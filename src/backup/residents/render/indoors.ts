import type { SimWorld } from '@sim/world';
import type { Resident } from '@sim/city/population';
import type { GestureView, PedView } from '@sim/people/view';
import { floorHeight, type GroundAt, type PavedAt } from '@world/buildings/foundation';
import { levelElevation, levelHeight, localToWorld } from '@world/buildings/geometry';
import { FURNITURE_SIZE, LAMP_KINDS, type Furniture, type FurnitureKind, interiorAt } from '@world/buildings/interior';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import type { CutawaySpec } from './buildings/layer';
import { type Doing, placeAt } from '@sim/agents/activities';

/**
 * The residents inside the buildings that are cut open: The Sims inside
 * SimCity. Whoever the city has in a building now (`sim/city`) is drawn on
 * the floor shown, using its furniture as the hour of the day has them use
 * it - breakfast at the kitchen counter and the table, the sofa in front of
 * the television in the evening, asleep in bed at night; at work at the desks,
 * behind the counters, at the tables and in the pews, some talking, some on
 * the phone - with the same bodies that walk the streets.
 */
export interface IndoorFigure {
  readonly view: PedView;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  /** Tipped on to its side (radians): somebody asleep in bed. */
  readonly lean: number;
}

/** What a place at a piece of furniture is used for. */
type Use = 'sofa' | 'seat' | 'table' | 'desk' | 'counter' | 'kitchen' | 'shelf' | 'bed' | 'pew';

interface Spot {
  /** Where, in the building's own frame (to tell whose flat it is in). */
  readonly lx: number;
  readonly ly: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly use: Use;
  /** Height of the body's base over the floor (a mattress). */
  readonly rise: number;
  readonly lean: number;
}

const USE: Partial<Record<FurnitureKind, Use>> = {
  sofa: 'sofa', armchair: 'sofa', chair: 'seat', officeChair: 'desk', seat: 'seat', pew: 'pew',
  table: 'table', counter: 'counter', stove: 'kitchen', sink: 'kitchen', fridge: 'kitchen',
  shelf: 'shelf', bookshelf: 'shelf', machine: 'counter', rack: 'shelf', atm: 'counter',
  bed: 'bed', singleBed: 'bed', wardBed: 'bed',
};
/** Uses a body sits at. */
const SITS: ReadonlySet<Use> = new Set(['sofa', 'seat', 'pew', 'desk']);
/** Most people drawn in one building. */
const PER_BUILDING = 28;
/** Most people drawn indoors in all: they share the crowd's ceiling with the street. */
const MAX_INDOOR = 140;
/** Ids of the indoor bodies, clear of the street's people and of anyone in a car. */
const INDOOR_BASE = 1 << 23;

const SEATED: GestureView = { kind: 'bench', phase: 'seated', t: 0 };
const PHONE: GestureView = { kind: 'phone', phase: 'hold', t: 0 };
const TALK: GestureView = { kind: 'talk', phase: 'hold', t: 0 };
const LOOK: GestureView = { kind: 'look', phase: 'hold', t: 0 };
const EAT: GestureView = { kind: 'eat', phase: 'hold', t: 0 };
const WORK: GestureView = { kind: 'work', phase: 'hold', t: 0 };

