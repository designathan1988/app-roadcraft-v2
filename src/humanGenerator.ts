import { GeneratorStage, loadBase, type GeneratorView } from '@render/people/generator/stage';
import { applyTranslations, initLanguage, t } from '@ui/i18n';

/**
 * The human generator's page (`human-generator.html`): composition root.
 * Slice 0: the two candidate bases side by side under the same light, random
 * people of each, seen from the front, side, back and close at the face, and
 * in an ages line, for the player to choose the base the generator is built on.
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
  const [left, right] = stage.baseCentres();
  const w = canvas.clientWidth;
  document.getElementById('label-vitruvian')!.style.left = `${Math.max(160, left)}px`;
  document.getElementById('label-mhr')!.style.left = `${Math.min(w - 160, right)}px`;
}

function setView(next: GeneratorView): void {
  view = next;
  stage.setView(view);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#views button')) b.classList.toggle('on', b.dataset['view'] === view);
  placeLabels();
}

window.addEventListener('resize', () => { stage.resize(); placeLabels(); });

const bases = await Promise.all([loadBase('vitruvian', urlOf('vitruvian')), loadBase('mhr', urlOf('mhr'))]);

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
};
