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
 * Low-poly as low-poly trees are modelled: the crown a few low-polygon
 * spheres, each pushed in and out by noise and scaled on its own, over a
 * tapering trunk with a few branches (the classic recipe: polygon-reduced
 * spheres under a noise displacer, a tapered extruded trunk - tuts+, "How to
 * Create a Low Poly Tree"). Flat faces, each its own shade.
 *
 * Colour: sober greens and grey-brown bark, sRGB hex read ONCE into the
 * linear working space (three's colour management since r152: hex is sRGB,
 * converted on input; a second `convertSRGBToLinear` - what the old
 * countryside trees did - crushed the blue to nothing and made every leaf
 * neon). An occlusion is baked into each face's colour: darker low in a crown
 * and deep inside it, where the leaves above shade it.
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
const LEAF = tone(0x2b4420, 0x5c7a36);
const LEAF_TALL = tone(0x253e20, 0x4f6e3a);
const NEEDLE = tone(0x1d3320, 0x3e5d3a);
const FROND = tone(0x33501f, 0x6a8a3c);
const BARK = tone(0x2b221b, 0x584737);
const PALM_BARK = tone(0x463b30, 0x7a6955);
const BLOOM_YELLOW = tone(0x96701f, 0xd1a63b);
const BLOOM_PINK = tone(0x7a3c5f, 0xbb6c95);
const SHRUB = tone(0x26401d, 0x527034);
const HEDGE = tone(0x213819, 0x45602e);
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
    return (0.58 + 0.42 * h) * (0.8 + 0.2 * out);
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
  tri(a: Vector3, b: Vector3, c: Vector3, t: Tone, occlusion: Occlusion = OPEN, jitter = 0.3): void {
    this.n.subVectors(b, a).cross(this.e.subVectors(c, a)).normalize();
    this.centre.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const k = Math.min(1, Math.max(0, 0.4 + 0.45 * this.n.y + (this.rng() - 0.5) * jitter));
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
  add(geometry: BufferGeometry, m: Matrix4, t: Tone, occlusion: Occlusion = OPEN, jitter = 0.3, pick?: (centre: Vector3) => Tone): void {
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
   * A lump of leaves: an 80-face sphere pushed in and out by two octaves of
   * noise (the large form, then detail at a third of it), squashed by
   * `squash`, at `at`. Below `floor` it is pressed flat (a bush on the ground).
   */
  blob(at: Vector3, radius: number, squash: Vector3, t: Tone, seed: number, roughness: number, occlusion: Occlusion,
    pick?: (centre: Vector3) => Tone, floor = -Infinity): void {
    const solid = new IcosahedronGeometry(1, 1);
    const position = solid.getAttribute('position');
    const p = new Vector3();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      const big = noise3(p.x * 1.3 + seed * 3.1, p.y * 1.3, p.z * 1.3, seed);
      const small = noise3(p.x * 3.1, p.y * 3.1 + seed * 1.7, p.z * 3.1, seed + 17);
      p.multiplyScalar(radius * (1 + big * roughness + small * roughness * 0.35)).multiply(squash).add(at);
      if (p.y < floor) p.y = floor + (p.y - floor) * 0.2;
      position.setXYZ(i, p.x, p.y, p.z);
    }
    this.add(solid, new Matrix4(), t, occlusion, 0.3, pick);
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
 * A trunk from the ground to `top`: a short foot a third wider than the stem
 * - the root swell, in the bark's colour, not a pedestal - and the stem
 * tapering to `r1`. Open at the ends, which are in the ground and the crown.
 */
function trunk(b: Builder, top: Vector3, r0: number, r1: number, bark: Tone): void {
  const footTop = new Vector3(top.x * 0.06, top.y * 0.08, top.z * 0.06);
  b.add(new CylinderGeometry(r0, r0 * 1.35, 1, 6, 1, true), along(new Vector3(0, 0, 0), footTop), bark, OPEN, 0.2);
  b.add(new CylinderGeometry(r1, r0, 1, 6, 1, true), along(footTop, top), bark, OPEN, 0.2);
}

/** Limbs from near the top of the trunk out into the crown, each `r0` thick at the trunk. */
function limbs(b: Builder, rng: () => number, from: Vector3, count: number, reach: number, rise: number, r0: number, bark: Tone): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng() * 0.7;
    const to = new Vector3(from.x + Math.cos(a) * reach * (0.8 + rng() * 0.3), from.y + rise * (0.8 + rng() * 0.4), from.z + Math.sin(a) * reach * (0.8 + rng() * 0.3));
    b.add(new CylinderGeometry(r0 * 0.45, r0, 1, 5, 1, true), along(from, to), bark, OPEN, 0.2);
  }
}

/** A broad, rounded crown of five or six lumps over a stout trunk: the shade tree. */
function oak(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const top = new Vector3((rng() - 0.5) * 0.05, 0.46, (rng() - 0.5) * 0.05);
  trunk(b, top, 0.042, 0.028, BARK);
  limbs(b, rng, new Vector3(top.x, top.y - 0.08, top.z), 3, 0.15, 0.16, 0.02, BARK);
  const shade = crownShade(0.44, 1.02, 0.42);
  const crown = new Vector3(top.x, 0.68, top.z);
  b.blob(crown, 0.25, new Vector3(1, 0.8, 1), LEAF, seed, 0.22, shade);
  const lumps = 4 + Math.floor(rng() * 2);
  const start = rng() * Math.PI * 2;
  for (let i = 0; i < lumps; i++) {
    const a = start + (i / lumps) * Math.PI * 2 + (rng() - 0.5) * 0.6;
    const reach = 0.17 + rng() * 0.05;
    const at = new Vector3(crown.x + Math.cos(a) * reach, 0.6 + rng() * 0.1, crown.z + Math.sin(a) * reach);
    b.blob(at, 0.15 + rng() * 0.05, new Vector3(1, 0.85, 1), LEAF, seed + i + 1, 0.22, shade);
  }
  b.blob(new Vector3(crown.x + (rng() - 0.5) * 0.06, 0.86, crown.z + (rng() - 0.5) * 0.06), 0.15, new Vector3(1, 0.85, 1), LEAF, seed + 9, 0.22, shade);
  return b.geometry();
}

/** A taller, narrower crown in three tiers on a longer clear stem. */
function broadleafTall(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const top = new Vector3((rng() - 0.5) * 0.04, 0.56, (rng() - 0.5) * 0.04);
  trunk(b, top, 0.036, 0.022, BARK);
  limbs(b, rng, new Vector3(top.x, top.y - 0.08, top.z), 2, 0.1, 0.14, 0.017, BARK);
  const shade = crownShade(0.5, 1.02, 0.3);
  b.blob(new Vector3(top.x, 0.74, top.z), 0.15, new Vector3(1, 1.35, 1), LEAF_TALL, seed, 0.2, shade);
  const tiers: readonly (readonly [number, number, number, number])[] = [[3, 0.62, 0.12, 0.14], [2, 0.78, 0.09, 0.13], [1, 0.92, 0.0, 0.11]];
  let k = 1;
  for (const [count, y, reach, r] of tiers) {
    const start = rng() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const a = start + (i / count) * Math.PI * 2;
      b.blob(new Vector3(top.x + Math.cos(a) * reach, y + (rng() - 0.5) * 0.04, top.z + Math.sin(a) * reach), r * (0.9 + rng() * 0.2),
        new Vector3(1, 1.05, 1), LEAF_TALL, seed + k++, 0.2, shade);
    }
  }
  return b.geometry();
}

