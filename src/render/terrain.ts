import type { Aabb } from '@core/aabb';
import { Digest } from '@core/digest';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  LinearFilter,
  ClampToEdgeWrapping,
  LinearMipmapLinearFilter,
  NearestFilter,
  RedFormat,
  FloatType,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
  type Material,
  type Texture,
} from 'three';

import type { RoadDoc } from '@world/doc';
import { PAINT_KINDS, type PaintDab } from '@world/terrainPaint';
import { MAP_SIZE } from '@world/bounds';
import {
  MAX_TERRAIN_STAMPS,
  TERRAIN_WATER_HEIGHT,
  TerrainIndex,
  sampleTerrainHeight,
  terrainInfluence,
  type TerrainStamp,
} from '@world/terrain';
import { bakeSurface, fbm, makeNoise, type SurfaceBake } from './mesh/textureBaker';
import { DETAIL_GLSL, detailSwitch, detailTextures } from './mesh/detailLayer';
import { WATER_DEPTH_ATTRIBUTE, createWaterSurface } from './water';

/**
 * Side of the playable, editable terrain plate, in world units.
 *
 * The world the editor authors in is 4096 units across. The plate is a little
 * wider so the player never reaches its rim, and a separate, cheap backdrop
 * carries the view out to the horizon beyond it — a single large plate at the
 * resolution the play area needs would be most of the frame's vertex budget
 * spent on ground nobody builds on.
 */
const TERRAIN_SIZE = MAP_SIZE;
/** Cells per side. 300 gives a 16-unit cell: 6.4 m, fine enough for a brush. */
const TERRAIN_SEGMENTS = 300;
const TERRAIN_BASE = -0.12;

/** Radius of a river's water disc, as a fraction of the stamp that carved it. */
const WATER_RADIUS = 0.92;
/** How far past the brush the surface may reach to find its shore. */
const WATER_SPREAD = 1.6;
/** Share of a channel's depth the water fills, measured down from its banks. */
const WATER_FILL = 0.3;
/** How far under the ground the surface stays, so its rim is never left dry. */
const WATER_MARGIN = 0.4;
/** Grid resolution of the unified river surface. */
const WATER_CELL = 4;

/**
 * World size of one terrain quad.
 *
 * The terrain mesh holds one vertex per cell and interpolates linearly between
 * them, so anything laid on the ground must be tessellated to at most this step
 * or it chords across a bump it never sampled.
 */
export const TERRAIN_CELL = TERRAIN_SIZE / TERRAIN_SEGMENTS;

/** A shore texel with no water near it (`shoreLevels`). */
const NO_WATER = -100_000;

/** Corners per side of the terrain grid — one more than its cells. */
const GRID = TERRAIN_SEGMENTS + 1;
/**
 * Half the terrain plate's extent. Nothing may be placed outside it.
 *
 * The ground is a finite 4800-unit plate. Anything scattered beyond it hangs
 * in the void with no surface under it, which is exactly what happened to the
 * vegetation: it was spread over `max(900, networkBounds * 0.85)` about the
 * network centre with no reference to the terrain at all, so a network near an
 * edge planted trees off the end of the world.
 */
export const TERRAIN_HALF = TERRAIN_SIZE / 2;

/**
 * Where the grass field stands this frame (`grassField.ts`): world x, y, how
 * far it reaches, and 1 when it is drawn. The ground shades itself under it.
 */
export const GRASS_FIELD: { value: [number, number, number, number] } = { value: [0, 0, 0, 0] };
/**
 * The universal grid drawn by the ground itself (`SceneHandle.setGrid`): the
 * cell (world units), the strength (0: off) and the map's half size. Part of
 * the terrain's own colour, it lies on the ground as drawn whatever roads are
 * laid, changed or removed - a set of lines over the ground went under it
 * wherever the ground was cut or filled after them (the player, 2026-10-06).
 */
export const TERRAIN_GRID: { value: [number, number, number] } = { value: [25, 0, 2400] };

export interface TerrainSurface {
  readonly meshes: readonly Mesh[];
  readonly ground: Mesh;
  /**
   * The terrain's own surface for the batter from a footway down to the
   * ground (`roadSurfaces.ts`): the same lawn, read as LEVEL ground whatever
   * its slope. The batter is steep over a short run, and the slope bands of
   * the terrain shader painted it as soil and rock - brown streaks along
   * every pavement.
   */
  readonly vergeMaterial: Material;
  /** The analytic height field: the smooth surface the stamps describe. */
  heightAt(x: number, y: number): number;
  /**
   * The ground as DRAWN, before any road cut or filled it.
   *
   * This is what the road profile is solved against. Solving it against the
   * shaped surface instead would feed the roads their own previous answer, and
   * the ground and the road would chase each other a little further apart on
   * every rebuild.
   */
  naturalRenderedHeightAt(x: number, y: number): number;
  /**
   * A digest of everything `renderedHeightAt` and `naturalRenderedHeightAt`
   * read inside a rectangle: the corners, shaped and natural, of every cell
   * they touch, and the stamps themselves where the rectangle leaves the plate
   * and the field is read analytically.
   */
  digest(minX: number, minY: number, maxX: number, maxY: number): number;
  /**
   * The height the terrain is actually DRAWN at.
   *
   * The mesh samples the field at cell corners and interpolates linearly across
   * the triangles between them, so the drawn surface differs from the field by
   * up to `(cell^2 / 8) * |H''|`. Anything laid on the ground must clear what is
   * on screen, not what the field says, or it sinks into a triangle.
   */
  renderedHeightAt(x: number, y: number): number;
  /**
   * Whether a point is under a river's water.
   *
   * NOT "the ground is low": the base relief dips well below zero over whole
   * valleys with no water in them, and planting was skipped wherever it did -
   * which left the ground around a crossroads in such a valley bare.
   */
  wetAt(x: number, y: number): boolean;
  /**
   * Rewrites the heightfield from the document's stamps alone.
   *
   * The first half of a two-pass build. Roads are solved against THIS surface,
   * because a road has to be laid on the natural ground before the ground can
   * be asked to come and meet it.
   */
  update(doc: RoadDoc, stroking?: boolean): boolean;
  /** Brings the painted ground up to `doc.paintRevision`. */
  updatePaint(doc: RoadDoc): void;
  /** How much forest was painted at a point, 0..1 (`world/terrainPaint.ts` 'forest'). */
  forestAt(x: number, y: number): number;
  /** Moves whenever the forest painted changes. */
  readonly forestRevision: number;
  /**
   * The grid cells (x0, x1, y0, y1) the last `update` rewrote, or null when it
   * rewrote the whole plate: where a stroke's dab changed the ground.
   */
  readonly lastRegion: TerrainRegion | null;
  /**
   * After a stroke: what was deferred while it was held (the water) is
   * brought up to date. Cheap when nothing was deferred.
   */
  settle(): void;
  /**
   * Cuts and fills the ground so it meets the roads.
   *
   * The second half. `shape` is the solved road field; every corner inside a
   * road's corridor is pulled to the road's subgrade, and the difference is
   * carried back to the natural ground over a wide batter. Returns true when
   * anything moved, so the caller knows whether the water needs rebuilding.
   */
  /**
   * `region`: one region or several, shaped in one pass (each region's own
   * pass walked every shaped corner, every road's box and the whole plate's
   * bounds again: an edit touching 20 blocks paid that 20 times).
   */
  shapeToRoads(shape: TerrainShaper | null, region?: TerrainRegion | readonly TerrainRegion[] | null): boolean;
  dispose(): void;
}

/** A box of grid corners, inclusive: x0..x1 across, y0..y1 down. */
export type TerrainRegion = readonly [number, number, number, number];

/** What `shapeToRoads` needs to know about the road network. */
export interface TerrainShaper {
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
  /** Boxes outside which `shapeAt` always answers weight 0. */
  shapeBounds(): readonly Aabb[];
}

/**
 * Tiling noise stretched along v: the mean of samples stacked up the column,
 * which smears each blob into a streak while both axes keep the one period
 * `fbm` tiles on (a lower frequency along v alone would leave a seam).
 */
function streakNoise(noise: (x: number, y: number, period: number) => number, u: number, v: number, period: number): number {
  let sum = 0;
  for (let k = 0; k < 8; k++) sum += fbm(noise, u * period, v * period + k * 0.75, period, 2);
  // Averaging flattens the contrast; stretched back about the middle.
  return Math.min(1, Math.max(0, 0.5 + (sum / 8 - 0.5) * 2.2));
}

export function terrainBakes(anisotropy: number): {
  grass: SurfaceBake;
  rock: SurfaceBake;
  dirt: SurfaceBake;
} {
  const grassFine = makeNoise(0x1234);
  const grassClump = makeNoise(0x9f2c);
  const grass = bakeSurface(
    'terrain-grass',
    {
      size: 1024,
      worldSize: 96,
      // Read at map zoom, where a pixel is a metre or two: the detail that
      // shows is TUFTS a few metres across - dark clumps, sunlit olive, dry
      // straw spots, soil showing through - as SimCity 4's ground has. A grain
      // finer than a metre melts into the mip chain and leaves flat felt.
      relief: 0.9,
      shade: (x, y, out) => {
        const u = x / 1024;
        const v = y / 1024;
        // Domain-warped: value noise alone is laid on a square lattice and
        // its blobs read as camouflage squares; bending the lookup by a
        // second noise rounds them into tufts.
        const wx = (fbm(grassClump, u * 24 + 11, v * 24, 24, 2) - 0.5) * 2.2;
        const wy = (fbm(grassClump, u * 24, v * 24 + 29, 24, 2) - 0.5) * 2.2;
        const speck = fbm(grassFine, u * 96 + wx * 2, v * 96 + wy * 2, 96, 2);
        const tuft = fbm(grassFine, u * 32 + wx + 3.1, v * 32 + wy + 7.7, 32, 3);
        const clump = fbm(grassClump, u * 10 + wx * 0.5, v * 10 + wy * 0.5, 10, 3);
        // sRGB: deep clump green, sunlit olive, dry straw, bare soil.
        const dark = [0.25, 0.31, 0.14];
        const lit = [0.32, 0.37, 0.165];
        const dry = [0.46, 0.44, 0.26];
        const soil = [0.36, 0.3, 0.2];
        const t = Math.min(1, Math.max(0, (tuft - 0.3) / 0.42));
        const k = t * t * (3 - 2 * t);
        let r = dark[0]! + (lit[0]! - dark[0]!) * k;
        let g = dark[1]! + (lit[1]! - dark[1]!) * k;
        let b = dark[2]! + (lit[2]! - dark[2]!) * k;
        // Dry patches over the higher, sunnier tufts of some clumps.
        const dryW = Math.min(1, Math.max(0, (clump - 0.6) / 0.12)) * k * 0.45;
        r += (dry[0]! - r) * dryW; g += (dry[1]! - g) * dryW; b += (dry[2]! - b) * dryW;
        // Soil showing in the gaps between tufts.
        const soilW = Math.min(1, Math.max(0, (speck - 0.66) / 0.08)) * (1 - k) * 0.8;
        r += (soil[0]! - r) * soilW; g += (soil[1]! - g) * soilW; b += (soil[2]! - b) * soilW;
        const grain = 0.94 + speck * 0.12;
        out.r = r * grain;
        out.g = g * grain;
        out.b = b * grain;
        out.h = k * 0.7 + speck * 0.3 - soilW * 0.3;
        out.rough = 0.99;
      },
    },
    anisotropy,
  );

  const rockCrack = makeNoise(0x5ac1);
  const rockGrain = makeNoise(0x77b3);
  const rock = bakeSurface(
    'terrain-rock',
    {
      size: 512,
      worldSize: 58,
      // Broad facets of warm and cool stone, no inked cracks: a black crack
      // line every few metres drew contour stripes over every hillside.
      relief: 1.8,
      shade: (x, y, out) => {
        const u = x / 512;
        const v = y / 512;
        // Long vertical ribs and gullies, as eroded rock faces show.
        const strata = streakNoise(rockCrack, u, v, 22);
        const grain = fbm(rockGrain, u * 110, v * 110, 110, 2);
        const facet = strata;
        const tone = 0.4 + (facet - 0.5) * 0.24 + (grain - 0.5) * 0.07;
        // Warm, reddish stone rather than concrete grey.
        out.r = tone * 1.14;
        out.g = tone * 0.98;
        out.b = tone * 0.84;
        out.h = facet * 0.7 + grain * 0.3;
        out.rough = 0.92;
      },
    },
    anisotropy,
  );

  const dirtGrain = makeNoise(0x3311);
  const dirt = bakeSurface(
    'terrain-dirt',
    {
      size: 256,
      worldSize: 34,
      relief: 2.4,
      shade: (x, y, out) => {
        const u = x / 256;
        const v = y / 256;
        const grain = fbm(dirtGrain, u * 90, v * 90, 90, 3);
        const patch = fbm(dirtGrain, u * 8 + 3, v * 8 + 9, 8, 3);
        // Gullies: narrow across, long up the face, so on a bank (read from
        // the side) they run down the slope as rain cuts them.
        const gully = streakNoise(dirtGrain, u, v, 48);
        const cut = Math.max(0, 0.5 - gully) * 2;
        const tone = 0.34 + (grain - 0.5) * 0.08 + patch * 0.07 - cut * 0.09 + Math.max(0, gully - 0.6) * 0.12;
        out.r = tone * 1.08;
        out.g = tone * 0.86;
        out.b = tone * 0.64;
        out.h = grain * 0.7 + patch * 0.3;
        out.rough = 0.97;
      },
    },
    anisotropy,
  );

  return { grass, rock, dirt };
}

