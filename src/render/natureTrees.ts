import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshDepthMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  RGBADepthPacking,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
  type Mesh,
  type MeshPhongMaterial,
  type Texture,
} from 'three';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import type { TreePlacement } from './groundCover';
import { applyWind, type WindResponse } from './wind';

/**
 * THE TREES of the countryside, grown procedurally: EZ-Tree (Dan Greenheck,
 * a three.js tree generator) builds each from a preset and a seed - a trunk
 * and branches of photographed bark, and where its leaves grow, the shape
 * of its crown. The crown is drawn SOLID, lumps where the leaves are with
 * leaf clusters laid on them (`foliageTexture`): leaves cut out of cards by
 * their alpha read as rubbish at this scale (the player, 2026-10-07), and
 * the solid canopies were what looked right.
 *
 * Each stands as its neighbours let it, as trees in a stand grow competing
 * for light and space (Runions et al., "Modeling Trees with a Space
 * Colonization Algorithm"; Palubicki et al., "Self-organizing tree models",
 * SIGGRAPH 2009): in the heart of a wood taller and narrower, at its edge and
 * alone broader, the crown leaning out towards the open side.
 *
 * The crown is shaded as one volume (normals from its ellipsoid, as foliage
 * normals are transferred from a sphere - Polycount, "Correct vertex normals
 * for foliage") with its depth darkened, in its leaves' own mean green. Three
 * levels of detail by the distance to the camera, as a game's foliage LODs:
 * near, the tree's bark (simplified) and leaf cards round 48 clusters, no
 * solid crown (the player, 2026-10-07: "só o alpha, não mostrar as bolas");
 * mid, cards round 24 larger clusters on a plain trunk; far, where a tree is
 * a few pixels, cards round 8 large clusters.
 */

/** The varieties grown, preset and seed: oaks, ashes, an aspen (its crown the autumn gold of its leaves). */
const VARIANTS: readonly (readonly [string, number])[] = [
  ['Oak Medium', 11], ['Oak Medium', 23], ['Oak Large', 37],
  ['Ash Medium', 41], ['Ash Large', 53], ['Aspen Medium', 67],
];
/** Within this distance of the camera a tree is drawn in full, world units. */
const NEAR_REACH = 350;
/** Within this distance a tree is drawn at mid detail; beyond, at its lightest. */
const MID_REACH = 1800;
/** The share of its triangles a near tree's bark keeps (meshopt): it is mostly under the crown. */
const BARK_KEEP = 0.2;
/** How far the view moves before the trees are sorted near and far again. */
const LOD_SLACK = 60;
/** Leaf clusters in a near crown, and lumps in a far one. */
const CROWN_CLUSTERS = 48;
const CROWN_LUMPS = 8;
const CROWN_MID = 24;
/** Leaf cards round each near cluster. */
const LEAF_CARDS = 10;
/** World units one tile of the foliage detail covers (eight leaf clusters across). */
const FOLIAGE_TILE = 18;
/** World units one photographed twig of leaves covers on a crown. */
const LEAF_TILE = 6;
/** Neighbours within this reach (world units) make a tree's stand. */
const STAND_REACH = 45;

/** The forest's wind (`groundCover.ts`): a slow sway and a leaf flutter. */
const FOREST_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };

interface Variant {
  readonly bark: BufferGeometry;
  /** The solid crown in detail, near; and light, far, on a plain trunk. */
  readonly trunk: BufferGeometry;
  readonly mid: BufferGeometry;
  readonly far: BufferGeometry;
  /** Near: the photographed leaf cards round the clusters, their material and shadow. */
  readonly cards: BufferGeometry;
  readonly leafMaterial: MeshStandardMaterial;
  readonly leafDepth: MeshDepthMaterial;
  readonly barkMaterial: MeshStandardMaterial;
}

export interface NatureTreeKit {
  readonly variants: readonly Variant[];
  readonly crownMaterial: MeshStandardMaterial;
  dispose(): void;
}

interface Primitive {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  /** RGB, linear. */
  readonly colour: Float32Array;
  readonly index: Uint32Array;
}

