// Editor do FORMA 3: liga documento, vista, alças, inferência e interface.
// Seleção em dois níveis (como grupos do SketchUp): fora de um edifício, o
// clique pega o edifício inteiro; dentro dele (duplo clique), pega volume,
// face ou componente. Arrastos partem de uma cópia do estado inicial e só
// gravam no histórico ao soltar.
import * as THREE from 'three';
import type { Building3, ID, Item, MaterialRef, Project3, Solid, Vec2, Vec3 } from '../model/schema';
import { building as newBuilding, circlePlan, levelsFor, planVertices, project as newProject, roofSpec, solid as newSolid, uid } from '../model/defaults';
import { bendEdge, cloneBuilding, cloneSolid, dirToLocal, edgeNormal, findSolid, mirrorSolid, moveVertex, planCenter, planValid as planValidOps, pushEdge, removeVertex, rotateSolid, splitEdge, toLocal, topRing, toWorld, topAt, translateSolid } from '../model/ops';
import { solidRings } from '../eval/body';
import { edgeLength, extrudeSide, insetSide, insetTop, offsetCopy, offsetSolid, setSolidSize, splitAtHeight } from '../model/modeling';
import { activeLayer, buildingHidden, buildingLocked, itemHidden, itemLocked, solidHidden, solidLocked } from '../model/layers';
import { boxPicks, combine, marqueeRect, selMode } from './selection';
import { Store } from './store';
import { alignBuildings, alignSolids, type AlignOp } from '../model/align';
import { BLOCKS, blockSolid, type BlockPlacement } from '../model/blocks';
import { View, type Hit } from './view';
import { Handles, HANDLE_COLORS, type Handle } from './handles';
import { Inference, SNAP_COLORS, type Snap } from './infer';
import { createShell3, type Shell3 } from '../ui/shell';
import { icon } from '../ui/icons';
import { closeOnOutside } from '../ui/kit';
import { family, typeById } from '../families/index';
import { CATEGORY_NAMES, resolveParams } from '../families/family';
import { emptyParts3, faceMatrix, FrameSink } from '../eval/parts';
import { buildPartsMesh, type PartsMesh } from '../render/parts';
import type { FaceInfo } from '../eval/faces';
import { between, column, elemKey, elementsOf, groupElements, grow, row, rowOnFace, sameFace, sameType, shift, shrink, type Elem, type GroupRow } from './elements';

export type Tool = 'select' | 'push' | 'rect' | 'circle' | 'polygon' | 'place' | 'paint' | 'block' | 'tape';

export interface Selection {
  building: ID | null;
  solids: ID[];
  /** Face selecionada do primeiro sólido: lado (edge) ou topo. */
  face: { kind: 'side' | 'top'; edge?: ID } | null;
  item: ID | null;
  /** Elementos de fachada selecionados (chaves de elements.ts). */
  elems: string[];
  /** Outros edifícios selecionados junto (Shift+clique). */
  others: ID[];
  /** Canto (vértice da planta) selecionado no primeiro sólido. */
  vertex?: ID | null;
}

