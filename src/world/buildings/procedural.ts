import type { Rng } from '@core/rng';
import { m } from '../units';
import type { BlueprintBody } from './blueprints';
import { Model, mat } from './cityBuildings';
import { elementClash } from './elements';
import type { MaterialSpec } from './materials';
import type { BayComponent, Building, BuildingElement, BuildingFunction, FacadePattern, RoofKind, Volume } from './types';

/**
 * Buildings made to measure for a lot, never the same twice.
 *
 * The lot planner (`editor/lotPlan.ts`) hands each building its envelope: the
 * part of the plot it stands on, after the front garden or forecourt, the side
 * drive or passage, and the yard or car park behind. The building fills it -
 * a deep shop with a lower stockroom behind, flats in a bar, an L or a U round
 * a courtyard, a house with its rear wing - and what it leaves of the envelope
 * it reports (`free`), so the lot gives that a use too.
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

export interface MadeBuilding {
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
}

const pickOf = <T>(rng: Rng, list: readonly T[]): T => list[rng.int(0, list.length - 1)] as T;
const between = (rng: Rng, a: number, b: number): number => a + (b - a) * rng.float();
const pat = (pattern: FacadePattern | undefined): { pattern?: FacadePattern } => (pattern ? { pattern } : {});
/** Rounds to the 0.5 m the Builder's grid uses. */
const half = (x: number): number => Math.round(x * 2) / 2;

const RENDERS: readonly MaterialSpec[] = [
  mat('plaster', 0xeae3d6), mat('plaster', 0xf3f1ec), mat('stucco', 0xe8dcc2), mat('plaster', 0xf1e4c9),
  mat('stucco', 0xd9c6a8), mat('plaster', 0xe6d2c4), mat('plaster', 0xcfd8d2), mat('plaster', 0xe9d8b4),
  mat('plaster', 0xd7e0e6), mat('stucco', 0xf0d9b5), mat('plaster', 0xc9d6c0), mat('plaster', 0xe8c9b8),
  mat('plaster', 0xb9cbd8), mat('stucco', 0xd8b49a), mat('plaster', 0xa9bfa4), mat('plaster', 0xe3b9a0),
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
  mat('concrete', 0x8e8d88), mat('stone', 0x5a5550),
];
const GLASSY: readonly MaterialSpec[] = [
  mat('glass', 0x8fb0c0), mat('glass', 0x6f8f9f), mat('glass', 0x9fb8b0), mat('panel', 0x8f9ba5), mat('glass', 0x7d97b5),
  mat('panel', 0xb4b8b6), mat('glass', 0x5d7280),
];
const SHEDS: readonly MaterialSpec[] = [
  mat('panel', 0x8f9ba5), mat('panel', 0xa3a9a6), mat('panel', 0x9aa49a), mat('metal', 0xb7b2a6), mat('panel', 0x7f8b8f),
  mat('concrete', 0xb0aca2), mat('panel', 0x6f7f8c),
];
const ROOF_TILES: readonly MaterialSpec[] = [
  mat('tile', 0xb5603f), mat('tile', 0x8f4a35), mat('slate', 0x55595e), mat('roofing', 0x6b5a4c), mat('tile', 0x7a3f32),
  mat('slate', 0x3f4a52), mat('tile', 0xa86d4a),
];
const AWNINGS = [0xb8382e, 0x2f6b4f, 0x2f4f7a, 0xd9a43a, 0x6b3f6b, 0x3d3d3d, 0xc7652f, 0x1f5f6b];

