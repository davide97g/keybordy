# keybordy MP

The next keybordy: an ESP32-S3 macropad on a custom PCB that JLCPCB fabs and assembles, in a 3D-printed case. It has 22 MX keys in three sizes, three encoders, a white 2.42" OLED, a microphone for voice and a speaker for sounds, TTS and notifications. It runs on USB-C or a LiPo, over USB HID or BLE.

`layout/macropad.json` is the single source for the PCB build, the CAD, the firmware pin header and the host editor. `layout/pins.json` holds the GPIO map. After changing either, run `just mp-gen` then `just mp-lint`. `just mp-preview` renders a 3D concept from the layout.

## Shape

- **Keys:** 6u wide, three rows of 1u, then a bottom row of 1.5u / 1u / 2u / 1.5u. The 2u key is the talk bar and gets a Cherry PCB screw-in stabilizer.
- **Top zone:** the OLED on the left, three knobs at 17.4 mm pitch on the right.
- **Case:** 133.3 × 138.1 mm, 19 mm high at the front and 29 mm at the rear (4.1° typing angle). It fits the A1 bed in one piece.
- **Top deck:** prints face down on Textured PEI, so the top gets the plate texture.
- **Keycaps:** float 3 mm above the deck. Legends are the key number only (K1..K22, knobs E1..E3), so any keymap fits without reprinting; the OLED names a key's action on each press. The talk bar keeps its engraved mic glyph. Legends are clear laser waterslide decals (`just mp-stickers`, printed at a copy shop), set with Micro Set/Sol over a gloss base coat and sealed with a water-based matte top coat. Parts are in `docs/macropad-shopping.md`.
- **Colours:** Bambu PLA Basic. Black case and knobs, Jade White caps, Gray 1.5u mods, Bambu Green talk bar.

## Parts

Checked 2026-10-07. Re-check stock before ordering.

| Function | Part | LCSC |
|---|---|---|
| MCU | ESP32-S3-WROOM-1-N16R8 | C2913202 |
| OLED | Waveshare 2.42" SSD1309 128x64 white, SPI, GH1.25 cable onto a 1x7 header | — |
| Encoders ×3 | Bourns PEC11R-4220F-S0024, 24 detents, push, 6 mm D-shaft | C143797 |
| Mic | TDK ICS-43434 I2S, bottom port, behind a slide switch on its VDD | C5656610 |
| Amp | MAX98357AETE+T, from VBUS/VBAT | C910544 |
| Speaker | 8 Ω 2 W 20×30 cavity speaker, JST lead (thickness to verify) | — |
| Sockets ×22 | Kailh MX hotswap CPG151101S11-16 | C41430893 |
| Charger | TI BQ24075 (power path) | C15464 |
| Battery | LiPo 603450 1000 mAh (a 10 mm cell does not fit at the front height) | — |

Every SMD part goes on the bottom, the same side as the hotswap sockets, so JLCPCB Economic assembly works. Through-hole parts on top: the encoders, the OLED header and the slide switches.

## Pins

| Function | GPIO |
|---|---|
| Matrix rows R0..R4 | 4, 5, 6, 7, 15 |
| Matrix cols C0..C5 | 16, 17, 18, 8, 9, 10 |
| E1 A/B | 11, 12 |
| E2 A/B | 13, 14 |
| E3 A/B | 21, 47 |
| I2S BCLK / WS / mic SD / amp DIN | 38, 39, 40, 41 |
| Amp SD_MODE | 46 (strap: the amp's internal pull-down keeps it low at boot) |
| OLED SCK / MOSI / CS / DC | 42, 2, 48, 43 (RES on EN) |
| VBAT ADC | 1 (ADC1, because ADC2 is unavailable while Wi-Fi is on) |
| Charge status | 44 |
| Mic LED | 45 (strap: the LED to GND keeps it low at boot) |
| BOOT button | 0 |

That uses 30 of the 31 usable GPIOs, leaving GPIO3 free.

- Off-limits: 19/20 (USB), 26–32 (flash), 35–37 (octal PSRAM).
- The matrix is 5×6 COL2ROW. Row 4 holds the three encoder pushes.

## Plan

0. **Layout, pins, lint and preview.** Done.
1. **Bench prototype from breakout modules.** ESP-IDF firmware bring-up in this order: matrix, HID over USB and BLE, encoders, OLED, I2S loopback, Wi-Fi streaming, wake word, USB audio.
2. **Host.** keymap v2 (mod+F13..F20 gives 40 action codes), an editor driven by the layout, the `host/voice/` service (Whisper, intent, TTS, `/notify`).
3. **PCB.** Rev A generated: `pcb/macropad/build.py` (helpers in `pcb/kb.py`) places, routes with Freerouting and writes Gerbers plus a JLC BOM and CPL. `just mp-pcb`; see `pcb/macropad/README.md` for ordering, hand-soldered parts and the case changes it needs.
4. **CAD.** `cad/` in build123d (plate, case, deck, knobs, keycaps), fit tests first.
5. **Assembly and bring-up.** Write print lessons back to `~/personal/projects/bambulab`.
