import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { SegmentId } from './ids';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { Level, halfWidth } from './roadTypes';
import { m } from './units';

/**
 * The zoning grid: the land along every street, cut into cells the player
 * zones and buildings grow on.
 *
 * As in Cities: Skylines, a street makes its own grid: cells of 8 x 8 m, in
 * columns along each side of the road from the back of the footway, up to
 * `ZONE_DEPTH` cells deep, following the road round its curves. Nothing about
 * the grid is stored: it is derived from the roads, so it moves with them. What
 * the player paints is stored by place (`ZoneMark`, `world/zones.ts`) and
 * found again by the cell that stands there.
 *
 * The first version zoned a rectangle aligned with the map's axes: under the
 * isometric camera a square drag became a sliver crossing the road, and the
 * buildings it made all at once overlapped each other.
 */

export const ZONE_CELL = m(8);
export const ZONE_DEPTH = 4;

export interface ZoneCell {
  /** Stable while the road does not change: segment, side, column, row. */
  readonly id: string;
  readonly segment: SegmentId;
  /** +1 left of the segment's a -> b direction, -1 right. */
  readonly side: 1 | -1;
  readonly column: number;
  readonly row: number;
  /** Corners in order: front-start, front-end, back-end, back-start. */
  readonly corners: readonly [Vec2, Vec2, Vec2, Vec2];
  readonly centre: Vec2;
  /** The middle of the cell's front edge, toward the road. */
  readonly front: Vec2;
  /** Rotation a building on this cell is placed with (`placeBuilding`): it faces the road. */
  readonly rotation: number;
}

export interface ZoneGrid {
  readonly cells: readonly ZoneCell[];
  readonly byId: ReadonlyMap<string, ZoneCell>;
  /** Cell at (segment, side, column, row), or undefined where the grid has none. */
  at(segment: SegmentId, side: 1 | -1, column: number, row: number): ZoneCell | undefined;
  /** The cell whose quad holds a world point. */
  cellAt(p: Vec2): ZoneCell | undefined;
  /** Cells whose centre lies within `radius` of a point. */
  cellsNear(p: Vec2, radius: number): ZoneCell[];
}

const key = (segment: SegmentId, side: number, column: number, row: number): string =>
  `${segment}:${side}:${column}:${row}`;

/** Spatial hash bucket edge: one cell. */
const BUCKET = ZONE_CELL;
const bucketKey = (x: number, y: number): string => `${Math.floor(x / BUCKET)},${Math.floor(y / BUCKET)}`;

