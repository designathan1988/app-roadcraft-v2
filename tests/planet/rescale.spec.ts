import { describe, expect, it } from 'vitest';
import { borderShift } from './_border';
import { FACE_HALF, PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILE_HALF, tileToSphereInto } from '@core/planetTiles';
import { ATLAS_COLUMNS, ATLAS_ROWS, TILE_REACH, atlasToTileInto, tileCellOf, tileCentre, type TileLocal } from '@world/planet/atlas';
import { RoadDoc } from '@world/doc';
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
    const shift = borderShift(home, 1, 0);
    const town = [{ x: c.x + 150 + shift, y: c.y }, { x: c.x + 240 + shift, y: c.y + 30 }, { x: c.x + 230 + shift, y: c.y - 60 }];
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

/**
 * A map made on the first planet (faces of 3 000 units: no `planetHalf` in
 * it) opened on today's, 2.5 times larger: its town keeps its size and its
 * place on the sphere (`world/rescale.ts` resizedPlanetPlace).
 */
describe('a map made on the smaller first planet', () => {
  it('opens with its town the same size, where it was on the sphere', () => {
    const k = 3000 / FACE_HALF;
    const pitch = Math.ceil((2 * (TILE_HALF * k + TILE_REACH) + 200) / 400) * 400;
    const tile = 2 * 144 + 5 * 12 + 5;
    const oc = { x: ((tile % ATLAS_COLUMNS) - ATLAS_COLUMNS / 2) * pitch, y: (Math.floor(tile / ATLAS_COLUMNS) - ATLAS_ROWS / 2) * pitch };
    // Two nodes 100 units apart on the old piece's map, a road between them.
    const old = new RoadDoc();
    const a = old.addNode({ x: 0, y: 0 }).id, b = old.addNode({ x: 0, y: 0 }).id;
    old.addSegment(a, b, 1);
    const saved = old.toJSON() as unknown as { nodes: { x: number; y: number }[]; planetHalf?: number };
    saved.nodes[0]!.x = oc.x + 10; saved.nodes[0]!.y = oc.y;
    saved.nodes[1]!.x = oc.x + 110; saved.nodes[1]!.y = oc.y;
    delete saved.planetHalf;
    const doc = RoadDoc.fromJSON(saved as never);
    const [p, q] = [...doc.nodes.values()];
    expect(arc(p!, q!)).toBeCloseTo(100, 0);
    // Where it was: some 10 and 110 units (old) from the piece's centre, the same units now.
    expect(arc(p!, tileCentre(tile))).toBeGreaterThan(5);
    expect(arc(p!, tileCentre(tile))).toBeLessThan(140);
    // And saved again, it says the planet it is on.
    expect((doc.toJSON() as { planetHalf?: number }).planetHalf).toBe(FACE_HALF);
  });
});
