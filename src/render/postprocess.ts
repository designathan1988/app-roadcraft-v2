import {
  BufferGeometry, Color, DepthTexture, Float32BufferAttribute, HalfFloatType, Matrix4, Mesh, NoBlending,
  PlaneGeometry, Scene, ShaderMaterial, Vector2, Vector3, Vector4, WebGLRenderTarget, type Camera, type Texture, type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { MAP_SIZE } from '@world/bounds';
import { driftedCloud, type PlacedCloud } from '@world/clouds';
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
   * How much of the light on the ground comes straight from the sun
   * (`SceneEnvironment.directShare`): all a cloud's shadow can take away.
   */
  setDirectShare(share: number): void;
  /**
   * The sky the player set (`Atmosphere`), the light it is lit by, and
   * whether the map is seen as a model over the void (building it), when
   * the air round it is drawn too: the backdrop and the haze of distance.
   */
  setAtmosphere(atmosphere: Atmosphere, sun: Vector3, skyColor: Color, sunLight: Color, backdrop: boolean,
    /** How far in front of the camera the view's equivalent eye stands (`uEyeShift`): 0 in perspective. */
    eyeShift?: number): void;
  /** The clouds the player placed (`world/clouds.ts`). */
  setPlacedClouds(clouds: readonly PlacedCloud[]): void;
  /** How far the wind has carried the clouds, on the map (`world/clouds.ts` driftedCloud). */
  setCloudDrift(x: number, y: number): void;
  /**
   * The painted fog (`render/fogLayer.ts`): its map, the slab of ground it
   * lies over, and the map's settings - or none.
   */
  setGroundFog(fog: { texture: Texture; low: number; high: number; density: number } | null): void;
  dispose(): void;
}

/**
 * The player's sky (Paisagem > Céu e clima): how much of it is cloud, at
 * what height and how thick the layer is, and how much mist lies over the
 * land and how high it reaches. World units.
 */
