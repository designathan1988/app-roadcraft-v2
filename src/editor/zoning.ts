import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { madeToMeasure } from '@world/buildings/procedural';
import { METERS_PER_UNIT } from '@world/units';
import { furnishLot, lotKind, planLot } from './lotPlan';
import type { Building } from '@world/buildings/types';
import type { SiteContext } from '@world/buildings/validate';
import type { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { ZONE_CELL, ZONE_DEPTH, type ZoneCell, type ZoneGrid } from '@world/zoneGrid';
import type { ZoneDensity, ZoneMark, ZoneUse } from '@world/zones';
import { addBuildingRecord, type placeBuilding } from './buildings';
import { buildingBounds, footprintRects } from '@world/buildings/geometry';
import { pointInPolygon } from '@core/polygon';
import { Level, halfWidth } from '@world/roadTypes';

/**
 * Zoning, the way city builders do it (Cities: Skylines 1 and 2): the player
 * paints the cells of the street grid (`world/zoneGrid.ts`) with a use and a
 * density, and buildings GROW on them over time, one lot at a time, each on
 * whole cells, facing its street. Zoning is a plan for the land, not a stamp
 * that drops a row of houses where the pointer let go.
 */

/** Lot widths in cells, narrowest and widest, by zone. */
const LOT_COLUMNS: Record<ZoneUse, Record<ZoneDensity, readonly [number, number]>> = {
  residential: { low: [1, 2], medium: [2, 3], high: [3, 4] },
  commercial: { low: [1, 2], medium: [2, 3], high: [2, 4] },
  industrial: { low: [2, 4], medium: [3, 5], high: [4, 6] },
};

/**
 * How far a lot may grow on each side, along the street (world units). It
 * walks out from each side edge, at the front, the middle and the back of the
 * lot, until it meets something: a road's footway (the lot reaches it), a
 * building or another zoned lot (the lot reaches it when it is near), or
 * nothing within a cell and a quarter (free land, left for a lot of its own).
 */
function sideReach(
  ctx: SiteContext,
  grid: ZoneGrid,
  marks: Map<string, { mark: ZoneMark; index: number }>,
  anchor: Vec2,
  rotation: number,
  width: number,
  depth: number,
  own: readonly ZoneCell[],
): { left: number; right: number } {
  const { doc, net } = ctx;
  if (!net) return { left: 0, right: 0 };
  const ex = { x: Math.cos(rotation), y: Math.sin(rotation) };
  const ey = { x: -ex.y, y: ex.x };
  const ownIds = new Set(own.map((cell) => cell.id));
  const ribbons = [...net.ribbons.values()].filter((r) => doc.segment(r.id)?.structure === 'ground');
  const near = [...doc.buildings.all()].filter((b) => {
    const bb = buildingBounds(b);
    return Math.hypot((bb.minX + bb.maxX) / 2 - anchor.x, (bb.minY + bb.maxY) / 2 - anchor.y) < width + depth + m(60);
  }).map((b) => footprintRects(b));
  const LIMIT = ZONE_CELL * 1.25, STEP = m(0.25), NEAR = m(3);
  const blocked = (q: Vec2): 'road' | 'thing' | null => {
    for (const r of ribbons) if (r.full.distanceTo(q) < halfWidth(r.road, Level.Sidewalk) - m(0.02)) return 'road';
    for (const rects of near) for (const rect of rects) if (pointInPolygon(q, rect)) return 'thing';
    const cell = grid.cellAt(q);
    if (cell && !ownIds.has(cell.id) && marks.has(cell.id)) return 'thing';
    return null;
  };
  const out = { left: 0, right: 0 };
  for (const [key, sign] of [['left', -1], ['right', 1]] as const) {
    let found: { d: number; what: 'road' | 'thing' } | null = null;
    for (let d = STEP; d <= LIMIT && !found; d += STEP) {
      for (const y of [m(0.3), depth / 2, depth - m(0.3)]) {
        const along = sign * (width / 2 + d);
        const q = { x: anchor.x + ex.x * along + ey.x * y, y: anchor.y + ex.y * along + ey.y * y };
        const what = blocked(q);
        if (what) { found = { d: d - STEP, what }; break; }
      }
    }
    // Up to a neighbour exactly (party wall to party wall); a hair short of a road's footway.
    if (found && (found.what === 'road' || found.d <= NEAR)) out[key] = Math.max(0, found.d - (found.what === 'road' ? m(0.1) : JOINT));
  }
  return out;
}

/** How close a stored mark has to be to a cell's centre to be that cell's. */
/** The joint left between two neighbouring lots: a hair, so their party walls meet without overlapping. */
const JOINT = 0;
const MATCH = ZONE_CELL / 2;

/** The mark standing on a cell, with its index in `doc.zoneMarks`. */
export function markOf(doc: RoadDoc, cell: ZoneCell): { mark: ZoneMark; index: number } | null {
  let best: { mark: ZoneMark; index: number } | null = null;
  let bestD = MATCH;
  doc.zoneMarks.forEach((mark, index) => {
    const d = Math.hypot(mark.x - cell.centre.x, mark.y - cell.centre.y);
    if (d < bestD) { bestD = d; best = { mark, index }; }
  });
  return best;
}

/** Every cell's mark at once (one pass over the marks, not one per cell). */
export function marksByCell(doc: RoadDoc, grid: ZoneGrid): Map<string, { mark: ZoneMark; index: number }> {
  const out = new Map<string, { mark: ZoneMark; index: number }>();
  const dist = new Map<string, number>();
  doc.zoneMarks.forEach((mark, index) => {
    const cell = grid.cellAt(mark) ?? grid.cellsNear(mark, MATCH)[0];
    if (!cell) return;
    const d = Math.hypot(mark.x - cell.centre.x, mark.y - cell.centre.y);
    if (d >= MATCH || d >= (dist.get(cell.id) ?? Infinity)) return;
    dist.set(cell.id, d);
    out.set(cell.id, { mark, index });
  });
  return out;
}

/**
 * The buildings that stand on marks no longer matching what the player wants
 * there go: a cell rezoned or dezoned under a grown building demolishes it,
 * and frees every other cell it stood on.
 */
function demolishGrown(doc: RoadDoc, ids: ReadonlySet<number>): void {
  if (!ids.size) return;
  for (const id of ids) {
    if (doc.buildings.has(id as Parameters<typeof doc.buildings.has>[0])) {
      doc.buildings.remove(id as Parameters<typeof doc.buildings.remove>[0]);
    }
  }
  for (let i = 0; i < doc.zoneMarks.length; i++) {
    const mark = doc.zoneMarks[i] as ZoneMark;
    if (mark.building !== undefined && ids.has(mark.building)) {
      const { building: _gone, ...free } = mark;
      doc.zoneMarks[i] = free;
    }
  }
}

/**
 * Paints cells with a use and density, or clears them (`zone` null). Returns
 * how many cells changed. A cell already zoned the same way keeps its building.
 */
export function paintCells(
  doc: RoadDoc,
  grid: ZoneGrid,
  cells: readonly ZoneCell[],
  zone: { use: ZoneUse; density: ZoneDensity } | null,
): number {
  const marks = marksByCell(doc, grid);
  const doomed = new Set<number>();
  const drop = new Set<number>();
  const add: ZoneMark[] = [];
  let changed = 0;
  for (const cell of cells) {
    const found = marks.get(cell.id);
    if (zone && found && found.mark.use === zone.use && found.mark.density === zone.density) continue;
    if (!zone && !found) continue;
    changed++;
    if (found) {
      drop.add(found.index);
      if (found.mark.building !== undefined) doomed.add(found.mark.building);
    }
    if (zone) add.push({ x: cell.centre.x, y: cell.centre.y, use: zone.use, density: zone.density });
  }
  if (!changed) return 0;
  const kept = doc.zoneMarks.filter((_, index) => !drop.has(index));
  doc.zoneMarks.splice(0, doc.zoneMarks.length, ...kept, ...add);
  demolishGrown(doc, doomed);
  doc.zoneRevision++;
  return changed;
}

/** Every cell of the street side a cell belongs to: the Fill tool's block. */
export function blockOf(grid: ZoneGrid, cell: ZoneCell): ZoneCell[] {
  return grid.cells.filter((other) => other.segment === cell.segment && other.side === cell.side);
}

/**
 * Grows at most one building on the zoned land. Picks the first free lot in a
 * stable order from a seeded walk, so a city zoned the same way grows the same
 * way. Returns the new building's id, or null when nothing could grow.
 *
 * `refused` remembers lots whose building did not fit (a slope, a building the
 * player put there), so a frame is not spent trying them again; the caller
 * clears it when the land changes.
 */
export function growOne(ctx: SiteContext, grid: ZoneGrid, refused: Set<string>, seed: number): number | null {
  // A refused start makes the column after it a start of its own: look again
  // (a few times) rather than report the land full while it is not.
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = refused.size;
    const id = growOnce(ctx, grid, refused, seed);
    if (id !== null || refused.size === before) return id;
  }
  return null;
}

