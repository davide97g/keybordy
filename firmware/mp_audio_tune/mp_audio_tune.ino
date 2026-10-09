// keybordy MP bench: the board tunes its own speaker level with its own mic. The MAX98357A and the
// INMP441 run full duplex on one I2S port (shared BCLK/WS), so every tone it plays it also hears.
//
// On 'T' over UART0 (the COM port, 2 Mbaud; `tune.py` sends it):
//   1. a short beep at a safe level: the cue to be quiet
//   2. 2 s of silence, the last second measured as the room's noise floor
//   3. a 1 kHz sweep, LEVEL_MIN..LEVEL_MAX dBFS in 2 dB steps, 500 ms each; the mic's middle
//      250 ms of each step is analysed: the fundamental (Goertzel, exact bin), the residual
//      (everything else: harmonics, crackle, noise) as THD+N, and the 2nd/3rd harmonics
// It prints one `step` line per level and `tune done`; `tune.py` picks the level. On 'C' + a
// signed byte (dBFS) it plays a two-note chime at that peak level.
// Wiring: docs/macropad-bench.md (OLED CS on GPIO3, DC on GPIO1).

#include <SPI.h>
#include <U8g2lib.h>
#include "driver/i2s_std.h"
#include "board_pins.h"
#include <KeybordyBench.h>  // Wi-Fi + OTA: `just mp-ota mp_audio_tune`

static const uint8_t OLED_DC = 1, OLED_CS = 3;  // bench pins, see mp_oled_test
U8G2_SSD1309_128X64_NONAME2_F_4W_HW_SPI oled(U8G2_R0, OLED_CS, OLED_DC, U8X8_PIN_NONE);
static const int INSET = 2;
static const int X0 = INSET, Y0 = INSET, W = 128 - 2 * INSET, H = 64 - 2 * INSET;

static const uint32_t BAUD = 2000000;
static const uint32_t FS = 32000;
static const int FRAMES = 256;            // 8 ms blocks
static const int LEVEL_MIN = -40, LEVEL_MAX = -6, LEVEL_STEP = 2;
static const float TONE_HZ = 1000;
static const int STEP_MS = 500, SKIP_MS = 200, MEAS_MS = 250;   // measure 200..450 ms of each step

static i2s_chan_handle_t txh, rxh;
static int32_t inBuf[FRAMES * 2], outBuf[FRAMES * 2];
static float meas[FS * MEAS_MS / 1000];   // mic samples of one step, normalised to full scale

static void show(const char *big, const char *sub) {
  oled.clearBuffer();
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0, Y0 + 7, "keybordy MP");
  oled.drawStr(X0 + W - oled.getStrWidth("tune"), Y0 + 7, "tune");
  oled.drawHLine(X0, Y0 + 10, W);
  oled.setFont(u8g2_font_logisoso22_tr);
  oled.drawStr(X0 + (W - oled.getStrWidth(big)) / 2, Y0 + 37, big);
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0 + max(0, (W - (int)oled.getStrWidth(sub)) / 2), Y0 + 48, sub);
  oled.sendBuffer();
}

