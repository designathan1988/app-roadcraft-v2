import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';

/**
 * THE ONE TREE STYLE of the game: every tree and bush on the map - the
 * countryside's and the planted ones (`natureTrees.ts`), the street, lot and
 * garden trees (`propGeometry.ts`, drawn by `scenery.ts`) and the painted
 * woods' stand-ins (`groundCover.ts`) - is grown here, so a city park and the
 * wood beside it are one family (the player, 2026-10-08: three kits side by
 * side, "não tem padronização alguma").
 *
 * Shaped as a professional low-poly kit shapes them (Kenney's Nature Kit,
 * measured in `public/models/nature/`: a crown 0.35 to 0.6 of the tree's
 * height across, 50 to 230 triangles, the crown ONE faceted mass on a short
 * clear trunk). The first version here built each crown of five or six
 * separate balls, wider than the tree was tall: from above it read as bunches
 * of grapes and balloons, an ipê as yellow balls stuck on green ones, and the
 * crowns of a garden ran together into one blob on many trunks (the player,
 * 2026-10-08: "esse lixo"). Now one sphere of 80 faces pushed in and out by a
 * slow noise (the low-poly recipe: a polygon-reduced sphere under a noise
 * displacer, tuts+), at most one smaller lump grown into it.
 *
 * Colour: sober greens and grey-brown bark, sRGB hex read ONCE into the
 * linear working space (three's colour management since r152). An occlusion
 * is baked into each face's colour: darker low in a crown and deep inside it.
 *
 * Every model is ONE unit tall with its root at the origin (the wind shader,
 * `wind.ts`, reads local y as the fraction of the height), non-indexed, with
 * position, normal and colour.
 */

export type LowPolyKind = 'oak' | 'broadleafTall' | 'cypress' | 'palm' | 'ipeYellow' | 'ipePink' | 'bush' | 'bushFlowering' | 'hedge';

interface Tone {
  readonly dark: Color;
  readonly lit: Color;
}
/** Two sRGB hex colours, converted once into the linear working space by `Color`. */
const tone = (dark: number, lit: number): Tone => ({ dark: new Color(dark), lit: new Color(lit) });
const LEAF = tone(0x2f4a22, 0x67883d);
const LEAF_TALL = tone(0x2a4424, 0x5a7a40);
const NEEDLE = tone(0x203a24, 0x46663f);
const FROND = tone(0x34521f, 0x6e8f3e);
const BARK = tone(0x3b3026, 0x6e5a47);
const PALM_BARK = tone(0x4d4135, 0x84735f);
const BLOOM_YELLOW = tone(0xa27a22, 0xd8ae40);
const BLOOM_PINK = tone(0x864468, 0xc47a9f);
const SHRUB = tone(0x2a4520, 0x5a7a38);
const HEDGE = tone(0x243b1b, 0x4b6630);
const FLOWERS: readonly Tone[] = [tone(0xb9b2a4, 0xe8e2d6), tone(0x9c4a68, 0xd0759a), tone(0x8e2f2f, 0xc4524c)];

/** A small seeded random (mulberry32): a model is the same every time it is made. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A deterministic 3-D value noise in -1..1, of the ORIGINAL corner, so the copies of a corner move together. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const hash = (i: number, j: number, k: number): number => {
    let h = Math.imul(i, 374_761_393) ^ Math.imul(j, 668_265_263) ^ Math.imul(k, 1_274_126_177) ^ Math.imul(seed, 2_246_822_519);
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
  };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const plane = (k: number): number => lerp(
    lerp(hash(xi, yi, k), hash(xi + 1, yi, k), sx),
    lerp(hash(xi, yi + 1, k), hash(xi + 1, yi + 1, k), sx),
    sy,
  );
  return lerp(plane(zi), plane(zi + 1), sz);
}

/** How much light a face keeps, from where its centre lies (1 open, lower in shade). */
type Occlusion = (centre: Vector3) => number;
const OPEN: Occlusion = () => 1;

/** A crown's baked occlusion: dark low in it and deep inside it, where the leaves above shade it. */
function crownShade(bottom: number, top: number, radius: number): Occlusion {
  return (p) => {
    const h = Math.min(1, Math.max(0, (p.y - bottom) / Math.max(1e-6, top - bottom)));
    const out = Math.min(1, Math.hypot(p.x, p.z) / Math.max(1e-6, radius));
    return (0.62 + 0.38 * h) * (0.85 + 0.15 * out);
  };
}

