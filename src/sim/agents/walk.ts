import type { Vec2 } from '@core/vec2';
import { buildWalkways, type WalkGraph, type Walkway } from '@world/walkways';
import { m } from '@world/units';
import type { SegmentId } from '@world/ids';
import { DT, PED } from '../params';
import { vehiclePose } from '../pose';
import type { SimWorld } from '../world';
import type { AuditIssue } from '../audit';
import { emptyCrossingState } from '../crossings/state';
import { indexReservations, mayEnterCrossing } from '../crossings/permission';
import { makeCrossingId, type CrossingId } from '../signals/plan';
import type { SidewalkEdge } from '../peds/sidewalk';
import { type GestureKind, personHash, type PedView, type PersonAgeClass, type PersonGender } from '../people/view';
import type { PedestrianEngine, PeopleBridge, ResidentWalk } from '../people/engine';
import { ASK_WAY, carSweep, crossesFootway } from './cars';

/**
 * The agents' walking: people on lanes of the footways, as SUMO's striping
 * model walks them (sumo.dlr.de, "Pedestrians": a footway cut into stripes;
 * each person takes the stripe with the most room ahead, keeps right of
 * somebody coming the other way, and walks as fast as that room allows).
 *
 * The ground is `world/walkways.ts`: footways down the middle of each
 * footway's through zone, corners round each junction, crossings on the
 * zebras, each with the lateral room a walker may use either side of it
 * (`lo`/`hi`). A walker's route is a chain of those walkways found by
 * shortest path. Along it:
 *
 * - the stripe (`aim`, the offset left of the way walked) is the one with the
 *   most free distance ahead (the room to the next body in it, halved for
 *   somebody coming the other way), with a pull to the right; a walker held
 *   up steps aside into it, no faster than a person sidesteps;
 * - the speed is what the room ahead in its own stripe allows, a person
 *   following another at a step's distance;
 * - the body walks towards a point a step or so ahead on its route, in its
 *   stripe, turning at a person's turn rate and only ever moving the way it
 *   faces (a pure pursuit, the path follower of Reynolds' "Steering Behaviors
 *   for Autonomous Characters"): it never jumps, never slides sideways and
 *   never steps backwards, and it rounds a corner instead of snapping to it;
 * - at a zebra it stands at the kerb until the crossing is theirs by the rule
 *   every pedestrian keeps (`crossings/permission.ts`: the signal, or a gap in
 *   the traffic), and while on it is published to the vehicles
 *   (`SimWorld.crossingStates`), which stop for it;
 * - an agent's car off the road is solid; one crossing the footway takes the
 *   ground it is about to cover in turn with the people (`OwnCars.holdWay`):
 *   a walker keeps off it while the car holds it, and walks on out of it if
 *   the car came to them;
 * - somebody held still a long while (`JAM_AFTER`) is let through others
 *   slowly, as SUMO's jammed state does, so nobody is ever stuck for good.
 *
 * Only residents walk here (the default; `?agents=0` brings back the People
 * engine): from a door to a door, or to and from their car. Nobody is made up
 * to fill the streets.
 */

/** Width of one stripe, world units: SUMO's default, a person's room abreast. */
const STRIPE = m(0.65);
/** A body's radius: two people closer than twice this, side by side, touch. */
const BODY = m(0.27);
/** Two people this far apart side by side pass each other, u. */
const SHOULDERS = m(0.5);
/** Fastest a body steps sideways, u/s. */
const SIDESTEP = m(0.45);
/** How far ahead others are looked for. */
const LOOK = m(8);
/** The gap a walker keeps to the body ahead, and the time headway behind it. */
const KEEP = m(0.45);
const HEADWAY = 0.5;
/** Acceleration and braking of a walker, u/s². */
const ACCEL = m(1.2);
const BRAKE = m(2.5);
/** A new stripe must be this much better to be taken: no dithering between two. */
const SWITCH_GAIN = m(1.2);
/** Held still this long, a walker is let through others slowly (SUMO's jamtime: 10 s on a crossing). */
const JAM_AFTER = 20;
const JAM_AFTER_CROSSING = 10;
/** Speed of a jammed walker, as a share of their own. */
const JAM_SHARE = 0.25;
/** How far ahead on the route the body walks towards, u. */
const AHEAD = m(0.9);
/** Fastest a body turns walking, and standing (on the spot), rad/s. */
const TURN_RATE = 3.5;
const TURN_STANDING = 6;
/** Extra cost of a crossing on a route, u: a zebra is walked to only when worth it. */
const CROSSING_COST = m(12);
/** Where a walker stands to wait: this far back from the kerb. */
const KERB_BACK = m(0.35);
/** A walker this far from the waiting place starts asking whether they may cross. */
const ASK_FROM = m(1.5);
/** How often a waiting walker asks whether they may cross, seconds. */
const ASK_EVERY = 0.25;
/** Farthest a door or a car may be from the walkways, by default. */
const REACH = m(30);
/** Somebody this near the spot a walker steps out onto keeps them inside a moment, u. */
const DOOR_CLEAR = m(0.8);
/** The end of a walk is reached this near it. */
const THERE = m(0.25);
/** Spatial cells for the walkers and for the walkways. */
const CELL = m(6);
const WAY_CELL = m(20);

interface Step {
  /** The walkway, or null for a straight stretch off it (to a door or a car). */
  readonly way: Walkway | null;
  /** +1 along the way from `a` to `b`, -1 the other way. */
  readonly dir: 1 | -1;
  /** Arc position on the way where the step starts, and where it ends. */
  readonly from: number;
  readonly to: number;
  /** Off the walkways: the straight line walked. */
  readonly a?: Vec2;
  readonly b?: Vec2;
}

