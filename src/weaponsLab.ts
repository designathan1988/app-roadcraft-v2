import type { SceneHandle } from '@render/renderer';
import type { RagdollProbe } from '@render/ragdoll';
import { removeWalker, traceWalkers, walkerAct, walkerState, type WalkTrace } from '@sim/agents/walk';
import type { BodyPart } from '@sim/people/view';
import { archetypeById } from '@sim/vehicles/archetypes';
import { makeDriver } from '@sim/vehicles/driver';
import { createVehicle, type VehicleId } from '@sim/vehicles/state';
import type { SimWorld } from '@sim/world';
import { t } from '@ui/i18n';
import type { Viewport } from '@view/viewport';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import type { Vec2 } from '@core/vec2';

/**
 * The weapons lab (`?lab=armas`, the player's order of 2026-10-06): a street
 * built for one purpose - a footway with its kerb, the carriageway, grass, a
 * bank of raised ground, a wall, a pole, a bench, a tree and a parked car -
 * and a person always standing ready at the spot chosen, to be shot in any
 * part from any side, bombed near or far, shot again where they lie, in slow
 * motion or a frame at a time; and probes that record every frame of it:
 * the simulation's side (what they are doing, health, bleeding), every body
 * on the ground (each particle, how far into the ground or into a wall, how
 * far its bones are off their lengths, how fast it moves) and every drawn
 * skeleton against its body (bones stretched or scaled: the mesh torn).
 *
 * In the page: `window.__weaponsLab` (the same actions, the log, a summary);
 * headless: `scripts/weapons-lab.mjs` runs the scenarios and writes frames
 * and a report.
 */

export interface LabHost {
  readonly sim: SimWorld;
  scene(): SceneHandle;
  view(): Viewport;
  canvas(): HTMLCanvasElement;
  loadDoc(data: ReturnType<RoadDoc['toJSON']>): void;
  lookAt(x: number, y: number, zoom: number): void;
  heightAt(p: Vec2): number;
  explode(at: Vec2, z: number, strength: number): void;
  /** Simulation speed (0: paused). */
  setSpeed(speed: number): void;
  /** Runs the simulation on by this many seconds at once (while paused). */
  runSim(seconds: number): void;
  requestDraw(): void;
}

type Side = 'front' | 'back' | 'left' | 'right' | 'obstacle';

/** A place to test at: where the person stands, which way they face, what is beside them. */
interface Spot {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  /** The way they face (world angle). */
  readonly facing: number;
  /** The way a shot from the obstacle's side drives them (world angle): into the thing beside them. */
  readonly into: number;
}

const M = (v: number): number => m(v);

/** The street: along x, footways either side, the kerb at 4 m from the middle. */
const SPOTS: readonly Spot[] = [
  { key: 'footway', x: M(0), y: M(5), facing: -Math.PI / 2, into: Math.PI / 2 },
  { key: 'kerb', x: M(6), y: M(4.35), facing: Math.PI / 2, into: -Math.PI / 2 },
  { key: 'road', x: M(-6), y: M(1.5), facing: 0, into: -Math.PI / 2 },
  { key: 'grass', x: M(10), y: M(11), facing: -Math.PI / 2, into: Math.PI / 2 },
  { key: 'bank', x: M(-22), y: M(10.5), facing: -Math.PI / 2, into: Math.PI / 2 },
  { key: 'wall', x: M(19), y: M(6.4), facing: -Math.PI / 2, into: Math.PI / 2 },
  { key: 'pole', x: M(-10), y: M(4.7), facing: -Math.PI / 2, into: Math.PI / 2 },
  { key: 'bench', x: M(-30), y: M(4.5), facing: -Math.PI / 2, into: Math.PI / 2 },
  { key: 'tree', x: M(30), y: M(8), facing: -Math.PI / 2, into: Math.PI / 2 },
  { key: 'car', x: M(40), y: M(4.7), facing: Math.PI / 2, into: -Math.PI / 2 },
];

