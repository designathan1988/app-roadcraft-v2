// Top-down plan of the lots the agents use: building walls, lot rectangles,
// bays (with the side they open on), each bay's way out and its lane point.
// Written as SVG for a person to look at; used by ownCars.spec.ts (AGENT_SVG).
import { localToWorld, solidFootprints } from '@world/buildings/geometry';
import type { SimWorld } from '@sim/world';
import type { Bay } from '@sim/agents/parking';
import { departure } from '@sim/agents/manoeuvre';

export function lotPlanSvg(sim: SimWorld, bays: readonly Bay[], cx: number, cy: number, half: number): string {
  const x0 = cx - half, y0 = cy - half, size = half * 2;
  const pt = (p: { x: number; y: number }): string => `${(p.x - x0).toFixed(1)},${(p.y - y0).toFixed(1)}`;
  const parts: string[] = [];
  for (const lane of sim.graph.lanelets.values()) {
    if (lane.kind !== 'link') continue;
    const pts = lane.centre.toPoints().map(pt).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="#bbb" stroke-width="1.5"/>`);
  }
  for (const b of sim.doc.buildings.all()) {
    for (const v of b.volumes) {
      if (!v.open) continue;
      const ring = [localToWorld(b, v.x, v.y), localToWorld(b, v.x + v.w, v.y), localToWorld(b, v.x + v.w, v.y + v.d), localToWorld(b, v.x, v.y + v.d)];
      parts.push(`<polygon points="${ring.map(pt).join(' ')}" fill="#e8f0d8" stroke="#8a6" stroke-width="0.8"/>`);
    }
  }
  for (const b of sim.doc.buildings.all()) {
    for (const ring of solidFootprints(b)) parts.push(`<polygon points="${ring.map(pt).join(' ')}" fill="#666" fill-opacity="0.75"/>`);
  }
  for (const bay of bays) {
    if (Math.abs(bay.x - cx) > half || Math.abs(bay.y - cy) > half) continue;
    const tip = { x: bay.x + bay.ox * bay.depth * 0.6, y: bay.y + bay.oy * bay.depth * 0.6 };
    parts.push(`<circle cx="${bay.x - x0}" cy="${bay.y - y0}" r="1.6" fill="${bay.lane ? '#06c' : '#c00'}"/>`);
    parts.push(`<line x1="${bay.x - x0}" y1="${bay.y - y0}" x2="${tip.x - x0}" y2="${tip.y - y0}" stroke="#06c" stroke-width="0.6"/>`);
  }
  // One way out in every few bays, so the picture stays legible.
  for (const bay of bays.filter((b) => b.lane && Math.abs(b.x - cx) < half && Math.abs(b.y - cy) < half).filter((_, i) => i % 4 === 0)) {
    const path = departure(bay, bay.lane!);
    parts.push(`<polyline points="${path.samples.map(pt).join(' ')}" fill="none" stroke="#d22" stroke-width="0.8"/>`);
    parts.push(`<circle cx="${bay.lane!.x - x0}" cy="${bay.lane!.y - y0}" r="2" fill="#d90"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="1000" height="1000">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><g transform="translate(0 ${size}) scale(1 -1)">${parts.join('')}</g></svg>`;
}
