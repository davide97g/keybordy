// keybordy MP as a three.js model, built from the same sources as the hardware: the printed parts are the
// real CAD meshes (video/build/models, exported by video/scripts/export_meshes.py), everything else is
// placed from layout/macropad.json. Assembled like the "Assembled" view of cad/preview/template.html:
// CAD frame (X = layout x, Y = -layout y, Z up, plate top at Z = 0), tilted by the case angle onto a table
// at y = 0. Units are mm. All posing goes through pose(), so a frame is a pure function of its inputs.
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import L from '@layout/macropad.json';
import { makeMaterials, type Materials } from './materials';
import { Oled, type OledState } from './oled';

export const LAYOUT = L;
const U = L.u_mm;

/** Example keymap, as in the concept render (layout/preview/template.html). */
export const KEYMAP: Record<string, [label: string, detail: string]> = {
  K1: ['CLAUDE', 'terminal › claude'], K2: ['NOTES', 'app › Notes'], K3: ['TERM', 'terminal › ~'], K4: ['CODE', 'app › VS Code'],
  K5: ['WEB', 'url › localhost'], K6: ['MAIL', 'app › Mail'], K7: ['SLACK', 'app › Slack'], K8: ['MEET', 'url › meet.new'],
  K9: ['MUSIC', 'media › play'], K10: ['SHOT', 'keys › ⇧⌘4'], K11: ['CLIP', 'app › Clipboard'], K12: ['LOCK', 'keys › ⌃⌘Q'],
  K13: ['◀ DESK', 'keys › ⌃←'], K14: ['DESK ▶', 'keys › ⌃→'], K15: ['MUTE', 'media › mute'], K16: ['DND', 'shortcut › Focus'],
  K17: ['TIMER', 'shortcut › 25 min'], K18: ['SLEEP', 'shell › pmset'], K19: ['LAYER', 'layer › next'], K20: ['FN', 'layer › hold'],
  K21: ['TALK', 'voice › push to talk'], K22: ['ENTER', 'keys › ↩'],
};

/** Layer lift (mm along the case's up axis) at explode = 1, bottom to top. */
export const EXPLODE = { tray: 0, inner: 22, pcb: 44, plate: 68, oled: 72, sw: 76, caps: 108, deck: 136, knobs: 156 } as const;
export type LayerName = keyof typeof EXPLODE;

export interface Pose {
  /** Per-layer lift in mm (overrides). */
  lift?: Partial<Record<LayerName, number>>;
  /** Per-layer visibility (0 hides; values in between are not blended, only 0 vs >0). */
  show?: Partial<Record<LayerName, number>>;
  /** Key travel 0..1 (1 = bottomed out, 4 mm). */
  press?: Record<string, number>;
  /** Knob angle in detents (24 per turn). */
  knob?: Record<string, number>;
  oled?: OledState;
  /** Panel brightness (HDR multiplier). */
  oledGain?: number;
  /** Mic LED 0..1. */
  mic?: number;
}

export const keyCenter = (k: { x: number; y: number; w: number; h: number }) => [(k.x + k.w / 2) * U, -(k.y + k.h / 2) * U] as const;

