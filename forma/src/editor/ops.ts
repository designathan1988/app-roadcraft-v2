// Operações de edição sobre o modelo forma/2 (sem DOM nem three.js).
// Cada função altera o edifício recebido ou devolve novos edifícios.
import type { StylePack } from '../styles/schema';
import type { Building, EdgeOverride, FacadePattern, ID, Mass, Opening, OpeningFillType, Project, RoofKind, Storey, Vec2 } from '../core/schema';
import { uid } from '../core/ids';
import { massExtent, sortedStoreys } from '../core/model';
import { storeyName } from '../core/migrate/v1';
import { area, bounds, boundsCenter, clamp, clean, validPolygon } from '../geometry/polygon';
import { difference, netArea as polyNetArea, union as polyUnion, validHoles, validPart, type PolygonWithHoles } from '../geometry/boolean';
import { massEdges, ringPoints, findEdge } from '../geometry/ring';
import { ringToWorld, toWorld } from '../geometry/frame';
import { rebuildMass } from '../geometry/ring-ids';
import { clipInteriors, reframeInteriors, transformInteriors, updateRooms } from './interior-ops';
import { transformGraph } from '../geometry/walls';
import { toLocal } from '../geometry/frame';

export const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Massa principal (a interface da Fase 1 trabalha com uma massa por edifício). */
export const mainMass = (b: Building): Mass => b.masses[0]!;

// ── Consultas no estilo “volume” usadas pela interface ────────────────
export const baseOf = (b: Building): number => sortedStoreys(b)[0]?.elevation ?? 0;
export const heightOf = (b: Building): number => massExtent(b, mainMass(b)).height;
export const floorsOf = (b: Building): number => b.storeys.length;
export const outerOf = (b: Building): Vec2[] => ringPoints(mainMass(b).outer);
export const holesOf = (b: Building): Vec2[][] => mainMass(b).holes.map(ringPoints);
export const footprintArea = (b: Building): number => area(outerOf(b)) - holesOf(b).reduce((s, h) => s + area(h), 0);
/** Área construída: área da base × pavimentos. */
export const builtArea = (b: Building): number => footprintArea(b) * floorsOf(b);

export interface VolumeInput {
  name: string;
  points: Vec2[];
  holes?: Vec2[][];
  position: Vec2;
  rotation?: number;
  base: number;
  height: number;
  floors: number;
  color?: string;
  trim?: string;
  roof?: RoofKind;
  roofColor?: string;
  roofHeight?: number;
}

/** Cria um edifício com uma massa e `floors` pavimentos iguais. */
export function newBuilding(input: VolumeInput, newId: () => ID = uid): Building {
  const floors = Math.round(clamp(input.floors, 1, 30));
  const height = clamp(input.height, 0.5, 100);
  const lh = height / floors;
  const storeys: Storey[] = Array.from({ length: floors }, (_, i) => ({
    id: newId(),
    name: storeyName(i),
    elevation: input.base + i * lh,
    height: lh,
    slabThickness: 0.16,
    graph: { nodes: [], walls: [] },
    rooms: [],
  }));
  const ring = (pts: Vec2[]) => ({ vertices: clean(pts).map((p) => ({ id: newId(), p })) });
  const mass: Mass = {
    id: newId(),
    name: input.name,
    outer: ring(input.points),
    holes: (input.holes ?? []).map(ring),
    fromStorey: storeys[0]!.id,
    toStorey: storeys.at(-1)!.id,
    roof: { kind: input.roof ?? 'flat', height: input.roofHeight ?? 2.3, color: input.roofColor ?? '#474c4e' },
    facade: { pattern: 'regular', windowWidth: 1.35, windowHeight: 1.8, spacing: 2.5 },
    finish: { wall: input.color ?? '#b77b56', trim: input.trim ?? '#383e40' },
    flags: { balconies: false, brise: false, cornice: true, garden: false, pilotis: false },
    edges: {},
  };
  return {
    id: newId(),
    name: input.name,
    lotId: null,
    position: [input.position[0], input.position[1]],
    rotation: input.rotation ?? 0,
    storeys,
    masses: [mass],
    openings: [],
    slabs: [],
    stairs: [],
  };
}

