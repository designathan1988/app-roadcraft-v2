import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  IcosahedronGeometry,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Material,
  type MeshDepthMaterial,
} from 'three';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';

/**
 * THE ONE TREE STYLE of the game: every tree and bush on the map - the
 * countryside's and the planted ones (`natureTrees.ts`), the street, lot and
 * garden trees (`propGeometry.ts`, drawn by `scenery.ts`) and the painted
 * woods' stand-ins (`groundCover.ts`) - is grown here, so a city park and the
 * wood beside it are one family (the player, 2026-10-08: three kits side by
 * side, "não tem padronização alguma").
 *
 * Built as games build light stylized trees (the player, 2026-10-08: "a
 * técnica de alpha, que faz ficar bem leve e bonita"): a low-poly trunk and a
 * small, dark inner crown - the shaded heart - covered by FOLIAGE CARDS:
 * quads of a leaf-cluster texture, alpha-cut, turned to face the eye
 * (billboards, so no card is ever seen edge-on), all lit with normals
 * pointing out from the crown's centre, so the canopy shades as one soft mass
 * (Polycount and SideFX on stylized foliage; the fluffy-tree write-ups of
 * Pontus Karlsson and Michael Dougall). The cut edge is smoothed by alpha to
 * coverage on the multisampled target (three: "smooth aliasing on
 * alphaTest-clipped edges"). Conifers and palms keep their geometry: needles
 * and fronds read better as facets than as clusters.
 *
 * Proportions from a professional low-poly kit (Kenney's Nature Kit,
 * `public/models/nature/`: a crown 0.35 to 0.6 of the height across, a short
 * clear trunk). Colour: sRGB hex read ONCE into the linear working space
 * (three's colour management since r152).
 *
 * Every model is ONE unit tall with its root at the origin (the wind shader,
 * `wind.ts`, reads local y as the fraction of the height). The body is
 * non-indexed with position, normal and colour; the cards carry, besides,
 * a uv and each corner's offset in the view's plane (`aCorner`).
 */

export type LowPolyKind = 'oak' | 'broadleafTall' | 'cypress' | 'palm' | 'ipeYellow' | 'ipePink' | 'bush' | 'bushFlowering' | 'hedge';

/** A tree's two parts: its body (trunk, inner crown, or the whole of a conifer or palm) and its foliage cards. */
export interface LowPolyParts {
  readonly body: BufferGeometry;
  readonly cards: BufferGeometry | null;
}

interface Tone {
  readonly dark: Color;
  readonly lit: Color;
}
/** Two sRGB hex colours, converted once into the linear working space by `Color`. */
const tone = (dark: number, lit: number): Tone => ({ dark: new Color(dark), lit: new Color(lit) });
// Seen in the game's own light (ACES at exposure 1).
const LEAF = tone(0x3d5e2a, 0x7fa34b);
const LEAF_TALL = tone(0x36552d, 0x6f9452);
const NEEDLE = tone(0x2b4b2d, 0x587c49);
const FROND = tone(0x3e6026, 0x7fa448);
const BARK = tone(0x4a3c2f, 0x7d6853);
const PALM_BARK = tone(0x5a4c3e, 0x948268);
const BLOOM_YELLOW = tone(0xb8892a, 0xe6bd4c);
const BLOOM_PINK = tone(0x9a5078, 0xd88ab0);
const SHRUB = tone(0x365a28, 0x6b9145);
const HEDGE = tone(0x2e4c24, 0x5c7d3a);
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

/** A point of a crown's surface the foliage cards stand on: where, which way is out, its leaf colour, its height in the crown (0..1). */
interface LeafPoint {
  readonly p: Vector3;
  readonly n: Vector3;
  readonly tone: Tone;
  readonly height: number;
}

/**
 * Triangles laid out flat - each its own three corners, so each face takes
 * its own normal and colour - and the crown's leaf points, for its cards.
 */
class Builder {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly n = new Vector3();
  private readonly e = new Vector3();
  private readonly centre = new Vector3();
  readonly leaves: LeafPoint[] = [];

