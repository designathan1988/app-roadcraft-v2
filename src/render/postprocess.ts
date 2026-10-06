import { BufferGeometry, DepthTexture, Float32BufferAttribute, HalfFloatType, Mesh, PlaneGeometry, Scene, Vector2, Vector3, WebGLRenderTarget, type Camera, type WebGLRenderer } from 'three';
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
 * ## Why SMAA rather than MSAA
 *
 * The composer renders into a float target, where the driver's own multisample
 * resolve is not available in WebGL2 for every format. SMAA runs on the resolved
 * image, costs one pass, and — unlike FXAA — keeps the thin bright lines of lane
 * markings sharp instead of smearing them.
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
   * The sun for the light shafts: where it is on screen (0..1, may lie off
   * it), how strongly the shafts show (0 off), and its colour.
   */
  setSun(x: number, y: number, strength: number, color: readonly [number, number, number]): void;
  dispose(): void;
}

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
      setSun() {
        /* no shafts without the chain */
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
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);
  composer.addPass(new RenderPass(scene, camera));
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
  const smaa = quality.smaa ? new SMAAPass() : null;
  if (smaa) composer.addPass(smaa);
  const output = new OutputPass();
  composer.addPass(output);
  // The grade, on the finished image: a film's contrast and colour.
  const grade = new ShaderPass(GRADE);
  composer.addPass(grade);
  // Light shafts (Kenny Mitchell, "Volumetric Light Scattering as a
  // Post-Process", GPU Gems 3, ch. 13): the sky seen past every hill, tree
  // and roof, blurred out from the sun's place on screen. Only when the sun
  // is near the view; off otherwise, its pass skipped. The LAST pass, drawn
  // to the screen: it reads the scene's depth, and anywhere in the chain its
  // output could land in the very target that depth belongs to - a feedback
  // loop, and the frame came out black.
  const shafts = quality.lightShafts ? new ShaderPass(SHAFTS) : null;
  if (shafts) {
    (shafts.uniforms['tDepth'] as { value: unknown }).value = target.depthTexture;
    shafts.enabled = false;
    composer.addPass(shafts);
  }


  return {
    enabled: true,
    target,
    render(delta) {
      (grade.uniforms['uTime'] as { value: number }).value += delta;
      composer.render(delta);
    },
    setNight(dark) {
      bloom.enabled = dark > 0.05;
      bloom.strength = bloomStrength * Math.min(1, dark);
    },
    setSun(x, y, strength, color) {
      if (!shafts) return;
      shafts.enabled = strength > 0.01;
      if (!shafts.enabled) return;
      (shafts.uniforms['uSun'] as { value: Vector2 }).value.set(x, y);
      (shafts.uniforms['uStrength'] as { value: number }).value = strength;
      (shafts.uniforms['uColor'] as { value: Vector3 }).value.set(color[0], color[1], color[2]);
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
      shafts?.dispose();
      output.dispose();
      grade.dispose();
    },
  };
}

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

/**
 * The shafts: from each pixel, samples along the way to the sun; a sample
 * counts where it is open sky (nothing drawn there: the depth is the far
 * plane), its brightness decaying with each step away from the sun. Added to
 * the picture in the sun's colour. Linear light, before the tone mapping.
 */
const SHAFTS = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null as unknown },
    uSun: { value: new Vector2(0.5, 0.5) },
    uStrength: { value: 0 },
    uColor: { value: new Vector3(1, 0.95, 0.85) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uSun;
    uniform float uStrength;
    uniform vec3 uColor;
    varying vec2 vUv;
    const int SAMPLES = 48;
    const float DENSITY = 0.9;
    const float DECAY = 0.955;
    const float WEIGHT = 0.5;
    float skyAt(vec2 uv) {
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
      if (texture2D(tDepth, uv).r < 0.99999) return 0.0;
      vec3 c = min(texture2D(tDiffuse, uv).rgb, vec3(8.0));
      // Only the sun and the glow round it shine through (the occlusion pass
      // of the original draws the light source alone, not the whole sky).
      float nearSun = exp(-dot(uv - uSun, uv - uSun) / 0.02);
      return clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 4.0) * nearSun;
    }
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec2 step = (vUv - uSun) * (DENSITY / float(SAMPLES));
      // Jittered start, so the steps do not show as rings.
      float j = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
      vec2 at = vUv - step * j;
      float light = 0.0, decay = 1.0;
      for (int i = 0; i < SAMPLES; i++) {
        at -= step;
        light += skyAt(at) * decay * WEIGHT;
        decay *= DECAY;
      }
      light /= float(SAMPLES) * 0.25;
      // A non-number never leaves this pass (the sun's disc can overflow a half float).
      vec3 add = uColor * light * uStrength;
      if (!(add.r >= 0.0 && add.g >= 0.0 && add.b >= 0.0)) add = vec3(0.0);
      gl_FragColor = vec4(src.rgb + add, src.a);
    }
  `,
};
