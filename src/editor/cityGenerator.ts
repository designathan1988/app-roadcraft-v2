import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { lotFrame, zoneLots, type Lot } from '@world/lots';
import { ROAD_TYPES } from '@world/roadTypes';
import { m } from '@world/units';
import { LEVEL_ROAD, type CityPlan } from '@world/cityGen/plan';

/**
 * The city generator's hand on the map: the planned streets laid as roads
 * (`world/cityGen/plan.ts`), and once the lots are cut (`world/lots.ts`),
 * each lot zoned for what its district is for. The buildings then grow on
 * the zoned lots as any zoned lot's do (`zoning.ts` `growOnLot`): a generated
 * city is an ordinary map, every road, lot and building of it editable.
 */

/** A new document with the plan's streets: a node at every crossing and bend, a road between. */
export function layCity(plan: CityPlan): RoadDoc {
  const doc = new RoadDoc();
  const types = LEVEL_ROAD.map((id) => Math.max(0, ROAD_TYPES.findIndex((t) => t.id === id)));
  const ids = plan.graph.nodes.map((p) => doc.addNode(p).id);
  for (const e of plan.graph.edges) {
    const chain = [ids[e.a]!, ...e.points.map((p) => doc.addNode(p).id), ids[e.b]!];
    for (let i = 0; i + 1 < chain.length; i++) doc.addSegment(chain[i]!, chain[i + 1]!, types[Math.min(e.level, types.length - 1)]!);
  }
  return doc;
}

/**
 * Every lot zoned by its district: commerce where its front is on an avenue
 * or a collector and the district is lively enough, parks left open. Returns
 * how many lots were zoned.
 */
export function zoneCity(doc: RoadDoc, plan: CityPlan): number {
  const main = new Set(['avenue', 'urban'].map((id) => ROAD_TYPES.findIndex((t) => t.id === id)));
  const mains: [Vec2, Vec2][] = [];
  for (const s of doc.segments.values()) {
    if (!main.has(s.type)) continue;
    const a = doc.nodes.get(s.a), b = doc.nodes.get(s.b);
    if (a && b) mains.push([a, b]);
  }
  const groups = new Map<string, number[]>();
  for (const lot of doc.lots as readonly Lot[]) {
    const f = lotFrame(lot);
    const zone = plan.zoneAt(f.anchor, nearAny(f.anchor, mains, m(22)));
    if (zone === 'park') continue;
    const key = `${zone.use}:${zone.density}`;
    let list = groups.get(key);
    if (!list) groups.set(key, list = []);
    list.push(lot.id);
  }
  let zoned = 0;
  for (const [key, ids] of groups) {
    const [use, density] = key.split(':') as [Lot['use'] & string, Lot['density'] & string];
    if (zoneLots(doc, ids, { use, density })) zoned += ids.length;
  }
  return zoned;
}

function nearAny(p: Vec2, segs: readonly [Vec2, Vec2][], d: number): boolean {
  for (const [a, b] of segs) {
    const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2)) : 0;
    if (Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y) < d) return true;
  }
  return false;
}
