import { EndType, FillRule, JoinType, inflatePathsD, unionD, type PathsD } from 'clipper2-ts';

import { Polyline } from '@core/polyline';
import type { MultiPoly } from '@core/clipper';
import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { LAMP_ZONE } from './section';
import { crossingAccesses, type CrossingAccess } from './landscape';
import { levelPolygons } from './surfaces';
import { Level } from './roadTypes';
import type { SegmentId } from './ids';
import { deckOf } from './walkways';
import { withGhostImages } from './planet/charts';

/**
 * The line wire poles stand on, and the kerb they stand behind.
 *
 * The outline of everything a kerb bounds (carriageway and kerb stone of
 * every ground street with footways, `surfaces().curb`), grown by
 * `POLE_KERB_INSET` with round joins (Clipper2, as the walking lines in
 * `walkways.ts` are). Each closed contour runs round one block at exactly that
 * distance from the kerb - along a street, round a corner's kerb return - so a
 * pole on it is on the pavement, never in a junction. The pole tool plans on
 * it (`editor/poles.ts`); the renderer turns a pole's lamp towards the kerb
 * nearest it (`kerbward`), which is right at a corner too, where no single
 * street owns the footway.
 */

/** How far behind the kerb stone the pole line runs: the middle of the lamp zone. */
export const POLE_KERB_INSET = LAMP_ZONE / 2;

export interface PoleLines {
  /** Closed contours, first point repeated at the end. */
  readonly contours: readonly Polyline[];
  /** The ground footways: paving out to the outer edge, and the kerbed carriageway inside it. */
  readonly paving: MultiPoly;
  readonly kerbed: MultiPoly;
  readonly accesses: readonly CrossingAccess[];
}

const cache = new WeakMap<Network, { revision: number; lines: PoleLines }>();

/** The pole lines of the ground streets that have footways. Cached per network revision. */
export function poleLines(net: Network): PoleLines {
  const known = cache.get(net);
  if (known && known.revision === net.revision) return known.lines;
  const doc = net.doc;
  // The two levels read (`surfaces` unions all four).
  const include = (id: SegmentId): boolean => {
    if (deckOf(doc, id) !== 'ground') return false;
    const ribbon = net.ribbons.get(id);
    return !!ribbon && carriesPedestrians(ribbon.road) && ribbon.road.sidewalk > 0;
  };
  const curb = levelPolygons(net, Level.Curb, include);
  const sidewalk = levelPolygons(net, Level.Sidewalk, include);
  const paths: PathsD = [];
  for (const poly of curb) for (const ring of poly) paths.push(ring.map(([x, y]) => ({ x: x!, y: y! })));
  const contours: Polyline[] = [];
  if (paths.length) {
    const grown = inflatePathsD(unionD(paths, [], FillRule.NonZero, 3), POLE_KERB_INSET, JoinType.Round, EndType.Polygon, 2, 3, 0.02);
    for (const ring of grown) if (ring.length >= 3) contours.push(Polyline.fromPoints([...ring, ring[0]!]));
  }
  // Point tests (`insideMulti`) read them with their ghost images (on the
  // planet: a point of one piece's chart finds the next piece's paving).
  const lines = { contours, paving: withGhostImages(sidewalk), kerbed: withGhostImages(curb), accesses: crossingAccesses(net) };
  cache.set(net, { revision: net.revision, lines });
  return lines;
}

/**
 * A ring's edges filed by horizontal band: the crossing test of
 * `pointInPolygon` (the same arithmetic, so the same answer) on only the
 * edges at a point's height - the paving of a whole town is one polygon of
 * thousands of edges, and every point test walked all of them.
 */
