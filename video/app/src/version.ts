// Which cut of the teaser to render, read once from the page URL (`?v=2`). Each version keeps its own cue
// sheet, soundtrack and scene overrides, so an older cut always renders as it was:
//   v1  the first cut (data/cues.json, build/mix_*.wav, scenes/*.ts)
//   v2  steady caps, clicks marked by sticker bursts, the official logo sticker, more lime
//       (data/v2/cues.json, build/v2/mix_*.wav, scenes/v2/*.ts over scenes/*.ts)
//   v3  v2 without the 2D click stickers: each click goes off in 3D out of its own cap (model/clickfx.ts)
//       (data/v3/, build/v3/, scenes/v3/*.ts over v2 over v1)
//   v4  v3 with an epic opening: the boom, a light shaft through dust over a silhouette, a crash zoom
//       into the first click (scenes/v4/open.ts, model/atmos.ts)
//   v5  v4's opening without the dust: light runs round the case edge on the boom, three backlights hold the
//       silhouette, a fill fades in before the crash zoom (scenes/v5/open.ts, model/trace.ts)
function readVersion() {
  if (typeof location === 'undefined') return 1;
  const v = Math.round(Number(new URLSearchParams(location.search).get('v') ?? '1'));
  return Number.isFinite(v) && v >= 1 ? v : 1;
}
export const VERSION = readVersion();
/** URL prefix of this version's generated files under data/ and audio/ ('' for v1). */
export const VDIR = VERSION === 1 ? '' : `v${VERSION}/`;
