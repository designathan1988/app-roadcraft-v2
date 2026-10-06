import { Rng } from '@core/rng';
import { m } from '@world/units';
import type { Building } from '@world/buildings/types';
import { DT } from '../params';
import type { SimWorld } from '../world';
import { ARCHETYPES, type Archetype } from '../vehicles/archetypes';
import { makeDriver } from '../vehicles/driver';
import { createVehicle, type Vehicle } from '../vehicles/state';
import { spawnVehicleAt } from '../vehicles/spawn';
import { vehiclePose } from '../pose';
import { removeWalker, walkerOf } from '../agents/walk';
import { collectBays, type Bay } from '../agents/parking';
import type { PersonAgeClass } from '../people/view';
import { PlayWorld } from './play';

/**
 * The life of the scenery, as GTA makes it: nobody lives here. People and
 * traffic are made where the camera is about to look and taken away where it
 * no longer does, within a fixed budget, at the density the place and the hour
 * call for (GTA's `popcycle`: per kind of zone and per hour, so many people
 * and so many cars).
 *
 * - NOTHING APPEARS OR VANISHES IN VIEW (the player's rule, 2026-10-05). Made
 *   outside the view, in a ring past its edge, and removed only past a wider
 *   ring (GTA IV: born out to ~105 m, culled 70-115 m and only off camera).
 *   Zoomed out past where people are drawn, the walkers are placed round the
 *   middle of the view where nobody can see them, so a zoom into the street
 *   finds it lived in. Only a map just opened is filled in view, as a game
 *   fills its world behind the loading screen.
 * - People walk the footways with the walking engine (`agents/walk.ts`):
 *   zebras, signals, cars, each other. They go from one place to another and
 *   go in when they get there.
 * - Cars join the lanes the same way and drive the traffic engine. Parked
 *   cars (GTA's car generators) stand in the bays of the whole map, the same
 *   car in the same bay every time: never simulated, so never made or taken
 *   away in sight; the renderer draws only those in view.
 * - Zoomed out past where a person can be seen, nobody is on foot at all.
 *
 * SET BY THE COMPOSITION ROOT (`enabled`) and fed by the renderer
 * (`SimWorld.focus`): with no focus (tests, harnesses) nothing is made.
 */

/** Most people on foot at once, and cars driving, and the cars driving when zoomed out. */
export const MAX_WALKERS = 90;
export const MAX_DRIVERS = 70;
const MAX_DRIVERS_FAR = 45;
/** Seconds between two looks at the budget. */
const LOOK_EVERY = 0.25;
/** Most made in one look: the population fills over a second or two. */
const MAKE_PER_LOOK = 4;

/** What kind of place the view is on: shares of each, from the buildings round it. */
interface Mix { readonly home: number; readonly shop: number; readonly work: number; readonly civic: number }

/** How busy each kind of place is at an hour (0..1): bumps at the hours people go out (GTA's day of the popcycle). */
function busy(kind: keyof Mix, hour: number): number {
  const bump = (at: number, width: number): number => {
    const d = ((hour - at + 36) % 24) - 12;
    return Math.exp(-(d * d) / (2 * width * width));
  };
  switch (kind) {
    case 'home': return 0.12 + 0.6 * bump(8, 1.3) + 0.35 * bump(13, 3) + 0.7 * bump(18.5, 2);
    case 'shop': return 0.06 + 0.45 * bump(9, 1.5) + 0.9 * bump(13, 2.5) + 0.8 * bump(18, 2.5);
    case 'work': return 0.04 + 0.75 * bump(7.5, 1) + 0.35 * bump(12.5, 1.5) + 0.7 * bump(17.5, 1.2);
    case 'civic': return 0.05 + 0.7 * bump(11, 3) + 0.5 * bump(16, 2);
  }
}
/** People per 100 m of street at full bustle, and cars. */
const PEOPLE: Mix = { home: 2.2, shop: 6.5, work: 1.6, civic: 4 };
const CARS: Mix = { home: 1.1, shop: 2, work: 1.6, civic: 1.4 };
/** Share of the bays with a car in them. */
const PARKED = 0.62;

function kindOf(b: Building): keyof Mix {
  const fn = b.function ?? '';
  if (/house|apartment|residential|townhouse|flat/i.test(fn)) return 'home';
  if (/shop|market|mall|restaurant|cafe|bar|bakery|pharmacy|bank|hotel|cinema/i.test(fn)) return 'shop';
  if (/factory|warehouse|industrial|works|office/i.test(fn)) return 'work';
  if (fn) return 'civic';
  return b.use === 'commercial' ? 'shop' : b.use === 'industrial' ? 'work' : b.use === 'residential' ? 'home' : 'civic';
}

