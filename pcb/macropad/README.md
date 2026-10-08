# keybordy MP PCB, rev A

A 2-layer board, 126.3 × 131.06 mm, for the keybordy MP macropad (`docs/macropad.md`). It is generated from `layout/macropad.json` and `layout/pins.json` by `build.py`. The schematic is in that script too: `parts()` lists every footprint with its pads' nets.

```sh
just mp-pcb          # place, Freerouting (5–20 min), DRC, then fab files into pcb/macropad/fab/
just mp-pcb-fab      # DRC + fab files only, after editing the board by hand in KiCad
just mp-pcb-open     # open in KiCad 10
```

Routing uses Freerouting 1.9.0 (`~/.local/share/freerouting/freerouting-1.9.0.jar`, Java 21+). Version 2.5 oscillates on this board and leaves about 30 connections unrouted. 1.9 is not deterministic either: a run leaves 0 to about 7 connections, so `route` tries up to four times and keeps the best session. A few stubs round the 0.5 mm-pitch amp and charger pins are drawn by hand in `place()`. After routing, `pour` fills GND on both layers and adds stitching vias on a 4 mm grid, plus one in any pour fragment the grid missed. `fab` fails on any DRC error or unconnected item. Silkscreen warnings and one starved thermal (an encoder GND pin, which is also on a routed track) do not block it.

## What is on it

All SMD parts are on the bottom, the same side as the hotswap sockets, so JLCPCB assembles one side.

- ESP32-S3-WROOM-1-N16R8. The antenna is flush with the rear edge, with no copper over it or within 15 mm either side.
- USB-C (USB 2.0) with 5.1k CC pull-downs and USBLC6 ESD protection.
- BQ24075 power-path charger.
  - Input limit about 860 mA (RILIM 1.8k). Charge current about 490 mA (RISET 1.8k).
  - TS has a fixed 10k because the cell has no NTC. Safety timer at its default.
  - The PWR switch drives SYSOFF. Off disconnects the battery; USB still powers the board, but the BQ24075 does not charge while SYSOFF is high, so leave PWR on to charge.
- AP2112K 3.3 V LDO, fed from the charger's OUT.
- MAX98357A amp on OUT, next to the speaker pads. GPIO46 drives SD_MODE high, which selects the left channel.
- ICS-43434 mic. Its port is a hole through the board under the deck's mic hole.
  - The MIC switch feeds its VDD from 3V3, or grounds it.
  - 1k resistors on its WS and SCK limit the current into it while it is off and the amp is using the shared clocks.
- Reverse-mount red LED on GPIO45, shining up through its hole.
- 22 Kailh hotswap sockets with 1N4148W diodes (COL2ROW).
- 3 encoders. A/B have 10k pull-ups. Each push has a diode into matrix row 4.
- BOOT and RST buttons. They are on the bottom, so they are only reachable with the case open. Normal flashing over native USB needs neither.
- Battery voltage on GPIO1 through a 100k/100k divider. Charge status on GPIO44.

## Ordering at JLCPCB

1. Upload `fab/keybordy-mp-gerbers.zip`. The viewer should show 2 layers and 126.3 × 131.06 mm. Keep FR-4, 1.6 mm, 1 oz and HASL lead-free.
2. Turn on PCB Assembly and choose the **Bottom side**. If Economic will not take a bottom-side job, pick Standard.
3. Assembly quantity: 2 is the minimum. Upload `fab/keybordy-mp-bom.csv` and `fab/keybordy-mp-cpl.csv`.
4. In the placement preview, check every polarised part against its silkscreen dot or bar before paying. JLC's rotation offsets differ from KiCad's. Check:
   - U1 to U6, pin 1.
   - D1–D33, cathode bar toward the row net.
   - D30, the LED.
   - J1, the USB-C mouth at the rear edge.
   - J2, the battery connector. Its opening faces the battery.
5. Stock risks as of 2026-10-07:
   - ICS-43434 (C5656610): about 1.4k in stock.
   - The ESP32-S3 module shows 0 at LCSC but 28k in JLC's own assembly stock.
   - Every IC is an Extended part, so each one adds a loading fee.

The BOM leaves out the parts you solder yourself, listed below.

## Solder yourself

| Part | Where | Notes |
|---|---|---|
| 3 × encoder | top, E1–E3 | Bourns PEC11R-4220F-S0024 (LCSC C143797, only a few hundred in stock). The footprint's lug slots also take Alps EC11 encoders such as the Amazon bench ones. |
| OLED, 7 wires | top, J3 at the rear edge | Cut the dupont ends off the Waveshare GH1.25 cable and solder the wires straight in. Pad order is `3V3 GND DIN CLK CS DC RST`, as on the silk. A header does not fit under the plate (3.5 mm). |
| Speaker, 2 wires | top, J4 at the left edge, `+` marked | Cut the PH1.25 plug off. |
| 22 × MX switch | top | They plug into the sockets. No soldering. |
| 2u stabilizer | top, K21 | Cherry PCB screw-in. |
| LiPo | bottom, J2 (JST PH 2.0) | **Check the polarity against the `+` and `-` on the silk before you plug it in.** Amazon cells come wired both ways, and the charger has no reverse-polarity protection. |

## Changes the case needs

- PWR switch moved from x 30 to x 68 in the layout, to the right of the USB-C. At x 30 it collided with the ESP32 module, and it was inside the antenna keep-out. `cad/` reads the layout, so `just cad-build` moves the tray's rear-wall slot. A tray printed before this change has the slot in the wrong place.
- The USB-C mouth sits 0.5 mm past the PCB edge, against the inside of the 3 mm wall. A plug's overmold is about 12.4 × 6.5 mm, so the 10 × 4.2 wall cut-out lets the plug in only about 3.5 mm. To seat the plug fully, widen the cut-out or recess the wall around it.
- The slide-switch levers stick out about 0.85 mm past the PCB edge, which doesn't reach through a 3 mm wall. Thin the wall at the two switch slots, or print a small slider.

## Not verified

- This board is untested. Nothing on it has been through the bench prototype (phase 1) yet. The charger, amp and mic circuits follow their datasheets' typical application circuits.
- The netlist was checked against KiCad's symbol pinouts. There is no separate schematic, so KiCad's ERC never ran.
- The Waveshare OLED's pin order and the speaker plug's wiring come from the listings, not from the parts in hand.
