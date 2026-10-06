import { solidsOf } from '@world/solids';
import { pointInPolygon } from '@core/polygon';
import { Rng } from '@core/rng';
import { solidFootprints } from '@world/buildings/geometry';
import type { BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { DT } from '../params';
import { vehiclePose } from '../pose';
import type { SimWorld } from '../world';
import { createVehicle, type Vehicle } from '../vehicles/state';
import { makeDriver } from '../vehicles/driver';
import {
  addPlayerWalker, movePlayerWalker, removeWalker, sendRunning, startle, walkerAct, walkerOf, walkersNear,
} from '../agents/walk';

/**
 * The player inside the scenery, as in GTA (`src/play.ts` drives it): a person
 * walked and run where the player points, who takes cars - parked ones, or
 * one out of the traffic, its driver getting out and running off - drives
 * them with the simplest model of a car (the kinematic bicycle), goes into
 * buildings, punches, shoots, and is wanted for it.
 *
 * The people of the scenery react as GTA's do, to what they see (the
 * "shocking events"): a blow or a shot sends everybody near running, those
 * hit fall; a car driven into people knocks them down. Every crime seen puts
 * stars on; out of sight of anybody a while they go one by one. With stars on,
 * officers come in from out of sight, run after the player, and arrest them
 * on foot if they catch up. Nobody here lives in the town: the officers are
 * made for the chase, as the walkers are.
 */

/** The player's person in the walking engine: one id, out of every other range. */
export const PLAYER_ID = 1 << 29;
/** How long the camera takes a train car to be, to frame it. */
const TRAIN_CAR_VIEW = m(18);

/** What the player is pressing this tick (set by `src/play.ts`). */
export interface PlayInput {
  /** On foot: the way to go, world axes, length 0 to 1. */
  moveX: number;
  moveY: number;
  run: boolean;
  /** In a car: throttle -1 (brake, reverse) to 1, steering -1 (left) to 1 (right). */
  throttle: number;
  steer: number;
  /** Where the player aims, world axes (unit). */
  aimX: number;
  aimY: number;
  /** Held: aiming (right mouse, GTA's), the body faces where the camera looks and steps sideways. */
  aiming: boolean;
  /** Held in a car: the handbrake (Space). */
  handbrake: boolean;
  /** Pressed once; cleared when used. F: get in at the wheel (or out); G: get on as a passenger; E: talk. */
  enter: boolean;
  board: boolean;
  talk: boolean;
  attack: boolean;
}

/** What the player rides as a passenger: a bus of the traffic, or a train or a metro by its key. */
export type Ride = { readonly kind: 'bus'; readonly id: number } | { readonly kind: 'train'; readonly key: string };

export type Weapon = 'fists' | 'pistol';

const WALK = m(1.6), RUN = m(5);
const TURN = 10;
const BODY = m(0.3);
/** The gap kept to walls and cars (Rapier's offset): never touching, never flickering inside. */
const SKIN = m(0.03);
/** Longest a knocked-down player stays down: the ragdoll's fall, lie and rise end it sooner (`walk.ts` getUp). */
const DOWN = 12;
const PUNCH_REACH = m(1.5), DOOR_REACH = m(4.5), BUILDING_REACH = m(2.2);
const TOP = m(26), TOP_BACK = m(7), ACCEL = m(5.5), BRAKE = m(11), DRAG = 0.22, LOCK = 0.62;
/** A pistol: how far it reaches, how close to the line a body is hit, seconds between shots. */
const RANGE = m(70), HIT = m(0.45), COOLDOWN = 0.28;
/** How far people see a crime, and how far a shot is heard. */
const SEEN = m(30), HEARD = m(45);
/** Seconds out of sight before a star goes, and an officer's reach to arrest. */
const STAR_COOL = 12, ARREST = m(1.4);
/** Cars left by the player kept about, at most. */
const KEPT_CARS = 4;

export class PlayWorld {
  readonly input: PlayInput = { moveX: 0, moveY: 0, run: false, throttle: 0, steer: 0, aimX: 1, aimY: 0, aiming: false, handbrake: false, enter: false, board: false, talk: false, attack: false };
  active = false;
  mode: 'foot' | 'car' | 'inside' | 'ride' = 'foot';
  /** What the player rides, as a passenger. */
  ride: Ride | null = null;
  weapon: Weapon = 'fists';
  x = 0; y = 0; heading = 0; v = 0;
  health = 100;
  wanted = 0;
  /** The building the player went into. */
  inside: BuildingId | null = null;
  /** The car driven. */
  car: Vehicle | null = null;
  /** The cars the player drove and left, drawn where they stand (`AmbientWorld.extra`). */
  readonly cars: Vehicle[] = [];
  /** The last thing that happened (`play.msg.<key>`) and when (sim seconds). */
  message: { key: string; at: number } | null = null;
  /** Shots fired since the renderer last looked: muzzle and where each struck (world). */
  readonly shots: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];

  private down = 0;
  private wasted = 0;
  private cooldown = 0;
  private quiet = 0;
  private sinceStar = 0;
  private readonly officers = new Set<number>();
  /** People the player's car has already struck: one crime each, not one a tick while the body touches them. */
  private readonly struck = new Set<number>();
  private retarget = 0;
  private readonly rng = new Rng(0x9a7e5);
  private walls: { ring: readonly { x: number; y: number }[]; id: BuildingId; x0: number; y0: number; x1: number; y1: number }[] = [];
  private wallsFor = -1;

  /** Into the scenery at a point, facing `heading`. */
  start(w: SimWorld, x: number, y: number, heading: number): void {
    this.active = true;
    this.mode = 'foot';
    this.x = x; this.y = y; this.heading = heading; this.v = 0;
    this.health = 100;
    this.wanted = 0;
    this.down = 0;
    this.wasted = 0;
    addPlayerWalker(w, PLAYER_ID, x, y, heading, 'adult', 'm');
    this.say(w, 'start');
  }

  /** Out of the scenery: the body goes, the officers stop. */
  stop(w: SimWorld): void {
    if (!this.active) return;
    if (this.mode === 'car') this.getOut(w);
    removeWalker(w, PLAYER_ID);
    this.callOff(w);
    this.active = false;
    this.inside = null;
  }

  private say(w: SimWorld, key: string): void { this.message = { key, at: w.clock.time }; }

  step(w: SimWorld): void {
    if (!this.active) return;
    const input = this.input;
    this.cooldown = Math.max(0, this.cooldown - DT);
    if (this.wasted > 0) {
      this.wasted -= DT;
      if (this.wasted <= 0) {
        this.health = 100;
        this.wanted = 0;
        this.callOff(w);
        this.down = 0;
        this.say(w, 'back');
      }
      input.enter = input.board = input.talk = input.attack = false;
      return;
    }
    if (this.mode === 'foot') this.onFoot(w);
    else if (this.mode === 'car') this.driving(w);
    else if (this.mode === 'ride') this.riding(w);
    else if (input.enter || input.board) this.goOut(w);
    input.enter = input.board = input.talk = input.attack = false;
    this.police(w);
  }

  // ------------------------------------------------------------- on foot

  private onFoot(w: SimWorld): void {
    const input = this.input;
    if (!walkerOf(w, PLAYER_ID)) addPlayerWalker(w, PLAYER_ID, this.x, this.y, this.heading, 'adult', 'm');
    if (this.down > 0) {
      // Down until the body has got up (the ragdoll tells the walk when, `getUp`), and up where it lies.
      this.down -= DT;
      this.v = 0;
      const me = walkerOf(w, PLAYER_ID);
      if (me && me.busy > 0 && this.down > 0) return;
      this.down = 0;
      if (me) { this.x = me.x; this.y = me.y; this.heading = me.heading; }
    }
    const len = Math.hypot(input.moveX, input.moveY);
    // Aiming, a walk at most, sideways or back as well (GTA's strafe); else a run if asked.
    const want = Math.min(1, len) * (input.aiming ? WALK : input.run ? RUN : WALK);
    this.v += Math.max(-m(10) * DT, Math.min(m(8) * DT, want - this.v));
    let goX = Math.cos(this.heading), goY = Math.sin(this.heading);
    if (input.aiming) {
      const to = Math.atan2(input.aimY, input.aimX);
      const err = Math.atan2(Math.sin(to - this.heading), Math.cos(to - this.heading));
      this.heading += Math.max(-TURN * 2 * DT, Math.min(TURN * 2 * DT, err));
      if (len > 0.05) { goX = input.moveX / len; goY = input.moveY / len; }
    } else if (len > 0.05) {
      const to = Math.atan2(input.moveY, input.moveX);
      const err = Math.atan2(Math.sin(to - this.heading), Math.cos(to - this.heading));
      this.heading += Math.max(-TURN * DT, Math.min(TURN * DT, err));
      goX = Math.cos(this.heading); goY = Math.sin(this.heading);
    }
    const fromX = this.x, fromY = this.y;
    this.x += goX * this.v * DT;
    this.y += goY * this.v * DT;
    // Run over by the traffic (before the body is pushed out of the car that hit it).
    for (const veh of w.vehicles.values()) {
      if (veh.v < m(2)) continue;
      const pose = vehiclePose(w, veh, 1);
      if (pose && insideBody(this.x, this.y, pose.p.x, pose.p.y, pose.angle, veh.archetype.length, veh.archetype.width, BODY)) {
        this.hurt(w, 20 + veh.v / m(1) * 4, 'runOver');
        break;
      }
    }
    this.pushOut(w);
    // Against a wall the body slows to what it really moved, as a body sliding along it does.
    if (this.v > 0) this.v = Math.min(this.v, Math.hypot(this.x - fromX, this.y - fromY) / DT + m(0.4));
    movePlayerWalker(w, PLAYER_ID, this.x, this.y, this.heading, this.v);
    if (input.attack) {
      if (this.weapon === 'pistol') this.shoot(w);
      else this.punch(w);
    }
    if (input.enter) this.enterNearest(w);
    if (input.board) this.boardNearest(w);
    if (input.talk) this.talkTo(w);
  }

  /** Where the player is seen from: their body, the car they drive, or what they ride. */
  viewPoint(w: SimWorld): { x: number; y: number; heading: number; vehicle: boolean; length: number } {
    if (this.mode === 'car' && this.car?.free) {
      return { x: this.car.free.x, y: this.car.free.y, heading: this.car.free.angle, vehicle: true, length: this.car.archetype.length };
    }
    if (this.mode === 'ride' && this.ride) {
      const at = this.rideAt(w);
      if (at) return { ...at, vehicle: true };
    }
    return { x: this.x, y: this.y, heading: this.heading, vehicle: false, length: 0 };
  }

  /** The vehicles near (x, y) as boxes, but the one the player is in or rides: what the camera's arm keeps out of. */
  vehicleBoxes(w: SimWorld, x: number, y: number, r: number): VehicleBox[] {
    const out: VehicleBox[] = [];
    const own = this.mode === 'car' ? this.car : null;
    const ridden = this.ride?.kind === 'bus' ? this.ride.id : null;
    const add = (v: Vehicle, cx: number, cy: number, angle: number): void => {
      if (Math.abs(cx - x) > r || Math.abs(cy - y) > r) return;
      out.push({ x: cx, y: cy, angle, length: v.archetype.length, width: v.archetype.width, height: v.archetype.height });
    };
    for (const v of w.vehicles.values()) {
      if (v.id === ridden) continue;
      const pose = vehiclePose(w, v, 1);
      if (pose) add(v, pose.p.x, pose.p.y, pose.angle);
    }
    for (const v of [...w.ambient.parked, ...this.cars]) if (v !== own && v.free) add(v, v.free.x, v.free.y, v.free.angle);
    return out;
  }

  // ------------------------------------------------------------- talking and riding

  /** A word with the person in front: both stop and face each other a moment. */
  private talkTo(w: SimWorld): void {
    let best: { id: number; x: number; y: number } | null = null, bestD = m(2.2);
    for (const p of walkersNear(w, this.x, this.y, bestD)) {
      if (p.id === PLAYER_ID) continue;
      const d = Math.hypot(p.x - this.x, p.y - this.y);
      if (d < bestD) { best = p; bestD = d; }
    }
    if (!best) { this.say(w, 'nobodyToTalk'); return; }
    walkerAct(w, best.id, 'talk', 6, this.x, this.y);
    walkerAct(w, PLAYER_ID, 'talk', 6, best.x, best.y);
    this.heading = Math.atan2(best.y - this.y, best.x - this.x);
    this.down = 0;
    this.say(w, 'talked');
  }

  /** Where the ride is now (its middle, its heading), or null when it has gone. */
  private rideAt(w: SimWorld): { x: number; y: number; heading: number; v: number; length: number } | null {
    const ride = this.ride;
    if (!ride) return null;
    if (ride.kind === 'bus') {
      const v = w.vehicles.get(ride.id);
      const pose = v ? vehiclePose(w, v, 1) : null;
      return v && pose ? { x: pose.p.x, y: pose.p.y, heading: pose.angle, v: v.v, length: v.archetype.length } : null;
    }
    const train = w.city.transit.trains().find((t) => t.key === ride.key);
    const car = train?.cars[Math.floor((train.cars.length - 1) / 2)];
    return train && car ? { x: car.x, y: car.y, heading: car.heading, v: train.v, length: TRAIN_CAR_VIEW } : null;
  }

  /** On as a passenger: a bus standing at its stop, or a train standing at its station, near. */
  private boardNearest(w: SimWorld): void {
    let best: { ride: Ride; d: number } | null = null;
    for (const v of w.vehicles.values()) {
      if (v.archetype.id !== 'bus' || v.v > m(0.6)) continue;
      const pose = vehiclePose(w, v, 1);
      if (!pose) continue;
      const d = Math.hypot(pose.p.x - this.x, pose.p.y - this.y);
      if (d < m(7) && (!best || d < best.d)) best = { ride: { kind: 'bus', id: v.id }, d };
    }
    for (const t of w.city.transit.trains()) {
      if (t.v > m(0.6)) continue;
      for (const c of t.cars) {
        const d = Math.hypot(c.x - this.x, c.y - this.y);
        if (d < m(9) && (!best || d < best.d)) best = { ride: { kind: 'train', key: t.key }, d };
      }
    }
    if (!best) { this.say(w, 'noRide'); return; }
    this.ride = best.ride;
    this.mode = 'ride';
    this.v = 0;
    removeWalker(w, PLAYER_ID);
    this.say(w, best.ride.kind === 'bus' ? 'onBus' : 'onTrain');
  }

  private riding(w: SimWorld): void {
    const at = this.rideAt(w);
    // The ride gone (off the map, its line deleted): off where it was.
    if (!at) { this.getOff(w, null); return; }
    this.x = at.x; this.y = at.y; this.heading = at.heading;
    if ((this.input.enter || this.input.board) && at.v < m(0.8)) this.getOff(w, at);
    else if (this.input.enter || this.input.board) this.say(w, 'waitStop');
  }

  private getOff(w: SimWorld, at: { x: number; y: number; heading: number } | null): void {
    // A bus, driving on the right, opens onto the kerb on its right; a train
    // onto its platform, on the left of its way (`transit.ts` PLATFORM).
    const train = this.ride?.kind === 'train';
    const side = (at?.heading ?? this.heading) + (train ? Math.PI / 2 : -Math.PI / 2);
    const out = train ? m(3.2) : m(2.2);
    this.x += Math.cos(side) * out;
    this.y += Math.sin(side) * out;
    this.mode = 'foot';
    this.ride = null;
    addPlayerWalker(w, PLAYER_ID, this.x, this.y, this.heading, 'adult', 'm');
    this.say(w, 'offRide');
  }

  private hurt(w: SimWorld, amount: number, key: string): void {
    this.health = Math.max(0, this.health - amount);
    this.down = DOWN;
    walkerAct(w, PLAYER_ID, 'fall', DOWN, this.x, this.y);
    this.say(w, key);
    if (this.health <= 0) {
      this.wasted = 4;
      this.say(w, 'wasted');
    }
  }

  private punch(w: SimWorld): void {
    let best: { id: number; x: number; y: number } | null = null, bestD = PUNCH_REACH;
    for (const p of walkersNear(w, this.x, this.y, PUNCH_REACH)) {
      if (p.id === PLAYER_ID) continue;
      const ahead = (p.x - this.x) * Math.cos(this.heading) + (p.y - this.y) * Math.sin(this.heading);
      const d = Math.hypot(p.x - this.x, p.y - this.y);
      if (ahead < -m(0.2) || d >= bestD) continue;
      best = p; bestD = d;
    }
    walkerAct(w, PLAYER_ID, 'argue', 0.4, this.x + Math.cos(this.heading), this.y + Math.sin(this.heading));
    if (!best) { this.say(w, 'swing'); return; }
    // Knocked down, everybody near runs off.
    walkerAct(w, best.id, 'fall', 4 + this.rng.float() * 3, this.x, this.y);
    startle(w, best.x, best.y, m(14), 10, PLAYER_ID);
    this.say(w, 'punch');
    this.crime(w, best.x, best.y, 1);
  }

  /** A shot along the aim: the first person on the line, unless a wall is first. */
  private shoot(w: SimWorld): void {
    if (this.cooldown > 0) return;
    this.cooldown = COOLDOWN;
    let ax = this.input.aimX, ay = this.input.aimY;
    const len = Math.hypot(ax, ay) || 1;
    ax /= len; ay /= len;
    this.heading = Math.atan2(ay, ax);
    movePlayerWalker(w, PLAYER_ID, this.x, this.y, this.heading, this.v);
    const fromX = this.x + ax * m(0.5), fromY = this.y + ay * m(0.5);
    // How far until a wall (sampled every half metre).
    let reach = RANGE;
    for (let t = m(0.5); t < RANGE; t += m(0.5)) {
      if (this.wallAt(w, fromX + ax * t, fromY + ay * t, 0)) { reach = t; break; }
    }
    let hit: { id: number; t: number } | null = null;
    for (const p of walkersNear(w, fromX + ax * reach / 2, fromY + ay * reach / 2, reach / 2 + HIT)) {
      if (p.id === PLAYER_ID) continue;
      const rx = p.x - fromX, ry = p.y - fromY;
      const t = rx * ax + ry * ay;
      if (t < 0 || t > reach) continue;
      if (Math.abs(-rx * ay + ry * ax) > HIT) continue;
      if (!hit || t < hit.t) hit = { id: p.id, t };
    }
    const end = hit ? hit.t : reach;
    this.shots.push({ from: { x: fromX, y: fromY }, to: { x: fromX + ax * end, y: fromY + ay * end } });
    // Heard all round: everybody runs.
    startle(w, this.x, this.y, HEARD, 14, PLAYER_ID);
    if (hit) {
      const at = walkerOf(w, hit.id);
      // Struck: down for good (the engine's blow, the body to the ragdolls).
      if (at) w.pedEngine.impact?.(w, at.x, at.y, m(0.35), HEARD);
      this.say(w, 'shot');
      this.crime(w, fromX + ax * end, fromY + ay * end, 2);
    } else {
      this.say(w, 'fired');
      this.crime(w, this.x, this.y, 1);
    }
  }

  // ------------------------------------------------------------- cars and doors

  private enterNearest(w: SimWorld): void {
    // The nearest car first: parked, left by the player, or in the traffic.
    let best: { car: Vehicle; traffic: boolean; d: number } | null = null;
    const consider = (car: Vehicle, traffic: boolean, x: number, y: number): void => {
      const d = Math.hypot(x - this.x, y - this.y);
      if (d < DOOR_REACH && (!best || d < best.d)) best = { car, traffic, d };
    };
    for (const car of [...w.ambient.parked, ...this.cars]) if (car.free) consider(car, false, car.free.x, car.free.y);
    for (const veh of w.vehicles.values()) {
      if (veh.archetype.id === 'bicycle') continue;
      const pose = vehiclePose(w, veh, 1);
      if (pose) consider(veh, true, pose.p.x, pose.p.y);
    }
    const found = best as { car: Vehicle; traffic: boolean; d: number } | null;
    if (found) { this.getIn(w, found.car, found.traffic); return; }
    // Else the building beside the player.
    const b = this.buildingNear(w);
    if (b !== null) {
      this.mode = 'inside';
      this.inside = b;
      this.v = 0;
      removeWalker(w, PLAYER_ID);
      this.say(w, 'inside');
      return;
    }
    this.say(w, 'nothing');
  }

  private getIn(w: SimWorld, car: Vehicle, traffic: boolean): void {
    let body = car;
    if (traffic) {
      // Out of the traffic: the driver gets out on their side and runs.
      const pose = vehiclePose(w, car, 1)!;
      w.removeVehicle(car);
      body = createVehicle(w.nextVehicleId++, car.archetype, makeDriver(car.archetype, () => this.rng.float()), car.color,
        car.lanelet, 0, w.clock.tick);
      body.free = { x: pose.p.x, y: pose.p.y, angle: pose.angle, px: pose.p.x, py: pose.p.y, pangle: pose.angle, lot: null };
      const side = pose.angle + Math.PI / 2;
      const sx = pose.p.x + Math.cos(side) * (car.archetype.width / 2 + m(0.8)), sy = pose.p.y + Math.sin(side) * (car.archetype.width / 2 + m(0.8));
      const engine = w.pedEngine;
      // Round behind the car to the kerb (on the right), never ahead of the car the player drives off in.
      const flee = pose.angle - Math.PI * 3 / 4;
      const away = { x: sx + Math.cos(flee) * m(40), y: sy + Math.sin(flee) * m(40) };
      const id = engine.walkTrip?.call(engine, w, { trip: -1, fromX: sx, fromY: sy, toX: away.x, toY: away.y, seed: car.id, ageClass: 'adult', reach: m(30) });
      if (id !== null && id !== undefined) sendRunning(w, id, away);
      startle(w, pose.p.x, pose.p.y, m(12), 8, PLAYER_ID);
      this.crime(w, pose.p.x, pose.p.y, 1);
      this.say(w, 'carjack');
    } else {
      w.ambient.takeParked(car);
      const i = this.cars.indexOf(car);
      if (i >= 0) this.cars.splice(i, 1);
      this.say(w, 'inCar');
    }
    body.seats = 1;
    body.v = 0;
    this.car = body;
    this.cars.push(body);
    this.mode = 'car';
    this.v = 0;
    removeWalker(w, PLAYER_ID);
  }

  private getOut(w: SimWorld): void {
    const car = this.car;
    if (!car?.free) { this.mode = 'foot'; return; }
    car.v = 0;
    car.seats = 0;
    const side = car.free.angle + Math.PI / 2;
    const across = car.archetype.width / 2 + m(0.6);
    this.x = car.free.x + Math.cos(side) * across;
    this.y = car.free.y + Math.sin(side) * across;
    this.heading = car.free.angle;
    this.mode = 'foot';
    this.v = 0;
    this.car = null;
    // The cars the player left stay where they are; the oldest go.
    while (this.cars.length > KEPT_CARS) this.cars.shift();
    addPlayerWalker(w, PLAYER_ID, this.x, this.y, this.heading, 'adult', 'm');
    this.say(w, 'outOfCar');
  }

  private goOut(w: SimWorld): void {
    this.mode = 'foot';
    this.inside = null;
    addPlayerWalker(w, PLAYER_ID, this.x, this.y, this.heading + Math.PI, 'adult', 'm');
    this.heading += Math.PI;
    this.say(w, 'outside');
  }

  private driving(w: SimWorld): void {
    const car = this.car;
    const input = this.input;
    if (!car?.free) { this.mode = 'foot'; return; }
    if (input.enter) { this.getOut(w); return; }
    const f = car.free;
    f.px = f.x; f.py = f.y; f.pangle = f.angle;
    const t = input.throttle;
    if (t > 0) this.v += (this.v < 0 ? BRAKE : ACCEL) * t * DT;
    else if (t < 0) this.v += (this.v > 0 ? -BRAKE : -ACCEL * 0.6) * -t * DT;
    this.v -= this.v * DRAG * DT;
    // The handbrake: the wheels locked, the car stops short and turns tighter.
    if (input.handbrake) this.v -= Math.sign(this.v) * Math.min(Math.abs(this.v), BRAKE * 1.3 * DT);
    if (Math.abs(this.v) < m(0.05) && t === 0) this.v = 0;
    this.v = Math.max(-TOP_BACK, Math.min(TOP, this.v));
    // The kinematic bicycle: the heading turns by v / L * tan(steer).
    const wheelbase = car.archetype.length * 0.6;
    const steer = -input.steer * LOCK * (input.handbrake ? 1.4 : 1) * (1 - 0.5 * Math.min(1, Math.abs(this.v) / TOP));
    const heading = f.angle + (this.v / wheelbase) * Math.tan(steer) * DT;
    const nx = f.x + Math.cos(heading) * this.v * DT, ny = f.y + Math.sin(heading) * this.v * DT;
    const half = car.archetype.length / 2, wide = car.archetype.width / 2;
    const dir = Math.sign(this.v || 1);
    const nose = { x: nx + Math.cos(heading) * half * dir, y: ny + Math.sin(heading) * half * dir };
    if (this.wallAt(w, nose.x, nose.y, wide * 0.8) || this.wallAt(w, nx, ny, wide * 0.8)) {
      if (Math.abs(this.v) > m(4)) { this.say(w, 'crash'); this.health = Math.max(5, this.health - Math.abs(this.v) / m(1) * 0.8); }
      this.v = -this.v * 0.2;
      car.v = Math.abs(this.v);
      return;
    }
    for (const veh of [...w.vehicles.values(), ...w.ambient.parked]) {
      const pose = veh.free ? { p: { x: veh.free.x, y: veh.free.y }, angle: veh.free.angle } : vehiclePose(w, veh, 1);
      if (!pose || veh === car) continue;
      if (Math.hypot(pose.p.x - nx, pose.p.y - ny) > (half + veh.archetype.length / 2) * 1.05) continue;
      if (insideBody(nose.x, nose.y, pose.p.x, pose.p.y, pose.angle, veh.archetype.length, veh.archetype.width, m(0.25))) {
        if (Math.abs(this.v) > m(3)) { this.say(w, 'crash'); this.crime(w, pose.p.x, pose.p.y, 1); }
        if (!veh.free) veh.v = 0;
        this.v = -this.v * 0.3;
        car.v = Math.abs(this.v);
        return;
      }
    }
    f.x = nx; f.y = ny; f.angle = heading;
    car.v = Math.abs(this.v);
    car.s += Math.abs(this.v) * DT;
    this.x = nx; this.y = ny; this.heading = heading;
    // People in the way: knocked down (killed, fast enough); everybody runs.
    if (Math.abs(this.v) > m(1)) {
      for (const p of walkersNear(w, nx, ny, half + m(1.5))) {
        if (p.id === PLAYER_ID || p.busy > 0 || this.struck.has(p.id)) continue;
        if (!insideBody(p.x, p.y, nx, ny, heading, car.archetype.length, car.archetype.width, m(0.25))) continue;
        this.struck.add(p.id);
        if (Math.abs(this.v) > m(9)) w.pedEngine.impact?.(w, p.x, p.y, m(0.3), m(20));
        else { walkerAct(w, p.id, 'fall', 6, nx, ny); startle(w, p.x, p.y, m(12), 8, PLAYER_ID); }
        this.say(w, 'hitPerson');
        this.crime(w, p.x, p.y, 2);
      }
    } else if (Math.abs(this.v) > m(6)) {
      // A car going fast near people: they shout and get out of the way.
      startle(w, nx, ny, m(5), 4, PLAYER_ID);
    }
  }

  // ------------------------------------------------------------- the police

  /** A crime at (x, y): stars if anybody near sees it. */
  private crime(w: SimWorld, x: number, y: number, stars: number): void {
    const seen = walkersNear(w, x, y, SEEN).some((p) => p.id !== PLAYER_ID && !this.officers.has(p.id));
    if (!seen) return;
    this.wanted = Math.min(5, this.wanted + stars);
    this.quiet = 0;
    this.sinceStar = 0;
  }

  private police(w: SimWorld): void {
    for (const id of [...this.officers]) if (!walkerOf(w, id)) this.officers.delete(id);
    // Struck once more only after the car has left them behind.
    for (const id of [...this.struck]) {
      const q = walkerOf(w, id);
      if (!q || Math.hypot(q.x - this.x, q.y - this.y) > m(20)) this.struck.delete(id);
    }
    if (this.wanted === 0) { if (this.officers.size) this.callOff(w); return; }
    // Out of sight of everybody, the stars go one by one.
    const seen = walkersNear(w, this.x, this.y, SEEN).some((p) => p.id !== PLAYER_ID);
    this.quiet = seen ? 0 : this.quiet + DT;
    this.sinceStar += DT;
    if (this.quiet > STAR_COOL && this.sinceStar > STAR_COOL) {
      this.wanted--;
      this.sinceStar = 0;
      if (this.wanted === 0) { this.say(w, 'lostThem'); this.callOff(w); return; }
    }
    // Officers come in from out of sight: two a star, six at most.
    this.retarget -= DT;
    const want = Math.min(6, this.wanted * 2);
    const focus = w.focus;
    if (this.officers.size < want && focus && this.rng.float() < 0.05) {
      const a = this.rng.float() * Math.PI * 2, d = focus.r * 1.15;
      const engine = w.pedEngine;
      const from = engine.walkableNear?.call(engine, w, this.x + Math.cos(a) * d, this.y + Math.sin(a) * d, m(30));
      if (from) {
        const id = engine.walkTrip?.call(engine, w, { trip: -1, fromX: from.x, fromY: from.y, toX: this.x, toY: this.y, seed: 0x9011ce, ageClass: 'adult', reach: m(30) });
        if (id !== null && id !== undefined) { this.officers.add(id); sendRunning(w, id, { x: this.x, y: this.y }); }
      }
    }
    if (this.retarget <= 0) {
      this.retarget = 1;
      for (const id of this.officers) sendRunning(w, id, { x: this.x, y: this.y });
    }
    // Caught on foot.
    if (this.mode === 'foot') {
      for (const id of this.officers) {
        const o = walkerOf(w, id);
        if (o && Math.hypot(o.x - this.x, o.y - this.y) < ARREST) {
          this.say(w, 'busted');
          this.wanted = 0;
          this.hurt(w, 0, 'busted');
          this.callOff(w);
          return;
        }
      }
    }
  }

  private callOff(w: SimWorld): void {
    for (const id of this.officers) removeWalker(w, id);
    this.officers.clear();
  }

  // ------------------------------------------------------------- walls and doors

  private wallsOf(w: SimWorld): typeof this.walls {
    if (w.doc.buildings.revision !== this.wallsFor) {
      this.wallsFor = w.doc.buildings.revision;
      this.walls = [];
      for (const b of w.doc.buildings.all()) {
        for (const ring of solidFootprints(b)) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
          this.walls.push({ ring, id: b.id, x0, y0, x1, y1 });
        }
      }
    }
    return this.walls;
  }

  /**
   * Move and slide (Rapier's character controller, Unreal's SlideAlongSurface):
   * after the step, the body (a disc of BODY) is pushed out of every wall,
   * car and person it entered, along the way out nearest; what is left of
   * the step runs along the surface. Steps are shorter than the body, so
   * nothing is passed through between two ticks.
   */
  private pushOut(w: SimWorld): void {
    const r = BODY + SKIN;
    const boxes = this.vehicleBoxes(w, this.x, this.y, m(10));
    const people = walkersNear(w, this.x, this.y, m(2));
    for (let it = 0; it < 4; it++) {
      let moved = false;
      // Everything solid on the map (`world/solids.ts`): buildings and the walls,
      // fences and furniture of their lots, the walls drawn, poles, trees,
      // benches - pushed out of along the way out nearest.
      for (const sd of solidsOf(w.doc).near(this.x, this.y, r)) {
        if (sd.kind === 'ring') {
          const ring = sd.ring;
          const inside = pointInPolygon({ x: this.x, y: this.y }, ring);
          let best = Infinity, bx = 0, by = 0;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[j]!, b = ring[i]!;
            const ex = b.x - a.x, ey = b.y - a.y;
            const u = Math.max(0, Math.min(1, ((this.x - a.x) * ex + (this.y - a.y) * ey) / Math.max(1e-9, ex * ex + ey * ey)));
            const qx = a.x + ex * u, qy = a.y + ey * u;
            const d = Math.hypot(this.x - qx, this.y - qy);
            if (d < best) { best = d; bx = qx; by = qy; }
          }
          if (!inside && best >= r) continue;
          // Out through the nearest edge, to the body's width from it.
          const nx = inside ? bx - this.x : this.x - bx, ny = inside ? by - this.y : this.y - by;
          const n = Math.hypot(nx, ny) || 1;
          const out = inside ? best + r : r - best;
          this.x += (nx / n) * out;
          this.y += (ny / n) * out;
          moved = true;
          continue;
        }
        // A disc or a capsule: away from its centre, or from the nearest point of its line.
        let cx: number, cy: number;
        if (sd.kind === 'disc') { cx = sd.c.x; cy = sd.c.y; }
        else {
          const ex = sd.b.x - sd.a.x, ey = sd.b.y - sd.a.y;
          const u = Math.max(0, Math.min(1, ((this.x - sd.a.x) * ex + (this.y - sd.a.y) * ey) / Math.max(1e-9, ex * ex + ey * ey)));
          cx = sd.a.x + ex * u; cy = sd.a.y + ey * u;
        }
        const d = Math.hypot(this.x - cx, this.y - cy), min = sd.r + r;
        if (d >= min) continue;
        const nx = d > 1e-6 ? (this.x - cx) / d : 1, ny = d > 1e-6 ? (this.y - cy) / d : 0;
        this.x = cx + nx * min;
        this.y = cy + ny * min;
        moved = true;
      }
      for (const b of boxes) {
        const c = Math.cos(b.angle), s = Math.sin(b.angle);
        const lx = (this.x - b.x) * c + (this.y - b.y) * s, ly = -(this.x - b.x) * s + (this.y - b.y) * c;
        const hx = b.length / 2, hy = b.width / 2;
        const qx = Math.max(-hx, Math.min(hx, lx)), qy = Math.max(-hy, Math.min(hy, ly));
        let ox: number, oy: number;
        if (qx === lx && qy === ly) {
          // Inside the car: out by the nearest side.
          const toX = hx - Math.abs(lx), toY = hy - Math.abs(ly);
          if (toX < toY) { ox = Math.sign(lx || 1) * (toX + r); oy = 0; } else { ox = 0; oy = Math.sign(ly || 1) * (toY + r); }
        } else {
          const d = Math.hypot(lx - qx, ly - qy);
          if (d >= r) continue;
          ox = ((lx - qx) / d) * (r - d); oy = ((ly - qy) / d) * (r - d);
        }
        this.x += ox * c - oy * s;
        this.y += ox * s + oy * c;
        moved = true;
      }
      for (const q of people) {
        if (q.id === PLAYER_ID) continue;
        const d = Math.hypot(this.x - q.x, this.y - q.y), min = BODY * 2;
        if (d >= min || d < 1e-6) continue;
        this.x += ((this.x - q.x) / d) * (min - d);
        this.y += ((this.y - q.y) / d) * (min - d);
        moved = true;
      }
      if (!moved) break;
    }
  }

  private wallAt(w: SimWorld, x: number, y: number, r: number): boolean {
    for (const wl of this.wallsOf(w)) {
      if (x < wl.x0 - r || x > wl.x1 + r || y < wl.y0 - r || y > wl.y1 + r) continue;
      if (pointInPolygon({ x, y }, wl.ring)) return true;
      if (r > 0) {
        for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) if (pointInPolygon({ x: x + dx, y: y + dy }, wl.ring)) return true;
      }
    }
    return false;
  }

  /** The building whose walls are within reach of the player, nearest first. */
  private buildingNear(w: SimWorld): BuildingId | null {
    let best: BuildingId | null = null, bestD = BUILDING_REACH;
    for (const wl of this.wallsOf(w)) {
      if (this.x < wl.x0 - bestD || this.x > wl.x1 + bestD || this.y < wl.y0 - bestD || this.y > wl.y1 + bestD) continue;
      for (let i = 0, j = wl.ring.length - 1; i < wl.ring.length; j = i++) {
        const a = wl.ring[j]!, b = wl.ring[i]!;
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((this.x - a.x) * dx + (this.y - a.y) * dy) / l2));
        const d = Math.hypot(a.x + dx * t - this.x, a.y + dy * t - this.y);
        if (d < bestD) { bestD = d; best = wl.id; }
      }
    }
    return best;
  }
}

/** Whether a point is within a body's outline (a rectangle along its heading), grown by `pad`. */
/** A vehicle seen as a box on the ground: its middle, heading and size. */
export interface VehicleBox { readonly x: number; readonly y: number; readonly angle: number; readonly length: number; readonly width: number; readonly height: number }

export function insideBody(px: number, py: number, cx: number, cy: number, angle: number, length: number, width: number, pad: number): boolean {
  const rx = px - cx, ry = py - cy;
  const a = rx * Math.cos(angle) + ry * Math.sin(angle), b = -rx * Math.sin(angle) + ry * Math.cos(angle);
  return Math.abs(a) < length / 2 + pad && Math.abs(b) < width / 2 + pad;
}
