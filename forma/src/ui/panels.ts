// HTML dos painéis (inspetor, prateleira, camadas, modais). Funções puras que
// recebem um modelo de visão; o editor cuida dos eventos.
import { icon } from './icons';
import type { Lot } from '../core/schema';
import type { LotIndices } from '../core/indices';

export interface VolumeView {
  id: string;
  name: string;
  height: number;
  floors: number;
  base: number;
  area: number;
  width: number;
  depth: number;
  rotation: number;
  color: string;
  trim: string;
  pattern: string;
  windowWidth: number;
  windowHeight: number;
  spacing: number;
  balconies: boolean;
  brise: boolean;
  cornice: boolean;
  garden: boolean;
  pilotis: boolean;
  roof: string;
  roofColor: string;
  roofHeight: number;
}

export interface Defaults {
  shape: string;
  height: number;
  floors: number;
  color: string;
  roof: string;
  width?: number;
  depth?: number;
}

export interface PanelState {
  /** Volume selecionado (o primeiro da seleção) já com os ajustes da face ativa. */
  view: VolumeView | null;
  /** Configuração ativa: a face selecionada (modo Face) ou o volume. */
  faceLabel: string | null;
  selectedCount: number;
  /** Soma das áreas de base da seleção (m²). */
  selectionArea: number;
  defaults: Defaults;
  tool: string;
  tab: string;
  section: boolean;
  repeatCount: number;
  repeatSpace: number;
  /** Lote selecionado (sem edifício selecionado) e seus índices. */
  lot: { lot: Lot; indices: LotIndices | null } | null;
}

export const PALETTES: [string, string][] = [
  ['#b77b56', 'Terracota'],
  ['#d8d1c1', 'Calcário'],
  ['#a9aba5', 'Concreto'],
  ['#4c5558', 'Grafite'],
  ['#a4815a', 'Madeira'],
  ['#e4e1d5', 'Marfim'],
  ['#7b8d81', 'Sálvia'],
  ['#8b6660', 'Argila'],
];

export const ROOFS: [string, string, string][] = [
  ['flat', 'flat', 'Plana'],
  ['shed', 'shed', 'Inclinada'],
  ['gable', 'gable', 'Duas águas'],
  ['dome', 'dome', 'Curva'],
];

