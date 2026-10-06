import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DepthTexture, DoubleSide, FloatType, HalfFloatType, Matrix4, Mesh,
  NearestFilter, OrthographicCamera, RGBAFormat, Scene, ShaderMaterial, Sphere, Vector3, WebGLRenderTarget, type WebGLRenderer,
} from 'three';
import type { StrandSet } from '@people/gen/hair';

/**
 * Strands (hair, brows, lashes) drawn as ribbons that always face the camera:
 * two vertices per strand point, spread across the strand in the vertex
 * shader by its width, at least half a pixel (EA's Frostbite: a strand thinner
 * than a pixel must be widened to the pixel or it breaks up; widened more it
 * reads as straw), covered by the canvas's MSAA (alpha to coverage).
 *
 * Shading follows the two things EA's Frostbite team (Tafuri, "Strand-based
 * Hair Rendering in Frostbite", SIGGRAPH 2019) names as what makes strand
 * hair look like hair:
 *
 * - Single scattering: Marschner's three paths - R (reflection), TT (through
 *   the fibre), TRT (one internal bounce) - with Karis's real-time
 *   approximations ("Physically Based Hair Shading in Unreal", 2016).
 * - The strands' shadow on each other and the light spread through the
 *   volume: a Deep Opacity Map (Yuksel and Keyser 2008) from the key light -
 *   the depth of the first strand, then the hair's opacity summed in four
 *   depth bands behind it - read as transmittance, which darkens the strands
 *   inside the hair and tints the light scattered through it (Karis's
 *   diffuse scatter, tinted towards the hair colour as the shadow deepens).
 *   The same map shades the skin under the hair (`HairShadow.uniforms`).
 */

export interface StrandLook {
  readonly root: number;
  readonly tip: number;
  /** The grey strands' colour. */
  readonly grey?: number;
  /** 0..1 highlight strength (lashes and brows have little). */
  readonly shine: number;
  /** Fade strands thinner than a pixel (brows, lashes). */
  readonly fadeThin?: boolean;
}

/** The stage's lights (directions towards the light), the key light first. */
export interface StrandLights { readonly dirs: readonly Vector3[]; readonly colours: readonly Color[]; readonly ambient: Color }

/** Depth bands of the opacity map behind the first strand, metres. */
const BANDS = [0.004, 0.012, 0.03, 0.08] as const;

/** Uniforms shared by every material that reads the hair's shadow. */
export interface HairShadowUniforms {
  domDepth: { value: DepthTexture | null };
  domLayers: { value: unknown };
  domMatrix: { value: Matrix4 };
  domRange: { value: number };
  domOn: { value: number };
}

/** GLSL: transmittance of the key light through the hair at a world point (1 = no hair in the way). */
export const HAIR_SHADOW_GLSL = /* glsl */ `
uniform sampler2D domDepth;
uniform sampler2D domLayers;
uniform mat4 domMatrix;
uniform float domRange;
uniform float domOn;
float hairTransmittance(vec3 world) {
  if (domOn < 0.5) return 1.0;
  vec4 c = domMatrix * vec4(world, 1.0);
  vec3 p = c.xyz / c.w * 0.5 + 0.5;
  if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0) return 1.0;
  float z0 = texture2D(domDepth, p.xy).r;
  if (z0 >= 1.0) return 1.0;
  float d = max(0.0, (p.z - z0) * domRange);
  vec4 o = texture2D(domLayers, p.xy);
  float b1 = ${BANDS[0]}, b2 = ${BANDS[1]}, b3 = ${BANDS[2]}, b4 = ${BANDS[3]};
  float opacity = o.r * clamp(d / b1, 0.0, 1.0)
    + o.g * clamp((d - b1) / (b2 - b1), 0.0, 1.0)
    + o.b * clamp((d - b2) / (b3 - b2), 0.0, 1.0)
    + o.a * clamp((d - b3) / (b4 - b3), 0.0, 1.0);
  return exp(-opacity);
}`;

