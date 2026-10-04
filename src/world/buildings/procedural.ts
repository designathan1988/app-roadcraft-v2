import type { Rng } from '@core/rng';
import type { BlueprintBody } from './blueprints';
import { Model, mat } from './cityBuildings';
import type { MaterialSpec } from './materials';
import type { BayComponent, BuildingFunction, FacadePattern, RoofKind } from './types';

/**
 * Buildings made to measure for a lot, never the same twice.
 *
 * The catalog (`cityBuildings.ts`) holds ONE model per kind; a street grown
 * from it was one house repeated with its walls repainted. Here every grown
 * building is composed from its lot and a seeded draw: its plan (a bar, an L,
 * a U, a podium with a tower, a stepped block, a main house with a wing or a
 * garage), its height, its roofs, the openings of its ground and upper floors,
 * its facade pattern and the materials of each part - from the same blocks
 * the Builder edits, so the result is an ordinary editable building.
 *
 * Sizes are metres in the building's local frame, the street along -y.
 */

export interface MadeBuilding {
  readonly fn: BuildingFunction;
  readonly body: BlueprintBody;
}

const pickOf = <T>(rng: Rng, list: readonly T[]): T => list[rng.int(0, list.length - 1)] as T;
const between = (rng: Rng, a: number, b: number): number => a + (b - a) * rng.float();
/** A facade pattern, or none (the default facade). */
const pat = (pattern: FacadePattern | undefined): { pattern?: FacadePattern } => (pattern ? { pattern } : {});

/** Rounds to the 0.5 m the Builder's grid uses. */
const half = (x: number): number => Math.round(x * 2) / 2;

const RENDERS: readonly MaterialSpec[] = [
  mat('plaster', 0xeae3d6), mat('plaster', 0xf3f1ec), mat('stucco', 0xe8dcc2), mat('plaster', 0xf1e4c9),
  mat('stucco', 0xd9c6a8), mat('plaster', 0xe6d2c4), mat('plaster', 0xcfd8d2), mat('plaster', 0xe9d8b4),
  mat('plaster', 0xd7e0e6), mat('stucco', 0xf0d9b5), mat('plaster', 0xc9d6c0), mat('plaster', 0xe8c9b8),
];
const BRICKS: readonly MaterialSpec[] = [
  mat('brick', 0xa4563f), mat('brick', 0x8c4a35), mat('brick', 0xb86a4a), mat('brick', 0x9a6a52), mat('brick', 0xc08060),
];
const HARD: readonly MaterialSpec[] = [
  mat('concrete', 0xbcbab3), mat('stone', 0xcfc7b6), mat('ceramic', 0xd8d4cc), mat('concrete', 0xa9aaa5), mat('stone', 0xb9ae98),
];
const GLASSY: readonly MaterialSpec[] = [
  mat('glass', 0x8fb0c0), mat('glass', 0x6f8f9f), mat('glass', 0x9fb8b0), mat('panel', 0x8f9ba5), mat('glass', 0x7d97b5),
];
const SHEDS: readonly MaterialSpec[] = [
  mat('panel', 0x8f9ba5), mat('panel', 0xa3a9a6), mat('panel', 0x9aa49a), mat('metal', 0xb7b2a6), mat('panel', 0x7f8b8f),
  mat('concrete', 0xb0aca2),
];
const ROOF_TILES: readonly MaterialSpec[] = [
  mat('tile', 0xb5603f), mat('tile', 0x8f4a35), mat('slate', 0x55595e), mat('roofing', 0x6b5a4c), mat('tile', 0x7a3f32),
  mat('slate', 0x3f4a52),
];

