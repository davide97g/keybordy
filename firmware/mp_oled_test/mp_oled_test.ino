// keybordy MP bench: OLED test. A test pattern at boot, then a click counter. Every press of the
// DevKit's BOOT button or of a matrix key adds one; the screen shows the key's name (K1, K2, ...,
// BOOT) big, its own count and the total. Wiring: docs/macropad-bench.md (OLED CS on GPIO3, RES on
// EN, DC on GPIO1). Prints `key N down/up` and `boot down/up` at 115200 on whichever port the build
// uses: UART0/COM from the simulator editor, native USB from `just mp-flash`.

#include <SPI.h>
#include <U8g2lib.h>
#include "board_pins.h"
#include <KeybordyBench.h>  // Wi-Fi + OTA: `just mp-ota mp_oled_test`

static const uint32_t SETTLE_US = 30;
static const uint32_t DEBOUNCE_MS = 15;

// Bench: DC on GPIO1 instead of the PCB's GPIO43 (UART0 TX), so UART0 stays free for the COM
// port and the simulator's builds, which print there. GPIO1 is the PCB's VBAT sense; no battery here.
static const uint8_t OLED_DC = 1;
// Bench: CS on GPIO3 (the PCB's is GPIO48, the DevKit's WS2812 data line). With CS on a GPIO the
// panel resyncs its byte framing on every transfer; tied to GND, one stray CLK edge (a reset, a pin
// test) left the screen black until the next power cycle.
static const uint8_t OLED_CS = 3;
U8G2_SSD1309_128X64_NONAME2_F_4W_HW_SPI oled(U8G2_R0, OLED_CS, OLED_DC, U8X8_PIN_NONE);

static bool stable[MATRIX_ROWS][MATRIX_COLS], raw[MATRIX_ROWS][MATRIX_COLS];
static uint32_t changedAt[MATRIX_ROWS][MATRIX_COLS];
static bool bootStable, bootRaw;
static uint32_t bootChangedAt;

// Pixels lost to the panel's edges on this module: everything is drawn inside this margin. The
// boot pattern draws frames at 0..3 px so the right value can be read off the glass.
static const int INSET = 2;
static const int X0 = INSET, Y0 = INSET, W = 128 - 2 * INSET, H = 64 - 2 * INSET;

static uint32_t total;
static uint16_t keyCount[KEY_COUNT + 1];  // last slot is BOOT
static char big[8] = "ready";
static char sub[24] = "press BOOT or a key";
static uint32_t pulseAt;                  // the bottom bar fills on each click and drains in 600 ms
static const uint32_t PULSE_MS = 600;

// Same layout as mp_proto (and the 3D guide): header, rule, big centred text, a line under it,
// a framed bar at the bottom. Here the header's right side is the click total and the bar is a
// click pulse instead of the mic level.
static void draw(uint32_t now) {
  oled.clearBuffer();
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0, Y0 + 7, "keybordy MP");
  char buf[24];
  snprintf(buf, sizeof buf, "%lu clicks", (unsigned long)total);
  oled.drawStr(X0 + W - oled.getStrWidth(buf), Y0 + 7, buf);
  oled.drawHLine(X0, Y0 + 10, W);
  oled.setFont(u8g2_font_logisoso22_tr);
  oled.drawStr(X0 + (W - oled.getStrWidth(big)) / 2, Y0 + 37, big);
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(X0 + (W - oled.getStrWidth(sub)) / 2, Y0 + 48, sub);
  uint32_t age = now - pulseAt;
  int fill = total && age < PULSE_MS ? (int)((W - 4) * (PULSE_MS - age) / PULSE_MS) : 0;
  oled.drawFrame(X0, Y0 + H - 7, W, 7);
  if (fill > 0) oled.drawBox(X0 + 2, Y0 + H - 5, fill, 3);
  oled.sendBuffer();
}

