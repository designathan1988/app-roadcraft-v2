import {
  BufferGeometry, Color, DepthTexture, Float32BufferAttribute, HalfFloatType, Matrix4, Mesh,
  PlaneGeometry, Scene, Vector2, Vector3, Vector4, WebGLRenderTarget, type Camera, type WebGLRenderer,
} from 'three';
import { MAP_SIZE } from '@world/bounds';
import { PLANET_SHADER, planetPoint } from './planet';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import type { QualityLevel, QualitySettings } from './quality';

/**
 * The post chain: ambient occlusion, then anti-aliasing, then tone mapping.
 *
 * ## Why ambient occlusion earns its cost here
 *
 * Nearly every contact in this scene is a flat surface meeting another flat
 * surface at a small height difference — asphalt to kerb, kerb to footway,
 * footway to verge, a pier standing on the ground, a deck over a road. Direct
 * light cannot describe any of those: the two surfaces face the same way, so
 * they take the same amount of sun and the edge between them vanishes. Ground
 * truth ambient occlusion darkens exactly those creases, and it is the single
 * change that makes the road read as built into the ground rather than printed
 * on it.
 *
 * ## MSAA and SMAA
 *
 * The composer's half-float target is multisampled (4x where the GPU allows):
 * thin geometry - lane lines, kerbs, a road's edge seen from afar - is sampled
 * at every pixel it crosses. SMAA then runs on the resolved image, one pass,
 * and - unlike FXAA - keeps the thin bright lines of lane markings sharp
 * instead of smearing them.
 *
 * At the lowest quality tier the composer is skipped entirely and the scene is
 * drawn straight to the canvas with the driver's own MSAA, which is what keeps a
 * weak GPU playable.
 */

