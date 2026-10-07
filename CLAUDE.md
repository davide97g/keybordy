# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A hand-wired keyboard on a classic ESP32 DevKit: eight MX-style switches wired with jumpers only (no breadboard, no PCB, no solder), plus a rotary encoder to add later. The repo holds the Arduino firmware, a Wokwi circuit diagram, a fully local simulator (a vendored Velxio fork in Docker), bench notes in `docs/`, an interactive wiring guide in `guide/`, and the Mac side in `host/`: Hammerspoon turns the board's Bluetooth F13–F20 presses into actions and serves a keymap editor.

Firmware and wiring are verified with `sim/harness/simcheck.py` (see "Headless checks" below): a static lint of the diagram against the sketch, and a headless run in the simulator's QEMU that presses keys and asserts serial output. After any change to a sketch, `diagram.json` or the README pin table, run `just sim-check` and report its result. Flashing and reading serial stays the final check on real hardware. The vendored simulator has its own test suites (see below).

## Tooling

Tasks are in the root `justfile` (`just` lists them). `mise.toml` pins Bun, Node, Python 3.12, uv and just. JS projects use Bun as package manager and script runner with committed `bun.lock` files. Run frontend tests with `bun run test` (vitest), never `bun test`, which is Bun's own runner. The simulator backend uses uv (`pyproject.toml` + `uv.lock`); ruff is configured narrowly (pyflakes + syntax) so vendored code stays diffable against upstream.

## Hardware constraints

- Board: ESP32-D0WD-V3 (rev 3.0) on a 30-pin DevKit V1 with a CP2102 USB-UART bridge, 4 MB flash (DIO, 80 MHz). Serial port: `/dev/cu.usbserial-0001`. Only 2 `GND` pins and one `3V3`.
- Never use GPIO 0, 2, 5, 12, 15 (boot straps) or 1, 3 (USB serial). GPIO 34–39 are input-only with no internal pull-up.
- Jumpers only means one wire per board pin: nothing can be shared or split. So each switch uses two board pins. Leg A goes to `KEY_PINS[i]` (`INPUT_PULLUP`). Leg B goes to `GND_PINS[i]`, which is either a real `GND` (`-1`) or a GPIO the firmware drives LOW as a ground. K2–K8 only work while `keys8` is running.
- The rotary (later) goes on 34/35/39. It relies on the module's own pull-ups, so its `+` must go to `3V3`, never `VIN`, which is 5 V.
- Every usable GPIO is taken. There is no room for the OLED unless a breadboard or a soldered ground line frees the GPIO grounds.

The pin map is duplicated in `firmware/keys8/keys8.ino` (`KEY_PINS`/`GND_PINS`), `firmware/keys8/diagram.json`, and the table in `README.md`. Change all three together.

## Firmware

Sketches live in `firmware/<name>/<name>.ino`. The FQBN is `esp32:esp32:esp32`.

