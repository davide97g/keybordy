# Local simulator

`sim/velxio/` is a fork of [Velxio](https://github.com/davidmonterocrespo24/velxio) (AGPLv3), an open-source take on Wokwi: a circuit canvas, a code editor, a compiler, and an emulated ESP32 with a serial monitor. The ESP32 runs in QEMU inside the container; the browser only draws the circuit. See `velxio/NOTICE.md` for what the fork changed.

Everything runs on this Mac. There are no accounts, no plans, no sharing, and nothing is sent to velxio.dev.

## First build

Docker Desktop must be running.

```sh
just sim-fetch-qemu   # QEMU runtime, copied out of the pinned upstream image
just sim-up           # build + start the simulator and Postgres (the first build clones ESP-IDF, ~30+ min)
```

`fetch-qemu.sh` copies `libqemu-xtensa.so`, `libqemu-riscv32.so` and the ESP32 boot ROMs into `velxio/prebuilt/qemu/` (gitignored). Upstream's build would download them from velxio.dev with a license key instead.

## Start and stop

```sh
just sim-up           # start (rebuilds what changed; app layers come last, so edits rebuild in seconds)
just sim-down         # stop, caches and saved projects are kept
just sim-logs velxio  # follow the logs
```

Open http://localhost:3080/editor?project=keys8. The port is bound to 127.0.0.1 only.

## Dev loop

`just dev` starts the containers with `compose.dev.yaml` on top, then Vite on the host:

- UI with hot reload at http://localhost:5173/editor?project=keys8. Vite proxies `/api` (with the simulation websocket) and `/projects` to nginx on 3080.
- The backend source is bind-mounted and uvicorn reloads on edits.
- Postgres is reachable on 127.0.0.1:5433 (user, password and database `velxio`) for `just test-backend`, `just db-psql` and `just db-revision "msg"`.

Rebuild the image (`just sim-up`) for Dockerfile, nginx or entrypoint changes, and before relying on the UI at 3080.

## Projects, drafts and saving

- `firmware/` is mounted read-only at `/projects/`. Any folder with a `diagram.json` is a project: `/editor?project=<folder>` imports its `diagram.json` and sketch sources, the same way a Wokwi `.zip` imports. Every load re-reads the files, so the repo is the source of truth: edit the sketch or the diagram, then reload.
- A folder project autosaves only to the browser draft (IndexedDB), a second after each edit. File > **Save to projects…** forks the workspace into a saved project in Postgres (it remembers the folder it came from) and the URL becomes `/editor?id=<uuid>`. From then on it autosaves to the database. File > **Projects…** lists, opens, renames and deletes them.
- Saved-project autosave is optimistic: if another tab saved first, a dialog offers to load the latest, overwrite, or save yours as a copy. If the database is down, edits stay in the browser (the Save button's tooltip says so) and sync when it is back.
- Plain `/editor` comes back to the last workspace: the saved project that was open, else the browser draft. The Save button's dot shows the state.
- `just db-dump` writes the project store to `backups/` (gitignored).
- Save (Ctrl+S) downloads the workspace as a Wokwi `.zip` (`diagram.json` + sources), the layout of a `firmware/<name>/` folder. File > Export .vlx keeps multi-board projects. Nothing is written back to the repo, so copy edits into `firmware/` yourself.
- Plain Wokwi diagrams work as they are: `wokwi-esp32-devkit-v1` maps to Velxio's ESP32 and its `D<n>` / `GND.<n>` pins are renamed, and `$serialMonitor` wires are dropped.

Press the green **Run** button. The first ESP32 compile takes about 2 minutes; later ones come from the cache in seconds. The serial panel prints `keys8 ready`. Click a key on the canvas and it prints `key N down` / `key N up`.

## What stays local

- Compiling, emulation and project storage all run in the containers or the browser.
- The Library Manager downloads Arduino libraries from the internet. `keys8` uses none.
- MicroPython firmware is fetched from micropython.org, with a bundled fallback.

## Gotchas

- The simulation only runs in a visible browser tab. A hidden or headless tab shows `Waiting for serial data...` forever.
- Velxio does not know Wokwi's `board-esp32-devkit-c-v4`. The diagram uses `wokwi-esp32-devkit-v1`, the 30-pin board that matches the real one.
- Raspberry Pi (Linux) and STM32 boards are hidden: their emulators were never open source.
