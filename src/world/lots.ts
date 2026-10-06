import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { Level, halfWidth } from './roadTypes';
import { levelPolygons } from './surfaces';
import { type MultiPoly, difference } from '@core/clipper';
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
  /**
   * The boundary, counter-clockwise (the inside on the left of each side):
   * any polygon - four corners as generated, more where the player drew one,
   * many along a curved side. The first side (corners 0 -> 1) is the front,
   * on the street.
   */
  readonly corners: readonly Vec2[];
  readonly use?: ZoneUse;
  readonly density?: ZoneDensity;
  /** The building that grew on it, while it stands. */
  readonly building?: number;
}

/** Depth of a lot along an open street. */
export const LOT_DEPTH = m(32);
/**
 * The frontage a lot aims at: a block's rows and a street's strip are cut
 * into equal lots of about this width (the player, 2026-10-05: square lots of
 * 26-30 m were too big; 2026-10-06: 15 m too small).
 */
export const LOT_FRONTAGE = m(22);
/** A block deeper than this is cut in two rows, back to back. */
const TWO_ROWS = m(44);
const MIN_LOT = m(10);
const RASTER = m(2);

/** The boundary's area centroid (the corners' mean for a degenerate one). */
export function lotCentre(l: Pick<Lot, 'corners'>): Vec2 {
  const q = l.corners;
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!, r = q[(i + 1) % q.length]!;
    const c = p.x * r.y - r.x * p.y;
    a += c; x += (p.x + r.x) * c; y += (p.y + r.y) * c;
  }
  if (Math.abs(a) < 1e-9) return { x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length };
  return { x: x / (3 * a), y: y / (3 * a) };
}

export function lotArea(l: Pick<Lot, 'corners'>): number {
  let a = 0;
  const q = l.corners;
  for (let i = 0; i < q.length; i++) { const p = q[i]!, r = q[(i + 1) % q.length]!; a += p.x * r.y - r.x * p.y; }
  return a / 2;
}

export function insideLot(p: Vec2, l: Pick<Lot, 'corners'>): boolean {
  let inside = false;
  const q = l.corners;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i]!, b = q[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The lot's frame for a building: front middle, facing angle (along the front), width and depth. */
export function lotFrame(l: Pick<Lot, 'corners'>): { anchor: Vec2; rotation: number; width: number; depth: number } {
  const a = l.corners[0]!, b = l.corners[1]!;
  const width = Math.hypot(b.x - a.x, b.y - a.y);
  const u = { x: (b.x - a.x) / (width || 1), y: (b.y - a.y) / (width || 1) }, n = { x: -u.y, y: u.x };
  // Depth: how far the lot goes back from its front, at the quarter points
  // of the front and its middle - the least of them, so a building made for
  // it fits a lot narrowing at the back.
  let depth = Infinity;
  for (const t of [0.25, 0.5, 0.75]) {
    const o = { x: a.x + (b.x - a.x) * t + n.x * 1e-3, y: a.y + (b.y - a.y) * t + n.y * 1e-3 };
    depth = Math.min(depth, rayExit(l.corners, o, n));
  }
  return { anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rotation: Math.atan2(u.y, u.x), width, depth: Number.isFinite(depth) ? depth : 0 };
}

/** How far a ray from inside a polygon runs before it leaves it. */
function rayExit(q: readonly Vec2[], o: Vec2, d: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!, r = q[(i + 1) % q.length]!;
    const ex = r.x - p.x, ey = r.y - p.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p.x - o.x) * ey - (p.y - o.y) * ex) / den;
    const s = ((p.x - o.x) * d.y - (p.y - o.y) * d.x) / den;
    if (t > 1e-6 && s >= 0 && s <= 1) best = Math.min(best, t);
  }
  return best;
}

interface Candidate { key: string; corners: Vec2[] }

/**
 * The corners in the order a building reads its lot: front-start to front-end
 * with the back on the LEFT of that direction (as the street grid's cells
 * have it, `ZoneCell.rotation`) - so a building made for the lot faces the
 * street. Given the other way round, the building stood back to front, its
 * yard over the footway, and was refused.
 */
export function facingCorners<T extends readonly Vec2[]>(c: T): Vec2[] {
  // Counter-clockwise keeps the inside on the left of every side; reversed,
  // the front side keeps its two corners, swapped.
  if (lotArea({ corners: c }) >= 0) return [...c];
  return [c[1]!, c[0]!, ...[...c.slice(2)].reverse()];
}

