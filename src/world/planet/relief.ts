import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { tileToSphereInto } from '@core/planetTiles';
import { RELIEF_FLAT, RELIEF_NATURAL, type ReliefVersion } from '../terrain';

/**
 * THE PLANET'S LAND: the same landforms as the flat map's (`terrain.ts`
 * `naturalRelief`, `baseRelief`), read at the POINT OF THE SPHERE rather than
 * at a face's own coordinates. A face's map ends at its border, but the
 * sphere does not: noise sampled in each face's coordinates gave two
 * different heights at every border, a step round the whole planet.
 * Sampled in three dimensions, both faces read the same ground at their
 * shared border (Catlike Coding, "Seamless Cube Sphere": noise at the 3-D
 * position, never per face).
 *
 * Deterministic and analytic, as the flat map's land is.
 */

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263) ^ Math.imul(z | 0, 2_246_822_519);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
}

/** Smooth deterministic value noise in three dimensions, -1..1. */
export function valueNoise3(x: number, y: number, z: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const layer = (k: number): number => lerp(
    lerp(hash3(x0, y0, k), hash3(x0 + 1, y0, k), sx),
    lerp(hash3(x0, y0 + 1, k), hash3(x0 + 1, y0 + 1, k), sx),
    sy,
  );
  return lerp(layer(z0), layer(z0 + 1), sz);
}

const smooth01 = (t: number): number => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/** `naturalRelief` at a point of the sphere (world units from its centre). */
export function naturalRelief3(x: number, y: number, z: number): number {
  const n = valueNoise3;
  const wx = n(x / 1400 + 3.1, y / 1400 - 7.4, z / 1400 + 1.7) * 420;
  const wy = n(x / 1400 - 11.2, y / 1400 + 2.6, z / 1400 - 4.9) * 420;
  const wz = n(x / 1400 + 6.3, y / 1400 + 9.8, z / 1400 + 12.4) * 420;
  const px = x + wx, py = y + wy, pz = z + wz;
  const continent = n(px / 1900, py / 1900, pz / 1900);
  const hilly = smooth01((n(px / 1300 + 17.3, py / 1300 - 5.9, pz / 1300 + 3.3) + 0.1) / 0.85);
  let ridge = 0;
  let weight = 0;
  let amplitude = 1;
  let frequency = 1 / 640;
  for (let octave = 0; octave < 4; octave++) {
    const r = 1 - Math.abs(n(px * frequency + octave * 13.7, py * frequency - octave * 9.1, pz * frequency + octave * 5.3));
    ridge += r * r * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  ridge /= weight;
  const rolling = n(px / 260 + 2.2, py / 260 - 8.8, pz / 260 + 0.7) * 0.65 + n(px / 110 + 4.4, py / 110 + 1.3, pz / 110 - 2.1) * 0.35;
  const micro = n(x / 38 - 6.6, y / 38 + 3.3, z / 38 + 8.1) * 0.6 + n(x / 17 + 9.9, y / 17 - 2.7, z / 17 - 5.5) * 0.4;
  return 55 * continent + hilly * (190 * ridge - 60) + 22 * rolling * (0.35 + 0.65 * hilly) + 1.6 * micro;
}

/** `baseRelief` at a point of the sphere. */
export function baseRelief3(x: number, y: number, z: number): number {
  const n = valueNoise3;
  const broad = n(x / 620, y / 620, z / 620);
  const middle = n(x / 210 + 13.7, y / 210 - 4.1, z / 210 + 2.9);
  const fine = n(x / 88 - 7.3, y / 88 + 19.2, z / 88 - 6.4);
  const grain = n(x / 48 + 31.5, y / 48 - 12.8, z / 48 + 7.7);
  return 32 * (broad * 0.42 + middle * 0.29 + fine * 0.2 + grain * 0.09);
}

/**
 * The land under one piece's map (`core/planetTiles.ts`): a point of it (its
 * own coordinates, about its centre) to the height of the planet's land there.
 */
export function tileGround(tile: number, relief: ReliefVersion): (x: number, y: number) => number {
  if (relief === RELIEF_FLAT) return () => 0;
  const s: Vec3 = { x: 0, y: 0, z: 0 };
  const land = relief === RELIEF_NATURAL ? naturalRelief3 : baseRelief3;
  return (x, y) => {
    tileToSphereInto(tile, x, y, s);
    return land(s.x * PLANET_RADIUS, s.y * PLANET_RADIUS, s.z * PLANET_RADIUS);
  };
}
