import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Quaternion,
  RGBADepthPacking,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Texture,
} from 'three';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import type { TreePlacement } from './groundCover';
import { applyWind, type WindResponse } from './wind';

/**
 * THE TREES of the countryside: hand-made models (Quaternius, "Stylized
 * Nature MegaKit" - five common broadleaf trees, trunk and branches and
 * clusters of painted leaves) in place of the procedural ball of cards that
 * read as a blurred sticker (the player, 2026-10-07: take what is ready).
 *
 * Each in two levels of detail, swapped by the distance to the view as a
 * game's foliage LODs are: near, the model with its bark simplified (meshopt)
 * and its leaf clusters round a solid heart; beyond, a solid crown of a few lumps where the
 * model's leaves are, shaded as one volume, on a plain trunk. Alpha-tested
 * leaves smaller than a pixel alias into speckle (Ben Golus, "Anti-aliased
 * Alpha Test"), and thinned leaf cards left the woods a pin-cushion of dark
 * specks and trunks (the player, 2026-10-07); a solid proxy is how a canopy
 * reads from afar - the rounded carpet of crowns of the diorama the player
 * holds up - and costs a fraction of the cards.
 */

const MODELS = ['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'CommonTree_4', 'CommonTree_5'];
/** The files' served URLs (the game serves no public folder; Vite hands each its own). */
const URLS = import.meta.glob('/public/models/nature/*.{gltf,bin,png}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const url = (file: string): string => {
  const found = URLS[`/public/models/nature/${file}`];
  if (!found) throw new Error(`nature model file missing: ${file}`);
  return found;
};
/** Within this distance of the view's ground a tree is drawn in full, world units. */
const NEAR_REACH = 420;
/** How far the view moves before the trees are sorted near and far again. */
const LOD_SLACK = 60;
/** Lumps in a far crown. */
const CROWN_LUMPS = 5;
/** The leaves' green as the near trees show it (texture times tint), and the bark's brown; linear. */
const CROWN_GREEN: readonly [number, number, number] = [0.075, 0.18, 0.02];
const CROWN_BARK: readonly [number, number, number] = [0.06, 0.04, 0.03];

/** The forest's wind (`groundCover.ts`): a slow sway and a leaf flutter. */
const FOREST_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };

interface TreeParts {
  readonly bark: BufferGeometry;
  readonly heart: BufferGeometry;
  readonly leaves: BufferGeometry;
}

export interface NatureTreeKit {
  readonly variants: readonly { readonly near: TreeParts; readonly far: BufferGeometry }[];
  readonly barkMaterial: MeshStandardMaterial;
  readonly leafMaterial: MeshStandardMaterial;
  readonly leafDepth: MeshDepthMaterial;
  readonly crownMaterial: MeshStandardMaterial;
  dispose(): void;
}

interface Primitive {
  readonly material: string;
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  readonly colour: Float32Array;
  readonly index: Uint32Array;
}