function primitiveOf(g: BufferGeometry): Primitive {
  const position = (g.getAttribute('position').array as Float32Array).slice();
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const index = g.getIndex();
  return {
    position,
    normal: (g.getAttribute('normal').array as Float32Array).slice(),
    uv: (g.getAttribute('uv').array as Float32Array).slice(),
    colour: new Float32Array(position.length).fill(1),
    index: index ? Uint32Array.from(index.array) : Uint32Array.from({ length: position.length / 3 }, (_, i) => i),
  };
}

function geometryOf(p: Primitive, height: number): BufferGeometry {
  const g = new BufferGeometry();
  const position = new Float32Array(p.position.length);
  for (let i = 0; i < position.length; i++) position[i] = p.position[i]! / height;
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(p.normal, 3));
  g.setAttribute('uv', new BufferAttribute(p.uv, 2));
  g.setAttribute('color', new BufferAttribute(p.colour, 3));
  g.setIndex(new BufferAttribute(p.index, 1));
  g.computeBoundingSphere();
  return g;
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
  const ao = (0.38 + 0.62 * smooth(0.3, 1, depth)) * (0.6 + 0.4 * smooth(0, 0.85, (d[1]! + 1) / 2));
  return { n: e.map((v) => v / el), ao };
}

/** The leaves shaded as the crown's one volume, with its depth in their vertex colour. */
function crownShaded(p: Primitive): Primitive {
  const { c, r } = crownEllipsoid(p.position);
  const normal = new Float32Array(p.normal.length);
  const colour = new Float32Array(p.colour.length);
  for (let v = 0; v < p.position.length / 3; v++) {
    const { n, ao } = crownLight([p.position[v * 3]!, p.position[v * 3 + 1]!, p.position[v * 3 + 2]!], c, r);
    // A fifth of the card's own normal kept, so each twig still catches the light a little apart.
    const m = [0, 1, 2].map((k) => n[k]! * 0.8 + p.normal[v * 3 + k]! * 0.2);
    const ml = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
    for (let k = 0; k < 3; k++) { normal[v * 3 + k] = m[k]! / ml; colour[v * 3 + k] = ao; }
  }
  return { ...p, normal, colour };
}

/**
 * The tree from afar: its crown as a few lumps where its leaves are (the leaf
 * vertices gathered by k-means), each knobbly as a cauliflower, all shaded as
 * the crown's one ellipsoid with its depth darkened; on a plain trunk.
 * Colours linear, in the vertex colour.
 */
/**
 * Where a crown's leaves gather: its leaf vertices in `lumps` groups by
 * k-means (from evenly spread starts, so the same every time), each group's
 * middle and the root-mean-square spread of its leaves about it.
 */
function crownClusters(leaves: Primitive, lumps: number): { c: number[]; r: number[]; centres: number[][]; spread: number[] } {
  const pts: number[][] = [];
  for (let v = 0; v < leaves.position.length / 3; v += 3) pts.push([leaves.position[v * 3]!, leaves.position[v * 3 + 1]!, leaves.position[v * 3 + 2]!]);
  const { c, r } = crownEllipsoid(leaves.position);
  const centres = Array.from({ length: lumps }, (_, i) => [...pts[Math.floor(((i + 0.5) * pts.length) / lumps)]!]);
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
  const spread = centres.map((m, j) => {
    let n = 0, sq = 0;
    pts.forEach((q, i) => { if (owner[i] === j) { n++; sq += d2(q, m); } });
    return n > 0 ? Math.sqrt(sq / n) : 0;
  });
  return { c, r, centres, spread };
}

/**
 * LEAF CARDS round each cluster of a near crown: quads of the tree's own
 * photographed twig (alpha-tested), set over the cluster's skin facing out,
 * spread by the golden angle - the leaf-cluster cards real-time trees are
 * made of (Habrador on The Witness's trees; Polycount, "Low Poly Foliage"),
 * here round the solid cluster, which fills every gap the cut-out leaves
 * leave (the player, 2026-10-07: "use alpha em cada bola ... aquelas texturas
 * de cacho"). Lit as the crown's volume (its ellipsoid's normal) with its
 * depth darkened; the photograph gives the colour.
 */
