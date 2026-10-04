import type { Rng } from '@core/rng';
import type { BlueprintBody } from './blueprints';
import { mat } from './cityBuildings';
import { elementClash } from './elements';
import type { MaterialSpec } from './materials';
import { type MadeBuilding, type Rect, madeToMeasure } from './procedural';
import { type Building, type BuildingElement, type ElementKind, type LotSurface, MAX_ELEMENTS, type Side, type Volume } from './types';
import { m } from '../units';
import type { ZoneDensity, ZoneUse } from '../zones';

/**
 * A grown lot, composed the way a plot in a real street is: street, footway,
 * gate, front garden or forecourt, the building, a side drive or passage, and
 * behind it a yard, a service court or a car park - each area with a purpose,
 * laid with its own surface, and joined to the others.
 *
 * The plan is made FIRST and the building is made for what it leaves (its
 * envelope), so the back of a lot is never the remainder of a building that
 * happened to be shallow. The depth of each zone comes from what it holds:
 *
 * - a car park is a row of stalls 5 m deep and a 6 m aisle (two rows: 16 m),
 *   reached by a 3.5 m drive down the side from a car gate, with a 1.2 m
 *   footpath beside the drive; parking-lot codes give 9 x 18 ft stalls and
 *   20-24 ft two-way aisles (2.5 x 5 m and 6 m here);
 * - a house's yard: a terrace on the back door, a lawn, a service corner by
 *   the side passage, sometimes a pool, a shed, beds and trees;
 * - a shop's service court: concrete, bins, the back door, a drain, a lamp;
 * - a works' loading yard: the truck lane down the side, docks at the hall.
 *
 * A side is either built on the boundary (a shop's party walls, a semi-
 * detached house) or wide enough to be used - a passage, a drive, a side
 * garden - never a strip of grass between a wall and a wall. Boundaries are
 * walls, railings on low walls, fences or hedges, by kind; gates stand where
 * the paths and drives cross them, and nowhere else.
 *
 * Metres in the lot's frame: x across from the left boundary, y back from the
 * street (the front boundary is y = 0).
 */

export type LotKind = 'house' | 'flats' | 'tower' | 'shop' | 'office' | 'industry';

export function lotKind(use: ZoneUse, density: ZoneDensity): LotKind {
  if (use === 'industrial') return 'industry';
  if (use === 'commercial') return density === 'high' ? 'office' : 'shop';
  return density === 'low' ? 'house' : density === 'medium' ? 'flats' : 'tower';
}

type FrontUse = 'street' | 'garden' | 'carpad' | 'forecourt' | 'plaza' | 'apron';
type SideUse = 'attached' | 'path' | 'drive' | 'drivePath' | 'garden';
type BackUse = 'none' | 'yard' | 'parking' | 'service' | 'courtyard' | 'loading';

interface SidePlan { readonly use: SideUse; readonly width: number }

export interface LotPlan {
  readonly kind: LotKind;
  readonly W: number;
  readonly D: number;
  readonly front: { readonly use: FrontUse; readonly depth: number };
  readonly left: SidePlan;
  readonly right: SidePlan;
  readonly back: { readonly use: BackUse; readonly depth: number; readonly rows: number };
  /** The building's envelope. */
  readonly building: Rect;
}

const DRIVE = 3.5, HOUSE_DRIVE = 3, FOOTPATH = 1.2, TRUCK_LANE = 6;
const STALL = 5, AISLE = 6;

const between = (rng: Rng, a: number, b: number): number => a + (b - a) * rng.float();
const half = (x: number): number => Math.floor(x * 2) / 2;

