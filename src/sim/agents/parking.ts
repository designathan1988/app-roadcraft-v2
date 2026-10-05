import { pointInPolygon } from '@core/polygon';
import { localDirToWorld, localToWorld, solidFootprints, worldToLocal } from '@world/buildings/geometry';
import { type LotGrid, buildLotGrid, wayOut } from './lotNav';
import type { Building, BuildingId } from '@world/buildings/types';
import type { Lanelet, LaneletId } from '@world/lanelets';
import { m } from '@world/units';
import type { SimWorld } from '../world';
import type { VehicleId } from '../vehicles/state';
import type { SegmentId } from '@world/ids';
import { parkingLayout } from '@world/parkingLayout';
import { PARKING_PITCH } from '@world/parking';

/**
 * The parking bays of the city: where a resident's car stands when it is not
 * on the road.
 *
 * A car used to be made at the kerb when its driver set off and deleted when
 * it arrived, the "pocket car" of Cities: Skylines 1. Cities: Skylines II
 * parks every car in a real space and lets the lack of one change how a
 * citizen travels (Development Diary #11); so does this. Every bay painted on
 * a lot (`parking` elements, `editor/lotPlan.ts`, `world/defaultTown.ts`) is
 * a space for one car, with the side it opens on and the point of the road a
 * car leaves it for and comes back from.
 */

/** Width of one stall, as the lot planner lays them (2.5 x 5 m). */
const STALL = m(2.5);
/** Farthest a bay may be from the lane it is reached from. */
const LANE_REACH = m(45);
/** Kept clear of the ends of a lane where a car joins or leaves it. */
const LANE_END = m(20);

export interface BayLane {
  readonly lanelet: LaneletId;
  /** Arc position of the point where a car's body centre joins or leaves the lane. */
  readonly at: number;
  readonly x: number;
  readonly y: number;
  /** Unit direction of travel there. */
  readonly tx: number;
  readonly ty: number;
}

export interface Bay {
  readonly id: number;
  readonly building: BuildingId;
  /** Centre of the stall. */
  readonly x: number;
  readonly y: number;
  /** Unit direction out of the stall, towards its open end. */
  readonly ox: number;
  readonly oy: number;
  /** Depth of the stall. */
  readonly depth: number;
  /** The road it is reached from; null when no lane is near enough. */
  readonly lane: BayLane | null;
  /**
   * The way through its lot, from the aisle in front of the stall to the lot's
   * street edge (world points, in the order a car leaving drives them): a car
   * keeps to the lot and never cuts across a building to the nearest road.
   * Empty for a bay outside any lot: it is driven straight to its lane.
   */
  readonly via: readonly { readonly x: number; readonly y: number }[];
  /** The car standing in it, or coming to it (reserved). */
  car: VehicleId | null;
  /**
   * A bay along a street's kerb (`world/parkingLayout.ts`), not in a lot: a
   * car backs into it from the lane beside, as one parks on a real street,
   * and drives forward out of it. Its lane point is a few metres ahead of it.
   */
  readonly kerb?: true;
}

/** Clear of the corners of a lot where a car leaves it for the street. */
const EDGE_MARGIN = m(3.5);
/** How far inside the street edge the last turn is made. */
const EDGE_INSET = m(3);
/** Farthest a lot's street edge may be from the lane it opens onto. */
const EDGE_REACH = m(22);

