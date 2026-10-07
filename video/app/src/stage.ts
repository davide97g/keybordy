// The product stage shared by every 3D scene: the macropad, a black studio (floor, fog), the light rig,
// a studio HDRI for reflections, and a camera rig. One instance for the whole video (scenes pose it on
// every render, so nothing carries over between frames).
//
// Lens effects come from the export's motion-blur sub-frames (engine.ts): while sub-frames are being
// averaged (SS_TAP >= 0) each one gets its own sub-pixel offset (anti-aliasing), its own point on the lens
// aperture (depth of field, thin lens: the camera moves on a disk and keeps looking at the focus point)
// and its own point on the key light's emitter (soft shadows). The samples are seeded from the sub-frame
// time, and the adaptive sampler keeps adding sub-frames until they have converged. The preview (one
// sample) shows the pinhole image.
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { W, H, PW, PH, SS_TAP, type Compositor } from './engine/gl';
import { hash } from './engine/util';
import { Macropad, type Pose } from './model/macropad';
import { VERSION } from './version';
import { ClickFX, type Burst } from './model/clickfx';
import { Atmos } from './model/atmos';
import { EdgeTrace } from './model/trace';

export type V3 = [number, number, number];

export interface Shot {
  cam: V3;
  at: V3;
  fov: number;
  roll?: number;
  /** Lens aperture radius in mm (0: pinhole). Focus is at `at` unless `focus` is given. */
  aperture?: number;
  focus?: V3;
  /** Key light (soft spot with shadows): position, intensity, emitter radius in mm. */
  key?: { pos?: V3; intensity?: number; radius?: number; color?: string; angle?: number };
  /** Rim light: a long softbox strip behind the product. `x` slides it across (a sweep). */
  rim?: { intensity?: number; pos?: V3; at?: V3; w?: number; h?: number; color?: string };
  /** Second accent strip (lime or lavender) from the side. */
  accent?: { intensity?: number; pos?: V3; at?: V3; w?: number; h?: number; color?: string };
  env?: number;
  floor?: number;
  /** A flat screen floating in the set (the keymap editor in v2): w x h mm, its centre, Euler rotation. */
  panel?: { tex: THREE.Texture; pos: V3; rot?: V3; w: number; h: number; gain?: number };
  /** v5: light running round the case edge (model/trace.ts). */
  trace?: { p: number; glow: number; head: number };
  /** v5: two more backlight strips, left and right behind the device (silhouette edges). */
  sides?: { intensity: number; color?: string };
  /** v4: the light shaft and the dust (model/atmos.ts), 0..1+. */
  atmos?: { beam?: number; dust?: number };
  /** Upright cut: lens shift, the image moves up by this fraction of the frame height (perspective unchanged). */
  shift?: number;
  /** Upright cut: fog distances times this (a camera pulled back keeps the v5 falloff on the subject). */
  fog?: number;
  /** v3: clicks going off in the set (model/clickfx.ts). */
  bursts?: Burst[];
  pose: Pose;
}

let instance: Promise<Stage> | null = null;
/** The one stage (built once, shared by every scene). */
export function getStage(renderer: THREE.WebGLRenderer) {
  instance ??= Stage.create(renderer);
  return instance;
}

