import { walkersNear } from '@sim/agents/walk';
import type { BodyPart } from '@sim/people/view';
import { beginFrameWork, workUntil } from '@core/frameWork';
import { GameState } from '@core/gameState';
import { FrameTimer, HealthLog } from '@core/health';
import { watchHealth } from '@ui/healthWatch';
import { mountHealthPanel } from '@ui/healthPanel';
import { METERS_PER_UNIT } from '@world/units';
import type { Occupant } from '@render/ragdoll';
import type { LotOverlayInput } from '@render/lotOverlay';
import { addPolygonLot, applyLots, curveLotSide, cutLines, deleteLot, insideLot, joinLots, lotCentre, lotFrame, lotRect, lotSnapper, moveLotCorner, onLand, setLotFront, planLots, splitLot, zoneLots, type Lot } from '@world/lots';
import { type Vec2, dist } from '@core/vec2';
import { COARSE_EPS, clamp } from '@core/scalar';
import { flattenSegment, shapeFromControl, type CurveShape } from '@core/bezier';
import { RoadDoc, fitRoadCurve, type JunctionControl } from '@world/doc';
import type { Change, ChangeKind } from '@world/changes';
import { MIN_LINK_LENGTH } from '@world/approach';
import { MAX_AUTHORED_GRADE } from '@world/elevation';
import { Network } from '@world/network';
import { DEFAULT_CITY, planCity, type CityOptions } from '@world/cityGen/plan';
import { layCity, zoneCity } from '@editor/cityGenerator';
import { LAST_UPGRADE_CLASS, Level, ROAD_TYPES, halfWidth, roadProfile, roadType } from '@world/roadTypes';
import { UNITS_PER_METER } from '@world/units';
import { MAX_TERRAIN_STAMPS, RELIEF_NATURAL, type TerrainMode } from '@world/terrain';
import type { GeologyKind } from '@world/terrainPaint';
import { DEFAULT_REGION, isRegionId, type NatureSettings } from '@world/ecology';
import type { NodeId, PoleId, SegmentId } from '@world/ids';
import { BARRIER_KINDS, type BarrierKind } from '@world/barriers';
import { barrierProblem, snapBarrierPoint } from '@editor/barriers';
import {
  POLE_PICK_PIXELS,
  commitPoleRun,
  planPoleRun,
  snapPole,
  type PoleRunPlan,
} from '@editor/poles';
import { blockGridChoice, onRoadGridChange, roadGridShown, signChoice, strikeChoice, zoneColoursShown, paintKind, poleLampMode, poleToolMode, roadWidth, streetscapeKind, fogErase, fogBrush, setFogBrush, gullyErase, treeMode, treeKind, treeBrush, setTreeBrush, cloudMode, cloudBrush, setCloudBrush, elementKind, elementMode, elementBrush, setElementBrush, syncElementInputs } from '@ui/toolChoices';
import { scatter } from '@world/elements';
import { cloudUnder, driftedCloud, scatterClouds } from '@world/clouds';
import { oneTree, plantTrees } from '@world/trees';
import { playThunder } from '@ui/thunder';
import { MAP_SIZE } from '@world/bounds';
import { blockGridLines, commitBlockGrid } from '@editor/blocks';
import { m } from '@world/units';
import { GRID_CELL, GRID_STEP, snapToGrid } from '@world/grid';
import { sectionForWidth } from '@world/roadSection';
import { LANDSCAPE_RADIUS, landscapeNear, snapLandscape, type LandscapeSnap } from '@world/landscape';

import { Camera } from '@view/camera';
import { type Viewport, flatViewport } from '@view/viewport';
import { CanvasSurface } from '@ui/overlay/surface';
import { INVALID, SELECTION, HOVER } from '@ui/overlay/palette';
import { createSceneRenderer, type BlastHit, type SceneHandle, type SkyMode } from '@render/renderer';
import { primeSurfaceBake, startSurfaceBake } from '@render/surfaceBakeClient';
import { DEFAULT_AZIMUTH, DEFAULT_ELEVATION, isoZoomBounds } from '@render/isoViewport';

import { SimWorld } from '@sim/world';
import { rebindAgents, rebindPeds, rebindVehicles, step } from '@sim/pipeline';
import { DT, NARROW_SCREEN_SHARE, NARROW_SCREEN_WIDTH } from '@sim/params';
import { summarize } from '@sim/audit';

import {
  type Anchor, anchorForHeight as anchorAtHeight, anchorHeightOffset as anchorHeightAt, findAnchor, setGridSnapStep, snapRoadEndpoint, snapRoadStart, type SnapResult,
} from '@editor/snap';
import { type DraftResult, commitRoadPath, duplicateSegment, joinSegments, reconcileMovedNode, splitSegment } from '@editor/commit';
import { commitPedestrianCrossing } from '@editor/streetObjects';
import { roadPathFromGesture, type RoadPathPiece, type RoadPathPoint } from '@editor/roadPath';
import { commitRoundabout } from '@editor/roundabout';
import { freeRoadsEnabled } from '@ui/roadSectionEditor';
import { roadParking } from '@editor/roadParking';
import { History, restoreInto, restoreSnapshot, serialize } from '@editor/history';
import { type ImportResult, Persistence, exportToFile, importFromFile, type SavedSettings, DEFAULT_TRAFFIC_COUNT, DEFAULT_PEDESTRIAN_COUNT, MAX_TRAFFIC_COUNT, MAX_PEDESTRIAN_COUNT } from '@editor/persistence';
import { drawMinimap, minimapToWorld } from '@ui/minimap';
import { openInspector, closeInspector, refreshInspector } from '@ui/inspector';
import { TransitTool, setTransitTool } from '@editor/transitTools';
import { vehiclePose } from '@sim/pose';
import { type Building, type BuildingId, decayOf } from '@world/buildings/types';
import { solidFootprints, worldToLocal } from '@world/buildings/geometry';
import { closestOnSegment } from '@core/intersect';
import { pointInPolygon } from '@core/polygon';
import { signalPosts } from '@world/signalPosts';
import { resolveBlocks } from '@world/buildings/blocks';
import { strandVehicle } from '@sim/vehicles/state';
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
interface RoadDraft {
  readonly start: Anchor;
  readonly startHeightOffset: number;
  readonly chained: boolean;
  readonly pressedAt: Vec2;
  snap: SnapResult;
  readonly samples: RoadPathPoint[];
  heightOffset: number;
  curveControl?: Vec2;
}

interface CurvePending {
  readonly start: Anchor;
  readonly startHeightOffset: number;
  end: Anchor;
  endHeightOffset: number;
  control: Vec2;
}

/**
 * A pole run being drawn.
 *
 * `from` is where the gesture started and `to` is the pointer. Neither is
 * where anything is BUILT: `planPoleRun` snaps both and decides the poles,
 * and the preview draws that plan rather than the raw drag, so what is under
 * the pointer is what appears on release.
 *
 * `chained` marks a run whose start came from the previous run's last pole
 * rather than from a fresh press, which is how a line is traced across a map
 * in several straight stretches without restarting the tool at every corner.
 */
interface PoleDraft {
  readonly from: Vec2;
  to: Vec2;
  readonly chained: boolean;
}

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
/**
 * How far a drag's stroke is carried, in plan, by the heights changed during
 * it. The cursor is read on the plane at the road's height; raising the road
 * mid-drag moved that plane up, the point under a still cursor jumped towards
 * the camera, and the stroke doubled back on itself into a loop.
 */
let draftShift = { x: 0, y: 0 };
let roadHeightEdited = false;
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
/** Brush paints the cells under the pointer; Fill paints a street side's whole block. */
type ZoneMode = 'brush' | 'fill' | 'edit' | 'front' | 'split' | 'join' | 'add' | 'polygon' | 'curve' | 'delete';
/** How the split tool cuts (`LotCut`): across the front, parallel to it, or along a drawn line. */
type LotSplitKind = 'vertical' | 'horizontal' | 'line';
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

let draft: RoadDraft | null = null;
let roadChain: Anchor | null = null;
let roadChainHeight = 0;
let chainPreview: RoadDraft | null = null;
let curvePending: CurvePending | null = null;
let roadPointerScreen: Vec2 | null = null;
let poleDraft: PoleDraft | null = null;
/**
 * The end of the last committed pole run, while the tool is still on it.
 *
 * A distribution line is drawn as a sequence of straight stretches, and
 * finishing one is almost never finishing the line. Holding the last pole
 * means the next press continues from it instead of starting a disconnected
 * run a few units away. Escape, a different tool or an undo drops it.
 */
let poleChain: Vec2 | null = null;
/** The pole run planned for this frame (`currentPolePlan`), shared by the 3D preview and the overlay. */
let framePolePlan: PoleRunPlan | null = null;
/** The pointer over the map while the pole tool is in hand, unsnapped. */
let poleHover: Vec2 | null = null;
/** Where the landscaping tool would put its item, under the pointer. */
let streetscapeHover: LandscapeSnap | null = null;
/** Pick radius for a placed item and the reach of the footway snap, world units. */
const streetscapeReach = (): number => Math.max(m(1.5), 26 / view.zoom);
/**
 * The wall, fence or hedge being traced (`world/barriers.ts`): the kind in
 * hand, the points put down so far, and where the pointer is.
 */
