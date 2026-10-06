import { GeneratorStage, loadBase, type GeneratorView } from '@render/people/generator/stage';
import { applyTranslations, initLanguage, t } from '@ui/i18n';

/**
 * The human generator's page (`human-generator.html`): composition root.
 * The base is CharMorph's Vitruvian (mesh, skin, eyes, expressions) with the
 * MHR's scan-learned shape carried onto it (the player's choice, 2026-10-06):
 * a row of random people, seen from the front, side, back and close at the
 * face, and an ages row.
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
const stage = new GeneratorStage(canvas);
const status = document.getElementById('status')!;
const agesButton = document.getElementById('ages')!;
let seed = 1;
let ages = false;
let view: GeneratorView = 'front';

function placeLabels(): void {
  const xs = stage.screenXs();
  const mid = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : canvas.clientWidth / 2;
  document.getElementById('label-base')!.style.left = `${mid}px`;
}

function setView(next: GeneratorView): void {
  view = next;
  stage.setView(view);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#views button')) b.classList.toggle('on', b.dataset['view'] === view);
  placeLabels();
}

window.addEventListener('resize', () => { stage.resize(); placeLabels(); });

const bases = [await loadBase('vitruvian', urlOf('vitruvian'))];

function populate(): void {
  const { count, ms } = stage.populate(bases, seed, ages);
  status.textContent = t('hgen.ready', { count, ms });
  agesButton.classList.toggle('on', ages);
  setView(view);
}

populate();
document.getElementById('reroll')!.addEventListener('click', () => { seed++; populate(); });
agesButton.addEventListener('click', () => { ages = !ages; populate(); });
for (const b of document.querySelectorAll<HTMLButtonElement>('#views button')) {
  b.addEventListener('click', () => setView(b.dataset['view'] as GeneratorView));
}
// For probes: a known state without clicking.
(window as unknown as { __hgen: object }).__hgen = {
  setView,
  reroll: () => { seed++; populate(); },
  setAges: (on: boolean) => { ages = on; populate(); },
  look: (eye: [number, number, number], target: [number, number, number]) => stage.look(eye, target),
  show: (weights: Record<string, number>) => stage.showWeights(bases[0]!, weights),
  stage,
};
