// Biblioteca de materiais: presets prontos (procedurais e fotografados) com
// miniatura de verdade, e o painel do material ativo do balde (acabamento,
// cores e parâmetros do gerador). Clicar num material arma o balde; clicar
// numa face pinta só ela, Shift pinta o volume inteiro, Alt copia.
import type { Editor3 } from '../editor/editor';
import type { MaterialRef } from '../model/schema';
import { FINISHES } from '../render/finishes';
import { PROC, procParams, procThumb } from '../render/procedural';
import { PBR_SETS } from '../render/pbr';

export interface MaterialPreset {
  id: string;
  name: string;
  group: 'Paredes' | 'Pisos' | 'Coberturas' | 'Metais e madeira' | 'Fotografados';
  ref: MaterialRef;
}

const P = (id: string, name: string, group: MaterialPreset['group'], finish: string, color: string, color2?: string, params?: Record<string, number>): MaterialPreset => ({
  id,
  name,
  group,
  ref: { finish, color, ...(color2 ? { color2 } : {}), ...(params ? { params } : {}) },
});

export const MATERIAL_PRESETS: MaterialPreset[] = [
  P('reb-branco', 'Reboco branco', 'Paredes', 'plaster', '#ece7dd'),
  P('reb-areia', 'Reboco areia', 'Paredes', 'plaster', '#d9c6a2'),
  P('reb-terra', 'Reboco terracota', 'Paredes', 'plaster', '#c47a52'),
  P('reb-ocre', 'Reboco ocre', 'Paredes', 'plaster', '#d7a54e'),
  P('pint-cinza', 'Pintura cinza', 'Paredes', 'paint', '#9ea3a6'),
  P('pint-verde', 'Pintura verde-água', 'Paredes', 'paint', '#9fc2b3'),
  P('tij-aparente', 'Tijolo aparente', 'Paredes', 'brick', '#a8553a', '#d8d2c6'),
  P('tij-claro', 'Tijolo claro', 'Paredes', 'brick', '#c9a27a', '#ece6da'),
  P('tij-ingles', 'Tijolo inglês escuro', 'Paredes', 'brick', '#6e3b2a', '#bdb3a4', { bond: 2 }),
  P('tij-branco', 'Tijolo pintado', 'Paredes', 'brick', '#ece8e0', '#d6d0c5', { vary: 0.15 }),
  P('pedra-calc', 'Pedra calcária', 'Paredes', 'stone', '#cfc4ae', '#bdb3a0'),
  P('pedra-escura', 'Pedra escura', 'Paredes', 'stone', '#7d7a73', '#5d5a54', { h: 0.3, len: 0.5 }),
  P('concreto', 'Concreto aparente', 'Paredes', 'concrete', '#b9b6ae'),
  P('concreto-liso', 'Concreto liso', 'Paredes', 'concrete', '#c7c4bc', undefined, { ties: 0, w: 2.4, h: 1.2 }),
  P('piso-ceram', 'Piso cerâmico', 'Pisos', 'floor', '#d8d1c4', '#a39b8e'),
  P('porcelanato', 'Porcelanato claro', 'Pisos', 'floor', '#e5e2dc', '#c9c4bb', { w: 0.9, gloss: 0.8 }),
  P('terracota', 'Ladrilho terracota', 'Pisos', 'floor', '#b86a45', '#d8cbb8', { w: 0.3, vary: 0.6, gloss: 0.1 }),
  P('intertravado', 'Piso intertravado', 'Pisos', 'paving', '#9a8f80', '#7c746a'),
  P('deck', 'Deck de madeira', 'Pisos', 'wood', '#8a5f3e', '#2c241d', { w: 0.14 }),
  P('telha', 'Telha cerâmica', 'Coberturas', 'tile', '#a3593a', '#5a3424'),
  P('telha-velha', 'Telha envelhecida', 'Coberturas', 'tile', '#7d4b36', '#3f2a20', { vary: 0.9 }),
  P('ardosia', 'Ardósia', 'Coberturas', 'slate', '#4b5258', '#1c1f22'),
  P('manta', 'Manta', 'Coberturas', 'membrane', '#8f9290'),
  P('telha-metal', 'Telha metálica', 'Coberturas', 'metal', '#9aa3a9'),
  P('chapa', 'Chapa com junta', 'Metais e madeira', 'panel', '#5f6870'),
  P('chapa-cobre', 'Chapa cobre', 'Metais e madeira', 'panel', '#a86b45'),
  P('madeira', 'Tábuas naturais', 'Metais e madeira', 'wood', '#9b6a43', '#2c241d'),
  P('madeira-esc', 'Tábuas escuras', 'Metais e madeira', 'wood', '#5a3b26', '#1d150f'),
  ...Object.keys(PBR_SETS).map((id) => P(id, FINISHES.find((f) => f.id === id)?.name ?? id, 'Fotografados', id, id.startsWith('tile') ? '#b9714f' : id.startsWith('brick') ? '#c47a5a' : '#d9d4ca')),
];

