import { LANDSCAPE_KINDS, type LandscapeKind, type SignType } from '@world/landscape';
import { POLE_LAMP_MODES, type PoleLampMode } from '@world/utilities';
import { PAINT_KINDS, type PaintKind } from '@world/terrainPaint';

/**
 * What the player has chosen in the tools' panels and the game reads when
 * the tool acts: the landscaping item the next click places, and the street
 * lights a new run of wire poles carries. Kept for the session, like the road
 * tool's parking.
 */

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
  } catch {
    // Not kept: the default stands.
  }
  return fallback;
}

function keep(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Not kept between sessions; it still applies now.
  }
}

const KIND_KEY = 'roadcraft.streetscapeKind';
let kind: LandscapeKind = stored(KIND_KEY, LANDSCAPE_KINDS, 'tree');

export function streetscapeKind(): LandscapeKind {
  return kind;
}

export function setStreetscapeKind(next: LandscapeKind): void {
  kind = next;
  keep(KIND_KEY, next);
}

const LAMP_KEY = 'roadcraft.poleLamps';
let lamps: PoleLampMode = stored(LAMP_KEY, POLE_LAMP_MODES, 'alternate');

export function poleLampMode(): PoleLampMode {
  return lamps;
}

export function setPoleLampMode(next: PoleLampMode): void {
  lamps = next;
  keep(LAMP_KEY, next);
}

/** What a click of the pole tool does: build a run, or remove the pole under it. */
export const POLE_TOOL_MODES = ['build', 'remove'] as const;
export type PoleToolMode = (typeof POLE_TOOL_MODES)[number];
let poleMode: PoleToolMode = 'build';

export function poleToolMode(): PoleToolMode {
  return poleMode;
}

/** Not kept between sessions: the tool always opens building. */
export function setPoleToolMode(next: PoleToolMode): void {
  poleMode = next;
}

const PAINT_KEY = 'roadcraft.paintKind';
let paint: PaintKind = stored(PAINT_KEY, PAINT_KINDS, 'sand');

/** The ground the terrain brush paints in its Paint mode. */
export function paintKind(): PaintKind {
  return paint;
}

export function setPaintKind(next: PaintKind): void {
  paint = next;
  keep(PAINT_KEY, next);
}

/** Total width of the roads the road tool lays, whole metres (the 1 m subgrid), or null for the class's own. */
let width: number | null = null;
export const ROAD_WIDTH_RANGE = [6, 60] as const;

export function roadWidth(): number | null {
  return width;
}

export function setRoadWidth(next: number | null): void {
  width = next === null ? null : Math.max(ROAD_WIDTH_RANGE[0], Math.min(ROAD_WIDTH_RANGE[1], Math.round(next)));
}

/**
 * The block grid the road tool lays in one click (`editor/blocks.ts`):
 * columns, rows, centreline spacing in whole metres, and whether the next
 * click places it.
 */
export const blockGridChoice = { cols: 3, rows: 2, blockMetres: 100, angle: 0, armed: false };

/** What the sign tool puts down next: its kind and its words; and the next street name. */
export const signChoice: { type: SignType; text: string; streetName: string } = { type: 'stop', text: '', streetName: '' };

/** The demolish tool: knock a building down at once, or strike it (and streets) with a chosen force. */
export const strikeChoice: { mode: 'demolish' | 'strike'; strength: number } = { mode: 'demolish', strength: 5 };

const ZONE_COLOUR_KEY = 'roadcraft.zoneColours';
let zoneColours = stored(ZONE_COLOUR_KEY, ['on', 'off'] as const, 'on') === 'on';
/** Whether zoned land is tinted with its use's colour outside the Zoning tool. */
export function zoneColoursShown(): boolean { return zoneColours; }
export function setZoneColoursShown(on: boolean): void { zoneColours = on; keep(ZONE_COLOUR_KEY, on ? 'on' : 'off'); }

const LOTS_ROADS_KEY = 'roadcraft.lotsWithRoads';
let lotsWithRoads = stored(LOTS_ROADS_KEY, ['on', 'off'] as const, 'on') === 'on';
/** Whether the lots are drawn while roads are built (the road panel's toggle). */
export function lotsShownWithRoads(): boolean { return lotsWithRoads; }
export function setLotsShownWithRoads(on: boolean): void { lotsWithRoads = on; keep(LOTS_ROADS_KEY, on ? 'on' : 'off'); }
