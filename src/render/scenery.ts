import { plantGrowth } from '@world/landscape';
import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  SRGBColorSpace,
  DynamicDrawUsage,
  Frustum,
  InstancedMesh,
  Matrix4,
  Sphere,
  Vector3,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
  Group,
  type Material,
  type MeshDepthMaterial,
} from 'three';

import { Rng } from '@core/rng';
import { angleOf } from '@core/vec2';
import type { Network } from '@world/network';
import type { RoadElevation } from '@world/elevation';
import { streetFurniture, type FurnitureItem, type FurnitureKind } from '@world/streetFurniture';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { m } from '@world/units';
import { buildGrass, type GrassField } from './grass';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';
import {
  BUSH_KINDS,
  TREE_SPECIES,
  benchGeometry,
  binGeometry,
  bushGeometry,
  grassTuftGeometry,
  hydrantGeometry,
  lampGeometry,
  lampLensGeometry,
  LAMP_OUTREACH,
  postboxGeometry,
  phoneGeometry,
  drainGeometry,
  treeGeometry,
  treePitGeometry,
  trianglesOf,
  wildflowerGeometry,
  type BushKind,
  type TreeSpecies,
} from './propGeometry';

export { LAMP_HEIGHT, LAMP_OUTREACH } from './propGeometry';

/**
 * Everything standing on the ground that is not a road: street furniture,
 * street trees, vegetation and grass.
 *
 * There used to be a gantry arch at every map-edge stub, to mark where traffic
 * entered. It was a piece of scenery nobody asked for standing in the middle of
 * open country, and it is gone: a road that ends simply ends.
 *
 * Vegetation is here for a reason beyond decoration. An isometric view of an
 * open plain gives the eye nothing to judge distance or scale by, so the scene
 * reads as a flat map however good the ground material is. Objects of a KNOWN
 * height, scattered at a known density, are what turn the same image into a
 * landscape: they cast shadows across the terrain, they occlude one another with
 * distance, and they make a hill's far side legible.
 *
 * WHERE the furniture stands is not decided here: `world/streetFurniture.ts`
 * owns the layout, because the pedestrians have to walk around the same list.
 *
 * Everything is instanced — one draw call per model, whatever the count — and
 * every mesh carries a real bounding sphere so the frustum can reject it.
 * Models and materials live in a `SceneryKit` built once; a rebuild only
 * writes instance matrices.
 */

export const TREE_MIN_HEIGHT = m(6);
export const TREE_HEIGHT_RANGE = m(8);

/** Street trees are pollarded smaller than a tree in open ground. */
const STREET_TREE_MIN = m(6.5);
const STREET_TREE_RANGE = m(3);

/** How each kind of plant answers the wind; see `wind.ts`. */
const TREE_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };
const BUSH_WIND: WindResponse = { sway: 0.05, flutter: 0.014 };
const GRASS_WIND: WindResponse = { sway: 0.22, flutter: 0.04 };

export interface SceneryKit {
  readonly trees: Record<TreeSpecies, BufferGeometry>;
  readonly bushes: Record<BushKind, BufferGeometry>;
  readonly furniture: Record<Exclude<FurnitureKind, 'streetTree' | 'shrub'>, BufferGeometry>;
  readonly lampLens: BufferGeometry;
  readonly treePit: BufferGeometry;
  readonly tuft: BufferGeometry;
  readonly flower: BufferGeometry;
  readonly foliage: MeshStandardMaterial;
  readonly foliageDepth: MeshDepthMaterial;
  readonly shrubs: MeshStandardMaterial;
  readonly shrubsDepth: MeshDepthMaterial;
  readonly grass: MeshStandardMaterial;
  readonly flowers: MeshStandardMaterial;
  readonly props: MeshStandardMaterial;
  readonly glow: MeshBasicMaterial;
  /** The warm pool of light under a street lamp, seen only after dark. */
  readonly pool: BufferGeometry;
  readonly poolGlow: MeshBasicMaterial;
  /** Lamps lit as night falls: 0 by day, 1 at night. */
  setNight(dark: number): void;
  dispose(): void;
}

