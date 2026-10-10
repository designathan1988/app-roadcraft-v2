// Geometria de lotes: classificação das arestas (testada, laterais, fundos) e
// área edificável com recuos diferentes por aresta.
//
// Área edificável = lote − (faixa de recuo de cada aresta ∪ disco em cada
// vértice). A faixa é o retângulo para dentro da aresta com a largura do seu
// recuo; o disco (polígono de 16 lados) cobre a cunha junto aos vértices
// reentrantes, onde as faixas sozinhas deixariam pontos perto demais da divisa.
import type { Lot, LotRules, Vec2 } from '../core/schema';
import { area, clean, signedArea } from './polygon';
import { difference, intersection, union, netArea, type PolygonWithHoles } from './boolean';

export type EdgeKind = 'front' | 'side' | 'back';

/** Polígono do lote orientado anti-horário (como as massas). */
export const lotPolygon = (lot: Lot): Vec2[] => (signedArea(lot.polygon) < 0 ? [...lot.polygon].reverse() : lot.polygon.map((p) => [p[0], p[1]] as Vec2));

/** Índices das arestas na ordem do polígono orientado. */
function orientedFront(lot: Lot): Set<number> {
  const n = lot.polygon.length;
  if (signedArea(lot.polygon) >= 0) return new Set(lot.frontEdges);
  // Ao inverter a ordem, a aresta i (p_i → p_i+1) vira a aresta n−2−i.
  return new Set(lot.frontEdges.map((i) => (((n - 2 - i) % n) + n) % n));
}

const outwardNormal = (a: Vec2, b: Vec2): Vec2 => {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    l = Math.hypot(dx, dz) || 1;
  return [dz / l, -dx / l];
};

/** Classifica cada aresta do polígono orientado: testada, lateral ou fundos. */
export function edgeKinds(lot: Lot): EdgeKind[] {
  const p = lotPolygon(lot),
    n = p.length,
    front = orientedFront(lot);
  if (!front.size) return p.map(() => 'side');
  // Direção média da rua: soma das normais externas das arestas de testada.
  let fx = 0,
    fz = 0;
  for (const i of front) {
    const nn = outwardNormal(p[i]!, p[(i + 1) % n]!);
    fx += nn[0];
    fz += nn[1];
  }
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  return p.map((a, i) => {
    if (front.has(i)) return 'front';
    const nn = outwardNormal(a, p[(i + 1) % n]!);
    return nn[0] * fx + nn[1] * fz < -0.7 ? 'back' : 'side';
  });
}

function disc(c: Vec2, r: number, sides = 16): Vec2[] {
  return Array.from({ length: sides }, (_, k) => {
    const t = (k / sides) * Math.PI * 2;
    return [c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r] as Vec2;
  });
}

/** Área onde se pode construir, respeitando os recuos (partes em coordenadas do mundo). */
export function buildableArea(lot: Lot, rules: LotRules | undefined = lot.rules): PolygonWithHoles[] {
  const p = lotPolygon(lot);
  if (!rules) return [[p]];
  const kinds = edgeKinds(lot),
    n = p.length;
  const setback = (k: EdgeKind) => Math.max(0, rules.setbacks[k]);
  const pieces: PolygonWithHoles[] = [];
  for (let i = 0; i < n; i++) {
    const s = setback(kinds[i]!);
    if (s <= 0) continue;
    const a = p[i]!,
      b = p[(i + 1) % n]!,
      [nx, nz] = outwardNormal(a, b);
    // Faixa para dentro (normal externa invertida), um pouco além das pontas.
    // A borda externa fica 1 cm fora do lote: contornos que coincidem
    // exatamente com a divisa derrubam o polygon-clipping.
    const dx = b[0] - a[0],
      dz = b[1] - a[1],
      l = Math.hypot(dx, dz) || 1,
      ex = (dx / l) * 0.01,
      ez = (dz / l) * 0.01,
      ox = nx * 0.01,
      oz = nz * 0.01;
    pieces.push([
      clean([
        [a[0] - ex + ox, a[1] - ez + oz],
        [b[0] + ex + ox, b[1] + ez + oz],
        [b[0] + ex - nx * s, b[1] + ez - nz * s],
        [a[0] - ex - nx * s, a[1] - ez - nz * s],
      ]),
    ]);
  }
  for (let i = 0; i < n; i++) {
    const r = Math.max(setback(kinds[(i - 1 + n) % n]!), setback(kinds[i]!));
    if (r > 0) pieces.push([disc(p[i]!, r)]);
  }
  if (!pieces.length) return [[p]];
  const band = union(pieces);
  let out: PolygonWithHoles[] = [[p]];
  for (const piece of band) {
    const next: PolygonWithHoles[] = [];
    for (const part of out) {
      // Subtrai o anel externo da peça; os furos da peça voltam a ser edificáveis.
      let rest = difference(part, piece[0]!);
      for (const h of piece.slice(1)) rest = [...rest, ...intersection(part, [h])];
      next.push(...rest);
    }
    out = next.filter((x) => netArea(x) > 0.01);
  }
  return out;
}

export const lotArea = (lot: Lot): number => area(lot.polygon);

/** Lote que contém o ponto (centro de um edifício), se houver. */
export function lotAt(lots: Lot[], x: number, z: number): Lot | undefined {
  return lots.find((l) => {
    const p = l.polygon;
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const a = p[i]!,
        b = p[j]!;
      if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  });
}
