// keybordy MP bench: push-to-talk voice loop with the Mac over Wi-Fi. K1 starts recording, K2
// stops it. The take (16 kHz mono int16, kept in PSRAM) goes in one HTTP POST to `voice_loop.py`
// on the Mac, found over mDNS as _keybordy-voice._tcp. The Mac transcribes it with davide2 and
// answers in Davide's voice; the reply streams back in the same response and plays on the speaker.
// Mic and amp run full duplex on one I2S port at 16 kHz. USB is only power and logs.
//
// POST /take  X-Keybordy-Token: <BENCH_OTA_PASS>  body: int16 LE samples
// Response body, line by line until the Mac closes:
//   "S BIG|small\n"    OLED status
//   "P <bytes>\n"      then that many bytes of 16 kHz mono int16 LE to play
//
// Logs go to both UART0 (COM) and the native USB port: `wifi ...`, `key N down/up`, `rec ...`.
// Wiring: docs/macropad-bench.md (OLED CS on GPIO3, DC on GPIO1; K1 = R0 C0, K2 = R0 C1).

#include <SPI.h>
#include <U8g2lib.h>
#include "driver/i2s_std.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include <KeybordyBench.h>
#include "bench_secrets.h"  // BENCH_OTA_PASS doubles as the token voice_loop.py checks
#include "board_pins.h"

static const uint8_t OLED_DC = 1, OLED_CS = 3;  // bench pins, see mp_oled_test
U8G2_SSD1309_128X64_NONAME2_F_4W_HW_SPI oled(U8G2_R0, OLED_CS, OLED_DC, U8X8_PIN_NONE);
static const int INSET = 2;
// The panel is write-only and its RES is on EN, so a reset of the ESP32 alone (RST on USB, a
// panic, the COM port's auto-reset) can leave it off or with garbled settings while the firmware
// believes it is fine. Every frame re-sends the unlock, the whole NONAME2 setup and display on,
// without the init's display off, so the screen heals within one frame. About 30 bytes, 0.3 ms at
// 1 MHz. Tested by locking the panel on purpose at boot: the first frame brought it back.
static const uint8_t OLED_REASSERT[] = {
  U8X8_START_TRANSFER(),
  U8X8_CA(0x0fd, 0x012),   // unlock: noise can send the lock (FD 16), after which only this or RES works
  U8X8_CA(0x0d5, 0x0a0),   // clock divide, oscillator
  U8X8_CA(0x0a8, 0x03f),   // multiplex 64
  U8X8_CA(0x0d3, 0x000),   // display offset 0
  U8X8_C(0x040),           // start line 0
  U8X8_CA(0x020, 0x002),   // page addressing
  U8X8_C(0x0a1), U8X8_C(0x0c8),  // segment remap, COM scan reversed
  U8X8_CA(0x0da, 0x012),   // COM pins
  U8X8_CA(0x081, 0x06f),   // contrast
  U8X8_CA(0x0d9, 0x0d3),   // pre-charge
  U8X8_CA(0x0db, 0x020),   // VCOMH
  U8X8_C(0x02e), U8X8_C(0x0a4), U8X8_C(0x0a6),  // no scroll, RAM to display, not inverted
  U8X8_C(0x0af),           // display on
  U8X8_END_TRANSFER(),
  U8X8_END()
};
static const int X0 = INSET, Y0 = INSET, W = 128 - 2 * INSET, H = 64 - 2 * INSET;

static const uint32_t BAUD = 115200;
static const uint32_t FS = 16000;
static const int FRAMES = 256;                 // 16 ms per I2S block
static const uint32_t REC_MAX_MS = 30000;
static const int TAKE_MAX = FS * REC_MAX_MS / 1000;
static const int RING = FS;                    // 1 s of playback buffer (int16 mono)
static const uint32_t SETTLE_US = 30, DEBOUNCE_MS = 15;

static i2s_chan_handle_t txh, rxh;
static int32_t inBuf[FRAMES * 2], outBuf[FRAMES * 2];
static int16_t ring[RING];
static volatile int ringHead, ringTail;        // head: write, tail: read
static int ringCount() { return (ringHead - ringTail + RING) % RING; }

