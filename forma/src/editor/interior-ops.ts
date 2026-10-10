// Operações de interiores: paredes, portas internas, escadas, cômodos,
// altura por pavimento e agrupamento de edifícios.
import type { Building, ID, Mass, Opening, Room, Stair, Storey, Vec2 } from '../core/schema';
import { uid } from '../core/ids';
import { massStoreys, sortedStoreys } from '../core/model';
import { clamp, pointInPolygon } from '../geometry/polygon';
import { ringPoints } from '../geometry/ring';
import { toLocal, toWorld, type Frame } from '../geometry/frame';
import { addWall, removeWall, transformGraph, wallEnds } from '../geometry/walls';
import { detectRooms, matchRooms, storeySegments } from '../geometry/rooms';
import { stairFootprint } from '../geometry/stairs';
import { storeyName } from '../core/migrate/v1';
import { r2 } from './ops';

export const storeyOf = (b: Building, id: ID): Storey | undefined => b.storeys.find((s) => s.id === id);

/** Massas que ocupam o pavimento. */
export function massesAt(b: Building, storeyId: ID): Mass[] {
  return b.masses.filter((m) => massStoreys(b, m).some((s) => s.id === storeyId));
}

/** Contornos (paredes externas) do pavimento: [externos], [pátios]. */
export function storeyOutlines(b: Building, storeyId: ID): { outer: Vec2[][]; holes: Vec2[][] } {
  const ms = massesAt(b, storeyId);
  return { outer: ms.map((m) => ringPoints(m.outer)), holes: ms.flatMap((m) => m.holes.map(ringPoints)) };
}

/** Recalcula os cômodos do pavimento mantendo IDs e nomes. */
export function updateRooms(b: Building, storeyId: ID, newId: () => ID = uid): Room[] {
  const s = storeyOf(b, storeyId);
  if (!s) return [];
  const { outer, holes } = storeyOutlines(b, storeyId);
  if (!outer.length) {
    s.rooms = [];
    return [];
  }
  // O vão das escadas que chegam neste pavimento não é área de cômodo.
  const voids = b.stairs.filter((st) => st.toStorey === storeyId).flatMap((st) => stairFootprint(st.path, st.width).map((p) => p[0]!));
  const detected = detectRooms(storeySegments(s.graph, [...outer, ...holes]), outer, [...holes, ...voids]);
  const wallsOf = (d: { polygon: Vec2[] }) =>
    s.graph.walls
      .filter((w) => {
        const e = wallEnds(s.graph, w);
        if (!e) return false;
        const m: Vec2 = [(e[0][0] + e[1][0]) / 2, (e[0][1] + e[1][1]) / 2];
        // Parede no contorno do cômodo: o meio dela fica sobre uma aresta do polígono.
        return d.polygon.some((p, i) => {
          const q = d.polygon[(i + 1) % d.polygon.length]!;
          const dx = q[0] - p[0],
            dz = q[1] - p[1],
            l2 = dx * dx + dz * dz || 1;
          const t = ((m[0] - p[0]) * dx + (m[1] - p[1]) * dz) / l2;
          return t >= -1e-6 && t <= 1 + 1e-6 && Math.hypot(p[0] + dx * t - m[0], p[1] + dz * t - m[1]) < 1e-3;
        });
      })
      .map((w) => w.id);
  s.rooms = matchRooms(s.rooms, detected, wallsOf, newId);
  return s.rooms;
}

export function addInteriorWall(b: Building, storeyId: ID, a: Vec2, c: Vec2, thickness = 0.12, newId: () => ID = uid): ID[] {
  const s = storeyOf(b, storeyId);
  if (!s) return [];
  const ids = addWall(s.graph, a, c, { thickness, openings: b.openings, storeyId, newId });
  updateRooms(b, storeyId, newId);
  return ids;
}

export function removeInteriorWall(b: Building, storeyId: ID, wallId: ID): void {
  const s = storeyOf(b, storeyId);
  if (!s) return;
  b.openings = removeWall(s.graph, wallId, b.openings);
  updateRooms(b, storeyId);
}

