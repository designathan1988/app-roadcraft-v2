import { describe, expect, it } from 'vitest';
import { offsetRing, ringValid, sampleRing, signedArea2, edgeLengths } from '../../src/f3/model/plan';
import type { PlanVertex } from '../../src/f3/model/schema';

const v = (id: string, x: number, z: number, extra: Partial<PlanVertex> = {}): PlanVertex => ({ id, p: [x, z], ...extra });

describe('planta forma/3', () => {
  it('retângulo anti-horário: 4 segmentos, um por lado', () => {
    const r = sampleRing([v('a', 0, 0), v('b', 10, 0), v('c', 10, 8), v('d', 0, 8)]);
    expect(r.pts).toHaveLength(4);
    expect(r.segs.map((s) => s.edge)).toEqual(['a', 'b', 'c', 'd']);
    expect(signedArea2(r.pts)).toBeCloseTo(80);
  });

  it('círculo de dois arcos fica para fora e tem a área do círculo', () => {
    const r = sampleRing([v('a', -5, 0, { bulge: 1 }), v('b', 5, 0, { bulge: 1 })]);
    expect(Math.abs(signedArea2(r.pts))).toBeGreaterThan(Math.PI * 25 * 0.98);
    expect(signedArea2(r.pts)).toBeGreaterThan(0);
    const L = edgeLengths(r);
    expect(L.get('a')).toBeGreaterThan(Math.PI * 5 * 0.99);
  });

  it('arco num lado de retângulo empurra para fora', () => {
    const plain = sampleRing([v('a', 0, 0), v('b', 10, 0), v('c', 10, 8), v('d', 0, 8)]);
    const bowed = sampleRing([v('a', 0, 0, { bulge: 0.3 }), v('b', 10, 0), v('c', 10, 8), v('d', 0, 8)]);
    expect(signedArea2(bowed.pts)).toBeGreaterThan(signedArea2(plain.pts));
  });

  it('canto arredondado e chanfrado reduzem a área e viram segmentos de canto', () => {
    const base = [v('a', 0, 0), v('b', 10, 0), v('c', 10, 8), v('d', 0, 8)];
    const round = sampleRing(base.map((x, i) => (i === 1 ? { ...x, round: 2 } : x)));
    const cham = sampleRing(base.map((x, i) => (i === 1 ? { ...x, chamfer: 2 } : x)));
    expect(signedArea2(round.pts)).toBeCloseTo(80 - (4 - Math.PI), 1);
    expect(signedArea2(cham.pts)).toBeCloseTo(80 - 2, 5);
    expect(cham.segs.some((s) => s.edge === 'b:c')).toBe(true);
  });

  it('deslocamento uniforme para dentro encolhe o retângulo', () => {
    const r = sampleRing([v('a', 0, 0), v('b', 10, 0), v('c', 10, 8), v('d', 0, 8)]);
    const top = offsetRing(r.pts, [1, 1, 1, 1]);
    expect(signedArea2(top)).toBeCloseTo(8 * 6);
    expect(ringValid(top, 1)).toBe(true);
    expect(ringValid(offsetRing(r.pts, [5, 5, 5, 5]), 1)).toBe(false);
  });
});