/** Rounded-rectangle shape in CAD x/y from layout-space bounds (y down). */
function rrect(x0: number, y0: number, x1: number, y1: number, r: number, path: THREE.Path = new THREE.Shape()) {
  const a = -y1, b = -y0; // CAD y
  r = Math.min(r, (x1 - x0) / 2 - 0.01, (b - a) / 2 - 0.01);
  path.moveTo(x0 + r, a);
  path.lineTo(x1 - r, a); path.absarc(x1 - r, a + r, r, -Math.PI / 2, 0, false);
  path.lineTo(x1, b - r); path.absarc(x1 - r, b - r, r, 0, Math.PI / 2, false);
  path.lineTo(x0 + r, b); path.absarc(x0 + r, b - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(x0, a + r); path.absarc(x0 + r, a + r, r, Math.PI, Math.PI * 1.5, false);
  return path;
}

/** A box from z0 to z1 centred on (x, y) in CAD frame. */
function box(w: number, d: number, z0: number, z1: number, r = 0) {
  const g = r > 0 ? new RoundedBoxGeometry(w, d, z1 - z0, 3, r) : new THREE.BoxGeometry(w, d, z1 - z0);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}
function cyl(rad: number, z0: number, z1: number, seg = 40) {
  const g = new THREE.CylinderGeometry(rad, rad, z1 - z0, seg);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

/** Text drawn on a transparent canvas, as a plane facing +Z (w x h mm). */
function textPlane(lines: string[], w: number, h: number, color: string, opts: { size?: number; font?: string; weight?: number; align?: CanvasTextAlign } = {}) {
  const ppm = 48, c = document.createElement('canvas');
  c.width = Math.round(w * ppm); c.height = Math.round(h * ppm);
  const g = c.getContext('2d')!;
  const fs = (opts.size ?? 3) * ppm;
  g.fillStyle = color; g.textAlign = opts.align ?? 'center'; g.textBaseline = 'middle';
  g.font = `${opts.weight ?? 600} ${fs}px "${opts.font ?? 'Martian Mono'}"`;
  const x = opts.align === 'left' ? 0 : c.width / 2;
  lines.forEach((ln, i) => g.fillText(ln, x, c.height / 2 + (i - (lines.length - 1) / 2) * fs * 1.2));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const m = new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -4 });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
}

async function loadSTL(name: string) {
  const g = await new STLLoader().loadAsync(`models/${name}.stl`);
  g.deleteAttribute('normal');
  return toCreasedNormals(g, THREE.MathUtils.degToRad(32));
}

/** Where build() gets the printed parts and the frame: the landing page (site/) swaps in its compact meshes. */
export const meshSource = {
  load: loadSTL,
  frame: async () => (await fetch('models/frame.json')).json(),
};

export class Macropad {
  /** On the table: y up, x right, z toward the default camera. */
  root = new THREE.Group();
  private asm = new THREE.Group();
  private tilt = new THREE.Group();
  layers = {} as Record<LayerName, THREE.Group>;
  caps = new Map<string, { grp: THREE.Group; stem: THREE.Group }>();
  knobs = new Map<string, THREE.Group>();
  oled = new Oled();
  oledMat!: THREE.MeshBasicMaterial;
  micLed!: THREE.MeshBasicMaterial;
  M!: Materials;
  /** Scene-space centre of the key field, the screen, each key and knob (for cameras), filled by build(). */
  anchors = new Map<string, THREE.Vector3>();

  async build() {
    const M = (this.M = makeMaterials());
    const frame = await meshSource.frame() as { tilt_deg: number; pcb_top: number; bore_depth: number; cap_up: number; cap_h: number };
    const [tray, deck, plate, cap1, cap15, cap2, knob] = await Promise.all(['tray', 'deck', 'plate', 'cap1', 'cap15', 'cap2_talk', 'knob'].map((n) => meshSource.load(n)));
    this.root.add(this.asm);
    this.asm.rotation.x = -Math.PI / 2;
    this.asm.add(this.tilt);
    this.tilt.rotation.x = THREE.MathUtils.degToRad(frame.tilt_deg);
    for (const k of Object.keys(EXPLODE) as LayerName[]) { const g = new THREE.Group(); g.name = k; this.tilt.add(g); this.layers[k] = g; }
    const add = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, cast = true) => {
      const o = new THREE.Mesh(g, m); o.castShadow = cast; o.receiveShadow = true; parent.add(o); return o;
    };
    const PCB_TOP = frame.pcb_top, PCB_BOT = PCB_TOP - 1.6;

    // printed parts
    add(tray!, M.case, this.layers.tray);
    add(plate!, M.plate, this.layers.plate);
    add(deck!, M.deck, this.layers.deck);