/** The kinds of car that stand in bays and join the traffic (buses run their lines, `sim/transit`). */
const TRAFFIC: readonly (readonly [Archetype, number])[] = ARCHETYPES
  .filter((a) => a.id !== 'bus')
  .map((a) => [a, a.id === 'truck' ? a.weight * 0.4 : a.weight] as const);
const PARKED_KINDS = ARCHETYPES.filter((a) => a.id === 'hatch' || a.id === 'sedan' || a.id === 'suv' || a.id === 'van');

export class AmbientWorld {
  /** On in the game (`main.ts`); off under test. */
  enabled = false;
  /** The cars standing in bays near the view: drawn, solid to walkers, never stepped. */
  readonly parked: Vehicle[] = [];
  /** The player in the scenery (`play.ts`, driven by `src/play.ts`). */
  readonly play = new PlayWorld();
  /** The cars the player drives and left: drawn and solid as parked ones. */
  get extra(): readonly Vehicle[] { return this.play.cars; }

  /** A parked car taken by the player: out of its bay. */
  takeParked(car: Vehicle): void {
    const i = this.parked.indexOf(car);
    if (i >= 0) this.parked.splice(i, 1);
    for (const [id, c] of this.bays) if (c === car) { this.bays.delete(id); break; }
  }

  private readonly rng = new Rng(0xa3b1e7);
  private readonly walkers = new Set<number>();
  private readonly drivers = new Set<number>();
  private readonly bays = new Map<number, Vehicle>();
  private clock = 0;
  private nextTrip = 1 << 26;
  private mixFor = '';
  private mix: Mix = { home: 1, shop: 0, work: 0, civic: 0 };
  private roadFor = '';
  private road = 0;
  private lanesFor = '';
  private lanes: { id: string; length: number; x: number; y: number }[] = [];
  private baysFor = '';
  private bayList: Bay[] = [];
  /** A map just opened: the first fill may use the view (`reset`). */
  private fresh = true;
  /** Seconds the fresh fill may still use the view. */
  private freshFor = 4;
  /** Where people are placed while too far to be drawn: round the middle of the view. */
  private static readonly UNSEEN_REACH = m(170);
  /**
   * The least radius people and cars live in round the view, metres: as GTA
   * keeps its population ~100 m round the player whatever the camera sees,
   * so a close view still has a street's worth of life round it, coming in.
   */
  private static readonly LIVE_PEOPLE = m(120);
  private static readonly LIVE_CARS = m(170);

  /** Walkers and drivers this world made, for the status bar. */
  counts(): { walkers: number; drivers: number; parked: number } {
    return { walkers: this.walkers.size, drivers: this.drivers.size, parked: this.parked.length };
  }

  /** Everything made is taken away (a new map). */
  reset(w: SimWorld): void {
    for (const id of this.walkers) removeWalker(w, id);
    for (const id of this.drivers) { const v = w.vehicles.get(id); if (v) w.removeVehicle(v); }
    this.walkers.clear();
    this.drivers.clear();
    this.bays.clear();
    this.parked.length = 0;
    this.baysFor = '';
    this.fresh = true;
    this.freshFor = 4;
  }

  step(w: SimWorld): void {
    if (!this.enabled) return;
    this.play.step(w);
    // The walks that ended: in through a door.
    const engine = w.pedEngine;
    engine.takeArrivals?.(w);
    for (const id of this.walkers) if (!walkerOf(w, id)) this.walkers.delete(id);
    for (const id of this.drivers) if (!w.vehicles.has(id)) this.drivers.delete(id);
    this.clock += DT;
    if (this.clock < LOOK_EVERY) return;
    this.clock = 0;
    const focus = w.focus;
    if (!focus) return;
    if (this.fresh) { this.freshFor -= LOOK_EVERY; if (this.freshFor <= 0) this.fresh = false; }
    const hour = (w.city.minutes(w) % 1440) / 60;
    // Drawn, people live in a ring a little wider than the view; zoomed out
    // (not drawn), round the middle of the view.
    const reach = focus.detail ? Math.max(focus.r * 1.3, AmbientWorld.LIVE_PEOPLE) : Math.min(focus.r, AmbientWorld.UNSEEN_REACH);
    const carReach = Math.max(focus.r * 1.35, AmbientWorld.LIVE_CARS);
    const mix = this.mixAround(w, focus.x, focus.y, focus.r);
    const road = this.roadAround(w, focus.x, focus.y, reach);
    const carRoad = this.roadAround(w, focus.x, focus.y, carReach);
    const density = (table: Mix): number =>
      table.home * mix.home * busy('home', hour) + table.shop * mix.shop * busy('shop', hour)
      + table.work * mix.work * busy('work', hour) + table.civic * mix.civic * busy('civic', hour);
    const wantWalkers = Math.min(MAX_WALKERS, Math.round((road / m(100)) * density(PEOPLE)));
    const wantDrivers = Math.min(focus.detail ? MAX_DRIVERS : MAX_DRIVERS_FAR,
      Math.round((carRoad / m(100)) * Math.max(0.25, density(CARS))));
    this.people(w, focus, reach, wantWalkers);
    this.traffic(w, focus, carReach, wantDrivers);
    this.parking(w);
  }

