import { createActions } from './actionsWiring';
import { FrameClock, Periodic, TopologyCatchUp } from './frameLoop';
import { beginFrameWork } from '@core/frameWork';
import { GameState } from '@core/gameState';
import { FrameTimer, HealthLog, frameStats } from '@core/health';
import { LotTool, type LotSplitKind, type ZoneMode } from '@editor/lotTool';
import { watchHealth } from '@ui/healthWatch';
import { mountHealthPanel } from '@ui/healthPanel';
import { METERS_PER_UNIT } from '@world/units';
import type { LotOverlayInput } from '@render/lotOverlay';
import { applyLots, planLots } from '@world/lots';
import { type Vec2, dist } from '@core/vec2';
import { clamp } from '@core/scalar';
import { flattenSegment } from '@core/bezier';
import { RoadDoc, type JunctionControl } from '@world/doc';
import type { Change, ChangeKind } from '@world/changes';
import { MIN_LINK_LENGTH } from '@world/approach';
import { MAX_AUTHORED_GRADE } from '@world/elevation';
import { Network } from '@world/network';
import { DEFAULT_CITY, planCity, type CityOptions } from '@world/cityGen/plan';
import { layCity, zoneCity } from '@editor/cityGenerator';
import { LAST_UPGRADE_CLASS, ROAD_TYPES, roadProfile, roadType } from '@world/roadTypes';
import { UNITS_PER_METER } from '@world/units';
import { MAX_TERRAIN_STAMPS, RELIEF_NATURAL, type TerrainMode } from '@world/terrain';
import type { GeologyKind } from '@world/terrainPaint';
import { DEFAULT_REGION, isRegionId, type NatureSettings } from '@world/ecology';
import type { NodeId, SegmentId } from '@world/ids';
import { BARRIER_KINDS, type BarrierKind } from '@world/barriers';
import { BarrierTool } from '@editor/barriers';
import {
  POLE_PICK_PIXELS,
  PoleTool,
  commitPoleRun,
  planPoleRun,
  type PoleRunPlan,
} from '@editor/poles';
import { blockGridChoice, onRoadGridChange, roadGridShown, signChoice, strikeChoice, zoneColoursShown, paintKind, poleLampMode, poleToolMode, roadWidth, streetscapeKind, fogErase, fogBrush, setFogBrush, gullyErase, treeMode, treeKind, treeBrush, setTreeBrush, cloudMode, cloudBrush, setCloudBrush, elementKind, elementMode, elementBrush, setElementBrush, syncElementInputs } from '@ui/toolChoices';
import { TERRAIN_MIN_MS, TerrainBrush, type DabSettings } from '@editor/terrainBrush';
import { scatterClouds } from '@world/clouds';
import { CloudTool } from '@editor/cloudTool';
import { playThunder } from '@ui/thunder';
import { MAP_SIZE } from '@world/bounds';
import { blockGridLines, commitBlockGrid } from '@editor/blocks';
import { m } from '@world/units';
import { GRID_CELL } from '@world/grid';
import { sectionForWidth } from '@world/roadSection';
import { LANDSCAPE_RADIUS } from '@world/landscape';
import { StreetscapeTool } from '@editor/streetscapeTool';

import { Camera } from '@view/camera';
import { type Viewport, flatViewport } from '@view/viewport';
import { CanvasSurface } from '@ui/overlay/surface';
import { INVALID, SELECTION, HOVER } from '@ui/overlay/palette';
import { createSceneRenderer, type SceneHandle, type SkyMode } from '@render/renderer';
import { primeSurfaceBake, startSurfaceBake } from '@render/surfaceBakeClient';
import { DEFAULT_AZIMUTH, DEFAULT_ELEVATION, isoZoomBounds } from '@render/isoViewport';

import { SimWorld } from '@sim/world';
import { rebindAgents, step } from '@sim/pipeline';
import { DT, NARROW_SCREEN_SHARE, NARROW_SCREEN_WIDTH } from '@sim/params';
import { summarize } from '@sim/audit';

import { type Anchor, anchorForHeight, findAnchor, roadSnap, setRoadSnap } from '@editor/snap';
import { duplicateSegment, joinSegments, splitSegment } from '@editor/commit';
import { commitPedestrianCrossing } from '@editor/streetObjects';
import { commitRoundabout } from '@editor/roundabout';
import { RoadTool, type RoadDraft } from '@editor/roadTool';
import { Bulldozer } from '@editor/bulldozer';
import { NodeMover } from '@editor/nodeMover';
import { CameraGestures } from '@view/cameraGestures';
import { freeRoadsEnabled } from '@ui/roadSectionEditor';
import { ROAD_PARKING_PRESETS, type RoadParkingPreset, roadParking, roadParkingPreset, setRoadParkingPreset } from '@editor/roadParking';
import { History, restoreInto, restoreSnapshot, serialize } from '@editor/history';
import { type ImportResult, Persistence, exportToFile, importFromFile, type SavedSettings, DEFAULT_TRAFFIC_COUNT, DEFAULT_PEDESTRIAN_COUNT, MAX_TRAFFIC_COUNT, MAX_PEDESTRIAN_COUNT } from '@editor/persistence';
import { drawMinimap, minimapToWorld } from '@ui/minimap';
import { openInspector, closeInspector, refreshInspector } from '@ui/inspector';
import { TransitTool, setTransitTool, transitTool } from '@editor/transitTools';
import { type BuildingId, decayOf } from '@world/buildings/types';
import { focusCameFromKeyboard, initChrome } from '@ui/chrome';
import { roadSwatch } from '@ui/roadSwatch';
import { mountBuildStamp } from '@ui/buildStamp';
import { UI_V2 } from '@ui/shell/flag';
import { mountShell } from '@ui/v2/shell';
import { mountAbout } from '@ui/about';
import { LANGUAGES, hasKey, initLanguage, language, onLanguageChange, setLanguage, t } from '@ui/i18n';
import {
  nodeCountLabel,
  peopleCountLabel,
  roadCountLabel,
  roadTypeDescription,
  roadTypeName,
  vehicleCountLabel,
} from '@ui/labels';
import { isQualityLevel, type QualityLevel } from '@render/quality';
import { createBuildingWiring } from './buildingsWiring';
import { levelElevation, roofRise } from '@world/buildings/geometry';
import { volumeTop } from '@world/buildings/types';
import { type ZoneUse, type ZoneDensity } from '@world/zones';
import { LOT_PLAN_VERSION, growOnLot } from '@editor/zoning';

type Tool =
  | 'building'
  | 'zone'
  | 'road'
  | 'roundabout'
  | 'terrain'
  | 'upgrade'
  | 'move'
  | 'split'
  | 'bulldoze'
  | 'control'
  | 'inspect'
  | 'pole'
  | 'streetscape'
  | 'barrier'
  | 'transit'
  | 'person';
type Alignment = 'straight' | 'curve' | 'free';

// The interface language is resolved and applied BEFORE anything reads a label,
// so no frame is ever painted in the wrong language.
initLanguage();

const canvas = document.getElementById('game') as HTMLCanvasElement;
const minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;

/**
 * The game's health (`core/health.ts`): what broke and what was slow, with
 * what the player was doing. Watched from here on, before the boot, so a map
 * that fails to load or a worker that dies while opening is written down too
 * (`ui/healthWatch.ts`); shown by the top bar's health button and F9
 * (`ui/healthPanel.ts`); `__health()` in the console.
 */
const health = new HealthLog();
const frameTimer = new FrameTimer();
const healthWatch = watchHealth({
  log: health,
  frames: frameTimer,
  canvas,
  context: () => {
    const last = doc.changes.latest(1)[0];
    return [
      `ferramenta ${game.tool}`,
      game.gesture ?? '',
      last ? `última mudança #${last.serial} ${last.kind} (${last.cause})` : '',
      booted ? '' : 'abrindo o jogo',
    ].filter(Boolean).join(' · ');
  },
});

const doc = new RoadDoc();
// A new map is made on the natural land; a saved one keeps its own (restored below).
doc.terrainRelief = RELIEF_NATURAL;
/** A new map's ecosystem: the default biome, its patches laid by a seed of its own. */
const newNature = (region = DEFAULT_REGION): NatureSettings => ({ region, seed: Math.floor(Math.random() * 1_000_000_000) });
doc.nature = newNature();
const net = new Network(doc);
const camera = new Camera();
/**
 * Whether the whole module has run. The boot awaits (the surface bake, the
 * crowd) let a resize draw a frame half-way through it, before the buildings
 * and the rest exist; no frame is drawn until the end, which asks for one.
 */
let booted = false;
const surface = new CanvasSurface(canvas, () => { if (booted) requestDraw(); });
const history = new History();
const persistence = new Persistence();

surface.observe();

// ------------------------------------------------------------------ boot
const surfaceBake = startSurfaceBake();
clearOldMapsOnce();
const savedSession = persistence.loadSession();
// The game opens on an empty map - zoning starts from nothing - unless the
// player has a map of their own. An autosave that is still an earlier build's
// untouched starter scenario is dropped too.
const saved = savedSession?.document && !isUntouchedStarter(savedSession.document)
  ? savedSession.document
  : null;

/**
 * The cities saved before 2026-10-04 (the shipped town, the player's own maps,
 * the copies set aside) are removed, once: the player asked for a clean start.
 */
function clearOldMapsOnce(): void {
  const MARK = 'roadcraft.mapsCleared';
  try {
    if (window.localStorage.getItem(MARK) === '2026-10-04') return;
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && (key.startsWith('roadcraft.world') || key === 'roadcraft.oldTownBackup' || key === 'roadcraft.townVersion')) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
    window.localStorage.setItem(MARK, '2026-10-04');
  } catch {
    // Storage blocked: nothing was kept to clear.
  }
}
// A saved map that validates and still fails to load must not take the game
// down with it - on every reload. It is set aside (never deleted) and the game
// opens on an empty map instead, saying so.
let bootFailed = false;
if (saved) {
  try {
    doc.changes.causeNext('mapa salvo carregado');
    restoreInto(doc, saved, net);
    doc.changes.causeNext('jogo');
  } catch (error) {
    console.error('The saved map could not be loaded; it was set aside.', error);
    persistence.quarantineStored();
    const fresh = new RoadDoc();
    fresh.terrainRelief = RELIEF_NATURAL;
    fresh.nature = newNature();
    doc.replaceWith(fresh);
    net.rebuild();
    bootFailed = true;
  }
}

const sim = new SimWorld(doc, net, 0x2024);
sim.auditEnabled = true;
sim.auditLevel = 'cheap';
// The status bar's alerts: checked once a second of play, not on every one
// of its sixty ticks - a whole pass over the fleet and the signals each tick.
sim.auditEvery = 60;
/** The simulation never reads the screen; the screen's size is handed to it. */
function syncPopulationShare(): void {
  sim.populationShare = window.innerWidth < NARROW_SCREEN_WIDTH ? NARROW_SCREEN_SHARE : 1;
}
syncPopulationShare();

/**
 * The zoom range the renderer we are about to boot can actually represent.
 *
 * Before the viewport exists there is nothing to ask, so this mirrors what
 * `createThreeRenderer` does with the same canvas: the iso rig takes its initial
 * half-height from `canvas.clientHeight`, so its range is
 * `isoZoomBounds(that height)`. Under `?render=2d` the flat camera's own range
 * applies instead. `view.zoomBounds` is used once a viewport exists.
 */
function bootZoomBounds(): { min: number; max: number } {
  return isoZoomBounds(Math.max(1, canvas.clientHeight || window.innerHeight));
}

if (savedSession && saved) {
  camera.x = savedSession.settings.camera.x;
  camera.y = savedSession.settings.camera.y;
  // Clamped against the ACTIVE renderer's range, not always the flat camera's.
  // A 3D session can legitimately sit at ~7.3 zoom at an 800 px viewport, and
  // the flat bounds (0.18-3.2) snapped every reload of one back to 3.2. The
  // clamp stays: it is the guard against a hand-edited or corrupt save file.
  const limits = bootZoomBounds();
  camera.zoom = clamp(savedSession.settings.camera.zoom, limits.min, limits.max);
} else {
  camera.fit(worldBounds(), surface.cssW, surface.cssH);
}

/**
 * Whether an autosave is exactly one of the starter scenarios an earlier build
 * seeded, never edited. Such a save carries nothing of the player's, so the
 * game opens on an empty map instead.
 */
function isUntouchedStarter(saved: ReturnType<RoadDoc['toJSON']>): boolean {
  // Declared here, not at module level: boot calls this before any `const`
  // below it is initialised.
  const OLD_STARTERS: readonly { readonly segments: number; readonly nodes: ReadonlySet<string> }[] = [
    // A 3x3 grid with four approach stubs.
    {
      segments: 16,
      nodes: new Set([
        ...[-360, 0, 360].flatMap((x) => [-260, 0, 260].map((y) => `${x},${y}`)),
        '0,-480', '0,480', '-580,0', '580,0',
      ]),
    },
    // An avenue crossed at a signalised crossroads, with a local street at a T.
    {
      segments: 6,
      nodes: new Set(['-560,0', '0,0', '330,0', '600,0', '0,-430', '0,430', '330,360']),
    },
  ];
  const nodes = saved.nodes ?? [];
  const segments = saved.segments ?? [];
  if ((saved.terrain ?? []).length > 0 || (saved.poles ?? []).length > 0 ||
    (saved.buildings ?? []).length > 0) return false;
  return OLD_STARTERS.some((starter) =>
    nodes.length === starter.nodes.size && segments.length === starter.segments &&
    nodes.every((n) => starter.nodes.has(`${n.x},${n.y}`)));
}

function worldBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of doc.nodes.values()) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  if (!Number.isFinite(minX)) return { minX: -200, minY: -200, maxX: 200, maxY: 200 };
  return { minX, minY, maxX, maxY };
}

// ------------------------------------------------------------------ state
// The tool in hand, the pause, the speed and the selection are the game's
// state (`gameState` below, read as `game.tool`...), and so is what each tool
// is set to (road class, brush, zone, lot cut...): there is no copy here.
/** The terrain brush: a land stamp (`TerrainMode`), or painting the ground (`terrainPaint.ts`). */
type BrushMode = TerrainMode | 'paint' | 'fog' | 'cloud' | 'elements' | 'gully' | 'trees' | 'weather' | Landform;
/**
 * The landforms: a shape and its ROCK in one tool, so a chapada stands in
 * sandstone and a sugarloaf in granite without the player painting the rock
 * (a biome layer of a terrain auto-material, laid as the land is sculpted).
 * Each dab also lays a geology dab of its rock (`world/terrainPaint.ts`).
 */
type Landform = 'mesa' | 'canyon' | 'escarpment' | 'sugarloaf';
const LANDFORMS: Readonly<Record<Landform, { readonly mode: 'raise' | 'lower'; readonly rock: GeologyKind; readonly hardness: number; readonly profile?: 'dome' }>> = {
  mesa: { mode: 'raise', rock: 'sandstone', hardness: 85 },
  canyon: { mode: 'lower', rock: 'sandstone', hardness: 80 },
  escarpment: { mode: 'raise', rock: 'basalt', hardness: 75 },
  sugarloaf: { mode: 'raise', rock: 'granite', hardness: 0, profile: 'dome' },
};
const landformOf = (mode: BrushMode): (typeof LANDFORMS)[Landform] | undefined => (LANDFORMS as Partial<Record<BrushMode, (typeof LANDFORMS)[Landform]>>)[mode];
const hardnessByMode: Partial<Record<BrushMode, number>> = { raise: 0, lower: 0, mesa: 85, canyon: 80, escarpment: 75 };
sim.clock.paused = savedSession?.settings.paused === true;
sim.clock.speed = savedSession?.settings.speed ?? 1;
sim.trafficIntensity = savedSession?.settings.trafficIntensity ?? 1;
sim.pedestrianIntensity = savedSession?.settings.pedestrianIntensity ?? 1;
// How many cars and people the panel asks for: they come in at the ends of the roads (`sim/ambient` source 'edges').
sim.trafficCount = savedSession?.settings.cars ?? DEFAULT_TRAFFIC_COUNT;
sim.pedestrianCount = savedSession?.settings.people ?? DEFAULT_PEDESTRIAN_COUNT;
sim.demandMultiplier = savedSession?.settings.demandMultiplier ?? 1;
/**
 * The game's state - the tool in hand, the pause and speed, the quality, the
 * selection - owned here and every change written down with why
 * (`core/gameState.ts`, `__state()` in the console). It is the only copy:
 * read through `game` (read-only), written only by `gameState.set` with the
 * cause, and whoever reacts to a change `watch`es it (told once a frame,
 * `frame` → `gameState.flush`). The game opens with nothing in hand.
 */
const gameState = new GameState({
  tool: 'inspect' as Tool,
  paused: sim.clock.paused,
  speed: sim.clock.speed,
  quality: 'high' as string,
  selectedSegment: null as SegmentId | null,
  selectedSegmentS: null as number | null,
  selectedNode: null as NodeId | null,
  // The road tool: class, plan, height above the ground, lanes.
  roadTypeIndex: 1,
  alignment: 'straight' as Alignment,
  roadHeightOffset: 0,
  roadLanePreset: null as number | null,
  roundaboutRadius: 100,
  // The terrain brush. Hardness, 0..95: how hard the raise/lower brush's edge
  // is (`TerrainStamp.hardness`), 0 the smooth dome; each mode keeps its own.
  terrainMode: 'raise' as BrushMode,
  terrainRadius: 80,
  terrainStrength: 24,
  terrainHardness: 0,
  // Walls, zones and lots.
  barrierKind: 'fence' as BarrierKind,
  zoneUse: 'residential' as ZoneUse,
  zoneDensity: 'low' as ZoneDensity,
  zoneEraser: false,
  zoneMode: 'brush' as ZoneMode,
  lotSplitKind: 'vertical' as LotSplitKind,
  lotSplitParts: 2,
  // The view.
  congestionOverlay: savedSession?.settings.congestionOverlay ?? false,
  perspective: false,
  /** What the player is in the middle of doing (`currentGesture`), null between gestures. */
  gesture: null as string | null,
}, () => { if (booted) requestDraw(); });
/** The game's state, read-only: `game.tool`, `game.paused`, `game.selectedSegment`... */
const game = gameState.values;

function sessionSettings(): SavedSettings {
  const centre = view.centre;
  return {
    camera: { x: centre.x, y: centre.y, zoom: view.zoom, azimuth: view.azimuth, elevation: view.elevation },
    paused: sim.clock.paused,
    speed: sim.clock.speed,
    trafficIntensity: sim.trafficIntensity,
    pedestrianIntensity: sim.pedestrianIntensity,
    cars: sim.trafficCount ?? DEFAULT_TRAFFIC_COUNT,
    people: sim.pedestrianCount ?? DEFAULT_PEDESTRIAN_COUNT,
    demandMultiplier: sim.demandMultiplier,
    congestionOverlay: game.congestionOverlay,
  };
}

