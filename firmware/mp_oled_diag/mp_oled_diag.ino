// keybordy MP bench: black-screen diagnostic for the OLED. Cycles through four controller drivers
// at a slow 1 MHz SPI clock. Each one lights every pixel and writes its name for 3 s, and prints
// `try N <driver>` at 115200. Whichever try lights the panel names the driver to use. If none does,
// the fault is CS (bench: GPIO3), RES (on RST/EN) or the module's interface jumpers (4-wire SPI).
// Wiring: docs/macropad-bench.md (bench DC on GPIO1).

#include <SPI.h>
#include <U8g2lib.h>
#include "board_pins.h"
#include <KeybordyBench.h>  // Wi-Fi + OTA: `just mp-ota mp_oled_diag`

static const uint8_t OLED_DC = 1;
// Bench: CS on GPIO3 (the PCB's is GPIO48, the DevKit's WS2812 data line). With CS on a GPIO the
// panel resyncs its byte framing on every transfer; tied to GND, one stray CLK edge (a reset, a pin
// test) left the screen black until the next power cycle.
static const uint8_t OLED_CS = 3;

U8G2_SSD1309_128X64_NONAME2_F_4W_HW_SPI d0(U8G2_R0, OLED_CS, OLED_DC, U8X8_PIN_NONE);
U8G2_SSD1309_128X64_NONAME0_F_4W_HW_SPI d1(U8G2_R0, OLED_CS, OLED_DC, U8X8_PIN_NONE);
U8G2_SSD1306_128X64_NONAME_F_4W_HW_SPI d2(U8G2_R0, OLED_CS, OLED_DC, U8X8_PIN_NONE);
U8G2_SH1106_128X64_NONAME_F_4W_HW_SPI d3(U8G2_R0, OLED_CS, OLED_DC, U8X8_PIN_NONE);
static U8G2 *const drivers[] = {&d0, &d1, &d2, &d3};
static const char *const names[] = {"SSD1309 NONAME2", "SSD1309 NONAME0", "SSD1306", "SH1106"};

void setup() {
  Serial.begin(115200);
  rgbLedWrite(48, 6, 6, 6);
  SPI.begin(PIN_OLED_SCK, -1, PIN_OLED_MOSI, -1);
  delay(1000);
  Serial.println("mp_oled_diag ready");
  benchNetBegin("keybordy-mp", true);
}

void loop() {
  for (int i = 0; i < 4; i++) {
    U8G2 *d = drivers[i];
    d->setBusClock(1000000);
    d->begin();
    d->setPowerSave(0);
    d->setContrast(255);
    d->clearBuffer();
    d->drawBox(0, 0, 128, 64);
    d->setDrawColor(0);
    d->setFont(u8g2_font_6x10_tr);
    d->drawStr(8, 28, "TRY");
    d->drawStr(8, 42, names[i]);
    d->setDrawColor(1);
    d->sendBuffer();
    Serial.printf("try %d %s\n", i + 1, names[i]);
    delay(3000);
  }
}
