import { describe, expect, it } from 'vitest';
import { area, bounds, clean, shape, signedArea, validPolygon, pointInPolygon } from '../../src/geometry/polygon';
import { toLocal, toWorld } from '../../src/geometry/frame';
import { difference, union, validHoles } from '../../src/geometry/boolean';
import { Legacy, randomPolygon, rng } from './legacy';
import type { Vec2 } from '../../src/core/schema';

const round = (polys: Vec2[][][]) => polys.map((p) => p.map((r) => r.map(([x, z]) => [+x.toFixed(6), +z.toFixed(6)])));

describe('polígonos: paridade com o FormaCore legado', () => {
  it('validPolygon, clean, area e bounds coincidem em 2.000 polígonos aleatórios', () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const p = randomPolygon(r);
      expect(validPolygon(p)).toBe(Legacy.validPolygon(p));
      expect(clean(p)).toEqual(Legacy.clean(p));
      expect(area(p)).toBeCloseTo(Legacy.area(p), 9);
      expect(signedArea(p)).toBeCloseTo(Legacy.signedArea(p), 9);
      expect(bounds(p)).toEqual(Legacy.bounds(p));
    }
  });

  it('formas básicas idênticas', () => {
    for (const k of ['rect', 'l', 'u', 'circle']) for (const [w, d] of [[10, 8], [6, 14], [3.5, 2]]) expect(shape(k, w, d)).toEqual(Legacy.shape(k, w, d));
  });

  it('toWorld equivale a worldPolygon e toLocal é sua inversa', () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const f = { position: [(r() - 0.5) * 100, (r() - 0.5) * 100] as Vec2, rotation: (r() - 0.5) * 720 };
      const p: Vec2 = [(r() - 0.5) * 40, (r() - 0.5) * 40];
      const legacy = Legacy.worldPolygon({ x: f.position[0], z: f.position[1], rotation: f.rotation }, [p])[0];
      const w = toWorld(f, p);
      expect(w[0]).toBeCloseTo(legacy[0], 9);
      expect(w[1]).toBeCloseTo(legacy[1], 9);
      const back = toLocal(f, w);
      expect(back[0]).toBeCloseTo(p[0], 9);
      expect(back[1]).toBeCloseTo(p[1], 9);
    }
  });

  it('pointInPolygon', () => {
    const sq: Vec2[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    expect(pointInPolygon(2, 2, sq)).toBe(true);
    expect(pointInPolygon(5, 2, sq)).toBe(false);
  });
});

describe('booleanas: paridade com o FormaCore legado', () => {
  it('recorte (difference) gera as mesmas partes no mundo que cutVolume', () => {
    const r = rng(99);
    let compared = 0;
    for (let i = 0; i < 200; i++) {
      const w = 4 + r() * 20,
        d = 4 + r() * 20;
      const v = Legacy.volume({ points: Legacy.shape(['rect', 'l', 'u', 'circle'][i % 4], w, d), x: (r() - 0.5) * 40, z: (r() - 0.5) * 40, rotation: 0 });
      const cx = v.x + (r() - 0.5) * w,
        cz = v.z + (r() - 0.5) * d,
        s = 1 + r() * 8;
      const cut: Vec2[] = [[cx - s, cz - s * 0.6], [cx + s, cz - s * 0.6], [cx + s, cz + s * 0.6], [cx - s, cz + s * 0.6]];
      const legacyParts = Legacy.cutVolume(v, cut).map((p: { x: number; z: number; points: Vec2[]; holes: Vec2[][] }) =>
        [p.points, ...p.holes].map((ring) => ring.map(([x, z]) => [x + p.x, z + p.z])),
      );
      const subject = [Legacy.worldPolygon(v)];
      const ours = difference(subject, cut);
      expect(round(ours)).toEqual(round(legacyParts));
      compared++;
    }
    expect(compared).toBe(200);
  });

  it('união de dois retângulos que se tocam vira um L', () => {
    const a: Vec2[] = [[-13, -11], [13, -11], [13, -5], [-13, -5]];
    const b: Vec2[] = [[7, -5], [13, -5], [13, 9], [7, 9]];
    const u = union([[a], [b]]);
    expect(u).toHaveLength(1);
    expect(area(u[0]![0]!)).toBeCloseTo(26 * 6 + 6 * 14, 6);
  });

  it('validHoles igual ao legado', () => {
    const outer: Vec2[] = [[-10, -8], [10, -8], [10, 8], [-10, 8]];
    const cases: Vec2[][][] = [
      [[[-2, -2], [2, -2], [2, 2], [-2, 2]]],
      [[[-12, -2], [2, -2], [2, 2], [-12, 2]]],
      [[[-5, -2], [0, -2], [0, 2], [-5, 2]], [[-1, -1], [4, -1], [4, 1], [-1, 1]]],
    ];
    for (const holes of cases) expect(validHoles(outer, holes)).toBe(Legacy.validHoles(outer, holes));
  });
});
