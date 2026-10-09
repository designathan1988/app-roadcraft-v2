import { Color, Group, type Material, type Mesh } from 'three';

import { difference, intersection, union, type MultiPoly, type Poly } from '@core/clipper';
import { Digest } from '@core/digest';
import { offsetPolyline } from '@core/offset';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { CASING_BAND, FOOTWAY_RISE, Level, ROAD_TYPES, type SurfaceLevel } from '@world/roadTypes';
import { levelPolygons, levelRings } from '@world/surfaces';
import { curbRamps, rampOutline, walkingRise } from '@world/curbRamps';
import { Polyline } from '@core/polyline';
import {
  ROAD_STRUCTURES,
  isRaised,
  roadStructure,
  type RoadStructure,
} from '@world/structures';
import type { RoadElevation } from '@world/elevation';
import { m } from '@world/units';
import { PAINT_RISE, markingQuads, paintMaterial } from './markings';
import type { SceneMaterials } from './materials';
import { TERRAIN_CELL } from './terrain';
import {
  clipToRect,
  disposeMesh,
  mergeTiles,
  meshTile,
  type HeightFn,
  type SurfaceMeshOptions,
  type Tile,
  type TileRect,
  type TintFn,
  type UvFn,
  type UvFrameFn,
} from './mesh/surfaceMesh';

/**
 * The road network's surface bands, per structural level.
 *
 * ## Cross-section
 *
 * Every band sits at a fixed offset from ONE shared deck height, and each one
 * draws a skirt down to the band outside it. That is what turns four flat
 * ribbons into a built cross-section:
 *
 * ```
 *                 kerb +0.16 m   footway +0.15 m
 *   asphalt 0.00 ──┐┌──────────────────────────┐
 *   (gutter at the │┘ kerb face                 ╲  verge: a grass batter from
 *    kerb, painted)                               ╲ the footway down (or up) to
 *                                                  ╲ the ground as it is drawn
 * ```
 *
 * Small, real steps: a 15 cm precast kerb, the footway level with its top, the
 * gutter at the carriageway's own level. The verge used to be a flat band
 * 4 cm under the asphalt with a vertical skirt down to ground pulled 60 cm
 * below the road - a grass wall that made every road read as a thick slab laid
 * on the terrain. It now slopes from the footway's edge to the drawn terrain,
 * so nothing stands proud and no side of the mesh shows.
 *
 * Because every offset is measured from the same `RoadElevation`, two bands can
 * never disagree about where the road is — the defect that left steps and gaps
 * between the carriageway and its kerb.
 *
 * ## Per-class colour, in one mesh
 *
 * A residential street is grey and a boulevard is near-black, but they share a
 * junction and therefore a polygon. The class tint is written per VERTEX from
 * the nearest road, so one asphalt mesh carries every class and the colour
 * blends where two classes meet instead of stopping at an invented seam.
 */

/**
 * Height of the kerb face above the carriageway.
 *
 * A hair ABOVE the footway rather than a hair below it. At 0.34 the kerb sat
 * 0.02 under the footway and read as part of it: nothing on screen said where
 * the kerb was. Standing 0.04 proud, its inner arris catches the light and
 * throws a line of shade, and the granite kerb reads as a separate edge.
 */
const KERB_RISE = FOOTWAY_RISE + m(0.01);
/** Depth of the verge below the carriageway, where the grass starts. */
const VERGE_DROP = 0.1;
/**
 * Drop of the verge skirt into the ground.
 *
 * Small, because the ground is now shaped to meet the road (`shapeAt` in
 * `world/elevation.ts`): the embankment is real terrain with a forty-five unit
 * batter, not a vertical face hung off the edge of the surface. This is only
 * the seal that stops a hairline of sky showing under the rim.
 */
const VERGE_SKIRT = 0.5;
/**
 * The verge meets the drawn terrain this far BELOW it: the lawn closes over
 * the batter's outer edge, so no rim of the batter (and no dark line of its
 * skirt) shows where the two meet. Both wear the terrain's material.
 */
const VERGE_LIFT = -m(0.08);
/** World size of one UV unit on the ground verge when it wears the terrain's material. */
const TERRAIN_UV = 64;

/**
 * Longest triangle edge on a road at grade.
 *
 * This is NOT sized against the terrain's curvature. The deck reads a solved
 * profile whose every station has already been raised to clear the ground
 * within a window wider than this edge (`DILATE` in `world/elevation.ts`), so a
 * chord this long is guaranteed above the ground at both ends and everywhere
 * between them. The tessellation only has to be fine enough to SHADE well.
 */
const GROUND_MAX_EDGE = TERRAIN_CELL / 2;
/** A dropped kerb's triangles: its slope is 1.8 m long, its flares 1.5 m. */
const RAMP_MAX_EDGE = m(0.3);
/** A raised deck follows nothing, so it needs vertices only for its shading. */
const RAISED_MAX_EDGE = TERRAIN_CELL;

/** Height of the median island's kerb above the carriageway. */
const MEDIAN_KERB = 0.4;
/** Height of the planting inside it. */
export const MEDIAN_PLANTING = 0.62;