let barrierPoints: Vec2[] | null = null;
/** The last click of the walls tool, to tell a double click (which ends the run). */
let lastBarrierClick: { t: number; x: number; y: number } | null = null;
let barrierCursor: Vec2 | null = null;
/** The corners of a lot being drawn point by point (the polygon tool). */
let lotPolygon: Vec2[] = [];
/** A drawn cut line, and a side being curved. */
let lotCutLine: { pointer: number; a: Vec2; b: Vec2 } | null = null;
let lotCurve: { pointer: number; a: Vec2; b: Vec2; through: Vec2 } | null = null;
/** The snap of lot points to the footways, the blocks' corners and the other lots' corners. */
const lotSnapReach = (): number => Math.max(m(2.5), 16 / Math.max(0.05, view.zoom));
const lotSnap = (p: Vec2, skip?: number): Vec2 => lotSnapper(doc, net)(p, lotSnapReach(), skip).p;
/** The side of a lot nearest a point: its two corners. */
function lotSideNear(p: Vec2): { a: Vec2; b: Vec2 } | null {
  let best: { a: Vec2; b: Vec2 } | null = null, bestD = 18 / Math.max(0.05, view.zoom);
  for (const l of doc.lots) for (let i = 0; i < l.corners.length; i++) {
    const a = l.corners[i]!, b = l.corners[(i + 1) % l.corners.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const d = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
    if (d < bestD) { bestD = d; best = { a, b }; }
  }
  return best;
}
/** The side of a lot nearest a point within reach: the lot and the side's index (corner i to i + 1). */
function lotSideAt(p: Vec2): { lot: Lot; side: number; a: Vec2; b: Vec2 } | null {
  let best: { lot: Lot; side: number; a: Vec2; b: Vec2 } | null = null, bestD = 18 / Math.max(0.05, view.zoom);
  for (const l of doc.lots) for (let i = 0; i < l.corners.length; i++) {
    const a = l.corners[i]!, b = l.corners[(i + 1) % l.corners.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    // Inside the lot counts as nearer: of two lots sharing a side, the one the pointer is in.
    const d = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y) - (insideLot(p, l) ? 1e-3 : 0);
    if (d < bestD) { bestD = d; best = { lot: l, side: i, a, b }; }
  }
  return best;
}
/** A dragged corner's snap: onto the streets and other corners, never onto itself. */
function lotSnapExcept(p: Vec2, from: Vec2): Vec2 {
  const snap = lotSnapper(doc, net, doc.lots.map((l) => ({ id: l.id, corners: l.corners.filter((q) => Math.hypot(q.x - from.x, q.y - from.y) > m(0.8)) })));
  return snap(p, lotSnapReach()).p;
}
/** Whether the segment a-b passes through the inside of a lot. */
function segmentCrossesLot(a: Vec2, b: Vec2, q: readonly Vec2[]): boolean {
  for (let k = 0; k <= 20; k++) if (insideLot({ x: a.x + (b.x - a.x) * k / 20, y: a.y + (b.y - a.y) * k / 20 }, { corners: q })) return true;
  return false;
}
/**
 * Which side of a lot is its front: the longest of those against a street
 * (a lot cut back to the footway has many short sides round a corner's curve,
 * and its front is the long straight one).
 */
function frontSideOf(points: readonly Vec2[]): number {
  const sides = points.map((p, i) => {
    const q = points[(i + 1) % points.length]!;
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    let d = Infinity;
    for (const r of net.ribbons.values()) d = Math.min(d, r.full.distanceTo(mid));
    return { i, d, length: Math.hypot(q.x - p.x, q.y - p.y) };
  });
  const nearest = Math.min(...sides.map((side) => side.d));
  return sides.filter((side) => side.d < nearest + m(1.5)).sort((a, b) => b.length - a.length)[0]?.i ?? 0;
}
/** A lot as drawn, cut back to the footways (`onLand`), with its front; null when nothing is left on land. */
function landLot(points: readonly Vec2[]): { corners: Vec2[]; front: number } | null {
  const corners = onLand(net, points);
  return corners ? { corners, front: frontSideOf(corners) } : null;
}
/**
 * The lots (`world/lots.ts`): drawn by the player in the Zoning tool, as
 * areas, and zoned there; buildings grow on the zoned ones. The roads neither
 * make, change nor show them (the player, 2026-10-06).
 */
const lotAt = (p: Vec2): Lot | undefined => doc.lots.find((l) => insideLot(p, l));
/** A stroke of the lot brush, a corner being dragged, a lot being drawn, the first lot of a join. */
let lotStroke: { pointer: number; remove: boolean; ids: Set<number> } | null = null;
let lotCorner: { pointer: number; from: Vec2; to: Vec2 } | null = null;
let lotNew: { pointer: number; a: Vec2; b: Vec2; angle: number } | null = null;
let lotJoinFirst: number | null = null;
const lotRefused = new Set<number>();
let lotRefusedNet = -1;
/** The direction of the street nearest a point, for a lot drawn there. */
function streetAngleNear(p: Vec2): number {
  let best = Infinity, angle = 0;
  for (const r of net.ribbons.values()) {
    const d = r.full.distanceTo(p);
    if (d >= best) continue;
    const f = r.full.sampleAt(r.full.closestPoint(p).s);
    best = d; angle = Math.atan2(f.t.y, f.t.x);
  }
  return angle;
}
/** A stroke of the delete mode: the lots and buildings it has passed over, removed on release as one undo step. */
let zoneErase: { pointer: number; lots: Set<number>; buildings: Set<BuildingId> } | null = null;
/** What the delete stroke takes at a point: the lot there, the building there. */
function eraseUnder(world: Vec2): void {
  if (!zoneErase) return;
  const lot = lotAt(world);
  if (lot) {
    zoneErase.lots.add(lot.id);
    if (lot.building !== undefined) zoneErase.buildings.add(lot.building as BuildingId);
  }
  for (const b of doc.buildings.all()) {
    if (Math.hypot(b.x - world.x, b.y - world.y) > m(80)) continue;
    if (solidFootprints(b).some((ring) => insideLot(world, { corners: ring }))) zoneErase.buildings.add(b.id as BuildingId);
  }
}
let zoneHover: Vec2 | null = null;
let hoverAnchor: Anchor | null = null;
/** What is selected - a road (and where along it) or a junction - written through the game's state with why (`gameState`). */
function select(segment: SegmentId | null, s: number | null, node: NodeId | null, cause: string): void {
  gameState.set('selectedSegment', segment, cause);
  gameState.set('selectedSegmentS', s, cause);
  gameState.set('selectedNode', node, cause);
}

/**
 * Panning is stored as the GROUND POINT that was grabbed, not as a screen
 * origin and a camera origin.
 *
 * "Keep what I grabbed under the pointer" is the same rule in both renderers;
 * "shift the camera by the screen delta over the zoom" is only true looking
 * straight down. Storing the grabbed point means one rule, tested once, and no
 * branch here at all.
 */
let panning: {
  id: number;
  grabbed: Vec2;
  /** Where a right press began, CSS px, and whether it has since become a drag. */
  pressed?: Vec2;
  moved?: boolean;
  /** A right click that stays a click cancels the gesture in progress. */
  cancelOnClick?: boolean;
} | null = null;
/** Camera turn and tilt per CSS pixel of an orbit drag, rad: a full turn in ~1000 px. */
const ORBIT_PER_PX = 0.0063;
/**
 * Which way a twist of two fingers turns the camera, so the map turns with
 * them: a positive orbit turns the map anticlockwise on screen, and a
 * clockwise twist grows the angle between the fingers.
 */
const TWIST_SIGN = -1;
/** How far a right press may travel, CSS px, and still be a click rather than a pan. */
const CLICK_SLOP = 5;
/** Camera turn per Q/E press, rad. */
const KEY_TURN = Math.PI / 12;
/** A camera orbit in progress: the pointer and where it last was, CSS px. */
let orbiting: { id: number; last: Vec2; pressed: Vec2; moved: boolean; cancelOnClick: boolean; height: number } | null = null;
/**
 * A node being dragged, with the document as it was when the drag began. The
 * live preview edits the document, and each step through a spot where an
 * incident curve would be too tight flattened it for good (`fitCurve`); the
 * snapshot is what cancel restores and what the undo step records.
 */
let moving: { node: NodeId; origin: Vec2; before: ReturnType<RoadDoc['toJSON']> } | null = null;
/**
 * A terrain stroke in progress.
 *
 * `level` is captured ONCE, when the stroke starts, and reused for every dab in
 * it. That is what makes levelling predictable: a player drags across a slope
 * and the whole swept area comes to the height they started from, instead of
 * each dab chasing the ground under itself and leaving the slope exactly as it
 * was. `at` is kept so a held pointer keeps working the same spot.
 */
let terrainStroke: {
  pointer: number;
  last: Vec2;
  at: Vec2;
  level: number;
  /** Wall time of the last dab, for the rate limit. */
  applied: number;
  /** The id its dabs carry, so they move the ground as one stroke (`TerrainStamp.stroke`). */
  id: number;
} | null = null;
/** Drives the held-still repeat of a flatten, so holding the button keeps levelling. */
let terrainRepeat: ReturnType<typeof setInterval> | null = null;
let pinch: { d0: number; zoom0: number; world: Vec2; angle: number } | null = null;
const pointers = new Map<number, Vec2>();
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
// The renderer starts its asynchronous shader preparation while topology and
// pedestrian navigation still build. Both finish before the first game frame.
sim.rebuildTopology();
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
  draft = null;
  roadChain = null;
  chainPreview = null;
  curvePending = null;
  if (source === 'import') {
    restoreInto(doc, data, net);
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
  const authoredHeight = game.tool === 'road' && (draft || roadChain || curvePending)
    ? game.roadHeightOffset
    : undefined;
  return worldAtScreen(e.clientX - r.left, e.clientY - r.top, authoredHeight);
}

/**
 * The point a pan or pinch holds under the pointer.
 *
 * Solved on the SAME plane `view.panTo` solves on, which is the `y = 0` plane,
 * and deliberately not with `worldAtScreen`. That one lifts the point onto the
 * terrain or deck under the cursor, and `panTo` then compared a point on that
 * plane with one on `y = 0`: the two differ by `height / tan(48°)` along the
 * view, so the first move of every drag jerked the map that far — 35 px at
 * 500 %, 139 px at 2000 % on the default terrain. Under an orthographic camera
 * a horizontal shift moves every plane identically, so holding the `y = 0`
 * point under the pointer IS holding what was grabbed.
 */
function panAnchor(px: number, py: number): Vec2 {
  return view.toWorld(px, py, surface.cssW, surface.cssH);
}

function panAnchorOf(e: PointerEvent): Vec2 {
  const r = canvas.getBoundingClientRect();
  return panAnchor(e.clientX - r.left, e.clientY - r.top);
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
  draft = null;
  roadChain = null;
  chainPreview = null;
  curvePending = null;
  poleDraft = null;
  poleChain = null;
  barrierPoints = null;
  zoneErase = null;
  // A lot being drawn, dragged, cut or bent, or the first lot of a join: dropped.
  lotPolygon = [];
  lotNew = null;
  lotCorner = null;
  lotCurve = null;
  lotCutLine = null;
  lotStroke = null;
  lotJoinFirst = null;
  bulldozeBox = null;
  endTerrainStroke();
  cancelMove();
  panning = null;
  orbiting = null;
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
  if (pinch) return 'câmera: pinça';
  if (orbiting) return 'câmera: girando';
  if (panning) return 'câmera: arrastando';
  if (moving) return 'via: movendo um nó';
  if (draft) return 'via: desenhando';
  if (curvePending) return 'via: curvando';
  if (roadChain) return 'via: encadeando';
  if (settlingRoad) return 'via: assentando';
  if (terrainStroke) return 'terreno: pincelando';
  if (poleDraft || poleChain) return 'poste: traçando a linha';
  if (barrierPoints) return 'cerca: traçando';
  if (bulldozeBox) return 'demolir: retângulo';
  if (cloudDrag) return 'nuvem: arrastando';
  if (zoneErase) return 'zona: apagando';
  if (lotStroke) return lotStroke.remove ? 'lote: tirando zona' : 'lote: pintando zona';
  if (lotCorner) return 'lote: movendo um canto';
  if (lotNew) return 'lote: desenhando';
  if (lotCutLine) return 'lote: cortando';
  if (lotCurve) return 'lote: curvando um lado';
  if (lotPolygon.length > 0) return 'lote: polígono';
  if (lotJoinFirst !== null) return 'lote: unindo';
  return null;
}
function syncGesture(): void {
  // Before the boot the file may not have run to the gestures' own variables.
  if (!booted) return;
  gameState.set('gesture', currentGesture(), `ferramenta ${game.tool}`);
}
// After the event's own handlers (a microtask, after the whole dispatch).
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'keyup'] as const) {
  window.addEventListener(type, () => queueMicrotask(syncGesture), { capture: true, passive: true });
}

/**
 * The Actions' pistol: a shot at the person under the pointer, striking the
 * part of the body clicked - the head, the body, an arm or a leg, the side
 * as the body faces (`PedestrianEngine.shot`): the wound, the blood, a limb
 * off, death. From the view, with no player on the map.
 */
function shootAt(sx: number, sy: number): boolean {
  const w = surface.cssW, h = surface.cssH;
  const ground = view.toWorldAt(sx, sy, sceneHeightAt(view.toWorld(sx, sy, w, h)), w, h);
  let best: { id: number; height: number; d: number; x: number; y: number; heading: number } | null = null;
  for (const p of walkersNear(sim, ground.x, ground.y, m(25))) {
    // Down on the ground: their body is shot where it lies (below).
    if (scene.isDown(p.id)) continue;
    const base = sceneHeightAt(p);
    // Up the body's axis: where the line of sight through the pointer passes nearest it.
    for (let k = 0; k <= 37; k++) {
      const height = m(0.05) * k;
      const q = view.toWorldAt(sx, sy, base + height, w, h);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      // The body's reach about its axis, arms out included (at 0.3 m a shot on an arm out swinging missed).
      if (d < m(0.42) && (!best || d < best.d)) best = { id: p.id, height, d, x: p.x, y: p.y, heading: p.heading };
    }
  }
  if (!best) {
    // The bodies on the ground, alive or dead, along the line of sight.
    // The line of sight between just under the ground and a little above the
    // tallest thing it can strike (a van, a rider's head): from much higher
    // the point was behind a camera zoomed in close, and the line went askew.
    const lo = sceneHeightAt(ground) - m(0.3), hi = lo + m(5);
    const a = view.toWorldAt(sx, sy, hi, w, h), b = view.toWorldAt(sx, sy, lo, w, h);
    const hit = scene.shootBody([a.x, a.y, hi], [b.x, b.y, lo]);
    if (hit && hit !== 'hit') {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const done = sim.pedEngine.shot?.(sim, hit.alive, hit.part, b.x - ((b.x - a.x) / len) * m(10), b.y - ((b.y - a.y) / len) * m(10));
      if (done) scene.wound(b.x, b.y, lo + m(0.4), (b.x - a.x) / len, (b.y - a.y) / len, done.severed);
    }
    if (hit) { requestDraw(); return true; }
    if (shootVehicle(a, b, hi, lo)) { requestDraw(); return true; }
    flashHint('hint.shoot.miss');
    return false;
  }
  // Where the line of sight comes from, on the ground plane: the shot's way.
  // The shot's way: from the viewer into the scene, which on the ground is
  // the way up the screen (measured 2026-10-06: taken from a point higher on
  // the line of sight it pointed back at the viewer, so the shot "came from"
  // behind the person, who turned away from the camera to face it).
  const gz = sceneHeightAt(best);
  const farther = view.toWorldAt(sx, sy - 40, gz, w, h), nearer = view.toWorldAt(sx, sy + 40, gz, w, h);
  let dx = farther.x - nearer.x, dy = farther.y - nearer.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  // Left or right of the body's middle, as the body faces.
  const at = view.toWorldAt(sx, sy, sceneHeightAt(best) + best.height, w, h);
  const side = (at.x - best.x) * -Math.sin(best.heading) + (at.y - best.y) * Math.cos(best.heading);
  const part: BodyPart = best.height > m(1.5) ? 'head'
    : best.height > m(0.9) ? (Math.abs(side) > m(0.17) ? (side > 0 ? 'armL' : 'armR') : 'torso')
      : side >= 0 ? 'legL' : 'legR';
  const done = sim.pedEngine.shot?.(sim, best.id, part, best.x - dx * m(10), best.y - dy * m(10));
  if (!done) return false;
  scene.wound(best.x, best.y, sceneHeightAt(best) + best.height, dx, dy, done.severed);
  requestDraw();
  return true;
}
/** Shots each vehicle has taken on its bodywork: enough of them and it burns and blows up (`shootVehicle`). */
const vehicleShots = new Map<number, number>();

/**
 * A shot along the line of sight from `a` (height `hi`) to `b` (height `lo`)
 * at the traffic, as GTA lets a player shoot at it: a cyclist or a
 * motorcyclist shot off their machine, dead, the machine falling over; a
 * driver shot through the glass, the car rolling to a stop; the bodywork
 * sparking, and after a dozen hits the car on fire and blowing up.
 */
