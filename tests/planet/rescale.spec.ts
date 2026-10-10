import { describe, expect, it } from 'vitest';
import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { tileToSphereInto } from '@core/planetTiles';
import { atlasToTileInto, tileCellOf, tileCentre, type TileLocal } from '@world/planet/atlas';
import { placeFor } from '@world/rescale';

const where: TileLocal = { tile: 0, x: 0, y: 0 };
const onSphere = (p: { x: number; y: number }): Vec3 => {
  atlasToTileInto(p.x, p.y, where);
  return tileToSphereInto(where.tile, where.x, where.y, { x: 0, y: 0, z: 0 });
};
const arc = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const p = onSphere(a), q = onSphere(b);
  return Math.acos(Math.min(1, p.x * q.x + p.y * q.y + p.z * q.z)) * PLANET_RADIUS;
};

/**
 * On the planet a saved map in another unit shrinks (or grows) about the
 * middle of its town on the sphere, never piece by piece: a road across a
 * piece's border keeps its two ends together (docs/ESCALA.md).
 */
describe('a planet map in another unit', () => {
  it('scales every distance about the town, across a piece border', () => {
    const home = tileCellOf(0, 0);
    const c = tileCentre(home);
    // A town straddling the home piece's east border (its owner's map past ~250 units).
    const town = [{ x: c.x + 150, y: c.y }, { x: c.x + 240, y: c.y + 30 }, { x: c.x + 230, y: c.y - 60 }];
    const points = [...town];
    const owners = new Set<number>();
    for (const factor of [0.4, 2.5]) {
      const place = placeFor(points, factor);
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          expect(arc(place(points[i]!.x, points[i]!.y), place(points[j]!.x, points[j]!.y))).toBeCloseTo(arc(points[i]!, points[j]!) * factor, 0);
        }
      }
      // Every point comes back written on the piece that owns it.
      for (const p of points) {
        const q = place(p.x, p.y);
        const back = onSphere(q);
        expect(Number.isFinite(back.x)).toBe(true);
        owners.add(tileCellOf(q.x, q.y));
      }
    }
    // Grown 2.5 times, the town reaches past the border onto the neighbour's piece.
    expect(owners.size).toBeGreaterThan(1);
    expect(owners.has(home)).toBe(true);
  });
});