/**
 * Redefine os pavimentos como `n` pavimentos iguais somando `total` metros.
 * Mantém os IDs dos pavimentos que continuam; aberturas de pavimentos removidos
 * são apagadas; peitoris acompanham a nova altura de cada pavimento.
 */
export function setStoreys(b: Building, n: number, total: number, newId: () => ID = uid): void {
  n = Math.round(clamp(n, 1, 30));
  total = r2(clamp(total, 0.5, 100));
  const base = baseOf(b);
  const old = sortedStoreys(b);
  const lh = total / n;
  const next: Storey[] = Array.from({ length: n }, (_, i) => {
    const prev = old[i];
    return prev
      ? { ...prev, elevation: base + i * lh, height: lh }
      : { id: newId(), name: storeyName(i), elevation: base + i * lh, height: lh, slabThickness: 0.16, graph: { nodes: [], walls: [] }, rooms: [] };
  });
  const kept = new Map(next.map((s) => [s.id, s]));
  const ratio = new Map(old.filter((s) => kept.has(s.id)).map((s) => [s.id, lh / s.height]));
  b.openings = b.openings.filter((o) => kept.has(o.storeyId));
  for (const o of b.openings) o.sill *= ratio.get(o.storeyId) ?? 1;
  b.stairs = b.stairs.filter((s) => kept.has(s.fromStorey) && kept.has(s.toStorey));
  b.slabs = b.slabs.filter((s) => kept.has(s.storeyId));
  b.storeys = next;
  for (const m of b.masses) {
    m.fromStorey = next[0]!.id;
    m.toStorey = next.at(-1)!.id;
  }
}

/** Pavimentos todos com a mesma altura (comportamento do v1). */
export const uniformStoreys = (b: Building): boolean => b.storeys.every((s) => Math.abs(s.height - b.storeys[0]!.height) < 1e-6);

/** Altura total: pavimentos iguais são redivididos; diferentes, escalados na proporção. */
export function setHeight(b: Building, h: number, newId?: () => ID): void {
  if (uniformStoreys(b)) return setStoreys(b, floorsOf(b), h, newId);
  const ordered = sortedStoreys(b),
    base = baseOf(b),
    k = clamp(h, 0.5, 100) / heightOf(b);
  let y = base;
  for (const s of ordered) {
    const nh = s.height * k;
    for (const o of b.openings) if (o.storeyId === s.id) o.sill *= k;
    s.elevation = r2(y);
    s.height = r2(nh);
    y += nh;
  }
}

/** Muda o número de andares mantendo o pé-direito (o novo copia o último). */
export function setFloors(b: Building, n: number, newId?: () => ID): void {
  n = Math.round(clamp(n, 1, 30));
  if (uniformStoreys(b)) {
    const fh = heightOf(b) / floorsOf(b);
    return setStoreys(b, n, fh * n, newId);
  }
  const ordered = sortedStoreys(b);
  if (n < ordered.length) {
    const keep = new Set(ordered.slice(0, n).map((s) => s.id));
    b.openings = b.openings.filter((o) => keep.has(o.storeyId));
    b.stairs = b.stairs.filter((s) => keep.has(s.fromStorey) && keep.has(s.toStorey));
    b.storeys = ordered.slice(0, n);
  } else {
    const id = newId ?? uid;
    for (let i = ordered.length; i < n; i++) {
      const last = b.storeys.at(-1)!;
      if (last.elevation + 2 * last.height > 100) break;
      b.storeys.push({ id: id(), name: storeyName(i), elevation: r2(last.elevation + last.height), height: last.height, slabThickness: last.slabThickness, graph: { nodes: [], walls: [] }, rooms: [] });
    }
  }
  for (const m of b.masses) {
    m.fromStorey = b.storeys[0]!.id;
    m.toStorey = b.storeys.at(-1)!.id;
  }
}

