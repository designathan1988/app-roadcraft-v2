import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { CrimeSim } from '@sim/agents/crime';

/**
 * Crime in the streets (`sim/agents/crime.ts`): in the default town, an
 * afternoon. Measured: thieves go out and rob somebody walking; people near
 * run off and people farther stop and look; the police on duty run after the
 * thief and arrest them (held at the station) or the thief gets home.
 */
describe('crime and the police', () => {
  it('thieves rob, people run or look, officers chase and arrest', () => {
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
    // To the afternoon: 13:30.
    sim.city.skip(7 * 60);
    const city = sim.city;
    const stations = [...doc.buildings.all()].filter((b) => b.function === 'police').length;

    let mostOfficers = 0;
    const phases = new Set<string>();
    const heldAt = new Set<string>();
    sim.clock.run(Math.round(720 / DT), () => {
      step(sim);
      for (const c of city.crime.active()) { phases.add(c.phase); mostOfficers = Math.max(mostOfficers, c.officers); }
      for (const r of city.population.residents) {
        const v = city.describe(r.id);
        if (v?.crime === 'held' && v.at !== null) heldAt.add(doc.buildings.get(v.at)?.function ?? '?');
      }
    });
    const thieves = city.population.residents.filter((r) => CrimeSim.isThief(r)).length;
    const s = city.crime.stats;
    console.log(`thieves ${thieves}, stations ${stations}, ${JSON.stringify(s)}, phases ${[...phases]}, most officers on one thief ${mostOfficers}, held at ${[...heldAt]}`);
    expect(thieves).toBeGreaterThan(0);
    expect(s.robberies).toBeGreaterThan(0);
    expect(s.witnesses + s.lookedOn).toBeGreaterThan(0);
    expect(mostOfficers).toBeGreaterThan(0);
    expect(s.arrests).toBeGreaterThan(0);
    // Those arrested are walked to the station and held there (or on the way when the run ends).
    const onTheWay = city.crime.active().filter((c) => c.phase === 'arrested').length;
    expect(s.held + onTheWay).toBe(s.arrests);
    if (s.held > 0) expect([...heldAt]).toContain('police');
  }, 300_000);
});
