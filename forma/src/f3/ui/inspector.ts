// Inspetor contextual: mostra só o que vale para a seleção (edifício, volume,
// face, componente ou componente de regra). Cada campo grava ao mudar.
import type { Editor3 } from '../editor/editor';
import type { Building3, FacadeRule, RoofKind, Solid } from '../model/schema';
import { findSolid, planCenter, rotateSolid, translateSolid } from '../model/ops';

/** Centro do volume (média dos vértices), arredondado para mostrar. */
const centerOf = (s: Solid): [number, number] => {
  const c = planCenter(s);
  return [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100];
};
import { levelsFor, facadeRule, uid } from '../model/defaults';
import { FINISHES } from '../render/finishes';
import { allFamilies, family, typeById, BUILTIN_TYPES } from '../families/index';
import { resolveParams, type ParamDef } from '../families/family';
import { icon } from './icons';
import { changeLevels, courtyardIn, FACADE_PRESETS, podiumUnder, setbackOn } from '../model/quick';
import { planBox } from '../model/modeling';

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

/** Campo de uma ferramenta (lido pelo botão data-run da mesma caixa). */
function tf(key: string, label: string, value: number, step = 0.1): string {
  return `<label class="f3-field"><span>${label}</span><input data-t="${key}" data-step="${step}" inputmode="decimal" value="${num(value)}"></label>`;
}

function toolBox(title: string, fields: string, buttons: string): string {
  return `<div class="f3-op"><h4>${title}</h4><div class="f3-grid2">${fields}</div><div class="f3-row" style="margin-top:6px">${buttons}</div></div>`;
}

