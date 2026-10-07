#!/usr/bin/env bash
# Re-download the third-party media in video/public/vendor/ (gitignored).
# Every file, its author and its license are listed in video/CREDITS.md.
#
#   video/scripts/fetch_vendor.sh            # fetch into video/public/vendor
#   video/scripts/fetch_vendor.sh DIR        # fetch into DIR instead
#   FORCE=1 video/scripts/fetch_vendor.sh    # re-download files that already exist
#
# Only audio/image files are fetched (plus two license texts). Nothing downloaded
# is ever executed. Kenney packs only ship as zips: the zip goes to a temp dir and
# only the listed .ogg files are extracted from it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${1:-$here/../public/vendor}"
mkdir -p "$dest"
dest="$(cd "$dest" && pwd)"

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() { # fetch <relative path> <url>
  local out="$dest/$1"
  if [[ -s "$out" && -z "${FORCE:-}" ]]; then return; fi
  mkdir -p "$(dirname "$out")"
  curl -fsSL --retry 3 -A "$UA" -o "$out.part" "$2"
  mv "$out.part" "$out"
  echo "fetched $1"
}

kenney() { # kenney <zip url> <member path in zip> <relative output path>
  local out="$dest/$3"
  if [[ -s "$out" && -z "${FORCE:-}" ]]; then return; fi
  local zip="$tmp/$(basename "$1")"
  [[ -s "$zip" ]] || curl -fsSL --retry 3 -A "$UA" -o "$zip" "$1"
  mkdir -p "$(dirname "$out")"
  unzip -p "$zip" "$2" > "$out.part"
  mv "$out.part" "$out"
  echo "fetched $3"
}

PB=https://cdn.pixabay.com/download/audio

# --- music (Pixabay Content License) ----------------------------------------
fetch music/audioatlant-total-war-epic-action-cinematic-trailer-main-513668.mp3 \
  "$PB/2026/04/10/audio_8470cb423f.mp3?filename=audioatlant-total-war-epic-action-cinematic-trailer-main-513668.mp3"
fetch music/epic-hollywood-trailer-9489.mp3 \
  "$PB/2021/10/15/audio_2320f2b0bc.mp3?filename=epic-hollywood-trailer-9489.mp3"
fetch music/kulakovka-epic-trailer-277924.mp3 \
  "$PB/2024/12/18/audio_deb1acb832.mp3?filename=kulakovka-epic-trailer-277924.mp3"

# --- key clicks: kbsim by Thomas Lai (MIT), pinned commit ---------------------
KB=https://raw.githubusercontent.com/tplai/kbsim/ba103f3b0afa9dab80447aa2e7e2ed80b6bd80e4
fetch clicks/kbsim-LICENSE.txt "$KB/LICENSE.md"
for sw in holypanda cream mxbrown; do
  for f in press/GENERIC_R0 press/GENERIC_R1 press/GENERIC_R2 press/GENERIC_R3 press/GENERIC_R4 \
           press/SPACE press/ENTER release/GENERIC release/SPACE; do
    fetch "clicks/kbsim-$sw/$f.mp3" "$KB/src/assets/audio/$sw/$f.mp3"
  done
done

# --- long keyboard recording + ratchets (Pixabay Content License) -------------
fetch clicks/mechanical-keyboard-sounds-gaming-on-a-keyboard-17149.mp3 \
  "$PB/2022/02/07/audio_7e77288571.mp3?filename=mechanical-keyboard-sounds-gaming-on-a-keyboard-17149.mp3"
fetch clicks/knob/rachet-click-47834.mp3 \
  "$PB/2022/03/10/audio_dd77c0b450.mp3?filename=rachet-click-47834.mp3"
fetch clicks/knob/freesound_community-ratchet-88147.mp3 \
  "$PB/2022/03/15/audio_53a0579ebe.mp3?filename=freesound_community-ratchet-88147.mp3"

# --- knob detent ticks: Kenney UI Audio (CC0) ---------------------------------
UI_ZIP=https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip
for f in switch13 switch14 click4 click5 switch19; do
  kenney "$UI_ZIP" "Audio/$f.ogg" "clicks/knob/kenney-ui-$f.ogg"
