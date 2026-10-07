// v4 atmosphere for the opening: a shaft of light falling on the device from above, and dust drifting
// through it. The shaft is an open cone drawn additively, brightest where the eye looks through most of it
// (facing the camera) and fading toward the lamp and the floor; the dust is a point cloud whose motion is
// a pure function of t. Units are mm, table space.
import * as THREE from 'three';
import { hash } from '../engine/util';

const N = 2600, R = 230, TOP = 560;
const BR = 150, BH = 900; // the shaft: radius at its foot, length (apex 820 mm up)

export class Atmos {
  group = new THREE.Group();
  private beam: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>;
  private dust: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private base: Float32Array;

  constructor() {
    const g = new THREE.ConeGeometry(BR, BH, 96, 1, true);
    g.translate(0, -BH / 2, 0); // apex at the origin, opening downward
    const m = new THREE.ShaderMaterial({
      uniforms: { gain: { value: 0 }, tint: { value: new THREE.Color(0.86, 0.84, 1.0) } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying float vH;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - w.xyz);
          vH = -position.y / 900.0;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float gain; uniform vec3 tint;
        varying vec3 vN; varying vec3 vV; varying float vH;
        void main() {
          float facing = pow(abs(dot(normalize(vN), normalize(vV))), 2.2);
          float along = smoothstep(0.0, 0.25, vH) * (1.0 - smoothstep(0.55, 0.88, vH));
          gl_FragColor = vec4(tint * facing * along * gain, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(g, m);
    this.beam.position.set(0, 820, -40);
    this.beam.renderOrder = 4;
    this.group.add(this.beam);

    this.base = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = 2 * Math.PI * hash(i, 1), r = R * 0.95 * Math.sqrt(hash(i, 2));
      this.base[i * 3] = Math.cos(a) * r;
      this.base[i * 3 + 1] = 8 + TOP * hash(i, 3);
      this.base[i * 3 + 2] = Math.sin(a) * r - 40;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this.base.slice(), 3).setUsage(THREE.DynamicDrawUsage));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: new THREE.Color(2.2, 2.2, 2.4), size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
    this.group.visible = false;
  }

  /** beam / dust: 0..1+ intensities. */
  update(t: number, beam: number, dust: number) {
    this.group.visible = beam > 0 || dust > 0;
    if (!this.group.visible) return;
    this.beam.visible = beam > 0;
    this.beam.material.uniforms.gain!.value = 0.11 * beam;
    this.dust.visible = dust > 0;
    this.dust.material.opacity = Math.min(1, dust);
    const p = this.dust.geometry.attributes.position as THREE.BufferAttribute;
    const a = p.array as Float32Array, b = this.base;
    for (let i = 0; i < N; i++) {
      const ph = hash(i, 4) * 6.283, sp = 0.3 + 0.7 * hash(i, 5);
      a[i * 3] = b[i * 3]! + Math.sin(t * 0.7 * sp + ph) * 9;
      a[i * 3 + 1] = 8 + ((b[i * 3 + 1]! - 8 + t * 6 * sp) % TOP);
      a[i * 3 + 2] = b[i * 3 + 2]! + Math.cos(t * 0.5 * sp + ph * 1.3) * 9;
    }
    p.needsUpdate = true;
  }
}
