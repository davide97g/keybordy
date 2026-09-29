#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// DevKit silkscreen: SDA 21, SCL 22, CLK 25, DT 26, SW 27
static const int PIN_SDA = 21;
static const int PIN_SCL = 22;
static const int PIN_CLK = 25;
static const int PIN_DT = 26;
static const int PIN_SW = 27;

static const int SCREEN_W = 128;
static const int SCREEN_H = 64;
static const uint8_t OLED_ADDR = 0x3C;

Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);

// One detent on a KY-040 is four quadrature steps.
volatile int32_t value = 0;
volatile int8_t steps = 0;

void IRAM_ATTR onEncoder() {
  static const int8_t table[16] = {
      0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};
  static uint8_t prev = 0;
  prev = ((prev << 2) | ((digitalRead(PIN_CLK) << 1) | digitalRead(PIN_DT))) & 0x0F;
  steps += table[prev];
  if (steps >= 4) {
    value++;
    steps = 0;
  } else if (steps <= -4) {
    value--;
    steps = 0;
  }
}

void drawValue(int32_t n) {
  char buf[16];
  snprintf(buf, sizeof(buf), "%ld", (long)n);
  int len = strlen(buf);
  int size = 4;
  if (len > 5) {
    size = 2;
  } else if (len > 4) {
    size = 3;
  }
  int charW = 6 * size;
  int charH = 8 * size;
  int textW = len * charW;
  int x = (SCREEN_W - textW) / 2;
  if (x < 0) {
    x = 0;
  }
  int y = (SCREEN_H - charH) / 2;

  display.clearDisplay();
  display.setTextSize(size);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(x, y);
  display.print(buf);
  display.display();
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_CLK, INPUT_PULLUP);
  pinMode(PIN_DT, INPUT_PULLUP);
  pinMode(PIN_SW, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_CLK), onEncoder, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_DT), onEncoder, CHANGE);

  Wire.begin(PIN_SDA, PIN_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("oled begin failed");
  }
  display.cp437(true);
  drawValue(0);
  Serial.println("rotary ready");
}

void loop() {
  static int32_t shown = 0;
  static int stable = HIGH;
  static int lastRead = HIGH;
  static uint32_t lastChange = 0;

  int read = digitalRead(PIN_SW);
  if (read != lastRead) {
    lastChange = millis();
    lastRead = read;
  }
  if ((millis() - lastChange) > 25 && read != stable) {
    stable = read;
    if (stable == LOW) {
      noInterrupts();
      value = 0;
      steps = 0;
      interrupts();
    }
  }

  int32_t now;
  noInterrupts();
  now = value;
  interrupts();
  if (now != shown) {
    shown = now;
    drawValue(now);
    Serial.println(now);
  }
}
