import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { type Signature, bodySignature, madeToMeasure, signatureDistance } from '@world/buildings/procedural';
import { METERS_PER_UNIT } from '@world/units';
import { furnishLot, lotKind, planLot } from './lotPlan';
import { MAX_ELEMENTS, type Building, type BuildingElement, type Volume } from '@world/buildings/types';
import type { SiteContext } from '@world/buildings/validate';
import type { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { ZONE_CELL, ZONE_DEPTH, type ZoneCell, type ZoneGrid } from '@world/zoneGrid';
import type { ZoneDensity, ZoneMark, ZoneUse } from '@world/zones';
import { lotCentre, lotFrame } from '@world/lots';
import { addBuildingRecord, type placeBuilding } from './buildings';
import { buildingBounds, footprintRects } from '@world/buildings/geometry';
import { pointInPolygon } from '@core/polygon';
import { Level, halfWidth } from '@world/roadTypes';
import { rectAround, type ChangeRect } from '@world/changes';
import { groundElements } from '@world/buildings/elements';
import { overlapArea } from '@world/buildings/footprints';

const BOUNDARY_PARTS = new Set(['wall', 'fence', 'hedge', 'railing']);

/**
 * A grown building added, its boundary meeting the neighbours': where a
 * piece of its wall or fence stands against a neighbour's own building or
 * boundary - the neighbour's wall already closes that stretch, as on any
 * party line - the piece is left out and the building added again. The
 * boundary is closed whole on the lot's own side (`lotPlan.ts`), and a
 * neighbour standing on the line was refused the whole building for it.
 */
function addPlaced(ctx: SiteContext, record: Omit<Building, 'id'>): ReturnType<typeof placeBuilding> {
  const first = addBuildingRecord(ctx, record);
  if (first.ok || first.problem !== 'building') return first;
  const probe = { ...record, id: -1 } as unknown as Building;
  const box = buildingBounds(probe, m(2));
  const theirs: Vec2[][] = [];
  for (const o of ctx.doc.buildings.all()) {
    const ob = buildingBounds(o);
    if (ob.minX > box.maxX || ob.maxX < box.minX || ob.minY > box.maxY || ob.maxY < box.minY) continue;
    theirs.push(...footprintRects(o), ...groundElements(o));
  }
  const elements = (record.elements ?? []).filter((e) => {
    if (!BOUNDARY_PARTS.has(e.kind)) return true;
    const ring = groundElements({ ...probe, elements: [e] }, -m(0.05))[0];
    return !ring || !theirs.some((c) => overlapArea(ring, c) > 1e-5);
  });
  if (elements.length === (record.elements ?? []).length) return first;
  return addBuildingRecord(ctx, { ...record, elements });
}

/**
 * Where these zone cells lie, for the diary (`RoadDoc.zonesChanged`): only
 * that region is marked as changed, the whole map when there is none.
 */
function cellRects(points: readonly Vec2[]): readonly ChangeRect[] | null {
  const rect = rectAround(points, ZONE_CELL);
  return rect ? [rect] : null;
}

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
  const touched: Vec2[] = [...add, ...[...drop].map((index) => doc.zoneMarks[index]!)];
  const kept = doc.zoneMarks.filter((_, index) => !drop.has(index));
  doc.zoneMarks.splice(0, doc.zoneMarks.length, ...kept, ...add);
  demolishGrown(doc, doomed);
  doc.zonesChanged(cellRects(touched), zone ? 'zona pintada' : 'zona apagada');
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
      result = addPlaced(ctx, { ...body, x: anchor.x, y: anchor.y, rotation } as Omit<Building, 'id'>);
      if (result.ok) break;
    }
    if (!result.ok || result.id === undefined) { refused.add(start.id); continue; }
    const id = result.id as number;
    for (const cell of lot) {
      const found = marks.get(cell.id)!;
      doc.zoneMarks[found.index] = { ...found.mark, building: id };
    }
    doc.zonesChanged(cellRects(lot.map((cell) => cell.centre)), 'prédio cresceu na zona');
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
export const LOT_PLAN_VERSION = 11;

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
  const freed: Vec2[] = [];
  doc.zoneMarks.forEach((mark, i) => {
    if (mark.building !== undefined && stale.has(mark.building)) {
      const { building: _b, ...rest } = mark;
      doc.zoneMarks[i] = rest as typeof mark;
      freed.push(mark);
    }
  });
  if (gone) doc.zonesChanged(cellRects(freed), 'prédios antigos refeitos');
  return gone;
}

/**
 * Grows one building on a zoned lot without one (`world/lots.ts`): the lot is
 * planned first - front, sides, back - and the building made for the envelope
 * the plan leaves, as on a grid lot (`growOnce`), but on the lot the player
 * drew: its front middle, its facing, its width and depth.
 */
