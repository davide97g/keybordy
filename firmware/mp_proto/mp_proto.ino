// keybordy MP bench prototype: the matrix, encoders, OLED, microphone and amp on the MP pins from
// board_pins.h (a copy of firmware/macropad/main/board_pins.h, generated from layout/). Wiring,
// chapter by chapter, is in docs/macropad-bench.md. Flash with `just mp-flash mp_proto` and read
// with `just mp-monitor` on the native USB port, or flash from the simulator editor on the COM port.
//
// Serial at 115200:
//   key N down|up (Rr Cc)           every key, same lines as mp_bench
//   enc E1 cw|ccw|push|release      encoders (E1 also sets the volume)
//   mic L -48 R -96 dBFS            peak level of both I2S slots, every 2 s
//   rec start / rec 1.8 s / play    hold K21 (the talk bar) to record up to 4 s, release to play
// Each key beeps its own note. Parts that are not wired yet are simply silent or blank.
//
// Bench differences from the PCB:
//   - OLED CS is on GPIO3, because the DevKit's WS2812 data line is on GPIO48 (the PCB's CS).
//     RES is on EN, as on the PCB.
//   - OLED DC is on GPIO1, not GPIO43 (UART0 TX), so the COM port keeps working.
//   - Encoder A/B use the internal pull-ups (the PCB has 10k).
//   - No diodes until they arrive: three keys held in an L show a phantom fourth.

#include <SPI.h>
#include <U8g2lib.h>
#include "driver/i2s_std.h"
#include "board_pins.h"
#include <KeybordyBench.h>  // Wi-Fi + OTA: `just mp-ota mp_proto`

#define BENCH 1

static const uint32_t SETTLE_US = 30;
static const uint32_t DEBOUNCE_MS = 15;
static const uint32_t FS = 16000;           // I2S sample rate, mic and amp share BCLK/WS
static const int FRAMES = 256;              // 16 ms per I2S block
static const uint32_t REC_MAX = FS * 4;     // 4 s of 16-bit mono
static const uint8_t LED_LEVEL = 6;         // DevKit WS2812, ~10% of the core's default

// Bench: DC on GPIO1 instead of the PCB's GPIO43 (UART0 TX), so UART0 stays free for the COM
// port and the simulator's builds, which print there. GPIO1 is the PCB's VBAT sense; no battery here.
static const uint8_t OLED_DC = 1;
// Bench: CS on GPIO3 (the PCB's is GPIO48, the DevKit's WS2812 data line). With CS on a GPIO the
// panel resyncs its byte framing on every transfer; tied to GND, one stray CLK edge (a reset, a pin
// test) left the screen black until the next power cycle.
static const uint8_t OLED_CS = 3;
U8G2_SSD1309_128X64_NONAME2_F_4W_HW_SPI oled(U8G2_R0, BENCH ? OLED_CS : PIN_OLED_CS, OLED_DC, U8X8_PIN_NONE);

// ── Events from the scan task ──────────────────────────────────────────────────────────────
enum : uint8_t { EV_KEY, EV_ENC_PUSH, EV_ENC_TURN, EV_EMPTY };
struct Event { uint8_t kind; int8_t id; int8_t val; uint8_t r, c; };
static QueueHandle_t events;

static void post(uint8_t kind, int8_t id, int8_t val, uint8_t r = 0, uint8_t c = 0) {
  Event e = {kind, id, val, r, c};
  xQueueSend(events, &e, 0);
}

