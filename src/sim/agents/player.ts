import { pointInPolygon } from '@core/polygon';
import { solidFootprints } from '@world/buildings/geometry';
import type { BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { DT } from '../params';
import { vehiclePose } from '../pose';
import type { SimWorld } from '../world';
import type { Vehicle, VehicleId } from '../vehicles/state';
import { AGENT_PERSON_BASE } from '../people/engine';
import { OwnCars, personGender } from './cars';
import {
  addPlayerWalker, movePlayerWalker, releaseWalker, removeWalker, sendRunning, startle, walkerAct, walkerOf, walkersNear,
} from './walk';

/**
 * A person of the city in the player's hands, as in GTA. Any resident can be
 * taken (`CityLife.takeControl`) and walked, run, driven:
 *
 * - on foot the body goes where the player points, through people as a
 *   person shoulders past, never through a wall; a word with somebody (F)
 *   stops the two of you facing each other a while, and does them good; a
 *   blow (Space) knocks them down - some get up and hit back - and everybody
 *   round runs off;
 * - a car is taken (E): one parked, or one in the traffic, its driver
 *   getting out and walking off; it is driven with the simplest model of a
 *   car (the kinematic bicycle: speed along the heading, turning by speed over
 *   wheelbase times the tangent of the steering), stopping dead against walls
 *   and other vehicles, knocking down whoever it runs into;
 * - every crime somebody sees (a blow, a crash, a person run over) puts stars
 *   on the player's wanted level, more for worse (GTA: "the Wanted Level rises
 *   when a violent action is performed in the vision of a non-player
 *   character"); out of sight of anybody for a while, the stars go one by one;
 * - the police are the residents on duty at the city's police stations: sent
 *   out running after the player, one or two per star, they arrest somebody
 *   on foot they catch up with. Nobody is made up.
 */

/** What the player is pressing this tick. */
export interface PlayerInput {
  /** On foot: the way to go, world axes, length 0 to 1. */
  moveX: number;
  moveY: number;
  /** In a car: the throttle (-1 reverse/brake to 1) and the steering (-1 left to 1 right). */
  throttle: number;
  steer: number;
  run: boolean;
  /** Pressed once (cleared when used). */
  enter: boolean;
  talk: boolean;
  punch: boolean;
  release: boolean;
}

export const newInput = (): PlayerInput => ({ moveX: 0, moveY: 0, throttle: 0, steer: 0, run: false, enter: false, talk: false, punch: false, release: false });

/** What the HUD shows. */
export interface PlayerView {
  readonly resident: number;
  readonly mode: 'foot' | 'car' | 'inside';
  /** Inside: the building, and what they are doing there (`agent.act.<kind>`). */
  readonly place: BuildingId | null;
  readonly activity: string | null;
  readonly x: number;
  readonly y: number;
  readonly health: number;
  readonly wanted: number;
  readonly speed: number;
  /** The last thing that happened, `player.msg.<key>`, and when (sim seconds). */
  readonly message: { readonly key: string; readonly at: number } | null;
  readonly officers: number;
}

const WALK = m(1.45), RUN = m(4.2);
const TURN = 9;
/** A body's radius against walls. */
const BODY = m(0.3);
/** Reach of a word, of a blow, of a car door. */
const TALK_REACH = m(2), PUNCH_REACH = m(1.4), DOOR_REACH = m(4.5);
/** The car: top speed forward and back, acceleration, braking, rolling drag, steering lock, wheelbase share. */
const TOP = m(22), TOP_BACK = m(6), ACCEL = m(4.5), BRAKE = m(9), DRAG = 0.25, LOCK = 0.6;
/** How far a witness sees a crime from, and the police see the player from. */
const SEES = m(30), POLICE_SEES = m(45);
/** Seconds out of sight before a star goes, and between stars going. */
const COOL = 20, STAR_EVERY = 12;
/** Police officers out per star, at most. */
const PER_STAR = 2;
/** An officer this close to the player on foot, for this long, arrests them. */
const ARREST_REACH = m(1.4), ARREST_TIME = 1.2;

export class Player {
  readonly input = newInput();
  resident: number | null = null;
  person = 0;
  mode: 'foot' | 'car' | 'inside' = 'foot';
  /** The building they went into. */
  private inside: BuildingId | null = null;
  x = 0; y = 0; heading = 0; v = 0;
  health = 100;
  wanted = 0;
  /** Seconds since the last crime seen, and since the last star went. */
  private quiet = 0;
  private sinceStar = 0;
  /** Seconds the player has been knocked down for yet (on foot: no control). */
  private down = 0;
  /** The car driven, a free body off the road. */
  private car: Vehicle | null = null;
  message: { key: string; at: number } | null = null;
  /** Officers out after the player: resident id, the station they came from. */
  private readonly officers = new Map<number, { station: BuildingId; close: number }>();
  private retarget = 0;
  private walls: { ring: readonly { x: number; y: number }[]; x0: number; y0: number; x1: number; y1: number }[] = [];
  private wallsFor = -1;

  /** Takes a resident into the player's hands; false when they cannot be found. */
  take(w: SimWorld, resident: number): boolean {
    if (this.resident !== null) this.letGo(w);
    const at = w.city.takeControl(w, resident);
    if (!at) return false;
    this.resident = resident;
    this.person = OwnCars.personOf(resident);
    this.health = 100;
    this.down = 0;
    this.v = 0;
    if (at.mode === 'car' && at.car !== null) {
      this.mode = 'foot';
      this.x = at.x; this.y = at.y; this.heading = at.heading;
      if (!this.getIn(w, at.car)) return this.take(w, resident);
    } else {
      this.mode = 'foot';
      this.x = at.x; this.y = at.y; this.heading = at.heading;
    }
    this.say(w, 'taken');
    return true;
  }

  /** Lets go: the resident walks home from where they are (out of the car first). */
  letGo(w: SimWorld): void {
    if (this.resident === null) return;
    if (this.mode === 'car') this.getOut(w);
    if (this.mode === 'inside') this.goOut(w);
    removeWalker(w, this.person);
    w.city.releaseControl(w, this.x, this.y);
    this.resident = null;
    this.callOff(w);
    this.wanted = 0;
  }

  view(): PlayerView | null {
    if (this.resident === null) return null;
    return { resident: this.resident, mode: this.mode, place: this.inside, activity: null, x: this.x, y: this.y, health: this.health, wanted: this.wanted,
      speed: Math.abs(this.v), message: this.message, officers: this.officers.size };
  }

  private say(w: SimWorld, key: string): void { this.message = { key, at: w.clock.time }; }

  /** One tick of the player and of the police after them. */
  step(w: SimWorld): void {
    if (this.resident === null) return;
    const input = this.input;
    if (input.release) { input.release = false; this.letGo(w); return; }
    if (this.mode === 'foot') this.onFoot(w);
    else if (this.mode === 'car') this.driving(w);
    else if (input.enter) { this.goOut(w); this.say(w, 'leftPlace'); }
    input.enter = input.talk = input.punch = false;
    this.police(w);
  }

  // ------------------------------------------------------------- on foot

  private onFoot(w: SimWorld): void {
    const input = this.input;
    // Our own body as the walk engine has it (another body may have pushed it, a fall may hold it).
    const me = walkerOf(w, this.person);
    if (!me) {
      addPlayerWalker(w, this.person, this.x, this.y, this.heading, w.city.resident(this.resident!)?.ageClass ?? 'adult', personGender(this.person));
    }
    if (this.down > 0) {
      this.down -= DT;
      this.v = 0;
      movePlayerWalker(w, this.person, this.x, this.y, this.heading, 0);
      return;
    }
    const len = Math.hypot(input.moveX, input.moveY);
    const top = input.run ? RUN : WALK;
    const want = Math.min(1, len) * top;
    this.v += Math.max(-m(8) * DT, Math.min(m(6) * DT, want - this.v));
    if (len > 0.05) {
      const to = Math.atan2(input.moveY, input.moveX);
      const err = Math.atan2(Math.sin(to - this.heading), Math.cos(to - this.heading));
      this.heading += Math.max(-TURN * DT, Math.min(TURN * DT, err));
    }
    const nx = this.x + Math.cos(this.heading) * this.v * DT, ny = this.y + Math.sin(this.heading) * this.v * DT;
    if (!this.inWall(w, nx, ny, BODY)) { this.x = nx; this.y = ny; }
    else if (!this.inWall(w, nx, this.y, BODY)) this.x = nx;
    else if (!this.inWall(w, this.x, ny, BODY)) this.y = ny;
    else this.v = 0;
    movePlayerWalker(w, this.person, this.x, this.y, this.heading, this.v);
    // Run over by the traffic.
    for (const veh of w.vehicles.values()) {
      const pose = vehiclePose(w, veh, 1);
      if (!pose || veh.v < m(1.5)) continue;
      if (insideBody(this.x, this.y, pose.p.x, pose.p.y, pose.angle, veh.archetype.length, veh.archetype.width, BODY)) {
        this.knockedDown(w, 35, 'runOver');
        break;
      }
    }
    if (input.talk) this.talk(w);
    if (input.punch) this.punch(w);
    if (input.enter) this.enterNearest(w);
  }

  private knockedDown(w: SimWorld, hurt: number, key: string): void {
    this.health = Math.max(0, this.health - hurt);
    this.down = 3;
    walkerAct(w, this.person, 'fall', 3, this.x, this.y);
    this.say(w, key);
    if (this.health <= 0) {
      this.say(w, 'fainted');
      this.letGo(w);
    }
  }

  /** The nearest other person in front within reach, or null. */
  private facing(w: SimWorld, reach: number): { id: number; x: number; y: number } | null {
    let best: { id: number; x: number; y: number } | null = null, bestD = reach;
    for (const p of walkersNear(w, this.x, this.y, reach)) {
      if (p.id === this.person) continue;
      const d = Math.hypot(p.x - this.x, p.y - this.y);
      const ahead = (p.x - this.x) * Math.cos(this.heading) + (p.y - this.y) * Math.sin(this.heading);
      if (ahead < -m(0.2) || d >= bestD) continue;
      best = p; bestD = d;
    }
    return best;
  }

  private talk(w: SimWorld): void {
    const other = this.facing(w, TALK_REACH);
    if (!other) { this.say(w, 'nobody'); return; }
    walkerAct(w, other.id, 'talk', 7, this.x, this.y);
    walkerAct(w, this.person, 'talk', 7, other.x, other.y);
    this.heading = Math.atan2(other.y - this.y, other.x - this.x);
    const r = other.id - AGENT_PERSON_BASE;
    if (r >= 0) w.city.boostNeed(r, 'social', 25);
    this.say(w, 'talked');
  }

  private punch(w: SimWorld): void {
    walkerAct(w, this.person, 'argue', 0.8, this.x + Math.cos(this.heading), this.y + Math.sin(this.heading));
    const other = this.facing(w, PUNCH_REACH);
    if (!other) return;
    // Some hit back: up again at once, and down goes the player.
    const tough = ((other.id * 2654435761) >>> 0) % 4 === 0;
    if (tough) {
      walkerAct(w, other.id, 'argue', 1.5, this.x, this.y);
      this.knockedDown(w, 15, 'hitBack');
    } else {
      walkerAct(w, other.id, 'fall', 4, this.x, this.y);
      this.say(w, 'punched');
    }
    this.crime(w, other.x, other.y, 1, other.id);
  }

  /** A crime done at a point: whoever is round runs off; anybody who saw it puts stars on the player. */
  private crime(w: SimWorld, x: number, y: number, stars: number, victim: number | null): void {
    const saw = startle(w, x, y, SEES, 12, null).filter((id) => id !== this.person);
    const byPolice = [...this.officers.keys()].some((r) => saw.includes(OwnCars.personOf(r)));
    if (saw.length === 0 && victim === null) return;
    this.wanted = Math.min(5, this.wanted + stars + (byPolice ? 1 : 0));
    this.quiet = 0;
    this.sinceStar = 0;
  }

  // ------------------------------------------------------------- cars

  private enterNearest(w: SimWorld): void {
    // A child does not drive.
    if (w.city.resident(this.resident!)?.ageClass === 'child') { this.say(w, 'tooYoung'); return; }
    let best: { id: VehicleId; d: number } | null = null;
    const consider = (id: VehicleId, x: number, y: number): void => {
      const d = Math.hypot(x - this.x, y - this.y);
      if (d < DOOR_REACH && (!best || d < best.d)) best = { id, d };
    };
    for (const body of w.city.cars?.offRoad() ?? []) if (body.free && body !== this.car) consider(body.id, body.free.x, body.free.y);
    for (const veh of w.vehicles.values()) {
      const pose = vehiclePose(w, veh, 1);
      if (pose) consider(veh.id, pose.p.x, pose.p.y);
    }
    // A door nearer than any car: in through it (a shop, a bank, a restaurant, a home).
    const door = w.city.doorNear(this.x, this.y, DOOR_REACH);
    const at = door !== null ? w.city.doorOf(door) : null;
    if (door !== null && at && (!best || Math.hypot(at.x - this.x, at.y - this.y) < (best as { d: number }).d)) { this.goIn(w, door); return; }
    if (!best) { this.say(w, 'noCar'); return; }
    if (!this.getIn(w, (best as { id: VehicleId }).id)) this.say(w, 'noCar');
  }

  /** Into a car: taken off the road or out of its bay; its driver, if any, out and walking. */
  private getIn(w: SimWorld, id: VehicleId): boolean {
    const cars = w.city.cars;
    if (!cars) return false;
    const got = cars.seize(w, id);
    if (!got) return false;
    const f = got.body.free!;
    if (got.driver !== null) {
      if (got.trip !== null) w.city.dropTrip(got.trip);
      // The driver pulled out: on the footway, running off, and it is a crime seen.
      w.city.putOnFoot(w, got.driver, f.x + Math.cos(f.angle + Math.PI / 2) * m(2.5), f.y + Math.sin(f.angle + Math.PI / 2) * m(2.5));
      this.crime(w, f.x, f.y, 1, null);
      this.say(w, 'carjacked');
    } else this.say(w, 'inCar');
    removeWalker(w, this.person);
    this.car = got.body;
    this.mode = 'car';
    this.v = got.body.v;
    this.x = f.x; this.y = f.y; this.heading = f.angle;
    got.body.seats = 1;
    got.body.people = [this.person];
    got.body.peopleAge = [w.city.resident(this.resident!)?.ageClass ?? 'adult'];
    return true;
  }

  /** Into a building by its door: off the street, doing what the place is for, until E again. */
  private goIn(w: SimWorld, building: BuildingId): void {
    removeWalker(w, this.person);
    w.city.enterAs(this.resident!, building);
    this.inside = building;
    this.mode = 'inside';
    this.v = 0;
    this.say(w, 'wentIn');
  }

  /** Out of the building, at its door. */
  private goOut(w: SimWorld): void {
    const door = w.city.leaveAs(this.resident!);
    if (door) { this.x = door.x; this.y = door.y; }
    this.inside = null;
    this.mode = 'foot';
    addPlayerWalker(w, this.person, this.x, this.y, this.heading, w.city.resident(this.resident!)?.ageClass ?? 'adult', personGender(this.person));
  }

  private getOut(w: SimWorld): void {
    const car = this.car;
    if (!car?.free) return;
    car.v = 0;
    car.seats = 0;
    car.people = [];
    car.peopleAge = [];
    const side = car.free.angle + Math.PI / 2;
    const across = car.archetype.width / 2 + m(0.6);
    this.x = car.free.x + Math.cos(side) * across;
    this.y = car.free.y + Math.sin(side) * across;
    this.mode = 'foot';
    this.v = 0;
    this.car = null;
    addPlayerWalker(w, this.person, this.x, this.y, this.heading, w.city.resident(this.resident!)?.ageClass ?? 'adult', personGender(this.person));
  }

  private driving(w: SimWorld): void {
    const car = this.car;
    const input = this.input;
    if (!car?.free) { this.mode = 'foot'; return; }
    if (input.enter) { this.getOut(w); this.say(w, 'outOfCar'); return; }
    const f = car.free;
    f.px = f.x; f.py = f.y; f.pangle = f.angle;
    // Throttle, brake, reverse.
    const t = input.throttle;
    if (t > 0) this.v += (this.v < 0 ? BRAKE : ACCEL) * t * DT;
    else if (t < 0) this.v += (this.v > 0 ? -BRAKE : -ACCEL * 0.6) * -t * DT;
    this.v -= this.v * DRAG * DT;
    if (Math.abs(this.v) < m(0.05) && t === 0) this.v = 0;
    this.v = Math.max(-TOP_BACK, Math.min(TOP, this.v));
    // The kinematic bicycle: the heading turns by v / L * tan(steer).
    const wheelbase = car.archetype.length * 0.6;
    const steer = input.steer * LOCK * (1 - 0.5 * Math.min(1, Math.abs(this.v) / TOP));
    const heading = f.angle + (this.v / wheelbase) * Math.tan(steer) * DT;
    const nx = f.x + Math.cos(heading) * this.v * DT, ny = f.y + Math.sin(heading) * this.v * DT;
    const half = car.archetype.length / 2, wide = car.archetype.width / 2;
    // Walls.
    const nose = { x: nx + Math.cos(heading) * half * Math.sign(this.v || 1), y: ny + Math.sin(heading) * half * Math.sign(this.v || 1) };
    if (this.inWall(w, nose.x, nose.y, wide * 0.8) || this.inWall(w, nx, ny, wide * 0.8)) {
      if (Math.abs(this.v) > m(4)) { this.say(w, 'crash'); this.health = Math.max(5, this.health - Math.abs(this.v) / m(1) * 0.8); }
      this.v = -this.v * 0.2;
      car.v = Math.abs(this.v);
      return;
    }
    // Other vehicles.
    for (const veh of w.vehicles.values()) {
      const pose = vehiclePose(w, veh, 1);
      if (!pose) continue;
      if (Math.hypot(pose.p.x - nx, pose.p.y - ny) < (half + veh.archetype.length / 2) * 0.75
        && insideBody(nose.x, nose.y, pose.p.x, pose.p.y, pose.angle, veh.archetype.length, veh.archetype.width, m(0.3))) {
        if (Math.abs(this.v) > m(3)) { this.say(w, 'crash'); this.crime(w, pose.p.x, pose.p.y, 1, null); }
        veh.v = 0;
        this.v = -this.v * 0.3;
        car.v = Math.abs(this.v);
        return;
      }
    }
    f.x = nx; f.y = ny; f.angle = heading;
    car.v = Math.abs(this.v);
    car.s += Math.abs(this.v) * DT;
    this.x = nx; this.y = ny; this.heading = heading;
    // People in the way: knocked down, and everybody runs.
    if (Math.abs(this.v) > m(1)) {
      for (const p of walkersNear(w, nx, ny, half + m(1))) {
        if (p.player || p.busy > 0) continue;
        if (!insideBody(p.x, p.y, nx, ny, heading, car.archetype.length, car.archetype.width, m(0.25))) continue;
        walkerAct(w, p.id, 'fall', 6, nx, ny);
        this.say(w, 'hitPerson');
        this.crime(w, p.x, p.y, 2, p.id);
      }
    }
  }

  // ------------------------------------------------------------- the police

  private police(w: SimWorld): void {
    if (this.wanted === 0) { if (this.officers.size) this.callOff(w); return; }
    // Seen by an officer: the clock out of sight starts again.
    let seen = false;
    for (const [r, o] of this.officers) {
      const p = walkerOf(w, OwnCars.personOf(r));
      // Off the street (their run ended where the player was): back at their station.
      if (!p) { w.city.giveBack(r, o.station); this.officers.delete(r); continue; }
      const d = Math.hypot(p.x - this.x, p.y - this.y);
      if (d < POLICE_SEES) seen = true;
      // Caught on foot.
      if (this.mode === 'foot' && d < ARREST_REACH) {
        o.close += DT;
        if (o.close >= ARREST_TIME) { this.arrested(w); return; }
      } else o.close = 0;
    }
    this.quiet += DT;
    if (seen) this.quiet = Math.min(this.quiet, COOL / 2);
    if (this.quiet > COOL) {
      this.sinceStar += DT;
      if (this.sinceStar > STAR_EVERY) {
        this.sinceStar = 0;
        this.wanted--;
        if (this.wanted === 0) { this.say(w, 'lostThem'); this.callOff(w); return; }
      }
    }
    // More officers out, from the stations, as the stars go up.
    if (this.officers.size < this.wanted * PER_STAR) this.dispatch(w);
    // After the player: their route on the walkways to where the player is, every few seconds.
    this.retarget -= DT;
    if (this.retarget <= 0) {
      this.retarget = 2.5;
      for (const r of this.officers.keys()) sendRunning(w, OwnCars.personOf(r), { x: this.x, y: this.y }, 2.6);
    }
  }

  private dispatch(w: SimWorld): void {
    const city = w.city;
    const free = city.atWork('police').filter((r) => !this.officers.has(r.id) && r.ageClass === 'adult');
    if (free.length === 0) return;
    const r = free[(Math.floor(w.clock.time) * 7) % free.length]!;
    const station = r.work!;
    const door = city.doorOf(station);
    const walk = w.pedEngine.walkTrip;
    if (!door || !walk || !city.borrow(r.id)) return;
    const person = OwnCars.personOf(r.id);
    const id = walk.call(w.pedEngine, w, { trip: -2, fromX: door.x, fromY: door.y, toX: this.x, toY: this.y,
      seed: 0, ageClass: 'adult', person, reach: m(60) });
    if (id === null) { city.giveBack(r.id, station); return; }
    sendRunning(w, person, { x: this.x, y: this.y }, 2.6);
    this.officers.set(r.id, { station, close: 0 });
    if (this.officers.size === 1) this.say(w, 'police');
  }

  /** The officers go back to their station. */
  private callOff(w: SimWorld): void {
    // They walk back to their station, and are counted there.
    for (const [r, o] of this.officers) {
      const door = w.city.doorOf(o.station);
      releaseWalker(w, OwnCars.personOf(r), door);
      w.city.giveBack(r, o.station);
    }
    this.officers.clear();
  }

  private arrested(w: SimWorld): void {
    this.say(w, 'arrested');
    walkerAct(w, this.person, 'fall', 2, this.x, this.y);
    this.letGo(w);
  }

  // ------------------------------------------------------------- walls

  private inWall(w: SimWorld, x: number, y: number, r: number): boolean {
    if (w.doc.buildings.revision !== this.wallsFor) {
      this.wallsFor = w.doc.buildings.revision;
      this.walls = [];
      for (const b of w.doc.buildings.all()) {
        for (const ring of solidFootprints(b)) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
          this.walls.push({ ring, x0, y0, x1, y1 });
        }
      }
    }
    for (const wl of this.walls) {
      if (x < wl.x0 - r || x > wl.x1 + r || y < wl.y0 - r || y > wl.y1 + r) continue;
      if (pointInPolygon({ x, y }, wl.ring)) return true;
    }
    return false;
  }
}

/** Whether a point is within a body's outline (a rectangle along its heading), grown by `pad`. */
function insideBody(px: number, py: number, cx: number, cy: number, angle: number, length: number, width: number, pad: number): boolean {
  const rx = px - cx, ry = py - cy;
  const a = rx * Math.cos(angle) + ry * Math.sin(angle), b = -rx * Math.sin(angle) + ry * Math.cos(angle);
  return Math.abs(a) < length / 2 + pad && Math.abs(b) < width / 2 + pad;
}
