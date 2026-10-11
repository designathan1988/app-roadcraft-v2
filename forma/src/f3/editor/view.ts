// Vista 3D do editor: renderizador, câmera orbital (botão direito gira, do
// meio ou Shift+direito desloca, roda aproxima no cursor), ambiente, desenho
// dos edifícios com cache por revisão e seleção por raio.
import * as THREE from 'three';
import type { Building3, ID, Project3 } from '../model/schema';
import { evaluateBuilding, type Evaluated } from '../eval/evaluate';
import type { FaceInfo } from '../eval/faces';
import type { PartTag } from '../eval/parts';
import { buildShellMesh, type ShellMesh } from '../render/shell';
import { buildPartsMesh, type PartsMesh } from '../render/parts';
import type { RenderContext } from '../../render/context';
import { createLook, createLookContext, type Look } from '../render/look';
import { onPbrLoad, setPbrAnisotropy } from '../render/pbr';
import { onProcBaked, setProcRenderer } from '../render/procedural';
import { onImageLoad, setProjectImages } from '../render/images';
import { buildingHidden, buildingLocked, categoryHidden, itemHidden, itemLocked, solidHidden, solidLocked, visibilityKeys } from '../model/layers';
import { family } from '../families/index';

export interface Built {
  revision: number;
  /** Camadas visíveis quando foi avaliado / categorias quando as peças foram montadas. */
  visSolids: string;
  visParts: string;
  group: THREE.Group;
  ev: Evaluated;
  shell: ShellMesh;
  parts: PartsMesh;
}