const EXPAND = /* glsl */ `
attribute vec3 aNext;
attribute float aSide;
attribute float aV;
attribute float aWidth;
uniform float rootWidth;
uniform float tipWidth;
uniform float pixelRows;
/** Narrowest drawn width, in pixels. */
uniform float minPixels;
vec4 strandWorld(out vec3 t, out float trueWidth, out float width) {
  vec4 w = modelMatrix * vec4(position, 1.0);
  t = normalize((modelMatrix * vec4(aNext, 1.0)).xyz - w.xyz);
  vec3 toEye = normalize(cameraPosition - w.xyz);
  vec3 across = normalize(cross(t, toEye));
  float scale = length(modelMatrix[0].xyz);
  vec4 clip = projectionMatrix * viewMatrix * w;
  float pixel = clip.w * 2.0 / (projectionMatrix[1][1] * pixelRows);
  trueWidth = mix(rootWidth, tipWidth, aV) * aWidth * scale;
  width = max(trueWidth, pixel * minPixels);
  w.xyz += across * aSide * width * 0.5;
  return w;
}`;

const VERTEX = /* glsl */ `
${EXPAND}
attribute float aSeed;
attribute float aGrey;
/** 1 for brows and lashes: thinner than a pixel, they fade by their share of it. 0 for hair, which stays opaque. */
uniform float subPixelFade;
varying vec3 vT;
varying vec3 vW;
varying float vV;
varying float vSeed;
varying float vGrey;
varying float vCover;
void main() {
  vec3 t; float trueWidth; float width;
  vec4 w = strandWorld(t, trueWidth, width);
  vCover = mix(1.0, clamp(trueWidth / width, 0.08, 1.0), subPixelFade);
  vT = t; vW = w.xyz; vV = aV; vSeed = aSeed; vGrey = aGrey;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 rootColour;
uniform vec3 tipColour;
uniform vec3 greyColour;
uniform float shine;
uniform vec3 lightDir[3];
uniform vec3 lightColour[3];
uniform vec3 ambient;
varying vec3 vT;
varying vec3 vW;
varying float vV;
varying float vSeed;
varying float vGrey;
varying float vCover;
${HAIR_SHADOW_GLSL}
const float PI_ = 3.14159265;
float hairG(float b, float x) { return exp(-0.5 * x * x / (b * b)) / (sqrt(2.0 * PI_) * b); }
float fresnelS(float f0, float c) { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }
// Karis 2016: Marschner's R, TT and TRT lobes for a light L seen from V.
vec3 hairBsdf(vec3 T, vec3 V, vec3 L, vec3 base, float roughness, float spec, float backlit) {
  float sinL = clamp(dot(T, L), -1.0, 1.0), sinV = clamp(dot(T, V), -1.0, 1.0);
  float cosD = cos(0.5 * abs(asin(sinV) - asin(sinL)));
  vec3 Lp = L - sinL * T, Vp = V - sinV * T;
  float cosPhi = dot(Lp, Vp) * inversesqrt(dot(Lp, Lp) * dot(Vp, Vp) + 1e-4);
  float cosHalfPhi = sqrt(clamp(0.5 + 0.5 * cosPhi, 0.0, 1.0));
  float n = 1.55, f0 = ((1.0 - n) / (1.0 + n)) * ((1.0 - n) / (1.0 + n));
  float nPrime = 1.19 / cosD + 0.36 * cosD;
  float shift = 0.035;
  float b = roughness * roughness;
  vec3 S = vec3(0.0);
  // R
  float Mp = hairG(b * sqrt(2.0) * cosHalfPhi, sinL + sinV + 2.0 * shift);
  float Np = 0.25 * cosHalfPhi;
  float Fp = fresnelS(f0, sqrt(clamp(0.5 + 0.5 * dot(L, V), 0.0, 1.0)));
  S += vec3(Mp * Np * Fp * spec * 2.0) * mix(1.0, backlit, clamp(-dot(L, V), 0.0, 1.0));
  // TT
  Mp = hairG(b * 0.5, sinL + sinV - shift);
  float a = 1.0 / nPrime;
  float h = cosHalfPhi * (1.0 + a * (0.6 - 0.8 * cosPhi));
  float f = fresnelS(f0, cosD * sqrt(clamp(1.0 - h * h, 0.0, 1.0)));
  vec3 Tp = pow(base, vec3(0.5 * sqrt(1.0 - (h * a) * (h * a)) / cosD));
  Np = exp(-3.65 * cosPhi - 3.98);
  S += Mp * Np * (1.0 - f) * (1.0 - f) * Tp * backlit;
  // TRT
  Mp = hairG(b * 2.0, sinL + sinV - 4.0 * shift);
  f = fresnelS(f0, cosD * 0.5);
  Tp = pow(base, vec3(0.8 / cosD));
  Np = exp(17.0 * cosPhi - 16.78);
  S += Mp * Np * (1.0 - f) * (1.0 - f) * f * Tp;
  return S;
}
void main() {
  vec3 T = normalize(vT);
  vec3 V = normalize(cameraPosition - vW);
  vec3 base = mix(rootColour, tipColour, smoothstep(0.25, 1.0, vV));
  base = mix(base, greyColour, vGrey);
  base *= 0.85 + 0.3 * vSeed;
  // Transmittance of the key light through the hair in front of this point.
  float shadow = hairTransmittance(vW);
  float luma = max(1e-3, dot(base, vec3(0.3, 0.59, 0.11)));
  // Light scattered through the hair takes the hair's colour, more so deep inside (Karis).
  vec3 scatterTint = pow(base / luma, vec3(1.0 - shadow));
  vec3 N = normalize(V - T * dot(V, T));
  vec3 colour = ambient * base * mix(0.35, 1.0, shadow);
  for (int i = 0; i < 3; i++) {
    vec3 L = normalize(lightDir[i]);
    // Only the key light has an opacity map; fill and rim come from elsewhere, so it says nothing of theirs.
    float through = i == 0 ? shadow : 1.0;
    float kajiya = 1.0 - abs(dot(N, L));
    float wrapNL = clamp((dot(N, L) + 1.0) / 4.0, 0.0, 1.0);
    // Karis's diffuse scatter, times Unreal's hair Scatter (0.5): sqrt(base) lifts dark hair, so more washes it out.
    vec3 diffuse = (1.0 / PI_) * mix(wrapNL, kajiya, 0.33) * 0.5 * sqrt(base) * scatterTint;
    vec3 specular = hairBsdf(T, V, L, base, 0.42, 0.5 * shine, 1.0) * shine;
    colour += lightColour[i] * through * (diffuse + specular);
  }
  gl_FragColor = vec4(colour, (1.0 - smoothstep(0.82, 1.0, vV) * 0.85) * vCover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Depth only, from the light (first pass of the opacity map). */
const DOM_DEPTH_FRAGMENT = /* glsl */ `void main() { gl_FragColor = vec4(1.0); }`;

/** Each strand fragment adds its opacity to the band its depth behind the first strand falls in. */
const DOM_LAYERS_VERTEX = /* glsl */ `
${EXPAND}
varying vec3 vClip;
varying float vCover;
void main() {
  vec3 t; float trueWidth; float width;
  vec4 w = strandWorld(t, trueWidth, width);
  // Widened to a whole texel, a strand adds only the share of it it covers.
  vCover = trueWidth / width;
  gl_Position = projectionMatrix * viewMatrix * w;
  vClip = gl_Position.xyz / gl_Position.w * 0.5 + 0.5;
}`;
const DOM_LAYERS_FRAGMENT = /* glsl */ `
uniform sampler2D domDepth;
uniform float domRange;
uniform float perStrand;
varying vec3 vClip;
varying float vCover;
void main() {
  float z0 = texture2D(domDepth, vClip.xy).r;
  float d = max(0.0, (vClip.z - z0) * domRange);
  vec4 band = d < ${BANDS[0]} ? vec4(1, 0, 0, 0) : d < ${BANDS[1]} ? vec4(0, 1, 0, 0) : d < ${BANDS[2]} ? vec4(0, 0, 1, 0) : vec4(0, 0, 0, 1);
  gl_FragColor = band * perStrand * vCover;
}`;

export function strandMaterial(lights: StrandLights, shadow: HairShadowUniforms): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      rootWidth: { value: 0.0004 }, tipWidth: { value: 0.0001 }, subPixelFade: { value: 0 }, pixelRows: { value: 720 }, minPixels: { value: 0.5 },
      rootColour: { value: new Color() }, tipColour: { value: new Color() }, greyColour: { value: new Color(0xb8b6b2) },
      shine: { value: 1 },
      lightDir: { value: lights.dirs.map((d) => d.clone().normalize()) },
      lightColour: { value: lights.colours },
      ambient: { value: lights.ambient },
      ...shadow,
    },
    alphaToCoverage: true,
    transparent: false,
    // A ribbon turned to the camera winds either way, by which way its strand runs on screen.
    side: DoubleSide,
  });
}

/**
 * The Deep Opacity Map of the hair from the key light (Yuksel and Keyser
 * 2008): 512 texels square over the hair's bounds, four depth bands.
 * Rebuilt when the hair changes, not every frame.
 */
export class HairShadow {
  readonly uniforms: HairShadowUniforms;
  private readonly depthTarget: WebGLRenderTarget;
  private readonly layerTarget: WebGLRenderTarget;
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  private readonly scene = new Scene();
  private readonly depthMat: ShaderMaterial;
  private readonly layerMat: ShaderMaterial;

  constructor(private readonly lightDir: Vector3) {
    const size = 512;
    const depth = new DepthTexture(size, size);
    depth.type = FloatType;
    this.depthTarget = new WebGLRenderTarget(size, size, { depthTexture: depth, depthBuffer: true });
    this.layerTarget = new WebGLRenderTarget(size, size, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter });
    this.uniforms = {
      domDepth: { value: depth }, domLayers: { value: this.layerTarget.texture }, domMatrix: { value: new Matrix4() }, domRange: { value: 1 }, domOn: { value: 0 },
    };
    const widths = { rootWidth: { value: 0.0009 }, tipWidth: { value: 0.0003 }, pixelRows: { value: size }, minPixels: { value: 1 } };
    this.depthMat = new ShaderMaterial({ vertexShader: DOM_LAYERS_VERTEX, fragmentShader: DOM_DEPTH_FRAGMENT, uniforms: { ...widths }, side: DoubleSide, colorWrite: false });
    this.layerMat = new ShaderMaterial({
      vertexShader: DOM_LAYERS_VERTEX, fragmentShader: DOM_LAYERS_FRAGMENT, side: DoubleSide,
      uniforms: { ...widths, domDepth: { value: depth }, domRange: { value: 1 }, perStrand: { value: 1.5 } },
      blending: AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
  }

  /** Renders the map for this hair (in the scene, with its world matrix), or turns it off for none. */
  update(renderer: WebGLRenderer, hair: Mesh | null, rootWidth: number, tipWidth: number): void {
    if (!hair) { this.uniforms.domOn.value = 0; return; }
    hair.updateWorldMatrix(true, false);
    const bounds = (hair.geometry.boundingSphere ?? new Sphere()).clone().applyMatrix4(hair.matrixWorld);
    const r = bounds.radius * 1.05;
    const cam = this.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 0.01; cam.far = r * 4;
    cam.position.copy(bounds.center).addScaledVector(this.lightDir.clone().normalize(), r * 2);
    cam.lookAt(bounds.center);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    for (const m of [this.depthMat, this.layerMat]) { m.uniforms['rootWidth']!.value = rootWidth; m.uniforms['tipWidth']!.value = tipWidth; }
    const range = cam.far - cam.near;
    this.layerMat.uniforms['domRange']!.value = range;
    this.uniforms.domRange.value = range;
    this.uniforms.domMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    const proxy = new Mesh(hair.geometry, this.depthMat);
    proxy.matrixAutoUpdate = false;
    proxy.matrix.copy(hair.matrixWorld);
    proxy.matrixWorld.copy(hair.matrixWorld);
    proxy.frustumCulled = false;
    this.scene.add(proxy);
    const before = renderer.getRenderTarget();
    const clear = renderer.getClearColor(new Color()), alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.depthTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(this.scene, cam);
    proxy.material = this.layerMat;
    renderer.setRenderTarget(this.layerTarget);
    renderer.clear(true, false, false);
    renderer.render(this.scene, cam);
    this.scene.remove(proxy);
    renderer.setRenderTarget(before);
    renderer.setClearColor(clear, alpha);
    this.uniforms.domOn.value = 1;
  }
}

/** Ribbon geometry for a strand set (two vertices per point). */
export function strandGeometry(set: StrandSet): BufferGeometry {
  let points = 0;
  for (const c of set.counts) points += c;
  const pos = new Float32Array(points * 6), next = new Float32Array(points * 6);
  const side = new Float32Array(points * 2), v = new Float32Array(points * 2), seed = new Float32Array(points * 2), grey = new Float32Array(points * 2);
  const width = new Float32Array(points * 2);
  let segs = 0;
  for (const c of set.counts) segs += c - 1;
  const index = new Uint32Array(segs * 6);
  let at = 0, ii = 0;
  for (let s = 0; s < set.counts.length; s++) {
    const n = set.counts[s]!;
    for (let i = 0; i < n; i++) {
      const p = at + i;
      // The point the strand heads to (the last point looks back).
      const q = i < n - 1 ? p + 1 : p - 1, flip = i < n - 1 ? 1 : -1;
      for (let k = 0; k < 2; k++) {
        const o = p * 2 + k;
        for (let d = 0; d < 3; d++) {
          pos[o * 3 + d] = set.points[p * 3 + d]!;
          // For the last point, a point beyond it along the strand.
          next[o * 3 + d] = flip > 0 ? set.points[q * 3 + d]! : 2 * set.points[p * 3 + d]! - set.points[q * 3 + d]!;
        }
        side[o] = k ? 1 : -1;
        v[o] = n > 1 ? i / (n - 1) : 0;
        seed[o] = set.seeds[s]!;
        grey[o] = set.grey[s]!;
        width[o] = set.widths ? set.widths[s]! : 1;
      }
      if (i < n - 1) {
        const a = p * 2, b = p * 2 + 1, c2 = (p + 1) * 2, d = (p + 1) * 2 + 1;
        index[ii++] = a; index[ii++] = c2; index[ii++] = b;
        index[ii++] = b; index[ii++] = c2; index[ii++] = d;
      }
    }
    at += n;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aNext', new BufferAttribute(next, 3));
  g.setAttribute('aSide', new BufferAttribute(side, 1));
  g.setAttribute('aV', new BufferAttribute(v, 1));
  g.setAttribute('aSeed', new BufferAttribute(seed, 1));
  g.setAttribute('aGrey', new BufferAttribute(grey, 1));
  g.setAttribute('aWidth', new BufferAttribute(width, 1));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/** A strand layer's mesh; its material is reused across rebuilds. */
export function strandMesh(set: StrandSet, look: StrandLook, material: ShaderMaterial): Mesh {
  const u = material.uniforms;
  u['rootWidth']!.value = set.rootWidth;
  u['tipWidth']!.value = set.tipWidth;
  (u['rootColour']!.value as Color).setHex(look.root);
  (u['tipColour']!.value as Color).setHex(look.tip);
  if (look.grey !== undefined) (u['greyColour']!.value as Color).setHex(look.grey);
  u['shine']!.value = look.shine;
  u['subPixelFade']!.value = look.fadeThin ? 1 : 0;
  const mesh = new Mesh(strandGeometry(set), material);
  mesh.frustumCulled = false;
  return mesh;
}
