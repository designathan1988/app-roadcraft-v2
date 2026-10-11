// Níveis de detalhe para o jogo:
//  - LOD0: o edifício completo (buildBuilding);
//  - LOD1: tudo fundido por material, sem caixilhos nem miudezas (poucas draw calls);
//  - LOD2: caixa de cada massa com o telhado (2 a 3 draw calls).
// buildBatchedCity junta o LOD2 de muitos edifícios em dois BatchedMesh
// (paredes e telhados, cor por instância): um bairro inteiro em 2 draw calls.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Building } from '../core/schema';
import { massExtent } from '../core/model';
import { ringPoints } from '../geometry/ring';
import { buildBuildingParts } from '../geometry/mass-parts';
import type { BuildingParts, MaterialKey, PartData } from '../geometry/parts';
import { buildBuilding, metricUVs, planShape, slabGeometry, type BuildOptions, type BuiltBuilding } from './build-building';
import { createRenderContext, type RenderContext } from './context';

const Y = new THREE.Vector3(0, 1, 0),
  Z = new THREE.Vector3(0, 0, 1);

export interface LodOptions extends BuildOptions {
  /** Distâncias (m) em que entram o LOD1 e o LOD2. Padrão: pelo tamanho do edifício. */
  distances?: [number, number];
  /** Fração da distância que evita alternar sem parar na fronteira (padrão 0,1). */
  hysteresis?: number;
  /** Multiplica as distâncias automáticas (um número ou [LOD1, LOD2]). */
  distanceScale?: number | [number, number];
}

export interface BuiltLOD extends BuiltBuilding {
  lod: THREE.LOD;
  levels: [THREE.Object3D, THREE.Object3D, THREE.Object3D];
}

const keyOf = (k: MaterialKey) => JSON.stringify([k.role, k.color, k.roughness, k.metalness ?? 0, !!k.doubleSide, k.texture ?? '', k.textureScale ?? 1]);

/** Geometria só com posição, normal e uv, sem índice (para poder fundir). */
function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(name)) n.deleteAttribute(name);
  if (!n.attributes.normal) n.computeVertexNormals();
  if (!n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((n.attributes.position!.count * 2) | 0), 2));
  n.clearGroups();
  if (n !== g) g.dispose();
  return n;
}

class Buckets {
  readonly map = new Map<string, { key: MaterialKey; geos: THREE.BufferGeometry[] }>();
  add(key: MaterialKey, g: THREE.BufferGeometry) {
    const id = keyOf(key);
    let b = this.map.get(id);
    if (!b) this.map.set(id, (b = { key, geos: [] }));
    b.geos.push(plain(g));
  }
  /** Funde cada balde numa malha; devolve o grupo e as geometrias criadas. */
  build(ctx: RenderContext, data: PartData, shadows: boolean): { group: THREE.Group; created: THREE.BufferGeometry[] } {
    const group = new THREE.Group();
    const created: THREE.BufferGeometry[] = [];
    for (const { key, geos } of this.map.values()) {
      const merged = geos.length === 1 ? geos[0]! : mergeGeometries(geos, false);
      if (geos.length > 1) for (const g of geos) g.dispose();
      if (!merged) continue;
      created.push(merged);
      const m = new THREE.Mesh(merged, ctx.material(key));
      m.castShadow = m.receiveShadow = shadows;
      m.userData = { ...data };
      group.add(m);
    }
    return { group, created };
  }
}

const m4 = new THREE.Matrix4(),
  q = new THREE.Quaternion(),
  qr = new THREE.Quaternion();

