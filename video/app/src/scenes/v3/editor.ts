// v3 editor: the clicks on the UI are a lime ripple (a dot and three rings running out from the pointer)
// instead of v2's sticker rings; "map every key." stays a label.
import type { Frame } from '../../engine/scene';
import { clamp, ease, smoothstep } from '../../engine/util';
import type { V3 } from '../../stage';
import { events } from '../../cues';
import EditorV2 from '../v2/editor';
import { stickerSlam } from '../v2/_fx';
import { VERTICAL } from '../../engine/gl';
import { UP } from '../_type';

export function ripple(c: CanvasRenderingContext2D, x: number, y: number, lt: number, size = 70) {
  if (lt < 0 || lt > 0.7) return false;
  c.save();
  c.shadowColor = 'rgba(214,255,31,0.9)'; c.shadowBlur = 18;
  // the press: a dot that pops and shrinks
  const d = clamp(1 - lt / 0.25);
  if (d > 0) { c.globalAlpha = d; c.fillStyle = '#d6ff1f'; c.beginPath(); c.arc(x, y, size * 0.16 * (0.6 + 0.6 * ease.outBack(clamp(lt / 0.08))), 0, Math.PI * 2); c.fill(); }
  // three rings, 60 ms apart
  c.strokeStyle = '#d6ff1f';
  for (let i = 0; i < 3; i++) {
    const u = clamp((lt - i * 0.06) / 0.5);
    if (u <= 0 || u >= 1) continue;
    c.globalAlpha = (1 - u) ** 1.5 * (1 - i * 0.25);
    c.lineWidth = 5 * (1 - u) + 1.5;
    c.beginPath(); c.arc(x, y, size * (0.2 + 1.1 * ease.outCubic(u)), 0, Math.PI * 2); c.stroke();
  }
  c.restore();
  return true;
}

export default class EditorV3 extends EditorV2 {
  // the camera tilts down on the last beat so the Save click is in frame
  override shot(f: Frame) {
    const s = super.shot(f);
    const save = events('ui_click', (e) => e.target === 'save')[0]!;
    const k = ease.inOutCubic(smoothstep(save.t - 0.42, save.t - 0.04, f.t));
    const at = s.at as V3;
    return { ...s, at: [at[0] + 10 * k, at[1] - 62 * k, at[2]] as V3 };
  }
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    let on = false;
    for (const k of events('ui_click')) {
      const p = this.uiPoint(k.target);
      on = ripple(c, p.x, p.y, f.t - k.t) || on;
    }
    for (const s of events('slam', (e) => e.text === 'map every key.')) {
      const dur = Math.min(s.dur, f.end - s.t);
      on = (VERTICAL ? stickerSlam(c, s.text, UP.cx, UP.high, f.t, s.t, dur, { tilt: -3, size: 110, maxW: UP.maxW })
        : stickerSlam(c, s.text, 70, 930, f.t, s.t, dur, { tilt: -3, align: 'left', size: 92 })) || on;
    }
    return on;
  }
}