/** The road tool (`editor/roadTool.ts`): the stroke, the chain, the curve waiting for its bend, the road settling. */
const roadTool = new RoadTool({
  doc,
  net,
  zoom: () => view.zoom,
  px: (n) => camera.px(n),
  settings: () => ({
    typeIndex: game.roadTypeIndex, lanes: game.roadLanePreset, alignment: game.alignment,
    heightOffset: game.roadHeightOffset, parking: roadParking(), width: roadWidth(), grid: roadGridShown(),
  }),
  setHeight: (value, cause) => gameState.set('roadHeightOffset', value, cause),
  worldAtScreen: (px, py, height) => worldAtScreen(px, py, height),
  naturalHeightAt: (x, y) => scene.naturalTerrainHeightAt(x, y),
  offerElevation: (solution, revision) => scene.offerElevation(solution, revision),
  flash: (ids) => scene.flashRoads(ids),
  mutate: (fn) => mutate(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
/** The pole tool (`editor/poles.ts`): the stretch being dragged and the line's last pole. */
const poleTool = new PoleTool({
  doc,
  net,
  zoom: () => view.zoom,
  mode: () => poleToolMode(),
  lamps: () => poleLampMode(),
  inHand: () => game.tool === 'pole',
  mutate: (fn) => mutateBuilt(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
/** The pole run planned for this frame (`PoleTool.plan`), shared by the 3D preview and the overlay. */
let framePolePlan: PoleRunPlan | null = null;
/** The landscaping tool (`editor/streetscapeTool.ts`): items on the footways. */
const streetscapeTool = new StreetscapeTool({
  doc,
  net,
  zoom: () => view.zoom,
  kind: () => streetscapeKind(),
  extra: (kind) => kind === 'sign' ? { signType: signChoice.type, text: signChoice.text }
    : kind === 'streetname' ? { text: signChoice.streetName }
    : kind === 'tree' || kind === 'shrub' ? { planted: sim.city.minutes(sim) } : {},
  mutate: (fn) => mutate(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
/** The walls tool (`editor/barriers.ts`): the wall, fence or hedge being traced. */
const barrierTool = new BarrierTool({
  net: () => net,
  kind: () => game.barrierKind,
  removeAt: (at) => {
    const hit = doc.barrierNear(at, BARRIER_PICK_PIXELS / view.zoom);
    if (!hit) return false;
    mutate(() => doc.removeBarrier(hit.id));
    return true;
  },
  build: (kind, path) => mutate(() => doc.addBarrier(kind, path) !== null),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
/**
 * The Zoning tool (`editor/lotTool.ts`): the lots the player draws, edits and
 * zones, with its gestures' own state. Buildings grow on the zoned lots; the
 * roads neither make, change nor show them (the player, 2026-10-06).
 */
const lotTool = new LotTool({
  doc,
  net,
  zoom: () => view.zoom,
  settings: () => ({
    mode: game.zoneMode, use: game.zoneUse, density: game.zoneDensity, eraser: game.zoneEraser,
    splitKind: game.lotSplitKind, splitParts: game.lotSplitParts,
  }),
  mutate: (fn) => mutate(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
let hoverAnchor: Anchor | null = null;
/** What is selected - a road (and where along it) or a junction - written through the game's state with why (`gameState`). */
function select(segment: SegmentId | null, s: number | null, node: NodeId | null, cause: string): void {
  gameState.set('selectedSegment', segment, cause);
  gameState.set('selectedSegmentS', s, cause);
  gameState.set('selectedNode', node, cause);
}

/** The camera moved by hand: the pointers, a pan, an orbit, a pinch (`view/cameraGestures.ts`). */
const cameraHand = new CameraGestures({
  view: () => view,
  size: () => ({ w: surface.cssW, h: surface.cssH }),
  orbited: () => persistence.saveSettingsSoon(sessionSettings),
  redraw: () => requestDraw(),
});
/** Camera turn per Q/E press, rad. */
const KEY_TURN = Math.PI / 12;
/** The Move tool's node drag (`editor/nodeMover.ts`), previewed live and dropped as one undo step. */
const mover = new NodeMover({
  doc,
  net,
  settleTopology: () => {
    if (sim.topologyRevision !== net.trafficRevision) rebuildSimulationTopology();
  },
  mutate: (fn) => mutate(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
/**
 * The terrain brush (`editor/terrainBrush.ts`): the stroke in progress and
 * what each dab does. The flatten's level is captured ONCE, when the stroke
 * starts, so a drag across a slope brings the whole swept area to the height
 * it started from instead of each dab chasing the ground under itself.
 */
const terrainBrush = new TerrainBrush({
  doc,
  settings: () => dabSettings(),
  heightAt: (at) => sceneHeightAt(at),
  // The cost-aware rate limit: every dab that moves the land re-solves the
  // roads on it, and dabbing on every pointer sample queued rebuilds until the
  // player let go. During a stroke only the ground is rebuilt (`holdRoads`),
  // so it is the ground's own cost that paces the brush.
  interval: (stroking) => Math.max(TERRAIN_MIN_MS, (stroking ? scene.stats.terrainMs : scene.stats.rebuildMs) * 1.4),
  record: () => { history.record(doc); updateHistoryButtons(); },
  redraw: () => requestDraw(),
});
/** The brush in hand, as one dab reads it (`editor/terrainBrush.ts` `DabSettings`). */
function dabSettings(): DabSettings {
  const fog = fogBrush();
  return {
    mode: game.terrainMode,
    radius: game.terrainRadius,
    strength: game.terrainStrength,
    hardness: game.terrainHardness,
    landform: landformOf(game.terrainMode),
    element: { mode: elementMode(), kind: elementKind(), brush: elementBrush(elementKind()) },
    tree: { mode: treeMode(), kind: treeKind(), brush: treeBrush() },
    gully: { strength: Number((document.getElementById('gullyStrength') as HTMLInputElement | null)?.value ?? 60), erase: gullyErase() },
    fog: { strength: fog.strength, height: fog.height, speed: fog.speed, erase: fogErase() },
    paint: paintKind(),
    random: Math.random,
  };
}
canvas.dataset['tool'] = game.tool;

let view: Viewport = flatViewport(camera);


/**
 * The editor's overlay gets its OWN canvas, and must.
 *
 * Reusing the flat canvas looked free — a canvas hands out one context for its
 * whole life, so `getContext('2d')` would return the very context the flat
 * painter holds. But that context was created with `{ alpha: false }`
 * (`render/surface.ts`), and on an opaque context `clearRect` does not clear to
 * transparent, it clears to BLACK. Measured: the entire 3D scene disappeared
 * behind a black rectangle the moment the overlay drew its first frame.
 */
const overlayCanvas = document.createElement('canvas');
let overlayCtx: CanvasRenderingContext2D | null = null;
let previewAsphaltPattern: CanvasPattern | null = null;

/** Asphalt grain used by the live 3D-editor preview. */
function asphaltPreviewPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (previewAsphaltPattern) return previewAsphaltPattern;
  const tile = document.createElement('canvas');
  tile.width = 48;
  tile.height = 48;
  const paint = tile.getContext('2d');
  if (!paint) return '#45494b';
  paint.fillStyle = '#505456';
  paint.fillRect(0, 0, tile.width, tile.height);
  let state = 0x6d2b79f5;
  for (let i = 0; i < 150; i++) {
    state = (Math.imul(state ^ (state >>> 15), 2246822519) + 3266489917) >>> 0;
    const x = state % tile.width;
    const y = (state >>> 8) % tile.height;
    paint.globalAlpha = 0.08 + ((state >>> 17) & 15) / 100;
    paint.fillStyle = (state & 1) === 0 ? '#171a1b' : '#a4a6a3';
    paint.fillRect(x, y, 1 + ((state >>> 24) & 1), 1);
  }
  paint.globalAlpha = 1;
  previewAsphaltPattern = ctx.createPattern(tile, 'repeat');
  return previewAsphaltPattern ?? '#45494b';
}

const canvas3d = document.createElement('canvas');
canvas3d.id = 'game-scene';
canvas3d.setAttribute('aria-hidden', 'true');
canvas3d.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
canvas.parentElement?.insertBefore(canvas3d, canvas);
/** The quality the player last chose, or High: a level, never "automatic". */
function savedQualityLevel(): QualityLevel {
  try {
    const saved = window.localStorage.getItem('roadcraft.quality');
    return isQualityLevel(saved) ? saved : 'high';
  } catch {
    return 'high';
  }
}

// The graphics are what the player chose (High until they choose): the game
// never lowers them on its own.
primeSurfaceBake(await surfaceBake);
const scene: SceneHandle = createSceneRenderer(canvas3d, { x: camera.x, y: camera.y }, camera.zoom, savedQualityLevel(), requestDraw);
// The traffic's topology is not built here: it is built a slice a frame while
// the opening puts the town together (`TopologyCatchUp`, its frames not yet
// shown), the traffic held until it is in. Built here, its conflict zones
// held the first frame 423 ms.
// The people walk with the agents' engine (`sim/agents/walk.ts`), on lanes of
// the footways - the only pedestrian engine the game has (the People, Detour
// crowd and sidewalk-graph engines were taken out, the player's decision of
// 2026-10-08).
const engineFlags = new URLSearchParams(location.search);
sim.usePedestrianEngine((await import('@sim/agents/walk')).createAgentWalkEngine());
// The scenery's life (`sim/ambient`): nobody lives here; cars and people come
// in at the ends of the roads, as many as the panel says, cross the map and
// leave at another road end - never anywhere else (the player's order of
// 2026-10-06). People walk with the agents' walking engine. `?ambient=view`
// brings back GTA's way (made and taken away round the view) to compare. The
// residents' days are kept apart (`src/backup/residents`).
sim.ambient.enabled = true;
sim.ambient.source = engineFlags.get('ambient') === 'view' ? 'view' : 'edges';
view = scene.viewport;
restoreOrbit(savedSession?.settings.camera);
canvas.style.opacity = '0';
// No loading screen (player, 2026-10-02): the town plays at once and each
// person appears as their body is ready (cooked ahead, read back on demand).

overlayCanvas.id = 'game-overlay';
overlayCanvas.setAttribute('aria-hidden', 'true');
overlayCanvas.style.cssText =
  'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
canvas.parentElement?.appendChild(overlayCanvas);
overlayCtx = overlayCanvas.getContext('2d');

window.addEventListener('resize', () => { scene.resize(); syncPopulationShare(); }, { passive: true });
canvas.dataset['render'] = 'webgl';

// Modular buildings (docs/buildings.md): the tool, its palette, its overlay
// and the road-wins rule, wired in `buildingsWiring.ts`.
const buildings = createBuildingWiring({
  doc,
  net,
  history,
  scene,
  view: () => view,
  size: () => ({ w: surface.cssW, h: surface.cssH }),
  undo: () => undoButton.click(),
  redo: () => redoButton.click(),
  focusBuilding(building) {
    const ground = building.volumes.filter((v) => v.base === 0);
    if (ground.length === 0) return;
    const cx = (Math.min(...ground.map((v) => v.x)) + Math.max(...ground.map((v) => v.x + v.w))) / 2;
    const cy = (Math.min(...ground.map((v) => v.y)) + Math.max(...ground.map((v) => v.y + v.d))) / 2;
    const c = Math.cos(building.rotation), s = Math.sin(building.rotation);
    const centre = { x: building.x + cx * c - cy * s, y: building.y + cx * s + cy * c };
    view.moveTo(centre);
    const span = Math.max(...ground.map((v) => Math.max(v.w, v.d)));
    const paletteWidth = document.getElementById('builder')?.getBoundingClientRect().width ?? 0;
    const available = Math.max(110, surface.cssW - paletteWidth - (surface.cssW < 600 ? 20 : 110));
      const corners = building.volumes.flatMap((v) => [
        [v.x, v.y], [v.x + v.w, v.y], [v.x + v.w, v.y + v.d], [v.x, v.y + v.d],
      ] as const).map(([x, y]) => view.toScreen({ x: building.x + x * c - y * s, y: building.y + x * s + y * c }, surface.cssW, surface.cssH));
      const projectedWidth = Math.max(...corners.map((p) => p.x)) - Math.min(...corners.map((p) => p.x));
      const top = Math.max(...building.volumes.map((v) => levelElevation(building, volumeTop(v)) + roofRise(building, v)
        + Math.max(0, ...(v.roofDetails ?? []).map((detail) => detail.h ?? 0))));
      const projectedRise = Math.abs(view.toScreen(centre, surface.cssW, surface.cssH, top).y
        - view.toScreen(centre, surface.cssW, surface.cssH).y);
      const projectedFootprint = Math.max(...corners.map((p) => p.y)) - Math.min(...corners.map((p) => p.y));
      const fit = Math.min(view.zoom * (available * .72) / Math.max(1, projectedWidth),
        view.zoom * (surface.cssH - 145) * .88 / Math.max(1, projectedRise + projectedFootprint));
    const ideal = Math.min(surface.cssW < 600 ? 3.2 : 7, Math.max(2.6, (surface.cssW < 600 ? 135 : 210) / span));
    const target = Math.max(view.zoomBounds.min, Math.min(view.zoomBounds.max, ideal, fit));
    view.zoomAt(surface.cssW / 2, surface.cssH / 2, target / view.zoom, surface.cssW, surface.cssH);
      const rise = Math.abs(view.toScreen(centre, surface.cssW, surface.cssH, top).y
        - view.toScreen(centre, surface.cssW, surface.cssH).y);
      view.panTo(centre, (surface.cssW - paletteWidth) / 2, surface.cssH / 2 + rise / 2 - 68, surface.cssW, surface.cssH);
  },
  afterEdit() {
    persistence.saveSessionSoon(doc, sessionSettings);
    updateHistoryButtons();
    requestDraw();
  },
  requestDraw: () => requestDraw(),
  flash: (key, params) => flashHint(key, params),
  hintChanged: () => updateHint(),
});
/** The ground the camera sees: the screen's four corners, on the ground. */
function viewFootprint(): Vec2[] {
  const { cssW: w, cssH: h } = surface;
  return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => view.toWorld(x!, y!, w, h));
}

/** Puts the camera back at a saved bearing and tilt; a save without one gets the default view. */
function restoreOrbit(saved: SavedSettings['camera'] | undefined): void {
  view.setOrbit(saved?.azimuth ?? DEFAULT_AZIMUTH, saved?.elevation ?? DEFAULT_ELEVATION);
}

function syncViewFromFlatCamera(): void {
  view.moveTo({ x: camera.x, y: camera.y });
  view.zoomAt(
    surface.cssW / 2,
    surface.cssH / 2,
    camera.zoom / Math.max(0.001, view.zoom),
    surface.cssW,
    surface.cssH,
  );
}

function fitView(): void {
  camera.fit(worldBounds(), surface.cssW, surface.cssH);
  syncViewFromFlatCamera();
}

function syncFlatCameraFromView(): void {
  if (view.kind === '2d') return;
  const centre = view.centre;
  camera.x = centre.x;
  camera.y = centre.y;
  camera.zoom = view.zoom;
}

// ------------------------------------------------------------- mutations
function mutate(fn: () => boolean): void {
  mutateBuilt(fn);
}

/** The public transport tool (`editor/transitTools.ts`): each edit one undo step. */
const transitEditor = new TransitTool({
  doc: () => doc,
  net: () => net,
  edit: (next) => mutate(() => { doc.setTransit(next); return true; }),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
setTransitTool(transitEditor);

/** `mutate`, reporting whether the edit actually changed anything. */
/**
 * The document as text, kept while nothing in it has moved: every edit took
 * a snapshot of the whole document before and after (for undo), and the
 * "after" of one edit is the "before" of the next unless something changed
 * in between - which moves one of the document's revision counters.
 */
let docText: { key: string; text: string } | null = null;
function serializedDoc(): string {
  const key = [doc.revision, doc.trafficRevision, doc.terrainRevision, doc.paintRevision, doc.utilityRevision,
    doc.barrierRevision, doc.transitRevision, doc.zoneRevision, doc.lotRevision, doc.peopleRevision, doc.buildings.revision,
    doc.buildings.size, doc.zoneMarks.length, doc.landscape.size, doc.poles.size, doc.nodes.size, doc.segments.size].join(':');
  if (docText?.key === key) return docText.text;
  const text = serialize(doc);
  docText = { key, text };
  return text;
}

// The autosave writes the same text the undo keeps (`Persistence.documentText`).
persistence.documentText = (d) => (d === doc ? serializedDoc() : null);

function mutateBuilt(fn: () => boolean): boolean {
  const mutateAt = performance.now();
  const before = serializedDoc();
  performance.measure('hitch:mutate/before', { start: mutateAt, end: performance.now() });
  // What the diary says this edit came from (`world/changes.ts`).
  doc.changes.causeNext(`ferramenta ${game.tool}`);
  const changed = fn();
  doc.changes.causeNext('jogo');
  if (!changed) return false;
  // An edit that reports success without changing anything - the same lane
  // count, a split on an existing endpoint, a pole line traced over itself -
  // used to push an undo step and throw away the redo stack.
  docText = null;
  if (before === serializedDoc()) return false;
  history.recordText(before);
  performance.measure('hitch:mutate/edit+after', { start: mutateAt, end: performance.now() });
  // A pole or a wire moves `doc.utilityRevision`, not `doc.revision`: the
  // network is unchanged, and rebuilding it (and, behind it, the simulation
  // topology) cost about 330 ms per pole on a large map.
  if (net.revision !== doc.revision) net.rebuild();
  // A road over a building demolishes it, in this same undo step.
  buildings.afterRoadEdit();
  // The simulation catches up in the frame AFTER the one that draws the edit
  // (see `topologyAfterDraw`), so the player sees the road first.
  topologyAfterDraw = topologyAfterDraw || sim.topologyRevision !== net.trafficRevision;
  persistence.saveSessionSoon(doc, sessionSettings);
  updateHistoryButtons();
  updateStatus();
  refreshInspector();
  requestDraw();
  performance.measure('hitch:mutate/after edit', { start: mutateAt, end: performance.now() });
  return true;
}

/**
 * `snapshot`: the model's own undo/redo state, restored exactly. `import`:
 * data from outside (a file, the debug surface), where legacy repairs apply.
 */
function applySnapshot(data: ReturnType<RoadDoc['toJSON']> | null, source: 'snapshot' | 'import' = 'snapshot'): void {
  if (!data) return;
  roadTool.cancel();
  if (source === 'import') {
    caused('mapa aberto', () => restoreInto(doc, data, net));
    // A different map: nothing of the old simulation may carry over.
    sim.reset();
    sim.ambient.reset(sim);
  } else {
    restoreSnapshot(doc, data, net);
  }
  // Only when the road plan the simulation runs on actually changed.
  if (sim.topologyRevision !== net.trafficRevision) rebuildSimulationTopology();
  // A different map: the graph the next edit is measured on, built now.
  if (source === 'import') sim.warmTopologyPrep();
  buildings.restored();
  syncFogInputs();
  syncGullyInputs();
  syncWeatherInputs();
  select(null, game.selectedSegmentS, null, 'outro mapa');
  closeInspector();
  persistence.saveSessionSoon(doc, sessionSettings);
  updateHistoryButtons();
  updateStatus();
  requestDraw();
}

/** Keeps live agents bound when the UI rebuilds topology outside a sim tick. */
function rebuildSimulationTopology(): void {
  sim.rebuildTopology();
  rebindAgents(sim);
}

// ---------------------------------------------------------------- input
/**
 * The one conversion that differs between renderers.
 *
 * Everything downstream of it — `findAnchor`, `snapEndpoint`, every editor
 * command — already works in world coordinates, so this is the entire seam
 * between a flat view and an isometric one. `src/editor` needs no change at all.
 */
/**
 * The world point under a screen position, ON THE SURFACE THAT IS THERE.
 *
 * A tilted camera projects anything raised away from the ground beneath it: a
 * deck fifteen units up lands about thirteen units off, so solving on the
 * `y = 0` plane picked open ground thirteen units from the node plainly drawn
 * under the cursor. That is why an elevated road could not be extended — the
 * snap was looking in the wrong place, and no snap radius fixes an error that
 * grows with height.
 *
 * Two or three iterations settle it: solve on the ground plane, read how high
 * the scene is there, solve again on that plane. Under an orthographic camera
 * the correction is exactly linear in height, so it converges immediately.
 */
function worldAtScreen(px: number, py: number, heightOffset?: number): Vec2 {
  let point = view.toWorld(px, py, surface.cssW, surface.cssH);
  if (view.kind === '2d') return point;
  if (heightOffset === undefined) return firstSurfaceAt(px, py) ?? point;
  let height = 0;
  for (let pass = 0; pass < 3; pass++) {
    const next = scene.terrainHeightAt(point.x, point.y) + heightOffset;
    if (Math.abs(next - height) < 0.05) break;
    height = next;
    point = view.toWorldAt(px, py, height, surface.cssW, surface.cssH);
  }
  return point;
}

/**
 * The height of what is drawn under a screen point: the ray marched down from
 * over the highest mountain until it meets a surface, then bisected (the
 * cursor pick's own method, reaching the whole relief). A fixed point of
 * "the height under the cursor at that height" wandered off on a tilted view
 * over hills, and the zoom and the turn slid away from the pointer.
 */
function groundHeightUnder(at: Vec2): number {
  const point = (h: number): Vec2 => view.toWorldAt(at.x, at.y, h, surface.cssW, surface.cssH);
  const below = (h: number): boolean => { const p = point(h); return scene.surfaceHeightAt(p.x, p.y) >= h; };
  let above = Math.min(600, surfaceTop());
  for (let h = above - 8; h >= -360; h -= 8) {
    if (!below(h)) { above = h; continue; }
    let lo = h;
    for (let i = 0; i < 14; i++) { const mid = (lo + above) / 2; if (below(mid)) lo = mid; else above = mid; }
    return lo;
  }
  return 0;
}

/** Whatever the player can see at a world point: a road deck, or the ground. */
function sceneHeightAt(p: Vec2): number {
  return scene.surfaceHeightAt(p.x, p.y);
}

/** Highest surface the pick looks for, world units; step of the march down the ray. */
const PICK_TOP = 160;
const PICK_STEP = 2;

/**
 * The highest surface drawn anywhere - the ground's corners (the mesh is flat
 * between them, so its top is one of them) and every road's height at its
 * nodes - with a margin for the decks between nodes and the platforms graded
 * under buildings, once per road or land edit. The picks march down the ray
 * from here: from a fixed ceiling over the highest possible mountain they
 * sampled the scene a hundred times and more on every pointer move above
 * nothing at all.
 */
let surfaceTopFor = '';
let surfaceTopValue = PICK_TOP;
function surfaceTop(): number {
  // The land as drawn (`SceneHandle.landTop`, read again by the renderer when
  // it rewrites the ground); a road's cut and fill only brings the ground to
  // its deck, which the nodes' heights cover.
  const land = scene.landTop();
  const key = `${doc.revision}:${land}`;
  if (key === surfaceTopFor) return surfaceTopValue;
  surfaceTopFor = key;
  let top = land;
  for (const node of doc.nodes.values()) top = Math.max(top, scene.elevationAt(node.x, node.y));
  surfaceTopValue = Number.isFinite(top) ? top + 12 : PICK_TOP;
  return surfaceTopValue;
}

/**
 * Where the ray under the cursor first meets what is drawn - a deck, or the
 * ground - marched down from above. It used to be solved as a fixed point of
 * "the height at the point under the cursor at that height" over the nearest
 * road's deck height, which is defined everywhere: beside a raised road the
 * equation had a second answer on the far side of the deck, and a corner
 * clicked on the grass landed tens of metres away.
 */
function firstSurfaceAt(px: number, py: number): Vec2 | null {
  const at = (h: number): Vec2 => view.toWorldAt(px, py, h, surface.cssW, surface.cssH);
  const below = (h: number): boolean => {
    const p = at(h);
    return scene.surfaceHeightAt(p.x, p.y) >= h;
  };
  let above = Math.min(PICK_TOP, surfaceTop());
  for (let h = above - PICK_STEP; h >= -PICK_TOP; h -= PICK_STEP) {
    if (!below(h)) { above = h; continue; }
    let lo = h;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + above) / 2;
      if (below(mid)) lo = mid; else above = mid;
    }
    return at(lo);
  }
  return null;
}

/** `rect`: the canvas's box when the caller has already read it for this event (a layout read each). */
function pointerWorld(e: PointerEvent, rect?: DOMRect): Vec2 {
  const r = rect ?? canvas.getBoundingClientRect();
  const authoredHeight = game.tool === 'road' && roadTool.inProgress()
    ? game.roadHeightOffset
    : undefined;
  return worldAtScreen(e.clientX - r.left, e.clientY - r.top, authoredHeight);
}


/**
 * Ends every gesture in progress without committing it: a road being drawn or
 * chained, a pole line, a terrain stroke, a node drag, a pan, the Builder's
 * press. ONE list for every way a gesture can be cut short - a tool switch,
 * undo/redo, Escape, the right button, a pinch - where there used to be six
 * lists that disagreed (Ctrl+Z mid-drag kept moving a node of the restored
 * map; Escape left a terrain stroke stamping).
 */
function cancelGestures(): void {
  roadTool.cancel();
  poleTool.cancel();
  barrierTool.cancel();
  // A lot being drawn, dragged, cut or bent, or the first lot of a join: dropped.
  lotTool.cancel();
  bulldozer.cancel();
  endTerrainStroke();
  cancelMove();
  cameraHand.cancel();
  if (game.tool === 'building') buildings.pointerUp(true);
  requestDraw();
}

/**
 * The gesture in progress, named: what the player is in the middle of
 * doing, read from the same variables `cancelGestures` ends. Written to the
 * game's state after every pointer and key event (`syncGesture`): since a
 * value set to what it already is writes nothing, the record holds where
 * each gesture began and ended, with the tool in hand - so a defect can be
 * traced back to what the player was doing when it happened.
 */
function currentGesture(): string | null {
  const camera = cameraHand.gesture();
  if (camera) return camera;
  const movingNode = mover.gesture();
  if (movingNode) return movingNode;
  const road = roadTool.gesture();
  if (road) return road;
  if (terrainBrush.stroking) return 'terreno: pincelando';
  const pole = poleTool.gesture();
  if (pole) return pole;
  const barrier = barrierTool.gesture();
  if (barrier) return barrier;
  const bulldozing = bulldozer.gesture();
  if (bulldozing) return bulldozing;
  const cloud = cloudTool.gesture();
  if (cloud) return cloud;
  return lotTool.gesture();
}
function syncGesture(): void {
  // Before the boot the file may not have run to the gestures' own variables.
  if (!booted) return;
  gameState.set('gesture', currentGesture(), `ferramenta ${game.tool}`);
}
// After the event's own handlers: a task of its own, after the whole dispatch.
// (A microtask would not do: the browser runs them after each listener, so one
// queued from this capturing listener ran BEFORE the handlers it was to follow.)
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'keyup'] as const) {
  window.addEventListener(type, () => setTimeout(syncGesture, 0), { capture: true, passive: true });
}
/**
 * What the diary says a change came from (`world/changes.ts` `causeNext`):
 * during a click or a key, the tool in hand and the gesture, set before any
 * handler runs and put back after the event; between events, the game
 * itself ("jogo"), unless the work says what it is (`caused`).
 */
const NO_CAUSE = 'jogo';
for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown'] as const) {
  window.addEventListener(type, () => {
    if (!booted) return;
    doc.changes.causeNext(`ferramenta ${game.tool}${game.gesture ? `: ${game.gesture}` : ''}`);
    setTimeout(() => doc.changes.causeNext(NO_CAUSE), 0);
  }, { capture: true, passive: true });
}
/** Runs `fn` with the diary's cause set to `cause`, then puts the one before back. */
function caused<T>(cause: string, fn: () => T): T {
  const was = doc.changes.cause;
  doc.changes.causeNext(cause);
  try {
    return fn();
  } finally {
    doc.changes.causeNext(was);
  }
}

/** The bulldozer (`editor/bulldozer.ts`): a click removes what is under it, a box everything inside. */
const bulldozer = new Bulldozer({
  doc,
  net,
  bulldozeBuildingAt: (at) => buildings.bulldozeAt(at),
  poleReach: () => poleReach(),
  itemReach: () => streetscapeTool.reach(),
  mutate: (fn) => mutate(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});

/** Whether anything is being drawn or dragged right now. */
function gestureInProgress(): boolean {
  return roadTool.inProgress() || poleTool.inProgress() || terrainBrush.stroking || mover.dragging || lotTool.gesture() !== null || bulldozer.inProgress();
}

/**
 * A press whose release will never arrive - the window lost focus, the pointer
 * capture was taken - ends what the held button was doing. A terrain stroke
 * kept stamping every 110 ms after an alt-tab with the button down.
 */
function releaseHeld(): void {
  endTerrainStroke();
  cancelMove();
  cameraHand.releaseAll();
}

/** Cancels a node drag without leaving its live preview in the document. */
function cancelMove(): void {
  mover.cancel();
}


// The element brush's settings (Paisagem > Terreno > Elementos), each kind its
// own (`ui/toolChoices.ts`); the sliders show the chosen kind's.
{
  const keys = { elDensity: 'density', elSize: 'size', elVariation: 'variation', elSpacing: 'spacing', elStrength: 'strength', elIntensity: 'intensity' } as const;
  for (const [id, key] of Object.entries(keys) as [keyof typeof keys, (typeof keys)[keyof typeof keys]][]) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    input?.addEventListener('input', () => {
      setElementBrush({ [key]: Number(input.value) });
      text(`${id}Value`, input.value);
    });
  }
  syncElementInputs();
  (document.getElementById('clearElements') as HTMLButtonElement | null)?.addEventListener('click', () => {
    if (doc.elements.length === 0) return;
    if (!window.confirm(t('confirm.clearElements'))) return;
    history.record(doc);
    doc.clearElements();
    updateHistoryButtons();
    persistence.saveSessionSoon(doc, sessionSettings);
    requestDraw();
  });
}

// THE CLOUD TOOL (Paisagem > Terreno > Nuvens): a click puts a cloud in the
// sky right under the pointer, drags one to move it, sets one to the tool's
// size, height and density, or takes one away (`world/clouds.ts`). Each is
// one undo step. A cloud is found where the pointer's ray crosses its body.
const cloudTool = new CloudTool({
  doc,
  mode: () => cloudMode(),
  brush: () => cloudBrush(),
  drift: () => scene.cloudDrift(),
  rayAt: (px, py, height) => view.toWorldAt(px, py, height, surface.cssW, surface.cssH),
  record: () => history.record(doc),
  changed: () => {
    updateHistoryButtons();
    persistence.saveSessionSoon(doc, sessionSettings);
    requestDraw();
  },
  hint: (key) => flashHint(key),
});
{
  const bind = (id: string, read: () => number, write: (v: number) => void): void => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) return;
    input.value = String(read());
    text(`${id}Value`, String(read()));
    input.addEventListener('input', () => {
      write(Number(input.value));
      text(`${id}Value`, input.value);
    });
  };
  bind('cloudSize', () => cloudBrush().size, (v) => setCloudBrush({ size: v }));
  bind('cloudHeight', () => cloudBrush().height, (v) => setCloudBrush({ height: v }));
  bind('cloudDensity', () => cloudBrush().density, (v) => setCloudBrush({ density: v }));
  // Spread clouds over the sky: as many as asked, about the tool's size,
  // height and density, varied - each one then to move, set or take away.
  (document.getElementById('scatterClouds') as HTMLButtonElement | null)?.addEventListener('click', () => {
    const count = Number((document.getElementById('cloudCount') as HTMLInputElement | null)?.value ?? 8);
    const variation = Number((document.getElementById('cloudVariation') as HTMLInputElement | null)?.value ?? 40) / 100;
    const brush = cloudBrush();
    const laid = scatterClouds(count, {
      size: brush.size * UNITS_PER_METER, height: brush.height * UNITS_PER_METER, density: brush.density / 100,
    }, variation, MAP_SIZE / 2, doc.clouds, Math.random);
    history.record(doc);
    const added = doc.addClouds(laid);
    if (added < count) flashHint('hint.cloud.full');
    updateHistoryButtons();
    persistence.saveSessionSoon(doc, sessionSettings);
    requestDraw();
  });
  for (const id of ['cloudCount', 'cloudVariation']) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    input?.addEventListener('input', () => text(`${id}Value`, input.value));
  }
  (document.getElementById('clearClouds') as HTMLButtonElement | null)?.addEventListener('click', () => {
    if (doc.clouds.length === 0) return;
    if (!window.confirm(t('confirm.clearClouds'))) return;
    history.record(doc);
    for (const cloud of [...doc.clouds]) doc.removeCloud(cloud.id);
    updateHistoryButtons();
    persistence.saveSessionSoon(doc, sessionSettings);
    requestDraw();
  });
}

/** Ends the brush stroke (`TerrainBrush.end`), warning when the land's stamps near their cap. */
function endTerrainStroke(): void {
  const wasPainting = terrainBrush.end();
  // Past the cap the oldest sculpting is dropped to make room. Say so before
  // it happens rather than erase the player's first hills in silence.
  if (wasPainting && doc.terrainStamps.length >= MAX_TERRAIN_STAMPS * 0.9) {
    flashHint(doc.terrainStamps.length >= MAX_TERRAIN_STAMPS ? 'hint.terrain.capReached' : 'hint.terrain.capNear');
  }
  // The roads were held for the stroke; this frame re-solves them.
  requestDraw();
}

// See inside a building by clicking it, with nothing in hand: two clicks open
// it (two on open ground close it); while one is open, a click on another
// opens that one instead.
canvas.addEventListener('dblclick', (e) => {
  // A double click ends a track or a line being laid (`pointerdown` carries no click count).
  if (game.tool === 'transit') { transitEditor.key('Enter'); return; }
  if (game.tool !== 'inspect') return;
  const r = canvas.getBoundingClientRect();
  buildings.insideClick({ x: e.clientX - r.left, y: e.clientY - r.top }, true);
});
canvas.addEventListener('click', (e) => {
  if (game.tool !== 'inspect' || e.detail > 1) return;
  const r = canvas.getBoundingClientRect();
  buildings.insideClick({ x: e.clientX - r.left, y: e.clientY - r.top }, false);
});
canvas.addEventListener('pointerdown', (e) => {
  // The mouse's back and forward buttons are not a click: they used to fall
  // through to the tool as if they were the left button.
  if (e.pointerType === 'mouse' && e.button > 2) return;
  canvas.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect();
  cameraHand.press(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });

  // A second finger promotes the gesture to pinch and cancels any draft. A
  // third finger is part of the pinch too: at size 3 it used to fall through to
  // the tool, and Bulldoze demolished the road under it.
  if (cameraHand.touches >= 2) {
    cancelGestures();
    cameraHand.startPinch();
    return;
  }

  // The mouse, as city builders have it: the right button dragged swings
  // the camera round and over the centre of the view (Shift with it pans);
  // a right CLICK - pressed and let go without moving - cancels whatever is
  // in progress. The middle button dragged pans. Both work mid-gesture, so a
  // road half placed can still be looked round.
  if (e.pointerType === 'mouse' && e.button === 2 && !e.shiftKey) {
    if (game.tool === 'building' && buildings.cancelOperation()) {
      requestDraw();
      return;
    }
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    // The camera turns about the ground under the pointer, at its own height.
    cameraHand.startOrbit(e.pointerId, at, gestureInProgress(), groundHeightUnder(at));
    return;
  }

  if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) {
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    cameraHand.startPan(e.pointerId, at);
    return;
  }

  const world = pointerWorld(e);
  if (game.tool === 'road') roadTool.pointerAt({ x: e.clientX - r.left, y: e.clientY - r.top });
  // A curve waiting for its bend: this press sets it.
  if (game.tool === 'road' && roadTool.bend(world)) return;
  const anchor = findAnchor(doc, net, world, view.zoom);

  switch (game.tool) {
    case 'roundabout':
      if (freeRoadsEnabled()) {
        mutate(() => {
          const result = commitRoundabout(doc, net, world, game.roundaboutRadius, 0);
          if (!result.committed) flashHint(`hint.roundabout.${result.reason}`);
          return result.committed;
        });
      }
      break;
    case 'road':
      if (blockGridChoice.armed) {
        // Vias > Quarteirões: the whole grid, centred where the click lands.
        blockGridChoice.armed = false;
        let laid = 0;
        mutate(() => {
          laid = commitBlockGrid(doc, world, blockGridChoice, game.roadTypeIndex, game.roadLanePreset, roadParking());
          return laid > 0;
        });
        flashHint(laid > 0 ? 'hint.blocks.built' : 'hint.road.invalid');
        refreshShell();
        requestDraw();
        break;
      }
      roadTool.down(world, anchor);
      break;

    case 'terrain':
      if (game.terrainMode === 'cloud') cloudTool.down(e.pointerId, e.clientX - r.left, e.clientY - r.top);
      // The weather tool: a click calls a lightning bolt down there.
      else if (game.terrainMode === 'weather') scene.strikeAt(world.x, world.y);
      else terrainBrush.begin(e.pointerId, world);
      break;

    case 'building':
      buildings.pointerDown({ x: e.clientX - r.left, y: e.clientY - r.top }, world, e.shiftKey);
      break;

    case 'zone':
      lotTool.down(e.pointerId, world, e.shiftKey, e.detail);
      break;

    case 'transit':
      // Stops, tracks, stations, lines (`editor/transitTools.ts`).
      transitEditor.click(world, e.shiftKey, e.detail >= 2);
      break;

    case 'barrier':
      barrierTool.down(world, e.shiftKey, e.clientX, e.clientY, e.detail);
      break;

    case 'streetscape':
      streetscapeTool.down(world, e.shiftKey);
      break;

    case 'pole':
      // A stretch starts (at the line's last pole, if there is one); Shift-click
      // or the Remove verb takes a pole away (`editor/poles.ts` `PoleTool`).
      poleTool.down(world, e.shiftKey);
      break;

    case 'move':
      if (anchor.kind === 'node' && anchor.node !== undefined) {
        mover.grab(anchor.node);
      } else {
        cameraHand.startPan(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
      }
      break;

    case 'split':
      if (
        anchor.kind === 'segment' &&
        anchor.segment !== undefined &&
        anchor.s !== undefined
      ) {
        let node: NodeId | null = null;
        mutate(() => {
          node = splitSegment(doc, net, anchor.segment as SegmentId, anchor.s as number, anchor.at);
          return node !== null;
        });
        if (node !== null) {
          select(null, game.selectedSegmentS, node, 'via dividida');
          showInspector();
        }
      }
      break;

    case 'bulldoze':
      // The Actions' bomb and pistol: what they leave behind (bodies, blood,
      // blasts, ruins) is loaded the first time either is used
      // (`SceneHandle.effects`), then the blow or the shot lands.
      if (strikeChoice.mode === 'strike') {
        const sx = e.clientX - r.left, sy = e.clientY - r.top, at = { ...world };
        void scene.effects().then(() => actions.strikeAt(sx, sy, at));
        break;
      }
      if (strikeChoice.mode === 'shoot') {
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        void scene.effects().then(() => actions.shootAt(sx, sy));
        break;
      }
      // A click removes what is under it; a drag draws a box and removes
      // everything inside it, as SimCity's bulldozer does (on release).
      bulldozer.down(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top }, world, anchor);
      break;

    case 'upgrade':
      if (anchor.kind === 'segment' && anchor.segment !== undefined) {
        const id = anchor.segment;
        const seg = doc.segment(id);
        if (seg && seg.type < LAST_UPGRADE_CLASS) {
          mutate(() => {
            doc.setSegmentType(id, seg.type + 1);
            return true;
          });
        }
      }
      break;

    case 'control':
      if (anchor.kind === 'node' && anchor.node !== undefined) {
        cycleNodeControl(anchor.node, e.shiftKey ? -1 : 1);
      } else {
        flashHint('hint.control.miss');
      }
      break;

    case 'inspect': {
      const box = canvas.getBoundingClientRect();
      // A click on a building is for seeing inside it (the click handlers
      // above), not for the street that happens to run past it.
      const hitBuilding = buildings.tool.buildingAt({ x: e.clientX - box.left, y: e.clientY - box.top });
      if (hitBuilding !== null) {
        // Shift+click: maintenance - the building is renovated, as new.
        if (e.shiftKey) {
          const b = doc.buildings.get(hitBuilding as BuildingId);
          if (b) {
            mutate(() => { doc.buildings.put({ ...b, builtAt: sim.city.minutes(sim), decay: 0 }); return true; });
            flashHint('hint.building.renovated');
          }
        }
        break;
      }
    }
      select(anchor.kind === 'segment' ? (anchor.segment ?? null) : null,
        anchor.kind === 'segment' ? (anchor.s ?? null) : null,
        anchor.kind === 'node' ? (anchor.node ?? null) : null, 'clique de inspeção');
      showInspector();
      break;
  }
  requestDraw();
});

window.addEventListener('blur', releaseHeld);
canvas.addEventListener('lostpointercapture', (e) => {
  // After an ordinary release the pointer is already gone from the map.
  if (cameraHand.has(e.pointerId)) releaseHeld();
});

canvas.addEventListener('pointermove', (e) => {
  // A mouse whose button is no longer down has ended its stroke, whether or
  // not the release reached us.
  if (e.pointerType === 'mouse' && e.buttons === 0 && terrainBrush.stroking) endTerrainStroke();
  const r = canvas.getBoundingClientRect();
  const screen: Vec2 = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (game.tool === 'road') roadTool.pointerAt(screen);
  // A pinch, an orbit or a pan takes the move first.
  if (cameraHand.move(e.pointerId, screen)) return;

  const world = pointerWorld(e, r);

  if (lotTool.move(e.pointerId, world)) return;
  if (bulldozer.move(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top }, world)) return;
  if (game.tool === 'zone') {
    lotTool.hover = world;
    requestDraw();
  }

  // The curve's bend follows the pointer.
  if (game.tool === 'road' && roadTool.bending()) {
    roadTool.move(world);
    return;
  }

  if (game.tool === 'building') {
    buildings.pointerMove(screen, world, e.shiftKey);
    return;
  }

  // The stroke being drawn.
  if (roadTool.move(world)) return;

  if (game.tool === 'barrier') barrierTool.move(world);
  if (game.tool === 'transit') {
    transitEditor.move(world);
    requestDraw();
  }

  if (poleTool.move(world)) return;

  if (game.tool === 'streetscape') {
    streetscapeTool.move(world);
    return;
  }

  if (mover.move(world)) return;


  if (terrainBrush.pointer === e.pointerId) {
    terrainBrush.paint(world);
    return;
  }
  if (cloudTool.pointer === e.pointerId) {
    const rect = canvas.getBoundingClientRect();
    cloudTool.move(e.clientX - rect.left, e.clientY - rect.top);
    return;
  }

  // The hover preview uses the same height-aware connection rule as the commit.
  const hovered = findAnchor(doc, net, world, view.zoom, undefined,
    game.tool === 'road' ? game.roadHeightOffset : undefined);
  if (game.tool === 'road') roadTool.hover(world);
  hoverAnchor = game.tool === 'terrain'
    ? { kind: 'free', at: world }
    : game.tool === 'road'
      ? anchorForHeight(doc, net, hovered, game.roadHeightOffset)
      : hovered;
  requestDraw();
});

/** Pick radius for a pole, in world units at the current zoom (`PoleTool.reach`: one definition). */
function poleReach(): number {
  return poleTool.reach();
}

function endPointer(e: PointerEvent): void {
  const cancelled = e.type === 'pointercancel';
  const { wasPinching, clickCancels } = cameraHand.release(e.pointerId);
  // A right click that stayed a click cancels whatever is in progress.
  if (clickCancels && !cancelled) {
    cancelGestures();
    return;
  }
  if (terrainBrush.pointer === e.pointerId) endTerrainStroke();
  cloudTool.up(e.pointerId);
  if (game.tool === 'building') buildings.pointerUp(cancelled || wasPinching);
  bulldozer.up(e.pointerId, !cancelled && !wasPinching);
  lotTool.up(e.pointerId, !cancelled && !wasPinching);
  // The stroke let go: a click starts a chain, a curve waits for its bend, a drag is laid.
  roadTool.up(() => pointerWorld(e), !cancelled && !wasPinching);

  poleTool.up(!cancelled && !wasPinching);

  // The node dropped: one undo step from where it started.
  mover.drop(!cancelled && !wasPinching);
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
}

canvas.addEventListener('pointerup', endPointer);
// Nothing to aim at off the map: no hover preview left behind on it.
canvas.addEventListener('pointerleave', () => {
  if (hoverAnchor) {
    hoverAnchor = null;
    requestDraw();
  }
});
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    // The wheel zooms, whatever tool is in hand (the player, 2026-10-06); with
    // the landscape tool, Shift+wheel sizes the brush and Alt+wheel sets its
    // strength. With Shift held a browser may scroll sideways: either axis.
    if (game.tool === 'terrain' && (e.shiftKey || e.altKey)) {
      const notches = -Math.sign(e.deltaY || e.deltaX);
      if (e.altKey) setTerrainStrength(game.terrainStrength + notches);
      else setTerrainRadius(game.terrainRadius + notches * 10);
      return;
    }
    const r = canvas.getBoundingClientRect();
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    // About the ground under the pointer at its real height: on the plane at
    // zero a hill or a chapada under the pointer slid away as the view zoomed.
    view.zoomAt(at.x, at.y, Math.exp(-e.deltaY * 0.0013), surface.cssW, surface.cssH, groundHeightUnder(at));
    persistence.saveSettingsSoon(sessionSettings);
    requestDraw();
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  const meta = e.ctrlKey || e.metaKey;

  // The building tool's own keys (R, +/-, Delete, Ctrl+C/V/D, 1-4) first.
  if (game.tool === 'building' && buildings.key(e)) {
    e.preventDefault();
    return;
  }

  // A run being traced: Enter ends it, Backspace takes the last point back,
  // Esc drops it.
  if (!meta && game.tool === 'transit' && transitEditor.key(e.key)) { e.preventDefault(); return; }
  if (!meta && game.tool === 'barrier' && barrierTool.key(e.key)) { e.preventDefault(); return; }

  if (!meta && game.tool === 'road' && (e.key === 'PageUp' || e.key === 'PageDown')) {
    e.preventDefault();
    roadTool.stepHeight(e.key === 'PageUp' ? 1 : -1);
    return;
  }

  if (!meta && game.tool === 'inspect' && game.selectedNode !== null &&
    doc.node(game.selectedNode)?.smooth && (e.key === 'PageUp' || e.key === 'PageDown')) {
    e.preventDefault();
    const current = doc.requireNode(game.selectedNode).heightOffset / UNITS_PER_METER;
    setNodeHeightMetres(game.selectedNode, current + (e.key === 'PageUp' ? 1 : -1));
    return;
  }

  // Turning the view is only offered where there is something to turn. The flat
  // viewport answers `rotate` with nothing rather than pretending.
  // Q/E turn the camera by 15 degrees, Shift by a quarter turn. Home (below,
  // with the arrows) puts it back where the game starts and frames the map.
  if (!meta && (e.key === 'q' || e.key === 'Q' || e.key === 'e' || e.key === 'E')) {
    const sign = e.key.toLowerCase() === 'q' ? -1 : 1;
    view.orbit(sign * (e.shiftKey ? Math.PI / 2 : KEY_TURN), 0);
    persistence.saveSettingsSoon(sessionSettings);
    requestDraw();
    return;
  }

  if (meta && e.key.toLowerCase() === 's') {
    e.preventDefault();
    (document.getElementById('saveMap') as HTMLButtonElement).click();
    return;
  }
  if (meta && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    (document.getElementById('openMap') as HTMLButtonElement).click();
    return;
  }
  if (meta && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelectedSegment();
    return;
  }

  if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undoButton.click();
    return;
  }
  if (meta && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    redoButton.click();
    return;
  }

  // Delete removes what Inspect has picked: the road it shows.
  if (!meta && (e.key === 'Delete' || e.key === 'Backspace') && game.tool === 'inspect' && game.selectedSegment !== null) {
    e.preventDefault();
    const id = game.selectedSegment;
    (document.getElementById('closeInspector') as HTMLButtonElement).click();
    mutate(() => {
      doc.removeSegment(id);
      doc.pruneOrphanNodes();
      return true;
    });
    return;
  }

  // Space pauses and resumes, as in every simulation game. A button the
  // player reached with the keyboard keeps Space for itself; one merely
  // clicked with the mouse (and so still focused) must not swallow it.
  if (!meta && e.key === ' ') {
    const target = e.target as HTMLElement | null;
    if (target instanceof HTMLButtonElement && focusCameFromKeyboard()) return;
    e.preventDefault();
    target?.blur?.();
    trafficButton.click();
    return;
  }

  // While sculpting, the number row picks the OPERATION. The road palette is
  // hidden in that mode, so binding the digits to road classes there was a
  // shortcut to something the player cannot see.
  if (game.tool === 'terrain') {
    const modes: readonly BrushMode[] = ['raise', 'lower', 'flatten', 'river', 'paint', 'mesa', 'canyon', 'escarpment', 'sugarloaf', 'fog', 'cloud', 'elements', 'gully', 'trees', 'weather'];
    const chosen = modes[Number(e.key) - 1];
    if (chosen) {
      setTerrainMode(chosen);
      return;
    }
    if (e.key === '[' || e.key === ']') {
      setTerrainRadius(game.terrainRadius + (e.key === ']' ? 10 : -10));
      return;
    }
    // Shift with the brackets: the strength (the wheel only zooms now).
    if (e.key === '{' || e.key === '}') {
      setTerrainStrength(game.terrainStrength + (e.key === '}' ? 1 : -1));
      return;
    }
    if (e.key === '-' || e.key === '_' || e.key === '=' || e.key === '+') {
      setTerrainStrength(game.terrainStrength + (e.key === '=' || e.key === '+' ? 1 : -1));
      return;
    }
  }

  const digit = Number(e.key);
  if (digit >= 1 && digit <= ROAD_TYPES.length) {
    // The class palette is shown only with the road tool, so choosing a class
    // from another tool also picks up the tool that draws it.
    if (game.tool !== 'road') setTool('road');
    selectRoadType(digit - 1);
    return;
  }

  // F8: what changed, where (`drawChanges`).
  if (e.key === 'F8') {
    showChanges = !showChanges;
    requestDraw();
    return;
  }

  // R is the building's rotation and nothing else; the road tool is the
  // number row, which also picks the class (above).
  const shortcuts: Record<string, Tool> = {
    u: 'upgrade',
    m: 'move',
    x: 'split',
    b: 'bulldoze',
    c: 'control',
    t: 'terrain',
    i: 'inspect',
    p: 'pole',
    g: 'streetscape',
    f: 'barrier',
    z: 'zone',
    h: 'building',
    o: 'transit',
  };
  const next = shortcuts[e.key.toLowerCase()];
  if (next) pickTool(next);
});

// -------------------------------------------------------------------- ui
const roadTypesEl = document.getElementById('roadTypes') as HTMLElement;

/** Every class, drawn: the tile shows the road the class lays. */
ROAD_TYPES.forEach((rt, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'road-type' + (i === game.roadTypeIndex ? ' active' : '');
  b.dataset['typeIndex'] = String(i);
  // Its total width in metres, which the width stepper starts from.
  b.dataset['widthM'] = String(Math.round((rt.width + rt.sidewalk * 2) * METERS_PER_UNIT));
  b.setAttribute('aria-pressed', String(i === game.roadTypeIndex));
  b.setAttribute('aria-label', `${roadTypeName(rt)}: ${roadTypeDescription(rt)}`);
  b.innerHTML = `<img class="road-type-art" src="${roadSwatch(rt)}" alt="" /><span class="road-type-name"></span>`;
  b.querySelector('.road-type-name')!.textContent = roadTypeName(rt);
  b.title = `${roadTypeName(rt)} — ${roadTypeDescription(rt)}`;
  b.onclick = () => selectRoadType(i);
  roadTypesEl.appendChild(b);
});

/**
 * What can be done to a road once it is drawn, at the end of the row of
 * classes: the same gesture a player makes, in the place they are looking.
 */
for (const [op, icon] of [
  ['upgrade', '<path d="M12 4v16M4 12h16"/><path d="m8 8 4-4 4 4"/>'],
  ['move', '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3m-6 12 3 3 3-3m3-9 3 3-3 3M6 9l-3 3 3 3"/>'],
  ['split', '<path d="M4 7h16M4 17h16"/><path d="M12 3v18"/><path d="m9 10 3 3 3-3"/>'],
  ['control', '<rect x="8" y="3" width="8" height="15" rx="2"/><path d="M12 18v3"/><circle cx="12" cy="7" r="1.4"/><circle cx="12" cy="10.6" r="1.4"/><circle cx="12" cy="14.2" r="1.4"/>'],
  ['roundabout', '<circle cx="12" cy="12" r="6"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4m-9-7 3 1-2 3"/>'],
] as const) {
  if (op === 'roundabout' && !freeRoadsEnabled()) continue;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'road-type road-op';
  b.dataset['roadOp'] = op;
  b.setAttribute('aria-pressed', 'false');
  b.setAttribute('aria-keyshortcuts', t(`tool.${op}`).charAt(0));
  b.innerHTML = `<span class="road-type-art op"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span><span class="road-type-name"></span>`;
  b.querySelector('.road-type-name')!.textContent = t(`tool.${op}`);
  b.title = t(`tool.${op}`);
  roadTypesEl.appendChild(b);
}

/**
 * Interface v2: what the road tool does is a row of modes at the top of its
 * panel - draw, improve, move, split, junctions, roundabout - as Cities:
 * Skylines II puts its tool modes apart from its road catalogue. The
 * operations no longer sit among the road classes as if they were roads.
 */
const roadModes = document.createElement('div');
roadModes.className = 'road-modes';
roadModes.setAttribute('role', 'group');
const roadModeNote = document.createElement('p');
roadModeNote.className = 'road-mode-note';
if (UI_V2) {
  for (const op of ['road', 'upgrade', 'move', 'split', 'control', 'roundabout'] as const) {
    if (op === 'roundabout' && !freeRoadsEnabled()) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'road-mode';
    b.dataset['roadMode'] = op;
    b.textContent = op === 'road' ? t('tool.draw') : t(`tool.${op}`);
    b.onclick = () => pickTool(op);
    roadModes.appendChild(b);
  }
  document.getElementById('paletteBody')?.prepend(roadModes, roadModeNote);
}
function syncRoadModes(current: Tool): void {
  if (!UI_V2) return;
  for (const b of roadModes.querySelectorAll<HTMLButtonElement>('[data-road-mode]')) {
    const on = b.dataset['roadMode'] === current;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  // Each mode shows only its own options: drawing has them all, improving
  // keeps the class to improve to, and the rest work by a click on the map.
  const palette = document.querySelector<HTMLElement>('.road-palette');
  if (palette) palette.dataset['roadMode'] = current;
  // The head's hint already says what a click does in this mode.
  roadModeNote.textContent = '';
  roadModeNote.hidden = roadModeNote.textContent === '';
}

const roundaboutSettings = document.createElement('label');
roundaboutSettings.className = 'inspect-range';
roundaboutSettings.hidden = true;
roundaboutSettings.innerHTML = '<span data-i18n="road.roundabout.radius"></span><output>40 m</output><input type="range" min="32" max="128" step="4" value="40" />';
roundaboutSettings.querySelector('span')!.textContent = t('road.roundabout.radius');
const roundaboutSize = roundaboutSettings.querySelector('input')!;
roundaboutSize.oninput = () => {
  gameState.set('roundaboutRadius', Number(roundaboutSize.value) * UNITS_PER_METER, 'tamanho da rotatória');
  roundaboutSettings.querySelector('output')!.value = `${roundaboutSize.value} m`;
  requestDraw();
};
document.getElementById('paletteBody')?.prepend(roundaboutSettings);

/**
 * The lanes a road is laid at. The count is stored per segment, so a street
 * can be four lanes wide while the avenue beside it is six; the last choice
 * is the class that carries a central reservation (`game.roadLanePreset`).
 */
const MEDIAN_CLASS = ROAD_TYPES.findIndex((rt) => rt.median > 0);
const roadLanesEl = document.getElementById('roadLanes') as HTMLElement;
const LANE_CHOICES: readonly { readonly id: string; readonly lanes: number | null }[] = [
  { id: '2', lanes: 2 },
  { id: '4', lanes: 4 },
  { id: '6', lanes: 6 },
  { id: 'median', lanes: null },
];
for (const choice of LANE_CHOICES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'road-lane';
  b.dataset['laneChoice'] = choice.id;
  b.setAttribute('aria-pressed', 'false');
  const sample = choice.lanes === null
    ? roadType(MEDIAN_CLASS)
    : roadProfile(game.roadTypeIndex, choice.lanes);
  const laneLabel = choice.lanes === null ? t('palette.lanes.median') : t('palette.lanes.count', { count: choice.lanes });
  b.innerHTML = `<img src="${roadSwatch(sample, 74, 38)}" alt="" /><span></span>`;
  b.querySelector('span')!.textContent = laneLabel;
  b.title = laneLabel;
  b.onclick = () => {
    gameState.set('roadLanePreset', choice.lanes, 'faixas escolhidas');
    if (choice.lanes === null) selectRoadType(MEDIAN_CLASS);
    updateLaneChoices();
    refreshLaneSwatches();
    requestDraw();
  };
  roadLanesEl.appendChild(b);
}

function updateLaneChoices(): void {
  for (const b of roadLanesEl.querySelectorAll<HTMLButtonElement>('.road-lane')) {
    const id = b.dataset['laneChoice'];
    const choice = LANE_CHOICES.find((c) => c.id === id);
    // With no count chosen, the class's own count is the one in hand: the row
    // says what the next road will actually be laid as.
    const on = choice !== undefined && (
      choice.lanes === null
        ? game.roadLanePreset === null && game.roadTypeIndex === MEDIAN_CLASS
        : game.roadTypeIndex !== MEDIAN_CLASS && choice.lanes === (game.roadLanePreset ?? roadType(game.roadTypeIndex).lanes)
    );
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

/** The pictures redraw against the class in hand, so they read as its widths. */
function refreshLaneSwatches(): void {
  for (const b of roadLanesEl.querySelectorAll<HTMLButtonElement>('.road-lane')) {
    const choice = LANE_CHOICES.find((c) => c.id === b.dataset['laneChoice']);
    if (!choice) continue;
    const img = b.querySelector('img');
    if (!img) continue;
    const sample = choice.lanes === null ? roadType(MEDIAN_CLASS) : roadProfile(game.roadTypeIndex, choice.lanes);
    img.src = roadSwatch(sample, 74, 38);
    const label = b.querySelector('span');
    if (label) label.textContent = choice.lanes === null
      ? t('palette.lanes.median')
      : t('palette.lanes.count', { count: choice.lanes });
  }
}

/**
 * The classes roll past under the fixed plan. The arrows page the strip; when
 * every class already fits they fade out rather than disappear, so the row
 * never changes width under the pointer.
 */
const roadCarousel = roadTypesEl.parentElement as HTMLElement;
function updateCarousel(): void {
  const room = roadTypesEl.scrollWidth - roadTypesEl.clientWidth;
  roadCarousel.classList.toggle('scrollable', room > 1);
  roadCarousel.classList.toggle('at-start', roadTypesEl.scrollLeft <= 1);
  roadCarousel.classList.toggle('at-end', roadTypesEl.scrollLeft >= room - 1);
}
for (const step of document.querySelectorAll<HTMLButtonElement>('.carousel-step')) {
  step.onclick = () => {
    const page = Math.max(180, roadTypesEl.clientWidth * 0.75) * Number(step.dataset['carousel'] ?? 1);
    roadTypesEl.scrollBy({ left: page, behavior: 'smooth' });
  };
}
roadTypesEl.addEventListener('scroll', updateCarousel, { passive: true });
window.addEventListener('resize', updateCarousel);
updateCarousel();

/** Re-renders every label the road palette owns, after a language change. */
function refreshRoadTypeLabels(): void {
  for (const child of roadTypesEl.querySelectorAll<HTMLElement>('[data-type-index]')) {
    const rt = ROAD_TYPES[Number(child.dataset['typeIndex'])];
    if (!rt) continue;
    child.setAttribute('aria-label', `${roadTypeName(rt)}: ${roadTypeDescription(rt)}`);
    child.title = `${roadTypeName(rt)} — ${roadTypeDescription(rt)}`;
    const name = child.querySelector('.road-type-name');
    if (name) name.textContent = roadTypeName(rt);
  }
  for (const op of roadTypesEl.querySelectorAll<HTMLElement>('.road-op')) {
    const label = op.querySelector('.road-type-name');
    if (label && op.dataset['roadOp']) label.textContent = t(`tool.${op.dataset['roadOp']}`);
  }
  refreshLaneSwatches();
  updateLaneChoices();
}

function selectRoadType(i: number): void {
  gameState.set('roadTypeIndex', i, 'classe de via escolhida');
  for (const child of roadTypesEl.querySelectorAll<HTMLElement>('[data-type-index]')) {
    const on = Number(child.dataset['typeIndex']) === i;
    child.classList.toggle('active', on);
    child.setAttribute('aria-pressed', String(on));
  }
  updateLaneChoices();
  refreshLaneSwatches();
  requestDraw();
}

function setAlignment(next: Alignment): void {
  gameState.set('alignment', next, 'traçado escolhido');
  if (next !== 'curve') roadTool.dropCurve();
  document.querySelectorAll<HTMLButtonElement>('.alignment-mode').forEach((button) => {
    const active = button.dataset['alignment'] === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  updateHint();
  requestDraw();
}

document.querySelectorAll<HTMLButtonElement>('.alignment-mode').forEach((button) => {
  button.onclick = () => setAlignment((button.dataset['alignment'] as Alignment) ?? 'straight');
});

// The road's own operations, beside its classes: each one takes the pointer.
document.querySelectorAll<HTMLButtonElement>('.road-op').forEach((button) => {
  button.onclick = () => setTool((button.dataset['roadOp'] as Tool) ?? 'road');
});

function updateRoadHeightValue(): void {
  const value = document.getElementById('roadHeightValue');
  const context = document.getElementById('roadHeightContext');
  const stateKey = game.roadHeightOffset > 1e-6 ? 'palette.height.above'
    : game.roadHeightOffset < -1e-6 ? 'palette.height.below' : 'palette.height.ground';
  if (value) {
    const metres = game.roadHeightOffset / UNITS_PER_METER;
    value.textContent = `${Math.abs(metres - Math.round(metres)) < 1e-6
      ? Math.round(metres) : metres.toFixed(1)} m`;
  }
  if (context) {
    context.dataset['i18n'] = stateKey;
    context.textContent = t(stateKey);
  }
}

document.querySelectorAll<HTMLButtonElement>('.road-height-step').forEach((button) => {
  button.onclick = () => roadTool.stepHeight(Number(button.dataset['heightStep']));
});
// The height shown is the game's state, wherever it was changed from.
gameState.watch(['roadHeightOffset'], updateRoadHeightValue);
updateRoadHeightValue();

const roadPalette = document.querySelector<HTMLElement>('.road-palette');
const terrainPalette = document.getElementById('terrainPalette') as HTMLElement;
const zonePalette = document.getElementById('zonePalette') as HTMLElement;
const zoneRemoveButton = document.getElementById('zoneRemove') as HTMLButtonElement;
zoneRemoveButton.addEventListener('click', () => {
  gameState.set('zoneEraser', !game.zoneEraser, 'borracha de zona');
  zoneRemoveButton.classList.toggle('active', game.zoneEraser);
  zoneRemoveButton.setAttribute('aria-pressed', String(game.zoneEraser));
  requestDraw();
});
document.querySelectorAll<HTMLButtonElement>('[data-zone-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    const wanted = button.dataset['zoneMode'];
    gameState.set('zoneMode', wanted === 'fill' || wanted === 'edit' || wanted === 'front' || wanted === 'split' || wanted === 'join' || wanted === 'add' ||
      wanted === 'polygon' || wanted === 'curve' || wanted === 'delete' ? wanted : 'brush', 'modo de zona');
    lotTool.modeChanged();
    document.querySelectorAll<HTMLButtonElement>('[data-zone-mode]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    requestDraw();
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-lot-split]').forEach((button) => {
  button.addEventListener('click', () => {
    gameState.set('lotSplitKind', button.dataset['lotSplit'] === 'horizontal' ? 'horizontal' : button.dataset['lotSplit'] === 'line' ? 'line' : 'vertical', 'corte de lote');
    document.querySelectorAll<HTMLButtonElement>('[data-lot-split]').forEach((item) => item.classList.toggle('active', item === button));
    requestDraw();
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-lot-parts]').forEach((button) => {
  button.addEventListener('click', () => {
    gameState.set('lotSplitParts', Number(button.dataset['lotParts']) || 2, 'partes do lote');
    document.querySelectorAll<HTMLButtonElement>('[data-lot-parts]').forEach((item) => item.classList.toggle('active', item === button));
    requestDraw();
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-zone-use]').forEach((button) => {
  button.addEventListener('click', () => {
    gameState.set('zoneUse', button.dataset['zoneUse'] as ZoneUse, 'uso da zona');
    document.querySelectorAll<HTMLButtonElement>('[data-zone-use]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    requestDraw();
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-zone-density]').forEach((button) => {
  button.addEventListener('click', () => {
    gameState.set('zoneDensity', button.dataset['zoneDensity'] as ZoneDensity, 'densidade da zona');
    document.querySelectorAll<HTMLButtonElement>('[data-zone-density]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    requestDraw();
  });
});

function setTerrainMode(next: BrushMode): void {
  gameState.set('terrainMode', next, 'pincel de terreno');
  // Each tool its own hardness: a chapada's cliff is not the hill's slope.
  const hardness = hardnessByMode[next];
  const hardnessInput = document.getElementById('terrainHardness') as HTMLInputElement | null;
  if (hardness !== undefined && hardnessInput) {
    gameState.set('terrainHardness', hardness, 'dureza do modo');
    hardnessInput.value = String(hardness);
    text('terrainHardnessValue', String(hardness));
  }
  document.querySelectorAll<HTMLButtonElement>('[data-terrain-mode]').forEach((button) => {
    const active = button.dataset['terrainMode'] === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const fogPanel = document.querySelector<HTMLElement>('.terrain-fog');
  if (fogPanel) fogPanel.hidden = next !== 'fog';
  const cloudPanel = document.querySelector<HTMLElement>('.terrain-cloud');
  if (cloudPanel) cloudPanel.hidden = next !== 'cloud';
  const weatherPanel = document.querySelector<HTMLElement>('.terrain-weather');
  if (weatherPanel) weatherPanel.hidden = next !== 'weather';
  const treePanel = document.querySelector<HTMLElement>('.terrain-trees');
  if (treePanel) treePanel.hidden = next !== 'trees';
  const gullyPanel = document.querySelector<HTMLElement>('.terrain-gully');
  if (gullyPanel) gullyPanel.hidden = next !== 'gully';
  const elementPanel = document.querySelector<HTMLElement>('.terrain-elements');
  if (elementPanel) elementPanel.hidden = next !== 'elements';
  updateHint();
}

// The fog BRUSH's settings (Paisagem > Terreno > Neblina): how thick, how
// high over the ground, how fast the wind carries it - laid with every dab,
// so each bank keeps its own (`world/fogPaint.ts`); kept between sessions.
// And the map's own thickness over all of them, kept in the map. Heights and
// speeds shown in metres.
{
  const bind = (id: string, read: () => number, write: (v: number) => void): void => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) return;
    input.value = String(read());
    text(`${id}Value`, String(read()));
    input.addEventListener('input', () => {
      write(Number(input.value));
      text(`${id}Value`, input.value);
    });
  };
  bind('fogStrength', () => fogBrush().strength, (v) => setFogBrush({ strength: v }));
  bind('fogHeight', () => fogBrush().height, (v) => setFogBrush({ height: v }));
  bind('fogSpeed', () => fogBrush().speed, (v) => setFogBrush({ speed: v }));
}
/** The map's fog thickness slider made to show the map (after a load or an undo). */
function syncFogInputs(): void {
  const input = document.getElementById('fogMapDensity') as HTMLInputElement | null;
  if (!input) return;
  const value = Math.round(doc.fogSettings.density * 100);
  input.value = String(value);
  text('fogMapDensityValue', String(value));
}
{
  let recorded = false;
  const input = document.getElementById('fogMapDensity') as HTMLInputElement | null;
  input?.addEventListener('input', () => {
    // One undo step a drag of the slider.
    if (!recorded) { history.record(doc); recorded = true; updateHistoryButtons(); }
    text('fogMapDensityValue', input.value);
    doc.setFogSettings({ density: Number(input.value) / 100 });
    persistence.saveSessionSoon(doc, sessionSettings);
    requestDraw();
  });
  input?.addEventListener('change', () => { recorded = false; });
  syncFogInputs();
}
// THE WEATHER (Paisagem > Terreno > Clima, `world/weather.ts`): the map's
// rain, wind, lightning and thunder; one undo step a drag of a slider. The
// thunder is heard at every strike, as late as sound takes to come.
const WEATHER_INPUTS = [
  ['weatherRain', 'rain', 100], ['weatherWind', 'wind', 1], ['weatherWindDir', 'windDirection', 1],
  ['weatherLightning', 'lightning', 1], ['weatherThunder', 'thunder', 100],
  // The water's, under the river brush.
  ['waterWaves', 'waves', 100], ['waterFoam', 'foam', 100], ['waterCurrent', 'current', 1],
] as const;
function syncWeatherInputs(): void {
  for (const [id, key, scale] of WEATHER_INPUTS) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) continue;
    input.value = String(Math.round(doc.weather[key] * scale * 10) / 10);
    text(`${id}Value`, input.value);
  }
}
{
  for (const [id, key, scale] of WEATHER_INPUTS) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    let recorded = false;
    input?.addEventListener('input', () => {
      if (!recorded) { history.record(doc); recorded = true; updateHistoryButtons(); }
      text(`${id}Value`, input.value);
      doc.setWeather({ [key]: Number(input.value) / scale });
      persistence.saveSessionSoon(doc, sessionSettings);
      requestDraw();
    });
    input?.addEventListener('change', () => { recorded = false; });
  }
  syncWeatherInputs();
  scene.onStrike((_x, _y, distance) => playThunder(distance / UNITS_PER_METER, doc.weather.thunder));
}
// The tree brush's settings (Paisagem > Terreno > Árvores), kept between
// sessions; and clearing every planted tree and every clearing at once.
{
  const bind = (id: string, key: 'density' | 'height' | 'variation' | 'spacing'): void => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) return;
    input.value = String(treeBrush()[key]);
    text(`${id}Value`, input.value);
    input.addEventListener('input', () => {
      setTreeBrush({ [key]: Number(input.value) });
      text(`${id}Value`, input.value);
    });
  };
  bind('treeDensity', 'density');
  bind('treeHeight', 'height');
  bind('treeVariation', 'variation');
  bind('treeSpacing', 'spacing');
  (document.getElementById('clearTrees') as HTMLButtonElement | null)?.addEventListener('click', () => {
    if (doc.trees.length === 0 && doc.treeClearings.length === 0) return;
    if (!window.confirm(t('confirm.clearTrees'))) return;
    history.record(doc);
    doc.clearTrees();
    updateHistoryButtons();
    persistence.saveSessionSoon(doc, sessionSettings);
    requestDraw();
  });
}
// The gully brush's strength, and how much of the steep land carries gullies
// of itself (the map's, `world/gullies.ts`): one undo step a drag.
{
  const strength = document.getElementById('gullyStrength') as HTMLInputElement | null;
  strength?.addEventListener('input', () => text('gullyStrengthValue', strength.value));
  let recorded = false;
  const input = document.getElementById('gullyAuto') as HTMLInputElement | null;
  input?.addEventListener('input', () => {
    if (!recorded) { history.record(doc); recorded = true; updateHistoryButtons(); }
    text('gullyAutoValue', input.value);
    doc.setGullyAuto(Number(input.value) / 100);
    persistence.saveSessionSoon(doc, sessionSettings);
    requestDraw();
  });
  input?.addEventListener('change', () => { recorded = false; });
  syncGullyInputs();
}
/** The map's gully slider made to show the map (after a load or an undo). */
function syncGullyInputs(): void {
  const input = document.getElementById('gullyAuto') as HTMLInputElement | null;
  if (!input) return;
  const value = Math.round(doc.gullyAuto * 100);
  input.value = String(value);
  text('gullyAutoValue', String(value));
}
(document.getElementById('clearGullies') as HTMLButtonElement | null)?.addEventListener('click', () => {
  if (doc.gullyDabs.length === 0) return;
  if (!window.confirm(t('confirm.clearGullies'))) return;
  history.record(doc);
  doc.clearGullies();
  updateHistoryButtons();
  persistence.saveSessionSoon(doc, sessionSettings);
  requestDraw();
});
(document.getElementById('clearFog') as HTMLButtonElement | null)?.addEventListener('click', () => {
  if (doc.fogDabs.length === 0) return;
  if (!window.confirm(t('confirm.clearFog'))) return;
  history.record(doc);
  doc.clearFog();
  updateHistoryButtons();
  persistence.saveSessionSoon(doc, sessionSettings);
  requestDraw();
});

document.querySelectorAll<HTMLButtonElement>('[data-terrain-mode]').forEach((button) => {
  button.onclick = () => setTerrainMode((button.dataset['terrainMode'] as BrushMode) ?? 'raise');
});

// The sky the player sets (Paisagem > Céu e clima): clouds - how many, how
// high, how thick - and mist. Kept between sessions; heights in metres.
{
  // v5: the flat map (the planet was taken out, the player's decision of
  // 2026-10-08). An older choice is not read.
  const KEY = 'roadcraft.atmosphere.v5';
  const ids = ['atmoClouds', 'atmoCloudBase', 'atmoCloudThickness', 'atmoFog', 'atmoFogHeight'] as const;
  const inputs = ids.map((id) => document.getElementById(id) as HTMLInputElement | null);
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, number> | null;
    if (kept) ids.forEach((id, i) => { const v = kept[id]; const input = inputs[i]; if (input && Number.isFinite(v)) input.value = String(v); });
  } catch { /* storage blocked: the defaults */ }
  const apply = (redraw = true): void => {
    const value = (i: number): number => Number(inputs[i]?.value ?? 0);
    ids.forEach((id, i) => text(`${id}Value`, String(value(i))));
    scene.setAtmosphere({
      clouds: value(0) / 100,
      cloudBase: value(1) * UNITS_PER_METER,
      cloudThickness: value(2) * UNITS_PER_METER,
      fog: value(3) / 100,
      fogHeight: value(4) * UNITS_PER_METER,
    });
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(ids.map((id, i) => [id, value(i)])))); } catch { /* not kept */ }
    // Not at boot: the frame loop is not set up yet then.
    if (redraw) requestDraw();
  };
  for (const input of inputs) if (input) input.oninput = () => apply();
  // The sky made no clouds of its own any more (every cloud is the map's, to
  // move or take away): a cover kept from before becomes clouds of the map
  // where it has none, once, and the setting goes to nought.
  const cover = Number(inputs[0]?.value ?? 0) / 100;
  if (cover > 0 && inputs[0]) {
    if (doc.clouds.length === 0) {
      const value = (i: number): number => Number(inputs[i]?.value ?? 0);
      doc.addClouds(scatterClouds(Math.round(cover * 12), {
        size: Math.max(40, value(2) * UNITS_PER_METER), height: value(1) * UNITS_PER_METER, density: 0.8,
      }, 0.3, MAP_SIZE / 2, [], Math.random));
      persistence.saveSessionSoon(doc, sessionSettings);
    }
    inputs[0].value = '0';
  }
  apply(false);
}

// The map's biome (`world/ecology.ts`): choosing one gives an old map its
// ecosystem too; "none" takes it away. Undoable.
let mapBiomeShown = -1;
function syncMapBiome(): void {
  mapBiomeShown = doc.natureRevision;
  const now = doc.nature?.region ?? 'none';
  document.querySelectorAll<HTMLButtonElement>('[data-map-biome]').forEach((button) => {
    const active = button.dataset['mapBiome'] === now;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
document.querySelectorAll<HTMLButtonElement>('[data-map-biome]').forEach((button) => {
  button.onclick = () => {
    const key = button.dataset['mapBiome'];
    const next = isRegionId(key) ? { region: key, seed: doc.nature?.seed ?? newNature().seed } : null;
    if (JSON.stringify(doc.nature) === JSON.stringify(next)) return;
    history.record(doc);
    doc.setNature(next);
    updateHistoryButtons();
    syncMapBiome();
    requestDraw();
  };
});

const terrainRadiusInput = document.getElementById('terrainRadius') as HTMLInputElement;
const terrainStrengthInput = document.getElementById('terrainStrength') as HTMLInputElement;

/**
 * One writer for each brush number.
 *
 * The slider used to be the only way to set them, which meant every change of
 * brush size crossed the map to a panel and back. The wheel and the bracket
 * keys now go through the same function, so the slider, the readout and the
 * on-canvas ring can never disagree about the current brush.
 */
function setTerrainRadius(value: number): void {
  const min = Number(terrainRadiusInput.min);
  const max = Number(terrainRadiusInput.max);
  gameState.set('terrainRadius', clamp(Math.round(value), min, max), 'raio do pincel');
  terrainRadiusInput.value = String(game.terrainRadius);
  text('terrainRadiusValue', String(game.terrainRadius));
  requestDraw();
}

function setTerrainStrength(value: number): void {
  const min = Number(terrainStrengthInput.min);
  const max = Number(terrainStrengthInput.max);
  gameState.set('terrainStrength', clamp(Math.round(value), min, max), 'força do pincel');
  terrainStrengthInput.value = String(game.terrainStrength);
  text('terrainStrengthValue', String(game.terrainStrength));
  requestDraw();
}

terrainRadiusInput.oninput = () => setTerrainRadius(Number(terrainRadiusInput.value));
terrainStrengthInput.oninput = () => setTerrainStrength(Number(terrainStrengthInput.value));
{
  // The brush's hardness: a mesa's cliff or a canyon's wall instead of a dome.
  const input = document.getElementById('terrainHardness') as HTMLInputElement | null;
  if (input) {
    input.oninput = () => {
      gameState.set('terrainHardness', clamp(Math.round(Number(input.value)), 0, 95), 'dureza do pincel');
      if (hardnessByMode[game.terrainMode] !== undefined) hardnessByMode[game.terrainMode] = game.terrainHardness;
      text('terrainHardnessValue', String(game.terrainHardness));
    };
  }
}
(document.getElementById('clearTerrain') as HTMLButtonElement).onclick = () => {
  if (!window.confirm(t('confirm.clearTerrain'))) return;
  history.record(doc);
  doc.clearTerrain();
  updateHistoryButtons();
  persistence.saveSessionSoon(doc, sessionSettings);
  requestDraw();
};

/**
 * Puts a tool in hand: what it does to the game (gestures dropped, the
 * selection let go, the Builder switched on or off). How the interface shows
 * it is `showTool`, told by the game's state at the next frame.
 */
function setTool(next: Tool): void {
  cancelGestures();
  gameState.set('tool', next, 'ferramenta escolhida');
  if (next !== 'inspect') {
    select(null, game.selectedSegmentS, null, `ferramenta ${next}`);
    closeInspector();
  }
  const buildingActive = next === 'building';
  if (buildingActive) buildings.activate();
  else buildings.deactivate();
  requestDraw();
}

/** The interface of the tool in hand: buttons lit, its palette, its help, the panel's title. */
function showTool(next: Tool): void {
  // Improving a road, moving its points, splitting a segment and setting up a
  // junction are things done TO a road, so they are the road's own options and
  // its button stays lit while one of them is in hand.
  const roadFamily = next === 'road' || next === 'upgrade' || next === 'split'
    || next === 'control' || next === 'move' || next === 'roundabout';
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) {
    // Inspect is the hand with nothing in it: no button is lit for it.
    const on = next !== 'inspect' && b.dataset['tool'] === (roadFamily ? 'road' : next);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('.road-op')) {
    const on = b.dataset['roadOp'] === next && next !== 'road';
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  canvas.dataset['tool'] = next;
  // Each palette is shown only with the tools it configures.
  const terrainActive = next === 'terrain';
  roadPalette?.classList.toggle('hidden', !roadFamily);
  roadPalette?.setAttribute('aria-hidden', String(!roadFamily));
  if (roadFamily) updateCarousel();
  roundaboutSettings.hidden = next !== 'roundabout';
  if (roadFamily) syncRoadModes(next);
  for (const group of roadPalette?.querySelectorAll<HTMLElement>('.palette-section.plan, .palette-section.lanes') ?? []) {
    group.style.display = next === 'roundabout' ? 'none' : '';
  }
  terrainPalette.classList.toggle('hidden', !terrainActive);
  terrainPalette.setAttribute('aria-hidden', String(!terrainActive));
  zonePalette.classList.toggle('hidden', next !== 'zone');
  zonePalette.setAttribute('aria-hidden', String(next !== 'zone'));
  // A tool with nothing to configure still fills its panel: with what it does
  // and every key it answers to. An empty shelf is a defect, not minimalism.
  renderToolHelp(roadFamily || terrainActive || next === 'zone' || next === 'building' || next === 'person' ? null : next);
  // The Person Creator fills the panel while it is the tool in hand.
  renderPanelTitle();
  // Buildings are a tool, not a mode: the game's own HUD stays up, and the
  // band's tray swaps to the Builder's categories while it is the tool in hand.
  buildings.workspace.setMode(next === 'building' ? 'builder' : 'road');
  syncToolPanel();
  updateHint();
}
gameState.watch(['tool'], () => showTool(game.tool));

/**
 * The tool panel is shown only while it has something to show: with nothing
 * in hand (Inspect, the tool the game opens on) and nothing picked, it stood
 * open over the map with a page of key bindings.
 */
function syncToolPanel(): void {
  const panel = document.querySelector<HTMLElement>('.bw-dock');
  const inspector = document.getElementById('inspector');
  if (!panel) return;
  panel.hidden = game.tool === 'inspect' && (!inspector || inspector.classList.contains('hidden') || inspector.hidden);
}
{
  // Picking a road or a junction to inspect opens the panel; closing it shuts it.
  const inspector = document.getElementById('inspector');
  if (inspector) new MutationObserver(() => syncToolPanel()).observe(inspector, { attributes: true, attributeFilter: ['class', 'hidden'] });
}


/** The panel's help card, for the tools that have nothing else to show. */
const toolHelp = document.createElement('div');
toolHelp.className = 'tool-help';
toolHelp.hidden = true;
let toolHelpFor: Tool | null = null;
/** Every tool's card ends with the camera, which works the same in all of them. */
const CAMERA_KEYS = [
  ['help.key.middleDrag', 'help.do.orbit'],
  ['help.key.rightDrag', 'help.do.pan'],
  ['help.key.wheel', 'help.do.zoom'],
  ['help.key.qe', 'help.do.turn'],
  ['help.key.home', 'help.do.resetView'],
] as const;
const TOOL_KEYS: Partial<Record<Tool, readonly (readonly [string, string])[]>> = {
  bulldoze: [['help.key.click', 'help.do.remove'], ['help.key.undo', 'help.do.undo']],
  pole: [['help.key.click', 'help.do.pole'], ['help.key.shiftClick', 'help.do.removePole'], ['help.key.esc', 'help.do.endLine']],
  streetscape: [['help.key.click', 'help.do.streetscape'], ['help.key.shiftClick', 'help.do.streetscapeRemove']],
  barrier: [['help.key.click', 'help.do.barrierPoint'], ['help.key.doubleClickEnter', 'help.do.barrierEnd'],
    ['help.key.backspace', 'help.do.barrierBack'], ['help.key.shiftClick', 'help.do.barrierRemove'], ['help.key.esc', 'help.do.barrierCancel']],
  inspect: [['help.key.click', 'help.do.pick'], ['help.key.pageUpDown', 'help.do.nodeHeight'], ['help.key.esc', 'help.do.close']],
};
function renderToolHelp(forTool: Tool | null): void {
  toolHelpFor = forTool;
  toolHelp.hidden = forTool === null;
  toolHelp.replaceChildren();
  if (forTool === null) return;
  const what = document.createElement('p');
  what.className = 'tool-help-what';
  what.textContent = t(`help.tool.${forTool}`);
  const list = document.createElement('dl');
  list.className = 'tool-help-keys';
  const section = (key: string): void => {
    const h = document.createElement('div');
    h.className = 'tool-help-section';
    h.textContent = t(key);
    list.appendChild(h);
  };
  const row = ([key, action]: readonly [string, string]): void => {
    const dt = document.createElement('dt');
    const kbd = document.createElement('kbd');
    kbd.textContent = t(key);
    dt.appendChild(kbd);
    const dd = document.createElement('dd');
    dd.textContent = t(action);
    list.append(dt, dd);
  };
  section('help.section.tool');
  (TOOL_KEYS[forTool] ?? []).forEach(row);
  if (forTool === 'barrier') {
    // What is drawn: a fence, a wall or a hedge.
    const kinds = document.createElement('div');
    kinds.className = 'tool-help-kinds';
    for (const kind of BARRIER_KINDS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pc-chip' + (kind === game.barrierKind ? ' active' : '');
      b.dataset['barrier'] = kind;
      b.textContent = t(`barrier.kind.${kind}`);
      b.addEventListener('click', () => { gameState.set('barrierKind', kind, 'tipo de cerca'); renderToolHelp('barrier'); });
      kinds.appendChild(b);
    }
    toolHelp.append(what, kinds, list);
    return;
  }
  section('help.section.camera');
  CAMERA_KEYS.forEach(row);
  toolHelp.append(what, list);
}
/** The name over the panel: the tool in hand, or the road's own option. */
function renderPanelTitle(): void {
  buildings.workspace.hosts.title.textContent = t(`tool.${game.tool}`);
}

/**
 * ONE chrome for the whole game.
 *
 * The toolbar, the palettes, the simulation panel and the app menu are the
 * game's own elements - their handlers are wired above - moved into the
 * container's hosts, so there is one place to look for anything and nothing
 * floats over the map. The chrome is up in both modes; `setMode` decides which
 * half fills the container's tiers.
 */
function mountUnifiedChrome(): void {
  const hosts = buildings.workspace.hosts;
  const move = (element: Element | null, host: HTMLElement): void => {
    if (element) host.appendChild(element);
  };
  move(document.querySelector('.toolbar'), hosts.level1);
  move(document.querySelector('.road-palette'), hosts.level2);
  move(document.getElementById('terrainPalette'), hosts.level2);
  move(document.getElementById('zonePalette'), hosts.level2);
  // What Inspect picked is shown in the panel, where the tool's card is: the
  // right-hand column belongs to the camera and the minimap.
  move(document.getElementById('inspector'), hosts.level2);
  move(toolHelp, hosts.level2);
  renderToolHelp(toolHelpFor);
  renderPanelTitle();
  move(document.querySelector('.simulation-controls'), hosts.simMenu);
  move(document.getElementById('topMenu'), hosts.appMenu);
  // Pausing is a speed, and every speed is inside the simulation menu: the
  // bar keeps only the camera. The button itself stays wired to the spacebar.
  // Demolish and Inspect act on whatever is under the pointer, in any mode:
  // they are the bar's tools, not modes on the rail. The camera's buttons
  // join them - a bar of their own floated over the map's corner.
  move(document.querySelector('.toolbar .tool[data-tool="bulldoze"]'), hosts.controls);
  move(document.querySelector('.toolbar .tool[data-tool="inspect"]'), hosts.controls);
  if (UI_V2) {
    // The camera is one menu of the bar, each button with its name beside it.
    const cameraControls = document.getElementById('cameraControls');
    move(cameraControls, hosts.cameraMenu);
    move(document.getElementById('resetView'), cameraControls ?? hosts.cameraMenu);
    for (const button of cameraControls?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
      const name = document.createElement('span');
      name.className = 'bw-camera-name';
      name.textContent = button.getAttribute('aria-label') ?? button.title;
      button.appendChild(name);
    }
  } else {
    move(document.getElementById('cameraControls'), hosts.controls);
    move(document.getElementById('resetView'), hosts.controls);
  }
  // The rail shows icons only; its names live in the tooltips.
  for (const button of document.querySelectorAll<HTMLButtonElement>('.toolbar .tool, .bw-controls .tool')) {
    const label = button.querySelector<HTMLElement>('[data-i18n]')?.dataset['i18n'];
    if (label) button.dataset['i18nTitle'] = label;
    button.title = `${button.textContent?.trim() ?? ''}${button.dataset['key'] ? ` (${button.dataset['key']})` : ''}`;
  }
  // The hint bar is the band's foot line now: floating over the map it landed
  // on the panel's own last row and the two sentences drew over each other.
  move(document.getElementById('hint'), hosts.hint);
  move(document.getElementById('mobileHint'), hosts.hint);
  document.getElementById('app')?.classList.add('bw-hide-legacy');
  // The panel starts in the mode of the tool in hand: at boot nothing had set
  // it, and the Builder's chips stood at the foot of the road panel.
  showTool(game.tool);
  buildings.workspace.setPanelClose(freeSelection);
  // The redesigned interface: its own HUD, dock, drawer and selection panel.
  // The tools' own settings are the editor's: handed to the interface here,
  // the one place that may wire the two layers.
  if (UI_V2) mountShell({
    workspace: buildings.workspace,
    roadSnap,
    setRoadSnap,
    parkingPresets: ROAD_PARKING_PRESETS,
    roadParkingPreset,
    setRoadParkingPreset: (preset) => {
      if ((ROAD_PARKING_PRESETS as readonly string[]).includes(preset)) setRoadParkingPreset(preset as RoadParkingPreset);
    },
    transitTool,
  });
}
// Mounted after this module has finished evaluating: moving the toolbar and
// the panels is a layout change, and a pointer already over the canvas can fire
// a move event mid-evaluation - before the run loop's own state exists.
setTimeout(mountUnifiedChrome, 0);

document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) => {
  b.addEventListener('click', () => pickTool((b.dataset['tool'] as Tool) ?? 'road'));
});

/** The button a tool lights: the road's own options light the road. */
function heldTool(): Tool {
  const roadFamily = game.tool === 'road' || game.tool === 'upgrade' || game.tool === 'split'
    || game.tool === 'control' || game.tool === 'move' || game.tool === 'roundabout';
  return roadFamily ? 'road' : game.tool;
}

/**
 * Puts everything down: no tool in hand, nothing picked, no panel. The game
 * always held some tool (Roads, Terrain...) and its panel stayed on screen;
 * this is the free hand, where a click on the map inspects what it hits.
 */
function freeSelection(): void {
  if (game.selectedSegment !== null || game.selectedNode !== null) {
    (document.getElementById('closeInspector') as HTMLButtonElement | null)?.click();
  }
  if (game.tool !== 'inspect') setTool('inspect');
}

/** A tool button or key: picks the tool, or puts it down when it is already in hand. */
function pickTool(next: Tool): void {
  if (next === 'inspect' || next === heldTool()) freeSelection();
  else setTool(next);
}
/** "Road (R)": each tool's name and key, as its tooltip - the only label a compact rail shows. */
function labelTools(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) {
    const name = t(`tool.${b.dataset['tool'] ?? 'road'}`);
    b.title = b.dataset['key'] ? `${name} (${b.dataset['key']})` : name;
  }
}
labelTools();

const trafficButton = document.getElementById('trafficToggle') as HTMLButtonElement;
function setPaused(paused: boolean): void {
  gameState.set('paused', paused, paused ? 'pausa' : 'simulação retomada');
  sim.clock.paused = paused;
  frameClock.restart();
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
}
trafficButton.onclick = () => setSpeed(game.paused ? game.speed : 0);

function setSpeed(speed: number): void {
  if (speed <= 0) setPaused(true);
  else {
    gameState.set('speed', speed, 'velocidade escolhida');
    sim.clock.speed = speed;
    setPaused(false);
  }
}

/** The pause button and the speed buttons as the game's state has them ("Pause" lit when paused). */
function showSpeed(): void {
  trafficButton.classList.toggle('active', !game.paused);
  trafficButton.setAttribute('aria-pressed', String(!game.paused));
  document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
    const active = Number(button.dataset['speed']) === (game.paused ? 0 : game.speed);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
gameState.watch(['paused', 'speed'], showSpeed);
showSpeed();

document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
  button.onclick = () => setSpeed(Number(button.dataset['speed']));
});

const trafficIntensity = document.getElementById('trafficIntensity') as HTMLInputElement;
const pedIntensity = document.getElementById('pedIntensity') as HTMLInputElement;
// The panel's Traffic and People: how many cars and how many people on foot.
trafficIntensity.max = String(MAX_TRAFFIC_COUNT);
pedIntensity.max = String(MAX_PEDESTRIAN_COUNT);
trafficIntensity.value = String(sim.trafficCount ?? DEFAULT_TRAFFIC_COUNT);
pedIntensity.value = String(sim.pedestrianCount ?? DEFAULT_PEDESTRIAN_COUNT);
function bindCount(input: HTMLInputElement, outputId: string, assign: (value: number) => void): void {
  const update = () => {
    assign(Number(input.value));
    text(outputId, input.value);
    persistence.saveSettingsSoon(sessionSettings);
  };
  input.oninput = update;
  update();
}
bindCount(trafficIntensity, 'trafficIntensityValue', (value) => { sim.trafficCount = value; });
bindCount(pedIntensity, 'pedIntensityValue', (value) => { sim.pedestrianCount = value; });
const demandLevel = document.getElementById('demandLevel') as HTMLSelectElement;
demandLevel.value = String(sim.demandMultiplier);
demandLevel.onchange = () => {
  sim.demandMultiplier = Number(demandLevel.value);
  persistence.saveSettingsSoon(sessionSettings);
};
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
  const active = Number(button.dataset['speed']) === (sim.clock.paused ? 0 : sim.clock.speed);
  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', String(active));
});

