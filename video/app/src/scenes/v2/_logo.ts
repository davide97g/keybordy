// The keybordy logo sticker (sim/velxio/frontend/src/components/ui/LogoSticker.tsx: a lime keycap with
// the K on a white die-cut vinyl, a lifted corner) as three Canvas2D images, so the cap can press into
// its skirt like the CSS one does: under (vinyl + skirt), cap (top, highlight, K), peel (the flap).
// The wordmark beside it is Anybody 820 at its widest keyword width (the tokens ask 140 %).
import { clamp } from '../../engine/util';
import { setFont } from '../_type';

const CAP = '#d6ff1f', SKIRT = '#8fb300', INK = '#0c0b0e', VINYL = '#f4f1f8';
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="600" height="600">
  <defs><mask id="m"><rect width="100" height="100" fill="#fff"/><polygon points="100,72 72,100 100,100" fill="#000"/></mask>
  <linearGradient id="flap" x1="86" y1="86" x2="76" y2="76" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9d95ab"/><stop offset="1" stop-color="${VINYL}"/></linearGradient></defs>
  ${body}</svg>`;
const UNDER = svg(`<g mask="url(#m)"><rect x="4" y="4" width="92" height="92" rx="22" fill="${VINYL}"/><rect x="13" y="15" width="74" height="72" rx="15" fill="${SKIRT}"/></g>`);
const CAPTOP = svg(`<rect x="13" y="13" width="74" height="64" rx="15" fill="${CAP}"/>
  <path d="M22 27q0-8 8-8h20" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="3.5" stroke-linecap="round"/>
  <g fill="${INK}" transform="translate(50 45) scale(2.25) translate(-16.75 -16)"><rect x="8.5" y="7.5" width="4.5" height="17" rx="1"/>
  <polygon points="13,15.2 19.6,7.5 25,7.5 16.4,17.6"/><polygon points="15.2,15.6 25,24.5 19.6,24.5 13,18.6"/></g>`);
const PEEL = svg(`<polygon points="96,76 76,96 73,73" fill="#000" fill-opacity=".28"/><path d="M96 76L76 96V79q0-3 3-3z" fill="url(#flap)"/>`);

let imgs: { under: HTMLImageElement; cap: HTMLImageElement; peel: HTMLImageElement } | null = null;
async function load(s: string) {
  const i = new Image();
  i.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
  await i.decode();
  return i;
}
export async function loadLogo() {
  imgs ??= { under: await load(UNDER), cap: await load(CAPTOP), peel: await load(PEEL) };
}

/** cubic-bezier(x1, y1, x2, y2) easing, as CSS: solve x for t by bisection, return y. */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const f = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 28; i++) { const m = (lo + hi) / 2; if (f(x1, x2, m) < x) lo = m; else hi = m; }
    return f(y1, y2, (lo + hi) / 2);
  };
}
/** The slap from sticker.css (thrown at the screen, lands with an overshoot), over `dur` seconds. */
const slapEase = bezier(0.2, 1.45, 0.35, 1);
export function slap(lt: number, dur = 0.42) {
  const k = slapEase(clamp(lt / dur));
  return { scale: 2 - k, rot: (-28 + 22 * k) * Math.PI / 180, dy: -0.12 * (1 - k), alpha: clamp(lt / (dur * 0.45)) };
}

/** The sticker centred at (x, y), `size` px square. `press` 0..1 pushes the cap into its skirt. */
export function drawLogo(c: CanvasRenderingContext2D, x: number, y: number, size: number, o: { rot?: number; scale?: number; alpha?: number; press?: number; dy?: number } = {}) {
  if (!imgs) return;
  const s = size * (o.scale ?? 1);
  c.save();
  c.globalAlpha = o.alpha ?? 1;
  c.translate(x, y + (o.dy ?? 0) * size); c.rotate(o.rot ?? -6 * Math.PI / 180);
  c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = s * 0.08; c.shadowOffsetY = s * 0.05;
  c.drawImage(imgs.under, -s / 2, -s / 2, s, s);
  c.shadowColor = 'transparent';
  c.drawImage(imgs.cap, -s / 2, -s / 2 + (o.press ?? 0) * s * 0.07, s, s);
  c.drawImage(imgs.peel, -s / 2, -s / 2, s, s);
  c.restore();
}

/** Wordmark metrics for a lockup: the sticker is 1.55x the cap height, the gap 0.32x the sticker. */
export function wordmark(c: CanvasRenderingContext2D, size: number) {
  setFont(c, 'Anybody', size, 820, 150, -0.01 * size);
  const w = c.measureText('keybordy').width;
  const stk = size * 1.06, gap = stk * 0.3;
  return { w, stk, gap, total: stk + gap + w };
}
