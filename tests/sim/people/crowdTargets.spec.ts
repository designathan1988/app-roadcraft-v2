import { beforeAll, expect, it } from 'vitest';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { addScriptedWalker, createCrowdEngine, initCrowd, inspectCrowd } from '@sim/people/crowd';
import { SCENARIOS } from '../../fixtures/crowdScenarios';

beforeAll(initCrowd);

it('does not repeatedly request the same projected waiting target', () => {
  const sc = SCENARIOS.find(s => s.name === 'crowd')!;
  const net = new Network(sc.doc);
  net.rebuild();
  const sim = new SimWorld(sc.doc, net, 0x5ce7);
  sim.rebuildTopology();
  sim.pedestrianIntensity = 0;
  sim.trafficIntensity = 0;
  sim.usePedestrianEngine(createCrowdEngine());
  step(sim, { traffic: false, pedestrians: true });
  const ids: number[] = [];
  for (const p of sc.walkers(net)) ids.push(addScriptedWalker(sim, {
    ...p, ...(p.leader !== undefined ? { leader: ids[p.leader]! } : {}),
  })!);
  for (let tick = 0; tick <= Math.round(26.1 / DT); tick++) step(sim, { traffic: false, pedestrians: true });
  // A person waiting at its place, not stepping aside: the first such one.
  // (It was person 28 by index, which pinned the test to one trajectory of a
  // chaotic crowd; any change of street geometry moves who stands where.)
  const waiting = inspectCrowd(sim).filter(p => ids.includes(p.id) && p.mode === 'wait' && p.aside === null);
  expect(waiting.length).toBeGreaterThan(0);
  const before = waiting[0]!;
  for (let tick = 0; tick < 24; tick++) step(sim, { traffic: false, pedestrians: true });
  const after = inspectCrowd(sim).find(p => p.id === before.id)!;
  expect(after.target).toEqual(before.target);
  expect(after.granted).toEqual(before.granted);
  expect(after.replans).toBe(before.replans);
});