/** LOD1: paredes, lajes, telhados e peças grandes, fundidos por material. */
export function lod1Geometry(parts: BuildingParts): Buckets {
  const out = new Buckets();
  for (const w of parts.walls) {
    if (w.data.part === 'lining' || w.data.part === 'iwall') continue;
    // Parede maciça (sem os recortes das janelas): o vidro vai para a face externa.
    const h = w.top - w.bottom;
    if (h <= 0.01 || w.length <= 0.01) continue;
    const g = new THREE.BoxGeometry(w.length, h, w.depth);
    g.translate(w.length / 2, (w.top + w.bottom) / 2, w.depth / 2);
    // UV em metros na face, como nas paredes completas.
    const pos = g.attributes.position!,
      uv = g.attributes.uv!;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) + pos.getZ(i), pos.getY(i));
    g.applyMatrix4(m4.compose(new THREE.Vector3(...w.origin), q.setFromAxisAngle(Y, w.angle), new THREE.Vector3(1, 1, 1)));
    out.add(w.mat, g);
  }
  // Lajes intermediárias ficam escondidas pelas paredes: só a mais alta de cada massa.
  const topSlab = new Map<string, number>();
  for (const s of parts.slabs) if (s.data.part === 'floor') topSlab.set(s.data.massId, Math.max(topSlab.get(s.data.massId) ?? -Infinity, s.y));
  for (const s of parts.slabs) {
    if (s.data.part === 'floor' && s.y < (topSlab.get(s.data.massId) ?? -Infinity) - 1e-6) continue;
    const g = slabGeometry(s);
    g.translate(0, s.y, 0);
    out.add(s.mat, g);
  }
  for (const r of parts.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(r.positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(metricUVs(r.positions), 2));
    g.computeVertexNormals();
    out.add(r.mat, g);
  }
  for (const box of parts.boxes) {
    // Sem caixilhos, guarda-corpos, montantes e outras miudezas.
    if (box.mat.role === 'frame' || box.mat.role === 'cap') continue;
    const [sx, sy, sz] = box.size;
    if (Math.max(sx, sy, sz) < 0.4 || sx * sy * sz < 0.01) continue;
    // Faixas finas (cornijas, pingadeiras) somem de longe; o vidro é plano e fica.
    if (box.mat.role !== 'glass' && Math.min(sx, sy, sz) < 0.15) continue;
    if (box.data.part === 'idoor' || box.data.part === 'stair') continue;
    q.setFromAxisAngle(Y, box.angle);
    if (box.roll) q.multiply(qr.setFromAxisAngle(Z, box.roll));
    const p = new THREE.Vector3(...box.pos);
    let g: THREE.BufferGeometry, size: THREE.Vector3;
    if (box.mat.role === 'glass' && !box.roll) {
      // O vidro ficava dentro do vão; sem o vão, vira um plano (2 triângulos)
      // colado na face externa da parede, voltado para fora (−z local).
      p.x -= Math.sin(box.angle) * 0.135;
      p.z -= Math.cos(box.angle) * 0.135;
      g = new THREE.PlaneGeometry(1, 1).rotateY(Math.PI);
      size = new THREE.Vector3(sx, sy, 1);
    } else {
      g = new THREE.BoxGeometry(1, 1, 1);
      size = new THREE.Vector3(sx, sy, sz);
    }
    g.applyMatrix4(m4.compose(p, q, size));
    out.add(box.mat, g);
  }
  return out;
}

/** LOD2: cada massa vira um prisma (base → topo) com o telhado por cima. */
export function lod2Geometry(b: Building, parts: BuildingParts): Buckets {
  const out = new Buckets();
  for (const m of b.masses) {
    const { base, height } = massExtent(b, m);
    if (height <= 0) continue;
    const g = new THREE.ExtrudeGeometry(planShape(ringPoints(m.outer), m.holes.map(ringPoints)), { depth: height + (m.roof.kind === 'flat' ? 0.2 : 0.16), bevelEnabled: false, curveSegments: 1 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, base, 0);
    out.add({ role: 'wall', color: m.finish.wall, roughness: 0.85 }, g);
    if (m.roof.kind === 'flat') {
      // Tampa na cor da cobertura: sem salto de cor ao trocar de nível.
      const cap = new THREE.ShapeGeometry(planShape(ringPoints(m.outer), m.holes.map(ringPoints)), 1);
      cap.rotateX(-Math.PI / 2);
      cap.translate(0, base + height + 0.21, 0);
      out.add({ role: 'roof', color: m.roof.color, roughness: 0.8 }, cap);
    }
  }
  for (const r of parts.meshes) {
    if (r.data.part !== 'roof' && r.data.part !== 'gable') continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(r.positions, 3));
    g.computeVertexNormals();
    out.add({ ...r.mat, texture: undefined, textureScale: undefined }, g);
  }
  return out;
}

/** Raio aproximado do edifício (para escolher as distâncias de troca). */
function sizeOf(b: Building): number {
  let r = 0,
    h = 0;
  for (const m of b.masses) {
    for (const p of ringPoints(m.outer)) r = Math.max(r, Math.hypot(p[0], p[1]));
    const e = massExtent(b, m);
    h = Math.max(h, e.base + e.height + m.roof.height);
  }
  return Math.max(r, h / 2, 4);
}

/** Edifício com três níveis de detalhe (THREE.LOD) trocados pela distância da câmera. */
export function buildLOD(b: Building, opts: LodOptions = {}): BuiltLOD {
  const ctx = opts.context ?? createRenderContext();
  const own = !opts.context;
  const shadows = opts.shadows ?? true;
  const parts = opts.parts ?? buildBuildingParts(b, opts);
  const full = buildBuilding(b, { ...opts, context: ctx, parts });
  full.group.position.set(0, 0, 0);
  full.group.rotation.set(0, 0, 0);
  const data: PartData = { buildingId: b.id, massId: '', part: 'lod' };
  const l1 = lod1Geometry(parts).build(ctx, { ...data, part: 'lod1' }, shadows);
  const l2 = lod2Geometry(b, parts).build(ctx, { ...data, part: 'lod2' }, false);
  const size = sizeOf(b);
  const k = opts.distanceScale ?? 1;
  const [k1, k2] = typeof k === 'number' ? [k, k] : k;
  const [d1, d2] = opts.distances ?? [Math.max(60, size * 4) * k1, Math.max(Math.max(60, size * 4) * k1 * 1.5, Math.max(160, size * 10) * k2)];
  const lod = new THREE.LOD();
  const hy = opts.hysteresis ?? 0.1;
  lod.addLevel(full.group, 0, hy);
  lod.addLevel(l1.group, d1, hy);
  lod.addLevel(l2.group, d2, hy);
  const group = new THREE.Group();
  group.name = b.name;
  group.position.set(b.position[0], 0, b.position[1]);
  group.rotation.y = (b.rotation * Math.PI) / 180;
  group.userData = { buildingId: b.id };
  group.add(lod);
  group.updateMatrixWorld(true);
  return {
    group,
    parts,
    lod,
    levels: [full.group, l1.group, l2.group],
    pick(hit) {
      return full.pick(hit) ?? (hit.object.userData.part ? (hit.object.userData as PartData) : null);
    },
    dispose() {
      group.removeFromParent();
      full.dispose();
      for (const g of [...l1.created, ...l2.created]) g.dispose();
      group.clear();
      if (own) ctx.dispose();
    },
  };
}

