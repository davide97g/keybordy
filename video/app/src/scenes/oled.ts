// The screen wakes: a scanline, then the wordmark, in the black glass. The riser starts here.
import type { Frame } from '../engine/scene';
import { ease, pulse } from '../engine/util';
import { first } from '../cues';
import { ProductScene, kv } from './_product';
import type { V3 } from '../stage';

export default class Oled extends ProductScene {
  shot(f: Frame) {
    const o = this.st.pad.anchors.get('oled')!.toArray() as V3;
    const d = f.end - f.start;
    const cam = kv(f.lt, [[0, [o[0] - 10, o[1] + 92, o[2] + 74]], [d, [o[0] - 4, o[1] + 70, o[2] + 54], ease.inOutQuad]]);
    return {
      cam, at: [o[0], o[1] - 1, o[2] - 2] as V3, fov: 30, aperture: 1.4,
      key: { pos: [120, 260, 260] as V3, intensity: 0.7, radius: 50 },
      rim: { intensity: 16, pos: [-80, 110, -220] as V3, at: o, w: 380, h: 14, color: '#e9e6ff' },
      env: 0.12,
    };
  }
  override post(f: Frame) {
    const c = first('chirp');
    return { bloom: 0.75 + 0.6 * pulse(f.t, c.t, 0.15), vignette: 0.55 };
  }
}
