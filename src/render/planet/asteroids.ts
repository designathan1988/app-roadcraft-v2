import {
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Camera,
} from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { natureNoise3 } from '../natureNoise';

/**
 * THE ASTEROIDS: one field of rocks out in space to fly to (the player's
 * brief, 2026-10-10, section 11), far from the planet and off the way to the
 * moon, with wide emptiness round it.
 *
 *  - SHAPES: `SHAPES` rocks of their own, not one stone scaled - a sphere
 *    pushed in and out by three octaves of 3D noise, flattened along a
 *    random axis, its surface dented by craters (a bowl with a raised rim).
 *    Each shape is made twice, at two levels of detail, from the same
 *    function, so the far one is the near one's silhouette.
 *  - ONE DRAW A SHAPE AND LEVEL (three's InstancedMesh): every rock an
 *    instance; its slow spin turned in the vertex shader from an axis and a
 *    rate of its own (`aSpin`), so nothing is updated a frame on the CPU and
 *    no two rocks turn together.
 *  - LEVEL OF DETAIL BY SIZE ON SCREEN: a few times a second each rock is
 *    put in the near or the far mesh by its angular size, and rocks smaller
 *    than a pixel or two are not drawn at all.
 *  - LIT BY THE SUN like everything else (the scene's sun light, its
 *    direction the drawn sun's), dark rock with a little colour of its own.
 *
 * The field is written in the planet's own frame and set down with the
 * planet each frame (`planetMotion`), as the moon is.
 */

/** Rocks in the field, distinct shapes, and the field's place and reach (the planet's frame, in its radii). */
const COUNT = 1400;
const SHAPES = 8;
const FIELD_DIR = new Vector3(-0.55, 0.32, -0.77).normalize();
const FIELD_DISTANCE = 26;
const FIELD_REACH = 3.2;
/** Rocks' sizes: radius from `SMALLEST` to `LARGEST` world units, most small (a power law). */
const SMALLEST = 25;
const LARGEST = 2600;
/** Angular radius (rad) over which a rock is drawn in full; under `TINY` not drawn. */
const NEAR_ANGLE = 0.004;
const TINY = 0.0006;
/** How often the rocks are sorted into their levels, s. */
const SORT_EVERY = 0.25;

export interface AsteroidRock {
  /** Its centre in three's space (as last sorted) and radius. */
  readonly centre: Vector3;
  readonly radius: number;
}

export interface Asteroids {
  readonly group: Group;
  /** Sets the field down with the planet and sorts the rocks by their size on screen. */
  update(camera: Camera, motion: Readonly<Matrix4>, seconds: number): void;
  /** The rocks nearest a point (three's space), at most `most`, for the flight's collisions. */
  nearest(at: Vector3, most: number): readonly AsteroidRock[];
  /** The field's centre (three's space) and reach, for the flight's panel. */
  readonly centre: Vector3;
  readonly reach: number;
  dispose(): void;
}

/** A deterministic 0..1 sequence. */
function sequence(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One rock's shape at a level of detail: the same function at either. */
function rockGeometry(shape: number, detail: number): BufferGeometry {
  const random = sequence(9173 + shape * 131);
  const base = mergeVertices(new IcosahedronGeometry(1, detail));
  const position = base.getAttribute('position') as BufferAttribute;
  const squash = new Vector3(0.65 + random() * 0.35, 0.55 + random() * 0.35, 0.8 + random() * 0.2);
  const craters = Array.from({ length: 7 }, () => ({
    dir: new Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize(),
    size: 0.18 + random() * 0.32,
  }));
  const colours = new Float32Array(position.count * 3);
  const tint = new Color().setHSL(0.07 + random() * 0.05, 0.12 + random() * 0.1, 0.26 + random() * 0.08);
  const p = new Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i).normalize();
    let r = 1
      + (natureNoise3(p.x * 4, p.y * 4, p.z * 4, 1, shape * 7 + 1) - 0.5) * 0.55
      + (natureNoise3(p.x * 9, p.y * 9, p.z * 9, 1, shape * 7 + 2) - 0.5) * 0.18
      + (natureNoise3(p.x * 21, p.y * 21, p.z * 21, 1, shape * 7 + 3) - 0.5) * 0.06;
    let shade = 1;
    for (const c of craters) {
      const d = Math.acos(Math.min(1, p.dot(c.dir))) / c.size;
      if (d < 1) { r -= (1 - d * d) * 0.09 * c.size * 3; shade -= (1 - d) * 0.18; }
      else if (d < 1.35) r += Math.sin((d - 1) / 0.35 * Math.PI) * 0.025 * c.size * 3;
    }
    position.setXYZ(i, p.x * r * squash.x, p.y * r * squash.y, p.z * r * squash.z);
    const grain = 0.85 + natureNoise3(p.x * 30, p.y * 30, p.z * 30, 1, shape * 7 + 4) * 0.3;
    colours[i * 3] = tint.r * shade * grain;
    colours[i * 3 + 1] = tint.g * shade * grain;
    colours[i * 3 + 2] = tint.b * shade * grain;
  }
  base.setAttribute('color', new BufferAttribute(colours, 3));
  base.computeVertexNormals();
  base.computeBoundingSphere();
  return base;
}