/**
 * The terrain material: three surfaces blended by slope, height and noise.
 *
 * One texture stretched over four kilometres of ground is what made the terrain
 * read as painted paper. Three fixes are layered here, and each is visible on
 * its own:
 *
 *  - **Slope decides the surface.** Anything steeper than about 25 degrees is
 *    rock, which is what actually gives a hill a silhouette: the colour change
 *    follows the geometry, so a slope is legible even when the sun is behind it.
 *  - **Two scales of the same texture.** Each map is sampled at its own size and
 *    again about seven times larger, and the two are mixed. Their scales do
 *    not align on every eighth tile across the terrain plate.
 *  - **Macro variation.** A slow noise tints wide regions warm or cool, so the
 *    ground has weather in it rather than one flat green.
 */
/** Texels across the map in each painted-ground weight texture. */
const PAINT_RES = 1024;

/**
 * The water's level at every terrain corner within a few cells of water, for
 * the shore bands of the terrain shader; NO_WATER elsewhere. Read off the
 * water surface itself (its vertices carry the level), so a lake and a river
 * are the same thing here, then spread outwards so the beach above the line
 * knows which water it belongs to.
 */
function shoreLevels(water: BufferGeometry, texture: DataTexture): void {
  const levels = texture.image.data as Float32Array;
  levels.fill(NO_WATER);
  const position = water.getAttribute('position');
  if (position) {
    for (let i = 0; i < position.count; i++) {
      const ix = Math.round((position.getX(i) + TERRAIN_HALF) / TERRAIN_CELL);
      const iy = Math.round((position.getZ(i) + TERRAIN_HALF) / TERRAIN_CELL);
      if (ix < 0 || iy < 0 || ix >= GRID || iy >= GRID) continue;
      const k = iy * GRID + ix;
      levels[k] = Math.max(levels[k] as number, position.getY(i));
    }
  }
  // Out three corners (48 units, about 19 m), each pass taking the highest
  // water next to it.
  for (let pass = 0; pass < 3; pass++) {
    const from = levels.slice();
    for (let iy = 0; iy < GRID; iy++) {
      for (let ix = 0; ix < GRID; ix++) {
        const k = iy * GRID + ix;
        if ((from[k] as number) > NO_WATER / 2) continue;
        let best = NO_WATER;
        if (ix > 0) best = Math.max(best, from[k - 1] as number);
        if (ix + 1 < GRID) best = Math.max(best, from[k + 1] as number);
        if (iy > 0) best = Math.max(best, from[k - GRID] as number);
        if (iy + 1 < GRID) best = Math.max(best, from[k + GRID] as number);
        levels[k] = best;
      }
    }
  }
  texture.needsUpdate = true;
}

/**
 * The land's colour map: a tint per region, a few hundred metres to a field,
 * stored as half its factor (0.5 = unchanged) so the shader multiplies the
 * grass by it. Domain-warped, so fields have the soft, irregular edges of
 * country seen from the air, not noise blobs.
 */
