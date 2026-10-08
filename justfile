# keybordy tasks. `just` lists them. Tool versions are pinned in mise.toml.

set dotenv-load

compose := "docker compose -f sim/compose.yaml"
dev_compose := compose + " -f sim/compose.dev.yaml"
port := env("ESP32_PORT", "/dev/cu.usbserial-0001")
fqbn := "esp32:esp32:esp32"
sketch := "keys8"
test_db := "postgresql+asyncpg://velxio:velxio@127.0.0.1:5433/velxio_test"
dev_db := "postgresql+asyncpg://velxio:velxio@127.0.0.1:5433/velxio"

default:
    @just --list

# ── Firmware ────────────────────────────────────────────────────────────────

# Compile a sketch in firmware/<name>
fw-build name=sketch:
    arduino-cli compile --fqbn {{fqbn}} firmware/{{name}}

# Compile and flash over USB
fw-flash name=sketch:
    arduino-cli compile --upload -p {{port}} --fqbn {{fqbn}} firmware/{{name}}

# Serial monitor at 115200
fw-monitor:
    arduino-cli monitor -p {{port}} -c baudrate=115200

# Binaries in firmware/<name>/build for wokwi.toml (Wokwi VS Code extension)
fw-bin name=sketch:
    arduino-cli compile --fqbn {{fqbn}} --output-dir firmware/{{name}}/build firmware/{{name}}

# ── keybordy MP (ESP32-S3 macropad; layout/ is the single source) ─────────────

# Lint layout/macropad.json + layout/pins.json against the ESP32-S3 module rules
mp-lint *args:
    @python3 layout/gen.py check {{args}}

# Regenerate firmware/macropad/main/board_pins.h from the layout and pin map
mp-gen:
    @python3 layout/gen.py header

# 3D concept render from the layout, opened in the browser
mp-preview:
    @python3 layout/gen.py preview
    open layout/preview/keybordy-mp.html

# A4 keycap decal sheet (PDF, 1:1) for laser waterslide paper; take it to a copy shop
mp-stickers *args:
    @python3 layout/gen.py stickers {{args}}
    open layout/stickers/keycap-decals.pdf

# Printed parts from the layout (build123d): STL + STEP into cad/out/ (e.g. `just cad-build knob cap1`)
[working-directory: 'cad']
cad-build *parts:
    uv run python macropad.py {{parts}}

# Put the parts and stand-ins for the electronics together and report collisions
[working-directory: 'cad']
cad-check:
    uv run python fitcheck.py

# Slice into Bambu Studio projects, one plate per colour, into cad/out/plates/ (print 01-fit first)
[working-directory: 'cad']
cad-slice *plates:
    uv run python slice.py {{plates}}

# Print preview page (real meshes on the sliced plates + assembly) into cad/out/preview/, after cad-slice
[working-directory: 'cad']
cad-preview:
    uv run python preview.py
    open out/preview/keybordy-mp-prints.html

# ── Mac actions (Hammerspoon) ───────────────────────────────────────────────

# Install Hammerspoon (into ~/Applications, no sudo), link host/hammerspoon/keybordy.lua into ~/.hammerspoon, start it
host-install:
    brew list --cask hammerspoon >/dev/null 2>&1 || brew install --cask --appdir="$HOME/Applications" hammerspoon
    mkdir -p ~/.hammerspoon
    ln -sf "{{justfile_directory()}}/host/hammerspoon/keybordy.lua" ~/.hammerspoon/keybordy.lua
    grep -qs 'require("keybordy")' ~/.hammerspoon/init.lua || echo 'require("keybordy")' >> ~/.hammerspoon/init.lua
    open -a Hammerspoon 2>/dev/null || open "$HOME/Applications/Hammerspoon.app"

# Keymap editor, served by Hammerspoon (also in its ⌨︎ menu-bar menu)
keymap:
    open http://localhost:7373/

# ── Simulator ───────────────────────────────────────────────────────────────

# Once: QEMU .so + ESP32 ROMs into sim/velxio/prebuilt/qemu/
sim-fetch-qemu:
    sim/velxio/scripts/fetch-qemu.sh

# Build and start the simulator + Postgres (http://localhost:3080/editor?project=keys8)
sim-up:
    {{compose}} up -d --build --wait

sim-down:
    {{compose}} down

# Static wiring check: diagram.json vs the sketch's pin map vs README (no container needed)
[positional-arguments]
sim-lint *args:
    @python3 sim/harness/simcheck.py lint "$@"

# Compile + boot in QEMU headless, play a --script, print serial (e.g. `just sim-run keys8 -s "until ready; tap K3"`)
[positional-arguments]
sim-run *args:
    @python3 sim/harness/simcheck.py run "$@"

# Lint, then tap every key and assert `key N down/up` (add --bounce for contact chatter)
[positional-arguments]
sim-check *args:
    @python3 sim/harness/simcheck.py check "$@"

# Follow container logs (e.g. `just sim-logs velxio`)
sim-logs *args:
    {{compose}} logs -f {{args}}

# Dev loop: backend reloads on edits, UI with HMR on http://localhost:5173/editor?project=keys8
dev:
    {{dev_compose}} up -d --build --wait
    cd sim/velxio/frontend && bun run dev

dev-down:
    {{dev_compose}} down

# ── Project store (Postgres) ────────────────────────────────────────────────

# Apply migrations in the running container (it also does this at boot)
db-migrate:
    docker exec velxio sh -c 'cd /app && /app/.venv/bin/alembic -c /app/alembic.ini upgrade head'

