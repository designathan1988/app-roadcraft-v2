import type { Rng } from '@core/rng';
import { EARRING_STYLES, FRAME_COLOURS, GLASSES_STYLES, METALS, NO_ACCESSORIES, type Accessories } from './accessories';
import { GARMENT_TYPES, PATTERNS, garmentDefaults, type GarmentParams, type GarmentSlot, type Outfit } from './clothes';
import { HAIR_COLOURS, type BrowParams, type HairParams, type LashParams } from './hair';
import { sexAxis } from './sampleBody';
import { hairFor } from '../wardrobe';

import type { HumanBase, MorphWeights } from './humanBase';

/** Every hair mesh offered, for either sex. */
export const HAIR_MESHES: readonly string[] = [...new Set([...hairFor('female'), ...hairFor('male')])];
const isHairMesh = (style: string): boolean => HAIR_MESHES.includes(style);

/**
 * A generated person as the player edits them: sex, age, height, BMI, skin,
 * ancestry and free shape components, turned into the base's morph weights
 * and a scale (`resolvePerson`).
 *
 * - Height is reached by scaling the body; the MHR components keep the
 *   proportions a body of that height has in the scans.
 * - Weight is reached through the body's own volume: the mass of the mesh
 *   (closed skin, density 1010 kg/m3, ICRP's whole-body density) is moved to
 *   height^2 x BMI along the MHR body components, with height held
 *   (a Gauss-Newton step on a measured Jacobian).
 * - Children use the Vitruvian's baby morph for a child's proportions (head
 *   large to the body) and are scaled to the WHO median height for their age.
 *
 * Random people (`randomPerson`) are drawn as a population: adult heights by
 * sex (NCD-RisC 2016 global means, 171 / 159 cm, sd 7 / 6.5), BMI around 25
 * (sd 4.5), children's heights and BMIs from the WHO growth references.
 */

export interface PersonParams {
  readonly name: string;
  /** 0 female .. 1 male. */
  readonly sex: number;
  readonly years: number;
  readonly heightCm: number;
  readonly bmi: number;
  /** 0 light .. 1 dark skin. */
  readonly melanin: number;
  /** The Vitruvian ancestry morph and its weight. */
  readonly ancestry: string;
  /** MHR body components (sex removed), head components, hands; unit normal draws. */
  readonly body: readonly number[];
  readonly head: readonly number[];
  readonly hands: readonly number[];
  /** The Vitruvian's regional sliders (face and body features), by morph name. */
  readonly detail: MorphWeights;
  /** 0 .. 1: the Vitruvian's muscular build. */
  readonly muscle: number;
  /** Iris colour, 0xRRGGBB. */
  readonly iris: number;
  /** A Vitruvian expression morph ('' for none) and how strongly it shows. */
  readonly expression: string;
  readonly expressionAmount: number;
  /** -1 cool .. 1 warm skin. */
  readonly undertone: number;
  readonly hair: HairParams;
  readonly brows: BrowParams;
  readonly lashes: LashParams;
  readonly outfit: Outfit;
  readonly makeup: Makeup;
  readonly accessories: Accessories;
  /** Fixes the person's strand and stubble randomness. */
  readonly seed: number;
}

export interface Makeup {
  readonly lipColour: number;
  readonly lipAmount: number;
  /** 0 clean-shaven .. 1 a few days' beard. */
  readonly stubble: number;
}

export const LIP_COLOURS: readonly number[] = [0xb03a48, 0x8c1c2c, 0xd0606a, 0xc47a6a, 0x9a4a3a, 0x6a2a40, 0xe0909a, 0x5a2030];
export const CLOTH_COLOURS: readonly number[] = [
  0xf2f0ea, 0x1c1c1e, 0x6b6e73, 0x2b3a5c, 0x3e6ea8, 0x8fb8de, 0x7a1f2a, 0xc23a32, 0xe08a3c, 0xe8c94a, 0x3f6b3a, 0x8aa86a,
  0x5a3d2b, 0xb08a64, 0xd9c4a2, 0x6b3f7a, 0xd88aa8, 0x2f8a8a,
];

