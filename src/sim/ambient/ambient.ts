import { Rng } from '@core/rng';
import { m } from '@world/units';
import type { Building } from '@world/buildings/types';
import { solidFootprints } from '@world/buildings/geometry';
import { DT } from '../params';
import type { SimWorld } from '../world';
import { ARCHETYPES, bodyClassOfArchetype, type Archetype } from '../vehicles/archetypes';
import { chooseVehicleDestination } from '../routing/destination';
import { planFrom } from '../routing/router';
import { makeDriver } from '../vehicles/driver';
import { createVehicle, type Vehicle } from '../vehicles/state';
import { spawnVehicleAt } from '../vehicles/spawn';
import { vehiclePose } from '../pose';
import { removeWalker, walkerOf, walkOn } from '../agents/walk';
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
 *
 * FED FROM THE ENDS OF THE ROADS (`source: 'edges'`, the game's way since the
 * player's order of 2026-10-06): none of the above is made round the view.
 * Cars come in at the road ends (`vehicles/spawn.ts` stepDispatch) and
 * people on the footways there (`edgePeople`), as many as the panel says
 * (`SimWorld.trafficCount`, `pedestrianCount`); each crosses the map to
 * another road end and leaves there - never anywhere else. The parked cars
 * and the player stay as they are.
 */

/** Most people on foot at once, and cars driving, and the cars driving when zoomed out. */
export const MAX_WALKERS = 260;
export const MAX_DRIVERS = 180;
const MAX_DRIVERS_FAR = 110;
/** Seconds between two looks at the budget. */
const LOOK_EVERY = 0.25;
/** Most made in one look: the population fills over a second or two. */
const MAKE_PER_LOOK = 8;

/** What kind of place the view is on: shares of each, from the buildings round it. */
interface Mix { readonly home: number; readonly shop: number; readonly work: number; readonly civic: number }

/** How busy each kind of place is at an hour (0..1): bumps at the hours people go out (GTA's day of the popcycle). */
function busy(kind: keyof Mix, hour: number): number {
  const bump = (at: number, width: number): number => {
    const d = ((hour - at + 36) % 24) - 12;
    return Math.exp(-(d * d) / (2 * width * width));
  };
  // A street is never empty by day: the peaks on a floor of half (a quarter by night).
  const day = 0.25 + 0.25 * bump(13, 4.5);
  switch (kind) {
    case 'home': return Math.min(1, day + 0.5 * bump(8, 1.3) + 0.3 * bump(13, 3) + 0.6 * bump(18.5, 2));
    case 'shop': return Math.min(1, day + 0.35 * bump(9, 1.5) + 0.6 * bump(13, 2.5) + 0.6 * bump(18, 2.5));
    case 'work': return Math.min(1, day + 0.6 * bump(7.5, 1) + 0.3 * bump(12.5, 1.5) + 0.6 * bump(17.5, 1.2));
    case 'civic': return Math.min(1, day + 0.5 * bump(11, 3) + 0.4 * bump(16, 2));
  }
}
/**
 * People per 100 m of street at full bustle, and cars: a shopping street as a
 * GTA street is, a body every few metres of pavement; a residential one quieter.
 */
const PEOPLE: Mix = { home: 7, shop: 24, work: 9, civic: 15 };
const CARS: Mix = { home: 2.6, shop: 6, work: 4.8, civic: 3.6 };
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
  /** Where people and cars come from: round the view (GTA's way) or the ends of the roads. */
  source: 'view' | 'edges' = 'edges';
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
  /** The drivers made here that may be on screen now: never taken off the road at a dead end (`vehicles/spawn.ts` stepDespawn). */
  readonly sighted = new Set<number>();
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
  private static readonly LIVE_PEOPLE = m(150);
  private static readonly LIVE_CARS = m(200);

  /** Walkers and drivers this world made, for the status bar. */
  counts(): { walkers: number; drivers: number; parked: number } {
    return { walkers: this.walkers.size, drivers: this.drivers.size, parked: this.parked.length };
  }

  /** Everything made is taken away (a new map). */
  reset(w: SimWorld): void {
    for (const id of this.walkers) removeWalker(w, id);
    for (const id of this.drivers) { const v = w.vehicles.get(id); if (v) w.removeVehicle(v); }
    this.walkers.clear();
    this.roaming.clear();
    this.drivers.clear();
    this.sighted.clear();
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
    for (const id of this.drivers) if (!w.vehicles.has(id)) { this.drivers.delete(id); this.sighted.delete(id); }
    this.clock += DT;
    if (this.clock < LOOK_EVERY) return;
    this.clock = 0;
    if (this.source === 'edges') {
      this.edgePeople(w);
      this.parking(w);
      return;
    }
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

  /**
   * Whether a point may be on screen: in the circle of the view from above,
   * or, playing, near the player or inside the camera's cone this side of how
   * far anything is noticed (`SimWorld.focus.view`).
   */
  private seen(w: SimWorld, focus: NonNullable<SimWorld['focus']>, x: number, y: number, pad: number): boolean {
    if (Math.hypot(x - focus.x, y - focus.y) < focus.r + pad) return true;
    const v = focus.view;
    if (!v) return false;
    const rx = x - v.ex, ry = y - v.ey, d = Math.hypot(rx, ry);
    if (d > v.far + pad) return false;
    if (d < pad) return true;
    if ((rx * v.dx + ry * v.dy) / d <= v.cos) return false;
    // In the cone, but behind a building: hidden, as GTA fills a street from
    // behind the corners. The point grown by `pad` must be hidden whole.
    return !this.behindWall(w, v.ex, v.ey, x, y, pad);
  }

  /** The walls of the buildings, as rings with their boxes, for the line of sight. */
  private walls: { ring: readonly { x: number; y: number }[]; x0: number; y0: number; x1: number; y1: number }[] = [];
  private wallsFor = -1;

  /** True when a wall stands between the eye and (x, y), and between the eye and each side of it `pad` across. */
  private behindWall(w: SimWorld, ex: number, ey: number, x: number, y: number, pad: number): boolean {
    if (this.wallsFor !== w.doc.buildings.revision) {
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
    const dx = x - ex, dy = y - ey, d = Math.hypot(dx, dy) || 1;
    const sx = (-dy / d) * pad, sy = (dx / d) * pad;
    return this.blocked(ex, ey, x + sx, y + sy) && this.blocked(ex, ey, x - sx, y - sy);
  }

  private blocked(ax: number, ay: number, bx: number, by: number): boolean {
    const lx = Math.min(ax, bx), ly = Math.min(ay, by), hx = Math.max(ax, bx), hy = Math.max(ay, by);
    for (const wl of this.walls) {
      if (wl.x1 < lx || wl.x0 > hx || wl.y1 < ly || wl.y0 > hy) continue;
      const r = wl.ring;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        if (crosses(ax, ay, bx, by, r[j]!.x, r[j]!.y, r[i]!.x, r[i]!.y)) return true;
      }
    }
    return false;
  }

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
      // Never taken away where they may be seen; drawn from above, the view is the circle.
      const inSight = seen && this.seen(w, focus, at.x, at.y, m(4));
      if (!inSight && (d > far || this.walkers.size > want)) {
        removeWalker(w, id);
        this.walkers.delete(id);
      } else if (inSight) {
        // In sight on their last stretch: on to somewhere else, never ending where they are seen.
        const b = this.rng.float() * Math.PI * 2, e = reach * (0.3 + this.rng.float() * 0.7);
        walkOn(w, id, focus.x + Math.cos(b) * e, focus.y + Math.sin(b) * e, m(30));
      }
    }
    const engine = w.pedEngine;
    if (!engine.walkTrip || !engine.walkableNear) return;
    const anywhere = !seen || this.fresh;
    for (let made = 0; made < MAKE_PER_LOOK * (anywhere ? 4 : 1) && this.walkers.size < want; made++) {
      const a = this.rng.float() * Math.PI * 2;
      const d = anywhere ? reach * Math.sqrt(this.rng.float()) : focus.r * 1.05 + (reach - focus.r * 1.05) * this.rng.float();
      const from = engine.walkableNear.call(engine, w, focus.x + Math.cos(a) * d, focus.y + Math.sin(a) * d, m(30));
      if (!from || (seen && !this.fresh && this.seen(w, focus, from.x, from.y, m(6)))) continue;
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

  // ------------------------------------------------------------ on foot, from the road ends

  private endsFor = '';
  /** The footway points at the end of each road, by the road end's node. */
  private ends: { node: number; x: number; y: number }[] = [];
  /** Walkers whose walk does not end at a road end (a map with one): sent on to one when they can be. */
  private readonly roaming = new Set<number>();
  private nextEdgeLook = 0;

  /** Where people come in and leave: the footways round every road end (a node with one road). */
  private roadEnds(w: SimWorld): { node: number; x: number; y: number }[] {
    const key = `${w.topologyRevision}:${w.net.revision}`;
    if (key === this.endsFor) return this.ends;
    this.endsFor = key;
    this.ends = [];
    const engine = w.pedEngine;
    if (!engine.walkableNear) return this.ends;
    for (const node of w.doc.nodes.values()) {
      if (w.doc.degree(node.id) !== 1) continue;
      const found: { x: number; y: number }[] = [];
      // Round the end, out to past the widest footway: each side's walkway once.
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        for (const r of [m(4), m(8), m(12)]) {
          const p = engine.walkableNear.call(engine, w, node.x + Math.cos(a) * r, node.y + Math.sin(a) * r, m(3));
          if (!p || Math.hypot(p.x - node.x, p.y - node.y) > m(16)) continue;
          if (found.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < m(3))) continue;
          found.push({ x: p.x, y: p.y });
        }
      }
      for (const p of found) this.ends.push({ node: node.id, x: p.x, y: p.y });
    }
    return this.ends;
  }

  /**
   * People on foot from the road ends, up to the number chosen: each comes in
   * on the footway at one road end, walks to another road end and leaves
   * there (`walk.ts` ends the walk on arrival). A map with a single road end
   * sends them somewhere across the map and back to it.
   */
  private edgePeople(w: SimWorld): void {
    const engine = w.pedEngine;
    if (!engine.walkTrip) return;
    for (const id of this.roaming) {
      if (!this.walkers.has(id)) { this.roaming.delete(id); continue; }
      const end = this.pickEnd(w, null);
      if (end && walkOn(w, id, end.x, end.y, m(30))) this.roaming.delete(id);
    }
    // The number chosen; past one person per 8 m of street they would only
    // stand in each other's way, so not more than that.
    const want = Math.min(Math.max(0, Math.round(w.pedestrianCount ?? 0)), Math.floor(this.roadAround(w, 0, 0, Infinity) / m(8)));
    // Everybody on foot counts (riders getting off a bus, the player too), not only those made here.
    const onFoot = Math.max(this.walkers.size, w.pedViews.length);
    if (onFoot >= want) return;
    const ends = this.roadEnds(w);
    if (!ends.length) return;
    this.nextEdgeLook -= LOOK_EVERY;
    if (this.nextEdgeLook > 0) return;
    // Two a second at most: the street fills over a while, and each new body
    // is built without a stall (`render/agents.ts` builds one at a time).
    const batch = Math.min(want - onFoot, 2);
    this.nextEdgeLook = 1;
    for (let made = 0, tries = 0; made < batch && tries < batch * 4; tries++) {
      const from = ends[Math.floor(this.rng.float() * ends.length)]!;
      // Not onto somebody standing there.
      if (engine.bridge.anyoneWithin(w, from.x, from.y, m(1.5), null)) continue;
      let to = this.pickEnd(w, from.node);
      let roams = false;
      if (!to) {
        // One road end only: across the map and back.
        const a = this.rng.float() * Math.PI * 2, d = m(60) + this.rng.float() * m(200);
        const p = engine.walkableNear?.call(engine, w, from.x + Math.cos(a) * d, from.y + Math.sin(a) * d, m(30));
        if (!p) continue;
        to = { node: -1, x: p.x, y: p.y };
        roams = true;
      }
      const roll = this.rng.float();
      const ageClass: PersonAgeClass = roll < 0.12 ? 'child' : roll < 0.28 ? 'elder' : 'adult';
      const id = engine.walkTrip.call(engine, w, {
        trip: this.nextTrip++, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
        seed: Math.floor(this.rng.float() * 0x7fffffff), ageClass, reach: m(30),
      });
      if (id === null) continue;
      this.walkers.add(id);
      if (roams) this.roaming.add(id);
      made++;
    }
  }

  /** A road end's footway point at another road end than `not`; null when there is none. */
  private pickEnd(w: SimWorld, not: number | null): { node: number; x: number; y: number } | null {
    const ends = this.roadEnds(w).filter((e) => e.node !== not);
    return ends.length ? ends[Math.floor(this.rng.float() * ends.length)]! : null;
  }

  // ------------------------------------------------------------ traffic

  private traffic(w: SimWorld, focus: NonNullable<SimWorld['focus']>, reach: number, want: number): void {
    const far = reach * 1.15;
    for (const id of [...this.drivers]) {
      const v = w.vehicles.get(id);
      if (!v) { this.drivers.delete(id); this.sighted.delete(id); continue; }
      const pose = vehiclePose(w, v, 1);
      const d = pose ? Math.hypot(pose.p.x - focus.x, pose.p.y - focus.y) : Infinity;
      const inSight = pose !== null && this.seen(w, focus, pose.p.x, pose.p.y, v.archetype.length);
      if (inSight) {
        this.sighted.add(id);
        // Near the end of its way (a road off the map), somewhere else instead: a car in sight drives on.
        const at = v.route.indexOf(v.lanelet);
        if (at >= 0 && v.route.length - at <= 5) {
          const next = chooseVehicleDestination(w, v.lanelet, bodyClassOfArchetype(v.archetype));
          if (next && next !== v.destination) { v.destination = next; planFrom(w, v); }
        }
      } else this.sighted.delete(id);
      if (!inSight && (d > far || this.drivers.size > want)) {
        w.removeVehicle(v);
        this.drivers.delete(id);
        this.sighted.delete(id);
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
      const ok = anywhere ? d < reach : d < reach && !this.seen(w, focus, at.x, at.y, arch.length + m(4));
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

/** Whether segment a-b crosses segment c-d (proper crossing). */
function crosses(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}