export function setBase(b: Building, base: number): void {
  const d = clamp(base, 0, 100) - baseOf(b);
  for (const s of b.storeys) s.elevation += d;
}

/** Comprimento de cada aresta, por ID (para reescalar aberturas). */
const edgeLengths = (m: Mass): Map<ID, number> => new Map(massEdges(m).map((e) => [e.id, e.length]));

/** Depois de mudar a forma, mantém cada abertura na mesma posição relativa da parede. */
function rescaleOpenings(b: Building, m: Mass, before: Map<ID, number>): void {
  const after = edgeLengths(m);
  for (const o of b.openings) {
    if (o.host.kind !== 'massEdge' || o.host.massId !== m.id) continue;
    const a = before.get(o.host.edgeId),
      c = after.get(o.host.edgeId);
    if (a && c) o.offset *= c / a;
  }
}

/** Substitui as coordenadas dos anéis mantendo os IDs (mesmo número de vértices). */
export function setFootprint(b: Building, outer: Vec2[], holes: Vec2[][] = holesOf(b)): boolean {
  const m = mainMass(b);
  if (outer.length !== m.outer.vertices.length || holes.length !== m.holes.length) return false;
  if (!validPolygon(outer) || !validHoles(outer, holes)) return false;
  const before = edgeLengths(m);
  m.outer.vertices.forEach((v, i) => (v.p = [outer[i]![0], outer[i]![1]]));
  m.holes.forEach((h, j) => h.vertices.forEach((v, i) => (v.p = [holes[j]![i]![0], holes[j]![i]![1]])));
  rescaleOpenings(b, m, before);
  return true;
}

/** Escala a base no eixo x ('width') ou z ('depth') em torno do centro. */
export function scaleFootprint(b: Building, axis: 'width' | 'depth', size: number): void {
  const pts = outerOf(b),
    bd = bounds(pts),
    isX = axis === 'width',
    old = isX ? bd.maxX - bd.minX : bd.maxZ - bd.minZ,
    c = isX ? (bd.maxX + bd.minX) / 2 : (bd.maxZ + bd.minZ) / 2,
    ratio = clamp(size, 0.5, 100) / old;
  const k = isX ? 0 : 1;
  const scale = (ring: Vec2[]) => ring.map((p) => {
    const q: Vec2 = [p[0], p[1]];
    q[k] = c + (p[k] - c) * ratio;
    return q;
  });
  setFootprint(b, scale(pts), holesOf(b).map(scale));
  transformInteriors(b, (p) => {
    const q: Vec2 = [p[0], p[1]];
    q[k] = c + (p[k] - c) * ratio;
    return q;
  });
}

/** Move a origem do edifício para o centro da base, sem mudar nada no mundo. */
export function recenter(b: Building): void {
  const all = b.masses.flatMap((m) => ringPoints(m.outer));
  if (!all.length) return;
  const [cx, cz] = boundsCenter(bounds(all));
  if (Math.abs(cx) < 1e-9 && Math.abs(cz) < 1e-9) return;
  const w = toWorld(b, [cx, cz]);
  for (const m of b.masses) for (const r of [m.outer, ...m.holes]) for (const v of r.vertices) v.p = [v.p[0] - cx, v.p[1] - cz];
  for (const s of b.storeys) for (const n of s.graph.nodes) n.p = [n.p[0] - cx, n.p[1] - cz];
  b.position = w;
}

export function setRotation(b: Building, deg: number): void {
  recenter(b);
  b.rotation = clamp(deg, -360, 360);
}

/**
 * Espelha a base em torno do centro (eixo x local). As fachadas e aberturas
 * acompanham: a aresta a→b vira b'→a', cujo ID é o do antigo vértice b.
 */
