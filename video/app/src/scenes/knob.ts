// Macro on the knobs: the knurl in a raking light, E1 turns on the eighths, the other two out of focus.
import type { Frame } from '../engine/scene';
import { ease } from '../engine/util';
import { ProductScene, kv } from './_product';
import type { V3 } from '../stage';

export default class Knob extends ProductScene {
  shot(f: Frame) {
    const e1 = this.st.pad.anchors.get('E1')!.toArray() as V3;
    const d = f.end - f.start;
    const cam = kv(f.lt, [[0, [e1[0] - 62, e1[1] + 2, e1[2] + 40]], [d, [e1[0] - 44, e1[1] + 6, e1[2] + 30], ease.inOutCubic]]);
    const at: V3 = [e1[0] + 4, e1[1] - 7, e1[2]];
    return {
      cam, at, fov: 24, aperture: 1.6,
      key: { pos: [-260, 160, 120] as V3, intensity: 1.6, radius: 30, angle: 0.25 },
      rim: { intensity: 26, pos: [60, 90, -200] as V3, at: e1, w: 220, h: 8, color: '#f4f1f8' },
      accent: { intensity: 3, pos: [240, 40, 60] as V3, at: e1, w: 120, h: 8, color: '#d6ff1f' },
      env: 0.12,
    };
  }
  override post() { return { vignette: 0.6, bloom: 0.6 }; }
}
