import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { SegmentId } from './ids';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { Level, halfWidth } from './roadTypes';
import { m } from './units';
import { GRID_CELL } from './grid';
import { insideMulti, onFootway, poleLines, type PoleLines } from './poleLines';

/** Whether a point is on the kerbed carriageway (inside a kerb). */
function insidePaving(lines: PoleLines, p: Vec2): boolean {
  return insideMulti(p, lines.kerbed);
}

/**
 * The zoning grid: the land along every street, cut into cells the player
 * zones and buildings grow on.
 *
 * As in Cities: Skylines, a street makes its own grid: cells of 10 x 10 m
 * (one cell of the universal grid, `grid.ts`), in
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

export const ZONE_CELL = GRID_CELL;
export const ZONE_DEPTH = 4;
/** The subgrid a cell is trimmed on where a whole cell does not fit (1 m). */
export const SUB_CELL = m(1);

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
  /** Width along the street: `ZONE_CELL`, or less for a cell trimmed on the 1 m subgrid. */
  readonly width: number;
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
  const steps = zoneGridSteps(doc, net);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * `buildZoneGrid` a street at a time: it yields after each street, so the
 * grid can be laid over several frames (the overlay keeps the last one until
 * this is done) instead of in one stall after every road edit. The answer is
 * the same grid; the document and the network must not change meanwhile.
 */
