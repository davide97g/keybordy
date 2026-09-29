#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// DevKit silkscreen: SDA 21, SCL 22, keys 32 / 33 / 14.
// Each switch: one metal pin to its GPIO, the other to a shared GND line.
static const int PIN_SDA = 21;
static const int PIN_SCL = 22;
static const int KEY_PINS[] = {32, 33, 14};
static const int KEY_COUNT = sizeof(KEY_PINS) / sizeof(KEY_PINS[0]);

static const int SCREEN_W = 128;
static const int SCREEN_H = 64;
static const uint8_t OLED_ADDR = 0x3C;

// Blue switches bounce for a few ms on both press and release.
static const uint32_t DEBOUNCE_MS = 15;

Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);

struct Key {
  int stable;
  int lastRead;
  uint32_t lastChange;
};

Key keys[KEY_COUNT];
int lastPressed = -1;
uint32_t presses = 0;

void drawScreen() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print("last key");
  char count[12];
  snprintf(count, sizeof(count), "%lu", (unsigned long)presses);
  display.setCursor(SCREEN_W - strlen(count) * 6, 0);
  display.print(count);

  // Big digit of the last key pressed, or a dash before the first press.
  const int size = 4;
  char big = lastPressed < 0 ? '-' : '1' + lastPressed;
  display.setTextSize(size);
  display.setCursor((SCREEN_W - 6 * size) / 2, 14);
  display.print(big);

  // Bottom row: one box per key, filled while that key is held.
  const int boxW = 30;
  const int boxH = 14;
  const int gap = (SCREEN_W - KEY_COUNT * boxW) / (KEY_COUNT + 1);
  const int y = SCREEN_H - boxH;
  display.setTextSize(1);
  for (int i = 0; i < KEY_COUNT; i++) {
    int x = gap + i * (boxW + gap);
    bool held = keys[i].stable == LOW;
    if (held) {
      display.fillRect(x, y, boxW, boxH, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
    } else {
      display.drawRect(x, y, boxW, boxH, SSD1306_WHITE);
      display.setTextColor(SSD1306_WHITE);
    }
    display.setCursor(x + (boxW - 6) / 2, y + (boxH - 8) / 2);
    display.print(i + 1);
  }

  display.display();
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < KEY_COUNT; i++) {
    pinMode(KEY_PINS[i], INPUT_PULLUP);
    keys[i] = {HIGH, HIGH, 0};
  }

  Wire.begin(PIN_SDA, PIN_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("oled begin failed");
  }
  display.cp437(true);
  drawScreen();
  Serial.println("switches ready");
}

void loop() {
  bool dirty = false;
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
      dirty = true;
      if (k.stable == LOW) {
        lastPressed = i;
        presses++;
        Serial.printf("key %d down\n", i + 1);
      } else {
        Serial.printf("key %d up\n", i + 1);
      }
    }
  }

  if (dirty) {
    drawScreen();
  }
}
