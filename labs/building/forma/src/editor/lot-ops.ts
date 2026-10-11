// Operações de lote: criar, atribuir edifícios e preencher com um edifício válido.
import type { Building, ID, Lot, LotRules, Project, RoofKind, Vec2 } from '../core/schema';
import { uid } from '../core/ids';
import { DEFAULT_LOT_RULES, buildingFootprints, computeLotIndices } from '../core/indices';
import { area, bounds, boundsCenter, clean } from '../geometry/polygon';
import { buildableArea, lotArea, lotAt } from '../geometry/lot';
import { netArea } from '../geometry/boolean';
import { newBuilding, r2 } from './ops';

export function newLot(polygon: Vec2[], name: string, rules: LotRules = DEFAULT_LOT_RULES, newId: () => ID = uid): Lot {
  const p = clean(polygon);
  // Testada padrão: a aresta mais ao sul (maior z médio), voltada para a câmera inicial.
  let front = 0,
    best = -Infinity;
  p.forEach((a, i) => {
    const b = p[(i + 1) % p.length]!;
    const z = (a[1] + b[1]) / 2;
    if (z > best) {
      best = z;
      front = i;
    }
  });
  return { id: newId(), name, polygon: p, frontEdges: [front], rules: structuredClone(rules) };
}

/** Centro da base do edifício no mundo. */
function buildingCenter(b: Building): Vec2 {
  const fp = buildingFootprints(b)[0]?.[0];
  return fp ? boundsCenter(bounds(fp)) : b.position;
}

/** Liga cada edifício ao lote que contém o seu centro (ou a nenhum). */
export function assignLots(p: Project): void {
  for (const b of p.buildings) {
    const [x, z] = buildingCenter(b);
    b.lotId = lotAt(p.lots, x, z)?.id ?? null;
  }
}

export interface FillOptions {
  storeyHeight?: number;
  color?: string;
  roof?: RoofKind;
  name?: string;
}

/**
 * Gera um edifício que ocupa a área edificável do lote e respeita a taxa de
 * ocupação, o coeficiente, o gabarito e o número de pavimentos.
 */
export function fillLot(p: Project, lot: Lot, opts: FillOptions = {}, newId: () => ID = uid): Building | null {
  const rules = lot.rules ?? DEFAULT_LOT_RULES;
  const parts = buildableArea(lot, rules);
  if (!parts.length) return null;
  const main = parts.reduce((a, b) => (netArea(b) > netArea(a) ? b : a));
  let outer = main[0]!;
  const la = lotArea(lot);
  // Área já ocupada por outros edifícios do lote conta na taxa de ocupação.
  const others = computeLotIndices(p, lot, rules);
  const allowed = rules.maxOccupancy !== undefined ? Math.max(0, rules.maxOccupancy * la - others.occupiedArea) : Infinity;
  const a0 = area(outer);
  const target = Math.min(a0, allowed * 0.995);
  if (target < 4) return null;
  const [cx, cz] = boundsCenter(bounds(outer));
  if (target < a0) {
    const k = Math.sqrt(target / a0);
    outer = outer.map((q) => [cx + (q[0] - cx) * k, cz + (q[1] - cz) * k] as Vec2);
  }
  const footprint = area(outer);
  const sh = opts.storeyHeight ?? 3.2;
  const roof = opts.roof ?? 'flat';
  const extra = (rules.heightTo ?? 'ridge') === 'ridge' ? (roof === 'flat' ? 0.66 : 0.18 + 2.3) : 0;
  let n = 30;
  if (rules.maxHeight !== undefined) n = Math.min(n, Math.floor((rules.maxHeight - extra) / sh + 1e-9));
  if (rules.maxStoreys !== undefined) n = Math.min(n, rules.maxStoreys);
  if (rules.maxFAR !== undefined) n = Math.min(n, Math.floor((rules.maxFAR * la - others.builtArea) / footprint + 1e-9));
  if (n < 1) return null;
  const make = (pts: Vec2[]): Building => {
    const b = newBuilding(
      { name: opts.name ?? 'Edifício do lote', points: pts.map((q) => [q[0] - cx, q[1] - cz] as Vec2), position: [cx, cz], base: 0, height: r2(n * sh), floors: n, color: opts.color ?? '#d8d1c1', roof },
      newId,
    );
    b.lotId = lot.id;
    return b;
  };
  // Confere o resultado; em lotes irregulares, reduz até caber na área edificável.
  let pts = outer;
  for (let k = 0; k < 12; k++) {
    const b = make(pts);
    const check = computeLotIndices({ ...p, buildings: [...p.buildings, b] }, lot, rules);
    if (!check.violations.some((x) => x.buildingIds.includes(b.id) && (x.kind === 'setback' || x.kind === 'outside'))) return b;
    pts = pts.map((q) => [cx + (q[0] - cx) * 0.95, cz + (q[1] - cz) * 0.95] as Vec2);
  }
  return null;
}
