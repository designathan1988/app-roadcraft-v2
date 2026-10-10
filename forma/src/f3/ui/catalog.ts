// Catálogo de componentes: categorias, busca, favoritos, miniaturas reais
// (renderizadas da própria família) e arrastar para a parede/chão. Clicar
// num cartão começa a posicionar; os tipos do projeto aparecem em "Meus".
import type { Editor3 } from '../editor/editor';
import type { ComponentType } from '../model/schema';
import { BUILTIN_TYPES, family } from '../families/index';
import { CATEGORY_NAMES, type Category } from '../families/family';
import { createThumbnailer, type Thumbnailer } from '../render/thumbs';
import { icon } from './icons';
import { BLOCKS } from '../model/blocks';

const FAV_KEY = 'forma3_favorites';
const ORDER: Category[] = ['windows', 'doors', 'balconies', 'railings', 'fences', 'gates', 'structure', 'stairs', 'canopies', 'shading', 'ornament', 'roofgear', 'industrial', 'site', 'walls', 'facade'];

function loadFavs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function mountCatalog(ed: Editor3): { open(): void } {
  const host = ed.shell.cat;
  const favs = loadFavs();
  let tab: string = 'blocks';
  let query = '';
  let thumbs: Thumbnailer | null = null;
  const types = (): ComponentType[] => [...BUILTIN_TYPES, ...ed.project.types.filter((t) => !BUILTIN_TYPES.some((b) => b.id === t.id))];
  const cats = (): string[] => {
    const present = new Set(types().map((t) => family(t.family)?.category).filter(Boolean) as string[]);
    return ['blocks', 'fav', ...ORDER.filter((c) => present.has(c)), 'mine'];
  };
  host.innerHTML = `<div class="f3-cat-head"><span style="display:flex;align-items:center;gap:6px;font-weight:600">${icon('catalog')}Componentes</span>
    <input type="search" placeholder="Buscar: janela, portão, sacada…" aria-label="Buscar componentes">
    <div class="f3-cat-tabs" role="tablist"></div>
    <button class="f3-btn" data-c="toggle" title="Mostrar/ocultar">▾</button></div><div class="f3-cards"></div>`;
  const search = host.querySelector<HTMLInputElement>('input')!;
  const tabsEl = host.querySelector<HTMLElement>('.f3-cat-tabs')!;
  const cards = host.querySelector<HTMLElement>('.f3-cards')!;
  host.querySelector('[data-c="toggle"]')!.addEventListener('click', () => host.classList.toggle('closed'));
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderCards();
  });
  search.addEventListener('keydown', (e) => e.stopPropagation());

  const label = (c: string) => (c === 'blocks' ? 'Blocos' : c === 'fav' ? '★ Favoritos' : c === 'mine' ? 'Meus' : CATEGORY_NAMES[c as Category]);
  const renderTabs = () => {
    tabsEl.innerHTML = cats()
      .map((c) => `<button data-tab="${c}" aria-pressed="${c === tab && !query}">${label(c)}</button>`)
      .join('');
    tabsEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab!;
        query = '';
        search.value = '';
        renderTabs();
        renderCards();
      }),
    );
  };

  const list = (): ComponentType[] => {
    const all = types();
    if (query) {
      return all.filter((t) => {
        const f = family(t.family);
        const hay = `${t.name} ${f?.name ?? ''} ${(f?.tags ?? []).join(' ')} ${f ? CATEGORY_NAMES[f.category] : ''}`.toLowerCase();
        return query.split(/\s+/).every((w) => hay.includes(w));
      });
    }
    if (tab === 'fav') return all.filter((t) => favs.has(t.id));
    if (tab === 'mine') return ed.project.types.filter((t) => t.user);
    return all.filter((t) => family(t.family)?.category === tab);
  };

  const renderCards = () => {
    renderTabs();
    if (tab === 'blocks' && !query) {
      // Blocos de massa: clique e solte no chão, sobre um telhado ou encostado numa parede.
      cards.innerHTML = BLOCKS.map((b) => `<div class="f3-card" data-block="${b.id}" title="${b.name}: no chão cria um edifício; sobre um telhado empilha; numa parede encosta alinhado (X recorta)" aria-pressed="${ed.tool === 'block' && ed.blockId === b.id}"><div class="f3-blockico">${icon(b.icon)}</div><span>${b.name}</span></div>`).join('');
      cards.querySelectorAll<HTMLElement>('[data-block]').forEach((c) =>
        c.addEventListener('click', () => {
          ed.startBlock(c.dataset.block!);
          renderCards();
        }),
      );
      return;
    }
    const items = list();
    if (!items.length) {
      cards.innerHTML = `<p class="f3-empty" style="padding:6px 4px">${tab === 'fav' && !query ? 'Marque ★ nos componentes que mais usa.' : tab === 'mine' && !query ? 'Tipos criados com "Tornar único" aparecem aqui.' : 'Nada encontrado.'}</p>`;
      return;
    }
    cards.innerHTML = items
      .map((t) => {
        const f = family(t.family)!;
        const host = f.host === 'face' ? 'parede' : f.host === 'path' ? 'caminho' : f.host === 'roof' ? 'telhado' : 'chão';
        return `<div class="f3-card" draggable="true" data-type="${t.id}" title="${t.name} · vai na ${host}" aria-pressed="${ed.placing === t.id}">
        <button class="fav" data-fav="${t.id}" aria-pressed="${favs.has(t.id)}" aria-label="Favorito">${icon('star')}</button>
        <img alt="" data-thumb="${t.id}"><span>${t.name}</span></div>`;
      })
      .join('');
    thumbs ??= createThumbnailer(ed.view.renderer, ed.view.ctx, { project: ed.project });
    cards.querySelectorAll<HTMLImageElement>('img[data-thumb]').forEach((img) => {
      const id = img.dataset.thumb!;
      const t = types().find((x) => x.id === id);
      if (!t) return;
      void thumbs!.get(id, t.params, t.family).then((url) => {
        img.src = url;
        ed.view.mark();
      }).catch(() => undefined);
    });
    cards.querySelectorAll<HTMLElement>('.f3-card').forEach((c) => {
      c.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.fav')) return;
        ed.startPlacing(c.dataset.type!);
        renderCards();
      });
      c.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/forma-type', c.dataset.type!);
        ed.placing = c.dataset.type!;
      });
    });
    cards.querySelectorAll<HTMLButtonElement>('.fav').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.fav!;
        favs.has(id) ? favs.delete(id) : favs.add(id);
        try {
          localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
        } catch {
          /* sem armazenamento: favoritos valem só nesta sessão */
        }
        renderCards();
      }),
    );
  };

  ed.catalogRequested = () => {
    host.classList.remove('closed');
    search.focus();
  };
  let lastPlacing: string | null = null;
  ed.onChange(() => {
    if (ed.placing !== lastPlacing) {
      lastPlacing = ed.placing;
      cards.querySelectorAll<HTMLElement>('.f3-card').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.type === ed.placing)));
    }
  });
  renderCards();
  return { open: () => ed.catalogRequested?.() };
}
