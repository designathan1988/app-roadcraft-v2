import {
  BufferAttribute,
  BufferGeometry,
  NormalBlending,
  Points,
  ShaderMaterial,
} from 'three';

import { windUniforms } from './wind';

/**
 * Smoke and dust: soft puffs that rise, spread, thin out and drift downwind.
 * Exhaust from the tail of a vehicle, dust from its wheels off the road, and
 * the clouds of a building breaking or coming down (`burst`).
 *
 * One `Points` cloud for the whole map, a fixed pool reused as a ring - the
 * way engine particle systems keep a budget: a puff is spawned by writing its
 * birth time, origin, size and life into the next slot, and the vertex shader
 * ages it (rise, growth, wind drift); nothing is allocated per frame.
 */

/** Puffs alive at once, map-wide. */
const POOL = 4000;
/** Seconds an exhaust puff lives. */
const EXHAUST_LIFE = 2.6;

/** 0 exhaust, 1 dust (brown-grey, low and wide), 2 dark smoke (rises), 3 concrete dust (pale, billowing), 4 blood spray (thrown up, falls). */
export type PuffKind = 0 | 1 | 2 | 3 | 4;

export interface Exhaust {
  readonly points: Points;
  /**
   * A vehicle at (x, y) on a deck at height `z`, heading `angle`, `length`
   * long, moving at `speed` (units/s); `dusty` when its wheels are on
   * unpaved ground. Spawns puffs at the tail at a rate that rises with speed.
   */
  emit(x: number, y: number, z: number, angle: number, length: number, speed: number, dusty: boolean): void;
  /**
   * `count` puffs of `kind` at once, scattered over `spread` round (x, y, z):
   * `size` is a puff's starting width in world units, `life` its seconds.
   */
  burst(x: number, y: number, z: number, count: number, kind: PuffKind, spread: number, size: number, life: number): void;
  /** Advances the clock the shader ages puffs by. */
  tick(seconds: number, halfHeight: number): void;
  dispose(): void;
}