  constructor(readonly rng: () => number) {}

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
   * pushed in and out by a slow noise and a little detail, squashed by
   * `squash`, at `at`. Below `floor` it is pressed flat (a bush). `leafy`: it
   * is the shaded heart under foliage cards - drawn darker, its surface
   * recorded as the cards' leaf points.
   */
  mass(at: Vector3, radius: number, squash: Vector3, t: Tone, seed: number, roughness: number, occlusion: Occlusion,
    leafy: boolean, pick?: (centre: Vector3) => Tone, floor = -Infinity): void {
    const solid = new IcosahedronGeometry(1, 1);
    const position = solid.getAttribute('position');
    const p = new Vector3();
    const top = radius * squash.y;
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      const big = noise3(p.x * 1.1 + seed * 3.1, p.y * 1.1, p.z * 1.1, seed);
      const small = noise3(p.x * 2.6, p.y * 2.6 + seed * 1.7, p.z * 2.6, seed + 17);
      p.multiplyScalar(radius * (1 + big * roughness + small * roughness * 0.3)).multiply(squash).add(at);
      if (p.y < floor) p.y = floor + (p.y - floor) * 0.2;
      position.setXYZ(i, p.x, p.y, p.z);
      if (leafy && i % 3 === 0) {
        const n = p.clone().sub(at).normalize();
        const height = Math.min(1, Math.max(0, (p.y - (at.y - top)) / Math.max(1e-6, 2 * top)));
        this.leaves.push({ p: p.clone(), n, tone: pick ? pick(p) : t, height });
      }
    }
    // The heart under the cards is their shade: what shows of it between
    // them reads as depth in the canopy, not as a solid.
    const heart: Occlusion = leafy ? (c) => occlusion(c) * 0.5 : occlusion;
    this.add(solid, new Matrix4(), t, heart, 0.15, pick);
  }

  /**
   * The body and `count` cards of `size` on the leaf points, both stood on
   * the origin and scaled to one unit tall. Each card faces out of the crown
   * and is lit with the crown's normal there; lighter towards the top, each
   * its own shade.
   */
  finish(count: number, size: number): LowPolyParts {
    const body = new BufferGeometry();
    body.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    body.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    body.computeBoundingBox();
    const box = body.boundingBox!;
    // Where each card goes, before the model is scaled: a little out from
    // the heart's surface. The tree's height counts the cards' reach above
    // the heart, so a tree of a given size is that tall, crown and all.
    const placed: { leaf: LeafPoint; s: number; c: Vector3 }[] = [];
    let top = box.max.y;
    for (let k = 0; k < (this.leaves.length > 0 ? count : 0); k++) {
      const leaf = this.leaves[Math.floor(this.rng() * this.leaves.length)]!;
      const s = size * (0.75 + this.rng() * 0.5);
      const c = leaf.p.clone().addScaledVector(leaf.n, s * (0.1 + this.rng() * 0.2));
      top = Math.max(top, c.y + s * 0.45);
      placed.push({ leaf, s, c });
    }
    const lift = -box.min.y;
    const scale = 1 / Math.max(1e-6, top - box.min.y);
    body.translate(0, lift, 0);
    body.scale(scale, scale, scale);
    // Non-indexed: each face its own corners, so its own normal.
    body.computeVertexNormals();
    body.computeBoundingBox();
    body.computeBoundingSphere();
    if (placed.length === 0) return { body, cards: null };

    const positions: number[] = [], normals: number[] = [], colours: number[] = [], uvs: number[] = [], corners: number[] = [];
    for (const { leaf, s, c } of placed) {
      c.y += lift;
      c.multiplyScalar(scale);
      const roll = this.rng() * Math.PI * 2;
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const k0 = Math.min(1, 0.45 + 0.55 * leaf.height) * (0.88 + this.rng() * 0.24);
      const t = leaf.tone;
      const r = t.dark.r + (t.lit.r - t.dark.r) * k0, g = t.dark.g + (t.lit.g - t.dark.g) * k0, b = t.dark.b + (t.lit.b - t.dark.b) * k0;
      // The normal out of the crown, lifted a little: the canopy's top takes the sky.
      const nx = leaf.n.x, ny = leaf.n.y * 0.8 + 0.2, nz = leaf.n.z;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const corner = (u: number, w: number): void => {
        // Every corner at the card's centre; the shader spreads it in the
        // view's plane by its own offset, turned by the card's roll.
        positions.push(c.x, c.y, c.z);
        const ou = (u - 0.5) * s * scale, ow = (w - 0.5) * s * scale;
        corners.push(ou * cr - ow * sr, ou * sr + ow * cr);
        normals.push(nx / nl, ny / nl, nz / nl);
        colours.push(r, g, b);
        uvs.push(u, w);
      };
      corner(0, 0); corner(1, 0); corner(1, 1);
      corner(0, 0); corner(1, 1); corner(0, 1);
    }
    const cards = new BufferGeometry();
    cards.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    cards.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    cards.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
    cards.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    cards.setAttribute('aCorner', new BufferAttribute(new Float32Array(corners), 2));
    cards.computeBoundingBox();
    cards.computeBoundingSphere();
    // The cards reach past their centres by up to their size.
    if (cards.boundingSphere) cards.boundingSphere.radius += size * scale;
    return { body, cards };
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

/** A six-sided trunk from the ground to `top`, tapering from `r0` to `r1`, open at its ends (in the ground and the crown). */
function trunk(b: Builder, top: Vector3, r0: number, r1: number, bark: Tone): void {
  b.add(new CylinderGeometry(r1, r0, 1, 6, 1, true), along(new Vector3(0, 0, 0), top), bark, OPEN, 0.1);
}

/** Limbs from near the top of the trunk out into the crown, each `r0` thick at the trunk: seen between the cards. */
function limbs(b: Builder, from: Vector3, count: number, reach: number, rise: number, r0: number, bark: Tone): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + b.rng() * 0.7;
    const to = new Vector3(from.x + Math.cos(a) * reach * (0.8 + b.rng() * 0.3), from.y + rise * (0.8 + b.rng() * 0.4), from.z + Math.sin(a) * reach * (0.8 + b.rng() * 0.3));
    b.add(new CylinderGeometry(r0 * 0.45, r0, 1, 5, 1, true), along(from, to), bark, OPEN, 0.1);
  }
}

