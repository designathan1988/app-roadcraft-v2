/**
 * Roadcraft's interface, redesigned (2026-10-04).
 *
 * A new layout, not the old panels restyled:
 * - a HUD across the top: the city (clock, sky, residents, traffic) on the
 *   left, the speed in the centre, menu / camera / history / help on the right;
 * - a dock of categories at the bottom centre, icon and name, as Cities:
 *   Skylines II lays its toolbar;
 * - above it, the tool's drawer: its modes as tabs, its options in a column,
 *   its catalogue as a strip of big cards (one picture per thing, a row with a
 *   name per verb);
 * - the selection on the right.
 *
 * The game's commands are unchanged: this module drives them - the Builder
 * through its actions, the map tools through the game's own (now invisible)
 * controls - so nothing the player does here can disagree with the rules.
 */
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { CITY_BUILDINGS } from '@world/buildings/cityBuildings';
import { FINISHES, STYLES } from '@world/buildings/materials';
import { FACADE_PATTERNS } from '@world/buildings/types';
import {
  BUILDER_TAB_SPECS,
  DRAW_ACTIONS,
  DRAW_SHAPES,
  FACADE_SCOPES,
  TIER_SHAPES,
  type BuilderCategoryId,
  type BuilderSection,
  type BuilderToolSpec,
} from '../builder/catalog';
import { roadSnap, setRoadSnap } from '@editor/snap';
import { ROAD_PARKING_PRESETS, roadParkingPreset, setRoadParkingPreset } from '@editor/roadParking';
import { builderIconSvg } from '../builder/icons';
import { SNAP_MODES, type BuilderState, type BuilderWorkspace } from '../builder/workspace';
import { t, onLanguageChange } from '../i18n';
import { materialSwatch } from '../materialSwatch';
import { planSwatch } from '../planSwatch';
import './shell.css';

type Category = 'roads' | 'zones' | 'build' | 'landscape' | 'people' | 'demolish' | 'info';

const SWATCHES: readonly number[] = [
  0xf2efe8, 0xe6d8bd, 0xd8c297, 0xc98f5a, 0xa4563f, 0x72412f, 0x9c6b43,
  0xbdbcb4, 0x8f9ba5, 0x55585c, 0x2f3134, 0x7d8c6a, 0x5d7a8f, 0x9fb8c4,
];
const hexOf = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