/** Hair as people have it, by melanin and age: darker for darker skin, grey with years. */
function hairColourFor(rng: Rng, melanin: number): number {
  if (melanin > 0.45 || rng.bool(0.55)) return rng.pick(HAIR_COLOURS.slice(0, 3));
  return rng.pick(HAIR_COLOURS.slice(1, 10));
}

function randomGarment(rng: Rng, slot: GarmentSlot, type?: string): GarmentParams {
  const t = type ?? rng.pick(GARMENT_TYPES[slot]);
  const colour = rng.pick(CLOTH_COLOURS);
  const d = garmentDefaults(t);
  const pattern = d.fabric === 'denim' ? 'denim' : rng.bool(0.7) ? 'solid' : rng.pick(PATTERNS.slice(1, 5));
  return { ...d, colour: t === 'trousers' ? rng.pick([0x2b3a5c, 0x3e5a80, 0x1c1c1e, 0x6b6e73]) : colour, colour2: rng.pick(CLOTH_COLOURS), pattern, patternScale: 1 };
}

/** A whole outfit, by sex: tops, then trousers, skirts, a dress. */
export function randomOutfit(rng: Rng, female: boolean): Outfit {
  const shoes = randomGarment(rng, 'shoes', rng.pick(['sneakers', 'sneakers', 'flats', 'boots']));
  if (female && rng.bool(0.2)) return { top: randomGarment(rng, 'top', 'dress'), bottom: null, shoes };
  const top = randomGarment(rng, 'top', rng.pick(female ? ['tshirt', 'tank', 'longsleeve', 'crop', 'turtleneck', 'shirt'] : ['tshirt', 'tshirt', 'longsleeve', 'shirt', 'tank', 'turtleneck']));
  const bottom = randomGarment(rng, 'bottom', rng.pick(female ? ['trousers', 'skirt', 'shorts', 'leggings', 'pants', 'capri'] : ['trousers', 'trousers', 'shorts', 'pants']));
  return { top, bottom, shoes };
}

export function randomHair(rng: Rng, female: boolean, years: number, melanin: number): HairParams {
  const curlyOdds = melanin > 0.75 ? 0.75 : 0.2;
  // A hairstyle from the hair meshes that suit the person (`people/wardrobe.ts`).
  let style = rng.pick(hairFor(female ? 'female' : 'male'));
  if (!female && years > 55 && rng.bool(0.15)) style = 'none';
  const colour = hairColourFor(rng, melanin);
  const curly = style === 'afro' || rng.bool(curlyOdds * 0.4);
  return {
    style, colour, tipColour: rng.bool(0.12) ? rng.pick(HAIR_COLOURS.slice(5, 10)) : colour,
    grey: Math.max(0, Math.min(1, (years - 38) / 40 + rng.normal(0, 0.1))),
    length: 1, volume: rng.range(0, 0.4), curl: curly ? rng.range(0.5, 1) : rng.bool(0.25) ? rng.range(0.1, 0.4) : 0,
    curlSize: curly ? rng.range(0.05, 0.4) : rng.range(0.4, 1), frizz: rng.range(0, 0.3), density: 1, thickness: 1,
  };
}

/** Fills what an older saved person lacks (people saved before hair and clothes existed). */
export function completePerson(p: PersonParams, rng: Rng): PersonParams {
  const female = p.sex < 0.5;
  return {
    ...p,
    undertone: p.undertone ?? 0,
    // Hair saved as a strand groom (before hair meshes) takes a mesh that suits the person.
    hair: !p.hair ? randomHair(rng, female, p.years, p.melanin)
      : p.hair.style === 'none' || isHairMesh(p.hair.style) ? p.hair : { ...p.hair, style: rng.pick(hairFor(female ? 'female' : 'male')) },
    brows: p.brows ?? { style: 'mind_eyebrows_11_Default', colour: 0x2a1d16, thickness: 1, density: 1, length: 1 },
    lashes: p.lashes ?? { length: female ? 1.15 : 0.9, curl: 0.6, density: 1, colour: 0x161010 },
    outfit: p.outfit ?? randomOutfit(rng, female),
    makeup: p.makeup ?? { lipColour: LIP_COLOURS[0]!, lipAmount: 0, stubble: 0 },
    accessories: p.accessories ?? NO_ACCESSORIES,
    seed: p.seed ?? Math.floor(rng.float() * 1e9),
  };
}