function shootVehicle(a: Vec2, b: Vec2, hi: number, lo: number): boolean {
  let best: { v: ReturnType<typeof sim.vehicles.get> & object; t: number; x: number; y: number; z: number; up: number; angle: number } | null = null;
  for (const v of sim.vehicles.values()) {
    const pose = vehiclePose(sim, v, 1);
    if (!pose) continue;
    const g = sceneHeightAt(pose.p);
    const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
    // A rider sits above a two-wheeler's frame: the box up to their head.
    const two = v.archetype.shape === 'bicycle' || v.archetype.shape === 'motorcycle';
    const L = v.archetype.length / 2, W = Math.max(v.archetype.width / 2, two ? m(0.35) : 0), H = two ? Math.max(v.archetype.height, m(1.75)) : v.archetype.height;
    // The segment in the vehicle's frame, clipped by each pair of faces (slabs).
    const ax = a.x - pose.p.x, ay = a.y - pose.p.y, bx = b.x - pose.p.x, by = b.y - pose.p.y;
    const p0 = [ax * c + ay * s, -ax * s + ay * c, hi - g], p1 = [bx * c + by * s, -bx * s + by * c, lo - g];
    const lo3 = [-L, -W, 0], hi3 = [L, W, H];
    let t0 = 0, t1 = 1;
    for (let i = 0; i < 3 && t0 <= t1; i++) {
      const d = p1[i]! - p0[i]!;
      if (Math.abs(d) < 1e-9) { if (p0[i]! < lo3[i]! || p0[i]! > hi3[i]!) t0 = 2; continue; }
      let ta = (lo3[i]! - p0[i]!) / d, tb = (hi3[i]! - p0[i]!) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (t0 > t1 || (best && t0 >= best.t)) continue;
    const z = hi + (lo - hi) * t0;
    best = { v, t: t0, x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0, z, up: (z - g) / H, angle: pose.angle };
  }
  if (!best) return false;
  const { v, x, y, z } = best;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dirX = (b.x - a.x) / len, dirY = (b.y - a.y) / len;
  const shape = v.archetype.shape;
  const css = String(v.color ?? '#777777');
  const color = parseInt(css.replace('#', '').slice(0, 6), 16) || 0x777777;
  if (shape === 'bicycle' || shape === 'motorcycle') {
    // The rider shot off: thrown down dead, the machine falling over.
    const g = sceneHeightAt({ x, y });
    scene.wound(x, y, g + m(1.2), dirX, dirY, null);
    scene.flingOccupants([{ id: 8_000_000 + v.id, x, y, z: g + m(0.9), heading: best.angle, blastX: x - dirX * m(4), blastY: y - dirY * m(4),
      power: 0.15, kind: 'dead', index: scene.driverBody(v, x, y) }]);
    scene.dropVehicle({ id: v.id, archetype: v.archetype, x, y, angle: best.angle, color, dirX, dirY });
    sim.removeVehicle(v);
    vehicleShots.delete(v.id);
    return true;
  }
  // Through the glass (the upper part of the body): the driver killed, the car rolling to a stop.
  const glass = best.up > 0.55;
  scene.vehicleHit(x, y, z, dirX, dirY, glass, glass);
  if (glass) strandVehicle(v);
  const n = (vehicleShots.get(v.id) ?? 0) + 1;
  vehicleShots.set(v.id, n);
  if (vehicleShots.size > 200) vehicleShots.clear();
  if (n >= 12) {
    vehicleShots.delete(v.id);
    const pose = vehiclePose(sim, v, 1);
    if (pose) explodeAt(pose.p, sceneHeightAt(pose.p), null, 3);
  }
  return true;
}

/** The bulldozer's box being dragged (screen pixels in the canvas), or its press when it stays a click. */
let bulldozeBox: { pointer: number; a: Vec2; b: Vec2; world: Vec2; to: Vec2; anchor: Anchor } | null = null;
/** The bulldozer's click: the one thing under the pointer. */
function bulldozeClick(screen: Vec2, world: Vec2, anchor: Anchor): void {
  // A building stands over whatever is under it, so it is tried first.
  if (buildings.bulldozeAt(screen)) return;
  // A pole is a thing standing in the world, so the tool whose job is
  // removing things has to be able to remove it. It is tried first: a
  // pole stands ON the footway of a road, so the road under it would
  // otherwise always win the click and the pole could never be hit.
  {
    const pole = doc.poleNear(world, poleReach());
    if (pole) {
      mutate(() => {
        doc.removePole(pole.id);
        return true;
      });
      flashHint('hint.pole.removed');
      return;
    }
    // Likewise a bench, a tree or a street light on the footway.
    const item = landscapeNear(doc.landscape.values(), world, streetscapeReach());
    if (item) {
      mutate(() => doc.removeLandscape(item.id));
      flashHint('hint.streetscape.removed');
      return;
    }
  }
  if (anchor.kind === 'segment' && anchor.segment !== undefined) {
    const id = anchor.segment;
    mutate(() => {
      doc.removeSegment(id);
      doc.pruneOrphanNodes();
      return true;
    });
  }
}
/**
 * Everything inside the bulldozer's box removed in one undo step: roads
 * (their middle inside), buildings, lots, poles, trees and benches, walls.
 * The box is on the map, its corners the ground pressed and released, square
 * to the map's axes (the player, 2026-10-06: "o espaço do mapa e não 2D").
 */
function bulldozeBoxed(a: Vec2, b: Vec2): void {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const inside = (p: Vec2): boolean => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const segments = [...doc.segments.keys()].filter((id) => {
    const line = net.ribbons.get(id)?.full;
    return line ? inside(line.sampleAt(line.length / 2).p) : false;
  });
  const builtIds = [...doc.buildings.all()].filter((bd) => inside({ x: bd.x, y: bd.y })).map((bd) => bd.id);
  const lots = doc.lots.filter((l) => inside(lotCentre(l))).map((l) => l.id);
  const poles = [...doc.poles.values()].filter((p) => inside(p)).map((p) => p.id);
  const items = [...doc.landscape.values()].filter((it) => inside(it)).map((it) => it.id);
  const walls = [...doc.barriers.values()].filter((bar) => bar.points.some(inside)).map((bar) => bar.id);
  if (!segments.length && !builtIds.length && !lots.length && !poles.length && !items.length && !walls.length) return;
  mutate(() => {
    for (const id of segments) doc.removeSegment(id);
    if (segments.length) doc.pruneOrphanNodes();
    for (const id of lots) deleteLot(doc, id);
    for (const id of builtIds) doc.buildings.remove(id);
    for (const id of poles) doc.removePole(id);
    for (const id of items) doc.removeLandscape(id);
    for (const id of walls) doc.removeBarrier(id);
    return true;
  });
  flashHint('hint.lot.deleted');
}

/** Whether anything is being drawn or dragged right now. */
function gestureInProgress(): boolean {
  return draft !== null || roadChain !== null || curvePending !== null || poleDraft !== null ||
    poleChain !== null || terrainStroke !== null || moving !== null || zoneErase !== null ||
    lotPolygon.length > 0 || lotNew !== null || lotCorner !== null || lotCurve !== null || lotCutLine !== null ||
    lotStroke !== null || lotJoinFirst !== null || bulldozeBox !== null;
}

/**
 * A press whose release will never arrive - the window lost focus, the pointer
 * capture was taken - ends what the held button was doing. A terrain stroke
 * kept stamping every 110 ms after an alt-tab with the button down.
 */
function releaseHeld(): void {
  endTerrainStroke();
  cancelMove();
  panning = null;
  orbiting = null;
  pointers.clear();
  pinch = null;
}

/** Cancels a node drag without leaving its live preview in the document. */
function cancelMove(): void {
  if (!moving) return;
  const before = moving.before;
  moving = null;
  restoreSnapshot(doc, before, net);
  if (sim.topologyRevision !== net.trafficRevision) rebuildSimulationTopology();
}

/** Height of an authored connection; open ground takes the height being drawn at. */
function anchorHeightOffset(anchor: Anchor): number {
  return anchorHeightAt(doc, net, anchor, game.roadHeightOffset);
}

/** A nearby road at another height is a crossing, not an accidental junction. */
function anchorForHeight(anchor: Anchor, heightOffset: number): Anchor {
  return anchorAtHeight(doc, net, anchor, heightOffset);
}

/**
 * Spacing between dabs along a drag, as a fraction of the brush radius.
 *
 * It was 0.28 and the dabs read as a string of craters rather than as a stroke.
 * A fifth of the radius overlaps enough for the smoothstep falloffs to sum into
 * one smooth channel, which is what carving a river needs.
 */
const TERRAIN_SPACING = 0.2;
/** Floor on the interval between dabs, so a fast drag cannot outrun a rebuild. */
const TERRAIN_MIN_MS = 45;
/** How often a held, stationary brush reapplies itself. */
const TERRAIN_REPEAT_MS = 110;

/**
 * The cost-aware rate limit, the same argument as `movePreviewInterval`.
 *
 * Every dab moves `terrainRevision`, which re-solves the whole road elevation
 * field and re-triangulates every band laid on the ground. On a big network
 * that is far more than a frame, and dabbing on every pointer sample simply
 * queued rebuilds until the player let go — which is exactly what "the terrain
 * tool is uncomfortable" describes. Asking the last rebuild what it cost keeps
 * the brush live on an empty map and merely coarser on a full one.
 */
function terrainPaintInterval(): number {
  // During a stroke only the ground is rebuilt (see `DrawOptions.holdRoads`),
  // so it is the ground's own cost that paces the brush.
  const cost = terrainStroke ? scene.stats.terrainMs : scene.stats.rebuildMs;
  return Math.max(TERRAIN_MIN_MS, cost * 1.4);
}

/** One dab, with no spacing or rate checks of its own. */
function stampTerrain(at: Vec2, level: number): void {
  if (game.terrainMode === 'elements') {
    // Elements move no height: a dab lays instances (or takes them away).
    const mode = elementMode();
    if (mode !== 'lay') {
      doc.removeElements(at.x, at.y, game.terrainRadius, mode === 'eraseKind' ? elementKind() : null);
      return;
    }
    const kind = elementKind();
    const brush = elementBrush(kind);
    const reach = game.terrainRadius + brush.spacing * UNITS_PER_METER;
    const nearby = doc.elements.filter((e) => e.kind === kind && Math.abs(e.x - at.x) < reach && Math.abs(e.y - at.y) < reach);
    doc.addElements(scatter(kind, brush, at.x, at.y, game.terrainRadius, UNITS_PER_METER, Math.random, nearby));
    return;
  }
  if (game.terrainMode === 'trees') {
    // Trees move no height: a dab plants a stand (or one tree), or cuts the
    // trees away there - the woods' own too (`world/trees.ts`).
    const mode = treeMode();
    if (mode === 'cut') {
      doc.cutTrees(at.x, at.y, game.terrainRadius);
      return;
    }
    const brush = treeBrush();
    const reach = game.terrainRadius + brush.spacing * UNITS_PER_METER;
    const nearby = doc.trees.filter((t) => Math.abs(t.x - at.x) < reach && Math.abs(t.y - at.y) < reach);
    if (mode === 'one') {
      const spacing = brush.spacing * UNITS_PER_METER;
      if (nearby.every((t) => Math.hypot(t.x - at.x, t.y - at.y) >= spacing)) doc.plantTrees([oneTree(treeKind(), brush, at.x, at.y, UNITS_PER_METER, Math.random)]);
      return;
    }
    doc.plantTrees(plantTrees(treeKind(), brush, at.x, at.y, game.terrainRadius, UNITS_PER_METER, Math.random, nearby));
    return;
  }
  if (game.terrainMode === 'gully') {
    // Gullies move no height the roads read: the relief the light reads is
    // cut there (or wiped), `render/terrainRelief.ts`.
    const strength = Number((document.getElementById('gullyStrength') as HTMLInputElement | null)?.value ?? 60);
    doc.addGullyDab({
      x: at.x, y: at.y, radius: game.terrainRadius,
      strength: Math.max(0.05, Math.min(1, strength / 100)),
      ...(gullyErase() ? { erase: true } : {}),
    });
    return;
  }
  if (game.terrainMode === 'fog') {
    // Fog moves no height either: a dab of mist laid, or taken away.
    // The brush's own settings go with the dab.
    const brush = fogBrush();
    doc.addFogDab({
      x: at.x, y: at.y, radius: game.terrainRadius,
      strength: Math.max(0.02, Math.min(1, brush.strength / 100)),
      height: brush.height * UNITS_PER_METER,
      speed: brush.speed * UNITS_PER_METER,
      ...(fogErase() ? { erase: true } : {}),
    });
    return;
  }
  if (game.terrainMode === 'paint') {
    // Painting moves no height: a dab of the chosen ground, nothing re-solved.
    doc.addPaintDab({
      kind: paintKind(), x: at.x, y: at.y, radius: game.terrainRadius,
      strength: Math.max(0.05, Math.min(1, game.terrainStrength / 80)),
    });
    return;
  }
  const landform = landformOf(game.terrainMode);
  const mode: TerrainMode = landform ? landform.mode : game.terrainMode as TerrainMode;
  doc.addTerrainStamp({
    x: at.x,
    y: at.y,
    radius: game.terrainRadius,
    strength: game.terrainStrength,
    mode,
    ...(mode === 'flatten' ? { level } : {}),
    ...(terrainStroke && mode !== 'flatten' ? { stroke: terrainStroke.id } : {}),
    ...(mode === 'raise' || mode === 'lower' || mode === 'river' ? { rough: true } : {}),
    ...(game.terrainHardness > 0 && !landform?.profile && (mode === 'raise' || mode === 'lower') ? { hardness: game.terrainHardness / 100 } : {}),
    ...(landform?.profile ? { profile: landform.profile } : {}),
  });
  // The landform's rock, under the whole dab.
  // A little wider than the dab, so the rock reaches the foot of its cliff.
  if (landform) doc.addPaintDab({ kind: landform.rock, x: at.x, y: at.y, radius: game.terrainRadius * 1.15, strength: 1 });
}

/**
 * Paints from the last dab to `at`, laying dabs along the way.
 *
 * Interpolating is the other half of a stroke feeling like a stroke: a pointer
 * sample can jump a hundred units at speed, and dabbing only where the samples
 * landed left gaps a river ran straight through.
 */
function paintTerrain(at: Vec2, force = false): void {
  const stroke = terrainStroke;
  if (!stroke) {
    stampTerrain(at, sceneHeightAt(at));
    requestDraw();
    return;
  }

  stroke.at = at;
  const now = performance.now();
  if (!force) {
    if (now - stroke.applied < terrainPaintInterval()) return;
    const moved = Math.hypot(at.x - stroke.last.x, at.y - stroke.last.y);
    if (moved < game.terrainRadius * TERRAIN_SPACING) return;
  }

  const spacing = Math.max(4, game.terrainRadius * TERRAIN_SPACING);
  const dx = at.x - stroke.last.x;
  const dy = at.y - stroke.last.y;
  const distance = Math.hypot(dx, dy);
  // Bounded, because a pointer that re-enters the canvas from far away must not
  // lay two hundred dabs in one event.
  const steps = force ? 1 : Math.min(12, Math.max(1, Math.round(distance / spacing)));
  for (let i = 1; i <= steps; i++) {
    const t = steps === 1 && force ? 1 : i / steps;
    stampTerrain({ x: stroke.last.x + dx * t, y: stroke.last.y + dy * t }, stroke.level);
  }
  stroke.last = at;
  stroke.applied = now;
  requestDraw();
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
let cloudDrag: { pointer: number; id: number; dx: number; dy: number } | null = null;
/** Where the pointer's ray meets the plane at `height`, on the map. */
function pointerAtHeight(px: number, py: number, height: number): Vec2 {
  return view.toWorldAt(px, py, height, surface.cssW, surface.cssH);
}
function cloudPointerDown(pointer: number, px: number, py: number): void {
  const mode = cloudMode();
  const brush = cloudBrush();
  const size = brush.size * UNITS_PER_METER;
  const height = brush.height * UNITS_PER_METER;
  // Where the wind has carried them (`world/clouds.ts` driftedCloud): picked
  // where they are seen, and a new or moved one kept where it is put.
  const drift = scene.cloudDrift();
  const seen = doc.clouds.map((c) => ({ ...c, ...driftedCloud(c, drift) }));
  const picked = cloudUnder(seen, (h) => pointerAtHeight(px, py, h));
  const done = (): void => {
    updateHistoryButtons();
    persistence.saveSessionSoon(doc, sessionSettings);
    requestDraw();
  };
  if (mode === 'add') {
    const at = pointerAtHeight(px, py, height + size * 0.3);
    history.record(doc);
    const cloud = doc.addCloud({ x: at.x - drift.x, y: at.y - drift.y, height, size, density: brush.density / 100, yaw: ((at.x * 0.013 + at.y * 0.007) % 1) * Math.PI * 2 });
    if (!cloud) flashHint('hint.cloud.full');
    done();
    return;
  }
  if (!picked) return;
  history.record(doc);
  if (mode === 'remove') doc.removeCloud(picked.id);
  else if (mode === 'edit') doc.updateCloud(picked.id, { size, height, density: brush.density / 100 });
  else {
    const at = pointerAtHeight(px, py, picked.height + picked.size * 0.3);
    cloudDrag = { pointer, id: picked.id, dx: picked.x - at.x, dy: picked.y - at.y };
  }
  done();
}
function cloudDragTo(px: number, py: number): void {
  const drag = cloudDrag;
  const cloud = drag ? doc.clouds.find((c) => c.id === drag.id) : undefined;
  if (!drag || !cloud) return;
  const at = pointerAtHeight(px, py, cloud.height + cloud.size * 0.3);
  const drift = scene.cloudDrift();
  doc.updateCloud(cloud.id, { x: at.x + drag.dx - drift.x, y: at.y + drag.dy - drift.y });
  persistence.saveSessionSoon(doc, sessionSettings);
  requestDraw();
}
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

/** Starts a stroke, capturing the level target and arming the held repeat. */
function beginTerrainStroke(pointer: number, at: Vec2): void {
  history.record(doc);
  let id = 1;
  for (const stamp of doc.terrainStamps) if (stamp.stroke !== undefined && stamp.stroke >= id) id = stamp.stroke + 1;
  terrainStroke = { pointer, last: at, at, level: sceneHeightAt(at), applied: 0, id };
  paintTerrain(at, true);
  if (terrainRepeat !== null) clearInterval(terrainRepeat);
  terrainRepeat = null;
  // Only a flatten works on by being held: it levels a little further with
  // every dab. A raise, a lower or a river stroke moves the ground by its
  // strength and no more however long it is held (its dabs are one stroke),
  // so repeating them would only spend the map's dab budget.
  if (game.terrainMode === 'flatten') terrainRepeat = setInterval(() => {
    const stroke = terrainStroke;
    if (!stroke) return;
    if (performance.now() - stroke.applied < terrainPaintInterval()) return;
    stampTerrain(stroke.at, stroke.level);
    stroke.applied = performance.now();
    requestDraw();
  }, TERRAIN_REPEAT_MS);
  updateHistoryButtons();
}

function endTerrainStroke(): void {
  const wasPainting = terrainStroke !== null;
  terrainStroke = null;
  // Past the cap the oldest sculpting is dropped to make room. Say so before
  // it happens rather than erase the player's first hills in silence.
  if (wasPainting && doc.terrainStamps.length >= MAX_TERRAIN_STAMPS * 0.9) {
    flashHint(doc.terrainStamps.length >= MAX_TERRAIN_STAMPS ? 'hint.terrain.capReached' : 'hint.terrain.capNear');
  }
  // The roads were held for the stroke; this frame re-solves them.
  requestDraw();
  if (terrainRepeat !== null) {
    clearInterval(terrainRepeat);
    terrainRepeat = null;
  }
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
  pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });

  // A second finger promotes the gesture to pinch and cancels any draft. A
  // third finger is part of the pinch too: at size 3 it used to fall through to
  // the tool, and Bulldoze demolished the road under it.
  if (pointers.size >= 2) {
    cancelGestures();
    const [a, b] = [...pointers.values()] as [Vec2, Vec2];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y),
      zoom0: view.zoom,
      world: panAnchor(mid.x, mid.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
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
    orbiting = { id: e.pointerId, last: at, pressed: at, moved: false, cancelOnClick: gestureInProgress(), height: groundHeightUnder(at) };
    return;
  }

  if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) {
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    panning = { id: e.pointerId, grabbed: panAnchor(at.x, at.y) };
    return;
  }

  const world = pointerWorld(e);
  if (game.tool === 'road') roadPointerScreen = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (game.tool === 'road' && curvePending) {
    const pending = curvePending;
    curvePending = null;
    const curveDraft: RoadDraft = {
      start: pending.start,
      startHeightOffset: pending.startHeightOffset,
      chained: true,
      pressedAt: world,
      snap: {
        at: pending.end.at,
        guide: pending.end.kind === 'free' ? null : 'network',
        angleDeg: 0,
        length: dist(pending.start.at, pending.end.at),
      },
      samples: [{ at: pending.start.at, heightOffset: pending.startHeightOffset }],
      heightOffset: pending.endHeightOffset,
      curveControl: world,
    };
    commitRoadGesture(curveDraft, pending.end);
    requestDraw();
    return;
  }
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
      {
      const chained = roadChain !== null;
      let gridOffset = 0;
      if (roadGridShown()) {
        // The road fills whole cells: an odd number of them wide, its middle in a cell's middle.
        const cells = Math.max(1, Math.round((2 * halfWidth(roadProfile(game.roadTypeIndex, game.roadLanePreset), Level.Sidewalk)) / GRID_CELL));
        gridOffset = cells % 2 === 1 ? GRID_CELL / 2 : 0;
        setGridSnapStep(GRID_CELL, gridOffset);
      } else setGridSnapStep(GRID_STEP);
      let start = roadChain ?? snapRoadStart(anchor);
      // Drawn from a road with the grid on: from the grid point on that road,
      // not from wherever the press fell on it - the new road came out askew
      // and off the grid (the player, 2026-10-06).
      if (!roadChain && roadGridShown() && start.kind === 'segment' && start.segment !== undefined) {
        const line = net.polylines.get(doc, start.segment);
        const q = snapToGrid(start.at, GRID_CELL, gridOffset);
        let best: { at: Vec2; s: number; d: number } | null = null;
        for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
          const hit = line.closestPoint({ x: q.x + dx * GRID_CELL, y: q.y + dy * GRID_CELL });
          if (hit.distance < m(0.6) && (!best || Math.hypot(hit.point.x - start.at.x, hit.point.y - start.at.y) < best.d)) {
            best = { at: hit.point, s: hit.s, d: Math.hypot(hit.point.x - start.at.x, hit.point.y - start.at.y) };
          }
        }
        if (best) start = { ...start, at: best.at, s: best.s };
      }
      const startHeightOffset = chained
        ? roadChainHeight
        : start.kind === 'free' ? game.roadHeightOffset : anchorHeightOffset(start);
      if (!chained && start.kind !== 'free' && !roadHeightEdited) {
        gameState.set('roadHeightOffset', startHeightOffset, 'via começa num ponto existente');
      }
      roadHeightEdited = false;
      chainPreview = null;
      draftShift = { x: 0, y: 0 };
      draft = {
        start,
        startHeightOffset,
        chained,
        pressedAt: world,
        snap: snapRoadEndpoint(doc, net, start, world, view.zoom, game.roadHeightOffset),
        samples: [{ at: start.at, heightOffset: startHeightOffset }],
        heightOffset: game.roadHeightOffset,
      };
      break;
      }

    case 'terrain':
      if (game.terrainMode === 'cloud') cloudPointerDown(e.pointerId, e.clientX - r.left, e.clientY - r.top);
      // The weather tool: a click calls a lightning bolt down there.
      else if (game.terrainMode === 'weather') scene.strikeAt(world.x, world.y);
      else beginTerrainStroke(e.pointerId, world);
      break;

    case 'building':
      buildings.pointerDown({ x: e.clientX - r.left, y: e.clientY - r.top }, world, e.shiftKey);
      break;

    case 'zone': {
      const lot = lotAt(world);
      if (game.zoneMode === 'edit') {
        // The nearest corner within reach of the pointer.
        const reach = 14 / Math.max(0.05, view.zoom);
        let best: Vec2 | null = null, bestD = reach;
        for (const l of doc.lots) for (const q of l.corners) {
          const d = Math.hypot(q.x - world.x, q.y - world.y);
          if (d < bestD) { bestD = d; best = q; }
        }
        if (best) lotCorner = { pointer: e.pointerId, from: { ...best }, to: { ...world } };
      } else if (game.zoneMode === 'front') {
        // The side clicked becomes the lot's front, the side its building faces.
        const side = lotSideAt(world);
        if (!side) flashHint('hint.lot.frontPick');
        else {
          mutate(() => setLotFront(doc, side.lot.id, side.side));
          lotRefused.clear();
          flashHint('hint.lot.front');
        }
      } else if (game.zoneMode === 'split') {
        if (game.lotSplitKind === 'line') lotCutLine = { pointer: e.pointerId, a: { ...world }, b: { ...world } };
        else if (lot) {
          let ok = false;
          mutate(() => (ok = splitLot(doc, lot.id, { kind: game.lotSplitKind as 'vertical' | 'horizontal', parts: game.lotSplitParts })));
          flashHint(ok ? 'hint.lot.split' : 'hint.lot.splitFail');
        }
      } else if (game.zoneMode === 'polygon') {
        // A point a click; the first point again (or a double click) closes it.
        const p = lotSnap(world);
        const first = lotPolygon[0];
        const closing = first && lotPolygon.length >= 3 && (Math.hypot(p.x - first.x, p.y - first.y) < 12 / Math.max(0.05, view.zoom) || e.detail >= 2);
        if (closing) {
          const points = [...lotPolygon];
          lotPolygon = [];
          let made = false;
          const lot = landLot(points);
          mutate(() => (made = lot !== null && addPolygonLot(doc, lot.corners, lot.front) !== null));
          flashHint(made ? 'hint.lot.added' : 'hint.lot.addFail');
        } else lotPolygon.push(p);
      } else if (game.zoneMode === 'curve') {
        const side = lotSideNear(world);
        if (side) lotCurve = { pointer: e.pointerId, a: side.a, b: side.b, through: { ...world } };
      } else if (game.zoneMode === 'join') {
        if (lot && lotJoinFirst === null) { lotJoinFirst = lot.id; flashHint('hint.lot.joinPick'); }
        else if (lot && lotJoinFirst !== null && lot.id !== lotJoinFirst) {
          const first = lotJoinFirst;
          let ok = false;
          mutate(() => (ok = joinLots(doc, first, lot.id)));
          flashHint(ok ? 'hint.lot.join' : 'hint.lot.joinFail');
          lotJoinFirst = null;
        } else lotJoinFirst = null;
      } else if (game.zoneMode === 'add') {
        lotNew = { pointer: e.pointerId, a: lotSnap(world), b: lotSnap(world), angle: streetAngleNear(world) };
      } else if (game.zoneMode === 'delete') {
        // Lots, the buildings on them or anywhere under the stroke, and the zoned cells: all at once.
        zoneErase = { pointer: e.pointerId, lots: new Set(), buildings: new Set() };
        eraseUnder(world);
      } else {
        // The brush zones the lots it passes over; land with no lot is not zoned.
        lotStroke = { pointer: e.pointerId, remove: e.shiftKey || game.zoneEraser, ids: new Set(lot ? [lot.id] : []) };
      }
      requestDraw();
      break;
    }

    case 'transit':
      // Stops, tracks, stations, lines (`editor/transitTools.ts`).
      transitEditor.click(world, e.shiftKey, e.detail >= 2);
      break;

    case 'barrier': {
      // Shift-click removes a run; a click puts a point down, a double click
      // (or Enter) ends the run there.
      const hit = e.shiftKey ? doc.barrierNear(world, BARRIER_PICK_PIXELS / view.zoom) : null;
      if (hit) {
        mutate(() => doc.removeBarrier(hit.id));
        flashHint('hint.barrier.removed');
        break;
      }
      const point = snapBarrierPoint(net, game.barrierKind, world);
      barrierPoints = [...(barrierPoints ?? []), point];
      // A double click ends the run. Detected here by time and distance:
      // `detail` on a pointerdown is 0 in Chrome, so the run never ended and
      // the wall, fence or hedge was never built - only its path was drawn.
      const now = performance.now();
      const last = lastBarrierClick;
      lastBarrierClick = { t: now, x: e.clientX, y: e.clientY };
      if (e.detail >= 2 || (last && now - last.t < 450 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 10)) {
        lastBarrierClick = null;
        finishBarrier();
      }
      requestDraw();
      break;
    }

    case 'streetscape': {
      // Shift-click removes an item; a click places the chosen one on the
      // footway under the pointer, where `snapLandscape` puts it.
      if (e.shiftKey) {
        const hit = landscapeNear(doc.landscape.values(), world, streetscapeReach());
        if (hit) {
          mutate(() => doc.removeLandscape(hit.id));
          flashHint('hint.streetscape.removed');
        }
        break;
      }
      const kind = streetscapeKind();
      const placed = snapLandscape(net, doc.landscape.values(), kind, world, streetscapeReach());
      if (placed.ok) {
        mutate(() => {
          doc.addLandscape(kind, placed.at, kind === 'sign' ? { signType: signChoice.type, text: signChoice.text }
          : kind === 'streetname' ? { text: signChoice.streetName }
          : kind === 'tree' || kind === 'shrub' ? { planted: sim.city.minutes(sim) } : {});
          return true;
        });
      } else {
        flashHint(`hint.streetscape.${placed.reason}`);
      }
      streetscapeHover = null;
      requestDraw();
      break;
    }

    case 'pole':
      // Shift-click removes, the way the bulldoze tool does on a road.
      //
      // Removal used to be what a plain click on a pole did, which made the
      // commonest gesture in the tool - starting a run AT an existing pole -
      // impossible: the press that should have begun the run deleted the pole
      // it was aimed at. The radius is also the same one the snap uses, so
      // anything the preview highlights can be hit.
      {
        const hit = doc.poleNear(world, poleReach());
        if (poleToolMode() === 'remove') {
          // The Remove choice of the tool: a click takes the pole under it, and its wires.
          if (hit) {
            mutate(() => {
              doc.removePole(hit.id);
              return true;
            });
            flashHint('hint.pole.removed');
          }
          poleChain = null;
        } else if (hit && e.shiftKey) {
          mutate(() => {
            doc.removePole(hit.id);
            return true;
          });
          poleChain = null;
          flashHint('hint.pole.removed');
        } else {
          const start = poleChain ?? world;
          poleDraft = { from: start, to: world, chained: poleChain !== null };
        }
      }
      break;

    case 'move':
      if (anchor.kind === 'node' && anchor.node !== undefined) {
        const node = doc.node(anchor.node);
        if (node) moving = { node: anchor.node, origin: { x: node.x, y: node.y }, before: doc.toJSON() };
      } else {
        panning = { id: e.pointerId, grabbed: panAnchorOf(e) };
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
        void scene.effects().then(() => strikeAt(sx, sy, at));
        break;
      }
      if (strikeChoice.mode === 'shoot') {
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        void scene.effects().then(() => shootAt(sx, sy));
        break;
      }
      // A click removes what is under it; a drag draws a box and removes
      // everything inside it, as SimCity's bulldozer does (on release).
      bulldozeBox = { pointer: e.pointerId, a: { x: e.clientX - r.left, y: e.clientY - r.top }, b: { x: e.clientX - r.left, y: e.clientY - r.top }, world: { ...world }, to: { ...world }, anchor };
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
  if (pointers.has(e.pointerId)) releaseHeld();
});

