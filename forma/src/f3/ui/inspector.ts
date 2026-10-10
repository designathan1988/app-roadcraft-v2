// Inspetor contextual: mostra só o que vale para a seleção (edifício, volume,
// face, componente ou componente de regra). Cada campo grava ao mudar.
import type { Editor3 } from '../editor/editor';
import type { Building3, FacadeRule, RoofKind, Solid } from '../model/schema';
import { findSolid } from '../model/ops';
import { levelsFor, facadeRule, uid } from '../model/defaults';
import { FINISHES } from '../render/finishes';
import { allFamilies, family, typeById, BUILTIN_TYPES } from '../families/index';
import { resolveParams, type ParamDef } from '../families/family';
import { icon } from './icons';

const ROOFS: [RoofKind, string, string][] = [
  ['flat', 'Plano', 'flat'],
  ['terrace', 'Terraço', 'terrace'],
  ['shed', 'Uma água', 'shed'],
  ['gable', 'Duas águas', 'gable'],
  ['hip', 'Quatro águas', 'hip'],
  ['mansard', 'Mansarda', 'mansard'],
  ['gambrel', 'Holandês', 'gambrel'],
  ['pyramid', 'Pirâmide', 'pyramid'],
  ['dome', 'Cúpula', 'dome'],
  ['vault', 'Abóbada', 'vault'],
  ['sawtooth', 'Shed fabril', 'sawtooth'],
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');
const parse = (s: string) => parseFloat(s.replace(',', '.'));

function field(key: string, label: string, value: number, step = 0.1, extra = ''): string {
  return `<label class="f3-field"><span>${label}</span><input data-k="${key}" inputmode="decimal" value="${num(value)}" data-step="${step}" ${extra}></label>`;
}

function finishSelect(key: string, label: string, ref: { finish: string; color: string }): string {
  return `<div class="f3-sw"><span>${label}</span><input type="color" data-k="${key}.color" value="${ref.color}"><select data-k="${key}.finish">${FINISHES.map((f) => `<option value="${f.id}" ${f.id === ref.finish ? 'selected' : ''}>${f.name}</option>`).join('')}</select></div>`;
}

export function mountInspector(ed: Editor3): void {
  const side = ed.shell.side;
  let lastKey = '';
  const render = () => {
    const b = ed.activeBuilding();
    const key = JSON.stringify([ed.sel, ed.context, b && ed.store.revision.get(b.id), ed.project.types.length]);
    // Não redesenha enquanto o usuário digita num campo.
    if (key === lastKey && side.contains(document.activeElement)) return;
    lastKey = key;
    if (!b) return void (side.innerHTML = emptyHelp());
    const s = ed.activeSolid();
    const it = ed.activeItem();
    if (ed.context !== b.id) side.innerHTML = buildingPanel(b);
    else if (it) side.innerHTML = itemPanel(ed, b, it.id);
    else if (ed.sel.rule && s) side.innerHTML = rulePanel(ed, s);
    else if (s) side.innerHTML = solidPanel(ed, b, s);
    else side.innerHTML = buildingPanel(b, true);
    bind(ed, b, s);
  };
  ed.onChange(render);
  render();
}

function emptyHelp(): string {
  return `<div class="f3-empty"><b>Comece a construir</b><br><br>
  <kbd>R</kbd> retângulo · <kbd>C</kbd> círculo · <kbd>L</kbd> polígono: desenhe no chão; puxe a seta verde para a altura.<br>
  Desenhe sobre um telhado plano para empilhar. <kbd>X</kbd> troca entre somar e recortar.<br><br>
  Clique num edifício para mover e girar; duplo clique entra nele para editar volumes, faces e componentes.<br><br>
  <kbd>K</kbd> abre os componentes: arraste janelas, portas, sacadas para as paredes.<br>
  Botão direito gira a vista, botão do meio desloca, roda aproxima.</div>`;
}

function buildingPanel(b: Building3, inside = false): string {
  const levels = [...b.levels].sort((x, y) => x.elevation - y.elevation);
  return `<div class="f3-title"><input data-b="name" value="${esc(b.name)}" aria-label="Nome do edifício"><span class="f3-kind">Edifício</span></div>
  <div class="f3-sec"><h3>Uso</h3><div class="f3-seg">${(
    [
      ['residential', 'Moradia'],
      ['commercial', 'Comércio'],
      ['industrial', 'Indústria'],
      ['public', 'Público'],
      ['mixed', 'Misto'],
    ] as const
  )
    .map(([v, l]) => `<button data-use="${v}" aria-pressed="${b.use === v}">${l}</button>`)
    .join('')}</div></div>
  <div class="f3-sec"><h3>Pavimentos</h3><div class="f3-grid2">
    ${field('levels', 'Quantidade', levels.length, 1)}${field('ground', 'Térreo (m)', levels[0]?.height ?? 3)}
    ${field('typical', 'Demais (m)', levels[1]?.height ?? 3)}${field('rotation', 'Rotação (°)', b.rotation, 15)}
  </div></div>
  <div class="f3-sec"><h3>Posição</h3><div class="f3-grid2">${field('px', 'X (m)', b.position[0])}${field('pz', 'Z (m)', b.position[1])}</div></div>
  <div class="f3-sec"><div class="f3-row">${inside ? '' : `<button class="f3-btn primary" data-act="enter">${icon('enter')}Editar volumes</button>`}<button class="f3-btn" data-act="dup">${icon('copy')}Duplicar</button><button class="f3-btn danger" data-act="del">${icon('trash')}Excluir</button></div>
  <p class="f3-empty" style="padding:8px 0 0">${b.solids.length} volume(s), ${b.items.length} componente(s) avulso(s).</p></div>`;
}

function solidPanel(ed: Editor3, b: Building3, s: Solid): string {
  const face = ed.sel.face;
  const r = s.roof;
  const roofParams =
    r.kind === 'flat' || r.kind === 'terrace'
      ? field('parapet', 'Platibanda (m)', r.parapet, 0.1)
      : r.kind === 'dome' || r.kind === 'vault'
        ? field('rise', 'Altura (m, 0 = meio círculo)', r.rise, 0.1) + (r.kind === 'vault' ? field('direction', 'Direção (°)', r.direction, 15) : '')
        : field('pitch', 'Inclinação (°)', r.pitch, 1) + field('overhang', 'Beiral (m)', r.overhang, 0.05) + (r.kind === 'shed' || r.kind === 'sawtooth' || r.kind === 'gable' || r.kind === 'gambrel' ? field('direction', 'Direção (°)', r.direction, 15) : '');
  let facePart = '';
  if (face?.kind === 'side' && face.edge) {
    const e = s.edges[face.edge] ?? {};
    facePart = `<div class="f3-sec"><h3>${icon('push')} Face selecionada</h3>
    <div class="f3-grid2">${field('lean', 'Inclinação da parede (°)', e.lean ?? 0, 1)}${field('push', 'Empurrar (m)', 0, 0.1, 'placeholder="0"')}</div>
    <div class="f3-row" style="margin-top:8px">
      <button class="f3-btn" data-act="gable" aria-pressed="${!!e.gable}">${e.gable ? 'É empena' : 'Fazer empena'}</button>
      <button class="f3-btn" data-act="blank">${e.blank ? 'Recebe componentes' : 'Parede cega'}</button>
      <button class="f3-btn" data-act="split">Dividir lado</button>
    </div>
    <div style="margin-top:8px">${finishSelect('edgemat', 'Parede', e.material ?? s.materials.wall)}</div></div>`;
  }
  return `<div class="f3-title"><input data-s="name" value="${esc(s.name)}" aria-label="Nome do volume"><span class="f3-kind">${s.op === 'add' ? 'Volume' : s.op === 'subtract' ? 'Recorte' : 'Interseção'}</span></div>
  ${facePart}
  <div class="f3-sec"><h3>Forma</h3>
    <div class="f3-seg" style="margin-bottom:8px">${(['add', 'subtract', 'intersect'] as const).map((o) => `<button data-op="${o}" aria-pressed="${s.op === o}">${o === 'add' ? 'Somar' : o === 'subtract' ? 'Recortar' : 'Interseção'}</button>`).join('')}</div>
    <div class="f3-grid2">${field('height', 'Altura (m)', s.height)}${field('base', 'Base (m)', s.base)}${field('taper', 'Afunilar topo (m)', s.taper)}${field('round', 'Arredondar cantos (m)', s.plan.outer[0]?.round ?? 0)}</div>
    <div class="f3-row" style="margin-top:8px"><button class="f3-btn" data-act="levelsfit">Altura = pavimentos</button><button class="f3-btn" data-act="mirror">${icon('mirror')}Espelhar</button></div>
  </div>
  <div class="f3-sec"><h3>Cobertura</h3><div class="f3-chips">${ROOFS.map(([k, l, ic]) => `<button class="f3-chip" data-roof="${k}" aria-pressed="${r.kind === k}">${icon(ic)}${l}</button>`).join('')}</div>
    <div class="f3-grid2" style="margin-top:8px">${roofParams}</div></div>
  <div class="f3-sec"><h3>Materiais</h3><div style="display:grid;gap:6px">${finishSelect('wall', 'Paredes', s.materials.wall)}${finishSelect('roof', 'Telhado', s.materials.roof)}${finishSelect('trim', 'Detalhes', s.materials.trim)}${finishSelect('base', 'Base', s.materials.base)}</div></div>
  <div class="f3-sec"><h3>Fachada <span class="r"><button class="f3-btn" data-act="addrule">${icon('add')}Regra</button></span></h3>${s.facade.length ? s.facade.map((f) => ruleRow(ed, f)).join('') : '<p class="f3-empty" style="padding:0">Sem regras. Uma regra espalha janelas ou portas pelos lados e pavimentos e se refaz quando o volume muda.</p>'}</div>`;
}

function ruleRow(ed: Editor3, f: FacadeRule): string {
  const t = typeById(f.type, ed.project);
  const lv = Array.isArray(f.levels) ? f.levels.map((x) => x + 1).join(',') : { all: 'Todos', ground: 'Térreo', upper: 'Acima do térreo', top: 'Último', middle: 'Intermediários' }[f.levels];
  return `<div class="f3-rule" data-rule="${f.id}"><div class="t"><b>${esc(t?.name ?? f.type)}</b><small>${lv} · ${{ spacing: 'a cada', max: 'até', count: 'quantidade', fit: 'encaixe' }[f.mode]} ${num(f.value)}${f.mode === 'count' ? '' : ' m'}</small></div>
  <select data-rk="levels" aria-label="Pavimentos"><option value="all">Todos</option><option value="ground">Térreo</option><option value="upper">Acima</option><option value="top">Último</option></select>
  <span style="color:var(--muted);font-size:11px">${f.mode === 'count' ? 'qtd.' : 'm'}</span><input data-rk="value" value="${num(f.value)}" style="width:52px" aria-label="Valor">
  <button class="f3-btn danger" data-rk="del" aria-label="Remover regra">${icon('trash')}</button></div>`;
}

function paramInputs(defs: ParamDef[], values: Record<string, unknown>, overrides: Record<string, unknown>): string {
  const groups: Record<string, string> = { size: 'Medidas', divisions: 'Divisões', profile: 'Perfil', material: 'Materiais', detail: 'Detalhes' };
  let html = '';
  for (const g of Object.keys(groups)) {
    const ds = defs.filter((d) => d.group === g);
    if (!ds.length) continue;
    html += `<div class="f3-sec"><h3>${groups[g]}</h3><div class="f3-grid2">`;
    for (const d of ds) {
      const v = values[d.key];
      const over = d.key in overrides ? ' over' : '';
      if (d.kind === 'enum') html += `<label class="f3-field${over}"><span>${d.label}</span><select data-p="${d.key}" data-scope="${d.scope}">${d.options!.map((o) => `<option value="${o.value}" ${o.value === v ? 'selected' : ''}>${o.label}</option>`).join('')}</select></label>`;
      else if (d.kind === 'bool') html += `<label class="f3-field${over}"><span>${d.label}</span><select data-p="${d.key}" data-scope="${d.scope}" data-bool="1"><option value="1" ${v === true ? 'selected' : ''}>Sim</option><option value="0" ${v !== true ? 'selected' : ''}>Não</option></select></label>`;
      else if (d.kind === 'color') html += `<label class="f3-field${over}"><span>${d.label}</span><input type="color" data-p="${d.key}" data-scope="${d.scope}" value="${v}"></label>`;
      else if (d.kind === 'finish') html += `<label class="f3-field${over}"><span>${d.label}</span><select data-p="${d.key}" data-scope="${d.scope}">${FINISHES.map((f) => `<option value="${f.id}" ${f.id === v ? 'selected' : ''}>${f.name}</option>`).join('')}</select></label>`;
      else html += `<label class="f3-field${over}"><span>${d.label}${d.kind === 'length' ? ' (m)' : d.kind === 'angle' ? ' (°)' : ''}</span><input data-p="${d.key}" data-scope="${d.scope}" inputmode="decimal" value="${typeof v === 'number' ? num(v) : v}"></label>`;
    }
    html += '</div></div>';
  }
  return html;
}

function itemPanel(ed: Editor3, b: Building3, id: string): string {
  const it = b.items.find((x) => x.id === id)!;
  const t = typeById(it.type, ed.project);
  const f = t && family(t.family);
  if (!t || !f) return '<div class="f3-empty">Tipo desconhecido.</div>';
  const values = resolveParams(f, t.params, it.params);
  const users = ed.project.buildings.reduce((n, x) => n + x.items.filter((q) => q.type === t.id).length + x.solids.reduce((m, s) => m + s.facade.filter((r) => r.type === t.id).length, 0), 0);
  const arr = it.array;
  return `<div class="f3-title"><span style="flex:1;font-weight:600">${esc(t.name)}</span><span class="f3-kind">${esc(f.name)}</span></div>
  <div class="f3-sec"><div class="f3-row"><span style="color:var(--muted);font-size:12px">Mudanças em campos do tipo valem para <b>${users}</b> uso(s) deste tipo; campos azuis são só desta peça.</span>
  <button class="f3-btn" data-act="unique">${icon('unique')}Tornar único</button><button class="f3-btn danger" data-act="del">${icon('trash')}Excluir</button></div></div>
  <div class="f3-sec"><h3>${icon('array')} Repetição</h3><div class="f3-grid2">${field('acount', 'Cópias', arr?.along.count ?? 1, 1)}${field('aspace', 'Distância (m)', arr?.along.value ?? (f.size(values)[0] + 1), 0.1)}${field('rcount', 'Fileiras', arr?.across?.count ?? 1, 1)}${field('rspace', 'Entre fileiras (m)', arr?.across?.spacing ?? 3, 0.1)}</div></div>
  ${paramInputs(f.params, values, it.params)}`;
}

function rulePanel(ed: Editor3, s: Solid): string {
  const r = s.facade.find((f) => f.id === ed.sel.rule!.rule);
  const t = r && typeById(r.type, ed.project);
  return `<div class="f3-title"><span style="flex:1;font-weight:600">${esc(t?.name ?? 'Componente')}</span><span class="f3-kind">Regra de fachada</span></div>
  <div class="f3-sec"><p class="f3-empty" style="padding:0 0 8px">Esta peça vem de uma regra do volume <b>${esc(s.name)}</b> e se redistribui sozinha quando a parede muda.</p>
  <div class="f3-row"><button class="f3-btn" data-act="detach">Soltar da regra</button><button class="f3-btn danger" data-act="del">${icon('trash')}Tirar desta posição</button><button class="f3-btn" data-act="swap">Trocar por outro tipo…</button></div></div>`;
}

function bind(ed: Editor3, b: Building3, s: Solid | undefined): void {
  const side = ed.shell.side;
  const $$ = <T extends HTMLElement>(q: string) => [...side.querySelectorAll<T>(q)];
  const val = (el: HTMLInputElement | HTMLSelectElement) => el.value;
  // Edifício.
  $$<HTMLInputElement>('[data-b="name"]').forEach((el) => el.addEventListener('change', () => ed.change(b.id, (x) => void (x.name = el.value || 'Edifício'), '', false)));
  $$<HTMLButtonElement>('[data-use]').forEach((el) => el.addEventListener('click', () => ed.change(b.id, (x) => void (x.use = el.dataset.use as Building3['use']), 'Uso alterado.', false)));
  // Volume.
  $$<HTMLInputElement>('[data-s="name"]').forEach((el) => el.addEventListener('change', () => ed.changeSolid((x) => void (x.name = el.value || 'Volume'))));
  $$<HTMLButtonElement>('[data-op]').forEach((el) => el.addEventListener('click', () => ed.command('op-' + el.dataset.op)));
  $$<HTMLButtonElement>('[data-roof]').forEach((el) =>
    el.addEventListener('click', () =>
      ed.changeSolid((x) => {
        const k = el.dataset.roof as RoofKind;
        x.roof.kind = k;
        if (k === 'flat') x.roof.parapet = x.roof.parapet || 0.6;
        if (k === 'terrace') x.roof.parapet = Math.max(1.05, x.roof.parapet);
        if (k !== 'flat' && k !== 'terrace' && x.roof.overhang === 0 && k !== 'dome' && k !== 'vault') x.roof.overhang = 0.5;
      }, 'Cobertura alterada.'),
    ),
  );
  for (const el of $$<HTMLInputElement>('input[data-k]')) {
    el.addEventListener('change', () => {
      const k = el.dataset.k!;
      if (k.endsWith('.color') || k.endsWith('.finish')) {
        const [slot, prop] = k.split('.') as [string, 'color' | 'finish'];
        if (slot === 'edgemat') return ed.changeSolid((x) => void (((x.edges[ed.sel.face!.edge!] ??= {}).material ??= { ...x.materials.wall })[prop] = el.value));
        return ed.changeSolid((x) => void (x.materials[slot as keyof Solid['materials']][prop] = el.value));
      }
      const v = parse(el.value);
      if (!Number.isFinite(v)) return;
      applyNumber(ed, b, s, k, v);
    });
    // Setas para cima/baixo mudam pelo passo.
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        el.dispatchEvent(new Event('change'));
        el.select();
        e.preventDefault();
        return;
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const step = parse(el.dataset.step ?? '0.1') * (e.shiftKey ? 10 : 1);
      const v = (parse(el.value) || 0) + (e.key === 'ArrowUp' ? step : -step);
      el.value = num(v);
      el.dispatchEvent(new Event('change'));
      e.preventDefault();
    });
  }
  $$<HTMLSelectElement>('select[data-k]').forEach((el) =>
    el.addEventListener('change', () => {
      const [slot, prop] = el.dataset.k!.split('.') as [string, 'finish'];
      if (slot === 'edgemat') return ed.changeSolid((x) => void (((x.edges[ed.sel.face!.edge!] ??= {}).material ??= { ...x.materials.wall })[prop] = el.value));
      ed.changeSolid((x) => void (x.materials[slot as keyof Solid['materials']][prop] = el.value));
    }),
  );
  // Regras de fachada.
  $$<HTMLElement>('.f3-rule').forEach((row) => {
    const id = row.dataset.rule!;
    const lv = row.querySelector<HTMLSelectElement>('[data-rk="levels"]');
    const r = s?.facade.find((f) => f.id === id);
    if (lv && r && !Array.isArray(r.levels)) lv.value = r.levels === 'middle' ? 'upper' : r.levels;
    lv?.addEventListener('change', () => ed.changeSolid((x) => void (x.facade.find((f) => f.id === id)!.levels = lv.value as FacadeRule['levels'])));
    row.querySelector<HTMLInputElement>('[data-rk="value"]')?.addEventListener('change', (e) => {
      const v = parse((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) ed.changeSolid((x) => void (x.facade.find((f) => f.id === id)!.value = v));
    });
    row.querySelector('[data-rk="del"]')?.addEventListener('click', () => ed.changeSolid((x) => void (x.facade = x.facade.filter((f) => f.id !== id)), 'Regra removida.'));
  });
  // Parâmetros de componente.
  // Enter aplica também nos parâmetros dos componentes.
  $$<HTMLInputElement>('input[data-p]').forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      el.dispatchEvent(new Event('change'));
      e.preventDefault();
    }
  }));
  $$<HTMLInputElement | HTMLSelectElement>('[data-p]').forEach((el) =>
    el.addEventListener('change', () => {
      const k = el.dataset.p!;
      let v: unknown = val(el);
      if (el.dataset.bool) v = el.value === '1';
      else if (el instanceof HTMLInputElement && el.type !== 'color') {
        const n = parse(el.value);
        if (!Number.isFinite(n)) return;
        v = n;
      }
      ed.setItemParam(k, v, el.dataset.scope === 'instance' ? 'instance' : 'type');
    }),
  );
  // Ações.
  $$<HTMLButtonElement>('[data-act]').forEach((el) =>
    el.addEventListener('click', () => {
      const a = el.dataset.act!;
      if (a === 'enter') ed.enter(b.id);
      else if (a === 'dup') ed.duplicate();
      else if (a === 'del') ed.remove();
      else if (a === 'mirror') ed.command('mirror');
      else if (a === 'unique') ed.makeUnique();
      else if (a === 'levelsfit') ed.changeSolid((x, bb) => {
        const top = [...bb.levels].sort((p, q) => p.elevation - q.elevation).reduce((acc, l) => (l.elevation + l.height > x.base + 0.5 ? Math.max(acc, l.elevation + l.height) : acc), x.base + 3);
        x.height = top - x.base;
      }, 'Altura igual aos pavimentos.');
      else if (a === 'gable' && s && ed.sel.face?.edge) ed.changeSolid((x) => void ((x.edges[ed.sel.face!.edge!] ??= {}).gable = !x.edges[ed.sel.face!.edge!]?.gable), 'Empena alterada.');
      else if (a === 'blank' && s && ed.sel.face?.edge) ed.changeSolid((x) => void ((x.edges[ed.sel.face!.edge!] ??= {}).blank = !x.edges[ed.sel.face!.edge!]?.blank));
      else if (a === 'split' && s && ed.sel.face?.edge) ed.changeSolid((x) => void splitEdgeOf(x, ed.sel.face!.edge!), 'Lado dividido: arraste o novo ponto.');
      else if (a === 'addrule') ruleMenu(ed, el);
      else if (a === 'detach') detach(ed);
      else if (a === 'swap') swapMenu(ed, el);
    }),
  );
}