const congestionButton = document.getElementById('congestionToggle') as HTMLButtonElement;
congestionButton.onclick = () => {
  gameState.set('congestionOverlay', !game.congestionOverlay, 'mapa de congestionamento');
  persistence.saveSettingsSoon(sessionSettings);
};
/** The congestion button as the game's state has it, wherever it was changed from. */
function showCongestion(): void {
  congestionButton.classList.toggle('active', game.congestionOverlay);
  congestionButton.setAttribute('aria-pressed', String(game.congestionOverlay));
}
gameState.watch(['congestionOverlay'], showCongestion);
showCongestion();
initChrome(requestDraw);
onRoadGridChange(requestDraw);
mountBuildStamp(document.getElementById('buildStamp'));
mountAbout();

// The weapons lab (`?lab=armas`): a test street, a person always ready, the
// guns and the bomb, and probes of every frame (`weaponsLab.ts`).
if (__PLAY_MODE__ && ['armas', 'weapons'].includes(new URLSearchParams(location.search).get('lab') ?? '')) {
  void Promise.all([import('./weaponsLab'), scene.effects()]).then(([{ startWeaponsLab }]) => setTimeout(() => startWeaponsLab({
    sim, scene: () => scene, view: () => view, canvas: () => canvas3d,
    loadDoc: (data) => { history.record(doc); applySnapshot(data, 'import'); },
    lookAt: (x, y, zoom) => { camera.x = x; camera.y = y; camera.zoom = zoom; syncViewFromFlatCamera(); requestDraw(); },
    heightAt: (p) => sceneHeightAt(p),
    explode: (at, z, strength) => actions.explodeAt(at, z, null, strength),
    setSpeed: (speed) => setSpeed(speed),
    runSim: (seconds) => {
      sim.clock.run(Math.max(1, Math.round(seconds / DT)), () => step(sim, { traffic: true, pedestrians: true }));
      requestDraw();
    },
    requestDraw,
  }), 300));
}