/** The shade tree: a broad crown of cards over a lumpy heart, on a short stout trunk. */
function oak(seed: number): LowPolyParts {
  const b = new Builder(random(seed));
  const top = new Vector3((b.rng() - 0.5) * 0.04, 0.42, (b.rng() - 0.5) * 0.04);
  trunk(b, top, 0.062, 0.04, BARK);
  limbs(b, new Vector3(top.x, top.y - 0.06, top.z), 3, 0.16, 0.16, 0.024, BARK);
  // A small heart under large cards (the forest's old card trees: 36 cards
  // of 0.48 over a heart of 0.19): with the heart as wide as the crown, its
  // facets showed between the cards and the tree still read as faceted balls
  // (the player, 2026-10-08: "ainda tá com as árvores antigas").
  const shade = crownShade(0.3, 0.98, 0.34);
  b.mass(new Vector3(top.x, 0.62, top.z), 0.19, new Vector3(1.05, 0.9, 1.05), LEAF, seed, 0.22, shade, true);
  const a = b.rng() * Math.PI * 2;
  b.mass(new Vector3(top.x + Math.cos(a) * 0.13, 0.64, top.z + Math.sin(a) * 0.13), 0.13, new Vector3(1, 0.88, 1), LEAF, seed + 5, 0.2, shade, true);
  return b.finish(40, 0.44);
}

/** A tall, narrow crown of cards on a longer clear stem. */
function broadleafTall(seed: number): LowPolyParts {
  const b = new Builder(random(seed));
  const top = new Vector3((b.rng() - 0.5) * 0.03, 0.4, (b.rng() - 0.5) * 0.03);
  trunk(b, top, 0.05, 0.032, BARK);
  limbs(b, new Vector3(top.x, top.y - 0.05, top.z), 2, 0.1, 0.16, 0.02, BARK);
  const shade = crownShade(0.26, 1.0, 0.24);
  b.mass(new Vector3(top.x, 0.66, top.z), 0.14, new Vector3(1, 1.7, 1), LEAF_TALL, seed, 0.2, shade, true);
  return b.finish(34, 0.34);
}

/** The cypress: a narrow column of four seven-sided tiers over a short trunk, their rims ragged and hanging. Needles read as facets: no cards. */
function cypress(seed: number): LowPolyParts {
  const b = new Builder(random(seed));
  trunk(b, new Vector3(0, 0.18, 0), 0.034, 0.024, BARK);
  const slim = 0.92 + b.rng() * 0.16;
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
  return b.finish(0, 0);
}

/** The palm: a curved, ringed trunk under a crown of drooping, toothed fronds. No cards. */
function palm(seed: number): LowPolyParts {
  const b = new Builder(random(seed));
  const lean = 0.12 + b.rng() * 0.1, turn = b.rng() * Math.PI * 2;
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
    const a = (k / fronds) * Math.PI * 2 + b.rng() * 0.35;
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new Vector3(-Math.sin(a), 0, Math.cos(a));
    const length = 0.4 + b.rng() * 0.08;
    const lift = 0.45 + b.rng() * 0.25;
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
  return b.finish(0, 0);
}

/** The flowering ipê: one wide, flat crown of cards, flower over the top and the last leaves' green underneath. */
function ipe(seed: number, bloom: Tone): LowPolyParts {
  const b = new Builder(random(seed));
  const top = new Vector3((b.rng() - 0.5) * 0.05, 0.44, (b.rng() - 0.5) * 0.05);
  trunk(b, top, 0.058, 0.036, BARK);
  limbs(b, new Vector3(top.x, top.y - 0.05, top.z), 4, 0.2, 0.14, 0.022, BARK);
  const shade = crownShade(0.34, 0.95, 0.42);
  const centre = 0.62;
  const pick = (c: Vector3): Tone => (c.y < centre - 0.1 ? LEAF : bloom);
  b.mass(new Vector3(top.x, centre, top.z), 0.2, new Vector3(1.25, 0.65, 1.25), bloom, seed, 0.2, shade, true, pick);
  return b.finish(54, 0.46);
}