/** Where a shot strikes each part, metres above the ground. */
const PART_HEIGHT: Readonly<Record<BodyPart, number>> = { head: 1.65, torso: 1.25, armL: 1.15, armR: 1.15, legL: 0.5, legR: 0.5 };
/** The particle (`ragdoll.ts`) each part is struck at, on a body on the ground. */
const PART_POINT: Readonly<Record<BodyPart, number>> = { head: 3, torso: 1, armL: 6, armR: 9, legL: 12, legR: 16 };

/** The lab's street, as a document. */
function labDoc(): RoadDoc {
  const d = new RoadDoc();
  const a = d.addNode({ x: M(-60), y: 0 }), b = d.addNode({ x: M(60), y: 0 });
  d.addSegment(a.id, b.id, 1);
  // A bank of raised ground beyond the footway, to fall down.
  d.addTerrainStamp({ x: M(-22), y: M(16), radius: M(9), strength: M(2.5), mode: 'raise' });
  d.addBarrier('wall', [{ x: M(14), y: M(7.2) }, { x: M(24), y: M(7.2) }]);
  d.addPole({ x: M(-10), y: M(5.5) }, true);
  d.addLandscape('bench', { x: M(-30), y: M(5.3) });
  d.addLandscape('tree', { x: M(30), y: M(9) });
  d.addLandscape('bin', { x: M(8), y: M(5.6) });
  d.addLandscape('hydrant', { x: M(-3), y: M(4.6) });
  return d;
}

/** One change in the timeline (`WeaponsLab.timeline`): the simulation's, or the clip the renderer plays. */
export interface LabEvent {
  /** Milliseconds since the lab started, and the frame. */
  readonly t: number;
  readonly frame: number;
  readonly id: number;
  readonly field: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly hp: number;
  readonly stack: string;
}

interface Frame {
  readonly t: number;
  readonly person: ReturnType<typeof walkerState>;
  readonly anim: ReturnType<SceneHandle['animProbe']>;
  readonly bodies: readonly RagdollProbe[];
  readonly mesh: ReturnType<SceneHandle['meshProbe']>;
  readonly flags: readonly string[];
  /** The person the frame is about. */
  readonly id: number | null;
}

export interface WeaponsLab {
  /** A new person at a spot (`SPOTS` key), standing still, facing the spot's way; the last one taken off. */
  spawn(spot?: string, person?: number): number;
  shoot(part: BodyPart, side?: Side): unknown;
  /** A shot at the body on the ground (the person's, or the last one), at a part. */
  shootBody(part: BodyPart, side?: Side): unknown;
  bomb(distance: number, strength?: number, side?: Side): void;
  /** People standing round the spot to watch the reactions (0 takes them off). */
  bystanders(count: number): void;
  setSpeed(speed: number): void;
  step(seconds?: number): void;
  clear(): void;
  record(on: boolean): void;
  log(): readonly Frame[];
  /** Every change to the person since they came (what they do, their flight, the clip drawn), with why and from where. */
  timeline(): readonly LabEvent[];
  /** Plays a clip on the person whatever they are doing (to see the clip alone); null gives them back. */
  playClip(clip: string | null): void;
  summary(): Record<string, unknown>;
  readonly spots: readonly string[];
}

