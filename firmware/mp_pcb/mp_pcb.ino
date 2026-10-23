// keybordy MP rev A PCB: the bring-up firmware for every part on the board, with the PCB's own pins
// (board_pins.h), no bench remaps: OLED CS on GPIO48, DC on GPIO43, RES on EN. Serial is the native
// USB port (USB-Serial-JTAG, CDC on boot), the only port the PCB has; GPIO43 is UART0 TX, which is
// the OLED's DC here, so nothing may print on UART0. Build and flash with `just mp-pcb-flash` (it
// sets CDCOnBoot=cdc). Assembly guide: manual/pcb/ (`just manual pcb/`).
//
// Serial at 115200 (lines the guide shows as expected output):
//   probe GPIO42 CLK ... / probe done   OLED lines before SPI takes them
//   mp_pcb ready (audio on, psram yes)
//   key N down|up (Rr Cc)               every key; the mic LED (GPIO45) is lit while one is held
//   enc E1 cw|ccw, enc E1 push|release (R4 C0)   encoders; E1 also sets the volume
//   boot down|up                        the BOOT button (GPIO0)
//   mic L -68 R -120 dBFS               peak of both I2S slots every 2 s (MIC switch on: L moves)
//   bat 3.92 V charging|not charging    every 10 s: VBAT through the 100k/100k divider, CHG on GPIO44
//   rec start / rec 2.4 s / play        hold K21 (the talk bar) to record up to 4 s, release to play
//   power off (E1 held 2 s)             soft off: deep sleep until E1 is pressed again (or send `off`)
//   wifi ... / ota ...                  Wi-Fi from .env (`just mp-secrets`), OTA as keybordy-mp-pcb.local
// Flash over Wi-Fi with `just mp-pcb-ota` once this sketch is on the board (the first time needs USB).
// Every key beeps its own note; the boot chime is two rising notes. The audio and matrix code is
// mp_proto's, which ran on the bench.

#include <SPI.h>
#include <U8g2lib.h>
#include "driver/i2s_std.h"
#include "driver/rtc_io.h"
#include "esp_sleep.h"
#include "board_pins.h"
#include <KeybordyBench.h>  // Wi-Fi + ArduinoOTA, credentials from the gitignored bench_secrets.h

// Its own mDNS name, so it never answers for the bench DevKit (keybordy-mp.local) by mistake.
static const char *HOSTNAME = "keybordy-mp-pcb";

static const uint32_t SETTLE_US = 30;
static const uint32_t DEBOUNCE_MS = 15;
static const uint32_t FS = 16000;           // I2S sample rate, mic and amp share BCLK/WS
static const int FRAMES = 256;              // 16 ms per I2S block
static const uint32_t REC_MAX = FS * 4;     // 4 s of 16-bit mono
static const int TALK_SLOT = 20;            // K21, the 2u talk bar
// Flip one encoder's direction here if it turns the wrong way (EC11 and PEC11R pin orders differ).
static const int8_t ENC_DIR[ENCODER_COUNT] = {1, 1, 1};
// Soft power: hold E1's push this long to switch off. E1's push joins column C0 (GPIO16) to row R4
// (GPIO15) through its diode, so in deep sleep R4 is held LOW and C0 pulled up: pressing E1 pulls C0
// LOW and wakes the chip (ext1). The other rows float, so no key on C0 can wake it. The PWR switch
// stays the hard battery cut; the charger keeps charging over USB while the chip sleeps.
static const uint32_t OFF_HOLD_MS = 2000;
static const uint8_t WAKE_ROW = 15, WAKE_COL = 16;

// R2: the panel is mounted upside down (its cable is too short to reach J3 the other way round).
// U8g2 rotates in software, so the per-frame OLED_REASSERT below still sends the normal scan order.
U8G2_SSD1309_128X64_NONAME2_F_4W_HW_SPI oled(U8G2_R2, PIN_OLED_CS, PIN_OLED_DC, U8X8_PIN_NONE);

