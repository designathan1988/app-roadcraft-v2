import { describe, expect, it } from 'vitest';
import {
  createProject, parseProject, phaseAt, signalConflicts, shortestRoute,
  routeLength, demandRate, transitSchedule, interpolatePose, soundGain,
  makeWave, movePoint, vehicleMix, trafficPlan, resizeClip, movementPath, supportHeight, animationSamples, trimSnapshots, frameBounds,
} from '../../src/studios/model';
import type { SignalProject, TrafficProject, TransitProject, AnimationProject, SoundProject } from '../../src/studios/model';

describe('studio project files', () => {
  for (const kind of ['signal', 'traffic', 'transit', 'material', 'animation', 'sound'] as const) {
    it(`round-trips ${kind} without dropping editable data`, () => {
      const project = createProject(kind);
      project.name = 'Projeto ç com <texto>';
      expect(parseProject(JSON.stringify(project), kind)).toEqual(project);
    });
  }
  it('rejects another editor and unsupported versions', () => {
    expect(() => parseProject(JSON.stringify(createProject('traffic')), 'signal')).toThrow();
    expect(() => parseProject('{"format":"roadcraft-studio/99"}', 'signal')).toThrow();
  });
  it('rejects malformed nested data instead of accepting a matching header', () => {
    const project = createProject('signal') as SignalProject;
    project.phases[0]!.green = -1;
    expect(() => parseProject(JSON.stringify(project), 'signal')).toThrow();
    const sound = createProject('sound') as SoundProject;
    sound.sources[0]!.audio = 'https://example.com/file.wav';
    expect(() => parseProject(JSON.stringify(sound), 'sound')).toThrow();
  });
  it('rejects duplicate graph ids and dangling routes', () => {
    const project = createProject('traffic') as TrafficProject;
    project.network.nodes[1]!.id = project.network.nodes[0]!.id;
    expect(() => parseProject(JSON.stringify(project), 'traffic')).toThrow();
    const transit = createProject('transit') as TransitProject;
    transit.lines[0]!.stops.push('missing');
    expect(() => parseProject(JSON.stringify(transit), 'transit')).toThrow();
  });
});

describe('junction programmes', () => {
  it('assigns a movement to an input and output lane in metres', () => {
    const p = createProject('signal') as SignalProject;
    p.assignments.find(a => a.movement === 'N-S')!.lane = 1;
    const path = movementPath('N-S', p);
    expect(path[0]!.x).toBeCloseTo(-4.8);
    expect(path[path.length - 1]!.x).toBeCloseTo(-1.6);
  });
  it('holds amber and all-red between conflicting green phases', () => {
    const project = createProject('signal') as SignalProject;
    expect(phaseAt(project, 24.9).stage).toBe('green');
    expect(phaseAt(project, 25).stage).toBe('amber');
    expect(phaseAt(project, 28).stage).toBe('red');
    expect(phaseAt(project, 29).index).toBe(1);
    expect(phaseAt(project, 58).index).toBe(0);
  });
  it('reports crossing vehicle paths and permits opposing straight streams', () => {
    const project = createProject('signal') as SignalProject;
    expect(signalConflicts(project, project.phases[0]!)).toEqual([]);
    project.phases[0]!.movements = ['N-S', 'E-W'];
    expect(signalConflicts(project, project.phases[0]!).length).toBeGreaterThan(0);
  });
  it('reports a crossing occupied by a green vehicle movement', () => {
    const project = createProject('signal') as SignalProject;
    project.phases[0]!.crossings = ['N'];
    expect(signalConflicts(project, project.phases[0]!).length).toBeGreaterThan(0);
  });
});