function growOnce(ctx: SiteContext, grid: ZoneGrid, refused: Set<string>, seed: number): number | null {
  const { doc } = ctx;
  if (!doc.zoneMarks.length) return null;
  const marks = marksByCell(doc, grid);
  const standing = (mark: ZoneMark): boolean =>
    mark.building !== undefined && doc.buildings.has(mark.building as Parameters<typeof doc.buildings.has>[0]);
  // Free, zoned front cells: where a lot can start.
  const starts = grid.cells.filter((cell) => {
    if (cell.row !== 0 || refused.has(cell.id)) return false;
    const found = marks.get(cell.id);
    if (!found || standing(found.mark)) return false;
    // Only the first free column of a run: lots then pack from one end of a
    // stretch to the other. Started anywhere, they left single columns between
    // them that no model fits, and the block stayed gappy.
    const before = grid.at(cell.segment, cell.side, cell.column - 1, 0);
    const prev = before && marks.get(before.id);
    return !(prev && !standing(prev.mark) && prev.mark.use === found.mark.use &&
      prev.mark.density === found.mark.density && !refused.has(before!.id));
  });
  if (!starts.length) return null;
  const rng = new Rng((seed ^ Math.imul(doc.buildings.nextId, 0x9e3779b1)) >>> 0);
  // Walk from a random start so growth spreads over the zoned streets.
  const first = rng.int(0, starts.length - 1);
  for (let k = 0; k < starts.length; k++) {
    const start = starts[(first + k) % starts.length] as ZoneCell;
    const zone = marks.get(start.id)!.mark;
    // A model of this zone, picked at random; the lot is as many columns as it
    // is wide, and always the zone's whole depth: what the building does not
    // cover becomes its garden, car park or yard - no zoned cell is left bare.
    // The lot: a width drawn for the zone, as deep as the zoned land goes.
    // Narrower widths are tried when the run is short, down to one column, so
    // no zoned cell is left bare; a building is then made for exactly that lot.
    const [narrow, wide] = LOT_COLUMNS[zone.use][zone.density];
    const want = rng.int(narrow, wide);
    const freeColumn = (column: number, depth: number): ZoneCell[] | null => {
      const cells: ZoneCell[] = [];
      for (let r = 0; r < depth; r++) {
        const cell = grid.at(start.segment, start.side, column, r);
        const found = cell && marks.get(cell.id);
        if (!cell || !found || found.mark.use !== zone.use || found.mark.density !== zone.density || standing(found.mark)) return null;
        cells.push(cell);
      }
      return cells;
    };
    let rows = 0;
    for (let depth = ZONE_DEPTH; depth >= 1 && !rows; depth--) if (freeColumn(start.column, depth)) rows = depth;
    if (!rows) { refused.add(start.id); continue; }
    // The free run from here, at that depth.
    let run = 0;
    while (run < wide + narrow && freeColumn(start.column + run, rows)) run++;
    // Take `want` columns, fewer if the run is short; and if what would be
    // left is narrower than any lot of this zone, take it too.
    let columns = Math.min(want, run);
    if (run - columns > 0 && run - columns < narrow) columns = run;
    // A cell trimmed on the subgrid at a block's end is too narrow for a lot
    // of its own: it goes with the next column, so the end is built on too.
    if (start.width < ZONE_CELL - 1e-6 && columns === 1 && run > 1) columns = 2;
    const lot: ZoneCell[] = [];
    for (let c = 0; c < columns; c++) lot.push(...freeColumn(start.column + c, rows)!);
    const margin = m(0.3);
    // Front middle of the grid lot, and the street's direction there.
    const fronts = lot.filter((cell) => cell.row === 0);
    // Cells trimmed on the 1 m subgrid at a block's edge (`ZoneCell.width`)
    // are part of the lot like any other: its width and its front middle are
    // read off the cells themselves, so no zoned strip is left unbuilt.
    fronts.sort((p, q) => p.column - q.column);
    const firstFront = fronts[0] as ZoneCell, lastFront = fronts[fronts.length - 1] as ZoneCell;
    const gridAnchor = {
      x: (firstFront.corners[0].x + lastFront.corners[1].x) / 2,
      y: (firstFront.corners[0].y + lastFront.corners[1].y) / 2,
    } as Vec2;
    const rotation = (fronts[Math.floor(fronts.length / 2)] as ZoneCell).rotation;
    // The full width of the cells: two lots side by side share their boundary
    // (the player's order of 2026-10-05: "qualquer construção não pode ter
    // vãos"). A margin taken off each side left a strip between neighbours.
    const gridW = fronts.reduce((sum, cell) => sum + cell.width, 0) - JOINT;
    // The land beside the lot that nobody else can use - the strip left at a
    // corner between the grid and the cross street's footway, a gap short of
    // the next building - joins the lot, so no bare strip is left along a
    // footway or between two properties.
    const fullReach = sideReach(ctx, grid, marks, gridAnchor, rotation, gridW, rows * ZONE_CELL - margin, lot);
    const lotD = rows * ZONE_CELL - margin;
    // Built on the widened lot; where that meets a corner's curved footway
    // and is refused, on half the gain, then on the grid lot alone.
    let result: ReturnType<typeof placeBuilding> = { ok: false, problem: 'overlap' } as ReturnType<typeof placeBuilding>;
    for (const k of [1, 0.5, 0]) {
      const reach = { left: fullReach.left * k, right: fullReach.right * k };
      if (k < 1 && fullReach.left + fullReach.right < m(0.5)) break;
      const lotW = gridW + reach.left + reach.right;
      const W = lotW * METERS_PER_UNIT, D = lotD * METERS_PER_UNIT;
      if (W < 4) continue;
      // The lot is planned first - front, sides, back, each for a purpose -
      // and the building is made for the envelope the plan leaves it.
      const plan = planLot(lotKind(zone.use, zone.density), W, D, rng);
      const env = plan.building;
      const made = madeToMeasure(zone.use, zone.density, {
        W: env.x1 - env.x0, D: env.y1 - env.y0,
        backDoor: plan.back.use !== 'none' && plan.back.use !== 'loading',
        character: (Number(start.segment) * 31 + (start.side === 1 ? 7 : 3)) >>> 0,
      }, rng);
      const body = made.body;
      const dx = m(env.x0 - W / 2), dy = m(env.y0);
      for (const v of body.volumes) { v.x += dx; v.y += dy; }
      for (const e of body.elements ?? []) { e.x += dx; e.y += dy; }
      for (const c of body.cores ?? []) { c.x += dx; c.y += dy; }
      // Nothing of the building past its lot's sides: a porch or an annex the
      // maker set a little wide stood into the neighbour's lot, and the
      // neighbour was then refused - the gap the player kept finding.
      for (const v of body.volumes) {
        if (v.outline) continue;
        const x0 = Math.max(v.x, -lotW / 2), x1 = Math.min(v.x + v.w, lotW / 2);
        if (x1 - x0 > m(1)) { v.x = x0; v.w = x1 - x0; }
        // A side standing on the lot's boundary is a party wall: blank, so
        // no shopfront, awning or door faces into the neighbour it joins.
        for (const [face, onEdge] of [[3, v.x <= -lotW / 2 + m(0.6)], [1, v.x + v.w >= lotW / 2 - m(0.6)]] as const) {
          if (!onEdge) continue;
          for (const storey of v.storeys) {
            storey.facade.sides = { ...(storey.facade.sides ?? {}), [face]: 'wall' };
            if (storey.facade.patterns) delete storey.facade.patterns[face];
            if (storey.facade.bays) for (const key of Object.keys(storey.facade.bays)) if (key.startsWith(`${face}:`)) delete storey.facade.bays[key];
          }
        }
      }
      if (!furnishLot(body, plan, made, rng)) continue;
      // The widened lot's front middle - the body's local origin - shifted
      // along the street by half of what one side gained over the other.
      const shift = (reach.right - reach.left) / 2;
      const anchor = { x: gridAnchor.x + Math.cos(rotation) * shift, y: gridAnchor.y + Math.sin(rotation) * shift };
      result = addBuildingRecord(ctx, { ...body, x: anchor.x, y: anchor.y, rotation } as Omit<Building, 'id'>);
      if (result.ok) break;
    }
    if (!result.ok || result.id === undefined) { refused.add(start.id); continue; }
    const id = result.id as number;
    for (const cell of lot) {
      const found = marks.get(cell.id)!;
      doc.zoneMarks[found.index] = { ...found.mark, building: id };
    }
    doc.zoneRevision++;
    return id;
  }
  return null;
}

