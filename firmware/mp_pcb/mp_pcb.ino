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
//   rec start / rec 2.4 s               hold K21 (the talk bar) to record up to 30 s, release to send
//   talk sent / talk done / talk failed: ...   the take's trip to the Mac (local echo if no Mac)
//   power off (E1 held 2 s)             soft off: deep sleep until E1 is pressed again (or send `off`)
//   ble advertising|connected|disconnected   the Bluetooth keyboard
//   wifi ... / ota ...                  Wi-Fi from .env (`just mp-secrets`), OTA as keybordy-mp-pcb.local
// Flash over Wi-Fi with `just mp-pcb-ota` once this sketch is on the board (the first time needs USB).
// Every key beeps its own note; the boot chime is two rising notes. The audio and matrix code is
// mp_proto's, which ran on the bench.
//
// Mac side (host/): it is a BLE keyboard named "keybordy MP". Every key except the talk bar, and
// E2/E3, taps one F13..F20 combo that host/hammerspoon/keybordy.lua maps to the action set in the
// keymap editor. The talk bar records a take and POSTs it over Wi-Fi to host/voice.py (found over
// mDNS as _keybordy-pad._tcp), which transcribes it with Echo, asks `claude -p` and streams the
// answer back in Davide's voice, with OLED status lines in between:
//   POST /take  X-Keybordy-Token: <BENCH_OTA_PASS>  body: 16 kHz mono int16 LE
//   POST /new                                       E1 tap: start a new Claude session
//   POST /replay                                    K20 after a reboot: the last answer again
//   POST /yes, /no                                  K22/K19 while Claude waits for a yes or no
//   response, line by line: "S BIG|small\n" (OLED status), "T text\n" (scrolls while spoken),
//   "C question\n" (scrolls, and K22/K19 answer it), "P <bytes>\n" + int16 LE to play
// E1 stays on the board: volume, tap for a new session, hold for soft off. K20 replays the last
// answer from PSRAM (from the Mac after a reboot); pressed while it plays, it stops it.

#include <SPI.h>
#include <U8g2lib.h>
#include "driver/i2s_std.h"
#include "driver/rtc_io.h"
#include "esp_sleep.h"
#include "board_pins.h"
#include <KeybordyBench.h>  // Wi-Fi + ArduinoOTA, credentials from the gitignored bench_secrets.h
#include "bench_secrets.h"  // BENCH_OTA_PASS doubles as the token host/voice.py checks
#include <WiFi.h>
#include <ESPmDNS.h>
#include <BLEDevice.h>
#include <BLEHIDDevice.h>
#include <BLESecurity.h>
#include <BLEServer.h>

// Its own mDNS name, so it never answers for the bench DevKit (keybordy-mp.local) by mistake.
static const char *HOSTNAME = "keybordy-mp-pcb";

