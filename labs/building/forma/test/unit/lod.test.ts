import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import * as bvh from 'three-mesh-bvh';
import { exampleProject } from '../../src/editor/example';
import { buildLOD, buildBatchedCity, enableBVH } from '../../src/render/lod';
import { buildBuilding } from '../../src/render/build-building';
import { createRenderContext } from '../../src/render/context';
import { buildBuildingParts } from '../../src/geometry/mass-parts';

const tris = (o: THREE.Object3D) => {
  let n = 0,
    meshes = 0;
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const c = m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position!.count;
    n += (c / 3) * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  });
  return { n, meshes };
};

describe('níveis de detalhe', () => {
  const p = exampleProject();
  const ctx = createRenderContext();
  it('LOD0 > LOD1 > LOD2 em triângulos e malhas, mesma caixa envolvente', () => {
    for (const b of p.buildings) {
      const built = buildLOD(b, { context: ctx });
      const [a, m, f] = built.levels.map(tris);
      expect(m!.n, b.name).toBeLessThan(a!.n);
      expect(f!.n).toBeLessThan(m!.n);
      expect(m!.meshes).toBeLessThanOrEqual(8);
      expect(f!.meshes).toBeLessThanOrEqual(3);
      const box = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
      const s0 = box(built.levels[0]),
        s2 = box(built.levels[2]);
      // O LOD2 cabe no LOD0 (sacadas e beirais saem até ~1 m de cada lado).
      for (const k of ['x', 'z'] as const) {
        expect(s2[k]).toBeLessThanOrEqual(s0[k] + 0.3);
        expect(s0[k] - s2[k]).toBeLessThan(2.5);
      }
      expect(built.lod.levels.map((l) => l.distance)[1]).toBeGreaterThanOrEqual(60);
      built.dispose();
    }
  });
  it('troca de nível pela distância da câmera e pick no nível visível', () => {
    const b = p.buildings[0]!;
    const built = buildLOD(b, { context: ctx, distances: [50, 150] });
    const cam = new THREE.PerspectiveCamera();
    for (const [d, level] of [[10, 0], [80, 1], [400, 2]] as const) {
      cam.position.set(b.position[0], 5, b.position[1] + d);
      cam.updateMatrixWorld();
      built.lod.update(cam);
      expect(built.lod.getCurrentLevel()).toBe(level);
    }
    built.dispose();
  });
  it('bairro em BatchedMesh: duas draw calls, pick devolve o edifício', () => {
    const city = buildBatchedCity(p.buildings);
    const batches = city.group.children as THREE.BatchedMesh[];
    expect(batches.map((x) => x.isBatchedMesh)).toEqual([true, true]);
    expect(batches[0]!.instanceCount).toBe(p.buildings.length);
    const target = p.buildings[0]!;
    const ray = new THREE.Raycaster(new THREE.Vector3(target.position[0], 3, target.position[1] + 200), new THREE.Vector3(0, 0, -1));
    city.group.updateMatrixWorld(true);
    const hit = ray.intersectObject(city.group, true)[0];
    expect(hit).toBeTruthy();
    expect(p.buildings.map((x) => x.id)).toContain(city.pick(hit!));
    city.dispose();
  });
  it('peças geradas antes (worker) dão o mesmo resultado', () => {
    const b = p.buildings[1]!;
    const a = buildBuilding(b, { context: ctx });
    const c = buildBuilding(b, { context: ctx, parts: structuredClone(buildBuildingParts(b)) });
    expect(tris(c.group)).toEqual(tris(a.group));
    a.dispose();
    c.dispose();
  });
  it('BVH opcional (three-mesh-bvh): raycast acelerado acerta o mesmo ponto', () => {
    const b = p.buildings[0]!;
    const plainB = buildBuilding(b, { context: ctx });
    const fast = buildBuilding(b, { context: ctx });
    const n = enableBVH(fast.group, bvh as never);
    expect(n).toBeGreaterThan(0);
    const ray = new THREE.Raycaster(new THREE.Vector3(b.position[0], 4, b.position[1] + 100), new THREE.Vector3(0, 0, -1));
    const h1 = ray.intersectObject(plainB.group, true).find((h) => !(h.object as THREE.InstancedMesh).isInstancedMesh)!;
    const h2 = ray.intersectObject(fast.group, true).find((h) => !(h.object as THREE.InstancedMesh).isInstancedMesh)!;
    expect(h2.distance).toBeCloseTo(h1.distance, 5);
    plainB.dispose();
    fast.dispose();
  });
});