/** Candidates made for a lot, the least like its neighbours kept (Mitchell's best candidate). */
const CANDIDATES = 4;
/** How far round a lot the buildings it should not look like are read. */
const LIKE_REACH = m(90);
/** How near the last building grown an open lot must be to grow next (the street filling along). */
const GROW_ON_REACH = m(70);

/** Each record's signature, worked out once (a record is replaced when its building changes). */
const SIGNATURES = new WeakMap<Building, Signature>();
const signatureOfRecord = (b: Building): Signature => {
  let s = SIGNATURES.get(b);
  if (!s) SIGNATURES.set(b, s = bodySignature(b));
  return s;
};

/** The buildings round a point: each one's signature and how far it stands. */
function nearSignatures(doc: RoadDoc, at: Vec2): { signature: Signature; distance: number }[] {
  const out: { signature: Signature; distance: number }[] = [];
  for (const b of doc.buildings.all()) {
    const d = Math.hypot(b.x - at.x, b.y - at.y);
    if (d < LIKE_REACH) out.push({ signature: signatureOfRecord(b), distance: d });
  }
  return out;
}

/**
 * How unlike its surroundings a building would be: its least distance in
 * looks to any of them, a building farther away counting as more unlike
 * (a twin across the town is no twin).
 */
function unlikeness(body: Building | Omit<Building, 'id' | 'x' | 'y' | 'rotation'>, near: readonly { signature: Signature; distance: number }[]): number {
  const mine = bodySignature(body);
  let least = Infinity;
  for (const n of near) least = Math.min(least, signatureDistance(mine, n.signature) + 2.5 * (n.distance / LIKE_REACH));
  return least;
}

/** Storeys of the buildings beside a lot's front (within its width and a little), tallest block each. */
function neighbourStoreys(doc: RoadDoc, anchor: Vec2, width: number): number[] {
  const out: number[] = [];
  for (const b of doc.buildings.all()) {
    if (Math.hypot(b.x - anchor.x, b.y - anchor.y) > width + m(12)) continue;
    const top = Math.max(0, ...b.volumes.filter((v) => !v.open).map((v) => v.base + v.storeys.length));
    if (top > 0) out.push(top);
  }
  return out;
}

/** Where the building grown last stands (the highest id grown on a lot), or null. */
function lastGrown(doc: RoadDoc): Vec2 | null {
  let best: Building | null = null;
  for (const l of doc.lots) {
    if (l.building === undefined) continue;
    const b = doc.buildings.get(l.building as Parameters<typeof doc.buildings.get>[0]);
    if (b && (!best || b.id > best.id)) best = b;
  }
  return best ? { x: best.x, y: best.y } : null;
}