function splitEdgeOf(s: Solid, edge: string): void {
  // Import tardio para não criar ciclo (ops ← editor).
  void import('../model/ops').then(() => undefined);
  const ring = [s.plan.outer, ...s.plan.holes].find((r) => r.some((v) => v.id === edge));
  if (!ring) return;
  const i = ring.findIndex((v) => v.id === edge);
  const a = ring[i]!,
    n = ring[(i + 1) % ring.length]!;
  delete a.bulge;
  ring.splice(i + 1, 0, { id: uid(), p: [(a.p[0] + n.p[0]) / 2, (a.p[1] + n.p[1]) / 2] });
}

function applyNumber(ed: Editor3, b: Building3, s: Solid | undefined, k: string, v: number): void {
  if (k === 'levels' || k === 'ground' || k === 'typical') {
    ed.change(b.id, (x) => {
      const lv = [...x.levels].sort((p, q) => p.elevation - q.elevation);
      const n = k === 'levels' ? Math.max(1, Math.min(60, Math.round(v))) : lv.length;
      const g = k === 'ground' ? Math.max(2.2, v) : (lv[0]?.height ?? 3);
      const t = k === 'typical' ? Math.max(2.2, v) : (lv[1]?.height ?? 3);
      const old = lv.reduce((acc, l) => acc + l.height, 0);
      x.levels = levelsFor(n, t, g);
      const now = x.levels.reduce((acc, l) => acc + l.height, 0);
      // Volumes que iam até o topo dos pavimentos acompanham.
      for (const so of x.solids) if (so.op === 'add' && Math.abs(so.base + so.height - old) < 0.6) so.height = now - so.base;
    }, 'Pavimentos alterados.');
    return;
  }
  if (k === 'rotation') return void ed.change(b.id, (x) => void (x.rotation = v), '', false);
  if (k === 'px' || k === 'pz') return void ed.change(b.id, (x) => void (x.position = k === 'px' ? [v, x.position[1]] : [x.position[0], v]), '', false);
  if (k === 'acount' || k === 'aspace' || k === 'rcount' || k === 'rspace') {
    const it = ed.activeItem();
    if (!it) return;
    ed.change(b.id, (x) => {
      const y = x.items.find((q) => q.id === it.id)!;
      const fam = family(typeById(y.type, ed.project)?.family ?? '');
      const w = fam ? fam.size(resolveParams(fam, typeById(y.type, ed.project)?.params, y.params))[0] : 1;
      y.array ??= { along: { mode: 'spacing', value: Math.round((w + 1) * 10) / 10, count: 1 } };
      if (k === 'acount') y.array.along.count = Math.max(1, Math.round(v));
      if (k === 'aspace') y.array.along.value = Math.max(0.1, v);
      if (k === 'rcount') y.array.across = { count: Math.max(1, Math.round(v)), spacing: y.array.across?.spacing ?? 3 };
      if (k === 'rspace') y.array.across = { count: y.array.across?.count ?? 1, spacing: Math.max(0.1, v) };
      if (y.array.along.count === 1 && (y.array.across?.count ?? 1) === 1) delete y.array;
    });
    return;
  }
  if (!s) return;
  ed.changeSolid((x) => {
    if (k === 'height') x.height = Math.max(0.3, v);
    else if (k === 'base') x.base = v;
    else if (k === 'taper') x.taper = Math.max(0, v);
    else if (k === 'round') for (const q of x.plan.outer) q.round = v > 0 ? v : undefined;
    else if (k === 'parapet') x.roof.parapet = Math.max(0, v);
    else if (k === 'pitch') x.roof.pitch = Math.max(3, Math.min(75, v));
    else if (k === 'overhang') x.roof.overhang = Math.max(0, v);
    else if (k === 'direction') x.roof.direction = v;
    else if (k === 'rise') x.roof.rise = Math.max(0, v);
    else if (k === 'lean' && ed.sel.face?.edge) (x.edges[ed.sel.face.edge] ??= {}).lean = Math.max(-45, Math.min(45, v));
    else if (k === 'push' && ed.sel.face?.edge) return void import('../model/ops').then(() => undefined);
  });
  if (k === 'push' && ed.sel.face?.edge && v !== 0) void import('../model/ops').then((ops) => ed.changeSolid((x) => ops.pushEdge(x, ed.sel.face!.edge!, v), `Face movida ${num(v)} m.`));
}