/** A house: a main body, sometimes a wing or a garage, one or two storeys. */
function house(rng: Rng, W: number, D: number): MadeBuilding {
  const wall = rng.float() < 0.25 ? pickOf(rng, BRICKS) : pickOf(rng, RENDERS);
  const model = new Model('house', 'residential', rng.int(0, 7)).look(wall, pickOf(rng, ROOF_TILES), pickOf(rng, RENDERS));
  const storeys = rng.float() < 0.55 ? 2 : 1;
  const roof = pickOf(rng, ['gable', 'gable', 'hip', 'hip', 'shed'] as const satisfies readonly RoofKind[]);
  const windows = pickOf(rng, ['window', 'sashWindow', 'frenchWindow', 'window'] as const satisfies readonly BayComponent[]);
  const plan = rng.int(0, 3);
  const mainW = half(Math.min(W, between(rng, 7, 11)));
  const mainD = half(Math.min(D, between(rng, 7, 11)));
  model.block({ x: 0, y: 0, w: mainW, d: mainD, storeys, roof, fill: windows, door: rng.int(0, Math.max(0, Math.round(mainW / 3) - 1)) });
  if (plan === 1 && W - mainW >= 3.5) {
    // A garage beside it, one storey, its door on the street.
    const gw = half(Math.min(W - mainW, between(rng, 3.5, 4.5)));
    model.block({ x: mainW, y: 0.5, w: gw, d: half(Math.min(D, 6)), storeys: 1, roof: pickOf(rng, ['flat', 'shed', roof] as const),
      fill: 'wall', ground: 'garageDoor' });
  } else if (plan === 2 && D - mainD >= 3) {
    // A wing behind, an L.
    const ww = half(between(rng, 4, Math.max(4, mainW - 2)));
    model.block({ x: rng.float() < 0.5 ? 0 : mainW - ww, y: mainD, w: ww, d: half(Math.min(D - mainD, between(rng, 3, 6))),
      storeys: Math.max(1, storeys - rng.int(0, 1)), roof, fill: windows });
  } else if (plan === 3 && storeys === 2 && mainW >= 8) {
    // A bay window on the front.
    model.block({ x: half(mainW * 0.3), y: -2, w: 3, d: 2, storeys: 1, roof: 'shed', fill: 'bayWindow' });
  }
  return { fn: 'house', body: model.build() };
}

/** A block of flats or a tower: bar, L, U, stepped or podium and tower. */
function flats(rng: Rng, W: number, D: number, high: boolean): MadeBuilding {
  const fn: BuildingFunction = high ? 'residentialTower' : 'apartments';
  const wall = pickOf(rng, rng.float() < 0.3 ? BRICKS : rng.float() < 0.5 ? HARD : RENDERS);
  const trim = pickOf(rng, [...RENDERS, ...HARD]);
  const model = new Model(fn, 'residential', rng.int(0, 7)).look(wall, mat('concrete', 0x8a8a86), trim);
  const floors = high ? rng.int(9, 22) : rng.int(3, 7);
  const fill = pickOf(rng, ['balcony', 'window', 'frenchWindow', 'balcony', 'sashWindow'] as const satisfies readonly BayComponent[]);
  const ground = pickOf(rng, ['window', 'shopfront', 'window', 'pillar'] as const satisfies readonly BayComponent[]);
  const pattern = rng.float() < 0.35 ? pickOf(rng, ['residential', 'gallery'] as const satisfies readonly FacadePattern[]) : undefined;
  const roof = pickOf(rng, ['flat', 'terrace', 'flat', 'hip'] as const satisfies readonly RoofKind[]);
  const w = half(Math.min(W, between(rng, Math.min(W, 12), W)));
  const d = half(Math.min(D, between(rng, 10, Math.max(10, Math.min(D, high ? 22 : 16)))));
  const plan = high ? rng.int(0, 2) : rng.int(0, 3);
  const door = 'middle' as const;
  if (high && plan === 0) {
    // Podium of shops or a lobby, tower set back on it.
    const podium = rng.int(1, 3);
    model.block({ x: 0, y: 0, w, d, storeys: podium, ground: rng.float() < 0.6 ? 'shopfront' : 'window', fill: 'window', door, doorKind: 'doubleDoor', wall: trim });
    const inset = half(between(rng, 1.5, 3.5));
    model.block({ x: inset, y: inset, w: w - 2 * inset, d: Math.max(6, d - 2 * inset), base: podium, storeys: floors, fill, ...pat(pattern), roof });
  } else if (plan === 1) {
    // Stepped: the top floors set back from the street.
    const lower = Math.max(2, Math.round(floors * between(rng, 0.55, 0.8)));
    model.block({ x: 0, y: 0, w, d, storeys: lower, ground, fill, door, doorKind: 'doubleDoor', ...pat(pattern) });
    const step = half(between(rng, 2, 4));
    model.block({ x: 0, y: step, w, d: Math.max(5, d - step), base: lower, storeys: floors - lower, fill, roof, ...pat(pattern) });
  } else if (plan === 2 && w >= 16 && D >= 18) {
    // An L: the street bar and a wing behind.
    const barD = half(Math.min(d, between(rng, 9, 12)));
    model.block({ x: 0, y: 0, w, d: barD, storeys: floors, ground, fill, door, doorKind: 'doubleDoor', ...pat(pattern), roof });
    const ww = half(between(rng, 7, Math.min(10, w / 2)));
    model.block({ x: rng.float() < 0.5 ? 0 : w - ww, y: barD, w: ww, d: half(Math.min(D - barD, between(rng, 6, 12))), storeys: Math.max(2, floors - rng.int(0, 2)), fill, roof, ...pat(pattern) });
  } else if (plan === 3 && w >= 20 && D >= 18) {
    // A U round a courtyard.
    const barD = half(between(rng, 8, 10));
    const ww = half(between(rng, 6, 8));
    const wingD = half(Math.min(D - barD, between(rng, 6, 10)));
    model.block({ x: 0, y: 0, w, d: barD, storeys: floors, ground, fill, door, doorKind: 'doubleDoor', ...pat(pattern), roof });
    model.block({ x: 0, y: barD, w: ww, d: wingD, storeys: floors, fill, roof, ...pat(pattern) });
    model.block({ x: w - ww, y: barD, w: ww, d: wingD, storeys: floors, fill, roof, ...pat(pattern) });
  } else {
    model.block({ x: 0, y: 0, w, d, storeys: floors, ground, fill, door, doorKind: 'doubleDoor', ...pat(pattern), roof });
  }
  model.core('stairLift', half(w / 2 - 1.5), half(Math.min(d, 10) / 2 - 1.5), floors);
  return { fn, body: model.build() };
}