/** The rock material: lit rock, not bent round the planet, each instance spun in the vertex shader. */
function rockMaterial(time: { value: number }): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, flatShading: false });
  material.defines = { PLANET_SKIP: '' };
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uRockTime'] = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aSpin;
        uniform float uRockTime;
        vec3 rockSpin(vec3 v) {
          float a = aSpin.w * uRockTime;
          vec3 k = aSpin.xyz;
          return v * cos(a) + cross(k, v) * sin(a) + k * dot(k, v) * (1.0 - cos(a));
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        objectNormal = rockSpin(objectNormal);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed = rockSpin(transformed);`);
  };
  material.customProgramCacheKey = () => 'asteroid-rock';
  return material;
}

export function createAsteroids(): Asteroids {
  const group = new Group();
  group.name = 'space-asteroids';
  group.matrixAutoUpdate = false;
  group.userData = { planetSkip: true };
  const time = { value: 0 };
  const material = rockMaterial(time);
  const random = sequence(4421);

  // The rocks: where (the planet's frame), how big, which shape, how they turn.
  const centres = new Float32Array(COUNT * 3);
  const radii = new Float32Array(COUNT);
  const shapes = new Uint8Array(COUNT);
  const turns = new Float32Array(COUNT * 4);
  const spins = new Float32Array(COUNT * 4);
  const fieldCentre = FIELD_DIR.clone().multiplyScalar(FIELD_DISTANCE * PLANET_RADIUS);
  const reach = FIELD_REACH * PLANET_RADIUS;
  const q = new Quaternion();
  const axis = new Vector3();
  for (let i = 0; i < COUNT; i++) {
    // A flattened cloud, denser to its middle, with a few clumps.
    const u = random(), v = random(), w = random();
    const rr = reach * Math.pow(u, 0.6);
    const th = v * Math.PI * 2, ph = Math.acos(2 * w - 1);
    centres[i * 3] = fieldCentre.x + rr * Math.sin(ph) * Math.cos(th);
    centres[i * 3 + 1] = fieldCentre.y + rr * Math.cos(ph) * 0.28;
    centres[i * 3 + 2] = fieldCentre.z + rr * Math.sin(ph) * Math.sin(th);
    radii[i] = SMALLEST * Math.pow(LARGEST / SMALLEST, Math.pow(random(), 3.2));
    shapes[i] = Math.floor(random() * SHAPES);
    axis.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize();
    q.setFromAxisAngle(axis, random() * Math.PI * 2);
    turns[i * 4] = q.x; turns[i * 4 + 1] = q.y; turns[i * 4 + 2] = q.z; turns[i * 4 + 3] = q.w;
    axis.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize();
    // Slow: a turn in some minutes to an hour, smaller rocks faster.
    spins[i * 4] = axis.x; spins[i * 4 + 1] = axis.y; spins[i * 4 + 2] = axis.z;
    spins[i * 4 + 3] = (0.006 + random() * 0.04) * Math.sqrt(SMALLEST * 10 / radii[i]!) * (random() < 0.5 ? -1 : 1);
  }
  const perShape = new Uint16Array(SHAPES);
  for (let i = 0; i < COUNT; i++) perShape[shapes[i]!]!++;

  // A near and a far mesh a shape, each able to hold all of that shape's rocks.
  const levels = [3, 1].map((detail) => Array.from({ length: SHAPES }, (_, shape) => {
    const geometry = rockGeometry(shape, detail);
    const capacity = Math.max(1, perShape[shape]!);
    const spin = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    spin.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aSpin', spin);
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData = { planetSkip: true };
    group.add(mesh);
    return { mesh, spin };
  }));

  const world = new Vector3();
  const eye = new Vector3();
  const placed = new Matrix4();
  const scale = new Vector3();
  const rockQ = new Quaternion();
  const worldCentres = new Float32Array(COUNT * 3);
  let sinceSort = SORT_EVERY;
  const centre = new Vector3();
  const nearOut: { centre: Vector3; radius: number; d: number }[] = Array.from({ length: 8 }, () => ({ centre: new Vector3(), radius: 0, d: 0 }));
  const result: AsteroidRock[] = [];

  const sort = (camera: Camera): void => {
    eye.setFromMatrixPosition(camera.matrixWorld);
    for (const level of levels) for (const { mesh } of level) mesh.count = 0;
    const m = group.matrix;
    for (let i = 0; i < COUNT; i++) {
      world.set(centres[i * 3]!, centres[i * 3 + 1]!, centres[i * 3 + 2]!).applyMatrix4(m);
      worldCentres[i * 3] = world.x; worldCentres[i * 3 + 1] = world.y; worldCentres[i * 3 + 2] = world.z;
      const angle = radii[i]! / Math.max(1, world.distanceTo(eye));
      if (angle < TINY) continue;
      const { mesh, spin } = levels[angle > NEAR_ANGLE ? 0 : 1]![shapes[i]!]!;
      const k = mesh.count++;
      rockQ.set(turns[i * 4]!, turns[i * 4 + 1]!, turns[i * 4 + 2]!, turns[i * 4 + 3]!);
      const r = radii[i]!;
      placed.compose(world.set(centres[i * 3]!, centres[i * 3 + 1]!, centres[i * 3 + 2]!), rockQ, scale.set(r, r, r));
      mesh.setMatrixAt(k, placed);
      spin.setXYZW(k, spins[i * 4]!, spins[i * 4 + 1]!, spins[i * 4 + 2]!, spins[i * 4 + 3]!);
    }
    for (const level of levels) for (const { mesh, spin } of level) {
      mesh.instanceMatrix.needsUpdate = true;
      spin.needsUpdate = true;
    }
  };

  return {
    group,
    centre,
    reach,
    update(camera, motion, seconds) {
      time.value += seconds;
      group.matrix.copy(motion);
      group.matrixWorldNeedsUpdate = true;
      centre.copy(fieldCentre).applyMatrix4(motion);
      sinceSort += seconds;
      // Sorted a few times a second, and at once when the eye moved far for the field's scale.
      eye.setFromMatrixPosition(camera.matrixWorld);
      if (sinceSort >= SORT_EVERY) { sinceSort = 0; sort(camera); }
    },
    nearest(at, most) {
      // The few nearest by surface distance (a short insertion list, no allocation).
      const n = Math.min(most, nearOut.length);
      let filled = 0;
      for (let i = 0; i < COUNT; i++) {
        const dx = worldCentres[i * 3]! - at.x, dy = worldCentres[i * 3 + 1]! - at.y, dz = worldCentres[i * 3 + 2]! - at.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - radii[i]!;
        if (d > radii[i]! * 6 + 400) continue;
        let k = filled < n ? filled++ : n;
        if (k === n && d >= nearOut[n - 1]!.d) continue;
        if (k === n) k = n - 1;
        while (k > 0 && nearOut[k - 1]!.d > d) {
          const a = nearOut[k - 1]!, b = nearOut[k]!;
          b.centre.copy(a.centre); b.radius = a.radius; b.d = a.d;
          k--;
        }
        const slot = nearOut[k]!;
        slot.centre.set(worldCentres[i * 3]!, worldCentres[i * 3 + 1]!, worldCentres[i * 3 + 2]!);
        slot.radius = radii[i]! * 0.82;
        slot.d = d;
      }
      result.length = 0;
      for (let k = 0; k < filled; k++) result.push(nearOut[k]!);
      return result;
    },
    dispose() {
      for (const level of levels) for (const { mesh } of level) { mesh.geometry.dispose(); mesh.dispose(); }
      material.dispose();
    },
  };
}