interface BandedRing { readonly points: readonly Vec2[]; readonly bands: Map<number, number[]> }
const BAND = 8;
function bandRing(points: readonly Vec2[]): BandedRing {
  const bands = new Map<number, number[]>();
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!.y, b = points[j]!.y;
    for (let k = Math.floor(Math.min(a, b) / BAND); k <= Math.floor(Math.max(a, b) / BAND); k++) {
      let list = bands.get(k);
      if (!list) bands.set(k, list = []);
      list.push(i);
    }
  }
  return { points, bands };
}
function insideRing(p: Vec2, ring: BandedRing): boolean {
  const edges = ring.bands.get(Math.floor(p.y / BAND));
  if (!edges) return false;
  const points = ring.points;
  let inside = false;
  for (const i of edges) {
    const pi = points[i]!;
    const pj = points[i === 0 ? points.length - 1 : i - 1]!;
    const straddles = pi.y > p.y !== pj.y > p.y;
    if (!straddles) continue;
    const x = ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (p.x < x) inside = !inside;
  }
  return inside;
}

/** One polygon of a MultiPoly ready to test against: its rings banded, and its bounds. */
interface IndexedPoly { readonly outer: BandedRing; readonly holes: BandedRing[]; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
/** A MultiPoly indexed for point tests: polygons by grid bucket. */
interface MultiIndex { readonly buckets: Map<number, IndexedPoly[]> }

/** Bucket edge of the point index, world units. */
const INDEX_CELL = 64;
const bucketOf = (bx: number, by: number): number => (bx + 32768) * 65536 + (by + 32768);
const indexes = new WeakMap<MultiPoly, MultiIndex>();

/**
 * The polygons of a MultiPoly as points, bounded and bucketed, once per
 * MultiPoly (per network revision, as `poleLines` is cached): a point test
 * used to turn every polygon of the town into new point arrays and test them
 * all, for every point - the zoning grid asked millions, and an edit froze
 * the game for seconds (the profile of 2026-10-05).
 */
function indexOf(polys: MultiPoly): MultiIndex {
  const known = indexes.get(polys);
  if (known) return known;
  const buckets = new Map<number, IndexedPoly[]>();
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (!outer || outer.length < 3) continue;
    const ring = outer.map(([x, y]) => ({ x: x!, y: y! }));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of ring) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const indexed: IndexedPoly = { outer: bandRing(ring), holes: holes.map((h) => bandRing(h.map(([x, y]) => ({ x: x!, y: y! })))), x0, y0, x1, y1 };
    for (let bx = Math.floor(x0 / INDEX_CELL); bx <= Math.floor(x1 / INDEX_CELL); bx++) {
      for (let by = Math.floor(y0 / INDEX_CELL); by <= Math.floor(y1 / INDEX_CELL); by++) {
        const k = bucketOf(bx, by);
        let list = buckets.get(k);
        if (!list) buckets.set(k, list = []);
        list.push(indexed);
      }
    }
  }
  const index = { buckets };
  indexes.set(polys, index);
  return index;
}

/** Whether a point is inside a MultiPoly: inside a polygon's outer ring and none of its holes. */
export function insideMulti(p: Vec2, polys: MultiPoly): boolean {
  const list = indexOf(polys).buckets.get(bucketOf(Math.floor(p.x / INDEX_CELL), Math.floor(p.y / INDEX_CELL)));
  if (!list) return false;
  for (const poly of list) {
    if (p.x < poly.x0 || p.x > poly.x1 || p.y < poly.y0 || p.y > poly.y1) continue;
    if (!insideRing(p, poly.outer)) continue;
    if (poly.holes.some((h) => insideRing(p, h))) continue;
    return true;
  }
  return false;
}

/** Whether a point is on a footway: on the paving, outside every kerbed carriageway. */
export function onFootway(net: Network, p: Vec2): boolean {
  const lines = poleLines(net);
  return insideMulti(p, lines.paving) && !insideMulti(p, lines.kerbed);
}

/**
 * The unit direction from a point to the nearest kerb edge (the carriageway's
 * side), or null when no kerbed street is within `reach`.
 */
export function kerbward(net: Network, p: Vec2, reach: number): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = reach;
  for (const poly of poleLines(net).kerbed) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        const ax = a[0]!, ay = a[1]!, dx = b[0]! - ax, dy = b[1]! - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
        const qx = ax + dx * t - p.x, qy = ay + dy * t - p.y;
        const d = Math.hypot(qx, qy);
        if (d < bestD && d > 1e-9) { bestD = d; best = { x: qx / d, y: qy / d }; }
      }
    }
  }
  return best;
}
