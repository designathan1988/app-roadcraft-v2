import type { Rng } from '@core/rng';
import { m } from '../units';
import type { BlueprintBody } from './blueprints';
import { Model, mat } from './cityBuildings';
import { elementClash } from './elements';
import type { MaterialSpec } from './materials';
import { type BayComponent, type Building, type BuildingElement, type BuildingFunction, type FacadePattern, type RoofKind, type Volume, MIN_PITCH } from './types';

/**
 * Buildings made to measure for a lot, never the same twice.
 *
 * The lot planner (`editor/lotPlan.ts`) hands each building its envelope: the
 * part of the plot it stands on, after the front garden or forecourt, the side
 * drive or passage, and the yard or car park behind. The building fills it,
 * and what it leaves of the envelope it reports (`free`), so the lot gives
 * that a use too.
 *
 * VARIETY, as CityEngine's mass modelling gets it (Esri, "Tutorial 8: Mass
 * modeling"): the FORM of the mass is chosen by case on the envelope - its
 * proportions, its width - and then by a stochastic branch among the forms
 * that fit (a house: a box with a rear wing, an L with a wing brought forward
 * to the street and mirrored at random, a veranda house, a house with its
 * garage, a pair of stepped halves, a long bungalow; flats: a bar, an L, a
 * U, a stepped bar, a tower on a podium with recursive setbacks); every
 * dimension is a random attribute in a range; a colour SCHEME (wall family,
 * contrasting trim, roof, base) is drawn from data and nudged per building,
 * so no two are the same paint. Each building reports its `signature` - form,
 * colour, roof, height - and the growth picks, of a few candidates, the one
 * least like its neighbours (`editor/zoning.ts`).
 *
 * Facades have a hierarchy: a taller ground floor in its own material, a
 * string course over it, an entrance under a canopy or in a porch, upper
 * floors in a rhythm of piers, windows of one family and proportion, loggias
 * and projecting bays, a cornice on top. A style (classic, modern, deco,
 * brick, house) keeps the parts of one building consistent.
 *
 * Sizes are metres in the building's local frame, the street along -y.
 */

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** What the eye tells two buildings apart by. */
export interface Signature {
  /** The form of the mass (`house:ell`, `flats:u`, `office:setback`...). */
  readonly form: string;
  /** The main wall colour, 0xRRGGBB. */
  readonly colour: number;
  /** The main roof: its kind and colour. */
  readonly roof: string;
  /** Storeys of the tallest block. */
  readonly storeys: number;
}

export interface MadeBuilding {
  /**
   * What the eye tells two buildings apart by: the form of the mass, its
   * wall colour, its roof, its height. Read by the growth's choice among
   * candidates (`editor/zoning.ts`), so a street does not repeat itself.
   */
  readonly signature: Signature;
  readonly fn: BuildingFunction;
  readonly body: BlueprintBody;
  /** The front door's middle, metres along the front from the envelope's left. */
  readonly entrance: number;
  /** A back door's middle (metres from the envelope's left), when it has one. */
  readonly backDoor?: number;
  /** Parts of the envelope it leaves open (metres, envelope frame). */
  readonly free: Rect[];
}

/** What the lot asks of the building. */
export interface Envelope {
  /** Width and depth, metres. */
  readonly W: number;
  readonly D: number;
  /** Where the front door should be (metres from the left), if the lot has a path to it. */
  readonly door?: number;
  /** The yard or car park behind wants a back door. */
  readonly backDoor?: boolean;
  /** The street's family of materials (one per street side), so a street reads as one. */
  readonly character?: number;
  /** The side the lot's drive runs down, if it has one: a garage goes beside it. */
  readonly driveSide?: 'left' | 'right';
  /** Storeys of the buildings either side, if any: a block steps towards them instead of towering over a house. */
  readonly neighbours?: readonly number[];
}

const pickOf = <T>(rng: Rng, list: readonly T[]): T => list[rng.int(0, list.length - 1)] as T;
const between = (rng: Rng, a: number, b: number): number => a + (b - a) * rng.float();
const pat = (pattern: FacadePattern | undefined): { pattern?: FacadePattern } => (pattern ? { pattern } : {});
/** Rounds to the 0.5 m the Builder's grid uses. */
const half = (x: number): number => Math.round(x * 2) / 2;

// ---------------------------------------------------------------- colour schemes

/**
 * A colour nudged in hue, saturation and lightness, a little: two buildings
 * drawn from the same entry of a palette are never the same paint, as two
 * houses painted "the same yellow" years apart are not.
 */
