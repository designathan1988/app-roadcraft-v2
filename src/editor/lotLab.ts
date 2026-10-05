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
import { type TowerKind, makeTower } from '@world/buildings/towerKit';
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
