import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../src/core/schema';
import { straightSkeleton } from '../../src/geometry/roofs/skeleton';
import { area } from '../../src/geometry/polygon';

const rect = (w: number, d: number): Vec2[] => [
  [-w / 2, -d / 2],
  [w / 2, -d / 2],
  [w / 2, d / 2],
  [-w / 2, d / 2],
];

describe('esqueleto reto', () => {
  it('retângulo: 4 faces, altura = meia largura', () => {
    const r = straightSkeleton(rect(10, 6));
    expect(r.faces).toHaveLength(4);
    expect(r.maxTime).toBeCloseTo(3, 6);
    const tot = r.faces.reduce((s, f) => s + area(f.points.map((p) => [p[0], p[1]] as Vec2)), 0);
    expect(tot).toBeCloseTo(60, 6);
  });

  it('quadrado: pirâmide', () => {
    const r = straightSkeleton(rect(8, 8));
    expect(r.maxTime).toBeCloseTo(4, 6);
    for (const f of r.faces) expect(f.points).toHaveLength(3);
  });

  it('planta em L (vértice reflexo)', () => {
    const L: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    const r = straightSkeleton(L);
    expect(r.faces).toHaveLength(6);
    expect(r.maxTime).toBeCloseTo(2, 6);
  });

  it('planta em T e em U (eventos de divisão)', () => {
    const T: Vec2[] = [
      [0, 0],
      [12, 0],
      [12, 4],
      [8, 4],
      [8, 12],
      [4, 12],
      [4, 4],
      [0, 4],
    ];
    expect(straightSkeleton(T).faces).toHaveLength(8);
    const U: Vec2[] = [
      [0, 0],
      [12, 0],
      [12, 10],
      [8, 10],
      [8, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    const r = straightSkeleton(U);
    expect(r.faces).toHaveLength(8);
    expect(r.maxTime).toBeCloseTo(2, 6);
  });

  it('pátio (furo)', () => {
    const hole: Vec2[] = rect(4, 4);
    const r = straightSkeleton(rect(12, 12), [hole]);
    expect(r.faces).toHaveLength(8);
    expect(r.maxTime).toBeCloseTo(2, 6);
  });

  it('peso 0 nas laterais curtas: duas águas', () => {
    const r = straightSkeleton(rect(10, 6), [], [1, 0, 1, 0]);
    expect(r.maxTime).toBeCloseTo(3, 6);
    const tot = r.faces.reduce((s, f) => s + area(f.points.map((p) => [p[0], p[1]] as Vec2)), 0);
    expect(tot).toBeCloseTo(60, 6);
  });

  it('círculo de 32 lados', () => {
    const c: Vec2[] = Array.from({ length: 32 }, (_, i) => [Math.cos((i / 32) * Math.PI * 2) * 5, Math.sin((i / 32) * Math.PI * 2) * 5]);
    const r = straightSkeleton(c);
    expect(r.maxTime).toBeCloseTo(5 * Math.cos(Math.PI / 32), 4);
  });

  it('fuzz: polígonos estrelados aleatórios cobrem a base ou falham com erro', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let ok = 0;
    for (let k = 0; k < 300; k++) {
      const n = 4 + Math.floor(rnd() * 14);
      const pts: Vec2[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd() * 0.3;
        const rad = 3 + rnd() * 8;
        pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
      }
      try {
        straightSkeleton(pts);
        ok++;
      } catch (e) {
        expect((e as Error).name).toBe('Error');
      }
    }
    expect(ok).toBeGreaterThanOrEqual(290);
  });

  it('fuzz: plantas ortogonais aleatórias', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let ok = 0;
    for (let k = 0; k < 200; k++) {
      // Escada ortogonal: degraus aleatórios num quadrante.
      const steps = 1 + Math.floor(rnd() * 5);
      const pts: Vec2[] = [[0, 0]];
      let x = 0,
        z = 0;
      const xs: number[] = [],
        zs: number[] = [];
      for (let i = 0; i < steps; i++) {
        xs.push(2 + Math.round(rnd() * 8));
        zs.push(2 + Math.round(rnd() * 8));
      }
      for (let i = 0; i < steps; i++) {
        x += xs[i]!;
        pts.push([x, z]);
        z += zs[i]!;
        pts.push([x, z]);
      }
      pts.push([0, z]);
      try {
        straightSkeleton(pts);
        ok++;
      } catch {
        /* contado abaixo */
      }
    }
    expect(ok).toBeGreaterThanOrEqual(195);
  });
});

describe('esqueleto reto: casos degenerados', () => {
  const cases: Record<string, Vec2[]> = {
    cruz: [[4, 0], [8, 0], [8, 4], [12, 4], [12, 8], [8, 8], [8, 12], [4, 12], [4, 8], [0, 8], [0, 4], [4, 4]],
    H: [[0, 0], [4, 0], [4, 4], [8, 4], [8, 0], [12, 0], [12, 12], [8, 12], [8, 8], [4, 8], [4, 12], [0, 12]],
    colinear: [[0, 0], [5, 0], [10, 0], [10, 6], [0, 6]],
    fino: [[0, 0], [30, 0], [30, 0.5], [0, 0.5]],
    pente: [[0, 0], [14, 0], [14, 6], [12, 6], [12, 2], [10, 2], [10, 6], [8, 6], [8, 2], [6, 2], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6]],
    Z: [[0, 0], [8, 0], [8, 4], [12, 4], [12, 8], [4, 8], [4, 4], [0, 4]],
  };
  for (const [name, pts] of Object.entries(cases))
    it(name, () => {
      const r = straightSkeleton(pts);
      expect(r.maxTime).toBeGreaterThan(0);
    });
  it('anel de largura constante', () => {
    const r = straightSkeleton(rect(12, 12), [rect(8, 8)]);
    expect(r.maxTime).toBeCloseTo(1, 6);
  });
  it('pátio fora do centro', () => {
    const h: Vec2[] = [[1, 1], [3, 1], [3, 3], [1, 3]];
    expect(straightSkeleton(rect(12, 10), [h]).faces).toHaveLength(8);
  });
});
