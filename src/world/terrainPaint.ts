/**
 * Ground the player paints over the terrain: sand, soil, meadow, snow,
 * gravel, asphalt, concrete - and grass, which paints the others away.
 *
 * Texture splatting, as engines store painted terrain layers: a weight per
 * layer per texel, four layers to an RGBA texture, the weights summing to at
 * most one and the terrain's own grass showing through the rest
 * (https://en.wikipedia.org/wiki/Texture_splatting). The document keeps the
 * DABS (where, how wide, how strong, which layer), so a painted map saves,
 * loads and undoes like the land stamps; the renderer rasterises them into
 * the weight textures (`render/terrain.ts`). Painting moves no height, so it
 * re-solves no road.
 */

/** The paintable layers, in channel order: two RGBA textures, then grass. */
export const PAINT_KINDS = ['sand', 'soil', 'meadow', 'snow', 'gravel', 'asphalt', 'concrete', 'grass'] as const;
export type PaintKind = (typeof PAINT_KINDS)[number];

export interface PaintDab {
  readonly kind: PaintKind;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** 0..1: how far one dab takes the ground to its layer at the centre. */
  readonly strength: number;
}

export function isPaintKind(value: unknown): value is PaintKind {
  return typeof value === 'string' && (PAINT_KINDS as readonly string[]).includes(value);
}

/** A map keeps at most this many dabs; the oldest go first. */
export const MAX_PAINT_DABS = 60_000;