/** Menu de tipos para uma regra nova (janelas e portas primeiro). */
function ruleMenu(ed: Editor3, anchor: HTMLElement): void {
  const types = BUILTIN_TYPES.concat(ed.project.types).filter((t) => family(t.family)?.host === 'face');
  menu(anchor, types.map((t) => [t.name, () => ed.changeSolid((x) => void x.facade.push(facadeRule(t.id, { levels: family(t.family)!.category === 'doors' ? 'ground' : 'all', mode: family(t.family)!.category === 'doors' ? 'count' : 'max', value: family(t.family)!.category === 'doors' ? 1 : 3 })), `Regra: ${t.name}.`)] as [string, () => void]));
}

function swapMenu(ed: Editor3, anchor: HTMLElement): void {
  const r = ed.sel.rule;
  if (!r) return;
  const types = BUILTIN_TYPES.concat(ed.project.types).filter((t) => family(t.family)?.host === 'face');
  menu(anchor, types.map((t) => [t.name, () => ed.changeSolid((x) => void (x.facade.find((f) => f.id === r.rule)!.except[r.key] = t.id), `Esta posição agora tem ${t.name}.`)] as [string, () => void]));
}

/** Solta um componente da regra: vira uma peça avulsa no mesmo lugar. */
function detach(ed: Editor3): void {
  const r = ed.sel.rule;
  const b = ed.activeBuilding();
  if (!r || !b) return;
  const built = ed.view.built.get(b.id);
  const pl = built?.ev.placements.find((p) => p.tag.rule === r.rule && p.tag.key === r.key);
  if (!pl?.host) return;
  const rule = findSolid(b, r.solid)?.facade.find((f) => f.id === r.rule);
  const id = uid();
  ed.change(b.id, (x) => {
    const ru = findSolid(x, r.solid)!.facade.find((f) => f.id === r.rule)!;
    ru.except[r.key] = 'none';
    const typeId = rule?.except[r.key] && rule.except[r.key] !== 'none' ? rule.except[r.key]! : ru.type;
    x.items.push({ id, type: typeId, params: { ...ru.params }, host: { kind: 'face', solid: pl.host!.solid, edge: pl.host!.edge, u: pl.host!.s, y: pl.host!.y } });
  }, 'Peça solta: agora ela é independente.');
  ed.select({ building: b.id, item: id });
}

function menu(anchor: HTMLElement, items: [string, () => void][]): void {
  document.querySelector('.f3-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'f3-menu';
  m.innerHTML = items.map(([l], i) => `<button data-i="${i}">${esc(l)}</button>`).join('');
  const root = anchor.closest('.f3') as HTMLElement;
  root.appendChild(m);
  const r = anchor.getBoundingClientRect(),
    rr = root.getBoundingClientRect();
  m.style.left = `${Math.min(r.left - rr.left, rr.width - 230)}px`;
  m.style.top = `${Math.min(r.bottom - rr.top + 4, rr.height - 320)}px`;
  m.style.maxHeight = '300px';
  m.style.overflow = 'auto';
  m.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
    b.addEventListener('click', () => {
      items[Number(b.dataset.i)]![1]();
      m.remove();
    }),
  );
  setTimeout(() => document.addEventListener('pointerdown', (e) => !m.contains(e.target as Node) && m.remove(), { once: true }), 0);
}

export { allFamilies };