function nudge(colour: number, rng: Rng, amount = 1): number {
  const r = ((colour >> 16) & 255) / 255, g = ((colour >> 8) & 255) / 255, b = (colour & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  const h2 = (h + (rng.float() - 0.5) * 0.03 * amount + 1) % 1;
  const s2 = Math.max(0, Math.min(1, s + (rng.float() - 0.5) * 0.1 * amount));
  const l2 = Math.max(0.05, Math.min(0.96, l + (rng.float() - 0.5) * 0.08 * amount));
  const q = l2 < 0.5 ? l2 * (1 + s2) : l2 + s2 - l2 * s2, p = 2 * l2 - q;
  const ch = (t: number): number => {
    const u = (t + 1) % 1;
    const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  return (ch(h2 + 1 / 3) << 16) | (ch(h2) << 8) | ch(h2 - 1 / 3);
}

/**
 * House walls by family - whites and creams, yellows and ochres, peaches and
 * terracottas, greens, blues, lilacs and pinks, greys - the paints of a
 * Brazilian street. A street leans to a family (`Envelope.character`), never
 * wholly: one house in three or more breaks from it.
 */
const HOUSE_FAMILIES: readonly (readonly number[])[] = [
  [0xf2ead8, 0xf6f1e6, 0xe9dcc0, 0xf0e4cc, 0xe4d6bc],
  [0xf1d98a, 0xe8c66a, 0xf3e1a6, 0xd6a85a, 0xe9cf8f],
  [0xf0c4a4, 0xe8a98a, 0xf2d0bc, 0xc9714f, 0xd98e6a],
  [0xb9d3b0, 0x9fc4a8, 0xcfe0c3, 0x7fa88f, 0xa8dcc8],
  [0xb8d0e0, 0x9cbcd6, 0xd5e3ec, 0x7d9fbf, 0xa9c6c9],
  [0xd9c2d8, 0xeac6cc, 0xe3cfd9, 0xc7a7b8],
  [0xc8c8c4, 0x9d9f9e, 0xdcdad3, 0x7c8084, 0xb3aea4],
];
/** Flats and shops: renders, ceramic tile cladding, brick, concrete. */
const BLOCK_WALLS: readonly MaterialSpec[] = [
  mat('plaster', 0xeae3d6), mat('plaster', 0xf3f1ec), mat('stucco', 0xe8dcc2), mat('plaster', 0xf1e4c9),
  mat('stucco', 0xd9c6a8), mat('plaster', 0xe6d2c4), mat('plaster', 0xcfd8d2), mat('plaster', 0xe9d8b4),
  mat('plaster', 0xd7e0e6), mat('stucco', 0xf0d9b5), mat('plaster', 0xc9d6c0), mat('plaster', 0xe8c9b8),
  mat('plaster', 0xb9cbd8), mat('stucco', 0xd8b49a), mat('plaster', 0xa9bfa4), mat('plaster', 0xe3b9a0),
  mat('ceramic', 0xe8e4dc), mat('ceramic', 0xb7c4cc), mat('ceramic', 0x9aa6a0), mat('ceramic', 0xd8c8a8),
  mat('ceramic', 0xc4b29c), mat('ceramic', 0x8e9aa4), mat('concrete', 0xbcbab3), mat('concrete', 0xa9aaa5),
];
const BRICKS: readonly MaterialSpec[] = [
  mat('brick', 0xa4563f), mat('brick', 0x8c4a35), mat('brick', 0xb86a4a), mat('brick', 0x9a6a52), mat('brick', 0xc08060),
  mat('brick', 0x7d5444), mat('brick', 0xb59a80),
];
const HARD: readonly MaterialSpec[] = [
  mat('concrete', 0xbcbab3), mat('stone', 0xcfc7b6), mat('ceramic', 0xd8d4cc), mat('concrete', 0xa9aaa5), mat('stone', 0xb9ae98),
  mat('ceramic', 0x9e9a92), mat('stone', 0xd9cdb4),
];
/** Ground floors: darker, harder wearing than the floors above. */
const BASES: readonly MaterialSpec[] = [
  mat('stone', 0x8f877a), mat('stone', 0x6f6a64), mat('ceramic', 0x5f6366), mat('stone', 0xa49880), mat('ceramic', 0x7b6a5c),
  mat('concrete', 0x8e8d88), mat('stone', 0x5a5550), mat('brick', 0x8c4a35), mat('ceramic', 0x4f5a5e),
];
const GLASSY: readonly MaterialSpec[] = [
  mat('glass', 0x8fb0c0), mat('glass', 0x6f8f9f), mat('glass', 0x9fb8b0), mat('panel', 0x8f9ba5), mat('glass', 0x7d97b5),
  mat('panel', 0xb4b8b6), mat('glass', 0x5d7280), mat('glass', 0x88a39a), mat('panel', 0x6b7780), mat('glass', 0xa7b5bd),
];
const SHEDS: readonly MaterialSpec[] = [
  mat('panel', 0x8f9ba5), mat('panel', 0xa3a9a6), mat('panel', 0x9aa49a), mat('metal', 0xb7b2a6), mat('panel', 0x7f8b8f),
  mat('concrete', 0xb0aca2), mat('panel', 0x6f7f8c), mat('panel', 0x8a9a7c), mat('panel', 0xc2b8a3), mat('metal', 0x7c8a96),
];
/** Pitched roofs: clay tiles in their reds and browns, slate, fibre-cement and metal sheet. */
const ROOF_TILES: readonly MaterialSpec[] = [
  mat('tile', 0xb5603f), mat('tile', 0x8f4a35), mat('slate', 0x55595e), mat('roofing', 0x6b5a4c), mat('tile', 0x7a3f32),
  mat('slate', 0x3f4a52), mat('tile', 0xa86d4a), mat('tile', 0xc06a45), mat('tile', 0x9c4f3a), mat('roofing', 0x9a9a94),
  mat('metal', 0x4f6b55), mat('metal', 0x6e3b32), mat('tile', 0x6b5f57),
];
/** Window frames, sills and cornices: white, off-white, dark grey, wood. */
const TRIMS: readonly MaterialSpec[] = [
  mat('plaster', 0xf7f5ef), mat('plaster', 0xe8e2d4), mat('plaster', 0x3b3d3f), mat('wood', 0x7a5536), mat('plaster', 0xf7f5ef),
];
const AWNINGS = [0xb8382e, 0x2f6b4f, 0x2f4f7a, 0xd9a43a, 0x6b3f6b, 0x3d3d3d, 0xc7652f, 0x1f5f6b, 0x8a2f3c, 0x3f7f8f, 0x5c6b2f, 0xd06d8a];

interface Scheme {
  readonly wall: MaterialSpec;
  readonly trim: MaterialSpec;
  readonly roof: MaterialSpec;
  readonly base: MaterialSpec | null;
  /** A second wall paint of the same scheme, for a wing, a stepped half or a top floor. */
  readonly accent: MaterialSpec;
}

/** Lightness, 0..1, of a colour. */
const lightness = (c: number): number => (Math.max((c >> 16) & 255, (c >> 8) & 255, c & 255) + Math.min((c >> 16) & 255, (c >> 8) & 255, c & 255)) / 510;

/** A house's paints: a wall of the street's family most of the time, its own otherwise; a trim that shows on it. */
function houseScheme(rng: Rng, character: number | undefined): Scheme {
  const family = character !== undefined && rng.float() < 0.45 ? HOUSE_FAMILIES[character % HOUSE_FAMILIES.length]! : pickOf(rng, HOUSE_FAMILIES);
  const roll = rng.float();
  const colour = nudge(pickOf(rng, family), rng);
  // Mostly render; some exposed brick, some timber cladding, some tile cladding.
  const wall = roll < 0.12 ? { ...pickOf(rng, BRICKS), colour: nudge(pickOf(rng, BRICKS).colour, rng, 0.6) }
    : roll < 0.18 ? mat('wood', nudge(0x9c6b43, rng, 1.5)) : roll < 0.24 ? mat('ceramic', colour) : mat(rng.float() < 0.7 ? 'plaster' : 'stucco', colour);
  const light = lightness(wall.colour) > 0.72;
  const trim = light && rng.float() < 0.35 ? pickOf(rng, [TRIMS[2]!, TRIMS[3]!]) : rng.float() < 0.8 ? TRIMS[0]! : pickOf(rng, TRIMS);
  const accent = mat('plaster', nudge(pickOf(rng, pickOf(rng, HOUSE_FAMILIES)), rng));
  const roof = { ...pickOf(rng, ROOF_TILES) };
  return { wall, trim, roof: { ...roof, colour: nudge(roof.colour, rng, 0.5) }, base: rng.float() < 0.4 ? pickOf(rng, BASES) : null, accent };
}

/** A block's paints: render, tiles, brick or concrete, a base, a contrasting top or wing. */
function blockScheme(rng: Rng, character: number | undefined, brick: boolean): Scheme {
  const lean = character !== undefined && rng.float() < 0.4;
  const base = brick ? pickOf(rng, BRICKS) : lean ? BLOCK_WALLS[character! % BLOCK_WALLS.length]! : pickOf(rng, BLOCK_WALLS);
  const wall = { ...base, colour: nudge(base.colour, rng) };
  const accentBase = pickOf(rng, [...BLOCK_WALLS, ...HARD]);
  return {
    wall, trim: rng.float() < 0.75 ? TRIMS[0]! : pickOf(rng, TRIMS), roof: pickOf(rng, ROOF_TILES), base: pickOf(rng, BASES),
    accent: { ...accentBase, colour: nudge(accentBase.colour, rng) },
  };
}

type Style = 'classic' | 'modern' | 'deco' | 'brick' | 'house';

// ---------------------------------------------------------------- facade dress

const levelZ = (body: BlueprintBody, level: number): number =>
  level <= 0 ? 0 : body.groundHeight + (level - 1) * body.storeyHeight;

/** Adds a facade part (a canopy, a cornice) unless it would cut into the building. */
function hang(body: BlueprintBody, el: Omit<BuildingElement, 'id'>): void {
  const elements = (body.elements ??= []);
  if (elements.length >= 96) return;
  const draft = { ...el, id: 0 } as BuildingElement;
  if (elementClash({ ...body, id: 0, x: 0, y: 0, rotation: 0 } as Building, draft)) return;
  draft.id = Math.max(0, ...elements.map((e) => e.id)) + 1;
  elements.push(draft);
  (body as { nextElementId?: number }).nextElementId = draft.id + 1;
}

/** A band along a volume's face at height `z`: a cornice, a string course, a slab edge. */
function band(body: BlueprintBody, v: Volume, side: 0 | 1 | 2 | 3, z: number, out: number, tall: number): void {
  const [x, y, w] = side === 0 ? [v.x + v.w / 2, v.y - out / 2, v.w + out * 2]
    : side === 2 ? [v.x + v.w / 2, v.y + v.d + out / 2, v.w + out * 2]
    : side === 1 ? [v.x + v.w + out / 2, v.y + v.d / 2, v.d + out * 2]
    : [v.x - out / 2, v.y + v.d / 2, v.d + out * 2];
  // In pieces no longer than a part may be.
  const pieces = Math.ceil(w / m(36));
  const alongX = side === 0 || side === 2;
  for (let k = 0; k < pieces; k++) {
    const off = (k + 0.5) * (w / pieces) - w / 2;
    hang(body, { kind: 'canopy', x: alongX ? x + off : x, y: alongX ? y : y + off, facing: side, w: w / pieces, d: out, z: Math.max(0, z), h: tall });
  }
}

const bayCount = (length: number): number => Math.max(1, Math.round(length / m(3)));

/**
 * Dresses the solid blocks of a body in a style: proportions of the openings,
 * piers, the ground floor's own material, porches and loggias, string course
 * and cornice. `entrance` is the door's middle (units, local x) on the front.
 */
function dressFacades(body: BlueprintBody, style: Style, rng: Rng, entrance: number, base: MaterialSpec | null, front?: Volume): void {
  const solid = body.volumes.filter((v) => !v.open);
  const top = (v: Volume): number => v.base + v.storeys.length;
  const proportions: Record<Style, { windowWidth: number; windowHeight: number; sill: number }> = {
    classic: { windowWidth: between(rng, 0.38, 0.46), windowHeight: between(rng, 0.58, 0.66), sill: m(0.9) },
    modern: { windowWidth: between(rng, 0.65, 0.85), windowHeight: between(rng, 0.5, 0.62), sill: m(0.75) },
    deco: { windowWidth: 0.38, windowHeight: 0.7, sill: m(0.8) },
    brick: { windowWidth: between(rng, 0.45, 0.55), windowHeight: 0.6, sill: m(0.85) },
    house: { windowWidth: between(rng, 0.38, 0.6), windowHeight: between(rng, 0.5, 0.6), sill: m(1) },
  };
  const proportion = proportions[style];
  for (const v of solid) {
    const sides = [0, 1, 2, 3] as const;
    const pier = style === 'classic' ? { pierWidth: m(0.45), pierDepth: m(0.18), pierEvery: rng.int(1, 2) }
      : style === 'deco' ? { pierWidth: m(0.6), pierDepth: m(0.35), pierEvery: 2 }
      : style === 'brick' ? { pierWidth: m(0.35), pierDepth: m(0.12), pierEvery: 1 }
      : null;
    const geometry = { ...proportion, ...(pier && v.storeys.length >= 3 ? pier : {}) };
    v.facadeGeometry = Object.fromEntries(sides.map((s) => [s, { ...geometry }]));
    // The ground floor in its own, harder material: the base of the building.
    if (base && v.base === 0 && top(v) >= 2) {
      v.storeys[0]!.materials = Object.fromEntries(sides.map((s) => [s, base]));
    }
  }
  // The entrance: a porch let into the front of the ground floor, or a canopy over it.
  const door = front ?? solid.filter((v) => v.base === 0).sort((p, q) => p.y - q.y)[0];
  if (door) {
    const across = bayCount(door.w);
    const bay = Math.max(0, Math.min(across - 1, Math.floor(((entrance - door.x) / door.w) * across)));
    const bw = door.w / across;
    if (style !== 'modern' && rng.float() < 0.45 && door.w > m(6)) {
      door.reliefs = [...(door.reliefs ?? []), { side: 0, bay0: bay, bay1: bay, storey0: 0, storey1: 0, depth: -m(1.2) }];
    } else {
      const z = Math.min(body.groundHeight - m(0.35), m(3.1));
      hang(body, { kind: 'canopy', x: door.x + (bay + 0.5) * bw, y: door.y - m(0.8), facing: 0, w: Math.min(m(4), bw + m(1)), d: m(1.6), z, h: m(0.18) });
    }
  }
  for (const v of solid) {
    const upper = v.storeys.length;
    if (upper < 2 && style === 'house') continue;
    // String course over the ground floor, on the street side.
    if (v.base === 0 && upper >= 2 && style !== 'modern') band(body, v, 0, levelZ(body, 1) - m(0.2), m(0.25), m(0.22));
    // Slab edges on a modern front: a line at every floor (a few, the budget is shared).
    if (style === 'modern' && upper >= 3) {
      for (let s = 1; s < Math.min(upper, 7); s++) band(body, v, 0, levelZ(body, v.base + s) - m(0.15), m(0.3), m(0.2));
    }
    // The cornice: on every face of a flat-roofed block of two floors or more.
    if ((v.roof === 'flat' || v.roof === 'terrace') && upper >= 2) {
      const z = levelZ(body, top(v)) - m(0.4);
      const out = style === 'classic' || style === 'deco' ? m(0.55) : m(0.3);
      for (const s of [0, 1, 2, 3] as const) band(body, v, s, z, out, m(0.4));
    }
    // Loggias and projecting bays on the floors above the street.
    if (upper >= 4 && v.w >= m(9)) {
      const across = bayCount(v.w);
      const lo = v.base === 0 ? 1 : 0;
      if (style === 'modern' || style === 'brick') {
        // Recessed loggias, every second, third or fourth column.
        const every = rng.int(2, 4);
        const reliefs = [];
        for (let i = 1; i < across - 1; i += every) reliefs.push({ side: 0 as const, bay0: i, bay1: i, storey0: lo, storey1: upper - 1, depth: -m(1.1) });
        v.reliefs = [...(v.reliefs ?? []), ...reliefs];
        for (let s = lo; s < upper; s++) {
          const f = v.storeys[s]!.facade;
          for (const r of reliefs) f.bays = { ...(f.bays ?? {}), [`0:${r.bay0}`]: 'frenchWindow' };
        }
      } else if (across >= 4) {
        // The end bays brought forward: the building reads as a centre and two wings.
        v.reliefs = [...(v.reliefs ?? []),
          { side: 0, bay0: 0, bay1: 0, storey0: lo, storey1: upper - 1, depth: m(0.5) },
          { side: 0, bay0: across - 1, bay1: across - 1, storey0: lo, storey1: upper - 1, depth: m(0.5) }];
      }
    }
  }
}

/** Moves the door of a block's front to the bay holding `x` (units, local). */
function doorAt(v: Volume, x: number, kind: BayComponent): number {
  const across = bayCount(v.w);
  const bay = Math.max(0, Math.min(across - 1, Math.floor(((x - v.x) / v.w) * across)));
  const f = v.storeys[0]!.facade;
  const bays = Object.fromEntries(Object.entries(f.bays ?? {}).filter(([, c]) => c !== 'door' && c !== 'doubleDoor'));
  f.bays = { ...bays, [`0:${bay}`]: kind };
  return v.x + ((bay + 0.5) * v.w) / across;
}

/** A back door on the rear of the block at the back, near the middle. */
function backDoorOn(v: Volume): number {
  const across = bayCount(v.w);
  const bay = Math.floor(across / 2);
  const f = v.storeys[0]!.facade;
  f.bays = { ...(f.bays ?? {}), [`2:${bay}`]: 'door' };
  return v.x + ((bay + 0.5) * v.w) / across;
}

/** The signature of a body made: its form, its main wall and roof, its height. */
function signatureOf(form: string, body: BlueprintBody): Signature {
  const solid = body.volumes.filter((v) => !v.open);
  const main = [...solid].sort((p, q) => q.w * q.d - p.w * p.d)[0];
  const wall = main?.materials?.wall ?? body.materials?.wall;
  const roof = main?.materials?.roof ?? body.materials?.roof;
  return {
    form,
    colour: wall?.colour ?? 0,
    roof: `${main?.roof ?? 'flat'}:${roof ? `${roof.finish}${roof.colour}` : ''}`,
    storeys: Math.max(0, ...solid.map((v) => v.base + v.storeys.length)),
  };
}

function finish(fn: BuildingFunction, form: string, body: BlueprintBody, env: Envelope, rng: Rng, style: Style, base: MaterialSpec | null,
  free: Rect[], doorKind: BayComponent = 'door', doorBlock?: Volume): MadeBuilding {
  body.function = fn;
  // Every pitched roof given its pitch (a wing's lean-to left at the default
  // 12 degrees rose a storey over a deep kitchen).
  for (const v of body.volumes) if (v.pitch === undefined) roofShape(v, rng);
  const solid = body.volumes.filter((v) => !v.open && v.base === 0);
  const front = doorBlock ?? solid.sort((p, q) => p.y - q.y || q.w - p.w)[0]!;
  const want = m(env.door ?? env.W / 2);
  const entrance = doorAt(front, Math.max(front.x, Math.min(front.x + front.w, want)), doorKind);
  const backBlock = [...solid].sort((p, q) => q.y + q.d - (p.y + p.d))[0]!;
  const back = env.backDoor ? backDoorOn(backBlock) : undefined;
  dressFacades(body, style, rng, entrance, base, front);
  return { signature: signatureOf(form, body), fn, body, entrance: entrance / m(1), ...(back !== undefined ? { backDoor: back / m(1) } : {}), free };
}

/**
 * The most a roof rises over its eaves, metres: a gable or a hip about a
 * storey (a house's attic), a lean-to and a sawtooth tooth a couple of
 * metres. A pitch drawn for a small house on a deep block or a hall made a
 * lean-to rise 10 m from the gutter - a wedge "from the ground to the top"
 * (the player, 2026-10-09).
 */
export const MAX_ROOF_RISE: Partial<Record<RoofKind, number>> = { gable: 3.2, hip: 3.2, shed: 1.2, sawtooth: 2 };
/**
 * Pitches drawn, degrees, as built: clay tiles 20-35 (a tile roof needs about
 * 17 degrees or more to shed rain), a lean-to's metal or fibre-cement sheet
 * 5-14 (sheet roofs are laid at 3-15 degrees).
 */
const PITCH: Partial<Record<RoofKind, readonly [number, number]>> = { gable: [20, 35], hip: [20, 32], shed: [5, 14], sawtooth: [22, 30] };

/**
 * Pitch and ridge of a pitched roof, drawn: a gable end to the street one
 * time in three; the pitch then lowered until the roof rises no more than a
 * real one over its span (`MAX_ROOF_RISE`): a hall's wide roof is low, a
 * house's steep. A span too wide for even the lowest pitch is roofed flat
 * behind a parapet, as a deep block is.
 */
function roofShape(v: Volume, rng: Rng, ridgeToStreet = rng.float() < 0.33): void {
  if (v.roof === 'flat' || v.roof === 'terrace') return;
  if (v.roof === 'gable' || v.roof === 'hip') v.ridge = ridgeToStreet ? 'y' : 'x';
  // A lean-to falls across the short way, as one is built: falling the long
  // way, its rise over the span was a storey or more.
  if (v.roof === 'shed' && v.fall === undefined && v.w < v.d) v.fall = 1;
  const [lo, hi] = PITCH[v.roof] ?? [20, 30];
  const run = v.roof === 'shed' ? ((v.fall ?? 0) % 2 === 0 ? v.d : v.w)
    : v.roof === 'sawtooth' ? Math.min(m(6), v.d) / 2
    : ((v.ridge ? v.ridge === 'x' : v.w >= v.d) ? v.d : v.w) / 2;
  const cap = (Math.atan(m(MAX_ROOF_RISE[v.roof] ?? 3) / Math.max(run, 1e-6)) * 180) / Math.PI;
  if (cap < MIN_PITCH * 0.66) { v.roof = 'flat'; delete v.pitch; delete v.ridge; delete v.fall; return; }
  v.pitch = Math.max(MIN_PITCH, Math.floor(Math.min(between(rng, lo, hi), cap)));
}

// ---------------------------------------------------------------- the kinds

type HouseForm = 'wing' | 'ell' | 'veranda' | 'garage' | 'twin' | 'bungalow';

/**
 * A house, in one of six forms chosen by case on the envelope and then at
 * random among those that fit (CityEngine's `LUShape` case on proportions,
 * then a stochastic branch):
 * - wing: the main body across the width, a kitchen wing behind on one side;
 * - ell: a wing brought forward to the street on one side (mirrored at
 *   random), its gable to the street, the door in the corner beside it;
 * - veranda: the house set back behind a covered veranda on posts;
 * - garage: a garage on the drive's side, set back from the house front;
 * - twin: two halves, one taller and set back, in two paints of one scheme;
 * - bungalow: long and low, a hipped roof, a porch over the door.
 */
function house(rng: Rng, env: Envelope): MadeBuilding {
  const { W, D } = env;
  const s = houseScheme(rng, env.character);
  const model = new Model('house', 'residential', rng.int(0, 7)).heights(between(rng, 2.8, 3.3), between(rng, 2.8, 3.1)).look(s.wall, s.roof, s.trim);
  const storeys = rng.float() < 0.5 ? 2 : 1;
  const roof = pickOf(rng, ['gable', 'gable', 'hip', 'hip', 'shed', 'flat'] as const satisfies readonly RoofKind[]);
  const windows = pickOf(rng, ['window', 'sashWindow', 'frenchWindow', 'window', 'wideWindow', 'bayWindow'] as const satisfies readonly BayComponent[]);
  const w = half(W), d = half(D);
  const forms: HouseForm[] = ['wing', 'veranda'];
  if (W >= 10) forms.push('ell', 'twin');
  if (W >= 11 && env.driveSide) forms.push('garage');
  if (W >= 12 && D <= 14) forms.push('bungalow', 'bungalow');
  const form = pickOf(rng, forms);
  const free: Rect[] = [];
  let doorBlock: Volume | undefined;
  const body = (() => {
    switch (form) {
      case 'ell': {
        const wingW = half(Math.min(w * 0.45, between(rng, 3.5, 5)));
        const step = half(Math.min(d * 0.35, between(rng, 2, 3.5)));
        const left = rng.float() < 0.5;
        const mainD = half(Math.min(d - step, between(rng, 7.5, 10)));
        model.block({ x: 0, y: step, w, d: mainD, storeys, roof, fill: windows });
        model.block({ x: left ? 0 : w - wingW, y: 0, w: wingW, d: step + half(mainD * 0.6), storeys: rng.float() < 0.6 ? storeys : 1, roof: 'gable', fill: windows });
        // The corner in front of the door: a little paved patio.
        free.push(left ? { x0: wingW, y0: 0, x1: w, y1: step } : { x0: 0, y0: 0, x1: w - wingW, y1: step });
        const b = model.build();
        doorBlock = b.volumes[0];
        roofShape(b.volumes[0]!, rng, false);
        roofShape(b.volumes[1]!, rng, true);
        return b;
      }
      case 'veranda': {
        const deep = half(between(rng, 1.8, 2.6));
        const mainD = half(Math.min(d - deep, between(rng, 8, 11)));
        model.block({ x: 0, y: deep, w, d: mainD, storeys, roof, fill: windows });
        if (d - deep - mainD >= 2.5 && rng.float() < 0.6) {
          const ww = half(Math.max(Math.min(w, 4), w * between(rng, 0.4, 0.6)));
          model.block({ x: rng.float() < 0.5 ? 0 : w - ww, y: deep + mainD, w: ww, d: half(d - deep - mainD), storeys: 1, roof: 'flat', fill: 'window' });
        }
        const b = model.build();
        roofShape(b.volumes[0]!, rng);
        // The veranda: its floor, a roof over it on posts at its front edge.
        const vx0 = m(0.3), vx1 = m(w - 0.3);
        const span = rng.float() < 0.5 ? [vx0, vx1] : [vx0, m(Math.max(3.5, w * 0.6))];
        const vw = span[1]! - span[0]!, cx = (span[0]! + span[1]!) / 2;
        hang(b, { kind: 'pavement', x: cx, y: m(deep / 2), facing: 0, w: vw, d: m(deep), z: 0, h: m(0.15), material: mat('ceramic', nudge(0xb5654a, rng)) });
        hang(b, { kind: 'slab', x: cx, y: m(deep / 2 - 0.05), facing: 0, w: vw + m(0.3), d: m(deep - 0.1), z: b.groundHeight - m(0.2), h: m(0.16), material: s.trim });
        const posts = Math.max(2, Math.round(vw / m(2.6)) + 1);
        for (let k = 0; k < posts; k++) {
          hang(b, { kind: 'pillar', x: span[0]! + m(0.15) + ((vw - m(0.3)) * k) / (posts - 1), y: m(0.2), facing: 0, w: m(0.2), d: m(0.2), z: 0, h: b.groundHeight - m(0.2), material: s.trim });
        }
        return b;
      }
      case 'garage': {
        const gw = half(between(rng, 3, 3.6));
        const onLeft = env.driveSide === 'left';
        const mainD = half(Math.min(d, between(rng, 8, 10.5)));
        const back = half(between(rng, 0.5, 2));
        model.block({ x: onLeft ? gw : 0, y: 0, w: w - gw, d: mainD, storeys, roof, fill: windows });
        model.block({ x: onLeft ? 0 : w - gw, y: back, w: gw, d: half(Math.min(d - back, 6)), storeys: 1, roof: rng.float() < 0.5 ? 'flat' : 'shed', fill: 'wall', ground: 'wall' });
        const b = model.build();
        doorBlock = b.volumes[0];
        roofShape(b.volumes[0]!, rng);
        // The garage door on its front.
        const g = b.volumes[1]!;
        g.storeys[0]!.facade.bays = { '0:0': 'garageDoor' };
        g.materials = { wall: s.accent };
        return b;
      }
      case 'twin': {
        const split = half(w * between(rng, 0.42, 0.58));
        const setback = half(between(rng, 0.8, 2));
        const tallLeft = rng.float() < 0.5;
        const mainD = half(Math.min(d - setback, between(rng, 8, 10)));
        model.block({ x: 0, y: tallLeft ? 0 : setback, w: split, d: mainD, storeys: tallLeft ? 2 : 1, roof, fill: windows });
        model.block({ x: split, y: tallLeft ? setback : 0, w: w - split, d: mainD, storeys: tallLeft ? 1 : 2, roof: pickOf(rng, ['gable', 'hip', 'shed', 'flat'] as const), fill: windows });
        const b = model.build();
        roofShape(b.volumes[0]!, rng);
        roofShape(b.volumes[1]!, rng);
        b.volumes[1]!.materials = { wall: s.accent };
        return b;
      }
      case 'bungalow': {
        const mainD = half(Math.min(d, between(rng, 7.5, 10)));
        model.block({ x: 0, y: 0, w, d: mainD, storeys: 1, roof: 'hip', fill: windows });
        const b = model.build();
        roofShape(b.volumes[0]!, rng, false);
        b.volumes[0]!.pitch = Math.round(between(rng, 20, 28));
        return b;
      }
      default: {
        // The main body across the whole width; behind it, the kitchen wing and a terrace beside it.
        const mainD = half(Math.min(d, between(rng, 7.5, 10)));
        model.block({ x: 0, y: 0, w, d: mainD, storeys, roof, fill: windows });
        if (d - mainD >= 2) {
          const ww = half(Math.max(Math.min(w, 4), w * between(rng, 0.45, 0.7)));
          const left = rng.float() < 0.5;
          model.block({ x: left ? 0 : w - ww, y: mainD, w: ww, d: half(d - mainD), storeys: 1,
            roof: pickOf(rng, ['flat', 'shed', roof] as const), fill: 'window' });
          if (w - ww >= 2) free.push(left ? { x0: ww, y0: mainD, x1: w, y1: d } : { x0: 0, y0: mainD, x1: w - ww, y1: d });
        }
        const b = model.build();
        roofShape(b.volumes[0]!, rng);
        return b;
      }
    }
  })();
  return finish('house', `house:${form}`, body, env, rng, 'house', s.base, free, rng.float() < 0.3 ? 'doubleDoor' : 'door', doorBlock);
}

/**
 * Recursive setbacks (CityEngine's `RecursiveSetbacks`): from `base`, a block
 * of `floors`, the top part again and again stepped in by a share of its size
 * while it is more than a few floors, each step a block of its own.
 */
function setbacks(model: Model, rng: Rng, x: number, y: number, w: number, d: number, base: number, floors: number,
  spec: { fill: BayComponent; pattern?: FacadePattern; roof: RoofKind }): void {
  let left = floors, at = base, bx = x, by = y, bw = w, bd = d;
  const scale = between(rng, 0.75, 0.9);
  for (let step = 0; left > 0; step++) {
    const part = left > 6 && step < 3 ? Math.max(3, Math.round(left * pickOf(rng, [0.4, 0.6]))) : left;
    model.block({ x: bx, y: by, w: bw, d: bd, base: at, storeys: part, fill: spec.fill, ...pat(spec.pattern), roof: part === left ? spec.roof : 'terrace' });
    at += part;
    left -= part;
    const nw = half(Math.max(8, bw * scale)), nd = half(Math.max(8, bd * scale));
    bx += half((bw - nw) / 2); by += half((bd - nd) / 2); bw = nw; bd = nd;
  }
}

/** Flats: a bar, an L or a U round a courtyard, stepped at the top; a tower on a podium when high. */
function flats(rng: Rng, env: Envelope, high: boolean): MadeBuilding {
  const { W, D } = env;
  const fn: BuildingFunction = high ? 'residentialTower' : 'apartments';
  const style = pickOf(rng, ['classic', 'modern', 'brick', 'deco', 'modern'] as const satisfies readonly Style[]);
  const s = blockScheme(rng, env.character, style === 'brick');
  const wall = style === 'modern' && rng.float() < 0.4 ? { ...pickOf(rng, HARD) } : s.wall;
  const model = new Model(fn, 'residential', rng.int(0, 7)).heights(between(rng, 3.8, 4.5), between(rng, 2.9, 3.1)).look(wall, s.roof, s.trim);
  // Next to low houses a block keeps nearer their height (a step, not a cliff).
  const near = env.neighbours?.length ? Math.max(...env.neighbours) : null;
  const cap = near !== null && !high ? Math.max(3, near + 3) : Infinity;
  const floors = high ? rng.int(9, 22) : Math.min(cap, rng.int(3, 7));
  const fill = pickOf(rng, ['balcony', 'window', 'frenchWindow', 'balcony', 'sashWindow', 'wideWindow', 'bayWindow'] as const satisfies readonly BayComponent[]);
  const ground = pickOf(rng, ['window', 'shopfront', 'window', 'wideWindow'] as const satisfies readonly BayComponent[]);
  const pattern = rng.float() < 0.25 ? pickOf(rng, ['residential', 'gallery'] as const satisfies readonly FacadePattern[]) : undefined;
  const roof = pickOf(rng, ['flat', 'terrace', 'flat', 'hip'] as const satisfies readonly RoofKind[]);
  const w = half(W), d = half(D);
  const free: Rect[] = [];
  const barD = half(Math.min(d, between(rng, 12, 15)));
  let form: string;
  if (high) {
    const podium = rng.int(1, 2);
    model.block({ x: 0, y: 0, w, d, storeys: podium, ground, fill: 'window', roof: 'terrace' });
    const inset = half(between(rng, 1.5, 3));
    const tw = Math.max(8, w - 2 * inset), td = Math.max(8, Math.min(d - 2 * inset, 22));
    if (rng.float() < 0.5) { form = 'tower:setback'; setbacks(model, rng, inset, inset, tw, td, podium, floors, { fill, ...pat(pattern), roof }); }
    else { form = 'tower'; model.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: floors, fill, ...pat(pattern), roof }); }
  } else if (d - barD >= 6 && w >= 20 && rng.float() < 0.5) {
    // A U: the street bar and two wings, the courtyard between them.
    form = 'flats:u';
    const ww = half(between(rng, 6, Math.min(9, w / 3)));
    const wingFloors = Math.max(2, floors - rng.int(0, 2));
    model.block({ x: 0, y: 0, w, d: barD, storeys: floors, ground, fill, ...pat(pattern), roof });
    model.block({ x: 0, y: barD, w: ww, d: d - barD, storeys: wingFloors, fill, roof, ...pat(pattern) });
    model.block({ x: w - ww, y: barD, w: ww, d: d - barD, storeys: wingFloors, fill, roof, ...pat(pattern) });
    free.push({ x0: ww, y0: barD, x1: w - ww, y1: d });
  } else if (d - barD >= 6 && w >= 14 && rng.float() < 0.7) {
    // An L: the bar and a wing behind, mirrored at random, a shorter wing one time in four.
    form = 'flats:l';
    const ww = half(between(rng, 7, Math.min(11, w / 2)));
    const left = rng.float() < 0.5;
    model.block({ x: 0, y: 0, w, d: barD, storeys: floors, ground, fill, ...pat(pattern), roof });
    model.block({ x: left ? 0 : w - ww, y: barD, w: ww, d: d - barD, storeys: rng.float() < 0.25 ? Math.max(2, Math.round(floors * 0.7)) : floors, fill, roof, ...pat(pattern) });
    free.push(left ? { x0: ww, y0: barD, x1: w, y1: d } : { x0: 0, y0: barD, x1: w - ww, y1: d });
  } else if (w >= 16 && rng.float() < 0.4) {
    // Two bars side by side, one taller and set back: a block of two buildings.
    form = 'flats:pair';
    const split = half(w * between(rng, 0.4, 0.6));
    const back = half(between(rng, 1, 2.5));
    model.block({ x: 0, y: 0, w: split, d, storeys: floors, ground, fill, ...pat(pattern), roof });
    model.block({ x: split, y: back, w: w - split, d: d - back, storeys: Math.max(2, floors + pickOf(rng, [-2, -1, 1, 2])), ground, fill, roof, ...pat(pattern) });
  } else {
    // A bar to the envelope's depth, its top floors stepped back from the street.
    form = 'flats:bar';
    const lower = floors >= 5 && rng.float() < 0.5 ? floors - rng.int(1, 2) : floors;
    model.block({ x: 0, y: 0, w, d, storeys: lower, ground, fill, ...pat(pattern), roof: lower < floors ? 'terrace' : roof });
    if (lower < floors && d >= 9) model.block({ x: 0, y: 2, w, d: d - 2, base: lower, storeys: floors - lower, fill, roof, ...pat(pattern) });
  }
  model.core('stairLift', half(w / 2 - 1.5), half(Math.min(d, 10) / 2 - 1.5), floors + (high ? 2 : 0));
  const body = model.build();
  // A second paint: the top floor in the accent, or a wing - one block in two.
  if (rng.float() < 0.5) {
    const solid = body.volumes.filter((v) => !v.open);
    const top = solid[solid.length - 1]!;
    if (solid.length > 1) top.materials = { ...(top.materials ?? {}), wall: s.accent };
    else top.storeys[top.storeys.length - 1]!.materials = Object.fromEntries([0, 1, 2, 3].map((k) => [k, s.accent]));
  }
  for (const v of body.volumes) roofShape(v, rng);
  return finish(fn, form, body, env, rng, style, s.base, free, 'doubleDoor');
}