export interface ResolvedPerson {
  readonly weights: MorphWeights;
  /** Uniform scale applied to the shaped mesh. */
  readonly scale: number;
  /** What the result measures (for the interface). */
  readonly heightCm: number;
  readonly massKg: number;
}

export const ANCESTRIES = ['Race_White', 'Race_African', 'Race_EastAsian', 'Race_Hispanic', 'Race_MiddleEastern',
  'Race_Punjabi', 'Race_Bengali', 'Race_Tamil', 'Race_Marathi', 'Race_Telegu', 'Race_Sinhalese', 'Race_Kannada'] as const;

const ANCESTRY_MELANIN: Readonly<Record<string, number>> = {
  Race_White: 0.08, Race_EastAsian: 0.22, Race_Hispanic: 0.38, Race_MiddleEastern: 0.33, Race_African: 0.88,
  Race_Bengali: 0.58, Race_Tamil: 0.72, Race_Punjabi: 0.42, Race_Marathi: 0.56, Race_Telegu: 0.62,
  Race_Sinhalese: 0.6, Race_Kannada: 0.62,
};

/** WHO growth reference medians, 1..18 years: height (cm) [girls, boys] and BMI. */
const GROWTH: readonly (readonly [number, number, number, number])[] = [
  // years, girls cm, boys cm, BMI
  [1, 74, 76, 16.8], [2, 86, 88, 16.2], [3, 95, 96, 15.7], [4, 103, 103, 15.4], [5, 109, 110, 15.3],
  [6, 115, 116, 15.3], [7, 121, 122, 15.5], [8, 127, 128, 15.8], [9, 133, 133, 16.2], [10, 138, 138, 16.6],
  [11, 144, 143, 17.2], [12, 151, 149, 17.8], [13, 156, 156, 18.5], [14, 159, 163, 19.2], [15, 161, 169, 19.8],
  [16, 162, 173, 20.4], [17, 163, 175, 20.9], [18, 163, 176, 21.3],
];

/** Adult means (NCD-RisC 2016, world): women 159, men 171 cm. */
const ADULT_CM: readonly [number, number] = [159, 171];

function growth(years: number): { cm: [number, number]; bmi: number } {
  const y = Math.min(18, Math.max(1, years));
  const i = Math.min(GROWTH.length - 2, Math.floor(y) - 1);
  const a = GROWTH[i]!, b = GROWTH[i + 1]!, t = y - a[0];
  return { cm: [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], bmi: a[3] + (b[3] - a[3]) * t };
}

/** The median height and BMI for a sex and age: the slider's centre. */
export function typical(sex: number, years: number): { heightCm: number; bmi: number } {
  if (years < 18) {
    const g = growth(years);
    return { heightCm: g.cm[0] + (g.cm[1] - g.cm[0]) * sex, bmi: g.bmi };
  }
  // Adults lose about 3 cm of height from 50 to 85.
  const shrink = Math.max(0, Math.min(1, (years - 50) / 35)) * 3;
  return { heightCm: ADULT_CM[0] + (ADULT_CM[1] - ADULT_CM[0]) * sex - shrink, bmi: years < 30 ? 23.5 : 25.5 };
}

/** The Vitruvian's baby morph by age: 1 at one year, 0 from eighteen. */
export function babyWeight(years: number): number {
  const knots: readonly (readonly [number, number])[] = [[1, 1], [3, 0.8], [6, 0.6], [10, 0.38], [14, 0.18], [18, 0]];
  if (years <= 1) return 1;
  for (let i = 1; i < knots.length; i++) {
    const [y0, w0] = knots[i - 1]!, [y1, w1] = knots[i]!;
    if (years <= y1) return w0 + ((years - y0) / (y1 - y0)) * (w1 - w0);
  }
  return 0;
}