static void click(int idx, const char *name, int r, int c) {
  total++;
  keyCount[idx]++;
  pulseAt = millis();
  snprintf(big, sizeof big, "%s", name);
  if (r >= 0) snprintf(sub, sizeof sub, "R%d C%d  x%u", r, c, keyCount[idx]);
  else snprintf(sub, sizeof sub, "GPIO0  x%u", keyCount[idx]);
  draw(pulseAt);
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
  // Crop ruler: a frame on the very edge and one 2 px in. If the outer one is missing on a side,
  // that side loses pixels and INSET has to cover it.
  oled.clearBuffer();
  oled.setFont(u8g2_font_4x6_tr);
  oled.drawFrame(0, 0, 128, 64);
  oled.drawFrame(2, 2, 124, 60);
  oled.drawStr(10, 16, "outer frame: edge 0");
  oled.drawStr(10, 26, "inner frame: 2 px in");
  oled.drawStr(10, 40, "count the lines");
  oled.drawStr(10, 48, "you can see");
  oled.sendBuffer();
  delay(4000);
}

// The OLED is write-only over 4-wire SPI, so the firmware cannot ask it anything. What it can check
// is the wiring on the ESP32 side, before SPI takes the pins: each line read with the internal
// pull-down, then the pull-up. A line the module pulls up (powered module with on-board pull-ups)
// reads 1 even against the pull-down; a floating line follows the pull (pd=0 pu=1), which means
// either unconnected or a module input without one.
// It never toggles CLK: with CS tied low (the first bench wiring), one stray edge shifted the
// panel's byte framing until the next reset. CS on GPIO3 fixes that, but the check stays passive.
static void probeWiring() {
  struct { uint8_t pin; const char *name; } lines[] = {{PIN_OLED_SCK, "CLK"}, {PIN_OLED_MOSI, "DIN"}, {OLED_DC, "DC"}};
  const int n = sizeof lines / sizeof lines[0];
  for (int i = 0; i < n; i++) {
    pinMode(lines[i].pin, INPUT_PULLDOWN); delay(5);
    int pd = digitalRead(lines[i].pin);
    pinMode(lines[i].pin, INPUT_PULLUP); delay(5);
    int pu = digitalRead(lines[i].pin);
    const char *verdict = pd && pu ? "pulled up by the module (connected, powered)"
                        : !pd && !pu ? "held LOW: short to GND?"
                        : "floating (unconnected, or a module input without pull-up)";
    Serial.printf("probe GPIO%-2d %-3s pd=%d pu=%d: %s\n", lines[i].pin, lines[i].name, pd, pu, verdict);
  }
  Serial.println("probe done");
}

void setup() {
  Serial.begin(115200);
  delay(1500);  // let a monitor attach before the probe prints
  probeWiring();
  rgbLedWrite(48, 6, 6, 6);  // GPIO48 is free on the bench (OLED CS on GPIO3): keep the LED dim
  for (int r = 0; r < MATRIX_ROWS; r++) pinMode(MATRIX_ROW_PINS[r], INPUT);
  for (int c = 0; c < MATRIX_COLS; c++) pinMode(MATRIX_COL_PINS[c], INPUT_PULLUP);
  pinMode(PIN_BOOT, INPUT_PULLUP);

  SPI.begin(PIN_OLED_SCK, -1, PIN_OLED_MOSI, -1);
  oled.setBusClock(1000000);  // 8 MHz gave a black screen over bench jumpers; 1 MHz works (mp_oled_diag)
  oled.begin();
  testPattern();
  draw(millis());
  Serial.println("mp_oled_test ready");
  benchNetBegin("keybordy-mp", true);
}

void loop() {
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
        if (slot < 0 || slot >= KEY_COUNT) continue;
        Serial.printf("key %d %s (R%d C%d)\n", slot + 1, down ? "down" : "up", r, c);
        if (down) { char n[8]; snprintf(n, sizeof n, "K%d", slot + 1); click(slot, n, r, c); }
      }
    }
    digitalWrite(MATRIX_ROW_PINS[r], HIGH);
    pinMode(MATRIX_ROW_PINS[r], INPUT);
  }
  bool b = digitalRead(PIN_BOOT) == LOW;
  if (b != bootRaw) { bootRaw = b; bootChangedAt = now; }
  if (b != bootStable && now - bootChangedAt >= DEBOUNCE_MS) {
    bootStable = b;
    Serial.printf("boot %s\n", b ? "down" : "up");
    if (b) click(KEY_COUNT, "BOOT", -1, -1);
  }
  // Animate the pulse bar while it drains (~30 fps; a frame is ~8 ms at 1 MHz).
  static uint32_t lastFrame;
  if (now - pulseAt < PULSE_MS + 40 && now - lastFrame >= 33) { lastFrame = now; draw(now); }
  delay(1);
}
