// v5: light running along the case's top edge. Two glowing lines leave the middle of the front edge in
// opposite directions and meet at the back, each with a bright head; then the whole outline glows and
// fades. A tube along the outline, drawn up to the head with setDrawRange.
import * as THREE from 'three';
import type { Macropad } from './macropad';

const SEG = 400;

export class EdgeTrace {
  group = new THREE.Group();
  private halves: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>[] = [];
  private heads: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
  private paths: THREE.CatmullRomCurve3[] = [];

  constructor(pad: Macropad) {
    const ring = pad.caseOutline(SEG);
    const half = SEG / 2;
    const a = ring.slice(0, half + 1);                                  // front-middle → back-middle one way
    const b = [ring[0]!, ...ring.slice(half).reverse()];                // and the other way
    for (const pts of [a, b]) {
      const curve = new THREE.CatmullRomCurve3(pts);
      this.paths.push(curve);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 600, 0.3, 8, false),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      tube.renderOrder = 5;
      this.halves.push(tube); this.group.add(tube);
      const head = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      head.renderOrder = 6;
      this.heads.push(head); this.group.add(head);
    }
    this.group.visible = false;
  }

  /** p: 0..1 how far the heads have run; glow: brightness of the drawn line (HDR); head: brightness of the heads. */
  update(p: number, glow: number, head: number) {
    this.group.visible = glow > 0.001 || head > 0.001;
    if (!this.group.visible) return;
    const lime = new THREE.Color(0.68, 1.0, 0.012);
    this.halves.forEach((t, i) => {
      const idx = t.geometry.index!;
      const per = idx.count / 600; // indices per tubular segment
      t.geometry.setDrawRange(0, Math.floor(600 * Math.min(1, p)) * per);
      t.material.color.copy(lime).multiplyScalar(glow);
      const h = this.heads[i]!;
      h.visible = p > 0 && p < 1.02 && head > 0;
      h.position.copy(this.paths[i]!.getPointAt(Math.min(1, p)));
      h.material.color.setRGB(head, head, head * 1.05);
    });
  }
}
