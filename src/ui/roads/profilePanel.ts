import type { RoadSegment } from '@world/doc';
import {
  CARRIAGEWAY_MATERIALS, type CarriagewayMaterial, FOOTWAY_MATERIALS, type FootwayMaterial, MEDIAN_MATERIALS,
  type MedianMaterial, ROAD_SECTION_LIMITS,
} from '@world/roadSection';
import { type ProfileElement, type RoadProfileSpec, profileOf, profileProblems } from '@world/roads/profile';
import { type RoadTemplate, classTemplates } from '@world/roads/templates';
import { METERS_PER_UNIT, UNITS_PER_METER } from '@world/units';
import { t } from '../i18n';
import { deleteTemplate, saveTemplate, savedTemplates } from './templates';

/**
 * THE ROAD'S PROFILE in the inspector (docs/VIAS.md V1): the cross-section
 * drawn as its bands, left edge to right edge looking from A to B; a
 * template applied in one step; each footway's width, whether it is laid
 * flush (no kerb), and what each element is paved with; the profile saved as
 * a template of the player's own. Every change is one edit of the road
 * (`apply`), judged and paid for like any other; what the road cannot carry is
 * named instead of applied. The full profile editor comes in V2.
 */
export function mountProfilePanel(
  host: HTMLElement,
  segment: RoadSegment,
  apply: (profile: RoadProfileSpec, type?: number) => void,
): void {
  const profile = profileOf(segment);
  const panel = document.createElement('fieldset');
  panel.className = 'road-profile-panel';
  panel.style.cssText = 'border:1px solid #ffffff24;border-radius:8px;padding:10px;margin:10px 0';
  const legend = document.createElement('legend');
  legend.textContent = t('profile.title');
  panel.append(legend);

  // ---- the bands, as they lie across the road
  const diagram = document.createElement('div');
  diagram.className = 'road-profile-diagram';
  diagram.style.cssText = 'display:flex;height:40px;gap:2px;margin:4px 0 4px;overflow:hidden;border-radius:4px';
  diagram.setAttribute('aria-label', t('profile.diagram'));
  for (const e of profile.elements) {
    const band = document.createElement('span');
    band.style.cssText = `flex:${e.width} 1 0;background:${bandColour(e, profile)};display:grid;place-items:center;color:white;min-width:0;font-size:11px;overflow:hidden`;
    band.textContent = bandLabel(e);
    band.title = `${t(`profile.element.${e.kind}`)} · ${metres(e.width)} m`;
    diagram.append(band);
  }
  panel.append(diagram);
  const ends = document.createElement('div');
  ends.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;opacity:.75;margin-bottom:8px';
  ends.innerHTML = `<span>${t('profile.leftEdge')}</span><span>${t('profile.rightEdge')}</span>`;
  panel.append(ends);

  // ---- templates
  const templates: RoadTemplate[] = [...classTemplates(), ...savedTemplates()];
  // In the inspector's own label rows and button rows, so they are drawn like their neighbours.
  const templateLabel = document.createElement('label');
  templateLabel.className = 'inspect-select';
  templateLabel.textContent = t('profile.template');
  const templateRow = document.createElement('div');
  templateRow.className = 'inspect-actions';
  const select = document.createElement('select');
  select.className = 'road-profile-template';
  for (const template of templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.nameKey ? t(template.nameKey) : template.name ?? template.id;
    select.append(option);
  }
  const applyTemplate = document.createElement('button');
  applyTemplate.type = 'button';
  applyTemplate.textContent = t('profile.applyTemplate');
  applyTemplate.onclick = () => {
    const chosen = templates.find((x) => x.id === select.value);
    if (chosen) apply(chosen.profile, chosen.type);
  };
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = t('profile.deleteTemplate');
  const syncRemove = (): void => { remove.disabled = !select.value.startsWith('user:'); };
  select.onchange = syncRemove;
  syncRemove();
  remove.onclick = () => {
    if (!select.value.startsWith('user:')) return;
    deleteTemplate(select.value);
    select.querySelector(`option[value="${CSS.escape(select.value)}"]`)?.remove();
    syncRemove();
  };
  templateLabel.append(select);
  templateRow.append(applyTemplate, remove);
  panel.append(templateLabel, templateRow);

  // ---- each footway: width and flush, then the materials
  const last = profile.elements.length - 1;
  const footway = (index: number): Extract<ProfileElement, { kind: 'footway' }> =>
    profile.elements[index] as Extract<ProfileElement, { kind: 'footway' }>;
  const withElement = (index: number, next: ProfileElement): RoadProfileSpec =>
    ({ ...profile, elements: profile.elements.map((e, i) => (i === index ? next : e)) });
  const problems = document.createElement('p');
  problems.className = 'road-profile-problems';
  problems.style.cssText = 'color:#ffb4a8;font-size:12px;margin:6px 0';
  const tryApply = (next: RoadProfileSpec): void => {
    const found = profileProblems(next, segment.type);
    problems.textContent = found.map((p) => t(`profile.problem.${p}`)).join(' · ');
    if (!found.length) apply(next);
  };
  const [minWalk, maxWalk] = ROAD_SECTION_LIMITS.sidewalk;
  for (const [index, side] of [[0, 'Left'], [last, 'Right']] as const) {
    const element = footway(index);
    const label = document.createElement('label');
    label.className = 'inspect-select';
    label.textContent = t(`profile.footway${side}`);
    const width = document.createElement('select');
    width.dataset['profileFootway'] = side.toLowerCase();
    for (let metresWide = Math.round(minWalk * METERS_PER_UNIT); metresWide <= Math.round(maxWalk * METERS_PER_UNIT); metresWide++) {
      const option = document.createElement('option');
      option.value = String(metresWide);
      option.textContent = `${metresWide} m`;
      width.append(option);
    }
    width.value = String(Math.round(element.width * METERS_PER_UNIT));
    width.onchange = () => tryApply(withElement(index, { ...element, width: Number(width.value) * UNITS_PER_METER }));
    label.append(width);
    panel.append(label);
    const flush = document.createElement('label');
    flush.className = 'inspect-select';
    flush.textContent = t(`profile.flush${side}`);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = element.flush === true;
    box.dataset['profileFlush'] = side.toLowerCase();
    box.onchange = () => {
      const { flush: _drop, ...rest } = element;
      void _drop;
      tryApply(withElement(index, box.checked ? { ...rest, flush: true } : rest));
    };
    flush.append(box);
    panel.append(flush);
    panel.append(materialSelect(`profile.material.footway${side}`, FOOTWAY_MATERIALS, element.material ?? 'pavers',
      (material) => tryApply(withElement(index, { ...element, material: material as FootwayMaterial }))));
  }
  panel.append(materialSelect('profile.material.carriageway', CARRIAGEWAY_MATERIALS, profile.carriageway ?? 'asphalt',
    (material) => tryApply({ ...profile, carriageway: material as CarriagewayMaterial })));
  const medianIndex = profile.elements.findIndex((e) => e.kind === 'median');
  if (medianIndex >= 0) {
    const median = profile.elements[medianIndex] as Extract<ProfileElement, { kind: 'median' }>;
    panel.append(materialSelect('profile.material.median', MEDIAN_MATERIALS, median.material ?? 'grass',
      (material) => tryApply(withElement(medianIndex, { ...median, material: material as MedianMaterial }))));
    const flush = document.createElement('label');
    flush.className = 'inspect-select';
    flush.textContent = t('profile.medianFlush');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = median.flush === true;
    box.onchange = () => {
      const { flush: _drop, ...rest } = median;
      void _drop;
      tryApply(withElement(medianIndex, box.checked ? { ...rest, flush: true } : rest));
    };
    flush.append(box);
    panel.append(flush);
  }
  panel.append(problems);

  // ---- saved as a template of the player's own
  const nameLabel = document.createElement('label');
  nameLabel.className = 'inspect-select';
  nameLabel.textContent = t('profile.templateName');
  const saveRow = document.createElement('div');
  saveRow.className = 'inspect-actions';
  const name = document.createElement('input');
  name.type = 'text';
  name.maxLength = 40;
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = t('profile.saveTemplate');
  const saved = document.createElement('span');
  saved.style.cssText = 'font-size:12px;opacity:.8';
  save.onclick = () => {
    const template = name.value.trim() ? saveTemplate(name.value, segment.type, profile) : null;
    saved.textContent = template ? t('profile.saved', { name: template.name ?? '' }) : t('profile.notSaved');
    if (template) {
      const option = document.createElement('option');
      option.value = template.id;
      option.textContent = template.name ?? template.id;
      select.append(option);
      templates.push(template);
    }
  };
  nameLabel.append(name);
  saveRow.append(save, saved);
  panel.append(nameLabel, saveRow);
  host.append(panel);
}