const mhr = (group: string, i: number): string => `MHR_${group}_${String(i).padStart(2, '0')}`;
export const BROW_STYLES: readonly string[] = Array.from({ length: 14 }, (_, i) => `mind_eyebrows_${String(i + 1).padStart(2, '0')}${i === 10 ? '_Default' : ''}`);

/** A colour a little darker (brows are darker than the hair on the head). */
export function darker(c: number, k = 0.75): number {
  return (Math.round(((c >> 16) & 255) * k) << 16) | (Math.round(((c >> 8) & 255) * k) << 8) | Math.round((c & 255) * k);
}

const NOT_DETAIL = new Set(['Expression', 'Fantasy', 'Race', 'Gender', 'Age', 'BodyType', 'Generic']);

/** The Vitruvian's own regional sliders: what a feature page edits. */
export function isFeatureMorph(name: string, group: string): boolean {
  return !NOT_DETAIL.has(group) && !name.startsWith('MHR_') && name !== 'Mouth_NoTeeth';
}

/** Eye colours as people have them, with how common each is. */
export const IRIS_COLOURS: readonly (readonly [number, number])[] = [
  [0x3b2416, 0.45], [0x5a3a24, 0.2], [0x7a5a32, 0.08], [0x6e7a4a, 0.08], [0x5d7a8a, 0.1], [0x8aa3b8, 0.06], [0x6a6a6a, 0.03],
];

export function randomPerson(base: HumanBase, rng: Rng, years?: number): PersonParams {
  const sex = rng.bool() ? 1 : 0;
  // An age mix with every age drawn: children, adults, elders.
  const age = years ?? (rng.bool(0.15) ? rng.range(2, 17) : rng.bool(0.15) ? rng.range(65, 88) : rng.range(18, 64));
  const t = typical(sex, age);
  const sd = age < 18 ? t.heightCm * 0.045 : sex ? 7 : 6.5;
  const heightCm = t.heightCm + rng.normal(0, sd);
  const bmi = Math.min(42, Math.max(16, t.bmi * Math.exp(rng.normal(0, age < 18 ? 0.1 : 0.16))));
  const ancestry = rng.pick(ANCESTRIES);
  const melanin = Math.min(1, Math.max(0, ANCESTRY_MELANIN[ancestry]! + rng.normal(0, 0.08)));
  const detail: Record<string, number> = {};
  for (const m of base.morphs.values()) {
    if (!isFeatureMorph(m.name, m.group)) continue;
    if (m.group === 'Chest' && sex) continue;
    detail[m.name] = m.min < 0 ? rng.normal(0, 0.12) : rng.bool(0.4) ? Math.max(0, rng.normal(0, 0.15)) : 0;
  }
  detail['Generic_Assymetry'] = rng.normal(0, 0.2);
  const hair = age < 1.5 ? { ...randomHair(rng, !sex, age, melanin), style: 'buzz' } : randomHair(rng, !sex, age, melanin);
  return {
    name: '', sex, years: age, heightCm, bmi, melanin, ancestry,
    muscle: Math.max(0, rng.normal(0, sex ? 0.25 : 0.12)),
    iris: rng.weighted(IRIS_COLOURS),
    expression: '', expressionAmount: 0,
    undertone: rng.normal(0, 0.35),
    hair: hair,
    brows: { style: rng.pick(BROW_STYLES), colour: darker(hair.colour), thickness: rng.range(0.8, sex ? 1.4 : 1.1), density: rng.range(0.7, 1.1), length: 1 },
    lashes: { length: sex ? rng.range(0.8, 1) : rng.range(1, 1.35), curl: rng.range(0.4, 0.9), density: rng.range(0.8, 1.2), colour: 0x141010 },
    outfit: randomOutfit(rng, !sex),
    makeup: { lipColour: rng.pick(LIP_COLOURS), lipAmount: !sex && age > 15 && rng.bool(0.4) ? rng.range(0.3, 0.8) : 0, stubble: sex && age > 17 && rng.bool(0.45) ? rng.range(0.3, 1) : 0 },
    accessories: {
      glasses: rng.bool(age > 40 ? 0.45 : 0.15) ? { style: rng.pick(GLASSES_STYLES.slice(1)), colour: rng.pick(FRAME_COLOURS), tint: 0xffffff, tintAmount: 0 } : NO_ACCESSORIES.glasses,
      earrings: !sex && age > 6 && rng.bool(0.5) ? { style: rng.pick(EARRING_STYLES.slice(1)), colour: rng.pick(METALS) } : NO_ACCESSORIES.earrings,
    },
    seed: Math.floor(rng.float() * 1e9),
    body: Array.from({ length: 20 }, () => rng.normal(0, 0.8)),
    head: Array.from({ length: 20 }, () => rng.normal(0, 0.7)),
    hands: Array.from({ length: 5 }, () => rng.normal(0, 0.8)),
    detail,
  };
}

