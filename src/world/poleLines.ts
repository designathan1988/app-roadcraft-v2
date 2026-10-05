import { EndType, FillRule, JoinType, inflatePathsD, unionD, type PathsD } from 'clipper2-ts';

import { Polyline } from '@core/polyline';
import { pointInPolygon } from '@core/polygon';
import type { MultiPoly } from '@core/clipper';
import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { LAMP_ZONE } from './section';
import { crossingAccesses, type CrossingAccess } from './landscape';
import { surfaces } from './surfaces';
import { deckOf } from './walkways';

/**
 * The line wire poles stand on, and the kerb they stand behind.
 *
 * The outline of everything a kerb bounds (carriageway and kerb stone of
 * every ground street with footways, `surfaces().curb`), grown by
 * `POLE_KERB_INSET` with round joins (Clipper2, as the walking lines in
 * `walkways.ts` are). Each closed contour runs round one block at exactly that
 * distance from the kerb - along a street, round a corner's kerb return - so a
 * pole on it is on the pavement, never in a junction. The pole tool plans on
 * it (`editor/poles.ts`); the renderer turns a pole's lamp towards the kerb
 * nearest it (`kerbward`), which is right at a corner too, where no single
 * street owns the footway.
 */

/** How far behind the kerb stone the pole line runs: the middle of the lamp zone. */
export const POLE_KERB_INSET = LAMP_ZONE / 2;

export interface PoleLines {
  /** Closed contours, first point repeated at the end. */
  readonly contours: readonly Polyline[];
  /** The ground footways: paving out to the outer edge, and the kerbed carriageway inside it. */
  readonly paving: MultiPoly;
  readonly kerbed: MultiPoly;
  readonly accesses: readonly CrossingAccess[];
}

const cache = new WeakMap<Network, { revision: number; lines: PoleLines }>();

/** The pole lines of the ground streets that have footways. Cached per network revision. */
export function poleLines(net: Network): PoleLines {
  const known = cache.get(net);
  if (known && known.revision === net.revision) return known.lines;
  const doc = net.doc;
  const s = surfaces(net, (id) => {
    if (deckOf(doc, id) !== 'ground') return false;
    const ribbon = net.ribbons.get(id);
    return !!ribbon && carriesPedestrians(ribbon.road) && ribbon.road.sidewalk > 0;
  });
  const paths: PathsD = [];
  for (const poly of s.curb) for (const ring of poly) paths.push(ring.map(([x, y]) => ({ x: x!, y: y! })));
  const contours: Polyline[] = [];
  if (paths.length) {
    const grown = inflatePathsD(unionD(paths, [], FillRule.NonZero, 3), POLE_KERB_INSET, JoinType.Round, EndType.Polygon, 2, 3, 0.02);
    for (const ring of grown) if (ring.length >= 3) contours.push(Polyline.fromPoints([...ring, ring[0]!]));
  }
  const lines = { contours, paving: s.sidewalk, kerbed: s.curb, accesses: crossingAccesses(net) };
  cache.set(net, { revision: net.revision, lines });
  return lines;
}

function inMulti(p: Vec2, polys: MultiPoly): boolean {
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (!outer || !pointInPolygon(p, outer.map(([x, y]) => ({ x: x!, y: y! })))) continue;
    if (holes.some((h) => pointInPolygon(p, h.map(([x, y]) => ({ x: x!, y: y! }))))) continue;
    return true;
  }
  return false;
}

/** Whether a point is on a footway: on the paving, outside every kerbed carriageway. */
export function onFootway(net: Network, p: Vec2): boolean {
  const lines = poleLines(net);
  return inMulti(p, lines.paving) && !inMulti(p, lines.kerbed);
}

/**
 * The unit direction from a point to the nearest kerb edge (the carriageway's
 * side), or null when no kerbed street is within `reach`.
 */
export function kerbward(net: Network, p: Vec2, reach: number): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = reach;
  for (const poly of poleLines(net).kerbed) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        const ax = a[0]!, ay = a[1]!, dx = b[0]! - ax, dy = b[1]! - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
        const qx = ax + dx * t - p.x, qy = ay + dy * t - p.y;
        const d = Math.hypot(qx, qy);
        if (d < bestD && d > 1e-9) { bestD = d; best = { x: qx / d, y: qy / d }; }
      }
    }
  }
  return best;
}
