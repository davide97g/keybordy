# keybordy MP: bench wiring

Phase 1 of `docs/macropad.md`: the MP electronics from breakout modules on breadboards, on the same GPIOs as the PCB (`layout/pins.json`), so bench firmware runs unchanged on the board later.

Board: diymore ESP32-S3 DevKitC-1 N16R8. It has two USB-C ports: **USB** (native, GPIO19/20) and **COM** (UART bridge). Use **USB**. The bench firmware logs over USB CDC, which keeps GPIO43/44 free for the OLED and the charge status. Flash with `just mp-flash` (default `firmware/mp_bench`) and read with `just mp-monitor`. If the upload can't connect, hold BOOT, tap RST, release BOOT, and flash again.

Pin positions below follow Espressif's DevKitC-1 header order. Always go by the GPIO number printed on the silkscreen, not by position.

## Breadboards

The DevKitC-1 is too wide for one breadboard with free holes on both sides. Use two 830 boards side by side, not clipped together. Take off the power rails between them, and slide them apart until the left header drops into the right-most column of board A and the right header into the left-most column of board B. Each pin then has 4 free holes in its strip, facing outward. Stick or tape both boards down.

## Matrix (phase 1a)

The 5×6 COL2ROW matrix: columns are `INPUT_PULLUP`, rows are driven LOW one at a time. On the bench, every switch has two female Dupont jumpers: one to its **column**, one to its **row**. Rows 0–3 hold the keys. Row 4 (GPIO15) holds the encoder pushes, which come later.

Put the DevKit's 3V3 (J1 pin 1) in row 9 of the left board, so the header fills rows 9–30. Then every left-header pin has holes f, g, h, i free in its board row, and the row numbers below match. Column GPIOs need at most 4 switch wires each, so those jumpers go straight into the free holes. Rows need up to 6, so each row GPIO gets a short jumper across the centre channel, from hole f to hole e of its board row. That joins the empty a–e half, giving 7 free holes per row bus (g, h, i, a, b, c, d).

Interactive 3D version with every jumper and hole: https://claude.ai/artifact/LKNcLyDCJhvHCnFxTo2muF

| Bus | GPIO | J1 pin | Board row |
|---|---|---|---|
| R0 | 4 | 4 | 12 |
| R1 | 5 | 5 | 13 |
| R2 | 6 | 6 | 14 |
| R3 | 7 | 7 | 15 |
| C0 | 16 | 9 | 17 |
| C1 | 17 | 10 | 18 |
| C2 | 18 | 11 | 19 |
| C3 | 8 | 12 | 20 |
| C4 | 9 | 15 | 23 |
| C5 | 10 | 16 | 24 |

| Key | Row | Col | | Key | Row | Col |
|---|---|---|---|---|---|---|
| K1 | R0 (4) | C0 (16) | | K12 | R1 (5) | C5 (10) |
| K2 | R0 (4) | C1 (17) | | K13 | R2 (6) | C0 (16) |
| K3 | R0 (4) | C2 (18) | | K14 | R2 (6) | C1 (17) |
| K4 | R0 (4) | C3 (8) | | K15 | R2 (6) | C2 (18) |
| K5 | R0 (4) | C4 (9) | | K16 | R2 (6) | C3 (8) |
| K6 | R0 (4) | C5 (10) | | K17 | R2 (6) | C4 (9) |
| K7 | R1 (5) | C0 (16) | | K18 | R2 (6) | C5 (10) |
| K8 | R1 (5) | C1 (17) | | K19 (1.5u) | R3 (7) | C0 (16) |
| K9 | R1 (5) | C2 (18) | | K20 | R3 (7) | C2 (18) |
| K10 | R1 (5) | C3 (8) | | K21 (2u talk bar) | R3 (7) | C3 (8) |
| K11 | R1 (5) | C4 (9) | | K22 (1.5u) | R3 (7) | C5 (10) |

Columns C0 (row 17) and C2 (row 19) also get an f→e bridge, because their encoder pushes need a fifth hole. With it, K19 and K20 go in hole d of their column row.

