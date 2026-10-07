/**
 * Roadcraft's interface, redesigned (2026-10-04).
 *
 * A new layout, not the old panels restyled:
 * - a HUD across the top: the city (clock, sky, residents, traffic) on the
 *   left, the speed in the centre, menu / camera / history / help on the right;
 * - a dock of categories at the bottom centre, icon and name, as Cities:
 *   Skylines II lays its toolbar;
 * - above it, the tool's drawer: its modes as tabs, its options in a column,
 *   its catalogue as a strip of big cards (one picture per thing, a row with a
 *   name per verb);
 * - the selection on the right.
 *
 * The game's commands are unchanged: this module drives them - the Builder
 * through its actions, the map tools through the game's own (now invisible)
 * controls - so nothing the player does here can disagree with the rules.
 */
import { EFFECT_KINDS, type ElementKind } from '@world/elements';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { CITY_BUILDINGS } from '@world/buildings/cityBuildings';
import { FINISHES, STYLES } from '@world/buildings/materials';
import { FACADE_PATTERNS } from '@world/buildings/types';
import {
  BUILDER_TAB_SPECS,
  DRAW_ACTIONS,
  DRAW_SHAPES,
  FACADE_SCOPES,
  TIER_SHAPES,
  type BuilderCategoryId,
  type BuilderSection,
  type BuilderToolSpec,
} from '../builder/catalog';
import { roadSnap, setRoadSnap } from '@editor/snap';
import { type TransitToolKind, transitTool } from '@editor/transitTools';
import { ROAD_PARKING_PRESETS, roadParkingPreset, setRoadParkingPreset } from '@editor/roadParking';
import { blockGridChoice, onRoadGridChange, roadGridShown, roadWidth, setRoadGridShown, setRoadWidth, setZoneColoursShown, signChoice, strikeChoice, zoneColoursShown } from '../toolChoices';
import { SIGN_HAS_TEXT, SIGN_TEXT_MAX, SIGN_TYPES } from '@world/landscape';
import { CLOUD_MODES, POLE_TOOL_MODES, cloudMode, setCloudMode, elementKind, elementMode, setElementKind, setElementMode, fogErase, paintKind, poleLampMode, poleToolMode, setFogErase, setPaintKind, setPoleLampMode, setPoleToolMode, setStreetscapeKind, streetscapeKind } from '../toolChoices';
import { PAINT_KINDS, type PaintKind } from '@world/terrainPaint';

/** The colour of each paintable ground, for its button. */
const PAINT_SWATCH: Readonly<Record<PaintKind, string>> = {
  sand: '#ccb380', soil: '#7a5a3c', meadow: '#7d8f3a', snow: '#eef1f6', gravel: '#8b8a84', asphalt: '#2d2e32', concrete: '#a8a69f', grass: '#4f7a36', forest: '#2c4f26',
  scrub: '#4c6a2c', flowers: '#c86a8e', rocks: '#7d776c', granite: '#8d8a84', sandstone: '#c27a44', basalt: '#3b3836',
  cerrado: '#b8933e', atlantic: '#2f6b34', amazon: '#1b4f27', caatinga: '#a08b68', pampa: '#86ad4c', pantanal: '#4e8f7c',
};
/** The biomes, painted or chosen for the whole map (`world/ecology.ts`). */
const BIOME_SWATCHES = ['cerrado', 'atlantic', 'amazon', 'caatinga', 'pampa', 'pantanal'] as const;
import { LANDSCAPE_KINDS } from '@world/landscape';
import { POLE_LAMP_MODES } from '@world/utilities';
import { builderIconSvg } from '../builder/icons';
import { SNAP_MODES, type BuilderState, type BuilderWorkspace } from '../builder/workspace';
import { t, onLanguageChange } from '../i18n';
import { materialSwatch } from '../materialSwatch';
import { planSwatch } from '../planSwatch';
import './shell.css';

type Category = 'roads' | 'zones' | 'build' | 'landscape' | 'transit' | 'people' | 'demolish' | 'info';

const SWATCHES: readonly number[] = [
  0xf2efe8, 0xe6d8bd, 0xd8c297, 0xc98f5a, 0xa4563f, 0x72412f, 0x9c6b43,
  0xbdbcb4, 0x8f9ba5, 0x55585c, 0x2f3134, 0x7d8c6a, 0x5d7a8f, 0x9fb8c4,
];
const hexOf = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

