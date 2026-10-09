import type { SegmentDirection } from '../doc';
import { PARKING_DEPTH, type ParkingKind, type SegmentParking } from '../parking';
import {
  type CarriagewayMaterial, type FootwayMaterial, type MedianMaterial, type RoadSection,
  ROAD_SECTION_LIMITS, normalizeRoadSection, sectionSidewalk,
} from '../roadSection';
import { type RoadType, laneWidth, roadProfile, roadType } from '../roadTypes';
import { kmh } from '../units';

/**
 * THE ROAD PROFILE (docs/VIAS.md V1): a road's cross-section as an ordered
 * list of elements from its left edge to its right edge, looking from `a` to
 * `b` - footway, parking or cycle lane, the lanes of each direction, the
 * central reservation - each with its width and what it is paved with, the
 * way OpenDRIVE and RoadRunner describe a road (lanes from the reference line
 * outward, each typed: driving, sidewalk, parking, biking, median; a lane's
 * height over the road for a raised walkway).
 *
 * It is an AUTHORING model, and an adapter: `applyProfile` turns it into the
 * segment's own fields (`lanes`, `direction`, `section`, `parking`), from
 * which `roadProfile` derives the `RoadType` every consumer already reads -
 * the junction builder, the lanelets, the markings, the pedestrians. So a
 * profile takes effect everywhere at once, a map saved before profiles is
 * the profile `profileOf` reads back from it, and nothing stores the same
 * thing twice. What the engine cannot carry yet is refused with a reason
 * (`profileProblems`): a lane of its own width, unequal lane counts per
 * direction and lane classes come with the lane connectors (V4).
 */
export type ProfileElement =
  | { readonly kind: 'footway'; readonly width: number; readonly material?: FootwayMaterial; readonly flush?: boolean }
  | { readonly kind: 'parking' | 'cycle'; readonly width: number }
  | { readonly kind: 'lane'; readonly width: number; readonly dir: 'forward' | 'backward' }
  | { readonly kind: 'median'; readonly width: number; readonly material?: MedianMaterial; readonly flush?: boolean };

export interface RoadProfileSpec {
  /** Left edge to right edge, looking from `a` to `b`. */
  readonly elements: readonly ProfileElement[];
  readonly speedKmh: number;
  readonly priority: number;
  readonly carriageway?: CarriagewayMaterial;
}

/** What a segment is made of, as the profile reads it. */
export interface ProfileSource {
  readonly type: number;
  readonly lanes: number | null;
  readonly direction: SegmentDirection;
  readonly section?: RoadSection;
  readonly parking?: SegmentParking;
}

/** The profile of a segment as it stands (its class, lanes, direction, section, parking). */
export function profileOf(source: ProfileSource): RoadProfileSpec {
  const rt = roadProfile(source.type, source.lanes, source.direction, source.section, source.parking);
  const section = source.section;
  const width = laneWidth(rt);
  const elements: ProfileElement[] = [];
  const footway = (side: 'left' | 'right'): ProfileElement => {
    const material = side === 'left' ? section?.materials?.footwayLeft : section?.materials?.footwayRight;
    const flush = side === 'left' ? section?.flushLeft : section?.flushRight;
    return { kind: 'footway', width: section ? sectionSidewalk(section, side) : rt.sidewalk,
      ...(material ? { material } : {}), ...(flush ? { flush: true } : {}) };
  };
  const band = (kind: ParkingKind): void => {
    if (kind === 'parallel') elements.push({ kind: 'parking', width: PARKING_DEPTH.parallel });
    else if (kind === 'cycle') elements.push({ kind: 'cycle', width: PARKING_DEPTH.cycle });
  };
  elements.push(footway('left'));
  band(rt.parkingLeftKind);
  const lanes = rt.lanes;
  if (source.direction === 'both') {
    const perSide = Math.max(1, Math.floor(lanes / 2));
    for (let i = 0; i < perSide; i++) elements.push({ kind: 'lane', width, dir: 'backward' });
    if (rt.median > 0) {
      elements.push({ kind: 'median', width: rt.median,
        ...(section?.materials?.median ? { material: section.materials.median } : {}),
        ...(section?.medianFlush ? { flush: true } : {}) });
    }
    for (let i = 0; i < perSide; i++) elements.push({ kind: 'lane', width, dir: 'forward' });
  } else {
    const dir = source.direction === 'aToB' ? 'forward' : 'backward';
    for (let i = 0; i < lanes; i++) elements.push({ kind: 'lane', width, dir });
  }
  band(rt.parkingRightKind);
  elements.push(footway('right'));
  return {
    elements,
    speedKmh: Math.round(rt.speedLimit / kmh(1)),
    priority: rt.priorityRank,
    ...(section?.materials?.carriageway ? { carriageway: section.materials.carriageway } : {}),
  };
}

