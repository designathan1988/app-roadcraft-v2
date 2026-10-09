import { m } from '../units';
import type { BlueprintBody } from './blueprints';
import { ON_FACADE } from './elements';
import { ACCESS_COMPONENTS, PLINTH_MIN } from './foundation';
import { EPS, GRID, isMass, levelHeight } from './geometry';
import { type BayComponent, type Building, type BuildingElement, type FaceId, MAX_LIFT, type Storey, type Volume } from './types';

/**
 * A building that follows its hillside: the back of it standing a half or a
 * whole storey above or below the front, as real houses on a slope are built
 * (a back-split, a split-level, a house with a lower ground floor opening on
 * the garden at the foot of the slope).
 *
 * The front - the block with the street door, and every block beside it -
 * keeps the street's floor (`foundation.ts`). Behind a line across the
 * building (the back of the door block, or its middle when nothing stands
 * behind it), the blocks are moved together to one floor of their own
 * (`Volume.lift`), the one that leaves the least earth cut and filled under
 * them, by half storeys (split levels are a half storey apart, joined by short
 * flights: McCarthy Homes, "split level home designs"; on 10-20 % slopes
 * "two to three split levels ... a daylight basement": studiomatrx, sloping
 * site design). Cut and fill are held to about a metre under a house where
 * that can be done (Camden DCP 4.2.2: "The maximum amount of cut must not
 * exceed 1m", fill the same; split level design on steep land) and a fill
 * costs more than a cut (fill raises the house off the hill). Each block is
 * moved whole, as CityEngine's "Translate to" alignment moves a shape.
 *
 * - Half a storey up or down: the back blocks' floors at their own level.
 * - A whole storey down: the back blocks keep their floors and gain a lower
 *   ground floor under them, exposed to the garden on the downhill side (a
 *   walk-out: its door at grade on the exposed side).
 * - A whole storey up: the back blocks lose their bottom storey to the hill.
 *
 * Where the front block is the whole building, it is split across its depth
 * into a front and a back part first. A face of a lowered block that looks
 * onto a side strip of the lot (laid at the street's floor) keeps no windows
 * below that grade.
 */

/** The shallowest a part of a split block may be. */
const MIN_PART = m(3.5);
/** A fill costs this much more than a cut of the same depth. */
const FILL_WEIGHT = 1.3;
/** The least a step must save in mean cut and fill under the back to be built. */
const GAIN = m(0.45);
/** How far a block's side may stand from the envelope's side and still look onto the side strip. */
const ON_EDGE = m(0.6);

export interface SlopeSite {
  /** The natural ground under a point of the body's local plan. */
  readonly groundAt: (x: number, y: number) => number;
  /** The ground floor the street gives the building (same units). */
  readonly floor: number;
  /** Local x of the envelope's two sides: a face on one looks onto a side strip at the street's floor. */
  readonly x0: number;
  readonly x1: number;
}

export interface SplitLevel {
  /** Local y from which the building, and the lot behind it, stand at their own level. */
  readonly y: number;
  /** That level's lift (world units). */
  readonly lift: number;
  /** Half storeys up (+) or down (-): 1 a split level, 2 a whole storey. */
  readonly steps: number;
}

const isAccess = (c: BayComponent | undefined): boolean => c !== undefined && ACCESS_COMPONENTS.has(c);

/** Whether storey 0 of a block has a way in on `side`. */
function doorOn(v: Volume, side: FaceId): boolean {
  const f = v.storeys[0]?.facade;
  if (!f) return false;
  if (Object.entries(f.bays ?? {}).some(([key, c]) => key.startsWith(`${side}:`) && isAccess(c))) return true;
  return isAccess(f.sides?.[side] ?? f.fill);
}

const snap = (v: number): number => Math.round(v / GRID) * GRID;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A storey's facade with the overrides of `drop` sides' bays taken out (their bay count changes with the block). */
function withoutBays(s: Storey, drop: readonly FaceId[]): Storey {
  const out = clone(s);
  if (out.facade.bays) {
    out.facade.bays = Object.fromEntries(Object.entries(out.facade.bays).filter(([key]) => !drop.includes(Number(key.split(':')[0]))));
  }
  return out;
}

/**
 * Splits block `v` across its depth at local `y`: `v` keeps the front part,
 * the returned block is the back part, with the same storeys, look and roof.
 * Bay overrides and reliefs stay with the face they were on; those of the two
 * sides, whose bays are shared out again, are left out.
 */
