// No breadboard: every board pin takes exactly one jumper, so the switches
// cannot share one GND line. Each switch gets two pins of its own:
//   leg A -> KEY_PINS[i]  (input, internal pull-up)
//   leg B -> GND_PINS[i]  (a real GND pin, or a GPIO held LOW as a ground)
// Rotary encoder, added later: CLK 34, DT 35, SW 39 (input-only pins, the
// module's own pull-ups hold them high), + to 3V3, GND to the second GND pin.
static const int KEY_PINS[] = {32, 33, 14, 13, 4, 18, 19, 23};
static const int GND_PINS[] = {-1, 25, 26, 27, 16, 17, 21, 22};  // -1: K1 uses a real GND pin
static const int KEY_COUNT = sizeof(KEY_PINS) / sizeof(KEY_PINS[0]);

// Blue switches bounce for a few ms on both press and release.
static const uint32_t DEBOUNCE_MS = 15;

struct Key {
  int stable;
  int lastRead;
  uint32_t lastChange;
};

Key keys[KEY_COUNT];

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < KEY_COUNT; i++) {
    if (GND_PINS[i] >= 0) {
      pinMode(GND_PINS[i], OUTPUT);
      digitalWrite(GND_PINS[i], LOW);
    }
    pinMode(KEY_PINS[i], INPUT_PULLUP);
    keys[i] = {HIGH, HIGH, 0};
  }
  Serial.println("keys8 ready");
}

void loop() {
  uint32_t now = millis();

  for (int i = 0; i < KEY_COUNT; i++) {
    Key &k = keys[i];
    int read = digitalRead(KEY_PINS[i]);
    if (read != k.lastRead) {
      k.lastChange = now;
      k.lastRead = read;
    }
    if ((now - k.lastChange) > DEBOUNCE_MS && read != k.stable) {
      k.stable = read;
      Serial.printf("key %d %s\n", i + 1, k.stable == LOW ? "down" : "up");
    }
  }
}