/** A street shop: shopfronts on the ground floor, flats or offices above, a stockroom behind. */
function shop(rng: Rng, env: Envelope, density: 'low' | 'medium'): MadeBuilding {
  const { W, D } = env;
  const fn = pickOf(rng, density === 'low'
    ? ['shop', 'bakery', 'pharmacy', 'snackBar', 'bar', 'shop', 'restaurant', 'supermarket'] as const satisfies readonly BuildingFunction[]
    : ['shop', 'restaurant', 'bank', 'hotel', 'gym', 'office', 'pharmacy', 'supermarket'] as const satisfies readonly BuildingFunction[]);
  const style = pickOf(rng, ['classic', 'brick', 'modern', 'classic', 'deco'] as const satisfies readonly Style[]);
  const s = blockScheme(rng, env.character, style === 'brick');
  const model = new Model(fn, 'commercial', rng.int(0, 7)).heights(between(rng, 4, 4.6), 3.1).look(s.wall, s.roof, s.trim);
  const near = env.neighbours?.length ? Math.max(...env.neighbours) : null;
  const storeys = density === 'low' ? rng.int(1, 3) : Math.min(near !== null ? Math.max(2, near + 3) : 6, rng.int(2, 6));
  const upper = pickOf(rng, ['window', 'sashWindow', 'frenchWindow', 'wideWindow', 'balcony', 'bayWindow'] as const satisfies readonly BayComponent[]);
  const roof = storeys === 1 && rng.float() < 0.4 ? pickOf(rng, ['gable', 'hip'] as const) : pickOf(rng, ['flat', 'flat', 'terrace', 'flat'] as const);
  const pattern = rng.float() < 0.3 ? pickOf(rng, ['storefront', 'arcade'] as const satisfies readonly FacadePattern[]) : undefined;
  const w = half(W), d = half(D);
  // The sales floor, then a lower stockroom to the back of the plot.
  const mainD = d > 16 ? half(between(rng, 12, Math.min(16, d - 3))) : d;
  let form = 'shop:block';
  if (w >= 14 && storeys >= 2 && rng.float() < 0.35) {
    // Two shop houses side by side, of different heights: a street front of two.
    form = 'shop:pair';
    const split = half(w * between(rng, 0.4, 0.6));
    model.block({ x: 0, y: 0, w: split, d: mainD, storeys, ground: 'shopfront', fill: upper, ...pat(pattern), roof });
    model.block({ x: split, y: 0, w: w - split, d: mainD, storeys: Math.max(1, storeys + pickOf(rng, [-1, 1])), ground: 'shopfront', fill: upper, roof });
  } else model.block({ x: 0, y: 0, w, d: mainD, storeys, ground: 'shopfront', fill: upper, ...pat(pattern), roof });
  if (d - mainD >= 2) model.block({ x: 0, y: mainD, w, d: d - mainD, storeys: 1, roof: 'flat', fill: 'wall', ground: 'wall' });
  const body = model.build();
  if (form === 'shop:pair') body.volumes[1]!.materials = { wall: s.accent };
  // A shop with homes or offices above has a second door for the stairs, at one end.
  if (storeys > 1 && w >= 7) {
    const main = body.volumes[0]!;
    const across = bayCount(main.w);
    main.storeys[0]!.facade.bays = { ...(main.storeys[0]!.facade.bays ?? {}), [`0:${rng.float() < 0.5 ? 0 : across - 1}`]: 'door' };
  }
  for (const v of body.volumes) roofShape(v, rng);
  const made = finish(fn, form, body, env, rng, style, style === 'modern' ? null : s.base, [], rng.float() < 0.5 ? 'doubleDoor' : 'door');
  if (rng.float() < 0.7) {
    hang(body, { kind: 'awning', x: m(w / 2), y: -m(0.6), facing: 0, w: m(Math.max(2, w - 1)), d: m(between(rng, 1, 1.6)), z: m(3), h: m(0.12),
      material: mat('metal', pickOf(rng, AWNINGS)) });
  }
  return made;
}