export function escapeHTML(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const field = (prop: string, label: string, value: number, step = 0.1, min = 0, max = 100) =>
  `<label>${label}<input type="number" data-prop="${prop}" aria-label="${label}" value="${Number(value).toFixed(step < 1 ? 1 : 0)}" step="${step}" min="${min}" max="${max}"></label>`;

const group = (title: string, content: string, advanced = false) =>
  `<div class="tool-group"${advanced ? ' data-advanced' : ''}><div class="group-title">${title}</div>${content}</div>`;

function swatches(color: string, large: boolean): string {
  return PALETTES.slice(0, large ? 8 : 5)
    .map(([c, name]) => {
      const b = `<button class="swatch ${color === c ? 'active' : ''}" data-color="${c}" title="${name}" aria-label="${name}" style="background:${c};--swatch:${c}"></button>`;
      return large ? `<div class="material-option">${b}<span class="material-name">${name}</span></div>` : b;
    })
    .join('');
}

export function inspectorHTML(s: PanelState): string {
  const v = s.view;
  if (!v && s.lot) return lotInspectorHTML(s.lot.lot, s.lot.indices);
  if (!v)
    return `<div class="inspector-title">Espaço de criação</div><div id="empty-inspector">Desenhe uma base no chão.<br>Puxe para criar a altura.<br>Selecione uma face para personalizar.</div><div class="inspector-foot"><span>Seleção direta</span><button data-tool="draw" data-icon="rect" title="Criar volume" aria-label="Criar volume"></button></div>`;
  const info = s.selectedCount > 1 ? `${s.selectedCount} volumes` : s.faceLabel ?? 'Volume completo';
  return `<div class="inspector-title"><input data-prop="name" aria-label="Nome do volume" value="${escapeHTML(v.name)}"><button data-action="delete" data-icon="trash" title="Excluir seleção" aria-label="Excluir seleção"></button></div>
<div class="inspector-body">
<div class="row"><label for="height-input">Altura</label><input id="height-input" type="number" data-prop="height" aria-label="Altura" step=".1" min=".5" max="100" value="${v.height.toFixed(1)}"></div>
<div class="row"><label for="floors-input">Andares</label><input id="floors-input" type="number" data-prop="floors" aria-label="Andares" min="1" max="30" step="1" value="${v.floors}"></div>
<div class="row"><label for="base-input">Elevação</label><input id="base-input" type="number" data-prop="base" aria-label="Elevação" min="0" max="100" step=".1" value="${v.base.toFixed(1)}"></div>
<div class="rule"></div><div class="caption">Material${s.faceLabel ? ' da face' : ''}</div><div class="swatches">${swatches(v.color, false)}</div>
<div class="rule"></div><div class="caption">Cobertura</div>
<div class="roof-mini">${ROOFS.map(([id, ic, label]) => `<button data-roof="${id}" class="${v.roof === id ? 'active' : ''}" title="${label}" aria-label="Cobertura ${label}" data-icon="${ic}"></button>`).join('')}</div>
<div class="roof-labels">${ROOFS.map((r) => `<span>${r[2]}</span>`).join('')}</div></div>
<div class="inspector-foot"><span id="selection-info">${info} · ${Math.round(s.selectionArea).toLocaleString('pt-BR')} m²</span><button data-action="floor" data-icon="extrude" title="Adicionar andar" aria-label="Adicionar andar"></button></div>`;
}

export function shelfHTML(s: PanelState): string {
  const v = s.view,
    d = s.defaults;
  let html = '';
  if (s.tab === 'lot') return lotShelfHTML(s);
  if (s.tab === 'volumes') {
    const shapes: [string, string, string][] = [['rect', 'rect', 'Retângulo'], ['l', 'l', 'L'], ['u', 'u', 'U'], ['circle', 'circle', 'Circular'], ['polygon', 'polygon', 'Livre']];
    html += group(
      'Formas básicas',
      `<div class="tool-row">${shapes.map(([id, ic, name]) => `<button class="shape-tool ${d.shape === id && ['draw', 'polygon'].includes(s.tool) ? 'active' : ''}" data-shape="${id}" data-icon="${ic}" title="Desenhar ${name}">${name}</button>`).join('')}</div>`,
    );
    const w = v ? v.width : (d.width ?? 10),
      dep = v ? v.depth : (d.depth ?? 8);
    html += group(
      v ? 'Dimensões da seleção' : 'Próximo volume',
      `<div class="field-col"><div class="field-row">${field('width', 'Largura', w, 0.5, 0.5, 100)}${field('height', 'Altura', v ? v.height : d.height, 0.1, 0.5, 100)}</div><div class="field-row">${field('depth', 'Profund.', dep, 0.5, 0.5, 100)}${field('floors', 'Andares', v ? v.floors : d.floors, 1, 1, 30)}</div></div>`,
    );
    html += group(
      'Composição',
      `<div class="field-col"><div class="tool-row"><button data-action="setback" class="action-tool" data-icon="setback">Recuo</button><button data-tool="editpoints" class="action-tool ${s.tool === 'editpoints' ? 'active' : ''}" data-icon="vertices">Vértices</button></div><div class="tool-row"><button data-action="mirror" class="action-tool" data-icon="mirror">Espelhar</button><button data-action="union" class="action-tool" data-icon="union">Unir</button><button data-action="group" class="action-tool" data-icon="layers" data-advanced title="Junta volumes empilhados num só edifício com vários pavimentos">Agrupar</button></div></div>`,
    );
    html += group(
      'Repetição',
      `<div class="field-col"><div class="field-row"><label>Qtd.<input id="repeat-count" aria-label="Quantidade de cópias" type="number" value="${s.repeatCount}" min="1" max="12" step="1"></label><label>Intervalo<input id="repeat-space" aria-label="Intervalo entre cópias" type="number" value="${s.repeatSpace}" min="0" max="30" step=".5"></label></div><div class="tool-row"><button data-action="repeat" class="action-tool" data-icon="copy">Repetir volumes</button></div></div>`,
      true,
    );
  } else if (s.tab === 'facades') {
    const patterns: [string, string, string][] = [['regular', 'window', 'Ritmada'], ['storefront', 'loja', 'Loja'], ['curtain', 'window', 'Vidro'], ['blank', 'blank', 'Cega'], ['arched', 'dome', 'Arcos']];
    const pattern = v?.pattern ?? 'regular';
    html += group('Distribuição', `<div class="tool-row">${patterns.map(([id, ic, name]) => `<button class="shape-tool ${pattern === id ? 'active' : ''}" data-facade="${id}" data-icon="${ic}">${name}</button>`).join('')}</div>`);
    html += group(
      'Desenhar na parede',
      `<div class="tool-row">${[['window', 'window', 'Janela'], ['door', 'door', 'Porta'], ['opening', 'blank', 'Vão']].map(([id, ic, name]) => `<button class="shape-tool ${s.tool === id ? 'active' : ''}" data-tool="${id}" data-icon="${ic}">${name}</button>`).join('')}</div>`,
    );
    html += group(
      'Ritmo e proporção',
      `<div class="field-col"><div class="field-row">${field('windowWidth', 'Largura', v?.windowWidth ?? 1.35, 0.1, 0.3, 5)}${field('windowHeight', 'Altura', v?.windowHeight ?? 1.8, 0.1, 0.3, 4)}</div><div class="field-row">${field('spacing', 'Intervalo', v?.spacing ?? 2.5, 0.1, 1, 8)}<button data-action="apply-face-all" class="action-tool">Aplicar ao volume</button></div></div>`,
      true,
    );
    html += group('Edição contextual', `<div class="help-inline">No modo Face, as alterações afetam somente a parede selecionada. Desenhar uma abertura substitui o ritmo automático dessa face.</div>`);
  } else if (s.tab === 'roofs') {
    const roof = v?.roof ?? d.roof;
    html += group('Forma da cobertura', `<div class="tool-row">${ROOFS.map(([id, ic, name]) => `<button class="roof-tool ${roof === id ? 'active' : ''}" data-roof="${id}" data-icon="${ic}">${name}</button>`).join('')}</div>`);
    html += group(
      'Perfil',
      `<div class="field-col"><div class="field-row">${field('roofHeight', 'Elevação', v ? v.roofHeight : 2.3, 0.1, 0.2, 10)}</div><div class="field-row"><label>Cor<input type="color" data-prop="roofColor" aria-label="Cor da cobertura" value="${v ? v.roofColor : '#474c4e'}"></label><button class="toggle-button ${v?.garden ? 'active' : ''}" data-toggle="garden" data-icon="tree">Jardim</button></div></div>`,
      true,
    );
    html += group(
      'Terraços e níveis',
      `<div class="field-col"><button data-action="setback" class="action-tool" data-icon="setback">Criar volume recuado</button><button data-action="floor" class="action-tool" data-icon="extrude">Adicionar andar</button></div>`,
    );
  } else if (s.tab === 'materials') {
    html += group(s.faceLabel ? 'Material da face selecionada' : 'Material do volume', `<div class="palette">${swatches(v?.color ?? d.color, true)}</div>`);
    html += group(
      'Personalizar',
      `<div class="field-col"><div class="field-row"><label>Parede<input type="color" data-prop="color" aria-label="Cor da parede" value="${v?.color ?? d.color}"></label><label>Caixilho<input type="color" data-prop="trim" aria-label="Cor dos caixilhos" value="${v?.trim ?? '#383e40'}"></label></div><div class="field-row"><label>Cobertura<input type="color" data-prop="roofColor" aria-label="Cor da cobertura" value="${v ? v.roofColor : '#474c4e'}"></label></div></div>`,
    );
    html += group('Aplicação', `<div class="help-inline">Escolha Objeto para alterar o conjunto ou Face para dar acabamento a uma parede específica.</div>`);
  } else if (s.tab === 'details') {
    const toggles: [keyof VolumeView, string, string][] = [['balconies', 'balcony', 'Varandas'], ['brise', 'brise', 'Brises'], ['cornice', 'cornice', 'Cornijas'], ['garden', 'tree', 'Jardim'], ['pilotis', 'pillar', 'Pilotis']];
    html += group('Elementos paramétricos', `<div class="tool-row">${toggles.map(([id, ic, name]) => `<button class="shape-tool ${v && v[id] ? 'active' : ''}" data-toggle="${id}" data-icon="${ic}">${name}</button>`).join('')}</div>`);
    html += group(
      'Transformar',
      `<div class="field-col"><div class="field-row">${field('rotation', 'Rotação', v ? v.rotation : 0, 15, -360, 360)}${field('base', 'Elevação', v ? v.base : 0, 0.1, 0, 100)}</div><div class="tool-row"><button data-action="mirror" class="action-tool" data-icon="mirror">Espelhar</button><button data-tool="editpoints" class="action-tool" data-icon="vertices">Editar base</button></div></div>`,
    );
    html += group(
      'Inspeção',
      `<div class="field-col"><button data-action="section" class="action-tool ${s.section ? 'active' : ''}" data-icon="section">Corte horizontal</button><button data-action="duplicate" class="action-tool" data-icon="copy">Duplicar seleção</button></div>`,
    );
  }
  return html;
}

export function layersHTML(items: { id: string; name: string; floors: number; selected: boolean }[]): string {
  return `<div class="layer-head">Volumes · ${items.length}</div>${items
    .map((v) => `<button class="layer-row ${v.selected ? 'active' : ''}" data-select="${v.id}">${icon('cube')}<span>${escapeHTML(v.name)}</span><small>${v.floors} and.</small></button>`)
    .join('')}`;
}

const fmt = (n: number, d = 1) => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: number) => fmt(n * 100, 0) + '%';

