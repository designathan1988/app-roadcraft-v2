export const LANE_TURN_RULES = ['all', 'left', 'through', 'right', 'leftThrough', 'throughRight'] as const;
export type LaneTurnRule = (typeof LANE_TURN_RULES)[number];

/** Authored symmetric road section. Widths use world units; sidewalk includes the kerb. */
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
  laneWidth: [5, 15],
  sidewalk: [1.2, 30],
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
    result[key] = Math.max(min, Math.min(max, key === 'priority' ? Math.round(number) : number));
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
