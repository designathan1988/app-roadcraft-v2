import { CATALOG, EXPRESSIONS, type CatalogCategory, type CatalogPage, type Focus } from '@people/gen/catalog';
import type { HumanBase } from '@people/gen/humanBase';
import { ANCESTRIES, IRIS_COLOURS, typical, type PersonParams } from '@people/gen/person';
import { applyTranslations, t } from '../i18n';
import { icon } from './icons';
import { deleteSaved, exportPerson, importPerson, loadSaved, savePerson } from './store';

/**
 * The person creator's interface (`human-generator.html`), laid out as The
 * Sims 4's Create a Sim: one person in the middle; a top bar with their name
 * and the file actions (new, random, undo, redo, save, my people, export,
 * import); a rail of categories on the left (icons, names in tooltips); the
 * open category's page on the right, with its sub-pages as tabs, its sliders
 * (each with a reset) and a die for that page alone. Opening a page tells
 * the host where to point the camera; clicking the person opens the part
 * clicked. Edits are undoable; people are saved with a portrait.
 *
 * The page knows nothing of three.js: the host draws (`CreatorHost`).
 */

export interface CreatorHost {
  readonly base: HumanBase;
  /** A whole new random person. */
  random(): PersonParams;
  /** The same person with one page's settings drawn again. */
  randomPage(p: PersonParams, page: CatalogPage): PersonParams;
  /** Draws the person (cheap enough for every slider move). */
  show(p: PersonParams): void;
  measure(p: PersonParams): { heightCm: number; massKg: number };
  focus(f: Focus): void;
  /** The part of the person under a canvas point, or null. */
  pick(x: number, y: number): Focus | null;
  portrait(): string;
}

const FOCUS_PAGE: Readonly<Record<Focus, [string, string]>> = {
  body: ['body', 'build'], torso: ['body', 'torso'], arms: ['body', 'arms'], legs: ['body', 'legs'],
  head: ['head', 'headShape'], eyes: ['eyes', 'eyeShape'], nose: ['nose', 'nose'], mouth: ['mouth', 'mouth'], ears: ['ears', 'ears'], chin: ['jaw', 'chin'],
};

interface Row { readonly input: HTMLInputElement; readonly out: HTMLOutputElement; readonly sync: (p: PersonParams) => void }

export class Creator {
  private person: PersonParams;
  private savedId: string | null = null;
  private past: PersonParams[] = [];
  private future: PersonParams[] = [];
  private category: CatalogCategory = CATALOG[0]!;
  private page: CatalogPage = CATALOG[0]!.pages[0]!;
  private rows: Row[] = [];
  private pending: PersonParams | null = null;
  private readonly el: Record<string, HTMLElement>;

