#!/usr/bin/env bash
# Final deliverables from the 4K render (video + stereo AAC from app/scripts/render.ts):
#   out/[vN/]keybordy-mp-teaser-4k60.mp4    the 4K60 picture, AAC 320k stereo + E-AC-3 640k 5.1 (second track)
#   out/[vN/]keybordy-mp-teaser-1080p60.mp4 a 1080p60 share copy (Lanczos downscale), AAC stereo
# Upright (Reels/Shorts, `9x16` as the second argument), from out/[vN/]9x16/render-4k.mp4, stereo only:
#   out/[vN/]9x16/keybordy-mp-reel-2160x3840p60.mp4  the 4K upright picture (YouTube Shorts takes it as is)
#   out/[vN/]9x16/keybordy-mp-reel-1080x1920p60.mp4  1080x1920 (Instagram Reels' size)
# Usage: mux.sh [version] [9x16]   (1 = the first cut, in out/ and build/; 2 = out/v2/ and build/v2/)
set -euo pipefail
cd "$(dirname "$0")/.."
v=${1:-2}
d=$([ "$v" = 1 ] && echo "" || echo "v$v/")
if [ "${2:-}" = 9x16 ]; then
  src=out/${d}9x16/render-4k.mp4
  ffmpeg -v error -y -i "$src" -map 0:v -map 0:a -c copy \
    -metadata title="keybordy MP" -movflags +faststart out/${d}9x16/keybordy-mp-reel-2160x3840p60.mp4
  ffmpeg -v error -y -i "$src" -map 0:v -map 0:a -vf "scale=1080:1920:flags=lanczos" \
    -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -tune grain \
    -color_primaries bt709 -color_trc bt709 -colorspace bt709 -c:a copy \
    -metadata title="keybordy MP" -movflags +faststart out/${d}9x16/keybordy-mp-reel-1080x1920p60.mp4
  ls -lh out/${d}9x16/keybordy-mp-reel-*.mp4
  exit 0
fi
src=out/${d}render-4k.mp4
ffmpeg -v error -y -i "$src" -i build/${d}mix_51.wav \
  -map 0:v -map 0:a -map 1:a -c:v copy -c:a:0 copy -c:a:1 eac3 -b:a:1 640k \
  -metadata:s:a:0 title="Stereo" -metadata:s:a:0 language=eng \
  -metadata:s:a:1 title="5.1" -metadata:s:a:1 language=eng \
  -disposition:a:0 default -disposition:a:1 0 \
  -metadata title="keybordy MP" -movflags +faststart out/${d}keybordy-mp-teaser-4k60.mp4
ffmpeg -v error -y -i "$src" -map 0:v -map 0:a -vf "scale=1920:1080:flags=lanczos" \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -tune grain \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -c:a copy \
  -metadata title="keybordy MP" -movflags +faststart out/${d}keybordy-mp-teaser-1080p60.mp4
ls -lh out/${d}keybordy-mp-teaser-*.mp4
