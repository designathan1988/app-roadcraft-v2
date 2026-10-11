import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../src/core/schema';
import { gableEdges, skeletonRoof } from '../../src/geometry/roofs/skeleton-roof';
import { SkeletonError } from '../../src/geometry/roofs/skeleton';

const rect = (w: number, d: number): Vec2[] => [
  [-w / 2, -d / 2],
  [w / 2, -d / 2],
  [w / 2, d / 2],
  [-w / 2, d / 2],
];
const ys = (pos: number[]) => pos.filter((_, i) => i % 3 === 1);
const xs = (pos: number[]) => pos.filter((_, i) => i % 3 === 0);
const L: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 4],
  [4, 4],
  [4, 10],
  [0, 10],
];

describe('coberturas pelo esqueleto reto', () => {
  it('quatro águas: cumeeira na altura pedida, beiral abaixo do topo', () => {
    const g = skeletonRoof(rect(10, 6), [], { kind: 'hip', top: 3, height: 2, overhang: 0.5 });
    expect(Math.max(...ys(g.roof))).toBeCloseTo(5, 6);
    expect(Math.min(...ys(g.roof))).toBeLessThan(3);
    expect(Math.max(...xs(g.roof))).toBeCloseTo(5.5, 6);
    expect(g.gables).toHaveLength(0);
  });

  it('duas águas num retângulo: empenas nas arestas curtas', () => {
    expect(gableEdges(rect(10, 6), []).sort()).toEqual([1, 3]);
    const g = skeletonRoof(rect(10, 6), [], { kind: 'gable', top: 3, height: 2 });
    expect(g.gables.length).toBe(2 * 9);
    expect(Math.max(...ys(g.gables))).toBeCloseTo(5, 6);
    // Empenas no plano das paredes de topo (x = ±5).
    for (const x of xs(g.gables)) expect(Math.abs(Math.abs(x) - 5)).toBeLessThan(1e-6);
  });

  it('duas águas com direção: cumeeira no eixo pedido', () => {
    expect(gableEdges(rect(10, 6), [], 90).sort()).toEqual([0, 2]);
  });

  it('duas águas em L e quadrado', () => {
    const l = skeletonRoof(L, [], { kind: 'gable', top: 0, height: 2, overhang: 0.3 });
    expect(l.gableEdges.length).toBe(2);
    const q = skeletonRoof(rect(8, 8), [], { kind: 'gable', top: 0, height: 2 });
    expect(q.gableEdges.length).toBe(2);
  });

  it('mansarda: dobra entre as duas inclinações', () => {
    const g = skeletonRoof(rect(12, 8), [], { kind: 'mansard', top: 0, height: 3 });
    const y = ys(g.roof);
    expect(Math.max(...y)).toBeCloseTo(3, 6);
    expect(y.some((v) => Math.abs(v - 2.1) < 1e-6)).toBe(true);
  });

  it('pátio interno', () => {
    const hole: Vec2[] = [
      [-2, -2],
      [-2, 2],
      [2, 2],
      [2, -2],
    ];
    const g = skeletonRoof(rect(14, 14), [hole], { kind: 'hip', top: 0, height: 2, overhang: 0.4 });
    expect(Math.max(...ys(g.roof))).toBeCloseTo(2, 6);
  });

  it('fuzz: só SkeletonError, nunca outro erro', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let ok = 0;
    for (let k = 0; k < 150; k++) {
      const n = 4 + Math.floor(rnd() * 12);
      const pts: Vec2[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd() * 0.3;
        const r = 3 + rnd() * 8;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      for (const kind of ['hip', 'gable', 'mansard'] as const)
        try {
          const g = skeletonRoof(pts, [], { kind, top: 0, height: 2, overhang: 0.4 });
          expect(g.roof.length % 9).toBe(0);
          expect(g.roof.every(Number.isFinite)).toBe(true);
          ok++;
        } catch (e) {
          expect(e).toBeInstanceOf(SkeletonError);
        }
    }
    expect(ok).toBeGreaterThan(400);
  });
});
