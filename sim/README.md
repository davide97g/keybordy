# Local simulator

`sim/velxio/` is a fork of [Velxio](https://github.com/davidmonterocrespo24/velxio) (AGPLv3), an open-source take on Wokwi: a circuit canvas, a code editor, a compiler, and an emulated ESP32 with a serial monitor. The ESP32 runs in QEMU inside the container; the browser only draws the circuit. See `velxio/NOTICE.md` for what the fork changed.

Everything runs on this Mac. There are no accounts, no plans, no sharing, and nothing is sent to velxio.dev.

## First build

Docker Desktop must be running.

```sh
sim/velxio/scripts/fetch-qemu.sh                  # QEMU runtime, copied out of the pinned upstream image
docker compose -f sim/compose.yaml up -d --build  # build + start (the first build clones ESP-IDF, ~30+ min)
```

`fetch-qemu.sh` copies `libqemu-xtensa.so`, `libqemu-riscv32.so` and the ESP32 boot ROMs into `velxio/prebuilt/qemu/` (gitignored). Upstream's build would download them from velxio.dev with a license key instead.

## Start and stop

```sh
docker compose -f sim/compose.yaml up -d     # start
docker compose -f sim/compose.yaml down      # stop, caches are kept
docker compose -f sim/compose.yaml up -d --build   # after editing sim/velxio
```

Open http://localhost:3080/editor?project=keys8. The port is bound to 127.0.0.1 only.

## Projects, drafts and saving

- `firmware/` is mounted read-only at `/projects/`. Any folder with a `diagram.json` is a project: `/editor?project=<folder>` imports its `diagram.json` and sketch sources, the same way a Wokwi `.zip` imports. Every load re-reads the files, so the repo is the source of truth: edit the sketch or the diagram, then reload.
- Plain `/editor` comes back to the last workspace: it autosaves to the browser's IndexedDB a second after each edit (the Save button's dot shows the state).
- Save (Ctrl+S) downloads the workspace as a Wokwi `.zip` (`diagram.json` + sources), the layout of a `firmware/<name>/` folder. File > Export .vlx keeps multi-board projects. Nothing is written back to the repo, so copy edits into `firmware/` yourself.
- Plain Wokwi diagrams work as they are: `wokwi-esp32-devkit-v1` maps to Velxio's ESP32 and its `D<n>` / `GND.<n>` pins are renamed, and `$serialMonitor` wires are dropped.

Press the green **Run** button. The first ESP32 compile takes about 2 minutes; later ones come from the cache in seconds. The serial panel prints `keys8 ready`. Click a key on the canvas and it prints `key N down` / `key N up`.

## What stays local

- Compiling, emulation and project storage all run in the container or the browser.
- The Library Manager downloads Arduino libraries from the internet. `keys8` uses none.
- MicroPython firmware is fetched from micropython.org, with a bundled fallback.

## Gotchas

- The simulation only runs in a visible browser tab. A hidden or headless tab shows `Waiting for serial data...` forever.
- Velxio does not know Wokwi's `board-esp32-devkit-c-v4`. The diagram uses `wokwi-esp32-devkit-v1`, the 30-pin board that matches the real one.
- Raspberry Pi (Linux) and STM32 boards are hidden: their emulators were never open source.
