// Teste aleatório da reatribuição de IDs depois de recortes.
import { describe, expect, it } from 'vitest';
import type { Building, Project, Vec2 } from '../../src/core/schema';
import { SCHEMA } from '../../src/core/schema';
import { validateProject } from '../../src/core/validate';
import { sequentialIds } from '../../src/core/ids';
import { massEdges } from '../../src/geometry/ring';
import { toWorld } from '../../src/geometry/frame';
import { distanceToSegment, pointInPolygon, shape } from '../../src/geometry/polygon';
import { addOpening, cutBuilding, mainMass, newBuilding } from '../../src/editor/ops';
import { rng } from './legacy';

function centers(b: Building) {
  const edges = massEdges(mainMass(b));
  return b.openings.map((o) => {
    const e = edges.find((x) => o.host.kind === 'massEdge' && x.id === o.host.edgeId)!;
    const t = o.offset / e.length;
    const w = toWorld(b, [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t]);
    return { id: o.id, w, y: b.storeys.find((s) => s.id === o.storeyId)!.elevation + o.sill };
  });
}

describe('ring-ids: recortes aleatórios', () => {
  it('300 casos: resultado válido, aberturas fora do recorte preservadas no mesmo ponto', () => {
    const r = rng(2024);
    let survived = 0,
      dropped = 0,
      rejected = 0;
    for (let i = 0; i < 300; i++) {
      const newId = sequentialIds('f' + i);
      const kind = ['rect', 'l', 'u', 'circle'][i % 4]!;
      const w = 8 + r() * 20,
        d = 8 + r() * 20;
      const b = newBuilding({ name: 'F', points: shape(kind, w, d), position: [(r() - 0.5) * 60, (r() - 0.5) * 60], rotation: (r() - 0.5) * 180, base: 0, height: 9.6, floors: 3 }, newId);
      const edges = massEdges(mainMass(b)).filter((e) => e.length > 1.3);
      if (!edges.length) continue;
      for (let k = 0; k < 6; k++) {
        const e = edges[Math.floor(r() * edges.length)]!;
        addOpening(b, { edgeId: e.id, x: r() * (e.length - 1.2), width: 1, y: r() * 8, height: 1.2, kind: 'window' }, newId);
        if (r() < 0.5) mainMass(b).edges[e.id] = { ...mainMass(b).edges[e.id], wall: '#00aa00' };
      }
      const before = centers(b);
      const cx = b.position[0] + (r() - 0.5) * w,
        cz = b.position[1] + (r() - 0.5) * d,
        sx = 0.5 + r() * w * 0.4,
        sz = 0.5 + r() * d * 0.6;
      const cut: Vec2[] = [[cx - sx, cz - sz], [cx + sx, cz - sz], [cx + sx, cz + sz], [cx - sx, cz + sz]];
      let parts: Building[] | null = null;
      try {
        parts = cutBuilding(b, cut, newId);
      } catch (err) {
        // Recusa explícita é aceitável; resultado inválido não.
        expect((err as Error).message).toContain('base inválida');
        rejected++;
        continue;
      }
      if (!parts) continue;
      const project: Project = { schema: SCHEMA, name: 'F', lots: [], buildings: parts, styles: [], meta: { createdWith: 't' } };
      expect(() => validateProject(project), `caso ${i}`).not.toThrow();
      const after = parts.flatMap(centers);
      for (const c of before) {
        const nearCutEdge = cut.some((a, j) => distanceToSegment(c.w[0], c.w[1], a, cut[(j + 1) % 4]!) < 0.05);
        if (nearCutEdge) continue;
        const inside = pointInPolygon(c.w[0], c.w[1], cut);
        const hit = after.find((x) => Math.hypot(x.w[0] - c.w[0], x.w[1] - c.w[1]) < 1e-6 && Math.abs(x.y - c.y) < 1e-6);
        if (inside) {
          expect(hit, `caso ${i}: abertura dentro do recorte deveria sumir`).toBeUndefined();
          dropped++;
        } else {
          expect(hit, `caso ${i}: abertura fora do recorte deveria ficar`).toBeDefined();
          survived++;
        }
      }
    }
    expect(survived).toBeGreaterThan(300);
    expect(dropped).toBeGreaterThan(20);
    expect(rejected).toBeLessThan(15);
  });
});
