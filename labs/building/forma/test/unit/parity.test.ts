// Paridade geométrica com o FORMA v1: para cada fixture, cada edifício gerado
// pelo v2 deve ter as mesmas peças e a mesma caixa envolvente que o volume
// correspondente renderizado pelo app legado (referências gravadas no Chromium).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { migrateV1 } from '../../src/core/migrate/v1';
import { sequentialIds } from '../../src/core/ids';
import { buildBuilding } from '../../src/render/build-building';
import { createRenderContext } from '../../src/render/context';
import { baselines, fixtures } from './legacy';

const all = fixtures();
const refs = baselines();

describe('paridade com o app legado', () => {
  it.each(Object.keys(all))('%s', (name) => {
    const p = migrateV1(all[name], { newId: sequentialIds(name) });
    const ctx = createRenderContext();
    for (const b of p.buildings) {
      const ref = refs[name]![b.id]!;
      expect(ref, `referência de ${b.id}`).toBeDefined();
      const built = buildBuilding(b, { context: ctx, legacyRoofs: true });
      const meshes: Record<string, number> = {},
        instances: Record<string, number> = {},
        sig: Record<string, number> = {},
        verts: Record<string, { count: number; sum: number }> = {};
      const m = new THREE.Matrix4(),
        pos = new THREE.Vector3(),
        q = new THREE.Quaternion(),
        s = new THREE.Vector3(),
        v = new THREE.Vector3();
      for (const o of built.group.children) {
        if ((o as THREE.InstancedMesh).isInstancedMesh) {
          const im = o as THREE.InstancedMesh;
          const key = '#' + (im.material as THREE.MeshStandardMaterial).color.getHexString();
          instances[key] = (instances[key] ?? 0) + im.count;
          for (let i = 0; i < im.count; i++) {
            im.getMatrixAt(i, m);
            m.premultiply(im.matrixWorld).decompose(pos, q, s);
            sig[key] = (sig[key] ?? 0) + pos.x + 2 * pos.y + 3 * pos.z + 5 * s.x + 7 * s.y + 11 * s.z;
          }
        } else {
          const part = o.userData.part === 'floor' || o.userData.part === 'roof' ? o.userData.part : 'wall';
          meshes[part] = (meshes[part] ?? 0) + 1;
          const attr = (o as THREE.Mesh).geometry.attributes.position!;
          const e = (verts[part] ??= { count: 0, sum: 0 });
          e.count += attr.count;
          if (part !== 'roof')
            for (let i = 0; i < attr.count; i++) {
              v.fromBufferAttribute(attr, i).applyMatrix4(o.matrixWorld);
              e.sum += v.x + 2 * v.y + 3 * v.z;
            }
        }
      }
      expect(meshes, `${b.name}: malhas`).toEqual(ref.meshes);
      expect(instances, `${b.name}: instâncias`).toEqual(ref.instances);
      for (const [k, val] of Object.entries(ref.sig)) expect(Math.abs(sig[k]! - val), `${b.name}: posição das peças ${k}`).toBeLessThan(0.05);
      for (const [k, val] of Object.entries(ref.verts)) {
        expect(verts[k]!.count, `${b.name}: vértices ${k}`).toBe(val.count);
        expect(Math.abs(verts[k]!.sum - val.sum), `${b.name}: posição dos vértices ${k}`).toBeLessThan(0.05);
      }
      const box = new THREE.Box3().setFromObject(built.group);
      const ours = [...box.min.toArray(), ...box.max.toArray()].map((n) => Math.round(n * 100) / 100);
      ours.forEach((n, i) => expect(Math.abs(n - ref.box[i]!), `${b.name}: caixa[${i}] ${n} vs ${ref.box[i]}`).toBeLessThanOrEqual(0.011));
      built.dispose();
    }
    ctx.dispose();
  });
});