export function mirror(b: Building): void {
  const mb = bounds(ringPoints(mainMass(b).outer)),
    mmx = mb.minX + mb.maxX;
  transformInteriors(b, (p) => [mmx - p[0], p[1]]);
  for (const m of b.masses) {
    const bd = bounds(ringPoints(m.outer)),
      mx = bd.minX + bd.maxX;
    const remap = new Map<ID, ID>();
    for (const r of [m.outer, ...m.holes]) {
      const n = r.vertices.length;
      r.vertices.forEach((v, i) => remap.set(v.id, r.vertices[(i + 1) % n]!.id));
      for (const v of r.vertices) v.p = [mx - v.p[0], v.p[1]];
      r.vertices.reverse();
    }
    const lengths = edgeLengths(m);
    const edges: Record<ID, EdgeOverride> = {};
    for (const [id, o] of Object.entries(m.edges)) edges[remap.get(id) ?? id] = o;
    m.edges = edges;
    for (const o of b.openings) {
      if (o.host.kind !== 'massEdge' || o.host.massId !== m.id) continue;
      const id = remap.get(o.host.edgeId);
      if (!id) continue;
      o.host = { ...o.host, edgeId: id };
      o.offset = (lengths.get(id) ?? o.offset) - o.offset;
    }
  }
}

/** Copia o edifício com todos os IDs novos e referências internas preservadas. */
export function cloneBuilding(b: Building, newId: () => ID = uid): Building {
  const map = new Map<ID, ID>();
  const re = (id: ID): ID => {
    let n = map.get(id);
    if (!n) map.set(id, (n = newId()));
    return n;
  };
  const c = structuredClone(b);
  c.id = re(b.id);
  for (const s of c.storeys) {
    s.id = re(s.id);
    for (const n of s.graph.nodes) n.id = re(n.id);
    for (const w of s.graph.walls) {
      w.id = re(w.id);
      w.a = re(w.a);
      w.b = re(w.b);
    }
    for (const r of s.rooms) {
      r.id = re(r.id);
      r.wallIds = r.wallIds.map(re);
    }
  }
  for (const m of c.masses) {
    m.id = re(m.id);
    m.fromStorey = re(m.fromStorey);
    m.toStorey = re(m.toStorey);
    for (const r of [m.outer, ...m.holes]) for (const v of r.vertices) v.id = re(v.id);
    m.edges = Object.fromEntries(Object.entries(m.edges).map(([k, v]) => [re(k), v]));
  }
  for (const o of c.openings) {
    o.id = re(o.id);
    o.storeyId = re(o.storeyId);
    o.host = o.host.kind === 'massEdge' ? { kind: 'massEdge', massId: re(o.host.massId), edgeId: re(o.host.edgeId) } : { kind: 'wall', storeyId: re(o.host.storeyId), wallId: re(o.host.wallId) };
  }
  for (const s of c.slabs) {
    s.id = re(s.id);
    s.storeyId = re(s.storeyId);
  }
  for (const s of c.stairs) {
    s.id = re(s.id);
    s.fromStorey = re(s.fromStorey);
    s.toStorey = re(s.toStorey);
  }
  return c;
}

/** Cópias lado a lado no eixo x do mundo (Duplicar e Repetir). */
export function repeatBuildings(originals: Building[], count: number, gap: number, newId: () => ID = uid): Building[] {
  const out: Building[] = [];
  for (let k = 1; k <= count; k++)
    for (const o of originals) {
      const bd = bounds(outerOf(o));
      const c = cloneBuilding(o, newId);
      c.name = (o.name + ' · cópia').slice(0, 60);
      c.masses[0]!.name = c.name;
      c.position = [o.position[0] + (bd.maxX - bd.minX + gap) * k, o.position[1]];
      out.push(c);
    }
  return out;
}