/** Linhas de índice: valor atual, limite e situação. */
function indexRows(lot: Lot, ix: LotIndices | null): string {
  if (!ix) return '';
  const r = lot.rules;
  const bad = new Set(ix.violations.map((v) => v.kind));
  const row = (label: string, value: string, limit: string | null, kind: string) =>
    `<div class="index-row ${bad.has(kind as never) ? 'bad' : ''}"><span>${label}</span><b>${value}${limit ? ' <small>/ ' + limit + '</small>' : ''}</b></div>`;
  return [
    row('Área do lote', fmt(ix.lotArea, 0) + ' m²', null, ''),
    row('Ocupação', pct(ix.occupancy), r?.maxOccupancy !== undefined ? pct(r.maxOccupancy) : null, 'occupancy'),
    row('Coeficiente', fmt(ix.far, 2), r?.maxFAR !== undefined ? fmt(r.maxFAR, 2) : null, 'far'),
    row('Altura', fmt(ix.height) + ' m', r?.maxHeight !== undefined ? fmt(r.maxHeight) + ' m' : null, 'height'),
    row('Pavimentos', String(ix.storeys), r?.maxStoreys !== undefined ? String(r.maxStoreys) : null, 'storeys'),
    row('Permeabilidade', pct(ix.permeability), r?.minPermeability !== undefined ? 'mín. ' + pct(r.minPermeability) : null, 'permeability'),
  ].join('');
}

