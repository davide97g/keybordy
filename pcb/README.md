# keybordy PCB, rev A

A 2-layer carrier board, 111.5 × 72.6 mm. The ESP32 DevKit, the OLED and the rotary module plug into female headers. The eight MX switches go into Kailh hotswap sockets on the back. Every switch has a real GND through the ground pour, so no GPIO is used as a ground. That frees enough pins for the OLED and the rotary.

`build.py` generates the board (`keybordy.kicad_pcb`), with every coordinate written in the script. It needs no autorouter. `just pcb-build` regenerates the board, routes it, runs DRC and writes the fab files to `pcb/fab/` (gitignored). `just pcb-open` opens the board in KiCad 10, installed in `~/Applications/KiCad`. If you edit the board by hand in KiCad, `just pcb-build` overwrites those edits, so run `just pcb-fab` afterwards instead.

| File in `pcb/fab/` | Use |
|---|---|
| `keybordy-gerbers.zip` | upload this to the fab |
| `print-1to1-top.pdf` | print at 100 % to check the fit on paper |
| `render-top.png`, `render-bottom.png` | 3D previews |
| `drc.json` | DRC report: 0 violations, 0 unconnected |

## Pin map

This map differs from the jumper rig in `firmware/keys8`. The key pins are the eight usable pins on the DevKit row nearest the keys, so the tracks fan out without crossings.

| Part | Signal | GPIO (DevKit label) |
|---|---|---|
| K1 / K2 / K3 / K4 (top row) | leg A | 16 (RX2) / 18 / 21 / 23 |
| K5 / K6 / K7 / K8 (bottom row) | leg A | 4 / 17 (TX2) / 19 / 22 |
| all keys | leg B | GND |
| OLED | SDA / SCL | 33 / 32 |
| OLED | VCC / GND | 3V3 / GND |
| Rotary | CLK / DT / SW | 35 / 34 / 39 (VN) |
| Rotary | + / GND | 3V3 / GND |

Firmware for this board needs:

```cpp
static const int KEY_PINS[] = {16, 18, 21, 23, 4, 17, 19, 22};
// no GND_PINS: every switch is on the GND pour
Wire.begin(33, 32);                      // SDA, SCL
// rotary: CLK 35, DT 34, SW 39, pull-ups on the module
```

`keys8` as it is will not read the keys on this board, because its key pins are different.

## Before you order: check on paper

1. Print `pcb/fab/print-1to1-top.pdf` at 100 % ("actual size", not "fit to page"). Measure the board outline on paper. It must be 111.5 mm wide.
2. Lay the DevKit on the print chip up, with USB at the `USB` mark. Every DevKit pin must sit on a pad, and the DevKit's own labels must match the silkscreen labels: `VIN` over `VIN`, `3V3` over `3V3`. If they are mirrored, stop: the board is wrong for your DevKit.
3. Check that the rows are 25.4 mm apart (10 holes on perfboard). If yours are 22.86 mm, change `DEVKIT_ROW_SPACING` in `build.py` and run `just pcb-build`.
4. Check the pin order printed on the OLED (`GND VCC SCL SDA`) and on the rotary (`CLK DT SW + GND`) against the silkscreen.

## Ordering at JLCPCB

1. Open jlcpcb.com, go to "Order now" and upload `pcb/fab/keybordy-gerbers.zip`. The viewer should show 2 layers and 111.5 × 72.6 mm.
2. Keep the defaults: FR-4, 2 layers, 1.6 mm thick, 1 oz copper, HASL (lead-free costs a little more), quantity 5. Any colour works; green ships fastest.
3. Under "Mark on PCB", choose "Remove Mark" if you don't want JLC's order number printed on the silkscreen. It costs a little extra.
4. Leave PCB Assembly off. Every part is hand-soldered.
5. Pay and pick shipping. Tax for Italy/EU is charged at checkout (IOSS), so nothing is due on delivery.

PCBWay (pcbway.com) and Aisler (aisler.net, made in Germany, no customs) accept the same zip. Aisler can also take `keybordy.kicad_pcb` directly.

## Parts to buy

| Qty | Part |
|---|---|
| 8 (+2 spare) | Kailh MX hotswap socket (CPG151101S11) |
| 2 | female header 1×15, 2.54 mm, vertical (DevKit) |
| 1 | female header 1×4, 2.54 mm, vertical (OLED) |
| 1 | female header 1×5, 2.54 mm, right angle (rotary) |
| 5 | M2 screws + standoffs, optional, for a case or plate |

Without a plate, 3-pin switches sit loosely in hotswap sockets. A 3D-printed plate 5 mm above the PCB, the standard MX height, holds them. The M2 holes are there for it.

## Assembly order

1. Hotswap sockets on the back. Tin one pad, slide the socket in with tweezers, reflow the pad, then solder the other pad.
2. DevKit headers on the front. Plug both headers onto the DevKit first, then solder them with the DevKit in place, so the rows stay parallel and at the right spacing.
3. OLED header and rotary right-angle header, the same way, with the module plugged in.
4. Flash the PCB firmware, then plug the DevKit in.

## Credits

`keybordy.pretty/SW_MX_HS_CPG151101S11_1u.kicad_mod` comes from [marbastlib](https://github.com/ebastler/marbastlib) by ebastler and is licensed CERN-OHL-P v2. Every other footprint ships with KiCad.