// RES is on EN, but a reset over USB (esptool, the monitor) is a system reset that leaves EN alone,
// so the panel keeps whatever state it had. Every frame re-sends the unlock and the NONAME2 setup
// (from mp_voice), so a confused panel heals within one frame.
static const uint8_t OLED_REASSERT[] = {
  U8X8_START_TRANSFER(),
  U8X8_CA(0x0fd, 0x012),   // unlock
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

// ── Events from the scan task ──────────────────────────────────────────────────────────────
enum : uint8_t { EV_KEY, EV_ENC_PUSH, EV_ENC_TURN, EV_EMPTY, EV_BOOT };
struct Event { uint8_t kind; int8_t id; int8_t val; uint8_t r, c; };
static QueueHandle_t events;
static volatile int held;                   // keys and pushes down right now
// E1's push straight from the scan, not through the queue: soft power must not hang on a lost event.
static volatile bool e1Held;

static void post(uint8_t kind, int8_t id, int8_t val, uint8_t r = 0, uint8_t c = 0) {
  Event e = {kind, id, val, r, c};
  xQueueSend(events, &e, 0);
}

// The matrix (COL2ROW: a row driven LOW, columns pulled up, a diode per key and per push), the
// encoders' quadrature and the BOOT button, once per millisecond on core 0.
static void scanTask(void *) {
  static bool stable[MATRIX_ROWS][MATRIX_COLS], raw[MATRIX_ROWS][MATRIX_COLS];
  static uint32_t changedAt[MATRIX_ROWS][MATRIX_COLS];
  static const int8_t QDEC[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};
  uint8_t encState[ENCODER_COUNT];
  int8_t encAcc[ENCODER_COUNT] = {};
  bool bootStable = false, bootRaw = false;
  uint32_t bootChangedAt = 0;
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
          held += down ? 1 : -1;
          int slot = MATRIX_SLOT[r][c];
          if (slot == KEY_COUNT) e1Held = down;
          if (slot < 0) post(EV_EMPTY, -1, down, r, c);
          else if (slot < KEY_COUNT) post(EV_KEY, slot, down, r, c);
          else post(EV_ENC_PUSH, slot - KEY_COUNT, down, r, c);
        }
      }
      digitalWrite(MATRIX_ROW_PINS[r], HIGH);  // recharge the columns before the next row
      pinMode(MATRIX_ROW_PINS[r], INPUT);
    }
    // A/B rest high between detents (10k pull-ups on the PCB). Count transitions and report at the
    // rest state, which also resyncs after contact bounce.
    for (int e = 0; e < ENCODER_COUNT; e++) {
      uint8_t s = (digitalRead(ENCODER_PIN_A[e]) << 1) | digitalRead(ENCODER_PIN_B[e]);
      if (s == encState[e]) continue;
      encAcc[e] += QDEC[(encState[e] << 2) | s];
      encState[e] = s;
      if (s == 3) {
        if (encAcc[e] >= 2) post(EV_ENC_TURN, e, ENC_DIR[e]);
        else if (encAcc[e] <= -2) post(EV_ENC_TURN, e, -ENC_DIR[e]);
        encAcc[e] = 0;
      }
    }
    bool b = digitalRead(PIN_BOOT) == LOW;
    if (b != bootRaw) { bootRaw = b; bootChangedAt = now; }
    if (b != bootStable && now - bootChangedAt >= DEBOUNCE_MS) { bootStable = b; post(EV_BOOT, -1, b); }
    vTaskDelay(1);
  }
}

