import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { curbRamps, walkingRise } from '@world/curbRamps';
import { m } from '@world/units';

/**
 * NOBODY IS LIFTED OR DROPPED BETWEEN TWO FRAMES (docs/PLANO.md, Etapa 5c).
 *
 * The body is drawn at the walking surface's height under it
 * (`render/agents.ts`, `walkingRise`). Measured on 2026-10-09 it was chosen
 * by the walker's ground instead - the footway's 15 cm or the carriageway's 0 -
 * and every step from a footway onto a zebra dropped the body 15 cm in one
 * frame (17 times a minute with ten people). With the dropped kerbs the two
 * read the same on the ramp, and the body walks down it.
 *
 * The height is taken exactly as the renderer takes it, over the road's own
 * deck, for everyone off the open ground (the lot gates are Etapa 5b).
 */

function city(): SimWorld {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const north = doc.addNode({ x: 0, y: 420 });
  const south = doc.addNode({ x: 0, y: -420 });
  const east = doc.addNode({ x: 460, y: 0 });
  const west = doc.addNode({ x: -460, y: 0 });
  doc.addSegment(south.id, centre.id, 1);
  doc.addSegment(centre.id, north.id, 1);
  doc.addSegment(west.id, centre.id, 1);
  doc.addSegment(centre.id, east.id, 2);
  doc.setNodeControl(centre.id, 'signal');
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0x7a1e);
  sim.rebuildTopology();
  sim.clock.paused = false;
  return sim;
}

/** The share of the footway's rise the renderer stands a walker at. */
function rise(sim: SimWorld, x: number, y: number, ground: string): number {
  return FOOTWAY_RISE * walkingRise(sim.net, x, y, ground !== 'crossing');
}

describe('walking height', () => {
  it('builds a dropped kerb at each end of every crossing', () => {
    const sim = city();
    // Four legs, a zebra on each, a ramp at each of its two ends; and the
    // unmarked crossing at each of the four road ends, two ramps each.
    expect(curbRamps(sim.net).length).toBe(16);
    for (const r of curbRamps(sim.net)) {
      // At the foot the walking surface is the carriageway's, from either side.
      expect(walkingRise(sim.net, r.x + r.nx * m(0.01), r.y + r.ny * m(0.01), true)).toBeLessThan(0.02);
      expect(walkingRise(sim.net, r.x + r.nx * m(0.01), r.y + r.ny * m(0.01), false)).toBeLessThan(0.02);
      // Past the top of the slope, the footway's full height.
      expect(walkingRise(sim.net, r.x + r.nx * (r.run + m(0.2)), r.y + r.ny * (r.run + m(0.2)), true)).toBe(1);
      // No steeper than 1 in 12.
      const a = walkingRise(sim.net, r.x + r.nx * m(0.5), r.y + r.ny * m(0.5), true);
      const b = walkingRise(sim.net, r.x + r.nx * m(1), r.y + r.ny * m(1), true);
      expect(((b - a) * FOOTWAY_RISE) / m(0.5)).toBeLessThanOrEqual(1 / 12 + 1e-6);
    }
  });

  it('never lifts or drops a walker more than a centimetre between ticks', () => {
    const sim = city();
    sim.usePedestrianEngine(createAgentWalkEngine());
    sim.ambient.enabled = true;
    sim.ambient.source = 'edges';
    sim.pedestrianCount = 100;
    const last = new Map<number, { rise: number; ground: string }>();
    let switches = 0, worst = 0, detail = '';
    sim.clock.run(Math.round(240 / DT), () => {
      step(sim, { traffic: true, pedestrians: true });
      for (const v of sim.pedViews) {
        if (v.ground === 'open') { last.delete(v.id); continue; }
        const now = rise(sim, v.x, v.y, v.ground);
        const before = last.get(v.id);
        if (before) {
          if (before.ground !== v.ground) switches++;
          const jump = Math.abs(now - before.rise);
          if (jump > worst) {
            worst = jump;
            detail = `walker ${v.id} ${before.ground}>${v.ground} at ${v.x.toFixed(1)},${v.y.toFixed(1)}: ${(jump / m(0.01)).toFixed(1)} cm`;
          }
        }
        last.set(v.id, { rise: now, ground: v.ground });
      }
    });
    // People stepped between the footways and the zebras, or nothing was tested.
    expect(switches).toBeGreaterThan(15);
    expect(worst, detail).toBeLessThanOrEqual(m(0.01));
  });
});