function leafCards(leaves: Primitive, height: number, lumps: number, grow: number, perCluster: number): BufferGeometry {
  const { c, r, centres, spread } = crownClusters(leaves, lumps);
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], colours: number[] = [], index: number[] = [];
  centres.forEach((m, j) => {
    const radius = spread[j]! * grow;
    if (radius <= 0) return;
    for (let k = 0; k < perCluster; k++) {
      const yk = 1 - ((k + 0.5) / perCluster) * 1.6;
      const ring = Math.sqrt(Math.max(0, 1 - yk * yk));
      const theta = k * 2.399963 + j * 1.3;
      const out = [Math.cos(theta) * ring, yk, Math.sin(theta) * ring];
      // Half out of the cluster's skin, a card twice its radius across.
      const centre = [0, 1, 2].map((q) => m[q]! + out[q]! * radius * 0.75);
      const side = Math.abs(out[1]!) < 0.95 ? [out[2]!, 0, -out[0]!] : [1, 0, 0];
      const sl = Math.hypot(side[0]!, side[1]!, side[2]!) || 1;
      const t0 = side.map((v) => v / sl);
      const b0 = [out[1]! * t0[2]! - out[2]! * t0[1]!, out[2]! * t0[0]! - out[0]! * t0[2]!, out[0]! * t0[1]! - out[1]! * t0[0]!];
      const spin = k * 1.618 + j * 0.7;
      const u = [0, 1, 2].map((q) => t0[q]! * Math.cos(spin) + b0[q]! * Math.sin(spin));
      const v = [0, 1, 2].map((q) => b0[q]! * Math.cos(spin) - t0[q]! * Math.sin(spin));
      const half = radius * 1.25;
      const cardNormal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const first = positions.length / 3;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const p = [0, 1, 2].map((q) => centre[q]! + (u[q]! * su + v[q]! * sv) * half);
        positions.push(p[0]! / height, p[1]! / height, p[2]! / height);
        const { n, ao } = crownLight(p, c, r);
        // The crown's volume normal with a third of the card's own: each
        // twig turned its own way catches the light apart from its
        // neighbours, and the crown reads as leaves, crisp, not one mush.
        const own = cardNormal[0]! * out[0]! + cardNormal[1]! * out[1]! + cardNormal[2]! * out[2]! >= 0 ? 1 : -1;
        const mixed = [0, 1, 2].map((q) => n[q]! * 0.65 + cardNormal[q]! * own * 0.35);
        const ml = Math.hypot(mixed[0]!, mixed[1]!, mixed[2]!) || 1;
        normals.push(mixed[0]! / ml, mixed[1]! / ml, mixed[2]! / ml);
        uvs.push((su + 1) / 2, (sv + 1) / 2);
        // Deeper in the crown, darker: the cards carry a stronger occlusion
        // than the solid lumps (a pale, even canopy read as haze), the outer
        // leaves full, the heart near a quarter.
        const deep = Math.pow(ao, 1.6);
        colours.push(deep, deep, deep);
      }
      index.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/**
 * Keeps an alpha-tested leaf texture's coverage at a distance: each mip level
 * averages the leaves' alpha down under the cutoff and crowns thin to bare
 * cards. The alpha is raised by the mip level the pixel reads (Ben Golus,
 * "Anti-aliased Alpha Test: The Esoteric Alpha To Coverage": CalcMipLevel,
 * a quarter a level).
 */
function preserveAlphaCoverage(material: MeshStandardMaterial | MeshDepthMaterial, bias = 0): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    // The leaves read a sharper mip than the footprint asks (a negative
    // bias): at the level the hardware picks, the photograph's leaves
    // averaged into a blur (the player, 2026-10-07: "cara de borrado").
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        diffuseColor *= texture2D(map, vMapUv, ${bias.toFixed(2)});
      #endif
      {
        vec2 texel = vMapUv * vec2(textureSize(map, 0));
        vec2 ddxT = dFdx(texel), ddyT = dFdy(texel);
        float mip = max(0.0, 0.5 * log2(max(dot(ddxT, ddxT), dot(ddyT, ddyT))) + ${bias.toFixed(2)});
        diffuseColor.a *= 1.0 + mip * 0.25;
      }`);
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}-mip-alpha`;
}

function crownProxy(leaves: Primitive, height: number, green: readonly number[], bark: readonly number[] | null, detail: number, lumps: number, grow: number): BufferGeometry {
  const { c, r, centres, spread } = crownClusters(leaves, lumps);
  const positions: number[] = [], normals: number[] = [], colours: number[] = [];
  centres.forEach((m, j) => {
    if (spread[j]! <= 0) return;
    const radius = spread[j]! * grow;
    // Each cluster a little apart in colour - lighter and warmer at the top
    // of the crown, where the sun reaches - so the crown reads as many
    // clusters and not one surface.
    const jitter = 0.86 + 0.28 * (((j * 0.6180339 + m[1]! * 0.37) % 1 + 1) % 1);
    const sunlit = 0.92 + 0.18 * smooth(-0.2, 0.9, (m[1]! - c[1]!) / r[1]!);
    const clumpGreen = [green[0]! * jitter * sunlit * 1.04, green[1]! * jitter * sunlit, green[2]! * jitter * sunlit * 0.92];
    const ball = new IcosahedronGeometry(1, detail).toNonIndexed();
    const pos = ball.getAttribute('position');
    for (let v = 0; v < pos.count; v++) {
      const dx = pos.getX(v), dy = pos.getY(v), dz = pos.getZ(v);
      // Cauliflower: knobs on knobs, so the outline is scalloped by clumps
      // of leaves and never a smooth curve.
      const knob = Math.sin(dx * 5.3 + j * 1.7) * Math.sin(dy * 4.9 + j) * Math.sin(dz * 5.1 + j * 2.3)
        + 0.6 * Math.sin(dx * 11.7 + j * 3.1) * Math.sin(dy * 10.3 + j * 0.7) * Math.sin(dz * 12.1 + j * 1.3);
      const rr = radius * (1 + knob * 0.13);
      const p = [m[0]! + dx * rr, m[1]! + dy * rr * 0.85, m[2]! + dz * rr];
      positions.push(p[0]! / height, p[1]! / height, p[2]! / height);
      const { n: e, ao } = crownLight(p, c, r);
      // The crown's volume normal, with some of the cluster's own (The
      // Witness's trees: leaves lit from the blob they fill).
      const nn = [e[0]! * 0.6 + dx * 0.4, e[1]! * 0.6 + dy * 0.4, e[2]! * 0.6 + dz * 0.4];
      const nl = Math.hypot(nn[0]!, nn[1]!, nn[2]!) || 1;
      normals.push(nn[0]! / nl, nn[1]! / nl, nn[2]! / nl);
      colours.push(clumpGreen[0]! * ao, clumpGreen[1]! * ao, clumpGreen[2]! * ao);
    }
    ball.dispose();
  });
  // A plain trunk up into the crown's underside (far; near, the tree's own).
  if (bark) appendTrunk(c, r, height, bark, positions, normals, colours);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
  g.computeBoundingSphere();
  return g;
}

function appendTrunk(c: readonly number[], r: readonly number[], height: number, bark: readonly number[], positions: number[], normals: number[], colours: number[]): void {
  const crownBottom = Math.max(height * 0.1, c[1]! - r[1]! * 0.4);
  const trunk = new CylinderGeometry(height * 0.012, height * 0.02, crownBottom, 6, 1, true).toNonIndexed();
  trunk.translate(0, crownBottom / 2, 0);
  const tp = trunk.getAttribute('position'), tn = trunk.getAttribute('normal');
  for (let v = 0; v < tp.count; v++) {
    positions.push(tp.getX(v) / height, tp.getY(v) / height, tp.getZ(v) / height);
    normals.push(tn.getX(v), tn.getY(v), tn.getZ(v));
    colours.push(bark[0]!, bark[1]!, bark[2]!);
  }
  trunk.dispose();
}

/**
 * THE FOLIAGE DETAIL of a solid crown: a tile of overlapping leaf clusters -
 * rotated ellipses, each domed, the upper one winning where they overlap -
 * as a normal map (RGB) and each cluster's own shade (A, the gaps between
 * them dark). Laid over the crowns triplanar in world space, it turns the
 * smooth lumps into heaps of leaf clusters that each catch the light, as
 * solid stylized canopies are shaded (a triplanar leaf-cluster normal and a
 * leaf-shaped breakup of the colour: Godot Shaders' "Realistic Tree Shader";
 * 80.lv on stylized nature) - a ball with no detail read as plastic (the
 * player, 2026-10-07). Tiles seamlessly (the clusters wrap).
 */
function foliageTexture(): DataTexture {
  const size = 256, cells = 8, perCell = 3;
  const hash = (a: number, b: number, c: number): number => {
    let h = Math.imul(a + 1013, 374_761_393) ^ Math.imul(b + 7, 668_265_263) ^ Math.imul(c + 3, 2_246_822_519);
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
  };
  const height = new Float32Array(size * size), shade = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * cells, v = (y / size) * cells;
      const ci = Math.floor(u), cj = Math.floor(v);
      let best = -1, tone = 0.15;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const gi = (((ci + di) % cells) + cells) % cells, gj = (((cj + dj) % cells) + cells) % cells;
          for (let k = 0; k < perCell; k++) {
            const cx = ci + di + hash(gi, gj, k * 5), cy = cj + dj + hash(gi, gj, k * 5 + 1);
            const angle = hash(gi, gj, k * 5 + 2) * Math.PI;
            const a = 0.55 + 0.25 * hash(gi, gj, k * 5 + 3), b = a * 0.55;
            const ex = u - cx, ey = v - cy;
            const rx = ex * Math.cos(angle) + ey * Math.sin(angle), ry = -ex * Math.sin(angle) + ey * Math.cos(angle);
            const e = (rx / a) ** 2 + (ry / b) ** 2;
            if (e >= 1) continue;
            const layer = hash(gi, gj, k * 5 + 4);
            const h = Math.sqrt(1 - e) * 0.6 + layer * 0.5;
            if (h > best) { best = h; tone = 0.55 + 0.45 * layer - 0.2 * e; }
          }
        }
      }
      height[y * size + x] = Math.max(0, best);
      shade[y * size + x] = tone;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => height[((y + size) % size) * size + ((x + size) % size)]!;
  const strength = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * strength, ny = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      data[i + 3] = Math.round(Math.min(1, Math.max(0, shade[y * size + x]!)) * 255);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.colorSpace = NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Lays the foliage detail over a crown material: triplanar in world space,
 * the three projections' normals blended by Ben Golus's whiteout method
 * ("Normal Mapping for a Triplanar Shader") over the crown's own smooth
 * volume normal, and each cluster's shade on the colour.
 */