// ── Audio: one I2S port, full duplex, mic on RX and amp on TX with shared clocks ───────────
static i2s_chan_handle_t txh, rxh;
static int16_t *rec;
static volatile uint32_t recLen, playPos;
static volatile bool recording, playing;
// powerOff() parks the audio task between blocks: i2s_channel_disable() waits for the channel's
// semaphore, which this higher-priority task holds inside every read and write, so disabling under
// a running task never returns.
static volatile bool audioPark, audioParked;
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
    if (audioPark) { audioParked = true; vTaskSuspend(nullptr); }
    size_t got = 0;
    i2s_channel_read(rxh, in, sizeof in, &got, portMAX_DELAY);
    int n = got / 8;
    int32_t pl = 0, pr = 0;
    for (int i = 0; i < n; i++) {
      int32_t l = in[2 * i] >> 8, r = in[2 * i + 1] >> 8;  // 24-bit samples, left-justified
      pl = max(pl, abs(l));
      pr = max(pr, abs(r));
      // The ICS-43434's SELECT is on GND: it talks in the left slot. +24 dB for 16-bit speech.
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

// ── Battery ────────────────────────────────────────────────────────────────────────────────
// VBAT through 100k/100k into GPIO1 (ADC1). CHG on GPIO44 is the BQ24075's open-drain status,
// pulled up by R3: LOW while charging. With no cell in J2 the charger's VBAT pin wanders, so the
// voltage means little until a battery is plugged in.
static float batVolts() { return analogReadMilliVolts(PIN_VBAT_ADC) * 2 / 1000.0f; }
static bool charging() { return digitalRead(PIN_CHARGE_STAT) == LOW; }

// The header's battery: 16 ADC reads, smoothed once a second, so the percentage does not flicker.
static float batSmooth;
static void batSample() {
  uint32_t mv = 0;
  for (int i = 0; i < 16; i++) mv += analogReadMilliVolts(PIN_VBAT_ADC);
  float v = mv * 2 / 16 / 1000.0f;
  batSmooth = batSmooth ? batSmooth + (v - batSmooth) * 0.2f : v;
}

// LiPo resting voltage to charge, linear between points. Reads high while charging (the charge
// current lifts the cell's voltage), which is fine for a header icon.
static int batPercent(float v) {
  static const float V[] = {3.30f, 3.60f, 3.70f, 3.75f, 3.80f, 3.85f, 3.95f, 4.05f, 4.15f, 4.20f};
  static const int P[] = {0, 5, 12, 25, 40, 55, 70, 83, 95, 100};
  if (v <= V[0]) return 0;
  for (int i = 1; i < 10; i++)
    if (v < V[i]) return P[i - 1] + (P[i] - P[i - 1]) * (v - V[i - 1]) / (V[i] - V[i - 1]);
  return 100;
}

// External power: CHG is LOW only while USB charges the cell; once it is full CHG goes high, so a
// USB host's frames count too. There is no VBUS sense on rev A, so a dumb charger with a full cell
// reads as battery. isPlugged() flaps for a few ms, so it counts as plugged for 1.5 s after a frame.
static bool usbPowered() {
  static uint32_t seenAt;
  if (Serial.isPlugged()) seenAt = millis() | 1;
  return charging() || (seenAt && millis() - seenAt < 1500);
}

// ── UI ─────────────────────────────────────────────────────────────────────────────────────
static char bigText[12] = "ready";
static char subText[28] = "keys, knobs, talk bar";
static int encCount[ENCODER_COUNT];
static bool dirty = true;

static float dbfs(int32_t peak24) { return peak24 > 0 ? 20 * log10f(peak24 / 8388608.0f) : -120; }

static const int INSET = 2;
static const int X0 = INSET, Y0 = INSET, W = 128 - 2 * INSET, H = 64 - 2 * INSET;

// 7 px icons left of the percentage: a bolt while charging, a plug on USB with the cell full.
static const uint8_t ICON_BOLT[] = {0x18, 0x0c, 0x06, 0x1f, 0x0c, 0x06, 0x03};   // 5x7
static const uint8_t ICON_PLUG[] = {0x22, 0x22, 0x7f, 0x3e, 0x1c, 0x08, 0x08};   // 7x7

// Top right: [bolt|plug] 87% [battery]. Below 3 V there is no cell in J2: the outline stays empty.
static void drawBattery() {
  int bx = X0 + W - 13, by = Y0 + 1;                // 12x7 body plus a 1x3 nub on the right
  oled.drawFrame(bx, by, 12, 7);
  oled.drawVLine(bx + 12, by + 2, 3);
  bool cell = batSmooth >= 3.0f;
  int pct = batPercent(batSmooth);
  if (cell) oled.drawBox(bx + 2, by + 2, (8 * pct + 50) / 100, 3);
  char buf[6];
  if (cell) snprintf(buf, sizeof buf, "%d%%", pct);
  else strcpy(buf, "--%");
  int tx = bx - 2 - oled.getStrWidth(buf);
  oled.drawStr(tx, Y0 + 7, buf);
  if (charging()) oled.drawXBM(tx - 7, by, 5, 7, ICON_BOLT);
  else if (usbPowered()) oled.drawXBM(tx - 9, by, 7, 7, ICON_PLUG);
}

static void drawOled() {
  oled.clearBuffer();
  oled.setFont(u8g2_font_5x8_tr);
  char buf[24];
  snprintf(buf, sizeof buf, "vol %d", volume);
  oled.drawStr(X0, Y0 + 7, buf);
  drawBattery();
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
  u8x8_cad_SendSequence(oled.getU8x8(), OLED_REASSERT);
  oled.sendBuffer();
}

static void testPattern() {
  oled.clearBuffer(); oled.drawBox(0, 0, 128, 64); oled.sendBuffer();          // every pixel on
  delay(400);
  oled.clearBuffer();
  for (int y = 0; y < 64; y += 8)
    for (int x = 0; x < 128; x += 8)
      if (((x + y) / 8) % 2 == 0) oled.drawBox(x, y, 8, 8);                    // checkerboard
  oled.sendBuffer();
  delay(400);
  oled.clearBuffer();
  oled.setFont(u8g2_font_4x6_tr);
  oled.drawFrame(0, 0, 128, 64);
  oled.drawFrame(2, 2, 124, 60);
  oled.drawStr(10, 20, "keybordy MP rev A");
  oled.drawStr(10, 32, "OLED on J3: ok");
  oled.sendBuffer();
  delay(1500);
}

// Passive check of the OLED lines on the ESP32 side, before SPI takes them (see mp_oled_test).
// Without the OLED soldered both lines float; with it, the powered module pulls them up (CLK and
// DIN did on the bench; CS and DC are left out because the bench never proved a pull-up there).
static void probeWiring() {
  struct { uint8_t pin; const char *name; } lines[] = {{PIN_OLED_SCK, "CLK"}, {PIN_OLED_MOSI, "DIN"}};
  for (auto &l : lines) {
    pinMode(l.pin, INPUT_PULLDOWN); delay(5);
    int pd = digitalRead(l.pin);
    pinMode(l.pin, INPUT_PULLUP); delay(5);
    int pu = digitalRead(l.pin);
    const char *verdict = pd && pu ? "pulled up by the module (connected, powered)"
                        : !pd && !pu ? "held LOW: short to GND?"
                        : "floating (no OLED yet, or an open joint)";
    Serial.printf("probe GPIO%-2d %-3s pd=%d pu=%d: %s\n", l.pin, l.name, pd, pu, verdict);
  }
  Serial.println("probe done");
}

// ── Soft power ─────────────────────────────────────────────────────────────────────────────
static uint32_t e1DownAt;        // E1 push held since (0: not held, or not armed)
static bool e1Armed = true;      // false after a wake by E1, until E1 is released once

static bool offPending;           // held long enough: sleep as soon as E1 is let go
static TaskHandle_t scanHandle;

// Deep sleep. Called on E1's release, so the press that switched it off cannot wake it at once.
static void powerOff() {
  vTaskSuspend(scanHandle);       // the matrix pins are about to change hands
  digitalWrite(PIN_AMP_SD, LOW);
  digitalWrite(PIN_MIC_LED, LOW);
  audioPark = true;
  for (int i = 0; i < 50 && !audioParked; i++) delay(2);   // one I2S block is 16 ms
  if (audioParked) {              // no BCLK: the mic drops into its own sleep mode
    i2s_channel_disable(txh);
    i2s_channel_disable(rxh);
  }
  oled.setPowerSave(1);           // SSD1309 display off
  Serial.println("power off");
  Serial.flush();
  delay(50);
  for (int r = 0; r < MATRIX_ROWS; r++) pinMode(MATRIX_ROW_PINS[r], INPUT);
  rtc_gpio_init((gpio_num_t)WAKE_ROW);
  rtc_gpio_set_direction((gpio_num_t)WAKE_ROW, RTC_GPIO_MODE_OUTPUT_ONLY);
  rtc_gpio_set_level((gpio_num_t)WAKE_ROW, 0);
  rtc_gpio_hold_en((gpio_num_t)WAKE_ROW);
  rtc_gpio_init((gpio_num_t)WAKE_COL);
  rtc_gpio_set_direction((gpio_num_t)WAKE_COL, RTC_GPIO_MODE_INPUT_ONLY);
  rtc_gpio_pulldown_dis((gpio_num_t)WAKE_COL);
  rtc_gpio_pullup_en((gpio_num_t)WAKE_COL);
  esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);   // keeps the RTC pull-up on
  esp_sleep_enable_ext1_wakeup(1ULL << WAKE_COL, ESP_EXT1_WAKEUP_ANY_LOW);
  esp_deep_sleep_start();
}

