// keybordy MP bench: push-to-talk voice loop with the Mac. K1 starts recording, K2 stops it;
// `voice_loop.py` (next to this sketch) transcribes the take with davide2 and sends back speech in
// Davide's voice, which plays on the speaker. Mic and amp run full duplex on one I2S port at
// 16 kHz; everything goes over UART0 (the COM port) at 2 Mbaud. No Wi-Fi: its current bursts make
// the bench supply (and so the amp) worse.
//
// Board -> Mac
//   text lines                            `mp_voice ready`, `key N down/up (Rr Cc)`, `rec start`,
//                                         `rec stop 3.2 s`
//   "MIC" + seq + FRAMES int16 LE         mono mic samples while recording
//   "END!"                                after the last MIC packet
//   0x06                                  one per SPK packet taken into the playback buffer
// Mac -> board
//   "SPK" + seq + FRAMES int16 LE         mono speaker samples
//   "STA" + len + "BIG|small text"        OLED status
//
// Wiring: docs/macropad-bench.md (OLED CS on GPIO3, DC on GPIO1; K1 = R0 C0, K2 = R0 C1).

#include <SPI.h>
#include <U8g2lib.h>
#include "driver/i2s_std.h"
#include "board_pins.h"

static const uint8_t OLED_DC = 1, OLED_CS = 3;  // bench pins, see mp_oled_test
U8G2_SSD1309_128X64_NONAME2_F_4W_HW_SPI oled(U8G2_R0, OLED_CS, OLED_DC, U8X8_PIN_NONE);
static const int INSET = 2;
static const int X0 = INSET, Y0 = INSET, W = 128 - 2 * INSET, H = 64 - 2 * INSET;

static const uint32_t BAUD = 2000000;
static const uint32_t FS = 16000;
static const int FRAMES = 256;                 // 16 ms per block and per packet
static const uint32_t REC_MAX_MS = 30000;
static const uint8_t ACK = 0x06;
static const int RING = FS;                    // 1 s of playback buffer (int16 mono)
static const uint32_t SETTLE_US = 30, DEBOUNCE_MS = 15;

static i2s_chan_handle_t txh, rxh;
static int32_t inBuf[FRAMES * 2], outBuf[FRAMES * 2];
static int16_t ring[RING];
static volatile int ringHead, ringTail;        // head: write, tail: read
static int ringCount() { return (ringHead - ringTail + RING) % RING; }

static bool recording;
static uint32_t recStart, lastSound, lastDraw;
static uint32_t sentAt;                        // a take went to the Mac; 0 once the Mac answers
static const uint32_t MAC_TIMEOUT_MS = 45000;
static uint8_t seq;
static bool ampOn;
static int32_t meter;                          // mic peak, 24-bit, decays
static char big[16] = "TALK", small[40] = "K1 record  K2 stop";

static bool stable[MATRIX_ROWS][MATRIX_COLS], raw[MATRIX_ROWS][MATRIX_COLS];
static uint32_t changedAt[MATRIX_ROWS][MATRIX_COLS];

static void draw(uint32_t now) {
  oled.clearBuffer();
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0, Y0 + 7, "keybordy MP");
  const char *tag = recording ? "mic" : (ringCount() ? "spk" : "voice");
  oled.drawStr(X0 + W - oled.getStrWidth(tag), Y0 + 7, tag);
  oled.drawHLine(X0, Y0 + 10, W);
  char b[16];
  if (recording) snprintf(b, sizeof b, "REC %.1f", (now - recStart) / 1000.0f);
  else snprintf(b, sizeof b, "%s", big);
  oled.setFont(u8g2_font_logisoso22_tr);
  oled.drawStr(X0 + max(0, (W - (int)oled.getStrWidth(b)) / 2), Y0 + 37, b);
  oled.setFont(u8g2_font_5x8_tr);
  const char *s = recording ? "K2 to stop" : small;
  oled.drawStr(X0 + max(0, (W - (int)oled.getStrWidth(s)) / 2), Y0 + 48, s);
  float db = meter > 0 ? 20 * log10f(meter / 8388608.0f) : -120;
  int fill = constrain((int)((db + 60) / 60 * (W - 4)), 0, W - 4);
  oled.drawFrame(X0, Y0 + H - 7, W, 7);
  if (fill > 0) oled.drawBox(X0 + 2, Y0 + H - 5, fill, 3);
  oled.sendBuffer();
}