interface Walker {
  readonly id: number;
  readonly trip: number;
  readonly view: PedView;
  readonly pace: number;
  readonly steps: Step[];
  leg: number;
  /** Progress along this step, and the offset left of it: the body projected on it. */
  s: number;
  d: number;
  /** The stripe it walks in: offset left of the way walked. */
  aim: number;
  v: number;
  x: number; y: number; heading: number;
  prevX: number; prevY: number; prevHeading: number;
  turnV: number;
  age: number;
  /** Seconds held still while meaning to walk. */
  held: number;
  /** Waiting for a zebra: seconds waited, and the time to the next ask. */
  waited: number;
  asked: number;
  /** The zebra it has been let onto. */
  granted: CrossingId | null;
  /**
   * Not out yet: waiting inside the door (or the car) until the spot it steps
   * out onto is clear. As SUMO inserts a person only where there is room, a
   * crowd leaving one building comes out one after another.
   */
  inside: boolean;
  /** The zebra it is coming up to, and the one it stands waiting for. */
  zebra: Zebra | null;
  waiting: Zebra | null;
  done: boolean;
  /** Moved by the player's hand, not by its route (`movePlayerWalker`). */
  player: boolean;
  /** Stopped to do something a while (talk, fall down), facing a point: until `age` reaches `until`. */
  act: { readonly kind: GestureKind; readonly from: number; readonly until: number; readonly faceX: number; readonly faceY: number } | null;
  /** Running away from something: pace times `by` until `age` reaches `until`; then on to `goal`. */
  rush: { readonly by: number; readonly until: number; readonly goal: Vec2 } | null;
}

interface State {
  graph: WalkGraph | null;
  builtFor: string;
  wayIndex: Map<string, number[]>;
  walkers: Walker[];
  byId: Map<number, Walker>;
  arrivals: number[];
  nextId: number;
  /**
   * For each car holding (or asking for) its way across the footway, the
   * walkers who were on that ground when it took it: they walk on off it;
   * everybody else keeps off it.
   */
  onCarWay: Map<number, Set<number>>;
}

const STATES = new WeakMap<SimWorld, State>();
function stateOf(w: SimWorld): State {
  let s = STATES.get(w);
  if (!s) {
    s = { graph: null, builtFor: '', wayIndex: new Map(), walkers: [], byId: new Map(), arrivals: [], nextId: 1, onCarWay: new Map() };
    STATES.set(w, s);
  }
  return s;
}

const hypot = Math.hypot;
const cellKey = (x: number, y: number, size: number): string => `${Math.floor(x / size)},${Math.floor(y / size)}`;

// ------------------------------------------------------------------ ground

/** The walkways of the map as it is now, built again when the network changes. */
function ensureGraph(w: SimWorld, s: State): WalkGraph | null {
  const key = `${w.net.revision}:${w.topologyRevision}`;
  if (s.graph && s.builtFor === key) return s.graph;
  s.graph = buildWalkways(w.net);
  s.builtFor = key;
  s.wayIndex.clear();
  for (const way of s.graph.ways) {
    const bb = way.path.bbox;
    const pad = Math.max(Math.abs(way.lo), Math.abs(way.hi));
    for (let x = Math.floor((bb.minX - pad) / WAY_CELL); x <= Math.floor((bb.maxX + pad) / WAY_CELL); x++) {
      for (let y = Math.floor((bb.minY - pad) / WAY_CELL); y <= Math.floor((bb.maxY + pad) / WAY_CELL); y++) {
        const k = `${x},${y}`;
        const list = s.wayIndex.get(k);
        if (list) list.push(way.id); else s.wayIndex.set(k, [way.id]);
      }
    }
  }
  return s.graph;
}

/** The walkway nearest a point within `reach` (crossings excluded: nobody starts on a zebra). */
function nearestWay(s: State, p: Vec2, reach: number): { way: Walkway; s: number; distance: number } | null {
  const g = s.graph;
  if (!g) return null;
  let best: { way: Walkway; s: number; distance: number } | null = null;
  const span = Math.ceil(reach / WAY_CELL);
  const cx = Math.floor(p.x / WAY_CELL), cy = Math.floor(p.y / WAY_CELL);
  const seen = new Set<number>();
  for (let x = cx - span; x <= cx + span; x++) {
    for (let y = cy - span; y <= cy + span; y++) {
      for (const id of s.wayIndex.get(`${x},${y}`) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const way = g.ways[id]!;
        if (way.kind === 'crossing') continue;
        const hit = way.path.closestPoint(p);
        if (hit.distance > reach) continue;
        if (!best || hit.distance < best.distance) best = { way, s: hit.s, distance: hit.distance };
      }
    }
  }
  return best;
}

/** The cost of walking a way: its length, and more for a zebra. */
const wayCost = (way: Walkway): number => way.path.length + (way.kind === 'crossing' ? CROSSING_COST : 0);

/**
 * The steps from one point on a way to another: the shortest chain of
 * walkways between them (Dijkstra over the walkway nodes).
 */
function route(g: WalkGraph, from: { way: Walkway; s: number }, to: { way: Walkway; s: number }): Step[] | null {
  if (from.way.id === to.way.id) {
    return [{ way: from.way, dir: to.s >= from.s ? 1 : -1, from: from.s, to: to.s }];
  }
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  const open: { node: number; d: number }[] = [];
  const push = (node: number, d: number, way: number): void => {
    if (d >= dist[node]!) return;
    dist[node] = d;
    via[node] = way;
    open.push({ node, d });
  };
  push(from.way.a, from.s, from.way.id);
  push(from.way.b, from.way.path.length - from.s, from.way.id);
  const done = new Uint8Array(n);
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.d < open[bi]!.d) bi = i;
    const { node, d } = open[bi]!;
    open[bi] = open[open.length - 1]!;
    open.pop();
    if (done[node]) continue;
    done[node] = 1;
    if (node === to.way.a || node === to.way.b) {
      // Settled at one end of the goal way; the other end is settled too or farther.
    }
    for (const wid of g.at.get(node) ?? []) {
      const way = g.ways[wid]!;
      if (way.id === from.way.id) continue;
      const other = way.a === node ? way.b : way.a;
      push(other, d + wayCost(way), way.id);
    }
  }
  const ends = [
    { node: to.way.a, total: dist[to.way.a]! + to.s },
    { node: to.way.b, total: dist[to.way.b]! + (to.way.path.length - to.s) },
  ].sort((p, q) => p.total - q.total);
  const end = ends[0]!;
  if (!Number.isFinite(end.total)) return null;
  // Back from the goal's end node to the start way.
  const chain: { way: Walkway; enter: number }[] = [];
  let node = end.node;
  let guard = 0;
  while (guard++ < n) {
    const wid = via[node]!;
    if (wid < 0) return null;
    const way = g.ways[wid]!;
    if (way.id === from.way.id) break;
    chain.push({ way, enter: way.a === node ? way.b : way.a });
    node = way.a === node ? way.b : way.a;
  }
  chain.reverse();
  const steps: Step[] = [];
  // Off the start way at the end the route leaves it by.
  const leaveAtB = node === from.way.b;
  steps.push({ way: from.way, dir: leaveAtB ? 1 : -1, from: from.s, to: leaveAtB ? from.way.path.length : 0 });
  for (const { way, enter } of chain) {
    const forward = enter === way.a;
    steps.push({ way, dir: forward ? 1 : -1, from: forward ? 0 : way.path.length, to: forward ? way.path.length : 0 });
  }
  const arriveAtA = end.node === to.way.a;
  steps.push({ way: to.way, dir: arriveAtA ? 1 : -1, from: arriveAtA ? 0 : to.way.path.length, to: to.s });
  return steps;
}


