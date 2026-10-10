import { PLANET_RADIUS } from '@core/cubeSphere';
import { Rng } from '@core/rng';
import {
  AdditiveBlending, BackSide, BufferGeometry, Color, CustomBlending, Float32BufferAttribute, FrontSide, HalfFloatType,
  LinearFilter, Matrix3, Matrix4, Mesh, OneFactor, PlaneGeometry, Points, RepeatWrapping, ShaderMaterial,
  SphereGeometry, SrcAlphaFactor, Vector3, WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { AIR_GLSL, ATMOSPHERE_TOP, airUniforms } from './air';
export { ATMOSPHERE_TOP } from './air';

/**
 * THE SPACE ROUND THE PLANET: the stars and the Milky Way, the sun, the moon
 * and the air. Drawn in the world's scene but never part of the world: none
 * of it is bent onto the planet (`bend.ts` - these shaders do not include its
 * chunks), none of it writes the world's depth, and all of it sits at the far
 * end of the depth range, so it shows only where no ground, road or building
 * stands in front of it (the sky dome's own trick, `environment.ts`).
 *
 * - The air: single scattering, Rayleigh and Mie, marched along each pixel's
 *   ray through a shell round the planet (Nishita et al. 1993; Sean O'Neil,
 *   "Accurate Atmospheric Scattering", GPU Gems 2 ch. 16; the coefficients
 *   and scale heights of wwwtyro/glsl-atmosphere). The Earth's are scaled by
 *   the ratio of the shells' thicknesses, so the optical depth - and so the
 *   colours of the sky, the limb and the dusk - are the Earth's. Blended as
 *   `in-scattered + behind * transmittance`: the ground is seen through it.
 * - The stars: points, by magnitude (counts tripling a magnitude) and by
 *   colour temperature (Tanner Helland's black-body fit), crowded towards the
 *   galactic plane; the Milky Way's glow baked once into a texture. They turn
 *   with the sun round the planet's axis, as the sky turns.
 * - The moon: tidally locked, lit by the sun (its phases from the angle
 *   between them), its craters a cellular field of bowls with raised rims
 *   (simple craters: depth about a fifth of the diameter, NASA), shaded by
 *   bump mapping from screen derivatives (three's `perturbNormalArb`, after
 *   Mikkelsen 2010).
 * - The sun: from space a white disc and its glow, bright past the bloom's
 *   threshold; from the ground the sky dome draws it.
 */

/** The moon: radius and distance from the planet's centre. */
const MOON_RADIUS = PLANET_RADIUS * 0.27;
const MOON_DISTANCE = PLANET_RADIUS * 16;
/** A synodic month, in days of the game. */
const LUNAR_MONTH = 29.53;
/** The moon's orbit's tilt to the sun's path, radians. */
const MOON_TILT = (5.1 * Math.PI) / 180;
const STAR_COUNT = 9000;
/** Just inside the far plane: what is drawn there shows only where nothing stands in front. */
const FAR_GLSL = /* glsl */ `
  void atFar(inout vec4 clip, float k) { clip.z = clip.w * (1.0 - k * 1.0e-6); }
`;

const ATMOSPHERE_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
    // Never cut by the far plane: the air behind the planet is the planet's limb.
    gl_Position.z = min(gl_Position.z, gl_Position.w * 0.999999);
  }
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
  varying vec3 vWorld;
  ${AIR_GLSL}
  void main() {
    gl_FragColor = airLight(cameraPosition, normalize(vWorld - cameraPosition));
  }
`;

const STARS_VERTEX = /* glsl */ `
  attribute vec3 tint;
  attribute float size;
  uniform mat3 uSky;
  uniform float uPixel;
  varying vec3 vTint;
  ${FAR_GLSL}
  void main() {
    vec3 dir = uSky * position;
    vec4 clip = projectionMatrix * viewMatrix * vec4(cameraPosition + dir * 1000.0, 1.0);
    atFar(clip, 1.0);
    gl_Position = clip;
    gl_PointSize = size * uPixel;
    vTint = tint;
  }
