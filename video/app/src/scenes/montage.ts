// One cut per beat: a key goes down, the screen answers. Text slams every other beat.
import type { Frame } from '../engine/scene';
import { hash, pulse } from '../engine/util';
import { events } from '../cues';
import { ProductScene, orbit } from './_product';
import { slam } from './_type';
import type { V3 } from '../stage';

export default class Montage extends ProductScene {
  protected override wantsText = true;
  shot(f: Frame) {
    const presses = events('press', (c) => c.t >= f.start - 0.05 && c.t < f.end);
    let i = 0;
    for (let j = 0; j < presses.length; j++) if (f.t >= presses[j]!.t - 0.06) i = j;
    const p = presses[i]!;
    const k = this.st.pad.anchors.get(p.key)!.toArray() as V3;
    const o = this.st.pad.anchors.get('oled')!.toArray() as V3;
    // each cut its own angle; the camera drifts a little through it
    const h = (n: number) => hash(i, n);
    const az = -1.1 + 2.2 * h(1), el = 0.22 + 0.5 * h(2), r = 62 + 40 * h(3);
    const drift = (f.t - (p.t - 0.06)) * 0.12;
    const showScreen = i % 2 === 1;
    const at: V3 = showScreen ? [(k[0] + o[0]) / 2, (k[1] + o[1]) / 2, (k[2] + o[2]) / 2] : [k[0], k[1] - 4, k[2]];
    return {
      cam: orbit(at, az + drift, el, showScreen ? r + 70 : r), at, fov: 28, aperture: showScreen ? 1.2 : 2.4, focus: showScreen ? undefined : k,
      key: { pos: [-150 + 300 * h(4), 380, 220] as V3, intensity: 2.2, radius: 60, angle: 0.4 },
      rim: { intensity: 16, pos: [0, 100, -260] as V3, at, w: 460, h: 18 },
      accent: { intensity: 3, pos: [h(5) > 0.5 ? 280 : -280, 50, 60] as V3, at, w: 200, h: 10, color: h(6) > 0.5 ? '#d6ff1f' : '#b9a8ff' },
      env: 0.26,
    };
  }
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    let on = false;
    // a scrim under the line keeps the type readable over the white caps
    const live = events('slam').find((s) => f.t >= s.t && f.t < s.t + s.dur);
    if (live) {
      const g = c.createLinearGradient(0, 640, 0, 1080);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.55, 'rgba(0,0,0,0.62)'); g.addColorStop(1, 'rgba(0,0,0,0.78)');
      c.fillStyle = g; c.fillRect(0, 640, 1920, 440);
    }
    for (const s of events('slam')) on = slam(c, s.text, 960, 900, f.t, s.t, s.dur, { size: 124 }) || on;
    return on;
  }
  override post(f: Frame) {
    let k = 0;
    for (const s of events('slam')) k += pulse(f.t, s.t, 0.06);
    return { zoom: 1 + 0.02 * k, vignette: 0.5, bloom: 0.6 };
  }
}