// ------------------------------------------------------------------ frames

const stepLength = (st: Step): number => st.way ? Math.abs(st.to - st.from) : hypot(st.b!.x - st.a!.x, st.b!.y - st.a!.y);

/** Point and walking tangent at `s` along a step; past either end it goes on straight. */
function frame(st: Step, s: number): { x: number; y: number; tx: number; ty: number } {
  if (!st.way) {
    const len = Math.max(1e-6, stepLength(st));
    const tx = (st.b!.x - st.a!.x) / len, ty = (st.b!.y - st.a!.y) / len;
    return { x: st.a!.x + tx * s, y: st.a!.y + ty * s, tx, ty };
  }
  const len = stepLength(st);
  const k = Math.max(0, Math.min(len, s));
  const f = st.way.path.sampleAt(st.from + st.dir * k);
  const tx = f.t.x * st.dir, ty = f.t.y * st.dir;
  const over = s - k;
  return { x: f.p.x + tx * over, y: f.p.y + ty * over, tx, ty };
}

/** A body projected on a step: how far along it, and how far left of it. */
function project(st: Step, x: number, y: number): { s: number; d: number } {
  if (!st.way) {
    const f = frame(st, 0);
    return { s: (x - f.x) * f.tx + (y - f.y) * f.ty, d: -(x - f.x) * f.ty + (y - f.y) * f.tx };
  }
  const hit = st.way.path.closestPoint({ x, y });
  let s = (hit.s - st.from) * st.dir;
  const f = frame(st, s);
  s += (x - f.x) * f.tx + (y - f.y) * f.ty;
  return { s, d: -(x - f.x) * f.ty + (y - f.y) * f.tx };
}

/**
 * The lateral room of a step in its own walking frame, [low, high], left
 * positive, for a body's centre. Round the inside of a corner a walker keeps
 * within half its radius: farther in, the line would fold back on itself.
 */
function room(st: Step): [number, number] {
  if (!st.way) return [0, 0];
  let lo = st.way.lo + BODY, hi = st.way.hi - BODY;
  if (st.dir === -1) [lo, hi] = [-hi, -lo];
  if (st.way.kind === 'corner') {
    const len = stepLength(st);
    const a = frame(st, 0), b = frame(st, len);
    const turn = Math.atan2(a.tx * b.ty - a.ty * b.tx, a.tx * b.tx + a.ty * b.ty);
    if (Math.abs(turn) > 0.2) {
      const r = len / Math.abs(turn);
      if (turn > 0) hi = Math.min(hi, r * 0.5); else lo = Math.max(lo, -r * 0.5);
    }
  }
  if (lo > hi) lo = hi = (lo + hi) / 2;
  return [lo, hi];
}

const clamp = (v: number, [lo, hi]: [number, number]): number => Math.max(lo, Math.min(hi, v));

/** How far a footway's walking line is from its kerb (where a crossing's end meets the road). */
const kerbInset = (way: Walkway | null | undefined): number =>
  !way || way.kind === 'crossing' ? 0 : way.kerb < 0 ? -way.lo : way.hi;

// ------------------------------------------------------------------ crossings

/**
 * A crossing on a walker's way: a zebra as the vehicles and the signals know
 * it (`edge`), or a crossing with no zebra (`edge` null: the end of a road that
 * leads nowhere, `Walkway.unmarked`), where the walker takes a gap.
 */
interface Zebra { readonly id: CrossingId; readonly edge: SidewalkEdge | null; readonly way: Walkway }

function crossingOf(w: SimWorld, way: Walkway | null | undefined): Zebra | null {
  if (!way || way.kind !== 'crossing' || way.node === undefined || way.segment === undefined) return null;
  const id = makeCrossingId(way.node, way.segment);
  const edge = way.unmarked ? null : w.sidewalks.crossingEdge(id) ?? null;
  return edge || way.unmarked ? { id, edge, way } : null;
}

/** Margin of clear road a walker wants beyond their own time across, s; after `IMPATIENT` waiting, none. */
const GAP_MARGIN = 2;
const IMPATIENT = 30;
/** A vehicle this near the crossing keeps a walker on the kerb whatever it is doing, u. */
const GAP_NEAR = m(6);

/**
 * Whether a walker may step onto a crossing with no zebra: no vehicle near
 * it, and none coming that would reach it before they are across and a
 * margin more (gap acceptance, as SUMO's pedestrians take a crossing without
 * priority). Nothing stops for them there.
 */
function gapOpen(w: SimWorld, z: Zebra, pace: number, waited: number): boolean {
  const path = z.way.path;
  const time = path.length / Math.max(pace, m(0.5)) + (waited < IMPATIENT ? GAP_MARGIN : 0);
  for (const v of w.vehicles.values()) {
    const pose = vehiclePose(w, v, 1);
    if (!pose) continue;
    const hit = path.closestPoint(pose.p);
    if (hit.distance < GAP_NEAR) return false;
    if (v.v < m(0.5) || hit.distance > v.v * time) continue;
    // Coming towards it, not going away.
    if ((hit.point.x - pose.p.x) * Math.cos(pose.angle) + (hit.point.y - pose.p.y) * Math.sin(pose.angle) > 0) return false;
  }
  return true;
}