/** An office building: glass, a podium and a tower stepped back as it rises, or a slab with bands. */
function office(rng: Rng, env: Envelope): MadeBuilding {
  const { W, D } = env;
  const style = pickOf(rng, ['modern', 'modern', 'deco', 'classic'] as const satisfies readonly Style[]);
  const wallBase = style === 'modern' ? pickOf(rng, GLASSY) : pickOf(rng, HARD);
  const wall = { ...wallBase, colour: nudge(wallBase.colour, rng, 0.6) };
  const model = new Model('office', 'commercial', rng.int(0, 7)).heights(between(rng, 4.5, 5.5), between(rng, 3.4, 3.9)).look(wall, mat('concrete', 0x8a8a86), pickOf(rng, HARD));
  const floors = rng.int(8, 24);
  const w = half(W), d = half(D);
  const fill = style === 'modern' ? pickOf(rng, ['ribbon', 'wideWindow'] as const) : pickOf(rng, ['window', 'sashWindow'] as const);
  const pattern = style === 'deco' ? 'artDeco' : style === 'modern' ? pickOf(rng, ['office', undefined] as const) : undefined;
  let form = 'office:slab';
  if (rng.float() < 0.6 && w >= 14 && d >= 14) {
    const podium = rng.int(2, 4);
    model.block({ x: 0, y: 0, w, d, storeys: podium, ground: 'shopfront', fill: 'wideWindow', wall: pickOf(rng, HARD), roof: 'terrace' });
    const inset = half(between(rng, 1.5, 3));
    const tw = w - 2 * inset, td = Math.max(8, Math.min(d - 2 * inset, 24));
    if (style === 'deco' || rng.float() < 0.4) { form = 'office:setback'; setbacks(model, rng, inset, inset, tw, td, podium, floors - podium, { fill, ...pat(pattern), roof: 'flat' }); }
    else { form = 'office:podium'; model.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: floors - podium, fill, ...pat(pattern), roof: 'flat' }); }
  } else {
    model.block({ x: 0, y: 0, w, d, storeys: floors, ground: 'shopfront', fill, ...pat(pattern), roof: 'flat' });
  }
  model.core('stairLift', half(w / 2 - 1.5), half(Math.min(d, 12) / 2 - 1.5), floors);
  const body = model.build();
  return finish('office', form, body, env, rng, style, pickOf(rng, BASES), [], 'doubleDoor');
}

