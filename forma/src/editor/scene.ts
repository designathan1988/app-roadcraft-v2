// Cena do editor: renderizador, câmera orbital, iluminação, chão, grade,
// decoração, raios de seleção e alças. Funciona sozinha (cria tudo) ou
// hospedada no jogo (usa renderer/scene/camera do jogo e não roda laço próprio).
import { buildLOD, type BuiltLOD } from '../render/lod';
import type { MassPartsOptions } from '../geometry/mass-parts';
import * as THREE from 'three';
import type { Building, ID, Vec2 } from '../core/schema';
import type { PartData } from '../geometry/parts';
import { clamp, distanceToSegment, pointInPolygon } from '../geometry/polygon';
import { buildBuilding, type BuiltBuilding } from '../render/build-building';
import { createRenderContext } from '../render/context';
import { worldPolygon } from './ops';
import type { Project } from '../core/schema';
import type { LotIndices } from '../core/indices';
import { buildLotGroup, disposeLotGroup } from '../render/lot';

/** Raio de captura das alças, em pixels de tela. */
const HANDLE_PX = 12;
/** Diâmetro visível das alças, em pixels de tela. */
const HANDLE_DIAMETER = 12;

export interface SceneHost {
  renderer?: THREE.WebGLRenderer;
  scene?: THREE.Scene;
  camera?: THREE.PerspectiveCamera;
  /** Níveis de detalhe (LOD) por distância da câmera: menos draw calls em projetos grandes. */
  lod?: boolean;
}

export interface PickResult {
  hit: THREE.Intersection;
  data: PartData;
}

export interface HandleData {
  handle: true;
  kind: 'height' | 'resize' | 'vertex' | 'lotvertex' | 'node';
  id: ID;
  sx?: number;
  sz?: number;
  index?: number;
}