# New migration from model changes (needs `just dev` running for the 5433 port)
[working-directory: 'sim/velxio/backend']
db-revision msg:
    DATABASE_URL={{dev_db}} uv run alembic revision --autogenerate -m "{{msg}}"

db-psql:
    docker exec -it velxio-postgres psql -U velxio velxio

# Dump the project store to backups/ (gitignored)
db-dump:
    mkdir -p backups
    docker exec velxio-postgres pg_dump -U velxio --clean velxio > backups/velxio-$(date +%Y%m%d-%H%M%S).sql

# ── Checks ──────────────────────────────────────────────────────────────────

install:
    cd sim/velxio/frontend && bun install --frozen-lockfile
    cd guide && bun install --frozen-lockfile
    cd sim/velxio/backend && uv sync

# Frontend unit tests (vitest; `bun test` would run Bun's own runner instead)
[working-directory: 'sim/velxio/frontend']
test-frontend *args:
    bun run test {{args}}

# Backend tests, including the Postgres ones against the dev compose database
test-backend *args:
    {{dev_compose}} up -d --wait postgres
    cd sim/velxio/backend && TEST_DATABASE_URL={{test_db}} uv run pytest {{args}}

test: test-backend test-frontend

# TypeScript check (about 170 errors predate the fork)
[working-directory: 'sim/velxio/frontend']
typecheck:
    bun run tsc

# ruff must pass; eslint reports too, but vendored code has pre-existing errors
lint:
    cd sim/velxio/backend && uv run ruff check .
    -cd sim/velxio/frontend && bun run lint --quiet

# ── PCB (KiCad 10 in ~/Applications/KiCad) ──────────────────────────────────

kicad_app := env("KICAD_APP", home_directory() / "Applications/KiCad/KiCad.app")
kicad_py := kicad_app / "Contents/Frameworks/Python.framework/Versions/Current/bin/python3"

# Regenerate the board from pcb/build.py: place, route, then DRC + Gerbers into pcb/fab/
pcb-build:
    {{kicad_py}} pcb/build.py place
    {{kicad_py}} pcb/build.py route
    {{kicad_py}} pcb/build.py fab

# DRC + Gerbers + renders only (after editing the board by hand in KiCad)
pcb-fab:
    {{kicad_py}} pcb/build.py fab

pcb-open:
    open -a "{{kicad_app}}" pcb/keybordy.kicad_pro

# ── Wiring guide ────────────────────────────────────────────────────────────

[working-directory: 'guide']
guide-dev:
    bun run dev

[working-directory: 'guide']
guide-build:
    bun run build

# ── Teaser video (video/; three.js renderer vendored from pdoom-video) ───────

# Download the third-party media (music, switch recordings, SFX, HDRI) into video/public/vendor
video-fetch:
    video/scripts/fetch_vendor.sh

# Export the printed parts as fine meshes for the video (after cad changes)
[working-directory: 'cad']
video-meshes:
    uv run python ../video/scripts/export_meshes.py

# Music edit, cue sheet, sound design, mix and master for cut v (data/[vN/]cues.json, build/[vN/]mix_*.wav)
[working-directory: 'video/audio']
video-audio v="2":
    uv run python build.py --v {{v}}

# Screenshots of the keymap editor with demo data, for v2's editor shot (video/build/editor)
[working-directory: 'video/app']
video-editor-shots:
    bun ../scripts/capture_editor.ts

# Live preview with the soundtrack (space plays, [ ] jump between scenes); add ?v=2 for the second cut
[working-directory: 'video/app']
video-dev:
    bunx vite

# Stills at times in seconds, e.g. `just video-stills 3,12.2,20 2`
[working-directory: 'video/app']
video-stills times v="2" *args:
    bun scripts/render.ts stills --v {{v}} --t {{times}} --samples auto --shutter 0.2 {{args}}

# Fast 1080p draft of cut v (12 sub-frames per frame)
[working-directory: 'video/app']
video-draft v="2":
    bun scripts/render.ts video --v {{v}} --samples 12 --shutter 0.4 --preset veryfast --crf 20 --out ../out/{{ if v == "1" { "" } else { "v" + v + "/" } }}draft-1080.mp4

# The final 4K60 render of cut v (adaptive motion blur, depth of field and soft shadows), then the deliverables
video-render v="2":
    cd video/app && bun scripts/render.ts video --v {{v}} --scale 2 --samples auto --max-samples 108 --shutter 0.3 --x264 aq-mode=3:rc-lookahead=30 --crf 16 --out ../out/{{ if v == "1" { "" } else { "v" + v + "/" } }}render-4k.mp4
    video/scripts/mux.sh {{v}}

# The upright cut of v for Reels and Shorts (?aspect=9x16, 1080x1920, same edit and soundtrack): fast draft
[working-directory: 'video/app']
video-reel-draft v="5":
    bun scripts/render.ts video --v {{v}} --vertical --samples 12 --shutter 0.4 --preset veryfast --crf 20 --out ../out/{{ if v == "1" { "" } else { "v" + v + "/" } }}9x16/draft-1080x1920.mp4

# The upright cut at 2160x3840 60 fps, then its deliverables (4K upright + 1080x1920, stereo)
video-reel-render v="5":
    cd video/app && bun scripts/render.ts video --v {{v}} --vertical --scale 2 --samples auto --max-samples 108 --shutter 0.3 --x264 aq-mode=3:rc-lookahead=30 --crf 16 --out ../out/{{ if v == "1" { "" } else { "v" + v + "/" } }}9x16/render-4k.mp4
    video/scripts/mux.sh {{v}} 9x16