export interface PostChain {
  readonly enabled: boolean;
  /** What the scene is drawn into (null: the screen): shaders are compiled ahead for it. */
  readonly target: WebGLRenderTarget | null;
  render(delta: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /**
   * How dark it is, 0 by day to 1 at night: the bloom is for lights in the
   * dark (lamps, headlights, lit windows). By day it set the white paint of
   * every zebra and line glowing in the sun; it is off then (and its passes
   * with it), and comes up with the dusk.
   */
  setNight(dark: number): void;
  /**
   * The sky the player set (`Atmosphere`), the light it is lit by, and
   * whether the map is seen as a model over the void (building it), when
   * the air round it is drawn too: the backdrop and the haze of distance.
   */
  setAtmosphere(atmosphere: Atmosphere, sun: Vector3, skyColor: Color, sunLight: Color, backdrop: boolean): void;
  /**
   * How far out to the whole globe the view is (`Viewport.globe`): out there
   * the crease shading is off - nothing at that scale has a crease, and over
   * the depth of a whole planet its reconstruction drew a line across it.
   */
  setGlobe(globe: number): void;
  dispose(): void;
}

/**
 * The player's sky (Paisagem > Céu e clima): how much of it is cloud, at
 * what height and how thick the layer is, and how much mist lies over the
 * land and how high it reaches. World units.
 */
export interface Atmosphere {
  /** 0 a clear sky, 1 a sky full of cumulus (`MAX_CLOUDS`). */
  readonly clouds: number;
  readonly cloudBase: number;
  readonly cloudThickness: number;
  /** 0 none (the default: the map seen clear), 1 a thick mist. */
  readonly fog: number;
  readonly fogHeight: number;
  /** The planet the map is drawn on, its radius in units (`planet.ts`); 0: flat. */
  readonly planet: number;
}
export const DEFAULT_ATMOSPHERE: Atmosphere = { clouds: 0.4, cloudBase: 450, cloudThickness: 375, fog: 0, fogHeight: 150, planet: 0 };

export function createPostChain(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  quality: QualitySettings,
  level: QualityLevel,
): PostChain {
  if (!quality.postProcessing) {
    return {
      enabled: false,
      target: null,
      render() {
        renderer.render(scene, camera);
      },
      setSize() {
        /* the renderer's own resize is enough */
      },
      setNight() {
        /* no bloom without the chain */
      },
      setAtmosphere() {
        /* no clouds or mist without the chain */
      },
      setGlobe() {
        /* no crease shading without the chain */
      },
      dispose() {
        /* nothing owned */
      },
    };
  }

  const size = renderer.getSize(new Vector2());
  // The scene is drawn into targets that keep their depth, so the occlusion
  // pass reads it rather than drawing the whole scene a second time.
  const ratio = renderer.getPixelRatio();
  const target = new WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), {
    type: HalfFloatType,
    depthTexture: new DepthTexture(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio)),
    // Multisampled, its depth resolved into the texture the occlusion reads
    // (three's `resolveDepthBuffer`). With SMAA alone, on the resolved image, a
    // lane line or a road's edge narrower than a pixel at a distance broke into
    // dots (the player, 2026-10-06): what was never sampled cannot be smoothed.
    samples: Math.min(4, renderer.capabilities.maxSamples),
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);
  const scenePass = new RenderPass(scene, camera);
  composer.addPass(scenePass);
  /**
   * The depth the scene was drawn with THIS frame. The composer ping-pongs
   * two targets and an odd number of swaps leaves it starting on the other
   * one next frame, so a pass bound to one target's depth read a stale or
   * empty buffer every other frame - the cloud shadows flickered on and off.
   */
  let sceneDepth: DepthTexture | null = target.depthTexture;
  {
    const draw = scenePass.render.bind(scenePass);
    scenePass.render = (...args: Parameters<RenderPass['render']>) => {
      sceneDepth = args[2].depthTexture;
      draw(...args);
    };
  }

  let gtao: GTAOPass | null = null;
  if (quality.ambientOcclusion) {
    gtao = new GTAOPass(scene, camera, size.x, size.y);
    gtao.output = GTAOPass.OUTPUT.Default;
    // Tuned for world units where a kerb is 0.4 high and a pier is 15 tall.
    // At a radius of 4 (1.6 m) the crease at every kerb's foot became a wide,
    // blotchy dark halo across the asphalt - a stain along every road edge,
    // worst where junction corners gather it. A crease is darkened over about
    // its own height; piers and buildings still read from the tighter pass.
    gtao.updateGtaoMaterial({
      radius: level === 'ultra' ? 1.3 : 1.0,
      distanceExponent: 1.6,
      thickness: 0.8,
      scale: 1.05,
      samples: level === 'ultra' ? 16 : 8,
      screenSpaceRadius: false,
    });
    gtao.blendIntensity = 0.85;
    // The occlusion is worked out from the depth the scene was just drawn
    // with (normals rebuilt from it). Left to itself the pass drew the whole
    // scene a second time, every mesh with an override material, for its own
    // depth and normals - a third full draw of the town each frame, with the
    // shadow map and the picture.
    const pass = gtao;
    const draw = pass.render.bind(pass);
    pass.render = (...args: Parameters<GTAOPass['render']>) => {
      const depth = args[2].depthTexture;
      if (depth && pass.depthTexture !== depth) pass.setGBuffer(depth);
      draw(...args);
    };
    // At half the resolution, as games do: occlusion is a soft shade, and
    // worked out per pixel at full size it cost as much as drawing the town.
    const resize = pass.setSize.bind(pass);
    pass.setSize = (width: number, height: number) => resize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
    composer.addPass(gtao);
    // GTAO's denoise shader is the slowest program to link on a cold start.
    // Submit both fullscreen programs now, while the rest of the game boots,
    // using the same depth input and target format as the first real pass.
    gtao.setGBuffer(target.depthTexture!);
    const quad = new BufferGeometry();
    quad.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    quad.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    const warm = new Scene();
    warm.add(new Mesh(quad, gtao.gtaoMaterial), new Mesh(quad, gtao.pdMaterial));
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(gtao.gtaoRenderTarget);
    void renderer.compileAsync(warm, camera).catch((error: unknown) => {
      console.error('Ambient occlusion shader precompile failed', error);
    }).finally(() => quad.dispose());
    renderer.setRenderTarget(previous);
  }

  // Light that is brighter than white spills a little round itself: the sun
  // on glass, lit windows and lamps at night. Only what is really bright
  // blooms; the day scene keeps its edges.
  const bloomStrength = level === 'ultra' ? 0.42 : 0.32;
  const bloom = new UnrealBloomPass(new Vector2(size.x, size.y), bloomStrength, 0.55, 0.92);
  bloom.enabled = false;
  composer.addPass(bloom);
  // Its shaders built now, in parallel (KHR_parallel_shader_compile), not at
  // the first dusk: the bloom is off by day, and the frame it first came on
  // stopped while its fourteen passes' programs were built. Compiled for one
  // of its own targets, as it draws them (render targets are part of a
  // program's key).
  {
    const quad = new PlaneGeometry();
    const warm = new Scene();
    for (const material of [bloom.materialHighPassFilter, ...bloom.separableBlurMaterials, bloom.compositeMaterial, bloom.blendMaterial]) {
      warm.add(new Mesh(quad, material));
    }
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(bloom.renderTargetsHorizontal[0]!);
    void renderer.compileAsync(warm, camera).catch(() => {}).finally(() => quad.dispose());
    renderer.setRenderTarget(previous);
  }
  // Cloud shadows: soft patches drifting over the land, on the linear image
  // before tone mapping. Each pixel's world position is rebuilt from the
  // depth the scene was drawn with, so the patches lie on the ground, the
  // roads and the roofs alike, and scroll with the wind.
  const clouds = quality.cloudShadows || quality.skyClouds ? new ShaderPass(CLOUD_SHADOWS) : null;
  let sky: Atmosphere = DEFAULT_ATMOSPHERE;
  let cloudClock = 0;
  const globePoint = new Vector3();
  if (clouds) {
    const pass = clouds;
    const shade = pass.render.bind(pass);
    pass.render = (...args: Parameters<ShaderPass['render']>) => {
      pass.uniforms['tDepth']!.value = sceneDepth;
      shade(...args);
    };
    composer.addPass(clouds);
  }
  const smaa = quality.smaa ? new SMAAPass() : null;
  if (smaa) composer.addPass(smaa);
  const output = new OutputPass();
  composer.addPass(output);
  // The grade, on the finished image: a film's contrast and colour.
  const grade = new ShaderPass(GRADE);
  (grade.uniforms['uSharpen'] as { value: number }).value = quality.sharpen;
  composer.addPass(grade);

  return {
    enabled: true,
    target,
    render(delta) {
      (grade.uniforms['uTime'] as { value: number }).value += delta;
      if (clouds) {
        camera.updateMatrixWorld();
        cloudClock += delta;
        (clouds.uniforms['uTime'] as { value: number }).value = cloudClock;
        const u = clouds.uniforms as Record<string, { value: unknown }>;
        const count = layClouds(sky, cloudClock, u['uCloud']!.value as Vector4[], u['uPuff']!.value as Vector4[], u['uLife']!.value as number[]);
        u['uCloudCount']!.value = count;
        // Laid over the plane, drawn over the globe (`planet.ts`).
        const onGlobe = (v: Vector4): void => {
          planetPoint(v.x, v.y, v.z, globePoint);
          v.set(globePoint.x, globePoint.y, globePoint.z, v.w);
        };
        for (let i = 0; i < count; i++) onGlobe((u['uCloud']!.value as Vector4[])[i]!);
        for (let i = 0; i < count * CLOUD_PUFFS; i++) onGlobe((u['uPuff']!.value as Vector4[])[i]!);
        (clouds.uniforms['uProjectionInverse'] as { value: Matrix4 }).value.copy(camera.projectionMatrixInverse);
        (clouds.uniforms['uCameraWorld'] as { value: Matrix4 }).value.copy(camera.matrixWorld);
      }
      composer.render(delta);
    },
    setNight(dark) {
      bloom.enabled = dark > 0.05;
      bloom.strength = bloomStrength * Math.min(1, dark);
      // No sun, no cloud shadow.
      if (clouds) (clouds.uniforms['uStrength'] as { value: number }).value = CLOUD_SHADOW_STRENGTH * Math.max(0, 1 - dark * 1.5);
      if (clouds) (clouds.uniforms['uDark'] as { value: number }).value = dark;
    },
    setGlobe(globe) {
      if (gtao) gtao.enabled = globe < 0.05;
    },
    setAtmosphere(atmosphere, sun, skyColor, sunLight, backdrop) {
      if (!clouds) return;
      sky = atmosphere;
      const u = clouds.uniforms as Record<string, { value: unknown }>;
      u['uBackdrop']!.value = backdrop ? 1 : 0;
      u['uCloudBase']!.value = atmosphere.cloudBase;
      (u['uSunLight']!.value as Color).copy(sunLight);
      u['uFog']!.value = atmosphere.fog;
      u['uFogHeight']!.value = Math.max(5, atmosphere.fogHeight);
      (u['uSunDir']!.value as Vector3).copy(sun).normalize();
      (u['uFogColor']!.value as Color).copy(skyColor);
    },
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      bloom.setSize(width, height);
    },
    dispose() {
      composer.dispose();
      target.dispose();
      gtao?.dispose();
      bloom.dispose();
      smaa?.dispose();
      output.dispose();
      grade.dispose();
      clouds?.dispose();
    },
  };
}

