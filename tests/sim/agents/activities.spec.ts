import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { NEEDS } from '@sim/agents/mind';
import type { ActivityKind } from '@sim/agents/activities';

/**
 * What residents do inside (`sim/agents/activities.ts`), measured over a day
 * in the default town: at night they sleep in their own beds; in working
 * hours the workers are at their posts (a desk, a machine, a checkout) and
 * the pupils at their desks; out of hours people cook, eat, watch television,
 * wash, clean, go shopping, to the bank, out to eat, to friends; no piece of
 * furniture holds two people; nobody's needs fall to nothing.
 */
describe('agents: what residents do inside', () => {
  it('sleep at night, work at their posts by day, and live by their needs in between', () => {
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
    const residents = () => sim.city.population.residents;

    /** What everybody is doing now, by activity. */
    const census = (): Map<ActivityKind, number> => {
      const out = new Map<ActivityKind, number>();
      const pieces = new Set<string>();
      for (const r of residents()) {
        const d = sim.city.doingOf(r.id);
        if (!d) continue;
        out.set(d.kind, (out.get(d.kind) ?? 0) + 1);
        if (d.piece >= 0) {
          const key = `${d.building}:${d.level}:${d.piece}`;
          expect(pieces.has(key), `two people at ${key}`).toBe(false);
          pieces.add(key);
        }
      }
      return out;
    };
    // A skip, then forty game minutes lived (120 s): time to get to work, to settle.
    const run = (minutes: number): void => { sim.city.skip(minutes); sim.clock.run(Math.round(120 / DT), () => step(sim)); };
    const show = (name: string, c: Map<ActivityKind, number>): string => `${name}: ${JSON.stringify([...c].sort((a, b) => b[1] - a[1]))}`;

    // 03:00: the night (a skip, then forty game minutes lived).
    run(19 * 60 + 20);
    const night = census();
    // The morning lived through, 06:30 to 09:30: everybody off to work and school.
    sim.city.skip(3 * 60 + 10);
    sim.clock.run(Math.round(3 * 180 / DT), () => step(sim));
    const morning = census();
    // 19:30: the evening.
    run(9 * 60 + 20);
    const evening = census();
    console.log(show('03:00', night));
    console.log(show('09:30', morning));
    console.log(show('19:30', evening));
    let lowest = 100;
    for (const r of residents()) {
      const n = sim.city.needsOf(r.id);
      if (n) for (const k of NEEDS) lowest = Math.min(lowest, n[k]);
    }
    console.log(`lowest need ${lowest.toFixed(0)}`);

    const total = (c: Map<ActivityKind, number>): number => [...c.values()].reduce((a, b) => a + b, 0);
    // The night: most of those drawn are asleep.
    expect((night.get('sleep') ?? 0) / Math.max(1, total(night))).toBeGreaterThan(0.6);
    // The morning: at the posts of work and school.
    const working = ['computer', 'machine', 'checkout', 'reception', 'stock', 'serve', 'teach', 'study', 'treat', 'guard', 'mop', 'cook']
      .reduce((a, k) => a + (morning.get(k as ActivityKind) ?? 0), 0);
    expect(working).toBeGreaterThan(50);
    // The evening: the home's own life, and out.
    const homeLife = ['tv', 'cook', 'eat', 'snack', 'dishes', 'bath', 'clean', 'read', 'game', 'talk', 'nap', 'fix', 'childcare']
      .filter((k) => (evening.get(k as ActivityKind) ?? 0) > 0);
    expect(homeLife.length).toBeGreaterThanOrEqual(5);
    expect(lowest).toBeGreaterThan(0);
  }, 300_000);
});
