import { Rng } from '@core/rng';
import { footprintCentre } from '@world/buildings/geometry';
import type { BuildingId } from '@world/buildings/types';
import type { LaneletId } from '@world/lanelets';
import { m } from '@world/units';
import { pathWorkLeft } from '@world/nav/path';
import { DRIVER_NOISE, DT, JAM_GAP } from '../params';
import type { SimWorld } from '../world';
import { ARCHETYPES, type Archetype } from '../vehicles/archetypes';
import { makeDriver } from '../vehicles/driver';
import { createVehicle, snapshot, type Vehicle } from '../vehicles/state';
import { assignOccupancy } from '../vehicles/kerbStops';
import { planFrom } from '../routing/router';
import { type Population, type Resident, derivePopulation } from './population';
import { type CarPhase, OwnCars, personGender, type TripReason } from '../agents/cars';
import { DECIDE_EVERY, type Mind, type Needs, type PlaceIndex, committedTo, decide, live, newMind, placeIndex } from '../agents/mind';
import { type ActivityKind, BuildingUse, type Doing, type YardPlaces, chooseActivity } from '../agents/activities';
import { addPlayerWalker, removeWalker, takeWalker, walkerAct, walkerOf } from '../agents/walk';
import { type Rider, TransitSim } from '../transit/transit';
import { Player } from '../agents/player';
import { CrimeSim, type CrimePhase } from '../agents/crime';
import type { VehicleId } from '../vehicles/state';
import { vehiclePose } from '../pose';
import { localToWorld } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';

/**
 * The residents' days: The Sims inside SimCity.
 *
 * Everybody who lives in the city has a home, most adults a job, children a
 * school. In the morning they leave home and go to work - on foot, or by car
 * if they have one and it is far - go in, and stay; in the evening they come
 * home, and some go out again for a meal, a film, a walk in the park. The
 * traffic on the streets is theirs: with residents in the city nothing comes
 * in at the map's edges (`SimWorld.edgeTraffic`).
 *
 * A resident inside a building is not an agent: only the trips move. A walk
 * is a person on the footway, from one door to another (`PedestrianEngine.
 * walkTrip`); a drive is a car from the kerb outside one door to the kerb
 * outside the other, where it pulls in and is parked, and its driver walks
 * the last metres in.
 */

/** Game seconds per simulated second: a day lasts 72 minutes of play. */
export const TIME_SCALE = 20;
/** The time of day the city wakes at, minutes after midnight. */
export const DAY_START = 6 * 60 + 30;
/** Seconds between two looks at everybody's diary. */
const LOOK_EVERY = 0.5;
/** The answer for an empty building, shared. */
const NOBODY: readonly Resident[] = [];
/** Most residents walking, and driving, at once: a queue forms beyond. */
const MAX_WALKS = 160;
/** Farther than this a resident without a car looks for a line to take (`sim/transit`). */
const TRANSIT_FROM = m(500);
/**
 * Residents without a car who cycle (one in three, by their seed) take their
 * bicycle for trips between these distances; farther, the bus or the train.
 * They ride on the road, in the cycle lane where the street has one
 * (`sim/vehicles/cycleLane.ts`), and walk the last metres from the kerb.
 */
const BIKE_FROM = m(200);
const BIKE_TO = m(1600);
const isHome = (fn: string | undefined): boolean => fn === 'house' || fn === 'townhouse' || fn === 'apartments' || fn === 'residentialTower';
const BICYCLE = ARCHETYPES.find((a) => a.id === 'bicycle')!;
const cycles = (r: Resident): boolean => !r.hasCar && r.ageClass !== 'child' && r.seed % 3 === 0;
const MAX_DRIVES = 90;
/** Closer than this, nobody takes the car. */
const DRIVE_FROM = m(150);
/** Farthest from a door a kerb lane is looked for. */
const KERB_REACH = m(28);
/** Longest a trip may run before the city gives up on it (seconds). */
const TRIP_LIMIT = 900;
/** Kept clear of the ends of a lane when a car pulls in or out. */
const LANE_END = m(10);

export interface Trip {
  readonly id: number;
  readonly resident: number;
  readonly to: BuildingId;
  mode: 'walk' | 'drive' | 'transit' | 'bike';
  /** Why it is made (`agent.why.<reason>`). */
  readonly why?: TripReason;
  /** The walker or the car carrying it. */
  agent: number;
  started: number;
}

interface Diary {
  /** Where the resident is; null while travelling. */
  at: BuildingId | null;
  day: number;
  /** Diary entries already done today. */
  done: number;
}

interface Entry {
  readonly at: number;
  readonly from: BuildingId;
  readonly to: BuildingId;
}

interface Kerb {
  readonly lanelet: LaneletId;
  readonly at: number;
  readonly x: number;
  readonly y: number;
}

export interface CityCounts {
  readonly residents: number;
  readonly jobs: number;
  readonly walking: number;
  readonly driving: number;
  readonly atHome: number;
  readonly atWork: number;
  readonly out: number;
  readonly waiting: number;
}

export class CityLife {
  /** The player may switch the residents off (and the edge traffic back on). */
  enabled = true;
  population: Population = { residents: [], jobs: new Map(), homes: new Map() };
  private builtFor = -1;
  private accessFor = '';
  private readonly diaries = new Map<number, Diary>();
  /**
   * Who is in each building, made in one pass over the residents and kept
   * until somebody moves (`moved`). Asked building by building - the lit
   * windows each second, the rooms cut open each frame - one pass over every
   * resident for every building was buildings times residents each time.
   */
  private occupancy: Map<BuildingId, Resident[]> | null = null;
  private moved(): void { this.occupancy = null; }
  /** Trips under way, by id. */
  readonly trips = new Map<number, Trip>();
  /** The game minute of the last look at the diaries. */
  private lastMinutes: number | null = null;
  private nextTrip = 1;
  private lookClock = 0;
  private readonly doors = new Map<BuildingId, { x: number; y: number }>();
  private readonly kerbs = new Map<BuildingId, Kerb | null>();
  private readonly byResident = new Map<number, Resident>();
  private readonly rng = new Rng(0xc171);
  /** Trips that could not be made: no door on a footway, no route. */
  stranded = 0;
  completed = 0;
  /**
   * Residents as agents (the default, `sim/agents`): each car is the resident's
   * own, parked in a bay and driven by them, instead of a car made at the kerb
   * for one trip and deleted at the end of it. Null: the old trips.
   */
  cars: OwnCars | null = null;
  /**
   * The agents' minds (`sim/agents/mind.ts`): their needs, and the places they
   * weigh. With agents on, where a resident goes is decided by what they need
   * and what is open near them, inside their commitments, not by a fixed diary.
   */
  private readonly minds = new Map<number, Mind>();
  private places: PlaceIndex | null = null;
  /** What each resident in a building is doing there, with what (`activities.ts`). */
  private readonly doings = new Map<number, Doing>();
  /** Each building's furniture and who has which piece, rebuilt with the buildings. */
  private readonly uses = new Map<BuildingId, BuildingUse>();
  private usesFor = -1;

