import {
  BufferGeometry, Color, CylinderGeometry, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, MeshStandardMaterial,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FACE_HALF, faceToSphereInto, type Vec3 } from '@core/cubeSphere';
import { TILE_COUNT, TILES_PER_SIDE } from '@core/planetTiles';
import { sphereToChartInto } from '@world/planet/charts';
import { m } from '@world/units';
import { natureDensity } from '../natureNoise';
import { PATCH } from './globeGround';

/**
 * THE FAR GLOBE'S WOODS: the trees of every piece not kept in full
 * (`terrainAtlas.ts`), as one instanced mesh of plain low trees - a crown and
 * a trunk, some thirty triangles - standing on the far globe's ground
 * (`globeGround.ts`). The near woods (`renderer.ts` natureSweep, the
 * hand-made models) grow only on the pieces in full; without these the land
 * round them was bare from a few hundred metres up (the player, 2026-10-10:
 * "esconde estando perto"). As engines draw a forest far off (SpeedTree's
 * and Horizon Zero Dawn's far LODs: the same placement, a cheaper tree), the
 * woods stand where the near ones do: the same masses (`natureNoise.ts`,
 * read at the same map coordinates) at the same density per area, on a
 * lattice four times coarser with as many trees a cell as the fine one's
 * sixteen would grow.
 *
 * Built a few pieces a frame (`build`); a piece in full hides its own trees
 * (`setShown`: its instances zeroed, the near woods stand there instead).
 */

/** The coarse lattice's step, world units. */
const FAR_SPACING = m(20);
/** The near lattice's (`renderer.ts` NATURE_SPACING): a coarse cell holds this many of its cells. */
const NEAR_CELLS = (FAR_SPACING / m(5)) ** 2;
/** The ecosystem's canopy share where it is not worked out (the far land): a middling one. */
const FAR_ECOLOGY = 0.35;
/** Trees a flat map (`m(1 920)` square) grows at full vegetation (`renderer.ts` NATURE_TREES). */
const FLAT_TREES = 2_500;
const STEP = (2 * FACE_HALF) / TILES_PER_SIDE;

export interface GlobeForest {
  readonly mesh: InstancedMesh;
  /** Builds the next pieces' trees within `budgetMs`; false when all are built. */
  build(budgetMs: number): boolean;
  /** A piece drawn in full hides its far trees (true), or shows them again. */
  setShown(tile: number, inFull: boolean): void;
  dispose(): void;
}

/** One plain tree, a unit tall: a round crown on a short trunk. */
function treeGeometry(): BufferGeometry {
  const crown = mergeVertices(new IcosahedronGeometry(0.34, 0));
  crown.scale(1, 1.25, 1);
  crown.translate(0, 0.6, 0);
  crown.computeVertexNormals();
  const trunk = new CylinderGeometry(0.04, 0.06, 0.4, 5, 1, true);
  trunk.translate(0, 0.2, 0);
  for (const g of [crown, trunk]) g.deleteAttribute('uv');
  // The crown green, the trunk brown, by vertex.
  const tint = (g: BufferGeometry, c: Color): void => {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new InstancedBufferAttribute(a, 3));
  };
  tint(crown, new Color(1, 1, 1));
  tint(trunk, new Color(0.45, 0.3, 0.2));
  const merged = mergeGeometries([crown.toNonIndexed(), trunk.toNonIndexed()]);
  crown.dispose();
  trunk.dispose();
  return merged!;
}

const hash = (a: number, b: number, c: number): number => {
  let h = Math.imul(a | 0, 374_761_393) ^ Math.imul(b | 0, 668_265_263) ^ Math.imul(c | 0, 2_246_822_519);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
};

/** Expected trees of a coarse cell at a density (`natureSweep`'s bands, times the fine cells it holds). */
const expected = (density: number): number => {
  const odds = density > 0.62 ? 0.92 : density > 0.5 ? 0.25 + ((density - 0.5) / 0.12) * 0.6 : density > 0.38 ? 0.025 : 0.003;
  return odds * NEAR_CELLS;
};

/**
 * The far woods over the ground `heightAt` draws (`globeGround.ts`), at the
 * vegetation quality's share (`share`, 0..1).
 */
