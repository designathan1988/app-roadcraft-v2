import { Rng } from '@core/rng';
import type { BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { DRIVER_NOISE, DT, JAM_GAP } from '../params';
import { vehiclePose } from '../pose';
import type { SimWorld } from '../world';
import { ARCHETYPES, type Archetype } from '../vehicles/archetypes';
import { makeDriver, type Driver } from '../vehicles/driver';
import type { KerbStop } from '../vehicles/kerbStops';
import { createVehicle, snapshot, type Vehicle, type VehicleId } from '../vehicles/state';
import { planFrom } from '../routing/router';
import { AGENT_PERSON_BASE, type Boarder } from '../people/engine';
import { personHash, type PersonAgeClass, type PersonGender } from '../people/view';
import { type Bay, type Wall, clearOfWalls, collectBays, freeBayNear, wallsOf } from './parking';
import { solidFootprints } from '@world/buildings/geometry';
import { Manoeuvre, arrival, departure } from './manoeuvre';

/**
 * Residents who own a car and use it: the GTA half of the agents.
 *
 * A resident is one person from the morning to the night, and their car is one
 * car. When the diary sends them somewhere far (`sim/city/life.ts`), they do
 * what a driver does, one task after another, as GTA's pedestrians do with
 * their task sequences (walk to the car, enter it, drive, leave it):
 *
 *   toCar    walk from the door to the footway beside their parked car;
 *   board    step to the driver's door, open it, get in, shut it;
 *   leave    back out of the bay with a quarter turn and drive to the lane,
 *            waiting at the footway's edge for a gap in the traffic;
 *   drive    the car is an ordinary vehicle of the traffic simulation, with a
 *            route to the lane beside the bay chosen at the other end;
 *   park     pull off the lane and into that bay, nose first;
 *   alight   open the door, get out, shut it;
 *   fromCar  walk to the door of where they were going, and in.
 *
 * The car is never deleted: it stands in a bay (`parking.ts`) until its owner
 * comes back to it, and the next trip starts from wherever it was left. A
 * resident whose car is not near, or who would find no free bay at the other
 * end, walks instead (Cities: Skylines II's citizens weigh parking the same
 * way). Cars off the road are not vehicles of the traffic simulation: their
 * pose is `Vehicle.free`, written here and nowhere else.
 */

/** Why a trip is made: the player reads it translated (`agent.why.<reason>`). */
export type TripReason = 'work' | 'school' | 'home' | 'lunch' | 'errand' | 'outing';

export type CarPhase = 'toCar' | 'board' | 'leave' | 'drive' | 'park' | 'alight' | 'fromCar';

export interface OwnCar {
  readonly id: VehicleId;
  readonly owner: number;
  readonly archetype: Archetype;
  readonly driver: Driver;
  readonly colour: string;
  /** The bay it stands in, or is leaving; null while driving. */
  bay: Bay | null;
  /** The car as drawn while off the road; null while it is a vehicle of the traffic. */
  body: Vehicle | null;
}

export interface CarTrip {
  readonly trip: number;
  readonly resident: number;
  readonly person: number;
  readonly gender: PersonGender;
  readonly ageClass: PersonAgeClass;
  readonly car: OwnCar;
  readonly to: BuildingId;
  readonly door: { readonly x: number; readonly y: number };
  /** The bay at the other end, held for this car. */
  readonly target: Bay;
  phase: CarPhase;
  /** Seconds in the phase. */
  t: number;
  /** The walkable point beside the car the person walks to or from. */
  foot: { x: number; y: number } | null;
  path: Manoeuvre | null;
  /** Seconds spent waiting to join the lane. */
  held: number;
  /** Why the agent is doing what it does: shown when the player looks at them. */
  readonly why: TripReason;
  /** They go into the building at the other end by its back door, from the lot. */
  inBack: boolean;
}

/**
 * Farthest a resident's car stands from where they are (about a minute on
 * foot), and the farthest bay from where they go they will park in. Beyond
 * that they walk: nobody walks two minutes to their car to drive two more.
 */
const CAR_REACH = m(70);
const PARK_REACH = m(90);
/** Farthest a person walks between a back door and their car in the lot behind. */
const BACK_REACH = m(40);
/** Farthest from the walkable area a car door may be. */
const FOOT_REACH = m(40);
/** Seconds a door takes to open and to shut; to get from the seat to the door; pace on foot. */
const DOOR_OPEN = 0.9;
const DOOR_SHUT = 0.7;
const SEAT_TIME = 1.8;
const PACE = m(1.35);
/** How close to the lane the car pulls up before looking for a gap. */
const LANE_EDGE = m(4.5);
/** Room the traffic must leave for a car joining the lane. */
const GAP_BEHIND = m(32);
const GAP_AHEAD = m(10);
/** Speed a car joins the lane at. */
const JOIN_SPEED = m(2.4);
/** Cars a household may have: the classes residents drive. */
const CLASSES = ['hatch', 'sedan', 'suv'];

/** A person's gender as every part of the game reads it from their id (`seatPerson`). */
export function personGender(person: number): PersonGender {
  return (personHash(person) >>> 3) & 1 ? 'f' : 'm';
}

export class OwnCars {
  bays: Bay[] = [];
  /** Cars by owner (resident id). */
  readonly cars = new Map<number, OwnCar>();
  /** Car trips under way, by the city's trip id. */
  readonly trips = new Map<number, CarTrip>();
  /** Walks of car trips that ended since the last step. */
  private readonly walksEnded: number[] = [];
  /** Counters for the probes: trips made, ended by force, given up on the road. */
  made = 0;
  rescued = 0;

  /**
   * The bays read again, and a car for every resident who has one and a free
   * bay near where they are. Trips under way are ended where they were going.
   */
  rebuild(w: SimWorld, residents: readonly { id: number; seed: number; ageClass: PersonAgeClass; hasCar: boolean }[],
    where: (resident: number) => { building: BuildingId; door: { x: number; y: number } } | null): void {
    for (const trip of [...this.trips.values()]) { this.finish(w, trip); this.notify(trip.trip); }
    this.trips.clear();
    this.cars.clear();
    this.bays = collectBays(w);
    this.walls = wallsOf(w);
    for (const r of residents) {
      if (!r.hasCar || r.ageClass === 'child') continue;
      const at = where(r.id);
      if (!at) continue;
      // Parked in the lot behind the building they are in, reached from its back
      // door; with no such bay free they have no car to use here, and walk.
      const bay = this.bayBehind(w, at.building);
      if (!bay || !bay.lane) continue;
      const rng = new Rng(r.seed ^ 0x5eed_ca75);
      const classes = ARCHETYPES.filter((a) => CLASSES.includes(a.id));
      const archetype = classes[Math.floor(rng.float() * classes.length)]!;
      const driver = makeDriver(archetype, () => rng.float());
      const colour = archetype.palette[Math.floor(rng.float() * archetype.palette.length)]!;
      const car: OwnCar = { id: w.nextVehicleId++, owner: r.id, archetype, driver, colour, bay, body: null };
      bay.car = car.id;
      car.body = this.parkedBody(w, car, bay);
      this.cars.set(r.id, car);
    }
  }

  /** The person id a resident lives as. */
  static personOf(resident: number): number { return AGENT_PERSON_BASE + resident; }

  /**
   * Starts a car trip if the resident's car is near and a bay is free near where
   * they go; false, and nothing changed, otherwise (they walk).
   */
  start(w: SimWorld, r: { id: number; seed: number; ageClass: PersonAgeClass }, trip: number,
    fromBuilding: BuildingId, from: { x: number; y: number }, to: BuildingId, door: { x: number; y: number },
    why: TripReason): boolean {
    const car = this.cars.get(r.id);
    if (!car || !car.body || !car.bay) return false;
    const side = driverDoor(car.body);
    // Out of the back of the building straight to the car when it stands in the
    // lot behind it; otherwise along the footway to the point nearest the car.
    const back = this.rearDoor(w, fromBuilding, side);
    if (!back && Math.hypot(car.bay.x - from.x, car.bay.y - from.y) > CAR_REACH) return false;
    const target = this.bayBehind(w, to) ?? freeBayNear(this.bays, door.x, door.y, PARK_REACH);
    if (!target || target === car.bay) return false;
    const person = OwnCars.personOf(r.id);
    const gender = personGender(person);
    let foot: { x: number; y: number } | null = back;
    if (!back) {
      const walk = w.pedEngine.walkTrip;
      const near = w.pedEngine.walkableNear;
      foot = walk && near ? near.call(w.pedEngine, w, side.x, side.y, FOOT_REACH) : null;
      if (!walk || !foot) return false;
      const walker = walk.call(w.pedEngine, w, {
        trip, fromX: from.x, fromY: from.y, toX: foot.x, toY: foot.y, seed: gender === 'f' ? 1 : 0,
        ageClass: r.ageClass, person, reach: m(8),
      });
      if (walker === null) return false;
    }
    target.car = car.id;
    this.trips.set(trip, {
      trip, resident: r.id, person, gender, ageClass: r.ageClass, car, to, door, target,
      phase: back ? 'board' : 'toCar', t: 0, foot, path: null, held: 0, why, inBack: false,
    });
    this.made++;
    return true;
  }

  /** Every building's walls, for the walks between a car and a back door. */
  private walls: Wall[] = [];

  /**
   * The point just outside a building's walls nearest `to`, if a person can walk
   * from it to `to` in a straight line without passing another building: the
   * back door they use for a car parked in the lot behind.
   */
  private rearDoor(w: SimWorld, building: BuildingId, to: { x: number; y: number }): { x: number; y: number } | null {
    const b = w.doc.buildings.get(building);
    if (!b) return null;
    let best: { x: number; y: number } | null = null;
    let bestD = BACK_REACH;
    for (const ring of solidFootprints(b)) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j]!, c = ring[i]!;
        const ex = c.x - a.x, ey = c.y - a.y;
        const len2 = ex * ex + ey * ey;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((to.x - a.x) * ex + (to.y - a.y) * ey) / len2)) : 0;
        const px = a.x + ex * t, py = a.y + ey * t;
        const d = Math.hypot(to.x - px, to.y - py);
        if (d < bestD && d > 1e-6) {
          bestD = d;
          best = { x: px + ((to.x - px) / d) * m(0.5), y: py + ((to.y - py) / d) * m(0.5) };
        }
      }
    }
    if (!best) return null;
    return clearOfWalls(this.walls, best, to, m(0.35), building) ? best : null;
  }

  /** The free bay nearest a building that a person can walk to from its back, or null. */
  private bayBehind(w: SimWorld, building: BuildingId): Bay | null {
    const b = w.doc.buildings.get(building);
    if (!b) return null;
    const rings = solidFootprints(b);
    if (rings.length === 0) return null;
    const candidates: { bay: Bay; d: number }[] = [];
    for (const bay of this.bays) {
      if (bay.car !== null || !bay.lane) continue;
      let d = Infinity;
      for (const ring of rings) for (const p of ring) d = Math.min(d, Math.hypot(p.x - bay.x, p.y - bay.y));
      if (d < BACK_REACH) candidates.push({ bay, d });
    }
    candidates.sort((a, c) => a.d - c.d);
    for (const { bay } of candidates.slice(0, 12)) if (this.rearDoor(w, building, bay)) return bay;
    return null;
  }

  /** A walk of one of the car trips ended (`PedestrianEngine.takeArrivals`). */
  walkEnded(trip: number): void { this.walksEnded.push(trip); }

  /** Told of every trip that has ended, set by `step`. */
  private notify: (trip: number) => void = () => {};

  /** A trip over: forgotten here, and the city told the person is where they went. */
  private end(t: CarTrip): void {
    this.trips.delete(t.trip);
    this.notify(t.trip);
  }

  /** One tick of every car trip; `done` is told of each trip that has ended. */
  step(w: SimWorld, done: (trip: number) => void): void {
    this.notify = done;
    const ended = new Set(this.walksEnded);
    this.walksEnded.length = 0;
    for (const t of this.trips.values()) {
      t.t += DT;
      switch (t.phase) {
        case 'toCar':
          if (ended.has(t.trip)) this.enter(t, 'board');
          break;
        case 'board': this.board(t); break;
        case 'leave': this.leave(w, t); break;
        case 'drive': this.drive(w, t); break;
        case 'park': this.park(w, t); break;
        case 'alight': this.alight(w, t, done); break;
        case 'fromCar':
          if (ended.has(t.trip)) { this.trips.delete(t.trip); done(t.trip); }
          break;
      }
    }
    for (const car of this.cars.values()) {
      const f = car.body?.free;
      if (!f) continue;
      // A standing car's previous pose is its pose; a moving one was set this tick.
      if (car.body!.v === 0) { f.px = f.x; f.py = f.y; f.pangle = f.angle; }
    }
  }

  /** A trip given up by the city (too long): the car is put in its bay, the person where they went. */
  abandon(w: SimWorld, trip: number): void {
    const t = this.trips.get(trip);
    if (t) this.finish(w, t);
    this.trips.delete(trip);
  }

  /** Cars off the road, to be drawn: parked ones and those manoeuvring (one array, refilled per call). */
  offRoad(): readonly Vehicle[] {
    const out = this.drawn;
    out.length = 0;
    for (const car of this.cars.values()) if (car.body) out.push(car.body);
    return out;
  }
  private readonly drawn: Vehicle[] = [];

  /** The trip a person is on, for the player's question "what is this one doing?". */
  tripOfPerson(person: number): CarTrip | null {
    for (const t of this.trips.values()) if (t.person === person) return t;
    return null;
  }

  /** The trip a car is on. */
  tripOfCar(car: VehicleId): CarTrip | null {
    for (const t of this.trips.values()) if (t.car.id === car) return t;
    return null;
  }

  // ------------------------------------------------------------- phases

  private enter(t: CarTrip, phase: CarPhase): void { t.phase = phase; t.t = 0; }

  private board(t: CarTrip): void {
    const body = t.car.body!;
    let stop = body.kerbStop;
    if (!stop) {
      const side = driverDoor(body);
      const foot = t.foot ?? side;
      const person: Boarder = { seed: t.person, gender: t.gender, ageClass: t.ageClass, footX: foot.x, footY: foot.y,
        footHeading: Math.atan2(side.y - foot.y, side.x - foot.x) };
      stop = body.kerbStop = transferStop(body, 'pick', person, Math.hypot(side.x - foot.x, side.y - foot.y) / PACE, SEAT_TIME);
      stop.phase = 'fetch';
    }
    stop.t += DT;
    stop.elapsed += DT;
    if (stop.phase === 'fetch') {
      stop.walked += DT;
      if (stop.walked >= stop.fetchTime) { stop.phase = 'open'; stop.t = 0; }
    } else if (stop.phase === 'open') {
      setDoor(body, Math.min(1, stop.t / DOOR_OPEN));
      if (stop.t >= DOOR_OPEN) { stop.phase = 'transfer'; stop.t = 0; }
    } else if (stop.phase === 'transfer') {
      if (stop.t >= stop.transferTime) {
        body.seats = 1;
        body.people = [t.person];
        body.peopleAge = [t.ageClass];
        stop.phase = 'close'; stop.t = 0;
      }
    } else if (stop.phase === 'close') {
      setDoor(body, Math.max(0, 1 - stop.t / DOOR_SHUT));
      if (stop.t >= DOOR_SHUT) {
        body.kerbStop = null;
        body.doors = [];
        const bay = t.car.bay!;
        t.path = departure(bay, bay.lane!);
        this.enter(t, 'leave');
      }
    }
  }

  private leave(w: SimWorld, t: CarTrip): void {
    const body = t.car.body!;
    const path = t.path!;
    const lane = t.car.bay!.lane!;
    // At the footway's edge: wait for a gap in the traffic and for the people
    // on the footway, as a driver does coming out of a drive.
    if (path.length - path.s <= LANE_EDGE && !this.mayJoin(w, t, lane)) {
      t.held += DT;
      body.v = 0;
      setFree(body, path.poseAt());
      return;
    }
    const v = path.speed();
    path.advance(v * DT);
    // Distance driven, for the wheels: an off-road body is not in the traffic, so `s` is free for it.
    body.s = path.s;
    body.v = v;
    setFree(body, path.poseAt());
    if (!path.done) return;
    // On the lane: the same car becomes a vehicle of the traffic.
    const bay = t.car.bay!;
    if (bay.car === t.car.id) bay.car = null;
    t.car.bay = null;
    const road = this.toRoad(w, t, lane);
    if (!road) { this.finish(w, t); this.end(t); return; }
    t.car.body = null;
    t.path = null;
    this.enter(t, 'drive');
  }

  private drive(w: SimWorld, t: CarTrip): void {
    const v = w.vehicles.get(t.car.id);
    if (!v) { this.rescued++; this.finish(w, t); this.end(t); return; }
    const c = v.commute;
    // Stopped at the place beside the bay, or past it: a lane change can carry a
    // car beyond it, and the stop then holds it just after; it parks from there.
    if (!c || v.lanelet !== c.lanelet || v.v > 0.3 || v.s < c.at - m(2.5)) return;
    // Stopped beside the bay: off the lane, and in.
    const pose = vehiclePose(w, v, 1);
    w.removeVehicle(v);
    if (!pose) { this.rescued++; this.finish(w, t); this.end(t); return; }
    const body = this.offRoadBody(w, t.car, v.lanelet, pose.p.x, pose.p.y, pose.angle, t.target.building);
    body.seats = 1;
    body.people = [t.person];
    body.peopleAge = [t.ageClass];
    t.car.body = body;
    t.path = arrival({ x: pose.p.x, y: pose.p.y, angle: pose.angle }, t.target);
    this.enter(t, 'park');
  }

  private park(w: SimWorld, t: CarTrip): void {
    const body = t.car.body!;
    const path = t.path!;
    const v = path.speed();
    path.advance(v * DT);
    body.s = path.s;
    body.v = path.done ? 0 : v;
    setFree(body, path.poseAt());
    if (!path.done) return;
    t.car.bay = t.target;
    t.path = null;
    const side = driverDoor(body);
    // In by the back door when the lot is behind where they are going.
    const back = this.rearDoor(w, t.to, side);
    const near = w.pedEngine.walkableNear;
    t.inBack = back !== null;
    t.foot = back ?? (near ? near.call(w.pedEngine, w, side.x, side.y, FOOT_REACH) : null);
    this.enter(t, 'alight');
  }

  private alight(w: SimWorld, t: CarTrip, done: (trip: number) => void): void {
    const body = t.car.body!;
    let stop = body.kerbStop;
    const side = driverDoor(body);
    const foot = t.foot ?? side;
    if (!stop) {
      const person: Boarder = { seed: t.person, gender: t.gender, ageClass: t.ageClass, footX: foot.x, footY: foot.y,
        footHeading: Math.atan2(foot.y - side.y, foot.x - side.x) };
      stop = body.kerbStop = transferStop(body, 'drop', person, 0,
        SEAT_TIME + Math.hypot(side.x - foot.x, side.y - foot.y) / PACE);
      stop.phase = 'open';
    }
    stop.t += DT;
    stop.elapsed += DT;
    if (stop.phase === 'open') {
      setDoor(body, Math.min(1, stop.t / DOOR_OPEN));
      if (stop.t >= DOOR_OPEN) {
        stop.phase = 'transfer'; stop.t = 0;
        body.seats = 0; body.people = []; body.peopleAge = [];
      }
    } else if (stop.phase === 'transfer') {
      // Out of the seat, a step clear of the door, and it is pushed shut while
      // they walk on to the footway.
      const away = (stop.t - SEAT_TIME) * PACE - m(1.2);
      if (away > 0) setDoor(body, Math.max(0, 1 - away / (PACE * DOOR_SHUT)));
      if (stop.t >= stop.transferTime) {
        body.kerbStop = null;
        body.doors = [];
        this.walkIn(w, t, done);
      }
    }
  }

  /** Out of the car and on the footway: the last walk, to the door and in. */
  private walkIn(w: SimWorld, t: CarTrip, done: (trip: number) => void): void {
    // At the back door already: in.
    if (t.inBack) { this.trips.delete(t.trip); done(t.trip); return; }
    const walk = w.pedEngine.walkTrip;
    const foot = t.foot;
    const id = walk && foot ? walk.call(w.pedEngine, w, {
      trip: t.trip, fromX: foot.x, fromY: foot.y, toX: t.door.x, toY: t.door.y, seed: t.gender === 'f' ? 1 : 0,
      ageClass: t.ageClass, person: t.person, reach: m(8),
    }) : null;
    if (id === null) { this.trips.delete(t.trip); done(t.trip); return; }
    t.phase = 'fromCar';
    t.t = 0;
  }

  // ------------------------------------------------------------- the car

  /** Whether the lane has room behind and ahead of the joining point, and the footway is clear. */
  private mayJoin(w: SimWorld, t: CarTrip, lane: NonNullable<Bay['lane']>): boolean {
    const front = lane.at + t.car.archetype.length / 2;
    for (const body of w.bodiesIn(lane.lanelet)) {
      const bFront = body.s;
      const bRear = body.s - body.vehicle.archetype.length;
      if (bFront > front - t.car.archetype.length - GAP_BEHIND - JAM_GAP && bRear < front + GAP_AHEAD) return false;
    }
    const nose = t.car.body!.free!;
    const nx = nose.x + Math.cos(nose.angle) * t.car.archetype.length * 0.6;
    const ny = nose.y + Math.sin(nose.angle) * t.car.archetype.length * 0.6;
    return !w.pedEngine.bridge.anyoneWithin(w, nx, ny, m(1.3), null);
  }

  /** The car put on the lane as a vehicle of the traffic, bound for the bay at the other end. */
  private toRoad(w: SimWorld, t: CarTrip, lane: NonNullable<Bay['lane']>): Vehicle | null {
    const l = w.lanelet(lane.lanelet);
    const goal = t.target.lane;
    if (!l || !goal) return null;
    const a = t.car.archetype;
    const v0 = l.speedLimit * a.speedFactor * w.rng.driver.range(DRIVER_NOISE.lo, DRIVER_NOISE.hi);
    const v = createVehicle(t.car.id, a, t.car.driver, t.car.colour, l.id, v0, w.clock.tick);
    v.s = Math.min(l.length, lane.at + a.length / 2);
    v.v = JOIN_SPEED;
    v.prev = snapshot(v);
    v.seats = 1;
    v.people = [t.person];
    v.peopleAge = [t.ageClass];
    v.errand = null;
    v.commute = { trip: t.trip, lanelet: goal.lanelet, at: goal.at + a.length / 2 };
    w.vehicles.set(v.id, v);
    w.enterLanelet(v, l.id);
    v.destination = goal.lanelet;
    planFrom(w, v);
    return v;
  }

  private parkedBody(w: SimWorld, car: OwnCar, bay: Bay): Vehicle {
    return this.offRoadBody(w, car, bay.lane!.lanelet, bay.x, bay.y, Math.atan2(-bay.oy, -bay.ox), bay.building);
  }

  /** The car as a drawn body off the road, standing at `(x, y)` facing `angle`. */
  private offRoadBody(w: SimWorld, car: OwnCar, lanelet: Vehicle['lanelet'], x: number, y: number, angle: number,
    lot: number): Vehicle {
    const body = createVehicle(car.id, car.archetype, car.driver, car.colour, lanelet, 0, w.clock.tick);
    body.seats = 0;
    body.free = { x, y, angle, px: x, py: y, pangle: angle, lot };
    return body;
  }

  /**
   * Ends a trip at once (given up, or the city read again): the car stands in
   * a bay - the one it never left, or the one it was going to - and every
   * other bay it held is free again.
   */
  private finish(w: SimWorld, t: CarTrip): void {
    const car = t.car;
    const onRoad = w.vehicles.get(car.id);
    if (onRoad) w.removeVehicle(onRoad);
    const stay = (t.phase === 'toCar' || t.phase === 'board') && car.bay ? car.bay : t.target;
    for (const b of [car.bay, t.target]) if (b && b !== stay && b.car === car.id) b.car = null;
    stay.car = car.id;
    car.bay = stay;
    car.body = this.parkedBody(w, car, stay);
  }
}

/** Where the driver stands to open their door: the left side, by the front seat. */
function driverDoor(body: Vehicle): { x: number; y: number } {
  const f = body.free!;
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  const across = body.archetype.width / 2 + m(0.55);
  const along = body.archetype.length * 0.08;
  return { x: f.x + c * along - s * across, y: f.y + s * along + c * across };
}

function setFree(body: Vehicle, p: { x: number; y: number; angle: number }): void {
  const f = body.free!;
  f.px = f.x; f.py = f.y; f.pangle = f.angle;
  f.x = p.x; f.y = p.y; f.angle = p.angle;
}

function setDoor(body: Vehicle, open: number): void {
  if (body.doors.length === 0) body.doors.push(0);
  body.doors[0] = open;
}

/** A door transfer the renderer draws as it draws a kerb stop (`render/occupants.ts`). */
function transferStop(body: Vehicle, kind: 'pick' | 'drop', person: Boarder, fetchTime: number, transferTime: number): KerbStop {
  return {
    kind, lanelet: body.lanelet, at: 0, door: 0, seat: 0, phase: 'open', t: 0, elapsed: 0, pedId: null, person,
    transferTime, fetchTime, walked: 0, keep: false, hold: 0, seatStage: true,
  };
}