/**
 * The version of the lot generator (`lotPlan.ts`, the yards, walls and
 * facades of grown buildings). Bumped when it changes; a zoned building grown
 * with an older one is regrown (`regrowStale`), so what the player sees is
 * always the current generator, not the records of an older one.
 */
export const LOT_PLAN_VERSION = 7;

/**
 * Takes down the zoned buildings grown by an older generator and frees their
 * cells, so growth builds them again. At most `limit` at a time, so a city
 * renews over a few seconds instead of all at once. Returns how many went.
 */
export function regrowStale(doc: RoadDoc, limit = 6): number {
  let gone = 0;
  const stale = new Set<number>();
  for (const mark of doc.zoneMarks) {
    if (mark.building === undefined || stale.has(mark.building)) continue;
    const b = doc.buildings.get(mark.building as Parameters<typeof doc.buildings.get>[0]);
    if (b && b.lotPlan !== LOT_PLAN_VERSION) {
      stale.add(mark.building);
      if (stale.size >= limit) break;
    }
  }
  for (const id of stale) {
    if (doc.buildings.remove(id as Parameters<typeof doc.buildings.remove>[0])) gone++;
  }
  doc.zoneMarks.forEach((mark, i) => {
    if (mark.building !== undefined && stale.has(mark.building)) {
      const { building: _b, ...rest } = mark;
      doc.zoneMarks[i] = rest as typeof mark;
    }
  });
  if (gone) doc.zoneRevision++;
  return gone;
}