    // caps with legends; switches under them (housing, cross stem, stabilisers on the 2u)
    for (const k of L.keys) {
      const [cx, cy] = keyCenter(k);
      const geo = k.w >= 2 ? cap2! : k.w === 1.5 ? cap15! : cap1!;
      const mat = (k as any).role === 'ptt' ? M.capGreen : (k as any).role === 'mod' ? M.capGray : M.capWhite;
      const grp = new THREE.Group(); grp.position.set(cx, cy, frame.cap_up); this.layers.caps.add(grp);
      add(geo, mat, grp);
      const ink = (k as any).role === 'ptt' ? 'rgba(0,52,20,0.9)' : (k as any).role === 'mod' ? 'rgba(36,38,34,0.92)' : 'rgba(70,68,74,0.9)';
      if ((k as any).role !== 'ptt') {
        const label = KEYMAP[k.id]![0];
        const tp = textPlane([label], k.w * U - 7, 9, ink, { size: label.length > 5 ? 1.9 : 2.3 });
        tp.position.z = frame.cap_h + 0.02; grp.add(tp);
      }
      const sw = new THREE.Group(); sw.position.set(cx, cy, 0); this.layers.sw.add(sw);
      add(box(15.4, 15.4, 0, 1.2, 0.6), M.housing, sw);
      const top = add(box(14.2, 14.2, 1.2, 5.6, 1.4), M.housing, sw); top.scale.set(1, 1, 1);
      add(box(10.6, 10.6, 5.6, 6.2, 1.0), M.housing, sw);
      const stem = new THREE.Group(); sw.add(stem);
      add(box(4.1, 1.3, 6.0, 10.6), M.stem, stem);
      add(box(1.3, 4.1, 6.0, 10.6), M.stem, stem);
      add(cyl(2.9, 5.6, 6.6, 28), M.stem, stem);
      if ((k as any).stab) for (const sx of [-11.938, 11.938]) {
        const st = add(box(6.6, 11, -1.5, 4.8, 0.8), M.housing, sw); st.position.set(sx, -1.0, 0);
        const ss = add(box(3.2, 3.2, 4.8, 10.2), M.stem, stem); ss.position.set(sx, 0, 0);
      }
      this.caps.set(k.id, { grp, stem });
      this.anchors.set(k.id, new THREE.Vector3(cx, cy, frame.cap_up + frame.cap_h));
    }

    // PCB: black mask, gold pads, hotswap sockets and diodes underneath, module, silkscreen
    {
      const po = L.pcb.outline_mm;
      const s = rrect(po[0]!, po[1]!, po[2]!, po[3]!, L.pcb.corner_r_mm) as THREE.Shape;
      for (const h of L.pcb.holes_mm) { const p = new THREE.Path(); p.absarc(h[0]!, -h[1]!, L.pcb.hole_d_mm / 2, 0, Math.PI * 2, true); s.holes.push(p); }
      const g = new THREE.ExtrudeGeometry(s, { depth: 1.6, bevelEnabled: false, curveSegments: 16 }); g.translate(0, 0, PCB_BOT);
      add(g, M.pcb, this.layers.pcb);
      for (const k of L.keys) {
        const [cx, cy] = keyCenter(k);
        for (const [dx, dy] of [[-3.81, 2.54], [2.54, 5.08]]) { const p = add(cyl(1.3, PCB_TOP, PCB_TOP + 0.04, 20), M.gold, this.layers.pcb, false); p.position.set(cx + dx!, cy + dy!, 0); }
        const c = add(cyl(2.0, PCB_TOP, PCB_TOP + 0.05, 24), M.hole, this.layers.pcb, false); c.position.set(cx, cy, 0);
        const so = add(box(10.9, 5.9, PCB_BOT - 1.8, PCB_BOT, 0.4), M.chip, this.layers.pcb); so.position.set(cx - 0.6, cy + 3.8, 0);
        const di = add(box(2.7, 1.6, PCB_BOT - 1.0, PCB_BOT), M.chip, this.layers.pcb); di.position.set(cx + 7, cy - 4.5, 0);
      }
      const [mx, my] = L.mcu.at as [number, number];
      const mod = add(box(18, 25.5, PCB_BOT - 0.8, PCB_BOT), M.pcb, this.layers.pcb); mod.position.set(mx, -my - 2, 0);
      const can = add(box(15.8, 17.6, PCB_BOT - 3.2, PCB_BOT - 0.8, 0.3), M.steel, this.layers.pcb); can.position.set(mx, -my - 5.5, 0);
      const silk = textPlane(['keybordy MP', 'rev B · ESP32-S3'], 46, 12, 'rgba(238,235,242,0.92)', { size: 3.4, font: 'Anybody', weight: 800 });
      silk.position.set(30.75, -10, PCB_TOP + 0.05); this.layers.pcb.add(silk);
      for (const e of L.encoders) {
        const [ex, ey] = e.at as [number, number];
        const enc = new THREE.Group(); enc.position.set(ex, -ey, 0); this.layers.pcb.add(enc);
        add(box(L.encoder_part.body_mm[0]!, L.encoder_part.body_mm[1]!, PCB_TOP, PCB_TOP + 6.5, 0.4), M.darkMetal, enc);
        add(cyl(3.5, PCB_TOP + 6.5, PCB_TOP + 11.5, 32), M.steel, enc);
        add(cyl(3.0, PCB_TOP + 11.5, PCB_TOP + L.encoder_part.shaft_top_above_pcb_mm, 32), M.steel, enc);
      }
      const hdr = add(box(17.8, 2.5, PCB_TOP, PCB_TOP + 8.5), M.chip, this.layers.pcb); hdr.position.set(L.oled.at[0]!, -(L.oled.at[1]! + 16), 0);
      const usb = add(box(8.9, 7.3, PCB_BOT - 3.2, PCB_BOT, 0.6), M.steel, this.layers.pcb); usb.position.set(L.usb_c.at[0]!, -(L.pcb.outline_mm[1]! + 3.2), 0);
    }

