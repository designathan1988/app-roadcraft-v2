import {
  ACESFilmicToneMapping, CanvasTexture, CircleGeometry, Color, CylinderGeometry, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial, ShaderMaterial,
  NoColorSpace, PCFSoftShadowMap, PerspectiveCamera, type Material, type Texture, PMREMGenerator, Raycaster, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HumanBase, type HumanBaseMeta } from '@people/gen/humanBase';
import type { Focus } from '@people/gen/catalog';
import type { GarmentMesh } from '@people/gen/clothes';
import type { StrandSet } from '@people/gen/hair';
import type { EarringParams, GlassesParams } from '@people/gen/accessories';
import { earrings, glasses } from './accessories';
import { garmentObject } from './fabric';
import type { FaceAnchors } from '@people/gen/extras';
import { createHumanMesh, disposeHumanMesh, loadHumanTextures, setIris, updateHumanMesh, type SkinUniforms, type TextureSet } from './humanMesh';
import { HairShadow, strandMaterial, strandMesh, type StrandLook } from './strands';

/** What a person wears and grows: hair, brows, lashes, clothes, and the skin's make-up. */
export interface Dressing {
  readonly hair: StrandSet;
  readonly hairLook: StrandLook;
  readonly brows: StrandSet;
  readonly browLook: StrandLook;
  readonly lashes: StrandSet;
  readonly lashLook: StrandLook;
  readonly garments: readonly GarmentMesh[];
  readonly skin: {
    readonly undertone: number; readonly lipColour: number; readonly lipAmount: number;
    readonly stubble: number; readonly stubbleColour: number; readonly follicleColour: number;
  };
}

/**
 * The creator's 3D view: one person on a pedestal in a studio (warm key light
 * from the front left, cool fill, rim from behind, a soft room reflection).
 * The camera glides to the part being edited (`frame`), as The Sims' Create a
 * Sim zooms to a feature; a drag turns the view round the person. The frame
 * keeps the person in the middle of the screen's free area, between the
 * interface's side panels (`setInsets`).
 */

export interface LoadedBase {
  readonly name: string;
  readonly base: HumanBase;
  readonly tex: TextureSet;
}

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

/** Landmarks of the drawn person, in the scene (metres). */
interface Landmarks { height: number; eyes: Vector3; mouth: Vector3; headHalfWidth: number }

/** How each focus frames: target, view direction (azimuth, rad) and half the height shown. */
function shot(f: Focus, m: Landmarks): { target: Vector3; azimuth: number; half: number } {
  const H = m.height, k = m.headHalfWidth / 0.075;
  switch (f) {
    case 'torso': return { target: new Vector3(0, H * 0.64, 0), azimuth: 0.25, half: H * 0.22 };
    case 'arms': return { target: new Vector3(0, H * 0.62, 0), azimuth: 0.5, half: H * 0.3 };
    case 'legs': return { target: new Vector3(0, H * 0.27, 0), azimuth: 0.3, half: H * 0.3 };
    case 'head': return { target: new Vector3(0, m.eyes.y - 0.02 * k, m.eyes.z - 0.04 * k), azimuth: 0.35, half: 0.15 * k };
    case 'eyes': return { target: new Vector3(0, m.eyes.y, m.eyes.z), azimuth: 0.15, half: 0.075 * k };
    case 'nose': return { target: new Vector3(0, (m.eyes.y + m.mouth.y) / 2, m.eyes.z + 0.01 * k), azimuth: 0.6, half: 0.085 * k };
    case 'mouth': return { target: new Vector3(0, m.mouth.y - 0.012 * k, m.mouth.z), azimuth: 0.3, half: 0.07 * k };
    case 'ears': return { target: new Vector3(m.headHalfWidth, m.eyes.y - 0.02 * k, m.eyes.z - 0.09 * k), azimuth: 1.45, half: 0.07 * k };
    case 'chin': return { target: new Vector3(0, m.mouth.y - 0.03 * k, m.mouth.z - 0.03 * k), azimuth: 0.55, half: 0.085 * k };
    default: return { target: new Vector3(0, H * 0.52, 0), azimuth: 0.2, half: H * 0.58 };
  }
}

