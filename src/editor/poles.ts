import { type Vec2, dist } from '@core/vec2';
import type { NodeId, PoleId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { carriesPedestrians } from '@world/pedestrianAccess';
import { LAMP_ZONE, sectionOf } from '@world/section';
import { crossingAccesses, onCrossingAccess, type CrossingAccess } from '@world/landscape';
import { DEFAULT_POLE_SPACING, MAX_POLE_SPACING, MIN_POLE_SPACING, poleCarriesLamp, type PoleLampMode } from '@world/utilities';
import { m } from '@world/units';

/**
 * Where a pole line goes: along the footways, and nowhere else.
 *
 * A distribution line in a town runs down one side of the street, its poles
 * in the furnishing zone beside the kerb (where the lamp columns stand,
 * `section.ts`), turning at the corners with the street. The tool used to drop
 * poles on the straight line between the two ends of a drag, so a run between
 * two streets cut across blocks and carriageways, and one end could be in
 * open ground. Now (the player's order of 2026-10-05):
 *
 * - both ends must be on a footway, or on a pole already standing;
 * - between them the run follows the footway line, round the street's curve,
 *   and round junction corners to the next street - the shortest way along
 *   the footways, which may cross a street at a junction mouth, as a real
 *   line does;
 * - a pole stands at every corner it turns, and the rest are spaced evenly
 *   along each stretch, never in a crossing's landing.
 *
 * Both the preview and the commit ask `planPoleRun`, so what is drawn under
 * the pointer is what is built on release.
 */

/** Pick radius for an existing pole, in screen pixels. */
export const POLE_PICK_PIXELS = 34;

/** How far off the footway a point may be and still be pulled onto it, world units. */
const FOOTWAY_CATCH = m(2.5);

/** A link at a junction between two footway ends farther apart than this is not a corner. */
const CORNER_REACH = m(30);

function lampFor(index: number, mode: PoleLampMode): boolean {
  return mode === 'all' ? true : mode === 'none' ? false : poleCarriesLamp(index);
}

/** One side of one street: the line its poles stand on, between the junction mouths. */
interface FootwayLine {
  readonly segment: SegmentId;
  readonly side: 1 | -1;
  /** Offset of the line from the centreline. */
  readonly out: number;
  readonly lo: number;
  readonly hi: number;
  readonly nodeLo: NodeId;
  readonly nodeHi: NodeId;
  readonly point: (s: number) => Vec2;
}

interface Footways {
  readonly lines: readonly FootwayLine[];
  readonly accesses: readonly CrossingAccess[];
}

const cache = new WeakMap<Network, { revision: number; footways: Footways }>();

function footways(net: Network): Footways {
  const known = cache.get(net);
  if (known && known.revision === net.revision) return known.footways;
  const lines: FootwayLine[] = [];
  for (const ribbon of net.ribbons.values()) {
    const road = ribbon.road;
    if (!carriesPedestrians(road) || road.sidewalk <= 0) continue;
    const segment = net.doc.segment(ribbon.id);
    if (!segment) continue;
    const zone = sectionOf(road, segment.direction).side.furnishing;
    const out = zone.inner + Math.min(LAMP_ZONE, Math.max(zone.outer - zone.inner, m(0.2))) / 2;
    const length = ribbon.full.length;
    const lo = net.mouthDistance(ribbon.id, segment.a);
    const hi = length - net.mouthDistance(ribbon.id, segment.b);
    if (!(hi - lo > m(1))) continue;
    const full = ribbon.full;
    for (const side of [1, -1] as const) {
      lines.push({
        segment: ribbon.id, side, out, lo, hi, nodeLo: segment.a, nodeHi: segment.b,
        point: (s) => {
          const f = full.sampleAt(Math.max(lo, Math.min(hi, s)));
          return { x: f.p.x + f.n.x * out * side, y: f.p.y + f.n.y * out * side };
        },
      });
    }
  }
  const footways = { lines, accesses: crossingAccesses(net) };
  cache.set(net, { revision: net.revision, footways });
  return footways;
}

/** A place on a footway line. */
interface OnLine {
  readonly line: number;
  readonly s: number;
}

function nearestOnLine(net: Network, at: Vec2, reach: number): (OnLine & { at: Vec2 }) | null {
  const { lines } = footways(net);
  let best: (OnLine & { at: Vec2 }) | null = null;
  let bestD = reach;
  const hit = { s: 0, distance: 0 };
  lines.forEach((line, index) => {
    const ribbon = net.ribbons.get(line.segment);
    if (!ribbon) return;
    const box = ribbon.full.bbox;
    const pad = line.out + reach;
    if (at.x < box.minX - pad || at.x > box.maxX + pad || at.y < box.minY - pad || at.y > box.maxY + pad) return;
    ribbon.full.closestInto(at.x, at.y, hit);
    const s = Math.max(line.lo, Math.min(line.hi, hit.s));
    const p = line.point(s);
    const d = dist(p, at);
    if (d < bestD) {
      bestD = d;
      best = { line: index, s, at: p };
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
 * is the commonest thing anyone does), else onto the footway line of the
 * street under the pointer. Anything else is `free`, and a run with a free
 * end is refused.
 */
export function snapPole(doc: RoadDoc, net: Network, at: Vec2, reach: number): PoleSnap {
  const hit = doc.poleNear(at, reach);
  if (hit) return { at: { x: hit.x, y: hit.y }, kind: 'pole', pole: hit.id };
  const on = nearestOnLine(net, at, Math.max(reach, FOOTWAY_CATCH) + m(6));
  if (on) {
    // Only when the pointer is really over that footway (or just off it).
    const ribbon = net.ribbons.get(footways(net).lines[on.line]!.segment)!;
    const road = ribbon.road;
    const across = ribbon.full.closestPoint(at).distance;
    if (across >= road.width / 2 - FOOTWAY_CATCH && across <= road.width / 2 + road.sidewalk + FOOTWAY_CATCH) {
      return { at: on.at, kind: 'footway' };
    }
  }
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

/** One stretch of the route: along a line, or straight across a corner. */
type Leg =
  | { readonly kind: 'line'; readonly line: number; readonly from: number; readonly to: number }
  | { readonly kind: 'chord'; readonly a: Vec2; readonly b: Vec2 };

/**
 * The shortest way along the footways from one place to another.
 *
 * The graph is the two ends of every footway line; a line joins its own two
 * ends, and the ends that meet at the same junction are joined across the
 * corner (or across the street, at the mouth). Dijkstra over a few hundred
 * vertices at most.
 */
function route(net: Network, from: OnLine, to: OnLine): Leg[] | null {
  const { lines } = footways(net);
  if (from.line === to.line) return [{ kind: 'line', line: from.line, from: from.s, to: to.s }];
  // Vertex 2i is line i's lo end, 2i + 1 its hi end; START and END are the two places.
  const n = lines.length * 2;
  const START = n, END = n + 1;
  const end = (v: number): { at: Vec2; node: NodeId; s: number } => {
    const line = lines[v >> 1]!;
    return (v & 1) === 0 ? { at: line.point(line.lo), node: line.nodeLo, s: line.lo }
      : { at: line.point(line.hi), node: line.nodeHi, s: line.hi };
  };
  const byNode = new Map<NodeId, number[]>();
  for (let v = 0; v < n; v++) {
    const node = end(v).node;
    const list = byNode.get(node);
    if (list) list.push(v);
    else byNode.set(node, [v]);
  }
  const edges = (v: number): [number, number][] => {
    const out: [number, number][] = [];
    if (v === START) {
      const line = lines[from.line]!;
      out.push([from.line * 2, from.s - line.lo], [from.line * 2 + 1, line.hi - from.s]);
      return out;
    }
    const line = lines[v >> 1]!;
    out.push([v ^ 1, line.hi - line.lo]);
    if ((v >> 1) === to.line) out.push([END, (v & 1) === 0 ? to.s - line.lo : line.hi - to.s]);
    const here = end(v);
    for (const w of byNode.get(here.node) ?? []) {
      if (w === v) continue;
      const d = dist(here.at, end(w).at);
      if (d <= CORNER_REACH) out.push([w, d]);
    }
    return out;
  };
  const best = new Float64Array(n + 2).fill(Infinity);
  const prev = new Int32Array(n + 2).fill(-1);
  const done = new Uint8Array(n + 2);
  best[START] = 0;
  for (;;) {
    let v = -1;
    for (let i = 0; i < n + 2; i++) if (!done[i] && best[i]! < Infinity && (v < 0 || best[i]! < best[v]!)) v = i;
    if (v < 0) return null;
    if (v === END) break;
    done[v] = 1;
    for (const [w, cost] of edges(v)) {
      if (done[w]) continue;
      const c = best[v]! + Math.max(0, cost);
      if (c < best[w]!) {
        best[w] = c;
        prev[w] = v;
      }
    }
  }
  const chain: number[] = [];
  for (let v = END; v >= 0; v = prev[v]!) chain.unshift(v);
  // START, ends..., END: consecutive ends of one line are a line leg, of two lines a corner.
  const legs: Leg[] = [];
  let cursor: { line: number; s: number } = { line: from.line, s: from.s };
  for (let i = 1; i < chain.length; i++) {
    const v = chain[i]!;
    if (v === END) {
      legs.push({ kind: 'line', line: to.line, from: cursor.s, to: to.s });
      break;
    }
    const here = end(v);
    if ((v >> 1) === cursor.line) {
      legs.push({ kind: 'line', line: cursor.line, from: cursor.s, to: here.s });
      cursor = { line: v >> 1, s: here.s };
    } else {
      const was = lines[cursor.line]!.point(cursor.s);
      legs.push({ kind: 'chord', a: was, b: here.at });
      cursor = { line: v >> 1, s: here.s };
    }
  }
  return legs.filter((leg) => leg.kind === 'chord' ? dist(leg.a, leg.b) > 1e-6 : Math.abs(leg.to - leg.from) > 1e-6);
}

/** Where a place is on the lines: a snapped footway point, or a pole standing on one. */
function placeOf(net: Network, snap: PoleSnap): OnLine | null {
  const on = nearestOnLine(net, snap.at, snap.kind === 'pole' ? m(1.5) : m(0.5));
  return on ? { line: on.line, s: on.s } : null;
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
  const a = placeOf(net, from);
  const b = placeOf(net, to);
  if (!a || !b) return refuse('offFootway');
  const legs = route(net, a, b);
  if (!legs) return refuse('noPath');

  const { lines, accesses } = footways(net);
  const step = Math.max(MIN_POLE_SPACING, Math.min(MAX_POLE_SPACING, spacing));
  // The poles: the start, then each leg's end, with evenly spaced ones along a line leg.
  const points: Vec2[] = [from.at];
  for (const leg of legs) {
    if (leg.kind === 'chord') {
      points.push(leg.b);
      continue;
    }
    const line = lines[leg.line]!;
    const length = Math.abs(leg.to - leg.from);
    const spans = Math.max(1, Math.round(length / step));
    for (let i = 1; i <= spans; i++) {
      let s = leg.from + ((leg.to - leg.from) * i) / spans;
      // Out of a crossing's landing, along the line, for any pole but the run's own ends.
      if (i < spans) s = clearOfCrossings(net, accesses, line, s);
      points.push(line.point(s));
    }
  }
  // The run's own ends are where they snapped, exactly.
  points[points.length - 1] = to.at;
  // Corner ends a hair apart collapse into one pole.
  const merged: Vec2[] = [];
  for (const p of points) if (!merged.length || dist(merged[merged.length - 1]!, p) > m(1)) merged.push(p);

  const poles: PlannedPole[] = merged.map((at, index) => {
    const existing = index === 0 && from.pole !== undefined ? doc.pole(from.pole)
      : index === merged.length - 1 && to.pole !== undefined ? doc.pole(to.pole)
        : doc.poleNear(at, Math.min(reach, m(2)));
    return {
      at: existing ? { x: existing.x, y: existing.y } : at,
      existing: existing?.id ?? null,
      // A pole that already exists keeps the lamp it has.
      lamp: existing ? existing.lamp : lampFor(index, lamps),
    };
  });
  return { from, to, poles };
}

/** A station on `line` near `s` that is not in any crossing's landing. */
function clearOfCrossings(net: Network, accesses: readonly CrossingAccess[], line: FootwayLine, s: number): number {
  const blocked = (t: number): boolean => {
    const p = line.point(t);
    return onCrossingAccess(net, accesses, line.segment, p.x, p.y, m(0.3));
  };
  if (!blocked(s)) return s;
  for (let d = m(1); d <= m(12); d += m(1)) {
    if (s + d <= line.hi && !blocked(s + d)) return s + d;
    if (s - d >= line.lo && !blocked(s - d)) return s - d;
  }
  return s;
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