/** A conifer: a short trunk under five tiers of seven-sided cones, their rims ragged and drooping. */
function cypress(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  trunk(b, new Vector3(0, 0.16, 0), 0.03, 0.022, BARK);
  const slim = 0.92 + rng() * 0.16;
  const shade: Occlusion = (p) => 0.62 + 0.38 * Math.min(1, Math.max(0, (p.y - 0.08) / 0.92));
  for (let k = 0; k < 5; k++) {
    const base = 0.1 + k * 0.155;
    const height = 0.34 - k * 0.03;
    const radius = (0.25 - k * 0.045) * slim;
    const cone = new ConeGeometry(radius, height, 7, 1, false);
    const position = cone.getAttribute('position');
    const p = new Vector3();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      const rim = p.y < 0 && Math.hypot(p.x, p.z) > radius * 0.5;
      if (!rim) continue;
      // A ragged rim of boughs, each corner its own reach, hanging a little.
      const n = noise3(p.x * 9 + k * 5.3, k * 1.7, p.z * 9, seed + k);
      const reach = 1 + n * 0.2;
      p.x *= reach;
      p.z *= reach;
      p.y -= height * (0.08 + 0.06 * (n + 1));
      position.setXYZ(i, p.x, p.y, p.z);
    }
    b.add(cone, new Matrix4().makeTranslation(0, base + height / 2, 0), NEEDLE, shade, 0.25);
  }
  return b.geometry();
}