function macroTexture(anisotropy: number): DataTexture {
  const res = 256;
  const fields = makeNoise(0x6d1c);
  const warp = makeNoise(0x2b77);
  // Tint factors: lush, yellowing meadow, deep green, olive.
  const lush = [0.84, 1.08, 0.84];
  const meadow = [1.24, 1.1, 0.7];
  const deep = [0.7, 0.86, 0.84];
  const olive = [1.1, 0.96, 0.76];
  const data = new Uint8Array(res * res * 4);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const u = x / res;
      const v = y / res;
      const wx = (fbm(warp, u * 6, v * 6, 6, 3) - 0.5) * 1.6;
      const wy = (fbm(warp, u * 6 + 17, v * 6 + 5, 6, 3) - 0.5) * 1.6;
      const a = fbm(fields, u * 4 + wx, v * 4 + wy, 4, 4);
      const b = fbm(fields, u * 8 + wy + 31, v * 8 + wx + 7, 8, 3);
      const k1 = Math.min(1, Math.max(0, (a - 0.42) / 0.2));
      const k2 = Math.min(1, Math.max(0, (b - 0.55) / 0.15));
      const k3 = Math.min(1, Math.max(0, (0.4 - a) / 0.12));
      const i = (y * res + x) * 4;
      for (let c = 0; c < 3; c++) {
        let t = lush[c]! + (meadow[c]! - lush[c]!) * k1;
        t += (deep[c]! - t) * k2 * 0.8;
        t += (olive[c]! - t) * k3 * 0.7;
        data[i + c] = Math.round(Math.min(1, t / 2) * 255);
      }
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, res, res, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

function paintTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array(PAINT_RES * PAINT_RES * 4), PAINT_RES, PAINT_RES, RGBAFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Lays one dab into the weight textures: within its radius every layer moves
 * toward the dab's (grass: toward none) by the dab's strength times a smooth
 * falloff, so the weights keep summing to at most one.
 */
function rasterPaint(textures: readonly DataTexture[], dab: PaintDab): void {
  const a = textures[0]!.image.data as Uint8Array;
  const b = textures[1]!.image.data as Uint8Array;
  const layer = PAINT_KINDS.indexOf(dab.kind);
  const cell = TERRAIN_SIZE / PAINT_RES;
  const cx = (dab.x + TERRAIN_HALF) / cell;
  const cy = (dab.y + TERRAIN_HALF) / cell;
  const r = dab.radius / cell;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(PAINT_RES - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(PAINT_RES - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / Math.max(1e-6, r);
      if (d >= 1) continue;
      const fall = 1 - d * d * (3 - 2 * d);
      const w = Math.min(1, dab.strength * fall);
      const i = (y * PAINT_RES + x) * 4;
      for (let k = 0; k < 8; k++) {
        const data = k < 4 ? a : b;
        const j = i + (k & 3);
        const target = k === layer ? 255 : 0;
        data[j] = Math.round(data[j]! + (target - data[j]!) * w);
      }
    }
  }
}

/** Side of the forest density grid over the plate (7.5 m a cell). */
const FOREST_RES = 256;

/** Lays one dab into the forest density: forest towards full, any other ground towards none. */
function rasterForest(forest: Uint8Array, dab: PaintDab): void {
  const cell = TERRAIN_SIZE / FOREST_RES;
  const cx = (dab.x + TERRAIN_HALF) / cell, cy = (dab.y + TERRAIN_HALF) / cell, r = dab.radius / cell;
  const target = dab.kind === 'forest' ? 255 : 0;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(FOREST_RES - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(FOREST_RES - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / Math.max(1e-6, r);
      if (d >= 1) continue;
      const w = Math.min(1, dab.strength * (1 - d * d * (3 - 2 * d)));
      const i = y * FOREST_RES + x;
      forest[i] = Math.round(forest[i]! + (target - forest[i]!) * w);
    }
  }
}

function terrainMaterial(
  bakes: {
    grass: SurfaceBake;
    rock: SurfaceBake;
    dirt: SurfaceBake;
  },
  anisotropy: number,
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    map: bakes.grass.map,
    normalMap: bakes.grass.normalMap,
    roughness: 1,
    metalness: 0,
    side: FrontSide,
    // Almost no environment reflection: a dielectric's 4 % reflects the whole
    // sky at any roughness, and over a field of grass that is the plastic sheen.
    envMapIntensity: 0.12,
  });
  material.normalScale.set(0.8, 0.8);

  const grassDetail = detailTextures('grass', anisotropy);
  const soilDetail = detailTextures('soil', anisotropy);
  const paintA = paintTexture();
  const paintB = paintTexture();
  material.userData['paint'] = [paintA, paintB];
  // The water's level at each terrain corner near water (`shoreLevels`),
  // NO_WATER elsewhere: where the ground stands just above it is beach,
  // just at it is wet, under it is the bed.
  const shore = new DataTexture(new Float32Array(GRID * GRID).fill(NO_WATER), GRID, GRID, RedFormat, FloatType);
  shore.magFilter = NearestFilter;
  shore.minFilter = NearestFilter;
  shore.generateMipmaps = false;
  shore.needsUpdate = true;
  material.userData['shore'] = shore;
  const uniforms = {
    uPaintA: { value: paintA as Texture },
    uPaintB: { value: paintB as Texture },
    uPaintHalf: { value: TERRAIN_HALF },
    uPaintSize: { value: TERRAIN_SIZE },
    uGrassField: GRASS_FIELD,
    uGrid: TERRAIN_GRID,
    uShore: { value: shore as Texture },
    uShoreGrid: { value: new Vector3(TERRAIN_HALF, TERRAIN_CELL, GRID) },
    uRockMap: { value: bakes.rock.map as Texture },
    uRockNormal: { value: bakes.rock.normalMap as Texture },
    uDirtMap: { value: bakes.dirt.map as Texture },
    uMacroMap: { value: macroTexture(anisotropy) as Texture },
    uGrassScale: { value: 1 / 96 },
    uRockScale: { value: 1 / 58 },
    uDirtScale: { value: 1 / 34 },
    // The close-zoom layer (see `mesh/detailLayer.ts`): blades over grass,
    // grit over dirt and rock, faded in by pixel footprint.
    uDetailOn: detailSwitch,
    uGrassDetail: { value: grassDetail.map },
    uGrassDetailN: { value: grassDetail.normalMap },
    uGrassDetailScale: { value: 1 / grassDetail.worldSize },
    uSoilDetail: { value: soilDetail.map },
    uSoilDetailN: { value: soilDetail.normalMap },
    uSoilDetailScale: { value: 1 / soilDetail.worldSize },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vTerrainWorld;
         varying vec3 vTerrainNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vTerrainWorld;
         varying vec3 vTerrainNormal;
         uniform sampler2D uRockMap;
         uniform sampler2D uPaintA;
         uniform sampler2D uPaintB;
         uniform float uPaintHalf;
         uniform float uPaintSize;
         uniform vec4 uGrassField; // world x, y, reach, on
         uniform vec3 uGrid; // cell, strength, map half
         uniform sampler2D uShore;
         uniform vec3 uShoreGrid; // half, cell, corners per side
         // The water level at the nearest terrain corner (NO_WATER if none).
         float terrainShoreLevel(vec3 world) {
           vec2 g = (world.xz + uShoreGrid.x) / uShoreGrid.y;
           ivec2 p = ivec2(clamp(floor(g + 0.5), vec2(0.0), vec2(uShoreGrid.z - 1.0)));
           return texelFetch(uShore, p, 0).r;
         }
         uniform sampler2D uRockNormal;
         uniform sampler2D uDirtMap;
         uniform sampler2D uMacroMap;
         uniform float uGrassScale;
         uniform float uRockScale;
         uniform float uDirtScale;
         uniform sampler2D uGrassDetail;
         uniform sampler2D uGrassDetailN;
         uniform float uGrassDetailScale;
         uniform sampler2D uSoilDetail;
         uniform sampler2D uSoilDetailN;
         uniform float uSoilDetailScale;
         ${DETAIL_GLSL}

         // Set once per fragment, before the first dualScale read: how far the
         // close-zoom layer has taken over, and so how much softer to read the
         // magnified macro maps.
         float terrainDetailW = 0.0;

         // Rotate the wide octave, as well as using an incommensurate scale:
         // otherwise the most visible clumps line up with their own repeats.
         vec2 terrainWideUv(vec2 uv) {
           return vec2(uv.x * 0.9396926 - uv.y * 0.3420201,
                       uv.x * 0.3420201 + uv.y * 0.9396926) * 0.137;
         }
         vec4 dualScale(sampler2D tex, vec2 uv) {
           vec4 near = texture2D(tex, uv, terrainDetailW * 2.2);
           vec4 far = texture2D(tex, terrainWideUv(uv));
           return mix(near, far, 0.42);
         }
         vec3 dualScaleNormal(sampler2D tex, vec2 uv) {
           vec3 near = texture2D(tex, uv, terrainDetailW * 2.2).xyz * 2.0 - 1.0;
           vec3 far = texture2D(tex, terrainWideUv(uv)).xyz * 2.0 - 1.0;
           // Bring the wide octave's tangent slope back into the ground frame.
           far.xy = vec2(far.x * 0.9396926 + far.y * 0.3420201,
                        -far.x * 0.3420201 + far.y * 0.9396926);
           return mix(near, far, 0.42);
         }

         // A WALL is not a floor. The ground's textures are read in a plan
         // view, which smears a 45-degree cliff into vertical stripes: the
         // steeper the land the more of the map's area it covers, and once the
         // brush could raise mountains, whole hillsides were stripes.
         //
         // A cliff is read by the projection that faces it instead - the rock
         // map sampled in the z-y plane for a face across z, in x-y for one
         // across x - blended by how much of the normal points each way. Only
         // the rock needs it: grass and soil live on ground gentle enough for
         // the plan view, and rockMix is zero there anyway.
         vec3 terrainWallAxis() {
           vec3 n = abs(normalize(vTerrainNormal));
           return vec3(n.x / max(0.0001, n.x + n.z), 0.0, 0.0);
         }
         vec2 terrainWallUv(vec3 world, float scale, float wXl) {
           // u runs across the face, v up it.
           vec2 acrossX = world.zy * scale;
           vec2 acrossZ = world.xy * scale;
           return mix(acrossZ, acrossX, wXl);
         }
         // TRIPLANAR (GPU Gems 3 ch. 1; Golus, "Normal Mapping for a Triplanar
         // Shader"): one sample per plane, the SAMPLES blended. Blending the
         // coordinates instead (terrainWallUv) twisted the rock into curved
         // wood grain wherever a face turned between the two axes.
         vec3 terrainTriWeights(vec3 n) {
           vec3 w = pow(abs(n), vec3(4.0));
           return w / max(w.x + w.y + w.z, 1e-4);
         }
         vec4 terrainTriColor(sampler2D tex, vec3 p, float scale, vec3 w) {
           return texture2D(tex, p.zy * scale) * w.x + texture2D(tex, p.xz * scale) * w.y + texture2D(tex, p.xy * scale) * w.z;
         }
         // The UDN blend with each axis's sign restored, in WORLD space.
         vec3 terrainTriNormal(sampler2D tex, vec3 p, float scale, vec3 n, vec3 w) {
           vec3 tx = texture2D(tex, p.zy * scale).xyz * 2.0 - 1.0;
           vec3 ty = texture2D(tex, p.xz * scale).xyz * 2.0 - 1.0;
           vec3 tz = texture2D(tex, p.xy * scale).xyz * 2.0 - 1.0;
           vec3 s = sign(n);
           tx = vec3(tx.xy + n.zy, abs(n.x) * s.x);
           ty = vec3(ty.xy + n.xz, abs(n.y) * s.y);
           tz = vec3(tz.xy + n.xy, abs(n.z) * s.z);
           return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
         }`,
      )
      .replace(
        '#include <map_fragment>',
        `terrainDetailW = detailWeight(vTerrainWorld.xz);
         vec2 tGrass = vTerrainWorld.xz * uGrassScale;
         vec2 tDirt = vTerrainWorld.xz * uDirtScale;
         float wallX = terrainWallAxis().x;
         vec2 tRock = terrainWallUv(vTerrainWorld, uRockScale, wallX);
         vec3 triN = normalize(vTerrainNormal);
         vec3 triW = terrainTriWeights(triN);
         // In DEGREES, not in one-minus-cosine. The cosine of a small angle is
         // almost one, so thresholds written against it are unreadable and were
         // simply wrong: a 10-degree hillside came out at 0.015, under a
         // threshold meant to start at a gentle slope, and the whole map stayed
         // one flat green however steep it got.
         float slopeDeg = degrees(acos(clamp(vTerrainNormal.y, 0.0, 1.0)));
         // High ground is bare whatever its slope: the quickest way to say
         // "mountain" is that nothing grows on the top of it.
         float altitude = smoothstep(260.0, 460.0, vTerrainWorld.y);
         // The bands are in degrees of slope, and they were set for land that
         // could not rise more than ten metres: soil from 9 degrees, rock from
         // 26. On a map with real hills that painted every hillside tan, and
         // the whole country read as savanna. Soil now starts where a slope
         // stops holding turf (18 degrees), rock where it stops holding soil.
         //
         // The bands WANDER: a slow noise shifts each threshold by up to some
         // fifteen degrees, so the soil and the rock follow the landform
         // loosely instead of drawing concentric rings round every hill.
         float wanderA = texture2D(uDirtMap, vTerrainWorld.xz * 0.0023).g;
         float wanderB = texture2D(map, terrainWideUv(vTerrainWorld.xz * 0.011)).g;
         // And a hill-sized one (about 50 m), or a hill still wears one
         // even, wobbly ring of soil round its foot.
         float wanderC = texture2D(uDirtMap, vTerrainWorld.xz * 0.02 + 0.37).g;
         // And a ragged one of about 12 m, so the edge itself frays.
         float wanderD = texture2D(uDirtMap, vTerrainWorld.xz * 0.083 + 0.61).b;
         float wander = (wanderA - 0.5) * 14.0 + (wanderB - 0.5) * 10.0 + (wanderC - 0.5) * 30.0 + (wanderD - 0.5) * 16.0;
         float rockW = max(smoothstep(32.0, 50.0, slopeDeg + wander), altitude * 0.92);
         float dirtW = smoothstep(18.0, 36.0, slopeDeg + wander * 1.3) * (1.0 - rockW);
         float grassW = max(0.0, 1.0 - rockW - dirtW);
         vec4 grassColor = dualScale(map, tGrass);
         vec4 rockColor = terrainTriColor(uRockMap, vTerrainWorld, uRockScale, triW);
         // Soil on a slope is read from the side, as the rock is: from above
         // it smeared down every bank in long streaks.
         vec4 dirtPlan = dualScale(uDirtMap, tDirt);
         vec4 dirtSide = terrainTriColor(uDirtMap, vTerrainWorld, uDirtScale, triW);
         vec4 dirtColor = mix(dirtPlan, dirtSide, smoothstep(22.0, 42.0, slopeDeg));
         // Height blending (Mishkinis, "Advanced Terrain Texture Splatting"):
         // each surface rises by its own relief, read from its brightness, and
         // the highest within a thin depth wins, so soil fills the hollows
         // between stones and the turf breaks into tufts at its edge instead
         // of a soft fade. A surface with no weight gets no relief either.
         float hGrass = grassW + dot(grassColor.rgb, vec3(0.3, 0.6, 0.1)) * 1.4 * smoothstep(0.0, 0.35, grassW);
         float hDirt = dirtW + dot(dirtColor.rgb, vec3(0.3, 0.6, 0.1)) * 0.9 * smoothstep(0.0, 0.35, dirtW);
         float hRock = rockW + dot(rockColor.rgb, vec3(0.3, 0.6, 0.1)) * 1.1 * smoothstep(0.0, 0.35, rockW);
         float hTop = max(hGrass, max(hDirt, hRock)) - 0.12;
         float bGrass = max(hGrass - hTop, 0.0);
         float bDirt = max(hDirt - hTop, 0.0);
         float bRock = max(hRock - hTop, 0.0);
         float bSum = max(bGrass + bDirt + bRock, 1e-4);
         float rockMix = bRock / bSum;
         float dirtMix = bDirt / bSum;
         vec4 blended = (grassColor * bGrass + dirtColor * bDirt + rockColor * bRock) / bSum;
         if (terrainDetailW > 0.001) {
           vec3 bladeDetail = detailSample(uGrassDetail, vTerrainWorld.xz * uGrassDetailScale);
           vec3 soilDetail = detailSample(uSoilDetail, terrainWallUv(vTerrainWorld, uSoilDetailScale, wallX));
           // Blades only where the ground is gentle: projected from above
           // onto a bank they stretched into long hairs.
           float soilMix = max(clamp(dirtMix + rockMix, 0.0, 1.0), smoothstep(12.0, 24.0, slopeDeg));
           vec3 fine = mix(bladeDetail, soilDetail, soilMix);
           blended.rgb *= mix(vec3(1.0), fine, terrainDetailW);
         }
         // The land's own colour map, as an aerial photograph shows it: wide
         // fields of lush green, yellowing meadow, deep green and olive, a few
         // hundred metres each (macroTexture). It tints the grass fully and
         // the bare ground a little, so a valley reads as country and not as
         // one lawn tiled to the horizon.
         vec3 macroTint = texture2D(uMacroMap, terrainWideUv(vTerrainWorld.xz) * 0.0024).rgb * 2.0;
         blended.rgb *= mix(vec3(1.0), macroTint, 1.0 - (rockMix + dirtMix) * 0.7);
         // A hillshade written into the ALBEDO, on top of the light the surface
         // actually receives. Direct sun alone moves a 10-degree slope by about
         // a tenth, which is under what the eye reads as shape at map zoom; this
         // doubles that for the slopes that carry the landform and leaves flat
         // ground untouched, so the hills are legible without the scene turning
         // into a relief map.
         float relief = clamp(dot(normalize(vTerrainNormal), normalize(vec3(0.24, 0.62, -0.75))), -1.0, 1.0);
         // The shore (Terragen's "wet shores": a band set by height over the
         // water, darkened where it is wet). Under the water a muddy bed, at
         // the waterline a dark wet strip, above it a beach of pale sand that
         // only lies where the bank is gentle enough to hold it.
         float shoreLevel = terrainShoreLevel(vTerrainWorld);
         if (shoreLevel > ${NO_WATER / 2}.0) {
           float above = vTerrainWorld.y - shoreLevel;
           float sandLuma = dot(dirtPlan.rgb, vec3(0.3, 0.6, 0.1));
           vec3 sand = vec3(0.42, 0.36, 0.23) * (0.82 + sandLuma * 1.4);
           float gentle = 1.0 - smoothstep(24.0, 40.0, slopeDeg);
           float beach = (1.0 - smoothstep(2.5 + wanderD * 3.0, 6.0 + wanderD * 3.0, above)) * gentle;
           blended.rgb = mix(blended.rgb, sand, beach * (1.0 - rockMix * 0.6));
           // A steep bank holds no beach: it is a cut of damp earth from the
           // water up to the turf, frayed at its top.
           float bank = (1.0 - smoothstep(5.0 + wanderD * 5.0, 10.0 + wanderD * 5.0, above)) * (1.0 - gentle);
           blended.rgb = mix(blended.rgb, dirtColor.rgb * vec3(0.78, 0.72, 0.62), bank * (1.0 - rockMix));
           // Below the water: the bed goes to a dark olive mud with depth.
           float bed = smoothstep(0.0, -3.0, above);
           blended.rgb = mix(blended.rgb, vec3(0.16, 0.15, 0.09) * (0.8 + sandLuma), bed * 0.8);
           // Wet: darker from a little above the line down into the water.
           float wet = 1.0 - smoothstep(-0.2, 1.4, above);
           blended.rgb *= mix(1.0, 0.6, wet);
         }
         // Kept gentle: at 0.46 the far side of every hill went navy.
         blended.rgb *= 1.0 + relief * 0.26 * smoothstep(1.5, 13.0, slopeDeg);
         // Higher ground dries out, low ground stays lush. Measured in the
         // units the land can actually reach now (a 560-unit mountain), so a
         // valley town stays green instead of the whole map turning tan the
         // moment the ground passes ten metres.
         float dryness = smoothstep(10.0, 240.0, vTerrainWorld.y);
         blended.rgb = mix(blended.rgb, blended.rgb * vec3(1.16, 1.07, 0.8), dryness * 0.6);
         // Hollows hold moisture and read darker, which is the cue that tells a
         // dip from a rise when the sun is behind the slope.
         float damp = smoothstep(2.0, -40.0, vTerrainWorld.y);
         blended.rgb *= mix(1.0, 0.78, damp * 0.7);
         // Under the grass field the ground is the shade between the blades:
         // darker, so the blades stand in a lawn and not on a bright card.
         float grassDist = distance(vec2(vTerrainWorld.x, -vTerrainWorld.z), uGrassField.xy);
         float grassUnder = uGrassField.w * (1.0 - smoothstep(uGrassField.z * 0.45, uGrassField.z * 0.95, grassDist));
         blended.rgb *= mix(1.0, 0.66, grassUnder * (1.0 - clamp(dirtMix + rockMix, 0.0, 1.0)));
         // Painted ground (world/terrainPaint.ts): a weight per layer, the
         // grass showing through what the weights leave.
         vec2 paintUv = vec2((vTerrainWorld.x + uPaintHalf) / uPaintSize, (uPaintHalf - vTerrainWorld.z) / uPaintSize);
         vec4 pa = texture2D(uPaintA, paintUv);
         vec4 pb = texture2D(uPaintB, paintUv);
         float painted = pa.r + pa.g + pa.b + pa.a + pb.r + pb.g + pb.b;
         if (painted > 0.002) {
           float grain = texture2D(uDirtMap, vTerrainWorld.xz * 0.11).r;
           float speck = texture2D(uDirtMap, vTerrainWorld.xz * 0.53).r;
           vec3 soilTex = dirtColor.rgb;
           vec3 sand = vec3(0.80, 0.70, 0.50) * mix(0.86, 1.1, grain) * mix(0.94, 1.04, speck);
           vec3 soil = soilTex * vec3(0.92, 0.78, 0.62) * mix(0.8, 1.08, grain);
           vec3 meadow = grassColor.rgb * vec3(0.95, 1.08, 0.62) * mix(0.75, 1.15, speck);
           vec3 snow = vec3(0.92, 0.94, 0.97) * mix(0.93, 1.0, grain);
           vec3 gravel = vec3(0.55, 0.54, 0.51) * mix(0.6, 1.25, speck) * mix(0.9, 1.05, grain);
           vec3 asphalt = vec3(0.17, 0.17, 0.19) * mix(0.85, 1.15, speck);
           vec3 concrete = vec3(0.66, 0.65, 0.62) * mix(0.9, 1.06, grain) * mix(0.96, 1.03, speck);
           float keep = clamp(1.0 - painted, 0.0, 1.0);
           vec3 layered = sand * pa.r + soil * pa.g + meadow * pa.b + snow * pa.a +
             gravel * pb.r + asphalt * pb.g + concrete * pb.b;
           blended.rgb = blended.rgb * keep + layered / max(1.0, painted);
         }
         diffuseColor *= blended;
         // The grid: a line a pixel wide at every cell, on the map only.
         if (uGrid.y > 0.0) {
           vec2 g = vec2(vTerrainWorld.x, -vTerrainWorld.z) / uGrid.x;
           vec2 toLine = abs(fract(g - 0.5) - 0.5) / max(fwidth(g), vec2(1e-4));
           float line = 1.0 - min(min(toLine.x, toLine.y), 1.0);
           float onMap = step(abs(vTerrainWorld.x), uGrid.z) * step(abs(vTerrainWorld.z), uGrid.z);
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), line * uGrid.y * onMap);
         }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 grassN = dualScaleNormal(normalMap, vTerrainWorld.xz * uGrassScale);
         // The rock's bumps, triplanar in world space like its colour, then
         // brought into the geometry's tangent frame so the two can be mixed.
         vec3 rockWorldN = terrainTriNormal(uRockNormal, vTerrainWorld, uRockScale, triN, triW);
         vec3 rockN = vec3(dot(rockWorldN, tbn[0]), dot(rockWorldN, tbn[1]), dot(rockWorldN, tbn[2]));
         // Softened: with height blending the rock's edge is crisp, and its
         // full relief turned every facet facing away from the sun into a
         // black blot.
         rockN = normalize(mix(rockN, vec3(0.0, 0.0, 1.0), 0.45));
         vec3 mapN = normalize(mix(grassN, rockN, rockMix));
         mapN.xy *= normalScale;
         if (terrainDetailW > 0.001) {
           vec3 bladeN = detailNormal(uGrassDetailN, vTerrainWorld.xz * uGrassDetailScale);
           vec3 soilN = detailNormal(uSoilDetailN, vTerrainWorld.xz * uSoilDetailScale);
           vec3 fineN = mix(bladeN, soilN, clamp(dirtMix + rockMix, 0.0, 1.0));
           mapN.xy += fineN.xy * 1.2 * terrainDetailW;
         }
         normal = normalize(tbn * mapN);`,
      );
  };
  // A changed program key forces three to compile this variant separately from
  // any other standard material in the scene.
  material.customProgramCacheKey = () => 'terrain-splat-v9';
  return material;
}

/** Metres along the rim one strata texture spans before it repeats. */
const STRATA_SPAN_X = 320;
/** Metres of depth one strata texture spans before it repeats. */
const STRATA_SPAN_Y = 260;
/** How far the map's cut sides reach below the base level (SimCity 4's slab). */
const SLAB_DEPTH = 320;
/** The darker topsoil band under the rim, in metres. */
const TOPSOIL = 4;

/**
 * The soil layers of the map's cut sides: horizontal bands of earth, clay and
 * stone, wavy rather than ruled, with a fine grain over them. Periodic noise,
 * so it tiles along the rim and down the wall with no seam.
 */
function strataTexture(anisotropy: number): DataTexture {
  const res = 256;
  const noise = makeNoise(4_177);
  // sRGB, top to bottom of one repeat.
  const layers: readonly (readonly [number, number, number])[] = [
    [132, 92, 60], [158, 118, 78], [120, 84, 56], [170, 134, 90],
    [140, 100, 66], [116, 82, 58], [162, 124, 84], [128, 92, 64],
  ];
  const data = new Uint8Array(res * res * 4);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const warp = fbm(noise, x / 32, y / 32, 8, 3) - 0.5;
      const t = (y / res) * layers.length + warp * 1.4;
      const band = ((Math.floor(t) % layers.length) + layers.length) % layers.length;
      const colour = layers[band]!;
      const grain = 0.88 + 0.24 * fbm(noise, x / 4 + 97, y / 4 + 31, 64, 3);
      // A thin dark seam at each band's top edge, as a cut bank shows.
      const seam = t - Math.floor(t) < 0.035 ? 0.86 : 1;
      const i = (y * res + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = Math.min(255, colour[c]! * grain * seam);
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, res, res, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The cut sides' material: the strata texture, and over it what a painted
 * cross-section shows at its top - a ragged lip of turf hanging over the
 * edge, a dark band of topsoil with roots under it - and at its bottom the
 * layers giving way to grey bedrock. Drawn from the metres under the rim
 * (`aBelow`), so the lip follows a hill as the rim does.
 */
function wallMaterial(anisotropy: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    map: strataTexture(anisotropy),
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.1,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
         attribute float aBelow;
         varying float vBelow;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
         vBelow = aBelow;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
         varying float vBelow;
         float wallHash(float n) { return fract(sin(n) * 43758.5453); }
         // 1-D value noise along the rim, in metres.
         float wallNoise(float x) {
           float i = floor(x);
           float f = fract(x);
           return mix(wallHash(i), wallHash(i + 1.0), f * f * (3.0 - 2.0 * f));
         }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
         float along = vMapUv.x * ${STRATA_SPAN_X.toFixed(1)};
         // The turf lip: 5 to 12 m, ragged in tufts, thick enough to read at map zoom.
         float lip = 5.0 + 5.0 * wallNoise(along * 0.12) + 2.5 * wallNoise(along * 0.6 + 11.0);
         // The topsoil under it, darker and redder, with a wavy bottom.
         float soil = lip + 10.0 + 8.0 * wallNoise(along * 0.04 + 5.0);
         vec3 strata = diffuseColor.rgb;
         vec3 topsoil = vec3(0.2, 0.13, 0.085) * (0.85 + 0.3 * wallNoise(along * 2.3 + vBelow * 1.7));
         // Roots: thin pale streaks hanging into the topsoil.
         float root = step(0.9, wallNoise(along * 0.9)) * smoothstep(soil, lip, vBelow);
         topsoil = mix(topsoil, vec3(0.42, 0.33, 0.22), root * 0.6);
         vec3 turf = mix(vec3(0.24, 0.34, 0.13), vec3(0.15, 0.22, 0.09), smoothstep(0.0, lip, vBelow));
         vec3 wall = mix(topsoil, strata, smoothstep(soil - 0.6, soil + 0.6, vBelow));
         // Bedrock: the deep layers turn to grey stone.
         float bedrock = smoothstep(230.0, 300.0, vBelow + 30.0 * wallNoise(along * 0.02));
         wall = mix(wall, vec3(0.13, 0.12, 0.11) * (0.7 + 1.2 * strata.r), bedrock * 0.8);
         wall = mix(wall, turf, 1.0 - smoothstep(lip - 0.6, lip + 0.6, vBelow));
         diffuseColor.rgb = wall;`);
  };
  material.customProgramCacheKey = () => 'terrain-walls-v1';
  return material;
}

