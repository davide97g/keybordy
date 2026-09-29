# ---- Stage 0: QEMU .so + ROM binaries ----
# ESP32 emulation needs libqemu-xtensa.so + libqemu-riscv32.so (QEMU built as
# a shared library, simulating ESP32 / ESP32-S3 / ESP32-C3) plus the matching
# boot ROM blobs. They are not in git: run scripts/fetch-qemu.sh once to copy
# them into prebuilt/qemu/ (or build QEMU yourself, see upstream
# docs/BUILD-QEMU.md). Nothing is downloaded here.
FROM ubuntu:22.04 AS qemu-provider

COPY prebuilt/qemu/ /qemu/

RUN cd /qemu && missing="" \
 && for f in libqemu-xtensa.so libqemu-riscv32.so esp32-v3-rom.bin \
             esp32-v3-rom-app.bin esp32c3-rom.bin esp32s3_rev0_rom.bin; do \
      [ -s "$f" ] || missing="$missing $f" ; \
    done \
 && if [ -n "$missing" ]; then \
      echo "" ; \
      echo "ERROR: prebuilt/qemu/ is missing:$missing" ; \
      echo "Run scripts/fetch-qemu.sh (from sim/velxio) to copy the QEMU runtime" ; \
      echo "into prebuilt/qemu/, then rebuild." ; \
      echo "" ; \
      exit 1 ; \
    fi \
 && ls -lh /qemu/


# ---- Stage 0.5: ESP-IDF toolchain for ESP32 compilation ----
FROM ubuntu:22.04 AS espidf-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git wget flex bison gperf python3 python3-pip python3-venv \
    cmake ninja-build ccache libffi-dev libssl-dev \
    libusb-1.0-0 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ESP-IDF v5.5.4 + arduino-esp32 3.3.10. espidf_compiler discovers them at /opt/esp-idf-v5 and
# /opt/arduino-esp32-3 (overridable via IDF5_PATH / ARDUINO_ESP32_5_PATH) and
# routes every ESP32-family Arduino build through them (_use_idf5).
#
# History: until 2026-08 this stage pinned IDF 4.4.7 + core 2.0.17 because
# the original qemu-8.1.3 WiFi shim crashed on IDF 5.x cache handling. The
# current libqemu builds run IDF 5.x firmware, and 3.x-only APIs
# (ledcAttach, esp_now_recv_info_t, the esp_task_wdt config API, ...) need the
# 3.x core.
RUN git clone -b v5.5.4 --recursive --depth=1 --shallow-submodules \
    https://github.com/espressif/esp-idf.git /opt/esp-idf-v5

WORKDIR /opt/esp-idf-v5

# Every family toolchain. Classic-ESP32 builds need the v5.5 xtensa toolchain
# too: with only the RISC-V targets installed they silently pick whatever GCC
# is on PATH and die mid-build on newlib header mismatches.
RUN ./install.sh esp32,esp32s3,esp32c3,esp32c6

# Clean up large unnecessary files to reduce image size
RUN rm -rf .git docs examples \
    && find /root/.espressif -name '*.tar.*' -delete 2>/dev/null || true

# Arduino-as-component (3.x core, IDF 5.5 based) for full Arduino API support
RUN git clone --branch 3.3.10 --depth=1 --recursive --shallow-submodules \
    https://github.com/espressif/arduino-esp32.git /opt/arduino-esp32-3 \
 && rm -rf /opt/arduino-esp32-3/.git

# mkspiffs (arduino-esp32 0.2.3 flavor) — bakes uploaded files into the SPIFFS
# data-partition image at compile time. Without it espidf_compiler._build_spiffs_image
# silently returns None and ships a blank SPIFFS region, so SPIFFS.begin() fails and
# auto-formats and user-uploaded files never appear (GH #162). Installed at the exact
# path the runtime locates via IDF_TOOLS_PATH (tools/mkspiffs/*/mkspiffs/mkspiffs).
RUN mkdir -p /root/.espressif/tools/mkspiffs/0.2.3/mkspiffs \
 && wget -qO /tmp/mkspiffs.tgz \
      https://github.com/igrr/mkspiffs/releases/download/0.2.3/mkspiffs-0.2.3-arduino-esp32-linux64.tar.gz \
 && tar -xzf /tmp/mkspiffs.tgz -C /tmp \
 && cp /tmp/mkspiffs-0.2.3-arduino-esp32-linux64/mkspiffs \
       /root/.espressif/tools/mkspiffs/0.2.3/mkspiffs/mkspiffs \
 && chmod +x /root/.espressif/tools/mkspiffs/0.2.3/mkspiffs/mkspiffs \
 && rm -rf /tmp/mkspiffs.tgz /tmp/mkspiffs-0.2.3-arduino-esp32-linux64


