import { Rng } from '@core/rng';
import type { CatalogPage } from '@people/gen/catalog';
import { bodyFor, dressBody } from '@people/gen/clothes';
import { HumanExtras, beardMask, faceAnchors, type ExtrasMeta } from '@people/gen/extras';
import { browStrands, hairStrands, lashStrands } from '@people/gen/hair';
import { randomName } from '@people/gen/names';
import {
  ANCESTRIES, IRIS_COLOURS, completePerson, darker, randomHair, randomOutfit, randomPerson, resolvePerson, type PersonParams, type ResolvedPerson,
} from '@people/gen/person';
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
const [b, ex] = await Promise.all([
  loadBase('vitruvian', urlOf('vitruvian')),
  Promise.all([
    fetch(urlOf('vitruvian')('extras.json')).then((r) => r.json() as Promise<ExtrasMeta>),
    fetch(urlOf('vitruvian')('extras.bin')).then((r) => r.arrayBuffer()),
  ]).then(([meta, bin]) => new HumanExtras(meta, bin)),
]);
document.getElementById('loading')?.remove();

// Per render vertex: lips, beard, scalp (the skin shader's make-up masks).
const masks = (() => {
  const beard = beardMask(ex, b.base);
  const out = new Float32Array(b.base.renderVertexCount * 3);
  for (let r = 0; r < b.base.renderVertexCount; r++) {
    const v = b.base.renderSource[r]!;
    out[r * 3] = ex.lips[v]! / 255; out[r * 3 + 1] = beard[v]! / 255; out[r * 3 + 2] = ex.scalp[v]! / 255;
  }
  return out;
})();
let first = true;

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
    case 'hairStyle': case 'hairColour': case 'hairShape': return { ...p, hair: randomHair(r, p.sex < 0.5, p.years, p.melanin) };
    case 'top': case 'bottom': case 'shoes': {
      const o = randomOutfit(r, p.sex < 0.5);
      return { ...p, outfit: { ...p.outfit, [page.id]: o[page.id as 'top' | 'bottom' | 'shoes'] } };
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

/**
 * Draws a person. The body is redrawn when what shapes it changed; each worn
 * layer (hair, brows, lashes, clothes) when its own settings or, once the
 * slider is let go, the body under it changed - so a body slider moves only
 * the body while it is dragged.
 */
const SHAPE_KEYS = ['sex', 'years', 'heightCm', 'bmi', 'muscle', 'ancestry', 'detail', 'body', 'head', 'hands', 'expression', 'expressionAmount'] as const;
const sameBody = (a: PersonParams, c: PersonParams): boolean => SHAPE_KEYS.every((k) => a[k] === c[k]);
let shown: PersonParams | null = null;
let bodyVersion = 0;
let shaped: { shape: Float32Array; body: ReturnType<typeof bodyFor> | null } | null = null;
const built: Record<string, { params: unknown; version: number }> = {};
const times: Record<string, number> = {};

function draw(p: PersonParams, live: boolean): void {
  const t0 = performance.now();
  if (!shown || !shaped || !sameBody(shown, p)) {
    const r = resolved(p);
    const shape = b.base.shape(r.weights);
    const drawn = { shape, scale: r.scale, melanin: p.melanin, iris: p.iris };
    if (first) { stage.setPerson(b, drawn, masks); first = false; } else stage.updatePerson(b, drawn);
    shaped = { shape, body: null };
    bodyVersion++;
  } else if (shown.melanin !== p.melanin || shown.iris !== p.iris) {
    stage.updatePerson(b, { shape: shaped.shape, scale: resolved(p).scale, melanin: p.melanin, iris: p.iris });
  }
  times['body'] = Math.round(performance.now() - t0);
  const current = shaped;
  // The body's normals, worked out only when a layer is rebuilt.
  const body = (): ReturnType<typeof bodyFor> => (current.body ??= bodyFor(b.base, ex, current.shape));
  const stale = (name: string, params: unknown): boolean => {
    const was = built[name];
    const changed = !was || was.params !== params;
    const moved = !was || was.version !== bodyVersion;
    if (changed || (moved && !live)) { built[name] = { params, version: bodyVersion }; return true; }
    return false;
  };
  const h = p.hair;
  let t = performance.now();
  if (stale('hair', h)) {
    const hair = hairStrands(ex, b.base, body(), h, p.seed);
    stage.strands('hair', hair, { root: darker(h.colour, 0.8), tip: h.tipColour, grey: 0xc4c2be, shine: 1 });
    stage.follicles(hair.follicles ?? null, h.style === 'buzz' ? 0.35 : 1);
  }
  times['hair'] = Math.round(performance.now() - t); t = performance.now();
  if (stale('brows', p.brows)) stage.strands('brows', browStrands(ex, b.base, shaped.shape, p.brows, p.seed + 1), { root: p.brows.colour, tip: p.brows.colour, shine: 0.25, fadeThin: true });
  if (stale('lashes', p.lashes)) stage.strands('lashes', lashStrands(ex, b.base, shaped.shape, p.lashes, p.seed + 2), { root: p.lashes.colour, tip: p.lashes.colour, shine: 0.15, fadeThin: true });
  times['face'] = Math.round(performance.now() - t); t = performance.now();
  if (stale('clothes', p.outfit) || stale('clothesSex', p.sex < 0.5)) stage.clothes(dressBody(body(), p.outfit, p.sex < 0.5));
  times['clothes'] = Math.round(performance.now() - t);
  if (stale('accessories', p.accessories)) stage.accessories(p.accessories.glasses, p.accessories.earrings, faceAnchors(ex, b.base, current.shape));
  stage.skin({
    undertone: p.undertone, lipColour: p.makeup.lipColour, lipAmount: p.makeup.lipAmount,
    stubble: p.makeup.stubble, stubbleColour: h.grey > 0.6 ? 0x8a8680 : darker(h.colour, 0.9), follicleColour: h.grey > 0.6 ? 0x8a8680 : darker(h.colour, 0.85),
  });
  shown = p;
  times['total'] = Math.round(performance.now() - t0);
  (window as unknown as { __hgenTimes: object }).__hgenTimes = { ...times };
}

const creator = new Creator({
  base: b.base,
  random: () => {
    const r = rng();
    const p = randomPerson(b.base, r);
    return { ...p, name: randomName(r, p.sex) };
  },
  complete: (p) => completePerson(p, rng()),
  randomPage,
  show: (p, live = false) => draw(p, live),
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