// Matrix exactly as mp_bench, plus quadrature decoding. One pass per millisecond on core 0, so the
// OLED and audio work on core 1 never delays a key or drops an encoder step.
static void scanTask(void *) {
  static bool stable[MATRIX_ROWS][MATRIX_COLS], raw[MATRIX_ROWS][MATRIX_COLS];
  static uint32_t changedAt[MATRIX_ROWS][MATRIX_COLS];
  static const int8_t QDEC[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};
  uint8_t encState[ENCODER_COUNT];
  int8_t encAcc[ENCODER_COUNT] = {};
  for (int e = 0; e < ENCODER_COUNT; e++)
    encState[e] = (digitalRead(ENCODER_PIN_A[e]) << 1) | digitalRead(ENCODER_PIN_B[e]);
  for (;;) {
    uint32_t now = millis();
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
          if (slot < 0) post(EV_EMPTY, -1, down, r, c);
          else if (slot < KEY_COUNT) post(EV_KEY, slot, down, r, c);
          else post(EV_ENC_PUSH, slot - KEY_COUNT, down, r, c);
        }
      }
      digitalWrite(MATRIX_ROW_PINS[r], HIGH);  // recharge the columns before the next row
      pinMode(MATRIX_ROW_PINS[r], INPUT);
    }
    // EC11: A/B rest high between detents. Count transitions and report at the rest state, which
    // also resyncs after contact bounce.
    for (int e = 0; e < ENCODER_COUNT; e++) {
      uint8_t s = (digitalRead(ENCODER_PIN_A[e]) << 1) | digitalRead(ENCODER_PIN_B[e]);
      if (s == encState[e]) continue;
      encAcc[e] += QDEC[(encState[e] << 2) | s];
      encState[e] = s;
      if (s == 3) {
        if (encAcc[e] >= 2) post(EV_ENC_TURN, e, 1);
        else if (encAcc[e] <= -2) post(EV_ENC_TURN, e, -1);
        encAcc[e] = 0;
      }
    }
    vTaskDelay(1);
  }
}

// ── Audio: one I2S port, full duplex, mic on RX and amp on TX with shared clocks ───────────
static i2s_chan_handle_t txh, rxh;
static int16_t *rec;
static volatile uint32_t recLen, playPos;
static volatile bool recording, playing;
static volatile float toneFreq;
static volatile uint32_t toneLeft, toneTotal;
static volatile int volume = 4;             // 0..10, E1
static volatile int32_t peakL, peakR;       // 24-bit peaks since the last report
static volatile int32_t meter;              // 24-bit peak for the OLED bar, decays

static void playTone(float hz, uint32_t ms) {
  toneTotal = FS * ms / 1000;
  toneFreq = hz;
  toneLeft = toneTotal;
}

static bool audioInit() {
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
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
  if (i2s_channel_init_std_mode(txh, &cfg) != ESP_OK) return false;
  if (i2s_channel_init_std_mode(rxh, &cfg) != ESP_OK) return false;
  return i2s_channel_enable(txh) == ESP_OK && i2s_channel_enable(rxh) == ESP_OK;
}

static inline int16_t clamp16(int32_t v) { return v > 32767 ? 32767 : v < -32768 ? -32768 : v; }

static void audioTask(void *) {
  static int32_t in[FRAMES * 2], out[FRAMES * 2];
  float phase = 0;
  uint32_t idleBlocks = 0;
  bool ampOn = false;
  for (;;) {
    size_t got = 0;
    i2s_channel_read(rxh, in, sizeof in, &got, portMAX_DELAY);
    int n = got / 8;
    int32_t pl = 0, pr = 0;
    for (int i = 0; i < n; i++) {
      int32_t l = in[2 * i] >> 8, r = in[2 * i + 1] >> 8;  // 24-bit samples, left-justified
      pl = max(pl, abs(l));
      pr = max(pr, abs(r));
      // The INMP441 talks in the left slot (L/R to GND). +24 dB so speech is not lost in 16 bits.
      if (recording && recLen < REC_MAX) rec[recLen++] = clamp16(l >> 4);
    }
    if (pl > peakL) peakL = pl;
    if (pr > peakR) peakR = pr;
    meter = max(pl, (int32_t)(meter * 0.8f));

    float vol = (volume / 10.0f) * (volume / 10.0f);
    bool sounding = false;
    for (int i = 0; i < n; i++) {
      float v = 0;
      if (playing) {
        if (playPos < recLen) { v = rec[playPos++] / 32768.0f; sounding = true; }
        else playing = false;
      } else if (toneLeft) {
        uint32_t k = toneTotal - toneLeft;
        float env = min(1.0f, min(k, (uint32_t)toneLeft) / 80.0f);   // 5 ms fades, no clicks
        v = sinf(phase) * 0.35f * env;
        phase += 2 * PI * toneFreq / FS;
        if (phase > 2 * PI) phase -= 2 * PI;
        toneLeft--;
        sounding = true;
      }
      int32_t s = (int32_t)(v * vol * 2147483392.0f);
      out[2 * i] = out[2 * i + 1] = s;
    }
    // SD_MODE high = amp on, left channel. Off after ~0.3 s of silence so it does not hiss.
    if (sounding) {
      idleBlocks = 0;
      if (!ampOn) { digitalWrite(PIN_AMP_SD, HIGH); ampOn = true; }
    } else if (ampOn && ++idleBlocks > 20) {
      digitalWrite(PIN_AMP_SD, LOW);
      ampOn = false;
    }
    size_t wrote;
    i2s_channel_write(txh, out, n * 8, &wrote, portMAX_DELAY);
  }
}