`;

const STARS_FRAGMENT = /* glsl */ `
  uniform float uShow;
  varying vec3 vTint;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 5.0);
    gl_FragColor = vec4(vTint * core * uShow, 1.0);
  }
`;

const GALAXY_BAKE = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 uPole;
  uniform vec3 uCore;
  const float PI = 3.14159265;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * noise(p); p *= 2.07; a *= 0.5; } return s; }
  void main() {
    float lon = (vUv.x - 0.5) * 2.0 * PI, lat = (vUv.y - 0.5) * PI;
    vec3 d = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
    float b = asin(clamp(dot(d, uPole), -1.0, 1.0));
    float toCore = acos(clamp(dot(d, uCore), -1.0, 1.0));
    float band = exp(-pow(b / (0.09 + 0.08 * exp(-toCore * 1.6)), 2.0));
    float clouds = fbm(d * 4.0) * 0.7 + fbm(d * 13.0) * 0.45;
    float dust = smoothstep(0.42, 0.68, fbm(d * 7.0 + 3.1)) * exp(-pow(b / 0.045, 2.0));
    float glow = band * pow(clouds, 1.6) * (1.0 - 0.8 * dust) * (1.0 + 2.6 * exp(-toCore * 2.2));
    vec3 tint = mix(vec3(0.7, 0.78, 1.0), vec3(1.0, 0.86, 0.7), exp(-toCore * 2.4));
    // Linear light, kept low: the display's curve lifts the dark a long way
    // (a 0.005 grain showed as blotches over the whole sky; at 0.045 the band
    // read as a brown smoke across the screen).
    gl_FragColor = vec4(tint * glow * 0.022, 1.0);
  }
`;

const GALAXY_VERTEX = /* glsl */ `
  uniform mat3 uSky;
  varying vec3 vDir;
  ${FAR_GLSL}
  void main() {
    vDir = position;
    vec4 clip = projectionMatrix * viewMatrix * vec4(cameraPosition + (uSky * position) * 1000.0, 1.0);
    atFar(clip, 1.0);
    gl_Position = clip;
  }
`;

const GALAXY_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uShow;
  varying vec3 vDir;
  const float PI = 3.14159265;
  void main() {
    vec3 d = normalize(vDir);
    vec2 uv = vec2(atan(d.y, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.z, -1.0, 1.0)) / PI + 0.5);
    gl_FragColor = vec4(texture2D(uMap, uv).rgb * uShow, 1.0);
  }
`;

const SUN_VERTEX = /* glsl */ `
  uniform vec3 uSun;
  uniform float uSize;
  varying vec2 vUv;
  ${FAR_GLSL}
  void main() {
    vUv = position.xy;
    vec4 view = viewMatrix * vec4(cameraPosition + uSun * 1000.0, 1.0);
    view.xy += position.xy * uSize * 1000.0;
    vec4 clip = projectionMatrix * view;
    atFar(clip, 1.0);
    gl_Position = clip;
  }
`;

const SUN_FRAGMENT = /* glsl */ `
  uniform float uShow;
  uniform float uDisc;
  varying vec2 vUv;
  void main() {
    float r = length(vUv);
    float disc = 1.0 - smoothstep(uDisc * 0.92, uDisc, r);
    float glow = exp(-r * 12.0) * 1.6 + exp(-r * 4.5) * 0.22;
    // A faint six-point star of the eye's lashes over the glare.
    float a = atan(vUv.y, vUv.x);
    float rays = pow(abs(cos(a * 3.0)), 40.0) * exp(-r * 6.0) * 0.5;
    // Down to nothing before the quad's edge: any step there, with the bloom
    // over it, drew the square the glow is painted on.
    float window = 1.0 - smoothstep(0.55, 0.98, r);
    vec3 c = vec3(1.0, 0.96, 0.9) * (disc * 40.0 + (glow + rays) * window);
    gl_FragColor = vec4(c * uShow, 1.0);
  }