/**
 * What one build of the surfaces keeps for the next, so an edit rebuilds only
 * the tiles it reaches. Owned by the renderer; a build without it makes
 * everything afresh.
 */
export interface SurfaceReuse {
  /** The tiles of the last build, per structural level. */
  readonly tiles: Map<string, Map<number, TileBundle>>;
  /**
   * A digest of everything the height field and the texture frames read in a
   * rectangle: the solved roads near it and the ground under it, both as
   * shaped and as it naturally lies.
   */
  readonly dependsOn: (minX: number, minY: number, maxX: number, maxY: number) => number;
  /** The paint materials, by colour: made once, not on every rebuild. */
  readonly paint: Map<string, Material>;
  /**
   * The meshes of each block of tiles (`CHUNK` tiles a side), by pass,
   * surface and block, with the tiles they were merged from. A block whose
   * tiles are the same objects keeps its mesh and its buffers on the GPU.
   * Owned by the cache: `disposeSurfaceReuse` frees them.
   */
  readonly chunks?: Map<string, { readonly parts: readonly Tile[]; readonly mesh: Mesh }>;
  /** Block meshes replaced but maybe still drawn: freed by the owner once the new roads are in. */
  readonly retired?: Mesh[];
  /**
   * Tiles kept from an earlier session (`derivedCache.ts`), by `storedKey`:
   * a tile whose key comes round again is taken from here instead of built
   * (Unreal's Derived Data Cache: derived data made once, kept locally, and
   * made again whenever it is missing). Its key is everything the tile is
   * built from, so a kept tile is the tile a build would make.
   */
  readonly stored?: Map<string, TileBundle>;
  /** Each tile built afresh, to be kept for a later session. */
  readonly keep?: (key: string, bundle: TileBundle) => void;
}

/** The name a tile is kept under between sessions: its pass and its digest. */
export const storedKey = (pass: string, digest: number): string => `${pass}|${digest}`;

/** Frees what a `SurfaceReuse` holds on the GPU. */
export function disposeSurfaceReuse(reuse: SurfaceReuse): void {
  for (const { mesh } of reuse.chunks?.values() ?? []) disposeMesh(mesh);
  reuse.chunks?.clear();
  for (const mesh of reuse.retired?.splice(0) ?? []) disposeMesh(mesh);
  for (const material of reuse.paint.values()) material.dispose();
}

/** Every surface of one tile, by mesh name. */
export type TileBundle = ReadonlyMap<string, Tile>;

export interface RoadSurfaces {
  readonly group: Group;
  readonly meshes: readonly Mesh[];
  readonly triangles: number;
  /** Tiles the build made afresh, and copied from the build before. */
  readonly built: number;
  readonly reused: number;
  /** Where the tiles made afresh lie (`world/changes.ts`). */
  readonly rebuilt: readonly TileRect[];
  /** The time the tiles and their blocks took, ms, without the frames between slices. */
  readonly workMs: number;
  dispose(): void;
}

/**
 * World size of one tile.
 *
 * A road edit used to merge, cut and triangulate every band of the whole
 * network: a quarter of a million triangles and every polygon boolean, most of
 * the time a new road took to appear, and more on a bigger map. Everything is
 * now done a tile at a time from the rings that reach the tile, and a tile
 * whose rings and surroundings (`SurfaceReuse.dependsOn`) have not changed is
 * copied from the last build, so an edit pays for the tiles it reaches. A
 * multiple of the ground and deck spans (8 x 6 and 16 x 6), so a tile holds
 * whole pieces.
 */
const TILE = 192;
/**
 * Where the tile grid starts. Off any round number, so no road drawn on a
 * round coordinate has its edge lie along a tile line, where it would be taken
 * for a cut and lose its kerb (`meshTile`).
 */
const TILE_ORIGIN = 0.371;
/** How far round a tile a ring may reach and still be read by it. */
const TILE_REACH = 0.5;
const TILE_BIAS = 1 << 15;
/**
 * Tiles a side of one mesh. Every tile of the network used to be merged into
 * one mesh per surface on every edit and sent to the GPU whole - 50 to 80 MB
 * and a 400-850 ms frame for one short street in the default town
 * (docs/performance.md #9). A block of tiles is merged on its own, and kept
 * while its tiles are.
 */
const CHUNK = 4;

/** One ring of input, with its box and its digest, measured once per build. */
interface Input {
  readonly poly: Poly;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly digest: number;
}

