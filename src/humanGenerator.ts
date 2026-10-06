import { Rng } from '@core/rng';
import { ANCESTRIES, randomPerson, resolvePerson, typical, type PersonParams } from '@people/gen/person';
import { GeneratorStage, loadBase, type DrawnPerson, type GeneratorView } from '@render/people/generator/stage';
import { applyTranslations, initLanguage, t } from '@ui/i18n';

/**
 * The human generator's page (`human-generator.html`): composition root.
 * The base is CharMorph's Vitruvian (mesh, skin, eyes, expressions) with the
 * MHR's scan-learned shape carried onto it (the player's choice, 2026-10-06).
 * A row of people drawn as a population; a click selects one and the
 * sliders edit them (`people/gen/person.ts` turns the sliders into a body).
 */

const URLS = import.meta.glob('/public/models/humans/*/*.{json,bin,jpg}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const urlOf = (base: string) => (file: string): string => {
  const url = URLS[`/public/models/humans/${base}/${file}`];
  if (!url) throw new Error(`missing human asset ${base}/${file}`);
  return url;
};

initLanguage();
applyTranslations();

const COUNT = 8;
const AGES_ROW = [3, 6, 10, 14, 18, 30, 55, 80];

const canvas = document.getElementById('view') as HTMLCanvasElement;
const stage = new GeneratorStage(canvas);
const status = document.getElementById('status')!;
const agesButton = document.getElementById('ages')!;
const b = await loadBase('vitruvian', urlOf('vitruvian'));

let seed = 1;
let selected = 0;
let view: GeneratorView = 'front';
let people: PersonParams[] = [];
const irises: number[] = [];

function draw(p: PersonParams): DrawnPerson {
  const r = resolvePerson(b.base, p);
  return { shape: b.base.shape(r.weights), scale: r.scale, melanin: p.melanin, iris: 0 };
}

function rerollAll(ages = false): void {
  const started = performance.now();
  const rng = new Rng(seed * 7919);
  people = Array.from({ length: COUNT }, (_, i) => randomPerson(b.base, rng.fork(`p${i}`), ages ? AGES_ROW[i] : undefined));
  irises.length = 0;
  for (let i = 0; i < COUNT; i++) irises.push(rng.bool(0.25) ? 0x6a8aa0 : rng.bool(0.3) ? 0x6e7a4a : 0x5a3a24);
  stage.setPeople(b, people.map((p, i) => ({ ...draw(p), iris: irises[i]! })));
  stage.select(selected);
  status.textContent = t('hgen.ready', { count: COUNT, ms: Math.round(performance.now() - started) });
  agesButton.classList.toggle('on', ages);
  syncSliders();
}

// ---- sliders

interface SliderDef {
  readonly key: string;
  readonly group: string;
  range(p: PersonParams): [number, number, number];
  get(p: PersonParams): number;
  set(p: PersonParams, v: number): PersonParams;
  show(v: number): string;
}

const comp = (field: 'body' | 'head', i: number): SliderDef => ({
  key: `hgen.${field}${i + 1}`, group: field === 'body' ? 'hgen.group.shape' : 'hgen.group.face',
  range: () => [-3, 3, 0.05],
  get: (p) => p[field][i] ?? 0,
  set: (p, v) => ({ ...p, [field]: p[field].map((c, j) => (j === i ? v : c)) }),
  show: (v) => v.toFixed(1),
});

/** Changing age or sex keeps the person's place in the population (their percentile). */
function keepPlace(p: PersonParams, next: Partial<PersonParams>): PersonParams {
  const before = typical(p.sex, p.years), q = { ...p, ...next }, after = typical(q.sex, q.years);
  return { ...q, heightCm: p.heightCm * after.heightCm / before.heightCm, bmi: p.bmi * after.bmi / before.bmi };
}

const SLIDERS: readonly SliderDef[] = [
  { key: 'hgen.sex', group: 'hgen.group.person', range: () => [0, 1, 0.01], get: (p) => p.sex,
    set: (p, v) => keepPlace(p, { sex: v }), show: (v) => (v < 0.35 ? t('hgen.female') : v > 0.65 ? t('hgen.male') : '·') },
  { key: 'hgen.age', group: 'hgen.group.person', range: () => [1, 90, 1], get: (p) => p.years,
    set: (p, v) => keepPlace(p, { years: v }), show: (v) => t('hgen.years', { n: Math.round(v) }) },
  { key: 'hgen.height', group: 'hgen.group.person',
    range: (p) => { const m = typical(p.sex, p.years).heightCm; return [Math.round(m * 0.8), Math.round(m * 1.2), 1]; },
    get: (p) => p.heightCm, set: (p, v) => ({ ...p, heightCm: v }), show: (v) => `${Math.round(v)} cm` },
  { key: 'hgen.bmi', group: 'hgen.group.person', range: () => [15, 42, 0.1], get: (p) => p.bmi,
    set: (p, v) => ({ ...p, bmi: v }), show: (v) => v.toFixed(1) },
  { key: 'hgen.skin', group: 'hgen.group.skin', range: () => [0, 1, 0.01], get: (p) => p.melanin,
    set: (p, v) => ({ ...p, melanin: v }), show: (v) => `${Math.round(v * 100)}%` },
  comp('body', 0), comp('body', 1), comp('body', 2), comp('body', 3),
  comp('head', 0), comp('head', 1), comp('head', 2), comp('head', 3),
];

