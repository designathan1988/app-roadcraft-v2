// Aba Camadas: camadas do projeto (olho, cadeado, cor, ativa), visibilidade por
// categoria de componente e a árvore de elementos (edifícios → volumes →
// regras e peças), com olho, cadeado e camada por elemento. Como as Tags e o
// Outliner do SketchUp, as camadas do Rhino e a Visibilidade/Gráficos do Revit.
import type { Editor3 } from '../editor/editor';
import type { Building3, ID, Item, Solid } from '../model/schema';
import { addLayer, activeLayer, buildingHidden, DEFAULT_LAYER, ensureLayers, itemHidden, layersOf, removeLayer, solidHidden, viewOf } from '../model/layers';
import { CATEGORY_NAMES, type Category } from '../families/family';
import { family, typeById } from '../families/index';
import { icon } from './icons';
import { polish } from './kit';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function mountLayers(ed: Editor3): void {
  const pane = ed.shell.layers;
  const tabs = ed.shell.tabs;
  const open = new Set<ID>();
  let lastKey = '';
  tabs.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((t) =>
    t.addEventListener('click', () => {
      const layers = t.dataset.tab === 'layers';
      tabs.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      ed.shell.side.hidden = layers;
      pane.hidden = !layers;
      lastKey = '';
      render();
    }),
  );

  const layerSelect = (cur: ID | undefined, attr: string) =>
    `<select ${attr} title="Camada">${layersOf(ed.project)
      .map((l) => `<option value="${l.id}" ${(cur ?? DEFAULT_LAYER.id) === l.id ? 'selected' : ''}>${esc(l.name)}</option>`)
      .join('')}</select>`;
  const eye = (on: boolean, attr: string) => `<button class="ic" ${attr} aria-pressed="${on}" title="${on ? 'Esconder' : 'Mostrar'}">${icon(on ? 'eye' : 'eyeoff')}</button>`;
  const lock = (on: boolean, attr: string) => `<button class="ic" ${attr} aria-pressed="${!on}" title="${on ? 'Destravar' : 'Travar (aparece, mas não se seleciona)'}">${icon(on ? 'lock' : 'unlock')}</button>`;

  function itemName(it: Item): string {
    return typeById(it.type, ed.project)?.name ?? 'Componente';
  }

  function render(): void {
    if (pane.hidden) return;
    const p = ed.project;
    const key = JSON.stringify([p.layers, p.view, p.buildings.map((b) => [b.id, b.name, b.hidden, b.locked, b.layer, b.solids.map((s) => [s.id, s.name, s.op, s.hidden, s.locked, s.layer, s.facade.map((r) => r.type)]), b.items.map((i) => [i.id, i.type, i.hidden, i.locked, i.layer])]), ed.sel, [...open]]);
    if (key === lastKey && pane.contains(document.activeElement)) return;
    lastKey = key;
    const act = activeLayer(p) ?? DEFAULT_LAYER.id;
    const counts = new Map<ID, number>();
    const inc = (id: ID | undefined) => counts.set(id ?? DEFAULT_LAYER.id, (counts.get(id ?? DEFAULT_LAYER.id) ?? 0) + 1);
    for (const b of p.buildings) {
      inc(b.layer);
      b.solids.forEach((s) => inc(s.layer));
      b.items.forEach((i) => inc(i.layer));
    }
    const layers = layersOf(p)
      .map(
        (l) => `<div class="f3-lrow" data-layer="${l.id}">
        <button class="ic" data-lact="active" aria-pressed="${l.id === act}" title="${l.id === act ? 'Camada ativa (recebe o que for criado)' : 'Tornar ativa'}">${l.id === act ? '●' : '○'}</button>
        <input type="color" data-lact="color" value="${l.color}" title="Cor">
        ${l.id === DEFAULT_LAYER.id ? `<span class="nm">${esc(l.name)}</span>` : `<input class="nm" data-lact="name" value="${esc(l.name)}" aria-label="Nome da camada">`}
        <small style="color:var(--muted)">${counts.get(l.id) ?? 0}</small>
        ${eye(l.visible, 'data-lact="eye"')}${lock(l.locked, 'data-lact="lock"')}
        ${l.id === DEFAULT_LAYER.id ? '<span style="width:24px"></span>' : `<button class="ic" data-lact="del" title="Apagar camada (o conteúdo volta para Padrão)">${icon('trash')}</button>`}
      </div>`,
      )
      .join('');
    const hiddenCats = new Set(p.view?.hiddenCategories ?? []);
    const cats = (Object.keys(CATEGORY_NAMES) as Category[])
      .map((c) => `<div class="f3-lrow" data-cat="${c}"><span class="nm">${CATEGORY_NAMES[c]}</span>${eye(!hiddenCats.has(c), 'data-cact="eye"')}</div>`)
      .join('');
    const tree = p.buildings
      .map((b) => {
        const isOpen = open.has(b.id) || ed.context === b.id;
        const selB = ed.sel.building === b.id && !ed.sel.solids.length && !ed.sel.item;
        let html = `<div class="f3-lrow${buildingHidden(ed.project, b) ? ' off' : ''}" data-b="${b.id}" aria-selected="${selB}">
          <button class="ic" data-tact="fold" title="${isOpen ? 'Recolher' : 'Abrir'}">${isOpen ? '▾' : '▸'}</button>
          <span class="nm" data-tact="pick">${esc(b.name)}</span>${layerSelect(b.layer, 'data-tact="layer"')}${eye(!b.hidden, 'data-tact="eye"')}${lock(!!b.locked, 'data-tact="lock"')}</div>`;
        if (!isOpen) return html;
        for (const s of b.solids) html += solidRow(b, s);
        for (const it of b.items) {
          const sel = ed.sel.item === it.id;
          html += `<div class="f3-lrow sub${itemHidden(ed.project, it) ? ' off' : ''}" data-b="${b.id}" data-i="${it.id}" aria-selected="${sel}"><span class="op">◆</span><span class="nm" data-tact="pick">${esc(itemName(it))}</span>${layerSelect(it.layer, 'data-tact="layer"')}${eye(!it.hidden, 'data-tact="eye"')}${lock(!!it.locked, 'data-tact="lock"')}</div>`;
        }
        return html;
      })
      .join('');
    pane.innerHTML = `<div class="f3-sec"><h3>Camadas <span class="r"><button class="f3-btn ic" data-lact="add" title="Nova camada">${icon('add')}</button></span></h3>${layers}</div>
      <div class="f3-sec"><h3>Elementos <span class="r"><button class="f3-btn ic" data-tact="showall" title="Mostrar tudo">${icon('eye')}</button><button class="f3-btn ic" data-tact="isolate" title="Isolar a seleção (esconde o resto)">${icon('focus')}</button></span></h3>${tree || '<p class="f3-empty" style="padding:0">Nada no projeto ainda.</p>'}</div>
      <div class="f3-sec"><h3>Categorias na vista</h3>${cats}</div>`;
    bind();
    polish(pane);
  }

  function solidRow(b: Building3, s: Solid): string {
    const sel = ed.sel.solids.includes(s.id);
    const op = s.op === 'add' ? '+' : s.op === 'subtract' ? '−' : '∩';
    let html = `<div class="f3-lrow sub${solidHidden(ed.project, s) ? ' off' : ''}" data-b="${b.id}" data-s="${s.id}" aria-selected="${sel}"><span class="op" title="${s.op === 'add' ? 'Soma' : s.op === 'subtract' ? 'Recorte' : 'Interseção'}">${op}</span><span class="nm" data-tact="pick">${esc(s.name)}</span>${layerSelect(s.layer, 'data-tact="layer"')}${eye(!s.hidden, 'data-tact="eye"')}${lock(!!s.locked, 'data-tact="lock"')}</div>`;
    for (const r of s.facade) {
      const t = typeById(r.type, ed.project);
      const f = t && family(t.family);
      html += `<div class="f3-lrow sub2" data-b="${b.id}" data-s="${s.id}" data-r="${r.id}"><span class="op">≡</span><span class="nm" data-tact="pick" title="Seleciona todos os elementos desta regra">${esc(t?.name ?? r.type)}${f ? ` <small style="color:var(--muted)">${esc(CATEGORY_NAMES[f.category])}</small>` : ''}</span></div>`;
    }
    return html;
  }

  function bind(): void {
    const p = ed.project;
    const commitView = (msg: string) => ed.store.commit(null, msg, false);
    pane.querySelector('[data-lact="add"]')?.addEventListener('click', () => {
      const l = addLayer(ed.project);
      viewOf(ed.project).activeLayer = l.id;
      commitView(`Camada "${l.name}" criada e ativa.`);
      ed.toast(`Camada "${l.name}" criada e ativa.`);
    });
    pane.querySelectorAll<HTMLElement>('[data-layer]').forEach((row) => {
      const id = row.dataset.layer!;
      const L = () => ensureLayers(ed.project).find((l) => l.id === id)!;
      row.querySelector('[data-lact="active"]')?.addEventListener('click', () => {
        viewOf(ed.project).activeLayer = id;
        commitView('Camada ativa trocada.');
      });
      row.querySelector<HTMLInputElement>('[data-lact="color"]')?.addEventListener('change', (e) => {
        L().color = (e.target as HTMLInputElement).value;
        commitView('Cor da camada.');
      });
      row.querySelector<HTMLInputElement>('[data-lact="name"]')?.addEventListener('change', (e) => {
        L().name = (e.target as HTMLInputElement).value.trim() || L().name;
        commitView('Camada renomeada.');
      });
      row.querySelector('[data-lact="eye"]')?.addEventListener('click', () => {
        L().visible = !L().visible;
        commitView(L().visible ? 'Camada visível.' : 'Camada escondida.');
      });
      row.querySelector('[data-lact="lock"]')?.addEventListener('click', () => {
        L().locked = !L().locked;
        if (L().locked) ed.select({});
        commitView(L().locked ? 'Camada travada.' : 'Camada destravada.');
      });
      row.querySelector('[data-lact="del"]')?.addEventListener('click', () => {
        if (removeLayer(ed.project, id)) {
          ed.store.commit(null, 'Camada apagada.', true);
          ed.toast('Camada apagada; o conteúdo voltou para Padrão.');
        }
      });
    });
    pane.querySelectorAll<HTMLElement>('[data-cat]').forEach((row) =>
      row.querySelector('[data-cact="eye"]')?.addEventListener('click', () => {
        const v = viewOf(ed.project);
        const c = row.dataset.cat!;
        v.hiddenCategories = v.hiddenCategories.includes(c) ? v.hiddenCategories.filter((x) => x !== c) : [...v.hiddenCategories, c];
        commitView(`${CATEGORY_NAMES[c as Category]}: ${v.hiddenCategories.includes(c) ? 'escondidas' : 'visíveis'}.`);
      }),
    );
    pane.querySelectorAll<HTMLElement>('.f3-lrow[data-b]').forEach((row) => {
      const bid = row.dataset.b!,
        sid = row.dataset.s,
        iid = row.dataset.i,
        rid = row.dataset.r;
      const target = (b: Building3): Building3 | Solid | Item | undefined => (iid ? b.items.find((x) => x.id === iid) : sid ? b.solids.find((x) => x.id === sid) : b);
      row.querySelector('[data-tact="fold"]')?.addEventListener('click', () => {
        if (open.has(bid)) open.delete(bid);
        else open.add(bid);
        lastKey = '';
        render();
      });
      row.querySelector('[data-tact="pick"]')?.addEventListener('click', () => {
        if (!sid && !iid) {
          if (ed.context === bid) ed.enter(null);
          return ed.select({ building: bid });
        }
        if (ed.context !== bid) ed.enter(bid);
        if (rid) {
          const keys = ed.elements().filter((e) => e.key.startsWith(`r|${sid}|${rid}|`)).map((e) => e.key);
          return ed.select({ building: bid, elems: keys });
        }
        if (iid) return ed.select({ building: bid, item: iid });
        ed.select({ building: bid, solids: [sid!] });
      });
      row.querySelector('[data-tact="pick"]')?.addEventListener('dblclick', () => {
        if (!sid && !iid) ed.enter(bid);
      });
      row.querySelector<HTMLSelectElement>('[data-tact="layer"]')?.addEventListener('change', (e) => {
        const v = (e.target as HTMLSelectElement).value;
        ed.change(bid, (b) => {
          const t = target(b);
          if (!t) return false;
          if (v === DEFAULT_LAYER.id) delete t.layer;
          else t.layer = v;
        }, 'Camada trocada.');
      });
      row.querySelector('[data-tact="eye"]')?.addEventListener('click', () =>
        ed.change(bid, (b) => {
          const t = target(b);
          if (!t) return false;
          t.hidden = !t.hidden;
          if (!t.hidden) delete t.hidden;
        }, ''),
      );
      row.querySelector('[data-tact="lock"]')?.addEventListener('click', () => {
        ed.change(bid, (b) => {
          const t = target(b);
          if (!t) return false;
          t.locked = !t.locked;
          if (!t.locked) delete t.locked;
        }, '', false);
        ed.select({});
      });
    });
    pane.querySelector('[data-tact="showall"]')?.addEventListener('click', () => {
      for (const b of p.buildings) {
        delete b.hidden;
        b.solids.forEach((s) => delete s.hidden);
        b.items.forEach((i) => delete i.hidden);
      }
      for (const l of ensureLayers(p)) l.visible = true;
      viewOf(p).hiddenCategories = [];
      ed.store.commit(null, 'Tudo visível.', true);
      ed.toast('Tudo visível.');
    });
    pane.querySelector('[data-tact="isolate"]')?.addEventListener('click', () => {
      const b = ed.activeBuilding();
      if (!b) return ed.toast('Selecione um volume ou edifício para isolar.');
      if (ed.sel.solids.length) {
        ed.change(b.id, (x) => {
          for (const s of x.solids) if (!ed.sel.solids.includes(s.id) && s.op === 'add') s.hidden = true;
        }, 'Seleção isolada. "Mostrar tudo" volta.');
      } else {
        for (const o of p.buildings) if (o.id !== b.id) o.hidden = true;
        ed.store.commit(null, 'Edifício isolado. "Mostrar tudo" volta.', false);
      }
    });
  }

  ed.onChange(render);
  render();
}
