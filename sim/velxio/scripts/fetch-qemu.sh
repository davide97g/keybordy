#!/usr/bin/env bash
# Copy the ESP32 QEMU runtime into prebuilt/qemu/ for the Docker build.
#
# The files come out of a pinned upstream Velxio image (arm64), which ships
# them in /app/lib. libqemu-xtensa.so / libqemu-riscv32.so are builds of the
# lcgamboa QEMU fork (GPL); the *.bin files are Espressif's ESP32 boot ROMs.
# Neither is kept in git (see .gitignore). The alternative is building QEMU
# yourself, see upstream docs/BUILD-QEMU.md.
#
# Files already present are left alone. Usage: scripts/fetch-qemu.sh
set -euo pipefail

IMAGE="ghcr.io/davidmonterocrespo24/velxio@sha256:a3c6f7accc3e0ee330bd86a4aa1b76cf3e678a27838bc0d557f44f4c72c8cf7e"
FILES=(
  libqemu-xtensa.so
  libqemu-riscv32.so
  esp32-v3-rom.bin
  esp32-v3-rom-app.bin
  esp32c3-rom.bin
  esp32s3_rev0_rom.bin
)

dest="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/prebuilt/qemu"
mkdir -p "$dest"

missing=()
for f in "${FILES[@]}"; do
  if [ -s "$dest/$f" ]; then
    echo "have  $f"
  else
    missing+=("$f")
  fi
done
if [ "${#missing[@]}" -eq 0 ]; then
  echo "prebuilt/qemu/ is complete."
  exit 0
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Pulling $IMAGE ..."
  docker pull --platform linux/arm64 "$IMAGE"
fi

container="$(docker create --platform linux/arm64 "$IMAGE")"
trap 'docker rm "$container" >/dev/null' EXIT

for f in "${missing[@]}"; do
  echo "copy  $f"
  docker cp "$container:/app/lib/$f" "$dest/$f"
done

echo "prebuilt/qemu/ is complete."
