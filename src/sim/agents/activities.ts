import type { Rng } from '@core/rng';
import { interiorAt, type Furniture, type FurnitureKind } from '@world/buildings/interior';
import { localToWorld, topLevel } from '@world/buildings/geometry';
import type { Building, BuildingFunction, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import type { Resident } from '../city/population';
import type { GestureKind } from '../people/view';
import { NEEDS, type Need, type Needs, urge } from './mind';

/**
 * What a resident does inside the building they are in, and with what: The
 * Sims' objects. Every piece of furniture ADVERTISES the activities it allows
 * and what each gives back an hour (Will Wright: "the objects are
 * advertising: if you're hungry, come to me"); the resident weighs the ads
 * against their needs, attenuated by nothing but the room, and takes one of
 * the best few at random (the autonomy loop of The Sims: GMTK, "The Genius AI
 * Behind The Sims"; Wikipedia, "Utility system").
 *
 * At home: sleep in their bed, nap or watch television on the sofa, read,
 * play at the computer, cook at the stove and eat at the table, a snack from
 * the fridge, wash the dishes, have a bath, clean the floor, mend things, talk
 * with the family, look after the children, run on the treadmill; outside, in
 * their own lot: tend the garden, swim in the pool, sit out in front, wash
 * the car. At a friend's: sit and talk.
 *
 * At work it is not needs but the job: each building's trade has its posts
 * (a desk and a computer in an office, a machine in a factory, the checkout
 * and the shelves of a shop, the stove and the bar of a restaurant, the
 * reception desk, the blackboard, the ward, the altar) and somebody is
 * cleaning; the post a worker takes is theirs by their id, all day.
 *
 * Visitors do what the place is for: eat at a restaurant's tables, drink at
 * the bar, dance, shop along the shelves and pay at the checkout, queue at a
 * bank's counter or its machine, sit in the cinema, pray in the pews, run in
 * the gym, read in the library, wait in the clinic.
 *
 * The sim keeps who does what with which piece (`CityLife.doing`); the
 * renderer draws them there (`render/indoors.ts`).
 */

export const ACTIVITIES = [
  // home
  'sleep', 'nap', 'tv', 'read', 'game', 'cook', 'eat', 'snack', 'dishes', 'bath', 'clean', 'fix', 'talk',
  'childcare', 'exercise', 'garden', 'swim', 'porch', 'washCar', 'window',
  // work
  'computer', 'machine', 'checkout', 'reception', 'stock', 'serve', 'teach', 'study', 'treat', 'preach', 'guard', 'mop',
  // out
  'dine', 'drink', 'dance', 'shop', 'pay', 'bank', 'watch', 'pray', 'browse', 'wait', 'visit',
] as const;
export type ActivityKind = (typeof ACTIVITIES)[number];

/** How the body is placed for it. */
export type Pose = 'lie' | 'sit' | 'stand' | 'crouch';

interface Ad {
  readonly kind: ActivityKind;
  /** The furniture it is done at. */
  readonly at: readonly FurnitureKind[];
  readonly pose: Pose;
  /** What the hands and face are doing (`PedView.gesture`); null for none. */
  readonly gesture: GestureKind | null;
  /** Points of each need given back an hour (negative: it costs). */
  readonly offer: Partial<Needs>;
  /** Game minutes it lasts, least and most. */
  readonly minutes: readonly [number, number];
  /** Only by night (sleep) or only by day. */
  readonly when?: 'night' | 'day';
  /** Only with somebody else of the household in (talk) / a child in (childcare). */
  readonly needs?: 'company' | 'child';
  /** Not for children. */
  readonly adult?: true;
}

const HOME_ADS: readonly Ad[] = [
  { kind: 'sleep', at: ['bed', 'singleBed'], pose: 'lie', gesture: null, offer: { energy: 26 }, minutes: [180, 480], when: 'night' },
  { kind: 'nap', at: ['bed', 'singleBed', 'sofa'], pose: 'lie', gesture: null, offer: { energy: 16, fun: 2 }, minutes: [30, 90] },
  { kind: 'tv', at: ['sofa', 'armchair'], pose: 'sit', gesture: 'bench', offer: { fun: 30, energy: 3 }, minutes: [30, 120] },
  { kind: 'read', at: ['armchair', 'sofa'], pose: 'sit', gesture: 'read', offer: { fun: 16 }, minutes: [20, 60] },
  { kind: 'game', at: ['officeChair'], pose: 'sit', gesture: 'work', offer: { fun: 34 }, minutes: [30, 90] },
  { kind: 'cook', at: ['stove'], pose: 'stand', gesture: 'work', offer: { hunger: 20, fun: 4, environment: -8 }, minutes: [20, 40], adult: true },
  { kind: 'eat', at: ['chair'], pose: 'sit', gesture: 'eat', offer: { hunger: 110, social: 6 }, minutes: [20, 35] },
  { kind: 'snack', at: ['fridge'], pose: 'stand', gesture: 'eat', offer: { hunger: 70 }, minutes: [5, 12] },
  { kind: 'dishes', at: ['sink'], pose: 'stand', gesture: 'work', offer: { environment: 60 }, minutes: [10, 20], adult: true },
  { kind: 'bath', at: ['bath'], pose: 'lie', gesture: null, offer: { hygiene: 160, energy: 4 }, minutes: [15, 30] },
  { kind: 'clean', at: ['table', 'sofa', 'bed', 'wardrobe', 'counter'], pose: 'crouch', gesture: 'crouch', offer: { environment: 70 }, minutes: [20, 40], adult: true },
  { kind: 'fix', at: ['stove', 'sink', 'fridge', 'tv'], pose: 'crouch', gesture: 'crouch', offer: { environment: 40, fun: 4 }, minutes: [15, 45], adult: true },
  { kind: 'talk', at: ['sofa', 'armchair', 'chair'], pose: 'sit', gesture: 'talk', offer: { social: 55, fun: 8 }, minutes: [20, 60], needs: 'company' },
  { kind: 'childcare', at: ['sofa', 'armchair', 'bed', 'singleBed'], pose: 'crouch', gesture: 'crouch', offer: { social: 30, fun: 6 }, minutes: [20, 40], needs: 'child', adult: true },
  { kind: 'exercise', at: ['treadmill'], pose: 'stand', gesture: 'dance', offer: { fun: 20, energy: -12, hygiene: -15 }, minutes: [20, 40] },
];

/** Outside, in the resident's own lot: on what ground (`Volume.open`), or by their car. */
interface YardAd {
  readonly kind: ActivityKind;
  readonly on: 'grass' | 'water' | 'patio' | 'front' | 'car';
  readonly pose: Pose;
  readonly gesture: GestureKind | null;
  readonly offer: Partial<Needs>;
  readonly minutes: readonly [number, number];
  readonly adult?: true;
}
const YARD_ADS: readonly YardAd[] = [
  { kind: 'garden', on: 'grass', pose: 'crouch', gesture: 'crouch', offer: { environment: 60, fun: 10 }, minutes: [20, 50], adult: true },
  { kind: 'swim', on: 'water', pose: 'lie', gesture: null, offer: { fun: 45, energy: -8, hygiene: 10 }, minutes: [20, 45] },
  { kind: 'porch', on: 'patio', pose: 'sit', gesture: 'bench', offer: { fun: 12, social: 10 }, minutes: [15, 45] },
  { kind: 'porch', on: 'front', pose: 'stand', gesture: 'look', offer: { fun: 10, social: 8 }, minutes: [10, 30] },
  { kind: 'washCar', on: 'car', pose: 'stand', gesture: 'work', offer: { environment: 45, fun: 6 }, minutes: [20, 40], adult: true },
];

/** A post at work: what is done, at what. */
interface Post {
  readonly kind: ActivityKind;
  readonly at: readonly FurnitureKind[];
  readonly pose: Pose;
  readonly gesture: GestureKind | null;
}
const P = (kind: ActivityKind, at: readonly FurnitureKind[], pose: Pose, gesture: GestureKind | null): Post => ({ kind, at, pose, gesture });
const DESK = P('computer', ['officeChair'], 'sit', 'work');
const RECEPTION = P('reception', ['counter', 'checkout'], 'stand', 'talk');
const CHECKOUT = P('checkout', ['checkout', 'counter'], 'stand', 'work');
const STOCK = P('stock', ['shelf', 'rack', 'pallet'], 'stand', 'work');
const COOK = P('cook', ['stove'], 'stand', 'work');
const SERVE = P('serve', ['barCounter', 'counter'], 'stand', 'talk');
const MACHINE = P('machine', ['machine'], 'stand', 'work');
const LOAD = P('stock', ['pallet', 'rack'], 'crouch', 'crouch');
const MOP = P('mop', ['table', 'desk', 'counter', 'shelf', 'seat', 'pew'], 'crouch', 'crouch');
const GUARD = P('guard', ['counter', 'bars', 'locker'], 'stand', 'look');
/** The posts of each trade; a worker takes `posts[id % posts.length]`. */
const POSTS: Partial<Record<BuildingFunction, readonly Post[]>> = {
  office: [DESK, DESK, DESK, RECEPTION, MOP],
  cityHall: [DESK, DESK, RECEPTION, GUARD, MOP],
  council: [DESK, RECEPTION, DESK, MOP],
  courthouse: [DESK, RECEPTION, GUARD],
  postOffice: [RECEPTION, RECEPTION, STOCK, DESK],
  police: [DESK, DESK, GUARD, RECEPTION],
  fireStation: [DESK, P('exercise', ['treadmill'], 'stand', 'dance'), GUARD],
  hospital: [P('treat', ['wardBed'], 'stand', 'work'), DESK, RECEPTION, MOP],
  clinic: [P('treat', ['wardBed'], 'stand', 'work'), RECEPTION, DESK],
  school: [P('teach', ['blackboard'], 'stand', 'talk'), DESK, MOP],
  university: [P('teach', ['blackboard'], 'stand', 'talk'), DESK, DESK],
  library: [RECEPTION, STOCK, DESK],
  museum: [GUARD, RECEPTION, MOP],
  prison: [GUARD, GUARD, DESK],
  church: [P('preach', ['altar'], 'stand', 'talk'), MOP],
  busStation: [RECEPTION, DESK, MOP],
  shop: [CHECKOUT, STOCK, RECEPTION],
  supermarket: [CHECKOUT, CHECKOUT, STOCK, STOCK, MOP],
  mall: [CHECKOUT, STOCK, RECEPTION, MOP],
  bank: [RECEPTION, RECEPTION, DESK, GUARD],
  pharmacy: [CHECKOUT, STOCK],
  bakery: [COOK, CHECKOUT],
  restaurant: [COOK, COOK, SERVE, SERVE, MOP],
  snackBar: [COOK, SERVE],
  bar: [SERVE, SERVE, MOP],
  nightclub: [SERVE, GUARD, P('dance', ['stage'], 'stand', 'dance')],
  cinema: [RECEPTION, MOP],
  hotel: [RECEPTION, MOP, P('clean', ['bed', 'singleBed'], 'crouch', 'crouch')],
  gym: [RECEPTION, P('exercise', ['treadmill'], 'stand', 'talk')],
  club: [SERVE, RECEPTION],
  gasStation: [CHECKOUT, STOCK],
  factory: [MACHINE, MACHINE, MACHINE, LOAD, DESK],
  warehouse: [LOAD, LOAD, STOCK, DESK],
};
/** Pupils at school sit at the desks and study. */
const STUDY = P('study', ['chair', 'seat', 'officeChair'], 'sit', 'read');

/** What a visitor does at a place: the first of these that the place has the furniture for. */
const VISITS: Partial<Record<BuildingFunction, readonly Post[]>> = {
  restaurant: [P('dine', ['chair'], 'sit', 'eat')],
  snackBar: [P('dine', ['chair', 'seat'], 'sit', 'eat'), P('pay', ['counter'], 'stand', 'talk')],
  bakery: [P('pay', ['counter', 'checkout'], 'stand', 'talk'), P('dine', ['chair'], 'sit', 'eat')],
  bar: [P('drink', ['barCounter', 'table'], 'stand', 'drink')],
  club: [P('drink', ['barCounter', 'table'], 'stand', 'drink')],
  nightclub: [P('dance', ['stage'], 'stand', 'dance'), P('drink', ['barCounter'], 'stand', 'drink')],
  supermarket: [P('shop', ['shelf', 'rack'], 'stand', 'trolley'), P('pay', ['checkout'], 'stand', 'bag')],
  shop: [P('shop', ['shelf', 'rack'], 'stand', 'look'), P('pay', ['checkout', 'counter'], 'stand', 'bag')],
  mall: [P('shop', ['shelf', 'rack'], 'stand', 'look'), P('pay', ['checkout', 'counter'], 'stand', 'bag')],
  pharmacy: [P('shop', ['shelf'], 'stand', 'look'), P('pay', ['checkout', 'counter'], 'stand', 'bag')],
  gasStation: [P('pay', ['checkout', 'counter'], 'stand', 'bag')],
  bank: [P('bank', ['atm'], 'stand', 'work'), P('bank', ['counter'], 'stand', 'talk')],
  postOffice: [P('bank', ['counter'], 'stand', 'talk')],
  council: [P('bank', ['counter'], 'stand', 'talk')],
  cityHall: [P('bank', ['counter'], 'stand', 'talk')],
  courthouse: [P('wait', ['seat', 'pew', 'chair'], 'sit', 'phone')],
  cinema: [P('watch', ['seat'], 'sit', 'bench')],
  church: [P('pray', ['pew'], 'sit', 'bench')],
  gym: [P('exercise', ['treadmill'], 'stand', 'dance')],
  library: [P('browse', ['bookshelf', 'shelf'], 'stand', 'read'), P('study', ['chair', 'officeChair'], 'sit', 'read')],
  museum: [P('browse', ['screen', 'shelf', 'bookshelf'], 'stand', 'look')],
  clinic: [P('wait', ['seat', 'chair'], 'sit', 'phone')],
  hospital: [P('wait', ['seat', 'chair', 'wardBed'], 'sit', 'phone')],
  hotel: [P('wait', ['sofa', 'armchair', 'seat'], 'sit', 'phone')],
  busStation: [P('wait', ['seat', 'chair'], 'sit', 'phone')],
};
/** At a friend's home: sit and talk. */
const VISIT_FRIEND = P('visit', ['sofa', 'armchair', 'chair'], 'sit', 'talk');

/** Where somebody is in a building, and doing what, until when. */
export interface Doing {
  readonly building: BuildingId;
  readonly kind: ActivityKind;
  readonly pose: Pose;
  readonly gesture: GestureKind | null;
  /** Indoors: the floor and the piece of furniture (its index on that floor). */
  readonly level: number;
  readonly piece: number;
  /** Outdoors, in the lot: the world point and the way they face; null indoors. */
  readonly out: { readonly x: number; readonly y: number; readonly heading: number } | null;
  /** What it gives back an hour (a job: a little company); null: what the place itself offers (a visitor's meal, film, errand). */
  readonly offer: Partial<Needs> | null;
  /** Game minutes it ends. */
  readonly until: number;
  /** In, with nothing there for them: not drawn. */
  readonly hidden?: true;
}

/** What a building offers its people: its furniture floor by floor, and which pieces are taken. */
export class BuildingUse {
  private readonly floors = new Map<number, readonly Furniture[]>();
  /** `level:piece` taken, by whom. */
  readonly taken = new Map<string, number>();
  constructor(readonly building: Building) {}

  furniture(level: number): readonly Furniture[] {
    let f = this.floors.get(level);
    if (!f) { f = interiorAt(this.building, level).furniture as Furniture[]; this.floors.set(level, f); }
    return f;
  }

  /** Free pieces of these kinds on a floor, inside `area` when given (a flat). */
  free(level: number, kinds: readonly FurnitureKind[], area: Area | null, who: number): number[] {
    const out: number[] = [];
    const list = this.furniture(level);
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!;
      if (!kinds.includes(f.kind)) continue;
      const by = this.taken.get(`${level}:${i}`);
      if (by !== undefined && by !== who) continue;
      if (area && (f.x < area.x - 1 || f.x > area.x + area.w + 1 || f.y < area.y - 1 || f.y > area.y + area.d + 1)) continue;
      out.push(i);
    }
    return out;
  }

  /** Whether the floor (or the flat) has one of these at all. */
  has(level: number, kind: FurnitureKind, area: Area | null): boolean {
    return this.furniture(level).some((f) => f.kind === kind && (!area ||
      (f.x >= area.x - 1 && f.x <= area.x + area.w + 1 && f.y >= area.y - 1 && f.y <= area.y + area.d + 1)));
  }
}
interface Area { readonly x: number; readonly y: number; readonly w: number; readonly d: number }

