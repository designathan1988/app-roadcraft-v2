// Acabamento comum dos painéis (kit): cada painel gera o HTML dos campos e
// este passo padroniza tudo de uma vez — unidade dentro do campo, rótulo em
// linha (longo ocupa a linha inteira), arrastar o rótulo muda o número (como
// no Figma e no Blender), seções recolhíveis lembradas entre seleções.

const CLOSED_KEY = 'forma3_closed_sections';
/** Seções que começam recolhidas (ferramentas menos usadas). */
const DEFAULT_CLOSED = new Set(['Modificar', 'Frisos e cornija', 'Modelar rápido', 'Repetição', 'Detalhes', 'Perfil', 'Categorias na vista']);

function loadClosed(): Set<string> {
  try {
    const raw = localStorage.getItem(CLOSED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set(DEFAULT_CLOSED);
  } catch {
    return new Set(DEFAULT_CLOSED);
  }
}
const closed = loadClosed();
function saveClosed(): void {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...closed]));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}

const parse = (s: string) => parseFloat(s.replace(',', '.'));
const fmt = (v: number, step: number) => {
  const d = step >= 1 ? 0 : step >= 0.1 ? 2 : 3;
  return String(Math.round(v * 10 ** d) / 10 ** d).replace('.', ',');
};

/** Padroniza um painel recém-desenhado. */
export function polish(root: HTMLElement): void {
  for (const f of root.querySelectorAll<HTMLElement>('.f3-field')) {
    const span = f.querySelector<HTMLElement>(':scope>span');
    const ctl = f.querySelector<HTMLInputElement | HTMLSelectElement>(':scope>input,:scope>select');
    if (!span || !ctl) continue;
    // "Altura (m)" → rótulo "Altura" + unidade "m" dentro do campo.
    const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(span.textContent ?? '');
    let label = span.textContent ?? '';
    let unit = '';
    if (m) {
      label = m[1]!;
      const u = m[2]!;
      // Unidade curta vai para dentro; nota longa vira dica.
      if (/^(m|°|%|cm|mm|m²)$/.test(u)) unit = u;
      else if (/^m;/.test(u)) {
        unit = 'm';
        f.title = `${label}: ${u.slice(2).trim()}`;
      } else f.title = `${label} (${u})`;
      span.textContent = label;
    }
    if (!f.title) f.title = label;
    if (label.length > 11 || (ctl instanceof HTMLSelectElement && label.length > 7)) f.classList.add("w");
    // Opção longa não cabe ao lado do rótulo (sobram ~95 px com a seta): rótulo em cima, campo na linha toda.
    if (ctl instanceof HTMLSelectElement && Math.max(0, ...[...ctl.options].map((o) => o.text.length)) > 14) f.classList.add('w', 'st');
    if (ctl instanceof HTMLInputElement && ctl.type !== 'color') {
      const wrap = document.createElement('span');
      wrap.className = 'f3-in';
      ctl.replaceWith(wrap);
      wrap.appendChild(ctl);
      if (unit) {
        const em = document.createElement('em');
        em.textContent = unit;
        wrap.appendChild(em);
      }
      if (ctl.inputMode === 'decimal') scrub(span, ctl);
    }
  }
  // Seções recolhíveis.
  for (const sec of root.querySelectorAll<HTMLElement>('.f3-sec')) {
    const h = sec.querySelector<HTMLElement>(':scope>h3');
    if (!h) continue;
    const key = (h.childNodes[0]?.textContent ?? h.textContent ?? '').trim() || (h.textContent ?? '').trim();
    if (closed.has(key)) sec.classList.add('closed');
    h.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button,input,select')) return;
      const now = !sec.classList.toggle('closed');
      if (now) closed.delete(key);
      else closed.add(key);
      saveClosed();
    });
  }
}

/** Arrastar o rótulo muda o número pelo passo do campo (Shift ×10, Alt ÷10). */
function scrub(label: HTMLElement, input: HTMLInputElement): void {
  label.classList.add('drag');
  label.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = parse(input.value) || 0;
    const step = parse(input.dataset.step ?? '0.1') || 0.1;
    const x0 = e.clientX;
    let moved = false;
    label.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 2) moved = true;
      const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      input.value = fmt(start + Math.round(dx / 4) * step * k, step * k);
    };
    const up = () => {
      label.removeEventListener('pointermove', move);
      label.removeEventListener('pointerup', up);
      if (moved) input.dispatchEvent(new Event('change'));
      else input.focus();
    };
    label.addEventListener('pointermove', move);
    label.addEventListener('pointerup', up);
  });
}

/**
 * Fecha um menu ou janela flutuante no primeiro toque fora dele (fase de
 * captura: o canvas não engole o evento). Toques dentro não gastam o ouvinte;
 * `except` (o botão que abre) também não fecha. Devolve o desligador.
 */
export function closeOnOutside(el: HTMLElement, close: () => void, except?: Element | null): () => void {
  const off = () => document.removeEventListener('pointerdown', on, true);
  const on = (e: PointerEvent) => {
    if (!el.isConnected) return off();
    const t = e.target as Node;
    if (el.contains(t) || except?.contains(t)) return;
    off();
    close();
  };
  setTimeout(() => el.isConnected && document.addEventListener('pointerdown', on, true), 0);
  return off;
}