done

# --- sfx (Pixabay Content License) -------------------------------------------
fetch sfx/ascent-sub-boom-cinematic-trailer-sound-effect-222265.mp3 \
  "$PB/2024/07/05/audio_8110b93280.mp3?filename=ascent-sub-boom-cinematic-trailer-sound-effect-222265.mp3"
fetch sfx/descent-sub-boom-massive-cinematic-sound-effect-405929.mp3 \
  "$PB/2025/09/17/audio_446287d8a4.mp3?filename=descent-sub-boom-massive-cinematic-sound-effect-405929.mp3"
fetch sfx/ascent-braam-magma-brass-d-cinematic-trailer-sound-effect-222269.mp3 \
  "$PB/2024/07/05/audio_923e4d8360.mp3?filename=ascent-braam-magma-brass-d-cinematic-trailer-sound-effect-222269.mp3"
fetch sfx/deep-braam-trailer-228761.mp3 \
  "$PB/2024/07/31/audio_f457629235.mp3?filename=deep-braam-trailer-228761.mp3"
fetch sfx/ascent-riser-cover-the-basics-cinematic-trailer-sound-effect-222278.mp3 \
  "$PB/2024/07/05/audio_c346b5df7f.mp3?filename=ascent-riser-cover-the-basics-cinematic-trailer-sound-effect-222278.mp3"
fetch sfx/descent-riser-cinematic-sound-effect-405926.mp3 \
  "$PB/2025/09/17/audio_d0a4787ba8.mp3?filename=descent-riser-cinematic-sound-effect-405926.mp3"
fetch sfx/ascent-whoosh-cinematic-sound-effect-222266.mp3 \
  "$PB/2024/07/05/audio_5add671d21.mp3?filename=ascent-whoosh-cinematic-sound-effect-222266.mp3"
fetch sfx/universfield-boom-swoosh-454825.mp3 \
  "$PB/2025/12/21/audio_32bcdab697.mp3?filename=universfield-boom-swoosh-454825.mp3"
fetch sfx/oxidvideos-paper-slide-short-478835.mp3 \
  "$PB/2026/02/03/audio_5d6c980794.mp3?filename=oxidvideos-paper-slide-short-478835.mp3"
fetch sfx/floraphonic-cartoon-slap-2-189831.mp3 \
  "$PB/2024/02/06/audio_a35aec4cb2.mp3?filename=floraphonic-cartoon-slap-2-189831.mp3"
fetch sfx/freesound_community-paper-fold-31416.mp3 \
  "$PB/2022/03/10/audio_8456e4327d.mp3?filename=freesound_community-paper-fold-31416.mp3"
fetch sfx/beep-125033.mp3 \
  "$PB/2022/11/04/audio_9ff1118f72.mp3?filename=beep-125033.mp3"

# --- digital chirps: Kenney Interface Sounds (CC0) ----------------------------
IF_ZIP=https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip
for f in confirmation_001 confirmation_002 select_001; do
  kenney "$IF_ZIP" "Audio/$f.ogg" "sfx/kenney-$f.ogg"
done

# --- HDRI: Poly Haven (CC0) --------------------------------------------------
fetch hdri/studio_small_09_2k.hdr \
  https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/studio_small_09_2k.hdr

# Sanity check: every audio file must decode as audio (catches HTML error pages).
if command -v ffprobe >/dev/null; then
  bad=0
  while IFS= read -r -d '' f; do
    if ! ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$f" | grep -q audio; then
      echo "NOT AUDIO: $f" >&2; bad=1
    fi
  done < <(find "$dest" -type f \( -name '*.mp3' -o -name '*.ogg' -o -name '*.wav' \) -print0)
  [[ $bad == 0 ]] || exit 1
fi
head -c 10 "$dest/hdri/studio_small_09_2k.hdr" | grep -q '#?RADIANCE' || { echo "HDRI is not a Radiance file" >&2; exit 1; }
echo "vendor media OK in $dest"