export function growOnLot(ctx: SiteContext, refused: Set<number>, seed: number): number | null {
  const { doc } = ctx;
  const standing = (b: number | undefined): boolean => b !== undefined && doc.buildings.has(b as Parameters<typeof doc.buildings.has>[0]);
  const open = doc.lots.filter((l) => l.use && !standing(l.building) && !refused.has(l.id));
  if (!open.length) return null;
  const rng = new Rng((seed ^ Math.imul(doc.buildings.nextId, 0x9e3779b1)) >>> 0);
  // The street fills along: the open lot nearest the last building grown,
  // when one is near (the player sees the street they zoned fill in, one
  // house after the next); anywhere else, a lot at random.
  let lot = open[rng.int(0, open.length - 1)]!;
  const last = lastGrown(doc);
  if (last) {
    let best = GROW_ON_REACH;
    for (const l of open) {
      const c = lotCentre(l);
      const d = Math.hypot(c.x - last.x, c.y - last.y);
      if (d < best) { best = d; lot = l; }
    }
  }
  const use = lot.use!;
  const frame = lotFrame(lot);
  // Every zoned lot gets a building, whatever its size or shape (the player,
  // 2026-10-05: "tem que aparecer sempre"). The building first made for the
  // whole lot; refused (its front over a corner's curved footway, a side over
  // a neighbour, a slope), it is made again set back from the front and the
  // sides, then narrower and shallower, then a density lower - until one fits.
  const u = { x: Math.cos(frame.rotation), y: Math.sin(frame.rotation) }, n = { x: -u.y, y: u.x };
  const densities: ZoneDensity[] = lot.density === 'high' ? ['high', 'medium', 'low'] : lot.density === 'medium' ? ['medium', 'low'] : ['low'];
  // A handful of tries, each a building made: a few milliseconds apiece.
  const tries = [
    { front: 0, side: 0, shrink: 1 }, { front: m(1.5), side: 0, shrink: 1 }, { front: m(3), side: m(1), shrink: 0.9 },
    { front: m(3), side: m(1), shrink: 0.75 }, { front: m(4), side: m(1.5), shrink: 0.6 }, { front: m(4), side: m(1.5), shrink: 0.45 },
  ];
  for (const density of densities) for (const t of tries) {
    const lotW = (frame.width - JOINT - 2 * t.side) * t.shrink;
    const lotD = (frame.depth - m(0.3) - t.front) * t.shrink;
    const W = lotW * METERS_PER_UNIT, D = lotD * METERS_PER_UNIT;
    if (W < 4 || D < 4) continue;
    const plan = planLot(lotKind(use, density), W, D, rng);
    const env = plan.building;
    const driveSide = plan.left.use === 'drive' || plan.left.use === 'drivePath' ? 'left' as const
      : plan.right.use === 'drive' || plan.right.use === 'drivePath' ? 'right' as const : undefined;
    const envelope = {
      W: env.x1 - env.x0, D: env.y1 - env.y0,
      backDoor: plan.back.use !== 'none' && plan.back.use !== 'loading',
      character: (lot.id * 31) >>> 0,
      ...(driveSide ? { driveSide } : {}),
      neighbours: neighbourStoreys(doc, frame.anchor, frame.width),
    };
    // Of a few candidates, the one least like the buildings round it
    // (Mitchell's best candidate, in the space of what a building looks
    // like): drawn at random, a street still came out with twins side by side.
    const near = nearSignatures(doc, frame.anchor);
    let made = madeToMeasure(use, density, envelope, rng);
    if (near.length) {
      let score = unlikeness(made.body, near);
      for (let k = 1; k < CANDIDATES; k++) {
        const other = madeToMeasure(use, density, envelope, rng);
        const s = unlikeness(other.body, near);
        if (s > score) { score = s; made = other; }
      }
    }
    const body = made.body;
    const dx = m(env.x0 - W / 2), dy = m(env.y0);
    for (const v of body.volumes) { v.x += dx; v.y += dy; }
    for (const e of body.elements ?? []) { e.x += dx; e.y += dy; }
    for (const c of body.cores ?? []) { c.x += dx; c.y += dy; }
    for (const v of body.volumes) {
      if (v.outline) continue;
      const x0 = Math.max(v.x, -lotW / 2), x1 = Math.min(v.x + v.w, lotW / 2);
      if (x1 - x0 > m(1)) { v.x = x0; v.w = x1 - x0; }
    }
    // The lot's front middle, set back by the try's front margin.
    const anchor = { x: frame.anchor.x + n.x * t.front, y: frame.anchor.y + n.y * t.front };
    // How the land falls or rises from the street to the middle of the back
    // yard, metres: a yard on a hillside is terraced (`furnishLot`).
    const ground = ctx.groundAt;
    const yardY = m(D - plan.back.depth / 2);
    const hill = ground && plan.back.depth > 0
      ? { yard: (ground(anchor.x + n.x * yardY, anchor.y + n.y * yardY) - ground(anchor.x + n.x * m(0.5), anchor.y + n.y * m(0.5))) * METERS_PER_UNIT }
      : undefined;
    if (!furnishLot(body, plan, made, rng, hill)) continue;
    // The lot in the building's frame: x along the front, y back into it.
    const ring = lot.corners.map((c) => ({ x: (c.x - anchor.x) * u.x + (c.y - anchor.y) * u.y, y: (c.x - anchor.x) * n.x + (c.y - anchor.y) * n.y }));
    fitToLot(body, ring);
    const result = addPlaced(ctx, { ...body, x: anchor.x, y: anchor.y, rotation: frame.rotation } as Omit<Building, 'id'>);
    if (!result.ok || result.id === undefined) continue;
    const at = doc.lots.findIndex((l) => l.id === lot.id);
    doc.lots[at] = { ...lot, building: result.id as number };
    const where = rectAround(lot.corners);
    doc.lotsChanged(where ? [where] : null, 'prédio cresceu no lote');
    return result.id as number;
  }
  refused.add(lot.id);
  return null;
}


const BOUNDARY_KINDS = new Set(['wall', 'fence', 'hedge', 'railing', 'gate']);

/**
 * A grown building made to its lot's own shape (the player, 2026-10-05: "as
 * construções devem seguir o formato dos lotes"). The plan was laid on the
 * lot's front rectangle; on a lot of another shape - a polygon, a curved
 * side, a lot narrowing or widening at the back:
 * - the ground of the whole lot is laid as a lawn (an open block with the
 *   lot's own outline), the plan's surfaces clipped to the lot over it;
 * - the boundary (walls, fences, hedges) is taken off the rectangle and run
 *   along the lot's own sides, all but the front;
 * - whatever of the plan falls outside the lot (a tree, a shed, a bench, a
 *   surface) is left out.
 * A rectangular lot is left as planned.
 */
