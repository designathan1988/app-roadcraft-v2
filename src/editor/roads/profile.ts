import type { RoadDoc } from '@world/doc';
import type { SegmentId } from '@world/ids';
import { sameParking } from '@world/parking';
import { sameRoadSection } from '@world/roadSection';
import { type ProfileProblem, type RoadProfileSpec, applyProfile, profileProblems } from '@world/roads/profile';
import { type RoadTemplate, normalizeTemplate } from '@world/roads/templates';

/**
 * Applying a profile to roads already built (docs/VIAS.md V1: "aplicar sem
 * demolir"): the segment keeps its id, its nodes, its curve and everything
 * placed beside it; only its cross-section changes, through the document's
 * own setters, so the network, the lanelets and the markings rebuild from it
 * as from any edit. Run inside `guardRoadEdit` (main.ts `mutateRoads`), it is
 * judged by the editing rules and paid for like every road edit.
 */
export interface ApplyResult {
  readonly changed: boolean;
  readonly problems: readonly ProfileProblem[];
}

export function applyProfileTo(doc: RoadDoc, ids: readonly SegmentId[], profile: RoadProfileSpec, type?: number): ApplyResult {
  let changed = false;
  for (const id of ids) {
    const segment = doc.segment(id);
    if (!segment) continue;
    const typeIndex = type ?? segment.type;
    const problems = profileProblems(profile, typeIndex);
    if (problems.length) return { changed, problems };
    const applied = applyProfile(profile, typeIndex);
    const before = { type: segment.type, lanes: segment.lanes, direction: segment.direction, section: segment.section, parking: segment.parking };
    if (typeIndex !== segment.type) doc.setSegmentType(id, typeIndex);
    // Direction before lanes: a two-way road's count is normalised to pairs.
    doc.setSegmentDirection(id, applied.direction);
    doc.setSegmentLanes(id, applied.lanes);
    doc.setSegmentSection(id, applied.section);
    doc.setSegmentParking(id, applied.parking);
    const after = doc.segment(id)!;
    changed ||= before.type !== after.type || before.lanes !== after.lanes || before.direction !== after.direction ||
      !sameRoadSection(before.section, after.section) || !sameParking(before.parking, after.parking);
  }
  return { changed, problems: [] };
}

/** Where the player's own templates are kept: in this browser, for every map. */
const STORE = 'roadcraft.roadTemplates';

/** The player's saved templates (malformed ones dropped). */
export function savedTemplates(): RoadTemplate[] {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORE) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeTemplate).filter((t): t is RoadTemplate => t !== null);
  } catch {
    return [];
  }
}

/** Saves a template under a name (replacing one of the same name); false when it cannot be built or stored. */
export function saveTemplate(name: string, type: number, profile: RoadProfileSpec): RoadTemplate | null {
  const template = normalizeTemplate({ id: `user:${Date.now().toString(36)}`, name, type, profile });
  if (!template) return null;
  const list = savedTemplates().filter((t) => t.name !== template.name);
  list.push(template);
  try {
    globalThis.localStorage?.setItem(STORE, JSON.stringify(list));
  } catch {
    return null;
  }
  return template;
}

export function deleteTemplate(id: string): void {
  try {
    globalThis.localStorage?.setItem(STORE, JSON.stringify(savedTemplates().filter((t) => t.id !== id)));
  } catch {
    // Storage refused (private window): nothing was saved to remove.
  }
}