- `keys8`: the current 8-key firmware. It debounces for 15 ms and prints `keys8 ready`, then `key N down` / `key N up`, at 115200. It is also a BLE HID keyboard named `keybordy` (core `BLE` library, Bluedroid, "Just Works" bonding): K1..K8 send F13..F20 (usages 0x68..0x6F, so the report map's usage range goes to 0xE7). It prints `ble advertising` / `ble connected` / `ble disconnected`. QEMU has no radio and `BLEDevice::init` stalls the whole chip there, so the sketch skips BLE when the eFuse MAC is QEMU's default `10:01:00:c4:0a:24` and prints `ble off in simulator`. The app is about 1.1 MB of the 1.25 MB default partition; switch to `PartitionScheme=huge_app` if it outgrows it.
- `switches_oled`, `rotary_oled`: earlier OLED demos on the old breadboard wiring (OLED I2C on 21/22 at `0x3C`, rotary on 25/26/27). They need the Adafruit SSD1306 and Adafruit GFX libraries. Their pins now clash with the `keys8` GPIO grounds.

```sh
just fw-build [name]     # arduino-cli compile --fqbn esp32:esp32:esp32 firmware/keys8
just fw-flash [name]     # compile --upload -p /dev/cu.usbserial-0001 (override with ESP32_PORT)
just fw-bin [name]       # --output-dir firmware/<name>/build, binaries for wokwi.toml
just fw-monitor          # arduino-cli monitor -c baudrate=115200
```

Reading serial from a script: opening the port resets the board once, and the macOS driver can replay old buffered lines. Repeated `ready` lines do not by themselves mean a boot loop, so look for `rst:` lines. The system `python3` has no pyserial. Use `/opt/homebrew/opt/esptool/libexec/bin/python3`, which does.

## Mac actions (`host/`)

Hammerspoon does the Mac side; there is no other server and nothing to build.

- `host/hammerspoon/keybordy.lua`: binds F13..F20 with `hs.hotkey` (no Accessibility needed) and runs each key's action from `~/.config/keybordy/keymap.json` (outside git; seeded from `host/keymap.default.json`). Action types and their fields are the `FIELDS` table; `cleanAction` drops anything else. Runners: `app`, `terminal` (Ghostty 1.3 AppleScript `new surface configuration`, the command goes in as `initial input`), `shell` (`zsh -lc`, output recorded), `url`, `shortcut` (`shortcuts run`), and `keys`/`text`/`media`, which need Accessibility and fail with a message without it. `M.fire(i, source, draft, label)` is the one path for board presses and simulated ones and logs events (last 40). Watchers reload Hammerspoon when `host/hammerspoon/*.lua` changes and reload the keymap when `keymap.json` changes. It requires `hs.ipc`, so `~/Applications/Hammerspoon.app/Contents/Frameworks/hs/hs -t 3 -c '<lua>'` runs Lua in it (e.g. `require("keybordy").fire(3, "board")` stands in for a real press). Reload with `hs.timer.doAfter(0.2, hs.reload)` so the call returns first.
- `host/hammerspoon/keybordy_web.lua`: `hs.httpserver` on `localhost:7373`. Serves `host/ui/` plus the simulator's `src/tokens/`, `public/fonts/` and `public/keybordy/sticker.css` straight from `sim/velxio/frontend`, and cuts the sticker SVG out of its `index.html`, so the editor's look has one source. API routes are listed at the top of the file. Security: loopback only, `Host` must be `localhost:7373`/`127.0.0.1:7373`, a foreign `Origin` gets 403, and `/api/*` (except icons) needs `X-Keybordy-Token`, which is embedded in the served page and stored in `~/.config/keybordy/token`. Keep all three checks: the API runs shell commands.
- `host/ui/`: plain HTML/CSS/ES module, no build. `app.js` holds the action catalog (`TYPES`, `DEFAULTS`), the editor, and a 400 ms poll of `/api/events` that lights a cap per new event. Cap colors come from `firmware/keys8/diagram.json`. Check UI changes with agent-browser at http://localhost:7373.
- `just host-install` installs the Hammerspoon cask into `~/Applications` (`/Applications` needs sudo, which has no TTY here), symlinks `keybordy.lua` into `~/.hammerspoon` and requires it from `init.lua`. The Mac pairs with the board in System Settings > Bluetooth. `just keymap` opens the editor.

## Wokwi diagram

`firmware/keys8/diagram.json` is a plain Wokwi diagram that also works on wokwi.com. It must use `wokwi-esp32-devkit-v1`, because Velxio rejects `board-esp32-devkit-c-v4`. It also loads unchanged in the local simulator via `?project=keys8`. That part's pin names are `D<n>` for most GPIOs, with these exceptions:
- GPIO16 is `RX2`, GPIO17 is `TX2`
- GPIO39 is `VN`, GPIO36 is `VP`
- ground is `GND.1` / `GND.2`
- USB serial is `TX0` / `RX0`

`wokwi.toml` points at `build/keys8.ino.merged.bin` and `.elf`, for the Wokwi VS Code extension.

## Local simulator (`sim/`)

`sim/velxio/` is a vendored fork of Velxio (AGPLv3, upstream commit `273a0ca`) with the Pro walls, accounts, sharing, analytics, news, SEO and desktop code removed. `sim/velxio/NOTICE.md` lists the changes and `sim/velxio/CLAUDE.md` covers the codebase. Raspberry Pi (Linux) and STM32 boards are hidden because their emulators were never open source.

```sh
just sim-fetch-qemu   # once: QEMU .so + ESP32 ROMs from the pinned upstream image into prebuilt/qemu/ (gitignored)
just sim-up           # docker compose -f sim/compose.yaml up -d --build --wait; Docker Desktop must be running
just sim-down
just dev              # compose.dev.yaml on top (backend hot reload, Postgres on 127.0.0.1:5433) + Vite on :5173
just test-backend     # uv run pytest; starts the dev Postgres and sets TEST_DATABASE_URL for the `db` tests
just test-frontend
```

Open http://localhost:3080/editor?project=keys8. The `velxio` container (image `keybordy-velxio:local`) runs nginx, the FastAPI backend (its own ESP-IDF/arduino-esp32 compile, uv venv at `/app/.venv`) and ESP32 emulation in QEMU. The `postgres` container (`velxio-postgres`, volume `velxio-pgdata`) holds saved projects. `firmware/` is mounted read-only at `/projects/`, and nginx lists folders as JSON.

- `?project=<folder>` imports `firmware/<folder>/diagram.json` plus its sketch sources on every load, so the repo stays the source of truth. The importer maps `wokwi-esp32-devkit-v1` to Velxio's ESP32, renames its `D<n>`/`GND.<n>` pins, and drops `$serialMonitor` wires, so the plain Wokwi diagram needs no conversion.
- Persistence: scratch and `?project=` folder workspaces autosave (1 s debounce) to the browser's IndexedDB draft. File > Save to projects… forks the workspace into Postgres via `/api/projects` and the URL becomes `?id=<uuid>`; saved projects autosave there with an optimistic `base_revision` check (409 opens a conflict dialog), and a dirty IndexedDB copy covers offline edits. Plain `/editor` reopens the last saved project, else the draft. Logic lives in `frontend/src/utils/workspacePersistence.ts`, API in `backend/app/api/routes/projects.py`, schema in `backend/migrations/`. Save (Ctrl+S) still downloads a Wokwi `.zip`. Nothing writes back to `firmware/`.
- Migrations run at container boot (`alembic upgrade head`); if they fail the simulator still works and `/api/projects` answers 503. New migration: `just db-revision "msg"` with `just dev` running.
- Frontend checks: `just typecheck` and `just test-frontend`. About 350 TypeScript error lines and the epaper/i2c test failures predate the fork.
- UI work without rebuilding the image: `just dev`, then open http://localhost:5173/editor?project=keys8 (Vite picks the next port if 5173 is taken). Vite proxies `/api` (with websockets) and `/projects` to nginx on 3080. Backend edits reload in place. Rebuild the image for Dockerfile, nginx or entrypoint changes; app layers come after the toolchain layers, so that takes well under a minute.
- The UI is branded keybordy and is dark only (the "Procedure Online" theme). Colors are tokens in `sim/velxio/frontend/src/tokens/colors.css`; Monaco restates them in `components/editor/monacoThemes.ts`, so change both together. Fonts are self-hosted in `frontend/public/fonts/` (Anybody, Geist, Martian Mono).
- The logo sticker (boot splash in `index.html`, compile card) is styled by `frontend/public/keybordy/sticker.css`, linked globally so the splash animates before JS loads. Its SVG exists twice, in `index.html` and `components/ui/LogoSticker.tsx`: change both. `lib/bootSplash.ts` drops the splash once `EditorPage` has loaded the workspace.
- Motion follows one vocabulary: keycaps press into a skirt (an inset shadow), stickers slap in and peel. On boot the splash sticker flies into the header mark (`data-booted` on `<html>` cues the catch and the title type-in). `components/simulator/KeyHud.tsx` lights one cap per `K<n>` part from the firmware's `key N down/up` serial lines and rings the matching part on the canvas, so it only shows what the sketch registered. Every animation has a `prefers-reduced-motion` fallback.
- Real board from the browser (Chrome/Edge, Web Serial): the toolbar's device dock shows whether the paired ESP32 is on USB (pair once from its chip), Flash builds if the code changed and writes the simulator's own image with esptool-js (`lib/esp32Flash.ts`, skips NVS, verifies MD5), then attaches and resets. Attach streams the board's serial into the monitor's USB tab and drives the key HUD. State is in `store/useDeviceStore.ts`. The port is exclusive, so close `just fw-monitor` or any other serial reader first. That image (DIO 40 MHz, watchdogs off) boots on the bench board, unlike host `arduino-cli` images in QEMU.
- Each key's color lives in `firmware/keys8/diagram.json`: the pushbutton `color` and both of its wires use the same hex. The serial monitor colors `key N down/up` lines from the cap color of the part labeled `KN`, so keep the labels `K1`..`K8`.

Gotchas:
- The simulation only runs in a visible tab. In a headless or hidden tab, serial stays at `Waiting for serial data...`. To check firmware and wiring, use the headless harness (`just sim-check`) instead of the UI. Use a visible browser only for UI work.
- The first image build clones ESP-IDF and takes 30+ minutes. The first ESP32 compile takes about 2 minutes; later compiles are cached in the `velxio-ccache` and `velxio-build` volumes.
- `sim/harness/simcheck.py` wraps `/app/.venv/bin/python /app/app/services/esp32_worker.py` inside the container. The worker reads a JSON config on stdin and emits `uart_tx` / `gpio_*` JSON on stdout (see its docstring). Use `just sim-run -v` before driving it by hand.

## Headless checks (`sim/harness/simcheck.py`)

This is how Claude runs simulations and reads their output without a browser. It is stdlib Python and runs on the host. `lint` needs nothing else. `run` and `check` need `just sim-up`.

```sh
just sim-lint [name]                  # diagram.json vs KEY_PINS/GND_PINS vs README table, pin rules
just sim-check [name] [--bounce]      # lint, then boot, tap every Kn, expect `key n down`/`key n up` once each
just sim-run [name] -s "until ready; tap K3; expect 'key 3 up'"   # any scenario; prints timed serial + actions
```

`name` is a folder under `firmware/` (default `keys8`) or a path to a copy, which is handy for trying a change in the scratchpad. Add `--json` for machine-readable output on stdout (`ok`, `problems`, `warnings`, `serial[{t_ms,line}]`, `actions`, `gpio`). Use `-v` to stream serial and worker logs. The exit code is 0 only on PASS.

- Script steps are separated by `;`: `wait MS`, `press P`/`release P`, `tap P [HOLD_MS]`, `bounce P [HOLD_MS]` (contact chatter on both edges), `cw P [N]`/`ccw P [N]` (ky-040 detents), `until RE [MS]` (default 20 s, for boot), `expect RE [MS]` (default 2 s), `reject RE [MS]`. `P` is a part id or label (`k3`, `K3`, `rot`). Pressing `rot` presses its SW.
- It compiles through the simulator's `/api/compile/` (about 30 s cold, cached in `sim/.cache/` by source hash, `--fresh` bypasses the cache) and runs `esp32_worker.py` in the `velxio` container via `docker exec`.
- The worker alone does not solve the circuit: without help every `INPUT_PULLUP` pin reads LOW. The harness plays the browser's role. It builds nets from `diagram.json`, where a pushbutton's `1.l/1.r` and `2.l/2.r` are one node each and a press joins them. It tracks each GPIO's direction, level and pull from worker events, then writes each input's level with `set_pin`. It models ky-040 CLK/DT/SW pull-ups only when VCC is on a supply.
- `check` fails on: lint errors, `rst:` lines after the first, panics and backtraces, worker crash/reboot events, shorts (two drivers at different levels on one net), switch inputs with no pull, switches with no GND or LOW GPIO on either side, a missing or extra `key` line. In `run`, the circuit checks are only warnings, because the sketch may not use the keys.
- It has been checked against deliberate faults, each of which fails as it should: `INPUT` instead of `INPUT_PULLUP`, a leg moved to GPIO34, a GPIO ground driven HIGH, and `DEBOUNCE_MS = 0` with `--bounce`.
- `--bin` runs a prebuilt image, but images from the host `arduino-cli` (core 3.3.12) do not work in this QEMU. The default QIO build fails its flash init. A `FlashMode=dio` build boots, then panics with `Cache error` on the first GPIO edge. Use the default path, which is the simulator's own compile.
- Timing is wall clock through a pipe, with about 20 ms from a press to the serial line. Contact-chatter blips are 3 ms. Do not assert on sub-10 ms timing.

## PCB (`pcb/`)

Rev A carrier board: DevKit, OLED (1x4) and KY-040 (1x5 right angle) on female headers, 8 Kailh MX hotswap sockets on the back, GND pours on both layers. `pcb/build.py` is the source: it places, routes (fixed coordinates, no autorouter; Freerouting was tried and left nets unrouted) and exports the board with KiCad's bundled Python (`just pcb-build`, `just pcb-fab`, `just pcb-open`). KiCad 10 lives in `~/Applications/KiCad` (copied from the dmg; the cask wants sudo for `/Library`). `pcb-fab` fails on any DRC violation or unconnected item.

- Its pin map is not the `keys8` one: keys on 16, 18, 21, 23, 4, 17, 19, 22 (K1..K8), OLED SDA 33 / SCL 32, rotary CLK 35 / DT 34 / SW 39, every switch leg B on GND. The firmware for the board must match `KEYS`, `OLED_PINS` and `ROT_PINS` in `build.py`, and `pcb/README.md` has the table.
- DevKit orientation follows the Wokwi DOIT V1 part: USB toward you, the VIN side is on the left. The top row in `build.py` is the VIN side, rows 25.4 mm apart.
- The hotswap footprint is marbastlib's (CERN-OHL-P), drawn from the back and flipped onto B.Cu. Hole-to-hole minimum is 0.45 mm because that footprint has 0.46 mm between a pin hole and the 5-pin peg hole.

## keybordy MP (`layout/`)

This is the next device: an ESP32-S3-WROOM-1-N16R8 macropad with 22 MX keys (1u/1.5u/2u), 3 encoders, a white 2.42" SSD1309 OLED, an ICS-43434 mic, a MAX98357A speaker amp and a LiPo, on a JLCPCB-assembled PCB in a printed case. `docs/macropad.md` has the spec, parts, pin table and phase plan.

- `layout/macropad.json` is the single source for the PCB build, the CAD, the firmware and the host editor. Keys are in u (top-left corner, KLE style); every other position is a part centre in mm. The origin is the key field's top-left corner and y points toward the user.
- `layout/pins.json` is the GPIO map. Strapping pins (0, 3, 45, 46) need a `strap` note. VBAT must be on ADC1. 19/20, 26–32 and 35–37 are off-limits.
- `layout/gen.py` (stdlib):
  - `just mp-lint` runs `check`: layout overlaps, matrix slots, stabilizers on 2u+, knob gaps, mounting holes near switches, battery/speaker fit, pin rules, and whether `board_pins.h` is stale. It has been checked against deliberate faults.
  - `just mp-gen` writes `firmware/macropad/main/board_pins.h`. Do not edit that file by hand.
  - `just mp-preview` writes the three.js concept render, `layout/preview/keybordy-mp.html` (gitignored), from `layout/preview/template.html`. The published copy is https://claude.ai/artifact/JGeDgLbdqCekFHqC4e5jJk; republish it after layout changes.
- After any change to the layout or pins, run `just mp-gen` and `just mp-lint`, and report the result.
- `cad/` (uv project, build123d) holds the printed parts, all built from the layout.
  - `macropad.py` builds the parts and `just cad-build` exports them: tray (case bottom, printed floor down), deck (4 mm top, printed face down so it gets the plate texture), plate (1.5 mm, 14.1 mm holes, standoffs), caps 1u/1.5u/2u, knobs (D-bore 6.1/4.6), and fit tests.
  - CAD frame: X = layout x, Y = -layout y, Z up, plate top at Z = 0.
  - The caps are the kodemotion-26 cap, which is proven on this printer.
  - Print rules come from `~/personal/projects/bambulab/design-rules.md`.
  - `just cad-check` (`fitcheck.py`) places stand-in blocks for the PCB, switches, caps (up and pressed), encoders, knobs, battery, speaker, ESP32 and OLED, and fails on any clash. Some stand-in heights are estimates and are marked in the file.
  - `just cad-slice` (`slice.py`) slices one Bambu project per filament colour into `cad/out/plates/` (gitignored). It uses the bambulab flattened profiles and their `--check`.
  - `just cad-preview` (`preview.py` + `cad/preview/template.html`) builds a page from the real meshes, placed on the beds exactly where the slicer put them (it reads the .3mf build items), plus an assembled view. Published copy: https://claude.ai/artifact/S8rzS7jPUv2tLSBWmkwrLr. Republish it after reslicing.
  - After changing the layout or the CAD, run `cad-build`, then `cad-check`, then `cad-slice`, then `cad-preview`.

## Wiring guide (`guide/`)

A Vite + React 19 + TypeScript app using `@xyflow/react` for the wiring graph and `@react-three/fiber`/`drei` for a 3D bench. Nets, devices, and pins are defined in `src/data.ts`. It still describes the old OLED + rotary breadboard setup, not the `keys8` wiring.

```sh
just guide-dev    # bun run dev
just guide-build  # tsc --noEmit, then vite build
```

## Privacy

- The board's MAC is kept out of git. It lives in the gitignored `.env` as `ESP32_BASE_MAC`, and `.env.example` is the template. Docs refer to `ESP32_BASE_MAC` and never to the value.
- This repo commits with the GitHub noreply email set in the local git config.
- NVS and SPIFFS were deliberately never read because they can hold Wi-Fi credentials.