/** Volume recuado de um pavimento sobre o topo (77% da base, centralizado). */
export function setback(b: Building, newId: () => ID = uid): Building {
  const m = mainMass(b),
    pts = outerOf(b),
    [cx, cz] = boundsCenter(bounds(pts)),
    s = 0.77;
  const scale = (r: Vec2[]) => r.map((p) => [cx + (p[0] - cx) * s, cz + (p[1] - cz) * s] as Vec2);
  const n = newBuilding(
    {
      name: (b.name + ' · recuo').slice(0, 60),
      points: scale(pts),
      holes: holesOf(b).map(scale),
      position: b.position,
      rotation: b.rotation,
      base: r2(baseOf(b) + heightOf(b) + 0.18),
      height: r2(heightOf(b) / floorsOf(b)),
      floors: 1,
      color: m.finish.wall,
      trim: m.finish.trim,
      roof: m.roof.kind,
      roofColor: m.roof.color,
      roofHeight: m.roof.height,
    },
    newId,
  );
  const nm = mainMass(n);
  nm.facade = { ...m.facade };
  nm.flags = { ...m.flags, garden: false };
  return n;
}

/** Polígono do edifício no mundo: [externo, ...furos]. */
export const worldPolygon = (b: Building, m: Mass = mainMass(b)): PolygonWithHoles => [ringToWorld(b, ringPoints(m.outer)), ...m.holes.map((h) => ringToWorld(b, ringPoints(h)))];

/** Monta edifícios a partir de partes no mundo, centrando cada um na própria base. */
function partsToBuildings(template: Building, sources: Building[], parts: PolygonWithHoles[], newId: () => ID): Building[] {
  return parts.map((poly, i) => {
    const [cx, cz] = boundsCenter(bounds(poly[0]!));
    const b = structuredClone(template);
    if (i > 0) {
      const fresh = cloneBuilding(template, newId);
      Object.assign(b, fresh);
    }
    b.name = (template.name + (parts.length > 1 ? ' ' + (i + 1) : '')).slice(0, 60);
    b.position = [cx, cz];
    b.rotation = 0;
    const m = mainMass(b);
    m.name = b.name;
    b.masses = [m];
    const rebuilt = rebuildMass(
      sources.map((s) => ({ building: s, mass: mainMass(s) })),
      poly,
      { frame: { position: b.position, rotation: 0 }, massId: m.id, building: b },
      newId,
    );
    m.outer = rebuilt.outer;
    m.holes = rebuilt.holes;
    m.edges = rebuilt.edges;
    b.openings = [...rebuilt.openings, ...b.openings.filter((o) => o.host.kind === 'wall')];
    // Interiores: leva do referencial do modelo para o novo e junta os dos outros edifícios.
    reframeInteriors(b, template, { position: b.position, rotation: 0 });
    for (const src of sources) {
      if (src.id === template.id) continue;
      mergeInteriors(b, src, newId);
    }
    clipInteriors(b);
    return b;
  });
}

/** Junta paredes, portas e escadas de outro edifício nos pavimentos de mesma altura. */
function mergeInteriors(dst: Building, src: Building, newId: () => ID): void {
  const c = cloneBuilding(src, newId);
  const map = new Map<ID, ID>();
  for (const s of c.storeys) {
    const t = dst.storeys.find((x) => Math.abs(x.elevation - s.elevation) < 0.01 && Math.abs(x.height - s.height) < 0.01);
    if (!t) continue;
    map.set(s.id, t.id);
    transformGraph(s.graph, (p) => toLocal({ position: dst.position, rotation: dst.rotation }, toWorld(c, p)));
    t.graph.nodes.push(...s.graph.nodes);
    t.graph.walls.push(...s.graph.walls);
  }
  for (const o of c.openings) {
    if (o.host.kind !== 'wall' || !map.has(o.host.storeyId)) continue;
    const sid = map.get(o.host.storeyId)!;
    dst.openings.push({ ...o, storeyId: sid, host: { ...o.host, storeyId: sid } });
  }
  for (const st of c.stairs) {
    if (!map.has(st.fromStorey) || !map.has(st.toStorey)) continue;
    dst.stairs.push({ ...st, fromStorey: map.get(st.fromStorey)!, toStorey: map.get(st.toStorey)!, path: st.path.map((p) => toLocal({ position: dst.position, rotation: dst.rotation }, toWorld(c, p))) });
  }
  for (const s of dst.storeys) updateRooms(dst, s.id, newId);
}