# ---- Stage 1: Build frontend and third-party ----
FROM node:20 AS frontend-builder

WORKDIR /app

# avr8js, rp2040js and @wokwi/elements are pulled directly from the npm
# registry (see frontend/package.json) — no upstream git clones needed.
# Board SVGs live in frontend/public/boards/, component SVGs in
# frontend/public/component-svgs/, and components-metadata.json is committed.
# Dependencies first, sources second: a UI-only edit then reuses the cached
# npm install layer instead of reinstalling ~1 GB of node_modules.
# (postinstall runs frontend/scripts/copy-monaco.mjs, so that folder comes
# along with package.json.)
COPY frontend/package.json frontend/
COPY frontend/scripts/ frontend/scripts/
WORKDIR /app/frontend
# Lock files aren't committed in this repo (they're gitignored) — see the
# note in .gitignore. The `rm -f` below is defense-in-depth in case
# someone runs `docker build .` from a tree where a local lock exists.
RUN rm -f package-lock.json \
 && npm install --include=optional
WORKDIR /app
COPY frontend/ frontend/
COPY scripts/ scripts/
WORKDIR /app/frontend
RUN rm -f package-lock.json && npm run build:docker


# ---- Stage 2: Final Production Image ----
FROM python:3.12-slim

# Install system dependencies and nginx.
#
# libglib2.0-0, libgcrypt20, libslirp0, libpixman-1-0 and libfdt1 are runtime
# deps of libqemu-xtensa.so / libqemu-riscv32.so (the ESP32 emulators);
# without them every ESP32 simulation fails to load.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    nginx \
    libglib2.0-0 \
    libgcrypt20 \
    libslirp0 \
    libpixman-1-0 \
    libfdt1 \
    cmake \
    ninja-build \
    libusb-1.0-0 \
    git \
    ccache \
    sdcc \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir packaging

# Install arduino-cli into /usr/local/bin directly (avoids touching /bin)
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
    | BINDIR=/usr/local/bin sh

# ---- WASI-SDK: the custom-chip compiler ----
# POST /api/compile-chip/ shells out to clang from the WASI-SDK (see
# app/services/chip_compile.py, which looks in /opt/wasi-sdk first). Without
# it the route reports available:false and the Compile button in the custom
# chip designer cannot work, so the image has to ship the toolchain.
#
# Only amd64 has an official wasi-sdk 22 Linux tarball. On any other arch the
# download is skipped rather than failing the build: the rest of the image is
# fine and the chip compiler degrades to the same available:false it had
# before, with the reason printed in the build log.
ARG WASI_SDK_VERSION=22
ARG WASI_SDK_RELEASE=22.0
# sha256 of wasi-sdk-22.0-linux.tar.gz as published on the GitHub release.
# Bump it together with the version: a mismatch fails the build on purpose.
ARG WASI_SDK_SHA256=fa46b8f1b5170b0fecc0daf467c39f44a6d326b80ced383ec4586a50bc38d7b8
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    if [ "$arch" = "amd64" ]; then \
      url="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_RELEASE}-linux.tar.gz"; \
      echo "[wasi-sdk] downloading $url"; \
      curl -fSL -o /tmp/wasi-sdk.tar.gz "$url"; \
      echo "${WASI_SDK_SHA256}  /tmp/wasi-sdk.tar.gz" | sha256sum -c -; \
      tar -xzf /tmp/wasi-sdk.tar.gz -C /opt; \
      mv "/opt/wasi-sdk-${WASI_SDK_RELEASE}" /opt/wasi-sdk; \
      rm -f /tmp/wasi-sdk.tar.gz; \
      /opt/wasi-sdk/bin/clang --version; \
    else \
      echo "[wasi-sdk] no official wasi-sdk ${WASI_SDK_VERSION} build for $arch - custom chip compilation will report available:false"; \
    fi

# Only install arduino-cli binary here. Core installation (arduino:avr,
# rp2040:rp2040) is done at first boot by entrypoint.sh and persisted
# in the mounted /root/.arduino15 volume.
# ESP32 compilation uses ESP-IDF instead of arduino-cli.

# Vendored board-manager index seeds (issue #254): entrypoint.sh copies any
# of these missing from /root/.arduino15 at boot, so a flaky index host
# (drazzy.com) or a stale pre-existing volume cannot brick compilation.
# See backend/board-indexes/README.md.
COPY backend/board-indexes/package_*.json /opt/arduino15-seed/

WORKDIR /app

# Install Python backend dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend application code
COPY backend/app/ ./app/

# The custom-chip SDK header. chip_compile.py passes this directory to clang
# as -I, and reports available:false without it, so a chip that includes
# velxio-chip.h cannot compile on an image that leaves it out.
COPY backend/sdk/ ./sdk/