  /** Switches the residents' own cars on or off; the city is read again either way. */
  useAgents(on: boolean): void {
    this.cars = on ? new OwnCars() : null;
    this.accessFor = '';
    this.minds.clear();
  }

  /** A resident's needs now (agents only), or null. */
  needsOf(resident: number): Readonly<Needs> | null {
    return this.minds.get(resident)?.needs ?? null;
  }

  /**
   * Sends a resident who is in a building to another one now, the way their
   * diary would (by their own car if it is near and the other end has a free
   * bay, on foot otherwise). The player's "go there", and the probes' way to
   * make a trip happen. Returns how they set off, or null.
   */
  goTo(w: SimWorld, resident: number, to: BuildingId): 'walk' | 'drive' | null {
    const r = this.byResident.get(resident);
    const d = this.diaries.get(resident);
    if (!r || !d || d.at === null || d.at === to) return null;
    const started = this.start(w, r, d, { at: this.minutes(w) % 1440, from: d.at, to }, true, true);
    return started === 'walk' || started === 'drive' ? started : null;
  }

  /** Minutes since midnight of the first day, from the simulation clock. */
  minutes(w: SimWorld): number {
    return DAY_START + this.skipped + (w.clock.tick * DT * TIME_SCALE) / 60;
  }

  /** Minutes the clock was moved on by hand (`skip`). */
  private skipped = 0;

  /** Moves the clock on: everybody's diary catches up, a queue at a time. */
  skip(minutes: number): void {
    const by = Math.max(0, minutes);
    this.skipped += by;
    // The hours skipped were lived as any others, off the screen: needs are
    // not run down for them, and whatever anybody was doing is over.
    for (const mind of this.minds.values()) mind.updated += by;
    for (const [id, d] of this.doings) {
      if (d.piece >= 0) this.uses.get(d.building)?.taken.delete(`${d.level}:${d.piece}`);
      this.doings.delete(id);
    }
  }

  /**
   * What a resident is doing and why, for the player who clicks on them (an
   * agent's card): where they are, the trip under way (on foot, or the step of
   * their car trip), where their car is. Null for an unknown resident.
   */
  describe(resident: number): AgentView | null {
    const r = this.byResident.get(resident);
    const d = this.diaries.get(resident);
    if (!r || !d) return null;
    let trip: AgentView['trip'] = null;
    for (const t of this.trips.values()) {
      if (t.resident !== resident) continue;
      const step = t.mode === 'bike' ? 'bike' : this.transit.riders.get(t.id)?.phase ?? this.cars?.trips.get(t.id)?.phase ?? 'walk';
      trip = { step, why: t.why ?? 'outing', to: t.to };
      break;
    }
    const own = this.cars?.cars.get(resident);
    const car: AgentView['car'] = own ? {
      archetype: own.archetype.id, colour: own.colour,
      state: own.body === null ? 'driving' : own.body.v > 0 || (trip && trip.step !== 'walk' && trip.step !== 'toCar' && trip.step !== 'fromCar') ? 'inUse' : 'parked',
      at: own.bay?.building ?? null,
    } : null;
    const needs = this.minds.get(resident)?.needs;
    const doing = this.doingOf(resident);
    const crime: AgentView['crime'] = this.crime.phaseOf(resident)
      ?? (this.crime.chasing(resident) ? 'chasing' : this.crime.patrolling(resident) ? 'patrolling' : this.lastMinutes !== null && this.isHeld(resident, this.lastMinutes) ? 'held' : null);
    return { resident, person: OwnCars.personOf(resident), ageClass: r.ageClass, home: r.home, work: r.work, at: d.at, trip, car,
      thief: CrimeSim.isThief(r), crime,
      job: this.drivers.has(resident) ? 'busDriver' : r.work !== null && isHome(this.places?.kindOf(r.work)) ? 'nanny' : null,
      ...(this.drivers.has(resident) ? { line: this.drivers.get(resident)! } : {}),
      ...(needs ? { needs: { ...needs } } : {}), ...(doing && d.at !== null ? { activity: doing.kind } : {}) };
  }

  /** The resident whose own car this is, or null. */
  ownerOfCar(vehicle: number): number | null {
    for (const c of this.cars?.cars.values() ?? []) if (c.id === vehicle) return c.owner;
    return null;
  }

  /** The point on the footway a building is entered from, or null. */
  doorOf(building: BuildingId): { readonly x: number; readonly y: number } | null {
    return this.doors.get(building) ?? null;
  }

  /** Where a resident is now: a building, or null on the way. */
  whereIs(resident: number): BuildingId | null {
    return this.diaries.get(resident)?.at ?? null;
  }

  /** The residents inside a building now. */
  inside(building: BuildingId): readonly Resident[] {
    if (!this.occupancy) {
      const index = new Map<BuildingId, Resident[]>();
      for (const r of this.population.residents) {
        const at = this.diaries.get(r.id)?.at;
        if (at === undefined || at === null) continue;
        let list = index.get(at);
        if (!list) { list = []; index.set(at, list); }
        list.push(r);
      }
      this.occupancy = index;
    }
    return this.occupancy.get(building) ?? NOBODY;
  }