canvas.addEventListener('pointermove', (e) => {
  // A mouse whose button is no longer down has ended its stroke, whether or
  // not the release reached us.
  if (e.pointerType === 'mouse' && e.buttons === 0 && terrainStroke) endTerrainStroke();
  const r = canvas.getBoundingClientRect();
  const screen: Vec2 = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (game.tool === 'road') roadPointerScreen = screen;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, screen);

  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()] as [Vec2, Vec2];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const limits = view.zoomBounds;
    const targetZoom = clamp((pinch.zoom0 * d) / Math.max(1, pinch.d0), limits.min, limits.max);
    // A twist of the two fingers turns the camera with them; the pan below
    // then keeps the ground between the fingers where it was.
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const twist = Math.atan2(Math.sin(angle - pinch.angle), Math.cos(angle - pinch.angle));
    pinch.angle = angle;
    if (d > 40) view.orbit(TWIST_SIGN * twist, 0);
    view.zoomAt(mid.x, mid.y, targetZoom / Math.max(0.001, view.zoom), surface.cssW, surface.cssH);
    view.panTo(pinch.world, mid.x, mid.y, surface.cssW, surface.cssH);
    requestDraw();
    return;
  }

  if (orbiting && orbiting.id === e.pointerId) {
    if (!orbiting.moved) {
      if (Math.hypot(screen.x - orbiting.pressed.x, screen.y - orbiting.pressed.y) < CLICK_SLOP) return;
      orbiting.moved = true;
    }
    const dx = screen.x - orbiting.last.x;
    const dy = screen.y - orbiting.last.y;
    orbiting.last = screen;
    // A turntable: the near side of the map follows the hand; dragging down
    // lifts the camera towards a plan view.
    view.orbit(dx * ORBIT_PER_PX, dy * ORBIT_PER_PX, { px: orbiting.pressed.x, py: orbiting.pressed.y, height: orbiting.height });
    persistence.saveSettingsSoon(sessionSettings);
    requestDraw();
    return;
  }

  if (panning && panning.id === e.pointerId) {
    if (panning.pressed && !panning.moved) {
      if (Math.hypot(screen.x - panning.pressed.x, screen.y - panning.pressed.y) < CLICK_SLOP) return;
      panning.moved = true;
    }
    view.panTo(panning.grabbed, screen.x, screen.y, surface.cssW, surface.cssH);
    requestDraw();
    return;
  }

  const world = pointerWorld(e, r);

  if (lotStroke?.pointer === e.pointerId) { const lot = lotAt(world); if (lot) lotStroke.ids.add(lot.id); requestDraw(); return; }
  if (bulldozeBox?.pointer === e.pointerId) {
    const r = canvas.getBoundingClientRect();
    bulldozeBox.b = { x: e.clientX - r.left, y: e.clientY - r.top };
    bulldozeBox.to = { ...world };
    requestDraw();
    return;
  }
  if (zoneErase?.pointer === e.pointerId) { eraseUnder(world); requestDraw(); return; }
  if (lotCorner?.pointer === e.pointerId) { lotCorner.to = lotSnapExcept(world, lotCorner.from); requestDraw(); return; }
  if (lotNew?.pointer === e.pointerId) { lotNew.b = lotSnap(world); requestDraw(); return; }
  if (lotCutLine?.pointer === e.pointerId) { lotCutLine.b = { ...world }; requestDraw(); return; }
  if (lotCurve?.pointer === e.pointerId) { lotCurve.through = { ...world }; requestDraw(); return; }
  if (game.tool === 'zone') {
    zoneHover = world;
    requestDraw();
  }

  if (game.tool === 'road' && curvePending) {
    curvePending.control = world;
    requestDraw();
    return;
  }

  if (game.tool === 'building') {
    buildings.pointerMove(screen, world, e.shiftKey);
    return;
  }

  if (draft) {
    const at = { x: world.x + draftShift.x, y: world.y + draftShift.y };
    draft.snap = snapRoadEndpoint(doc, net, draft.start, at, view.zoom, draft.heightOffset);
    if (draft.samples.length < 256) draft.samples.push({ at, heightOffset: draft.heightOffset });
    requestDraw();
    return;
  }

  if (game.tool === 'barrier') {
    barrierCursor = world;
    requestDraw();
  }
  if (game.tool === 'transit') {
    transitEditor.move(world);
    requestDraw();
  }

  if (poleDraft) {
    poleDraft.to = world;
    requestDraw();
    return;
  }

  if (game.tool === 'pole') {
    // The bare pointer, not a road anchor: the pole tool snaps to its own
    // line (`snapPole`), and a chained run has no button held, so the preview
    // has to follow the pointer or the next stretch is aimed blind.
    poleHover = world;
    requestDraw();
  }

  if (game.tool === 'streetscape') {
    streetscapeHover = snapLandscape(net, doc.landscape.values(), streetscapeKind(), world, streetscapeReach());
    requestDraw();
    return;
  }

  if (moving) {
    doc.moveNode(moving.node, world);
    requestDraw();
    return;
  }


  if (terrainStroke?.pointer === e.pointerId) {
    paintTerrain(world);
    return;
  }
  if (cloudDrag?.pointer === e.pointerId) {
    const rect = canvas.getBoundingClientRect();
    cloudDragTo(e.clientX - rect.left, e.clientY - rect.top);
    return;
  }

  // The hover preview uses the same height-aware connection rule as the commit.
  const hovered = findAnchor(doc, net, world, view.zoom, undefined,
    game.tool === 'road' ? game.roadHeightOffset : undefined);
  if (game.tool === 'road' && roadChain) {
    chainPreview = {
      start: roadChain,
      startHeightOffset: roadChainHeight,
      chained: true,
      pressedAt: world,
      snap: snapRoadEndpoint(doc, net, roadChain, world, view.zoom, game.roadHeightOffset),
      samples: [{ at: roadChain.at, heightOffset: roadChainHeight }],
      heightOffset: game.roadHeightOffset,
    };
  }
  hoverAnchor = game.tool === 'terrain'
    ? { kind: 'free', at: world }
    : game.tool === 'road'
      ? anchorForHeight(hovered, game.roadHeightOffset)
      : hovered;
  requestDraw();
});

