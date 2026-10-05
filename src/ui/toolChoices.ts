import { LANDSCAPE_KINDS, type LandscapeKind } from '@world/landscape';
import { POLE_LAMP_MODES, type PoleLampMode } from '@world/utilities';

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