/** The primitives of a glTF of plain float attributes and 16-bit indices, its images left alone. */
async function readGltf(name: string): Promise<Primitive[]> {
  const json = await (await fetch(url(`${name}.gltf`))).json() as {
    meshes: { primitives: { attributes: Record<string, number>; indices: number; material: number }[] }[];
    accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[];
    bufferViews: { byteOffset?: number }[];
    materials: { name: string }[];
    buffers: { uri: string }[];
  };
  const bin = await (await fetch(url(json.buffers[0]!.uri))).arrayBuffer();
  const width: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (i: number): Float32Array | Uint32Array => {
    const a = json.accessors[i]!;
    const offset = (json.bufferViews[a.bufferView]!.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const n = a.count * width[a.type]!;
    if (a.componentType === 5126) return new Float32Array(bin.slice(offset, offset + n * 4));
    if (a.componentType === 5123) return Uint32Array.from(new Uint16Array(bin.slice(offset, offset + n * 2)));
    return new Uint32Array(bin.slice(offset, offset + n * 4));
  };
  return json.meshes.flatMap((mesh) => mesh.primitives.map((p) => ({
    material: json.materials[p.material]!.name,
    position: read(p.attributes['POSITION']!) as Float32Array,
    normal: read(p.attributes['NORMAL']!) as Float32Array,
    uv: read(p.attributes['TEXCOORD_0']!) as Float32Array,
    colour: read(p.attributes['COLOR_0']!) as Float32Array,
    index: read(p.indices) as Uint32Array,
  })));
}

function geometryOf(p: Primitive, index: Uint32Array, height: number): BufferGeometry {
  const g = new BufferGeometry();
  const position = new Float32Array(p.position.length);
  for (let i = 0; i < position.length; i++) position[i] = p.position[i]! / height;
  // RGB of the vertex colour (the bark's baked occlusion; the leaves' own, `crownShaded`).
  const colour = new Float32Array((p.colour.length / 4) * 3);
  for (let i = 0, j = 0; i < p.colour.length; i += 4, j += 3) {
    colour[j] = p.colour[i]!; colour[j + 1] = p.colour[i + 1]!; colour[j + 2] = p.colour[i + 2]!;
  }
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(p.normal.slice(), 3));
  g.setAttribute('uv', new BufferAttribute(p.uv.slice(), 2));
  g.setAttribute('color', new BufferAttribute(colour, 3));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/** Simplified to `fraction` of its triangles (meshopt), or as near as the error allows. */
function simplified(p: Primitive, fraction: number): Uint32Array {
  const target = Math.max(3, Math.floor((p.index.length * fraction) / 3) * 3);
  return MeshoptSimplifier.simplify(p.index, p.position, 3, target, 0.02, [])[0];
}

/** Each leaf cluster (a connected piece of the leaf mesh) grown by `growth` about its own middle. */
function grownLeaves(p: Primitive, growth: number): Primitive {
  const vertices = p.position.length / 3;
  const parent = Int32Array.from({ length: vertices }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  };
  for (let t = 0; t < p.index.length; t += 3) {
    const a = root(p.index[t]!), b = root(p.index[t + 1]!);
    parent[b] = a;
    parent[root(p.index[t + 2]!)] = a;
  }
  const sum = new Map<number, [number, number, number, number]>();
  for (let v = 0; v < vertices; v++) {
    const r = root(v);
    const s = sum.get(r) ?? [0, 0, 0, 0];
    s[0] += p.position[v * 3]!; s[1] += p.position[v * 3 + 1]!; s[2] += p.position[v * 3 + 2]!; s[3]++;
    sum.set(r, s);
  }
  const position = p.position.slice();
  for (let v = 0; v < vertices; v++) {
    const s = sum.get(root(v))!;
    for (let k = 0; k < 3; k++) {
      const mid = s[k]! / s[3]!;
      position[v * 3 + k] = mid + (p.position[v * 3 + k]! - mid) * growth;
    }
  }
  return { ...p, position };
}

const smooth = (a: number, b: number, t: number): number => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/** The crown's bounding ellipsoid: centre and radii. */
function crownEllipsoid(position: Float32Array): { c: number[]; r: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, position[i + k]!); max[k] = Math.max(max[k]!, position[i + k]!); }
  }
  return {
    c: [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2),
    r: [0, 1, 2].map((k) => Math.max(1e-3, (max[k]! - min[k]!) / 2)),
  };
}

/** The ellipsoid's normal at `p` and the crown's occlusion there (dark deep inside and underneath). */
function crownLight(p: readonly number[], c: readonly number[], r: readonly number[]): { n: number[]; ao: number } {
  const d = [0, 1, 2].map((k) => (p[k]! - c[k]!) / r[k]!);
  const e = [0, 1, 2].map((k) => d[k]! / r[k]!);
  const el = Math.hypot(e[0]!, e[1]!, e[2]!) || 1;
  const depth = Math.hypot(d[0]!, d[1]!, d[2]!);
  const ao = (0.32 + 0.68 * smooth(0.3, 1, depth)) * (0.55 + 0.45 * smooth(0, 0.85, (d[1]! + 1) / 2));
  return { n: e.map((v) => v / el), ao };
}