function splitBlock(v: Volume, y: number, id: number): Volume {
  const end = v.y + v.d;
  // The ridge as it ran on the whole block (absent, it follows the longer side).
  if ((v.roof === 'gable' || v.roof === 'hip') && !v.ridge) v.ridge = v.w >= v.d ? 'x' : 'y';
  const back: Volume = { ...clone(v), id, y, d: end - y };
  v.d = y - v.y;
  v.storeys = v.storeys.map((s) => withoutBays(s, [1, 2, 3]));
  back.storeys = back.storeys.map((s) => withoutBays(s, [0, 1, 3]));
  const keep = (part: Volume, side: FaceId): void => {
    const reliefs = (part.reliefs ?? []).filter((r) => r.side === side);
    if (reliefs.length) part.reliefs = reliefs; else delete part.reliefs;
    for (const face of [1, 3] as const) if (part.facadeGeometry?.[face]) delete part.facadeGeometry[face]!.bays;
    if (part.roofDetails) part.roofDetails = part.roofDetails.filter((d) => d.y >= part.y && d.y <= part.y + part.d);
  };
  keep(v, 0);
  keep(back, 2);
  return back;
}

/** The block a part hung on a face belongs to: the one whose face, on its side, is nearest. */
function ownerOf(el: BuildingElement, blocks: readonly Volume[]): Volume | null {
  let best: Volume | null = null;
  let bestD = m(1.2);
  for (const v of blocks) {
    const inX = el.x >= v.x - m(0.5) && el.x <= v.x + v.w + m(0.5);
    const inY = el.y >= v.y - m(0.5) && el.y <= v.y + v.d + m(0.5);
    const d = el.facing === 0 ? (inX ? Math.abs(el.y - v.y) : Infinity)
      : el.facing === 2 ? (inX ? Math.abs(el.y - (v.y + v.d)) : Infinity)
        : el.facing === 1 ? (inY ? Math.abs(el.x - (v.x + v.w)) : Infinity)
          : inY ? Math.abs(el.x - v.x) : Infinity;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/**
 * Steps the back of a body (local frame, its volumes in place on the lot) to
 * the ground under it. Returns the step made, or null when the ground does
 * not call for one (or the building cannot take one: a block of another
 * shape, a core or an upper floor across the line).
 */
export function stepToSlope(body: BlueprintBody, site: SlopeSite): SplitLevel | null {
  const b = body as Building;
  const solids = body.volumes.filter((v) => !v.open && isMass(v) && v.base === 0);
  if (!solids.length || body.volumes.some((v) => v.outline || v.mode) || solids.some((v) => v.lift)) return null;
  const front = [...solids].sort((p, q) => Number(doorOn(q, 0)) - Number(doorOn(p, 0)) || p.y - q.y)[0]!;
  const frontBack = front.y + front.d;
  const behind = solids.filter((v) => v.y >= frontBack - EPS);
  // The line: the back of the door block, or across its middle.
  const y = behind.length ? frontBack : snap(front.y + front.d / 2);
  const crossing = solids.filter((v) => v.y < y - EPS && v.y + v.d > y + EPS);
  if (crossing.some((v) => y - v.y < MIN_PART || v.y + v.d - y < MIN_PART)) return null;
  // Nothing above the ground or in a shaft may straddle the line or stand behind it unsplit.
  const uppers = body.volumes.filter((v) => !v.open && v.base > 0);
  if (uppers.some((v) => v.y < y - EPS && v.y + v.d > y + EPS)) return null;
  if ((body.cores ?? []).some((c) => c.y + body.module > y + EPS)) return null;

  // The ground under the back, against the floors it could have.
  const samples: number[] = [];
  for (const v of [...behind, ...crossing]) {
    const y0 = Math.max(v.y, y), y1 = v.y + v.d;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
      const g = site.groundAt(v.x + (v.w * i) / 4, y0 + ((y1 - y0) * j) / 4);
      if (Number.isFinite(g)) samples.push(g);
    }
  }
  if (!samples.length) return null;
  const H = levelHeight(b, 0);
  const liftOf = (k: number): number => (Math.abs(k) === 2 ? Math.sign(k) * H : k * H / 2);
  const cost = (k: number): number => {
    const pad = site.floor + liftOf(k) - PLINTH_MIN;
    let sum = 0;
    for (const g of samples) sum += pad > g ? (pad - g) * FILL_WEIGHT : g - pad;
    return sum / samples.length;
  };
  const backs = [...behind, ...crossing];
  // A whole storey up takes the bottom storey off the back blocks: each needs one to spare.
  const ks = [-2, -1, 1, ...(backs.every((v) => v.storeys.length >= 2) ? [2] : [])];
  let k = 0;
  let best = cost(0);
  for (const c of ks) { const s = cost(c); if (s < best - 1e-9) { best = s; k = c; } }
  if (k === 0 || cost(0) - best < GAIN || Math.abs(liftOf(k)) > MAX_LIFT) return null;
  const lift = liftOf(k);

  // ---- the step made
  let nextId = Math.max(body.nextVolumeId, ...body.volumes.map((v) => v.id + 1));
  const parts: Volume[] = [...behind];
  for (const v of crossing) {
    const back = splitBlock(v, y, nextId++);
    body.volumes.push(back);
    parts.push(back);
  }
  body.nextVolumeId = nextId;
  const raised = uppers.filter((v) => v.y >= y - EPS);
  const onEdge = (v: Volume, side: 1 | 3): boolean => side === 3 ? Math.abs(v.x - site.x0) < ON_EDGE : Math.abs(v.x + v.w - site.x1) < ON_EDGE;
  /** A storey with no openings on the faces that look onto a side strip laid higher than it. */
  const blind = (v: Volume, s: Storey): void => {
    for (const side of [1, 3] as const) {
      if (!onEdge(v, side)) continue;
      s.facade.sides = { ...(s.facade.sides ?? {}), [side]: 'wall' };
      if (s.facade.bays) for (const key of Object.keys(s.facade.bays)) if (key.startsWith(`${side}:`)) delete s.facade.bays[key];
    }
  };
  const backDoor = (s: Storey | undefined): string | null =>
    Object.entries(s?.facade.bays ?? {}).find(([key, c]) => key.startsWith('2:') && isAccess(c))?.[0] ?? null;
  for (const v of parts) {
    if (k === -2) {
      // A lower ground floor under it: a storey like the one above, walled
      // where earth stands against it, its windows and the back door on the
      // garden side.
      const above = v.storeys[0]!;
      const lower = clone(above);
      lower.facade.sides = { ...(lower.facade.sides ?? {}), 0: 'wall' };
      if (lower.facade.bays) for (const key of Object.keys(lower.facade.bays)) if (key.startsWith('0:')) delete lower.facade.bays[key];
      blind(v, lower);
      const door = backDoor(above);
      if (door) {
        above.facade.bays = { ...(above.facade.bays ?? {}), [door]: isAccess(above.facade.fill) ? 'window' : above.facade.fill };
        lower.facade.bays = { ...(lower.facade.bays ?? {}), [door]: 'door' };
      }
      v.storeys.unshift(lower);
    } else if (k === 2) {
      const gone = v.storeys.shift()!;
      const door = backDoor(gone);
      if (door) v.storeys[0]!.facade.bays = { ...(v.storeys[0]!.facade.bays ?? {}), [door]: 'door' };
    } else if (k < 0) blind(v, v.storeys[0]!);
    v.lift = lift;
  }
  for (const v of raised) {
    v.base += k === -2 ? 1 : k === 2 ? -1 : 0;
    v.lift = lift;
  }

  // ---- the parts hung on the moved faces move with them
  const moved = new Set([...parts, ...raised].map((v) => v.id));
  const all = body.volumes.filter((v) => !v.open && isMass(v));
  const elements = body.elements ?? [];
  let nextElement = Math.max(body.nextElementId ?? 1, ...elements.map((e) => e.id + 1));
  // A whole storey keeps every floor where it was; a half storey moves them.
  const dz = Math.abs(k) === 2 ? 0 : lift;
  const out: BuildingElement[] = [];
  for (const el of elements) {
    if (!ON_FACADE.has(el.kind)) { out.push(el); continue; }
    const owner = ownerOf(el, all);
    if (!owner) { out.push(el); continue; }
    const side = el.facing === 1 || el.facing === 3;
    const y0 = el.y - (side ? el.w : el.d) / 2, y1 = el.y + (side ? el.w : el.d) / 2;
    if (side && y0 < y - EPS && y1 > y + EPS) {
      // A band along a split side: in two, the back piece at the back's level.
      out.push({ ...el, y: (y0 + y) / 2, w: y - y0 });
      if (k !== 2 || el.z >= lift) out.push({ ...el, id: nextElement++, y: (y + y1) / 2, w: y1 - y, z: el.z + dz });
      continue;
    }
    if (!moved.has(owner.id)) { out.push(el); continue; }
    // Below the floor of a block that lost its bottom storey to the hill: gone with it.
    if (k === 2 && el.z < lift - EPS) continue;
    out.push({ ...el, z: el.z + dz });
  }
  body.elements = out;
  body.nextElementId = nextElement;
  return { y, lift, steps: k };
}
