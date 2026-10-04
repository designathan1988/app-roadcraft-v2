import { expect, it, vi } from 'vitest';
import { NavMeshQuery } from '@recast-navigation/core';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { addScriptedWalker, createCrowdEngine, initCrowd, inspectCrowd } from '@sim/people/crowd';
import * as party from '@sim/people/party';
import { AGENT_HEIGHT, AGENT_RADIUS } from '@sim/people/crowdNav';
import { SCENARIOS } from '../../fixtures/crowdScenarios';
import { CITIES } from '../support/agentDefects';

it.each(['none', 'route'])('keeps city demand and whole groups when birth failure=%s', async (failure) => {
  await initCrowd();
  const previousEngine = process.env.AGENT_ENGINE;
  process.env.AGENT_ENGINE = 'crowd';
  const sim = CITIES.find(c => c.name === 'player-city')!.build();
  if (previousEngine === undefined) delete process.env.AGENT_ENGINE;
  else process.env.AGENT_ENGINE = previousEngine;
  const plans = vi.spyOn(party, 'planParty');
  const raycast = failure === 'route' ? vi.spyOn(NavMeshQuery.prototype, 'raycast').mockImplementation(() => ({
    success: true, status: 0, t: 0, hitNormal: { x: 0, y: 0, z: 0 }, hitEdgeIndex: -1, path: [], maxPath: 0, pathCost: 0,
  })) : null;
  try {
    sim.pedEngine.dispatch(sim, true);
    const people = inspectCrowd(sim);
    // Preserve demand. Relocated companions affect later source occupancy, so
    // subsequent accepted parties need not have the old random identities.
    expect(people).toHaveLength(334);
    const planned = new Map(plans.mock.calls.map((args, i) => [args[1], plans.mock.results[i]!.value as party.PartyPlan]));
    for (const leader of people.filter(p => p.leader === null)) {
      const group = people.filter(p => p.id === leader.id || p.leader === leader.id);
      expect(group.length, `missing companion of ${leader.id}`).toBe(planned.get(leader.id)!.size);
    }
    for (const p of people) {
      if (p.leader === null) continue;
      for (const q of people) {
        if (p.id === q.id || Math.abs(p.h - q.h) >= AGENT_HEIGHT) continue;
        expect(Math.hypot(p.x - q.x, p.y - q.y), `birth overlap ${p.id}/${q.id}`).toBeGreaterThanOrEqual(2 * AGENT_RADIUS - 1e-4);
      }
    }
  } finally { raycast?.mockRestore(); plans.mockRestore(); sim.pedEngine.reset(sim); }
}, 30000);

it('starts side-by-side walkers without a collision-correction slide', async () => {
  await initCrowd();
  const sc = SCENARIOS.find(s => s.name === 'side-by-side')!;
  const net = new Network(sc.doc); net.rebuild();
  const sim = new SimWorld(sc.doc, net, 0x5ce7); sim.rebuildTopology();
  sim.pedestrianIntensity = 0; sim.trafficIntensity = 0;
  sim.usePedestrianEngine(createCrowdEngine());
  try {
    step(sim, { traffic: false, pedestrians: true });
    const ids: number[] = [];
    for (const wk of sc.walkers(net)) ids.push(addScriptedWalker(sim, {
      ...wk, ...(wk.leader !== undefined ? { leader: ids[wk.leader]! } : {}),
    })!);
    const initial = inspectCrowd(sim);
    expect(ids).toHaveLength(3);
    expect(ids.every(id => id > 0)).toBe(true);
    expect(Math.hypot(initial[0]!.x - initial[1]!.x, initial[0]!.y - initial[1]!.y))
      .toBeGreaterThanOrEqual(2 * AGENT_RADIUS);
    step(sim, { traffic: false, pedestrians: true });
    const byId = new Map(inspectCrowd(sim).map(p => [p.id, p]));
    for (const view of sim.pedViews) {
      const speed = Math.hypot(view.x - view.prev.x, view.y - view.prev.y) / DT;
      expect(speed > m(0.1) && byId.get(view.id)!.speed < m(0.03)).toBe(false);
    }
  } finally { sim.pedEngine.reset(sim); }
});
