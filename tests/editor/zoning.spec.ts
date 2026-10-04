import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { applyZone } from '@editor/zoning';
import { validateBuilding } from '@world/buildings/validate';
import { ZONE_DENSITIES, ZONE_USES } from '@world/zones';

function street() {
  const doc = new RoadDoc();
  const west = doc.addNode({ x: -600, y: 0 });
  const east = doc.addNode({ x: 600, y: 0 });
  doc.addSegment(west.id, east.id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, groundAt: () => 0 };
}

describe('roadside zoning', () => {
  it('constructs valid buildings for every use and density', () => {
    for (const use of ZONE_USES) for (const density of ZONE_DENSITIES) {
      const ctx = street();
      const result = applyZone(ctx, { x: -220, y: 0 }, { x: 220, y: 160 }, use, density);
      expect(result.zones, `${use} ${density}`).toBe(1);
      expect(result.buildings, `${use} ${density}`).toBeGreaterThan(0);
      expect(ctx.doc.zones[0]?.buildingIds).toHaveLength(result.buildings);
      for (const building of ctx.doc.buildings.all()) {
        expect(building.use, `${use} ${density}`).toBe(use);
        expect(validateBuilding(ctx, building), `${use} ${density}`).toBeNull();
      }
    }
  });

  it('round-trips zones and removes only their generated buildings', () => {
    const ctx = street();
    // Painting just behind the first lot must still find its road frontage.
    const start = { x: -200, y: 52 }, end = { x: 200, y: 85 };
    const first = applyZone(ctx, start, end, 'residential', 'low');
    expect(first.buildings).toBeGreaterThan(0);
    const restored = RoadDoc.fromJSON(ctx.doc.toJSON(), { repair: false });
    expect(restored.zones).toHaveLength(1);
    expect(restored.zones[0]?.buildingIds).toHaveLength(first.buildings);
    const net = new Network(restored);
    net.rebuild();
    const removed = applyZone({ doc: restored, net, groundAt: () => 0 }, start, end, 'residential', 'low', true);
    expect(removed.zones).toBe(1);
    expect(restored.zones).toHaveLength(0);
    expect(restored.buildings.size).toBe(0);
  });
});