export function createTerrainSurface(anisotropy: number): TerrainSurface {
  const bakes = terrainBakes(anisotropy);
  const material = terrainMaterial(bakes, anisotropy);

  const geometry = new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  const ground = new Mesh(geometry, material);
  ground.name = 'terrain-ground';
  ground.receiveShadow = true;
  // The ground does NOT cast.
  //
  // It is a single 301x301 heightfield - 180 000 triangles - and casting meant
  // rasterising every one of them a second time into the shadow map each
  // frame. What that bought was self-shadowing across one wide cascade whose
  // texels are around a world unit across at play zoom, which does not resolve
  // a hillside; what it actually produced was acne, the irregular dark
  // diagonal banding on open grass that has nothing casting it. Roads,
  // structures, props and agents all still cast onto the ground, which is
  // every shadow the player is actually looking at.
  ground.castShadow = false;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();

  // Land beyond the editable plate, so the map does not end in mid-air.
  //
  // It is a FRAME, not a plane. A plane under the plate is the wrong shape: the
  // plate's own ground dips below it wherever the base relief goes negative, and
  // the plane then draws straight over the terrain, the roads and everything on
  // them — which is exactly how a full plane hid most of the road network behind
  // a grey sheet. A frame occupies only the ground the plate does not.
  //
  // Its INNER ring is stitched to the plate's own rim (see `rebuildFrame`): a
  // constant-height frame was fine while the land could only move ten metres
  // either way, and became a straight slice through mountains and pits the
  // moment the brush could make them.
  const backdrop = new Mesh(
    new BufferGeometry(),
    new MeshStandardMaterial({ color: new Color(0x53694a), roughness: 1, metalness: 0 }),
  );
  backdrop.name = 'terrain-backdrop';
  backdrop.receiveShadow = false;
  backdrop.matrixAutoUpdate = false;
  backdrop.updateMatrix();

  // The map's cut sides, SimCity 4's slab: from the rim straight down to a flat
  // bottom, in soil layers, so the plate reads as a block of land standing on
  // the plain background rather than a sheet ending in mid-air. In play the
  // backdrop is drawn over the rim and hides them.
  const walls = new Mesh(
    new BufferGeometry(),
    wallMaterial(anisotropy),
  );
  walls.name = 'terrain-walls';
  walls.receiveShadow = false;
  walls.castShadow = false;
  walls.matrixAutoUpdate = false;
  walls.updateMatrix();

  const waterSurface = createWaterSurface(anisotropy);
  const water = new Mesh(new BufferGeometry(), waterSurface.material);
  water.name = 'terrain-water';
  water.receiveShadow = false;
  water.castShadow = false;
  water.matrixAutoUpdate = false;
  water.updateMatrix();
  // The river animates itself from here on: nothing in the draw loop has to
  // know that the terrain owns something with a clock in it.
  waterSurface.attach(water);

  let index = new TerrainIndex([], 0);
  let revision = -1;

  /** The land the player sculpted, with no road in it. */
  const naturalHeightAt = (x: number, y: number): number =>
    TERRAIN_BASE + sampleTerrainHeight(index, x, y);

  // The heights the mesh actually carries, one per grid corner, so
  // `renderedHeightAt` interpolates exactly the numbers that are on screen.
  const grid = new Float64Array(GRID * GRID);
  /** The same corners before any road shaped them, so shaping is idempotent. */
  const natural = new Float64Array(GRID * GRID);
  /** Corners a road has moved, so an unshaped one can be restored cheaply. */
  let shapedCorners: number[] = [];
  /** The cells the last `update` rewrote (see `lastRegion`). */
  let lastRegion: TerrainRegion | null = null;
  /** The water waits for the end of a stroke (see `settle`). */
  let waterStale = false;
  let lastStamps: readonly TerrainStamp[] = [];

  const heightAt = naturalHeightAt;

  // The drawn corners again, for the water to measure its depth per pixel
  // (`WaterSurface.setGround`). Refreshed with the water.
  const groundTexture = new DataTexture(new Float32Array(GRID * GRID), GRID, GRID, RedFormat, FloatType);
  groundTexture.magFilter = NearestFilter;
  groundTexture.minFilter = NearestFilter;
  groundTexture.generateMipmaps = false;
  waterSurface.setGround(groundTexture, TERRAIN_HALF, TERRAIN_CELL, GRID);

  /** Bilinear read of one corner array, reproducing the plane's own diagonal. */
  const sampleGrid = (corners: Float64Array, x: number, y: number): number => {
    if (!(x >= -TERRAIN_HALF && x <= TERRAIN_HALF && y >= -TERRAIN_HALF && y <= TERRAIN_HALF)) {
      return naturalHeightAt(x, y);
    }
    // `PlaneGeometry` lays its rows from +y downwards, so the row index grows as
    // world y falls.
    const gx = (x + TERRAIN_HALF) / TERRAIN_CELL;
    const gy = (TERRAIN_HALF - y) / TERRAIN_CELL;
    const ix = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(gx));
    const iy = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(gy));
    const u = gx - ix;
    const v = gy - iy;
    const a = corners[ix + iy * GRID] as number;
    const b = corners[ix + (iy + 1) * GRID] as number;
    const c = corners[ix + 1 + (iy + 1) * GRID] as number;
    const d = corners[ix + 1 + iy * GRID] as number;
    // Each cell is split into (a, b, d) and (b, c, d): the diagonal runs b-d.
    return u + v <= 1 ? a * (1 - u - v) + d * u + b * v : b * (1 - u) + c * (u + v - 1) + d * (1 - v);
  };

  const renderedHeightAt = (x: number, y: number): number => sampleGrid(grid, x, y);
  const naturalRenderedHeightAt = (x: number, y: number): number => sampleGrid(natural, x, y);

  /**
   * Stitches the land outside the plate to the plate's own rim.
   *
   * The inner ring IS the rim: one vertex per plate cell, at the height the
   * triangles are drawn at (`grid`), so the seam is watertight whatever the
   * player sculpts — a mountain cut off by the map's edge, a pit at the
   * corner. From there the ground steps down to the distant level over two
   * wide rings, so a hillside at the edge reads as land falling away.
   *
   * It used to be one flat sheet at a fixed height, which was honest while
   * the brush could only move the ground ten metres; the moment it could
   * build a mountain, the sheet sliced through it.
   *
   * Rebuilt whenever the rim moves — a terrain edit or a road shaping the
   * ground near the edge — and it is 2 400 vertices, so that is a fraction of
   * a frame, not a budget.
   */
  const FRAME_STEP_OUT = 700;
  const FRAME_FAR = 13_000;
  const DISTANT_LEVEL = TERRAIN_BASE - 3.5;
  const rebuildFrame = (): void => {
    const half = TERRAIN_HALF;
    const perSide = TERRAIN_SEGMENTS;
    const count = perSide * 4;
    /** Ring vertices, one per cell per side, anticlockwise in local x/z. */
    const ring = (h: number): { x: number; z: number }[] => {
      const out: { x: number; z: number }[] = [];
      for (let s = 0; s < 4; s++) {
        for (let k = 0; k < perSide; k++) {
          const t = -h + (2 * h * k) / perSide;
          if (s === 0) out.push({ x: t, z: -h });
          else if (s === 1) out.push({ x: h, z: t });
          else if (s === 2) out.push({ x: -t, z: h });
          else out.push({ x: -h, z: -t });
        }
      }
      return out;
    };
    const inner = ring(half);
    // The rim's own heights, and the level the land outside continues at.
    let sum = 0;
    const rimHeight = inner.map((p) => {
      const value = sampleGrid(grid, p.x, -p.z);
      sum += value;
      return value;
    });
    const mean = sum / count;
    const levels = [null, FRAME_STEP_OUT, FRAME_STEP_OUT * 2, FRAME_FAR];
    const rings = [inner, ring(half + levels[1]!), ring(half + levels[2]!), ring(half + levels[3]!)];
    const heightOf = (r: number, k: number): number => {
      if (r === 0) return rimHeight[k] as number;
      if (r === 1) return mean;
      if (r === 2) return (mean + DISTANT_LEVEL) / 2;
      return DISTANT_LEVEL;
    };
    const positions: number[] = [];
    /** Wound so the face points UP, measured rather than assumed. */
    const pushQuad = (a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): void => {
      const area = (p: readonly number[], q: readonly number[], r: readonly number[]): number =>
        (q[0]! - p[0]!) * (r[2]! - p[2]!) - (r[0]! - p[0]!) * (q[2]! - p[2]!);
      const forward = area(a, b, c) < 0;
      if (forward) positions.push(...a, ...b, ...c, ...a, ...c, ...d);
      else positions.push(...a, ...d, ...c, ...a, ...c, ...b);
    };
    const at = (r: number, k: number): number[] => {
      const point = rings[r]![k % count] as { x: number; z: number };
      return [point.x, heightOf(r, k % count), point.z];
    };
    for (let r = 0; r + 1 < rings.length; r++) {
      for (let k = 0; k < count; k++) pushQuad(at(r, k), at(r, k + 1), at(r + 1, k + 1), at(r + 1, k));
    }
    const next = new BufferGeometry();
    next.setAttribute('position', new Float32BufferAttribute(positions, 3));
    // Lit as level ground, every face alike: its faces are long thin slivers
    // from the rim outwards, and each lit by its own slope they drew dark
    // streaks fanning out from the map.
    const up = new Float32Array(positions.length);
    for (let k = 1; k < up.length; k += 3) up[k] = 1;
    next.setAttribute('normal', new Float32BufferAttribute(up, 3));
    next.computeBoundingSphere();
    const previous = backdrop.geometry;
    backdrop.geometry = next;
    previous.dispose();
    rebuildWalls();
  };

  /**
   * The cut sides, sewn to the same rim: per side one column per plate cell,
   * from the rim's drawn height down past a topsoil band to a flat bottom
   * below the lowest point of the rim. The layers are laid by ABSOLUTE height,
   * so they run level under a hill as real strata do.
   */
  const rebuildWalls = (): void => {
    const h = TERRAIN_HALF;
    const n = TERRAIN_SEGMENTS;
    // Each side from corner to corner, with its outward normal (local x/z).
    const sides: readonly (readonly [number, number, number, number, number, number])[] = [
      [-h, -h, h, -h, 0, -1],
      [h, -h, h, h, 1, 0],
      [h, h, -h, h, 0, 1],
      [-h, h, -h, -h, -1, 0],
    ];
    let lowest = Infinity;
    const tops = sides.map(([x0, z0, x1, z1]) => {
      const row: number[] = [];
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        const y = sampleGrid(grid, x, -z);
        row.push(y);
        lowest = Math.min(lowest, y);
      }
      return row;
    });
    const floor = Math.min(TERRAIN_BASE - SLAB_DEPTH, lowest - 40);
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colours: number[] = [];
    /** Metres under the rim, for the shader's grass lip and topsoil (`wallMaterial`). */
    const below: number[] = [];
    // Row shades: full under the rim (the shader draws the lip), shaded to the bottom.
    const LIP = 1;
    const BODY = 1;
    const BOTTOM = 0.42;
    sides.forEach(([x0, z0, x1, z1, nx, nz], s) => {
      const top = tops[s]!;
      const length = Math.hypot(x1 - x0, z1 - z0);
      const vertex = (k: number, y: number, shade: number): void => {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        positions.push(x, y, z);
        normals.push(nx, 0, nz);
        uvs.push(((s * length + (length * k) / n) / STRATA_SPAN_X), y / STRATA_SPAN_Y);
        colours.push(shade, shade, shade);
        below.push(top[k]! - y);
      };
      for (let k = 0; k < n; k++) {
        const ya = top[k]!;
        const yb = top[k + 1]!;
        const bands: readonly (readonly [number, number, number, number])[] = [
          [ya, yb, LIP, LIP],
          [ya - TOPSOIL, yb - TOPSOIL, BODY, BODY],
          [floor, floor, BOTTOM, BOTTOM],
        ];
        for (let b = 0; b + 1 < bands.length; b++) {
          const [ua, ub, sa] = bands[b]!;
          const [la, lb, sl] = bands[b + 1]!;
          // Wound so the face points OUT, measured rather than assumed:
          // (b - a) x (c - a) for a = upper k, b = lower k, c = upper k+1.
          const ax = x0 + ((x1 - x0) * k) / n;
          const az = z0 + ((z1 - z0) * k) / n;
          const cx = x0 + ((x1 - x0) * (k + 1)) / n;
          const cz = z0 + ((z1 - z0) * (k + 1)) / n;
          // b - a = (0, la - ua, 0); c - a = (cx - ax, ., cz - az).
          const outward = (la - ua) * (cz - az) * nx - (la - ua) * (cx - ax) * nz;
          const quad: [number, number, number][] = [[k, ua, sa], [k, la, sl], [k + 1, ub, sa], [k + 1, lb, sl]];
          const order = outward > 0 ? [0, 1, 2, 2, 1, 3] : [0, 2, 1, 2, 3, 1];
          for (const o of order) vertex(...quad[o]!);
        }
      }
    });
    const next = new BufferGeometry();
    next.setAttribute('position', new Float32BufferAttribute(positions, 3));
    next.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    next.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    next.setAttribute('color', new Float32BufferAttribute(colours, 3));
    next.setAttribute('aBelow', new Float32BufferAttribute(below, 1));
    next.computeBoundingSphere();
    const previous = walls.geometry;
    walls.geometry = next;
    previous.dispose();
  };
  rebuildFrame();

  const position = geometry.getAttribute('position');

  const rewrite = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const i = iy * GRID + ix;
        const x = position.getX(i);
        const worldY = -position.getZ(i);
        const height = naturalHeightAt(x, worldY);
        position.setY(i, height);
        grid[i] = height;
        natural[i] = height;
      }
    }
  };

  /**
   * Pulls the ground towards the roads, and carries the difference away over a
   * batter wide enough to read as an embankment rather than as a wall.
   *
   * This is the answer to the oldest complaint about this renderer: a road laid
   * across rolling ground has to sit at ONE height across its full width, so
   * where the ground falls away there is a difference to absorb. Absorbing it in
   * the road's own skirt draws a vertical face — the "wall" — and absorbing it
   * nowhere leaves the road hanging. Absorbing it in the TERRAIN is what a road
   * actually does to a landscape, and it is the only version that looks built.
   *
   * It is also, with no extra code, how tunnels work: `shapeAt` fades its own
   * weight out where the road is buried deeply, so the ground closes over the
   * bore and stays open at the portals.
   */
  /** Corners visited by the current shaping pass, by stamp, so boxes that overlap visit each once. */
  const visited = new Int32Array(GRID * GRID);
  let pass = 0;

  /** The corners the last shaping pass moved (`touchesWater`). */
  let lastChanged: readonly number[] = [];
  const shapeToRoads = (shape: TerrainShaper | null, region: TerrainRegion | readonly TerrainRegion[] | null = null): boolean => {
    const regions: readonly TerrainRegion[] | null = region === null ? null
      : typeof region[0] === 'number' ? [region as TerrainRegion] : region as readonly TerrainRegion[];
    // The corners whose height this pass changes, whichever way.
    const changed: number[] = [];
    // Restore whatever the last shaping moved, so this is a pure function of
    // the current network rather than an accumulation over every edit. With a
    // region (a brush dab while the stroke is held) only the corners in it
    // are shaped again: every other one keeps its cut and fill. The whole
    // plate was re-shaped on every dab - every road and every building pad of
    // the town, sixty-odd times a stroke.
    const inRegion = (i: number): boolean => {
      if (!regions) return true;
      const ix = i % GRID, iy = (i - ix) / GRID;
      return regions.some((r) => ix >= r[0] && ix <= r[1] && iy >= r[2] && iy <= r[3]);
    };
    const before = new Map<number, number>();
    const kept: number[] = [];
    for (const i of shapedCorners) {
      if (!inRegion(i)) { kept.push(i); continue; }
      before.set(i, grid[i] as number);
      grid[i] = natural[i] as number;
    }
    shapedCorners = kept;
    const fresh: number[] = [];

    if (shape) {
      // Only the corners some road could shape: everywhere else `shapeAt`
      // answers weight 0, and asking all 90 601 of them was most of the pass.
      pass++;
      for (const box of shape.shapeBounds()) {
        const bx0 = Math.max(0, Math.floor((box.minX + TERRAIN_HALF) / TERRAIN_CELL));
        const bx1 = Math.min(GRID - 1, Math.ceil((box.maxX + TERRAIN_HALF) / TERRAIN_CELL));
        const by0 = Math.max(0, Math.floor((TERRAIN_HALF - box.maxY) / TERRAIN_CELL));
        const by1 = Math.min(GRID - 1, Math.ceil((TERRAIN_HALF - box.minY) / TERRAIN_CELL));
        for (const r of regions ?? [null]) {
          const x0 = r ? Math.max(bx0, r[0]) : bx0, x1 = r ? Math.min(bx1, r[1]) : bx1;
          const y0 = r ? Math.max(by0, r[2]) : by0, y1 = r ? Math.min(by1, r[3]) : by1;
          for (let iy = y0; iy <= y1; iy++) {
            for (let ix = x0; ix <= x1; ix++) {
              const i = ix + iy * GRID;
              if (visited[i] === pass) continue;
              visited[i] = pass;
              const x = position.getX(i);
              const worldY = -position.getZ(i);
              const ground = natural[i] as number;
              const { height, weight } = shape.shapeAt(x, worldY, ground);
              if (weight <= 0.001) continue;
              const blended = ground + (height - ground) * weight;
              if (Math.abs(blended - ground) < 0.002) continue;
              grid[i] = blended;
              shapedCorners.push(i);
              fresh.push(i);
            }
          }
        }
      }
    }

    for (const i of fresh) {
      const was = before.get(i) ?? (natural[i] as number);
      if (grid[i] !== was) changed.push(i);
      before.delete(i);
    }
    for (const [i, was] of before) if (grid[i] !== was) changed.push(i);
    if (changed.length === 0) return false;
    for (const i of changed) position.setY(i, grid[i] as number);
    position.needsUpdate = true;
    refreshNormals(changed);
    geometry.computeBoundingSphere();
    for (const i of changed) if (onRim(i)) { rebuildFrame(); break; }
    lastChanged = changed;
    return true;
  };

  /** Whether a grid corner is on the plate's rim, which the backdrop is sewn to. */
  const onRim = (i: number): boolean => {
    const ix = i % GRID;
    const iy = (i - ix) / GRID;
    return ix === 0 || iy === 0 || ix === GRID - 1 || iy === GRID - 1;
  };

  const normal = geometry.getAttribute('normal');
  const pa = new Vector3();
  const pb = new Vector3();
  const pc = new Vector3();
  const cb = new Vector3();
  const ab = new Vector3();
  const sum = new Vector3();
  /** Adds one face's area-weighted normal, as `computeVertexNormals` forms it. */
  const addFace = (a: number, b: number, c: number): void => {
    pa.fromBufferAttribute(position, a);
    pb.fromBufferAttribute(position, b);
    pc.fromBufferAttribute(position, c);
    cb.subVectors(pc, pb);
    ab.subVectors(pa, pb);
    sum.add(cb.cross(ab));
  };
  /**
   * Recomputes the normals round the corners that moved: the corners
   * themselves and every corner sharing a face with one, which is all a moved
   * corner can tilt. The whole plate's `computeVertexNormals` was the other
   * large share of every road edit.
   */
  const refreshNormals = (moved: readonly number[]): void => {
    const touched = new Set<number>();
    for (const i of moved) {
      const ix = i % GRID;
      const iy = (i - ix) / GRID;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = ix + dx;
          const y = iy + dy;
          if (x >= 0 && y >= 0 && x < GRID && y < GRID) touched.add(x + y * GRID);
        }
      }
    }
    for (const v of touched) {
      sum.set(0, 0, 0);
      const ix = v % GRID;
      const iy = (v - ix) / GRID;
      // The cells round the corner, split as `PlaneGeometry` splits them:
      // (a, b, d) and (b, c, d).
      for (let cy = iy - 1; cy <= iy; cy++) {
        for (let cx = ix - 1; cx <= ix; cx++) {
          if (cx < 0 || cy < 0 || cx >= TERRAIN_SEGMENTS || cy >= TERRAIN_SEGMENTS) continue;
          const a = cx + GRID * cy;
          const b = cx + GRID * (cy + 1);
          const c = cx + 1 + GRID * (cy + 1);
          const d = cx + 1 + GRID * cy;
          if (v === a || v === b || v === d) addFace(a, b, d);
          if (v === b || v === c || v === d) addFace(b, c, d);
        }
      }
      sum.normalize();
      normal.setXYZ(v, sum.x, sum.y, sum.z);
    }
    normal.needsUpdate = true;
  };

  let wetDiscs: readonly WaterStamp[] = [];
  /** Where the water's mesh lies, world units (`touchesWater`). */
  let waterBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  /** The cells water flooded into past the brush (`floodBasins`), with their level. */
  let floodCells = new Map<string, number>();
  const wetAt = (x: number, y: number): boolean => {
    if (floodCells.size) {
      const level = floodCells.get(`${Math.round(x / WATER_CELL)}:${Math.round(y / WATER_CELL)}`);
      if (level !== undefined && renderedHeightAt(x, y) < level + 0.6) return true;
    }
    for (const disc of wetDiscs) {
      const reach = disc.radius * WATER_SPREAD;
      if (Math.abs(x - disc.x) > reach || Math.abs(y - disc.y) > reach) continue;
      if (Math.hypot(x - disc.x, y - disc.y) > reach) continue;
      // A margin, so nothing stands with its root on the waterline.
      if (renderedHeightAt(x, y) < disc.level + 0.6) return true;
    }
    return false;
  };

  const rebuildWater = (stamps: readonly TerrainStamp[]): void => {
    // A river stands at the level its channel was cut INTO, below the banks: at
    // a fixed world datum it vanished under raised ground, and level with the
    // banks it covered the whole valley as one flat sheet.
    const land = stamps.filter((stamp) => stamp.mode !== 'river');
    const landIndex = new TerrainIndex(land, 0);
    const landAt = (x: number, y: number): number => TERRAIN_BASE + sampleTerrainHeight(landIndex, x, y);

    const discs: WaterStamp[] = [];
    for (const stamp of stamps) {
      if (stamp.mode !== 'river' || discs.length >= MAX_TERRAIN_STAMPS) continue;
      const bank = landAt(stamp.x, stamp.y);
      const bed = heightAt(stamp.x, stamp.y);
      const level = bank - Math.max(WATER_MARGIN, WATER_FILL * (bank - bed));
      if (bed + TERRAIN_WATER_HEIGHT >= level) continue;
      discs.push({ x: stamp.x, y: stamp.y, radius: stamp.radius * WATER_RADIUS, level });
    }
    wetDiscs = discs;
    (groundTexture.image.data as Float32Array).set(grid);
    groundTexture.needsUpdate = true;
    const previous = water.geometry;
    floodCells = new Map();
    water.geometry = unifiedWaterGeometry(discs, renderedHeightAt, floodCells);
    previous.dispose();
    shoreLevels(water.geometry, material.userData['shore'] as DataTexture);
    water.geometry.computeBoundingBox();
    const box = water.geometry.boundingBox;
    // In world (x, y): the mesh is three's (x, height, -y).
    waterBox = box && !box.isEmpty() ? { minX: box.min.x, maxX: box.max.x, minY: -box.max.z, maxY: -box.min.z } : null;
  };
  /** How near the water a moved corner can be and still leave it as it was: two water cells and two terrain cells. */
  const WATER_REACH = 2 * WATER_CELL + 2 * TERRAIN_CELL;
  /**
   * Whether the last shaping moved ground under or beside the water. A road
   * edit re-cut the ground under that road only, but rebuilt the whole water
   * mesh every time (about 90 ms on a town with a river); away from the water
   * the mesh is the same, as the rivers' levels read the unshaped land.
   */
  const touchesWater = (): boolean => {
    if (!waterBox) return wetDiscs.length > 0;
    for (const i of lastChanged) {
      const ix = i % GRID, iy = (i - ix) / GRID;
      const x = ix * TERRAIN_CELL - TERRAIN_HALF, y = TERRAIN_HALF - iy * TERRAIN_CELL;
      if (x >= waterBox.minX - WATER_REACH && x <= waterBox.maxX + WATER_REACH
        && y >= waterBox.minY - WATER_REACH && y <= waterBox.maxY + WATER_REACH) return true;
    }
    return false;
  };

  const vergeMaterial = material.clone();
  vergeMaterial.onBeforeCompile = (shader, renderer) => {
    material.onBeforeCompile(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      'float slopeDeg = degrees(acos(clamp(vTerrainNormal.y, 0.0, 1.0)));',
      'float slopeDeg = 0.0;',
    );
  };
  vergeMaterial.customProgramCacheKey = () => 'terrain-splat-v3-verge';

  const paint = material.userData['paint'] as DataTexture[];
  let paintRevision = 0;
  let paintCount = 0;
  let paintFirst: PaintDab | undefined;
  const forest = new Uint8Array(FOREST_RES * FOREST_RES);
  let forestRevision = 0;
  const updatePaint = (doc: RoadDoc): void => {
    if (doc.paintRevision === paintRevision) return;
    paintRevision = doc.paintRevision;
    const dabs = doc.terrainPaint;
    // Dabs only added since the last time: lay just those. Anything else (an
    // undo, a load, the oldest dabs dropped): lay them all again.
    if (dabs.length >= paintCount && dabs[0] === paintFirst && paintCount > 0) {
      for (let i = paintCount; i < dabs.length; i++) for (const t of [dabs[i]!]) { rasterPaint(paint, t); rasterForest(forest, t); }
    } else {
      for (const t of paint) (t.image.data as Uint8Array).fill(0);
      forest.fill(0);
      for (const dab of dabs) { rasterPaint(paint, dab); rasterForest(forest, dab); }
    }
    forestRevision++;
    paintCount = dabs.length;
    paintFirst = dabs[0];
    for (const t of paint) t.needsUpdate = true;
  };

  return {
    meshes: [backdrop, walls, ground, water],
    ground,
    vergeMaterial,
    updatePaint,
    forestAt(x, y) {
      const cell = TERRAIN_SIZE / FOREST_RES;
      const gx = Math.floor((x + TERRAIN_HALF) / cell), gy = Math.floor((y + TERRAIN_HALF) / cell);
      if (gx < 0 || gy < 0 || gx >= FOREST_RES || gy >= FOREST_RES) return 0;
      return forest[gy * FOREST_RES + gx]! / 255;
    },
    get forestRevision() {
      return forestRevision;
    },
    heightAt,
    naturalRenderedHeightAt,
    renderedHeightAt,
    wetAt,
    digest(minX, minY, maxX, maxY) {
      const digest = new Digest();
      if (minX < -TERRAIN_HALF || maxX > TERRAIN_HALF || minY < -TERRAIN_HALF || maxY > TERRAIN_HALF) {
        digest.add(revision);
      }
      // Rows run from +y downwards (see `sampleGrid`).
      const clampCorner = (value: number): number => Math.min(GRID - 1, Math.max(0, value));
      const x0 = clampCorner(Math.floor((minX + TERRAIN_HALF) / TERRAIN_CELL));
      const x1 = clampCorner(Math.floor((maxX + TERRAIN_HALF) / TERRAIN_CELL) + 1);
      const y0 = clampCorner(Math.floor((TERRAIN_HALF - maxY) / TERRAIN_CELL));
      const y1 = clampCorner(Math.floor((TERRAIN_HALF - minY) / TERRAIN_CELL) + 1);
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) digest.add(natural[ix + iy * GRID] as number).add(grid[ix + iy * GRID] as number);
      }
      return digest.value();
    },
    get lastRegion() { return lastRegion; },
    settle() {
      if (!waterStale) return;
      waterStale = false;
      rebuildWater(lastStamps);
    },
    shapeToRoads(shape, region = null) {
      const shapeAt = performance.now();
      const moved = shapeToRoads(shape, region);
      performance.measure('hitch:road-edit/ground shape', { start: shapeAt, end: performance.now() });
      // A road that cut through a valley changes where the water's shore is:
      // at once, or once the stroke is over when one is held (`settle`).
      if (moved && touchesWater()) {
        if (region) waterStale = true;
        else { waterStale = false; rebuildWater(lastStamps); }
      }
      return moved;
    },
    update(doc, stroking = false) {
      if (revision === doc.terrainRevision) return false;
      const firstBuild = revision < 0;
      const previous = index;
      revision = doc.terrainRevision;
      index = new TerrainIndex(doc.terrainStamps, revision);

      // Only the cells a new stamp reaches are rewritten. A brush stroke adds
      // one 80-unit stamp; rewriting all 90 601 corners for it is what made
      // painting terrain drop frames on a large map.
      const added = doc.terrainStamps.length === previous.stamps.length + 1
        ? doc.terrainStamps[doc.terrainStamps.length - 1]
        : undefined;
      const sameHistory =
        added !== undefined &&
        previous.stamps.length > 0 &&
        previous.stamps[0] === doc.terrainStamps[0];

      let box: readonly [number, number, number, number] | null = null;
      if (firstBuild || !added || !sameHistory) {
        rewrite(0, GRID - 1, 0, GRID - 1);
        lastRegion = null;
      } else {
        const reach = added.radius + TERRAIN_CELL;
        const cx0 = Math.max(0, Math.floor((added.x - reach + TERRAIN_HALF) / TERRAIN_CELL));
        const cx1 = Math.min(GRID - 1, Math.ceil((added.x + reach + TERRAIN_HALF) / TERRAIN_CELL));
        const cy0 = Math.max(0, Math.floor((TERRAIN_HALF - (added.y + reach)) / TERRAIN_CELL));
        const cy1 = Math.min(GRID - 1, Math.ceil((TERRAIN_HALF - (added.y - reach)) / TERRAIN_CELL));
        // A `flatten` stamp scales everything under it, so it can move ground
        // the disc does not cover if an earlier stamp reached further; the box
        // above is still the only place its influence is non-zero.
        rewrite(cx0, cx1, cy0, cy1);
        box = [cx0, cx1, cy0, cy1];
        lastRegion = box;
      }

      position.needsUpdate = true;
      let rimMoved = !box;
      if (box) {
        // Only the corners the dab rewrote can have tilted, with their ring of
        // neighbours; the whole plate's normals were a third of a dab.
        const moved: number[] = [];
        for (let iy = box[2]; iy <= box[3]; iy++) {
          for (let ix = box[0]; ix <= box[1]; ix++) moved.push(iy * GRID + ix);
        }
        refreshNormals(moved);
        rimMoved = moved.some(onRim);
      } else {
        geometry.computeVertexNormals();
      }
      // The backdrop is sewn to the rim (see `rebuildFrame`): a dab that moved
      // an edge corner re-sews it, and one in the middle of the plate does not.
      if (rimMoved) rebuildFrame();
      geometry.computeBoundingSphere();
      lastStamps = doc.terrainStamps;
      // The water - every pool and river on the map - is the deferred part of
      // a stroke (Unity's SetHeightsDelayLOD then SyncHeightmap on release):
      // rebuilt on every dab, it was the largest single cost of painting.
      if (stroking) waterStale = true;
      else { waterStale = false; rebuildWater(lastStamps); }
      return true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      backdrop.geometry.dispose();
      (backdrop.material as MeshStandardMaterial).dispose();
      walls.geometry.dispose();
      (walls.material as MeshStandardMaterial).map?.dispose();
      (walls.material as MeshStandardMaterial).dispose();
      water.geometry.dispose();
      waterSurface.dispose();
      groundTexture.dispose();
    },
  };
}

