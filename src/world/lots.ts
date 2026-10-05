import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { Level, halfWidth } from './roadTypes';
import { m } from './units';
import { pavedTester, quadsOverlap } from './zoneGrid';
import type { ZoneDensity, ZoneUse } from './zones';

/**
 * Lots: the land cut into plots the player zones and buildings grow on, as a
 * town's cadastre is.
 *
 * - A closed block (land with streets all round) is cut into equal lots: its
 *   oriented rectangle in one or two rows - each row facing its own street -
 *   and in equal columns, each lot as near square as the block allows (a
 *   block 80 x 60 m is six lots of about 27 x 30 m). This is the "recursive"
 *   subdivision of CityEngine with no irregularity (equal parts) and street
 *   access forced (two rows at most).
 * - Along a street with open land beside it, a continuous strip as deep as a
 *   lot, from the back of the footway, cut into equal lots too: CityEngine's
 *   offset subdivision.
 *
 * Lots are STORED in the document (`RoadDoc.lots`): the player moves their
 * corners, splits, joins, deletes and adds them. Land is subdivided only once:
 * each block or strip leaves a key (`RoadDoc.lotKeys`) so a lot deleted on
 * purpose is not made again; a road moved or added makes new land (a new key),
 * and lots the paving now covers are removed.
 */

export interface Lot {
  readonly id: number;
  /** Front-start, front-end, back-end, back-start: the front faces the street. */
  readonly corners: readonly [Vec2, Vec2, Vec2, Vec2];
  readonly use?: ZoneUse;
  readonly density?: ZoneDensity;
  /** The building that grew on it, while it stands. */
  readonly building?: number;
}

/** Depth of a lot along an open street, and the lot side aimed at in a block. */
export const LOT_DEPTH = m(30);
/** A block deeper than this is cut in two rows, back to back. */
const TWO_ROWS = m(36);
const MIN_LOT = m(8);
const RASTER = m(2);

export const lotCentre = (l: Pick<Lot, 'corners'>): Vec2 => ({
  x: (l.corners[0].x + l.corners[1].x + l.corners[2].x + l.corners[3].x) / 4,
  y: (l.corners[0].y + l.corners[1].y + l.corners[2].y + l.corners[3].y) / 4,
});

