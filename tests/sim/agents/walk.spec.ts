import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT, PED } from '@sim/params';
import { createAgentWalkEngine, inspectAgentWalkers } from '@sim/agents/walk';

/**
 * The agents' walking (`sim/agents/walk.ts`), measured on the drawn body
 * (`PedView`) every tick in the default town on an evening, when residents go
 * out for their own reasons:
 *
 * - nobody jumps: a body moves at most a walker's top speed in a tick;
 * - nobody walks backwards: a moving body moves the way it faces;
 * - nobody slides sideways faster than a sidestep;
 * - nobody stands inside somebody else: a crowd leaving one building comes out
 *   one after another;
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
    let worstJump = 0, worstSlide = 0, overlapTicks = 0;
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
      for (const id of walking) if (!now.has(id)) arrived++;
      walking.clear();
      for (const id of now) walking.add(id);
      for (const p of inspectAgentWalkers(sim)) maxHeld = Math.max(maxHeld, p.held);
    });
    const u = m(1);
    console.log(`walk: ${ticks} ticks, ${bodies} body-ticks, walks started ${started.size}, arrived ${arrived}, `
      + `on zebras ${crossing} body-ticks, jumps ${jumps} (worst ${(worstJump / u).toFixed(2)} m/s), backward ${backward}, `
      + `slides ${slides} (worst ${(worstSlide / u).toFixed(2)} m/s), overlapping pair-seconds ${(overlapTicks * DT).toFixed(1)}, longest kerb wait ${maxWait.toFixed(1)} s, longest hold ${maxHeld.toFixed(1)} s`);
    expect(started.size).toBeGreaterThan(20);
    expect(arrived).toBeGreaterThan(10);
    expect(crossing).toBeGreaterThan(0);
    expect(jumps).toBe(0);
    expect(backward).toBe(0);
    expect(slides).toBe(0);
    expect(maxWait).toBeLessThan(90);
    expect(maxHeld).toBeLessThan(12);
    // Two bodies brushing as they pass, a thousandth of the time at most.
    expect(overlapTicks / bodies).toBeLessThan(0.001);
  }, 300_000);
});
