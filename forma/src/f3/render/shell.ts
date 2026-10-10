// Casca avaliada → malha three.js com um grupo por material. Normais planas,
// exceto nas faces curvas (lados em arco, cúpulas, abóbadas), que são
// suavizadas entre triângulos da mesma superfície. UVs em metros.
import * as THREE from 'three';
import type { Building3, ID } from '../model/schema';
import type { Evaluated } from '../eval/evaluate';
import type { FaceInfo } from '../eval/faces';
import type { MaterialKey } from '../../geometry/parts';
import type { RenderContext } from '../../render/context';
import { metricUVs } from '../../render/build-building';
import { materialKey } from './finishes';

const FLAT_ROOF = { finish: 'membrane', color: '#8f9290' };

/** Material de uma face de origem. */
export function faceMaterial(b: Building3, f: FaceInfo): MaterialKey {
  const s = b.solids.find((x) => x.id === f.solid);
  if (!s) return materialKey({ finish: 'paint', color: '#cccccc' }, 'wall');
  const edgeMat = f.edge ? s.edges[f.edge.endsWith(':c') ? f.edge.slice(0, -2) : f.edge]?.material : undefined;
  switch (f.kind) {
    case 'side':
    case 'bevel':
    case 'gable':
    case 'cutter':
      return materialKey(edgeMat ?? s.materials.wall, 'wall');
    case 'parapet':
      return materialKey(s.materials.wall, 'wall');
    case 'roof':
      return materialKey(s.materials.roof, 'roof');
    case 'top':
      return materialKey(s.roof.kind === 'terrace' ? s.materials.base : FLAT_ROOF, 'roof');
    case 'glazing':
      return materialKey({ finish: 'glass', color: '#6d8794' }, 'glass');
    case 'fascia':
    case 'soffit':
    case 'reveal':
      return materialKey(s.materials.trim, 'frame');
    case 'roomFloor':
      return materialKey({ finish: 'wood', color: '#8a6f55' }, 'stone');
    case 'roomCeil':
      return materialKey({ finish: 'paint', color: '#f1ece3' }, 'stone');
    case 'roomWall':
      return materialKey({ finish: 'paint', color: '#ddd3c4' }, 'stone');
    case 'coping':
      return materialKey(s.materials.trim, 'stone');
    case 'plinth':
      return materialKey(s.materials.base, 'stone');
    case 'bottom':
      return materialKey(s.materials.base, 'stone');
  }
}

export interface ShellMesh {
  mesh: THREE.Mesh;
  /** Face de origem de cada triângulo desenhado (na ordem dos grupos). */
  faceOf: Uint32Array;
  dispose(): void;
}

const keyOf = (k: MaterialKey) => `${k.role}|${k.color}|${k.roughness}|${k.texture ?? ''}|${k.textureScale ?? 1}|${k.metalness ?? 0}`;

export function buildShellMesh(b: Building3, ev: Evaluated, ctx: RenderContext, solidOf?: (id: ID) => boolean): ShellMesh {
  const { positions: P, indices: I, faceOf } = ev.shell;
  const nTri = I.length / 3;
  // Triângulos agrupados por material.
  const groups = new Map<string, { key: MaterialKey; tris: number[] }>();
  for (let t = 0; t < nTri; t++) {
    const f = ev.faces[faceOf[t]!];
    if (!f || (solidOf && !solidOf(f.solid))) continue;
    const key = faceMaterial(b, f);
    const id = keyOf(key);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { key, tris: [] }));
    g.tris.push(t);
  }
  // Normais suavizadas por vértice dentro de cada superfície curva.
  const smoothKey = (f: FaceInfo) => `${f.solid}|${f.kind}|${f.kind === 'side' ? f.edge : ''}`;
  const acc = new Map<string, [number, number, number]>();
  const triNormal = new Float32Array(nTri * 3);
  const a = new THREE.Vector3(),
    bb = new THREE.Vector3(),
    c = new THREE.Vector3();
  for (let t = 0; t < nTri; t++) {
    a.fromArray(P, I[t * 3]! * 3);
    bb.fromArray(P, I[t * 3 + 1]! * 3);
    c.fromArray(P, I[t * 3 + 2]! * 3);
    bb.sub(a);
    c.sub(a);
    bb.cross(c);
    const area = bb.length();
    bb.normalize();
    triNormal[t * 3] = bb.x;
    triNormal[t * 3 + 1] = bb.y;
    triNormal[t * 3 + 2] = bb.z;
    const f = ev.faces[faceOf[t]!];
    if (!f?.smooth) continue;
    for (let j = 0; j < 3; j++) {
      const k = `${I[t * 3 + j]}|${smoothKey(f)}`;
      const v = acc.get(k) ?? [0, 0, 0];
      v[0] += bb.x * area;
      v[1] += bb.y * area;
      v[2] += bb.z * area;
      acc.set(k, v);
    }
  }
  const total = [...groups.values()].reduce((s, g) => s + g.tris.length, 0);
  const pos = new Float32Array(total * 9),
    nor = new Float32Array(total * 9);
  const drawnFace = new Uint32Array(total);
  const geo = new THREE.BufferGeometry();
  const materials: THREE.Material[] = [];
  let o = 0;
  for (const g of groups.values()) {
    const start = o;
    for (const t of g.tris) {
      const f = ev.faces[faceOf[t]!]!;
      for (let j = 0; j < 3; j++) {
        const vi = I[t * 3 + j]!;
        pos[(o * 3 + j) * 3] = P[vi * 3]!;
        pos[(o * 3 + j) * 3 + 1] = P[vi * 3 + 1]!;
        pos[(o * 3 + j) * 3 + 2] = P[vi * 3 + 2]!;
        let nx = triNormal[t * 3]!,
          ny = triNormal[t * 3 + 1]!,
          nz = triNormal[t * 3 + 2]!;
        if (f.smooth) {
          const v = acc.get(`${vi}|${smoothKey(f)}`);
          if (v) {
            const l = Math.hypot(v[0], v[1], v[2]) || 1;
            // Só suaviza onde a curvatura é pequena (não arredonda quinas).
            if ((v[0] * nx + v[1] * ny + v[2] * nz) / l > 0.6) {
              nx = v[0] / l;
              ny = v[1] / l;
              nz = v[2] / l;
            }
          }
        }
        nor[(o * 3 + j) * 3] = nx;
        nor[(o * 3 + j) * 3 + 1] = ny;
        nor[(o * 3 + j) * 3 + 2] = nz;
      }
      drawnFace[o] = faceOf[t]!;
      o++;
    }
    geo.addGroup(start * 3, (o - start) * 3, materials.length);
    materials.push(ctx.material(g.key));
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(metricUVs(Array.from(pos)), 2));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const mesh = new THREE.Mesh(geo, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = { shell: true, buildingId: b.id };
  return {
    mesh,
    faceOf: drawnFace,
    dispose() {
      geo.dispose();
    },
  };
}