function inputOf(poly: Poly): Input | null {
  const outer = poly[0];
  if (!outer || outer.length < 3) return null;
  const digest = new Digest();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of poly) {
    digest.add(ring.length);
    for (const point of ring) {
      const x = point[0] as number;
      const y = point[1] as number;
      digest.add(x).add(y);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { poly, minX, minY, maxX, maxY, digest: digest.value() };
}

const offset = (base: HeightFn, amount: number): HeightFn => (x, y) => base(x, y) + amount;

/** Linear-space tints per road class, so the asphalt mesh can vary by class. */
const CLASS_TINT: readonly Color[] = ROAD_TYPES.map((type) =>
  new Color(type.color),
);
/** The tint the asphalt material is authored against, so 1.0 means "as baked". */
const TINT_REFERENCE = new Color(0x3a3d3f);

/** What each surface of a tile is made from. */
type Source =
  | { readonly kind: 'band'; readonly band: 'verge' | 'footway' | 'kerb' | 'asphalt' | 'curbRamp' }
  | { readonly kind: 'median'; readonly part: 'kerb' | 'planting' }
  | { readonly kind: 'paint'; readonly color: string };

/** One surface of a structural level: how it is meshed, and from what. */
interface SurfaceSpec {
  readonly source: Source;
  readonly options: Omit<SurfaceMeshOptions, 'polygons'>;
  readonly renderOrder?: number;
}

export function buildRoadSurfaces(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
  reuse?: SurfaceReuse,
  groundMaterial?: Material,
): RoadSurfaces {
  const steps = roadSurfaceSteps(net, elevation, materials, terrainAt, reuse, groundMaterial);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * `buildRoadSurfaces` in steps: it yields after each tile built and each block
 * merged, so the renderer can spread an edit's tiles over frames while the
 * roads as they were stay drawn (`renderer.ts`), as a city builder updates a
 * road's mesh behind the frame (docs/performance.md #10). With
 * `reuse.retired`, the meshes a block replaces are handed there, not freed:
 * the roads still drawn may hold them until the new ones take their place.
 */
export function* roadSurfaceSteps(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
  reuse?: SurfaceReuse,
  groundMaterial?: Material,
): Generator<void, RoadSurfaces, void> {
  const started = performance.now();
  let tilesMs = 0;
  let mergeMs = 0;
  let chunksMerged = 0;
  let chunksKept = 0;
  const chunks = reuse?.chunks;
  const usedChunks = new Set<string>();
  const retire = (mesh: Mesh): void => { if (reuse?.retired) reuse.retired.push(mesh); else disposeMesh(mesh); };
  const group = new Group();
  group.name = 'road-network';
  const meshes: Mesh[] = [];
  let triangles = 0;
  let built = 0;
  let reused = 0;
  const rebuilt: TileRect[] = [];
  // Without a caller to own them, the paint materials belong to this build.
  const paint = reuse?.paint ?? new Map<string, Material>();
  const paintFor = (color: string): Material => {
    let material = paint.get(color);
    if (!material) {
      material = paintMaterial(color);
      paint.set(color, material);
    }
    return material;
  };

  const manual = (id: SegmentId): boolean => {
    const segment = net.doc.segment(id);
    return !!segment && (Math.abs(net.doc.node(segment.a)?.heightOffset ?? 0) > 1e-6 ||
      Math.abs(net.doc.node(segment.b)?.heightOffset ?? 0) > 1e-6);
  };
  // Roads at authored heights are drawn on their own, each from its own
  // deck, and those that run on from one another through a two-way node
  // as ONE surface: drawn a segment at a time, every piece of a road raised in
  // one stroke closed its ends, and the joins showed as lines and notched kerbs.
  const alignments = new Map<SegmentId, SegmentId[]>();
  {
    const owner = new Map<SegmentId, SegmentId>();
    const find = (id: SegmentId): SegmentId => {
      let r = id;
      while (owner.get(r) !== r) r = owner.get(r)!;
      return r;
    };
    const ids = [...net.doc.segments.keys()].filter(manual);
    for (const id of ids) owner.set(id, id);
    for (const node of net.doc.nodes.values()) {
      if (node.incident.length !== 2) continue;
      const [p, q] = node.incident as [SegmentId, SegmentId];
      // Bent or straight: a bend's junction plate belongs to the pass that
      // holds both its legs (`ownsJunction`), so it is drawn in the same surface.
      if (!owner.has(p) || !owner.has(q)) continue;
      const a = find(p), b = find(q);
      if (a !== b) owner.set(Math.max(a, b) as SegmentId, Math.min(a, b) as SegmentId);
    }
    for (const id of ids) {
      const root = find(id);
      const list = alignments.get(root);
      if (list) list.push(id); else alignments.set(root, [id]);
    }
  }
  const passes: { readonly id: string; readonly structure: RoadStructure; readonly segment?: SegmentId; readonly chain?: readonly SegmentId[] }[] = [
    ...ROAD_STRUCTURES.map((structure) => ({ id: structure.id, structure: structure.id })),
    ...[...alignments].map(([root, chain]) =>
      ({ id: `alignment-${root}`, structure: 'ground' as const, segment: root, chain })),
  ];
  if (reuse) {
    const current = new Set(passes.map((pass) => pass.id));
    for (const id of reuse.tiles.keys()) if (!current.has(id)) reuse.tiles.delete(id);
  }
  for (const pass of passes) {
    yield;
    const structure = roadStructure(pass.structure);
    const present = [...net.doc.segments.values()].some(
      (segment) => pass.chain !== undefined
        ? pass.chain.includes(segment.id)
        : segment.structure === structure.id && !manual(segment.id),
    );
    if (!present) {
      reuse?.tiles.delete(pass.id);
      continue;
    }

    const only: ReadonlySet<RoadStructure> = new Set([structure.id]);
    const include = (id: SegmentId): boolean => pass.chain !== undefined
      ? pass.chain.includes(id)
      : !manual(id) && (net.doc.segment(id)?.structure ?? 'ground') === structure.id;
    /** The segment of the pass a point belongs to: the one whose centreline is nearest. */
    const segmentAt = (x: number, y: number): SegmentId => {
      const chain = pass.chain!;
      if (chain.length === 1) return chain[0]!;
      let best = chain[0]!, bestD = Infinity;
      for (const id of chain) {
        const d = net.ribbons.get(id)?.full.closestPoint({ x, y }).distance ?? Infinity;
        if (d < bestD) { bestD = d; best = id; }
      }
      return best;
    };
    const raised = pass.chain !== undefined
      ? pass.chain.some((id) => {
        const line = net.ribbons.get(id)?.full;
        if (!line) return false;
        for (let s = 0; s <= line.length; s += Math.max(4, line.length / 24)) {
          const p = line.sampleAt(s).p;
          if (elevation.onSegment(id, p.x, p.y) - terrainAt(p.x, p.y) > 5) return true;
        }
        return false;
      })
      : isRaised(structure.id);
    const maxEdge = raised ? RAISED_MAX_EDGE : GROUND_MAX_EDGE;

    /** The single deck height every band of this structure is measured from. */
    const deck: HeightFn = pass.segment !== undefined
      ? (x, y) => elevation.onSegment(segmentAt(x, y), x, y)
      : (x, y) => elevation.at(x, y, only, false);
    /** Underside of the whole structure — the soffit of a deck, or the ground. */
    const soffit: HeightFn = raised
      ? (x, y) => deck(x, y) - roadStructure(pass.segment === undefined ? structure.id : 'elevated').deck - FOOTWAY_RISE
      : (x, y) => Math.min(deck(x, y) - VERGE_SKIRT, terrainAt(x, y) - 0.2);

    const frameFor = (tile: number): UvFrameFn => (x, y, pickX, pickY, out) => {
      const frame = elevation.surfaceFrameAt(x, y, only, pickX, pickY,
        pass.segment !== undefined, pass.segment === undefined ? undefined : segmentAt(pickX, pickY));
      out[0] = frame.across / tile;
      out[1] = frame.along / tile;
    };
    /** Road-framed UVs, with every triangle kept inside one road's frame. */
    const uvFor = (tile: number): { uv: UvFn; uvFrame: UvFrameFn; uvWorld: number } => {
      const uvFrame = frameFor(tile);
      return { uv: (x, y, out) => uvFrame(x, y, x, y, out), uvFrame, uvWorld: tile };
    };

    /**
     * The carriageway's tint, taken from the class of the nearest road and
     * normalised against the colour the asphalt texture was baked at — so the
     * reference class comes out exactly as authored and the others shift from
     * it rather than being multiplied twice.
     */
    const asphaltTint: TintFn = (x, y, out) => {
      const type = pass.segment === undefined
        ? elevation.roadAt(x, y, only, false).type
        : net.doc.segment(pass.segment)?.type ?? 0;
      const tint = CLASS_TINT[type] ?? TINT_REFERENCE;
      out[0] = tint.r / TINT_REFERENCE.r;
      out[1] = tint.g / TINT_REFERENCE.g;
      out[2] = tint.b / TINT_REFERENCE.b;
    };

    const suffix = pass.id === 'ground' ? '' : `-${pass.id}`;

    /**
     * The verge on the ground: from the footway's edge, at the footway's
     * height, down (or up) to the terrain as it is drawn at the verge's outer
     * edge - a batter, not a wall. Read off the nearest road's own section.
     */
    // The batter's fall is measured from the footway's OUTER EDGE as drawn
    // (the union of every footway of this pass), not across the nearest
    // road's centreline: round a junction's corner the nearest leg's
    // centreline is far off, and the batter started at the bottom - a grey
    // wall of footway skirt under the corner's paving.
    let footwayEdges: Polyline[] | null = null;
    const edges = (): Polyline[] => {
      if (!footwayEdges) {
        footwayEdges = [];
        for (const poly of levelPolygons(net, Level.Sidewalk, include)) for (const ring of poly) {
          if (ring.length >= 3) footwayEdges.push(Polyline.fromPoints([...ring.map(([px, py]) => ({ x: px!, y: py! })), { x: ring[0]![0]!, y: ring[0]![1]! }]));
        }
      }
      return footwayEdges;
    };
    const fromFootway = (x: number, y: number): number => {
      let best = Infinity;
      const pad = CASING_BAND * 2;
      for (const line of edges()) {
        const box = line.bbox;
        if (x < box.minX - pad || x > box.maxX + pad || y < box.minY - pad || y > box.maxY + pad) continue;
        best = Math.min(best, line.distanceTo({ x, y }));
      }
      return best;
    };
    const vergeTop: HeightFn = (x, y) => {
      const footway = deck(x, y) + FOOTWAY_RISE;
      const t = Math.min(1, Math.max(0, fromFootway(x, y) / CASING_BAND));
      const ease = t * t * (3 - 2 * t);
      return footway + (terrainAt(x, y) + VERGE_LIFT - footway) * ease;
    };

    // Outermost first, so a nearer band's skirt lands on the one outside it.
    //
    // The ground verge - the batter from the footway's edge down to the
    // terrain - is drawn with the TERRAIN's own material when the renderer
    // passes it (`groundMaterial`). The terrain shader textures by world
    // position, so the batter is the lawn itself rising to the pavement: no
    // strip of a second green along every footway (the player's order of
    // 2026-10-05, "nunca colocar essa manta verde"), and no wall either -
    // the terrain alone cannot reach the footway's height, being a 6.4 m grid
    // that would lift through the asphalt of a kerb return.
    const allSpecs: SurfaceSpec[] = [
      {
        source: { kind: 'band', band: 'verge' },
        options: {
          name: `verge${suffix}`,
          top: raised ? offset(deck, -VERGE_DROP) : vergeTop,
          bottom: soffit,
          material: raised ? materials.deck : groundMaterial ?? materials.verge,
          maxEdge,
          // On the terrain's material the batter takes the terrain plane's UV
          // frame (world x, y): its normal map is read off UV derivatives, and
          // a road-framed UV turned the lawn's relief and lit it as a second green.
          ...(raised || !groundMaterial ? uvFor(raised ? materials.scale.deck : materials.scale.verge) : {
            uv: (x: number, y: number, out: number[] | Float32Array) => { out[0] = x / TERRAIN_UV; out[1] = y / TERRAIN_UV; },
            uvFrame: (x: number, y: number, _px: number, _py: number, out: number[] | Float32Array) => { out[0] = x / TERRAIN_UV; out[1] = y / TERRAIN_UV; },
            uvWorld: TERRAIN_UV,
          }),
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: raised ? materials.scale.deck : materials.scale.verge,
        },
      },
      {
        source: { kind: 'band', band: 'footway' },
        options: {
          name: `footway${suffix}`,
          top: offset(deck, FOOTWAY_RISE),
          // On the ground the footway's own edge goes down into the terrain:
          // there is no verge band outside it (see `specs` below).
          bottom: raised ? offset(deck, -VERGE_DROP) : offset(deck, -VERGE_SKIRT),
          material: materials.footway,
          maxEdge,
          ...uvFor(materials.scale.footway),
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: materials.scale.footway,
        },
      },
      {
        // The dropped kerbs at the zebras (`world/curbRamps.ts`): the footway
        // and its kerb sloping down to the carriageway, at the height the
        // walkers on it read (`walkingRise`). Fine triangles, as the slope is
        // a metre and a half long.
        source: { kind: 'band', band: 'curbRamp' },
        options: {
          name: `curb-ramp${suffix}`,
          top: (x, y) => deck(x, y) + FOOTWAY_RISE * walkingRise(net, x, y, true, structure.id),
          bottom: raised ? offset(deck, -VERGE_DROP) : offset(deck, -VERGE_SKIRT),
          material: materials.footway,
          maxEdge: RAMP_MAX_EDGE,
          ...uvFor(materials.scale.footway),
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: materials.scale.footway,
        },
      },
      {
        source: { kind: 'band', band: 'kerb' },
        options: {
          name: `kerb${suffix}`,
          top: offset(deck, KERB_RISE),
          bottom: deck,
          material: materials.kerb,
          maxEdge,
          ...uvFor(materials.scale.kerb),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        },
      },
      {
        source: { kind: 'band', band: 'asphalt' },
        options: {
          name: `asphalt${suffix}`,
          top: deck,
          ...(raised ? { bottom: soffit } : {}),
          material: raised ? materials.asphaltRaised : materials.asphalt,
          maxEdge,
          ...uvFor(materials.scale.asphalt),
          tint: asphaltTint,
          castShadow: raised,
          receiveShadow: true,
          skirtUvScale: materials.scale.deck,
        },
      },
      {
        source: { kind: 'median', part: 'kerb' },
        options: {
          name: `median-kerb${suffix}`,
          top: offset(deck, MEDIAN_KERB),
          bottom: deck,
          material: materials.kerb,
          maxEdge,
          ...uvFor(materials.scale.kerb),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        },
      },
      {
        source: { kind: 'median', part: 'planting' },
        options: {
          name: `median-planting${suffix}`,
          top: offset(deck, MEDIAN_PLANTING),
          bottom: offset(deck, MEDIAN_KERB),
          material: materials.verge,
          maxEdge,
          ...uvFor(materials.scale.verge),
          receiveShadow: true,
          skirtUvScale: materials.scale.kerb,
        },
      },
    ];
    const specs = allSpecs;

    // ---------------------------------------------------------------- inputs
    const levels: Record<'casing' | 'sidewalk' | 'curb' | 'asphalt', Input[]> = {
      casing: inputsOf(levelRings(net, Level.Casing as SurfaceLevel, include)),
      sidewalk: inputsOf(levelRings(net, Level.Sidewalk as SurfaceLevel, include)),
      curb: inputsOf(levelRings(net, Level.Curb as SurfaceLevel, include)),
      asphalt: inputsOf(levelRings(net, Level.Asphalt as SurfaceLevel, include)),
    };
    const strips = medianStrips(net, include);
    const medians = { kerb: inputsOf(strips.kerb), planting: inputsOf(strips.planting) };
    const ramps = inputsOf(curbRamps(net).filter((r) => include(r.segment)).map((r) => [rampOutline(r)]));
    // The pass's inputs, the crossings' footway and the markings in steps of
    // their own: together they were one step of ~20 ms after a road edit in the
    // test city, past the slice (`renderer.ts` `pumpWorld`, P3).
    yield;
    // Paint belongs to the road legs, not to the shared intersection interior,
    // so it is clipped to the ribbons' carriageway alone.
    const ribbonAsphalt: Input[] = [];
    for (const ribbon of net.ribbons.values()) {
      if (!include(ribbon.id)) continue;
      const ring = ribbon.rings[Level.Asphalt];
      if (!ring || ring.isEmpty) continue;
      const input = inputOf([ring.flatten().map((point) => [point.x, point.y])]);
      if (input) ribbonAsphalt.push(input);
    }
    // ...and to the tapers where a road carries on at another width, whose lane
    // lines and edge lines run on through them (see transitionMarkings).
    for (const node of net.transitions) {
      const junction = net.junctions.get(node)?.get(Level.Asphalt as SurfaceLevel);
      const leg = junction?.legs[0];
      if (!junction || !leg || !include(leg.seg)) continue;
      const input = inputOf([junction.ring.flatten().map((point) => [point.x, point.y])]);
      if (input) ribbonAsphalt.push(input);
    }
    yield;
    net.crossingSurface();
    yield;
    const quads = new Map<string, Input[]>();
    for (const [color, rings] of markingQuads(net, include, structure.id === 'ground')) {
      quads.set(color, inputsOf(rings.map((ring) => [ring])));
      specs.push({
        source: { kind: 'paint', color },
        options: {
          name: `markings-${color.slice(1)}${suffix}`,
          top: offset(deck, 0.02 + PAINT_RISE),
          material: paintFor(color),
          // Paint follows the road it is painted on, so it needs the same vertex
          // density the deck has or it floats over a crest and sinks into a dip.
          maxEdge: 5,
          uv: (x, y, out) => {
            out[0] = x / 12;
            out[1] = y / 12;
          },
          receiveShadow: true,
        },
        renderOrder: 3,
      });
    }

    // ----------------------------------------------------------------- tiles
    /** Everything that reaches each tile, by kind, in input order. */
    interface Reach {
      readonly levels: Record<keyof typeof levels, Input[]>;
      readonly medians: Record<keyof typeof medians, Input[]>;
      readonly ramps: Input[];
      readonly ribbons: Input[];
      readonly quads: Map<string, Input[]>;
    }
    const reach = new Map<number, Reach>();
    const reachOf = (key: number): Reach => {
      let value = reach.get(key);
      if (!value) {
        value = {
          levels: { casing: [], sidewalk: [], curb: [], asphalt: [] },
          medians: { kerb: [], planting: [] },
          ramps: [],
          ribbons: [],
          quads: new Map(),
        };
        reach.set(key, value);
      }
      return value;
    };
    const file = (input: Input, add: (into: Reach) => void): void => {
      const x0 = Math.floor((input.minX - TILE_REACH - TILE_ORIGIN) / TILE);
      const x1 = Math.floor((input.maxX + TILE_REACH - TILE_ORIGIN) / TILE);
      const y0 = Math.floor((input.minY - TILE_REACH - TILE_ORIGIN) / TILE);
      const y1 = Math.floor((input.maxY + TILE_REACH - TILE_ORIGIN) / TILE);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) add(reachOf((ix + TILE_BIAS) * 0x1_0000 + (iy + TILE_BIAS)));
      }
    };
    yield;
    for (const name of ['casing', 'sidewalk', 'curb', 'asphalt'] as const) {
      for (const input of levels[name]) file(input, (into) => into.levels[name].push(input));
    }
    for (const name of ['kerb', 'planting'] as const) {
      for (const input of medians[name]) file(input, (into) => into.medians[name].push(input));
    }
    for (const input of ramps) file(input, (into) => into.ramps.push(input));
    for (const input of ribbonAsphalt) file(input, (into) => into.ribbons.push(input));
    for (const [color, list] of quads) {
      for (const input of list) {
        file(input, (into) => {
          const bucket = into.quads.get(color);
          if (bucket) bucket.push(input);
          else into.quads.set(color, [input]);
        });
      }
    }

    // Everything a tile's build reads besides its rings and its surroundings:
    // the constants of every surface, so a change to one is a change to all.
    // A paint colour's surface draws only in the tiles that hold lines of that
    // colour, so its constants are in those tiles' keys alone: in every key,
    // a road of a class with a colour new to the map (its centre line) made
    // every tile of the town build again, a second's stall for one street.
    const specSalt = (spec: SurfaceSpec): number => new Digest().addText(spec.options.name).add(spec.options.maxEdge)
      .add(spec.options.uvWorld ?? 0).add(spec.options.skirtUvScale ?? 0).add(spec.options.bottom ? 1 : 0)
      .add(spec.options.tint ? 1 : 0).value();
    const salt = new Digest().addText(pass.id);
    const paintSalt = new Map<string, number>();
    for (const spec of specs) {
      if (spec.source.kind === 'paint') paintSalt.set(spec.source.color, specSalt(spec));
      else salt.add(specSalt(spec));
    }
    const saltValue = salt.value();

    const previous = reuse?.tiles.get(pass.id);
    const kept = new Map<number, TileBundle>();
    /** Each surface's tiles, by block of tiles, in tile order. */
    const parts = new Map<string, Map<string, Tile[]>>();
    for (const spec of specs) parts.set(spec.options.name, new Map());
    // In tile order, so a mesh is laid out the same however it was reached.
    for (const key of [...reach.keys()].sort((a, b) => a - b)) {
      const into = reach.get(key)!;
      const ix = Math.floor(key / 0x1_0000) - TILE_BIAS;
      const iy = (key % 0x1_0000) - TILE_BIAS;
      const rect: TileRect = [
        ix * TILE + TILE_ORIGIN, iy * TILE + TILE_ORIGIN, (ix + 1) * TILE + TILE_ORIGIN, (iy + 1) * TILE + TILE_ORIGIN,
      ];
      const digest = new Digest().add(saltValue).add(key);
      const addAll = (list: readonly Input[]): void => {
        digest.add(list.length);
        for (const input of list) digest.add(input.digest);
      };
      addAll(into.levels.casing);
      addAll(into.levels.sidewalk);
      addAll(into.levels.curb);
      addAll(into.levels.asphalt);
      addAll(into.medians.kerb);
      addAll(into.medians.planting);
      addAll(into.ramps);
      addAll(into.ribbons);
      // In a fixed order: the colours come in the order the network first
      // paints them, which a street drawn elsewhere can change, and what a
      // tile builds does not depend on it (its surfaces are kept by name).
      for (const color of [...into.quads.keys()].sort()) {
        digest.addText(color).add(paintSalt.get(color) ?? 0);
        addAll(into.quads.get(color)!);
      }
      if (reuse) digest.add(reuse.dependsOn(rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1));
      const value = digest.value();
      let bundle = previous?.get(value) ?? reuse?.stored?.get(storedKey(pass.id, value));
      if (bundle) {
        reused++;
        // A step too: the digests of every tile kept, back to back, were a
        // slice of 20-30 ms after a road edit (docs/performance.md #34).
        yield;
      } else {
        const tileAt = performance.now();
        bundle = buildTile(into, rect, specs);
        tilesMs += performance.now() - tileAt;
        built++;
        rebuilt.push(rect);
        reuse?.keep?.(storedKey(pass.id, value), bundle);
        yield;
      }
      kept.set(value, bundle);
      const chunk = `${Math.floor(ix / CHUNK)},${Math.floor(iy / CHUNK)}`;
      for (const [name, tile] of bundle) {
        const blocks = parts.get(name);
        if (!blocks) continue;
        const list = blocks.get(chunk);
        if (list) list.push(tile);
        else blocks.set(chunk, [tile]);
      }
    }
    reuse?.tiles.set(pass.id, kept);

    const mergeAt = performance.now();
    for (const spec of specs) {
      for (const [chunk, list] of parts.get(spec.options.name) ?? []) {
        const key = `${pass.id}|${spec.options.name}|${chunk}|${spec.options.material.uuid}|${spec.renderOrder ?? ''}`;
        const known = chunks?.get(key);
        let mesh: Mesh | null;
        if (known && known.parts.length === list.length && known.parts.every((tile, i) => tile === list[i])) {
          mesh = known.mesh;
          chunksKept++;
        } else {
          if (known) retire(known.mesh);
          mesh = mergeTiles(list, spec.options);
          if (mesh && spec.renderOrder !== undefined) mesh.renderOrder = spec.renderOrder;
          if (mesh) chunks?.set(key, { parts: list, mesh });
          else chunks?.delete(key);
          chunksMerged++;
          yield;
        }
        if (!mesh) continue;
        usedChunks.add(key);
        group.add(mesh);
        meshes.push(mesh);
        triangles += (mesh.geometry.index?.count ?? 0) / 3;
      }
    }
    mergeMs += performance.now() - mergeAt;
  }
  // Blocks no surface has any more.
  if (chunks) for (const [key, { mesh }] of chunks) if (!usedChunks.has(key)) { retire(mesh); chunks.delete(key); }
  // Where an edit's time went (`hitch:` entries, scripts/probe-hitches.mjs; docs/performance.md).
  const end = performance.now();
  performance.measure(`hitch:road-edit/surfaces ${built} tiles built ${reused} kept, ${chunksMerged} blocks merged ${chunksKept} kept: tiles ${tilesMs.toFixed(0)} ms, merge ${mergeMs.toFixed(0)} ms`, { start: started, end });
  return {
    group,
    meshes,
    triangles,
    built,
    reused,
    rebuilt,
    workMs: tilesMs + mergeMs,
    dispose() {
      // Meshes the cache keeps are freed by `disposeSurfaceReuse`.
      if (!chunks) for (const mesh of meshes) disposeMesh(mesh);
      group.clear();
      if (!reuse) for (const material of paint.values()) material.dispose();
    },
  };
}

