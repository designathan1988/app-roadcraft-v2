import type { Building, BuildingId } from '@world/buildings/types';
import type { LotTemplate } from '@world/buildings/lotTemplate';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import type { SiteContext } from '@world/buildings/validate';
import { m } from '@world/units';
import type { ZoneGrid } from '@world/zoneGrid';
import type { ZoneDensity, ZoneUse } from '@world/zones';
import { LOT_PLAN_VERSION, growOne, paintCells } from './zoning';
import { Rng } from '@core/rng';
import { instantiate } from '@world/buildings/blueprints';
import { TOWER_KINDS, type TowerKind, makeTower } from '@world/buildings/towerKit';
import type { MadeBuilding } from '@world/buildings/procedural';
import { type LotKind, furnishLot, planLot } from './lotPlan';
import { addBuildingRecord } from './buildings';

/**
 * The lot lab (`?lab=lots`): a street on empty land where the zoning's lot
 * generator (`zoning.ts` `growOne`, `lotPlan.ts`) grows lots of one zone at a
 * time, for the player to look at, edit with the building tool, and keep in a
 * library (`lot-library-plugin.ts`) for the zones to use later.
 */


/** The lab's street: one local street, long enough for a row of lots on each side. */
export function layLabStreet(doc: RoadDoc, net: Network): void {
  const a = doc.addNode({ x: -m(110), y: 0 });
  const b = doc.addNode({ x: m(110), y: 0 });
  doc.addSegment(a.id, b.id, 0);
  net.rebuild();
}

/** Takes down every grown lot and zones the whole street with `zone`. */
export function rezoneLab(doc: RoadDoc, grid: ZoneGrid, zone: { use: ZoneUse; density: ZoneDensity }): void {
  for (const mark of doc.zoneMarks) {
    if (mark.building !== undefined && doc.buildings.has(mark.building as BuildingId)) doc.buildings.remove(mark.building as BuildingId);
  }
  doc.zoneMarks.length = 0;
  doc.zoneRevision++;
  paintCells(doc, grid, grid.cells, zone);
}

/**
 * Dezones the whole street, its grown lots demolished at once (Cities:
 * Skylines II's dezoning, without the wait); the street stays. Undoable.
 */
export function clearLab(doc: RoadDoc, grid: ZoneGrid): void {
  paintCells(doc, grid, grid.cells, null);
  doc.zoneMarks.length = 0;
  doc.zoneRevision++;
}

/** Grows every lot the zoned street holds, at once. Returns how many grew. */
export function growLab(ctx: SiteContext, grid: ZoneGrid, seed: number, widths: readonly [number, number]): number {
  const refused = new Set<string>();
  let grown = 0;
  for (let i = 0; i < 200; i++) {
    const id = growOne(ctx, grid, refused, seed, widths);
    if (id === null) break;
    const b = ctx.doc.buildings.get(id as BuildingId);
    if (b) ctx.doc.buildings.put({ ...b, decay: 0, lotPlan: LOT_PLAN_VERSION });
    grown++;
  }
  return grown;
}

/**
 * Puts a tower of the kit (`world/buildings/towerKit.ts`) in the first free
 * place of two rows behind the lab street's north lots, its front to the
 * street. Returns its id, or null when no place took it.
 */
export function placeTower(ctx: SiteContext, kind: TowerKind, floors: number | undefined, seed: number): number | null {
  const body = makeTower({ kind, ...(floors ? { floors } : {}) }, new Rng(seed >>> 0));
  for (const rowY of [-m(60), -m(105)]) {
    for (let k = 0; k < 7; k++) {
      const anchor = { x: -m(105) + k * m(35), y: rowY };
      const result = addBuildingRecord(ctx, instantiate(body, anchor, Math.PI));
      if (result.ok && result.id !== undefined) return result.id as number;
    }
  }
  return null;
}

/** The lot each tower of the kit stands on: the lot planner's kind and the plot, metres. */
const CATALOG_LOTS: Record<TowerKind, { kind: LotKind; W: number; D: number }> = {
  balconyMid: { kind: 'flats', W: 30, D: 40 },
  glassOffice: { kind: 'office', W: 30, D: 40 },
  glassBalcony: { kind: 'tower', W: 30, D: 40 },
  beigeClassic: { kind: 'tower', W: 30, D: 40 },
  darkGlass: { kind: 'office', W: 30, D: 40 },
  whiteBalcony: { kind: 'tower', W: 30, D: 40 },
  brickFrame: { kind: 'tower', W: 30, D: 40 },
  roundGlass: { kind: 'tower', W: 30, D: 40 },
  darkGrid: { kind: 'tower', W: 30, D: 40 },
  artDeco: { kind: 'office', W: 30, D: 40 },
  twistGreen: { kind: 'tower', W: 34, D: 42 },
  hexTerracotta: { kind: 'tower', W: 34, D: 42 },
  stepGarden: { kind: 'tower', W: 34, D: 42 },
  waveWhite: { kind: 'tower', W: 34, D: 40 },
  cubeBalcony: { kind: 'tower', W: 34, D: 40 },
  twinNavy: { kind: 'office', W: 36, D: 40 },
  octCopper: { kind: 'office', W: 34, D: 42 },
  stackedBlocks: { kind: 'tower', W: 34, D: 40 },
  pinkCorner: { kind: 'flats', W: 34, D: 42 },
  triangleDark: { kind: 'office', W: 34, D: 42 },
};