`;

const MOON_VERTEX = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vLocal = position;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 clip = projectionMatrix * viewMatrix * world;
    // Beyond the far plane it is still drawn, just inside it, behind everything near.
    clip.z = min(clip.z, clip.w * (1.0 - 2.0e-6));
    gl_Position = clip;
  }
`;

const MOON_FRAGMENT = /* glsl */ `
  uniform vec3 uSun;
  uniform float uShow;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vWorld;
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  // Simple craters on a cellular field: a bowl a fifth as deep as it is
  // wide, a raised rim and the ejecta round it.
  float craters(vec3 p, float cells, float seed, float keep) {
    vec3 q = p * cells;
    vec3 id = floor(q);
    float h = 0.0;
    for (int k = 0; k < 27; k++) {
      vec3 c = id + vec3(float(k - (k / 3) * 3 - 1), float((k / 3) - (k / 9) * 3 - 1), float(k / 9 - 1));
      if (hash13(c + seed) > keep) continue;
      vec3 centre = c + 0.15 + 0.7 * hash33(c + seed * 1.3);
      float r = 0.12 + 0.33 * hash13(c - seed);
      float d = length(q - centre) / r;
      if (d > 2.6) continue;
      float bowl = d < 1.0 ? (d * d - 1.0) * 0.4 : 0.0;
      float rim = exp(-pow((d - 1.0) / 0.2, 2.0)) * 0.16;
      float ejecta = d > 1.0 ? 0.05 * exp(-(d - 1.0) * 2.5) : 0.0;
      h += (bowl + rim + ejecta) * r;
    }
    return h / cells;
  }
  void main() {
    vec3 p = normalize(vLocal);
    float h = craters(p, 3.0, 1.0, 0.55) + craters(p, 8.0, 7.0, 0.5) + craters(p, 22.0, 13.0, 0.45) * 0.8;
    // Maria: the dark basalt plains, on the near side mostly.
    float maria = smoothstep(0.55, 0.7, noise(p * 2.2 + 4.0) * 0.65 + noise(p * 5.0) * 0.35) * smoothstep(-0.4, 0.3, p.x);
    float albedo = mix(0.17, 0.075, maria) * (0.85 + 0.3 * noise(p * 40.0));
    // Bump from the height's screen derivatives (three's perturbNormalArb).
    vec3 n = normalize(vNormal);
    vec3 dpdx = dFdx(vWorld), dpdy = dFdy(vWorld);
    float scale = 1100.0 * (1.0 - 0.6 * maria);
    float dhdx = dFdx(h) * scale, dhdy = dFdy(h) * scale;
    vec3 r1 = cross(dpdy, n), r2 = cross(n, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
    n = normalize(abs(det) * n - grad);
    float mu0 = max(dot(n, uSun), 0.0);
    vec3 view = normalize(cameraPosition - vWorld);
    float mu = max(dot(n, view), 0.0);
    // Lommel-Seeliger with a little Lambert: the full moon bright to its limb.
    float lit = mix(mu0 / max(mu0 + mu, 1e-3) * 2.0, mu0, 0.35);
    vec3 c = vec3(1.0, 0.98, 0.95) * albedo * lit * 9.0 + vec3(0.02, 0.025, 0.035) * albedo;
    gl_FragColor = vec4(c * uShow, 1.0);
  }
`;

/** Tanner Helland's fit of a black body's colour (1000..40000 K), linear-ish 0..1. */
function kelvin(t: number, out: Color): Color {
  const k = t / 100;
  const r = k <= 66 ? 255 : 329.698727446 * (k - 60) ** -0.1332047592;
  const g = k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * (k - 60) ** -0.0755148492;
  const b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  const c = (v: number): number => Math.min(255, Math.max(0, v)) / 255;
  // The fit is in display values: to linear light.
  return out.setRGB(c(r) ** 2.2, c(g) ** 2.2, c(b) ** 2.2);
}

