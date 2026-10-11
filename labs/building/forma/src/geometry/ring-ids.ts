// Reatribuição de IDs depois de operações booleanas (recortar, unir).
// O polygon-clipping devolve só coordenadas; aqui os vértices, as arestas, os
// ajustes de fachada e as aberturas antigas são reencontrados no resultado:
//  - vértice a até 1 cm de um antigo mantém o ID;
//  - aresta colinear com uma antiga herda o ajuste (com splitFrom se o ID mudou);
//  - cada abertura vai para a aresta nova que contém o seu centro; se nenhuma
//    contém (parede recortada), a abertura é descartada.
import type { Building, EdgeOverride, ID, Mass, Opening, Ring, Vec2 } from '../core/schema';
import { uid } from '../core/ids';
import { sortedStoreys } from '../core/model';
import { distanceToSegment } from './polygon';
import { toLocal, toWorld, type Frame } from './frame';
import { massEdges } from './ring';
import type { PolygonWithHoles } from './boolean';

const TOL = 0.01;

export interface MassSource {
  building: Building;
  mass: Mass;
}

interface OldEdge {
  id: ID;
  a: Vec2;
  b: Vec2;
  override?: EdgeOverride;
}

interface OldOpening {
  opening: Opening;
  center: Vec2;
  /** Altura absoluta da base da abertura (y no edifício de origem). */
  y: number;
}

export interface RebuiltMass {
  outer: Ring;
  holes: Ring[];
  edges: Record<ID, EdgeOverride>;
  openings: Opening[];
}

export interface RebuildTarget {
  frame: Frame;
  massId: ID;
  /** Pavimentos do edifício de destino (para mapear aberturas por altura). */
  building: Building;
}

const parallel = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
  const ux = b[0] - a[0],
    uz = b[1] - a[1],
    vx = d[0] - c[0],
    vz = d[1] - c[1];
  const lu = Math.hypot(ux, uz),
    lv = Math.hypot(vx, vz);
  if (lu < 1e-9 || lv < 1e-9) return false;
  return Math.abs(ux * vz - uz * vx) / (lu * lv) < 1e-3;
};

export function rebuildMass(sources: MassSource[], poly: PolygonWithHoles, target: RebuildTarget, newId: () => ID = uid): RebuiltMass {
  const oldVerts: { id: ID; w: Vec2 }[] = [];
  const oldEdges: OldEdge[] = [];
  const oldOpenings: OldOpening[] = [];
  for (const { building: b, mass: m } of sources) {
    for (const r of [m.outer, ...m.holes]) for (const v of r.vertices) oldVerts.push({ id: v.id, w: toWorld(b, v.p) });
    const storeyById = new Map(b.storeys.map((s) => [s.id, s]));
    for (const e of massEdges(m)) {
      const wa = toWorld(b, e.a),
        wb = toWorld(b, e.b);
      const ov = m.edges[e.id];
      oldEdges.push({ id: e.id, a: wa, b: wb, ...(ov ? { override: ov } : {}) });
      for (const o of b.openings) {
        if (o.host.kind !== 'massEdge' || o.host.massId !== m.id || o.host.edgeId !== e.id || e.length < 1e-9) continue;
        const t = o.offset / e.length;
        const storey = storeyById.get(o.storeyId);
        oldOpenings.push({ opening: o, center: [wa[0] + (wb[0] - wa[0]) * t, wa[1] + (wb[1] - wa[1]) * t], y: (storey?.elevation ?? 0) + o.sill });
      }
    }
  }

  const used = new Set<ID>();
  const ringOf = (pts: Vec2[]): Ring => ({
    vertices: pts.map((w) => {
      let best: { id: ID; d: number } | null = null;
      for (const v of oldVerts) {
        if (used.has(v.id)) continue;
        const d = Math.hypot(v.w[0] - w[0], v.w[1] - w[1]);
        if (d <= TOL && (!best || d < best.d)) best = { id: v.id, d };
      }
      const id = best ? best.id : newId();
      used.add(id);
      return { id, p: toLocal(target.frame, w) };
    }),
  });
  const rings = poly.map(ringOf);
  const outer = rings[0]!,
    holes = rings.slice(1);

  // Arestas novas em coordenadas do mundo.
  const newEdges: { id: ID; a: Vec2; b: Vec2 }[] = [];
  for (const r of rings) {
    const n = r.vertices.length;
    for (let i = 0; i < n; i++) {
      const a = r.vertices[i]!,
        b = r.vertices[(i + 1) % n]!;
      newEdges.push({ id: a.id, a: toWorld(target.frame, a.p), b: toWorld(target.frame, b.p) });
    }
  }
  const containing = (p: Vec2, dirA: Vec2, dirB: Vec2, list: { a: Vec2; b: Vec2 }[]) =>
    list.find((e) => distanceToSegment(p[0], p[1], e.a, e.b) <= TOL && parallel(e.a, e.b, dirA, dirB));

  const edges: Record<ID, EdgeOverride> = {};
  for (const e of newEdges) {
    const mid: Vec2 = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    const old = containing(mid, e.a, e.b, oldEdges) as OldEdge | undefined;
    if (old?.override) edges[e.id] = old.id === e.id ? { ...old.override } : { ...old.override, splitFrom: old.id };
  }

  const storeys = sortedStoreys(target.building);
  const base = storeys[0]?.elevation ?? 0;
  const openings: Opening[] = [];
  for (const oo of oldOpenings) {
    const old = oldEdges.find((x) => oo.opening.host.kind === 'massEdge' && x.id === oo.opening.host.edgeId)!;
    const ne = containing(oo.center, old.a, old.b, newEdges) as (typeof newEdges)[number] | undefined;
    if (!ne || !storeys.length) continue;
    const y = Math.max(oo.y, base);
    let si = 0;
    for (let i = 0; i < storeys.length; i++) if (y >= storeys[i]!.elevation - 1e-9) si = i;
    const storey = storeys[si]!;
    openings.push({
      ...structuredClone(oo.opening),
      host: { kind: 'massEdge', massId: target.massId, edgeId: ne.id },
      storeyId: storey.id,
      offset: Math.hypot(oo.center[0] - ne.a[0], oo.center[1] - ne.a[1]),
      sill: y - storey.elevation,
    });
  }
  return { outer, holes, edges, openings };
}