/**
 * Triangles laid out flat - each its own three corners, so each face takes
 * its own normal and colour: the faceted look of a low-poly model.
 */
class Builder {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly n = new Vector3();
  private readonly e = new Vector3();
  private readonly centre = new Vector3();

  constructor(private readonly rng: () => number) {}

  /** One face: lighter facing the sky, a little shade of its own, times its occlusion. */
  tri(a: Vector3, b: Vector3, c: Vector3, t: Tone, occlusion: Occlusion = OPEN, jitter = 0.15): void {
    this.n.subVectors(b, a).cross(this.e.subVectors(c, a)).normalize();
    this.centre.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const k = Math.min(1, Math.max(0, 0.42 + 0.45 * this.n.y + (this.rng() - 0.5) * jitter));
    const light = occlusion(this.centre);
    const r = (t.dark.r + (t.lit.r - t.dark.r) * k) * light;
    const g = (t.dark.g + (t.lit.g - t.dark.g) * k) * light;
    const bl = (t.dark.b + (t.lit.b - t.dark.b) * k) * light;
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.col.push(r, g, bl);
    }
  }

  /** A sheet seen from both sides (a frond): both windings. */
  sheet(a: Vector3, b: Vector3, c: Vector3, t: Tone, occlusion: Occlusion = OPEN): void {
    this.tri(a, b, c, t, occlusion);
    this.tri(a, c, b, t, occlusion);
  }

  /** A three primitive, moved by `m`, its faces each their own shade; `pick` may give a face another tone. */
  add(geometry: BufferGeometry, m: Matrix4, t: Tone, occlusion: Occlusion = OPEN, jitter = 0.15, pick?: (centre: Vector3) => Tone): void {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    g.applyMatrix4(m);
    const p = g.getAttribute('position');
    const mid = new Vector3();
    for (let i = 0; i + 2 < p.count; i += 3) {
      const a = new Vector3().fromBufferAttribute(p, i);
      const b = new Vector3().fromBufferAttribute(p, i + 1);
      const c = new Vector3().fromBufferAttribute(p, i + 2);
      const faceTone = pick ? pick(mid.copy(a).add(b).add(c).multiplyScalar(1 / 3)) : t;
      this.tri(a, b, c, faceTone, occlusion, jitter);
    }
    g.dispose();
    geometry.dispose();
  }

  /**
   * A crown mass: an 80-face sphere (non-indexed: three's IcosahedronGeometry)
   * pushed in and out by a slow noise - the large form - and a little detail,
   * squashed by `squash`, at `at`. Below `floor` it is pressed flat (a bush on
   * the ground).
   */
  mass(at: Vector3, radius: number, squash: Vector3, t: Tone, seed: number, roughness: number, occlusion: Occlusion,
    pick?: (centre: Vector3) => Tone, floor = -Infinity): void {
    const solid = new IcosahedronGeometry(1, 1);
    const position = solid.getAttribute('position');
    const p = new Vector3();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      const big = noise3(p.x * 1.1 + seed * 3.1, p.y * 1.1, p.z * 1.1, seed);
      const small = noise3(p.x * 2.6, p.y * 2.6 + seed * 1.7, p.z * 2.6, seed + 17);
      p.multiplyScalar(radius * (1 + big * roughness + small * roughness * 0.3)).multiply(squash).add(at);
      if (p.y < floor) p.y = floor + (p.y - floor) * 0.2;
      position.setXYZ(i, p.x, p.y, p.z);
    }
    this.add(solid, new Matrix4(), t, occlusion, 0.15, pick);
  }

  /** The model, standing on its origin, one unit tall, each face its own normal. */
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingBox();
    const box = g.boundingBox!;
    const height = Math.max(1e-6, box.max.y - box.min.y);
    g.translate(0, -box.min.y, 0);
    g.scale(1 / height, 1 / height, 1 / height);
    // Non-indexed: each face its own corners, so its own normal.
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const UP = new Vector3(0, 1, 0);
/** A primitive standing along +y, placed from `from` to `to` (its height is the distance). */
function along(from: Vector3, to: Vector3): Matrix4 {
  const dir = new Vector3().subVectors(to, from);
  const length = dir.length();
  const q = new Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  const mid = new Vector3().addVectors(from, to).multiplyScalar(0.5);
  return new Matrix4().compose(mid, q, new Vector3(1, 1, 1)).multiply(new Matrix4().makeScale(1, length, 1));
}