/** Recorta a base pelo polígono `cut` (mundo). Devolve as partes ou null se nada mudou. */
export function cutBuilding(b: Building, cut: Vec2[], newId: () => ID = uid): Building[] | null {
  if (!validPolygon(cut)) throw new Error('Recorte inválido.');
  const before = worldPolygon(b);
  const parts = difference(before, cut);
  if (parts.length === 1 && Math.abs(polyNetArea(parts[0]!) - polyNetArea(before)) < 0.01) return null;
  if (parts.some((p) => !validPart(p))) throw new Error('O recorte gerou uma base inválida. Ajuste o desenho e tente de novo.');
  return partsToBuildings(b, [b], parts, newId);
}

/** Une as bases de edifícios com a mesma elevação e altura. */
export function unionBuildings(bs: Building[], newId: () => ID = uid): Building[] {
  if (bs.length < 2) throw new Error('Selecione pelo menos dois volumes.');
  const b0 = bs[0]!;
  if (bs.some((b) => Math.abs(baseOf(b) - baseOf(b0)) > 0.01 || Math.abs(heightOf(b) - heightOf(b0)) > 0.01))
    throw new Error('Para unir bases, os volumes precisam ter a mesma altura e elevação.');
  const parts = polyUnion(bs.map((b) => worldPolygon(b)));
  if (parts.some((p) => !validPart(p))) throw new Error('A união gerou uma base inválida. Ajuste os volumes e tente de novo.');
  return partsToBuildings(b0, bs, parts, newId);
}

// ── Fachadas e aberturas ──────────────────────────────────────────────
export type EdgeProp = 'pattern' | 'wall' | 'trim' | 'windowWidth' | 'windowHeight' | 'spacing' | 'balconies' | 'brise';

/** Altera uma propriedade da massa inteira ou só de uma aresta. */
export function setFacadeProp(b: Building, edgeId: ID | null, prop: EdgeProp, value: string | number | boolean): void {
  const m = mainMass(b);
  if (edgeId) {
    const o = (m.edges[edgeId] ??= {});
    (o as Record<string, unknown>)[prop] = value;
    return;
  }
  if (prop === 'pattern') m.facade.pattern = value as FacadePattern;
  else if (prop === 'wall') m.finish.wall = value as string;
  else if (prop === 'trim') m.finish.trim = value as string;
  else if (prop === 'balconies' || prop === 'brise') m.flags[prop] = value as boolean;
  else m.facade[prop] = value as number;
}

/** Aplica uma distribuição de fachada: na aresta (limpa aberturas desenhadas) ou na massa toda. */
export function applyPattern(b: Building, edgeId: ID | null, pattern: FacadePattern): void {
  const m = mainMass(b);
  if (edgeId) {
    m.edges[edgeId] = { ...(m.edges[edgeId] ?? {}), pattern, manual: false };
    b.openings = b.openings.filter((o) => !(o.host.kind === 'massEdge' && o.host.massId === m.id && o.host.edgeId === edgeId));
  } else {
    m.facade.pattern = pattern;
    m.edges = {};
    b.openings = b.openings.filter((o) => !(o.host.kind === 'massEdge' && o.host.massId === m.id));
  }
}

