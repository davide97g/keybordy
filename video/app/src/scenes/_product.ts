// Shared base for the 3D scenes: the stage, the device pose from the cue sheet, and an optional 2D layer
// for type composited over the render.
import type * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../engine/scene';
import { Layer2D, VERTICAL } from '../engine/gl';
import { upright } from './_upright';
import { getStage, type Shot, type Stage, type V3 } from '../stage';
import { events, poseAt } from '../cues';
import { KEYMAP } from '../model/macropad';
import { VERSION } from '../version';
import { clickBurst } from './v2/_fx';
import { loadLogo } from './v2/_logo';
import * as T from 'three';
import type { Pose } from '../model/macropad';
import { keys, type Key } from '../engine/util';

export abstract class ProductScene extends Scene {
  st!: Stage;
  text: Layer2D | null = null;
  /** Set true in a subclass to get a 2D layer (drawn in overlay()). */
  protected wantsText = false;

  override async init() {
    this.st = await getStage(this.ctx.renderer);
    // v2 marks every click with a sticker burst, so every scene has a 2D layer
    if (this.wantsText || VERSION >= 2) this.text = new Layer2D();
    if (VERSION >= 2) await loadLogo();
  }

  /** The camera, lights and any pose overrides for time t. */
  abstract shot(f: Frame, pose: Pose): Omit<Shot, 'pose'> & { pose?: Pose };
  /** Type over the frame (logical 1920x1080 px). Return false to skip compositing. */
  overlay(_f: Frame, _c: CanvasRenderingContext2D): boolean { return false; }
  post(_f: Frame): PostOverrides | void {}

  /** v2: a sticker burst round each key while its click is on screen (drawn after overlay()). */
  protected clickTags = false;
  clicks(f: Frame, c: CanvasRenderingContext2D) {
    let on = false;
    const U = 19.05;
    for (const p of events('press', (e) => f.t >= e.t - 0.02 && f.t < e.t + e.hold + 0.6)) {
      const a = this.st.pad.anchors.get(p.key);
      if (!a) continue;
      const k = this.st.pad.keyInfo(p.key);
      // framed on the cap's on-screen box: the 8 corners of its 1u-pitch footprint, top to 9 mm down
      const xs: number[] = [], ys: number[] = [];
      let behind = false;
      for (const dx of [-1, 1]) for (const dz of [-1, 1]) for (const dy of [0, -9]) {
        const p2 = this.st.project(a.clone().add(new T.Vector3((dx * k.w * U) / 2 - dx * 1.2, dy, (dz * U) / 2 - dz * 1.2)));
        if (p2.z > 1) behind = true;
        xs.push(p2.x); ys.push(p2.y);
      }
      if (behind) continue;
      const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
      const ctr = { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 };
      const s = Math.min(520, Math.max(bw / k.w, bh) * 0.86);
      on = clickBurst(c, ctr.x, ctr.y, s, f.t - p.t, p.hold, this.clickTags ? KEYMAP[p.key]![0] : undefined, k.w) || on;
    }
    return on;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const base = poseAt(f.t);
    const s0 = this.shot(f, base);
    const s = VERTICAL ? upright(this.ctx.id, f, s0) : s0;
    // v3: every click goes off in 3D, out of its own cap
    const bursts = VERSION >= 3 ? events('press', (e) => e.t >= f.start && e.t < f.end && f.t >= e.t - 0.01 && f.t < e.t + e.hold + 0.9).map((e) => ({ key: e.key as string, t0: e.t, lt: f.t - e.t, hold: e.hold as number })) : undefined;
    this.st.render(f.t, { bursts, ...s, pose: { ...base, ...(s.pose ?? {}) } }, out, this.ctx.comp);
    if (this.text) {
      this.text.clear();
      // (v2: the click stickers go under the scene's own type)
      let drawn = VERSION === 2 ? this.clicks(f, this.text.ctx) : false;
      drawn = this.overlay(f, this.text.ctx) || drawn;
      if (drawn) this.ctx.comp.draw(this.ctx.renderer, this.text.upload(), out, { mode: 'normal' });
    }
    return this.post(f);
  }
}

/** Keyframed vector: one key list per component sharing times and eases. */
export function kv(t: number, ks: [number, V3, ((x: number) => number)?][]): V3 {
  return [0, 1, 2].map((i) => keys(t, ks.map(([tt, v, e]) => [tt, v[i]!, e] as Key))) as V3;
}

/** Orbit position around a centre: angle (rad, 0 = toward +z), elevation (rad), radius. */
export function orbit(c: V3, az: number, el: number, r: number): V3 {
  return [c[0] + Math.sin(az) * Math.cos(el) * r, c[1] + Math.sin(el) * r, c[2] + Math.cos(az) * Math.cos(el) * r];
}