  counts(): CityCounts {
    let walking = 0, driving = 0, atHome = 0, atWork = 0, out = 0;
    for (const t of this.trips.values()) if (t.mode === 'walk') walking++; else driving++;
    for (const r of this.population.residents) {
      const at = this.diaries.get(r.id)?.at;
      if (at === undefined || at === null) continue;
      if (at === r.home) atHome++;
      else if (at === r.work) atWork++;
      else out++;
    }
    let jobs = 0;
    for (const j of this.population.jobs.values()) jobs += j.offered;
    return {
      residents: this.population.residents.length, jobs, walking, driving, atHome, atWork, out,
      waiting: this.population.residents.length - walking - driving - atHome - atWork - out,
    };
  }

  // ------------------------------------------------------------ the step

  step(w: SimWorld): void {
    if (w.doc.buildings.revision !== this.builtFor) this.rebuild(w);
    const live = this.enabled && this.population.residents.length > 0;
    w.edgeTraffic = !live;
    if (!live) return;
    const accessKey = `${w.buildingAccessRevision}:${w.topologyRevision}`;
    if (accessKey !== this.accessFor) this.readAccess(w, accessKey);

    this.arrivals(w);
    this.cars?.step(w, (id) => { const t = this.trips.get(id); if (t) this.arrive(t); });
    this.player.step(w);
    this.crime.step(w);
    this.ride(w);
    this.lookClock += DT;
    if (this.lookClock < LOOK_EVERY) return;
    this.lookClock = 0;
    this.giveUp(w);

    const now = this.minutes(w);
    this.lastMinutes = now;
    const day = Math.floor(now / 1440);
    const clock = now - day * 1440;
    let walks = 0, drives = 0;
    for (const t of this.trips.values()) if (t.mode === 'walk') walks++; else drives++;

    if (this.cars && this.places) {
      this.minded(w, now, clock, walks, drives);
      return;
    }
    for (const r of this.population.residents) {
      // This tick's route searching spent: the rest start from the next tick
      // on, looked at again straight away (`PATH_WORK_PER_TICK`).
      if (!pathWorkLeft()) { this.lookClock = LOOK_EVERY; break; }
      const d = this.diaries.get(r.id)!;
      if (d.day !== day) { d.day = day; d.done = 0; }
      const plan = diaryOf(r);
      while (d.done < plan.length) {
        const e = plan[d.done]!;
        if (clock < e.at) break;
        if (d.at === null) break;
        // Not where this entry starts (an outing missed, a trip given up):
        // it is skipped, never made from somewhere else.
        if (d.at !== e.from) { d.done++; continue; }
        const started = this.start(w, r, d, e, walks < MAX_WALKS, drives < MAX_DRIVES);
        if (started === 'wait') break;
        d.done++;
        if (started === 'walk') walks++;
        else if (started === 'drive') drives++;
        break;
      }
    }
  }

  /**
   * The agents' turn: every resident's needs brought up to now, and those who
   * are somewhere and due weigh where to be (`mind.ts`): where their
   * commitments send them, or what their needs want of the places open near.
   */
  private minded(w: SimWorld, now: number, clock: number, walks: number, drives: number): void {
    const places = this.places!;
    for (const r of this.population.residents) {
      const d = this.diaries.get(r.id)!;
      let mind = this.minds.get(r.id);
      if (!mind) { mind = newMind(r, now); this.minds.set(r.id, mind); }
      const doing = this.doingNow(w, r, d.at, mind, now, clock);
      live(mind, r, d.at, now, places.kindOf, doing?.offer ?? null);
      if (d.at === null || this.isHeld(r.id, now)) continue;
      const due = committedTo(r, clock);
      const owed = due !== null && d.at !== due;
      if (!owed && now - mind.decided < DECIDE_EVERY) continue;
      if (!pathWorkLeft()) { this.lookClock = LOOK_EVERY; break; }
      mind.decided = now;
      const choice = decide(mind, r, d.at, clock, places, this.rng);
      if (!choice || choice.to === d.at) continue;
      const started = this.start(w, r, d, { at: clock, from: d.at, to: choice.to }, walks < MAX_WALKS, drives < MAX_DRIVES, choice.why);
      if (started === 'walk') walks++;
      else if (started === 'drive') drives++;
      // Could not set off just now (a queue of trips): asked again soon.
      else if (started === 'wait') mind.decided = now - DECIDE_EVERY + 2;
    }
  }

  /**
   * What a resident is doing where they are, chosen afresh when the last
   * thing ends or they arrive somewhere: the furniture's ads against their
   * needs at home, their post at work, what the place is for elsewhere. The
   * piece they use is theirs until they are done (`BuildingUse.taken`).
   */
  private doingNow(w: SimWorld, r: Resident, at: BuildingId | null, mind: Mind, now: number, clock: number): Doing | null {
    if (w.doc.buildings.revision !== this.usesFor) {
      this.usesFor = w.doc.buildings.revision;
      this.uses.clear();
      this.doings.clear();
    }
    const was = this.doings.get(r.id);
    if (was && (at === null || was.building !== at || now >= was.until)) {
      if (was.piece >= 0) this.uses.get(was.building)?.taken.delete(`${was.level}:${was.piece}`);
      this.doings.delete(r.id);
    }
    if (at === null) return null;
    const kept = this.doings.get(r.id);
    if (kept) return kept;
    const b = w.doc.buildings.get(at);
    if (!b) return null;
    let use = this.uses.get(at);
    if (!use) { use = new BuildingUse(b); this.uses.set(at, use); }
    const inside = this.inside(at);
    const family = inside.filter((o) => o.id !== r.id && (o.home === r.home || at !== r.home));
    const company = { someone: family.length > 0, child: family.some((o) => o.ageClass === 'child') };
    const atWork = r.work === at && committedTo(r, clock) === at;
    // Nothing for them to do there with what it has: in, not drawn, given
    // what the place itself offers; asked again in a while.
    const doing: Doing = chooseActivity(r, mind.needs, b, use, clock, company, this.yard(w), atWork, this.rng)
      ?? { building: at, kind: 'wait', pose: 'stand', gesture: null, level: 0, piece: -1, out: null, offer: null, until: now + 30, hidden: true };
    if (doing.piece >= 0) use.taken.set(`${doing.level}:${doing.piece}`, r.id);
    this.doings.set(r.id, doing);
    return doing;
  }

  // ------------------------------------------------------------- the player's hand

  /** The resident under the player's hand, or null (`agents/player.ts`). */
  controlled: number | null = null;

