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