static bool recording;
static uint32_t recStart, lastSound, lastDraw;
static int16_t *take;                          // PSRAM, TAKE_MAX samples
static int takeLen;
static volatile bool busy;                     // the take is out to the Mac or its reply is coming in
static bool ampOn;
static int32_t meter;                          // mic peak, 24-bit, decays
static char big[16] = "TALK", small[40] = "K1 record  K2 stop";

// Serial0 is UART0 (COM); usb is the native USB port.
#if ARDUINO_USB_CDC_ON_BOOT
static HWCDC &usb = HWCDCSerial;
#else
static HWCDC usb;  // the core only creates HWCDCSerial when CDCOnBoot is on
#endif

static void outf(const char *fmt, ...) {
  char t[96];
  va_list ap;
  va_start(ap, fmt);
  int n = min(vsnprintf(t, sizeof t, fmt, ap), (int)sizeof t - 1);
  va_end(ap);
  Serial0.write((const uint8_t *)t, n);
  usb.write((const uint8_t *)t, n);  // tx timeout 0: dropped if nobody reads the USB port
}

static void setStatus(const char *b, const char *s) {
  snprintf(big, sizeof big, "%s", b);
  snprintf(small, sizeof small, "%s", s);
}

static bool stable[MATRIX_ROWS][MATRIX_COLS], raw[MATRIX_ROWS][MATRIX_COLS];
static uint32_t changedAt[MATRIX_ROWS][MATRIX_COLS];

static void draw(uint32_t now) {
  oled.clearBuffer();
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0, Y0 + 7, "keybordy MP");
  const char *tag = recording ? "mic" : ringCount() ? "spk" : busy ? "mac" : benchNetConnected() ? "wifi" : "no wifi";
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
  u8x8_cad_SendSequence(oled.getU8x8(), OLED_REASSERT);
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

// --- the Mac side, on core 0 ---

static IPAddress macIp;
static uint16_t macPort;

static bool findMac() {
  int n = MDNS.queryService("keybordy-voice", "tcp");
  for (int i = 0; i < n; i++) {
    if (MDNS.address(i) == IPAddress()) continue;
    macIp = MDNS.address(i);
    macPort = MDNS.port(i);
    outf("voice_loop at %s:%u\n", macIp.toString().c_str(), macPort);
    return true;
  }
  return false;
}

// One '\n'-terminated line, without the line end. False on close or after ms of silence.
static bool readLine(WiFiClient &c, char *buf, int cap, uint32_t ms) {
  int n = 0;
  uint32_t t = millis();
  while (millis() - t < ms) {
    if (!c.available()) {
      if (!c.connected()) break;
      vTaskDelay(2);
      continue;
    }
    int ch = c.read();
    t = millis();
    if (ch == '\n') {
      if (n && buf[n - 1] == '\r') n--;
      buf[n] = 0;
      return true;
    }
    if (n < cap - 1) buf[n++] = ch;
  }
  buf[n] = 0;
  return false;
}

// Streams `bytes` of int16 LE into the playback ring, as fast as the loop plays it.
static bool playStream(WiFiClient &c, int bytes) {
  static uint8_t buf[512];
  static uint8_t lo;
  bool odd = false;
  uint32_t t = millis();
  while (bytes > 0) {
    if (ringCount() > RING - 1 - (int)sizeof buf / 2) { vTaskDelay(5); t = millis(); continue; }
    int n = c.read(buf, min(bytes, (int)sizeof buf));
    if (n <= 0) {
      if ((!c.connected() && !c.available()) || millis() - t > 10000) return false;
      vTaskDelay(2);
      continue;
    }
    t = millis();
    bytes -= n;
    for (int i = 0; i < n; i++) {
      if (!odd) { lo = buf[i]; odd = true; continue; }
      ring[ringHead] = (int16_t)(lo | buf[i] << 8);
      ringHead = (ringHead + 1) % RING;
      odd = false;
    }
  }
  while (ringCount() % FRAMES) {  // the loop plays whole frames: pad the tail with silence
    ring[ringHead] = 0;
    ringHead = (ringHead + 1) % RING;
  }
  return true;
}