static const uint8_t PENTA[5] = {0, 2, 4, 7, 9};
static float keyHz(int slot) {
  int midi = 60 + 12 * (slot / 5) + PENTA[slot % 5];
  return 440.0f * powf(2, (midi - 69) / 12.0f);
}

static void handle(const Event &e) {
  switch (e.kind) {
    case EV_KEY:
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
      Serial.printf("slot R%d C%d %s (no key here)\n", e.r, e.c, e.val ? "down" : "up");
      break;
    case EV_BOOT:
      Serial.printf("boot %s\n", e.val ? "down" : "up");
      if (e.val) { strcpy(bigText, "BOOT"); strcpy(subText, "GPIO0"); }
      break;
  }
  dirty = true;
}

void setup() {
  bool wokeByE1 = esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT1;
  rtc_gpio_hold_dis((gpio_num_t)WAKE_ROW);   // undo the sleep setup before the matrix takes the pins
  rtc_gpio_deinit((gpio_num_t)WAKE_ROW);
  rtc_gpio_deinit((gpio_num_t)WAKE_COL);
  e1Armed = !wokeByE1;                        // the press that woke it must not switch it off again
  Serial.begin(115200);
  // Plugged into a Mac with no monitor open, the host stops reading and the TX ring fills: with the
  // default 100 ms timeout each print then blocks up to 2 s (20 retries) and the UI freezes. Never
  // wait: lines nobody reads are dropped.
  Serial.setTxTimeoutMs(0);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);  // let the monitor attach before the probe prints
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);
  pinMode(PIN_MIC_LED, OUTPUT);
  for (int i = 0; i < 3; i++) { digitalWrite(PIN_MIC_LED, HIGH); delay(80); digitalWrite(PIN_MIC_LED, LOW); delay(80); }
  if (!wokeByE1) probeWiring();
  for (int r = 0; r < MATRIX_ROWS; r++) pinMode(MATRIX_ROW_PINS[r], INPUT);
  for (int c = 0; c < MATRIX_COLS; c++) pinMode(MATRIX_COL_PINS[c], INPUT_PULLUP);
  for (int e = 0; e < ENCODER_COUNT; e++) {
    pinMode(ENCODER_PIN_A[e], INPUT_PULLUP);
    pinMode(ENCODER_PIN_B[e], INPUT_PULLUP);
  }
  pinMode(PIN_BOOT, INPUT_PULLUP);
  pinMode(PIN_CHARGE_STAT, INPUT);
  if (wokeByE1) {                 // a quick tap may be over already: then arm at once
    pinMode(WAKE_ROW, OUTPUT); digitalWrite(WAKE_ROW, LOW); delayMicroseconds(SETTLE_US);
    e1Armed = digitalRead(WAKE_COL) == HIGH;
    digitalWrite(WAKE_ROW, HIGH); pinMode(WAKE_ROW, INPUT);
  }
  analogSetPinAttenuation(PIN_VBAT_ADC, ADC_11db);
  batSample();

  SPI.begin(PIN_OLED_SCK, -1, PIN_OLED_MOSI, PIN_OLED_CS);
  oled.setBusClock(1000000);  // the bench's proven clock; traces could take more, but bring-up first
  oled.begin();
  if (!wokeByE1) testPattern();
  drawOled();

  rec = (int16_t *)(psramFound() ? ps_malloc(REC_MAX * 2) : malloc(REC_MAX * 2));
  bool audio = audioInit();
  events = xQueueCreate(32, sizeof(Event));
  xTaskCreatePinnedToCore(scanTask, "scan", 4096, nullptr, 5, &scanHandle, 0);
  if (audio) xTaskCreatePinnedToCore(audioTask, "audio", 4096, nullptr, 4, nullptr, 1);

  Serial.printf("mp_pcb ready (audio %s, psram %s)%s\n", audio ? "on" : "FAILED", psramFound() ? "yes" : "no", wokeByE1 ? ", woke by E1" : "");
  Serial.printf("bat %.2f V %s\n", batVolts(), charging() ? "charging" : "not charging");
  if (audio) { playTone(880, 90); delay(110); playTone(1318.5f, 140); }
  benchNetBegin(HOSTNAME, true);
}