function inputsOf(polys: readonly Poly[]): Input[] {
  const out: Input[] = [];
  for (const poly of polys) {
    const input = inputOf(poly);
    if (input) out.push(input);
  }
  return out;
}

/**
 * Every surface of one tile, from the rings that reach it: merged, banded and
 * clipped exactly as the whole network would be, then cut to the tile.
 */
function buildTile(
  into: {
    readonly levels: Record<'casing' | 'sidewalk' | 'curb' | 'asphalt', readonly Input[]>;
    readonly medians: Record<'kerb' | 'planting', readonly Input[]>;
    readonly ramps: readonly Input[];
    readonly ribbons: readonly Input[];
    readonly quads: ReadonlyMap<string, readonly Input[]>;
  },
  rect: TileRect,
  specs: readonly SurfaceSpec[],
): TileBundle {
  const merged = (list: readonly Input[]): MultiPoly => list.length > 0 ? union(list.map((input) => input.poly)) : [];
  const casing = merged(into.levels.casing);
  const sidewalk = merged(into.levels.sidewalk);
  const curb = merged(into.levels.curb);
  const asphalt = merged(into.levels.asphalt);
  const footway = difference(sidewalk, curb);
  const kerb = difference(curb, asphalt);
  // The dropped kerbs take their piece out of the footway and the kerb and
  // are a surface of their own, sloping (`world/curbRamps.ts`).
  const ramps = merged(into.ramps);
  const bands: Record<'verge' | 'footway' | 'kerb' | 'asphalt' | 'curbRamp', MultiPoly> = {
    verge: difference(casing, sidewalk),
    footway: ramps.length > 0 ? difference(footway, ramps) : footway,
    kerb: ramps.length > 0 ? difference(kerb, ramps) : kerb,
    asphalt,
    curbRamp: ramps.length > 0 ? intersection(difference(sidewalk, asphalt), ramps) : [],
  };
  let ribbonsOnly: MultiPoly | null = null;
  const bundle = new Map<string, Tile>();
  for (const spec of specs) {
    const source = spec.source;
    let polygons: MultiPoly;
    if (source.kind === 'band') polygons = bands[source.band];
    else if (source.kind === 'median') {
      const list = into.medians[source.part];
      polygons = list.length > 0 ? intersection(merged(list), asphalt) : [];
    } else {
      const list = into.quads.get(source.color) ?? [];
      if (list.length === 0) polygons = [];
      else {
        ribbonsOnly ??= merged(into.ribbons);
        polygons = intersection(merged(list), ribbonsOnly);
      }
    }
    const inside = polygons.length > 0 ? clipToRect(polygons, rect) : [];
    if (inside.length > 0) bundle.set(spec.options.name, meshTile({ ...spec.options, polygons: inside }, rect));
  }
  return bundle;
}

