// Ações da seleção, numa lista só (docs/INTERFACE.md): a faixa "Modificar" no
// alto da vista, o menu do botão direito e a busca usam a mesma lista, então
// nunca divergem. Cada ação diz em que grupo fica e o que faz; as que levam
// medida aplicam um valor padrão e deixam a caixa de medidas pronta.
import type { Editor3 } from '../editor/editor';
import type { AlignOp } from '../model/align';
import { BUILTIN_TYPES, family } from '../families/index';
import { icon } from './icons';
import { closeOnOutside } from './kit';

export interface Action {
  id: string;
  label: string;
  icon: string;
  group: string;
  title?: string;
  on?: boolean;
  danger?: boolean;
  run: (anchor?: HTMLElement) => void;
}

const ALIGN: [AlignOp, string, string][] = [
  ['left', 'Esquerda', 'alignLeft'],
  ['centerX', 'Centro X', 'alignCenterX'],
  ['right', 'Direita', 'alignRight'],
  ['front', 'Frente', 'alignFront'],
  ['centerZ', 'Centro Z', 'alignCenterZ'],
  ['back', 'Fundo', 'alignBack'],
];

/** Altura de corte "boa": a divisa de pavimento mais perto do meio do volume (relativa à base). */
function splitHeight(ed: Editor3): number {
  const b = ed.activeBuilding(),
    s = ed.activeSolid();
  if (!b || !s) return 3;
  const mid = s.base + s.height / 2;
  const cuts = b.levels.map((l) => l.elevation).filter((y) => y > s.base + 0.3 && y < s.base + s.height - 0.3);
  const y = cuts.length ? cuts.reduce((a, c) => (Math.abs(c - mid) < Math.abs(a - mid) ? c : a)) : mid;
  return Math.round((y - s.base) * 100) / 100;
}

