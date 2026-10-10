import { FACE_COUNT, FACE_HALF, type FaceId } from '@core/cubeSphere';
import { clamp } from '@core/scalar';
import type { Vec2 } from '@core/vec2';

/**
 * THE PLANET'S ATLAS: the six faces of the cube (`core/cubeSphere.ts`) laid
 * side by side on ONE plane, so the whole game - roads, junctions, buildings,
 * traffic, undo, saving - keeps working on a plane with no idea it is on a
 * planet. Only the picture is folded onto the sphere.
 *
 * Three faces a row, two rows, `ATLAS_PITCH` between centres: a face is
 * `2 FACE_HALF` square, and the gutter between two faces is the room what a
 * face owns may reach over its border (`FACE_REACH`) without touching what the
 * next square owns. A compact block round the origin keeps every coordinate
 * under 12 km, a millimetre in a 32-bit float, where the shaders read them.
 */

/** Centre to centre of two faces side by side in the atlas, metres. */
export const ATLAS_PITCH = 8000;

/** How far past its border what a face owns may reach (a junction's plate, a building). */
export const FACE_REACH = 300;

const centres: readonly Readonly<Vec2>[] = Array.from({ length: FACE_COUNT }, (_, f) => Object.freeze({
  x: ((f % 3) - 1) * ATLAS_PITCH,
  y: f < 3 ? ATLAS_PITCH / 2 : -ATLAS_PITCH / 2,
}));

/** A face's centre in the atlas. */
export const faceCentre = (face: number): Readonly<Vec2> => centres[face] as Vec2;

/** The face whose cell of the atlas holds a point: the nearest centre's (a third of the plane each, round its square). */
export function faceCellOf(x: number, y: number): FaceId {
  const col = clamp(Math.round(x / ATLAS_PITCH) + 1, 0, 2);
  const row = y >= 0 ? 0 : 1;
  return (row * 3 + col) as FaceId;
}

/** A point of the atlas in its face's own map: metres from the face's centre. */
export interface FaceLocal {
  face: FaceId;
  x: number;
  y: number;
}

/** A point of the atlas as its face's map point, into `out`. */
export function atlasToFaceInto(x: number, y: number, out: FaceLocal): FaceLocal {
  const face = faceCellOf(x, y);
  const c = centres[face] as Vec2;
  out.face = face;
  out.x = x - c.x;
  out.y = y - c.y;
  return out;
}

/** A face's map point in the atlas. */
export const faceToAtlas = (face: number, x: number, y: number): Vec2 => {
  const c = centres[face] as Vec2;
  return { x: c.x + x, y: c.y + y };
};

/** Whether an atlas point is on a face's square (with `margin` inside it). */
export function insideAtlas(p: Vec2, margin = 0): boolean {
  const c = centres[faceCellOf(p.x, p.y)] as Vec2;
  const h = FACE_HALF - margin;
  return Math.abs(p.x - c.x) <= h && Math.abs(p.y - c.y) <= h;
}

/** The nearest point of its cell's face square (with `margin` inside it). */
export function clampToAtlas(p: Vec2, margin = 0): Vec2 {
  const c = centres[faceCellOf(p.x, p.y)] as Vec2;
  const h = FACE_HALF - margin;
  return { x: clamp(p.x, c.x - h, c.x + h), y: clamp(p.y, c.y - h, c.y + h) };
}

/** The atlas's extent: every face square, with its reach. */
export const ATLAS_BOUNDS = Object.freeze({
  minX: -ATLAS_PITCH - FACE_HALF - FACE_REACH,
  maxX: ATLAS_PITCH + FACE_HALF + FACE_REACH,
  minY: -ATLAS_PITCH / 2 - FACE_HALF - FACE_REACH,
  maxY: ATLAS_PITCH / 2 + FACE_HALF + FACE_REACH,
});
