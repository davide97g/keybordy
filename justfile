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

# ── Simulator ───────────────────────────────────────────────────────────────

# Once: QEMU .so + ESP32 ROMs into sim/velxio/prebuilt/qemu/
sim-fetch-qemu:
    sim/velxio/scripts/fetch-qemu.sh

# Build and start the simulator + Postgres (http://localhost:3080/editor?project=keys8)
sim-up:
    {{compose}} up -d --build --wait

sim-down:
    {{compose}} down

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

# ── Wiring guide ────────────────────────────────────────────────────────────

[working-directory: 'guide']
guide-dev:
    bun run dev

[working-directory: 'guide']
guide-build:
    bun run build
