// keybordy MP matrix test: the PCB's 5x6 COL2ROW matrix (1N4148W per key, anode on the column
// side, cathode on the row) and three encoders, on the real MP pins from board_pins.h (a copy of
// firmware/macropad/main/board_pins.h, generated from layout/). Prints `key N down/up`,
// `enc E1 push/release` and `enc E1 cw/ccw` at 115200.
//
// Rows are driven LOW one at a time; the idle rows float (INPUT), so a held key on another row
// cannot pull a column low through its diode. Columns are INPUT_PULLUP (the PCB has no external
// column pull-ups). The settle time is long because in the simulator every row edge goes through
// the browser's circuit solve and back; on hardware a few microseconds are enough.

#include "board_pins.h"

static const uint32_t SETTLE_MS = 50;
static const uint32_t DEBOUNCE_MS = 15;

static bool stable[MATRIX_ROWS][MATRIX_COLS];
static bool raw[MATRIX_ROWS][MATRIX_COLS];
static uint32_t changedAt[MATRIX_ROWS][MATRIX_COLS];

static volatile int32_t encSteps[ENCODER_COUNT];

// One detent: A rises once per detent and B's level then gives the direction. Polled on core 0,
// because the simulator's S3 machine never raises a GPIO interrupt for an injected input level
// (attachInterrupt counted 0 edges). Hardware firmware should use a full quadrature state machine.
static void encPoll(void *) {
  bool lastA[ENCODER_COUNT] = {};
  for (;;) {
    for (int e = 0; e < ENCODER_COUNT; e++) {
      bool a = digitalRead(ENCODER_PIN_A[e]);
      if (a && !lastA[e]) encSteps[e] += digitalRead(ENCODER_PIN_B[e]) ? -1 : 1;
      lastA[e] = a;
    }
    esp_rom_delay_us(50);
  }
}

static void report(int slot, bool down) {
  if (slot < KEY_COUNT) {
    Serial.printf("key %d %s\n", slot + 1, down ? "down" : "up");
  } else {
    Serial.printf("enc %s %s\n", ENCODER_IDS[slot - KEY_COUNT], down ? "push" : "release");
  }
}

void setup() {
  Serial.begin(115200);
  for (int r = 0; r < MATRIX_ROWS; r++) pinMode(MATRIX_ROW_PINS[r], INPUT);
  for (int c = 0; c < MATRIX_COLS; c++) pinMode(MATRIX_COL_PINS[c], INPUT_PULLUP);
  for (int e = 0; e < ENCODER_COUNT; e++) {
    // The PCB has 10k pull-ups on A/B (R42..R47), so no internal pull.
    pinMode(ENCODER_PIN_A[e], INPUT);
    pinMode(ENCODER_PIN_B[e], INPUT);
  }
  disableCore0WDT();
  xTaskCreatePinnedToCore(encPoll, "encPoll", 2048, nullptr, 1, nullptr, 0);
  delay(200);
  Serial.println("mp_matrix ready");
}

void loop() {
  uint32_t now = millis();
  for (int r = 0; r < MATRIX_ROWS; r++) {
    pinMode(MATRIX_ROW_PINS[r], OUTPUT);
    digitalWrite(MATRIX_ROW_PINS[r], LOW);
    delay(SETTLE_MS);
    for (int c = 0; c < MATRIX_COLS; c++) {
      if (MATRIX_SLOT[r][c] < 0) continue;
      bool down = digitalRead(MATRIX_COL_PINS[c]) == LOW;
      if (down != raw[r][c]) {
        raw[r][c] = down;
        changedAt[r][c] = now;
      }
      if (down != stable[r][c] && now - changedAt[r][c] >= DEBOUNCE_MS) {
        stable[r][c] = down;
        report(MATRIX_SLOT[r][c], down);
      }
    }
    pinMode(MATRIX_ROW_PINS[r], INPUT);
  }
  for (int e = 0; e < ENCODER_COUNT; e++) {
    noInterrupts();
    int32_t s = encSteps[e];
    encSteps[e] = 0;
    interrupts();
    for (; s > 0; s--) Serial.printf("enc %s cw\n", ENCODER_IDS[e]);
    for (; s < 0; s++) Serial.printf("enc %s ccw\n", ENCODER_IDS[e]);
  }
}