/** Who else is in, for the activities done together. */
export interface Company {
  /** Another member of the household (or a guest) is in. */
  readonly someone: boolean;
  /** A child of the household is in. */
  readonly child: boolean;
}

const minutesOf = (range: readonly [number, number], rng: Rng): number => range[0] + rng.float() * (range[1] - range[0]);
const isNight = (clock: number): boolean => clock >= 22 * 60 || clock < 6 * 60;
/** The pull of one's bed at night, whatever else is wanted. */
const NIGHT_SLEEP = 60;
const TOP = 3;

/** How much an activity is worth to a resident now: its offers weighed by their needs. */
function worth(offer: Partial<Needs>, needs: Needs): number {
  let s = 0;
  for (const n of NEEDS) s += (offer[n] ?? 0) * urge(n as Need, needs[n]);
  return s;
}

/** One of the best few, weighted by worth: a Sim's autonomy draw. */
function draw<T extends { score: number }>(list: T[], rng: Rng): T | null {
  list.sort((a, b) => b.score - a.score);
  const best = list.slice(0, TOP).filter((e) => e.score > 0);
  if (best.length === 0) return null;
  const total = best.reduce((s, e) => s + e.score, 0);
  let pick = rng.float() * total;
  for (const e of best) { pick -= e.score; if (pick <= 0) return e; }
  return best[0]!;
}

