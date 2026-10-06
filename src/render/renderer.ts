import { pointInPolygon } from '@core/polygon';
import type { Occupant } from './ragdoll';
import { createLotOverlay, type LotOverlayInput } from './lotOverlay';
import { onCarriageway } from '@world/carriageway';
import {
  BufferGeometry,
  Float32BufferAttribute,
  Color,
  Quaternion,
  ACESFilmicToneMapping,
  Box3,
  PointLight,
  Group,
  Frustum,
  Matrix4,
  type Material,
  Mesh,
  MeshDepthMaterial,
  type Object3D,
  RGBADepthPacking,
  Sphere,
  PCFShadowMap,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';

import { Digest } from '@core/digest';
import type { Vec2 } from '@core/vec2';
import type { SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { GROUND_ONLY, buildRoadElevation, type RoadElevation } from '@world/elevation';
import { FOOTWAY_RISE, ROAD_TYPES, casingHalf, sidewalkHalf } from '@world/roadTypes';
import type { RoadStructure } from '@world/structures';
import type { SimWorld } from '@sim/world';
import type { Viewport } from '@view/viewport';

import { createAgentMeshes, type AgentMeshes } from './agents';
import { createEnvironment } from './environment';
import { createMaterials, type SceneMaterials } from './materials';
import { createIsoRig } from './isoViewport';
import { createPostChain, type PostChain } from './postprocess';
import { createInspector, type Inspector } from './inspector';
import { buildRoadSurfaces, type RoadSurfaces, type SurfaceReuse } from './roadSurfaces';
import { PLANT_MAP_ZOOM, PLANT_NEAR_ZOOM, buildGardens, buildScenery, buildStreetFurniture, createSceneryKit, type GardenPlant, type Scenery, type SceneryKit } from './scenery';
import { buildingBounds, levelElevation, localToWorld, roofHeightAt, roofRise, solidFootprints, volumeCorners, worldToLocal } from '@world/buildings/geometry';
import { elementRing, followPieces } from '@world/buildings/elements';
import { RoadDoc } from '@world/doc';
import { compileAhead, drainCompiles, drainUploads, drainWarm } from './uploads';
import { GRASS_MIN_ZOOM } from './grass';
import { advanceWind } from './wind';
import { createSignalHeads, type SignalHeads } from './signals';
import { buildStructureDetails, type StructureDetails } from './structures';
import { createExhaust } from './exhaust';
import { createCasualties } from './casualties';
import { createRagdolls, type RagdollWall, type RagdollWorld } from './ragdoll';
import { createBlast } from './blast';
import { POLE_ARM_DROP, POLE_ARM_HALF, POLE_HEIGHT, POLE_LAMP_REACH } from '@world/utilities';
import { impactCasualties } from '@sim/people/people';
import { createDestruction } from './destruction';
import { floorHeight } from '@world/buildings/foundation';
import { GROW_MINUTES } from '@world/landscape';
import { applyWear, createWearField } from './wear';
import { MAP_SIZE } from '@world/bounds';
import { buildSigns, type SignLayer } from './signs';
import { buildPolePreview, buildUtilities, poleGroundAt, type PolePreviewInput, type Utilities } from './utilities';
import { buildBarriers, type Barriers } from './barriers';
import { buildTrackPreview, buildTransit, type TransitMeshes } from './transit';
import { TERRAIN_CELL, TERRAIN_HALF, createTerrainSurface, type TerrainRegion, type TerrainSurface } from './terrain';
import { buildingPads, type Pad } from '@world/buildings/pads';
import { Indoors } from './indoors';
import { setLit, slotOf, slotsOnFloor } from './buildings/lightSlots';
import { m } from '@world/units';
/**
 * Marks lit every space somebody is in, awake: a resident's own flat at home
 * (none after bedtime), the floor of their job at work, the ground floor for
 * a visitor, and the lobby of a block of flats with people in it after dark.
 */
function updateLitRooms(sim: SimWorld): void {
  const lit = new Set<number>();
  const hour = (sim.city.minutes(sim) % 1440) / 60;
  const asleep = hour >= 23 || hour < 6.5;
  const addFloor = (b: number, level: number): void => { for (const slot of slotsOnFloor(b, level)) lit.add(slot); };
  for (const b of sim.doc.buildings.all()) {
    const inside = sim.city.inside(b.id);
    if (inside.length === 0) continue;
    for (const r of inside) {
      if (r.home === b.id) {
        if (asleep) continue;
        const flat = r.homeSpace;
        const slot = flat ? slotOf(b.id, r.homeLevel, flat.volume, flat.x, flat.y) : -1;
        if (slot >= 0) lit.add(slot); else addFloor(b.id, r.homeLevel);
      } else addFloor(b.id, r.work === b.id ? r.workLevel : 0);
    }
    if (b.function === 'apartments' || b.function === 'residentialTower') addFloor(b.id, 0);
  }
  setLit(lit);
}

/** Room lights kept in the scene for the floors cut open (`indoors.ts`). */
const ROOM_LIGHTS = 6;
/** The thinnest frame bars are 0.045 u wide: their shadows are subpixel below this zoom. */
const FACADE_SHADOW_ZOOM = 11;
import { type BuildingPreviewInput, type CutawaySpec, createBuildingLayer } from './buildings/layer';
import type { Building, BuildingId } from '@world/buildings/types';
import { QUALITY, QualityGovernor, type QualityLevel, type QualitySettings } from './quality';

/**
 * The scene renderer.
 *
 * ## The rebuild contract
 *
 * Everything derived from the road network or the terrain is rebuilt in exactly
 * one place, `rebuildWorld`, and only when one of the two revisions it watches
 * has moved. Nothing computes geometry inside `draw`. That matters because a
 * road rebuild solves the whole elevation field and re-triangulates every band:
 * doing it per frame was how earlier versions turned an edit into a stall.
 *
 * A terrain edit invalidates the roads too — they are laid ON the terrain — so
 * both revisions gate the same rebuild.
 *
 * ## Draw order
 *
 * 1. terrain (heightfield, water)
 * 2. road surfaces (four bands per structural level, plus markings)
 * 3. structure details (piers, parapets)
 * 4. scenery (furniture, trees, bushes; grass at close zoom only)
 * 5. agents and signal heads, resynced every frame from the simulation
 */

/** How the sky is kept: `cycle` follows the residents' clock. */
export type SkyMode = 'day' | 'night' | 'cycle';


/** What an explosion broke, for the renderer to throw (`blast.ts`): world coordinates. */
export interface BlastHit {
  readonly ground: 'road' | 'earth' | 'building';
  readonly crater: boolean;
  readonly poles: readonly { x: number; y: number; lamp: boolean; mode: 'whole' | 'snap' | 'splinter'; dirX: number; dirY: number }[];
  /** Wires torn off a broken pole: from the pole still standing towards the one that went. */
  readonly wires: readonly { fromX: number; fromY: number; toX: number; toY: number }[];
  readonly posts: readonly { x: number; y: number; yaw: number }[];
  readonly vehicles: readonly { x: number; y: number; angle: number; length: number; width: number; height: number; color: number }[];
  readonly items: readonly { kind: string; x: number; y: number }[];
}

export interface RenderStats {
  /** Built scene geometry budget; `gl.info.render.triangles` counts drawn passes. */
  readonly triangles: number;
  /** Actual draw calls across every pass of the last game frame. */
  readonly drawCalls: number;
  readonly quality: QualityLevel;
  readonly fps: number;
  /** Wall time of the last world rebuild, in milliseconds. */
  readonly rebuildMs: number;
  /** The road surface tiles the last rebuild made afresh, and those it kept. */
  readonly roadTiles?: { readonly built: number; readonly reused: number };
  /** Increments once per completed world rebuild. */
  readonly rebuilds: number;
  /** Wall time of the last terrain-only update (a brush dab while roads are held), ms. */
  readonly terrainMs: number;
}

export interface DrawOptions {
  /**
   * Keep the roads, and everything laid along them, as they are: only the
   * ground is updated, and shaped to the roads' current heights. Set while a
   * terrain brush stroke is held; the first draw without it re-solves the
   * roads once for the whole stroke.
   */
  readonly holdRoads?: boolean;
}

export interface SceneHandle {
  readonly backend: 'three-webgl';
  readonly viewport: Viewport;
  readonly scene: Scene;
  /** The underlying WebGL renderer. Exposed for diagnostics and tests. */
  readonly gl: WebGLRenderer;
  readonly stats: RenderStats;
  /** The solved road height field, for the editor's own previews. */
  elevationAt(x: number, y: number, structure?: RoadStructure): number;
  /** The editor's building ghost (docs/buildings.md); null removes it. */
  setBuildingPreview(preview: BuildingPreviewInput | null): void;
  /** The pole run the pole tool would build, drawn as built; null removes it. */
  setPolePreview(net: Network, preview: PolePreviewInput | null): void;
  /** The metro seen as a cut through the ground (the transit tool on). */
  setTransitXray(on: boolean): void;
  /** The track being laid, built as it will be (`buildTrackPreview`); null removes it. */
  setTransitPreview(preview: { mode: 'train' | 'metro'; points: readonly { x: number; y: number }[] } | null): void;
  /** The lots of the Zoning tool laid on the ground (`lotOverlay.ts`); null removes them. */
  setLotOverlay(input: LotOverlayInput | null): void;
  /**
   * A blow on a building at world (x, y, z), `strength` 1..10: it breaks
   * (`destruction.ts`). Returns true when nothing of it is left standing.
   */
  strikeBuilding(b: Building, x: number, y: number, z: number, strength: number): boolean;
  /** A blow on the street at (x, y): a crater in the asphalt, dust. */
  strikeGround(x: number, y: number, strength: number): void;
  /** An explosion at world (x, y), height z, reaching `radius` (`blast.ts`), and the things it broke. */
  explode(x: number, y: number, z: number, radius: number, hit: BlastHit): void;
  /** People inside a struck building, thrown out of it (`ragdoll.fling`). */
  flingOccupants(list: readonly Occupant[]): void;
  /** Called when a struck building comes down after its blow (its pieces were made off the main thread). */
  onBuildingDown(listener: (id: number) => void): void;
  /** A broken hydrant spouting water (`blast.geyser`). */
  geyser(x: number, y: number, z: number, seconds?: number): void;
  /** A burst pipe: a small spout of water from a wall for a moment. */
  leak(x: number, y: number, z: number, seconds: number): void;
  /** Sparks of a short circuit at world (x, y), height z, for a while (`blast.arc`). */
  sparkAt(x: number, y: number, z: number, seconds: number): void;
  /** Soot laid on the ground (`blast.soot`). */
  soot(x: number, y: number, z: number, radius: number): void;
  /** Smoke in the air, 0 clear to 1 thick: the fog closes in, browner, the light dims. */
  setSmog(k: number): void;
  /** A lasting fire at world (x, y), height z (a building burning). */
  burn(x: number, y: number, z: number, size: number, seconds: number): void;
  /** Whether anything is still moving on its own (an explosion, bodies, debris): keep drawing. */
  busy(): boolean;
  /** Forgets a building's ruin (it was removed). */
  forgetRuin(id: number): void;
  /**
   * The Builder's "Ocultar outros": undefined draws every building solid,
   * null fades them all, an id fades every building but that one.
   */
  setBuildingsDimmed(except: number | null | undefined): void;
  /** "See inside": the buildings near (x, y) drawn cut open at a floor; null draws them whole. */
  setBuildingCutaway(spec: CutawaySpec | null): void;
  /** The sky: always day, always night, or the residents' own clock. */
  setSkyMode(mode: SkyMode): void;
  /** Perspective camera on, or the orthographic (isometric) view. */
  setPerspective(on: boolean): void;
  /** The height the terrain is drawn at — what anything laid on it must clear. */
  terrainHeightAt(x: number, y: number): number;
  /**
   * The top of what is drawn at a point: a deck where a road's casing covers
   * it, the terrain elsewhere. (`elevationAt` is the NEAREST road's height
   * wherever the point is, a field for previews, not a surface.)
   */
  surfaceHeightAt(x: number, y: number): number;
  /**
   * The height of the paving at a point - footway or carriageway of a road at
   * grade - or NaN off the roads. What a building's entrance opens onto.
   */
  pavedHeightAt(x: number, y: number): number;
  resize(): void;
  draw(net: Network, sim: SimWorld, alpha: number, delta: number, options?: DrawOptions): void;
  setQuality(level: QualityLevel | 'auto'): void;
  readonly quality: QualityLevel | 'auto';
  /** The inspection camera (`inspector.ts`); null outside development builds. */
  readonly inspect: Inspector | null;
  /** Every figure drawn last frame and the body it was cast as: the runtime census. */
  census(): ReturnType<AgentMeshes['census']>;
  dispose(): void;
}

/** Roads at grade, and the decks above them, as `surfaceHeightAt` asks them. */
const SURFACE_SETS: readonly ReadonlySet<RoadStructure>[] = [GROUND_ONLY, new Set<RoadStructure>(['elevated', 'bridge'])];

/** The plants of every building's garden, in the world, on the ground they stand on. */
function gardenPlants(all: Iterable<Building>, groundAt: (x: number, y: number) => number): GardenPlant[] {
  const out: GardenPlant[] = [];
  for (const b of all) {
    for (const el of b.elements ?? []) {
      if (el.kind !== 'tree' && el.kind !== 'shrub' && el.kind !== 'hedge' && el.kind !== 'flowers') continue;
      // `w` runs across the way the element faces.
      const yaw = (b.rotation ?? 0) + (el.facing === 1 || el.facing === 3 ? Math.PI / 2 : 0) + (el.angle ?? 0);
      // A long hedge in steps, each on the ground under it, not one box at its middle's height.
      const kind = el.kind;
      followPieces(el).forEach((piece, k) => {
        const at = localToWorld(b, piece.x, piece.y);
        out.push({ kind, x: at.x, y: at.y, z: groundAt(at.x, at.y), w: piece.w, d: piece.d, h: piece.h, yaw,
          seed: ((b.id * 7919 + el.id * 104729 + k * 31) % 100003) / 100003 });
      });
    }
  }
  return out;
}

export function createSceneRenderer(
  canvas: HTMLCanvasElement,
  initialCentre: Vec2,
  initialZoom: number,
  initialQuality: QualityLevel | 'auto' = 'auto',
  onAssetsReady: () => void = () => {},
): SceneHandle {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  // One game frame has the scene, shadows and several postprocess renders.
  // The default reset on each `render()` left stats showing only the last quad.
  renderer.info.autoReset = false;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap was REMOVED in three r186. Asking for it logged
  // "PCFSoftShadowMap has been removed. Using PCFShadowMap instead." on every
  // boot and silently gave us the hard filter anyway, so the softness the
  // scene was tuned for never existed. Name what we actually get.
  renderer.shadowMap.type = PCFShadowMap;
  // Drawn once a frame, on request (see `post.render` below). Left automatic,
  // three redraws every shadow map on EVERY `renderer.render`, and the frame
  // has two scene renders with the sun in them - the main pass and the
  // ambient-occlusion pass's normal pass - so the whole shadow pass, every
  // caster in the city, was drawn twice a frame for the same picture.
  renderer.shadowMap.autoUpdate = false;

  // One shadow depth material per program variant. three draws every caster
  // without a depth material of its own with ONE shared material, and plain
  // meshes, instanced meshes and instanced meshes with per-instance colour
  // compile to three different programs of it: interleaved in the shadow pass,
  // three re-derived the program on nearly every draw (`getParameters`,
  // `setProgram` - the trap CLAUDE.md describes, inside three). Each variant
  // now has its own material, so each keeps its program.
  const depthVariants = {
    plain: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
    instanced: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
    tinted: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
  };
  const ownDepth = new Set<MeshDepthMaterial>(Object.values(depthVariants));
  const plainOpaque = (material: Material): boolean => {
    const m = material as Material & { alphaTest: number; alphaMap?: unknown; map?: unknown; displacementMap?: unknown };
    // Anything three would give a depth material of its own (cut-outs,
    // displacement, coverage) keeps three's own choice.
    return !(m.alphaTest > 0 && (m.map || m.alphaMap)) && !m.displacementMap && !m.alphaToCoverage;
  };
  const assignShadowDepth = (root: Object3D): void => {
    root.traverse((object) => {
      const mesh = object as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown };
      if (!mesh.isMesh || !mesh.castShadow) return;
      const current = mesh.customDepthMaterial as MeshDepthMaterial | undefined;
      if (current && !ownDepth.has(current)) return;
      if (Array.isArray(mesh.material) || !plainOpaque(mesh.material)) return;
      const wanted = !mesh.isInstancedMesh
        ? depthVariants.plain
        : mesh.instanceColor ? depthVariants.tinted : depthVariants.instanced;
      if (current !== wanted) mesh.customDepthMaterial = wanted;
    });
  };

  let requested: QualityLevel | 'auto' = initialQuality;
  const governor = new QualityGovernor(requested === 'auto' ? 'high' : requested);
  let quality: QualitySettings = QUALITY[governor.current];

  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const anisotropy = Math.min(quality.anisotropy, maxAnisotropy);

  const scene = new Scene();
  // The root never moves. Keep its identity matrix from forcing every static
  // world child to recompute a world matrix on every render pass.
  scene.matrixAutoUpdate = false;
  scene.updateMatrix();
  const initialHeight = Math.max(1, canvas.clientHeight || window.innerHeight);
  const rig = createIsoRig(initialCentre, initialHeight / Math.max(0.001, initialZoom * 2));

  const environment = createEnvironment(scene, renderer, {
    shadows: quality.shadows,
    shadowMapSize: quality.shadowMapSize,
  });

  const materials: SceneMaterials = createMaterials(anisotropy);
  // Streets and footways wear with use (`wear.ts`).
  const wear = createWearField(MAP_SIZE);
  let lastWall = -1;
  applyWear(materials.asphalt, wear, MAP_SIZE, 0, 'asphalt');
  applyWear(materials.footway, wear, MAP_SIZE, 1, 'footway');
  // For browser-driven checks: the field, to age a street on demand.
  if (typeof window !== 'undefined') (window as unknown as { __wear?: unknown }).__wear = wear;
  materials.setDetail(quality.surfaceDetail);
  // Every prop model and material, built once. A rebuild writes only the
  // instance matrices.
  const sceneryKit: SceneryKit = createSceneryKit();
  const terrain: TerrainSurface = createTerrainSurface(anisotropy);
  scene.add(...terrain.meshes);

  const world = new Group();
  world.name = 'world';
  scene.add(world);

  let roads: RoadSurfaces | null = null;
  let details: StructureDetails | null = null;
  let scenery: Scenery | null = null;
  /** What the player placed on the footways; on `doc.utilityRevision` like the poles. */
  let furniture: Scenery | null = null;
  let utilities: Utilities | null = null;
  /** The pole tool's planned run, and the plan it was built for (rebuilt only when that changes). */
  /** Vehicle exhaust and dust (`exhaust.ts`): one particle cloud for the map. */
  const exhaust = createExhaust();
  scene.add(exhaust.points);
  /** Buildings knocked down block by block (`destruction.ts`). */
  const destruction = createDestruction(exhaust, (b) => buildings.chunkOf(b));
  scene.add(destruction.group);
  destruction.onRuined = () => { buildings.setRuined(destruction.ruined); };
  /** Blood where blows killed people (`casualties.ts`). */
  const casualties = createCasualties();
  scene.add(casualties.group);
  /** Explosions and what they throw (`blast.ts`). */
  const blast = createBlast(exhaust);
  const shakeOffset = new Vector3();
  scene.add(blast.group);
  /** The bodies of the people blows killed (`ragdoll.ts`). */
  const ragdolls = createRagdolls(exhaust, (id, x, y, heading, seconds) => {
    // Up again where the body came to rest (`PeopleEngine.getUp`).
    if (ragdollSim) ragdollSim.pedEngine.getUp?.(ragdollSim, id, x, y, heading, seconds);
  });
  (globalThis as Record<string, unknown>)['__ragdolls'] = ragdolls;
  /** Who is down (a `fall` pause) this frame. */
  const ragdollDown = new Set<number>();
  /** The world drawn this frame, for the walls a body strikes. */
  let ragdollSim: SimWorld | null = null;
  /** The lots near the bodies (their raised yards are ground too), and the ground found, by small cells. */
  const ragdollLots = new Set<BuildingId>();
  const ragdollGround = new Map<number, number>();
  const ragdollWorld: RagdollWorld = {
    groundAt(x, y) {
      const key = Math.round(x * 5) * 100003 + Math.round(y * 5);
      const known = ragdollGround.get(key);
      if (known !== undefined) return known;
      // A lot's yard as drawn, else the paving (a footway stands over the
      // terrain), else the terrain.
      let h = NaN;
      for (const id of ragdollLots) {
        h = buildings.lotHeightAt(id, x, y);
        if (Number.isFinite(h)) break;
      }
      if (!Number.isFinite(h)) h = pavedHeightAt(x, y);
      if (!Number.isFinite(h)) h = terrain.renderedHeightAt(x, y);
      if (ragdollGround.size > 60000) ragdollGround.clear();
      ragdollGround.set(key, h);
      return h;
    },
    wallsNear(x, y, reach) {
      // The buildings standing (not a ruin) and the walls, fences and hedges of their lots.
      const out: RagdollWall[] = [];
      if (ragdollLots.size > 400) ragdollLots.clear();
      ragdollGround.clear();
      for (const b of ragdollSim?.doc.buildings.all() ?? []) {
        if (destruction.ruined.has(b.id) || Math.hypot(b.x - x, b.y - y) > reach + m(40)) continue;
        ragdollLots.add(b.id);
        const floor = floorHeight(b, terrain.naturalRenderedHeightAt, pavedHeightAt);
        for (const v of b.volumes) {
          if (v.base !== 0 || v.mode === 'void' || v.mode === 'intersect' || v.open) continue;
          // The walls up to the eaves, the roof over them: a body lands on it and slides down a pitch.
          const eaves = floor + levelElevation(b, v.base + v.storeys.length);
          out.push({ ring: volumeCorners(b, v), top: eaves + roofRise(b, v), roof: (wx, wy) => eaves + Math.max(0, roofHeightAt(b, v, worldToLocal(b, { x: wx, y: wy }))) });
        }
        for (const e of b.elements ?? []) {
          if ((e.kind === 'wall' || e.kind === 'fence' || e.kind === 'hedge') && e.z <= 0.01) out.push({ ring: elementRing(b, e), top: floor + e.h });
        }
      }
      return out.filter((w) => w.ring.length >= 3);
    },
  };
  let polePreview: Utilities | null = null;
  /** Placed signs and street name plates (`signs.ts`), on `doc.utilityRevision` with the furniture. */
  let signs: SignLayer | null = null;
  let polePreviewKey = '';
  /** Walls, fences and hedges (`barriers.ts`), and the state they were built for. */
  let barriers: Barriers | null = null;
  let barriersFor = '';
  /** Public transport (`transit.ts`), and the state it was built for. */
  let transit: TransitMeshes | null = null;
  let transitFor = '';
  let elevation: RoadElevation | null = null;

  // What each rebuild keeps for the next: the tiles of every surface an edit
  // does not reach, keyed by the solved roads and the ground they read.
  const surfaceReuse: SurfaceReuse = {
    tiles: new Map(),
    dependsOn: (minX, minY, maxX, maxY) => new Digest()
      .add(elevation?.digest(minX, minY, maxX, maxY) ?? 0)
      .add(terrain.digest(minX, minY, maxX, maxY))
      .value(),
    paint: new Map(),
  };

  let networkRevision = -1;
  let terrainRevision = -1;
  let builtTriangles = 0;
  let rebuildMs = 0;
  let rebuilds = 0;
  let terrainMs = 0;

  const deckHeight = (
    _world: SimWorld,
    x: number,
    y: number,
    segment: SegmentId | undefined,
  ): number => {
    if (!elevation) return terrain.renderedHeightAt(x, y);
    return segment === undefined ? elevation.at(x, y) : elevation.onSegment(segment, x, y);
  };

  /** See `SceneHandle.pavedHeightAt`. */
  const pavedHeightAt = (x: number, y: number): number => {
    if (!elevation || !elevation.has(GROUND_ONLY)) return NaN;
    const road = elevation.roadAt(x, y, GROUND_ONLY);
    const rt = road.type >= 0 ? ROAD_TYPES[road.type] : undefined;
    if (!rt) return NaN;
    // `half` is this road's own casing (its lanes may be set individually):
    // the footway ends a casing band inside it and starts a footway further in.
    const footway = road.half - (casingHalf(rt) - sidewalkHalf(rt));
    const across = Math.abs(road.across);
    if (across > footway) return NaN;
    const deck = elevation.at(x, y, GROUND_ONLY);
    return across > footway - (road.sidewalk ?? rt.sidewalk) ? deck + FOOTWAY_RISE : deck;
  };

  const agents: AgentMeshes = createAgentMeshes(deckHeight, onAssetsReady,
    // A walker off the streets stands on what is drawn there: a building's
    // terrace or yard paving where there is one, the terrain elsewhere (they
    // sank to the knees in a raised terrace).
    (x, y) => {
      const lot = buildings.anyLotHeightAt(x, y);
  // A body torn apart: a limb or two and what was inside thrown over the
  // street, where they stay; blood spraying off them as they fly.
  ragdolls.onGore = (x, y, z, dx, dy, speed, kind) => {
    const skin = [0xc89878, 0x9c6b4e, 0x6e4632, 0xe0b49a][Math.floor(Math.random() * 4)]!;
    const limbs = kind === 'torn' ? 1 + Math.floor(Math.random() * 3) : 1;
    for (let k = 0; k < limbs; k++) {
      const v = new Vector3(dx * speed * (0.4 + Math.random() * 0.6) + (Math.random() - 0.5) * m(5), m(3 + Math.random() * 5),
        -dy * speed * (0.4 + Math.random() * 0.6) + (Math.random() - 0.5) * m(5));
      const leg = Math.random() < 0.5;
      blast.debris({ shape: 'cylinder', kind: 'flesh', color: skin, at: new Vector3(x, z, -y),
        size: new Vector3(m(leg ? 0.075 : 0.05), m(leg ? 0.85 : 0.6), m(leg ? 0.075 : 0.05)), velocity: v,
        spin: new Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 12) });
    }
    const organs = kind === 'torn' ? 6 + Math.floor(Math.random() * 6) : 2;
    for (let k = 0; k < organs; k++) {
      const s0 = m(0.08 + Math.random() * 0.14);
      blast.debris({ shape: Math.random() < 0.5 ? 'cylinder' : 'box', kind: 'flesh', color: [0x6e0d10, 0x8c2a32, 0xa04a55, 0x5a1414][k % 4]!,
        at: new Vector3(x, z, -y), size: new Vector3(s0, s0 * (0.6 + Math.random()), s0 * (0.7 + Math.random() * 0.6)),
        velocity: new Vector3(dx * speed * 0.5 + (Math.random() - 0.5) * m(6), m(2 + Math.random() * 4), -dy * speed * 0.5 + (Math.random() - 0.5) * m(6)) });
    }
  };
  // A trail of blood behind those who lost a limb: a drop every metre or so.
  const lastDrip = new Map<number, { x: number; y: number }>();
  agents.setBleed((id, x, y, z) => {
    const last = lastDrip.get(id);
    if (last && Math.hypot(last.x - x, last.y - y) < m(0.9)) return;
    lastDrip.set(id, { x, y });
    if (lastDrip.size > 500) lastDrip.clear();
    ragdolls.drip(x + (Math.random() - 0.5) * m(0.3), y + (Math.random() - 0.5) * m(0.3), z + m(0.02), m(0.25 + Math.random() * 0.35));
  });
      const ground = terrain.renderedHeightAt(x, y);
      return Number.isFinite(lot) ? Math.max(lot, ground) : ground;
    },
    // A resident's parked car stands on its lot as the lot is drawn.
    (building, x, y) => buildings.lotHeightAt(building as BuildingId, x, y));

  const crowdFrustum = new Frustum();
  const crowdProjection = new Matrix4();
  const crowdBounds = new Sphere(new Vector3(), 8);
  const pedestrianVisible = (x: number, y: number, height: number): boolean => {
    crowdBounds.center.set(x, height + 3, -y);
    return crowdFrustum.intersectsSphere(crowdBounds);
  };
  // A vehicle is tested with its own reach, grown by its height towards the
  // sun's side: an off-screen truck near the edge still casts a shadow onto it.
  const vehicleBounds = new Sphere(new Vector3(), 1);
  const vehicleVisible = (x: number, y: number, height: number, radius: number): boolean => {
    vehicleBounds.center.set(x, height + radius * 0.3, -y);
    vehicleBounds.radius = radius;
    return crowdFrustum.intersectsSphere(vehicleBounds);
  };
  scene.add(...agents.meshes);
  const signals: SignalHeads = createSignalHeads(scene, deckHeight);

  // Modular buildings: their own layer, behind their own gate (see
  // `render/buildings/layer.ts`), so a building edit never re-solves the roads.
  const buildings = createBuildingLayer();
  scene.add(buildings.group);
  /** The scenery the building footprints were last cut out of. */
  let excludedFor: { scenery: Scenery | null; site: string | null } = { scenery: null, site: null };
  /** The buildings' garden plants, and the buildings and ground they were planted for. */
  let gardens: Scenery | null = null;
  let gardensFor = '';
  // One representative per material and mesh program variant is enough for
  // compileAsync. Passing the whole scene compiled every repeated instance,
  // including objects hidden outside the view, during the first town frame.
  const compiledVariants = new WeakMap<Material, Set<string>>();
  let compileCheckedAt = 0;
  let compiling = false;
  /** The look for new materials in progress and their representative objects. */
  const scanStack: Object3D[] = [];
  const compileSamples: Object3D[] = [];
  const SCAN_PER_FRAME = 1500;
  /** The buildings cut open, for the people drawn inside them (`indoors.ts`). */
  let cutSpec: CutawaySpec | null = null;
  let skyMode: SkyMode = 'day';
  const indoors = new Indoors();
  // Room lights for the floors cut open: a fixed set, so switching them on and
  // off never changes the scene's light count (which recompiles every shader).
  const roomLights: PointLight[] = [];
  for (let i = 0; i < ROOM_LIGHTS; i++) {
    const light = new PointLight(0xffd6a0, 0, m(8), 2);
    light.name = 'room-light';
    light.castShadow = false;
    scene.add(light);
    roomLights.push(light);
  }
  let lampsKey = '';
  let litAt = 0;
  let tallestFor = -1;
  let lastDark = -1;
  let tallestTop = 0;
  const tallestBox = new Box3();
  const viewDirection = new Vector3();
  /** The building revision the ground was last graded for. */
  let gradedFor = -1;
  /**
   * What the ground under the buildings is graded from (`buildingPads`): each
   * building's built footprints, its floor and its open lots - not its
   * storeys, its facades or its rooms. A storey added to a building re-graded
   * the ground of the whole town and re-planted every garden; now the ground
   * is graded again only when a site changed.
   */
  /** The ground the buildings were last graded on (frozen while a stroke is held). */
  let buildingGround = '';
  /** Bumped each time the ground is graded: what stands on it is set again. */
  let groundVersion = 0;
  /** The plants of the buildings' gardens, as `gardenPlants` reads them, by building revision. */
  let plantsFor = -1;
  let plantsKey = '';
  const plantSignature = (doc: RoadDoc): string => {
    if (plantsFor === doc.buildings.revision) return plantsKey;
    plantsFor = doc.buildings.revision;
    const parts: unknown[] = [];
    for (const b of doc.buildings.all()) {
      const plants = (b.elements ?? []).filter((el: { kind: string }) => el.kind === 'tree' || el.kind === 'shrub' || el.kind === 'hedge' || el.kind === 'flowers');
      if (plants.length) parts.push([b.id, b.x, b.y, b.rotation, plants]);
    }
    return (plantsKey = JSON.stringify(parts));
  };
  /**
   * Cuts and fills the ground to the roads AND to the buildings: a level
   * platform under each building and a grassed bank round it. A road keeps the
   * ground it has claimed; a platform takes the rest.
   */
  /** The buildings' platforms as last worked out, reused while a stroke is held. */
  let padsCache: ReturnType<typeof buildingPads> | null = null;
  /** Each building's platform by record, while the roads and the land stand (`buildingPads`). */
  let padsKnown = new WeakMap<Building, Pad | null>();
  /** The buildings the ground was last graded for, by id: their record then, and the box their bank reaches. */
  const graded = new Map<number, { ref: Building; box: readonly [number, number, number, number] }>();
  const bankBox = (b: Building): readonly [number, number, number, number] => {
    const r = buildingBounds(b, TERRAIN_CELL * 1.5 + m(40) + TERRAIN_CELL);
    return [r.minX, r.minY, r.maxX, r.maxY];
  };
  /**
   * What changed among the buildings since the ground was graded: the box
   * of every site added, removed or changed (a record is replaced on any
   * change), or null when none did.
   */
  const changedSites = (doc: RoadDoc): [number, number, number, number] | null => {
    let box: [number, number, number, number] | null = null;
    const take = (q: readonly [number, number, number, number]): void => {
      box = box ? [Math.min(box[0], q[0]), Math.min(box[1], q[1]), Math.max(box[2], q[2]), Math.max(box[3], q[3])] : [...q];
    };
    const seen = new Set<number>();
    for (const b of doc.buildings.all()) {
      seen.add(b.id);
      const was = graded.get(b.id);
      if (was?.ref === b) continue;
      if (was) take(was.box);
      const now = bankBox(b);
      take(now);
      graded.set(b.id, { ref: b, box: now });
    }
    for (const [id, was] of graded) if (!seen.has(id)) { take(was.box); graded.delete(id); }
    return box;
  };
  /**
   * Where two solves of the roads differ: the blocks of the map whose roads
   * (their lines, heights, widths) are not the same, from the solve's own
   * per-area digest. A street drawn changes a few blocks; a road whose reach
   * spans the whole map changes every block, and the whole ground is cut and
   * filled again, as before.
   */
  const SHAPE_BLOCK = 160;
  const changedBlocks = (before: RoadElevation, after: RoadElevation): [number, number, number, number][] => {
    const out: [number, number, number, number][] = [];
    const half = MAP_SIZE / 2;
    for (let x = -half; x < half; x += SHAPE_BLOCK) {
      for (let y = -half; y < half; y += SHAPE_BLOCK) {
        const x1 = x + SHAPE_BLOCK, y1 = y + SHAPE_BLOCK;
        if (before.digest(x, y, x1, y1) !== after.digest(x, y, x1, y1)) out.push([x, y, x1, y1]);
      }
    }
    return out;
  };
  /** A world box as the terrain grid corners it covers. */
  const terrainRegion = (box: readonly [number, number, number, number]): TerrainRegion => {
    const last = MAP_SIZE / TERRAIN_CELL;
    const clamp = (v: number): number => Math.max(0, Math.min(last, v));
    return [
      clamp(Math.floor((box[0] + TERRAIN_HALF) / TERRAIN_CELL)), clamp(Math.ceil((box[2] + TERRAIN_HALF) / TERRAIN_CELL)),
      clamp(Math.floor((TERRAIN_HALF - box[3]) / TERRAIN_CELL)), clamp(Math.ceil((TERRAIN_HALF - box[1]) / TERRAIN_CELL)),
    ];
  };
  /**
   * `region`: a brush dab while the stroke is held - only the ground under it
   * is cut and filled again, against the platforms as they stood when the
   * stroke began; the rest waits for the stroke to end (`settle`).
   */
  /**
   * The ground cut and filled again only in `blocks` (the roads changed
   * there, the land did not): the platforms of the buildings whose banks
   * reach them are worked out again - their floors read the footway - and
   * every block is re-shaped on its own.
   */
  const shapeBlocks = (net: Network, blocks: readonly [number, number, number, number][]): void => {
    const touches = (q: readonly [number, number, number, number]): boolean =>
      blocks.some((b) => q[0] <= b[2] && q[2] >= b[0] && q[1] <= b[3] && q[3] >= b[1]);
    for (const b of net.doc.buildings.all()) if (touches(bankBox(b))) padsKnown.delete(b);
    groundVersion++;
    gradedFor = net.doc.buildings.revision;
    changedSites(net.doc);
    padsCache = net.doc.buildings.size > 0
      ? buildingPads(net.doc.buildings.all(), terrain.naturalRenderedHeightAt, pavedHeightAt, TERRAIN_CELL * 1.5, padsKnown)
      : null;
    for (const block of blocks) shapeGround(net, terrainRegion(block), false, true);
  };

  const shapeGround = (net: Network, region: TerrainRegion | null = null, sites = false, padsReady = false): void => {
    const roads = net.doc.segments.size > 0 ? elevation : null;
    if (!padsReady && (!region || !padsCache || sites)) {
      gradedFor = net.doc.buildings.revision;
      if (!sites) {
        // The roads or the land moved: every platform is worked out afresh.
        padsKnown = new WeakMap();
        graded.clear();
        changedSites(net.doc);
      }
      groundVersion++;
      padsCache = net.doc.buildings.size > 0
        ? buildingPads(net.doc.buildings.all(), terrain.naturalRenderedHeightAt, pavedHeightAt, TERRAIN_CELL * 1.5, padsKnown)
        : null;
    }
    const pads = net.doc.buildings.size > 0 ? padsCache : null;
    if (!pads) {
      terrain.shapeToRoads(roads, region);
      return;
    }
    terrain.shapeToRoads({
      shapeBounds: () => [...(roads?.shapeBounds() ?? []), ...pads.shapeBounds()],
      shapeAt(x, y, ground) {
        const road = roads ? roads.shapeAt(x, y, ground) : { height: ground, weight: 0 };
        const pad = pads.shapeAt(x, y, ground);
        if (pad.weight <= 0) return road;
        if (road.weight <= 0) return pad;
        return { height: pad.height + (road.height - pad.height) * road.weight, weight: 1 };
      },
    }, region);
  };

  /** `doc.utilityRevision` the pole layer was last built at. */
  let utilityRevision = -1;
  /**
   * The pole layer alone, on its own revision: a pole edit moves only
   * `doc.utilityRevision` (see `RoadDoc`), so it rebuilds this and nothing else.
   */
  const rebuildUtilities = (net: Network): void => {
    if (!elevation) return;
    utilityRevision = net.doc.utilityRevision;
    if (utilities) {
      builtTriangles -= utilities.triangles;
      world.remove(utilities.group);
      utilities.dispose();
    }
    utilities = buildUtilities(net, poleGroundAt(elevation, terrain.renderedHeightAt), sceneryKit);
    world.add(utilities.group);
    builtTriangles += utilities.triangles;
    rebuildFurniture(net);
  };

  /** The landscaping layer, rebuilt with the poles: it moves the same revision. */
  /** The city hour the plants were last sized at (`plantGrowth`). */
  let growthHour = Number.NaN;
  let cityMinutes = Number.NaN;
  const rebuildFurniture = (net: Network): void => {
    growthHour = Math.floor(cityMinutes / 60);
    if (!elevation) return;
    if (furniture) {
      builtTriangles -= furniture.triangles;
      for (const mesh of furniture.meshes) world.remove(mesh);
      world.remove(furniture.grass);
      furniture.dispose();
    }
    furniture = buildStreetFurniture(net, elevation, sceneryKit, terrain.renderedHeightAt, cityMinutes);
    if (signs) { world.remove(signs.group); signs.dispose(); }
    signs = buildSigns(net, elevation, net.doc.landscape.values());
    world.add(signs.group);
    for (const mesh of furniture.meshes) world.add(mesh);
    world.add(furniture.grass);
    builtTriangles += furniture.triangles;
  };

  const rebuildWorld = (net: Network): void => {
    if (networkRevision === net.revision && terrainRevision === net.doc.terrainRevision) {
      if (utilityRevision !== net.doc.utilityRevision) rebuildUtilities(net);
      return;
    }
    const started = performance.now();
    // Only the roads changed (the land did not): the ground is cut and filled
    // again only where the solve of the roads differs.
    const landStill = terrainRevision === net.doc.terrainRevision && elevation !== null;
    const previousElevation = elevation;
    networkRevision = net.revision;
    terrainRevision = net.doc.terrainRevision;

    roads?.dispose();
    details?.dispose();
    scenery?.dispose();
    furniture?.dispose();
    furniture = null;
    utilities?.dispose();
    for (const mesh of scenery?.meshes ?? []) world.remove(mesh);
    if (scenery) world.remove(scenery.grass);
    world.clear();

    // ONE solve for the whole network, shared by every consumer below. Solving
    // it per structure, or per band, is how two surfaces came to disagree about
    // where the same junction was.
    //
    // Against the NATURAL ground, never the shaped one: the terrain is about to
    // be cut and filled to meet these roads, and feeding the next solve its own
    // previous answer would let the two drift a little further apart on every
    // rebuild.
    elevation = buildRoadElevation(net, terrain.naturalRenderedHeightAt);
    // Now the ground comes to meet the roads: embankments and cuttings instead
    // of the vertical face the verge skirt used to hang off its own edge, and —
    // from the same rule, where a road is buried deeply enough — tunnels.
    // A street drawn re-shaped the whole map (a seventh of a second on a
    // small town); now only the blocks its solve changed.
    const blocks = landStill && previousElevation && padsCache ? changedBlocks(previousElevation, elevation) : null;
    if (blocks && blocks.length * SHAPE_BLOCK * SHAPE_BLOCK < MAP_SIZE * MAP_SIZE * 0.25) {
      if (blocks.length) shapeBlocks(net, blocks);
    } else shapeGround(net);

    roads = buildRoadSurfaces(net, elevation, materials, terrain.renderedHeightAt, surfaceReuse, terrain.vergeMaterial);
    world.add(roads.group);

    details = buildStructureDetails(net, elevation, terrain.renderedHeightAt, materials);
    world.add(details.group);

    scenery = buildScenery(
      net,
      elevation,
      terrain.renderedHeightAt,
      terrain.wetAt,
      { grass: quality.grass },
      sceneryKit,
    );
    for (const mesh of scenery.meshes) world.add(mesh);
    world.add(scenery.grass);

    // The overhead utility network. It is drawn from the document directly
    // rather than from the Network, because a pole line is not derived from
    // the roads - it can be drawn across open ground with no road near it.
    //
    // But a pole that IS beside a road stands on the FOOTWAY, not on the
    // ground beside it. The terrain is shaped to meet the road, so the two
    // differ only by the kerb - and a pole sunk 0.36 into the pavement it is
    // meant to stand on is exactly the "poles do not sit on the footway"
    // complaint. The lamp columns in `scenery.ts` already do this; the poles
    // were the one piece of street furniture reading the bare ground.
    utilities = buildUtilities(net, poleGroundAt(elevation, terrain.renderedHeightAt), sceneryKit);
    world.add(utilities.group);
    utilityRevision = net.doc.utilityRevision;

    builtTriangles =
      roads.triangles + details.triangles + scenery.triangles + utilities.triangles;
    rebuildFurniture(net);
    rebuildMs = performance.now() - started;
    rebuilds++;
  };

  /**
   * The road shaders compiled before the first road is drawn. Each material
   * compiles its program the first time something uses it, and that is a
   * stall of the frame it happens in - the first road on an empty map froze
   * the game for most of a second (the profile of 2026-10-05: 0.8 s in
   * `getProgramInfoLog`). Engines warm their shaders ahead for this (three's
   * `compileAsync`, with KHR_parallel_shader_compile; Unreal's PSO cache):
   * a small junction is built off-screen with the very builders and shared
   * materials of `rebuildWorld`, compiled in the background, and thrown away.
   */
  let roadShadersWarm: 'no' | 'started' = 'no';
  const warmRoadShaders = (): void => {
    if (roadShadersWarm !== 'no') return;
    roadShadersWarm = 'started';
    try {
      const doc = new RoadDoc();
      const centre = doc.addNode({ x: 0, y: 0 });
      // Each class of road, a junction and a pedestrian crossing on one leg.
      [[m(70), 0, 0], [-m(70), 0, 1], [0, m(70), 2], [0, -m(70), 3]].forEach(([x, y, type]) => {
        doc.addSegment(doc.addNode({ x: x!, y: y! }).id, centre.id, type!);
      });
      const pole1 = doc.addPole({ x: m(20), y: m(12) }, true);
      const pole2 = doc.addPole({ x: m(50), y: m(12) }, false);
      doc.addPoleSpan(pole1.id, pole2.id);
      const warmNet = new Network(doc);
      warmNet.rebuild();
      const flat = (): number => 0;
      const warmElevation = buildRoadElevation(warmNet, flat);
      const group = new Group();
      const parts = [
        buildRoadSurfaces(warmNet, warmElevation, materials, flat, undefined, terrain.vergeMaterial),
        buildStructureDetails(warmNet, warmElevation, flat, materials),
        buildUtilities(warmNet, poleGroundAt(warmElevation, flat), sceneryKit),
      ];
      for (const part of parts) group.add(part.group);
      const plants = buildScenery(warmNet, warmElevation, flat, () => false, { grass: quality.grass }, sceneryKit);
      for (const mesh of plants.meshes) group.add(mesh);
      group.add(plants.grass);
      void compileAhead(group).then(() => {
        for (const part of parts) part.dispose();
        plants.dispose();
      });
    } catch (error) {
      console.warn('road shader warm-up skipped', error);
    }
  };

  /**
   * The shaders a blow first needs - a broken building's pieces (its kit's
   * materials on plain meshes), the explosion's debris, soot, fire and spray -
   * compiled ahead, in the background: compiled when the first blow landed,
   * they stalled that frame for most of a second.
   */
  let blastShadersWarm = false;
  const warmBlastShaders = (): void => {
    if (blastShadersWarm) return;
    blastShadersWarm = true;
    const kit = buildings.kit;
    const tiny = new BufferGeometry();
    tiny.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    tiny.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    tiny.setAttribute('color', new Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    tiny.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    tiny.setAttribute('aDecay', new Float32BufferAttribute([0, 0, 0], 1));
    const group = new Group();
    const mats = [...Object.values(kit.shell), ...Object.values(kit.material), kit.furniture().material];
    for (const mat of mats) {
      const mesh = new Mesh(tiny, mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      group.add(mesh);
    }
    // In the scene for its lights, but never drawn: drawn before the parallel
    // compile was done, each of these meshes stalled its frame waiting for
    // its program (3.4 s of stalls on an empty map, the profile of
    // 2026-10-05) - the very stall the warm-up is for. `compile` reads hidden
    // objects too.
    group.visible = false;
    scene.add(group);
    void compileAhead(group).then(() => { scene.remove(group); tiny.dispose(); });
    void compileAhead(blast.group);
  };

  const applyQuality = (level: QualityLevel): void => {
    quality = QUALITY[level];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
    renderer.shadowMap.enabled = quality.shadows;
    materials.setDetail(quality.surfaceDetail);
    environment.setQuality({ shadows: quality.shadows, shadowMapSize: quality.shadowMapSize });
    post?.dispose();
    post = createPostChain(renderer, scene, rig.camera, quality, level);
    post.setNight(Math.max(0, lastDark));
    resize();
    // Vegetation density is baked into the instanced meshes, so it only takes
    // effect on the next rebuild. Forcing one here keeps the tier honest.
    networkRevision = -1;
  };

  let post: PostChain = createPostChain(renderer, scene, rig.camera, quality, governor.current);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));

  function resize(): void {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    rig.resize(width, height);
    post.setSize(width, height, renderer.getPixelRatio());
  }
  resize();

  const target = new Vector3();
  let fps = 60;
  /** Wall-clock seconds, for the wind; independent of the simulation speed. */
  let windClock = 0;
  let lastWidth = 0;
  let lastHeight = 0;

  // Development only: the production build replaces the flag with false and
  // drops the inspector with it.
  const inspect = import.meta.env.DEV ? createInspector(renderer, scene) : null;
  let lotOverlay: ReturnType<typeof createLotOverlay> | null = null;
  const occupantQueue: Occupant[] = [];
  let transitXray = false;
  let transitPreview: ReturnType<typeof buildTrackPreview> | null = null;
  let transitPreviewKey = '';

  const handle: SceneHandle = {
    inspect,
    census: () => agents.census(),
    backend: 'three-webgl',
    viewport: rig.viewport,
    scene,
    gl: renderer,
    get stats(): RenderStats {
      return {
        triangles: builtTriangles + buildings.triangles,
        drawCalls: renderer.info.render.calls,
        quality: governor.current,
        fps: Math.round(fps),
        rebuildMs: Math.round(rebuildMs),
        roadTiles: roads ? { built: roads.built, reused: roads.reused } : { built: 0, reused: 0 },
        rebuilds,
        terrainMs: Math.round(terrainMs),
      };
    },
    terrainHeightAt(x, y) {
      return terrain.renderedHeightAt(x, y);
    },
    surfaceHeightAt(x, y) {
      const ground = terrain.renderedHeightAt(x, y);
      if (!elevation) return ground;
      let top = ground;
      // The road at grade and the decks are asked apart: where an overpass
      // crosses a street, the street's centreline is the nearer of the two.
      for (const set of SURFACE_SETS) {
        if (!elevation.has(set)) continue;
        const road = elevation.roadAt(x, y, set);
        if (road.type < 0 || Math.abs(road.across) > road.half) continue;
        top = Math.max(top, elevation.at(x, y, set));
      }
      return top;
    },
    pavedHeightAt,
    setBuildingPreview(preview) {
      buildings.setPreview(preview);
    },
    strikeBuilding(b, x, y, z, strength) {
      // The building's own floor, as it is drawn on its pad.
      const floor = floorHeight(b, terrain.naturalRenderedHeightAt, pavedHeightAt);
      const down = destruction.hit(b, floor, x, y, z, strength, rig.camera.getWorldDirection(new Vector3()));
      buildings.setRuined(destruction.ruined);
      return down;
    },
    strikeGround(x, y, strength) {
      for (let k = 0; k < 6 + strength * 2; k++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * m(0.6 + strength * 0.25);
        wear.wheels(x + Math.cos(a) * r, y + Math.sin(a) * r, a, 0.01, 30);
      }
      wear.tick(10);
      exhaust.burst(x, y, terrain.renderedHeightAt(x, y), 20 + strength * 6, 1, m(1 + strength * 0.4), m(3), 5);
    },
    explode(x, y, z, radius, hit) {
      const ground = (px: number, py: number): number => ragdollWorld.groundAt(px, py);
      blast.explode(x, y, z, radius, hit.ground);
      if (hit.crater && hit.ground !== 'building') blast.crater(x, y, ground(x, y), radius * 0.75, hit.ground);
      const away = (px: number, py: number, k: number): Vector3 => {
        const dx = px - x, dy = py - y, d = Math.hypot(dx, dy) || 1;
        const f = k * Math.max(0.25, 1 - d / (radius * 1.6));
        return new Vector3((dx / d) * f, f * 0.6, -(dy / d) * f);
      };
      const wood = 0x5e4630;
      for (const pole of hit.poles) {
        const g = ground(pole.x, pole.y);
        const r = m(0.15);
        const top = new Vector3(pole.x, g + POLE_HEIGHT - POLE_ARM_DROP, -pole.y);
        // Falls the way it is thrown: a turn about the horizontal axis across that way.
        const axis = new Vector3(-pole.dirY, 0, -pole.dirX).normalize();
        const push = away(pole.x, pole.y, m(5));
        if (pole.mode === 'whole') {
          blast.debris({ shape: 'cylinder', kind: 'wood', color: wood, at: new Vector3(pole.x, g + POLE_HEIGHT / 2 + m(0.05), -pole.y),
            size: new Vector3(r, POLE_HEIGHT, r), velocity: push.clone().multiplyScalar(0.4), spin: axis.clone().multiplyScalar(0.9 + Math.random() * 0.6) });
        } else if (pole.mode === 'snap') {
          // Snapped: the stump left standing, the top thrown over.
          const cut = POLE_HEIGHT * (0.25 + Math.random() * 0.3);
          blast.debris({ shape: 'cylinder', kind: 'wood', color: wood, at: new Vector3(pole.x, g + cut / 2, -pole.y),
            size: new Vector3(r * 1.1, cut, r * 1.1), velocity: new Vector3(), spin: new Vector3() });
          blast.debris({ shape: 'cylinder', kind: 'wood', color: wood, at: new Vector3(pole.x, g + cut + (POLE_HEIGHT - cut) / 2 + m(0.1), -pole.y),
            size: new Vector3(r, POLE_HEIGHT - cut, r), velocity: push.clone().multiplyScalar(0.7), spin: axis.clone().multiplyScalar(1.5 + Math.random()) });
        } else {
          // To splinters: pieces of it flung out.
          let h = 0;
          while (h < POLE_HEIGHT - m(0.5)) {
            const l = Math.min(POLE_HEIGHT - h, m(1 + Math.random() * 2.5));
            blast.debris({ shape: 'cylinder', kind: 'wood', color: wood, at: new Vector3(pole.x, g + h + l / 2, -pole.y),
              size: new Vector3(r * (0.6 + Math.random() * 0.4), l, r * (0.6 + Math.random() * 0.4)),
              velocity: push.clone().multiplyScalar(0.8 + Math.random()).add(new Vector3((Math.random() - 0.5) * m(4), m(2 + Math.random() * 4), (Math.random() - 0.5) * m(4))) });
            h += l;
          }
        }
        // The cross-arm and the lamp, knocked off.
        blast.debris({ shape: 'box', kind: 'wood', color: wood, at: top.clone(), size: new Vector3(POLE_ARM_HALF * 2, m(0.1), m(0.1)),
          velocity: push.clone().add(new Vector3(0, m(2), 0)) });
        if (pole.lamp) blast.debris({ shape: 'box', kind: 'metal', at: top.clone().add(new Vector3(POLE_LAMP_REACH * 0.5, 0, 0)), size: new Vector3(m(0.5), m(0.14), m(0.26)), velocity: push.clone().multiplyScalar(1.2) });
        // A flash and sparks off the line as it goes.
        blast.arc(top, 1.5 + Math.random() * 2);
      }
      for (const w of hit.wires) {
        const g = ground(w.fromX, w.fromY);
        const gt = ground(w.toX, w.toY);
        const dx = w.toX - w.fromX, dy = w.toY - w.fromY, d = Math.hypot(dx, dy) || 1;
        for (const offset of [-0.8, 0, 0.8]) {
          const side = new Vector3(-dy / d, 0, -dx / d).multiplyScalar(offset * POLE_ARM_HALF);
          const from = new Vector3(w.fromX, g + POLE_HEIGHT - POLE_ARM_DROP, -w.fromY).add(side);
          const to = new Vector3(w.toX, gt + POLE_HEIGHT * 0.6, -w.toY).add(side);
          blast.wire(from, to, away(w.toX, w.toY, m(3)));
        }
      }
      for (const post of hit.posts) {
        const g = ground(post.x, post.y);
        const push = away(post.x, post.y, m(5));
        const axis = new Vector3(push.z, 0, -push.x).normalize();
        blast.debris({ shape: 'cylinder', kind: 'metal', color: 0x2a2d31, at: new Vector3(post.x, g + m(3.1) + m(0.05), -post.y),
          size: new Vector3(m(0.165), m(6.2), m(0.165)), velocity: push.clone().multiplyScalar(0.3), spin: axis.multiplyScalar(1.2) });
        const head = new Vector3(post.x + Math.cos(post.yaw) * m(3), g + m(5.5), -(post.y + Math.sin(post.yaw) * m(3)));
        blast.debris({ shape: 'box', kind: 'metal', color: 0x1b1d20, at: head, size: new Vector3(m(0.35), m(1.0), m(0.35)), velocity: push.clone().add(new Vector3(0, m(3), 0)) });
        blast.debris({ shape: 'cylinder', kind: 'metal', color: 0x2a2d31, at: head.clone().lerp(new Vector3(post.x, g + m(5.9), -post.y), 0.5),
          size: new Vector3(m(0.06), m(3.5), m(0.06)), turn: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2), velocity: push.clone() });
        blast.arc(head, 1 + Math.random() * 2);
      }
      for (const v of hit.vehicles) {
        const g = ground(v.x, v.y);
        const push = away(v.x, v.y, m(9)).add(new Vector3(0, m(3), 0));
        const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), v.angle);
        const spin = new Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3);
        // The burnt shell, black but for a scorched trace of its paint, burning; two wheels flying off.
        const charred = new Color(v.color).lerp(new Color(0x1f1b18), 0.95).getHex();
        blast.debris({ shape: 'car', kind: 'char', color: charred, at: new Vector3(v.x, g + v.height * 0.45, -v.y),
          size: new Vector3(v.length, v.height * 0.85, v.width), turn, velocity: push, spin, burn: 30 + Math.random() * 20 });
        for (let k = 0; k < 2; k++) {
          blast.debris({ shape: 'cylinder', kind: 'char', color: 0x141414, at: new Vector3(v.x, g + m(0.35), -v.y),
            size: new Vector3(m(0.32), m(0.22), m(0.32)), turn: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2),
            velocity: push.clone().multiplyScalar(0.6 + Math.random()).add(new Vector3((Math.random() - 0.5) * m(8), m(2 + Math.random() * 4), (Math.random() - 0.5) * m(8))) });
        }
        exhaust.burst(v.x, v.y, g + m(1), 40, 5, m(1.2), m(1.4), 1.0);
      }
      for (const item of hit.items) {
        const g = ground(item.x, item.y);
        const push = away(item.x, item.y, m(6));
        if (item.kind === 'tree') {
          // Split: a broken stump left standing, charred; the top - trunk
          // and crown - torn off at the break and thrown over, burning.
          const tall = m(6 + Math.random() * 3), cut = tall * (0.25 + Math.random() * 0.25);
          const axis = new Vector3(push.z, 0, -push.x).normalize();
          blast.debris({ shape: 'cylinder', kind: 'char', color: 0x2b211a, at: new Vector3(item.x, g + cut / 2, -item.y), size: new Vector3(m(0.22), cut, m(0.22)),
            velocity: new Vector3(), spin: new Vector3() });
          blast.debris({ shape: 'cylinder', kind: 'wood', at: new Vector3(item.x, g + cut + (tall - cut) / 2, -item.y), size: new Vector3(m(0.18), tall - cut, m(0.18)),
            velocity: push.clone().multiplyScalar(0.6), spin: axis.clone().multiplyScalar(1.4 + Math.random()), burn: 12 + Math.random() * 10 });
          // The splinters at the break.
          for (let k = 0; k < 6; k++) {
            blast.debris({ shape: 'box', kind: 'wood', at: new Vector3(item.x, g + cut, -item.y), size: new Vector3(m(0.05), m(0.3 + Math.random() * 0.5), m(0.05)),
              velocity: push.clone().add(new Vector3((Math.random() - 0.5) * m(5), m(2 + Math.random() * 4), (Math.random() - 0.5) * m(5))) });
          }
          // The crown, in clumps of leaves and branches.
          for (let k = 0; k < 24; k++) {
            blast.debris({ shape: 'box', kind: 'leaf', at: new Vector3(item.x, g + tall * 0.85, -item.y), size: new Vector3(m(0.4 + Math.random() * 0.6), m(0.1), m(0.4 + Math.random() * 0.6)),
              velocity: push.clone().add(new Vector3((Math.random() - 0.5) * m(7), m(1 + Math.random() * 5), (Math.random() - 0.5) * m(7))) });
          }
          exhaust.burst(item.x, item.y, g + tall * 0.7, 10, 5, m(1.5), m(1.2), 1);
        } else if (item.kind === 'shrub') {
          const tall = m(1.2);
          blast.debris({ shape: 'cylinder', kind: 'wood', at: new Vector3(item.x, g + tall / 2, -item.y), size: new Vector3(m(0.14), tall, m(0.14)),
            velocity: push.clone().multiplyScalar(0.4), spin: new Vector3(push.z, 0, -push.x).normalize().multiplyScalar(1.2) });
          for (let k = 0; k < 14; k++) {
            blast.debris({ shape: 'box', kind: 'leaf', at: new Vector3(item.x, g + tall * 0.8, -item.y), size: new Vector3(m(0.3), m(0.05), m(0.3)),
              velocity: push.clone().add(new Vector3((Math.random() - 0.5) * m(6), m(2 + Math.random() * 5), (Math.random() - 0.5) * m(6))) });
          }
        } else if (item.kind === 'lamp') {
          // A street light: its column bent over and thrown, the head and its glass flung off, sparks.
          const axis = new Vector3(push.z, 0, -push.x).normalize();
          blast.debris({ shape: 'cylinder', kind: 'metal', color: 0x3a3e43, at: new Vector3(item.x, g + m(3), -item.y), size: new Vector3(m(0.1), m(6), m(0.1)),
            velocity: push.clone().multiplyScalar(0.5), spin: axis.multiplyScalar(1.6) });
          blast.debris({ shape: 'box', kind: 'metal', color: 0x2a2d31, at: new Vector3(item.x, g + m(6), -item.y), size: new Vector3(m(0.6), m(0.15), m(0.3)),
            velocity: push.clone().add(new Vector3(0, m(4), 0)) });
          exhaust.burst(item.x, item.y, g + m(6), 30, 6, m(0.3), m(0.12), 0.8);
        } else {
          for (let k = 0; k < 4; k++) {
            blast.debris({ shape: 'box', kind: item.kind === 'bench' ? 'wood' : 'metal', at: new Vector3(item.x, g + m(0.5), -item.y),
              size: new Vector3(m(0.2 + Math.random() * 0.5), m(0.06 + Math.random() * 0.2), m(0.1 + Math.random() * 0.3)),
              velocity: push.clone().add(new Vector3((Math.random() - 0.5) * m(4), m(2 + Math.random() * 5), (Math.random() - 0.5) * m(4))) });
          }
        }
      }
    },
    burn: (x, y, z, size, seconds) => blast.burn(x, y, z, size, seconds),
    soot: (x, y, z, r) => blast.soot(x, y, z, r),
    geyser: (x, y, z, seconds) => blast.geyser(x, y, z, seconds),
    sparkAt: (x, y, z, seconds) => blast.arc(new Vector3(x, z, -y), seconds),
    leak: (x, y, z, seconds) => blast.leak(x, y, z, seconds),
    onBuildingDown: (listener) => { destruction.onDown = listener; },
    flingOccupants: (list) => { occupantQueue.push(...list); },
    setSmog: (k) => environment.setSmog(k),
    busy: () => blast.active() || ragdolls.stats().living > 0 || ragdolls.stats().moving > 0,
    forgetRuin(id) {
      void id;
      buildings.setRuined(destruction.ruined);
    },
    setTransitXray(on) {
      transitXray = on;
      transit?.setXray(on);
    },
    setTransitPreview(preview) {
      const key = preview ? `${preview.mode}:${preview.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';')}` : '';
      if (key === transitPreviewKey) return;
      transitPreviewKey = key;
      if (transitPreview) { world.remove(transitPreview.group); transitPreview.dispose(); transitPreview = null; }
      if (preview && preview.points.length >= 2) {
        transitPreview = buildTrackPreview(preview.points, preview.mode, terrain.renderedHeightAt, pavedHeightAt);
        world.add(transitPreview.group);
      }
    },
    setLotOverlay(input) {
      lotOverlay ??= createLotOverlay(scene, (x, y) => handle.surfaceHeightAt(x, y));
      lotOverlay.set(input);
    },
    setPolePreview(net, preview) {
      const key = preview && elevation
        ? `${net.revision}:${preview.poles.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${+p.lamp},${+p.standing}`).join(';')}`
        : '';
      if (key === polePreviewKey) return;
      polePreviewKey = key;
      if (polePreview) {
        world.remove(polePreview.group);
        polePreview.dispose();
        polePreview = null;
      }
      if (!preview || !elevation || preview.poles.length === 0) return;
      polePreview = buildPolePreview(net, poleGroundAt(elevation, terrain.renderedHeightAt), sceneryKit, preview);
      world.add(polePreview.group);
    },
    setPerspective(on) {
      if (on === rig.perspective) return;
      rig.setPerspective(on);
      // The passes hold the camera they were made with.
      post.dispose();
      post = createPostChain(renderer, scene, rig.camera, quality, governor.current);
      post.setNight(Math.max(0, lastDark));
      resize();
      onAssetsReady();
    },
    setSkyMode(mode) {
      // Read by the next frame drawn.
      skyMode = mode;
    },
    setBuildingCutaway(spec) {
      buildings.setCutaway(spec);
      cutSpec = spec;
    },
    setBuildingsDimmed(except) {
      buildings.setDimmed(except === undefined ? undefined : (except as BuildingId | null));
    },
    elevationAt(x, y, structure) {
      if (!elevation) return terrain.renderedHeightAt(x, y);
      return elevation.at(x, y, structure ? new Set([structure]) : undefined);
    },
    resize,
    // Wall-clock time between drawn frames, for things that age as they are watched.
    draw(net, sim, alpha, delta, options) {
      renderer.info.reset();
      // Planted trees and shrubs grow with the city's clock: resized once a city hour.
      cityMinutes = sim.city.minutes(sim);
      if (Math.floor(cityMinutes / 60) !== growthHour && [...net.doc.landscape.values()].some((i) => i.planted !== undefined && cityMinutes - i.planted < GROW_MINUTES + 60)) rebuildFurniture(net);
      const wallNow = performance.now();
      const wallDt = lastWall < 0 ? 0 : Math.min(0.1, (wallNow - lastWall) / 1000);
      lastWall = wallNow;
      if (canvas.clientWidth !== lastWidth || canvas.clientHeight !== lastHeight) {
        lastWidth = canvas.clientWidth;
        lastHeight = canvas.clientHeight;
        resize();
      }
      const terrainStarted = performance.now();
      const stroking = !!options?.holdRoads && !!elevation && networkRevision === net.revision;
      const groundMoved = terrain.update(net.doc, stroking);
      terrain.updatePaint(net.doc);
      // A brush stroke in progress: every dab used to re-solve the whole road
      // network and re-mesh every road, tree and tuft of grass near it - 450 ms
      // a dab on the player map, so painting was a slideshow. While the stroke
      // is held only the ground follows the brush, cut and filled to the roads
      // as they already stand; the roads catch up once, when it ends.
      if (stroking) {
        if (groundMoved) {
          shapeGround(net, terrain.lastRegion);
          terrainMs = performance.now() - terrainStarted;
        }
      } else {
        rebuildWorld(net);
        terrain.settle();
      }
      // A building placed, moved or reshaped grades its own site.
      // Only the ground round the sites that changed is graded again (growing
      // a building re-graded the whole map and every platform: a hitch for
      // every building the zones grew, the profile of 2026-10-05).
      if (gradedFor !== net.doc.buildings.revision) {
        gradedFor = net.doc.buildings.revision;
        const changed = changedSites(net.doc);
        if (changed) shapeGround(net, terrainRegion(changed), true);
      }
      // The buildings follow the ground once a stroke is over, not on every
      // dab of it: re-grading 600 buildings per dab took seconds a dab.
      if (!stroking) buildingGround = `${net.doc.terrainRevision}:${rebuilds}`;
      buildings.update(net.doc, terrain.renderedHeightAt, buildingGround, pavedHeightAt, terrain.naturalRenderedHeightAt);
      // The plants under a building's footprints: only a changed site moves them.
      if (scenery && (excludedFor.scenery !== scenery || excludedFor.site !== String(groundVersion))) {
        scenery.exclude(net.doc.buildings.size > 0 ? buildings.covers : null);
        excludedFor = { scenery, site: String(groundVersion) };
      }
      // Walls, fences and hedges: on their own revision, and on the ground they stand on.
      const barrierKey = `${net.doc.barrierRevision}:${groundVersion}:${net.doc.terrainRevision}:${rebuilds}`;
      if (barrierKey !== barriersFor) {
        barriersFor = barrierKey;
        if (barriers) {
          builtTriangles -= barriers.triangles;
          world.remove(barriers.group);
          barriers.dispose();
        }
        barriers = buildBarriers(net.doc, terrain.renderedHeightAt);
        world.add(barriers.group);
        builtTriangles += barriers.triangles;
      }
      // Public transport: tracks, stations, stops (`transit.ts`), on its own revision.
      const transitKey = `${net.doc.transitRevision}:${groundVersion}:${net.doc.terrainRevision}:${rebuilds}`;
      if (transitKey !== transitFor) {
        transitFor = transitKey;
        if (transit) {
          builtTriangles -= transit.triangles;
          world.remove(transit.group);
          transit.dispose();
        }
        // A metro entrance stands off the streets and out of the buildings.
        const solids = [...net.doc.buildings.all()].flatMap((b) => solidFootprints(b));
        transit = buildTransit(net.doc, terrain.renderedHeightAt, pavedHeightAt,
          (p) => onCarriageway(net, p) || solids.some((ring) => pointInPolygon(p, ring)));
        transit.setXray(transitXray);
        world.add(transit.group);
        builtTriangles += transit.triangles;
      }
      const gardenKey = `${plantSignature(net.doc)}:${groundVersion}:${net.doc.terrainRevision}:${rebuilds}`;
      if (gardenKey !== gardensFor) {
        gardensFor = gardenKey;
        if (gardens) {
          for (const mesh of gardens.meshes) world.remove(mesh);
          gardens.dispose();
        }
        gardens = buildGardens(gardenPlants(net.doc.buildings.all(), terrain.renderedHeightAt), sceneryKit);
        for (const mesh of gardens.meshes) world.add(mesh);
      }
      // Discover new shader variants across frames, including hidden objects
      // that may become visible as the player moves. Three's compileAsync
      // traverses everything passed to it regardless of visibility, so only
      // the representative meshes are submitted, with the real scene supplying
      // lights and environment through its targetScene parameter.
      if (!compiling) {
        if (scanStack.length === 0 && performance.now() - compileCheckedAt > 2000) {
          compileCheckedAt = performance.now();
          scanStack.push(scene);
        }
        for (let n = 0; n < SCAN_PER_FRAME && scanStack.length; n++) {
          const o = scanStack.pop()!;
          const material = (o as Mesh).material as Material | Material[] | undefined;
          if (material) for (const m of Array.isArray(material) ? material : [material]) {
            const mesh = o as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown; isSkinnedMesh?: boolean };
            const variant = mesh.isSkinnedMesh ? 'skinned'
              : mesh.isInstancedMesh ? mesh.instanceColor ? 'instanced-color' : 'instanced'
                : o.type;
            let known = compiledVariants.get(m);
            if (!known) { known = new Set(); compiledVariants.set(m, known); }
            if (!known.has(variant)) { known.add(variant); compileSamples.push(o); }
          }
          for (const child of o.children) scanStack.push(child);
        }
        if (scanStack.length === 0 && compileSamples.length > 0) {
          const warm = new Group();
          for (const sample of compileSamples) warm.add(sample.clone(false));
          compileSamples.length = 0;
          compiling = true;
          // For the target the scene is drawn into (`drainCompiles`).
          const previous = renderer.getRenderTarget();
          renderer.setRenderTarget(post.target);
          void renderer.compileAsync(warm, rig.camera, scene).catch(() => {}).finally(() => {
            warm.clear();
            compiling = false;
          });
          renderer.setRenderTarget(previous);
        }
      }

      const detailed = rig.viewport.zoom >= quality.detailCutoffZoom;
      const plantMap = rig.viewport.zoom < PLANT_MAP_ZOOM;
      // Keep the full facade at street zoom: the planar far mesh loses frames
      // on side-facing windows. Only its thin shadows can disappear earlier.
      buildings.setFar(rig.viewport.zoom < 3);
      buildings.setShadowFar(rig.viewport.zoom < FACADE_SHADOW_ZOOM);
      if (roads) roads.group.visible = true;
      if (details) details.group.visible = true;
      gardens?.setMap(plantMap);
      scenery?.setMap(plantMap);
      furniture?.setMap(plantMap);
      for (const mesh of furniture?.meshes ?? []) {
        mesh.visible = quality.detailProps && detailed && (!plantMap || !mesh.name.endsWith('-leaves'));
      }
      furniture?.setNear(rig.viewport.zoom >= PLANT_NEAR_ZOOM);
      for (const mesh of scenery?.meshes ?? []) {
        mesh.visible = quality.detailProps && detailed && (!plantMap || !mesh.name.endsWith('-leaves'));
      }
      for (const mesh of gardens?.meshes ?? []) {
        mesh.visible = detailed && (!plantMap || !mesh.name.endsWith('-leaves'));
      }
      gardens?.setNear(rig.viewport.zoom >= PLANT_NEAR_ZOOM);
      if (scenery) {
        scenery.grass.visible = quality.detailProps && rig.viewport.zoom >= GRASS_MIN_ZOOM;
        scenery.setNear(rig.viewport.zoom >= PLANT_NEAR_ZOOM);
      }
      // The wind blows in real time: a paused simulation is still a windy day.
      windClock += Math.min(0.1, Math.max(0, delta));
      advanceWind(windClock);

      crowdProjection.multiplyMatrices(rig.camera.projectionMatrix, rig.camera.matrixWorldInverse);
      crowdFrustum.setFromProjectionMatrix(crowdProjection);
      // Plants and street furniture outside the view are not drawn at all.
      scenery?.cull(crowdFrustum, crowdProjection);
      furniture?.cull(crowdFrustum, crowdProjection);
      gardens?.cull(crowdFrustum, crowdProjection);
      transit?.update(sim.city.transit.trains(), terrain.renderedHeightAt);
      agents.sync(sim, alpha, detailed, rig.viewport.zoom, {
        pedestrianDetail: quality.pedestrianDetail,
        pedestrianVisible,
        eye: rig.camera.position,
        vehicleVisible,
        occupantZoom: quality.occupantZoom,
        // Zoomed out past the crowd's band nobody is drawn: the people in
        // the rooms and the lots are not even listed (they were, every frame).
        indoor: detailed ? [...indoors.figures(sim, cutSpec, terrain.naturalRenderedHeightAt, pavedHeightAt),
          ...indoors.yard(sim, terrain.naturalRenderedHeightAt)] : [],
        exhaust: (x, y, z, angle, length, speed, dusty) => {
          exhaust.emit(x, y, z, angle, length, speed, dusty);
          if (!dusty && Math.abs(speed) > 0.5) wear.wheels(x, y, angle, Math.min(length * 0.42, m(1.7)), wallDt);
        },
        ragdolls: (citizens) => {
          ragdollSim = sim;
          ragdolls.absorb(impactCasualties(sim, wallDt), citizens, ragdollWorld);
          if (occupantQueue.length) { ragdolls.fling(occupantQueue, citizens, ragdollWorld); occupantQueue.length = 0; }
          // Somebody tripping on the pavement falls as a ragdoll too.
          ragdollDown.clear();
          for (const ped of sim.pedViews) {
            const g = ped.gesture;
            if (g?.kind !== 'fall') continue;
            ragdollDown.add(ped.id);
            if (g.t < 0.5 && !ragdolls.hides(ped.id)) {
              // Knocked from a point (a punch, a shove): down away from it; else a trip, forwards.
              const away = g.fromX !== undefined && g.fromY !== undefined && Math.hypot(ped.x - g.fromX, ped.y - g.fromY) > 1e-3
                ? Math.atan2(ped.y - g.fromY, ped.x - g.fromX) : null;
              ragdolls.trip(ped.id, ped.heading, citizens, ragdollWorld, away);
            }
          }
          ragdolls.release((id) => ragdollDown.has(id));
          ragdolls.update(wallDt, ragdollWorld);
          ragdolls.draw(citizens, ragdollWorld);
        },
        hiddenPed: (id) => ragdolls.hides(id),
      });
      exhaust.tick(windClock, renderer.domElement.height / 2);
      destruction.update(wallDt);
      casualties.sync(ragdolls.decals);
      blast.update(wallDt, ragdollWorld);
      for (const ped of sim.pedViews) if (ped.v > 0.05) wear.feet(ped.x, ped.y, wallDt);
      wear.tick(wallDt);
      // The rooms cut open are lit from inside: brighter as the day goes.
      const key = cutSpec ? `${cutSpec.level}@${cutSpec.x},${cutSpec.y}:${sim.doc.buildings.revision}` : '';
      if (key !== lampsKey) {
        lampsKey = key;
        const lamps = indoors.lamps(sim, cutSpec, terrain.naturalRenderedHeightAt, pavedHeightAt, ROOM_LIGHTS);
        roomLights.forEach((light, i) => {
          const at = lamps[i];
          light.userData['used'] = !!at;
          if (at) light.position.set(at.x, at.z, -at.y);
        });
      }
      for (const light of roomLights) light.intensity = cutSpec && light.userData['used'] ? 55 * (0.25 + 0.75 * lastDark) : 0;
      signals.sync(sim, detailed);

      target.copy(rig.target);
      const halfHeight = canvas.clientHeight / Math.max(0.001, rig.viewport.zoom * 2);
      const halfWidth = (halfHeight * canvas.clientWidth) / Math.max(1, canvas.clientHeight);
      // The screen's height covers more ground the lower the camera looks: the
      // shadows are fitted to the ground seen, not to the screen.
      // In perspective the far edge of the view takes in more ground than the
      // near: the shadows reach that far too.
      const reach = rig.perspective ? 1.6 : 1;
      const groundHalfDepth = (reach * halfHeight) / Math.max(0.3, Math.sin(rig.viewport.elevation));
      // The top of the tallest building, once per rebuild of the layer: the
      // shadows must reach as high as anything stands, or every terrace and
      // upper floor seen at close zoom lies outside the shadow map, in sun.
      if (tallestFor !== buildings.version) {
        tallestFor = buildings.version;
        tallestBox.setFromObject(buildings.group);
        tallestTop = tallestBox.isEmpty() ? 0 : tallestBox.max.y;
      }
      // The windows of the rooms people are in, and awake in, are lit; the rest
      // are dark (`buildings/lightSlots.ts`). Once a second of play is enough.
      if (performance.now() - litAt > 1000) {
        litAt = performance.now();
        updateLitRooms(sim);
      }
      // Day and night, by the residents' clock (`sim/city`).
      const clock = skyMode === 'day' ? 13 * 60 : skyMode === 'night' ? 22 * 60 : sim.city.minutes(sim);
      const dark = environment.setTimeOfDay(clock);
      if (Math.abs(dark - lastDark) > 0.01) {
        lastDark = dark;
        post.setNight(dark);
        buildings.setNight(dark);
        sceneryKit.setNight(dark);
        agents.setNight(dark);
      }
      rig.camera.getWorldDirection(viewDirection);
      environment.follow(target, halfWidth, groundHalfDepth, viewDirection, Math.max(0, tallestTop - target.y));
      // What the simulation must show in full: people step round each other
      // only where they are seen, and big enough to see it (`SimWorld.focus`).
      sim.focus = {
        x: target.x,
        y: -target.z,
        r: Math.hypot(halfWidth, groundHalfDepth) + m(20),
        detail: rig.viewport.zoom * m(1.7) >= 10,
      };

      renderer.shadowMap.needsUpdate = true;
      // Cheap (a few hundred objects), and it follows meshes a rebuild or an
      // asset load adds, and instance colours created on first use.
      if (renderer.shadowMap.enabled) assignShadowDepth(scene);
      // An explosion shakes the camera for a moment.
      const shake = blast.shake();
      if (shake > 0) {
        shakeOffset.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
        rig.camera.position.add(shakeOffset);
        rig.camera.updateMatrixWorld();
      }
      post.render(delta);
      if (shake > 0) { rig.camera.position.sub(shakeOffset); rig.camera.updateMatrixWorld(); }
      // One waiting texture a frame to the GPU, before anybody draws it.
      drainUploads(renderer, 1);
      drainCompiles(renderer, rig.camera, scene, post.target);
      // From the second frame on, the compiler answers: warm the road shaders.
      warmRoadShaders();
      warmBlastShaders();
      // One waiting body's geometry a frame to the GPU, before anybody draws it.
      drainWarm(renderer, rig.camera, scene, post.target);

      if (delta > 0) fps = fps * 0.9 + (1 / Math.min(1, delta)) * 0.1;
    },
    setQuality(level) {
      requested = level;
      const resolved = level === 'auto' ? governor.current : level;
      governor.set(resolved);
      applyQuality(resolved);
    },
    get quality() {
      return requested;
    },
    dispose() {
      agents.dispose();
      signals.dispose();
      buildings.dispose();
      roads?.dispose();
      for (const paint of surfaceReuse.paint.values()) paint.dispose();
      details?.dispose();
      scenery?.dispose();
      furniture?.dispose();
      gardens?.dispose();
      sceneryKit.dispose();
      terrain.dispose();
      materials.dispose();
      environment.dispose();
      post.dispose();
      lotOverlay?.dispose();
      renderer.dispose();
    },
  };
  return handle;
}