  constructor(private readonly host: CreatorHost, root: HTMLElement, canvas: HTMLCanvasElement) {
    root.innerHTML = `
      <header class="cr-top">
        <input class="cr-name" maxlength="40" data-i18n-label="hgen.name" />
        <div class="cr-actions">
          ${['new:plus', 'random:dice', 'undo:undo', 'redo:redo', 'save:save', 'gallery:gallery', 'export:download', 'import:upload']
            .map((a) => { const [id, ic] = a.split(':'); return `<button class="cr-icon" data-act="${id}" data-i18n-title="hgen.act.${id}" data-i18n-label="hgen.act.${id}">${icon(ic!)}</button>`; }).join('')}
          <input type="file" accept=".json,application/json" class="cr-file" hidden />
        </div>
      </header>
      <nav class="cr-rail">${CATALOG.map((c) => `<button class="cr-cat" data-cat="${c.id}" data-i18n-title="${c.label}" data-i18n-label="${c.label}">${icon(c.icon)}</button>`).join('')}</nav>
      <aside class="cr-page">
        <div class="cr-page-head"><h2></h2><button class="cr-icon cr-page-dice" data-i18n-title="hgen.act.randomPage" data-i18n-label="hgen.act.randomPage">${icon('dice')}</button></div>
        <div class="cr-tabs"></div>
        <div class="cr-body"></div>
        <div class="cr-readout"></div>
      </aside>
      <div class="cr-gallery" hidden>
        <div class="cr-gallery-head"><h2 data-i18n="hgen.gallery"></h2><button class="cr-icon" data-act="close-gallery" data-i18n-title="hgen.act.close">${icon('close')}</button></div>
        <div class="cr-cards"></div>
      </div>
      <div class="cr-toast" hidden></div>`;
    const q = (s: string): HTMLElement => root.querySelector(s)!;
    this.el = {
      name: q('.cr-name'), rail: q('.cr-rail'), title: q('.cr-page-head h2'), tabs: q('.cr-tabs'), body: q('.cr-body'),
      readout: q('.cr-readout'), gallery: q('.cr-gallery'), cards: q('.cr-cards'), toast: q('.cr-toast'), file: q('.cr-file'),
      undo: q('[data-act="undo"]'), redo: q('[data-act="redo"]'),
    };
    applyTranslations(root);

    this.person = host.random();
    root.addEventListener('click', (e) => this.onClick(e));
    q('.cr-page-dice').addEventListener('click', () => this.commit(host.randomPage(this.person, this.page)));
    (this.el['name'] as HTMLInputElement).addEventListener('change', (e) => this.commit({ ...this.person, name: (e.target as HTMLInputElement).value.trim() }));
    this.el['file']!.addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      const p = await importPerson(f);
      if (p) { this.savedId = null; this.commit(p); this.toast(t('hgen.toast.imported')); } else this.toast(t('hgen.toast.badFile'));
      (e.target as HTMLInputElement).value = '';
    });
    // A click on the person (not the end of a drag) opens the part clicked.
    let down: [number, number] | null = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.offsetX, e.offsetY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.offsetX - down[0], e.offsetY - down[1]) > 4) return;
      const f = host.pick(e.offsetX, e.offsetY);
      if (f) { const [c, pg] = FOCUS_PAGE[f]; this.open(c, pg); }
    });
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
    });
    this.host.show(this.person);
    this.open('person', 'basics');
  }

  /** The person being edited. */
  get current(): PersonParams { return this.person; }

  // ---- edits and history

  /** A finished edit: undoable. */
  commit(next: PersonParams): void {
    this.past.push(this.person);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    this.set(next);
  }

  /** A live edit while a slider moves: drawn once a frame, recorded on release. */
  private live(next: PersonParams): void {
    this.person = next;
    if (this.pending) { this.pending = next; return; }
    this.pending = next;
    requestAnimationFrame(() => {
      const p = this.pending!;
      this.pending = null;
      this.host.show(p);
      this.syncValues();
    });
  }

  private set(next: PersonParams): void {
    this.person = next;
    this.host.show(next);
    this.renderPage();
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.person);
    this.set(prev);
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.person);
    this.set(next);
  }

  // ---- buttons

  private onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const cat = btn.dataset['cat'];
    if (cat) { this.open(cat); return; }
    const tab = btn.dataset['page'];
    if (tab) { this.open(this.category.id, tab); return; }
    switch (btn.dataset['act']) {
      case 'new': this.savedId = null; this.past = []; this.future = []; this.set(this.host.random()); this.open('person', 'basics'); break;
      case 'random': this.commit({ ...this.host.random(), name: this.person.name }); break;
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'save': this.save(); break;
      case 'gallery': this.showGallery(); break;
      case 'close-gallery': this.el['gallery']!.hidden = true; break;
      case 'export': exportPerson(this.person); break;
      case 'import': (this.el['file'] as HTMLInputElement).click(); break;
    }
  }

  private save(): void {
    const id = savePerson(this.person, this.host.portrait(), this.savedId ?? undefined);
    if (id) { this.savedId = id; this.toast(t('hgen.toast.saved', { name: this.person.name || t('hgen.unnamed') })); } else this.toast(t('hgen.toast.full'));
  }

  private showGallery(): void {
    const list = loadSaved();
    const cards = this.el['cards']!;
    cards.innerHTML = list.length ? '' : `<p class="cr-empty">${t('hgen.galleryEmpty')}</p>`;
    for (const s of list) {
      const card = document.createElement('div');
      card.className = 'cr-card';
      card.innerHTML = `<button class="cr-card-open" title="${t('hgen.act.open')}"><img alt="" src="${s.portrait}" /><span></span></button>
        <button class="cr-icon cr-card-del" title="${t('hgen.act.delete')}" aria-label="${t('hgen.act.delete')}">${icon('trash')}</button>`;
      card.querySelector('span')!.textContent = s.params.name || t('hgen.unnamed');
      card.querySelector('.cr-card-open')!.addEventListener('click', () => {
        this.savedId = s.id; this.past = []; this.future = [];
        this.set(s.params);
        this.el['gallery']!.hidden = true;
      });
      card.querySelector('.cr-card-del')!.addEventListener('click', () => {
        if (!window.confirm(t('hgen.confirmDelete', { name: s.params.name || t('hgen.unnamed') }))) return;
        deleteSaved(s.id);
        if (this.savedId === s.id) this.savedId = null;
        this.showGallery();
      });
      cards.append(card);
    }
    this.el['gallery']!.hidden = false;
  }

  private toast(text: string): void {
    const el = this.el['toast']!;
    el.textContent = text;
    el.hidden = false;
    clearTimeout((el as unknown as { timer?: number }).timer);
    (el as unknown as { timer?: number }).timer = window.setTimeout(() => { el.hidden = true; }, 2200);
  }

  // ---- pages

  open(categoryId: string, pageId?: string): void {
    const c = CATALOG.find((x) => x.id === categoryId) ?? CATALOG[0]!;
    this.category = c;
    this.page = c.pages.find((p) => p.id === pageId) ?? c.pages[0]!;
    for (const b of this.el['rail']!.querySelectorAll<HTMLButtonElement>('.cr-cat')) b.classList.toggle('on', b.dataset['cat'] === c.id);
    this.el['tabs']!.innerHTML = c.pages.length > 1
      ? c.pages.map((p) => `<button class="cr-tab${p === this.page ? ' on' : ''}" data-page="${p.id}">${t(p.label)}</button>`).join('') : '';
    this.el['title']!.textContent = t(c.label);
    this.host.focus(this.page.focus);
    this.renderPage();
  }

  private renderPage(): void {
    const body = this.el['body']!;
    body.innerHTML = '';
    this.rows = [];
    (this.el['name'] as HTMLInputElement).value = this.person.name;
    (this.el['name'] as HTMLInputElement).placeholder = t('hgen.unnamed');
    switch (this.page.id) {
      case 'basics': this.basics(body); break;
      case 'build': this.components(body, 'body', 'hgen.shape', 8); break;
      case 'faceShape': this.components(body, 'head', 'hgen.faceVar', 8); break;
      case 'skin': this.skin(body); break;
      case 'expression': this.expression(body); break;
      default: for (const m of this.page.morphs) this.morphRow(body, m);
    }
    this.syncValues();
  }

  private syncValues(): void {
    for (const r of this.rows) r.sync(this.person);
    const m = this.host.measure(this.person);
    this.el['readout']!.textContent = t('hgen.readout', { cm: Math.round(m.heightCm), kg: Math.round(m.massKg), bmi: (m.massKg / (m.heightCm / 100) ** 2).toFixed(1) });
    this.el['undo']!.toggleAttribute('disabled', this.past.length === 0);
    this.el['redo']!.toggleAttribute('disabled', this.future.length === 0);
  }

  /**
   * One slider row: name, track, value and a reset. `twoWay` sliders show
   * their middle; moving one draws live, letting go records the edit.
   */
  private slider(host: HTMLElement, label: string, range: (p: PersonParams) => [number, number, number],
    get: (p: PersonParams) => number, set: (p: PersonParams, v: number) => PersonParams,
    show: (v: number) => string, reset: number | null, twoWay = false): void {
    const row = document.createElement('div');
    row.className = 'cr-row';
    row.innerHTML = `<span class="cr-label"></span><input type="range" class="${twoWay ? 'two-way' : ''}" /><output></output>
      <button class="cr-reset" title="${t('hgen.act.reset')}" aria-label="${t('hgen.act.reset')}">${icon('reset')}</button>`;
    row.querySelector('.cr-label')!.textContent = label;
    const input = row.querySelector('input')!, out = row.querySelector('output')!;
    const resetBtn = row.querySelector<HTMLButtonElement>('.cr-reset')!;
    if (reset === null) resetBtn.style.visibility = 'hidden';
    let before: PersonParams | null = null;
    input.addEventListener('pointerdown', () => { before = this.person; });
    input.addEventListener('input', () => { this.live(set(this.person, Number(input.value))); out.textContent = show(Number(input.value)); });
    input.addEventListener('change', () => {
      const after = this.person;
      if (before && before !== after) { this.past.push(before); this.future = []; }
      else if (!before) { this.past.push(this.person); this.future = []; }
      before = null;
      this.person = after;
      this.syncValues();
    });
    resetBtn.addEventListener('click', () => { if (reset !== null) this.commit(set(this.person, reset)); });
    host.append(row);
    this.rows.push({ input, out, sync: (p) => {
      const [lo, hi, step] = range(p);
      input.min = String(lo); input.max = String(hi); input.step = String(step);
      input.value = String(get(p));
      out.textContent = show(get(p));
    } });
  }

  private morphRow(host: HTMLElement, name: string): void {
    const m = this.host.base.morphs.get(name);
    if (!m) return;
    const twoWay = m.min < 0;
    this.slider(host, t(`hgen.m.${name}`), () => [m.min, m.max, 0.01], (p) => p.detail[name] ?? 0,
      (p, v) => ({ ...p, detail: { ...p.detail, [name]: v } }),
      (v) => (twoWay ? `${v > 0 ? '+' : ''}${Math.round(v * 100)}` : `${Math.round(v * 100)}`), 0, twoWay);
  }

  private components(host: HTMLElement, field: 'body' | 'head', label: string, count: number): void {
    const note = document.createElement('p');
    note.className = 'cr-note';
    note.textContent = t(`${label}.note`);
    host.append(note);
    for (let i = 0; i < count; i++) {
      this.slider(host, t(label, { n: i + 1 }), () => [-3, 3, 0.02], (p) => p[field][i] ?? 0,
        (p, v) => ({ ...p, [field]: p[field].map((c, j) => (j === i ? v : c)) }), (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, 0, true);
    }
  }

  /** Changing age or sex keeps the person's place in the population (their percentile). */
  private static keepPlace(p: PersonParams, next: Partial<PersonParams>): PersonParams {
    const before = typical(p.sex, p.years), q = { ...p, ...next }, after = typical(q.sex, q.years);
    return { ...q, heightCm: p.heightCm * after.heightCm / before.heightCm, bmi: p.bmi * after.bmi / before.bmi };
  }

  private chips<T>(host: HTMLElement, items: readonly (readonly [T, string])[], get: (p: PersonParams) => T, set: (p: PersonParams, v: T) => PersonParams): void {
    const row = document.createElement('div');
    row.className = 'cr-chips';
    for (const [value, label] of items) {
      const b = document.createElement('button');
      b.className = 'cr-chip';
      b.textContent = label;
      b.addEventListener('click', () => this.commit(set(this.person, value)));
      row.append(b);
      this.rows.push({ input: document.createElement('input'), out: document.createElement('output'), sync: (p) => b.classList.toggle('on', get(p) === value) });
    }
    host.append(row);
  }

  private heading(host: HTMLElement, key: string): void {
    const h = document.createElement('div');
    h.className = 'cr-group';
    h.textContent = t(key);
    host.append(h);
  }

  private basics(host: HTMLElement): void {
    this.heading(host, 'hgen.sex');
    this.chips(host, [[0, t('hgen.female')], [1, t('hgen.male')]], (p) => (p.sex < 0.5 ? 0 : 1), (p, v) => Creator.keepPlace(p, { sex: v }));
    this.slider(host, t('hgen.androgyny'), () => [0, 1, 0.01], (p) => p.sex, (p, v) => Creator.keepPlace(p, { sex: v }),
      (v) => `${Math.round(v * 100)}`, null);
    this.heading(host, 'hgen.age');
    const stages: [number, string][] = [[4, t('hgen.stage.child')], [14, t('hgen.stage.teen')], [24, t('hgen.stage.young')], [42, t('hgen.stage.adult')], [72, t('hgen.stage.elder')]];
    this.chips(host, stages, (p) => stages.reduce((best, s) => (Math.abs(s[0] - p.years) < Math.abs(best - p.years) ? s[0] : best), stages[0]![0]),
      (p, v) => Creator.keepPlace(p, { years: v }));
    this.slider(host, t('hgen.age'), () => [1, 90, 1], (p) => p.years, (p, v) => Creator.keepPlace(p, { years: v }), (v) => t('hgen.years', { n: Math.round(v) }), null);
    this.heading(host, 'hgen.group.build');
    this.slider(host, t('hgen.height'), (p) => { const m = typical(p.sex, p.years).heightCm; return [Math.round(m * 0.8), Math.round(m * 1.2), 1]; },
      (p) => p.heightCm, (p, v) => ({ ...p, heightCm: v }), (v) => `${Math.round(v)} cm`, null);
    this.slider(host, t('hgen.bmi'), () => [15, 42, 0.1], (p) => p.bmi, (p, v) => ({ ...p, bmi: v }), (v) => v.toFixed(1), null);
    this.slider(host, t('hgen.muscle'), () => [0, 1, 0.01], (p) => p.muscle, (p, v) => ({ ...p, muscle: v }), (v) => `${Math.round(v * 100)}`, 0);
  }

  private skin(host: HTMLElement): void {
    this.heading(host, 'hgen.skin');
    this.slider(host, t('hgen.skinTone'), () => [0, 1, 0.01], (p) => p.melanin, (p, v) => ({ ...p, melanin: v }), (v) => `${Math.round(v * 100)}`, null);
    this.heading(host, 'hgen.ancestry');
    this.chips(host, ANCESTRIES.map((a) => [a, t(`hgen.anc.${a}`)] as const), (p) => p.ancestry, (p, v) => ({ ...p, ancestry: v }));
    this.heading(host, 'hgen.eyeColour');
    const sw = document.createElement('div');
    sw.className = 'cr-swatches';
    for (const [c] of IRIS_COLOURS) {
      const b = document.createElement('button');
      b.className = 'cr-swatch';
      b.style.background = `#${c.toString(16).padStart(6, '0')}`;
      b.title = t('hgen.eyeColour');
      b.addEventListener('click', () => this.commit({ ...this.person, iris: c }));
      sw.append(b);
      this.rows.push({ input: document.createElement('input'), out: document.createElement('output'), sync: (p) => b.classList.toggle('on', p.iris === c) });
    }
    host.append(sw);
    this.heading(host, 'hgen.group.detail');
    this.morphRow(host, 'Generic_Assymetry');
  }

  private expression(host: HTMLElement): void {
    this.chips(host, EXPRESSIONS.map((e) => [e, t(`hgen.expr.${e || 'none'}`)] as const), (p) => p.expression,
      (p, v) => ({ ...p, expression: v, expressionAmount: v ? (p.expressionAmount || 0.8) : 0 }));
    this.slider(host, t('hgen.intensity'), () => [0, 1, 0.01], (p) => p.expressionAmount, (p, v) => ({ ...p, expressionAmount: v }),
      (v) => `${Math.round(v * 100)}`, null);
  }
}