/** The plan of a lot `W` x `D` metres for a kind of building. */
export function planLot(kind: LotKind, W: number, D: number, rng: Rng): LotPlan {
  const attached: SidePlan = { use: 'attached', width: 0 };
  let front: LotPlan['front'] = { use: 'street', depth: 0 };
  let left: SidePlan = attached, right: SidePlan = attached;
  let back: LotPlan['back'] = { use: 'none', depth: 0, rows: 0 };
  const flip = rng.float() < 0.5;
  const sides = (a: SidePlan, b: SidePlan): void => { [left, right] = flip ? [b, a] : [a, b]; };
  /** Parking behind: rows the depth allows after `front` and a building of `minBuilding`. */
  const parkingRows = (minBuilding: number): number => {
    const room = D - front.depth - minBuilding;
    return room >= STALL * 2 + AISLE ? 2 : room >= STALL + AISLE ? 1 : 0;
  };

  switch (kind) {
    case 'house': {
      const narrow = W < 10.5;
      front = D >= 22 ? (narrow ? { use: 'carpad', depth: 5.5 } : { use: 'garden', depth: half(between(rng, 3.5, 5.5)) })
        : { use: 'garden', depth: D >= 14 ? 3 : 0 };
      if (front.depth === 0) front = { use: 'street', depth: 0 };
      if (narrow) sides({ use: 'path', width: FOOTPATH }, attached);
      else sides({ use: 'drive', width: HOUSE_DRIVE }, W >= 16 ? { use: 'garden', width: half(between(rng, 3, 4)) } : W >= 13 ? { use: 'path', width: FOOTPATH } : attached);
      const houseD = Math.min(Math.max(8, D - front.depth - between(rng, 8, 12)), 15);
      const yard = D - front.depth - houseD;
      back = yard >= 4 ? { use: 'yard', depth: half(yard), rows: 0 } : back;
      break;
    }
    case 'flats':
    case 'tower': {
      front = kind === 'tower' ? { use: D >= 24 ? 'plaza' : 'street', depth: D >= 24 ? 5 : 0 }
        : W >= 14 && D >= 20 && rng.float() < 0.75 ? { use: 'garden', depth: half(between(rng, 3, 5)) } : { use: 'street', depth: 0 };
      const rows = W >= 18 ? parkingRows(12) : 0;
      if (rows) {
        sides({ use: 'drivePath', width: DRIVE + FOOTPATH }, rng.float() < 0.55 ? attached : { use: 'path', width: 1.5 });
        back = { use: 'parking', depth: rows === 2 ? STALL * 2 + AISLE : STALL + AISLE, rows };
      } else {
        sides(W >= 14 ? { use: 'path', width: 1.5 } : attached, attached);
        const room = D - front.depth - 12;
        back = room >= 5 ? { use: 'courtyard', depth: half(Math.min(room, 12)), rows: 0 } : back;
      }
      break;
    }
    case 'shop': {
      front = D >= 16 && rng.float() < 0.45 ? { use: 'forecourt', depth: half(between(rng, 3, 4.5)) } : { use: 'street', depth: 0 };
      const rows = W >= 15 && rng.float() < 0.6 ? Math.min(1, parkingRows(12)) : 0;
      if (rows) {
        sides({ use: 'drive', width: DRIVE }, attached);
        back = { use: 'parking', depth: STALL + AISLE, rows };
      } else if (D - front.depth >= 14) {
        back = { use: 'service', depth: half(between(rng, 4.5, 6)), rows: 0 };
      }
      break;
    }
    case 'office': {
      front = D >= 22 ? { use: 'plaza', depth: half(between(rng, 5, 7)) } : { use: 'forecourt', depth: D >= 14 ? 3 : 0 };
      if (front.depth === 0) front = { use: 'street', depth: 0 };
      const rows = W >= 16 ? parkingRows(14) : 0;
      if (rows) {
        sides({ use: 'drivePath', width: DRIVE + FOOTPATH }, attached);
        back = { use: 'parking', depth: rows === 2 ? STALL * 2 + AISLE : STALL + AISLE, rows };
      } else if (D - front.depth >= 16) back = { use: 'service', depth: 5, rows: 0 };
      break;
    }
    case 'industry': {
      front = D >= 22 ? { use: 'apron', depth: 6 } : { use: 'street', depth: 0 };
      if (W >= 20 && D >= 30) {
        sides({ use: 'drive', width: TRUCK_LANE }, W >= 26 ? { use: 'path', width: 1.5 } : attached);
        back = { use: 'loading', depth: half(Math.min(16, Math.max(12, (D - front.depth) * 0.35))), rows: 0 };
      }
      break;
    }
  }
  // The building keeps a usable width: what it cannot keep, the sides give up.
  if (W - left.width - right.width < 6) { left = attached; right = attached; if (back.use === 'parking') back = { use: 'service', depth: Math.min(6, back.depth), rows: 0 }; }
  const building = { x0: left.width, y0: front.depth, x1: W - right.width, y1: D - back.depth };
  return { kind, W, D, front, left, right, back, building };
}

// ---------------------------------------------------------------- furnishing

const PAVERS = mat('brick', 0x9a958c);
const PAVERS_WARM = mat('brick', 0xb08a6e);
const CONCRETE_PATH = mat('concrete', 0xc8c4bb);
const STONE_PATH = mat('stone', 0xd2cbbd);

interface Lot {
  surface(r: Rect, s: LotSurface): void;
  /** `region` laid with `s` round its `holes` (each laid on its own), in rects that do not overlap. */
  tile(region: Rect, holes: readonly Rect[], s: LotSurface): void;
  put(kind: ElementKind, x: number, y: number, facing: Side, w: number, d: number, h: number, z?: number, material?: MaterialSpec): boolean;
  /** A run of `kind` along x at `y` from `x0` to `x1`, with gaps [middle, width]. */
  runX(kind: ElementKind, y: number, x0: number, x1: number, h: number, gaps?: readonly (readonly [number, number])[], z?: number): void;
  runY(kind: ElementKind, x: number, y0: number, y1: number, h: number, z?: number): void;
  /** A path laid as a strip of paving over the ground. */
  path(r: Rect, material?: MaterialSpec): void;
  busy(x: number, y: number, r?: number): boolean;
}

/**
 * Lays the plan on a body whose building already stands in its envelope (the
 * body's local frame: x = m(lot x - W/2), y = m(lot y)). Returns false when
 * the lot could not be laid.
 */