/** Every stall of every parking element, with the way out of its lot and the lane it is reached from. */
export function collectBays(w: SimWorld): Bay[] {
  const out: Bay[] = [];
  const walls = wallsOf(w);
  const navCache = new Map<object, { exits: LotExit[]; grid: LotGrid }>();
  for (const b of w.doc.buildings.all()) {
    for (const el of b.elements ?? []) {
      if (el.kind !== 'parking') continue;
      const stalls = Math.max(1, Math.floor(el.w / STALL));
      const alongY = el.facing === 0 || el.facing === 2;
      // `w` runs across the facing (the row of stalls), `d` along it (a stall's depth).
      let ax = alongY ? 0 : 1, ay = alongY ? 1 : 0;
      let cx = alongY ? 1 : 0, cy = alongY ? 0 : 1;
      if (el.angle) {
        const c = Math.cos(el.angle), s = Math.sin(el.angle);
        [ax, ay] = [ax * c - ay * s, ax * s + ay * c];
        [cx, cy] = [cx * c - cy * s, cx * s + cy * c];
      }
      const lot = b.volumes.find((v) => v.open && el.x >= v.x && el.x <= v.x + v.w && el.y >= v.y && el.y <= v.y + v.d);
      let nav = lot ? navCache.get(lot) : undefined;
      if (lot && !nav) {
        const exits = exitsOf(w, b, lot, walls);
        const local = walls.filter((wl) => near(wl, b, lot)).map((wl) => wl.ring.map((q) => worldToLocal(b, q)));
        nav = { exits, grid: buildLotGrid(b, lot, local, exits) };
        navCache.set(lot, nav);
      }
      for (let k = 0; k < stalls; k++) {
        const u = -el.w / 2 + (el.w * (k + 0.5)) / stalls;
        const lx = el.x + cx * u, ly = el.y + cy * u;
        const p = localToWorld(b, lx, ly);
        if (lot && nav) {
          // The stall opens on whichever side has an aisle that leads out of
          // the lot, down the aisles to the nearest way out onto a street.
          const reach = el.d / 2 + m(2.8);
          let pick: { sign: number; points: { x: number; y: number }[]; exit: number; cost: number } | null = null;
          for (const sign of [1, -1]) {
            const aisle = { x: lx + ax * sign * reach, y: ly + ay * sign * reach };
            const way = wayOut(nav.grid, aisle.x, aisle.y);
            if (!way) continue;
            let cost = 0;
            for (let i = 1; i < way.points.length; i++) cost += Math.hypot(way.points[i]!.x - way.points[i - 1]!.x, way.points[i]!.y - way.points[i - 1]!.y);
            if (!pick || cost < pick.cost) pick = { sign, points: way.points, exit: way.exit, cost };
          }
          const exit = pick ? nav.exits[pick.exit] : undefined;
          const axis = localDirToWorld(b, ax * (pick?.sign ?? 1), ay * (pick?.sign ?? 1));
          if (!pick || !exit) {
            // No aisle from this stall leads out to a street: it is not used.
            out.push({ id: out.length, building: b.id, x: p.x, y: p.y, ox: axis.x, oy: axis.y, depth: el.d, lane: null, via: [], car: null });
            continue;
          }
          const local = [...pick.points, exit.inner];
          const via = local.filter((q, i) => i === 0 || Math.hypot(q.x - local[i - 1]!.x, q.y - local[i - 1]!.y) > m(1))
            .map((q) => localToWorld(b, q.x, q.y));
          out.push({
            id: out.length, building: b.id, x: p.x, y: p.y, ox: axis.x, oy: axis.y,
            depth: el.d, lane: exit.lane, via, car: null,
          });
          continue;
        }
        const lane = laneFor(w, p.x, p.y);
        const axis = localDirToWorld(b, ax, ay);
        // Outside any lot: the stall opens towards the road it is reached from.
        const sign = lane && (lane.x - p.x) * axis.x + (lane.y - p.y) * axis.y < 0 ? -1 : 1;
        out.push({
          id: out.length, building: b.id, x: p.x, y: p.y, ox: axis.x * sign, oy: axis.y * sign,
          depth: el.d, lane, via: [], car: null,
        });
      }
    }
  }
  out.push(...kerbBays(w, out.length));
  return out;
}

/** Ahead of a kerb bay, the place on the lane a car stops at to back in, and leaves for. */
const KERB_AHEAD = m(7);
/** The least a kerb bay's joining point may lie ahead of it, u. */
const KERB_MIN_AHEAD = m(4);
/** No lot: the bay stands on the street. */
const NO_LOT = -1 as BuildingId;

