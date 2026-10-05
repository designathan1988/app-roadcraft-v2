import {
  BufferGeometry,
  BufferAttribute,
  NormalBlending,
  Points,
  ShaderMaterial,
} from 'three';

import { windUniforms } from './wind';

/**
 * Exhaust smoke and dust: soft puffs that leave the tail of a vehicle (or the
 * ground under its wheels), rise, spread, thin out and drift downwind.
 *
 * One `Points` cloud for the whole map, a fixed pool reused as a ring - the
 * way engine particle systems keep a budget: a puff is spawned by writing its
 * birth time and origin into the next slot, and the vertex shader ages it
 * (rise, growth, wind drift); nothing is allocated per frame. Sizes are in
 * world units projected by the camera, so a puff is the size of a puff at any
 * zoom.
 */

/** Puffs alive at once, map-wide. */
const POOL = 900;
/** Seconds a puff lives. */
const LIFE = 2.6;

export interface Exhaust {
  readonly points: Points;
  /**
   * A vehicle at (x, y) on a deck at height `z`, heading `angle`, `length`
   * long, moving at `speed` (units/s); `dusty` when its wheels are on
   * unpaved ground. Spawns puffs at the tail at a rate that rises with speed.
   */
  emit(x: number, y: number, z: number, angle: number, length: number, speed: number, dusty: boolean): void;
  /** Advances the clock the shader ages puffs by. */
  tick(seconds: number, halfHeight: number): void;
  dispose(): void;
}

export function createExhaust(): Exhaust {
  const origin = new Float32Array(POOL * 3);
  const born = new Float32Array(POOL).fill(-1e6);
  const kind = new Float32Array(POOL);
  const seed = new Float32Array(POOL);
  for (let i = 0; i < POOL; i++) seed[i] = Math.random();
  const geometry = new BufferGeometry();
  // BufferAttribute (not Float32BufferAttribute, which copies): the pool is
  // written in place through these same arrays.
  geometry.setAttribute('position', new BufferAttribute(origin, 3));
  geometry.setAttribute('aBorn', new BufferAttribute(born, 1));
  geometry.setAttribute('aKind', new BufferAttribute(kind, 1));
  geometry.setAttribute('aSeed', new BufferAttribute(seed, 1));
  geometry.boundingSphere = null;
  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLife: { value: LIFE },
      uWindDir: windUniforms.uWindDir,
      uHalfH: { value: 400 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uLife;
      uniform vec2 uWindDir;
      uniform float uHalfH;
      attribute float aBorn;
      attribute float aKind;
      attribute float aSeed;
      varying float vAlpha;
      varying float vKind;
      void main() {
        float age = (uTime - aBorn) / uLife;
        vKind = aKind;
        if (age < 0.0 || age > 1.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 0.0;
          vAlpha = 0.0;
          return;
        }
        vec3 p = position;
        float t = age * uLife;
        // Rises (dust less), spreads, and is carried downwind.
        p.y += (aKind > 0.5 ? 1.0 : 2.4) * t + 0.15 * sin(t * 3.0 + aSeed * 6.28);
        p.xz += uWindDir * (3.0 * t + 0.8 * t * t) + vec2(sin(aSeed * 40.0), cos(aSeed * 40.0)) * 0.5 * t;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // World units across (1 unit = 0.4 m): a puff leaves the pipe about
        // a metre wide and spreads to three; dust is twice that.
        float size = (aKind > 0.5 ? 6.0 : 2.4) * (0.5 + 2.0 * age);
        // Projected size in pixels, for the isometric (orthographic) camera
        // and the perspective one alike.
        bool ortho = projectionMatrix[3][3] == 1.0;
        gl_PointSize = size * projectionMatrix[1][1] * uHalfH / (ortho ? 1.0 : max(1.0, -mv.z));
        vAlpha = (aKind > 0.5 ? 0.4 : 0.36) * smoothstep(0.0, 0.08, age) * (1.0 - age);
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vKind;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        float soft = smoothstep(1.0, 0.0, r);
        vec3 smoke = vec3(0.55, 0.56, 0.58);
        vec3 dust = vec3(0.62, 0.53, 0.40);
        gl_FragColor = vec4(mix(smoke, dust, vKind), vAlpha * soft * soft);
      }`,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
  });
  const points = new Points(geometry, material);
  points.name = 'exhaust';
  points.frustumCulled = false;
  points.renderOrder = 5;

  let next = 0;
  let now = 0;
  /** Fractional puffs owed per vehicle-call, carried as one pool-wide budget. */
  let owed = 0;
  /** Wall time between the last two frames: emission follows real time, not the sim's step. */
  let frameDt = 1 / 60;
  let lastWall = -1;
  const position = geometry.getAttribute('position') as BufferAttribute;
  const bornAttr = geometry.getAttribute('aBorn') as BufferAttribute;
  const kindAttr = geometry.getAttribute('aKind') as BufferAttribute;
  let dirtyFrom = POOL, dirtyTo = -1;
  const spawn = (x: number, y: number, z: number, k: number): void => {
    const i = next;
    next = (next + 1) % POOL;
    // World y is three's -z, as everywhere in this layer.
    origin[i * 3] = x;
    origin[i * 3 + 1] = z;
    origin[i * 3 + 2] = -y;
    born[i] = now;
    kind[i] = k;
    dirtyFrom = Math.min(dirtyFrom, i);
    dirtyTo = Math.max(dirtyTo, i);
  };
  return {
    points,
    emit(x, y, z, angle, length, speed, dusty) {
      const dt = frameDt;
      const moving = Math.abs(speed) > 0.5;
      // A running engine puffs a little standing still, more pulling away.
      owed += dt * (moving ? 2.2 + Math.min(4, Math.abs(speed) * 0.08) : 0.9);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const tailX = x - cos * length * 0.5, tailY = y - sin * length * 0.5;
      while (owed >= 1) {
        owed -= 1;
        spawn(tailX + (Math.random() - 0.5) * 0.8, tailY + (Math.random() - 0.5) * 0.8, z + 1.0, 0);
      }
      if (dusty && moving && Math.random() < dt * 6) spawn(tailX, tailY, z + 0.2, 1);
    },
    tick(seconds, halfHeight) {
      now = seconds;
      const wall = typeof performance !== 'undefined' ? performance.now() / 1000 : seconds;
      frameDt = lastWall < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, wall - lastWall));
      lastWall = wall;
      material.uniforms['uHalfH']!.value = halfHeight;
      material.uniforms['uTime']!.value = seconds;
      if (dirtyTo >= dirtyFrom) {
        // Rewrites the whole small pool: 900 puffs is a few kilobytes.
        position.needsUpdate = true;
        bornAttr.needsUpdate = true;
        kindAttr.needsUpdate = true;
        dirtyFrom = POOL;
        dirtyTo = -1;
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
