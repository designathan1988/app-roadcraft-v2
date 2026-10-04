import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { madeToMeasure } from '@world/buildings/procedural';
import { METERS_PER_UNIT } from '@world/units';
import { dressLot } from './lotDressing';
import type { SiteContext } from '@world/buildings/validate';
import type { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { ZONE_CELL, ZONE_DEPTH, type ZoneCell, type ZoneGrid } from '@world/zoneGrid';
import type { ZoneDensity, ZoneMark, ZoneUse } from '@world/zones';
import { placeBuilding } from './buildings';

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

/** How close a stored mark has to be to a cell's centre to be that cell's. */
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
    const lot: ZoneCell[] = [];
    for (let c = 0; c < columns; c++) lot.push(...freeColumn(start.column + c, rows)!);
    const margin = m(0.3);
    const lotW = columns * ZONE_CELL - margin;
    const lotD = rows * ZONE_CELL - margin;
    // A building made for the lot, leaving room for its setback and yard.
    const roomW = (lotW - (zone.use === 'residential' && zone.density === 'low' ? m(1.5) : m(0.6))) * METERS_PER_UNIT;
    const roomD = Math.max(5, (lotD - m(zone.use === 'commercial' ? 4 : 8)) * METERS_PER_UNIT);
    if (roomW < 4) { refused.add(start.id); continue; }
    const made = madeToMeasure(zone.use, zone.density, roomW, roomD, rng);
    const body = made.body;
    body.function = made.fn;
    if (!dressLot(body, zone.use, zone.density, lotW, lotD, rng)) { refused.add(start.id); continue; }
    // Front middle of the lot, and the street's direction there.
    const fronts = lot.filter((cell) => cell.row === 0);
    const anchor = {
      x: fronts.reduce((s, cell) => s + cell.front.x, 0) / fronts.length,
      y: fronts.reduce((s, cell) => s + cell.front.y, 0) / fronts.length,
    } as Vec2;
    const rotation = (fronts[Math.floor(fronts.length / 2)] as ZoneCell).rotation;
    const result = placeBuilding(ctx, body, anchor, rotation);
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