/** How much a cloud's shadow takes from the light under it at its heart. */
const CLOUD_SHADOW_STRENGTH = 0.55;


/** Most cumulus clouds over the map at once, and the puffs each is built of. */
const MAX_CLOUDS = 12;
const CLOUD_PUFFS = 7;

/**
 * Each cloud's puffs, in units of its size: across, up from the base, along,
 * radius. A cumulus is a flat-bottomed heap - a row of broad puffs on the
 * base, two smaller ones over them and a crown (the sphere clusters of Maxime
 * Heckel's "Real-time dreamy Cloudscapes" and the three.js volume cloud's
 * spherical mask).
 */
const PUFFS: readonly (readonly [number, number, number, number])[] = [
  [-0.46, 0.26, 0.02, 0.4],
  [0.0, 0.3, 0.06, 0.48],
  [0.46, 0.25, -0.04, 0.4],
  [-0.2, 0.58, 0.1, 0.37],
  [0.24, 0.56, -0.08, 0.35],
  [0.02, 0.8, 0.0, 0.3],
  [0.12, 0.36, 0.38, 0.33],
];

/** Units a second the clouds drift with the wind (some 10 m/s). */
const CLOUD_DRIFT = new Vector2(24, 9);
/** Seconds a cloud lives, from its first wisps to its last, at the least and the most. */
const CLOUD_LIFE: readonly [number, number] = [80, 150];

