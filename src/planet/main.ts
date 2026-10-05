import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { initLanguage, t } from '@ui/i18n';
import { createPlanetCamera } from './camera';
import { PLANET_RADIUS } from './relief';
import { createPlanetSurface } from './surface';

/**
 * The planet: the world as a real sphere, not a flat map bent to look like one.
 *
 * Its ground is a cube sphere of quadtree patches (`surface.ts`) over a relief
 * read on the sphere itself (`relief.ts`), its sea a sphere at sea level, and
 * the camera goes round it and down to the ground (`camera.ts`).
 */

initLanguage();
const canvas = document.getElementById('planet') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;

const scene = new Scene();
const sky = new Color(0x9ec4e4);
const space = new Color(0x04060c);
scene.background = sky.clone();
scene.fog = new Fog(sky.getHex(), 4_000, 20_000);

const sun = new DirectionalLight(0xfff2d6, 3.2);
sun.position.set(0.6, 0.7, 0.4).multiplyScalar(PLANET_RADIUS * 4);
scene.add(sun);
scene.add(new HemisphereLight(0xcfe0ee, 0x3a3226, 0.6));

const surface = createPlanetSurface();
scene.add(surface.group);

// The sea: a sphere at sea level, the ground shows through its shallows.
const sea = new Mesh(
  new SphereGeometry(PLANET_RADIUS, 256, 128),
  new MeshStandardMaterial({ color: 0x1d5a86, roughness: 0.25, metalness: 0, transparent: true, opacity: 0.82 }),
);
sea.name = 'planet-sea';
scene.add(sea);

const view = createPlanetCamera();
view.attach(canvas);

const hint = document.getElementById('hint') as HTMLElement;
const altitudeText = document.getElementById('altitude') as HTMLElement;
document.title = `${t('planet.title')} — Roadcraft`;
hint.textContent = t('planet.hint');

const resize = (): void => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  view.resize(window.innerWidth, window.innerHeight);
};
window.addEventListener('resize', resize);
resize();

const fog = scene.fog as Fog;
const frame = (): void => {
  view.update();
  surface.update(view.camera);
  // Sky near the ground, space from orbit; the haze thins out as the camera climbs.
  const out = Math.min(1, Math.max(0, (view.altitude - 3_000) / 25_000));
  (scene.background as Color).copy(sky).lerp(space, out);
  fog.color.copy(scene.background as Color);
  fog.near = view.altitude * 2 + 3_000;
  fog.far = view.altitude * 6 + 18_000 + out * 200_000;
  altitudeText.textContent = t('planet.altitude', { km: (view.altitude / 1000).toFixed(view.altitude < 10_000 ? 2 : 0) });
  renderer.render(scene, view.camera);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

(window as unknown as { __planet: unknown }).__planet = { view, surface, renderer, scene };
