import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
  type MeshDepthMaterial,
} from 'three';
import type { TreePlacement } from './groundCover';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';

/**
 * THE TREES: low-poly, faceted, made here - the three the player drew
 * (2026-10-08): the cypress, a narrow column of pointed leaf wedges round a
 * short trunk; the palm, a curved ringed trunk under a crown of drooping,
 * saw-toothed fronds; the oak, a stout trunk opening into branches under a
 * crown of faceted leaf balls. Flat faces, each its own shade of green -
 * lighter where it faces the sky - as the drawings are lit.
 *
 * One model a tree, whatever the distance: the levels of detail of the old
 * kit changed a tree's shape before the player's eyes ("ainda tem lod"), and
 * few trees stand on a map now (`renderer.ts` NATURE_TREES), so the whole
 * model is drawn everywhere.
 *
 * Each stands as its neighbours let it, as trees in a stand grow competing
 * for light and space (Runions et al., "Modeling Trees with a Space
 * Colonization Algorithm"; Palubicki et al., "Self-organizing tree models",
 * SIGGRAPH 2009): in the heart of a wood taller and narrower, at its edge and
 * alone broader, the crown leaning out towards the open side.
 */

/** The models, in seed order: each takes its share of the seed's range (`world/trees.ts` KIND_SLOTS). */
export const TREE_MODELS = ['oak', 'oak', 'cypress', 'cypress', 'palm', 'palm'] as const;
export type TreeModelKind = (typeof TREE_MODELS)[number];
/** A seed (0..1) that grows as this kind of tree, `r` (0..1) choosing among its models. */
export function seedOfKind(kind: TreeModelKind, r: number): number {
  const slots = TREE_MODELS.flatMap((k, i) => (k === kind ? [i] : []));
  const slot = slots[Math.min(slots.length - 1, Math.floor(r * slots.length))]!;
  return (slot + 0.05 + ((r * 7.31) % 1) * 0.9) / TREE_MODELS.length;
}
/** How far the view moves before the trees are sorted again (one level now: kept for the API). */
const LOD_SLACK = 60;
/** Neighbours within this reach (world units) make a tree's stand. */
const STAND_REACH = 45;

/** The forest's wind (`groundCover.ts`): a slow sway and a leaf flutter. */
const FOREST_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };

interface Variant {
  /** The model, one unit tall on its origin (the ground); the same at every distance. */
  readonly levels: readonly [BufferGeometry, BufferGeometry, BufferGeometry];
}

export interface NatureTreeKit {
  readonly variants: readonly Variant[];
  readonly material: MeshStandardMaterial;
  readonly depth: MeshDepthMaterial;
  dispose(): void;
}

/** sRGB hex to the linear working space (three's colour management). */
const hex = (h: number): Color => new Color(h).convertSRGBToLinear();
const LEAF_DARK = hex(0x3c7a1c), LEAF_LIT = hex(0x9ccf3f);
const CYPRESS_DARK = hex(0x356f1f), CYPRESS_LIT = hex(0x86bb3a);
const PALM_DARK = hex(0x4f9a1e), PALM_LIT = hex(0xb6dc45);
const BARK_DARK = hex(0x7a4a24), BARK_LIT = hex(0xb27a40);
const PALM_BARK_DARK = hex(0x9a6532), PALM_BARK_LIT = hex(0xd09a58);

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

/**
 * Triangles laid out flat - each its own three corners, so each face takes
 * its own normal and colour: the faceted look of a low-poly model.
 */
class Builder {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly n = new Vector3();

  constructor(private readonly rng: () => number) {}

  /** A face between two colours: lighter facing up, a little shade of its own. */
  private shade(dark: Color, lit: Color, normal: Vector3, jitter: number): Color {
    const t = Math.min(1, Math.max(0, 0.45 + 0.4 * normal.y + (this.rng() - 0.5) * jitter));
    return dark.clone().lerp(lit, t);
  }