/**
 * Pick radius for a pole, in WORLD units at the current zoom.
 *
 * One definition, used by the snap, by the preview, by removal and by
 * bulldoze. When these were separate numbers the preview highlighted a pole
 * the commit then missed, which is the "does not attach to an existing line"
 * complaint: the run looked joined and was built disconnected.
 */
function poleReach(): number {
  return POLE_PICK_PIXELS / view.zoom;
}

/** What the current gesture would build, snapped. Drawn and committed alike. */
let lastPoleMode = poleToolMode();
function currentPolePlan(): PoleRunPlan | null {
  // A change of the tool's verb ends the line being traced.
  if (poleToolMode() !== lastPoleMode) {
    lastPoleMode = poleToolMode();
    poleChain = null;
    poleDraft = null;
  }
  if (poleDraft) return planPoleRun(doc, net, poleDraft.from, poleDraft.to, poleReach(), undefined, poleLampMode());
  if (game.tool === 'pole' && poleToolMode() === 'build' && poleChain && poleHover) {
    return planPoleRun(doc, net, poleChain, poleHover, poleReach(), undefined, poleLampMode());
  }
  return null;
}

/** The segments there were before the road being committed (`commitRoadGesture`), for the grid's blink. */
let laidNow: ReadonlySet<SegmentId> = new Set();
/** The roads just laid blink (`SceneHandle.flashRoads`): the new road itself lights up and fades back. */
function flashLaidCells(before: ReadonlySet<SegmentId>): void {
  const laid = [...doc.segments.keys()].filter((id) => !before.has(id));
  if (laid.length) scene.flashRoads(laid);
}
/**
 * The road just committed, drawn as its preview was until the world with it
 * is built (a few frames, `SceneHandle.worldBusy`): the world is built in
 * slices and swapped whole, and the road used to appear only then, up to a
 * second after the click.
 */
let settlingRoad: RoadDraft | null = null;
function commitRoadGesture(d: RoadDraft, chosenEnd?: Anchor): boolean {
  const endAnchor = chosenEnd ?? anchorForHeight(
    findAnchor(doc, net, d.snap.at, view.zoom, undefined, d.heightOffset), d.heightOffset);
  const end: Anchor = endAnchor.kind === 'free' ? { kind: 'free', at: d.snap.at } : endAnchor;
  const endHeightOffset = end.kind === 'free' ? d.heightOffset : anchorHeightOffset(end);
  const pieces = piecesForDraft(d, endHeightOffset);
  let result: ReturnType<typeof commitRoadPath> = { committed: false };
  mutate(() => {
    const before = new Set(doc.segments.keys());
    laidNow = before;
    result = commitRoadPath(doc, net, d.start, end, game.roadTypeIndex, pieces, game.roadLanePreset, roadParking(),
      (x, y) => scene.naturalTerrainHeightAt(x, y));
    if (result.elevation) scene.offerElevation(result.elevation, net.revision);
    // Drawn as it was previewed until the new world is in place (`settlingRoad`).
    if (result.committed) settlingRoad = { ...d, snap: { ...d.snap, at: end.at } };
    // A chosen total width (Vias > Largura): the segments just laid take it.
    const roadWidthMetres = roadWidth();
    if (result.committed && roadWidthMetres !== null) {
      const rt = roadProfile(game.roadTypeIndex, game.roadLanePreset);
      const section = sectionForWidth(rt, roadWidthMetres, Math.round(rt.speedLimit * 3.6 * METERS_PER_UNIT));
      for (const id of doc.segments.keys()) if (!before.has(id)) doc.setSegmentSection(id, section);
    }
    return result.committed;
  });
  if (!result.committed) {
    flashHint(result.reason === 'clearance' ? 'hint.road.clearance' : 'hint.road.invalid');
    return false;
  }
  const finalHeight = result.finalHeightOffset ?? endHeightOffset;
  // Each completed placement ends the gesture. A new road begins only after
  // the player clicks a start again, including when that start is this node.
  roadChain = null;
  chainPreview = null;
  curvePending = null;
  roadChainHeight = finalHeight;
  gameState.set('roadHeightOffset', finalHeight, 'via terminada');
  roadHeightEdited = false;
  if (result.heightLimited) flashHint('hint.road.gradeLimited');
  flashLaidCells(laidNow);
  return true;
}