static bool audioInit() {
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.dma_desc_num = 6;
  chan.dma_frame_num = FRAMES;
  chan.auto_clear = true;  // silence when there is nothing to play
  if (i2s_new_channel(&chan, &txh, &rxh) != ESP_OK) return false;
  i2s_std_config_t cfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(FS),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = (gpio_num_t)PIN_I2S_BCLK,
      .ws = (gpio_num_t)PIN_I2S_WS,
      .dout = (gpio_num_t)PIN_I2S_AMP_DIN,
      .din = (gpio_num_t)PIN_I2S_MIC_SD,
      .invert_flags = {false, false, false},
    },
  };
  if (i2s_channel_init_std_mode(txh, &cfg) != ESP_OK || i2s_channel_init_std_mode(rxh, &cfg) != ESP_OK) return false;
  return i2s_channel_enable(txh) == ESP_OK && i2s_channel_enable(rxh) == ESP_OK;
}

static void startRec(uint32_t now) {
  if (recording) return;
  ringHead = ringTail = 0;  // talking over playback cuts it
  recording = true;
  recStart = now;
  seq = 0;
  Serial.println("rec start");
}

static void stopRec(uint32_t now) {
  if (!recording) return;
  recording = false;
  Serial.write((const uint8_t *)"END!", 4);
  Serial.printf("\nrec stop %.1f s\n", (now - recStart) / 1000.0f);
  snprintf(big, sizeof big, "SENT");
  snprintf(small, sizeof small, "to davide2...");
  sentAt = now ? now : 1;
}

static void scanKeys(uint32_t now) {
  for (int r = 0; r < MATRIX_ROWS; r++) {
    pinMode(MATRIX_ROW_PINS[r], OUTPUT);
    digitalWrite(MATRIX_ROW_PINS[r], LOW);
    delayMicroseconds(SETTLE_US);
    for (int c = 0; c < MATRIX_COLS; c++) {
      bool down = digitalRead(MATRIX_COL_PINS[c]) == LOW;
      if (down != raw[r][c]) { raw[r][c] = down; changedAt[r][c] = now; }
      if (down != stable[r][c] && now - changedAt[r][c] >= DEBOUNCE_MS) {
        stable[r][c] = down;
        int slot = MATRIX_SLOT[r][c];
        if (slot < 0 || slot >= KEY_COUNT) continue;
        if (!recording) Serial.printf("key %d %s (R%d C%d)\n", slot + 1, down ? "down" : "up", r, c);
        if (down && slot == 0) startRec(now);
        if (down && slot == 1) stopRec(now);
      }
    }
    digitalWrite(MATRIX_ROW_PINS[r], HIGH);
    pinMode(MATRIX_ROW_PINS[r], INPUT);
  }
}

