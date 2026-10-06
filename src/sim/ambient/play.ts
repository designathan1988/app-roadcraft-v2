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
  /** Pressed once; cleared when used. */
  enter: boolean;
  attack: boolean;
}

export type Weapon = 'fists' | 'pistol';

const WALK = m(1.6), RUN = m(5);
const TURN = 10;
const BODY = m(0.3);
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
  readonly input: PlayInput = { moveX: 0, moveY: 0, run: false, throttle: 0, steer: 0, aimX: 1, aimY: 0, enter: false, attack: false };
  active = false;
  mode: 'foot' | 'car' | 'inside' = 'foot';
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
      input.enter = input.attack = false;
      return;
    }
    if (this.mode === 'foot') this.onFoot(w);
    else if (this.mode === 'car') this.driving(w);
    else if (input.enter) this.goOut(w);
    input.enter = input.attack = false;
    this.police(w);
  }

  // ------------------------------------------------------------- on foot

  private onFoot(w: SimWorld): void {
    const input = this.input;
    if (!walkerOf(w, PLAYER_ID)) addPlayerWalker(w, PLAYER_ID, this.x, this.y, this.heading, 'adult', 'm');
    if (this.down > 0) {
      this.down -= DT;
      this.v = 0;
      movePlayerWalker(w, PLAYER_ID, this.x, this.y, this.heading, 0);
      return;
    }
    const len = Math.hypot(input.moveX, input.moveY);
    const want = Math.min(1, len) * (input.run ? RUN : WALK);
    this.v += Math.max(-m(10) * DT, Math.min(m(8) * DT, want - this.v));
    if (len > 0.05) {
      const to = Math.atan2(input.moveY, input.moveX);
      const err = Math.atan2(Math.sin(to - this.heading), Math.cos(to - this.heading));
      this.heading += Math.max(-TURN * DT, Math.min(TURN * DT, err));
    }
    const nx = this.x + Math.cos(this.heading) * this.v * DT, ny = this.y + Math.sin(this.heading) * this.v * DT;
    if (!this.wallAt(w, nx, ny, BODY)) { this.x = nx; this.y = ny; }
    else if (!this.wallAt(w, nx, this.y, BODY)) this.x = nx;
    else if (!this.wallAt(w, this.x, ny, BODY)) this.y = ny;
    else this.v = 0;
    movePlayerWalker(w, PLAYER_ID, this.x, this.y, this.heading, this.v);
    // Run over by the traffic.
    for (const veh of w.vehicles.values()) {
      if (veh.v < m(2)) continue;
      const pose = vehiclePose(w, veh, 1);
      if (pose && insideBody(this.x, this.y, pose.p.x, pose.p.y, pose.angle, veh.archetype.length, veh.archetype.width, BODY)) {
        this.hurt(w, 20 + veh.v / m(1) * 4, 'runOver');
        break;
      }
    }
    if (input.attack) {
      if (this.weapon === 'pistol') this.shoot(w);
      else this.punch(w);
    }
    if (input.enter) this.enterNearest(w);
  }

  private hurt(w: SimWorld, amount: number, key: string): void {
    this.health = Math.max(0, this.health - amount);
    this.down = 2.5;
    walkerAct(w, PLAYER_ID, 'fall', 2.5, this.x, this.y);
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
      if (veh.archetype.id === 'bus' || veh.archetype.id === 'bicycle') continue;
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
      const away = { x: sx + Math.cos(side) * m(40), y: sy + Math.sin(side) * m(40) };
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
    if (Math.abs(this.v) < m(0.05) && t === 0) this.v = 0;
    this.v = Math.max(-TOP_BACK, Math.min(TOP, this.v));
    // The kinematic bicycle: the heading turns by v / L * tan(steer).
    const wheelbase = car.archetype.length * 0.6;
    const steer = -input.steer * LOCK * (1 - 0.5 * Math.min(1, Math.abs(this.v) / TOP));
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
        if (p.id === PLAYER_ID || p.busy > 0) continue;
        if (!insideBody(p.x, p.y, nx, ny, heading, car.archetype.length, car.archetype.width, m(0.25))) continue;
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
function insideBody(px: number, py: number, cx: number, cy: number, angle: number, length: number, width: number, pad: number): boolean {
  const rx = px - cx, ry = py - cy;
  const a = rx * Math.cos(angle) + ry * Math.sin(angle), b = -rx * Math.sin(angle) + ry * Math.cos(angle);
  return Math.abs(a) < length / 2 + pad && Math.abs(b) < width / 2 + pad;
}
