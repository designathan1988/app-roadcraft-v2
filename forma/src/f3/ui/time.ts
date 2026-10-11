// Hora do dia na barra de estado: botão com a hora e um controle deslizante
// (dia, pôr do sol, noite). A hora fica no estado da vista do projeto.
import type { Editor3 } from '../editor/editor';
import { viewOf } from '../model/layers';
import { icon } from './icons';
import { closeOnOutside } from './kit';

const fmt = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

export function mountTime(ed: Editor3): void {
  const bar = ed.shell.viewbar;
  const btn = document.createElement('button');
  btn.className = 'f3-tb';
  btn.title = 'Hora do dia: sol, céu e luzes da noite';
  const anchor = bar.querySelector('[data-cmd="snap"]')!;
  bar.insertBefore(btn, anchor);
  let hour = viewOf(ed.project).time ?? 13;
  const apply = (h: number, save = true) => {
    hour = Math.max(0, Math.min(23.99, h));
    const dark = ed.view.look.setTime(hour);
    ed.view.setDark(dark);
    ed.view.mark();
    btn.innerHTML = `${icon(dark > 0.5 ? 'moon' : 'sun')}<span>${fmt(hour)}</span>`;
    btn.setAttribute('aria-pressed', String(dark > 0.5));
    if (save) viewOf(ed.project).time = hour;
  };
  apply(hour, false);
  let pop: HTMLElement | null = null;
  let off: (() => void) | null = null;
  const close = () => {
    off?.();
    off = null;
    pop?.remove();
    pop = null;
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop) return close();
    pop = document.createElement('div');
    pop.className = 'f3-island';
    pop.style.cssText = 'position:absolute;z-index:20;width:260px;padding:10px 12px;display:grid;gap:8px';
    pop.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><b style="font-size:12px">Hora do dia</b><span data-h style="margin-left:auto;font:600 12px ui-monospace,Consolas,monospace">${fmt(hour)}</span></div>
      <input type="range" min="0" max="23.75" step="0.25" value="${hour}" aria-label="Hora" style="width:100%;accent-color:var(--accent)">
      <div class="f3-seg"><button data-p="9">Manhã</button><button data-p="13">Meio-dia</button><button data-p="18.5">Pôr do sol</button><button data-p="21.5">Noite</button></div>`;
    const r = btn.getBoundingClientRect(),
      rv = ed.shell.view.getBoundingClientRect();
    pop.style.left = `${Math.min(rv.width - 270, r.left - rv.left - 100)}px`;
    pop.style.bottom = `${rv.bottom - r.top + 8}px`;
    ed.shell.view.appendChild(pop);
    const range = pop.querySelector<HTMLInputElement>('input')!;
    const label = pop.querySelector<HTMLElement>('[data-h]')!;
    range.addEventListener('input', () => {
      apply(parseFloat(range.value));
      label.textContent = fmt(hour);
    });
    pop.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) =>
      b.addEventListener('click', () => {
        apply(parseFloat(b.dataset.p!));
        range.value = String(hour);
        label.textContent = fmt(hour);
      }),
    );
    off = closeOnOutside(pop, close, btn);
  });
  // Projeto aberto ou novo: volta à hora salva nele.
  ed.store.on((ev) => {
    if (ev.kind === 'change' && (ed.project.view?.time ?? 13) !== hour && !pop) apply(ed.project.view?.time ?? 13, false);
  });
}
