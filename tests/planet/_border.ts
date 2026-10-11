import { FACE_HALF } from '@core/cubeSphere';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, toOwner } from '@world/planet/charts';

/**
 * Places near a piece's border, for the planet's specs. They were chosen on a
 * planet of faces of 3 000 units; the pieces are the same angles of the sphere
 * at any size, so a border stands `FACE_HALF / 3000` times farther from its
 * piece's centre now. `nearBorder` moves a place the way the border moved -
 * the scene keeps every length (a road, a wall, a building) and stands at the
 * same distance from the border as it was written for.
 */
const SIZE = FACE_HALF / 3000;

/** How far out from a piece's centre, along (ux, uy) on its own map, its border lies. */
export function borderAlong(chart: number, ux: number, uy: number): number {
  const c = tileCentre(chart);
  const l = Math.hypot(ux, uy);
  for (let t = 0; t < 20_000; t += 0.25) {
    const p = toOwner(chart, { x: c.x + (ux / l) * t, y: c.y + (uy / l) * t });
    if (chartAt(p.x, p.y) !== chart) return t;
  }
  return Infinity;
}

/** How far to move a place written for the old planet along (ux, uy) so it keeps its distance to the border. */
export function borderShift(chart: number, ux: number, uy: number): number {
  return borderAlong(chart, ux, uy) * (1 - 1 / SIZE);
}

/**
 * For a scene written to cross SEVERAL borders along (ux, uy): its distances
 * from the piece's centre, written for the old planet, moved so each border it
 * crossed is crossed the same way now - up to the first border moved out as
 * the border moved (`borderShift`), past it stretched as the pieces grew.
 */
export function acrossBorders(chart: number, ux: number, uy: number): (x: number) => number {
  const border = borderAlong(chart, ux, uy);
  const old = border / SIZE;
  return (x) => (x <= old ? x + (border - old) : border + (x - old) * SIZE);
}
