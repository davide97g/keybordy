// Push to talk: the green bar held down, the mic LED lit, the screen listening.
import type { Frame } from '../engine/scene';
import { ease } from '../engine/util';
import { ProductScene, kv } from './_product';
import type { V3 } from '../stage';

export default class Talk extends ProductScene {
  shot(f: Frame) {
    const k = this.st.pad.anchors.get('K21')!.toArray() as V3, o = this.st.pad.anchors.get('oled')!.toArray() as V3;
    const at: V3 = [(k[0] + o[0]) / 2 + 10, (k[1] + o[1]) / 2, (k[2] + o[2]) / 2 + 6];
    const d = f.end - f.start;
    const cam = kv(f.lt, [[0, [at[0] + 40, at[1] + 150, at[2] + 150]], [d, [at[0] + 25, at[1] + 125, at[2] + 120], ease.outCubic]]);
    return {
      cam, at, fov: 30, aperture: 1.2, focus: k,
      key: { pos: [-140, 400, 200] as V3, intensity: 1.6, radius: 60 },
      rim: { intensity: 14, pos: [0, 110, -260] as V3, at, w: 460, h: 18 },
      accent: { intensity: 6, pos: [260, 40, 120] as V3, at: k, w: 220, h: 10, color: '#00ae42' },
      env: 0.2,
    };
  }
  override post() { return { bloom: 0.8, vignette: 0.55 }; }
}
