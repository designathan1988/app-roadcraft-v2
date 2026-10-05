import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { roadType } from '@world/roadTypes';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { vehiclePose } from '@sim/pose';
import type { Vehicle } from '@sim/vehicles/state';

/**
 * Cycle lanes (`parking` kind `cycle`, `sim/vehicles/cycleLane.ts`): every
 * local street of the default town gets one on its right, parking on its left.
 * Measured: bicycles ride inside the red band along the middle of the street;
 * the cars of the lane beside it pass them instead of queuing behind, and no
 * car body ever overlaps a bicycle; residents without a car cycle to places
 * and get off at the other end.
 */
describe('cycle lanes', () => {
  it('bicycles ride in the band, cars pass them, residents cycle', () => {
    const doc = new RoadDoc();
    buildDefaultTown(doc);
    for (const segment of doc.segments.values()) {
      if (roadType(segment.type).id === 'local') doc.setSegmentParking(segment.id, { left: 'parallel', right: 'cycle' });
    }
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x2024);
    sim.rebuildTopology();
    sim.usePedestrianEngine(createAgentWalkEngine());
    sim.driveModel = 'v2';
    sim.populationShare = 0.3;
    sim.city.useAgents(true);
    sim.city.skip(4 * 60);

    const cycleLanes = [...sim.graph.lanelets.values()].filter((l) => l.cycleShift);
    expect(cycleLanes.length).toBeGreaterThan(20);

    const bikeTrips = new Set<number>();
    let offBike = 0, inBand = 0, outOfBand = 0, overlaps = 0, passed = 0;
    // Car -> bicycle it was behind on the same lane.
    const behind = new Map<number, number>();
    const isBike = (v: Vehicle): boolean => v.archetype.shape === 'bicycle';
    sim.clock.run(Math.round(300 / DT), () => {
      step(sim);
      for (const t of sim.city.trips.values()) {
        if (t.mode === 'bike') bikeTrips.add(t.id);
        else if (bikeTrips.has(t.id) && t.mode === 'walk') { offBike++; bikeTrips.delete(t.id); }
      }
      const bikes = [...sim.vehicles.values()].filter(isBike);
      for (const b of bikes) {
        const lane = sim.lanelet(b.lanelet);
        if (!lane?.cycleShift) continue;
        const centre = b.s - b.archetype.length / 2;
        if (centre < m(10) || centre > lane.length - m(10)) continue;
        const pose = vehiclePose(sim, b, 1)!;
        const off = lane.centre.closestPoint(pose.p).distance;
        if (Math.abs(off - Math.abs(lane.cycleShift)) < m(0.2)) inBand++; else outOfBand++;
      }
      for (const car of sim.vehicles.values()) {
        if (isBike(car) || car.free) continue;
        const cp = vehiclePose(sim, car, 1);
        if (!cp) continue;
        const cx = Math.cos(cp.angle), cy = Math.sin(cp.angle);
        for (const b of bikes) {
          const bp = vehiclePose(sim, b, 1);
          if (!bp) continue;
          const dx = bp.p.x - cp.p.x, dy = bp.p.y - cp.p.y;
          const along = dx * cx + dy * cy, side = -dx * cy + dy * cx;
          if (Math.abs(along) < (car.archetype.length + b.archetype.length) / 2 - m(0.2)
            && Math.abs(side) < (car.archetype.width + b.archetype.width) / 2 - m(0.1)) overlaps++;
          if (car.lanelet === b.lanelet && sim.lanelet(b.lanelet)?.cycleShift) {
            if (car.s < b.s - b.archetype.length) behind.set(car.id, b.id);
            else if (behind.get(car.id) === b.id && car.s - car.archetype.length > b.s) { passed++; behind.delete(car.id); }
          }
        }
      }
    });
    console.log(`cycle lanes ${cycleLanes.length}, bike trips ${bikeTrips.size + offBike}, got off and walked ${offBike}, `
      + `in band ${inBand}, out of band ${outOfBand}, cars passed a bicycle ${passed}, overlaps ${overlaps}`);
    expect(offBike).toBeGreaterThan(0);
    expect(inBand).toBeGreaterThan(0);
    expect(outOfBand).toBe(0);
    expect(passed).toBeGreaterThan(0);
    expect(overlaps).toBe(0);
  }, 300_000);
});