/** The palm: a curved, ringed trunk under a crown of drooping, toothed fronds. */
function palm(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const lean = 0.12 + rng() * 0.1, turn = rng() * Math.PI * 2;
  const leanDir = new Vector3(Math.cos(turn), 0, Math.sin(turn));
  // The trunk's line: up, bending out with the lean (a quadratic curve).
  const at = (t: number): Vector3 => new Vector3(0, 0.82 * t, 0).addScaledVector(leanDir, lean * t * t);
  b.add(new CylinderGeometry(0.045, 0.058, 1, 6, 1, true), along(new Vector3(0, 0, 0), new Vector3(0, 0.05, 0)), PALM_BARK, OPEN, 0.2);
  const rings = 12;
  for (let s = 0; s < rings; s++) {
    const p0 = at(s / rings), p1 = at((s + 1.08) / rings);
    const r = 0.042 * (1 - 0.35 * (s / rings));
    // Each ring wider at its foot than its top: the stepped bark of a palm.
    b.add(new CylinderGeometry(r * 0.86, r * 1.06, 1, 6, 1, true), along(p0, p1), PALM_BARK, OPEN, 0.25);
  }
  const crown = at(1);
  // Where the fronds spring from: a dark knot of old leaf bases.
  b.add(new IcosahedronGeometry(1, 0), new Matrix4().compose(crown, new Quaternion(), new Vector3(0.05, 0.045, 0.05)), BARK);
  const shade: Occlusion = (p) => 0.7 + 0.3 * Math.min(1, Math.max(0, (p.y - crown.y + 0.25) / 0.35));
  const fronds = 8;
  for (let k = 0; k < fronds; k++) {
    const a = (k / fronds) * Math.PI * 2 + rng() * 0.35;
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new Vector3(-Math.sin(a), 0, Math.cos(a));
    const length = 0.4 + rng() * 0.08;
    const lift = 0.45 + rng() * 0.25;
    const steps = 7;
    const spine: Vector3[] = [crown.clone()];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const angle = lift - t * 1.7;
      const step = new Vector3().addScaledVector(out, Math.cos(angle)).setY(Math.sin(angle)).multiplyScalar(length / steps);
      spine.push(spine[i - 1]!.clone().add(step));
    }
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const width = 0.08 * Math.sin(Math.PI * (0.12 + t * 0.85));
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

/** The flowering ipê: a wide, open, flat-topped crown that in the dry season is nearly all flower. */
function ipe(seed: number, bloom: Tone): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const top = new Vector3((rng() - 0.5) * 0.05, 0.5, (rng() - 0.5) * 0.05);
  trunk(b, top, 0.04, 0.024, BARK);
  limbs(b, rng, new Vector3(top.x, top.y - 0.06, top.z), 4, 0.2, 0.14, 0.018, BARK);
  const shade = crownShade(0.52, 0.95, 0.46);
  b.blob(new Vector3(top.x, 0.76, top.z), 0.19, new Vector3(1, 0.7, 1), bloom, seed, 0.24, shade);
  const lumps = 5;
  const start = rng() * Math.PI * 2;
  // One lump of the ring still in leaf: the tree is flower over a little green.
  const green = Math.floor(rng() * lumps);
  for (let i = 0; i < lumps; i++) {
    const a = start + (i / lumps) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const reach = 0.22 + rng() * 0.05;
    b.blob(new Vector3(top.x + Math.cos(a) * reach, 0.7 + rng() * 0.06, top.z + Math.sin(a) * reach), 0.14 + rng() * 0.04,
      new Vector3(1, 0.72, 1), i === green ? LEAF : bloom, seed + i + 1, 0.24, shade);
  }
  return b.geometry();
}

/** A bush: three lumps of leaves pressed onto the ground, about one and a half times as wide as tall. */
function bush(seed: number, flowering: boolean): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const shade = crownShade(0, 0.85, 0.75);
  // A flowering bush: a scatter of blossoms over the sunlit upper faces.
  const pick = flowering
    ? (c: Vector3): Tone => (c.y > 0.45 && rng() < 0.2 ? FLOWERS[Math.floor(rng() * FLOWERS.length)]! : SHRUB)
    : undefined;
  b.blob(new Vector3(0, 0.42, 0), 0.5, new Vector3(1, 0.8, 1), SHRUB, seed, 0.2, shade, pick, 0);
  b.blob(new Vector3(0.42, 0.3, 0.12 + (rng() - 0.5) * 0.2), 0.36, new Vector3(1, 0.85, 1), SHRUB, seed + 1, 0.2, shade, pick, 0);
  b.blob(new Vector3(-0.38, 0.28, -0.16 + (rng() - 0.5) * 0.2), 0.34, new Vector3(1, 0.85, 1), SHRUB, seed + 2, 0.2, shade, pick, 0);
  return b.geometry();
}

/** A clipped hedge: five lumps in a row, little noise (it is trimmed), darker and denser. */
function hedge(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const shade = crownShade(0, 0.95, 0.8);
  for (let i = 0; i < 5; i++) {
    b.blob(new Vector3((i - 2) * 0.28, 0.48 + rng() * 0.04, (rng() - 0.5) * 0.08), 0.36 + rng() * 0.05, new Vector3(1, 0.92, 0.78),
      HEDGE, seed + i, 0.1, shade, undefined, 0);
  }
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
