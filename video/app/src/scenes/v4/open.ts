// v4 cold open, epic: black; on the music's opening hit a white flash, a horizontal flare streak and a
// shake, and a shaft of light falls through drifting dust onto the device, a rim-lit silhouette seen wide
// and low. The camera pushes in, then crash-zooms into the CLAUDE key, landing as it goes off (v3 burst).
import type { Frame } from '../../engine/scene';
import { clamp, ease, keys, pulse, smoothstep } from '../../engine/util';
import { first } from '../../cues';
import { ProductScene, kv, orbit } from '../_product';
import type { V3 } from '../../stage';
import { W, VERTICAL } from '../../engine/gl';
import * as THREE from 'three';

export default class OpenV4 extends ProductScene {
  protected override wantsText = true;
  /** The wide shot: camera distance at the hit and when the crash zoom starts, and the height it aims at (mm). */
  protected wide = { r0: 720, r1: 470, atY: 96 };
  shot(f: Frame) {
    const boom = first('boom_open').t, crash = first('crash'), press = first('press', (c) => c.key === 'K1');
    const k1 = this.st.pad.anchors.get('K1')!.toArray() as V3;
    // wide and low, pushing in; then the crash zoom (crash.t .. press.t - 0.12), then a slow drift on the key
    const wideCam = orbit([0, 18, 0], 0.32 - 0.1 * smoothstep(boom, crash.t, f.t), 0.06 + 0.05 * smoothstep(boom, crash.t, f.t), keys(f.t, [[boom, this.wide.r0], [crash.t, this.wide.r1, ease.outCubic]]));
    const macroCam: V3 = [k1[0] + 34, k1[1] + 8, k1[2] + 46];
    const land = press.t - 0.1;
    const u = ease.inOutExpo(clamp((f.t - crash.t) / (land - crash.t)));
    const drift = Math.max(0, f.t - land);
    const cam: V3 = [0, 1, 2].map((i) => wideCam[i]! + (macroCam[i]! - wideCam[i]!) * u - (i === 0 ? drift * 8 : 0)) as V3;
    const at = kv(u, [[0, [0, this.wide.atY, 0]], [1, [k1[0] + 2, k1[1] - 4, k1[2] + 2]]]);
    const lit = smoothstep(boom - 0.01, boom + 0.05, f.t);
    return {
      cam, at, fov: 24 + 4 * u, aperture: 2.2 * u, focus: u > 0.5 ? (k1 as V3) : undefined,
      key: { pos: [-90, 320, 200] as V3, intensity: 1.2 * smoothstep(land - 0.2, press.t + 0.1, f.t), radius: 60, angle: 0.3 },
      rim: { intensity: (12 + 14 * pulse(f.t, boom, 0.25)) * lit, pos: [0, 130, -300] as V3, at: [0, 40, 0] as V3, w: 520, h: 12, color: '#f4f1f8' },
      accent: { intensity: 3 * lit * (1 - u), pos: [-340, 90, 140] as V3, at: [0, 40, 0] as V3, w: 200, h: 8, color: '#d6ff1f' },
      env: 0.02 + 0.12 * u,
      atmos: { beam: lit * (0.8 + 1.4 * pulse(f.t, boom, 0.3)) * (1 - 0.85 * u), dust: lit },
    };
  }
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    // the anamorphic streak on the hit: a hairline core with a wide soft halo, across the frame
    const boom = first('boom_open').t, a = pulse(f.t, boom, 0.18) * smoothstep(boom - 0.01, boom + 0.01, f.t);
    if (a < 0.01) return false;
    // (upright: through the device's top edge, where the lime trace starts)
    const y = VERTICAL ? this.st.project(new THREE.Vector3(0, 30, 0)).y : 470;
    for (const [h, al, col] of [[90, 0.18, '214,255,31'], [26, 0.45, '232,240,255'], [4, 1, '255,255,255']] as const) {
      const g = c.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(0.5, `rgba(${col},${al * a})`); g.addColorStop(1, `rgba(${col},0)`);
      c.fillStyle = g; c.fillRect(0, y - h / 2, W, h);
    }
    return true;
  }
  override post(f: Frame) {
    const boom = first('boom_open').t, crash = first('crash'), press = first('press', (c) => c.key === 'K1');
    const sh = pulse(f.t, boom, 0.08) * 9 + pulse(f.t, press.t, 0.05) * 5;
    const zoomMid = Math.sin(Math.PI * clamp((f.t - crash.t) / (press.t - 0.1 - crash.t)));
    return {
      fade: 1 - smoothstep(0, 0.02, f.t), flash: 0.85 * pulse(f.t, boom, 0.07), vignette: 0.75,
      shake: [Math.sin(f.t * 170) * sh, Math.cos(f.t * 150) * sh] as [number, number],
      ca: 0.9 + 6 * zoomMid, bloom: 0.75, zoom: 1 + 0.04 * pulse(f.t, boom, 0.2),
    };
  }
}