/**
 * The crown shaded as one volume: every leaf's normal turned to the normal of
 * the ellipsoid round the crown, as foliage cards' normals are transferred
 * from a sphere (Polycount, "Correct vertex normals for foliage"; SpeedTree's
 * leaf lighting smoothing) - left to their own, each card lit apart and the
 * crown read as speckle with no form (the player, 2026-10-07). And its
 * occlusion in the vertex colour: dark in the heart of the crown and under
 * it, full at its sunlit skin, which is what gives a canopy its depth.
 */
function crownShaded(p: Primitive): Primitive {
  const { c, r } = crownEllipsoid(p.position);
  const normal = new Float32Array(p.normal.length);
  const colour = new Float32Array(p.colour.length);
  for (let v = 0; v < p.position.length / 3; v++) {
    const { n, ao } = crownLight([p.position[v * 3]!, p.position[v * 3 + 1]!, p.position[v * 3 + 2]!], c, r);
    // A tenth of the card's own normal kept.
    const m = [0, 1, 2].map((k) => n[k]! * 0.9 + p.normal[v * 3 + k]! * 0.1);
    const ml = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
    for (let k = 0; k < 3; k++) normal[v * 3 + k] = m[k]! / ml;
    colour[v * 4] = ao; colour[v * 4 + 1] = ao; colour[v * 4 + 2] = ao; colour[v * 4 + 3] = 1;
  }
  return { ...p, normal, colour };
}

/**
 * The tree from afar: its crown as a few lumps where its leaves are (the leaf
 * vertices gathered by k-means), each knobbly as a cauliflower, all shaded as
 * the crown's one ellipsoid with its depth darkened as `crownShaded` does; on
 * a plain trunk. Colours linear, in the vertex colour.
 */
function crownProxy(leaves: Primitive, height: number, detail: number, shrink: number, withTrunk: boolean, shade = 1): BufferGeometry {
  const pts: number[][] = [];
  for (let v = 0; v < leaves.position.length / 3; v += 3) pts.push([leaves.position[v * 3]!, leaves.position[v * 3 + 1]!, leaves.position[v * 3 + 2]!]);
  const { c, r } = crownEllipsoid(leaves.position);
  // k-means from evenly spread starts: deterministic.
  const centres = Array.from({ length: CROWN_LUMPS }, (_, i) => [...pts[Math.floor(((i + 0.5) * pts.length) / CROWN_LUMPS)]!]);
  const owner = new Int32Array(pts.length);
  const d2 = (a: readonly number[], b: readonly number[]): number => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;
  for (let it = 0; it < 10; it++) {
    pts.forEach((q, i) => {
      let best = 0;
      centres.forEach((m, j) => { if (d2(q, m) < d2(q, centres[best]!)) best = j; });
      owner[i] = best;
    });
    centres.forEach((m, j) => {
      let n = 0;
      const sum = [0, 0, 0];
      pts.forEach((q, i) => { if (owner[i] === j) { n++; for (let k = 0; k < 3; k++) sum[k] = sum[k]! + q[k]!; } });
      if (n > 0) for (let k = 0; k < 3; k++) m[k] = sum[k]! / n;
    });
  }
  const positions: number[] = [], normals: number[] = [], colours: number[] = [];
  centres.forEach((m, j) => {
    let n = 0, sq = 0;
    pts.forEach((q, i) => { if (owner[i] === j) { n++; sq += d2(q, m); } });
    if (n === 0) return;
    const radius = Math.sqrt(sq / n) * 1.25 * shrink;
    const ball = new IcosahedronGeometry(1, detail).toNonIndexed();
    const pos = ball.getAttribute('position');
    for (let v = 0; v < pos.count; v++) {
      const dx = pos.getX(v), dy = pos.getY(v), dz = pos.getZ(v);
      // Cauliflower: the lump's skin raised in rounded knobs.
      const knob = Math.sin(dx * 5.3 + j * 1.7) * Math.sin(dy * 4.9 + j) * Math.sin(dz * 5.1 + j * 2.3);
      const rr = radius * (1 + knob * 0.14);
      const p = [m[0]! + dx * rr, m[1]! + dy * rr * 0.85, m[2]! + dz * rr];
      positions.push(p[0]! / height, p[1]! / height, p[2]! / height);
      // The crown's ellipsoid normal with a third of the lump's own: one volume, lumpy.
      const { n: e, ao } = crownLight(p, c, r);
      const nn = [e[0]! * 0.65 + dx * 0.35, e[1]! * 0.65 + dy * 0.35, e[2]! * 0.65 + dz * 0.35];
      const nl = Math.hypot(nn[0]!, nn[1]!, nn[2]!) || 1;
      normals.push(nn[0]! / nl, nn[1]! / nl, nn[2]! / nl);
      colours.push(CROWN_GREEN[0] * ao * shade, CROWN_GREEN[1] * ao * shade, CROWN_GREEN[2] * ao * shade);
    }
    ball.dispose();
  });
  // The trunk, up into the crown's underside.
  if (withTrunk) appendTrunk(c, r, height, positions, normals, colours);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
  g.computeBoundingSphere();
  return g;
}