export function insideLot(p: Vec2, l: Pick<Lot, 'corners'>): boolean {
  let inside = false;
  const q = l.corners;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i]!, b = q[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The lot's frame for a building: front middle, facing angle (along the front), width and depth. */
export function lotFrame(l: Pick<Lot, 'corners'>): { anchor: Vec2; rotation: number; width: number; depth: number } {
  const [a, b, c, d] = l.corners;
  const width = Math.hypot(b.x - a.x, b.y - a.y);
  const depth = Math.min(Math.hypot(d.x - a.x, d.y - a.y), Math.hypot(c.x - b.x, c.y - b.y));
  return { anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rotation: Math.atan2(b.y - a.y, b.x - a.x), width, depth };
}

interface Candidate { key: string; corners: [Vec2, Vec2, Vec2, Vec2] }

/**
 * The corners in the order a building reads its lot: front-start to front-end
 * with the back on the LEFT of that direction (as the street grid's cells
 * have it, `ZoneCell.rotation`) - so a building made for the lot faces the
 * street. Given the other way round, the building stood back to front, its
 * yard over the footway, and was refused.
 */
export function facingCorners(c: readonly [Vec2, Vec2, Vec2, Vec2]): [Vec2, Vec2, Vec2, Vec2] {
  const [a, b, cc, d] = c;
  const cross = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  return cross >= 0 ? [a, b, cc, d] : [b, a, d, cc];
}

/**
 * New lots for land with none yet, and the lots the paving now covers. Pure:
 * the caller stores the result (`applyLots`).
 */
export function planLots(doc: RoadDoc, net: Network): { add: Candidate[]; keys: string[]; drop: number[] } {
  const { onRoad, onPlate } = pavedTester(doc, net);
  const paved = (p: Vec2): boolean => onRoad(p) || onPlate(p);
  const ribbons = [...net.ribbons.values()].filter((r) => doc.segment(r.id)?.structure === 'ground' && carriesPedestrians(r.road));
  const drop = doc.lots.filter((l) => paved(lotCentre(l)) ||
    l.corners.some((q) => paved({ x: q.x + (lotCentre(l).x - q.x) * 0.15, y: q.y + (lotCentre(l).y - q.y) * 0.15 }))).map((l) => l.id);
  if (!ribbons.length) return { add: [], keys: [], drop };
  const known = new Set(doc.lotKeys);
  const kept = doc.lots.filter((l) => !drop.includes(l.id));
  const add: Candidate[] = [];
  const keys: string[] = [];
  const free = (corners: readonly Vec2[]): boolean =>
    !kept.some((l) => quadsOverlap(corners, l.corners, m(0.5))) && !add.some((c) => quadsOverlap(corners, c.corners, m(0.5)));

  // The land as a raster over the streets' reach: paved or not, then labelled
  // into connected pieces; those that do not reach the raster's edge are
  // closed blocks.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of ribbons) {
    const bb = r.full.bbox;
    minX = Math.min(minX, bb.minX); minY = Math.min(minY, bb.minY); maxX = Math.max(maxX, bb.maxX); maxY = Math.max(maxY, bb.maxY);
  }
  const pad = LOT_DEPTH + m(20);
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const W = Math.ceil((maxX - minX) / RASTER), H = Math.ceil((maxY - minY) / RASTER);
  const label = new Int32Array(W * H).fill(-1);
  const isPaved = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (paved({ x: minX + (i + 0.5) * RASTER, y: minY + (j + 0.5) * RASTER })) isPaved[j * W + i] = 1;
  }
  const pieces: { cells: number[]; open: boolean }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (isPaved[start] || label[start]! >= 0) continue;
    const id = pieces.length;
    const piece = { cells: [] as number[], open: false };
    pieces.push(piece);
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      piece.cells.push(c);
      const i = c % W, j = (c - i) / W;
      if (i === 0 || j === 0 || i === W - 1 || j === H - 1) piece.open = true;
      for (const n of [i > 0 ? c - 1 : -1, i < W - 1 ? c + 1 : -1, j > 0 ? c - W : -1, j < H - 1 ? c + W : -1]) {
        if (n < 0 || isPaved[n] || label[n]! >= 0) continue;
        label[n] = id;
        stack.push(n);
      }
    }
  }
  const pieceAt = (p: Vec2): number => {
    const i = Math.floor((p.x - minX) / RASTER), j = Math.floor((p.y - minY) / RASTER);
    return i < 0 || j < 0 || i >= W || j >= H ? -2 : label[j * W + i]!;
  };

  // --- closed blocks
  for (const [id, piece] of pieces.entries()) {
    if (piece.open || piece.cells.length * RASTER * RASTER < MIN_LOT * MIN_LOT * 2) continue;
    const pts = piece.cells.map((c) => ({ x: minX + ((c % W) + 0.5) * RASTER, y: minY + (Math.floor(c / W) + 0.5) * RASTER }));
    const box = orientedBox(hull(pts));
    const key = `b:${Math.round(box.c.x / m(4))},${Math.round(box.c.y / m(4))},${Math.round(box.L / m(4))},${Math.round(box.D / m(4))}`;
    keys.push(key);
    if (known.has(key)) continue;
    // Grow the raster box by half a raster cell: its points are cell centres.
    const L = box.L + RASTER, D = box.D + RASTER;
    const rows = D >= TWO_ROWS ? 2 : 1;
    const depth = D / rows;
    const columns = Math.max(1, Math.round(L / Math.max(MIN_LOT, depth)));
    const width = L / columns;
    const at = (s: number, t: number): Vec2 => ({ x: box.c.x + box.u.x * s + box.v.x * t, y: box.c.y + box.u.y * s + box.v.y * t });
    for (let r = 0; r < rows; r++) for (let k = 0; k < columns; k++) {
      const s0 = -L / 2 + k * width, s1 = s0 + width;
      const t0 = -D / 2 + r * depth, t1 = t0 + depth;
      // The front faces the street: the row's outer long edge (one row: the
      // side nearer a street).
      const towardMinus = rows === 2 ? r === 0 : nearerStreet(at, s0, s1, -D / 2, D / 2, paved);
      const corners: [Vec2, Vec2, Vec2, Vec2] = towardMinus
        ? [at(s1, t0), at(s0, t0), at(s0, t1), at(s1, t1)]
        : [at(s0, t1), at(s1, t1), at(s1, t0), at(s0, t0)];
      // Most of it on this block's land (a block that is no rectangle loses
      // the lots that would hang over its streets).
      let inside = 0, total = 0;
      for (let a = 0.1; a < 1; a += 0.2) for (let b = 0.1; b < 1; b += 0.2) {
        total++;
        if (pieceAt(at(s0 + (s1 - s0) * a, t0 + (t1 - t0) * b)) === id) inside++;
      }
      if (inside / total >= 0.7 && free(corners)) add.push({ key, corners: facingCorners(corners) });
    }
  }

  // --- open land along streets: a continuous strip each side, cut in equal lots
  const ids = [...doc.segments.keys()].sort((a, b) => a - b);
  for (const segId of ids) {
    const ribbon = net.ribbons.get(segId);
    if (!ribbon || !ribbons.includes(ribbon)) continue;
    const line = ribbon.full;
    const face = halfWidth(ribbon.road, Level.Sidewalk) + m(0.3);
    const length = line.length;
    for (const side of [1, -1] as const) {
      const point = (s: number, d: number): Vec2 => {
        const f = line.sampleAt(Math.max(0, Math.min(length, s)));
        return { x: f.p.x - f.t.y * side * d, y: f.p.y + f.t.x * side * d };
      };
      // Runs of street where the land just behind the footway is open land.
      const step = m(1);
      const runs: [number, number][] = [];
      let from = -1;
      for (let s = 0; s <= length; s += step) {
        const p = point(s, face + m(1.5)), q = point(s, face + LOT_DEPTH - m(1));
        const ok = !paved(p) && !paved(q) && pieces[pieceAt(p)]?.open === true;
        if (ok && from < 0) from = s;
        if ((!ok || s + step > length) && from >= 0) { runs.push([from, ok ? s : s - step]); from = -1; }
      }
      for (const [s0, s1] of runs) {
        const len = s1 - s0;
        if (len < MIN_LOT) continue;
        const mid = point((s0 + s1) / 2, face);
        const key = `s:${Math.round(mid.x / m(4))},${Math.round(mid.y / m(4))},${Math.round(len / m(4))}`;
        keys.push(key);
        if (known.has(key)) continue;
        const n = Math.max(1, Math.round(len / LOT_DEPTH));
        const w = len / n;
        for (let k = 0; k < n; k++) {
          const a = s0 + k * w, b = a + w;
          // Facing the street: front-start, front-end along the street's
          // direction on its left, against it on its right.
          const corners: [Vec2, Vec2, Vec2, Vec2] = side === 1
            ? [point(a, face), point(b, face), point(b, face + LOT_DEPTH), point(a, face + LOT_DEPTH)]
            : [point(b, face), point(a, face), point(a, face + LOT_DEPTH), point(b, face + LOT_DEPTH)];
          const c = lotCentre({ corners });
          if (paved(c) || corners.some((q) => paved({ x: q.x + (c.x - q.x) * 0.1, y: q.y + (c.y - q.y) * 0.1 }))) continue;
          if (free(corners)) add.push({ key, corners: facingCorners(corners) });
        }
      }
    }
  }
  return { add, keys, drop };
}