export interface Atmosphere {
  /**
   * How much of the sky the old setting covered (0..1). The sky draws only
   * the map's own clouds now (`world/clouds.ts`); a cover still kept is
   * turned into clouds of the map once (`main.ts`).
   */
  readonly clouds: number;
  readonly cloudBase: number;
  readonly cloudThickness: number;
  /** 0 none (the default: the map seen clear), 1 a thick mist. */
  readonly fog: number;
  readonly fogHeight: number;
}
export const DEFAULT_ATMOSPHERE: Atmosphere = { clouds: 0.4, cloudBase: 450, cloudThickness: 375, fog: 0, fogHeight: 150 };

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
      setDirectShare() {
        /* no cloud shadows without the chain */
      },
      setAtmosphere() {
        /* no clouds or mist without the chain */
      },
      setGroundFog() {
        /* no painted fog without the chain */
      },
      setCloudDrift() {},
      setPlacedClouds() {
        /* no clouds without the chain */
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
  let cloudClock = 0;
  let placedClouds: readonly PlacedCloud[] = [];
  const cloudDrift = { x: 0, y: 0 };
  /** The clouds' bodies at a quarter of the pixels (`CLOUD_BODIES_MAIN`), drawn just before the pass that blends them in. */
  const bodiesSize = (n: number): number => Math.max(1, Math.ceil(n / 2));
  // Two, one written each frame while the other is read as its history (`uHistory`).
  const bodiesTargets = [0, 1].map(() => new WebGLRenderTarget(bodiesSize(size.x * ratio), bodiesSize(size.y * ratio), { type: HalfFloatType, depthBuffer: false }));
  let bodiesWrite = 0;
  /** Whether the target not written this frame holds the last frame's clouds, for this same view. */
  let historyValid = false;
  /** The view the history was made from: the camera's world matrix and projection, as last drawn. */
  const lastView = new Matrix4(), lastProjection = new Matrix4();
  let cloudFrame = 0;
  /** Whether the last frame drew any cloud (a history of nothing is none). */
  let hadClouds = false;
  let bodiesQuad: FullScreenQuad | null = null;
  // The clouds' shadow map (`CLOUD_SHADOW_MAP_MAIN`): drawn once a frame, read once a pixel.
  const shadowMapTarget = new WebGLRenderTarget(CLOUD_SHADOW_MAP, CLOUD_SHADOW_MAP, { type: HalfFloatType, depthBuffer: false });
  let shadowMapQuad: FullScreenQuad | null = null;
  if (clouds) {
    const pass = clouds;
    const fragment = CLOUD_SHADOWS.fragmentShader;
    const functions = fragment.slice(0, fragment.indexOf('void main()'));
    bodiesQuad = new FullScreenQuad(new ShaderMaterial({
      uniforms: pass.uniforms, vertexShader: CLOUD_SHADOWS.vertexShader,
      fragmentShader: functions + CLOUD_BODIES_MAIN,
      blending: NoBlending, depthTest: false, depthWrite: false,
    }));
    shadowMapQuad = new FullScreenQuad(new ShaderMaterial({
      uniforms: pass.uniforms, vertexShader: CLOUD_SHADOWS.vertexShader,
      fragmentShader: functions + CLOUD_SHADOW_MAP_MAIN,
      blending: NoBlending, depthTest: false, depthWrite: false,
    }));
    pass.uniforms['tCloudShadow']!.value = shadowMapTarget.texture;
    const quad = bodiesQuad;
    const mapQuad = shadowMapQuad;
    const shade = pass.render.bind(pass);
    pass.render = (...args: Parameters<ShaderPass['render']>) => {
      pass.uniforms['tDepth']!.value = sceneDepth;
      const on = (pass.uniforms['uCloudCount']!.value as number) > 0;
      pass.uniforms['uCloudsOn']!.value = on ? 1 : 0;
      const gl = args[0];
      if (on && (pass.uniforms['uShadowMapOn']!.value as number) > 0.5 && (pass.uniforms['uStrength']!.value as number) > 0) {
        const previous = gl.getRenderTarget();
        gl.setRenderTarget(shadowMapTarget);
        mapQuad.render(gl);
        gl.setRenderTarget(previous);
      }
      if (on) {
        // With the view still, fewer steps and the last frame blended in
        // (Playdead's TAA feedback); moving, the full steps and no history -
        // nothing is carried across a change of view, so nothing trails.
        const u = pass.uniforms as Record<string, { value: unknown }>;
        const still = historyValid;
        u['uSteps']!.value = still ? CLOUD_STEPS_STILL : CLOUD_STEPS_MOVING;
        u['uHistory']!.value = still ? CLOUD_HISTORY : 0;
        u['uFrame']!.value = still ? cloudFrame++ % 4096 : 0;
        const write = bodiesTargets[bodiesWrite]!, read = bodiesTargets[1 - bodiesWrite]!;
        u['tCloudHistory']!.value = read.texture;
        const previous = gl.getRenderTarget();
        gl.setRenderTarget(write);
        quad.render(gl);
        gl.setRenderTarget(previous);
        u['tClouds']!.value = write.texture;
        bodiesWrite = 1 - bodiesWrite;
      }
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

  // A cloud's shadow takes the sun's direct light and leaves the sky's
  // (global = diffuse + direct * cos(zenith)): its strength is the direct
  // share, none by night. A fixed 0.62 took more than the whole sun gives in
  // the morning (some a fifth of the light at 06:30), and from the map's
  // zoom the land was covered in near-black blotches (2026-10-08).
  let night = 0;
  let directShare = CLOUD_SHADOW_STRENGTH;
  const shadowStrength = (): number => directShare * Math.max(0, 1 - night * 1.5);

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
        const count = layClouds(u['uCloud']!.value as Vector4[], u['uPuff']!.value as Vector4[], u['uLife']!.value as number[], u['uBase']!.value as number[], u['uShow']!.value as number[], placedClouds, cloudDrift);
        u['uCloudCount']!.value = count;
        const plane = cloudShadowFrame(u['uCloud']!.value as Vector4[], u['uBase']!.value as number[], count,
          u['uSunDir']!.value as Vector3, u['uShadowRect']!.value as Vector4);
        u['uShadowMapOn']!.value = plane === null ? 0 : 1;
        if (plane !== null) u['uShadowPlane']!.value = plane;
        (clouds.uniforms['uProjectionInverse'] as { value: Matrix4 }).value.copy(camera.projectionMatrixInverse);
        (clouds.uniforms['uCameraWorld'] as { value: Matrix4 }).value.copy(camera.matrixWorld);
        // The history holds for the same view only: the last frame drew
        // clouds, from this camera, at this size.
        const same = camera.matrixWorld.equals(lastView) && camera.projectionMatrix.equals(lastProjection);
        historyValid = same && count > 0 && hadClouds;
        hadClouds = count > 0;
        lastView.copy(camera.matrixWorld);
        lastProjection.copy(camera.projectionMatrix);
        // Nothing of it shows - no cloud, no mist, no painted fog, no air round
        // the map: the pass is skipped, not run over every pixel for nothing.
        clouds.enabled = count > 0 || (u['uFog']!.value as number) > 0 || (u['uGroundFog']!.value as Vector4).w > 0.5
          || (u['uBackdrop']!.value as number) > 0.5;
      }
      composer.render(delta);
    },
    setNight(dark) {
      bloom.enabled = dark > 0.05;
      bloom.strength = bloomStrength * Math.min(1, dark);
      night = dark;
      if (clouds) (clouds.uniforms['uStrength'] as { value: number }).value = shadowStrength();
      if (clouds) (clouds.uniforms['uDark'] as { value: number }).value = dark;
    },
    setDirectShare(share) {
      if (Math.abs(share - directShare) < 0.005) return;
      directShare = share;
      if (clouds) (clouds.uniforms['uStrength'] as { value: number }).value = shadowStrength();
    },
    setPlacedClouds(clouds) {
      placedClouds = clouds;
    },
    setCloudDrift(x, y) {
      cloudDrift.x = x;
      cloudDrift.y = y;
    },
    setGroundFog(fog) {
      if (!clouds) return;
      const u = clouds.uniforms as Record<string, { value: unknown }>;
      if (!fog) { (u['uGroundFog']!.value as Vector4).set(0, 0, 0, 0); return; }
      u['tGroundFog']!.value = fog.texture;
      (u['uGroundFog']!.value as Vector4).set(fog.density, 0, 0, 1);
      (u['uGroundFogSlab']!.value as Vector2).set(fog.low - 2, fog.high);
    },
    setAtmosphere(atmosphere, sun, skyColor, sunLight, backdrop, eyeShift = 0) {
      if (!clouds) return;
      const u = clouds.uniforms as Record<string, { value: unknown }>;
      u['uBackdrop']!.value = backdrop ? 1 : 0;
      u['uEyeShift']!.value = eyeShift;
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
      for (const t of bodiesTargets) t.setSize(bodiesSize(width * pixelRatio), bodiesSize(height * pixelRatio));
      historyValid = false;
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
      (bodiesQuad?.material as ShaderMaterial | undefined)?.dispose();
      for (const t of bodiesTargets) t.dispose();
      (shadowMapQuad?.material as ShaderMaterial | undefined)?.dispose();
      shadowMapTarget.dispose();
    },
  };
}

