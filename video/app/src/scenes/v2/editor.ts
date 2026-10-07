// v2: the keymap editor (host/ui, captured with demo data by scripts/capture_editor.ts) floats over the
// device. Three clicks on the beat: K5, K6, Save, each a sticker burst on the UI; "map every key." slaps on.
import * as THREE from 'three';
import type { Frame } from '../../engine/scene';
import { ease } from '../../engine/util';
import { events } from '../../cues';
import { ProductScene, kv } from '../_product';
import { clickBurst, stickerSlam } from './_fx';
import type { V3 } from '../../stage';

const W = 380, H = 237.5; // mm, the 1600x1000 page
const POS: V3 = [-14, 128, -70], ROT: V3 = [-0.12, 0.2, 0];

export default class Editor extends ProductScene {
  protected override wantsText = true;
  tex: Record<string, THREE.Texture> = {};
  rects!: { caps: number[][]; save: number[]; viewport: [number, number] };
  override async init() {
    await super.init();
    const L = new THREE.TextureLoader();
    for (const k of ['a', 'b', 'c']) {
      const t = await L.loadAsync(`editor/${k}.png`);
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
      this.tex[k] = t;
    }
    this.rects = await (await fetch('editor/rects.json')).json();
  }
  private state(t: number) {
    let s = 'a';
    for (const c of events('ui_click')) if (t >= c.t + 0.04) s = c.state;
    return s;
  }
  /** A point on the page (CSS px) in world space. */
  protected onPanel(px: number, py: number) {
    const [vw, vh] = this.rects.viewport;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...POS), new THREE.Quaternion().setFromEuler(new THREE.Euler(...ROT)), new THREE.Vector3(W, H, 1));
    return new THREE.Vector3(px / vw - 0.5, 0.5 - py / vh, 0.002).applyMatrix4(m);
  }
  shot(f: Frame) {
    const d = f.end - f.start;
    const cam = kv(f.lt, [[0, [POS[0] + 95, POS[1] + 40, POS[2] + 470]], [d, [POS[0] + 55, POS[1] + 22, POS[2] + 385], ease.outCubic]]);
    return {
      cam, at: [POS[0] + 6, POS[1] - 4, POS[2]] as V3, fov: 31, aperture: 2.2, focus: POS,
      key: { pos: [-150, 420, 260] as V3, intensity: 1.6, radius: 70 },
      rim: { intensity: 16, pos: [0, 120, -320] as V3, at: [0, 20, 0] as V3, w: 520, h: 20 },
      accent: { intensity: 8, pos: [-260, 60, 140] as V3, at: [0, 30, 0] as V3, w: 260, h: 12, color: '#d6ff1f' },
      env: 0.25,
      panel: { tex: this.tex[this.state(f.t)]!, pos: POS, rot: ROT, w: W, h: H, gain: 0.95 },
    };
  }
  /** Screen position (logical px) of a click target on the page. */
  uiPoint(target: string) {
    const r = target === 'save' ? this.rects.save : this.rects.caps[target === 'cap5' ? 4 : 5]!;
    return this.st.project(this.onPanel(r[0]! + r[2]! / 2, r[1]! + r[3]! / 2));
  }
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    let on = false;
    for (const k of events('ui_click')) {
      const r = k.target === 'save' ? this.rects.save : this.rects.caps[k.target === 'cap5' ? 4 : 5]!;
      const ctr = this.st.project(this.onPanel(r[0]! + r[2]! / 2, r[1]! + r[3]! / 2));
      const edge = this.st.project(this.onPanel(r[0]! + r[2]!, r[1]! + r[3]! / 2));
      const s = Math.hypot(edge.x - ctr.x, edge.y - ctr.y) * 2 * (k.target === 'save' ? 0.75 : 0.62);
      on = clickBurst(c, ctr.x, ctr.y, s, f.t - k.t, 0.2, undefined, k.target === 'save' ? 1.3 : 1.1) || on;
    }
    for (const s of events('slam', (e) => e.text === 'map every key.')) on = stickerSlam(c, s.text, 70, 930, f.t, s.t, Math.min(s.dur, f.end - s.t), { tilt: -3, align: 'left', size: 92 }) || on;
    return on;
  }
  override post() { return { vignette: 0.5, bloom: 0.5 }; }
}
