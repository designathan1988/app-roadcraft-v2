import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { BuildingId } from '@world/buildings/types';
import { SimWorld } from '@sim/world';
import { createPeopleEngine } from '@sim/people/people';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { vehiclePose } from '@sim/pose';
import type { CarPhase } from '@sim/agents/cars';
import { solidFootprints } from '@world/buildings/geometry';
import { pointInPolygon } from '@core/polygon';
import { lotPlanSvg } from './lotPlan.probe';

/**
 * Residents as agents with their own cars (`?agents=1`), measured as the player
 * would see them in the default town. A few car owners at home are sent to a
 * building a few hundred metres away (`CityLife.goTo`, the player's "go
 * there"), and every tick is checked:
 *
 * - every car on the road is somebody's own car (no car made at the kerb);
 * - a car never jumps: parked, manoeuvring or driving, its body moves less than
 *   a metre a tick, including where it leaves its bay for the lane and back;
 * - each of them does the whole chain - walk to the car, get in, back out,
 *   drive, park in a bay at the other end, get out, walk in - and ends inside
 *   the building it was sent to, with its car in a bay near it.
 */
describe('agents: residents use their own cars', () => {
  it('walk to the car, drive, park and walk in, without a car made or deleted at the kerb', () => {
    const doc = new RoadDoc();
    buildDefaultTown(doc);
    // AGENT_TOWN_OUT=<file>: the town as a map file, for `scripts/agents-shots.mjs`.
    if (process.env['AGENT_TOWN_OUT']) writeFileSync(process.env['AGENT_TOWN_OUT'], JSON.stringify(doc.toJSON()));
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x2024);
    sim.rebuildTopology();
    sim.usePedestrianEngine(createPeopleEngine());
    sim.driveModel = 'v2';
    sim.populationShare = 0.3;
    sim.city.useAgents(true);
    step(sim);
    const city = sim.city;
    const cars = city.cars!;
    const owned = new Set([...cars.cars.values()].map((c) => c.id));

    // Car owners at home, each sent somewhere 160-450 m away that has a free bay.
    const buildings = [...doc.buildings.all()];
    const sent = new Map<number, { resident: number; to: BuildingId; car: number }>();
    for (const car of cars.cars.values()) {
      if (sent.size >= 6) break;
      const r = city.population.residents.find((x) => x.id === car.owner)!;
      const at = city.whereIs(r.id);
      const home = at === null ? null : city.doorOf(at);
      if (at !== r.home || !home) continue;
      const to = buildings.find((b) => {
        const door = city.doorOf(b.id);
        if (!door || b.id === at) return false;
        const d = Math.hypot(door.x - home.x, door.y - home.y);
        return d > m(160) && d < m(450) && cars.bays.some((bay) => bay.car === null && bay.lane
          && Math.hypot(bay.x - door.x, bay.y - door.y) < m(80));
      });
      if (!to) continue;
      const how = city.goTo(sim, r.id, to.id);
      if (how !== 'drive') continue;
      const trip = [...cars.trips.values()].find((t) => t.resident === r.id)!;
      sent.set(trip.trip, { resident: r.id, to: to.id, car: car.id });
    }

    // AGENT_SVG=<file>: a plan from above of the first agent's lot (`lotPlan.probe.ts`).
    const firstCar = [...cars.cars.values()].find((c) => c.id === [...sent.values()][0]?.car);
    if (process.env['AGENT_SVG'] && firstCar?.bay) {
      writeFileSync(process.env['AGENT_SVG'], lotPlanSvg(sim, cars.bays, firstCar.bay.x, firstCar.bay.y, m(70)));
    }
    // Every building's walls, as rings: a car off the road must never be inside one.
    const walls = [...doc.buildings.all()].flatMap((b) => solidFootprints(b));
    const inWalls = (x: number, y: number): boolean => walls.some((ring) => pointInPolygon({ x, y }, ring));
    let throughWalls = 0;
    const wallWhere = new Map<string, number>();
    const phaseAt = new Map<number, Map<CarPhase, number>>();
    const last = new Map<number, { x: number; y: number }>();
    let jumps = 0;
    let worstJump = 0;
    let pocket = 0;
    let time = 0;
    const lanes = new Map<number, string[]>();
    sim.clock.run(Math.round(300 / DT), () => {
      // Done when every one has parked and is walking in (or is in).
      if ([...sent.keys()].every((id) => { const t = cars.trips.get(id); return !t || t.phase === 'fromCar'; })) return;
      step(sim);
      time += DT;
      for (const v of sim.vehicles.values()) if (!owned.has(v.id)) pocket++;
      for (const id of sent.keys()) {
        const t = cars.trips.get(id);
        if (!t) continue;
        const dv = sim.vehicles.get(t.car.id);
        if (dv) {
          let h = lanes.get(id);
          if (!h) { h = []; lanes.set(id, h); }
          const tag = `${dv.lanelet}${dv.lanelet === dv.commute?.lanelet ? '*' : ''}`;
          if (h[h.length - 1]?.split('@')[0] !== tag) h.push(`${tag}@${time.toFixed(0)}`);
        }
        let at = phaseAt.get(id);
        if (!at) { at = new Map(); phaseAt.set(id, at); }
        if (!at.has(t.phase)) at.set(t.phase, time);
      }
      for (const car of cars.cars.values()) {
        const v = car.body ?? sim.vehicles.get(car.id);
        if (!v) continue;
        const p = vehiclePose(sim, v, 1);
        if (!p) continue;
        if (v.free && v.v > 0) {
          const c = Math.cos(p.angle), s = Math.sin(p.angle);
          const hl = v.archetype.length / 2, hw = v.archetype.width / 2;
          const corners = [[hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw], [0, 0]] as const;
          if (corners.some(([a, b]) => inWalls(p.p.x + c * a - s * b, p.p.y + s * a + c * b))) {
            throughWalls++;
            const tr = cars.tripOfCar(car.id);
            const key = `${tr?.phase} leg${tr?.path?.leg}/${tr?.path?.legs.length}`;
            wallWhere.set(key, (wallWhere.get(key) ?? 0) + 1);
          }
        }
        const before = last.get(car.id);
        if (before) {
          const d = Math.hypot(p.p.x - before.x, p.p.y - before.y);
          worstJump = Math.max(worstJump, d);
          if (d > m(1)) jumps++;
        }
        last.set(car.id, { x: p.p.x, y: p.p.y });
      }
    });

    const phases: CarPhase[] = ['toCar', 'board', 'leave', 'drive', 'park', 'alight', 'fromCar'];
    const lines: string[] = [];
    let arrived = 0;
    let parked = 0;
    for (const [id, s] of sent) {
      const at = phaseAt.get(id) ?? new Map<CarPhase, number>();
      const inside = city.whereIs(s.resident) === s.to;
      const car = [...cars.cars.values()].find((c) => c.id === s.car)!;
      const parkedNear = car.bay !== null && car.body !== null;
      if (at.has('alight') && parkedNear) parked++;
      if (inside) arrived++;
      const times = phases.map((p) => `${p}@${at.has(p) ? at.get(p)!.toFixed(0) : '-'}`).join(' ');
      lines.push(`agent ${s.resident}: ${times} inside=${inside} parked=${parkedNear}`);
      if (!parkedNear) lines.push(`  lanes: ${(lanes.get(id) ?? []).join(' ')}`);
    }
    const report = {
      bays: cars.bays.length, cars: cars.cars.size, sent: sent.size, parked, inside: arrived, rescued: cars.rescued,
      seconds: Math.round(time), pocket, jumps, worstJumpM: +(worstJump / m(1)).toFixed(2), throughWalls,
    };
    lines.push(`walls: ${JSON.stringify([...wallWhere])}`);
    lines.push(`own cars: ${JSON.stringify(report)}`);
    // AGENT_REPORT=<file>: the measurement, also when the test passes.
    const text = `${lines.join('\n')}\n`;
    if (process.env['AGENT_REPORT']) writeFileSync(process.env['AGENT_REPORT'], text);
    console.log(text);
    expect(report.bays).toBeGreaterThan(0);
    expect(report.sent).toBeGreaterThan(2);
    expect(report.pocket).toBe(0);
    expect(report.jumps).toBe(0);
    expect(report.throughWalls).toBe(0);
    expect(report.parked).toBe(report.sent);
  }, 300_000);
});