/**
 * A generated city (`world/cityGen/plan.ts`, `editor/cityGenerator.ts`): the
 * map replaced (one undo step), the planned streets laid, the lots cut and
 * zoned, then every lot built on, a slice of each frame until all stand.
 */
let cityGrowth: { left: number; total: number; started: number } | null = null;
function generateCity(options: CityOptions): { roads: number; lots: number; zoned: number } {
  const plan = planCity(options);
  const cityDoc = layCity(plan);
  history.record(doc);
  applySnapshot(cityDoc.toJSON(), 'import');
  if (net.revision !== doc.revision) net.rebuild();
  applyLots(doc, planLots(doc, net));
  const zoned = zoneCity(doc, plan);
  lotTool.refused.clear();
  lotTool.refusedFor(net.revision);
  cityGrowth = { left: zoned, total: zoned, started: performance.now() };
  fitView();
  requestDraw();
  return { roads: doc.segments.size, lots: doc.lots.length, zoned };
}
/**
 * Builds on the generated city's lots, forty milliseconds a frame, the
 * buildings held from the renderer meanwhile (`holdBuildings`) and drawn
 * once at the end: growing one costs a millisecond or two, but drawing each
 * as it came re-meshed the layer every frame - two buildings a second.
 */
const cityProgress = document.createElement('div');
cityProgress.className = 'city-progress';
cityProgress.style.cssText = 'position:fixed;left:50%;top:76px;transform:translateX(-50%);z-index:50;display:none;'
  + 'background:rgba(10,16,18,.85);color:#fff;font:600 14px system-ui,sans-serif;padding:10px 16px;border-radius:10px';
