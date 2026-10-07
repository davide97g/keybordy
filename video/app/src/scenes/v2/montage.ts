// v2 montage: four cuts, each click a sticker burst with its action tag; the lines are lime labels.
import type { Frame } from '../../engine/scene';
import { events } from '../../cues';
import Montage from '../montage';
import { stickerSlam } from './_fx';
import { VERTICAL } from '../../engine/gl';
import { UP } from '../_type';

export default class MontageV2 extends Montage {
  protected override clickTags = true;
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    let on = false, i = 0;
    for (const s of events('slam', (e) => e.t < f.end)) {
      const tilt = i++ % 2 ? 3 : -3, dur = Math.min(s.dur, f.end - s.t);
      on = (VERTICAL ? stickerSlam(c, s.text, UP.cx, UP.low, f.t, s.t, dur, { tilt, size: 120, maxW: UP.maxW })
        : stickerSlam(c, s.text, 960, 880, f.t, s.t, dur, { tilt })) || on;
    }
    return on;
  }
}
