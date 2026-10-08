// v5 title, unchanged for the cut. With ?thumb=1 it is a plate for the YouTube thumbnail: no lockup (the
// thumbnail sets its own type) and the open's lime line held all the way round the case's top edge.
import type { Frame } from '../../engine/scene';
import { THUMB } from '../../version';
import TitleV2 from '../v2/title';

export default class TitleV5 extends TitleV2 {
  override shot(f: Frame) {
    const s = super.shot(f);
    return THUMB ? { ...s, trace: { p: 1, glow: 1.15, head: 0 } } : s;
  }
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    return THUMB ? false : super.overlay(f, c);
  }
}