export class Stage {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, PW / PH, 2, 6000);
  pad = new Macropad();
  key = new THREE.SpotLight('#fff3e6', 1, 0, 0.42, 1, 0);
  rim = new THREE.RectAreaLight('#e9e6ff', 0, 420, 26);
  accent = new THREE.RectAreaLight('#d6ff1f', 0, 300, 14);
  fill = new THREE.HemisphereLight('#f4f1f8', '#070608', 0.05);
  floor: THREE.Mesh;
  floorMat: THREE.MeshPhysicalMaterial;
  panel: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  fx: ClickFX | null = null;
  atmos: Atmos | null = null;
  trace: EdgeTrace | null = null;
  sides: THREE.RectAreaLight[] = [];
  /** Multisampled HDR target the stage renders into before it is copied to the scene's output. */
  rt = new THREE.WebGLRenderTarget(PW, PH, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });

  private constructor(private renderer: THREE.WebGLRenderer) {
    this.floorMat = new THREE.MeshPhysicalMaterial({ color: '#030304', roughness: 0.55, clearcoat: 0, envMapIntensity: 0.03 });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    // the panel: rounded corners through an alpha map, unlit, outside the fog
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1000;
    const g = c.getContext('2d')!; g.fillStyle = '#000'; g.fillRect(0, 0, 1600, 1000);
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect(0, 0, 1600, 1000, 28); g.fill();
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ alphaMap: new THREE.CanvasTexture(c), transparent: true, fog: false }));
    this.panel.visible = false;
  }

  /** Logical (W x H) screen position of a world point in the last rendered shot, without the lens jitter. */
  project(v: THREE.Vector3) {
    const cam = this.camera.clone();
    cam.clearViewOffset();
    if (this.lastPinhole) cam.position.copy(this.lastPinhole);
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const p = v.clone().project(cam);
    return { x: (p.x + 1) * W / 2, y: (1 - p.y) * H / 2 - this.lastShift * H, z: p.z };
  }
  private lastPinhole: THREE.Vector3 | null = null;
  private lastShift = 0;

  static async create(renderer: THREE.WebGLRenderer) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    RectAreaLightUniformsLib.init();
    const s = new Stage(renderer);
    await s.pad.build();
    const sc = s.scene;
    sc.background = new THREE.Color(0, 0, 0);
    sc.fog = new THREE.Fog(0x000000, 380, 1400);
    sc.add(s.pad.root, s.floor, s.fill, s.rim, s.accent, s.key, s.key.target, s.panel);
    if (VERSION >= 3) { s.fx = new ClickFX(s.pad); sc.add(s.fx.group); }
    if (VERSION >= 4) { s.atmos = new Atmos(); sc.add(s.atmos.group); }
    if (VERSION >= 5) {
      s.trace = new EdgeTrace(s.pad); sc.add(s.trace.group);
      for (const x of [-1, 1]) {
        const l = new THREE.RectAreaLight('#f4f1f8', 0, 14, 260);
        l.position.set(x * 260, 150, -260); l.lookAt(0, 35, 0);
        s.sides.push(l); sc.add(l);
      }
    }
    s.key.castShadow = true;
    s.key.shadow.mapSize.set(4096, 4096);
    s.key.shadow.bias = -0.00008;
    s.key.shadow.normalBias = 0.12;
    s.key.shadow.camera.near = 100;
    s.key.shadow.camera.far = 2000;
    // environment: Poly Haven studio HDRI (reflections only; the background stays black)
    const pmrem = new THREE.PMREMGenerator(renderer);
    try {
      const hdr = await new HDRLoader().loadAsync('vendor/hdri/studio_small_09_2k.hdr');
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      sc.environment = pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose();
    } catch {
      sc.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    }
    sc.environmentRotation.set(0, 1.1, 0);
    return s;
  }

  /** Pose everything for one sub-frame at time t and render into `out` (linear HDR). */
  render(t: number, shot: Shot, out: THREE.WebGLRenderTarget, comp: Compositor) {
    const r = this.renderer;
    const acc = SS_TAP.value >= 0; // averaging sub-frames: take one lens/light sample
    // v1 seeds the lens/light samples with the time, so every frame draws a new set (it shimmers until it
    // converges). v2 seeds them with the sub-frame's place in the shutter, the same set every frame: the
    // blur is steady from one frame to the next.
    const seed = VERSION >= 2 ? Math.round((t * 60 - Math.round(t * 60)) * 1e6) : t * 7919.0;
    const h1 = hash(seed, 1), h2 = hash(seed, 2), h3 = hash(seed, 3), h4 = hash(seed, 4);
    const h5 = hash(seed, 5), h6 = hash(seed, 6);
    this.pad.pose(shot.pose);

    // camera with a thin lens: the camera moves on the aperture disk, keeps its orientation, and the
    // frustum is sheared so the focus plane stays put (exact accumulation depth of field)
    const cam = this.camera, at = new THREE.Vector3(...shot.at), pos = new THREE.Vector3(...shot.cam);
    cam.fov = shot.fov;
    cam.aspect = PW / PH;
    cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(at);
    if (shot.roll) cam.rotateZ(shot.roll);
    this.lastPinhole = cam.position.clone();
    let ox = 0, oy = 0;
    if (acc) {
      ox = h3 - 0.5; oy = h4 - 0.5; // sub-pixel anti-aliasing
      // v2: a third of the lens: only a hint of depth, so text off the focus plane stays readable
      const aperture = (shot.aperture ?? 0) * (VERSION >= 2 ? 0.3 : 1);
      if (aperture > 0) {
        const fwd = cam.getWorldDirection(new THREE.Vector3());
        const F = Math.max(1, new THREE.Vector3(...(shot.focus ?? shot.at)).sub(pos).dot(fwd));
        const a = 2 * Math.PI * h1, rr = Math.sqrt(h2) * aperture;
        const dx = Math.cos(a) * rr, dy = Math.sin(a) * rr;
        cam.translateX(dx); cam.translateY(dy);
        const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
        ox += -(dx / F) / (tanH * cam.aspect) * (PW / 2);
        oy += (dy / F) / tanH * (PH / 2);
      }
    }
    this.lastShift = shot.shift ?? 0;
    oy += this.lastShift * PH;
    if (acc || oy !== 0) cam.setViewOffset(PW, PH, ox, oy, PW, PH);
    else cam.clearViewOffset();
    const fog = this.scene.fog as THREE.Fog;
    fog.near = 380 * (shot.fog ?? 1); fog.far = 1400 * (shot.fog ?? 1);
    cam.updateProjectionMatrix();

    // lights
    const k = shot.key ?? {};
    const kp = new THREE.Vector3(...(k.pos ?? [180, 420, 240]));
    if (acc && (k.radius ?? 40) > 0) {
      const a = 2 * Math.PI * h5, rr = Math.sqrt(h6) * (k.radius ?? 40);
      kp.x += Math.cos(a) * rr; kp.z += Math.sin(a) * rr;
    }
    this.key.position.copy(kp);
    this.key.target.position.set(...shot.at);
    this.key.intensity = k.intensity ?? 2.4;
    this.key.angle = k.angle ?? 0.42;
    this.key.color.set(k.color ?? '#fff3e6');
    this.key.target.updateMatrixWorld();
    const rim = shot.rim ?? {};
    this.rim.intensity = rim.intensity ?? 0;
    this.rim.width = rim.w ?? 420; this.rim.height = rim.h ?? 26;
    this.rim.color.set(rim.color ?? '#e9e6ff');
    this.rim.position.set(...(rim.pos ?? [0, 90, -260]));
    this.rim.lookAt(...(rim.at ?? [0, 10, 0]));
    const ac = shot.accent ?? {};
    this.accent.intensity = ac.intensity ?? 0;
    this.accent.width = ac.w ?? 300; this.accent.height = ac.h ?? 14;
    this.accent.color.set(ac.color ?? '#d6ff1f');
    this.accent.position.set(...(ac.pos ?? [-300, 60, 60]));
    this.accent.lookAt(...(ac.at ?? [0, 10, 0]));
    this.scene.environmentIntensity = shot.env ?? 0.35;
    this.floor.visible = (shot.floor ?? 1) > 0;
    this.fx?.update(shot.bursts ?? []);
    this.atmos?.update(t, shot.atmos?.beam ?? 0, shot.atmos?.dust ?? 0);
    this.trace?.update(shot.trace?.p ?? 0, shot.trace?.glow ?? 0, shot.trace?.head ?? 0);
    for (const l of this.sides) { l.intensity = shot.sides?.intensity ?? 0; l.color.set(shot.sides?.color ?? '#f4f1f8'); }
    const pn = shot.panel;
    this.panel.visible = !!pn;
    if (pn) {
      const m = this.panel.material;
      if (m.map !== pn.tex) { m.map = pn.tex; m.needsUpdate = true; }
      m.color.setScalar(pn.gain ?? 0.92);
      this.panel.position.set(...pn.pos);
      this.panel.rotation.set(...(pn.rot ?? [0, 0, 0]));
      this.panel.scale.set(pn.w, pn.h, 1);
      this.panel.updateMatrixWorld();
    }

    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);
    r.render(this.scene, cam);
    comp.draw(r, this.rt.texture, out, { mode: 'replace' });
  }
}