/** The galactic plane's pole and the core's direction, in the planet's frame (unit). */
const GALACTIC_POLE = new Vector3(0.35, -0.55, 0.76).normalize();
const GALACTIC_CORE = new Vector3(0.9, 0.4, 0).projectOnPlane(GALACTIC_POLE).normalize();

function makeStars(): BufferGeometry {
  const rng = new Rng(0x5747a2);
  const position = new Float32Array(STAR_COUNT * 3);
  const tint = new Float32Array(STAR_COUNT * 3);
  const size = new Float32Array(STAR_COUNT);
  const colour = new Color();
  // Temperatures as the naked eye sees them: hot blue-white and cool orange
  // giants over-represented against the galaxy's red dwarfs.
  const kinds = [[25000, 0.04], [11000, 0.18], [8000, 0.18], [6500, 0.16], [5600, 0.16], [4500, 0.2], [3400, 0.08]] as const;
  const MIN = -1.4, MAX = 7.2;
  const span = 10 ** (0.47 * (MAX - MIN)) - 1;
  const d = new Vector3(), a = new Vector3(), b = new Vector3();
  a.copy(GALACTIC_CORE);
  b.crossVectors(GALACTIC_POLE, GALACTIC_CORE);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Magnitude: counts about tripling a magnitude down.
    const m = MIN + Math.log10(1 + rng.float() * span) / 0.47;
    // Direction: the faint ones crowd towards the galactic plane.
    if (rng.float() < 0.15 + 0.4 * ((m - MIN) / (MAX - MIN))) {
      const lon = rng.float() * Math.PI * 2;
      const lat = Math.max(-1.5, Math.min(1.5, rng.normal(0, 0.16)));
      d.copy(a).multiplyScalar(Math.cos(lat) * Math.cos(lon)).addScaledVector(b, Math.cos(lat) * Math.sin(lon)).addScaledVector(GALACTIC_POLE, Math.sin(lat));
    } else {
      const z = rng.range(-1, 1), t = rng.float() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      d.set(s * Math.cos(t), s * Math.sin(t), z);
    }
    position.set([d.x, d.y, d.z], i * 3);
    let pick = rng.float(), temperature = 5600;
    for (const [t, w] of kinds) { if (pick < w) { temperature = t; break; } pick -= w; }
    kelvin(temperature * rng.range(0.9, 1.1), colour);
    // Brightness by magnitude, its range squeezed as a photograph's is (a
    // true 2.512 a step left all but a few dozen invisible); the brightest
    // pass the bloom's threshold and glint.
    const energy = 2.6 * 10 ** (-0.21 * (m + 1));
    const px = 1.3 + Math.max(0, 5 - m) * 0.4;
    tint.set([colour.r * energy, colour.g * energy, colour.b * energy], i * 3);
    size[i] = px;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('tint', new Float32BufferAttribute(tint, 3));
  geometry.setAttribute('size', new Float32BufferAttribute(size, 1));
  return geometry;
}

export interface SpaceFrame {
  readonly camera: Camera;
  /** How far out at the globe the view is (0 at the ground .. 1 the whole planet). */
  readonly globe: number;
  /** How dark it is where the view looks (0 day .. 1 night). */
  readonly dark: number;
  /** The game's clock: minutes since the first midnight (days run on). */
  readonly minutes: number;
  /** The sun's direction, three's space, unit. */
  readonly sun: Vector3;
  /** The planet's centre as drawn. */
  readonly centre: Vector3;
  /** The motion setting the planet down (`bend.ts`): the planet's frame to three's space. */
  readonly motion: Matrix4;
  /** Device pixels per CSS pixel. */
  readonly pixelRatio: number;
}