# Setup Nginx configuration. Remove Debian's stock site so it doesn't shadow
# ours as the default_server (was Issue #108: users behind reverse proxies got
# the "Welcome to nginx" page because the stock site claimed default_server).
RUN rm -f /etc/nginx/sites-enabled/default
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Copy and configure entrypoint script (fix Windows CRLF → LF)
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# ── ESP32 emulation: pre-built QEMU .so + ROM binaries ──────────────────────
# From the qemu-provider stage (prebuilt/qemu/, filled by scripts/fetch-qemu.sh)
# libqemu-xtensa.so    → ESP32 / ESP32-S3 (Xtensa LX6/LX7)
# libqemu-riscv32.so   → ESP32-C3 (RISC-V RV32IMC)
# esp32-v3-rom*.bin    → boot/app ROM images required by esp32-picsimlab machine
# esp32c3-rom.bin      → ROM image required by esp32c3-picsimlab machine
# esp32s3_rev0_rom.bin → ROM image required by esp32s3-picsimlab machine
# NOTE: ROM files must live in the same directory as the .so (worker passes -L
#       to QEMU pointing at os.path.dirname(lib_path))
RUN mkdir -p /app/lib
COPY --from=qemu-provider /qemu/ /app/lib/

# Activate ESP32 emulation
# QEMU_ESP32_LIB    → Xtensa library (ESP32, ESP32-S3)
# QEMU_RISCV32_LIB  → RISC-V library (ESP32-C3 and variants)
ENV QEMU_ESP32_LIB=/app/lib/libqemu-xtensa.so
ENV QEMU_RISCV32_LIB=/app/lib/libqemu-riscv32.so

# ── ESP-IDF toolchain for ESP32 compilation ──────────────────────────────────
# Copied from espidf-builder stage: IDF framework + cross-compiler toolchains
COPY --from=espidf-builder /opt/esp-idf-v5 /opt/esp-idf-v5
COPY --from=espidf-builder /root/.espressif /root/.espressif
COPY --from=espidf-builder /opt/arduino-esp32-3 /opt/arduino-esp32-3

# Legacy-path symlinks: espidf_compiler hardcodes /opt/esp-idf (version
# signature, IDF_PATH default) and /opt/arduino-esp32, and the entrypoint
# sources /opt/esp-idf/export.sh. Pointing both at the v5 trees keeps every
# read site working; the compiler still discovers the v5 install through
# /opt/esp-idf-v5 and /opt/arduino-esp32-3.
RUN ln -sn /opt/esp-idf-v5 /opt/esp-idf \
 && ln -sn /opt/arduino-esp32-3 /opt/arduino-esp32

# Memoize ldgen. It re-parses every component's linker.lf with pyparsing on
# EVERY build - measured at 15.2 s here, 41% of a whole ESP-IDF compile of a
# one-file sketch - and its output is a pure function of its inputs. The
# wrapper delegates to the untouched upstream script on a miss.
COPY backend/scripts/ldgen_cache.py /tmp/ldgen_cache.py
RUN if [ -f /opt/esp-idf/tools/ldgen/ldgen.py ]; then \
      mv /opt/esp-idf/tools/ldgen/ldgen.py /opt/esp-idf/tools/ldgen/ldgen_upstream.py && \
      cp /tmp/ldgen_cache.py /opt/esp-idf/tools/ldgen/ldgen.py && \
      chmod +x /opt/esp-idf/tools/ldgen/ldgen.py; \
    fi; rm -f /tmp/ldgen_cache.py

ENV IDF_PATH=/opt/esp-idf
ENV IDF_TOOLS_PATH=/root/.espressif
ENV ARDUINO_ESP32_PATH=/opt/arduino-esp32