function applyFoliageDetail(material: MeshStandardMaterial, texture: Texture, leafPhoto: Texture): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms['uFoliage'] = { value: texture };
    shader.uniforms['uLeafPhoto'] = { value: leafPhoto };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFoliagePos;
        varying vec3 vFoliageNormal;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        {
          vec4 foliageWorld = vec4(transformed, 1.0);
          mat3 foliageBasis = mat3(modelMatrix);
          #ifdef USE_INSTANCING
            foliageWorld = instanceMatrix * foliageWorld;
            foliageBasis = foliageBasis * mat3(instanceMatrix);
          #endif
          vFoliagePos = (modelMatrix * foliageWorld).xyz;
          vFoliageNormal = normalize(foliageBasis * objectNormal);
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uFoliage;
        varying vec3 vFoliagePos;
        varying vec3 vFoliageNormal;
        uniform sampler2D uLeafPhoto;
        vec3 foliageN;
        float foliageShade;
        float foliageLeaf;
        void foliageDetail() {
          vec3 n = normalize(vFoliageNormal);
          vec3 w = pow(abs(n), vec3(4.0));
          w /= w.x + w.y + w.z;
          vec3 p = vFoliagePos / ${FOLIAGE_TILE.toFixed(1)};
          vec4 tx = texture2D(uFoliage, p.zy);
          vec4 ty = texture2D(uFoliage, p.xz);
          vec4 tz = texture2D(uFoliage, p.xy);
          vec3 nx = tx.xyz * 2.0 - 1.0;
          vec3 ny = ty.xyz * 2.0 - 1.0;
          vec3 nz = tz.xyz * 2.0 - 1.0;
          // Whiteout: each projection's tangent normal over the surface's.
          nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
          ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
          nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
          foliageN = normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
          foliageShade = tx.a * w.x + ty.a * w.y + tz.a * w.z;
          // From the usual zoom inwards, LEAVES: the photographed twigs of
          // the trees' own leaf texture printed over the crown, triplanar, in
          // two layers turned and offset so they overlap and never tile in
          // rows - each leaf's light and shade from the photograph, its
          // colour the crown's, the gaps between leaves the dark inside of
          // the crown. Solid, nothing cut out: it reads as foliage without
          // alpha-tested cards (the player, 2026-10-07: "parecer realmente
          // folhas"). Faded out as a pixel covers more than a unit.
          foliageLeaf = 1.0;
          float footprint = max(fwidth(vFoliagePos.x), max(fwidth(vFoliagePos.y), fwidth(vFoliagePos.z)));
          float near = 1.0 - smoothstep(0.4, 1.2, footprint);
          if (near > 0.0) {
            vec3 lp = vFoliagePos / ${LEAF_TILE.toFixed(1)};
            vec2 uvs[3] = vec2[3](lp.zy, lp.xz, lp.xy);
            float ws[3] = float[3](w.x, w.y, w.z);
            float cover = 0.0, lum = 0.0;
            for (int i = 0; i < 3; i++) {
              vec2 u = uvs[i];
              vec4 a = texture2D(uLeafPhoto, u);
              vec4 b = texture2D(uLeafPhoto, vec2(-u.y, u.x) * 1.31 + 0.47);
              float la = dot(a.rgb, vec3(0.3, 0.6, 0.1)) / max(a.a, 0.05);
              float lb = dot(b.rgb, vec3(0.3, 0.6, 0.1)) / max(b.a, 0.05);
              float c = max(a.a, b.a);
              cover += c * ws[i];
              lum += (a.a > 0.5 ? la : lb) * c * ws[i];
            }
            lum /= max(cover, 0.01);
            float leafy = mix(0.4, 0.62 + 1.3 * lum, smoothstep(0.3, 0.6, cover));
            foliageLeaf = mix(1.0, leafy, near);
          }
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        foliageDetail();
        diffuseColor.rgb *= mix(0.45, 1.2, foliageShade) * foliageLeaf;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(foliageN, 0.0)).xyz);`);
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}-foliage-detail`;
}