/**
 * New lots for land with none yet, and the lots the paving now covers. Pure:
 * the caller stores the result (`applyLots`).
 */
export interface LotPlan { add: Candidate[]; keys: string[]; drop: number[] }

export function planLots(doc: RoadDoc, net: Network): LotPlan {
  const steps = planLotsSteps(doc, net);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * `planLots` a little at a time: it yields between rows of the raster, blocks
 * and streets, and returns the plan. Replanning a town's lots in one go was a
 * quarter-second frame after every road edit; the game runs this a few
 * milliseconds a frame (`main.ts`, as `zoneGridSteps`) and applies the plan
 * only if nothing it read has changed meanwhile.
 */
export function* planLotsSteps(doc: RoadDoc, net: Network): Generator<void, LotPlan> {
  const { onRoad, onPlate } = pavedTester(doc, net);
  yield;
  const paved = (p: Vec2): boolean => onRoad(p) || onPlate(p);
  const ribbons = [...net.ribbons.values()].filter((r) => doc.segment(r.id)?.structure === 'ground' && carriesPedestrians(r.road));
  const drop: number[] = [];
  for (const [i, l] of doc.lots.entries()) {
    if (paved(lotCentre(l)) ||
      l.corners.some((q) => paved({ x: q.x + (lotCentre(l).x - q.x) * 0.15, y: q.y + (lotCentre(l).y - q.y) * 0.15 }))) drop.push(l.id);
    if (i % 64 === 63) yield;
  }
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
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (paved({ x: minX + (i + 0.5) * RASTER, y: minY + (j + 0.5) * RASTER })) isPaved[j * W + i] = 1;
    }
    yield;
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
    yield;
    const pts = piece.cells.map((c) => ({ x: minX + ((c % W) + 0.5) * RASTER, y: minY + (Math.floor(c / W) + 0.5) * RASTER }));
    const box = orientedBox(hull(pts));
    const key = `b:${Math.round(box.c.x / m(4))},${Math.round(box.c.y / m(4))},${Math.round(box.L / m(4))},${Math.round(box.D / m(4))}`;
    keys.push(key);
    if (known.has(key)) continue;
    // Grow the raster box by half a raster cell: its points are cell centres.
    const L = box.L + RASTER, D = box.D + RASTER;
    const rows = D >= TWO_ROWS ? 2 : 1;
    const depth = D / rows;
    const columns = Math.max(1, Math.round(L / Math.max(MIN_LOT, Math.min(depth, LOT_FRONTAGE))));
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
    yield;
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
        const n = Math.max(1, Math.round(len / LOT_FRONTAGE));
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
  // Onto the footways' back edges and the blocks' corners: no gap between a
  // lot and its street.
  snapLotsToStreets(doc, net, add.map((c) => c.corners));
  return { add, keys, drop };
}

/** Stores a plan: the covered lots removed, the new ones added, the land's keys kept. */
export function applyLots(doc: RoadDoc, plan: LotPlan): boolean {
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
const near = (p: Vec2, q: Vec2, d = m(1.2)): boolean => Math.hypot(p.x - q.x, p.y - q.y) < d;

/** The part of a polygon on the left of the line a -> b (Sutherland-Hodgman against one half-plane). */
function clipLeft(q: readonly Vec2[], a: Vec2, b: Vec2): Vec2[] {
  const side = (p: Vec2): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const out: Vec2[] = [];
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!, r = q[(i + 1) % q.length]!;
    const sp = side(p), sr = side(r);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sr >= 0)) { const t = sp / (sp - sr); out.push(lerp(p, r, t)); }
  }
  // Points the cut put on top of each other merged.
  return out.filter((p, i) => !near(p, out[(i + 1) % out.length]!, 1e-6));
}

/**
 * A piece of a cut lot with its front set: the side lying along the old
 * front, or else the side nearest it - a back piece of a lot cut parallel to
 * its street then faces the same way.
 */
