import {
  BufferGeometry, Color, DataTexture, DepthTexture, Float32BufferAttribute, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Matrix4, Mesh,
  PlaneGeometry, RGBAFormat, RepeatWrapping, Scene, UnsignedByteType, Vector2, Vector3, WebGLRenderTarget, type Camera, type WebGLRenderer,
} from 'three';
import { fbm, makeNoise } from './mesh/textureBaker';
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
  /** The sky the player set (`Atmosphere`) and the light it is lit by. */
  setAtmosphere(atmosphere: Atmosphere, sun: Vector3, skyColor: Color): void;
  dispose(): void;
}

/**
 * The player's sky (Paisagem > Céu e clima): how much of it is cloud, at
 * what height and how thick the layer is, and how much mist lies over the
 * land and how high it reaches. World units.
 */
export interface Atmosphere {
  /** 0 a clear sky, 1 overcast. */
  readonly clouds: number;
  readonly cloudBase: number;
  readonly cloudThickness: number;
  /** 0 none (the default: the map seen clear), 1 a thick mist. */
  readonly fog: number;
  readonly fogHeight: number;
}
export const DEFAULT_ATMOSPHERE: Atmosphere = { clouds: 0.45, cloudBase: 875, cloudThickness: 150, fog: 0, fogHeight: 150 };

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
  const cloudMap = clouds ? cloudTexture() : null;
  if (clouds && cloudMap) {
    clouds.uniforms['tClouds']!.value = cloudMap;
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
  composer.addPass(grade);

  return {
    enabled: true,
    target,
    render(delta) {
      (grade.uniforms['uTime'] as { value: number }).value += delta;
      if (clouds) {
        camera.updateMatrixWorld();
        (clouds.uniforms['uTime'] as { value: number }).value += delta;
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
    setAtmosphere(atmosphere, sun, skyColor) {
      if (!clouds) return;
      const u = clouds.uniforms as Record<string, { value: unknown }>;
      u['uCloudCover']!.value = atmosphere.clouds;
      u['uCloudBase']!.value = atmosphere.cloudBase;
      u['uCloudThickness']!.value = Math.max(10, atmosphere.cloudThickness);
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
      cloudMap?.dispose();
    },
  };
}

/** How much a cloud's shadow takes from the light under it: a soft patch, not a dark blot. */
const CLOUD_SHADOW_STRENGTH = 0.2;

/**
 * Tiling cloud cover: billowy fbm with gaps between, so the patches are
 * separate clouds rather than an even grey film.
 */
function cloudTexture(): DataTexture {
  const res = 256;
  const noise = makeNoise(0x51c3);
  const data = new Uint8Array(res * res * 4);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const v = fbm(noise, (x / res) * 6, (y / res) * 6, 6, 5);
      const cover = Math.min(1, Math.max(0, (v - 0.47) / 0.16));
      const i = (y * res + x) * 4;
      const c = Math.round(cover * cover * (3 - 2 * cover) * 255);
      data[i] = c;
      data[i + 1] = c;
      data[i + 2] = c;
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, res, res, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * THE ATMOSPHERE, on the image (the player sets it: Paisagem > Céu e clima):
 *
 *  - CLOUDS with a height and a thickness: each pixel's ray, from the camera
 *    to what it sees (or to the sky), is marched in a few steps through the
 *    slab between the cloud base and its top, the cover read from the same
 *    drifting cloud texture as ever, shaped round in height and lit brighter
 *    at the top than at the base - the shape cheap volumetric layers take
 *    (Schneider, "The Real-time Volumetric Cloudscapes of Horizon Zero
 *    Dawn"), in a handful of steps rather than dozens.
 *  - Their SHADOWS on the land, now where the sun throws them from that
 *    height, so a cloud and its shadow belong together.
 *  - MIST: exponential height fog, thickest in the low ground.
 *
 * Every pixel's world position is rebuilt from the depth the scene was drawn
 * with (the composer swaps its targets, so the depth is captured per frame).
 */
const CLOUD_SHADOWS = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tClouds: { value: null },
    uProjectionInverse: { value: new Matrix4() },
    uCameraWorld: { value: new Matrix4() },
    uTime: { value: 0 },
    uStrength: { value: CLOUD_SHADOW_STRENGTH },
    uDark: { value: 0 },
    uCloudCover: { value: DEFAULT_ATMOSPHERE.clouds },
    uCloudBase: { value: DEFAULT_ATMOSPHERE.cloudBase },
    uCloudThickness: { value: DEFAULT_ATMOSPHERE.cloudThickness },
    uFog: { value: DEFAULT_ATMOSPHERE.fog },
    uFogHeight: { value: DEFAULT_ATMOSPHERE.fogHeight },
    uSunDir: { value: new Vector3(0.5, 0.8, 0.3).normalize() },
    uFogColor: { value: new Color(0xc9dcea) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tClouds;
    uniform mat4 uProjectionInverse;
    uniform mat4 uCameraWorld;
    uniform float uTime;
    uniform float uStrength;
    uniform float uDark;
    uniform float uCloudCover;
    uniform float uCloudBase;
    uniform float uCloudThickness;
    uniform float uFog;
    uniform float uFogHeight;
    uniform vec3 uSunDir;
    uniform vec3 uFogColor;
    varying vec2 vUv;
    vec3 worldAt(vec2 uv, float depth) {
      vec4 view = uProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      return (uCameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
    }
    // The cloud cover over a point, 0..1, as the player's cover thresholds it.
    float coverAt(vec2 p) {
      // Two layers at different sizes and drifts, so the shapes change as
      // they pass instead of sliding by as one stencil.
      float a = texture2D(tClouds, p / 2600.0 + uTime * vec2(0.0042, 0.0017)).r;
      float b = texture2D(tClouds, p / 1500.0 + uTime * vec2(0.0058, 0.0009) + 0.37).r;
      float raw = clamp(a * 0.75 + b * 0.45 - 0.15, 0.0, 1.0);
      return clamp((raw - (1.0 - uCloudCover) * 0.95) / 0.35, 0.0, 1.0);
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
      // The clouds' shadow, thrown by the sun from the middle of the layer.
      if (!sky && uStrength > 0.0 && uCloudCover > 0.0) {
        float lift = (uCloudBase + uCloudThickness * 0.5 - hit.y) / max(uSunDir.y, 0.2);
        float shade = coverAt(hit.xz + uSunDir.xz * lift);
        colour *= 1.0 - uStrength * shade;
      }
      // Mist: exponential in height, along the ray to what the pixel sees.
      if (uFog > 0.0) {
        float dist = min(tScene, 6000.0);
        float yMid = ro.y + rd.y * dist * 0.5;
        float thickness = exp(-max(0.0, min(yMid, hit.y)) / uFogHeight);
        float amount = 1.0 - exp(-uFog * 0.0009 * dist * thickness);
        vec3 mist = mix(uFogColor, uFogColor * 0.18, uDark);
        colour = mix(colour, mist, clamp(amount, 0.0, 0.95));
      }
      // The clouds: a few steps through the slab the ray crosses.
      if (uCloudCover > 0.0 && abs(rd.y) > 1e-4) {
        float top = uCloudBase + uCloudThickness;
        float ta = (uCloudBase - ro.y) / rd.y;
        float tb = (top - ro.y) / rd.y;
        float t0 = max(0.0, min(ta, tb));
        float t1 = min(max(ta, tb), tScene);
        if (t1 > t0) {
          const int STEPS = 10;
          float stepLen = (t1 - t0) / float(STEPS);
          // Each pixel starts its steps at its own offset: fixed steps drew
          // the layer as a stack of slices.
          float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          float transmit = 1.0;
          vec3 light = vec3(0.0);
          vec3 lit = mix(vec3(1.0, 0.98, 0.95), vec3(0.12, 0.14, 0.2), uDark);
          vec3 base = mix(vec3(0.62, 0.66, 0.72), vec3(0.05, 0.06, 0.09), uDark);
          for (int i = 0; i < STEPS; i++) {
            vec3 q = ro + rd * (t0 + (float(i) + jitter) * stepLen);
            float h = clamp((q.y - uCloudBase) / uCloudThickness, 0.0, 1.0);
            // Billowing: the cover a point needs grows towards the base and
            // much more towards the top, so each cloud is a mound with a
            // flat-ish base and a rounded top, not its outline extruded.
            float need = 0.12 + 0.75 * pow(abs(h * 1.6 - 0.45), 1.6);
            float density = smoothstep(need, need + 0.25, coverAt(q.xz));
            if (density <= 0.0) continue;
            float alpha = 1.0 - exp(-density * stepLen * 0.006);
            light += transmit * alpha * mix(base, lit, h);
            transmit *= 1.0 - alpha;
            if (transmit < 0.02) break;
          }
          colour = colour * transmit + light;
        }
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
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Contrast, an S round the middle grey.
      c = mix(c, smoothstep(0.0, 1.0, c), 0.28);
      // Vibrance: the dull colours gain more than the vivid.
      float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
      float sat = mx - mn;
      c = mix(vec3(l), c, 1.0 + 0.32 * (1.0 - sat));
      // Split toning: warm highlights, cool shadows.
      c += mix(vec3(-0.012, 0.0, 0.03), vec3(0.03, 0.012, -0.022), smoothstep(0.15, 0.85, l));
      // Vignette.
      vec2 d = vUv - 0.5;
      c *= mix(1.0, 0.78, smoothstep(0.3, 0.85, dot(d, d) * 2.4));
      // Film grain.
      c += (hash(vUv * 1024.0 + fract(uTime) * 61.0) - 0.5) * 0.018;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
    }
  `,
};