Wires per column: C0 4, C1 3, C2 4, C3 4, C4 3, C5 4. Per row: 6, 6, 6, 4. In total, 44 leads and 6 short bridges. Female Dupont sockets do not fit MX pins, which are flat blades. Cut male-male jumpers in half, wrap 5–6 turns of the stripped end around the pin, pinch, and tape. Four keys (K1, K2, K7, K8) are enough for firmware bring-up.

`mp_bench` prints `key N down (Rr Cc)`. If the row or column in that line doesn't match the table, the switch is on the wrong bus. `empty slot` means a switch landed on R3 C1 or R3 C4, which have no key.

**Diodes.** The PCB has a 1N4148W per key: anode on the column side, cathode (the band) on the row. Without diodes on the bench, one or two keys at a time read correctly, but three keys held in an L shape (for example K1, K2, K7) show a phantom fourth (K8). When the 1N4148s arrive, put one in each switch's row wire, with the band toward the row bus.

## Firmware from the OLED on

`firmware/mp_proto` runs everything: the matrix and the encoders on core 0, and the OLED and I2S audio on core 1. Flash with `just mp-flash mp_proto` on the **USB** port, or from the simulator editor on the COM port. The bench's OLED DC is on GPIO1, which leaves UART0 free. It prints `key`/`enc` lines like mp_bench, plus `mic L … R … dBFS` every 2 s. Keys beep, holding K21 records up to 4 s and releasing plays it back, and E1 sets the volume.

Hole letters below: on the left board (A), a GPIO's free holes are f–i. On the right board (B), they are b–e.

## OLED (Waveshare 2.42", SSD1309, 4-wire SPI)

| OLED | Net | Hole |
|---|---|---|
| VCC | 3V3 | A row 9, i |
| GND | GND | B row 9, b |
| DIN | GPIO2 | B row 13, b |
| CLK | GPIO42 | B row 14, b |
| CS | **GPIO3** (bench) | A row 21, i |
| DC | **GPIO1** (bench) | B row 12, b |
| RES | RST / EN | A row 11, i |

DC is on GPIO1 on the bench, not the PCB's GPIO43 (UART0 TX). That keeps the COM port, and with it the simulator editor's builds, working. GPIO1 is the PCB's battery sense, and there is no battery on the bench. `firmware/mp_oled_test` checks the wiring at boot (CLK and DIN pulled up by a powered module, no shorts) and then counts clicks on BOOT and on the keys.

Two bench gotchas, both found the hard way:

- **CS needs its own GPIO.** The first bench wiring tied CS to GND, so the panel counted every clock edge. One stray edge, from a pin test or a reset, shifted its byte framing until the next power cycle, and every later command arrived garbled: a black screen with correct wiring. With CS on GPIO3, the panel resyncs on every transfer.
- **SPI runs at 1 MHz** over the jumpers. A full frame then takes about 8 ms.

The panel crops a few edge pixels, so the UI keeps a 2 px margin (`INSET`). `mp_oled_diag` cycles four controller drivers if the screen is ever black again. All four light this module, and the firmware uses SSD1309 NONAME2.

CS is on GPIO3 on the bench, not the PCB's GPIO48, because the DevKit's WS2812 data line is on GPIO48. Chip-select pulses would drive the LED at full brightness. If the image is shifted by 2 px, change `NONAME2` to `NONAME0` in mp_proto.

## Microphone (INMP441) and amp (MAX98357A)

Both modules need their headers soldered. Seat them in right-board column h: the mic in rows 40–45, the amp in rows 50–56. Run jumpers from hole f of each module row. The pin order varies by module, so follow the labels.

| Mic | Net | Hole | | Amp | Net | Hole |
|---|---|---|---|---|---|---|
| SCK | GPIO38 BCLK | B row 18, b | | BCLK | GPIO38 | B row 18, c |
| WS | GPIO39 | B row 17, b | | LRC | GPIO39 | B row 17, c |
| SD | GPIO40 | B row 16, b | | DIN | GPIO41 | B row 15, b |
| L/R | GND | B row 29, b | | SD | GPIO46 | A row 22, i |
| VDD | 3V3 | A row 9, h | | VIN | 5V | A row 29, i |
| GND | GND | B row 29, c | | GND | GND | B row 30, b |

