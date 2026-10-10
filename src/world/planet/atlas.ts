import { TILE_COUNT, TILE_HALF, onTile } from '@core/planetTiles';
import type { Vec2 } from '@core/vec2';

/**
 * THE PLANET'S ATLAS: its pieces (`core/planetTiles.ts`, 96 flat x, y maps)
 * laid side by side on ONE plane, so the whole game - roads, junctions,
 * buildings, traffic, undo, saving - keeps working on a plane with no idea it
 * is on a planet. Only the picture is folded onto the sphere.
 *
 * Twelve pieces a row, eight rows, `ATLAS_PITCH` between centres: a piece
 * lies within `TILE_HALF` of its centre on its own map, and the gutter round
 * it is the room what it owns may reach over its border (`TILE_REACH`)
 * without touching what the next cell owns. Every centre on a multiple of
 * 400 world units, so the terrain's 16-unit grid, the grid's 25 and the
 * plants' 12.5 fall on the same lines in every piece. The farthest
 * coordinate is under 19 km: two millimetres in a 32-bit float.
 */

/** Centre to centre of two pieces side by side in the atlas, world units. */
export const ATLAS_PITCH = 2800;
/** Pieces a row in the atlas. */
export const ATLAS_COLUMNS = 12;
/** How far past its border what a piece owns may reach (a junction's plate, a building). */
export const TILE_REACH = 300;

const centres: readonly Readonly<Vec2>[] = Array.from({ length: TILE_COUNT }, (_, t) => Object.freeze({
  x: ((t % ATLAS_COLUMNS) - 6) * ATLAS_PITCH,
  y: (Math.floor(t / ATLAS_COLUMNS) - 4) * ATLAS_PITCH,
}));

/** A piece's centre in the atlas. */
export const tileCentre = (tile: number): Readonly<Vec2> => centres[tile] as Vec2;

/** The piece whose cell of the atlas holds a point: the nearest centre's. */
export function tileCellOf(x: number, y: number): number {
  const col = Math.min(ATLAS_COLUMNS - 1, Math.max(0, Math.round(x / ATLAS_PITCH) + 6));
  const row = Math.min(TILE_COUNT / ATLAS_COLUMNS - 1, Math.max(0, Math.round(y / ATLAS_PITCH) + 4));
  return row * ATLAS_COLUMNS + col;
}

/** A point of the atlas in its piece's own map: about the piece's centre. */
export interface TileLocal {
  tile: number;
  x: number;
  y: number;
}

/** A point of the atlas as its piece's map point, into `out`. */
export function atlasToTileInto(x: number, y: number, out: TileLocal): TileLocal {
  const tile = tileCellOf(x, y);
  const c = centres[tile] as Vec2;
  out.tile = tile;
  out.x = x - c.x;
  out.y = y - c.y;
  return out;
}

/** A piece's map point in the atlas. */
export const tileToAtlas = (tile: number, x: number, y: number): Vec2 => {
  const c = centres[tile] as Vec2;
  return { x: c.x + x, y: c.y + y };
};

const local: TileLocal = { tile: 0, x: 0, y: 0 };

/** Whether an atlas point is on its cell's piece itself (not on a neighbour reached past the border). */
export function insideAtlas(p: Vec2): boolean {
  atlasToTileInto(p.x, p.y, local);
  return onTile(local.tile, local.x, local.y);
}

/** The point itself when it is on its cell's piece, else the nearest point of that piece towards its centre. */
export function clampToAtlas(p: Vec2): Vec2 {
  atlasToTileInto(p.x, p.y, local);
  if (onTile(local.tile, local.x, local.y)) return p;
  const tile = local.tile, x = local.x, y = local.y;
  // The share of the way to the centre: `off` still off the piece, `on` on it.
  let off = 0, on = 1;
  for (let k = 0; k < 30; k++) {
    const mid = (off + on) / 2;
    if (onTile(tile, x * (1 - mid), y * (1 - mid))) on = mid; else off = mid;
  }
  const c = centres[tile] as Vec2;
  return { x: c.x + x * (1 - on), y: c.y + y * (1 - on) };
}

/** Half the square about a piece's centre its ground is laid on (the terrain's plate): a cell over `TILE_HALF`, on the 16-unit grid. */
export const TILE_PLATE_HALF = Math.ceil(TILE_HALF / 16) * 16;