function violationList(ix: LotIndices | null, max = 3): string {
  if (!ix?.violations.length) return '<div class="index-ok">Dentro das regras do lote.</div>';
  const items = ix.violations.slice(0, max).map((v) => `<li>${escapeHTML(v.message)}</li>`).join('');
  const more = ix.violations.length > max ? `<li>+ ${ix.violations.length - max} outra(s)</li>` : '';
  return `<ul class="index-bad">${items}${more}</ul>`;
}

export function lotInspectorHTML(lot: Lot, ix: LotIndices | null): string {
  return `<div class="inspector-title"><input data-lotprop="name" aria-label="Nome do lote" value="${escapeHTML(lot.name)}"><button data-lotaction="delete" data-icon="trash" title="Excluir lote" aria-label="Excluir lote"></button></div>
<div class="inspector-body lot-body">${indexRows(lot, ix)}<div class="rule"></div>${violationList(ix)}</div>
<div class="inspector-foot"><span>Lote · ${lot.rules?.enforcement === 'block' ? 'regras bloqueiam' : 'regras avisam'}</span><button data-lotaction="fill" data-icon="fill" title="Preencher lote" aria-label="Preencher lote"></button></div>`;
}

const lotField = (prop: string, label: string, value: number | undefined, step: number, min: number, max: number, unit = '') =>
  `<label>${label}${unit ? ' (' + unit + ')' : ''}<input type="number" data-lotprop="${prop}" aria-label="${label}" value="${value === undefined ? '' : Number(value).toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0)}" step="${step}" min="${min}" max="${max}" placeholder="—"></label>`;