function fitToLot(body: { volumes: Volume[]; elements?: BuildingElement[] }, ring: readonly Vec2[]): void {
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let area = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i]!, q = ring[(i + 1) % ring.length]!; area += p.x * q.y - q.x * p.y; }
  if (ring.length === 4 && Math.abs(area / 2) > (x1 - x0) * (y1 - y0) * 0.97) return;
  const inside = (p: Vec2): boolean => pointInPolygon(p, ring as Vec2[]);
  const elements = (body.elements ??= []);
  // The boundary's kind and height, from the plan's own.
  const old = elements.filter((e) => BOUNDARY_KINDS.has(e.kind) && e.kind !== 'gate');
  const front = elements.filter((e) => BOUNDARY_KINDS.has(e.kind) && Math.abs(e.y) < m(1.2));
  const kind = (old.find((e) => Math.abs(e.y) >= m(1.2))?.kind ?? old[0]?.kind ?? 'fence') as BuildingElement['kind'];
  const height = old.find((e) => e.kind === kind)?.h ?? m(1.4);
  const thick = kind === 'fence' ? m(0.12) : kind === 'hedge' ? m(0.7) : m(0.2);
  // Everything off the lot, and the side and back boundary, out.
  const kept = elements.filter((e) => (front.includes(e)) || (!BOUNDARY_KINDS.has(e.kind) && inside({ x: e.x, y: e.y })));
  let nextId = Math.max(0, ...elements.map((e) => e.id)) + 1;
  // The new boundary along every side but the front (side 0), in pieces of 20 m at most.
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < m(0.5)) continue;
    const pieces = Math.ceil(len / m(20));
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    // Set in by half its thickness, so it stands on the lot's side of the line.
    const nx = -(b.y - a.y) / len * thick / 2, ny = (b.x - a.x) / len * thick / 2;
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces;
      kept.push({ id: nextId++, kind, x: a.x + (b.x - a.x) * t + nx, y: a.y + (b.y - a.y) * t + ny, facing: 0, w: len / pieces, d: thick, z: 0, h: height, angle });
    }
  }
  elements.splice(0, elements.length, ...kept.slice(0, MAX_ELEMENTS));
  // Surfaces clipped to the lot; volumes of the building itself kept where
  // they stand on it.
  const clip = (poly: Vec2[]): Vec2[] => {
    let out = poly;
    // Each side of the lot (counter-clockwise) keeps what is on its left.
    for (let i = 0; i < ring.length && out.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      const side = (p: Vec2): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const input = out;
      out = [];
      for (let j = 0; j < input.length; j++) {
        const p = input[j]!, q = input[(j + 1) % input.length]!;
        const sp = side(p), sq = side(q);
        if (sp >= 0) out.push(p);
        if ((sp >= 0) !== (sq >= 0)) { const k = sp / (sp - sq); out.push({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k }); }
      }
    }
    return out;
  };
  const asOutline = (v: Volume, poly: readonly Vec2[]): void => {
    const px = poly.map((p) => p.x), py = poly.map((p) => p.y);
    v.x = Math.min(...px); v.y = Math.min(...py); v.w = Math.max(...px) - v.x; v.d = Math.max(...py) - v.y;
    v.outline = poly.map((p) => ({ x: (p.x - v.x) / (v.w || 1), y: (p.y - v.y) / (v.d || 1) }));
  };
  const volumes: Volume[] = [];
  const nextVolume = Math.max(0, ...body.volumes.map((v) => v.id)) + 1;
  // The lawn under everything, the lot's own shape - laid first, drawn under the rest.
  const lawnTemplate = body.volumes.find((v) => v.open);
  if (lawnTemplate) {
    const lawn: Volume = { ...JSON.parse(JSON.stringify(lawnTemplate)) as Volume, id: nextVolume, open: 'grass' };
    asOutline(lawn, [...ring]);
    volumes.push(lawn);
  }
  for (const v of body.volumes) {
    const ringOf = v.outline ? v.outline.map((p) => ({ x: v.x + p.x * v.w, y: v.y + p.y * v.d }))
      : [{ x: v.x, y: v.y }, { x: v.x + v.w, y: v.y }, { x: v.x + v.w, y: v.y + v.d }, { x: v.x, y: v.y + v.d }];
    if (v.open) {
      const cut = clip(ringOf);
      if (cut.length < 3) continue;
      if (cut.length !== 4 || !ringOf.every((p) => inside({ x: p.x * 0.999 + (v.x + v.w / 2) * 0.001, y: p.y * 0.999 + (v.y + v.d / 2) * 0.001 }))) asOutline(v, cut);
      volumes.push(v);
    } else if (ringOf.some((p) => inside(p)) || inside({ x: v.x + v.w / 2, y: v.y + v.d / 2 })) volumes.push(v);
  }
  body.volumes.splice(0, body.volumes.length, ...volumes);
}
