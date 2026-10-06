import {
  ACESFilmicToneMapping, CircleGeometry, Color, MeshBasicMaterial, Raycaster, RingGeometry, Vector2, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial,
  PCFSoftShadowMap, PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HumanBase, type HumanBaseMeta } from '@people/gen/humanBase';
import { createHumanMesh, disposeHumanMesh, loadHumanTextures, updateHumanMesh, type TextureSet } from './humanMesh';

/**
 * The human generator's 3D view: a studio (warm key light from the front
 * left, cool fill, rim from behind, a soft room reflection) and the people.
 * The people stand in one row, every base's in turn.
 */

export type GeneratorView = 'front' | 'side' | 'back' | 'face';

export interface LoadedBase {
  readonly name: string;
  readonly base: HumanBase;
  readonly tex: TextureSet;
}

const SPACING = 0.8;

/** One person to draw: their shaped body, its scale, skin and eyes. */
export interface DrawnPerson {
  readonly shape: Float32Array;
  readonly scale: number;
  readonly melanin: number;
  readonly iris: number;
}

export async function loadBase(name: string, urlOf: (file: string) => string): Promise<LoadedBase> {
  const [meta, bin] = await Promise.all([
    fetch(urlOf('base.json')).then((r) => r.json() as Promise<HumanBaseMeta>),
    fetch(urlOf('base.bin')).then((r) => r.arrayBuffer()),
  ]);
  const base = new HumanBase(meta, bin);
  return { name, base, tex: await loadHumanTextures(base, urlOf) };
}

export class GeneratorStage {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.05, 100);
  private readonly controls: OrbitControls;
  private readonly people = new Group();
  private view: GeneratorView = 'front';
  private readonly marker: Mesh;
  private selected = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const renderer = new WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer = renderer;

    const scene = this.scene;
    scene.background = new Color(0x3a3d42);
    scene.environment = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;
    scene.add(new HemisphereLight(0xdfe6f0, 0x4a4540, 0.6));
    const key = new DirectionalLight(0xfff0e0, 2.4);
    key.position.set(-3, 5, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -6, right: 6, top: 4, bottom: -1 });
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.01;
    scene.add(key);
    const fill = new DirectionalLight(0xd8e4ff, 0.7);
    fill.position.set(5, 3, 4);
    scene.add(fill);
    const rim = new DirectionalLight(0xffffff, 1.2);
    rim.position.set(0, 4, -6);
    scene.add(rim);
    const floor = new Mesh(new CircleGeometry(12, 64), new MeshStandardMaterial({ color: 0x55585e, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    scene.add(this.people);
    // The selected person's ring on the floor.
    this.marker = new Mesh(new RingGeometry(0.3, 0.34, 48), new MeshBasicMaterial({ color: 0x7fd4ff }));
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.position.y = 0.002;
    scene.add(this.marker);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    // Drawn only when something changes (three.js manual, "Rendering on
    // Demand"): a still page costs nothing. While the orbit glides to a
    // stop, `update()` keeps reporting changes and so keeps asking.
    this.controls.addEventListener('change', () => this.redraw());
    this.resize();
  }

  private pending = false;

  /** Asks for one frame; several asks before it is drawn make one frame. */
  redraw(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.redraw();
  }

  /** Replaces the row with these people. */
  setPeople(b: LoadedBase, people: readonly DrawnPerson[]): void {
    for (const child of [...this.people.children]) { disposeHumanMesh(child as Mesh); this.people.remove(child); }
    people.forEach((p, slot) => {
      const mesh = createHumanMesh(b.base, b.tex, p.shape, { melanin: p.melanin, flatSkin: new Color(0xd0a080), iris: new Color(p.iris) });
      mesh.scale.setScalar(p.scale);
      mesh.userData['slot'] = { slot };
      this.people.add(mesh);
    });
    this.setView(this.view);
  }

  /** Reshapes one person in place. */
  updatePerson(b: LoadedBase, slot: number, p: DrawnPerson): void {
    const mesh = this.people.children[slot] as Mesh | undefined;
    if (!mesh) return;
    updateHumanMesh(mesh, b.base, p.shape, p.melanin);
    mesh.scale.setScalar(p.scale);
    this.setView(this.view);
  }

  select(slot: number): void {
    this.selected = slot;
    this.setView(this.view);
  }

  /** The person under a screen point (CSS px in the canvas), or null. */
  pick(x: number, y: number): number | null {
    const ndc = new Vector2((x / this.canvas.clientWidth) * 2 - 1, -(y / this.canvas.clientHeight) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.people.children.filter((p) => p.visible), false)[0];
    return hit ? (hit.object.userData['slot'] as { slot: number }).slot : null;
  }

  private placeMarker(): void {
    const p = this.people.children[this.selected];
    this.marker.visible = !!p && this.view !== 'face';
    if (p) this.marker.position.x = p.position.x;
  }

  /** One person with exactly these morph weights, alone in the middle (probes). */
  showWeights(b: LoadedBase, weights: Readonly<Record<string, number>>, melanin = 0.2): void {
    for (const child of [...this.people.children]) { disposeHumanMesh(child as Mesh); this.people.remove(child); }
    const mesh = createHumanMesh(b.base, b.tex, b.base.shape(weights), { melanin, flatSkin: new Color(0xd0a080), iris: new Color(0x506070) });
    mesh.userData['slot'] = { slot: 0 };
    this.people.add(mesh);
    this.setView(this.view);
  }

  setView(view: GeneratorView): void {
    this.view = view;
    const turn = view === 'side' ? Math.PI / 2 : view === 'back' ? Math.PI : 0;
    let top = 0;
    const count = this.people.children.length;
    for (const p of this.people.children) {
      const { slot } = p.userData['slot'] as { slot: number };
      p.rotation.y = turn;
      // Close up, the selected person alone.
      p.visible = view !== 'face' || slot === this.selected;
      p.position.x = view === 'face' ? 0 : (slot - (count - 1) / 2) * SPACING;
      if (p.visible) {
        const g = (p as Mesh).geometry;
        g.computeBoundingBox();
        top = Math.max(top, g.boundingBox!.max.y * p.scale.y);
      }
    }
    this.placeMarker();
    if (view === 'face') {
      this.controls.target.set(-0.12, top - 0.13, 0);
      this.camera.position.set(-0.12, top - 0.11, 0.85);
    } else {
      // The row is framed right of the controls panel (a quarter of a
      // 1280-wide screen): the camera looks a little left of its middle.
      this.controls.target.set(-1.1, 0.95, 0);
      this.camera.position.set(-1.1, 1.25, 10.5);
    }
    this.redraw();
  }

  /** Puts the camera at `eye` looking at `target` (probes and close-ups). */
  look(eye: readonly [number, number, number], target: readonly [number, number, number]): void {
    this.camera.position.set(...eye);
    this.controls.target.set(...target);
    this.redraw();
  }

  /** Screen x (CSS px) of each person's feet, in row order (for labels). */
  screenXs(): number[] {
    const w = this.canvas.clientWidth;
    return this.people.children.filter((p) => p.visible)
      .map((p) => (new Vector3(p.position.x, 0, 0).project(this.camera).x * 0.5 + 0.5) * w);
  }
}
