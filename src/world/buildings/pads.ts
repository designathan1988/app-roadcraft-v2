import type { Aabb } from '@core/aabb';
import type { Vec2 } from '@core/vec2';
import { m } from '../units';
import { type GroundAt, type PavedAt, PLINTH_MIN, floorHeight } from './foundation';
import { groundVolumes, solidFootprints, volumeLift } from './geometry';
import { lotSurfaces } from './lots';
import type { Building } from './types';

/**
 * The ground graded to every building: a level platform under it, and a bank
 * at about one in three and a half from its edge back to the land - gentle
 * enough to stay grassed rather than bare soil.
 *
 * This is what a site on a slope actually gets, and what city builders do: the
 * TERRAIN is cut and filled, so the building stands on level ground and the
 * land meets it as a grassed slope. The old answer drew the difference as part
 * of the building - a stone plinth wall on the low side, with flights of steps
 * down it - which is what a builder does only where there is no room for a bank.
 *
 * The platform stands at the floor less the plinth, and the floor is worked out
 * on the NATURAL ground. Drawn on the graded ground, the same rule finds the
 * platform under the whole footprint and puts the floor back where it was: the
 * grading never feeds on itself.
 */

/** Slope of the bank: horizontal run per unit of height. */
export const PAD_BATTER = 3.5;
/** How far a paved lot's plate stands over the graded ground under it. */
export const LOT_PLATE = m(0.03);
/** How far water stands below its lot's edge: a pool's or a pond's rim. */
export const POOL_SINK = m(0.04);
/** Clearance for water over the triangulated terrain between grid corners. */
export const POOL_TERRAIN_CLEARANCE = m(0.06);
/** Furthest a bank may reach from its platform. */
const PAD_REACH = m(40);

export interface Pad {
  readonly rings: readonly (readonly Vec2[])[];
  /** The platform's height under each ring, at a point (a car park falls with its street). */
  readonly levels: readonly ((x: number, y: number) => number)[];
  readonly water: readonly boolean[];
  /** Whether each ring is a paved lot (anything but grass and water). */
  readonly paved: readonly boolean[];
  readonly solidCount: number;
  /** Whether its blocks stand at floors of their own (a split level). */
  readonly stepped: boolean;
  readonly box: Aabb;
}

export interface BuildingPads {
  /** The graded height at a point, and how fully it replaces the land (0 or 1). */
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
  shapeBounds(): readonly Aabb[];
  readonly count: number;
}