export interface Space {
  update(frame: SpaceFrame): void;
  /** How far the sky has gone to space (0 the ground's sky .. 1 black space): what the sky dome fades by. */
  readonly spaceShare: number;
  /** Parts kept hidden by name (`space-stars`, `space-air`...): for the browser checks. */
  readonly hidden: Set<string>;
  /** The air's uniforms as drawn this frame (`air.ts`): the clouds' shadows leave its light be. */
  readonly air: Readonly<Record<string, { value: unknown }>>;
  dispose(): void;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createSpace(scene: Scene, renderer: WebGLRenderer): Space {
  const skip = { planetSkip: true };
  // THE MILKY WAY, baked once.
  const galaxyTarget = new WebGLRenderTarget(2048, 1024, { type: HalfFloatType, depthBuffer: false, magFilter: LinearFilter, minFilter: LinearFilter });
  galaxyTarget.texture.wrapS = RepeatWrapping;
  {
    const bake = new FullScreenQuad(new ShaderMaterial({
      uniforms: { uPole: { value: GALACTIC_POLE }, uCore: { value: GALACTIC_CORE } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: GALAXY_BAKE,
      depthTest: false,
      depthWrite: false,
    }));
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(galaxyTarget);
    bake.render(renderer);
    renderer.setRenderTarget(previous);
    bake.material.dispose();
    bake.dispose();
  }
  const sky = new Matrix3();
  const galaxyMaterial = new ShaderMaterial({
    uniforms: { uMap: { value: galaxyTarget.texture }, uShow: { value: 0 }, uSky: { value: sky } },
    vertexShader: GALAXY_VERTEX,
    fragmentShader: GALAXY_FRAGMENT,
    side: BackSide,
    depthWrite: false,
    transparent: true,
    blending: AdditiveBlending,
  });
  const galaxy = new Mesh(new SphereGeometry(1, 48, 24), galaxyMaterial);
  galaxy.name = 'space-galaxy';
  galaxy.frustumCulled = false;
  galaxy.renderOrder = -998;
  galaxy.userData = skip;

  const starsMaterial = new ShaderMaterial({
    uniforms: { uSky: { value: sky }, uShow: { value: 0 }, uPixel: { value: 1 } },
    vertexShader: STARS_VERTEX,
    fragmentShader: STARS_FRAGMENT,
    depthWrite: false,
    transparent: true,
    blending: AdditiveBlending,
  });
  const stars = new Points(makeStars(), starsMaterial);
  stars.name = 'space-stars';
  stars.frustumCulled = false;
  stars.renderOrder = -997;
  stars.userData = skip;

  const sunMaterial = new ShaderMaterial({
    uniforms: { uSun: { value: new Vector3() }, uShow: { value: 0 }, uSize: { value: 0.16 }, uDisc: { value: 0.034 } },
    vertexShader: SUN_VERTEX,
    fragmentShader: SUN_FRAGMENT,
    depthWrite: false,
    transparent: true,
    blending: AdditiveBlending,
  });
  const sun = new Mesh(new PlaneGeometry(2, 2), sunMaterial);
  sun.name = 'space-sun';
  sun.frustumCulled = false;
  sun.renderOrder = -996;
  sun.userData = skip;

  const moonMaterial = new ShaderMaterial({
    uniforms: { uSun: { value: new Vector3() }, uShow: { value: 0 } },
    vertexShader: MOON_VERTEX,
    fragmentShader: MOON_FRAGMENT,
    side: FrontSide,
  });
  const moon = new Mesh(new SphereGeometry(1, 64, 32), moonMaterial);
  moon.name = 'space-moon';
  moon.frustumCulled = false;
  moon.renderOrder = -999;
  moon.scale.setScalar(MOON_RADIUS);
  moon.userData = skip;

  const airMaterial = new ShaderMaterial({
    uniforms: airUniforms(),
    vertexShader: ATMOSPHERE_VERTEX,
    fragmentShader: ATMOSPHERE_FRAGMENT,
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: SrcAlphaFactor,
  });
  const air = new Mesh(new SphereGeometry(1, 96, 48), airMaterial);
  air.name = 'space-air';
  air.frustumCulled = false;
  // Over everything the world draws: the ground is seen through the air.
  air.renderOrder = 1e9;
  air.scale.setScalar(ATMOSPHERE_TOP);
  air.userData = skip;

  for (const object of [galaxy, stars, sun, moon, air]) scene.add(object);

  const axis = new Vector3();
  const spin = new Matrix4();
  const rotation = new Matrix4();
  const toward = new Vector3();
  const moonDir = new Vector3();
  const up = new Vector3();
  const side = new Vector3();
  const basis = new Matrix4();
  let spaceShare = 0;
  const hidden = new Set<string>();

  return {
    hidden,
    air: airMaterial.uniforms,
    get spaceShare() {
      return spaceShare;
    },
    update(frame) {
      const { globe, dark, minutes, centre, motion, camera } = frame;
      // From the ground's sky to space as the view climbs to the globe.
      spaceShare = smooth(0.0, 0.12, globe);
      // The sky turns with the sun round the planet's axis (`world/planet/sun.ts`).
      const sigma = (-(minutes - 720) / 1440) * Math.PI * 2;
      rotation.extractRotation(motion);
      spin.makeRotationZ(sigma);
      sky.setFromMatrix4(spin.premultiply(rotation));
      // Stars on the ground at night (under what light the sky still has), and all of them in space.
      const starsShow = Math.max(spaceShare, smooth(0.55, 0.95, dark) * 0.9);
      starsMaterial.uniforms['uShow']!.value = starsShow;
      starsMaterial.uniforms['uPixel']!.value = frame.pixelRatio;
      galaxyMaterial.uniforms['uShow']!.value = starsShow;
      stars.visible = galaxy.visible = starsShow > 0.001;
      // The sun's own disc from space; from the ground the dome draws it.
      sunMaterial.uniforms['uShow']!.value = spaceShare;
      (sunMaterial.uniforms['uSun']!.value as Vector3).copy(frame.sun);
      sun.visible = spaceShare > 0.001;
      // The moon: phase by its lag behind the sun, on an orbit tilted a little.
      const phase = (minutes / 1440 / LUNAR_MONTH) % 1;
      const lunar = sigma - phase * Math.PI * 2;
      axis.set(0, 0, 1).applyMatrix4(rotation);
      moonDir.set(Math.cos(lunar), Math.sin(lunar), Math.sin(MOON_TILT) * Math.sin(lunar * 0.5 + 1.3)).normalize().applyMatrix4(rotation);
      moon.position.copy(centre).addScaledVector(moonDir, MOON_DISTANCE);
      // Tidally locked: its +x always to the planet.
      toward.copy(moonDir).negate();
      side.crossVectors(axis, toward).normalize();
      up.crossVectors(toward, side);
      basis.makeBasis(toward, side, up);
      moon.quaternion.setFromRotationMatrix(basis);
      (moonMaterial.uniforms['uSun']!.value as Vector3).copy(frame.sun);
      moonMaterial.uniforms['uShow']!.value = Math.max(spaceShare, smooth(0.3, 0.8, dark));
      moon.visible = true;
      // The air round the planet, seen from above it.
      air.position.copy(centre);
      (airMaterial.uniforms['uAirCentre']!.value as Vector3).copy(centre);
      (airMaterial.uniforms['uAirSun']!.value as Vector3).copy(frame.sun);
      airMaterial.uniforms['uAirStrength']!.value = spaceShare;
      air.visible = spaceShare > 0.001;
      for (const object of [galaxy, stars, sun, moon, air]) if (hidden.has(object.name)) object.visible = false;
      void camera;
    },
    dispose() {
      for (const object of [galaxy, stars, sun, moon, air]) {
        scene.remove(object);
        object.geometry.dispose();
        (object.material as ShaderMaterial).dispose();
      }
      galaxyTarget.dispose();
    },
  };
}
