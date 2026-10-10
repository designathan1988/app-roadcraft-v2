// Operações booleanas em planta (polygon-clipping) e validação de pátios.
import * as clipNs from 'polygon-clipping';
import type { Vec2 } from '../core/schema';
import { area, clean, simplifyRing, validPolygon, type PolygonLimits, DEFAULT_POLYGON_LIMITS } from './polygon';

// O pacote só tem exportação padrão no ESM, mas os tipos declaram exportações nomeadas.
const clip = ((clipNs as unknown as { default?: typeof clipNs }).default ?? clipNs) as typeof clipNs;

/** Polígono com furos: [externo, ...furos]. */
export type PolygonWithHoles = Vec2[][];

const netArea = (p: PolygonWithHoles): number => area(p[0]!) - p.slice(1).reduce((s, r) => s + area(r), 0);

/** Furos válidos: cada um é polígono simples, inteiro dentro do externo e sem sobrepor outro. */
export function validHoles(points: Vec2[], holes: Vec2[][], limits: PolygonLimits = DEFAULT_POLYGON_LIMITS): boolean {
  try {
    for (let i = 0; i < holes.length; i++) {
      const h = holes[i]!;
      if (!validPolygon(h, limits)) return false;
      const inside = clip.intersection([points], [h]).reduce((s, p) => s + netArea(p as PolygonWithHoles), 0);
      if (Math.abs(inside - area(h)) > 0.0001) return false;
      for (let j = 0; j < i; j++) if (clip.intersection([h], [holes[j]!]).some((p) => area(p[0] as Vec2[]) > 0.0001)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Resultado limpo: anel externo anti-horário, furos limpos, partes minúsculas descartadas. */
function normalize(result: clipNs.MultiPolygon, minArea = 0.15): PolygonWithHoles[] {
  return result
    .filter((p) => area(p[0] as Vec2[]) > minArea)
    .map((p) => p.map((r) => simplifyRing(clean(r as Vec2[]))).filter((r, i) => i === 0 || area(r) > 0.01));
}

/** Parte utilizável como base: polígono simples e pátios válidos. */
export const validPart = (p: PolygonWithHoles, limits: PolygonLimits = DEFAULT_POLYGON_LIMITS): boolean =>
  validPolygon(p[0], limits) && validHoles(p[0]!, p.slice(1), limits);

export function union(polys: PolygonWithHoles[]): PolygonWithHoles[] {
  if (polys.length < 2) return polys.map((p) => p.map((r) => clean(r)));
  const [first, ...rest] = polys;
  return normalize(clip.union(first as clipNs.Polygon, ...(rest as clipNs.Polygon[])));
}

export function difference(subject: PolygonWithHoles, cut: Vec2[]): PolygonWithHoles[] {
  return normalize(clip.difference(subject as clipNs.Polygon, [cut] as clipNs.Polygon));
}

export function intersection(a: PolygonWithHoles, b: PolygonWithHoles): PolygonWithHoles[] {
  return normalize(clip.intersection(a as clipNs.Polygon, b as clipNs.Polygon), 0);
}

export { netArea };