export interface WaterStamp {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly level: number;
}

interface WaterVertex {
  readonly ix: number;
  readonly iy: number;
  weightedLevel: number;
  weight: number;
}

type WaterKey = number | string;
const WATER_KEY_STRIDE = 65_536;
const WATER_KEY_OFFSET = 32_768;

/** Exact numeric cell IDs on the playable map; a string preserves arbitrary out-of-map coordinates. */
function waterKey(ix: number, iy: number): WaterKey {
  return ix >= -WATER_KEY_OFFSET && ix < WATER_KEY_OFFSET && iy >= -WATER_KEY_OFFSET && iy < WATER_KEY_OFFSET
    ? (ix + WATER_KEY_OFFSET) * WATER_KEY_STRIDE + iy + WATER_KEY_OFFSET
    : `${ix}:${iy}`;
}

function waterCell(key: WaterKey): readonly [number, number] {
  if (typeof key === 'number') {
    const x = Math.floor(key / WATER_KEY_STRIDE);
    return [x - WATER_KEY_OFFSET, key - x * WATER_KEY_STRIDE - WATER_KEY_OFFSET];
  }
  const [x, y] = key.split(':');
  return [Number(x), Number(y)];
}

/** Most cells one body of water may spread over into a basin: about 400 m square. */
const MAX_FLOOD_CELLS = 40_000;

