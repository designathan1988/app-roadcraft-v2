import type { Vec2 } from '@core/vec2';
import { mat } from './cityBuildings';
import { elementClash } from './elements';
import { worldToLocal } from './geometry';
import type { MaterialSpec } from './materials';
import { type Building, type BuildingElement, type ElementKind, type LotSurface, MAX_ELEMENTS, MAX_VOLUMES, type Side, type Volume } from './types';
import { m } from '../units';
import { structuralProblem } from './validate';

/**
 * A property's plot carried back to its rear boundary - in a real town a
 * building on the street owns the ground behind it to the plot's back line,
 * the block's spine: its yard, its service court, its garden, walled from the
 * neighbours' and from the plot behind. Not a new building in the middle of
 * the block, and not common ground: the building's own back.
 *
 * `rect` is the ground (world units, axis-aligned) from the back of the
 * building to the rear boundary. Returns the building with its plot laid to
 * it, or null when it could not be laid.
 */
export interface WorldRect { x0: number; y0: number; x1: number; y1: number }

const HOMES = new Set(['house', 'townhouse', 'apartments', 'residentialTower']);

export function extendPlot(source: Building, rect: WorldRect): Building | null {
  const b = JSON.parse(JSON.stringify(source)) as Building;
  // The rect in the building's own frame (its turns are quarter turns).
  const corners: Vec2[] = [
    { x: rect.x0, y: rect.y0 }, { x: rect.x1, y: rect.y0 }, { x: rect.x1, y: rect.y1 }, { x: rect.x0, y: rect.y1 },
  ].map((p) => worldToLocal(b, p));
  const r = {
    x0: Math.min(...corners.map((p) => p.x)), y0: Math.min(...corners.map((p) => p.y)),
    x1: Math.max(...corners.map((p) => p.x)), y1: Math.max(...corners.map((p) => p.y)),
  };
  if (r.x1 - r.x0 < m(2) || r.y1 - r.y0 < m(2)) return null;
  const solid = b.volumes.filter((v) => !v.open);
  if (!solid.length) return null;
  const sb = {
    x0: Math.min(...solid.map((v) => v.x)), y0: Math.min(...solid.map((v) => v.y)),
    x1: Math.max(...solid.map((v) => v.x + v.w)), y1: Math.max(...solid.map((v) => v.y + v.d)),
  };
  // Which way the plot runs back from the building: `u` from the building
  // (0) to the rear boundary (depth), `a` along the building.
  const gaps = [r.y0 - sb.y1, sb.y0 - r.y1, r.x0 - sb.x1, sb.x0 - r.x1];
  const dir = gaps.indexOf(Math.max(...gaps));
  const depth = dir < 2 ? r.y1 - r.y0 : r.x1 - r.x0;
  const width = dir < 2 ? r.x1 - r.x0 : r.y1 - r.y0;
  /** A rect `u0..u1` back from the building, `a0..a1` along it, in the local frame. */
  const R = (u0: number, u1: number, a0: number, a1: number): { x0: number; y0: number; x1: number; y1: number } => {
    switch (dir) {
      case 0: return { x0: r.x0 + a0, x1: r.x0 + a1, y0: r.y0 + u0, y1: r.y0 + u1 };
      case 1: return { x0: r.x0 + a0, x1: r.x0 + a1, y0: r.y1 - u1, y1: r.y1 - u0 };
      case 2: return { y0: r.y0 + a0, y1: r.y0 + a1, x0: r.x0 + u0, x1: r.x0 + u1 };
      default: return { y0: r.y0 + a0, y1: r.y0 + a1, x0: r.x1 - u1, x1: r.x1 - u0 };
    }
  };
  /** Facing out of the far boundary (into the plot behind) and along the side boundaries. */
  const farFacing: Side = dir === 0 ? 2 : dir === 1 ? 0 : dir === 2 ? 1 : 3;
  const sideFacing: Side = dir < 2 ? 1 : 0;

  let nextVolume = Math.max(0, ...b.volumes.map((v) => v.id)) + 1;
  const elements: BuildingElement[] = (b.elements ??= []);
  let nextElement = Math.max(0, ...elements.map((e) => e.id)) + 1;
  const lot = (q: ReturnType<typeof R>, open: LotSurface): void => {
    if (q.x1 - q.x0 < m(2) - 1e-6 || q.y1 - q.y0 < m(2) - 1e-6 || b.volumes.length >= MAX_VOLUMES) return;
    b.volumes.push({ id: nextVolume++, x: q.x0, y: q.y0, w: q.x1 - q.x0, d: q.y1 - q.y0, base: 0, roof: 'flat',
      storeys: [{ facade: { fill: 'wall' } }], open } as Volume);
  };
  const put = (kind: ElementKind, q: ReturnType<typeof R>, facing: Side, h: number, material?: MaterialSpec): void => {
    if (elements.length >= MAX_ELEMENTS - 1) return;
    const alongX = facing === 0 || facing === 2;
    const el: BuildingElement = {
      id: nextElement, kind, x: (q.x0 + q.x1) / 2, y: (q.y0 + q.y1) / 2, facing,
      w: alongX ? q.x1 - q.x0 : q.y1 - q.y0, d: alongX ? q.y1 - q.y0 : q.x1 - q.x0, z: 0, h, ...(material ? { material } : {}),
    };
    if (el.w < m(0.1) || el.d < m(0.1) || el.w > m(40) || elementClash(b, el)) return;
    elements.push(el);
    nextElement++;
  };
  /** A wall from `u0` to `u1` back at `a` (a side boundary), in pieces. */
  const sideWall = (a: number, u0: number, u1: number, h: number): void => {
    const n = Math.ceil((u1 - u0) / m(20));
    for (let k = 0; k < n; k++) {
      const q = R(u0 + ((u1 - u0) * k) / n, u0 + ((u1 - u0) * (k + 1)) / n, a - m(0.1), a + m(0.1));
      put('wall', q, sideFacing, h);
    }
  };
  const homes = HOMES.has(b.function ?? '');
  const S = m(1);
  // ---- the ground, from the back door to the rear boundary
  const near = Math.min(depth, homes ? 3 * S : 5 * S);
  if (depth - near < 2 * S) {
    lot(R(0, depth, 0, width), homes ? 'tiles' : 'concrete');
  } else {
    lot(R(0, near, 0, width), homes ? 'tiles' : 'concrete');
    lot(R(near, depth, 0, width), homes ? 'grass' : width >= 8 * S && depth - near >= 6 * S ? 'grass' : 'gravel');
  }
  // ---- walls: the two side boundaries and the rear boundary
  const inset = m(0.15);
  sideWall(inset, 0, depth - inset, m(2));
  sideWall(width - inset, 0, depth - inset, m(2));
  for (let k = 0, n = Math.ceil(width / m(20)); k < n; k++) {
    put('wall', R(depth - inset - m(0.1), depth - inset + m(0.1), (width * k) / n, (width * (k + 1)) / n), farFacing, m(2));
  }
  // ---- what the yard holds
  const spot = (u: number, a: number, s: number): ReturnType<typeof R> => R(u - s / 2, u + s / 2, a - s / 2, a + s / 2);
  put('bin', R(m(0.4), m(1.1), m(0.5), m(1.9)), farFacing, m(1.1));
  if (!homes) put('drain', spot(near / 2, width / 2, m(0.5)), 0, m(0.1));
  if (depth - near >= 4 * S) {
    // Trees at the back, beds along the rear wall, a bench facing the garden.
    for (let a = 2 * S; a < width - 1.5 * S; a += 6 * S) put('tree', spot(depth - 2.2 * S, a, 2.6 * S), 0, 5 * S);
    for (let a = 1.5 * S; a < width - 1.2 * S; a += 2.4 * S) put('flowers', R(depth - 1.3 * S, depth - 0.5 * S, a - 0.8 * S, a + 0.8 * S), farFacing, 0.4 * S);
    put('bench', R(near + 0.3 * S, near + 0.8 * S, width / 2 - 0.8 * S, width / 2 + 0.8 * S), farFacing, 0.45 * S, mat('wood', 0x8a6a45));
  }
  (b as { nextVolumeId?: number }).nextVolumeId = nextVolume;
  (b as { nextElementId?: number }).nextElementId = nextElement;
  return structuralProblem(b) ? null : b;
}
