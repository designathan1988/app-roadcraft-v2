// Editor FORMA 2: estado, seleção, ferramentas, ações, interface e API pública.
// Portado da lógica do FORMA v1 e adaptado ao modelo forma/2.
import * as THREE from 'three';
import type { Building, FacadePattern, ID, Limits, Project, RoofKind, Vec2 } from '../core/schema';
import { DEFAULT_LIMITS } from '../core/schema';
import { loadProject, emptyProject } from '../core';
import { History } from '../core/history';
import { Emitter } from '../core/events';
import { edgeConfig } from '../core/model';
import { bounds, clamp, clean, shape, validPolygon } from '../geometry/polygon';
import { validHoles } from '../geometry/boolean';
import { findEdge, massEdges } from '../geometry/ring';
import { toLocal } from '../geometry/frame';
import * as ops from './ops';
import { EditorScene, type HandleData, type SceneHost } from './scene';
import { exampleProject } from './example';
import { createShell, type Shell, type UiLevel } from '../ui/shell';
import { hydrate } from '../ui/icons';
import { inspectorHTML, layersHTML, shelfHTML, helpHTML, NEW_HTML, type Defaults, type PanelState, type VolumeView } from '../ui/panels';
import * as persist from '../io/persistence';
import { download, exportGLB as glb, exportJSON as json, exportOBJ as obj, filename } from '../io/export';

export type Tool = 'select' | 'draw' | 'polygon' | 'extrude' | 'move' | 'cut' | 'window' | 'door' | 'opening' | 'editpoints';

export interface EditorOptions extends SceneHost {
  /** Contêiner da interface. Obrigatório quando ui ≠ 'none'. */
  container?: HTMLElement;
  project?: unknown;
  ui?: 'full' | 'none';
  level?: UiLevel;
  limits?: Partial<Limits>;
  /** Salvamento automático no navegador (false desliga). */
  storage?: false | { key: string };
  /** Abre o projeto de exemplo quando não há projeto salvo. */
  example?: boolean;
}

export interface EditorEvents extends Record<string, unknown> {
  ready: void;
  change: { reason: string };
  commit: { message: string };
  selection: { ids: ID[]; edgeId: ID | null; mode: 'object' | 'face' };
  tool: { tool: Tool };
  error: { message: string };
}

interface Drag {
  type: string;
  [k: string]: unknown;
}

/** Número no formato brasileiro (vírgula decimal, sinal de menos tipográfico). */
const fmt = (n: number, digits = 1): string => n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace('-', '−');

const HINTS: Record<string, string> = {
  select: 'Selecione uma parte. Arraste as alças para transformar.',
  draw: 'Arraste no chão para criar um volume. No topo, crie outro andar.',
  polygon: 'Clique os vértices. Enter ou duplo clique fecha a base. Esc cancela.',
  extrude: 'Arraste o topo ou a alça vertical para puxar a altura.',
  move: 'Arraste o volume para mover. Alt permite movimento livre.',
  cut: 'Selecione um volume e desenhe o recorte. Pode criar um pátio ou dividir a base.',
  window: 'Arraste sobre uma parede para desenhar uma janela real.',
  door: 'Arraste sobre uma parede para desenhar uma porta.',
  opening: 'Arraste sobre uma parede para abrir um vão sem vidro.',
  editpoints: 'Arraste os pontos da base para remodelar o contorno.',
};

export class Editor {
  readonly events = new Emitter<EditorEvents>();
  readonly scene: EditorScene;
  private shell: Shell | null = null;
  private project: Project;
  private history: History<Project>;
  private limits: Limits;
  private storageKey: string | null;
  private selected = new Set<ID>();
  private edgeId: ID | null = null;
  private mode: 'object' | 'face' = 'object';
  private tool: Tool = 'select';
  private tab = 'volumes';
  private snap = true;
  private gridSize = 1;
  private drag: Drag | null = null;
  private sketch: Vec2[] = [];
  private sketchY = 0;
  private repeatCount = 3;
  private repeatSpace = 2;
  private defaults: Defaults = { shape: 'rect', height: 9.6, floors: 3, color: '#b77b56', roof: 'flat' };
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingMove: PointerEvent | null = null;
  private moveFrame = 0;
  private touches = new Map<number, { x: number; y: number }>();
  private cleanup: (() => void)[] = [];
  private disposed = false;

  constructor(opts: EditorOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.storageKey = opts.storage === false ? null : (opts.storage?.key ?? persist.KEY_V2);
    const ui = opts.ui ?? (opts.container ? 'full' : 'none');
    let viewport: HTMLElement;
    if (ui === 'full') {
      if (!opts.container) throw new Error('createEditor: informe o contêiner da interface.');
      const level = (opts.level ?? (persist.readPreference('forma_ui_level') as UiLevel | null) ?? 'simple') as UiLevel;
      this.shell = createShell(opts.container, level);
      viewport = this.shell.viewport;
    } else {
      viewport = opts.renderer?.domElement.parentElement ?? opts.container ?? document.body;
    }
    this.scene = new EditorScene(viewport, opts);

    // Projeto inicial: informado, salvo no navegador ou exemplo.
    let initial: Project | null = null;
    let restoreError: string | undefined;
    if (opts.project !== undefined) initial = loadProject(opts.project, this.limits);
    else if (this.storageKey) {
      const r = persist.restore(this.storageKey, this.limits);
      initial = r.project;
      restoreError = r.error;
    }
    this.project = initial ?? (opts.example === false ? emptyProject() : exampleProject());
    this.history = new History(this.project);
    if (this.project.buildings.length && !opts.project) this.selected.add(this.project.buildings[Math.min(2, this.project.buildings.length - 1)]!.id);

    this.bindCanvas();
    if (this.shell) this.bindUI();
    this.scene.rebuild(this.project.buildings);
    this.scene.buildEnvironment(this.project.buildings);
    this.scene.fitView();
    this.updateGizmos();
    this.renderUI();
    this.updateHint();
    this.saveLocal();
    if (this.shell) {
      this.shell.$('#loading').classList.add('hidden');
      this.shell.app.dataset.ready = 'true';
    }
    if (restoreError) this.toast('O projeto salvo não pôde ser aberto e foi guardado à parte: ' + restoreError);
    queueMicrotask(() => this.events.emit('ready', undefined));
  }

  // ── Consultas ───────────────────────────────────────────────────────
  private byId = (id: ID): Building | undefined => this.project.buildings.find((b) => b.id === id);
  private selectedBuilding = (): Building | undefined => this.project.buildings.find((b) => this.selected.has(b.id));
  private selectedList = (): Building[] => this.project.buildings.filter((b) => this.selected.has(b.id));
  private $ = <T extends HTMLElement = HTMLElement>(sel: string): T => this.shell!.$<T>(sel);
  private $$ = <T extends HTMLElement = HTMLElement>(sel: string): T[] => this.shell!.$$<T>(sel);