/**
 * The zebra a walker is coming up to and has not been let onto, and the
 * distance along its route to where it waits for it (a step back from the
 * kerb); null when none is ahead on this step or the next.
 */
function zebraAhead(w: SimWorld, p: Walker): { zebra: Zebra; stop: number } | null {
  const st = p.steps[p.leg]!;
  const here = crossingOf(w, st.way);
  if (here) {
    const kerb = kerbInset(p.steps[p.leg - 1]?.way);
    if (p.granted === here.id || p.s >= kerb) return null;
    return { zebra: here, stop: kerb - KERB_BACK - p.s };
  }
  const next = p.steps[p.leg + 1];
  const ahead = crossingOf(w, next?.way);
  if (!ahead || p.granted === ahead.id) return null;
  return { zebra: ahead, stop: stepLength(st) - p.s + kerbInset(st.way) - KERB_BACK };
}

/** Whether a walker is out on a zebra's carriageway, kerb to kerb. */
function onZebra(w: SimWorld, p: Walker): Zebra | null {
  const st = p.steps[p.leg]!;
  const z = crossingOf(w, st.way);
  if (!z) return null;
  const from = kerbInset(p.steps[p.leg - 1]?.way), to = stepLength(st) - kerbInset(p.steps[p.leg + 1]?.way);
  return p.s >= from && p.s <= to ? z : null;
}

// ------------------------------------------------------------------ engine

export function createAgentWalkEngine(): PedestrianEngine {
  const bridge: PeopleBridge = {
    hailable: () => null,
    board: () => null,
    alight: () => {},
    anyoneWithin(w, x, y, radius, except) {
      for (const p of stateOf(w).walkers) if (!p.inside && p.id !== except && hypot(p.x - x, p.y - y) < radius) return true;
      return false;
    },
  };
  const engine: PedestrianEngine = {
    kind: 'people',
    bridge,
    beginTick(w) {
      for (const p of stateOf(w).walkers) { p.prevX = p.x; p.prevY = p.y; p.prevHeading = p.heading; }
    },
    dispatch() {},
    step(w) { stepWalkers(w); },
    rebind(w) {
      const s = stateOf(w);
      ensureGraph(w, s);
      // Everybody walking goes on from where they stand, on what is left.
      for (const p of s.walkers) {
        const last = p.steps[p.steps.length - 1]!;
        const end = frame(last, stepLength(last));
        const steps = plan(w, s, { x: p.x, y: p.y }, { x: end.x, y: end.y }, REACH);
        if (!steps) { finish(s, p); continue; }
        p.steps.length = 0;
        p.steps.push(...steps);
        p.leg = 0;
        p.granted = null;
        const pr = project(steps[0]!, p.x, p.y);
        p.s = pr.s; p.d = pr.d; p.aim = clamp(pr.d, room(steps[0]!));
      }
      prune(s);
    },
    publish(w) { publish(w); },
    audit(_w: SimWorld, _out: AuditIssue[]) {},
    reset(w) {
      const s = stateOf(w);
      s.walkers.length = 0;
      s.byId.clear();
      s.arrivals.length = 0;
      s.graph = null;
      s.builtFor = '';
    },
    walkTrip(w, trip) { return startWalk(w, trip); },
    takeArrivals(w) {
      const s = stateOf(w);
      const out = s.arrivals.slice();
      s.arrivals.length = 0;
      return out;
    },
    walkableNear(w, x, y, reach) {
      const s = stateOf(w);
      ensureGraph(w, s);
      const hit = nearestWay(s, { x, y }, reach);
      return hit ? hit.way.path.sampleAt(hit.s).p : null;
    },
  };
  // For probes in the page: what each walker is doing (`inspectAgentWalkers`).
  (engine as PedestrianEngine & { inspect?: typeof inspectAgentWalkers }).inspect = inspectAgentWalkers;
  return engine;
}

/** The steps from a point to a point: to the walkways, along them, and off to the end. */
function plan(w: SimWorld, s: State, from: Vec2, to: Vec2, reach: number): Step[] | null {
  const g = ensureGraph(w, s);
  if (!g) return null;
  const a = nearestWay(s, from, reach);
  const b = nearestWay(s, to, reach);
  if (!a || !b) return null;
  const along = route(g, a, b);
  if (!along) return null;
  const steps: Step[] = [];
  const onA = a.way.path.sampleAt(a.s).p;
  if (hypot(onA.x - from.x, onA.y - from.y) > m(0.3)) steps.push({ way: null, dir: 1, from: 0, to: 0, a: from, b: onA });
  steps.push(...along.filter((st) => Math.abs(st.to - st.from) > 1e-6));
  const onB = b.way.path.sampleAt(b.s).p;
  if (hypot(onB.x - to.x, onB.y - to.y) > m(0.3)) steps.push({ way: null, dir: 1, from: 0, to: 0, a: onB, b: to });
  return steps.length ? steps : [{ way: null, dir: 1, from: 0, to: 0, a: from, b: to }];
}