/** Every place a body can be at the furniture of one floor, in world axes. */
function spotsOf(b: Building, level: number): Spot[] {
  const out: Spot[] = [];
  const c = Math.cos(b.rotation), s = Math.sin(b.rotation);
  const worldHeading = (dx: number, dy: number): number => Math.atan2(dx * s + dy * c, dx * c - dy * s);
  for (const f of interiorAt(b, level).furniture as Furniture[]) {
    const use = USE[f.kind];
    if (!use) continue;
    // The piece's front, in the building's frame (angle 0 faces -y).
    const fx = Math.sin(f.angle), fy = -Math.cos(f.angle);
    if (use === 'bed') {
      // Lying on the side along the bed, head on the pillow (the back end).
      const footOut = f.d / 2 - m(0.15);
      const p = localToWorld(b, f.x + fx * footOut, f.y + fy * footOut);
      const back = worldHeading(-fx, -fy);
      const [, , h] = FURNITURE_SIZE[f.kind];
      out.push({ lx: f.x, ly: f.y, x: p.x, y: p.y, heading: back - Math.PI / 2, use, rise: m(h * 0.95 + 0.12), lean: Math.PI / 2 });
      continue;
    }
    if (SITS.has(use)) {
      // Where somebody stands to sit down: just in front of the seat. The
      // seated clip carries the hips back on to it (set at the seat itself,
      // the body sank into the back of the sofa).
      const ahead = f.d / 2 + m(0.12);
      const p = localToWorld(b, f.x + fx * ahead, f.y + fy * ahead);
      out.push({ lx: f.x, ly: f.y, x: p.x, y: p.y, heading: worldHeading(fx, fy), use, rise: 0, lean: 0 });
      continue;
    }
    // Standing in front of it, facing it.
    const away = f.d / 2 + m(0.45);
    const p = localToWorld(b, f.x + fx * away, f.y + fy * away);
    out.push({ lx: f.x, ly: f.y, x: p.x, y: p.y, heading: worldHeading(-fx, -fy), use, rise: 0, lean: 0 });
  }
  return out;
}

/** The uses a resident looks for, in order, by where they are and the hour. */
function wants(r: Resident, building: number, hour: number): readonly Use[] {
  const home = r.home === building;
  if (home) {
    if (hour >= 23 || hour < 6.5) return ['bed'];
    // Breakfast: cooking at the counter, or seated at the table.
    if (hour < 8.5) return r.id % 2 ? ['kitchen', 'seat', 'counter'] : ['seat', 'kitchen', 'table'];
    // Supper at the table, then the evening in front of the television.
    if (hour >= 19 && hour < 20) return ['seat', 'sofa', 'kitchen'];
    if (hour >= 19) return ['sofa', 'seat', 'table'];
    return r.id % 3 === 0 ? ['seat', 'sofa', 'kitchen'] : ['sofa', 'seat', 'kitchen'];
  }
  if (r.work === building) {
    // Staff: at a desk, behind the counter, at the shelves.
    return r.id % 4 === 0 ? ['counter', 'shelf', 'desk', 'kitchen'] : ['desk', 'counter', 'seat', 'shelf', 'kitchen'];
  }
  // Out for a meal, a film, a service, a prayer: seated where there are seats.
  return ['seat', 'pew', 'sofa', 'shelf', 'counter', 'table'];
}

/** The hands and face of a resident at an activity, as the walking crowd's gestures. */
function gestureOf(d: Doing): GestureView | null {
  if (d.pose === 'lie') return null;
  if (d.pose === 'crouch') return { kind: 'crouch', phase: 'hold', t: 3, hold: 1e6 };
  if (d.pose === 'sit') return d.gesture === 'eat' ? EAT : d.gesture === 'phone' ? PHONE : SEATED;
  return d.gesture ? { kind: d.gesture, phase: 'hold', t: 0 } : null;
}

export class Indoors {
  private readonly spots = new Map<string, Spot[]>();
  private readonly floors = new Map<string, number>();
  private readonly views = new Map<number, PedView>();
  private revision = -1;
  /** The cutaway's buildings, nearest first, and the spec they were picked for. */
  private nearKey = '';
  private near: Building[] = [];

