import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT, PED } from '@sim/params';
import { createAgentWalkEngine, inspectAgentWalkers } from '@sim/agents/walk';
import { vehiclePose } from '@sim/pose';

/**
 * The agents' walking (`sim/agents/walk.ts`), measured on the drawn body
 * (`PedView`) every tick in the default town on an evening, when residents go
 * out for their own reasons:
 *
 * - nobody jumps: a body moves at most a walker's top speed in a tick;
 * - nobody walks backwards: a moving body moves the way it faces;
 * - nobody slides sideways faster than a sidestep;
 * - nobody stands inside somebody else: a crowd leaving one building comes out
 *   one after another; nobody walks through a car manoeuvring off the road;
 * - walks end: people arrive, and nobody is held still for good;
 * - at zebras people wait at the kerb, and not for ever.
 */
describe('agents: residents walk on the footways', () => {
  it('walk where they are going without jumps, backward steps or locks', () => {
    const doc = new RoadDoc();
    buildDefaultTown(doc);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x2024);
    sim.rebuildTopology();
    sim.usePedestrianEngine(createAgentWalkEngine());
    sim.driveModel = 'v2';
    sim.populationShare = 0.3;
    sim.city.useAgents(true);
    sim.city.skip(11 * 60);

    const top = PED.maxSpeed * 1.15;
    let ticks = 0, bodies = 0, jumps = 0, backward = 0, slides = 0, maxWait = 0, maxHeld = 0, crossing = 0;
    let worstJump = 0, worstSlide = 0, overlapTicks = 0, inCar = 0, carTicks = 0, underTraffic = 0;
    const started = new Set<number>();
    let arrived = 0;
    const walking = new Set<number>();
    sim.clock.run(Math.round(150 / DT), () => {
      step(sim);
      ticks++;
      for (const t of sim.city.trips.values()) if (t.mode === 'walk') started.add(t.id);
      const now = new Set<number>();
      for (const v of sim.pedViews) {
        now.add(v.id);
        bodies++;
        const dx = v.x - v.prev.x, dy = v.y - v.prev.y;
        const moved = Math.hypot(dx, dy);
        if (moved > top * DT + m(0.02)) { jumps++; worstJump = Math.max(worstJump, moved / DT); }
        const along = dx * Math.cos(v.heading) + dy * Math.sin(v.heading);
        const side = Math.abs(-dx * Math.sin(v.heading) + dy * Math.cos(v.heading));
        if (moved > m(0.2) * DT && along < -m(0.05) * DT) backward++;
        if (side / DT > m(0.8)) { slides++; worstSlide = Math.max(worstSlide, side / DT); }
        maxWait = Math.max(maxWait, v.kerbWait);
        if (v.ground === 'crossing') crossing++;
      }
      // Bodies inside one another: pairs closer than a shoulder's width.
      const views = sim.pedViews;
      for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) {
        if (Math.hypot(views[i]!.x - views[j]!.x, views[i]!.y - views[j]!.y) < m(0.3)) overlapTicks++;
      }
      // Walkers inside a moving car's outline (cars off the road: bays, drives, lots).
      for (const car of sim.city.cars?.offRoad() ?? []) {
        const f = car.free;
        if (!f || Math.abs(car.v) < m(0.05)) continue;
        carTicks++;
        const hl = car.archetype.length / 2, hw = car.archetype.width / 2;
        for (const v of views) {
          const rx = v.x - f.x, ry = v.y - f.y;
          const a = rx * Math.cos(f.angle) + ry * Math.sin(f.angle), b = -rx * Math.sin(f.angle) + ry * Math.cos(f.angle);
          if (Math.abs(a) < hl && Math.abs(b) < hw) inCar++;
        }
      }
      // Walkers inside a vehicle of the traffic (on a zebra, at a road end).
      for (const veh of sim.vehicles.values()) {
        const pose = vehiclePose(sim, veh, 1);
        if (!pose) continue;
        const hl = veh.archetype.length / 2, hw = veh.archetype.width / 2;
        for (const v of views) {
          const rx = v.x - pose.p.x, ry = v.y - pose.p.y;
          if (Math.abs(rx * Math.cos(pose.angle) + ry * Math.sin(pose.angle)) < hl && Math.abs(-rx * Math.sin(pose.angle) + ry * Math.cos(pose.angle)) < hw) underTraffic++;
        }
      }
      for (const id of walking) if (!now.has(id)) arrived++;
      walking.clear();
      for (const id of now) walking.add(id);
      for (const p of inspectAgentWalkers(sim)) maxHeld = Math.max(maxHeld, p.held);
    });
    const u = m(1);
    console.log(`walk: ${ticks} ticks, ${bodies} body-ticks, walks started ${started.size}, arrived ${arrived}, `
      + `on zebras ${crossing} body-ticks, jumps ${jumps} (worst ${(worstJump / u).toFixed(2)} m/s), backward ${backward}, `
      + `slides ${slides} (worst ${(worstSlide / u).toFixed(2)} m/s), overlapping pair-seconds ${(overlapTicks * DT).toFixed(1)}, `
      + `inside a manoeuvring car ${inCar} body-ticks (of ${carTicks} car-ticks), inside a vehicle on the road ${underTraffic}, longest kerb wait ${maxWait.toFixed(1)} s, longest hold ${maxHeld.toFixed(1)} s`);
    expect(started.size).toBeGreaterThan(20);
    expect(arrived).toBeGreaterThan(10);
    expect(crossing).toBeGreaterThan(0);
    expect(jumps).toBe(0);
    expect(backward).toBe(0);
    expect(slides).toBe(0);
    expect(maxWait).toBeLessThan(90);
    expect(inCar).toBe(0);
    expect(underTraffic).toBe(0);
    expect(maxHeld).toBeLessThan(12);
    // Two bodies brushing as they pass, a thousandth of the time at most.
    expect(overlapTicks / bodies).toBeLessThan(0.001);
  }, 300_000);

  it('take turns with a car crossing the footway out of or into a bay: nobody walks into it, nobody waits for ever', () => {
    const doc = new RoadDoc();
    buildDefaultTown(doc);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x2024);
    sim.rebuildTopology();
    const engine = createAgentWalkEngine();
    sim.usePedestrianEngine(engine);
    sim.driveModel = 'v2';
    sim.populationShare = 0.3;
    sim.city.useAgents(true);
    step(sim);
    const city = sim.city;
    const cars = city.cars!;
    // Car owners at home sent a few hundred metres away: they back out, drive and park.
    const buildings = [...doc.buildings.all()];
    let sentCars = 0;
    for (const car of cars.cars.values()) {
      if (sentCars >= 8) break;
      const at = city.whereIs(car.owner);
      const home = at === null ? null : city.doorOf(at);
      if (!home) continue;
      const to = buildings.find((b) => {
        const door = city.doorOf(b.id);
        if (!door || b.id === at) return false;
        const d = Math.hypot(door.x - home.x, door.y - home.y);
        return d > m(160) && d < m(450) && cars.bays.some((bay) => bay.car === null && bay.lane
          && Math.hypot(bay.x - door.x, bay.y - door.y) < m(80));
      });
      if (to && city.goTo(sim, car.owner, to.id) === 'drive') sentCars++;
    }
    expect(sentCars).toBeGreaterThan(2);

    // Whenever one of them is moving off the road beside a footway, three
    // people are sent along that footway through where it is.
    const SECONDS = 200;
    const seeded = new Set<number>();
    const sentAt = new Map<number, number>();
    let trip = 900_000, inCar = 0, crossings = 0, tick = 0;
    const near = (x: number, y: number) => engine.walkableNear!.call(engine, sim, x, y, m(6));
    sim.clock.run(Math.round(SECONDS / DT), () => {
      step(sim);
      tick++;
      for (const t of cars.trips.values()) {
        const body = t.car.body;
        if (seeded.has(t.trip) || !body?.free || Math.abs(body.v) < m(0.2)) continue;
        const f = body.free;
        const here = near(f.x, f.y);
        if (!here) continue;
        // Along the footway: the two far ends that are both on it.
        let best: [{ x: number; y: number }, { x: number; y: number }] | null = null, bestD = 0;
        for (const a of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
          const dx = Math.cos(a) * m(12), dy = Math.sin(a) * m(12);
          const p = near(here.x + dx, here.y + dy), q = near(here.x - dx, here.y - dy);
          if (p && q && Math.hypot(p.x - q.x, p.y - q.y) > bestD) { bestD = Math.hypot(p.x - q.x, p.y - q.y); best = [p, q]; }
        }
        if (!best || bestD < m(15)) continue;
        seeded.add(t.trip);
        crossings++;
        for (const [a, b] of [[best[0], best[1]], [best[1], best[0]], [best[0], best[1]]] as const) {
          const id = engine.walkTrip!.call(engine, sim, { trip: trip++, fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, seed: trip, ageClass: 'adult' });
          if (id !== null) sentAt.set(id, tick * DT);
        }
      }
      // Anybody inside the outline of a car that is moving off the road.
      for (const car of cars.offRoad()) {
        const f = car.free;
        if (!f || Math.abs(car.v) < m(0.05)) continue;
        const hl = car.archetype.length / 2, hw = car.archetype.width / 2;
        for (const v of sim.pedViews) {
          const rx = v.x - f.x, ry = v.y - f.y;
          if (Math.abs(rx * Math.cos(f.angle) + ry * Math.sin(f.angle)) < hl && Math.abs(-rx * Math.sin(f.angle) + ry * Math.cos(f.angle)) < hw) inCar++;
        }
      }
    });
    // A minute is long enough for 24 m and any wait for a car: those sent a
    // minute or more before the end have all arrived.
    const late = [...sentAt].filter(([id, at]) => at < SECONDS - 60 && sim.pedViewById.has(id)).length;
    console.log(`cars across the footway: ${crossings} met by ${sentAt.size} walkers; inside a car ${inCar} body-ticks; `
      + `walking a minute after they were sent ${late}`);
    expect(crossings).toBeGreaterThan(0);
    expect(inCar).toBe(0);
    expect(late).toBe(0);
  }, 300_000);

  it('cross the end of a street that leads nowhere in a gap in the traffic', () => {
    // One straight street, both ends leading off the map: traffic comes in
    // and goes out by them, and people go from one side to the other round
    // its end (the only way across: no zebra anywhere).
    const doc = new RoadDoc();
    const a = doc.addNode({ x: -150, y: 0 }), b = doc.addNode({ x: 150, y: 0 });
    doc.addSegment(a.id, b.id, 1);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x7ead);
    sim.rebuildTopology();
    const engine = createAgentWalkEngine();
    sim.usePedestrianEngine(engine);
    sim.driveModel = 'v2';
    // Traffic at the game's default.
    sim.trafficIntensity = 2;
    sim.demandMultiplier = 2;
    sim.clock.paused = false;
    const near = (x: number, y: number) => engine.walkableNear!.call(engine, sim, x, y, m(8));
    const north = near(-130, 12), south = near(-130, -12);
    expect(north && south).toBeTruthy();
    const SECONDS = 240;
    const sentAt = new Map<number, number>();
    let trip = 1, under = 0, onEnd = 0, waits = 0, tick = 0, vehicles = 0;
    sim.clock.run(Math.round(SECONDS / DT), () => {
      step(sim, { traffic: true, pedestrians: true });
      tick++;
      // Somebody sets off every ten seconds, either way.
      if (tick % Math.round(10 / DT) === 1 && tick * DT < SECONDS - 60) {
        const [from, to] = trip % 2 ? [north!, south!] : [south!, north!];
        const id = engine.walkTrip!.call(engine, sim, { trip: trip++, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, seed: trip, ageClass: 'adult' });
        if (id !== null) sentAt.set(id, tick * DT);
      }
      vehicles = Math.max(vehicles, sim.vehicles.size);
      for (const v of sim.pedViews) {
        if (v.ground === 'crossing') onEnd++;
        if (v.kerbWait > 0) waits++;
        for (const veh of sim.vehicles.values()) {
          const pose = vehiclePose(sim, veh, 1);
          if (!pose) continue;
          const rx = v.x - pose.p.x, ry = v.y - pose.p.y;
          if (Math.abs(rx * Math.cos(pose.angle) + ry * Math.sin(pose.angle)) < veh.archetype.length / 2
            && Math.abs(-rx * Math.sin(pose.angle) + ry * Math.cos(pose.angle)) < veh.archetype.width / 2) under++;
        }
      }
    });
    const late = [...sentAt.keys()].filter((id) => sim.pedViewById.has(id)).length;
    console.log(`road end: ${sentAt.size} sent, up to ${vehicles} vehicles, ${(onEnd * DT).toFixed(0)} s on the crossing, `
      + `${(waits * DT).toFixed(0)} s waiting for a gap, inside a vehicle ${under} body-ticks, still walking ${late}`);
    expect(sentAt.size).toBeGreaterThan(10);
    expect(vehicles).toBeGreaterThan(0);
    expect(onEnd).toBeGreaterThan(0);
    expect(under).toBe(0);
    expect(late).toBe(0);
  }, 300_000);
});
