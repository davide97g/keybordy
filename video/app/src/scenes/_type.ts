// Type for the teaser: Anybody (wide, heavy) for slams and the wordmark, Geist for the credit line.
// Every function draws for time t only (no state).
import { stretch } from '../engine/type';
import { clamp, ease, smoothstep } from '../engine/util';
import { W, SAFE } from '../engine/gl';

/**
 * Upright type positions: lines centre on the frame (where the device is) and stay inside SAFE, so they are at
 * most twice the distance to its right edge wide; `high` sits under the top bar, `low` above the caption.
 */
export const UP = { cx: W / 2, maxW: 2 * (SAFE.right - W / 2), high: SAFE.top + 110, low: SAFE.bottom - 120 };

export const INK = '#070608', WHITE = '#e4e1e9', MUTED = 'rgba(165,159,178,0.9)', LIME = '#d6ff1f', LIME_SHADOW = '#8fb300';

export function setFont(c: CanvasRenderingContext2D, family: string, size: number, weight: number, width = 100, tracking = 0) {
  c.font = `${weight} ${size}px "${family}"`;
  c.fontStretch = stretch(width);
  c.letterSpacing = `${tracking}px`;
}

/**
 * A text slam: snaps in at t0 (a 90 ms scale-down from 1.12 with a 30 ms fade), holds, then leaves over the
 * last `outDur` seconds with a small drift and blur. Returns false when not on screen.
 */
export function slam(c: CanvasRenderingContext2D, text: string, x: number, y: number, t: number, t0: number, dur: number,
  o: { size?: number; weight?: number; width?: number; align?: CanvasTextAlign; color?: string; outDur?: number; tracking?: number } = {}) {
  const lt = t - t0;
  if (lt < 0 || lt > dur) return false;
  const outDur = o.outDur ?? 0.18;
  const inK = ease.outCubic(clamp(lt / 0.09));
  const outK = smoothstep(dur - outDur, dur, lt);
  const s = 1.12 - 0.12 * inK + 0.03 * outK;
  c.save();
  c.globalAlpha = clamp(lt / 0.03) * (1 - outK);
  if (outK > 0) c.filter = `blur(${outK * 10}px)`;
  c.translate(x, y); c.scale(s, s);
  setFont(c, 'Anybody', o.size ?? 150, o.weight ?? 900, o.width ?? 125, o.tracking ?? -2);
  c.textAlign = o.align ?? 'center'; c.textBaseline = 'middle';
  c.fillStyle = o.color ?? WHITE;
  c.fillText(text, 0, 0);
  c.restore();
  return true;
}

/** The MP sticker from the concept page: lime tag, rotated -6°, a hard drop shadow; slaps in and settles. */
export function sticker(c: CanvasRenderingContext2D, x: number, y: number, t: number, t0: number, size = 96) {
  const lt = t - t0;
  if (lt < 0) return false;
  const k = ease.outBack(clamp(lt / 0.16), 2.2);
  const s = 1.6 - 0.6 * k;
  const rot = (-6 + (1 - k) * -14) * Math.PI / 180;
  c.save();
  c.globalAlpha = clamp(lt / 0.04);
  c.translate(x, y); c.rotate(rot); c.scale(s, s);
  setFont(c, 'Anybody', size, 900, 100, 0);
  const w = c.measureText('MP').width + size * 0.44, h = size * 1.02;
  const drop = size * 0.065 * clamp(lt / 0.12);
  c.fillStyle = LIME_SHADOW; roundRect(c, -w / 2, -h / 2 + drop, w, h, size * 0.065); c.fill();
  c.fillStyle = LIME; roundRect(c, -w / 2, -h / 2, w, h, size * 0.065); c.fill();
  c.fillStyle = INK; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('MP', 0, size * 0.05);
  c.restore();
  return true;
}

export function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath(); c.roundRect(x, y, w, h, r);
}
