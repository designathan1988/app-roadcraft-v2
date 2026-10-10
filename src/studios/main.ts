import styles from './style.css?inline';
import { createProject, parseProject, movements, sides, sideNames, cycleDuration, phaseDuration, signalConflicts, shortestRoute, routeLength, nodeById, transitSchedule, interpolatePose, neutralPose, joints, demandRate, distance, soundGain, resizeClip, trimSnapshots } from './model';
import type { Kind, Project, Network, Point, AnimationProject, Pose, Joint } from './model';
import { MapView } from './mapView';
import { ThreeView } from './threeView';
import { SoundEngine } from './audio';

const names: Record<Kind, [string, string]> = {
  signal: ['Signal Studio', 'Cruzamentos e semáforos'], traffic: ['Traffic Studio', 'Tráfego e cenários'],
  transit: ['Transit Studio', 'Transporte público'], material: ['Material Studio', 'Materiais e superfícies'],
  animation: ['Animation Studio', 'Animações e poses'], sound: ['Sound Studio', 'Som e ambientes sonoros'],
};
const jointNames: Record<Joint, string> = { leftArm: 'Ombro esquerdo', rightArm: 'Ombro direito', leftElbow: 'Cotovelo esquerdo', rightElbow: 'Cotovelo direito', leftLeg: 'Quadril esquerdo', rightLeg: 'Quadril direito', leftKnee: 'Joelho esquerdo', rightKnee: 'Joelho direito', head: 'Cabeça', torso: 'Tronco', height: 'Altura do corpo' };
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;
const seconds = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const fixed = (value: number, digits = 1) => value.toLocaleString('pt-BR', { maximumFractionDigits: digits });
function element<T extends HTMLElement = HTMLElement>(id: string): T { const found = document.getElementById(id); if (!found) throw new Error(`Controle ausente: ${id}`); return found as T; }
function field(label: string, path: string, value: string | number, type = 'number', min = 0, max = 100, step = 1): string { return `<label class="field"><span>${esc(label)}</span><input data-field="${path}" type="${type}" value="${esc(value)}" ${type === 'number' || type === 'range' ? `min="${min}" max="${max}" step="${step}"` : 'maxlength="100"'}></label>`; }
function select(label: string, path: string, value: string, choices: [string, string][]): string { return `<label class="field"><span>${esc(label)}</span><select data-field="${path}">${choices.map(([id, name]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>`; }
function check(label: string, path: string, checked: boolean): string { return `<label class="check"><input type="checkbox" data-field="${path}" ${checked ? 'checked' : ''}>${esc(label)}</label>`; }
const button = (label: string, action: string, extra = '') => `<button type="button" data-action="${action}" ${extra}>${esc(label)}</button>`;
const metric = (label: string, value: string) => `<div class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
const note = (text: string) => `<p class="note">${esc(text)}</p>`;
function rows(items: { id: string; name: string; color?: string }[], selected: string): string { return `<div class="list">${items.map((item, i) => `<button data-pick="${esc(item.id)}" class="${item.id === selected ? 'active' : ''}" aria-pressed="${item.id === selected}"><span class="index">${i + 1}</span>${item.color ? `<span class="swatch" style="background:${esc(item.color)}"></span>` : ''}${esc(item.name)}</button>`).join('')}</div>`; }
function download(data: Blob | ArrayBuffer | string, name: string, type: string) { const blob = data instanceof Blob ? data : new Blob([data], { type }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
function csvCell(value: unknown): string { let text = String(value); if (/^[=+@-]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; }
const csv = (rows: unknown[][]) => '\ufeff' + rows.map(row => row.map(csvCell).join(';')).join('\r\n');

class Studio {
  private readonly kind: Kind;
  private project: Project;
  private selected = '';
  private history: string[] = [];
  private future: string[] = [];
  private map: MapView | null = null;
  private three: ThreeView | null = null;
  private readonly sound = new SoundEngine();
  private time = 0;
  private running = false;
  private speed = 1;
  private mode: 'select' | 'add' | 'connect' = 'select';
  private connectFrom = '';
  private seat = false;
  private baseline: ReturnType<MapView['metrics']> | null = null;
  private lastFrame = 0;
  private lastReadout = 0;
  private recoveryMessage = '';
  private activeLine = '';
  private activeStop = 0;
  private playGeneration = 0;
  private preparingSound = false;
  constructor() {
    const kind = document.body.dataset.studio; if (!kind || !(kind in names)) throw new Error('Editor desconhecido.'); this.kind = kind as Kind;
    this.project = createProject(this.kind);
    try { const saved = localStorage.getItem(`roadcraft-studio-${this.kind}`); if (saved) { this.project = parseProject(saved, this.kind); this.recoveryMessage = 'Projeto local recuperado.'; } } catch (error) { this.recoveryMessage = `Recuperação indisponível: ${String(error)}`; }
    document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
    this.shell(); this.selectFirst();
    if (this.kind === 'material' || this.kind === 'animation') this.three = new ThreeView(element('viewport'), this.project);
    else this.map = new MapView(element('viewport'), this.project, { pick: id => this.pick(id), move: (id, p) => this.move(id, p), add: p => this.addNode(p) });
    this.render(); if (this.recoveryMessage) this.status(this.recoveryMessage, this.recoveryMessage.includes('indisponível'));
    window.addEventListener('keydown', e => { const editing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement; if (editing) return; if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(e.shiftKey); } else if (e.code === 'Space') { e.preventDefault(); void this.toggle(); } });
    window.addEventListener('pagehide', () => this.sound.stop());
    requestAnimationFrame(t => this.frame(t));
  }
  private shell() {
    document.body.innerHTML = `<header class="topbar"><div class="brand">Roadcraft<span class="slash">/</span><span class="studio">${names[this.kind][0]}</span></div><select id="studio-nav" aria-label="Abrir outro editor">${Object.entries(names).map(([kind, [, label]]) => `<option value="${kind}" ${kind === this.kind ? 'selected' : ''}>${label}</option>`).join('')}</select><input id="project-name" class="project" aria-label="Nome do projeto" maxlength="100"><button id="open">Abrir projeto</button><button id="save">Salvar projeto</button><button id="export" class="primary">Exportar</button></header>
    <main class="layout"><aside class="panel left" id="left" aria-label="Criação e seleção"></aside><section class="workbench" aria-label="Bancada de criação"><div class="toolbar"><strong id="preview-title">Prévia</strong><div id="tools" class="row"></div><button id="view-top">${this.three ? 'Geral' : this.kind === 'material' || this.kind === 'animation' ? 'Geral' : 'Planta'}</button><button id="view-iso">${this.kind === 'material' || this.kind === 'animation' ? 'Aproximar' : 'Isométrica'}</button></div><div class="viewport" id="viewport"><div class="caption" id="caption"></div></div><div class="playback"><div class="row"><button id="play" class="primary">▶ Reproduzir</button><button id="restart" aria-label="Reiniciar prévia">↺</button><input id="scrub" type="range" min="0" max="60" step="0.01" value="0" aria-label="Tempo da prévia"><output id="time">00:00</output><select id="speed" aria-label="Velocidade da prévia"><option value="1">1×</option><option value="4">4×</option><option value="16">16×</option></select></div><div id="timeline"></div></div></section><aside class="panel right" id="right" aria-label="Propriedades da seleção"></aside></main>
    <footer class="footer"><span id="status" role="status"><span class="dot"></span>Projeto local</span><button id="undo">Desfazer</button><button id="redo">Refazer</button><button id="help">Ajuda</button><span id="performance"></span></footer>
    <input type="file" id="project-file" accept=".json,application/json" hidden><input type="file" id="asset-file" hidden>
    <dialog id="export-dialog"><div class="dialog-top"><h2>Exportar criação</h2><button data-close="export-dialog" aria-label="Fechar exportação">✕</button></div><p id="export-note"></p><div class="export-options" id="export-options"></div></dialog>
    <dialog id="help-dialog"><div class="dialog-top"><h2>${names[this.kind][1]}</h2><button data-close="help-dialog" aria-label="Fechar ajuda">✕</button></div><p>Salve um projeto JSON para continuar a edição. O projeto também é recuperado localmente neste navegador. Desfazer e refazer estão disponíveis nos botões e em Ctrl+Z / Ctrl+Shift+Z.</p><p id="help-detail"></p><p>Os arquivos exportados são criações deste laboratório. A integração com o jogo precisa ser implementada separadamente.</p></dialog>`;
    element('project-name').addEventListener('change', e => this.change(p => { p.name = (e.target as HTMLInputElement).value; }));
    element<HTMLSelectElement>('studio-nav').addEventListener('change', e => { location.href = `${(e.target as HTMLSelectElement).value}-system.html`; });
    element('open').onclick = () => element<HTMLInputElement>('project-file').click(); element('save').onclick = () => this.save(); element('export').onclick = () => this.exportDialog();
    element('play').onclick = () => { void this.toggle(); }; element('restart').onclick = () => { this.stop(); this.time = 0; this.preview(); this.readout(); };
    element('scrub').addEventListener('input', e => { this.stop(); this.time = Number((e.target as HTMLInputElement).value); this.preview(); this.readout(); });
    element('speed').addEventListener('change', e => { this.speed = Number((e.target as HTMLSelectElement).value); this.sound.setSpeed(this.speed); });
    element('undo').onclick = () => this.undo(false); element('redo').onclick = () => this.undo(true);
    element('help').onclick = () => element<HTMLDialogElement>('help-dialog').showModal();
    element('view-top').onclick = () => { this.map?.setMode(false); this.three?.setMode(false); element('view-top').classList.add('active'); element('view-iso').classList.remove('active'); };
    element('view-iso').onclick = () => { this.map?.setMode(true); this.three?.setMode(true); element('view-iso').classList.add('active'); element('view-top').classList.remove('active'); };
    document.querySelectorAll<HTMLElement>('[data-close]').forEach(control => { control.onclick = () => element<HTMLDialogElement>(control.dataset.close!).close(); });
    element('project-file').addEventListener('change', e => { const file = (e.target as HTMLInputElement).files?.[0]; if (file) void this.open(file); (e.target as HTMLInputElement).value = ''; });
    element('asset-file').addEventListener('change', e => { const file = (e.target as HTMLInputElement).files?.[0]; if (file) void this.importAsset(file); (e.target as HTMLInputElement).value = ''; });
  }
  private status(message: string, error = false) { element('status').textContent = message; element('status').classList.toggle('error', error); }
  private selectFirst() { const p = this.project; this.selected = p.kind === 'signal' ? p.phases[0]!.id : p.kind === 'traffic' ? p.flows[0]!.id : p.kind === 'transit' ? p.lines[0]!.id : p.kind === 'sound' ? p.sources[0]!.id : '0'; if (p.kind === 'transit') this.activeLine = this.selected; }
  private change(mutate: (p: Project) => void) {
    const before = JSON.stringify(this.project); this.stop();
    try { const draft = structuredClone(this.project); mutate(draft); const next = parseProject(JSON.stringify(draft), this.kind); if (JSON.stringify(next) === before) return; this.history.push(before); if (this.history.length > 60) this.history.shift(); this.future = []; trimSnapshots(this.history, this.future); this.project = next; this.time = Math.min(this.time, this.duration()); this.persist(); this.render(); }
    catch (error) { this.status(error instanceof Error ? error.message : String(error), true); this.render(false); }
  }
  private persist() { try { localStorage.setItem(`roadcraft-studio-${this.kind}`, JSON.stringify(this.project)); this.status('Alteração guardada neste navegador. Salve JSON para levar o projeto.'); } catch (error) { this.status(`Não foi possível guardar localmente: ${String(error)}. Use Salvar projeto.`, true); } }
  private undo(redo: boolean) { const from = redo ? this.future : this.history, to = redo ? this.history : this.future, saved = from.pop(); if (!saved) return; this.stop(); to.push(JSON.stringify(this.project)); trimSnapshots(this.history, this.future); this.project = parseProject(saved, this.kind); this.selectFirst(); this.time = Math.min(this.time, this.duration()); this.persist(); this.render(); }
  private async open(file: File) { try { if (file.size > 30_000_000) throw new Error('Projeto maior que 30 MB.'); const next = parseProject(await file.text(), this.kind); this.change(p => { Object.assign(p, next); }); this.selectFirst(); this.time = 0; this.render(); this.status(`Projeto aberto: ${file.name}`); } catch (error) { this.status(`Projeto recusado: ${error instanceof Error ? error.message : String(error)}`, true); } }
  private filename(extension: string) { return `${this.project.name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 65) || this.kind}.${extension}`; }
  private save() { download(JSON.stringify(this.project, null, 2), this.filename(`${this.kind}.json`), 'application/json'); this.status('Projeto JSON exportado.'); }
  private duration() { const p = this.project; return p.kind === 'signal' ? cycleDuration(p) : p.kind === 'traffic' || p.kind === 'animation' || p.kind === 'sound' ? p.duration : p.kind === 'transit' ? Math.max(60, ...p.lines.map(line => { try { return transitSchedule(p.network, line).tripSeconds; } catch { return 60; } })) : 60; }
  private stop() { this.playGeneration++; this.running = false; this.preparingSound = false; this.sound.stop(); element('play').textContent = '▶ Reproduzir'; }
  private async toggle() { if (this.running) { this.stop(); return; } const generation = ++this.playGeneration; try { if (this.time >= this.duration()) this.time = 0; this.running = true; element('play').textContent = 'Ⅱ Pausar'; if (this.project.kind === 'sound') { this.preparingSound = true; this.status('Preparando fontes sonoras…'); await this.sound.start(this.project, this.time, this.speed); } if (generation !== this.playGeneration) return; this.preparingSound = false; if (this.project.kind === 'sound') this.status('Prévia sonora em reprodução.'); } catch (error) { this.stop(); this.status(`Prévia recusada: ${String(error)}`, true); } }
  private preview() { this.map?.update(this.project, this.selected, this.time); this.three?.update(this.project, this.time); }
  private frame(now: number) { const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0; this.lastFrame = now;
    if (this.running && !this.preparingSound && !document.hidden) { this.time += dt * this.speed; const duration = this.duration(); if (this.time >= duration) { if (this.project.kind === 'signal' || this.project.kind === 'material' || this.project.kind === 'animation' && this.project.loop) this.time %= duration; else { this.time = duration; this.stop(); } } this.map?.tick(this.time); this.three?.tick(this.time, this.running); }
    if (now - this.lastReadout > 120) { this.lastReadout = now; this.readout(); } requestAnimationFrame(t => this.frame(t));
  }
  private readout() {
    element<HTMLInputElement>('scrub').value = String(this.time); element('time').textContent = `${seconds(this.time)} / ${seconds(this.duration())}`;
    if (this.project.kind === 'traffic' && this.map) { const result = this.map.metrics(); const area = document.getElementById('traffic-metrics'); if (area) area.innerHTML = metric('Partidas', String(result.departed)) + metric('Concluídas', String(result.completed)) + metric('Em viagem', String(result.active)) + metric('Viagem média', `${fixed(result.average)} s`); const time = document.getElementById('clock'); if (time) time.textContent = clock(this.project.start + this.time / 60); const comparison = document.getElementById('comparison'); if (comparison && this.baseline) comparison.textContent = `Referência: ${this.baseline.completed} concluídas / ${fixed(this.baseline.average)} s. Diferença atual: ${result.completed - this.baseline.completed} viagens / ${fixed(result.average - this.baseline.average)} s.`; }
    if (this.three) { const info = this.three.info(); element('performance').textContent = `${info.calls} chamadas · ${fixed(info.triangles, 0)} triângulos`; }
  }
  private render(updatePreview = true) {
    element<HTMLInputElement>('project-name').value = this.project.name; element<HTMLInputElement>('scrub').max = String(this.duration());
    element<HTMLButtonElement>('undo').disabled = !this.history.length; element<HTMLButtonElement>('redo').disabled = !this.future.length;
    element('preview-title').textContent = names[this.kind][1];
    element('tools').innerHTML = this.kind === 'traffic' || this.kind === 'transit' ? ['select', 'add', 'connect'].map((tool, i) => button(['Selecionar', '+ Ponto', 'Ligar pontos'][i]!, `tool-${tool}`, `class="${this.mode === tool ? 'active' : ''}"`)).join('') : this.kind === 'sound' ? button('+ Fonte', 'add-source') : this.kind === 'animation' ? button(this.seat ? 'Ocultar banco' : 'Mostrar banco', 'seat') : '';
    element('caption').textContent = this.kind === 'signal' ? 'Linhas tracejadas: movimentos da fase selecionada · pontos: sinais em reprodução' : this.kind === 'traffic' || this.kind === 'transit' ? this.mode === 'add' ? 'Clique no plano para criar um ponto.' : this.mode === 'connect' ? this.connectFrom ? 'Escolha o ponto de destino da via.' : 'Escolha o primeiro ponto da via.' : 'Arraste os pontos · coordenadas também disponíveis no painel' : this.kind === 'material' ? 'Arraste para girar · roda para aproximar · textura e PBR reais' : this.kind === 'animation' ? 'Manequim articulado · quadros em segundos · rotações em graus' : 'Arraste fontes ou o ouvinte · alcance em metros · áudio começa ao reproduzir';
    element('help-detail').textContent = this.kind === 'traffic' ? 'Esta prévia calcula demanda, rotas e tempos em fluxo livre. Não modela filas, colisões ou semáforos. A mesma semente mantém a composição dos veículos. Guarde uma referência no mesmo instante para comparar cenários.' : this.kind === 'animation' ? 'Selecione um quadro, ajuste as articulações e reproduza. O GLB inclui o manequim e as animações de seus nós; a ligação com o rig dos cidadãos do jogo é uma etapa separada.' : this.kind === 'material' ? 'As cores são sRGB e os controles usam o fluxo PBR de metalness/roughness. Importe uma textura ou use as superfícies procedurais. PNG exporta a textura; GLB leva geometria e material.' : this.kind === 'sound' ? 'Som espacial usa HRTF e atenuação inversa, com corte fora do alcance. Fontes geradas ou arquivos de áudio locais podem ser combinados. WAV exporta a mistura estéreo na posição atual do ouvinte.' : 'Crie e selecione elementos no painel esquerdo; ajuste propriedades à direita. Planta e Isométrica mostram o mesmo projeto. Use a linha do tempo para inspecionar a prévia.';
    switch (this.project.kind) { case 'signal': this.signalUI(); break; case 'traffic': this.trafficUI(); break; case 'transit': this.transitUI(); break; case 'material': this.materialUI(); break; case 'animation': this.animationUI(); break; case 'sound': this.soundUI(); break; }
    this.bind(); if (updatePreview) this.preview(); this.readout();
  }
  private bind() {
    for (const root of [element('left'), element('right'), element('tools'), element('timeline')]) {
      root.querySelectorAll<HTMLElement>('[data-pick]').forEach(b => { b.onclick = () => this.pick(b.dataset.pick!); });
      root.querySelectorAll<HTMLElement>('[data-action]').forEach(b => { b.onclick = () => this.action(b.dataset.action!); });
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach(input => input.addEventListener('change', () => { const value: string | boolean | number = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input instanceof HTMLInputElement && (input.type === 'number' || input.type === 'range') ? Number(input.value) : input.value; this.change(p => this.setField(p, input.dataset.field!, value)); }));
      root.querySelectorAll<HTMLInputElement>('[data-movement]').forEach(input => input.addEventListener('change', () => this.change(p => { if (p.kind !== 'signal') return; const phase = p.phases.find(v => v.id === this.selected)!; if (input.checked) phase.movements.push(input.dataset.movement!); else phase.movements = phase.movements.filter(id => id !== input.dataset.movement); })));
      root.querySelectorAll<HTMLInputElement>('[data-crossing]').forEach(input => input.addEventListener('change', () => this.change(p => { if (p.kind !== 'signal') return; const phase = p.phases.find(v => v.id === this.selected)!; if (input.checked) phase.crossings.push(input.dataset.crossing! as typeof sides[number]); else phase.crossings = phase.crossings.filter(id => id !== input.dataset.crossing); })));
    }
  }
  private setField(p: Project, field: string, value: string | boolean | number) {
    if (p.kind === 'signal' && /^assignments\.\d+\.(lane|exit)$/.test(field)) value = Number(value) - 1;
    if (p.kind === 'animation' && field === 'duration') { Object.assign(p, resizeClip(p, Number(value))); return; }
    if (p.kind === 'signal' && field === 'lanes') { p.assignments.forEach(a => { a.lane = Math.min(a.lane, Number(value) - 1); a.exit = Math.min(a.exit, Number(value) - 1); }); }
    let target = p as unknown as Record<string, unknown>; const path = field.split('.'), last = path.pop()!;
    for (const key of path) { if (!Object.hasOwn(target, key)) throw new Error('Campo desconhecido.'); target = target[key] as Record<string, unknown>; }
    if (!Object.hasOwn(target, last)) throw new Error('Campo desconhecido.'); target[last] = value;
  }
  private network(): Network | null { const p = this.project; return p.kind === 'traffic' || p.kind === 'transit' ? p.network : null; }
  private networkUI(net: Network): string { return `<h3>Rede de referência</h3>${rows(net.nodes, this.selected)}${note('Crie pontos na bancada e use Ligar pontos para desenhar vias. As vias novas têm dois sentidos. Selecione uma via abaixo para mudar isso.')}${rows(net.edges.map(e => ({ id: e.id, name: `${nodeById(net, e.from)!.name} → ${nodeById(net, e.to)!.name}` })), this.selected)}`; }
  private selectedNetworkUI(net: Network): string | null { const node = net.nodes.find(n => n.id === this.selected); if (node) { const i = net.nodes.indexOf(node); return `<h2>Ponto selecionado</h2>${field('Nome', `network.nodes.${i}.name`, node.name, 'text')}${field('X · metros', `network.nodes.${i}.x`, node.x, 'number', -10000, 10000, 1)}${field('Y · metros', `network.nodes.${i}.y`, node.y, 'number', -10000, 10000, 1)}${note('A mudança recalcula as rotas e as distâncias.')}`; }
    const edge = net.edges.find(e => e.id === this.selected); if (edge) { const i = net.edges.indexOf(edge); return `<h2>Via selecionada</h2>${field('Velocidade máxima · km/h', `network.edges.${i}.speed`, edge.speed, 'number', 1, 130)}${check('Dois sentidos', `network.edges.${i}.both`, edge.both)}${note(`${nodeById(net, edge.from)!.name} → ${nodeById(net, edge.to)!.name}`)}`; } return null;
  }
  private signalUI() {
    const p = this.project; if (p.kind !== 'signal') return; const i = Math.max(0, p.phases.findIndex(v => v.id === this.selected)), phase = p.phases[i]!; this.selected = phase.id;
    element('left').innerHTML = `<h2>Cruzamento</h2><div class="preset-row">${button('Simples', 'signal-simple')}${button('Avenida', 'signal-avenue')}${button('Com pedestres', 'signal-pedestrian')}</div><div class="section">${field('Faixas por sentido', 'lanes', p.lanes, 'number', 1, 4)}${field('Largura da faixa · m', 'width', p.width, 'number', 2.5, 4.5, 0.1)}${field('Raio da esquina · m', 'radius', p.radius, 'number', 2, 12, 0.5)}</div><h2>Fases do semáforo</h2>${rows(p.phases, this.selected)}${button('+ Adicionar fase', 'add-phase', 'class="full primary"')}<div class="row">${button('Subir', 'phase-up')}${button('Descer', 'phase-down')}</div>${button('Remover fase', 'remove-phase', `class="full danger" ${p.phases.length <= 1 ? 'disabled' : ''}`)}<div class="metrics">${metric('Ciclo completo', `${fixed(cycleDuration(p))} s`)}${metric('Fases', String(p.phases.length))}</div>`;
    const conflicts = signalConflicts(p, phase);
    element('right').innerHTML = `<h2>Fase selecionada</h2>${field('Nome da fase', `phases.${i}.name`, phase.name, 'text')}${field('Duração do verde · s', `phases.${i}.green`, phase.green, 'number', 1, 300, 0.5)}${field('Tempo de amarelo · s', `phases.${i}.amber`, phase.amber, 'number', 0.5, 15, 0.5)}${field('Vermelho geral · s', `phases.${i}.clearance`, phase.clearance, 'number', 0.5, 15, 0.5)}<h3>Movimentos por faixa de entrada</h3>${note('As trajetórias usam a primeira faixa de cada aproximação. Movimentos da mesma entrada compartilham o sinal.')}${sides.map(side => `<h3>${sideNames[side]}</h3>${movements.filter(m => m.startsWith(side)).map(m => `<label class="check"><input type="checkbox" data-movement="${m}" ${phase.movements.includes(m) ? 'checked' : ''}>${sideNames[side]} → ${sideNames[m[2] as typeof side]}</label>`).join('')}`).join('')}<h3>Travessias liberadas</h3>${sides.map(side => `<label class="check"><input type="checkbox" data-crossing="${side}" ${phase.crossings.includes(side) ? 'checked' : ''}>Travessia ${sideNames[side]}</label>`).join('')}<div class="warnings ${conflicts.length ? '' : 'ok'}">${conflicts.length ? `Conflitos nesta fase:<br>${conflicts.map(esc).join('<br>')}` : 'Nenhum conflito geométrico nesta fase.'}</div>`;
    const laneChoices = Array.from({ length: p.lanes }, (_, lane) => [String(lane), `Faixa ${lane + 1}`] as [string, string]);
    element('right').insertAdjacentHTML('beforeend', `<h3>Faixas dos movimentos liberados</h3>${phase.movements.map(m => { const index = p.assignments.findIndex(a => a.movement === m), a = p.assignments[index]!; return `<h3>${sideNames[m[0] as typeof sides[number]]} → ${sideNames[m[2] as typeof sides[number]]}</h3><div class="row">${field('Faixa de entrada', `assignments.${index}.lane`, a.lane + 1, 'number', 1, p.lanes)}${field('Faixa de saída', `assignments.${index}.exit`, a.exit + 1, 'number', 1, p.lanes)}</div>`; }).join('')}${note(`Faixa 1: próxima ao eixo da via. ${laneChoices.length} faixas por aproximação.`)}`);
    const movementNote = element('right').querySelector('.note'); if (movementNote) movementNote.textContent = 'Movimentos da mesma aproximação compartilham o sinal. Escolha as faixas de entrada e saída abaixo.';
    element('timeline').innerHTML = `<div class="timeline">${p.phases.map(phase => `<span style="flex:${phase.green};background:#8bbf48" title="${esc(phase.name)}"></span><span style="flex:${phase.amber};background:#e4bb56"></span><span style="flex:${phase.clearance};background:#d27360"></span>`).join('')}</div><div class="timeline-labels">${p.phases.map(phase => `<span>${esc(phase.name)} · ${fixed(phaseDuration(phase))} s</span>`).join('')}</div>`;
  }
  private trafficUI() {
    const p = this.project; if (p.kind !== 'traffic') return; const i = Math.max(0, p.flows.findIndex(f => f.id === this.selected)), flow = p.flows[i]!;
    element('left').innerHTML = `<h2>Origens e destinos</h2>${rows(p.flows, this.selected)}${button('+ Criar demanda', 'add-flow', 'class="full primary"')}${button('Remover demanda', 'remove-flow', `class="full danger" ${p.flows.length <= 1 || !p.flows.some(f => f.id === this.selected) ? 'disabled' : ''}`)}<h3>Cenário</h3>${field('Início · minuto do dia', 'start', p.start, 'number', 0, 1439)}${field('Duração · s', 'duration', p.duration, 'number', 30, 3600)}${field('Velocidade de cruzeiro · km/h', 'speed', p.speed, 'number', 5, 100)}${field('Semente', 'seed', p.seed, 'number', 1, 1000000)}<h3>Composição dos veículos</h3>${field('Ônibus · %', 'buses', p.buses, 'number', 0, 100)}${field('Caminhões · %', 'trucks', p.trucks, 'number', 0, 100)}${note(`Automóveis: ${100 - p.buses - p.trucks}%`)}${this.networkUI(p.network)}`;
    const network = this.selectedNetworkUI(p.network), route = shortestRoute(p.network, flow.from, flow.to);
    element('right').innerHTML = network ?? `<h2>Demanda selecionada</h2>${field('Nome', `flows.${i}.name`, flow.name, 'text')}${select('Origem', `flows.${i}.from`, flow.from, p.network.nodes.map(n => [n.id, n.name]))}${select('Destino', `flows.${i}.to`, flow.to, p.network.nodes.map(n => [n.id, n.name]))}${field('Veículos por hora', `flows.${i}.rate`, flow.rate, 'number', 0, 3600)}<h3>Horário de pico</h3>${field('Começa · minuto do dia', 'peakStart', p.peakStart, 'number', 0, 1439)}${field('Termina · minuto do dia', 'peakEnd', p.peakEnd, 'number', 0, 1439)}${field('Multiplicador', 'multiplier', p.multiplier, 'number', 1, 5, 0.1)}${note(`${clock(p.peakStart)}–${clock(p.peakEnd)} · taxa no início: ${fixed(demandRate(flow.rate, p.peakStart, p.peakEnd, p.multiplier, p.start), 0)} veículos/h`)}${route.length ? `<div class="warnings ok">Rota conectada · ${fixed(routeLength(p.network, route))} m</div>` : '<div class="warnings">Origem e destino sem rota.</div>'}<h3>Resultado · <span id="clock">${clock(p.start)}</span></h3><div class="metrics" id="traffic-metrics"></div>${button('Guardar referência atual', 'baseline', 'class="full"')}<p class="note" id="comparison"></p>${note('Prévia em fluxo livre: não inclui congestionamento, colisões ou sinais. Até 300 veículos são desenhados; os indicadores contam todas as partidas.')}`;
    element('timeline').innerHTML = '';
  }
  private transitUI() {
    const p = this.project; if (p.kind !== 'transit') return; const i = Math.max(0, p.lines.findIndex(v => v.id === this.activeLine)), line = p.lines[i]!; this.activeLine = line.id; this.activeStop = Math.min(this.activeStop, line.stops.length - 1);
    element('left').innerHTML = `<h2>Linhas de ônibus</h2>${rows(p.lines, this.selected)}${button('+ Criar linha', 'add-line', 'class="full primary"')}${button('Remover linha', 'remove-line', `class="full danger" ${p.lines.length <= 1 || !p.lines.some(v => v.id === this.selected) ? 'disabled' : ''}`)}<h3>Paradas da linha ${esc(line.name)}</h3><div class="list">${line.stops.map((id, index) => `<button data-action="stop-${index}"><span class="index">${index + 1}</span>${esc(nodeById(p.network, id)!.name)}</button>`).join('')}</div><label class="field"><span>Adicionar parada</span><select id="stop-choice">${p.network.nodes.map(n => `<option value="${esc(n.id)}">${esc(n.name)}</option>`).join('')}</select></label>${button('Adicionar à sequência', 'append-stop', 'class="full"')}${button('Remover última parada', 'remove-stop', `class="full danger" ${line.stops.length <= 2 ? 'disabled' : ''}`)}${this.networkUI(p.network)}`;
    element('left').querySelectorAll<HTMLButtonElement>('[data-action^="stop-"]').forEach((b, index) => { b.classList.toggle('active', index === this.activeStop); });
    element('left').insertAdjacentHTML('beforeend', `<h3>Parada selecionada: ${this.activeStop + 1}</h3><div class="row">${button('Parada ↑', 'stop-up')}${button('Parada ↓', 'stop-down')}</div>${note('Selecione uma parada na sequência acima para mudar sua ordem.')}`);
    let summary: string; try { const result = transitSchedule(p.network, line); summary = `<div class="metrics">${metric('Percurso', `${fixed(result.distance)} m`)}${metric('Tempo de ida', `${fixed(result.tripSeconds)} s`)}${metric('Frota mínima', String(result.fleet))}${metric('Oferta por hora', `${fixed(60 / line.headway * line.capacity, 0)} lugares`)}</div>${note(`Primeiras partidas: ${result.departures.slice(0, 5).map(clock).join(' · ')}`)}`; } catch (error) { summary = `<div class="warnings">${esc(error instanceof Error ? error.message : error)}</div>`; }
    element('right').innerHTML = this.selectedNetworkUI(p.network) ?? `<h2>Linha selecionada</h2>${field('Nome', `lines.${i}.name`, line.name, 'text')}${field('Cor da linha', `lines.${i}.color`, line.color, 'color')}${field('Intervalo · min', `lines.${i}.headway`, line.headway, 'number', 1, 120)}${field('Velocidade média · km/h', `lines.${i}.speed`, line.speed, 'number', 5, 80)}${field('Tempo em cada parada · s', `lines.${i}.dwell`, line.dwell, 'number', 0, 120)}${field('Primeira partida · minuto do dia', `lines.${i}.start`, line.start, 'number', 0, 1439)}${field('Última partida · minuto do dia', `lines.${i}.end`, line.end, 'number', 1, 1440)}${field('Capacidade · passageiros', `lines.${i}.capacity`, line.capacity, 'number', 1, 200)}${check('Incluir retorno na frota', `lines.${i}.returnTrip`, line.returnTrip)}${summary}${note('A prévia percorre a ida e mostra as esperas nas paradas. A frota inclui o retorno quando habilitado. Tempos são estimativas em fluxo livre.')}`;
    element('timeline').innerHTML = '';
  }
  private materialUI() {
    const p = this.project; if (p.kind !== 'material') return;
    element('left').innerHTML = `<h2>Superfícies</h2><div class="list">${['asphalt', 'concrete', 'brick', 'fabric', 'plain'].map((type, i) => button(['Asfalto', 'Concreto', 'Alvenaria', 'Tecido', 'Liso'][i]!, `material-${type}`, `class="${p.pattern === type ? 'active' : ''}"`)).join('')}</div><h3>Forma da amostra</h3>${select('Geometria', 'shape', p.shape, [['sphere', 'Esfera'], ['cube', 'Cubo'], ['plane', 'Placa de superfície']])}<h3>Textura local</h3>${button('Importar PNG / JPEG / WebP', 'import-texture', 'class="full"')}${button('Usar textura procedural', 'clear-texture', `class="full" ${!p.texture ? 'disabled' : ''}`)}${note(p.texture ? 'Textura importada e incorporada no projeto.' : 'Textura procedural determinística de 512 × 512 px.')}${note('Complemento para o fluxo do Asset Studio: a geometria de referência permite comparar superfícies sob a mesma iluminação.')}`;
    element('right').innerHTML = `<h2>Material PBR</h2>${field('Cor da superfície', 'color', p.color, 'color')}${field(`Rugosidade · ${fixed(p.roughness, 2)}`, 'roughness', p.roughness, 'range', 0, 1, 0.01)}${field(`Metallicidade · ${fixed(p.metalness, 2)}`, 'metalness', p.metalness, 'range', 0, 1, 0.01)}${field('Repetições da textura', 'scale', p.scale, 'number', 0.25, 20, 0.25)}${field(`Desgaste · ${fixed(p.wear, 2)}`, 'wear', p.wear, 'range', 0, 1, 0.01)}<div class="warnings ok">Material com reflexão de ambiente e fluxo metalness / roughness.</div>${note('Rugosidade 0: superfície polida. Rugosidade 1: superfície fosca. Vidro não é representado por este material opaco. O desgaste é aplicado à textura procedural.')}`;
    element('timeline').innerHTML = note('Reproduzir gira a amostra. GLB leva o material e a textura; PNG leva apenas a superfície.');
  }
  private animationUI() {
    const p = this.project; if (p.kind !== 'animation') return; const i = Math.max(0, Math.min(p.keys.length - 1, Number(this.selected) || 0)), key = p.keys[i]!;
    element('left').innerHTML = `<h2>Biblioteca de poses</h2><div class="preset-row">${button('Caminhada', 'pose-walk')}${button('Em pé', 'pose-stand')}${button('Motorista', 'pose-driver')}${button('Aceno', 'pose-wave')}${button('Sentar', 'pose-sit')}</div><h3>Clipe</h3>${field('Duração · s', 'duration', p.duration, 'number', 0.2, 30, 0.1)}${check('Repetir animação', 'loop', p.loop)}${note('Para mudar a duração, use o botão abaixo; os tempos dos quadros são reescalados.')}${button('Ajustar duração do clipe', 'duration-animation', 'class="full"')}<h3>Quadros-chave</h3>${rows(p.keys.map((k, index) => ({ id: String(index), name: `${fixed(k.time, 2)} s${index === 0 ? ' · início' : index === p.keys.length - 1 ? ' · fim' : ''}` })), String(i))}${button('Criar quadro neste instante', 'add-key', 'class="full primary"')}${button('Remover quadro', 'remove-key', `class="full danger" ${i === 0 || i === p.keys.length - 1 ? 'disabled' : ''}`)}${note('Manequim próprio com articulações hierárquicas. O GLB exporta rotações interpoladas dos nós e deslocamento do corpo.')}`;
    element('right').innerHTML = `<h2>Pose · ${fixed(key.time, 2)} s</h2>${i > 0 && i < p.keys.length - 1 ? field('Tempo do quadro · s', `keys.${i}.time`, key.time, 'number', p.keys[i - 1]!.time + 0.01, p.keys[i + 1]!.time - 0.01, 0.01) : note('Este quadro fixa o início ou o fim do clipe.')}<div class="joint-fields">${joints.map(joint => field(`${jointNames[joint]} · ${fixed(key.pose[joint], joint === 'height' ? 2 : 0)} ${joint === 'height' ? 'm' : '°'}`, `keys.${i}.pose.${joint}`, key.pose[joint], 'range', joint === 'height' ? -0.6 : -150, joint === 'height' ? 0.6 : 150, joint === 'height' ? 0.01 : 1)).join('')}</div>${note('Ombros e quadris: inclinação para frente/trás. Cotovelos e joelhos: flexão. Cabeça: giro horizontal. Ajuste com teclado para precisão.')}`;
    element('right').insertAdjacentHTML('afterbegin', check('Apoiar os pés no chão', 'grounded', p.grounded));
    element('timeline').innerHTML = `<div class="timeline" style="background:#dce5d6;position:relative">${p.keys.map((k, index) => `<button data-pick="${index}" aria-label="Selecionar quadro ${fixed(k.time, 2)} segundos" style="position:absolute;left:calc(${k.time / p.duration * 100}% - ${index === p.keys.length - 1 ? '8' : '0'}px);top:0;width:8px;height:13px;padding:0;background:${i === index ? '#38572e' : '#8bbf48'};border:0"></button>`).join('')}</div>`;
  }
  private soundUI() {
    const p = this.project; if (p.kind !== 'sound') return; const i = Math.max(0, p.sources.findIndex(v => v.id === this.selected)), source = p.sources[i]!;
    element('left').innerHTML = `<h2>Fontes sonoras</h2>${rows(p.sources, this.selected)}${button('+ Criar fonte', 'add-source', 'class="full primary"')}${button('Remover fonte', 'remove-source', `class="full danger" ${p.sources.length <= 1 || this.selected === 'listener' ? 'disabled' : ''}`)}<h3>Ouvinte</h3>${button('Selecionar ouvinte', 'listener', `class="full ${this.selected === 'listener' ? 'active' : ''}"`)}${field('Posição X · m', 'listener.x', p.listener.x, 'number', -10000, 10000)}${field('Posição Y · m', 'listener.y', p.listener.y, 'number', -10000, 10000)}<h3>Mixagem</h3>${field(`Volume geral · ${fixed(p.master, 2)}`, 'master', p.master, 'range', 0, 1, 0.01)}${field('Duração da prévia / WAV · s', 'duration', p.duration, 'number', 1, 30)}${note('Áudio inicia ao clicar Reproduzir. O ouvinte olha para o norte. Use fones para perceber a posição de cada fonte.')}`;
    element('right').innerHTML = this.selected === 'listener' ? `<h2>Ouvinte selecionado</h2>${note('Arraste o ponto escuro ou use as coordenadas no painel esquerdo. A mixagem WAV usa esta posição.')}<div class="metrics">${metric('Fontes ao alcance', String(p.sources.filter(s => distance(s, p.listener) <= s.radius).length))}</div>` : `<h2>Fonte selecionada</h2>${field('Nome', `sources.${i}.name`, source.name, 'text')}${select('Som gerado', `sources.${i}.type`, source.type, [['motor', 'Motor'], ['wind', 'Vento'], ['steps', 'Passos'], ['tone', 'Tom puro'], ...(source.audio ? [['file', 'Arquivo importado'] as [string, string]] : [])])}${button('Importar áudio local', 'import-audio', 'class="full"')}${field('Posição X · m', `sources.${i}.x`, source.x, 'number', -10000, 10000)}${field('Posição Y · m', `sources.${i}.y`, source.y, 'number', -10000, 10000)}${field('Frequência base · Hz', `sources.${i}.frequency`, source.frequency, 'number', 20, 2000)}${field(`Volume · ${fixed(source.volume, 2)}`, `sources.${i}.volume`, source.volume, 'range', 0, 1, 0.01)}${field('Alcance máximo · m', `sources.${i}.radius`, source.radius, 'number', 1, 200)}${field('Distância de referência · m', `sources.${i}.reference`, source.reference, 'number', 0.1, 50, 0.1)}${check('Repetir fonte', `sources.${i}.loop`, source.loop)}<div class="metrics">${metric('Distância', `${fixed(distance(source, p.listener))} m`)}${metric('Ganho no ouvinte', fixed(soundGain(distance(source, p.listener), source.reference, source.radius, source.volume), 3))}</div>${note('A fonte fica silenciosa fora do alcance. Dentro dele, o volume cai pela distância inversa. Arquivos importados ficam incorporados no projeto.')}`;
    element('timeline').innerHTML = note('WAV estéreo de 44,1 kHz · fontes procedurais e arquivos locais · posição espacial preservada');
  }
  private pick(id: string) { if (this.mode === 'connect' && this.network()?.nodes.some(n => n.id === id)) { if (!this.connectFrom) { this.connectFrom = id; this.selected = id; this.render(); return; } const from = this.connectFrom; this.connectFrom = ''; if (from === id) { this.status('Escolha dois pontos diferentes.', true); return; } this.change(p => { if (p.kind !== 'traffic' && p.kind !== 'transit') return; if (p.network.edges.some(e => e.from === from && e.to === id || e.both && e.from === id && e.to === from)) throw new Error('Estes pontos já têm uma ligação nesse sentido.'); p.network.edges.push({ id: this.id('r'), from, to: id, speed: 40, both: true }); }); return; }
    this.selected = id; if (this.project.kind === 'transit' && this.project.lines.some(line => line.id === id)) this.activeLine = id; if (this.project.kind === 'animation') { this.stop(); this.time = this.project.keys[Number(id)]!.time; } this.render();
  }
  private move(id: string, point: Point) { this.change(p => { if (p.kind === 'traffic' || p.kind === 'transit') { const node = nodeById(p.network, id); if (node) Object.assign(node, point); } else if (p.kind === 'sound') { const target = id === 'listener' ? p.listener : p.sources.find(s => s.id === id); if (target) Object.assign(target, point); } }); }
  private id(prefix: string) { return `${prefix}-${Date.now().toString(36)}-${Math.floor(performance.now() * 1000).toString(36)}`; }
  private addNode(point: Point) { const id = this.id('n'); this.change(p => { if (p.kind === 'traffic' || p.kind === 'transit') p.network.nodes.push({ id, name: `Ponto ${p.network.nodes.length + 1}`, ...point }); }); this.selected = id; this.render(); }
  private action(action: string) {
    if (/^stop-\d+$/.test(action)) { this.activeStop = Number(action.slice(5)); this.selected = this.activeLine; this.render(); return; }
    if (action.startsWith('tool-')) { this.mode = action.slice(5) as typeof this.mode; this.connectFrom = ''; if (this.map) this.map.tool = this.mode; this.render(); return; }
    if (action === 'seat') { this.seat = !this.seat; this.three?.showSeat(this.seat); this.render(); return; }
    if (action === 'listener') { this.pick('listener'); return; }
    if (action === 'baseline') { this.baseline = this.map!.metrics(); this.readout(); this.status('Referência guardada neste instante para comparação.'); return; }
    if (action === 'import-texture' || action === 'import-audio') { const input = element<HTMLInputElement>('asset-file'); input.accept = action === 'import-texture' ? 'image/png,image/jpeg,image/webp' : 'audio/*'; input.click(); return; }
    if (action === 'duration-animation') { const p = this.project; if (p.kind !== 'animation') return; const raw = window.prompt('Nova duração do clipe em segundos (0,2 a 30):', String(p.duration)); if (raw === null) return; const duration = Number(raw.replace(',', '.')); this.change(draft => { if (draft.kind === 'animation') { const ratio = duration / draft.duration; draft.keys.forEach(key => { key.time *= ratio; }); draft.duration = duration; } }); return; }
    if (action.startsWith('pose-')) { this.posePreset(action.slice(5)); return; }
    this.change(p => {
      if (p.kind === 'signal') {
        const i = Math.max(0, p.phases.findIndex(v => v.id === this.selected));
        if (action.startsWith('signal-')) { const fresh = createProject('signal'); if (fresh.kind !== 'signal') return; p.lanes = action === 'signal-avenue' ? 3 : 2; p.phases = fresh.phases; if (action === 'signal-pedestrian') p.phases.push({ id: this.id('p'), name: 'Pedestres', green: 18, amber: 1, clearance: 2, movements: [], crossings: [...sides] }); this.selected = p.phases[0]!.id; }
        else if (action === 'add-phase') { const id = this.id('p'); p.phases.push({ id, name: `Fase ${p.phases.length + 1}`, green: 20, amber: 3, clearance: 1, movements: [], crossings: [] }); this.selected = id; }
        else if (action === 'remove-phase' && p.phases.length > 1) { p.phases.splice(i, 1); this.selected = p.phases[Math.min(i, p.phases.length - 1)]!.id; }
        else if (action === 'phase-up' && i > 0) [p.phases[i - 1], p.phases[i]] = [p.phases[i]!, p.phases[i - 1]!];
        else if (action === 'phase-down' && i < p.phases.length - 1) [p.phases[i + 1], p.phases[i]] = [p.phases[i]!, p.phases[i + 1]!];
      } else if (p.kind === 'traffic') {
        if (action === 'add-flow') { const id = this.id('f'); p.flows.push({ id, name: `Demanda ${p.flows.length + 1}`, from: p.network.nodes[0]!.id, to: p.network.nodes[p.network.nodes.length - 1]!.id, rate: 120 }); this.selected = id; }
        if (action === 'remove-flow' && p.flows.length > 1) { p.flows = p.flows.filter(f => f.id !== this.selected); this.selected = p.flows[0]!.id; }
      } else if (p.kind === 'transit') {
        const line = p.lines.find(v => v.id === this.activeLine) ?? p.lines[0]!;
        if (action === 'add-line') { const id = this.id('l'); p.lines.push({ ...structuredClone(p.lines[0]!), id, name: `Linha ${p.lines.length + 1}`, color: '#8bbf48' }); this.selected = this.activeLine = id; }
        else if (action === 'remove-line' && p.lines.length > 1) { p.lines = p.lines.filter(v => v.id !== this.selected); this.selected = p.lines[0]!.id; }
        else if (action === 'append-stop') line.stops.push(element<HTMLSelectElement>('stop-choice').value);
        else if (action === 'remove-stop' && line.stops.length > 2) line.stops.pop();
        else if (action === 'stop-up' || action === 'stop-down') { const index = this.activeStop, next = index + (action === 'stop-up' ? -1 : 1); if (next >= 0 && next < line.stops.length) { [line.stops[index], line.stops[next]] = [line.stops[next]!, line.stops[index]!]; this.activeStop = next; } }
      } else if (p.kind === 'material') {
        if (action === 'clear-texture') p.texture = null;
        else if (action.startsWith('material-')) { p.pattern = action.slice(9) as typeof p.pattern; p.texture = null; const colors = { asphalt: '#535859', concrete: '#aaa99c', brick: '#9b6650', fabric: '#68826f', plain: '#a8ba8c' }; p.color = colors[p.pattern]; p.metalness = 0; p.roughness = p.pattern === 'fabric' ? 0.95 : 0.85; }
      } else if (p.kind === 'animation') {
        if (action === 'add-key') { if (p.keys.some(k => Math.abs(k.time - this.time) < 0.01)) throw new Error('Já existe um quadro neste instante. Mova a linha do tempo.'); const pose = interpolatePose(p, this.time); p.keys.push({ time: this.time, pose }); p.keys.sort((a, b) => a.time - b.time); this.selected = String(p.keys.findIndex(k => k.time === this.time)); }
        else if (action === 'remove-key') { const i = Number(this.selected); if (i > 0 && i < p.keys.length - 1) { p.keys.splice(i, 1); this.selected = String(i - 1); this.time = p.keys[i - 1]!.time; } }
      } else if (p.kind === 'sound') {
        if (action === 'add-source') { const id = this.id('s'); p.sources.push({ id, name: `Fonte ${p.sources.length + 1}`, x: 12, y: 8, type: 'wind', frequency: 100, volume: 0.25, radius: 35, reference: 2, loop: true, audio: null }); this.selected = id; }
        else if (action === 'remove-source' && p.sources.length > 1) { p.sources = p.sources.filter(v => v.id !== this.selected); this.selected = p.sources[0]!.id; }
      }
    });
  }
  private posePreset(type: string) {
    this.change(p => { if (p.kind !== 'animation') return; if (type === 'walk') { const fresh = createProject('animation') as AnimationProject; p.keys = fresh.keys.map(k => ({ ...k, time: k.time / fresh.duration * p.duration })); p.name = 'Caminhada'; }
      else { const pose: Pose = neutralPose();
        if (type === 'driver' || type === 'sit') Object.assign(pose, { leftLeg: -90, rightLeg: -90, leftKnee: 90, rightKnee: 90, height: -0.35 });
        if (type === 'driver') Object.assign(pose, { leftArm: -55, rightArm: -55, leftElbow: -35, rightElbow: -35 });
        const end = { ...pose }; if (type === 'wave') { pose.rightArm = -135; pose.rightElbow = -35; end.rightArm = -135; end.rightElbow = -90; }
        p.keys = [{ time: 0, pose }, { time: p.duration / 2, pose: end }, { time: p.duration, pose: { ...pose } }]; p.name = { stand: 'Em pé', driver: 'Motorista', wave: 'Aceno', sit: 'Sentado' }[type] ?? 'Pose';
      } this.selected = '0'; this.time = 0;
      p.grounded = type !== 'driver' && type !== 'sit';
    }); this.seat = type === 'driver' || type === 'sit'; this.three?.showSeat(this.seat); this.render();
  }
  private async importAsset(file: File) {
    try {
      const image = this.kind === 'material'; if (file.size > (image ? 5_000_000 : 8_000_000)) throw new Error(image ? 'Textura maior que 5 MB.' : 'Áudio maior que 8 MB.');
      if (image && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !image && !file.type.startsWith('audio/')) throw new Error('Tipo de arquivo não suportado.');
      const uri = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      if (image) { const img = new Image(); img.src = uri; await img.decode(); }
      else { const ctx = new AudioContext(); try { await ctx.decodeAudioData(await file.arrayBuffer()); } finally { await ctx.close(); } }
      this.change(p => { if (p.kind === 'material') p.texture = uri; else if (p.kind === 'sound') { const source = p.sources.find(s => s.id === this.selected) ?? p.sources[0]!; source.audio = uri; source.type = 'file'; source.name = file.name.slice(0, 100); } }); this.status(`Arquivo incorporado: ${file.name}`);
    } catch (error) { this.status(`Importação recusada: ${String(error)}`, true); }
  }
  private exportDialog() {
    const labels = this.kind === 'signal' ? [['signal-plan', 'Plano de sinais · JSON']] : this.kind === 'traffic' ? [['demand', 'Demanda e rede · JSON'], ['results', 'Resultados neste instante · CSV']] : this.kind === 'transit' ? [['lines', 'Linhas e rede · JSON'], ['timetable', 'Horários de partidas · CSV']] : this.kind === 'material' ? [['glb', 'Amostra com material e textura · GLB'], ['texture', 'Textura da superfície · PNG']] : this.kind === 'animation' ? [['glb', 'Manequim com animação · GLB']] : [['sound-scene', 'Cena sonora e arquivos incorporados · JSON'], ['wave', 'Mistura espacial estéreo · WAV']];
    element('export-note').textContent = 'Salve o projeto editável ou exporte sua criação. Esses arquivos não são instalados automaticamente no jogo.';
    element('export-options').innerHTML = button('Projeto editável · JSON', 'project') + labels.map(([id, label]) => button(label!, id!)).join('') + button('Imagem da bancada · PNG', 'screenshot');
    element('export-options').querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.onclick = () => { void this.export(b.dataset.action!); }; }); element<HTMLDialogElement>('export-dialog').showModal();
  }
  private async export(action: string) {
    const buttons = element('export-options').querySelectorAll<HTMLButtonElement>('button'); buttons.forEach(b => { b.disabled = true; });
    try {
      const p = this.project;
      if (action === 'project') this.save();
      else if (action === 'screenshot') { const canvas = this.three?.canvas ?? this.map!.canvas; const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG indisponível.')), 'image/png')); download(blob, this.filename('png'), 'image/png'); }
      else if (action === 'glb') { download(await this.three!.exportGLB(), this.filename('glb'), 'model/gltf-binary'); this.preview(); }
      else if (action === 'texture') download(await this.three!.exportTexture(), this.filename('texture.png'), 'image/png');
      else if (action === 'wave' && p.kind === 'sound') download(await this.sound.exportWave(p), this.filename('wav'), 'audio/wav');
      else if (action === 'signal-plan' && p.kind === 'signal') { const conflicts = p.phases.flatMap(phase => signalConflicts(p, phase).map(c => `${phase.name}: ${c}`)); if (conflicts.length) throw new Error(`Corrija os conflitos antes de exportar o plano: ${conflicts.join('; ')}`); download(JSON.stringify({ format: 'roadcraft-signal-plan/1', units: 'metres-seconds', name: p.name, lanes: p.lanes, width: p.width, radius: p.radius, assignments: p.assignments, cycle: cycleDuration(p), phases: p.phases }, null, 2), this.filename('signals.json'), 'application/json'); }
      else if (action === 'demand' && p.kind === 'traffic') { const missing = p.flows.filter(f => !shortestRoute(p.network, f.from, f.to).length); if (missing.length) throw new Error('Conecte todas as origens e destinos antes de exportar.'); download(JSON.stringify({ ...p, export: { units: 'metres-kmh-minutes', preview: 'free-flow', routes: p.flows.map(f => ({ flow: f.id, nodes: shortestRoute(p.network, f.from, f.to) })) } }, null, 2), this.filename('demand.json'), 'application/json'); }
      else if (action === 'results' && p.kind === 'traffic') { const result = this.map!.metrics(); download(csv([['Cenário', 'Tempo (s)', 'Partidas', 'Concluídas', 'Em viagem', 'Média (s)', 'Modelo'], [p.name, this.time.toFixed(2), result.departed, result.completed, result.active, result.average.toFixed(2), 'Fluxo livre']]), this.filename('results.csv'), 'text/csv'); }
      else if (action === 'lines' && p.kind === 'transit') { const schedules = p.lines.map(line => ({ line: line.id, ...transitSchedule(p.network, line) })); download(JSON.stringify({ ...p, export: { units: 'metres-kmh-minutes-seconds', schedules } }, null, 2), this.filename('lines.json'), 'application/json'); }
      else if (action === 'timetable' && p.kind === 'transit') { const table: unknown[][] = [['Linha', 'Partida', 'Partida (min)', 'Chegada estimada (min)', 'Frota mínima']]; for (const line of p.lines) { const schedule = transitSchedule(p.network, line); for (const t of schedule.departures) table.push([line.name, clock(t), t, (t + schedule.tripSeconds / 60).toFixed(2), schedule.fleet]); } download(csv(table), this.filename('timetable.csv'), 'text/csv'); }
      else if (action === 'sound-scene' && p.kind === 'sound') download(JSON.stringify(p, null, 2), this.filename('sound-scene.json'), 'application/json');
      this.status('Exportação gerada.'); element<HTMLDialogElement>('export-dialog').close();
    } catch (error) { this.status(`Exportação recusada: ${error instanceof Error ? error.message : String(error)}`, true); element('export-note').textContent = `Exportação recusada: ${error instanceof Error ? error.message : String(error)}`; }
    finally { buttons.forEach(b => { b.disabled = false; }); }
  }
}

try { new Studio(); } catch (error) { document.body.innerHTML = `<main style="padding:32px;font:16px 'Segoe UI',sans-serif"><h1>Não foi possível abrir este editor</h1><p>${esc(error instanceof Error ? error.message : error)}</p><p>Confira se o navegador oferece Canvas 2D, WebGL 2 e Web Audio.</p></main>`; console.error(error); }
