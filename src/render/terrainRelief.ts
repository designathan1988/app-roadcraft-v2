import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RedFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';

/**
 * THE FINE RELIEF: the land's gullies, spurs and wrinkles, far finer than the
 * terrain mesh (16 units a cell), baked into a texture the terrain shader
 * lights by - the normal map a landscape is drawn with over a coarse mesh
 * (World Machine's "Create Normals": a low-resolution mesh drawn with the
 * shading of a high-resolution terrain). Only the light reads it: the mesh,
 * the roads on it and every pick keep the mesh's height.
 *
 * The relief is Rune Skovbo Johansen's erosion filter (2025-2026, after Clay
 * John's and Fewes's eroded noise): stripes of "phacelle" noise laid down
 * every slope, so they read as gullies; each octave's slopes bend the next
 * octave's, so small gullies branch off big ones; a mask from the slope
 * fades it all out on flat ground. Ported from the reference shader as the
 * bevy_erosion_filter crate publishes it. Evaluated per texel on the GPU,
 * once each time the land changes, over the mesh's height read smoothly
 * (Catmull-Rom between its corners).
 *
 * The texture: R the height the relief adds (world units), G its ridge map
 * (about +1 on crests, -1 in creases), B the brightness of the land's macro
 * colour map (`terrain.ts` macroTexture) - carried here because the terrain
 * shader is at the sixteen textures a fragment shader may bind.
 */

/** Texels across the map: 2.3 units a texel over the 4800-unit map. */
export const RELIEF_RES = 2048;
/** World units to one unit of the filter's own space (its first gullies some 150 units apart). */
const RELIEF_LENGTH = 1400;

