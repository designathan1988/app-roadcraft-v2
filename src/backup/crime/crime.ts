import type { BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { DT } from '../params';
import type { SimWorld } from '../world';
import type { Resident } from '../city/population';
import { AGENT_PERSON_BASE } from '../people/engine';
import { OwnCars } from './cars';
import { releaseWalker, sendRunning, startle, walkerAct, walkerOf, walkersNear } from './walk';

/**
 * Crime in the streets, done by residents, and the police answering it - not
 * only the player's crimes (`player.ts`), as GTA V's police take on fights and
 * robberies between passers-by.
 *
 * A few adults of the city are thieves. Now and then, at the hours a thief
 * keeps, one leaves where they are, picks somebody walking near and follows
 * them, robs them (the victim falls), and runs for home. The reaction round
 * the robbery is the "behaviour zones" of IO Interactive's crowds (Fauerby,
 * "Crowds in Hitman: Absolution", GDC 2012): close by, a scare zone - people
 * run off (`startle`); farther, a point of interest - people stop and look.
 * The victim (and whoever saw it) calls the police: officers on duty at the
 * stations run after the thief; one who catches up arrests them, and the two
 * walk to the station, where the thief is held some hours. A thief who gets
 * home first has got away.
 */

/** One in this many adults is a thief. */
const THIEF_EVERY = 25;
/** Thieves out at once, at most. */
const AT_ONCE = 2;
/** Game minutes a thief waits after a robbery before the next. */
const REST = 180;
/** How far from their door a thief looks for somebody to follow. */
const PREY_REACH = m(220);
/** Close enough to rob. */
const ROB_REACH = m(2);
/** Scare zone and look zone round a robbery. */
const SCARE = m(25), LOOK = m(55);
/** An officer this close to the thief, for this long, arrests them. */
const ARREST_REACH = m(2.2), ARREST_TIME = 1;
/** Officers sent after a thief. */
const OFFICERS = 2;
/** A thief this long out without robbing anybody gives up; a chase this long is called off. */
const STALK_LIMIT = 150, CHASE_LIMIT = 240;
/** Game minutes a thief is held at the station. */
const HELD = 8 * 60;
/** Speeds: the thief runs, the police run a little faster. */
const FLEE = 1.8, CHASE = 3.4;
/** A thief closing on somebody walks briskly. */
const STALK = 1.6;
/** How far the thief gets from where an officer is heading before the officer's route is made again. */
const RETARGET = m(10);
/** How far from their station an officer's beat goes. */
const BEAT = m(1200);

export type CrimePhase = 'stalking' | 'fleeing' | 'arrested';

interface Crime {
  readonly thief: number;
  readonly from: BuildingId;
  phase: CrimePhase;
  victim: number | null;
  /** Seconds in this phase. */
  time: number;
  retarget: number;
  /** When the thief's run home was last sent (seconds into the phase). */
  rerun: number;
  /** Where the thief is heading for (the victim, when last seen). */
  aimX: number;
  aimY: number;
  /** Officers after them: resident, station, seconds close. */
  readonly officers: Map<number, { station: BuildingId; close: number; out: number; aimX: number; aimY: number }>;
  /** Where the arrest leads them: the station of the officer who made it. */
  station: BuildingId | null;
}

/** What the city has seen of it, for the probes and the tests. */
export interface CrimeStats {
  robberies: number;
  witnesses: number;
  lookedOn: number;
  calls: number;
  arrests: number;
  /** Thieves brought in and held at a station. */
  held: number;
  escapes: number;
  givenUp: number;
}

const hash = (n: number): number => (Math.imul(n ^ 0x5bd1e995, 0x27d4eb2d) >>> 0);

export class CrimeSim {
  private readonly crimes = new Map<number, Crime>();
  /** Game minute each thief may go out again. */
  private readonly restUntil = new Map<number, number>();
  private clock = 0;
  readonly stats: CrimeStats = { robberies: 0, witnesses: 0, lookedOn: 0, calls: 0, arrests: 0, held: 0, escapes: 0, givenUp: 0 };
  /** Officers out after a thief (so the player's police do not take them too). */
  readonly busyOfficers = new Set<number>();

  /** Whether a resident is a thief. */
  static isThief(r: Resident): boolean {
    return r.ageClass === 'adult' && hash(r.id) % THIEF_EVERY === 0;
  }

  /** The phase of a thief's crime under way, or null. */
  phaseOf(resident: number): CrimePhase | null { return this.crimes.get(resident)?.phase ?? null; }
  /** Whether an officer is out after a thief. */
  chasing(resident: number): boolean { return this.busyOfficers.has(resident); }
  /** Whether an officer is out on the beat. */
  patrolling(resident: number): boolean { return this.patrols.has(resident); }
  /** Officers on the beat now. */
  patrolCount(): number { return this.patrols.size; }

  /**
   * Officers on foot patrol: half of those on duty at a station walk the
   * streets round it, from one door to another, as a beat - so a call is
   * answered by somebody near, not only from the station.
   */
  private readonly patrols = new Map<number, { station: BuildingId; x: number; y: number; out: number }>();
  /** Thieves out now, for the probes. */
  active(): { thief: number; phase: CrimePhase; officers: number }[] {
    return [...this.crimes.values()].map((c) => ({ thief: c.thief, phase: c.phase, officers: c.officers.size }));
  }

  step(w: SimWorld): void {
    const city = w.city;
    for (const c of [...this.crimes.values()]) this.stepCrime(w, c);
    this.beat(w);
    this.clock += DT;
    if (this.clock < 1) return;
    this.clock = 0;
    const now = city.minutes(w);
    const hour = (now % 1440) / 60;
    this.sendOnPatrol(w, hour);
    if (this.crimes.size >= AT_ONCE) return;
    // Thieves keep the afternoon and the evening.
    if (hour < 13 || hour > 23) return;
    const thieves = city.population.residents.filter((r) => CrimeSim.isThief(r) && !this.crimes.has(r.id)
      && (this.restUntil.get(r.id) ?? -Infinity) <= now && city.whereIs(r.id) !== null && city.player.resident !== r.id
      && !city.isHeld(r.id, now));
    if (thieves.length === 0) return;
    const r = thieves[hash(Math.floor(now) + this.stats.robberies) % thieves.length]!;
    const at = city.whereIs(r.id)!;
    const door = city.doorOf(at);
    if (!door) return;
    const prey = this.preyNear(w, door.x, door.y, r.id);
    if (!prey) return;
    const walk = w.pedEngine.walkTrip;
    if (!walk || !city.borrow(r.id)) return;
    const person = OwnCars.personOf(r.id);
    const id = walk.call(w.pedEngine, w, { trip: -3, fromX: door.x, fromY: door.y, toX: prey.x, toY: prey.y,
      seed: 0, ageClass: 'adult', person, reach: m(60) });
    if (id === null) { city.giveBack(r.id, at); return; }
    this.crimes.set(r.id, { thief: r.id, from: at, phase: 'stalking', victim: prey.id, time: 0, retarget: 0, rerun: 0, aimX: prey.x, aimY: prey.y, officers: new Map(), station: null });
    this.restUntil.set(r.id, now + REST);
  }

  /** More officers out on the beat while half of those on duty are not; all back at night. */
  private sendOnPatrol(w: SimWorld, hour: number): void {
    const city = w.city;
    if (hour < 7 || hour > 23) {
      for (const [r, p] of this.patrols) { releaseWalker(w, OwnCars.personOf(r), city.doorOf(p.station) ?? null); city.giveBack(r, p.station); }
      this.patrols.clear();
      return;
    }
    const inStation = city.atWork('police').filter((r) => r.ageClass === 'adult');
    if (this.patrols.size >= Math.floor((inStation.length + this.patrols.size) / 2) || inStation.length === 0) return;
    const r = inStation[hash(Math.floor(w.clock.time)) % inStation.length]!;
    const station = r.work!;
    const door = city.doorOf(station);
    const to = door ? this.beatPoint(w, door.x, door.y, r.id) : null;
    const walk = w.pedEngine.walkTrip;
    if (!door || !to || !walk || !city.borrow(r.id)) return;
    const id = walk.call(w.pedEngine, w, { trip: -4, fromX: door.x, fromY: door.y, toX: to.x, toY: to.y,
      seed: 0, ageClass: 'adult', person: OwnCars.personOf(r.id), reach: m(60) });
    if (id === null) { city.giveBack(r.id, station); return; }
    this.patrols.set(r.id, { station, x: to.x, y: to.y, out: 0 });
  }

  /** A door some way from a point, within the beat round the station. */
  private beatPoint(w: SimWorld, x: number, y: number, salt: number): { x: number; y: number } | null {
    const doors: { x: number; y: number }[] = [];
    for (const b of w.doc.buildings.all()) {
      const d = w.city.doorOf(b.id);
      if (!d) continue;
      const far = Math.hypot(d.x - x, d.y - y);
      if (far > m(60) && far < BEAT) doors.push(d);
    }
    return doors.length ? doors[hash(salt + Math.floor(w.clock.time * 7)) % doors.length]! : null;
  }

  /** The officers on the beat: at the end of a stretch, on to the next door. */
  private beat(w: SimWorld): void {
    const walk = w.pedEngine.walkTrip;
    for (const [r, p] of this.patrols) {
      p.out += DT;
      const person = OwnCars.personOf(r);
      const at = walkerOf(w, person);
      if (at || p.out < 1) continue;
      // Arrived (the stretch ended): on from there.
      const station = w.city.doorOf(p.station);
      const to = station ? this.beatPoint(w, station.x, station.y, r) : null;
      const id = to && walk ? walk.call(w.pedEngine, w, { trip: -4, fromX: p.x, fromY: p.y, toX: to.x, toY: to.y,
        seed: 0, ageClass: 'adult', person, reach: m(60) }) : null;
      if (id === null || !to) { w.city.giveBack(r, p.station); this.patrols.delete(r); continue; }
      p.x = to.x; p.y = to.y; p.out = 0;
    }
  }

  /** Somebody walking near a point to follow: an adult resident, not the player, not police, not a thief. */
  private preyNear(w: SimWorld, x: number, y: number, thief: number): { id: number; x: number; y: number } | null {
    let best: { id: number; x: number; y: number } | null = null, bestD = PREY_REACH;
    for (const p of walkersNear(w, x, y, PREY_REACH)) {
      const r = p.id - AGENT_PERSON_BASE;
      if (r < 0 || r === thief || p.player || p.busy > 0) continue;
      const res = w.city.resident(r);
      if (!res || res.ageClass === 'child' || this.busyOfficers.has(r) || this.patrols.has(r) || this.crimes.has(r)) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  private stepCrime(w: SimWorld, c: Crime): void {
    const city = w.city;
    const person = OwnCars.personOf(c.thief);
    const me = walkerOf(w, person);
    c.time += DT;
    c.retarget -= DT;
    if (c.phase === 'stalking') {
      const v = c.victim === null ? null : walkerOf(w, c.victim);
      if (!me || !v || c.time > STALK_LIMIT) {
        // Lost them: back where they came from.
        this.stats.givenUp++;
        this.end(w, c, c.from, me !== null);
        return;
      }
      if (Math.hypot(v.x - me.x, v.y - me.y) < ROB_REACH) { this.rob(w, c, me, v); return; }
      if (c.retarget <= 0 && Math.hypot(c.aimX - v.x, c.aimY - v.y) > m(5)) {
        c.retarget = 1;
        c.aimX = v.x; c.aimY = v.y;
        sendRunning(w, person, { x: v.x, y: v.y }, STALK);
      }
      return;
    }
    if (c.phase === 'fleeing') {
      // Home first: got away.
      if (!me) { this.stats.escapes++; this.end(w, c, city.resident(c.thief)?.home ?? c.from, false); return; }
      if (c.time > CHASE_LIMIT) { this.stats.escapes++; this.end(w, c, city.resident(c.thief)?.home ?? c.from, true); return; }
      if (c.officers.size < OFFICERS && c.retarget <= 0) this.dispatch(w, c, me);
      if (c.retarget <= 0) {
        c.retarget = 1;
        // A route made again only when the thief has got somewhere else: made
        // every tick or two, it started the walker over at every kerb they waited at.
        for (const [r, o] of c.officers) {
          const at = walkerOf(w, OwnCars.personOf(r));
          // ...or when they are about to reach the end of the route they have (it would end their run).
          const arriving = at !== null && Math.hypot(o.aimX - at.x, o.aimY - at.y) < m(8);
          if (!arriving && Math.hypot(o.aimX - me.x, o.aimY - me.y) < RETARGET) continue;
          o.aimX = me.x; o.aimY = me.y;
          sendRunning(w, OwnCars.personOf(r), { x: me.x, y: me.y }, CHASE);
        }
        // Still running for home: a run lasts half a minute, then they would walk.
        if (c.time - c.rerun > 25) {
          c.rerun = c.time;
          const home = city.doorOf(city.resident(c.thief)?.home ?? c.from);
          if (home) sendRunning(w, person, home, FLEE);
        }
      }
      for (const [r, o] of c.officers) {
        const p = walkerOf(w, OwnCars.personOf(r));
        o.out += DT;
        // Out on the street from the next tick on; gone after that: their run ended.
        if (!p) { if (o.out > 1) { this.officerBack(w, r, o.station, false); c.officers.delete(r); } continue; }
        if (Math.hypot(p.x - me.x, p.y - me.y) < ARREST_REACH) {
          o.close += DT;
          if (o.close >= ARREST_TIME) { this.arrest(w, c, me, r, o.station); return; }
        } else o.close = 0;
      }
      return;
    }
    // Arrested: walking to the station beside the officer; held there once in.
    if (!me || c.time > CHASE_LIMIT) {
      const station = c.station!;
      city.giveBack(c.thief, station);
      city.hold(c.thief, station, HELD);
      this.stats.held++;
      for (const [r, o] of c.officers) this.officerBack(w, r, o.station, true);
      this.crimes.delete(c.thief);
    }
  }

  private rob(w: SimWorld, c: Crime, me: { x: number; y: number }, v: { id: number; x: number; y: number }): void {
    const person = OwnCars.personOf(c.thief);
    walkerAct(w, person, 'argue', 1.2, v.x, v.y);
    walkerAct(w, v.id, 'fall', 4, me.x, me.y);
    // The scare zone: they run. The look zone round it: they stop and look.
    const saw = startle(w, v.x, v.y, SCARE, 10, person).filter((id) => id !== v.id);
    let looked = 0;
    for (const p of walkersNear(w, v.x, v.y, LOOK)) {
      if (p.player || p.busy > 0 || p.id === person || p.id === v.id || saw.includes(p.id)) continue;
      walkerAct(w, p.id, 'look', 3, v.x, v.y);
      looked++;
    }
    this.stats.robberies++;
    this.stats.witnesses += saw.length;
    this.stats.lookedOn += looked;
    const victim = v.id - AGENT_PERSON_BASE;
    if (victim >= 0) w.city.boostNeed(victim, 'fun', -30);
    // Off home at a run; the victim calls the police.
    const home = w.city.doorOf(w.city.resident(c.thief)?.home ?? c.from);
    if (home) sendRunning(w, person, home, FLEE);
    c.phase = 'fleeing';
    c.time = 0;
    c.rerun = 0;
    c.retarget = 1.5;
    this.stats.calls++;
  }

  private dispatch(w: SimWorld, c: Crime, me: { x: number; y: number }): void {
    const city = w.city;
    // The nearest officer on the beat, if one is nearer than the station.
    let beat: { r: number; d: number } | null = null;
    for (const [r] of this.patrols) {
      const p = walkerOf(w, OwnCars.personOf(r));
      if (!p) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (!beat || d < beat.d) beat = { r, d };
    }
    if (beat && beat.d < m(1000)) {
      const patrol = this.patrols.get(beat.r)!;
      this.patrols.delete(beat.r);
      sendRunning(w, OwnCars.personOf(beat.r), me, CHASE);
      c.officers.set(beat.r, { station: patrol.station, close: 0, out: 2, aimX: me.x, aimY: me.y });
      this.busyOfficers.add(beat.r);
      return;
    }
    const free = city.atWork('police').filter((r) => r.ageClass === 'adult' && !this.busyOfficers.has(r.id));
    if (free.length === 0) return;
    // The nearest station's officers first.
    free.sort((a, b) => {
      const da = city.doorOf(a.work!), db = city.doorOf(b.work!);
      return (da ? Math.hypot(da.x - me.x, da.y - me.y) : Infinity) - (db ? Math.hypot(db.x - me.x, db.y - me.y) : Infinity);
    });
    const r = free[0]!;
    const station = r.work!;
    const door = city.doorOf(station);
    const walk = w.pedEngine.walkTrip;
    if (!door || !walk || !city.borrow(r.id)) return;
    const person = OwnCars.personOf(r.id);
    const id = walk.call(w.pedEngine, w, { trip: -2, fromX: door.x, fromY: door.y, toX: me.x, toY: me.y,
      seed: 0, ageClass: 'adult', person, reach: m(60) });
    if (id === null) { city.giveBack(r.id, station); return; }
    sendRunning(w, person, me, CHASE);
    c.officers.set(r.id, { station, close: 0, out: 0, aimX: me.x, aimY: me.y });
    this.busyOfficers.add(r.id);
  }

  private arrest(w: SimWorld, c: Crime, me: { x: number; y: number }, officer: number, station: BuildingId): void {
    const person = OwnCars.personOf(c.thief);
    walkerAct(w, person, 'look', 1.5, me.x, me.y);
    const door = w.city.doorOf(station);
    // The thief walks to the station at a walk (no longer running), the officer beside them; any other officer goes back.
    releaseWalker(w, person, door ?? null);
    if (door) sendRunning(w, person, door, 1);
    for (const [r, o] of [...c.officers]) {
      // The officer on the same way, at the same walk: beside them.
      if (r === officer) { releaseWalker(w, OwnCars.personOf(r), door ?? null); if (door) sendRunning(w, OwnCars.personOf(r), door, 1); continue; }
      this.officerBack(w, r, o.station, true);
      c.officers.delete(r);
    }
    c.phase = 'arrested';
    c.station = station;
    c.time = 0;
    this.stats.arrests++;
  }

  /** An officer back at their station (walking there, counted in at once, as the player's police are). */
  private officerBack(w: SimWorld, r: number, station: BuildingId, walking: boolean): void {
    if (walking) releaseWalker(w, OwnCars.personOf(r), w.city.doorOf(station) ?? null);
    w.city.giveBack(r, station);
    this.busyOfficers.delete(r);
  }

  /** A crime over without an arrest: the thief walks to `to` (home), the officers back. */
  private end(w: SimWorld, c: Crime, to: BuildingId, walking: boolean): void {
    if (walking) releaseWalker(w, OwnCars.personOf(c.thief), w.city.doorOf(to) ?? null);
    w.city.giveBack(c.thief, to);
    for (const [r, o] of c.officers) this.officerBack(w, r, o.station, true);
    this.crimes.delete(c.thief);
  }
}
