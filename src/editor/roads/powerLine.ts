import type { RoadDoc } from '@world/doc';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { carriesPedestrians } from '@world/pedestrianAccess';
import { m } from '@world/units';
import { commitPoleRun, planPoleRun } from '../poles';

/**
 * THE POWER LINE OF A NEW STREET (docs/VIAS.md V7): the distribution line
 * down one side of each street laid with the complete set, a pole every span
 * (`ROAD_TUNING.poles.spacing`) carrying a street light, as Brazilian streets
 * are lit from the utility poles. Laid by the pole tool's own planner
 * (`planPoleRun`: poles on the footway by the kerb, clear of crossings,
 * corners and the furniture, carried round corners), so it is the line the
 * player would have drawn, and each end snaps to a pole already standing:
 * the lines of the streets laid one after another join into one network.
 *
 * On the left of a -> b; the right keeps the lamp columns of the set.
 */
const END_SETBACK = m(4);
const MIN_RUN = m(24);
const SNAP_REACH = m(8);

export function layPowerLines(doc: RoadDoc, net: Network, segments: Iterable<SegmentId>): number {
  let built = 0;
  for (const id of [...segments].sort((a, b) => a - b)) {
    const segment = doc.segment(id), ribbon = net.ribbons.get(id);
    if (!segment || !ribbon || !carriesPedestrians(ribbon.road) || ribbon.road.sidewalk <= 0) continue;
    const line = ribbon.full;
    const s0 = net.mouthDistance(id, segment.a) + END_SETBACK;
    const s1 = line.length - net.mouthDistance(id, segment.b) - END_SETBACK;
    if (s1 - s0 < MIN_RUN) continue;
    // On the left footway, by the kerb: the planner pulls each end onto its line.
    const out = ribbon.road.width / 2 + m(0.4);
    const at = (s: number): { x: number; y: number } => {
      const f = line.sampleAt(s);
      return { x: f.p.x + f.n.x * out, y: f.p.y + f.n.y * out };
    };
    const plan = planPoleRun(doc, net, at(s0), at(s1), SNAP_REACH, undefined, 'all');
    if (commitPoleRun(doc, plan)) built++;
  }
  return built;
}
