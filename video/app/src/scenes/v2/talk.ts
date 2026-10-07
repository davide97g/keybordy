// v2 talk: the held bar wears its sticker for as long as it is down; "your voice." is a label.
import type { Frame } from '../../engine/scene';
import { events } from '../../cues';
import Talk from '../talk';
import { stickerSlam } from './_fx';
import { VERTICAL } from '../../engine/gl';
import { UP } from '../_type';

export default class TalkV2 extends Talk {
  protected override wantsText = true;
  protected override clickTags = true;
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    const s = events('slam', (e) => e.text === 'your voice.')[0];
    if (!s) return false;
    return VERTICAL ? stickerSlam(c, s.text, UP.cx, UP.high, f.t, s.t, s.dur, { tilt: -4, size: 120, maxW: UP.maxW })
      : stickerSlam(c, s.text, 960, 150, f.t, s.t, s.dur, { tilt: -4 });
  }
}