/**
 * A trunk from the ground to `top`, six-sided, tapering from `r0` to `r1`,
 * the foot a little wider (the root swell, not a pedestal). Open at the ends,
 * which are in the ground and in the crown.
 */
function trunk(b: Builder, top: Vector3, r0: number, r1: number, bark: Tone): void {
  b.add(new CylinderGeometry(r1, r0, 1, 6, 1, true), along(new Vector3(0, 0, 0), top), bark, OPEN, 0.1);
}

/** The shade tree: one broad, lumpy crown, a smaller lump grown into it, on a short stout trunk. 184 triangles. */
function oak(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const top = new Vector3((rng() - 0.5) * 0.04, 0.5, (rng() - 0.5) * 0.04);
  trunk(b, top, 0.05, 0.032, BARK);
  const shade = crownShade(0.36, 0.98, 0.3);
  b.mass(new Vector3(top.x, 0.64, top.z), 0.28, new Vector3(1, 0.92, 1), LEAF, seed, 0.28, shade);
  const a = rng() * Math.PI * 2;
  b.mass(new Vector3(top.x + Math.cos(a) * 0.1, 0.8, top.z + Math.sin(a) * 0.1), 0.17, new Vector3(1, 0.9, 1), LEAF, seed + 5, 0.24, shade);
  return b.geometry();
}

/** A tall, narrow crown - one long mass - on a longer clear stem. 172 triangles. */
function broadleafTall(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const top = new Vector3((rng() - 0.5) * 0.03, 0.5, (rng() - 0.5) * 0.03);
  trunk(b, top, 0.04, 0.026, BARK);
  const shade = crownShade(0.32, 1.0, 0.22);
  b.mass(new Vector3(top.x, 0.66, top.z), 0.2, new Vector3(1, 1.65, 1), LEAF_TALL, seed, 0.24, shade);
  return b.geometry();
}

/** The cypress: a narrow column of four seven-sided tiers over a short trunk, their rims ragged and hanging. 68 triangles. */
function cypress(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  trunk(b, new Vector3(0, 0.18, 0), 0.034, 0.024, BARK);
  const slim = 0.92 + rng() * 0.16;
  const shade: Occlusion = (p) => 0.66 + 0.34 * Math.min(1, Math.max(0, (p.y - 0.14) / 0.86));
  const tiers: readonly (readonly [number, number, number])[] = [[0.14, 0.36, 0.17], [0.33, 0.32, 0.14], [0.51, 0.29, 0.105], [0.68, 0.32, 0.07]];
  tiers.forEach(([base, height, r], k) => {
    const radius = r * slim;
    const cone = new ConeGeometry(radius, height, 7, 1, false);
    const position = cone.getAttribute('position');
    const p = new Vector3();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      if (!(p.y < 0 && Math.hypot(p.x, p.z) > radius * 0.5)) continue;
      // A ragged rim of boughs, each corner its own reach, hanging a little.
      const n = noise3(p.x * 9 + k * 5.3, k * 1.7, p.z * 9, seed + k);
      p.x *= 1 + n * 0.16;
      p.z *= 1 + n * 0.16;
      p.y -= height * (0.06 + 0.05 * (n + 1));
      position.setXYZ(i, p.x, p.y, p.z);
    }
    b.add(cone, new Matrix4().makeTranslation(0, base + height / 2, 0), NEEDLE, shade, 0.12);
  });
  return b.geometry();
}

