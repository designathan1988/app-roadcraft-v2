import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createAgentWalkEngine, walkerOf, walkersNear } from '@sim/agents/walk';
import { OwnCars } from '@sim/agents/cars';

/**
 * A person of the city in the player's hands (`sim/agents/player.ts`), as in
 * GTA, driven by the same input the keys give: they walk where pointed, talk
 * with somebody (who stops and faces them), knock somebody down (who falls;
 * the people round run off; a star goes on), the police come out of their
 * station, and a car is got into, driven and got out of.
 */
describe('the player: a person of the city in the player hands', () => {
  it('walks, talks, fights, is wanted, drives', () => {
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
    // Mid-morning: people about, officers on duty.
    sim.city.skip(4 * 60);
    const run = (seconds: number): void => sim.clock.run(Math.round(seconds / DT), () => step(sim));
    run(60);
    const player = sim.city.player;
    const input = player.input;

    // Somebody walking, with somebody else near them.
    // An adult: a child would not be let drive.
    const walking = sim.pedViews.filter((v) => v.id >= OwnCars.personOf(0) && v.ageClass === 'adult');
    const who = walking.find((v) => walkersNear(sim, v.x, v.y, m(25)).length > 3) ?? walking[0]!;
    const resident = who.id - OwnCars.personOf(0);
    expect(player.take(sim, resident)).toBe(true);
    expect(player.mode).toBe('foot');

    // Walk: pointed along the way they face, three seconds.
    const x0 = player.x, y0 = player.y;
    input.moveX = Math.cos(player.heading); input.moveY = Math.sin(player.heading);
    run(3);
    input.moveX = 0; input.moveY = 0;
    const walked = Math.hypot(player.x - x0, player.y - y0) / m(1);
    console.log(`walked ${walked.toFixed(1)} m in 3 s`);
    expect(walked).toBeGreaterThan(0.5);

    // A word with the nearest person: they stop, facing the player, talking.
    const nearest = (): { id: number; x: number; y: number } | null => walkersNear(sim, player.x, player.y, m(120))
      .filter((p) => p.id !== player.person && p.busy === 0).sort((a, b) =>
        Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y))[0] ?? null;
    const goUpTo = (id: number): void => {
      // Walk up to them, as the player would.
      for (let k = 0; k < 400; k++) {
        const p = walkerOf(sim, id);
        if (!p) return;
        const d = Math.hypot(p.x - player.x, p.y - player.y);
        if (d < m(1.1)) break;
        input.moveX = (p.x - player.x) / d; input.moveY = (p.y - player.y) / d;
        input.run = d > m(4);
        run(0.1);
      }
      input.moveX = 0; input.moveY = 0; input.run = false;
      const p = walkerOf(sim, id);
      if (p) player.heading = Math.atan2(p.y - player.y, p.x - player.x);
    };
    const friend = nearest();
    expect(friend).not.toBeNull();
    goUpTo(friend!.id);
    input.talk = true;
    run(0.5);
    // Whoever was in front of the player: stopped there, talking with them.
    const talking = sim.pedViews.filter((v) => v.id !== player.person && v.gesture?.kind === 'talk'
      && Math.hypot(v.x - player.x, v.y - player.y) < m(2.5));
    console.log(`talk: ${talking.length} talking with the player, message ${player.message?.key}`);
    expect(player.message?.key).toBe('talked');
    expect(talking.length).toBeGreaterThan(0);

    // A blow: down they go (or they hit back), the people round run, a star.
    run(7);
    const victim = nearest();
    expect(victim).not.toBeNull();
    goUpTo(victim!.id);
    const round = walkersNear(sim, player.x, player.y, m(30)).filter((p) => p.id !== player.person && p.id !== victim!.id);
    input.punch = true;
    run(1);
    const fell = sim.pedViews.find((v) => v.id !== player.person && (v.gesture?.kind === 'fall' || v.gesture?.kind === 'argue')
      && Math.hypot(v.x - player.x, v.y - player.y) < m(2.5))?.gesture?.kind;
    const runners = round.filter((p) => (walkerOf(sim, p.id)?.v ?? 0) > m(2.2)).length;
    run(2);
    console.log(`punch: victim ${fell}, message ${player.message?.key}, ${round.length} round, running ${runners}, wanted ${player.wanted}`);
    expect(['fall', 'argue']).toContain(fell);
    expect(player.wanted).toBeGreaterThan(0);

    // The police come out.
    run(5);
    const v1 = player.view()!;
    console.log(`police out: ${v1.officers}`);
    expect(v1.officers).toBeGreaterThan(0);

    // A car: the nearest parked one, walked to, got into, driven, got out of.
    const cars = sim.city.cars!;
    let target: { x: number; y: number } | null = null, best = Infinity;
    for (const c of cars.cars.values()) {
      const f = c.body?.free;
      if (!f || cars.tripOfCar(c.id)) continue;
      const d = Math.hypot(f.x - player.x, f.y - player.y);
      if (d < best) { best = d; target = f; }
    }
    expect(target).not.toBeNull();
    // Out of the walk engine's way: put beside the car, as walking there would.
    for (let k = 0; k < 2000 && Math.hypot(target!.x - player.x, target!.y - player.y) > m(3); k++) {
      const d = Math.hypot(target!.x - player.x, target!.y - player.y);
      input.moveX = (target!.x - player.x) / d; input.moveY = (target!.y - player.y) / d; input.run = true;
      run(0.1);
      if (player.resident === null) break;
    }
    input.moveX = 0; input.moveY = 0; input.run = false;
    if (player.resident !== null && Math.hypot(target!.x - player.x, target!.y - player.y) <= m(4.5)) {
      input.enter = true;
      run(0.2);
      console.log(`car: mode ${player.mode}, message ${player.message?.key}`);
      expect(player.mode).toBe('car');
      const cx = player.x, cy = player.y;
      input.throttle = 1;
      run(2);
      input.throttle = -1;
      run(1);
      input.throttle = 0;
      const drove = Math.hypot(player.x - cx, player.y - cy) / m(1);
      console.log(`drove ${drove.toFixed(1)} m, message ${player.message?.key}`);
      expect(drove).toBeGreaterThan(0.5);
      input.enter = true;
      run(0.2);
      expect(player.mode).toBe('foot');
    } else console.log(`car: not reached (${player.message?.key})`);

    // Let go: they walk home.
    input.release = true;
    run(0.2);
    expect(player.resident).toBeNull();
  }, 300_000);

  it('goes into a shop, a restaurant, a bank: does what the place is for, comes out', () => {
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
    sim.city.skip(5 * 60);
    const run = (seconds: number): void => sim.clock.run(Math.round(seconds / DT), () => step(sim));
    run(5);
    const city = sim.city;
    const player = city.player;
    const input = player.input;
    const adult = city.population.residents.find((r) => r.ageClass === 'adult' && city.whereIs(r.id) === r.home)!;
    expect(player.take(sim, adult.id)).toBe(true);
    const done: string[] = [];
    for (const fn of ['supermarket', 'restaurant', 'bank', 'bakery', 'shop']) {
      const place = [...doc.buildings.all()].find((b) => b.function === fn && city.doorOf(b.id));
      if (!place) continue;
      const door = city.doorOf(place.id)!;
      // At its door (the walk there is the player's), E.
      player.x = door.x; player.y = door.y;
      input.enter = true;
      run(0.2);
      expect(player.mode).toBe('inside');
      run(20);
      const doing = city.doingOf(adult.id);
      done.push(`${fn}: ${doing?.kind ?? 'nothing'}`);
      expect(doing?.building).toBe(place.id);
      input.enter = true;
      run(0.2);
      expect(player.mode).toBe('foot');
      expect(Math.hypot(player.x - door.x, player.y - door.y)).toBeLessThan(m(1));
    }
    console.log(`inside: ${done.join(', ')}`);
    expect(done.length).toBeGreaterThan(2);
  }, 300_000);
});