static const uint32_t SETTLE_US = 30;
static const uint32_t DEBOUNCE_MS = 15;
static const uint32_t FS = 16000;           // I2S sample rate, mic and amp share BCLK/WS
static const int FRAMES = 256;              // 16 ms per I2S block
static const uint32_t REC_MAX = FS * 30;    // 30 s of 16-bit mono, in PSRAM
static const uint32_t REPLY_MAX = FS * 120; // the spoken answer, 2 min
static const int TALK_SLOT = 20;            // K21, the 2u talk bar
static const int REPLAY_SLOT = 19;          // K20: says the last answer again
// While Claude waits for a yes or no (a "C" line), K22 answers yes and K19 no instead of their combos.
static const int YES_SLOT = 21, NO_SLOT = 18;
static const uint32_t CONFIRM_MS = 120000;  // a question nobody answers stops waiting
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
// The Mac's spoken answer: the talk task appends chunks while the audio task plays behind it.
static int16_t *reply;
static volatile uint32_t replyLen, replyPos;
static volatile bool replying, replyOpen;   // playing it; more chunks may still come
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
      if (replying) {
        if (replyPos < replyLen) v = reply[replyPos++] / 32768.0f;
        else if (!replyOpen) replying = false;
        sounding = true;                     // between chunks too, so the amp stays on
      } else if (playing) {
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
// The answer (or Claude's question) scrolling in place of the small line while it is spoken.
static char ticker[200], lastTicker[200];
static uint32_t tickerAt;
static volatile bool confirmPending;
static uint32_t confirmAt;
static int encCount[ENCODER_COUNT];
static bool dirty = true;

static float dbfs(int32_t peak24) { return peak24 > 0 ? 20 * log10f(peak24 / 8388608.0f) : -120; }

static const int INSET = 2;
static const int X0 = INSET, Y0 = INSET, W = 128 - 2 * INSET, H = 64 - 2 * INSET;

// 7 px icons left of the percentage: a bolt while charging, a plug on USB with the cell full.
static const uint8_t ICON_BOLT[] = {0x18, 0x0c, 0x06, 0x1f, 0x0c, 0x06, 0x03};   // 5x7
static const uint8_t ICON_PLUG[] = {0x22, 0x22, 0x7f, 0x3e, 0x1c, 0x08, 0x08};   // 7x7
// Left of the header, after the volume: Bluetooth while a Mac is connected, Wi-Fi while joined.
static const uint8_t ICON_BT[] = {0x0c, 0x15, 0x0e, 0x04, 0x0e, 0x15, 0x0c};     // 5x7
static const uint8_t ICON_WIFI[] = {0x3e, 0x41, 0x1c, 0x22, 0x00, 0x08, 0x00};   // 7x7
static volatile bool bleConnected;

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

// 40 px/s after a 1.2 s hold on the start; text that fits stays still and centered.
static void drawTicker(int y) {
  static const char GAP[] = "   -   ";
  static const int TX = X0 + 4, TW = W - 8, CW = 5;   // u8g2_font_5x8 is fixed width
  int len = strlen(ticker), loop = len + sizeof GAP - 1;
  if (len * CW <= TW) { oled.drawStr(X0 + (W - len * CW) / 2, y, ticker); return; }
  uint32_t t = millis() - tickerAt;
  uint32_t px = t < 1200 ? 0 : (t - 1200) * 40 / 1000 % (loop * CW);
  char buf[TW / CW + 3];
  int n = TW / CW + 2, first = px / CW;
  for (int i = 0; i < n; i++) {
    int k = (first + i) % loop;
    buf[i] = k < len ? ticker[k] : GAP[k - len];
  }
  buf[n] = 0;
  oled.setClipWindow(TX, y - 8, TX + TW, y + 1);
  oled.drawStr(TX - px % CW, y, buf);
  oled.setMaxClipWindow();
}

static void drawOled() {
  oled.clearBuffer();
  oled.setFont(u8g2_font_5x8_tr);
  char buf[24];
  snprintf(buf, sizeof buf, "vol %d", volume);
  oled.drawStr(X0, Y0 + 7, buf);
  int ix = X0 + oled.getStrWidth(buf) + 5;
  if (bleConnected) { oled.drawXBM(ix, Y0 + 1, 5, 7, ICON_BT); ix += 8; }
  if (benchNetConnected()) oled.drawXBM(ix, Y0 + 1, 7, 7, ICON_WIFI);
  drawBattery();
  oled.drawHLine(X0, Y0 + 10, W);
  oled.setFont(u8g2_font_logisoso22_tr);
  oled.drawStr(X0 + (W - oled.getStrWidth(bigText)) / 2, Y0 + 37, bigText);
  oled.setFont(u8g2_font_5x8_tr);
  if (ticker[0]) drawTicker(Y0 + 48);
  else oled.drawStr(X0 + (W - oled.getStrWidth(subText)) / 2, Y0 + 48, subText);
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

// ── Bluetooth keyboard ─────────────────────────────────────────────────────────────────────
// Each key taps one combo on press (press report, then an empty one), so two keys from different
// groups can never mix their modifiers. macOS has no key codes for F21..F24, hence the modifiers:
//   K1..K8 F13..F20, K9..K16 shift+F13..F20, K17..K22 ctrl+F13..F18 (K20 replay and K21 talk never send)
//   E2 ccw/cw/push alt+F13..F15, E3 ccw/cw/push alt+F16..F18; E1 stays on the board
// host/hammerspoon/keybordy.lua binds the same table: change both together.
static const uint8_t MOD_CTRL = 0x01, MOD_SHIFT = 0x02, MOD_ALT = 0x04, USAGE_F13 = 0x68;

// Boot keyboard layout with report ID 1, as keys8. The usage range goes to 0xE7 rather than the
// usual 0x65, or F13..F20 would be out of range.
static const uint8_t REPORT_MAP[] = {
  0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x01,  // Generic Desktop, Keyboard, Application, ID 1
  0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08,
  0x81, 0x02,                                      //   modifiers
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01,              //   reserved
  0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0xE7, 0x05, 0x07, 0x19, 0x00, 0x29, 0xE7,
  0x81, 0x00,                                      //   up to 6 keys
  0xC0,
};

static BLEHIDDevice *hid;
static BLECharacteristic *hidInput;

class BleCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { bleConnected = true; Serial.println("ble connected"); }
  void onDisconnect(BLEServer *) override {
    bleConnected = false;
    Serial.println("ble disconnected");
    BLEDevice::startAdvertising();
  }
};

static void bleBegin() {
  BLEDevice::init("keybordy MP");
  // "Just Works" pairing with bonding: no PIN, the Mac reconnects on its own.
  BLESecurity *security = new BLESecurity();
  security->setCapability(ESP_IO_CAP_NONE);
  security->setAuthenticationMode(true, false, true);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new BleCallbacks());
  hid = new BLEHIDDevice(server);
  hid->manufacturer()->setValue("keybordy");
  hid->pnp(0x02, 0xE502, 0xA112, 0x0210);
  hid->hidInfo(0x00, 0x01);
  hid->reportMap((uint8_t *)REPORT_MAP, sizeof(REPORT_MAP));
  hidInput = hid->inputReport(1);
  hid->setBatteryLevel(batPercent(batSmooth));
  hid->startServices();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->setAppearance(HID_KEYBOARD);
  adv->addServiceUUID(hid->hidService()->getUUID());
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("ble advertising");
}