const host = document.getElementById('sliders')!;
const inputs: { def: SliderDef; input: HTMLInputElement; out: HTMLOutputElement }[] = [];
let lastGroup = '';
const ancestry = document.createElement('select');
for (const a of ANCESTRIES) {
  const o = document.createElement('option');
  o.value = a;
  o.dataset['i18n'] = `hgen.anc.${a}`;
  ancestry.append(o);
}
for (const def of SLIDERS) {
  if (def.group !== lastGroup) {
    const g = document.createElement('div');
    g.className = 'group';
    g.dataset['i18n'] = def.group;
    host.append(g);
    lastGroup = def.group;
    if (def.group === 'hgen.group.skin') host.append(ancestry);
  }
  const row = document.createElement('label');
  row.className = 'slider';
  const name = document.createElement('span');
  name.dataset['i18n'] = def.key;
  const input = document.createElement('input');
  input.type = 'range';
  const out = document.createElement('output');
  row.append(name, input, out);
  host.append(row);
  inputs.push({ def, input, out });
}
applyTranslations();

function syncSliders(): void {
  const p = people[selected];
  if (!p) return;
  for (const { def, input, out } of inputs) {
    const [lo, hi, step] = def.range(p);
    input.min = String(lo); input.max = String(hi); input.step = String(step);
    input.value = String(def.get(p));
    out.textContent = def.show(def.get(p));
  }
  ancestry.value = p.ancestry;
  const r = resolvePerson(b.base, p);
  document.getElementById('readout')!.textContent =
    t('hgen.readout', { cm: Math.round(r.heightCm), kg: Math.round(r.massKg), bmi: (r.massKg / (r.heightCm / 100) ** 2).toFixed(1) });
}

// Slider moves are applied once a frame, whatever the input rate.
let pending: PersonParams | null = null;
function edit(next: PersonParams): void {
  people[selected] = next;
  if (pending) { pending = next; return; }
  pending = next;
  requestAnimationFrame(() => {
    const p = pending!;
    pending = null;
    stage.updatePerson(b, selected, { ...draw(p), iris: irises[selected]! });
    syncSliders();
  });
}

for (const { def, input } of inputs) input.addEventListener('input', () => edit(def.set(people[selected]!, Number(input.value))));
ancestry.addEventListener('change', () => edit({ ...people[selected]!, ancestry: ancestry.value }));

// ---- selection, views, buttons

let down: [number, number] | null = null;
canvas.addEventListener('pointerdown', (e) => { down = [e.offsetX, e.offsetY]; });
canvas.addEventListener('pointerup', (e) => {
  // A click, not the end of an orbit drag.
  if (!down || Math.hypot(e.offsetX - down[0], e.offsetY - down[1]) > 4) return;
  const slot = stage.pick(e.offsetX, e.offsetY);
  if (slot === null) return;
  selected = slot;
  stage.select(slot);
  syncSliders();
});

function setView(next: GeneratorView): void {
  view = next;
  stage.setView(view);
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#views button')) btn.classList.toggle('on', btn.dataset['view'] === view);
}
for (const btn of document.querySelectorAll<HTMLButtonElement>('#views button')) {
  btn.addEventListener('click', () => setView(btn.dataset['view'] as GeneratorView));
}
document.getElementById('reroll')!.addEventListener('click', () => { seed++; rerollAll(); });
agesButton.addEventListener('click', () => { seed++; rerollAll(!agesButton.classList.contains('on')); });
document.getElementById('reroll-one')!.addEventListener('click', () => {
  seed++;
  edit(randomPerson(b.base, new Rng(seed * 104729 + selected)));
});
window.addEventListener('resize', () => stage.resize());

rerollAll();

// For probes: a known state without clicking.
(window as unknown as { __hgen: object }).__hgen = {
  setView,
  reroll: () => { seed++; rerollAll(); },
  setAges: (on: boolean) => rerollAll(on),
  select: (slot: number) => { selected = slot; stage.select(slot); syncSliders(); },
  edit: (patch: Partial<PersonParams>) => edit({ ...people[selected]!, ...patch }),
  people: () => people,
  look: (eye: [number, number, number], target: [number, number, number]) => stage.look(eye, target),
  show: (weights: Record<string, number>) => stage.showWeights(b, weights),
  stage,
};
