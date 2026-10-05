import {
  ACESFilmicToneMapping, CanvasTexture, Clock, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial,
  PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, RepeatWrapping, Scene, SRGBColorSpace, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { randomPerson } from '@people/spec';
import { yearsFromAge } from '@people/body/macro';
import { createProceduralCrowd, type ProceduralPerson } from './proceduralCrowd';

/**
 * The procedural people's test bench (`people-lab.html`): a line-up to look at
 * close, and a crowd walking round it, all drawn by `proceduralCrowd.ts` -
 * one body per class, clothes and hair as pieces of their own.
 */

const canvas = document.getElementById('lab') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;

const scene = new Scene();
scene.background = new Color(0xbfd3e0);
const camera = new PerspectiveCamera(35, 1, 0.1, 400);
camera.position.set(0, 2.2, 9);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;

scene.add(new HemisphereLight(0xdfeeff, 0x6b6253, 1.1));
const sun = new DirectionalLight(0xfff1dc, 2.6);
sun.position.set(-8, 14, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -16;
sun.shadow.camera.right = sun.shadow.camera.top = 16;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

// Paving: a plain grid of slabs, so scale and footing read.
const tile = document.createElement('canvas');
tile.width = tile.height = 128;
const g = tile.getContext('2d')!;
g.fillStyle = '#9a968e'; g.fillRect(0, 0, 128, 128);
g.strokeStyle = '#85817a'; g.lineWidth = 3; g.strokeRect(0, 0, 128, 128);
const paving = new CanvasTexture(tile);
paving.wrapS = paving.wrapT = RepeatWrapping;
paving.repeat.set(40, 40);
paving.colorSpace = SRGBColorSpace;
const ground = new Mesh(new PlaneGeometry(80, 80), new MeshStandardMaterial({ map: paving, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const crowd = createProceduralCrowd();
scene.add(crowd.group);

const LINEUP = 10;
interface Walker { person: ProceduralPerson; s: number; lane: number; speed: number }
const walkers: Walker[] = [];
let walking = true;
let seed = 1;
let wanted = 60;
let generation = 0;

const statusEl = document.getElementById('status')!;
const statsEl = document.getElementById('stats')!;
const infoEl = document.getElementById('info')!;

function loopPoint(s: number, lane: number): { x: number; z: number; heading: number } {
  // A rounded rectangle round the line-up, `lane` metres out.
  const rx = 7 + lane, rz = 5 + lane;
  const t = s / (2 * Math.PI * Math.sqrt((rx * rx + rz * rz) / 2));
  const a = t * Math.PI * 2;
  const x = Math.cos(a) * rx, z = Math.sin(a) * rz - 1;
  // Facing along the path: the derivative of the ellipse.
  const dx = -Math.sin(a) * rx, dz = Math.cos(a) * rz;
  return { x, z, heading: Math.atan2(dx, dz) };
}

async function populate(): Promise<void> {
  const mine = ++generation;
  crowd.clear();
  walkers.length = 0;
  const started = performance.now();
  for (let i = 0; i < wanted; i++) {
    if (mine !== generation) return;
    const spec = randomPerson(i + 1, seed * 7919 + i * 104729);
    statusEl.textContent = `Gerando ${i + 1} de ${wanted}...`;
    const person = await crowd.add(spec).catch(() => null);
    if (mine !== generation || !person) return;
    if (i < LINEUP) {
      const x = (i - (LINEUP - 1) / 2) * 0.9;
      person.matrix.makeRotationY(0).setPosition(x, 0, 1.2);
      person.clip = 'idle';
      person.phase = (i * 0.137) % 1;
    } else {
      walkers.push({ person, s: (i - LINEUP) * 2.3, lane: (i % 4) * 1.1, speed: 0 });
    }
  }
  const s = crowd.stats();
  statusEl.textContent = `Pronto: ${wanted} pessoas em ${((performance.now() - started) / 1000).toFixed(1)} s `
    + `(montagem das classes ${(s.bakeMs / 1000).toFixed(1)} s). Arraste para girar, roda do mouse para aproximar.`;
}

function describe(): void {
  const s = crowd.stats();
  statsEl.innerHTML = [
    `Classes de corpo: <b>${s.classes}</b> (sexo × idade)`,
    `Pessoas: <b>${s.people}</b>`,
    `Peças diferentes (roupa, cabelo...): <b>${s.items}</b>`,
    `Malhas instanciadas: <b>${s.pieces}</b>, chamadas de desenho: <b>${s.draws}</b>`,
    `Vértices carregados: <b>${(s.vertices / 1000).toFixed(0)} mil</b>`,
    `Texturas de forma/osso: <b>${(s.textureBytes / 1e6).toFixed(1)} MB</b>`,
    `Desenho: <b>${renderer.info.render.calls}</b> chamadas, <b>${(renderer.info.render.triangles / 1000).toFixed(0)} mil</b> triângulos`,
  ].join('<br>');
}

const clock = new Clock();
let fpsFrames = 0, fpsTime = 0, fps = 0;
function frame(): void {
  const dt = Math.min(0.05, clock.getDelta());
  fpsFrames++; fpsTime += dt;
  if (fpsTime > 0.5) { fps = fpsFrames / fpsTime; fpsFrames = 0; fpsTime = 0; describe(); infoEl.textContent = `${fps.toFixed(0)} fps`; }
  for (const person of crowd.people) {
    if (person.clip === 'idle') person.phase += dt / crowd.clipDuration(person);
  }
  for (const w of walkers) {
    const duration = crowd.clipDuration(w.person);
    if (walking) {
      w.speed = crowd.stride(w.person) / duration;
      w.s += w.speed * dt;
      w.person.clip = 'walk';
      w.person.phase += dt / duration;
    } else {
      w.person.clip = 'idle';
      w.person.phase += dt / duration;
    }
    const p = loopPoint(w.s, w.lane);
    w.person.matrix.makeRotationY(p.heading).setPosition(p.x, 0, p.z);
  }
  crowd.update();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function resize(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

document.getElementById('again')!.addEventListener('click', () => { seed++; void populate(); });
document.getElementById('walk')!.addEventListener('click', (e) => {
  walking = !walking;
  (e.currentTarget as HTMLButtonElement).textContent = walking ? 'Parar todos' : 'Andar';
});
document.getElementById('count')!.addEventListener('change', (e) => {
  wanted = Number((e.currentTarget as HTMLSelectElement).value);
  void populate();
});
document.getElementById('close')!.addEventListener('click', () => {
  controls.target.set(0, 1.1, 1.2);
  camera.position.set(0, 1.6, 4.2);
});
document.getElementById('far')!.addEventListener('click', () => {
  controls.target.set(0, 0.8, 0);
  camera.position.set(0, 9, 22);
});

// For the headless photographer (`scripts/people-lab-shots.mjs`).
(window as unknown as { __lab: unknown }).__lab = {
  crowd, camera, controls,
  ready: () => statusEl.textContent?.startsWith('Pronto') ?? false,
  view(x: number, y: number, z: number, tx: number, ty: number, tz: number) { camera.position.set(x, y, z); controls.target.set(tx, ty, tz); controls.update(); },
  people: () => crowd.people.map((p) => ({ years: Math.round(yearsFromAge(p.spec.body.age)), sex: p.sex, band: p.band, height: p.height, items: p.items })),
};

requestAnimationFrame(frame);
void populate();
