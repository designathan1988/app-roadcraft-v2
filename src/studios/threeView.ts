import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { interpolatePose, joints, supportHeight, animationSamples } from './model';
import type { Project, MaterialProject, AnimationProject, Pose, Joint } from './model';

/** Procedural PBR texture with a fixed seed. Rebuilt only on edits. */
export function textureCanvas(p: MaterialProject): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const c = canvas.getContext('2d'); if (!c) throw new Error('Canvas de textura indisponível.');
  c.fillStyle = p.color; c.fillRect(0, 0, 512, 512);
  let seed = 13579; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  if (p.pattern === 'brick') { c.fillStyle = '#a6a296'; c.fillRect(0, 0, 512, 512); for (let y = 0; y < 512; y += 64) for (let x = -128; x < 512; x += 128) { c.fillStyle = p.color; c.fillRect(x + (y / 64 % 2 ? 64 : 0) + 3, y + 3, 122, 58); } }
  if (p.pattern === 'fabric') { for (let i = 0; i < 512; i += 4) { c.strokeStyle = 'rgba(255,255,255,.11)'; c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 512); c.stroke(); c.strokeStyle = 'rgba(0,0,0,.14)'; c.beginPath(); c.moveTo(0, i); c.lineTo(512, i); c.stroke(); } }
  if (p.pattern !== 'plain') for (let i = 0; i < (p.pattern === 'asphalt' ? 16000 : 4500); i++) { const x = random() * 512, y = random() * 512, alpha = random() * (p.pattern === 'asphalt' ? 0.18 : 0.06); c.fillStyle = i % 2 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`; c.fillRect(x, y, random() * 2 + 0.5, random() * 2 + 0.5); }
  if (p.wear) for (let i = 0; i < p.wear * 45; i++) { const x = random() * 512, y = random() * 512; c.strokeStyle = `rgba(17,23,19,${p.wear * 0.4})`; c.lineWidth = 0.6 + random() * 2; c.beginPath(); c.moveTo(x, y); c.lineTo(x + 10 + random() * 30, y + random() * 30); c.stroke(); }
  return canvas;
}

export class ThreeView {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
  private readonly controls: OrbitControls;
  private object: THREE.Group | THREE.Mesh | null = null;
  private poseBones = new Map<Joint, THREE.Bone>();
  private body: THREE.Bone | null = null;
  private texture: THREE.Texture | null = null;
  private textureReady: Promise<void> = Promise.resolve();
  private textureError: string | null = null;
  private project: Project;
  private playing = false;
  private bench: THREE.Group;
  constructor(host: HTMLElement, p: Project) {
    this.project = p;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); this.renderer.setClearColor('#edf1e7');
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.95;
    this.canvas = this.renderer.domElement; this.canvas.tabIndex = 0; this.canvas.setAttribute('aria-label', 'Prévia 3D. Arraste para girar a câmera; use a roda para aproximar.'); host.append(this.canvas);
    this.camera.position.set(3, 2.4, 4.5);
    this.controls = new OrbitControls(this.camera, this.canvas); this.controls.target.set(0, 0.8, 0); this.controls.minDistance = 1; this.controls.maxDistance = 10; this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    this.controls.addEventListener('change', () => this.draw());
    this.scene.add(new THREE.HemisphereLight('#fcfff0', '#617561', 1.8));
    const light = new THREE.DirectionalLight('#fff5df', 3.5); light.position.set(4, 6, 3); light.castShadow = true; light.shadow.mapSize.set(1024, 1024); light.shadow.camera.left = -3; light.shadow.camera.right = 3; light.shadow.camera.top = 3; light.shadow.camera.bottom = -3; light.shadow.normalBias = 0.02; this.scene.add(light);
    const fill = new THREE.DirectionalLight('#d1e7f4', 1.2); fill.position.set(-3, 2, -2); this.scene.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: '#dde6d4', roughness: 1 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.scene.add(floor);
    const grid = new THREE.GridHelper(20, 40, '#b2c1a7', '#d0daca'); grid.position.y = 0.002; this.scene.add(grid);
    // A local environment map gives metallic samples a real reflection source.
    const room = new THREE.Scene(); room.background = new THREE.Color('#d9e5d4'); room.add(new THREE.HemisphereLight('#ffffff', '#687d64', 2));
    for (const [x, y, z] of [[-3, 3, 1], [4, 2, -2], [0, 5, 0]]) { const panel = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.8, 1), new THREE.MeshBasicMaterial({ color: '#ffffff' })); panel.position.set(x!, y!, z!); room.add(panel); }
    const pmrem = new THREE.PMREMGenerator(this.renderer), environment = pmrem.fromScene(room, 0.04); this.scene.environment = environment.texture; pmrem.dispose();
    room.traverse(node => { if (node instanceof THREE.Mesh) { node.geometry.dispose(); (node.material as THREE.Material).dispose(); } });
    this.bench = this.seat(); this.bench.visible = false; this.scene.add(this.bench);
    new ResizeObserver(() => { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.draw(); }).observe(host);
    this.update(p, 0);
  }
  setMode(close: boolean) { this.camera.position.set(close ? 1.8 : 3, close ? 1.5 : 2.4, close ? 2.4 : 4.5); const p = this.project, target = p.kind === 'material' ? p.shape === 'sphere' ? 0.76 : p.shape === 'cube' ? 0.65 : 0.2 : close ? 1.0 : 0.8; this.controls.target.set(0, target, 0); this.controls.update(); this.draw(); }
  showSeat(show: boolean) { this.bench.visible = show; this.draw(); }
  private releaseObject() { if (!this.object) return; this.scene.remove(this.object); const materials = new Set<THREE.Material>(), geometries = new Set<THREE.BufferGeometry>(); this.object.traverse(node => { if (node instanceof THREE.Mesh) { geometries.add(node.geometry); for (const m of Array.isArray(node.material) ? node.material : [node.material]) materials.add(m); } }); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); this.texture?.dispose(); this.texture = null; this.poseBones.clear(); }
  update(p: Project, time: number) {
    const changed = this.project !== p || !this.object; this.project = p;
    if (changed) { this.releaseObject(); if (p.kind === 'material') this.material(p); else if (p.kind === 'animation') this.human(); if (this.object) this.scene.add(this.object); }
    this.tick(time, false);
  }
  tick(time: number, playing: boolean) { this.playing = playing; if (this.project.kind === 'animation') this.pose(interpolatePose(this.project, time)); else if (this.object && this.project.kind === 'material' && playing) this.object.rotation.y = time * 0.35; this.draw(); }
  private draw() { this.renderer.render(this.scene, this.camera); }
  info() { return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, playing: this.playing }; }
  private material(p: MaterialProject) {
    this.textureReady = Promise.resolve(); this.textureError = null;
    const canvas = textureCanvas(p); this.texture = new THREE.CanvasTexture(canvas); this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping; this.texture.repeat.set(p.scale, p.scale); this.texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const material = new THREE.MeshStandardMaterial({ color: '#ffffff', map: this.texture, roughness: p.roughness, metalness: p.metalness });
    const geometry = p.shape === 'sphere' ? new THREE.SphereGeometry(0.75, 64, 40) : p.shape === 'cube' ? new THREE.BoxGeometry(1.3, 1.3, 1.3) : new THREE.BoxGeometry(2.4, 0.08, 2.4);
    const mesh = new THREE.Mesh(geometry, material); mesh.position.y = p.shape === 'sphere' ? 0.76 : p.shape === 'cube' ? 0.66 : 0.05; mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = p.name; this.object = mesh;
    if (p.texture) { const expected = this.texture; this.textureReady = new Promise(resolve => { new THREE.TextureLoader().load(p.texture!, loaded => { if (this.project !== p) { loaded.dispose(); resolve(); return; } const ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, 512, 512); ctx.drawImage(loaded.image as CanvasImageSource, 0, 0, 512, 512); expected!.needsUpdate = true; loaded.dispose(); this.draw(); resolve(); }, undefined, error => { if (this.project === p) { this.textureError = `Textura não pôde ser carregada: ${String(error)}`; const status = document.getElementById('status'); if (status) { status.textContent = this.textureError; status.classList.add('error'); } } resolve(); }); }); }
  }
  private human() {
    const group = new THREE.Group(); group.name = 'Roadcraft_mannequin'; this.body = new THREE.Bone(); this.body.name = 'body'; this.body.position.y = 0.9; group.add(this.body);
    const skin = new THREE.MeshStandardMaterial({ color: '#ccab8b', roughness: 0.85 }), shirt = new THREE.MeshStandardMaterial({ color: '#799267', roughness: 0.9 }), trousers = new THREE.MeshStandardMaterial({ color: '#435650', roughness: 0.95 });
    const addMesh = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z = 0) => { const mesh = new THREE.Mesh(geo, mat); mesh.position.set(x, y, z); mesh.castShadow = true; parent.add(mesh); return mesh; };
    const bone = (joint: Joint, parent: THREE.Object3D, x: number, y: number) => { const b = new THREE.Bone(); b.name = joint; b.position.set(x, y, 0); parent.add(b); this.poseBones.set(joint, b); return b; };
    const torso = bone('torso', this.body, 0, 0); addMesh(torso, new THREE.BoxGeometry(0.38, 0.50, 0.22), shirt, 0, 0.29);
    addMesh(this.body, new THREE.BoxGeometry(0.3, 0.15, 0.22), trousers, 0, -0.03);
    const head = bone('head', torso, 0, 0.67); addMesh(head, new THREE.SphereGeometry(0.13, 24, 18), skin, 0, 0.05); addMesh(head, new THREE.BoxGeometry(0.04, 0.05, 0.045), skin, 0, 0.02, 0.125);
    for (const side of ['left', 'right'] as const) { const sign = side === 'left' ? 1 : -1;
      const arm = bone(`${side}Arm`, torso, sign * 0.25, 0.5); addMesh(arm, new THREE.CylinderGeometry(0.06, 0.052, 0.3, 12), shirt, 0, -0.15);
      const elbow = bone(`${side}Elbow`, arm, 0, -0.3); addMesh(elbow, new THREE.CylinderGeometry(0.05, 0.036, 0.26, 12), skin, 0, -0.13); addMesh(elbow, new THREE.SphereGeometry(0.045, 12, 8), skin, 0, -0.29);
      const leg = bone(`${side}Leg`, this.body, sign * 0.105, -0.08); addMesh(leg, new THREE.CylinderGeometry(0.075, 0.056, 0.38, 12), trousers, 0, -0.19);
      const knee = bone(`${side}Knee`, leg, 0, -0.38); addMesh(knee, new THREE.CylinderGeometry(0.055, 0.045, 0.36, 12), trousers, 0, -0.18); addMesh(knee, new THREE.BoxGeometry(0.105, 0.09, 0.23), trousers, 0, -0.395, 0.065);
    }
    this.object = group;
  }
  private pose(pose: Pose) { if (this.body) this.body.position.y = (this.project.kind === 'animation' && this.project.grounded ? supportHeight(pose) : 0.9) + pose.height; for (const [joint, bone] of this.poseBones) { bone.rotation.set(0, 0, 0); if (joint === 'head') bone.rotation.y = THREE.MathUtils.degToRad(pose[joint]); else bone.rotation.x = THREE.MathUtils.degToRad(pose[joint]); } }
  private seat() { const group = new THREE.Group(), mat = new THREE.MeshStandardMaterial({ color: '#738073', roughness: 0.9 }); const part = (size: number[], pos: number[]) => { const m = new THREE.Mesh(new THREE.BoxGeometry(size[0]!, size[1]!, size[2]!), mat); m.position.set(pos[0]!, pos[1]!, pos[2]!); group.add(m); };
    part([0.55, 0.12, 0.5], [0, 0.48, -0.05]); part([0.55, 0.65, 0.12], [0, 0.81, -0.3]); part([0.1, 0.45, 0.1], [0, 0.23, -0.1]);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.018, 8, 32), mat); wheel.position.set(0, 1.03, 0.47); wheel.rotation.x = -0.45; group.add(wheel); return group;
  }
  private clips(p: AnimationProject): THREE.AnimationClip[] {
    const samples = animationSamples(p), times = samples.map(k => k.time), tracks: THREE.KeyframeTrack[] = [], q = new THREE.Quaternion();
    for (const joint of joints.filter(j => j !== 'height')) { const values: number[] = []; for (const key of samples) { const e = new THREE.Euler(joint === 'head' ? 0 : THREE.MathUtils.degToRad(key.pose[joint]), joint === 'head' ? THREE.MathUtils.degToRad(key.pose[joint]) : 0, 0); q.setFromEuler(e); values.push(q.x, q.y, q.z, q.w); } tracks.push(new THREE.QuaternionKeyframeTrack(`${joint}.quaternion`, times, values)); }
    tracks.push(new THREE.VectorKeyframeTrack('body.position', times, samples.flatMap(({ pose }) => [0, (p.grounded ? supportHeight(pose) : 0.9) + pose.height, 0])));
    return [new THREE.AnimationClip(p.name, p.duration, tracks)];
  }
  async exportGLB(): Promise<ArrayBuffer> {
    await this.textureReady; if (this.textureError) throw new Error(this.textureError);
    if (!this.object) throw new Error('Nenhum modelo para exportar.');
    const p = this.project; if (p.kind === 'animation') this.pose(p.keys[0]!.pose);
    const exporter = new GLTFExporter(); const buffer = await exporter.parseAsync(this.object, { binary: true, animations: p.kind === 'animation' ? this.clips(p) : [] });
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Exportação GLB inválida.'); return buffer;
  }
  async exportTexture(): Promise<Blob> { await this.textureReady; if (this.textureError) throw new Error(this.textureError); const p = this.project; if (p.kind !== 'material') throw new Error('Este editor não exporta textura.'); const canvas = this.texture?.image as HTMLCanvasElement | undefined; if (!canvas) throw new Error('Textura ainda indisponível.'); return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Falha ao gerar PNG.')), 'image/png')); }
}
