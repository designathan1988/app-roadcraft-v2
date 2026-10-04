import { Rng } from '@core/rng';
import type { RoadDoc } from './doc';
import { buildingBounds } from './buildings/geometry';
import { infill } from './town';
import type { Building } from './buildings/types';
import { m } from './units';

/**
 * Saved cities from before the town's blocks were built through to their
 * spine still have a court in the middle of every block: a lawn round a
 * gravel walk (`town.ts` courtyard, function 'square', all of it open lots,
 * the walk four gravel strips). A block of a town has no common ground in its
 * middle: on load, each such court is replaced by what the town builds there
 * now - the back buildings of the plots on either side, two rows back to
 * back, each a back house or a workshop of its own width.
 *
 * Returns how many courts were replaced.
 */
export function replaceBlockCourts(doc: RoadDoc): number {
  const courts = [...doc.buildings.all()].filter((b) =>
    b.function === 'square' && b.volumes.length >= 5 && b.volumes.every((v) => v.open) &&
    b.volumes.filter((v) => v.open === 'gravel').length >= 4);
  let replaced = 0;
  for (const court of courts) {
    const box = buildingBounds(court);
    doc.buildings.remove(court.id);
    replaced++;
    const rng = new Rng((court.id * 0x9e3779b1) >>> 0);
    const pick = (): number => rng.float();
    const W = box.maxX - box.minX, D = box.maxY - box.minY;
    const alongX = W >= D;
    const length = alongX ? W : D, depth = alongX ? D : W;
    // Two rows, back to back on the block's spine, a plot every 9-14 m.
    const rowDepth = depth / 2 - m(0.4);
    if (rowDepth < m(4)) continue;
    let t = m(0.5);
    while (t < length - m(4.5)) {
      const width = Math.min(length - m(0.5) - t, m(9 + pick() * 5));
      if (width < m(4)) break;
      for (const row of [0, 1] as const) {
        const Wm = width / m(1) - 0.6, Dm = (rowDepth - m(0.3) - pick() * m(3)) / m(1);
        if (Wm < 4 || Dm < 4) continue;
        const body = infill(pick, Wm, Dm, true);
        // The back building stands against the row's outer edge - the back of
        // the plot's front building - and its yard runs to the spine.
        const along0 = t + m(0.3);
        const x = alongX ? box.minX + along0 : row === 0 ? box.minX : box.maxX - m(Dm);
        const y = alongX ? (row === 0 ? box.minY : box.maxY - m(Dm)) : box.minY + along0;
        const rotation = 0;
        // An unrotated block: its local frame is the world's, offset to the corner.
        if (!alongX) for (const v of body.volumes) { [v.w, v.d] = [v.d, v.w]; [v.x, v.y] = [v.y, v.x]; }
        const local = { x0: Math.min(...body.volumes.map((v) => v.x)), y0: Math.min(...body.volumes.map((v) => v.y)) };
        doc.buildings.add({ ...body, function: 'townhouse', x: x - local.x0, y: y - local.y0, rotation } as Omit<Building, 'id'> as Building);
      }
      t += width;
    }
  }
  return replaced;
}
