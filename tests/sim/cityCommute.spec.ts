import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { createPeopleEngine } from '@sim/people/people';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';

describe('default town commute', () => {
  it('brings residents into work and completes trips after the morning rush starts', () => {
    const doc = new RoadDoc();
    buildDefaultTown(doc);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 0x2024);
    sim.rebuildTopology();
    sim.usePedestrianEngine(createPeopleEngine());
    sim.driveModel = 'v2';
    step(sim);
    sim.city.skip(95);
    const completedBefore = sim.city.completed;
    sim.clock.run(Math.round(120 / DT), () => step(sim));
    const counts = sim.city.counts();
    console.log(`commute: working=${counts.atWork} completed=${sim.city.completed} walking=${counts.walking} driving=${counts.driving}`);
    expect(counts.atWork).toBeGreaterThan(0);
    expect(sim.city.completed).toBeGreaterThan(completedBefore);
  }, 300_000);
});