export class CreatorStage {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.02, 100);
  private readonly controls: OrbitControls;
  private person: Mesh | null = null;
  /** The person's hair, brows, lashes and clothes, in the body's frame. */
  private worn = new Group();
  private lift = 0;
  private readonly strandMats: { hair: ShaderMaterial; brows: ShaderMaterial; lashes: ShaderMaterial };
  /** The hair's opacity map from the key light, redrawn before the next frame when the hair or body moves. */
  private readonly hairShadow: HairShadow;
  private shadowStale = false;
  private focus: Focus = 'body';
  private insets: [number, number] = [0, 0];
  private glide: { from: [Vector3, Vector3]; to: [Vector3, Vector3]; t0: number } | null = null;
  private pending = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const renderer = new WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer = renderer;

    const scene = this.scene;
    scene.background = new Color(0x2f3237);
    scene.environment = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;
    scene.add(new HemisphereLight(0xdfe6f0, 0x4a4540, 0.6));
    const key = new DirectionalLight(0xfff0e0, 2.4);
    key.position.set(-3, 5, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2.5, bottom: -0.5 });
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.01;
    scene.add(key);
    const fill = new DirectionalLight(0xd8e4ff, 0.7);
    fill.position.set(5, 3, 4);
    scene.add(fill);
    const rim = new DirectionalLight(0xffffff, 1.2);
    rim.position.set(0, 4, -6);
    scene.add(rim);
    const lights = {
      dirs: [key.position.clone(), fill.position.clone(), rim.position.clone()],
      colours: [key.color.clone().multiplyScalar(key.intensity * 0.55), fill.color.clone().multiplyScalar(fill.intensity * 0.55), rim.color.clone().multiplyScalar(rim.intensity * 0.55)],
      ambient: new Color(0x8a8f99).multiplyScalar(0.55),
    };
    this.hairShadow = new HairShadow(key.position.clone());
    const shadow = this.hairShadow.uniforms;
    this.strandMats = { hair: strandMaterial(lights, shadow), brows: strandMaterial(lights, shadow), lashes: strandMaterial(lights, shadow) };
    const floor = new Mesh(new CircleGeometry(14, 64), new MeshStandardMaterial({ color: 0x45484e, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.06;
    floor.receiveShadow = true;
    scene.add(floor);
    const pedestal = new Mesh(new CylinderGeometry(0.55, 0.58, 0.06, 64), new MeshStandardMaterial({ color: 0x6b6f76, roughness: 0.6 }));
    pedestal.position.y = -0.03;
    pedestal.receiveShadow = true;
    scene.add(pedestal);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.75;
    // Drawn only when something changes (three.js manual, "Rendering on Demand").
    this.controls.addEventListener('change', () => this.redraw());
    this.controls.addEventListener('start', () => { this.glide = null; });
    this.resize();
  }

  /** Asks for one frame; several asks before it is drawn make one frame. */
  redraw(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (this.glide) {
        const t = Math.min(1, (performance.now() - this.glide.t0) / 380);
        const e = t * t * (3 - 2 * t);
        this.camera.position.lerpVectors(this.glide.from[0], this.glide.to[0], e);
        this.controls.target.lerpVectors(this.glide.from[1], this.glide.to[1], e);
        if (t >= 1) this.glide = null; else this.redraw();
      }
      this.controls.update();
      this.updateShadow();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private updateShadow(): void {
    if (!this.shadowStale) return;
    this.shadowStale = false;
    const hair = this.layers.get('hair')?.[0] ?? null;
    const u = hair ? (hair.material as ShaderMaterial).uniforms : null;
    this.hairShadow.update(this.renderer, hair, u?.['rootWidth']!.value as number, u?.['tipWidth']!.value as number);
  }

  /** Screen pixels the interface covers on the left and right: the person is framed between them. */
  setInsets(left: number, right: number): void {
    this.insets = [left, right];
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    // Strands are at least half a pixel wide: of the canvas's drawn pixels.
    const rows = this.renderer.getDrawingBufferSize(new Vector2()).y;
    for (const m of Object.values(this.strandMats)) m.uniforms['pixelRows']!.value = rows;
    this.camera.aspect = w / h;
    // Shift the image so its centre is the free area's centre.
    const shift = (this.insets[0] - this.insets[1]) / 2;
    this.camera.setViewOffset(w, h, -shift, 0, w, h);
    this.camera.updateProjectionMatrix();
    this.redraw();
  }

  setPerson(b: LoadedBase, p: DrawnPerson, masks?: Float32Array): void {
    if (this.person) { disposeHumanMesh(this.person); this.scene.remove(this.person); }
    this.person = createHumanMesh(b.base, b.tex, p.shape, { melanin: p.melanin, flatSkin: new Color(0xd0a080), iris: new Color(p.iris), hairShadow: this.hairShadow.uniforms }, masks);
    this.person.scale.setScalar(p.scale);
    this.person.add(this.worn);
    this.place();
    this.scene.add(this.person);
    this.frame(this.focus, false);
  }

  /** The worn things follow the body's shift to the floor; shoes lift the person. */
  private place(): void {
    if (!this.person) return;
    this.worn.position.y = -(this.person.userData['floor'] as number ?? 0);
    this.person.position.y = this.lift * this.person.scale.y;
    this.shadowStale = true;
  }

  private readonly layers = new Map<string, Mesh[]>();

  /** Replaces one worn layer ('hair', 'brows', 'lashes', 'clothes') with these meshes. */
  private setLayer(name: string, meshes: Mesh[]): void {
    for (const m of this.layers.get(name) ?? []) {
      m.geometry.dispose();
      if (!(m.material instanceof ShaderMaterial)) (m.material as { dispose(): void }).dispose();
      this.worn.remove(m);
    }
    for (const m of meshes) this.worn.add(m);
    this.layers.set(name, meshes);
    if (name === 'hair') this.shadowStale = true;
    this.redraw();
  }

  strands(name: 'hair' | 'brows' | 'lashes', set: StrandSet, look: StrandLook): void {
    this.setLayer(name, set.counts.length ? [strandMesh(set, look, this.strandMats[name])] : []);
  }

  private readonly follicleCanvases = new Map<number, { canvas: HTMLCanvasElement; texture: CanvasTexture }>();

  /**
   * The scalp's follicle map (Unreal's groom "follicle mask"): a dot on the
   * skin's texture where each strand of hair leaves it, so the scalp between
   * strands is skin with hair roots, never painted the hair's colour. Each
   * skin tile hit by roots gets its own map.
   */
  follicles(f: { readonly tris: Uint32Array; readonly bary: Float32Array } | null, cover = 1): void {
    if (!this.person) return;
    const mesh = this.person, g = mesh.geometry;
    const uv = g.getAttribute('uv'), index = g.getIndex()!;
    const materials = mesh.material as Material[];
    const SIZE = 2048;
    const used = new Set<number>();
    const draw = new Map<number, CanvasRenderingContext2D>();
    for (let k = 0; f && k < f.tris.length; k++) {
      const start = f.tris[k]!;
      const group = g.groups.find((gr) => start >= gr.start && start < gr.start + gr.count);
      if (!group) continue;
      const slot = group.materialIndex ?? 0;
      let ctx = draw.get(slot);
      if (!ctx) {
        let entry = this.follicleCanvases.get(slot);
        if (!entry) {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = SIZE;
          entry = { canvas, texture: new CanvasTexture(canvas) };
          entry.texture.colorSpace = NoColorSpace;
          entry.texture.anisotropy = 8;
          this.follicleCanvases.set(slot, entry);
        }
        ctx = entry.canvas.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.fillStyle = '#fff';
        draw.set(slot, ctx);
        used.add(slot);
      }
      const u = f.bary[k * 2]!, v = f.bary[k * 2 + 1]!;
      const a = index.getX(start), b = index.getX(start + 1), c = index.getX(start + 2);
      const x = uv.getX(a) + (uv.getX(b) - uv.getX(a)) * u + (uv.getX(c) - uv.getX(a)) * v;
      const y = uv.getY(a) + (uv.getY(b) - uv.getY(a)) * u + (uv.getY(c) - uv.getY(a)) * v;
      ctx.beginPath();
      ctx.arc(x * SIZE, (1 - y) * SIZE, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Green: the roots' density, blurred over 2-3 mm and scaled so a full
    // head of roots reads 1 (it shuts the scalp off from the light).
    for (const slot of used) packDensity(this.follicleCanvases.get(slot)!.canvas);
    materials.forEach((m, slot) => {
      const u = m.userData['follicle'] as { follicleMap: { value: Texture | null }; follicleOn: { value: number }; hairCover: { value: number } } | undefined;
      if (!u) return;
      const entry = this.follicleCanvases.get(slot);
      const on = used.has(slot) && !!entry;
      u.hairCover.value = cover;
      if (on) entry.texture.needsUpdate = true;
      u.follicleMap.value = on ? entry.texture : null;
      u.follicleOn.value = on ? 1 : 0;
    });
    this.redraw();
  }

  /** Glasses and earrings, placed on this face. */
  accessories(g: GlassesParams, e: EarringParams, a: FaceAnchors): void {
    const v = (p: readonly number[]): Vector3 => new Vector3(p[0], p[1], p[2]);
    const anchors = { eyes: [v(a.eyes[0]), v(a.eyes[1])] as const, lobes: [v(a.lobes[0]), v(a.lobes[1])] as const, earTops: [v(a.earTops[0]), v(a.earTops[1])] as const };
    const meshes: Mesh[] = [];
    for (const group of [glasses(g, anchors), earrings(e, anchors)]) {
      if (!group) continue;
      group.updateMatrixWorld(true);
      for (const child of [...group.children]) meshes.push(child as Mesh);
    }
    this.setLayer('accessories', meshes);
  }

  clothes(garments: readonly GarmentMesh[]): void {
    this.lift = garments.reduce((m, g) => Math.max(m, g.lift), 0);
    this.setLayer('clothes', garments.map(garmentObject));
    this.place();
  }

  skin(s: Dressing['skin']): void {
    if (!this.person) return;
    const u = this.person.userData['skin'] as SkinUniforms;
    u.undertone.value = s.undertone;
    u.lipColour.value.setHex(s.lipColour);
    u.lipAmount.value = s.lipAmount;
    u.stubble.value = s.stubble;
    u.stubbleColour.value.setHex(s.stubbleColour);
    u.follicleColour.value.setHex(s.follicleColour);
    this.redraw();
  }

  /** Reshapes the person in place; the camera follows the part on show. */
  updatePerson(b: LoadedBase, p: DrawnPerson): void {
    if (!this.person) return this.setPerson(b, p);
    updateHumanMesh(this.person, b.base, p.shape, p.melanin);
    setIris(this.person, p.iris);
    this.person.scale.setScalar(p.scale);
    this.place();
    this.redraw();
  }

  private landmarks(): Landmarks {
    const mesh = this.person!;
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const index = g.getIndex()!;
    const s = mesh.scale.x;
    const centroid = (material: string): Vector3 => {
      const out = new Vector3();
      let n = 0;
      for (const grp of g.groups) {
        const mat = (mesh.material as { name?: string }[])[grp.materialIndex ?? 0];
        if (mat?.name !== material) continue;
        for (let i = grp.start; i < grp.start + grp.count; i += 7) {
          const v = index.getX(i);
          out.x += pos.getX(v); out.y += pos.getY(v); out.z += pos.getZ(v); n++;
        }
      }
      return n ? out.multiplyScalar(s / n) : out;
    };
    g.computeBoundingBox();
    const eyes = centroid('Iris');
    const mouth = centroid('Mouth');
    // Half the head's width at eye height: the widest skin there.
    let half = 0;
    for (let v = 0; v < pos.count; v++) {
      if (Math.abs(pos.getY(v) * s - eyes.y) < 0.02 * s) half = Math.max(half, Math.abs(pos.getX(v)) * s);
    }
    // Shoes lift the person off the pedestal.
    const up = mesh.position.y;
    eyes.y += up; mouth.y += up;
    return { height: g.boundingBox!.max.y * s + up, eyes, mouth, headHalfWidth: Math.min(half, 0.11 * s) || 0.075 };
  }

  /** Points the camera at a part of the person (gliding unless `glide` is false). */
  frame(focus: Focus, glide = true): void {
    this.focus = focus;
    if (!this.person) return;
    const { target, azimuth, half } = shot(focus, this.landmarks());
    const dist = half / Math.tan((this.camera.fov * Math.PI) / 360) * 1.08;
    const eye = new Vector3(target.x + Math.sin(azimuth) * dist, target.y + dist * 0.06, target.z + Math.cos(azimuth) * dist);
    this.controls.minDistance = Math.min(0.25, dist * 0.5);
    this.controls.maxDistance = 7;
    if (glide) {
      this.glide = { from: [this.camera.position.clone(), this.controls.target.clone()], to: [eye, target], t0: performance.now() };
    } else {
      this.glide = null;
      this.camera.position.copy(eye);
      this.controls.target.copy(target);
    }
    this.redraw();
  }

  /** The part of the person under a screen point (CSS px in the canvas), or null. */
  pick(x: number, y: number): Focus | null {
    if (!this.person) return null;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const ndc = new Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.person, false)[0];
    if (!hit) return null;
    const m = this.landmarks();
    const p = hit.point, k = m.headHalfWidth / 0.075;
    if (p.y > m.mouth.y - 0.08 * k) {
      if (Math.abs(p.x) > m.headHalfWidth * 0.85) return 'ears';
      if (Math.abs(p.y - m.eyes.y) < 0.022 * k) return 'eyes';
      if (p.y < m.mouth.y - 0.025 * k) return 'chin';
      if (Math.abs(p.y - m.mouth.y) < 0.02 * k) return 'mouth';
      if (p.y < m.eyes.y && Math.abs(p.x) < 0.025 * k) return 'nose';
      return 'head';
    }
    const rel = p.y / m.height;
    if (rel < 0.47) return 'legs';
    if (Math.abs(p.x) > m.height * 0.12) return 'arms';
    return 'torso';
  }

  /** A head-and-shoulders portrait, `size` px square, as a JPEG data URL (for the gallery). */
  portrait(size = 160): string {
    if (!this.person) return '';
    const before = [this.camera.position.clone(), this.controls.target.clone()] as const;
    const m = this.landmarks();
    const k = m.headHalfWidth / 0.075;
    const target = new Vector3(0, m.eyes.y - 0.06 * k, m.eyes.z - 0.05 * k);
    const dist = 0.24 * k / Math.tan((this.camera.fov * Math.PI) / 360);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.camera.clearViewOffset();
    this.camera.aspect = w / h;
    this.camera.position.set(target.x + dist * 0.35, target.y + 0.02, target.z + dist * 0.94);
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const src = this.renderer.domElement;
    const side = Math.min(src.width, src.height);
    out.getContext('2d')!.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, size, size);
    this.camera.position.copy(before[0]);
    this.controls.target.copy(before[1]);
    this.resize();
    return out.toDataURL('image/jpeg', 0.85);
  }
}

/** Packs a follicle canvas: red keeps the dots, green gets their blurred density, normalised. */
function packDensity(canvas: HTMLCanvasElement): void {
  const size = canvas.width;
  const blur = document.createElement('canvas');
  blur.width = blur.height = size;
  const b = blur.getContext('2d')!;
  b.filter = 'blur(8px)';
  b.drawImage(canvas, 0, 0);
  const dots = canvas.getContext('2d')!.getImageData(0, 0, size, size);
  const dense = b.getImageData(0, 0, size, size).data;
  // The 90th percentile of the density where there is any: a full head of roots.
  const hist = new Uint32Array(256);
  for (let i = 0; i < dense.length; i += 4) if (dense[i]! > 2) hist[dense[i]!]!++;
  let total = 0;
  for (const h of hist) total += h;
  let top = 255;
  for (let v = 0, seen = 0; v < 256; v++) { seen += hist[v]!; if (seen >= total * 0.9) { top = Math.max(1, v); break; } }
  const d = dots.data;
  for (let i = 0; i < d.length; i += 4) d[i + 1] = Math.min(255, Math.round((dense[i]! * 255) / top));
  canvas.getContext('2d')!.putImageData(dots, 0, 0);
}