document.body.appendChild(cityProgress);
function growCity(): void {
  if (!cityGrowth) return;
  // The notice painted first, then every lot built in one go: between frames
  // each new building set off the rebuilds that follow a building edit (the
  // ground, the walkways, the bays, the lots), and the city grew at three
  // buildings a second. Grown in one go, they follow once.
  if (cityProgress.style.display !== 'block') {
    cityProgress.style.display = 'block';
    cityProgress.textContent = t('city.building', { done: 0, total: cityGrowth.total });
    requestDraw();
    return;
  }
  const growing = cityGrowth;
  cityGrowth = null;
  setTimeout(() => caused('cidade gerada', () => {
    for (let guard = 0; guard < growing.total * 3 + 50; guard++) {
      const id = growOnLot({ doc, net, groundAt: (x, y) => scene.terrainHeightAt(x, y) }, lotTool.refused, 0x5eed);
      if (id === null) {
        // A lot refused (nothing fits it) is set aside; done when none is left open.
        const open = doc.lots.some((l) => l.use && (l.building === undefined || !doc.buildings.has(l.building as BuildingId)) && !lotTool.refused.has(l.id));
        if (!open) break;
        continue;
      }
      const fresh = doc.buildings.get(id as BuildingId);
      if (fresh) doc.buildings.put({ ...fresh, builtAt: sim.city.minutes(sim), decay: 0, lotPlan: LOT_PLAN_VERSION });
    }
    cityBuiltIn = (performance.now() - growing.started) / 1000;
    cityProgress.style.display = 'none';
    persistence.saveSessionSoon(doc, sessionSettings);
    updateStatus();
    requestDraw();
  }), 30);
}
/** Seconds the last generated city took, from the call to its last building (probes). */
let cityBuiltIn = 0;

(document.getElementById('newMap') as HTMLButtonElement).onclick = () => {
  if (!window.confirm(t('confirm.newMap'))) return;
  // Discarding the whole map is the largest edit the editor can make, so it is
  // the one that most needs to be undoable. Opening a file already records;
  // this did not, which left Ctrl+Z unable to recover a map cleared by mistake.
  history.record(doc);
  // A new map is empty.
  applySnapshot({ ...new RoadDoc().toJSON(), relief: RELIEF_NATURAL, nature: newNature() }, 'import');
  roadTool.reset();
  fitView();
  flashHint('hint.newMap');
};
// The sky: always day (the default), always night, or the residents' clock.
{
  const SKY_KEY = 'roadcraft.sky';
  const modes: readonly SkyMode[] = ['day', 'night', 'cycle'];
  let sky: SkyMode = 'day';
  try {
    const saved = localStorage.getItem(SKY_KEY);
    if (saved && (modes as readonly string[]).includes(saved)) sky = saved as SkyMode;
  } catch { /* storage blocked: day */ }
  const button = document.getElementById('skyMode') as HTMLButtonElement;
  const show = (): void => {
    button.textContent = t(`sky.${sky}`);
    button.title = t('sky.title');
    scene.setSkyMode(sky);
  };
  button.onclick = () => {
    sky = modes[(modes.indexOf(sky) + 1) % modes.length]!;
    try { localStorage.setItem(SKY_KEY, sky); } catch { /* not kept */ }
    show();
    requestDraw();
  };
  onLanguageChange(show);
  show();
}
(document.getElementById('saveMap') as HTMLButtonElement).onclick = () => {
  exportToFile(doc, sessionSettings());
  flashHint('hint.saved');
};
/**
 * Loads a picked map. The undo entry is recorded only once the map has
 * actually loaded: recording first left a bogus step (and cleared redo) when
 * the file then failed.
 */