/** Why a profile cannot be built as it stands; a translation key under `profile.problem.`. */
export type ProfileProblem =
  | 'footways' | 'noLanes' | 'laneWidths' | 'laneBalance' | 'order' | 'median' | 'parkingSide' | 'width' | 'class';

/**
 * What stops a profile from being built, empty when nothing does. The order
 * the engine carries is footway, parking or cycle lane, the backward lanes,
 * the median, the forward lanes, parking or cycle lane, footway.
 */
export function profileProblems(profile: RoadProfileSpec, typeIndex: number): ProfileProblem[] {
  const out = new Set<ProfileProblem>();
  const e = profile.elements;
  const first = e[0], last = e[e.length - 1];
  if (!first || !last || first.kind !== 'footway' || last.kind !== 'footway' || e.length < 3) out.add('footways');
  const inner = e.slice(1, -1);
  if (inner.some((x) => x.kind === 'footway')) out.add('footways');
  const lanes = inner.filter((x): x is Extract<ProfileElement, { kind: 'lane' }> => x.kind === 'lane');
  if (!lanes.length) out.add('noLanes');
  if (lanes.some((l) => l.width !== lanes[0]!.width)) out.add('laneWidths');
  const backward = lanes.filter((l) => l.dir === 'backward').length;
  const forward = lanes.length - backward;
  if (backward > 0 && forward > 0 && backward !== forward) out.add('laneBalance');
  // Parking and cycle lanes only by the kerb.
  inner.forEach((x, i) => {
    if ((x.kind === 'parking' || x.kind === 'cycle') && i !== 0 && i !== inner.length - 1) out.add('parkingSide');
  });
  // The carriageway in order: backward lanes, then the median, then forward lanes.
  const core = inner.filter((x) => x.kind === 'lane' || x.kind === 'median');
  let seenForward = false, seenMedian = false;
  for (const x of core) {
    if (x.kind === 'median') {
      if (seenMedian || seenForward || backward === 0 || forward === 0) out.add('median');
      seenMedian = true;
    } else if (x.dir === 'forward') seenForward = true;
    else if (seenForward || seenMedian && x.dir === 'backward') out.add('order');
  }
  const [minLane, maxLane] = ROAD_SECTION_LIMITS.laneWidth;
  const [minWalk, maxWalk] = ROAD_SECTION_LIMITS.sidewalk;
  for (const x of e) {
    if (x.kind === 'lane' && (x.width < minLane || x.width > maxLane)) out.add('width');
    if (x.kind === 'footway' && (x.width < minWalk || x.width > maxWalk)) out.add('width');
    if (x.kind === 'median' && (x.width <= 0 || x.width > ROAD_SECTION_LIMITS.median[1])) out.add('width');
  }
  // Highways and ramps park nothing (`parkingAllowed`).
  const id = roadType(typeIndex).id;
  if ((id === 'highway' || id === 'ramp') && inner.some((x) => x.kind === 'parking' || x.kind === 'cycle')) out.add('class');
  return [...out];
}

