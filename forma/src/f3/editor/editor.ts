// Editor do FORMA 3: liga documento, vista, alças, inferência e interface.
// Seleção em dois níveis (como grupos do SketchUp): fora de um edifício, o
// clique pega o edifício inteiro; dentro dele (duplo clique), pega volume,
// face ou componente. Arrastos partem de uma cópia do estado inicial e só
// gravam no histórico ao soltar.
import * as THREE from 'three';
import type { Building3, ID, Item, Project3, Solid, Vec2, Vec3 } from '../model/schema';
import { building as newBuilding, circlePlan, levelsFor, planVertices, project as newProject, rectPlan, roofSpec, solid as newSolid, uid } from '../model/defaults';
import { bendEdge, cloneBuilding, cloneSolid, dirToLocal, edgeNormal, findSolid, mirrorSolid, moveVertex, planCenter, pushEdge, removeVertex, rotateSolid, splitEdge, toLocal, toWorld, topAt, translateSolid } from '../model/ops';
import { solidRings } from '../eval/body';
import { Store } from './store';
import { BLOCKS, blockSolid, type BlockPlacement } from '../model/blocks';
import { View, type Hit } from './view';
import { Handles, HANDLE_COLORS, type Handle } from './handles';
import { Inference, SNAP_COLORS, type Snap } from './infer';
import { createShell3, type Shell3 } from '../ui/shell';
import { icon } from '../ui/icons';
import { family, typeById } from '../families/index';
import { resolveParams } from '../families/family';
import { emptyParts3, FrameSink, frameMatrix } from '../eval/parts';
import { buildPartsMesh, type PartsMesh } from '../render/parts';
import type { FaceInfo } from '../eval/faces';
import { between, column, elemKey, elementsOf, grow, row, rowOnFace, sameFace, sameType, shift, shrink, type Elem } from './elements';

export type Tool = 'select' | 'push' | 'rect' | 'circle' | 'polygon' | 'place' | 'paint' | 'block' | 'tape';

export interface Selection {
  building: ID | null;
  solids: ID[];
  /** Face selecionada do primeiro sólido: lado (edge) ou topo. */
  face: { kind: 'side' | 'top'; edge?: ID } | null;
  item: ID | null;
  /** Elementos de fachada selecionados (chaves de elements.ts). */
  elems: string[];
}

interface Measure {
  label: string;
  apply(text: string): boolean;
}

interface Drag {
  kind: string;
  /** Edifício afetado. */
  bid: ID;
  start: { x: number; y: number };
  moved: boolean;
  origBuilding: Building3;
  data: Record<string, unknown>;
  geometry: boolean;
}

const rad = (d: number) => (d * Math.PI) / 180;
const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/** Lê número com vírgula ou ponto e unidade opcional (m, cm). */
export function parseLength(s: string): number | null {
  const t = s.trim().toLowerCase().replace(',', '.');
  const m = /^(-?\d*\.?\d+)\s*(mm|cm|m)?$/.exec(t);
  if (!m) return null;
  const v = parseFloat(m[1]!);
  return m[2] === 'cm' ? v / 100 : m[2] === 'mm' ? v / 1000 : v;
}

export interface EditorOptions {
  project?: Project3;
  autosave?: boolean;
}

export class Editor3 {
  readonly shell: Shell3;
  readonly store: Store;
  readonly view: View;
  readonly handles: Handles;
  readonly infer: Inference;
  tool: Tool = 'select';
  drawMode: 'add' | 'subtract' = 'add';
  sel: Selection = { building: null, solids: [], face: null, item: null, elems: [] };
  context: ID | null = null;
  /** Tipo de componente sendo posicionado. */
  placing: ID | null = null;
  /** Bloco de massa sendo posicionado. */
  blockId: string | null = null;
  paintMat = { finish: 'brick', color: '#a8553a' };
  measure: Measure | null = null;
  warnings: string[] = [];
  private drag: Drag | null = null;
  private draft: { points: THREE.Vector3[]; y: number; bid: ID | null; hover: THREE.Vector3 | null } | null = null;
  private selOverlay = new THREE.Group();
  private snapOverlay = new THREE.Group();
  private ghost: { mesh: PartsMesh; key: string } | null = null;
  private lastSnap: Snap | null = null;
  private clipboard: { kind: 'solid' | 'building' | 'item'; json: string } | null = null;
  private listeners = new Set<() => void>();
  private toastTimer = 0;
  private saveTimer = 0;
  /** Edifícios em prévia (sem fachada) durante um arrasto. */
  private preview = new Set<ID>();

  constructor(container: HTMLElement, opts: EditorOptions = {}) {
    this.shell = createShell3(container);
    this.view = new View(this.shell.view);
    this.store = new Store(opts.project ?? newProject());
    this.handles = new Handles(this.view);
    this.infer = new Inference(this.view);
    this.view.overlay.add(this.selOverlay, this.snapOverlay);
    this.view.onCamera = () => {
      this.handles.draw();
      this.placeCtxBar();
      if (this.dims.length) this.drawDims();
    };
    this.store.on((e) => {
      if (e.kind === 'change') {
        this.sync();
        if (opts.autosave !== false) this.scheduleSave();
      } else this.refreshTop();
    });
    this.bindCanvas();
    this.bindKeys();
    this.bindTop();
    this.renderTools();
    this.shell.name.value = this.store.project.name;
    this.sync();
    this.view.frame();
  }

  // ── Eventos para a interface ─────────────────────────────────────────
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get project(): Project3 {
    return this.store.project;
  }

  activeBuilding(): Building3 | undefined {
    return this.store.building(this.sel.building ?? this.context);
  }

  activeSolid(): Solid | undefined {
    const b = this.activeBuilding();
    return b ? findSolid(b, this.sel.solids[0]) : undefined;
  }

  activeItem(): Item | undefined {
    return this.activeBuilding()?.items.find((i) => i.id === this.sel.item);
  }

  // ── Sincronização ────────────────────────────────────────────────────
  sync(): void {
    const p = this.store.project;
    this.view.sync(p, this.store.revision, this.preview);
    // Seleção que sumiu (desfazer, excluir).
    const b = this.store.building(this.sel.building);
    if (this.sel.building && !b) this.sel = { building: null, solids: [], face: null, item: null, elems: [] };
    if (b) {
      this.sel.solids = this.sel.solids.filter((id) => b.solids.some((s) => s.id === id));
      if (this.sel.item && !b.items.some((i) => i.id === this.sel.item)) this.sel.item = null;
    }
    if (this.context && !this.store.building(this.context)) this.context = null;
    const ctxB = this.store.building(this.context);
    this.infer.axisAngle = ctxB?.rotation ?? 0;
    this.infer.refresh(p, [...this.store.revision.entries()].map(([k, v]) => k + v).join(',') + p.buildings.map((x) => x.position.join() + x.rotation).join());
    this.warnings = [];
    for (const [id, built] of this.view.built) if (!this.context || id === this.context) this.warnings.push(...built.ev.warnings);
    this.drawSelection();
    this.refreshTop();
    this.renderCrumb();
    this.renderWarnings();
    this.shell.status.stats.textContent = `${p.buildings.length} edifício(s) · ${this.view.lastEvalMs.toFixed(0)} ms`;
    this.emit();
  }