/** The world point beside a lot's open ground, or by the front door, or by the car. */
export interface YardPlaces {
  /** A point on open ground of this surface in the building's lot, or null. */
  on(building: Building, surface: 'grass' | 'water' | 'patio', rng: Rng): { x: number; y: number } | null;
  /** Just outside the front door, facing out; null without one. */
  front(building: BuildingId): { x: number; y: number; heading: number } | null;
  /** Beside the resident's own car parked near home; null when it is not there. */
  car(resident: number): { x: number; y: number; heading: number } | null;
}

/**
 * What a resident in `b` does next. At home and at a friend's, by their needs
 * and the furniture's ads; at work, their post; elsewhere, what the place is
 * for. Null when nothing there suits them (no furniture for it): they are in,
 * not drawn.
 */
export function chooseActivity(r: Resident, needs: Needs, b: Building, use: BuildingUse, clock: number,
  company: Company, yard: YardPlaces, atWork: boolean, rng: Rng): Doing | null {
  const night = isNight(clock);
  const child = r.ageClass === 'child';
  if (b.id === r.home) {
    // A house or a townhouse is one family's, every floor of it (the
    // bedrooms upstairs); a flat is its own floor and its own rooms.
    const whole = b.function === 'house' || b.function === 'townhouse' || r.homeSpace === null;
    const area = whole ? null : r.homeSpace;
    const levels = whole ? [r.homeLevel, ...Array.from({ length: topLevel(b) }, (_, i) => i).filter((l) => l !== r.homeLevel)] : [r.homeLevel];
    type Option = { score: number; make: () => Doing | null };
    const options: Option[] = [];
    for (const ad of HOME_ADS) {
      if (ad.adult && child) continue;
      if (ad.when === 'night' && !night && needs.energy > 25) continue;
      if (ad.needs === 'company' && !company.someone) continue;
      if (ad.needs === 'child' && !company.child) continue;
      if (ad.kind === 'tv' && !levels.some((l) => use.has(l, 'tv', area))) continue;
      // Asleep at night above all, tired or not (the body's clock); the night's
      // other doings only for a pressing need (a snack, a bath).
      const offer = ad.kind === 'sleep' && night ? { energy: (ad.offer.energy ?? 0) * 1.6 } : ad.offer;
      const score = ad.kind === 'sleep' && night ? NIGHT_SLEEP + worth(offer, needs)
        : worth(offer, needs) * (night ? 0.1 : 1);
      if (score <= 0) continue;
      const free = levels.flatMap((l) => use.free(l, ad.at, area, r.id).map((piece) => ({ level: l, piece })));
      if (free.length === 0) continue;
      // Their own bed: the same piece every night.
      const at = free[(ad.kind === 'sleep' ? r.id : Math.floor(rng.float() * 1e6)) % free.length]!;
      options.push({ score, make: () => indoor(b.id, ad, at.level, at.piece, offer, clock + minutesOf(ad.minutes, rng)) });
    }
    if (!night) {
      for (const ad of YARD_ADS) {
        if (ad.adult && child) continue;
        const score = worth(ad.offer, needs) * 0.8;
        if (score <= 0) continue;
        const spot = ad.on === 'front' ? yard.front(b.id) : ad.on === 'car' ? yard.car(r.id)
          : (() => { const p = yard.on(b, ad.on, rng); return p ? { ...p, heading: rng.float() * Math.PI * 2 } : null; })();
        if (!spot) continue;
        options.push({ score, make: () => ({ building: b.id, kind: ad.kind, pose: ad.pose, gesture: ad.gesture, level: 0, piece: -1,
          out: spot, offer: ad.offer, until: clock + minutesOf(ad.minutes, rng) }) });
      }
    }
    return draw(options, rng)?.make() ?? null;
  }
  const fn = b.function;
  if (atWork) {
    const posts = child ? [STUDY] : fn ? POSTS[fn] ?? [DESK] : [DESK];
    // Their post, by who they are; the next one along if theirs has no furniture.
    for (let k = 0; k < posts.length; k++) {
      const post = posts[(r.id + k) % posts.length]!;
      const level = r.workLevel;
      const free = use.free(level, post.at, null, r.id);
      if (free.length === 0) continue;
      const piece = free[r.id % free.length]!;
      return indoor(b.id, post, level, piece, { social: 10, fun: 3 }, clock + 60);
    }
    return null;
  }
  // A guest at somebody's home.
  if (fn === 'house' || fn === 'townhouse' || fn === 'apartments' || fn === 'residentialTower') {
    for (const level of [0, 1, 2]) {
      const free = use.free(level, VISIT_FRIEND.at, null, r.id);
      if (free.length) return indoor(b.id, VISIT_FRIEND, level, free[Math.floor(rng.float() * free.length)]!, { social: 50, fun: 15 }, clock + 45);
    }
    return null;
  }
  const visits = fn ? VISITS[fn] : undefined;
  if (!visits) return null;
  // The visit in order: the shelves first, then the checkout.
  for (const v of visits) {
    const free = use.free(0, v.at, null, r.id);
    if (free.length === 0) continue;
    const piece = free[Math.floor(rng.float() * free.length)]!;
    const minutes = v.kind === 'pay' || v.kind === 'bank' ? 8 + rng.float() * 8 : 20 + rng.float() * 40;
    return indoor(b.id, v, 0, piece, null, clock + minutes);
  }
  return null;
}

