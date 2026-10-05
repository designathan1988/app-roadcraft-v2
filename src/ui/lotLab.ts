import { t } from '@ui/i18n';
import type { LotTemplate } from '@world/buildings/lotTemplate';
import { ZONE_DENSITIES, ZONE_USES, type ZoneDensity, type ZoneUse } from '@world/zones';
import { TOWER_KINDS, type TowerKind } from '@world/buildings/towerKit';

/**
 * The lot lab's panel (`?lab=lots`, `editor/lotLab.ts`): the zone and lot width
 * to grow, a seed, Generate; Save the selected lot to the library; and the
 * library, each kept lot put in place of the selected one or deleted.
 */
export interface LotLabActions {
  generate(zone: { use: ZoneUse; density: ZoneDensity }, widths: readonly [number, number], seed: number): number;
  /** Dezones the street and takes its lots down. */
  clear(): void;
  /** Puts towers of the kit behind the street; returns how many were placed. */
  towers(kinds: readonly TowerKind[], floors: number | undefined, seed: number): number;
  /** The selected building as a template, or null with nothing selected. */
  selectedTemplate(name: string, zone: { use: ZoneUse; density: ZoneDensity }): LotTemplate | null;
  /** Puts a kept lot in place of the selected building; false with nothing selected. */
  apply(template: LotTemplate): boolean;
  flash(text: string): void;
}

const CSS = `
.lot-lab { position: fixed; right: 12px; top: 64px; z-index: 40; width: 250px; max-height: calc(100vh - 160px);
  overflow: auto; padding: 10px; border-radius: 12px; background: rgba(22, 28, 34, .94); color: #e8eef2;
  box-shadow: 0 4px 18px rgba(0,0,0,.35); font: 500 12px/1.35 system-ui, sans-serif; }
.lot-lab h3 { margin: 0 0 8px; font-size: 12px; letter-spacing: .06em; }
.lot-lab label { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 6px; margin: 5px 0; }
.lot-lab select, .lot-lab input { width: 100%; box-sizing: border-box; background: #2a333c; color: inherit;
  border: 1px solid #3c4752; border-radius: 6px; padding: 3px 5px; font: inherit; }
.lot-lab .row { display: flex; gap: 6px; margin: 8px 0; }
.lot-lab button { flex: 1; border: 0; border-radius: 7px; padding: 6px 8px; background: #3b82c4; color: #fff;
  font: 600 12px system-ui, sans-serif; cursor: pointer; }
.lot-lab button.ghost { background: #34404b; }
.lot-lab button:hover { filter: brightness(1.12); }
.lot-lab ul { list-style: none; margin: 4px 0 0; padding: 0; }
.lot-lab li { display: flex; align-items: center; gap: 4px; padding: 4px 0; border-top: 1px solid #333d47; }
.lot-lab li span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lot-lab li small { opacity: .65; }
.lot-lab li button { flex: 0 0 auto; padding: 3px 6px; font-size: 11px; }
.lot-lab .empty { opacity: .6; margin: 4px 0; }
`;

