// keybordy MP bench test on real hardware: the 5x6 COL2ROW matrix on the MP pins from board_pins.h
// (a copy of firmware/macropad/main/board_pins.h, generated from layout/). Prints
// `key N down (Rr Cc)` / `key N up (Rr Cc)` at 115200 over the native USB port (CDCOnBoot=cdc).
//
// Same scan as firmware/mp_matrix, minus the simulator tuning: one row LOW at a time, idle rows
// floating (INPUT), columns INPUT_PULLUP, 30 us to settle, so a full scan takes well
// under a millisecond. Works with or without the per-key diodes; without them, three keys held in
// an L shape show a phantom fourth. Encoders are not wired on the bench yet.
//
// A switch whose row/col in the printout does not match docs/macropad-bench.md is miswired.

#include "board_pins.h"

static const uint32_t SETTLE_US = 30;
static const uint32_t DEBOUNCE_MS = 15;

// The DevKit's WS2812 holds its last colour across a reset, and the factory demo leaves it
// blinking bright. Hold it steady at 10% of the core's RGB_BRIGHTNESS (64). Clones put it on
// GPIO48 or GPIO38 (Espressif v1.1), so write both; neither is used yet on the bench. Drop this
// once the OLED (CS on 48) and I2S (BCLK on 38) are wired.
static const uint8_t LED_LEVEL = 6;
static const uint8_t LED_PINS[] = {48, 38};

static bool stable[MATRIX_ROWS][MATRIX_COLS];
static bool raw[MATRIX_ROWS][MATRIX_COLS];
static uint32_t changedAt[MATRIX_ROWS][MATRIX_COLS];

void setup() {
  Serial.begin(115200);
  for (uint8_t p : LED_PINS) rgbLedWrite(p, LED_LEVEL, LED_LEVEL, LED_LEVEL);
  for (int r = 0; r < MATRIX_ROWS; r++) pinMode(MATRIX_ROW_PINS[r], INPUT);
  for (int c = 0; c < MATRIX_COLS; c++) pinMode(MATRIX_COL_PINS[c], INPUT_PULLUP);
  delay(1500);  // let the Mac open the CDC port before the first line
  Serial.println("mp_bench ready");
}

void loop() {
  uint32_t now = millis();
  for (int r = 0; r < MATRIX_ROWS; r++) {
    pinMode(MATRIX_ROW_PINS[r], OUTPUT);
    digitalWrite(MATRIX_ROW_PINS[r], LOW);
    delayMicroseconds(SETTLE_US);
    for (int c = 0; c < MATRIX_COLS; c++) {
      bool down = digitalRead(MATRIX_COL_PINS[c]) == LOW;
      if (down != raw[r][c]) {
        raw[r][c] = down;
        changedAt[r][c] = now;
      }
      if (down != stable[r][c] && now - changedAt[r][c] >= DEBOUNCE_MS) {
        stable[r][c] = down;
        int slot = MATRIX_SLOT[r][c];
        const char *edge = down ? "down" : "up";
        if (slot < 0) Serial.printf("empty slot %s (R%d C%d): check wiring\n", edge, r, c);
        else if (slot < KEY_COUNT) Serial.printf("key %d %s (R%d C%d)\n", slot + 1, edge, r, c);
        else Serial.printf("enc %s %s (R%d C%d)\n", ENCODER_IDS[slot - KEY_COUNT], down ? "push" : "release", r, c);
      }
    }
    // Pull the row back up before letting it float, so the columns read HIGH for the next row
    // instead of waiting on the internal pull-up to recharge the wires.
    digitalWrite(MATRIX_ROW_PINS[r], HIGH);
    pinMode(MATRIX_ROW_PINS[r], INPUT);
  }
  delay(1);
}
