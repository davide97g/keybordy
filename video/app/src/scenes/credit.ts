// Made by: the silhouette holds, one line under the wordmark, then black.
import type { Frame } from '../engine/scene';
import { clamp, ease, pulse, smoothstep } from '../engine/util';
import { events, first } from '../cues';
import { layoutWord } from './_word';
import { ProductScene, orbit } from './_product';
import { MUTED, setFont, sticker, WHITE } from './_type';
import type { V3 } from '../stage';

export default class Credit extends ProductScene {
  protected override wantsText = true;
  shot(f: Frame) {
    const title = events('letter')[0]!.t;
    const p = clamp((f.t - title) / (f.end - title));
    return {
      cam: orbit([0, 10, 0], 0.08 - 0.12 * p, 0.12, 330 - 30 * ease.outCubic(Math.min(1, p * 1.3))), at: [0, 62, 0] as V3, fov: 30,
      key: { pos: [0, 400, 200] as V3, intensity: 0.3 * smoothstep(f.start, f.start + 0.5, f.t), radius: 60 },
      rim: { intensity: 4 + 20 * smoothstep(f.start - 0.02, f.start + 0.5, f.t), pos: [0, 70, -260] as V3, at: [0, 20, 0] as V3, w: 700, h: 20 },
      env: 0.02 + 0.06 * smoothstep(f.start, f.start + 0.5, f.t),
    };
  }
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    const size = 210;
    setFont(c, 'Anybody', size, 900, 130, -4);
    const word = layoutWord(c, 'keybordy');
    const x0 = 960 - word.width / 2 - 60, y = 470;
    const lift = ease.inOutCubic(smoothstep(f.start + 0.4, f.start + 1.0, f.t)) * 40;
    c.textBaseline = 'alphabetic'; c.textAlign = 'left'; c.fillStyle = WHITE;
    c.fillText('keybordy', x0, y - lift);
    sticker(c, x0 + word.width + 120, y - lift - size * 0.62, f.t, first('sticker').t, 92);
    const a = smoothstep(f.start + 0.6, f.start + 1.2, f.t);
    c.globalAlpha = a;
    setFont(c, 'Geist', 44, 500, 100, 0.5);
    c.textAlign = 'center'; c.fillStyle = MUTED;
    c.fillText('made by Davide + Claude Opus 5.5', 960, y + 110 - lift + 14 * (1 - a));
    c.globalAlpha = 1;
    return true;
  }
  override post(f: Frame) {
    const hit = first('impact');
    return { fade: smoothstep(f.end - 0.7, f.end - 0.05, f.t), flash: 0.55 * pulse(f.t, hit.t, 0.07), zoom: 1 + 0.03 * pulse(f.t, hit.t, 0.25), vignette: 0.55, bloom: 0.55 };
  }
}
