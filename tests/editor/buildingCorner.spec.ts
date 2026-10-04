import { describe, expect, it } from 'vitest';
import { footprintSize, snapPlacement } from '@editor/buildingSnap';
import { blueprintByKey, instantiate } from '@world/buildings/blueprints';
import { footprintRects } from '@world/buildings/geometry';
import { ROAD_CLEARANCE, touchesRoad } from '@world/buildings/validate';
import { type Building, asBuildingId } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { Level, ROAD_TYPES, halfWidth } from '@world/roadTypes';

function corner() {
  const doc = new RoadDoc();
  const road = ROAD_TYPES.findIndex((type) => type.id === 'local');
  const west = doc.addNode({ x: -180, y: 0 });
  const centre = doc.addNode({ x: 0, y: 0 });
  const east = doc.addNode({ x: 180, y: 0 });
  const north = doc.addNode({ x: 0, y: -180 });
  const south = doc.addNode({ x: 0, y: 180 });
  for (const [a, b] of [[west, centre], [centre, east], [north, centre], [centre, south]] as const) {
    doc.addSegment(a.id, b.id, road);
  }
  const net = new Network(doc);
  net.rebuild();
  const body = blueprintByKey('house')!.body;
  return { doc, net, body, size: footprintSize(body), road };
}

describe('corner building placement', () => {
  it('places both street-facing edges at the footway without overlapping a road', () => {
    const { doc, net, body, size, road } = corner();
    const snap = snapPlacement(doc, net, size, { x: 34, y: 36 }, 0);
    const building = { ...instantiate(body, snap.anchor, snap.rotation), id: asBuildingId(1) } as Building;
    const rects = footprintRects(building);
    const minY = Math.min(...rects.flatMap((rect) => rect.map((point) => point.y)));
    expect(snap.kind).toBe('road');
    expect(minY).toBeCloseTo(halfWidth(ROAD_TYPES[road]!, Level.Sidewalk) + ROAD_CLEARANCE, 6);
    expect(rects.every((rect) => !touchesRoad(net, rect))).toBe(true);
  });

  it('keeps a building away from the corner when the pointer is far down the street', () => {
    const { doc, net, size } = corner();
    const snap = snapPlacement(doc, net, size, { x: 34, y: 80 }, 0);
    expect(snap.anchor.y).toBeGreaterThan(50);
  });
});