export function furnishLot(body: BlueprintBody, plan: LotPlan, made: MadeBuilding, rng: Rng): boolean {
  const { W, D, front, left, right, back } = plan;
  const env = plan.building;
  const F = front.depth, Bk = D - back.depth;
  const X = (x: number): number => m(x - W / 2), Y = (y: number): number => m(y);
  let nextVolume = Math.max(0, ...body.volumes.map((v) => v.id)) + 1;
  const elements: BuildingElement[] = (body.elements ??= []);
  let nextElement = Math.max(0, ...elements.map((e) => e.id)) + 1;
  const taken: Rect[] = [];
  const probe = (): Building => ({ ...body, id: 0, x: 0, y: 0, rotation: 0 } as Building);

  const lot: Lot = {
    surface(r, s) {
      if (r.x1 - r.x0 < 2 - 1e-6 || r.y1 - r.y0 < 2 - 1e-6) return;
      body.volumes.push({ id: nextVolume++, x: X(r.x0), y: Y(r.y0), w: m(r.x1 - r.x0), d: m(r.y1 - r.y0), base: 0,
        roof: 'flat', storeys: [{ facade: { fill: 'wall' } }], open: s } as Volume);
    },
    tile(region, holes, s) {
      const inside = holes.map((h) => ({ x0: Math.max(h.x0, region.x0), y0: Math.max(h.y0, region.y0), x1: Math.min(h.x1, region.x1), y1: Math.min(h.y1, region.y1) }))
        .filter((h) => h.x1 > h.x0 && h.y1 > h.y0);
      const ys = [...new Set([region.y0, region.y1, ...inside.flatMap((h) => [h.y0, h.y1])])].sort((a, b) => a - b);
      for (let j = 0; j + 1 < ys.length; j++) {
        const y0 = ys[j]!, y1 = ys[j + 1]!;
        const cuts = inside.filter((h) => h.y0 < y1 - 1e-6 && h.y1 > y0 + 1e-6).map((h) => [h.x0, h.x1] as const).sort((a, b) => a[0] - b[0]);
        let x = region.x0;
        for (const [a, b] of [...cuts, [region.x1, region.x1] as const]) {
          if (a - x >= 2) lot.surface({ x0: x, y0, x1: a, y1 }, s);
          x = Math.max(x, b);
        }
      }
    },
    put(kind, x, y, facing, w, d, h, z = 0, material) {
      if (elements.length >= MAX_ELEMENTS - 2 || w < 0.1 || d < 0.1 || h < 0.1) return false;
      const el: BuildingElement = { id: nextElement, kind, x: X(x), y: Y(y), facing, w: m(Math.min(w, 40)), d: m(d), z: m(z), h: m(h),
        ...(material ? { material } : {}) };
      if (elementClash(probe(), el)) return false;
      elements.push(el);
      nextElement++;
      return true;
    },
    runX(kind, y, x0, x1, h, gaps = [], z = 0) {
      const cuts = gaps.map(([c, w]) => [c - w / 2, c + w / 2] as const).sort((p, q) => p[0] - q[0]);
      let from = x0;
      for (const [g0, g1] of [...cuts, [x1, x1] as const]) {
        const to = Math.min(g0, x1);
        const n = Math.ceil((to - from) / 20);
        for (let k = 0; k < n && to - from > 0.3; k++) {
          const a = from + ((to - from) * k) / n, b = from + ((to - from) * (k + 1)) / n;
          lot.put(kind, (a + b) / 2, y, 0, b - a, kind === 'fence' ? 0.12 : kind === 'hedge' ? 0.7 : 0.2, h, z);
        }
        from = Math.max(from, g1);
      }
    },
    runY(kind, x, y0, y1, h, z = 0) {
      const n = Math.ceil((y1 - y0) / 20);
      for (let k = 0; k < n && y1 - y0 > 0.3; k++) {
        const a = y0 + ((y1 - y0) * k) / n, b = y0 + ((y1 - y0) * (k + 1)) / n;
        lot.put(kind, x, (a + b) / 2, 1, b - a, kind === 'fence' ? 0.12 : kind === 'hedge' ? 0.7 : 0.2, h, z);
      }
    },
    path(r, material = PAVERS) {
      if (r.x1 - r.x0 < 0.3 || r.y1 - r.y0 < 0.3) return;
      taken.push(r);
      // In pieces no longer than a part may be.
      const n = Math.ceil(Math.max(r.x1 - r.x0, r.y1 - r.y0) / 30);
      const alongX = r.x1 - r.x0 >= r.y1 - r.y0;
      for (let k = 0; k < n; k++) {
        const q = alongX ? { ...r, x0: r.x0 + ((r.x1 - r.x0) * k) / n, x1: r.x0 + ((r.x1 - r.x0) * (k + 1)) / n }
          : { ...r, y0: r.y0 + ((r.y1 - r.y0) * k) / n, y1: r.y0 + ((r.y1 - r.y0) * (k + 1)) / n };
        lot.put('pavement', (q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2, 0, q.x1 - q.x0, q.y1 - q.y0, 0.1, 0, material);
      }
    },
    busy(x, y, r = 0.8) {
      return taken.some((t) => x + r > t.x0 && x - r < t.x1 && y + r > t.y0 && y - r < t.y1);
    },
  };

  // ---- the strips beside the building: what part of each is drive, and what path
  const strip = (side: 'left' | 'right'): { drive: Rect | null; walk: Rect | null; garden: Rect | null } => {
    const s = side === 'left' ? left : right;
    const x0 = side === 'left' ? 0 : W - s.width, x1 = side === 'left' ? s.width : W;
    const out = { drive: null as Rect | null, walk: null as Rect | null, garden: null as Rect | null };
    const driveW = s.use === 'drivePath' ? s.width - FOOTPATH : s.width;
    if (s.use === 'drive' || s.use === 'drivePath') {
      out.drive = side === 'left' ? { x0, y0: 0, x1: x0 + driveW, y1: Bk } : { x0: x1 - driveW, y0: 0, x1, y1: Bk };
    }
    if (s.use === 'drivePath') out.walk = side === 'left' ? { x0: x0 + driveW, y0: F, x1, y1: Bk } : { x0, y0: F, x1: x0 + FOOTPATH, y1: Bk };
    if (s.use === 'path') out.walk = { x0, y0: F, x1, y1: Bk };
    if (s.use === 'garden') out.garden = { x0, y0: F, x1, y1: Bk };
    return out;
  };
  const L = strip('left'), R = strip('right');
  const drives = [L.drive, R.drive].filter((r): r is Rect => r !== null);
  const walks = [L.walk, R.walk].filter((r): r is Rect => r !== null);
  const door = env.x0 + made.entrance;
  const backDoor = made.backDoor !== undefined ? env.x0 + made.backDoor : null;
  const isHouse = plan.kind === 'house';
  const driveSurface: LotSurface = isHouse ? 'concrete' : plan.kind === 'industry' ? 'concrete' : 'asphalt';

  // ---- what the building leaves of its envelope: a terrace, a court garden
  for (const f of made.free) {
    const r = { x0: env.x0 + f.x0, y0: env.y0 + f.y0, x1: env.x0 + f.x1, y1: env.y0 + f.y1 };
    if (plan.kind === 'industry') {
      lot.surface(r, 'asphalt');
      for (let x = r.x0 + 0.3; x + 2.5 <= r.x1 - 0.2; x += 2.5) lot.put('parking', x + 1.25, r.y0 + Math.min(2.5, (r.y1 - r.y0) / 2), 0, 2.5, Math.min(5, r.y1 - r.y0 - 0.2), 0.12);
    } else if (r.y1 - r.y0 <= 6 && r.x1 - r.x0 <= 8) {
      lot.surface(r, 'tiles');
      lot.put('planter', r.x1 - 0.8, r.y1 - 0.8, 0, 1, 1, 0.6);
      lot.put('bench', (r.x0 + r.x1) / 2, r.y1 - 0.5, 2, 1.4, 0.45, 0.45);
    } else {
      // A courtyard garden: a paved square in the middle of a lawn, benches, trees.
      const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      const pw = Math.min(r.x1 - r.x0 - 2, 6), pd = Math.min(r.y1 - r.y0 - 2, 6);
      if (pw >= 2 && pd >= 2) {
        lot.path({ x0: cx - pw / 2, y0: cy - pd / 2, x1: cx + pw / 2, y1: cy + pd / 2 }, STONE_PATH);
        lot.put('bench', cx, cy - pd / 2 + 0.6, 0, 1.6, 0.5, 0.45);
        lot.put('bench', cx, cy + pd / 2 - 0.6, 2, 1.6, 0.5, 0.45);
      }
      for (const [x, y] of [[r.x0 + 1.5, r.y0 + 1.5], [r.x1 - 1.5, r.y1 - 1.5]] as const) lot.put('tree', x, y, 0, 3, 3, 5);
      lot.put('flowers', r.x1 - 1.2, r.y0 + 1.2, 0, 1.4, 1.4, 0.4);
    }
  }

  // ---- front zone
  if (F > 0) {
    const frontSurface: LotSurface = front.use === 'garden' ? 'grass' : front.use === 'carpad' ? 'grass'
      : front.use === 'forecourt' ? 'pavers' : front.use === 'plaza' ? 'paving' : 'asphalt';
    // Across the front: the drives' own surface where they cross it, the front's elsewhere.
    const cuts = drives.map((r) => [r.x0, r.x1] as const).sort((p, q) => p[0] - q[0]);
    let x = 0;
    for (const [a, b] of [...cuts, [W, W] as const]) {
      if (a - x >= 2) lot.surface({ x0: x, y0: 0, x1: a, y1: F }, frontSurface);
      if (b > a) lot.surface({ x0: a, y0: 0, x1: b, y1: F }, driveSurface);
      x = Math.max(x, b);
    }
    // The path from the gate to the door, and along the building to the side passages.
    if (front.use === 'garden' || front.use === 'carpad') {
      lot.path({ x0: door - 0.7, y0: 0, x1: door + 0.7, y1: F }, isHouse ? PAVERS_WARM : PAVERS);
      for (const w of walks) {
        const [a, b] = w.x0 < door ? [w.x0, door - 0.7] : [door + 0.7, w.x1];
        lot.path({ x0: a, y0: F - FOOTPATH, x1: b, y1: F }, isHouse ? PAVERS_WARM : PAVERS);
      }
      if (front.use === 'carpad') {
        // The car's pad in the front garden, on the side away from the path.
        const padLeft = door > W / 2;
        const pad = padLeft ? { x0: 0.3, y0: 0, x1: Math.min(3.3, door - 1), y1: F - 0.2 } : { x0: Math.max(door + 1, W - 3.3), y0: 0, x1: W - 0.3, y1: F - 0.2 };
        lot.path(pad, CONCRETE_PATH);
      }
      // Planting: shrubs inside the boundary, flowers under the windows, a tree if there is room.
      for (let px = 1.2; px < W - 1; px += 2.6) if (!lot.busy(px, 0.9) && !drives.some((r) => px > r.x0 - 1 && px < r.x1 + 1)) lot.put(rng.float() < 0.5 ? 'shrub' : 'flowers', px, 0.9, 0, 1.2, 1.2, 0.8);
      if (F >= 4) for (let px = env.x0 + 1.5; px < env.x1 - 1; px += 3.5) if (!lot.busy(px, F - 2.4, 1.2)) { lot.put('tree', px, F - 2.4, 0, 2.6, 2.6, 4.5); break; }
      for (let px = env.x0 + 1; px < env.x1 - 0.8; px += 2) if (!lot.busy(px, F - 0.6, 0.7)) lot.put('flowers', px, F - 0.6, 0, 1.6, 0.8, 0.35);
    } else if (front.use === 'forecourt') {
      // Tables outside the shop: benches in pairs, planters between, bollards at the kerb.
      for (let px = 1.6; px < W - 1.2; px += 3.6) {
        if (Math.abs(px - door) < 1.6) continue;
        if (rng.float() < 0.7 && F >= 3) {
          lot.put('bench', px, F * 0.35, 0, 1.3, 0.45, 0.45);
          lot.put('bench', px, F * 0.35 + 1.3, 2, 1.3, 0.45, 0.45);
        } else lot.put('planter', px, F * 0.5, 0, 1, 1, 0.6);
      }
      for (let px = 0.8; px < W - 0.5; px += 1.8) if (Math.abs(px - door) > 1.2 && !drives.some((r) => px > r.x0 - 0.3 && px < r.x1 + 0.3)) lot.put('bollard', px, 0.35, 0, 0.2, 0.2, 0.9);
      lot.put('bin', W - 1.2, F - 0.6, 0, 0.7, 0.6, 1);
    } else if (front.use === 'plaza') {
      // A plaza: trees in planters, benches facing the street, lamps, bollards.
      for (let px = 2.5; px < W - 2; px += 6) {
        if (Math.abs(px - door) < 3) continue;
        lot.put('planter', px, F * 0.45, 0, 2, 2, 0.6);
        lot.put('tree', px, F * 0.45, 0, 2.5, 2.5, 5);
        lot.put('bench', px, F * 0.45 + 1.6, 0, 1.6, 0.5, 0.45);
      }
      for (const px of [1, W - 1]) lot.put('lamp', px, F - 0.8, 0, 0.3, 0.3, 4.5);
      for (let px = 0.8; px < W - 0.5; px += 2) if (!drives.some((r) => px > r.x0 - 0.3 && px < r.x1 + 0.3)) lot.put('bollard', px, 0.35, 0, 0.2, 0.2, 0.9);
    } else if (front.use === 'apron') {
      // A works' front: visitors' stalls off the apron, the walk to the office painted across it.
      lot.path({ x0: door - 0.8, y0: 0, x1: door + 0.8, y1: F }, CONCRETE_PATH);
      for (let px = env.x0 + 0.3; px + 2.5 <= env.x1; px += 2.5) {
        if (Math.abs(px + 1.25 - door) < 2.2) continue;
        lot.put('parking', px + 1.25, F - 2.6, 2, 2.5, 5, 0.12);
      }
      lot.put('lamp', door + 1.6, F - 0.6, 0, 0.3, 0.3, 5);
    }
  }

  // ---- side strips
  for (const s of [L, R]) {
    if (s.drive) {
      const r = { ...s.drive, y0: Math.max(F, s.drive.y0) };
      lot.surface(r, driveSurface);
      if (isHouse && Bk - F >= 6) {
        // A carport: a roof on four posts over the car, beside the house.
        const y0 = F + 0.3, y1 = F + 5.8, x0 = r.x0 + 0.25, x1 = r.x1 - 0.25;
        lot.put('slab', (x0 + x1) / 2, (y0 + y1) / 2, 0, x1 - x0, y1 - y0, 0.15, 2.4, mat('concrete', 0xd0ccc4));
        for (const [px, py] of [[x0 + 0.15, y0 + 0.15], [x1 - 0.15, y0 + 0.15], [x0 + 0.15, y1 - 0.15], [x1 - 0.15, y1 - 0.15]] as const) lot.put('pillar', px, py, 0, 0.18, 0.18, 2.4);
      }
      lot.put('drain', (r.x0 + r.x1) / 2, Math.min(Bk - 0.6, F + 7), 0, 0.5, 0.5, 0.1);
    }
    if (s.walk) {
      lot.path(s.walk, isHouse ? CONCRETE_PATH : PAVERS);
      if (!isHouse && s.walk.y1 - s.walk.y0 > 12) lot.put('lamp', s.walk.x0 + 0.3, (s.walk.y0 + s.walk.y1) / 2, 0, 0.3, 0.3, 3.5);
    }
    if (s.garden) {
      const g = s.garden;
      lot.surface(g, 'grass');
      for (let py = g.y0 + 2; py < g.y1 - 1.5; py += 5) lot.put(py % 10 < 5 ? 'tree' : 'shrub', (g.x0 + g.x1) / 2, py, 0, 2.4, 2.4, 4);
    }
  }

  // ---- back zone
  const by0 = Bk, by1 = D;
  switch (back.use) {
    case 'yard': {
      // The terrace on the back door, the lawn, a service corner, a pool or beds, a shed.
      const terrace = { x0: env.x0, y0: by0, x1: env.x1, y1: Math.min(by1, by0 + 3) };
      const lawnY0 = terrace.y1, depth = by1 - lawnY0;
      const pool = depth >= 6 && W >= 11 && rng.float() < 0.45
        ? { x0: (W - Math.min(8, W - 5)) / 2, y0: lawnY0 + 1, x1: (W + Math.min(8, W - 5)) / 2, y1: lawnY0 + 4.5 } : null;
      lot.tile({ x0: 0, y0: by0, x1: W, y1: by1 }, pool ? [terrace, pool] : [terrace], 'grass');
      lot.surface(terrace, 'tiles');
      if (pool) {
        lot.surface(pool, 'water');
        // Its deck: a paved edge on the terrace side, two loungers.
        lot.path({ x0: pool.x0, y0: lawnY0, x1: pool.x1, y1: pool.y0 }, mat('stone', 0xe0d8c8));
        lot.put('bench', pool.x1 + 1, pool.y0 + 1.2, 3, 1.6, 0.6, 0.35);
      }
      taken.push(terrace);
      lot.put('bench', (terrace.x0 + terrace.x1) / 2 + 1.5, terrace.y0 + 1.6, 2, 1.4, 0.45, 0.45);
      const service = drives[0] ?? walks[0];
      if (service) {
        // The drive or the passage ends in a paved service corner: bins, a drain.
        const sx0 = service.x0, sx1 = Math.max(service.x1, service.x0 + 2.5);
        lot.path({ x0: sx0, y0: by0, x1: sx1, y1: Math.min(by1, by0 + 3) }, CONCRETE_PATH);
        lot.put('bin', (sx0 + sx1) / 2, by0 + 2.4, 2, 1.3, 0.65, 1.1);
        lot.put('drain', (sx0 + sx1) / 2, by0 + 1, 0, 0.5, 0.5, 0.1);
      }
      if (pool) taken.push(pool);
      else if (depth >= 4) {
        // Beds along the back wall.
        for (let px = 1.5; px < W - 1.5; px += 2.2) if (!lot.busy(px, by1 - 1.2)) lot.put('flowers', px, by1 - 1.2, 0, 1.6, 1.2, 0.4);
      }
      if (depth >= 5) {
        for (const px of [1.8, W - 1.8]) if (!lot.busy(px, by1 - 2.2, 1.5)) lot.put('tree', px, by1 - 2.2, 0, 3, 3, 5);
      }
      break;
    }
    case 'parking': {
      lot.surface({ x0: 0, y0: by0, x1: W, y1: by1 }, 'asphalt');
      // Rows along the back boundary (and along the building for two), clear of the drive's mouth.
      const mouth = drives[0];
      const rowY = [by1 - STALL / 2 - 0.15];
      if (back.rows === 2) rowY.push(by0 + STALL / 2);
      for (const [k, y] of rowY.entries()) {
        const facing: Side = k === 0 ? 2 : 0;
        // The row is split where the drive comes in and at the back door's path.
        const skips: [number, number][] = [];
        if (mouth && k === 1) skips.push([mouth.x0 - 0.2, mouth.x1 + 0.2]);
        if (backDoor !== null && k === 1) skips.push([backDoor - 0.9, backDoor + 0.9]);
        let x = 0.4;
        const end = W - 0.4;
        const runs: [number, number][] = [];
        for (const [a, b] of skips.sort((p, q) => p[0] - q[0])) { if (a > x) runs.push([x, a]); x = Math.max(x, b); }
        if (end > x) runs.push([x, end]);
        for (const [a, b] of runs) {
          const n = Math.floor((b - a) / 2.5);
          if (n < 1) {
            if (b - a >= 1.2) { lot.put('planter', (a + b) / 2, y, 0, Math.min(2, b - a - 0.2), 1.2, 0.5); lot.put('shrub', (a + b) / 2, y, 0, 1, 1, 0.9); }
            continue;
          }
          const used = n * 2.5, x0 = a + (b - a - used) / 2;
          lot.put('parking', x0 + used / 2, y, facing, used, STALL, 0.12);
          // A tree in a planter at the end of a long row.
          if (b - a - used >= 1.4) { lot.put('planter', b - (b - a - used) / 2, y, 0, Math.min(1.6, b - a - used - 0.2), 1.6, 0.5); }
        }
      }
      // The back door's walk across to the cars; lamps; a drain in the aisle; the bins by the drive.
      if (backDoor !== null) lot.path({ x0: backDoor - 0.7, y0: by0, x1: backDoor + 0.7, y1: by0 + (back.rows === 2 ? STALL : 1.2) }, PAVERS);
      const aisleY = back.rows === 2 ? by0 + STALL + AISLE / 2 : by0 + AISLE / 2;
      lot.put('drain', W / 2, aisleY, 0, 0.5, 0.5, 0.1);
      for (const px of [0.6, W - 0.6]) lot.put('lamp', px, aisleY, 0, 0.3, 0.3, 5);
      if (mouth) lot.put('bin', mouth.x0 < W / 2 ? mouth.x1 + 1.2 : mouth.x0 - 1.2, by0 + 0.6, 0, 1.4, 0.7, 1.1);
      break;
    }
    case 'service': {
      lot.surface({ x0: 0, y0: by0, x1: W, y1: by1 }, 'concrete');
      const bd = backDoor ?? (env.x0 + env.x1) / 2;
      lot.put('bin', Math.min(W - 1.2, bd + 2.2), by0 + 0.6, 0, 1.4, 0.7, 1.1);
      lot.put('drain', bd, by0 + (by1 - by0) / 2, 0, 0.5, 0.5, 0.1);
      lot.put('lamp', Math.max(0.6, bd - 1.6), by0 + 0.4, 0, 0.3, 0.3, 3.2);
      for (let px = env.x0 + 1; px < env.x1 - 1 && px < bd - 2.5; px += 2.4) lot.put('ac', px, by0 + 0.2, 2, 0.8, 0.35, 0.6, 2.6);
      if (by1 - by0 >= 5 && W >= 8) lot.put('planter', 1, by1 - 1, 0, 1, 1, 0.6);
      break;
    }
    case 'courtyard': {
      // Residents' garden: lawn, a paved square with benches, a play corner, trees.
      const play = by1 - by0 >= 8 && W >= 12 ? { x0: W - 5, y0: by1 - 4.5, x1: W - 1, y1: by1 - 0.5 } : null;
      lot.tile({ x0: 0, y0: by0, x1: W, y1: by1 }, play ? [play] : [], 'grass');
      if (play) { lot.surface(play, 'sand'); lot.put('bench', play.x0 - 0.6, (play.y0 + play.y1) / 2, 1, 1.4, 0.45, 0.45); taken.push(play); }
      const cx = (env.x0 + env.x1) / 2;
      if (backDoor !== null) lot.path({ x0: backDoor - 0.7, y0: by0, x1: backDoor + 0.7, y1: by0 + 2 }, PAVERS);
      lot.path({ x0: cx - 3, y0: by0 + 2, x1: cx + 3, y1: Math.min(by1 - 0.5, by0 + 6) }, STONE_PATH);
      lot.put('bench', cx - 1.5, by0 + 4, 0, 1.6, 0.5, 0.45);
      lot.put('bench', cx + 1.5, by0 + 4, 0, 1.6, 0.5, 0.45);
      for (const w of walks) lot.path({ x0: w.x0, y0: by0, x1: w.x1, y1: by0 + 2 }, PAVERS);
      for (const px of [1.8, W - 1.8]) if (!lot.busy(px, by1 - 2, 1.4)) lot.put('tree', px, by1 - 2, 0, 3, 3, 5);
      lot.put('bin', 1.2, by0 + 0.6, 0, 1.4, 0.7, 1.1);
      break;
    }
    case 'loading': {
      lot.surface({ x0: 0, y0: by0, x1: W, y1: by1 }, 'concrete');
      // Lorry bays at the loading doors, bollards between them, lamps over the yard.
      for (let px = env.x0 + 0.5; px + 3.6 <= env.x1 - 0.3; px += 4.5) {
        lot.put('parking', px + 1.8, by0 + 6, 0, 3.6, Math.min(12, by1 - by0 - 0.5), 0.12);
        lot.put('bollard', px - 0.25, by0 + 0.5, 0, 0.25, 0.25, 1);
      }
      for (const px of [0.6, W - 0.6]) lot.put('lamp', px, (by0 + by1) / 2, 0, 0.3, 0.3, 6);
      lot.put('drain', W / 2, by0 + (by1 - by0) * 0.6, 0, 0.6, 0.6, 0.1);
      break;
    }
    default: break;
  }

  // ---- boundaries and gates
  const inset = 0.15;
  const boundary = ((): { front: ElementKind | null; frontH: number; frontBase: number; sides: ElementKind; sidesH: number } => {
    switch (plan.kind) {
      case 'house': {
        const style = rng.int(0, 2);
        return style === 0 ? { front: 'fence', frontH: 1.1, frontBase: 0.6, sides: 'wall', sidesH: 2 }
          : style === 1 ? { front: 'hedge', frontH: 1.1, frontBase: 0, sides: 'wall', sidesH: 1.9 }
          : { front: 'wall', frontH: 1.4, frontBase: 0, sides: 'wall', sidesH: 2 };
      }
      case 'flats':
      case 'tower': return { front: 'fence', frontH: 1.6, frontBase: 0.45, sides: 'wall', sidesH: 2.2 };
      case 'industry': return { front: 'fence', frontH: 2.4, frontBase: 0, sides: 'fence', sidesH: 2.4 };
      default: return { front: null, frontH: 0, frontBase: 0, sides: 'wall', sidesH: 2.2 };
    }
  })();
  // Front: across the whole frontage where nothing is built on it; gates at the path and the drives.
  const frontGaps: [number, number][] = [];
  const gates: { x: number; w: number }[] = [];
  if (front.use === 'garden' || front.use === 'carpad' || front.use === 'apron') gates.push({ x: door, w: 1.2 });
  for (const r of drives) gates.push({ x: (r.x0 + r.x1) / 2, w: r.x1 - r.x0 - 0.4 });
  if (front.use === 'carpad') gates.push({ x: door > W / 2 ? 1.8 : W - 1.8, w: 2.8 });
  for (const w of walks) if (F === 0) gates.push({ x: (w.x0 + w.x1) / 2, w: w.x1 - w.x0 - 0.2 });
  for (const g of gates) frontGaps.push([g.x, g.w + 0.1]);
  const builtFront = F === 0 ? [env.x0 - 0.05, env.x1 + 0.05] as const : null;
  const frontRun = (x0: number, x1: number): void => {
    if (boundary.front && F > 0) {
      if (boundary.frontBase > 0) lot.runX('wall', inset, x0, x1, boundary.frontBase, frontGaps);
      lot.runX(boundary.front, inset, x0, x1, boundary.frontH, frontGaps, boundary.frontBase);
    } else if (F === 0 || boundary.front === null) {
      // The street front of a shop or a plaza is open; its side strips are closed by their gates.
      for (const s of [L, R]) for (const r of [s.drive, s.walk, s.garden]) {
        if (!r || r.x1 < x0 || r.x0 > x1) continue;
        if (F === 0 && s.garden) lot.runX('wall', inset, r.x0, r.x1, 1.6);
      }
    }
  };
  if (builtFront) { frontRun(0, builtFront[0]); frontRun(builtFront[1], W); } else frontRun(0, W);
  for (const g of gates) lot.put('gate', g.x, inset, 0, g.w, 0.12, plan.kind === 'industry' ? 2.2 : g.w > 2 ? 1.8 : 1.4);
  // Sides: full depth, except where the building stands on the boundary.
  for (const [s, x] of [[left, inset], [right, W - inset]] as const) {
    const lowFront = plan.kind === 'house' || plan.kind === 'flats' ? Math.min(boundary.sidesH, 1.3) : boundary.sidesH;
    if (s.use === 'attached') {
      if (F > 0) lot.runY(boundary.sides, x, inset, F, lowFront);
      if (D - Bk > 0) lot.runY(boundary.sides, x, Bk, D - inset, boundary.sidesH);
    } else {
      if (F > 0) lot.runY(boundary.sides, x, inset, F, lowFront);
      lot.runY(boundary.sides, x, Math.max(F, inset), D - inset, boundary.sidesH);
    }
  }
  // Back.
  if (D - Bk > 0) lot.runX(boundary.sides, D - inset, inset, W - inset, boundary.sidesH);
  (body as { nextVolumeId?: number }).nextVolumeId = nextVolume;
  (body as { nextElementId?: number }).nextElementId = nextElement;
  return true;
}

/**
 * A whole property for a lot `W` x `D` metres: planned, its building made
 * for the envelope, laid out to its boundaries. Local frame: the street along
 * -y, the front boundary at y = 0, centred on x. Null if it cannot be laid.
 */
export function plannedLot(use: ZoneUse, density: ZoneDensity, W: number, D: number, rng: Rng, character?: number): BlueprintBody | null {
  const plan = planLot(lotKind(use, density), W, D, rng);
  const env = plan.building;
  const made = madeToMeasure(use, density, {
    W: env.x1 - env.x0, D: env.y1 - env.y0,
    backDoor: plan.back.use !== 'none' && plan.back.use !== 'loading',
    ...(character !== undefined ? { character } : {}),
  }, rng);
  const body = made.body;
  const dx = m(env.x0 - W / 2), dy = m(env.y0);
  for (const v of body.volumes) { v.x += dx; v.y += dy; }
  for (const e of body.elements ?? []) { e.x += dx; e.y += dy; }
  for (const c of body.cores ?? []) { c.x += dx; c.y += dy; }
  return furnishLot(body, plan, made, rng) ? body : null;
}
