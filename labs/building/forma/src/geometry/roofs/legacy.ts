// Coberturas do v1 (inclinada, duas águas, curva), calculadas pelo retângulo
// envolvente. Mantidas para paridade; a Fase 4 traz o esqueleto reto.
import earcut from 'earcut';
import type { Vec2 } from '../../core/schema';
import { bounds } from '../polygon';

export type LegacyRoofKind = 'shed' | 'gable' | 'dome';

/** Triângulos do telhado em [x, y, z, ...], com y medido a partir de `base`. */
export function legacyRoofPositions(kind: LegacyRoofKind, outer: Vec2[], holes: Vec2[][], top: number, roofHeight: number, base = 0): number[] {
  const bd = bounds(outer),
    w = bd.maxX - bd.minX,
    d = bd.maxZ - bd.minZ,
    cx = (bd.minX + bd.maxX) / 2,
    cz = (bd.minZ + bd.maxZ) / 2;
  const roofY = (x: number, z: number): number =>
    base +
    top +
    0.18 +
    roofHeight *
      (kind === 'shed'
        ? (x - bd.minX) / w
        : kind === 'dome'
          ? Math.sqrt(Math.max(0, 1 - ((x - cx) / (w * 0.72)) ** 2 - ((z - cz) / (d * 0.72)) ** 2))
          : 1 - Math.abs((x - cx) / (w / 2)));
  const all = [...outer, ...holes.flat()];
  const flat: number[] = [];
  const holeIndices: number[] = [];
  for (const p of outer) flat.push(p[0], p[1]);
  let idx = outer.length;
  for (const h of holes) {
    holeIndices.push(idx);
    idx += h.length;
    for (const p of h) flat.push(p[0], p[1]);
  }
  const tri = earcut(flat, holeIndices);
  const verts: number[] = [];
  const push = (...pts: Vec2[]) => {
    for (const a of pts) verts.push(a[0], roofY(a[0], a[1]), a[1]);
  };
  const n = kind === 'dome' ? 10 : 8;
  for (let t = 0; t < tri.length; t += 3) {
    const a = all[tri[t]!]!,
      b = all[tri[t + 1]!]!,
      c = all[tri[t + 2]!]!;
    const pt = (i: number, j: number): Vec2 => [
      a[0] + ((b[0] - a[0]) * i) / n + ((c[0] - a[0]) * j) / n,
      a[1] + ((b[1] - a[1]) * i) / n + ((c[1] - a[1]) * j) / n,
    ];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n - i; j++) {
        push(pt(i, j), pt(i + 1, j), pt(i, j + 1));
        if (j < n - i - 1) push(pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1));
      }
  }
  // Fechamentos laterais entre o topo das paredes e o telhado.
  for (const ring of [outer, ...holes])
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      for (let k = 0; k < 8; k++) {
        const p: Vec2 = [a[0] + ((b[0] - a[0]) * k) / 8, a[1] + ((b[1] - a[1]) * k) / 8],
          q: Vec2 = [a[0] + ((b[0] - a[0]) * (k + 1)) / 8, a[1] + ((b[1] - a[1]) * (k + 1)) / 8];
        const topP = [p[0], roofY(...p), p[1]],
          topQ = [q[0], roofY(...q), q[1]],
          botP = [p[0], base + top, p[1]],
          botQ = [q[0], base + top, q[1]];
        verts.push(...botP, ...topP, ...topQ, ...botP, ...topQ, ...botQ);
      }
    }
  return verts;
}