void loop() {
  static uint32_t lastDraw, lastMic, lastBat, lastBatSample;
  Event e;
  while (xQueueReceive(events, &e, 0) == pdTRUE) handle(e);
  if (Serial.available()) {                  // `off` from the monitor: soft off without E1
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "off") powerOff();
  }
  uint32_t now = millis();
  digitalWrite(PIN_MIC_LED, held > 0 || recording ? HIGH : LOW);
  if (recording) {
    snprintf(subText, sizeof subText, "%.1f s, release to play", recLen / (float)FS);
    if (recLen >= REC_MAX) { recording = false; playPos = 0; playing = true; strcpy(bigText, "PLAY"); Serial.println("rec full\nplay"); }
    dirty = true;
  }
  static bool e1Was;
  if (e1Held != e1Was) {
    e1Was = e1Held;
    if (e1Was) e1DownAt = e1Armed ? now | 1 : 0;
    else { e1DownAt = 0; e1Armed = true; if (offPending) powerOff(); }
  }
  if (e1DownAt && !offPending && !benchOtaActive() && now - e1DownAt >= OFF_HOLD_MS) {
    offPending = true;
    Serial.println("power off (E1 held 2 s): let go of E1");
    strcpy(bigText, "bye"); strcpy(subText, "let go; tap E1 to wake");
    dirty = true;
  }
  if (now - lastMic >= 2000) {
    lastMic = now;
    Serial.printf("mic L %.0f R %.0f dBFS\n", dbfs(peakL), dbfs(peakR));
    peakL = peakR = 0;
  }
  if (now - lastBatSample >= 1000) { lastBatSample = now; batSample(); }
  if (now - lastBat >= 10000) {
    lastBat = now;
    Serial.printf("bat %.2f V %s\n", batVolts(), charging() ? "charging" : "not charging");
  }
  if (benchOtaActive()) {
    strcpy(bigText, "OTA"); snprintf(subText, sizeof subText, "%d %%  keep power on", benchOtaProgress());
    dirty = true;
  }
  if (dirty || now - lastDraw >= 50) {
    drawOled();
    lastDraw = now;
    dirty = false;
  }
  delay(2);
}