const ICON: Record<string, string> = {
  player: '<circle cx="12" cy="5" r="2.2"/><path d="M12 8v6m0 0-3 6m3-6 3 6M8 11l4-2 4 2"/>',
  roads: '<path d="M7 21 10 3h4l3 18"/><path d="M12 6v2m0 3v2m0 3v2"/>',
  zones: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
  build: '<path d="M4 21V9l6-4v16"/><path d="M10 21V3h10v18"/><path d="M2 21h20"/><path d="M13 7h1m3 0h1m-5 4h1m3 0h1m-5 4h1m3 0h1"/>',
  landscape: '<path d="m2 19 7-11 4 6 3-4 6 9Z"/><circle cx="17" cy="5" r="2"/>',
  transit: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 11h14M8 18v2M16 18v2"/><circle cx="8.5" cy="14.5" r="1"/><circle cx="15.5" cy="14.5" r="1"/>',
  tr_stop: '<path d="M7 21V4"/><rect x="7" y="4" width="10" height="7" rx="1"/><path d="M10 7.5h4"/><path d="M4 21h8"/>',
  tr_terminal: '<rect x="3" y="9" width="18" height="10" rx="1"/><path d="M3 9l9-5 9 5M8 19v-5h8v5"/>',
  tr_track: '<path d="M8 3 6 21M16 3l2 18M6.5 7h11M6 12h12M5.5 17h13"/>',
  tr_metro: '<path d="M4 20h16"/><rect x="6" y="5" width="12" height="11" rx="4"/><path d="M6 11h12M9 16l-2 3m8-3 2 3"/><circle cx="12" cy="8" r="1"/>',
  tr_station: '<path d="M3 20h18M5 20V9h14v11M3 9l9-5 9 5"/><path d="M9 13h6"/>',
  tr_line: '<circle cx="5" cy="17" r="2"/><circle cx="12" cy="7" r="2"/><circle cx="19" cy="17" r="2"/><path d="M6.4 15.6 10.6 8.4M13.4 8.4l4.2 7.2"/>',
  people: '<circle cx="12" cy="6" r="3"/><path d="M6 21v-5a6 6 0 0 1 12 0v5"/>',
  actions: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  bomb: '<circle cx="11" cy="14" r="7"/><path d="M15 8l2-2M17 6l1.5-1.5M19 3l1 1M20 6l1 0"/>',
  demolish: '<path d="m5 9 8-5 5 8-8 5Z"/><path d="m7 15 5 5m4-8 3 5"/>',
  info: '<circle cx="11" cy="11" r="6"/><path d="m16 16 5 5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  camera: '<path d="M3 8h4l2-3h6l2 3h4v11H3Z"/><circle cx="12" cy="13" r="3.5"/>',
  sim: '<path d="M4 18 9 9l4 5 3-4 4 8"/><path d="M4 18h16"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5"/><path d="M12 17.5v.5"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/>',
  redo: '<path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  raise: '<path d="M3 20h18"/><path d="m5 20 7-12 7 12"/><path d="M12 3v3"/>',
  lower: '<path d="M3 6h18"/><path d="m5 6 7 12 7-12"/>',
  flatten: '<path d="M3 15h18"/><path d="M6 11h12"/>',
  river: '<path d="M3 8c3-3 6 3 9 0s6 3 9 0"/><path d="M3 15c3-3 6 3 9 0s6 3 9 0"/>',
  paint: '<path d="M4 20c2 0 4-1 4-4 0-2 2-3 4-3"/><path d="M12 13l7-7a2 2 0 0 0-3-3l-7 7"/><path d="M9 10l3 3"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.3 1.7A3.2 3.2 0 0 0 7 18Z"/>',
  fog: '<path d="M3 9h13"/><path d="M6 13h15"/><path d="M3 17h13"/><path d="M19 9h2M3 13h1M18 17h3"/>',
  mesa: '<path d="M2 20h20"/><path d="M4 20 7 9h10l3 11"/><path d="M7.6 13h8.8M6.6 16.5h10.8"/>',
  canyon: '<path d="M2 6h6l2 13h4l2-13h6"/><path d="M8.6 10h-6M15.4 10h6M9.3 14.5h-7M14.7 14.5h7"/>',
  escarpment: '<path d="M2 20h20"/><path d="M3 20V8h9l1 12"/><path d="M5 8v12M7.5 8v12M10 8v12"/><path d="M13 20c3-1 5-2 9-2"/>',
  sugarloaf: '<path d="M2 20h20"/><path d="M5 20c0-9 2-14 6-14s6 5 6 14"/><path d="M9 9c0 3 0 7 .5 11M13 9c.3 3 .4 7 .2 11"/>',
  brush: '<path d="M14 4 20 10 10 20H4v-6Z"/>',
  fill: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/>',
  eraser: '<path d="m8 20-5-5L14 4l7 7-9 9Z"/><path d="M8 20h12"/>',
  frame: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  grid: '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/>',
  hide: '<path d="M3 3l18 18"/><path d="M10.6 6.2A9 9 0 0 1 21 12a14 14 0 0 1-2.4 3.2M6.3 6.6A14 14 0 0 0 3 12s3 6 9 6a8.8 8.8 0 0 0 4.3-1.1"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  car: '<path d="M4 16V12l2-5h12l2 5v4Z"/><path d="M4 12h16"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>',
  crowd: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2"/><circle cx="17" cy="8" r="2.5"/><path d="M16 13a5 5 0 0 1 6 4.5V21"/>',
  demand: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  heat: '<path d="M3 17c4-1 5-6 9-6s5 5 9 6"/><path d="M3 12c4-1 5-6 9-6s5 5 9 6" stroke-dasharray="2 2"/><circle cx="12" cy="11" r="1.5" fill="currentColor"/>',
  // Road modes
  draw: '<path d="M4 20 15 9l3 3L7 23H4Z" transform="translate(0 -3)"/><path d="m15 6 3-3 3 3-3 3"/>',
  upgrade: '<path d="M12 20V6"/><path d="m6 11 6-6 6 6"/><path d="M5 21h14"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  join: '<rect x="3" y="6" width="8" height="12" rx="1"/><rect x="13" y="6" width="8" height="12" rx="1"/><path d="M9 12h6"/>',
  lotPolygon: '<path d="M5 18 3 9l8-6 9 5-2 10Z"/><circle cx="5" cy="18" r="1.6"/><circle cx="3" cy="9" r="1.6"/><circle cx="11" cy="3" r="1.6"/>',
  lotCurve: '<path d="M4 20V8"/><path d="M4 8Q12 2 20 8"/><path d="M20 8v12H4"/>',
  lotEdit: '<path d="M4 4h16v16H4Z"/><circle cx="4" cy="4" r="2"/><circle cx="20" cy="20" r="2"/>',
  lotDelete: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="m8 8 8 8M16 8l-8 8"/>',
  lotFront: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="2 2"/><path d="M4 20h16" stroke-width="3"/><path d="m12 9 0 7M9 13l3 3 3-3"/>',
  split: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5 20 17M8 15.5 20 7"/>',
  control: '<rect x="8" y="2" width="8" height="17" rx="2"/><circle cx="12" cy="6" r="1.4"/><circle cx="12" cy="10.5" r="1.4"/><circle cx="12" cy="15" r="1.4"/><path d="M12 19v3"/>',
  roundabout: '<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="8.5"/><path d="M12 1v2.5M12 20.5V23M1 12h2.5M20.5 12H23"/>',
  // Alignment
  straight: '<path d="M4 20 20 4"/><circle cx="4" cy="20" r="1.6"/><circle cx="20" cy="4" r="1.6"/>',
  curve: '<path d="M4 20C6 8 14 6 20 4"/><circle cx="4" cy="20" r="1.6"/><circle cx="20" cy="4" r="1.6"/>',
  free: '<path d="M3 19c3-1 3-6 6-6s2 5 5 5 3-9 7-12"/>',
  // Snapping
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/><path d="M10 3v8a2 2 0 0 0 4 0V3"/>',
  angle: '<path d="M4 20h16"/><path d="M4 20 16 6"/><path d="M10 20a6 6 0 0 0-1.8-4.3"/>',
  cells: '<path d="M3 15h18v5H3z"/><path d="M8 15v5M13 15v5M18 15v5"/><path d="M3 5h18M3 9h18" stroke-dasharray="2 2"/>',
  // Parking: the carriageway from above, bays along its kerbs
  'park-none': '<path d="M5 3v18M19 3v18"/><path d="M12 4v3m0 3v4m0 3v3"/>',
  'park-parallel': '<path d="M3 3v18M21 3v18"/><path d="M7 3v18M17 3v18"/><path d="M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  'park-parallelRight': '<path d="M4 3v18M21 3v18"/><path d="M17 3v18"/><path d="M17 9h4M17 15h4"/><path d="M10.5 4v3m0 3v4m0 3v3"/>',
  'park-parallelLeft': '<path d="M3 3v18M20 3v18"/><path d="M7 3v18"/><path d="M3 9h4M3 15h4"/><path d="M13.5 4v3m0 3v4m0 3v3"/>',
  'park-cycle': '<path d="M3 3v18M21 3v18M7 3v18M17 3v18"/><circle cx="5" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  'park-cycleParking': '<path d="M3 3v18M21 3v18M7 3v18M17 3v18"/><path d="M3 9h4M3 15h4"/><circle cx="19" cy="12" r="1.2"/>',
  // Lanes: the carriageway seen from above
  lanes2: '<path d="M7 3v18M17 3v18"/><path d="M12 4v3m0 3v4m0 3v3" />',
  lanes4: '<path d="M4 3v18M20 3v18"/><path d="M12 3v18"/><path d="M8 5v2m0 4v2m0 4v2M16 5v2m0 4v2m0 4v2"/>',
  lanes6: '<path d="M3 3v18M21 3v18M12 3v18"/><path d="M6 5v2m0 4v2m0 4v2M9 5v2m0 4v2m0 4v2M15 5v2m0 4v2m0 4v2M18 5v2m0 4v2m0 4v2"/>',
  median: '<path d="M3 3v18M21 3v18"/><path d="M10.5 3v18M13.5 3v18"/><path d="M7 5v2m0 4v2m0 4v2M17 5v2m0 4v2m0 4v2"/>',
  // Density: how tall
  low: '<path d="M4 20h16"/><rect x="5" y="14" width="14" height="6" rx="1"/>',
  medium: '<path d="M4 20h16"/><rect x="6" y="9" width="12" height="11" rx="1"/><path d="M9 13h2m2 0h2M9 16h2m2 0h2"/>',
  high: '<path d="M4 20h16"/><rect x="8" y="3" width="8" height="17" rx="1"/><path d="M10.5 7h3M10.5 10h3M10.5 13h3M10.5 16h3"/>',
  // Landscape tabs
  terrain: '<path d="m2 19 7-11 4 6 3-4 6 9Z"/>',
  walls: '<path d="M3 20V9h18v11"/><path d="M3 13h18M3 17h18M8 9v4M14 9v4M11 13v4M17 13v4M6 17v3M14 17v3"/>',
  radius: '<circle cx="12" cy="12" r="8"/><path d="M12 12h8"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  strength: '<path d="M4 20h16"/><path d="M6 20v-4M10 20v-7M14 20v-10M18 20v-14"/>',
  // Where a facade change applies: a facade of 3 x 3 bays, the part lit.
  scope_bay: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"9.3\" y=\"9.3\" width=\"5.4\" height=\"5.4\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  scope_zone: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"9.3\" y=\"4\" width=\"10.7\" height=\"10.7\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/><rect x=\"9.3\" y=\"4\" width=\"10.7\" height=\"10.7\" stroke-dasharray=\"2 1.5\"/>',
  scope_row: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"4.8\" y=\"10.1\" width=\"3.7\" height=\"3.8\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/><rect x=\"10.1\" y=\"10.1\" width=\"3.8\" height=\"3.8\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/><rect x=\"15.5\" y=\"10.1\" width=\"3.7\" height=\"3.8\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  scope_column: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"9.3\" y=\"4\" width=\"5.4\" height=\"16\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  scope_storey: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"2\" y=\"9.3\" width=\"20\" height=\"5.4\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  scope_side: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  scope_volume: '<path d=\"M12 3 20 7.5v9L12 21l-8-4.5v-9Z\"/><path d=\"M4 7.5 12 12l8-4.5M12 12v9\"/><path d=\"M12 3 20 7.5 12 12 4 7.5Z\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  // Roofs: which way the ridge runs, which side the slope falls to
  ridge_x: '<path d=\"M3 12h18\"/><path d=\"m7 8-4 4 4 4M17 8l4 4-4 4\"/>',
  ridge_y: '<path d=\"M12 3v18\"/><path d=\"m8 7 4-4 4 4M8 17l4 4 4-4\"/>',
  fall_front: '<path d=\"M12 4v15\"/><path d=\"m6 13 6 6 6-6\"/>',
  fall_right: '<path d=\"M4 12h15\"/><path d=\"m13 6 6 6-6 6\"/>',
  fall_back: '<path d=\"M12 20V5\"/><path d=\"m6 11 6-6 6 6\"/>',
  fall_left: '<path d=\"M20 12H5\"/><path d=\"m11 6-6 6 6 6\"/>',
  advanced: '<path d=\"M4 7h10M18 7h2M4 17h4M12 17h8\"/><circle cx=\"16\" cy=\"7\" r=\"2\"/><circle cx=\"10\" cy=\"17\" r=\"2\"/>',
  poles: '<path d="M12 22V3"/><path d="M6 6h12"/><path d="M7 6v2M17 6v2"/><path d="M6 6c3 3 9 3 12 0" stroke-dasharray="2 2"/>',
  // Landscaping: what goes on a footway
  streetscape: '<path d="M12 21v-6"/><circle cx="12" cy="9" r="5"/><path d="M4 21h16"/>',
  ls_tree: '<path d="M12 21v-7"/><circle cx="12" cy="9" r="6"/><path d="M8 21h8"/>',
  ls_shrub: '<path d="M4 19c0-4 3-7 8-7s8 3 8 7Z"/><path d="M8 13c0-3 2-5 4-5s4 2 4 5"/><path d="M3 21h18"/>',
  ls_bench: '<path d="M4 11h16"/><path d="M4 15h16"/><path d="M6 15v5M18 15v5M6 11V7h12v4"/>',
  ls_bin: '<path d="M6 7h12l-1 14H7Z"/><path d="M5 7h14M10 4h4"/><path d="M10 11v6M14 11v6"/>',
  ls_lamp: '<path d="M7 21V5h7"/><path d="M12 5h5l1 2h-6Z"/><path d="M15 9l-1 3M17 9l1 3" stroke-dasharray="1.5 1.5"/><path d="M4 21h6"/>',
  ls_hydrant: '<path d="M8 21V10h8v11Z"/><path d="M8 10a4 4 0 0 1 8 0"/><path d="M5 14h3M16 14h3M12 4v2"/><path d="M6 21h12"/>',
  ls_postbox: '<rect x="6" y="5" width="12" height="11" rx="5"/><path d="M9 9h6"/><path d="M12 16v5M8 21h8"/>',
  ls_phone: '<path d="M7 11a5 6 0 0 1 10 0v2H7Z"/><path d="M12 13v8M9 21h6"/><path d="M11 9h2v3h-2Z"/>',
  ls_meadow: '<path d="M4 20c1-4 2-7 1-10M8 20c0-5 1-8 3-11M12 20c0-4-1-8-3-12M16 20c0-5 2-8 4-10M20 20c-1-3-1-6 0-8"/>',
  ls_sign: '<path d="M12 22V11"/><path d="M8 3h8l3 4-3 4H8L5 7Z"/>',
  ls_streetname: '<path d="M12 22V8"/><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M6 5.5h12" stroke-dasharray="2 1.5"/>',
  ls_drain: '<path d="M3 9h18"/><path d="M3 9v3h18V9"/><path d="M5 15h14v4H5Z"/><path d="M8 15v4M11 15v4M14 15v4M17 15v4"/>',
  guardrail: '<path d="M5 18v-8M12 18v-8M19 18v-8"/><path d="M3 9h18v4H3Z"/><path d="M3 11h18"/>',
  railing: '<path d="M4 20V6M20 20V6"/><path d="M4 7h16M4 18h16"/><path d="M8 7v11M12 7v11M16 7v11"/>',
  // The pole tool's two verbs: string a line, take a pole down
  pole_build: '<path d="M6 21V4M18 21V4"/><path d="M3 7h6M15 7h6"/><path d="M6 8c4 3 8 3 12 0"/><path d="M12 14v6M9 17h6"/>',
  pole_remove: '<path d="M10 21V4"/><path d="M6 7h8"/><path d="M15 13l5 5M20 13l-5 5"/>',
  // Street lights on the wire poles: none, every other, all
  pl_none: '<path d="M8 21V4"/><path d="M4 7h8"/><path d="M15 9l5 5M20 9l-5 5"/>',
  pl_alternate: '<path d="M6 21V5h4M18 21V5"/><path d="M9 5l1 2H8Z"/><path d="M9 9l-.5 2" stroke-dasharray="1.5 1.5"/>',
  pl_all: '<path d="M6 21V5h4M18 21V5h-4"/><path d="M9 5l1 2H8ZM15 5l-1 2h2Z"/><path d="M9 9l-.5 2M15 9l.5 2" stroke-dasharray="1.5 1.5"/>',
};
const svg = (name: string, size = 22): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const q = <T extends HTMLElement = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const press = (selector: string): void => q<HTMLButtonElement>(selector)?.click();
const button = (className: string, label: string, run: () => void, icon?: string): HTMLButtonElement => {
  const b = el('button', className);
  b.type = 'button';
  b.innerHTML = icon ? `${icon}<span></span>` : '<span></span>';
  (b.querySelector('span') as HTMLElement).textContent = label;
  b.title = label;
  b.onclick = run;
  return b;
};
/** Sets one of the game's own inputs as the player would. */
const setInput = (selector: string, value: string): void => {
  const input = q<HTMLInputElement | HTMLSelectElement>(selector);
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

export interface ShellDeps {
  readonly workspace: BuilderWorkspace;
}

export function mountShell(deps: ShellDeps): void {
  const { workspace } = deps;
  const actions = workspace.actions;
  document.documentElement.classList.add('v2-shell');
  const root = el('div', 'v2');
  document.getElementById('app')?.appendChild(root);

  // ================================================================ HUD
  const hud = el('header', 'v2-hud');
  const city = el('div', 'v2-city');
  const sky = el('button', 'v2-sky');
  sky.type = 'button';
  sky.onclick = () => press('#skyMode');
  const clock = el('strong', 'v2-clock');
  const stats = el('div', 'v2-stats');
  city.append(sky, clock, stats);

  const speed = el('div', 'v2-speed');
  speed.setAttribute('role', 'group');
  const speedButtons: HTMLButtonElement[] = [];
  for (const s of ['0', '1', '2', '4']) {
    const b = el('button', 'v2-speed-b');
    b.type = 'button';
    b.dataset['speed'] = s;
    b.innerHTML = s === '0' ? svg('pause', 16) : `${s}×`;
    b.onclick = () => press(`.simulation-controls [data-speed="${s}"]`);
    speedButtons.push(b);
    speed.appendChild(b);
  }

  const actionsBar = el('div', 'v2-actions');
  const undo = button('v2-icon', t('action.undo'), () => press('#undoAction'), svg('undo', 18));
  const redo = button('v2-icon', t('action.redo'), () => press('#redoAction'), svg('redo', 18));
  const menuB = button('v2-pill', t('builder.menu.app'), () => toggle('menu', menuB), svg('menu', 18));
  const simB = button('v2-pill', t('builder.menu.simulation'), () => toggle('sim', simB), svg('sim', 18));
  const camB = button('v2-pill', t('camera.label'), () => toggle('camera', camB), svg('camera', 18));
  const helpB = button('v2-icon', t('builder.help'), () => toggle('help', helpB), svg('help', 18));
  // The grid over the whole map, on and off.
  const gridB = button('v2-icon', t('v2.grid.toggle'), () => { setRoadGridShown(!roadGridShown()); syncGrid(); render(); }, svg('grid', 18));
  const syncGrid = (): void => { gridB.classList.toggle('on', roadGridShown()); gridB.setAttribute('aria-pressed', String(roadGridShown())); };
  syncGrid();
  onRoadGridChange(syncGrid);
  // Into the scenery on foot (`play.ts`): the way in, in plain sight, not only the J key.
  const playB = button('v2-pill v2-play', t('play.button'), () => press('#playButton'), svg('player', 18));
  playB.title = t('play.start');
  // See inside the buildings (the Builder's own toggle, `workspace.ts`): on,
  // with the floor shown and a step down and up beside it.
  const insideButtons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.bw-inside .bw-icon-button')];
  const insideLevel = (): string => document.querySelector('.bw-inside .bw-inside-level')?.textContent ?? '';
  const insideB = button('v2-icon', t('inside.toggle'), () => { insideButtons()[0]?.click(); syncInside(); }, builderIconSvg('interiorView', 18));
  const insideDownB = button('v2-icon', t('inside.down'), () => { insideButtons()[1]?.click(); syncInside(); }, builderIconSvg('floorDown', 16));
  const insideUpB = button('v2-icon', t('inside.up'), () => { insideButtons()[2]?.click(); syncInside(); }, builderIconSvg('floorUp', 16));
  const insideLevelEl = el('span', 'v2-inside-level');
  const syncInside = (): void => {
    const on = insideButtons()[0]?.classList.contains('active') ?? false;
    insideB.classList.toggle('on', on);
    insideB.setAttribute('aria-pressed', String(on));
    insideDownB.hidden = insideUpB.hidden = insideLevelEl.hidden = !on;
    insideLevelEl.textContent = insideLevel();
  };
  syncInside();
  actionsBar.append(playB, insideB, insideDownB, insideLevelEl, insideUpB, gridB, simB, camB, undo, redo, helpB, menuB);
  hud.append(city, speed, actionsBar);

  // ================================================================ popovers
  const pop = el('div', 'v2-pop');
  pop.hidden = true;
  let popId: string | null = null;
  let popAnchor: HTMLElement | null = null;
  const closePop = (): void => {
    pop.hidden = true;
    popId = null;
    popAnchor = null;
  };
  document.addEventListener('pointerdown', (e) => {
    if (!popId) return;
    const target = e.target as Node;
    if (!pop.contains(target) && !popAnchor?.contains(target)) closePop();
  }, true);
  const toggle = (id: string, anchor: HTMLElement): void => {
    if (popId === id) return closePop();
    popId = id;
    popAnchor = anchor;
    pop.innerHTML = '';
    pop.appendChild(popBody(id));
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    if (r.top > window.innerHeight / 2) {
      // From the dock at the bottom: opened above its button.
      pop.style.top = 'auto';
      pop.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
      pop.style.right = 'auto';
      pop.style.left = `${Math.max(12, Math.round(r.left + r.width / 2 - 140))}px`;
    } else {
      pop.style.bottom = 'auto';
      pop.style.left = 'auto';
      pop.style.top = `${Math.round(r.bottom + 8)}px`;
      pop.style.right = `${Math.max(12, Math.round(window.innerWidth - r.right))}px`;
    }
  };
  const row = (label: string, run: () => void, icon = ''): HTMLButtonElement => {
    const b = button('v2-row', label, () => { run(); closePop(); }, icon);
    return b;
  };
  const slider = (label: string, selector: string, outSelector: string, icon?: string): HTMLElement => {
    const source = q<HTMLInputElement>(selector);
    const wrap = el('label', 'v2-slider' + (icon ? ' iconic' : ''));
    wrap.title = label;
    const name = el('span', 'v2-slider-name', label);
    if (icon) name.innerHTML = icon;
    const out = el('output', 'v2-slider-out', q(outSelector)?.textContent ?? '');
    const input = el('input');
    input.type = 'range';
    if (source) {
      input.min = source.min;
      input.max = source.max;
      input.step = source.step;
      input.value = source.value;
    }
    input.oninput = () => {
      setInput(selector, input.value);
      out.textContent = q(outSelector)?.textContent ?? input.value;
    };
    wrap.append(name, input, out);
    return wrap;
  };
  const selectProxy = (label: string, selector: string, icon?: string): HTMLElement => {
    const source = q<HTMLSelectElement>(selector);
    const wrap = el('label', 'v2-select' + (icon ? ' iconic' : ''));
    const name = el('span', '', label);
    if (icon) {
      name.innerHTML = icon;
      wrap.title = label;
    }
    const select = el('select');
    for (const o of source?.options ?? []) {
      const option = el('option', '', o.textContent ?? o.value);
      option.value = o.value;
      option.selected = o.value === source?.value;
      select.appendChild(option);
    }
    select.onchange = () => setInput(selector, select.value);
    wrap.append(name, select);
    return wrap;
  };
  function popBody(id: string): HTMLElement {
    const body = el('div', 'v2-pop-body');
    if (id === 'menu') {
      body.append(
        row(t('action.newMap'), () => press('#newMap')),
        row(t('action.openMap'), () => press('#openMap')),
        row(t('action.saveMap'), () => press('#saveMap')),
        el('hr'),
        selectProxy(t('menu.quality'), '#qualitySelect'),
        selectProxy(t('menu.language'), '#languageSelect'),
        el('hr'),
        row(t('action.about'), () => press('#aboutButton')),
      );
    } else if (id === 'actions') {
      // One button an action: a click and it is ready.
      body.classList.add('icons');
      // The pistol, as the bomb: clicked on a person in the map, the shot strikes where clicked.
      body.appendChild(button('v2-row', t('actions.pistol'), () => {
        strikeChoice.mode = 'shoot';
        open = true;
        closePop();
        press('.tool[data-tool="bulldoze"]');
        render();
      }, svg('actions', 18)));
      // The bomb (what Demolish called its Impact): clicked on the map, it strikes with a force.
      body.appendChild(button('v2-row', t('actions.bomb'), () => {
        strikeChoice.mode = 'strike';
        open = true;
        closePop();
        press('.tool[data-tool="bulldoze"]');
        render();
      }, svg('bomb', 18)));
    } else if (id === 'sim') {
      body.append(
        slider(t('sim.traffic'), '#trafficIntensity', '#trafficIntensityValue', svg('car', 18)),
        slider(t('sim.people'), '#pedIntensity', '#pedIntensityValue', svg('crowd', 18)),
      );
      // Demand and the congestion map side by side, as icons.
      const line = el('div', 'v2-pop-line');
      const congestion = q<HTMLButtonElement>('#congestionToggle');
      const c = button('v2-icon' + (congestion?.getAttribute('aria-pressed') === 'true' ? ' on' : ''), t('sim.congestionLabel'), () => {
        congestion?.click();
        c.classList.toggle('on', congestion?.getAttribute('aria-pressed') === 'true');
      }, svg('heat', 18));
      line.append(selectProxy(t('sim.demand'), '#demandLevel', svg('demand', 18)), c);
      body.appendChild(line);
      const metrics = q('.sim-metrics');
      if (metrics) {
        const copy = el('dl', 'v2-metrics');
        copy.innerHTML = metrics.innerHTML;
        body.appendChild(copy);
      }
    } else if (id === 'camera') {
      for (const b of document.querySelectorAll<HTMLButtonElement>('#cameraControls [data-camera], #resetView')) {
        const label = (b.getAttribute('aria-label') ?? b.title).replace(/\s*\(.*$/, '');
        const icon = b.querySelector('svg')?.outerHTML ?? '';
        // A row of icons, as a camera bar: the name in the tooltip.
        body.classList.add('icons');
        body.appendChild(button('v2-icon', label, () => b.click(), icon));
      }
    } else if (id === 'help') {
      for (const [title, text] of [
        ['builder.help.select', 'builder.help.select.text'],
        ['builder.help.gizmo', 'builder.help.gizmo.text'],
        ['builder.help.numeric', 'builder.help.numeric.text'],
        ['builder.help.keys', 'builder.help.keys.text'],
        ['builder.help.cancel', 'builder.help.cancel.text'],
      ] as const) {
        const block = el('div', 'v2-help');
        block.append(el('strong', '', t(title)), el('p', '', t(text)));
        body.appendChild(block);
      }
    }
    return body;
  }

  // ================================================================ dock
  const dock = el('nav', 'v2-dock');
  const CATS: readonly { id: Category; tool: string; key: string; label: () => string }[] = [
    { id: 'roads', tool: 'road', key: '1', label: () => t('tool.road') },
    { id: 'zones', tool: 'zone', key: 'Z', label: () => t('tool.zone') },
    { id: 'build', tool: 'building', key: 'H', label: () => t('tool.building') },
    { id: 'landscape', tool: 'terrain', key: 'T', label: () => t('v2.cat.landscape') },
    { id: 'transit', tool: 'transit', key: 'O', label: () => t('tool.transit') },
    { id: 'demolish', tool: 'bulldoze', key: 'B', label: () => t('tool.bulldoze') },
    { id: 'info', tool: 'inspect', key: 'I', label: () => t('v2.cat.info') },
  ];
  const catButtons = new Map<Category, HTMLButtonElement>();
  // The Actions: not a tool, a panel of what the player may do in play.
  const actionsB = el('button', 'v2-cat');
  actionsB.type = 'button';
  actionsB.title = t('v2.cat.actions');
  actionsB.setAttribute('aria-label', t('v2.cat.actions'));
  actionsB.innerHTML = `${svg('actions', 26)}<span class="v2-cat-name"></span>`;
  actionsB.onclick = () => toggle('actions', actionsB);
  for (const c of CATS) {
    const b = el('button', 'v2-cat' + (c.id === 'demolish' ? ' danger' : ''));
    b.type = 'button';
    b.dataset['cat'] = c.id;
    b.innerHTML = `${svg(c.id, 26)}<span class="v2-cat-name"></span><kbd>${c.key}</kbd>`;
    b.onclick = () => {
      if (categoryOf(tool()) === c.id && open) {
        // A second click puts the tool down: the free hand.
        press('.bw-fold');
        open = false;
        render();
        return;
      }
      open = true;
      // Demolish knocks down; the bomb is chosen from the Actions.
      if (c.id === 'demolish') strikeChoice.mode = 'demolish';
      press(`.tool[data-tool="${c.tool}"]`);
      render();
    };
    catButtons.set(c.id, b);
    dock.appendChild(b);
    if (c.id === 'demolish') dock.appendChild(actionsB);
  }

  // ================================================================ drawer
  const drawer = el('section', 'v2-drawer');
  const head = el('div', 'v2-drawer-head');
  const title = el('h2', 'v2-title');
  const tabs = el('div', 'v2-tabs');
  tabs.setAttribute('role', 'tablist');
  const tools = el('div', 'v2-head-tools');
  const close = button('v2-icon', t('v2.close'), () => {
    press('.bw-fold');
    open = false;
    render();
  }, svg('close', 18));
  head.append(title, tabs);
  const hint = el('p', 'v2-hint');
  const body = el('div', 'v2-drawer-body');
  const options = el('div', 'v2-options');
  const strip = el('div', 'v2-strip');
  body.append(strip);
  // The tool's options stand on their own at the bottom left, as Cities:
  // Skylines II lays its tool options: modes, elevation, snapping, as icons.
  const toolOptions = el('section', 'v2-toolopts');
  toolOptions.append(options, tools);
  // One row: the modes, the options, the things, the pointer's switches, close.
  drawer.append(head, hint, body, close);
  // A wheel over the strip scrolls it sideways.
  strip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });


  // The selection on the right: the road inspector lives here.
  const side = el('aside', 'v2-side');
  const roadInspector = q('#inspector');
  if (roadInspector) side.appendChild(roadInspector);

  root.append(hud, pop, drawer, toolOptions, side, dock);

  // The interface's own tooltip: every control is an icon and its name shows
  // here on hover - the browser's tooltip is slow and out of style. A control's
  // `title` is moved to `data-tip` the first time it is pointed at.
  const tip = el('div', 'v2-tip');
  tip.hidden = true;
  root.appendChild(tip);
  let tipFor: HTMLElement | null = null;
  root.addEventListener('pointerover', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[title], [data-tip]');
    if (!target || !root.contains(target)) return;
    if (target.title) {
      target.dataset['tip'] = target.title;
      target.removeAttribute('title');
    }
    const text = target.dataset['tip'] ?? '';
    if (!text) return;
    tipFor = target;
    tip.textContent = text;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    // Above the control; below it when that would leave the screen.
    const above = r.top - h - 8 >= 4;
    tip.style.left = `${Math.round(Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2)))}px`;
    tip.style.top = `${Math.round(above ? r.top - h - 8 : r.bottom + 8)}px`;
  });
  root.addEventListener('pointerout', (e) => {
    if (!tipFor) return;
    const to = e.relatedTarget as Node | null;
    if (to && tipFor.contains(to)) return;
    tipFor = null;
    tip.hidden = true;
  });
  root.addEventListener('pointerdown', () => { tip.hidden = true; });
  // A control rebuilt or removed under the pointer takes its tooltip with it.
  const tipCheck = (): void => {
    if (tipFor && (!tipFor.isConnected || tipFor.getBoundingClientRect().width === 0)) {
      tipFor = null;
      tip.hidden = true;
    }
  };
  setInterval(tipCheck, 200);

  // ================================================================ state
  let open = false;
  let landTab: 'terrain' | 'barrier' | 'pole' | 'streetscape' = 'terrain';
  let builder: BuilderState | null = null;

  let modelQuery = '';
  let modelCat = 'all';
  let advanced = false;
  try { advanced = window.localStorage.getItem('roadcraft.builder.advanced') === '1'; } catch { /* off */ }
  const requested = new Set<string>();

  const tool = (): string => (q('#game') as HTMLElement | null)?.dataset['tool'] ?? 'inspect';
  const categoryOf = (current: string): Category | null => {
    if (['road', 'upgrade', 'move', 'split', 'control', 'roundabout'].includes(current)) return 'roads';
    if (current === 'zone') return 'zones';
    if (current === 'building') return 'build';
    if (['terrain', 'barrier', 'pole', 'streetscape'].includes(current)) return 'landscape';
    if (current === 'transit') return 'transit';
    if (current === 'bulldoze') return 'demolish';
    if (current === 'inspect') return 'info';
    return null;
  };

  // ------------------------------------------------------------ helpers
  /** A mode of the tool: its icon, its name in the tooltip. */
  const tab = (label: string, on: boolean, run: () => void, disabled = false, icon?: string): HTMLButtonElement => {
    const b = button('v2-tab' + (on ? ' on' : '') + (icon ? ' icon' : ''), label, run, icon);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(on));
    b.disabled = disabled;
    return b;
  };
  /** A cluster of controls in the row; its name is the tooltip, not a heading. */
  const group = (label: string): HTMLElement => {
    const g = el('div', 'v2-group');
    g.title = label;
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    return g;
  };
  /** A group laid as a column with its name on top: a panel of rows, each named. */
  const titled = (g: HTMLElement, label: string): HTMLElement => {
    g.classList.add('stack', 'titled');
    g.prepend(el('span', 'v2-group-title', label));
    return g;
  };
  const choices = (items: readonly { label: string; on: boolean; run: () => void; disabled?: boolean; icon?: string }[], cols = 3): HTMLElement => {
    const wrap = el('div', 'v2-choices');
    wrap.style.setProperty('--cols', String(cols));
    for (const item of items) {
      const b = button('v2-choice' + (item.on ? ' on' : '') + (item.icon ? ' icon' : ''), item.label, item.run, item.icon);
      b.disabled = item.disabled ?? false;
      b.setAttribute('aria-pressed', String(item.on));
      wrap.appendChild(b);
    }
    return wrap;
  };
  /** A thing: its picture, its name. */
  const card = (label: string, on: boolean, run: () => void, picture?: string, iconHtml?: string, extra = ''): HTMLButtonElement => {
    const b = el('button', `v2-card${on ? ' on' : ''}${extra ? ` ${extra}` : ''}`);
    b.type = 'button';
    b.title = label;
    const art = picture ? `<img class="v2-card-art" src="${picture}" alt="" />` : `<span class="v2-card-art glyph">${iconHtml ?? ''}</span>`;
    b.innerHTML = `${art}<span class="v2-card-name"></span>`;
    (b.querySelector('.v2-card-name') as HTMLElement).textContent = label;
    b.onclick = run;
    return b;
  };
  /** A verb: an icon and its name, in a row. */
  const verb = (label: string, on: boolean, run: () => void, iconHtml: string, danger = false): HTMLButtonElement => {
    const b = button(`v2-verb${on ? ' on' : ''}${danger ? ' danger' : ''}`, label, run, iconHtml);
    return b;
  };
  const section = (label: string, kind: 'cards' | 'verbs' = 'cards'): { box: HTMLElement; items: HTMLElement } => {
    const box = el('div', `v2-section ${kind}`);
    box.appendChild(el('div', 'v2-section-title', label));
    const items = el('div', 'v2-section-items');
    box.appendChild(items);
    strip.appendChild(box);
    return { box, items };
  };
  /** What a tool does: in the tooltip of its drawer, never as a paragraph. */
  const note = (text: string): void => {
    drawer.setAttribute('aria-description', text);
  };

  // ------------------------------------------------------------ roads
  function renderRoads(current: string): void {
    title.textContent = t('tool.road');
    const modes: [string, string, string][] = [['road', t('tool.draw'), 'draw'], ['upgrade', t('tool.upgrade'), 'upgrade'], ['move', t('tool.move'), 'move'], ['split', t('tool.split'), 'split'], ['control', t('tool.control'), 'control']];
    if (q('[data-road-op="roundabout"]')) modes.push(['roundabout', t('tool.roundabout'), 'roundabout']);
    for (const [id, label, icon] of modes) {
      tabs.appendChild(tab(label, current === id, () => {
        if (id === 'road') press('.tool[data-tool="road"]');
        else press(`[data-road-op="${id}"]`);
        render();
      }, false, svg(icon, 18)));
    }
    if (current === 'road') {
      const trace = group(t('palette.trace'));
      trace.appendChild(choices([...document.querySelectorAll<HTMLButtonElement>('.alignment-mode')].map((b) => ({
        label: b.textContent?.trim() ?? '',
        on: b.classList.contains('active'),
        run: () => { b.click(); render(); },
        icon: svg(b.dataset['alignment'] ?? 'straight', 18),
      }))));
      // Snapping, as Cities: Skylines II offers it: all of it, then each kind.
      const snap = roadSnap();
      const snapping = group(t('v2.snap.title'));
      snapping.appendChild(choices([
        { label: t('v2.snap.on'), on: snap.on, run: () => { setRoadSnap({ on: !snap.on }); render(); }, icon: svg('magnet', 18) },
        { label: t('v2.snap.angles'), on: snap.on && snap.angles, run: () => { setRoadSnap({ angles: !snap.angles }); render(); }, disabled: !snap.on, icon: svg('angle', 18) },
        { label: t('v2.snap.grid'), on: snap.on && snap.grid, run: () => { setRoadSnap({ grid: !snap.grid }); render(); }, disabled: !snap.on, icon: svg('grid', 18) },
      ]));
      // The grid itself, drawn on the ground while the road is laid.
      const gridGroup = titled(group(t('v2.roadGrid')), t('v2.roadGrid'));
      gridGroup.appendChild(choices([
        { label: t('v2.roadGrid.show'), on: roadGridShown(), run: () => { setRoadGridShown(true); if (!snap.on || !snap.grid) setRoadSnap({ on: true, grid: true }); render(); } },
        { label: t('v2.roadGrid.hide'), on: !roadGridShown(), run: () => { setRoadGridShown(false); render(); } },
      ], 2));
      // Parking the new road is drawn with (`editor/roadParking.ts`).
      const parking = group(t('palette.parking'));
      const parkingNow = roadParkingPreset();
      parking.appendChild(choices(ROAD_PARKING_PRESETS.map((preset) => ({
        label: t(`parking.preset.${preset}`),
        on: parkingNow === preset,
        run: () => { setRoadParkingPreset(preset); render(); },
        icon: svg(`park-${preset}`, 18),
      }))));
      const height = group(`${t('palette.height')} - ${q('#roadHeightContext')?.textContent ?? ''}`);
      const stepper = el('div', 'v2-stepper');
      stepper.append(
        button('v2-icon', t('palette.height.lower'), () => { press('[data-height-step="-1"]'); render(); }, svg('minus', 14)),
        el('output', 'v2-stepper-value', q('#roadHeightValue')?.textContent ?? ''),
        button('v2-icon', t('palette.height.raise'), () => { press('[data-height-step="1"]'); render(); }, svg('plus', 14)),
      );
      height.append(stepper);
      const lanes = group(t('palette.lanes'));
      lanes.appendChild(choices([...document.querySelectorAll<HTMLButtonElement>('[data-lane-choice]')].filter((b) => !b.hidden).map((b) => {
        const id = b.dataset['laneChoice'] ?? '2';
        return {
          label: b.getAttribute('aria-label') ?? b.title ?? b.textContent?.trim() ?? '',
          on: b.classList.contains('active'),
          run: () => { b.click(); render(); },
          disabled: b.disabled,
          icon: svg(id === 'median' ? 'median' : `lanes${id}`, 18),
        };
      })));
      // Total width, on the 1 m subgrid of the 10 m zoning grid.
      const widthGroup = group(t('palette.width'));
      const w = roadWidth();
      const widthStepper = el('div', 'v2-stepper');
      const stepWidth = (d: number): void => { setRoadWidth((roadWidth() ?? defaultRoadWidth()) + d); render(); };
      widthStepper.append(
        button('v2-icon', t('palette.width.narrower'), () => stepWidth(-1), svg('minus', 14)),
        el('output', 'v2-stepper-value', `${t('palette.width.short')}: ${w === null ? t('palette.width.auto') : `${w} m`}`),
        button('v2-icon', t('palette.width.wider'), () => stepWidth(1), svg('plus', 14)),
      );
      widthGroup.append(widthStepper);
      if (w !== null) widthGroup.appendChild(button('v2-choice', t('palette.width.auto'), () => { setRoadWidth(null); render(); }));
      // Several blocks at once (`editor/blocks.ts`): columns, rows, spacing.
      const blocks = group(t('palette.blocks'));
      blocks.classList.add('stack');
      const g = blockGridChoice;
      const stepRow = (label: string, value: string, run: (d: number) => void): HTMLElement => {
        const row = el('div', 'v2-stepper');
        row.title = label;
        row.append(
          button('v2-icon', `${label} -`, () => { run(-1); render(); }, svg('minus', 14)),
          el('output', 'v2-stepper-value', value),
          button('v2-icon', `${label} +`, () => { run(1); render(); }, svg('plus', 14)),
        );
        return row;
      };
      blocks.append(
        el('span', 'v2-group-title', t('palette.blocks')),
        stepRow(t('palette.blocks.cols'), `${g.cols} ${t('palette.blocks.colsShort')}`, (d) => { g.cols = Math.max(1, Math.min(12, g.cols + d)); }),
        stepRow(t('palette.blocks.rows'), `${g.rows} ${t('palette.blocks.rowsShort')}`, (d) => { g.rows = Math.max(1, Math.min(12, g.rows + d)); }),
        stepRow(t('palette.blocks.size'), `${t('palette.blocks.size')}: ${g.blockMetres} m`, (d) => { g.blockMetres = Math.max(30, Math.min(300, g.blockMetres + d * 10)); }),
        stepRow(t('palette.blocks.angle'), `${t('palette.blocks.angle')}: ${Math.round((g.angle * 180) / Math.PI)}°`, (d) => { g.angle += (d * 15 * Math.PI) / 180; }),
        button('v2-choice' + (g.armed ? ' on' : ''), g.armed ? t('palette.blocks.armed') : t('palette.blocks.place'), () => { g.armed = !g.armed; render(); }),
      );
      titled(trace, t('palette.trace')); titled(snapping, t('v2.snap.title')); titled(parking, t('palette.parking'));
      titled(height, t('palette.height')); titled(lanes, t('palette.lanes')); titled(widthGroup, t('palette.width'));
      options.append(trace, snapping, gridGroup, lanes, widthGroup, height, parking, blocks);
    }
    if (current === 'road' || current === 'upgrade') {
      const { items } = section(t('palette.kind'));
      for (const b of document.querySelectorAll<HTMLButtonElement>('.road-type[data-type-index]')) {
        const img = b.querySelector('img')?.getAttribute('src') ?? undefined;
        items.appendChild(card(b.querySelector('.road-type-name')?.textContent ?? '', b.classList.contains('active'), () => { b.click(); render(); }, img, undefined, 'wide'));
      }
    } else if (current === 'roundabout') {
      const source = q<HTMLInputElement>('.road-palette .inspect-range input');
      if (source) {
        const g = group(t('road.roundabout.radius'));
        const input = el('input');
        input.type = 'range';
        input.min = source.min;
        input.max = source.max;
        input.step = source.step;
        input.value = source.value;
        const out = el('output', 'v2-slider-out', `${source.value} m`);
        input.oninput = () => { setInput('.road-palette .inspect-range input', input.value); out.textContent = `${input.value} m`; };
        const wrap = el('div', 'v2-slider');
        wrap.append(input, out);
        g.appendChild(wrap);
        options.appendChild(g);
      }
      note(t('hint.roundabout'));
    } else {
      note(t(`hint.${current}`));
    }
  }

  // ------------------------------------------------------------ zones
  /** The shape the Create lot tool draws (`data-zone-mode`): a dragged rectangle or a polygon point by point. */
  let lotShape: 'add' | 'polygon' = 'add';
  function renderZones(): void {
    title.textContent = t('tool.zone');
    const active = (selector: string): boolean => q<HTMLButtonElement>(selector)?.classList.contains('active') ?? false;
    const pick = (selector: string): void => { q<HTMLButtonElement>(selector)?.click(); };
    // The lots first: made, then shaped, then given a front, cut, joined or
    // deleted (`world/lots.ts`). Creating one is one tool whatever its shape.
    const lots = section(t('zone.lots'), 'verbs');
    const creating = active('[data-zone-mode="add"]') || active('[data-zone-mode="polygon"]');
    lots.items.appendChild(verb(t('zone.lot.create'), creating, () => { pick(`[data-zone-mode="${lotShape}"]`); render(); }, svg(lotShape === 'add' ? 'plus' : 'lotPolygon', 20)));
    for (const [mode, icon] of [['edit', 'lotEdit'], ['curve', 'lotCurve'], ['front', 'lotFront'], ['split', 'split'], ['join', 'join'], ['delete', 'lotDelete']] as const) {
      lots.items.appendChild(verb(t(`zone.lot.${mode}`), active(`[data-zone-mode="${mode}"]`), () => { pick(`[data-zone-mode="${mode}"]`); render(); }, svg(icon, 20), mode === 'delete'));
    }
    // The shape of the lot being created - shown while creating.
    if (creating) {
      const shape = titled(group(t('zone.lot.shape')), t('zone.lot.shape'));
      shape.appendChild(choices((['add', 'polygon'] as const).map((kind) => ({
        label: t(kind === 'add' ? 'zone.lot.shape.rect' : 'zone.lot.shape.polygon'),
        on: active(`[data-zone-mode="${kind}"]`),
        run: () => { lotShape = kind; pick(`[data-zone-mode="${kind}"]`); render(); },
        icon: svg(kind === 'add' ? 'plus' : 'lotPolygon', 18),
      })), 2));
      options.appendChild(shape);
    }
    // How the split tool cuts, and into how many - shown while it is chosen.
    if (q<HTMLButtonElement>('[data-zone-mode="split"]')?.classList.contains('active')) {
      const how = titled(group(t('zone.split.how')), t('zone.split.how'));
      how.appendChild(choices((['vertical', 'horizontal', 'line'] as const).map((kind) => {
        const b = q<HTMLButtonElement>(`[data-lot-split="${kind}"]`);
        return { label: t(`zone.split.${kind}`), on: b?.classList.contains('active') ?? false, run: () => { b?.click(); render(); } };
      }), 3));
      options.appendChild(how);
      if (!q<HTMLButtonElement>('[data-lot-split="line"]')?.classList.contains('active')) {
        const parts = titled(group(t('zone.split.into')), t('zone.split.into'));
        parts.appendChild(choices([2, 3, 4, 5, 6].map((n) => {
          const b = q<HTMLButtonElement>(`[data-lot-parts="${n}"]`);
          return { label: String(n), on: b?.classList.contains('active') ?? false, run: () => { b?.click(); render(); } };
        }), 5));
        options.appendChild(parts);
      }
    }
    // Then the zoning of the lots: painted on, or taken off.
    const paint = section(t('v2.zone.paint'), 'verbs');
    const brush = active('[data-zone-mode="brush"]'), erasing = active('#zoneRemove');
    paint.items.appendChild(verb(t('zone.brush'), brush && !erasing, () => { pick('[data-zone-mode="brush"]'); if (erasing) pick('#zoneRemove'); render(); }, svg('brush', 20)));
    paint.items.appendChild(verb(t('zone.remove'), brush && erasing, () => { pick('[data-zone-mode="brush"]'); if (!erasing) pick('#zoneRemove'); render(); }, svg('eraser', 20), true));
    note(t('zone.lots.help'));
    const use = section(t('v2.zone.use'));
    for (const [key, colour] of [['residential', '#58c26f'], ['commercial', '#4aa3e8'], ['industrial', '#e6b84a']] as const) {
      const b = q<HTMLButtonElement>(`[data-zone-use="${key}"]`);
      const c = card(t(`zone.${key}`), b?.classList.contains('active') ?? false, () => { b?.click(); render(); }, undefined, `<i class="v2-zone-swatch" style="--zone:${colour}"></i>`);
      use.items.appendChild(c);
    }
    const density = titled(group(t('v2.zone.density')), t('v2.zone.density'));
    density.appendChild(choices((['low', 'medium', 'high'] as const).map((key) => {
      const b = q<HTMLButtonElement>(`[data-zone-density="${key}"]`);
      return { label: `${t('v2.zone.density')}: ${t(`zone.${key}`)}`, on: b?.classList.contains('active') ?? false, run: () => { b?.click(); render(); }, icon: svg(key, 18) };
    })));
    options.appendChild(density);
    // The colours of zoned land outside this tool: shown or hidden.
    const colours = titled(group(t('zone.colours')), t('zone.colours'));
    colours.appendChild(choices([
      { label: t('zone.colours.show'), on: zoneColoursShown(), run: () => { setZoneColoursShown(true); render(); } },
      { label: t('zone.colours.hide'), on: !zoneColoursShown(), run: () => { setZoneColoursShown(false); render(); } },
    ], 2));
    options.appendChild(colours);
  }

  // ------------------------------------------------------------ landscape
  function renderLandscape(current: string): void {
    title.textContent = t('v2.cat.landscape');
    landTab = current === 'barrier' ? 'barrier' : current === 'pole' ? 'pole' : current === 'streetscape' ? 'streetscape' : 'terrain';
    for (const [id, label, icon] of [['terrain', t('tool.terrain'), 'terrain'], ['streetscape', t('tool.streetscape'), 'streetscape'], ['barrier', t('v2.land.walls'), 'walls'], ['pole', t('tool.pole'), 'poles']] as const) {
      tabs.appendChild(tab(label, landTab === id, () => { press(`.tool[data-tool="${id}"]`); render(); }, false, svg(icon, 18)));
    }
    if (landTab === 'terrain') {
      const { items } = section(t('v2.terrain.brush'));
      for (const [mode, icon] of [['raise', 'raise'], ['lower', 'lower'], ['flatten', 'flatten'], ['river', 'river'], ['paint', 'paint'], ['fog', 'fog'], ['cloud', 'cloud'], ['elements', 'ls_meadow']] as const) {
        const b = q<HTMLButtonElement>(`[data-terrain-mode="${mode}"]`);
        items.appendChild(card(t(`terrain.${mode}`), b?.classList.contains('active') ?? false, () => { b?.click(); render(); }, undefined, svg(icon, 34)));
      }
      // Landforms: each a shape with its own rock (`main.ts` LANDFORMS).
      const forms = section(t('v2.terrain.landforms')).items;
      for (const mode of ['mesa', 'canyon', 'escarpment', 'sugarloaf'] as const) {
        const b = q<HTMLButtonElement>(`[data-terrain-mode="${mode}"]`);
        forms.appendChild(card(t(`terrain.${mode}`), b?.classList.contains('active') ?? false, () => { b?.click(); render(); }, undefined, svg(mode, 34)));
      }
      // Painting: which ground the brush lays (`world/terrainPaint.ts`).
      if (q<HTMLButtonElement>('[data-terrain-mode="paint"]')?.classList.contains('active')) {
        // Named, so its nine swatches wrap under the name instead of running off the panel.
        const grounds = titled(group(t('paint.kind')), t('paint.kind'));
        const now = paintKind();
        const swatchOf = (kind: PaintKind): string => `<svg viewBox="0 0 16 16" width="20" height="20"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${PAINT_SWATCH[kind]}" stroke="currentColor" stroke-opacity="0.45"/></svg>`;
        // The biomes on a row of their own: each one is a whole country.
        const biomes = titled(group(t('paint.biome')), t('paint.biome'));
        biomes.appendChild(choices(BIOME_SWATCHES.map((kind) => ({
          label: t(`paint.kind.${kind}`), on: now === kind, run: () => { setPaintKind(kind); render(); }, icon: swatchOf(kind),
        })), 6));
        grounds.appendChild(choices(PAINT_KINDS.filter((kind) => !(BIOME_SWATCHES as readonly string[]).includes(kind)).map((kind) => ({
          label: t(`paint.kind.${kind}`),
          on: now === kind,
          run: () => { setPaintKind(kind); render(); },
          icon: `<svg viewBox="0 0 16 16" width="20" height="20"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${PAINT_SWATCH[kind]}" stroke="currentColor" stroke-opacity="0.45"/></svg>`,
        })), 8));
        options.appendChild(grounds);
        options.appendChild(biomes);
      }
      // The fog brush: lay mist or take it away, and how the map's fog
      // looks - how thick, how high, how fast it drifts (`world/fogPaint.ts`).
      if (q<HTMLButtonElement>('[data-terrain-mode="fog"]')?.classList.contains('active')) {
        // The brush: what the next strokes lay, each bank keeping its own.
        const fog = titled(group(t('fog.brush')), t('fog.brush'));
        fog.classList.add('stack');
        fog.appendChild(choices([
          { label: t('fog.lay'), on: !fogErase(), run: () => { setFogErase(false); render(); }, icon: svg('brush', 18) },
          { label: t('fog.erase'), on: fogErase(), run: () => { setFogErase(true); render(); }, icon: svg('eraser', 18) },
        ], 2));
        fog.append(
          slider(t('terrain.radius'), '#terrainRadius', '#terrainRadiusValue'),
          slider(t('fog.strength'), '#fogStrength', '#fogStrengthValue'),
          slider(t('fog.height'), '#fogHeight', '#fogHeightValue'),
          slider(t('fog.speed'), '#fogSpeed', '#fogSpeedValue'),
        );
        options.appendChild(fog);
        // The map's: over every bank at once.
        const all = titled(group(t('fog.map')), t('fog.map'));
        all.classList.add('stack');
        all.appendChild(slider(t('fog.mapDensity'), '#fogMapDensity', '#fogMapDensityValue'));
        all.appendChild(button('v2-icon danger', t('fog.clear'), () => press('#clearFog'), svg('eraser', 16)));
        options.appendChild(all);
      }
      // The element brush (`world/elements.ts`): what it lays - ground,
      // plants or effects - whether it lays or erases, and that kind's settings.
      const elementsActive = q<HTMLButtonElement>('[data-terrain-mode="elements"]')?.classList.contains('active') ?? false;
      if (elementsActive) {
        const now = elementKind();
        const kinds = (title: string, list: readonly ElementKind[]): void => {
          const g = titled(group(title), title);
          g.appendChild(choices(list.map((kind) => ({ label: t(`el.kind.${kind}`), on: now === kind, run: () => { setElementKind(kind); render(); } })), 3));
          options.appendChild(g);
        };
        kinds(t('el.ground'), ['stones', 'pebbles', 'gravel', 'leaves']);
        kinds(t('el.plants'), ['grass', 'tallGrass', 'scrub', 'fern', 'clover', 'flowers', 'mushrooms']);
        kinds(t('el.effects'), [...EFFECT_KINDS]);
        const brush = titled(group(t('el.brush')), t('el.brush'));
        brush.classList.add('stack');
        brush.appendChild(choices((['lay', 'eraseKind', 'eraseAll'] as const).map((mode) => ({
          label: t(`el.mode.${mode}`), on: elementMode() === mode, run: () => { setElementMode(mode); render(); },
        })), 3));
        brush.append(
          slider(t('terrain.radius'), '#terrainRadius', '#terrainRadiusValue'),
          slider(t('el.density'), '#elDensity', '#elDensityValue'),
          slider(t('el.size'), '#elSize', '#elSizeValue'),
          slider(t('el.variation'), '#elVariation', '#elVariationValue'),
          slider(t('el.spacing'), '#elSpacing', '#elSpacingValue'),
          slider(t('el.strength'), '#elStrength', '#elStrengthValue'),
        );
        if ((EFFECT_KINDS as readonly string[]).includes(now)) brush.appendChild(slider(t('el.intensity'), '#elIntensity', '#elIntensityValue'));
        brush.appendChild(button('v2-icon danger', t('el.clear'), () => press('#clearElements'), svg('eraser', 16)));
        options.appendChild(brush);
        return;
      }
      // The cloud tool: put clouds in the sky, move them, set them to the
      // tool's size, height and density, or take them away (`world/clouds.ts`).
      const cloudActive = q<HTMLButtonElement>('[data-terrain-mode="cloud"]')?.classList.contains('active') ?? false;
      if (cloudActive) {
        const tool = titled(group(t('cloud.title')), t('cloud.title'));
        tool.classList.add('stack');
        const icons: Record<(typeof CLOUD_MODES)[number], string> = { add: 'plus', move: 'move', edit: 'draw', remove: 'eraser' };
        tool.appendChild(choices(CLOUD_MODES.map((mode) => ({
          label: t(`cloud.${mode}`), on: cloudMode() === mode, run: () => { setCloudMode(mode); render(); }, icon: svg(icons[mode], 18),
        })), 4));
        tool.append(
          slider(t('cloud.size'), '#cloudSize', '#cloudSizeValue'),
          slider(t('cloud.height'), '#cloudHeight', '#cloudHeightValue'),
          slider(t('cloud.density'), '#cloudDensity', '#cloudDensityValue'),
        );
        tool.appendChild(button('v2-icon danger', t('cloud.clear'), () => press('#clearClouds'), svg('eraser', 16)));
        options.appendChild(tool);
      }
      // The sky - clouds and the haze over the whole map - with the weather
      // tools only, named: shown under every terrain brush it was clutter
      // (the player, 2026-10-07). No planet radius: the planet is off.
      const fogActive = q<HTMLButtonElement>('[data-terrain-mode="fog"]')?.classList.contains('active') ?? false;
      if (fogActive || cloudActive) {
        const sky = titled(group(t('atmo.title')), t('atmo.title'));
        sky.classList.add('stack');
        sky.append(
          slider(t('atmo.clouds'), '#atmoClouds', '#atmoCloudsValue'),
          slider(t('atmo.cloudBase'), '#atmoCloudBase', '#atmoCloudBaseValue'),
          slider(t('atmo.cloudThickness'), '#atmoCloudThickness', '#atmoCloudThicknessValue'),
          slider(t('atmo.fog'), '#atmoFog', '#atmoFogValue'),
          slider(t('atmo.fogHeight'), '#atmoFogHeight', '#atmoFogHeightValue'),
        );
        options.appendChild(sky);
      }
      // The map's own biome - the ecosystem everywhere nothing else is
      // painted - with the paint brush only.
      if (q<HTMLButtonElement>('[data-terrain-mode="paint"]')?.classList.contains('active')) {
        const mapBiome = titled(group(t('terrain.mapBiome')), t('terrain.mapBiome'));
        mapBiome.appendChild(choices([...document.querySelectorAll<HTMLButtonElement>('[data-map-biome]')].map((b) => {
          const key = b.dataset['mapBiome'] as string;
          return {
            label: key === 'none' ? t('terrain.mapBiome.none') : t(`paint.kind.${key}`),
            on: b.getAttribute('aria-pressed') === 'true',
            run: () => { b.click(); render(); },
            icon: key === 'none'
              ? '<svg viewBox="0 0 16 16" width="20" height="20"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" stroke-opacity="0.6"/><path d="M4 12 12 4" stroke="currentColor" stroke-opacity="0.6"/></svg>'
              : `<svg viewBox="0 0 16 16" width="20" height="20"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${PAINT_SWATCH[key as PaintKind]}" stroke="currentColor" stroke-opacity="0.45"/></svg>`,
          };
        }), 7));
        options.appendChild(mapBiome);
      }
      // Named too: the two sliders and the clear button ran off the panel's edge.
      // Not under the fog brush or the cloud tool, which have their own.
      if (fogActive || cloudActive) return;
      const brush = titled(group(t('v2.options')), t('v2.options'));
      brush.append(slider(t('terrain.radius'), '#terrainRadius', '#terrainRadiusValue', svg('radius', 16)), slider(t('terrain.strength'), '#terrainStrength', '#terrainStrengthValue', svg('strength', 16)),
        slider(t('terrain.hardness'), '#terrainHardness', '#terrainHardnessValue', svg('flatten', 16)));
      brush.appendChild(button('v2-icon danger', t('terrain.clear'), () => press('#clearTerrain'), svg('flatten', 16)));
      options.append(brush);
    } else if (landTab === 'barrier') {
      const { items } = section(t('v2.land.walls'));
      for (const b of document.querySelectorAll<HTMLButtonElement>('.tool-help-kinds [data-barrier]')) {
        items.appendChild(card(b.textContent ?? '', b.classList.contains('active'), () => { b.click(); render(); }, undefined, (b.dataset['barrier'] === 'guardrail' || b.dataset['barrier'] === 'railing' ? svg(b.dataset['barrier'], 34) : builderIconSvg(b.dataset['barrier'] === 'hedge' ? 'hedge' : b.dataset['barrier'] === 'wall' ? 'wallRun' : 'fenceRun', 34))));
      }
      note(t('help.tool.barrier'));
    } else if (landTab === 'streetscape') {
      // What the next click puts on the footway (`world/landscape.ts`).
      const { items } = section(t('tool.streetscape'));
      const now = streetscapeKind();
      for (const kind of LANDSCAPE_KINDS) {
        items.appendChild(card(t(`streetscape.${kind}`), now === kind, () => { setStreetscapeKind(kind); render(); }, undefined, svg(`ls_${kind}`, 34)));
      }
      // The sign tool: which sign, and the words on those that carry them.
      if (now === 'sign') {
        const kinds = group(t('sign.type'));
        kinds.classList.add('stack');
        kinds.appendChild(choices(SIGN_TYPES.map((type) => ({
          label: t(`sign.type.${type}`), on: signChoice.type === type, run: () => { signChoice.type = type; render(); },
        })), 2));
        if (SIGN_HAS_TEXT.has(signChoice.type)) {
          const input = el('input', 'v2-search');
          input.type = 'text';
          input.maxLength = SIGN_TEXT_MAX;
          input.placeholder = t(signChoice.type === 'speed' ? 'sign.text.speed' : 'sign.text');
          input.value = signChoice.text;
          input.oninput = () => { signChoice.text = input.value; };
          kinds.appendChild(input);
        }
        options.appendChild(kinds);
      } else if (now === 'streetname') {
        const named = group(t('streetscape.streetname'));
        named.classList.add('stack');
        const input = el('input', 'v2-search');
        input.type = 'text';
        input.maxLength = SIGN_TEXT_MAX;
        input.placeholder = t('sign.street.placeholder');
        input.value = signChoice.streetName;
        input.oninput = () => { signChoice.streetName = input.value; };
        named.appendChild(input);
        options.appendChild(named);
      }
      note(t('help.tool.streetscape'));
    } else {
      // What a click does: string a line, or take a pole down (with its wires).
      const { items } = section(t('tool.pole'));
      const mode = poleToolMode();
      for (const next of POLE_TOOL_MODES) {
        items.appendChild(card(t(`pole.mode.${next}`), mode === next, () => { setPoleToolMode(next); render(); }, undefined, svg(`pole_${next}`, 34)));
      }
      if (mode === 'remove') {
        note(t('help.tool.poleRemove'));
        return;
      }
      // Street lights on the poles of the next run.
      const lamps = group(t('pole.lamps'));
      const now = poleLampMode();
      lamps.appendChild(choices(POLE_LAMP_MODES.map((mode) => ({
        label: t(`pole.lamps.${mode}`),
        on: now === mode,
        run: () => { setPoleLampMode(mode); render(); },
        icon: svg(`pl_${mode}`, 18),
      }))));
      options.appendChild(lamps);
      note(t('help.tool.pole'));
    }
  }

  // ------------------------------------------------------------ public transport
  function renderTransit(): void {
    title.textContent = t('tool.transit');
    const tool2 = transitTool();
    if (!tool2) return;
    const kinds: [TransitToolKind, 'train' | 'metro' | undefined, string, string][] = [
      ['stop', undefined, t('transit.tool.stop'), 'tr_stop'],
      ['terminal', undefined, t('transit.tool.terminal'), 'tr_terminal'],
      ['track', 'train', t('transit.tool.trainTrack'), 'tr_track'],
      ['station', 'train', t('transit.tool.trainStation'), 'tr_station'],
      ['track', 'metro', t('transit.tool.metroTrack'), 'tr_metro'],
      ['station', 'metro', t('transit.tool.metroStation'), 'tr_station'],
      ['line', undefined, t('transit.tool.line'), 'tr_line'],
    ];
    for (const [kind, rail, label, icon] of kinds) {
      const on = tool2.kind === kind && (rail === undefined || tool2.rail === rail);
      tabs.appendChild(tab(label, on, () => { tool2.setKind(kind, rail); render(); }, false, svg(icon, 18)));
    }
    // The lines: their colour and name, how many vehicles, and away.
    const lines = tool2.lines();
    const { items } = section(t('transit.lines'));
    if (lines.length === 0) note(t('transit.noLines'));
    for (const line of lines) {
      const row = el('div', 'v2-transit-line');
      row.innerHTML = `<i style="background:${line.colour}"></i><b>${line.name}</b><span>${t(`transit.mode.${line.mode}`)} · ${t('transit.stops', { n: line.stops.length })}</span>`;
      const less = button('v2-icon', t('transit.fewer'), () => { tool2.setVehicles(line.id, line.vehicles - 1); render(); }, '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 12h12"/></svg>');
      const count = el('span', 'v2-transit-count');
      count.textContent = String(line.vehicles);
      count.title = t('transit.vehicles');
      const more = button('v2-icon', t('transit.more'), () => { tool2.setVehicles(line.id, line.vehicles + 1); render(); }, '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 12h12M12 6v12"/></svg>');
      const drop = button('v2-icon danger', t('transit.remove'), () => { tool2.removeLine(line.id); render(); }, svg('demolish', 14));
      row.append(less, count, more, drop);
      items.appendChild(row);
    }
    note(t(`help.transit.${tool2.kind}`));
  }

  // ------------------------------------------------------------ simple tools
  function renderSimple(current: string): void {
    title.textContent = t(`tool.${current}`);
    if (current === 'bulldoze') {
      // Demolish knocks down at once; the bomb (from the Actions) strikes
      // with a force, things breaking piece by piece.
      if (strikeChoice.mode === 'shoot') title.textContent = t('actions.pistol');
      if (strikeChoice.mode === 'strike') {
        title.textContent = t('actions.bomb');
        const force = group(t('strike.force'));
        const row = el('div', 'v2-stepper');
        row.append(
          button('v2-icon', t('strike.force.less'), () => { strikeChoice.strength = Math.max(1, strikeChoice.strength - (strikeChoice.strength > 10 ? 5 : 1)); render(); }, svg('minus', 14)),
          el('output', 'v2-stepper-value', `${t('strike.force')}: ${strikeChoice.strength}`),
          button('v2-icon', t('strike.force.more'), () => { strikeChoice.strength = Math.min(50, strikeChoice.strength + (strikeChoice.strength >= 10 ? 5 : 1)); render(); }, svg('plus', 14)),
        );
        force.appendChild(row);
        options.appendChild(force);
      }
    }
    note(t(`help.tool.${current}`));
  }

  // ------------------------------------------------------------ construction
  const picture = (id: string): string | undefined => {
    const shape = DRAW_SHAPES[id] ?? TIER_SHAPES[id];
    return workspace.thumbnail(id) ?? (shape ? planSwatch(shape) : undefined);
  };
  const ask = (ids: readonly string[]): void => {
    const wanted = ids.filter((id) => !requested.has(id) && !workspace.thumbnail(id));
    for (const id of wanted) requested.add(id);
    if (wanted.length) actions.requestThumbnails(wanted);
  };
  const THINGS = new Set<string>([...FACADE_PATTERNS, 'window', 'sashWindow', 'wideWindow', 'ribbon', 'bayWindow', 'frenchWindow',
    'door', 'doubleDoor', 'garageDoor', 'loadingDoor', 'balcony', 'shopfront', 'roofFlat', 'roofShed', 'roofGable', 'roofHip',
    'roofSawtooth', 'roofTerrace', 'solar', 'skylight', 'vent', 'chimney', 'waterTank', 'spire', 'lantern', 'stair', 'ramp', 'pillar',
    'canopy', 'wall', 'slab', 'wallRun', 'fenceRun', 'pavementRun', 'railing', 'stairRun', 'tree', 'shrub', 'hedge', 'flowers', 'rocks',
    'bench', 'planter', 'parking', 'ac', 'awning', 'clock']);

  function renderBuild(): void {
    title.textContent = t('tool.building');
    const state = builder;
    if (!state) return;
    const selected = state.selection !== null;


    const createTabs: BuilderCategoryId[] = ['models', 'draw'];
    const editTabs: BuilderCategoryId[] = ['mass', 'facade', 'roof', 'parts', 'interior', 'paint'];
    const visible = selected ? [...createTabs, ...editTabs] : [...createTabs, 'paint' as const];
    for (const id of visible) {
      const label = id === 'mass' ? t('v2.build.shape') : t(`builder.category.${id}`);
      const icon = ({ models: 'models', draw: 'draw', mass: 'mass', facade: 'face', roof: 'roof', parts: 'components', interior: 'interiorView', paint: 'paint' } as Record<string, string>)[id] ?? 'models';
      tabs.appendChild(tab(label, state.category === id, () => actions.setCategory(id), false, builderIconSvg(icon, 18)));
    }
    if (!selected) tabs.title = t('v2.build.selectToEdit');

    // The pointer's switches, in the head.
    if (selected) {
      const floor = el('select', 'v2-mini');
      floor.title = t('builder.floor.title');
      for (let i = 0; i < Math.max(1, state.floor.total); i++) {
        const o = el('option', '', `${t('v2.build.floor')} ${i + 1}`);
        o.value = String(i);
        o.selected = i === state.floor.active;
        floor.appendChild(o);
      }
      floor.onchange = () => actions.setFloor(Number(floor.value));
      tools.appendChild(floor);
    }
    const snap = el('select', 'v2-mini');
    snap.title = t('builder.snap.label');
    for (const s of SNAP_MODES) {
      const o = el('option', '', `${t('builder.snap.label')}: ${t(`builder.snap.${s}`)}`);
      o.value = s;
      o.selected = s === state.snap;
      snap.appendChild(o);
    }
    snap.onchange = () => actions.setSnap(snap.value);
    const grid = button('v2-icon' + (state.grid ? ' on' : ''), t('builder.grid'), () => actions.toggleGrid(), svg('grid', 17));
    const hide = button('v2-icon' + (state.hideOthers ? ' on' : ''), t('builder.hideOthers'), () => actions.toggleHideOthers(), svg('hide', 17));
    tools.append(snap, grid, hide);
    if (selected) tools.appendChild(button('v2-icon', t('builder.view.frame'), () => actions.view('frame'), svg('frame', 17)));

    if (state.planning) {
      const plan = group(t('v2.build.plan'));
plan.appendChild(choices([
        { label: t('builder.plan.finish'), on: true, run: () => actions.planFinish(), disabled: state.planPoints < 3, icon: svg('check', 18) },
        { label: t('builder.plan.back'), on: false, run: () => actions.planBack(), icon: svg('undo', 18) },
        { label: t('builder.plan.cancel'), on: false, run: () => actions.planCancel(), icon: svg('close', 18) },
      ]));
      options.appendChild(plan);
    }

    const spec = BUILDER_TAB_SPECS.find((s) => s.id === state.category);
    if (!spec) return;
    if (spec.needsSelection && !selected) {
      note(t('builder.needsSelection'));
      return;
    }
    const sections = spec.sections.filter((s) => !s.advanced || advanced);
    const wantPictures: string[] = [];
    for (const s of sections) {
      for (const x of s.tools ?? []) wantPictures.push(x.id);
      if (s.shelf === 'models') wantPictures.push(...CITY_BUILDINGS.map((c) => `city:${c.fn}`), ...BLUEPRINTS.map((b) => b.key), ...state.userBlueprints.map((b) => b.key));
      if (s.shelf === 'patterns') wantPictures.push(...FACADE_PATTERNS);
    }
    ask(wantPictures);
    for (const s of sections) renderSection(s, state);
    if (spec.sections.some((s) => s.advanced)) {
      const count = spec.sections.filter((s) => s.advanced).reduce((n, s) => n + (s.tools?.length ?? 0), 0);
      const adv = group(advanced ? t('builder.advanced.on') : `${t('builder.advanced.off')} (${count})`);
      adv.appendChild(choices([{ label: advanced ? t('builder.advanced.on') : `${t('builder.advanced.off')} (${count})`, on: advanced, icon: svg('advanced', 18), run: () => {
        advanced = !advanced;
        try { window.localStorage.setItem('roadcraft.builder.advanced', advanced ? '1' : '0'); } catch { /* not kept */ }
        render();
      } }]));
      options.appendChild(adv);
    }
  }

  function renderSection(s: BuilderSection, state: BuilderState): void {
    const label = s.title ? t(`builder.section.${s.title}`) : '';
    if (s.shelf === 'models') return renderModels(state);
    if (s.shelf === 'scope') {
      const g = group(label);
      g.appendChild(choices(FACADE_SCOPES.map((scope) => ({ label: t(`creator.dock.scope.${scope}`), on: state.scope === scope, run: () => actions.setScope(scope), icon: svg(`scope_${scope}`, 18) }))));
      options.appendChild(g);
      return;
    }
    if (s.shelf === 'drawAction') {
      const g = group(label);
      const drawIcon = { new: 'addVolume', ground: 'wing', top: 'stack', cut: 'cut' } as const;
      g.appendChild(choices(DRAW_ACTIONS.map((a) => ({ label: t(`builder.drawAction.${a}`), on: state.drawAction === a, run: () => actions.setDrawAction(a), disabled: a !== 'new' && !state.selection, icon: builderIconSvg(drawIcon[a], 18) }))));
      options.appendChild(g);
      return;
    }
    if (s.shelf === 'roofParams') {
      const roof = state.roof;
      const g = group(t('builder.field.pitch'));
      const stepper = el('div', 'v2-stepper');
      stepper.append(
        button('v2-icon', '−5°', () => actions.roofPitch(-5), svg('minus', 16)),
        el('output', 'v2-stepper-value', `${roof?.pitch ?? 30}°`),
        button('v2-icon', '+5°', () => actions.roofPitch(5), svg('plus', 16)),
      );
      g.appendChild(stepper);
      options.appendChild(g);
      if (roof?.pitched) {
        const ridge = group(t('builder.roof.ridge.label'));
        ridge.appendChild(choices((['x', 'y'] as const).map((r) => ({ label: t(`builder.roof.ridge.${r}`), on: roof.ridge === r, run: () => actions.roofRidge(r), icon: svg(`ridge_${r}`, 18) }))));
        const fall = group(t('builder.roof.side.label'));
        fall.appendChild(choices(([[0, 'front'], [1, 'right'], [2, 'back'], [3, 'left']] as const).map(([side, key]) => ({ label: t(`builder.roof.side.${key}`), on: roof.fall === side, run: () => actions.roofFall(side), icon: svg(`fall_${key}`, 18) }))));
        options.append(ridge, fall);
      }
      return;
    }
    if (s.shelf === 'patterns') {
      const { items } = section(label);
      for (const p of FACADE_PATTERNS) items.appendChild(card(t(`creator.pattern.${p}`), state.pattern === p, () => actions.choosePattern(p), workspace.thumbnail(p), builderIconSvg(p, 30)));
      return;
    }
    if (s.shelf === 'finishes') {
      const { items } = section(t('v2.build.material'));
      for (const f of FINISHES) items.appendChild(card(t(`building.finish.${f}`), state.material?.finish === f, () => actions.chooseFinish(f), materialSwatch(f), undefined, 'square'));
      const colours = group(t('v2.build.colour'));
      const sw = el('div', 'v2-swatches');
      for (const c of SWATCHES) {
        const b = el('button', 'v2-swatch' + (state.material?.colour === c ? ' on' : ''));
        b.type = 'button';
        b.style.setProperty('--c', hexOf(c));
        b.setAttribute('aria-label', hexOf(c));
        b.onclick = () => actions.chooseColour(c);
        sw.appendChild(b);
      }
      const custom = el('input', 'v2-swatch custom');
      custom.type = 'color';
      custom.onchange = () => actions.chooseColour(parseInt(custom.value.slice(1), 16));
      sw.appendChild(custom);
      colours.appendChild(sw);
      options.appendChild(colours);
      const st = section(t('builder.section.styles'));
      for (const style of STYLES) {
        const chips = [style.materials.wall.colour, style.materials.trim.colour, style.materials.roof.colour].map((c) => `<i style="background:${hexOf(c)}"></i>`).join('');
        st.items.appendChild(card(t(`building.style.${style.key}`), false, () => actions.chooseStyle(style.key), undefined, `<span class="v2-style">${chips}</span>`, 'square'));
      }
      return;
    }
    const list = s.tools ?? [];
    if (!list.length) return;
    const things = list.some((x) => THINGS.has(x.id) || DRAW_SHAPES[x.id] || TIER_SHAPES[x.id]);
    const { items } = section(label || title.textContent || '', things ? 'cards' : 'verbs');
    for (const x of list) items.appendChild(toolButton(x, state, things));
  }

  function toolButton(x: BuilderToolSpec, state: BuilderState, asCard: boolean): HTMLButtonElement {
    const on = x.kind === 'mode' && (state.tool === x.id || state.armed === x.id);
    const label = t(`builder.tool.${x.id}`);
    const run = (): void => actions.chooseTool(x.id);
    const b = asCard ? card(label, on, run, picture(x.id), builderIconSvg(x.id, 32)) : verb(label, on, run, builderIconSvg(x.id, 18), x.danger);
    b.disabled = !state.ready.has(x.id);
    b.dataset['builderTool'] = x.id;
    return b;
  }

  function renderModels(state: BuilderState): void {
    const g = group(t('builder.search'));
    const search = el('input', 'v2-search');
    search.type = 'search';
    search.placeholder = t('builder.search');
    search.value = modelQuery;
    search.onkeydown = (e) => e.stopPropagation();
    g.appendChild(search);
    const cats = ['all', 'homes', 'public', 'commerce', 'work', 'leisure', 'generic', ...(state.userBlueprints.length ? ['mine'] : [])];
    // The kinds of building in one dropdown, not a row of names.
    const kind = el('select', 'v2-mini');
    kind.title = t('builder.category.models');
    for (const c of cats) {
      const o = el('option', '', c === 'all' ? t('builder.city.all') : c === 'mine' ? t('builder.city.mine') : t(`builder.city.${c}`));
      o.value = c;
      o.selected = modelCat === c;
      kind.appendChild(o);
    }
    kind.onchange = () => { modelCat = kind.value; render(); };
    g.appendChild(kind);
    options.appendChild(g);
    const { items } = section(t('builder.category.models'));
    const names = new Set<string>();
    type Entry = { key: string; label: string; cat: string; run: () => void };
    const entries: Entry[] = [];
    for (const m of CITY_BUILDINGS) {
      const key = `city:${m.fn}`;
      const label = t(`building.fn.${m.fn}`);
      names.add(label.toLocaleLowerCase());
      entries.push({ key, label, cat: m.category, run: () => actions.choosePreset(key) });
    }
    for (const bp of BLUEPRINTS) {
      const label = bp.nameKey ? t(bp.nameKey) : bp.key;
      if (!names.has(label.toLocaleLowerCase())) entries.push({ key: bp.key, label, cat: 'generic', run: () => actions.choosePreset(bp.key) });
    }
    for (const bp of state.userBlueprints) entries.push({ key: bp.key, label: bp.name ?? bp.key, cat: 'mine', run: () => actions.chooseUserBlueprint(bp.key) });
    const fill = (): void => {
      items.innerHTML = '';
      const query = modelQuery.trim().toLocaleLowerCase();
      const shown = entries.filter((e) => (modelCat === 'all' || e.cat === modelCat) && (!query || e.label.toLocaleLowerCase().includes(query)));
      for (const e of shown) items.appendChild(card(e.label, false, e.run, workspace.thumbnail(e.key), builderIconSvg('models', 32), 'model'));
      if (!shown.length) items.appendChild(el('p', 'v2-muted', t('builder.search.none')));
    };
    search.oninput = () => { modelQuery = search.value; fill(); };
    fill();
  }

  // ================================================================ render
  let lastSignature = '';
  function render(): void {
    const current = tool();
    const cat = categoryOf(current);
    // The bomb is an Action: its button is lit, not Demolish's.
    const bombing = current === 'bulldoze' && strikeChoice.mode !== 'demolish' && open;
    actionsB.classList.toggle('on', bombing);
    for (const [id, b] of catButtons) {
      b.classList.toggle('on', id === cat && open && (current !== 'inspect' || id === 'info') && !(bombing && id === 'demolish'));
      const c = CATS.find((x) => x.id === id);
      (b.querySelector('.v2-cat-name') as HTMLElement).textContent = c?.label() ?? '';
      // Only the icon shows: the name and the key are in the tooltip.
      b.dataset['tip'] = c ? `${c.label()}  ${c.key}` : '';
      b.setAttribute('aria-label', c?.label() ?? '');
    }
    const showDrawer = open && cat !== null;
    drawer.hidden = !showDrawer;
    toolOptions.hidden = !showDrawer;
    side.hidden = q('#inspector')?.classList.contains('hidden') ?? true;
    root.dataset['tool'] = current;
    // Whether the player has the Information tool open (not merely no tool in
    // hand, which is also 'inspect'): the game draws road gizmos only then.
    document.body.dataset['infoTool'] = open && cat === 'info' ? 'on' : 'off';
    syncSide();
    if (!showDrawer) return;
    // Keep the search box focused across a rebuild.
    const focused = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('v2-search');
    const scroll = strip.scrollLeft;
    tabs.innerHTML = '';
    tools.innerHTML = '';
    options.innerHTML = '';
    strip.innerHTML = '';
    drawer.removeAttribute('aria-description');
    if (cat === 'roads') renderRoads(current);
    else if (cat === 'zones') renderZones();
    else if (cat === 'landscape') renderLandscape(current);
    else if (cat === 'transit') renderTransit();
    else if (cat === 'build') renderBuild();
    else renderSimple(current);
    options.hidden = options.childElementCount === 0;
    tabs.hidden = tabs.childElementCount === 0;
    // A tool with nothing to choose (demolish, inspect) opens no drawer: its
    // icon is lit in the dock and its help is in the tooltip.
    drawer.hidden = tabs.hidden && strip.childElementCount === 0;
    toolOptions.hidden = options.hidden && tools.childElementCount === 0;
    if (lastSignature === `${cat}|${current}|${builder?.category ?? ''}`) strip.scrollLeft = scroll;
    lastSignature = `${cat}|${current}|${builder?.category ?? ''}`;
    if (focused) {
      const s = options.querySelector<HTMLInputElement>('.v2-search');
      s?.focus();
      s?.setSelectionRange(s.value.length, s.value.length);
    }
    updateHint();
    fitDrawer();
  }
  /**
   * The asset panel stands centred over the dock but never over the tool
   * options (left) or the selection (right): its width is what is left between
   * them, whatever the screen.
   */
  function fitDrawer(): void {
    if (drawer.hidden) return;
    const vw = window.innerWidth;
    let left = 12;
    let right = vw - 12;
    if (!toolOptions.hidden) left = Math.max(left, toolOptions.getBoundingClientRect().right + 12);
    const sel = [side, q('#builder .bw-inspector')].filter((e): e is HTMLElement => !!e && !e.hidden && e.getBoundingClientRect().width > 0);
    for (const e of sel) {
      const r = e.getBoundingClientRect();
      // Only what reaches down to the panel's height matters.
      if (r.bottom > drawer.getBoundingClientRect().top - 4) right = Math.min(right, r.left - 12);
    }
    const half = Math.max(160, Math.min(vw / 2 - left, right - vw / 2));
    drawer.style.maxWidth = `${Math.floor(Math.min(1100, half * 2))}px`;
  }
  window.addEventListener('resize', () => fitDrawer());
  let wantInfo = true;
  void wantInfo;

  function updateHint(): void {
    const current = tool();
    const text = current === 'building' ? builder?.hint ?? '' : (q('#hint')?.textContent ?? '');
    if (hint.textContent !== text) hint.textContent = text;

  }

  // The HUD follows the game's numbers.
  const tick = (): void => {
    clock.textContent = q('#cityClock')?.textContent ?? '';
    sky.textContent = q('#skyMode')?.textContent ?? '';
    const parts = ['#residentCount', '#vehicleCount', '#pedCount'].map((s) => q(s)?.textContent ?? '').filter(Boolean);
    const line = parts.join('  ·  ');
    if (stats.textContent !== line) stats.textContent = line;
    const active = q('.simulation-controls [data-speed].active')?.dataset['speed'] ?? '1';
    for (const b of speedButtons) b.classList.toggle('on', b.dataset['speed'] === active);
    undo.disabled = q<HTMLButtonElement>('#undoAction')?.disabled ?? false;
    redo.disabled = q<HTMLButtonElement>('#redoAction')?.disabled ?? false;
    updateHint();
    syncSide();
  };
  function syncSide(): void {
    const roadSide = !(q('#inspector')?.classList.contains('hidden') ?? true);
    if (side.hidden === roadSide) side.hidden = !roadSide;
    const builderSide = !(q('#builder .bw-inspector')?.hidden ?? true);
    root.classList.toggle('has-side', roadSide || builderSide);
  }
  setInterval(tick, 250);
  tick();

  // Re-render when the game changes a tool or an option: its own controls
  // carry the truth (classes, pressed states), and the Builder reports its state.
  let pending = false;
  const later = (): void => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      render();
    });
  };
  // Only a real change: the game rewrites some states every frame with the
  // value they already had (the speed buttons' aria-pressed), and every such
  // write rebuilt the whole panel - the buttons flickered under the pointer.
  const watch = new MutationObserver((records) => {
    if (records.some((r) => r.target instanceof Element && r.attributeName && r.target.getAttribute(r.attributeName) !== r.oldValue)) later();
  });
  const game = q('#game');
  if (game) watch.observe(game, { attributes: true, attributeOldValue: true, attributeFilter: ['data-tool'] });
  const builderRoot = document.getElementById('builder');
  if (builderRoot) watch.observe(builderRoot, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ['class', 'aria-pressed'] });
  workspace.subscribe((state) => {
    builder = state;
    if (tool() === 'building') later();
  });
  window.addEventListener('keydown', (e) => {
    // A tool picked from the keyboard opens its drawer.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (/^[1-6tbipfzhkucmx]$/i.test(e.key)) {
      open = true;
      later();
    }
  });
  onLanguageChange(() => {
    for (const [b, key] of [[undo, 'action.undo'], [redo, 'action.redo'], [menuB, 'builder.menu.app'], [simB, 'builder.menu.simulation'], [camB, 'camera.label'], [helpB, 'builder.help']] as const) {
      const s = b.querySelector('span');
      if (s) s.textContent = t(key);
      b.title = t(key);
    }
    later();
  });
  render();
}

/** The width the road tool starts from when stepped: the selected class's own, in whole metres. */
function defaultRoadWidth(): number {
  const raw = document.querySelector<HTMLElement>('.road-type.active')?.dataset['widthM'];
  return raw ? Math.round(Number(raw)) : 10;
}
