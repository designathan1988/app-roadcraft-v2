// Converte um edifício (forma/2) em um THREE.Group pronto para a cena do jogo.
import * as THREE from 'three';
import type { Building, Vec2 } from '../core/schema';
import type { BuildingParts, PartData, SlabPart, WallPart } from '../geometry/parts';
import { buildBuildingParts, type MassPartsOptions } from '../geometry/mass-parts';
import { createRenderContext, type RenderContext } from './context';

export interface BuildOptions extends MassPartsOptions {
  /** Peças já geradas (por exemplo, num worker); sem elas, são geradas aqui. */
  parts?: BuildingParts;
  /** Contexto compartilhado (materiais). Sem ele, o edifício cria e libera o seu. */
  context?: RenderContext;
  shadows?: boolean;
}

export interface BuiltBuilding {
  group: THREE.Group;
  parts: BuildingParts;
  /** Dados da peça atingida por um raio (Raycaster). */
  pick(hit: THREE.Intersection): PartData | null;
  /** Libera apenas os recursos criados por este edifício. */
  dispose(): void;
}

export function planShape(outer: Vec2[], holes: Vec2[][]): THREE.Shape {
  // Planta [x, z] vira forma em [x, -z]; a extrusão é girada −90° em X.
  const s = new THREE.Shape();
  outer.forEach((p, i) => (i ? s.lineTo(p[0], -p[1]) : s.moveTo(p[0], -p[1])));
  s.closePath();
  for (const ring of holes) {
    const h = new THREE.Path();
    ring.forEach((p, i) => (i ? h.lineTo(p[0], -p[1]) : h.moveTo(p[0], -p[1])));
    h.closePath();
    s.holes.push(h);
  }
  return s;
}

export function slabGeometry(s: SlabPart): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(planShape(s.outer, s.holes), { depth: s.thickness, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  return g;
}

export function wallGeometry(w: WallPart): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, w.bottom);
  shape.lineTo(w.length, w.bottom);
  shape.lineTo(w.length, w.top);
  shape.lineTo(0, w.top);
  shape.closePath();
  for (const o of w.holes) {
    const hole = new THREE.Path();
    hole.moveTo(o.left, o.bottom);
    if (o.arch) {
      const radius = Math.min(o.width / 2, o.height * 0.48);
      hole.lineTo(o.left, o.top - radius);
      hole.absarc(o.center, o.top - radius, radius, Math.PI, 0, true);
    } else {
      hole.lineTo(o.left, o.top);
      hole.lineTo(o.right, o.top);
    }
    hole.lineTo(o.right, o.bottom);
    hole.closePath();
    shape.holes.push(hole);
  }
  return new THREE.ExtrudeGeometry(shape, { depth: w.depth, bevelEnabled: false, curveSegments: 10 });
}

/**
 * UVs em metros para malhas livres (telhados, empenas): cada triângulo é
 * projetado no próprio plano, com u ao longo da horizontal do plano. Triângulos
 * do mesmo plano usam a mesma base, então a textura continua sem emendas.
 */
export function metricUVs(pos: number[]): number[] {
  const uv: number[] = [];
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    n = new THREE.Vector3(),
    t = new THREE.Vector3(),
    s = new THREE.Vector3();
  for (let i = 0; i + 8 < pos.length; i += 9) {
    a.fromArray(pos, i);
    b.fromArray(pos, i + 3);
    c.fromArray(pos, i + 6);
    n.subVectors(b, a).cross(s.subVectors(c, a)).normalize();
    if (n.y < 0) n.negate();
    t.crossVectors(Y, n);
    if (t.lengthSq() < 1e-8) t.set(1, 0, 0);
    t.normalize();
    s.crossVectors(n, t).normalize();
    for (const p of [a, b, c]) uv.push(p.dot(t), p.dot(s));
  }
  return uv;
}

const Y = new THREE.Vector3(0, 1, 0),
  Z = new THREE.Vector3(0, 0, 1);