function withFront(piece: readonly Vec2[], front: readonly [Vec2, Vec2]): Vec2[] {
  const [fa, fb] = front;
  const len = Math.hypot(fb.x - fa.x, fb.y - fa.y) || 1;
  const off = (p: Vec2): number => Math.abs((fb.x - fa.x) * (p.y - fa.y) - (fb.y - fa.y) * (p.x - fa.x)) / len;
  let best = 0, bestScore = Infinity;
  for (let i = 0; i < piece.length; i++) {
    const p = piece[i]!, r = piece[(i + 1) % piece.length]!;
    const l = Math.hypot(r.x - p.x, r.y - p.y);
    if (l < m(1)) continue;
    // Along the front direction (parallel) and near the front line.
    const parallel = Math.abs(((r.x - p.x) * (fb.x - fa.x) + (r.y - p.y) * (fb.y - fa.y)) / (l * len));
    const score = off(lerp(p, r, 0.5)) + (1 - parallel) * m(40);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return [...piece.slice(best), ...piece.slice(0, best)];
}

export type LotCut =
  /** Across the front, into `parts` lots side by side, each on the street. */
  | { readonly kind: 'vertical'; readonly parts: number }
  /** Parallel to the front, into `parts` lots one behind the other. */
  | { readonly kind: 'horizontal'; readonly parts: number }
  /** Along a line the player drew, from `a` to `b`, into two. */
  | { readonly kind: 'line'; readonly a: Vec2; readonly b: Vec2 };

/** The cut lines of a cut on a lot, each as two points: the preview the tool draws. */
export function cutLines(l: Pick<Lot, 'corners'>, cut: LotCut): [Vec2, Vec2][] {
  if (cut.kind === 'line') return [[cut.a, cut.b]];
  const a = l.corners[0]!, b = l.corners[1]!;
  const w = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const u = { x: (b.x - a.x) / w, y: (b.y - a.y) / w }, n = { x: -u.y, y: u.x };
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const q of l.corners) {
    const s = (q.x - a.x) * u.x + (q.y - a.y) * u.y, t = (q.x - a.x) * n.x + (q.y - a.y) * n.y;
    s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
  }
  const P = (s: number, t: number): Vec2 => ({ x: a.x + u.x * s + n.x * t, y: a.y + u.y * s + n.y * t });
  const lines: [Vec2, Vec2][] = [];
  for (let k = 1; k < cut.parts; k++) {
    if (cut.kind === 'vertical') {
      // Equal widths along the front itself (the front may be shorter than the lot).
      const s = k / cut.parts * w;
      lines.push([P(s, t1 + m(1)), P(s, t0 - m(1))]);
    } else {
      const t = t0 + (t1 - t0) * k / cut.parts;
      lines.push([P(s0 - m(1), t), P(s1 + m(1), t)]);
    }
  }
  return lines;
}

/** Cuts a lot by `cut`; false when nothing worth a lot is left on both sides. */
export function splitLot(doc: RoadDoc, id: number, cut: LotCut): boolean {
  const at = doc.lots.findIndex((l) => l.id === id);
  if (at < 0) return false;
  const lot = doc.lots[at]!;
  const front: [Vec2, Vec2] = [lot.corners[0]!, lot.corners[1]!];
  let pieces: Vec2[][] = [[...lot.corners]];
  for (const [a, b] of cutLines(lot, cut)) {
    const next: Vec2[][] = [];
    for (const piece of pieces) {
      const left = clipLeft(piece, a, b), right = clipLeft(piece, b, a);
      for (const half of [left, right]) if (half.length >= 3 && Math.abs(lotArea({ corners: half })) > MIN_LOT * MIN_LOT / 4) next.push(half);
    }
    pieces = next;
  }
  if (pieces.length < 2) return false;
  const made = pieces.map((piece) => ({ id: doc.nextLotId++, corners: facingCorners(withFront(piece, front)), ...(lot.use ? { use: lot.use, density: lot.density ?? 'low' as const } : {}) }));
  doc.lots.splice(at, 1, ...made);
  doc.lotRevision++;
  return true;
}

/**
 * Joins two lots that share a side into one: the two boundaries walked
 * round, the shared stretch left out. False when they share no side.
 */
