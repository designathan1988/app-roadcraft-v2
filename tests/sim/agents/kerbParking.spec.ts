import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { roadType } from '@world/roadTypes';
import { m } from '@world/units';
import type { BuildingId } from '@world/buildings/types';
import { SimWorld } from '@sim/world';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { vehiclePose } from '@sim/pose';
import type { OwnCar as OwnCarOf } from '@sim/agents/cars';
import { solidFootprints } from '@world/buildings/geometry';
import { pointInPolygon } from '@core/polygon';

/**
 * Residents' cars park along the kerb of streets that have parking
 * (`RoadSegment.parking`, `world/parkingLayout.ts`), as on a real street:
 * stopped beside and ahead of a bay, the car backs into it and ends with its
 * nose along the kerb; it later drives forward out of it. Every lot bay is
 * taken here, so the street is the only place to park.
 */
describe('agents: parking along the kerb', () => {
  it('backs into a kerb bay, ends along the kerb, never jumps nor enters a building', () => {
    const doc = new RoadDoc();
    buildDefaultTown(doc);
    for (const segment of doc.segments.values()) {
      const id = roadType(segment.type).id;
      if (id === 'local' || id === 'urban') doc.setSegmentParking(segment.id, { left: 'parallel', right: 'parallel' });
    }
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x2024);
    sim.rebuildTopology();
    sim.usePedestrianEngine(createAgentWalkEngine());
    sim.driveModel = 'v2';
    sim.populationShare = 0.3;
    sim.city.useAgents(true);
    step(sim);
    const city = sim.city;
    const cars = city.cars!;
    const kerbBays = cars.bays.filter((bay) => bay.kerb && bay.lane);
    expect(kerbBays.length).toBeGreaterThan(20);
    // Every free lot bay taken: the street is the only place left.
    for (const bay of cars.bays) if (!bay.kerb && bay.car === null) bay.car = -1 as never;

    const buildings = [...doc.buildings.all()];
    const sent = new Map<number, { resident: number; to: BuildingId; car: number }>();
    for (const car of cars.cars.values()) {
      if (sent.size >= 5) break;
      const r = city.population.residents.find((x) => x.id === car.owner)!;
      const at = city.whereIs(r.id);
      const home = at === null ? null : city.doorOf(at);
      if (at !== r.home || !home) continue;
      const to = buildings.find((b) => {
        const door = city.doorOf(b.id);
        if (!door || b.id === at) return false;
        const d = Math.hypot(door.x - home.x, door.y - home.y);
        return d > m(160) && d < m(450) && kerbBays.some((bay) => bay.car === null && Math.hypot(bay.x - door.x, bay.y - door.y) < m(80));
      });
      if (!to) continue;
      if (city.goTo(sim, r.id, to.id) !== 'drive') continue;
      const trip = [...cars.trips.values()].find((t) => t.resident === r.id)!;
      sent.set(trip.trip, { resident: r.id, to: to.id, car: car.id });
    }
    expect(sent.size).toBeGreaterThan(2);

    const walls = buildings.flatMap((b) => solidFootprints(b));
    const inWalls = (x: number, y: number): boolean => walls.some((ring) => pointInPolygon({ x, y }, ring));
    const last = new Map<number, { x: number; y: number }>();
    let jumps = 0;
    let throughWalls = 0;
    // Each car as it stood when its driver began to get out: the parked pose.
    // (Later, its owner may set off again for reasons of their own.)
    const parked = new Map<number, { bay: NonNullable<OwnCarOf['bay']>; f: NonNullable<NonNullable<OwnCarOf['body']>['free']> }>();
    sim.clock.run(Math.round(300 / DT), () => {
      if ([...sent.keys()].every((id) => { const t = cars.trips.get(id); return !t || t.phase === 'fromCar'; })) return;
      step(sim);
      for (const [trip, s] of sent) {
        const t = cars.trips.get(trip);
        if (parked.has(trip) || !t || t.phase !== 'alight') continue;
        const car = [...cars.cars.values()].find((c) => c.id === s.car)!;
        if (car.bay && car.body?.free) parked.set(trip, { bay: car.bay, f: { ...car.body.free } });
      }
      for (const car of cars.cars.values()) {
        const v = car.body ?? sim.vehicles.get(car.id);
        if (!v) continue;
        const p = vehiclePose(sim, v, 1);
        if (!p) continue;
        if (v.free && v.v > 0 && inWalls(p.p.x, p.p.y)) throughWalls++;
        const before = last.get(car.id);
        if (before && Math.hypot(p.p.x - before.x, p.p.y - before.y) > m(1)) jumps++;
        last.set(car.id, { x: p.p.x, y: p.p.y });
      }
    });

    let inKerbBay = 0;
    let alongKerb = 0;
    for (const trip of sent.keys()) {
      const at = parked.get(trip);
      if (!at?.bay.kerb) continue;
      inKerbBay++;
      const { bay, f } = at;
      // Nose along the kerb, the way the traffic beside it goes (`-o`).
      const aligned = Math.cos(f.angle) * -bay.ox + Math.sin(f.angle) * -bay.oy;
      const off = Math.hypot(f.x - bay.x, f.y - bay.y);
      if (aligned > 0.98 && off < m(0.3)) alongKerb++;
      else console.log(`off the kerb: trip ${trip} angle ${(Math.acos(Math.max(-1, Math.min(1, aligned))) * 180 / Math.PI).toFixed(1)} deg, ${(off / m(1)).toFixed(2)} m from the bay; neighbours ${cars.bays.filter((b) => b !== bay && b.car !== null && Math.hypot(b.x - bay.x, b.y - bay.y) < m(8)).length}`);
    }
    const report = { kerbBays: kerbBays.length, sent: sent.size, inKerbBay, alongKerb, jumps, throughWalls,
      inside: [...sent.values()].filter((s) => city.whereIs(s.resident) === s.to).length,
      // Where each one got to: the step of a trip still under way, the kind of bay of one over.
      ends: [...sent.keys()].map((trip) => cars.trips.get(trip)?.phase ?? (parked.get(trip)?.bay.kerb ? 'kerb' : 'lot')) };
    console.log(`kerb parking: ${JSON.stringify(report)}`);
    expect(report.inKerbBay).toBe(report.sent);
    expect(report.alongKerb).toBe(report.sent);
    expect(report.jumps).toBe(0);
    expect(report.throughWalls).toBe(0);
  }, 300_000);
});