// Sends the take and plays the reply. Returns null, or what went wrong for the OLED.
static const char *exchange() {
  if (!benchNetConnected()) return "no wifi";
  WiFiClient c;
  if (!(macPort && c.connect(macIp, macPort, 3000)) && !(findMac() && c.connect(macIp, macPort, 3000)))
    return "voice_loop not found";
  c.setNoDelay(true);
  c.printf("POST /take HTTP/1.0\r\nX-Keybordy-Token: %s\r\nContent-Type: application/octet-stream\r\n"
           "Content-Length: %d\r\n\r\n", BENCH_OTA_PASS, takeLen * 2);
  const uint8_t *p = (const uint8_t *)take;
  size_t left = takeLen * 2;
  uint32_t t = millis();
  while (left) {
    size_t w = c.write(p, min(left, (size_t)4096));
    if (w) { p += w; left -= w; t = millis(); continue; }
    if (!c.connected() || millis() - t > 5000) return "upload failed";
    vTaskDelay(2);
  }
  outf("take sent (%d bytes)\n", takeLen * 2);
  char line[96];
  if (!readLine(c, line, sizeof line, 120000)) return "no answer";
  if (!strstr(line, " 200")) return strstr(line, " 403") ? "bad token" : "mac error";
  while (readLine(c, line, sizeof line, 10000) && line[0]) {}  // headers
  while (readLine(c, line, sizeof line, 120000)) {
    if (!strncmp(line, "S ", 2)) {
      char *bar = strchr(line + 2, '|');
      if (bar) *bar = 0;
      setStatus(line + 2, bar ? bar + 1 : "");
    } else if (!strncmp(line, "P ", 2)) {
      if (!playStream(c, atoi(line + 2))) return "reply cut off";
    }
  }
  return nullptr;
}

static void talkTask(void *) {
  const char *err = exchange();
  if (err) {
    outf("talk failed: %s\n", err);
    setStatus("ERROR", err);
  }
  busy = false;
  vTaskDelete(nullptr);
}

// --- keys and recording, on core 1 ---

static void startRec(uint32_t now) {
  if (recording || busy || !take) return;
  ringHead = ringTail = 0;
  takeLen = 0;
  recording = true;
  recStart = now;
  outf("rec start\n");
}

static void stopRec(uint32_t now) {
  if (!recording) return;
  recording = false;
  outf("rec stop %.1f s\n", takeLen / (float)FS);
  if (takeLen < (int)FS / 4) { setStatus("TALK", "too short, K1 again"); return; }
  setStatus("SENT", "to davide2...");
  busy = true;
  xTaskCreatePinnedToCore(talkTask, "talk", 8192, nullptr, 1, nullptr, 0);
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
        if (!recording) outf("key %d %s (R%d C%d)\n", slot + 1, down ? "down" : "up", r, c);
        if (down && slot == 0) startRec(now);
        if (down && slot == 1) stopRec(now);
      }
    }
    digitalWrite(MATRIX_ROW_PINS[r], HIGH);
    pinMode(MATRIX_ROW_PINS[r], INPUT);
  }
}

void setup() {
  pinMode(OLED_CS, OUTPUT);  // GPIO3 floats through boot: deselect the panel before anything else
  digitalWrite(OLED_CS, HIGH);
  Serial0.begin(BAUD);
  usb.setTxTimeoutMs(0);
  usb.begin();
  take = (int16_t *)ps_malloc(TAKE_MAX * sizeof(int16_t));
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
  benchNetBegin("keybordy-mp", true);
  outf("mp_voice ready (i2s %s, %lu Hz, take buffer %s)\n", ok ? "on" : "FAILED", (unsigned long)FS, take ? "ok" : "FAILED");
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
    for (int i = 0; i < frames && takeLen < TAKE_MAX; i++) take[takeLen++] = inBuf[2 * i] >> 16;
    if (takeLen >= TAKE_MAX) stopRec(now);
  }

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

  scanKeys(now);
  if (now - lastDraw >= 100) { lastDraw = now; draw(now); }
}