function openImported(result: ImportResult): boolean {
  if (result.status === 'cancelled') return false;
  if (result.status === 'invalid') {
    flashHint('hint.openFailed');
    return false;
  }
  const before = doc.toJSON();
  try {
    applySnapshot(result.session.document, 'import');
  } catch (error) {
    console.error('The map could not be loaded.', error);
    applySnapshot(before);
    flashHint('hint.openFailed');
    return false;
  }
  history.record(RoadDoc.fromJSON(before, { repair: false }));
  updateHistoryButtons();
  restoreSettings(result.session.settings);
  flashHint('hint.opened');
  return true;
}
(document.getElementById('openMap') as HTMLButtonElement).onclick = async () => {
  openImported(await importFromFile());
};

// Perspective or the isometric (orthographic) view, the player's choice, kept.
// Perspective unless the player turns the isometric view on (the player,
// 2026-10-06: "a vista isométrica deve ficar desligada por padrão"); a new key,
// so a choice kept under the old default does not hold the isometric view on.
const PERSPECTIVE_KEY = 'roadcraft.perspective.v2';
function setPerspective(on: boolean): void {
  gameState.set('perspective', on, 'câmera');
  try { localStorage.setItem(PERSPECTIVE_KEY, on ? '1' : '0'); } catch { /* not kept */ }
}
/** The camera and its button as the game's state has it. */
function showPerspective(): void {
  scene.setPerspective(game.perspective);
  document.getElementById('perspectiveToggle')?.setAttribute('aria-pressed', String(game.perspective));
}
gameState.watch(['perspective'], showPerspective);
// At boot, once the whole file has run: switching the camera asks for a
// frame, and the frame loop is set up further down.
queueMicrotask(() => {
  let kept: string | null = null;
  try { kept = localStorage.getItem(PERSPECTIVE_KEY); } catch { /* storage blocked: the default */ }
  gameState.set('perspective', kept !== '0', 'preferência guardada');
  showPerspective();
});

// The camera's own buttons: a step per press, and the needle keeps north.
const cameraNeedle = document.querySelector<SVGElement>('#cameraControls .camera-needle');
const TILT_STEP = Math.PI / 18;
for (const button of document.querySelectorAll<HTMLButtonElement>('#cameraControls [data-camera]')) {
  button.addEventListener('click', () => {
    switch (button.dataset['camera']) {
      case 'turnLeft': view.orbit(-KEY_TURN, 0); break;
      case 'turnRight': view.orbit(KEY_TURN, 0); break;
      case 'tiltUp': view.orbit(0, TILT_STEP); break;
      case 'tiltDown': view.orbit(0, -TILT_STEP); break;
      case 'north': view.setOrbit(DEFAULT_AZIMUTH, DEFAULT_ELEVATION); break;
      case 'perspective': setPerspective(!game.perspective); break;
    }
    persistence.saveSettingsSoon(sessionSettings);
    requestDraw();
  });
}
// A flat view has nothing to turn or tilt.
if (view.kind === '2d') (document.getElementById('cameraControls') as HTMLElement).style.display = 'none';
let needleAngle = NaN;
/** Points the needle where north lies on screen. */
function updateCameraNeedle(): void {
  if (!cameraNeedle) return;
  const { cssW: w, cssH: h } = surface;
  const c = view.centre;
  const a = view.toScreen(c, w, h);
  // North is +Y (`lanelets.ts`, `classifyTurn`): up the map.
  const b = view.toScreen({ x: c.x, y: c.y + 10 }, w, h);
  const angle = Math.round((Math.atan2(b.x - a.x, a.y - b.y) * 180) / Math.PI);
  if (angle === needleAngle) return;
  needleAngle = angle;
  cameraNeedle.style.transform = `rotate(${angle}deg)`;
}

(document.getElementById('resetView') as HTMLButtonElement).onclick = () => {
  view.setOrbit(DEFAULT_AZIMUTH, DEFAULT_ELEVATION);
  fitView();
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
};

const undoButton = document.getElementById('undoAction') as HTMLButtonElement;
const redoButton = document.getElementById('redoAction') as HTMLButtonElement;
// An undo can change something far off screen, so the hint bar says it
// happened; Ctrl+Z and Ctrl+Y go through these buttons too.
undoButton.onclick = () => {
  // A drag or stroke in progress ends first: undoing mid-drag used to go on
  // moving a node of the restored map, and record the half-done state as redo.
  cancelGestures();
  doc.changes.causeNext('desfazer');
  const snapshot = history.undo(doc);
  applySnapshot(snapshot);
  doc.changes.causeNext('jogo');
  if (snapshot) flashHint('hint.undone');
};
redoButton.onclick = () => {
  cancelGestures();
  doc.changes.causeNext('refazer');
  const snapshot = history.redo(doc);
  applySnapshot(snapshot);
  doc.changes.causeNext('jogo');
  if (snapshot) flashHint('hint.redone');
};

function updateHistoryButtons(): void {
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
  buildings.workspace.setHistory(history.canUndo, history.canRedo);
}

/** Restores the user-visible state stored beside a map without touching topology. */
function restoreSettings(settings: SavedSettings): void {
  camera.x = settings.camera.x;
  camera.y = settings.camera.y;
  // Same rule as boot, asked of the live viewport this time.
  const limits = view.zoomBounds;
  camera.zoom = clamp(settings.camera.zoom, limits.min, limits.max);
  syncViewFromFlatCamera();
  restoreOrbit(settings.camera);
  // Through the game's state: setting the clock alone left `game.speed` and the
  // speed buttons showing the speed before the map was loaded.
  gameState.set('speed', settings.speed, 'mapa carregado');
  sim.clock.speed = settings.speed;
  setPaused(settings.paused);
  sim.trafficIntensity = settings.trafficIntensity;
  sim.pedestrianIntensity = settings.pedestrianIntensity;
  sim.trafficCount = settings.cars ?? DEFAULT_TRAFFIC_COUNT;
  sim.pedestrianCount = settings.people ?? DEFAULT_PEDESTRIAN_COUNT;
  trafficIntensity.value = String(sim.trafficCount);
  pedIntensity.value = String(sim.pedestrianCount);
  sim.demandMultiplier = settings.demandMultiplier ?? 1;
  demandLevel.value = String(sim.demandMultiplier);
  text('trafficIntensityValue', trafficIntensity.value);
  text('pedIntensityValue', pedIntensity.value);
  gameState.set('congestionOverlay', settings.congestionOverlay, 'mapa carregado');
  document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
    const active = Number(button.dataset['speed']) === (sim.clock.paused ? 0 : sim.clock.speed);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
}
updateHistoryButtons();

(document.getElementById('closeInspector') as HTMLButtonElement).onclick = () => {
  select(null, game.selectedSegmentS, null, 'inspetor fechado');
  closeInspector();
  requestDraw();
};

/**
 * Junction control, as a tool rather than as a form field.
 *
 * A player asked for signals to be OPTIONAL at a crossing, which they already
 * were — the setting lived in the inspector, three clicks away behind a select
 * nobody opens. Making it a tool is the difference between a setting and a
 * decision you can take while looking at the junction. The inspector's select
 * stays: it names the modes, which a cycling tool cannot.
 *
 * The order is the one a player reasons in, from "leave it to the game" through
 * the increasingly permissive real devices to nothing at all. Shift walks it
 * backwards, because the mode you want is as often the previous one as the next.
 */
const CONTROL_CYCLE: readonly JunctionControl[] = [
  'auto',
  'signal',
  'priority',
  'stop',
  'yield',
  'none',
];

function cycleNodeControl(id: NodeId, direction: 1 | -1): void {
  const node = doc.node(id);
  if (!node) return;
  // A node with fewer than three legs is not a junction: it is a kerb line or a
  // change of class, and no control device belongs there. Saying so is better
  // than silently cycling a setting that will never be read.
  if (node.incident.length < 3) {
    flashHint('hint.control.notJunction');
    return;
  }
  const at = CONTROL_CYCLE.indexOf(node.control);
  const next = CONTROL_CYCLE[
    ((at < 0 ? 0 : at) + direction + CONTROL_CYCLE.length) % CONTROL_CYCLE.length
  ] as JunctionControl;
  mutate(() => {
    doc.setNodeControl(id, next);
    return true;
  });
  select(null, game.selectedSegmentS, id, `controle ${next}`);
  flashHint(`control.${next}`);
}

/**
 * A transient message in the hint bar.
 *
 * It reuses the hint rather than adding a toast, because the player's eyes are
 * already there and a second floating panel over an isometric map costs more
 * than it tells. `updateHint` restores the tool's own wording, so the timer
 * never has to remember what was displaced.
 */
let hintFlash: ReturnType<typeof setTimeout> | null = null;
function flashHint(key: string, params?: Readonly<Record<string, string | number>>): void {
  // Both bars: on a phone only the touch hint is visible, and it used to miss
  // every one of these answers.
  const hints = ['hint', 'mobileHint']
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null);
  for (const hint of hints) {
    hint.textContent = t(key, params);
    delete hint.dataset['i18n'];
    hint.classList.add('flash');
  }
  if (hintFlash !== null) clearTimeout(hintFlash);
  hintFlash = setTimeout(() => {
    hintFlash = null;
    for (const hint of hints) hint.classList.remove('flash');
    updateHint();
  }, 1600);
}

/**
 * The hint bar, in both the desktop and the touch wording.
 *
 * The key is derived from the tool and its current mode rather than chosen from
 * a table of sentences, so adding a language is a dictionary entry and adding a
 * tool is one key in each dictionary.
 */
function hintKey(prefix: string): string {
  if (game.tool === 'road' && game.alignment === 'curve') return `${prefix}.road.curve`;
  if (game.tool === 'road' && game.alignment === 'free') return `${prefix}.road.free`;
  // Each sculpting operation gets its own sentence. Four modes behind one hint
  // meant the bar told the player nothing about the one they had selected.
  if (game.tool === 'terrain') return `${prefix}.terrain.${game.terrainMode}`;
  if (game.tool === 'building') return buildings.hintKey(prefix);
  return `${prefix}.${game.tool}`;
}

function updateHint(): void {
  const hint = document.getElementById('hint');
  const mobileHint = document.getElementById('mobileHint');
  if (hint) {
    const key = hintKey('hint');
    hint.dataset['i18n'] = key;
    hint.textContent = t(key);
  }
  if (mobileHint) {
    // A tool without touch wording of its own falls back to the desktop
    // sentence. The Builder has none, and the bar (and every screen reader,
    // through the canvas's aria-describedby) used to read the raw key.
    const touch = hintKey('hint.mobile');
    const key = hasKey(touch) ? touch : hintKey('hint');
    mobileHint.dataset['i18n'] = key;
    mobileHint.textContent = t(key);
  }
}
updateHint();
if (bootFailed) flashHint('hint.bootFailed');

// ------------------------------------------------------------- minimap
minimapCanvas.addEventListener('pointerdown', (e) => {
  minimapCanvas.setPointerCapture(e.pointerId);
  const p = minimapToWorld(minimapCanvas, doc, camera, e.clientX, e.clientY);
  if (p) {
    // Through the seam: writing the flat camera moves nothing under the 3D (three.js) viewport.
    view.moveTo(p);
    requestDraw();
  }
});
minimapCanvas.addEventListener('pointermove', (e) => {
  if (e.buttons === 0) return;
  const p = minimapToWorld(minimapCanvas, doc, camera, e.clientX, e.clientY);
  if (p) {
    // Through the seam: writing the flat camera moves nothing under the 3D (three.js) viewport.
    view.moveTo(p);
    requestDraw();
  }
});

/**
 * Arrow-key panning, through the seam and bound to the WINDOW.
 *
 * It used to be bound to the minimap's own `keydown`, so it did nothing unless
 * the player had first clicked the minimap — while the on-screen hint told them
 * the arrows move the camera. And it wrote the flat camera's `x`/`y`, which the
 * isometric renderer never reads, so even with the minimap focused it moved
 * nothing at all.
 */
const arrowPan = (e: KeyboardEvent): void => {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
  // Escape ends whatever is being drawn. A pole line is traced in stretches,
  // so there has to be a way to say "that is the end of this line" without
  // switching tool and back.
  if (e.key === 'Escape') {
    if (gestureInProgress()) {
      cancelGestures();
      e.preventDefault();
    } else if (game.selectedSegment !== null || game.selectedNode !== null) {
      // With nothing being drawn, Escape puts down what Inspect picked up.
      (document.getElementById('closeInspector') as HTMLButtonElement).click();
      e.preventDefault();
    } else if (game.tool !== 'inspect') {
      // ...and then the tool itself: the free hand.
      freeSelection();
      e.preventDefault();
    }
    return;
  }
  // Along the SCREEN's axes: with the camera turned, "up" is wherever the
  // camera faces, not the map's north.
  const step = e.shiftKey ? 120 : 40;
  const { cssW: w, cssH: h } = surface;
  const along = (dx: number, dy: number): void => view.moveTo(view.toWorld(w / 2 + dx, h / 2 + dy, w, h));
  // W A S D as well as the arrows, as in every city builder; never with
  // Ctrl or Alt (Ctrl+S saves, Ctrl+D duplicates).
  const key = e.ctrlKey || e.metaKey || e.altKey ? '' : e.key.toLowerCase();
  if (e.key === 'ArrowLeft' || key === 'a') along(-step, 0);
  else if (e.key === 'ArrowRight' || key === 'd') along(step, 0);
  else if (e.key === 'ArrowUp' || key === 'w') along(0, -step);
  else if (e.key === 'ArrowDown' || key === 's') along(0, step);
  else if (e.key === 'Home') {
    view.setOrbit(DEFAULT_AZIMUTH, DEFAULT_ELEVATION);
    fitView();
  } else return;
  e.preventDefault();
  requestDraw();
};
window.addEventListener('keydown', arrowPan);

// ------------------------------------------------------------- run loop
/** The frame asked for, and the time between frames (`frameLoop.ts`). */
const frameClock = new FrameClock(frame);
// Due on the first frame: the loop stops once nothing moves, and a paused map
// kept the page's initial readout ("0 roads · 0 nodes") and a blank minimap.
/** The minimap: ten times a second, never every frame, panning included. */
const minimapDue = new Periodic(0.1);
/** The status bar, the inspector, the simulation's checks. */
const panelsDue = new Periodic(0.4);

/**
 * Set by an edit: draw the new geometry first, rebuild the simulation after.
 *
 * Both are rebuilt from scratch and both block the page. `mutate` used to
 * rebuild the simulation's topology inside the pointer event, and the scene
 * was rebuilt in the frame after it, so a drawn road stayed a draft line on
 * screen for the SUM of the two — measured on a 144-segment map, 2.0 s of
 * topology and then 1.7 s of meshes before anything changed. The frame that
 * draws the edit now holds the simulation still, as a node drag already does,
 * and the next one brings its topology up to date: the road appears after the
 * mesh rebuild alone, and the traffic pauses for the topology afterwards.
 */
let topologyAfterDraw = false;
/** The traffic's topology catching up with an edit, a slice a frame (`frameLoop.ts`). */
const topology = new TopologyCatchUp();

function requestDraw(): void {
  frameClock.request();
}

/**
 * Buildings grow on zoned lots on their own, one at a time, twice a second:
 * the city fills in as the player watches, as in every city builder. Lots that
 * did not take a building are skipped until the land or the roads change.
 */
/** Wall-clock time before which nothing grows (rubble of a collapse lying, `strikeAt`). */
let zoneGrowthHold = 0;
setInterval(() => {
  // Buildings on zoned lots (`world/lots.ts`).
  // A road edit can make room on a lot refused before: try them again.
  const lotRefused = lotTool.refusedFor(net.revision);
  if (!mover.dragging && performance.now() >= zoneGrowthHold && doc.lots.some((l) => l.use)) {
    const grown = caused('crescimento da zona', () => {
      const id = growOnLot({ doc, net, groundAt: (x, y) => scene.terrainHeightAt(x, y) }, lotRefused, 0x5eed);
      const fresh = id === null ? undefined : doc.buildings.get(id as BuildingId);
      if (fresh) doc.buildings.put({ ...fresh, builtAt: sim.city.minutes(sim), decay: 0, lotPlan: LOT_PLAN_VERSION });
      return id;
    });
    if (grown !== null) {
      persistence.saveSessionSoon(doc, sessionSettings);
      updateStatus();
      requestDraw();
    }
  }
}, 500);

/** A frame has been drawn, and the first world has been put in place (the opening builds it in parts). */
let drawnOnce = false;
let worldShown = false;
function frame(now: number): void {
  if (!booted) return;
  // Each system's time in this frame (`core/health.ts`): a long frame is told with the systems that took it.
  frameTimer.begin();
  beginFrameWork();
  // Everyone watching the game's state is told what changed, once, here.
  gameState.flush();
  // The map's biome shown as it is after an undo, a load or a new map.
  if (doc.natureRevision !== mapBiomeShown) syncMapBiome();
  frameTimer.mark('painéis');
  const wall = frameClock.tick(now);

  // The opening puts the town together in parts (`SceneHandle.worldBusy`):
  // the traffic waits for the roads it drives on to be drawn.
  if (!worldShown && drawnOnce && !scene.worldBusy) worldShown = true;
  // Moving a node is an authoring preview. Freeze simulation time until the
  // gesture finishes so agents never rebuild against every intermediate shape.
  // The frame that first draws an edit is held the same way.
  let holdSim = mover.dragging || topologyAfterDraw || !worldShown;
  // A generated city being built (`generateCity`).
  growCity();
  // The traffic's topology catching up with an edit, a slice a frame, the
  // simulation held until it has (`TopologyCatchUp`); with a load's time
  // while the opening's town is put together, nothing of it shown yet.
  if ((!holdSim || scene.opening) && topology.step(sim, net.trafficRevision, scene.worldBusy, scene.opening)) {
    holdSim = true;
    requestDraw();
  }
  frameTimer.mark('topologia');
  const alpha = holdSim
    ? 1
    : sim.clock.advance(wall, () => step(sim, { traffic: !game.paused, pedestrians: !game.paused }));
  frameTimer.mark('simulação');

  if (net.revision !== doc.revision) {
    // Geometry is still refreshed during a drag, but a 20 Hz preview is more
    // than smooth enough and avoids repeatedly rebuilding routes, signals and
    // spatial indexes for pointer samples that will be superseded immediately.
    if (!mover.dragging || mover.previewDue(now, scene.stats.rebuildMs)) {
      net.rebuild();
      if (!mover.dragging && sim.topologyRevision !== net.trafficRevision) rebuildSimulationTopology();
    }
  }
  frameTimer.mark('rede viária');
  buildings.beforeDraw(game.tool === 'building');
  frameTimer.mark('prédios');
  // The pole run under the pointer, planned once per frame: the 3D preview
  // shows it as it will stand, the overlay marks only what cannot be built.
  framePolePlan = poleTool.plan();
  scene.setPolePreview(net, framePolePlan && !framePolePlan.refused && framePolePlan.poles.length >= 2
    ? { poles: framePolePlan.poles.map((pole) => ({ x: pole.at.x, y: pole.at.y, lamp: pole.lamp, standing: pole.existing !== null })) }
    : null);
  frameTimer.mark('postes');
  scene.draw(net, sim, alpha, wall, { holdRoads: terrainBrush.stroking });
  frameTimer.mark('desenho');
  drawnOnce = true;
  drawOverlayScreen();
  updateCameraNeedle();
  frameTimer.mark('sobreposição');
  if (topologyAfterDraw) {
    topologyAfterDraw = false;
    requestDraw();
  }

  // TEN TIMES A SECOND, AND NO FASTER — panning included.
  //
  // `drawMinimap` walks every lanelet in the simulation and every ribbon in the
  // network on each call, and the clause that used to sit here forced it to run
  // on EVERY FRAME while panning, pinching, drafting or dragging a node. So the
  // one moment the main canvas most needs the frame budget — the camera moving
  // under the user's hand — was the moment a full sweep of the map was billed
  // to it as well, and the bigger the map the worse it got. That is the stall
  // felt on pan and zoom.
  //
  // A 194-by-124 overview does not need sixty updates a second. The clock alone
  // now decides, so the cost is bounded no matter what the pointer is doing.
  if (minimapDue.due(wall)) {
    syncFlatCameraFromView();
    drawMinimap(minimapCanvas, doc, net, sim, camera, surface, viewFootprint());
  }
  frameTimer.mark('minimapa');

  if (panelsDue.due(wall)) {
    updateStatus();
    // Safe while the player is using the panel: an unchanged selection only
    // rewrites the statistics block, never the control under the pointer.
    refreshInspector();
    noteSimulationIssues();
  }
  frameTimer.mark('painéis');
  const timed = frameTimer.end();
  healthWatch.frameEnded(timed.start, timed.end);

  // Keep animating while anything is moving; otherwise settle.
  if (!document.hidden && (!game.paused || roadTool.draft || mover.dragging || cameraHand.active || scene.busy())) requestDraw();
  // Only the clouds moving (they drift, form and fade): a slower frame.
  else if (!document.hidden && scene.drifting()) frameClock.drift();
}

/**
 * The same hints as `drawOverlay`, projected instead of transformed.
 *
 * Under the isometric renderer there is no canvas transform that maps world to
 * screen, so every point goes through `view.toScreen` and everything is stroked
 * in CSS pixels. Widths are pixels here for the same reason: a hairline must
 * stay a hairline at any zoom, and there is no uniform scale left to divide by.
 *
 * The flat canvas sits above the 3D one and is cleared to full transparency
 * every frame, so it contributes only these strokes.
 */
/**
 * Draws a planned pole run onto the overlay.
 *
 * Taken out of `drawOverlayScreen` because it is the only part of that
 * function that has a model behind it, and because the preview and the commit
 * now share one plan - keeping the drawing beside the rest of the hairlines
 * hid that.
 */
/** Pick radius for a barrier under a shift-click, screen pixels. */
const BARRIER_PICK_PIXELS = 10;