/** A bush: one lump of leaves pressed onto the ground under a coat of cards, about one and a half times as wide as tall. */
function bush(seed: number, flowering: boolean): LowPolyParts {
  const b = new Builder(random(seed));
  const shade = crownShade(0, 0.95, 0.7);
  // A flowering bush: a scatter of blossoms over the sunlit upper side.
  const pick = flowering
    ? (c: Vector3): Tone => (c.y > 0.5 && b.rng() < 0.3 ? FLOWERS[Math.floor(b.rng() * FLOWERS.length)]! : SHRUB)
    : undefined;
  b.mass(new Vector3(0, 0.42, 0), 0.36, new Vector3(1.5, 1, 1.3), SHRUB, seed, 0.2, shade, true, pick, 0);
  return b.finish(16, 0.62);
}

/** A clipped hedge: one long, trimmed block of leaves under a coat of cards. */
function hedge(seed: number): LowPolyParts {
  const b = new Builder(random(seed));
  const shade = crownShade(0, 0.95, 0.9);
  b.mass(new Vector3(0, 0.46, 0), 0.4, new Vector3(2, 1, 0.8), HEDGE, seed, 0.08, shade, true, undefined, 0);
  return b.finish(20, 0.56);
}

/** A tree or bush of this kind, grown from `seed` (the same seed, the same model): its body and its foliage cards. */
export function lowPolyTreeParts(kind: LowPolyKind, seed: number): LowPolyParts {
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

/**
 * A cluster of small leaves on a card: many leaves in a rounded clump with
 * ragged gaps, each leaf its own shade, the alpha cut round them. Grey: the
 * card's vertex colour gives it the species' green. One for the whole game.
 */
let clusterTexture: CanvasTexture | null | undefined;
function leafClusterTexture(): CanvasTexture | null {
  if (clusterTexture !== undefined) return clusterTexture;
  if (typeof document === 'undefined') return (clusterTexture = null);
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return (clusterTexture = null);
  const rng = random(0xc1a5);
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 300; i++) {
    const a = rng() * Math.PI * 2;
    // Denser at the heart of the clump, ragged at its rim.
    const r = Math.pow(rng(), 0.7) * 112;
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r * 0.92;
    const len = 14 + rng() * 10;
    const wid = 6 + rng() * 4;
    const shade = 150 + Math.floor(rng() * 105);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rng() * Math.PI * 2);
    ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
    ctx.beginPath();
    ctx.moveTo(-len / 2, 0);
    ctx.quadraticCurveTo(0, -wid, len / 2, 0);
    ctx.quadraticCurveTo(0, wid, -len / 2, 0);
    ctx.fill();
    ctx.restore();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return (clusterTexture = texture);
}

/**
 * Turns a material's foliage cards to face the camera - or the light, in a
 * shadow pass: each corner spread from its card's centre in the view's plane
 * by its offset (`aCorner`), scaled by the instance's size.
 */
function billboardCards(material: Material, key: string): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aCorner;`)
      .replace('mvPosition = modelViewMatrix * mvPosition;', `mvPosition = modelViewMatrix * mvPosition;
        {
          float cardScale = 1.0;
          #ifdef USE_INSTANCING
            cardScale = 0.5 * (length(instanceMatrix[0].xyz) + length(instanceMatrix[1].xyz));
          #endif
          mvPosition.xy += aCorner * cardScale;
        }`);
  };
  const cacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${cacheKey()}-billboard-${key}`;
}

/** The foliage cards' material (leaf-cluster texture, alpha to coverage, billboards, the wind) and the depth material their shadows would use. */
export function leafCardMaterials(wind: WindResponse, key: string): { material: MeshStandardMaterial; depth: MeshDepthMaterial } {
  const map = leafClusterTexture();
  const material = new MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, map, alphaTest: 0.5, alphaToCoverage: true, side: DoubleSide,
    roughness: 0.8, metalness: 0, envMapIntensity: 0.3,
  });
  applyWind(material, wind, `${key}-cards`);
  billboardCards(material, key);
  const depth = windDepthMaterial(wind, `${key}-cards`);
  billboardCards(depth, `${key}-depth`);
  depth.map = map;
  depth.alphaTest = 0.5;
  return { material, depth };
}