  /** A resident's record, by id. */
  resident(id: number): Resident | null { return this.byResident.get(id) ?? null; }

  /**
   * Takes a resident out of their own life for the player: whatever trip they
   * were on ends where they are, nothing they were doing goes on. Returns
   * where they are and how: on foot (walking, or stepping out of the building
   * they were in), or at the wheel of their car on the road; null when they
   * cannot be found.
   */
  takeControl(w: SimWorld, resident: number): { mode: 'foot' | 'car'; x: number; y: number; heading: number; car: VehicleId | null } | null {
    const r = this.byResident.get(resident);
    const d = this.diaries.get(resident);
    if (!r || !d) return null;
    const person = OwnCars.personOf(resident);
    let out: { mode: 'foot' | 'car'; x: number; y: number; heading: number; car: VehicleId | null } | null = null;
    for (const t of [...this.trips.values()]) {
      if (t.resident !== resident) continue;
      const ct = this.cars?.trips.get(t.id);
      const bike = t.mode === 'bike' ? w.vehicles.get(t.agent as VehicleId) : undefined;
      if (bike) {
        // Off the bicycle, on foot where it was.
        const pose = vehiclePose(w, bike, 1);
        w.removeVehicle(bike);
        if (pose) {
          addPlayerWalker(w, person, pose.p.x, pose.p.y, pose.angle, r.ageClass, personGender(person));
          out = { mode: 'foot', x: pose.p.x, y: pose.p.y, heading: pose.angle, car: null };
        }
      } else if (ct && ct.phase === 'drive') {
        out = { mode: 'car', x: 0, y: 0, heading: 0, car: ct.car.id };
      } else if (ct && ct.car.body?.free && (ct.phase === 'leave' || ct.phase === 'park')) {
        // Off the road in their car (out of a bay, into one): at the wheel there.
        const f = ct.car.body.free;
        this.cars!.trips.delete(t.id);
        out = { mode: 'car', x: f.x, y: f.y, heading: f.angle, car: ct.car.id };
      } else {
        if (ct) this.cars!.trips.delete(t.id);
        const p = walkerOf(w, person);
        if (p) { takeWalker(w, person); out = { mode: 'foot', x: p.x, y: p.y, heading: p.heading, car: null }; }
      }
      if (!ct || ct.phase !== 'drive') this.trips.delete(t.id);
    }
    if (!out) {
      const at = d.at ?? r.home;
      const door = this.doors.get(at);
      if (!door) return null;
      const b = w.doc.buildings.get(at);
      const c = b ? footprintCentre(b) : door;
      const heading = Math.atan2(door.y - c.y, door.x - c.x);
      addPlayerWalker(w, person, door.x, door.y, heading, r.ageClass, personGender(person));
      out = { mode: 'foot', x: door.x, y: door.y, heading, car: null };
    }
    const doing = this.doings.get(resident);
    if (doing?.piece !== undefined && doing.piece >= 0) this.uses.get(doing.building)?.taken.delete(`${doing.level}:${doing.piece}`);
    this.doings.delete(resident);
    d.at = null;
    this.controlled = resident;
    this.moved();
    return out;
  }

  /** The player lets go of a resident: they walk home from where they are. */
  releaseControl(w: SimWorld, x: number, y: number): void {
    const resident = this.controlled;
    this.controlled = null;
    if (resident !== null) this.putOnFoot(w, resident, x, y);
  }

  /**
   * A resident on foot at a point, off any trip (out of a car taken from
   * them, let go by the player): they walk home from there.
   */
  putOnFoot(w: SimWorld, resident: number, x: number, y: number): void {
    const r = this.byResident.get(resident);
    const d = this.diaries.get(resident);
    const home = r ? this.doors.get(r.home) : undefined;
    const walk = w.pedEngine.walkTrip;
    if (!r || !d || !home || !walk) return;
    for (const t of [...this.trips.values()]) if (t.resident === resident) this.trips.delete(t.id);
    const trip: Trip = { id: this.nextTrip++, resident, to: r.home, mode: 'walk', agent: -1, started: w.clock.time, why: 'home' };
    const person = OwnCars.personOf(resident);
    const id = walk.call(w.pedEngine, w, { trip: trip.id, fromX: x, fromY: y, toX: home.x, toY: home.y,
      seed: personGender(person) === 'f' ? 1 : 0, ageClass: r.ageClass, person, reach: m(40) });
    if (id === null) { d.at = r.home; this.moved(); return; }
    trip.agent = id;
    this.trips.set(trip.id, trip);
    d.at = null;
    this.moved();
  }

  /** The public transport running, and its riders on and off (`sim/transit`). */
  readonly transit = new TransitSim();

  /** One tick of the lines; those who got on gone from the stop, those who got off walking on. */
  private ride(w: SimWorld): void {
    this.transit.step(w);
    for (const [trip, rider] of this.transit.riders) {
      if (rider.phase === 'riding' && walkerOf(w, rider.person)) removeWalker(w, rider.person);
      void trip;
    }
    const walk = w.pedEngine.walkTrip;
    for (const { trip, at } of this.transit.takeAlighted()) {
      const t = this.trips.get(trip);
      const rider = this.transit.riders.get(trip);
      const r = t ? this.byResident.get(t.resident) : undefined;
      const door = rider ? this.doors.get(rider.building) : undefined;
      if (!t || !rider || !r || !door || !walk) { if (t) this.arrive(t); this.transit.riders.delete(trip); continue; }
      const id = walk.call(w.pedEngine, w, { trip, fromX: at.x, fromY: at.y, toX: door.x, toY: door.y,
        seed: personGender(rider.person) === 'f' ? 1 : 0, ageClass: r.ageClass, person: rider.person, reach: m(60) });
      if (id === null) { this.arrive(t); this.transit.riders.delete(trip); }
    }
  }

  /** A trip ended where it is, without arriving (a car taken by the player from its driver). */
  dropTrip(id: number): void { this.trips.delete(id); }

  /** The person in the player's hands, and the police after them (`agents/player.ts`). */
  readonly player = new Player();

  /** Thieves in the streets and the police after them (`agents/crime.ts`). */
  readonly crime = new CrimeSim();
  /** Residents held where they are until a game minute (a thief at the police station). */
  private readonly held = new Map<number, number>();