// Non-blocking parser for SPK / STA packets from the Mac.
static void pollSerial() {
  static uint8_t hdr[4];
  static int hdrLen = 0, need = 0, got = 0;
  static uint8_t payload[FRAMES * 2];
  static enum { HDR, SPK, STA } st = HDR;
  while (Serial.available()) {
    if (st == HDR) {
      if (st == HDR && ringCount() > RING - FRAMES - 1) return;  // no room: let the Mac wait
      hdr[hdrLen++] = Serial.read();
      // resync: the tag must start with S
      if (hdrLen == 1 && hdr[0] != 'S') { hdrLen = 0; continue; }
      if (hdrLen < 4) continue;
      hdrLen = 0;
      if (!memcmp(hdr, "SPK", 3)) { st = SPK; need = FRAMES * 2; got = 0; }
      else if (!memcmp(hdr, "STA", 3)) { st = STA; need = hdr[3]; got = 0; if (!need) st = HDR; }
      continue;
    }
    int n = min(Serial.available(), need - got);
    got += Serial.readBytes(payload + got, n);
    if (got < need) return;
    if (st == SPK) {
      const int16_t *s = (const int16_t *)payload;
      for (int i = 0; i < FRAMES; i++) { ring[ringHead] = s[i]; ringHead = (ringHead + 1) % RING; }
      Serial.write(ACK);
    } else {
      char t[64];
      int len = min(need, (int)sizeof t - 1);
      memcpy(t, payload, len);
      t[len] = 0;
      char *bar = strchr(t, '|');
      if (bar) { *bar = 0; snprintf(small, sizeof small, "%s", bar + 1); } else small[0] = 0;
      sentAt = 0;  // the Mac is alive
      snprintf(big, sizeof big, "%s", t);
    }
    st = HDR;
  }
}

void setup() {
  Serial.setTxBufferSize(16384);
  Serial.setRxBufferSize(16384);
  Serial.begin(BAUD);
  rgbLedWrite(48, 6, 6, 6);
  for (int r = 0; r < MATRIX_ROWS; r++) pinMode(MATRIX_ROW_PINS[r], INPUT);
  for (int c = 0; c < MATRIX_COLS; c++) pinMode(MATRIX_COL_PINS[c], INPUT_PULLUP);
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);
  SPI.begin(PIN_OLED_SCK, -1, PIN_OLED_MOSI, -1);
  oled.setBusClock(1000000);
  oled.begin();
  bool ok = audioInit();
  draw(millis());
  delay(300);
  Serial.printf("mp_voice ready (i2s %s, %lu Hz)\n", ok ? "on" : "FAILED", (unsigned long)FS);
}

void loop() {
  size_t n;
  i2s_channel_read(rxh, inBuf, sizeof inBuf, &n, portMAX_DELAY);  // paces the loop: 16 ms
  uint32_t now = millis();
  int frames = n / 8;
  int32_t pk = 0;
  for (int i = 0; i < frames; i++) pk = max(pk, abs(inBuf[2 * i] >> 8));
  meter = max(pk, (int32_t)(meter * 0.85f));

  if (recording) {
    static uint8_t pkt[4 + FRAMES * 2];
    pkt[0] = 'M'; pkt[1] = 'I'; pkt[2] = 'C'; pkt[3] = seq++;
    int16_t *o = (int16_t *)(pkt + 4);
    for (int i = 0; i < frames; i++) o[i] = inBuf[2 * i] >> 16;
    Serial.write(pkt, 4 + frames * 2);
    if (now - recStart > REC_MAX_MS) stopRec(now);
  }

  pollSerial();
  if (ringCount() >= FRAMES) {
    if (!ampOn) { digitalWrite(PIN_AMP_SD, HIGH); ampOn = true; }
    for (int i = 0; i < FRAMES; i++) {
      int32_t v = (int32_t)ring[ringTail] << 16;
      ringTail = (ringTail + 1) % RING;
      outBuf[2 * i] = outBuf[2 * i + 1] = v;
    }
    i2s_channel_write(txh, outBuf, sizeof outBuf, &n, portMAX_DELAY);
    lastSound = now;
  } else if (ampOn && now - lastSound > 400) {
    digitalWrite(PIN_AMP_SD, LOW);
    ampOn = false;
  }

  // No word from the Mac: the USB link dropped (a supply sag resets the CH343) or the loop is down.
  if (sentAt && now - sentAt > MAC_TIMEOUT_MS) {
    sentAt = 0;
    snprintf(big, sizeof big, "NO MAC");
    snprintf(small, sizeof small, "check USB, then K1");
  }
  scanKeys(now);
  if (now - lastDraw >= 100) { lastDraw = now; draw(now); }
}
