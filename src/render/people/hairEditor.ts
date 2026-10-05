import { HAIR_STYLES, type HairStyle } from '@people/hair/procedural';
import { ageFromYears } from '@people/body/macro';
import { randomPerson } from '@people/spec';
import type { ProceduralCrowd, ProceduralPerson } from './proceduralCrowd';

/**
 * The hairstyle editor of the people lab (`people-lab.html?editor`): sliders
 * over a `HairStyle`, the style grown again on every change
 * (`people/hair/procedural.ts`) and worn by three bodies - a young woman, a
 * girl and an old woman - so it is seen fitting each.
 */

interface Slider { readonly key: string; readonly label: string; readonly min: number; readonly max: number; readonly step: number }
const SLIDERS: readonly Slider[] = [
  { key: 'length', label: 'Comprimento', min: 0.4, max: 5.5, step: 0.05 },
  { key: 'part', label: 'Risca (direita ↔ esquerda)', min: -1, max: 1, step: 0.05 },
  { key: 'volume', label: 'Volume', min: 0, max: 0.35, step: 0.01 },
  { key: 'gravity', label: 'Queda', min: 0.05, max: 0.9, step: 0.01 },
  { key: 'wave', label: 'Ondas', min: 0, max: 0.2, step: 0.005 },
  { key: 'fringe', label: 'Franja (0 = sem)', min: 0, max: 1.7, step: 0.05 },
  { key: 'clumps', label: 'Mechas', min: 60, max: 320, step: 10 },
  { key: 'cardWidth', label: 'Largura da mecha', min: 0.15, max: 0.7, step: 0.01 },
];

export function mountHairEditor(panel: HTMLElement, crowd: ProceduralCrowd, status: HTMLElement): { people: () => readonly ProceduralPerson[] } {
  const values: Record<string, number> = {};
  let gather: 'none' | 'ponytail' | 'bun' = 'none';
  let colour = '#4a3222';
  let people: ProceduralPerson[] = [];

  const fromStyle = (s: HairStyle): void => {
    values['length'] = s.length; values['part'] = s.part; values['volume'] = s.volume; values['gravity'] = s.gravity;
    values['wave'] = s.wave?.amplitude ?? 0; values['fringe'] = s.fringe?.length ?? 0;
    values['clumps'] = s.clumps; values['cardWidth'] = s.cardWidth;
    gather = s.gather?.bun ? 'bun' : s.gather ? 'ponytail' : 'none';
  };
  const toStyle = (): HairStyle => {
    const base = { name: 'custom', length: values['length']!, part: values['part']!, volume: values['volume']!, gravity: values['gravity']!,
      clumps: values['clumps']!, cardWidth: values['cardWidth']!, layers: (values['length']! < 1.2 ? 1 : 2) as 1 | 2,
      strands: (values['wave']! > 0.03 ? 'wavy' : 'straight') as 'wavy' | 'straight' };
    return {
      ...base,
      ...(values['wave']! > 0 ? { wave: { amplitude: values['wave']!, wavelength: 1.3 } } : {}),
      ...(values['fringe']! > 0 ? { fringe: { length: values['fringe']!, width: 0.55 } } : {}),
      ...(gather === 'ponytail' ? { gather: { at: [0, 7.75, -0.55] as const, tail: Math.max(0.8, values['length']! - 0.4) } } : {}),
      ...(gather === 'bun' ? { gather: { at: [0, 8.05, -0.45] as const, tail: 0, bun: 0.42 } } : {}),
    };
  };

  panel.innerHTML = `<h1>Editor de cabelo</h1>
    <p>O penteado é calculado pelos números abaixo: nada vem de arquivo. Mude e ele cresce de novo, nos três corpos.</p>
    <div class="row"><select id="preset">${Object.keys(HAIR_STYLES).filter((k) => k !== 'custom').map((k) => `<option value="${k}">Partir de: ${k}</option>`).join('')}</select></div>
    <div id="sliders"></div>
    <div class="row">
      <label>Preso: <select id="gather"><option value="none">solto</option><option value="ponytail">rabo de cavalo</option><option value="bun">coque</option></select></label>
      <label>Cor: <input id="colour" type="color" value="${colour}"></label>
    </div>`;
  const box = panel.querySelector('#sliders')!;
  const inputs = new Map<string, HTMLInputElement>();
  for (const s of SLIDERS) {
    const row = document.createElement('label');
    row.className = 'slider';
    row.innerHTML = `<span>${s.label} <b></b></span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}">`;
    const input = row.querySelector('input')!;
    input.addEventListener('input', () => { values[s.key] = Number(input.value); show(); schedule(); });
    inputs.set(s.key, input);
    box.appendChild(row);
  }
  const gatherEl = panel.querySelector('#gather') as HTMLSelectElement;
  const show = (): void => {
    for (const s of SLIDERS) {
      const input = inputs.get(s.key)!;
      input.value = String(values[s.key]);
      (input.previousElementSibling!.querySelector('b')!).textContent = Number(values[s.key]).toFixed(s.step < 0.1 ? 2 : 0);
    }
    gatherEl.value = gather;
  };

  let timer = 0;
  let running = Promise.resolve();
  const schedule = (): void => {
    clearTimeout(timer);
    timer = window.setTimeout(() => { running = running.then(grow); }, 180);
  };
  const BODIES: readonly { years: number; x: number }[] = [{ years: 9, x: -1.1 }, { years: 26, x: 0 }, { years: 68, x: 1.1 }];
  const grow = async (): Promise<void> => {
    const started = performance.now();
    HAIR_STYLES['custom'] = toStyle();
    crowd.forget('hair:custom');
    crowd.clear();
    people = [];
    for (const [i, b] of BODIES.entries()) {
      const spec = randomPerson(100 + i, 4242 + i, { body: { gender: 0, age: ageFromYears(b.years) }, look: { hairCut: 'hair:custom', hair: parseInt(colour.slice(1), 16), extras: [] } });
      const person = await crowd.add(spec).catch(() => null);
      if (!person) continue;
      person.matrix.makeRotationY(0).setPosition(b.x, 0, 1.2);
      person.clip = 'idle';
      people.push(person);
    }
    status.textContent = `Penteado gerado em ${((performance.now() - started) / 1000).toFixed(2)} s. Arraste para girar; a roda do mouse aproxima.`;
  };

  (panel.querySelector('#preset') as HTMLSelectElement).addEventListener('change', (e) => {
    fromStyle(HAIR_STYLES[(e.currentTarget as HTMLSelectElement).value]!);
    show(); schedule();
  });
  gatherEl.addEventListener('change', () => { gather = gatherEl.value as typeof gather; schedule(); });
  (panel.querySelector('#colour') as HTMLInputElement).addEventListener('input', (e) => { colour = (e.currentTarget as HTMLInputElement).value; schedule(); });

  fromStyle(HAIR_STYLES['longWavy']!);
  (panel.querySelector('#preset') as HTMLSelectElement).value = 'longWavy';
  show();
  schedule();
  return { people: () => people };
}