/** Stores a plan: the covered lots removed, the new ones added, the land's keys kept. */
export function applyLots(doc: RoadDoc, plan: ReturnType<typeof planLots>): boolean {
  if (!plan.add.length && !plan.drop.length && plan.keys.every((k) => doc.lotKeys.includes(k))) return false;
  const dropped = new Set(plan.drop);
  const kept = doc.lots.filter((l) => !dropped.has(l.id));
  doc.lots.splice(0, doc.lots.length, ...kept);
  for (const c of plan.add) doc.lots.push({ id: doc.nextLotId++, corners: c.corners });
  for (const k of plan.keys) if (!doc.lotKeys.includes(k)) doc.lotKeys.push(k);
  doc.lotRevision++;
  return true;
}

// ------------------------------------------------------------------ editing

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Splits a lot in `parts` equal lots along its front (or, `deep`, front and back). */
export function splitLot(doc: RoadDoc, id: number, parts = 2, deep = false): boolean {
  const at = doc.lots.findIndex((l) => l.id === id);
  if (at < 0 || parts < 2) return false;
  const [a, b, c, d] = doc.lots[at]!.corners;
  const made: Lot[] = [];
  for (let k = 0; k < parts; k++) {
    const t0 = k / parts, t1 = (k + 1) / parts;
    made.push({ id: doc.nextLotId++, corners: deep
      ? [lerp(a, d, t0), lerp(b, c, t0), lerp(b, c, t1), lerp(a, d, t1)]
      : [lerp(a, b, t0), lerp(a, b, t1), lerp(d, c, t1), lerp(d, c, t0)] });
  }
  doc.lots.splice(at, 1, ...made);
  doc.lotRevision++;
  return true;
}

