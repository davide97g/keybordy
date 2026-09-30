# keybordy

A small keyboard built on a classic ESP32 DevKit: eight MX-style switches wired with jumpers only, and a rotary encoder to add later.

- `firmware/keys8/`: current firmware. Reads 8 keys, acts as a Bluetooth LE keyboard named `keybordy` that presses F13–F20, and prints `key N down` / `key N up` on serial at 115200. Also holds the Wokwi `diagram.json`.
- `host/`: Mac side. Hammerspoon maps F13–F20 to actions and serves a keymap editor on http://localhost:7373 (`host/ui/`).
- `firmware/switches_oled/`, `firmware/rotary_oled/`: earlier sketches with the SSD1306 OLED.
- `sim/`: fully local simulator, a vendored fork of Velxio (AGPLv3) in Docker, with a local Postgres for saved projects. Run `just sim-fetch-qemu` once, then `just sim-up` and open http://localhost:3080/editor?project=keys8. See `sim/README.md`.
- `docs/`: board and bench notes.
- `guide/`: interactive wiring guide (Vite + React).

## Tooling

Tasks live in the root `justfile` (`just` lists them); tool versions are pinned in `mise.toml` (Bun, Node, Python, uv, just). Frontends use Bun (`bun.lock`), the simulator backend uses uv (`uv.lock`).

```
just install         # bun + uv dependencies
just dev             # simulator with backend hot reload + UI on http://localhost:5173
just test            # backend (incl. Postgres) + frontend tests
just fw-flash        # compile and flash keys8
```

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

## Actions on the Mac

No server to run and no USB needed once flashed: the board only needs power (USB charger or power bank). It pairs as a Bluetooth keyboard, and Hammerspoon turns each key into an action.

1. `just fw-flash`, then power the board anywhere in Bluetooth range.
2. System Settings > Bluetooth: connect `keybordy` (no PIN). The Mac reconnects on its own after that.
3. `just host-install`: installs Hammerspoon into `~/Applications` (no sudo), links `host/hammerspoon/keybordy.lua` into `~/.hammerspoon`, starts it.
4. `just keymap` (or the ⌨︎ menu-bar item > Open keymap editor) opens http://localhost:7373.

The keymap editor shows the eight caps with their current action, lets you pick an action per key and try it before saving: ▶ on a cap (or Test) simulates a press with the unsaved version, and Activity lists every press, real or simulated, with the command output or the error. Save (⌘S) writes `~/.config/keybordy/keymap.json`; hand edits to that file load live too. `host/keymap.default.json` seeds it on first run.

| Action | Does | |
|---|---|---|
| Open app | launch or focus an app (picker with icons) | |
| Terminal | new Ghostty window in a folder, typing a command such as `claude` | |
| Shell command | `zsh -lc` in the background, output in Activity | |
| Open URL | any URL or app scheme (`obsidian://`, `raycast://`) | |
| Shortcut | `shortcuts run <name>` from the Shortcuts app | |
| Key combo | send e.g. ⇧⌘4 to the frontmost app (recorder included) | Accessibility |
| Type text | type a snippet | Accessibility |
| Media key | play/pause, next, volume, brightness | Accessibility |

Hotkeys need no permission. The last three need Hammerspoon in System Settings > Privacy & Security > Accessibility; the editor's `accessibility off · allow` chip opens that prompt. The first Terminal action asks to let Hammerspoon control Ghostty.

The editor is served by Hammerspoon on loopback only. Because it can run shell commands, every API call needs the token embedded in its page, and requests with a foreign `Host` or `Origin` are refused.

## Flash

```
just fw-flash        # arduino-cli compile --upload -p /dev/cu.usbserial-0001 --fqbn esp32:esp32:esp32 firmware/keys8
just fw-monitor
```