export interface BatchedCity {
  group: THREE.Group;
  /** Edifício atingido (pelo batchId do BatchedMesh). */
  pick(hit: THREE.Intersection): Building['id'] | null;
  dispose(): void;
}

/**
 * Bairro distante num só lote: o LOD2 de cada edifício entra em dois
 * BatchedMesh (paredes e telhados), com a cor de cada um por instância.
 */
export function buildBatchedCity(buildings: Building[], opts: BuildOptions = {}): BatchedCity {
  const items = buildings.map((b) => {
    const parts = opts.parts ?? buildBuildingParts(b, { ...opts, interiors: false });
    const buckets = lod2Geometry(b, parts);
    const walls: THREE.BufferGeometry[] = [],
      roofs: THREE.BufferGeometry[] = [];
    let wallColor = '#cccccc',
      roofColor = '#555555';
    for (const { key, geos } of buckets.map.values()) {
      if (key.role === 'roof') {
        roofs.push(...geos);
        roofColor = key.color;
      } else {
        walls.push(...geos);
        wallColor = key.color;
      }
    }
    const merge = (list: THREE.BufferGeometry[]) => {
      if (!list.length) return null;
      const g = list.length === 1 ? list[0]! : mergeGeometries(list, false);
      if (list.length > 1) for (const x of list) x.dispose();
      return g;
    };
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(b.position[0], 0, b.position[1]), new THREE.Quaternion().setFromAxisAngle(Y, (b.rotation * Math.PI) / 180), new THREE.Vector3(1, 1, 1));
    return { id: b.id, wall: merge(walls), roof: merge(roofs), wallColor, roofColor, matrix };
  });
  const group = new THREE.Group();
  group.name = 'FORMA-bairro';
  const created: THREE.BufferGeometry[] = [];
  const batches: { mesh: THREE.BatchedMesh; ids: string[]; material: THREE.Material }[] = [];
  for (const kind of ['wall', 'roof'] as const) {
    const list = items.filter((i) => i[kind]);
    if (!list.length) continue;
    const verts = list.reduce((s, i) => s + i[kind]!.attributes.position!.count, 0);
    const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: kind === 'wall' ? 0.85 : 0.75, side: kind === 'roof' ? THREE.DoubleSide : THREE.FrontSide });
    const mesh = new THREE.BatchedMesh(list.length, verts, verts, material);
    mesh.name = kind === 'wall' ? 'FORMA-paredes' : 'FORMA-telhados';
    const ids: string[] = [];
    const color = new THREE.Color();
    for (const it of list) {
      const geo = it[kind]!;
      created.push(geo);
      const gid = mesh.addGeometry(geo);
      const iid = mesh.addInstance(gid);
      mesh.setMatrixAt(iid, it.matrix);
      mesh.setColorAt(iid, color.set(kind === 'wall' ? it.wallColor : it.roofColor));
      ids[iid] = it.id;
    }
    mesh.castShadow = mesh.receiveShadow = opts.shadows ?? true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    group.add(mesh);
    batches.push({ mesh, ids, material });
  }
  return {
    group,
    pick(hit) {
      const b = batches.find((x) => x.mesh === hit.object);
      const id = (hit as THREE.Intersection & { batchId?: number }).batchId;
      return b && id !== undefined ? (b.ids[id] ?? null) : null;
    },
    dispose() {
      group.removeFromParent();
      for (const b of batches) {
        b.mesh.dispose();
        b.material.dispose();
      }
      for (const g of created) g.dispose();
      group.clear();
    },
  };
}

/**
 * Raycast acelerado opcional com three-mesh-bvh (o jogo passa o módulo):
 *   import * as bvh from 'three-mesh-bvh'; enableBVH(edificio.group, bvh);
 * Malhas comuns ganham BVH; InstancedMesh e BatchedMesh ficam como estão.
 */
export function enableBVH(
  root: THREE.Object3D,
  bvh: { computeBoundsTree: (this: THREE.BufferGeometry, ...a: never[]) => unknown; acceleratedRaycast: THREE.Mesh['raycast'] },
): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || (m as unknown as THREE.BatchedMesh).isBatchedMesh) return;
    const g = m.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    if (!g.boundsTree) bvh.computeBoundsTree.call(g);
    m.raycast = bvh.acceleratedRaycast;
    n++;
  });
  return n;
}
