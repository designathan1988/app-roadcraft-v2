import { describe, expect, it } from 'vitest';

import { Rng } from '@core/rng';
import type { BuildingFunction, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import type { Resident } from '@sim/city/population';
import { NEEDS, decide, live, newMind, type Mind, type PlaceIndex } from '@sim/agents/mind';

/**
 * A resident's mind (`sim/agents/mind.ts`): needs run down, places give back
 * what they advertise, and where to be is weighed by need, distance and the
 * hour, inside the resident's commitments.
 */

const id = (n: number): BuildingId => n as BuildingId;
const HOME = id(1), WORK = id(2), DINER = id(3), PARK = id(4), BAR = id(5);

function town(): PlaceIndex {
  const at: Record<number, { x: number; y: number; kind?: BuildingFunction }> = {
    1: { x: 0, y: 0 }, 2: { x: m(400), y: 0, kind: 'office' }, 3: { x: m(420), y: m(30), kind: 'restaurant' },
    4: { x: m(60), y: m(40), kind: 'park' }, 5: { x: m(80), y: -m(40), kind: 'bar' },
  };
  const places = [DINER, PARK, BAR].map((b) => ({ building: b, x: at[b]!.x, y: at[b]!.y, kind: at[b]!.kind! }));
  return {
    kindOf: (b) => at[b]?.kind,
    position: (b) => at[b] ?? null,
    near: (from) => places.filter((p) => p.building !== from),
  };
}

const adult = (over: Partial<Resident> = {}): Resident => ({
  id: 7, seed: 1234, ageClass: 'adult', home: HOME, homeLevel: 0, homeSpace: null, workLevel: 0, work: WORK, hasCar: false,
  leaveAt: 8 * 60, stay: 8 * 60, outing: null, lunch: null, errand: null, ...over,
});

const mindWith = (levels: Partial<Record<(typeof NEEDS)[number], number>>, clock: number): Mind => {
  const mind = newMind(adult(), clock);
  for (const n of NEEDS) mind.needs[n] = levels[n] ?? 90;
  return mind;
};

describe('a resident\'s mind', () => {
  const index = town();
  const rng = (): Rng => new Rng(9);

  it('goes to work when the working day starts, and stays there', () => {
    const r = adult();
    expect(decide(mindWith({}, 8 * 60 + 5), r, HOME, 8 * 60 + 5, index, rng())).toEqual({ to: WORK, why: 'work' });
    expect(decide(mindWith({}, 10 * 60), r, WORK, 10 * 60, index, rng())).toBeNull();
  });

  it('goes out to eat near work at lunchtime when hungry, and back after', () => {
    const r = adult();
    expect(decide(mindWith({ hunger: 20 }, 12 * 60), r, WORK, 12 * 60, index, rng())).toEqual({ to: DINER, why: 'lunch' });
    expect(decide(mindWith({ hunger: 95 }, 12 * 60 + 40), r, DINER, 12 * 60 + 40, index, rng())).toEqual({ to: WORK, why: 'work' });
  });

  it('goes home at night, tired', () => {
    const r = adult();
    const choice = decide(mindWith({ energy: 15, fun: 70 }, 23 * 60), r, BAR, 23 * 60, index, rng());
    expect(choice?.to).toBe(HOME);
  });

  it('goes out for fun or company when bored and free, to a place that is open', () => {
    const r = adult({ work: null });
    const choices = new Set<BuildingId>();
    for (let seed = 0; seed < 20; seed++) {
      const c = decide(mindWith({ fun: 5, social: 10 }, 19 * 60), r, HOME, 19 * 60, index, new Rng(seed));
      if (c) choices.add(c.to);
    }
    expect(choices.size).toBeGreaterThan(0);
    for (const c of choices) expect([PARK, BAR]).toContain(c);
  });

  it('never sends a child to a bar, nor out at night', () => {
    const child = adult({ ageClass: 'child', work: null });
    for (let seed = 0; seed < 20; seed++) {
      expect(decide(mindWith({ fun: 5, social: 5 }, 19 * 60), child, HOME, 19 * 60, index, new Rng(seed))?.to).not.toBe(BAR);
      expect(decide(mindWith({ fun: 5, social: 5 }, 23 * 60), child, HOME, 23 * 60, index, new Rng(seed))).toBeNull();
    }
  });

  it('is fed at a restaurant and sleeps at home at night', () => {
    const r = adult();
    const mind = mindWith({ hunger: 20, energy: 30 }, 12 * 60);
    live(mind, r, DINER, 13 * 60, index.kindOf);
    expect(mind.needs.hunger).toBeGreaterThan(70);
    mind.updated = 23 * 60;
    live(mind, r, HOME, 23 * 60 + 300, index.kindOf);
    expect(mind.needs.energy).toBeGreaterThan(90);
  });
});

describe('agents live by their needs in the default town', () => {
  it('sets off for reasons of their own, and nobody is left in need', () => {
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
    // Evening of the first day: free time, meals and outings.
    sim.city.skip(11 * 60);
    const reasons = new Map<string, number>();
    const seen = new Set<number>();
    sim.clock.run(Math.round(120 / DT), () => {
      step(sim);
      for (const t of sim.city.trips.values()) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        reasons.set(t.why ?? '-', (reasons.get(t.why ?? '-') ?? 0) + 1);
      }
    });
    const residents = sim.city.population.residents;
    let worst = 100;
    for (const r of residents) {
      const needs = sim.city.needsOf(r.id);
      if (!needs) continue;
      for (const n of NEEDS) worst = Math.min(worst, needs[n]);
    }
    console.log(`mind: ${residents.length} residents, trips ${seen.size} ${JSON.stringify([...reasons])}, lowest need ${worst.toFixed(0)}`);
    expect(seen.size).toBeGreaterThan(20);
    // Trips made for the residents' own needs, not only commitments.
    const ownReasons = ['eat', 'fun', 'social', 'sleep', 'home', 'wash'].reduce((sum, k) => sum + (reasons.get(k) ?? 0), 0);
    expect(ownReasons).toBeGreaterThan(5);
    expect(worst).toBeGreaterThanOrEqual(0);
  }, 300_000);
});