/** Closed-skin volume of a shape, m3 (signed tetrahedra from the origin). */
function volume(base: HumanBase, shape: Float32Array, tris: Uint32Array): number {
  let v = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]! * 3, b = tris[t + 1]! * 3, c = tris[t + 2]! * 3;
    v += shape[a]! * (shape[b + 1]! * shape[c + 2]! - shape[b + 2]! * shape[c + 1]!)
      - shape[a + 1]! * (shape[b]! * shape[c + 2]! - shape[b + 2]! * shape[c]!)
      + shape[a + 2]! * (shape[b]! * shape[c + 1]! - shape[b + 1]! * shape[c]!);
  }
  void base;
  return Math.abs(v) / 6;
}

function heightOf(shape: Float32Array): number {
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < shape.length; i += 3) { const y = shape[i]!; if (y < lo) lo = y; if (y > hi) hi = y; }
  return hi - lo;
}

const DENSITY = 1010;

interface Solver { tris: Uint32Array; gradV: Float64Array; gradH: Float64Array }
const SOLVERS = new WeakMap<HumanBase, Solver>();

/** Skin triangles over mesh vertices, and how volume and height move per body component. */
function solver(base: HumanBase): Solver {
  const cached = SOLVERS.get(base);
  if (cached) return cached;
  const skin: number[] = [];
  for (const g of base.meta.groups) {
    if (g.material !== 'Skin' && g.material !== 'Covered') continue;
    for (let i = g.start; i < g.start + g.count; i++) skin.push(base.renderSource[base.index[i]!]!);
  }
  const tris = Uint32Array.from(skin);
  const s0 = base.shape({});
  const v0 = volume(base, s0, tris), h0 = heightOf(s0);
  const gradV = new Float64Array(20), gradH = new Float64Array(20);
  for (let i = 0; i < 20; i++) {
    const s = base.shape({ [mhr('Body', i)]: 1 });
    gradV[i] = volume(base, s, tris) - v0;
    gradH[i] = heightOf(s) - h0;
  }
  const out = { tris, gradV, gradH };
  SOLVERS.set(base, out);
  return out;
}

function weightsFor(base: HumanBase, p: PersonParams, body: readonly number[], fat = 0): Record<string, number> {
  const w: Record<string, number> = { ...p.detail };
  if (fat > 0) w['BodyType_Fat'] = fat;
  if (p.muscle > 0) w['BodyType_Muscular'] = p.muscle;
  if (p.expression) w[p.expression] = p.expressionAmount;
  w['Gender_Female'] = 1 - p.sex;
  w['Gender_Male'] = p.sex;
  w[p.ancestry] = 0.85;
  const baby = babyWeight(p.years);
  if (baby > 0) w['Age_Baby'] = baby;
  if (p.years > 40) w['Age_Old'] = Math.min(1, (p.years - 40) / 45);
  // A child's body is the baby morph's; the adult scan components fade out.
  const adult = 1 - baby;
  const axis = base.morphs.has(mhr('Body', 0)) ? sexAxis(base) : [];
  const along = body.reduce((s, c, i) => s + c * (axis[i] ?? 0), 0);
  body.forEach((c, i) => { w[mhr('Body', i)] = (c - along * (axis[i] ?? 0)) * adult; });
  p.head.forEach((c, i) => { w[mhr('Head', 20 + i)] = c * adult; });
  p.hands.forEach((c, i) => { w[mhr('Hands', 40 + i)] = c * adult; });
  return w;
}