function indoor(building: BuildingId, ad: { kind: ActivityKind; pose: Pose; gesture: GestureKind | null }, level: number, piece: number,
  offer: Partial<Needs> | null, until: number): Doing {
  return { building, kind: ad.kind, pose: ad.pose, gesture: ad.gesture, level, piece, out: null, offer, until };
}

/**
 * Where a body stands, sits or lies at a piece of furniture for a pose, in
 * world axes: in front of it facing it, on the seat facing out, along the bed
 * (or the bath) on its side, crouched at its front.
 */
export function placeAt(b: Building, f: Furniture, pose: Pose): { x: number; y: number; heading: number; rise: number; lean: number } {
  const c = Math.cos(b.rotation), s = Math.sin(b.rotation);
  const worldHeading = (dx: number, dy: number): number => Math.atan2(dx * s + dy * c, dx * c - dy * s);
  // The piece's front, in the building's frame (angle 0 faces -y).
  const fx = Math.sin(f.angle), fy = -Math.cos(f.angle);
  if (pose === 'lie') {
    const out = f.d / 2 - m(0.15);
    const p = localToWorld(b, f.x + fx * out, f.y + fy * out);
    return { x: p.x, y: p.y, heading: worldHeading(-fx, -fy) - Math.PI / 2, rise: f.h * 0.95 + m(0.12), lean: Math.PI / 2 };
  }
  if (pose === 'sit') {
    const ahead = f.d / 2 + m(0.12);
    const p = localToWorld(b, f.x + fx * ahead, f.y + fy * ahead);
    return { x: p.x, y: p.y, heading: worldHeading(fx, fy), rise: 0, lean: 0 };
  }
  const away = f.d / 2 + (pose === 'crouch' ? m(0.35) : m(0.45));
  const p = localToWorld(b, f.x + fx * away, f.y + fy * away);
  return { x: p.x, y: p.y, heading: worldHeading(-fx, -fy), rise: 0, lean: 0 };
}

/** The activities that keep a home: what a family's environment need is met by. */
export const CHORES: ReadonlySet<ActivityKind> = new Set(['dishes', 'clean', 'fix', 'garden', 'washCar']);