export function lotShelfHTML(s: PanelState): string {
  const tools = `<div class="tool-row">${[
    ['lot', 'lot', 'Retângulo'],
    ['lotpolygon', 'polygon', 'Livre'],
    ['frontage', 'front', 'Testada'],
  ]
    .map(([id, ic, name]) => `<button class="shape-tool ${s.tool === id ? 'active' : ''}" data-tool="${id}" data-icon="${ic}">${name}</button>`)
    .join('')}<button class="shape-tool" data-lotaction="fill" data-icon="fill">Preencher</button></div>`;
  let html = group('Lote', tools);
  const sel = s.lot;
  if (!sel) return html + group('Como usar', '<div class="help-inline">Desenhe um lote no chão ou clique num lote existente para ver recuos, limites e índices.</div>');
  const r = sel.lot.rules;
  html += group(
    'Recuos',
    `<div class="field-col"><div class="field-row">${lotField('front', 'Frontal', r?.setbacks.front, 0.5, 0, 50, 'm')}${lotField('side', 'Lateral', r?.setbacks.side, 0.5, 0, 50, 'm')}</div><div class="field-row">${lotField('back', 'Fundos', r?.setbacks.back, 0.5, 0, 50, 'm')}</div></div>`,
  );
  html += group(
    'Limites',
    `<div class="field-col"><div class="field-row">${lotField('maxOccupancy', 'Ocupação', r?.maxOccupancy === undefined ? undefined : r.maxOccupancy * 100, 1, 0, 100, '%')}${lotField('maxFAR', 'Coeficiente', r?.maxFAR, 0.1, 0, 20)}${lotField('maxHeight', 'Gabarito', r?.maxHeight, 0.5, 0, 300, 'm')}</div><div class="field-row">${lotField('maxStoreys', 'Pavimentos', r?.maxStoreys, 1, 1, 100)}${lotField('minPermeability', 'Permeável', r?.minPermeability === undefined ? undefined : r.minPermeability * 100, 1, 0, 100, '%')}</div></div>`,
  );
  html += group(
    'Regras',
    `<div class="field-col"><div class="tool-row"><button class="action-tool ${r?.enforcement !== 'block' ? 'active' : ''}" data-lotmode="warn">Avisar</button><button class="action-tool ${r?.enforcement === 'block' ? 'active' : ''}" data-lotmode="block">Bloquear</button></div><div class="field-row" data-advanced><label>Gabarito até<select data-lotprop="heightTo" aria-label="Gabarito medido até"><option value="ridge" ${r?.heightTo !== 'eave' ? 'selected' : ''}>a cumeeira</option><option value="eave" ${r?.heightTo === 'eave' ? 'selected' : ''}>o beiral</option></select></label></div></div>`,
  );
  return html;
}