export function moveNode(b: Building, storeyId: ID, nodeId: ID, p: Vec2): void {
  const s = storeyOf(b, storeyId);
  const n = s?.graph.nodes.find((x) => x.id === nodeId);
  if (!s || !n) return;
  n.p = [p[0], p[1]];
  updateRooms(b, storeyId);
}

export function setWallThickness(b: Building, storeyId: ID, wallId: ID, t: number): void {
  const w = storeyOf(b, storeyId)?.graph.walls.find((x) => x.id === wallId);
  if (w) w.thickness = clamp(t, 0.05, 1);
}

export function addInteriorDoor(b: Building, storeyId: ID, wallId: ID, offset: number, width = 0.9, height = 2.1, newId: () => ID = uid): Opening | null {
  const s = storeyOf(b, storeyId);
  const w = s?.graph.walls.find((x) => x.id === wallId);
  if (!s || !w) return null;
  const e = wallEnds(s.graph, w)!;
  const len = Math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]);
  if (len < width + 0.1) width = Math.max(0.5, len - 0.1);
  const o: Opening = {
    id: newId(),
    host: { kind: 'wall', storeyId, wallId },
    storeyId,
    offset: clamp(offset, width / 2 + 0.05, len - width / 2 - 0.05),
    sill: 0,
    width,
    height: Math.min(height, s.height - s.slabThickness - 0.1),
    fill: { type: 'door' },
  };
  b.openings.push(o);
  return o;
}

/** Escada do pavimento até o seguinte, pelo caminho (coordenadas locais). */
export function addStair(b: Building, fromStorey: ID, path: Vec2[], width = 1.1, newId: () => ID = uid): Stair | null {
  const ordered = sortedStoreys(b);
  const i = ordered.findIndex((s) => s.id === fromStorey);
  if (i < 0 || i >= ordered.length - 1 || path.length < 2) return null;
  const st: Stair = { id: newId(), fromStorey, toStorey: ordered[i + 1]!.id, path: path.map((p) => [p[0], p[1]] as Vec2), width: clamp(width, 0.6, 3) };
  b.stairs.push(st);
  updateRooms(b, st.toStorey, newId);
  return st;
}

export function removeStair(b: Building, stairId: ID): void {
  const st = b.stairs.find((s) => s.id === stairId);
  b.stairs = b.stairs.filter((s) => s.id !== stairId);
  if (st) updateRooms(b, st.toStorey);
}

export function renameRoom(b: Building, storeyId: ID, roomId: ID, name: string): void {
  const r = storeyOf(b, storeyId)?.rooms.find((x) => x.id === roomId);
  if (r) r.name = name.slice(0, 40) || r.name;
}

/** Cômodo que contém o ponto (coordenadas locais). */
export function roomAt(b: Building, storeyId: ID, p: Vec2): Room | undefined {
  return storeyOf(b, storeyId)?.rooms.find((r) => r.polygon && pointInPolygon(p[0], p[1], r.polygon));
}

/** Altura de um pavimento; os de cima sobem ou descem junto. */
export function setStoreyHeight(b: Building, storeyId: ID, h: number): void {
  const ordered = sortedStoreys(b);
  const i = ordered.findIndex((s) => s.id === storeyId);
  if (i < 0) return;
  const s = ordered[i]!;
  const nh = r2(clamp(h, 2, 12));
  const d = nh - s.height;
  s.height = nh;
  for (let k = i + 1; k < ordered.length; k++) ordered[k]!.elevation = r2(ordered[k]!.elevation + d);
}

export function renameStorey(b: Building, storeyId: ID, name: string): void {
  const s = storeyOf(b, storeyId);
  if (s) s.name = name.slice(0, 40) || s.name;
}

// ── Transformações que precisam levar os interiores junto ─────────────
export function transformInteriors(b: Building, fn: (p: Vec2) => Vec2): void {
  for (const s of b.storeys) {
    transformGraph(s.graph, fn);
    for (const r of s.rooms) if (r.polygon) r.polygon = r.polygon.map(fn);
  }
  for (const st of b.stairs) st.path = st.path.map(fn);
}