export function createGlobeForest(heightAt: (tile: number, a: number, b: number) => number, share: number): GlobeForest {
  const n = Math.round(STEP / FAR_SPACING);
  const s: Vec3 = { x: 0, y: 0, z: 0 };
  const at = { x: 0, y: 0 };
  /** A coarse cell of a piece: its map point, ground and density inputs. */
  const cell = (tile: number, ci: number, cj: number, jx: number, jy: number) => {
    const face = Math.floor(tile / (TILES_PER_SIDE * TILES_PER_SIDE));
    const k = tile % (TILES_PER_SIDE * TILES_PER_SIDE);
    const i = k % TILES_PER_SIDE, j = Math.floor(k / TILES_PER_SIDE);
    const u = (ci + jx) / n, v = (cj + jy) / n;
    faceToSphereInto(face, -FACE_HALF + (i + u) * STEP, -FACE_HALF + (j + v) * STEP, s);
    sphereToChartInto(tile, s, at);
    const a = u * PATCH, b = v * PATCH;
    const h = heightAt(tile, a, b);
    const d = 0.5;
    const slope = Math.hypot(heightAt(tile, a + d, b) - heightAt(tile, a - d, b), heightAt(tile, a, b + d) - heightAt(tile, a, b - d)) / (2 * d * (STEP / PATCH));
    const hillside = Math.min(1, Math.max(0, (slope - 0.06) / 0.35));
    return { x: at.x, y: at.y, h, density: natureDensity(at.x, at.y, m(1), hillside, FAR_ECOLOGY) };
  };
  // The density per area the near woods reach, estimated from a sample of
  // cells (every piece, a few each): the near sweep scales its odds so a
  // flat map's worth of land grows `FLAT_TREES`; so do these.
  let sampleSum = 0, samples = 0;
  for (let tile = 0; tile < TILE_COUNT; tile++) {
    for (let q = 0; q < 6; q++) {
      const c = cell(tile, Math.floor(hash(tile, q, 1) * n), Math.floor(hash(tile, q, 2) * n), 0.5, 0.5);
      sampleSum += expected(c.density);
      samples++;
    }
  }
  const cellArea = FAR_SPACING ** 2;
  const rawPerArea = sampleSum / samples / cellArea;
  const wantedPerArea = (FLAT_TREES * share) / m(1_920) ** 2;
  const scale = Math.min(1, wantedPerArea / Math.max(1e-12, rawPerArea));
  const capacity = Math.ceil(Math.min(wantedPerArea, rawPerArea) * 6 * (2 * FACE_HALF) ** 2 * 1.25) + 1024;

  const geometry = treeGeometry();
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = 'planet-far-forest';
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const colours = new Float32Array(capacity * 3);
  mesh.instanceColor = new InstancedBufferAttribute(colours, 3);
  const matrices = mesh.instanceMatrix.array as Float32Array;
  /** Each piece's trees: where they start and how many. */
  const first = new Int32Array(TILE_COUNT).fill(-1);
  const count = new Int32Array(TILE_COUNT);
  const hiddenTile = new Uint8Array(TILE_COUNT);
  /** The built matrices, kept to show a piece again after it was in full. */
  const kept = new Float32Array(capacity * 16);
  let next = 0;
  const green = new Color();

  const buildTile = (tile: number): void => {
    first[tile] = mesh.count;
    for (let cj = 0; cj < n; cj++) {
      for (let ci = 0; ci < n; ci++) {
        const centre = cell(tile, ci, cj, 0.5, 0.5);
        const e = expected(centre.density) * scale;
        const trees = Math.floor(e + hash(tile * 4096 + ci, cj, 3));
        const inner = centre.density > 0.62, edge = centre.density > 0.5;
        for (let t = 0; t < trees && mesh.count < capacity; t++) {
          const c = cell(tile, ci, cj, hash(tile, ci * 977 + cj, 10 + t), hash(tile, ci * 977 + cj, 40 + t));
          const r = hash(tile, ci * 31 + cj * 7, 70 + t);
          const size = inner ? m(11) + m(8) * r : edge ? m(8) + m(6) * r : m(5.5) + m(4) * r;
          const yaw = hash(tile, ci + cj * 131, 90 + t) * Math.PI * 2;
          const cs = Math.cos(yaw) * size, sn = Math.sin(yaw) * size;
          const o = mesh.count * 16;
          // Column-major: a turn about the up axis, scaled; sunk a little into the ground.
          matrices.set([cs, 0, -sn, 0, 0, size, 0, 0, sn, 0, cs, 0, c.x, c.h - m(0.3), -c.y, 1], o);
          kept.set(matrices.subarray(o, o + 16), o);
          const g = hash(tile, ci * 13 + cj, 120 + t);
          green.setRGB(0.12 + 0.08 * g, 0.22 + 0.1 * g, 0.08 + 0.04 * g);
          colours[mesh.count * 3] = green.r; colours[mesh.count * 3 + 1] = green.g; colours[mesh.count * 3 + 2] = green.b;
          mesh.count++;
        }
      }
    }
    count[tile] = mesh.count - first[tile]!;
    if (hiddenTile[tile]) matrices.fill(0, first[tile]! * 16, (first[tile]! + count[tile]!) * 16);
    mesh.instanceMatrix.addUpdateRange(first[tile]! * 16, count[tile]! * 16);
    mesh.instanceColor!.addUpdateRange(first[tile]! * 3, count[tile]! * 3);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
  };

  return {
    mesh,
    build(budgetMs) {
      if (next >= TILE_COUNT) return false;
      const started = performance.now();
      while (next < TILE_COUNT && performance.now() - started < budgetMs) buildTile(next++);
      return next < TILE_COUNT;
    },
    setShown(tile, inFull) {
      hiddenTile[tile] = inFull ? 1 : 0;
      const f = first[tile]!, c = count[tile]!;
      if (f < 0 || c === 0) return;
      if (inFull) matrices.fill(0, f * 16, (f + c) * 16);
      else matrices.set(kept.subarray(f * 16, (f + c) * 16), f * 16);
      mesh.instanceMatrix.addUpdateRange(f * 16, c * 16);
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