/** The run being traced (`editor/barriers.ts` `BarrierTool.plan`), as it will stand: red where it cannot be built. */
function drawBarrierPlan(ctx: CanvasRenderingContext2D, at: (p: Vec2) => Vec2): void {
  const { line: points, bad, dots } = barrierTool.plan();
  ctx.save();
  if (points.length >= 2) {
    ctx.strokeStyle = bad ? '#ff6f63' : SELECTION;
    ctx.lineWidth = game.barrierKind === 'hedge' ? 5 : game.barrierKind === 'wall' ? 4 : 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => { const s = at(p); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
    ctx.stroke();
  }
  ctx.fillStyle = SELECTION;
  for (const p of dots) {
    const s = at(p);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Where the landscaping tool would put its item: a ring on the footway, red where it cannot go. */
function drawStreetscapeHover(ctx: CanvasRenderingContext2D, at: (p: Vec2) => Vec2): void {
  const hover = streetscapeTool.hover;
  if (!hover) return;
  const centre = at(hover.at);
  const edge = at({ x: hover.at.x + LANDSCAPE_RADIUS[streetscapeKind()] + m(0.3), y: hover.at.y });
  const radius = Math.max(6, Math.hypot(edge.x - centre.x, edge.y - centre.y));
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = hover.ok ? SELECTION : '#e5534b';
  ctx.fillStyle = hover.ok ? 'rgba(120, 200, 255, 0.18)' : 'rgba(229, 83, 75, 0.18)';
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (!hover.ok) {
    const k = radius * 0.6;
    ctx.beginPath();
    ctx.moveTo(centre.x - k, centre.y - k);
    ctx.lineTo(centre.x + k, centre.y + k);
    ctx.moveTo(centre.x + k, centre.y - k);
    ctx.lineTo(centre.x - k, centre.y + k);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPolePlan(
  plan: PoleRunPlan | null,
  ctx: CanvasRenderingContext2D,
  at: (p: Vec2) => Vec2,
): void {
  const cross = (p: Vec2): void => {
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#e5534b';
    ctx.beginPath();
    ctx.moveTo(p.x - 8, p.y - 8);
    ctx.lineTo(p.x + 8, p.y + 8);
    ctx.moveTo(p.x + 8, p.y - 8);
    ctx.lineTo(p.x - 8, p.y + 8);
    ctx.stroke();
    ctx.restore();
  };
  const ring = (p: Vec2, colour: string, radius = 7): void => {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };
  if (game.tool !== 'pole' && !plan) return;
  const marks = poleTool.marks();
  // Removing: the pole under the pointer, in red.
  if (game.tool === 'pole' && poleToolMode() === 'remove') {
    if (marks.removing) ring(at(marks.removing), '#e5534b', 10);
    return;
  }
  if (plan?.refused) {
    // An end off the footways: a red cross where it would have gone.
    cross(at(plan.from.kind === 'free' ? plan.from.at : plan.to.at));
    return;
  }
  if (plan && plan.poles.length) {
    // The run itself is drawn in 3D as it will stand (`setPolePreview`); here
    // only a ring round each standing pole the run will tie into.
    for (const pole of plan.poles) if (pole.existing !== null) ring(at(pole.at), HOVER, 9);
    return;
  }
  // Nothing drawn yet: where the first pole would go, or a cross where it cannot.
  if (marks.first) {
    const snap = marks.first;
    if (snap.kind === 'free') cross(at(snap.at));
    else ring(at(snap.at), snap.kind === 'pole' ? HOVER : SELECTION);
  }
}

/** F8: the diary's last changes drawn where they happened (`world/changes.ts`). */
let showChanges = false;
/** How long a change stays drawn, ms. */
const CHANGE_SHOWN = 8000;
const CHANGE_COLOURS: Record<ChangeKind, string> = {
  roads: '#ffd23f', traffic: '#fca311', clearings: '#95d5b2', terrain: '#c8823c', paint: '#9be564', buildings: '#ff8fab', zones: '#7bdff2', lots: '#b2f7ef',
  utilities: '#f7aef8', barriers: '#d0d0d0', landscape: '#6bd425', transit: '#4cc9f0', people: '#ffffff',
  trees: '#2d6a4f', elements: '#e0aaff', fog: '#e9ecef', clouds: '#f8f9fa', weather: '#adb5bd', nature: '#52b788',
  gullies: '#8d5524', elevation: '#ff6b6b', ground: '#f4a261', light: '#ffe066', surfaces: '#4361ee',
};

/**
 * The rectangles of the changes of the last seconds, each in its kind's
 * colour and labelled with what it was and why, fading out: what an edit
 * touched in the document, and what the game worked out again from it - the
 * roads' heights, the ground cut and filled, the land relit, the road tiles.
 */
function drawChanges(ctx: CanvasRenderingContext2D, at: (p: Vec2) => Vec2): void {
  const now = performance.now();
  const recent = doc.changes.latest(200).filter((c) => now - c.at < CHANGE_SHOWN);
  if (recent.length === 0) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.font = '600 11px system-ui, sans-serif';
  for (const change of recent) {
    ctx.globalAlpha = 1 - (now - change.at) / CHANGE_SHOWN;
    ctx.strokeStyle = CHANGE_COLOURS[change.kind];
    ctx.fillStyle = CHANGE_COLOURS[change.kind];
    ctx.setLineDash(change.parent ? [5, 4] : []);
    for (const [minX, minY, maxX, maxY] of change.rects ?? []) {
      const corners = [at({ x: minX, y: minY }), at({ x: maxX, y: minY }), at({ x: maxX, y: maxY }), at({ x: minX, y: maxY })];
      ctx.beginPath();
      corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    }
    const first = change.rects?.[0];
    if (first) {
      const p = at({ x: first[0], y: first[3] });
      ctx.fillText(`#${change.serial} ${change.kind}: ${change.cause}${change.detail ? ` (${change.detail})` : ''}`, p.x + 3, p.y - 3);
    }
  }
  ctx.restore();
  // Drawn again while they fade.
  requestDraw();
}

function drawOverlayScreen(): void {
  const w = overlayCanvas.clientWidth;
  const h = overlayCanvas.clientHeight;
  const ctx = overlayCtx;
  if (!ctx || w === 0 || h === 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (
    overlayCanvas.width !== Math.round(w * dpr) ||
    overlayCanvas.height !== Math.round(h * dpr)
  ) {
    overlayCanvas.width = Math.round(w * dpr);
    overlayCanvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Project at the height of whatever is UNDER the point, not at zero.
  //
  // A tilted view puts a raised deck well away from the ground directly below
  // it, so a draft line or a snap ring drawn on the ground plane floated off
  // the viaduct it belonged to — the on-screen feedback disagreed with what the
  // editor was about to build.
  const at = (p: Vec2): Vec2 => view.toScreen(p, w, h, sceneHeightAt(p));

  if (showChanges) drawChanges(ctx, at);

  if (game.tool === 'roundabout' && hoverAnchor) {
    ctx.save();
    ctx.strokeStyle = HOVER;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const angle = i * Math.PI / 32;
      const p = at({ x: hoverAnchor.at.x + Math.cos(angle) * game.roundaboutRadius,
        y: hoverAnchor.at.y + Math.sin(angle) * game.roundaboutRadius });
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // The pole run being drawn.
  //
  // What was here before was a dashed line ON THE GROUND with a small ring at
  // each pole, and it was useless for the one thing a preview has to do: a
  // pole is nine metres of vertical mast, and a ground line says nothing
  // about where the masts, the arms or the wires will be. It also disagreed
  // with the commit, because it drew the RAW drag while the commit snapped.
  //
  // This draws the plan: every mast at its real height, the wire that will
  // hang between them with its real sag, and a ring round any pole the run is
  // about to tie into. If it looks right here it is right when built.
  drawPolePlan(framePolePlan, ctx, at);
  // The universal grid (`world/grid.ts`) on the ground while roads are built:
  // 10 m cells, and their 1 m subdivisions close up - what the grid snap lands on.
  // The grid is drawn in the scene, on the ground, over the whole map (`SceneHandle.setGrid`).
  scene.setGrid(roadGridShown());
  if (game.tool === 'road' && blockGridChoice.armed && hoverAnchor) {
    // The grid the next click lays, on the ground.
    for (const [a, b] of blockGridLines(hoverAnchor.at, blockGridChoice)) {
      const steps = Math.max(2, Math.ceil(dist(a, b) / m(4)));
      ctx.save();
      ctx.strokeStyle = SELECTION;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let k = 0; k <= steps; k++) {
        const p = at({ x: a.x + (b.x - a.x) * (k / steps), y: a.y + (b.y - a.y) * (k / steps) });
        if (k === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  if (game.tool === 'streetscape') drawStreetscapeHover(ctx, at);
  if (game.tool === 'barrier') drawBarrierPlan(ctx, at);
  if (game.tool === 'transit') transitEditor.draw(ctx, at, true);
  // The metro seen through the ground and the track being laid, in the scene.
  scene.setTransitXray(game.tool === 'transit');
  scene.setTransitPreview(game.tool === 'transit' ? transitEditor.preview() : null);
  // The zoning grid is shown while a road is being drawn too, so a street can
  // be laid out to the blocks it will make.
  // The lots, laid on the ground in the scene (`render/lotOverlay.ts`): in
  // the Zoning tool, and while roads are being built (unless the player
  // turned that off); zoned ones faintly with the other tools.
  const showLots = game.tool === 'zone' || (doc.lots.some((l) => l.use) && zoneColoursShown());
  if (showLots) {
    // What the Zoning tool draws (`editor/lotTool.ts`), in the scene; its labels on the 2D layer.
    const { polygons, lines, points, labels } = lotTool.overlay(game.tool === 'zone');
    const input: LotOverlayInput = { key: JSON.stringify([polygons, lines, points]), polygons, lines, points };
    scene.setLotOverlay(input);
    // Labels stay on the 2D layer, projected at the ground's real height.
    const ground = (p: Vec2): Vec2 => view.toScreen(p, w, h, scene.surfaceHeightAt(p.x, p.y));
    ctx.save();
    for (const label of labels) {
      const c = ground(label.at);
      ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = '#0b1416cc'; ctx.fillStyle = '#ffffff';
      if (label.kind === 'size') {
        const text = t('zone.lot.size', { w: Math.round(label.width * METERS_PER_UNIT), d: Math.round(label.depth * METERS_PER_UNIT) });
        ctx.font = '600 13px system-ui, sans-serif'; ctx.textBaseline = 'middle';
        ctx.strokeText(text, c.x, c.y); ctx.fillText(text, c.x, c.y);
      } else {
        const text = `${Math.round(label.length * METERS_PER_UNIT)} m`;
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.strokeText(text, c.x, c.y - 10); ctx.fillText(text, c.x, c.y - 10);
      }
    }
    ctx.restore();
  } else scene.setLotOverlay(null);

  if (game.tool === 'building') buildings.drawOverlay(ctx);
  // The bulldozer's box, on the ground: its edges follow the land.
  const bulldozeBox = bulldozer.box();
  if (bulldozeBox) {
    const { a, b } = bulldozeBox;
    const corners = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
    ctx.save();
    ctx.beginPath();
    corners.forEach((p, i) => {
      const q = corners[(i + 1) % 4]!;
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / GRID_CELL));
      for (let k = 0; k < n; k++) {
        const g = { x: p.x + (q.x - p.x) * k / n, y: p.y + (q.y - p.y) * k / n };
        const s = view.toScreen(g, w, h, sceneHeightAt(g));
        if (i === 0 && k === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      }
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(227, 108, 96, 0.18)';
    ctx.fill();
    ctx.strokeStyle = '#ff6b5e';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.restore();
  }

  const strokeScreen = (
    points: readonly Vec2[],
    colour: string | CanvasGradient | CanvasPattern,
    width: number,
    dash: readonly number[] = [],
    projected?: readonly Vec2[],
  ): void => {
    if (points.length < 2) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([...dash]);
    ctx.beginPath();
    const first = projected?.[0] ?? at(points[0] as Vec2);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) {
      const p = projected?.[i] ?? at(points[i] as Vec2);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };

  const ring = (centre: Vec2, radius: number, colour: string, width: number,
    projected?: Vec2): void => {
    const c = projected ?? at(centre);
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  };

  // The road's centre line, picked or under the pointer, only with the
  // Information tool in hand (the player's order of 2026-10-05): with any
  // other tool a white line down the middle of the street is noise.
  const infoTool = game.tool === 'inspect' && document.body.dataset['infoTool'] === 'on';
  if (infoTool && game.selectedSegment !== null) {
    const ribbon = net.ribbons.get(game.selectedSegment);
    if (ribbon) strokeScreen(ribbon.full.toPoints(), SELECTION, 3);
  }

  if (infoTool && hoverAnchor?.kind === 'segment' && hoverAnchor.segment !== undefined) {
    const ribbon = net.ribbons.get(hoverAnchor.segment);
    if (ribbon) strokeScreen(ribbon.full.toPoints(), HOVER, 2);
  }

  if (game.selectedNode !== null) {
    const node = doc.node(game.selectedNode);
    if (node) ring({ x: node.x, y: node.y }, 12, SELECTION, 2);
  }

  // The node a road would start from, when the cursor is snapping to one.
  //
  // Only then. It was drawn wherever the cursor rested - a white circle on the
  // grass, and on a road on its centre line, where a segment anchor sits -
  // with the Road tool up, which is the tool the game starts in. Players
  // reported it, twice, as a debug marker left on screen.
  if (game.tool === 'road' && !roadTool.draft && hoverAnchor?.kind === 'node') {
    ring(hoverAnchor.at, 9, HOVER, 2);
  }

  // The brush, drawn where it will land.
  //
  // Two rings rather than one: the outer is the radius, the inner marks where
  // the smoothstep falloff still has most of its strength, which is the part
  // the player is actually aiming. The height readout is there because
  // levelling needs a number — you cannot match one slope to another by eye in
  // an isometric projection.
  if (game.tool === 'terrain' && hoverAnchor) {
    const brush = terrainBrush.at ?? hoverAnchor.at;
    const centre = at(brush);
    const xEdge = at({ x: brush.x + game.terrainRadius, y: brush.y });
    const yEdge = at({ x: brush.x, y: brush.y + game.terrainRadius });
    const rx = Math.max(4, Math.hypot(xEdge.x - centre.x, xEdge.y - centre.y));
    const ry = Math.max(4, Math.hypot(yEdge.x - centre.x, yEdge.y - centre.y));
    const colour = TERRAIN_BRUSH_COLOUR[game.terrainMode];
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.fillStyle = TERRAIN_BRUSH_FILL[game.terrainMode];
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.ellipse(centre.x, centre.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Inner ring: the half-strength contour, scaled by the strength setting so
    // a heavier brush visibly bites deeper. Scaled against the slider's own
    // range, not against a hard-coded 10: a ring drawn past the outer one is
    // not a heavier bite, it is a second radius the brush does not have.
    const strengthMax = Number(terrainStrengthInput.max) || 40;
    const bite = 0.3 + 0.35 * (game.terrainStrength / strengthMax);
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(centre.x, centre.y, rx * bite, ry * bite, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(centre.x - 5, centre.y);
    ctx.lineTo(centre.x + 5, centre.y);
    ctx.moveTo(centre.x, centre.y - 5);
    ctx.lineTo(centre.x, centre.y + 5);
    ctx.stroke();

    const height = terrainBrush.level ?? sceneHeightAt(brush);
    const label = game.terrainMode === 'flatten'
      ? `${t('terrain.level')} ${height.toFixed(1)}`
      : height.toFixed(1);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const width = ctx.measureText(label).width + 12;
    ctx.fillStyle = 'rgba(12,18,16,0.76)';
    ctx.beginPath();
    ctx.roundRect(centre.x - width / 2, centre.y - ry - 24, width, 17, 8);
    ctx.fill();
    ctx.fillStyle = colour;
    ctx.fillText(label, centre.x, centre.y - ry - 10);
    ctx.restore();
  }

  // With the control tool up, every junction states what it is doing. The
  // setting is invisible otherwise, so choosing one meant clicking each node in
  // turn to read it back.
  if (game.tool === 'control') {
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const node of doc.nodes.values()) {
      if (node.incident.length < 3) continue;
      const centre = at({ x: node.x, y: node.y });
      const colour = CONTROL_COLOUR[node.control] ?? HOVER;
      const hot = hoverAnchor?.kind === 'node' && hoverAnchor.node === node.id;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, hot ? 13 : 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(12,18,16,0.72)';
      ctx.fill();
      ctx.strokeStyle = colour;
      ctx.lineWidth = hot ? 3 : 2;
      ctx.stroke();
      ctx.fillStyle = colour;
      ctx.fillText(CONTROL_GLYPH[node.control] ?? '?', centre.x, centre.y + 0.5);
    }
  }

  // The road just laid, as previewed, while the world with it is still being built.
  const shownRoad = roadTool.preview(!scene.worldBusy && !topologyAfterDraw);
  const settling = shownRoad?.settling ?? false;
  const roadPreview: RoadDraft | null = shownRoad?.road ?? null;
  if (roadPreview) {
    // The profile the road will be laid with: its lanes and its parking.
    const chosenWidth = roadWidth();
    const plainRt = roadProfile(game.roadTypeIndex, game.roadLanePreset);
    const rt = roadProfile(game.roadTypeIndex, game.roadLanePreset,
      roadType(game.roadTypeIndex).lanes === 1 ? 'aToB' : 'both',
      chosenWidth === null ? undefined : sectionForWidth(plainRt, chosenWidth, Math.round(plainRt.speedLimit * 3.6 * METERS_PER_UNIT)),
      roadParking());
    const pieces = roadTool.pieces(roadPreview);
    const points: Vec2[] = [];
    const projected: Vec2[] = [];
    const groundProjected: Vec2[] = [];
    const offsets: number[] = [];
    let previewHeight = roadPreview.startHeightOffset;
    let limited = false;
    for (const [pieceIndex, piece] of pieces.entries()) {
      // Sampled every couple of metres, so the preview lies on the ground as
      // the road will: a straight piece was two points and drew a straight
      // line through any hill between them (the player's order of 2026-10-05).
      const flattened = densify(flattenSegment(piece.start.at, piece.end.at, piece.curve), m(2));
      const pieceLength = flattened.reduce((sum, p, i) =>
        i === 0 ? 0 : sum + dist(p, flattened[i - 1] as Vec2), 0);
      const reach = pieceLength * MAX_AUTHORED_GRADE;
      const nextHeight = clamp(piece.end.heightOffset,
        previewHeight - reach, previewHeight + reach);
      limited ||= Math.abs(nextHeight - piece.end.heightOffset) > 1e-6;
      for (let i = pieceIndex === 0 ? 0 : 1; i < flattened.length; i++) {
        const p = flattened[i] as Vec2;
        const t = i / Math.max(1, flattened.length - 1);
        const eased = t * t * (3 - 2 * t);
        const offset = previewHeight + (nextHeight - previewHeight) * eased;
        const ground = scene.terrainHeightAt(p.x, p.y);
        points.push(p);
        offsets.push(offset);
        groundProjected.push(view.toScreen(p, w, h, ground));
        projected.push(view.toScreen(p, w, h, ground + offset));
      }
      previewHeight = nextHeight;
    }
    const pathLength = points.reduce((sum, point, i) =>
      i === 0 ? 0 : sum + Math.hypot(point.x - (points[i - 1] as Vec2).x, point.y - (points[i - 1] as Vec2).y), 0);
    const ok = pathLength >= MIN_LINK_LENGTH * 0.25 &&
      !(limited && roadPreview.snap.guide === 'network');
    // Use the length of both projected world axes. Reading only the horizontal
    // component made the preview several pixels thinner than the committed 3D
    // road in an isometric view, especially at the far zoom.
    const origin = at({ x: 0, y: 0 });
    const xAxis = at({ x: 100, y: 0 });
    const yAxis = at({ x: 0, y: 100 });
    const pixelsPerUnit = (
      Math.hypot(xAxis.x - origin.x, xAxis.y - origin.y) +
      Math.hypot(yAxis.x - origin.x, yAxis.y - origin.y)
    ) / 200;
    const asphaltWidth = Math.max(3, rt.width * pixelsPerUnit);
    const kerbWidth = Math.max(asphaltWidth + 2, (rt.width + 1.8) * pixelsPerUnit);
    const footwayWidth = Math.max(kerbWidth + 2, (rt.width + 1.8 + rt.sidewalk * 2) * pixelsPerUnit);
    const casingWidth = Math.max(footwayWidth + 2, footwayWidth + 3 * pixelsPerUnit);

    // The editor used to paint one translucent class-colour stroke here. At a
    // distance that blended into the grass and looked like a broken, untextured
    // road even though the committed mesh was sound. Draw the same visual stack
    // as the 3D road and keep validity as a slim outer halo instead.
    ctx.save();
    if (points.length > 1 && offsets.some((offset) => Math.abs(offset) > UNITS_PER_METER * 0.5)) {
      strokeScreen(points, 'rgba(6, 19, 21, 0.52)', casingWidth + 5, [7, 7], groundProjected);
      ctx.beginPath();
      ctx.moveTo(projected[0]!.x, projected[0]!.y);
      for (const p of projected.slice(1)) ctx.lineTo(p.x, p.y);
      for (const p of [...groundProjected].reverse()) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fillStyle = previewHeight >= 0 ? 'rgba(101, 229, 195, 0.16)' : 'rgba(244, 184, 103, 0.20)';
      ctx.fill();
    }
    // Each band of the road as it will be laid: its two edges worked out on
    // the ground at their real width and projected point by point, ends cut
    // square - not strokes of a fixed pixel width with round caps, which in
    // perspective swelled a short road into a ball (the player, 2026-10-06).
    const band = (half: number, fill: string | CanvasPattern): void => {
      if (points.length < 2) return;
      const left: Vec2[] = [], right: Vec2[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[Math.max(0, i - 1)]!, b = points[Math.min(points.length - 1, i + 1)]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
        const p = points[i]!, z = (projected[i] && groundProjected[i]) ? offsets[i]! : 0;
        const l = { x: p.x + nx * half, y: p.y + ny * half }, r = { x: p.x - nx * half, y: p.y - ny * half };
        left.push(view.toScreen(l, w, h, scene.terrainHeightAt(l.x, l.y) + z));
        right.push(view.toScreen(r, w, h, scene.terrainHeightAt(r.x, r.y) + z));
      }
      ctx.beginPath();
      left.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i]!.x, right[i]!.y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    const asphaltHalf = rt.width / 2, kerbHalf = (rt.width + 1.8) / 2;
    const footwayHalf = (rt.width + 1.8 + rt.sidewalk * 2) / 2, casingHalf = footwayHalf + 1.5;
    if (!settling) band(casingHalf + 2, ok ? SELECTION : INVALID);
    band(casingHalf, '#536b47');
    band(footwayHalf, '#a7a498');
    band(kerbHalf, '#87877f');
    band(asphaltHalf, asphaltPreviewPattern(ctx));
    if (rt.markings !== 'none') {
      const dash = [Math.max(4, 10 * pixelsPerUnit), Math.max(3, 8 * pixelsPerUnit)];
      strokeScreen(points, rt.line, Math.max(1, 1.1 * pixelsPerUnit), dash, projected);
    }
    ctx.restore();
    if (points.length && !settling) {
      ring(roadPreview.start.at, 7, ok ? SELECTION : INVALID, 2, projected[0]);
      ring(roadPreview.snap.at, 7, ok ? SELECTION : INVALID, 2, projected[projected.length - 1]);
      const end = projected[projected.length - 1]!;
      const groundEnd = groundProjected[groundProjected.length - 1]!;
      // The road's length beside the pointer, in steps of 10 m, as SimCity shows it.
      {
        const tens = Math.round((pathLength * METERS_PER_UNIT) / 10) * 10;
        const text = `${tens} m`;
        ctx.save();
        ctx.font = '700 13px system-ui, sans-serif';
        const tw = ctx.measureText(text).width;
        const bx = clamp(end.x + 16, 8, Math.max(8, w - tw - 28)), by = clamp(end.y - 40, 60, h - 40);
        ctx.fillStyle = 'rgba(9, 27, 28, 0.92)';
        ctx.beginPath();
        ctx.roundRect(bx, by, tw + 18, 24, 6);
        ctx.fill();
        ctx.fillStyle = ok ? '#e7fff7' : '#ffb4ab';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 9, by + 12.5);
        ctx.restore();
      }
      if (Math.abs(previewHeight) > UNITS_PER_METER * 0.5) {
        ctx.save();
        ctx.strokeStyle = previewHeight >= 0 ? '#7df7d3' : '#ffc864';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(groundEnd.x, groundEnd.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(groundEnd.x, groundEnd.y, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      const metres = previewHeight / UNITS_PER_METER;
      const grade = pathLength > 1
        ? Math.round(Math.abs(previewHeight - roadPreview.startHeightOffset) / pathLength * 100)
        : 0;
      const label = `${metres >= 0 ? '+' : ''}${metres.toFixed(1)} m · ${grade}%`;
      if (Math.abs(previewHeight) > 0.25 ||
        Math.abs(previewHeight - roadPreview.startHeightOffset) > 0.25) {
        const x = clamp(end.x + 16, 12, Math.max(12, w - 430));
        const y = clamp(end.y + 24, 80, h - 80);
        const baseline = y + 51;
        const levelY = (offset: number): number => baseline -
          clamp(offset / UNITS_PER_METER * 3, -22, 22);
        const startY = levelY(roadPreview.startHeightOffset);
        const endY = levelY(previewHeight);
        const colour = previewHeight >= 0 ? '#7df7d3' : '#ffc864';
        ctx.save();
        ctx.fillStyle = 'rgba(9, 27, 28, 0.94)';
        ctx.fillRect(x, y, 170, 68);
        ctx.strokeStyle = 'rgba(210, 226, 218, 0.55)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 12, baseline);
        ctx.lineTo(x + 158, baseline);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = colour;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + 12, startY);
        ctx.bezierCurveTo(x + 63, startY, x + 107, endY, x + 158, endY);
        ctx.stroke();
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillStyle = limited ? '#ffc864' : '#e7fff7';
        ctx.fillText(label, x + 11, y + 16);
        ctx.restore();
      }
    }
  }
}

/** The brush's colour, by what it does to the ground. */
const TERRAIN_BRUSH_COLOUR: Readonly<Record<BrushMode, string>> = {
  paint: '#f2d27a',
  fog: '#e8eef4',
  cloud: '#ffffff',
  elements: '#b8e07a',
  gully: '#c98a5a',
  trees: '#5fbf5a',
  weather: '#cfe3ff',
  raise: SELECTION,
  lower: '#ffc864',
  flatten: '#cfd8d4',
  river: '#73cfe7',
  mesa: '#e29a5c',
  canyon: '#e29a5c',
  escarpment: '#9aa0a8',
  sugarloaf: '#c9c4bb',
};

const TERRAIN_BRUSH_FILL: Readonly<Record<BrushMode, string>> = {
  paint: 'rgba(242,210,122,0.10)',
  fog: 'rgba(232,238,244,0.12)',
  cloud: 'rgba(255,255,255,0)',
  elements: 'rgba(184,224,122,0.10)',
  gully: 'rgba(201,138,90,0.10)',
  trees: 'rgba(95,191,90,0.10)',
  weather: 'rgba(207,227,255,0)',
  raise: 'rgba(101,229,195,0.08)',
  lower: 'rgba(255,200,100,0.08)',
  flatten: 'rgba(207,216,212,0.08)',
  river: 'rgba(70,160,190,0.12)',
  mesa: 'rgba(226,154,92,0.10)',
  canyon: 'rgba(226,154,92,0.10)',
  escarpment: 'rgba(154,160,168,0.10)',
  sugarloaf: 'rgba(201,196,187,0.10)',
};

/**
 * One glyph and one colour per control mode.
 *
 * Letters rather than icons: the overlay is a 2D canvas over an isometric
 * scene, a ten-pixel icon at that size is a smudge, and a letter survives the
 * zoom the player actually reads the map at.
 */
const CONTROL_GLYPH: Readonly<Record<JunctionControl, string>> = {
  auto: 'A',
  signal: 'S',
  priority: 'P',
  stop: '\u25A0',
  yield: '\u25BC',
  none: '\u2013',
};

const CONTROL_COLOUR: Readonly<Record<JunctionControl, string>> = {
  auto: '#8fb3a6',
  signal: '#ffd24a',
  priority: '#7ec8ff',
  stop: '#ff7a6a',
  yield: '#ffb057',
  none: '#9aa3a0',
};

function setNodeHeightMetres(id: NodeId, metres: number): void {
  const node = doc.node(id);
  if (!node || !Number.isFinite(metres) || node.heightOffset === metres * UNITS_PER_METER) return;
  let lower = -Infinity;
  let upper = Infinity;
  for (const segmentId of node.incident) {
    const segment = doc.segment(segmentId);
    if (!segment) continue;
    const other = doc.node(segment.a === id ? segment.b : segment.a);
    if (!other) continue;
    const rise = net.polylines.get(doc, segmentId).length * MAX_AUTHORED_GRADE;
    lower = Math.max(lower, other.heightOffset - rise);
    upper = Math.min(upper, other.heightOffset + rise);
  }
  const requested = metres * UNITS_PER_METER;
  const height = lower <= upper ? clamp(requested, lower, upper) : node.heightOffset;
  if (height === node.heightOffset) {
    if (Math.abs(height - requested) > 1e-6) flashHint('hint.road.gradeLimited');
    return;
  }
  mutate(() => {
    doc.setNodeHeightOffset(id, height);
    return true;
  });
  if (Math.abs(height - requested) > 1e-6) flashHint('hint.road.gradeLimited');
}

function showInspector(): void {
  openInspector(
    doc,
    net,
    sim,
    { segment: game.selectedSegment, node: game.selectedNode },
    {
      onUpgrade: (id) => {
        const seg = doc.segment(id);
        if (!seg || seg.type >= LAST_UPGRADE_CLASS) return;
        mutate(() => {
          doc.setSegmentType(id, seg.type + 1);
          return true;
        });
      },
      onSetType: (id, type) => {
        const seg = doc.segment(id);
        if (!seg || seg.type === type) return;
        mutate(() => {
          doc.setSegmentType(id, type);
          return true;
        });
      },
      onSetLanes: (id, lanes) => {
        if (!doc.segment(id)) return;
        mutate(() => {
          doc.setSegmentLanes(id, lanes);
          return true;
        });
      },
      onSetParking: (id, parking) => {
        if (!doc.segment(id)) return;
        mutate(() => {
          doc.setSegmentParking(id, parking);
          return true;
        });
      },
      onSetSection: (id, section) => {
        if (!freeRoadsEnabled() || !doc.segment(id)) return;
        mutate(() => {
          doc.setSegmentSection(id, section);
          return true;
        });
      },
      onSetDirection: (id, direction) => {
        if (!doc.segment(id)) return;
        mutate(() => {
          doc.setSegmentDirection(id, direction);
          return true;
        });
      },
      onSetNodeHeight: setNodeHeightMetres,
      onReverseDirection: (id) => {
        const seg = doc.segment(id);
        if (!seg) return;
        const direction = seg.direction === 'aToB' ? 'bToA' : 'aToB';
        mutate(() => {
          doc.setSegmentDirection(id, direction);
          return true;
        });
      },
      onSplit: (id) => {
        const seg = doc.segment(id);
        if (!seg) return;
        const polyline = net.polylines.get(doc, id);
        const at = polyline.sampleAt(polyline.length / 2).p;
        mutate(() => splitSegment(doc, net, id, polyline.length / 2, at) !== null);
      },
      onAddCrossing: (id, kind) => {
        if (!doc.segment(id)) return;
        // Where the player clicked on the road, or its middle.
        const chosen = game.selectedSegment === id && game.selectedSegmentS !== null ? game.selectedSegmentS : undefined;
        let placed: NodeId | null = null;
        mutate(() => {
          const result = commitPedestrianCrossing(doc, net, id, kind, chosen);
          if (!result.committed) {
            flashHint(`hint.crossing.${result.reason}`);
            return false;
          }
          placed = result.node;
          return true;
        });
        if (placed !== null) {
          select(null, null, placed, 'ponto inserido na via');
          showInspector();
        }
      },
      onRemoveCrossing: (node) => {
        mutate(() => {
          if (!doc.node(node)?.crossing) return false;
          doc.clearNodeCrossing(node);
          return true;
        });
      },
      onAddHeightPoint: (id) => {
        if (!doc.segment(id)) return;
        const polyline = net.polylines.get(doc, id);
        if (polyline.length < 20) { flashHint('hint.road.invalid'); return; }
        const chosen = game.selectedSegment === id && game.selectedSegmentS !== null
          ? game.selectedSegmentS : polyline.length / 2;
        const s = chosen < 5 || chosen > polyline.length - 5
          ? polyline.length / 2 : chosen;
        let node: NodeId | null = null;
        mutate(() => {
          node = splitSegment(doc, net, id, s, polyline.sampleAt(s).p);
          if (node === null) return false;
          doc.requireNode(node).smooth = true;
          return true;
        });
        if (node !== null) {
          select(null, null, node, 'ponto suave inserido');
          showInspector();
        }
      },
      onDuplicate: (id) => {
        duplicateSelectedSegment(id);
      },
      onSetControl: (id, control) => {
        if (!doc.node(id)) return;
        mutate(() => {
          doc.setNodeControl(id, control);
          return true;
        });
      },
      onSetMovementBlocked: (node, from, to, blocked) => {
        if (!doc.node(node)) return;
        mutate(() => {
          doc.setMovementBlocked(node, from, to, blocked);
          return true;
        });
      },
      onSetCurve: (id, curve) => {
        const seg = doc.segment(id);
        if (!seg) return;
        const unchanged =
          seg.curve === curve ||
          (seg.curve !== null && curve !== null && seg.curve.t === curve.t && seg.curve.h === curve.h);
        if (unchanged) return;
        mutate(() => {
          doc.setSegmentCurve(id, curve);
          return true;
        });
      },
      onJoin: (node) => {
        mutate(() => joinSegments(doc, node));
        select(game.selectedSegment, game.selectedSegmentS, null, 'vias unidas');
        closeInspector();
      },
      onRemoveNode: (node) => {
        mutate(() => {
          const source = doc.node(node);
          if (!source) return false;
          for (const seg of [...source.incident]) doc.removeSegment(seg);
          doc.removeNode(node);
          doc.pruneOrphanNodes();
          return true;
        });
        select(game.selectedSegment, game.selectedSegmentS, null, 'ponto removido');
        closeInspector();
      },
      onDelete: (id) => {
        mutate(() => {
          doc.removeSegment(id);
          doc.pruneOrphanNodes();
          return true;
        });
        select(null, game.selectedSegmentS, game.selectedNode, 'via apagada');
        closeInspector();
      },
    },
  );
}

/** Duplicates the inspected road and keeps the copy selected for immediate editing. */
function duplicateSelectedSegment(id = game.selectedSegment): void {
  if (id === null) return;
  let copy: SegmentId | null = null;
  mutate(() => {
    copy = duplicateSegment(doc, net, id);
    return copy !== null;
  });
  if (copy !== null) {
    select(copy, game.selectedSegmentS, null, 'via duplicada');
    showInspector();
  }
}

function updateStatus(): void {
  text('roadCount', roadCountLabel(doc.segments.size));
  text('nodeCount', nodeCountLabel(doc.nodes.size));
  text('vehicleCount', vehicleCountLabel(sim.vehicles.size));
  text('pedCount', peopleCountLabel(sim.pedViews.length));
  // The time of day and the residents' day (`sim/city`).
  const minutes = sim.city.minutes(sim) % 1440;
  text('cityClock', `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`);
  // The city's numbers, computed all along and shown nowhere (audit P2-02).
  text('metricTrips', String(sim.completedTrips));
  text('metricLost', String(sim.entryDemandLost));
  let speedSum = 0;
  let queued = 0;
  for (const v of sim.vehicles.values()) {
    speedSum += v.v;
    if (v.v < 0.5) queued++;
  }
  text('metricSpeed', sim.vehicles.size ? `${Math.round((speedSum / sim.vehicles.size) * METERS_PER_UNIT * 3.6)} km/h` : '—');
  text('metricQueued', String(queued));
  text('zoomReadout', `${Math.round(view.zoom * 100)}%`);
  // From the seam, not the flat camera: under 3D that one never moves, so
  // the readout sat frozen at its start position through every pan and zoom.
  const centre = view.centre;
  text('coordReadout', `X ${Math.round(centre.x)} · Y ${Math.round(centre.y)}`);

  const el = document.getElementById('auditReadout');
  if (!el) return;

  const counts = summarize(sim.issues);
  if (counts.size === 0) {
    el.textContent = t('status.clear');
    el.className = 'good';
  } else {
    const parts = [...counts].map(([code, n]) => `${code}×${n}`);
    el.textContent = parts.slice(0, 2).join(' · ');
    el.className = 'bad';
  }
}

function text(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Do not let a hidden tab's elapsed wall time flood the accumulator.
    frameClock.restart();
    requestDraw();
  }
});

window.addEventListener('beforeunload', () => persistence.saveSession(doc, sessionSettings()));
// A hidden or discarded tab may never see `beforeunload` (phones, tab freezing).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistence.flush();
});
window.addEventListener('pagehide', () => persistence.saveSession(doc, sessionSettings()));

// A failed write says so, at most once a minute, instead of losing the map at
// the next reload in silence.
let saveWarnedAt = -Infinity;
persistence.onSaveFailed = () => {
  const now = performance.now();
  if (now - saveWarnedAt < 60_000) return;
  saveWarnedAt = now;
  flashHint('hint.saveFailed');
};

requestDraw();

// Refresh the readouts once, explicitly. The loop stops as soon as nothing is
// moving, so its UI work cannot be the only place that runs it: a map that
// loads paused ended the loop before the first status pass and kept the initial
// HTML for ever. Measured on an all-combinations map of 32 roads and 47 nodes:
// the roads drew, the status bar read "0 roads · 0 nodes", and the minimap was
// never resized from its default 300x150.
updateStatus();
syncFlatCameraFromView();
drawMinimap(minimapCanvas, doc, net, sim, camera, surface, viewFootprint());

// ------------------------------------------------------------- language & quality

const languageSelect = document.getElementById('languageSelect') as HTMLSelectElement;
for (const spec of LANGUAGES) {
  const option = document.createElement('option');
  option.value = spec.code;
  option.textContent = spec.label;
  languageSelect.appendChild(option);
}
languageSelect.value = language();
languageSelect.onchange = () => {
  const value = languageSelect.value;
  if (value === 'en' || value === 'pt-BR') setLanguage(value);
};

// Anything rendered from script rather than from markup has to be re-rendered
// when the language changes; `applyTranslations` only reaches elements that
// carry a key, and these were built by hand.
onLanguageChange(() => {
  refreshRoadTypeLabels();
  labelTools();
  renderToolHelp(toolHelpFor);
  renderPanelTitle();
  buildings.languageChanged();
  updateHint();
  updateStatus();
  refreshInspector();
  requestDraw();
});

const qualitySelect = document.getElementById('qualitySelect') as HTMLSelectElement;
const QUALITY_STORAGE_KEY = 'roadcraft.quality';
const savedQuality = (() => {
  try {
    return window.localStorage.getItem(QUALITY_STORAGE_KEY);
  } catch {
    return null;
  }
})();
qualitySelect.value = isQualityLevel(savedQuality) ? savedQuality : 'high';
gameState.set('quality', qualitySelect.value, 'preferência guardada');
qualitySelect.onchange = () => {
  const value = qualitySelect.value;
  if (!isQualityLevel(value)) return;
  gameState.set('quality', value, 'menu de qualidade');
  scene.setQuality(value);
  try {
    window.localStorage.setItem(QUALITY_STORAGE_KEY, value);
  } catch {
    // Not remembering the choice is not a reason to refuse it.
  }
  requestDraw();
};
/**
 * The game's state in the console (`core/gameState.ts`): `__state()` its
 * values now and the last changes - what, from what to what, why - newest first.
 */
(window as unknown as { __state: unknown }).__state = (count = 20): unknown => ({
  now: gameState.snapshot(),
  changes: gameState.latest(count).map((c) => `#${c.serial} ${c.key}: ${String(c.from)} → ${String(c.to)} (${c.cause})`),
});
/** The game's health in the console (`core/health.ts`): what broke or was slow, newest first. */
(window as unknown as { __health: unknown }).__health = (count = 30): unknown => health.latest(count);
/**
 * The last frames per system (`core/health.ts` `frameStats`): median, 95th
 * percentile and largest of each, and how many were long - the numbers the
 * baseline of each scenario and every "after" are taken from.
 */
(window as unknown as { __frames: unknown }).__frames = (since = 0): unknown =>
  frameStats(frameTimer.recent().filter((f) => f.start >= since));

/**
 * The simulation's own checks (`sim/invariants.ts`, run every 60 ticks) in
 * the health log: a check that did not hold is a warning with where and
 * when. Each issue once (they stay in `sim.issues` until it is cleared).
 */
const issuesSeen = new WeakSet<object>();
function noteSimulationIssues(): void {
  for (const issue of sim.issues) {
    if (issuesSeen.has(issue)) continue;
    issuesSeen.add(issue);
    health.record('invariant', 'warning', `Simulação: ${issue.code}`, { detail: `${issue.subject}: ${issue.detail} (passo ${issue.tick})` });
  }
}

const valueText = (value: unknown): string => (value === null || value === undefined ? '—' : typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value));
mountHealthPanel({
  log: health,
  world: (n) => doc.changes.latest(n).map((c) => {
    const where = c.rects === null ? 'mapa inteiro' : `${c.rects.length} ret.`;
    return `#${c.serial} ${c.kind} · ${c.cause}${c.parent ? ` ← #${c.parent}` : ''} · ${where}${c.ms !== undefined ? ` · ${c.ms.toFixed(1)} ms` : ''}${c.detail ? ` · ${c.detail}` : ''}`;
  }),
  state: (n) => ({
    now: Object.entries(gameState.snapshot()).map(([key, value]) => `${key}: ${valueText(value)}`),
    changes: gameState.latest(n).map((c) => `${c.key}: ${valueText(c.from)} → ${valueText(c.to)} (${c.cause})`),
  }),
});
/**
 * The diary of changes in the console (`world/changes.ts`): `__changes()`
 * lists the last ones - what, why, after what, where, how long it took -
 * newest first; `__changes(n, serial)` the chain back from one entry to the
 * edit it follows from.
 */
(window as unknown as { __changes: unknown }).__changes = (count = 30, serial?: number): unknown => {
  const row = (c: Change) => ({
    serial: c.serial, kind: c.kind, cause: c.cause, after: c.parent ?? '',
    where: c.rects === null ? 'mapa inteiro' : `${c.rects.length} ret. ${Math.round(c.rects.reduce((a, r) => a + (r[2] - r[0]) * (r[3] - r[1]), 0) / 1e3)} mil u²`,
    ids: c.ids?.slice(0, 8).join(' ') ?? '', ms: c.ms === undefined ? '' : c.ms.toFixed(1), detail: c.detail ?? '',
  });
  if (serial !== undefined) {
    const chain: Change[] = [];
    for (let c = doc.changes.get(serial); c && chain.length < count; c = c.parent ? doc.changes.get(c.parent) : undefined) chain.push(c);
    console.table(chain.map(row));
    return chain;
  }
  const rows = doc.changes.latest(count);
  console.table(rows.map(row));
  return rows;
};

// Diagnostic surface for browser-driven checks.
(window as unknown as { __roadcraft: unknown }).__roadcraft = {
  doc,
  net,
  sim,
  camera,
  surface,
  DT,
  exportMap: () => exportToFile(doc, sessionSettings()),
  importMap: async () => openImported(await importFromFile()),
  /** The public transport tool, for the probes (`scripts/transit-shots.mjs`). */
  transit: transitEditor,
  setTraffic: (enabled: boolean) => {
    if (!game.paused !== enabled) trafficButton.click();
  },
  setRoadHeight: (metres: number) => {
    roadTool.heightChosen(metres * UNITS_PER_METER);
    requestDraw();
  },
  /** A generated city (`editor/cityGenerator.ts`), and how far its building has gone. */
  generateCity: (options: Partial<CityOptions> = {}) => generateCity({ ...DEFAULT_CITY, ...options }),
  /** Probe: one building grown on a zoned lot, and what it cost (ms). */
  growTimed: () => { const t = performance.now(); const id = growOnLot({ doc, net, groundAt: (x, y) => scene.terrainHeightAt(x, y) }, lotTool.refused, 0x5eed); return { id, ms: performance.now() - t }; },
  cityGrowth: () => (cityGrowth || cityProgress.style.display === 'block' ? { pending: true } : null),
  cityBuiltIn: () => cityBuiltIn,
  /** Replaces the map as loading a file does: document, network and simulation topology. */
  loadDoc: (data: ReturnType<RoadDoc['toJSON']>) => {
    history.record(doc);
    applySnapshot(data, 'import');
  },
  /**
   * Centres the play camera on a world point, so the next frame builds what
   * is there (the crowd and the shadow frustum follow the play view). The
   * inspection camera then photographs that frame (`scene().inspect`).
   */
  /** The transport tool, for the browser checks. */
  transitTool: () => transitEditor,
  lookAt: (x: number, y: number, zoom = camera.zoom) => {
    camera.x = x;
    camera.y = y;
    camera.zoom = zoom;
    syncViewFromFlatCamera();
    requestDraw();
  },
  /** Forces one frame. Used by the browser verification harness. */
  redraw: () => requestDraw(),
  /**
   * Runs the simulation for `seconds` of SIMULATION time, immediately.
   *
   * The clock deliberately refuses to catch up more than `MAX_SUBSTEPS` per
   * frame, which is right for a game and useless for a harness: on a software
   * rasteriser at seven frames a second, waiting in wall time for a junction to
   * fill with traffic or for a signal to reach green takes minutes and is not
   * reproducible. This runs the fixed steps directly.
   */
  runSim: (seconds: number) => {
    sim.clock.run(Math.max(0, Math.round(seconds / DT)), () =>
      step(sim, { traffic: true, pedestrians: true }),
    );
    requestDraw();
  },
  pickAtScreen: (x: number, y: number) =>
    findAnchor(
      doc,
      net,
      worldAtScreen(x, y),
      view.zoom,
    ),
  // The pole tool, as the tool itself runs it: plan from two raw points, then
  // commit that plan. A harness that called the geometry directly would be
  // testing something the player cannot reach.
  utilities: {
    plan: (from: Vec2, to: Vec2, reach = POLE_PICK_PIXELS / view.zoom) =>
      planPoleRun(doc, net, from, to, reach),
    run: (from: Vec2, to: Vec2, reach = POLE_PICK_PIXELS / view.zoom) => {
      const plan = planPoleRun(doc, net, from, to, reach);
      return mutateBuilt(() => commitPoleRun(doc, plan));
    },
  },
  audit: () => [...sim.issues],
  /** The live three.js scene handle, for browser-driven checks. */
  scene: () => scene,
  /** The orbit camera (`setOrbit(azimuth, elevation)`), for photographing from a chosen angle. */
  view: () => view,
  /** The building tool, for browser-driven checks. */
  buildings: buildings.tool,
  /** One fixed simulation step, as the game takes it, without traffic or new pedestrians if asked. */
  step: (traffic = true, pedestrians = true) => step(sim, { traffic, pedestrians }),
};

/** A polyline with points added so no step is longer than `step`. */
function densify(points: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  points.forEach((p, i) => {
    if (i === 0) { out.push(p); return; }
    const q = points[i - 1]!;
    const n = Math.max(1, Math.ceil(dist(p, q) / step));
    for (let k = 1; k <= n; k++) out.push({ x: q.x + (p.x - q.x) * (k / n), y: q.y + (p.y - q.y) * (k / n) });
  });
  return out;
}

/** Whether the road tool is drawing a road right now (a drag, a chained stretch or a curve). */
/** Asks the interface to redraw its panels (a state it shows changed in the game). */
function refreshShell(): void {
  const host = document.getElementById('game');
  if (host) { const t = host.dataset['tool'] ?? ''; host.dataset['tool'] = ''; host.dataset['tool'] = t; }
}

// Buildings run down without maintenance (\`decayOf\`): checked every few
// seconds, a record changes only when its decay moves a tenth.
setInterval(() => {
  const now = sim.city.minutes(sim);
  let changed = false;
  for (const b of [...doc.buildings.all()]) {
    if (b.builtAt === undefined) continue;
    const decay = decayOf(b.builtAt, now);
    if (decay !== (b.decay ?? 0)) { caused('desgaste dos prédios', () => doc.buildings.put({ ...b, decay })); changed = true; }
  }
  if (changed) requestDraw();
}, 3000);

/**
 * The Actions (`actionsWiring.ts`): the pistol, the bomb, the buildings it
 * breaks and the fires it leaves.
 */
const actions = createActions({
  doc,
  net,
  sim,
  scene,
  buildingAt: (screen) => buildings.tool.buildingAt(screen),
  view: () => view,
  size: () => ({ w: surface.cssW, h: surface.cssH }),
  heightAt: (p) => sceneHeightAt(p),
  strength: () => strikeChoice.strength,
  mutate: (fn) => mutate(fn),
  caused: (cause, fn) => caused(cause, fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
  holdGrowth: (until) => { zoneGrowthHold = until; },
});

// Everything is set up: the first frame may be drawn.
booted = true;
requestDraw();
