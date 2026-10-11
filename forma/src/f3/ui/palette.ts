// Busca de comandos (Ctrl+K), como a do Shapr3D e a paleta do VS Code/Figma:
// qualquer ferramenta, ação, bloco, componente ou seção do inspetor pelo nome.
import type { Editor3, Tool } from '../editor/editor';
import { BLOCKS } from '../model/blocks';
import { BUILTIN_TYPES, family } from '../families/index';
import { CATEGORY_NAMES } from '../families/family';
import { icon } from './icons';

interface Cmd {
  label: string;
  group: string;
  ic: string;
  key?: string;
  run(): void;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function mountPalette(ed: Editor3): void {
  const root = ed.shell.root;
  const top = (cmd: string) => (ed.topCommand?.(cmd) ? undefined : ed.command(cmd));
  /** Abre o inspetor na seção pedida (ferramentas com campos). */
  const section = (title: string) => () => {
    ed.shell.aside.classList.remove('min');
    ed.shell.tabs.querySelector<HTMLButtonElement>('[data-tab="props"]')?.click();
    const h = [...ed.shell.side.querySelectorAll<HTMLElement>('.f3-sec>h3')].find((x) => (x.textContent ?? '').trim().startsWith(title));
    if (!h) return ed.toast(`Selecione um volume para usar "${title}".`);
    const sec = h.parentElement!;
    if (sec.classList.contains('closed')) h.click();
    sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const commands = (): Cmd[] => {
    const tool = (t: Tool, label: string, ic: string, key: string): Cmd => ({ label, group: 'Ferramenta', ic, key, run: () => ed.setTool(t) });
    const list: Cmd[] = [
      tool('select', 'Selecionar e mover', 'cursor', 'V'),
      tool('push', 'Empurrar / puxar face', 'push', 'P'),
      tool('rect', 'Desenhar retângulo', 'rect', 'R'),
      tool('circle', 'Desenhar círculo', 'circle', 'C'),
      tool('polygon', 'Desenhar polígono', 'polygon', 'L'),
      tool('paint', 'Pintar', 'paint', 'B'),
      tool('tape', 'Trena e cotas', 'tape', 'T'),
      { label: 'Biblioteca', group: 'Ferramenta', ic: 'catalog', key: 'K', run: () => ed.toggleLibrary(true) },
      { label: 'Desfazer', group: 'Editar', ic: 'undo', key: 'Ctrl Z', run: () => ed.command('undo') },
      { label: 'Refazer', group: 'Editar', ic: 'redo', key: 'Ctrl Y', run: () => ed.command('redo') },
      { label: 'Duplicar seleção', group: 'Editar', ic: 'copy', key: 'Ctrl D', run: () => ed.duplicate() },
      { label: 'Excluir seleção', group: 'Editar', ic: 'trash', key: 'Del', run: () => ed.remove() },
      { label: 'Espelhar volume', group: 'Editar', ic: 'mirror', run: () => ed.command('mirror') },
      { label: 'Enquadrar', group: 'Vista', ic: 'focus', key: 'F', run: () => ed.frameSelection() },
      { label: 'Encaixe ligado/desligado', group: 'Vista', ic: 'magnet', key: 'G', run: () => ed.toggleSnap() },
      { label: 'Extrudar face', group: 'Modelar', ic: 'extrude', run: section('Face selecionada') },
      { label: 'Inset da face / do topo', group: 'Modelar', ic: 'inset', run: section('Face selecionada') },
      { label: 'Offset do contorno', group: 'Modelar', ic: 'offset', run: section('Modificar') },
      { label: 'Dividir volume na altura', group: 'Modelar', ic: 'split', run: section('Modificar') },
      { label: 'Bisel das arestas', group: 'Modelar', ic: 'bevel', run: section('Modificar') },
      { label: 'Frisos, cornija e rodapé', group: 'Modelar', ic: 'cornice', run: section('Frisos e cornija') },
      { label: 'Cobertura (telhado)', group: 'Modelar', ic: 'gable', run: section('Cobertura') },
      { label: 'Regras de fachada', group: 'Modelar', ic: 'window', run: section('Fachada') },
      { label: 'Novo projeto', group: 'Projeto', ic: 'folder', run: () => top('new') },
      { label: 'Abrir projeto', group: 'Projeto', ic: 'open', run: () => top('open') },
      { label: 'Salvar projeto', group: 'Projeto', ic: 'save', key: 'Ctrl S', run: () => top('save') },
      { label: 'Exportar', group: 'Projeto', ic: 'export', run: () => top('export') },
      { label: 'Modelos prontos', group: 'Projeto', ic: 'template', run: () => top('templates') },
      { label: 'Atalhos', group: 'Ajuda', ic: 'help', key: '?', run: () => top('help') },
    ];
    for (const b of BLOCKS) list.push({ label: b.name, group: 'Bloco', ic: b.icon, run: () => ed.startBlock(b.id) });
    for (const t of [...BUILTIN_TYPES, ...ed.project.types.filter((x) => x.user)]) {
      const f = family(t.family);
      if (f) list.push({ label: t.name, group: CATEGORY_NAMES[f.category], ic: 'catalog', run: () => ed.startPlacing(t.id) });
    }
    return list;
  };

  let modal: HTMLElement | null = null;
  const close = () => {
    modal?.remove();
    modal = null;
    ed.view.renderer.domElement.focus();
  };
  ed.paletteRequested = () => {
    if (modal) return close();
    const all = commands();
    modal = document.createElement('div');
    modal.className = 'f3-modal';
    modal.innerHTML = `<div class="f3-pal" role="dialog" aria-label="Buscar comandos"><input placeholder="Buscar ferramenta, comando, bloco ou componente…" aria-label="Buscar"><ul role="listbox"></ul></div>`;
    root.appendChild(modal);
    const input = modal.querySelector('input')!;
    const ul = modal.querySelector('ul')!;
    let shown: Cmd[] = [];
    let cur = 0;
    const draw = () => {
      const q = norm(input.value.trim());
      const words = q.split(/\s+/).filter(Boolean);
      shown = all.filter((c) => words.every((w) => norm(`${c.label} ${c.group}`).includes(w))).slice(0, 60);
      cur = Math.min(cur, Math.max(0, shown.length - 1));
      ul.innerHTML = shown.length
        ? shown.map((c, i) => `<li role="option" data-i="${i}" aria-selected="${i === cur}">${icon(c.ic)}<span>${c.label}</span><em>${c.group}</em>${c.key ? `<small><kbd>${c.key}</kbd></small>` : ''}</li>`).join('')
        : '<li aria-disabled="true"><span style="color:var(--faint)">Nada encontrado.</span></li>';
      ul.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
    };
    const run = (i: number) => {
      const c = shown[i];
      if (!c) return;
      close();
      c.run();
    };
    input.addEventListener('input', () => {
      cur = 0;
      draw();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') cur = Math.min(shown.length - 1, cur + 1);
      else if (e.key === 'ArrowUp') cur = Math.max(0, cur - 1);
      else if (e.key === 'Enter') return run(cur);
      else if (e.key === 'Escape') return close();
      else return;
      e.preventDefault();
      draw();
    });
    ul.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
      if (li) run(Number(li.dataset.i));
    });
    modal.addEventListener('pointerdown', (e) => {
      if (e.target === modal) close();
    });
    draw();
    input.focus();
  };