  tri(a: Vector3, b: Vector3, c: Vector3, dark: Color, lit: Color, jitter = 0.35): void {
    this.n.subVectors(b, a).cross(this.c.subVectors(c, a)).normalize();
    const colour = this.shade(dark, lit, this.n, jitter);
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.col.push(colour.r, colour.g, colour.b);
    }
  }

  /** A sheet seen from both sides (a frond): both windings. */
  sheet(a: Vector3, b: Vector3, c: Vector3, dark: Color, lit: Color): void {
    this.tri(a, b, c, dark, lit);
    this.tri(a, c, b, dark, lit);
  }

  /** A three primitive, moved by `m`, its faces each their own shade. */
  add(geometry: BufferGeometry, m: Matrix4, dark: Color, lit: Color, jitter = 0.35): void {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    g.applyMatrix4(m);
    const p = g.getAttribute('position');
    for (let i = 0; i + 2 < p.count; i += 3) {
      this.a.fromBufferAttribute(p, i);
      this.b.fromBufferAttribute(p, i + 1);
      const c = new Vector3().fromBufferAttribute(p, i + 2);
      this.tri(this.a.clone(), this.b.clone(), c, dark, lit, jitter);
    }
    g.dispose();
    geometry.dispose();
  }

  /** The model, standing on its origin, one unit tall. */
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingBox();
    const box = g.boundingBox!;
    const height = Math.max(1e-6, box.max.y - box.min.y);
    g.translate(0, -box.min.y, 0);
    g.scale(1 / height, 1 / height, 1 / height);
    // Flat: each face its own corners, so its own normal.
    g.computeVertexNormals();
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

/** The cypress: a short trunk with a flared foot, a narrow column of leaf wedges to a pointed top. */
function cypress(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  // The trunk and its foot.
  b.add(new CylinderGeometry(0.022, 0.034, 1, 6), along(new Vector3(0, 0.03, 0), new Vector3(0, 0.16, 0)), BARK_DARK, BARK_LIT);
  b.add(new CylinderGeometry(0.03, 0.07, 1, 6), along(new Vector3(0, 0, 0), new Vector3(0, 0.04, 0)), BARK_DARK, BARK_LIT);
  // The core the wedges grow from: no light through the column.
  b.add(new CylinderGeometry(0.012, 0.075, 1, 6), along(new Vector3(0, 0.13, 0), new Vector3(0, 0.95, 0)), CYPRESS_DARK, CYPRESS_LIT, 0.2);
  // The wedges: long diamonds pointing up and out, round the column in a
  // golden spiral, widest a third of the way up and narrowing to the tip.
  const wedges = 34 + Math.floor(rng() * 8);
  const slim = 0.9 + rng() * 0.2;
  for (let i = 0; i < wedges; i++) {
    const t = i / wedges;
    const y = 0.15 + t * 0.78;
    const envelope = Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)) ** 0.7 * (1 - 0.55 * t);
    const r = 0.085 * envelope * slim;
    const a = i * 2.39996 + rng() * 0.4;
    const length = 0.13 * (1 - 0.45 * t) * (0.85 + rng() * 0.3);
    const width = 0.04 * (1 - 0.35 * t) * (0.85 + rng() * 0.3);
    const outward = new Vector3(Math.cos(a), 0, Math.sin(a));
    const tilt = new Quaternion().setFromAxisAngle(new Vector3(-Math.sin(a), 0, Math.cos(a)), 0.28);
    const m = new Matrix4().compose(outward.clone().multiplyScalar(r).setY(y), tilt, new Vector3(width, length * 0.5, width * 0.7));
    b.add(new OctahedronGeometry(1, 0), m, CYPRESS_DARK, CYPRESS_LIT);
  }
  // The pointed top.
  b.add(new OctahedronGeometry(1, 0), new Matrix4().compose(new Vector3(0, 0.95, 0), new Quaternion(), new Vector3(0.03, 0.07, 0.03)), CYPRESS_DARK, CYPRESS_LIT);
  return b.geometry();
}

