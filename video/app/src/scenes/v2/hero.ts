// v2 hero: as v1, with the lime doing more of the lighting.
import type { Frame } from '../../engine/scene';
import Hero from '../hero';
import type { V3 } from '../../stage';

export default class HeroV2 extends Hero {
  override shot(f: Frame) {
    const s = super.shot(f);
    return { ...s, accent: { intensity: 6, pos: [-300, 120, 60] as V3, at: [0, 40, 0] as V3, w: 220, h: 10, color: '#d6ff1f' },
      rim: { ...s.rim, color: '#eef9c8' } };
  }
}