const thumbs = new Map<string, string>();

/** Miniatura de um material (gerada uma vez). */
export function materialThumb(ref: MaterialRef): string | null {
  const key = JSON.stringify(ref);
  const got = thumbs.get(key);
  if (got) return got;
  let url: string | null = null;
  if (PROC[ref.finish]) url = procThumb(ref.finish, ref.params, ref.color, ref.color2 ?? PROC[ref.finish]!.color2);
  else if (PBR_SETS[ref.finish]) url = `./tex/${PBR_SETS[ref.finish]!.dir}/color.jpg`;
  if (url) thumbs.set(key, url);
  return url;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (v: number) => String(Math.round(v * 1000) / 1000).replace('.', ',');

/** Painel do material ativo do balde (no inspetor enquanto pinta). */
export function paintPanel(ed: Editor3): string {
  const m = ed.paintMat;
  const proc = PROC[m.finish];
  const p = proc ? procParams(m.finish, m.params) : {};
  const thumb = materialThumb(m);
  const opts = FINISHES.filter((f) => f.id !== 'glass')
    .map((f) => `<option value="${f.id}" ${f.id === m.finish ? 'selected' : ''}>${esc(f.name)}</option>`)
    .join('');
  const params = proc
    ? proc.params
        .map((d) =>
          d.options
            ? `<label class="f3-field"><span>${d.label}</span><select data-mp="${d.key}">${d.options.map((o, i) => `<option value="${i}" ${Math.round(p[d.key]!) === i ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`
            : `<label class="f3-field"><span>${d.label}${['vary', 'grain', 'gloss'].includes(d.key) ? '' : ' (m)'}</span><input data-mp="${d.key}" inputmode="decimal" data-step="${d.step}" value="${num(p[d.key]!)}"></label>`,
        )
        .join('')
    : '';
  return `<div class="f3-title"><span>Material do balde</span><span class="f3-kind">Pintar</span></div>
  <div class="f3-sec" style="padding-top:10px">
    <div style="display:flex;gap:10px;align-items:center">
      <div style="width:64px;height:64px;border-radius:8px;flex:none;background:${thumb ? `url('${thumb}') center/cover` : m.color};box-shadow:inset 0 0 0 1px #ffffff14"></div>
      <div style="display:grid;gap:6px;flex:1;min-width:0">
        <select class="f3-pick" data-mk="finish" aria-label="Acabamento">${opts}</select>
        <div class="f3-row" style="gap:10px"><label class="f3-swatch" title="Cor principal"><input type="color" data-mk="color" value="${m.color}">Cor</label>${proc && proc.color2 !== '#ffffff' ? `<label class="f3-swatch" title="Junta, argamassa, rejunte"><input type="color" data-mk="color2" value="${m.color2 ?? proc.color2}">Junta</label>` : ''}</div>
      </div>
    </div>
  </div>
  ${params ? `<div class="f3-sec"><h3>Padrão</h3><div class="f3-grid2">${params}</div></div>` : ''}
  <div class="f3-sec"><p class="f3-empty" style="padding:6px 0 0">Clique numa face para pintar só ela · <kbd>Shift</kbd> o volume inteiro · <kbd>Alt</kbd> copia o material.</p></div>`;
}

export function bindPaintPanel(ed: Editor3, root: HTMLElement): void {
  const parse = (s: string) => parseFloat(s.replace(',', '.'));
  const set = (fn: (m: MaterialRef) => void) => {
    const m = structuredClone(ed.paintMat);
    fn(m);
    ed.paintMat = m;
    ed.select({ ...ed.sel });
  };
  root.querySelector<HTMLSelectElement>('[data-mk="finish"]')?.addEventListener('change', (e) =>
    set((m) => {
      m.finish = (e.target as HTMLSelectElement).value;
      delete m.params;
      delete m.color2;
    }),
  );
  root.querySelector<HTMLInputElement>('[data-mk="color"]')?.addEventListener('change', (e) => set((m) => void (m.color = (e.target as HTMLInputElement).value)));
  root.querySelector<HTMLInputElement>('[data-mk="color2"]')?.addEventListener('change', (e) => set((m) => void (m.color2 = (e.target as HTMLInputElement).value)));
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-mp]').forEach((el) =>
    el.addEventListener('change', () => {
      const v = parse(el.value);
      if (Number.isFinite(v)) set((m) => void (m.params = { ...(m.params ?? {}), [el.dataset.mp!]: v }));
    }),
  );
}