  ed.helpRequested = () => {
    const m = document.createElement('div');
    m.className = 'f3-modal';
    const k = (keys: string, what: string) => `<span>${keys.split(' ').map((x) => `<kbd>${x}</kbd>`).join(' ')}</span><span>${what}</span>`;
    m.innerHTML = `<div class="f3-help" role="dialog" aria-label="Atalhos"><h2>Atalhos</h2><div class="cols">
      <div class="f3-keys" style="margin:0"><h3>Ferramentas</h3>${k('V', 'Selecionar (tudo na seleção)')}${k('M', 'Mover')}${k('Q', 'Girar')}${k('S', 'Escala e tamanho')}${k('P', 'Empurrar face')}${k('E', 'Extrudar face')}${k('R', 'Retângulo')}${k('C', 'Círculo')}${k('L', 'Polígono')}${k('X', 'Somar / recortar')}${k('K', 'Biblioteca')}${k('B', 'Pintar (Alt: conta-gotas)')}${k('T', 'Trena e cotas')}</div>
      <div class="f3-keys" style="margin:0"><h3>Comandos</h3>${k('Ctrl K', 'Buscar comandos')}${k('Ctrl Z', 'Desfazer')}${k('Ctrl Y', 'Refazer')}${k('Ctrl D', 'Duplicar')}${k('Del', 'Excluir')}${k('F', 'Enquadrar')}${k('G', 'Encaixe')}${k('Esc', 'Sair / cancelar')}${k('10x8', 'Medidas (digite e Enter)')}${k('5x 5/', 'Repetir / dividir cópias')}</div>
      <div class="f3-keys" style="margin:0"><h3>Seleção</h3>${k('Ctrl clique', 'Soma à seleção')}${k('Shift clique', 'Alterna (põe ou tira)')}${k('Ctrl Shift clique', 'Tira da seleção')}${k('Alt clique', 'Trecho da fileira até aqui')}${k('Arrastar →', 'Caixa: só o que fica inteiro')}${k('Arrastar ←', 'Caixa: tudo o que ela toca')}${k('Ctrl arrastar', 'Copiar o que está selecionado')}${k('← → ↑ ↓', 'Andar com a seleção na fachada')}${k('Botão direito', 'Menu com as ações do objeto')}</div>
    </div><p class="f3-empty" style="padding:12px 0 0">Botão direito: clique abre o menu, arrastar gira a vista. Botão do meio desloca, roda aproxima. Duplo clique entra num edifício.</p></div>`;
    root.appendChild(m);
    const close = () => m.remove();
    m.addEventListener('pointerdown', (e) => e.target === m && close());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        close();
        window.removeEventListener('keydown', onKey, true);
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
  };
}
