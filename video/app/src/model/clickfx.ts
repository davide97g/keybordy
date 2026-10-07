// v3 clicks, in the 3D set: the key itself goes off. For a click at t0 (lt = t - t0):
//   aura       the cap flashes lime (an additive shell round the real cap), stays lit while held
//   shards     lime and white shards burst up out of the cap and fall back (gravity, spin, shrink)
//   shockwave  a ring runs out across the keys from the cap
//   light      a lime point light at the cap, so the neighbouring caps catch the flash
// Everything is a pure function of (t, the bursts); HDR colours above 1 feed the bloom, and the export's
// sub-frames give the shards real motion blur.
import * as THREE from 'three';
import { hash } from '../engine/util';
import type { Macropad } from './macropad';

export interface Burst { key: string; t0: number; lt: number; hold: number }

const LIME = new THREE.Color(0.68, 1.0, 0.012); // #d6ff1f, linear
const SHARDS = 30, POOL = 4, LIFE = 0.75, G = -1400; // mm/s²

export class ClickFX {
  group = new THREE.Group();
  private auras = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>();
  private shards: THREE.InstancedMesh;
  private rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  light = new THREE.PointLight(LIME, 0, 110, 0);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();

  constructor(private pad: Macropad) {
    // auras: a clone of each cap mesh, 4 % larger, additive
    for (const [id, c] of pad.caps) {
      const cap = c.grp.children[0] as THREE.Mesh;
      const mat = new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
      const a = new THREE.Mesh(cap.geometry, mat);
      a.scale.set(1.045, 1.045, 1.03); a.position.z = -0.15; a.visible = false; a.renderOrder = 2;
      c.grp.add(a);
      this.auras.set(id, a);
    }
    // shards: thin octahedra, lime or white per instance
    const g = new THREE.OctahedronGeometry(1, 0); g.scale(0.55, 0.55, 2.2);
    this.shards = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), SHARDS * POOL);
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < SHARDS * POOL; i++) {
      const white = i % 5 === 0;
      this.shards.setColorAt(i, white ? new THREE.Color(4, 4, 4.2) : LIME.clone().multiplyScalar(5));
    }
    this.shards.frustumCulled = false;
    this.group.add(this.shards);
    for (let i = 0; i < POOL; i++) {
      const r = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 96), new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      r.rotation.x = -Math.PI / 2; r.visible = false; r.renderOrder = 3;
      this.group.add(r); this.rings.push(r);
    }
    this.group.add(this.light);
  }

  update(bursts: Burst[]) {
    for (const a of this.auras.values()) a.visible = false;
    for (const r of this.rings) r.visible = false;
    this.light.intensity = 0;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < SHARDS * POOL; i++) this.shards.setMatrixAt(i, zero);
    const live = bursts.filter((b) => b.lt >= 0 && b.lt < Math.max(LIFE, b.hold + 0.3)).slice(-POOL);
    let brightest = -1;
    live.forEach((b, slot) => {
      const top = this.pad.anchors.get(b.key);
      if (!top) return;
      const k = this.pad.keyInfo(b.key);
      const seed = Math.round(b.t0 * 1000);
      const flash = Math.exp(-b.lt / 0.11);
      const held = b.hold > 0.3 && b.lt < b.hold ? 0.35 + 0.15 * Math.sin(b.lt * 22) : 0;
      // aura
      const a = this.auras.get(b.key)!;
      a.visible = true;
      a.material.opacity = Math.min(0.85, flash * 0.9 + held);
      a.material.color.copy(LIME).multiplyScalar(1.1);
      // shockwave across the keys, a little under the cap tops
      const ring = this.rings[slot]!;
      const u = b.lt / 0.5;
      if (u < 1) {
        const r0 = (k.w * 19.05) / 2;
        ring.visible = true;
        ring.position.set(top.x, top.y - 5, top.z);
        const rad = r0 * (1 + 4.2 * (1 - (1 - u) ** 3));
        ring.scale.set(rad * (k.w > 1 ? 1.25 : 1), rad, 1);
        ring.material.opacity = (1 - u) ** 2 * 0.8;
        ring.material.color.copy(LIME).multiplyScalar(2);
      }
      // shards
      for (let i = 0; i < SHARDS; i++) {
        const h = (n: number) => hash(seed, i, n);
        const life = LIFE * (0.6 + 0.4 * h(1));
        const lt = b.lt - 0.004 * h(2);
        if (lt < 0 || lt > life) continue;
        const az = 2 * Math.PI * h(3), el = (0.35 + 0.6 * h(4)) * Math.PI / 2;
        const sp = 180 + 320 * h(5);
        const dir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
        const p = new THREE.Vector3(top.x + (h(6) - 0.5) * k.w * 12, top.y + 0.5, top.z + (h(7) - 0.5) * 12)
          .addScaledVector(dir, sp * lt).add(new THREE.Vector3(0, 0.5 * G * lt * lt, 0));
        const vel = dir.clone().multiplyScalar(sp).add(new THREE.Vector3(0, G * lt, 0));
        // long axis along the velocity, tumbling a little
        this.q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), vel.clone().normalize());
        this.e.set(lt * 9 * (h(8) - 0.5), 0, lt * 11 * (h(9) - 0.5));
        this.q.multiply(new THREE.Quaternion().setFromEuler(this.e));
        const s = (0.7 + 0.8 * h(10)) * (1 - (lt / life) ** 2);
        this.m.compose(p, this.q, new THREE.Vector3(s, s, s * (1 + Math.min(2.5, vel.length() / 260))));
        this.shards.setMatrixAt(slot * SHARDS + i, this.m);
      }
      if (brightest < 0 || b.lt < live[brightest]!.lt) brightest = slot;
    });
    if (brightest >= 0) {
      const b = live[brightest]!, top = this.pad.anchors.get(b.key)!;
      this.light.position.set(top.x, top.y + 14, top.z);
      this.light.intensity = 2.6 * Math.exp(-b.lt / 0.12) + (b.hold > 0.3 && b.lt < b.hold ? 0.8 : 0);
    }
    this.shards.instanceMatrix.needsUpdate = true;
  }
}