export const NEW_HTML = `<div class="modal-head"><h2>Novo espaço de criação</h2><button data-modal="close" data-icon="close" aria-label="Fechar"></button></div><p>Salve o projeto atual se quiser guardá-lo antes de começar outro. Um mapa vazio permite desenhar sua própria construção.</p><div class="modal-footer"><button class="secondary" data-modal="close">Cancelar</button><button class="primary" data-modal="empty">Criar mapa vazio</button></div>`;

export function helpHTML(): string {
  return `<div class="modal-head"><h2>Construa com as mãos.</h2><button data-modal="close" data-icon="close" aria-label="Fechar"></button></div><div class="help-grid"><div><strong>${icon('rect')} Desenhe a base</strong><kbd>B</kbd> e arraste no chão. Escolha L, U ou circular. <kbd>P</kbd> desenha um contorno livre; Enter fecha.</div><div><strong>${icon('extrude')} Puxe e componha</strong>Arraste a alça vertical. Os pontos nos cantos alteram a base. Desenhe no topo para empilhar volumes.</div><div><strong>${icon('window')} Edite a fachada</strong>Escolha Face, clique na parede e altere ritmo, proporção ou material. Arraste Janela, Porta ou Vão sobre ela.</div><div><strong>${icon('cut')} Abra um pátio</strong>Selecione o volume, pressione <kbd>C</kbd> e desenhe o recorte. A subtração também pode dividir o volume.</div><div><strong>${icon('cursor')} Navegue</strong>Botão direito orbita. Shift + direito desloca. Scroll aproxima. No toque, dois dedos orbitam e aproximam.</div><div><strong>${icon('save')} Continue e exporte</strong>Salvamento local automático. Salvar baixa o projeto JSON. Exportar GLB preserva geometria e materiais.</div></div><p><kbd>V</kbd> selecionar · <kbd>G</kbd> mover · <kbd>E</kbd> puxar · <kbd>F</kbd> enquadrar · Ctrl+clique multisseleciona · Ctrl+D duplica · Ctrl+Z desfaz · Esc cancela. O botão Modo avançado mostra todos os controles.</p><div class="modal-footer"><button class="secondary" data-modal="example">Carregar exemplo</button><button class="primary" data-modal="close">Continuar criando</button></div>`;
}

// ── Interiores ────────────────────────────────────────────────────────
export interface InteriorState {
  /** Pavimentos do edifício selecionado e o ativo. */
  storeys: { id: string; name: string; height: number; rooms: { id: string; name: string; area: number }[] }[];
  activeStoreyId: string | null;
  tool: string;
  wallThickness: number;
  stairWidth: number;
}

/** Barra de pavimentos no canto da vista (só com um edifício selecionado). */
export function storeyBarHTML(s: InteriorState | null): string {
  if (!s || !s.storeys.length) return '';
  const items = [...s.storeys].reverse();
  return `<button class="storey-btn ${s.activeStoreyId ? '' : 'active'}" data-storey="" title="Mostrar o edifício inteiro">Todos</button>${items
    .map((st) => `<button class="storey-btn ${st.id === s.activeStoreyId ? 'active' : ''}" data-storey="${st.id}" title="Ver e editar o interior de ${escapeHTML(st.name)}">${escapeHTML(st.name)}</button>`)
    .join('')}`;
}