/** A works: an office on the street corner, the hall behind it with its loading doors at the back. */
function works(rng: Rng, env: Envelope, density: 'low' | 'medium' | 'high'): MadeBuilding {
  const { W, D } = env;
  const fn: BuildingFunction = density === 'low' ? 'warehouse' : rng.float() < 0.5 ? 'factory' : 'warehouse';
  const shed = pickOf(rng, SHEDS);
  // A hall's one tall storey, 6-10 m to the eaves (racking and a lorry's
  // door), taller the denser the district.
  const hallH = density === 'high' ? between(rng, 8, 10) : density === 'medium' ? between(rng, 7, 9) : between(rng, 6, 7.5);
  const model = new Model(fn, 'industrial', rng.int(0, 7)).heights(hallH, 3.4)
    .look({ ...shed, colour: nudge(shed.colour, rng, 0.8) }, mat('panel', pickOf(rng, [0x6d7378, 0x8a8f86, 0x5d6870, 0x9a9890, 0x7a4a3a, 0x4f6b55])), pickOf(rng, HARD));
  const w = half(W), d = half(D);
  const roof = pickOf(rng, ['sawtooth', 'shed', 'flat', 'gable', 'sawtooth'] as const satisfies readonly RoofKind[]);
  const free: Rect[] = [];
  const annex = d >= 20 && w >= 12;
  const aw = annex ? half(Math.min(w - 4, between(rng, 6, 9))) : 0;
  const ad = annex ? half(between(rng, 5, 7)) : 0;
  const left = rng.float() < 0.5;
  // One tall storey: a hall of two storeys at 6-9 m each was a box 18 m high.
  model.block({ x: 0, y: ad, w, d: d - ad, storeys: 1, ground: 'wall', fill: 'ribbon', roof, pattern: 'industrial' });
  if (annex) {
    model.block({ x: left ? 0 : w - aw, y: 0, w: aw, d: ad, storeys: rng.int(1, 2), ground: 'window', fill: 'window', roof: 'flat',
      wall: pickOf(rng, [...HARD, ...BRICKS]) });
    free.push(left ? { x0: aw, y0: 0, x1: w, y1: ad } : { x0: 0, y0: 0, x1: w - aw, y1: ad });
  }
  const body = model.build();
  roofShape(body.volumes[0]!, rng, false);
  // The hall's back: loading doors onto the yard.
  const hall = body.volumes[0]!;
  const f = hall.storeys[0]!.facade;
  const across = bayCount(hall.w);
  for (let i = 0; i < across; i += 2) f.bays = { ...(f.bays ?? {}), [`2:${i}`]: 'loadingDoor' };
  return finish(fn, `works:${roof}:${annex ? (left ? 'l' : 'r') : 'none'}`, body, { ...env, door: annex ? (left ? aw / 2 : w - aw / 2) : env.door ?? w / 2 }, rng, 'modern', null, free);
}