export class EditorScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly hosted: boolean;
  /** Raiz única que o editor adiciona à cena do jogo. */
  readonly root = new THREE.Group();
  readonly modelRoot = new THREE.Group();
  readonly gizmos = new THREE.Group();
  readonly sketch = new THREE.Group();
  readonly environment = new THREE.Group();
  /** Lotes e marcas de violação. */
  readonly lotsRoot = new THREE.Group();
  readonly ctx = createRenderContext();
  readonly built = new Map<ID, BuiltBuilding>();
  lodEnabled = false;
  readonly target = new THREE.Vector3(0, 4, 0);
  theta = 0.68;
  phi = 1.04;
  distance = 60;
  section = false;
  night = false;
  private dirty = true;
  private frameId = 0;
  private resizeObserver: ResizeObserver | null = null;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private sphereGeo = new THREE.SphereGeometry(0.18, 12, 8);
  private coneGeo = new THREE.ConeGeometry(0.18, 0.35, 8);
  private gizmoMat = new THREE.MeshBasicMaterial({ color: '#ee8b38', depthTest: false });
  private hemi?: THREE.HemisphereLight;
  private sun?: THREE.DirectionalLight;
  private grid?: THREE.GridHelper;
  private ground?: THREE.Mesh;
  /** Chamado quando a cena precisa ser desenhada (modo hospedado). */
  onInvalidate: (() => void) | null = null;
  /** Chamado quando a câmera ou o tamanho mudam (rótulos na tela). */
  onViewChange: (() => void) | null = null;
  /** Opções de geração por edifício (corte do pavimento ativo). */
  buildOptionsFor: ((b: Building) => MassPartsOptions) | null = null;

  constructor(
    private viewport: HTMLElement,
    host: SceneHost = {},
    private withEnvironment = !host.scene,
  ) {
    this.hosted = !!host.renderer;
    this.lodEnabled = !!host.lod;
    this.scene = host.scene ?? new THREE.Scene();
    this.camera = host.camera ?? new THREE.PerspectiveCamera(38, 1, 0.1, 500);
    if (host.renderer) this.renderer = host.renderer;
    else {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.75));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.shadowMap.autoUpdate = false;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.1;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      viewport.prepend(this.renderer.domElement);
      this.renderer.domElement.setAttribute('aria-label', 'Canvas 3D de construção');
    }
    this.root.name = 'FORMA-editor';
    this.modelRoot.name = 'FORMA';
    this.root.add(this.modelRoot, this.gizmos, this.sketch, this.environment, this.lotsRoot);
    this.scene.add(this.root);
    if (this.withEnvironment) this.setupEnvironment();
    if (!this.hosted) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(viewport);
      this.resize();
      const loop = () => {
        this.frameId = requestAnimationFrame(loop);
        if (this.dirty) {
          this.renderer.render(this.scene, this.camera);
          this.dirty = false;
        }
      };
      loop();
    }
    this.updateCamera();
  }

  private setupEnvironment(): void {
    const s = this.scene;
    s.background = new THREE.Color('#e9e8e3');
    s.fog = new THREE.Fog('#e9e8e3', 100, 220);
    this.hemi = new THREE.HemisphereLight('#f8f4e9', '#77786f', 2.1);
    this.sun = new THREE.DirectionalLight('#fff5e3', 3.2);
    this.sun.position.set(-30, 48, 25);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -65, right: 65, top: 65, bottom: -65, near: 0.5, far: 130 });
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.035;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshStandardMaterial({ color: '#deded5', roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.position.y = -0.04;
    this.root.add(this.hemi, this.sun, this.ground);
    this.setGrid(1);
  }

  setGrid(size: number): void {
    if (!this.withEnvironment) return;
    if (this.grid) {
      this.root.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    this.grid = new THREE.GridHelper(160, Math.round(160 / size), '#aeb4b1', '#c8ccc7');
    this.grid.position.y = 0.003;
    const m = this.grid.material as THREE.Material;
    m.opacity = 0.56;
    m.transparent = true;
    this.root.add(this.grid);
    this.mark();
  }

  setNight(on: boolean): void {
    this.night = on;
    if (!this.hemi || !this.sun) return;
    this.hemi.intensity = on ? 0.85 : 2.1;
    this.sun.intensity = on ? 1.3 : 3.2;
    this.sun.color.set(on ? '#d5e3ff' : '#fff5e3');
    (this.scene.background as THREE.Color).set(on ? '#a0abb6' : '#e9e8e3');
    this.scene.fog?.color.copy(this.scene.background as THREE.Color);
    this.renderer.shadowMap.needsUpdate = true;
    this.mark();
  }

  mark(): void {
    this.dirty = true;
    this.onInvalidate?.();
  }

  /** Desenha agora (exportar PNG). */
  renderNow(): void {
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const r = this.viewport.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.mark();
    this.onViewChange?.();
  }

  updateCamera(): void {
    this.phi = clamp(this.phi, 0.025, Math.PI / 2 - 0.015);
    this.distance = clamp(this.distance, 5, 230);
    const { target: t, distance: d, phi, theta } = this;
    this.camera.position.set(t.x + d * Math.sin(phi) * Math.sin(theta), t.y + d * Math.cos(phi), t.z + d * Math.sin(phi) * Math.cos(theta));
    this.camera.lookAt(t);
    this.camera.updateMatrixWorld();
    this.rescaleHandles();
    this.onViewChange?.();
    if (this.scene.fog instanceof THREE.Fog && this.withEnvironment) {
      this.scene.fog.near = Math.max(100, d * 1.4);
      this.scene.fog.far = Math.max(220, d * 3);
    }
    this.mark();
  }

  fitView(): void {
    if (!this.built.size) {
      this.target.set(0, 0, 0);
      this.distance = 45;
      this.theta = 0.7;
      this.phi = 1.08;
      this.updateCamera();
      return;
    }
    const b = new THREE.Box3().setFromObject(this.modelRoot),
      size = b.getSize(new THREE.Vector3()),
      center = b.getCenter(new THREE.Vector3());
    this.target.copy(center);
    this.target.y = Math.max(1, center.y * 0.65);
    this.distance = Math.max(size.x, size.z, size.y) * 1.95 + 12;
    this.theta = 0.68;
    this.phi = 1.06;
    this.updateCamera();
  }

  // ── Edifícios ───────────────────────────────────────────────────────
  rebuild(buildings: Building[], ids: ID[] | null = null): void {
    const want = ids ?? [...new Set([...this.built.keys(), ...buildings.map((b) => b.id)])];
    for (const id of want) {
      this.built.get(id)?.dispose();
      this.built.delete(id);
      const b = buildings.find((x) => x.id === id);
      if (!b) continue;
      const o = { context: this.ctx, section: this.section, ...(this.buildOptionsFor?.(b) ?? {}) };
      // Cortes (pavimento, seção) sempre com o detalhe completo.
      const built = this.lodEnabled && !o.section && o.cutY === undefined ? buildLOD(b, { ...o, distanceScale: [2.5, 1.3] }) : buildBuilding(b, o);
      this.modelRoot.add(built.group);
      this.built.set(id, built);
    }
    this.modelRoot.updateMatrixWorld(true);
    this.renderer.shadowMap.needsUpdate = true;
    this.mark();
  }

  /** Edifícios selecionados ficam sempre no detalhe completo (faces e alças precisas). */
  setDetailed(ids: Set<ID>): void {
    for (const [id, b] of this.built) {
      const lod = (b as BuiltLOD).lod;
      if (!lod) continue;
      lod.autoUpdate = !ids.has(id);
      if (ids.has(id)) (b as BuiltLOD).levels.forEach((l, i) => (l.visible = i === 0));
    }
    this.mark();
  }

  /** Redesenha os lotes; prédios em violação ganham contorno vermelho na base. */
  rebuildLots(project: Project, indices: Map<ID, LotIndices>, selectedLot: ID | null): void {
    for (const c of [...this.lotsRoot.children]) disposeLotGroup(c as THREE.Group);
    const bad = new Set<ID>();
    for (const lot of project.lots) {
      const ix = indices.get(lot.id);
      const violated = !!ix?.violations.length;
      for (const v of ix?.violations ?? []) if (v.kind === 'setback' || v.kind === 'outside') v.buildingIds.forEach((id) => bad.add(id));
      this.lotsRoot.add(buildLotGroup(lot, ix?.buildable ?? [], { selected: lot.id === selectedLot, violated }));
    }
    if (bad.size) {
      const g = new THREE.Group();
      for (const b of project.buildings) {
        if (!bad.has(b.id)) continue;
        for (const ring of worldPolygon(b)) {
          const pts = ring.map((p) => new THREE.Vector3(p[0], 0.05, p[1]));
          pts.push(pts[0]!.clone());
          const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#d0392b', depthTest: false }));
          l.renderOrder = 12;
          g.add(l);
        }
      }
      this.lotsRoot.add(g);
    }
    this.mark();
  }

  /** Lote sob o ponteiro (piso do lote). */
  pickLot(e: { clientX: number; clientY: number }): ID | null {
    const fills: THREE.Object3D[] = [];
    this.lotsRoot.traverse((o) => o.userData.part === 'lot' && fills.push(o));
    const hit = this.pointerRay(e).intersectObjects(fills, false)[0];
    return hit ? (hit.object.userData.lotId as ID) : null;
  }

  /** Árvores, piso e escada decorativos, omitidos onde colidem com volumes. */
  buildEnvironment(buildings: Building[], lots: { polygon: Vec2[] }[] = []): void {
    this.disposeGroup(this.environment);
    this.renderer.shadowMap.needsUpdate = true;
    this.mark();
    if (!this.withEnvironment || !buildings.length) return;
    const polys = buildings.map((b) => worldPolygon(b)[0]!);
    const lotPolys = lots.map((l) => l.polygon);
    const outsideLots = (x: number, z: number, r: number) => lotPolys.every((p) => !pointInPolygon(x, z, p) && p.every((a, i) => distanceToSegment(x, z, a, p[(i + 1) % p.length]!) >= r));
    const free = (x: number, z: number, r: number) =>
      outsideLots(x, z, r) &&
      polys.every((p) => !pointInPolygon(x, z, p) && p.every((a, i) => distanceToSegment(x, z, a, p[(i + 1) % p.length]!) >= r));
    const mat = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
    const box = (size: [number, number, number], pos: [number, number, number], m: THREE.Material) => {
      const mesh = new THREE.Mesh(this.ctx.boxGeometry, m);
      mesh.scale.set(...size);
      mesh.position.set(...pos);
      mesh.castShadow = mesh.receiveShadow = true;
      this.environment.add(mesh);
    };
    const pathMat = mat('#bfbfb5');
    // O piso do exemplo só aparece sem lotes: com lotes, o terreno é deles.
    if (!lots.length) box([34, 0.1, 28], [0, 0.015, 0], pathMat);
    for (const [x, z, s] of [[-4, -0.5, 1.8], [3, 2, 1.5], [-2, 5, 1.3], [-16, 9, 1.4], [17, -4, 1.6], [-15, -11, 1.1]] as const) {
      if (!free(x, z, Math.max(1.8, 1.25 * s))) continue;
      box([2.5, 0.28, 2.5], [x, 0.2, z], mat('#8d8f7a'));
      this.tree(x, 0.34, z, s);
    }
    if (!lots.length && free(-3.45, 13, 1.8)) for (let i = 0; i < 3; i++) box([0.38, 0.15, 3], [-3 - i * 0.45, 0.2 + i * 0.15, 13], pathMat);
    if (!lots.length && free(0, 14, 3.1)) box([6, 0.12, 0.6], [0, 0.06, 14], pathMat);
  }

  private tree(x: number, y: number, z: number, s: number): void {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.13 * s, 1.5 * s, 7), new THREE.MeshStandardMaterial({ color: '#6b6150', roughness: 0.8 }));
    trunk.position.set(x, y + 0.75 * s, z);
    trunk.castShadow = true;
    this.environment.add(trunk);
    const leaf = new THREE.MeshStandardMaterial({ color: '#7b8661', roughness: 0.8 });
    for (let i = 0; i < 4; i++) {
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75 * s, 1), leaf);
      crown.scale.set(1, 1.2, 0.9);
      crown.position.set(x + Math.cos(i * 2) * 0.25 * s, y + (1.65 + i * 0.28) * s, z + Math.sin(i * 2) * 0.22 * s);
      crown.castShadow = true;
      this.environment.add(crown);
    }
  }

  /** Libera geometrias e materiais do grupo, exceto os compartilhados. */
  disposeGroup(group: THREE.Object3D): void {
    const keep = new Set<unknown>([this.ctx.boxGeometry, this.sphereGeo, this.coneGeo, this.gizmoMat]);
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !keep.has(m.geometry)) m.geometry.dispose();
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const x of mats) if (!keep.has(x) && !this.ctx.owns(x)) x.dispose();
    });
    group.clear();
  }

  // ── Raios ───────────────────────────────────────────────────────────
  pointerRay(e: { clientX: number; clientY: number }): THREE.Raycaster {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, (-(e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    return this.raycaster;
  }

  planePoint(e: { clientX: number; clientY: number }, y = 0): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    return this.pointerRay(e).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null;
  }

  /**
   * Alça sob o ponteiro. As esferas têm poucos pixels na tela, então vale a
   * mais próxima num raio de HANDLE_PX pixels (alvo confortável para o mouse).
   */
  pickHandle(e: { clientX: number; clientY: number }, px = HANDLE_PX): HandleData | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best: { d: number; data: HandleData } | null = null;
    for (const o of this.gizmos.children) {
      if (!o.userData.handle) continue;
      v.copy(o.position).project(this.camera);
      if (v.z > 1) continue;
      const sx = r.left + (v.x * 0.5 + 0.5) * r.width,
        sy = r.top + (-0.5 * v.y + 0.5) * r.height;
      const d = Math.hypot(sx - e.clientX, sy - e.clientY);
      if (d <= px && (!best || d < best.d)) best = { d, data: o.userData as HandleData };
    }
    return best ? best.data : null;
  }

  pick(e: { clientX: number; clientY: number }): PickResult | null {
    const hits = this.pointerRay(e).intersectObjects(this.modelRoot.children, true);
    for (const hit of hits) {
      // Níveis de LOD ocultos também são atingidos pelo raio: ignora.
      let shown = true;
      for (let v: THREE.Object3D | null = hit.object; v && v !== this.modelRoot; v = v.parent) if (!v.visible) shown = false;
      if (!shown) continue;
      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.buildingId) o = o.parent;
      const built = o ? this.built.get(o.userData.buildingId as ID) : undefined;
      const data = built?.pick(hit);
      if (data) return { hit, data };
    }
    return null;
  }

  worldToScreen(p: THREE.Vector3): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect(),
      v = p.clone().project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * r.width, y: (-0.5 * v.y + 0.5) * r.height };
  }

  // ── Alças e contornos ───────────────────────────────────────────────
  line(points: THREE.Vector3[], color = '#f09b56', closed = false, parent: THREE.Group = this.gizmos): THREE.Line {
    const p = closed ? [...points, points[0]!] : points;
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
    l.renderOrder = 10;
    parent.add(l);
    return l;
  }

  handle(pos: THREE.Vector3, data: Omit<HandleData, 'handle'>): void {
    const m = new THREE.Mesh(this.sphereGeo, this.gizmoMat);
    m.position.copy(pos);
    m.userData = { handle: true, ...data };
    m.renderOrder = 20;
    this.gizmos.add(m);
    this.rescaleHandle(m);
  }

  /** Mantém a alça com HANDLE_DIAMETER pixels na tela, em qualquer zoom. */
  private rescaleHandle(o: THREE.Object3D): void {
    const h = this.renderer.domElement.clientHeight || 600;
    const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.camera.position.distanceTo(o.position)) / h;
    o.scale.setScalar((HANDLE_DIAMETER / 2) * worldPerPx / 0.18);
  }

  private rescaleHandles(): void {
    for (const o of this.gizmos.children) if (o.userData.handle) this.rescaleHandle(o);
  }

  cone(pos: THREE.Vector3): void {
    const c = new THREE.Mesh(this.coneGeo, this.gizmoMat);
    c.position.copy(pos);
    c.position.y += 0.25;
    c.renderOrder = 20;
    this.gizmos.add(c);
  }

  /** Converte ponto local do edifício (planta + y absoluto) para o mundo. */
  toWorld(b: Building, p: Vec2, y: number): THREE.Vector3 {
    const g = this.built.get(b.id)?.group;
    const v = new THREE.Vector3(p[0], y, p[1]);
    return g ? v.applyMatrix4(g.matrixWorld) : v;
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    for (const b of this.built.values()) b.dispose();
    this.built.clear();
    this.disposeGroup(this.gizmos);
    this.disposeGroup(this.sketch);
    this.disposeGroup(this.environment);
    for (const c of [...this.lotsRoot.children]) disposeLotGroup(c as THREE.Group);
    for (const o of [this.ground, this.grid]) {
      if (!o) continue;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.sphereGeo.dispose();
    this.coneGeo.dispose();
    this.gizmoMat.dispose();
    this.ctx.dispose();
    this.root.removeFromParent();
    if (!this.hosted) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
  }
}