function startWalk(w: SimWorld, trip: ResidentWalk): number | null {
  const s = stateOf(w);
  const steps = plan(w, s, { x: trip.fromX, y: trip.fromY }, { x: trip.toX, y: trip.toY }, Math.max(trip.reach ?? 0, REACH));
  if (!steps) return null;
  const id = trip.person ?? s.nextId++;
  const old = s.byId.get(id);
  if (old) finish(s, old, false);
  const gender: PersonGender = trip.person !== undefined ? ((personHash(trip.person) & 1) === 0 ? 'f' : 'm')
    : (trip.seed & 1) === 1 ? 'f' : 'm';
  const ageClass: PersonAgeClass = trip.ageClass;
  const h = personHash(id);
  const pace = Math.max(PED.minSpeed, Math.min(PED.maxSpeed,
    PED.meanSpeed + ((h % 1000) / 1000 - 0.5) * 2 * PED.speedSd)) * (ageClass === 'elder' ? 0.8 : ageClass === 'child' ? 0.9 : 1);
  const first = frame(steps[0]!, 0);
  const heading = Math.atan2(first.ty, first.tx);
  const view: PedView = {
    id, x: trip.fromX, y: trip.fromY, heading, prev: { x: trip.fromX, y: trip.fromY, heading },
    v: 0, turnV: 0, age: 0, ageClass, gender,
    party: { id, size: 1, archetype: 'solo', hasChild: false }, rank: 0,
    ground: 'footway', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null, gesture: null,
  };
  const p: Walker = {
    id, trip: trip.trip, view, pace, steps, leg: 0, s: 0, d: 0, aim: 0, v: 0,
    x: trip.fromX, y: trip.fromY, heading, prevX: trip.fromX, prevY: trip.fromY, prevHeading: heading,
    turnV: 0, age: 0, held: 0, waited: 0, asked: 0, granted: null, done: false, waiting: null, zebra: null, inside: true,
    player: false, act: null, rush: null,
  };
  const pr = project(steps[0]!, p.x, p.y);
  p.s = pr.s; p.d = pr.d; p.aim = clamp(pr.d, room(steps[0]!));
  s.walkers.push(p);
  s.byId.set(id, p);
  return id;
}

function finish(s: State, p: Walker, arrived = true): void {
  p.done = true;
  s.byId.delete(p.id);
  if (arrived) s.arrivals.push(p.trip);
}

function prune(s: State): void {
  if (s.walkers.some((q) => q.done)) s.walkers = s.walkers.filter((q) => !q.done);
}

/** The point the body walks towards: a little ahead on its route, in its stripe. */
function target(p: Walker): { x: number; y: number } {
  let leg = p.leg;
  let st = p.steps[leg]!;
  let s = p.s + AHEAD;
  while (s > stepLength(st) && leg + 1 < p.steps.length) {
    s -= stepLength(st);
    leg++;
    st = p.steps[leg]!;
  }
  if (leg === p.steps.length - 1) s = Math.min(s, stepLength(st));
  // In this step, its stripe; in the next, where it is now across that one.
  const d = leg === p.leg ? p.aim : clamp(project(st, p.x, p.y).d, room(st));
  const f = frame(st, s);
  return { x: f.x - f.ty * d, y: f.y + f.tx * d };
}

// ------------------------------------------------------------------ the step