static bool audioInit() {
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.dma_desc_num = 4;
  chan.dma_frame_num = FRAMES;
  chan.auto_clear = true;
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

// Play `ms` of a sine (hz = 0: silence) at `db` dBFS peak with 10 ms fades, and capture the mic's
// left slot for [fromMs, fromMs + count/FS) into dst (if not null).
static void run(float hz, float db, int ms, int fromMs, float *dst, int count) {
  const int total = FS * ms / 1000, from = FS * fromMs / 1000, fade = FS / 100;
  const float amp = powf(10, db / 20) * 2147483392.0f;
  float phase = 0;
  for (int done = 0; done < total; done += FRAMES) {
    for (int i = 0; i < FRAMES; i++) {
      int k = done + i;
      float env = min(1.0f, min((float)k / fade, (float)(total - k) / fade));
      float v = (hz > 0 && k < total) ? sinf(phase) * amp * max(0.0f, env) : 0;
      phase += 2 * PI * hz / FS;
      if (phase > 2 * PI) phase -= 2 * PI;
      outBuf[2 * i] = outBuf[2 * i + 1] = (int32_t)v;
    }
    size_t n;
    i2s_channel_write(txh, outBuf, sizeof outBuf, &n, portMAX_DELAY);
    i2s_channel_read(rxh, inBuf, sizeof inBuf, &n, portMAX_DELAY);
    for (int i = 0; i < FRAMES; i++) {
      int k = done + i - from;
      if (dst && k >= 0 && k < count) dst[k] = (inBuf[2 * i] >> 8) / 8388608.0f;
    }
  }
}

// Amplitude of the component at hz (exact bin when hz * n / FS is an integer).
static float goertzel(const float *x, int n, float hz) {
  float w = 2 * PI * hz / FS, c = 2 * cosf(w), s1 = 0, s2 = 0;
  for (int i = 0; i < n; i++) { float s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
  float re = s1 - s2 * cosf(w), im = s2 * sinf(w);
  return 2 * sqrtf(re * re + im * im) / n;
}

static float db20(float x) { return x > 1e-9f ? 20 * log10f(x) : -180; }

static void tune() {
  const int n = FS * MEAS_MS / 1000;
  digitalWrite(PIN_AMP_SD, HIGH);
  delay(20);
  show("BEEP", "quiet please");
  run(880, -24, 150, 0, nullptr, 0);
  show("QUIET", "measuring the room");
  run(0, 0, 1000, 0, nullptr, 0);
  run(0, 0, 1000, 0, meas, n);
  float mean = 0, pw = 0;
  for (int i = 0; i < n; i++) mean += meas[i];
  mean /= n;
  for (int i = 0; i < n; i++) pw += (meas[i] - mean) * (meas[i] - mean);
  Serial.printf("noise %.1f dBFS\n", db20(sqrtf(pw / n)));
  for (int lvl = LEVEL_MIN; lvl <= LEVEL_MAX; lvl += LEVEL_STEP) {
    char big[12], sub[24];
    snprintf(big, sizeof big, "%d dB", lvl);
    snprintf(sub, sizeof sub, "sweep %d..%d", LEVEL_MIN, LEVEL_MAX);
    show(big, sub);
    run(TONE_HZ, lvl, STEP_MS, SKIP_MS, meas, n);
    mean = 0; pw = 0;
    float pk = 0;
    for (int i = 0; i < n; i++) mean += meas[i];
    mean /= n;
    for (int i = 0; i < n; i++) { float v = meas[i] - mean; meas[i] = v; pw += v * v; pk = max(pk, fabsf(v)); }
    float rms = sqrtf(pw / n);
    float f1 = goertzel(meas, n, TONE_HZ), h2 = goertzel(meas, n, 2 * TONE_HZ), h3 = goertzel(meas, n, 3 * TONE_HZ);
    float fundRms = f1 / sqrtf(2);
    float resid = sqrtf(max(0.0f, rms * rms - fundRms * fundRms));
    Serial.printf("step %d fund %.1f thdn %.1f h2 %.1f h3 %.1f crest %.1f\n", lvl, db20(f1), db20(resid / fundRms),
                  db20(h2 / f1), db20(h3 / f1), db20(pk / max(rms, 1e-9f)));
  }
  digitalWrite(PIN_AMP_SD, LOW);
  show("DONE", "tune.py picks the level");
  Serial.println("tune done");
}

static void chime(int db) {
  char sub[24];
  snprintf(sub, sizeof sub, "peak %d dBFS", db);
  show("SET", sub);
  digitalWrite(PIN_AMP_SD, HIGH);
  delay(20);
  run(1046.5f, db, 160, 0, nullptr, 0);
  run(1568.0f, db, 260, 0, nullptr, 0);
  run(0, 0, 60, 0, nullptr, 0);
  digitalWrite(PIN_AMP_SD, LOW);
  Serial.println("chime done");
}

void setup() {
  Serial.begin(BAUD);
  rgbLedWrite(48, 6, 6, 6);
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);
  SPI.begin(PIN_OLED_SCK, -1, PIN_OLED_MOSI, -1);
  oled.setBusClock(1000000);
  oled.begin();
  bool ok = audioInit();
  show("TUNE", ok ? "waiting for the Mac" : "I2S FAILED");
  delay(300);
  Serial.printf("mp_audio_tune ready (i2s %s, %lu Hz)\n", ok ? "on" : "FAILED", (unsigned long)FS);
  benchNetBegin("keybordy-mp", false);  // quiet: Serial carries binary audio
}

void loop() {
  // Keep both DMA directions moving while idle, so the first measurement starts from a clean state.
  size_t n;
  memset(outBuf, 0, sizeof outBuf);
  i2s_channel_write(txh, outBuf, sizeof outBuf, &n, 20);
  i2s_channel_read(rxh, inBuf, sizeof inBuf, &n, 20);
  if (Serial.available()) {
    int c = Serial.read();
    if (c == 'T') tune();
    else if (c == 'C') {
      uint32_t t0 = millis();
      while (!Serial.available() && millis() - t0 < 200) {}
      if (Serial.available()) chime((int8_t)Serial.read());
    }
  }
}