export function interiorShelfHTML(s: InteriorState | null): string {
  if (!s) return group('Interior', '<div class="help-inline">Selecione um edifício e escolha um pavimento na barra à esquerda da vista para desenhar paredes, portas e escadas.</div>');
  const active = s.storeys.find((x) => x.id === s.activeStoreyId);
  const tools = [
    ['wall', 'wall', 'Parede'],
    ['idoor', 'door', 'Porta'],
    ['stair', 'stair', 'Escada'],
    ['room', 'cube', 'Cômodo'],
  ];
  let html = group(
    'Desenhar',
    `<div class="tool-row">${tools.map(([id, ic, name]) => `<button class="shape-tool ${s.tool === id ? 'active' : ''}" data-tool="${id}" data-icon="${ic}" ${active ? '' : 'disabled'}>${name}</button>`).join('')}<button class="shape-tool" data-interior="walk" data-icon="walk">Caminhar</button></div>`,
  );
  if (!active)
    return html + group('Pavimento', `<div class="help-inline">Escolha um pavimento na barra à esquerda da vista.</div><div class="tool-row"><button class="action-tool" data-storey="${s.storeys[0]?.id ?? ''}" data-icon="level">Entrar no térreo</button></div>`);
  html += group(
    'Pavimento',
    `<div class="field-col"><div class="field-row"><label>Nome<input data-storeyprop="name" aria-label="Nome do pavimento" value="${escapeHTML(active.name)}" maxlength="40"></label></div><div class="field-row"><label>Pé-direito (m)<input type="number" data-storeyprop="height" aria-label="Pé-direito" value="${active.height.toFixed(2)}" step=".05" min="2" max="12"></label><button class="action-tool" data-interior="plan" data-icon="top">Planta</button></div></div>`,
  );
  html += group(
    'Medidas',
    `<div class="field-col"><div class="field-row"><label>Parede (m)<input type="number" data-interiorprop="wallThickness" aria-label="Espessura das paredes novas" value="${s.wallThickness.toFixed(2)}" step=".01" min=".05" max="1"></label></div><div class="field-row"><label>Escada (m)<input type="number" data-interiorprop="stairWidth" aria-label="Largura das escadas novas" value="${s.stairWidth.toFixed(2)}" step=".05" min=".6" max="3"></label></div></div>`,
  );
  const rooms = active.rooms;
  html += group(
    `Cômodos · ${rooms.length}`,
    rooms.length
      ? `<div class="room-list">${rooms.map((r) => `<label class="room-row"><input data-room="${r.id}" aria-label="Nome do cômodo" value="${escapeHTML(r.name)}" maxlength="40"><small>${fmt(r.area, 1)} m²</small></label>`).join('')}</div>`
      : '<div class="help-inline">Desenhe paredes para dividir o pavimento em cômodos.</div>',
  );
  return html;
}

export function wallInspectorHTML(w: { length: number; thickness: number; doors: number }): string {
  return `<div class="inspector-title"><span class="inspector-heading">Parede interna</span><button data-interior="delete-wall" data-icon="trash" title="Excluir parede" aria-label="Excluir parede"></button></div>
<div class="inspector-body"><div class="row"><label>Comprimento</label><b>${fmt(w.length, 2)} m</b></div><div class="row"><label for="wall-thickness">Espessura</label><input id="wall-thickness" type="number" data-wallprop="thickness" aria-label="Espessura" value="${w.thickness.toFixed(2)}" step=".01" min=".05" max="1"></div><div class="row"><label>Portas</label><b>${w.doors}</b></div></div>
<div class="inspector-foot"><span>Arraste as pontas para mover</span><button data-tool="idoor" data-icon="door" title="Desenhar porta" aria-label="Desenhar porta"></button></div>`;
}

export function roomInspectorHTML(r: { name: string; area: number; walls: number }): string {
  return `<div class="inspector-title"><input data-roomprop="name" aria-label="Nome do cômodo" value="${escapeHTML(r.name)}" maxlength="40"></div>
<div class="inspector-body"><div class="row"><label>Área</label><b>${fmt(r.area, 1)} m²</b></div><div class="row"><label>Paredes internas</label><b>${r.walls}</b></div></div>
<div class="inspector-foot"><span>Cômodo</span></div>`;
}

export function stairInspectorHTML(st: { width: number; from: string; to: string }): string {
  return `<div class="inspector-title"><span class="inspector-heading">Escada</span><button data-interior="delete-stair" data-icon="trash" title="Excluir escada" aria-label="Excluir escada"></button></div>
<div class="inspector-body"><div class="row"><label>Largura</label><b>${fmt(st.width, 2)} m</b></div><div class="row"><label>De</label><b>${escapeHTML(st.from)}</b></div><div class="row"><label>Até</label><b>${escapeHTML(st.to)}</b></div></div>
<div class="inspector-foot"><span>Escada</span></div>`;
}