export function startWeaponsLab(host: LabHost): WeaponsLab {
  const sim = host.sim;
  host.loadDoc(labDoc().toJSON());
  // Only the lab's people and car: no traffic, nobody walking in.
  sim.trafficCount = 0;
  sim.pedestrianCount = 0;

  let spot: Spot = SPOTS[0]!;
  let personId = 900_001;
  let id: number | null = null;
  const watchers: number[] = [];
  let recording = false;
  let started = performance.now();
  const frames: Frame[] = [];
  let follow = true;
  let zoom = 70;
  let speed = 1;
  let autoRespawn = true;
  let goneSince: number | null = null;
  const events: LabEvent[] = [];
  const labStart = performance.now();
  let frameNo = 0;
  let lastClip = '';
  const onTrace = (e: WalkTrace): void => {
    if (events.length < 2000) events.push({ t: performance.now() - labStart, frame: frameNo, id: e.id, field: e.field, from: e.from, to: e.to, reason: e.reason, hp: e.hp, stack: e.stack });
  };

  // The parked car beside the `car` spot: a sedan at the kerb, off the traffic.
  const parkCar = (): void => {
    if (sim.ambient.parked.some((v) => v.id === (970_001 as VehicleId))) return;
    const arch = archetypeById('sedan');
    const car = createVehicle(970_001 as VehicleId, arch, makeDriver(arch, () => 0.5), '#2f5d8a', '', 0, sim.clock.tick);
    car.seats = 0;
    car.free = { x: M(40), y: M(2.6), angle: 0, px: M(40), py: M(2.6), pangle: 0, lot: null };
    sim.ambient.parked.push(car);
  };

  const spawnWalker = (at: Spot, who: number, offset = 0): number | null => {
    const ox = Math.cos(at.facing + Math.PI / 2) * offset, oy = Math.sin(at.facing + Math.PI / 2) * offset;
    const x = at.x + ox, y = at.y + oy;
    const walker = sim.pedEngine.walkTrip?.(sim, {
      trip: who, fromX: x, fromY: y, toX: x + Math.cos(at.facing) * M(0.4), toY: y + Math.sin(at.facing) * M(0.4),
      seed: who, ageClass: 'adult', person: who, reach: M(40),
    }) ?? null;
    if (walker === null) return null;
    // Standing still, facing their way, until something happens to them.
    walkerAct(sim, walker, 'look', 1e6, x + Math.cos(at.facing) * M(5), y + Math.sin(at.facing) * M(5));
    return walker;
  };

  const lab: WeaponsLab = {
    spots: SPOTS.map((s) => s.key),
    spawn(key, who) {
      parkCar();
      if (key) spot = SPOTS.find((s) => s.key === key) ?? spot;
      if (id !== null) removeWalker(sim, id);
      if (who !== undefined) personId = who;
      id = spawnWalker(spot, personId);
      goneSince = null;
      events.length = 0;
      lastClip = '';
      traceWalkers(id !== null ? [id] : [], onTrace);
      if (follow) host.lookAt(spot.x, spot.y, zoom);
      host.requestDraw();
      return id ?? -1;
    },
    shoot(part, side = 'front') {
      if (id === null) return null;
      const w = walkerState(sim, id);
      if (!w) return lab.shootBody(part, side);
      const dir = directionOf(side, w.heading);
      const from = { x: w.x - dir.x * M(10), y: w.y - dir.y * M(10) };
      const done = sim.pedEngine.shot?.(sim, id, part, from.x, from.y) ?? null;
      if (done) host.scene().wound(w.x, w.y, host.heightAt(w) + M(PART_HEIGHT[part]), dir.x, dir.y, done.severed);
      host.requestDraw();
      return done;
    },
    shootBody(part, side = 'front') {
      const bodies = host.scene().ragdollProbe().filter((b) => !b.piece);
      const body = bodies.find((b) => b.id === id) ?? bodies[bodies.length - 1];
      if (!body) return null;
      const p = body.points[PART_POINT[part]]!;
      const dir = directionOf(side, spot.facing);
      // Down at it from a little above and to the side the shot comes from.
      const a: [number, number, number] = [p[0] - dir.x * M(1.5), p[1] - dir.y * M(1.5), p[2] + M(2)];
      const b: [number, number, number] = [p[0] + dir.x * M(0.3), p[1] + dir.y * M(0.3), p[2] - M(0.4)];
      const hit = host.scene().shootBody(a, b);
      if (hit && hit !== 'hit') {
        const done = sim.pedEngine.shot?.(sim, hit.alive, hit.part, p[0] - dir.x * M(10), p[1] - dir.y * M(10)) ?? null;
        if (done) host.scene().wound(p[0], p[1], p[2], dir.x, dir.y, done.severed);
      }
      host.requestDraw();
      return hit;
    },
    bomb(distance, strength = 5, side = 'front') {
      const w = id !== null ? walkerState(sim, id) : null;
      const at = w ?? spot;
      const dir = directionOf(side, w?.heading ?? spot.facing);
      const p = { x: at.x - dir.x * M(distance), y: at.y - dir.y * M(distance) };
      host.explode(p, host.heightAt(p), strength);
      host.requestDraw();
    },
    bystanders(count) {
      for (const w of watchers.splice(0)) removeWalker(sim, w);
      for (let k = 0; k < count; k++) {
        const ring = SPOTS[(SPOTS.indexOf(spot) + 1 + k) % SPOTS.length]!;
        const near: Spot = { ...ring, x: spot.x + Math.cos(k * 2.4) * M(3 + k), y: spot.y + Math.sin(k * 2.4) * M(1.2) };
        const w = spawnWalker(near, 910_001 + k);
        if (w !== null) watchers.push(w);
      }
      host.requestDraw();
    },
    setSpeed(s) {
      speed = s;
      host.setSpeed(s);
      host.scene().setEffectsSpeed(s);
      refresh();
    },
    step(seconds = 1 / 30) {
      host.runSim(seconds);
      host.scene().stepEffects(seconds);
      host.requestDraw();
    },
    clear() {
      // The street as built (a blast leaves craters, rubble and broken things in the document).
      host.loadDoc(labDoc().toJSON());
      host.scene().clearCasualties();
      for (const w of watchers.splice(0)) removeWalker(sim, w);
      lab.spawn();
    },
    record(on) {
      recording = on;
      if (on) { frames.length = 0; started = performance.now(); }
      refresh();
    },
    log: () => frames,
    timeline: () => events,
    playClip(clip) {
      if (id !== null) host.scene().forceClip(id, clip);
    },
    summary() {
      const worst = (f: (x: Frame) => number): number => frames.reduce((s, x) => Math.max(s, f(x)), 0);
      const flagCount: Record<string, number> = {};
      for (const f of frames) for (const flag of f.flags) flagCount[flag] = (flagCount[flag] ?? 0) + 1;
      return {
        frames: frames.length, seconds: frames.length ? (frames[frames.length - 1]!.t / 1000) : 0,
        underGround: worst((f) => Math.max(0, ...f.bodies.map((b) => b.underGround))),
        inWall: worst((f) => Math.max(0, ...f.bodies.map((b) => b.inWall))),
        boneError: worst((f) => Math.max(0, ...f.bodies.map((b) => b.boneError))),
        stretch: worst((f) => Math.max(0, ...f.mesh.filter((x) => x.held).map((x) => Math.abs(x.stretch - 1)))),
        scale: worst((f) => Math.max(0, ...f.mesh.map((x) => x.scale))),
        topSpeed: worst((f) => Math.max(0, ...f.bodies.map((b) => b.speed))),
        flags: flagCount,
        acts: [...new Set(frames.map((f) => f.person?.act ?? (f.person ? 'none' : 'gone')))],
        // The person jumping from one frame to the next (a teleport), metres.
        personJump: frames.reduce((j, f, i) => {
          const a = frames[i - 1]?.person, b = f.person;
          return a && b ? Math.max(j, Math.hypot(b.x - a.x, b.y - a.y) / M(1)) : j;
        }, 0),
        bodies: Math.max(0, ...frames.map((f) => f.bodies.length)),
      };
    },
  };

  /** A shot's way, from the side named, for somebody facing `heading`. */
  function directionOf(side: Side, heading: number): Vec2 {
    const a = side === 'front' ? heading + Math.PI : side === 'back' ? heading : side === 'left' ? heading - Math.PI / 2
      : side === 'right' ? heading + Math.PI / 2 : spot.into;
    return { x: Math.cos(a), y: Math.sin(a) };
  }

  // ------------------------------------------------------------ probes, each frame

  const readout = panel(lab, {
    follow: (on) => { follow = on; },
    zoom: (z) => { zoom = z; },
    auto: (on) => { autoRespawn = on; },
  });
  let last: Frame | null = null;
  const tick = (): void => {
    const now = performance.now();
    const scene = host.scene();
    frameNo++;
    const person = id !== null ? walkerState(sim, id) : null;
    const anim = id !== null ? scene.animProbe(id) : null;
    const clipNow = anim ? `${anim.source}:${anim.clip}` : 'none';
    if (id !== null && clipNow !== lastClip) {
      events.push({ t: now - labStart, frame: frameNo, id, field: 'clip', from: lastClip || 'none', to: clipNow,
        reason: `renderer (agents.ts procDraw) for act ${person?.act ?? '-'} at ${person ? (person.v / M(1)).toFixed(2) : '-'} m/s`, hp: person?.hp ?? 0, stack: '' });
      lastClip = clipNow;
    }
    const bodies = scene.ragdollProbe();
    const mesh = scene.meshProbe().filter((x) => x.id === id || watchers.includes(x.id) || x.held);
    const flags: string[] = [];
    for (const b of bodies) {
      if (b.underGround > 0.05) flags.push('underGround');
      if (b.inWall > 0.05) flags.push('inWall');
      if (b.boneError > 0.05) flags.push('boneError');
    }
    for (const x of mesh) {
      // On a body (a ragdoll): a played clip's own poses are authored, and
      // short bones (a twist, a clavicle) read noisy against a standing pose.
      if (x.held && Math.abs(x.stretch - 1) > 0.3) flags.push('stretch');
      if (x.scale > 1.3) flags.push('scale');
    }
    last = { t: now - started, person, anim, bodies, mesh, flags, id };
    if (recording && frames.length < 4000) frames.push(last);
    // Following the person, or their body once they are down.
    if (follow) {
      const mine = bodies.find((b) => b.id === id && !b.piece);
      const p = mine ? mine.points[0]! : person ? [person.x, person.y] : null;
      if (p) host.lookAt(p[0]!, p[1]!, zoom);
    }
    // Always somebody to test on: a new person a few seconds after the last one is gone.
    if (autoRespawn) {
      const gone = id === null || !person || Math.hypot(person.x - spot.x, person.y - spot.y) > M(20);
      if (gone && !bodies.some((b) => b.id === id && !b.piece && b.phase !== 'dead')) {
        goneSince ??= now;
        if (now - goneSince > 4000) { personId++; lab.spawn(); }
      } else goneSince = null;
    }
    readout(last, recording, speed);
    requestAnimationFrame(tick);
  };
  const refresh = (): void => { if (last) readout(last, recording, speed); };

  lab.spawn();
  requestAnimationFrame(tick);
  (globalThis as Record<string, unknown>)['__weaponsLab'] = lab;
  return lab;
}

