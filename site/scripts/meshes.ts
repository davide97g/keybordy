// CAD meshes for the page: the teaser's STL exports (video/build/models, `just video-meshes`) welded and
// quantized into a small indexed format, KBM1, so the page loads ~1.5 MB instead of 12 MB of STL.
// Layout: "KBM1", u32 vertex count, u32 index count, f32 min[3], f32 step[3], u16 positions (xyz), then
// u16 or u32 indices (u32 when there are more than 65535 vertices). Positions are within half a step of
// the CAD (well under 0.01 mm). Run from site/: bun scripts/meshes.ts
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const sizes: Record<string, number> = {};

const SRC = '../video/build/models', OUT = 'public/models';
for (const name of ['tray', 'deck', 'plate', 'cap1', 'cap15', 'cap2_talk', 'knob']) {
  const buf = readFileSync(`${SRC}/${name}.stl`);
  const g = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  g.deleteAttribute('normal');
  const m = mergeVertices(g, 1e-4);
  const p = m.getAttribute('position') as THREE.BufferAttribute, idx = m.getIndex()!;
  m.computeBoundingBox();
  const min = m.boundingBox!.min, size = m.boundingBox!.getSize(new THREE.Vector3());
  const step = [size.x / 65535 || 1, size.y / 65535 || 1, size.z / 65535 || 1];
  const pos = new Uint16Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    pos[i * 3] = Math.round((p.getX(i) - min.x) / step[0]!);
    pos[i * 3 + 1] = Math.round((p.getY(i) - min.y) / step[1]!);
    pos[i * 3 + 2] = Math.round((p.getZ(i) - min.z) / step[2]!);
  }
  const ind = p.count > 65535 ? Uint32Array.from(idx.array) : Uint16Array.from(idx.array);
  const head = new ArrayBuffer(4 + 8 + 24);
  const dv = new DataView(head);
  'KBM1'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, p.count, true); dv.setUint32(8, ind.length, true);
  [min.x, min.y, min.z, ...step].forEach((v, i) => dv.setFloat32(12 + i * 4, v, true));
  const pad = (pos.byteLength % 4) ? 2 : 0;
  const out = Buffer.concat([Buffer.from(head), Buffer.from(pos.buffer), Buffer.alloc(pad), Buffer.from(ind.buffer)]);
  writeFileSync(`${OUT}/${name}.kbm`, out);
  sizes[name] = out.length;
  console.log(name, `${p.count} verts, ${ind.length / 3} tris, ${(out.length / 1024).toFixed(0)} KB`);
}
copyFileSync(`${SRC}/frame.json`, `${OUT}/frame.json`);
// byte sizes, for the loading bar (the server gzips, so Content-Length is not the decoded size)
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(sizes, null, 1) + '\n');
