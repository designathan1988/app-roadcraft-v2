import { FACE_HALF } from '@core/cubeSphere';
import { clamp } from '@core/scalar';
import type { Vec2 } from '@core/vec2';
import { FACE_REACH, clampToAtlas, faceCentre, insideAtlas } from './planet/atlas';

/**
 * How big the world is.
 *
 * The ground is a finite plate, and this is its size. It lived in
 * `render/terrain.ts`, which made it a fact about the PICTURE — so everything
 * that authored a position (a node, a pole) had no way to know where the world
 * ended, because `world` may not import `render`. The consequence was visible:
 * roads, poles and the street furniture hanging off them could be built past
 * the edge of the map, standing on nothing.
 *
 * It belongs here, where the document can see it.
 *
 * On the planet (`__PLANET__`) the world is six such plates, the cube's faces,
 * side by side in one plane (`planet/atlas.ts`): `MAP_SIZE` is then one face's
 * side, and `MAP_REGIONS` lists the plates.
 */
export const MAP_SIZE = __PLANET__ ? FACE_HALF * 2 : 4_800;
export const MAP_HALF = MAP_SIZE / 2;

/** One square plate of ground: its centre and half its side. */
export interface MapRegion {
  readonly cx: number;
  readonly cy: number;
  readonly half: number;
}

/** Every plate the world has: one about the origin, or the planet's six faces. */
export const MAP_REGIONS: readonly MapRegion[] = Object.freeze(
  __PLANET__
    ? Array.from({ length: 6 }, (_, f) => Object.freeze({ cx: faceCentre(f).x, cy: faceCentre(f).y, half: MAP_HALF }))
    : [Object.freeze({ cx: 0, cy: 0, half: MAP_HALF })],
);

/**
 * Half the side of the square about the origin that holds every plate (and
 * what reaches past them): `MAP_HALF` on the flat map. What is laid over the
 * whole world in one texture - the wear of the streets, the painted fog - is
 * laid over this.
 */
export const WORLD_HALF = __PLANET__
  ? Math.max(...MAP_REGIONS.map((r) => Math.max(Math.abs(r.cx), Math.abs(r.cy)) + r.half)) + FACE_REACH
  : MAP_HALF;

/** The plate whose cell holds a point: the nearest one. */
export function regionAt(x: number, y: number): MapRegion {
  if (!__PLANET__) return MAP_REGIONS[0] as MapRegion;
  let best = MAP_REGIONS[0] as MapRegion, bestD = Infinity;
  for (const r of MAP_REGIONS) {
    const d = Math.max(Math.abs(x - r.cx), Math.abs(y - r.cy));
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/**
 * How far past its plate's edge a thing may reach: nothing on the flat map;
 * on the planet, over the face's border onto the neighbour's ground
 * (`planet/atlas.ts` FACE_REACH).
 */
export const MAP_REACH = __PLANET__ ? FACE_REACH : 0;

/**
 * How far inside the edge anything the player builds is kept.
 *
 * Not zero, because a road is WIDE: a centreline exactly on the rim puts half
 * a carriageway, its footway and its casing out over the void. The widest road
 * in the game is under 30 units of casing half-width, and a junction between
 * two of them reaches further still, so this is that with room to spare.
 *
 * Zero on the planet: a face's border is no rim, the neighbour's ground goes on.
 */
export const MAP_MARGIN = __PLANET__ ? 0 : 64;

/** Whether a point is on the plate at all. */
export const insideMap = (p: Vec2, margin = 0): boolean =>
  __PLANET__
    ? insideAtlas(p, margin)
    : p.x >= -MAP_HALF + margin &&
      p.x <= MAP_HALF - margin &&
      p.y >= -MAP_HALF + margin &&
      p.y <= MAP_HALF - margin;

/**
 * The nearest point on the plate to `p`.
 *
 * Clamping rather than refusing, and deliberately: a drag that runs off the
 * edge should build a road up to the edge, which is what the player was
 * plainly asking for. Refusing it would make the last stretch of a drag do
 * nothing, with no explanation.
 */
export const clampToMap = (p: Vec2, margin = MAP_MARGIN): Vec2 =>
  __PLANET__
    ? clampToAtlas(p, margin)
    : {
        x: clamp(p.x, -MAP_HALF + margin, MAP_HALF - margin),
        y: clamp(p.y, -MAP_HALF + margin, MAP_HALF - margin),
      };