describe('network and demand', () => {
  const graph = {
    nodes: [{ id: 'a', name: 'A', x: 0, y: 0 }, { id: 'b', name: 'B', x: 3, y: 0 }, { id: 'c', name: 'C', x: 3, y: 4 }],
    edges: [{ id: 'ab', from: 'a', to: 'b', speed: 30, both: false }, { id: 'bc', from: 'b', to: 'c', speed: 30, both: true }],
  };
  it('routes by connected streets and respects one-way edges', () => {
    expect(shortestRoute(graph, 'a', 'c')).toEqual(['a', 'b', 'c']);
    expect(routeLength(graph, ['a', 'b', 'c'])).toBe(7);
    expect(shortestRoute(graph, 'c', 'a')).toEqual([]);
  });
  it('recalculates length after dragging a node without changing topology', () => {
    const result = movePoint(graph, 'b', 0, 4);
    expect(routeLength(result, ['a', 'b', 'c'])).toBe(7);
    expect(result.nodes[1]!.x).toBe(0);
    expect(graph.nodes[1]!.x).toBe(3);
  });
  it('supports peaks crossing midnight and excludes the end boundary', () => {
    expect(demandRate(120, 1380, 120, 2, 60)).toBe(240);
    expect(demandRate(120, 1380, 120, 2, 120)).toBe(120);
    expect(demandRate(120, 420, 540, 2, 450)).toBe(240);
  });
  it('normalizes vehicle shares without generating negative shares', () => {
    expect(vehicleMix(20, 30)).toEqual({ cars: 50, buses: 20, trucks: 30 });
    expect(() => vehicleMix(80, 30)).toThrow();
  });
  it('generates repeatable departures from demand and caps speed by the street', () => {
    const p = createProject('traffic') as TrafficProject;
    p.network = graph;
    p.flows = [{ id: 'f1', name: 'Trip', from: 'a', to: 'c', rate: 120 }];
    p.start = 600; p.duration = 60; p.speed = 60;
    const plan = trafficPlan(p);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.birth).toBe(30);
    expect(plan[0]!.finish - plan[0]!.birth).toBeCloseTo(7 / (30 / 3.6));
    expect(trafficPlan(p)).toEqual(plan);
  });
  it('actually represents both requested vehicle shares in a seeded scenario', () => {
    const p = createProject('traffic') as TrafficProject;
    p.flows[0]!.rate = 3600; p.start = 600; p.duration = 3600;
    p.buses = 10; p.trucks = 20;
    const trips = trafficPlan(p), buses = trips.filter(t => t.type === 'bus').length, trucks = trips.filter(t => t.type === 'truck').length;
    expect(trips).toHaveLength(3600);
    expect(buses).toBeGreaterThan(260); expect(buses).toBeLessThan(460);
    expect(trucks).toBeGreaterThan(560); expect(trucks).toBeLessThan(880);
  });
});

describe('public transport', () => {
  it('includes stop dwell and return trip in the required fleet', () => {
    const project = createProject('transit') as TransitProject;
    const line = project.lines[0]!;
    const result = transitSchedule(project.network, line);
    expect(result.distance).toBeGreaterThan(0);
    expect(result.tripSeconds).toBeGreaterThan(result.distance / (line.speed / 3.6));
    expect(result.fleet).toBe(Math.ceil(result.cycleSeconds / (line.headway * 60)));
    expect(result.departures[0]).toBe(line.start);
    expect(result.departures[1]).toBe(line.start + line.headway);
  });
  it('refuses a disconnected stop sequence', () => {
    const project = createProject('transit') as TransitProject;
    project.network.edges = [];
    expect(() => transitSchedule(project.network, project.lines[0]!)).toThrow();
  });
});