function stepWalkers(w: SimWorld): void {
  const s = stateOf(w);
  if (!s.walkers.length) return;
  ensureGraph(w, s);
  indexReservations(w);
  // Who is where, a cell of a few metres each.
  const cells = new Map<string, Walker[]>();
  const enter = (p: Walker): void => {
    const k = cellKey(p.x, p.y, CELL);
    const list = cells.get(k);
    if (list) list.push(p); else cells.set(k, [p]);
  };
  for (const p of s.walkers) if (!p.inside) enter(p);
  const others: { along: number; lat: number; oncoming: boolean; r: number }[] = [];
  // The agents' own cars off the road: solid to a walker as a person is (the
  // body three discs along its length, half its width round: a walker's own
  // body is the margin, so a car in the road by the kerb does not close the
  // kerb-side stripe); and, for a car holding its way across the footway or
  // asking for it (`OwnCars.holdWay`), the ground it is about to cover, kept
  // off with a little room. Somebody already inside one walks on out of it.
  const carZones: { x0: number; y0: number; x1: number; y1: number; discs: { x: number; y: number; r: number }[]; on: Set<number> | null;
    /** Its way kept off only by people crossing the carriageway (a car at the kerb, `crossesFootway`). */
    crossingOnly: boolean }[] = [];
  const holding = new Set<number>();
  for (const car of w.city.cars?.offRoad() ?? []) {
    const f = car.free;
    if (!f) continue;
    const r = car.archetype.width / 2;
    const reach = Math.max(0, car.archetype.length / 2 - r);
    const discs = [-1, 0, 1].map((k) => ({ x: f.x + Math.cos(f.angle) * reach * k, y: f.y + Math.sin(f.angle) * reach * k, r }));
    const t = w.city.cars!.tripOfCar(car.id);
    let on: Set<number> | null = null;
    if (t && (t.reserved || t.waitedPeople >= ASK_WAY)) {
      const way = carSweep(t, m(0.5));
      discs.push(...way);
      holding.add(car.id);
      on = s.onCarWay.get(car.id) ?? null;
      if (!on) {
        // The ground just taken: whoever is on it now walks on off it.
        on = new Set(s.walkers.filter((p) => !p.inside && way.some((c) => hypot(c.x - p.x, c.y - p.y) < c.r)).map((p) => p.id));
        s.onCarWay.set(car.id, on);
      }
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of discs) { x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); }
    carZones.push({ x0, y0, x1, y1, discs, on, crossingOnly: t !== null && !crossesFootway(t) });
  }
  for (const id of [...s.onCarWay.keys()]) if (!holding.has(id)) s.onCarWay.delete(id);
  // The trains at grade: solid as cars are (nobody walks across a level crossing under one).
  for (const discs of w.city.transit.trainZones()) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of discs) { x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); }
    // `on` empty: whoever is on a train's ground walks off it (`inside` below).
    carZones.push({ x0, y0, x1, y1, discs, on: TRAIN_GROUND, crossingOnly: false });
  }


  for (const p of s.walkers) {
    p.age += DT;
    if (p.inside) {
      // Out when nobody is on the spot; then the next one waits for them to move off it.
      let clear = true;
      const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
      for (let gx = cx - 1; gx <= cx + 1 && clear; gx++) for (let gy = cy - 1; gy <= cy + 1 && clear; gy++) {
        for (const q of cells.get(`${gx},${gy}`) ?? []) if (hypot(q.x - p.x, q.y - p.y) < DOOR_CLEAR) { clear = false; break; }
      }
      // Nor while a car holds the ground they would step onto: they wait for it to pass.
      if (clear && carZones.some((z) => z.discs.some((c) => hypot(c.x - p.x, c.y - p.y) < c.r + BODY))) clear = false;
      if (clear) { p.inside = false; p.prevX = p.x; p.prevY = p.y; p.prevHeading = p.heading; enter(p); }
      continue;
    }
    // The player's body goes where the player moves it (`movePlayerWalker`).
    if (p.player) continue;
    // Stopped for something (a word, a fall): standing there, facing it.
    if (p.act) {
      if (p.age < p.act.until) {
        p.v = 0;
        const want = Math.atan2(p.act.faceY - p.y, p.act.faceX - p.x);
        if (hypot(p.act.faceX - p.x, p.act.faceY - p.y) > m(0.1) && p.act.kind !== 'fall') {
          const err = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
          p.heading += Math.max(-TURN_STANDING * DT, Math.min(TURN_STANDING * DT, err));
        }
        continue;
      }
      p.act = null;
    }
    // A run from danger over: on again to where they were going.
    if (p.rush && p.age >= p.rush.until) {
      const goal = p.rush.goal;
      p.rush = null;
      replan(w, s, p, goal);
    }
    let st = p.steps[p.leg]!;
    const f = frame(st, p.s);
    const span = room(st);
    // On a zebra, and waiting at one, everybody keeps to their right half:
    // those coming the other way, and those waiting, are on the other half.
    if (crossingOf(w, st.way)) span[1] = Math.max(span[0], Math.min(span[1], BODY / 2));

    // --- the others, in this walker's own frame: how far ahead, how far across, which way they go.
    others.length = 0;
    const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
    for (let gx = cx - 2; gx <= cx + 2; gx++) for (let gy = cy - 2; gy <= cy + 2; gy++) {
      for (const q of cells.get(`${gx},${gy}`) ?? []) {
        if (q === p) continue;
        const rx = q.x - p.x, ry = q.y - p.y;
        const along = rx * f.tx + ry * f.ty;
        if (along <= 0 || along > LOOK) continue;
        const lat = p.d - rx * f.ty + ry * f.tx;
        const oncoming = q.v > m(0.1) && Math.cos(q.heading) * f.tx + Math.sin(q.heading) * f.ty < -0.3;
        others.push({ along, lat, oncoming, r: SHOULDERS - BODY });
      }
    }
    for (const z of carZones) {
      if (p.x < z.x0 - LOOK || p.x > z.x1 + LOOK || p.y < z.y0 - LOOK || p.y > z.y1 + LOOK) continue;
      // On it when the car took it, or inside the car's body (the car came to
      // them): they walk on out of its way.
      const inside = z.discs.some((c) => hypot(c.x - p.x, c.y - p.y) < c.r);
      if (inside && (z.on === TRAIN_GROUND || z.on?.has(p.id) || z.discs.slice(0, 3).some((c) => hypot(c.x - p.x, c.y - p.y) < c.r))) continue;
      if (!inside) z.on?.delete(p.id);
      const crossingNow = st.way?.kind === 'crossing';
      for (const [i, c] of z.discs.entries()) {
        // Past the body (`i >= 3`), a kerb car's way is only for those crossing.
        if (i >= 3 && z.crossingOnly && !crossingNow) break;
        const rx = c.x - p.x, ry = c.y - p.y;
        const along = rx * f.tx + ry * f.ty - c.r + BODY;
        if (along + 2 * c.r <= 0 || along > LOOK) continue;
        others.push({ along: Math.max(0.01, along), lat: p.d - rx * f.ty + ry * f.tx, oncoming: false, r: c.r });
      }
    }
    /** Free distance ahead in a stripe centred `c` across the step. */
    const free = (c: number): number => {
      let gap = LOOK;
      for (const o of others) {
        if (Math.abs(o.lat - c) >= BODY + o.r) continue;
        const g = o.oncoming ? o.along / 2 : o.along;
        if (g < gap) gap = g;
      }
      return gap;
    };

    // --- the stripe: the most room ahead, keeping to the right (SUMO's striping).
    if (span[1] > span[0]) {
      const right = span[0] + Math.min(span[1] - span[0], STRIPE * 0.5);
      let best = p.aim, bestScore = free(p.aim) - (p.aim - right) * 0.15 + SWITCH_GAIN;
      for (let c = span[0]; c <= span[1] + 1e-6; c += STRIPE / 2) {
        const score = free(c) - (c - right) * 0.15 - Math.abs(c - p.d) * 0.2;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      p.aim = clamp(best, span);
    }
    p.aim = clamp(p.aim, span);

    // --- a zebra ahead: wait a step back from the kerb until it is theirs.
    const zebra = zebraAhead(w, p);
    p.zebra = zebra?.zebra ?? null;
    p.waiting = null;
    if (zebra && zebra.stop < ASK_FROM) {
      p.waiting = zebra.zebra;
      p.waited += DT;
      p.asked -= DT;
      if (p.asked <= 0) {
        p.asked = ASK_EVERY;
        const open = zebra.zebra.edge ? mayEnterCrossing(w, zebra.zebra.edge, p.waited) : gapOpen(w, zebra.zebra, p.pace, p.waited);
        if (open) { p.granted = zebra.zebra.id; p.waited = 0; p.waiting = null; }
      }
    }
    const stop = p.waiting ? Math.max(0, zebra!.stop) : Infinity;

    // --- where it is going, and the turn towards it.
    const t = target(p);
    const tx = t.x - p.x, ty = t.y - p.y;
    let err = 0;
    if (hypot(tx, ty) > m(0.05)) {
      const want = Math.atan2(ty, tx);
      err = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
      const rate = (p.v < m(0.3) ? TURN_STANDING : TURN_RATE) * DT;
      const turn = Math.max(-rate, Math.min(rate, err));
      p.heading += turn;
      p.turnV = turn / DT;
      err -= turn;
    } else p.turnV = 0;

    // --- the speed: the room ahead in its own stripe, the wait, and the turn still to make.
    const crossing = crossingOf(w, st.way) !== null;
    const jammed = p.held > (crossing ? JAM_AFTER_CROSSING : JAM_AFTER);
    let want = p.pace * (crossing ? 1.15 : 1) * (p.rush?.by ?? 1);
    if (jammed) want *= JAM_SHARE;
    else want = Math.min(want, Math.max(0, (free(p.d) - KEEP) / HEADWAY));
    if (stop < Infinity) want = Math.min(want, Math.sqrt(2 * BRAKE * stop));
    want *= Math.max(0, (Math.cos(err) - 0.5) / 0.5);
    p.v = want > p.v ? Math.min(want, p.v + ACCEL * DT) : Math.max(want, p.v - BRAKE * DT);
    const meansToGo = !(stop < m(0.1));
    p.held = meansToGo && p.v < m(0.1) ? p.held + DT : 0;
    p.x += Math.cos(p.heading) * p.v * DT;
    p.y += Math.sin(p.heading) * p.v * DT;
    // Held up, or slow, a person steps aside into their stripe when it is free.
    const aside = p.aim - p.d;
    if (Math.abs(aside) > m(0.02) && free(p.aim) > KEEP) {
      const ls = Math.max(-SIDESTEP, Math.min(SIDESTEP, aside / 0.25)) * Math.max(0, 1 - p.v / (0.6 * p.pace));
      // Square to the body, to the side the stripe is on: never a step back.
      const side = Math.sign(-Math.sin(p.heading) * -f.ty + Math.cos(p.heading) * f.tx) || 1;
      p.x += -Math.sin(p.heading) * side * ls * DT;
      p.y += Math.cos(p.heading) * side * ls * DT;
      if (Math.abs(ls) > m(0.05)) p.held = 0;
    }

    // --- where that left it on its route; on to the next step past the end of this one.
    let pr = project(st, p.x, p.y);
    p.s = pr.s; p.d = pr.d;
    for (;;) {
      st = p.steps[p.leg]!;
      const len = stepLength(st);
      if (p.leg === p.steps.length - 1) {
        if (len - p.s <= THERE || hypot(t.x - p.x, t.y - p.y) <= THERE && len - p.s <= AHEAD) finish(s, p);
        break;
      }
      const next = p.steps[p.leg + 1]!;
      const ahead = p.s >= len - m(0.02) || (p.s > len - AHEAD && project(next, p.x, p.y).s >= 0);
      if (!ahead) break;
      p.leg++;
      pr = project(next, p.x, p.y);
      p.s = pr.s; p.d = pr.d;
      p.aim = clamp(pr.d, room(next));
      if (!crossingOf(w, next.way)) p.granted = null;
    }
  }
  prune(s);
}

