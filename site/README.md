# site/ — the keybordy MP landing page

https://keybordy.davideghiotto.it. A Vite + three.js page: a fixed canvas behind the hero and the story
chapters renders the real device, and the scroll position flies the camera between chapter shots.

```sh
cd site && bun install
bun run dev        # http://localhost:5190
bun run build      # tsc, then vite build into dist/
bun run meshes     # after `just video-meshes`: re-quantize the CAD meshes into public/models/
```

## What's where

| file | what it holds |
| --- | --- |
| `index.html` | every section, the logo symbol and the SEO tags |
| `src/scene.ts` | the 3D stage: KBM mesh loader, lights, bloom, chapter shots, presses, OLED states |
| `src/main.ts` | scroll → shot mapping, reveals, nav, magnetic buttons, OLED tiles, 2D keymap, trailer player |
| `src/keymap.ts` | the example keymap, action types and the keyboard → K mapping |
| `src/sound.ts` | synthesized key clicks (off until the visitor turns them on) |
| `scripts/meshes.ts` | STL → KBM1 (welded, 16-bit quantized, indexed): ~1.4 MB gzipped instead of 12 MB |
| `public/media/` | the v5 teaser re-encoded for the web, 16:9 and 9:16, plus posters |

## Things worth knowing

- **The model is the teaser's.** `@model/*` is `video/app/src/model`: the page swaps in its own mesh
  loader through `meshSource` and relabels the caps with their K numbers (the real legends). A change
  there shows up in both, so keep older video cuts rendering when you touch it.
- **A sanitizing pass sits before the bloom.** A single NaN pixel from the printed-PLA shader otherwise
  smears black over the frame through the blur chain.
- **The trailer is not on YouTube yet.** Set `YT_TRAILER` in `src/main.ts` once it is: the trailer
  buttons then link to the video instead of the channel's subscribe page.
- **No WebGL** falls back to the trailer poster in the hero and hides the story chapters.
- Reduced motion: no intro flight, no idle sway, reveals show their end state.

## Deploying

Dokploy project `keybordy` on the homelab, compose service `keybordy-site` building
`site/compose.yml` from GitHub (`davide97g/keybordy`). The build context is the repo root, trimmed
by `Dockerfile.dockerignore`. The domain is `keybordy.davideghiotto.it` → service `keybordy-site`,
port 80, HTTPS off, no certificate, behind the Cloudflare tunnel (see `~/personal/projects/homelab`).
`autoDeploy` is off: redeploy with `compose.deploy` after pushing.
