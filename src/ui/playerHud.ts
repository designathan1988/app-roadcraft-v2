import type { PlayerView } from '@sim/agents/player';
import { t } from './i18n';

/**
 * The player's panel while a person of the city is in their hands: who they
 * are, their health, the wanted stars, the speed at the wheel, what just
 * happened, and the keys. As GTA's: in a corner, out of the way of the view.
 */
export interface PlayerHud {
  update(view: PlayerView | null, name: string, now: number): void;
}

const CSS = `
.player-hud { position: fixed; left: 16px; top: 70px; z-index: 31; width: 248px; padding: 10px 12px; border-radius: 12px;
  background: rgba(22, 28, 34, .92); color: #e8eef2; box-shadow: 0 4px 18px rgba(0,0,0,.35);
  font: 500 12.5px/1.35 system-ui, sans-serif; }
.player-hud[hidden] { display: none; }
.player-hud .ph-name { font-weight: 700; font-size: 14px; display: flex; justify-content: space-between; gap: 8px; }
.player-hud .ph-stars { color: #f4c542; letter-spacing: 2px; font-size: 15px; }
.player-hud .ph-stars .off { color: rgba(255,255,255,.18); }
.player-hud .ph-bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.12); margin: 6px 0 4px; overflow: hidden; }
.player-hud .ph-bar > i { display: block; height: 100%; background: #5fd38d; }
.player-hud .ph-bar.low > i { background: #f07a5a; }
.player-hud .ph-mode { opacity: .8; }
.player-hud .ph-msg { margin-top: 6px; min-height: 17px; color: #ffd98a; }
.player-hud .ph-keys { margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,.1); opacity: .75; font-size: 11.5px; }
.player-hud kbd { display: inline-block; min-width: 16px; padding: 0 4px; border-radius: 4px; background: rgba(255,255,255,.12);
  font: 600 11px/16px system-ui, sans-serif; text-align: center; }
`;

export function createPlayerHud(host: HTMLElement): PlayerHud {
  if (!document.getElementById('player-hud-css')) {
    const style = document.createElement('style');
    style.id = 'player-hud-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement('div');
  root.className = 'player-hud';
  root.hidden = true;
  root.innerHTML = `<div class="ph-name"><span class="ph-who"></span><span class="ph-stars"></span></div>
    <div class="ph-bar"><i></i></div><div class="ph-mode"></div><div class="ph-msg"></div><div class="ph-keys"></div>`;
  host.appendChild(root);
  const who = root.querySelector<HTMLElement>('.ph-who')!;
  const stars = root.querySelector<HTMLElement>('.ph-stars')!;
  const bar = root.querySelector<HTMLElement>('.ph-bar')!;
  const fill = root.querySelector<HTMLElement>('.ph-bar > i')!;
  const mode = root.querySelector<HTMLElement>('.ph-mode')!;
  const msg = root.querySelector<HTMLElement>('.ph-msg')!;
  const keys = root.querySelector<HTMLElement>('.ph-keys')!;
  let keysFor = '';
  return {
    update(view, name, now) {
      root.hidden = view === null;
      if (!view) return;
      who.textContent = name;
      stars.innerHTML = Array.from({ length: 5 }, (_, i) => `<span class="${i < view.wanted ? '' : 'off'}">★</span>`).join('');
      stars.title = t('player.wanted');
      fill.style.width = `${Math.round(view.health)}%`;
      bar.classList.toggle('low', view.health < 35);
      bar.title = t('player.health');
      mode.textContent = view.mode === 'car'
        ? t('player.driving', { speed: Math.round(view.speed * 0.4 * 3.6) })
        : t('player.onFoot') + (view.officers > 0 ? ` · ${t('player.officers', { n: view.officers })}` : '');
      msg.textContent = view.message && now - view.message.at < 5 ? t(`player.msg.${view.message.key}`) : '';
      if (keysFor !== view.mode) {
        keysFor = view.mode;
        keys.innerHTML = t(view.mode === 'car' ? 'player.keys.car' : 'player.keys.foot');
      }
    },
  };
}