# ── ccache for ESP-IDF compiles ──────────────────────────────────────────────
# ESP-IDF's build system honours IDF_CCACHE_ENABLE=1 and routes every C/C++
# compile through ccache. Cold first compile per container is unchanged
# (cache is empty), but the second and subsequent compiles drop from
# ~5-7 minutes to ~30-60 seconds because every ESP-IDF base object
# (FreeRTOS, lwIP, esp_wifi, libsodium, …) hits the cache.
#
# Cache lives at /var/cache/ccache. Mount as a docker volume in
# docker-compose.yml so the cache survives `docker compose up -d --build`.
# Without the volume, the cache rebuilds itself on first compile after each
# image rebuild — still better than no cache.
ENV CCACHE_DIR=/var/cache/ccache
ENV IDF_CCACHE_ENABLE=1
# CCACHE_BASEDIR makes ccache treat absolute paths under this prefix as
# relative when computing the cache key. Combined with the persistent
# /var/lib/velxio-build/<target>/ build dir, this lets ccache hit across
# compiles even though some flags (-I, -fmacro-prefix-map) embed absolute
# paths into the command line.
ENV CCACHE_BASEDIR=/var/lib/velxio-build
# hash_dir=false. ESP-IDF compiles with -ggdb, and for debug builds ccache
# folds the cwd into every cache key by default; CCACHE_BASEDIR does NOT
# exempt it (verified with CCACHE_DEBUG on ccache 4.11: "Hashing CWD
# /var/lib/velxio-build/esp32s3/v_<hash>/project/build"). Since each build
# variant lives in its own dir, every variant had a private key space and a
# cold variant of an already-built board recompiled all ~2100 IDF objects
# from scratch — on a busy box that overran the 600s ninja timeout. With
# hash_dir off, variants of the same board/sdkconfig share objects. The
# only difference is DW_AT_comp_dir inside .debug_info of a reused object,
# which never reaches the flashed .bin.
ENV CCACHE_NOHASHDIR=1
# Cache cap + compression set as env vars (rather than via `ccache
# --set-config` at image-build time) because $CCACHE_DIR is a docker volume:
# anything written into /var/cache/ccache during the RUN step is masked at
# runtime by the volume mount. ccache reads CCACHE_MAXSIZE / CCACHE_COMPRESS
# / CCACHE_COMPRESSLEVEL on every invocation and they override any conf-file
# value, so the cap actually applies at runtime.
ENV CCACHE_MAXSIZE=20G
ENV CCACHE_COMPRESS=1
ENV CCACHE_COMPRESSLEVEL=6
RUN mkdir -p /var/cache/ccache /var/lib/velxio-build /root/Arduino

# ── Persistent paths ────────────────────────────────────────────────────────
# Declaring these as VOLUMEs means `docker run` (without explicit -v) creates
# anonymous volumes for them — they survive `docker stop`/`docker start` and
# even `docker rm`. Without this, every container restart wipes the ccache
# and persistent ESP-IDF build dir, so every compile is cold (~5-7 min on
# modest hardware) instead of the warm-cache 5-30s.
#
# Users SHOULD pass `-v velxio-X:/path` for each of these to get named
# volumes (easier to inspect / back up than anonymous ones), but the
# anonymous default is a sensible fallback.
#
# /root/.arduino15     — arduino-cli config + installed cores
# /root/Arduino        — Library Manager-installed Arduino libraries
# /var/cache/ccache    — ccache cache (ESP-IDF compiles)
# /var/lib/velxio-build — persistent ESP-IDF build dir (one subdir per target)
VOLUME ["/root/.arduino15", "/root/Arduino", "/var/cache/ccache", "/var/lib/velxio-build"]

# Recreate the IDF v5.5 Python env with THIS stage's python. The
# espidf-builder created it with its own python (3.10) and a venv's
# site-packages are version-scoped, so the copied env cannot even import
# `packaging` here; IDF's cmake also derives the env dir name from the
# RUNNING python (idf5.5_py3.12_env) and fails with "python doesn't exist"
# when it is missing. Every ESP32-family compile routes through the v5
# tree, so a broken v5 env means no ESP32 compiles at all.
RUN rm -rf /root/.espressif/python_env/idf5.5_* \
 && rm -f /root/.espressif/espidf.constraints.v5.5.txt \
 && cd /opt/esp-idf-v5 \
 && ./tools/idf_tools.py install-python-env \
 # The v5.5.4 snapshot is internally inconsistent: its cmake hardcodes
 # component-manager interface_version 4 (project.cmake:64) while its
 # requirements pin idf-component-manager~=2.2, whose CLI tops out at
 # interface 3. Interface 4 lives in the 3.x line — install it and relax
 # both pins so the cmake python dependency check accepts the pairing.
 && /root/.espressif/python_env/idf5.5_*/bin/pip install "idf-component-manager>=3.1,<4" \
 && sed -i 's/^idf-component-manager.*/idf-component-manager>=2.2,<4/' \
      /root/.espressif/espidf.constraints.v5.5.txt \
      /opt/esp-idf-v5/tools/requirements/requirements.core.txt \
 && find /root/.espressif -name '*.tar.*' -delete 2>/dev/null || true

# System-python IDF deps. IDF 5.x has no root requirements.txt (the 4.4
# tree did); its equivalent is tools/requirements/requirements.core.txt.
RUN pip install --no-cache-dir -r /opt/esp-idf-v5/tools/requirements/requirements.core.txt

# Built frontend assets, copied LAST: every layer above (QEMU, the ESP-IDF
# trees, the pip installs) stays cached when only the UI changes.
COPY --from=frontend-builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

CMD ["/app/entrypoint.sh"]
