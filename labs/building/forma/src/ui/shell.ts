// Monta a casca do editor dentro do contêiner e injeta o CSS uma única vez.
import legacyCss from './legacy.css?inline';
import extraCss from './styles.css?inline';
import { SHELL_HTML } from './shell-html';
import { hydrate } from './icons';

const STYLE_ID = 'forma-editor-styles';

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = legacyCss + '\n' + extraCss;
  doc.head.appendChild(style);
}

export type UiLevel = 'simple' | 'advanced';

export interface Shell {
  root: HTMLElement;
  app: HTMLElement;
  viewport: HTMLElement;
  /** Consulta dentro do editor (os IDs não vazam para a página). */
  $<T extends HTMLElement = HTMLElement>(sel: string): T;
  $$<T extends HTMLElement = HTMLElement>(sel: string): T[];
  setLevel(level: UiLevel): void;
  dispose(): void;
}

export function createShell(container: HTMLElement, level: UiLevel): Shell {
  const doc = container.ownerDocument;
  injectStyles(doc);
  const root = doc.createElement('div');
  root.className = 'forma-root';
  const app = doc.createElement('div');
  app.className = 'forma-app';
  app.innerHTML = SHELL_HTML;
  root.appendChild(app);
  container.appendChild(root);
  const $ = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T;
  const $$ = <T extends HTMLElement>(sel: string) => [...app.querySelectorAll(sel)] as T[];

  // Botão do modo avançado, ao lado de desfazer/refazer.
  $('#redo').insertAdjacentHTML(
    'afterend',
    '<div class="separator"></div><button id="ui-level" class="header-button level-toggle" data-icon="detail" aria-pressed="false" title="Mostrar todos os controles"><span>Modo avançado</span></button>',
  );
  // Aba Lote, logo depois de Volumes.
  $('[data-tab="volumes"]').insertAdjacentHTML('afterend', '<div class="separator"></div><button class="tab" data-tab="lot" data-icon="lot">Lote</button>');
  // Aba Interior, depois de Lote.
  $('[data-tab="lot"]').insertAdjacentHTML('afterend', '<div class="separator"></div><button class="tab" data-tab="interior" data-icon="wall">Interior</button>');
  // Aba Estilos, depois de Coberturas.
  $('[data-tab="roofs"]').insertAdjacentHTML('afterend', '<div class="separator"></div><button class="tab" data-tab="styles" data-icon="style">Estilos</button>');
  app.insertAdjacentHTML('beforeend', '<input type="file" id="style-input" accept=".json,application/json" hidden><div id="coach" role="dialog" aria-label="Tutorial"></div>');
  // Caixa de medidas (como no SketchUp): digite valores depois de desenhar, puxar ou mover.
  $('#status-metric').insertAdjacentHTML('beforebegin', '<span id="measure-box" class="measure-box" title="Digite um valor e Enter logo depois de desenhar, puxar ou mover"><span class="measure-label">Medidas</span><span class="measure-value"></span></span>');
  // Conta-gotas de estilo na barra de ferramentas.
  $('[data-tool="cut"]').insertAdjacentHTML('afterend', '<button data-tool="eyedrop" data-icon="eyedrop" title="Conta-gotas de estilo · I" aria-label="Conta-gotas de estilo"></button>');
  // Barra de pavimentos, rótulos de cômodos e indicações do modo caminhar.
  $('#viewport').insertAdjacentHTML(
    'beforeend',
    '<div id="storey-bar" aria-label="Pavimentos"></div><div id="room-labels"></div><div id="walk-hint" role="status"></div><div id="walk-crosshair"></div>',
  );
  // Controles que só aparecem no modo avançado.
  for (const tab of ['materials', 'details']) $(`[data-tab="${tab}"]`)?.setAttribute('data-advanced', '');
  $$('.tabs > .separator').slice(5).forEach((s) => s.setAttribute('data-advanced', ''));
  hydrate(app);

  const setLevel = (l: UiLevel) => {
    app.dataset.level = l;
    const b = $('#ui-level');
    b.setAttribute('aria-pressed', String(l === 'advanced'));
  };
  setLevel(level);

  return {
    root,
    app,
    viewport: $('#viewport'),
    $,
    $$,
    setLevel,
    dispose: () => root.remove(),
  };
}
