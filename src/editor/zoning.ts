import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { generateBody } from '@world/buildings/blueprints';
import type { BuildingFunction, BuildingUse, RoofKind } from '@world/buildings/types';
import type { SiteContext } from '@world/buildings/validate';
import { Level, halfWidth } from '@world/roadTypes';
import { m } from '@world/units';
import { type Zone, type ZoneUse, type ZoneDensity, zoneBounds, zonesOverlap } from '@world/zones';
import { placeBuilding } from './buildings';

interface ZoneForm {
  readonly function: BuildingFunction;
  readonly width: number;
  readonly depth: number;
  readonly floors: readonly [number, number];
  readonly roofs: readonly RoofKind[];
}

const FORMS: Record<ZoneUse, Record<ZoneDensity, ZoneForm>> = {
  residential: {
    low: { function: 'house', width: 9, depth: 10, floors: [1, 2], roofs: ['gable', 'hip'] },
    medium: { function: 'apartments', width: 14, depth: 13, floors: [3, 6], roofs: ['flat', 'hip'] },
    high: { function: 'residentialTower', width: 18, depth: 17, floors: [8, 16], roofs: ['flat', 'terrace'] },
  },
  commercial: {
    low: { function: 'shop', width: 10, depth: 10, floors: [1, 3], roofs: ['flat', 'hip'] },
    medium: { function: 'office', width: 15, depth: 15, floors: [4, 8], roofs: ['flat', 'terrace'] },
    high: { function: 'office', width: 20, depth: 18, floors: [9, 18], roofs: ['flat', 'terrace'] },
  },
  industrial: {
    low: { function: 'warehouse', width: 16, depth: 15, floors: [1, 1], roofs: ['sawtooth', 'flat'] },
    medium: { function: 'factory', width: 18, depth: 17, floors: [1, 2], roofs: ['sawtooth', 'flat'] },
    high: { function: 'factory', width: 23, depth: 20, floors: [2, 4], roofs: ['sawtooth', 'flat'] },
  },
};

/** Applies one rectangular brush stroke to lots that actually front a ground road. */
export function applyZone(
  ctx: SiteContext,
  start: Vec2,
  end: Vec2,
  use: ZoneUse,
  density: ZoneDensity,
  remove = false,
): { zones: number; buildings: number } {
  const { doc, net } = ctx;
  const box = zoneBounds(start, end);
  if (box.x1 - box.x0 < m(2) || box.y1 - box.y0 < m(2)) return { zones: 0, buildings: 0 };
  const old = doc.zones.filter((zone) => zonesOverlap(zone, box));
  for (const zone of old) {
    for (const id of zone.buildingIds) doc.buildings.remove(id as Parameters<typeof doc.buildings.remove>[0]);
  }
  if (old.length) doc.zones.splice(0, doc.zones.length, ...doc.zones.filter((zone) => !old.includes(zone)));
  if (remove || !net) return { zones: old.length, buildings: 0 };

  const id = doc.nextZoneId;
  const seed = (Math.imul(id, 0x9e3779b1) ^ Math.round(box.x0 * 31) ^ Math.round(box.y0 * 131)) >>> 0;
  const rng = new Rng(seed);
  const form = FORMS[use][density];
  const spacing = m(form.width + (density === 'high' ? 2 : 1));
  const buildingIds: number[] = [];
  let candidates = 0;
  for (const ribbon of net.ribbons.values()) {
    if (doc.segment(ribbon.id)?.structure !== 'ground') continue;
    // The broad phase must include the same first-lot snap allowance used by
    // the precise candidate test below, or it drops the road before testing it.
    const reach = halfWidth(ribbon.road, Level.Sidewalk) + m(form.depth * 1.5 + 0.15);
    const bb = ribbon.full.bbox;
    if (bb.maxX + reach < box.x0 || bb.minX - reach > box.x1 || bb.maxY + reach < box.y0 || bb.minY - reach > box.y1) continue;
    const count = Math.floor(ribbon.full.length / spacing);
    for (let i = 0; i < count && candidates < 300; i++) {
      const s = (i + 0.5) * ribbon.full.length / count;
      const before = ribbon.full.sampleAt(Math.max(0, s - m(0.5))).p;
      const after = ribbon.full.sampleAt(Math.min(ribbon.full.length, s + m(0.5))).p;
      const length = Math.hypot(after.x - before.x, after.y - before.y);
      if (length < 1e-6) continue;
      const tangent = { x: (after.x - before.x) / length, y: (after.y - before.y) / length };
      const centre = ribbon.full.sampleAt(s).p;
      for (const side of [-1, 1]) {
        const normal = { x: -tangent.y * side, y: tangent.x * side };
        const face = halfWidth(ribbon.road, Level.Sidewalk) + m(0.15);
        const anchor = { x: centre.x + normal.x * face, y: centre.y + normal.y * face };
        const middle = { x: anchor.x + normal.x * m(form.depth / 2), y: anchor.y + normal.y * m(form.depth / 2) };
        // The drag marks land, while the built frontage snaps back to the road.
        // Accept the first lot depth beyond the painted edge so a stroke just
        // behind the sidewalk still selects its road-facing lots.
        const reachFromPaint = m(form.depth);
        if (middle.x < box.x0 - reachFromPaint || middle.x > box.x1 + reachFromPaint ||
            middle.y < box.y0 - reachFromPaint || middle.y > box.y1 + reachFromPaint) continue;
        if (++candidates > 300) break;
        const width = m(form.width + rng.int(-1, 1));
        const depth = m(form.depth + rng.int(-1, 1));
        const body = generateBody(use as BuildingUse, width, depth, rng.int(...form.floors), {
          roof: rng.pick(form.roofs), palette: rng.int(0, 7),
        });
        body.function = form.function;
        const result = placeBuilding(ctx, body, anchor, Math.atan2(tangent.y, tangent.x) + (side === 1 ? 0 : Math.PI));
        if (result.ok && result.id !== undefined) buildingIds.push(result.id);
      }
    }
  }
  if (candidates === 0) return { zones: old.length, buildings: 0 };
  doc.nextZoneId++;
  const zone: Zone = { id, use, density, ...box, seed, buildingIds };
  doc.zones.push(zone);
  return { zones: 1, buildings: buildingIds.length };
}