/** A plain six-sided trunk up into the crown's underside. */
function appendTrunk(c: readonly number[], r: readonly number[], height: number, positions: number[], normals: number[], colours: number[]): void {
  const crownBottom = Math.max(0.5, c[1]! - r[1]! * 0.4);
  const trunk = new CylinderGeometry(0.16, 0.26, crownBottom, 6, 1, true).toNonIndexed();
  trunk.translate(0, crownBottom / 2, 0);
  const tp = trunk.getAttribute('position'), tn = trunk.getAttribute('normal');
  for (let v = 0; v < tp.count; v++) {
    positions.push(tp.getX(v) / height, tp.getY(v) / height, tp.getZ(v) / height);
    normals.push(tn.getX(v), tn.getY(v), tn.getZ(v));
    colours.push(...CROWN_BARK);
  }
  trunk.dispose();
}

/** Loads the trees and builds their levels; their materials share the forest's wind. */
export async function loadNatureTrees(anisotropy: number): Promise<NatureTreeKit> {
  await MeshoptSimplifier.ready;
  const texture: Texture = await new TextureLoader().loadAsync(url('Leaves_NormalTree_C.png'));
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  const variants = await Promise.all(MODELS.map(async (name) => {
    const primitives = await readGltf(name);
    const bark = primitives.find((p) => p.material.startsWith('Bark'))!;
    const leaves = crownShaded(primitives.find((p) => p.material.startsWith('Leaves'))!);
    // Every cluster a quarter larger: the painted leaves have gaps, and the
    // crown showed through as shredded paper.
    const nearLeaves = grownLeaves(leaves, 1.25);
    // One unit tall, standing on its own origin (the ground).
    let top = 0;
    for (const p of primitives) for (let i = 1; i < p.position.length; i += 3) top = Math.max(top, p.position[i]!);
    return {
      // Near, the same lumps well inside the leaves and dark, the crown's
      // shaded heart: it closes the gaps between the leaf clusters and never
      // shows as a ball of its own (at the leaves' size and brightness it read
      // as plastic topiary).
      near: { bark: geometryOf(bark, simplified(bark, 0.35), top), heart: crownProxy(leaves, top, 1, 0.7, false, 0.45), leaves: geometryOf(nearLeaves, nearLeaves.index, top) },
      far: crownProxy(leaves, top, 1, 1, true),
    };
  }));
  const barkMaterial = new MeshStandardMaterial({ color: 0x5a4636, vertexColors: true, roughness: 0.95, metalness: 0 });
  applyWind(barkMaterial, FOREST_WIND, 'nature-bark');
  const leafMaterial = new MeshStandardMaterial({
    map: texture, alphaTest: 0.45, side: DoubleSide, vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.3,
  });
  // A deeper green than the painted leaves' olive, which the light turned lime.
  leafMaterial.color.setRGB(0.68, 0.95, 1);
  applyWind(leafMaterial, FOREST_WIND, 'nature-leaves');
  const leafDepth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, map: texture, alphaTest: 0.45 });
  const crownMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.3 });
  applyWind(crownMaterial, FOREST_WIND, 'nature-crowns');
  return {
    variants,
    barkMaterial,
    leafMaterial,
    leafDepth,
    crownMaterial,
    dispose() {
      for (const v of variants) for (const g of [v.near.bark, v.near.heart, v.near.leaves, v.far]) g.dispose();
      barkMaterial.dispose();
      leafMaterial.dispose();
      leafDepth.dispose();
      crownMaterial.dispose();
      texture.dispose();
    },
  };
}