/** Distance from a point to a closed ring: 0 inside it. */
function ringDistance(ring: readonly Vec2[], x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    if ((b.y > y) !== (a.y > y) && x < ((a.x - b.x) * (y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
  }
  return inside ? 0 : best;
}

/**
 * The pads of every building. `apron` is the level margin round each
 * footprint: at least one cell of the ground mesh, so every cell a wall stands
 * in is level at all its corners.
 */
export function buildingPads(
  buildings: Iterable<Building>,
  naturalGround: GroundAt,
  pavedAt: PavedAt | undefined,
  apron: number,
  /**
   * Each building's platform as last worked out, by its record (a record is
   * replaced when the building changes): only a new or changed building is
   * worked out again. The caller drops it when the ground or the roads move.
   */
  known?: WeakMap<Building, Pad | null>,
): BuildingPads {
  const pads: Pad[] = [];
  for (const b of buildings) {
    if (known?.has(b)) { const pad = known.get(b); if (pad) pads.push(pad); continue; }
    const before = pads.length;
    padOf(b);
    known?.set(b, pads.length > before ? pads[pads.length - 1]! : null);
  }
  function padOf(b: Building): void {
    const built = solidFootprints(b);
    // Each block's own platform: a block at a floor of its own (a split
    // level, `Volume.lift`) has its own, as CityEngine aligns the terrain to
    // each shape at that shape's height.
    const lifts = groundVolumes(b).filter((v) => !v.open).map(volumeLift);
    const floor = floorHeight(b, naturalGround, pavedAt);
    // Under the building, level at the floor less the plinth; under its open
    // lots, the lot's own surface (`lots.ts`), which falls with the street.
    const lots = lotSurfaces(b, floor, pavedAt);
    const rings: (readonly Vec2[])[] = [...built, ...lots.map((l) => l.ring)];
    const water = [...built.map(() => false), ...lots.map((l) => l.volume.open === 'water')];
    if (rings.length === 0) return;
    const flat = floor - PLINTH_MIN;
    // A lawn IS the ground, graded to the lot's surface (it is drawn as the
    // terrain's own grass, and people walk on it at that height); paving,
    // gravel, sand and water are laid as a thin plate just over it.
    const levels = [...built.map((_, i) => { const level = flat + (lifts[i] ?? 0); return () => level; }), ...lots.map((l) => {
      const open = l.volume.open ?? 'grass';
      // A lawn is graded a little under the paving beside it, so a terrain
      // triangle reaching from the lawn into a car park never pokes up
      // through the asphalt (grass showing through the bays).
      const under = open === 'grass' ? LOT_PLATE * 3 : open === 'water'
        ? POOL_SINK + LOT_PLATE + POOL_TERRAIN_CLEARANCE : LOT_PLATE;
      return (x: number, y: number) => l.heightAt(x, y) - under;
    })];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
      for (const p of ring) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
    }
    const grow = apron + PAD_REACH;
    const paved = [...built.map(() => false), ...lots.map((l) => (l.volume.open ?? 'grass') !== 'grass' && l.volume.open !== 'water')];
    const stepped = lifts.some((l) => Math.abs(l) > 1e-6);
    pads.push({ rings, levels, water, paved, solidCount: built.length, stepped,
      box: { minX: minX - grow, minY: minY - grow, maxX: maxX + grow, maxY: maxY + grow } });
  }
  // The platforms filed under every grid cell their box reaches: a corner of
  // the ground asks only the ones over it. Every corner asked every platform
  // in the town, which on a town of six hundred buildings was seconds a pass.
  const CELL = m(25.6);
  const cells = new Map<number, Pad[]>();
  const cellKey = (cx: number, cy: number): number => cx * 100_003 + cy;
  for (const pad of pads) {
    for (let cx = Math.floor(pad.box.minX / CELL); cx <= Math.floor(pad.box.maxX / CELL); cx++) {
      for (let cy = Math.floor(pad.box.minY / CELL); cy <= Math.floor(pad.box.maxY / CELL); cy++) {
        const key = cellKey(cx, cy);
        const list = cells.get(key);
        if (list) list.push(pad); else cells.set(key, [pad]);
      }
    }
  }
  return {
    count: pads.length,
    shapeBounds: () => pads.map((p) => p.box),
    shapeAt(x, y, ground) {
      // The nearest platform decides: two buildings side by side share the
      // strip between them as each one's own apron, split down the middle.
      let nearest = Infinity;
      let level = 0;
      let owner: Pad | null = null;
      let solid = false;
      let waterDistance = Infinity;
      let waterLevel = 0;
      let waterOwner: Pad | null = null;
      // A split-level building's lowest block platform within an apron of the
      // point: where two of its blocks meet at different floors, the lower
      // one's excavation runs on under the edge of the upper one (hidden
      // under its floor, behind its plinth). Each on its own, the terrain
      // cell across the line rose as a bank of earth inside the lower room.
      let stepLow = Infinity;
      let stepPad: Pad | null = null;
      for (const pad of cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))) ?? []) {
        if (x < pad.box.minX || x > pad.box.maxX || y < pad.box.minY || y > pad.box.maxY) continue;
        pad.rings.forEach((ring, i) => {
          const d = ringDistance(ring, x, y);
          // Inside a paved lot (a car park, a yard), its plate decides, not a
          // lawn whose edge it shares.
          const paved = i >= pad.solidCount && !pad.water[i] && pad.paved[i];
          if (d < nearest || (d === 0 && paved && nearest === 0)) { nearest = d; level = pad.levels[i]!(x, y); owner = pad; solid = i < pad.solidCount; }
          if (pad.water[i] && d < waterDistance) { waterDistance = d; waterLevel = pad.levels[i]!(x, y); waterOwner = pad; }
          if (pad.stepped && i < pad.solidCount && d <= apron) {
            const l = pad.levels[i]!(x, y);
            if (l < stepLow) { stepLow = l; stepPad = pad; }
          }
        });
      }
      if (nearest === Infinity) return { height: ground, weight: 0 };
      if (solid && nearest === 0 && stepPad === owner && stepLow < level) level = stepLow;
      // A water basin is cut into the ground under its surrounding deck too.
      // Otherwise a terrain triangle whose outer corner reads the higher deck
      // crosses the lower water plane and leaves only a triangular fragment.
      // Cut, never filled: a pool on a terrace up the slope (a split-level's
      // raised garden) raised the ground under the house beside it.
      if ((waterOwner === owner || !solid) && apron > 0 && waterDistance < 2 * apron && waterLevel < level) {
        // A neighbouring open garden can own a terrain grid corner beside the
        // pool; its high corner would interpolate through the water. A solid
        // building's own platform remains protected from this excavation.
        const t = Math.min(1, (2 * apron - waterDistance) / apron);
        level += (waterLevel - level) * t * t * (3 - 2 * t);
      }
      const out = Math.max(0, nearest - apron) / PAD_BATTER;
      // Fill below the platform, cut above it, and the land itself once the
      // bank has met it.
      const height = ground < level ? Math.max(ground, level - out) : Math.min(ground, level + out);
      if (Math.abs(height - ground) < 1e-3) return { height: ground, weight: 0 };
      return { height, weight: 1 };
    },
  };
}