/**
 * Morph weights and scale for a person: the body components are moved
 * (smallest change, height held) until the scaled body's mass gives the BMI.
 */
export function resolvePerson(base: HumanBase, p: PersonParams): ResolvedPerson {
  const hasMhr = base.morphs.has(mhr('Body', 0));
  const targetH = p.heightCm / 100;
  const targetMass = p.bmi * targetH * targetH;
  let body = [...p.body];
  let fat = 0;
  let shape = base.shape(weightsFor(base, p, body));
  let scale = targetH / heightOf(shape);
  if (hasMhr) {
    const { tris, gradV, gradH } = solver(base);
    // The component direction that changes volume but not height.
    const hh = gradH.reduce((s, g) => s + g * g, 0) || 1;
    const vh = gradV.reduce((s, g, i) => s + g * gradH[i]!, 0);
    const raw = Array.from(gradV, (g, i) => g - (vh / hh) * gradH[i]!);
    const len = Math.hypot(...raw) || 1;
    // Unit length, so a step k is in component units (the draws' sigmas).
    const dir = raw.map((g) => g / len);
    const dd = dir.reduce((s, g, i) => s + g * gradV[i]!, 0) || 1;
    // Mass as a function of a step k along `dir`, solved by the secant
    // method from the linear model's first guess (the response bends at
    // the extremes, where a fixed linear step overshot).
    const base0 = [...p.body];
    const massAt = (k: number): number => {
      body = base0.map((c, i) => Math.max(-3.5, Math.min(3.5, c + k * dir[i]!)));
      shape = base.shape(weightsFor(base, p, body));
      scale = targetH / heightOf(shape);
      return volume(base, shape, tris) * scale ** 3 * DENSITY;
    };
    let k0 = 0, m0 = massAt(0);
    let k1 = Math.max(-6, Math.min(6, (targetMass - m0) / (DENSITY * scale ** 3) / dd)), m1 = massAt(k1);
    for (let iter = 0; iter < 4 && Math.abs(m1 - targetMass) > 0.3 && m1 !== m0; iter++) {
      const k2 = Math.max(-6, Math.min(6, k1 + (targetMass - m1) * (k1 - k0) / (m1 - m0)));
      k0 = k1; m0 = m1; k1 = k2; m1 = massAt(k1);
    }
    // Heavier than the scans' space reaches (BMI past ~32): the
    // Vitruvian's own fat morph adds the rest, solved the same way.
    if (targetMass - m1 > 0.5) {
      const atFat = (f: number): number => {
        fat = f;
        shape = base.shape(weightsFor(base, p, body, f));
        scale = targetH / heightOf(shape);
        return volume(base, shape, tris) * scale ** 3 * DENSITY;
      };
      let f0 = 0, n0 = m1, f1 = 0.5, n1 = atFat(f1);
      for (let iter = 0; iter < 5 && Math.abs(n1 - targetMass) > 0.3 && n1 !== n0; iter++) {
        const f2 = Math.max(0, Math.min(1.5, f1 + (targetMass - n1) * (f1 - f0) / (n1 - n0)));
        f0 = f1; n0 = n1; f1 = f2; n1 = atFat(f1);
      }
    }
  }
  const { tris } = hasMhr ? solver(base) : { tris: new Uint32Array() };
  const massKg = hasMhr ? volume(base, shape, tris) * scale ** 3 * DENSITY : 0;
  return { weights: weightsFor(base, p, body, fat), scale, heightCm: heightOf(shape) * scale * 100, massKg };
}
