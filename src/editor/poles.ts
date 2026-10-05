import type { Polyline } from '@core/polyline';
import { type Vec2, dist } from '@core/vec2';
import type { PoleId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import type { CrossingAccess } from '@world/landscape';
import { CROSSWALK_DEPTH } from '@world/approach';
import { onFootway, poleLines } from '@world/poleLines';
import { DEFAULT_POLE_SPACING, MAX_POLE_SPACING, MIN_POLE_SPACING, poleCarriesLamp, type PoleLampMode } from '@world/utilities';
import { m } from '@world/units';

/**
 * Where a pole line goes: on the footway, just behind the kerb, and nowhere
 * else (the player's order of 2026-10-05, second pass).
 *
 * A distribution line in a town runs ALONG the street, its poles in a uniform
 * alignment a little behind the face of the kerb (N.J.A.C. 16:25-10.3; AASHTO
 * asks at least 0.5 m from the kerb face), turning with the street. The first
 * version of this tool kept one straight line per street, cut at each
 * junction's mouth, and joined two streets by a chord between their line
 * ends. Both halves of that were wrong at a corner: the line end at the mouth
 * stood inside the kerb return - on the asphalt - and the two streets' ends
 * gave two or three poles a few metres apart where one corner pole belongs.
 *
 * Now the line IS the kerb line, offset into the footway: the outline of
 * everything a kerb bounds (carriageway and kerb stone of every street that
 * has footways, `surfaces().curb`), grown by `POLE_KERB_INSET` with round
 * joins (Clipper2, as the walking lines in `walkways.ts` are). Each closed
 * contour runs round one block at exactly that distance from the kerb - along
 * a street, round the kerb return of a corner, round a bend - so a pole on it
 * is on the pavement by construction, never in a junction.
 *
 * - Both ends of a run must be on that line (or on a pole already standing).
 * - Between them the run follows the contour the short way round the block.
 *   An end on another block's contour is reached by ONE span across the
 *   street, from the point of this block's contour nearest it.
 * - A pole stands at every corner the line turns (the corners are found by
 *   Ramer-Douglas-Peucker simplification of the route), and the rest are
 *   spaced evenly between corners, off any crossing's landing.
 * - A planned pole close to one already standing IS that pole: lines join
 *   instead of growing a second mast beside the first.
 *
 * Both the preview and the commit ask `planPoleRun`, so what is drawn under
 * the pointer is what is built on release.
 */

/** Pick radius for an existing pole, in screen pixels. */
export const POLE_PICK_PIXELS = 34;

/** A pointer this far from the line, or anywhere on a footway, takes the line. */
const LINE_CATCH = m(2.5);

/** An existing pole off the line (drawn by an older version) joins it within this. */
const POLE_TO_LINE = m(5);

/** Douglas-Peucker tolerance for a corner of the route: a turn that bows the line this far. */
const CORNER_TOLERANCE = m(1.5);

/** Two poles of one run never stand closer than this; corners closer merge into one. */
const MIN_POLE_GAP = m(10);

/** A planned pole this close to a pole already standing is that pole. */
const REUSE_RADIUS = m(6);

/** Step along the contour when a stretch of it is turned into points. */
const SAMPLE_STEP = m(0.5);

export { onFootway };

function lampFor(index: number, mode: PoleLampMode): boolean {
  return mode === 'all' ? true : mode === 'none' ? false : poleCarriesLamp(index);
}

/** A place on a contour. */
interface OnContour {
  readonly contour: number;
  readonly s: number;
  readonly at: Vec2;
  readonly distance: number;
}

function nearestOnContour(net: Network, at: Vec2, reach: number): OnContour | null {
  let best: OnContour | null = null;
  poleLines(net).contours.forEach((line: Polyline, contour: number) => {
    const box = line.bbox;
    if (at.x < box.minX - reach || at.x > box.maxX + reach || at.y < box.minY - reach || at.y > box.maxY + reach) return;
    const hit = line.closestPoint(at);
    if (hit.distance <= reach && (!best || hit.distance < best.distance)) {
      best = { contour, s: hit.s, at: hit.point, distance: hit.distance };
    }
  });
  return best;
}

export type PoleSnapKind = 'pole' | 'footway' | 'free';

export interface PoleSnap {
  readonly at: Vec2;
  readonly kind: PoleSnapKind;
  /** The existing pole this snapped onto, when `kind` is `pole`. */
  readonly pole?: PoleId;
}

/**
 * Snaps one end of a pole run: onto a pole already standing (joining a line
 * is the commonest thing anyone does), else onto the pole line of the footway
 * under the pointer. Anything else is `free`, and a run with a free end is
 * refused.
 */
export function snapPole(doc: RoadDoc, net: Network, at: Vec2, reach: number): PoleSnap {
  const hit = doc.poleNear(at, reach);
  if (hit) return { at: { x: hit.x, y: hit.y }, kind: 'pole', pole: hit.id };
  // Anywhere on the pavement takes its line; off it, only just beside the line.
  const footway = onFootway(net, at);
  const on = nearestOnContour(net, at, footway ? m(12) : LINE_CATCH);
  if (on && onFootway(net, on.at)) return { at: on.at, kind: 'footway' };
  return { at: { x: at.x, y: at.y }, kind: 'free' };
}

export interface PlannedPole {
  readonly at: Vec2;
  /** The pole already standing here, which the run will reuse. */
  readonly existing: PoleId | null;
  readonly lamp: boolean;
}

export type PoleRunRefusal = 'offFootway' | 'noPath';

export interface PoleRunPlan {
  readonly from: PoleSnap;
  readonly to: PoleSnap;
  readonly poles: readonly PlannedPole[];
  /** Set when nothing would be built, and why. */
  readonly refused?: PoleRunRefusal;
}

/** Points along a closed contour from station `sa` to `sb`, the shorter way round. */
function alongContour(line: Polyline, sa: number, sb: number): Vec2[] {
  const total = line.length;
  const forward = (sb - sa + total) % total;
  const backward = (sa - sb + total) % total;
  const span = Math.min(forward, backward);
  const sign = forward <= backward ? 1 : -1;
  const steps = Math.max(1, Math.ceil(span / SAMPLE_STEP));
  const out: Vec2[] = [];
  for (let k = 0; k <= steps; k++) {
    const s = sa + (sign * span * k) / steps;
    out.push(line.sampleAt(((s % total) + total) % total).p);
  }
  return out;
}

/** Where a snapped end lies on the contours, or null when no contour is near it. */
function placeOf(net: Network, snap: PoleSnap): OnContour | null {
  return nearestOnContour(net, snap.at, snap.kind === 'pole' ? POLE_TO_LINE : m(0.5));
}

/**
 * The route of a run, as a dense list of points: along the contour of the
 * start's block, then (when the end is on another block) one span across the
 * street. Null when the street is too wide to span.
 */
function route(net: Network, from: PoleSnap, a: OnContour, to: PoleSnap, b: OnContour): Vec2[] | null {
  const { contours } = poleLines(net);
  const lineA = contours[a.contour]!;
  const head: Vec2[] = from.kind === 'pole' && a.distance > 1e-3 ? [from.at] : [];
  if (a.contour === b.contour) {
    const body = alongContour(lineA, a.s, b.s);
    const tail = to.kind === 'pole' && b.distance > 1e-3 ? [to.at] : [];
    return [...head, ...body, ...tail];
  }
  // Across the street: along this block to the point nearest the far end, then one span.
  const turn = lineA.closestPoint(to.at);
  if (dist(turn.point, to.at) > MAX_POLE_SPACING) return null;
  return [...head, ...alongContour(lineA, a.s, turn.s), to.at];
}

/** Indices of the points Ramer-Douglas-Peucker keeps at `tolerance`. */
function corners(points: readonly Vec2[], tolerance: number): number[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = points[i]!, b = points[j]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let far = -1, farD = tolerance;
    for (let k = i + 1; k < j; k++) {
      const p = points[k]!;
      const d = len > 1e-9 ? Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len : dist(p, a);
      if (d > farD) { farD = d; far = k; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

/** Whether a point stands in a crossing's landing (any street's: a corner belongs to none). */
function inLanding(accesses: readonly CrossingAccess[], p: Vec2): boolean {
  const margin = m(0.3) + m(0.2);
  return accesses.some((access) => {
    if (access.structure !== 'ground') return false;
    const dx = p.x - access.x, dy = p.y - access.y;
    return Math.abs(dx * access.tx + dy * access.ty) < CROSSWALK_DEPTH / 2 + margin &&
      Math.abs(-dx * access.ty + dy * access.tx) < access.across + margin;
  });
}

/**
 * Everything the run WOULD build, from the two raw ends of the gesture.
 * Called by the preview on every pointer move and by the commit once.
 * Nothing here mutates the document.
 */
export function planPoleRun(
  doc: RoadDoc,
  net: Network,
  rawFrom: Vec2,
  rawTo: Vec2,
  reach: number,
  spacing = DEFAULT_POLE_SPACING,
  lamps: PoleLampMode = 'alternate',
): PoleRunPlan {
  const from = snapPole(doc, net, rawFrom, reach);
  const to = snapPole(doc, net, rawTo, reach);
  const refuse = (refused: PoleRunRefusal): PoleRunPlan => ({ from, to, poles: [], refused });
  if (from.kind === 'free' || to.kind === 'free') return refuse('offFootway');
  if (from.pole !== undefined && from.pole === to.pole) return { from, to, poles: [] };
  if (dist(from.at, to.at) < 1e-3) return { from, to, poles: [] };
  const a = placeOf(net, from);
  const b = placeOf(net, to);
  if (!a || !b) return refuse('noPath');
  const path = route(net, from, a, to, b);
  if (!path || path.length < 2) return refuse('noPath');

  // Arc length along the route.
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1]! + dist(path[i - 1]!, path[i]!));
  const total = cum[cum.length - 1]!;
  const at = (s: number): Vec2 => {
    let i = 1;
    while (i < cum.length - 1 && cum[i]! < s) i++;
    const s0 = cum[i - 1]!, s1 = cum[i]!;
    const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    const p = path[i - 1]!, q = path[i]!;
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  };

  // Corner stations; corners closer than a pole gap merge into one, and none
  // stands within a gap of either end.
  const keys: number[] = [0];
  for (const index of corners(path, CORNER_TOLERANCE).slice(1, -1)) {
    const s = cum[index]!;
    if (s < MIN_POLE_GAP || total - s < MIN_POLE_GAP) continue;
    const last = keys[keys.length - 1]!;
    if (keys.length > 1 && s - last < MIN_POLE_GAP) keys[keys.length - 1] = (last + s) / 2;
    else keys.push(s);
  }
  keys.push(total);

  // Evenly between corners, nudged off crossing landings along the route.
  const { accesses } = poleLines(net);
  const step = Math.max(MIN_POLE_SPACING, Math.min(MAX_POLE_SPACING, spacing));
  const stations: number[] = [0];
  for (let k = 1; k < keys.length; k++) {
    const s0 = keys[k - 1]!, s1 = keys[k]!;
    const spans = Math.max(1, Math.round((s1 - s0) / step));
    for (let i = 1; i <= spans; i++) stations.push(s0 + ((s1 - s0) * i) / spans);
  }
  const clear = (s: number, lo: number, hi: number): number | null => {
    const ok = (t: number): boolean => { const p = at(t); return !inLanding(accesses, p) && onFootway(net, p); };
    if (ok(s)) return s;
    for (let d = m(1); d <= m(12); d += m(1)) {
      if (s + d < hi && ok(s + d)) return s + d;
      if (s - d > lo && ok(s - d)) return s - d;
    }
    return null;
  };
  const kept: number[] = [0];
  for (let i = 1; i < stations.length - 1; i++) {
    const s = clear(stations[i]!, kept[kept.length - 1]! + MIN_POLE_GAP / 2, total - MIN_POLE_GAP / 2);
    if (s !== null) kept.push(s);
  }
  kept.push(total);

  // Poles: the ends exactly where they snapped, existing poles reused.
  const points = kept.map((s, i) => (i === 0 ? from.at : i === kept.length - 1 ? to.at : at(s)));
  const poles: PlannedPole[] = [];
  points.forEach((p, index) => {
    const existing = index === 0 && from.pole !== undefined ? doc.pole(from.pole)
      : index === points.length - 1 && to.pole !== undefined ? doc.pole(to.pole)
        : doc.poleNear(p, REUSE_RADIUS);
    const planned: PlannedPole = {
      at: existing ? { x: existing.x, y: existing.y } : p,
      existing: existing?.id ?? null,
      // A pole that already exists keeps the lamp it has.
      lamp: existing ? existing.lamp : lampFor(index, lamps),
    };
    const prev = poles[poles.length - 1];
    // The same standing pole twice in a row is one pole.
    if (prev && planned.existing !== null && prev.existing === planned.existing) return;
    poles.push(planned);
  });
  if (poles.length < 2) return { from, to, poles: [] };
  return { from, to, poles };
}

/**
 * Applies a plan to the document. Returns whether anything was built.
 * A refused plan builds nothing.
 */
export function commitPoleRun(doc: RoadDoc, plan: PoleRunPlan): boolean {
  if (plan.refused || plan.poles.length < 2) return false;

  const ids: PoleId[] = plan.poles.map(
    (pole) => pole.existing ?? doc.addPole(pole.at, pole.lamp).id,
  );

  let built = false;
  for (let i = 1; i < ids.length; i++) {
    const a = ids[i - 1];
    const b = ids[i];
    if (a === undefined || b === undefined || a === b) continue;
    if (doc.addPoleSpan(a, b)) built = true;
  }
  return built;
}
