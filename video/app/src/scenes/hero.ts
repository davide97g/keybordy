// The drop: a white flash, and the whole device in the full light, turning slowly.
import type { Frame } from '../engine/scene';
import { ease, pulse } from '../engine/util';
import { first } from '../cues';
import { ProductScene, orbit } from './_product';
import type { V3 } from '../stage';

export default class Hero extends ProductScene {
  shot(f: Frame) {
    const d = f.end - f.start, p = f.lt / d;
    const az = 0.62 - 0.5 * ease.outCubic(p), el = 0.4 - 0.08 * p, r = 300 - 40 * ease.outQuart(Math.min(1, p * 1.4));
    return {
      cam: orbit([0, 18, 6], az, el, r), at: [0, 22 + 4 * p, 8] as V3, fov: 28, aperture: 1.2,
      key: { pos: [-170, 430, 240] as V3, intensity: 2.6, radius: 70, angle: 0.45 },
      rim: { intensity: 18, pos: [40, 120, -300] as V3, at: [0, 30, 0] as V3, w: 520, h: 24 },
      accent: { intensity: 4, pos: [320, 50, 80] as V3, at: [0, 30, 0] as V3, w: 260, h: 12, color: '#b9a8ff' },
      env: 0.3,
    };
  }
  override post(f: Frame) {
    const d = first('drop');
    return { flash: 0.9 * pulse(f.t, d.t, 0.09), zoom: 1 + 0.05 * pulse(f.t, d.t, 0.18), bloom: 0.7, vignette: 0.45 };
  }
}