/** A wall material, leaning to the street's family two times in three. */
function wallFor(rng: Rng, character: number | undefined, families: readonly (readonly MaterialSpec[])[]): MaterialSpec {
  const family = character !== undefined && rng.float() < 0.67 ? families[character % families.length]! : pickOf(rng, families);
  return pickOf(rng, family);
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
function dressFacades(body: BlueprintBody, style: Style, rng: Rng, entrance: number, base: MaterialSpec | null): void {
  const solid = body.volumes.filter((v) => !v.open);
  const top = (v: Volume): number => v.base + v.storeys.length;
  const proportions: Record<Style, { windowWidth: number; windowHeight: number; sill: number }> = {
    classic: { windowWidth: 0.42, windowHeight: 0.62, sill: m(0.9) },
    modern: { windowWidth: 0.8, windowHeight: 0.55, sill: m(0.75) },
    deco: { windowWidth: 0.38, windowHeight: 0.7, sill: m(0.8) },
    brick: { windowWidth: 0.5, windowHeight: 0.6, sill: m(0.85) },
    house: { windowWidth: 0.45, windowHeight: 0.55, sill: m(1) },
  };
  for (const v of solid) {
    const sides = [0, 1, 2, 3] as const;
    const pier = style === 'classic' ? { pierWidth: m(0.45), pierDepth: m(0.18), pierEvery: rng.int(1, 2) }
      : style === 'deco' ? { pierWidth: m(0.6), pierDepth: m(0.35), pierEvery: 2 }
      : style === 'brick' ? { pierWidth: m(0.35), pierDepth: m(0.12), pierEvery: 1 }
      : null;
    const geometry = { ...proportions[style], ...(pier && v.storeys.length >= 3 ? pier : {}) };
    v.facadeGeometry = Object.fromEntries(sides.map((s) => [s, { ...geometry }]));
    // The ground floor in its own, harder material: the base of the building.
    if (base && v.base === 0 && top(v) >= 2) {
      v.storeys[0]!.materials = Object.fromEntries(sides.map((s) => [s, base]));
    }
  }
  // The entrance: a porch let into the front of the ground floor, or a canopy over it.
  const front = solid.filter((v) => v.base === 0).sort((p, q) => p.y - q.y)[0];
  if (front) {
    const across = bayCount(front.w);
    const bay = Math.max(0, Math.min(across - 1, Math.floor(((entrance - front.x) / front.w) * across)));
    const bw = front.w / across;
    if (style !== 'modern' && rng.float() < 0.45 && front.w > m(6)) {
      front.reliefs = [...(front.reliefs ?? []), { side: 0, bay0: bay, bay1: bay, storey0: 0, storey1: 0, depth: -m(1.2) }];
    } else {
      const z = Math.min(body.groundHeight - m(0.35), m(3.1));
      hang(body, { kind: 'canopy', x: front.x + (bay + 0.5) * bw, y: front.y - m(0.8), facing: 0, w: Math.min(m(4), bw + m(1)), d: m(1.6), z, h: m(0.18) });
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
        // Recessed loggias, every third column.
        const reliefs = [];
        for (let i = 1; i < across - 1; i += 3) reliefs.push({ side: 0 as const, bay0: i, bay1: i, storey0: lo, storey1: upper - 1, depth: -m(1.1) });
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

function finish(fn: BuildingFunction, body: BlueprintBody, env: Envelope, rng: Rng, style: Style, base: MaterialSpec | null,
  free: Rect[], doorKind: BayComponent = 'door'): MadeBuilding {
  body.function = fn;
  const solid = body.volumes.filter((v) => !v.open && v.base === 0);
  const front = solid.sort((p, q) => p.y - q.y || q.w - p.w)[0]!;
  const want = m(env.door ?? env.W / 2);
  const entrance = doorAt(front, Math.max(front.x, Math.min(front.x + front.w, want)), doorKind);
  const backBlock = solid.sort((p, q) => q.y + q.d - (p.y + p.d))[0]!;
  const back = env.backDoor ? backDoorOn(backBlock) : undefined;
  dressFacades(body, style, rng, entrance, base);
  return { fn, body, entrance: entrance / m(1), ...(back !== undefined ? { backDoor: back / m(1) } : {}), free };
}

// ---------------------------------------------------------------- the kinds

/** A house: a main body over the whole width, a rear wing, one or two storeys. */
function house(rng: Rng, env: Envelope): MadeBuilding {
  const { W, D } = env;
  const wall = wallFor(rng, env.character, [RENDERS, RENDERS, BRICKS]);
  const model = new Model('house', 'residential', rng.int(0, 7)).heights(between(rng, 2.9, 3.3), 2.9).look(wall, pickOf(rng, ROOF_TILES), pickOf(rng, RENDERS));
  const storeys = rng.float() < 0.55 ? 2 : 1;
  const roof = pickOf(rng, ['gable', 'gable', 'hip', 'hip', 'shed', 'flat'] as const satisfies readonly RoofKind[]);
  const windows = pickOf(rng, ['window', 'sashWindow', 'frenchWindow', 'window', 'wideWindow'] as const satisfies readonly BayComponent[]);
  const mainD = half(Math.min(D, between(rng, 7.5, 10)));
  const free: Rect[] = [];
  model.block({ x: 0, y: 0, w: half(W), d: mainD, storeys, roof, fill: windows });
  if (D - mainD >= 2) {
    // The rear wing: kitchen and service, on one side; beside it, a terrace.
    const ww = half(Math.max(Math.min(W, 4), W * between(rng, 0.45, 0.7)));
    const left = rng.float() < 0.5;
    model.block({ x: left ? 0 : half(W) - ww, y: mainD, w: ww, d: half(D - mainD), storeys: 1,
      roof: pickOf(rng, ['flat', 'shed', roof] as const), fill: 'window' });
    if (half(W) - ww >= 2) free.push(left ? { x0: ww, y0: mainD, x1: half(W), y1: half(D) } : { x0: 0, y0: mainD, x1: half(W) - ww, y1: half(D) });
  }
  const body = model.build();
  return finish('house', body, env, rng, 'house', rng.float() < 0.4 ? pickOf(rng, BASES) : null, free);
}

/** Flats: a bar, an L or a U round a courtyard, stepped at the top; a tower on a podium when high. */
function flats(rng: Rng, env: Envelope, high: boolean): MadeBuilding {
  const { W, D } = env;
  const fn: BuildingFunction = high ? 'residentialTower' : 'apartments';
  const style = pickOf(rng, ['classic', 'modern', 'brick', 'deco', 'modern'] as const satisfies readonly Style[]);
  const wall = style === 'brick' ? pickOf(rng, BRICKS) : style === 'modern' ? wallFor(rng, env.character, [HARD, RENDERS]) : wallFor(rng, env.character, [RENDERS, HARD, BRICKS]);
  const model = new Model(fn, 'residential', rng.int(0, 7)).heights(between(rng, 3.8, 4.5), 3).look(wall, mat('concrete', 0x8a8a86), pickOf(rng, [...RENDERS, ...HARD]));
  const floors = high ? rng.int(9, 22) : rng.int(3, 7);
  const fill = pickOf(rng, ['balcony', 'window', 'frenchWindow', 'balcony', 'sashWindow', 'wideWindow'] as const satisfies readonly BayComponent[]);
  const ground = pickOf(rng, ['window', 'shopfront', 'window', 'wideWindow'] as const satisfies readonly BayComponent[]);
  const pattern = rng.float() < 0.25 ? pickOf(rng, ['residential', 'gallery'] as const satisfies readonly FacadePattern[]) : undefined;
  const roof = pickOf(rng, ['flat', 'terrace', 'flat', 'hip'] as const satisfies readonly RoofKind[]);
  const w = half(W), d = half(D);
  const free: Rect[] = [];
  const barD = half(Math.min(d, between(rng, 12, 15)));
  if (high) {
    const podium = rng.int(1, 2);
    model.block({ x: 0, y: 0, w, d, storeys: podium, ground, fill: 'window', roof: 'terrace' });
    const inset = half(between(rng, 1.5, 3));
    const tw = Math.max(8, w - 2 * inset), td = Math.max(8, Math.min(d - 2 * inset, 22));
    model.block({ x: inset, y: inset, w: tw, d: td, base: podium, storeys: floors, fill, ...pat(pattern), roof });
  } else if (d - barD >= 6 && w >= 20 && rng.float() < 0.5) {
    // A U: the street bar and two wings, the courtyard between them.
    const ww = half(between(rng, 6, Math.min(9, w / 3)));
    model.block({ x: 0, y: 0, w, d: barD, storeys: floors, ground, fill, ...pat(pattern), roof });
    model.block({ x: 0, y: barD, w: ww, d: d - barD, storeys: Math.max(2, floors - 1), fill, roof, ...pat(pattern) });
    model.block({ x: w - ww, y: barD, w: ww, d: d - barD, storeys: Math.max(2, floors - 1), fill, roof, ...pat(pattern) });
    free.push({ x0: ww, y0: barD, x1: w - ww, y1: d });
  } else if (d - barD >= 6 && w >= 14) {
    // An L: the bar and a wing behind; the corner beside the wing is a garden.
    const ww = half(between(rng, 7, Math.min(11, w / 2)));
    const left = rng.float() < 0.5;
    model.block({ x: 0, y: 0, w, d: barD, storeys: floors, ground, fill, ...pat(pattern), roof });
    model.block({ x: left ? 0 : w - ww, y: barD, w: ww, d: d - barD, storeys: Math.max(2, floors - rng.int(0, 2)), fill, roof, ...pat(pattern) });
    free.push(left ? { x0: ww, y0: barD, x1: w, y1: d } : { x0: 0, y0: barD, x1: w - ww, y1: d });
  } else {
    // A bar to the envelope's depth, its top floors stepped back from the street.
    const lower = floors >= 5 && rng.float() < 0.5 ? floors - rng.int(1, 2) : floors;
    model.block({ x: 0, y: 0, w, d, storeys: lower, ground, fill, ...pat(pattern), roof: lower < floors ? 'terrace' : roof });
    if (lower < floors && d >= 9) model.block({ x: 0, y: 2, w, d: d - 2, base: lower, storeys: floors - lower, fill, roof, ...pat(pattern) });
  }
  model.core('stairLift', half(w / 2 - 1.5), half(Math.min(d, 10) / 2 - 1.5), floors + (high ? 2 : 0));
  const body = model.build();
  return finish(fn, body, env, rng, style, pickOf(rng, BASES), free, 'doubleDoor');
}

/** A street shop: shopfronts on the ground floor, flats or offices above, a stockroom behind. */
function shop(rng: Rng, env: Envelope, density: 'low' | 'medium'): MadeBuilding {
  const { W, D } = env;
  const fn = pickOf(rng, density === 'low'
    ? ['shop', 'bakery', 'pharmacy', 'snackBar', 'bar', 'shop', 'restaurant'] as const satisfies readonly BuildingFunction[]
    : ['shop', 'restaurant', 'bank', 'hotel', 'gym', 'office'] as const satisfies readonly BuildingFunction[]);
  const style = pickOf(rng, ['classic', 'brick', 'modern', 'classic', 'deco'] as const satisfies readonly Style[]);
  const wall = style === 'brick' ? pickOf(rng, BRICKS) : wallFor(rng, env.character, [RENDERS, HARD, BRICKS]);
  const model = new Model(fn, 'commercial', rng.int(0, 7)).heights(between(rng, 4, 4.6), 3.1).look(wall, pickOf(rng, ROOF_TILES), pickOf(rng, [...RENDERS, ...HARD]));
  const storeys = density === 'low' ? rng.int(1, 3) : rng.int(2, 6);
  const upper = pickOf(rng, ['window', 'sashWindow', 'frenchWindow', 'wideWindow', 'balcony'] as const satisfies readonly BayComponent[]);
  const roof = storeys === 1 && rng.float() < 0.4 ? pickOf(rng, ['gable', 'hip'] as const) : pickOf(rng, ['flat', 'flat', 'terrace', 'flat'] as const);
  const pattern = rng.float() < 0.3 ? pickOf(rng, ['storefront', 'arcade'] as const satisfies readonly FacadePattern[]) : undefined;
  const w = half(W), d = half(D);
  // The sales floor, then a lower stockroom to the back of the plot.
  const mainD = d > 16 ? half(between(rng, 12, Math.min(16, d - 3))) : d;
  model.block({ x: 0, y: 0, w, d: mainD, storeys, ground: 'shopfront', fill: upper, ...pat(pattern), roof });
  if (d - mainD >= 2) model.block({ x: 0, y: mainD, w, d: d - mainD, storeys: 1, roof: 'flat', fill: 'wall', ground: 'wall' });
  const body = model.build();
  // A shop with homes or offices above has a second door for the stairs, at one end.
  if (storeys > 1 && w >= 7) {
    const main = body.volumes[0]!;
    const across = bayCount(main.w);
    main.storeys[0]!.facade.bays = { ...(main.storeys[0]!.facade.bays ?? {}), [`0:${rng.float() < 0.5 ? 0 : across - 1}`]: 'door' };
  }
  const made = finish(fn, body, env, rng, style, style === 'modern' ? null : pickOf(rng, BASES), [], rng.float() < 0.5 ? 'doubleDoor' : 'door');
  if (rng.float() < 0.6) {
    hang(body, { kind: 'awning', x: m(w / 2), y: -m(0.6), facing: 0, w: m(Math.max(2, w - 1)), d: m(1.3), z: m(3), h: m(0.12),
      material: mat('metal', pickOf(rng, AWNINGS)) });
  }
  return made;
}

/** An office building: glass, a podium and a tower, or a slab with bands. */
function office(rng: Rng, env: Envelope): MadeBuilding {
  const { W, D } = env;
  const style = pickOf(rng, ['modern', 'modern', 'deco', 'classic'] as const satisfies readonly Style[]);
  const wall = style === 'modern' ? pickOf(rng, GLASSY) : pickOf(rng, HARD);
  const model = new Model('office', 'commercial', rng.int(0, 7)).heights(between(rng, 4.5, 5.5), 3.6).look(wall, mat('concrete', 0x8a8a86), pickOf(rng, HARD));
  const floors = rng.int(8, 24);
  const w = half(W), d = half(D);
  const fill = style === 'modern' ? pickOf(rng, ['ribbon', 'wideWindow'] as const) : pickOf(rng, ['window', 'sashWindow'] as const);
  const pattern = style === 'deco' ? 'artDeco' : style === 'modern' ? pickOf(rng, ['office', undefined] as const) : undefined;
  if (rng.float() < 0.6 && w >= 14 && d >= 14) {
    const podium = rng.int(2, 4);
    model.block({ x: 0, y: 0, w, d, storeys: podium, ground: 'shopfront', fill: 'wideWindow', wall: pickOf(rng, HARD), roof: 'terrace' });
    const inset = half(between(rng, 1.5, 3));
    model.block({ x: inset, y: inset, w: w - 2 * inset, d: Math.max(8, Math.min(d - 2 * inset, 24)), base: podium, storeys: floors - podium, fill, ...pat(pattern), roof: 'flat' });
  } else {
    model.block({ x: 0, y: 0, w, d, storeys: floors, ground: 'shopfront', fill, ...pat(pattern), roof: 'flat' });
  }
  model.core('stairLift', half(w / 2 - 1.5), half(Math.min(d, 12) / 2 - 1.5), floors);
  const body = model.build();
  return finish('office', body, env, rng, style, pickOf(rng, BASES), [], 'doubleDoor');
}

/** A works: an office on the street corner, the hall behind it with its loading doors at the back. */
function works(rng: Rng, env: Envelope, density: 'low' | 'medium' | 'high'): MadeBuilding {
  const { W, D } = env;
  const fn: BuildingFunction = density === 'low' ? 'warehouse' : rng.float() < 0.5 ? 'factory' : 'warehouse';
  const model = new Model(fn, 'industrial', rng.int(0, 7)).heights(between(rng, 6, 9), 3.6)
    .look(pickOf(rng, SHEDS), mat('panel', pickOf(rng, [0x6d7378, 0x8a8f86, 0x5d6870, 0x9a9890])), pickOf(rng, HARD));
  const w = half(W), d = half(D);
  const roof = pickOf(rng, ['sawtooth', 'shed', 'flat', 'gable', 'sawtooth'] as const satisfies readonly RoofKind[]);
  const free: Rect[] = [];
  const annex = d >= 20 && w >= 12;
  const aw = annex ? half(Math.min(w - 4, between(rng, 6, 9))) : 0;
  const ad = annex ? half(between(rng, 5, 7)) : 0;
  const left = rng.float() < 0.5;
  model.block({ x: 0, y: ad, w, d: d - ad, storeys: density === 'high' ? 2 : 1, ground: 'wall', fill: 'ribbon', roof, pattern: 'industrial' });
  if (annex) {
    model.block({ x: left ? 0 : w - aw, y: 0, w: aw, d: ad, storeys: rng.int(1, 2), ground: 'window', fill: 'window', roof: 'flat',
      wall: pickOf(rng, [...HARD, ...BRICKS]) });
    free.push(left ? { x0: aw, y0: 0, x1: w, y1: ad } : { x0: 0, y0: 0, x1: w - aw, y1: ad });
  }
  const body = model.build();
  // The hall's back: loading doors onto the yard.
  const hall = body.volumes[0]!;
  const f = hall.storeys[0]!.facade;
  const across = bayCount(hall.w);
  for (let i = 0; i < across; i += 2) f.bays = { ...(f.bays ?? {}), [`2:${i}`]: 'loadingDoor' };
  const made = finish(fn, body, { ...env, door: annex ? (left ? aw / 2 : w - aw / 2) : env.door ?? w / 2 }, rng, 'modern', null, free);
  return made;
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