/** Every bay along the kerbs of the streets that park (`RoadSegment.parking`). */
function kerbBays(w: SimWorld, first: number): Bay[] {
  const out: Bay[] = [];
  for (const bay of parkingLayout(w.net).bays) {
    const f = bay.facing;
    const ahead = { x: bay.centre.x + f.x * KERB_AHEAD, y: bay.centre.y + f.y * KERB_AHEAD };
    const lane = laneFor(w, ahead.x, ahead.y, undefined, bay.segment);
    // The lane has to run the way the car faces: the traffic beside the bay;
    // and its joining point (kept `LANE_END` clear of the junctions) must lie
    // ahead of the bay. Near the end of a street it falls behind it, and the
    // car would turn round on the spot, its tail sweeping the footway.
    const aligned = lane !== null && lane.tx * f.x + lane.ty * f.y > 0.7
      && (lane.x - bay.centre.x) * f.x + (lane.y - bay.centre.y) * f.y >= KERB_MIN_AHEAD;
    out.push({
      id: first + out.length, building: NO_LOT, x: bay.centre.x, y: bay.centre.y,
      // The car stands nose along the kerb: `o` points out of its tail.
      ox: -f.x, oy: -f.y, depth: PARKING_PITCH.parallel,
      lane: aligned ? lane : null, via: [], car: null, kerb: true,
    });
  }
  return out;
}

/** Whether a wall's bounds come within a few metres of a lot. */
function near(wl: Wall, b: Building, v: { x: number; y: number; w: number; d: number }): boolean {
  const corners = [localToWorld(b, v.x, v.y), localToWorld(b, v.x + v.w, v.y), localToWorld(b, v.x + v.w, v.y + v.d), localToWorld(b, v.x, v.y + v.d)];
  const pad = m(3);
  const x0 = Math.min(...corners.map((c) => c.x)) - pad, x1 = Math.max(...corners.map((c) => c.x)) + pad;
  const y0 = Math.min(...corners.map((c) => c.y)) - pad, y1 = Math.max(...corners.map((c) => c.y)) + pad;
  return wl.x1 >= x0 && wl.x0 <= x1 && wl.y1 >= y0 && wl.y0 <= y1;
}

/** A way out of a lot: a point inside its street edge, and the lane it joins, clear of every building. */
interface LotExit {
  /** Local frame, a few metres inside the edge. */
  readonly inner: { readonly x: number; readonly y: number };
  /** Local frame, just inside the edge: the line from `inner` to it must be free of fences. */
  readonly edge: { readonly x: number; readonly y: number };
  readonly lane: BayLane;
  /** Distance from the edge to the lane's joining point. */
  readonly out: number;
}

/** Spacing of the points tried along a lot's sides. */
const EXIT_STEP = m(2);
/** Half the width of the swept path a car needs between the lot and its lane. */
const SWEEP = m(1.4);

export interface Wall {
  readonly building: BuildingId;
  readonly ring: readonly { x: number; y: number }[];
  readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number;
}

/** Every building's solid footprint, with its bounds. */
export function wallsOf(w: SimWorld): Wall[] {
  const out: Wall[] = [];
  for (const b of w.doc.buildings.all()) {
    for (const ring of solidFootprints(b)) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      out.push({ building: b.id, ring, x0, y0, x1, y1 });
    }
  }
  return out;
}

/** Whether a car can be driven straight from `a` to `b` without its body touching a building. */
export function clearOfWalls(walls: readonly Wall[], a: { x: number; y: number }, b: { x: number; y: number },
  sweep = SWEEP, except: BuildingId | null = null): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return true;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const near = walls.filter((wl) => wl.building !== except && wl.x1 >= Math.min(a.x, b.x) - sweep && wl.x0 <= Math.max(a.x, b.x) + sweep
    && wl.y1 >= Math.min(a.y, b.y) - sweep && wl.y0 <= Math.max(a.y, b.y) + sweep);
  if (near.length === 0) return true;
  const steps = Math.ceil(len / m(0.8));
  for (let i = 0; i <= steps; i++) {
    const t = (len * i) / steps;
    for (const side of [-sweep, 0, sweep]) {
      const p = { x: a.x + ux * t - uy * side, y: a.y + uy * t + ux * side };
      if (near.some((wl) => p.x >= wl.x0 && p.x <= wl.x1 && p.y >= wl.y0 && p.y <= wl.y1 && pointInPolygon(p, wl.ring))) return false;
    }
  }
  return true;
}