/**
 * Water runs into the hollow beside it and fills it to its own level.
 *
 * The surface used to stop where the brush's reach stopped. A river led into
 * a pit stood at its own level out over the pit and simply ended there in the
 * air, a sheet with a sawtooth edge hanging over the hole. Each body of water
 * (the stamps' vertices, taken a connected group at a time) now floods out,
 * cell by cell, into every neighbouring cell whose ground is below its level -
 * the flood fill depression-filling algorithms are built on (Barnes, Lehman &
 * Mulla, "Priority-Flood", 2014) - so the pit becomes a lake whose edge is its
 * shore. A flood that runs on past `MAX_FLOOD_CELLS` is not a basin but open
 * low country the water would drain into; it is withdrawn and that water keeps
 * the extent the brush gave it.
 */
function floodBasins(
  vertices: Map<WaterKey, WaterVertex>,
  groundAt: (x: number, y: number) => number,
  flooded?: Map<string, number>,
): void {
  const seen = new Set<WaterKey>();
  const seeds = [...vertices.values()];
  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (const seed of seeds) {
    const seedKey = waterKey(seed.ix, seed.iy);
    if (seen.has(seedKey)) continue;
    // The body of water this stamp vertex belongs to.
    const body: WaterVertex[] = [];
    const stack = [seed];
    seen.add(seedKey);
    while (stack.length) {
      const v = stack.pop() as WaterVertex;
      body.push(v);
      for (const [dx, dy] of NEIGHBOURS) {
        const key = waterKey(v.ix + dx, v.iy + dy);
        const next = vertices.get(key);
        if (next && !seen.has(key)) { seen.add(key); stack.push(next); }
      }
    }
    // Its flood, breadth first from its whole edge, each new cell at the level
    // of the water that reached it.
    const added: WaterKey[] = [];
    const queue = body.slice();
    let overflow = false;
    for (let head = 0; head < queue.length && !overflow; head++) {
      const v = queue[head] as WaterVertex;
      const level = v.weightedLevel / v.weight;
      for (const [dx, dy] of NEIGHBOURS) {
        const ix = v.ix + dx;
        const iy = v.iy + dy;
        const key = waterKey(ix, iy);
        if (vertices.has(key)) continue;
        if (groundAt(ix * WATER_CELL, iy * WATER_CELL) >= level - TERRAIN_WATER_HEIGHT) continue;
        const wet: WaterVertex = { ix, iy, weightedLevel: level, weight: 1 };
        vertices.set(key, wet);
        seen.add(key);
        added.push(key);
        queue.push(wet);
        if (added.length > MAX_FLOOD_CELLS) { overflow = true; break; }
      }
    }
    if (overflow) for (const key of added) vertices.delete(key);
    else if (flooded) for (const key of added) {
      const v = vertices.get(key) as WaterVertex;
      flooded.set(`${v.ix}:${v.iy}`, v.weightedLevel / v.weight);
    }
  }
}