/** Builds every model and material once, at renderer start. */
export function createSceneryKit(): SceneryKit {
  const trees = Object.fromEntries(TREE_SPECIES.map((s) => [s, treeGeometry(s)])) as Record<TreeSpecies, BufferGeometry>;
  const bushes = Object.fromEntries(BUSH_KINDS.map((k) => [k, bushGeometry(k)])) as Record<BushKind, BufferGeometry>;
  const furniture = {
    lamp: lampGeometry(),
    bin: binGeometry(),
    bench: benchGeometry(),
    hydrant: hydrantGeometry(),
    postbox: postboxGeometry(),
    phone: phoneGeometry(),
    drain: drainGeometry(),
  };
  const lampLens = lampLensGeometry();
  const treePit = treePitGeometry();
  const tuft = grassTuftGeometry();
  const flower = wildflowerGeometry();

  // Faceted, as the countryside's trees (`lowPolyTrees.ts`): one tree style
  // in the whole game, no leaf cards, no leaf noise over the crown.
  const foliage = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: true, envMapIntensity: 0.35 });
  applyWind(foliage, TREE_WIND, 'tree');
  const shrubs = new MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, flatShading: true, envMapIntensity: 0.35 });
  applyWind(shrubs, BUSH_WIND, 'bush');
  const grass = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: DoubleSide });
  applyWind(grass, GRASS_WIND, 'grass');
  const flowers = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: DoubleSide });
  applyWind(flowers, GRASS_WIND, 'flower');
  const props = new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.28 });
  const glow = new MeshBasicMaterial({ color: 0xffeec0, toneMapped: false });
  const pool = new CircleGeometry(1, 28);
  pool.rotateX(-Math.PI / 2);
  const poolGlow = new MeshBasicMaterial({
    map: lightPoolTexture(), color: 0xffc98a, transparent: true, opacity: 0, blending: AdditiveBlending,
    depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const foliageDepth = windDepthMaterial(TREE_WIND, 'tree');
  const shrubsDepth = windDepthMaterial(BUSH_WIND, 'bush');
  const geometries: BufferGeometry[] = [
    ...Object.values(trees),
    ...Object.values(bushes),
    ...Object.values(furniture),
    lampLens,
    treePit,
    tuft,
    flower,
    pool,
  ];
  const materials: Material[] = [foliage, shrubs, grass, flowers, props, glow, foliageDepth, shrubsDepth, poolGlow];
  return {
    trees,
    bushes,
    furniture,
    lampLens,
    treePit,
    tuft,
    flower,
    foliage,
    foliageDepth,
    shrubs,
    shrubsDepth,
    grass,
    flowers,
    props,
    glow,
    pool,
    poolGlow,
    setNight(dark) {
      // The lens burns brighter than white at night, so it blooms.
      glow.color.setHex(0xffeec0).multiplyScalar(1 + 2.6 * dark);
      poolGlow.opacity = 0.5 * dark;
      poolGlow.visible = dark > 0.02;
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

/**
 * The instanced meshes of trees and bushes, one low-poly model per kind at
 * every zoom, added to `meshes` and to `plants`.
 */
function plantMeshes(prefix: string, trees: Map<TreeSpecies, Placement[]>, bushes: Map<BushKind, Placement[]>, kit: SceneryKit,
  meshes: InstancedMesh[], plants: [InstancedMesh, BufferGeometry, BufferGeometry][]): void {
  const add = (mesh: InstancedMesh | null, model: BufferGeometry): void => {
    if (!mesh) return;
    meshes.push(mesh);
    plants.push([mesh, model, model]);
  };
  for (const species of TREE_SPECIES) {
    const placed = trees.get(species) ?? [];
    add(build(`${prefix}trees-${species}`, kit.trees[species], kit.foliage, placed, kit.foliageDepth, kit.trees[species]), kit.trees[species]);
  }
  for (const kind of BUSH_KINDS) {
    const placed = bushes.get(kind) ?? [];
    add(build(`${prefix}bushes-${kind}`, kit.bushes[kind], kit.shrubs, placed, kit.shrubsDepth, kit.bushes[kind]), kit.bushes[kind]);
  }
}

export interface Scenery {
  readonly meshes: readonly InstancedMesh[];
  /** Grass tufts and wildflowers, shown only at close zoom. */
  readonly grass: Group;
  readonly triangles: number;
  /**
   * Swaps every plant between its close-up model and its map-zoom model. A
   * geometry reference per mesh; nothing is rebuilt.
   */
  setNear(near: boolean): void;
  /**
   * The map zoom (`PLANT_MAP_ZOOM`): the leaf cards are not drawn at all, a
   * shrub or a length of hedge being a pixel or two; the crown under them
   * gives its colour and shape. Called every frame, after `visible` is set.
   */
  setMap(map: boolean): void;
  /**
   * Keeps only the instances the camera can see, or whose shadow it can.
   * `view` is the camera's projection times its inverse world matrix; nothing
   * is done while it is unchanged.
   */
  cull(frustum: Frustum, view: Matrix4): void;
  /**
   * Drops every tree and shrub whose trunk stands where `covered` says -
   * under a building (docs/buildings.md section 5) - from the instance cull.
   * Nothing is rebuilt; the next `cull` simply skips them. Null clears it.
   */
  exclude(covered: ((x: number, y: number) => boolean) | null): void;
  dispose(): void;
}

/**
 * How far outside the view an instance is still drawn, world units: the
 * longest shadow a tree can throw into the picture from beyond its edge.
 */
const SHADOW_REACH = 70;

/**
 * Every instance of one mesh, kept apart from what is drawn.
 *
 * Each species used to be ONE instanced mesh spread over the whole map, so
 * its bounding sphere was the map and nothing was ever off screen: zoomed in
 * on a crossroads, every bush on the map went to the GPU in close-up detail,
 * three times over (picture, shadow map, occlusion) - four million triangles
 * a frame, most of them outside the window. The instances in view are copied
 * to the front of the buffer when the camera moves, and only those are drawn.
 */
interface Instances {
  readonly matrices: Float32Array;
  readonly colours: Float32Array | null;
  /** Per instance: centre x, y, z and radius, in the scene's frame. */
  readonly spheres: Float32Array;
  readonly count: number;
  /** One sphere round every instance, so a mesh wholly out of view is skipped at once. */
  readonly bounds: { x: number; y: number; z: number; r: number };
}

/** Zoom at and above which plants are drawn with their close-up models. */
export const PLANT_NEAR_ZOOM = 1.4;
/** Below this zoom the plants' leaf cards are left out (`Scenery.setMap`). */
export const PLANT_MAP_ZOOM = 1;

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  tint?: Color;
}

function build(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
  depth?: MeshDepthMaterial,
  near?: BufferGeometry,
): InstancedMesh | null {
  if (placements.length === 0) return null;
  const mesh = new InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Culled per instance instead (`Scenery.cull`): a sphere round the whole
  // map rejects nothing, and it would go stale when the model is swapped.
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // The shadow pass bends with the wind too, or the shadows would lie still
  // under moving trees.
  if (depth) mesh.customDepthMaterial = depth;
  const object = new Object3D();
  let tinted = false;
  placements.forEach((placement, index) => {
    object.position.set(placement.x, placement.z, -placement.y);
    object.rotation.set(0, placement.yaw, 0);
    object.scale.set(placement.sx, placement.sy, placement.sz);
    object.updateMatrix();
    mesh.setMatrixAt(index, object.matrix);
    if (placement.tint) {
      mesh.setColorAt(index, placement.tint);
      tinted = true;
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (tinted && mesh.instanceColor) {
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    mesh.instanceColor.needsUpdate = true;
  }
  mesh.computeBoundingSphere();

  // Every instance's bounding sphere, from the larger of the model's reach
  // and the plant's close-up model's (`setNear` swaps them).
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const reach = Math.max(geometry.boundingSphere?.radius ?? 1, near?.boundingSphere?.radius ?? 0);
  const centre = geometry.boundingSphere?.center ?? new Vector3();
  const spheres = new Float32Array(placements.length * 4);
  const point = new Vector3();
  const matrix = new Matrix4();
  for (let i = 0; i < placements.length; i++) {
    mesh.getMatrixAt(i, matrix);
    point.copy(centre).applyMatrix4(matrix);
    const p = placements[i] as Placement;
    spheres[i * 4] = point.x;
    spheres[i * 4 + 1] = point.y;
    spheres[i * 4 + 2] = point.z;
    spheres[i * 4 + 3] = reach * Math.max(p.sx, p.sy, p.sz);
  }
  instances.set(mesh, {
    matrices: Float32Array.from(mesh.instanceMatrix.array as Float32Array),
    colours: tinted && mesh.instanceColor ? Float32Array.from(mesh.instanceColor.array as Float32Array) : null,
    spheres,
    count: placements.length,
    bounds: boundsOf(spheres, placements.length),
  });
  return mesh;
}

const instances = new WeakMap<InstancedMesh, Instances>();
const probe = new Sphere();

/** One sphere round every instance's own sphere: the centre of them, and the reach to the farthest. */
function boundsOf(spheres: Float32Array, count: number): { x: number; y: number; z: number; r: number } {
  if (count === 0) return { x: 0, y: 0, z: 0, r: 0 };
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < count; i++) { x += spheres[i * 4]!; y += spheres[i * 4 + 1]!; z += spheres[i * 4 + 2]!; }
  x /= count; y /= count; z /= count;
  let r = 0;
  for (let i = 0; i < count; i++) {
    const dx = spheres[i * 4]! - x, dy = spheres[i * 4 + 1]! - y, dz = spheres[i * 4 + 2]! - z;
    r = Math.max(r, Math.hypot(dx, dy, dz) + spheres[i * 4 + 3]!);
  }
  return { x, y, z, r };
}

/** A near-white multiplier, so no two plants of one species are identical. */
function foliageTint(rng: Rng): Color {
  const warm = rng.float();
  return new Color(0.9 + warm * 0.18, 0.93 + rng.float() * 0.12, 0.86 + (1 - warm) * 0.14);
}

/** Picks a species for a street tree: mostly planes, some flowering ipês. */
function streetSpecies(roll: number): TreeSpecies {
  if (roll < 0.55) return 'broadleafTall';
  if (roll < 0.78) return 'broadleaf';
  return roll < 0.89 ? 'ipeYellow' : 'ipePink';
}

export interface ScenerySettings {
  /** Grass clumps. */
  readonly grass: number;
}

/**
 * The ground cover of the open land: grass and wildflowers at close zoom.
 *
 * No trees or bushes are scattered over the terrain or along the roads any
 * more (the player's order of 2026-10-05): every tree on the map is one the
 * player planted with the landscaping tool, or one of a building's gardens.
 */
export function buildScenery(
  net: Network,
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  wetAt: (x: number, y: number) => boolean,
  settings: ScenerySettings,
  kit: SceneryKit,
): Scenery {
  // No grass grows by itself (the player's order of 2026-10-05): long grass
  // is placed with the landscaping tool and drawn with the street furniture.
  void settings;
  const grass: GrassField = buildGrass(net, elevation, terrainAt, wetAt, 0, kit);
  return {
    meshes: [],
    grass: grass.group,
    triangles: grass.triangles,
    setNear() {},
    setMap() {},
    cull(frustum, view) {
      if (grass.group.visible) grass.cull(frustum, view);
    },
    exclude() {},
    dispose() {
      grass.dispose();
    },
  };
}

/**
 * What the player placed on the footways (`world/streetFurniture.ts`): street
 * lights, benches, bins, hydrants, post boxes, street trees in their pits and
 * shrubs. Rebuilt on `doc.utilityRevision`, so placing a bench rebuilds this
 * and nothing else.
 */
export function buildStreetFurniture(net: Network, elevation: RoadElevation, kit: SceneryKit,
  terrainAt: (x: number, y: number) => number = () => 0, now = Number.NaN): Scenery {
  const furniture = new Map<string, Placement[]>();
  const put = (key: string, placement: Placement): void => {
    const list = furniture.get(key);
    if (list) list.push(placement);
    else furniture.set(key, [placement]);
  };
  const trees = new Map<TreeSpecies, Placement[]>(TREE_SPECIES.map((s) => [s, []]));
  const bushes = new Map<BushKind, Placement[]>(BUSH_KINDS.map((k) => [k, []]));

  // On the item's OWN road. The unfiltered field answers for whichever road is
  // nearest, and a lamp on a street passing under a viaduct was lifted onto the
  // deck above it.
  const deckAt = (item: FurnitureItem): number => elevation.onSegment(item.segment, item.x, item.y) + FOOTWAY_RISE;
  for (const item of streetFurniture(net)) {
    const base = deckAt(item);
    // Local +X of a lamp reaches over the road; local -Z of a bench, a post
    // box or a hydrant turns its back on the road.
    const inward = angleOf({ x: -item.outward.x, y: -item.outward.y });
    const facing = angleOf({ x: item.outward.y, y: -item.outward.x });
    const at = { x: item.x, y: item.y, z: base, sx: 1, sy: 1, sz: 1 };
    switch (item.kind) {
      case 'lamp': {
        put('lamp', { ...at, yaw: inward });
        // The light falls under the head, over the kerb and the road.
        const reach = LAMP_OUTREACH * 0.85;
        put('pool', { x: item.x - item.outward.x * reach, y: item.y - item.outward.y * reach, z: base + 0.03,
          yaw: 0, sx: m(4.6), sy: 1, sz: m(4.6) });
        break;
      }
      case 'bin':
        put('bin', { ...at, yaw: item.seed * Math.PI * 2 });
        break;
      case 'bench': {
        // Its seat faces where the layout says somebody sitting looks.
        const faces = item.faces ?? { x: -item.outward.x, y: -item.outward.y };
        put('bench', { ...at, yaw: angleOf({ x: -faces.y, y: faces.x }) });
        break;
      }
      case 'postbox':
      case 'hydrant':
      case 'phone':
      case 'drain':
        // Built facing -Z; turned so the phone's shell opens to the footway
        // and the drain's grate lies in the gutter on the road side.
        put(item.kind, { ...at, yaw: facing + Math.PI });
        break;
      case 'streetTree': {
        put('treePit', { ...at, yaw: angleOf(item.along) });
        // Planted young, it grows to its full height over a few days.
        const height = (STREET_TREE_MIN + item.seed * STREET_TREE_RANGE) * plantGrowth(item.planted, now);
        const rng = new Rng(Math.floor(item.seed * 0xffffff));
        (trees.get(streetSpecies(rng.float())) as Placement[]).push({
          x: item.x,
          y: item.y,
          z: base + m(0.03),
          yaw: rng.float() * Math.PI * 2,
          sx: height * (0.85 + rng.float() * 0.2),
          sy: height,
          sz: height * (0.85 + rng.float() * 0.2),
          tint: foliageTint(rng),
        });
        break;
      }
      case 'shrub': {
        const rng = new Rng(Math.floor(item.seed * 0xffffff));
        const height = (m(0.8) + rng.float() * m(0.4)) * plantGrowth(item.planted, now);
        (bushes.get(rng.float() < 0.4 ? 'bushFlowering' : 'bush') as Placement[]).push({
          x: item.x,
          y: item.y,
          z: base - m(0.05),
          yaw: rng.float() * Math.PI * 2,
          sx: height * 1.05,
          sy: height,
          sz: height * 1.05,
          tint: foliageTint(rng),
        });
        break;
      }
    }
  }

  const meshes = [
    build('street-lights', kit.furniture.lamp, kit.props, furniture.get('lamp') ?? []),
    build('street-light-lamps', kit.lampLens, kit.glow, furniture.get('lamp') ?? []),
    build('street-light-pools', kit.pool, kit.poolGlow, furniture.get('pool') ?? []),
    build('street-bins', kit.furniture.bin, kit.props, furniture.get('bin') ?? []),
    build('benches', kit.furniture.bench, kit.props, furniture.get('bench') ?? []),
    build('hydrants', kit.furniture.hydrant, kit.props, furniture.get('hydrant') ?? []),
    build('post-boxes', kit.furniture.postbox, kit.props, furniture.get('postbox') ?? []),
    build('phones', kit.furniture.phone, kit.props, furniture.get('phone') ?? []),
    build('drains', kit.furniture.drain, kit.props, furniture.get('drain') ?? []),
    build('tree-pits', kit.treePit, kit.props, furniture.get('treePit') ?? []),
  ].filter((mesh): mesh is InstancedMesh => mesh !== null);

  /** Each plant mesh with its two models, near first. */
  const plants: [InstancedMesh, BufferGeometry, BufferGeometry][] = [];
  plantMeshes('street-', trees, bushes, kit, meshes, plants);
  const leafMeshes = meshes.filter((mesh) => mesh.name.endsWith('-leaves'));
  // The lens is lit from inside; it neither casts nor takes a shadow.
  for (const mesh of meshes) {
    if (mesh.name === 'street-light-lamps' || mesh.name === 'tree-pits' || mesh.name === 'street-light-pools') mesh.castShadow = false;
    if (mesh.name === 'street-light-pools') { mesh.receiveShadow = false; mesh.renderOrder = 3; }
  }

  let triangles = 0;
  for (const mesh of meshes) triangles += trianglesOf(mesh.geometry) * mesh.count;
  let culledFor: Matrix4 | null = null;
  let nearMode: boolean | null = null;
  let mapMode: boolean | null = null;

  // Long grass placed on open ground (Paisagismo > Mato).
  const meadows = [...net.doc.landscape.values()].filter((item) => item.kind === 'meadow');
  const meadow = buildGrass(net, elevation, terrainAt, () => false, 0, kit, meadows);
  triangles += meadow.triangles;

  return {
    meshes,
    grass: meadow.group,
    triangles,
    setNear(near) {
      if (nearMode === near) return;
      nearMode = near;
      for (const [mesh, close, far] of plants) mesh.geometry = near ? close : far;
    },
    setMap(map) {
      if (mapMode === map) return;
      mapMode = map;
      culledFor = null;
      for (const mesh of leafMeshes) mesh.visible = !map;
    },
    cull(frustum, view) {
      if (culledFor && culledFor.equals(view)) return;
      culledFor = (culledFor ?? new Matrix4()).copy(view);
      cullInstances(meshes, null, frustum, mapMode === true);
      meadow.cull(frustum, view);
    },
    exclude() {},
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      meadow.dispose();
    },
  };
}

/** A soft round falloff, white in the middle, for a pool of lamplight. */
function lightPoolTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  r.addColorStop(0.7, 'rgba(255,255,255,0.15)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A plant of a building's garden, in the world: a tree, a shrub, a run of hedge or a flower bed. */
export interface GardenPlant {
  readonly kind: 'tree' | 'shrub' | 'hedge' | 'flowers';
  readonly x: number;
  readonly y: number;
  /** Ground height under it. */
  readonly z: number;
  /** Size, world units: along (w), across (d) and height (h); `yaw` the way `w` runs. */
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly yaw: number;
  readonly seed: number;
  /** A tree's species, when it is not a garden's mix (a painted forest's). */
  readonly species?: TreeSpecies;
  /** A shrub that never flowers (a wood's understorey). */
  readonly plain?: boolean;
}

/** A garden tree's species: mostly broadleaf, some conifers, now and then a flowering ipê. */
function gardenSpecies(roll: number): TreeSpecies {
  if (roll < 0.42) return 'broadleaf';
  if (roll < 0.62) return 'broadleafTall';
  if (roll < 0.8) return 'conifer';
  return roll < 0.9 ? 'ipeYellow' : 'ipePink';
}

/**
 * The trees, shrubs, hedges and flowers of the buildings' gardens, drawn with
 * the scenery's own plants (instanced, swaying, culled to the view) - not as
 * boxes and cones in the building's mesh.
 */
export function buildGardens(list: readonly GardenPlant[], kit: SceneryKit): Scenery {
  const trees = new Map<TreeSpecies, Placement[]>(TREE_SPECIES.map((s) => [s, []]));
  const bushes = new Map<BushKind, Placement[]>(BUSH_KINDS.map((k) => [k, []]));
  for (const p of list) {
    const rng = new Rng(Math.floor(p.seed * 0xffffff) ^ 0x5eed);
    switch (p.kind) {
      case 'tree': {
        const spread = 0.82 + rng.float() * 0.3;
        const roll = rng.float();
        (trees.get(p.species ?? gardenSpecies(roll)) as Placement[]).push({
          x: p.x, y: p.y, z: p.z - m(0.05), yaw: rng.float() * Math.PI * 2,
          sx: p.h * spread, sy: p.h, sz: p.h * spread * (0.9 + rng.float() * 0.2), tint: foliageTint(rng),
        });
        break;
      }
      case 'shrub': {
        // The geometry is about 1.5 across for 1 tall.
        // Kept in the bush's own proportions: a narrow, tall slot used to
        // stretch it into a column of smeared leaves and flowers. The plant
        // fills the slot's width and stands no taller than a bush that wide.
        // A little under the slot: the leaf cards reach past the crown, and a
        // bush by a wall must not show through it.
        const across = (Math.min(p.w, p.d) / 1.5) * 0.8;
        const tall = Math.min(p.h, across * 1.3);
        const wide = Math.max(across, tall / 1.3);
        (bushes.get(!p.plain && rng.float() < 0.25 ? 'bushFlowering' : 'bush') as Placement[]).push({
          x: p.x, y: p.y, z: p.z - m(0.05), yaw: rng.float() * Math.PI * 2,
          sx: wide, sy: tall, sz: wide * (0.9 + rng.float() * 0.2), tint: foliageTint(rng),
        });
        break;
      }
      case 'hedge': {
        // Clipped pieces along its run, overlapping so it reads as one.
        const n = Math.max(1, Math.round(p.w / Math.max(m(2.2), p.h * 1.5)));
        const step = p.w / n;
        const cx = Math.cos(p.yaw), cy = Math.sin(p.yaw);
        const tint = foliageTint(rng);
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) * step - p.w / 2;
          (bushes.get('hedge') as Placement[]).push({
            x: p.x + cx * t, y: p.y + cy * t, z: p.z - m(0.05), yaw: p.yaw,
            sx: (step / 1.9) * 1.25, sy: p.h, sz: p.d / 0.9, tint,
          });
        }
        break;
      }
      case 'flowers': {
        // A bed of low flowering clumps.
        const n = Math.max(2, Math.round((p.w * p.d) / (m(0.7) * m(0.7))));
        const cx = Math.cos(p.yaw), cy = Math.sin(p.yaw);
        for (let i = 0; i < Math.min(n, 24); i++) {
          const u = (rng.float() - 0.5) * p.w * 0.85, v = (rng.float() - 0.5) * p.d * 0.85;
          const h = m(0.35) + rng.float() * m(0.25);
          (bushes.get('bushFlowering') as Placement[]).push({
            x: p.x + cx * u - cy * v, y: p.y + cy * u + cx * v, z: p.z + m(0.12), yaw: rng.float() * Math.PI * 2,
            sx: h * 1.1, sy: h, sz: h * 1.1,
          });
        }
        break;
      }
    }
  }
  const meshes: InstancedMesh[] = [];
  const plants: [InstancedMesh, BufferGeometry, BufferGeometry][] = [];
  plantMeshes('garden-', trees, bushes, kit, meshes, plants);
  const leafMeshes = meshes.filter((mesh) => mesh.name.endsWith('-leaves'));
  let triangles = 0;
  for (const mesh of meshes) triangles += trianglesOf(mesh.geometry) * mesh.count;
  let culledFor: Matrix4 | null = null;
  let nearMode: boolean | null = null;
  let mapMode: boolean | null = null;
  const grass = new Group();
  return {
    meshes,
    grass,
    triangles,
    setNear(near) {
      if (nearMode === near) return;
      nearMode = near;
      for (const [mesh, close, far] of plants) mesh.geometry = near ? close : far;
    },
    setMap(map) {
      if (mapMode === map) return;
      mapMode = map;
      culledFor = null;
      for (const mesh of leafMeshes) mesh.visible = !map;
    },
    cull(frustum, view) {
      if (culledFor && culledFor.equals(view)) return;
      culledFor = (culledFor ?? new Matrix4()).copy(view);
      cullInstances(meshes, null, frustum, mapMode === true);
    },
    exclude() { /* a garden's plants are the building's own */ },
    dispose() {
      for (const mesh of meshes) mesh.dispose();
    },
  };
}

/** Copies the instances of each mesh the frustum can see (or see the shadow of) to the front, skipping `excluded`. */
function cullInstances(meshes: readonly InstancedMesh[], excluded: Map<InstancedMesh, Uint8Array> | null, frustum: Frustum, mapMode: boolean): void {
  for (const mesh of meshes) {
    if (mapMode && mesh.name.endsWith('-leaves')) continue;
    const all = instances.get(mesh);
    if (!all) continue;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const colours = all.colours && mesh.instanceColor ? mesh.instanceColor.array as Float32Array : null;
    // The whole mesh, before its instances one by one: a mesh entirely out of
    // view - most of them, most frames - used to have every instance tested
    // and its buffers rewritten to hold nothing. The sphere is the one built
    // over every instance (`build`), grown by the shadow reach the per-instance
    // test allows, so a miss here cannot hide an instance that test would keep.
    if (all.bounds) {
      probe.center.set(all.bounds.x, all.bounds.y, all.bounds.z);
      probe.radius = all.bounds.r + SHADOW_REACH;
      if (!frustum.intersectsSphere(probe)) {
        if (mesh.count !== 0) {
          mesh.count = 0;
          mesh.instanceMatrix.clearUpdateRanges();
          mesh.instanceMatrix.needsUpdate = true;
          if (colours && mesh.instanceColor) {
            mesh.instanceColor.clearUpdateRanges();
            mesh.instanceColor.needsUpdate = true;
          }
        }
        continue;
      }
    }
    let n = 0;
    const hidden = excluded?.get(mesh);
    for (let i = 0; i < all.count; i++) {
      if (hidden && hidden[i]) continue;
      const s = all.spheres;
      probe.center.set(s[i * 4] as number, s[i * 4 + 1] as number, s[i * 4 + 2] as number);
      probe.radius = (s[i * 4 + 3] as number) + SHADOW_REACH;
      if (!frustum.intersectsSphere(probe)) continue;
      const source = i * 16;
      const target = n * 16;
      for (let j = 0; j < 16; j++) matrices[target + j] = all.matrices[source + j]!;
      if (colours && all.colours) {
        const sourceColour = i * 3;
        const targetColour = n * 3;
        colours[targetColour] = all.colours[sourceColour]!;
        colours[targetColour + 1] = all.colours[sourceColour + 1]!;
        colours[targetColour + 2] = all.colours[sourceColour + 2]!;
      }
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.clearUpdateRanges();
    if (n > 0) mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (colours && mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      if (n > 0) mesh.instanceColor.addUpdateRange(0, n * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }
}