static void bleTap(uint8_t mods, uint8_t usage) {
  if (!bleConnected) return;
  uint8_t r[8] = {mods, 0, usage};
  hidInput->setValue(r, sizeof r);
  hidInput->notify();
  memset(r, 0, sizeof r);
  hidInput->setValue(r, sizeof r);
  hidInput->notify();
}

static void bleKey(int slot) {
  static const uint8_t GROUP_MODS[] = {0, MOD_SHIFT, MOD_CTRL};
  bleTap(GROUP_MODS[slot / 8], USAGE_F13 + slot % 8);
}

// enc 1 or 2 (E2, E3); what 0 ccw, 1 cw, 2 push.
static void bleKnob(int enc, int what) { bleTap(MOD_ALT, USAGE_F13 + (enc - 1) * 3 + what); }

// ── Talk bar: the take to host/voice.py and its answer back ────────────────────────────────
static volatile bool talkBusy, talkCancel;
static IPAddress macIp;
static uint16_t macPort;

static void setStatus(const char *big, const char *small) {
  snprintf(bigText, sizeof bigText, "%s", big);
  snprintf(subText, sizeof subText, "%s", small);
  dirty = true;
}

static void setTicker(const char *text) {
  snprintf(ticker, sizeof ticker, "%s", text);
  tickerAt = millis();
  dirty = true;
}

static bool findMac() {
  int n = MDNS.queryService("keybordy-pad", "tcp");
  for (int i = 0; i < n; i++) {
    if (MDNS.address(i) == IPAddress()) continue;
    macIp = MDNS.address(i);
    macPort = MDNS.port(i);
    Serial.printf("voice service at %s:%u\n", macIp.toString().c_str(), macPort);
    return true;
  }
  return false;
}

