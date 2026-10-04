import type { AgentView } from '@sim/city/life';
import { t } from './i18n';

/**
 * A resident's card: who they are, what they are doing and why, where they
 * are going, where their car is. Opened by clicking on a person or on their
 * car with the inspect tool, kept up to date while it is open, as a city
 * builder's citizen panel is (Cities: Skylines II), and with a button that
 * keeps the camera on them.
 *
 * Every row is an icon (its name in the tooltip) and the fact itself.
 */

export interface AgentCard {
  /** The resident shown, or null when closed. */
  readonly resident: number | null;
  /** Whether the camera follows them. */
  readonly following: boolean;
  open(resident: number): void;
  close(): void;
  /** Writes what the resident is doing now; `place` names a building. */
  update(view: AgentView | null, place: (building: number) => string): void;
}

const ICON: Record<string, string> = {
  person: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  doing: '<circle cx="13" cy="4.5" r="2"/><path d="M9 21l2-6 3 3v3M7 12l3-4 4 1 3 3M11 15l-1-4"/>',
  why: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.5"/>',
  to: '<path d="M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
  work: '<rect x="4" y="8" width="16" height="12" rx="1"/><path d="M9 8V5h6v3"/>',
  car: '<path d="M4 16v-4l2-5h12l2 5v4z"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/>',
  follow: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;
}

const CSS = `
.agent-card { position: absolute; right: 12px; top: calc(12px + var(--v-hud-h, 52px) + 10px); width: 320px; padding: 12px 14px;
  border-radius: 16px; pointer-events: auto; background: var(--v-bg, rgba(20,24,28,.86)); border: 1px solid var(--v-line, rgba(255,255,255,.12));
  box-shadow: var(--v-shadow, 0 10px 30px rgba(0,0,0,.35)); backdrop-filter: blur(18px) saturate(130%); color: var(--v-text, #eef2f4); font-size: 14px; z-index: 30; }
.agent-card[hidden] { display: none; }
.agent-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.agent-card-name { flex: 1; font-weight: 700; font-size: 15px; }
.agent-card-head button { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; border: 1px solid transparent;
  background: transparent; color: inherit; cursor: pointer; }
.agent-card-head button:hover { background: rgba(255,255,255,.08); }
.agent-card-head button[aria-pressed="true"] { background: var(--v-accent, #3fd0a8); color: #0d1714; }
.agent-card-row { display: grid; grid-template-columns: 26px 1fr; align-items: center; gap: 6px; padding: 4px 0; min-height: 26px; }
.agent-card-row svg { opacity: .75; }
.agent-card-row[hidden] { display: none; }
`;

export function createAgentCard(host: HTMLElement, onChange: () => void = () => {}): AgentCard {
  if (!document.getElementById('agent-card-css')) {
    const style = document.createElement('style');
    style.id = 'agent-card-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement('section');
  root.className = 'agent-card';
  root.hidden = true;
  const head = document.createElement('div');
  head.className = 'agent-card-head';
  const name = document.createElement('span');
  name.className = 'agent-card-name';
  const follow = document.createElement('button');
  follow.type = 'button';
  follow.innerHTML = icon('follow');
  follow.setAttribute('aria-pressed', 'false');
  const close = document.createElement('button');
  close.type = 'button';
  close.innerHTML = icon('close');
  const who = document.createElement('span');
  who.innerHTML = icon('person');
  head.append(who, name, follow, close);
  root.appendChild(head);

  const rows: Record<string, { row: HTMLElement; text: HTMLElement }> = {};
  for (const key of ['doing', 'why', 'to', 'home', 'work', 'car']) {
    const row = document.createElement('div');
    row.className = 'agent-card-row';
    const label = document.createElement('span');
    label.innerHTML = icon(key);
    const text = document.createElement('span');
    row.append(label, text);
    root.appendChild(row);
    rows[key] = { row, text };
  }
  host.appendChild(root);

  let resident: number | null = null;
  let following = false;
  const tips = (): void => {
    follow.title = t('agent.follow');
    close.title = t('agent.close');
    rows['doing']!.row.title = t('agent.doingLabel');
    rows['why']!.row.title = t('agent.whyLabel');
    rows['to']!.row.title = t('agent.toLabel');
    rows['home']!.row.title = t('agent.homeLabel');
    rows['work']!.row.title = t('agent.workLabel');
    rows['car']!.row.title = t('agent.carLabel');
  };
  follow.addEventListener('click', () => {
    following = !following;
    follow.setAttribute('aria-pressed', String(following));
    onChange();
  });
  const card: AgentCard = {
    get resident() { return resident; },
    get following() { return following; },
    open(id) {
      resident = id;
      root.hidden = false;
      tips();
      onChange();
    },
    close() {
      resident = null;
      following = false;
      follow.setAttribute('aria-pressed', 'false');
      root.hidden = true;
      onChange();
    },
    update(view, place) {
      if (!view) { card.close(); return; }
      name.textContent = `${t('agent.title', { n: view.resident })} · ${t(`agent.age.${view.ageClass}`)}`;
      const trip = view.trip;
      const set = (key: string, value: string | null): void => {
        rows[key]!.row.hidden = value === null;
        if (value !== null) rows[key]!.text.textContent = value;
      };
      if (trip) {
        set('doing', t(`agent.doing.${trip.step}`, { place: place(trip.to) }));
        set('why', t(`agent.why.${trip.why}`));
        set('to', place(trip.to));
      } else {
        const at = view.at;
        set('doing', at === view.home ? t('agent.at.home') : at !== null && at === view.work ? t('agent.at.work')
          : at !== null ? t('agent.at.place', { place: place(at) }) : t('agent.at.nowhere'));
        set('why', null);
        set('to', null);
      }
      set('home', place(view.home));
      set('work', view.work !== null ? place(view.work) : null);
      const car = view.car;
      set('car', !car ? t('agent.car.none')
        : `${t(`agent.carKind.${car.archetype}`)} · ${car.state === 'parked' && car.at !== null
          ? t('agent.car.parked', { place: place(car.at) }) : t(`agent.car.${car.state}`)}`);
    },
  };
  close.addEventListener('click', () => card.close());
  return card;
}
