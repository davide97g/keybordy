// v2 title: the logo sticker slaps on, then "keybordy" is typed beside it one letter per eighth, the
// sticker's key pressing with every letter; over the same dark silhouette as v1.
import type { Frame } from '../../engine/scene';
import { clamp, ease } from '../../engine/util';
import { events, first, travel } from '../../cues';
import { layoutWord } from '../_word';
import Title from '../title';
import { drawLogo, slap, wordmark } from './_logo';
import { UP, WHITE } from '../_type';
import { VERTICAL } from '../../engine/gl';

export const LOCKUP = { size: 138, y: 460 };
/** Upright: the sticker stacked over the wordmark, both centred; the wordmark as wide as the safe box allows. */
export const LOCKUP_UP = { stk: 300, y: 560 };

/** The lockup: logo sticker + wordmark, letters shown up to time t (all when `all`). */
export function lockup(f: Frame, c: CanvasRenderingContext2D, o: { all?: boolean; lift?: number } = {}) {
  let { size } = LOCKUP, y = LOCKUP.y - (o.lift ?? 0);
  let m = wordmark(c, size);
  if (VERTICAL) { size = Math.min(180, (size * UP.maxW * 0.96) / m.w); m = wordmark(c, size); }
  const x0 = 960 - m.total / 2 - 50; // (room for the MP sticker on the right)
  const logo = first('logo'), letters = events('letter');
  const lt = f.t - logo.t;
  if (lt < 0 && !o.all) return false;
  let press = 0;
  for (const l of letters) press = Math.max(press, travel(f.t, l.t, 0.05));
  const sl = o.all ? { scale: 1, rot: -6 * Math.PI / 180, dy: 0, alpha: 1 } : slap(lt, 0.42);
  const word = layoutWord(c, 'keybordy');
  let wx = x0 + m.stk + m.gap;
  if (VERTICAL) {
    const ly = LOCKUP_UP.y - (o.lift ?? 0);
    drawLogo(c, UP.cx, ly, LOCKUP_UP.stk, { ...sl, press });
    y = ly + LOCKUP_UP.stk / 2 + 60 + size * 0.72;
    wx = UP.cx - word.width / 2;
  } else drawLogo(c, x0 + m.stk / 2, y - size * 0.34, m.stk, { ...sl, press });
  c.textBaseline = 'alphabetic'; c.textAlign = 'left'; c.fillStyle = WHITE;
  for (const l of letters) {
    const k = o.all ? 1 : ease.outBack(clamp((f.t - l.t) / 0.12), 2.6);
    if (!o.all && f.t < l.t) continue;
    const g = word.glyphs[l.i]!;
    c.save();
    c.globalAlpha = o.all ? 1 : clamp((f.t - l.t) / 0.025);
    c.translate(wx + g.x + g.w / 2, y); c.scale(1, 0.4 + 0.6 * k); c.translate(0, 18 * (1 - k));
    c.fillText(l.ch, -g.w / 2, 0);
    c.restore();
  }
  return { right: wx + word.width, y };
}

export default class TitleV2 extends Title {
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    return !!lockup(f, c);
  }
}
