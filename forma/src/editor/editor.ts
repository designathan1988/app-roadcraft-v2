// Editor FORMA 2: estado, seleção, ferramentas, ações, interface e API pública.
// Portado da lógica do FORMA v1 e adaptado ao modelo forma/2.
import * as THREE from 'three';
import type { Building, FacadePattern, ID, Limits, Lot, LotRules, Project, RoofKind, Storey, Vec2 } from '../core/schema';
import * as iops from './interior-ops';
import { WalkController, walkStart } from './walk';
import { snapToGraph, wallEnds, project as projectOnSegment } from '../geometry/walls';
import { interiorPoint } from '../geometry/rooms';
import { sortedStoreys } from '../core/model';
import { ringPoints } from '../geometry/ring';
import { computeLotIndices, DEFAULT_LOT_RULES, type LotIndices, type Violation } from '../core/indices';
import { assignLots, fillLot as fillLotOp, newLot } from './lot-ops';
import { DEFAULT_LIMITS } from '../core/schema';
import { loadProject, emptyProject } from '../core';
import { History } from '../core/history';
import { Emitter } from '../core/events';
import { edgeConfig } from '../core/model';
import { bounds, clamp, clean, distanceToSegment, shape, validPolygon } from '../geometry/polygon';
import { validHoles } from '../geometry/boolean';
import { findEdge, massEdges } from '../geometry/ring';
import { toLocal } from '../geometry/frame';
import * as ops from './ops';
import { EditorScene, type HandleData, type SceneHost } from './scene';
import { exampleProject } from './example';
import { createShell, type Shell, type UiLevel } from '../ui/shell';
import { hydrate } from '../ui/icons';
import { inspectorHTML, layersHTML, shelfHTML, helpHTML, NEW_HTML, interiorShelfHTML, storeyBarHTML, wallInspectorHTML, roomInspectorHTML, stairInspectorHTML, type Defaults, type InteriorState, type PanelState, type VolumeView } from '../ui/panels';
import * as persist from '../io/persistence';
import { download, exportGLB as glb, exportJSON as json, exportOBJ as obj, filename } from '../io/export';