export interface NatureForest {
  readonly meshes: readonly InstancedMesh[];
  /** Sorts the trees into near and far round the view's ground (three's x, z), when it has moved. */
  updateLod(x: number, z: number): void;
  dispose(): void;
}

/** The trees, instanced per variant and level; `updateLod` picks which instance draws where. */
export function buildNatureForest(trees: readonly TreePlacement[], kit: NatureTreeKit): NatureForest {
  const byVariant: TreePlacement[][] = kit.variants.map(() => []);
  for (const tree of trees) byVariant[Math.min(byVariant.length - 1, Math.floor(tree.seed * byVariant.length))]!.push(tree);
  const meshes: InstancedMesh[] = [];
  const groups: { items: TreePlacement[]; matrices: Matrix4[]; colours: Color[]; levels: InstancedMesh[][] }[] = [];
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  const up = new Vector3(0, 1, 0);
  byVariant.forEach((items, k) => {
    if (items.length === 0) return;
    const variant = kit.variants[k]!;
    const make = (geometry: BufferGeometry, material: MeshStandardMaterial, name: string): InstancedMesh => {
      const mesh = new InstancedMesh(geometry, material, items.length);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = material !== kit.leafMaterial;
      if (material === kit.leafMaterial) mesh.customDepthMaterial = kit.leafDepth;
      mesh.frustumCulled = false;
      mesh.count = 0;
      meshes.push(mesh);
      return mesh;
    };
    const near = [
      make(variant.near.bark, kit.barkMaterial, 'nature-bark'),
      make(variant.near.heart, kit.crownMaterial, 'nature-heart'),
      make(variant.near.leaves, kit.leafMaterial, 'nature-leaves'),
    ];
    const far = [make(variant.far, kit.crownMaterial, 'nature-crowns')];
    const matrices = items.map((item) => {
      position.set(item.x, item.z, -item.y);
      rotation.setFromAxisAngle(up, item.yaw);
      // A little narrower or broader; never wider overall (that made logs of the trunks).
      const spread = 0.95 + ((item.seed * 5.3) % 1) * 0.15;
      scale.set(item.size * spread, item.size, item.size * spread);
      return new Matrix4().compose(position, rotation, scale);
    });
    // A little variety of green between trees, none of it far from the leaves' own.
    const colours = items.map((item) => {
      const t = 0.88 + ((item.seed * 3.77) % 1) * 0.24;
      return new Color(t * (0.96 + ((item.seed * 1.3) % 1) * 0.08), t, t * 0.94);
    });
    groups.push({ items, matrices, colours, levels: [near, far] });
  });
  let sortedX = Infinity, sortedZ = Infinity;
  const sort = (x: number, z: number): void => {
    for (const g of groups) {
      const counts = [0, 0];
      for (let i = 0; i < g.items.length; i++) {
        const item = g.items[i]!;
        const level = Math.hypot(item.x - x, -item.y - z) < NEAR_REACH ? 0 : 1;
        const slot = counts[level]!++;
        for (const mesh of g.levels[level]!) {
          mesh.setMatrixAt(slot, g.matrices[i]!);
          mesh.setColorAt(slot, g.colours[i]!);
        }
      }
      g.levels.forEach((meshes, level) => {
        for (const mesh of meshes) {
          mesh.count = counts[level]!;
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
      });
    }
  };
  return {
    meshes,
    updateLod(x, z) {
      if (Math.hypot(x - sortedX, z - sortedZ) < LOD_SLACK) return;
      sortedX = x; sortedZ = z;
      sort(x, z);
    },
    dispose() {
      for (const mesh of meshes) mesh.dispose();
    },
  };
}