/** Resolves once a texture's image has loaded. */
async function loaded(texture: Texture): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const image = texture.image as HTMLImageElement | undefined;
    if (image && image.complete && image.naturalWidth > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The mean colour (linear) of a leaf texture where it is opaque, so the far crowns wear the near leaves' green. */
function meanLeafColour(texture: Texture): [number, number, number] {
  const image = texture.image as HTMLImageElement;
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [0.05, 0.16, 0.03];
  ctx.drawImage(image, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data;
  const sum = [0, 0, 0];
  let n = 0;
  const linear = (c: number): number => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 128) continue;
    sum[0] = sum[0]! + linear(data[i]!); sum[1] = sum[1]! + linear(data[i + 1]!); sum[2] = sum[2]! + linear(data[i + 2]!); n++;
  }
  return n > 0 ? [sum[0]! / n, sum[1]! / n, sum[2]! / n] : [0.05, 0.16, 0.03];
}

/** Grows the trees and builds their levels; their materials share the forest's wind. */
export async function loadNatureTrees(anisotropy: number): Promise<NatureTreeKit> {
  const { Tree } = await import('@dgreenheck/ez-tree');
  await MeshoptSimplifier.ready;
  const variants: Variant[] = [];
  /** The first variety's photographed leaves (an oak's), printed over every crown up close. */
  let leafPhoto: Texture | null = null;
  for (const [preset, seed] of VARIANTS) {
    const tree = new Tree();
    tree.loadPreset(preset);
    tree.options.seed = seed;
    tree.generate();
    const branches = tree.branchesMesh as Mesh;
    const leavesMesh = tree.leavesMesh as Mesh;
    const barkSource = branches.material as MeshPhongMaterial;
    const leafSource = leavesMesh.material as MeshPhongMaterial;
    const full = primitiveOf(branches.geometry);
    const target = Math.max(3, Math.floor((full.index.length * BARK_KEEP) / 3) * 3);
    const bark = { ...full, index: MeshoptSimplifier.simplify(full.index, full.position, 3, target, 0.05, [])[0] };
    const leaves = crownShaded(primitiveOf(leavesMesh.geometry));
    // One unit tall, standing on its own origin (the ground).
    let top = 0;
    for (const p of [bark, leaves]) for (let i = 1; i < p.position.length; i += 3) top = Math.max(top, p.position[i]!);
    const leafTexture = leafSource.map!;
    await loaded(leafTexture);
    leafTexture.anisotropy = anisotropy;
    if (!leafPhoto) {
      leafTexture.wrapS = RepeatWrapping;
      leafTexture.wrapT = RepeatWrapping;
      leafTexture.needsUpdate = true;
      leafPhoto = leafTexture;
    }
    const tint = leafSource.color;
    const mean = meanLeafColour(leafTexture);
    const green = [mean[0] * tint.r * 0.85, mean[1] * tint.g * 0.85, mean[2] * tint.b * 0.85];
    const barkMaterial = new MeshStandardMaterial({
      map: barkSource.map, normalMap: barkSource.normalMap, color: barkSource.color, roughness: 0.95, metalness: 0,
    });
    applyWind(barkMaterial, FOREST_WIND, 'nature-bark');
    const leafMaterial = new MeshStandardMaterial({
      // A deeper green than the photograph's pale spring leaves, and little
      // of the sky's sheen on them: lit as they were, the canopy was milky.
      map: leafTexture, color: tint.clone().multiply(new Color(0.78, 0.9, 0.7)), alphaTest: 0.5, side: DoubleSide, vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.12,
      // Alpha to coverage on the multisampled target: the cut-out edge
      // anti-aliased and kept sharp by the alpha's own derivative (three's
      // alphatest chunk, after Ben Golus, "Anti-aliased Alpha Test").
      alphaToCoverage: true,
    });
    applyWind(leafMaterial, FOREST_WIND, 'nature-leaves');
    preserveAlphaCoverage(leafMaterial, -0.75);
    const leafDepth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, map: leafTexture, alphaTest: 0.5 });
    preserveAlphaCoverage(leafDepth);
    variants.push({
      bark: geometryOf(bark, top),
      // Near, many small clusters where the branches carry their leaves
      // (the blob is never drawn itself - Habrador on The Witness's trees);
      // far, a few coarse lumps, a fraction of the triangles.
      // A plain trunk alone (no crown): the mid trees' cards stand on it.
      trunk: crownProxy(leaves, top, green, [0.05, 0.035, 0.025], 1, 0, 1),
      cards: leafCards(leaves, top, CROWN_CLUSTERS, 1.5, LEAF_CARDS),
      leafMaterial,
      leafDepth,
      mid: leafCards(leaves, top, CROWN_MID, 1.6, LEAF_CARDS),
      // Far: the same leaf cards, few and large - no solid lumps anywhere
      // (the player, 2026-10-07: "deixar assim em tudo e tirar as bolas").
      far: leafCards(leaves, top, CROWN_LUMPS, 2.1, 6),
      barkMaterial,
    });
    tree.branchesMesh.geometry.dispose();
    tree.leavesMesh.geometry.dispose();
  }
  const crownMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.3 });
  applyWind(crownMaterial, FOREST_WIND, 'nature-crowns');
  const foliage = foliageTexture();
  foliage.anisotropy = anisotropy;
  applyFoliageDetail(crownMaterial, foliage, leafPhoto!);
  console.info('[nature] tree variants (triangles near / far):', variants.map((v) => `${v.bark.index!.count / 3 + v.cards.index!.count / 3} / ${v.far.getAttribute('position').count / 3}`).join(', '));
  return {
    variants,
    crownMaterial,
    dispose() {
      for (const v of variants) {
        for (const g of [v.bark, v.trunk, v.mid, v.far, v.cards]) g.dispose();
        v.leafMaterial.dispose();
        v.leafDepth.dispose();
        v.barkMaterial.dispose();
      }
      crownMaterial.dispose();
      foliage.dispose();
    },
  };
}