/** A street shop: ground floor shopfront, flats or offices above, the full width of its plot. */
function shop(rng: Rng, W: number, D: number, density: 'low' | 'medium'): MadeBuilding {
  const fn = pickOf(rng, density === 'low'
    ? ['shop', 'bakery', 'pharmacy', 'snackBar', 'bar', 'shop', 'restaurant'] as const satisfies readonly BuildingFunction[]
    : ['shop', 'restaurant', 'bank', 'hotel', 'gym', 'office'] as const satisfies readonly BuildingFunction[]);
  const wall = pickOf(rng, rng.float() < 0.3 ? BRICKS : rng.float() < 0.3 ? HARD : RENDERS);
  const model = new Model(fn, 'commercial', rng.int(0, 7)).look(wall, pickOf(rng, ROOF_TILES), pickOf(rng, [...RENDERS, ...HARD]));
  const storeys = density === 'low' ? rng.int(1, 3) : rng.int(2, 6);
  const d = half(Math.min(D, between(rng, 9, density === 'low' ? 14 : 18)));
  const upper = pickOf(rng, ['window', 'sashWindow', 'frenchWindow', 'wideWindow', 'balcony'] as const satisfies readonly BayComponent[]);
  const roof = storeys === 1 && rng.float() < 0.4 ? pickOf(rng, ['gable', 'hip'] as const) : pickOf(rng, ['flat', 'flat', 'terrace', 'gable', 'hip'] as const);
  const pattern = rng.float() < 0.4 ? pickOf(rng, ['storefront', 'arcade'] as const satisfies readonly FacadePattern[]) : undefined;
  model.block({ x: 0, y: 0, w: half(W), d, storeys, ground: 'shopfront', fill: upper, door: 'middle', doorKind: rng.float() < 0.5 ? 'doubleDoor' : 'door', ...pat(pattern), roof });
  if (rng.float() < 0.65) model.el('awning', half(W) / 2, -0.6, 0, { w: half(Math.max(2, W - 1)), d: 1.2, z: 2.8, material: mat('metal', pickOf(rng, [0xb8382e, 0x2f6b4f, 0x2f4f7a, 0xd9a43a, 0x6b3f6b, 0x3d3d3d])) });
  return { fn, body: model.build() };
}