  private refreshTop(): void {
    const q = (c: string) => this.shell.top.querySelector<HTMLButtonElement>(`[data-cmd="${c}"]`)!;
    q('undo').disabled = !this.store.canUndo;
    q('redo').disabled = !this.store.canRedo;
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem('forma3_project', this.store.json());
      } catch {
        this.toast('Não foi possível salvar neste navegador (sem espaço).');
      }
    }, 400);
  }

  toast(msg: string): void {
    const t = this.shell.toast;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('on'), 2600);
  }

  private renderWarnings(): void {
    const w = this.shell.warn;
    const uniq = [...new Set(this.warnings)];
    w.classList.toggle('on', uniq.length > 0);
    w.textContent = uniq.slice(0, 3).join(' · ') + (uniq.length > 3 ? ` (+${uniq.length - 3})` : '');
  }

  // ── Mudanças no documento ────────────────────────────────────────────
  /** Altera um edifício e grava (mensagem no toast). */
  change(bid: ID, fn: (b: Building3) => void | boolean, message = '', geometry = true): boolean {
    const b = this.store.building(bid);
    if (!b) return false;
    const r = fn(b);
    if (r === false) {
      this.store.revert();
      if (message) this.toast('Não foi possível: a forma ficaria inválida.');
      return false;
    }
    this.store.commit([bid], message, geometry);
    if (message) this.toast(message);
    return true;
  }

  changeSolid(fn: (s: Solid, b: Building3) => void | boolean, message = ''): boolean {
    const b = this.activeBuilding(),
      s = this.activeSolid();
    if (!b || !s) return false;
    return this.change(b.id, () => fn(s, b), message);
  }

  // ── Seleção ──────────────────────────────────────────────────────────
  select(next: Partial<Selection>): void {
    this.sel = { building: null, solids: [], face: null, item: null, elems: [], ...next };
    this.syncSelection();
  }

  private syncSelection(): void {
    this.drawSelection();
    this.renderCrumb();
    this.emit();
  }

  enter(bid: ID | null): void {
    this.context = bid;
    const b = this.store.building(bid);
    this.infer.axisAngle = b?.rotation ?? 0;
    this.select(bid ? { building: bid } : {});
  }

  exitContext(): void {
    if (this.drag || this.draft) return this.cancel();
    if (this.sel.item || this.sel.elems.length || this.sel.face) return this.select({ building: this.sel.building, solids: this.sel.solids });
    if (this.sel.solids.length) return this.select({ building: this.sel.building });
    if (this.context) {
      const id = this.context;
      this.context = null;
      return this.select({ building: id });
    }
    this.select({});
  }

  private renderCrumb(): void {
    const c = this.shell.crumb;
    const b = this.store.building(this.context);
    const parts: string[] = [];
    parts.push(`<button data-crumb="root" ${!b ? 'aria-current="true"' : ''}>Projeto</button>`);
    if (b) parts.push(`<button data-crumb="building" aria-current="${!this.sel.solids.length && !this.sel.item}">${esc(b.name)}</button>`);
    const s = this.activeSolid();
    if (b && s) parts.push(`<button data-crumb="solid" aria-current="${!this.sel.face}">${esc(s.name)}</button>`);
    if (b && s && this.sel.face) parts.push(`<button data-crumb="face" aria-current="true">${this.sel.face.kind === 'top' ? 'Topo' : 'Face'}</button>`);
    if (this.sel.item) parts.push(`<button aria-current="true">Componente</button>`);
    c.innerHTML = parts.join('');
    c.querySelectorAll<HTMLButtonElement>('button').forEach((btn) =>
      btn.addEventListener('click', () => {
        const k = btn.dataset.crumb;
        if (k === 'root') {
          const id = this.context;
          this.context = null;
          this.select(id ? { building: id } : {});
        } else if (k === 'building' && b) this.select({ building: b.id });
        else if (k === 'solid' && b && s) this.select({ building: b.id, solids: [s.id] });
      }),
    );
  }

  /** Contornos da seleção e alças. */
  drawSelection(): void {
    for (const c of [...this.selOverlay.children]) {
      this.selOverlay.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material && !Array.isArray(m.material)) (m.material as THREE.Material).dispose();
    }
    const handles: Handle[] = [];
    const b = this.activeBuilding();
    if (!b) {
      this.handles.set([]);
      this.placeCtxBar();
      return;
    }
    const M = this.view.buildingMatrix(b);
    const W = (p: Vec2, y: number) => new THREE.Vector3(p[0], y, p[1]).applyMatrix4(M);
    const line = (pts: THREE.Vector3[], color: string, closed = true, opacity = 1) => {
      const l = new (closed ? THREE.LineLoop : THREE.Line)(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity }));
      l.renderOrder = 20;
      this.selOverlay.add(l);
    };
    const [ax, az] = [new THREE.Vector3(1, 0, 0).transformDirection(M), new THREE.Vector3(0, 0, 1).transformDirection(M)];
    // Contorno de cada sólido do edifício (o selecionado em destaque).
    const inCtx = this.context === b.id;
    for (const s of b.solids) {
      const r = solidRings(s);
      const sel = this.sel.solids.includes(s.id);
      if (!inCtx && !sel) {
        if (s.op !== 'add') continue;
        line(r.outer.pts.map((p) => W(p, s.base + 0.03)), '#2f7de1', true, 0.9);
        continue;
      }
      const color = sel ? '#e2702a' : s.op === 'add' ? '#2f7de1' : '#c026d3';
      const op = sel ? 1 : 0.45;
      line(r.outer.pts.map((p) => W(p, r.base)), color, true, op);
      line(r.topOuter.map((p) => W(p, r.top)), color, true, op);
      if (sel)
        r.outer.pts.forEach((p, i) => {
          if (r.outer.segs[i]!.curved && r.outer.segs[(i - 1 + r.outer.pts.length) % r.outer.pts.length]!.curved) return;
          line([W(p, r.base), W(r.topOuter[i]!, r.top)], color, false, 0.7);
        });
    }
    // Face selecionada: realce translúcido dos triângulos dela.
    const s0 = this.activeSolid();
    const built = this.view.built.get(b.id);
    if (s0 && this.sel.face && built) {
      const want = (f: FaceInfo | undefined) => !!f && f.solid === s0.id && (this.sel.face!.kind === 'top' ? f.kind === 'top' || f.kind === 'roof' : f.kind === 'side' && f.edge === this.sel.face!.edge);
      const { positions: P, indices: I, faceOf } = built.ev.shell;
      const pos: number[] = [];
      for (let t = 0; t < I.length / 3; t++) {
        if (!want(built.ev.faces[faceOf[t]!])) continue;
        for (let j = 0; j < 3; j++) {
          const i = I[t * 3 + j]! * 3;
          pos.push(P[i]!, P[i + 1]!, P[i + 2]!);
        }
      }
      if (pos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#e2702a', transparent: true, opacity: 0.28, depthTest: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        m.applyMatrix4(M);
        m.renderOrder = 15;
        this.selOverlay.add(m);
      }
    }
    // Elementos selecionados: caixa de contorno em cada um.
    if (this.sel.elems.length && built) {
      const set = new Set(this.sel.elems);
      const pos: number[] = [];
      const mm = new THREE.Matrix4();
      for (const pl of built.ev.placements) {
        const k = elemKey(pl);
        if (!k || !set.has(k)) continue;
        const [w, h, dd] = pl.family.size(pl.params);
        mm.fromArray(pl.frame).premultiply(M);
        const c = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(mm);
        const xs = [-w / 2 - 0.05, w / 2 + 0.05],
          ys = [-0.05, h + 0.05],
          zs = [-0.05, Math.max(0.12, dd) + 0.05];
        const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => c(xs[i & 1]!, ys[(i >> 1) & 1]!, zs[(i >> 2) & 1]!));
        for (const [a, b2] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]] as [number, number][]) pos.push(...corners[a]!.toArray(), ...corners[b2]!.toArray());
      }
      if (pos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        // Forte onde o elemento aparece; fraco onde está escondido (pátio, outra face).
        const front = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#e2702a', depthTest: true }));
        const behind = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#e2702a', depthTest: false, transparent: true, opacity: 0.22 }));
        front.renderOrder = 22;
        behind.renderOrder = 21;
        this.selOverlay.add(front, behind);
      }
    }
    if (this.drag) {
      this.handles.set(this.handles.list.filter((h) => h.kind === (this.drag!.data.handle as string)));
      this.placeCtxBar();
      return;
    }
    if (!inCtx) {
      // Edifício inteiro: mover no chão e girar.
      const box = new THREE.Box3();
      for (const s of b.solids) for (const v of s.plan.outer) box.expandByPoint(W(v.p, 0));
      const c = box.getCenter(new THREE.Vector3());
      // Acima do topo: visível de qualquer ângulo, sem cruzar as paredes.
      c.y = Math.max(...b.solids.filter((x) => x.op === 'add').map((x) => x.base + x.height), 1) + 0.6;
      const R = Math.max(box.getSize(new THREE.Vector3()).length() / 2 + 1.5, 4);
      handles.push(...this.moveHandles(c, ax, az), this.rotateHandle(c, R));
    } else if (this.sel.item) {
      const it = this.activeItem();
      if (it && (it.host.kind === 'free' || it.host.kind === 'roof')) {
        const p = it.host.kind === 'free' ? it.host.p : [it.host.p[0], 0, it.host.p[1]];
        const c = W([p[0]!, p[2]!], (p[1] ?? 0) + 0.05);
        handles.push(...this.moveHandles(c, ax, az), this.rotateHandle(c, 2.5));
      }
    } else if (s0) {
      const r = solidRings(s0);
      const ctr = planCenter(s0);
      const base = W(ctr, s0.base + 0.05);
      const top = W(ctr, r.top);
      const faceMode = !!this.sel.face;
      // Mover e girar acima do topo do volume (sem cruzar as paredes); com uma face escolhida, só a seta da face.
      const over = W(ctr, r.top + 0.5);
      if (!faceMode) {
        handles.push(...this.moveHandles(over, ax, az));
        const R = Math.max(...r.outer.pts.map((p) => Math.hypot(p[0] - ctr[0], p[1] - ctr[1]))) + 1.2;
        handles.push(this.rotateHandle(over, R));
      }
      if (!faceMode || this.sel.face?.kind === 'top') handles.push({ kind: 'height', at: top, dir: new THREE.Vector3(0, 1, 0), solid: s0.id, color: HANDLE_COLORS.y, label: 'Altura' });
      if (!faceMode && (s0.base > 0.01 || s0.op !== 'add')) handles.push({ kind: 'lift', at: base, dir: new THREE.Vector3(0, -1, 0), solid: s0.id, color: HANDLE_COLORS.y, label: 'Elevação' });
      // Vértices e meios dos lados (curvar), na base se afunilado, senão no topo.
      const yv = s0.taper > 0.01 ? r.base : r.top;
      for (const ring of [s0.plan.outer, ...s0.plan.holes])
        ring.forEach((v, i) => {
          const n = ring[(i + 1) % ring.length]!;
          handles.push({ kind: 'vertex', at: W(v.p, yv), solid: s0.id, vertex: v.id, color: HANDLE_COLORS.vertex, label: 'Vértice' });
          const mid = midOf(v, n);
          handles.push({ kind: 'bend', at: W(mid, yv), solid: s0.id, edge: v.id, color: HANDLE_COLORS.bend, label: 'Curvar' });
        });
      if (this.sel.face?.kind === 'side' && this.sel.face.edge) {
        const n = edgeNormal(s0, this.sel.face.edge);
        const loc = s0.plan.outer.concat(...s0.plan.holes);
        const vi = loc.findIndex((v) => v.id === this.sel.face!.edge);
        if (n && vi >= 0) {
          const ringOf = [s0.plan.outer, ...s0.plan.holes].find((rg) => rg.some((v) => v.id === this.sel.face!.edge))!;
          const k = ringOf.findIndex((v) => v.id === this.sel.face!.edge);
          const mid = midOf(ringOf[k]!, ringOf[(k + 1) % ringOf.length]!);
          const at = W(mid, s0.base + s0.height / 2);
          const dir = new THREE.Vector3(n[0], 0, n[1]).transformDirection(M);
          handles.push({ kind: 'push', at, dir, solid: s0.id, edge: this.sel.face.edge, color: HANDLE_COLORS.push, label: 'Empurrar/puxar' });
        }
      }
    }
    this.handles.set(handles);
    this.placeCtxBar();
  }

  private moveHandles(c: THREE.Vector3, ax: THREE.Vector3, az: THREE.Vector3): Handle[] {
    return [
      { kind: 'move-x', at: c, dir: ax, color: HANDLE_COLORS.x, label: 'Mover no eixo vermelho' },
      { kind: 'move-z', at: c, dir: az, color: HANDLE_COLORS.z, label: 'Mover no eixo azul' },
      { kind: 'move-xz', at: c, color: HANDLE_COLORS.plane, label: 'Mover no chão' },
    ];
  }

  private rotateHandle(c: THREE.Vector3, R: number): Handle {
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < 64; i++) ring.push(new THREE.Vector3(c.x + Math.cos((i / 64) * Math.PI * 2) * R, c.y, c.z + Math.sin((i / 64) * Math.PI * 2) * R));
    return { kind: 'rotate', at: new THREE.Vector3(c.x + R * Math.cos(-0.6), c.y, c.z + R * Math.sin(-0.6)), ring, color: HANDLE_COLORS.ring, label: 'Girar' };
  }

  // ── Barra contextual ─────────────────────────────────────────────────
  private placeCtxBar(): void {
    const bar = this.shell.ctxbar;
    const b = this.activeBuilding();
    if (!b || this.drag || this.draft || this.tool !== 'select') {
      bar.hidden = true;
      return;
    }
    const s = this.activeSolid();
    const btn = (cmd: string, ic: string, label: string, pressed?: boolean, title = label) => `<button data-ctx="${cmd}" title="${title}" ${pressed !== undefined ? `aria-pressed="${pressed}"` : ''}>${icon(ic)}${label ? `<span>${label}</span>` : ''}</button>`;
    let html = '';
    if (this.context !== b.id) html = btn('enter', 'enter', 'Editar', undefined, 'Editar o edifício (duplo clique)') + '<span class="sep"></span>' + btn('dup', 'copy', '', undefined, 'Duplicar · Ctrl+D') + btn('rot90', 'rotate', '', undefined, 'Girar 90°') + btn('del', 'trash', '', undefined, 'Excluir · Delete');
    else if (this.sel.item) html = btn('dup', 'copy', '', undefined, 'Duplicar · Ctrl+D') + btn('del', 'trash', '', undefined, 'Excluir · Delete');
    else if (s)
      html =
        btn('op-add', 'add', 'Somar', s.op === 'add', 'O volume soma ao edifício') +
        btn('op-subtract', 'subtract', 'Recortar', s.op === 'subtract', 'O volume recorta o que veio antes (pátios, arcos, nichos)') +
        btn('op-intersect', 'intersect', 'Interseção', s.op === 'intersect', 'Fica só a parte em comum') +
        '<span class="sep"></span>' +
        btn('dup', 'copy', '', undefined, 'Duplicar · Ctrl+D') +
        btn('mirror', 'mirror', '', undefined, 'Espelhar') +
        btn('del', 'trash', '', undefined, 'Excluir · Delete');
    else html = btn('exit', 'exit', 'Sair', undefined, 'Sair do edifício · Esc') + btn('dup', 'copy', '', undefined, 'Duplicar edifício');
    bar.innerHTML = html;
    // Acima do topo da seleção.
    const M = this.view.buildingMatrix(b);
    let top = new THREE.Vector3();
    const list = s ? [s] : b.solids;
    let y = 0,
      cx = 0,
      cz = 0,
      n = 0;
    for (const x of list) {
      y = Math.max(y, x.base + x.height);
      const c = planCenter(x);
      cx += c[0];
      cz += c[1];
      n++;
    }
    top = new THREE.Vector3(cx / Math.max(1, n), y + 1.5, cz / Math.max(1, n)).applyMatrix4(M);
    const sp = this.view.toScreen(top);
    const r = this.shell.view.getBoundingClientRect();
    bar.hidden = sp.behind;
    bar.style.left = `${Math.max(120, Math.min(r.width - 120, sp.x))}px`;
    bar.style.top = `${Math.max(56, Math.min(r.height - 10, sp.y - 8))}px`;
    bar.querySelectorAll<HTMLButtonElement>('button').forEach((x) => x.addEventListener('click', () => this.command(x.dataset.ctx!)));
  }

  // ── Comandos ─────────────────────────────────────────────────────────
  command(cmd: string): void {
    const b = this.activeBuilding();
    const s = this.activeSolid();
    switch (cmd) {
      case 'enter':
        if (b) this.enter(b.id);
        break;
      case 'exit':
        this.exitContext();
        break;
      case 'op-add':
      case 'op-subtract':
      case 'op-intersect':
        if (s) this.changeSolid((x) => void (x.op = cmd.slice(3) as Solid['op']), cmd === 'op-add' ? 'O volume soma ao edifício.' : cmd === 'op-subtract' ? 'O volume agora recorta o edifício.' : 'Fica só a parte em comum.');
        break;
      case 'dup':
        this.duplicate();
        break;
      case 'mirror':
        if (s) this.changeSolid((x) => mirrorSolid(x, 'x'), 'Volume espelhado.');
        break;
      case 'rot90':
        if (b) this.change(b.id, (x) => void (x.rotation = (x.rotation + 90) % 360), 'Girado 90°.', false);
        break;
      case 'del':
        this.remove();
        break;
      case 'undo':
        if (this.store.undo()) this.toast('Desfeito.');
        break;
      case 'redo':
        if (this.store.redo()) this.toast('Refeito.');
        break;
      case 'frame':
        this.frameSelection();
        break;
    }
  }

  frameSelection(): void {
    const b = this.activeBuilding();
    const g = b && this.view.built.get(b.id)?.group;
    this.view.frame(g ? new THREE.Box3().setFromObject(g) : undefined);
  }

  duplicate(): void {
    const b = this.activeBuilding();
    if (!b) return;
    if (this.context === b.id && this.sel.item) {
      const it = this.activeItem()!;
      const c = structuredClone(it);
      c.id = uid();
      if (c.host.kind === 'face') c.host.u += 1.5;
      else if (c.host.kind === 'free') c.host.p = [c.host.p[0] + 1.5, c.host.p[1], c.host.p[2]];
      else if (c.host.kind === 'roof') c.host.p = [c.host.p[0] + 1.5, c.host.p[1]];
      this.change(b.id, (x) => void x.items.push(c), 'Componente duplicado.');
      this.select({ building: b.id, item: c.id });
      return;
    }
    if (this.context === b.id && this.sel.solids.length) {
      const ids: ID[] = [];
      this.change(
        b.id,
        (x) => {
          for (const sid of this.sel.solids) {
            const src = findSolid(x, sid);
            if (!src) continue;
            const c = cloneSolid(src);
            translateSolid(c, 2, 2);
            c.name = src.name + ' (cópia)';
            x.solids.push(c);
            ids.push(c.id);
          }
        },
        'Volume duplicado.',
      );
      this.select({ building: b.id, solids: ids });
      return;
    }
    const c = cloneBuilding(b);
    c.position = [b.position[0] + 4, b.position[1] + 4];
    c.name = b.name + ' (cópia)';
    this.store.project.buildings.push(c);
    this.store.commit([c.id], 'Edifício duplicado.');
    this.toast('Edifício duplicado.');
    this.select({ building: c.id });
  }

  remove(): void {
    const b = this.activeBuilding();
    if (!b) return;
    if (this.context === b.id && this.sel.item) {
      this.change(b.id, (x) => void (x.items = x.items.filter((i) => i.id !== this.sel.item)), 'Componente excluído.');
      return this.select({ building: b.id });
    }
    if (this.context === b.id && this.sel.elems.length) return this.elemAction('remove');
    if (this.context === b.id && this.sel.solids.length) {
      const del = new Set(this.sel.solids);
      this.change(b.id, (x) => {
        x.solids = x.solids.filter((s) => !del.has(s.id));
        x.items = x.items.filter((i) => !((i.host.kind === 'face' || i.host.kind === 'roof') && del.has(i.host.solid)));
      }, 'Volume excluído.');
      return this.select({ building: b.id });
    }
    this.store.project.buildings = this.store.project.buildings.filter((x) => x.id !== b.id);
    if (this.context === b.id) this.context = null;
    this.store.commit(null, 'Edifício excluído.');
    this.toast('Edifício excluído. Ctrl+Z desfaz.');
    this.select({});
  }

  copy(): void {
    const b = this.activeBuilding();
    if (!b) return;
    if (this.context === b.id && this.sel.item) this.clipboard = { kind: 'item', json: JSON.stringify(this.activeItem()) };
    else if (this.context === b.id && this.activeSolid()) this.clipboard = { kind: 'solid', json: JSON.stringify(this.activeSolid()) };
    else this.clipboard = { kind: 'building', json: JSON.stringify(b) };
    this.toast('Copiado.');
  }

  paste(): void {
    const c = this.clipboard;
    if (!c) return;
    const target = this.store.building(this.context);
    if (c.kind === 'building' || !target) {
      if (c.kind !== 'building') return;
      const b = cloneBuilding(JSON.parse(c.json) as Building3);
      b.position = [b.position[0] + 5, b.position[1] + 5];
      this.store.project.buildings.push(b);
      this.store.commit([b.id], 'Colado.');
      return this.select({ building: b.id });
    }
    if (c.kind === 'solid') {
      const s = cloneSolid(JSON.parse(c.json) as Solid);
      translateSolid(s, 2, 2);
      this.change(target.id, (x) => void x.solids.push(s), 'Colado.');
      return this.select({ building: target.id, solids: [s.id] });
    }
    const it = JSON.parse(c.json) as Item;
    it.id = uid();
    this.change(target.id, (x) => void x.items.push(it), 'Colado.');
  }

  // ── Elementos de fachada ─────────────────────────────────────────────
  /** Elementos (janelas, portas…) do edifício em edição. */
  elements(): Elem[] {
    const b = this.store.building(this.context ?? this.sel.building);
    const built = b && this.view.built.get(b.id);
    if (!b || !built) return [];
    return elementsOf(built.ev.placements, (pl) => {
      if (pl.tag.item) return b.items.find((i) => i.id === pl.tag.item)?.type ?? '';
      const rule = findSolid(b, pl.tag.solid)?.facade.find((f) => f.id === pl.tag.rule);
      const ex = rule?.except[pl.tag.key!];
      return ex && ex !== 'none' ? ex : (rule?.type ?? '');
    }, (pl) => {
      // Pavimento pela cota real (regras e peças avulsas na mesma numeração).
      const s = findSolid(b, pl.host!.solid);
      const y = (s?.base ?? 0) + pl.host!.y + 0.05;
      const lv = [...b.levels].sort((p, q) => p.elevation - q.elevation);
      let i = 0;
      lv.forEach((l, k) => {
        if (l.elevation <= y) i = k;
      });
      return i;
    });
  }

  /** Seleção de elementos: fileira, coluna, crescer, encolher, mesmo tipo, face, deslocar. */
  selectElems(op: 'row' | 'rowFace' | 'column' | 'grow' | 'shrink' | 'type' | 'face' | 'left' | 'right' | 'up' | 'down'): void {
    const all = this.elements();
    const cur = new Set(this.sel.elems);
    if (!cur.size) return;
    const next =
      op === 'row' ? row(all, cur) : op === 'rowFace' ? rowOnFace(all, cur) : op === 'column' ? column(all, cur) : op === 'grow' ? grow(all, cur) : op === 'shrink' ? shrink(all, cur) : op === 'type' ? sameType(all, cur) : op === 'face' ? sameFace(all, cur) : shift(all, cur, op);
    if (!next.size) return this.toast('Nada sobra para encolher.');
    this.select({ building: this.sel.building ?? this.context, elems: [...next] });
    this.toast(`${next.size} elemento(s) selecionado(s).`);
  }

  /** Ações em lote sobre os elementos selecionados. */
  elemAction(kind: 'remove' | 'restore' | 'swap' | 'vary', typeId?: ID): void {
    const b = this.activeBuilding();
    if (!b || !this.sel.elems.length) return;
    const keys = this.sel.elems;
    let varied: ID | null = null;
    if (kind === 'vary') {
      // Variação do tipo só para estes elementos (os demais seguem o tipo original).
      const first = this.elements().find((e) => e.key === keys[0]);
      const base = first && typeById(first.type, this.project);
      if (!base) return;
      const v = { id: uid(), family: base.family, name: base.name + ' (variação)', params: structuredClone(base.params), user: true };
      this.store.project.types.push(v);
      varied = v.id;
    }
    this.change(b.id, (x) => {
      for (const k of keys) {
        const parts = k.split('|');
        if (parts[0] === 'r') {
          const rule = findSolid(x, parts[1]!)?.facade.find((f) => f.id === parts[2]);
          if (!rule) continue;
          const pos = parts[3]!;
          if (kind === 'remove') rule.except[pos] = 'none';
          else if (kind === 'restore') delete rule.except[pos];
          else if (kind === 'swap' && typeId) rule.except[pos] = typeId;
          else if (kind === 'vary' && varied) rule.except[pos] = varied;
        } else if (parts[0] === 'i') {
          if (kind === 'remove') x.items = x.items.filter((i) => i.id !== parts[1]);
          else if ((kind === 'swap' && typeId) || (kind === 'vary' && varied)) {
            const it = x.items.find((i) => i.id === parts[1]);
            if (it) it.type = (typeId ?? varied)!;
          }
        }
      }
    }, kind === 'remove' ? `${keys.length} elemento(s) removido(s).` : kind === 'restore' ? 'Elementos voltaram à regra.' : kind === 'vary' ? 'Variação criada: edite os campos para mudar só estes.' : 'Tipo trocado.');
    if (kind === 'remove') this.select({ building: b.id });
    else if (varied) this.variation = varied;
  }

  /** Tipo de variação em edição (depois de "Editar só estes"). */
  variation: ID | null = null;

  // ── Ferramentas ──────────────────────────────────────────────────────
  setTool(t: Tool): void {
    this.cancel();
    this.shell.dim.hidden = true;
    this.tool = t;
    if (t !== 'place') this.placing = null;
    this.renderTools();
    this.updateHint();
    this.placeCtxBar();
    this.emit();
  }

  /** Começa a posicionar um tipo de componente. */
  startPlacing(typeId: ID): void {
    this.setTool('place');
    this.placing = typeId;
    const t = typeById(typeId, this.project);
    const f = t && family(t.family);
    this.updateHint(f ? (f.host === 'face' ? `${t!.name}: clique numa parede para colocar. Esc termina.` : f.host === 'path' ? `${t!.name}: clique os pontos do caminho; Enter termina.` : `${t!.name}: clique no chão ou no telhado.`) : undefined);
    this.emit();
  }

  private renderTools(): void {
    const tools: [Tool | string, string, string, string][] = [
      ['select', 'cursor', 'Selecionar e mover', 'V'],
      ['push', 'push', 'Empurrar/puxar faces', 'P'],
      ['|', '', '', ''],
      ['rect', 'rect', 'Retângulo', 'R'],
      ['circle', 'circle', 'Círculo', 'C'],
      ['polygon', 'polygon', 'Polígono (curve os lados depois)', 'L'],
      ['mode', this.drawMode === 'add' ? 'add' : 'subtract', this.drawMode === 'add' ? 'Desenho soma (troque para recortar)' : 'Desenho recorta (troque para somar)', 'X'],
      ['|', '', '', ''],
      ['catalog', 'catalog', 'Componentes', 'K'],
      ['paint', 'paint', 'Pintar (Alt: conta-gotas)', 'B'],
      ['tape', 'tape', 'Trena: mede e deixa cotas no modelo (Shift+Delete apaga)', 'T'],
      ['|', '', '', ''],
      ['frame', 'focus', 'Enquadrar', 'F'],
      ['grid', 'magnet', 'Encaixe ligado/desligado', 'G'],
    ];
    this.shell.tools.innerHTML = tools
      .map(([id, ic, label, key]) => (id === '|' ? '<hr>' : `<button class="f3-tool" data-tool="${id}" title="${label} · ${key}" aria-label="${label}" aria-pressed="${id === this.tool || (id === 'grid' && this.infer.enabled) || (id === 'mode' && this.drawMode === 'subtract')}">${icon(ic)}<span class="k">${key}</span></button>`))
      .join('');
    this.shell.tools.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.tool!;
        if (id === 'mode') this.toggleDrawMode();
        else if (id === 'catalog') this.emitCatalog();
        else if (id === 'frame') this.frameSelection();
        else if (id === 'grid') this.toggleSnap();
        else this.setTool(id as Tool);
      }),
    );
  }

  toggleDrawMode(): void {
    this.drawMode = this.drawMode === 'add' ? 'subtract' : 'add';
    this.renderTools();
    this.toast(this.drawMode === 'add' ? 'O desenho soma volumes.' : 'O desenho recorta: pátios, vãos, nichos, arcos.');
  }

  toggleSnap(): void {
    this.infer.enabled = !this.infer.enabled;
    this.renderTools();
    this.toast(this.infer.enabled ? 'Encaixe ligado.' : 'Encaixe desligado (movimento livre).');
  }

  /** O catálogo escuta isto para abrir/focar a busca. */
  catalogRequested: (() => void) | null = null;
  private emitCatalog(): void {
    this.catalogRequested?.();
  }

  updateHint(text?: string): void {
    const t =
      text ??
      ({
        select: this.context ? 'Clique num volume, face ou componente. Arraste o volume para mover; use as setas e as alças. Duplo clique numa face seleciona só ela.' : 'Clique num edifício para selecionar; arraste para mover. Duplo clique entra para editar.',
        push: 'Arraste uma face para empurrar ou puxar. Digite a distância e Enter.',
        rect: 'Clique dois cantos (no chão ou sobre um telhado plano). Depois digite 10x8 e Enter para largura × profundidade, ou um número para a altura.',
        circle: 'Clique o centro e depois o raio.',
        polygon: 'Clique os pontos; clique no primeiro ou Enter para fechar. Backspace volta um ponto.',
        place: 'Clique para colocar.',
        paint: 'Clique numa face para pintar. Alt+clique copia o material.',
      } as Record<Tool, string>)[this.tool];
    this.shell.status.hint.textContent = t;
  }

  private setMeasure(label: string, apply: Measure['apply']): void {
    this.measure = { label, apply };
    this.shell.status.vcbLabel.textContent = label;
  }

  // ── Ponteiro ─────────────────────────────────────────────────────────
  private bindCanvas(): void {
    const el = this.view.renderer.domElement;
    el.tabIndex = 0;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    let orbit: { x: number; y: number; pan: boolean } | null = null;
    el.addEventListener('pointerdown', (e) => {
      el.focus();
      if (e.button === 2 || e.button === 1) {
        orbit = { x: e.clientX, y: e.clientY, pan: e.button === 1 || e.shiftKey };
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      this.onDown(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (orbit) {
        const dx = e.clientX - orbit.x,
          dy = e.clientY - orbit.y;
        orbit.x = e.clientX;
        orbit.y = e.clientY;
        if (orbit.pan) {
          const k = this.view.distance * 0.0016;
          const right = new THREE.Vector3().setFromMatrixColumn(this.view.camera.matrixWorld, 0).setY(0).normalize();
          const fwd = new THREE.Vector3(-Math.sin(this.view.theta), 0, -Math.cos(this.view.theta));
          this.view.target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k);
        } else {
          this.view.theta -= dx * 0.006;
          this.view.phi -= dy * 0.006;
        }
        this.view.updateCamera();
        return;
      }
      this.onMove(e);
    });
    el.addEventListener('pointerup', (e) => {
      if (orbit) {
        orbit = null;
        return;
      }
      if (e.button === 0) this.onUp(e);
    });
    el.addEventListener('dblclick', (e) => this.onDouble(e));
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const k = Math.exp(e.deltaY * 0.0011);
        // Aproxima em direção ao ponto sob o cursor.
        const p = this.view.onPlane(e, 0);
        const before = this.view.distance;
        this.view.distance *= k;
        if (p && k < 1) this.view.target.lerp(new THREE.Vector3(p.x, this.view.target.y, p.z), (1 - k) * 0.6);
        void before;
        this.view.updateCamera();
      },
      { passive: false },
    );
    // Arrastar do catálogo para a vista.
    this.shell.view.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('text/forma-type')) {
        e.preventDefault();
        this.tool = 'place';
        this.placing = this.placing ?? null;
        this.onMove(e as unknown as PointerEvent);
      }
    });
    this.shell.view.addEventListener('drop', (e) => {
      const id = e.dataTransfer?.getData('text/forma-type');
      if (!id) return;
      e.preventDefault();
      this.startPlacing(id);
      this.placeAt(e as unknown as PointerEvent);
    });
  }

  private pickAt(e: { clientX: number; clientY: number }, only?: ID | null): Hit | null {
    return this.view.pick(this.store.project, e, only);
  }

  private onDown(e: PointerEvent): void {
    if (this.tool === 'select' || this.tool === 'push') {
      const h = this.tool === 'select' ? this.handles.hit(e) : null;
      if (h) {
        this.beginHandle(h, e);
        if (this.drag) this.drag.data.viaHandle = true;
        return;
      }
      const hit = this.pickAt(e);
      if (this.tool === 'push') {
        if (hit?.face && (hit.face.kind === 'side' || hit.face.kind === 'top' || hit.face.kind === 'roof') && hit.building) {
          if (this.context !== hit.building.id) this.context = hit.building.id;
          this.select({ building: hit.building.id, solids: [hit.face.solid], face: hit.face.kind === 'side' ? { kind: 'side', edge: hit.face.edge! } : { kind: 'top' } });
          const fh = this.handles.list.find((x) => x.kind === (hit.face!.kind === 'side' ? 'push' : 'height'));
          if (fh) this.beginHandle(fh, e);
        }
        return;
      }
      this.clickSelect(hit, e);
      // Arrastar o que está selecionado move (direto no modelo).
      const b = this.activeBuilding();
      if (hit && b && hit.building.id === b.id) {
        if (this.context !== b.id) this.beginMoveBuilding(b, e, hit);
        else if (this.sel.item) this.beginMoveItem(b, e, hit);
        else if (this.sel.solids.length) this.beginMoveSolids(b, e, hit);
      }
      return;
    }
    if (this.tool === 'rect' || this.tool === 'circle' || this.tool === 'polygon') return this.drawDown(e);
    if (this.tool === 'place') return this.placeAt(e);
    if (this.tool === 'block') return this.blockAt(e, true);
    if (this.tool === 'tape') return this.tapeAt(e, true);
    if (this.tool === 'paint') return this.paintAt(e);
  }

  private clickSelect(hit: Hit | null, e: PointerEvent): void {
    if (!hit) {
      if (this.context) {
        if (this.sel.solids.length || this.sel.item) return this.select({ building: this.context });
        const id = this.context;
        this.context = null;
        return this.select({ building: id });
      }
      return this.select({});
    }
    const b = hit.building;
    if (this.context !== b.id) {
      if (this.context) this.context = null;
      return this.select({ building: b.id });
    }
    if (hit.part) {
      const key = hit.part.rule ? `r|${hit.part.solid}|${hit.part.rule}|${hit.part.key}` : hit.part.item ? `i|${hit.part.item}|${hit.part.key ?? '0'}` : null;
      if (key && (e.shiftKey || e.ctrlKey) && this.sel.elems.length) {
        // Shift: acrescenta/tira; Ctrl+Shift: o trecho entre o último e este.
        const set = e.ctrlKey && e.shiftKey ? new Set([...this.sel.elems, ...between(this.elements(), this.sel.elems[this.sel.elems.length - 1]!, key)]) : new Set(this.sel.elems);
        if (!(e.ctrlKey && e.shiftKey)) set.has(key) ? set.delete(key) : set.add(key);
        return this.select({ building: b.id, elems: [...set], item: set.size === 1 && hit.part.item ? hit.part.item : null });
      }
      if (hit.part.item) return this.select({ building: b.id, item: hit.part.item, elems: key ? [key] : [] });
      if (key) return this.select({ building: b.id, elems: [key] });
    }
    const f = hit.face;
    if (!f) return;
    const sid = f.solid;
    if (e.shiftKey && !this.sel.item) {
      const set = new Set(this.sel.solids);
      set.has(sid) ? set.delete(sid) : set.add(sid);
      return this.select({ building: b.id, solids: [...set] });
    }
    // Primeiro clique: o volume; clique de novo no mesmo volume: a face.
    const already = this.sel.solids.length === 1 && this.sel.solids[0] === sid;
    const face = already && (f.kind === 'side' || f.kind === 'top' || f.kind === 'roof') ? (f.kind === 'side' ? { kind: 'side' as const, edge: f.edge! } : { kind: 'top' as const }) : null;
    this.select({ building: b.id, solids: [sid], face });
  }

  private onDouble(e: MouseEvent): void {
    if (this.tool === 'polygon' && this.draft) return this.finishPolygon();
    if (this.tool !== 'select') return;
    const hit = this.pickAt(e);
    if (!hit) return;
    if (this.context === hit.building.id && hit.part && (hit.part.rule || hit.part.item)) {
      // Duplo clique num elemento: a fileira inteira (Loop do 3ds Max).
      if (!this.sel.elems.length) this.clickSelect(hit, e as PointerEvent);
      return this.selectElems('row');
    }
    if (this.context !== hit.building.id) {
      this.enter(hit.building.id);
      const h2 = this.pickAt(e, hit.building.id);
      if (h2?.face) this.select({ building: hit.building.id, solids: [h2.face.solid] });
      this.toast('Editando o edifício. Esc sai.');
    } else if (hit.face && (hit.face.kind === 'side' || hit.face.kind === 'top')) {
      this.select({ building: hit.building.id, solids: [hit.face.solid], face: hit.face.kind === 'side' ? { kind: 'side', edge: hit.face.edge! } : { kind: 'top' } });
    }
  }

  private onMove(e: PointerEvent): void {
    if (this.drag) return this.updateDrag(e);
    if (this.tool === 'select') {
      this.handles.setHover(this.handles.hit(e));
      this.view.renderer.domElement.style.cursor = this.handles.hover ? 'grab' : 'default';
      if (this.handles.hover) this.shell.status.hint.textContent = this.handles.hover.label;
      return;
    }
    if (this.tool === 'rect' || this.tool === 'circle' || this.tool === 'polygon') return this.drawMove(e);
    if (this.tool === 'place') return this.placeHover(e);
    if (this.tool === 'block') return this.blockAt(e, false);
    if (this.tool === 'tape') return this.tapeAt(e, false);
  }

  private onUp(e: PointerEvent): void {
    if (this.drag) return this.finishDrag(e);
    if ((this.tool === 'rect' || this.tool === 'circle') && this.draft && this.draft.points.length === 1 && this.draft.hover && this.draft.hover.distanceTo(this.draft.points[0]!) > 0.6) this.drawDown(e);
  }

  cancel(): void {
    if (this.drag) {
      this.store.revert();
      this.drag = null;
      this.preview.clear();
    }
    this.draft = null;
    this.tapeFrom = null;
    this.clearSnap();
    this.removeGhost();
    for (const n of ['block', 'tape']) {
      const o = this.snapOverlay.getObjectByName(n);
      if (o) this.snapOverlay.remove(o);
    }
    this.shell.dim.hidden = true;
    this.drawSelection();
  }

  // ── Arrastos ─────────────────────────────────────────────────────────
  private startDrag(kind: string, b: Building3, e: { clientX: number; clientY: number }, data: Record<string, unknown>, geometry: boolean): void {
    this.drag = { kind, bid: b.id, start: { x: e.clientX, y: e.clientY }, moved: false, origBuilding: structuredClone(b), data, geometry };
  }

  private beginHandle(h: Handle, e: PointerEvent): void {
    const b = this.activeBuilding();
    if (!b) return;
    const inCtx = this.context === b.id;
    const s = this.activeSolid();
    if (h.kind === 'move-x' || h.kind === 'move-z' || h.kind === 'move-xz') {
      if (!inCtx) return this.beginMoveBuilding(b, e, null, h);
      if (this.sel.item) return this.beginMoveItem(b, e, null, h);
      if (s) return this.beginMoveSolids(b, e, null, h);
    }
    if (h.kind === 'rotate') {
      const c = h.ring ? ringCenter(h.ring) : h.at;
      this.startDrag('rotate', b, e, { handle: 'rotate', center: c, a0: this.angleAt(e, c), copy: e.ctrlKey, inCtx }, inCtx);
      this.setMeasure('Ângulo', (t) => {
        const v = parseLength(t);
        if (v === null) return false;
        this.applyRotation(v, this.drag?.origBuilding ?? structuredClone(b));
        return true;
      });
      return;
    }
    if (!s) return;
    const M = this.view.buildingMatrix(b);
    if (h.kind === 'height' || h.kind === 'lift') {
      this.startDrag(h.kind, b, e, { handle: h.kind, at: h.at.clone(), h0: s.height, b0: s.base, sid: s.id }, true);
      this.preview.add(b.id);
      this.setMeasure(h.kind === 'height' ? 'Altura' : 'Elevação', (t) => {
        const v = parseLength(t);
        if (v === null || v <= 0) return false;
        this.change(b.id, (x) => {
          const y = findSolid(x, s.id)!;
          if (h.kind === 'height') y.height = v;
          else y.base = v;
        }, h.kind === 'height' ? `Altura ${fmt(v)} m.` : `Elevação ${fmt(v)} m.`);
        return true;
      });
      return;
    }
    if (h.kind === 'push') {
      this.startDrag('push', b, e, { handle: 'push', at: h.at.clone(), dir: h.dir!.clone(), edge: h.edge, sid: s.id, plan: structuredClone(s.plan) }, true);
      this.preview.add(b.id);
      this.setMeasure('Distância', (t) => {
        const v = parseLength(t);
        if (v === null) return false;
        const last = (this.lastPush ?? 0) >= 0 ? 1 : -1;
        this.change(b.id, (x) => pushEdge(findSolid(x, s.id)!, h.edge!, v * last), `Face movida ${fmt(v)} m.`);
        return true;
      });
      return;
    }
    if (h.kind === 'vertex' || h.kind === 'bend') {
      const y = h.at.y;
      this.startDrag(h.kind, b, e, { handle: h.kind, y, vertex: h.vertex, edge: h.edge, sid: s.id, M }, true);
      this.preview.add(b.id);
      if (h.kind === 'bend') this.setMeasure('Flecha', (t) => {
        const v = parseLength(t);
        if (v === null) return false;
        this.change(b.id, (x) => {
          const so = findSolid(x, s.id)!;
          const n = edgeNormal(so, h.edge!)!;
          const ring = [so.plan.outer, ...so.plan.holes].find((r) => r.some((q) => q.id === h.edge))!;
          const k = ring.findIndex((q) => q.id === h.edge);
          const m = midOf(ring[k]!, ring[(k + 1) % ring.length]!, true);
          return bendEdge(so, h.edge!, [m[0] + n[0] * v, m[1] + n[1] * v]);
        }, 'Lado curvado.');
        return true;
      });
    }
  }

  private lastPush: number | null = null;

  private beginMoveBuilding(b: Building3, e: PointerEvent, hit: Hit | null, h?: Handle): void {
    const p0 = this.view.onPlane(e, 0) ?? new THREE.Vector3(b.position[0], 0, b.position[1]);
    this.startDrag('move-building', b, e, { handle: h?.kind ?? 'move-xz', p0, axis: h?.dir?.clone() ?? null, copy: e.ctrlKey, hitY: hit?.point.y ?? 0 }, false);
    this.setMoveMeasure();
  }

  private beginMoveSolids(b: Building3, e: PointerEvent, hit: Hit | null, h?: Handle): void {
    const s = this.activeSolid()!;
    const p0 = this.view.onPlane(e, s.base) ?? new THREE.Vector3();
    this.startDrag('move-solids', b, e, { handle: h?.kind ?? 'move-xz', p0, axis: h?.dir?.clone() ?? null, copy: e.ctrlKey, ids: [...this.sel.solids], y: s.base }, true);
    void hit;
    this.preview.add(b.id);
    this.setMoveMeasure();
  }

  private beginMoveItem(b: Building3, e: PointerEvent, hit: Hit | null, h?: Handle): void {
    const it = this.activeItem();
    if (!it) return;
    void hit;
    this.startDrag('move-item', b, e, { handle: h?.kind ?? 'move-xz', axis: h?.dir?.clone() ?? null, id: it.id }, true);
  }

  private setMoveMeasure(): void {
    this.setMeasure('Distância', (t) => {
      const m = /^(\d+)\s*([x*/])$/.exec(t.trim());
      if (m) return this.arrayLast(parseInt(m[1]!, 10), m[2] === '/');
      const v = parseLength(t);
      if (v === null || !this.lastMove) return false;
      const d = this.lastMove.clone().normalize().multiplyScalar(v);
      this.applyMoveDelta(d, true);
      return true;
    });
  }

  private lastMove: THREE.Vector3 | null = null;
  private lastMoved: { kind: 'building' | 'solids'; bid: ID; ids: ID[]; delta: THREE.Vector3; copied: boolean } | null = null;

  /** Cópias em série depois de mover com Ctrl (5x) ou divisão (5/), como no SketchUp. */
  private arrayLast(n: number, divide: boolean): boolean {
    const lm = this.lastMoved;
    if (!lm || !lm.copied || n < 2) {
      this.toast('Mova com Ctrl (cópia) e depois digite 5x.');
      return false;
    }
    const step = divide ? lm.delta.clone().divideScalar(n) : lm.delta.clone();
    if (lm.kind === 'building') {
      const src = this.store.building(lm.bid);
      if (!src) return false;
      if (divide) {
        src.position = [src.position[0] - lm.delta.x + step.x, src.position[1] - lm.delta.z + step.z];
      }
      for (let i = 1; i < n; i++) {
        const c = cloneBuilding(src);
        c.position = [src.position[0] + step.x * i, src.position[1] + step.z * i];
        this.store.project.buildings.push(c);
      }
      this.store.commit(null, `${n} cópias.`);
      this.toast(`${divide ? n : n} cópias.`);
      return true;
    }
    return this.change(lm.bid, (b) => {
      const local = dirToLocal(b, [step.x, step.z]);
      for (const sid of lm.ids) {
        const src = findSolid(b, sid);
        if (!src) continue;
        if (divide) translateSolid(src, -dirToLocal(b, [lm.delta.x, lm.delta.z])[0] + local[0], -dirToLocal(b, [lm.delta.x, lm.delta.z])[1] + local[1]);
        for (let i = 1; i < n; i++) {
          const c = cloneSolid(src);
          translateSolid(c, local[0] * i, local[1] * i);
          b.solids.push(c);
        }
      }
    }, `${n} cópias.`);
  }

  private angleAt(e: { clientX: number; clientY: number }, c: THREE.Vector3): number {
    const p = this.view.onPlane(e, c.y);
    return p ? Math.atan2(-(p.z - c.z), p.x - c.x) : 0;
  }

  private applyRotation(deg: number, orig: Building3): void {
    const d = this.drag;
    const b = this.store.building(orig.id);
    if (!b) return;
    if (!d || !(d.data.inCtx as boolean)) {
      // Edifício inteiro: gira em torno do centro dos seus volumes.
      const c = (d?.data.center as THREE.Vector3) ?? new THREE.Vector3(b.position[0], 0, b.position[1]);
      const a = rad(deg);
      const ox = orig.position[0] - c.x,
        oz = orig.position[1] - c.z;
      b.position = [c.x + ox * Math.cos(a) + oz * Math.sin(a), c.z - ox * Math.sin(a) + oz * Math.cos(a)];
      b.rotation = (((orig.rotation + deg) % 360) + 360) % 360;
      if (!d) this.store.commit([b.id], `Girado ${fmt(deg)}°.`, false);
      else this.store.touch([]);
      return;
    }
    if (this.sel.item) {
      const it = b.items.find((i) => i.id === this.sel.item);
      const io = orig.items.find((i) => i.id === this.sel.item);
      if (it && io && (it.host.kind === 'free' || it.host.kind === 'roof') && (io.host.kind === 'free' || io.host.kind === 'roof')) it.host.rot = io.host.rot + deg;
      return;
    }
    const c = (d.data.center as THREE.Vector3).clone();
    const cl = toLocal(b, [c.x, c.z]);
    for (const sid of this.sel.solids) {
      const so = findSolid(orig, sid),
        s = findSolid(b, sid);
      if (!so || !s) continue;
      s.plan = structuredClone(so.plan);
      rotateSolid(s, deg, cl);
    }
  }

  private updateDrag(e: PointerEvent): void {
    const d = this.drag!;
    if (!d.moved && Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) < 4) return;
    if (!d.moved && d.data.copy) this.makeDragCopy();
    d.moved = true;
    const b = this.store.building(d.bid);
    if (!b) return;
    const orig = d.origBuilding;
    if (d.kind === 'move-building' || d.kind === 'move-solids') {
      const y = d.kind === 'move-solids' ? (d.data.y as number) : 0;
      const p0 = d.data.p0 as THREE.Vector3;
      const axis = d.data.axis as THREE.Vector3 | null;
      const snap = this.infer.snap(e, y, p0, axis, 12);
      if (!snap) return;
      this.showSnap(snap, e);
      const delta = snap.p.clone().sub(p0).setY(0);
      // Encaixe de blocos: um vértice do que se move gruda num vértice ou numa
      // aresta de outro volume (faces encostadas com perfeição).
      if (this.infer.enabled && !e.altKey) {
        const fix = this.blockSnap(d, delta, this.view.worldPerPixel(p0) * 14);
        if (fix) {
          delta.add(fix.v);
          this.showSnap({ kind: fix.kind, p: fix.at, label: fix.kind === 'vertex' ? 'Encaixe no vértice' : 'Face encostada', color: SNAP_COLORS[fix.kind] }, e);
        }
      }
      this.applyMoveDelta(delta, false);
      this.showDim(`${fmt(delta.length())} m`, e);
      return;
    }
    if (d.kind === 'move-item') {
      const it = b.items.find((i) => i.id === d.data.id),
        io = orig.items.find((i) => i.id === d.data.id);
      if (!it || !io) return;
      if (it.host.kind === 'face' && io.host.kind === 'face') {
        // Arrasta ao longo da face: projeta no plano da face.
        const hit = this.pickAt(e, b.id);
        if (hit?.face?.kind === 'side' && hit.face.solid === io.host.solid && hit.face.edge === io.host.edge && hit.face.frame) {
          const local = new THREE.Vector3().copy(hit.point).applyMatrix4(this.view.buildingMatrix(b).invert());
          const fr = hit.face.frame;
          const s = fr.s0 + (local.x - fr.o[0]) * fr.u[0] + (local.y - fr.o[1]) * fr.u[1] + (local.z - fr.o[2]) * fr.u[2];
          const fam = family(typeById(io.type, this.project)?.family ?? '');
          const h = fam ? fam.size(resolveParams(fam, typeById(io.type, this.project)?.params, io.params))[1] : 1;
          let yy = (local.x - fr.o[0]) * fr.v[0] + (local.y - fr.o[1]) * fr.v[1] + (local.z - fr.o[2]) * fr.v[2] - h / 2;
          if (this.infer.enabled) yy = Math.round(yy / 0.05) * 0.05;
          it.host.u = this.infer.enabled ? Math.round(s / 0.1) * 0.1 : s;
          it.host.y = Math.max(0, yy);
          this.store.touch([b.id]);
          this.showDim(`${fmt(it.host.u)} m · ${fmt(it.host.y)} m`, e);
        }
        return;
      }
      if ((it.host.kind === 'free' || it.host.kind === 'roof') && (io.host.kind === 'free' || io.host.kind === 'roof')) {
        const snap = this.infer.snap(e, io.host.kind === 'free' ? io.host.p[1] : 0, null, null);
        if (!snap) return;
        const l = toLocal(b, [snap.p.x, snap.p.z]);
        if (it.host.kind === 'free' && io.host.kind === 'free') it.host.p = [l[0], io.host.p[1], l[1]];
        else if (it.host.kind === 'roof') it.host.p = [l[0], l[1]];
        this.store.touch([b.id]);
      }
      return;
    }
    if (d.kind === 'rotate') {
      const c = d.data.center as THREE.Vector3;
      let deg = ((this.angleAt(e, c) - (d.data.a0 as number)) * 180) / Math.PI;
      if (!e.shiftKey && this.infer.enabled) deg = Math.round(deg / 15) * 15;
      this.store.project = structuredClone(this.store.project);
      const idx = this.store.project.buildings.findIndex((x) => x.id === d.bid);
      this.store.project.buildings[idx] = structuredClone(orig);
      this.applyRotation(deg, orig);
      if (d.data.inCtx) this.store.touch([d.bid]);
      else this.view.sync(this.store.project, this.store.revision, this.preview);
      this.showDim(`${fmt(deg)}°`, e);
      this.drawSelection();
      return;
    }
    const s = findSolid(b, d.data.sid as ID);
    const so = findSolid(orig, d.data.sid as ID);
    if (!s || !so) return;
    if (d.kind === 'height' || d.kind === 'lift') {
      const at = d.data.at as THREE.Vector3;
      const t = this.alongLine(e, at, new THREE.Vector3(0, 1, 0));
      const tops = b.solids.filter((x) => x.id !== s.id).flatMap((x) => [x.base + x.height, x.base]).concat(b.levels.map((l) => l.elevation), b.levels.map((l) => l.elevation + l.height));
      if (d.kind === 'height') {
        const want = so.base + so.height + t;
        const sn = e.altKey ? { value: want, snapped: false } : this.infer.snapHeight(want, tops, 0.3);
        s.height = Math.max(0.3, sn.value - so.base);
        this.showDim(`${fmt(s.height)} m${sn.snapped ? ' · alinhado' : ''}`, e);
      } else {
        const want = so.base + t;
        const sn = e.altKey ? { value: want, snapped: false } : this.infer.snapHeight(want, tops, 0.3);
        s.base = sn.value;
        this.showDim(`base ${fmt(s.base)} m`, e);
      }
      this.store.touch([b.id]);
      return;
    }
    if (d.kind === 'push') {
      const at = d.data.at as THREE.Vector3,
        dir = d.data.dir as THREE.Vector3;
      let t = this.alongLine(e, at, dir);
      if (!e.altKey && this.infer.enabled) t = Math.round(t / 0.1) * 0.1;
      s.plan = structuredClone(so.plan);
      if (pushEdge(s, d.data.edge as ID, t)) {
        this.lastPush = t;
        this.store.touch([b.id]);
      }
      this.showDim(`${t >= 0 ? '+' : ''}${fmt(t)} m`, e);
      return;
    }
    if (d.kind === 'vertex' || d.kind === 'bend') {
      const snap = this.infer.snap(e, d.data.y as number, null, null);
      if (!snap) return;
      this.showSnap(snap, e);
      const l = toLocal(b, [snap.p.x, snap.p.z]);
      s.plan = structuredClone(so.plan);
      const ok = d.kind === 'vertex' ? moveVertex(s, d.data.vertex as ID, l) : bendEdge(s, d.data.edge as ID, l);
      if (ok) this.store.touch([b.id]);
      this.drawSelection();
    }
  }

  /** Correção do deslocamento para encaixar vértices do que se move em vértices/arestas dos outros. */
  private blockSnap(d: Drag, delta: THREE.Vector3, tol: number): { v: THREE.Vector3; at: THREE.Vector3; kind: 'vertex' | 'edge' } | null {
    const ob = d.origBuilding;
    const moving = new Set(d.kind === 'move-solids' ? (d.data.ids as ID[]) : []);
    const mine: THREE.Vector3[] = [];
    const others: [THREE.Vector3, THREE.Vector3][] = [];
    const ring = (b: Building3, s: Solid) => {
      const r = solidRings(s);
      return r.outer.pts.filter((_, i) => !r.outer.segs[i]!.curved).map((p) => {
        const w = toWorld(b, p);
        return new THREE.Vector3(w[0], 0, w[1]);
      });
    };
    for (const b of this.project.buildings) {
      const src = b.id === ob.id ? ob : b;
      for (const s of src.solids) {
        if (s.hidden) continue;
        const pts = ring(src, s);
        const isMoving = d.kind === 'move-building' ? b.id === ob.id : b.id === ob.id && moving.has(s.id);
        if (isMoving) mine.push(...pts);
        else if (s.op === 'add') pts.forEach((p, i) => others.push([p, pts[(i + 1) % pts.length]!]));
      }
    }
    let best: { dist: number; v: THREE.Vector3; at: THREE.Vector3; kind: 'vertex' | 'edge' } | null = null;
    for (const m of mine) {
      const q = m.clone().add(delta);
      for (const [a, b2] of others) {
        const dv = a.distanceTo(q);
        if (dv < tol && (!best || dv < best.dist - 1e-6 || best.kind === 'edge')) best = { dist: dv, v: a.clone().sub(q), at: a.clone(), kind: 'vertex' };
        if (best?.kind === 'vertex') continue;
        const ab = b2.clone().sub(a);
        const t = Math.max(0, Math.min(1, q.clone().sub(a).dot(ab) / (ab.lengthSq() || 1)));
        const proj = a.clone().addScaledVector(ab, t);
        const de = proj.distanceTo(q);
        if (de < tol * 0.8 && (!best || de < best.dist)) best = { dist: de, v: proj.clone().sub(q), at: proj, kind: 'edge' };
      }
    }
    return best ? { v: best.v, at: best.at.setY(d.kind === 'move-solids' ? (d.data.y as number) : 0), kind: best.kind } : null;
  }

  /** Desloca o que está sendo movido (a partir do estado inicial). */
  private applyMoveDelta(delta: THREE.Vector3, commit: boolean): void {
    const d = this.drag;
    const bid = d?.bid ?? this.lastMoved?.bid;
    const b = bid ? this.store.building(bid) : undefined;
    if (!b) return;
    if ((d && d.kind === 'move-building') || (!d && this.lastMoved?.kind === 'building')) {
      const orig = d ? d.origBuilding : null;
      const base = orig ? orig.position : [b.position[0] - this.lastMoved!.delta.x, b.position[1] - this.lastMoved!.delta.z];
      b.position = [base[0]! + delta.x, base[1]! + delta.z];
      if (commit) {
        this.lastMoved = { kind: 'building', bid: b.id, ids: [], delta: delta.clone(), copied: this.lastMoved?.copied ?? false };
        this.store.commit([b.id], `Movido ${fmt(delta.length())} m.`, false);
      } else this.view.sync(this.store.project, this.store.revision, this.preview);
      this.drawSelection();
      return;
    }
    const ids = d ? (d.data.ids as ID[]) : this.lastMoved!.ids;
    const local = dirToLocal(b, [delta.x, delta.z]);
    for (const sid of ids) {
      const s = findSolid(b, sid);
      const so = d ? findSolid(d.origBuilding, sid) : null;
      if (!s) continue;
      if (so) s.plan = structuredClone(so.plan);
      else translateSolid(s, -dirToLocal(b, [this.lastMoved!.delta.x, this.lastMoved!.delta.z])[0], -dirToLocal(b, [this.lastMoved!.delta.x, this.lastMoved!.delta.z])[1]);
      translateSolid(s, local[0], local[1]);
    }
    if (commit) {
      this.lastMoved = { kind: 'solids', bid: b.id, ids, delta: delta.clone(), copied: this.lastMoved?.copied ?? false };
      this.store.commit([b.id], `Movido ${fmt(delta.length())} m.`);
    } else this.store.touch([b.id]);
  }

  /** Ctrl ao começar a mover: o original fica, a cópia anda. */
  private makeDragCopy(): void {
    const d = this.drag!;
    const b = this.store.building(d.bid)!;
    if (d.kind === 'move-building') {
      const c = cloneBuilding(b);
      this.store.project.buildings.push(c);
      d.bid = c.id;
      d.origBuilding = structuredClone(c);
      this.sel.building = c.id;
    } else if (d.kind === 'move-solids') {
      const ids: ID[] = [];
      for (const sid of d.data.ids as ID[]) {
        const src = findSolid(b, sid);
        if (!src) continue;
        const c = cloneSolid(src);
        b.solids.push(c);
        ids.push(c.id);
      }
      d.data.ids = ids;
      d.origBuilding = structuredClone(b);
      this.sel.solids = ids;
    }
    d.data.copied = true;
  }

  /** Distância ao longo de uma reta (no mundo) até o ponto mais próximo do raio do mouse. */
  private alongLine(e: { clientX: number; clientY: number }, at: THREE.Vector3, dir: THREE.Vector3): number {
    const ray = this.view.rayFrom(e).ray;
    const d = dir.clone().normalize();
    const w0 = at.clone().sub(ray.origin);
    const a = d.dot(d),
      b = d.dot(ray.direction),
      c = ray.direction.dot(ray.direction),
      dd = d.dot(w0),
      ee = ray.direction.dot(w0);
    const den = a * c - b * b;
    if (Math.abs(den) < 1e-9) return 0;
    return (b * ee - c * dd) / den;
  }

  private finishDrag(e: PointerEvent): void {
    const d = this.drag!;
    this.drag = null;
    this.preview.delete(d.bid);
    this.clearSnap();
    this.shell.dim.hidden = true;
    if (!d.moved) {
      this.store.revert();
      // Clique sem arrastar numa alça: vale como clique no modelo (selecionar face, etc.).
      if (d.data.viaHandle && this.tool === 'select') this.clickSelect(this.pickAt(e), e);
      else this.drawSelection();
      return;
    }
    const b = this.store.building(d.bid);
    if (d.kind === 'move-building' && b) {
      const delta = new THREE.Vector3(b.position[0] - d.origBuilding.position[0], 0, b.position[1] - d.origBuilding.position[1]);
      this.lastMove = delta.clone();
      this.lastMoved = { kind: 'building', bid: b.id, ids: [], delta, copied: !!d.data.copied };
      this.store.commit([b.id], d.data.copied ? 'Copiado. Digite 5x para mais cópias.' : `Movido ${fmt(delta.length())} m.`, !!d.data.copied);
      if (d.data.copied) this.toast('Copiado. Digite 5x para mais cópias.');
      return;
    }
    if (d.kind === 'move-solids' && b) {
      const s = findSolid(b, (d.data.ids as ID[])[0]!),
        so = findSolid(d.origBuilding, (d.data.ids as ID[])[0]!);
      if (s && so) {
        const a = toWorld(b, planCenter(so)),
          c = toWorld(b, planCenter(s));
        const delta = new THREE.Vector3(c[0] - a[0], 0, c[1] - a[1]);
        this.lastMove = delta;
        this.lastMoved = { kind: 'solids', bid: b.id, ids: d.data.ids as ID[], delta, copied: !!d.data.copied };
      }
    }
    if (d.kind === 'rotate' && !d.data.inCtx) {
      this.store.commit([d.bid], 'Girado.', false);
      return;
    }
    this.store.commit([d.bid], '');
    void e;
  }

  // ── Desenho ──────────────────────────────────────────────────────────
  private drawPlane(e: { clientX: number; clientY: number }): { y: number; bid: ID | null } {
    const hit = this.pickAt(e);
    if (hit?.face && (hit.face.kind === 'top' || hit.face.kind === 'parapet') && hit.normal.y > 0.9) return { y: hit.point.y, bid: hit.building.id };
    return { y: 0, bid: this.context };
  }

  private drawDown(e: PointerEvent): void {
    if (!this.draft) {
      const pl = this.drawPlane(e);
      const sn = this.infer.snap(e, pl.y, null, null);
      if (!sn) return;
      this.draft = { points: [sn.p.clone()], y: pl.y, bid: pl.bid, hover: sn.p.clone() };
      return;
    }
    const sn = this.infer.snap(e, this.draft.y, this.draft.points[this.draft.points.length - 1]!, e.shiftKey && this.lastSnap?.line ? this.lastSnap.line[1].clone().sub(this.lastSnap.line[0]) : null);
    if (!sn) return;
    if (this.tool === 'polygon') {
      const first = this.draft.points[0]!;
      if (this.draft.points.length >= 3 && this.view.toScreen(first).x !== undefined && screenDist(this.view, first, sn.p) < 12) return this.finishPolygon();
      this.draft.points.push(sn.p.clone());
      return;
    }
    this.draft.points.push(sn.p.clone());
    this.finishShape();
  }

  private drawMove(e: PointerEvent): void {
    const from = this.draft?.points[this.draft.points.length - 1] ?? null;
    const y = this.draft?.y ?? this.drawPlane(e).y;
    const sn = this.infer.snap(e, y, from, null);
    if (!sn) return;
    this.showSnap(sn, e);
    if (!this.draft) return;
    this.draft.hover = sn.p.clone();
    this.drawDraft();
    const a = this.draft.points[0]!;
    if (this.tool === 'rect') {
      const [ax, az] = this.infer.axes();
      const d = sn.p.clone().sub(a);
      this.showDim(`${fmt(Math.abs(d.dot(ax!)))} × ${fmt(Math.abs(d.dot(az!)))} m`, e);
    } else if (this.tool === 'circle') this.showDim(`r ${fmt(sn.p.distanceTo(a))} m`, e);
    else this.showDim(`${fmt(sn.p.distanceTo(from!))} m`, e);
  }

  private drawDraft(): void {
    const dr = this.draft;
    if (!dr || !dr.hover) return;
    const pts = this.shapePoints(dr.points.concat(this.tool === 'polygon' ? [dr.hover] : [dr.hover]));
    const g = this.snapOverlay.getObjectByName('draft') as THREE.Line | undefined;
    if (g) {
      this.snapOverlay.remove(g);
      g.geometry.dispose();
    }
    const l = new (this.tool === 'polygon' ? THREE.Line : THREE.LineLoop)(new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, dr.y + 0.03, p.z))), new THREE.LineBasicMaterial({ color: this.drawMode === 'add' ? '#e2702a' : '#c026d3', depthTest: false }));
    l.name = 'draft';
    l.renderOrder = 25;
    this.snapOverlay.add(l);
    this.view.mark();
  }

  /** Pontos do desenho em curso (retângulo no referencial do edifício). */
  private shapePoints(pts: THREE.Vector3[]): THREE.Vector3[] {
    if (this.tool === 'polygon') return pts;
    const a = pts[0]!,
      b = pts[pts.length - 1]!;
    if (this.tool === 'circle') {
      const r = a.distanceTo(b);
      return Array.from({ length: 48 }, (_, i) => new THREE.Vector3(a.x + Math.cos((i / 48) * Math.PI * 2) * r, a.y, a.z + Math.sin((i / 48) * Math.PI * 2) * r));
    }
    const [ax, az] = this.infer.axes();
    const d = b.clone().sub(a);
    const u = d.dot(ax!),
      v = d.dot(az!);
    return [a.clone(), a.clone().addScaledVector(ax!, u), a.clone().addScaledVector(ax!, u).addScaledVector(az!, v), a.clone().addScaledVector(az!, v)];
  }

  private finishPolygon(): void {
    const dr = this.draft;
    if (!dr || dr.points.length < 3) return;
    this.finishShape();
  }

  private finishShape(): void {
    const dr = this.draft!;
    this.draft = null;
    const g = this.snapOverlay.getObjectByName('draft');
    if (g) this.snapOverlay.remove(g);
    this.shell.dim.hidden = true;
    this.clearSnap();
    let world = this.shapePoints(dr.points);
    if (this.tool === 'circle') world = [dr.points[0]!, dr.points[1]!];
    const a = world[0]!;
    if (this.tool !== 'circle' && polyArea(world) < 0.5) return;
    if (this.tool === 'circle' && a.distanceTo(world[1]!) < 0.3) return;
    const isRectTool = this.tool === 'rect';
    let b = this.store.building(dr.bid);
    let created = false;
    if (!b) {
      if (this.drawMode === 'subtract') return this.toast('Para recortar, desenhe sobre um edifício (ou dentro dele em edição).');
      b = newBuilding({ name: `Edifício ${this.project.buildings.length + 1}`, position: [a.x, a.z], levels: levelsFor(1) });
      this.store.project.buildings.push(b);
      created = true;
    }
    const local = world.map((p) => toLocal(b!, [p.x, p.z]));
    let plan;
    if (this.tool === 'circle') {
      const r = Math.hypot(local[1]![0] - local[0]![0], local[1]![1] - local[0]![1]);
      plan = circlePlan(r, local[0]![0], local[0]![1]);
    } else plan = planVertices(local);
    const sub = this.drawMode === 'subtract';
    const levelH = b.levels[0]?.height ?? 3;
    const top = topAt(b, local[0]!);
    const base = dr.y > 0.01 ? dr.y : sub ? Math.max(0, top - levelH) : 0;
    const s = newSolid({ name: sub ? 'Recorte' : `Volume ${b.solids.length + 1}`, op: sub ? 'subtract' : 'add', plan: { outer: plan, holes: [] }, base: sub && dr.y > 0.01 ? dr.y - levelH : base, height: sub ? levelH + 0.5 : levelH, roof: roofSpec('flat', { parapet: sub ? 0 : 0.6 }) });
    if (sub && dr.y > 0.01) s.height = levelH;
    b.solids.push(s);
    // Níveis acompanham a altura do primeiro volume.
    this.store.commit([b.id], created ? 'Volume criado.' : 'Volume acrescentado.');
    if (created || this.context !== b.id) this.context = b.id;
    this.select({ building: b.id, solids: [s.id], face: { kind: 'top' } });
    this.toast(sub ? 'Recorte criado. Puxe a seta verde para a altura.' : isRectTool ? 'Volume criado. Digite 10x8 (largura × profundidade) ou 6 (altura) e Enter; ou puxe a seta verde.' : 'Volume criado. Puxe a seta verde ou digite a altura e Enter.');
    const bid = b.id,
      sid = s.id;
    const isRect = isRectTool;
    this.setMeasure(isRect ? 'Dimensões' : 'Altura', (t) => {
      // Largura × profundidade: 10x8, 10;8, 10*8 ou 10 8 (a vírgula é decimal).
      const m = /^\s*([\d.,]+)\s*(?:[;x×*/]|\s)\s*([\d.,]+)\s*$/i.exec(t);
      if (isRect && m) {
        const w = parseLength(m[1]!),
          dd = parseLength(m[2]!);
        if (!w || !dd) return false;
        return this.change(bid, (x) => {
          const so = findSolid(x, sid)!;
          const p0 = so.plan.outer[0]!.p;
          const p1 = so.plan.outer[1]!.p,
            p3 = so.plan.outer[3]!.p;
          const ux = [p1[0] - p0[0], p1[1] - p0[1]],
            uz = [p3[0] - p0[0], p3[1] - p0[1]];
          const lu = Math.hypot(ux[0]!, ux[1]!) || 1,
            lz = Math.hypot(uz[0]!, uz[1]!) || 1;
          const U: Vec2 = [(ux[0]! / lu) * w, (ux[1]! / lu) * w],
            V: Vec2 = [(uz[0]! / lz) * dd, (uz[1]! / lz) * dd];
          so.plan.outer[1]!.p = [p0[0] + U[0], p0[1] + U[1]];
          so.plan.outer[2]!.p = [p0[0] + U[0] + V[0], p0[1] + U[1] + V[1]];
          so.plan.outer[3]!.p = [p0[0] + V[0], p0[1] + V[1]];
        }, `${fmt(w)} × ${fmt(dd)} m.`);
      }
      const v = parseLength(t);
      if (v === null || v <= 0) return false;
      return this.change(bid, (x) => void (findSolid(x, sid)!.height = v), `Altura ${fmt(v)} m.`);
    });
    this.setTool('select');
    this.context = bid;
    this.select({ building: bid, solids: [sid], face: { kind: 'top' } });
  }

  // ── Componentes ──────────────────────────────────────────────────────
  // ── Blocos de massa ──────────────────────────────────────────────────
  startBlock(id: string): void {
    this.setTool('block');
    this.blockId = id;
    const def = BLOCKS.find((b) => b.id === id);
    this.updateHint(def ? `${def.name}: no chão cria um edifício; sobre um telhado empilha; numa parede encosta alinhado. X alterna somar/recortar. Esc termina.` : undefined);
    this.emit();
  }

  /** Onde o bloco cairia: chão, topo (empilha) ou face (encosta alinhado). */
  private blockPlacement(e: { clientX: number; clientY: number }): { b: Building3 | null; at: BlockPlacement; label: string } | null {
    const def = BLOCKS.find((x) => x.id === this.blockId);
    if (!def) return null;
    const hit = this.pickAt(e);
    const op: Solid['op'] = this.drawMode === 'subtract' ? 'subtract' : 'add';
    const lvOf = (b: Building3) => [...b.levels].sort((p, q) => p.elevation - q.elevation)[1]?.height ?? b.levels[0]?.height ?? 3;
    if (hit?.face && hit.building) {
      const b = hit.building;
      const lvH = lvOf(b);
      const s = findSolid(b, hit.face.solid);
      const local = hit.point.clone().applyMatrix4(this.view.buildingMatrix(b).invert());
      if ((hit.face.kind === 'top' || hit.face.kind === 'parapet' || hit.face.kind === 'coping' || hit.face.kind === 'roof') && s && hit.normal.y > 0.5) {
        const p = this.snapLocal([local.x, local.z]);
        const top = s.base + s.height;
        return { b, at: { origin: [p[0], p[1] - def.d / 2], ux: [1, 0], uz: [0, 1], base: op === 'add' ? top : top - def.levels * lvH, levelHeight: lvH, op }, label: op === 'add' ? 'Empilhar sobre o volume' : 'Recortar de cima' };
      }
      if (hit.face.kind === 'side' && hit.face.frame && s) {
        const fr = hit.face.frame;
        // Costas do bloco no plano da face, largura ao longo dela (encaixe perfeito).
        let along = fr.s0 + (local.x - fr.o[0]) * fr.u[0] + (local.z - fr.o[2]) * fr.u[2];
        if (this.infer.enabled) along = Math.round(along / 0.5) * 0.5;
        const ds = along - fr.s0;
        const ox = fr.o[0] + fr.u[0] * ds,
          oz = fr.o[2] + fr.u[2] * ds;
        const nl = Math.hypot(fr.n[0], fr.n[2]) || 1;
        const n: Vec2 = [fr.n[0] / nl, fr.n[2] / nl];
        const inward = op === 'subtract';
        // Somar: cresce para fora (ala, varanda fechada). Recortar: entra na parede (arco, nicho).
        const uz: Vec2 = inward ? [-n[0], -n[1]] : n;
        const ux: Vec2 = inward ? [fr.u[0], fr.u[2]] : [-fr.u[0], -fr.u[2]];
        const origin: Vec2 = inward ? [ox + n[0] * 0.3, oz + n[1] * 0.3] : [ox, oz];
        const lv = [...b.levels].sort((p, q) => p.elevation - q.elevation).filter((l) => l.elevation <= local.y + 0.01).pop();
        const base = def.id === 'arch' ? s.base - 0.3 : (lv?.elevation ?? s.base);
        return { b, at: { origin, ux, uz, base, levelHeight: lvH, op, attached: true, ...(def.id === 'arch' ? { d: 2.5 } : {}) }, label: inward ? 'Recortar na parede' : 'Encostar na parede' };
      }
    }
    const b = this.store.building(this.context) ?? null;
    const sn = this.infer.snap(e, 0, null, null);
    if (!sn) return null;
    const p: Vec2 = b ? toLocal(b, [sn.p.x, sn.p.z]) : [sn.p.x, sn.p.z];
    return { b, at: { origin: [p[0], p[1] - def.d / 2], ux: [1, 0], uz: [0, 1], base: 0, levelHeight: b ? lvOf(b) : 3, op }, label: b ? 'No chão do edifício' : 'Novo edifício' };
  }

  private snapLocal(p: Vec2): Vec2 {
    if (!this.infer.enabled) return p;
    const g = this.infer.grid || 0.5;
    return [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g];
  }

  private blockAt(e: PointerEvent, commit: boolean): void {
    const def = BLOCKS.find((x) => x.id === this.blockId);
    const pl = this.blockPlacement(e);
    const old = this.snapOverlay.getObjectByName('block') as THREE.LineSegments | undefined;
    if (old) {
      this.snapOverlay.remove(old);
      old.geometry.dispose();
    }
    if (!def || !pl) return this.view.mark();
    const s = blockSolid(def, pl.at);
    if (!commit) {
      const r = solidRings(s);
      const M = pl.b ? this.view.buildingMatrix(pl.b) : new THREE.Matrix4();
      const W = (p: Vec2, y: number) => new THREE.Vector3(p[0], y, p[1]).applyMatrix4(M);
      const pos: number[] = [];
      const n = r.outer.pts.length;
      for (let i = 0; i < n; i++) {
        const a = r.outer.pts[i]!,
          c = r.outer.pts[(i + 1) % n]!;
        pos.push(...W(a, r.base).toArray(), ...W(c, r.base).toArray());
        pos.push(...W(r.topOuter[i]!, r.top).toArray(), ...W(r.topOuter[(i + 1) % n]!, r.top).toArray());
        if (!r.outer.segs[i]!.curved || i % 4 === 0) pos.push(...W(a, r.base).toArray(), ...W(r.topOuter[i]!, r.top).toArray());
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: pl.at.op === 'add' ? '#e2702a' : '#c026d3', depthTest: false }));
      ls.name = 'block';
      ls.renderOrder = 25;
      this.snapOverlay.add(ls);
      this.showDim(`${pl.label} · ${fmt(def.w)} × ${fmt(pl.at.d ?? def.d)} m`, e);
      this.view.mark();
      return;
    }
    let b = pl.b;
    if (!b) {
      if (pl.at.op === 'subtract') return this.toast('Para recortar, solte o bloco sobre um edifício.');
      b = newBuilding({ name: `Edifício ${this.project.buildings.length + 1}`, position: [pl.at.origin[0], pl.at.origin[1] + def.d / 2], levels: levelsFor(Math.max(1, def.levels)) });
      const s0 = blockSolid(def, { ...pl.at, origin: [0, -def.d / 2] });
      b.solids.push(s0);
      this.store.project.buildings.push(b);
      this.store.commit([b.id], `${def.name} criado.`);
      this.context = b.id;
      this.select({ building: b.id, solids: [s0.id] });
      this.toast(`${def.name} criado. Clique de novo para mais um; Esc termina.`);
      return;
    }
    this.change(b.id, (x) => {
      x.solids.push(s);
      // Mais pavimentos quando o bloco sobe além dos níveis do edifício.
      const top = s.base + s.height;
      const lv = [...x.levels].sort((p, q) => p.elevation - q.elevation);
      const last = lv[lv.length - 1];
      const typ = lv[1]?.height ?? last?.height ?? 3;
      if (s.op === 'add' && last && top > last.elevation + last.height + 0.3) x.levels = levelsFor(Math.round((top - (lv[0]?.height ?? typ)) / typ) + 1, typ, lv[0]?.height ?? typ);
    }, `${def.name} ${s.op === 'add' ? 'acrescentado' : 'recortado'}.`);
    this.context = b.id;
    this.select({ building: b.id, solids: [s.id] });
  }

  // ── Trena e cotas ────────────────────────────────────────────────────
  private tapeFrom: THREE.Vector3 | null = null;
  /** Cotas fixadas no modelo (desta sessão). */
  dims: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];

  private tapePoint(e: { clientX: number; clientY: number }): THREE.Vector3 | null {
    const hit = this.pickAt(e);
    if (hit) {
      // Encaixa em vértices próximos no plano do ponto atingido.
      const sn = this.infer.snap(e, hit.point.y, this.tapeFrom, null, 10);
      if (sn && sn.kind !== 'grid' && sn.kind !== 'free') return sn.p;
      return hit.point;
    }
    return this.infer.snap(e, this.tapeFrom?.y ?? 0, this.tapeFrom, null)?.p ?? null;
  }

  private tapeAt(e: PointerEvent, commit: boolean): void {
    const p = this.tapePoint(e);
    const old = this.snapOverlay.getObjectByName('tape') as THREE.Line | undefined;
    if (old) {
      this.snapOverlay.remove(old);
      old.geometry.dispose();
    }
    if (!p) return;
    if (commit) {
      if (!this.tapeFrom) {
        this.tapeFrom = p.clone();
        return;
      }
      this.dims.push({ a: this.tapeFrom.clone(), b: p.clone() });
      this.toast(`Cota: ${fmt(this.tapeFrom.distanceTo(p))} m. Ela fica no modelo; Shift+Delete apaga as cotas.`);
      this.tapeFrom = null;
      this.drawDims();
      return;
    }
    if (!this.tapeFrom) {
      this.showDim('Clique o primeiro ponto', e);
      return;
    }
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.tapeFrom, p]), new THREE.LineBasicMaterial({ color: '#1f2326', depthTest: false }));
    l.name = 'tape';
    l.renderOrder = 26;
    this.snapOverlay.add(l);
    const d = p.clone().sub(this.tapeFrom);
    this.showDim(`${fmt(d.length())} m  (Δx ${fmt(Math.abs(d.x))} · Δz ${fmt(Math.abs(d.z))} · Δy ${fmt(Math.abs(d.y))})`, e);
    this.view.mark();
  }

  /** Desenha as cotas fixadas (linhas com marcas e rótulos). */
  drawDims(): void {
    const old = this.snapOverlay.getObjectByName('dims') as THREE.LineSegments | undefined;
    if (old) {
      this.snapOverlay.remove(old);
      old.geometry.dispose();
    }
    this.shell.view.querySelectorAll('.f3-dimlbl').forEach((x) => x.remove());
    if (!this.dims.length) return this.view.mark();
    const pos: number[] = [];
    for (const d of this.dims) pos.push(...d.a.toArray(), ...d.b.toArray());
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#1f2326', depthTest: false }));
    ls.name = 'dims';
    ls.renderOrder = 26;
    this.snapOverlay.add(ls);
    for (const d of this.dims) {
      const m = d.a.clone().add(d.b).multiplyScalar(0.5);
      const sp = this.view.toScreen(m);
      if (sp.behind) continue;
      const el = document.createElement('div');
      el.className = 'f3-dim f3-dimlbl';
      el.textContent = `${fmt(d.a.distanceTo(d.b))} m`;
      el.style.left = `${sp.x}px`;
      el.style.top = `${sp.y}px`;
      this.shell.view.appendChild(el);
    }
    this.view.mark();
  }

  private placeHover(e: PointerEvent): void {
    const pl = this.placementAt(e);
    if (!pl) {
      this.removeGhost();
      return;
    }
    const key = JSON.stringify([this.placing, pl.frame]);
    if (this.ghost?.key === key) return;
    this.removeGhost();
    const t = typeById(this.placing!, this.project)!;
    const f = family(t.family)!;
    const params = resolveParams(f, t.params);
    const parts = emptyParts3();
    f.build(params, new FrameSink(parts, pl.frame, 0), { length: f.size(params)[0], reveal: 0.3, index: 0 });
    parts.tags.push({ family: f.id });
    const mesh = buildPartsMesh(parts, this.view.ctx, false);
    mesh.group.applyMatrix4(this.view.buildingMatrix(pl.b));
    mesh.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material) m.renderOrder = 5;
    });
    this.view.overlay.add(mesh.group);
    this.ghost = { mesh, key };
    this.showDim(pl.label, e);
    this.view.mark();
  }

  private removeGhost(): void {
    if (!this.ghost) return;
    this.ghost.mesh.group.removeFromParent();
    this.ghost.mesh.dispose();
    this.ghost = null;
    this.view.mark();
  }

  /** Onde o componente cairia sob o ponteiro (face, chão ou telhado). */
  private placementAt(e: { clientX: number; clientY: number }): { b: Building3; host: Item['host']; frame: number[]; label: string } | null {
    if (!this.placing) return null;
    const t = typeById(this.placing, this.project);
    const f = t && family(t.family);
    if (!t || !f) return null;
    const params = resolveParams(f, t.params);
    const hit = this.pickAt(e);
    if (f.host === 'face') {
      if (!hit?.face || hit.face.kind !== 'side' || !hit.face.frame) return null;
      const b = hit.building;
      const fr = hit.face.frame;
      const local = hit.point.clone().applyMatrix4(this.view.buildingMatrix(b).invert());
      let s = fr.s0 + (local.x - fr.o[0]) * fr.u[0] + (local.y - fr.o[1]) * fr.u[1] + (local.z - fr.o[2]) * fr.u[2];
      const solid = findSolid(b, hit.face.solid)!;
      // Peitoril pelo nível sob o ponteiro.
      const yAbs = local.y;
      const lv = [...b.levels].sort((x, y) => x.elevation - y.elevation).filter((l) => l.elevation <= yAbs + 0.01).pop();
      const sill = f.sill?.(params) ?? 0.9;
      let y = (lv ? lv.elevation : solid.base) + sill - solid.base;
      if (e && 'altKey' in e && (e as PointerEvent).altKey) y = (local.x - fr.o[0]) * fr.v[0] + (local.y - fr.o[1]) * fr.v[1] + (local.z - fr.o[2]) * fr.v[2] - f.size(params)[1] / 2;
      if (this.infer.enabled) s = Math.round(s / 0.1) * 0.1;
      const ds = s - fr.s0;
      const p: Vec3 = [fr.o[0] + fr.u[0] * ds + fr.v[0] * y, fr.o[1] + fr.u[1] * ds + fr.v[1] * y, fr.o[2] + fr.u[2] * ds + fr.v[2] * y];
      return { b, host: { kind: 'face', solid: solid.id, edge: hit.face.edge!, u: s, y }, frame: frameMatrix(p, fr.u, fr.v, fr.n), label: `${fmt(s)} m ao longo · ${fmt(y + solid.base)} m de altura` };
    }
    if (f.host === 'roof' && hit?.face && (hit.face.kind === 'roof' || hit.face.kind === 'top')) {
      const b = hit.building;
      const local = hit.point.clone().applyMatrix4(this.view.buildingMatrix(b).invert());
      return { b, host: { kind: 'roof', solid: hit.face.solid, p: [local.x, local.z], rot: 0 }, frame: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, local.x, local.y, local.z, 1], label: 'Sobre o telhado' };
    }
    // Livre: no chão (ou no topo plano sob o ponteiro).
    const b = hit?.building ?? this.store.building(this.context) ?? this.project.buildings[0];
    const y = hit?.face && hit.normal.y > 0.9 ? hit.point.y : 0;
    const sn = this.infer.snap(e, y, null, null);
    if (!sn) return null;
    if (!b) return null;
    const l = toLocal(b, [sn.p.x, sn.p.z]);
    return { b, host: { kind: 'free', p: [l[0], y, l[1]], rot: 0 }, frame: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, l[0], y, l[1], 1], label: `${fmt(l[0])}; ${fmt(l[1])}` };
  }

  private pathDraft: { b: ID; pts: Vec3[] } | null = null;

  placeAt(e: PointerEvent): void {
    if (!this.placing) return;
    const t = typeById(this.placing, this.project);
    const f = t && family(t.family);
    if (!t || !f) return;
    if (f.host === 'path') {
      const b = this.store.building(this.context) ?? this.pickAt(e)?.building ?? this.project.buildings[0];
      if (!b) return this.toast('Crie um edifício antes (ou entre em um).');
      const sn = this.infer.snap(e, 0, null, null);
      if (!sn) return;
      const l = toLocal(b, [sn.p.x, sn.p.z]);
      if (!this.pathDraft || this.pathDraft.b !== b.id) this.pathDraft = { b: b.id, pts: [] };
      this.pathDraft.pts.push([l[0], 0, l[1]]);
      this.toast(`${this.pathDraft.pts.length} ponto(s). Enter termina.`);
      return;
    }
    const pl = this.placementAt(e);
    if (!pl) return this.toast(f.host === 'face' ? 'Aponte para uma parede.' : 'Aponte para o chão ou um telhado.');
    const it: Item = { id: uid(), type: t.id, params: {}, host: pl.host };
    this.removeGhost();
    this.shell.dim.hidden = true;
    this.change(pl.b.id, (b) => void b.items.push(it), `${t.name} colocado. Clique de novo para mais um; Esc termina.`);
    this.context = pl.b.id;
    this.select({ building: pl.b.id, item: it.id });
    this.lastItem = it.id;
    this.setMeasure('Cópias', (txt) => {
      const m = /^(\d+)\s*x$/i.exec(txt.trim());
      if (!m) return false;
      const n = parseInt(m[1]!, 10);
      return this.change(pl.b.id, (b) => {
        const x = b.items.find((q) => q.id === it.id);
        if (x) x.array = { along: { mode: 'spacing', value: (f.size(resolveParams(f, t.params))[0] ?? 1) + 1, count: n } };
      }, `${n} cópias em linha.`);
    });
  }

  private lastItem: ID | null = null;

  finishPath(): void {
    const pd = this.pathDraft;
    this.pathDraft = null;
    if (!pd || pd.pts.length < 2 || !this.placing) return;
    const t = typeById(this.placing, this.project)!;
    const it: Item = { id: uid(), type: t.id, params: {}, host: { kind: 'path', points: pd.pts } };
    this.change(pd.b, (b) => void b.items.push(it), `${t.name} criado.`);
    this.select({ building: pd.b, item: it.id });
  }

  // ── Pintura ──────────────────────────────────────────────────────────
  private paintAt(e: PointerEvent): void {
    const hit = this.pickAt(e);
    if (!hit?.face) return;
    const b = hit.building;
    const f = hit.face;
    const s = findSolid(b, f.solid);
    if (!s) return;
    if (e.altKey) {
      const ref = f.kind === 'roof' ? s.materials.roof : f.kind === 'side' && f.edge ? (s.edges[f.edge]?.material ?? s.materials.wall) : s.materials.wall;
      this.paintMat = { ...ref };
      this.toast(`Material copiado: ${ref.finish}.`);
      this.emit();
      return;
    }
    this.change(b.id, (x) => {
      const so = findSolid(x, s.id)!;
      const m = { ...this.paintMat };
      if (f.kind === 'roof' || f.kind === 'top') so.materials.roof = m;
      else if (f.kind === 'fascia' || f.kind === 'soffit') so.materials.trim = m;
      else if (f.kind === 'side' && f.edge && e.shiftKey) (so.edges[f.edge] ??= {}).material = m;
      else so.materials.wall = m;
    }, 'Pintado.');
  }

  // ── Inferência na tela ───────────────────────────────────────────────
  private showSnap(s: Snap, e: { clientX: number; clientY: number }): void {
    this.lastSnap = s;
    this.clearSnap(false);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: s.color, depthTest: false }));
    dot.position.copy(s.p);
    dot.scale.setScalar(this.view.worldPerPixel(s.p) * 5);
    dot.renderOrder = 40;
    dot.name = 'snap';
    this.snapOverlay.add(dot);
    if (s.line) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(s.line), new THREE.LineDashedMaterial({ color: s.color, dashSize: 0.4, gapSize: 0.25, depthTest: false }));
      l.computeLineDistances();
      l.renderOrder = 39;
      l.name = 'snapline';
      this.snapOverlay.add(l);
    }
    const tip = this.shell.snap;
    tip.hidden = !s.label;
    tip.textContent = s.label;
    tip.style.background = s.color;
    const r = this.shell.view.getBoundingClientRect();
    tip.style.left = `${e.clientX - r.left}px`;
    tip.style.top = `${e.clientY - r.top}px`;
    this.view.mark();
  }

  private clearSnap(hideTip = true): void {
    for (const n of ['snap', 'snapline']) {
      const o = this.snapOverlay.getObjectByName(n) as THREE.Mesh | undefined;
      if (o) {
        this.snapOverlay.remove(o);
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    }
    if (hideTip) this.shell.snap.hidden = true;
    this.view.mark();
  }

  private showDim(text: string, e: { clientX: number; clientY: number }): void {
    const d = this.shell.dim;
    const r = this.shell.view.getBoundingClientRect();
    d.hidden = false;
    d.textContent = text;
    d.style.left = `${e.clientX - r.left}px`;
    d.style.top = `${e.clientY - r.top - 28}px`;
  }

  // ── Teclado ──────────────────────────────────────────────────────────
  private bindKeys(): void {
    const vcb = this.shell.status.vcb;
    vcb.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const ok = this.measure?.apply(vcb.value) ?? false;
        if (!ok) this.toast('Valor não reconhecido para ' + (this.measure?.label ?? 'medidas') + '.');
        vcb.value = '';
        this.view.renderer.domElement.focus();
        e.preventDefault();
      } else if (e.key === 'Escape') {
        vcb.value = '';
        this.view.renderer.domElement.focus();
      }
      e.stopPropagation();
    });
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('input,select,textarea') || !this.shell.root.isConnected) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z') this.command(e.shiftKey ? 'redo' : 'undo');
        else if (k === 'y') this.command('redo');
        else if (k === 'd') this.duplicate();
        else if (k === 'c') this.copy();
        else if (k === 'v') this.paste();
        else if (k === 's') this.saveRequested?.();
        else return;
        e.preventDefault();
        return;
      }
      // Números e separadores vão para a caixa de medidas.
      if (/^[0-9.,;*/-]$/.test(e.key) && this.measure) {
        vcb.focus();
        return;
      }
      if (this.sel.elems.length && (k === 'arrowleft' || k === 'arrowright' || k === 'arrowup' || k === 'arrowdown')) {
        this.selectElems(k.slice(5) as 'left');
        e.preventDefault();
        return;
      }
      if (k === 'escape') {
        if (this.tool !== 'select') {
          this.pathDraft = null;
          this.setTool('select');
        } else this.exitContext();
      }
      else if (k === 'delete' && e.shiftKey) {
        this.dims = [];
        this.drawDims();
        this.toast('Cotas apagadas.');
      } else if (k === 'delete' || k === 'backspace') {
        if (this.draft && this.tool === 'polygon' && this.draft.points.length > 1) this.draft.points.pop();
        else if (k === 'delete') this.remove();
      } else if (k === 'enter') {
        if (this.tool === 'polygon') this.finishPolygon();
        else if (this.pathDraft) this.finishPath();
      } else if (k === 'v') this.setTool('select');
      else if (k === 'p') this.setTool('push');
      else if (k === 'r') this.setTool('rect');
      else if (k === 'c') this.setTool('circle');
      else if (k === 'l') this.setTool('polygon');
      else if (k === 'b') this.setTool('paint');
      else if (k === 't') this.setTool('tape');
      else if (k === 'x') this.toggleDrawMode();
      else if (k === 'k') this.emitCatalog();
      else if (k === 'f') this.frameSelection();
      else if (k === 'g') this.toggleSnap();
      else if (k === '?') this.helpRequested?.();
      else return;
      e.preventDefault();
    });
  }

  saveRequested: (() => void) | null = null;
  helpRequested: (() => void) | null = null;

  private bindTop(): void {
    this.shell.top.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => b.addEventListener('click', () => this.topCommand?.(b.dataset.cmd!) ?? this.command(b.dataset.cmd!)));
    this.shell.name.addEventListener('change', () => {
      this.store.project.name = this.shell.name.value.trim() || 'Projeto sem título';
      this.store.commit(null, '', false);
    });
  }

  topCommand: ((cmd: string) => boolean) | null = null;

  /** Edita uma ocorrência: valores só desta (instância) ou do tipo (todas). */
  setItemParam(key: string, value: unknown, scope: 'instance' | 'type'): void {
    const b = this.activeBuilding(),
      it = this.activeItem();
    if (!b || !it) return;
    if (scope === 'instance') {
      this.change(b.id, (x) => {
        const y = x.items.find((q) => q.id === it.id)!;
        y.params[key] = value as never;
      });
      return;
    }
    this.editType(it.type, key, value);
  }

  /** Muda um valor do tipo: todas as ocorrências e regras que usam o tipo mudam. */
  editType(typeId: ID, key: string, value: unknown): void {
    const p = this.store.project;
    let t = p.types.find((x) => x.id === typeId);
    if (!t) {
      const base = typeById(typeId, p);
      if (!base) return;
      // Tipo incluído: vira uma cópia do projeto com o mesmo ID (todas as ocorrências seguem).
      t = { ...structuredClone(base), user: true };
      p.types.push(t);
    }
    t.params[key] = value as never;
    this.store.commit(null, 'Tipo alterado (todas as ocorrências).');
  }

  /** Cria um tipo novo a partir da ocorrência (Tornar único). */
  makeUnique(): void {
    const b = this.activeBuilding(),
      it = this.activeItem();
    if (!b || !it) return;
    const base = typeById(it.type, this.project);
    if (!base) return;
    const n = { id: uid(), family: base.family, name: base.name + ' (único)', params: { ...structuredClone(base.params), ...structuredClone(it.params) }, user: true };
    this.store.project.types.push(n);
    this.change(b.id, (x) => {
      const y = x.items.find((q) => q.id === it.id)!;
      y.type = n.id;
      y.params = {};
    }, 'Agora esta ocorrência tem um tipo próprio.');
  }

  dispose(): void {
    this.view.dispose();
    this.shell.root.remove();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Ponto do meio de um lado (arcos: meio do arco). */
function midOf(v: { p: Vec2; bulge?: number }, n: { p: Vec2 }, chord = false): Vec2 {
  const m: Vec2 = [(v.p[0] + n.p[0]) / 2, (v.p[1] + n.p[1]) / 2];
  if (chord || !v.bulge) return m;
  const dx = n.p[0] - v.p[0],
    dz = n.p[1] - v.p[1];
  const c = Math.hypot(dx, dz) || 1;
  const sag = (v.bulge * c) / 2;
  // Direita do sentido de v → n.
  return [m[0] + (dz / c) * sag, m[1] - (dx / c) * sag];
}

function ringCenter(r: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const p of r) c.add(p);
  return c.divideScalar(r.length);
}

function polyArea(pts: THREE.Vector3[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!,
      b = pts[(i + 1) % pts.length]!;
    s += a.x * b.z - b.x * a.z;
  }
  return Math.abs(s / 2);
}

function screenDist(view: View, a: THREE.Vector3, b: THREE.Vector3): number {
  const p = view.toScreen(a),
    q = view.toScreen(b);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

export { splitEdge, removeVertex };