/**
 * The central reservation's outlines, as two real polygons rather than as paint.
 *
 * It used to be drawn as two overlapping marking strokes at the same height —
 * a wide kerb colour with a narrower green inside it — which put two coplanar
 * surfaces in the depth buffer and produced the torn green scribble a player
 * photographed down the middle of every boulevard. A median is not paint: it is
 * a kerbed island with something growing in it, so it is built like one, with
 * its own height and its own skirt.
 *
 * Clipped against the carriageway so it can never leak past the kerb line, and
 * unioned so two medians meeting at a junction are one shape rather than two
 * overlapping ones - both a tile at a time, in `buildRoadSurfaces`.
 */
function medianStrips(
  net: Network,
  include: (segment: SegmentId) => boolean,
): { kerb: Poly[]; planting: Poly[] } {
  const kerb: Poly[] = [];
  const planting: Poly[] = [];
  for (const ribbon of net.ribbons.values()) {
    if (!include(ribbon.id)) continue;
    const median = ribbon.road.median;
    if (median <= 0) continue;
    const centre = ribbon.centre[Level.Asphalt];
    if (!centre || centre.n < 2) continue;
    const points = centre.toPoints();
    kerb.push(strip(points, (median + 1.4) / 2));
    planting.push(strip(points, median / 2));
  }
  return { kerb, planting };
}

/** A closed ribbon `half` wide either side of a centreline. */
function strip(points: readonly { x: number; y: number }[], half: number): MultiPoly[number] {
  const left = offsetPolyline(points, half);
  const right = offsetPolyline(points, -half).reverse();
  return [[...left, ...right].map((p) => [p.x, p.y])];
}