export function joinLots(doc: RoadDoc, idA: number, idB: number): boolean {
  const ia = doc.lots.findIndex((l) => l.id === idA), ib = doc.lots.findIndex((l) => l.id === idB);
  if (ia < 0 || ib < 0 || ia === ib) return false;
  const A = doc.lots[ia]!.corners, B = doc.lots[ib]!.corners;
  const onB = A.map((p) => B.findIndex((q) => near(p, q)));
  // A side of A whose two corners are both corners of B.
  let start = -1;
  for (let i = 0; i < A.length; i++) if (onB[i]! >= 0 && onB[(i + 1) % A.length]! >= 0) { start = i; break; }
  if (start < 0) return false;
  // Walk A from just after the shared run, round to its start; then B the same way.
  let i0 = start;
  while (onB[(i0 - 1 + A.length) % A.length]! >= 0 && (i0 - 1 + A.length) % A.length !== start) i0 = (i0 - 1 + A.length) % A.length;
  let i1 = (start + 1) % A.length;
  while (onB[(i1 + 1) % A.length]! >= 0 && (i1 + 1) % A.length !== i0) i1 = (i1 + 1) % A.length;
  const ring: Vec2[] = [];
  for (let k = i1; ; k = (k + 1) % A.length) { ring.push(A[k]!); if (k === i0) break; }
  const j0 = onB[i0]!, j1 = onB[i1]!;
  for (let k = (j0 + 1) % B.length; k !== j1; k = (k + 1) % B.length) ring.push(B[k]!);
  if (ring.length < 3) return false;
  const lotA = doc.lots[ia]!;
  // The front stays the first lot's: the ring started at the end of the
  // shared run; the front side is found again by its corners.
  const fa = lotA.corners[0]!, fb = lotA.corners[1]!;
  let f = ring.findIndex((p, k) => near(p, fa) && near(ring[(k + 1) % ring.length]!, fb));
  if (f < 0) f = ring.findIndex((p) => near(p, fa));
  const ordered = f > 0 ? [...ring.slice(f), ...ring.slice(0, f)] : ring;
  const joined: Lot = { id: doc.nextLotId++, corners: facingCorners(ordered), ...(lotA.use ? { use: lotA.use, density: lotA.density ?? 'low' } : {}) };
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
  const rect = lotRect(a, b, angle);
  return rect ? addPolygonLot(doc, rect, 0) : null;
}

/** The rectangle from `a` to `b` square to `angle` (a street's direction), counter-clockwise; null when too small. */
export function lotRect(a: Vec2, b: Vec2, angle: number): Vec2[] | null {
  const u = { x: Math.cos(angle), y: Math.sin(angle) }, v = { x: -u.y, y: u.x };
  const ds = (b.x - a.x) * u.x + (b.y - a.y) * u.y, dt = (b.x - a.x) * v.x + (b.y - a.y) * v.y;
  if (Math.abs(ds) < MIN_LOT / 2 || Math.abs(dt) < MIN_LOT / 2) return null;
  const p = (s: number, t: number): Vec2 => ({ x: a.x + u.x * s + v.x * t, y: a.y + u.y * s + v.y * t });
  const s0 = Math.min(0, ds), s1 = Math.max(0, ds), t0 = Math.min(0, dt), t1 = Math.max(0, dt);
  return [p(s0, t0), p(s1, t0), p(s1, t1), p(s0, t1)];
}

/** The paving as drawn (footways and all within them), each piece with its box, by network (`onLand`). */
const PAVING = new WeakMap<Network, { revision: number; pieces: { poly: MultiPoly[number]; box: [number, number, number, number] }[] }>();
function pavingOf(net: Network): { poly: MultiPoly[number]; box: [number, number, number, number] }[] {
  const known = PAVING.get(net);
  if (known && known.revision === net.revision) return known.pieces;
  const pieces = (net.doc.segments.size ? levelPolygons(net, Level.Sidewalk) : []).map((poly) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly[0] ?? []) { x0 = Math.min(x0, x!); y0 = Math.min(y0, y!); x1 = Math.max(x1, x!); y1 = Math.max(y1, y!); }
    return { poly, box: [x0, y0, x1, y1] as [number, number, number, number] };
  });
  PAVING.set(net, { revision: net.revision, pieces });
  return pieces;
}

/**
 * A lot drawn over the street, cut back to the land: what falls on the paving
 * is taken off, so the lot - and the building grown on it - meets the footway
 * exactly, along a straight back and round a corner's curve alike (the
 * player, 2026-10-06: "snap certinho nas calçadas, rente"). The largest piece
 * is kept; null when nothing of it is on land.
 */