/** Leva a configuração de uma aresta para a massa inteira. */
export function applyEdgeToAll(b: Building, edgeId: ID): boolean {
  const m = mainMass(b),
    o = m.edges[edgeId];
  if (!o) return false;
  if (o.pattern) m.facade.pattern = o.pattern;
  if (o.wall) m.finish.wall = o.wall;
  if (o.trim) m.finish.trim = o.trim;
  for (const k of ['windowWidth', 'windowHeight', 'spacing'] as const) if (o[k] !== undefined) m.facade[k] = o[k]!;
  for (const k of ['balconies', 'brise'] as const) if (o[k] !== undefined) m.flags[k] = o[k]!;
  m.edges = {};
  b.openings = b.openings.filter((x) => !(x.host.kind === 'massEdge' && x.host.massId === m.id));
  return true;
}

export interface OpeningDraw {
  edgeId: ID;
  /** Início e largura ao longo da aresta (m). */
  x: number;
  width: number;
  /** Base e altura medidas a partir da base da massa (m). */
  y: number;
  height: number;
  kind: OpeningFillType;
}

/** Desenha uma abertura numa aresta; a aresta passa a usar só aberturas desenhadas. */
export function addOpening(b: Building, d: OpeningDraw, newId: () => ID = uid): Opening | null {
  const m = mainMass(b),
    e = findEdge(m, d.edgeId);
  if (!e) return null;
  const { storeys, base } = massExtent(b, m);
  const o = (m.edges[d.edgeId] ??= {});
  if (!o.manual) b.openings = b.openings.filter((x) => !(x.host.kind === 'massEdge' && x.host.massId === m.id && x.host.edgeId === d.edgeId));
  o.manual = true;
  let si = 0;
  for (let i = 0; i < storeys.length; i++) if (base + d.y >= storeys[i]!.elevation - 1e-9) si = i;
  const s = storeys[si]!;
  const op: Opening = {
    id: newId(),
    host: { kind: 'massEdge', massId: m.id, edgeId: d.edgeId },
    storeyId: s.id,
    offset: d.x + d.width / 2,
    sill: Math.max(0, base + d.y - s.elevation),
    width: d.width,
    height: d.height,
    fill: { type: d.kind },
  };
  b.openings.push(op);
  return op;
}

export function setRoof(b: Building, kind: RoofKind): void {
  mainMass(b).roof.kind = kind;
}

export type MassFlag = 'cornice' | 'garden' | 'pilotis';

export function setFlag(b: Building, flag: MassFlag, value: boolean): void {
  mainMass(b).flags[flag] = value;
}

/** Estatísticas do projeto. */
export function projectStats(p: Project): { buildings: number; builtArea: number } {
  return { buildings: p.buildings.length, builtArea: p.buildings.reduce((s, b) => s + b.masses.reduce((t, m) => {
    const { storeys } = massExtent(b, m);
    return t + (area(ringPoints(m.outer)) - m.holes.reduce((u, h) => u + area(ringPoints(h)), 0)) * storeys.length;
  }, 0), 0) };
}

export { edgeLengths };

/** Aplica um pacote de estilo (ou remove, com null) a todas as massas do edifício. */
export function applyStyle(b: Building, pack: StylePack | null): void {
  for (const m of b.masses) delete m.style;
  if (!pack) {
    delete b.styleRef;
    return;
  }
  b.styleRef = pack.id;
  for (const m of b.masses) {
    m.finish.wall = pack.materials.wall.color;
    m.finish.trim = pack.materials.trim.color;
    if (pack.materials.roof) m.roof.color = pack.materials.roof.color;
    if (pack.roof?.kind) m.roof.kind = pack.roof.kind;
    if (pack.roof?.height !== undefined) m.roof.height = pack.roof.height;
    if (pack.roof?.overhang !== undefined) m.roof.overhang = pack.roof.overhang;
    if (pack.flags) Object.assign(m.flags, pack.flags);
    // Ajustes de fachada por face dão lugar ao estilo (aberturas desenhadas ficam).
    for (const o of Object.values(m.edges)) {
      for (const k of ['pattern', 'windowWidth', 'windowHeight', 'spacing', 'wall', 'trim', 'balconies', 'brise'] as const) delete o[k];
    }
  }
}