  /** Holds a resident in a building for some game minutes: they make no trip till then. */
  hold(resident: number, building: BuildingId, minutes: number): void {
    const d = this.diaries.get(resident);
    if (!d) return;
    d.at = building;
    this.held.set(resident, (this.lastMinutes ?? 0) + minutes);
    this.moved();
  }

  /** Residents driving a bus now, and the line. */
  private readonly drivers = new Map<number, number>();

  /**
   * A resident to drive a bus of a line: an adult without a job, at home,
   * living nearest the point (the line's first stop); taken off their day
   * until given back. Null when nobody is free.
   */
  hireDriver(w: SimWorld, x: number, y: number, line: number): number | null {
    let best: Resident | null = null, bestD = Infinity;
    for (const r of this.population.residents) {
      if (r.ageClass !== 'adult' || r.work !== null || this.drivers.has(r.id) || this.controlled === r.id) continue;
      if (this.diaries.get(r.id)?.at !== r.home || CrimeSim.isThief(r)) continue;
      const door = this.doors.get(r.home);
      if (!door) continue;
      const d = Math.hypot(door.x - x, door.y - y);
      if (d < bestD) { best = r; bestD = d; }
    }
    if (!best || !this.borrow(best.id)) return null;
    this.drivers.set(best.id, line);
    void w;
    return best.id;
  }

  /** A bus driver off duty: home. */
  releaseDriver(resident: number): void {
    if (!this.drivers.delete(resident)) return;
    const r = this.byResident.get(resident);
    if (r) this.giveBack(resident, r.home);
  }

  /** The line a resident drives a bus of, or null. */
  drivesLine(resident: number): number | null { return this.drivers.get(resident) ?? null; }

  /** Whether a resident is held now. */
  isHeld(resident: number, now: number): boolean {
    const until = this.held.get(resident);
    if (until === undefined) return false;
    if (now < until) return true;
    this.held.delete(resident);
    return false;
  }

  /** A resident called out of where they are (a police officer sent after the player): off their life until given back. */
  borrow(resident: number): boolean {
    const d = this.diaries.get(resident);
    if (!d || d.at === null) return false;
    const doing = this.doings.get(resident);
    if (doing && doing.piece >= 0) this.uses.get(doing.building)?.taken.delete(`${doing.level}:${doing.piece}`);
    this.doings.delete(resident);
    d.at = null;
    this.moved();
    return true;
  }

  /** A resident borrowed, given back to a building (back at the station). */
  giveBack(resident: number, building: BuildingId): void {
    const d = this.diaries.get(resident);
    if (d) { d.at = building; this.moved(); }
  }

  /** A need of a resident met a little (a word with somebody, say). */
  boostNeed(resident: number, need: keyof Needs, by: number): void {
    const n = this.minds.get(resident)?.needs;
    if (n) n[need] = Math.max(0, Math.min(100, n[need] + by));
  }

  /** The residents working at buildings of a trade, who are there now. */
  atWork(fn: string): Resident[] {
    const out: Resident[] = [];
    for (const r of this.population.residents) {
      if (r.work === null) continue;
      const d = this.diaries.get(r.id);
      if (d?.at === r.work && this.kindAt(r.work) === fn) out.push(r);
    }
    return out;
  }

  private kindAt(id: BuildingId): string | undefined { return this.places?.kindOf(id); }

  /** What a resident is doing in the building they are in, for the renderer and their card. */
  doingOf(resident: number): Doing | null {
    const d = this.doings.get(resident);
    return d && !d.hidden ? d : null;
  }

  /** Every resident doing something out in their lot (the garden, the pool, the car, the front step). */
  outdoors(): { resident: Resident; doing: Doing }[] {
    const out: { resident: Resident; doing: Doing }[] = [];
    for (const [id, d] of this.doings) {
      if (!d.out) continue;
      const r = this.byResident.get(id);
      if (r) out.push({ resident: r, doing: d });
    }
    return out;
  }

  /** A few residents a resident calls on: their friends, by who they are; those who are home now. */
  private friendsIn(r: Resident): { building: BuildingId; x: number; y: number }[] {
    const all = this.population.residents;
    const out: { building: BuildingId; x: number; y: number }[] = [];
    if (all.length < 2) return out;
    for (let k = 1; k <= 4; k++) {
      const f = all[(r.seed * 31 + k * 7919) % all.length]!;
      if (f.id === r.id || f.home === r.home || f.ageClass === 'child' !== (r.ageClass === 'child')) continue;
      if (this.diaries.get(f.id)?.at !== f.home) continue;
      const door = this.doors.get(f.home);
      if (door) out.push({ building: f.home, x: door.x, y: door.y });
    }
    return out;
  }

  /** The places outside a building residents spend time in: its open ground, its front step, the car. */
  private yard(w: SimWorld): YardPlaces {
    const doors = this.doors;
    const cars = this.cars;
    const homes = this.byResident;
    return {
      on(b: Building, surface, rng) {
        const kinds = surface === 'patio' ? ['paving', 'pavers', 'tiles'] : [surface];
        const open = b.volumes.filter((v) => v.open && kinds.includes(v.open) && v.w > m(2) && v.d > m(2));
        if (open.length === 0) return null;
        const v = open[Math.floor(rng.float() * open.length)]!;
        return localToWorld(b, v.x + v.w * (0.25 + rng.float() * 0.5), v.y + v.d * (0.25 + rng.float() * 0.5));
      },
      front(id) {
        const door = doors.get(id);
        const b = w.doc.buildings.get(id);
        if (!door || !b) return null;
        const c = footprintCentre(b);
        const away = Math.atan2(door.y - c.y, door.x - c.x);
        return { x: door.x + Math.cos(away) * m(0.6), y: door.y + Math.sin(away) * m(0.6), heading: away };
      },
      car(resident) {
        const car = cars?.cars.get(resident);
        const r = homes.get(resident);
        const door = r ? doors.get(r.home) : undefined;
        const f = car?.body?.free;
        if (!car?.bay || !f || !door || car.body!.v !== 0 || cars!.tripOfCar(car.id)) return null;
        if (Math.hypot(f.x - door.x, f.y - door.y) > m(60)) return null;
        // Beside it, at the driver's door, facing it.
        const side = f.angle + Math.PI / 2;
        const half = car.archetype.width / 2 + m(0.5);
        return { x: f.x + Math.cos(side) * half, y: f.y + Math.sin(side) * half, heading: side + Math.PI };
      },
    };
  }

