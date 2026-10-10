// Valores iniciais e fábricas do documento forma/3. Sem three.
import type { Building3, Level, MaterialRef, PlanVertex, Project3, RoofKind, RoofSpec, Solid, SolidMaterials, Vec2 } from './schema';
import { SCHEMA3 } from './schema';

let counter = 0;
/** ID estável e único (crypto quando existe; contador como reserva em testes). */
export function uid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `id-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export const mat = (finish: string, color: string): MaterialRef => ({ finish, color });

export const DEFAULT_MATERIALS: SolidMaterials = {
  wall: mat('plaster', '#e8e1d3'),
  roof: mat('tile', '#9a5a3c'),
  trim: mat('paint', '#f4f1ea'),
  base: mat('stone', '#b9b2a4'),
};

export function roofSpec(kind: RoofKind = 'flat', extra: Partial<RoofSpec> = {}): RoofSpec {
  return { kind, pitch: 30, rise: 0, overhang: kind === 'flat' || kind === 'terrace' ? 0 : 0.5, direction: 0, parapet: kind === 'flat' ? 0.6 : 0, thickness: 0.2, ...extra };
}

export function planVertices(points: Vec2[], extra: (i: number) => Partial<PlanVertex> = () => ({})): PlanVertex[] {
  return points.map((p, i) => ({ id: uid(), p: [p[0], p[1]], ...extra(i) }));
}

export function rectPlan(w: number, d: number, cx = 0, cz = 0): PlanVertex[] {
  return planVertices([
    [cx - w / 2, cz - d / 2],
    [cx + w / 2, cz - d / 2],
    [cx + w / 2, cz + d / 2],
    [cx - w / 2, cz + d / 2],
  ]);
}

/** Círculo por quatro arcos de 90° (bulge = tan(90°/4)). */
export function circlePlan(r: number, cx = 0, cz = 0): PlanVertex[] {
  const b = Math.tan(Math.PI / 8);
  return planVertices(
    [
      [cx + r, cz],
      [cx, cz + r],
      [cx - r, cz],
      [cx, cz - r],
    ],
    () => ({ bulge: b }),
  );
}

export function solid(input: Partial<Solid> & { plan: Solid['plan'] }): Solid {
  return {
    id: uid(),
    name: 'Volume',
    op: 'add',
    base: 0,
    height: 6,
    taper: 0,
    edges: {},
    roof: roofSpec('flat'),
    facade: [],
    materials: structuredClone(DEFAULT_MATERIALS),
    plinth: 0.4,
    ...input,
  };
}

export function levelsFor(count: number, height = 3, ground = 3.4): Level[] {
  const out: Level[] = [];
  let y = 0;
  for (let i = 0; i < count; i++) {
    const h = i === 0 ? ground : height;
    out.push({ id: uid(), name: i === 0 ? 'Térreo' : `${i}º pavimento`, elevation: y, height: h });
    y += h;
  }
  return out;
}

export function building(input: Partial<Building3> = {}): Building3 {
  return { id: uid(), name: 'Edifício', lotId: null, position: [0, 0], rotation: 0, use: 'residential', levels: levelsFor(2), solids: [], items: [], interiors: {}, ...input };
}

export function project(input: Partial<Project3> = {}): Project3 {
  return { schema: SCHEMA3, name: 'Projeto sem título', lots: [], buildings: [], types: [], styles: [], meta: { createdWith: 'FORMA 3' }, ...input };
}

/** Regra de fachada (distribui um tipo pelos lados e níveis). */
export function facadeRule(type: string, input: Partial<import('./schema').FacadeRule> = {}): import('./schema').FacadeRule {
  return { id: uid(), type, levels: 'all', edges: [], mode: 'max', value: 3, margin: 0.8, sill: NaN, justify: 'center', except: {}, params: {}, ...input };
}