/** How much a cloud's shadow takes from the light under it at its heart, until the light's direct share is known (`setDirectShare`). */
const CLOUD_SHADOW_STRENGTH = 0.62;


/** Most cumulus clouds over the map at once, and the puffs each is built of. */
const MAX_CLOUDS = 24;
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

/** 0..1 hash of an integer and a salt (the same puffs every visit). */
function cloudHash(i: number, salt: number): number {
  let h = Math.imul(i + 1, 374_761_393) ^ Math.imul(salt, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/**
 * Lays the clouds out: the map's own, each where the player put it or the
 * sky's spreader laid it (`world/clouds.ts`), whole. The sky invents none of
 * its own - every cloud can be moved, set and taken away (the player,
 * 2026-10-07). Writes each cloud's bounding sphere (centre, size), its puffs
 * (world centre, radius) and how grown it is (1).
 */
function layClouds(bounds: Vector4[], puffs: Vector4[], lives: number[], bases: number[], shows: number[], placed: readonly PlacedCloud[], drift: { x: number; y: number }): number {
  let slot = 0;
  for (const cloud of placed) {
    if (slot >= MAX_CLOUDS) break;
    // Where the wind has carried it, thinning away near the edge it wraps round.
    // The thinning scales its DENSITY (`uShow`: Beer-Lambert, the optical
    // depth goes with the concentration, so the whole cloud fades evenly).
    // Fed to `life` it eroded the shape instead, and a cloud near the edge
    // broke into loose white flecks, one lying over the land (2026-10-08).
    const at = driftedCloud(cloud, drift);
    layOne(slot, 1_000_003 + cloud.id * 7919, at.x, -at.y, cloud.height, cloud.size, cloud.yaw, cloud.density, 1, bounds, puffs, lives);
    shows[slot] = at.show;
    // Each its own flat base, at its own height (one height for the whole
    // sky cut away every cloud set lower than it, and its shadow with it).
    bases[slot] = cloud.height;
    slot++;
  }
  return slot;
}

/** One cloud into slot `i`: its bounding sphere, its puffs (jittered by `id`), how grown it is (`life`). */
function layOne(i: number, id: number, x: number, z: number, base: number, size: number, yaw: number, life: number, grown: number,
  bounds: Vector4[], puffs: Vector4[], lives: number[]): void {
  lives[i] = life;
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
    uBase: { value: Array.from({ length: MAX_CLOUDS }, () => 0) },
    // How much of each cloud shows (1, down to 0 near the edge it wraps round): a factor on its density.
    uShow: { value: Array.from({ length: MAX_CLOUDS }, () => 1) },
    uCloudBase: { value: DEFAULT_ATMOSPHERE.cloudBase },
    uFog: { value: DEFAULT_ATMOSPHERE.fog },
    uFogHeight: { value: DEFAULT_ATMOSPHERE.fogHeight },
    uSunDir: { value: new Vector3(0.5, 0.8, 0.3).normalize() },
    uSunLight: { value: new Color(3, 2.8, 2.5) },
    uFogColor: { value: new Color(0xc9dcea) },
    // The painted fog (`setGroundFog`): its map; the map's density, -, -, on;
    // the lowest and highest the bank reaches.
    tGroundFog: { value: null as Texture | null },
    uGroundFog: { value: new Vector4() },
    uGroundFogSlab: { value: new Vector2() },
    uMapHalf: { value: MAP_SIZE / 2 },
    uBackdrop: { value: 0 },
    // How far in front of the camera the view's equivalent eye stands, units
    // (`setAtmosphere`): 0 in perspective; in the orthographic view the camera
    // stands far back by construction, and the air is measured from where the
    // perspective camera would stand at the same scale.
    uEyeShift: { value: 0 },
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
    // Below the map: a deep navy, never black (the player, 2026-10-09: "não
    // quero que fique preto, é azul escuro"); the earth-brown went black
    // looking straight down.
    uAbyss: { value: new Color(0x0b1a33) },
    // The clouds' bodies, marched at a quarter of the pixels (`CLOUD_BODIES_MAIN`): light, and what of the scene shows through.
    tClouds: { value: null as Texture | null },
    uCloudsOn: { value: 0 },
    // The bodies' accumulation (`CLOUD_BODIES_MAIN`): the last frame's
    // result, its weight (0: none), the frame number for the start's jitter,
    // and the steps across a cloud's diameter.
    tCloudHistory: { value: null as Texture | null },
    uHistory: { value: 0 },
    uFrame: { value: 0 },
    uSteps: { value: 24 },
    // The clouds' shadow map (`CLOUD_SHADOW_MAP_MAIN`), its plane's height and its rectangle (x0, z0, x1, z1).
    tCloudShadow: { value: null as Texture | null },
    uShadowMapOn: { value: 0 },
    uShadowPlane: { value: 0 },
    uShadowRect: { value: new Vector4() },
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
    uniform float uBase[MAX_CLOUDS];
    uniform float uShow[MAX_CLOUDS];
    uniform float uCloudBase;
    uniform float uFog;
    uniform float uFogHeight;
    uniform vec3 uSunDir;
    uniform vec3 uSunLight;
    uniform vec3 uFogColor;
    uniform sampler2D tGroundFog;
    uniform vec4 uGroundFog;
    uniform vec2 uGroundFogSlab;
    uniform float uMapHalf;
    uniform float uBackdrop;
    uniform float uEyeShift;
    // Height over the ground's base level.
    float altitude(vec3 p) {
      return p.y;
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
      float base = smoothstep(uBase[c] - size * 0.12, uBase[c] + size * 0.08, altitude(p));
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
      float up = clamp((altitude(p) - uBase[c]) / size, 0.0, 1.0);
      detail = mix(1.0 - detail, detail, clamp(up * 3.0, 0.0, 1.0));
      // remap(base, detail * 0.35, 1, 0, 1): the heart (1) stays whole, the
      // thin edge is worn into wisps.
      float erode = detail * (0.55 + 0.3 * (1.0 - life));
      return clamp((shape - erode) / (1.0 - erode), 0.0, 1.0) * uShow[c];
    }
    uniform sampler2D tClouds;
    uniform float uCloudsOn;
    uniform sampler2D tCloudHistory;
    uniform float uHistory;
    uniform float uFrame;
    uniform float uSteps;
    // The clouds' shadow map (Unreal's cloud shadow map in place of a march
    // per pixel): what lies between a point of the plane under every cloud's
    // base and the sun, over the rectangle the shadows fall in.
    uniform sampler2D tCloudShadow;
    uniform float uShadowMapOn;
    uniform float uShadowPlane;
    uniform vec4 uShadowRect;
    // How much cloud lies from a point towards the sun, through each heap.
    float shadowThrough(vec3 from) {
      float through = 0.0;
      for (int c = 0; c < MAX_CLOUDS; c++) {
        if (c >= uCloudCount) break;
        vec2 span = sphereSpan(from, uSunDir, uCloud[c]);
        if (span.y <= 0.0) continue;
        float a = max(span.x, 0.0);
        float len = (span.y - a) / 5.0;
        for (int i = 0; i < 5; i++) {
          through += clamp(heap(c, from + uSunDir * (a + (float(i) + 0.5) * len)) * 5.0 - (1.0 - uLife[c]) * 1.2, 0.0, 1.0) * uShow[c] * len / uCloud[c].w;
        }
      }
      return through;
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
      // The clouds' shadows. No cloud has anything below the plane of the
      // lowest base, so a point under it is shaded as the point where its ray
      // to the sun crosses that plane: one read of the map. Above the plane
      // (a roof over a low cloud's base) the march itself.
      if (!sky && uStrength > 0.0 && uCloudCount > 0) {
        float through = 0.0;
        if (uShadowMapOn > 0.5 && hit.y <= uShadowPlane) {
          vec3 onPlane = hit + uSunDir * ((uShadowPlane - hit.y) / uSunDir.y);
          vec2 at = (onPlane.xz - uShadowRect.xy) / (uShadowRect.zw - uShadowRect.xy);
          if (at.x >= 0.0 && at.y >= 0.0 && at.x <= 1.0 && at.y <= 1.0) through = texture2D(tCloudShadow, at).r;
        } else {
          through = shadowThrough(hit);
        }
        colour *= 1.0 - uStrength * (1.0 - exp(-through * 7.0));
      }
      // The air between the eye and what the pixel sees: from the view's
      // equivalent eye (\`uEyeShift\`). Measured from the orthographic camera,
      // 5 000 units back whatever the zoom, rain mist covered half of every
      // close view and the haze lay over ground seen from a few metres.
      float tAir = max(tScene - uEyeShift, 0.0);
      vec3 eye = ro + rd * uEyeShift;
      // Mist: exponential in height, along the ray to what the pixel sees.
      if (uFog > 0.0) {
        float dist = min(tAir, 6000.0);
        float yMid = eye.y + rd.y * dist * 0.5;
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
      if (uBackdrop > 0.5) {
        float zen = acos(clamp(abs(rd.y), 0.0, 1.0));
        float air = 1.0 / (cos(zen) + 0.15 * pow(max(93.885 - degrees(zen), 1e-3), -1.253));
        float glow = 1.0 - exp(-air * 0.12);
        float sunSide = pow(max(dot(rd, uSunDir), 0.0), 3.0);
        vec3 haze = mix(uSkyGlow, uSkyGlow * vec3(1.4, 1.18, 0.9), sunSide * 0.6) * (1.0 - 0.85 * uDark);
        // Brought down near the ground the view gets a SKY: pale blue at the
        // horizon deepening upwards (the player, 2026-10-07: "azul mais
        // clarinho com transição para o mais escuro, só quando der zoom");
        // from high over the map it stays the dark blue round the model.
        // Dark blue down to the zoom of the whole map filling the view
        // (about 700 units up), pale sky only closer than that (the player,
        // 2026-10-09).
        float low = 1.0 - smoothstep(250.0, 650.0, ro.y);
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
          // Koschmieder: contrast falls as exp(-beta d) from the eye, beta =
          // 3.912 / visibility; a clear day of 30 km (0.4 m a unit). It began
          // only past 880 m, so ground at mid distance kept the foreground's
          // full colour and the town read as a model on a table (2026-10-08).
          // Held under 0.55: the map's edge never melts into the dark blue
          // round it (the player, 2026-10-08).
          const float HAZE_BETA = 3.912 / 30000.0 * 0.4;
          float amount = (1.0 - exp(-tAir * HAZE_BETA)) * 0.55;
          colour = mix(colour, haze * (1.0 + 0.6 * glow), amount);
        }
      }
      // THE PAINTED FOG (world/fogPaint.ts): a bank of mist lying on the
      // land where the player laid it, thick near the ground and thinning
      // with height over it (Unreal's local fog volumes over an exponential
      // height fog), torn into drifting wisps by a noise the wind carries
      // through. The view's ray is marched through the slab of air the bank
      // can fill, as far as the scene; each step's density from the painted
      // map, the ground under it from the map's other channel. Lit by the
      // sky and, looking towards the sun, its warm glow (Inigo Quilez,
      // "Better Fog").
      if (uGroundFog.w > 0.5) {
        float t0 = 0.0, t1 = min(tScene, 30000.0);
        // Into the slab [low, high] along the ray.
        if (abs(rd.y) > 1e-4) {
          float ta = (uGroundFogSlab.x - ro.y) / rd.y, tb = (uGroundFogSlab.y - ro.y) / rd.y;
          t0 = max(t0, min(ta, tb));
          t1 = min(t1, max(ta, tb));
        } else if (ro.y < uGroundFogSlab.x || ro.y > uGroundFogSlab.y) {
          t1 = -1.0;
        }
        if (t1 > t0) {
          const int FOG_STEPS = 36;
          float stepLen = (t1 - t0) / float(FOG_STEPS);
          // Interleaved gradient noise (Jimenez, "Next Generation Post
          // Processing in Call of Duty: Advanced Warfare", 2014) to start each
          // pixel's march: a sine hash drew a visible cross-hatch over the
          // bank (the player's screenshot, 2026-10-07).
          float jitterF = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          vec2 windDir = normalize(vec2(24.0, 9.0));
          // The FLOW MAP (Vlachos, "Water Flow in Portal 2", Valve 2010):
          // each texel's fog moves at its own speed, so the offset cannot
          // grow with time (neighbours of different speeds would shear the
          // wisps apart); two layers half a cycle apart each slide for one
          // cycle and start again, the one restarting always faded out.
          const float CYCLE = 9.0;
          float phaseA = fract(uTime / CYCLE);
          float phaseB = fract(uTime / CYCLE + 0.5);
          float blendB = abs(phaseA - 0.5) * 2.0;
          float transmit = 1.0;
          for (int i = 0; i < FOG_STEPS; i++) {
            float t = t0 + (float(i) + jitterF) * stepLen;
            vec3 q = ro + rd * t;
            vec2 uv = vec2(q.x + uMapHalf, -q.z + uMapHalf) / (2.0 * uMapHalf);
            if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
            vec4 m = texture2D(tGroundFog, uv);
            if (m.r < 0.003) continue;
            float over = q.y - m.g;
            if (over < -4.0) continue;
            float thin = exp(-max(over, 0.0) / max(m.b, 1.0));
            vec2 flow = windDir * m.a * CYCLE;
            // Wisps: two layers of billows the wind carries at different
            // speeds and a little apart in heading, each rolling over in
            // time as it goes, so the bank streams, curls and frays instead
            // of sliding as one sheet (the player, 2026-10-07: "tem que se
            // mexer").
            // The rolling-over goes at the fog's own pace too: still fog
            // barely stirs, fast fog boils.
            float roll = uTime * (0.01 + m.a * 0.002);
            vec2 flow2 = vec2(flow.x * 1.7 - flow.y * 0.4, flow.y * 1.7 + flow.x * 0.4);
            float n = 0.0;
            for (int layer = 0; layer < 2; layer++) {
              float phase = layer == 0 ? phaseA : phaseB;
              // Each layer starts its cycle in a different place (Valve's noise against the pulsing).
              vec2 shift = layer == 0 ? vec2(0.0) : vec2(37.1, 91.7);
              vec3 nq = vec3(q.x - flow.x * phase + shift.x, q.y * 1.6, -q.z - flow.y * phase + shift.y) / 55.0 + vec3(0.0, roll, roll * 0.7);
              vec3 nr = vec3(q.x - flow2.x * phase + shift.y, q.y * 2.0, -q.z - flow2.y * phase + shift.x) / 23.0 + vec3(roll * 1.4, 0.0, 0.0);
              float nl = noise3(nq) * 0.6 + noise3(nq * 2.1 + 4.1) * 0.15 + noise3(nr) * 0.25;
              n += nl * (layer == 0 ? 1.0 - blendB : blendB);
            }
            float wisp = smoothstep(0.25, 0.75, n * (0.7 + 0.6 * thin));
            float density = m.r * uGroundFog.x * thin * wisp * 0.012;
            transmit *= exp(-density * stepLen);
            if (transmit < 0.02) break;
          }
          float amount = 1.0 - transmit;
          if (amount > 0.001) {
            float sunAmount = pow(max(dot(rd, uSunDir), 0.0), 8.0);
            vec3 mist = mix(vec3(0.86, 0.9, 0.95), vec3(1.0, 0.95, 0.84), sunAmount) * (0.72 + 0.28 * max(uSunDir.y, 0.0));
            mist *= 1.0 - 0.85 * uDark;
            colour = mix(colour, mist, amount);
          }
        }
      }
      // The clouds' bodies, marched at a quarter of the pixels (CLOUD_BODIES_MAIN).
      if (uCloudsOn > 0.5) {
        vec4 bodies = texture2D(tClouds, vUv);
        colour = colour * bodies.a + bodies.rgb;
      }
      gl_FragColor = vec4(colour, src.a);
    }
  `,
};

/**
 * The clouds' shadow map (`CLOUD_SHADOWS`'s functions and uniforms): each
 * texel a point of the plane under every cloud's base, over the rectangle the
 * shadows fall in, and how much cloud lies from it towards the sun - the
 * march each pixel of the screen made for itself, made once a texel.
 */
const CLOUD_SHADOW_MAP_MAIN = /* glsl */ `
    void main() {
      vec3 from = vec3(mix(uShadowRect.x, uShadowRect.z, vUv.x), uShadowPlane, mix(uShadowRect.y, uShadowRect.w, vUv.y));
      gl_FragColor = vec4(shadowThrough(from), 0.0, 0.0, 1.0);
    }
`;

/**
 * The clouds' bodies' steps across a cloud's diameter: the full 24 with the
 * camera moving (no history then), 10 with it still, each frame's start
 * moved on and the last frames blended in with this weight (Playdead's TAA
 * feedback; with ten jittered steps a frame it gathers the full count's
 * samples within three frames).
 */
const CLOUD_STEPS_MOVING = 24;
const CLOUD_STEPS_STILL = 16;
const CLOUD_HISTORY = 0.9;

/** Texels a side of the clouds' shadow map: some 10 world units a texel over the whole map, for shadows tens to hundreds of units soft. */
const CLOUD_SHADOW_MAP = 512;

/**
 * The plane under every cloud (none has density below `uBase - 0.12 size`,
 * `heap`) and the rectangle on it where their shadows fall: each cloud's
 * bounding sphere carried down the sun's ray to the plane, stretched by the
 * sun's slant. Null with no cloud or the sun too low for a map.
 */
function cloudShadowFrame(bounds: readonly Vector4[], bases: readonly number[], count: number, sun: Vector3,
  rect: Vector4): number | null {
  if (count === 0 || sun.y < 0.08) return null;
  let plane = Infinity;
  for (let c = 0; c < count; c++) plane = Math.min(plane, bases[c]! - bounds[c]!.w / 1.12 * 0.12);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let c = 0; c < count; c++) {
    const s = bounds[c]!;
    const down = (s.y - plane) / sun.y;
    const x = s.x - sun.x * down, z = s.z - sun.z * down;
    const reach = s.w / sun.y;
    x0 = Math.min(x0, x - reach); x1 = Math.max(x1, x + reach);
    z0 = Math.min(z0, z - reach); z1 = Math.max(z1, z + reach);
  }
  rect.set(x0, z0, x1, z1);
  return plane;
}

/**
 * The clouds' bodies (`CLOUD_SHADOWS`'s functions and uniforms), nearest
 * first, into a target of half the width and half the height: a quarter of
 * the pixels, as volumetric clouds are marched in games (Horizon Zero Dawn's
 * cloudscapes, the Nubis line of work) - they are soft, and every pixel of
 * them cost up to 24 clouds of 24 steps of noise. Each is marched to the
 * nearest of the scene's four depths under it, so no cloud is laid over the
 * edge of something in front of it; the full-size pass blends them in
 * (light, and what of the scene shows through).
 */
const CLOUD_BODIES_MAIN = /* glsl */ `
    void main() {
      ivec2 full = textureSize(tDepth, 0);
      ivec2 at = ivec2(gl_FragCoord.xy) * 2;
      float depth = 1.0;
      for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) depth = min(depth, texelFetch(tDepth, min(at + ivec2(i, j), full - 1), 0).r);
      bool sky = depth >= 0.9999;
      vec3 ro = worldAt(vUv, 0.0);
      vec3 hit = worldAt(vUv, sky ? 0.99999 : depth);
      vec3 rd = normalize(hit - ro);
      float tScene = sky ? 1e7 : length(hit - ro);
      float transmit = 1.0;
      vec3 light = vec3(0.0);
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
        // Over the map only now (layClouds), so they show from every zoom
        // (the player, 2026-10-07: "quero que as nuvens apareçam"); only
        // past the whole map's width do they give way to their shadows.
        float bodies = 1.0 - smoothstep(9000.0, 14000.0, spanFocus);
        vec2 spans[MAX_CLOUDS];
        for (int c = 0; c < MAX_CLOUDS; c++) {
          spans[c] = vec2(-1.0);
          if (c < uCloudCount) spans[c] = sphereSpan(ro, rd, uCloud[c]);
        }
        // Each pixel its own start, moved on every frame (the golden ratio's
        // step) so the accumulation sees other depths each time (arXiv
        // 1609.05344, 3.2); with the camera moving no history is kept and the
        // start stays put, as before.
        float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453 + uFrame * 0.6180339887);
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
          // Steps of one length through every cloud: 24 across its diameter,
          // fewer through a chord near its rim or cut short by the scene.
          // Each step's opacity is integrated over its length (Beer's law),
          // so its light does not depend on how long the step is (Högfeldt,
          // "Optimisations for Real-Time Volumetric Cloudscapes", 3.1).
          const int STEPS = 24;
          // uSteps across the diameter: 24 with the camera moving, fewer
          // with it still, the history filling in what a frame leaves out.
          int steps = int(clamp(ceil(uSteps * (t1 - t0) / (2.0 * uCloud[best].w)), 4.0, float(STEPS)));
          float stepLen = (t1 - t0) / float(steps);
          for (int i = 0; i < STEPS; i++) {
            if (i >= steps) break;
            float t = t0 + (float(i) + jitter) * stepLen;
            vec3 q = ro + rd * t;
            float density = cloudDensity(best, q);
            // Never pressed against the camera: a cloud within its own size
            // of the eye fades out. (Fading every cloud nearer than most of
            // the way to the ground looked at hid them all from above - the
            // camera looks down through the sky at the land - and no cloud
            // ever showed: the player, 2026-10-07.)
            float near = size * 1.3;
            density *= smoothstep(near * 0.4, near, t) * bodies;
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
            float up = clamp((altitude(q) - uBase[best]) / size, 0.0, 1.0);
            vec3 c = mix(baseShade, skyLight, 0.25 + 0.75 * up) * 0.85 + uSunLight * 0.36 * lit * (1.0 - uDark);
            // Little extinction: the eroded edge is a veil the land shows through.
            float alpha = 1.0 - exp(-density * stepLen * 0.015);
            light += transmit * alpha * c;
            transmit *= 1.0 - alpha;
            if (transmit < 0.03) break;
          }
        }
      }
      vec4 now = vec4(light, transmit);
      // The view unchanged since the last frame: this pixel's last result is
      // at this same place, blended in (Playdead's TAA: lerp(current,
      // history, feedback)).
      if (uHistory > 0.0) now = mix(now, texture2D(tCloudHistory, vUv), uHistory);
      gl_FragColor = now;
    }
`;

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