  private view(b: Building): VolumeView {
    const m = ops.mainMass(b);
    const cfg = edgeConfig(m, this.mode === 'face' && this.edgeId ? m.edges[this.edgeId] : undefined);
    const bd = bounds(ops.outerOf(b));
    return {
      id: b.id,
      name: b.name,
      height: ops.heightOf(b),
      floors: ops.floorsOf(b),
      base: ops.baseOf(b),
      area: ops.footprintArea(b),
      width: bd.maxX - bd.minX,
      depth: bd.maxZ - bd.minZ,
      rotation: b.rotation,
      color: cfg.wall,
      trim: cfg.trim,
      pattern: cfg.pattern,
      windowWidth: cfg.windowWidth,
      windowHeight: cfg.windowHeight,
      spacing: cfg.spacing,
      balconies: cfg.balconies,
      brise: cfg.brise,
      cornice: m.flags.cornice,
      garden: m.flags.garden,
      pilotis: m.flags.pilotis,
      roof: m.roof.kind,
      roofColor: m.roof.color,
      roofHeight: m.roof.height,
    };
  }

  private faceLabel(b: Building): string | null {
    if (this.mode !== 'face' || !this.edgeId) return null;
    const i = massEdges(ops.mainMass(b)).findIndex((e) => e.id === this.edgeId);
    return i >= 0 ? 'Face ' + (i + 1) : null;
  }

  // ── Interface ───────────────────────────────────────────────────────
  private panelState(): PanelState {
    const b = this.selectedBuilding();
    return {
      view: b ? this.view(b) : null,
      faceLabel: b ? this.faceLabel(b) : null,
      selectedCount: this.selected.size,
      defaults: this.defaults,
      tool: this.tool,
      tab: this.tab,
      section: this.scene.section,
      repeatCount: this.repeatCount,
      repeatSpace: this.repeatSpace,
    };
  }

  private renderInspector(): void {
    if (!this.shell) return;
    this.$('#inspector-inner').innerHTML = inspectorHTML(this.panelState());
    hydrate(this.$('#inspector'));
  }

  private renderShelf(): void {
    if (!this.shell) return;
    this.$('#shelf-content').innerHTML = shelfHTML(this.panelState());
    hydrate(this.$('#shelf-content'));
  }

  private renderLayers(): void {
    if (!this.shell) return;
    this.$('#layers').innerHTML = layersHTML(this.project.buildings.map((b) => ({ id: b.id, name: b.name, floors: ops.floorsOf(b), selected: this.selected.has(b.id) })));
  }

  private refreshStatus(): void {
    if (!this.shell) return;
    const s = ops.projectStats(this.project);
    this.$('#status-metric').textContent = `${s.buildings} ${s.buildings === 1 ? 'volume' : 'volumes'} · ${Math.round(s.builtArea).toLocaleString('pt-BR')} m²`;
  }

