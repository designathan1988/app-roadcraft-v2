import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { generateBody } from '@world/buildings/blueprints';
import type { BuildingFunction, BuildingUse, RoofKind } from '@world/buildings/types';
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

interface ZoneForm {
  readonly function: BuildingFunction;
  /** Lot size in cells: columns along the street, rows deep. */
  readonly columns: number;
  readonly rows: number;
  readonly depth: number;
  readonly floors: readonly [number, number];
  readonly roofs: readonly RoofKind[];
}

const FORMS: Record<ZoneUse, Record<ZoneDensity, ZoneForm>> = {
  residential: {
    low: { function: 'house', columns: 1, rows: 2, depth: 10, floors: [1, 2], roofs: ['gable', 'hip'] },
    medium: { function: 'apartments', columns: 2, rows: 2, depth: 13, floors: [3, 6], roofs: ['flat', 'hip'] },
    high: { function: 'residentialTower', columns: 3, rows: 3, depth: 17, floors: [8, 16], roofs: ['flat', 'terrace'] },
  },
  commercial: {
    low: { function: 'shop', columns: 1, rows: 2, depth: 10, floors: [1, 3], roofs: ['flat', 'hip'] },
    medium: { function: 'office', columns: 2, rows: 2, depth: 15, floors: [4, 8], roofs: ['flat', 'terrace'] },
    high: { function: 'office', columns: 3, rows: 3, depth: 18, floors: [9, 18], roofs: ['flat', 'terrace'] },
  },
  industrial: {
    low: { function: 'warehouse', columns: 2, rows: 2, depth: 15, floors: [1, 1], roofs: ['sawtooth', 'flat'] },
    medium: { function: 'factory', columns: 3, rows: 3, depth: 17, floors: [1, 2], roofs: ['sawtooth', 'flat'] },
    high: { function: 'factory', columns: 3, rows: 4, depth: 22, floors: [2, 4], roofs: ['sawtooth', 'flat'] },
  },
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
  const { doc } = ctx;
  if (!doc.zoneMarks.length) return null;
  const marks = marksByCell(doc, grid);
  const standing = (mark: ZoneMark): boolean =>
    mark.building !== undefined && doc.buildings.has(mark.building as Parameters<typeof doc.buildings.has>[0]);
  // Free, zoned front cells: where a lot can start.
  const starts = grid.cells.filter((cell) => {
    if (cell.row !== 0 || refused.has(cell.id)) return false;
    const found = marks.get(cell.id);
    return !!found && !standing(found.mark);
  });
  if (!starts.length) return null;
  const rng = new Rng((seed ^ Math.imul(doc.buildings.nextId, 0x9e3779b1)) >>> 0);
  // Walk from a random start so growth spreads over the zoned streets.
  const first = rng.int(0, starts.length - 1);
  for (let k = 0; k < starts.length; k++) {
    const start = starts[(first + k) % starts.length] as ZoneCell;
    const zone = marks.get(start.id)!.mark;
    const form = FORMS[zone.use][zone.density];
    // The lot: `columns` x `rows` cells, all zoned alike and free. A dense
    // form that does not fit falls back to a one-column-narrower lot, down to
    // one: a short block still fills.
    let lot: ZoneCell[] | null = null;
    for (let columns = form.columns; columns >= 1 && !lot; columns--) {
      const cells: ZoneCell[] = [];
      let fits = true;
      for (let c = 0; c < columns && fits; c++) {
        for (let r = 0; r < Math.min(form.rows, ZONE_DEPTH) && fits; r++) {
          const cell = grid.at(start.segment, start.side, start.column + c, r);
          const found = cell && marks.get(cell.id);
          if (!cell || !found || found.mark.use !== zone.use || found.mark.density !== zone.density || standing(found.mark)) fits = false;
          else cells.push(cell);
        }
      }
      if (fits) lot = cells;
    }
    if (!lot) { refused.add(start.id); continue; }
    const columns = new Set(lot.map((cell) => cell.column)).size;
    const rows = lot.length / columns;
    // Front middle of the lot, and the street's direction there.
    const fronts = lot.filter((cell) => cell.row === 0);
    const anchor = {
      x: fronts.reduce((s, cell) => s + cell.front.x, 0) / fronts.length,
      y: fronts.reduce((s, cell) => s + cell.front.y, 0) / fronts.length,
    } as Vec2;
    const rotation = (fronts[Math.floor(fronts.length / 2)] as ZoneCell).rotation;
    // The building fills its lot less a margin, so neighbours never touch.
    const width = columns * ZONE_CELL - m(1.5) - m(rng.int(0, 2));
    const depth = Math.min(m(form.depth + rng.int(-1, 1)), rows * ZONE_CELL - m(1.5));
    const body = generateBody(zone.use as BuildingUse, width, depth, rng.int(...form.floors), {
      roof: rng.pick(form.roofs), palette: rng.int(0, 7),
    });
    body.function = form.function;
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
