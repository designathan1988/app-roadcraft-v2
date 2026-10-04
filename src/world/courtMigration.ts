import type { RoadDoc } from './doc';
import { buildingBounds } from './buildings/geometry';
import { extendPlot } from './buildings/plotExtension';
import type { Building } from './buildings/types';
import type { Box } from './sampleTown';
import { trimAgainst } from './town';
import { m } from './units';

/**
 * Saved cities from before the town's blocks were built through still have a
 * court in the middle of every block: a lawn round a gravel walk (function
 * 'square', all of it open lots, the walk four gravel strips). In a real town
 * that ground belongs to the buildings round it: each one's plot runs back to
 * the block's spine. On load the court goes, and every building that backs
 * onto it has its own yard carried back over its share - walled from its
 * neighbours and from the plot behind. No building is added.
 *
 * Returns how many courts were given back to their plots.
 */
export function replaceBlockCourts(doc: RoadDoc): number {
  const isCourt = (b: Building): boolean =>
    b.function === 'square' && b.volumes.length >= 5 && b.volumes.every((v) => v.open) &&
    b.volumes.filter((v) => v.open === 'gravel').length >= 4;
  const courts = [...doc.buildings.all()].filter(isCourt);
  for (const court of courts) {
    const cb = buildingBounds(court);
    const box: Box = { x0: cb.minX, y0: cb.minY, x1: cb.maxX, y1: cb.maxY };
    doc.buildings.remove(court.id);
    const W = box.x1 - box.x0, D = box.y1 - box.y0;
    const midX = (box.x0 + box.x1) / 2, midY = (box.y0 + box.y1) / 2;
    const reach = m(4);
    // The buildings backing onto the court, and the way their plots run into it.
    const around: { b: Building; rect: Box; inward: { x: number; y: number }; long: boolean }[] = [];
    for (const b of doc.buildings.all()) {
      if (b.volumes.every((v) => v.open)) continue;
      const bb = buildingBounds(b);
      const overlapX = Math.min(bb.maxX, box.x1) - Math.max(bb.minX, box.x0);
      const overlapY = Math.min(bb.maxY, box.y1) - Math.max(bb.minY, box.y0);
      const ax0 = Math.max(bb.minX, box.x0), ax1 = Math.min(bb.maxX, box.x1);
      const ay0 = Math.max(bb.minY, box.y0), ay1 = Math.min(bb.maxY, box.y1);
      if (overlapX > m(3) && Math.abs(bb.maxY - box.y0) <= reach) {
        around.push({ b, inward: { x: 0, y: 1 }, long: W >= D, rect: { x0: ax0, x1: ax1, y0: box.y0, y1: W >= D ? midY : box.y1 } });
      } else if (overlapX > m(3) && Math.abs(bb.minY - box.y1) <= reach) {
        around.push({ b, inward: { x: 0, y: -1 }, long: W >= D, rect: { x0: ax0, x1: ax1, y0: W >= D ? midY : box.y0, y1: box.y1 } });
      } else if (overlapY > m(3) && Math.abs(bb.maxX - box.x0) <= reach) {
        around.push({ b, inward: { x: 1, y: 0 }, long: D > W, rect: { y0: ay0, y1: ay1, x0: box.x0, x1: D > W ? midX : box.x1 } });
      } else if (overlapY > m(3) && Math.abs(bb.minX - box.x1) <= reach) {
        around.push({ b, inward: { x: -1, y: 0 }, long: D > W, rect: { y0: ay0, y1: ay1, x0: D > W ? midX : box.x0, x1: box.x1 } });
      }
    }
    // The long sides first, to the spine; the ends take what is left.
    const taken: Box[] = [];
    for (const f of around.sort((p, q) => Number(q.long) - Number(p.long))) {
      const rect = trimAgainst(f.rect, f.inward, taken);
      if (!rect) continue;
      const grown = extendPlot(f.b, { x0: rect.x0 + m(0.1), y0: rect.y0 + m(0.1), x1: rect.x1 - m(0.1), y1: rect.y1 - m(0.1) });
      if (!grown) continue;
      doc.buildings.put(grown);
      taken.push(rect);
    }
  }
  return courts.length;
}