  /** The population, again, from the buildings as they are; nobody already somewhere is moved. */
  private rebuild(w: SimWorld): void {
    this.builtFor = w.doc.buildings.revision;
    const before = new Map<number, Diary>();
    for (const r of this.population.residents) {
      const d = this.diaries.get(r.id);
      if (d) before.set(r.seed, d);
    }
    this.population = derivePopulation(w.doc.buildings.all());
    this.diaries.clear();
    this.moved();
    this.byResident.clear();
    const day = Math.floor(this.minutes(w) / 1440);
    const clock = this.minutes(w) - day * 1440;
    for (const r of this.population.residents) {
      this.byResident.set(r.id, r);
      const kept = before.get(r.seed);
      if (kept && (kept.at === null || w.doc.buildings.has(kept.at))) {
        this.diaries.set(r.id, kept);
        continue;
      }
      // Somebody new to the city starts the day where the diary has them
      // now: at work in working hours, at home otherwise.
      const plan = diaryOf(r);
      let at: BuildingId = r.home;
      let done = 0;
      while (done < plan.length && plan[done]!.at <= clock) { at = plan[done]!.to; done++; }
      this.diaries.set(r.id, { at, day, done });
    }
    // Trips of people no longer in the city end where they are.
    const ids = new Set(this.population.residents.map((r) => r.id));
    for (const [id, t] of this.trips) if (!ids.has(t.resident)) this.trips.delete(id);
    this.kerbs.clear();
    this.accessFor = '';
  }

  /** Doors on the footway, and the kerb lane in front of each building. */
  private readAccess(w: SimWorld, key: string): void {
    this.accessFor = key;
    this.doors.clear();
    this.kerbs.clear();
    for (const [id, node] of w.sidewalks.nodes) {
      if (!id.startsWith('B:')) continue;
      const building = Number(id.split(':')[1]) as BuildingId;
      if (!this.doors.has(building)) this.doors.set(building, { x: node.at.x, y: node.at.y });
    }
    // A park, a square, a playground: no door, entered from the footway
    // nearest it.
    for (const b of w.doc.buildings.all()) {
      if (this.doors.has(b.id)) continue;
      const c = footprintCentre(b);
      let best: { x: number; y: number } | null = null;
      let bestD = m(60);
      for (const edge of w.sidewalks.edges.values()) {
        if (edge.kind !== 'walk') continue;
        const hit = edge.path.closestPoint(c);
        if (hit.distance < bestD) { bestD = hit.distance; best = edge.path.sampleAt(hit.s).p; }
      }
      if (best) this.doors.set(b.id, { x: best.x, y: best.y });
    }
    const index = placeIndex(w.doc.buildings.all(), (id) => this.doors.get(id) ?? null);
    this.places = { ...index, friends: (r) => this.friendsIn(r) };
    // The bays read again, and every car owner's car parked near where they are.
    this.cars?.rebuild(w, this.population.residents, (id) => {
      const r = this.byResident.get(id);
      const at = this.diaries.get(id)?.at ?? r?.home;
      const door = at === undefined || at === null ? undefined : this.doors.get(at);
      return at === undefined || at === null || !door ? null : { building: at, door };
    });
  }

  private kerbOf(w: SimWorld, building: BuildingId): Kerb | null {
    if (this.kerbs.has(building)) return this.kerbs.get(building)!;
    const door = this.doors.get(building);
    let best: Kerb | null = null;
    let bestD = KERB_REACH;
    if (door) {
      for (const lane of w.graph.lanelets.values()) {
        if (lane.kind !== 'link' || lane.length < 2 * LANE_END + m(6)) continue;
        if (w.rt(lane.id).ghost) continue;
        const hit = lane.centre.closestPoint(door);
        if (hit.distance >= bestD) continue;
        const at = Math.max(LANE_END + m(5), Math.min(lane.length - LANE_END, hit.s));
        const p = lane.centre.sampleAt(at).p;
        bestD = hit.distance;
        best = { lanelet: lane.id, at, x: p.x, y: p.y };
      }
    }
    this.kerbs.set(building, best);
    return best;
  }

  // ------------------------------------------------------------- trips

