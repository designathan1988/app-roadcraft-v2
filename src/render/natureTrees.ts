import {
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  type InterleavedBufferAttribute,
  type MeshDepthMaterial,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { TreePlacement } from './groundCover';
import { FIELD_TINTS, GRASS_TONES } from './terrain';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';

/**
 * THE TREES of the countryside: Kenney's Nature Kit (CC0, docs/CREDITOS.md),
 * hand-made low-poly trees, solid - no leaf cut out of a card anywhere. Their
 * leaves and bark take the terrain's own tones (`terrain.ts` GRASS_TONES and
 * FIELD_TINTS: the deep, lush and olive fields' greens, the soil's brown), so
 * a wood is the colour of the land it grows on.
 *
 * Each stands as its neighbours let it, as trees in a stand grow competing
 * for light and space (Runions et al., "Modeling Trees with a Space
 * Colonization Algorithm"; Palubicki et al., "Self-organizing tree models",
 * SIGGRAPH 2009): in the heart of a wood taller and narrower, at its edge and
 * alone broader, the crown leaning out towards the open side.
 *
 * Three levels by the distance to the camera, as a game's foliage LODs: near,
 * the model itself (50-400 triangles); mid, about a third of it; far, about
 * twenty triangles of the same shape and colours (meshoptimizer). Real
 * shadows from the near and mid levels.
 */

/** The varieties, their file in `public/models/nature/`, and the field tone their leaves take. */
const VARIETIES: readonly { readonly file: string; readonly leaves: 'lush' | 'deep' | 'olive' | 'pine' }[] = [
  { file: 'tree_default', leaves: 'lush' },
  { file: 'tree_oak', leaves: 'deep' },
  { file: 'tree_detailed', leaves: 'lush' },
  { file: 'tree_plateau', leaves: 'olive' },
  { file: 'tree_fat', leaves: 'deep' },
  { file: 'tree_tall', leaves: 'lush' },
  { file: 'tree_pineRoundA', leaves: 'pine' },
  { file: 'tree_pineDefaultA', leaves: 'pine' },
];
/**
 * The models' URLs, as Vite serves and builds them: the project serves no
 * `public/` folder by path (`publicDir: false`), every asset is imported
 * (`elements.ts` does the same).
 */
const TREE_URLS = import.meta.glob('/public/models/nature/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
/** Within this distance of the camera a tree is drawn in full, world units. */
const NEAR_REACH = 350;
/** Within this distance a tree is drawn at mid detail; beyond, at its lightest. */
const MID_REACH = 1800;
/** How far the view moves before the trees are sorted near and far again. */
const LOD_SLACK = 60;
/** The mid level's share of the model's triangles, and the far level's triangles. */
const MID_SHARE = 0.35;
const FAR_TRIANGLES = 20;
/** Neighbours within this reach (world units) make a tree's stand. */
const STAND_REACH = 45;

/** The forest's wind (`groundCover.ts`): a slow sway and a leaf flutter. */
const FOREST_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };

interface Variant {
  /** Near, mid and far: one unit tall, standing on its own origin (the ground). */
  readonly levels: readonly [BufferGeometry, BufferGeometry, BufferGeometry];
}

export interface NatureTreeKit {
  readonly variants: readonly Variant[];
  readonly material: MeshStandardMaterial;
  readonly depth: MeshDepthMaterial;
  dispose(): void;
}

/** sRGB to the linear working space (three's colour management). */
const linear = (c: readonly number[]): Color => new Color(c[0]!, c[1]!, c[2]!).convertSRGBToLinear();
const mixed = (a: readonly number[], b: readonly number[], t: number): number[] => a.map((v, i) => v + (b[i]! - v) * t);
const tinted = (c: readonly number[], f: readonly number[], k = 1): number[] => c.map((v, i) => Math.min(1, v * f[i]! * k));

/**
 * The leaves' colour of a variety, from the terrain's grass tones and its
 * fields' tints - a canopy a shade darker than the grass under it - and the
 * bark's, from its soil.
 */
function leafColour(kind: (typeof VARIETIES)[number]['leaves']): Color {
  const { dark, lit } = GRASS_TONES;
  switch (kind) {
    case 'lush': return linear(tinted(mixed(dark, lit, 0.35), FIELD_TINTS.lush, 0.82));
    case 'deep': return linear(tinted(dark, FIELD_TINTS.deep, 0.9));
    case 'olive': return linear(tinted(mixed(dark, lit, 0.5), FIELD_TINTS.olive, 0.78));
    // The conifers' darker, bluer needles.
    case 'pine': return linear(tinted(dark, [0.62, 0.8, 0.98], 0.85));
  }
}
const BARK = linear(tinted(GRASS_TONES.soil, [1, 1, 1], 0.55));

/**
 * A model's triangles as one geometry, one unit tall on its origin, a colour
 * a vertex: its leaves' and its bark's (the kit names its materials
 * `leafs...` and `woodBark...`).
 */
function variantGeometry(scene: Object3D, leaves: Color): BufferGeometry | null {
  const parts: BufferGeometry[] = [];
  /** An attribute as a plain float array (a glTF may interleave its own). */
  const plain = (a: BufferAttribute | InterleavedBufferAttribute): BufferAttribute => {
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = c === 0 ? a.getX(i) : c === 1 ? a.getY(i) : c === 2 ? a.getZ(i) : a.getW(i);
    }
    return new BufferAttribute(out, a.itemSize);
  };
  scene.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const source = (o.geometry as BufferGeometry).clone();
    source.applyMatrix4(o.matrixWorld);
    const keep = new BufferGeometry();
    keep.setAttribute('position', plain(source.getAttribute('position')));
    if (!source.getAttribute('normal')) source.computeVertexNormals();
    keep.setAttribute('normal', plain(source.getAttribute('normal')));
    const material = Array.isArray(o.material) ? o.material[0] : o.material;
    const name = String((material as { name?: string } | undefined)?.name ?? '');
    const colour = /leaf/i.test(name) ? leaves : BARK;
    const n = keep.getAttribute('position').count;
    const colours = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { colours[i * 3] = colour.r; colours[i * 3 + 1] = colour.g; colours[i * 3 + 2] = colour.b; }
    keep.setAttribute('color', new BufferAttribute(colours, 3));
    keep.setIndex(source.getIndex() ?? [...Array(n).keys()]);
    parts.push(keep);
    source.dispose();
  });
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) return null;
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const height = Math.max(1e-6, box.max.y - box.min.y);
  merged.translate(0, -box.min.y, 0);
  merged.scale(1 / height, 1 / height, 1 / height);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * A coarser level of a model: its corners welded (the kit's faces have their
 * own corners, for their flat shading), simplified to `triangles`, and laid
 * out flat again - each face its own corners and normal, in its colours.
 */