/**
 * One triangulated surface for every overlapping river stamp.
 *
 * Drawing one translucent disc per brush sample stacked forty alpha layers into
 * the pale cloud saved maps showed. Accumulating them on a shared grid performs
 * the union before rendering: overlap changes the local level, never the
 * opacity. The level each vertex carries is the weighted average of the stamps
 * reaching it, so the surface runs DOWN the channel's own profile instead of
 * standing at one height along a river that drops seventeen units across a map.
 *
 * Every vertex also carries its DEPTH — its own level minus the ground under it
 * — which is the one number the shader needs to tell a bank from a channel. It
 * is free here and impossible there: only this builder holds the terrain
 * sampler. See `water.ts` for what is made of it.
 */
export function unifiedWaterGeometry(
  stamps: readonly WaterStamp[],
  terrainHeightAt: (x: number, y: number) => number,
  /** Filled with the cells the water flooded into, and their level. */
  flooded?: Map<string, number>,
): BufferGeometry {
  const geometry = new BufferGeometry();
  if (stamps.length === 0) return geometry;

  const vertices = new Map<WaterKey, WaterVertex>();
  for (const stamp of stamps) {
    const reach = stamp.radius * WATER_SPREAD;
    const minX = Math.floor((stamp.x - reach) / WATER_CELL);
    const maxX = Math.ceil((stamp.x + reach) / WATER_CELL);
    const minY = Math.floor((stamp.y - reach) / WATER_CELL);
    const maxY = Math.ceil((stamp.y + reach) / WATER_CELL);
    for (let ix = minX; ix <= maxX; ix++) {
      const x = ix * WATER_CELL;
      for (let iy = minY; iy <= maxY; iy++) {
        const y = iy * WATER_CELL;
        const distance = Math.hypot(x - stamp.x, y - stamp.y);
        if (distance >= reach) continue;
        const weight =
          distance < stamp.radius
            ? Math.max(0.001, terrainInfluence(1 - distance / stamp.radius))
            : 0.001;
        const key = waterKey(ix, iy);
        const vertex = vertices.get(key);
        if (vertex) {
          vertex.weightedLevel += stamp.level * weight;
          vertex.weight += weight;
        } else {
          vertices.set(key, { ix, iy, weightedLevel: stamp.level * weight, weight });
        }
      }
    }
  }

  floodBasins(vertices, terrainHeightAt, flooded);

  const levelAt = (ix: number, iy: number): number | null => {
    const vertex = vertices.get(waterKey(ix, iy));
    return vertex ? vertex.weightedLevel / vertex.weight : null;
  };
  const positions: number[] = [];
  const depths: number[] = [];
  const cells = new Set<WaterKey>();
  // The contour builders consume these immediately; reuse them across cells
  // instead of allocating five points and three arrays for every quad.
  const points: WaterPoint[] = Array.from({ length: 4 }, () => ({ x: 0, y: 0, level: 0, depth: 0 }));
  const centre: WaterPoint = { x: 0, y: 0, level: 0, depth: 0 };
  for (const vertex of vertices.values()) {
    cells.add(waterKey(vertex.ix, vertex.iy));
    cells.add(waterKey(vertex.ix - 1, vertex.iy));
    cells.add(waterKey(vertex.ix, vertex.iy - 1));
    cells.add(waterKey(vertex.ix - 1, vertex.iy - 1));
  }

  for (const cell of cells) {
    const [ix, iy] = waterCell(cell);
    const k0 = levelAt(ix, iy), k1 = levelAt(ix + 1, iy);
    const k2 = levelAt(ix + 1, iy + 1), k3 = levelAt(ix, iy + 1);
    // A flooded basin carries a level only at its WET corners (`floodBasins`),
    // so every cell on a lake's shore had a corner with none, and dropping
    // those cells cut the lake's outline into a staircase of whole cells. The
    // missing corners take the water's level instead: they stand above it, so
    // the clip against the ground below draws the shore where it really is.
    let known = 0, sum = 0;
    for (const level of [k0, k1, k2, k3]) if (level !== null) { known++; sum += level; }
    if (known === 0) continue;
    const fill = sum / known;
    const l0 = k0 ?? fill, l1 = k1 ?? fill, l2 = k2 ?? fill, l3 = k3 ?? fill;
    const wx = ix * WATER_CELL, wy = iy * WATER_CELL;
    const p0 = points[0]!, p1 = points[1]!, p2 = points[2]!, p3 = points[3]!;
    p0.x = wx; p0.y = wy; p0.level = l0; p0.depth = l0 - terrainHeightAt(wx, wy);
    p1.x = wx + WATER_CELL; p1.y = wy; p1.level = l1; p1.depth = l1 - terrainHeightAt(p1.x, p1.y);
    p2.x = wx + WATER_CELL; p2.y = wy + WATER_CELL; p2.level = l2; p2.depth = l2 - terrainHeightAt(p2.x, p2.y);
    p3.x = wx; p3.y = wy + WATER_CELL; p3.level = l3; p3.depth = l3 - terrainHeightAt(p3.x, p3.y);
    centre.x = wx + WATER_CELL / 2;
    centre.y = wy + WATER_CELL / 2;
    centre.level = (l0 + l1 + l2 + l3) / 4;
    centre.depth = centre.level - terrainHeightAt(centre.x, centre.y);
    const wetCorners = Number(p0.depth > TERRAIN_WATER_HEIGHT) + Number(p1.depth > TERRAIN_WATER_HEIGHT) +
      Number(p2.depth > TERRAIN_WATER_HEIGHT) + Number(p3.depth > TERRAIN_WATER_HEIGHT);
    if (wetCorners === 0 && centre.depth <= TERRAIN_WATER_HEIGHT) continue;
    // Wound anticlockwise seen from above, so the surface is a FRONT face. The
    // old winding pointed every face at the ground and needed `DoubleSide` and a
    // back-face normal flip to be lit at all — which also meant the water was
    // rasterised twice.
    if (wetCorners === 4 && centre.depth > TERRAIN_WATER_HEIGHT) {
      pushTriangle(positions, depths, points[0]!, points[1]!, points[2]!);
      pushTriangle(positions, depths, points[0]!, points[2]!, points[3]!);
    } else {
      // Only the shore cells need a contour. Their wet triangles are clipped
      // against the actual ground, so the edge follows the bank between grid
      // corners instead of jumping one whole square at a time.
      for (let i = 0; i < 4; i++) {
        pushWetTriangle(positions, depths, points[i]!, points[(i + 1) % 4]!, centre, terrainHeightAt);
      }
    }
  }

  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute(WATER_DEPTH_ATTRIBUTE, new Float32BufferAttribute(depths, 1));
  const uvs: number[] = [];
  // Flat UP, not the face normals `computeVertexNormals` would give. The level
  // field steps by a fraction of a unit per cell, and on a surface this
  // reflective those steps show as a quilt of four-unit facets in the Fresnel
  // term and in the sun's glint. The ripple the eye reads comes from the normal
  // map, so the geometry's own normal should be the plane's.
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    uvs.push((positions[i] as number) / 40, (positions[i + 2] as number) / 40);
    normals[i + 1] = 1;
  }
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