/** 0..1 hash of an integer and a salt (the same clouds every visit). */
function cloudHash(i: number, salt: number): number {
  let h = Math.imul(i + 1, 374_761_393) ^ Math.imul(salt, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/**
 * Lays the clouds out for this moment: as many as the player's cover asks
 * for, scattered over the map and a little past its edges, drifting with
 * the wind and wrapping round so the sky never empties. Each LIVES: it
 * condenses out of wisps, grows, holds, and is worn away again, and in its
 * place another forms somewhere else (each slot's clouds out of step with
 * the others', so the sky is always some forming and some fading). Writes
 * each cloud's bounding sphere (centre, size), its puffs (world centre,
 * radius) and how far through its life it is (0 none, 1 grown).
 */
function layClouds(atmosphere: Atmosphere, time: number, bounds: Vector4[], puffs: Vector4[], lives: number[]): number {
  const count = Math.min(MAX_CLOUDS, Math.round(atmosphere.clouds * MAX_CLOUDS));
  // Over the map only: a cloud past its edge hung in the empty space round
  // the diorama like a snowball (the player, 2026-10-07). It fades out
  // before it gets there, and wraps round unseen.
  const span = MAP_SIZE * 0.9;
  const wrap = (v: number): number => ((((v + span / 2) % span) + span) % span) - span / 2;
  const ease = (v: number): number => { const t = Math.min(1, Math.max(0, v)); return t * t * (3 - 2 * t); };
  for (let i = 0; i < count; i++) {
    const life = CLOUD_LIFE[0] + (CLOUD_LIFE[1] - CLOUD_LIFE[0]) * cloudHash(i, 10);
    const age = time / life + cloudHash(i, 11);
    const generation = Math.floor(age);
    const phase = age - generation;
    // A new cloud every generation, out of the slot's own sequence.
    const id = i + generation * 131;
    const x = wrap((cloudHash(id, 1) - 0.5) * span + CLOUD_DRIFT.x * time);
    const z = wrap((cloudHash(id, 2) - 0.5) * span + CLOUD_DRIFT.y * time);
    const edge = 1 - ease((Math.max(Math.abs(x), Math.abs(z)) - span * 0.3) / (span * 0.17));
    lives[i] = ease(phase / 0.3) * (1 - ease((phase - 0.62) / 0.38)) * edge;
    // It thins into wisps as it forms and fades, at nearly its full size: a
    // cloud that shrank as it went was a small bright ball.
    const grown = 0.85 + 0.15 * lives[i]!;
    // Its size from the thickness the player set: a cumulus about twice as wide as tall.
    const size = Math.max(40, atmosphere.cloudThickness) * (0.85 + 0.55 * cloudHash(id, 3));
    const base = atmosphere.cloudBase + (cloudHash(id, 4) - 0.5) * size * 0.3;
    const yaw = cloudHash(id, 5) * Math.PI * 2;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    bounds[i]!.set(x, base + size * 0.5, z, size * 1.12);
    for (let k = 0; k < CLOUD_PUFFS; k++) {
      const [a, up, b, r] = PUFFS[k]!;
      const ja = a + (cloudHash(id * 11 + k, 6) - 0.5) * 0.16;
      const jb = b + (cloudHash(id * 11 + k, 7) - 0.5) * 0.16;
      const jr = r * (0.88 + 0.24 * cloudHash(id * 11 + k, 8)) * grown;
      puffs[i * CLOUD_PUFFS + k]!.set(x + (ja * c - jb * sn) * size, base + up * size * grown, z + (ja * sn + jb * c) * size, jr * size);
    }
  }
  return count;
}

/**
 * THE ATMOSPHERE, on the image (the player sets it: Paisagem > Céu e clima):
 *
 *  - CUMULUS CLOUDS, each its own heap over the map: puffs joined by a
 *    smooth union, their rims eaten by 3-D noise (the sphere-plus-fbm density
 *    of Heckel's cloudscapes), a flat base; lit by the directional derivative
 *    towards the sun (brighter where the cloud thins sunwards), absorbed by
 *    Beer's law. Marched only where the ray crosses a cloud's bounding
 *    sphere, nearest first, and faded within its own size of the camera, so a
 *    cloud is never a wall in front of it (the player, 2026-10-07).
 *  - Their SHADOWS: from each pixel towards the sun through the clouds'
 *    smooth shapes, one big soft shadow where the sun throws each cloud's.
 *  - MIST: exponential height fog, thickest in the low ground.
 *
 * Every pixel's world position is rebuilt from the depth the scene was drawn
 * with (the composer swaps its targets, so the depth is captured per frame).
 */
const CLOUD_SHADOWS = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uProjectionInverse: { value: new Matrix4() },
    uCameraWorld: { value: new Matrix4() },
    uTime: { value: 0 },
    uStrength: { value: CLOUD_SHADOW_STRENGTH },
    uDark: { value: 0 },
    uCloudCount: { value: 0 },
    uCloud: { value: Array.from({ length: MAX_CLOUDS }, () => new Vector4()) },
    uPuff: { value: Array.from({ length: MAX_CLOUDS * CLOUD_PUFFS }, () => new Vector4()) },
    uLife: { value: Array.from({ length: MAX_CLOUDS }, () => 0) },
    uCloudBase: { value: DEFAULT_ATMOSPHERE.cloudBase },
    uFog: { value: DEFAULT_ATMOSPHERE.fog },
    uFogHeight: { value: DEFAULT_ATMOSPHERE.fogHeight },
    uSunDir: { value: new Vector3(0.5, 0.8, 0.3).normalize() },
    uSunLight: { value: new Color(3, 2.8, 2.5) },
    uFogColor: { value: new Color(0xc9dcea) },
    uBackdrop: { value: 0 },
    planetBend: PLANET_SHADER.uniform,
    planetSpin: PLANET_SHADER.spin,
    // The void round the map: its deep blue, the paler air towards the
    // horizon, and the abyss below (sRGB, as the page's own colours).
    uSkyDeep: { value: new Color(0x0c1a2c) },
    uSkyGlow: { value: new Color(0x3d5a82) },
    uSkyLow: { value: new Color(0x0a1830) },
    // The sky seen from near the ground: pale at the horizon, deeper above.
    // Sky blue, not grey (the player, 2026-10-07): a clear pale blue at
    // the horizon, a deep clear blue above.
    uSkyHorizon: { value: new Color(0x86bdf0) },
    uSkyHigh: { value: new Color(0x2a66c8) },
    uAbyss: { value: new Color(0x1e160f) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    #define MAX_CLOUDS ${MAX_CLOUDS}
    #define PUFFS ${CLOUD_PUFFS}
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform mat4 uProjectionInverse;
    uniform mat4 uCameraWorld;
    uniform float uTime;
    uniform float uStrength;
    uniform float uDark;
    uniform int uCloudCount;
    uniform vec4 uCloud[MAX_CLOUDS];
    uniform vec4 uPuff[MAX_CLOUDS * PUFFS];
    uniform float uLife[MAX_CLOUDS];
    uniform float uCloudBase;
    uniform float uFog;
    uniform float uFogHeight;
    uniform vec3 uSunDir;
    uniform vec3 uSunLight;
    uniform vec3 uFogColor;
    uniform float uBackdrop;
    uniform vec4 planetBend;
    // Height over the ground's base level: over the globe, out from its centre.
    float altitude(vec3 p) {
      return planetBend.x > 0.0 ? length(p + vec3(0.0, planetBend.x, 0.0)) - planetBend.x : p.y;
    }
    uniform vec3 uSkyDeep;
    uniform vec3 uSkyGlow;
    uniform vec3 uSkyLow;
    uniform vec3 uSkyHorizon;
    uniform vec3 uSkyHigh;
    uniform vec3 uAbyss;
    varying vec2 vUv;
    vec3 worldAt(vec2 uv, float depth) {
      vec4 view = uProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      return (uCameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
    }
    // Where a ray enters and leaves a sphere (both negative: it misses).
    vec2 sphereSpan(vec3 ro, vec3 rd, vec4 s) {
      vec3 oc = ro - s.xyz;
      float b = dot(oc, rd);
      float h = b * b - (dot(oc, oc) - s.w * s.w);
      if (h < 0.0) return vec2(-1.0);
      h = sqrt(h);
      return vec2(-b - h, -b + h);
    }
    float smin(float a, float b, float k) {
      float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
      return mix(b, a, h) - k * h * (1.0 - h);
    }
    float hash3(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float noise3(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0)), f.x), f.y),
        f.z);
    }
    // The heap's smooth shape: how far inside it a point is, in its own size (> 0 inside).
    float heap(int c, vec3 p) {
      float size = uCloud[c].w;
      float d = 1e5;
      for (int k = 0; k < PUFFS; k++) {
        vec4 s = uPuff[c * PUFFS + k];
        // Each puff a little flattened, and joined wide: one heap with a
        // lumpy top, not a bunch of balls.
        vec3 o = p - s.xyz;
        o.y *= 1.3;
        d = smin(d, length(o) - s.w, size * 0.2);
      }
      // A flat base: the cloud stops at its condensation level.
      float base = smoothstep(uCloudBase - size * 0.12, uCloudBase + size * 0.08, altitude(p));
      return -d / size * base;
    }
    // Its density, as Horizon Zero Dawn's clouds are built (Schneider; the
    // TerrainEngine-OpenGL shader after it): a soft base shape - the heap
    // ramped over a wide band, its outline broken by large noise - and then
    // ERODED by fine billowy noise, remapped so the erosion eats the thin
    // edge away into wisps while the dense heart stays whole; wispy towards
    // the base, billowy towards the top. The noise only takes away, never
    // adds, so nothing lies past the heap's surface and no cloud is cut off
    // by its bounding sphere.
    float cloudDensity(int c, vec3 p) {
      float size = uCloud[c].w;
      // The billows boil: they rise and turn over as the cloud lives.
      vec3 drift = vec3(uTime * 0.05, -uTime * 0.04, uTime * 0.02);
      float life = uLife[c];
      vec3 q = p / (size * 0.3) + drift;
      float low = noise3(q) * 0.5 + noise3(q * 2.03 + 5.1) * 0.3 + noise3(q * 4.1 + 9.7) * 0.2;
      // The outline broken by that noise, deep enough that no puff keeps a
      // sphere's clean edge.
      float shape = clamp(heap(c, p) * 3.2 - (1.0 - low) * (0.55 + 0.4 * (1.0 - life)) - (1.0 - life) * 0.8, 0.0, 1.0);
      if (shape <= 0.0) return 0.0;
      vec3 r = p / (size * 0.055) + drift * 2.3;
      float b1 = 1.0 - abs(noise3(r) * 2.0 - 1.0);
      float b2 = 1.0 - abs(noise3(r * 2.13 + 3.3) * 2.0 - 1.0);
      float detail = b1 * 0.65 + b2 * 0.35;
      float up = clamp((altitude(p) - uCloudBase) / size, 0.0, 1.0);
      detail = mix(1.0 - detail, detail, clamp(up * 3.0, 0.0, 1.0));
      // remap(base, detail * 0.35, 1, 0, 1): the heart (1) stays whole, the
      // thin edge is worn into wisps.
      float erode = detail * (0.55 + 0.3 * (1.0 - life));
      return clamp((shape - erode) / (1.0 - erode), 0.0, 1.0);
    }
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;
      bool sky = depth >= 0.9999;
      vec3 ro = worldAt(vUv, 0.0);
      vec3 hit = worldAt(vUv, sky ? 0.99999 : depth);
      vec3 rd = normalize(hit - ro);
      float tScene = sky ? 1e7 : length(hit - ro);
      vec3 colour = src.rgb;
      // The clouds' shadows: from the point towards the sun, through each heap.
      if (!sky && uStrength > 0.0 && uCloudCount > 0) {
        float through = 0.0;
        for (int c = 0; c < MAX_CLOUDS; c++) {
          if (c >= uCloudCount) break;
          vec2 span = sphereSpan(hit, uSunDir, uCloud[c]);
          if (span.y <= 0.0) continue;
          float a = max(span.x, 0.0);
          float len = (span.y - a) / 5.0;
          for (int i = 0; i < 5; i++) {
            through += clamp(heap(c, hit + uSunDir * (a + (float(i) + 0.5) * len)) * 3.0 - (1.0 - uLife[c]) * 1.2, 0.0, 1.0) * len / uCloud[c].w;
          }
        }
        colour *= 1.0 - uStrength * (1.0 - exp(-through * 3.5));
      }
      // Mist: exponential in height, along the ray to what the pixel sees.
      if (uFog > 0.0) {
        float dist = min(tScene, 6000.0);
        float yMid = ro.y + rd.y * dist * 0.5;
        float thickness = exp(-max(0.0, min(yMid, altitude(hit))) / uFogHeight);
        float amount = 1.0 - exp(-uFog * 0.0009 * dist * thickness);
        vec3 mist = mix(uFogColor, uFogColor * 0.18, uDark);
        colour = mix(colour, mist, clamp(amount, 0.0, 0.95));
      }
      // THE AIR round the map while it is built, seen as a model over the
      // void (the player, 2026-10-07). The path a ray takes through the air
      // grows towards the horizon - Preetham's optical length, as three's Sky
      // has it - so the backdrop pales there, round the map's edge, and deepens
      // up and further still down into the abyss. And the land beyond the
      // middle of the view takes on that air, L0 e^(-b s) plus the air's own
      // light (the aerial perspective of Preetham and of Hillaire's
      // atmosphere), by the real distance, so the far edge melts into the
      // pale horizon from afar and ground seen close up stays clear. The backdrop hangs on the view's direction, as a
      // sky infinitely far: the map slides over it, and it turns only with the
      // camera - its parallax.
      if (uBackdrop > 0.5 && planetBend.x > 0.0) {
        // ON A PLANET the air is a shell round the globe, and each pixel
        // takes on the air its ray crosses inside the shell (the in-scattering
        // and extinction along the ray of Preetham's and Hillaire's
        // atmospheres): from the street the horizon pales and nearby ground
        // stays clear; from space the globe is clear and its limb glows,
        // ringed by the lit air, against the dark.
        float R = planetBend.x;
        vec3 centre = vec3(0.0, -R, 0.0);
        vec2 shell = sphereSpan(ro, rd, vec4(centre, R + 1100.0));
        float enter = max(shell.x, 0.0);
        float path = shell.y > 0.0 ? max(0.0, (sky ? shell.y : tScene) - enter) : 0.0;
        float sunSide = pow(max(dot(rd, uSunDir), 0.0), 3.0);
        vec3 haze = mix(uSkyGlow, uSkyGlow * vec3(1.4, 1.18, 0.9), sunSide * 0.6) * (1.0 - 0.85 * uDark);
        // How far out into space the eye is: the sky goes from the day's
        // blue to the dark of space round the whole planet.
        float altitude = length(ro - centre) - R;
        float space = smoothstep(1500.0, 9000.0, altitude);
        if (sky) {
          float veil = noise3(rd * 4.0 + 3.1) * 0.6 + noise3(rd * 9.0 + 7.7) * 0.4;
          vec3 inside = mix(uSkyDeep * (0.88 + 0.24 * veil), haze * 1.2, 1.0 - exp(-path / 5000.0));
          // From space: the air's glow at the limb, thickest where the ray
          // grazes the ground and fading out with height (an exponential
          // atmosphere, Chapman's grazing column: exp(-h / H)).
          vec3 toCentre = centre - ro;
          float along = dot(toCentre, rd);
          float graze = along > 0.0 ? length(toCentre - rd * along) - R : altitude;
          float limb = exp(-max(graze, 0.0) / 380.0);
          vec3 outside = vec3(0.0015, 0.002, 0.006) + haze * 1.3 * limb;
          colour = mix(inside, outside, space);
        } else {
          float far = max(0.0, path - 2200.0);
          colour = mix(colour, haze, (1.0 - exp(-far / 9000.0)) * 0.55);
        }
      } else if (uBackdrop > 0.5) {
        float zen = acos(clamp(abs(rd.y), 0.0, 1.0));
        float air = 1.0 / (cos(zen) + 0.15 * pow(max(93.885 - degrees(zen), 1e-3), -1.253));
        float glow = 1.0 - exp(-air * 0.12);
        float sunSide = pow(max(dot(rd, uSunDir), 0.0), 3.0);
        vec3 haze = mix(uSkyGlow, uSkyGlow * vec3(1.4, 1.18, 0.9), sunSide * 0.6) * (1.0 - 0.85 * uDark);
        // Brought down near the ground the view gets a SKY: pale blue at the
        // horizon deepening upwards (the player, 2026-10-07: "azul mais
        // clarinho com transição para o mais escuro, só quando der zoom");
        // from high over the map it stays the dark blue round the model.
        float low = 1.0 - smoothstep(600.0, 1800.0, ro.y);
        vec3 horizon = mix(uSkyHorizon, uSkyHorizon * vec3(1.12, 1.04, 0.92), sunSide * 0.5) * (1.0 - 0.85 * uDark);
        vec3 overhead = uSkyHigh * (1.0 - 0.7 * uDark);
        haze = mix(haze, horizon, low);
        if (sky) {
          vec3 backdrop = mix(uSkyDeep, haze, glow);
          backdrop = mix(backdrop, mix(horizon, overhead, smoothstep(0.0, 0.5, rd.y)), low * step(0.0, rd.y));
          // Below the horizon: a deeper blue at once, going down into the
          // earth's own dark brown (the player, 2026-10-07).
          backdrop = mix(backdrop, uSkyLow, smoothstep(0.0, 0.3, -rd.y) * 0.85);
          backdrop = mix(backdrop, uAbyss, smoothstep(0.18, 0.8, -rd.y) * 0.9);
          // A faint veil of high haze, fixed in the sky.
          float veil = noise3(rd * 4.0 + 3.1) * 0.6 + noise3(rd * 9.0 + 7.7) * 0.4;
          colour = backdrop * (0.88 + 0.24 * veil);
        } else {
          // By the real distance, as air is: the whole map seen from afar
          // takes it on, ground seen close up none (the player, 2026-10-07).
          float far = max(0.0, tScene - 2200.0);
          float amount = (1.0 - exp(-far / 9000.0)) * 0.55;
          colour = mix(colour, haze * (1.0 + 0.6 * glow), amount);
        }
      }
      // The clouds, nearest first.
      if (uCloudCount > 0) {
        float focusDepth = texture2D(tDepth, vec2(0.5)).r;
        float tFocus = focusDepth >= 0.9999 ? 1e5 : length(worldAt(vec2(0.5), focusDepth) - ro);
        // Drawn from up close only: from far enough to take in the whole
        // diorama every cloud stands out against the empty space round it,
        // a ball hanging in the void (the player, 2026-10-07); there only
        // their shadows cross the land.
        // How tall the view is there, in world units: the same measure in
        // the orthographic view and in perspective (both ends of the
        // screen's middle column at the depth of its centre).
        float spanFocus = focusDepth >= 0.9999 ? 1e5 : length(worldAt(vec2(0.5, 1.0), focusDepth) - worldAt(vec2(0.5, 0.0), focusDepth));
        float bodies = 1.0 - smoothstep(1400.0, 2400.0, spanFocus);
        vec2 spans[MAX_CLOUDS];
        for (int c = 0; c < MAX_CLOUDS; c++) {
          spans[c] = vec2(-1.0);
          if (c < uCloudCount) spans[c] = sphereSpan(ro, rd, uCloud[c]);
        }
        float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        float transmit = 1.0;
        vec3 light = vec3(0.0);
        // Lit by the sun on its sunward side, by the sky elsewhere; dim at night.
        vec3 skyLight = mix(uFogColor * 0.55 + vec3(0.12), vec3(0.03, 0.035, 0.05), uDark);
        vec3 baseShade = mix(vec3(0.22, 0.24, 0.3), vec3(0.02, 0.025, 0.035), uDark);
        float done = -1.0;
        for (int pass = 0; pass < MAX_CLOUDS; pass++) {
          if (pass >= uCloudCount || transmit < 0.03 || bodies <= 0.0) break;
          int best = -1;
          float bestKey = 1e9;
          for (int c = 0; c < MAX_CLOUDS; c++) {
            if (c >= uCloudCount || spans[c].y <= 0.0) continue;
            float key = max(spans[c].x, 0.0) + float(c) * 0.001;
            if (key > done && key < bestKey) { bestKey = key; best = c; }
          }
          if (best < 0) break;
          done = bestKey;
          float size = uCloud[best].w;
          float t0 = max(spans[best].x, 0.0);
          float t1 = min(spans[best].y, tScene);
          if (t1 <= t0) continue;
          const int STEPS = 24;
          float stepLen = (t1 - t0) / float(STEPS);
          for (int i = 0; i < STEPS; i++) {
            float t = t0 + (float(i) + jitter) * stepLen;
            vec3 q = ro + rd * t;
            float density = cloudDensity(best, q);
            // Never in front of the camera (the player, 2026-10-07): a cloud
            // nearer than most of the way to the ground the view looks at
            // (the middle of the screen) fades out, and always within its own
            // size of the eye - so none hangs between the eye and the land.
            float near = max(size * 1.1, tFocus * 0.85);
            density *= smoothstep(near * 0.45, near, t) * bodies;
            if (density < 0.01) continue;
            // The sun's light reaching this point: a short march towards it
            // through the cloud itself (Horizon Zero Dawn's light samples,
            // Beer's law), so every billow shades its neighbours - bright
            // crowns, grey hollows and undersides - and the heap's smooth
            // form facing the sun on top of it.
            float towards = cloudDensity(best, q + uSunDir * size * 0.06) * 0.06
              + cloudDensity(best, q + uSunDir * size * 0.18) * 0.12;
            float sunT = exp(-towards * size * 0.02 * 2.2);
            float facing = smoothstep(-0.05, 0.1, heap(best, q) - heap(best, q + uSunDir * size * 0.16));
            float lit = sunT * mix(0.55, 1.0, facing);
            float up = clamp((altitude(q) - uCloudBase) / size, 0.0, 1.0);
            vec3 c = mix(baseShade, skyLight, 0.25 + 0.75 * up) * 0.85 + uSunLight * 0.36 * lit * (1.0 - uDark);
            // Little extinction: the eroded edge is a veil the land shows through.
            float alpha = 1.0 - exp(-density * stepLen * 0.015);
            light += transmit * alpha * c;
            transmit *= 1.0 - alpha;
            if (transmit < 0.03) break;
          }
        }
        colour = colour * transmit + light;
      }
      gl_FragColor = vec4(colour, src.a);
    }
  `,
};

/**
 * A film grade on the display image: a gentle S-curve of contrast, colour
 * kept rich without neon (vibrance lifts the dull colours more than the
 * strong), warm light and cool shade (split toning), a vignette that holds
 * the eye in the frame, and a grain too fine to see as noise, which keeps
 * large flat areas of road and roof from looking like plastic.
 */
const GRADE = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSharpen: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uSharpen;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      // SHARPENING, AMD FidelityFX CAS (ffx_cas.h, the sharpen-only path):
      // each pixel against the cross of its neighbours, weighted down where
      // the local contrast is already high, so detail comes out crisp
      // without halos or noise.
      if (uSharpen > 0.0) {
        vec2 texel = 1.0 / vec2(textureSize(tDiffuse, 0));
        vec3 b = texture2D(tDiffuse, vUv + vec2(0.0, -texel.y)).rgb;
        vec3 d = texture2D(tDiffuse, vUv + vec2(-texel.x, 0.0)).rgb;
        vec3 f = texture2D(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb;
        vec3 h = texture2D(tDiffuse, vUv + vec2(0.0, texel.y)).rgb;
        vec3 mn = min(min(min(d, c), min(f, b)), h);
        vec3 mx = max(max(max(d, c), max(f, b)), h);
        vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
        float w = amp.g * (-1.0 / mix(8.0, 5.0, uSharpen));
        c = clamp(((b + d + f + h) * w + c) / (1.0 + 4.0 * w), 0.0, 1.0);
      }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Contrast, an S round the middle grey.
      c = mix(c, smoothstep(0.0, 1.0, c), 0.25);
      // Vibrance: the dull colours gain more than the vivid.
      float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
      float sat = mx - mn;
      c = mix(vec3(l), c, 1.0 + 0.3 * (1.0 - sat));
      // Split toning: warm highlights, cool shadows.
      // Warm light, shadows left neutral: a blue push in them read as a
      // teal cast over every shaded slope.
      c += mix(vec3(0.0), vec3(0.02, 0.008, -0.014), smoothstep(0.15, 0.85, l));
      // Vignette.
      vec2 d = vUv - 0.5;
      c *= mix(1.0, 0.78, smoothstep(0.3, 0.85, dot(d, d) * 2.4));
      // Film grain.
      c += (hash(vUv * 1024.0 + fract(uTime) * 61.0) - 0.5) * 0.018;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
    }
  `,
};
