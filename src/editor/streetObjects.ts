import { CROSSWALK_DEPTH, MIN_LINK_LENGTH, STOP_BAR_SETBACK } from '@world/approach';
import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { roadProfile } from '@world/roadTypes';
import { sectionOf } from '@world/section';
import { splitSegment } from './commit';

export type PedestrianCrossingKind = 'zebra' | 'signal';
export type PedestrianCrossingResult =
  | { readonly committed: true; readonly node: NodeId; readonly segments: readonly SegmentId[] }
  | { readonly committed: false; readonly reason: 'unsupported' | 'tooShort' | 'geometry' };

/**
 * Inserts one crossing whose centre is at the selected arc distance (midpoint
 * by default). The split node is its downstream paint edge: the existing
 * crossing adapters can share one positive distance and one crossing ID.
 * Call within the normal history wrapper; all rejected edits leave doc intact.
 */
export function commitPedestrianCrossing(
  doc: RoadDoc,
  net: Network,
  segmentId: SegmentId,
  kind: PedestrianCrossingKind,
  s?: number,
): PedestrianCrossingResult {
  const segment = doc.segment(segmentId);
  if (!segment || (kind !== 'zebra' && kind !== 'signal') || segment.structure === 'tunnel') {
    return { committed: false, reason: 'unsupported' };
  }
  const profile = roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking);
  if (!sectionOf(profile, segment.direction).walkable || profile.sidewalk <= 0) {
    return { committed: false, reason: 'unsupported' };
  }
  const original = net.polylines.get(doc, segmentId);
  const selected = s ?? original.length / 2;
  const splitAt = selected + CROSSWALK_DEPTH / 2;
  // Reserve a whole drivable link beyond each approach, including the far
  // junction's stop line. A crossing never consumes the storage for a queue.
  const reserve = MIN_LINK_LENGTH + CROSSWALK_DEPTH + STOP_BAR_SETBACK;
  if (!Number.isFinite(selected) ||
      splitAt < net.stopLineDistance(segmentId, segment.a) + reserve ||
      original.length - splitAt < net.stopLineDistance(segmentId, segment.b) + reserve) {
    return { committed: false, reason: 'tooShort' };
  }

  const work = doc.clone();
  const workNet = new Network(work);
  workNet.rebuild();
  const node = splitSegment(work, workNet, segmentId, splitAt, original.sampleAt(splitAt).p);
  if (node === null || node === segment.a || node === segment.b) {
    return { committed: false, reason: 'geometry' };
  }
  const record = work.requireNode(node);
  if (record.incident.length !== 2) return { committed: false, reason: 'geometry' };
  const segments = [...record.incident].sort((a, b) => a - b);
  const owner = segments.find((id) => work.requireSegment(id).a === segment.a);
  if (owner === undefined) return { committed: false, reason: 'geometry' };
  work.setNodeCrossing(node, kind, owner);
  workNet.rebuild();
  // Refuse if the new topology cannot carry the crossing the player requested.
  // Exactly one physical zebra serves both directions; never paint a fake one.
  if (workNet.impossible.has(node) ||
      segments.filter((id) => workNet.crosswalkDistanceAt(id, node) > 0).length !== 1) {
    return { committed: false, reason: 'geometry' };
  }
  doc.replaceWith(work);
  net.adopt(workNet);
  return { committed: true, node, segments };
}