const ICON: Record<string, string> = {
  roads: '<path d="M7 21 10 3h4l3 18"/><path d="M12 6v2m0 3v2m0 3v2"/>',
  zones: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
  build: '<path d="M4 21V9l6-4v16"/><path d="M10 21V3h10v18"/><path d="M2 21h20"/><path d="M13 7h1m3 0h1m-5 4h1m3 0h1m-5 4h1m3 0h1"/>',
  landscape: '<path d="m2 19 7-11 4 6 3-4 6 9Z"/><circle cx="17" cy="5" r="2"/>',
  people: '<circle cx="12" cy="6" r="3"/><path d="M6 21v-5a6 6 0 0 1 12 0v5"/>',
  demolish: '<path d="m5 9 8-5 5 8-8 5Z"/><path d="m7 15 5 5m4-8 3 5"/>',
  info: '<circle cx="11" cy="11" r="6"/><path d="m16 16 5 5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  camera: '<path d="M3 8h4l2-3h6l2 3h4v11H3Z"/><circle cx="12" cy="13" r="3.5"/>',
  sim: '<path d="M4 18 9 9l4 5 3-4 4 8"/><path d="M4 18h16"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5"/><path d="M12 17.5v.5"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/>',
  redo: '<path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  raise: '<path d="M3 20h18"/><path d="m5 20 7-12 7 12"/><path d="M12 3v3"/>',
  lower: '<path d="M3 6h18"/><path d="m5 6 7 12 7-12"/>',
  flatten: '<path d="M3 15h18"/><path d="M6 11h12"/>',
  river: '<path d="M3 8c3-3 6 3 9 0s6 3 9 0"/><path d="M3 15c3-3 6 3 9 0s6 3 9 0"/>',
  brush: '<path d="M14 4 20 10 10 20H4v-6Z"/>',
  fill: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/>',
  eraser: '<path d="m8 20-5-5L14 4l7 7-9 9Z"/><path d="M8 20h12"/>',
  frame: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  grid: '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/>',
  hide: '<path d="M3 3l18 18"/><path d="M10.6 6.2A9 9 0 0 1 21 12a14 14 0 0 1-2.4 3.2M6.3 6.6A14 14 0 0 0 3 12s3 6 9 6a8.8 8.8 0 0 0 4.3-1.1"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  car: '<path d="M4 16V12l2-5h12l2 5v4Z"/><path d="M4 12h16"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>',
  crowd: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2"/><circle cx="17" cy="8" r="2.5"/><path d="M16 13a5 5 0 0 1 6 4.5V21"/>',
  demand: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  heat: '<path d="M3 17c4-1 5-6 9-6s5 5 9 6"/><path d="M3 12c4-1 5-6 9-6s5 5 9 6" stroke-dasharray="2 2"/><circle cx="12" cy="11" r="1.5" fill="currentColor"/>',
  // Road modes
  draw: '<path d="M4 20 15 9l3 3L7 23H4Z" transform="translate(0 -3)"/><path d="m15 6 3-3 3 3-3 3"/>',
  upgrade: '<path d="M12 20V6"/><path d="m6 11 6-6 6 6"/><path d="M5 21h14"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  split: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5 20 17M8 15.5 20 7"/>',
  control: '<rect x="8" y="2" width="8" height="17" rx="2"/><circle cx="12" cy="6" r="1.4"/><circle cx="12" cy="10.5" r="1.4"/><circle cx="12" cy="15" r="1.4"/><path d="M12 19v3"/>',
  roundabout: '<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="8.5"/><path d="M12 1v2.5M12 20.5V23M1 12h2.5M20.5 12H23"/>',
  // Alignment
  straight: '<path d="M4 20 20 4"/><circle cx="4" cy="20" r="1.6"/><circle cx="20" cy="4" r="1.6"/>',
  curve: '<path d="M4 20C6 8 14 6 20 4"/><circle cx="4" cy="20" r="1.6"/><circle cx="20" cy="4" r="1.6"/>',
  free: '<path d="M3 19c3-1 3-6 6-6s2 5 5 5 3-9 7-12"/>',
  // Snapping
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/><path d="M10 3v8a2 2 0 0 0 4 0V3"/>',
  angle: '<path d="M4 20h16"/><path d="M4 20 16 6"/><path d="M10 20a6 6 0 0 0-1.8-4.3"/>',
  cells: '<path d="M3 15h18v5H3z"/><path d="M8 15v5M13 15v5M18 15v5"/><path d="M3 5h18M3 9h18" stroke-dasharray="2 2"/>',
  // Parking: the carriageway from above, bays along its kerbs
  'park-none': '<path d="M5 3v18M19 3v18"/><path d="M12 4v3m0 3v4m0 3v3"/>',
  'park-parallel': '<path d="M3 3v18M21 3v18"/><path d="M7 3v18M17 3v18"/><path d="M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  'park-parallelRight': '<path d="M4 3v18M21 3v18"/><path d="M17 3v18"/><path d="M17 9h4M17 15h4"/><path d="M10.5 4v3m0 3v4m0 3v3"/>',
  'park-parallelLeft': '<path d="M3 3v18M20 3v18"/><path d="M7 3v18"/><path d="M3 9h4M3 15h4"/><path d="M13.5 4v3m0 3v4m0 3v3"/>',
  // Lanes: the carriageway seen from above
  lanes2: '<path d="M7 3v18M17 3v18"/><path d="M12 4v3m0 3v4m0 3v3" />',
  lanes4: '<path d="M4 3v18M20 3v18"/><path d="M12 3v18"/><path d="M8 5v2m0 4v2m0 4v2M16 5v2m0 4v2m0 4v2"/>',
  lanes6: '<path d="M3 3v18M21 3v18M12 3v18"/><path d="M6 5v2m0 4v2m0 4v2M9 5v2m0 4v2m0 4v2M15 5v2m0 4v2m0 4v2M18 5v2m0 4v2m0 4v2"/>',
  median: '<path d="M3 3v18M21 3v18"/><path d="M10.5 3v18M13.5 3v18"/><path d="M7 5v2m0 4v2m0 4v2M17 5v2m0 4v2m0 4v2"/>',
  // Density: how tall
  low: '<path d="M4 20h16"/><rect x="5" y="14" width="14" height="6" rx="1"/>',
  medium: '<path d="M4 20h16"/><rect x="6" y="9" width="12" height="11" rx="1"/><path d="M9 13h2m2 0h2M9 16h2m2 0h2"/>',
  high: '<path d="M4 20h16"/><rect x="8" y="3" width="8" height="17" rx="1"/><path d="M10.5 7h3M10.5 10h3M10.5 13h3M10.5 16h3"/>',
  // Landscape tabs
  terrain: '<path d="m2 19 7-11 4 6 3-4 6 9Z"/>',
  walls: '<path d="M3 20V9h18v11"/><path d="M3 13h18M3 17h18M8 9v4M14 9v4M11 13v4M17 13v4M6 17v3M14 17v3"/>',
  radius: '<circle cx="12" cy="12" r="8"/><path d="M12 12h8"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  strength: '<path d="M4 20h16"/><path d="M6 20v-4M10 20v-7M14 20v-10M18 20v-14"/>',
  // Where a facade change applies: a facade of 3 x 3 bays, the part lit.
  scope_bay: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"9.3\" y=\"9.3\" width=\"5.4\" height=\"5.4\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  scope_zone: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"9.3\" y=\"4\" width=\"10.7\" height=\"10.7\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/><rect x=\"9.3\" y=\"4\" width=\"10.7\" height=\"10.7\" stroke-dasharray=\"2 1.5\"/>',
  scope_row: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"4.8\" y=\"10.1\" width=\"3.7\" height=\"3.8\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/><rect x=\"10.1\" y=\"10.1\" width=\"3.8\" height=\"3.8\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/><rect x=\"15.5\" y=\"10.1\" width=\"3.7\" height=\"3.8\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  scope_column: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"9.3\" y=\"4\" width=\"5.4\" height=\"16\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  scope_storey: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"2\" y=\"9.3\" width=\"20\" height=\"5.4\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  scope_side: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16\"/><rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  scope_volume: '<path d=\"M12 3 20 7.5v9L12 21l-8-4.5v-9Z\"/><path d=\"M4 7.5 12 12l8-4.5M12 12v9\"/><path d=\"M12 3 20 7.5 12 12 4 7.5Z\" fill=\"currentColor\" fill-opacity=\".55\" stroke=\"none\"/>',
  // Roofs: which way the ridge runs, which side the slope falls to
  ridge_x: '<path d=\"M3 12h18\"/><path d=\"m7 8-4 4 4 4M17 8l4 4-4 4\"/>',
  ridge_y: '<path d=\"M12 3v18\"/><path d=\"m8 7 4-4 4 4M8 17l4 4 4-4\"/>',
  fall_front: '<path d=\"M12 4v15\"/><path d=\"m6 13 6 6 6-6\"/>',
  fall_right: '<path d=\"M4 12h15\"/><path d=\"m13 6 6 6-6 6\"/>',
  fall_back: '<path d=\"M12 20V5\"/><path d=\"m6 11 6-6 6 6\"/>',
  fall_left: '<path d=\"M20 12H5\"/><path d=\"m11 6-6 6 6 6\"/>',
  advanced: '<path d=\"M4 7h10M18 7h2M4 17h4M12 17h8\"/><circle cx=\"16\" cy=\"7\" r=\"2\"/><circle cx=\"10\" cy=\"17\" r=\"2\"/>',
  poles: '<path d="M12 22V3"/><path d="M6 6h12"/><path d="M7 6v2M17 6v2"/><path d="M6 6c3 3 9 3 12 0" stroke-dasharray="2 2"/>',
};
const svg = (name: string, size = 22): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const q = <T extends HTMLElement = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const press = (selector: string): void => q<HTMLButtonElement>(selector)?.click();
const button = (className: string, label: string, run: () => void, icon?: string): HTMLButtonElement => {
  const b = el('button', className);
  b.type = 'button';
  b.innerHTML = icon ? `${icon}<span></span>` : '<span></span>';
  (b.querySelector('span') as HTMLElement).textContent = label;
  b.title = label;
  b.onclick = run;
  return b;
};
/** Sets one of the game's own inputs as the player would. */
const setInput = (selector: string, value: string): void => {
  const input = q<HTMLInputElement | HTMLSelectElement>(selector);
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

export interface ShellDeps {
  readonly workspace: BuilderWorkspace;
  /** The Person Creator's own panel and its 3D stage. */
  readonly creator: HTMLElement;
}

export function mountShell(deps: ShellDeps): void {
  const { workspace } = deps;
  const actions = workspace.actions;
  document.documentElement.classList.add('v2-shell');
  const root = el('div', 'v2');
  document.getElementById('app')?.appendChild(root);

  // ================================================================ HUD
  const hud = el('header', 'v2-hud');
  const city = el('div', 'v2-city');
  const sky = el('button', 'v2-sky');
  sky.type = 'button';
  sky.onclick = () => press('#skyMode');
  const clock = el('strong', 'v2-clock');
  const stats = el('div', 'v2-stats');
  city.append(sky, clock, stats);

  const speed = el('div', 'v2-speed');
  speed.setAttribute('role', 'group');
  const speedButtons: HTMLButtonElement[] = [];
  for (const s of ['0', '1', '2', '4']) {
    const b = el('button', 'v2-speed-b');
    b.type = 'button';
    b.dataset['speed'] = s;
    b.innerHTML = s === '0' ? svg('pause', 16) : `${s}×`;
    b.onclick = () => press(`.simulation-controls [data-speed="${s}"]`);
    speedButtons.push(b);
    speed.appendChild(b);
  }

  const actionsBar = el('div', 'v2-actions');
  const undo = button('v2-icon', t('action.undo'), () => press('#undoAction'), svg('undo', 18));
  const redo = button('v2-icon', t('action.redo'), () => press('#redoAction'), svg('redo', 18));
  const menuB = button('v2-pill', t('builder.menu.app'), () => toggle('menu', menuB), svg('menu', 18));
  const simB = button('v2-pill', t('builder.menu.simulation'), () => toggle('sim', simB), svg('sim', 18));
  const camB = button('v2-pill', t('camera.label'), () => toggle('camera', camB), svg('camera', 18));
  const helpB = button('v2-icon', t('builder.help'), () => toggle('help', helpB), svg('help', 18));
  actionsBar.append(simB, camB, undo, redo, helpB, menuB);
  hud.append(city, speed, actionsBar);

  // ================================================================ popovers
  const pop = el('div', 'v2-pop');
  pop.hidden = true;
  let popId: string | null = null;
  let popAnchor: HTMLElement | null = null;
  const closePop = (): void => {
    pop.hidden = true;
    popId = null;
    popAnchor = null;
  };
  document.addEventListener('pointerdown', (e) => {
    if (!popId) return;
    const target = e.target as Node;
    if (!pop.contains(target) && !popAnchor?.contains(target)) closePop();
  }, true);
  const toggle = (id: string, anchor: HTMLElement): void => {
    if (popId === id) return closePop();
    popId = id;
    popAnchor = anchor;
    pop.innerHTML = '';
    pop.appendChild(popBody(id));
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 8)}px`;
    pop.style.right = `${Math.max(12, Math.round(window.innerWidth - r.right))}px`;
  };
  const row = (label: string, run: () => void, icon = ''): HTMLButtonElement => {
    const b = button('v2-row', label, () => { run(); closePop(); }, icon);
    return b;
  };
  const slider = (label: string, selector: string, outSelector: string, icon?: string): HTMLElement => {
    const source = q<HTMLInputElement>(selector);
    const wrap = el('label', 'v2-slider' + (icon ? ' iconic' : ''));
    wrap.title = label;
    const name = el('span', 'v2-slider-name', label);
    if (icon) name.innerHTML = icon;
    const out = el('output', 'v2-slider-out', q(outSelector)?.textContent ?? '');
    const input = el('input');
    input.type = 'range';
    if (source) {
      input.min = source.min;
      input.max = source.max;
      input.step = source.step;
      input.value = source.value;
    }
    input.oninput = () => {
      setInput(selector, input.value);
      out.textContent = q(outSelector)?.textContent ?? input.value;
    };
    wrap.append(name, input, out);
    return wrap;
  };
  const selectProxy = (label: string, selector: string, icon?: string): HTMLElement => {
    const source = q<HTMLSelectElement>(selector);
    const wrap = el('label', 'v2-select' + (icon ? ' iconic' : ''));
    const name = el('span', '', label);
    if (icon) {
      name.innerHTML = icon;
      wrap.title = label;
    }
    const select = el('select');
    for (const o of source?.options ?? []) {
      const option = el('option', '', o.textContent ?? o.value);
      option.value = o.value;
      option.selected = o.value === source?.value;
      select.appendChild(option);
    }
    select.onchange = () => setInput(selector, select.value);
    wrap.append(name, select);
    return wrap;
  };
  function popBody(id: string): HTMLElement {
    const body = el('div', 'v2-pop-body');
    if (id === 'menu') {
      body.append(
        row(t('action.newMap'), () => press('#newMap')),
        row(t('action.openMap'), () => press('#openMap')),
        row(t('action.saveMap'), () => press('#saveMap')),
        el('hr'),
        selectProxy(t('menu.quality'), '#qualitySelect'),
        selectProxy(t('menu.language'), '#languageSelect'),
        el('hr'),
        row(t('action.about'), () => press('#aboutButton')),
      );
    } else if (id === 'sim') {
      body.append(
        slider(t('sim.traffic'), '#trafficIntensity', '#trafficIntensityValue', svg('car', 18)),
        slider(t('sim.people'), '#pedIntensity', '#pedIntensityValue', svg('crowd', 18)),
      );
      // Demand and the congestion map side by side, as icons.
      const line = el('div', 'v2-pop-line');
      const congestion = q<HTMLButtonElement>('#congestionToggle');
      const c = button('v2-icon' + (congestion?.getAttribute('aria-pressed') === 'true' ? ' on' : ''), t('sim.congestionLabel'), () => {
        congestion?.click();
        c.classList.toggle('on', congestion?.getAttribute('aria-pressed') === 'true');
      }, svg('heat', 18));
      line.append(selectProxy(t('sim.demand'), '#demandLevel', svg('demand', 18)), c);
      body.appendChild(line);
      const metrics = q('.sim-metrics');
      if (metrics) {
        const copy = el('dl', 'v2-metrics');
        copy.innerHTML = metrics.innerHTML;
        body.appendChild(copy);
      }
    } else if (id === 'camera') {
      for (const b of document.querySelectorAll<HTMLButtonElement>('#cameraControls [data-camera], #resetView')) {
        const label = (b.getAttribute('aria-label') ?? b.title).replace(/\s*\(.*$/, '');
        const icon = b.querySelector('svg')?.outerHTML ?? '';
        // A row of icons, as a camera bar: the name in the tooltip.
        body.classList.add('icons');
        body.appendChild(button('v2-icon', label, () => b.click(), icon));
      }
    } else if (id === 'help') {
      for (const [title, text] of [
        ['builder.help.select', 'builder.help.select.text'],
        ['builder.help.gizmo', 'builder.help.gizmo.text'],
        ['builder.help.numeric', 'builder.help.numeric.text'],
        ['builder.help.keys', 'builder.help.keys.text'],
        ['builder.help.cancel', 'builder.help.cancel.text'],
      ] as const) {
        const block = el('div', 'v2-help');
        block.append(el('strong', '', t(title)), el('p', '', t(text)));
        body.appendChild(block);
      }
    }
    return body;
  }

  // ================================================================ dock
  const dock = el('nav', 'v2-dock');
  const CATS: readonly { id: Category; tool: string; key: string; label: () => string }[] = [
    { id: 'roads', tool: 'road', key: '1', label: () => t('tool.road') },
    { id: 'zones', tool: 'zone', key: 'Z', label: () => t('tool.zone') },
    { id: 'build', tool: 'building', key: 'H', label: () => t('tool.building') },
    { id: 'landscape', tool: 'terrain', key: 'T', label: () => t('v2.cat.landscape') },
    { id: 'people', tool: 'person', key: 'K', label: () => t('tool.person') },
    { id: 'demolish', tool: 'bulldoze', key: 'B', label: () => t('tool.bulldoze') },
    { id: 'info', tool: 'inspect', key: 'I', label: () => t('v2.cat.info') },
  ];
  const catButtons = new Map<Category, HTMLButtonElement>();
  for (const c of CATS) {
    const b = el('button', 'v2-cat' + (c.id === 'demolish' ? ' danger' : ''));
    b.type = 'button';
    b.dataset['cat'] = c.id;
    b.innerHTML = `${svg(c.id, 26)}<span class="v2-cat-name"></span><kbd>${c.key}</kbd>`;
    b.onclick = () => {
      if (categoryOf(tool()) === c.id && open) {
        // A second click puts the tool down: the free hand.
        press('.bw-fold');
        open = false;
        render();
        return;
      }
      open = true;
      press(`.tool[data-tool="${c.tool}"]`);
      render();
    };
    catButtons.set(c.id, b);
    dock.appendChild(b);
  }

  // ================================================================ drawer
  const drawer = el('section', 'v2-drawer');
  const head = el('div', 'v2-drawer-head');
  const title = el('h2', 'v2-title');
  const tabs = el('div', 'v2-tabs');
  tabs.setAttribute('role', 'tablist');
  const tools = el('div', 'v2-head-tools');
  const close = button('v2-icon', t('v2.close'), () => {
    press('.bw-fold');
    open = false;
    render();
  }, svg('close', 18));
  head.append(title, tabs);
  const hint = el('p', 'v2-hint');
  const body = el('div', 'v2-drawer-body');
  const options = el('div', 'v2-options');
  const strip = el('div', 'v2-strip');
  body.append(strip);
  // The tool's options stand on their own at the bottom left, as Cities:
  // Skylines II lays its tool options: modes, elevation, snapping, as icons.
  const toolOptions = el('section', 'v2-toolopts');
  toolOptions.append(options, tools);
  // One row: the modes, the options, the things, the pointer's switches, close.
  drawer.append(head, hint, body, close);
  // A wheel over the strip scrolls it sideways.
  strip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // The Person Creator: a studio of its own on the left.
  const studio = el('section', 'v2-studio');
  studio.appendChild(deps.creator);

  // The selection on the right: the road inspector lives here.
  const side = el('aside', 'v2-side');
  const roadInspector = q('#inspector');
  if (roadInspector) side.appendChild(roadInspector);

  root.append(hud, pop, drawer, toolOptions, studio, side, dock);

  // The interface's own tooltip: every control is an icon and its name shows
  // here on hover - the browser's tooltip is slow and out of style. A control's
  // `title` is moved to `data-tip` the first time it is pointed at.
  const tip = el('div', 'v2-tip');
  tip.hidden = true;
  root.appendChild(tip);
  let tipFor: HTMLElement | null = null;
  root.addEventListener('pointerover', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[title], [data-tip]');
    if (!target || !root.contains(target)) return;
    if (target.title) {
      target.dataset['tip'] = target.title;
      target.removeAttribute('title');
    }
    const text = target.dataset['tip'] ?? '';
    if (!text) return;
    tipFor = target;
    tip.textContent = text;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    // Above the control; below it when that would leave the screen.
    const above = r.top - h - 8 >= 4;
    tip.style.left = `${Math.round(Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2)))}px`;
    tip.style.top = `${Math.round(above ? r.top - h - 8 : r.bottom + 8)}px`;
  });
  root.addEventListener('pointerout', (e) => {
    if (!tipFor) return;
    const to = e.relatedTarget as Node | null;
    if (to && tipFor.contains(to)) return;
    tipFor = null;
    tip.hidden = true;
  });
  root.addEventListener('pointerdown', () => { tip.hidden = true; });
  // A control rebuilt or removed under the pointer takes its tooltip with it.
  const tipCheck = (): void => {
    if (tipFor && (!tipFor.isConnected || tipFor.getBoundingClientRect().width === 0)) {
      tipFor = null;
      tip.hidden = true;
    }
  };
  setInterval(tipCheck, 200);

  // ================================================================ state
  let open = false;
  let landTab: 'terrain' | 'barrier' | 'pole' = 'terrain';
  let builder: BuilderState | null = null;

  let modelQuery = '';
  let modelCat = 'all';
  let advanced = false;
  try { advanced = window.localStorage.getItem('roadcraft.builder.advanced') === '1'; } catch { /* off */ }
  const requested = new Set<string>();

  const tool = (): string => (q('#game') as HTMLElement | null)?.dataset['tool'] ?? 'inspect';
  const categoryOf = (current: string): Category | null => {
    if (['road', 'upgrade', 'move', 'split', 'control', 'roundabout'].includes(current)) return 'roads';
    if (current === 'zone') return 'zones';
    if (current === 'building') return 'build';
    if (['terrain', 'barrier', 'pole'].includes(current)) return 'landscape';
    if (current === 'person') return 'people';
    if (current === 'bulldoze') return 'demolish';
    if (current === 'inspect') return 'info';
    return null;
  };

  // ------------------------------------------------------------ helpers
  /** A mode of the tool: its icon, its name in the tooltip. */
  const tab = (label: string, on: boolean, run: () => void, disabled = false, icon?: string): HTMLButtonElement => {
    const b = button('v2-tab' + (on ? ' on' : '') + (icon ? ' icon' : ''), label, run, icon);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(on));
    b.disabled = disabled;
    return b;
  };
  /** A cluster of controls in the row; its name is the tooltip, not a heading. */
  const group = (label: string): HTMLElement => {
    const g = el('div', 'v2-group');
    g.title = label;
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    return g;
  };
  const choices = (items: readonly { label: string; on: boolean; run: () => void; disabled?: boolean; icon?: string }[], cols = 3): HTMLElement => {
    const wrap = el('div', 'v2-choices');
    wrap.style.setProperty('--cols', String(cols));
    for (const item of items) {
      const b = button('v2-choice' + (item.on ? ' on' : '') + (item.icon ? ' icon' : ''), item.label, item.run, item.icon);
      b.disabled = item.disabled ?? false;
      b.setAttribute('aria-pressed', String(item.on));
      wrap.appendChild(b);
    }
    return wrap;
  };
  /** A thing: its picture, its name. */
  const card = (label: string, on: boolean, run: () => void, picture?: string, iconHtml?: string, extra = ''): HTMLButtonElement => {
    const b = el('button', `v2-card${on ? ' on' : ''}${extra ? ` ${extra}` : ''}`);
    b.type = 'button';
    b.title = label;
    const art = picture ? `<img class="v2-card-art" src="${picture}" alt="" />` : `<span class="v2-card-art glyph">${iconHtml ?? ''}</span>`;
    b.innerHTML = `${art}<span class="v2-card-name"></span>`;
    (b.querySelector('.v2-card-name') as HTMLElement).textContent = label;
    b.onclick = run;
    return b;
  };
  /** A verb: an icon and its name, in a row. */
  const verb = (label: string, on: boolean, run: () => void, iconHtml: string, danger = false): HTMLButtonElement => {
    const b = button(`v2-verb${on ? ' on' : ''}${danger ? ' danger' : ''}`, label, run, iconHtml);
    return b;
  };
  const section = (label: string, kind: 'cards' | 'verbs' = 'cards'): { box: HTMLElement; items: HTMLElement } => {
    const box = el('div', `v2-section ${kind}`);
    box.appendChild(el('div', 'v2-section-title', label));
    const items = el('div', 'v2-section-items');
    box.appendChild(items);
    strip.appendChild(box);
    return { box, items };
  };
  /** What a tool does: in the tooltip of its drawer, never as a paragraph. */
  const note = (text: string): void => {
    drawer.setAttribute('aria-description', text);
  };

  // ------------------------------------------------------------ roads
  function renderRoads(current: string): void {
    title.textContent = t('tool.road');
    const modes: [string, string, string][] = [['road', t('tool.draw'), 'draw'], ['upgrade', t('tool.upgrade'), 'upgrade'], ['move', t('tool.move'), 'move'], ['split', t('tool.split'), 'split'], ['control', t('tool.control'), 'control']];
    if (q('[data-road-op="roundabout"]')) modes.push(['roundabout', t('tool.roundabout'), 'roundabout']);
    for (const [id, label, icon] of modes) {
      tabs.appendChild(tab(label, current === id, () => {
        if (id === 'road') press('.tool[data-tool="road"]');
        else press(`[data-road-op="${id}"]`);
        render();
      }, false, svg(icon, 18)));
    }
    if (current === 'road') {
      const trace = group(t('palette.trace'));
      trace.appendChild(choices([...document.querySelectorAll<HTMLButtonElement>('.alignment-mode')].map((b) => ({
        label: b.textContent?.trim() ?? '',
        on: b.classList.contains('active'),
        run: () => { b.click(); render(); },
        icon: svg(b.dataset['alignment'] ?? 'straight', 18),
      }))));
      // Snapping, as Cities: Skylines II offers it: all of it, then each kind.
      const snap = roadSnap();
      const snapping = group(t('v2.snap.title'));
      snapping.appendChild(choices([
        { label: t('v2.snap.on'), on: snap.on, run: () => { setRoadSnap({ on: !snap.on }); render(); }, icon: svg('magnet', 18) },
        { label: t('v2.snap.angles'), on: snap.on && snap.angles, run: () => { setRoadSnap({ angles: !snap.angles }); render(); }, disabled: !snap.on, icon: svg('angle', 18) },
        { label: t('v2.snap.grid'), on: snap.on && snap.grid, run: () => { setRoadSnap({ grid: !snap.grid }); render(); }, disabled: !snap.on, icon: svg('grid', 18) },
        { label: t('v2.snap.zoneLength'), on: snap.on && snap.zoneLength, run: () => { setRoadSnap({ zoneLength: !snap.zoneLength }); render(); }, disabled: !snap.on, icon: svg('cells', 18) },
      ]));
      // Parking the new road is drawn with (`editor/roadParking.ts`).
      const parking = group(t('palette.parking'));
      const parkingNow = roadParkingPreset();
      parking.appendChild(choices(ROAD_PARKING_PRESETS.map((preset) => ({
        label: t(`parking.preset.${preset}`),
        on: parkingNow === preset,
        run: () => { setRoadParkingPreset(preset); render(); },
        icon: svg(`park-${preset}`, 18),
      }))));
      const height = group(`${t('palette.height')} - ${q('#roadHeightContext')?.textContent ?? ''}`);
      const stepper = el('div', 'v2-stepper');
      stepper.append(
        button('v2-icon', t('palette.height.lower'), () => { press('[data-height-step="-1"]'); render(); }, svg('minus', 14)),
        el('output', 'v2-stepper-value', q('#roadHeightValue')?.textContent ?? ''),
        button('v2-icon', t('palette.height.raise'), () => { press('[data-height-step="1"]'); render(); }, svg('plus', 14)),
      );
      height.append(stepper);
      const lanes = group(t('palette.lanes'));
      lanes.appendChild(choices([...document.querySelectorAll<HTMLButtonElement>('[data-lane-choice]')].filter((b) => !b.hidden).map((b) => {
        const id = b.dataset['laneChoice'] ?? '2';
        return {
          label: b.getAttribute('aria-label') ?? b.title ?? b.textContent?.trim() ?? '',
          on: b.classList.contains('active'),
          run: () => { b.click(); render(); },
          disabled: b.disabled,
          icon: svg(id === 'median' ? 'median' : `lanes${id}`, 18),
        };
      })));
      options.append(trace, snapping, parking, height, lanes);
    }
    if (current === 'road' || current === 'upgrade') {
      const { items } = section(t('palette.kind'));
      for (const b of document.querySelectorAll<HTMLButtonElement>('.road-type[data-type-index]')) {
        const img = b.querySelector('img')?.getAttribute('src') ?? undefined;
        items.appendChild(card(b.querySelector('.road-type-name')?.textContent ?? '', b.classList.contains('active'), () => { b.click(); render(); }, img, undefined, 'wide'));
      }
    } else if (current === 'roundabout') {
      const source = q<HTMLInputElement>('.road-palette .inspect-range input');
      if (source) {
        const g = group(t('road.roundabout.radius'));
        const input = el('input');
        input.type = 'range';
        input.min = source.min;
        input.max = source.max;
        input.step = source.step;
        input.value = source.value;
        const out = el('output', 'v2-slider-out', `${source.value} m`);
        input.oninput = () => { setInput('.road-palette .inspect-range input', input.value); out.textContent = `${input.value} m`; };
        const wrap = el('div', 'v2-slider');
        wrap.append(input, out);
        g.appendChild(wrap);
        options.appendChild(g);
      }
      note(t('hint.roundabout'));
    } else {
      note(t(`hint.${current}`));
    }
  }

  // ------------------------------------------------------------ zones
  function renderZones(): void {
    title.textContent = t('tool.zone');
    const tool2 = section(t('v2.zone.tool'), 'verbs');
    const modes: [string, string, string][] = [['[data-zone-mode="brush"]', t('zone.brush'), 'brush'], ['[data-zone-mode="fill"]', t('zone.fill'), 'fill'], ['#zoneRemove', t('zone.remove'), 'eraser']];
    for (const [selector, label, icon] of modes) {
      const b = q<HTMLButtonElement>(selector);
      tool2.items.appendChild(verb(label, b?.classList.contains('active') ?? false, () => { b?.click(); render(); }, svg(icon, 20), icon === 'eraser'));
    }
    const use = section(t('v2.zone.use'));
    for (const [key, colour] of [['residential', '#58c26f'], ['commercial', '#4aa3e8'], ['industrial', '#e6b84a']] as const) {
      const b = q<HTMLButtonElement>(`[data-zone-use="${key}"]`);
      const c = card(t(`zone.${key}`), b?.classList.contains('active') ?? false, () => { b?.click(); render(); }, undefined, `<i class="v2-zone-swatch" style="--zone:${colour}"></i>`);
      use.items.appendChild(c);
    }
    const density = group(t('v2.zone.density'));
    density.appendChild(choices((['low', 'medium', 'high'] as const).map((key) => {
      const b = q<HTMLButtonElement>(`[data-zone-density="${key}"]`);
      return { label: `${t('v2.zone.density')}: ${t(`zone.${key}`)}`, on: b?.classList.contains('active') ?? false, run: () => { b?.click(); render(); }, icon: svg(key, 18) };
    })));
    options.appendChild(density);
  }

  // ------------------------------------------------------------ landscape
  function renderLandscape(current: string): void {
    title.textContent = t('v2.cat.landscape');
    landTab = current === 'barrier' ? 'barrier' : current === 'pole' ? 'pole' : 'terrain';
    for (const [id, label, icon] of [['terrain', t('tool.terrain'), 'terrain'], ['barrier', t('v2.land.walls'), 'walls'], ['pole', t('tool.pole'), 'poles']] as const) {
      tabs.appendChild(tab(label, landTab === id, () => { press(`.tool[data-tool="${id}"]`); render(); }, false, svg(icon, 18)));
    }
    if (landTab === 'terrain') {
      const { items } = section(t('v2.terrain.brush'));
      for (const [mode, icon] of [['raise', 'raise'], ['lower', 'lower'], ['flatten', 'flatten'], ['river', 'river']] as const) {
        const b = q<HTMLButtonElement>(`[data-terrain-mode="${mode}"]`);
        items.appendChild(card(t(`terrain.${mode}`), b?.classList.contains('active') ?? false, () => { b?.click(); render(); }, undefined, svg(icon, 34)));
      }
      const brush = group(t('v2.options'));
      brush.append(slider(t('terrain.radius'), '#terrainRadius', '#terrainRadiusValue', svg('radius', 16)), slider(t('terrain.strength'), '#terrainStrength', '#terrainStrengthValue', svg('strength', 16)));
      brush.appendChild(button('v2-icon danger', t('terrain.clear'), () => press('#clearTerrain'), svg('flatten', 16)));
      options.append(brush);
    } else if (landTab === 'barrier') {
      const { items } = section(t('v2.land.walls'));
      for (const b of document.querySelectorAll<HTMLButtonElement>('.tool-help-kinds [data-barrier]')) {
        items.appendChild(card(b.textContent ?? '', b.classList.contains('active'), () => { b.click(); render(); }, undefined, builderIconSvg(b.dataset['barrier'] === 'hedge' ? 'hedge' : b.dataset['barrier'] === 'wall' ? 'wallRun' : 'fenceRun', 34)));
      }
      note(t('help.tool.barrier'));
    } else {
      note(t('help.tool.pole'));
    }
  }

  // ------------------------------------------------------------ simple tools
  function renderSimple(current: string): void {
    title.textContent = t(`tool.${current}`);
    note(t(`help.tool.${current}`));
  }

  // ------------------------------------------------------------ construction
  const picture = (id: string): string | undefined => {
    const shape = DRAW_SHAPES[id] ?? TIER_SHAPES[id];
    return workspace.thumbnail(id) ?? (shape ? planSwatch(shape) : undefined);
  };
  const ask = (ids: readonly string[]): void => {
    const wanted = ids.filter((id) => !requested.has(id) && !workspace.thumbnail(id));
    for (const id of wanted) requested.add(id);
    if (wanted.length) actions.requestThumbnails(wanted);
  };
  const THINGS = new Set<string>([...FACADE_PATTERNS, 'window', 'sashWindow', 'wideWindow', 'ribbon', 'bayWindow', 'frenchWindow',
    'door', 'doubleDoor', 'garageDoor', 'loadingDoor', 'balcony', 'shopfront', 'roofFlat', 'roofShed', 'roofGable', 'roofHip',
    'roofSawtooth', 'roofTerrace', 'solar', 'skylight', 'vent', 'chimney', 'waterTank', 'spire', 'lantern', 'stair', 'ramp', 'pillar',
    'canopy', 'wall', 'slab', 'wallRun', 'fenceRun', 'pavementRun', 'railing', 'stairRun', 'tree', 'shrub', 'hedge', 'flowers', 'rocks',
    'bench', 'planter', 'parking', 'ac', 'awning', 'clock']);

  function renderBuild(): void {
    title.textContent = t('tool.building');
    const state = builder;
    if (!state) return;
    const selected = state.selection !== null;


    const createTabs: BuilderCategoryId[] = ['models', 'draw'];
    const editTabs: BuilderCategoryId[] = ['mass', 'facade', 'roof', 'parts', 'interior', 'paint'];
    const visible = selected ? [...createTabs, ...editTabs] : [...createTabs, 'paint' as const];
    for (const id of visible) {
      const label = id === 'mass' ? t('v2.build.shape') : t(`builder.category.${id}`);
      const icon = ({ models: 'models', draw: 'draw', mass: 'mass', facade: 'face', roof: 'roof', parts: 'components', interior: 'interiorView', paint: 'paint' } as Record<string, string>)[id] ?? 'models';
      tabs.appendChild(tab(label, state.category === id, () => actions.setCategory(id), false, builderIconSvg(icon, 18)));
    }
    if (!selected) tabs.title = t('v2.build.selectToEdit');

    // The pointer's switches, in the head.
    if (selected) {
      const floor = el('select', 'v2-mini');
      floor.title = t('builder.floor.title');
      for (let i = 0; i < Math.max(1, state.floor.total); i++) {
        const o = el('option', '', `${t('v2.build.floor')} ${i + 1}`);
        o.value = String(i);
        o.selected = i === state.floor.active;
        floor.appendChild(o);
      }
      floor.onchange = () => actions.setFloor(Number(floor.value));
      tools.appendChild(floor);
    }
    const snap = el('select', 'v2-mini');
    snap.title = t('builder.snap.label');
    for (const s of SNAP_MODES) {
      const o = el('option', '', `${t('builder.snap.label')}: ${t(`builder.snap.${s}`)}`);
      o.value = s;
      o.selected = s === state.snap;
      snap.appendChild(o);
    }
    snap.onchange = () => actions.setSnap(snap.value);
    const grid = button('v2-icon' + (state.grid ? ' on' : ''), t('builder.grid'), () => actions.toggleGrid(), svg('grid', 17));
    const hide = button('v2-icon' + (state.hideOthers ? ' on' : ''), t('builder.hideOthers'), () => actions.toggleHideOthers(), svg('hide', 17));
    tools.append(snap, grid, hide);
    if (selected) tools.appendChild(button('v2-icon', t('builder.view.frame'), () => actions.view('frame'), svg('frame', 17)));

    if (state.planning) {
      const plan = group(t('v2.build.plan'));
plan.appendChild(choices([
        { label: t('builder.plan.finish'), on: true, run: () => actions.planFinish(), disabled: state.planPoints < 3, icon: svg('check', 18) },
        { label: t('builder.plan.back'), on: false, run: () => actions.planBack(), icon: svg('undo', 18) },
        { label: t('builder.plan.cancel'), on: false, run: () => actions.planCancel(), icon: svg('close', 18) },
      ]));
      options.appendChild(plan);
    }

    const spec = BUILDER_TAB_SPECS.find((s) => s.id === state.category);
    if (!spec) return;
    if (spec.needsSelection && !selected) {
      note(t('builder.needsSelection'));
      return;
    }
    const sections = spec.sections.filter((s) => !s.advanced || advanced);
    const wantPictures: string[] = [];
    for (const s of sections) {
      for (const x of s.tools ?? []) wantPictures.push(x.id);
      if (s.shelf === 'models') wantPictures.push(...CITY_BUILDINGS.map((c) => `city:${c.fn}`), ...BLUEPRINTS.map((b) => b.key), ...state.userBlueprints.map((b) => b.key));
      if (s.shelf === 'patterns') wantPictures.push(...FACADE_PATTERNS);
    }
    ask(wantPictures);
    for (const s of sections) renderSection(s, state);
    if (spec.sections.some((s) => s.advanced)) {
      const count = spec.sections.filter((s) => s.advanced).reduce((n, s) => n + (s.tools?.length ?? 0), 0);
      const adv = group(advanced ? t('builder.advanced.on') : `${t('builder.advanced.off')} (${count})`);
      adv.appendChild(choices([{ label: advanced ? t('builder.advanced.on') : `${t('builder.advanced.off')} (${count})`, on: advanced, icon: svg('advanced', 18), run: () => {
        advanced = !advanced;
        try { window.localStorage.setItem('roadcraft.builder.advanced', advanced ? '1' : '0'); } catch { /* not kept */ }
        render();
      } }]));
      options.appendChild(adv);
    }
  }

  function renderSection(s: BuilderSection, state: BuilderState): void {
    const label = s.title ? t(`builder.section.${s.title}`) : '';
    if (s.shelf === 'models') return renderModels(state);
    if (s.shelf === 'scope') {
      const g = group(label);
      g.appendChild(choices(FACADE_SCOPES.map((scope) => ({ label: t(`creator.dock.scope.${scope}`), on: state.scope === scope, run: () => actions.setScope(scope), icon: svg(`scope_${scope}`, 18) }))));
      options.appendChild(g);
      return;
    }
    if (s.shelf === 'drawAction') {
      const g = group(label);
      const drawIcon = { new: 'addVolume', ground: 'wing', top: 'stack', cut: 'cut' } as const;
      g.appendChild(choices(DRAW_ACTIONS.map((a) => ({ label: t(`builder.drawAction.${a}`), on: state.drawAction === a, run: () => actions.setDrawAction(a), disabled: a !== 'new' && !state.selection, icon: builderIconSvg(drawIcon[a], 18) }))));
      options.appendChild(g);
      return;
    }
    if (s.shelf === 'roofParams') {
      const roof = state.roof;
      const g = group(t('builder.field.pitch'));
      const stepper = el('div', 'v2-stepper');
      stepper.append(
        button('v2-icon', '−5°', () => actions.roofPitch(-5), svg('minus', 16)),
        el('output', 'v2-stepper-value', `${roof?.pitch ?? 30}°`),
        button('v2-icon', '+5°', () => actions.roofPitch(5), svg('plus', 16)),
      );
      g.appendChild(stepper);
      options.appendChild(g);
      if (roof?.pitched) {
        const ridge = group(t('builder.roof.ridge.label'));
        ridge.appendChild(choices((['x', 'y'] as const).map((r) => ({ label: t(`builder.roof.ridge.${r}`), on: roof.ridge === r, run: () => actions.roofRidge(r), icon: svg(`ridge_${r}`, 18) }))));
        const fall = group(t('builder.roof.side.label'));
        fall.appendChild(choices(([[0, 'front'], [1, 'right'], [2, 'back'], [3, 'left']] as const).map(([side, key]) => ({ label: t(`builder.roof.side.${key}`), on: roof.fall === side, run: () => actions.roofFall(side), icon: svg(`fall_${key}`, 18) }))));
        options.append(ridge, fall);
      }
      return;
    }
    if (s.shelf === 'patterns') {
      const { items } = section(label);
      for (const p of FACADE_PATTERNS) items.appendChild(card(t(`creator.pattern.${p}`), state.pattern === p, () => actions.choosePattern(p), workspace.thumbnail(p), builderIconSvg(p, 30)));
      return;
    }
    if (s.shelf === 'finishes') {
      const { items } = section(t('v2.build.material'));
      for (const f of FINISHES) items.appendChild(card(t(`building.finish.${f}`), state.material?.finish === f, () => actions.chooseFinish(f), materialSwatch(f), undefined, 'square'));
      const colours = group(t('v2.build.colour'));
      const sw = el('div', 'v2-swatches');
      for (const c of SWATCHES) {
        const b = el('button', 'v2-swatch' + (state.material?.colour === c ? ' on' : ''));
        b.type = 'button';
        b.style.setProperty('--c', hexOf(c));
        b.setAttribute('aria-label', hexOf(c));
        b.onclick = () => actions.chooseColour(c);
        sw.appendChild(b);
      }
      const custom = el('input', 'v2-swatch custom');
      custom.type = 'color';
      custom.onchange = () => actions.chooseColour(parseInt(custom.value.slice(1), 16));
      sw.appendChild(custom);
      colours.appendChild(sw);
      options.appendChild(colours);
      const st = section(t('builder.section.styles'));
      for (const style of STYLES) {
        const chips = [style.materials.wall.colour, style.materials.trim.colour, style.materials.roof.colour].map((c) => `<i style="background:${hexOf(c)}"></i>`).join('');
        st.items.appendChild(card(t(`building.style.${style.key}`), false, () => actions.chooseStyle(style.key), undefined, `<span class="v2-style">${chips}</span>`, 'square'));
      }
      return;
    }
    const list = s.tools ?? [];
    if (!list.length) return;
    const things = list.some((x) => THINGS.has(x.id) || DRAW_SHAPES[x.id] || TIER_SHAPES[x.id]);
    const { items } = section(label || title.textContent || '', things ? 'cards' : 'verbs');
    for (const x of list) items.appendChild(toolButton(x, state, things));
  }

  function toolButton(x: BuilderToolSpec, state: BuilderState, asCard: boolean): HTMLButtonElement {
    const on = x.kind === 'mode' && (state.tool === x.id || state.armed === x.id);
    const label = t(`builder.tool.${x.id}`);
    const run = (): void => actions.chooseTool(x.id);
    const b = asCard ? card(label, on, run, picture(x.id), builderIconSvg(x.id, 32)) : verb(label, on, run, builderIconSvg(x.id, 18), x.danger);
    b.disabled = !state.ready.has(x.id);
    b.dataset['builderTool'] = x.id;
    return b;
  }

  function renderModels(state: BuilderState): void {
    const g = group(t('builder.search'));
    const search = el('input', 'v2-search');
    search.type = 'search';
    search.placeholder = t('builder.search');
    search.value = modelQuery;
    search.onkeydown = (e) => e.stopPropagation();
    g.appendChild(search);
    const cats = ['all', 'homes', 'public', 'commerce', 'work', 'leisure', 'generic', ...(state.userBlueprints.length ? ['mine'] : [])];
    // The kinds of building in one dropdown, not a row of names.
    const kind = el('select', 'v2-mini');
    kind.title = t('builder.category.models');
    for (const c of cats) {
      const o = el('option', '', c === 'all' ? t('builder.city.all') : c === 'mine' ? t('builder.city.mine') : t(`builder.city.${c}`));
      o.value = c;
      o.selected = modelCat === c;
      kind.appendChild(o);
    }
    kind.onchange = () => { modelCat = kind.value; render(); };
    g.appendChild(kind);
    options.appendChild(g);
    const { items } = section(t('builder.category.models'));
    const names = new Set<string>();
    type Entry = { key: string; label: string; cat: string; run: () => void };
    const entries: Entry[] = [];
    for (const m of CITY_BUILDINGS) {
      const key = `city:${m.fn}`;
      const label = t(`building.fn.${m.fn}`);
      names.add(label.toLocaleLowerCase());
      entries.push({ key, label, cat: m.category, run: () => actions.choosePreset(key) });
    }
    for (const bp of BLUEPRINTS) {
      const label = bp.nameKey ? t(bp.nameKey) : bp.key;
      if (!names.has(label.toLocaleLowerCase())) entries.push({ key: bp.key, label, cat: 'generic', run: () => actions.choosePreset(bp.key) });
    }
    for (const bp of state.userBlueprints) entries.push({ key: bp.key, label: bp.name ?? bp.key, cat: 'mine', run: () => actions.chooseUserBlueprint(bp.key) });
    const fill = (): void => {
      items.innerHTML = '';
      const query = modelQuery.trim().toLocaleLowerCase();
      const shown = entries.filter((e) => (modelCat === 'all' || e.cat === modelCat) && (!query || e.label.toLocaleLowerCase().includes(query)));
      for (const e of shown) items.appendChild(card(e.label, false, e.run, workspace.thumbnail(e.key), builderIconSvg('models', 32), 'model'));
      if (!shown.length) items.appendChild(el('p', 'v2-muted', t('builder.search.none')));
    };
    search.oninput = () => { modelQuery = search.value; fill(); };
    fill();
  }

  // ================================================================ render
  let lastSignature = '';
  function render(): void {
    const current = tool();
    const cat = categoryOf(current);
    for (const [id, b] of catButtons) {
      b.classList.toggle('on', id === cat && open && current !== 'inspect');
      const c = CATS.find((x) => x.id === id);
      (b.querySelector('.v2-cat-name') as HTMLElement).textContent = c?.label() ?? '';
      // Only the icon shows: the name and the key are in the tooltip.
      b.dataset['tip'] = c ? `${c.label()}  ${c.key}` : '';
      b.setAttribute('aria-label', c?.label() ?? '');
    }
    const showDrawer = open && cat !== null && cat !== 'people';
    drawer.hidden = !showDrawer;
    toolOptions.hidden = !showDrawer;
    studio.hidden = cat !== 'people' || !open;
    side.hidden = q('#inspector')?.classList.contains('hidden') ?? true;
    root.dataset['tool'] = current;
    syncSide();
    if (!showDrawer) return;
    // Keep the search box focused across a rebuild.
    const focused = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('v2-search');
    const scroll = strip.scrollLeft;
    tabs.innerHTML = '';
    tools.innerHTML = '';
    options.innerHTML = '';
    strip.innerHTML = '';
    drawer.removeAttribute('aria-description');
    if (cat === 'roads') renderRoads(current);
    else if (cat === 'zones') renderZones();
    else if (cat === 'landscape') renderLandscape(current);
    else if (cat === 'build') renderBuild();
    else renderSimple(current);
    options.hidden = options.childElementCount === 0;
    tabs.hidden = tabs.childElementCount === 0;
    // A tool with nothing to choose (demolish, inspect) opens no drawer: its
    // icon is lit in the dock and its help is in the tooltip.
    drawer.hidden = tabs.hidden && strip.childElementCount === 0;
    toolOptions.hidden = options.hidden && tools.childElementCount === 0;
    if (lastSignature === `${cat}|${current}|${builder?.category ?? ''}`) strip.scrollLeft = scroll;
    lastSignature = `${cat}|${current}|${builder?.category ?? ''}`;
    if (focused) {
      const s = options.querySelector<HTMLInputElement>('.v2-search');
      s?.focus();
      s?.setSelectionRange(s.value.length, s.value.length);
    }
    updateHint();
    fitDrawer();
  }
  /**
   * The asset panel stands centred over the dock but never over the tool
   * options (left) or the selection (right): its width is what is left between
   * them, whatever the screen.
   */
  function fitDrawer(): void {
    if (drawer.hidden) return;
    const vw = window.innerWidth;
    let left = 12;
    let right = vw - 12;
    if (!toolOptions.hidden) left = Math.max(left, toolOptions.getBoundingClientRect().right + 12);
    const sel = [side, q('#builder .bw-inspector')].filter((e): e is HTMLElement => !!e && !e.hidden && e.getBoundingClientRect().width > 0);
    for (const e of sel) {
      const r = e.getBoundingClientRect();
      // Only what reaches down to the panel's height matters.
      if (r.bottom > drawer.getBoundingClientRect().top - 4) right = Math.min(right, r.left - 12);
    }
    const half = Math.max(160, Math.min(vw / 2 - left, right - vw / 2));
    drawer.style.maxWidth = `${Math.floor(Math.min(1100, half * 2))}px`;
  }
  window.addEventListener('resize', () => fitDrawer());
  let wantInfo = true;
  void wantInfo;

  function updateHint(): void {
    const current = tool();
    const text = current === 'building' ? builder?.hint ?? '' : (q('#hint')?.textContent ?? '');
    if (hint.textContent !== text) hint.textContent = text;

  }

  // The HUD follows the game's numbers.
  const tick = (): void => {
    clock.textContent = q('#cityClock')?.textContent ?? '';
    sky.textContent = q('#skyMode')?.textContent ?? '';
    const parts = ['#residentCount', '#vehicleCount', '#pedCount'].map((s) => q(s)?.textContent ?? '').filter(Boolean);
    const line = parts.join('  ·  ');
    if (stats.textContent !== line) stats.textContent = line;
    const active = q('.simulation-controls [data-speed].active')?.dataset['speed'] ?? '1';
    for (const b of speedButtons) b.classList.toggle('on', b.dataset['speed'] === active);
    undo.disabled = q<HTMLButtonElement>('#undoAction')?.disabled ?? false;
    redo.disabled = q<HTMLButtonElement>('#redoAction')?.disabled ?? false;
    updateHint();
    syncSide();
  };
  function syncSide(): void {
    const roadSide = !(q('#inspector')?.classList.contains('hidden') ?? true);
    if (side.hidden === roadSide) side.hidden = !roadSide;
    const builderSide = !(q('#builder .bw-inspector')?.hidden ?? true);
    root.classList.toggle('has-side', roadSide || builderSide);
  }
  setInterval(tick, 250);
  tick();

  // Re-render when the game changes a tool or an option: its own controls
  // carry the truth (classes, pressed states), and the Builder reports its state.
  let pending = false;
  const later = (): void => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      render();
    });
  };
  const watch = new MutationObserver(later);
  const game = q('#game');
  if (game) watch.observe(game, { attributes: true, attributeFilter: ['data-tool'] });
  const builderRoot = document.getElementById('builder');
  if (builderRoot) watch.observe(builderRoot, { attributes: true, subtree: true, attributeFilter: ['class', 'aria-pressed'] });
  workspace.subscribe((state) => {
    builder = state;
    if (tool() === 'building') later();
  });
  window.addEventListener('keydown', (e) => {
    // A tool picked from the keyboard opens its drawer.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (/^[1-6tbipfzhkucmx]$/i.test(e.key)) {
      open = true;
      later();
    }
  });
  onLanguageChange(() => {
    for (const [b, key] of [[undo, 'action.undo'], [redo, 'action.redo'], [menuB, 'builder.menu.app'], [simB, 'builder.menu.simulation'], [camB, 'camera.label'], [helpB, 'builder.help']] as const) {
      const s = b.querySelector('span');
      if (s) s.textContent = t(key);
      b.title = t(key);
    }
    later();
  });
  render();
}
