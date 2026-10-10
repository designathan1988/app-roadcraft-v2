import { describe, expect, it } from 'vitest';
import { FACE_HALF, PLANET_RADIUS, faceToSphereInto, type Vec3 } from '@core/cubeSphere';
import { TILES_PER_SIDE, tileOfDirection } from '@core/planetTiles';
import { GRID_CELL, onGrid, snapToGrid } from '@world/grid';
import { atlasToSphereInto, sphereToChartInto } from '@world/planet/charts';

/**
 * THE GRID ON THE PLANET (`world/grid.ts` snapToGrid, `world/planet/charts.ts`
 * snapToFaceGridInto; drawn by `render/terrain.ts` uGrid). Run with
 * `vitest.planet.config.ts`.
 *
 * Drawn and snapped on every piece's own map, the grid broke at each piece's
 * border: two charts put their lines a few metres apart and turned, and a
 * road snapped on one did not meet the grid of the next. It is now the cube
 * faces' own, one grid for the sphere.
 */

const s = (): Vec3 => ({ x: 0, y: 0, z: 0 });
/** The arc between two directions (atan2 of the cross and the dot: exact near zero, unlike acos). */
const arc = (a: Vec3, b: Vec3): number => {
  const cx = a.y * b.z - a.z * b.y, cy = a.z * b.x - a.x * b.z, cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z) * PLANET_RADIUS;
};

/** The grid point a sphere direction snaps to, read on `chart`'s map, back on the sphere. */
function snappedOn(chart: number, d: Vec3, offset = 0): Vec3 {
  const p = sphereToChartInto(chart, d, { x: 0, y: 0 });
  const q = snapToGrid(p, GRID_CELL, offset);
  return atlasToSphereInto(q.x, q.y, s());
}

describe('the grid on the planet', () => {
  const step = (2 * FACE_HALF) / TILES_PER_SIDE;
  const cases = [
    // A border between two pieces of one face.
    { name: 'between two pieces of a face', face: 2, x: -FACE_HALF + 6 * step - 4, y: 333, across: 9 },
    // An edge of the cube: two faces.
    { name: 'over an edge of the cube', face: 0, x: FACE_HALF - 6, y: -517, across: 14 },
  ];
  for (const c of cases) {
    it(`is one grid ${c.name}`, () => {
      const d = faceToSphereInto(c.face, c.x, c.y, s());
      const here = tileOfDirection(d);
      const there = tileOfDirection(faceToSphereInto(c.face, c.x + c.across, c.y, s()));
      expect(there).not.toBe(here);
      for (const offset of [0, GRID_CELL / 2]) {
        const a = snappedOn(here, d, offset), b = snappedOn(there, d, offset);
        // The same ground, whichever map it was read on.
        expect(arc(a, b)).toBeLessThan(1e-6);
        // And no farther than half a cell's diagonal from where it was.
        expect(arc(a, d)).toBeLessThan(GRID_CELL * 0.75);
      }
    });
  }

  it('keeps its cells a cell across and its points on their chart', () => {
    const chart = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 6 * TILES_PER_SIDE + 6;
    const p = sphereToChartInto(chart, faceToSphereInto(2, 41, -77, s()), { x: 0, y: 0 });
    const q = snapToGrid(p, GRID_CELL);
    expect(onGrid(q, GRID_CELL)).toBe(true);
    expect(onGrid(p, GRID_CELL)).toBe(false);
    const east = snapToGrid({ x: q.x + GRID_CELL, y: q.y }, GRID_CELL);
    const north = snapToGrid({ x: q.x, y: q.y + GRID_CELL }, GRID_CELL);
    const a = atlasToSphereInto(q.x, q.y, s());
    expect(arc(a, atlasToSphereInto(east.x, east.y, s()))).toBeCloseTo(GRID_CELL, 1);
    expect(arc(a, atlasToSphereInto(north.x, north.y, s()))).toBeCloseTo(GRID_CELL, 1);
    // Written on the chart it was asked on (its cell of the atlas).
    expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(GRID_CELL);
  });
});
