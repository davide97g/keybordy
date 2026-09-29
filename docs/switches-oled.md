# Three switches and the OLED

Written 28 Sep 2026. The firmware is flashed and verified on the board. The switches were not yet wired when this was written, so a key press has not been seen on the screen.

Goal: press switch 1, 2, or 3 and see that number on the OLED.

## Parts

**Switches.** BTFO mechanical keyboard switches, blue (clicky), 3-pin, 50-pack ([Amazon B0GHNDQV4Q](https://www.amazon.it/dp/B0GHNDQV4Q)). No PCB or hot-swap sockets come with them.

A 3-pin MX-style switch has two metal pins and one plastic post. The plastic post only locates the switch on a PCB. The two metal pins form a normally open contact: pressing the key connects them. Either metal pin can go to either side.

**OLED.** The same SSD1306 128×64 I2C module as before, at address `0x3C`. See `docs/session.md`.

**Rotary encoder.** Stays wired on GPIO 25, 26, and 27. The switches do not need its pins.

**Breadboard.** Full size: 60 rows, columns A–J, and a pair of power rails down each long edge. The red and blue lines on the rails stop around row 30, which usually means the rail is cut there. The top half and the bottom half of a rail are then not connected.

## Pins

| Part | Pin | DevKit |
|---|---|---|
| Switch 1 | metal pin A | GPIO32 |
| Switch 2 | metal pin A | GPIO33 |
| Switch 3 | metal pin A | GPIO14 |
| Switches 1–3 | metal pin B | GND, through the breadboard rail |
| OLED | `SDA` | GPIO21 |
| OLED | `SCL` | GPIO22 |
| OLED | `VCC` | `3V3`, through the breadboard rail |
| OLED | `GND` | GND, through the breadboard rail |

GPIO32, 33, and 14 have internal pull-ups and are not boot straps. GPIO 34–39 were avoided because they are input-only with no pull-up.

No resistors are needed. The firmware enables the internal pull-up, so a pin reads HIGH at rest and LOW while its switch is pressed.

The OLED pin order on the silkscreen differs between modules. Wire by the printed labels. `SCK` means SCL and `VDD` means VCC. If SDA and SCL are swapped nothing breaks, but the screen stays black.

VCC must come from `3V3`, not `VIN`. `VIN` is 5 V from USB and would put 5 V on SDA and SCL.

## Ground and 3V3 on the breadboard

The DevKit has only two GND pins, but every part needs ground. The breadboard rail fixes that: every hole in one rail is connected, so one wire from the DevKit turns the whole rail into GND.

The DevKit stays off the breadboard. Plugged in, it would cover almost every hole. The breadboard is only a hub for GND and 3V3.

Use the left edge, top half (rows 30–60):

1. DevKit `GND` to the blue (−) rail.
2. DevKit `3V3` to the red (+) rail.
3. OLED `GND` and rotary `GND` into the blue rail. OLED `VCC` and rotary `+` into the red rail.
4. Pin B of each switch into the blue rail.
5. Pin A of each switch straight to its GPIO on the DevKit.
6. OLED `SDA` and `SCL` straight to GPIO21 and GPIO22 on the DevKit.

```
DevKit GND ──► blue rail ◄── OLED GND, ROT GND, SW1 B, SW2 B, SW3 B
DevKit 3V3 ──► red rail  ◄── OLED VCC, ROT +
GPIO32 ── SW1 A     GPIO33 ── SW2 A     GPIO14 ── SW3 A
GPIO21 ── OLED SDA  GPIO22 ── OLED SCL
```

Keep all rail wires in one half of the rail, or bridge the cut at row 30 with a short jumper.

## Jumpers

The DevKit, switch, and OLED pins are all male, so every wire needs a female end. Switch pins do not sit well in breadboard holes, so they get a female Dupont end pushed onto the pin.

| From | To | Jumper | Count |
|---|---|---|---|
| DevKit GND, DevKit 3V3 | rails | female-to-male | 2 |
| OLED GND, OLED VCC | rails | female-to-male | 2 |
| Rotary GND, rotary `+` | rails | female-to-male | 2 |
| Switch pin B | blue rail | female-to-male | 3 |
| Switch pin A | DevKit GPIO | female-to-female | 3 |
| OLED SDA, SCL | DevKit GPIO | female-to-female | 2 (already wired) |

Rotary CLK, DT, and SW stay wired straight to GPIO 25, 26, and 27.

## Firmware

`firmware/switches_oled/switches_oled.ino`. The pins are set on line 9: `KEY_PINS[] = {32, 33, 14}`.

Screen layout:

- Top left: `last key`. Top right: total press count.
- Middle: a large `1`, `2`, or `3` for the last key pressed, or `-` before the first press.
- Bottom: one box per key. A box fills while its key is held.

Serial at 115200 prints `switches ready` at boot, then `key N down` and `key N up`.

Each key is debounced for 15 ms, because blue switches bounce on both press and release.

Build: 307044 bytes of program storage (23%) and 23708 bytes of RAM (7%).

Flash:

```
arduino-cli compile --upload -p /dev/cu.usbserial-0001 --fqbn esp32:esp32:esp32 firmware/switches_oled
```

Check that the board runs this build. Compile into a folder, then compare against flash at the app offset:

```
arduino-cli compile --fqbn esp32:esp32:esp32 --output-dir build firmware/switches_oled
~/Library/Arduino15/packages/esp32/tools/esptool_py/5.3.1/esptool --chip esp32 -p /dev/cu.usbserial-0001 verify_flash 0x10000 build/switches_oled.ino.bin
```

On 28 Sep 2026 this printed `Verification successful (digest matched)`.

Watch key presses:

```
arduino-cli monitor -p /dev/cu.usbserial-0001 -c baudrate=115200
```

Flashing this sketch replaces `firmware/rotary_oled`. Flash that sketch again to go back to the encoder counter.

## Troubleshooting

| Symptom | Check |
|---|---|
| Screen blank | OLED wiring. SDA and SCL swapped, or VCC not on 3V3. |
| Screen fine, one key does nothing | That key's two wires: pin A on its GPIO, pin B in the blue rail. |
| Screen fine, no key works | DevKit GND wire into the blue rail, and the cut at row 30. |
| OLED module has 6–7 pins | It is the SPI version. This wiring does not apply. |
