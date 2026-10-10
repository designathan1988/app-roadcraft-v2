import { describe, expect, it } from 'vitest';
import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILES, TILE_COUNT, TILE_HALF, onTile, sphereToTileInto, tileOfDirection, tileToSphereInto, tileTransferInto } from '@core/planetTiles';

const s: Vec3 = { x: 0, y: 0, z: 0 };
const a: Vec3 = { x: 0, y: 0, z: 0 };
const b: Vec3 = { x: 0, y: 0, z: 0 };
const p = { x: 0, y: 0 };

describe('the planet cut into flat maps', () => {
  it('every piece owns its own centre, and the pieces tile the sphere', () => {
    expect(TILE_COUNT).toBe(96);
    for (let id = 0; id < TILE_COUNT; id++) expect(tileOfDirection(TILES[id]!.centre)).toBe(id);
    console.info(`planet tiles: ${TILE_COUNT}, a piece within ±${TILE_HALF.toFixed(0)} of its centre`);
  });

  it('takes a map point to the sphere and back exactly, on the piece and past it', () => {
    let worst = 0;
    for (let id = 0; id < TILE_COUNT; id += 7) {
      for (let k = 0; k < 400; k++) {
        const x = Math.sin(k * 12.9898) * TILE_HALF * 1.6, y = Math.cos(k * 78.233) * TILE_HALF * 1.6;
        tileToSphereInto(id, x, y, s);
        sphereToTileInto(id, s, p);
        worst = Math.max(worst, Math.abs(p.x - x), Math.abs(p.y - y));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('keeps every shape on the sphere: a right angle within a degree, a length within 1.5%, anywhere on the piece', () => {
    let worstAngle = 0, worstScale = 0;
    for (let id = 0; id < TILE_COUNT; id++) {
      for (let gx = -1; gx <= 1; gx += 0.125) {
        for (let gy = -1; gy <= 1; gy += 0.125) {
          const x = gx * TILE_HALF, y = gy * TILE_HALF;
          if (!onTile(id, x, y)) continue;
          for (const turn of [0, Math.PI / 6, Math.PI / 4, Math.PI / 3]) {
            const ux = Math.cos(turn), uy = Math.sin(turn);
            tileToSphereInto(id, x, y, s);
            tileToSphereInto(id, x + ux * 0.5, y + uy * 0.5, a);
            tileToSphereInto(id, x - uy * 0.5, y + ux * 0.5, b);
            const u = [a.x - s.x, a.y - s.y, a.z - s.z], v = [b.x - s.x, b.y - s.y, b.z - s.z];
            const lu = Math.hypot(u[0]!, u[1]!, u[2]!), lv = Math.hypot(v[0]!, v[1]!, v[2]!);
            const angle = (Math.acos((u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!) / (lu * lv)) * 180) / Math.PI;
            worstAngle = Math.max(worstAngle, Math.abs(angle - 90));
            worstScale = Math.max(worstScale, Math.abs((lu * PLANET_RADIUS) / 0.5 - 1), Math.abs((lv * PLANET_RADIUS) / 0.5 - 1));
          }
        }
      }
    }
    console.info(`planet tiles: worst right angle off by ${worstAngle.toFixed(2)} deg, worst length off by ${(worstScale * 100).toFixed(2)}%`);
    expect(worstAngle).toBeLessThan(1);
    expect(worstScale).toBeLessThan(0.015);
  });

  it('carries a point and its heading over to a neighbour', () => {
    const out = { x: 0, y: 0, dx: 0, dy: 0 };
    const id = 5;
    tileToSphereInto(id, TILE_HALF * 0.99, 0, s);
    const next = tileOfDirection(tileToSphereInto(id, TILE_HALF * 1.2, 0, a));
    expect(next).not.toBe(id);
    tileTransferInto(id, TILE_HALF * 0.99, 0, 1, 0, next, out);
    tileToSphereInto(next, out.x, out.y, b);
    expect(Math.hypot(b.x - s.x, b.y - s.y, b.z - s.z) * PLANET_RADIUS).toBeLessThan(1e-6);
  });
});