Leave the amp's GAIN pin unconnected (9 dB). Cut the speaker's PH1.25 plug off and screw the wires into the amp terminal. If the RGB LED flickers once audio runs, this clone has it on GPIO38 rather than 48.

## Encoders (EC11, when they arrive)

| Encoder | A | B | C | Push leg 1 | Push leg 2 |
|---|---|---|---|---|---|
| E1 | GPIO11, A row 25 i | GPIO12, A row 26 i | GND, A row 30 i | R4 GPIO15, A row 16 i | C0, A row 17 c |
| E2 | GPIO13, A row 27 i | GPIO14, A row 28 i | GND, A row 30 h | A row 16 h | C1, A row 18 f |
| E3 | GPIO21, B row 26 b | GPIO47, B row 25 b | GND, A row 30 g | A row 16 g | C2, A row 19 c |

Internal pull-ups on the bench (the PCB has 10k). Swap A and B if the direction is reversed.

## Diodes (when they arrive)

Put one 1N4148 inline in each row lead. Wrap the anode around the switch's right pin and the row lead around the cathode, so the band faces the row. Then three keys held in an L no longer show a phantom fourth.

## Audio findings (2026-10-09)

Measured on the bench, not guessed. To redo them: `python3 firmware/mp_audio_tune/tune.py <port>` with `mp_audio_tune` flashed. The raw data of the last run is in `firmware/mp_speaker_stream/tune-last.json`.

- **Mic (INMP441) works:** left I2S slot, L/R on GND. Room speech reads about −25 to −40 dBFS and a quiet room about −42 to −49 dBFS (broadband RMS). The DC offset is up to −2650 counts at 16 bit. 32 kHz full duplex with the amp works on one I2S port. Over the COM port at 2 Mbaud, 30 s streamed to the Mac with 0 of 1,875 packets dropped (`mp_mic_stream` + `record.py`).
- **Speaker crackle is supply sag, not data:**
  - Streaming from the Mac (`mp_speaker_stream` + `play.py`) keeps real time with every packet acked.
  - A 1 kHz tone is clean at −30 and −20 dBFS. By ear it crackles from −16 dBFS.
  - The self-test (`mp_audio_tune`) plays a sweep and records it with the board's own mic. It found the mic reading linear up to −16 dBFS (gain −11.7 dB, steady). At −14 dBFS the reading drops 8 dB, the crest factor jumps from 5–7 to 12 dB (crackle) and the 2nd harmonic rises from −40 to −21 dB.
  - The cause is the amp's 5 V arriving through USB, the DevKit's 5V pin and long jumpers, with no bulk capacitor at the amp.
- **Bench speaker level:** peak −20 dBFS, which is the last clean step (−16) minus a 4 dB margin, because the ear hears crackle about one step before the mic sees compression. It is saved in `firmware/mp_speaker_stream/tuned.json`, and `play.py` uses it by default.
- **Louder on the bench:** add 100–470 µF across the amp's VIN and GND, right at the module (rows 56 and 55, + to VIN), use short power wires, then tune again.
- **Live monitoring through the Mac speakers feeds back.** The first live take howled at +12 dB. `record.py --live` now plays at 0 dB with a guard that mutes for 1 s and halves the gain after about 0.2 s of sustained loud output. Headphones avoid the loop entirely.
- **PCB note (not changed):** the amp on rev A has 10 µF + 100 nF on VSYS (C11, C12). That is better than the breadboard but thin for 3 W bursts. Consider 47–100 µF there.
- **Average power resets USB, too.** In the voice loop (`firmware/mp_voice`), compressed speech (drive 1.5, peak −18 dBFS) drew enough steady amp current to sag USB 5 V until the CH343 reset. The Mac lost the COM port mid-reply while the board stayed powered, and the OLED sat on "SENT". The defaults are now peak −19 dBFS and drive 1.0. The firmware shows NO MAC after 45 s without an answer, and `voice_loop.py` waits for the port and reconnects.