// ------------------------------------------------------------------ publish

function publish(w: SimWorld): void {
  const s = stateOf(w);
  w.crossingStates.clear();
  const views = w.pedViews;
  const byId = w.pedViewById;
  views.length = 0;
  byId.clear();
  for (const p of s.walkers) {
    if (p.inside) continue;
    const st = p.steps[p.leg]!;
    const on = onZebra(w, p);
    // The vehicles' view of the zebras: who is on each, and who waits at it.
    const report = on ?? p.waiting;
    const edge = report?.edge;
    if (report && edge) {
      let state = w.crossingStates.get(report.id);
      if (!state) { state = emptyCrossingState(edge.length); w.crossingStates.set(report.id, state); }
      const hit = edge.path.closestPoint({ x: p.x, y: p.y });
      if (on) {
        const t = edge.path.sampleAt(hit.s).t;
        state.occupants.push({
          id: p.id, s: Math.max(0, Math.min(edge.length, hit.s)),
          forward: Math.cos(p.heading) * t.x + Math.sin(p.heading) * t.y >= 0,
          v: p.v, held: p.v < m(0.3) && p.held > 2,
        });
      } else {
        if (hit.s < edge.length / 2) state.waitingFrom++; else state.waitingTo++;
        state.demand = true;
        state.longestWait = Math.max(state.longestWait, p.waited);
      }
    }
    const v = p.view;
    v.x = p.x; v.y = p.y; v.heading = p.heading;
    v.prev.x = p.prevX; v.prev.y = p.prevY; v.prev.heading = p.prevHeading;
    v.v = p.v; v.turnV = p.turnV; v.age = p.age;
    v.ground = on ? 'crossing' : 'footway';
    v.segment = (st.way?.segment ?? undefined) as SegmentId | undefined;
    v.stretch = st.way ? `${st.way.id}:${st.dir}` : '';
    v.walking = p.v > m(0.1);
    v.gesture = p.act ? { kind: p.act.kind, phase: 'hold', t: p.age - p.act.from, hold: p.act.until - p.act.from } : null;
    v.kerbWait = p.waiting ? p.waited : 0;
    v.waitingFor = p.waiting ? p.waiting.id : null;
    views.push(v);
    byId.set(p.id, v);
  }
}

/** A read-only look at the walkers, for tests and diagnosis. */
export function inspectAgentWalkers(w: SimWorld): readonly {
  id: number; x: number; y: number; v: number; s: number; d: number; len: number;
  leg: number; legs: number; held: number; waited: number; kind: string;
}[] {
  return stateOf(w).walkers.map((p) => ({
    id: p.id, x: p.x, y: p.y, v: p.v, s: p.s, d: p.d, len: stepLength(p.steps[p.leg]!),
    leg: p.leg, legs: p.steps.length, held: p.held, waited: p.waited, kind: p.steps[p.leg]!.way?.kind ?? 'off',
  }));
}

// ------------------------------------------------------------------ the player's hand

/** Somebody walking now, as the player and the police see them. */
export interface WalkerSeen {
  readonly id: number;
  readonly trip: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly v: number;
  readonly player: boolean;
  /** Knocked down, or stopped for something, and for how long yet (seconds). */
  readonly busy: number;
}

const seen = (p: Walker): WalkerSeen => ({ id: p.id, trip: p.trip, x: p.x, y: p.y, heading: p.heading, v: p.v, player: p.player,
  busy: p.act ? Math.max(0, p.act.until - p.age) : 0 });

