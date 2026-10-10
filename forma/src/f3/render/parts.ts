// Peças dos componentes → three.js: uma InstancedMesh por (primitiva, material)
// e uma malha fundida por material para os perfis. Geometrias das primitivas
// são compartilhadas (do contexto); cada edifício libera só o que criou.
import * as THREE from 'three';
import type { MaterialKey } from '../../geometry/parts';
import type { RenderContext } from '../../render/context';
import type { PartMat } from '../families/family';
import type { InstPart, Parts3, PartTag } from '../eval/parts';
import { metricUVs } from '../../render/build-building';
import { materialKey } from './finishes';

const SLOT_ROLE: Record<PartMat['slot'], MaterialKey['role']> = {
  frame: 'frame',
  glass: 'glass',
  panel: 'frame',
  metal: 'frame',
  wood: 'frame',
  stone: 'stone',
  concrete: 'stone',
  wall: 'wall',
  roof: 'roof',
  green: 'green',
  fabric: 'frame',
  light: 'frame',
  dark: 'frame',
};

const SLOT_FINISH: Partial<Record<PartMat['slot'], string>> = { glass: 'glass', metal: 'metal', wood: 'wood', stone: 'stone', concrete: 'concrete', green: 'paint', fabric: 'paint', light: 'paint', dark: 'paint' };

export function partMaterial(m: PartMat, textured = true): MaterialKey {
  const finish = m.finish ?? SLOT_FINISH[m.slot] ?? 'paint';
  const full = materialKey({ finish, color: m.color }, SLOT_ROLE[m.slot]);
  // Primitivas instanciadas têm UV unitário: sem textura (esticaria o padrão).
  const { texture, textureScale, ...plain } = full;
  void textureScale;
  const key: MaterialKey = textured && texture ? full : plain;
  if (m.slot === 'glass') return { ...key, roughness: 0.08, metalness: 0.45 };
  if (m.slot === 'light') return { ...key, roughness: 0.4 };
  return key;
}

const shared = new WeakMap<RenderContext, Record<InstPart['shape'], THREE.BufferGeometry>>();

function primitives(ctx: RenderContext): Record<InstPart['shape'], THREE.BufferGeometry> {
  let p = shared.get(ctx);
  if (!p) {
    p = {
      box: ctx.boxGeometry,
      cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6),
      cyl12: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
      cyl20: new THREE.CylinderGeometry(0.5, 0.5, 1, 20),
    };
    shared.set(ctx, p);
  }
  return p;
}

export interface PartsMesh {
  group: THREE.Group;
  /** Etiqueta (componente, regra) de cada instância ou triângulo atingido. */
  pick(hit: THREE.Intersection): PartTag | null;
  dispose(): void;
}

const keyOf = (k: MaterialKey) => `${k.role}|${k.color}|${k.roughness}|${k.metalness ?? 0}|${k.texture ?? ''}|${k.textureScale ?? 1}`;

export function buildPartsMesh(parts: Parts3, ctx: RenderContext, shadows = true): PartsMesh {
  const group = new THREE.Group();
  group.name = 'componentes';
  const created: THREE.BufferGeometry[] = [];
  const prim = primitives(ctx);
  // Instâncias.
  const batches = new Map<string, { shape: InstPart['shape']; key: MaterialKey; list: InstPart[] }>();
  for (const it of parts.inst) {
    const key = partMaterial(it.mat, false);
    const id = `${it.shape}|${keyOf(key)}`;
    let b = batches.get(id);
    if (!b) batches.set(id, (b = { shape: it.shape, key, list: [] }));
    b.list.push(it);
  }
  const m4 = new THREE.Matrix4();
  for (const b of batches.values()) {
    const mesh = new THREE.InstancedMesh(prim[b.shape], ctx.material(b.key), b.list.length);
    b.list.forEach((it, i) => mesh.setMatrixAt(i, m4.fromArray(it.m)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadows && b.key.role !== 'glass';
    mesh.receiveShadow = shadows;
    mesh.userData = { partTags: b.list.map((it) => it.tag) };
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  // Perfis: uma malha por material.
  const byMat = new Map<string, { key: MaterialKey; pos: number[]; tags: number[] }>();
  for (const m of parts.meshes) {
    const key = partMaterial(m.mat);
    const id = keyOf(key);
    let b = byMat.get(id);
    if (!b) byMat.set(id, (b = { key, pos: [], tags: [] }));
    for (let i = 0; i < m.positions.length; i++) b.pos.push(m.positions[i]!);
    for (let i = 0; i < m.positions.length / 9; i++) b.tags.push(m.tag);
  }
  for (const b of byMat.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(metricUVs(b.pos), 2));
    g.computeVertexNormals();
    created.push(g);
    const mesh = new THREE.Mesh(g, ctx.material(b.key));
    mesh.castShadow = shadows && b.key.role !== 'glass';
    mesh.receiveShadow = shadows;
    mesh.userData = { triTags: b.tags };
    group.add(mesh);
  }
  return {
    group,
    pick(hit) {
      const o = hit.object;
      const tags = o.userData.partTags as number[] | undefined;
      if (tags && hit.instanceId !== undefined) return parts.tags[tags[hit.instanceId]!] ?? null;
      const tt = o.userData.triTags as number[] | undefined;
      if (tt && hit.faceIndex !== undefined && hit.faceIndex !== null) return parts.tags[tt[hit.faceIndex]!] ?? null;
      return null;
    },
    dispose() {
      for (const c of group.children) if ((c as THREE.InstancedMesh).isInstancedMesh) (c as THREE.InstancedMesh).dispose();
      for (const g of created) g.dispose();
      group.clear();
    },
  };
}
