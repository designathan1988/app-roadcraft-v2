import { Rng } from '@core/rng';
import type { Building, BuildingFunction, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import type { Resident } from '../city/population';

/**
 * What a resident wants, and where they go for it: The Sims inside SimCity.
 *
 * Every resident has needs that run down as the hours pass - hunger, energy,
 * fun, company, hygiene, from 100 (wanting nothing) to 0 (desperate). Places
 * ADVERTISE what they give back, an hour at a time: a home lets you sleep, eat
 * and wash; a restaurant feeds you; a bar gives company and some fun; a park,
 * fun and a little company. The intelligence is in the places, not in the
 * person, as in The Sims (the objects broadcast their offers and the Sim
 * weighs them; GMTK, "The Genius AI Behind The Sims"; Game AI Pro ch. 9,
 * "An Introduction to Utility Theory"):
 *
 *   score(place) = sum over needs of  offer(need) x urge(need)
 *                  x attenuation(distance)
 *
 * The urge of a bodily need (hunger, energy, hygiene) rises steeply as it runs
 * low and is near nothing while it is met; company and fun pull more evenly.
 * Of the best few places the resident picks one at random, weighted by score,
 * so a city of people with the same needs is not one queue at one door.
 *
 * Commitments stand above all this: an adult with a job is at work in working
 * hours, a child at school (`Resident.leaveAt`/`stay`), stepping out only to
 * eat near work when hungry. Outside them, needs decide.
 */

export const NEEDS = ['hunger', 'energy', 'fun', 'social', 'hygiene'] as const;
export type Need = (typeof NEEDS)[number];
export type Needs = Record<Need, number>;

/** How fast each need runs down, points per game hour, while it is not being met. */
const DECAY: Readonly<Needs> = { hunger: 6, energy: 4.5, fun: 5, social: 4, hygiene: 3 };

/** What a kind of place gives back, points per game hour spent there. */
type Offer = Partial<Needs>;
/** Opening hours, minutes after midnight; `to` past 1440 runs into the next day. */
interface Hours { readonly from: number; readonly to: number }

interface Kind {
  readonly offer: Offer;
  readonly hours: Hours;
}

const DAY: Hours = { from: 7 * 60, to: 20 * 60 };
const MEALS: Hours = { from: 7 * 60, to: 23 * 60 };
const NIGHT: Hours = { from: 18 * 60, to: 26 * 60 };
const ALWAYS: Hours = { from: 0, to: 1440 };

/** The places residents go to on their own account, by what they are. */
const KINDS: Partial<Record<BuildingFunction, Kind>> = {
  restaurant: { offer: { hunger: 70, social: 12 }, hours: { from: 11 * 60, to: 23 * 60 } },
  snackBar: { offer: { hunger: 60, social: 6 }, hours: MEALS },
  bakery: { offer: { hunger: 55 }, hours: { from: 6 * 60, to: 20 * 60 } },
  supermarket: { offer: { hunger: 25 }, hours: DAY },
  mall: { offer: { fun: 22, hunger: 25, social: 8 }, hours: { from: 10 * 60, to: 22 * 60 } },
  shop: { offer: { fun: 12 }, hours: DAY },
  bar: { offer: { social: 35, fun: 15, hunger: 15 }, hours: { from: 16 * 60, to: 26 * 60 } },
  nightclub: { offer: { fun: 40, social: 35 }, hours: { from: 22 * 60, to: 29 * 60 } },
  cinema: { offer: { fun: 45, social: 8 }, hours: { from: 14 * 60, to: 24 * 60 } },
  gym: { offer: { fun: 25, hygiene: -10 }, hours: { from: 6 * 60, to: 22 * 60 } },
  club: { offer: { fun: 25, social: 25 }, hours: NIGHT },
  sportsCourt: { offer: { fun: 30, social: 12 }, hours: { from: 7 * 60, to: 22 * 60 } },
  park: { offer: { fun: 25, social: 10 }, hours: { from: 6 * 60, to: 22 * 60 } },
  square: { offer: { fun: 15, social: 15 }, hours: ALWAYS },
  playground: { offer: { fun: 35, social: 10 }, hours: { from: 8 * 60, to: 20 * 60 } },
  church: { offer: { social: 20, fun: 6 }, hours: { from: 7 * 60, to: 21 * 60 } },
  library: { offer: { fun: 18 }, hours: { from: 9 * 60, to: 19 * 60 } },
  museum: { offer: { fun: 30 }, hours: { from: 10 * 60, to: 18 * 60 } },
};

/** Home: sleep (at night, or when worn out), eat, wash, a little company. */
const HOME: Offer = { energy: 22, hunger: 45, hygiene: 60, social: 6, fun: 4 };
/** Work and school: company and a little to do, nothing else. */
const WORK: Offer = { social: 10, fun: 3 };

/** How far a place's pull halves, metres of straight line from where the resident is. */
const ATTENUATION = m(600);
/** Places farther than this are not considered. */
const REACH = m(2_500);
/** Nearest places of one kind looked at from a building. */
const PER_KIND = 2;
/** Game minutes between two decisions of a resident who is free. */
export const DECIDE_EVERY = 30;
/** Staying where one is is worth this much more than an equal place elsewhere: no flitting. */
const STAY_BONUS = 1.35;
/** Below this nothing is worth a trip: the resident stays where they are. */
const WORTH_A_TRIP = 6;
/** Of the best choices, how many are drawn from. */
const TOP = 3;
/** Hunger under which somebody at work goes out to eat, and the hours a lunch may be taken. */
const LUNCH_HUNGER = 40;
const LUNCH: Hours = { from: 11 * 60 + 30, to: 14 * 60 + 30 };
/** The night: a home's sleep counts double, and nobody stays out without a reason. */
const NIGHT_FROM = 22 * 60, NIGHT_TO = 6 * 60;

/** One resident's mind: their needs now, and when they last weighed where to be. */
export interface Mind {
  readonly needs: Needs;
  /** Game minutes of the last decision. */
  decided: number;
  /** Game minutes the needs were last brought up to date. */
  updated: number;
}

/** A place a resident may go: its building, where it is, what it gives. */
export interface Place {
  readonly building: BuildingId;
  readonly x: number;
  readonly y: number;
  readonly kind: BuildingFunction;
}

const isOpen = (hours: Hours, clock: number): boolean => {
  const t = clock < hours.from && hours.to > 1440 ? clock + 1440 : clock;
  return t >= hours.from && t < hours.to;
};
const inside = (h: Hours, clock: number): boolean => isOpen(h, clock);
const isNight = (clock: number): boolean => clock >= NIGHT_FROM || clock < NIGHT_TO;

/** The pull of a need as it runs low: steep for the body's needs, even for the rest. */
function urge(need: Need, level: number): number {
  const lack = Math.max(0, Math.min(1, (100 - level) / 100));
  return need === 'fun' || need === 'social' ? lack : lack * lack * 1.6;
}

/** A starting mind for a resident: needs spread so the city does not all get hungry at once. */
export function newMind(r: Resident, clock: number): Mind {
  const rng = new Rng(r.seed ^ 0x6e65);
  const needs = {} as Needs;
  for (const n of NEEDS) needs[n] = 55 + rng.float() * 40;
  return { needs, decided: clock - rng.float() * DECIDE_EVERY, updated: clock };
}

/** What a resident gets back an hour where they are now. */
function offerAt(r: Resident, at: BuildingId, kindOf: (id: BuildingId) => BuildingFunction | undefined, clock: number): Offer {
  if (at === r.home) {
    // Sleep: at night, or worn out.
    const offer = { ...HOME };
    offer.energy = (HOME.energy ?? 0) * (isNight(clock) ? 2 : 1);
    return offer;
  }
  if (at === r.work) return WORK;
  const kind = kindOf(at);
  return (kind && KINDS[kind]?.offer) ?? {};
}

/**
 * Brings a mind's needs up to `clock` (game minutes): they run down, and the
 * place the resident is in gives back what it offers. On the way somewhere
 * (`at` null) they only run down.
 */
export function live(mind: Mind, r: Resident, at: BuildingId | null, clock: number,
  kindOf: (id: BuildingId) => BuildingFunction | undefined): void {
  const hours = Math.max(0, clock - mind.updated) / 60;
  mind.updated = clock;
  if (hours <= 0) return;
  const offer = at === null ? {} : offerAt(r, at, kindOf, clock);
  for (const n of NEEDS) {
    const asleep = n === 'energy' && at === r.home && isNight(clock);
    const down = asleep ? 0 : DECAY[n];
    const up = offer[n] ?? 0;
    mind.needs[n] = Math.max(0, Math.min(100, mind.needs[n] + (up - down) * hours));
  }
}

/** Where a resident has to be now, by their commitments, or null when they are free. */
export function committedTo(r: Resident, clock: number): BuildingId | null {
  if (r.work === null || r.work === r.home) return null;
  return clock >= r.leaveAt && clock < r.leaveAt + r.stay ? r.work : null;
}

/** The candidates' value: the places worth weighing from where a resident is. */
export interface PlaceIndex {
  /** The nearest few places of every kind to a building, open or not. */
  near(from: BuildingId): readonly Place[];
  kindOf(id: BuildingId): BuildingFunction | undefined;
  position(id: BuildingId): { readonly x: number; readonly y: number } | null;
}

/** Indexes the city's places by kind, and their nearest few from every building. */
export function placeIndex(buildings: Iterable<Building>, doorOf: (id: BuildingId) => { x: number; y: number } | null): PlaceIndex {
  const all = [...buildings];
  const places: Place[] = [];
  for (const b of all) {
    if (!b.function || !KINDS[b.function]) continue;
    const door = doorOf(b.id) ?? { x: b.x, y: b.y };
    places.push({ building: b.id, x: door.x, y: door.y, kind: b.function });
  }
  const byKind = new Map<BuildingFunction, Place[]>();
  for (const p of places) {
    const list = byKind.get(p.kind);
    if (list) list.push(p); else byKind.set(p.kind, [p]);
  }
  const kinds = new Map(all.map((b) => [b.id, b.function]));
  const positions = new Map(all.map((b) => [b.id, doorOf(b.id) ?? { x: b.x, y: b.y }]));
  const cache = new Map<BuildingId, Place[]>();
  return {
    kindOf: (id) => kinds.get(id),
    position: (id) => positions.get(id) ?? null,
    near(from) {
      const hit = cache.get(from);
      if (hit) return hit;
      const o = positions.get(from);
      const out: Place[] = [];
      if (o) {
        for (const list of byKind.values()) {
          const best = list.filter((p) => p.building !== from)
            .map((p) => ({ p, d: Math.hypot(p.x - o.x, p.y - o.y) }))
            .filter((e) => e.d <= REACH)
            .sort((a, b) => a.d - b.d).slice(0, PER_KIND);
          for (const e of best) out.push(e.p);
        }
      }
      cache.set(from, out);
      return out;
    },
  };
}

/** Why a resident decided to go where they go (`agent.why.<reason>` on their card). */
export type MindReason = 'work' | 'school' | 'home' | 'sleep' | 'lunch' | 'eat' | 'fun' | 'social' | 'wash';

export interface Choice {
  readonly to: BuildingId;
  readonly why: MindReason;
}

/**
 * Where a resident who is at `at` goes next, or null to stay. Called when
 * they are free and it is time to weigh it again (`DECIDE_EVERY`), and at once
 * when a commitment starts or ends.
 */
export function decide(mind: Mind, r: Resident, at: BuildingId, clock: number, index: PlaceIndex, rng: Rng): Choice | null {
  const due = committedTo(r, clock);
  if (due !== null) {
    if (at === due) {
      // At work: out to eat near it when hungry at lunchtime, and back.
      if (mind.needs.hunger < LUNCH_HUNGER && inside(LUNCH, clock)) {
        const food = bestOf(index.near(at).filter((p) => (KINDS[p.kind]?.offer.hunger ?? 0) >= 40 && isOpen(KINDS[p.kind]!.hours, clock)),
          index.position(at), (p) => KINDS[p.kind]!.offer.hunger ?? 0);
        if (food) return { to: food.building, why: 'lunch' };
      }
      return null;
    }
    // Out at lunch: back to work once fed.
    if (r.work !== null && at !== r.home && mind.needs.hunger < 85 && inside(LUNCH, clock) && (KINDS[index.kindOf(at) ?? 'office']?.offer.hunger ?? 0) > 0) return null;
    return { to: due, why: r.ageClass === 'child' ? 'school' : 'work' };
  }
  const here = index.position(at);
  if (!here) return null;
  type Scored = { to: BuildingId; score: number; why: MindReason };
  const scored: Scored[] = [];
  const value = (offer: Offer, stay: boolean, d: number): { score: number; why: MindReason } => {
    let score = 0, top: Need = 'fun', topScore = -Infinity;
    for (const n of NEEDS) {
      const s = (offer[n] ?? 0) * urge(n, mind.needs[n]);
      score += s;
      if (s > topScore) { topScore = s; top = n; }
    }
    score /= 1 + d / ATTENUATION;
    if (stay) score *= STAY_BONUS;
    const why: MindReason = top === 'hunger' ? 'eat' : top === 'energy' ? 'sleep' : top === 'hygiene' ? 'wash' : top;
    return { score, why };
  };
  // Home.
  const home = index.position(r.home);
  if (home) {
    const offer = offerAt(r, r.home, index.kindOf, clock);
    // At night home is where everybody ends up: the day's other places are closing.
    const night = isNight(clock) ? 3 : 1;
    const v = value(offer, at === r.home, Math.hypot(home.x - here.x, home.y - here.y));
    scored.push({ to: r.home, score: v.score * night, why: at === r.home ? v.why : 'home' });
  }
  // Where they are, if it is not home.
  if (at !== r.home) {
    const kind = index.kindOf(at);
    const k = kind ? KINDS[kind] : undefined;
    if (k && isOpen(k.hours, clock)) {
      const v = value(k.offer, true, 0);
      scored.push({ to: at, score: v.score, why: v.why });
    }
  }
  // The places near, open now. Children go out only by day and not far.
  for (const p of index.near(at)) {
    const k = KINDS[p.kind]!;
    if (!isOpen(k.hours, clock)) continue;
    if (r.ageClass === 'child' && (isNight(clock) || p.kind === 'bar' || p.kind === 'nightclub')) continue;
    const v = value(k.offer, false, Math.hypot(p.x - here.x, p.y - here.y));
    scored.push({ to: p.building, score: v.score, why: v.why });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.slice(0, TOP).filter((s) => s.score >= WORTH_A_TRIP || s.to === at);
  if (best.length === 0) return null;
  // Weighted draw among the best, as a Sim picks among its top choices.
  const total = best.reduce((sum, s) => sum + s.score, 0);
  let pick = rng.float() * total;
  let chosen = best[0]!;
  for (const s of best) { pick -= s.score; if (pick <= 0) { chosen = s; break; } }
  return chosen.to === at ? null : { to: chosen.to, why: chosen.why };
}

/** The best place by a value, attenuated by distance. */
function bestOf(places: readonly Place[], from: { x: number; y: number } | null, worth: (p: Place) => number): Place | null {
  if (!from) return null;
  let best: Place | null = null, bestScore = 0;
  for (const p of places) {
    const s = worth(p) / (1 + Math.hypot(p.x - from.x, p.y - from.y) / ATTENUATION);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return best;
}