function coarser(full: BufferGeometry, triangles: number): BufferGeometry {
  const position = full.getAttribute('position');
  const colour = full.getAttribute('color');
  const positions = new Float32Array(position.array as ArrayLike<number>);
  // A coarser level is laid out flat, without an index: each corner its own.
  const indexed = full.getIndex();
  const index = indexed ? Uint32Array.from(indexed.array as ArrayLike<number>) : Uint32Array.from({ length: position.count }, (_, i) => i);
  let kept: Uint32Array = index;
  if (MeshoptSimplifier.supported && index.length / 3 > triangles) {
    const remap = MeshoptSimplifier.generatePositionRemap(positions, 3);
    const welded = index.map((v) => remap[v]!);
    const target = Math.max(3, Math.floor(triangles) * 3);
    [kept] = MeshoptSimplifier.simplify(welded, positions, 3, target, 1);
    // The sloppy one only when the careful one cannot get near the budget,
    // and only if it keeps a shape: on these small flat-faced models it can
    // collapse a whole tree to nothing (a far level of 0 triangles: the tree
    // vanished in the distance).
    if (kept.length > target * 1.5) {
      const [sloppy] = MeshoptSimplifier.simplifySloppy(welded, positions, 3, null, target, 1);
      if (sloppy.length >= target * 0.5) kept = sloppy;
    }
  }
  const out = new Float32Array(kept.length * 3), colours = new Float32Array(kept.length * 3);
  for (let i = 0; i < kept.length; i++) {
    const v = kept[i]!;
    out[i * 3] = position.getX(v); out[i * 3 + 1] = position.getY(v); out[i * 3 + 2] = position.getZ(v);
    colours[i * 3] = colour.getX(v); colours[i * 3 + 1] = colour.getY(v); colours[i * 3 + 2] = colour.getZ(v);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(out, 3));
  g.setAttribute('color', new BufferAttribute(colours, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Loads the kit's trees and builds their levels; their material shares the forest's wind. */
export async function loadNatureTrees(_anisotropy: number): Promise<NatureTreeKit> {
  await MeshoptSimplifier.ready;
  const loader = new GLTFLoader();
  const variants: Variant[] = [];
  for (const variety of VARIETIES) {
    const url = TREE_URLS[`/public/models/nature/${variety.file}.glb`];
    if (!url) continue;
    const gltf = await loader.loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const full = variantGeometry(gltf.scene, leafColour(variety.leaves));
    if (!full) continue;
    const triangles = full.getIndex()!.count / 3;
    // Each level from the one before (meshoptimizer's LOD chain): the far one
    // never ends up heavier than the mid one when the simplifier stops short.
    const mid = coarser(full, Math.max(FAR_TRIANGLES, triangles * MID_SHARE));
    const far = coarser(mid, FAR_TRIANGLES);
    const keepFar = far.getAttribute('position').count < mid.getAttribute('position').count;
    if (!keepFar) far.dispose();
    variants.push({ levels: [full, mid, keepFar ? far : mid] });
  }
  if (!variants.length) throw new Error('No tree of the Nature Kit could be read');
  // Opaque and lit as the land is: matt, a little of the sky's sheen.
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.3 });
  applyWind(material, FOREST_WIND, 'nature-trees');
  const depth = windDepthMaterial(FOREST_WIND, 'nature-trees-depth');
  console.info('[nature] tree variants (triangles near / mid / far):',
    variants.map((v) => v.levels.map((g) => (g.getIndex()?.count ?? g.getAttribute('position').count) / 3).join(' / ')).join(', '));
  return {
    variants,
    material,
    depth,
    dispose() {
      for (const v of variants) for (const g of v.levels) g.dispose();
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
  /** Sorts the trees into near and far by their distance to the camera (three's x, y, z), when it has moved. */
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
 * The trees, instanced per variety and level; `updateLod` picks which instance
 * draws where. `room`: how many trees each variety's meshes hold (at least
 * the trees given; more lets `update` take a larger forest without new meshes).
 */
export function buildNatureForest(trees: readonly TreePlacement[], kit: NatureTreeKit, room: readonly number[] = forestRoom(trees, kit)): NatureForest {
  const varieties = kit.variants.length;
  const meshes: InstancedMesh[] = [];
  /**
   * One variety: its mesh by level, how many trees they hold, and the trees
   * it draws with each one's transform (16, column-major) and tint (3).
   */
  interface Group {
    readonly levels: readonly InstancedMesh[];
    readonly capacity: number;
    items: TreePlacement[];
    readonly matrices: Float32Array;
    readonly colours: Float32Array;
  }
  const groups: (Group | null)[] = kit.variants.map((variant, k) => {
    const capacity = Math.max(0, Math.floor(room[k] ?? 0));
    if (capacity === 0) return null;
    const levels = variant.levels.map((geometry, level) => {
      const mesh = new InstancedMesh(geometry, kit.material, capacity);
      mesh.name = `nature-tree-${k}-L${level}`;
      // Real shadows near and mid; far, a tree is a few pixels.
      mesh.castShadow = level < 2;
      mesh.customDepthMaterial = kit.depth;
      // The upper leaves shading the lower is what gives a canopy its depth.
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      // The tint per tree from the start: the program is built once with it.
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
      mesh.count = 0;
      meshes.push(mesh);
      return mesh;
    });
    return { levels, capacity, items: [], matrices: new Float32Array(capacity * 16), colours: new Float32Array(capacity * 3) };
  });
  let sortedX = Infinity, sortedY = Infinity, sortedZ = Infinity;

  const place = (list: readonly TreePlacement[]): boolean => {
    const byVariety: number[][] = kit.variants.map(() => []);
    list.forEach((tree, i) => byVariety[varietyOf(tree, varieties)]!.push(i));
    if (byVariety.some((indices, k) => indices.length > (groups[k]?.capacity ?? 0))) return false;
    const stand = stands(list);
    groups.forEach((g, k) => {
      if (!g) return;
      const indices = byVariety[k]!;
      g.items = indices.map((i) => list[i]!);
      const m = g.matrices, col = g.colours;
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
        // A little variety of green between trees, none of it far from the variety's own.
        const t = 0.9 + ((item.seed * 3.77) % 1) * 0.2;
        col[slot * 3] = t * (0.96 + ((item.seed * 1.3) % 1) * 0.08);
        col[slot * 3 + 1] = t;
        col[slot * 3 + 2] = t * 0.94;
      });
    });
    // Sorted again at the next look, whatever the camera did.
    sortedX = Infinity;
    return true;
  };

  const sort = (x: number, y: number, z: number): void => {
    for (const g of groups) {
      if (!g) continue;
      const counts = [0, 0, 0];
      for (let i = 0; i < g.items.length; i++) {
        const item = g.items[i]!;
        const distance = Math.hypot(item.x - x, item.z - y, -item.y - z);
        const level = distance < NEAR_REACH ? 0 : distance < MID_REACH ? 1 : 2;
        const slot = counts[level]!++;
        const mesh = g.levels[level]!;
        const matrix = mesh.instanceMatrix.array as Float32Array;
        for (let e = 0; e < 16; e++) matrix[slot * 16 + e] = g.matrices[i * 16 + e]!;
        const tint = mesh.instanceColor!.array as Float32Array;
        tint[slot * 3] = g.colours[i * 3]!;
        tint[slot * 3 + 1] = g.colours[i * 3 + 1]!;
        tint[slot * 3 + 2] = g.colours[i * 3 + 2]!;
      }
      g.levels.forEach((mesh, level) => {
        const count = counts[level]!;
        mesh.count = count;
        // Only the instances drawn go to the GPU (`addUpdateRange`); with no
        // range three sends the whole buffer, the forest's full capacity, at
        // every change of level as the camera moves.
        if (count === 0) return;
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        mesh.instanceColor!.addUpdateRange(0, count * 3);
        mesh.instanceColor!.needsUpdate = true;
      });
    }
  };
  place(trees);
  return {
    meshes,
    update: place,
    updateLod(x, y, z) {
      if (Math.hypot(x - sortedX, y - sortedY, z - sortedZ) < LOD_SLACK) return;
      sortedX = x; sortedY = y; sortedZ = z;
      sort(x, y, z);
    },
    dispose() {
      for (const mesh of meshes) mesh.dispose();
    },
  };
}
