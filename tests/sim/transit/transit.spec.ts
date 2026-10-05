import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { buildDefaultTown } from '@world/defaultTown';
import { Network } from '@world/network';
import { m } from '@world/units';
import { buildWalkways } from '@world/walkways';
import { ALONG_ROAD, addLine, addStop, addTrack, longestOnRoad, setTerminal, type TransitData } from '@world/transit';
import { onCarriageway } from '@editor/transitTools';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { vehiclePose } from '@sim/pose';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { laneBeside } from '@sim/agents/parking';
import { planTrip } from '@sim/drive/tactical';

/**
 * Public transport (`world/transit.ts`, `sim/transit/transit.ts`) in the
 * default town, laid out as the player would: a bus line along four stops of
 * the streets, its first a terminal; a train track across the town with three
 * stations and its line. Measured: the buses go on the road and stop at each
 * stop in turn; the trains run and stand at the stations; residents without a
 * car going far walk to a stop, wait, ride and get off.
 */
describe('public transport', () => {
  it('buses stop at their stops, trains at their stations, and residents ride them', () => {
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
    sim.city.skip(4 * 60);
    // Four bus stops on footways a few hundred metres apart, as the stop tool puts them.
    // On streets joined at both ends (not a road out of the map), as a line that works is laid.
    const joined = (seg: number): boolean => {
      const sg = doc.segments.get(seg as never);
      return !!sg && (doc.nodes.get(sg.a)?.incident.length ?? 0) > 1 && (doc.nodes.get(sg.b)?.incident.length ?? 0) > 1;
    };
    // ...and whose lane beside the stop leads on into the town (not out of the map).
    const links = [...sim.graph.lanelets.values()].filter((l) => l.kind === 'link');
    const sample = links.filter((_, i) => i % 6 === 0);
    const intoTown = (x: number, y: number, seg: number): boolean => {
      const lane = laneBeside(sim, x, y, seg as never);
      return !!lane && sample.filter((l) => planTrip(sim, lane.lanelet, lane.at, l.id, 2 as never)).length > sample.length * 0.6;
    };
    const ways = buildWalkways(net).ways.filter((w) => w.kind === 'footway' && w.segment !== undefined && w.path.length > m(40) && joined(w.segment)
      && intoTown(w.path.sampleAt(w.path.length / 2).p.x, w.path.sampleAt(w.path.length / 2).p.y, w.segment));
    const picked: { x: number; y: number; segment: number }[] = [];
    for (const way of ways) {
      const p = way.path.sampleAt(way.path.length / 2).p;
      if (picked.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > m(250)) && (picked.length === 0 || Math.hypot(picked[picked.length - 1]!.x - p.x, picked[picked.length - 1]!.y - p.y) < m(600))) {
        picked.push({ x: p.x, y: p.y, segment: way.segment! });
      }
      if (picked.length === 4) break;
    }
    expect(picked.length).toBe(4);
    let t: TransitData = doc.transit;
    const stops: number[] = [];
    for (const p of picked) { const r = addStop(t, { mode: 'bus', x: p.x, y: p.y, segment: p.segment as never }); t = r.data; stops.push(r.id); }
    t = setTerminal(t, stops[0]!, true);
    t = addLine(t, 'bus', stops).data;
    // A train track across the town, and three stations on it.
    const xs = [...doc.nodes.values()].map((n) => n.x), ys = [...doc.nodes.values()].map((n) => n.y);
    // A line across the town that crosses its streets without running down one (the tool would refuse it).
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let ym = (Math.min(...ys) + Math.max(...ys)) / 2;
    for (let k = 0; k < 80; k++) {
      const y = Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * (0.3 + 0.4 * ((k * 0.618) % 1));
      if (longestOnRoad([{ x: x0, y }, { x: x1, y }], (q) => onCarriageway(net, q)) <= ALONG_ROAD) { ym = y; break; }
    }
    const track = addTrack(t, 'train', [{ x: x0, y: ym }, { x: x1, y: ym }]);
    t = track.data;
    const stations: number[] = [];
    for (const f of [0.15, 0.5, 0.85]) { const r = addStop(t, { mode: 'train', x: x0 + (x1 - x0) * f, y: ym, track: track.id }); t = r.data; stations.push(r.id); }
    t = addLine(t, 'train', stations).data;
    doc.setTransit(t);

    const transit = sim.city.transit;

    // Each bus's stops: the stop it stood at, in turn.
    const busStops = new Map<number, number[]>();
    const trainStops = new Set<string>();
    let maxBuses = 0, trainMoved = 0, underTrain = 0, vehUnder = 0;
    const last = new Map<string, { x: number; y: number }>();
    sim.clock.run(Math.round(600 / DT), () => {
      step(sim);
      const ids = transit.busIds();
      maxBuses = Math.max(maxBuses, ids.length);
      for (const id of ids) {
        const v = sim.vehicles.get(id);
        if (!v || v.v > m(0.3)) continue;
        const pose = vehiclePose(sim, v, 1);
        if (!pose) continue;
        const near = t.stops.filter((s) => s.mode === 'bus').find((s) => Math.hypot(s.x - pose.p.x, s.y - pose.p.y) < m(14));
        if (!near) continue;
        const seen = busStops.get(id) ?? [];
        if (seen[seen.length - 1] !== near.id) seen.push(near.id);
        busStops.set(id, seen);
      }
      // At the level crossings: nobody under a train, no vehicle in one.
      // The cars themselves (not the track kept clear ahead of them).
      const bodies = transit.trainBodies(false);
      for (const veh of sim.vehicles.values()) {
        const pose = vehiclePose(sim, veh, 1);
        if (pose && bodies.some((d) => Math.hypot(d.x - pose.p.x, d.y - pose.p.y) < d.r)) { underTrain++; vehUnder++; }
      }
      for (const p of sim.pedViews) if (bodies.some((d) => Math.hypot(d.x - p.x, d.y - p.y) < d.r * 0.8)) underTrain++;
      for (const train of transit.trains()) {
        const c = train.cars[0]!;
        const before = last.get(train.key);
        if (before) trainMoved = Math.max(trainMoved, Math.hypot(c.x - before.x, c.y - before.y));
        last.set(train.key, { x: c.x, y: c.y });
        if (train.v === 0) {
          const st = t.stops.find((s) => s.mode === 'train' && Math.hypot(s.x - c.x, s.y - c.y) < m(30));
          if (st) trainStops.add(`${train.key}:${st.id}`);
        }
      }
    });
    const served = [...busStops.values()].map((s) => s.length);
    console.log(`buses on the road ${maxBuses}, stops served per bus ${JSON.stringify(served)}, train stops ${trainStops.size}, `
      + `inside a train ${underTrain} (vehicles ${vehUnder}), crossings ${JSON.stringify((transit as unknown as { rails: { crossings: unknown[] }[] }).rails.map((r) => r.crossings.length))}, riders ${transit.riders.size}, boarded ${transit.boarded}, carried ${transit.carried}, on board ${transit.onBoard()}`);
    expect(maxBuses).toBeGreaterThan(0);
    expect(Math.max(0, ...served)).toBeGreaterThanOrEqual(3);
    expect(trainMoved).toBeGreaterThan(0);
    expect(trainStops.size).toBeGreaterThan(0);
    expect(underTrain).toBe(0);
    // Residents got on, and got off where they were going.
    expect(transit.boarded).toBeGreaterThan(0);
    expect(transit.carried).toBeGreaterThan(0);
  }, 300_000);
});
