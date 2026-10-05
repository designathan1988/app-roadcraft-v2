import { onGridLength } from './grid';
import { m } from './units';
export const LANE_TURN_RULES = ['all', 'left', 'through', 'right', 'leftThrough', 'throughRight'] as const;
export type LaneTurnRule = (typeof LANE_TURN_RULES)[number];

/** Authored symmetric road section. Widths use world units, whole metres; sidewalk includes the kerb. */
export interface RoadSection {
  readonly laneWidth: number;
  readonly sidewalk: number;
  readonly median: number;
  readonly speedKmh: number;
  readonly priority: number;
  /** Lane order matches laneIndex, inner to outer, in the stored a -> b direction. */
  readonly turnsForward?: readonly LaneTurnRule[];
  /** Lane order in the stored b -> a direction. Missing indexes retain default movements. */
  readonly turnsBackward?: readonly LaneTurnRule[];
}

/** Physical edit bounds, shared by persistence and the section editor. */
export const ROAD_SECTION_LIMITS = {
  laneWidth: [m(2), m(6)],
  sidewalk: [m(1), m(12)],
  median: [0, 20],
  speedKmh: [10, 130],
  priority: [0, 5],
} as const;

/** Rejects incomplete/non-finite input; clamps finite values at the document boundary. */
export function normalizeRoadSection(raw: unknown): RoadSection | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const result = {} as { -readonly [K in keyof RoadSection]: RoadSection[K] };
  for (const key of Object.keys(ROAD_SECTION_LIMITS) as (keyof typeof ROAD_SECTION_LIMITS)[]) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
    const [min, max] = ROAD_SECTION_LIMITS[key];
    const clamped = Math.max(min, Math.min(max, key === 'priority' ? Math.round(number) : number));
    // Widths are whole metres of the universal grid (`grid.ts`).
    result[key] = key === 'laneWidth' || key === 'sidewalk' || key === 'median'
      ? Math.max(min, Math.min(max, onGridLength(clamped)))
      : clamped;
  }
  for (const key of ['turnsForward', 'turnsBackward'] as const) {
    const rules = value[key];
    if (rules === undefined) continue;
    if (!Array.isArray(rules) || rules.length > 8 ||
      rules.some((rule) => !LANE_TURN_RULES.includes(rule as LaneTurnRule))) return undefined;
    result[key] = [...rules] as LaneTurnRule[];
  }
  return result;
}

export function sameRoadSection(a: RoadSection | undefined, b: RoadSection | undefined): boolean {
  if (!a || !b) return a === b;
  return (Object.keys(ROAD_SECTION_LIMITS) as (keyof typeof ROAD_SECTION_LIMITS)[]).every((key) => a[key] === b[key]) &&
    (['turnsForward', 'turnsBackward'] as const).every((key) => {
      const left = a[key] ?? [], right = b[key] ?? [];
      return left.length === right.length && left.every((rule, index) => rule === right[index]);
    });
}

/**
 * The section of one piece of a split road. Lane arrows are a rule of the END
 * a lane arrives at: forward arrows (a -> b) belong to the piece that reaches
 * b, backward arrows to the piece that reaches a. Copied onto every piece they
 * turned each new node into a place with only a forbidden way on - a lane with
 * no exit at all (seen at a mid-block crossing: "left only", nothing on the left).
 */
export function sectionForPiece(section: RoadSection | undefined, reachesA: boolean, reachesB: boolean): RoadSection | undefined {
  if (!section) return undefined;
  const { turnsForward, turnsBackward, ...rest } = section;
  return {
    ...rest,
    ...(reachesB && turnsForward ? { turnsForward: [...turnsForward] } : {}),
    ...(reachesA && turnsBackward ? { turnsBackward: [...turnsBackward] } : {}),
  };
}

/** Whether two sections are the same road once their lane arrows are set aside. */
export function sameRoadSectionIgnoringArrows(a: RoadSection | undefined, b: RoadSection | undefined): boolean {
  return sameRoadSection(sectionForPiece(a, false, false), sectionForPiece(b, false, false));
}

/** A snapshot must never share editable turn arrays with its document. */
export function cloneRoadSection(section: RoadSection): RoadSection {
  return { ...section,
    ...(section.turnsForward ? { turnsForward: [...section.turnsForward] } : {}),
    ...(section.turnsBackward ? { turnsBackward: [...section.turnsBackward] } : {}) };
}

/** Explicit arrows restrict every connector, including merge and U-turn fallbacks. */
export function laneTurnAllowed(rule: LaneTurnRule | undefined, turn: 'left' | 'right' | 'through' | 'uturn'): boolean {
  if (!rule || rule === 'all') return true;
  if (turn === 'uturn') return false;
  return rule === turn || (rule === 'leftThrough' && (turn === 'left' || turn === 'through')) ||
    (rule === 'throughRight' && (turn === 'through' || turn === 'right'));
}