export function* zoneGridSteps(doc: RoadDoc, net: Network): Generator<void, ZoneGrid> {
  // What a cell may not sit on: any road's carriageway and footway, at ground.
  const ribbons = [...net.ribbons.values()].filter((r) => doc.segment(r.id)?.structure === 'ground');
  const reachOf = new Map(ribbons.map((r) => [r.id, halfWidth(r.road, Level.Sidewalk)]));
  // The ribbons bucketed by their reach, so a point is measured against the
  // few streets near it, not every street in the town.
  const ROAD_CELL = m(25);
  const roadBuckets = new Map<string, typeof ribbons>();
  for (const r of ribbons) {
    const reach = reachOf.get(r.id) as number;
    const bb = r.full.bbox;
    for (let bx = Math.floor((bb.minX - reach) / ROAD_CELL); bx <= Math.floor((bb.maxX + reach) / ROAD_CELL); bx++) {
      for (let by = Math.floor((bb.minY - reach) / ROAD_CELL); by <= Math.floor((bb.maxY + reach) / ROAD_CELL); by++) {
        const k = `${bx},${by}`;
        let list = roadBuckets.get(k);
        if (!list) roadBuckets.set(k, list = []);
        list.push(r);
      }
    }
  }
  const onRoad = (p: Vec2): boolean => {
    for (const r of roadBuckets.get(`${Math.floor(p.x / ROAD_CELL)},${Math.floor(p.y / ROAD_CELL)}`) ?? []) {
      const reach = reachOf.get(r.id) as number;
      const bb = r.full.bbox;
      if (p.x < bb.minX - reach || p.x > bb.maxX + reach || p.y < bb.minY - reach || p.y > bb.maxY + reach) continue;
      if (r.full.distanceTo(p) < reach - m(0.05)) return true;
    }
    return false;
  };
  // The paving as drawn - carriageways, kerbs, footways and every junction's
  // corners - so a cell comes right up to the footway's back edge and round
  // the corner of the block. A disc round each junction (as wide as its
  // widest mouth) used to stand in for the junction, and took a bite out of
  // every block corner: the zones stopped short of the corners, broken.
  const lines = poleLines(net);
  const onPlate = (p: Vec2): boolean => onFootway(net, p) || insidePaving(lines, p);
  const cells: ZoneCell[] = [];
  const byId = new Map<string, ZoneCell>();
  const buckets = new Map<string, ZoneCell[]>();
  /** Corners pulled a little toward the centre: cells that only share an edge do not overlap. */
  const shrunk = (corners: readonly Vec2[], centre: Vec2): Vec2[] =>
    corners.map((q) => ({ x: q.x + (centre.x - q.x) * 0.15, y: q.y + (centre.y - q.y) * 0.15 }));
  /**
   * Whether a cell would overlap one already laid - by any amount, not only
   * when the centres nearly meet. Two streets' grids meeting at a block's
   * corner used to keep cells overlapping by a third or a half, and the
   * corner of every block read as two grids drawn over each other.
   */
  const taken = (centre: Vec2, corners: readonly Vec2[]): boolean => {
    const mine = shrunk(corners, centre);
    const bx = Math.floor(centre.x / BUCKET), by = Math.floor(centre.y / BUCKET);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      for (const other of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
        if (Math.hypot(other.centre.x - centre.x, other.centre.y - centre.y) > ZONE_CELL * 1.5) continue;
        if (insideQuad(centre, other.corners) || insideQuad(other.centre, corners)) return true;
        if (mine.some((q) => insideQuad(q, other.corners))) return true;
        if (shrunk(other.corners, other.centre).some((q) => insideQuad(q, corners))) return true;
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
    // Columns along the whole street, centred on it; those that reach into a
    // junction are refused cell by cell against the paving, so the grid runs
    // up to the corner of each block instead of stopping at the mouth.
    const columns = Math.floor(length / ZONE_CELL);
    if (columns < 1) continue;
    const s0 = (length - columns * ZONE_CELL) / 2;
    const face = halfWidth(ribbon.road, Level.Sidewalk);
    const frame = (s: number) => {
      const f = line.sampleAt(Math.max(0, Math.min(length, s)));
      return { p: f.p, t: f.t };
    };
    /** The cell over [sa, sb] along the street at `row`, or null where it cannot be land. */
    const cellOver = (side: 1 | -1, column: number, row: number, sa: number, sb: number): ZoneCell | null => {
      const a = frame(sa), b = frame(sb), mid = frame((sa + sb) / 2);
      const na = { x: -a.t.y * side, y: a.t.x * side };
      const nb = { x: -b.t.y * side, y: b.t.x * side };
      const nm = { x: -mid.t.y * side, y: mid.t.x * side };
      const d0 = face + row * ZONE_CELL, d1 = d0 + ZONE_CELL;
      const corners: [Vec2, Vec2, Vec2, Vec2] = [
        { x: a.p.x + na.x * d0, y: a.p.y + na.y * d0 },
        { x: b.p.x + nb.x * d0, y: b.p.y + nb.y * d0 },
        { x: b.p.x + nb.x * d1, y: b.p.y + nb.y * d1 },
        { x: a.p.x + na.x * d1, y: a.p.y + na.y * d1 },
      ];
      const centre = { x: mid.p.x + nm.x * (d0 + d1) / 2, y: mid.p.y + nm.y * (d0 + d1) / 2 };
      const edgeMids = corners.map((corner, i) => {
        const next = corners[(i + 1) % 4]!;
        return { x: (corner.x + next.x) / 2, y: (corner.y + next.y) / 2 };
      });
      // Tested a tenth of the way in, so a cell whose edge lies along the
      // paving's edge (as the front row's does) is not refused for it.
      const inset = (q: Vec2): Vec2 => ({ x: q.x + (centre.x - q.x) * 0.1, y: q.y + (centre.y - q.y) * 0.1 });
      if (onRoad(centre) || corners.map(inset).some(onRoad) || onPlate(centre) ||
        [...corners, ...edgeMids].some((q) => onPlate(inset(q))) || taken(centre, corners)) return null;
      const front = { x: mid.p.x + nm.x * d0, y: mid.p.y + nm.y * d0 };
      return {
        id: key(segId, side, column, row), segment: segId, side, column, row,
        corners, centre, front, rotation: Math.atan2(mid.t.y, mid.t.x) + (side === 1 ? 0 : Math.PI),
        width: sb - sa,
      };
    };
    const lay = (cell: ZoneCell): void => {
      cells.push(cell);
      byId.set(cell.id, cell);
      const k = bucketKey(cell.centre.x, cell.centre.y);
      let bucket = buckets.get(k);
      if (!bucket) buckets.set(k, bucket = []);
      bucket.push(cell);
    };
    // The regular 10 m columns, then a partial column at each end of the
    // street for what is left before the junction.
    const spans: { column: number; sa: number; sb: number }[] = [];
    for (let c = 0; c < columns; c++) spans.push({ column: c, sa: s0 + c * ZONE_CELL, sb: s0 + (c + 1) * ZONE_CELL });
    if (s0 >= SUB_CELL) spans.unshift({ column: -1, sa: 0, sb: s0 });
    if (length - (s0 + columns * ZONE_CELL) >= SUB_CELL) spans.push({ column: columns, sa: s0 + columns * ZONE_CELL, sb: length });
    for (const side of [1, -1] as const) {
      for (const { column, sa, sb } of spans) {
        for (let row = 0; row < ZONE_DEPTH; row++) {
          // A cell that does not fit whole is trimmed on the 1 m subgrid, from
          // whichever end is in the way, down to a single metre: the grid then
          // reaches the footway and the corner of the block with no gap.
          let cell = cellOver(side, column, row, sa, sb);
          for (let k = 1; !cell && sb - sa - k * SUB_CELL >= SUB_CELL - 1e-6; k++) {
            cell = cellOver(side, column, row, sa + k * SUB_CELL, sb) ?? cellOver(side, column, row, sa, sb - k * SUB_CELL);
          }
          // A column stops at its first refused cell: a deeper row with the
          // front one missing would float away from the street.
          if (!cell) break;
          lay(cell);
        }
      }
    }
    yield;
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