  private start(w: SimWorld, r: Resident, d: Diary, e: Entry, canWalk: boolean, canDrive: boolean,
    reason: TripReason = reasonOf(r, e)): 'walk' | 'drive' | 'skip' | 'wait' {
    const from = this.doors.get(e.from);
    const to = this.doors.get(e.to);
    if (!from || !to) { this.stranded++; return 'skip'; }
    const far = Math.hypot(to.x - from.x, to.y - from.y) > DRIVE_FROM;
    const cars = this.cars;
    if (cars && far && r.hasCar) {
      // An agent takes their own car, if it is near and a bay is free at the
      // other end; otherwise they walk. No car is ever made at the kerb.
      if (!canDrive) return 'wait';
      const trip: Trip = { id: this.nextTrip++, resident: r.id, to: e.to, mode: 'drive', agent: -1, started: w.clock.time, why: reason };
      if (cars.start(w, r, trip.id, e.from, from, e.to, to, reason)) {
        trip.agent = OwnCars.personOf(r.id);
        this.trips.set(trip.id, trip);
        d.at = null;
        this.moved();
        return 'drive';
      }
    }
    const kerbA = !cars && r.hasCar && far ? this.kerbOf(w, e.from) : null;
    const kerbB = kerbA ? this.kerbOf(w, e.to) : null;
    if (kerbA && kerbB && kerbA.lanelet !== kerbB.lanelet) {
      if (!canDrive) return 'wait';
      const trip: Trip = { id: this.nextTrip++, resident: r.id, to: e.to, mode: 'drive', agent: -1, started: w.clock.time, why: reason };
      const car = spawnCommuter(w, kerbA, kerbB, trip.id, this.rng);
      if (car) {
        trip.agent = car.id;
        this.trips.set(trip.id, trip);
        d.at = null;
        this.moved();
        return 'drive';
      }
      // No room at the kerb just now: try again in a moment.
      return 'wait';
    }
    // Without a car, a cyclist rides to places not too far.
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    if (cycles(r) && span > BIKE_FROM && span < BIKE_TO) {
      const kA = this.kerbOf(w, e.from);
      const kB = kA ? this.kerbOf(w, e.to) : null;
      // Never getting on or off on a level crossing.
      const clear = (k: Kerb): boolean => !this.transit.crossingNear(k.lanelet, k.at, m(14));
      if (kA && kB && kA.lanelet !== kB.lanelet && clear(kA) && clear(kB)) {
        if (!canDrive) return 'wait';
        const trip: Trip = { id: this.nextTrip++, resident: r.id, to: e.to, mode: 'bike', agent: -1, started: w.clock.time, why: reason };
        const bike = spawnCommuter(w, kA, kB, trip.id, this.rng, BICYCLE);
        if (bike) {
          trip.agent = bike.id;
          this.trips.set(trip.id, trip);
          d.at = null;
          this.moved();
          return 'drive';
        }
      }
    }
    if (!canWalk) return 'wait';
    // Far, and without a car to take: a bus, a train or the metro, if a line
    // runs from near here to near there (`sim/transit`).
    if (Math.hypot(to.x - from.x, to.y - from.y) > TRANSIT_FROM) {
      const ride = this.transit.plan(w, from, to);
      const stop = ride ? this.transit.stopAt(ride.board) : null;
      const walkTo = w.pedEngine.walkTrip;
      if (ride && stop && walkTo) {
        const trip: Trip = { id: this.nextTrip++, resident: r.id, to: e.to, mode: 'transit', agent: -1, started: w.clock.time, why: reason };
        const person = OwnCars.personOf(r.id);
        const id = walkTo.call(w.pedEngine, w, { trip: trip.id, fromX: from.x, fromY: from.y, toX: stop.x, toY: stop.y,
          seed: personGender(person) === 'f' ? 1 : 0, ageClass: r.ageClass, person, reach: m(40) });
        if (id !== null) {
          trip.agent = id;
          this.trips.set(trip.id, trip);
          this.transit.addRider({ trip: trip.id, resident: r.id, person, line: ride.line, from: ride.board, to: ride.alight,
            building: e.to, phase: 'toStop', on: null });
          d.at = null;
          this.moved();
          return 'walk';
        }
      }
    }
    const walk = w.pedEngine.walkTrip;
    if (!walk) { this.stranded++; return 'skip'; }
    const trip: Trip = { id: this.nextTrip++, resident: r.id, to: e.to, mode: 'walk', agent: -1, started: w.clock.time, why: reason };
    // An agent walks as themselves: the same body on every walk and in their car.
    const person = cars ? OwnCars.personOf(r.id) : undefined;
    const id = walk.call(w.pedEngine, w, person === undefined
      ? { trip: trip.id, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, seed: r.seed, ageClass: r.ageClass }
      : { trip: trip.id, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, seed: personGender(person) === 'f' ? 1 : 0,
        ageClass: r.ageClass, person });
    if (id === null) { this.stranded++; return 'skip'; }
    trip.agent = id;
    this.trips.set(trip.id, trip);
    d.at = null;
    this.moved();
    return 'walk';
  }

  /** Walkers in at their door; cars pulled in and parked, their drivers walking the last metres. */
  private arrivals(w: SimWorld): void {
    for (const id of w.pedEngine.takeArrivals?.(w) ?? []) {
      const t = this.trips.get(id);
      if (t && t.mode === 'transit') {
        // At the stop: they stand there waiting. From it: there.
        const r = this.byResident.get(t.resident);
        const stopped = this.transit.walkEnded(id);
        if (stopped === 'arrived') this.arrive(t);
        else if (stopped === 'waiting' && r) {
          const rider = this.transit.riders.get(id)!;
          const at = this.transit.stopAt(rider.from)!;
          const person = OwnCars.personOf(r.id);
          addPlayerWalker(w, person, at.x + ((id * 37) % 7 - 3) * m(0.5), at.y + ((id * 53) % 5 - 2) * m(0.5),
            (id % 8) * Math.PI / 4, r.ageClass, personGender(person));
          walkerAct(w, person, (id & 1) ? 'phone' : 'look', 1e6, at.x, at.y);
        }
        continue;
      }
      if (t && t.mode === 'walk') this.arrive(t);
      // A walk to or from an agent's own car: the car trip goes on.
      else if (t && this.cars) this.cars.walkEnded(id);
    }
    // Straight over the map: a trip ended here is deleted as it is passed,
    // which a Map's iteration allows; a copy of every trip each tick was garbage.
    for (const t of this.trips.values()) {
      // The agents' cars are never deleted at the kerb: `OwnCars` parks them.
      // A bicycle is: its rider gets off and walks to the door.
      if (t.mode !== 'bike' && (t.mode !== 'drive' || this.cars)) continue;
      const v = w.vehicles.get(t.agent as Vehicle['id']);
      if (!v) { this.arrive(t); continue; }
      const c = v.commute;
      if (!c || v.lanelet !== c.lanelet || v.v > 0.3 || Math.abs(c.at - v.s) > m(2.5)) continue;
      // Parked. The driver gets out on the kerb side and walks to the door.
      const lane = w.lanelet(v.lanelet)!;
      const f = lane.centre.sampleAt(Math.min(lane.length, v.s - v.archetype.length * 0.4));
      w.removeVehicle(v);
      const door = this.doors.get(t.to);
      const r = this.byResident.get(t.resident);
      const walk = w.pedEngine.walkTrip;
      // Out on the side the door is on.
      const side = door && (door.x - f.p.x) * f.n.x + (door.y - f.p.y) * f.n.y < 0 ? -1 : 1;
      const person = this.cars && r ? OwnCars.personOf(r.id) : undefined;
      const walker = door && r && walk
        ? walk.call(w.pedEngine, w, {
          trip: t.id, fromX: f.p.x + side * f.n.x * m(3.2), fromY: f.p.y + side * f.n.y * m(3.2), toX: door.x, toY: door.y,
          seed: person === undefined ? r.seed : personGender(person) === 'f' ? 1 : 0, ageClass: r.ageClass,
          ...(person === undefined ? {} : { person }),
        })
        : null;
      if (walker === null) { this.arrive(t); continue; }
      t.mode = 'walk';
      t.agent = walker;
      t.started = w.clock.time;
    }
  }

