import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import type { BlueprintBody } from '@world/buildings/blueprints';
import { cityBuilding } from '@world/buildings/cityBuildings';
import type { BuildingFunction, LotSurface } from '@world/buildings/types';
import type { SiteContext } from '@world/buildings/validate';
import type { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { ZONE_CELL, ZONE_DEPTH, type ZoneCell, type ZoneGrid } from '@world/zoneGrid';
import { ZONE_DENSITIES, type ZoneDensity, type ZoneMark, type ZoneUse } from '@world/zones';
import { placeBuilding } from './buildings';

/**
 * Zoning, the way city builders do it (Cities: Skylines 1 and 2): the player
 * paints the cells of the street grid (`world/zoneGrid.ts`) with a use and a
 * density, and buildings GROW on them over time, one lot at a time, each on
 * whole cells, facing its street. Zoning is a plan for the land, not a stamp
 * that drops a row of houses where the pointer let go.
 */

/**
 * What grows in each zone: the catalog's own models (`cityBuildings.ts`, the
 * Builder's gallery), not a bare box. Several per zone, so a street is not one
 * house repeated; each with its wall colours and, where it has upper floors, its
 * height varied. Models deeper than the zone (a supermarket, a mall) are left
 * to the Builder.
 */
const GROWS: Record<ZoneUse, Record<ZoneDensity, readonly BuildingFunction[]>> = {
  residential: {
    low: ['house', 'house', 'townhouse'],
    medium: ['apartments', 'townhouse', 'apartments'],
    high: ['residentialTower', 'apartments'],
  },
  commercial: {
    low: ['shop', 'pharmacy', 'bakery', 'snackBar', 'bar', 'shop'],
    medium: ['bank', 'restaurant', 'hotel', 'gym', 'shop'],
    high: ['office', 'hotel', 'office'],
  },
  industrial: {
    low: ['warehouse'],
    medium: ['warehouse', 'factory'],
    high: ['factory', 'warehouse'],
  },
};

/** What the land behind a building is laid as: a garden, a car park, a yard. */
const YARD: Record<ZoneUse, LotSurface> = { residential: 'grass', commercial: 'paving', industrial: 'gravel' };

/** Wall colours a zone's buildings are painted in, by finish. */
const WALLS: Record<ZoneUse, readonly number[]> = {
  residential: [0xeae3d6, 0xe8dcc2, 0xf1e4c9, 0xd9c6a8, 0xe6d2c4, 0xcfd8d2, 0xf3f1ec, 0xe9d8b4, 0xd8c9b9],
  commercial: [0xf3f1ec, 0xe8dcc2, 0xdfe3e6, 0xeae3d6, 0xd6d0c4],
  industrial: [0x8f9ba5, 0xa3a9a6, 0x9aa49a, 0xb7b2a6],
};
const ROOFS = [0xb5603f, 0x8f4a35, 0x55595e, 0x6b5a4c, 0x7a3f32];

/** A catalog model's ground footprint, local units. */
function footprintOf(body: BlueprintBody): { x0: number; y0: number; x1: number; y1: number } {
  const v = body.volumes;
  return {
    x0: Math.min(...v.map((q) => q.x)), y0: Math.min(...v.map((q) => q.y)),
    x1: Math.max(...v.map((q) => q.x + q.w)), y1: Math.max(...v.map((q) => q.y + q.d)),
  };
}

/** The model a lot grows, with its colours and height varied. */
function grownBody(fn: BuildingFunction, use: ZoneUse, density: ZoneDensity, rng: Rng): BlueprintBody | null {
  const model = cityBuilding(fn);
  if (!model) return null;
  const body = JSON.parse(JSON.stringify(model.body)) as BlueprintBody;
  const wall = body.materials?.['wall'];
  if (wall) body.materials!['wall'] = { ...wall, colour: rng.pick(WALLS[use]) };
  const roof = body.materials?.['roof'];
  if (roof && use === 'residential') body.materials!['roof'] = { ...roof, colour: rng.pick(ROOFS) };
  body.palette = rng.int(0, 7);
  // A model a little deeper than the zone (the warehouse) is built smaller,
  // down to seven tenths of its size; anything deeper stays the Builder's.
  const box = footprintOf(body);
  const room = ZONE_DEPTH * ZONE_CELL - m(1);
  if (box.y1 - box.y0 > room) {
    const k = room / (box.y1 - box.y0);
    if (k < 0.7) return null;
    for (const v of body.volumes) { v.x *= k; v.y *= k; v.w *= k; v.d *= k; }
    for (const c of (body.cores ?? []) as { x: number; y: number }[]) { c.x *= k; c.y *= k; }
  }
  // Towers and blocks of flats: a few floors more or less, never under three.
  if (fn === 'apartments' || fn === 'residentialTower' || fn === 'office' || fn === 'hotel') {
    const extra = density === 'high' ? rng.int(-1, 6) : rng.int(-2, 1);
    for (const volume of body.volumes) {
      const storeys = volume.storeys as unknown[] | undefined;
      if (!storeys || storeys.length < 3) continue;
      if (extra > 0) for (let i = 0; i < extra; i++) storeys.push(JSON.parse(JSON.stringify(storeys[storeys.length - 1])));
      else storeys.splice(Math.max(3, storeys.length + extra));
    }
  }
  return body;
}

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
    // Every model of the zone in a random order, then those of the lower
    // densities of the same use: the end of a block too narrow for a block of
    // flats still takes a townhouse, so no zoned cell is left bare.
    const order = (list: readonly BuildingFunction[]): BuildingFunction[] => {
      const copy = [...new Set(list)];
      for (let i = copy.length - 1; i > 0; i--) { const j = rng.int(0, i); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; }
      return copy;
    };
    const lower = ZONE_DENSITIES.slice(0, ZONE_DENSITIES.indexOf(zone.density)).reverse();
    const candidates = [...new Set([...order(GROWS[zone.use][zone.density]),
      ...lower.flatMap((density) => order(GROWS[zone.use][density]))])];
    const margin = m(1);
    let lot: ZoneCell[] | null = null;
    let columns = 0, rows = 0;
    let body: BlueprintBody | null = null;
    let box = { x0: 0, y0: 0, x1: 0, y1: 0 };
    for (const fn of candidates) {
      const candidate = grownBody(fn, zone.use, zone.density, rng);
      if (!candidate) continue;
      const b = footprintOf(candidate);
      const wanted = Math.ceil((b.x1 - b.x0 + margin) / ZONE_CELL);
      for (let depth = ZONE_DEPTH; depth >= 1 && !lot; depth--) {
        if (b.y1 - b.y0 > depth * ZONE_CELL - margin) break;
        const cells: ZoneCell[] = [];
        let fits = true;
        for (let c = 0; c < wanted && fits; c++) {
          for (let r = 0; r < depth && fits; r++) {
            const cell = grid.at(start.segment, start.side, start.column + c, r);
            const found = cell && marks.get(cell.id);
            if (!cell || !found || found.mark.use !== zone.use || found.mark.density !== zone.density || standing(found.mark)) fits = false;
            else cells.push(cell);
          }
        }
        if (fits) { lot = cells; columns = wanted; rows = depth; body = candidate; box = b; }
      }
      if (lot) break;
    }
    if (!lot || !body) { refused.add(start.id); continue; }
    // Free columns right after the lot that no model could take on their own
    // (an odd column at the end of a block) join this lot as yard.
    const narrowest = Math.min(...candidates.map((fn) => {
      const model = cityBuilding(fn);
      if (!model) return Infinity;
      const b = footprintOf(model.body);
      return Math.ceil((b.x1 - b.x0 + margin) / ZONE_CELL);
    }));
    const freeColumn = (column: number): ZoneCell[] | null => {
      const cells: ZoneCell[] = [];
      for (let r = 0; r < rows; r++) {
        const cell = grid.at(start.segment, start.side, column, r);
        const found = cell && marks.get(cell.id);
        if (!cell || !found || found.mark.use !== zone.use || found.mark.density !== zone.density || standing(found.mark)) return null;
        cells.push(cell);
      }
      return cells;
    };
    const tail: ZoneCell[][] = [];
    for (let c = start.column + columns; tail.length < narrowest; c++) {
      const cells = freeColumn(c);
      if (!cells) break;
      tail.push(cells);
    }
    if (tail.length > 0 && tail.length < narrowest) {
      for (const cells of tail) lot.push(...cells);
      columns += tail.length;
    }
    // The yard: an open block behind the building, as wide as the lot and to
    // its back edge, so the lot reads as one property.
    const lotW = columns * ZONE_CELL - margin;
    const lotD = rows * ZONE_CELL - margin;
    const midX = (box.x0 + box.x1) / 2;
    const yardDepth = box.y0 + lotD - box.y1;
    if (yardDepth > m(2)) {
      const nextId = Math.max(0, ...body.volumes.map((v) => v.id ?? 0)) + 1;
      body.volumes.push({
        id: nextId, x: midX - lotW / 2, y: box.y1, w: lotW, d: yardDepth, base: 0,
        roof: 'flat', storeys: [{ facade: { fill: 'wall' } }], open: YARD[zone.use],
      } as BlueprintBody['volumes'][number]);
      (body as { nextVolumeId?: number }).nextVolumeId = nextId + 1;
    }
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