export function onLand(net: Network, points: readonly Vec2[]): Vec2[] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const near = pavingOf(net).filter(({ box }) => box[0] <= x1 && box[2] >= x0 && box[1] <= y1 && box[3] >= y0).map(({ poly }) => poly);
  if (!near.length) return [...points];
  let best: Vec2[] | null = null, bestArea = 0;
  for (const poly of difference([[points.map((p) => [p.x, p.y])]], near)) {
    const ring = (poly[0] ?? []).map(([x, y]) => ({ x: x!, y: y! }));
    const area = Math.abs(lotArea({ corners: ring }));
    if (ring.length >= 3 && area > bestArea) { bestArea = area; best = ring; }
  }
  return best && bestArea >= MIN_LOT * MIN_LOT / 2 ? squareCorners(best) : null;
}

/**
 * A lot cut back to the footways, its corners made square: each run of short
 * sides round a corner's curve between two long straight ones is replaced by
 * the point where the two straight ones meet. The lot is then a straight line
 * from corner to corner, and what grows on it reaches the footway at the
 * corner with no gap (the player, 2026-10-06), standing over the curve's
 * sliver of paving as a building on a street corner does.
 */
function squareCorners(ring: Vec2[]): Vec2[] {
  const n = ring.length;
  const longSides: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!;
    if (Math.hypot(q.x - p.x, q.y - p.y) >= STRAIGHT_BACK) longSides.push(i);
  }
  if (longSides.length < 2) return ring;
  // The corners between each long side and the next: their shared point, or
  // - with a curve's short sides between them - where their lines meet.
  const out: Vec2[] = [];
  for (let k = 0; k < longSides.length; k++) {
    const i = longSides[k]!, j = longSides[(k + 1) % longSides.length]!;
    const a = ring[i]!, b = ring[(i + 1) % n]!, c = ring[j]!, d = ring[(j + 1) % n]!;
    if ((i + 1) % n === j) { out.push(b); continue; }
    const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
    const den = ux * vy - uy * vx;
    const t = Math.abs(den) > 0.3 * Math.hypot(ux, uy) * Math.hypot(vx, vy) ? ((c.x - a.x) * vy - (c.y - a.y) * vx) / den : NaN;
    const x = { x: a.x + ux * t, y: a.y + uy * t };
    if (Number.isFinite(t) && Math.hypot(x.x - b.x, x.y - b.y) < m(8)) out.push(x);
    // Not a corner of two streets: the short sides kept as they are.
    else for (let r = (i + 1) % n; r !== (j + 1) % n; r = (r + 1) % n) out.push(ring[r]!);
  }
  return out.length >= 3 ? out : ring;
}

/**
 * A new lot of any shape: the corners the player clicked, in order. `front`
 * is the side on the street (the caller picks the side nearest one).
 */
export function addPolygonLot(doc: RoadDoc, points: readonly Vec2[], front: number): Lot | null {
  if (points.length < 3 || Math.abs(lotArea({ corners: points })) < MIN_LOT * MIN_LOT / 2) return null;
  const ring = [...points.slice(front), ...points.slice(0, front)];
  const corners = facingCorners(ring);
  if (doc.lots.some((l) => quadsOverlap(corners, l.corners, m(0.5)) && overlapDeep(corners, l.corners))) return null;
  const lot: Lot = { id: doc.nextLotId++, corners };
  doc.lots.push(lot);
  doc.lotRevision++;
  return lot;
}

/** Whether a corner or the middle of one polygon is well inside the other (the separating-axis test is only for convex shapes). */
function overlapDeep(p: readonly Vec2[], q: readonly Vec2[]): boolean {
  const inner = (a: readonly Vec2[], b: readonly Vec2[]): boolean => {
    const c = lotCentre({ corners: a });
    return [c, ...a.map((x) => lerp(x, c, 0.2))].some((x) => insideLot(x, { corners: b }));
  };
  return inner(p, q) || inner(q, p);
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
      if (near(q, from, m(0.8))) { changed = true; return { x: to.x, y: to.y }; }
      return q;
    });
    if (changed) { doc.lots[i] = { ...l, corners }; moved = true; }
  }
  if (moved) doc.lotRevision++;
  return moved;
}

/**
 * Bends the side of a lot from corner `a` to corner `b` through `through`:
 * a curve (a quadratic arc in 12 straight pieces) replaces it - in this lot
 * and in every neighbour sharing that side, so the boundary stays shared.
 */