const run = (op: string, label: string, extra: Record<string, unknown> = {}, cls = '') => `<button class="f3-btn ${cls}" data-run="${op}" data-extra='${JSON.stringify(extra)}'>${label}</button>`;

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
    if (ed.context !== b.id && ed.sel.others.length) side.innerHTML = alignPanel(1 + ed.sel.others.length, 'edifícios');
    else if (ed.context !== b.id) side.innerHTML = buildingPanel(b);
    else if (ed.sel.solids.length > 1) side.innerHTML = alignPanel(ed.sel.solids.length, 'volumes');
    else if (it && ed.sel.elems.length <= 1) side.innerHTML = itemPanel(ed, b, it.id);
    else if (ed.sel.elems.length) side.innerHTML = elementsPanel(ed);
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
  <div class="f3-sec"><div class="f3-row"><button class="f3-btn" data-quick="lvup">+ Pavimento</button><button class="f3-btn" data-quick="lvdown">− Pavimento</button></div></div>
  <div class="f3-sec"><h3>Posição</h3><div class="f3-grid2">${field('px', 'X (m)', b.position[0])}${field('pz', 'Z (m)', b.position[1])}</div></div>
  <div class="f3-sec"><div class="f3-row">${inside ? '' : `<button class="f3-btn primary" data-act="enter">${icon('enter')}Editar volumes</button>`}<button class="f3-btn" data-act="dup">${icon('copy')}Duplicar</button><button class="f3-btn danger" data-act="del">${icon('trash')}Excluir</button></div>
  <p class="f3-empty" style="padding:8px 0 0">${b.solids.length} volume(s), ${b.items.length} componente(s) avulso(s).</p></div>`;
}

function alignPanel(n: number, what: string): string {
  const b = (op: string, ic: string, label: string) => '<button class="f3-btn" data-align="' + op + '" title="' + label + '">' + label + '</button>';
  return '<div class="f3-title"><span style="flex:1;font-weight:600">' + n + ' ' + what + '</span><span class="f3-kind">Seleção</span></div>' +
    '<div class="f3-sec"><h3>Alinhar (pelo primeiro selecionado)</h3><div class="f3-row">' + b('left', '', 'Esquerda') + b('centerX', '', 'Centro X') + b('right', '', 'Direita') + b('front', '', 'Frente') + b('centerZ', '', 'Centro Z') + b('back', '', 'Fundo') + '</div></div>' +
    (what === 'volumes' ? '<div class="f3-sec"><h3>Altura</h3><div class="f3-row">' + b('base', '', 'Mesma base') + b('top', '', 'Mesmo topo (sobe)') + b('height', '', 'Mesmo topo (estica)') + '</div></div>' : '') +
    '<div class="f3-sec"><h3>Distribuir com espaços iguais</h3><div class="f3-row">' + b('distX', '', 'Em X') + b('distZ', '', 'Em Z') + '</div><p class="f3-empty" style="padding:6px 0 0">Shift+clique acrescenta à seleção. As pontas ficam; os do meio se espaçam por igual.</p></div>';
}

function solidPanel(ed: Editor3, b: Building3, s: Solid): string {
  const face = ed.sel.face;
  const box = planBox(s);
  const bv = s.bevel;
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
    <div style="margin-top:8px">${finishSelect('edgemat', 'Parede', e.material ?? s.materials.wall)}</div>
    ${toolBox('Extrudar face', tf('depth', 'Profundidade (m; − afunda)', 3), run('extrude', 'Extrudar'))}
    ${toolBox('Inset da face', tf('margin', 'Margem (m)', 1) + tf('depth', 'Profundidade (m; − nicho)', -1.2) + `<label class="f3-field"><span>Pé</span><select data-t="keepBottom"><option value="">Com margem</option><option value="1">Até a base</option></select></label>`, run('inset-side', 'Aplicar inset'))}
    <div class="f3-grid2" style="margin-top:8px">${field('edgebevel', 'Bisel do topo deste lado (m)', e.bevel ?? 0, 0.05)}</div></div>`;
  } else if (face?.kind === 'top') {
    facePart = `<div class="f3-sec"><h3>${icon('push')} Topo selecionado</h3>
    ${toolBox('Inset do topo', tf('inset', 'Recuo da borda (m)', 2) + tf('depth', 'Altura (m; − rebaixa)', 3), run('inset-top', 'Aplicar inset'))}
    <p class="f3-empty" style="padding:6px 0 0">Ctrl + arrastar a seta verde extruda o topo como volume novo.</p></div>`;
  }
  if (ed.sel.vertex) {
    const v = [...s.plan.outer, ...s.plan.holes.flat()].find((q) => q.id === ed.sel.vertex);
    if (v) facePart += `<div class="f3-sec"><h3>Canto selecionado</h3><div class="f3-grid2">${field('cround', 'Arredondar (m)', v.round ?? 0, 0.1)}${field('cchamfer', 'Chanfrar (m)', v.chamfer ?? 0, 0.1)}</div>
    <div class="f3-row" style="margin-top:8px"><button class="f3-btn danger" data-act="delvertex">Apagar vértice</button></div></div>`;
  }
  return `<div class="f3-title"><input data-s="name" value="${esc(s.name)}" aria-label="Nome do volume"><span class="f3-kind">${s.op === 'add' ? 'Volume' : s.op === 'subtract' ? 'Recorte' : 'Interseção'}</span></div>
  ${facePart}
  <div class="f3-sec"><h3>Forma</h3>
    <div class="f3-seg" style="margin-bottom:8px">${(['add', 'subtract', 'intersect'] as const).map((o) => `<button data-op="${o}" aria-pressed="${s.op === o}">${o === 'add' ? 'Somar' : o === 'subtract' ? 'Recortar' : 'Interseção'}</button>`).join('')}</div>
    <div class="f3-grid2">${field('height', 'Altura (m)', s.height)}${field('base', 'Base (m)', s.base)}${field('cx', 'Centro X (m)', centerOf(s)[0])}${field('cz', 'Centro Z (m)', centerOf(s)[1])}${field('spin', 'Girar (°)', 0, 15, 'placeholder="0"')}${field('taper', 'Afunilar topo (m)', s.taper)}${field('round', 'Arredondar cantos (m)', s.plan.outer[0]?.round ?? 0)}${field('chamfer', 'Chanfrar cantos (m)', s.plan.outer[0]?.chamfer ?? 0)}${field('sizew', 'Largura X (m)', box.x1 - box.x0)}${field('sized', 'Profundidade Z (m)', box.z1 - box.z0)}</div>
    <div class="f3-row" style="margin-top:8px"><button class="f3-btn" data-act="levelsfit">Altura = pavimentos</button><button class="f3-btn" data-act="mirror">${icon('mirror')}Espelhar</button></div>
  </div>
  <div class="f3-sec"><h3>Modificar</h3>
    ${toolBox('Offset do contorno', tf('d', 'Distância (m; − encolhe)', 1) + `<label class="f3-field"><span>Cantos</span><select data-t="corner"><option value="sharp">Vivos</option><option value="round">Redondos</option><option value="chamfer">Chanfrados</option></select></label>`, run('offset', 'Aplicar') + run('offset', 'Como volume novo', { copy: true }))}
    ${toolBox('Dividir na altura', tf('y', 'Altura do corte acima da base (m)', Math.round(s.height * 5) / 10), run('split', 'Dividir'))}
    <div class="f3-op"><h4>Bisel das arestas</h4><div class="f3-grid2">${field('bvtop', 'Topo (m)', bv?.top ?? 0, 0.05)}${field('bvbottom', 'Base (m)', bv?.bottom ?? 0, 0.05)}${field('bvseg', 'Segmentos', bv?.segments ?? 1, 1)}
    <label class="f3-field"><span>Perfil</span><select data-bvprofile><option value="0" ${!bv || bv.profile < 0.25 ? 'selected' : ''}>Reto</option><option value="0.5" ${bv && bv.profile >= 0.25 && bv.profile < 0.75 ? 'selected' : ''}>Misto</option><option value="1" ${bv && bv.profile >= 0.75 ? 'selected' : ''}>Redondo</option></select></label></div></div>
  </div>
  <div class="f3-sec"><h3>Modelar rápido</h3><div class="f3-row">
    <button class="f3-btn" data-quick="lvup" title="Mais um pavimento no edifício">+ Pavimento</button>
    <button class="f3-btn" data-quick="lvdown" title="Um pavimento a menos">− Pavimento</button>
    <button class="f3-btn" data-quick="setback" title="Pavimento recuado em cima; o de baixo vira terraço">Recuo no topo</button>
    <button class="f3-btn" data-quick="podium" title="Pódio mais largo no térreo, com lojas">Embasamento</button>
    <button class="f3-btn" data-quick="court" title="Recorte no meio (pátio interno)">Pátio</button></div>
    <label class="f3-field" style="margin-top:8px"><span>Fachada pronta</span><select data-quick-facade><option value="">Escolher…</option>${FACADE_PRESETS.map((f) => `<option value="${f.id}">${f.name}</option>`).join('')}</select></label></div>
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

function elementsPanel(ed: Editor3): string {
  const all = ed.elements();
  const picked = all.filter((e) => ed.sel.elems.includes(e.key));
  const types = [...new Set(picked.map((e) => e.type))];
  const names = types.map((t) => typeById(t, ed.project)?.name ?? t);
  const btn = (op: string, label: string, title: string) => '<button class="f3-btn" data-sel="' + op + '" title="' + title + '">' + label + '</button>';
  const t = types.length === 1 ? typeById(types[0]!, ed.project) : undefined;
  const f = t && family(t.family);
  const users = t ? all.filter((e) => e.type === t.id).length : 0;
  let params = '';
  if (t && f) {
    const scope = ed.elemScope;
    params =
      '<div class="f3-sec"><h3>Parâmetros · ' + esc(t.name) + '</h3><div class="f3-seg" style="margin-bottom:6px">' +
      '<button data-escope="type" aria-pressed="' + (scope === 'type') + '">Todos do tipo (' + users + ')</button>' +
      '<button data-escope="sel" aria-pressed="' + (scope === 'sel') + '">Só os selecionados (' + picked.length + ')</button></div></div>' +
      paramInputs(f.params, resolveParams(f, t.params), {});
  } else params = '<div class="f3-sec"><p class="f3-empty" style="padding:0">Tipos diferentes na seleção. Use "Mesmo tipo" para editar os parâmetros de um tipo.</p></div>';
  return '<div class="f3-title"><span style="flex:1;font-weight:600">' + (t ? esc(t.name) : picked.length + ' elemento(s)') + '</span><span class="f3-kind">' + (f ? esc(f.name) : 'Fachada') + ' · ' + picked.length + '</span></div>' +
  '<div class="f3-sec"><p class="f3-empty" style="padding:0 0 8px">' + esc(names.join(', ')) + '</p>' +
  '<h3>Selecionar</h3><div class="f3-row">' +
  btn('row', 'Fileira', 'O mesmo pavimento em todas as faces (duplo clique numa janela)') +
  btn('rowFace', 'Fileira na face', 'O mesmo pavimento só nesta face') +
  btn('column', 'Coluna', 'A mesma prumada em todos os pavimentos') +
  btn('grow', 'Crescer', 'Acrescenta os vizinhos') +
  btn('shrink', 'Encolher', 'Tira a borda da seleção') +
  btn('type', 'Mesmo tipo', 'Todos do mesmo tipo no edifício') +
  btn('face', 'Face inteira', 'Todos desta face') +
  '</div></div>' +
  params +
  '<div class="f3-sec"><h3>Aplicar aos selecionados</h3><div class="f3-row">' +
  '<button class="f3-btn" data-act="swapsel">Trocar por outro tipo…</button>' +
  '<button class="f3-btn" data-act="restore">Voltar à regra</button>' +
  '<button class="f3-btn danger" data-act="removesel">Remover</button></div></div>';
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
      if (ed.sel.elems.length && !(ed.activeItem() && ed.sel.elems.length <= 1)) ed.editElemsParam(k, v);
      else ed.setItemParam(k, v, el.dataset.scope === 'instance' ? 'instance' : 'type');
    }),
  );
  // Ferramentas de modelagem: o botão lê os campos da sua caixa.
  $$<HTMLButtonElement>('[data-run]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const box = btn.closest('.f3-op')!;
      const args: Record<string, number | string | boolean> = {};
      box.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-t]').forEach((el) => {
        const k = el.dataset.t!;
        if (el instanceof HTMLSelectElement) args[k] = k === 'keepBottom' ? el.value === '1' : el.value;
        else args[k] = parse(el.value);
      });
      Object.assign(args, JSON.parse(btn.dataset.extra || '{}'));
      if (!ed.modelOp(btn.dataset.run!, args)) ed.toast('Não foi possível com essas medidas.');
    }),
  );
  $$<HTMLInputElement>('input[data-t]').forEach((el) =>
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      el.closest('.f3-op')?.querySelector<HTMLButtonElement>('[data-run]')?.click();
      e.preventDefault();
    }),
  );
  $$<HTMLSelectElement>('[data-bvprofile]').forEach((el) => el.addEventListener('change', () => ed.modelOp('bevel', { profile: parse(el.value) })));
  $$<HTMLButtonElement>('[data-escope]').forEach((el) =>
    el.addEventListener('click', () => {
      ed.elemScope = el.dataset.escope === 'sel' ? 'sel' : 'type';
      ed.select({ ...ed.sel });
    }),
  );
  $$<HTMLButtonElement>('[data-sel]').forEach((el) => el.addEventListener('click', () => ed.selectElems(el.dataset.sel as 'row')));
  $$<HTMLButtonElement>('[data-align]').forEach((el) => el.addEventListener('click', () => ed.align(el.dataset.align as never)));
  $$<HTMLButtonElement>('[data-quick]').forEach((el) =>
    el.addEventListener('click', () => {
      const q = el.dataset.quick!;
      if (q === 'lvup' || q === 'lvdown') return void ed.change(b.id, (x) => changeLevels(x, q === 'lvup' ? 1 : -1), q === 'lvup' ? 'Mais um pavimento.' : 'Um pavimento a menos.');
      if (!s) return;
      let made: string | null = null;
      const ok = ed.change(b.id, (x) => {
        const so = x.solids.find((y) => y.id === s.id)!;
        const n = q === 'setback' ? setbackOn(x, so) : q === 'podium' ? podiumUnder(x, so) : courtyardIn(x, so);
        if (!n) return false;
        made = n.id;
      }, q === 'setback' ? 'Recuo criado; o volume de baixo virou terraço.' : q === 'podium' ? 'Embasamento com lojas criado.' : 'Pátio recortado.');
      if (ok && made) ed.select({ building: b.id, solids: [made] });
      else if (!ok) ed.toast('Não cabe: o volume é pequeno demais para isso.');
    }),
  );
  $$<HTMLSelectElement>('[data-quick-facade]').forEach((el) =>
    el.addEventListener('change', () => {
      const pr = FACADE_PRESETS.find((f) => f.id === el.value);
      if (pr) ed.changeSolid((x) => void (x.facade = pr.rules()), `Fachada ${pr.name.toLowerCase()}.`);
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
      else if (a === 'delvertex') ed.remove();
      else if (a === 'addrule') ruleMenu(ed, el);
      else if (a === 'swapsel') swapMenu(ed, el);
      else if (a === 'vary') ed.elemAction('vary');
      else if (a === 'restore') ed.elemAction('restore');
      else if (a === 'removesel') ed.elemAction('remove');
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
  if (k === 'bvtop' || k === 'bvbottom' || k === 'bvseg') return void ed.modelOp('bevel', k === 'bvtop' ? { top: v } : k === 'bvbottom' ? { bottom: v } : { segments: v });
  if (k === 'edgebevel') return void ed.modelOp('edge-bevel', { w: v });
  if (k === 'cround') return void ed.modelOp('corner', { round: v });
  if (k === 'cchamfer') return void ed.modelOp('corner', { chamfer: v });
  if (k === 'sizew' || k === 'sized') {
    const bx = planBox(s);
    return void ed.modelOp('size', k === 'sizew' ? { w: v, d: bx.z1 - bx.z0 } : { w: bx.x1 - bx.x0, d: v });
  }
  ed.changeSolid((x) => {
    if (k === 'height') x.height = Math.max(0.3, v);
    else if (k === 'base') x.base = v;
    else if (k === 'taper') x.taper = Math.max(0, v);
    else if (k === 'round') for (const q of x.plan.outer) q.round = v > 0 ? v : undefined;
    else if (k === 'chamfer') for (const q of x.plan.outer) q.chamfer = v > 0 ? v : undefined;
    else if (k === 'cx' || k === 'cz') {
      const c = centerOf(x);
      translateSolid(x, k === 'cx' ? v - c[0] : 0, k === 'cz' ? v - c[1] : 0);
    } else if (k === 'spin') rotateSolid(x, v);
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
  // Com uma face escolhida, a regra vale só para aquele lado (porta da frente, vitrine).
  const edge = ed.sel.face?.kind === 'side' ? ed.sel.face.edge : undefined;
  menu(anchor, types.map((t) => {
    const door = family(t.family)!.category === 'doors';
    return [t.name, () => ed.changeSolid((x) => void x.facade.push(facadeRule(t.id, { levels: door ? 'ground' : 'all', mode: door ? 'count' : 'max', value: door ? 1 : 3, edges: edge ? [edge] : [] })), `Regra: ${t.name}${edge ? ' nesta face' : ' em todos os lados'}.`)] as [string, () => void];
  }));
}

function swapMenu(ed: Editor3, anchor: HTMLElement): void {
  const types = BUILTIN_TYPES.concat(ed.project.types).filter((t) => family(t.family)?.host === 'face');
  menu(anchor, types.map((t) => [t.name, () => ed.elemAction('swap', t.id)] as [string, () => void]));
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