export type Tool = 'select' | 'draw' | 'polygon' | 'extrude' | 'move' | 'cut' | 'window' | 'door' | 'opening' | 'editpoints' | 'lot' | 'lotpolygon' | 'frontage' | 'wall' | 'idoor' | 'stair' | 'room';

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
  violation: { lotId: ID; violations: Violation[] };
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
  lot: 'Arraste no chão para desenhar um lote retangular.',
  lotpolygon: 'Clique os vértices do lote. Enter ou duplo clique fecha. Esc cancela.',
  frontage: 'Clique numa divisa do lote selecionado para marcar ou desmarcar a testada (frente para a rua).',
  wall: 'Clique ponto a ponto para desenhar paredes. Shift trava em ângulo reto. Enter, duplo clique ou Esc termina.',
  idoor: 'Clique numa parede interna para abrir uma porta.',
  stair: 'Clique os pontos do caminho da escada (2 = reta, 3 = em L, 4 = em U). Enter ou duplo clique conclui.',
  room: 'Clique dentro de um cômodo para dar nome a ele.',
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
  private selectedLot: ID | null = null;
  private lotIndices = new Map<ID, LotIndices>();
  /** O que a base livre está desenhando: um volume ou um lote. */
  private polygonTarget: 'building' | 'lot' = 'building';
  /** Pavimento em edição (interiores): edifício e pavimento. */
  private activeStorey: { buildingId: ID; storeyId: ID } | null = null;
  private selectedWall: ID | null = null;
  private selectedRoom: ID | null = null;
  private selectedStair: ID | null = null;
  private chain: Vec2[] = [];
  private stairPath: Vec2[] = [];
  private wallThickness = 0.12;
  private stairWidth = 1.1;
  private walk: WalkController | null = null;

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
    this.scene.buildOptionsFor = (b) => {
      if (this.walk || this.activeStorey?.buildingId !== b.id) return {};
      const s = b.storeys.find((x) => x.id === this.activeStorey!.storeyId);
      return s ? { cutY: s.elevation + s.height - 0.02 } : {};
    };
    this.scene.onViewChange = () => this.renderRoomLabels();
    this.scene.rebuild(this.project.buildings);
    this.scene.buildEnvironment(this.project.buildings, this.project.lots);
    this.refreshLots();
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
      roofOverhang: m.roof.overhang ?? 0.4,
      roofDirection: m.roof.direction,
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
      selectionArea: this.selectedList().reduce((t, x) => t + ops.footprintArea(x), 0),
      defaults: this.defaults,
      tool: this.tool,
      tab: this.tab,
      section: this.scene.section,
      repeatCount: this.repeatCount,
      repeatSpace: this.repeatSpace,
      lot: !b && this.selectedLot && this.lotById(this.selectedLot) ? { lot: this.lotById(this.selectedLot)!, indices: this.lotIndices.get(this.selectedLot) ?? null } : null,
    };
  }

  // ── Interiores ──────────────────────────────────────────────────────
  private activeBuilding(): Building | undefined {
    return this.activeStorey ? this.byId(this.activeStorey.buildingId) : undefined;
  }

  private activeStoreyObj(): Storey | undefined {
    const b = this.activeBuilding();
    return b?.storeys.find((s) => s.id === this.activeStorey!.storeyId);
  }

  /** Estado dos interiores para o edifício ativo ou o selecionado. */
  private interiorState(): InteriorState | null {
    const b = this.activeBuilding() ?? (this.selected.size === 1 ? this.selectedBuilding() : undefined);
    if (!b) return null;
    return {
      storeys: sortedStoreys(b).map((s) => ({ id: s.id, name: s.name, height: s.height, rooms: s.rooms.map((r) => ({ id: r.id, name: r.name, area: r.area ?? 0 })) })),
      activeStoreyId: this.activeStorey?.buildingId === b.id ? this.activeStorey.storeyId : null,
      tool: this.tool,
      wallThickness: this.wallThickness,
      stairWidth: this.stairWidth,
    };
  }

  private setActiveStorey(buildingId: ID | null, storeyId: ID | null): void {
    const prev = this.activeStorey?.buildingId;
    this.activeStorey = buildingId && storeyId ? { buildingId, storeyId } : null;
    this.selectedWall = this.selectedRoom = this.selectedStair = null;
    this.chain = [];
    this.stairPath = [];
    if (this.activeStorey) {
      this.selected = new Set([buildingId!]);
      this.tab = 'interior';
      // Cômodos são derivados: calcula ao entrar (prédios novos ainda não têm).
      const ab = this.byId(buildingId!);
      if (ab) iops.updateRooms(ab, storeyId!);
    } else if (['wall', 'idoor', 'stair', 'room'].includes(this.tool)) this.setTool('select');
    this.rebuild([...new Set([prev, buildingId].filter((x): x is ID => !!x))]);
    this.renderUI();
  }

  /** Ponto sob o ponteiro no piso do pavimento ativo (coordenadas locais). */
  private storeyPoint(e: { clientX: number; clientY: number }): Vec2 | null {
    const b = this.activeBuilding(),
      s = this.activeStoreyObj();
    if (!b || !s) return null;
    const p = this.scene.planePoint(e, s.elevation + s.slabThickness);
    return p ? toLocal(b, [p.x, p.z]) : null;
  }

  /** Encaixe: nós, paredes e contorno; senão grade. Shift trava em ângulo reto. */
  private snapInterior(p: Vec2, from: Vec2 | null, ortho: boolean, excludeNode: ID | null = null): Vec2 {
    const b = this.activeBuilding(),
      s = this.activeStoreyObj();
    if (!b || !s) return p;
    if (ortho && from) {
      const dx = p[0] - from[0],
        dz = p[1] - from[1];
      p = Math.abs(dx) >= Math.abs(dz) ? [p[0], from[1]] : [from[0], p[1]];
    }
    const g = excludeNode ? { nodes: s.graph.nodes.filter((n) => n.id !== excludeNode), walls: s.graph.walls.filter((w) => w.a !== excludeNode && w.b !== excludeNode) } : s.graph;
    const { outer, holes } = iops.storeyOutlines(b, s.id);
    const edges: [Vec2, Vec2][] = [...outer, ...holes].flatMap((r) => r.map((a, i) => [a, r[(i + 1) % r.length]!] as [Vec2, Vec2]));
    const snapped = snapToGraph(g, p, edges, Math.max(0.2, this.scene.distance * 0.008));
    if (snapped.seg) {
      // Sobre uma aresta ou parede: arredonda à grade ao longo dela.
      const g2: Vec2 = [this.snapN(p[0]), this.snapN(p[1])];
      const pr = projectOnSegment(g2, snapped.seg[0], snapped.seg[1]);
      return pr.d < 1e-6 || Math.abs(pr.q[0] - snapped.p[0]) + Math.abs(pr.q[1] - snapped.p[1]) < this.gridSize ? pr.q : snapped.p;
    }
    if (snapped.kind !== 'free') return snapped.p;
    return [this.snapN(p[0]), this.snapN(p[1])];
  }

  private previewInterior(points: Vec2[], width = 0): void {
    const b = this.activeBuilding(),
      s = this.activeStoreyObj(),
      sc = this.scene;
    sc.disposeGroup(sc.sketch);
    if (!b || !s || points.length < 2) return sc.mark();
    const y = s.elevation + s.slabThickness + 0.05;
    sc.line(points.map((p) => sc.toWorld(b, p, y)), '#c57130', false, sc.sketch);
    if (width > 0)
      for (const side of [-1, 1]) {
        const off = points.map((p, i) => {
          const q = points[Math.min(i + 1, points.length - 1)]!,
            o = points[Math.max(i - 1, 0)]!;
          const dx = q[0] - o[0],
            dz = q[1] - o[1],
            l = Math.hypot(dx, dz) || 1;
          return [p[0] - (dz / l) * (width / 2) * side, p[1] + (dx / l) * (width / 2) * side] as Vec2;
        });
        sc.line(off.map((p) => sc.toWorld(b, p, y)), '#e5924d', false, sc.sketch);
      }
    sc.mark();
  }

  private finishStair(): void {
    const b = this.activeBuilding(),
      s = this.activeStoreyObj();
    const path = this.stairPath;
    this.stairPath = [];
    this.scene.disposeGroup(this.scene.sketch);
    if (!b || !s || path.length < 2) return this.toast('Marque pelo menos dois pontos para a escada.');
    const st = iops.addStair(b, s.id, path, this.stairWidth);
    if (!st) return this.toast('Não há pavimento acima para a escada chegar.');
    this.rebuild([b.id]);
    this.commit('Escada criada; a laje de cima ganhou o vão.');
    this.setTool('select');
  }

  private renderRoomLabels(): void {
    if (!this.shell) return;
    const box = this.$('#room-labels');
    const b = this.activeBuilding(),
      s = this.activeStoreyObj();
    if (!b || !s || this.walk) {
      if (box.innerHTML) box.innerHTML = '';
      return;
    }
    const fmtA = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const y = s.elevation + s.slabThickness + 0.1;
    box.innerHTML = s.rooms
      .filter((r) => r.polygon)
      .map((r) => {
        const c = interiorPoint(r.polygon!);
        const p = this.scene.worldToScreen(this.scene.toWorld(b, c, y));
        const esc = String(r.name).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
        return `<div class="room-label" style="left:${p.x.toFixed(0)}px;top:${p.y.toFixed(0)}px">${esc}<small>${fmtA(r.area ?? 0)} m²</small></div>`;
      })
      .join('');
  }

  private startWalk(): void {
    const b = this.activeBuilding() ?? this.selectedBuilding();
    if (!b) return this.toast('Selecione um edifício para caminhar dentro dele.');
    const s = this.activeStoreyObj() ?? sortedStoreys(b)[0]!;
    iops.updateRooms(b, s.id);
    const start = walkStart(b, s.id);
    this.cancelDrag();
    this.setTool('select');
    const canvas = this.scene.renderer.domElement;
    this.walk = new WalkController(b, this.scene.camera, canvas, { p: start, floor: s.elevation + s.slabThickness, yaw: this.scene.theta }, () => this.scene.mark(), () => {
      this.walk = null;
      this.scene.gizmos.visible = true;
      if (this.shell) {
        this.$('#walk-hint').style.display = 'none';
        this.$('#walk-crosshair').style.display = 'none';
        this.$('#hint').style.display = '';
      }
      this.renderStoreyBar();
      this.scene.updateCamera();
      this.rebuild([b.id]);
      this.renderRoomLabels();
    });
    this.rebuild([b.id]);
    this.scene.gizmos.visible = false;
    this.renderStoreyBar();
    if (this.shell) {
      this.$('#hint').style.display = 'none';
      const hint = this.$('#walk-hint');
      hint.textContent = 'Caminhando: W A S D para andar, mouse para olhar, Shift corre, Esc sai.';
      hint.style.display = 'block';
      this.$('#walk-crosshair').style.display = 'block';
    }
  }

  private interiorAction(action: string): void {
    const b = this.activeBuilding(),
      s = this.activeStoreyObj();
    if (action === 'walk') return this.startWalk();
    if (!b || !s) return this.toast('Escolha um pavimento primeiro.');
    if (action === 'plan') {
      const pts = ringPoints(ops.mainMass(b).outer).map((p) => this.scene.toWorld(b, p, 0));
      const cx = pts.reduce((t, p) => t + p.x, 0) / pts.length,
        cz = pts.reduce((t, p) => t + p.z, 0) / pts.length;
      const span = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.z - cz)));
      this.scene.target.set(cx, s.elevation, cz);
      this.scene.distance = Math.max(12, span * 3.2);
      this.scene.phi = 0.025;
      this.scene.theta = -((b.rotation * Math.PI) / 180);
      this.scene.updateCamera();
    } else if (action === 'delete-wall' && this.selectedWall) {
      iops.removeInteriorWall(b, s.id, this.selectedWall);
      this.selectedWall = null;
      this.rebuild([b.id]);
      this.commit('Parede removida.');
    } else if (action === 'delete-stair' && this.selectedStair) {
      iops.removeStair(b, this.selectedStair);
      this.selectedStair = null;
      this.rebuild([b.id]);
      this.commit('Escada removida.');
    }
  }

  private renderStoreyBar(): void {
    if (!this.shell) return;
    if (this.activeStorey && (!this.activeBuilding() || !this.activeStoreyObj())) this.activeStorey = null;
    const st = this.interiorState();
    this.$('#storey-bar').innerHTML = this.walk ? '' : storeyBarHTML(st && st.storeys.length > 0 ? st : null);
    this.renderRoomLabels();
  }

  private renderInspector(): void {
    if (!this.shell) return;
    const ab = this.activeBuilding(),
      as = this.activeStoreyObj();
    if (ab && as && this.selectedWall) {
      const w = as.graph.walls.find((x) => x.id === this.selectedWall);
      const e = w && wallEnds(as.graph, w);
      if (w && e) {
        this.$('#inspector-inner').innerHTML = wallInspectorHTML({ length: Math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]), thickness: w.thickness, doors: ab.openings.filter((o) => o.host.kind === 'wall' && o.host.wallId === w.id).length });
        return hydrate(this.$('#inspector'));
      }
    }
    if (ab && as && this.selectedRoom) {
      const r = as.rooms.find((x) => x.id === this.selectedRoom);
      if (r) {
        this.$('#inspector-inner').innerHTML = roomInspectorHTML({ name: r.name, area: r.area ?? 0, walls: r.wallIds.length });
        return hydrate(this.$('#inspector'));
      }
    }
    if (ab && this.selectedStair) {
      const st = ab.stairs.find((x) => x.id === this.selectedStair);
      if (st) {
        const nm = (id: ID) => ab.storeys.find((x) => x.id === id)?.name ?? '?';
        this.$('#inspector-inner').innerHTML = stairInspectorHTML({ width: st.width, from: nm(st.fromStorey), to: nm(st.toStorey) });
        return hydrate(this.$('#inspector'));
      }
    }
    this.$('#inspector-inner').innerHTML = inspectorHTML(this.panelState());
    hydrate(this.$('#inspector'));
  }

  private renderShelf(): void {
    if (!this.shell) return;
    this.$('#shelf-content').innerHTML = this.tab === 'interior' ? interiorShelfHTML(this.interiorState()) : shelfHTML(this.panelState());
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
    this.renderStoreyBar();
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

  // ── Lotes ───────────────────────────────────────────────────────────
  private lotById = (id: ID): Lot | undefined => this.project.lots.find((l) => l.id === id);

  /** Índices de todos os lotes de um projeto; uma falha de geometria nunca derruba o editor. */
  private evaluateLots(p: Project): Map<ID, LotIndices> {
    const out = new Map<ID, LotIndices>();
    for (const lot of p.lots) {
      try {
        out.set(lot.id, computeLotIndices(p, lot));
      } catch (e) {
        console.error('Índices do lote', lot.name, e);
      }
    }
    return out;
  }

  /** Recalcula índices, redesenha lotes e avisa o jogo das violações. */
  private refreshLots(): void {
    this.lotIndices = this.evaluateLots(this.project);
    if (this.selectedLot && !this.lotById(this.selectedLot)) this.selectedLot = null;
    this.scene.rebuildLots(this.project, this.lotIndices, this.selectedLot);
    for (const [lotId, ix] of this.lotIndices) if (ix.violations.length) this.events.emit('violation', { lotId, violations: ix.violations });
  }

  /**
   * Regras em modo “bloquear”: se a alteração cria uma violação que o estado
   * anterior não tinha, ela é desfeita. Devolve a mensagem do bloqueio.
   */
  private blockedBy(): string | null {
    const key = (v: Violation) => v.kind + '|' + v.buildingIds.join(',');
    const prevProject = this.history.current();
    const prev = this.evaluateLots(prevProject);
    const now = this.evaluateLots(this.project);
    for (const lot of this.project.lots) {
      if (lot.rules?.enforcement !== 'block') continue;
      const before = new Set((prev.get(lot.id)?.violations ?? []).map(key));
      const fresh = (now.get(lot.id)?.violations ?? []).find((v) => !before.has(key(v)));
      if (fresh) return `Bloqueado pelo lote “${lot.name}”: ${fresh.message}`;
    }
    return null;
  }

  private commit(message = '', opts: { allowViolations?: boolean } = {}): void {
    assignLots(this.project);
    if (!opts.allowViolations) {
      const blocked = this.blockedBy();
      if (blocked) {
        this.project = this.history.current();
        this.selected = new Set([...this.selected].filter((id) => this.byId(id)));
        this.rebuild();
        this.refreshLots();
        this.renderUI();
        this.toast(blocked);
        return;
      }
    }
    if (this.history.commit(this.project)) this.events.emit('commit', { message });
    this.saveLocal();
    this.scene.buildEnvironment(this.project.buildings, this.project.lots);
    this.refreshLots();
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
    this.scene.buildEnvironment(this.project.buildings, this.project.lots);
    this.refreshLots();
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
  private selectLot(id: ID | null): void {
    this.selectedLot = id;
    this.selected.clear();
    this.edgeId = null;
    if (id) this.tab = 'lot';
    this.scene.rebuildLots(this.project, this.lotIndices, this.selectedLot);
    this.updateGizmos();
    this.renderUI();
  }

  private applyLotProp(prop: string, raw: string): void {
    const lot = this.selectedLot ? this.lotById(this.selectedLot) : undefined;
    if (!lot) return;
    if (prop === 'name') {
      lot.name = raw.slice(0, 60) || 'Lote';
      return this.commit('', { allowViolations: true });
    }
    const r: LotRules = (lot.rules ??= structuredClone(DEFAULT_LOT_RULES));
    if (prop === 'heightTo') r.heightTo = raw === 'eave' ? 'eave' : 'ridge';
    else if (prop === 'front' || prop === 'side' || prop === 'back') r.setbacks[prop] = clamp(Number(raw) || 0, 0, 50);
    else {
      const n = raw === '' ? undefined : Number(raw);
      const val = n === undefined || !Number.isFinite(n) ? undefined : prop === 'maxOccupancy' || prop === 'minPermeability' ? clamp(n, 0, 100) / 100 : prop === 'maxStoreys' ? Math.round(clamp(n, 1, 100)) : clamp(n, 0, 1000);
      if (prop === 'maxOccupancy' || prop === 'minPermeability' || prop === 'maxFAR' || prop === 'maxHeight' || prop === 'maxStoreys') {
        if (val === undefined) delete r[prop];
        else r[prop] = val;
      }
    }
    this.commit('Regras do lote atualizadas.', { allowViolations: true });
  }

  private lotAction(action: string): void {
    const lot = this.selectedLot ? this.lotById(this.selectedLot) : undefined;
    if (!lot) return this.toast('Selecione um lote primeiro.');
    if (action === 'delete') {
      this.project.lots = this.project.lots.filter((l) => l.id !== lot.id);
      this.selectedLot = null;
      this.commit('Lote removido. Ctrl+Z desfaz.', { allowViolations: true });
      this.updateGizmos();
    } else if (action === 'fill') {
      const b = fillLotOp(this.project, lot, { color: this.defaults.color });
      if (!b) return this.toast('Não há espaço edificável suficiente neste lote com as regras atuais.');
      b.name = 'Volume ' + String(this.project.buildings.length + 1).padStart(2, '0');
      b.masses[0]!.name = b.name;
      this.selectedLot = null;
      this.addBuildings([b], 'Lote preenchido dentro das regras.');
    }
  }

  private select(id: ID | null, edge: ID | null = null, add = false, showContext = false, e: PointerEvent | null = null): void {
    if (id && this.selectedLot) {
      this.selectedLot = null;
      this.scene.rebuildLots(this.project, this.lotIndices, null);
    }
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
    if (['wall', 'idoor', 'stair', 'room'].includes(next) && !this.activeStoreyObj()) {
      this.toast('Escolha um pavimento na barra à esquerda da vista para desenhar o interior.');
      next = 'select';
    }
    this.tool = next;
    this.sketch = [];
    this.chain = [];
    this.stairPath = [];
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
    const lotSel = this.selectedLot && !this.selected.size ? this.lotById(this.selectedLot) : undefined;
    if (lotSel && this.tool === 'select') lotSel.polygon.forEach((p, i) => sc.handle(new THREE.Vector3(p[0], 0.05, p[1]), { kind: 'lotvertex', id: lotSel.id, index: i }));
    // Pontas da parede interna selecionada.
    const ab = this.activeBuilding(),
      as = this.activeStoreyObj();
    if (ab && as && this.selectedWall && this.tool === 'select' && sc.built.has(ab.id)) {
      const w = as.graph.walls.find((x) => x.id === this.selectedWall);
      for (const nid of w ? [w.a, w.b] : []) {
        const n = as.graph.nodes.find((x) => x.id === nid);
        if (n) sc.handle(sc.toWorld(ab, n.p, as.elevation + as.slabThickness + 0.05), { kind: 'node', id: n.id });
      }
      if (w) {
        const e = wallEnds(as.graph, w);
        if (e) sc.line([sc.toWorld(ab, e[0], as.elevation + as.height - 0.05), sc.toWorld(ab, e[1], as.elevation + as.height - 0.05)], '#ffb270');
      }
    }
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
      if (this.tool === 'editpoints') pts.forEach((p, i) => sc.handle(sc.toWorld(b, p, base + 0.1), { kind: 'vertex', id: b.id, index: i }));
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
      else if (prop === 'roofOverhang') m.roof.overhang = ops.r2(clamp(Number(value), 0, 1.5));
      else if (prop === 'roofDirection') {
        if (value === '' || !Number.isFinite(Number(value))) delete m.roof.direction;
        else m.roof.direction = Number(value);
      }
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
    } else if (action === 'group') {
      try {
        const sources = this.selectedList();
        const g = iops.groupBuildings(sources);
        this.replaceBuildings(sources, [g], 'Volumes agrupados num só edifício.');
      } catch (err) {
        this.toast((err as Error).message);
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
      } else if (d.storey !== undefined) {
        const b = this.activeBuilding() ?? this.selectedBuilding();
        if (b) this.setActiveStorey(d.storey ? b.id : null, d.storey || null);
      } else if (d.interior) this.interiorAction(d.interior);
      else if (d.lotaction) this.lotAction(d.lotaction);
      else if (d.lotmode) {
        const lot = this.selectedLot ? this.lotById(this.selectedLot) : undefined;
        if (!lot) return this.toast('Selecione um lote primeiro.');
        (lot.rules ??= structuredClone(DEFAULT_LOT_RULES)).enforcement = d.lotmode === 'block' ? 'block' : 'warn';
        this.commit(d.lotmode === 'block' ? 'O lote agora bloqueia o que viola as regras.' : 'O lote agora só avisa sobre violações.', { allowViolations: true });
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
      else if (el.dataset.lotprop) this.applyLotProp(el.dataset.lotprop, el.value);
      else if (el.dataset.interiorprop === 'wallThickness') this.wallThickness = clamp(Number(el.value) || 0.12, 0.05, 1);
      else if (el.dataset.interiorprop === 'stairWidth') this.stairWidth = clamp(Number(el.value) || 1.1, 0.6, 3);
      else if (el.dataset.storeyprop || el.dataset.room || el.dataset.roomprop || el.dataset.wallprop) {
        const b = this.activeBuilding(),
          s = this.activeStoreyObj();
        if (!b || !s) return;
        if (el.dataset.storeyprop === 'name') iops.renameStorey(b, s.id, el.value);
        else if (el.dataset.storeyprop === 'height') iops.setStoreyHeight(b, s.id, Number(el.value));
        else if (el.dataset.room) iops.renameRoom(b, s.id, el.dataset.room, el.value);
        else if (el.dataset.roomprop === 'name' && this.selectedRoom) iops.renameRoom(b, s.id, this.selectedRoom, el.value);
        else if (el.dataset.wallprop === 'thickness' && this.selectedWall) iops.setWallThickness(b, s.id, this.selectedWall, Number(el.value));
        this.rebuild([b.id]);
        this.commit();
      }
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
    if (this.walk) return;
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && (this.selectedWall || this.selectedStair) && this.activeStorey) {
      e.preventDefault();
      this.interiorAction(this.selectedWall ? 'delete-wall' : 'delete-stair');
    } else if (e.key === 'Enter' && this.tool === 'wall') {
      e.preventDefault();
      this.chain = [];
      this.scene.disposeGroup(this.scene.sketch);
      this.hideDimension();
    } else if (e.key === 'Enter' && this.tool === 'stair') {
      e.preventDefault();
      this.finishStair();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !this.selected.size && this.selectedLot) {
      e.preventDefault();
      this.lotAction('delete');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.doAction('delete');
    } else if (e.key === 'Enter' && (this.tool === 'polygon' || this.tool === 'lotpolygon')) {
      e.preventDefault();
      this.finishPolygon();
    } else if (key === 'f') this.scene.fitView();
    else if (key === '?' && this.shell) this.modal(helpHTML());
    else {
      const map: Record<string, Tool> = { v: 'select', b: 'draw', p: 'polygon', e: 'extrude', g: 'move', c: 'cut', l: 'lot' };
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
    if (this.polygonTarget === 'lot') return this.addLot(p);
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
      if (this.tool === 'wall') {
        this.chain = [];
        this.scene.disposeGroup(this.scene.sketch);
        return this.hideDimension();
      }
      if (this.tool === 'stair') return this.finishStair();
      if (this.tool !== 'polygon' && this.tool !== 'lotpolygon') return;
      const s = this.sketch;
      if (s.length > 1 && Math.hypot(s.at(-1)![0] - s.at(-2)![0], s.at(-1)![1] - s.at(-2)![1]) < 0.1) s.pop();
      this.finishPolygon();
    });
    this.listen(
      el,
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        if (this.walk) return;
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
    if (this.walk) return;
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
    if (handle?.kind === 'node') {
      const b = this.activeBuilding();
      if (b) this.drag = { type: 'node', id: handle.id, snapshot: structuredClone(this.project) };
    } else if (tool === 'wall' || tool === 'stair') {
      this.drag = { type: 'iclick', clientX: e.clientX, clientY: e.clientY, shift: e.shiftKey };
    } else if (tool === 'idoor') {
      const b = this.activeBuilding(),
        s = this.activeStoreyObj();
      if (!b || !s || !picked || picked.data.part !== 'iwall' || picked.data.buildingId !== b.id || !picked.data.wallId) return this.toast('Clique numa parede interna deste pavimento.');
      const w = s.graph.walls.find((x) => x.id === picked.data.wallId);
      const en = w && wallEnds(s.graph, w);
      if (!w || !en) return;
      const local = toLocal(b, [picked.hit.point.x, picked.hit.point.z]);
      const pr = projectOnSegment(local, en[0], en[1]);
      const len = Math.hypot(en[1][0] - en[0][0], en[1][1] - en[0][1]);
      iops.addInteriorDoor(b, s.id, w.id, pr.t * len);
      this.rebuild([b.id]);
      this.commit('Porta interna criada.');
      return;
    } else if (tool === 'room') {
      const b = this.activeBuilding(),
        s = this.activeStoreyObj(),
        q = this.storeyPoint(e);
      const r = b && s && q ? iops.roomAt(b, s.id, q) : undefined;
      this.selectedRoom = r?.id ?? null;
      this.selectedWall = this.selectedStair = null;
      if (!r) this.toast('Clique dentro de um cômodo do pavimento.');
      this.renderUI();
      return;
    } else if (handle?.kind === 'lotvertex') {
      const lot = this.lotById(handle.id);
      if (lot) this.drag = { type: 'lotvertex', id: lot.id, index: handle.index, original: structuredClone(lot.polygon), snapshot: structuredClone(this.project) };
    } else if (handle) {
      const b = this.byId(handle.id);
      if (!b) return;
      if (handle.kind === 'height') this.beginHeight(b, e);
      else this.drag = { type: handle.kind, id: handle.id, sx: handle.sx, sz: handle.sz, index: handle.index, original: structuredClone(b), snapshot: structuredClone(this.project) };
    } else if (tool === 'lot') {
      const p = sc.planePoint(e, 0);
      if (!p) return;
      const s: Vec2 = [this.snapN(p.x), this.snapN(p.z)];
      this.drag = { type: 'lot', start: s, end: s, y: 0 };
    } else if (tool === 'frontage') {
      this.toggleFrontage(e);
    } else if (tool === 'draw' || tool === 'cut') {
      const b = this.selectedBuilding();
      if (tool === 'cut' && !b) return this.toast('Selecione o volume que deseja recortar.');
      const y = tool === 'draw' && picked?.data.part === 'roof' ? picked.hit.point.y : 0;
      const p = sc.planePoint(e, y);
      if (!p) return;
      const s: Vec2 = [this.snapN(p.x), this.snapN(p.z)];
      this.drag = { type: tool, id: b?.id, start: s, end: s, y, snapshot: structuredClone(this.project) };
    } else if (tool === 'polygon' || tool === 'lotpolygon') {
      this.polygonTarget = tool === 'lotpolygon' ? 'lot' : 'building';
      if (!this.sketch.length) this.sketchY = tool === 'polygon' && picked?.data.part === 'roof' ? picked.hit.point.y : 0;
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
      const ab = this.activeBuilding();
      if (picked && ab && picked.data.buildingId === ab.id && ['iwall', 'idoor', 'stair'].includes(picked.data.part)) {
        this.selectedWall = picked.data.wallId ?? null;
        this.selectedStair = picked.data.part === 'stair' ? (picked.data.stairId ?? null) : null;
        this.selectedRoom = null;
        this.updateGizmos();
        this.renderUI();
        return;
      }
      this.selectedWall = this.selectedStair = this.selectedRoom = null;
      if (picked && this.activeStorey && picked.data.buildingId !== this.activeStorey.buildingId) this.setActiveStorey(null, null);
      if (picked) this.select(picked.data.buildingId, this.mode === 'face' ? (picked.data.edgeId ?? null) : null, e.ctrlKey || e.metaKey, this.mode === 'face', e);
      else {
        const lotId = sc.pickLot(e);
        if (lotId) this.selectLot(lotId);
        else {
          if (this.selectedLot) this.selectLot(null);
          this.select(null);
        }
      }
    }
    if (this.drag) this.capture(e);
  }

  private onPointerMove(e: PointerEvent): void {
    const sc = this.scene;
    if (this.walk) return;
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
    if (this.tool === 'wall' && this.chain.length) {
      const q = this.storeyPoint(e);
      if (q) {
        const last = this.chain.at(-1)!;
        const s = this.snapInterior(q, last, e.shiftKey);
        this.previewInterior([last, s]);
        this.showDimension(`${fmt(Math.hypot(s[0] - last[0], s[1] - last[1]), 2)} m`, e);
      }
    } else if (this.tool === 'stair' && this.stairPath.length) {
      const q = this.storeyPoint(e);
      if (q) this.previewInterior([...this.stairPath, this.snapInterior(q, this.stairPath.at(-1)!, e.shiftKey)], this.stairWidth);
    } else if (this.tool === 'polygon' && this.sketch.length) {
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
    if (d.type === 'iclick') return;
    if (d.type === 'node') {
      const b = this.activeBuilding(),
        s = this.activeStoreyObj(),
        q = this.storeyPoint(e);
      if (!b || !s || !q) return;
      const p = this.snapInterior(q, null, false, d.id as ID);
      iops.moveNode(b, s.id, d.id as ID, p);
      this.rebuild([b.id]);
      this.renderRoomLabels();
      this.showDimension(`x ${fmt(p[0])} · z ${fmt(p[1])} m`, e);
      return;
    }
    if (d.type === 'lotvertex') {
      const lot = this.lotById(d.id as ID);
      const p = sc.planePoint(e, 0);
      if (!lot || !p) return;
      const poly = (d.original as Vec2[]).map((q) => [q[0], q[1]] as Vec2);
      poly[d.index as number] = [e.altKey ? p.x : this.snapN(p.x), e.altKey ? p.z : this.snapN(p.z)];
      if (validPolygon(poly)) {
        lot.polygon = poly;
        this.lotIndices = this.evaluateLots(this.project);
        sc.rebuildLots(this.project, this.lotIndices, lot.id);
        this.updateGizmos();
      }
      this.showDimension(`x ${fmt(p.x)} · z ${fmt(p.z)} m`, e);
      return;
    }
    if (d.type === 'draw' || d.type === 'cut' || d.type === 'lot') {
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
    if (d.type === 'iclick') {
      if (Math.hypot(e.clientX - (d.clientX as number), e.clientY - (d.clientY as number)) > 5) return;
      const b = this.activeBuilding(),
        s = this.activeStoreyObj(),
        raw = this.storeyPoint(e);
      if (!b || !s || !raw) return;
      if (this.tool === 'stair') {
        const q = this.snapInterior(raw, this.stairPath.at(-1) ?? null, !!d.shift);
        if (!this.stairPath.length || Math.hypot(q[0] - this.stairPath.at(-1)![0], q[1] - this.stairPath.at(-1)![1]) > 0.2) this.stairPath.push(q);
        this.previewInterior(this.stairPath, this.stairWidth);
        return;
      }
      const last = this.chain.at(-1) ?? null;
      const q = this.snapInterior(raw, last, !!d.shift);
      if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.05) {
        const ids = iops.addInteriorWall(b, s.id, last, q, this.wallThickness);
        if (ids.length) {
          this.rebuild([b.id]);
          this.commit('', { allowViolations: true });
          const n = s.rooms.length;
          this.toast(`Parede criada · ${n} ${n === 1 ? 'cômodo' : 'cômodos'} no pavimento.`);
        }
      }
      this.chain = [q];
      this.previewInterior([q, q]);
      return;
    }
    if (d.type === 'node') {
      this.commit('Parede ajustada.');
      return;
    }
    if (d.type === 'lot') {
      const r = this.rectPoints(d.start as Vec2, d.end as Vec2);
      const w = r[1]![0] - r[0]![0],
        dep = r[2]![1] - r[1]![1];
      if (w < 3 || dep < 3) return this.toast('Desenhe um lote com pelo menos 3 m de cada lado.');
      this.addLot(r);
      return;
    }
    if (d.type === 'lotvertex') {
      this.commit('Lote remodelado.', { allowViolations: true });
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

  private addLot(polygon: Vec2[]): void {
    const n = this.project.lots.length + 1;
    const lot = newLot(polygon, 'Lote ' + String(n).padStart(2, '0'));
    this.project.lots.push(lot);
    this.selectedLot = lot.id;
    this.selected.clear();
    this.tab = 'lot';
    this.setTool('select');
    this.commit('Lote criado. A faixa azul marca a testada; ajuste recuos e limites na aba Lote.', { allowViolations: true });
    this.updateGizmos();
  }

  /** Marca ou desmarca a testada na divisa mais próxima do clique (até 3 m). */
  private toggleFrontage(e: PointerEvent): void {
    const lot = this.selectedLot ? this.lotById(this.selectedLot) : undefined;
    const p = this.scene.planePoint(e, 0);
    if (!lot || !p) return this.toast('Selecione um lote e clique numa divisa.');
    let best = -1,
      dist = 3;
    lot.polygon.forEach((a, i) => {
      const d = distanceToSegment(p.x, p.z, a, lot.polygon[(i + 1) % lot.polygon.length]!);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    if (best < 0) return this.toast('Clique mais perto de uma divisa do lote.');
    const has = lot.frontEdges.includes(best);
    if (has && lot.frontEdges.length === 1) return this.toast('O lote precisa de pelo menos uma testada.');
    lot.frontEdges = has ? lot.frontEdges.filter((i) => i !== best) : [...lot.frontEdges, best].sort((a, b) => a - b);
    this.commit(has ? 'Testada removida desta divisa.' : 'Divisa marcada como testada.', { allowViolations: true });
  }

  // ── API pública: lotes ──────────────────────────────────────────────
  /** Cria um lote (coordenadas do mundo) e devolve o seu ID. */
  addLotPolygon(polygon: Vec2[], rules?: Partial<LotRules>, name?: string): ID {
    const lot = newLot(polygon, name ?? 'Lote ' + String(this.project.lots.length + 1).padStart(2, '0'), { ...DEFAULT_LOT_RULES, ...rules, setbacks: { ...DEFAULT_LOT_RULES.setbacks, ...(rules?.setbacks ?? {}) } });
    this.project.lots.push(lot);
    this.commit('', { allowViolations: true });
    return lot.id;
  }

  setLotRules(lotId: ID, rules: Partial<LotRules>): void {
    const lot = this.lotById(lotId);
    if (!lot) throw new Error('Lote inexistente: ' + lotId);
    const cur = lot.rules ?? structuredClone(DEFAULT_LOT_RULES);
    lot.rules = { ...cur, ...rules, setbacks: { ...cur.setbacks, ...(rules.setbacks ?? {}) } };
    this.commit('', { allowViolations: true });
  }

  getIndices(lotId: ID): LotIndices | null {
    return this.lotIndices.get(lotId) ?? null;
  }

  /** Preenche o lote com um edifício dentro das regras; devolve o ID ou null. */
  fillLot(lotId: ID): ID | null {
    const lot = this.lotById(lotId);
    if (!lot) return null;
    const b = fillLotOp(this.project, lot, { color: this.defaults.color });
    if (!b) return null;
    this.addBuildings([b], '');
    return b.id;
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