/** A flat relief until the first bake: one texel, nothing added. */
export const RELIEF_TEXTURE: { value: Texture } = {
  value: (() => {
    const flat = new DataTexture(new Uint8Array([0, 0, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    flat.needsUpdate = true;
    return flat;
  })(),
};

const BAKE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uHeights;
  uniform sampler2D uMacro;
  uniform float uGridN;
  uniform float uCell;
  uniform float uHalf;
  uniform float uLength;
  varying vec2 vUv;

  #define TAU 6.283185307
  // The reference's defaults.
  #define SCALE 0.15
  #define STRENGTH 0.22
  #define GULLY 0.5
  #define DETAIL 1.5
  const vec4 ROUND = vec4(0.1, 0.0, 0.1, 2.0);
  const vec4 ONSET = vec4(1.25, 1.25, 2.8, 1.5);
  const vec2 ASSUMED = vec2(0.7, 1.0);
  #define CELL_SCALE 0.7
  #define NORMALIZATION 0.5
  #define OCTAVES 5
  #define LACUNARITY 2.0
  #define GAIN 0.5

  // The mesh's height, smooth between its corners: a bilinear read has a
  // slope that jumps at every cell edge, and the gullies would follow the grid.
  float corner(ivec2 c) {
    int n = int(uGridN) - 1;
    return texelFetch(uHeights, clamp(c, ivec2(0), ivec2(n)), 0).r;
  }
  float catmull(float a, float b, float c, float d, float t) {
    return b + 0.5 * t * (c - a + t * (2.0 * a - 5.0 * b + 4.0 * c - d + t * (3.0 * (b - c) + d - a)));
  }
  float heightAt(vec2 xz) {
    vec2 g = (xz + uHalf) / uCell;
    vec2 i = floor(g);
    vec2 f = g - i;
    ivec2 k = ivec2(i);
    float r[4];
    for (int j = 0; j < 4; j++) {
      int y = k.y + j - 1;
      r[j] = catmull(corner(ivec2(k.x - 1, y)), corner(ivec2(k.x, y)), corner(ivec2(k.x + 1, y)), corner(ivec2(k.x + 2, y)), f.x);
    }
    return catmull(r[0], r[1], r[2], r[3], f.y);
  }

  // Inigo Quilez's 2-D hash, both components in [-1, 1].
  vec2 hash2(vec2 x) {
    const vec2 k = vec2(0.3183099, 0.3678794);
    x = x * k + k.yx;
    return -1.0 + 2.0 * fract(16.0 * k * fract(x.x * x.y * (x.x + x.y)));
  }
  float easeOut(float t) { float v = 1.0 - clamp(t, 0.0, 1.0); return 1.0 - v * v; }
  float smoothStart(float t, float s) { return t >= s ? t - 0.5 * s : 0.5 * t * t / max(s, 1e-12); }
  float powInv(float t, float p) { return 1.0 - pow(1.0 - clamp(t, 0.0, 1.0), p); }

  // Phacelle noise: a stripe pattern along dir, a cosine across it (x) and
  // its sine (y), interpolated over jittered cells; zw the side direction
  // times freq * TAU.
  vec4 phacelle(vec2 p, vec2 dir, float freq, float offsetCycles, float normalization) {
    vec2 side = vec2(-dir.y, dir.x) * freq * TAU;
    float offset = offsetCycles * TAU;
    vec2 i = floor(p);
    vec2 f = p - i;
    vec2 acc = vec2(0.0);
    float weights = 0.0;
    for (int a = -1; a <= 2; a++) {
      for (int b = -1; b <= 2; b++) {
        vec2 g = vec2(float(a), float(b));
        vec2 v = f - g - hash2(i + g) * 0.5;
        float w = max(0.0, exp(-dot(v, v) * 2.0) - 0.01111);
        weights += w;
        float wave = dot(v, side) + offset;
        acc += vec2(cos(wave), sin(wave)) * w;
      }
    }
    acc /= max(weights, 1e-6);
    float magnitude = max(1.0 - normalization, length(acc));
    return vec4(acc / magnitude, side);
  }

  // The filter at p over a height h with slope d: x the height to add, y the ridge map.
  vec2 erosion(vec2 p, float h, vec2 d, float fadeTargetIn) {
    float strength = STRENGTH * SCALE;
    float fadeTarget = clamp(fadeTargetIn, -1.0, 1.0);
    float hh = h;
    float freq = 1.0 / (SCALE * CELL_SCALE);
    float slopeLength = max(length(d), 1e-10);
    float roundingMult = 1.0;
    float roundingForInput = mix(ROUND.y, ROUND.x, clamp(fadeTarget + 0.5, 0.0, 1.0)) * ROUND.z;
    float combiMask = easeOut(smoothStart(slopeLength * ONSET.x, roundingForInput * ONSET.x));
    float ridgeMask = easeOut(slopeLength * ONSET.z);
    float ridgeTarget = fadeTarget;
    // The gully direction: the real slope, its length replaced by an ideal one.
    vec2 g = mix(d, d / slopeLength * ASSUMED.x, ASSUMED.y);
    for (int i = 0; i < OCTAVES; i++) {
      float gl = length(g);
      vec2 n = gl > 1e-10 ? g / gl : g;
      vec4 ph = phacelle(p * freq, n, CELL_SCALE, 0.25, NORMALIZATION);
      vec2 z = ph.zw * -freq;
      float sloping = abs(ph.y);
      // Smaller gullies branch off this octave's.
      g += (ph.y >= 0.0 ? 1.0 : -1.0) * z * strength * GULLY;
      float fh = mix(fadeTarget, ph.x * GULLY, combiMask);
      hh += fh * strength;
      fadeTarget = fh;
      float roundingForOctave = mix(ROUND.y, ROUND.x, clamp(ph.x + 0.5, 0.0, 1.0)) * roundingMult;
      float newMask = easeOut(smoothStart(sloping * ONSET.y, roundingForOctave * ONSET.y));
      combiMask = powInv(combiMask, DETAIL) * newMask;
      ridgeTarget = mix(ridgeTarget, ph.x, ridgeMask);
      ridgeMask *= easeOut(sloping * ONSET.w);
      strength *= GAIN;
      freq *= LACUNARITY;
      roundingMult *= ROUND.w;
    }
    return vec2(hh - h, ridgeTarget * (1.0 - ridgeMask));
  }

  void main() {
    vec2 xz = vUv * (2.0 * uHalf) - uHalf;
    float h = heightAt(xz);
    float e = 3.0;
    vec2 slope = vec2(heightAt(xz + vec2(e, 0.0)) - heightAt(xz - vec2(e, 0.0)), heightAt(xz + vec2(0.0, e)) - heightAt(xz - vec2(0.0, e))) / (2.0 * e);
    vec2 r = erosion(xz / uLength, h / uLength, slope, 0.0);
    // The macro map as the terrain shader read it (terrainWideUv * 0.0024).
    vec2 wide = vec2(xz.x * 0.9396926 - xz.y * 0.3420201, xz.x * 0.3420201 + xz.y * 0.9396926) * 0.137 * 0.0024;
    float macro = dot(texture2D(uMacro, wide).rgb * 2.0, vec3(0.3, 0.59, 0.11));
    gl_FragColor = vec4(r.x * uLength, r.y, macro, 1.0);
  }
`;

export interface ReliefBake {
  /** The land moved: bake again at the next chance. */
  markDirty(): void;
  /** Bakes the relief over these corner heights (row by row, GRID by GRID) if it is stale. */
  bake(renderer: WebGLRenderer, heights: Float64Array): void;
  dispose(): void;
}

export function createReliefBake(gridN: number, cell: number, half: number, macro: Texture): ReliefBake {
  const target = new WebGLRenderTarget(RELIEF_RES, RELIEF_RES, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    generateMipmaps: true,
    depthBuffer: false,
  });
  const corners = new Float32Array(gridN * gridN);
  const heights = new DataTexture(corners, gridN, gridN, RedFormat, FloatType);
  heights.minFilter = NearestFilter;
  heights.magFilter = NearestFilter;
  heights.generateMipmaps = false;
  const material = new ShaderMaterial({
    uniforms: {
      uHeights: { value: heights },
      uMacro: { value: macro },
      uGridN: { value: gridN },
      uCell: { value: cell },
      uHalf: { value: half },
      uLength: { value: RELIEF_LENGTH },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: BAKE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new Scene();
  scene.add(quad);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let dirty = true;
  return {
    markDirty() { dirty = true; },
    bake(renderer, grid) {
      if (!dirty) return;
      dirty = false;
      const startedAt = performance.now();
      for (let i = 0; i < corners.length; i++) corners[i] = grid[i]!;
      heights.needsUpdate = true;
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previous);
      RELIEF_TEXTURE.value = target.texture;
      performance.measure('hitch:terrain-relief', { start: startedAt, end: performance.now() });
    },
    dispose() {
      target.dispose();
      heights.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}