export function buildBuilding(b: Building, opts: BuildOptions = {}): BuiltBuilding {
  const ctx = opts.context ?? createRenderContext();
  const ownContext = !opts.context;
  const shadows = opts.shadows ?? true;
  const parts = opts.parts ?? buildBuildingParts(b, opts);
  const group = new THREE.Group();
  group.name = b.name;
  group.position.set(b.position[0], 0, b.position[1]);
  group.rotation.y = (b.rotation * Math.PI) / 180;
  group.userData = { buildingId: b.id };
  const created: THREE.BufferGeometry[] = [];
  const add = (m: THREE.Mesh, data: PartData) => {
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    m.userData = { ...data };
    group.add(m);
  };

  // Lajes: a mesma geometria é reaproveitada quando o contorno se repete.
  const slabCache = new Map<string, THREE.BufferGeometry>();
  for (const s of parts.slabs) {
    const key = JSON.stringify([s.outer, s.holes, s.thickness]);
    let g = slabCache.get(key);
    if (!g) {
      g = slabGeometry(s);
      slabCache.set(key, g);
      created.push(g);
    }
    const m = new THREE.Mesh(g, ctx.material(s.mat));
    m.position.y = s.y;
    add(m, s.data);
  }

  for (const w of parts.walls) {
    const g = wallGeometry(w);
    created.push(g);
    const m = new THREE.Mesh(g, ctx.material(w.mat));
    m.position.set(...w.origin);
    m.rotation.y = w.angle;
    add(m, w.data);
  }

  for (const r of parts.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(r.positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(metricUVs(r.positions), 2));
    g.computeVertexNormals();
    created.push(g);
    add(new THREE.Mesh(g, ctx.material(r.mat)), r.data);
  }

  // Módulos glTF: uma InstancedMesh por malha do módulo; caixa provisória enquanto carrega.
  const byUrl = new Map<string, typeof parts.modules>();
  for (const p of parts.modules) byUrl.set(p.url, [...(byUrl.get(p.url) ?? []), p]);
  const mq = new THREE.Quaternion();
  for (const [url, list] of byUrl) {
    const meshes = ctx.modules.get(url);
    const place = list.map((p) => new THREE.Matrix4().compose(new THREE.Vector3(...p.pos), mq.setFromAxisAngle(Y, p.angle), new THREE.Vector3(...p.size)));
    const sources = meshes ?? [{ geometry: ctx.boxGeometry, material: ctx.material({ role: 'frame', color: '#8a8f91', roughness: 0.7 }), matrix: new THREE.Matrix4() }];
    for (const src of sources) {
      const mesh = new THREE.InstancedMesh(src.geometry, src.material, list.length);
      place.forEach((m, i) => mesh.setMatrixAt(i, m.clone().multiply(src.matrix)));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      mesh.userData = { buildingId: b.id, instances: list.map((p) => p.data), module: url, placeholder: !meshes };
      group.add(mesh);
    }
  }

  // Caixas repetidas: uma InstancedMesh por material.
  const batches = new Map<THREE.Material, { data: PartData[]; matrices: THREE.Matrix4[] }>();
  const q = new THREE.Quaternion(),
    qr = new THREE.Quaternion();
  for (const box of parts.boxes) {
    const material = ctx.material(box.mat);
    let batch = batches.get(material);
    if (!batch) batches.set(material, (batch = { data: [], matrices: [] }));
    q.setFromAxisAngle(Y, box.angle);
    if (box.roll) q.multiply(qr.setFromAxisAngle(Z, box.roll));
    batch.matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(...box.pos), q, new THREE.Vector3(...box.size)));
    batch.data.push(box.data);
  }
  for (const [material, batch] of batches) {
    const mesh = new THREE.InstancedMesh(ctx.boxGeometry, material, batch.matrices.length);
    batch.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.userData = { buildingId: b.id, instances: batch.data };
    group.add(mesh);
  }
  group.updateMatrixWorld(true);

  return {
    group,
    parts,
    pick(hit) {
      const o = hit.object;
      if ((o as THREE.InstancedMesh).isInstancedMesh) return (o.userData.instances as PartData[])[hit.instanceId ?? -1] ?? null;
      return o.userData.part ? (o.userData as PartData) : null;
    },
    dispose() {
      group.removeFromParent();
      for (const g of created) g.dispose();
      for (const child of group.children) if ((child as THREE.InstancedMesh).isInstancedMesh) (child as THREE.InstancedMesh).dispose();
      group.clear();
      if (ownContext) ctx.dispose();
    },
  };
}