/** Leva os interiores de um referencial (edifício de origem) para outro. */
export function reframeInteriors(b: Building, from: Frame, to: Frame): void {
  transformInteriors(b, (p) => toLocal(to, toWorld(from, p)));
}

/** Remove paredes e escadas que ficaram fora da base (depois de um recorte). */
export function clipInteriors(b: Building): void {
  const inside = (p: Vec2) => b.masses.some((m) => pointInPolygon(p[0], p[1], ringPoints(m.outer)) && !m.holes.some((h) => pointInPolygon(p[0], p[1], ringPoints(h))));
  for (const s of b.storeys) {
    for (const w of [...s.graph.walls]) {
      const e = wallEnds(s.graph, w);
      if (!e) continue;
      const mid: Vec2 = [(e[0][0] + e[1][0]) / 2, (e[0][1] + e[1][1]) / 2];
      if (!inside(mid)) b.openings = removeWall(s.graph, w.id, b.openings);
    }
    updateRooms(b, s.id);
  }
  b.stairs = b.stairs.filter((st) => st.path.every(inside));
}

/**
 * Agrupa edifícios num só (várias massas). Os pavimentos precisam ser
 * compatíveis: intervalos de altura iguais ou que não se sobrepõem.
 */
export function groupBuildings(bs: Building[], newId: () => ID = uid): Building {
  if (bs.length < 2) throw new Error('Selecione pelo menos dois volumes para agrupar.');
  const base = structuredClone(bs[0]!);
  const frame: Frame = { position: base.position, rotation: base.rotation };
  const intervals: Storey[] = [...base.storeys];
  const key = (s: Storey) => `${r2(s.elevation)}|${r2(s.height)}`;
  const byKey = new Map(intervals.map((s) => [key(s), s]));
  for (const other of bs.slice(1)) {
    const o = structuredClone(other);
    const map = new Map<ID, ID>();
    for (const s of o.storeys) {
      const k = key(s);
      const same = byKey.get(k);
      if (same) {
        map.set(s.id, same.id);
        // Junta as paredes internas no pavimento existente.
        const g = structuredClone(s.graph);
        transformGraph(g, (p) => toLocal(frame, toWorld(o, p)));
        same.graph.nodes.push(...g.nodes);
        same.graph.walls.push(...g.walls);
        continue;
      }
      const lo = s.elevation,
        hi = s.elevation + s.height;
      if (intervals.some((x) => lo < x.elevation + x.height - 1e-6 && hi > x.elevation + 1e-6))
        throw new Error('Os pavimentos dos volumes não coincidem; ajuste as alturas para agrupar.');
      const ns: Storey = { ...structuredClone(s), id: newId() };
      transformGraph(ns.graph, (p) => toLocal(frame, toWorld(o, p)));
      ns.rooms = [];
      intervals.push(ns);
      byKey.set(k, ns);
      map.set(s.id, ns.id);
    }
    for (const m of o.masses) {
      for (const r of [m.outer, ...m.holes]) for (const v of r.vertices) v.p = toLocal(frame, toWorld(o, v.p));
      m.fromStorey = map.get(m.fromStorey)!;
      m.toStorey = map.get(m.toStorey)!;
      base.masses.push(m);
    }
    for (const op of o.openings) {
      op.storeyId = map.get(op.storeyId) ?? op.storeyId;
      if (op.host.kind === 'wall') op.host = { ...op.host, storeyId: map.get(op.host.storeyId) ?? op.host.storeyId };
      base.openings.push(op);
    }
    for (const st of o.stairs) {
      st.fromStorey = map.get(st.fromStorey)!;
      st.toStorey = map.get(st.toStorey)!;
      st.path = st.path.map((p) => toLocal(frame, toWorld(o, p)));
      base.stairs.push(st);
    }
  }
  base.storeys = intervals.sort((a, b) => a.elevation - b.elevation);
  base.storeys.forEach((s, i) => {
    if (/^(Térreo|\d+º pavimento)$/.test(s.name)) s.name = storeyName(i);
  });
  for (const s of base.storeys) updateRooms(base, s.id, newId);
  return base;
}