/**
 * The ways out of a lot onto a street: points along its sides from which a car
 * reaches a lane on the lot's kerb side in a straight line without crossing a
 * building. In a town of perimeter blocks, a car park in the middle of a block
 * is left by the passage between the buildings, not through them.
 */
function exitsOf(w: SimWorld, b: Building, v: { x: number; y: number; w: number; d: number }, walls: readonly Wall[]): LotExit[] {
  const sides = [
    { ax: v.x, ay: v.y, dx: 1, dy: 0, nx: 0, ny: -1, length: v.w },
    { ax: v.x + v.w, ay: v.y, dx: 0, dy: 1, nx: 1, ny: 0, length: v.d },
    { ax: v.x, ay: v.y + v.d, dx: 1, dy: 0, nx: 0, ny: 1, length: v.w },
    { ax: v.x, ay: v.y, dx: 0, dy: 1, nx: -1, ny: 0, length: v.d },
  ];
  // Only the lanes that could be near this lot are asked.
  const centre = localToWorld(b, v.x + v.w / 2, v.y + v.d / 2);
  const reach = Math.hypot(v.w, v.d) / 2 + EDGE_REACH + m(10);
  const lanes = [...w.graph.lanelets.values()].filter((lane) => lane.centre.closestPoint(centre).distance < reach);
  const out: LotExit[] = [];
  for (const s of sides) {
    if (s.length < 2 * EDGE_MARGIN + m(1)) continue;
    for (let t = EDGE_MARGIN; t <= s.length - EDGE_MARGIN; t += EXIT_STEP) {
      const edge = localToWorld(b, s.ax + s.dx * t, s.ay + s.dy * t);
      const lane = laneFor(w, edge.x, edge.y, lanes);
      if (!lane) continue;
      const out1 = Math.hypot(lane.x - edge.x, lane.y - edge.y);
      if (out1 > EDGE_REACH) continue;
      const inner = { x: s.ax + s.dx * t - s.nx * EDGE_INSET, y: s.ay + s.dy * t - s.ny * EDGE_INSET };
      if (!clearOfWalls(walls, localToWorld(b, inner.x, inner.y), lane)) continue;
      out.push({ inner, edge: { x: s.ax + s.dx * t - s.nx * m(0.2), y: s.ay + s.dy * t - s.ny * m(0.2) }, lane, out: out1 });
    }
  }
  return out;
}

/** The nearest drivable lane with room to join, its point beside `(x, y)`, on the kerb side. */
function laneFor(w: SimWorld, x: number, y: number, among?: Iterable<Lanelet>, segment?: SegmentId): BayLane | null {
  let best: BayLane | null = null;
  let bestD = LANE_REACH;
  for (const lane of among ?? w.graph.lanelets.values()) {
    if (lane.kind !== 'link' || lane.length < 2 * LANE_END + m(6)) continue;
    if (segment !== undefined && lane.segment !== segment) continue;
    if (w.rt(lane.id).ghost) continue;
    const hit = lane.centre.closestPoint({ x, y });
    if (hit.distance >= bestD) continue;
    const at = Math.max(LANE_END, Math.min(lane.length - LANE_END, hit.s));
    const f = lane.centre.sampleAt(at);
    // Right-hand traffic: the kerb, and the lots beyond it, are on the right of
    // the direction of travel. A lane with the bay on its left is the far one.
    if ((x - f.p.x) * f.t.y - (y - f.p.y) * f.t.x <= 0) continue;
    bestD = hit.distance;
    best = { lanelet: lane.id, at, x: f.p.x, y: f.p.y, tx: f.t.x, ty: f.t.y };
  }
  return best;
}

/** The free bay with a lane nearest `(x, y)` within `reach`, or null. */
export function freeBayNear(bays: readonly Bay[], x: number, y: number, reach: number): Bay | null {
  let best: Bay | null = null;
  let bestD = reach;
  for (const bay of bays) {
    if (bay.car !== null || !bay.lane) continue;
    const d = Math.hypot(bay.x - x, bay.y - y);
    if (d < bestD) { bestD = d; best = bay; }
  }
  return best;
}