/** The walkers within `radius` of a point, out on the street. */
export function walkersNear(w: SimWorld, x: number, y: number, radius: number): WalkerSeen[] {
  return stateOf(w).walkers.filter((p) => !p.inside && !p.done && hypot(p.x - x, p.y - y) < radius).map(seen);
}

/** One walker, by id, or null when nobody of that id is out. */
export function walkerOf(w: SimWorld, id: number): WalkerSeen | null {
  const p = stateOf(w).byId.get(id);
  return p && !p.inside && !p.done ? seen(p) : null;
}

/** Puts somebody walking under the player's hand: they stop following their route. */
export function takeWalker(w: SimWorld, id: number): boolean {
  const p = stateOf(w).byId.get(id);
  if (!p || p.done) return false;
  p.inside = false;
  p.player = true;
  p.act = null;
  p.rush = null;
  return true;
}

/** A body for the player to move, out at a point (stepping out of a door or a car). */
export function addPlayerWalker(w: SimWorld, id: number, x: number, y: number, heading: number,
  ageClass: PersonAgeClass, gender: PersonGender): void {
  const s = stateOf(w);
  const old = s.byId.get(id);
  if (old) finish(s, old, false);
  prune(s);
  const view: PedView = {
    id, x, y, heading, prev: { x, y, heading }, v: 0, turnV: 0, age: 0, ageClass, gender,
    party: { id, size: 1, archetype: 'solo', hasChild: false }, rank: 0,
    ground: 'footway', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null, gesture: null,
  };
  const p: Walker = {
    id, trip: -1, view, pace: PED.meanSpeed, steps: [{ way: null, dir: 1, from: 0, to: 0, a: { x, y }, b: { x, y } }], leg: 0,
    s: 0, d: 0, aim: 0, v: 0, x, y, heading, prevX: x, prevY: y, prevHeading: heading, turnV: 0, age: 0, held: 0,
    waited: 0, asked: 0, granted: null, done: false, waiting: null, zebra: null, inside: false, player: true, act: null, rush: null,
  };
  s.walkers.push(p);
  s.byId.set(id, p);
}

/** The player's body moved: where it is now, the way it faces, how fast it goes. */
export function movePlayerWalker(w: SimWorld, id: number, x: number, y: number, heading: number, v: number): void {
  const p = stateOf(w).byId.get(id);
  if (!p || !p.player) return;
  const turn = Math.atan2(Math.sin(heading - p.heading), Math.cos(heading - p.heading));
  p.turnV = turn / DT;
  p.x = x; p.y = y; p.heading = heading; p.v = v;
}

/** Takes somebody off the street altogether (into a car, into a building): no arrival is told. */
export function removeWalker(w: SimWorld, id: number): void {
  const s = stateOf(w);
  const p = s.byId.get(id);
  if (p) { finish(s, p, false); prune(s); }
}

/** Somebody stops a while to do something (talk, fall down), facing a point. */
export function walkerAct(w: SimWorld, id: number, kind: GestureKind, seconds: number, faceX: number, faceY: number): void {
  const p = stateOf(w).byId.get(id);
  if (!p || p.done) return;
  p.act = { kind, from: p.age, until: p.age + seconds, faceX, faceY };
  p.v = 0;
}

/** The ground of a train (its cars, the track just ahead): whoever is on it walks off it. */
const TRAIN_GROUND: Set<number> = new Set();

/** How much faster than their walk somebody runs away. */
const RUN = 2.4;

/**
 * Everybody within `radius` of a fright (a blow, a crash, a car on the
 * footway) runs off away from it for a while, then goes on where they were
 * going. Those knocked down get up first. Returns who saw it.
 */
export function startle(w: SimWorld, x: number, y: number, radius: number, seconds: number, except: number | null): number[] {
  const s = stateOf(w);
  const saw: number[] = [];
  for (const p of s.walkers) {
    if (p.inside || p.done || p.player || p.id === except) continue;
    const d = hypot(p.x - x, p.y - y);
    if (d > radius) continue;
    saw.push(p.id);
    const goal = p.rush?.goal ?? lastOf(p);
    // Away from it: to the walkway point some way off on the far side.
    const ax = d > 1e-6 ? (p.x - x) / d : Math.cos(p.heading), ay = d > 1e-6 ? (p.y - y) / d : Math.sin(p.heading);
    replan(w, s, p, { x: p.x + ax * m(40), y: p.y + ay * m(40) });
    const after = p.act?.kind === 'fall' ? p.act.until - p.age : 0;
    p.rush = { by: RUN, until: p.age + after + seconds * (0.7 + 0.6 * ((personHash(p.id) & 255) / 255)), goal };
  }
  return saw;
}

/** Somebody sent running towards a point (a police officer after the player), their own route on the walkways. */
export function sendRunning(w: SimWorld, id: number, to: Vec2, by = RUN): void {
  const s = stateOf(w);
  const p = s.byId.get(id);
  if (!p || p.done || p.player) return;
  replan(w, s, p, to);
  p.rush = { by, until: p.age + 30, goal: to };
}

/** The end of a walker's route: where they are going. */
function lastOf(p: Walker): Vec2 {
  const last = p.steps[p.steps.length - 1]!;
  const end = frame(last, stepLength(last));
  return { x: end.x, y: end.y };
}

/** A walker's route made again from where they are to `to`. */
function replan(w: SimWorld, s: State, p: Walker, to: Vec2): void {
  const steps = plan(w, s, { x: p.x, y: p.y }, to, REACH);
  if (!steps) return;
  p.steps.length = 0;
  p.steps.push(...steps);
  p.leg = 0;
  p.granted = null;
  const pr = project(steps[0]!, p.x, p.y);
  p.s = pr.s; p.d = pr.d; p.aim = clamp(pr.d, room(steps[0]!));
}

/** Gives a body back from the player's hand, walking on to `to` (their home, say); null: off the street. */
export function releaseWalker(w: SimWorld, id: number, to: Vec2 | null): void {
  const s = stateOf(w);
  const p = s.byId.get(id);
  if (!p) return;
  p.player = false;
  if (!to) { finish(s, p, false); prune(s); return; }
  replan(w, s, p, to);
}
