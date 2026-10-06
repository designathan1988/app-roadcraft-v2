import type { Rng } from '@core/rng';
import type { HumanBase, MorphWeights } from './humanBase';

/**
 * Random bodies for the base comparison (slice 0). Not yet calibrated to a
 * population; slice 1 replaces this with heights and BMIs drawn by sex and
 * age (WHO) and solved into the morphs.
 *
 * - MHR: its identity space is a PCA of 7,110 scans, so each coefficient is a
 *   draw from a normal; the MHR demo draws them with sigma 0.8.
 * - Vitruvian: CharMorph's own randomiser nudges every slider uniformly; here
 *   the sliders are drawn by what they mean: a sex, one or two ancestries, a
 *   build, and small independent variations of every face and body region.
 * - Vitruvian with the MHR's shape (`MHR_*` morphs, the player's choice of
 *   2026-10-06): the build comes from the MHR's components drawn as the MHR
 *   draws them, less the part of them that is sex - sex is the Vitruvian's
 *   own morph, which also shapes the face and chest - and the Vitruvian's
 *   regional sliders add smaller face and body detail.
 */

export type Sex = 'female' | 'male';

export interface SampledBody {
  readonly weights: MorphWeights;
  readonly sex: Sex | null;
  /** 0 light .. 1 dark, for the skin textures' blend. */
  readonly melanin: number;
}

const ANCESTRY_MELANIN: Readonly<Record<string, number>> = {
  Race_White: 0.05, Race_EastAsian: 0.2, Race_Hispanic: 0.35, Race_MiddleEastern: 0.3, Race_African: 0.9,
  Race_Bengali: 0.55, Race_Tamil: 0.7, Race_Punjabi: 0.4, Race_Marathi: 0.55, Race_Telegu: 0.6,
  Race_Sinhalese: 0.6, Race_Kannada: 0.6,
};

/** Groups that are not a region's variation: drawn on their own, or never. */
const NOT_REGIONAL = new Set(['Expression', 'Fantasy', 'Race', 'Gender', 'Age', 'BodyType', 'Generic']);

export function sampleBody(base: HumanBase, rng: Rng, age: 'adult' | 'any' = 'any'): SampledBody {
  if (base.meta.base === 'mhr') {
    const weights: Record<string, number> = {};
    for (const m of base.morphs.values()) if (m.group !== 'Expression') weights[m.name] = rng.normal(0, 0.8);
    return { weights, sex: null, melanin: rng.float() };
  }

  const w: Record<string, number> = {};
  const sex: Sex = rng.bool() ? 'female' : 'male';
  w[sex === 'female' ? 'Gender_Female' : 'Gender_Male'] = rng.range(0.8, 1);

  const races = Object.keys(ANCESTRY_MELANIN).filter((r) => base.morphs.has(r));
  const first = rng.pick(races);
  const firstW = rng.range(0.55, 1);
  w[first] = firstW;
  let melanin = ANCESTRY_MELANIN[first]! * firstW;
  let total = firstW;
  if (rng.bool(0.4)) {
    const second = rng.pick(races);
    if (second !== first) {
      const sw = rng.range(0.1, 1 - firstW + 0.1);
      w[second] = sw; melanin += ANCESTRY_MELANIN[second]! * sw; total += sw;
    }
  }
  melanin = Math.min(1, Math.max(0, melanin / total + rng.normal(0, 0.06)));

  const half = (sd: number): number => Math.max(0, rng.normal(0, sd));
  if (base.morphs.has('MHR_Body_00')) {
    const body = Array.from({ length: 20 }, () => rng.normal(0, 0.8));
    const axis = sexAxis(base);
    const along = body.reduce((sum, c, i) => sum + c * axis[i]!, 0);
    body.forEach((c, i) => { w[mhrName('Body', i)] = c - along * axis[i]!; });
    for (let i = 20; i < 40; i++) w[mhrName('Head', i)] = rng.normal(0, 0.7);
    for (let i = 40; i < 45; i++) w[mhrName('Hands', i)] = rng.normal(0, 0.8);
    w['Generic_Assymetry'] = rng.normal(0, 0.2);
    if (age === 'any' && rng.bool(0.3)) w['Age_Old'] = rng.range(0.2, 0.9);
    for (const m of base.morphs.values()) {
      if (NOT_REGIONAL.has(m.group) || m.name in w || m.name.startsWith('MHR_')) continue;
      if (m.group === 'Chest' && sex === 'male') continue;
      w[m.name] = m.min < 0 ? rng.normal(0, 0.12) : rng.bool(0.4) ? half(0.15) : 0;
    }
    return { weights: w, sex, melanin };
  }
  w['BodyType_Fat'] = half(0.35);
  w['BodyType_Muscular'] = half(sex === 'male' ? 0.3 : 0.15);
  w['BodyType_Lean'] = half(0.2);
  w['BodyType_Emaciated'] = rng.bool(0.05) ? rng.range(0, 0.4) : 0;
  w['BodyType_LongProportions'] = rng.normal(0, 0.25);
  w['Generic_Assymetry'] = rng.normal(0, 0.25);
  if (age === 'any' && rng.bool(0.3)) w['Age_Old'] = rng.range(0.2, 0.9);

  for (const m of base.morphs.values()) {
    if (NOT_REGIONAL.has(m.group) || m.name in w) continue;
    if (m.group === 'Chest' && sex === 'male') continue;
    w[m.name] = m.min < 0 ? rng.normal(0, 0.22) : rng.bool(0.5) ? half(0.25) : 0;
  }
  return { weights: w, sex, melanin };
}

const mhrName = (group: string, i: number): string => `MHR_${group}_${String(i).padStart(2, '0')}`;

const AXES = new WeakMap<HumanBase, number[]>();

/**
 * The unit direction in the MHR's 20 body components that best reproduces
 * the Vitruvian's female-minus-male morph (least squares over every vertex):
 * the part of a random MHR body that is its sex.
 */
export function sexAxis(base: HumanBase): readonly number[] {
  const cached = AXES.get(base);
  if (cached) return cached;
  const f = base.denseDelta('Gender_Female');
  const m = base.denseDelta('Gender_Male');
  for (let i = 0; i < f.length; i++) f[i] = f[i]! - m[i]!;
  const B = Array.from({ length: 20 }, (_, i) => base.denseDelta(mhrName('Body', i)));
  const n = B.length;
  // Normal equations (B^T B) c = B^T f, solved by Gaussian elimination.
  const a = Array.from({ length: n }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    for (let j = 0; j < n; j++) { let s = 0; const bi = B[i]!, bj = B[j]!; for (let k = 0; k < bi.length; k++) s += bi[k]! * bj[k]!; row[j] = s; }
    let r = 0; const bi = B[i]!; for (let k = 0; k < bi.length; k++) r += bi[k]! * f[k]!; row[n] = r;
    return row;
  });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    [a[c], a[p]] = [a[p]!, a[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = a[r]![c]! / a[c]![c]!;
      for (let j = c; j <= n; j++) a[r]![j] = a[r]![j]! - k * a[c]![j]!;
    }
  }
  const x = a.map((row, i) => row[n]! / row[i]!);
  const len = Math.hypot(...x) || 1;
  const axis = x.map((v) => v / len);
  AXES.set(base, axis);
  return axis;
}