/**
 * The catalogue: every tower of the kit on a whole lot - its forecourt or
 * garden, walls or railings, gates, the residents' car park behind, trees and
 * lamps - laid by the zoning's own lot planner (`lotPlan.ts`), along both
 * sides of the lab street, fronts on the footway. Everything on the lab
 * street before is taken down. Returns how many stood.
 */
/** How far behind the lab street the catalogue's row stands, metres (clear of the street). */
export const CATALOG_BACK = 160;
/** The catalogue's lots stand this far apart along the row, metres: the widest lot and a gap. */
const CATALOG_PITCH = 40;

/** `toward`: the unit direction (world) from the ground towards the camera; given, the lots stand in one row facing it. */
export function showCatalog(ctx: SiteContext, grid: ZoneGrid, seed: number, toward?: { x: number; y: number }): number {
  const { doc } = ctx;
  for (const b of [...doc.buildings.all()]) doc.buildings.remove(b.id);
  doc.zoneMarks.length = 0;
  doc.zoneRevision++;
  // The front line of each side of the street, from the zone grid's first row.
  const sides = ([1, -1] as const).map((side) => {
    const fronts = grid.cells.filter((c) => c.row === 0 && c.side === side);
    if (!fronts.length) return null;
    const y = fronts.reduce((s, c) => s + (c.corners[0].y + c.corners[1].y) / 2, 0) / fronts.length;
    const xs = fronts.flatMap((c) => [c.corners[0].x, c.corners[1].x]);
    return { y, x0: Math.min(...xs), x1: Math.max(...xs), rotation: fronts[0]!.rotation };
  }).filter((s): s is NonNullable<typeof s> => s !== null);
  const cursor = sides.map((s) => s.x0);
  let placed = 0;
  TOWER_KINDS.forEach((kind, i) => {
    const lot = CATALOG_LOTS[kind];
    const rng = new Rng((seed * 977 + i * 131) >>> 0);
    const plan = planLot(lot.kind, lot.W, lot.D, rng);
    const env = plan.building;
    const body = makeTower({ kind, width: env.x1 - env.x0, depth: env.y1 - env.y0 }, rng);
    // Into the lot's frame: x across from its middle, y back from the front boundary.
    const dx = m(env.x0 - lot.W / 2), dy = m(env.y0);
    for (const v of body.volumes) {
      v.x += dx; v.y += dy;
      for (const r of v.roofDetails ?? []) { r.x += dx; r.y += dy; }
    }
    for (const e of body.elements ?? []) { e.x += dx; e.y += dy; }
    for (const c of body.cores ?? []) { c.x += dx; c.y += dy; }
    const made: MadeBuilding = { fn: body.function ?? 'apartments', body, entrance: (env.x1 - env.x0) / 2, free: [] };
    furnishLot(body, plan, made, rng);
    // Facing the camera: one row, side by side, every front to the viewer
    // (two rows face to face hid each other's fronts).
    if (toward) {
      const t = toward;
      const u = { x: -t.y, y: t.x };
      const off = (i - (TOWER_KINDS.length - 1) / 2) * m(CATALOG_PITCH);
      const back = m(CATALOG_BACK);
      const result = addBuildingRecord(ctx, {
        ...body, x: -t.x * back + u.x * off, y: -t.y * back + u.y * off,
        rotation: Math.atan2(t.x, -t.y), decay: 0, lotPlan: LOT_PLAN_VERSION,
      } as Omit<Building, 'id'>);
      if (result.ok) placed++;
      return;
    }
    // The next free stretch on either side of the street.
    for (let k = 0; k < sides.length; k++) {
      const s = (placed + k) % sides.length;
      const side = sides[s]!;
      const width = m(lot.W);
      if (cursor[s]! + width > side.x1 + 1e-6) continue;
      const along = cursor[s]! + width / 2;
      const result = addBuildingRecord(ctx, {
        ...body, x: along, y: side.y, rotation: side.rotation, decay: 0, lotPlan: LOT_PLAN_VERSION,
      } as Omit<Building, 'id'>);
      cursor[s] = cursor[s]! + width;
      if (result.ok) { placed++; return; }
    }
  });
  return placed;
}

/** The zone a grown building stands on, if any. */
export function zoneOfBuilding(doc: RoadDoc, id: number): { use: ZoneUse; density: ZoneDensity } | null {
  const mark = doc.zoneMarks.find((z) => z.building === id);
  return mark ? { use: mark.use, density: mark.density } : null;
}

export function templateOf(building: Building, name: string, zone: { use: ZoneUse; density: ZoneDensity }): LotTemplate {
  const { id: _id, x: _x, y: _y, rotation: _r, builtAt: _b, decay: _d, ...body } = building;
  return { name, use: zone.use, density: zone.density, savedAt: new Date().toISOString(), body };
}

/** Puts a kept lot in place of a building, where it stands and facing the same way. */
export function applyTemplate(doc: RoadDoc, target: Building, template: LotTemplate): void {
  doc.buildings.put({
    ...structuredClone(template.body),
    id: target.id, x: target.x, y: target.y, rotation: target.rotation,
    decay: 0, lotPlan: LOT_PLAN_VERSION,
  } as Building);
}
