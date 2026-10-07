// v2 credit: the lockup holds, the lime MP sticker slaps on the final hit, the made-by line.
import type { Frame } from '../../engine/scene';
import { ease, smoothstep } from '../../engine/util';
import { first } from '../../cues';
import Credit from '../credit';
import { MUTED, setFont, sticker } from '../_type';
import { lockup, LOCKUP_UP } from './title';
import { VERTICAL } from '../../engine/gl';
import { UP } from '../_type';

export default class CreditV2 extends Credit {
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    const lift = ease.inOutCubic(smoothstep(f.start + 0.4, f.start + 1.0, f.t)) * 40;
    const r = lockup(f, c, { all: true, lift });
    if (!r) return false;
    // (upright: on the logo sticker's top-right corner)
    if (VERTICAL) sticker(c, UP.cx + LOCKUP_UP.stk * 0.5 + 10, LOCKUP_UP.y - lift - LOCKUP_UP.stk * 0.42, f.t, first('sticker').t, 84);
    else sticker(c, r.right + 74, r.y - 118, f.t, first('sticker').t, 74);
    const a = smoothstep(f.start + 0.6, f.start + 1.2, f.t);
    c.globalAlpha = a;
    setFont(c, 'Geist', 44, 500, 100, 0.5);
    c.textAlign = 'center'; c.fillStyle = MUTED;
    c.fillText('made by Davide + Claude Opus 5.5', VERTICAL ? UP.cx : 960, r.y + (VERTICAL ? 110 : 120) + 14 * (1 - a));
    c.globalAlpha = 1;
    return true;
  }
}
