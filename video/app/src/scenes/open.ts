// Cold open: darkness, a thin strip of light slides behind the CLAUDE key and draws its edges, the
// texture of the print comes up, and the key goes down on the first click.
import type { Frame } from '../engine/scene';
import { ease, keys, smoothstep } from '../engine/util';
import { first } from '../cues';
import { ProductScene, kv } from './_product';
import type { V3 } from '../stage';

export default class Open extends ProductScene {
  shot(f: Frame) {
    const k1 = this.st.pad.anchors.get('K1')!.toArray() as V3;
    const at: V3 = [k1[0] + 2, k1[1] - 4, k1[2] + 2];
    const end = f.end, t = f.lt;
    const cam = kv(t, [[0, [k1[0] + 58, k1[1] + 4, k1[2] + 52]], [end - f.start, [k1[0] + 30, k1[1] + 10, k1[2] + 44], ease.inOutCubic]]);
    const sweep = keys(t, [[0, -320], [(end - f.start) * 0.8, 260, ease.inOutQuad]]);
    const press = first('press', (c) => c.key === 'K1');
    return {
      cam, at, fov: 26, aperture: 2.2,
      key: { pos: [-60, 300, 220] as V3, intensity: 1.2 * smoothstep(f.start + 0.6, press.t, f.t) ** 2, radius: 60, angle: 0.3 },
      rim: { intensity: 22, pos: [sweep, 70, -120] as V3, at: [sweep * 0.3, 40, 0] as V3, w: 60, h: 6, color: '#f4f1f8' },
      accent: { intensity: 4 * smoothstep(press.t - 0.05, press.t + 0.3, f.t), pos: [220, 50, 120] as V3, at: k1, w: 200, h: 10, color: '#b9a8ff' },
      env: 0.01 + 0.12 * smoothstep(f.start + 0.5, press.t, f.t) ** 2,
    };
  }
  override post(f: Frame) {
    return { fade: 1 - smoothstep(0, 0.9, f.lt), vignette: 0.7, bloom: 0.6 };
  }
}