  /**
   * Where the room lights go on the floors cut open: one over each group of
   * furniture (a living room, a kitchen, a row of desks), nearest the middle of
   * the view first, at most `max`.
   */
lamps(world: SimWorld, spec: CutawaySpec | null, groundAt: GroundAt, pavedAt: PavedAt, max: number): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    if (!spec) return out;
    const near = [...world.doc.buildings.all()]
      .map((b) => ({ b, d: Math.hypot(b.x - spec.x, b.y - spec.y) }))
      .filter((e) => (spec.only !== undefined ? e.b.id === spec.only : e.d <= spec.radius))
      .sort((a, c) => a.d - c.d);
    for (const { b } of near) {
      const key = `${b.id}:${spec.level}`;
      let floor = this.floors.get(key);
      if (floor === undefined) {
        floor = floorHeight(b, groundAt, pavedAt) + levelElevation(b, spec.level) + m(0.05);
        this.floors.set(key, floor);
      }
      // The light is where the fittings are: placed, moved and removed by the
      // player like any other piece (`interior.ts`, the Interior tab).
      for (const f of interiorAt(b, spec.level).furniture) {
        if (!LAMP_KINDS.has(f.kind)) continue;
        if (out.length >= max) return out;
        const p = localToWorld(b, f.x, f.y);
        const up = f.kind === 'ceilingLamp' ? levelHeight(b, spec.level) - m(0.6) : f.h * 0.9;
        out.push({ x: p.x, y: p.y, z: floor + up });
      }
    }
    return out;
  }

  /** Everybody to draw inside the buildings cut open by `spec`. */
  figures(world: SimWorld, spec: CutawaySpec | null, groundAt: GroundAt, pavedAt: PavedAt): IndoorFigure[] {
    if (!spec) return [];
    if (world.doc.buildings.revision !== this.revision) {
      this.revision = world.doc.buildings.revision;
      this.spots.clear();
      this.floors.clear();
      this.furniture.clear();
    }
    const hour = (world.city.minutes(world) % 1440) / 60;
    const out: IndoorFigure[] = [];
    // Nearest the middle of the view first: the crowd has a ceiling, and the
    // buildings in id order filled it with people nobody was looking at.
    // Picked once per spec: walking every building, measuring and sorting it
    // ran every frame the cutaway was open, on ground that had not moved.
    const nearKey = `${world.doc.buildings.revision}:${spec.level}:${spec.only ?? ''}:${spec.radius}:${spec.x},${spec.y}`;
    if (nearKey !== this.nearKey) {
      this.nearKey = nearKey;
      this.near = [...world.doc.buildings.all()]
        .map((b) => ({ b, d: Math.hypot(b.x - spec.x, b.y - spec.y) }))
        .filter((e) => (spec.only !== undefined ? e.b.id === spec.only : e.d <= spec.radius))
        .sort((a, c) => a.d - c.d)
        .map((e) => e.b);
    }
    const near = this.near;
    for (const b of near) {
      if (out.length >= MAX_INDOOR) break;
      // The scenery (`sim/ambient`): nobody lives here; the pieces are taken
      // by people of the hour, the same piece by the same person each time.
      const inside = world.city.enabled ? world.city.inside(b.id) : null;
      if (inside && inside.length === 0) continue;
      const key = `${b.id}:${spec.level}`;
      let spots = this.spots.get(key);
      if (!spots) { spots = spotsOf(b, spec.level); this.spots.set(key, spots); }
      if (spots.length === 0) continue;
      let floor = this.floors.get(key);
      if (floor === undefined) {
        floor = floorHeight(b, groundAt, pavedAt) + levelElevation(b, spec.level) + m(0.05);
        this.floors.set(key, floor);
      }
      if (!inside) {
        this.sceneryPeople(world, b, spec.level, spots, floor, hour, out);
        continue;
      }
      // Each resident takes the first free place of the uses they want, in a
      // stable order: the same people in the same places frame to frame.
      const taken = new Set<number>();
      let shown = 0;
      for (const r of inside) {
        if (shown >= PER_BUILDING) break;
        // A resident the simulation has doing something (`sim/agents/activities.ts`):
        // drawn exactly there, as it says.
        const doing = world.city.doingOf(r.id);
        if (doing && !doing.out) {
          if (doing.level !== spec.level) continue;
          const f = this.pieces(b, doing.level)[doing.piece];
          if (!f) continue;
          const at = placeAt(b, f, doing.pose);
          shown++;
          out.push(this.figure(world, r, at.x, at.y, floor + at.rise, at.heading, at.lean, gestureOf(doing)));
          continue;
        }
        // With the agents, nobody is placed by the hour alone: what they do is the sim's.
        if (world.city.cars) continue;
        // Only the people on this floor: at home on their own floor, at work
        // on their job's, visitors on the ground floor.
        const home = r.home === b.id;
        const floorOf = home ? r.homeLevel : r.work === b.id ? r.workLevel : 0;
        if (floorOf !== spec.level) continue;
        // At home, inside their own flat.
        const flat = home ? r.homeSpace : null;
        const inFlat = (sp: Spot): boolean => !flat ||
          (sp.lx >= flat.x - 1 && sp.lx <= flat.x + flat.w + 1 && sp.ly >= flat.y - 1 && sp.ly <= flat.y + flat.d + 1);
        let pick = -1;
        for (const use of wants(r, b.id, hour)) {
          const start = (r.id * 7) % spots.length;
          for (let k = 0; k < spots.length; k++) {
            const i = (start + k) % spots.length;
            if (!taken.has(i) && spots[i]!.use === use && inFlat(spots[i]!)) { pick = i; break; }
          }
          if (pick >= 0) break;
        }
        if (pick < 0) continue;
        taken.add(pick);
        shown++;
        const spot = spots[pick]!;
        const sitting = SITS.has(spot.use);
        // Something to do: a seated pair talks, somebody checks the phone,
        // somebody at a shelf looks along it.
        // At a table, a meal; at the stove, the sink or a counter, work.
        const gesture = spot.use === 'bed' ? null
          : spot.use === 'seat' ? (r.id % 5 === 0 ? PHONE : EAT)
            : sitting ? (r.id % 5 === 0 ? PHONE : SEATED)
              : spot.use === 'kitchen' || spot.use === 'counter' ? WORK
                : r.id % 3 === 0 ? TALK : r.id % 3 === 1 ? (spot.use === 'shelf' ? LOOK : PHONE) : null;
        // One view per resident, kept from frame to frame: the renderer keeps
        // each body's animation by its view, and a new one every frame started
        // the clip over every frame - nobody ever finished sitting down.
        let view = this.views.get(r.id);
        if (!view || view.x !== spot.x || view.y !== spot.y) {
          view = {
            id: INDOOR_BASE + r.id,
            x: spot.x, y: spot.y, heading: spot.heading,
            prev: { x: spot.x, y: spot.y, heading: spot.heading },
            v: 0, turnV: 0, age: 0,
            ageClass: r.ageClass, gender: r.seed % 2 ? 'f' : 'm',
            party: { id: INDOOR_BASE + r.id, size: 1, archetype: 'solo', hasChild: false },
            rank: 0, ground: 'open', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null,
            gesture,
          };
          this.views.set(r.id, view);
        }
        view.gesture = gesture;
        view.age = world.clock.time + (r.id % 17);
        out.push({ view, x: spot.x, y: spot.y, z: floor + spot.rise, heading: spot.heading, lean: spot.lean });
      }
    }
    return out;
  }

  /**
   * People of the scenery at the pieces of one floor: each piece taken by the
   * hour's odds for what it is (a bed at night, a desk in office hours, a sofa
   * in the evening), by the same person whenever it is.
   */
  private sceneryPeople(world: SimWorld, b: Building, level: number, spots: readonly Spot[], floor: number, hour: number,
    out: IndoorFigure[]): void {
    const night = hour >= 22 || hour < 7;
    const office = hour >= 8 && hour < 18;
    const evening = hour >= 18 && hour < 23;
    const odds = (use: Use): number => {
      switch (use) {
        case 'bed': return night ? 0.7 : 0.04;
        case 'desk': case 'counter': case 'kitchen': return office ? 0.55 : evening && use === 'kitchen' ? 0.3 : 0.04;
        case 'shelf': return office ? 0.3 : 0.03;
        case 'sofa': return evening ? 0.55 : night ? 0.05 : 0.2;
        case 'seat': case 'table': return office || evening ? 0.35 : 0.05;
        case 'pew': return hour >= 9 && hour < 12 ? 0.3 : 0.03;
      }
    };
    let shown = 0;
    for (let i = 0; i < spots.length && shown < PER_BUILDING && out.length < MAX_INDOOR; i++) {
      const spot = spots[i]!;
      const h = Math.imul(b.id * 7919 + i * 104729 + level * 31, 2654435761) >>> 0;
      if ((h % 1000) / 1000 >= odds(spot.use)) continue;
      shown++;
      const id = INDOOR_BASE + (h & 0x3fffff);
      const sitting = SITS.has(spot.use);
      const gesture = spot.use === 'bed' ? null
        : sitting ? (h % 5 === 0 ? PHONE : SEATED)
          : spot.use === 'kitchen' || spot.use === 'counter' ? WORK
            : h % 3 === 0 ? TALK : h % 3 === 1 ? (spot.use === 'shelf' ? LOOK : PHONE) : null;
      let view = this.views.get(id);
      if (!view || view.x !== spot.x || view.y !== spot.y) {
        view = {
          id, x: spot.x, y: spot.y, heading: spot.heading, prev: { x: spot.x, y: spot.y, heading: spot.heading },
          v: 0, turnV: 0, age: 0,
          ageClass: (h >> 10) % 9 === 0 ? 'child' : (h >> 10) % 9 === 1 ? 'elder' : 'adult', gender: (h >> 3) & 1 ? 'f' : 'm',
          party: { id, size: 1, archetype: 'solo', hasChild: false },
          rank: 0, ground: 'open', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null, gesture,
        };
        this.views.set(id, view);
      }
      view.gesture = gesture;
      view.age = world.clock.time;
      out.push({ view, x: spot.x, y: spot.y, z: floor + spot.rise, heading: spot.heading, lean: spot.lean });
    }
  }

  /**
   * The residents out in their own lots - in the garden, in the pool, on the
   * front step, washing the car (`CityLife.outdoors`): drawn whether or not
   * anything is cut open, as the street is.
   */
  yard(world: SimWorld, groundAt: GroundAt, max = 120): IndoorFigure[] {
    const out: IndoorFigure[] = [];
    for (const { resident, doing } of world.city.outdoors()) {
      if (out.length >= max) break;
      const o = doing.out!;
      const z = groundAt(o.x, o.y) + (doing.kind === 'swim' ? m(-0.6) : m(0.04));
      out.push(this.figure(world, resident, o.x, o.y, z, o.heading, doing.pose === 'lie' ? Math.PI / 2 : 0, gestureOf(doing)));
    }
    return out;
  }

  private readonly furniture = new Map<string, readonly Furniture[]>();
  /** A floor's furniture, as the sim numbers it (`BuildingUse.furniture`), kept until the buildings change. */
  private pieces(b: Building, level: number): readonly Furniture[] {
    const key = `${b.id}:${level}`;
    let list = this.furniture.get(key);
    if (!list) { list = interiorAt(b, level).furniture as Furniture[]; this.furniture.set(key, list); }
    return list;
  }

  /** One resident's body at a place, the view kept frame to frame (its clip is kept by it). */
  private figure(world: SimWorld, r: Resident, x: number, y: number, z: number, heading: number, lean: number,
    gesture: GestureView | null): IndoorFigure {
    let view = this.views.get(r.id);
    if (!view || view.x !== x || view.y !== y) {
      view = {
        id: INDOOR_BASE + r.id, x, y, heading, prev: { x, y, heading }, v: 0, turnV: 0, age: 0,
        ageClass: r.ageClass, gender: r.seed % 2 ? 'f' : 'm',
        party: { id: INDOOR_BASE + r.id, size: 1, archetype: 'solo', hasChild: false },
        rank: 0, ground: 'open', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null, gesture,
      };
      this.views.set(r.id, view);
    }
    view.gesture = gesture;
    view.age = world.clock.time + (r.id % 17);
    return { view, x, y, z, heading, lean };
  }
}