export function mountLotLab(actions: LotLabActions): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const panel = document.createElement('div');
  panel.className = 'lot-lab';
  const option = (value: string, label: string): string => `<option value="${value}">${label}</option>`;
  panel.innerHTML = `
    <h3>${t('lab.title')}</h3>
    <label>${t('zone.use')}<select data-k="use">${ZONE_USES.map((u) => option(u, t(`zone.${u}`))).join('')}</select></label>
    <label>${t('zone.density')}<select data-k="density">${ZONE_DENSITIES.map((d) => option(d, t(`zone.${d}`))).join('')}</select></label>
    <label>${t('lab.widthMin')}<input data-k="wmin" type="number" min="1" max="8" value="1"></label>
    <label>${t('lab.widthMax')}<input data-k="wmax" type="number" min="1" max="8" value="3"></label>
    <label>${t('lab.seed')}<input data-k="seed" type="number" value="1"></label>
    <div class="row"><button data-a="generate">${t('lab.generate')}</button><button class="ghost" data-a="random">${t('lab.random')}</button></div>
    <div class="row"><button class="ghost" data-a="clear">${t('lab.clear')}</button></div>
    <div class="row"><button class="ghost" data-a="save">${t('lab.save')}</button></div>
    <h3>${t('lab.towers')}</h3>
    <label>${t('lab.towerKind')}<select data-k="tower">${TOWER_KINDS.map((k) => option(k, t(`lab.tower.${k}`))).join('')}</select></label>
    <label>${t('lab.floors')}<input data-k="floors" type="number" min="0" max="56" value="0"></label>
    <div class="row"><button data-a="tower">${t('lab.makeTower')}</button><button class="ghost" data-a="towersAll">${t('lab.makeAll')}</button></div>
    <h3>${t('lab.library')}</h3>
    <ul data-k="list"></ul>`;
  document.body.appendChild(panel);
  const field = <T extends HTMLElement>(k: string): T => panel.querySelector<T>(`[data-k="${k}"]`)!;
  const zone = (): { use: ZoneUse; density: ZoneDensity } => ({
    use: field<HTMLSelectElement>('use').value as ZoneUse,
    density: field<HTMLSelectElement>('density').value as ZoneDensity,
  });
  const generate = (): void => {
    const a = Math.max(1, Math.round(Number(field<HTMLInputElement>('wmin').value) || 1));
    const b = Math.max(a, Math.round(Number(field<HTMLInputElement>('wmax').value) || a));
    const n = actions.generate(zone(), [a, b], Math.round(Number(field<HTMLInputElement>('seed').value) || 0));
    actions.flash(t('lab.grown', { n }));
  };

  const list = field<HTMLUListElement>('list');
  const refresh = async (): Promise<void> => {
    let items: { name: string; use: ZoneUse; density: ZoneDensity }[] = [];
    try { items = await (await fetch('/__lots')).json() as typeof items; } catch { /* no library server */ }
    list.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = t('lab.empty');
      list.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = item.name;
      name.title = item.name;
      const kind = document.createElement('small');
      kind.textContent = `${t(`zone.${item.use}`)} · ${t(`zone.${item.density}`)}`;
      name.append(document.createElement('br'), kind);
      const use = document.createElement('button');
      use.textContent = t('lab.apply');
      use.onclick = async () => {
        const tpl = await (await fetch(`/__lots/${encodeURIComponent(item.name)}`)).json() as LotTemplate;
        actions.flash(actions.apply(tpl) ? t('lab.applied', { name: item.name }) : t('lab.pickFirst'));
      };
      const del = document.createElement('button');
      del.className = 'ghost';
      del.textContent = '✕';
      del.title = t('lab.delete');
      del.onclick = async () => {
        if (!window.confirm(t('lab.confirmDelete', { name: item.name }))) return;
        await fetch(`/__lots/${encodeURIComponent(item.name)}`, { method: 'DELETE' });
        void refresh();
      };
      li.append(name, use, del);
      list.appendChild(li);
    }
  };

  panel.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset['a'];
    if (action === 'generate') generate();
    else if (action === 'clear') { actions.clear(); actions.flash(t('lab.cleared')); }
    else if (action === 'tower' || action === 'towersAll') {
      const floors = Math.round(Number(field<HTMLInputElement>('floors').value) || 0) || undefined;
      const seed = Math.round(Number(field<HTMLInputElement>('seed').value) || 0);
      const kinds = action === 'tower' ? [field<HTMLSelectElement>('tower').value as TowerKind] : TOWER_KINDS;
      const n = actions.towers(kinds, floors, seed);
      actions.flash(n ? t('lab.towersMade', { n }) : t('lab.noRoom'));
    }
    else if (action === 'random') {
      field<HTMLInputElement>('seed').value = String(Math.floor(Math.random() * 100000));
      generate();
    } else if (action === 'save') {
      const probe = actions.selectedTemplate('', zone());
      if (!probe) { actions.flash(t('lab.pickFirst')); return; }
      const name = window.prompt(t('lab.saveName'), `${probe.use}-${probe.density}-${Date.now() % 100000}`)?.trim();
      if (!name) return;
      const tpl = actions.selectedTemplate(name, zone())!;
      void fetch(`/__lots/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(tpl) }).then((r) => {
        actions.flash(r.ok ? t('lab.saved', { name }) : t('lab.saveFailed'));
        void refresh();
      });
    }
  });
  // Keys typed in the panel are not the game's shortcuts.
  panel.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).matches('input, select')) e.stopPropagation();
  });
  void refresh();
}