interface WaterPoint {
  x: number;
  y: number;
  level: number;
  depth: number;
}

function pushTriangle(
  out: number[],
  depths: number[],
  a: WaterPoint,
  b: WaterPoint,
  c: WaterPoint,
): void {
  out.push(a.x, a.level, -a.y, b.x, b.level, -b.y, c.x, c.level, -c.y);
  depths.push(a.depth, b.depth, c.depth);
}

function pushWetTriangle(
  positions: number[], depths: number[], a: WaterPoint, b: WaterPoint, c: WaterPoint,
  groundAt: (x: number, y: number) => number,
): void {
  const corners = [a, b, c];
  const polygon: WaterPoint[] = [];
  for (let i = 0; i < 3; i++) {
    const from = corners[i]!;
    const to = corners[(i + 1) % 3]!;
    const fromWet = from.depth > TERRAIN_WATER_HEIGHT;
    const toWet = to.depth > TERRAIN_WATER_HEIGHT;
    if (fromWet) polygon.push(from);
    if (fromWet === toWet) continue;
    let wet = fromWet ? from : to;
    let dry = fromWet ? to : from;
    // Resolve against the ground sampler itself. A linear depth estimate can
    // place the vertex in air where the terrain bends or has a step.
    for (let step = 0; step < 8; step++) {
      const x = (wet.x + dry.x) / 2;
      const y = (wet.y + dry.y) / 2;
      const level = (wet.level + dry.level) / 2;
      const middle = { x, y, level, depth: level - groundAt(x, y) };
      if (middle.depth > TERRAIN_WATER_HEIGHT) wet = middle;
      else dry = middle;
    }
    polygon.push(wet);
  }
  for (let i = 1; i + 1 < polygon.length; i++) {
    const a = polygon[0]!, b = polygon[i]!, c = polygon[i + 1]!;
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 1e-9) {
      pushTriangle(positions, depths, a, b, c);
    }
  }
}