/** Joins two lots side by side (sharing a boundary) into one; false when they do not touch. */
export function joinLots(doc: RoadDoc, idA: number, idB: number): boolean {
  const ia = doc.lots.findIndex((l) => l.id === idA), ib = doc.lots.findIndex((l) => l.id === idB);
  if (ia < 0 || ib < 0 || ia === ib) return false;
  const A = doc.lots[ia]!, B = doc.lots[ib]!;
  const near = (p: Vec2, q: Vec2): boolean => Math.hypot(p.x - q.x, p.y - q.y) < m(1.5);
  let corners: [Vec2, Vec2, Vec2, Vec2] | null = null;
  // B to the right of A (A's front-end = B's front-start), or to its left.
  if (near(A.corners[1], B.corners[0]) && near(A.corners[2], B.corners[3])) corners = [A.corners[0], B.corners[1], B.corners[2], A.corners[3]];
  else if (near(B.corners[1], A.corners[0]) && near(B.corners[2], A.corners[3])) corners = [B.corners[0], A.corners[1], A.corners[2], B.corners[3]];
  // B behind A.
  else if (near(A.corners[3], B.corners[0]) && near(A.corners[2], B.corners[1])) corners = [A.corners[0], A.corners[1], B.corners[2], B.corners[3]];
  else if (near(B.corners[3], A.corners[0]) && near(B.corners[2], A.corners[1])) corners = [B.corners[0], B.corners[1], A.corners[2], A.corners[3]];
  if (!corners) return false;
  const joined: Lot = { id: doc.nextLotId++, corners, ...(A.use ? { use: A.use, density: A.density ?? 'low' } : {}) };
  doc.lots.splice(Math.max(ia, ib), 1);
  doc.lots.splice(Math.min(ia, ib), 1, joined);
  doc.lotRevision++;
  return true;
}

export function deleteLot(doc: RoadDoc, id: number): boolean {
  const at = doc.lots.findIndex((l) => l.id === id);
  if (at < 0) return false;
  doc.lots.splice(at, 1);
  doc.lotRevision++;
  return true;
}

/** A new lot: a rectangle from `a` to `b` aligned with `angle` (the nearest street's direction). */
export function addLot(doc: RoadDoc, a: Vec2, b: Vec2, angle: number): Lot | null {
  const u = { x: Math.cos(angle), y: Math.sin(angle) }, v = { x: -u.y, y: u.x };
  const ds = (b.x - a.x) * u.x + (b.y - a.y) * u.y, dt = (b.x - a.x) * v.x + (b.y - a.y) * v.y;
  if (Math.abs(ds) < MIN_LOT / 2 || Math.abs(dt) < MIN_LOT / 2) return null;
  const p = (s: number, t: number): Vec2 => ({ x: a.x + u.x * s + v.x * t, y: a.y + u.y * s + v.y * t });
  const s0 = Math.min(0, ds), s1 = Math.max(0, ds), t0 = Math.min(0, dt), t1 = Math.max(0, dt);
  // The front is the side nearer the street the angle came from: t0 (the
  // nearer edge to where the drag began) - and the back on its left.
  const corners = facingCorners([p(s0, t0), p(s1, t0), p(s1, t1), p(s0, t1)]);
  if (doc.lots.some((l) => quadsOverlap(corners, l.corners, m(0.5)))) return null;
  const lot: Lot = { id: doc.nextLotId++, corners };
  doc.lots.push(lot);
  doc.lotRevision++;
  return lot;
}