// ── UI ─────────────────────────────────────────────────────────────────────────────────────
static char bigText[12] = "ready";
static char subText[24] = "keys, knobs, talk bar";
static int encCount[ENCODER_COUNT];
static bool dirty = true;

static float dbfs(int32_t peak24) { return peak24 > 0 ? 20 * log10f(peak24 / 8388608.0f) : -120; }

// Pixels lost to the panel's edges on the bench module: everything is drawn inside this margin
// (mp_oled_test has the crop check).
static const int INSET = 2;
static const int X0 = INSET, Y0 = INSET, W = 128 - 2 * INSET, H = 64 - 2 * INSET;

static void drawOled() {
  oled.clearBuffer();
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0, Y0 + 7, "keybordy MP");
  char buf[24];
  snprintf(buf, sizeof buf, "vol %d", volume);
  oled.drawStr(X0 + W - oled.getStrWidth(buf), Y0 + 7, buf);
  oled.drawHLine(X0, Y0 + 10, W);
  oled.setFont(u8g2_font_logisoso22_tr);
  oled.drawStr(X0 + (W - oled.getStrWidth(bigText)) / 2, Y0 + 37, bigText);
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0 + (W - oled.getStrWidth(subText)) / 2, Y0 + 48, subText);
  // mic meter: -60..0 dBFS
  float db = dbfs(meter);
  int fill = constrain((int)((db + 60) / 60 * (W - 4)), 0, W - 4);
  oled.drawFrame(X0, Y0 + H - 7, W, 7);
  if (fill > 0) oled.drawBox(X0 + 2, Y0 + H - 5, fill, 3);
  oled.sendBuffer();
}

static const uint8_t PENTA[5] = {0, 2, 4, 7, 9};
static float keyHz(int slot) {
  int midi = 60 + 12 * (slot / 5) + PENTA[slot % 5];
  return 440.0f * powf(2, (midi - 69) / 12.0f);
}
static const int TALK_SLOT = 20;  // K21, the 2u talk bar