// One '\n'-terminated line, without the line end. False on close, cancel or after ms of silence.
static bool readLine(WiFiClient &c, char *buf, int cap, uint32_t ms) {
  int n = 0;
  uint32_t t = millis();
  while (millis() - t < ms && !talkCancel) {
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

// Appends `bytes` of int16 LE to the reply; playback starts with the first chunk.
static bool readChunk(WiFiClient &c, int bytes) {
  static uint8_t buf[1024];
  static uint8_t lo;
  bool odd = false;
  uint32_t t = millis();
  replying = true;
  while (bytes > 0 && !talkCancel) {
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
      odd = false;
      if (replyLen < REPLY_MAX) { reply[replyLen] = (int16_t)(lo | buf[i] << 8); replyLen = replyLen + 1; }
    }
  }
  return !talkCancel;
}

// POSTs the take (or nothing, for /new) and plays what comes back. Null, or what went wrong.
static const char *exchange(const char *path, bool withTake) {
  for (int i = 0; i < 50 && !benchNetConnected(); i++) vTaskDelay(pdMS_TO_TICKS(100));
  if (!benchNetConnected()) return "no wifi";
  WiFiClient c;
  if (!(macPort && c.connect(macIp, macPort, 3000)) && !(findMac() && c.connect(macIp, macPort, 3000)))
    return "no mac";
  c.setNoDelay(true);
  uint32_t bytes = withTake ? recLen * 2 : 0;
  c.printf("POST %s HTTP/1.0\r\nX-Keybordy-Token: %s\r\nContent-Type: application/octet-stream\r\n"
           "Content-Length: %u\r\n\r\n", path, BENCH_OTA_PASS, bytes);
  const uint8_t *p = (const uint8_t *)rec;
  uint32_t t = millis();
  while (bytes && !talkCancel) {
    size_t w = c.write(p, min(bytes, (uint32_t)4096));
    if (w) { p += w; bytes -= w; t = millis(); continue; }
    if (!c.connected() || millis() - t > 5000) return "upload failed";
    vTaskDelay(2);
  }
  if (withTake) Serial.printf("talk sent (%.1f s)\n", recLen / (float)FS);
  char line[224];   // T and C lines carry up to 190 characters
  // Claude can think for a while; voice.py sends a status line at least every few seconds.
  if (!readLine(c, line, sizeof line, 30000)) return talkCancel ? nullptr : "no answer";
  if (!strstr(line, " 200")) return strstr(line, " 403") ? "bad token" : "mac error";
  while (readLine(c, line, sizeof line, 10000) && line[0]) {}  // headers
  while (readLine(c, line, sizeof line, 180000)) {
    if (!strncmp(line, "S ", 2)) {
      char *bar = strchr(line + 2, '|');
      if (bar) *bar = 0;
      setStatus(line + 2, bar ? bar + 1 : "");
    } else if (!strncmp(line, "T ", 2) || !strncmp(line, "C ", 2)) {
      setTicker(line + 2);
      snprintf(lastTicker, sizeof lastTicker, "%s", line + 2);
      if (line[0] == 'C') {
        confirmPending = true;
        confirmAt = millis();
        Serial.printf("confirm? %s\n", line + 2);
      }
    } else if (!strncmp(line, "P ", 2)) {
      if (!readChunk(c, atoi(line + 2))) return talkCancel ? nullptr : "answer cut off";
    }
  }
  return nullptr;
}

static void talkTask(void *arg) {
  const char *path = (const char *)arg;
  bool withTake = !strcmp(path, "/take");
  if (strcmp(path, "/new")) replyLen = replyPos = 0;   // /new keeps the last answer for K20
  replyOpen = true;
  const char *err = exchange(path, withTake);
  replyOpen = false;
  if (talkCancel) Serial.println("talk cancelled");
  else if (err && withTake && !strcmp(err, "no mac")) {   // no voice.py: echo the take, as bring-up did
    Serial.println("talk failed: no mac, local echo");
    setStatus("ECHO", "no mac: playing it back");
    playPos = 0;
    playing = true;
  } else if (err) {
    Serial.printf("talk failed: %s\n", err);
    setStatus("ERROR", err);
  } else Serial.println("talk done");
  talkBusy = false;
  vTaskDelete(nullptr);
}

static void talkStart(const char *path) {
  talkCancel = false;
  talkBusy = true;
  xTaskCreatePinnedToCore(talkTask, "talk", 8192, (void *)path, 1, nullptr, 0);
}

// Stops an answer still playing or coming in, so a new request can start.
static void talkStop() {
  if (talkBusy) {
    talkCancel = true;
    for (int i = 0; i < 100 && talkBusy; i++) delay(5);
  }
  replying = playing = false;
  ticker[0] = 0;
  confirmPending = false;
}

// The talk bar went down: stop any answer, then record.
static void talkDown() {
  talkStop();
  recLen = 0;
  recording = true;
  Serial.println("rec start");
  setStatus("REC", "release to send");
}

static void talkUp() {
  if (!recording) return;
  recording = false;
  Serial.printf("rec %.1f s\n", recLen / (float)FS);
  if (recLen < FS / 4) { setStatus("TALK", "too short: hold the bar"); return; }
  setStatus("SENT", "to the Mac...");
  talkStart("/take");
}

// K20: the last answer again, from PSRAM, or from the Mac when this boot has none yet.
static void replay() {
  if (replying) {
    replying = false;
    setStatus("STOP", "K20 to hear it again");
    return;
  }
  if (talkBusy || recording) return;
  if (replyLen) {
    playing = false;
    replyPos = 0;
    replyOpen = false;
    replying = true;
    Serial.printf("replay %.1f s\n", replyLen / (float)FS);
    setStatus("REPLAY", "K20 again to stop");
    setTicker(lastTicker);
  } else {
    setStatus("REPLAY", "asking the Mac...");
    talkStart("/replay");
  }
}

// K22/K19 while Claude waits: the answer goes back as "yes"/"no" in the same session.
static void answerConfirm(bool yes) {
  talkStop();
  Serial.printf("confirm %s\n", yes ? "yes" : "no");
  setStatus(yes ? "YES" : "NO", "to Claude...");
  talkStart(yes ? "/yes" : "/no");
}

static void newChat() {
  if (talkBusy) return;
  ticker[0] = 0;
  confirmPending = false;
  setStatus("NEW", "new Claude session");
  talkStart("/new");
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
      if (e.id == TALK_SLOT) {
        if (!rec || !reply) break;
        if (e.val) talkDown();
        else talkUp();
      } else if (e.id == REPLAY_SLOT) {
        if (e.val && reply) replay();
      } else if (confirmPending && (e.id == YES_SLOT || e.id == NO_SLOT)) {
        if (e.val) answerConfirm(e.id == YES_SLOT);
      } else if (e.val) {
        bleKey(e.id);
        playTone(keyHz(e.id), 70);
        snprintf(bigText, sizeof bigText, "K%d", e.id + 1);
        snprintf(subText, sizeof subText, "R%d C%d", e.r, e.c);
      }
      break;
    case EV_ENC_PUSH:
      Serial.printf("enc %s %s (R%d C%d)\n", ENCODER_IDS[e.id], e.val ? "push" : "release", e.r, e.c);
      if (e.val) { snprintf(bigText, sizeof bigText, "%s", ENCODER_IDS[e.id]); strcpy(subText, "push"); playTone(1760, 40); }
      if (e.val && e.id > 0) bleKnob(e.id, 2);
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
        bleKnob(e.id, e.val > 0 ? 1 : 0);
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

  rec = (int16_t *)(psramFound() ? ps_malloc(REC_MAX * 2) : nullptr);
  reply = (int16_t *)(psramFound() ? ps_malloc(REPLY_MAX * 2) : nullptr);
  bool audio = audioInit();
  events = xQueueCreate(32, sizeof(Event));
  xTaskCreatePinnedToCore(scanTask, "scan", 4096, nullptr, 5, &scanHandle, 0);
  if (audio) xTaskCreatePinnedToCore(audioTask, "audio", 4096, nullptr, 4, nullptr, 1);

  Serial.printf("mp_pcb ready (audio %s, psram %s)%s\n", audio ? "on" : "FAILED", psramFound() ? "yes" : "no", wokeByE1 ? ", woke by E1" : "");
  Serial.printf("bat %.2f V %s\n", batVolts(), charging() ? "charging" : "not charging");
  if (audio) { playTone(880, 90); delay(110); playTone(1318.5f, 140); }
  benchNetBegin(HOSTNAME, true);
  bleBegin();
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
    snprintf(subText, sizeof subText, "%.1f s, release to send", recLen / (float)FS);
    if (recLen >= REC_MAX) talkUp();
    dirty = true;
  }
  static bool e1Was;
  if (e1Held != e1Was) {
    e1Was = e1Held;
    if (e1Was) e1DownAt = e1Armed ? now | 1 : 0;
    else {
      bool tap = e1DownAt && now - e1DownAt < OFF_HOLD_MS;
      e1DownAt = 0;
      e1Armed = true;
      if (offPending) powerOff();
      else if (tap) newChat();
    }
  }
  if (e1DownAt && !offPending && !benchOtaActive() && now - e1DownAt >= OFF_HOLD_MS) {
    offPending = true;
    Serial.println("power off (E1 held 2 s): let go of E1");
    strcpy(bigText, "bye"); strcpy(subText, "let go; tap E1 to wake");
    dirty = true;
  }
  if (confirmPending && now - confirmAt > CONFIRM_MS) {
    confirmPending = false;
    ticker[0] = 0;
    setStatus("ready", "question timed out");
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
    if (hid) hid->setBatteryLevel(batPercent(batSmooth));
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