export function curveLotSide(doc: RoadDoc, a: Vec2, b: Vec2, through: Vec2): boolean {
  const control = { x: 2 * through.x - (a.x + b.x) / 2, y: 2 * through.y - (a.y + b.y) / 2 };
  const curve = (from: Vec2, to: Vec2): Vec2[] => {
    const out: Vec2[] = [];
    for (let k = 1; k < 12; k++) {
      const t = k / 12, s = 1 - t;
      out.push({ x: s * s * from.x + 2 * s * t * control.x + t * t * to.x, y: s * s * from.y + 2 * s * t * control.y + t * t * to.y });
    }
    return out;
  };
  let changed = false;
  for (let i = 0; i < doc.lots.length; i++) {
    const l = doc.lots[i]!;
    const q = l.corners;
    for (let k = 0; k < q.length; k++) {
      const p = q[k]!, r = q[(k + 1) % q.length]!;
      let inner: Vec2[] | null = null;
      if (near(p, a) && near(r, b)) inner = curve(a, b);
      else if (near(p, b) && near(r, a)) inner = curve(a, b).reverse();
      if (!inner) continue;
      const corners = [...q.slice(0, k + 1), ...inner, ...q.slice(k + 1)];
      doc.lots[i] = { ...l, corners };
      changed = true;
      break;
    }
  }
  if (changed) doc.lotRevision++;
  return changed;
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
  return !!v && Number.isInteger(v.id) && Array.isArray(v.corners) && v.corners.length >= 3 &&
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

/** The footways' outer edges as drawn, in a grid, by network (`footwayEdges`). */
const EDGE_CELL = m(16);
/** An outline edge at least this long is a straight back of a footway; shorter ones are a corner's curve. */
const STRAIGHT_BACK = m(2);
interface FootwayEdges {
  readonly revision: number;
  readonly cells: Map<number, number[]>;
  /** Edges as x0, y0, x1, y1, four numbers each. */
  readonly edges: number[];
}
const EDGES = new WeakMap<Network, FootwayEdges>();
const edgeKey = (i: number, j: number): number => i * 65_536 + j;

/**
 * The outline of the paving a building may stand against: the union of every
 * footway as the game draws it (`levelPolygons`, the sidewalk level) - the
 * straight backs of the footways, and their curves round each junction's
 * corners. Built once per network.
 */
function footwayEdges(net: Network): FootwayEdges {
  const known = EDGES.get(net);
  if (known && known.revision === net.revision) return known;
  const cells = new Map<number, number[]>();
  const edges: number[] = [];
  const paving = net.doc.segments.size ? levelPolygons(net, Level.Sidewalk) : [];
  for (const poly of paving) for (const ring of poly) {
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k]!, q = ring[(k + 1) % ring.length]!;
      const at = edges.length / 4;
      edges.push(p[0]!, p[1]!, q[0]!, q[1]!);
      for (let i = Math.floor(Math.min(p[0]!, q[0]!) / EDGE_CELL); i <= Math.floor(Math.max(p[0]!, q[0]!) / EDGE_CELL); i++) {
        for (let j = Math.floor(Math.min(p[1]!, q[1]!) / EDGE_CELL); j <= Math.floor(Math.max(p[1]!, q[1]!) / EDGE_CELL); j++) {
          const list = cells.get(edgeKey(i, j));
          if (list) list.push(at); else cells.set(edgeKey(i, j), [at]);
        }
      }
    }
  }
  const built = { revision: net.revision, cells, edges };
  EDGES.set(net, built);
  return built;
}

/**
 * The lot snap: a point near a street is put on the outer edge of its footway
 * as drawn - the straight back of it, or its curve round a corner - so a lot,
 * and the building that grows on it, stands flush against the paving with no
 * gap and no overlap (the player, 2026-10-06). Near a corner of that outline
 * (where a straight back meets the curve, or two backs meet), onto the corner
 * itself. Another lot's corner first, so neighbours close up.
 */
