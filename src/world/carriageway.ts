import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import { Level, halfWidth } from './roadTypes';

/** Whether a point is on the carriageway of a road of the network (kerb to kerb). */
export function onCarriageway(net: Network, p: Vec2): boolean {
  for (const ribbon of net.ribbons.values()) {
    const centre = ribbon.centre[Level.Asphalt];
    if (!centre) continue;
    const bb = centre.bbox, half = halfWidth(ribbon.road, Level.Asphalt);
    if (p.x < bb.minX - half || p.x > bb.maxX + half || p.y < bb.minY - half || p.y > bb.maxY + half) continue;
    if (centre.closestPoint(p).distance < half) return true;
  }
  return false;
}