function materialSelect(key: string, materials: readonly string[], value: string, change: (material: string) => void): HTMLElement {
  const label = document.createElement('label');
  label.className = 'inspect-select';
  label.textContent = t(key);
  const select = document.createElement('select');
  select.dataset['profileMaterial'] = key;
  for (const material of materials) {
    const option = document.createElement('option');
    option.value = material;
    option.textContent = t(`profile.materialName.${material}`);
    select.append(option);
  }
  select.value = value;
  select.onchange = () => change(select.value);
  label.append(select);
  return label;
}

const metres = (units: number): string => (units * METERS_PER_UNIT).toFixed(units * METERS_PER_UNIT % 1 ? 1 : 0);

function bandLabel(e: ProfileElement): string {
  if (e.kind === 'lane') return e.dir === 'forward' ? '→' : '←';
  if (e.kind === 'footway') return t('profile.short.footway');
  if (e.kind === 'cycle') return t('profile.short.cycle');
  if (e.kind === 'parking') return 'P';
  return '';
}

function bandColour(e: ProfileElement, profile: RoadProfileSpec): string {
  switch (e.kind) {
    case 'footway': return e.material === 'stone' ? '#9c8466' : e.material === 'concrete' ? '#8c8c88' : '#77766e';
    case 'median': return e.flush ? '#3b434c' : e.material && e.material !== 'grass' ? '#7c7a73' : '#496447';
    case 'cycle': return '#8e3b34';
    case 'parking': return '#454c55';
    case 'lane': return profile.carriageway === 'concrete' ? '#6c6b67' : profile.carriageway === 'cobble' ? '#5a5047' : '#363f49';
  }
}
