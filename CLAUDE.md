# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A hand-wired keyboard on a classic ESP32 DevKit: eight MX-style switches wired with jumpers only (no breadboard, no PCB, no solder), plus a rotary encoder to add later. The repo holds the Arduino firmware, a Wokwi circuit diagram, a fully local simulator (a vendored Velxio fork in Docker), bench notes in `docs/`, and an interactive wiring guide in `guide/`.

There are no tests or linters for the firmware. Verification means compiling, then either flashing and reading serial or running the circuit in the simulator. The vendored simulator has its own test suites (see below).

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

- `keys8`: the current 8-key firmware. It debounces for 15 ms and prints `keys8 ready`, then `key N down` / `key N up`, at 115200.
- `switches_oled`, `rotary_oled`: earlier OLED demos on the old breadboard wiring (OLED I2C on 21/22 at `0x3C`, rotary on 25/26/27). They need the Adafruit SSD1306 and Adafruit GFX libraries. Their pins now clash with the `keys8` GPIO grounds.

```sh
just fw-build [name]     # arduino-cli compile --fqbn esp32:esp32:esp32 firmware/keys8
just fw-flash [name]     # compile --upload -p /dev/cu.usbserial-0001 (override with ESP32_PORT)
just fw-bin [name]       # --output-dir firmware/<name>/build, binaries for wokwi.toml
just fw-monitor          # arduino-cli monitor -c baudrate=115200
```

Reading serial from a script: opening the port resets the board once, and the macOS driver can replay old buffered lines. Repeated `ready` lines do not by themselves mean a boot loop, so look for `rst:` lines. The system `python3` has no pyserial. Use `/opt/homebrew/opt/esptool/libexec/bin/python3`, which does.

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
- Each key's color lives in `firmware/keys8/diagram.json`: the pushbutton `color` and both of its wires use the same hex. The serial monitor colors `key N down/up` lines from the cap color of the part labeled `KN`, so keep the labels `K1`..`K8`.

Gotchas:
- The simulation only runs in a visible tab. In a headless or hidden tab, serial stays at `Waiting for serial data...`. Use a visible browser to test Run and key presses.
- The first image build clones ESP-IDF and takes 30+ minutes. The first ESP32 compile takes about 2 minutes; later compiles are cached in the `velxio-ccache` and `velxio-build` volumes.
- Debug emulation outside the browser by running `/app/.venv/bin/python /app/app/services/esp32_worker.py` inside the container. It reads a JSON config on stdin and emits `uart_tx` / `gpio_change` JSON on stdout.

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
