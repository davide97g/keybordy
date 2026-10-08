// The 3D stage behind the hero and the story: the teaser's own model (real CAD meshes, printed-PLA
// shader, OLED, click bursts, edge light) in a black studio, with a camera the page's scroll position
// flies between chapter shots. Everything that moves eases toward a target every frame, so scrolling,
// pointer parallax and key presses all blend.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Macropad, KEYMAP, EXPLODE, meshSource, type LayerName, type Pose } from '@model/macropad';
import { ClickFX, type Burst } from '@model/clickfx';
import { EdgeTrace } from '@model/trace';
import type { OledState } from '@model/oled';
import { ACTIONS } from './keymap';

type V3 = [number, number, number];
export type ShotName = 'hero' | 'keys' | 'oled' | 'knobs' | 'talk' | 'explode' | 'final';

interface Shot { target: V3; az: number; el: number; r: number; fov: number; sx: number; sy: number; explode: number; rim: number; accent: number }

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const LAYERS = Object.keys(EXPLODE) as LayerName[];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── meshes: the compact KBM1 files written by scripts/meshes.ts ─────────────
let manifest: Record<string, number> = {};
let loaded = 0;
let onBytes: (f: number) => void = () => {};

async function fetchBuffer(url: string, expected: number) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; loaded += value.length;
    onBytes(loaded / Object.values(manifest).reduce((a, b) => a + b, 0));
  }
  if (expected && got !== expected) console.warn(`${url}: ${got} bytes, expected ${expected}`);
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

async function loadKBM(name: string) {
  const buf = await fetchBuffer(`/models/${name}.kbm`, manifest[name] ?? 0);
  const dv = new DataView(buf);
  const n = dv.getUint32(4, true), ni = dv.getUint32(8, true);
  const f = (i: number) => dv.getFloat32(12 + i * 4, true);
  const min = [f(0), f(1), f(2)], step = [f(3), f(4), f(5)];
  const q = new Uint16Array(buf, 36, n * 3);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) pos[i] = min[i % 3]! + q[i]! * step[i % 3]!;
  const off = 36 + n * 6 + ((n * 6) % 4 ? 2 : 0);
  const idx = n > 65535 ? new Uint32Array(buf, off, ni) : new Uint16Array(buf, off, ni);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return toCreasedNormals(g, THREE.MathUtils.degToRad(32));
}

