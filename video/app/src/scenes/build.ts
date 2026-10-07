// The parts float apart in the dark and fall into place one per beat, bottom up; the last one locks on
// the beat before the drop.
import type { Frame } from '../engine/scene';
import { clamp, ease, pulse, smoothstep } from '../engine/util';
import { events } from '../cues';
import { EXPLODE, type LayerName } from '../model/macropad';
import { ProductScene, orbit } from './_product';
import { VERSION } from '../version';
import type { V3 } from '../stage';

const FALL = 0.2; // seconds a layer takes to drop the last of its height (gravity-like)

export default class Build extends ProductScene {
  shot(f: Frame) {
    const lift: Partial<Record<LayerName, number>> = {};
    const lands = events('land');
    for (const c of lands) {
      const k = c.layer as LayerName;
      // v2: no float and no bounce, the parts hang still and land dead
      const steady = VERSION >= 2;
      const h = EXPLODE[k] * 1.35 + (steady ? 0 : 6 * Math.sin(f.t * 2.1 + EXPLODE[k]));
      const u = clamp((f.t - (c.t - FALL)) / FALL);
      const bounce = !steady && f.t > c.t ? Math.max(0, Math.sin((f.t - c.t) * 40) * Math.exp(-(f.t - c.t) * 18)) * 1.2 : 0;
      lift[k] = h * (1 - ease.inQuad(u)) + bounce;
    }
    // the switches and the screen ride with the plate
    lift.oled = lift.plate! + (EXPLODE.oled - EXPLODE.plate) * (lift.plate! > 0.5 ? 1 : 0);
    const d = f.end - f.start;
    const az = 0.95 - 0.35 * ease.inOutCubic(f.lt / d), el = 0.42 + 0.06 * ease.inOutCubic(f.lt / d);
    const r = 640 - 170 * ease.inOutCubic(f.lt / d);
    return {
      cam: orbit([0, 60, 0], az, el, r), at: [0, 95 - 70 * smoothstep(f.start, f.end, f.t), 0] as V3, fov: 30,
      key: { pos: [-200, 520, 260] as V3, intensity: 2.0, radius: 80, angle: 0.5 },
      rim: { intensity: 14, pos: [0, 160, -380] as V3, at: [0, 60, 0] as V3, w: 600, h: 30 },
      accent: { intensity: 2.5, pos: [-380, 220, 40] as V3, at: [0, 110, 0] as V3, w: 300, h: 12, color: '#d6ff1f' },
      env: 0.22,
      pose: { lift },
    };
  }
  override post(f: Frame) {
    let shake = 0;
    for (const c of events('land')) shake += pulse(f.t, c.t, 0.05) * (c.heavy ? 5 : 2);
    return { shake: [Math.sin(f.t * 190) * shake, Math.cos(f.t * 160) * shake] as [number, number], vignette: 0.5 };
  }
}