function endPointer(e: PointerEvent): void {
  const cancelled = e.type === 'pointercancel';
  const wasPinching = pinch !== null;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (panning?.id === e.pointerId) {
    const click = panning.cancelOnClick && !panning.moved;
    panning = null;
    if (click && !cancelled) {
      cancelGestures();
      return;
    }
  }
  if (orbiting?.id === e.pointerId) {
    const click = orbiting.cancelOnClick && !orbiting.moved;
    orbiting = null;
    if (click && !cancelled) {
      cancelGestures();
      return;
    }
  }
  if (terrainStroke?.pointer === e.pointerId) endTerrainStroke();
  if (cloudDrag?.pointer === e.pointerId) cloudDrag = null;
  if (game.tool === 'building') buildings.pointerUp(cancelled || wasPinching);
  if (bulldozeBox?.pointer === e.pointerId) {
    const box = bulldozeBox;
    bulldozeBox = null;
    if (!cancelled && !wasPinching) {
      if (Math.hypot(box.b.x - box.a.x, box.b.y - box.a.y) < 6) bulldozeClick(box.a, box.world, box.anchor);
      else bulldozeBoxed(box.world, box.to);
    }
    requestDraw();
  }
  if (lotStroke?.pointer === e.pointerId) {
    const stroke = lotStroke;
    lotStroke = null;
    if (!cancelled && !wasPinching && !stroke.ids.size) flashHint('hint.zone.empty');
    else if (!cancelled && !wasPinching) {
      mutate(() => zoneLots(doc, [...stroke.ids], stroke.remove ? null : { use: game.zoneUse, density: game.zoneDensity }));
      lotRefused.clear();
      flashHint(stroke.remove ? 'hint.zone.removed' : 'hint.zone.painted');
    }
    requestDraw();
  }
  if (lotCorner?.pointer === e.pointerId) {
    const drag = lotCorner;
    lotCorner = null;
    if (!cancelled && !wasPinching && Math.hypot(drag.to.x - drag.from.x, drag.to.y - drag.from.y) > m(0.3)) {
      mutate(() => moveLotCorner(doc, drag.from, drag.to));
      lotRefused.clear();
    }
    requestDraw();
  }
  if (lotCutLine?.pointer === e.pointerId) {
    const line = lotCutLine;
    lotCutLine = null;
    if (!cancelled && !wasPinching && Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) > m(2)) {
      // Every lot the line crosses is cut along it.
      const crossed = doc.lots.filter((l) => cutLines(l, { kind: 'line', a: line.a, b: line.b }).length &&
        l.corners.some((q) => (line.b.x - line.a.x) * (q.y - line.a.y) - (line.b.y - line.a.y) * (q.x - line.a.x) > 0) &&
        l.corners.some((q) => (line.b.x - line.a.x) * (q.y - line.a.y) - (line.b.y - line.a.y) * (q.x - line.a.x) < 0) &&
        segmentCrossesLot(line.a, line.b, l.corners));
      let ok = false;
      mutate(() => { for (const l of crossed) ok = splitLot(doc, l.id, { kind: 'line', a: line.a, b: line.b }) || ok; return ok; });
      flashHint(ok ? 'hint.lot.split' : 'hint.lot.splitFail');
    }
    requestDraw();
  }
  if (lotCurve?.pointer === e.pointerId) {
    const bend = lotCurve;
    lotCurve = null;
    if (!cancelled && !wasPinching) mutate(() => curveLotSide(doc, bend.a, bend.b, bend.through));
    requestDraw();
  }
  if (lotNew?.pointer === e.pointerId) {
    const drawn = lotNew;
    lotNew = null;
    if (!cancelled && !wasPinching) {
      let made = false;
      const rect = lotRect(drawn.a, drawn.b, drawn.angle);
      const lot = rect ? landLot(rect) : null;
      mutate(() => (made = lot !== null && addPolygonLot(doc, lot.corners, lot.front) !== null));
      flashHint(made ? 'hint.lot.added' : 'hint.lot.addFail');
    }
    requestDraw();
  }
  if (zoneErase?.pointer === e.pointerId) {
    const stroke = zoneErase;
    zoneErase = null;
    if (!cancelled && !wasPinching && (stroke.lots.size || stroke.buildings.size)) {
      mutate(() => {
        for (const id of stroke.lots) deleteLot(doc, id);
        for (const id of stroke.buildings) doc.buildings.remove(id);
        return true;
      });
      flashHint('hint.lot.deleted');
    }
    requestDraw();
  }
  if (draft) {
    const d = draft;
    draft = null;
    if (!cancelled && !wasPinching) {
      const traveled = d.samples.reduce((sum, sample, i) =>
        i === 0 ? 0 : sum + dist(sample.at, d.samples[i - 1]!.at), 0) +
        dist(d.samples[d.samples.length - 1]!.at, d.snap.at);
      const dragged = d.samples.slice(1).some((sample) =>
        dist(sample.at, d.pressedAt) > camera.px(7));
      // A click, by where the pointer itself went: with the snaps on, the
      // start and the snapped end both jump onto the grid, and a click read
      // as a short drag that laid nothing.
      const clicked = !dragged && dist(pointerWorld(e), d.pressedAt) < camera.px(7);
      if (!d.chained && (traveled < camera.px(7) || clicked)) {
        roadChain = d.start;
        roadChainHeight = d.startHeightOffset;
        requestDraw();
      } else if (d.chained && game.alignment === 'curve' && !dragged) {
        // A curve uses endpoint, then bend point. A drag still draws it at once.
        const anchor = anchorForHeight(
          findAnchor(doc, net, d.snap.at, view.zoom, undefined, d.heightOffset), d.heightOffset);
        const end = anchor.kind === 'free' ? { kind: 'free' as const, at: d.snap.at } : anchor;
        curvePending = {
          start: d.start,
          startHeightOffset: d.startHeightOffset,
          end,
          endHeightOffset: end.kind === 'free' ? d.heightOffset : anchorHeightOffset(end),
          control: { x: (d.start.at.x + end.at.x) / 2, y: (d.start.at.y + end.at.y) / 2 },
        };
        requestDraw();
      } else if (dist(d.start.at, d.snap.at) >= 1 || traveled >= 24) {
        commitRoadGesture(d);
      }
    }
  }

  if (poleDraft) {
    const run = poleDraft;
    const plan = planPoleRun(doc, net, run.from, run.to, poleReach(), undefined, poleLampMode());
    poleDraft = null;
    if (!cancelled && !wasPinching) {
      const last = plan.poles[plan.poles.length - 1];
      // A run with an end off the footways builds nothing, and says why.
      if (plan.refused) flashHint(`hint.pole.${plan.refused}`);
      const built = mutateBuilt(() => commitPoleRun(doc, plan));
      // The line goes on from where it ended. A press that built nothing -
      // a click in place - starts the chain instead, so tracing a line is
      // click, click, click rather than a drag per stretch.
      if (built && last) poleChain = { x: last.at.x, y: last.at.y };
      else if (!run.chained) poleChain = { x: plan.from.at.x, y: plan.from.at.y };
      else poleChain = null;
    } else {
      poleChain = null;
    }
  }

  if (moving) {
    const m = moving;
    moving = null;
    // Record the move as one undo step, using the position it started from.
    const node = doc.node(m.node);
    if (node) {
      const now = { x: node.x, y: node.y };
      const changed = Math.hypot(now.x - m.origin.x, now.y - m.origin.y) > COARSE_EPS;
      // Back to the document as it was - curves included - then, if the drag
      // counts, one move from there to the drop point as one undo step.
      restoreSnapshot(doc, m.before, net);
      if (changed && !cancelled && !wasPinching) {
        // The drop is reconciled like a drawn road: onto a node it joins it,
        // across a road it makes a junction, and a drop that would leave a
        // stub or cross a road at the wrong height is refused.
        let refused: DraftResult['reason'] | undefined;
        mutate(() => {
          doc.moveNode(m.node, now);
          const result = reconcileMovedNode(doc, net, m.node);
          if (result.committed) return true;
          refused = result.reason;
          restoreSnapshot(doc, m.before, net);
          return false;
        });
        if (refused) flashHint(refused === 'clearance' ? 'hint.move.clearance' : 'hint.move.tooShort');
      } else if (sim.topologyRevision !== net.trafficRevision) {
        rebuildSimulationTopology();
      }
    }
  }
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
  if (!meta && game.tool === 'barrier' && barrierPoints) {
    if (e.key === 'Enter') { e.preventDefault(); finishBarrier(); return; }
    if (e.key === 'Backspace') {
      e.preventDefault();
      barrierPoints.pop();
      if (barrierPoints.length === 0) barrierPoints = null;
      requestDraw();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); barrierPoints = null; requestDraw(); return; }
  }

  if (!meta && game.tool === 'road' && (e.key === 'PageUp' || e.key === 'PageDown')) {
    e.preventDefault();
    stepRoadHeight(e.key === 'PageUp' ? 1 : -1);
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
  if (next !== 'curve') curvePending = null;
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

function stepRoadHeight(metres: number): void {
  const before = game.roadHeightOffset;
  // Steps land on whole metres. A road cut short by the safe grade leaves the
  // height at a fraction (1.1 m), and stepping by a metre from there never
  // came back to the terrain's own level.
  const now = game.roadHeightOffset / UNITS_PER_METER;
  const next = metres > 0 ? Math.floor(now + 1e-6) + metres : Math.ceil(now - 1e-6) + metres;
  gameState.set('roadHeightOffset', next * UNITS_PER_METER, 'altura da via');
  roadHeightEdited = true;
  const underPointer = roadPointerScreen
    ? worldAtScreen(roadPointerScreen.x, roadPointerScreen.y, game.roadHeightOffset)
    : null;
  if (draft) {
    draft.heightOffset = game.roadHeightOffset;
    if (roadPointerScreen) {
      // The stroke goes on from where it is: the jump of the plane is carried.
      const was = worldAtScreen(roadPointerScreen.x, roadPointerScreen.y, before);
      draftShift = { x: draftShift.x + was.x - underPointer!.x, y: draftShift.y + was.y - underPointer!.y };
    }
    const at = underPointer ? { x: underPointer.x + draftShift.x, y: underPointer.y + draftShift.y } : draft.snap.at;
    draft.snap = snapRoadEndpoint(doc, net, draft.start, at, view.zoom, game.roadHeightOffset);
    draft.samples.push({ at, heightOffset: game.roadHeightOffset });
  }
  if (roadChain && !draft && !curvePending) {
    const at = underPointer ?? chainPreview?.snap.at ?? roadChain.at;
    chainPreview = {
      start: roadChain,
      startHeightOffset: roadChainHeight,
      chained: true,
      pressedAt: at,
      snap: snapRoadEndpoint(doc, net, roadChain, at, view.zoom, game.roadHeightOffset),
      samples: [{ at: roadChain.at, heightOffset: roadChainHeight }],
      heightOffset: game.roadHeightOffset,
    };
  }
  if (curvePending) {
    curvePending.end = anchorForHeight(curvePending.end, game.roadHeightOffset);
    curvePending.endHeightOffset = game.roadHeightOffset;
  }
  requestDraw();
}

document.querySelectorAll<HTMLButtonElement>('.road-height-step').forEach((button) => {
  button.onclick = () => stepRoadHeight(Number(button.dataset['heightStep']));
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
    lotJoinFirst = null;
    lotPolygon = [];
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
  if (UI_V2) mountShell({ workspace: buildings.workspace });
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
  last = performance.now();
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
    explode: (at, z, strength) => explodeAt(at, z, null, strength),
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
  lotRefused.clear();
  lotRefusedNet = net.revision;
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
  setTimeout(() => {
    for (let guard = 0; guard < growing.total * 3 + 50; guard++) {
      const id = growOnLot({ doc, net, groundAt: (x, y) => scene.terrainHeightAt(x, y) }, lotRefused, 0x5eed);
      if (id === null) {
        // A lot refused (nothing fits it) is set aside; done when none is left open.
        const open = doc.lots.some((l) => l.use && (l.building === undefined || !doc.buildings.has(l.building as BuildingId)) && !lotRefused.has(l.id));
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
  }, 30);
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
  gameState.set('roadHeightOffset', 0, 'mapa novo');
  roadHeightEdited = false;
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
let last = performance.now();
let pending = false;
// Seeded ABOVE their thresholds so the first frame refreshes both. The loop
// stops once nothing is moving — a paused map with no traffic ends it after one
// or two frames — and the status bar and minimap are only refreshed from inside
// that loop. Starting at zero meant a paused map kept the initial HTML readout
// for ever: measured on an all-combinations test map of 32 roads and 47 nodes,
// the status bar read "0 roads · 0 nodes" while the roads were plainly drawn,
// the minimap stayed blank.
let uiClock = 0.4;
let minimapClock = 0.1;
let lastMovePreviewRebuild = -Infinity;
/**
 * Shortest interval between geometry rebuilds while a node is being dragged.
 *
 * A preview at 20 Hz is far smoother than the eye needs for a drag, and it
 * avoids rebuilding routes, signals and spatial indexes for pointer samples that
 * will be superseded immediately.
 */
const MOVE_PREVIEW_MIN_MS = 50;
/**
 * The cap is a floor, not the whole rule: on a large network one rebuild costs
 * far more than 50 ms, and asking for another one every 50 ms simply queues
 * them until the pointer stops. The interval is therefore taken from what the
 * last rebuild ACTUALLY cost, so the preview stays responsive on a small map
 * and degrades to a slower preview on a big one instead of locking up.
 */
function movePreviewInterval(): number {
  return Math.max(MOVE_PREVIEW_MIN_MS, scene.stats.rebuildMs * 1.6);
}

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
/** The conflict zones of an edit being measured ahead of the swap (`SimWorld.prepareVehicleTopology`). */
let topologyPrep: { revision: number; steps: Generator<void, void> } | null = null;
/** Milliseconds a frame spends measuring them. */
const TOPOLOGY_SLICE_MS = 6;

function requestDraw(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(frame);
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
  if (lotRefusedNet !== net.revision) { lotRefused.clear(); lotRefusedNet = net.revision; }
  if (!moving && performance.now() >= zoneGrowthHold && doc.lots.some((l) => l.use)) {
    const grown = growOnLot({ doc, net, groundAt: (x, y) => scene.terrainHeightAt(x, y) }, lotRefused, 0x5eed);
    if (grown !== null) {
      const fresh = doc.buildings.get(grown as BuildingId);
      if (fresh) doc.buildings.put({ ...fresh, builtAt: sim.city.minutes(sim), decay: 0, lotPlan: LOT_PLAN_VERSION });
      persistence.saveSessionSoon(doc, sessionSettings);
      updateStatus();
      requestDraw();
    }
  }
}, 500);

/** The footways were rebuilt (`rebuildWalkTopology`) and the walkers are rebound onto them next frame. */
let pedsToRebind = false;
/** The footways of the last edit being rebuilt, a few milliseconds a frame (`SimWorld.walkTopologySteps`). */
let walkPrep: { revision: number; steps: Generator<void, void, void> } | null = null;

/** A frame has been drawn, and the first world has been put in place (the opening builds it in parts). */
let drawnOnce = false;
let worldShown = false;
function frame(now: number): void {
  pending = false;
  if (!booted) return;
  // Each system's time in this frame (`core/health.ts`): a long frame is told with the systems that took it.
  frameTimer.begin();
  beginFrameWork();
  // Everyone watching the game's state is told what changed, once, here.
  gameState.flush();
  // The map's biome shown as it is after an undo, a load or a new map.
  if (doc.natureRevision !== mapBiomeShown) syncMapBiome();
  frameTimer.mark('painéis');
  const wall = (now - last) / 1000;
  last = now;

  // The opening puts the town together in parts (`SceneHandle.worldBusy`):
  // the traffic waits for the roads it drives on to be drawn.
  if (!worldShown && drawnOnce && !scene.worldBusy) worldShown = true;
  // Moving a node is an authoring preview. Freeze simulation time until the
  // gesture finishes so agents never rebuild against every intermediate shape.
  // The frame that first draws an edit is held the same way.
  let holdSim = moving || topologyAfterDraw || !worldShown;
  // A generated city being built (`generateCity`).
  growCity();
  if (!holdSim && sim.topologyRevision !== net.trafficRevision && scene.worldBusy) {
    // The road being built first: the traffic and the footways wait for it,
    // the simulation held meanwhile, so the frame's allowance goes to the road.
    holdSim = true;
    requestDraw();
  } else if (!holdSim && sim.topologyRevision !== net.trafficRevision) {
    // In two frames, vehicles then footways, each drawn in between: the two
    // together were one stall of up to 240 ms after every edit. The world is
    // held until both are done.
    if (sim.vehicleTopologyRevision !== net.trafficRevision) {
      // The conflict zones of the new junctions measured first, a few
      // milliseconds a frame on a graph of their own (`prepareVehicleTopology`);
      // then the swap, which finds every pair measured.
      if (!topologyPrep || topologyPrep.revision !== net.trafficRevision) {
        topologyPrep = { revision: net.trafficRevision, steps: sim.prepareVehicleTopology() };
      }
      const until = workUntil(TOPOLOGY_SLICE_MS) || performance.now() + 1;
      let prep = topologyPrep.steps.next();
      while (!prep.done && performance.now() < until) prep = topologyPrep.steps.next();
      if (prep.done) {
        topologyPrep = null;
        sim.rebuildVehicleTopology();
        rebindVehicles(sim);
      }
      holdSim = true;
      requestDraw();
    } else {
      // The footways now, the walkers rebound onto them in the next frame,
      // the world held until then: the two in one frame were a stall of
      // 130-180 ms after every road in the default town (docs/performance.md #11).
      if (!walkPrep || walkPrep.revision !== net.trafficRevision) {
        walkPrep = { revision: net.trafficRevision, steps: sim.walkTopologySteps() };
      }
      const until = workUntil(TOPOLOGY_SLICE_MS) || performance.now() + 1;
      let step = walkPrep.steps.next();
      while (!step.done && performance.now() < until) step = walkPrep.steps.next();
      if (step.done) {
        walkPrep = null;
        pedsToRebind = true;
      }
      holdSim = true;
      requestDraw();
    }
  } else if (!holdSim && pedsToRebind) {
    pedsToRebind = false;
    rebindPeds(sim);
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
    if (!moving || now - lastMovePreviewRebuild >= movePreviewInterval()) {
      net.rebuild();
      if (moving) lastMovePreviewRebuild = now;
      else if (sim.topologyRevision !== net.trafficRevision) rebuildSimulationTopology();
    }
  }
  frameTimer.mark('rede viária');
  buildings.beforeDraw(game.tool === 'building');
  frameTimer.mark('prédios');
  // The pole run under the pointer, planned once per frame: the 3D preview
  // shows it as it will stand, the overlay marks only what cannot be built.
  framePolePlan = currentPolePlan();
  scene.setPolePreview(net, framePolePlan && !framePolePlan.refused && framePolePlan.poles.length >= 2
    ? { poles: framePolePlan.poles.map((pole) => ({ x: pole.at.x, y: pole.at.y, lamp: pole.lamp, standing: pole.existing !== null })) }
    : null);
  frameTimer.mark('postes');
  scene.draw(net, sim, alpha, wall, { holdRoads: terrainStroke !== null });
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
  minimapClock += wall;
  if (minimapClock >= 0.1) {
    minimapClock = 0;
    syncFlatCameraFromView();
    drawMinimap(minimapCanvas, doc, net, sim, camera, surface, viewFootprint());
  }
  frameTimer.mark('minimapa');

  uiClock += wall;
  if (uiClock > 0.4) {
    uiClock = 0;
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
  if (!document.hidden && (!game.paused || draft || moving || panning || orbiting || pinch || scene.busy())) requestDraw();
  else if (!document.hidden && scene.drifting() && !driftQueued) {
    // Only the clouds moving (they drift, form and fade): twenty frames a
    // second keeps them alive without holding the GPU at full speed.
    driftQueued = true;
    setTimeout(() => { driftQueued = false; requestDraw(); }, 50);
  }
}
/** A frame for the drifting clouds is already on its way. */
let driftQueued = false;

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

/** The run being traced, with the pointer's point added: what would be built. */
function barrierPlan(): Vec2[] {
  const points = [...(barrierPoints ?? [])];
  if (barrierPoints && barrierCursor) points.push(snapBarrierPoint(net, game.barrierKind, barrierCursor));
  return points;
}

/** Builds the run traced so far, in one undo step, or says why it cannot be. */
function finishBarrier(): void {
  const points = barrierPoints ?? [];
  barrierPoints = null;
  // A double click lands two points on one spot: one of them is enough.
  const path = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1]!.x, p.y - points[i - 1]!.y) > 1e-3);
  if (path.length < 2) { requestDraw(); return; }
  const problem = barrierProblem(net, game.barrierKind, path);
  if (problem) {
    flashHint(`hint.barrier.${problem}`);
    requestDraw();
    return;
  }
  mutate(() => doc.addBarrier(game.barrierKind, path) !== null);
  flashHint('hint.barrier.built');
}

/** The run being traced, as it will stand: red where it cannot be built. */
function drawBarrierPlan(ctx: CanvasRenderingContext2D, at: (p: Vec2) => Vec2): void {
  const points = barrierPlan();
  const cursor = barrierCursor ? snapBarrierPoint(net, game.barrierKind, barrierCursor) : null;
  ctx.save();
  if (points.length >= 2) {
    const bad = barrierProblem(net, game.barrierKind, points) === 'road';
    ctx.strokeStyle = bad ? '#ff6f63' : SELECTION;
    ctx.lineWidth = game.barrierKind === 'hedge' ? 5 : game.barrierKind === 'wall' ? 4 : 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => { const s = at(p); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
    ctx.stroke();
  }
  ctx.fillStyle = SELECTION;
  for (const p of [...(barrierPoints ?? []), ...(cursor ? [cursor] : [])]) {
    const s = at(p);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Where the landscaping tool would put its item: a ring on the footway, red where it cannot go. */
function drawStreetscapeHover(ctx: CanvasRenderingContext2D, at: (p: Vec2) => Vec2): void {
  const hover = streetscapeHover;
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
  // Removing: the pole under the pointer, in red.
  if (game.tool === 'pole' && poleToolMode() === 'remove') {
    const hit = poleHover ? doc.poleNear(poleHover, poleReach()) : null;
    if (hit) ring(at(hit), '#e5534b', 10);
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
  if (game.tool === 'pole' && poleHover && !poleDraft) {
    const snap = snapPole(doc, net, poleHover, poleReach());
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
    const colours: Record<ZoneUse, number> = { residential: 0x56bb73, commercial: 0x5da9e9, industrial: 0xd9b254 };
    const hoverLot = game.tool === 'zone' && zoneHover ? lotAt(zoneHover) : undefined;
    const dragged = (q: Vec2): Vec2 => lotCorner && Math.hypot(q.x - lotCorner.from.x, q.y - lotCorner.from.y) < m(0.8) ? lotCorner.to : q;
    const polygons: LotOverlayInput['polygons'][number][] = [];
    const lines: LotOverlayInput['lines'][number][] = [];
    const points: LotOverlayInput['points'][number][] = [];
    const editing = game.tool === 'zone';
    for (const l of doc.lots) {
      const built = l.building !== undefined && doc.buildings.has(l.building as BuildingId);
      if (!editing && (!l.use || built)) continue;
      const painting = lotStroke?.ids.has(l.id);
      const brushHover = l === hoverLot && game.zoneMode === 'brush';
      const picked = editing && (l.id === lotJoinFirst || (l === hoverLot && !brushHover && game.zoneMode !== 'edit'));
      const fill = painting ? (lotStroke!.remove ? 0xe36c60 : colours[game.zoneUse]) : l.use ? colours[l.use] : brushHover ? (game.zoneEraser ? 0xe36c60 : colours[game.zoneUse]) : null;
      const fillAlpha = painting ? 0.6 : l.use ? (editing ? (built ? 0.22 : 0.45) : 0.25) : brushHover ? 0.35 : 0;
      polygons.push({ corners: l.corners.map(dragged), fill, fillAlpha,
        line: picked ? (game.zoneMode === 'delete' ? 0xff6b5e : 0xffd25e) : 0xffffff, lineAlpha: editing ? (picked ? 1 : 0.85) : 0,
        width: picked ? 0.7 : 0.35 });
    }
    if (editing && game.zoneMode === 'edit') for (const l of doc.lots) for (const q of l.corners) points.push({ p: dragged(q), colour: 0xffffff, radius: 0.6 });
    // Each lot's front, the side its building faces: marked in the Zoning tool.
    if (editing) for (const l of doc.lots) if (l.corners.length > 1) {
      const a = dragged(l.corners[0]!), b = dragged(l.corners[1]!);
      lines.push({ a, b, colour: 0x5ee0ff, dashed: false, width: 0.8 });
      // An arrow from inside the lot out through the middle of its front, towards the street.
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < m(2)) continue;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const centre = lotCentre(l);
      let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      if ((mid.x - centre.x) * nx + (mid.y - centre.y) * ny < 0) { nx = -nx; ny = -ny; }
      const size = Math.min(m(7), len * 0.35, Math.max(m(2), Math.hypot(mid.x - centre.x, mid.y - centre.y) * 0.6));
      const tail = { x: mid.x - nx * size, y: mid.y - ny * size };
      const tip = { x: mid.x - nx * size * 0.15, y: mid.y - ny * size * 0.15 };
      const head = size * 0.4, tx = -ny, ty = nx;
      lines.push({ a: tail, b: tip, colour: 0x5ee0ff, dashed: false, width: 1 });
      lines.push({ a: tip, b: { x: tip.x - nx * head + tx * head * 0.7, y: tip.y - ny * head + ty * head * 0.7 }, colour: 0x5ee0ff, dashed: false, width: 1 });
      lines.push({ a: tip, b: { x: tip.x - nx * head - tx * head * 0.7, y: tip.y - ny * head - ty * head * 0.7 }, colour: 0x5ee0ff, dashed: false, width: 1 });
    }
    if (editing && game.zoneMode === 'front' && zoneHover) {
      const side = lotSideAt(zoneHover);
      if (side) lines.push({ a: side.a, b: side.b, colour: 0xffd25e, dashed: false, width: 1 });
    }
    if (editing && game.zoneMode === 'split' && game.lotSplitKind !== 'line' && hoverLot) {
      for (const [a, b] of cutLines(hoverLot, { kind: game.lotSplitKind, parts: game.lotSplitParts })) lines.push({ a, b, colour: 0xffd25e, dashed: true, width: 0.5 });
    }
    if (lotCutLine) lines.push({ a: lotCutLine.a, b: lotCutLine.b, colour: 0xffd25e, dashed: true, width: 0.5 });
    if (lotCurve) {
      const { a, b, through } = lotCurve;
      const c = { x: 2 * through.x - (a.x + b.x) / 2, y: 2 * through.y - (a.y + b.y) / 2 };
      let prev = a;
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, s1 = 1 - t;
        const q = { x: s1 * s1 * a.x + 2 * s1 * t * c.x + t * t * b.x, y: s1 * s1 * a.y + 2 * s1 * t * c.y + t * t * b.y };
        lines.push({ a: prev, b: q, colour: 0xffd25e, dashed: false, width: 0.6 });
        prev = q;
      }
    }
    if (editing && game.zoneMode === 'curve' && !lotCurve && zoneHover) {
      const side = lotSideNear(zoneHover);
      if (side) lines.push({ a: side.a, b: side.b, colour: 0xffd25e, dashed: false, width: 0.7 });
    }
    if (lotPolygon.length) {
      const pts = [...lotPolygon, ...(zoneHover ? [lotSnap(zoneHover)] : [])];
      for (let i = 1; i < pts.length; i++) lines.push({ a: pts[i - 1]!, b: pts[i]!, colour: 0xffffff, dashed: false, width: 0.5 });
      for (const q of lotPolygon) points.push({ p: q, colour: 0xffffff, radius: 0.6 });
    }
    if (editing && (game.zoneMode === 'polygon' || game.zoneMode === 'add' || lotCorner) && zoneHover) {
      points.push({ p: lotCorner ? lotCorner.to : lotSnap(zoneHover), colour: 0x5ee0ff, radius: 0.9 });
    }
    if (lotNew) {
      // As it will be made: cut back to the footways.
      const rect = lotRect(lotNew.a, lotNew.b, lotNew.angle);
      const cut = rect ? onLand(net, rect) : null;
      if (cut) polygons.push({ corners: cut, fill: 0xffffff, fillAlpha: 0.2, line: 0xffffff, lineAlpha: 1, width: 0.5 });
    }
    const key = JSON.stringify([polygons, lines, points]);
    scene.setLotOverlay({ key, polygons, lines, points });
    // Labels stay on the 2D layer, projected at the ground's real height.
    const ground = (p: Vec2): Vec2 => view.toScreen(p, w, h, scene.surfaceHeightAt(p.x, p.y));
    ctx.save();
    if (editing && hoverLot && !lotPolygon.length) {
      const f = lotFrame(hoverLot), c = ground(lotCentre(hoverLot));
      const label = t('zone.lot.size', { w: Math.round(f.width * METERS_PER_UNIT), d: Math.round(f.depth * METERS_PER_UNIT) });
      ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = '#0b1416cc'; ctx.strokeText(label, c.x, c.y);
      ctx.fillStyle = '#ffffff'; ctx.fillText(label, c.x, c.y);
    }
    if (lotPolygon.length && zoneHover) {
      const a = lotPolygon[lotPolygon.length - 1]!, b = lotSnap(zoneHover);
      const sm = ground({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const label = `${Math.round(Math.hypot(b.x - a.x, b.y - a.y) * METERS_PER_UNIT)} m`;
      ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = '#0b1416cc';
      ctx.strokeText(label, sm.x, sm.y - 10); ctx.fillStyle = '#ffffff'; ctx.fillText(label, sm.x, sm.y - 10);
    }
    ctx.restore();
  } else scene.setLotOverlay(null);

  if (game.tool === 'building') buildings.drawOverlay(ctx);
  // The bulldozer's box, on the ground: its edges follow the land.
  if (bulldozeBox && Math.hypot(bulldozeBox.b.x - bulldozeBox.a.x, bulldozeBox.b.y - bulldozeBox.a.y) >= 6) {
    const { world: a, to: b } = bulldozeBox;
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
  if (game.tool === 'road' && !draft && hoverAnchor?.kind === 'node') {
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
    const brush = terrainStroke ? terrainStroke.at : hoverAnchor.at;
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

    const height = terrainStroke ? terrainStroke.level : sceneHeightAt(brush);
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
  if (settlingRoad && !scene.worldBusy && !topologyAfterDraw) settlingRoad = null;
  const settling = !curvePending && !draft && !chainPreview && settlingRoad !== null;
  const roadPreview: RoadDraft | null = curvePending
    ? {
      start: curvePending.start,
      startHeightOffset: curvePending.startHeightOffset,
      chained: true,
      pressedAt: curvePending.control,
      snap: { at: curvePending.end.at, guide: null, angleDeg: 0,
        length: dist(curvePending.start.at, curvePending.end.at) },
      samples: [{ at: curvePending.start.at, heightOffset: curvePending.startHeightOffset }],
      heightOffset: curvePending.endHeightOffset,
      curveControl: curvePending.control,
    }
    : draft ?? chainPreview ?? settlingRoad;
  if (roadPreview) {
    // The profile the road will be laid with: its lanes and its parking.
    const chosenWidth = roadWidth();
    const plainRt = roadProfile(game.roadTypeIndex, game.roadLanePreset);
    const rt = roadProfile(game.roadTypeIndex, game.roadLanePreset,
      roadType(game.roadTypeIndex).lanes === 1 ? 'aToB' : 'both',
      chosenWidth === null ? undefined : sectionForWidth(plainRt, chosenWidth, Math.round(plainRt.speedLimit * 3.6 * METERS_PER_UNIT)),
      roadParking());
    const pieces = piecesForDraft(roadPreview);
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

function curveFromGesture(value: RoadDraft): CurveShape | null {
  const a = value.start.at;
  const b = value.snap.at;
  if (value.curveControl) {
    return fitRoadCurve(a, b, shapeFromControl(a, b, value.curveControl), game.roadTypeIndex);
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1) return null;
  const nx = -dy / chord;
  const ny = dx / chord;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  let side = 0;
  for (const sample of value.samples) {
    const p = sample.at;
    const candidate = (p.x - mid.x) * nx + (p.y - mid.y) * ny;
    if (Math.abs(candidate) > Math.abs(side)) side = candidate;
  }
  side = clamp(side, -chord * 0.52, chord * 0.52);
  if (Math.abs(side) < camera.px(6)) return null;
  return fitRoadCurve(a, b, shapeFromControl(a, b,
    { x: mid.x + nx * side * 1.36, y: mid.y + ny * side * 1.36 }), game.roadTypeIndex);
}

function piecesForDraft(value: RoadDraft, endHeightOffset = value.heightOffset): RoadPathPiece[] {
  const start = { at: value.start.at, heightOffset: value.startHeightOffset };
  const end = { at: value.snap.at, heightOffset: endHeightOffset };
  if (game.alignment === 'free') return roadPathFromGesture(value.samples, start, end).map((piece) => ({
    ...piece,
    curve: fitRoadCurve(piece.start.at, piece.end.at, piece.curve, game.roadTypeIndex),
  }));
  if (Math.hypot(start.at.x - end.at.x, start.at.y - end.at.y) < 1e-6) return [];
  return [{ start, end, curve: game.alignment === 'curve' ? curveFromGesture(value) : null }];
}

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
    last = performance.now();
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
    gameState.set('roadHeightOffset', metres * UNITS_PER_METER, 'altura pedida pelo console');
    roadHeightEdited = true;
    requestDraw();
  },
  /** A generated city (`editor/cityGenerator.ts`), and how far its building has gone. */
  generateCity: (options: Partial<CityOptions> = {}) => generateCity({ ...DEFAULT_CITY, ...options }),
  /** Probe: one building grown on a zoned lot, and what it cost (ms). */
  growTimed: () => { const t = performance.now(); const id = growOnLot({ doc, net, groundAt: (x, y) => scene.terrainHeightAt(x, y) }, lotRefused, 0x5eed); return { id, ms: performance.now() - t }; },
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
    if (decay !== (b.decay ?? 0)) { doc.buildings.put({ ...b, decay }); changed = true; }
  }
  if (changed) requestDraw();
}, 3000);

/**
 * The demolish tool's Strike mode (the player's order of 2026-10-05): a blow
 * of the chosen force where the pointer is. A building breaks a piece at a
 * time and comes down when little is left; a street gets a crater. Anybody
 * close enough dies, anybody near runs away.
 */
function strikeAt(sx: number, sy: number, world: Vec2): void {
  // `world` is moved onto the building below.
  const strength = strikeChoice.strength;
  // A building already broken is no longer drawn as itself, so the pick by
  // its meshes misses it: found by its footprint under the pointer instead.
  const id = buildings.tool.buildingAt({ x: sx, y: sy });
  const b = id !== null ? doc.buildings.get(id as BuildingId)
    : [...doc.buildings.all()].find((c) => rayOnBuilding(c, sx, sy, sceneHeightAt({ x: c.x, y: c.y })) !== null);
  // Where the blow lands: the first point of the building along the pointer's
  // ray (its roof or the face under the pointer); else the ground.
  let target = world, z = sceneHeightAt(world);
  if (b) {
    const hit = rayOnBuilding(b, sx, sy, z);
    if (hit) { target = hit; z = hit.z; }
  }
  explodeAt(target, z, b ?? null, strength);
}

/**
 * An explosion at `world`, height `z` (on building `b` when it landed on one):
 * the strike tool's blow, and the blasts of a city on fire (`fireTick`).
 */
function explodeAt(world: Vec2, z: number, b: Building | null, strength: number, quiet = false): void {
  // An explosion (the player's order of 2026-10-05): it wrecks everything
  // within its reach, not only what it lands on - buildings, people, cars,
  // poles and their wires, traffic lights, street things, the road itself.
  const radius = m(2.5 + strength * 1.1);
  const kill = radius * 0.5, scare = m(70 + strength * 10);
  const dead = sim.pedEngine.impact?.(sim, world.x, world.y, kill, scare) ?? 0;
  const near = (x: number, y: number, reach: number): boolean => Math.hypot(x - world.x, y - world.y) < reach;
  const paved = Number.isFinite(scene.pavedHeightAt(world.x, world.y));
  const ground: BlastHit['ground'] = b && z > sceneHeightAt(world) + m(0.5) ? 'building' : paved ? 'road' : 'earth';
  const hit: { ground: BlastHit['ground']; crater: boolean; poles: BlastHit['poles'][number][]; wires: BlastHit['wires'][number][];
    posts: BlastHit['posts'][number][]; vehicles: BlastHit['vehicles'][number][]; items: BlastHit['items'][number][] } =
    { ground, crater: ground !== 'building', poles: [], wires: [], posts: [], vehicles: [], items: [] };
  let downs = 0;
  mutate(() => {
    let changed = false;
    // Buildings: each struck at its nearest point, harder the nearer.
    for (const c of [...doc.buildings.all()]) {
      let best = Infinity, px = world.x, py = world.y;
      for (const ring of solidFootprints(c)) {
        if (pointInPolygon(world, ring)) { best = 0; break; }
        for (let i = 0; i < ring.length; i++) {
          const q = closestOnSegment(world, ring[i]!, ring[(i + 1) % ring.length]!).point;
          const d = Math.hypot(q.x - world.x, q.y - world.y);
          if (d < best) { best = d; px = q.x; py = q.y; }
        }
      }
      if (best > radius) continue;
      const at = c === b ? { x: world.x, y: world.y, z } : { x: px, y: py, z: Math.max(z, sceneHeightAt({ x: px, y: py }) + m(1.5)) };
      const force = c === b ? strength : Math.max(1, strength * (1 - best / radius) * 1.2);
      // Breaking a building into its pieces is the costly part (a Voronoi
      // fracture of its meshes): the one struck now, the others a frame each
      // after, so a big blow does not freeze the game for seconds.
      if (c !== b) { if (best < radius * 0.75 || force >= 4) { deferredHits.push({ id: c.id, ...at, force }); scheduleBreak(); } continue; }
      if (scene.strikeBuilding(c, at.x, at.y, at.z, force)) {
        doc.buildings.remove(c.id);
        scene.forgetRuin(c.id);
        burning.delete(c.id);
        downs++;
        changed = true;
      } else {
        // Its wiring shorting and its pipes bursting at a few points on the
        // side the blast struck: sparks and spouts of water for a while.
        const base = sceneHeightAt({ x: c.x, y: c.y });
        const floors = Math.max(1, Math.max(...c.volumes.map((v) => v.base + v.storeys.length)));
        // Only the first time it is struck, and only for a moment.
        const spots = shorted.has(c.id) ? 0 : Math.min(2, 1 + Math.round(force / 8));
        shorted.add(c.id);
        for (let k = 0; k < spots; k++) {
          const h = base + levelElevation(c, Math.floor(Math.random() * floors)) + m(1 + Math.random() * 1.5);
          const jx = px + (Math.random() - 0.5) * m(6), jy = py + (Math.random() - 0.5) * m(6);
          if (Math.random() < 0.75) scene.sparkAt(jx, jy, h, 0.6 + Math.random() * 0.8);
          else scene.leak(jx, jy, h, 1 + Math.random() * 1.5);
        }
      }
    }
    // Everything round it left filthy: the buildings within twice the reach
    // blackened with soot and dust (their weathering, `decay`).
    for (const c of [...doc.buildings.all()]) {
      const d = Math.hypot(c.x - world.x, c.y - world.y);
      if (d > radius * 2.2) continue;
      const add = 0.35 * (1 - d / (radius * 2.2)) * Math.min(1, strength / 8);
      if (add > 0.02) { doc.buildings.put({ ...c, decay: Math.min(1, (c.decay ?? 0) + add) }); changed = true; }
    }
    // Poles: broken whole, snapped or to splinters; the wires torn off them
    // pull the next poles over, or hang from them.
    const broken = new Set<PoleId>();
    for (const pole of doc.poles.values()) if (near(pole.x, pole.y, radius)) broken.add(pole.id);
    for (const span of doc.poleSpans.values()) {
      for (const [from, to] of [[span.a, span.b], [span.b, span.a]] as const) {
        if (!broken.has(to) || broken.has(from)) continue;
        const p = doc.poles.get(from);
        if (p && near(p.x, p.y, radius * 2.2) && Math.random() < 0.5) broken.add(from);
      }
    }
    for (const span of doc.poleSpans.values()) {
      const pa = doc.poles.get(span.a), pb = doc.poles.get(span.b);
      if (!pa || !pb) continue;
      if (broken.has(span.a) && !broken.has(span.b)) hit.wires.push({ fromX: pb.x, fromY: pb.y, toX: pa.x, toY: pa.y });
      if (broken.has(span.b) && !broken.has(span.a)) hit.wires.push({ fromX: pa.x, fromY: pa.y, toX: pb.x, toY: pb.y });
    }
    for (const id of broken) {
      const pole = doc.poles.get(id)!;
      const d = Math.hypot(pole.x - world.x, pole.y - world.y) || 1;
      const close = d < radius * 0.4;
      const mode = d > radius ? 'whole' : close && Math.random() < 0.6 ? 'splinter' : Math.random() < 0.5 ? 'snap' : 'whole';
      hit.poles.push({ x: pole.x, y: pole.y, lamp: pole.lamp, mode, dirX: (pole.x - world.x) / d, dirY: (pole.y - world.y) / d });
      doc.removePole(id);
      changed = true;
    }
    // Traffic lights: a junction whose posts the blast reaches loses them.
    for (const post of signalPosts(net, sim.graph)) {
      if (!near(post.x, post.y, radius)) continue;
      hit.posts.push({ x: post.x, y: post.y, yaw: post.yaw });
      if (doc.node(post.node)?.control !== 'none') { doc.setNodeControl(post.node, 'none'); changed = true; }
    }
    // Trees, benches, bins, lamps, signs: thrown and gone.
    for (const item of [...doc.landscape.values()]) {
      if (!near(item.x, item.y, radius)) continue;
      hit.items.push({ kind: item.kind, x: item.x, y: item.y });
      if (item.kind === 'hydrant') scene.geyser(item.x, item.y, sceneHeightAt(item));
      doc.removeLandscape(item.id);
      changed = true;
    }
    // Bare earth: a crater dug into the terrain.
    if (ground === 'earth') {
      doc.addTerrainStamp({ x: world.x, y: world.y, radius: radius * 0.5, strength: m(0.6 + strength * 0.12), mode: 'lower' });
      changed = true;
    }
    return changed;
  });
  // Cars: thrown, burning shells - the traffic.
  // Who was in them or on them: thrown out dead, torn, burnt black near the blast.
  const aboard: Occupant[] = [];
  const throwAboard = (id: number, x: number, y: number, angle: number, rider: boolean, index: number | null = null): void => {
    const d = Math.hypot(x - world.x, y - world.y);
    const close = d < radius * 0.6;
    aboard.push({ id: 8_000_000 + id, x, y, z: sceneHeightAt({ x, y }) + m(rider ? 1.0 : 0.6), heading: angle,
      blastX: world.x, blastY: world.y, power: Math.max(0.3, 1 - d / (radius * 1.1)),
      kind: close && Math.random() < 0.5 ? 'torn' : 'dead', charred: !rider || close, index });
  };
  for (const v of [...sim.vehicles.values()]) {
    const pose = vehiclePose(sim, v, 1);
    if (!pose || !near(pose.p.x, pose.p.y, radius * 1.1)) continue;
    const css = String(v.color ?? '#777777');
    hit.vehicles.push({ x: pose.p.x, y: pose.p.y, angle: pose.angle, length: v.archetype.length, width: v.archetype.width,
      height: v.archetype.height, color: parseInt(css.replace('#', '').slice(0, 6), 16) || 0x777777, id: v.id, archetype: v.archetype });
    throwAboard(v.id, pose.p.x, pose.p.y, pose.angle, v.archetype.shape === 'bicycle' || v.archetype.shape === 'motorcycle', scene.driverBody(v, pose.p.x, pose.p.y));
    sim.removeVehicle(v);
  }
  (globalThis as Record<string, unknown>)['__lastBlast'] = { ...hit, radius, at: world };
  scene.explode(world.x, world.y, z, radius, hit);
  if (aboard.length) scene.flingOccupants(aboard);
  // Soot and ash over the ground round it, kept: streets and lots left dirty.
  const blots = Math.min(40, Math.round(6 + radius / m(3)));
  for (let k = 0; k < blots; k++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * radius * 1.6;
    const x = world.x + Math.cos(a) * r, y = world.y + Math.sin(a) * r;
    scene.soot(x, y, sceneHeightAt({ x, y }), m(2 + Math.random() * 4) + radius * 0.08);
  }
  if (ground === 'road') scene.strikeGround(world.x, world.y, strength);
  if (downs > 0 || hit.poles.length || hit.vehicles.length) zoneGrowthHold = performance.now() + 90_000;
  if (!quiet) flashHint(downs > 0 ? 'hint.strike.down' : dead > 0 ? 'hint.strike.deaths' : b ? 'hint.strike.hit' : 'hint.strike.ground');
  if (b && doc.buildings.has(b.id)) ignite(b.id);
  requestDraw();
}

/**
 * Buildings on fire (the player's order of 2026-10-05: "o fogo ir tomando
 * conta dos prédios vizinhos, acontecendo explosões, e ir ficando um clima
 * ruim"): each burns with flames and a black column for a couple of minutes,
 * spreads now and then to a neighbour close by, and now and then blows up
 * (a gas main, a tank) - an explosion of its own that breaks more. The air
 * thickens with smoke while anything burns.
 */
/** Buildings a blow reached, broken one a frame (`explodeAt`). */
/** Buildings that already shorted and burst their pipes (once each). */
const shorted = new Set<number>();
const deferredHits: { id: number; x: number; y: number; z: number; force: number }[] = [];
// A building struck comes down when its pieces are ready (made off the main thread).
scene.onBuildingDown((id) => {
  if (!doc.buildings.has(id as BuildingId)) return;
  mutate(() => { doc.buildings.remove(id as BuildingId); scene.forgetRuin(id); burning.delete(id); return true; });
  requestDraw();
});
/** A frame asked for the buildings waiting to break (`breakDeferred`); none while none wait. */
let breaking = false;
function breakDeferred(): void {
  breaking = false;
  for (let k = 0; k < 4 && deferredHits.length; k++) breakOne(deferredHits.shift()!);
  if (deferredHits.length) scheduleBreak();
}
/** A frame for the buildings a blow reached: asked only while some wait (it ran every frame for ever). */
function scheduleBreak(): void {
  if (breaking) return;
  breaking = true;
  requestAnimationFrame(breakDeferred);
}
function breakOne(next: { id: number; x: number; y: number; z: number; force: number }): void {
  {
    const c = doc.buildings.get(next.id as BuildingId);
    if (c && scene.strikeBuilding(c, next.x, next.y, next.z, next.force)) {
      mutate(() => { doc.buildings.remove(c.id); scene.forgetRuin(c.id); burning.delete(c.id); return true; });
    }
    requestDraw();
  }
}
const burning = new Map<number, { since: number; nextFlame: number; until: number }>();
function ignite(id: number): void {
  if (burning.has(id) || burning.size >= 3) return;
  const now = performance.now() / 1000;
  burning.set(id, { since: now, nextFlame: now, until: now + 50 + Math.random() * 40 });
}
setInterval(() => {
  const now = performance.now() / 1000;
  for (const [id, f] of [...burning]) {
    const b = doc.buildings.get(id as BuildingId);
    if (!b || now > f.until) { burning.delete(id); continue; }
    const rings = solidFootprints(b);
    const pts = rings.flat();
    if (!pts.length) { burning.delete(id); continue; }
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const size = Math.min(m(30), Math.max(m(6), Math.hypot(pts[0]!.x - cx, pts[0]!.y - cy)));
    const ground = sceneHeightAt({ x: cx, y: cy });
    if (now >= f.nextFlame) {
      // Fires at a few points of the building, from the ground up its height.
      for (let k = 0; k < 2; k++) {
        const p = pts[Math.floor(Math.random() * pts.length)]!;
        const x = cx + (p.x - cx) * Math.random(), y = cy + (p.y - cy) * Math.random();
        scene.burn(x, y, ground + m(2 + Math.random() * 10), Math.min(size * 0.3, m(3)), 7);
      }
      f.nextFlame = now + 6;
    }
  }
  if (burning.size) requestDraw();
}, 500);

/** The first point of building `b` along the screen ray through (sx, sy): marched down from its top. */
function rayOnBuilding(b: Building, sx: number, sy: number, ground: number): (Vec2 & { z: number }) | null {
  const volumes = resolveBlocks(b).volumes.filter((v) => !v.open);
  let top = 0;
  for (const v of volumes) top = Math.max(top, levelElevation(b, v.base + v.storeys.length));
  for (let h = top + m(1); h >= 0; h -= m(0.5)) {
    const p = view.toWorldAt(sx, sy, ground + h, surface.cssW, surface.cssH);
    const l = worldToLocal(b, p);
    for (const v of volumes) {
      if (l.x < v.x || l.x > v.x + v.w || l.y < v.y || l.y > v.y + v.d) continue;
      if (h <= levelElevation(b, v.base + v.storeys.length) && h >= levelElevation(b, v.base)) return { x: p.x, y: p.y, z: ground + h };
    }
  }
  return null;
}

// Everything is set up: the first frame may be drawn.
booted = true;
requestDraw();