/**
 * Moves a lot corner to `to`, and every other lot's corner standing on the
 * same point with it, so neighbours keep sharing their boundary.
 */
export function moveLotCorner(doc: RoadDoc, from: Vec2, to: Vec2): boolean {
  let moved = false;
  for (let i = 0; i < doc.lots.length; i++) {
    const l = doc.lots[i]!;
    let changed = false;
    const corners = l.corners.map((q) => {
      if (Math.hypot(q.x - from.x, q.y - from.y) < m(0.8)) { changed = true; return { x: to.x, y: to.y }; }
      return q;
    }) as unknown as Lot['corners'];
    if (changed) { doc.lots[i] = { ...l, corners }; moved = true; }
  }
  if (moved) doc.lotRevision++;
  return moved;
}

/** Zones lots (or clears them, `zone` null). */
export function zoneLots(doc: RoadDoc, ids: readonly number[], zone: { use: ZoneUse; density: ZoneDensity } | null): boolean {
  let changed = false;
  for (let i = 0; i < doc.lots.length; i++) {
    const l = doc.lots[i]!;
    if (!ids.includes(l.id)) continue;
    if (zone ? l.use === zone.use && l.density === zone.density : !l.use) continue;
    const { use: _u, density: _d, ...rest } = l;
    doc.lots[i] = zone ? { ...rest, use: zone.use, density: zone.density } : rest;
    changed = true;
  }
  if (changed) doc.lotRevision++;
  return changed;
}

export function isLot(raw: unknown): raw is Lot {
  const v = raw as Partial<Lot> | null;
  return !!v && Number.isInteger(v.id) && Array.isArray(v.corners) && v.corners.length === 4 &&
    v.corners.every((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y));
}

// ------------------------------------------------------------------ geometry

function hull(points: readonly Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [], upper: Vec2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The smallest-area rectangle round a convex hull (rotating its edges): centre, long axis u, short axis v, lengths. */
function orientedBox(h: readonly Vec2[]): { c: Vec2; u: Vec2; v: Vec2; L: number; D: number } {
  let best = { area: Infinity, c: { x: 0, y: 0 }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, L: 0, D: 0 };
  for (let i = 0; i < h.length; i++) {
    const a = h[i]!, b = h[(i + 1) % h.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, v = { x: -u.y, y: u.x };
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const q of h) {
      const s = q.x * u.x + q.y * u.y, t = q.x * v.x + q.y * v.y;
      s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    const area = (s1 - s0) * (t1 - t0);
    if (area < best.area) {
      const sc = (s0 + s1) / 2, tc = (t0 + t1) / 2;
      best = { area, c: { x: u.x * sc + v.x * tc, y: u.y * sc + v.y * tc }, u, v, L: s1 - s0, D: t1 - t0 };
    }
  }
  if (best.D > best.L) best = { ...best, u: best.v, v: { x: -best.v.y, y: best.v.x }, L: best.D, D: best.L };
  return best;
}

/** For a one-row block: whether the street is nearer its -v side than its +v side, at this column. */
function nearerStreet(at: (s: number, t: number) => Vec2, s0: number, s1: number, tMinus: number, tPlus: number,
  paved: (p: Vec2) => boolean): boolean {
  const s = (s0 + s1) / 2;
  for (let d = 0; d < m(12); d += m(1)) {
    const minus = paved(at(s, tMinus - d)), plus = paved(at(s, tPlus + d));
    if (minus !== plus) return minus;
  }
  return true;
}