export function actionsFor(ed: Editor3): Action[] {
  const b = ed.activeBuilding();
  if (!b) return [];
  const out: Action[] = [];
  const add = (group: string, id: string, label: string, ic: string, run: Action['run'], extra: Partial<Action> = {}) => out.push({ group, id, label, icon: ic, run, ...extra });
  const inside = ed.context === b.id;
  const s = ed.activeSolid();
  const multiB = !inside && ed.sel.others.length > 0;
  const multiS = inside && ed.sel.solids.length > 1;

  if (!inside) {
    if (!multiB) add('Edifício', 'enter', 'Editar volumes', 'enter', () => ed.enter(b.id), { title: 'Entrar no edifício (duplo clique)' });
    add('Andares', 'lvup', '+ Andar', 'floorUp', () => ed.floorsDelta(1), { title: 'Um pavimento a mais (o que está em cima sobe junto)' });
    add('Andares', 'lvdown', '− Andar', 'floorDown', () => ed.floorsDelta(-1), { title: 'Um pavimento a menos' });
    add('Editar', 'dup', 'Duplicar', 'copy', () => ed.duplicate(), { title: 'Duplicar · Ctrl+D' });
    add('Editar', 'rot90', 'Girar 90°', 'rotate', () => ed.command('rot90'));
  }
  if (multiB || multiS) {
    for (const [op, label, ic] of ALIGN) add('Alinhar', op, label, ic, () => ed.align(op), { title: `Alinhar ${label.toLowerCase()} (pelo primeiro selecionado)` });
    add('Distribuir', 'distX', 'Em X', 'distX', () => ed.align('distX'), { title: 'Espaços iguais em X' });
    add('Distribuir', 'distZ', 'Em Z', 'distZ', () => ed.align('distZ'), { title: 'Espaços iguais em Z' });
    if (multiS) {
      add('Altura', 'base', 'Mesma base', 'alignFront', () => ed.align('base'));
      add('Altura', 'top', 'Mesmo topo', 'alignBack', () => ed.align('top'));
    }
  }

  if (inside && ed.sel.elems.length && !(ed.sel.item && ed.sel.elems.length <= 1)) {
    const sel = (op: 'row' | 'column' | 'type' | 'face' | 'grow') => () => ed.selectElems(op);
    add('Selecionar', 'row', 'Fileira', 'row', sel('row'), { title: 'O mesmo pavimento em todas as faces' });
    add('Selecionar', 'column', 'Coluna', 'column', sel('column'), { title: 'A mesma prumada em todos os pavimentos' });
    add('Selecionar', 'type', 'Mesmo tipo', 'template', sel('type'));
    add('Selecionar', 'face', 'Face inteira', 'blank', sel('face'));
    add('Regra', 'detach', 'Soltar da regra', 'detach', () => ed.elemAction('detach'), { title: 'Vira peça avulsa no mesmo lugar: move e muda sozinha' });
    add('Regra', 'restore', 'Voltar à regra', 'restore', () => ed.elemAction('restore'));
    add('Editar', 'swap', 'Trocar tipo', 'swap', (a) => swapMenu(ed, a));
    add('Editar', 'removesel', 'Remover', 'trash', () => ed.elemAction('remove'), { danger: true });
    return out;
  }
  if (inside && ed.sel.item) {
    const it = ed.activeItem();
    add('Componente', 'dup', 'Duplicar', 'copy', () => ed.duplicate());
    add('Componente', 'unique', 'Tornar único', 'unique', () => ed.makeUnique(), { title: 'Tipo próprio só para esta ocorrência' });
    if (it?.origin) add('Componente', 'restore', 'Voltar à regra', 'restore', () => ed.elemAction('restore'));
    add('Componente', 'del', 'Excluir', 'trash', () => ed.remove(), { danger: true });
    return out;
  }
  if (inside && s && !multiS) {
    const op = (o: 'add' | 'subtract' | 'intersect', label: string, ic: string, title: string) => add('Operação', `op-${o}`, label, ic, () => ed.command(`op-${o}`), { on: s.op === o, title });
    op('add', 'Somar', 'add', 'Somar ao edifício');
    op('subtract', 'Recortar', 'subtract', 'Recortar o que veio antes (pátios, arcos, nichos)');
    op('intersect', 'Interseção', 'intersect', 'Fica só a parte em comum');
    const side = ed.sel.face?.kind === 'side';
    add('Modelar', 'extrude', 'Extrudar', 'extrude', () => (side ? ed.applyMeasured('Extrudar', 3, (v) => ed.modelOp('extrude', { depth: v })) : (ed.setTool('extrude'), ed.toast('Extrudar: arraste uma face (ou a seta dela) para criar o volume novo.'))), { title: 'Face escolhida vira volume novo (E)' });
    add('Modelar', 'inset', 'Inset', 'inset', () => (side ? ed.applyMeasured('Inset (profundidade)', -0.6, (v) => ed.modelOp('inset-side', { margin: 1, depth: v })) : ed.applyMeasured('Inset do topo', 1, (v) => ed.modelOp('inset-top', { inset: v, depth: 3 }))), { title: 'Na face escolhida: nicho ou saliência; sem face: volume recuado sobre o topo' });
    add('Modelar', 'offset', 'Offset', 'offset', () => ed.applyMeasured('Offset', 1, (v) => ed.modelOp('offset', { d: v })), { title: 'Desloca o contorno todo (negativo encolhe)' });
    add('Modelar', 'split', 'Dividir', 'split', () => ed.applyMeasured('Dividir na altura', splitHeight(ed), (v) => ed.modelOp('split', { y: v })), { title: 'Corta o volume em dois na altura (pavimento mais perto do meio)' });
    add('Modelar', 'bevel', 'Bisel', 'bevel', () => ed.applyMeasured('Bisel', 0.3, (v) => ed.modelOp('bevel', { top: v })), { title: 'Bisel na borda do topo' });
    add('Modelar', 'round', 'Arredondar', 'round', () => ed.applyMeasured('Arredondar cantos', 1, (v) => ed.modelOp('corner', { round: v })), { title: 'Todos os cantos (ou o canto escolhido)' });
    add('Modelar', 'chamfer', 'Chanfrar', 'chamfer', () => ed.applyMeasured('Chanfrar cantos', 0.8, (v) => ed.modelOp('corner', { chamfer: v })), { title: 'Todos os cantos (ou o canto escolhido)' });
    add('Massa', 'setback', 'Recuo no topo', 'setback', () => ed.quick('setback'), { title: 'Pavimento recuado em cima; o de baixo vira terraço' });
    add('Massa', 'podium', 'Embasamento', 'podium', () => ed.quick('podium'), { title: 'Pódio mais largo no térreo, com lojas' });
    add('Massa', 'court', 'Pátio', 'court', () => ed.quick('court'), { title: 'Recorte no meio (pátio interno)' });
    add('Andares', 'lvup', '+ Andar', 'floorUp', () => ed.floorsDelta(1));
    add('Andares', 'lvdown', '− Andar', 'floorDown', () => ed.floorsDelta(-1));
    add('Editar', 'dup', 'Duplicar', 'copy', () => ed.duplicate(), { title: 'Duplicar · Ctrl+D' });
    add('Editar', 'mirror', 'Espelhar', 'mirror', () => ed.command('mirror'));
  }
  if (inside && !s && !ed.sel.item && !ed.sel.elems.length) {
    add('Andares', 'lvup', '+ Andar', 'floorUp', () => ed.floorsDelta(1));
    add('Andares', 'lvdown', '− Andar', 'floorDown', () => ed.floorsDelta(-1));
    add('Edifício', 'exit', 'Sair', 'exit', () => ed.exitContext(), { title: 'Sair do edifício · Esc' });
    return out;
  }
  add('Editar', 'del', 'Excluir', 'trash', () => ed.remove(), { danger: true, title: 'Excluir · Delete' });
  return out;
}

function swapMenu(ed: Editor3, anchor?: HTMLElement): void {
  const types = BUILTIN_TYPES.concat(ed.project.types).filter((t) => family(t.family)?.host === 'face');
  const r = anchor?.getBoundingClientRect();
  popMenu(ed, r ? r.left : 200, r ? r.bottom + 4 : 200, [{ title: 'Trocar por', items: types.map((t) => ({ label: t.name, icon: 'swap', run: () => ed.elemAction('swap', t.id) })) }]);
}