/** An office building: glass, a podium and a tower, or a slab. */
function office(rng: Rng, W: number, D: number): MadeBuilding {
  const wall = pickOf(rng, rng.float() < 0.6 ? GLASSY : HARD);
  const model = new Model('office', 'commercial', rng.int(0, 7)).look(wall, mat('concrete', 0x8a8a86), pickOf(rng, HARD));
  const floors = rng.int(8, 24);
  const w = half(Math.min(W, between(rng, Math.min(W, 16), W)));
  const d = half(Math.min(D, between(rng, 14, Math.max(14, Math.min(D, 24)))));
  const fill = pickOf(rng, ['ribbon', 'wideWindow', 'window'] as const satisfies readonly BayComponent[]);
  const pattern = pickOf(rng, ['office', 'office', 'artDeco', undefined] as const);
  if (rng.float() < 0.6) {
    const podium = rng.int(2, 4);
    model.block({ x: 0, y: 0, w, d, storeys: podium, ground: 'shopfront', fill: 'wideWindow', door: 'middle', doorKind: 'doubleDoor', wall: pickOf(rng, HARD) });
    const inset = half(between(rng, 1.5, 3));
    model.block({ x: inset, y: inset, w: w - 2 * inset, d: Math.max(8, d - 2 * inset), base: podium, storeys: floors - podium, fill, ...pat(pattern), roof: 'flat' });
    if (rng.float() < 0.3) model.block({ x: inset + 2, y: inset + 2, w: Math.max(4, w - 2 * inset - 4), d: Math.max(4, d - 2 * inset - 4), base: floors, storeys: 1, fill: 'wall', pattern: 'artDecoCrown', roof: 'flat' });
  } else {
    model.block({ x: 0, y: 0, w, d, storeys: floors, ground: 'shopfront', fill, ...pat(pattern), door: 'middle', doorKind: 'doubleDoor', roof: 'flat' });
  }
  model.core('stairLift', half(w / 2 - 1.5), half(d / 2 - 1.5), floors);
  return { fn: 'office', body: model.build() };
}

/** A works: a tall shed with loading doors, an office annex, sometimes a second hall. */
function works(rng: Rng, W: number, D: number, density: 'low' | 'medium' | 'high'): MadeBuilding {
  const fn: BuildingFunction = density === 'low' ? 'warehouse' : rng.float() < 0.5 ? 'factory' : 'warehouse';
  const model = new Model(fn, 'industrial', rng.int(0, 7)).heights(between(rng, 6, 9), 3.6)
    .look(pickOf(rng, SHEDS), mat('panel', pickOf(rng, [0x6d7378, 0x8a8f86, 0x5d6870, 0x9a9890])), pickOf(rng, HARD));
  const hallW = half(Math.min(W, between(rng, Math.min(W, 14), W)));
  const hallD = half(Math.min(D, between(rng, 12, Math.max(12, D))));
  const roof = pickOf(rng, ['sawtooth', 'shed', 'flat', 'gable', 'sawtooth'] as const satisfies readonly RoofKind[]);
  model.block({ x: 0, y: 0, w: hallW, d: hallD, storeys: density === 'high' ? 2 : 1, ground: 'loadingDoor', fill: 'ribbon', roof, pattern: 'industrial' });
  // The office annex on the street corner.
  if (hallW >= 14 && rng.float() < 0.7) {
    const aw = half(between(rng, 5, 8));
    model.block({ x: rng.float() < 0.5 ? 0 : hallW - aw, y: -half(between(rng, 3, 5)), w: aw, d: 5, storeys: rng.int(1, 2), ground: 'window', fill: 'window', door: 0, roof: 'flat', wall: pickOf(rng, [...HARD, ...BRICKS]) });
  }
  return { fn, body: model.build() };
}

/**
 * A building for a lot `W` wide with `D` of depth for the building itself
 * (metres), for a zone's use and density.
 */
export function madeToMeasure(use: 'residential' | 'commercial' | 'industrial', density: 'low' | 'medium' | 'high', W: number, D: number, rng: Rng): MadeBuilding {
  if (use === 'residential') return density === 'low' ? house(rng, W, D) : flats(rng, W, D, density === 'high');
  if (use === 'commercial') return density === 'high' ? office(rng, W, D) : shop(rng, W, D, density);
  return works(rng, W, D, density);
}