/** The segment's own fields for a profile (`profileProblems` must be empty). */
export interface AppliedProfile {
  /** Null: the class's own lane count. */
  readonly lanes: number | null;
  readonly direction: SegmentDirection;
  /** Absent: the class's own section, exactly (its lanes need not be whole metres). */
  readonly section: RoadSection | undefined;
  readonly parking: SegmentParking | undefined;
}

/**
 * The segment's fields for a profile. With the class (`typeIndex`), a profile
 * that is the class's own (as `profileOf` reads a road of that class with
 * that many lanes, that direction and that parking) stays the class's: no
 * authored section, which would round its lanes to whole metres.
 */
export function applyProfile(profile: RoadProfileSpec, typeIndex?: number): AppliedProfile {
  const authored = authoredFields(profile);
  if (typeIndex === undefined) return authored;
  const same = (p: RoadProfileSpec): boolean => JSON.stringify(p) === JSON.stringify(profile);
  const base = { type: typeIndex, direction: authored.direction, ...(authored.parking ? { parking: authored.parking } : {}) };
  if (same(profileOf({ ...base, lanes: null }))) return { ...authored, lanes: null, section: undefined };
  if (same(profileOf({ ...base, lanes: authored.lanes }))) return { ...authored, section: undefined };
  return authored;
}

function authoredFields(profile: RoadProfileSpec): AppliedProfile & { readonly lanes: number; readonly section: RoadSection } {
  const e = profile.elements;
  const left = e[0] as Extract<ProfileElement, { kind: 'footway' }>;
  const right = e[e.length - 1] as Extract<ProfileElement, { kind: 'footway' }>;
  const inner = e.slice(1, -1);
  const lanes = inner.filter((x): x is Extract<ProfileElement, { kind: 'lane' }> => x.kind === 'lane');
  const median = inner.find((x): x is Extract<ProfileElement, { kind: 'median' }> => x.kind === 'median');
  const backward = lanes.filter((l) => l.dir === 'backward').length;
  const forward = lanes.length - backward;
  const direction: SegmentDirection = backward && forward ? 'both' : forward ? 'aToB' : 'bToA';
  const kindAt = (x: ProfileElement | undefined): ParkingKind => x?.kind === 'parking' ? 'parallel' : x?.kind === 'cycle' ? 'cycle' : 'none';
  const parkingLeft = kindAt(inner[0]);
  const parkingRight = kindAt(inner[inner.length - 1]);
  const materials = {
    ...(profile.carriageway ? { carriageway: profile.carriageway } : {}),
    ...(left.material ? { footwayLeft: left.material } : {}),
    ...(right.material ? { footwayRight: right.material } : {}),
    ...(median?.material ? { median: median.material } : {}),
  };
  const raw = {
    laneWidth: lanes[0]?.width ?? ROAD_SECTION_LIMITS.laneWidth[0],
    sidewalk: Math.max(left.width, right.width),
    ...(left.width !== right.width ? { sidewalkLeft: left.width, sidewalkRight: right.width } : {}),
    median: median?.width ?? 0,
    speedKmh: profile.speedKmh,
    priority: profile.priority,
    ...(left.flush ? { flushLeft: true } : {}),
    ...(right.flush ? { flushRight: true } : {}),
    ...(median?.flush ? { medianFlush: true } : {}),
    ...(Object.keys(materials).length ? { materials } : {}),
  };
  const section = normalizeRoadSection(raw) as RoadSection;
  return {
    lanes: lanes.length,
    direction,
    section,
    parking: parkingLeft === 'none' && parkingRight === 'none' ? undefined : { left: parkingLeft, right: parkingRight },
  };
}

/** The road a profile builds, as every consumer reads it. */
export function profileRoad(profile: RoadProfileSpec, typeIndex: number): RoadType {
  const applied = applyProfile(profile, typeIndex);
  return roadProfile(typeIndex, applied.lanes, applied.direction, applied.section, applied.parking);
}

/** Total width of a profile, footways included, world units. */
export const profileWidth = (profile: RoadProfileSpec): number =>
  profile.elements.reduce((sum, x) => sum + x.width, 0);