static void handle(const Event &e) {
  switch (e.kind) {
    case EV_KEY: {
      Serial.printf("key %d %s (R%d C%d)\n", e.id + 1, e.val ? "down" : "up", e.r, e.c);
      if (e.id == TALK_SLOT && rec) {
        if (e.val) {
          playing = false; recLen = 0; recording = true;
          Serial.println("rec start");
          strcpy(bigText, "REC"); strcpy(subText, "release to play");
        } else {
          recording = false;
          Serial.printf("rec %.1f s\nplay\n", recLen / (float)FS);
          playPos = 0; playing = true;
          strcpy(bigText, "PLAY"); snprintf(subText, sizeof subText, "%.1f s", recLen / (float)FS);
        }
      } else if (e.val) {
        playTone(keyHz(e.id), 70);
        snprintf(bigText, sizeof bigText, "K%d", e.id + 1);
        snprintf(subText, sizeof subText, "R%d C%d", e.r, e.c);
      }
      break;
    }
    case EV_ENC_PUSH:
      Serial.printf("enc %s %s (R%d C%d)\n", ENCODER_IDS[e.id], e.val ? "push" : "release", e.r, e.c);
      if (e.val) { snprintf(bigText, sizeof bigText, "%s", ENCODER_IDS[e.id]); strcpy(subText, "push"); playTone(1760, 40); }
      break;
    case EV_ENC_TURN:
      Serial.printf("enc %s %s\n", ENCODER_IDS[e.id], e.val > 0 ? "cw" : "ccw");
      encCount[e.id] += e.val;
      if (e.id == 0) {
        volume = constrain(volume + e.val, 0, 10);
        snprintf(bigText, sizeof bigText, "vol %d", volume);
        playTone(1320, 25);
      } else {
        snprintf(bigText, sizeof bigText, "%s %d", ENCODER_IDS[e.id], encCount[e.id]);
      }
      snprintf(subText, sizeof subText, "%s", e.val > 0 ? "cw" : "ccw");
      break;
    case EV_EMPTY:
      Serial.printf("empty slot %s (R%d C%d): check wiring\n", e.val ? "down" : "up", e.r, e.c);
      break;
  }
  dirty = true;
}

void setup() {
  Serial.begin(115200);
#if BENCH
  rgbLedWrite(48, LED_LEVEL, LED_LEVEL, LED_LEVEL);
#endif
  for (int r = 0; r < MATRIX_ROWS; r++) pinMode(MATRIX_ROW_PINS[r], INPUT);
  for (int c = 0; c < MATRIX_COLS; c++) pinMode(MATRIX_COL_PINS[c], INPUT_PULLUP);
  for (int e = 0; e < ENCODER_COUNT; e++) {
    pinMode(ENCODER_PIN_A[e], INPUT_PULLUP);
    pinMode(ENCODER_PIN_B[e], INPUT_PULLUP);
  }
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);

  SPI.begin(PIN_OLED_SCK, -1, PIN_OLED_MOSI, -1);
  oled.setBusClock(1000000);  // 8 MHz gave a black screen over bench jumpers; 1 MHz works (mp_oled_diag)
  oled.begin();
  drawOled();

  rec = (int16_t *)(psramFound() ? ps_malloc(REC_MAX * 2) : malloc(REC_MAX * 2));
  bool audio = audioInit();

  events = xQueueCreate(32, sizeof(Event));
  xTaskCreatePinnedToCore(scanTask, "scan", 4096, nullptr, 5, nullptr, 0);
  if (audio) xTaskCreatePinnedToCore(audioTask, "audio", 4096, nullptr, 4, nullptr, 1);

  delay(1500);  // let the Mac open the CDC port before the first line
  Serial.printf("mp_proto ready (audio %s, psram %s)\n", audio ? "on" : "FAILED", psramFound() ? "yes" : "no");
  if (audio) { playTone(880, 90); delay(110); playTone(1318.5f, 140); }
  benchNetBegin("keybordy-mp", true);
}

void loop() {
  static uint32_t lastDraw, lastMic;
  Event e;
  while (xQueueReceive(events, &e, 0) == pdTRUE) handle(e);
  uint32_t now = millis();
  if (recording) {
    snprintf(subText, sizeof subText, "%.1f s, release to play", recLen / (float)FS);
    if (recLen >= REC_MAX) { recording = false; playPos = 0; playing = true; strcpy(bigText, "PLAY"); Serial.println("rec full\nplay"); }
    dirty = true;
  }
  if (now - lastMic >= 2000) {
    lastMic = now;
    Serial.printf("mic L %.0f R %.0f dBFS\n", dbfs(peakL), dbfs(peakR));
    peakL = peakR = 0;
  }
  if (dirty || now - lastDraw >= 50) {
    drawOled();
    lastDraw = now;
    dirty = false;
  }
  delay(2);
}