  // ------------------------------------------------------------ on foot

  private people(w: SimWorld, focus: NonNullable<SimWorld['focus']>, reach: number, want: number): void {
    // Drawn (`detail`), the view is the circle of radius `focus.r`: nobody is
    // made or taken away inside it. Not drawn, nothing is seen: they are kept
    // round the middle, `reach`, made and taken away anywhere.
    const seen = focus.detail;
    const far = reach * 1.15;
    for (const id of [...this.walkers]) {
      const at = walkerOf(w, id);
      if (!at) { this.walkers.delete(id); continue; }
      const d = Math.hypot(at.x - focus.x, at.y - focus.y);
      if (d > far || (this.walkers.size > want && (!seen || d > focus.r * 1.05))) {
        removeWalker(w, id);
        this.walkers.delete(id);
      }
    }
    const engine = w.pedEngine;
    if (!engine.walkTrip || !engine.walkableNear) return;
    const anywhere = !seen || this.fresh;
    for (let made = 0; made < MAKE_PER_LOOK * (anywhere ? 4 : 1) && this.walkers.size < want; made++) {
      const a = this.rng.float() * Math.PI * 2;
      const d = anywhere ? reach * Math.sqrt(this.rng.float()) : focus.r * 1.05 + (reach - focus.r * 1.05) * this.rng.float();
      const from = engine.walkableNear.call(engine, w, focus.x + Math.cos(a) * d, focus.y + Math.sin(a) * d, m(30));
      if (!from) continue;
      // Somewhere across the view: the walk passes through what is seen.
      const b = this.rng.float() * Math.PI * 2, e = reach * (0.3 + this.rng.float() * 0.9);
      const to = engine.walkableNear.call(engine, w, focus.x + Math.cos(b) * e, focus.y + Math.sin(b) * e, m(30));
      if (!to || Math.hypot(to.x - from.x, to.y - from.y) < m(40)) continue;
      const roll = this.rng.float();
      const ageClass: PersonAgeClass = roll < 0.12 ? 'child' : roll < 0.28 ? 'elder' : 'adult';
      const id = engine.walkTrip.call(engine, w, {
        trip: this.nextTrip++, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
        seed: Math.floor(this.rng.float() * 0x7fffffff), ageClass, reach: m(30),
      });
      if (id !== null) this.walkers.add(id);
    }
  }

  // ------------------------------------------------------------ traffic

  private traffic(w: SimWorld, focus: NonNullable<SimWorld['focus']>, reach: number, want: number): void {
    const far = reach * 1.15;
    for (const id of [...this.drivers]) {
      const v = w.vehicles.get(id);
      if (!v) { this.drivers.delete(id); continue; }
      const pose = vehiclePose(w, v, 1);
      const d = pose ? Math.hypot(pose.p.x - focus.x, pose.p.y - focus.y) : Infinity;
      if (d > far || (this.drivers.size > want && d > focus.r * 1.05)) {
        w.removeVehicle(v);
        this.drivers.delete(id);
      }
    }
    if (this.drivers.size >= want) return;
    const lanes = this.lanesNear(w);
    if (!lanes.length) return;
    // Cars are drawn at every zoom: only past the edge of the view, but for a map just opened.
    const anywhere = this.fresh;
    for (let tries = 0, made = 0; tries < 48 && made < MAKE_PER_LOOK * (anywhere ? 4 : 1) && this.drivers.size < want; tries++) {
      const pick = lanes[Math.floor(this.rng.float() * lanes.length)]!;
      // A lane wholly out of reach is not looked at further.
      if (Math.hypot(pick.x - focus.x, pick.y - focus.y) > reach + pick.length / 2) continue;
      const lane = w.lanelet(pick.id);
      if (!lane) continue;
      const arch = this.rng.weighted(TRAFFIC);
      const s = arch.length + 1 + this.rng.float() * Math.max(0, lane.length - arch.length - 2);
      const at = lane.centre.sampleAt(s).p;
      const d = Math.hypot(at.x - focus.x, at.y - focus.y);
      const ok = anywhere ? d < reach : d > focus.r * 1.1 && d < reach;
      if (!ok) continue;
      const id = spawnVehicleAt(w, lane.id, s, arch);
      if (id !== null) { this.drivers.add(id); made++; }
    }
  }