export interface NatureForest {
  readonly meshes: readonly InstancedMesh[];
  /** Sorts the trees into near and far by their distance to the camera (three's x, y, z), when it has moved. */
  updateLod(x: number, y: number, z: number): void;
  dispose(): void;
}

/**
 * How each tree stands among its neighbours: how crowded it is (0 alone .. 1
 * deep in a wood) and which way the open ground lies (unit, map axes).
 */
function stands(trees: readonly TreePlacement[]): { crowd: Float32Array; openX: Float32Array; openY: Float32Array } {
  const cell = STAND_REACH;
  const grid = new Map<string, number[]>();
  trees.forEach((t, i) => {
    const key = `${Math.floor(t.x / cell)},${Math.floor(t.y / cell)}`;
    const list = grid.get(key);
    if (list) list.push(i); else grid.set(key, [i]);
  });
  const crowd = new Float32Array(trees.length), openX = new Float32Array(trees.length), openY = new Float32Array(trees.length);
  trees.forEach((t, i) => {
    const cx = Math.floor(t.x / cell), cy = Math.floor(t.y / cell);
    let n = 0, ax = 0, ay = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
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

/** The trees, instanced per variant and level; `updateLod` picks which instance draws where. */
export function buildNatureForest(trees: readonly TreePlacement[], kit: NatureTreeKit): NatureForest {
  const stand = stands(trees);
  const byVariant: number[][] = kit.variants.map(() => []);
  trees.forEach((tree, i) => byVariant[Math.min(byVariant.length - 1, Math.floor(tree.seed * byVariant.length))]!.push(i));
  const meshes: InstancedMesh[] = [];
  const groups: { items: TreePlacement[]; matrices: Matrix4[]; colours: Color[]; levels: InstancedMesh[][] }[] = [];
  byVariant.forEach((indices, k) => {
    if (indices.length === 0) return;
    const variant = kit.variants[k]!;
    const make = (geometry: BufferGeometry, material: MeshStandardMaterial, name: string, depth?: MeshDepthMaterial): InstancedMesh => {
      const mesh = new InstancedMesh(geometry, material, indices.length);
      mesh.name = name;
      mesh.castShadow = true;
      // Every part of a tree takes the sun's shadows, the leaf cards too: the
      // upper leaves shading the lower is what gives a canopy its depth.
      mesh.receiveShadow = true;
      if (depth) mesh.customDepthMaterial = depth;
      mesh.frustumCulled = false;
      mesh.count = 0;
      meshes.push(mesh);
      return mesh;
    };
    const near = [
      make(variant.bark, variant.barkMaterial, 'nature-bark'),
      make(variant.cards, variant.leafMaterial, 'nature-leaves', variant.leafDepth),
    ];
    const mid = [make(variant.trunk, kit.crownMaterial, 'nature-trunk-mid'), make(variant.mid, variant.leafMaterial, 'nature-leaves-mid', variant.leafDepth)];
    const far = [make(variant.trunk, kit.crownMaterial, 'nature-trunk-far'), make(variant.far, variant.leafMaterial, 'nature-leaves-far', variant.leafDepth)];
    const items = indices.map((i) => trees[i]!);
    const matrices = indices.map((i) => {
      const item = trees[i]!;
      const crowd = stand.crowd[i]!;
      // Deep in a wood taller and narrower; at its edge and alone broader,
      // the crown leaning out over the open side (a shear, the foot kept).
      const tall = item.size * (0.92 + 0.22 * crowd);
      const wide = item.size * (1.12 - 0.3 * crowd) * (0.94 + ((item.seed * 5.3) % 1) * 0.12);
      const lean = 0.22 * (1 - crowd) * Math.min(1, crowd * 4);
      const sx = stand.openX[i]! * lean, sz = -stand.openY[i]! * lean;
      const c = Math.cos(item.yaw), s = Math.sin(item.yaw);
      // World = translate * shear * rotateY * scale.
      return new Matrix4().set(
        c * wide, sx * tall, s * wide, item.x,
        0, tall, 0, item.z,
        -s * wide, sz * tall, c * wide, -item.y,
        0, 0, 0, 1,
      );
    });
    // A little variety of green between trees, none of it far from the leaves' own.
    const colours = items.map((item) => {
      const t = 0.9 + ((item.seed * 3.77) % 1) * 0.2;
      return new Color(t * (0.96 + ((item.seed * 1.3) % 1) * 0.08), t, t * 0.94);
    });
    groups.push({ items, matrices, colours, levels: [near, mid, far] });
  });
  let sortedX = Infinity, sortedY = Infinity, sortedZ = Infinity;
  const sort = (x: number, y: number, z: number): void => {
    for (const g of groups) {
      const counts = [0, 0, 0];
      for (let i = 0; i < g.items.length; i++) {
        const item = g.items[i]!;
        const distance = Math.hypot(item.x - x, item.z - y, -item.y - z);
        const level = distance < NEAR_REACH ? 0 : distance < MID_REACH ? 1 : 2;
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
