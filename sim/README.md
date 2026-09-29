# Local simulator

[Velxio](https://github.com/davidmonterocrespo24/velxio) (AGPLv3) runs in Docker on this Mac. It is an open-source take on Wokwi: a circuit canvas, a code editor, a compiler, and an emulated ESP32 with a serial monitor. The ESP32 runs in QEMU inside the container. The browser only draws the circuit.

Set up 29 Sep 2026 with image `ghcr.io/davidmonterocrespo24/velxio:master` (arm64, 6.6 GB).

## Start and stop

Docker Desktop must be running.

```
docker compose -f sim/compose.yaml up -d     # start
docker compose -f sim/compose.yaml down      # stop, caches are kept
```

Open http://localhost:3080/editor. The port is bound to 127.0.0.1 only.

## The keys8 project loads by itself

Two containers run. `velxio` is the simulator. `velxio-proxy` is an nginx in front of it that adds `web/autoload.js` to every page and serves `firmware/keys8` read-only.

On `/editor`, `autoload.js` fetches `diagram.json` and `keys8.ino` from the repo, packs them into a zip in the browser, closes the "Start a new project" picker, and imports the zip. Velxio keeps no workspace across reloads for anonymous users, so this runs on every load. The repo is the source of truth: edit the sketch or the diagram, then reload the page.

Open http://localhost:3080/editor?blank for an empty editor without the autoload.

Press the green **Run** button. The first ESP32 compile takes about 2 minutes. Later compiles come from the cache in seconds. The serial panel prints `keys8 ready`. Click a key on the canvas and it prints `key N down` / `key N up`.

Edits made inside Velxio are lost on reload. Copy them back into `firmware/keys8/` first.

## What stays local

- Compiling, emulation, and project storage all run in the container.
- `VELXIO_NEWS=off` stops the news fetch from velxio.dev.
- The Google Analytics tag only loads on velxio.dev hostnames, so it does nothing on localhost.
- The Library Manager downloads Arduino libraries from the internet. `keys8` uses none.
- The first run downloaded a few arduino-cli tools. They are now cached in the `velxio-arduino-libs` volume.

## Gotchas

- The simulation only runs in a visible browser tab. A hidden or headless tab shows `Waiting for serial data...` forever.
- Velxio does not know Wokwi's `board-esp32-devkit-c-v4`. The diagram uses `wokwi-esp32-devkit-v1`, the 30-pin board that matches the real one, and `autoload.js` renames it for Velxio.
- Docker bind-mounts of single files keep the old file after an editor replaces it. That is why `autoload.js` lives in the mounted `web/` folder.