/** The state of a walker's wounds, in words for the panel. */
function woundOf(p: NonNullable<ReturnType<typeof walkerState>>): string {
  if (p.hits === 0 && p.hp >= 100) return t('lab.unhurt');
  const grave = p.hp < 50 || p.lost.length > 0;
  return `${grave ? t('lab.grave') : t('lab.light')} (${p.hits} ${t('lab.hits')})`;
}

/** The lab's panel: the actions, and the probes read out live. */
function panel(lab: WeaponsLab, set: { follow: (on: boolean) => void; zoom: (z: number) => void; auto: (on: boolean) => void }):
  (f: Frame, recording: boolean, speed: number) => void {
  const root = document.createElement('div');
  root.className = 'weapons-lab';
  const style = document.createElement('style');
  style.textContent = `
.weapons-lab { position: fixed; left: 12px; top: 64px; width: 300px; max-height: calc(100vh - 150px); overflow-y: auto; z-index: 50;
  background: rgba(14, 22, 32, 0.92); color: #e8eef4; font: 12px/1.35 system-ui, sans-serif; border-radius: 10px; padding: 10px; }
.weapons-lab h4 { margin: 8px 0 4px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #8fb3d0; }
.weapons-lab .row { display: flex; flex-wrap: wrap; gap: 4px; }
.weapons-lab button, .weapons-lab select { background: #22344a; color: #e8eef4; border: 1px solid #35506e; border-radius: 6px; padding: 4px 7px; cursor: pointer; font: inherit; }
.weapons-lab button:hover { background: #2d4561; }
.weapons-lab button.on { background: #3d7bd0; border-color: #5d97e6; }
.weapons-lab pre { margin: 6px 0 0; white-space: pre-wrap; font: 11px/1.35 ui-monospace, monospace; color: #cfe0ee; }
.weapons-lab .bad { color: #ff8a7a; }
.weapons-lab label { display: inline-flex; align-items: center; gap: 4px; margin-right: 8px; }`;
  document.head.appendChild(style);
  document.body.appendChild(root);
  let side: Side = 'front';
  const button = (label: string, act: () => void, row: HTMLElement): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = act;
    row.appendChild(b);
    return b;
  };
  const section = (title: string): HTMLElement => {
    const h = document.createElement('h4');
    h.textContent = title;
    root.appendChild(h);
    const row = document.createElement('div');
    row.className = 'row';
    root.appendChild(row);
    return row;
  };
  const head = document.createElement('div');
  head.style.fontWeight = '600';
  head.textContent = t('lab.title');
  root.appendChild(head);

  const where = section(t('lab.spot'));
  const select = document.createElement('select');
  for (const key of lab.spots) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = t(`lab.spot.${key}`);
    select.appendChild(o);
  }
  select.onchange = () => lab.spawn(select.value);
  where.appendChild(select);
  button(t('lab.newPerson'), () => lab.spawn(undefined, 900_001 + Math.floor(Math.random() * 5000)), where);
  button(t('lab.clear'), () => lab.clear(), where);

  const from = section(t('lab.from'));
  const sides: Side[] = ['front', 'back', 'left', 'right', 'obstacle'];
  const sideButtons = sides.map((s) => button(t(`lab.side.${s}`), () => {
    side = s;
    sideButtons.forEach((b, i) => b.classList.toggle('on', sides[i] === s));
  }, from));
  sideButtons[0]!.classList.add('on');

  const parts: BodyPart[] = ['head', 'torso', 'armL', 'armR', 'legL', 'legR'];
  const shoot = section(t('lab.shoot'));
  for (const p of parts) button(t(`lab.part.${p}`), () => lab.shoot(p, side), shoot);
  const body = section(t('lab.shootBody'));
  for (const p of parts) button(t(`lab.part.${p}`), () => lab.shootBody(p, side), body);
  const bomb = section(t('lab.bomb'));
  for (const d of [1, 3, 6, 10]) button(t('lab.bombAt', { m: d }), () => lab.bomb(d, 5, side), bomb);

  const people = section(t('lab.bystanders'));
  for (const n of [0, 3, 6]) button(String(n), () => lab.bystanders(n), people);

  const clips = section(t('lab.clipCheck'));
  for (const c of ['idle', 'walk', 'hurtWalk', 'run', 'duck', 'cower', 'getUp']) button(c, () => lab.playClip(c), clips);
  button(t('lab.clipOff'), () => lab.playClip(null), clips);

  const time = section(t('lab.time'));
  const speeds = [1, 0.5, 0.25, 0.1, 0];
  const speedButtons = speeds.map((s) => button(s === 0 ? t('lab.pause') : `${s}x`, () => lab.setSpeed(s), time));
  button(t('lab.step'), () => lab.step(1 / 30), time);

  const camera = section(t('lab.camera'));
  const followBox = document.createElement('label');
  const followInput = document.createElement('input');
  followInput.type = 'checkbox';
  followInput.checked = true;
  followInput.onchange = () => set.follow(followInput.checked);
  followBox.append(followInput, t('lab.follow'));
  camera.appendChild(followBox);
  for (const z of [30, 50, 70]) button(t('lab.zoom', { z }), () => set.zoom(z), camera);
  const autoBox = document.createElement('label');
  const autoInput = document.createElement('input');
  autoInput.type = 'checkbox';
  autoInput.checked = true;
  autoInput.onchange = () => set.auto(autoInput.checked);
  autoBox.append(autoInput, t('lab.auto'));
  camera.appendChild(autoBox);

  const probes = section(t('lab.probes'));
  const rec = button(t('lab.record'), () => lab.record(!rec.classList.contains('on')), probes);
  button(t('lab.export'), () => {
    const blob = new Blob([JSON.stringify({ summary: lab.summary(), frames: lab.log() })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `weapons-lab-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, probes);
  const out = document.createElement('pre');
  root.appendChild(out);

  return (f, recording, speed) => {
    rec.classList.toggle('on', recording);
    rec.textContent = recording ? t('lab.recording', { n: lab.log().length }) : t('lab.record');
    speedButtons.forEach((b, i) => b.classList.toggle('on', speeds[i] === speed));
    const p = f.person;
    const lines: string[] = [];
    const a = f.anim;
    lines.push(p ? `${t('lab.person')} #${f.id}  hp ${p.hp.toFixed(0)}  ${t('lab.wound')}: ${woundOf(p)}`
      + `\n  ${t('lab.behaviour')}: ${p.act ?? '-'}${p.act ? ` ${p.actLeft.toFixed(1)}s` : ''}${p.rush ? `  ${t('lab.fleeing')} x${p.rush.by.toFixed(2)} ${p.rush.left.toFixed(1)}s` : ''}`
      + `\n  ${t('lab.movement')}: ${(p.v / M(1)).toFixed(2)} m/s  ${t('lab.bleeding')} ${p.bleeding.toFixed(1)}/s`
      + (p.lastHit ? `\n  ${t('lab.lastHit')}: ${t(`lab.part.${p.lastHit.part}`)} -${p.lastHit.damage.toFixed(0)} hp, ${p.lastHit.ago.toFixed(1)}s` : '')
      + (p.lost.length ? `\n  ${t('lab.lost')}: ${p.lost.join(', ')}` : '') : `${t('lab.person')}: ${t('lab.gone')}`);
    if (a) lines.push(`${t('lab.anim')}: ${a.clip}  t ${a.time.toFixed(2)}/${a.duration.toFixed(2)}s  ${t('lab.weight')} ${a.weight}`
      + `  ${a.paused ? t('lab.paused') : t('lab.playing')}  ${t('lab.source')}: ${a.source}${a.layers.length ? `\n  + ${a.layers.join(', ')}` : ''}`);
    for (const e of lab.timeline().slice(-6)) lines.push(`· ${(e.t / 1000).toFixed(2)}s ${e.field}: ${e.from} → ${e.to}\n    ${e.reason}`);
    for (const b of f.bodies) {
      lines.push(`${b.piece ? t('lab.piece') : t('lab.body')} #${b.id} ${b.phase}${b.asleep ? ' z' : ''}  v ${b.speed.toFixed(2)}`
        + `\n  ${t('lab.under')} ${(b.underGround * 100).toFixed(1)}cm  ${t('lab.inWall')} ${(b.inWall * 100).toFixed(1)}cm  ${t('lab.bone')} ${(b.boneError * 100).toFixed(1)}%`);
    }
    for (const x of f.mesh) {
      lines.push(`${t('lab.mesh')} #${x.id} ${x.clip}${x.held ? ' (ragdoll)' : ''}: ${t('lab.stretch')} ${x.stretch.toFixed(2)} ${x.stretchBone}  ${t('lab.scale')} ${x.scale.toFixed(2)}`);
    }
    out.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = lines.join('\n');
    out.appendChild(text);
    if (f.flags.length) {
      const bad = document.createElement('div');
      bad.className = 'bad';
      bad.textContent = `${t('lab.problems')}: ${[...new Set(f.flags)].join(', ')}`;
      out.appendChild(bad);
    }
  };
}