/** Modificadores de um gesto (clique ou caixa). */
type Mods = { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean };

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
  sel: Selection = { building: null, solids: [], face: null, item: null, elems: [], others: [] };
  context: ID | null = null;
  /** Tipo de componente sendo posicionado. */
  placing: ID | null = null;
  /** Bloco de massa sendo posicionado. */
  blockId: string | null = null;
  paintMat: MaterialRef = { finish: 'brick', color: '#a8553a', color2: '#d8d2c6' };
  measure: Measure | null = null;
  warnings: string[] = [];
  private drag: Drag | null = null;
  /** Caixa de seleção em curso (de onde, até onde, modificadores do começo). */
  private marquee: { ax: number; ay: number; bx: number; by: number; active: boolean; hit: Hit | null; ev: Mods } | null = null;
  private marqueeEl: HTMLElement | null = null;
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
      this.drawSelDims();
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
    // Grade e giro (barra de estado).
    const gridSel = this.shell.root.querySelector<HTMLSelectElement>('[data-grid]')!;
    const rotSel = this.shell.root.querySelector<HTMLSelectElement>('[data-rot]')!;
    gridSel.addEventListener('change', () => {
      this.infer.grid = parseFloat(gridSel.value);
      this.view.setGrid(Math.max(0.5, this.infer.grid));
      this.toast(`Grade de ${gridSel.options[gridSel.selectedIndex]!.text}.`);
    });
    rotSel.addEventListener('change', () => {
      this.rotSnap = parseFloat(rotSel.value);
      this.toast(`Giro de ${this.rotSnap}° em ${this.rotSnap}°.`);
    });
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
    if (this.sel.building && !b) this.sel = { building: null, solids: [], face: null, item: null, elems: [], others: [] };
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
    const sv = this.shell.top.querySelector('.f3-saved');
    if (sv) sv.textContent = 'Salvando…';
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem('forma3_project', this.store.json());
        const sv = this.shell.top.querySelector('.f3-saved');
        if (sv) sv.textContent = 'Salvo neste navegador';
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
    const known = new Set([...b.solids.map((x) => x.id), ...b.items.map((x) => x.id)]);
    const r = fn(b);
    // O que nasceu nesta mudança vai para a camada ativa.
    const layer = activeLayer(this.project);
    if (layer && r !== false) for (const x of [...b.solids, ...b.items]) if (!known.has(x.id) && !x.layer) x.layer = layer;
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
    this.sel = { building: null, solids: [], face: null, item: null, elems: [], others: [], vertex: null, ...next };
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
    c.innerHTML = parts.join('<i>›</i>');
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
      this.drawSelDims();
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
    // Outros edifícios selecionados junto (Shift+clique): contorno da planta.
    for (const oid of this.sel.others) {
      const ob = this.store.building(oid);
      if (!ob) continue;
      const OM = this.view.buildingMatrix(ob);
      for (const s of ob.solids) if (s.op === 'add') line(solidRings(s).outer.pts.map((p) => new THREE.Vector3(p[0], s.base + 0.03, p[1]).applyMatrix4(OM)), '#2f7de1', true, 1);
    }
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
      const pos = this.elemBoxes(b, new Set(this.sel.elems));
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
      handles.push(...this.sizeHandles(b, b.solids.filter((x) => x.op === 'add'), Math.max(...b.solids.map((x) => x.base + x.height), 0)));
    } else if (this.sel.item) {
      const it = this.activeItem();
      if (it && (it.host.kind === 'free' || it.host.kind === 'roof')) {
        // Altura real da peça (no telhado, a da superfície onde ela está).
        const pl = built?.ev.placements.find((q) => q.tag.item === it.id);
        const y = pl ? pl.frame[13]! : it.host.kind === 'free' ? it.host.p[1] : 0;
        const p = it.host.kind === 'free' ? it.host.p : [it.host.p[0], y, it.host.p[1]];
        const c = W([p[0]!, p[2]!], y + 0.05);
        handles.push(...this.moveHandles(c, ax, az), this.rotateHandle(c, 2.5));
      }
      // Peça presa à face: alças de largura, altura e peitoril sobre ela.
      if (it && it.host.kind === 'face' && built) {
        const pl = built.ev.placements.find((q) => q.tag.item === it.id && (q.tag.key ?? '0') === '0');
        if (pl) {
          const F = new THREE.Matrix4().fromArray(pl.frame).premultiply(M);
          const [w, h] = pl.family.size(pl.params);
          const op = pl.opening;
          const ow = op?.w ?? w,
            oh = op?.h ?? h;
          const P = (x: number, y: number) => new THREE.Vector3(x, y, 0.15).applyMatrix4(F);
          const U = new THREE.Vector3(1, 0, 0).transformDirection(F),
            V = new THREE.Vector3(0, 1, 0).transformDirection(F);
          handles.push({ kind: 'cwidth', at: P(ow / 2, oh / 2), dir: U, color: '#e2702a', label: 'Largura (arraste; digite a medida)' });
          handles.push({ kind: 'cheight', at: P(0, oh), dir: V, color: '#e2702a', label: 'Altura' });
          handles.push({ kind: 'csill', at: P(0, 0), dir: V.clone().negate(), color: '#e2702a', label: 'Peitoril / posição vertical' });
        }
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
        handles.push(...this.sizeHandles(b, [s0], r.top));
      }
      if (!faceMode || this.sel.face?.kind === 'top') handles.push({ kind: 'height', at: top, dir: new THREE.Vector3(0, 1, 0), solid: s0.id, color: HANDLE_COLORS.y, label: 'Altura' });
      if (!faceMode && (s0.base > 0.01 || s0.op !== 'add')) handles.push({ kind: 'lift', at: base, dir: new THREE.Vector3(0, -1, 0), solid: s0.id, color: HANDLE_COLORS.y, label: 'Elevação' });
      // Vértices e meios dos lados (curvar), na base se afunilado, senão no topo.
      const yv = s0.taper > 0.01 ? r.base : r.top;
      for (const ring of [s0.plan.outer, ...s0.plan.holes])
        ring.forEach((v, i) => {
          const n = ring[(i + 1) % ring.length]!;
          handles.push({ kind: 'vertex', at: W(v.p, yv), solid: s0.id, vertex: v.id, color: v.id === this.sel.vertex ? HANDLE_COLORS.push : HANDLE_COLORS.vertex, label: 'Vértice' });
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
    this.drawSelDims();
  }

  /**
   * Alças de tamanho na caixa da planta (eixos do edifício), um pouco para
   * fora dela (não disputam o clique com os vértices): lados puxam um eixo,
   * cantos os dois; o lado oposto fica parado. Shift mantém a proporção.
   */
  private sizeHandles(b: Building3, solids: Solid[], y: number): Handle[] {
    if (!solids.length) return [];
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const s of solids)
      for (const v of s.plan.outer) {
        x0 = Math.min(x0, v.p[0]);
        x1 = Math.max(x1, v.p[0]);
        z0 = Math.min(z0, v.p[1]);
        z1 = Math.max(z1, v.p[1]);
      }
    const M = this.view.buildingMatrix(b);
    const mid = new THREE.Vector3((x0 + x1) / 2, y, (z0 + z1) / 2).applyMatrix4(M);
    const off = this.view.worldPerPixel(mid) * 16;
    const out: Handle[] = [];
    for (const sx of [-1, 0, 1])
      for (const sz of [-1, 0, 1]) {
        if (!sx && !sz) continue;
        const x = sx < 0 ? x0 - off : sx > 0 ? x1 + off : (x0 + x1) / 2;
        const z = sz < 0 ? z0 - off : sz > 0 ? z1 + off : (z0 + z1) / 2;
        out.push({ kind: 'size', at: new THREE.Vector3(x, y + 0.02, z).applyMatrix4(M), sx, sz, color: '#ffffff', label: sx && sz ? 'Tamanho (arraste o canto; Shift mantém a proporção; digite 12x8)' : sx ? 'Largura (arraste; digite a medida)' : 'Profundidade (arraste; digite a medida)' });
      }
    return out;
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
    let html: string;
    if (this.context !== b.id) html = btn('enter', 'enter', 'Editar', undefined, 'Editar o edifício (duplo clique)') + '<span class="sep"></span>' + btn('dup', 'copy', '', undefined, 'Duplicar · Ctrl+D') + btn('rot90', 'rotate', '', undefined, 'Girar 90°') + btn('del', 'trash', '', undefined, 'Excluir · Delete');
    else if (this.sel.item) html = btn('dup', 'copy', '', undefined, 'Duplicar · Ctrl+D') + btn('del', 'trash', '', undefined, 'Excluir · Delete');
    else if (s)
      html =
        btn('op-add', 'add', '', s.op === 'add', 'Somar ao edifício') +
        btn('op-subtract', 'subtract', '', s.op === 'subtract', 'Recortar o que veio antes (pátios, arcos, nichos)') +
        btn('op-intersect', 'intersect', '', s.op === 'intersect', 'Interseção: fica só a parte em comum') +
        '<span class="sep"></span>' +
        btn('dup', 'copy', '', undefined, 'Duplicar · Ctrl+D') +
        btn('mirror', 'mirror', '', undefined, 'Espelhar') +
        btn('del', 'trash', '', undefined, 'Excluir · Delete');
    else html = btn('exit', 'exit', 'Sair', undefined, 'Sair do edifício · Esc') + btn('dup', 'copy', '', undefined, 'Duplicar edifício');
    bar.innerHTML = html;
    // Fixa no alto da vista: nunca cobre o gizmo, as cotas nem o modelo.
    bar.hidden = false;
    bar.style.left = '50%';
    bar.style.top = '10px';
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
        if (b && this.context !== b.id && this.sel.others.length) this.rotateBuildings(90);
        else if (b) this.change(b.id, (x) => void (x.rotation = (x.rotation + 90) % 360), 'Girado 90°.', false);
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
      case 'snap':
        this.toggleSnap();
        break;
      case 'library':
        this.toggleLibrary();
        break;
      case 'palette':
        this.paletteRequested?.();
        break;
      case 'help':
        this.helpRequested?.();
        break;
    }
  }

  /** A busca de comandos (ui/palette.ts) escuta isto. */
  paletteRequested: (() => void) | null = null;

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
    // Todos os edifícios selecionados (o arranjo entre eles se mantém).
    const copies = this.selectedBuildings().flatMap((id) => {
      const src = this.store.building(id);
      if (!src) return [];
      const c = cloneBuilding(src);
      c.position = [src.position[0] + 4, src.position[1] + 4];
      c.name = src.name + ' (cópia)';
      this.store.project.buildings.push(c);
      return [c.id];
    });
    const msg = copies.length > 1 ? `${copies.length} edifícios duplicados.` : 'Edifício duplicado.';
    this.store.commit(copies, msg);
    this.toast(msg);
    this.selectBuildings(copies);
  }

  remove(): void {
    const b = this.activeBuilding();
    if (!b) return;
    if (this.context === b.id && this.sel.vertex) {
      const vid = this.sel.vertex;
      if (this.changeSolid((s) => removeVertex(s, vid), 'Vértice apagado.')) this.select({ building: b.id, solids: this.sel.solids });
      return;
    }
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
    const del = new Set(this.context === b.id ? [b.id] : this.selectedBuildings());
    this.store.project.buildings = this.store.project.buildings.filter((x) => !del.has(x.id));
    if (this.context && del.has(this.context)) this.context = null;
    const msg = del.size > 1 ? `${del.size} edifícios excluídos.` : 'Edifício excluído.';
    this.store.commit(null, msg);
    this.toast(`${msg} Ctrl+Z desfaz.`);
    this.select({});
  }

  /**
   * Ferramentas de modelagem sobre a seleção (painel, caixa de medidas):
   * extrudar e inset de face, offset, dividir, medidas, bisel, cantos.
   */
  modelOp(op: string, a: Record<string, number | string | boolean> = {}): boolean {
    const b = this.activeBuilding(),
      s = this.activeSolid();
    if (!b || !s) return false;
    const n = (k: string, d = 0) => (typeof a[k] === 'number' && Number.isFinite(a[k]) ? (a[k] as number) : d);
    let created: Solid | null = null;
    const edge = this.sel.face?.kind === 'side' ? this.sel.face.edge : undefined;
    const msgs: Record<string, string> = {
      extrude: n('depth') >= 0 ? 'Face extrudada (volume novo).' : 'Reentrância criada (recorte).',
      'inset-side': n('depth') >= 0 ? 'Saliência criada.' : 'Nicho criado (recorte).',
      'inset-top': n('depth') >= 0 ? 'Volume sobre o topo criado.' : 'Rebaixo criado (recorte).',
      offset: a.copy ? 'Cópia com offset criada.' : 'Contorno deslocado.',
      split: 'Volume dividido em dois.',
      size: 'Medidas aplicadas.',
      bevel: 'Bisel aplicado.',
      'edge-bevel': 'Bisel do lado aplicado.',
      corner: 'Canto ajustado.',
    };
    const layer = activeLayer(this.project);
    const run = (x: Building3): boolean => {
        const so = findSolid(x, s.id)!;
        switch (op) {
          case 'extrude':
            if (!edge) return false;
            created = extrudeSide(x, so, edge, n('depth'));
            return !!created;
          case 'inset-side':
            if (!edge) return false;
            created = insetSide(x, so, edge, n('margin', 1), n('depth', -1), !!a.keepBottom);
            return !!created;
          case 'inset-top':
            created = insetTop(x, so, n('inset'), n('depth'));
            return !!created;
          case 'offset': {
            const corner = (a.corner as 'sharp' | 'round' | 'chamfer' | undefined) ?? 'sharp';
            if (a.copy) {
              created = offsetCopy(x, so, n('d'), corner);
              return !!created;
            }
            return offsetSolid(so, n('d'), corner);
          }
          case 'split':
            created = splitAtHeight(x, so, n('y'));
            return !!created;
          case 'size':
            return setSolidSize(so, n('w'), n('d'));
          case 'bevel': {
            const cur = so.bevel ?? { top: 0, bottom: 0, segments: 1, profile: 0 };
            so.bevel = { top: Math.max(0, n('top', cur.top)), bottom: Math.max(0, n('bottom', cur.bottom)), segments: Math.max(1, Math.round(n('segments', cur.segments))), profile: Math.max(0, Math.min(1, n('profile', cur.profile))) };
            if (so.bevel.top <= 0 && so.bevel.bottom <= 0) delete so.bevel;
            return true;
          }
          case 'edge-bevel': {
            if (!edge) return false;
            // 0 também vale: tira o bisel só deste lado.
            (so.edges[edge] ??= {}).bevel = Math.max(0, n('w'));
            return true;
          }
          case 'corner': {
            const vid = this.sel.vertex;
            const v = vid ? [so.plan.outer, ...so.plan.holes].flat().find((q) => q.id === vid) : undefined;
            if (!v) return false;
            if ('round' in a) {
              if (n('round') > 0) v.round = n('round');
              else delete v.round;
            }
            if ('chamfer' in a) {
              if (n('chamfer') > 0) v.chamfer = n('chamfer');
              else delete v.chamfer;
            }
            return true;
          }
        }
        return false;
    };
    const ok = this.change(
      b.id,
      (x) => {
        const r = run(x);
        const c = created as Solid | null;
        if (r && c && layer && !c.layer) c.layer = layer;
        return r;
      },
      msgs[op] ?? '',
    );
    if (ok && created) this.select({ building: b.id, solids: [(created as Solid).id] });
    return ok;
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

  /** Passo do giro (graus) com encaixe ligado. */
  rotSnap = 15;

  // ── Alinhar e distribuir ─────────────────────────────────────────────
  /** Volumes (dentro de um edifício) ou edifícios (fora): o primeiro selecionado é a referência. */
  align(op: AlignOp): void {
    const b = this.activeBuilding();
    if (!b) return;
    const label: Record<AlignOp, string> = { left: 'à esquerda', centerX: 'ao centro (x)', right: 'à direita', front: 'à frente', centerZ: 'ao centro (z)', back: 'ao fundo', base: 'na mesma base', top: 'no mesmo topo', height: 'com o mesmo topo (altura)', distX: 'distribuídos em x', distZ: 'distribuídos em z' };
    if (this.context === b.id && this.sel.solids.length > 1) {
      this.change(b.id, (x) => alignSolids(this.sel.solids.map((id) => findSolid(x, id)!).filter(Boolean), op), `Volumes ${label[op]}.`);
      return;
    }
    if (this.sel.others.length) {
      const list = [b, ...this.sel.others.map((id) => this.store.building(id)!).filter(Boolean)];
      alignBuildings(list, op);
      this.store.commit(list.map((x) => x.id), `Edifícios ${label[op]}.`, false);
      this.toast(`Edifícios ${label[op]}.`);
    }
  }

  /** Cotas da seleção: cada lado do volume e a altura, sempre visíveis e sem encostar uma na outra. */
  private drawSelDims(): void {
    this.placeSelDims();
    this.declutterDims();
  }

  /**
   * Rotulagem gulosa: cada cota, na ordem, sai de perto das já colocadas
   * (folga de 6 px), descendo; se sair da vista, sobe. Uma passada basta para
   * as poucas cotas de uma seleção.
   */
  private declutterDims(): void {
    const els = [...this.shell.view.querySelectorAll<HTMLElement>('.f3-sdim')];
    const H = this.shell.view.clientHeight;
    const GAP = 6;
    const placed: DOMRect[] = [];
    for (const el of els) {
      let r = el.getBoundingClientRect();
      const hit = (q: DOMRect) => placed.find((p) => q.left < p.right + GAP && q.right > p.left - GAP && q.top < p.bottom + GAP && q.bottom > p.top - GAP);
      for (let k = 0; k < 6; k++) {
        const p = hit(r);
        if (!p) break;
        const top = parseFloat(el.style.top);
        const down = p.bottom + GAP - r.top;
        const up = r.bottom - (p.top - GAP);
        const dy = top + down + r.height < H ? down : -up;
        el.style.top = `${top + dy}px`;
        r = el.getBoundingClientRect();
      }
      placed.push(r);
    }
  }

  private placeSelDims(): void {
    this.shell.view.querySelectorAll('.f3-sdim').forEach((x) => x.remove());
    const b = this.activeBuilding();
    if (!b || this.drag) return;
    const M = this.view.buildingMatrix(b);
    const put = (p: THREE.Vector3, text: string) => {
      const sp = this.view.toScreen(p);
      if (sp.behind) return;
      const el = document.createElement('div');
      el.className = 'f3-dim f3-sdim';
      el.textContent = text;
      el.style.left = `${sp.x}px`;
      el.style.top = `${sp.y}px`;
      this.shell.view.appendChild(el);
    };
    const solids = this.context === b.id ? this.sel.solids.map((id) => findSolid(b, id)).filter((s): s is Solid => !!s) : [];
    if (solids.length === 1 && !this.sel.elems.length && !this.sel.item) {
      const s = solids[0]!;
      const r = solidRings(s);
      // Comprimento de cada lado (somando os segmentos de um lado curvo).
      const sides = new Map<string, { len: number; mid: Vec2 }>();
      r.outer.segs.forEach((g, i) => {
        if (g.edge.endsWith(':c')) return;
        const a = r.outer.pts[i]!,
          c = r.outer.pts[(i + 1) % r.outer.pts.length]!;
        const cur = sides.get(g.edge) ?? { len: 0, mid: a };
        cur.len += Math.hypot(c[0] - a[0], c[1] - a[1]);
        sides.set(g.edge, cur);
      });
      for (const [edge, v] of sides) {
        const ring = s.plan.outer;
        const k = ring.findIndex((q) => q.id === edge);
        if (k < 0) continue;
        const m = midOf(ring[k]!, ring[(k + 1) % ring.length]!);
        const n = edgeNormal(s, edge) ?? [0, 0];
        put(new THREE.Vector3(m[0] + n[0] * 0.9, s.base + 0.05, m[1] + n[1] * 0.9).applyMatrix4(M), `${fmt(v.len)} m`);
      }
      // Altura ao lado da quina mais à direita na tela, a meia altura (o centro é do gizmo).
      let best: THREE.Vector3 | null = null;
      let bx = -Infinity;
      for (const p of r.outer.pts) {
        const w = new THREE.Vector3(p[0], s.base + s.height / 2, p[1]).applyMatrix4(M);
        const sp = this.view.toScreen(w);
        if (!sp.behind && sp.x > bx) {
          bx = sp.x;
          best = w;
        }
      }
      if (best) {
        const sp = this.view.toScreen(best);
        const el = document.createElement('div');
        el.className = 'f3-dim f3-sdim';
        el.textContent = `↕ ${fmt(s.height)} m`;
        el.style.left = `${sp.x + 30}px`;
        el.style.top = `${sp.y}px`;
        this.shell.view.appendChild(el);
      }
      return;
    }
    if (this.context !== b.id) {
      const pts = b.solids.filter((s) => s.op === 'add').flatMap((s) => solidRings(s).outer.pts);
      if (!pts.length) return;
      const xs = pts.map((p) => p[0]),
        zs = pts.map((p) => p[1]);
      const top = Math.max(...b.solids.map((s) => s.base + s.height));
      put(new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, 0.1, Math.max(...zs) + 1.2).applyMatrix4(M), `${fmt(Math.max(...xs) - Math.min(...xs))} m`);
      put(new THREE.Vector3(Math.max(...xs) + 1.2, 0.1, (Math.min(...zs) + Math.max(...zs)) / 2).applyMatrix4(M), `${fmt(Math.max(...zs) - Math.min(...zs))} m`);
      // Altura numa quina vertical (o centro do topo é do gizmo).
      put(new THREE.Vector3(Math.max(...xs) + 1.2, top / 2, Math.max(...zs) + 1.2).applyMatrix4(M), `↕ ${fmt(top)} m`);
    }
  }

  // ── Seleção múltipla (docs/SELECAO.md) ───────────────────────────────
  /** Clique parado pendente (dentro de uma seleção múltipla, sem arrasto). */
  private pendingClick: Hit | null = null;

  /** O ponto pressionado já está selecionado (com `multi`, numa seleção de vários)? */
  private inSelection(hit: Hit, multi: boolean): boolean {
    const b = hit.building;
    if (this.context !== b.id) return (!multi || this.sel.others.length > 0) && this.selectedBuildings().includes(b.id);
    const p = hit.part;
    const key = p ? (p.rule ? `r|${p.solid}|${p.rule}|${p.key}` : p.item ? `i|${p.item}|${p.key ?? '0'}` : null) : null;
    if (key) return multi ? this.sel.elems.length > 1 && this.sel.elems.includes(key) : this.sel.item === p!.item || this.sel.elems.includes(key);
    return (!multi || this.sel.solids.length > 1) && !!hit.face && this.sel.solids.includes(hit.face.solid);
  }

  /** Gira os edifícios selecionados juntos, em torno do centro comum (cada um gira e anda no círculo). */
  rotateBuildings(deg: number): void {
    const bs = this.selectedBuildings().map((id) => this.store.building(id)).filter((x): x is Building3 => !!x);
    if (!bs.length) return;
    const centers = bs.map((x) => {
      const add = x.solids.filter((s) => s.op === 'add');
      const c = add.map((s) => planCenter(s));
      return toWorld(x, c.length ? [c.reduce((a, q) => a + q[0], 0) / c.length, c.reduce((a, q) => a + q[1], 0) / c.length] : [0, 0]);
    });
    const G: Vec2 = [centers.reduce((a, q) => a + q[0], 0) / centers.length, centers.reduce((a, q) => a + q[1], 0) / centers.length];
    const a = rad(deg);
    for (const x of bs) {
      const dx = x.position[0] - G[0],
        dz = x.position[1] - G[1];
      // Mesma rotação de buildingMatrix/toWorld: (x, z) → (x cos a + z sin a, −x sin a + z cos a).
      x.position = [G[0] + dx * Math.cos(a) + dz * Math.sin(a), G[1] - dx * Math.sin(a) + dz * Math.cos(a)];
      x.rotation = (((x.rotation + deg) % 360) + 360) % 360;
    }
    this.store.commit(bs.map((x) => x.id), `${bs.length} edifícios girados ${deg}°.`, false);
    this.toast(`${bs.length} edifícios girados ${deg}°.`);
    this.drawSelection();
  }

  /** Arestas (pares de pontos) das caixas dos elementos `keys` do edifício `b`, no mundo. */
  private elemBoxes(b: Building3, keys: Set<string>): number[] {
    const built = this.view.built.get(b.id);
    if (!built) return [];
    const M = this.view.buildingMatrix(b);
    const pos: number[] = [];
    const mm = new THREE.Matrix4();
    for (const pl of built.ev.placements) {
      const k = elemKey(pl);
      if (!k || !keys.has(k)) continue;
      const [w, h, dd] = pl.family.size(pl.params);
      mm.fromArray(pl.frame).premultiply(M);
      const c = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(mm);
      const xs = [-w / 2 - 0.05, w / 2 + 0.05],
        ys = [-0.05, h + 0.05],
        zs = pl.host ? [-0.05, Math.max(0.12, dd) + 0.05] : [-dd / 2 - 0.05, dd / 2 + 0.05];
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => c(xs[i & 1]!, ys[(i >> 1) & 1]!, zs[(i >> 2) & 1]!));
      for (const [a, b2] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]] as [number, number][]) pos.push(...corners[a]!.toArray(), ...corners[b2]!.toArray());
    }
    return pos;
  }

  /** Grupos automáticos dos elementos do edifício em edição (categoria → tipo → variação). */
  elementGroups(): GroupRow[] {
    return groupElements(
      this.elements(),
      (t) => {
        const ty = typeById(t, this.project);
        const f = ty && family(ty.family);
        return ty && f ? { name: ty.name, category: f.category, ...(ty.base ? { base: ty.base } : {}) } : undefined;
      },
      (c) => CATEGORY_NAMES[c as keyof typeof CATEGORY_NAMES] ?? c,
      Object.keys(CATEGORY_NAMES),
    );
  }

  /** Seleciona um grupo (com os modificadores do clique: Ctrl soma, Shift alterna, Ctrl+Shift tira). */
  selectGroup(id: string, e: Mods): void {
    const b = this.activeBuilding();
    const g = this.elementGroups().find((x) => x.id === id);
    if (!b || !g) return;
    const next = combine(this.sel.elems, g.keys, selMode(e));
    this.selectElemKeys(b.id, next);
    this.toast(`${next.length} elemento(s) selecionado(s).`);
  }

  private groupHover = new THREE.Group();
  /** Pré-destaque no modelo do que um grupo do painel acrescentaria à seleção (null apaga). */
  previewElems(keys: string[] | null): void {
    if (!keys && !this.groupHover.children.length) return;
    if (!this.groupHover.parent) this.view.overlay.add(this.groupHover);
    for (const c of [...this.groupHover.children]) {
      this.groupHover.remove(c);
      const m = c as THREE.LineSegments;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    const b = this.activeBuilding();
    // Só o que o clique acrescentaria: o que já está selecionado tem o destaque laranja.
    const sel = new Set(this.sel.elems);
    const add = keys?.filter((k) => !sel.has(k)) ?? [];
    const pos = b && add.length ? this.elemBoxes(b, new Set(add)) : [];
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const front = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#5b9cff', depthTest: true }));
      const behind = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#5b9cff', depthTest: false, transparent: true, opacity: 0.3 }));
      front.renderOrder = 24;
      behind.renderOrder = 23;
      this.groupHover.add(front, behind);
    }
    this.view.mark();
  }

  /** Edifícios selecionados, o principal primeiro. */
  selectedBuildings(): ID[] {
    return this.sel.building ? [this.sel.building, ...this.sel.others] : [];
  }

  selectBuildings(ids: ID[]): void {
    if (!ids.length) return this.select({});
    this.select({ building: ids[0]!, others: ids.slice(1) });
  }

  /** Seleciona elementos por chave; um componente sozinho abre o painel dele. */
  selectElemKeys(bid: ID, keys: string[]): void {
    if (!keys.length) return this.select({ building: bid });
    const only = keys.length === 1 && keys[0]!.startsWith('i|') ? keys[0]!.split('|')[1]! : null;
    this.select({ building: bid, elems: keys, item: only });
  }

  private moveMarquee(e: { clientX: number; clientY: number }): void {
    const m = this.marquee!;
    m.bx = e.clientX;
    m.by = e.clientY;
    if (!m.active && Math.hypot(m.bx - m.ax, m.by - m.ay) < 5) return;
    m.active = true;
    if (!this.marqueeEl) {
      this.marqueeEl = document.createElement('div');
      this.marqueeEl.className = 'f3-marquee';
      this.shell.view.appendChild(this.marqueeEl);
    }
    const el = this.marqueeEl;
    const rv = this.shell.view.getBoundingClientRect();
    const { rect, window: win } = marqueeRect(m.ax, m.ay, m.bx, m.by);
    el.hidden = false;
    el.classList.toggle('cross', !win);
    el.style.left = `${rect.x0 - rv.left}px`;
    el.style.top = `${rect.y0 - rv.top}px`;
    el.style.width = `${rect.x1 - rect.x0}px`;
    el.style.height = `${rect.y1 - rect.y0}px`;
    this.drawHover(null);
    this.shell.status.hint.textContent = win ? 'Janela (→): pega só o que fica inteiro dentro' : 'Cruzada (←): pega tudo o que a caixa toca';
  }

  private endMarquee(): void {
    const m = this.marquee!;
    this.marquee = null;
    if (this.marqueeEl) this.marqueeEl.hidden = true;
    if (!m.active) return this.clickSelect(m.hit, m.ev);
    this.applyMarquee(m);
    this.updateHint();
  }

  /** O que a caixa pega: edifícios fora de um edifício; dentro, elementos (ou volumes, se não houver). */
  private applyMarquee(m: { ax: number; ay: number; bx: number; by: number; ev: Mods }): void {
    const cr = this.view.renderer.domElement.getBoundingClientRect();
    const { rect, window: win } = marqueeRect(m.ax - cr.left, m.ay - cr.top, m.bx - cr.left, m.by - cr.top);
    const mode = selMode(m.ev);
    const scr = (v: THREE.Vector3) => this.view.toScreen(v);
    const solidPts = (s: Solid, M: THREE.Matrix4) => s.plan.outer.flatMap((v) => [new THREE.Vector3(v.p[0], s.base, v.p[1]).applyMatrix4(M), new THREE.Vector3(v.p[0], s.base + s.height, v.p[1]).applyMatrix4(M)]);
    const b = this.context ? this.store.building(this.context) : null;
    if (!b) {
      const ids = this.project.buildings
        .filter((x) => !buildingHidden(this.project, x) && !buildingLocked(this.project, x))
        .filter((x) => {
          const M = this.view.buildingMatrix(x);
          return boxPicks(x.solids.filter((s) => s.op === 'add').flatMap((s) => solidPts(s, M)).map(scr), rect, win);
        })
        .map((x) => x.id);
      const next = combine(this.selectedBuildings(), ids, mode);
      this.selectBuildings(next);
      if (next.length) this.toast(`${next.length} edifício(s) selecionado(s).`);
      return;
    }
    const M = this.view.buildingMatrix(b);
    const cam = this.view.camera.position;
    const mm = new THREE.Matrix4(),
      n = new THREE.Vector3(),
      c = new THREE.Vector3();
    const keys: string[] = [];
    for (const el of this.elements()) {
      const pl = el.pl;
      const it = pl.tag.item ? b.items.find((x) => x.id === pl.tag.item) : undefined;
      if (it && (itemHidden(this.project, it) || itemLocked(this.project, it))) continue;
      const [w, h, d] = pl.family.size(pl.params);
      mm.fromArray(pl.frame).premultiply(M);
      if (pl.host) {
        // Só faces voltadas para a câmera: a caixa não pega o fundo do prédio.
        n.setFromMatrixColumn(mm, 2);
        c.setFromMatrixPosition(mm);
        if (n.dot(c.sub(cam).negate()) <= 0) continue;
      }
      let pts: THREE.Vector3[];
      if (pl.path) pts = pl.path.flatMap((p) => [new THREE.Vector3(p[0], p[1], p[2]), new THREE.Vector3(p[0], p[1] + h, p[2])].map((v) => v.applyMatrix4(mm)));
      else {
        const zs = pl.host ? [0, Math.max(0.05, d)] : [-d / 2, d / 2];
        pts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? w / 2 : -w / 2, i & 2 ? h : 0, zs[(i >> 2) & 1]!).applyMatrix4(mm));
      }
      if (boxPicks(pts.map(scr), rect, win)) keys.push(el.key);
    }
    if (keys.length) {
      const next = combine(this.sel.elems, keys, mode);
      this.selectElemKeys(b.id, next);
      this.toast(`${next.length} elemento(s) selecionado(s).`);
      return;
    }
    // Nenhum elemento na caixa: volumes.
    const sids = b.solids.filter((s) => !solidHidden(this.project, s) && !solidLocked(this.project, s) && boxPicks(solidPts(s, M).map(scr), rect, win)).map((s) => s.id);
    if (!sids.length && mode !== 'replace') return;
    const next = combine(this.sel.solids, sids, mode);
    this.select({ building: b.id, solids: next });
    if (next.length) this.toast(`${next.length} volume(s) selecionado(s).`);
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
      // Pavimento pela cota real da peça (regras, avulsas e componentes livres na mesma numeração).
      const y = (pl.path ? (pl.path[0]?.[1] ?? 0) : pl.frame[13]!) + 0.05;
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
  elemAction(kind: 'remove' | 'restore' | 'swap' | 'vary' | 'detach', typeId?: ID): void {
    const b = this.activeBuilding();
    if (!b || !this.sel.elems.length) return;
    const keys = this.sel.elems;
    let varied: ID | null = null;
    if (kind === 'vary') {
      // Variação do tipo só para estes elementos (os demais seguem o tipo original).
      const first = this.elements().find((e) => e.key === keys[0]);
      const base = first && typeById(first.type, this.project);
      if (!base) return;
      const v = { id: uid(), family: base.family, name: base.name + ' (variação)', params: structuredClone(base.params), user: true, base: base.base ?? base.id };
      this.store.project.types.push(v);
      varied = v.id;
    }
    // Soltar da regra: cada elemento vira componente avulso no mesmo lugar (Figma: desanexar).
    const detached: string[] = [];
    const placed = kind === 'detach' ? new Map(this.elements().map((e) => [e.key, e])) : null;
    this.change(b.id, (x) => {
      for (const k of keys) {
        const parts = k.split('|');
        if (parts[0] === 'r') {
          const rule = findSolid(x, parts[1]!)?.facade.find((f) => f.id === parts[2]);
          if (!rule) continue;
          const pos = parts[3]!;
          if (kind === 'detach') {
            const el = placed!.get(k);
            if (!el?.pl.host) continue;
            const ex = rule.except[pos];
            const id = uid();
            x.items.push({ id, type: ex && ex !== 'none' ? ex : rule.type, params: structuredClone(rule.params), host: { kind: 'face', solid: el.pl.host.solid, edge: el.pl.host.edge, u: el.pl.host.s, y: el.pl.host.y }, origin: { solid: parts[1]!, rule: rule.id, key: pos, ...(ex && ex !== 'none' ? { prev: ex } : {}) } });
            rule.except[pos] = 'none';
            detached.push(`i|${id}|0`);
          } else if (kind === 'remove') rule.except[pos] = 'none';
          else if (kind === 'restore') delete rule.except[pos];
          else if (kind === 'swap' && typeId) rule.except[pos] = typeId;
          else if (kind === 'vary' && varied) rule.except[pos] = varied;
        } else if (parts[0] === 'i') {
          if (kind === 'restore') {
            // Avulso que veio de uma regra: sai, e a regra volta a ocupar a posição.
            const it = x.items.find((i) => i.id === parts[1]);
            const o = it?.origin;
            if (!o) continue;
            const rule = findSolid(x, o.solid)?.facade.find((f) => f.id === o.rule);
            if (rule) {
              // A posição volta como era antes de soltar (com a variação de tipo, se tinha).
              if (o.prev) rule.except[o.key] = o.prev;
              else delete rule.except[o.key];
            }
            x.items = x.items.filter((i) => i.id !== it.id);
          } else if (kind === 'remove') x.items = x.items.filter((i) => i.id !== parts[1]);
          else if ((kind === 'swap' && typeId) || (kind === 'vary' && varied)) {
            const it = x.items.find((i) => i.id === parts[1]);
            if (it) it.type = (typeId ?? varied)!;
          }
        }
      }
    }, kind === 'remove' ? `${keys.length} elemento(s) removido(s).` : kind === 'restore' ? 'Elementos voltaram à regra.' : kind === 'vary' ? 'Variação criada: edite os campos para mudar só estes.' : kind === 'detach' ? `${keys.filter((k) => k.startsWith('r|')).length} elemento(s) soltos da regra: movem e mudam sozinhos.` : 'Tipo trocado.');
    if (kind === 'remove' || kind === 'restore') this.select({ building: b.id });
    else if (kind === 'detach') this.selectElemKeys(b.id, detached);
    else if (varied) this.variation = varied;
  }

  /** Tipo de variação em edição (depois de "Editar só estes"). */
  variation: ID | null = null;
  /** Parâmetros dos elementos selecionados valem para o tipo todo ou só para eles. */
  elemScope: 'type' | 'sel' = 'type';

  /**
   * Muda um parâmetro dos elementos selecionados: no tipo (todas as
   * ocorrências e regras) ou, em "só os selecionados", numa variação do tipo
   * criada na primeira mudança (como duplicar o tipo no Revit).
   */
  editElemsParam(key: string, value: unknown): void {
    const picked = this.elements().filter((e) => this.sel.elems.includes(e.key));
    const types = [...new Set(picked.map((e) => e.type))];
    if (types.length !== 1) return;
    const tid = types[0]!;
    if (this.elemScope === 'type') return this.editType(tid, key, value);
    // A variação já é só destes quando nenhum outro elemento usa o tipo.
    const others = this.elements().some((e) => e.type === tid && !this.sel.elems.includes(e.key));
    if (others || this.project.types.every((t) => t.id !== tid)) {
      this.elemAction('vary');
      if (!this.variation) return;
      return this.editType(this.variation, key, value);
    }
    this.editType(tid, key, value);
  }

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

  /** Último desenho usado (o grupo mostra o ícone dele). */
  private lastDraw: Tool = 'rect';

  private renderTools(): void {
    type T = { id: string; ic: string; label: string; key: string };
    const draw: T[] = [
      { id: 'rect', ic: 'rect', label: 'Retângulo', key: 'R' },
      { id: 'circle', ic: 'circle', label: 'Círculo', key: 'C' },
      { id: 'polygon', ic: 'polygon', label: 'Polígono', key: 'L' },
    ];
    if (draw.some((d) => d.id === this.tool)) this.lastDraw = this.tool;
    const cur = draw.find((d) => d.id === this.lastDraw)!;
    const one = (t: T, pressed: boolean, extra = '') => `<button class="f3-tool${extra}" data-tool="${t.id}" title="${t.label} · ${t.key}" aria-label="${t.label}" aria-pressed="${pressed}">${icon(t.ic)}</button>`;
    const drawing = draw.some((d) => d.id === this.tool);
    this.shell.tools.innerHTML = [
      one({ id: 'select', ic: 'cursor', label: 'Selecionar e mover', key: 'V' }, this.tool === 'select'),
      one({ id: 'push', ic: 'push', label: 'Empurrar/puxar faces (Ctrl: extrudar)', key: 'P' }, this.tool === 'push'),
      one({ ...cur, label: `${cur.label} (segure para outros desenhos)` }, drawing, ' grp'),
      one({ id: 'mode', ic: this.drawMode === 'add' ? 'add' : 'subtract', label: this.drawMode === 'add' ? 'O desenho soma (trocar para recortar)' : 'O desenho recorta (trocar para somar)', key: 'X' }, this.drawMode === 'subtract'),
      '<hr>',
      one({ id: 'catalog', ic: 'catalog', label: 'Biblioteca de blocos e componentes', key: 'K' }, !this.shell.cat.classList.contains('closed')),
      one({ id: 'paint', ic: 'paint', label: 'Pintar (Alt: conta-gotas)', key: 'B' }, this.tool === 'paint'),
      one({ id: 'tape', ic: 'tape', label: 'Trena e cotas (Shift+Delete apaga)', key: 'T' }, this.tool === 'tape'),
    ].join('');
    const snapBtn = this.shell.status.bar.querySelector('[data-cmd="snap"]');
    snapBtn?.setAttribute('aria-pressed', String(this.infer.enabled));
    const libBtn = this.shell.status.bar.querySelector('[data-cmd="library"]');
    libBtn?.setAttribute('aria-pressed', String(!this.shell.cat.classList.contains('closed')));
    // Submenu do grupo de desenho: segurar (ou clicar no canto) abre a lista.
    const grp = this.shell.tools.querySelector<HTMLButtonElement>('.f3-tool.grp')!;
    let hold = 0;
    const openFly = () => {
      this.closeFly();
      const fly = document.createElement('div');
      fly.className = 'f3-fly f3-island';
      fly.innerHTML = draw.map((d) => `<button data-fly="${d.id}" aria-pressed="${d.id === this.tool}">${icon(d.ic)}${d.label}<kbd>${d.key}</kbd></button>`).join('');
      const r = grp.getBoundingClientRect(),
        rv = this.shell.view.getBoundingClientRect();
      fly.style.left = `${r.right - rv.left + 8}px`;
      fly.style.top = `${r.top - rv.top - 4}px`;
      this.shell.view.appendChild(fly);
      fly.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
        b.addEventListener('click', () => {
          this.closeFly();
          this.setTool(b.dataset.fly as Tool);
        }),
      );
      closeOnOutside(fly, () => this.closeFly(), grp);
    };
    grp.addEventListener('pointerdown', () => {
      hold = window.setTimeout(() => {
        hold = -1;
        openFly();
      }, 320);
    });
    grp.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openFly();
    });
    this.shell.tools.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.tool!;
        if (b === grp) {
          if (hold === -1) return void (hold = 0);
          clearTimeout(hold);
        }
        if (id === 'mode') this.toggleDrawMode();
        else if (id === 'catalog') this.toggleLibrary();
        else this.setTool(id as Tool);
      }),
    );
  }

  private closeFly(): void {
    this.shell.view.querySelectorAll('.f3-fly').forEach((f) => f.remove());
  }

  /** Abre ou fecha a gaveta da biblioteca. */
  toggleLibrary(open?: boolean): void {
    const cat = this.shell.cat;
    const willOpen = open ?? cat.classList.contains('closed');
    cat.classList.toggle('closed', !willOpen);
    if (willOpen) this.emitCatalog();
    this.renderTools();
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
        select: this.context ? 'Clique num volume, face ou componente; Ctrl soma, Shift alterna; arraste no vazio para a caixa. Duplo clique numa janela pega a fileira.' : 'Clique num edifício; Ctrl soma, Shift alterna; arraste no vazio para a caixa. Duplo clique entra para editar.',
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
      // Ctrl sobre o que já está selecionado: arrastar copia (SketchUp); parado, nada muda.
      const copyGrab = !!hit && (e.ctrlKey || e.metaKey) && !e.shiftKey && this.inSelection(hit, false);
      // Vazio, ou Ctrl/Shift em qualquer lugar: caixa de seleção; parado, vale como clique na soltura.
      if (this.tool === 'select' && !copyGrab && (!hit || e.ctrlKey || e.shiftKey || e.metaKey)) {
        this.marquee = { ax: e.clientX, ay: e.clientY, bx: e.clientX, by: e.clientY, active: false, hit, ev: { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey, altKey: e.altKey } };
        return;
      }
      // Pressionar algo que já está numa seleção múltipla não a desfaz: arrastar move o
      // grupo; soltar sem arrastar seleciona só aquilo (como no SketchUp e no Figma).
      if (hit && (copyGrab || this.inSelection(hit, true))) {
        const b0 = this.activeBuilding()!;
        if (this.context !== b0.id) this.beginMoveBuilding(b0, e, hit);
        else if (this.sel.item && !this.sel.elems.length) this.beginMoveItem(b0, e, hit);
        else if (this.sel.solids.length && !this.sel.elems.length) this.beginMoveSolids(b0, e, hit);
        const ev = { ctrlKey: copyGrab, shiftKey: false, metaKey: false, altKey: false };
        if (this.drag) this.drag.data.click = { hit, ev };
        else if (!copyGrab) this.pendingClick = hit;
        return;
      }
      // Clique de novo num edifício já selecionado (sem arrastar) entra nele e pega o volume.
      const drill = hit && this.context !== hit.building.id && this.sel.building === hit.building.id && !e.shiftKey && !this.sel.others.length ? hit.face?.solid : undefined;
      this.clickSelect(hit, e);
      this.drawHover(null);
      // Arrastar o que está selecionado move (direto no modelo).
      const b = this.activeBuilding();
      if (hit && b && hit.building.id === b.id) {
        if (this.context !== b.id) {
          this.beginMoveBuilding(b, e, hit);
          if (this.drag && drill) this.drag.data.drill = drill;
        }
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

  private clickSelect(hit: Hit | null, e: Mods): void {
    const mode = selMode(e);
    if (!hit) {
      // Clique no vazio com modificador não perde a seleção.
      if (mode !== 'replace') return;
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
      // Vários edifícios (para alinhar e distribuir).
      if (mode !== 'replace') return this.selectBuildings(combine(this.selectedBuildings(), [b.id], mode));
      return this.select({ building: b.id });
    }
    if (hit.part) {
      const key = hit.part.rule ? `r|${hit.part.solid}|${hit.part.rule}|${hit.part.key}` : hit.part.item ? `i|${hit.part.item}|${hit.part.key ?? '0'}` : null;
      // Alt: o trecho da fileira entre o último selecionado e este.
      if (key && e.altKey && this.sel.elems.length) return this.selectElemKeys(b.id, combine(this.sel.elems, [...between(this.elements(), this.sel.elems[this.sel.elems.length - 1]!, key)], 'add'));
      if (key && mode !== 'replace') return this.selectElemKeys(b.id, combine(this.sel.elems, [key], mode));
      if (hit.part.item) return this.select({ building: b.id, item: hit.part.item, elems: key ? [key] : [] });
      if (key) return this.select({ building: b.id, elems: [key] });
    }
    const f = hit.face;
    if (!f) return;
    const sid = f.solid;
    if (mode !== 'replace') {
      // Com modificador, a parede só entra numa seleção de volumes; com elementos selecionados, nada muda.
      if (this.sel.item || this.sel.elems.length) return;
      return this.select({ building: b.id, solids: combine(this.sel.solids, [sid], mode) });
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
    if (this.marquee) return this.moveMarquee(e);
    if (this.drag) return this.updateDrag(e);
    if (this.tool === 'select') {
      this.handles.setHover(this.handles.hit(e));
      const h = this.handles.hover;
      if (h) {
        this.shell.status.hint.textContent = h.label;
        this.drawHover(null);
        this.view.renderer.domElement.style.cursor = h.kind === 'size' ? (h.sx && h.sz ? (h.sx * h.sz > 0 ? 'nwse-resize' : 'nesw-resize') : 'ew-resize') : h.kind === 'rotate' ? 'grab' : 'move';
        return;
      }
      const hit = this.pickAt(e);
      this.drawHover(hit);
      const b = this.activeBuilding();
      const onSel = !!hit && !!b && hit.building.id === b.id && (this.context !== b.id || (hit.face && this.sel.solids.includes(hit.face.solid)) || (!!hit.part?.item && hit.part.item === this.sel.item));
      this.view.renderer.domElement.style.cursor = !hit ? 'default' : onSel ? 'move' : 'pointer';
      return;
    }
    if (this.tool === 'rect' || this.tool === 'circle' || this.tool === 'polygon') return this.drawMove(e);
    if (this.tool === 'place') return this.placeHover(e);
    if (this.tool === 'block') return this.blockAt(e, false);
    if (this.tool === 'tape') return this.tapeAt(e, false);
  }

  private hoverKey = '';
  private hoverOverlay = new THREE.Group();

  /**
   * Pré-realce: mostra o que o próximo clique vai selecionar (edifício,
   * volume, face ou elemento), como o SketchUp, antes de clicar.
   */
  private drawHover(hit: Hit | null): void {
    if (!this.hoverOverlay.parent) this.view.overlay.add(this.hoverOverlay);
    let key = '';
    let what: { b: Building3; solids?: ID[]; face?: { solid: ID; kind: string; edge?: ID }; part?: Hit['part'] } | null = null;
    if (hit && !this.drag) {
      const b = hit.building;
      if (this.context !== b.id) {
        // Edifício já selecionado: o clique entra e pega o volume sob o cursor.
        if (this.sel.building === b.id && hit.face) what = { b, solids: [hit.face.solid] };
        else if (this.sel.building !== b.id) what = { b, solids: b.solids.filter((s) => s.op === 'add').map((s) => s.id) };
      } else if (hit.part && (hit.part.item || hit.part.rule)) what = { b, part: hit.part };
      else if (hit.face) {
        const already = this.sel.solids.length === 1 && this.sel.solids[0] === hit.face.solid;
        if (already && !this.sel.face && (hit.face.kind === 'side' || hit.face.kind === 'top' || hit.face.kind === 'roof')) what = { b, face: { solid: hit.face.solid, kind: hit.face.kind, edge: hit.face.edge } };
        else if (!already) what = { b, solids: [hit.face.solid] };
      }
      if (what) key = `${b.id}|${what.solids?.join(',') ?? ''}|${what.face ? what.face.solid + what.face.kind + (what.face.edge ?? '') : ''}|${what.part ? (what.part.item ?? '') + (what.part.rule ?? '') + (what.part.key ?? '') : ''}|${this.store.revision.get(b.id)}`;
    }
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    for (const c of [...this.hoverOverlay.children]) {
      this.hoverOverlay.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose();
    }
    if (what) {
      const M = this.view.buildingMatrix(what.b);
      const color = '#5b9cff';
      const addLine = (pts: THREE.Vector3[], closed = true) => {
        const l = new (closed ? THREE.LineLoop : THREE.Line)(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
        l.renderOrder = 19;
        this.hoverOverlay.add(l);
      };
      for (const id of what.solids ?? []) {
        const s = findSolid(what.b, id);
        if (!s) continue;
        const r = solidRings(s);
        addLine(r.outer.pts.map((p) => new THREE.Vector3(p[0], r.base + 0.02, p[1]).applyMatrix4(M)));
        addLine(r.topOuter.map((p) => new THREE.Vector3(p[0], r.top, p[1]).applyMatrix4(M)));
        r.outer.pts.forEach((p, i) => {
          if (r.outer.segs[i]!.curved) return;
          addLine([new THREE.Vector3(p[0], r.base, p[1]).applyMatrix4(M), new THREE.Vector3(r.topOuter[i]![0], r.top, r.topOuter[i]![1]).applyMatrix4(M)], false);
        });
      }
      const built = this.view.built.get(what.b.id);
      // Véu azul nos volumes sob o cursor (o contorno sozinho some de longe).
      if (what.solids?.length && built) {
        const set = new Set(what.solids);
        const { positions: P, indices: I, faceOf } = built.ev.shell;
        const pos: number[] = [];
        for (let t = 0; t < I.length / 3; t++) {
          const f = built.ev.faces[faceOf[t]!];
          if (!f || !set.has(f.solid) || f.kind.startsWith('room')) continue;
          for (let j = 0; j < 3; j++) {
            const i = I[t * 3 + j]! * 3;
            pos.push(P[i]!, P[i + 1]!, P[i + 2]!);
          }
        }
        if (pos.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
          m.applyMatrix4(M);
          m.renderOrder = 14;
          this.hoverOverlay.add(m);
        }
      }
      if (what.face && built) {
        const f0 = what.face;
        const { positions: P, indices: I, faceOf } = built.ev.shell;
        const pos: number[] = [];
        for (let t = 0; t < I.length / 3; t++) {
          const f = built.ev.faces[faceOf[t]!];
          if (!f || f.solid !== f0.solid) continue;
          if (f0.kind === 'side' ? !(f.kind === 'side' && f.edge === f0.edge) : !(f.kind === 'top' || f.kind === 'roof')) continue;
          for (let j = 0; j < 3; j++) {
            const i = I[t * 3 + j]! * 3;
            pos.push(P[i]!, P[i + 1]!, P[i + 2]!);
          }
        }
        if (pos.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
          m.applyMatrix4(M);
          m.renderOrder = 14;
          this.hoverOverlay.add(m);
        }
      }
      if (what.part && built) {
        const tag = what.part;
        const pos: number[] = [];
        const mm = new THREE.Matrix4();
        for (const pl of built.ev.placements) {
          if (pl.tag.item !== tag.item || pl.tag.rule !== tag.rule || pl.tag.key !== tag.key) continue;
          const [w, h, dd] = pl.family.size(pl.params);
          mm.fromArray(pl.frame).premultiply(M);
          const c = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(mm);
          const xs = [-w / 2 - 0.04, w / 2 + 0.04],
            ys = [-0.04, h + 0.04],
            zs = [-0.04, Math.max(0.12, dd) + 0.04];
          const k = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => c(xs[i & 1]!, ys[(i >> 1) & 1]!, zs[(i >> 2) & 1]!));
          for (const [a, b2] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]] as [number, number][]) pos.push(...k[a]!.toArray(), ...k[b2]!.toArray());
        }
        if (pos.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
          l.renderOrder = 19;
          this.hoverOverlay.add(l);
        }
      }
    }
    this.view.mark();
  }

  private onUp(e: PointerEvent): void {
    if (this.marquee) return this.endMarquee();
    if (this.pendingClick) {
      const hit = this.pendingClick;
      this.pendingClick = null;
      return this.clickSelect(hit, { ctrlKey: false, shiftKey: false, metaKey: false, altKey: false });
    }
    if (this.drag) return this.finishDrag(e);
    if ((this.tool === 'rect' || this.tool === 'circle') && this.draft && this.draft.points.length === 1 && this.draft.hover && this.draft.hover.distanceTo(this.draft.points[0]!) > 0.6) this.drawDown(e);
  }

  cancel(): void {
    this.marquee = null;
    if (this.marqueeEl) this.marqueeEl.hidden = true;
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
    if (h.kind === 'size') {
      const ids = inCtx ? (s ? [s.id] : []) : b.solids.filter((x) => x.op === 'add').map((x) => x.id);
      if (!ids.length) return;
      let x0 = Infinity,
        x1 = -Infinity,
        z0 = Infinity,
        z1 = -Infinity;
      for (const id of ids)
        for (const v of findSolid(b, id)!.plan.outer) {
          x0 = Math.min(x0, v.p[0]);
          x1 = Math.max(x1, v.p[0]);
          z0 = Math.min(z0, v.p[1]);
          z1 = Math.max(z1, v.p[1]);
        }
      const all = !inCtx;
      this.startDrag('size', b, e, { handle: 'size', sx: h.sx, sz: h.sz, box: [x0, x1, z0, z1], y: h.at.y, ids, all }, true);
      this.preview.add(b.id);
      this.setMeasure(h.sx && h.sz ? 'Tamanho' : h.sx ? 'Largura' : 'Profundidade', (t) => {
        const m = /^\s*([\d.,]+)\s*(?:[x*;\s]\s*([\d.,]+))?\s*$/.exec(t);
        if (!m) return false;
        const a = parseFloat(m[1]!.replace(',', '.')),
          c = m[2] ? parseFloat(m[2].replace(',', '.')) : NaN;
        const W0 = x1 - x0,
          D0 = z1 - z0;
        const wantW = h.sx ? a : W0,
          wantD = h.sz ? (h.sx ? (Number.isFinite(c) ? c : (a / W0) * D0) : a) : D0;
        return this.change(b.id, (x) => this.applySize(x, ids, [x0, x1, z0, z1], h.sx ?? 0, h.sz ?? 0, wantW / W0, wantD / D0, all), `Tamanho ${fmt(wantW)} × ${fmt(wantD)} m.`);
      });
      return;
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
    if (h.kind === 'cwidth' || h.kind === 'cheight' || h.kind === 'csill') {
      const it = this.activeItem();
      if (!it || it.host.kind !== 'face') return;
      const t = typeById(it.type, this.project);
      const fam = t && family(t.family);
      if (!t || !fam) return;
      const p = resolveParams(fam, t.params, it.params);
      this.startDrag(h.kind, b, e, { handle: h.kind, at: h.at.clone(), dir: h.dir!.clone(), id: it.id, w0: Number(p.width ?? 1), h0: Number(p.height ?? 1), y0: it.host.y }, true);
      const label = h.kind === 'cwidth' ? 'Largura' : h.kind === 'cheight' ? 'Altura' : 'Peitoril';
      this.setMeasure(label, (txt) => {
        let v = parseLength(txt);
        if (v === null || v <= 0) return false;
        // Largura e altura nos limites do parâmetro (a mensagem diz o que ficou valendo).
        const pk = h.kind === 'cwidth' ? 'width' : h.kind === 'cheight' ? 'height' : null;
        const pd = pk ? fam.params.find((q) => q.key === pk) : undefined;
        if (pd) v = Math.max(pd.min ?? 0.3, Math.min(pd.max ?? Infinity, v));
        return this.change(b.id, (x) => {
          const y = x.items.find((q) => q.id === it.id)!;
          if (h.kind === 'cwidth') y.params.width = v;
          else if (h.kind === 'cheight') y.params.height = v;
          else if (y.host.kind === 'face') {
            const lv = this.levelBelow(x, y);
            y.host.y = lv + v;
          }
        }, `${label} ${fmt(v)} m.`);
      });
      return;
    }
    if (!s) return;
    const M = this.view.buildingMatrix(b);
    // Ctrl + seta da face: extrudar (volume novo), como o Ctrl do Empurrar/Puxar do SketchUp.
    if ((h.kind === 'push' && h.edge) || (h.kind === 'height' && this.sel.face?.kind === 'top')) {
      if (e.ctrlKey) {
        const side = h.kind === 'push';
        this.startDrag(side ? 'extrude-side' : 'extrude-top', b, e, { handle: h.kind, at: h.at.clone(), dir: h.dir!.clone(), edge: h.edge, sid: s.id }, true);
        this.preview.add(b.id);
        this.setMeasure(side ? 'Extrudar' : 'Extrudar topo', (t) => {
          const v = parseLength(t);
          if (v === null || v === 0) return false;
          this.modelOp(side ? 'extrude' : 'inset-top', side ? { depth: v } : { inset: 0, depth: v });
          return true;
        });
        return;
      }
    }
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
    // Os outros edifícios selecionados andam junto (posição de partida de cada um).
    const others = this.sel.building === b.id ? this.sel.others.flatMap((id) => {
      const o = this.store.building(id);
      return o ? [[id, [...o.position]] as [ID, number[]]] : [];
    }) : [];
    this.startDrag('move-building', b, e, { handle: h?.kind ?? 'move-xz', p0, axis: h?.dir?.clone() ?? null, copy: e.ctrlKey, hitY: hit?.point.y ?? 0, others }, false);
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
    // Altura real da peça (no telhado, a da superfície onde ela está): o arrasto anda nessa altura.
    const pl = this.view.built.get(b.id)?.ev.placements.find((q) => q.tag.item === it.id);
    const y0 = pl ? pl.frame[13]! : it.host.kind === 'free' ? it.host.p[1] : 0;
    // Na face: o arrasto anda no plano da própria face, a partir do ponto pego (a peça cobre a
    // parede onde se segura, então não dá para depender de acertar a parede sob o cursor).
    let face: Record<string, unknown> | null = null;
    if (it.host.kind === 'face' && pl) {
      const F = new THREE.Matrix4().fromArray(pl.frame).premultiply(this.view.buildingMatrix(b));
      const n = new THREE.Vector3().setFromMatrixColumn(F, 2).normalize();
      const o = new THREE.Vector3().setFromMatrixPosition(F);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
      const p0 = this.view.rayFrom(e).ray.intersectPlane(plane, new THREE.Vector3());
      const s = findSolid(b, it.host.solid);
      const [w, hh] = pl.family.size(pl.params);
      if (p0 && s) face = { plane, p0, ux: new THREE.Vector3().setFromMatrixColumn(F, 0).normalize().negate(), vy: new THREE.Vector3().setFromMatrixColumn(F, 1).normalize(), u0: it.host.u, yf0: it.host.y, len: edgeLength(s, it.host.edge), w, h: hh, top: s.height };
    }
    this.startDrag('move-item', b, e, { handle: h?.kind ?? 'move-xz', axis: h?.dir?.clone() ?? null, at: h?.at.clone() ?? null, id: it.id, y0, face }, true);
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
    if (d.kind === 'size') {
      const p = this.view.onPlane(e, d.data.y as number);
      if (!p) return;
      const [x0, x1, z0, z1] = d.data.box as number[];
      const l = toLocal(b, [p.x, p.z]);
      const g = !e.altKey && this.infer.enabled ? this.infer.grid : 0;
      const q = (v: number) => (g ? Math.round(v / g) * g : v);
      const sx = d.data.sx as number,
        sz = d.data.sz as number;
      const W0 = x1! - x0!,
        D0 = z1! - z0!;
      let w = sx > 0 ? q(l[0] - x0!) : sx < 0 ? q(x1! - l[0]) : W0;
      let dd = sz > 0 ? q(l[1] - z0!) : sz < 0 ? q(z1! - l[1]) : D0;
      w = Math.max(0.3, w);
      dd = Math.max(0.3, dd);
      let fx = w / W0,
        fz = dd / D0;
      if (e.shiftKey && sx && sz) fx = fz = Math.max(fx, fz);
      b.solids = structuredClone(orig.solids);
      b.items = structuredClone(orig.items);
      if (this.applySize(b, d.data.ids as ID[], [x0!, x1!, z0!, z1!], sx, sz, fx, fz, !!d.data.all)) this.store.touch([b.id]);
      this.showDim(`${fmt(W0 * fx)} × ${fmt(D0 * fz)} m`, e);
      this.drawSelection();
      return;
    }
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
      if (it.host.kind === 'face' && io.host.kind === 'face' && d.data.face) {
        // No plano da face: deslocamento desde o ponto pego, dentro dos limites da face.
        const f = d.data.face as { plane: THREE.Plane; p0: THREE.Vector3; ux: THREE.Vector3; vy: THREE.Vector3; u0: number; yf0: number; len: number; w: number; h: number; top: number };
        const p = this.view.rayFrom(e).ray.intersectPlane(f.plane, new THREE.Vector3());
        if (!p) return;
        p.sub(f.p0);
        let du = p.dot(f.ux),
          dv = p.dot(f.vy);
        if (this.infer.enabled && !e.altKey) {
          // Inferência de eixo (SketchUp): movimento claramente horizontal não mexe na altura, e vice-versa.
          if (Math.abs(dv) < 0.3 && Math.abs(du) > 3 * Math.abs(dv)) dv = 0;
          else if (Math.abs(du) < 0.3 && Math.abs(dv) > 3 * Math.abs(du)) du = 0;
        }
        let u = f.u0 + du,
          y = f.yf0 + dv;
        if (this.infer.enabled && !e.altKey) {
          if (du) u = Math.round(u / 0.1) * 0.1;
          if (dv) y = Math.round(y / 0.05) * 0.05;
        }
        it.host.u = f.len > f.w ? Math.max(f.w / 2, Math.min(f.len - f.w / 2, u)) : f.len / 2;
        it.host.y = Math.max(0, Math.min(Math.max(0, f.top - f.h), y));
        this.store.touch([b.id]);
        this.showDim(`${fmt(it.host.u)} m ao longo · ${fmt(it.host.y)} m de altura`, e);
        return;
      }
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
      if (it.host.kind === 'roof' && io.host.kind === 'roof') {
        // Peça de telhado desliza sobre o telhado: o que está sob o cursor, ou
        // o plano na altura dela preso à borda do telhado (nunca cai no chão).
        const axis = d.data.axis as THREE.Vector3 | null;
        let sid = io.host.solid;
        let local: Vec2 | null = null;
        if (axis && d.data.at) {
          let t = this.dragAlong(d, e, d.data.at as THREE.Vector3, axis);
          if (this.infer.enabled && !e.altKey) t = Math.round(t / 0.1) * 0.1;
          const dl = dirToLocal(b, [axis.x, axis.z]);
          local = [io.host.p[0] + dl[0] * t, io.host.p[1] + dl[1] * t];
        } else {
          const hit = this.pickAt(e, b.id);
          const hs = hit?.face && (hit.face.kind === 'roof' || hit.face.kind === 'top') ? findSolid(b, hit.face.solid) : undefined;
          if (hit && hs && hs.op === 'add') {
            sid = hs.id;
            local = toLocal(b, [hit.point.x, hit.point.z]);
          } else {
            const p = this.view.onPlane(e, d.data.y0 as number);
            if (p) local = toLocal(b, [p.x, p.z]);
          }
          if (local && this.infer.enabled && !e.altKey) local = [Math.round(local[0] / 0.1) * 0.1, Math.round(local[1] / 0.1) * 0.1];
        }
        const host = findSolid(b, sid);
        if (!local || !host) return;
        it.host.solid = sid;
        it.host.p = clampInside(local, topRing(host), 0.3);
        this.store.touch([b.id]);
        this.showDim('no telhado', e);
        return;
      }
      if (it.host.kind === 'free' && io.host.kind === 'free') {
        const snap = this.infer.snap(e, io.host.kind === 'free' ? io.host.p[1] : 0, null, null);
        if (!snap) return;
        const l = toLocal(b, [snap.p.x, snap.p.z]);
        it.host.p = [l[0], io.host.p[1], l[1]];
        this.store.touch([b.id]);
      }
      return;
    }
    if (d.kind === 'rotate') {
      const c = d.data.center as THREE.Vector3;
      let deg = ((this.angleAt(e, c) - (d.data.a0 as number)) * 180) / Math.PI;
      if (!e.shiftKey && this.infer.enabled) deg = Math.round(deg / this.rotSnap) * this.rotSnap;
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
    if (d.kind === 'cwidth' || d.kind === 'cheight' || d.kind === 'csill') {
      const it = b.items.find((q) => q.id === d.data.id);
      if (!it || it.host.kind !== 'face') return;
      let t = this.dragAlong(d, e, d.data.at as THREE.Vector3, d.data.dir as THREE.Vector3);
      if (!e.altKey && this.infer.enabled) t = Math.round(t / 0.05) * 0.05;
      // Nos limites do próprio parâmetro da família: a medida mostrada é a que fica valendo.
      const fam = family(typeById(it.type, this.project)?.family ?? '');
      const lim = (k: string, v: number) => {
        const p = fam?.params.find((q) => q.key === k);
        return Math.max(p?.min ?? 0.3, Math.min(p?.max ?? Infinity, v));
      };
      if (d.kind === 'cwidth') {
        it.params.width = lim('width', (d.data.w0 as number) + 2 * t);
        this.showDim(`largura ${fmt(it.params.width as number)} m`, e);
      } else if (d.kind === 'cheight') {
        it.params.height = lim('height', (d.data.h0 as number) + t);
        this.showDim(`altura ${fmt(it.params.height as number)} m`, e);
      } else {
        it.host.y = Math.max(0, (d.data.y0 as number) - t);
        this.showDim(`peitoril ${fmt(it.host.y - this.levelBelow(b, it))} m`, e);
      }
      this.store.touch([b.id]);
      return;
    }
    const s = findSolid(b, d.data.sid as ID);
    const so = findSolid(orig, d.data.sid as ID);
    if (!s || !so) return;
    if (d.kind === 'extrude-side' || d.kind === 'extrude-top') {
      let t = this.dragAlong(d, e, d.data.at as THREE.Vector3, d.data.dir as THREE.Vector3);
      if (!e.altKey && this.infer.enabled) t = Math.round(t / 0.1) * 0.1;
      // Refaz a partir do original a cada passo (o volume novo é um só).
      b.solids = structuredClone(orig.solids);
      b.levels = structuredClone(orig.levels);
      const base = findSolid(b, d.data.sid as ID)!;
      const n = Math.abs(t) < 0.05 ? null : d.kind === 'extrude-side' ? extrudeSide(b, base, d.data.edge as ID, t) : insetTop(b, base, 0, t);
      d.data.created = n?.id;
      this.store.touch([b.id]);
      this.showDim((t >= 0 ? '+' : '') + fmt(t) + ' m' + (t < 0 ? ' (recorte)' : ''), e);
      return;
    }
    if (d.kind === 'height' || d.kind === 'lift') {
      const at = d.data.at as THREE.Vector3;
      const t = this.dragAlong(d, e, at, new THREE.Vector3(0, 1, 0));
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
      let t = this.dragAlong(d, e, at, dir);
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

  /**
   * Escala as plantas dos volumes pela caixa, com o lado oposto à alça parado
   * (âncora). No edifício inteiro, as peças soltas acompanham.
   */
  private applySize(b: Building3, ids: ID[], box: number[], sx: number, sz: number, fx: number, fz: number, all: boolean): boolean {
    const [x0, x1, z0, z1] = box as [number, number, number, number];
    const ax = sx > 0 ? x0 : sx < 0 ? x1 : (x0 + x1) / 2;
    const az = sz > 0 ? z0 : sz < 0 ? z1 : (z0 + z1) / 2;
    const k = Math.min(fx, fz);
    const map = (p: Vec2): Vec2 => [ax + (p[0] - ax) * fx, az + (p[1] - az) * fz];
    for (const id of ids) {
      const s = findSolid(b, id);
      if (!s) continue;
      const before = structuredClone(s.plan);
      for (const ring of [s.plan.outer, ...s.plan.holes])
        for (const v of ring) {
          v.p = map(v.p);
          if (v.round) v.round *= k;
          if (v.chamfer) v.chamfer *= k;
        }
      if (!planValidOps(s.plan)) {
        s.plan = before;
        return false;
      }
    }
    if (all)
      for (const it of b.items) {
        if (it.host.kind === 'free') {
          const q = map([it.host.p[0], it.host.p[2]]);
          it.host.p = [q[0], it.host.p[1], q[1]];
        } else if (it.host.kind === 'roof') it.host.p = map(it.host.p);
      }
    return true;
  }

  /** Cota do piso do pavimento sob uma peça de face (relativa à base do sólido). */
  levelBelow(b: Building3, it: Item): number {
    if (it.host.kind !== 'face') return 0;
    const s = findSolid(b, it.host.solid);
    const base = s?.base ?? 0;
    const y = base + it.host.y + 0.01;
    const lv = [...b.levels].sort((p, q) => p.elevation - q.elevation).filter((l) => l.elevation <= y).pop();
    return (lv?.elevation ?? base) - base;
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
      // Partida: a do arrasto ou, ao redigitar a distância, a de antes do último movimento.
      const moveTo = (x: Building3, orig: number[] | null) => {
        const base = orig ?? [x.position[0] - this.lastMoved!.delta.x, x.position[1] - this.lastMoved!.delta.z];
        x.position = [base[0]! + delta.x, base[1]! + delta.z];
      };
      moveTo(b, d ? d.origBuilding.position : null);
      const others = d ? ((d.data.others as [ID, number[]][] | undefined) ?? []) : this.lastMoved!.ids.map((id) => [id, null] as [ID, null]);
      for (const [id, p] of others) {
        const x = this.store.building(id);
        if (x) moveTo(x, p);
      }
      const ids = others.map((o) => o[0]);
      if (commit) {
        this.lastMoved = { kind: 'building', bid: b.id, ids, delta: delta.clone(), copied: this.lastMoved?.copied ?? false };
        this.store.commit([b.id, ...ids], `Movido ${fmt(delta.length())} m.`, false);
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
      c.name = b.name + ' (cópia)';
      this.store.project.buildings.push(c);
      d.bid = c.id;
      d.origBuilding = structuredClone(c);
      this.sel.building = c.id;
      // Os outros selecionados também viram cópias, e são as cópias que andam.
      const others = (d.data.others as [ID, number[]][] | undefined) ?? [];
      d.data.others = others.flatMap(([id, p]) => {
        const src = this.store.building(id);
        if (!src) return [];
        const k = cloneBuilding(src);
        k.name = src.name + ' (cópia)';
        k.position = [p[0]!, p[1]!];
        this.store.project.buildings.push(k);
        return [[k.id, p] as [ID, number[]]];
      });
      this.sel.others = (d.data.others as [ID, number[]][]).map((o) => o[0]);
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

  /** Deslocamento ao longo da reta desde onde o arrasto começou (pegar a ponta da seta não salta). */
  private dragAlong(d: Drag, e: { clientX: number; clientY: number }, at: THREE.Vector3, dir: THREE.Vector3): number {
    if (d.data.t0 === undefined) d.data.t0 = this.alongLine({ clientX: d.start.x, clientY: d.start.y }, at, dir);
    return this.alongLine(e, at, dir) - (d.data.t0 as number);
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
    if (!d.moved && d.kind === 'vertex') {
      // Clique num vértice: seleciona o canto (arredondar, chanfrar, apagar).
      this.store.revert();
      return this.select({ building: this.sel.building, solids: this.sel.solids, vertex: d.data.vertex as ID });
    }
    if (!d.moved && d.kind === 'move-building' && d.data.drill) {
      this.store.revert();
      this.enter(d.bid);
      return this.select({ building: d.bid, solids: [d.data.drill as ID] });
    }
    if (!d.moved && d.data.click) {
      // Clique parado num objeto da seleção múltipla: fica só ele.
      this.store.revert();
      const c = d.data.click as { hit: Hit; ev: Mods };
      return this.clickSelect(c.hit, c.ev);
    }
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
      const ids = ((d.data.others as [ID, number[]][] | undefined) ?? []).map((o) => o[0]);
      this.lastMoved = { kind: 'building', bid: b.id, ids, delta, copied: !!d.data.copied };
      this.store.commit([b.id, ...ids], d.data.copied ? 'Copiado. Digite 5x para mais cópias.' : `Movido ${fmt(delta.length())} m.`, !!d.data.copied);
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
    if ((d.kind === 'extrude-side' || d.kind === 'extrude-top') && b) {
      const id = d.data.created as ID | undefined;
      this.store.commit([d.bid], id ? 'Volume extrudado.' : '');
      if (id) {
        this.toast('Volume extrudado: é um volume novo, editável.');
        this.select({ building: b.id, solids: [id] });
      }
      return;
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
      b = newBuilding({ name: `Edifício ${this.project.buildings.length + 1}`, position: [a.x, a.z], levels: levelsFor(1) , ...(activeLayer(this.project) ? { layer: activeLayer(this.project) } : {}) });
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
      b = newBuilding({ name: `Edifício ${this.project.buildings.length + 1}`, position: [pl.at.origin[0], pl.at.origin[1] + def.d / 2], levels: levelsFor(Math.max(1, def.levels)) , ...(activeLayer(this.project) ? { layer: activeLayer(this.project) } : {}) });
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
      return { b, host: { kind: 'face', solid: solid.id, edge: hit.face.edge!, u: s, y }, frame: faceMatrix(p, fr.u, fr.v, fr.n), label: `${fmt(s)} m ao longo · ${fmt(y + solid.base)} m de altura` };
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
    // Que material do volume cada tipo de face usa (pintar e conta-gotas).
    const edge = f.edge ? (f.edge.endsWith(':c') ? f.edge.slice(0, -2) : f.edge) : undefined;
    const slot = (k: string): 'wall' | 'roof' | 'trim' | 'base' | 'floor' | 'edge' =>
      k === 'roof' ? 'roof' : k === 'top' ? 'floor' : k === 'fascia' || k === 'soffit' || k === 'parapet' || k === 'coping' || k === 'band' || k === 'reveal' ? 'trim' : k === 'plinth' || k === 'bottom' ? 'base' : (k === 'side' || k === 'gable' || k === 'bevel') && edge ? 'edge' : 'wall';
    const where = slot(f.kind);
    if (e.altKey) {
      const ref = where === 'edge' ? (s.edges[edge!]?.material ?? s.materials.wall) : where === 'floor' ? (s.materials.floor ?? s.materials.base) : s.materials[where];
      this.paintMat = structuredClone(ref);
      this.toast('Material copiado para o balde.');
      this.emit();
      return;
    }
    this.change(b.id, (x) => {
      const so = findSolid(x, s.id)!;
      const m = structuredClone(this.paintMat);
      // Como no SketchUp: o clique pinta a face; Shift pinta as paredes do volume inteiro.
      if (where === 'edge' && e.shiftKey) {
        so.materials.wall = m;
        for (const es of Object.values(so.edges)) delete es.material;
      } else if (where === 'edge') (so.edges[edge!] ??= {}).material = m;
      else so.materials[where] = m;
    }, where === 'edge' && !e.shiftKey ? 'Face pintada (Shift pinta o volume todo).' : 'Pintado.');
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
        else if (k === 'k') this.command('palette');
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
      else if (k === 'k') this.toggleLibrary();
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
    this.shell.top.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => b.addEventListener('click', () => (this.topCommand?.(b.dataset.cmd!) ? undefined : this.command(b.dataset.cmd!))));
    this.shell.status.bar.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => b.addEventListener('click', () => this.command(b.dataset.cmd!)));
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
    const n = { id: uid(), family: base.family, name: base.name + ' (único)', params: { ...structuredClone(base.params), ...structuredClone(it.params) }, user: true, base: base.base ?? base.id };
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

/** O ponto, ou o mais perto dele dentro do polígono (recuado `inset`). */
function clampInside(p: Vec2, poly: Vec2[], inset: number): Vec2 {
  const inside = (q: Vec2) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!,
        b = poly[j]!;
      if (a[1] > q[1] !== b[1] > q[1] && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  if (inside(p)) return p;
  let best: Vec2 = p,
    bd = Infinity;
  let cx = 0,
    cz = 0;
  for (const q of poly) {
    cx += q[0] / poly.length;
    cz += q[1] / poly.length;
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!,
      b = poly[(i + 1) % poly.length]!;
    const abx = b[0] - a[0],
      abz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / (abx * abx + abz * abz || 1)));
    const q: Vec2 = [a[0] + abx * t, a[1] + abz * t];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  // Um pouco para dentro, em direção ao centro.
  const dx = cx - best[0],
    dz = cz - best[1],
    l = Math.hypot(dx, dz) || 1;
  return [best[0] + (dx / l) * inset, best[1] + (dz / l) * inset];
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