    // battery and speaker on the case floor (the floor drops toward the rear)
    {
      const zf = (ly: number) => -24.94 + ((-ly - 9.5) / -138.06) * 9.94 + 2;
      const b = L.battery, s = L.speaker;
      const bat = add(box(b.box_mm[0]!, b.box_mm[1]!, 0, b.box_mm[2]!, 1.2), M.pouch, this.layers.inner); bat.position.set(b.at[0]!, -b.at[1]!, zf(b.at[1]!));
      const spk = add(box(s.box_mm[0]!, s.box_mm[1]!, 0, s.box_mm[2]!, 1.5), M.speaker, this.layers.inner); spk.position.set(s.at[0]!, -s.at[1]!, zf(s.at[1]!));
    }

    // OLED: module under the deck window, glass, emissive pixel panel
    {
      const o = L.oled, [ox, oy] = o.at as [number, number];
      const m = add(box(o.module_mm[0]!, o.module_mm[1]!, -1.6, 0), M.pcb, this.layers.oled); m.position.set(ox, -oy, 0);
      const gl = add(box(o.active_mm[0]! + 5, o.active_mm[1]! + 7, 0, 1.3, 0.4), M.glass, this.layers.oled); gl.position.set(ox, -oy, 0);
      this.oledMat = new THREE.MeshBasicMaterial({ map: this.oled.tex, color: new THREE.Color(1, 1, 1) });
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(o.active_mm[0]!, o.active_mm[1]!), this.oledMat);
      scr.position.set(ox, -oy, 1.32); this.layers.oled.add(scr);
      this.anchors.set('oled', new THREE.Vector3(ox, -oy, 1.3));
    }

    // knobs on the encoder shafts, with an indicator line on the cap
    for (const e of L.encoders) {
      const [ex, ey] = e.at as [number, number];
      const grp = new THREE.Group(); grp.position.set(ex, -ey, PCB_TOP + L.encoder_part.shaft_top_above_pcb_mm - frame.bore_depth); this.layers.knobs.add(grp);
      add(knob!, M.knob, grp);
      const ind = add(box(1.0, 4.2, L.encoder_part.knob_h_mm - 0.02, L.encoder_part.knob_h_mm + 0.06), new THREE.MeshStandardMaterial({ color: '#e9e6ee', roughness: 0.4 }), grp, false);
      ind.position.set(0, 3.4, 0);
      this.knobs.set(e.id, grp);
      this.anchors.set(e.id, new THREE.Vector3(ex, -ey, PCB_TOP + L.encoder_part.shaft_top_above_pcb_mm - frame.bore_depth + L.encoder_part.knob_h_mm));
    }

    // mic LED behind its 2 mm window in the deck
    this.micLed = new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0, 0) });
    const led = new THREE.Mesh(new THREE.CircleGeometry(1.0, 24), this.micLed);
    led.position.set(L.mic_led.at[0]!, -L.mic_led.at[1]!, 2.2); this.layers.deck.add(led);
    this.anchors.set('mic', new THREE.Vector3(L.mic_led.at[0]!, -L.mic_led.at[1]!, 4));

    // stand it on the table, centred
    this.root.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(this.root);
    const c = bb.getCenter(new THREE.Vector3());
    this.asm.position.set(-c.x, -bb.min.y, -c.z);
    this.root.updateMatrixWorld(true);
    // anchors to table space
    for (const [k, v] of this.anchors) this.anchors.set(k, this.tilt.localToWorld(v.clone()));
    const kf = new THREE.Vector3(3 * U, -4.25 * U, frame.cap_up + frame.cap_h);
    this.anchors.set('keys', this.tilt.localToWorld(kf));
    this.anchors.set('center', bb.getCenter(new THREE.Vector3()).sub(c).add(new THREE.Vector3(0, bb.getSize(new THREE.Vector3()).y / 2, 0)));
    this.pose({});
  }

  /**
   * The case's top outer edge in table space, `n` points round it, starting at the middle of the front
   * edge and running counter-clockwise seen from above (CAD frame: outline OUTER, deck top Z = 4).
   */
  caseOutline(n = 400) {
    const [x0, y0, x1, y1] = [-9.5, -9.5, 123.8, 128.56], r = L.case.corner_r_mm, z = 3.4, inset = 0.25;
    const s = rrect(x0 + inset, y0 + inset, x1 - inset, y1 - inset, r) as THREE.Shape;
    const pts = s.getSpacedPoints(n);
    // rrect starts at the front-left of the bottom edge (CAD y = -y1): rotate so it starts mid-front
    const mid = pts.reduce((b, p, i) => (Math.abs(p.x - (x0 + x1) / 2) + Math.abs(p.y + y1) < Math.abs(pts[b]!.x - (x0 + x1) / 2) + Math.abs(pts[b]!.y + y1) ? i : b), 0);
    const ring = [...pts.slice(mid, -1), ...pts.slice(0, mid)];
    return ring.map((p) => this.tilt.localToWorld(new THREE.Vector3(p.x, p.y, z)));
  }

  /** A key's size in u. */
  keyInfo(id: string) { const k = L.keys.find((x) => x.id === id)!; return { w: k.w, h: k.h }; }

  /** The case's up axis in table space (for explode moves). */
  get size() { return new THREE.Box3().setFromObject(this.root).getSize(new THREE.Vector3()); }

  pose(p: Pose) {
    for (const k of Object.keys(EXPLODE) as LayerName[]) {
      this.layers[k].position.z = p.lift?.[k] ?? 0;
      this.layers[k].visible = (p.show?.[k] ?? 1) > 0;
    }
    for (const [id, c] of this.caps) {
      const d = -4 * (p.press?.[id] ?? 0);
      c.grp.position.z = 7 + d;
      c.stem.position.z = d;
    }
    for (const [id, g] of this.knobs) g.rotation.z = -((p.knob?.[id] ?? 0) * Math.PI * 2) / 24;
    this.oled.draw(p.oled ?? { mode: 'logo' });
    const gain = p.oledGain ?? 1.6;
    this.oledMat.color.setRGB(gain, gain, gain);
    const m = p.mic ?? 0;
    this.micLed.color.setRGB(0.68 * 6 * m, 1.0 * 6 * m, 0.012 * 6 * m);
  }
}