// ── the stage ──────────────────────────────────────────────────────────────
export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(28, 1, 2, 6000);
  pad = new Macropad();
  fx!: ClickFX;
  trace!: EdgeTrace;
  composer!: EffectComposer;
  bloom!: UnrealBloomPass;
  key = new THREE.SpotLight('#fff3e6', 1.15, 0, 0.42, 1, 0);
  rim = new THREE.RectAreaLight('#e9e6ff', 0, 520, 24);
  accent = new THREE.RectAreaLight('#d6ff1f', 0, 300, 14);
  sides: THREE.RectAreaLight[] = [];
  fill = new THREE.HemisphereLight('#f4f1f8', '#070608', 0.03);

  /** Which shot each scroll anchor holds, and how far the page is between two of them (set by the page). */
  from: ShotName = 'hero';
  to: ShotName = 'hero';
  blend = 0;
  /** Local 0..1 progress of each chapter through the viewport (set by the page). */
  local: Partial<Record<ShotName, number>> = {};
  active = true;
  pointer = new THREE.Vector2();
  private pointerEased = new THREE.Vector2();
  private cur: Shot | null = null;
  private clock = new THREE.Clock();
  private t = 0;
  private bootAt = -1;
  private bursts: { key: string; t0: number; hold: number; up: number }[] = [];
  private press: Record<string, number> = {};
  private knob: Record<string, number> = { E1: 0, E2: 0, E3: 0 };
  private userOled: { s: OledState; until: number } | null = null;
  private talkHeld = false;
  private talkStart = 0;
  private talkRelease = -10;
  private chapterSeq = 0;
  private lastChapter: ShotName = 'hero';
  private traceStart = -10;
  private capMeshes = new Map<THREE.Object3D, string>();
  private ray = new THREE.Raycaster();
  private size = { w: 0, h: 0 };
  onLayer: (i: number) => void = () => {};
  onKnob: (v: number) => void = () => {};
  onPress: (id: string) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x070608, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
  }

  async init(progress: (f: number) => void) {
    onBytes = progress;
    manifest = await (await fetch('/models/manifest.json')).json();
    meshSource.load = loadKBM;
    meshSource.frame = async () => (await fetch('/models/frame.json')).json();
    // the caps carry their K number only (the trailer shows action names; the real caps do not)
    for (const id of Object.keys(KEYMAP)) KEYMAP[id]![0] = id;

    const r = this.renderer, sc = this.scene;
    const mobile = innerWidth < 720;
    r.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.5 : 1.75));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    RectAreaLightUniformsLib.init();
    await this.pad.build();
    this.fx = new ClickFX(this.pad);
    this.trace = new EdgeTrace(this.pad);
    sc.background = new THREE.Color(0x070608);
    sc.fog = new THREE.Fog(0x070608, 420, 1500);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshPhysicalMaterial({ color: '#030304', roughness: 0.82, envMapIntensity: 0.02 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    sc.add(this.pad.root, floor, this.fill, this.rim, this.accent, this.key, this.key.target, this.fx.group, this.trace.group);
    for (const x of [-1, 1]) {
      const l = new THREE.RectAreaLight('#f4f1f8', 0, 14, 260);
      l.position.set(x * 260, 150, -260); l.lookAt(0, 35, 0);
      this.sides.push(l); sc.add(l);
    }
    this.key.position.set(180, 420, 240);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    this.key.shadow.bias = -0.0001; this.key.shadow.normalBias = 0.15;
    this.key.shadow.camera.near = 100; this.key.shadow.camera.far = 1200;
    this.key.penumbra = 0.8;
    const pmrem = new THREE.PMREMGenerator(r);
    sc.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    sc.environmentIntensity = 0.35;
    sc.environmentRotation.set(0, 1.1, 0);

    for (const [id, c] of this.pad.caps) this.capMeshes.set(c.grp.children[0]!, id);

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(sc, this.camera));
    // a NaN from a degenerate pixel would smear black across the frame through the bloom's blur chain
    this.composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0); gl_FragColor = min(c, vec4(64.0)); }',
    }));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize(true);
    // compile everything before the loader lifts, so the first scroll does not stutter
    this.camera.position.set(0, 200, 400); this.camera.lookAt(0, 0, 0);
    await r.compileAsync(sc, this.camera);
  }

  boot() { this.bootAt = this.t; this.traceStart = this.t + 0.15; }

  resize(force = false) {
    const w = innerWidth, h = Math.max(window.visualViewport?.height ?? 0, innerHeight);
    // mobile URL bars change the height on scroll: ignore small height changes
    if (!force && w === this.size.w && Math.abs(h - this.size.h) < 140) return;
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ── shots ────────────────────────────────────────────────────────────────
  private shot(name: ShotName): Shot {
    const a = this.pad.anchors, v = (k: string, dy = 0): V3 => { const p = a.get(k)!; return [p.x, p.y + dy, p.z]; };
    const wide = innerWidth >= 720;
    // card on the left: device to the right (negative x offset), and the other way round; on a phone
    // the cards sit at the bottom, so the device moves up
    const side = (dir: number) => (wide ? { sx: -dir * 0.17, sy: 0 } : { sx: 0, sy: 0.13 });
    switch (name) {
      case 'hero': return { target: [0, 16, 4], az: 0.55, el: 0.36, r: 500, fov: 28, ...(wide ? { sx: -0.25, sy: 0.02 } : { sx: 0, sy: -0.2 }), explode: 0, rim: 18, accent: 3 };
      case 'keys': return { target: v('keys'), az: 0.08, el: 1.02, r: 255, fov: 30, ...side(1), explode: 0, rim: 10, accent: 2 };
      case 'oled': return { target: v('oled'), az: -0.5, el: 0.6, r: 150, fov: 26, ...side(-1), explode: 0, rim: 14, accent: 2 };
      case 'knobs': return { target: v('E2', -2), az: 0.62, el: 0.42, r: 132, fov: 26, ...side(1), explode: 0, rim: 22, accent: 4 };
      case 'talk': return { target: v('K21'), az: -0.3, el: 0.62, r: 175, fov: 28, ...side(-1), explode: 0, rim: 12, accent: 6 };
      case 'explode': return { target: [0, 78, 0], az: 0.82, el: 0.3, r: 560, fov: 28, ...(wide ? { sx: -0.18, sy: 0 } : { sx: 0, sy: -0.06 }), explode: 1, rim: 24, accent: 3 };
      case 'final': return { target: [0, 18, 0], az: -0.62, el: 0.32, r: 430, fov: 28, sx: 0, sy: wide ? -0.3 : -0.2, explode: 0, rim: 26, accent: 5 };
    }
  }

  private mix(a: Shot, b: Shot, t: number): Shot {
    const l = (x: number, y: number) => x + (y - x) * t;
    return {
      target: [l(a.target[0], b.target[0]), l(a.target[1], b.target[1]), l(a.target[2], b.target[2])],
      az: l(a.az, b.az), el: l(a.el, b.el), r: l(a.r, b.r), fov: l(a.fov, b.fov), sx: l(a.sx, b.sx), sy: l(a.sy, b.sy),
      explode: l(a.explode, b.explode), rim: l(a.rim, b.rim), accent: l(a.accent, b.accent),
    };
  }

  // ── interaction ──────────────────────────────────────────────────────────
  /** Press a key; `hold` true keeps it down until release(). */
  down(id: string, hold = false) {
    if (!this.pad.caps.has(id)) return;
    const b = { key: id, t0: this.t, hold: hold ? 99 : 0.12, up: hold ? -1 : this.t + 0.12 };
    this.bursts.push(b);
    if (this.bursts.length > 8) this.bursts.shift();
    if (id === 'K21') { this.talkHeld = true; this.talkStart = this.t; }
    else {
      const [label, detail] = ACTIONS[id] ?? [id, ''];
      this.userOled = { s: { mode: 'key', label, detail }, until: this.t + 1.8 };
    }
    this.onPress(id);
  }
  up(id: string) {
    for (const b of this.bursts) if (b.key === id && b.up < 0) { b.up = this.t; b.hold = this.t - b.t0; }
    if (id === 'K21' && this.talkHeld) {
      this.talkHeld = false; this.talkRelease = this.t;
      this.userOled = { s: { mode: 'listen', t: 0, transcript: 'open my notes' }, until: this.t + 2.2 };
    }
  }
  /** The key under a screen point (CSS px), if any. */
  pick(x: number, y: number) {
    this.ray.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / this.size.h) * 2 + 1), this.camera);
    const hit = this.ray.intersectObjects([...this.capMeshes.keys()], false)[0];
    return hit ? this.capMeshes.get(hit.object) ?? null : null;
  }

  // ── frame ────────────────────────────────────────────────────────────────
  frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.t += dt;
    if (!this.active || document.hidden) return;
    const t = this.t;
    const near: ShotName = this.blend < 0.5 ? this.from : this.to;
    if (near !== this.lastChapter) { this.lastChapter = near; this.chapterSeq = t; if (near === 'final') this.traceStart = t + 0.2; }
    const since = t - this.chapterSeq;

    // camera target from the scroll position, eased
    const goal = this.mix(this.shot(this.from), this.shot(this.to), smooth(0, 1, this.blend));
    const pe = this.pointerEased.lerp(this.pointer, 1 - Math.exp(-dt * 3));
    const sway = reduced ? 0 : Math.sin(t * 0.23) * 0.05;
    goal.az += sway + pe.x * 0.14 * (1 - goal.explode * 0.5);
    goal.el = clamp(goal.el + pe.y * 0.06, 0.08, 1.35);
    // the explode chapter scrubs its own lift, rising in and settling back before the last shot
    const ep = this.local.explode ?? 0;
    const explodeAmt = (this.from === 'explode' || this.to === 'explode') ? smooth(0.12, 0.42, ep) * (1 - smooth(0.78, 0.97, ep)) : 0;
    goal.explode = explodeAmt;
    const portrait = this.size.w / this.size.h < 1 ? Math.max(1, 0.8 / (this.size.w / this.size.h)) : 1;
    goal.r *= portrait;
    if (!this.cur) {
      // intro: start high and far, the damping flies it in
      this.cur = { ...goal, r: goal.r * (reduced ? 1 : 2.1), el: reduced ? goal.el : 1.05, az: goal.az + (reduced ? 0 : 0.9) };
    }
    const k = reduced ? 1 : 1 - Math.exp(-dt * (t < 3 ? 1.6 : 4.2));
    const c = this.cur = this.mix(this.cur, goal, k);
    c.explode = goal.explode; // scrubbed directly: it already follows the scroll

    const cam = this.camera;
    cam.fov = c.fov;
    const tg = new THREE.Vector3(...c.target);
    cam.position.set(tg.x + Math.sin(c.az) * Math.cos(c.el) * c.r, tg.y + Math.sin(c.el) * c.r, tg.z + Math.cos(c.az) * Math.cos(c.el) * c.r);
    cam.lookAt(tg);
    const { w, h } = this.size;
    cam.setViewOffset(w, h, c.sx * w, c.sy * h, w, h);
    cam.updateProjectionMatrix();

    // lights
    this.key.target.position.copy(tg).setY(Math.min(tg.y, 40));
    this.key.target.updateMatrixWorld();
    this.rim.intensity = c.rim; this.rim.position.set(40, 120, -300); this.rim.lookAt(0, 30, 0);
    this.accent.intensity = c.accent; this.accent.color.set('#b9a8ff'); this.accent.position.set(320, 50, 80); this.accent.lookAt(0, 30, 0);
    for (const l of this.sides) l.intensity = 6 + 10 * c.explode;

    // device pose
    const pose: Pose = { lift: {}, press: {}, knob: {}, mic: 0, oledGain: 1.6 };
    for (const L of LAYERS) pose.lift![L] = EXPLODE[L] * c.explode;
    const press: Record<string, number> = {};
    // keys chapter: a wave rolls across the field from K1 every 2.6 s
    if (near === 'keys' && !reduced) {
      const ph = (since % 2.6) - 0.3;
      for (const [id] of this.pad.caps) {
        const kk = this.pad.anchors.get(id)!, k1 = this.pad.anchors.get('K1')!;
        const d = Math.hypot(kk.x - k1.x, kk.z - k1.z) / 140;
        const x = (ph - d * 0.9) / 0.12;
        press[id] = Math.max(0, 1 - x * x) * 0.8;
      }
    }
    // OLED chapter: a demo press every 1.15 s
    let oled: OledState = { mode: 'logo' };
    if (near === 'oled') {
      const seq = ['K1', 'K4', 'K9', 'K15', 'K10', 'K7', 'K17'];
      const i = Math.floor(since / 1.15), lt = since - i * 1.15;
      const id = seq[i % seq.length]!;
      if (lt < 0.03 && !this.bursts.some((b) => b.key === id && t - b.t0 < 0.5)) this.down(id);
      const [label, detail] = ACTIONS[id] ?? [id, ''];
      oled = { mode: 'key', label, detail };
    }
    // knobs chapter: scroll turns them
    if (near === 'knobs' || this.from === 'knobs' || this.to === 'knobs') {
      const kp = this.local.knobs ?? 0;
      this.knob.E1 = kp * 40; this.knob.E2 = -kp * 24; this.knob.E3 = kp * 18;
      const v = Math.round(clamp(20 + kp * 90, 0, 100));
      if (near === 'knobs') oled = { mode: 'knob', name: 'VOLUME', value: v };
      this.onKnob(v);
    }
    // talk chapter: the bar stays held, the mic LED on, the panel listening
    let talking = this.talkHeld;
    if (near === 'talk') {
      const cyc = since % 4.2;
      if (cyc < 2.8) { talking = true; press.K21 = 1; }
      else oled = { mode: 'listen', t: 0, transcript: 'open my notes' };
      if (cyc < 2.8) oled = { mode: 'listen', t };
    }
    if (this.talkHeld) { press.K21 = 1; oled = { mode: 'listen', t }; }
    pose.mic = talking ? 0.7 + 0.3 * Math.sin(t * 6) : 0;
    // explode chapter: highlight the layer list
    if (near === 'explode') this.onLayer(explodeAmt > 0.6 ? Math.floor(clamp((ep - 0.42) / 0.36) * LAYERS.length * 0.999) : -1);
    // boot: the OLED wipes in
    if (this.bootAt >= 0 && t - this.bootAt < 1.6) oled = { mode: 'boot', p: (t - this.bootAt) / 1.6 };
    if (this.userOled && t < this.userOled.until && !this.talkHeld) oled = this.userOled.s;

    // user and demo presses: 40 ms down, held while held, 70 ms up
    const live: Burst[] = [];
    for (const b of this.bursts) {
      const lt = t - b.t0;
      const upT = b.up < 0 ? Infinity : b.up;
      const down = smooth(0, 0.04, lt) * (1 - smooth(upT - b.t0, upT - b.t0 + 0.07, lt));
      press[b.key] = Math.max(press[b.key] ?? 0, down);
      live.push({ key: b.key, t0: b.t0, lt, hold: b.up < 0 ? lt + 1 : b.hold });
    }
    this.bursts = this.bursts.filter((b) => b.up < 0 || t - b.t0 < 1.2);
    for (const id in press) this.press[id] = press[id]!;
    for (const id in this.press) if (!(id in press)) this.press[id] = 0;
    pose.press = this.press;
    pose.knob = this.knob;
    pose.oled = oled;
    this.pad.pose(pose);
    this.fx.update(live);

    // edge light: on boot and when the last shot comes in
    const tp = (t - this.traceStart) / 1.5;
    if (tp > -0.01 && tp < 2.2) this.trace.update(smooth(0, 1, tp), 2.4 * smooth(0, 0.2, tp) * (1 - smooth(1.1, 2.1, tp)), tp < 1 ? 6 : 0);
    else this.trace.update(0, 0, 0);

    this.composer.render(dt);
  }
}