/** The palm: a curved trunk of stacked rings over a flared foot, a crown of drooping saw-toothed fronds. */
function palm(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  const lean = 0.12 + rng() * 0.1, turn = rng() * Math.PI * 2;
  const leanDir = new Vector3(Math.cos(turn), 0, Math.sin(turn));
  // The trunk's line: up, bending out with the lean (a quadratic curve).
  const at = (t: number): Vector3 => new Vector3(0, 0.82 * t, 0).addScaledVector(leanDir, lean * t * t);
  b.add(new CylinderGeometry(0.045, 0.1, 1, 6), along(new Vector3(0, 0, 0), new Vector3(0, 0.06, 0)), PALM_BARK_DARK, PALM_BARK_LIT);
  const rings = 12;
  for (let s = 0; s < rings; s++) {
    const p0 = at(s / rings), p1 = at((s + 1.08) / rings);
    const r = 0.045 * (1 - 0.35 * (s / rings));
    // Each ring wider at its foot than its top: the stepped bark of a palm.
    b.add(new CylinderGeometry(r * 0.82, r * 1.08, 1, 6), along(p0, p1), PALM_BARK_DARK, PALM_BARK_LIT, 0.25);
  }
  const crown = at(1);
  b.add(new IcosahedronGeometry(1, 0), new Matrix4().compose(crown, new Quaternion(), new Vector3(0.045, 0.04, 0.045)), PALM_BARK_DARK, PALM_BARK_LIT);
  // The fronds: arched out and down, leaflets hanging from both sides of the
  // spine as teeth, longest in the middle of the frond.
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
      const width = 0.085 * Math.sin(Math.PI * (0.12 + t * 0.85));
      const p0 = spine[i]!, p1 = spine[i + 1]!;
      for (const sign of [1, -1]) {
        // A tooth: from the spine, out to the side and hanging down, swept towards the tip.
        const tip = p0.clone().lerp(p1, 0.8).addScaledVector(side, sign * width).add(new Vector3(0, -width * 0.75, 0));
        b.sheet(p0, p1, tip, PALM_DARK, PALM_LIT);
      }
    }
  }
  return b.geometry();
}

/** The oak: a stout trunk on its roots opening into branches, under a broad crown of faceted leaf balls. */
function oak(seed: number): BufferGeometry {
  const rng = random(seed);
  const b = new Builder(rng);
  // The trunk, and its roots spreading at the foot.
  b.add(new CylinderGeometry(0.05, 0.085, 1, 7), along(new Vector3(0, 0, 0), new Vector3(0, 0.44, 0)), BARK_DARK, BARK_LIT, 0.3);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng() * 0.6;
    const foot = new Vector3(Math.cos(a) * 0.14, 0, Math.sin(a) * 0.14);
    b.add(new CylinderGeometry(0.008, 0.03, 1, 4), along(foot, new Vector3(0, 0.12, 0)), BARK_DARK, BARK_LIT);
  }
  // The branches, from the top of the trunk up and out into the crown.
  const branches = 5;
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rng() * 0.5;
    const from = new Vector3(0, 0.34 + rng() * 0.08, 0);
    const to = new Vector3(Math.cos(a) * (0.22 + rng() * 0.08), 0.6 + rng() * 0.1, Math.sin(a) * (0.22 + rng() * 0.08));
    b.add(new CylinderGeometry(0.014, 0.034, 1, 5), along(from, to), BARK_DARK, BARK_LIT);
  }
  // The crown: leaf balls over an ellipsoid - one on top, a ring round the
  // middle, a lower ring further out - and a few inside to close it.
  const centre = new Vector3(0, 0.66, 0);
  const balls: { at: Vector3; r: number }[] = [{ at: new Vector3(0, 0.88, 0), r: 0.17 }];
  const ring = (n: number, y: number, reach: number, r: number): void => {
    const start = rng() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = start + (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.4;
      balls.push({ at: new Vector3(Math.cos(a) * reach, y + (rng() - 0.5) * 0.05, Math.sin(a) * reach), r: r * (0.85 + rng() * 0.3) });
    }
  };
  ring(5, 0.76, 0.2, 0.16);
  ring(6, 0.6, 0.32, 0.15);
  balls.push({ at: centre.clone(), r: 0.2 });
  for (const ball of balls) {
    b.add(new IcosahedronGeometry(1, 1), new Matrix4().compose(ball.at, new Quaternion(), new Vector3(ball.r, ball.r * 0.88, ball.r)), LEAF_DARK, LEAF_LIT);
  }
  return b.geometry();
}

