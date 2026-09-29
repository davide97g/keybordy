#!/bin/bash
set -e

# Ensure arduino-cli config and board manager URLs are set up
if [ ! -f /root/.arduino15/arduino-cli.yaml ]; then
    echo "📦 Initializing arduino-cli config..."
    arduino-cli config init 2>/dev/null || true
    arduino-cli config add board_manager.additional_urls \
        https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json 2>/dev/null || true
    arduino-cli config add board_manager.additional_urls \
        https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json 2>/dev/null || true
    # ATTinyCore (Spence Konde) — needed for ATtiny85 FQBNs.
    # Without this URL `core install ATTinyCore:avr` fails with
    #   "Platform 'ATTinyCore:avr' not found: platform not installed".
    # See https://github.com/SpenceKonde/ATTinyCore
    arduino-cli config add board_manager.additional_urls \
        http://drazzy.com/package_drazzy.com_index.json 2>/dev/null || true
fi

# Seed board-manager indexes vendored into the image (issue #254).
# A /root/.arduino15 volume created by an older image can lack an index
# file that the config references; arduino-cli then fails instance init
# outright, which breaks EVERY compile — not just the boards from that
# index. A stale index is harmless, a missing one is fatal, so copy any
# vendored index the volume does not already have. `core update-index`
# below still refreshes whatever is reachable.
if [ -d /opt/arduino15-seed ]; then
    for seed in /opt/arduino15-seed/package_*.json; do
        [ -f "$seed" ] || continue
        dest="/root/.arduino15/$(basename "$seed")"
        if [ ! -f "$dest" ]; then
            echo "Seeding board index $(basename "$seed") (missing from volume)"
            cp "$seed" "$dest"
        fi
    done
fi

# Install missing cores. They persist in the /root/.arduino15 volume, so a
# normal boot skips the network entirely. A core that failed to install
# (ATTinyCore has no arm64 Linux tools) is remembered and not retried;
# VELXIO_REFRESH_CORES=1 refreshes the index and retries everything.
# ESP32 builds use ESP-IDF 5.5.4 + arduino-esp32 3.3.10; the arduino-cli 3.x
# core below is only the fallback when ESP-IDF is absent.
core_failed_marker=/root/.arduino15/.velxio-core-install-failed
if [ "${VELXIO_REFRESH_CORES:-0}" = 1 ]; then
    rm -f "$core_failed_marker"
fi
installed_cores=$(arduino-cli core list 2>/dev/null || true)
missing_cores=()
for core in arduino:avr rp2040:rp2040 ATTinyCore:avr@1.4.1; do
    id=${core%@*}
    grep -q "^${id} " <<<"$installed_cores" && continue
    grep -qxF "$core" "$core_failed_marker" 2>/dev/null && continue
    missing_cores+=("$core")
done
if [ ${#missing_cores[@]} -gt 0 ] || [ "${VELXIO_REFRESH_CORES:-0}" = 1 ]; then
    echo "📦 Installing arduino-cli cores: ${missing_cores[*]:-(index refresh only)}"
    arduino-cli core update-index 2>/dev/null || true
    for core in "${missing_cores[@]}"; do
        arduino-cli core install "$core" 2>/dev/null || echo "$core" >> "$core_failed_marker"
    done
fi

# ESP32 compilation now uses ESP-IDF instead of arduino-cli.
# arduino-cli ESP32 core is no longer needed for QEMU-compatible builds.
# If ESP-IDF is not available, fall back to arduino-cli ESP32 core.
if [ -f /opt/esp-idf/export.sh ]; then
    echo "🔧 Sourcing ESP-IDF environment..."
    . /opt/esp-idf/export.sh || true
    echo "✅ ESP-IDF $(cat /opt/esp-idf/version.txt 2>/dev/null || echo 'unknown') ready"
else
    echo "⚠️  ESP-IDF not found — falling back to arduino-cli for ESP32"
    # 3.x core (IDF 5.5 based), matching the arduino-esp32 3.3.10 the image
    # builds with under ESP-IDF; 3.3.9 is the newest 3.3.x the board manager
    # index carries. Sketches written for the 3.x core use 3.x-only APIs.
    ESP32_CORE_VERSION=3.3.9
    ESP32_VER=$(arduino-cli core list 2>/dev/null | grep esp32:esp32 | awk '{print $2}')
    if [ -z "$ESP32_VER" ]; then
        echo "Installing ESP32 core ${ESP32_CORE_VERSION}..."
        arduino-cli core install esp32:esp32@${ESP32_CORE_VERSION}
    elif [[ "$ESP32_VER" != ${ESP32_CORE_VERSION} ]]; then
        echo "ESP32 core is $ESP32_VER, need ${ESP32_CORE_VERSION} - reinstalling..."
        arduino-cli core install esp32:esp32@${ESP32_CORE_VERSION}
    fi
fi

# Apply database migrations. A failure leaves the simulator usable: the
# project API answers 503 and the editor keeps edits in the browser.
if [ -n "${DATABASE_URL:-}" ]; then
    echo "🗄️  Applying database migrations..."
    migrated=0
    for _ in $(seq 1 15); do
        if (cd /app && /app/.venv/bin/alembic -c /app/alembic.ini upgrade head); then
            migrated=1
            break
        fi
        sleep 2
    done
    if [ "$migrated" != 1 ]; then
        echo "❌ Database migrations FAILED — the project store is unavailable"
    fi
fi

# Start FastAPI backend in the background on port 8001. By absolute path:
# export.sh above put IDF's python env first on PATH. UVICORN_RELOAD=1 (the
# dev compose override) restarts it when the bind-mounted app/ changes.
echo "🚀 Starting Velxio Backend..."
cd /app
reload_args=()
if [ "${UVICORN_RELOAD:-0}" = 1 ]; then
    reload_args=(--reload --reload-dir /app/app)
fi
/app/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001 "${reload_args[@]}" &
UVICORN_PID=$!

# Wait for the backend to answer before starting nginx
for _ in $(seq 1 30); do
    curl -sf http://127.0.0.1:8001/health >/dev/null && break
    sleep 1
done

# Start Nginx in the background (not exec — we need to monitor both)
echo "🌐 Starting Nginx Web Server on port 80..."
nginx -g "daemon off;" &
NGINX_PID=$!

# Exit as soon as either process dies so Docker can restart the container.
# wait -n requires bash 4.3+ (standard on Debian Bullseye / Ubuntu 20.04+).
wait -n $UVICORN_PID $NGINX_PID
EXIT_CODE=$?

echo "⚠️  A process exited (code $EXIT_CODE) — shutting down container"
kill $UVICORN_PID $NGINX_PID 2>/dev/null || true
wait $UVICORN_PID $NGINX_PID 2>/dev/null || true
exit $EXIT_CODE
