import { Rng } from '@core/rng';
import type { CatalogPage } from '@people/gen/catalog';
import { randomName } from '@people/gen/names';
import { ANCESTRIES, IRIS_COLOURS, randomPerson, resolvePerson, type PersonParams, type ResolvedPerson } from '@people/gen/person';
import { CreatorStage, loadBase } from '@render/people/generator/stage';
import { Creator } from '@ui/creator/creator';
import { applyTranslations, initLanguage } from '@ui/i18n';

/**
 * The person creator's page (`human-generator.html`): composition root.
 * One person at a time, edited as in The Sims' Create a Sim
 * (`ui/creator/creator.ts`), drawn by `render/people/generator/stage.ts` from
 * the Vitruvian base with the MHR's scan-learned shape
 * (`people/gen/person.ts` turns the settings into a body).
 */

const URLS = import.meta.glob('/public/models/humans/*/*.{json,bin,jpg}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const urlOf = (base: string) => (file: string): string => {
  const url = URLS[`/public/models/humans/${base}/${file}`];
  if (!url) throw new Error(`missing human asset ${base}/${file}`);
  return url;
};

initLanguage();
applyTranslations();

const canvas = document.getElementById('view') as HTMLCanvasElement;
const stage = new CreatorStage(canvas);
const b = await loadBase('vitruvian', urlOf('vitruvian'));
document.getElementById('loading')?.remove();

let seed = Date.now() % 100000;
const rng = (): Rng => new Rng(++seed * 7919);

// The last person resolved: drawing and the readout share one solve.
let last: { p: PersonParams; r: ResolvedPerson } | null = null;
const resolved = (p: PersonParams): ResolvedPerson => {
  if (last?.p !== p) last = { p, r: resolvePerson(b.base, p) };
  return last.r;
};

function randomPage(p: PersonParams, page: CatalogPage): PersonParams {
  const r = rng();
  switch (page.id) {
    case 'basics': {
      const q = randomPerson(b.base, r);
      return { ...p, sex: q.sex, years: q.years, heightCm: q.heightCm, bmi: q.bmi, muscle: q.muscle };
    }
    case 'build': return { ...p, body: p.body.map(() => r.normal(0, 0.8)) };
    case 'faceShape': return { ...p, head: p.head.map(() => r.normal(0, 0.7)) };
    case 'skin': {
      const ancestry = r.pick(ANCESTRIES);
      const q = randomPerson(b.base, r);
      return { ...p, ancestry, melanin: q.melanin, iris: r.weighted(IRIS_COLOURS) };
    }
    case 'expression': return { ...p, expression: r.pick(['Smile_Lips_Closed', 'Happy', 'Thinking', 'Sad', 'Angry', 'Oops']), expressionAmount: r.range(0.5, 1) };
    default: {
      const detail = { ...p.detail };
      for (const name of page.morphs) {
        const m = b.base.morphs.get(name);
        if (m) detail[name] = m.min < 0 ? Math.max(-1, Math.min(1, r.normal(0, 0.35))) : r.bool(0.5) ? Math.min(1, Math.abs(r.normal(0, 0.35))) : 0;
      }
      return { ...p, detail };
    }
  }
}

const creator = new Creator({
  base: b.base,
  random: () => {
    const r = rng();
    const p = randomPerson(b.base, r);
    return { ...p, name: randomName(r, p.sex) };
  },
  randomPage,
  show: (p) => {
    const r = resolved(p);
    stage.updatePerson(b, { shape: b.base.shape(r.weights), scale: r.scale, melanin: p.melanin, iris: p.iris });
  },
  measure: (p) => resolved(p),
  focus: (f) => stage.frame(f),
  pick: (x, y) => stage.pick(x, y),
  portrait: () => stage.portrait(),
}, document.getElementById('creator')!, canvas);

// The person is framed between the category rail and the page panel.
const insets = (): void => {
  const rail = document.querySelector('.cr-rail')!.getBoundingClientRect();
  const page = document.querySelector('.cr-page')!.getBoundingClientRect();
  stage.setInsets(rail.right, window.innerWidth - page.left);
};
insets();
window.addEventListener('resize', insets);

// For probes: a known state without clicking.
(window as unknown as { __hgen: object }).__hgen = { creator, stage, open: (c: string, p?: string) => creator.open(c, p) };