/** Makes the trees; their material shares the forest's wind. */
export async function loadNatureTrees(_anisotropy: number): Promise<NatureTreeKit> {
  const makers = { oak, cypress, palm } as const;
  const variants: Variant[] = TREE_MODELS.map((kind, i) => {
    const g = makers[kind](0x7ee5 + i * 7919);
    return { levels: [g, g, g] };
  });
  // Opaque, matt, faceted: each face lit flat, as the drawings are.
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: true, envMapIntensity: 0.35 });
  applyWind(material, FOREST_WIND, 'nature-trees-lowpoly');
  const depth = windDepthMaterial(FOREST_WIND, 'nature-trees-lowpoly-depth');
  console.info('[nature] low-poly trees (triangles):', variants.map((v, i) => `${TREE_MODELS[i]} ${v.levels[0].getAttribute('position').count / 3}`).join(', '));
  return {
    variants,
    material,
    depth,
    dispose() {
      for (const v of variants) v.levels[0].dispose();
      material.dispose();
      depth.dispose();
    },
  };
}

export interface NatureForest {
  readonly meshes: readonly InstancedMesh[];
  /**
   * Takes these trees in place of the ones it holds, written into the meshes
   * it already has: a buffer cannot be resized, but its content can be
   * rewritten (three's manual, "How to update things"). False when a variety
   * has more trees than its meshes hold: a new forest is built then.
   */
  update(trees: readonly TreePlacement[]): boolean;
  /** Writes the trees into their meshes when the camera has moved (one level: the same model at every distance). */
  updateLod(x: number, y: number, z: number): void;
  dispose(): void;
}

/** The variety a tree is grown as, from its seed. */
const varietyOf = (tree: { readonly seed: number }, varieties: number): number => Math.min(varieties - 1, Math.floor(tree.seed * varieties));

/** How many of these trees (or places a tree may stand, by seed) each variety of the kit takes: the room a forest built for them needs. */
export function forestRoom(trees: readonly { readonly seed: number }[], kit: NatureTreeKit): number[] {
  const room = kit.variants.map(() => 0);
  for (const tree of trees) room[varietyOf(tree, room.length)]!++;
  return room;
}

/** A cell of the stand grid as one number (a string key per tree and neighbour was most of the cost). */
const standKey = (cx: number, cy: number): number => cx * 100_003 + cy;

/**
 * How each tree stands among its neighbours: how crowded it is (0 alone .. 1
 * deep in a wood) and which way the open ground lies (unit, map axes).
 */
function stands(trees: readonly TreePlacement[]): { crowd: Float32Array; openX: Float32Array; openY: Float32Array } {
  const cell = STAND_REACH;
  const grid = new Map<number, number[]>();
  trees.forEach((t, i) => {
    const key = standKey(Math.floor(t.x / cell), Math.floor(t.y / cell));
    const list = grid.get(key);
    if (list) list.push(i); else grid.set(key, [i]);
  });
  const crowd = new Float32Array(trees.length), openX = new Float32Array(trees.length), openY = new Float32Array(trees.length);
  trees.forEach((t, i) => {
    const cx = Math.floor(t.x / cell), cy = Math.floor(t.y / cell);
    let n = 0, ax = 0, ay = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(standKey(cx + dx, cy + dy)) ?? []) {
          if (j === i) continue;
          const o = trees[j]!;
          const ex = o.x - t.x, ey = o.y - t.y;
          const d = Math.hypot(ex, ey);
          if (d > STAND_REACH || d < 1e-3) continue;
          const w = 1 - d / STAND_REACH;
          n += w; ax += (ex / d) * w; ay += (ey / d) * w;
        }
      }
    }
    crowd[i] = Math.min(1, n / 6);
    const a = Math.hypot(ax, ay);
    openX[i] = a > 1e-3 ? -ax / a : 0;
    openY[i] = a > 1e-3 ? -ay / a : 0;
  });
  return { crowd, openX, openY };
}

/**
 * The trees, instanced per variety: one mesh each, the whole model at every
 * distance. `room`: how many trees each variety's mesh holds (at least the
 * trees given; more lets `update` take a larger forest without new meshes).
 */
