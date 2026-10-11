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
import { MATERIAL_PRESETS, materialThumb } from './materials';
import { readImageFile } from '../render/images';
import { uid } from '../model/defaults';

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
    return ['blocks', 'materials', 'fav', ...ORDER.filter((c) => present.has(c)), 'mine'];
  };
  host.innerHTML = `<div class="f3-cat-head"><b>Biblioteca</b>
    <input type="search" placeholder="Buscar: janela, portão, sacada…" aria-label="Buscar na biblioteca">
    <button class="f3-tb" data-c="close" title="Fechar · K">${icon('close')}</button></div>
    <div class="f3-cat-body"><div class="f3-cat-tabs" role="tablist"></div><div class="f3-cards"></div></div>`;
  const search = host.querySelector<HTMLInputElement>('input')!;
  const tabsEl = host.querySelector<HTMLElement>('.f3-cat-tabs')!;
  const cards = host.querySelector<HTMLElement>('.f3-cards')!;
  host.querySelector('[data-c="close"]')!.addEventListener('click', () => ed.toggleLibrary(false));
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderCards();
  });
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') ed.toggleLibrary(false);
  });

  const label = (c: string) => (c === 'blocks' ? 'Blocos de massa' : c === 'materials' ? 'Materiais' : c === 'fav' ? 'Favoritos' : c === 'mine' ? 'Meus tipos' : CATEGORY_NAMES[c as Category]);
  const renderTabs = () => {
    tabsEl.innerHTML = cats()
      .map((c) => `<button data-tab="${c}" aria-pressed="${c === tab && !query}">${label(c)}</button>${c === 'fav' ? '<hr>' : ''}`)
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
          ed.toggleLibrary(false);
        }),
      );
      return;
    }
    if (tab === 'materials' && !query) {
      let html = '';
      let group = '';
      for (const m of MATERIAL_PRESETS) {
        if (m.group !== group) {
          group = m.group;
          html += `<div style="grid-column:1/-1;font-size:11px;color:var(--faint);padding:4px 2px 0">${group}</div>`;
        }
        const th = materialThumb(m.ref);
        html += `<div class="f3-card" data-mat="${m.id}" title="${m.name}: clique e pinte as faces (Shift: volume todo)"><img alt="" ${th ? `src="${th}"` : ''} style="object-fit:cover"><span>${m.name}</span></div>`;
      }
      cards.innerHTML = html;
      cards.querySelectorAll<HTMLElement>('[data-mat]').forEach((c) =>
        c.addEventListener('click', () => {
          const m = MATERIAL_PRESETS.find((x) => x.id === c.dataset.mat)!;
          ed.paintMat = structuredClone(m.ref);
          ed.setTool('paint');
          ed.toggleLibrary(false);
          ed.toast(`${m.name}: clique numa face para pintar.`);
        }),
      );
      return;
    }
    const items = list();
    // Revestimentos e fachada: além das áreas, o cartão de imagem própria.
    const upload = tab === 'facade' && !query ? `<div class="f3-card" data-upload title="Escolher uma imagem do computador e colocar numa parede (cartaz, grafite, logo, mural)"><div class="f3-blockico">${icon('open')}</div><span>Imagem…</span></div>` : '';
    if (!items.length && !upload) {
      cards.innerHTML = `<p class="f3-empty" style="padding:6px 4px">${tab === 'fav' && !query ? 'Marque ★ nos componentes que mais usa.' : tab === 'mine' && !query ? 'Tipos criados com "Tornar único" aparecem aqui.' : 'Nada encontrado.'}</p>`;
      return;
    }
    cards.innerHTML = upload + items
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
    cards.querySelector<HTMLElement>('[data-upload]')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', async () => {
        const f = input.files?.[0];
        if (!f) return;
        try {
          const im = await readImageFile(f);
          const w = Math.min(4, Math.max(0.5, im.w / 400));
          const type = { id: uid(), family: 'image-decal', name: im.name, params: { image: im.id, width: Math.round(w * 100) / 100, height: Math.round(((w * im.h) / im.w) * 100) / 100 }, user: true };
          (ed.project.images ??= []).push(im);
          ed.project.types.push(type);
          ed.store.commit(null, 'Imagem adicionada ao projeto.', false);
          ed.startPlacing(type.id);
          ed.toggleLibrary(false);
          ed.toast(`${im.name}: clique numa parede para colocar.`);
        } catch (err) {
          ed.toast(`Não foi possível usar a imagem: ${(err as Error).message}`);
        }
      });
      input.click();
    });
    cards.querySelectorAll<HTMLElement>('.f3-card[data-type]').forEach((c) => {
      c.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.fav')) return;
        ed.startPlacing(c.dataset.type!);
        ed.toggleLibrary(false);
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
    renderCards();
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
