/**
 * The interface redesign (docs/audit/2026-10-04-ui) ships behind a switch
 * first: `?ui=v2` turns it on and remembers it, `?ui=v1` turns it off. The
 * root element carries `data-ui="v2"` so the stylesheet and the code read the
 * same answer.
 *
 * `?debug` (or F3) shows the developer's numbers - roads, nodes, the audit,
 * zoom, the build - which the player's status bar no longer carries.
 */

const KEY = 'roadcraft.ui';

function readChoice(): 'v1' | 'v2' {
  try {
    const param = new URLSearchParams(window.location.search).get('ui');
    if (param === 'v1' || param === 'v2') {
      window.localStorage.setItem(KEY, param);
      return param;
    }
    // The redesign is the default; ?ui=v1 keeps the old interface reachable.
    return window.localStorage.getItem(KEY) === 'v1' ? 'v1' : 'v2';
  } catch {
    return 'v2';
  }
}

const choice = readChoice();
document.documentElement.dataset['ui'] = choice;

export const UI_V2 = choice === 'v2';

function readDebug(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('debug');
  } catch {
    return false;
  }
}

export function setDebugOverlay(on: boolean): void {
  if (on) document.documentElement.dataset['debug'] = '1';
  else delete document.documentElement.dataset['debug'];
}

setDebugOverlay(readDebug());
window.addEventListener('keydown', (e) => {
  if (e.key !== 'F3') return;
  e.preventDefault();
  setDebugOverlay(document.documentElement.dataset['debug'] !== '1');
});
