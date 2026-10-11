// Exemplo: o jogo cria a própria cena three.js e incorpora o FORMA.
// O editor adiciona um único grupo à cena, não roda laço próprio e não
// usa a interface do FORMA (ui: 'none'); o jogo comanda pelos métodos.
import * as THREE from 'three';
import { buildBuilding, createEditor, ops, type Tool } from '../index';

const host = document.getElementById('game')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fb4c7');
scene.add(new THREE.HemisphereLight('#ffffff', '#556070', 2.4));
const sunLight = new THREE.DirectionalLight('#ffffff', 2);
sunLight.position.set(-30, 50, 20);
scene.add(sunLight);
const terrain = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: '#7d9161' }));
terrain.rotation.x = -Math.PI / 2;
terrain.position.y = -0.05;
scene.add(terrain);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);

function resize() {
  const r = host.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
resize();

const editor = createEditor({ renderer, scene, camera, ui: 'none', storage: false });
const log = document.getElementById('log')!;
editor.on('error', ({ message }) => (log.textContent = message));
editor.on('commit', ({ message }) => (log.textContent = message || 'Alterado.'));
editor.on('tool', ({ tool }) => document.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool))));

document.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => editor.setTool(b.dataset.tool as Tool)));
document.getElementById('undo')!.addEventListener('click', () => editor.undo());

// Gerador: um prédio pronto adicionado direto na cena do jogo, sem o editor.
let spawned = 0;
document.getElementById('spawn')!.addEventListener('click', () => {
  const b = ops.newBuilding({ name: 'Gerado', points: [[-4, -3], [4, -3], [4, 3], [-4, 3]], position: [-40 + spawned * 12, -30], base: 0, height: 12.8, floors: 4, color: '#d8d1c1', roof: 'gable' });
  scene.add(buildBuilding(b).group);
  spawned++;
  log.textContent = `Prédio gerado (${spawned}).`;
});

(globalThis as Record<string, unknown>).hostDemo = { editor, scene, renderer };
renderer.setAnimationLoop(() => renderer.render(scene, camera));
document.body.dataset.ready = 'true';