export function buildNatureForest(trees: readonly TreePlacement[], kit: NatureTreeKit, room: readonly number[] = forestRoom(trees, kit)): NatureForest {
  const varieties = kit.variants.length;
  const meshes: InstancedMesh[] = [];
  interface Group {
    readonly mesh: InstancedMesh;
    readonly capacity: number;
    count: number;
  }
  const groups: (Group | null)[] = kit.variants.map((variant, k) => {
    const capacity = Math.max(0, Math.floor(room[k] ?? 0));
    if (capacity === 0) return null;
    const mesh = new InstancedMesh(variant.levels[0], kit.material, capacity);
    mesh.name = `nature-tree-${TREE_MODELS[k] ?? k}-${k}`;
    mesh.castShadow = true;
    mesh.customDepthMaterial = kit.depth;
    // The upper leaves shading the lower is what gives a crown its depth.
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    // The tint per tree from the start: the program is built once with it.
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.count = 0;
    meshes.push(mesh);
    return { mesh, capacity, count: 0 };
  });

  const place = (list: readonly TreePlacement[]): boolean => {
    const byVariety: number[][] = kit.variants.map(() => []);
    list.forEach((tree, i) => byVariety[varietyOf(tree, varieties)]!.push(i));
    if (byVariety.some((indices, k) => indices.length > (groups[k]?.capacity ?? 0))) return false;
    const stand = stands(list);
    groups.forEach((g, k) => {
      if (!g) return;
      const indices = byVariety[k]!;
      const m = g.mesh.instanceMatrix.array as Float32Array;
      const col = g.mesh.instanceColor!.array as Float32Array;
      indices.forEach((i, slot) => {
        const item = list[i]!;
        const crowd = stand.crowd[i]!;
        // Deep in a wood taller and narrower; at its edge and alone broader,
        // the crown leaning out over the open side (a shear, the foot kept).
        const tall = item.size * (0.92 + 0.22 * crowd);
        const wide = item.size * (1.12 - 0.3 * crowd) * (0.94 + ((item.seed * 5.3) % 1) * 0.12);
        const lean = 0.22 * (1 - crowd) * Math.min(1, crowd * 4);
        const sx = stand.openX[i]! * lean, sz = -stand.openY[i]! * lean;
        const c = Math.cos(item.yaw), s = Math.sin(item.yaw);
        // World = translate * shear * rotateY * scale, column by column as
        // three keeps a matrix (`Matrix4.elements`).
        const o = slot * 16;
        m[o] = c * wide; m[o + 1] = 0; m[o + 2] = -s * wide; m[o + 3] = 0;
        m[o + 4] = sx * tall; m[o + 5] = tall; m[o + 6] = sz * tall; m[o + 7] = 0;
        m[o + 8] = s * wide; m[o + 9] = 0; m[o + 10] = c * wide; m[o + 11] = 0;
        m[o + 12] = item.x; m[o + 13] = item.z; m[o + 14] = -item.y; m[o + 15] = 1;
        // A little variety of green between trees, none of it far from the model's own.
        const t = 0.9 + ((item.seed * 3.77) % 1) * 0.2;
        col[slot * 3] = t * (0.96 + ((item.seed * 1.3) % 1) * 0.08);
        col[slot * 3 + 1] = t;
        col[slot * 3 + 2] = t * 0.94;
      });
      g.count = indices.length;
      g.mesh.count = g.count;
      // Only the instances drawn go to the GPU (`addUpdateRange`).
      if (g.count === 0) return;
      g.mesh.instanceMatrix.clearUpdateRanges();
      g.mesh.instanceMatrix.addUpdateRange(0, g.count * 16);
      g.mesh.instanceMatrix.needsUpdate = true;
      g.mesh.instanceColor!.clearUpdateRanges();
      g.mesh.instanceColor!.addUpdateRange(0, g.count * 3);
      g.mesh.instanceColor!.needsUpdate = true;
    });
    return true;
  };
  place(trees);
  let lastX = Infinity, lastY = Infinity, lastZ = Infinity;
  return {
    meshes,
    update: place,
    updateLod(x, y, z) {
      // One model at every distance: nothing to sort as the camera moves.
      if (Math.hypot(x - lastX, y - lastY, z - lastZ) < LOD_SLACK) return;
      lastX = x; lastY = y; lastZ = z;
    },
    dispose() {
      for (const mesh of meshes) mesh.dispose();
    },
  };
}
