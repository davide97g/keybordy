// keybordy MP bench: play audio streamed from the Mac through the MAX98357A and the 8 ohm speaker.
// `play.py` (next to this sketch) decodes a file or synthesises a tune, then streams it over UART0
// (the COM port) at 2 Mbaud:
//   "TTL" + len (u8) + title bytes        shown on the OLED
//   "SPK" + seq (u8) + FRAMES int16 LE    mono samples at 32 kHz
//   "EOS!"                                end of stream: drain, amp off
// The board answers one 'K' per SPK packet it has queued to I2S. The host keeps a fixed number of
// packets in flight, so the I2S DMA paces the stream and the UART never overruns.
// SD_MODE (GPIO46) is high only while playing, so the amp does not hiss at idle.
// Wiring: docs/macropad-bench.md (OLED CS on GPIO3, DC on GPIO1).

#include <SPI.h>
#include <U8g2lib.h>
#include "driver/i2s_std.h"
#include "board_pins.h"
#include <KeybordyBench.h>  // Wi-Fi + OTA: `just mp-ota mp_speaker_stream`

static const uint8_t OLED_DC = 1;  // bench: DC on GPIO1, CS on GPIO3 (see mp_oled_test)
static const uint8_t OLED_CS = 3;
U8G2_SSD1309_128X64_NONAME2_F_4W_HW_SPI oled(U8G2_R0, OLED_CS, OLED_DC, U8X8_PIN_NONE);
static const int INSET = 2;
static const int X0 = INSET, Y0 = INSET, W = 128 - 2 * INSET, H = 64 - 2 * INSET;

static const uint32_t BAUD = 2000000;
static const uint32_t FS = 32000;
static const int FRAMES = 512;  // 16 ms per packet

static i2s_chan_handle_t txh;
static char title[40] = "waiting for the Mac";
static bool playing;
static uint32_t playedFrames, lastDraw, lastData;
static int32_t level;  // 16-bit peak, decays

static bool ampInit() {
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.dma_desc_num = 8;
  chan.dma_frame_num = FRAMES;
  chan.auto_clear = true;  // silence, not the last buffer, on underrun
  if (i2s_new_channel(&chan, &txh, nullptr) != ESP_OK) return false;
  i2s_std_config_t cfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(FS),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = (gpio_num_t)PIN_I2S_BCLK,
      .ws = (gpio_num_t)PIN_I2S_WS,
      .dout = (gpio_num_t)PIN_I2S_AMP_DIN,
      .din = I2S_GPIO_UNUSED,
      .invert_flags = {false, false, false},
    },
  };
  return i2s_channel_init_std_mode(txh, &cfg) == ESP_OK && i2s_channel_enable(txh) == ESP_OK;
}

static void draw() {
  oled.clearBuffer();
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0, Y0 + 7, "keybordy MP");
  char buf[24];
  uint32_t s = playedFrames / FS;
  snprintf(buf, sizeof buf, "%lu:%02lu", (unsigned long)(s / 60), (unsigned long)(s % 60));
  oled.drawStr(X0 + W - oled.getStrWidth(buf), Y0 + 7, buf);
  oled.drawHLine(X0, Y0 + 10, W);
  const char *big = playing ? "PLAY" : "SPK";
  oled.setFont(u8g2_font_logisoso22_tr);
  oled.drawStr(X0 + (W - oled.getStrWidth(big)) / 2, Y0 + 37, big);
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0 + max(0, (W - (int)oled.getStrWidth(title)) / 2), Y0 + 48, title);
  float db = level > 0 ? 20 * log10f(level / 32768.0f) : -120;
  int fill = constrain((int)((db + 48) / 48 * (W - 4)), 0, W - 4);  // -48..0 dBFS
  oled.drawFrame(X0, Y0 + H - 7, W, 7);
  if (fill > 0) oled.drawBox(X0 + 2, Y0 + H - 5, fill, 3);
  oled.sendBuffer();
}

static void amp(bool on) {
  if (on == playing) return;
  playing = on;
  digitalWrite(PIN_AMP_SD, on ? HIGH : LOW);
}

// Read exactly n bytes, or give up after timeoutMs.
static bool readN(uint8_t *dst, size_t n, uint32_t timeoutMs) {
  uint32_t t0 = millis();
  size_t got = 0;
  while (got < n) {
    int a = Serial.available();
    if (a > 0) got += Serial.readBytes(dst + got, min((size_t)a, n - got));
    else if (millis() - t0 > timeoutMs) return false;
  }
  return true;
}

void setup() {
  Serial.setRxBufferSize(32768);
  Serial.begin(BAUD);
  rgbLedWrite(48, 6, 6, 6);
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);
  SPI.begin(PIN_OLED_SCK, -1, PIN_OLED_MOSI, -1);
  oled.setBusClock(1000000);
  oled.begin();
  bool ok = ampInit();
  draw();
  delay(300);
  Serial.printf("mp_speaker ready (i2s %s, %lu Hz, %lu baud)\n", ok ? "on" : "FAILED", (unsigned long)FS, (unsigned long)BAUD);
  benchNetBegin("keybordy-mp", false);  // quiet: Serial carries binary audio
}

void loop() {
  static int16_t mono[FRAMES];
  static int16_t stereo[FRAMES * 2];
  static uint8_t hdr[4];
  uint32_t now = millis();

  // Sync on a 3-letter tag, one byte at a time.
  if (Serial.available() >= 4 && Serial.peek() != 'S' && Serial.peek() != 'T' && Serial.peek() != 'E') {
    Serial.read();
  } else if (Serial.available() >= 4) {
    readN(hdr, 4, 50);
    if (!memcmp(hdr, "SPK", 3)) {
      if (readN((uint8_t *)mono, sizeof mono, 200)) {
        amp(true);
        int32_t pk = 0;
        for (int i = 0; i < FRAMES; i++) {
          stereo[2 * i] = stereo[2 * i + 1] = mono[i];
          pk = max(pk, (int32_t)abs(mono[i]));
        }
        level = max(pk, (int32_t)(level * 0.9f));
        size_t wrote;
        i2s_channel_write(txh, stereo, sizeof stereo, &wrote, portMAX_DELAY);  // blocks: DMA paces us
        playedFrames += FRAMES;
        lastData = now;
        Serial.write('K');
      }
    } else if (!memcmp(hdr, "TTL", 3)) {
      uint8_t n = hdr[3];
      char t[256];
      if (readN((uint8_t *)t, n, 200)) {
        n = min<uint8_t>(n, sizeof title - 1);
        memcpy(title, t, n);
        title[n] = 0;
        playedFrames = 0;
      }
    } else if (!memcmp(hdr, "EOS!", 4)) {
      delay(FRAMES * 8 * 1000 / FS);  // let the DMA drain (8 descriptors)
      amp(false);
      level = 0;
      Serial.println("play done");
    }
  }
  if (playing && now - lastData > 500) { amp(false); level = 0; }  // the Mac went away
  if (now - lastDraw >= 100) {
    lastDraw = now;
    if (!playing) level = (int32_t)(level * 0.5f);
    draw();
  }
}
