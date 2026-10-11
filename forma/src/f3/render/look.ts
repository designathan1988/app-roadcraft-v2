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
import { DETAIL_MEAN, disposePbr, pbrFor } from './pbr';
import { disposeProc, procFor, type ProcTextures } from './procedural';
import { imageTexture } from './images';

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

/**
 * Vidro de janela em uma passada, alfa pré-multiplicado: o reflexo (céu e sol)
 * soma com força total e o que está atrás é atenuado pelo alfa, que cresce
 * com o Fresnel (de lado o vidro vira espelho). Opacidade comum apagava o
 * reflexo junto (three.js #15941).
 */
function windowGlass(m: THREE.MeshStandardMaterial, color: string): void {
  m.color.set(color);
  m.roughness = 0.04;
  m.metalness = 0;
  m.envMapIntensity = 1.6;
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendEquation = THREE.AddEquation;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float glassNv = clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0);
       float glassF = pow(1.0 - glassNv, 5.0);
       float glassA = mix(0.22, 1.0, glassF);
       gl_FragColor = vec4(totalSpecular + totalDiffuse * glassA, glassA);`,
    );
  };
  m.customProgramCacheKey = () => 'forma-window-glass';
}

/**
 * Material procedural: o detalhe traz luminância (R), máscara da 2ª cor (G)
 * e rugosidade (B); a cor principal e a 2ª cor são do material.
 */
function procMaterial(m: THREE.MeshStandardMaterial, key: MaterialKey, t: ProcTextures): void {
  m.map = t.detail;
  m.normalMap = t.normal;
  m.normalScale.set(1, 1);
  m.bumpMap = null;
  m.roughnessMap = null;
  m.roughness = 1;
  m.color.set(key.color).multiplyScalar(1 / 0.8);
  const c2 = { value: new THREE.Color(key.color2 ?? t.def.color2).multiplyScalar(1 / 0.8) };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uColor2 = c2;
    sh.fragmentShader =
      'uniform vec3 uColor2;\n' +
      sh.fragmentShader
        .replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
  vec4 procT = texture2D( map, vMapUv );
  diffuseColor.rgb = mix( diffuseColor.rgb, uColor2, procT.g ) * procT.r;
#endif`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness;
#ifdef USE_MAP
  roughnessFactor *= texture2D( map, vMapUv ).b;
#endif`,
        );
  };
  m.customProgramCacheKey = () => 'forma-proc';
}

/**
 * Contexto de render com materiais ricos: texturas PBR reais (cor, normal,
 * rugosidade) por acabamento, vidro de janela físico, metal com brilho e
 * interiores escuros (de dia, um cômodo visto de fora é bem mais escuro que a
 * fachada; a luz do céu não entra inteira).
 */
export function createLookContext(): RenderContext {
  const base = createRenderContext();
  const extra = new Map<string, THREE.MeshStandardMaterial>();
  return {
    ...base,
    boxGeometry: base.boxGeometry,
    modules: base.modules,
    material(key: MaterialKey) {
      const id = `${key.role}|${key.color}|${key.roughness}|${key.metalness ?? 0}|${key.doubleSide ? 2 : 1}|${key.texture ?? ''}|${key.textureScale ?? 1}|${key.finish ?? ''}|${key.color2 ?? ''}|${key.params ?? ''}|${key.image ?? ''}`;
      let m = extra.get(id);
      if (m) return m;
      m = base.material(key);
      const pbr = key.texture && key.finish ? pbrFor(key.finish) : null;
      const proc = key.texture && key.finish && !pbr ? procFor(key.finish, key.params ? (Object.fromEntries(JSON.parse(key.params) as [string, number][]) as Record<string, number>) : undefined) : null;
      if (key.image !== undefined) {
        m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.65, map: imageTexture(key.image) });
        m.name = 'imagem';
      } else if (key.role === 'glass' && key.roughness < 0.1) windowGlass(m, key.color);
      else if (key.role === 'glass') {
        // Vidro sem nada atrás (cobertura, pele de vidro): opaco e espelhado.
        m.color.set(key.color).multiplyScalar(0.6);
        m.roughness = 0.06;
        m.metalness = 0.7;
        m.envMapIntensity = 1.5;
      } else if (key.finish === 'interior') {
        m.roughness = 1;
        m.envMapIntensity = 0.12;
      } else if (proc) procMaterial(m, key, proc);
      else if (pbr) {
        m.map = pbr.map;
        m.normalMap = pbr.normalMap;
        m.normalScale.set(pbr.set.normalScale, pbr.set.normalScale);
        m.roughnessMap = pbr.roughnessMap;
        m.roughness = Math.min(1, key.roughness + 0.1);
        m.bumpMap = null;
        // O detalhe guardado tem média DETAIL_MEAN: a cor compensa.
        m.color.set(key.color).multiplyScalar(1 / DETAIL_MEAN);
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
      disposePbr();
      disposeProc();
    },
  };
}