  /** The link lanes of the map, each with its middle: where cars can join. */
  private lanesNear(w: SimWorld): { id: string; length: number; x: number; y: number }[] {
    const key = `${w.topologyRevision}:${w.vehicleTopologyRevision}`;
    if (key !== this.lanesFor) {
      this.lanesFor = key;
      this.lanes = [];
      for (const lane of w.graph.lanelets.values()) {
        if (lane.kind !== 'link' || lane.length < m(12)) continue;
        const mid = lane.centre.sampleAt(lane.length / 2).p;
        this.lanes.push({ id: lane.id, length: lane.length, x: mid.x, y: mid.y });
      }
    }
    return this.lanes;
  }

  // ------------------------------------------------------------ parked cars

  /**
   * The cars standing in the bays of the whole map, made again only when the
   * bays change (a building, a road): the same car in the same bay each time.
   */
  private parking(w: SimWorld): void {
    const key = `${w.doc.buildings.revision}:${w.topologyRevision}`;
    if (key === this.baysFor) return;
    this.baysFor = key;
    this.bayList = collectBays(w);
    const kept = new Map(this.bays);
    this.bays.clear();
    this.parked.length = 0;
    for (const bay of this.bayList) {
      const r = new Rng(0x9e3779b9 ^ Math.imul(Math.round(bay.x * 7) + Math.round(bay.y * 13) * 4099, 2654435761));
      if (r.float() >= PARKED) continue;
      const arch = PARKED_KINDS[Math.floor(r.float() * PARKED_KINDS.length)]!;
      const colour = arch.palette[Math.floor(r.float() * arch.palette.length)]!;
      // A bay that was there before keeps its car (same place, same body).
      const was = kept.get(bay.id);
      const angle = Math.atan2(-bay.oy, -bay.ox);
      const car = was && was.free && was.free.x === bay.x && was.free.y === bay.y ? was
        : createVehicle(w.nextVehicleId++, arch, makeDriver(arch, () => r.float()), colour, bay.lane?.lanelet ?? '', 0, w.clock.tick);
      car.seats = 0;
      car.free = { x: bay.x, y: bay.y, angle, px: bay.x, py: bay.y, pangle: angle, lot: bay.building };
      this.bays.set(bay.id, car);
      this.parked.push(car);
    }
  }

  // ------------------------------------------------------------ the place

  private mixAround(w: SimWorld, x: number, y: number, r: number): Mix {
    const key = `${w.doc.buildings.revision}:${Math.round(x / m(40))}:${Math.round(y / m(40))}:${Math.round(r / m(40))}`;
    if (key === this.mixFor) return this.mix;
    this.mixFor = key;
    const count: Record<keyof Mix, number> = { home: 0, shop: 0, work: 0, civic: 0 };
    let total = 0;
    for (const b of w.doc.buildings.all()) {
      if (Math.hypot(b.x - x, b.y - y) > r * 1.2) continue;
      count[kindOf(b)]++;
      total++;
    }
    this.mix = total === 0 ? { home: 0.6, shop: 0.2, work: 0.1, civic: 0.1 }
      : { home: count.home / total, shop: count.shop / total, work: count.work / total, civic: count.civic / total };
    return this.mix;
  }

  /** Street length inside the view, world units: what the population is sized by. */
  private roadAround(w: SimWorld, x: number, y: number, r: number): number {
    const key = `${w.net.revision}:${Math.round(x / m(40))}:${Math.round(y / m(40))}:${Math.round(r / m(40))}`;
    if (key === this.roadFor) return this.road;
    this.roadFor = key;
    let total = 0;
    for (const ribbon of w.net.ribbons.values()) {
      const bb = ribbon.full.bbox;
      if (bb.maxX < x - r || bb.minX > x + r || bb.maxY < y - r || bb.minY > y + r) continue;
      const pts = ribbon.full.toPoints();
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (Math.hypot(mx - x, my - y) <= r) total += Math.hypot(b.x - a.x, b.y - a.y);
      }
    }
    this.road = total;
    return total;
  }
}