export interface Hit {
  building: Building3;
  point: THREE.Vector3;
  /** Normal no mundo. */
  normal: THREE.Vector3;
  face?: FaceInfo;
  part?: PartTag;
}

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1200);
  readonly ctx: RenderContext = createLookContext();
  readonly look: Look;
  readonly root = new THREE.Group();
  readonly overlay = new THREE.Group();
  readonly built = new Map<ID, Built>();
  private unPbr: () => void = () => undefined;
  private unProc: () => void = () => undefined;
  private unImg: () => void = () => undefined;
  readonly target = new THREE.Vector3(0, 3, 0);
  theta = 0.75;
  phi = 1.0;
  distance = 55;
  private grid: THREE.GridHelper;
  private ground: THREE.Mesh;
  private dirty = true;
  private raf = 0;
  private ray = new THREE.Raycaster();
  /** Avaliação feita (para medir). */
  lastEvalMs = 0;
  onRender: (() => void) | null = null;
  onCamera: (() => void) | null = null;

  constructor(readonly el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.domElement.className = 'f3-canvas';
    el.prepend(this.renderer.domElement);
    this.look = createLook(this.renderer, this.scene, this.camera);
    // Texturas PBR: filtro anisotrópico máximo da placa e redesenho quando chegam.
    setPbrAnisotropy(Math.min(16, this.renderer.capabilities.getMaxAnisotropy()));
    setProcRenderer(this.renderer, Math.min(16, this.renderer.capabilities.getMaxAnisotropy()));
    this.unImg = onImageLoad(() => this.mark());
    this.unProc = onProcBaked(() => {
      this.renderer.shadowMap.needsUpdate = true;
      this.mark();
    });
    this.unPbr = onPbrLoad(() => {
      this.renderer.shadowMap.needsUpdate = true;
      this.mark();
    });
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(900, 64), new THREE.MeshStandardMaterial({ color: '#d8d5ca', roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.02;
    this.ground.receiveShadow = true;
    this.ground.name = 'chão';
    this.grid = this.makeGrid(1);
    this.scene.add(this.ground, this.grid, this.root, this.overlay);
    this.overlay.renderOrder = 10;
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.updateCamera();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (!this.dirty) return;
      this.dirty = false;
      this.look.render();
      this.onRender?.();
    };
    loop();
  }

  private makeGrid(step: number): THREE.GridHelper {
    const g = new THREE.GridHelper(240, Math.round(240 / step), '#a9aca4', '#c4c4ba');
    const m = g.material as THREE.Material;
    m.transparent = true;
    m.opacity = 0.32;
    m.depthWrite = false;
    g.position.y = 0.002;
    return g;
  }

  setGrid(step: number): void {
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.grid = this.makeGrid(step);
    this.scene.add(this.grid);
    this.mark();
  }

  mark(): void {
    this.dirty = true;
  }

  resize(): void {
    const r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.look?.setSize(r.width, r.height);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.mark();
    this.onCamera?.();
  }

  updateCamera(): void {
    this.phi = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, this.phi));
    this.distance = Math.max(2, Math.min(600, this.distance));
    const { target: t, distance: d, phi, theta } = this;
    this.camera.position.set(t.x + d * Math.sin(phi) * Math.sin(theta), t.y + d * Math.cos(phi), t.z + d * Math.sin(phi) * Math.cos(theta));
    this.camera.lookAt(t);
    this.camera.updateMatrixWorld();
    // Sombra acompanha o centro da vista.
    this.look?.follow(new THREE.Vector3(t.x, 0, t.z), d * 0.9 + 20);
    this.mark();
    this.onCamera?.();
  }

  /** Enquadra uma caixa (ou tudo). */
  frame(box?: THREE.Box3): void {
    const b = box ?? new THREE.Box3().setFromObject(this.root);
    if (b.isEmpty()) {
      this.target.set(0, 3, 0);
      this.distance = 55;
    } else {
      const c = b.getCenter(new THREE.Vector3()),
        s = b.getSize(new THREE.Vector3());
      this.target.copy(c);
      this.target.y = Math.max(1, c.y * 0.6);
      this.distance = Math.max(s.x, s.y * 1.3, s.z) * 1.5 + 12;
    }
    this.updateCamera();
  }

  // ── Edifícios ────────────────────────────────────────────────────────
  /** Recalcula e redesenha o que mudou. */
  sync(p: Project3, revisions: Map<ID, number>, preview = new Set<ID>()): void {
    let changed = false;
    const t0 = performance.now();
    const vis = visibilityKeys(p);
    setProjectImages(p.images);
    const partVisible = (b: Building3) => (tag: PartTag) => {
      const f = family(tag.family);
      if (f && categoryHidden(p, f.category)) return false;
      const it = tag.item ? b.items.find((x) => x.id === tag.item) : undefined;
      return !(it && itemHidden(p, it));
    };
    for (const b of p.buildings) {
      const rev = revisions.get(b.id) ?? 0;
      const cur = this.built.get(b.id);
      if (cur && cur.revision === rev && cur.visSolids === vis.solids) {
        cur.group.position.set(b.position[0], 0, b.position[1]);
        cur.group.rotation.y = (b.rotation * Math.PI) / 180;
        cur.group.visible = !buildingHidden(p, b);
        if (cur.visParts !== vis.parts) {
          // Só as categorias mudaram: remonta as peças, sem refazer as booleanas.
          cur.parts.dispose();
          cur.parts.group.removeFromParent();
          cur.parts = buildPartsMesh(cur.ev.parts, this.ctx, true, partVisible(b));
          cur.group.add(cur.parts.group);
          cur.visParts = vis.parts;
          changed = true;
        }
        continue;
      }
      cur && this.drop(cur);
      const ev = evaluateBuilding(b, { preview: preview.has(b.id), hidden: (s) => solidHidden(p, s) }, p);
      const shell = buildShellMesh(b, ev, this.ctx);
      const parts = buildPartsMesh(ev.parts, this.ctx, true, partVisible(b));
      const group = new THREE.Group();
      group.name = b.name;
      group.userData = { buildingId: b.id };
      group.position.set(b.position[0], 0, b.position[1]);
      group.rotation.y = (b.rotation * Math.PI) / 180;
      group.add(shell.mesh, parts.group);
      group.visible = !buildingHidden(p, b);
      this.root.add(group);
      this.built.set(b.id, { revision: rev, visSolids: vis.solids, visParts: vis.parts, group, ev, shell, parts });
      changed = true;
    }
    for (const [id, b] of this.built)
      if (!p.buildings.some((x) => x.id === id)) {
        this.drop(b);
        this.built.delete(id);
        changed = true;
      }
    if (changed) this.lastEvalMs = performance.now() - t0;
    // Qualquer mudança (até só mover um edifício) refaz a sombra.
    this.renderer.shadowMap.needsUpdate = true;
    this.root.updateMatrixWorld(true);
    this.mark();
  }

  private drop(b: Built): void {
    b.group.removeFromParent();
    b.shell.dispose();
    b.parts.dispose();
  }

  // ── Raios ────────────────────────────────────────────────────────────
  rayFrom(e: { clientX: number; clientY: number }): THREE.Raycaster {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    return this.ray;
  }

  /** Ponto no plano horizontal y. */
  onPlane(e: { clientX: number; clientY: number }, y = 0): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    return this.rayFrom(e).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null;
  }

  /** Primeiro edifício sob o ponteiro (casca ou componente). */
  pick(p: Project3, e: { clientX: number; clientY: number }, only?: ID | null): Hit | null {
    const ray = this.rayFrom(e);
    const groups = [...this.built.entries()].filter(([id]) => (!only || id === only) && this.built.get(id)!.group.visible).map(([, b]) => b.group);
    const hits = ray.intersectObjects(groups, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.buildingId) o = o.parent;
      if (!o) continue;
      const id = o.userData.buildingId as ID;
      const b = p.buildings.find((x) => x.id === id);
      const built = this.built.get(id);
      if (!b || !built) continue;
      // Travado (cadeado): aparece, mas o clique passa direto.
      if (buildingLocked(p, b)) continue;
      const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      if (h.object === built.shell.mesh && h.faceIndex !== undefined && h.faceIndex !== null) {
        const fi = built.shell.faceOf[h.faceIndex];
        const fs = fi !== undefined ? b.solids.find((x) => x.id === built.ev.faces[fi]?.solid) : undefined;
        if (fs && solidLocked(p, fs)) continue;
        return { building: b, point: h.point.clone(), normal, face: fi !== undefined ? built.ev.faces[fi] : undefined };
      }
      const tag = built.parts.pick(h);
      const ti = tag?.item ? b.items.find((x) => x.id === tag.item) : undefined;
      if (ti && itemLocked(p, ti)) continue;
      return { building: b, point: h.point.clone(), normal, ...(tag ? { part: tag } : {}) };
    }
    return null;
  }

  toScreen(p: THREE.Vector3): { x: number; y: number; behind: boolean } {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = p.clone().project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * r.width, y: (-v.y * 0.5 + 0.5) * r.height, behind: v.z > 1 };
  }

  /** Metros por pixel a uma distância (para alças de tamanho fixo na tela). */
  worldPerPixel(at: THREE.Vector3): number {
    const h = this.renderer.domElement.clientHeight || 600;
    return (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.camera.position.distanceTo(at)) / h;
  }

  /** Matriz do edifício (local → mundo). */
  buildingMatrix(b: Building3): THREE.Matrix4 {
    return new THREE.Matrix4().compose(new THREE.Vector3(b.position[0], 0, b.position[1]), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (b.rotation * Math.PI) / 180), new THREE.Vector3(1, 1, 1));
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.unPbr();
    this.unProc();
    this.unImg();
    for (const b of this.built.values()) this.drop(b);
    this.built.clear();
    this.look.dispose();
    this.ctx.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