  private renderUI(): void {
    if (!this.shell) return;
    this.renderInspector();
    this.renderShelf();
    this.renderLayers();
    this.refreshStatus();
    this.$<HTMLInputElement>('#project-name').value = this.project.name;
    this.$<HTMLButtonElement>('#undo').disabled = !this.history.canUndo;
    this.$<HTMLButtonElement>('#redo').disabled = !this.history.canRedo;
    this.$$('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === this.mode));
    this.$$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === this.tab));
  }

  private updateHint(): void {
    if (this.shell) this.$('#hint').textContent = HINTS[this.tool] ?? HINTS.select!;
  }

  toast(message: string): void {
    if (!this.shell) {
      this.events.emit('error', { message });
      return;
    }
    clearTimeout(this.toastTimer);
    const t = this.$('#toast');
    t.textContent = message;
    t.classList.add('show');
    this.toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  }

  private modal(html: string): void {
    this.$('#modal').innerHTML = html;
    this.$('#modal-backdrop').style.display = 'flex';
    hydrate(this.$('#modal'));
  }

  private closeModal(): void {
    this.$('#modal-backdrop').style.display = 'none';
  }

  // ── Persistência e histórico ────────────────────────────────────────
  private saveLocal(): void {
    if (!this.storageKey) return;
    const ok = persist.save(this.project, this.storageKey);
    if (this.shell) this.$('#save-state').textContent = ok ? 'Salvo neste navegador' : 'Use Salvar para baixar';
  }

  private commit(message = ''): void {
    if (this.history.commit(this.project)) this.events.emit('commit', { message });
    this.saveLocal();
    this.scene.buildEnvironment(this.project.buildings);
    this.renderUI();
    this.events.emit('change', { reason: message || 'commit' });
    if (message) this.toast(message);
  }

  private rebuild(ids: ID[] | null = null): void {
    this.scene.rebuild(this.project.buildings, ids);
    this.updateGizmos();
  }

  /** Aplica `fn` a cada edifício selecionado, reconstrói e registra. */
  private mutate(fn: (b: Building) => void, message = ''): void {
    const ids = [...this.selected];
    for (const b of this.selectedList()) fn(b);
    this.rebuild(ids);
    this.commit(message);
  }

  private restore(which: 'undo' | 'redo'): void {
    if (this.drag) return;
    if (which === 'undo' ? !this.history.canUndo : !this.history.canRedo) return;
    this.project = this.history[which]();
    this.selected = new Set([...this.selected].filter((id) => this.byId(id)));
    this.edgeId = null;
    this.rebuild();
    this.scene.buildEnvironment(this.project.buildings);
    this.saveLocal();
    this.renderUI();
    this.events.emit('change', { reason: which });
    this.toast(which === 'undo' ? 'Ação desfeita.' : 'Ação refeita.');
  }

  /** Troca o projeto inteiro (abrir, exemplo, mapa vazio). Ctrl+Z volta ao anterior. */
  private replaceProject(p: Project, message = ''): void {
    this.project = p;
    this.selected.clear();
    this.edgeId = null;
    this.scene.section = false;
    this.rebuild();
    this.commit(message);
    this.scene.fitView();
  }

  // ── Seleção e ferramentas ───────────────────────────────────────────
  private select(id: ID | null, edge: ID | null = null, add = false, showContext = false, e: PointerEvent | null = null): void {
    if (!add) this.selected.clear();
    if (id) {
      if (add && this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    }
    this.edgeId = edge;
    this.updateGizmos();
    this.renderUI();
    if (this.shell) {
      const ctx = this.$('#context');
      if (showContext && e && id) {
        const r = this.scene.renderer.domElement.getBoundingClientRect();
        ctx.style.left = clamp(e.clientX - r.left - 85, 8, r.width - 190) + 'px';
        ctx.style.top = clamp(e.clientY - r.top - 48, 55, r.height - 48) + 'px';
        ctx.style.display = 'flex';
      } else ctx.style.display = 'none';
    }
    this.scene.mark();
    this.events.emit('selection', { ids: [...this.selected], edgeId: this.edgeId, mode: this.mode });
  }

  setTool(next: Tool): void {
    this.tool = next;
    this.sketch = [];
    this.scene.disposeGroup(this.scene.sketch);
    if (this.shell) {
      this.$('#context').style.display = 'none';
      this.$$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === next));
    }
    this.updateGizmos();
    this.renderShelf();
    this.updateHint();
    this.scene.renderer.domElement.style.cursor = ['draw', 'polygon', 'cut', 'window', 'door', 'opening'].includes(next) ? 'crosshair' : next === 'move' ? 'move' : 'default';
    this.scene.mark();
    this.events.emit('tool', { tool: next });
  }

  private updateGizmos(): void {
    const sc = this.scene;
    sc.disposeGroup(sc.gizmos);
    const list = this.selectedList();
    for (const b of list) {
      if (!sc.built.has(b.id)) continue;
      const m = ops.mainMass(b),
        base = ops.baseOf(b),
        h = ops.heightOf(b);
      const pts = ops.outerOf(b);
      const bottom = pts.map((p) => sc.toWorld(b, p, base)),
        top = pts.map((p) => sc.toWorld(b, p, base + h + 0.2));
      sc.line(bottom, '#f09b56', true);
      sc.line(top, '#f09b56', true);
      pts.forEach((_, i) => {
        if (pts.length < 12 || i % 4 === 0) sc.line([bottom[i]!, top[i]!]);
      });
      if (list.length !== 1) continue;
      const bd = bounds(pts),
        center: Vec2 = [(bd.minX + bd.maxX) / 2, (bd.minZ + bd.maxZ) / 2];
      const end = sc.toWorld(b, center, base + h + 2.2);
      sc.line([sc.toWorld(b, center, base + h + 0.22), end]);
      sc.handle(end, { kind: 'height', id: b.id });
      sc.cone(end);
      if (this.tool === 'editpoints') pts.forEach((p, i) => sc.handle(sc.toWorld(b, p, base + 0.1), { kind: 'vertex', id: b.id, index: i }, true));
      else
        for (const [sx, sz] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const)
          sc.handle(sc.toWorld(b, [sx ? bd.maxX : bd.minX, sz ? bd.maxZ : bd.minZ], base + 0.16), { kind: 'resize', id: b.id, sx, sz });
      if (this.mode === 'face' && this.edgeId) {
        const e = findEdge(m, this.edgeId);
        if (e) sc.line([sc.toWorld(b, e.a, base + 0.03), sc.toWorld(b, e.b, base + 0.03), sc.toWorld(b, e.b, base + h), sc.toWorld(b, e.a, base + h)], '#ffb270', true);
      }
    }
    sc.mark();
  }

  // ── Propriedades e ações ────────────────────────────────────────────
  private applyProperty(prop: string, value: string | number | boolean): void {
    const b = this.selectedBuilding();
    if (!b) {
      if (['height', 'floors', 'color', 'roof', 'width', 'depth'].includes(prop)) {
        if (prop === 'floors') {
          const n = Math.round(clamp(Number(value), 1, 30));
          this.defaults.height = ops.r2(clamp((this.defaults.height / this.defaults.floors) * n, 0.5, 100));
          value = n;
        }
        (this.defaults as unknown as Record<string, unknown>)[prop] = value;
        this.renderShelf();
      }
      return;
    }
    const face = this.mode === 'face' && this.edgeId ? this.edgeId : null;
    const facadeProps: Record<string, ops.EdgeProp> = { color: 'wall', trim: 'trim', windowWidth: 'windowWidth', windowHeight: 'windowHeight', spacing: 'spacing', balconies: 'balconies', brise: 'brise' };
    this.mutate((n) => {
      const m = ops.mainMass(n);
      if (prop === 'name') {
        n.name = m.name = String(value).slice(0, 60) || 'Volume';
      } else if (prop === 'width' || prop === 'depth') ops.scaleFootprint(n, prop, Number(value));
      else if (prop === 'floors') ops.setFloors(n, Number(value));
      else if (prop === 'height') ops.setHeight(n, Number(value));
      else if (prop === 'base') ops.setBase(n, Number(value));
      else if (prop === 'rotation') ops.setRotation(n, Number(value));
      else if (prop === 'roofHeight') m.roof.height = clamp(Number(value), 0.2, 10);
      else if (prop === 'roofColor') m.roof.color = String(value);
      else if (prop === 'roof') ops.setRoof(n, value as RoofKind);
      else if (prop === 'cornice' || prop === 'garden' || prop === 'pilotis') ops.setFlag(n, prop, !!value);
      else if (facadeProps[prop]) ops.setFacadeProp(n, face && n.id === b.id ? face : null, facadeProps[prop]!, value);
    });
  }

  private doAction(action: string): void {
    const b = this.selectedBuilding();
    if (action === 'section') {
      this.scene.section = !this.scene.section;
      if (this.shell) this.$('#section-toggle').classList.toggle('active', this.scene.section);
      this.rebuild();
      this.renderShelf();
      return;
    }
    if (action === 'help') return this.modal(helpHTML());
    if (action === 'new') return this.modal(NEW_HTML);
    if (!b) {
      this.toast('Selecione um volume primeiro.');
      return;
    }
    if (action === 'delete') {
      const ids = [...this.selected];
      this.project.buildings = this.project.buildings.filter((n) => !this.selected.has(n.id));
      this.selected.clear();
      this.edgeId = null;
      this.rebuild(ids);
      this.commit('Seleção removida. Ctrl+Z desfaz.');
    } else if (action === 'floor') {
      if (ops.floorsOf(b) >= 30) return this.toast('Máximo de 30 andares por volume.');
      this.mutate((n) => ops.setFloors(n, ops.floorsOf(n) + 1), 'Andar adicionado.');
    } else if (action === 'setback') {
      this.addBuildings([ops.setback(b)], 'Volume criado. Puxe a alça superior para ajustar a altura.');
    } else if (action === 'duplicate' || action === 'repeat') {
      const count = action === 'repeat' ? this.repeatCount : 1;
      const room = this.limits.maxBuildings - this.project.buildings.length;
      const copies = ops.repeatBuildings(this.selectedList(), count, this.repeatSpace).slice(0, Math.max(0, room));
      if (!copies.length) return this.toast(`Limite de ${this.limits.maxBuildings} volumes por projeto.`);
      this.project.buildings.push(...copies);
      this.selected = new Set(copies.map((c) => c.id));
      this.edgeId = null;
      this.rebuild(copies.map((c) => c.id));
      this.commit(copies.length + ' cópia(s) criada(s).');
    } else if (action === 'union') {
      try {
        const sources = this.selectedList();
        const parts = ops.unionBuildings(sources);
        this.replaceBuildings(sources, parts, 'Bases unidas em uma geometria contínua.');
      } catch (e) {
        this.toast((e as Error).message);
      }
    } else if (action === 'mirror') {
      this.mutate((n) => ops.mirror(n), 'Base espelhada.');
    } else if (action === 'window-tool' || action === 'door-tool') {
      this.mode = 'face';
      this.setTool(action === 'window-tool' ? 'window' : 'door');
      this.renderUI();
    } else if (action === 'apply-face-all') {
      if (!this.edgeId || !ops.mainMass(b).edges[this.edgeId]) return this.toast('Personalize uma face primeiro.');
      const edge = this.edgeId;
      this.mutate((n) => {
        if (n.id === b.id) ops.applyEdgeToAll(n, edge);
      }, 'Configuração aplicada ao volume inteiro.');
    }
  }

  private addBuildings(list: Building[], message: string): void {
    if (this.project.buildings.length + list.length > this.limits.maxBuildings) {
      this.toast(`Limite de ${this.limits.maxBuildings} volumes por projeto.`);
      return;
    }
    this.project.buildings.push(...list);
    this.selected = new Set(list.map((b) => b.id));
    this.edgeId = null;
    this.rebuild(list.map((b) => b.id));
    this.commit(message);
  }

  private replaceBuildings(sources: Building[], parts: Building[], message: string): void {
    const ids = sources.map((s) => s.id);
    const at = this.project.buildings.findIndex((x) => x.id === ids[0]);
    this.project.buildings = this.project.buildings.filter((x) => !ids.includes(x.id));
    this.project.buildings.splice(Math.max(0, Math.min(at, this.project.buildings.length)), 0, ...parts);
    this.selected = new Set(parts.map((p) => p.id));
    this.edgeId = null;
    this.rebuild([...ids, ...parts.map((p) => p.id)]);
    this.commit(message);
  }

  private newVolume(input: Omit<ops.VolumeInput, 'name'>): void {
    if (this.project.buildings.length >= this.limits.maxBuildings) return this.toast(`Limite de ${this.limits.maxBuildings} volumes por projeto.`);
    const pts = clean(input.points);
    if (!validPolygon(pts)) return this.toast('A base se cruza ou é pequena demais.');
    const name = 'Volume ' + String(this.project.buildings.length + 1).padStart(2, '0');
    this.addBuildings([ops.newBuilding({ ...input, name })], 'Volume criado. Puxe a alça superior para ajustar a altura.');
  }

  // ── Exportação ──────────────────────────────────────────────────────
  async exportFile(kind: 'json' | 'png' | 'glb' | 'obj'): Promise<void> {
    if (this.shell) this.$('#export-menu').classList.remove('open');
    const p = this.project;
    if (kind === 'json') {
      download(json(p), filename(p, 'json'), 'application/json');
      return this.toast('Projeto editável baixado.');
    }
    if (kind === 'png') {
      this.scene.renderNow();
      this.scene.renderer.domElement.toBlob((blob) => blob && download(blob, filename(p, 'png'), 'image/png'));
      return this.toast('Imagem da construção exportada.');
    }
    if (!p.buildings.length) return this.toast('Crie uma construção para exportar.');
    if (this.scene.section) return this.toast('Desative o corte horizontal para exportar o modelo completo.');
    if (kind === 'glb') {
      this.toast('Preparando modelo GLB…');
      try {
        download(await glb(this.scene.modelRoot), filename(p, 'glb'), 'model/gltf-binary');
        this.toast('GLB exportado com geometria e materiais.');
      } catch (e) {
        console.error(e);
        this.toast('Falha ao exportar GLB: ' + (e as Error).message);
      }
      return;
    }
    download(obj(this.scene.modelRoot), filename(p, 'obj'), 'text/plain');
    this.toast('Geometria OBJ exportada em metros.');
  }

  // ── Interface: eventos ──────────────────────────────────────────────
  private listen<K extends keyof HTMLElementEventMap>(el: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions): void {
    el.addEventListener(type, fn as EventListener, opts);
    this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  private bindUI(): void {
    const app = this.shell!.app;
    this.listen(app, 'click', (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b || !app.contains(b)) return;
      const d = b.dataset;
      if (b.id) {
        const actions: Record<string, () => void> = {
          new: () => this.modal(NEW_HTML),
          help: () => this.modal(helpHTML()),
          save: () => {
            this.saveLocal();
            void this.exportFile('json');
          },
          import: () => this.$<HTMLInputElement>('#file-input').click(),
          export: () => this.$('#export-menu').classList.toggle('open'),
          undo: () => this.restore('undo'),
          redo: () => this.restore('redo'),
          fit: () => this.scene.fitView(),
          'view-top': () => {
            this.scene.phi = 0.025;
            this.scene.theta = 0;
            this.scene.updateCamera();
          },
          'view-perspective': () => {
            this.scene.phi = 1.06;
            this.scene.theta = 0.68;
            this.scene.updateCamera();
          },
          'section-toggle': () => this.doAction('section'),
          'layers-toggle': () => {
            const l = this.$('#layers');
            l.style.display = l.style.display === 'block' ? 'none' : 'block';
            this.$('#layers-toggle').classList.toggle('active', l.style.display === 'block');
          },
          'snap-toggle': () => {
            this.snap = !this.snap;
            this.$('#snap-toggle').innerHTML = `<span class="status-dot" style="opacity:${this.snap ? 1 : 0.25}"></span>Snap: ${this.snap ? 'ativado' : 'livre'}`;
          },
          'lighting-toggle': () => {
            this.scene.setNight(!this.scene.night);
            this.$('#lighting-toggle').classList.toggle('active', this.scene.night);
          },
          'ui-level': () => {
            const next: UiLevel = app.dataset.level === 'advanced' ? 'simple' : 'advanced';
            this.shell!.setLevel(next);
            persist.writePreference('forma_ui_level', next);
            this.toast(next === 'advanced' ? 'Modo avançado: todos os controles visíveis.' : 'Modo simples: só o essencial.');
          },
        };
        if (actions[b.id]) return actions[b.id]!();
      }
      if (d.tab) {
        this.tab = d.tab;
        this.renderUI();
      } else if (d.tool) {
        if (['window', 'door', 'opening'].includes(d.tool)) this.mode = 'face';
        this.setTool(d.tool as Tool);
        this.renderUI();
      } else if (d.shape) {
        this.defaults.shape = d.shape;
        this.setTool(d.shape === 'polygon' ? 'polygon' : 'draw');
      } else if (d.mode) {
        this.mode = d.mode as 'object' | 'face';
        this.edgeId = null;
        if (this.mode === 'object' && ['window', 'door', 'opening'].includes(this.tool)) this.setTool('select');
        this.updateGizmos();
        this.renderUI();
      } else if (d.action) this.doAction(d.action);
      else if (d.select) this.select(d.select, null, e.ctrlKey || e.metaKey);
      else if (d.color) this.applyProperty('color', d.color);
      else if (d.roof) {
        this.defaults.roof = d.roof;
        this.applyProperty('roof', d.roof);
      } else if (d.facade) {
        const sel = this.selectedBuilding();
        if (!sel) return this.toast('Selecione uma construção ou uma face.');
        const face = this.mode === 'face' ? this.edgeId : null;
        this.mutate((n) => ops.applyPattern(n, face && n.id === sel.id ? face : null, d.facade as FacadePattern), 'Fachada atualizada.');
      } else if (d.toggle) {
        const sel = this.selectedBuilding();
        if (!sel) return this.toast('Selecione um volume.');
        const v = this.view(sel) as unknown as Record<string, unknown>;
        this.applyProperty(d.toggle, !v[d.toggle]);
      } else if (d.export) void this.exportFile(d.export as 'json');
      else if (d.modal) {
        if (d.modal === 'close') this.closeModal();
        else if (d.modal === 'empty') {
          this.closeModal();
          this.replaceProject(emptyProject());
          this.setTool('draw');
          this.toast('Arraste no chão para desenhar sua primeira base.');
        } else if (d.modal === 'example') {
          this.closeModal();
          const p = exampleProject();
          this.replaceProject(p);
          this.select(p.buildings[2]?.id ?? null);
          this.setTool('select');
        }
      }
    });
    this.listen(app, 'change', (e: Event) => {
      const el = e.target as HTMLInputElement;
      if (el.id === 'project-name') {
        this.project.name = el.value.slice(0, 70) || 'Projeto sem título';
        return this.commit();
      }
      if (el.id === 'grid-size') {
        this.gridSize = Number(el.value);
        return this.scene.setGrid(this.gridSize);
      }
      if (el.id === 'repeat-count') this.repeatCount = Math.round(clamp(Number(el.value), 1, 12));
      else if (el.id === 'repeat-space') this.repeatSpace = clamp(Number(el.value), 0, 30);
      else if (el.id === 'file-input') void this.openFile(el);
      else if (el.dataset.prop) {
        let val: string | number = el.value;
        if (el.type === 'number') {
          val = Number(val);
          if (!Number.isFinite(val)) return;
          val = clamp(val, Number(el.min || -1000), Number(el.max || 1000));
        }
        this.applyProperty(el.dataset.prop, val);
      }
    });
    this.listen(app, 'pointerdown', (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.dropdown-wrap')) this.$('#export-menu').classList.remove('open');
    });
    this.listen(this.$('#modal-backdrop'), 'click', (e: MouseEvent) => {
      if (e.target === this.$('#modal-backdrop')) this.closeModal();
    });
    this.listen(app.ownerDocument, 'keydown', (e: KeyboardEvent) => this.onKey(e));
  }

  private async openFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 5e6) throw new Error('Projeto maior que 5 MB.');
      let raw: unknown;
      try {
        raw = JSON.parse(await file.text());
      } catch {
        throw new Error('o arquivo não é um JSON válido.');
      }
      this.replaceProject(loadProject(raw, this.limits), 'Projeto aberto.');
      this.setTool('select');
    } catch (err) {
      this.toast('Não foi possível abrir: ' + (err as Error).message);
    }
    input.value = '';
  }

  private onKey(e: KeyboardEvent): void {
    if (this.disposed) return;
    const modalOpen = this.shell && this.$('#modal-backdrop').style.display === 'flex';
    if (e.key === 'Escape') {
      if (modalOpen) return this.closeModal();
      this.cancelDrag();
      this.setTool('select');
      return;
    }
    const tag = (e.target as HTMLElement).tagName;
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.saveLocal();
      void this.exportFile('json');
      return;
    }
    if (editing || modalOpen) return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (key === 'z') {
        e.preventDefault();
        this.restore(e.shiftKey ? 'redo' : 'undo');
      } else if (key === 'y') {
        e.preventDefault();
        this.restore('redo');
      } else if (key === 'd') {
        e.preventDefault();
        this.doAction('duplicate');
      } else if (key === 'a') {
        e.preventDefault();
        this.selected = new Set(this.project.buildings.map((b) => b.id));
        this.edgeId = null;
        this.updateGizmos();
        this.renderUI();
      } else if (key === 'o' && this.shell) {
        e.preventDefault();
        this.$<HTMLInputElement>('#file-input').click();
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.doAction('delete');
    } else if (e.key === 'Enter' && this.tool === 'polygon') {
      e.preventDefault();
      this.finishPolygon();
    } else if (key === 'f') this.scene.fitView();
    else if (key === '?' && this.shell) this.modal(helpHTML());
    else {
      const map: Record<string, Tool> = { v: 'select', b: 'draw', p: 'polygon', e: 'extrude', g: 'move', c: 'cut' };
      if (map[key]) this.setTool(map[key]!);
    }
  }

  // ── Ponteiro: desenho, alças, mover, recortar, aberturas ────────────
  private snapN = (n: number): number => (this.snap ? Math.round(n / this.gridSize) * this.gridSize : n);

  /** Ponto do mundo → [x local, y acima da base da massa, z local]. */
  private localPoint(b: Building, p: THREE.Vector3): [number, number, number] {
    const [x, z] = toLocal(b, [p.x, p.z]);
    return [x, p.y - ops.baseOf(b), z];
  }

  private preview(points: Vec2[], y: number, close = true): void {
    const sc = this.scene;
    sc.disposeGroup(sc.sketch);
    if (points.length < 2) return sc.mark();
    sc.line(points.map((p) => new THREE.Vector3(p[0], y + 0.04, p[1])), '#c57130', close, sc.sketch);
    if (points.length >= 3 && validPolygon(points)) {
      const s = new THREE.Shape();
      points.forEach((p, i) => (i ? s.lineTo(p[0], -p[1]) : s.moveTo(p[0], -p[1])));
      s.closePath();
      const m = new THREE.Mesh(new THREE.ShapeGeometry(s), new THREE.MeshBasicMaterial({ color: '#e5924d', transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = y + 0.035;
      sc.sketch.add(m);
    }
    sc.mark();
  }

  private rectPoints(a: Vec2, b: Vec2): Vec2[] {
    const x1 = Math.min(a[0], b[0]),
      x2 = Math.max(a[0], b[0]),
      z1 = Math.min(a[1], b[1]),
      z2 = Math.max(a[1], b[1]);
    return [[x1, z1], [x2, z1], [x2, z2], [x1, z2]];
  }

  private showDimension(text: string, e: PointerEvent): void {
    if (!this.shell) return;
    const r = this.scene.renderer.domElement.getBoundingClientRect(),
      el = this.$('#dimension');
    el.textContent = text;
    el.style.display = 'block';
    el.style.left = clamp(e.clientX - r.left + 14, 10, r.width - 150) + 'px';
    el.style.top = clamp(e.clientY - r.top - 28, 10, r.height - 30) + 'px';
  }

  private hideDimension(): void {
    if (this.shell) this.$('#dimension').style.display = 'none';
  }

  private finishPolygon(): void {
    if (this.sketch.length < 3) return this.toast('Marque pelo menos três vértices.');
    const p = clean(this.sketch);
    if (!validPolygon(p)) return this.toast('O contorno se cruza ou é pequeno demais. Esc reinicia.');
    const bd = bounds(p),
      cx = (bd.minX + bd.maxX) / 2,
      cz = (bd.minZ + bd.maxZ) / 2;
    this.newVolume({ points: p.map((a) => [a[0] - cx, a[1] - cz]), position: [cx, cz], base: ops.r2(this.sketchY), height: this.defaults.height, floors: this.defaults.floors, color: this.defaults.color, roof: this.defaults.roof as RoofKind });
    this.setTool('select');
  }

  private cancelDrag(): void {
    const snapshot = this.drag?.snapshot as Project | undefined;
    if (snapshot) {
      this.project = snapshot;
      this.rebuild();
      this.renderUI();
    }
    this.drag = null;
    this.sketch = [];
    this.scene.disposeGroup(this.scene.sketch);
    this.hideDimension();
    this.scene.mark();
  }

  private beginHeight(b: Building, e: PointerEvent): void {
    const bd = bounds(ops.outerOf(b));
    const p = this.scene.toWorld(b, [(bd.minX + bd.maxX) / 2, (bd.minZ + bd.maxZ) / 2], ops.baseOf(b) + ops.heightOf(b));
    const a = this.scene.worldToScreen(p),
      q = this.scene.worldToScreen(p.clone().add(new THREE.Vector3(0, 1, 0)));
    this.drag = { type: 'height', id: b.id, original: structuredClone(b), snapshot: structuredClone(this.project), startY: e.clientY, pixels: Math.max(4, Math.abs(q.y - a.y)) };
  }

  private beginOpening(picked: ReturnType<EditorScene['pick']>): boolean {
    if (!picked || !picked.data.edgeId || picked.data.part !== 'wall' && !['window', 'door', 'void', 'storefront'].includes(picked.data.part)) {
      this.toast('Desenhe a abertura sobre uma parede.');
      return false;
    }
    const b = this.byId(picked.data.buildingId);
    if (!b) return false;
    const e = findEdge(ops.mainMass(b), picked.data.edgeId);
    if (!e) return false;
    const tx = (e.b[0] - e.a[0]) / e.length,
      tz = (e.b[1] - e.a[1]) / e.length;
    const local = this.localPoint(b, picked.hit.point);
    const x = (local[0] - e.a[0]) * tx + (local[2] - e.a[1]) * tz;
    const g = this.scene.built.get(b.id)!.group;
    const origin = new THREE.Vector3(e.a[0], 0, e.a[1]).applyMatrix4(g.matrixWorld),
      normal = new THREE.Vector3(tz, 0, -tx).transformDirection(g.matrixWorld);
    this.mode = 'face';
    this.select(b.id, e.id);
    this.drag = { type: 'opening', id: b.id, edgeId: e.id, a: e.a, len: e.length, tx, tz, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin), start: [x, local[1]], end: [x, local[1]], snapshot: structuredClone(this.project), kind: this.tool };
    return true;
  }

  private bindCanvas(): void {
    const el = this.scene.renderer.domElement;
    this.listen(el, 'contextmenu', (e: Event) => e.preventDefault());
    this.listen(el, 'pointerdown', (e: PointerEvent) => this.onPointerDown(e));
    this.listen(el, 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
    this.listen(el, 'pointerup', (e: PointerEvent) => this.onPointerUp(e));
    this.listen(el, 'pointercancel', (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      this.cancelDrag();
    });
    this.listen(el, 'dblclick', () => {
      if (this.tool !== 'polygon') return;
      const s = this.sketch;
      if (s.length > 1 && Math.hypot(s.at(-1)![0] - s.at(-2)![0], s.at(-1)![1] - s.at(-2)![1]) < 0.1) s.pop();
      this.finishPolygon();
    });
    this.listen(
      el,
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        this.scene.distance *= Math.exp(e.deltaY * 0.001);
        this.scene.updateCamera();
      },
      { passive: false },
    );
  }

  private capture(e: PointerEvent): void {
    try {
      this.scene.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* ponteiro sintético ou já liberado */
    }
  }

  private onPointerDown(e: PointerEvent): void {
    const sc = this.scene;
    if (this.shell) this.$('#context').style.display = 'none';
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        this.cancelDrag();
        const ps = [...this.touches.values()];
        this.drag = { type: 'touch-orbit', theta: sc.theta, phi: sc.phi, distance: sc.distance, center: [(ps[0]!.x + ps[1]!.x) / 2, (ps[0]!.y + ps[1]!.y) / 2], span: Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y) };
        this.capture(e);
        return;
      }
    }
    if (e.button === 2 || e.button === 1 || (e.shiftKey && e.button === 0)) {
      this.drag = { type: 'orbit', startX: e.clientX, startY: e.clientY, theta: sc.theta, phi: sc.phi, target: sc.target.clone(), pan: e.shiftKey || e.button === 1 };
      this.capture(e);
      return;
    }
    if (e.button !== 0) return;
    const handle = this.tool === 'select' || this.tool === 'editpoints' ? sc.pickHandle(e) : null;
    const picked = handle ? null : sc.pick(e);
    const tool = this.tool;
    if (handle) {
      const b = this.byId(handle.id);
      if (!b) return;
      if (handle.kind === 'height') this.beginHeight(b, e);
      else this.drag = { type: handle.kind, id: handle.id, sx: handle.sx, sz: handle.sz, index: handle.index, original: structuredClone(b), snapshot: structuredClone(this.project) };
    } else if (tool === 'draw' || tool === 'cut') {
      const b = this.selectedBuilding();
      if (tool === 'cut' && !b) return this.toast('Selecione o volume que deseja recortar.');
      const y = tool === 'draw' && picked?.data.part === 'roof' ? picked.hit.point.y : 0;
      const p = sc.planePoint(e, y);
      if (!p) return;
      const s: Vec2 = [this.snapN(p.x), this.snapN(p.z)];
      this.drag = { type: tool, id: b?.id, start: s, end: s, y, snapshot: structuredClone(this.project) };
    } else if (tool === 'polygon') {
      if (!this.sketch.length) this.sketchY = picked?.data.part === 'roof' ? picked.hit.point.y : 0;
      this.drag = { type: 'polygon-click', clientX: e.clientX, clientY: e.clientY };
    } else if (tool === 'window' || tool === 'door' || tool === 'opening') {
      if (!this.beginOpening(picked)) return;
    } else if (tool === 'extrude') {
      if (!picked) return this.toast('Selecione o topo da construção para puxar.');
      this.select(picked.data.buildingId);
      const b = this.selectedBuilding();
      if (b) this.beginHeight(b, e);
    } else if (tool === 'move') {
      if (!picked) return;
      if (!this.selected.has(picked.data.buildingId)) this.select(picked.data.buildingId);
      const b = this.selectedBuilding()!;
      const p = sc.planePoint(e, ops.baseOf(b));
      if (!p) return;
      this.drag = { type: 'move', id: b.id, start: p, y: ops.baseOf(b), originals: this.selectedList().map((n) => ({ id: n.id, position: [...n.position] })), snapshot: structuredClone(this.project) };
    } else {
      if (picked) this.select(picked.data.buildingId, this.mode === 'face' ? (picked.data.edgeId ?? null) : null, e.ctrlKey || e.metaKey, this.mode === 'face', e);
      else this.select(null);
    }
    if (this.drag) this.capture(e);
  }

  private onPointerMove(e: PointerEvent): void {
    const sc = this.scene;
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const d = this.drag;
      if (d?.type === 'touch-orbit' && this.touches.size >= 2) {
        const ps = [...this.touches.values()];
        const cx = (ps[0]!.x + ps[1]!.x) / 2,
          cy = (ps[0]!.y + ps[1]!.y) / 2,
          span = Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y);
        const center = d.center as number[];
        sc.theta = (d.theta as number) - (cx - center[0]!) * 0.006;
        sc.phi = (d.phi as number) - (cy - center[1]!) * 0.006;
        sc.distance = ((d.distance as number) * (d.span as number)) / Math.max(span, 10);
        sc.updateCamera();
        return;
      }
    }
    if (this.drag) {
      this.pendingMove = e;
      if (!this.moveFrame)
        this.moveFrame = requestAnimationFrame(() => {
          this.moveFrame = 0;
          if (this.drag && this.pendingMove) this.updateDrag(this.pendingMove);
        });
      return;
    }
    if (this.tool === 'polygon' && this.sketch.length) {
      const p = sc.planePoint(e, this.sketchY);
      if (p) this.preview([...this.sketch, [this.snapN(p.x), this.snapN(p.z)]], this.sketchY, false);
    } else if (this.tool === 'select' || this.tool === 'editpoints') {
      const h = sc.pickHandle(e);
      sc.renderer.domElement.style.cursor = h ? (h.kind === 'height' ? 'ns-resize' : 'crosshair') : sc.pick(e) ? 'pointer' : 'default';
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.drag?.type === 'touch-orbit') {
        if (this.touches.size < 2) this.drag = null;
        return;
      }
    }
    if (this.moveFrame) {
      cancelAnimationFrame(this.moveFrame);
      this.moveFrame = 0;
    }
    this.pendingMove = null;
    this.finishDrag(e);
    const el = this.scene.renderer.domElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  private updateDrag(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const sc = this.scene;
    if (d.type === 'orbit') {
      const dx = e.clientX - (d.startX as number),
        dy = e.clientY - (d.startY as number);
      if (d.pan) {
        const units = sc.distance * 0.00095,
          right = new THREE.Vector3().setFromMatrixColumn(sc.camera.matrix, 0),
          up = new THREE.Vector3().setFromMatrixColumn(sc.camera.matrix, 1);
        sc.target.copy(d.target as THREE.Vector3).addScaledVector(right, -dx * units).addScaledVector(up, dy * units);
      } else {
        sc.theta = (d.theta as number) - dx * 0.006;
        sc.phi = (d.phi as number) - dy * 0.006;
      }
      sc.updateCamera();
      return;
    }
    if (d.type === 'polygon-click') return;
    if (d.type === 'draw' || d.type === 'cut') {
      const p = sc.planePoint(e, d.y as number);
      if (!p) return;
      d.end = [this.snapN(p.x), this.snapN(p.z)];
      const s = d.start as Vec2,
        en = d.end as Vec2;
      this.preview(this.rectPoints(s, en), d.y as number);
      this.showDimension(`${fmt(Math.abs(en[0] - s[0]))} × ${fmt(Math.abs(en[1] - s[1]))} m`, e);
      return;
    }
    const idx = this.project.buildings.findIndex((n) => n.id === d.id);
    if (idx < 0) return;
    const b = this.project.buildings[idx]!;
    if (d.type === 'height') {
      const original = d.original as Building;
      const oh = ops.heightOf(original),
        of = ops.floorsOf(original),
        fh = oh / of;
      const free = oh - (e.clientY - (d.startY as number)) / (d.pixels as number);
      const n = structuredClone(original);
      if (e.altKey || !this.snap) {
        const h = clamp(free, 0.5, 100);
        ops.setStoreys(n, Math.round(clamp(h / fh, 1, 30)), h);
      } else {
        const floors = Math.round(clamp(free / fh, 1, 30));
        ops.setStoreys(n, floors, floors * fh);
      }
      this.project.buildings[idx] = n;
      this.rebuild([n.id]);
      this.showDimension(`${fmt(ops.heightOf(n))} m · ${ops.floorsOf(n)} ${ops.floorsOf(n) === 1 ? 'andar' : 'andares'}`, e);
      this.renderInspector();
      this.refreshStatus();
      return;
    }
    if (d.type === 'move') {
      const p = sc.planePoint(e, d.y as number);
      if (!p) return;
      const start = d.start as THREE.Vector3;
      const dx = p.x - start.x,
        dz = p.z - start.z;
      for (const o of d.originals as { id: ID; position: Vec2 }[]) {
        const n = this.byId(o.id);
        if (n) n.position = [e.altKey ? o.position[0] + dx : this.snapN(o.position[0] + dx), e.altKey ? o.position[1] + dz : this.snapN(o.position[1] + dz)];
      }
      this.rebuild((d.originals as { id: ID }[]).map((o) => o.id));
      this.showDimension(`x ${fmt(b.position[0])} · z ${fmt(b.position[1])} m`, e);
      return;
    }
    if (d.type === 'resize' || d.type === 'vertex') {
      const original = d.original as Building;
      const p = sc.planePoint(e, ops.baseOf(original) + 0.16);
      if (!p) return;
      const local = this.localPoint(original, p),
        x = e.altKey ? local[0] : this.snapN(local[0]),
        z = e.altKey ? local[2] : this.snapN(local[2]);
      const n = structuredClone(original);
      if (d.type === 'vertex') {
        const pts = ops.outerOf(original);
        pts[d.index as number] = [x, z];
        if (validPolygon(pts) && validHoles(pts, ops.holesOf(original)) && ops.setFootprint(n, pts)) {
          this.project.buildings[idx] = n;
          this.rebuild([n.id]);
        }
        this.showDimension(`x ${fmt(x)} · z ${fmt(z)} m`, e);
      } else {
        const bd = bounds(ops.outerOf(original)),
          ax = d.sx ? bd.minX : bd.maxX,
          az = d.sz ? bd.minZ : bd.maxZ,
          nx = d.sx ? Math.max(ax + 0.5, x) : Math.min(ax - 0.5, x),
          nz = d.sz ? Math.max(az + 0.5, z) : Math.min(az - 0.5, z),
          minX = Math.min(ax, nx),
          minZ = Math.min(az, nz),
          w = Math.abs(nx - ax),
          dep = Math.abs(nz - az);
        const map = (q: Vec2): Vec2 => [minX + ((q[0] - bd.minX) * w) / (bd.maxX - bd.minX), minZ + ((q[1] - bd.minZ) * dep) / (bd.maxZ - bd.minZ)];
        if (ops.setFootprint(n, ops.outerOf(original).map(map), ops.holesOf(original).map((h) => h.map(map)))) {
          this.project.buildings[idx] = n;
          this.rebuild([n.id]);
        }
        this.showDimension(`${fmt(w)} × ${fmt(dep)} m`, e);
      }
      this.renderInspector();
      this.refreshStatus();
      return;
    }
    if (d.type === 'opening') {
      const p = new THREE.Vector3();
      if (!sc.pointerRay(e).ray.intersectPlane(d.plane as THREE.Plane, p)) return;
      const q = this.localPoint(b, p),
        a = d.a as Vec2,
        tx = d.tx as number,
        tz = d.tz as number,
        len = d.len as number;
      const sx = (q[0] - a[0]) * tx + (q[2] - a[1]) * tz;
      d.end = [clamp(sx, 0.08, len - 0.08), clamp(q[1], 0.015, ops.heightOf(b) - 0.08)];
      const r = this.rectPoints(d.start as Vec2, d.end as Vec2);
      sc.disposeGroup(sc.sketch);
      const base = ops.baseOf(b);
      sc.line(r.map((pp) => sc.toWorld(b, [a[0] + tx * pp[0] + tz * 0.12, a[1] + tz * pp[0] - tx * 0.12], base + pp[1])), '#f09b56', true, sc.sketch);
      const s = d.start as Vec2,
        en = d.end as Vec2;
      this.showDimension(`${fmt(Math.abs(en[0] - s[0]), 2)} × ${fmt(Math.abs(en[1] - s[1]), 2)} m`, e);
      sc.mark();
    }
  }

  private finishDrag(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.updateDrag(e);
    this.drag = null;
    this.hideDimension();
    this.scene.disposeGroup(this.scene.sketch);
    if (d.type === 'orbit') return;
    if (d.type === 'polygon-click') {
      if (Math.hypot(e.clientX - (d.clientX as number), e.clientY - (d.clientY as number)) > 5) return;
      const p = this.scene.planePoint(e, this.sketchY);
      if (!p) return;
      const q: Vec2 = [this.snapN(p.x), this.snapN(p.z)];
      const s = this.sketch;
      if (s.length >= 3 && Math.hypot(q[0] - s[0]![0], q[1] - s[0]![1]) < this.gridSize * 0.55) return this.finishPolygon();
      if (!s.length || Math.hypot(q[0] - s.at(-1)![0], q[1] - s.at(-1)![1]) > 0.1) s.push(q);
      this.preview(s, this.sketchY, false);
      return;
    }
    if (d.type === 'draw') {
      const s = d.start as Vec2,
        en = d.end as Vec2;
      let w = Math.abs(en[0] - s[0]),
        dep = Math.abs(en[1] - s[1]),
        x = (s[0] + en[0]) / 2,
        z = (s[1] + en[1]) / 2;
      if (w < 0.3 && dep < 0.3) {
        w = this.defaults.width ?? 10;
        dep = this.defaults.depth ?? 8;
        x = s[0];
        z = s[1];
      }
      if (w < 0.5 || dep < 0.5) return this.toast('Desenhe uma base com pelo menos 0,5 m de cada lado.');
      this.newVolume({ points: shape(this.defaults.shape, w, dep), position: [x, z], base: ops.r2(d.y as number), height: this.defaults.height, floors: this.defaults.floors, color: this.defaults.color, roof: this.defaults.roof as RoofKind });
      this.setTool('select');
      return;
    }
    if (d.type === 'cut') {
      const b = this.byId(d.id as ID);
      if (!b) return;
      try {
        const parts = ops.cutBuilding(b, this.rectPoints(d.start as Vec2, d.end as Vec2));
        if (!parts) return this.toast('O recorte não alcançou a base.');
        this.replaceBuildings([b], parts, parts.length > 1 ? 'Volume dividido.' : parts.length ? 'Pátio ou recorte criado.' : 'Volume removido pelo recorte.');
        this.setTool('select');
      } catch (err) {
        this.toast((err as Error).message);
      }
      return;
    }
    if (d.type === 'opening') {
      const b = this.byId(d.id as ID);
      if (!b) return;
      const s = d.start as Vec2,
        en = d.end as Vec2,
        len = d.len as number,
        H = ops.heightOf(b);
      let x = Math.min(s[0], en[0]),
        y = Math.min(s[1], en[1]),
        w = Math.abs(en[0] - s[0]),
        h = Math.abs(en[1] - s[1]);
      const kind = d.kind as string;
      const clicked = w < 0.2 && h < 0.2;
      if (clicked) {
        const m = ops.mainMass(b);
        w = Math.min(m.facade.windowWidth, len - 0.3);
        h = kind === 'door' ? Math.min(2.4, H - 0.2) : Math.min(m.facade.windowHeight, H - 0.2);
        x = s[0] - w / 2;
        y = s[1] - h / 2;
      }
      if (kind === 'door') {
        if (!clicked) h = y + h;
        y = 0.015;
      }
      w = clamp(w, 0.3, len - 0.16);
      h = clamp(h, 0.3, H - 0.1);
      x = clamp(x, 0.08, len - w - 0.08);
      y = clamp(y, 0.015, H - h - 0.04);
      ops.addOpening(b, { edgeId: d.edgeId as ID, x, width: w, y, height: h, kind: kind === 'opening' ? 'void' : (kind as 'window' | 'door') });
      this.edgeId = d.edgeId as ID;
      this.rebuild([b.id]);
      this.commit('Abertura desenhada na parede.');
      return;
    }
    this.commit();
  }

  // ── API pública ─────────────────────────────────────────────────────
  getProject(): Project {
    return structuredClone(this.project);
  }

  load(raw: unknown): void {
    this.replaceProject(loadProject(raw, this.limits));
  }

  getSelection(): { ids: ID[]; edgeId: ID | null; mode: 'object' | 'face' } {
    return { ids: [...this.selected], edgeId: this.edgeId, mode: this.mode };
  }

  selectIds(ids: ID[]): void {
    this.selected = new Set(ids.filter((id) => this.byId(id)));
    this.edgeId = null;
    this.updateGizmos();
    this.renderUI();
  }

  getView(): { theta: number; phi: number; distance: number; target: number[] } {
    const s = this.scene;
    return { theta: s.theta, phi: s.phi, distance: s.distance, target: s.target.toArray() };
  }

  getStatistics(): { volumes: number; triangles: number; drawCalls: number; builtArea: number } {
    const info = this.scene.renderer.info.render;
    const st = ops.projectStats(this.project);
    return { volumes: st.buildings, triangles: info.triangles, drawCalls: info.calls, builtArea: st.builtArea };
  }

  exportJSON(): string {
    return json(this.project);
  }

  exportGLB(opts: { expandInstances?: boolean } = {}): Promise<ArrayBuffer> {
    return glb(this.scene.modelRoot, opts);
  }

  undo(): void {
    this.restore('undo');
  }

  redo(): void {
    this.restore('redo');
  }

  on<K extends keyof EditorEvents>(event: K, fn: (p: EditorEvents[K]) => void): () => void {
    return this.events.on(event, fn);
  }

  /** No modo hospedado: chame no laço do jogo; devolve true se algo mudou. */
  update(): void {
    this.scene.mark();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.toastTimer);
    cancelAnimationFrame(this.moveFrame);
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.events.clear();
    this.scene.dispose();
    this.shell?.dispose();
  }
}

export function createEditor(opts: EditorOptions = {}): Editor {
  return new Editor(opts);
}

export type { HandleData };
