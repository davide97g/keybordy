# keybordy

A small keyboard built on a classic ESP32 DevKit: eight MX-style switches wired with jumpers only, and a rotary encoder to add later.

- `firmware/keys8/`: current firmware. Reads 8 keys and prints `key N down` / `key N up` on serial at 115200. Also holds the Wokwi `diagram.json`.
- `firmware/switches_oled/`, `firmware/rotary_oled/`: earlier sketches with the SSD1306 OLED.
- `sim/`: fully local simulator, a vendored fork of Velxio (AGPLv3) in Docker. Run `sim/velxio/scripts/fetch-qemu.sh` once, then `docker compose -f sim/compose.yaml up -d --build` and open http://localhost:3080/editor?project=keys8. See `sim/README.md`.
- `docs/`: board and bench notes.
- `guide/`: interactive wiring guide (Vite + React).

## Wiring

No breadboard, so every board pin takes one jumper and each switch gets two pins: leg A to an input with the internal pull-up, leg B to ground. K1 uses a real `GND` pin. K2–K8 use GPIOs the firmware holds LOW.

| Key | Leg A | Leg B |
|---|---|---|
| K1 | GPIO32 | GND |
| K2 | GPIO33 | GPIO25 |
| K3 | GPIO14 | GPIO26 |
| K4 | GPIO13 | GPIO27 |
| K5 | GPIO4 | GPIO16 |
| K6 | GPIO18 | GPIO17 |
| K7 | GPIO19 | GPIO21 |
| K8 | GPIO23 | GPIO22 |
| Rotary (later) | CLK 34, DT 35, SW 39 | `+` to 3V3, GND to the second GND |

## Flash

```
arduino-cli compile --upload -p /dev/cu.usbserial-0001 --fqbn esp32:esp32:esp32 firmware/keys8
```