describe('poses and sound', () => {
  it('subdivides large rotations so a GLB follows the same angular path as the preview', () => {
    const p = createProject('animation') as AnimationProject;
    p.keys = [{ time: 0, pose: { ...p.keys[0]!.pose, leftArm: -150 } }, { time: 2, pose: { ...p.keys[0]!.pose, leftArm: 150 } }];
    const samples = animationSamples(p);
    expect(samples.find(s => s.time === 1)!.pose.leftArm).toBe(0);
    expect(samples.every((s, i) => !i || Math.abs(s.pose.leftArm - samples[i - 1]!.pose.leftArm) <= 20)).toBe(true);
  });
  it('keeps very short authored rotation keys in the export sampling', () => {
    const p = createProject('animation') as AnimationProject;
    p.keys.splice(1, 0, { time: 0.001, pose: { ...p.keys[0]!.pose, leftArm: -150 } });
    const samples = animationSamples(p);
    expect(samples.some(s => s.time === 0.001)).toBe(true);
    expect(samples.every((s, i) => !i || Math.abs(s.pose.leftArm - samples[i - 1]!.pose.leftArm) <= 20)).toBe(true);
  });
  it('bounds undo storage by size while retaining the nearest undo state', () => {
    const past = ['123456', 'abcdef', 'uvwxyz'], future = ['789012'];
    trimSnapshots(past, future, 10);
    expect(past.length + future.length).toBe(1);
    expect(past.concat(future).join('').length).toBeLessThanOrEqual(10);
    expect(future[0]).toBe('789012');
  });
  it('frames valid remote coordinates without clipping them or forcing a minimum zoom', () => {
    const bounds = frameBounds([{ x: -10000, y: 0 }, { x: 10000, y: 0 }], 800, 600, false);
    expect(bounds.scale).toBeLessThan(0.04);
    expect(10000 * bounds.scale).toBeLessThan(400);
    const remote = frameBounds([{ x: 9990, y: 100 }, { x: 10000, y: 100 }], 800, 600, false);
    expect(remote.center.x).toBe(9995);
    expect(remote.center.y).toBe(100);
  });
  it('places the lowest shoe on the ground for standing and horizontal legs', () => {
    const p = createProject('animation') as AnimationProject;
    const pose = { ...p.keys[0]!.pose, leftLeg: 0, rightLeg: 0, leftKnee: 0, rightKnee: 0 };
    expect(supportHeight(pose)).toBeCloseTo(0.9);
    pose.leftLeg = pose.rightLeg = 90;
    expect(supportHeight(pose)).toBeCloseTo(0.26);
  });
  it('rescales key times when changing the clip duration, preserving poses', () => {
    const p = createProject('animation') as AnimationProject;
    const resized = resizeClip(p, 4);
    expect(resized.keys.map(k => k.time)).toEqual([0, 1, 2, 3, 4]);
    expect(resized.keys[1]!.pose).toEqual(p.keys[1]!.pose);
    expect(p.duration).toBe(2);
    expect(() => resizeClip(p, 0)).toThrow();
  });
  it('interpolates joint rotations and keeps endpoint poses exact', () => {
    const project = createProject('animation') as AnimationProject;
    project.duration = 2;
    project.keys = [
      { time: 0, pose: { ...project.keys[0]!.pose, leftArm: -40 } },
      { time: 2, pose: { ...project.keys[0]!.pose, leftArm: 40 } },
    ];
    expect(interpolatePose(project, 1).leftArm).toBe(0);
    expect(interpolatePose(project, 2).leftArm).toBe(40);
  });
  it('attenuates a source by distance and becomes silent outside its radius', () => {
    expect(soundGain(0, 2, 20, 1)).toBe(1);
    expect(soundGain(10, 2, 20, 1)).toBeCloseTo(2 / 10);
    expect(soundGain(21, 2, 20, 1)).toBe(0);
  });
  it('writes actual stereo PCM samples with a valid RIFF header', () => {
    const bytes = makeWave([Float32Array.from([1, -1]), Float32Array.from([0.5, -0.5])], 8000);
    const view = new DataView(bytes);
    expect(new TextDecoder().decode(new Uint8Array(bytes, 0, 4))).toBe('RIFF');
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(16383);
    expect(view.getInt16(48, true)).toBe(-32768);
  });
});
