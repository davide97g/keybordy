# keybordy MP teaser (`video/`)

A 27.4 s, 4K60 launch teaser for the keybordy MP macropad, rendered from code: three.js scenes of the real
CAD meshes, a cue sheet laid on the music's beat grid, and a soundtrack mixed in Python. The current cut is
**v5**: `out/v5/keybordy-mp-teaser-4k60.mp4` (stereo AAC + 5.1 E-AC-3) and `-1080p60.mp4`.

The same cut renders upright for Reels and Shorts (`out/v5/9x16/`, see "Reels and Shorts"). This file is the
playbook: what exists, how to drive it, what broke and what the user liked.

## Layout

| Path | What |
|---|---|
| `app/` | The renderer (TypeScript + three.js, Bun + Vite). Engine vendored from [mexicat/pdoom-video](https://github.com/mexicat/pdoom-video) (MIT, `app/LICENSE.pdoom-video`). |
| `app/src/engine/` | Engine: deterministic time → frame, adaptive motion-blur sub-frames, post (bloom, halation, CA, grain, vignette, flash, shake, zoom). |
| `app/src/stage.ts` | The shared 3D set: macropad, lights, floor, studio HDRI, thin-lens camera, editor panel, v3+ click bursts, v4+ atmosphere, v5 edge trace. |
| `app/src/model/` | `macropad.ts` (CAD meshes + procedural PCB/switches/OLED), `materials.ts` (PLA layer lines + PEI grain in the shader), `oled.ts` (1-bit panel), `clickfx.ts` (v3 3D click burst), `atmos.ts` (v4 light shaft), `trace.ts` (v5 edge light). |
| `app/src/scenes/` | One file per shot (`open`, `knob`, `oled`, `build`, `hero`, `montage`, `talk`, `title`, `credit`), `_product.ts` base, `_type.ts` type, `v2/`..`v5/` overrides. |
| `app/src/cues.ts` | Reads `data/[vN/]cues.json`; `poseAt(t)` = device state (presses, knob, OLED, mic) as a pure function. |
| `app/scripts/render.ts` | Offline render: stills, sheet, perf, video. |
| `audio/` | uv project: `cues.py` (the edit), `build.py` (music edit + mix + master + 5.1), `synth.py` (all synthesized SFX), `analyze.py` (tempo/energy map). |
| `scripts/` | `export_meshes.py` (CAD → STL), `capture_editor.ts` (keymap-editor screenshots with demo data), `fetch_vendor.sh` (re-download media), `mux.sh` (deliverables). |
| `data/[vN/]` | Committed: `cues.json`, `audio.json` per version. |
| `build/` | Generated, gitignored: `models/`, `editor/`, `[vN/]mix_stereo.wav`, `mix_51.wav`. |
| `public/vendor/` | Downloaded media, gitignored (licenses forbid redistributing raw files). `CREDITS.md` lists every file. |
| `out/` | Renders, gitignored: `out/[vN/]draft-1080.mp4`, `render-4k.mp4`, deliverables, `wip/` sheets. |

## Commands

```sh
just video-fetch            # media into public/vendor (once)
just video-meshes           # CAD → build/models (after cad/ changes)
just video-editor-shots     # keymap editor screenshots → build/editor (v2+)
just video-audio 5          # cues + mix for cut 5 (data/v5, build/v5)
just video-dev              # live preview: http://localhost:5181/?v=5 (space play, [ ] scenes, . , frame step)
just video-stills 2.8,15.1 5
just video-draft 5          # 1080p, 12 sub-frames, ~4-5 min
just video-render 5         # 4K60 adaptive (max 108 sub-frames) + mux.sh: ~66 min on this Mac
```

Ad hoc from `app/`: `bun scripts/render.ts sheet --v 5 --times 0.5,2.4,15.1 --cols 3 --out ../out/v5/wip/x.png` (contact sheet, 1 sample, seconds), `... video --v 5 --from 2.3 --to 3.6 --workers 1 --samples 12 --out ../out/v5/preview.mp4` (short motion-blurred preview).

## Versions (cuts)

Every revision the user asks for is a new version; older ones must keep rendering exactly as they were.
`?v=N` / `--v N` picks one. Per version: `data/vN/`, `build/vN/`, `out/vN/`, and `scenes/vN/<id>.ts`
overrides (newest wins, falls back to older, then `scenes/<id>.ts`). Code shared by all versions gates new
behaviour with `VERSION >= N` (`app/src/version.ts`, `audio/cues.py plan(version=)`, `audio/build.py main(version)`).

| v | What changed |
|---|---|
| 1 | First cut: 9 shots on the 120 BPM grid, keys travel 4 mm, 2D type slams. |
| 2 | Caps never move; v2 clicks were 2D sticker rings with action tags (disliked later); lime vinyl labels for the lines; the official logo-sticker lockup; keymap-editor shot (beats 34-38); smaller lens (aperture × 0.3); sampling seeded by shutter position (no shimmer). |
| 3 | No 2D click stickers: each click explodes out of its own cap in 3D (aura, shards, shockwave, point light); lime ripple on editor clicks; burst SFX. |
| 4 | Epic opening: boom flash + anamorphic streak + shake, light shaft, crash zoom into the first click (dust: disliked). |
| 5 | **Final.** v4 without dust; lime light runs round the case edge on the boom; three backlights hold a silhouette; fill fades in before the crash zoom; wider start framing. |

## How it works

- **Deterministic frames.** Everything is a pure function of `t` (and seeded hashes). No `Math.random`, no
  `performance.now`, no state carried between frames. Scenes re-pose the shared stage on every render.
- **Motion blur, AA, depth of field and soft shadows all come from sub-frames.** The engine averages
  sub-frames over the shutter (`--samples auto` steps 4→12→36→108 per tile until converged). The stage gives
  each sub-frame its own sub-pixel offset, its own point on the lens aperture (thin lens with a sheared
  frustum: the focus plane stays put) and its own point on the key light (soft shadows). v2+ seeds these
  with the sub-frame's position in the shutter (same pattern every frame), v1 with `t` (shimmered).
- **One cue sheet, two consumers.** `audio/cues.py` writes scene windows and every event (press, detent,
  land, slam, ui_click, logo, boom_open, crash, ...). The video poses and cuts from it; the mixer places every
  sound from it. Never hand-place a sound or a cut elsewhere.
- **Music edit** (Total War, AudioAtlant, Pixabay, 120 BPM): its hits sit on one grid. Our beat b is at
  `0.02 + 0.5·b` s. Intro A from its first hit (beat 0) through beat 16, faded out 18-20; B from the
  near-silent break (beat 18) so the drop lands on beat 24 (music 52.575 s) and the final hit on beat 48
  (64.575 s). Hits were found with a 25 ms loudness scan, not librosa onsets (those were ~0.3 s early on swells).
- **Mix:** real kbsim Cream switch recordings (MIT) per key row, SPACE for the 2u, Kenney CC0 ticks for
  detents, Pixabay sub boom / braam / paper; the rest synthesized. Reverb send, sidechain duck, 25 Hz HPF,
  −14 LUFS, look-ahead limiter at −1.3 dBTP on 4x oversampled peaks. 5.1 = music front + delayed rears,
  design mid in C, hall in rears, < 110 Hz in LFE. Real Dolby Atmos is not possible here (no Dolby tools).
- **Look:** black void, matte black floor, studio HDRI (Poly Haven `studio_small_09`) for reflections only,
  key spot + rect-area rim/accent strips, ACES-free: the engine's tone shoulder does the mapping. Palette:
  ground `#070608`, white `#f4f1f8`, lime `#d6ff1f` (+ `#8fb300` shadow), lavender `#b9a8ff`, Bambu green.
  Fonts from `sim/velxio/frontend/public/fonts`: Anybody (wordmark 820 / widest keyword stretch), Geist, Martian Mono.
- **Official logo:** the sticker SVG from `sim/velxio/frontend/src/components/ui/LogoSticker.tsx`, split into
  under / cap / peel images so the cap can press (`scenes/v2/_logo.ts`).

## Render gotchas (all fixed in `app/scripts/render.ts`, keep the fixes)

- **Frames go to the encoder as same-origin HTTP POSTs through Vite's proxy** (`/frame`, `VIDEO_FRAME_PORT`).
  Upstream's WebSocket hand-off never acknowledged here, and Chrome's local-network check stalls requests
  from the page to another localhost port.
- **Vite's proxy sometimes answers 502** on a reused connection: the page retries, the server ignores duplicates.
- **The private Vite picks a port nothing listens on.** A random port once hit a stale server from a killed
  render (whose `/frame` proxy pointed at a dead encoder): every POST 502'd. After killing a render, also
  `pkill -f "keybordy/video/app/node_modules/.bin/vite"`.
- **Close ffmpeg's stdin before the browsers**, and race `browser.close()` with a timeout. Otherwise the run
  finishes rendering and hangs with an unfinished mp4 ("moov atom not found"). Rescue: `kill -9` the Bun
  process (not SIGINT: its handler kills ffmpeg), and ffmpeg finalizes the file.
- The pixel-pack-buffer readback crashed the headless GPU process: export uses `readPixelsAsync`.
- In zsh, `set -- $r` does not word-split: loop over plain values.
- A 4K frame at 108 sub-frames is ~2-4 s; the 4K export is ~400 Mbit/s because of the per-pixel grain
  (1.3 GB for 27 s). Offer a lighter re-encode for sharing.

## What the user liked and didn't (apply to every new video)

- Wants previews before big renders: frame strips (`sheet`) and short motion-blurred clips, then a 1080p
  draft, then 4K. Keep running renders going; never kill one to start another unless asked.
- Every change = a new version; never delete or overwrite an older cut.
- **Liked:** keys rock-steady; click effects that come out of the 3D object itself (lime burst, shards,
  shockwave); lime fluo + the logo sticker; lime vinyl labels for short lines; the editor UI shot with real
  UI; Apple-style reveal grammar (silhouette → edge light → fill → reveal); light running along the edges;
  crash zoom into a click; a short, punchy edit under 30 s.
- **Disliked:** 2D sticker rings popping up "in between" over the 3D; keycaps moving or bouncing; doubled /
  ghosted out-of-focus text (too wide a lens, too few samples); glittery static particles (dust); the
  device too close to the frame edge.
- Inspiration given: pdoom-video's smoothness (sub-frame motion blur, deterministic frames).

## Reels and Shorts (9:16)

The upright cut is the same trailer (same edit, cue sheet and soundtrack) reframed for 1080x1920. It is a URL
flag orthogonal to the version, `?aspect=9x16` (`render.ts --vertical`), so `--v 5 --vertical` is the upright
v5 and the 16:9 cuts render exactly as before. Outputs go to `out/vN/9x16/`.

```sh
just video-reel-draft 5     # out/v5/9x16/draft-1080x1920.mp4, ~6 min
just video-reel-render 5    # 2160x3840 render + mux.sh 5 9x16: keybordy-mp-reel-{2160x3840,1080x1920}p60.mp4
# preview: http://localhost:5181/?v=5&aspect=9x16 ; sheets: render.ts sheet --v 5 --vertical (270x480 tiles)
```

- Ported from `~/personal/projects/autocratico/apps/video`: `VERTICAL` in `engine/scale.ts`; `W`/`H` and the
  `SAFE` box in `engine/gl.ts` (upright: top 240, bottom 1920 − 470, left 64, right 1080 − 160, clear of the
  Reels/Shorts UI). `stage.project()` reads `W`/`H`.
- **Framing** is one table, `scenes/_upright.ts`, keyed by scene id and applied in `ProductScene.render`:
  three.js keeps the vertical fov, so upright the frame is ~3x narrower. Each shot pulls the camera back along
  its own line of sight (`dolly`), the fog moves back with it (`Shot.fog`), and a lens shift (`Shot.shift`,
  a view offset, perspective unchanged) places the subject. The opening eases from 1.3x back to v5's macro
  during the crash zoom.
- **Type:** `UP` in `_type.ts` (centred on the frame, at most `2 × (SAFE.right − 540)` wide, `high` under
  the top bar, `low` above the caption). Labels shrink to fit (`stickerSlam` `maxW`). The lockup stacks
  upright: the logo sticker over the wordmark, the MP sticker on the logo's corner, the credit line under.
  The boom's flare streak runs through the device's projected top edge.
- Deliverables: stereo only (no 5.1 on Reels/Shorts), the v5 mix at −14 LUFS. 27.4 s fits both
  (Reels ≤ 90 s, Shorts ≤ 3 min).
- A change to the upright cut is a new version like any other: gate it `VERTICAL && VERSION >= N`.