/** The palm: a curved, ringed trunk under a crown of drooping, toothed fronds. About 230 triangles. */
function palm(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const lean = 0.12 + rng() * 0.1, turn = rng() * Math.PI * 2;
  const leanDir = new Vector3(Math.cos(turn), 0, Math.sin(turn));
  // The trunk's line: up, bending out with the lean (a quadratic curve).
  const at = (t: number): Vector3 => new Vector3(0, 0.82 * t, 0).addScaledVector(leanDir, lean * t * t);
  const rings = 6;
  for (let s = 0; s < rings; s++) {
    const p0 = at(s / rings), p1 = at((s + 1.06) / rings);
    const r = 0.04 * (1 - 0.35 * (s / rings));
    // Each ring wider at its foot than its top: the stepped bark of a palm.
    b.add(new CylinderGeometry(r * 0.86, r * 1.06, 1, 6, 1, true), along(p0, p1), PALM_BARK, OPEN, 0.1);
  }
  const crown = at(1);
  const shade: Occlusion = (p) => 0.72 + 0.28 * Math.min(1, Math.max(0, (p.y - crown.y + 0.25) / 0.35));
  const fronds = 7;
  for (let k = 0; k < fronds; k++) {
    const a = (k / fronds) * Math.PI * 2 + rng() * 0.35;
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new Vector3(-Math.sin(a), 0, Math.cos(a));
    const length = 0.4 + rng() * 0.08;
    const lift = 0.45 + rng() * 0.25;
    const steps = 5;
    const spine: Vector3[] = [crown.clone()];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const angle = lift - t * 1.7;
      const step = new Vector3().addScaledVector(out, Math.cos(angle)).setY(Math.sin(angle)).multiplyScalar(length / steps);
      spine.push(spine[i - 1]!.clone().add(step));
    }
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const width = 0.085 * Math.sin(Math.PI * (0.12 + t * 0.85));
      const p0 = spine[i]!, p1 = spine[i + 1]!;
      for (const sign of [1, -1]) {
        // A leaflet: from the spine, out to the side and hanging down, swept towards the tip.
        const tip = p0.clone().lerp(p1, 0.8).addScaledVector(side, sign * width).add(new Vector3(0, -width * 0.75, 0));
        b.sheet(p0, p1, tip, FROND, shade);
      }
    }
  }
  return b.geometry();
}

/**
 * The flowering ipê: one wide, flat crown, flower over the top and the green
 * of the last leaves showing underneath - one mass, not flower balls stuck
 * on green ones. 172 triangles.
 */
function ipe(seed: number, bloom: Tone): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const top = new Vector3((rng() - 0.5) * 0.05, 0.5, (rng() - 0.5) * 0.05);
  trunk(b, top, 0.045, 0.028, BARK);
  const shade = crownShade(0.42, 0.92, 0.36);
  const centre = 0.68;
  const pick = (c: Vector3): Tone => (c.y < centre - 0.08 ? LEAF : bloom);
  b.mass(new Vector3(top.x, centre, top.z), 0.3, new Vector3(1.1, 0.62, 1.1), bloom, seed, 0.26, shade, pick);
  return b.geometry();
}

/** A bush: one lump of leaves pressed onto the ground, about one and a half times as wide as tall. 80 triangles. */
function bush(seed: number, flowering: boolean): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const shade = crownShade(0, 0.95, 0.7);
  // A flowering bush: a scatter of blossoms over the sunlit upper faces.
  const pick = flowering
    ? (c: Vector3): Tone => (c.y > 0.5 && rng() < 0.3 ? FLOWERS[Math.floor(rng() * FLOWERS.length)]! : SHRUB)
    : undefined;
  b.mass(new Vector3(0, 0.45, 0), 0.5, new Vector3(1.5, 1, 1.3), SHRUB, seed, 0.24, shade, pick, 0);
  return b.geometry();
}

/** A clipped hedge: one long, trimmed block of leaves, a little noise only. 80 triangles. */
function hedge(seed: number): BufferGeometry {
  const b = new Builder(random(seed));
  const shade = crownShade(0, 0.95, 0.9);
  b.mass(new Vector3(0, 0.5, 0), 0.5, new Vector3(2, 1, 0.8), HEDGE, seed, 0.08, shade, undefined, 0);
  return b.geometry();
}

/** A tree or bush of this kind, grown from `seed` (the same seed, the same model). */
export function lowPolyTree(kind: LowPolyKind, seed: number): BufferGeometry {
  switch (kind) {
    case 'oak': return oak(seed);
    case 'broadleafTall': return broadleafTall(seed);
    case 'cypress': return cypress(seed);
    case 'palm': return palm(seed);
    case 'ipeYellow': return ipe(seed, BLOOM_YELLOW);
    case 'ipePink': return ipe(seed, BLOOM_PINK);
    case 'bush': return bush(seed, false);
    case 'bushFlowering': return bush(seed, true);
    case 'hedge': return hedge(seed);
  }
}
