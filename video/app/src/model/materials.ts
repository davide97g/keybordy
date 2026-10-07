// Materials for the printed parts and the electronics. The printed parts get their surface from the
// print itself, computed in the shader from the object-space position (no UVs on the STL meshes):
// 0.2 mm layer lines on every side wall, and the Textured PEI grain on faces printed against the plate.
// Units are mm, so the bump heights are physical.
import * as THREE from 'three';

export const PLA = {
  black: '#16151a',
  white: '#ece9e3',
  gray: '#8e9089',
  green: '#00ae42',
} as const;

const PRINT_GLSL = /* glsl */ `
varying vec3 vObjPos;
varying vec3 vObjN;
uniform float uLayer;      // layer height, mm
uniform float uLayerAmp;   // bead depth, mm
uniform float uGrainAmp;   // PEI grain depth, mm
uniform float uGrainSide;  // which Z face got the plate texture: +1 top, -1 bottom, 0 none
float kbHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float kbNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(kbHash(i), kbHash(i + vec3(1,0,0)), f.x), mix(kbHash(i + vec3(0,1,0)), kbHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(kbHash(i + vec3(0,0,1)), kbHash(i + vec3(1,0,1)), f.x), mix(kbHash(i + vec3(0,1,1)), kbHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float kbHeight() {
  vec3 n = normalize(vObjN);
  float side = 1.0 - smoothstep(0.55, 0.85, abs(n.z));
  // layer beads: a rounded profile per layer, faded out where a layer is under ~2 px (no moire)
  float z = vObjPos.z / uLayer;
  float fw = fwidth(z);
  float bead = sqrt(max(0.0, 1.0 - pow(2.0 * fract(z) - 1.0, 2.0)));
  float jitter = kbNoise(vec3(vObjPos.xy * 0.35, floor(z) * 3.1)) * 0.35;
  float layers = (bead + jitter) * uLayerAmp * (1.0 - smoothstep(0.25, 0.6, fw));
  // Textured PEI: fine sintered grain, two octaves
  float face = uGrainSide == 0.0 ? 0.0 : smoothstep(0.85, 0.97, n.z * uGrainSide);
  float g = kbNoise(vObjPos * 9.0) * 0.65 + kbNoise(vObjPos * 23.0) * 0.35;
  float grain = g * uGrainAmp * (1.0 - smoothstep(0.4, 1.2, fwidth(vObjPos.x * 9.0)));
  return layers * side + grain * face;
}
vec3 kbPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
  vec3 vSigmaX = normalize(dFdx(surf_pos)), vSigmaY = normalize(dFdy(surf_pos));
  vec3 R1 = cross(vSigmaY, surf_norm), R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}`;

/** A printed PLA part. `grainSide`: +1 if its +Z face was printed on the plate (deck, caps, knobs), 0 if none shows. */
export function printed(hex: string, o: { rough?: number; grainSide?: number; layerAmp?: number; sheen?: number } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(hex),
    roughness: o.rough ?? 0.62,
    metalness: 0,
    clearcoat: 0.06,
    clearcoatRoughness: 0.55,
    sheen: o.sheen ?? 0.25,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color('#ffffff'),
    envMapIntensity: 0.55,
  });
  const u = {
    uLayer: { value: 0.2 },
    uLayerAmp: { value: o.layerAmp ?? 0.018 },
    uGrainAmp: { value: 0.012 },
    uGrainSide: { value: o.grainSide ?? 0 },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${PRINT_GLSL}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { float h = kbHeight(); normal = kbPerturb(-vViewPosition, normal, vec2(dFdx(h), dFdy(h)), faceDirection); }`);
  };
  m.customProgramCacheKey = () => 'printed';
  return m;
}

export const metal = (hex: string, rough = 0.3) => new THREE.MeshStandardMaterial({ color: hex, metalness: 1, roughness: rough, envMapIntensity: 1.1 });
export const plastic = (hex: string, rough = 0.5) => new THREE.MeshStandardMaterial({ color: hex, metalness: 0, roughness: rough, envMapIntensity: 0.6 });

export function makeMaterials() {
  return {
    case: printed('#0e0d11', { rough: 0.72, grainSide: 0, layerAmp: 0.022, sheen: 0.12 }),
    deck: printed('#0e0d11', { rough: 0.7, grainSide: 1, layerAmp: 0.02, sheen: 0.12 }),
    plate: printed(PLA.gray, { rough: 0.6, grainSide: 0 }),
    capWhite: printed(PLA.white, { rough: 0.5, grainSide: 1, sheen: 0.35 }),
    capGray: printed(PLA.gray, { rough: 0.52, grainSide: 1 }),
    capGreen: printed(PLA.green, { rough: 0.48, grainSide: 1 }),
    knob: printed('#141317', { rough: 0.55, grainSide: 1 }),
    pcb: new THREE.MeshPhysicalMaterial({ color: '#0d0f0e', roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.18, envMapIntensity: 0.8 }),
    gold: metal('#e0b25a', 0.22),
    steel: metal('#c9cad0', 0.24),
    darkMetal: metal('#4a4a52', 0.38),
    chip: plastic('#18181c', 0.42),
    housing: plastic('#25242b', 0.38),
    housingTop: new THREE.MeshPhysicalMaterial({ color: '#d8d5dc', roughness: 0.15, transmission: 0.55, thickness: 1.5, ior: 1.5, envMapIntensity: 0.8 }),
    stem: plastic('#e8c34a', 0.42),
    hole: new THREE.MeshBasicMaterial({ color: '#020202' }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#030304', roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.4 }),
    pouch: metal('#aab3c1', 0.34),
    speaker: plastic('#1c1b20', 0.6),
    silk: new THREE.MeshStandardMaterial({ color: '#efedf3', roughness: 0.7, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  };
}
export type Materials = ReturnType<typeof makeMaterials>;
