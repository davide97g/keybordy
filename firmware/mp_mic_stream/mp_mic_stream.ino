// keybordy MP bench: stream the INMP441 to the Mac. Idle, the OLED shows both I2S slots' levels.
// `record.py` (next to this sketch) sends 'R' plus a byte of seconds; the board then shows a
// REC countdown and streams raw audio over UART0 (the COM port) at 2 Mbaud, then prints
// `rec done`. Text only goes out while not streaming, so the host can parse cleanly.
//
// Packet: "MIC" + seq (u8) + FRAMES stereo int16 LE frames (L, R): the top 16 bits of each 32-bit
// I2S slot. Both slots are sent, so the host can tell which one the mic is on (L/R to GND = L).
// 16 kHz x 2 ch x 16 bit = 64 KB/s, a third of the link. Wiring: docs/macropad-bench.md.

#include <SPI.h>
#include <U8g2lib.h>
#include "driver/i2s_std.h"
#include "board_pins.h"
#include <KeybordyBench.h>  // Wi-Fi + OTA: `just mp-ota mp_mic_stream`

static const uint8_t OLED_DC = 1;  // bench: DC on GPIO1 (see mp_oled_test)
// Bench: CS on GPIO3 (the PCB's is GPIO48, the DevKit's WS2812 data line). With CS on a GPIO the
// panel resyncs its byte framing on every transfer; tied to GND, one stray CLK edge (a reset, a pin
// test) left the screen black until the next power cycle.
static const uint8_t OLED_CS = 3;
U8G2_SSD1309_128X64_NONAME2_F_4W_HW_SPI oled(U8G2_R0, OLED_CS, OLED_DC, U8X8_PIN_NONE);
static const int INSET = 2;
static const int X0 = INSET, Y0 = INSET, W = 128 - 2 * INSET, H = 64 - 2 * INSET;

static const uint32_t BAUD = 2000000;
static const uint32_t FS = 16000;
static const int FRAMES = 256;  // 16 ms per packet

static i2s_chan_handle_t rxh;
static bool streaming;
static uint32_t recEnd, lastDraw;
static uint8_t seq;
static int32_t peakL, peakR, meterL;  // 24-bit

static float dbfs(int32_t p) { return p > 0 ? 20 * log10f(p / 8388608.0f) : -120; }

static bool micInit() {
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.dma_desc_num = 8;
  if (i2s_new_channel(&chan, nullptr, &rxh) != ESP_OK) return false;
  i2s_std_config_t cfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(FS),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = (gpio_num_t)PIN_I2S_BCLK,
      .ws = (gpio_num_t)PIN_I2S_WS,
      .dout = I2S_GPIO_UNUSED,
      .din = (gpio_num_t)PIN_I2S_MIC_SD,
      .invert_flags = {false, false, false},
    },
  };
  return i2s_channel_init_std_mode(rxh, &cfg) == ESP_OK && i2s_channel_enable(rxh) == ESP_OK;
}

static void draw(uint32_t now) {
  oled.clearBuffer();
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0, Y0 + 7, "keybordy MP");
  const char *tag = streaming ? "-> Mac" : "mic";
  oled.drawStr(X0 + W - oled.getStrWidth(tag), Y0 + 7, tag);
  oled.drawHLine(X0, Y0 + 10, W);
  char big[12];
  if (streaming) snprintf(big, sizeof big, "REC %lu", (unsigned long)((recEnd - now + 999) / 1000));
  else snprintf(big, sizeof big, "MIC");
  oled.setFont(u8g2_font_logisoso22_tr);
  oled.drawStr(X0 + (W - oled.getStrWidth(big)) / 2, Y0 + 37, big);
  char sub[32];
  snprintf(sub, sizeof sub, "L %.0f  R %.0f dBFS", dbfs(peakL), dbfs(peakR));
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0 + (W - oled.getStrWidth(sub)) / 2, Y0 + 48, sub);
  int fill = constrain((int)((dbfs(meterL) + 60) / 60 * (W - 4)), 0, W - 4);  // -60..0 dBFS
  oled.drawFrame(X0, Y0 + H - 7, W, 7);
  if (fill > 0) oled.drawBox(X0 + 2, Y0 + H - 5, fill, 3);
  oled.sendBuffer();
}

void setup() {
  Serial.setTxBufferSize(16384);
  Serial.begin(BAUD);
  rgbLedWrite(48, 6, 6, 6);
  SPI.begin(PIN_OLED_SCK, -1, PIN_OLED_MOSI, -1);
  oled.setBusClock(1000000);
  oled.begin();
  bool ok = micInit();
  draw(millis());
  delay(300);
  Serial.printf("mp_mic ready (i2s %s, %lu Hz, %lu baud)\n", ok ? "on" : "FAILED", (unsigned long)FS, (unsigned long)BAUD);
  benchNetBegin("keybordy-mp", false);  // quiet: Serial carries binary audio
}

void loop() {
  static int32_t in[FRAMES * 2];
  static uint8_t pkt[4 + FRAMES * 4];
  size_t got = 0;
  i2s_channel_read(rxh, in, sizeof in, &got, portMAX_DELAY);
  int n = got / 8;
  int32_t pl = 0, pr = 0;
  for (int i = 0; i < n; i++) {
    pl = max(pl, abs(in[2 * i] >> 8));
    pr = max(pr, abs(in[2 * i + 1] >> 8));
  }
  uint32_t now = millis();
  meterL = max(pl, (int32_t)(meterL * 0.85f));
  // the text line shows the loudest block of the last ~0.5 s
  static uint32_t peakAt;
  if (now - peakAt > 500) { peakL = pl; peakR = pr; peakAt = now; }
  else { peakL = max(peakL, pl); peakR = max(peakR, pr); }

  if (streaming) {
    pkt[0] = 'M'; pkt[1] = 'I'; pkt[2] = 'C'; pkt[3] = seq++;
    int16_t *o = (int16_t *)(pkt + 4);
    for (int i = 0; i < n; i++) {
      o[2 * i] = in[2 * i] >> 16;
      o[2 * i + 1] = in[2 * i + 1] >> 16;
    }
    Serial.write(pkt, 4 + n * 4);
    if ((int32_t)(now - recEnd) >= 0) {
      streaming = false;
      Serial.flush();
      Serial.write((const uint8_t *)"END!", 4);
      Serial.println("\nrec done");
    }
  } else if (Serial.available() >= 2 && Serial.peek() == 'R') {
    Serial.read();
    uint8_t secs = Serial.read();
    seq = 0;
    recEnd = now + secs * 1000UL;
    streaming = true;
  } else if (Serial.available() && Serial.peek() != 'R') {
    Serial.read();  // anything else is noise
  }
  if (now - lastDraw >= 100) { lastDraw = now; draw(now); }
}
