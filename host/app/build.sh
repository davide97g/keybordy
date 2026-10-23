#!/bin/sh
# Builds keybordy.app (the keymap editor for the Dock) into ~/Applications. `just host-app` runs it.
set -eu
cd "$(dirname "$0")"
out="${1:-$HOME/Applications}/keybordy.app"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

swift icon.swift "$build/icon.png"
mkdir "$build/AppIcon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$build/icon.png" --out "$build/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$build/icon.png" --out "$build/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done

app="$build/keybordy.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
iconutil -c icns "$build/AppIcon.iconset" -o "$app/Contents/Resources/AppIcon.icns"
swiftc -O -target arm64-apple-macos13 -framework Cocoa -framework WebKit Keybordy.swift -o "$app/Contents/MacOS/keybordy"
cp Info.plist "$app/Contents/Info.plist"
codesign --force --sign - "$app"

rm -rf "$out"
mkdir -p "$(dirname "$out")"
mv "$app" "$out"
echo "installed $out"