function insideQuad(p: Vec2, q: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i] as Vec2, b = q[j] as Vec2;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Builds the grid of every ground street that carries pedestrians. */
export function buildZoneGrid(doc: RoadDoc, net: Network): ZoneGrid {
  // What a cell may not sit on: any road's carriageway and footway, at ground.
  const ribbons = [...net.ribbons.values()].filter((r) => doc.segment(r.id)?.structure === 'ground');
  const reachOf = new Map(ribbons.map((r) => [r.id, halfWidth(r.road, Level.Sidewalk)]));
  const onRoad = (p: Vec2): boolean => {
    for (const r of ribbons) {
      const reach = reachOf.get(r.id) as number;
      const bb = r.full.bbox;
      if (p.x < bb.minX - reach || p.x > bb.maxX + reach || p.y < bb.minY - reach || p.y > bb.maxY + reach) continue;
      if (r.full.distanceTo(p) < reach - m(0.05)) return true;
    }
    return false;
  };
  // Junction plates: a disc round every junction as wide as its widest mouth.
  const plates: { p: Vec2; r: number }[] = [];
  for (const node of doc.nodes.values()) {
    if (node.incident.length < 3) continue;
    let r = 0;
    for (const s of node.incident) {
      const ribbon = net.ribbons.get(s);
      r = Math.max(r, net.mouthDistance(s, node.id) + (ribbon ? halfWidth(ribbon.road, Level.Sidewalk) : 0));
    }
    plates.push({ p: { x: node.x, y: node.y }, r });
  }
  const onPlate = (p: Vec2): boolean => plates.some((plate) => Math.hypot(p.x - plate.p.x, p.y - plate.p.y) < plate.r);

  const cells: ZoneCell[] = [];
  const byId = new Map<string, ZoneCell>();
  const buckets = new Map<string, ZoneCell[]>();
  const taken = (centre: Vec2): boolean => {
    const bx = Math.floor(centre.x / BUCKET), by = Math.floor(centre.y / BUCKET);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const other of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
        if (Math.hypot(other.centre.x - centre.x, other.centre.y - centre.y) < ZONE_CELL * 0.7) return true;
        if (insideQuad(centre, other.corners)) return true;
      }
    }
    return false;
  };

  const ids = [...doc.segments.keys()].sort((a, b) => a - b);
  for (const segId of ids) {
    const seg = doc.requireSegment(segId);
    const ribbon = net.ribbons.get(segId);
    if (!ribbon || seg.structure !== 'ground' || !carriesPedestrians(ribbon.road)) continue;
    const line = ribbon.full;
    const length = line.length;
    // The grid starts clear of each end's junction mouth.
    const start = net.mouthDistance(segId, seg.a);
    const end = length - net.mouthDistance(segId, seg.b);
    const columns = Math.floor((end - start) / ZONE_CELL);
    if (columns < 1) continue;
    // Centre the columns between the two mouths.
    const s0 = start + ((end - start) - columns * ZONE_CELL) / 2;
    const face = halfWidth(ribbon.road, Level.Sidewalk);
    const frame = (s: number) => {
      const f = line.sampleAt(Math.max(0, Math.min(length, s)));
      return { p: f.p, t: f.t };
    };
    for (const side of [1, -1] as const) {
      for (let c = 0; c < columns; c++) {
        const a = frame(s0 + c * ZONE_CELL), b = frame(s0 + (c + 1) * ZONE_CELL), mid = frame(s0 + (c + 0.5) * ZONE_CELL);
        const na = { x: -a.t.y * side, y: a.t.x * side };
        const nb = { x: -b.t.y * side, y: b.t.x * side };
        const nm = { x: -mid.t.y * side, y: mid.t.x * side };
        for (let row = 0; row < ZONE_DEPTH; row++) {
          const d0 = face + row * ZONE_CELL, d1 = d0 + ZONE_CELL;
          const corners: [Vec2, Vec2, Vec2, Vec2] = [
            { x: a.p.x + na.x * d0, y: a.p.y + na.y * d0 },
            { x: b.p.x + nb.x * d0, y: b.p.y + nb.y * d0 },
            { x: b.p.x + nb.x * d1, y: b.p.y + nb.y * d1 },
            { x: a.p.x + na.x * d1, y: a.p.y + na.y * d1 },
          ];
          const centre = { x: mid.p.x + nm.x * (d0 + d1) / 2, y: mid.p.y + nm.y * (d0 + d1) / 2 };
          // A column stops at the first cell that cannot be land: a road, a
          // junction plate or another street's cell. Its deeper rows would be
          // cut off from the road.
          if (onRoad(centre) || corners.some(onRoad) || onPlate(centre) || taken(centre)) break;
          const front = { x: mid.p.x + nm.x * d0, y: mid.p.y + nm.y * d0 };
          const cell: ZoneCell = {
            id: key(segId, side, c, row), segment: segId, side, column: c, row,
            corners, centre, front, rotation: Math.atan2(mid.t.y, mid.t.x) + (side === 1 ? 0 : Math.PI),
          };
          cells.push(cell);
          byId.set(cell.id, cell);
          const k = bucketKey(centre.x, centre.y);
          let bucket = buckets.get(k);
          if (!bucket) buckets.set(k, bucket = []);
          bucket.push(cell);
        }
      }
    }
  }

  return {
    cells,
    byId,
    at: (segment, side, column, row) => byId.get(key(segment, side, column, row)),
    cellAt(p) {
      const bx = Math.floor(p.x / BUCKET), by = Math.floor(p.y / BUCKET);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const cell of buckets.get(`${bx + dx},${by + dy}`) ?? []) if (insideQuad(p, cell.corners)) return cell;
      }
      return undefined;
    },
    cellsNear(p, radius) {
      const out: ZoneCell[] = [];
      const span = Math.ceil(radius / BUCKET) + 1;
      const bx = Math.floor(p.x / BUCKET), by = Math.floor(p.y / BUCKET);
      for (let dx = -span; dx <= span; dx++) for (let dy = -span; dy <= span; dy++) {
        for (const cell of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
          if (Math.hypot(cell.centre.x - p.x, cell.centre.y - p.y) <= radius) out.push(cell);
        }
      }
      return out;
    },
  };
}