export function createExhaust(): Exhaust {
  const origin = new Float32Array(POOL * 3);
  const born = new Float32Array(POOL).fill(-1e6);
  const kind = new Float32Array(POOL);
  const seed = new Float32Array(POOL);
  const size = new Float32Array(POOL);
  const life = new Float32Array(POOL).fill(1);
  for (let i = 0; i < POOL; i++) seed[i] = Math.random();
  const geometry = new BufferGeometry();
  // BufferAttribute (not Float32BufferAttribute, which copies): the pool is
  // written in place through these same arrays.
  geometry.setAttribute('position', new BufferAttribute(origin, 3));
  geometry.setAttribute('aBorn', new BufferAttribute(born, 1));
  geometry.setAttribute('aKind', new BufferAttribute(kind, 1));
  geometry.setAttribute('aSeed', new BufferAttribute(seed, 1));
  geometry.setAttribute('aSize', new BufferAttribute(size, 1));
  geometry.setAttribute('aLife', new BufferAttribute(life, 1));
  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWindDir: windUniforms.uWindDir,
      uHalfH: { value: 400 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec2 uWindDir;
      uniform float uHalfH;
      attribute float aBorn;
      attribute float aKind;
      attribute float aSeed;
      attribute float aSize;
      attribute float aLife;
      varying float vAlpha;
      varying float vKind;
      varying float vSeed;
      void main() {
        float t = uTime - aBorn;
        float age = t / aLife;
        vKind = aKind;
        vSeed = aSeed;
        if (age < 0.0 || age > 1.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 0.0;
          vAlpha = 0.0;
          return;
        }
        vec3 p = position;
        // Rise: smoke climbs, dust hangs low, a collapse cloud billows up and out.
        float rise = aKind < 0.5 ? 2.4 : aKind < 1.5 ? 1.0 : aKind < 2.5 ? 3.5 : 1.8;
        vec2 out2 = vec2(sin(aSeed * 40.0), cos(aSeed * 40.0));
        if (aKind > 3.5) {
          // Blood: droplets flung up and out, falling back under gravity.
          p.y += (5.0 + 10.0 * fract(aSeed * 17.0)) * t - 12.25 * t * t;
          p.xz += out2 * (3.0 + 8.0 * fract(aSeed * 7.0)) * t;
        } else {
          p.y += rise * t * (1.0 - 0.3 * age) + 0.15 * sin(t * 3.0 + aSeed * 6.28);
          float spreadOut = aKind > 2.5 ? 2.2 : aKind > 0.5 ? 1.2 : 0.5;
          p.xz += uWindDir * (3.0 * t + 0.6 * t * t) + out2 * spreadOut * t;
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float grow = aKind > 3.5 ? 0.6 : aKind > 2.5 ? 3.2 : aKind > 1.5 ? 2.6 : 2.0;
        float s = aSize * (0.5 + grow * age);
        bool ortho = projectionMatrix[3][3] == 1.0;
        gl_PointSize = s * projectionMatrix[1][1] * uHalfH / (ortho ? 1.0 : max(1.0, -mv.z));
        float peak = aKind < 0.5 ? 0.16 : aKind < 1.5 ? 0.45 : aKind < 2.5 ? 0.5 : aKind < 3.5 ? 0.42 : 0.95;
        vAlpha = peak * smoothstep(0.0, 0.06, age) * (1.0 - age) * (1.0 - age * 0.3);
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vKind;
      varying float vSeed;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        // A soft, round puff: gaussian falloff, a faint unevenness inside it
        // (an angular wobble on the edge drew five-pointed stars).
        float inner = 0.9 + 0.1 * sin(d.x * 9.0 + vSeed * 20.0) * sin(d.y * 7.0 - vSeed * 13.0);
        float soft = exp(-r * r * 3.2) * inner * smoothstep(1.0, 0.7, r);
        vec3 smoke = vec3(0.55, 0.56, 0.58);
        vec3 dust = vec3(0.6, 0.53, 0.43);
        vec3 dark = vec3(0.16, 0.15, 0.15);
        vec3 concrete = vec3(0.74, 0.71, 0.66);
        vec3 blood = vec3(0.32, 0.02, 0.03);
        vec3 c = vKind < 0.5 ? smoke : vKind < 1.5 ? dust : vKind < 2.5 ? dark : vKind < 3.5 ? concrete : blood;
        if (vKind > 3.5) soft = smoothstep(1.0, 0.55, r);
        // Shaded a little darker underneath, lighter on top.
        c *= 0.85 + 0.3 * (0.5 - d.y);
        gl_FragColor = vec4(c, vAlpha * soft);
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
  let owed = 0;
  let frameDt = 1 / 60;
  let lastWall = -1;
  let dirty = false;
  const spawn = (x: number, y: number, z: number, k: PuffKind, s: number, l: number): void => {
    const i = next;
    next = (next + 1) % POOL;
    // World y is three's -z, as everywhere in this layer.
    origin[i * 3] = x;
    origin[i * 3 + 1] = z;
    origin[i * 3 + 2] = -y;
    born[i] = now;
    kind[i] = k;
    size[i] = s;
    life[i] = l;
    seed[i] = Math.random();
    dirty = true;
  };
  return {
    points,
    emit(x, y, z, angle, length, speed, dusty) {
      const dt = frameDt;
      const moving = Math.abs(speed) > 0.5;
      // A running engine puffs a little standing still, more pulling away.
      // A faint puff now and then: a modern car's exhaust is barely visible.
      owed += dt * (moving ? 0.5 + Math.min(1, Math.abs(speed) * 0.02) : 0.15);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const tailX = x - cos * length * 0.5, tailY = y - sin * length * 0.5;
      while (owed >= 1) {
        owed -= 1;
        spawn(tailX + (Math.random() - 0.5) * 0.8, tailY + (Math.random() - 0.5) * 0.8, z + 1.0, 0, 2.4, EXHAUST_LIFE);
      }
      if (dusty && moving && Math.random() < dt * 6) spawn(tailX, tailY, z + 0.2, 1, 6, EXHAUST_LIFE * 1.5);
    },
    burst(x, y, z, count, k, spread, s, l) {
      for (let n = 0; n < count; n++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
        spawn(x + Math.cos(a) * r, y + Math.sin(a) * r, z + (Math.random() - 0.3) * spread * 0.4,
          k, s * (0.6 + Math.random() * 0.8), l * (0.7 + Math.random() * 0.6));
      }
    },
    tick(seconds, halfHeight) {
      now = seconds;
      const wall = typeof performance !== 'undefined' ? performance.now() / 1000 : seconds;
      frameDt = lastWall < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, wall - lastWall));
      lastWall = wall;
      material.uniforms['uHalfH']!.value = halfHeight;
      material.uniforms['uTime']!.value = seconds;
      if (dirty) {
        dirty = false;
        for (const name of ['position', 'aBorn', 'aKind', 'aSeed', 'aSize', 'aLife']) geometry.getAttribute(name).needsUpdate = true;
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
