import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';

/**
 * Nannies (`population.ts` `hireNannies`, the posts of a home in
 * `activities.ts`): in the default town on a weekday morning, families whose
 * adults all work have one; at the family's home in their hours they look
 * after the children, clean or cook there.
 */
describe('jobs: nannies', () => {
  it('a nanny works at the family home: children, cleaning, cooking', () => {
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
    sim.city.skip(3 * 60);
    const city = sim.city;
    const seen = new Map<string, number>();
    let nannies = 0;
    sim.clock.run(Math.round(300 / DT), () => {
      step(sim);
    });
    for (const r of city.population.residents) {
      const v = city.describe(r.id);
      if (v?.job !== 'nanny') continue;
      nannies++;
      const doing = city.doingOf(r.id);
      if (doing && v.at === r.work) seen.set(doing.kind, (seen.get(doing.kind) ?? 0) + 1);
    }
    console.log(`nannies ${nannies}, at work doing ${JSON.stringify([...seen])}`);
    expect(nannies).toBeGreaterThan(0);
    expect([...seen.keys()].some((k) => k === 'childcare' || k === 'clean' || k === 'cook')).toBe(true);
  }, 300_000);
});
