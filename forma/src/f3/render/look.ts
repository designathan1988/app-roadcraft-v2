// Aparência do FORMA 3, no espírito do jogo (src/render/environment.ts e
// postprocess.ts do Roadcraft): céu em gradiente que também é o mapa de
// ambiente (vidro e metal refletem o céu), um sol lateral dominante com sombra
// macia e um céu de preenchimento fraco (a razão é o que modela o volume),
// oclusão de ambiente GTAO em meia resolução lendo a profundidade já desenhada,
// MSAA e saída tonal. Materiais com relevo (bump) a partir das texturas.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { MaterialKey } from '../../geometry/parts';
import { createRenderContext, type RenderContext } from '../../render/context';

const SKY_VERTEX = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_Position.z = gl_Position.w;
  }
`;

const SKY_FRAGMENT = `
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  void main() {
    float h = vDir.y;
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
    sky = mix(uGround, sky, smoothstep(-0.1, 0.03, h));
    float sun = max(dot(normalize(vDir), uSunDir), 0.0);
    sky += uSunColor * (pow(sun, 8.0) * 0.22 + pow(sun, 160.0) * 0.8);
    gl_FragColor = vec4(sky, 1.0);
  }
`;

/** Elevação e rumo do sol: alto o bastante para não alongar demais as sombras, lateral para modelar. */
const SUN_ELEVATION = (46 * Math.PI) / 180;
const SUN_AZIMUTH = (-62 * Math.PI) / 180;

export interface Look {
  sun: THREE.DirectionalLight;
  /** Aponta a sombra para onde a câmera olha. */
  follow(target: THREE.Vector3, span: number): void;
  setSize(w: number, h: number): void;
  render(): void;
  setAO(on: boolean): void;
  dispose(): void;
}

export function createLook(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): Look {
  // Neutral (Khronos PBR): mantém as cores dos materiais (AgX lavava tudo de cinza).
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const sunDir = new THREE.Vector3(Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH), Math.sin(SUN_ELEVATION), Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH)).normalize();
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color('#5d8fcf') },
      uHorizon: { value: new THREE.Color('#d6e3ec') },
      uGround: { value: new THREE.Color('#b9b4a6') },
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color('#fff1d6') },
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMat);
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  sky.name = 'céu';
  sky.onBeforeRender = (_r, _s, cam) => sky.position.copy(cam.position);
  sky.scale.setScalar(900);
  scene.add(sky);
  scene.background = null;

  // O céu vira o mapa de ambiente (reflexos no vidro, no metal e nas telhas).
  const pmrem = new THREE.PMREMGenerator(renderer);
  const probe = new THREE.Scene();
  const probeSky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMat.clone());
  probe.add(probeSky);
  const env = pmrem.fromScene(probe, 0, 0.1, 100);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.55;
  probeSky.geometry.dispose();
  (probeSky.material as THREE.Material).dispose();
  pmrem.dispose();

  const hemi = new THREE.HemisphereLight('#e9e6dc', '#6d6b58', 0.75);
  const sun = new THREE.DirectionalLight('#fff0d8', 3.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 3;
  scene.add(hemi, sun, sun.target);

  // Pós-processamento: cena num alvo com MSAA e profundidade → GTAO → saída.
  const size = renderer.getSize(new THREE.Vector2());
  const ratio = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), {
    type: THREE.HalfFloatType,
    depthTexture: new THREE.DepthTexture(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio)),
    samples: Math.min(4, renderer.capabilities.maxSamples),
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(ratio);
  composer.setSize(size.x, size.y);
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, size.x, size.y);
  gtao.output = GTAOPass.OUTPUT.Default;
  // Em metros: dobras de ~0,6 m (beirais, soleiras, encontros de volumes).
  gtao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  gtao.blendIntensity = 0.9;
  {
    // Usa a profundidade da própria cena (sem desenhar tudo de novo).
    const draw = gtao.render.bind(gtao);
    gtao.render = (...args: Parameters<GTAOPass['render']>) => {
      const depth = args[2].depthTexture;
      if (depth && gtao.depthTexture !== depth) gtao.setGBuffer(depth);
      draw(...args);
    };
    const resize = gtao.setSize.bind(gtao);
    gtao.setSize = (w: number, h: number) => resize(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2)));
    gtao.setSize(size.x * ratio, size.y * ratio);
  }
  composer.addPass(gtao);
  composer.addPass(new OutputPass());

  return {
    sun,
    follow(t, span) {
      const d = 220;
      sun.position.copy(t).addScaledVector(sunDir, d);
      sun.target.position.copy(t);
      sun.target.updateMatrixWorld();
      const s = Math.max(30, Math.min(220, span));
      Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: d * 2 });
      sun.shadow.camera.updateProjectionMatrix();
      renderer.shadowMap.needsUpdate = true;
    },
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    render() {
      composer.render();
    },
    setAO(on) {
      gtao.enabled = on;
    },
    dispose() {
      composer.dispose();
      gtao.dispose();
      target.dispose();
      env.dispose();
      sky.geometry.dispose();
      skyMat.dispose();
      scene.remove(sky, hemi, sun, sun.target);
    },
  };
}

/** Relevo por acabamento (bump a partir da própria textura). */
const BUMP: Record<string, number> = { brick: 1.6, stone: 1.8, tile: 2.0, concrete: 0.35, plaster: 0.5, wood: 0.9, metal: 1.1 };

/**
 * Contexto de render com materiais mais ricos: relevo nas texturas, vidro com
 * reflexo do céu, metal com brilho. Mantém a interface do contexto do FORMA.
 */
export function createLookContext(): RenderContext {
  const base = createRenderContext();
  const extra = new Map<string, THREE.MeshStandardMaterial>();
  return {
    ...base,
    boxGeometry: base.boxGeometry,
    modules: base.modules,
    material(key: MaterialKey) {
      const id = `${key.role}|${key.color}|${key.roughness}|${key.metalness ?? 0}|${key.doubleSide ? 2 : 1}|${key.texture ?? ''}|${key.textureScale ?? 1}`;
      let m = extra.get(id);
      if (m) return m;
      m = base.material(key);
      if (key.role === 'glass') {
        m.color.set(key.color).multiplyScalar(0.55);
        m.roughness = 0.04;
        m.metalness = 0.85;
        m.envMapIntensity = 1.6;
      } else if (key.texture && m.map) {
        m.bumpMap = m.map;
        m.bumpScale = BUMP[key.texture] ?? 0.6;
        m.roughness = Math.min(1, key.roughness + 0.04);
      }
      if ((key.metalness ?? 0) > 0.3 && key.role !== 'glass') m.envMapIntensity = 1.2;
      m.needsUpdate = true;
      extra.set(id, m);
      return m;
    },
    owns: base.owns,
    dispose() {
      extra.clear();
      base.dispose();
    },
  };
}
