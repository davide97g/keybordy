# Session record

Written 27 Sep 2026, after the bench was confirmed working.

## Board

The board on this Mac is a classic ESP32 DevKit.

| | |
|---|---|
| Chip | ESP32-D0WD-V3, revision v3.0 |
| USB bridge | Silicon Labs CP2102 |
| Port | `/dev/cu.usbserial-0001` |
| Flash | 4 MB, DIO, 80 MHz |
| MAC | `ESP32_BASE_MAC` in `.env` |

Full chip, flash, eFuse, and partition notes are in `docs/esp32-connection.md`. NVS and SPIFFS were not read.

Pin numbers printed on the DevKit are the ones that matter. On the usual 30-pin board, with the USB connector toward you:

- Left header, antenna end first: `3V3`, then later `25`, `26`, `27`, then a `GND`
- Right header: `VIN`, `GND`, `23`, `22`, `TX`, `RX`, `21`, then another `GND`

`VIN` is 5 V from USB. It stays empty. The OLED pull-ups sit on VCC, so 5 V on VCC would put 5 V on SDA and SCL.

Leave these pins empty: GPIO 0, 2, 12, 15 (boot straps) and GPIO 1, 3 (USB serial).

## Parts

**OLED.** 0.96 inch SSD1306, 128×64, I2C. Front silkscreen, left to right: `GND`, `VCC`, `SCL`, `SDA`. Back silk prints 8-bit addresses `0x78` and `0x7A`. The working 7-bit address is `0x3C`.

**Rotary.** Five-pin encoder with pull-ups already on the back (R1, R2, R3). Knob up, pins along the bottom, left to right: `CLK`, `DT`, `SW`, `+`, `GND`. `SW` is the knob push.

The DevKit has one `3V3` pin. OLED VCC and rotary `+` share it through a breadboard rail. Each module GND uses its own `GND` pin on the DevKit.

## Wiring that works

| Jumper | From | To |
|---|---|---|
| Red, split on the rail | ESP32 `3V3` | OLED `VCC` and rotary `+` |
| Black | ESP32 `GND` | OLED `GND` |
| Yellow | GPIO `22` | OLED `SCL` |
| Blue | GPIO `21` | OLED `SDA` |
| Green | GPIO `25` | Rotary `CLK` |
| Violet | GPIO `26` | Rotary `DT` |
| Orange | GPIO `27` | Rotary `SW` |
| Black | ESP32 `GND` | Rotary `GND` |

If a turn counts the wrong way, swap the wires on 25 and 26.

## Firmware

`firmware/rotary_oled/rotary_oled.ino`

- Big signed integer on the OLED. It can go negative. The type size shrinks when the number gets long.
- One detent is one step. The encoder emits four quadrature edges per detent; the sketch adds those up and then steps the count by 1.
- Pressing the knob pulls GPIO 27 low. After 25 ms it sets the count back to 0.
- Serial at 115200 prints `rotary ready` on boot, then the count whenever it changes.

Flash:

```sh
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/rotary_oled
arduino-cli upload -p /dev/cu.usbserial-0001 --fqbn esp32:esp32:esp32 firmware/rotary_oled
```

Libraries: Adafruit SSD1306 and Adafruit GFX, on ESP32 Arduino core 3.3.12. Board FQBN `esp32:esp32:esp32`.

## What was confirmed

1. OLED came up on I2C `0x3C` with SDA 21 and SCL 22.
2. Turning the knob moves the number both ways.
3. Pressing the knob returns the number to 0.

## Visual guide

`guide/` is a local page with the same wiring: a Three.js bench and a React Flow map. Jumper colors match. Select a wire in either view and the other view marks that net.

```sh
cd guide
npm install
npm run dev
```
