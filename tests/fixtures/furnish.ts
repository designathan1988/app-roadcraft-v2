import type { Network } from '@world/network';
import { snapLandscape, type LandscapeKind } from '@world/landscape';
import { carriesPedestrians } from '@world/pedestrianAccess';
import { roadProfile } from '@world/roadTypes';

/**
 * Furnishes every street of a test map the way a player would with the
 * landscaping tool: a street light every 88 units, alternating sides, with a
 * bench or a bin beside some of them and a tree half a span on. Streets are
 * bare by default since 2026-10-05; the pedestrian specs that walk round
 * furniture place it with this, through the same `snapLandscape` the tool uses.
 */
export function furnishStreets(net: Network): void {
  const doc = net.doc;
  let column = 0;
  for (const ribbon of net.ribbons.values()) {
    if (!carriesPedestrians(ribbon.road)) continue;
    const seg = doc.requireSegment(ribbon.id);
    const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
    const length = ribbon.full.length;
    const start = Math.min(36, length * 0.24);
    const put = (kind: LandscapeKind, s: number, side: number): void => {
      const f = ribbon.full.sampleAt(s);
      const across = rt.width / 2 + rt.sidewalk / 2;
      const at = { x: f.p.x + f.n.x * across * side, y: f.p.y + f.n.y * across * side };
      const snap = snapLandscape(net, doc.landscape.values(), kind, at, 4);
      if (snap.ok) doc.addLandscape(kind, snap.at);
    };
    for (let s = start; s < length - start; s += 88) {
      const side = (Math.floor(s / 88) + ribbon.id) % 2 === 0 ? -1 : 1;
      put('lamp', s, side);
      if (column % 4 === 1) put('bench', s - 5, side);
      if (column % 3 === 0) put('bin', s + 3, side);
      if (s + 44 < length - start) for (const treeSide of [-1, 1]) put('tree', s + 44, treeSide);
      column++;
    }
  }
}