export function lotSnapper(doc: RoadDoc, net: Network, lots: readonly Pick<Lot, 'id' | 'corners'>[] = doc.lots): (p: Vec2, reach: number, skip?: number) => { p: Vec2; kind: 'corner' | 'street' | 'lot' | null } {
  const { cells, edges } = footwayEdges(net);
  return (p, reach, skip) => {
    let lotBest: Vec2 | null = null, lotD = reach * 0.7;
    for (const l of lots) {
      if (l.id === skip) continue;
      for (const q of l.corners) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < lotD) { lotD = d; lotBest = q; } }
    }
    if (lotBest) return { p: { x: lotBest.x, y: lotBest.y }, kind: 'lot' };
    let best: Vec2 | null = null, bestD = reach;
    // The straight backs of the footways near the point (their curves round
    // the corners left out): two of them that meet make a corner.
    const backs: { d: number; x0: number; y0: number; dx: number; dy: number }[] = [];
    const seen = new Set<number>();
    const span = reach * 1.5;
    for (let i = Math.floor((p.x - span) / EDGE_CELL); i <= Math.floor((p.x + span) / EDGE_CELL); i++) {
      for (let j = Math.floor((p.y - span) / EDGE_CELL); j <= Math.floor((p.y + span) / EDGE_CELL); j++) {
        for (const e of cells.get(edgeKey(i, j)) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const x0 = edges[e * 4]!, y0 = edges[e * 4 + 1]!, x1 = edges[e * 4 + 2]!, y1 = edges[e * 4 + 3]!;
          const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.y - y0) * dy) / len2)) : 0;
          const qx = x0 + dx * t, qy = y0 + dy * t, d = Math.hypot(qx - p.x, qy - p.y);
          if (d < bestD) { bestD = d; best = { x: qx, y: qy }; }
          if (len2 >= STRAIGHT_BACK * STRAIGHT_BACK && d < span) backs.push({ d, x0, y0, dx, dy });
        }
      }
    }
    backs.sort((u, v) => u.d - v.d);
    let corner: Vec2 | null = null;
    const first = backs[0];
    if (first) {
      for (const other of backs) {
        const den = first.dx * other.dy - first.dy * other.dx;
        // Square enough to be two streets, not one back cut in two.
        if (Math.abs(den) < 0.3 * Math.hypot(first.dx, first.dy) * Math.hypot(other.dx, other.dy)) continue;
        const k = ((other.x0 - first.x0) * other.dy - (other.y0 - first.y0) * other.dx) / den;
        const x = { x: first.x0 + first.dx * k, y: first.y0 + first.dy * k };
        if (Math.hypot(x.x - p.x, x.y - p.y) < span) corner = x;
        break;
      }
    }
    if (corner) return { p: corner, kind: 'corner' };
    if (best) return { p: best, kind: 'street' };
    return { p, kind: null };
  };
}

/** Every corner of `lots` within `reach` of a street put on it (the same point snaps the same way, so shared corners stay shared). */
export function snapLotsToStreets(doc: RoadDoc, net: Network, corners: Vec2[][], reach = m(4)): void {
  const snapStreet = lotSnapper(doc, net, []);
  for (const ring of corners) for (let i = 0; i < ring.length; i++) {
    const s = snapStreet(ring[i]!, reach);
    if (s.kind) ring[i] = s.p;
  }
}

/** How far a lot's front may be from the middle of a road and still be on it. */
const ON_STREET = m(26);

/**
 * Removes the empty lots no road serves any more - the road beside them
 * deleted - and the empty lots a road now runs across (the player,
 * 2026-10-06: deleting a road left its lots on the grass). A lot with a
 * building standing keeps it. Only lots are looked at, never land planned
 * again: cheap enough for every road edit.
 */
export function pruneOrphanLots(doc: RoadDoc, net: Network): boolean {
  if (!doc.lots.length) return false;
  const { onRoad, onPlate } = pavedTester(doc, net);
  const ribbons = [...net.ribbons.values()];
  const kept = doc.lots.filter((l) => {
    if (l.building !== undefined && doc.buildings.has(l.building as never)) return true;
    const a = l.corners[0]!, b = l.corners[1] ?? a;
    const front = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const served = ribbons.some((r) => {
      const bb = r.full.bbox;
      if (front.x < bb.minX - ON_STREET || front.x > bb.maxX + ON_STREET || front.y < bb.minY - ON_STREET || front.y > bb.maxY + ON_STREET) return false;
      return r.full.distanceTo(front) < ON_STREET;
    });
    if (!served) return false;
    const c = lotCentre(l);
    return !(onRoad(c) || onPlate(c));
  });
  if (kept.length === doc.lots.length) return false;
  doc.lots.splice(0, doc.lots.length, ...kept);
  doc.lotRevision++;
  return true;
}