interface MenuItem {
  label: string;
  icon: string;
  run: () => void;
  danger?: boolean;
  on?: boolean;
  title?: string;
}

/** Menu flutuante em grupos com título (menu de contexto e listas das ações). */
function popMenu(ed: Editor3, x: number, y: number, groups: { title: string; items: MenuItem[] }[]): void {
  document.querySelectorAll('.f3-cmenu').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = 'f3-cmenu f3-island';
  m.setAttribute('role', 'menu');
  const flat: MenuItem[] = [];
  m.innerHTML = groups
    .filter((g) => g.items.length)
    .map(
      (g) =>
        `<div class="hd">${g.title}</div>` +
        g.items
          .map((it) => {
            flat.push(it);
            return `<button role="menuitem" data-i="${flat.length - 1}"${it.danger ? ' class="danger"' : ''}${it.on ? ' aria-pressed="true"' : ''}${it.title ? ` title="${it.title}"` : ''}>${icon(it.icon)}<span>${it.label}</span></button>`;
          })
          .join(''),
    )
    .join('');
  ed.shell.root.appendChild(m);
  const rr = ed.shell.root.getBoundingClientRect();
  const w = m.offsetWidth,
    h = m.offsetHeight;
  m.style.left = `${Math.max(4, Math.min(x - rr.left, rr.width - w - 8))}px`;
  m.style.top = `${Math.max(4, Math.min(y - rr.top, rr.height - h - 8))}px`;
  m.querySelectorAll<HTMLButtonElement>('button').forEach((bt) =>
    bt.addEventListener('click', () => {
      m.remove();
      flat[Number(bt.dataset.i)]!.run();
    }),
  );
  closeOnOutside(m, () => m.remove());
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      m.remove();
      window.removeEventListener('keydown', esc, true);
      e.stopPropagation();
    }
  };
  window.addEventListener('keydown', esc, true);
}

/** Agrupa as ações na ordem em que aparecem. */
function grouped(list: Action[]): [string, Action[]][] {
  const g = new Map<string, Action[]>();
  for (const a of list) {
    const arr = g.get(a.group) ?? [];
    arr.push(a);
    g.set(a.group, arr);
  }
  return [...g];
}

/**
 * Faixa "Modificar" no alto da vista (aba contextual do Revit): todas as
 * ações da seleção à vista, com ícone e nome, em grupos. E o menu do botão
 * direito com as mesmas ações do objeto clicado.
 */
export function mountActions(ed: Editor3): void {
  const bar = ed.shell.ctxbar;
  let last = '';
  const render = () => {
    const list = ed.tool === 'paint' || ed.tool === 'tape' || ed.tool === 'rect' || ed.tool === 'circle' || ed.tool === 'polygon' || ed.tool === 'place' ? [] : actionsFor(ed);
    const key = JSON.stringify([ed.tool, list.map((a) => [a.id, a.on])]);
    // A faixa fica sempre no lugar (o layout não pula); sem ações, diz o que fazer.
    bar.hidden = false;
    if (key === last) return;
    last = key;
    if (!list.length) {
      bar.innerHTML = `<span class="empty">${ed.selectLike() || ed.pushLike() ? 'Selecione um edifício, volume ou janela: as ações dele aparecem aqui. Botão direito abre o menu.' : 'Ferramenta em uso; Esc volta para Selecionar.'}</span>`;
      return;
    }
    bar.innerHTML = grouped(list)
      .map(([g, as]) => `<div class="grp"><div class="btns">${as.map((a) => `<button data-a="${a.id}"${a.on !== undefined ? ` aria-pressed="${a.on}"` : ''}${a.danger ? ' class="danger"' : ''} title="${a.title ?? a.label}">${icon(a.icon)}<span>${a.label}</span></button>`).join('')}</div><div class="cap">${g}</div></div>`)
      .join('');
    bar.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((bt) =>
      bt.addEventListener('click', () => {
        const a = actionsFor(ed).find((x) => x.id === bt.dataset.a);
        a?.run(bt);
      }),
    );
  };
  // Quem fica abaixo da faixa (trilha, Vista, aviso) segue a altura real dela (uma ou duas linhas).
  const place = () => ed.shell.root.style.setProperty('--rib', `${bar.offsetHeight}px`);
  new ResizeObserver(place).observe(bar);
  ed.onChange(render);
  render();
  place();
  // Botão direito parado: o menu com as ações do que está sob o cursor (selecionado antes, se preciso).
  ed.contextRequested = (x, y) => {
    const list = actionsFor(ed);
    const head: MenuItem[] = [];
    if (ed.context) head.push({ label: 'Sair do edifício', icon: 'exit', run: () => ed.exitContext() });
    head.push({ label: 'Enquadrar', icon: 'focus', run: () => ed.frameSelection() });
    popMenu(ed, x, y, [...grouped(list).map(([title, as]) => ({ title, items: as.map((a) => ({ label: a.label, icon: a.icon, run: () => a.run(), danger: a.danger, on: a.on, title: a.title })) })), { title: 'Vista', items: head }]);
  };
}
