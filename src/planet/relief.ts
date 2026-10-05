/**
 * The ground of the planet: height above sea level for a direction from its
 * centre.
 *
 * Read on a direction (a unit vector), never on a flat map: the same relief
 * wherever the camera is, with no edge and no seam, as planet renderers do it
 * (3D noise sampled on the sphere; Leif Node, "Planetary Scale LOD Terrain").
 */

/** Radius of the planet at sea level, metres: the area of a 48 km square map. */
export const PLANET_RADIUS = 13_500;

// A fixed permutation, so the planet is the same every time.
const PERM = new Uint8Array(512);
{
  let seed = 0x2f6b9a1d;
  const order = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  for (let i = 0; i < 512; i++) PERM[i] = order[i & 255] as number;
}

const GRAD = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
  [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
] as const;

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Perlin's improved gradient noise in 3D, roughly -1..1. */
function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  x -= X; y -= Y; z -= Z;
  const xi = X & 255, yi = Y & 255, zi = Z & 255;
  const u = fade(x), v = fade(y), w = fade(z);
  const g = (h: number, dx: number, dy: number, dz: number): number => {
    const d = GRAD[h % 12] as readonly number[];
    return (d[0] as number) * dx + (d[1] as number) * dy + (d[2] as number) * dz;
  };
  const p = (i: number): number => PERM[i] as number;
  const a = p(xi) + yi, aa = p(a) + zi, ab = p(a + 1) + zi;
  const b = p(xi + 1) + yi, ba = p(b) + zi, bb = p(b + 1) + zi;
  return lerp(
    lerp(lerp(g(p(aa), x, y, z), g(p(ba), x - 1, y, z), u), lerp(g(p(ab), x, y - 1, z), g(p(bb), x - 1, y - 1, z), u), v),
    lerp(lerp(g(p(aa + 1), x, y, z - 1), g(p(ba + 1), x - 1, y, z - 1), u), lerp(g(p(ab + 1), x, y - 1, z - 1), g(p(bb + 1), x - 1, y - 1, z - 1), u), v),
    w,
  );
}

function fbm(x: number, y: number, z: number, octaves: number): number {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * f + i * 17.1, y * f - i * 9.3, z * f + i * 3.7);
    f *= 2.02;
    amp *= 0.5;
  }
  return sum;
}

/** Sharp crests: mountain ranges. */
function ridged(x: number, y: number, z: number, octaves: number): number {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise3(x * f - i * 5.3, y * f + i * 11.9, z * f - i * 2.1));
    sum += amp * n * n;
    f *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Height above sea level, metres, for a unit direction (x, y, z). */
export function reliefAt(x: number, y: number, z: number): number {
  // Continents and ocean basins, a few kilometres across.
  const continent = fbm(x * 1.6, y * 1.6, z * 1.6, 5);
  const land = smooth(-0.02, 0.12, continent);
  let h = continent * 900 - 40;
  // Mountain ranges inland.
  h += ridged(x * 5, y * 5, z * 5, 5) * 650 * smooth(0.06, 0.3, continent);
  // Hills and the grain of the ground.
  h += fbm(x * 40, y * 40, z * 40, 4) * 60 * land;
  h += fbm(x * 400, y * 400, z * 400, 3) * 4;
  // Coastal plains: land just above the sea is flattened into ground to build on.
  if (h > 0 && h < 30) h = h * (0.4 + 0.6 * (h / 30));
  return h;
}