/**
 * A building for an envelope `W` x `D` metres of a lot, for a zone's use and
 * density.
 */
export function madeToMeasure(use: 'residential' | 'commercial' | 'industrial', density: 'low' | 'medium' | 'high', env: Envelope, rng: Rng): MadeBuilding {
  if (use === 'residential') return density === 'low' ? house(rng, env) : flats(rng, env, density === 'high');
  if (use === 'commercial') return density === 'high' ? office(rng, env) : shop(rng, env, density);
  return works(rng, env, density);
}

/**
 * The signature of any building, grown or not, read off its record as the
 * eye reads it: its function and the arrangement of its blocks - for each,
 * whether it is at the front or set back, left, middle or right, across the
 * whole width or not, its storeys and its roof (not its exact size: two
 * houses of one form on lots a metre apart are the same house) - its main
 * wall and roof paint, its height.
 */
export function bodySignature(body: BlueprintBody): Signature {
  const solid = body.volumes.filter((v) => !v.open);
  if (!solid.length) return signatureOf(`${body.function ?? body.use}|`, body);
  const x0 = Math.min(...solid.map((v) => v.x)), x1 = Math.max(...solid.map((v) => v.x + v.w));
  const y0 = Math.min(...solid.map((v) => v.y));
  const width = Math.max(1e-6, x1 - x0);
  const token = (v: Volume): string => {
    const col = Math.round(((v.x + v.w / 2 - x0) / width) * 2);
    const row = v.y - y0 < m(1) ? 'f' : 'b';
    const whole = v.w > width * 0.8 ? 'W' : '';
    return `${row}${col}${whole}${v.base}+${v.storeys.length}${v.roof}`;
  };
  return signatureOf(`${body.function ?? body.use}|${solid.map(token).sort().join(';')}`, body);
}

/**
 * How unlike two signatures are, 0 (the same building) to about 4: a
 * different form counts most, then a wall colour apart, a roof, a height.
 */
export function signatureDistance(a: Signature, b: Signature): number {
  const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  const [r1, g1, b1] = rgb(a.colour), [r2, g2, b2] = rgb(b.colour);
  const colour = Math.min(1, Math.hypot(r1 - r2, g1 - g2, b1 - b2) / 90);
  return (a.form === b.form ? 0 : 1.5) + colour + (a.roof === b.roof ? 0 : 0.7) + Math.min(1, Math.abs(a.storeys - b.storeys) / 2) * 0.8;
}