  private arrive(t: Trip): void {
    this.trips.delete(t.id);
    const d = this.diaries.get(t.resident);
    if (d) { d.at = t.to; this.moved(); }
    this.completed++;
  }

  /** A trip that has gone on far too long (a route lost to an edit) ends where it was going. */
  private giveUp(w: SimWorld): void {
    for (const t of [...this.trips.values()]) {
      if (w.clock.time - t.started < TRIP_LIMIT) continue;
      if (this.cars && t.mode === 'drive') this.cars.abandon(w, t.id);
      else if (t.mode === 'drive' || t.mode === 'bike') {
        const v = w.vehicles.get(t.agent as Vehicle['id']);
        if (v) w.removeVehicle(v);
      }
      this.arrive(t);
    }
  }
}

/** A resident as the player sees them when they click on them (`CityLife.describe`). */
export interface AgentView {
  readonly resident: number;
  readonly person: number;
  readonly ageClass: Resident['ageClass'];
  readonly home: BuildingId;
  readonly work: BuildingId | null;
  /** The building they are in; null on the way somewhere. */
  readonly at: BuildingId | null;
  /** The trip under way: on foot (`walk`), or the step of their car trip. */
  readonly trip: { readonly step: 'walk' | 'bike' | CarPhase | Rider['phase']; readonly why: TripReason; readonly to: BuildingId } | null;
  /** Their own car: parked (and in whose lot), in use, or on the road. */
  readonly car: { readonly archetype: string; readonly colour: string; readonly state: 'parked' | 'inUse' | 'driving'; readonly at: BuildingId | null } | null;
  /** Their needs, 0 desperate to 100 met (agents only). */
  readonly needs?: Readonly<Needs>;
  /** A trade shown on the card: driving a bus (and its line), or nanny in another family's home. */
  readonly job: 'busDriver' | 'nanny' | null;
  readonly line?: number;
  /** A thief (one in 25 adults, `agents/crime.ts`). */
  readonly thief: boolean;
  /** Their part in a crime now: robbing, running off, arrested, held at the station, or an officer chasing. */
  readonly crime: CrimePhase | 'held' | 'chasing' | 'patrolling' | null;
  /** What they are doing where they are (agents only): `agent.act.<kind>`. */
  readonly activity?: ActivityKind;
}

/** Why a resident is making a trip, as the player is told when they look at them. */
function reasonOf(r: Resident, e: Entry): TripReason {
  if (e.to === r.home) return 'home';
  if (e.to === r.work) return r.ageClass === 'child' ? 'school' : 'work';
  if (r.lunch && e.to === r.lunch.to) return 'lunch';
  if (r.errand && e.to === r.errand.to) return 'errand';
  return 'outing';
}

/**
 * A resident's day: the trips they make, in order. Made once a resident and
 * kept: a resident does not change, and the day was made afresh for every
 * resident twice a second.
 */
const DIARIES = new WeakMap<Resident, readonly Entry[]>();
export function diaryOf(r: Resident): readonly Entry[] {
  let day = DIARIES.get(r);
  if (!day) { day = makeDiary(r); DIARIES.set(r, day); }
  return day;
}

function makeDiary(r: Resident): Entry[] {
  const out: Entry[] = [];
  if (r.work !== null && r.work !== r.home) {
    out.push({ at: r.leaveAt, from: r.home, to: r.work });
    // Lunch out, inside the working day.
    const l = r.lunch;
    if (l && l.at > r.leaveAt + 30 && l.at + l.stay < r.leaveAt + r.stay - 30) {
      out.push({ at: l.at, from: r.work, to: l.to });
      out.push({ at: l.at + l.stay, from: l.to, to: r.work });
    }
    out.push({ at: r.leaveAt + r.stay, from: r.work, to: r.home });
  }
  // A morning errand, home and back before anything else.
  const e = r.errand;
  if (e && r.work === null && e.to !== r.home) {
    out.push({ at: e.at, from: r.home, to: e.to });
    out.push({ at: e.at + e.stay, from: e.to, to: r.home });
  }
  const o = r.outing;
  if (o && o.to !== r.home) {
    const busyUntil = r.work !== null ? r.leaveAt + r.stay + 30 : e ? e.at + e.stay + 30 : -1;
    if (o.at > busyUntil && o.at + o.stay < 24 * 60) {
      out.push({ at: o.at, from: r.home, to: o.to });
      out.push({ at: o.at + o.stay, from: o.to, to: r.home });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** A car for a resident, pulled out from the kerb in front of their door; null when there is no room. */
function spawnCommuter(w: SimWorld, from: Kerb, to: Kerb, trip: number, rng: Rng, kind?: Archetype): Vehicle | null {
  const lane = w.lanelet(from.lanelet);
  if (!lane) return null;
  const cars = ARCHETYPES.filter((a) => a.id === 'hatch' || a.id === 'sedan' || a.id === 'suv');
  const arch = kind ?? cars[Math.floor(rng.float() * cars.length)] as Archetype;
  const front = from.at;
  const rear = front - arch.length;
  // Room on the lane round the place it pulls out from.
  for (const body of w.bodiesIn(lane.id)) {
    const bFront = body.s;
    const bRear = body.s - body.vehicle.archetype.length;
    if (bFront > rear - JAM_GAP - m(6) && bRear < front + JAM_GAP + m(4)) return null;
  }
  const driver = makeDriver(arch, () => w.rng.driver.float());
  const v0 = lane.speedLimit * arch.speedFactor * w.rng.driver.range(DRIVER_NOISE.lo, DRIVER_NOISE.hi);
  const colour = arch.palette[Math.floor(rng.float() * arch.palette.length)] as string;
  const v = createVehicle(w.nextVehicleId++, arch, driver, colour, lane.id, v0, w.clock.tick);
  v.s = front;
  v.v = 0;
  v.prev = snapshot(v);
  assignOccupancy(w, v);
  // A commuter runs no errands: it goes where its driver is going.
  v.errand = null;
  v.commute = { trip, lanelet: to.lanelet, at: to.at };
  w.vehicles.set(v.id, v);
  w.enterLanelet(v, lane.id);
  v.destination = to.lanelet;
  planFrom(w, v);
  return v;
}
