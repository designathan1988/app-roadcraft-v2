import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Shape,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';

import { m } from '@world/units';
import type { Exhaust } from './exhaust';

/**
 * Explosions, and what they throw (the player's order of 2026-10-05: a blow
 * is an explosion - fire, smoke, shrapnel - that wrecks everything near it).
 *
 * An explosion is built the way game effects are, in layers on their own
 * clocks: a white flash and a burst of light (~0.1 s), a fireball of flame
 * puffs (~0.5 s) rising into a column, smoke that starts with the fire,
 * cools to black, rises and spreads (seconds), sparks flung out under
 * gravity, a shockwave ring racing over the ground, a scorch mark - a crater
 * where the ground gives way - debris that falls and lies there, and a
 * shake of the camera.
 *
 * Debris are rigid bodies: chunks of asphalt, kerb, earth and masonry, the
 * pieces of a pole broken at its foot, in the middle or to splinters, the
 * mast and head of a traffic light, the burnt shell of a car. Each moves
 * under gravity and strikes the ground at its corners with an impulse -
 * restitution along the contact normal and friction across it, the impulse
 * turning the body about its centre (the usual impulse response of a game
 * rigid body, with a round inertia) - and comes to rest where it lands.
 * Wires torn from a pole are ropes (Verlet, like the ragdolls): pinned to
 * the pole still standing, their loose end falls and, on the ground, arcs
 * and sparks for a while.
 */

export type DebrisKind = 'asphalt' | 'concrete' | 'earth' | 'brick' | 'wood' | 'metal' | 'glass' | 'char' | 'leaf';

const COLORS: Readonly<Record<DebrisKind, number>> = {
  asphalt: 0x2b2b2d, concrete: 0x9a968e, earth: 0x5b4632, brick: 0x8a4a35, wood: 0x6b4a2e,
  metal: 0x3c3f44, glass: 0x9fb8c4, char: 0x1c1a19, leaf: 0x3d6b2a,
};

export interface DebrisSpec {
  /** `car`: a car's shell (bonnet, windscreen, roof, boot), length x height x width. */
  readonly shape: 'box' | 'cylinder' | 'car';
  readonly kind: DebrisKind;
  /** World position of the centre (three's frame: y up). */
  readonly at: Vector3;
  /** Box: width, height, depth. Cylinder: radius, length, radius. */
  readonly size: Vector3;
  readonly turn?: Quaternion;
  readonly velocity: Vector3;
  readonly spin?: Vector3;
  /** Seconds of fire on it (a burning wreck), 0 for none. */
  readonly burn?: number;
  /** Colour over the kind's. */
  readonly color?: number;
}

export interface BlastWorld {
  groundAt(x: number, y: number): number;
}

export interface Blast {
  readonly group: Group;
  /** The explosion itself at world (x, y), height z: `radius` its reach; `ground` what it tears up. */
  explode(x: number, y: number, z: number, radius: number, ground: 'road' | 'earth' | 'building'): void;
  /** A crater (a hole and its broken rim) and the scorch round it. */
  crater(x: number, y: number, z: number, radius: number, ground: 'road' | 'earth'): void;
  debris(spec: DebrisSpec): void;
  /** A wire torn loose: pinned at `from` (world, three's frame), its loose end at `to`, thrown by `kick`. */
  wire(from: Vector3, to: Vector3, kick: Vector3): void;
  /** An electric discharge at a point, repeated for a while (a broken line on the ground). */
  arc(at: Vector3, seconds: number): void;
  /** How hard the camera shakes now (world units). */
  shake(): number;
  /** A fire that keeps burning at world (x, y), height z, `size` across, for `seconds`: flames and a black column. */
  burn(x: number, y: number, z: number, size: number, seconds: number): void;
  /** Soot and ash laid on the ground at world (x, y): the street left dirty by the blast, for good. */
  soot(x: number, y: number, z: number, radius: number): void;
  /** A broken hydrant at world (x, y): a jet of water that keeps going. */
  geyser(x: number, y: number, z: number): void;
  /** Whether anything is still moving, burning or flashing. */
  active(): boolean;
  update(dt: number, world: BlastWorld): void;
  dispose(): void;
}

const MAX_PIECES = 1400;
const MAX_CRATERS = 60;
/** Soot blots kept on the ground at once (oldest go first). */
const MAX_SOOT = 600;
const MAX_WIRES = 40;
const WIRE_POINTS = 12;
const GRAVITY = m(9.8);

interface Piece {
  readonly mesh: 'box' | 'cylinder' | 'car';
  readonly p: Vector3;
  readonly v: Vector3;
  readonly q: Quaternion;
  readonly w: Vector3;
  readonly size: Vector3;
  readonly corners: Vector3[];
  readonly color: Color;
  /** Inverse of the (round) inertia, per unit mass. */
  readonly invI: number;
  burn: number;
  rest: number;
  asleep: boolean;
}

interface Rope { p: Vector3[]; o: Vector3[]; pin: Vector3; seg: number; sparks: number; age: number }

interface Crater { x: number; y: number; z: number; r: number; road: boolean; age: number; angle: number }

function craterTexture(road: boolean): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  let seed = road ? 7 : 13;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const mid = size / 2;
  // Scorch: soot spreading out, ragged.
  for (let i = 0; i < 40; i++) {
    const a = rnd() * Math.PI * 2, r = size * (0.15 + rnd() * 0.3);
    const x = mid + Math.cos(a) * r * 0.6, y = mid + Math.sin(a) * r * 0.6, rad = size * (0.08 + rnd() * 0.14);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(12, 10, 9, 0.55)');
    grad.addColorStop(1, 'rgba(12, 10, 9, 0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  // The hole: dark earth, deeper at the middle, a lighter broken lip.
  const hole = size * 0.26;
  const pts: [number, number][] = [];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2, r = hole * (0.82 + rnd() * 0.3);
    pts.push([mid + Math.cos(a) * r, mid + Math.sin(a) * r]);
  }
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  const grad = g.createRadialGradient(mid, mid, 0, mid, mid, hole * 1.1);
  grad.addColorStop(0, road ? 'rgba(28, 22, 17, 1)' : 'rgba(34, 25, 17, 1)');
  grad.addColorStop(0.7, road ? 'rgba(58, 46, 36, 1)' : 'rgba(70, 52, 34, 1)');
  grad.addColorStop(1, road ? 'rgba(92, 86, 80, 1)' : 'rgba(96, 74, 50, 1)');
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = road ? 'rgba(120, 116, 110, 0.9)' : 'rgba(110, 86, 60, 0.9)';
  g.stroke();
  // Clods and grit in and round it.
  for (let i = 0; i < 160; i++) {
    const a = rnd() * Math.PI * 2, r = hole * (0.2 + rnd() * 1.6);
    const s = 1 + rnd() * 3;
    const shade = road ? 40 + rnd() * 70 : 50 + rnd() * 50;
    g.fillStyle = road ? `rgba(${shade},${shade},${shade + 4},0.9)` : `rgba(${shade + 30},${shade + 12},${shade - 10},0.9)`;
    g.fillRect(mid + Math.cos(a) * r, mid + Math.sin(a) * r, s, s);
  }
  // Cracks running out through the paving.
  if (road) {
    g.strokeStyle = 'rgba(14, 12, 12, 0.85)';
    for (let i = 0; i < 11; i++) {
      let a = rnd() * Math.PI * 2, r = hole * 0.9;
      let x = mid + Math.cos(a) * r, y = mid + Math.sin(a) * r;
      g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(x, y);
      const length = size * (0.12 + rnd() * 0.22);
      for (let s = 0; s < 8; s++) {
        a += (rnd() - 0.5) * 0.7;
        r = length / 8;
        x += Math.cos(a) * r; y += Math.sin(a) * r;
        g.lineTo(x, y);
        g.lineWidth = Math.max(0.6, 2.2 - s * 0.25);
        if (rnd() < 0.25) {
          const b = a + (rnd() < 0.5 ? 0.8 : -0.8);
          g.moveTo(x, y); g.lineTo(x + Math.cos(b) * r * 2, y + Math.sin(b) * r * 2); g.moveTo(x, y);
        }
      }
      g.stroke();
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function createBlast(exhaust: Exhaust): Blast {
  const group = new Group();
  group.name = 'blast';
  const debrisMaterial = new MeshStandardMaterial({ roughness: 0.9, metalness: 0.05 });
  const boxes = new InstancedMesh(new BoxGeometry(1, 1, 1), debrisMaterial, MAX_PIECES);
  const cylinders = new InstancedMesh(new CylinderGeometry(1, 1, 1, 9), debrisMaterial, MAX_PIECES);
  // A car's side, extruded across: a unit box's worth, centred, x along the car.
  const side = new Shape();
  const profile: [number, number][] = [[-0.5, -0.5], [0.5, -0.5], [0.5, -0.12], [0.44, 0.0], [0.2, 0.05], [0.08, 0.48], [-0.28, 0.5], [-0.42, 0.08], [-0.5, 0.02]];
  profile.forEach(([x, y], i) => (i ? side.lineTo(x, y) : side.moveTo(x, y)));
  side.closePath();
  const shellGeometry = new ExtrudeGeometry(side, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
  const shells = new InstancedMesh(shellGeometry, debrisMaterial, 80);
  for (const mesh of [boxes, cylinders, shells]) {
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Instance colours from the first frame, so the program never changes variant.
    mesh.setColorAt(0, new Color(1, 1, 1));
    group.add(mesh);
  }
  const craterGeometry = new CircleGeometry(0.5, 28).rotateX(-Math.PI / 2);
  const craterMaterials = [craterTexture(true), craterTexture(false)].map((map) => new MeshStandardMaterial({
    map, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  // Soot: a soft dark blot, many of them, kept (the street stays dirty).
  const sootMap = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!;
    for (let k = 0; k < 26; k++) {
      const x = 64 + (Math.random() - 0.5) * 70, y = 64 + (Math.random() - 0.5) * 70, r = 10 + Math.random() * 34;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(20,17,14,${0.25 + Math.random() * 0.25})`); grad.addColorStop(1, 'rgba(20,17,14,0)');
      g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    }
    const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; return t;
  })();
  craterMaterials.push(new MeshStandardMaterial({ map: sootMap, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  const craterMeshes = craterMaterials.map((material, i) => {
    if (i === 2) {
      const mesh = new InstancedMesh(craterGeometry, material, MAX_SOOT);
      mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    }
    const mesh = new InstancedMesh(craterGeometry, material, MAX_CRATERS);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  });
  // The shockwave: a bright ring racing out over the ground.
  const ringMaterial = new MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false, blending: AdditiveBlending });
  const ring = new Mesh(new RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2), ringMaterial);
  ring.visible = false;
  ring.renderOrder = 6;
  group.add(ring);
  // The flash: one light, reused, and its colour (white-orange for a blast, blue-white for an arc).
  const light = new PointLight(0xffb060, 0, m(60), 1.6);
  light.castShadow = false;
  group.add(light);
  const wireGeometry = new BufferGeometry();
  const wirePositions = new Float32Array(MAX_WIRES * (WIRE_POINTS - 1) * 2 * 3);
  wireGeometry.setAttribute('position', new BufferAttribute(wirePositions, 3));
  const wires = new LineSegments(wireGeometry, new LineBasicMaterial({ color: 0x141414 }));
  wires.frustumCulled = false;
  group.add(wires);

  const pieces: Piece[] = [];
  const ropes: Rope[] = [];
  const craters: Crater[] = [];
  const soots: Crater[] = [];
  const geysers: { x: number; y: number; z: number; carry: number }[] = [];
  let sootDirty = false;
  const fires: { at: Vector3; until: number; rate: number; carry: number; piece?: Piece; size?: number; smoke?: number }[] = [];
  const arcs: { at: Vector3; until: number; next: number }[] = [];
  let time = 0;
  let flash = 0, flashLife = 0.15;
  let ringAge = Infinity, ringReach = 0, ringAt = new Vector3();
  let shakeAmp = 0;
  let clock = 0;
  let drawnPieces = -1;
  const o = new Object3D();
  const mtx = new Matrix4();

  const piece = (spec: DebrisSpec): void => {
    const s = spec.size;
    const corners = spec.shape !== 'cylinder'
      ? [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new Vector3(x * s.x / 2, y * s.y / 2, z * s.z / 2))))
      : [-1, 1].flatMap((y) => [0, 1, 2, 3].map((k) => new Vector3(Math.cos(k * Math.PI / 2) * s.x, y * s.y / 2, Math.sin(k * Math.PI / 2) * s.z)));
    const extent = spec.shape !== 'cylinder' ? s.x * s.x + s.y * s.y + s.z * s.z : s.y * s.y + 3 * s.x * s.x;
    const body: Piece = {
      mesh: spec.shape, p: spec.at.clone(), v: spec.velocity.clone(), q: spec.turn?.clone() ?? new Quaternion(),
      w: spec.spin?.clone() ?? new Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
      size: s.clone(), corners, color: new Color(spec.color ?? COLORS[spec.kind]).multiplyScalar(0.85 + Math.random() * 0.3),
      invI: 12 / Math.max(1e-4, extent), burn: spec.burn ?? 0, rest: 0, asleep: false,
    };
    pieces.push(body);
    if (body.burn > 0) fires.push({ at: body.p, until: time + body.burn, rate: 28, carry: 0, piece: body });
    if (pieces.length > MAX_PIECES) pieces.splice(Math.max(0, pieces.findIndex((p) => p.asleep && p.burn <= 0)), 1);
  };

  /** One step of a rigid piece: gravity, then each corner below the ground struck with an impulse. */
  const stepPiece = (b: Piece, dt: number, world: BlastWorld): void => {
    b.v.y -= GRAVITY * dt;
    b.p.addScaledVector(b.v, dt);
    const angle = b.w.length() * dt;
    if (angle > 1e-6) b.q.premultiply(new Quaternion().setFromAxisAngle(tmp1.copy(b.w).normalize(), angle)).normalize();
    let touching = false;
    let deepest = 0;
    for (const c of b.corners) {
      const r = tmp2.copy(c).applyQuaternion(b.q);
      const wp = tmp3.copy(b.p).add(r);
      const ground = world.groundAt(wp.x, -wp.z);
      const pen = ground - wp.y;
      if (pen <= 0) continue;
      touching = true;
      deepest = Math.max(deepest, pen);
      // Velocity of the corner, and the impulse that stops it going in.
      const vp = tmp4.copy(b.w).cross(r).add(b.v);
      const vn = vp.y;
      if (vn < 0) {
        const rn = tmp5.set(-r.z, 0, r.x); // r x up
        const k = 1 + b.invI * (r.x * r.x + r.z * r.z);
        const j = (-(1 + 0.25) * vn) / k;
        b.v.y += j;
        b.w.addScaledVector(rn, b.invI * j);
        // Friction across the contact, at most a share of the push.
        const tx = vp.x, tz = vp.z;
        const tl = Math.hypot(tx, tz);
        if (tl > 1e-6) {
          const f = Math.min(tl / k, 0.6 * j);
          const fx = (-tx / tl) * f, fz = (-tz / tl) * f;
          b.v.x += fx; b.v.z += fz;
          // r x f, f horizontal.
          b.w.x += b.invI * (r.y * fz);
          b.w.y += b.invI * (r.z * fx - r.x * fz);
          b.w.z += b.invI * (-r.y * fx);
        }
      }
    }
    if (deepest > 0) b.p.y += deepest;
    if (touching) { b.w.multiplyScalar(0.985); b.v.x *= 0.995; b.v.z *= 0.995; }
    const slow = b.v.lengthSq() < m(0.15) ** 2 && b.w.lengthSq() < 0.3;
    b.rest = touching && slow ? b.rest + dt : 0;
    if (b.rest > 0.6) { b.asleep = true; b.v.set(0, 0, 0); b.w.set(0, 0, 0); }
  };

  const stepRope = (rope: Rope, dt: number, world: BlastWorld): void => {
    rope.age += dt;
    const { p, o: old } = rope;
    for (let k = 0; k < p.length; k++) {
      const v = p[k]!, q = old[k]!;
      const vx = (v.x - q.x) * 0.99, vy = (v.y - q.y) * 0.99, vz = (v.z - q.z) * 0.99;
      q.copy(v);
      v.x += vx; v.y += vy - GRAVITY * dt * dt; v.z += vz;
    }
    for (let it = 0; it < 12; it++) {
      p[0]!.copy(rope.pin);
      for (let k = 1; k < p.length; k++) {
        const a = p[k - 1]!, b = p[k]!;
        const d = tmp1.subVectors(b, a);
        const l = d.length() || 1e-6;
        if (l <= rope.seg) continue;
        const diff = (l - rope.seg) / l;
        if (k === 1) b.addScaledVector(d, -diff);
        else { a.addScaledVector(d, diff * 0.5); b.addScaledVector(d, -diff * 0.5); }
      }
      for (let k = 1; k < p.length; k++) {
        const v = p[k]!;
        const g = world.groundAt(v.x, -v.z) + m(0.03);
        if (v.y < g) { v.y = g; old[k]!.x = v.x - (v.x - old[k]!.x) * 0.6; old[k]!.z = v.z - (v.z - old[k]!.z) * 0.6; }
      }
    }
    // The loose end live on the ground: sparks and blue flashes for a while.
    const end = p[p.length - 1]!;
    if (rope.age < rope.sparks && end.y < world.groundAt(end.x, -end.z) + m(0.3) && Math.random() < dt * 9) {
      exhaust.burst(end.x, -end.z, end.y + m(0.05), 10, 6, m(0.1), m(0.08), 0.5);
      if (Math.random() < 0.4) flashAt(end, 0x9fc8ff, 900, 0.08);
    }
  };

  const flashAt = (at: Vector3, color: number, power: number, life: number): void => {
    if (flash > power * 0.6 && light.color.getHex() !== color) return;
    light.position.copy(at);
    light.color.setHex(color);
    flash = Math.max(flash, power);
    flashLife = life;
  };

  return {
    group,
    explode(x, y, z, radius, ground) {
      const at = new Vector3(x, z, -y);
      // Flash and light.
      flashAt(at.clone().setY(z + m(2)), 0xffb060, 9000 + radius * 400, 0.35);
      // Fireball: flame puffs out and up, a column rising after it.
      exhaust.burst(x, y, z + m(0.8), 110, 5, radius * 0.45, m(2.6) + radius * 0.12, 1.1);
      exhaust.burst(x, y, z + m(2.5), 60, 5, radius * 0.25, m(3.2) + radius * 0.15, 1.6);
      fires.push({ at: at.clone().setY(z + m(0.5)), until: time + 1.5, rate: 90, carry: 0, size: radius * 0.35, smoke: 0.3 });
      // Then it burns on in the crater a while, under a column of black smoke.
      fires.push({ at: at.clone().setY(z + m(0.2)), until: time + 9 + radius * 0.3, rate: 22, carry: 0, size: radius * 0.18, smoke: 0.9 });
      // Smoke: dark, rising and spreading, then the dust of what was torn up.
      exhaust.burst(x, y, z + m(1.5), 80, 2, radius * 0.45, m(3.5), 7);
      exhaust.burst(x, y, z + m(5), 40, 2, radius * 0.35, m(4.5), 9);
      exhaust.burst(x, y, z + m(0.3), 40, ground === 'earth' ? 1 : 3, radius * 0.6, m(2.2), 6);
      // Sparks and grit flung out under gravity.
      exhaust.burst(x, y, z + m(0.5), 120, 6, m(0.5), m(0.1), 1.1);
      exhaust.burst(x, y, z + m(0.2), 90, 7, m(0.6), m(0.18), 1.4);
      // The shockwave and the shake.
      ringAt = new Vector3(x, z + m(0.15), -y);
      ringAge = 0;
      ringReach = radius * 2.4;
      shakeAmp = Math.max(shakeAmp, m(0.25) + radius * 0.04);
      // Shrapnel of what the ground was.
      const kinds: DebrisKind[] = ground === 'earth' ? ['earth', 'earth', 'earth', 'concrete'] : ground === 'road' ? ['asphalt', 'asphalt', 'concrete', 'earth'] : ['concrete', 'brick', 'glass', 'concrete'];
      const n = Math.round(24 + radius * 1.5);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const out = m(4 + Math.random() * 9);
        const s = m(0.08 + Math.random() * Math.random() * 0.45);
        piece({
          shape: 'box', kind: kinds[i % kinds.length]!,
          at: new Vector3(x + Math.cos(a) * radius * 0.2, z + m(0.3), -(y + Math.sin(a) * radius * 0.2)),
          size: new Vector3(s * (1 + Math.random()), s * (0.4 + Math.random() * 0.5), s * (1 + Math.random())),
          velocity: new Vector3(Math.cos(a) * out, m(5 + Math.random() * 10), -Math.sin(a) * out),
        });
      }
    },
    crater(x, y, z, radius, ground) {
      const road = ground === 'road';
      craters.push({ x, y, z, r: radius, road, age: 0, angle: Math.random() * Math.PI * 2 });
      if (craters.length > MAX_CRATERS) craters.shift();
      // The broken rim: slabs of the surface heaved up and tilted round the hole.
      const slabs = Math.round(8 + radius * 0.8);
      for (let i = 0; i < slabs; i++) {
        const a = (i / slabs) * Math.PI * 2 + Math.random() * 0.4;
        const r = radius * (0.32 + Math.random() * 0.12);
        const s = m(0.35 + Math.random() * 0.5) * (road ? 1 : 0.8);
        const tilt = new Quaternion().setFromAxisAngle(new Vector3(-Math.sin(a), 0, -Math.cos(a)), 0.4 + Math.random() * 0.6);
        piece({
          shape: 'box', kind: road ? (i % 3 === 0 ? 'concrete' : 'asphalt') : 'earth',
          at: new Vector3(x + Math.cos(a) * r, z + m(0.1), -(y + Math.sin(a) * r)),
          size: new Vector3(s, m(road ? 0.12 : 0.2), s * (0.6 + Math.random() * 0.5)),
          turn: tilt, velocity: new Vector3(Math.cos(a) * m(0.6), m(0.8), -Math.sin(a) * m(0.6)), spin: new Vector3(),
        });
      }
    },
    debris: piece,
    wire(from, to, kick) {
      const p: Vector3[] = [], o: Vector3[] = [];
      for (let k = 0; k < WIRE_POINTS; k++) {
        const v = from.clone().lerp(to, k / (WIRE_POINTS - 1));
        p.push(v);
        o.push(v.clone().addScaledVector(kick, -(k / (WIRE_POINTS - 1)) / 60));
      }
      ropes.push({ p, o, pin: from.clone(), seg: from.distanceTo(to) / (WIRE_POINTS - 1) * 1.05, sparks: 5 + Math.random() * 6, age: 0 });
      if (ropes.length > MAX_WIRES) ropes.shift();
    },
    arc(at, seconds) {
      arcs.push({ at: at.clone(), until: time + seconds, next: time });
    },
    shake: () => shakeAmp,
    soot(x, y, z, radius) {
      soots.push({ x, y, z, r: radius, road: false, age: 1, angle: Math.random() * Math.PI * 2 });
      if (soots.length > MAX_SOOT) soots.shift();
      sootDirty = true;
    },
    geyser(x, y, z) {
      geysers.push({ x, y, z, carry: 0 });
      if (geysers.length > 40) geysers.shift();
    },
    burn(x, y, z, size, seconds) {
      fires.push({ at: new Vector3(x, z, -y), until: time + seconds, rate: Math.min(18, 6 + size / m(1)), carry: 0, size: Math.min(size, m(6)), smoke: 0.6 });
    },
    active: () => geysers.length > 0 || flash > 1 || ringAge < 0.7 || fires.length > 0 || arcs.length > 0 || pieces.some((b) => !b.asleep) || ropes.some((r) => r.age < 12),
    update(dt, world) {
      const wall = Math.min(0.1, Math.max(0, dt));
      time += wall;
      clock += wall;
      const STEP = 1 / 60;
      while (clock >= STEP) {
        clock -= STEP;
        for (const b of pieces) if (!b.asleep) stepPiece(b, STEP, world);
        for (const r of ropes) stepRope(r, STEP, world);
      }
      // Fires: flame and smoke puffs from what burns.
      for (let i = fires.length - 1; i >= 0; i--) {
        const f = fires[i]!;
        if (time > f.until) { fires.splice(i, 1); continue; }
        f.carry += f.rate * wall;
        const left = (f.until - time);
        while (f.carry >= 1) {
          f.carry -= 1;
          const at = f.piece ? f.piece.p : f.at;
          const big = f.piece ? Math.max(f.piece.size.x, f.piece.size.z) * 0.5 : f.size ?? m(1);
          const dying = Math.min(1, left / 3 + 0.3);
          exhaust.burst(at.x, -at.z, at.y + m(0.3), 1, 5, big, (m(1.1) + big * 0.4) * dying, 0.8);
          // Black smoke over the flames, rising in a short column that thins
          // out near them - not a cloud over the town.
          if (Math.random() < (f.smoke ?? 0.4) * 0.5) exhaust.burst(at.x, -at.z, at.y + m(1.5), 1, 2, big * 0.4, Math.min(m(3), m(1.6) + big * 0.15), 4);
          // And the grey smoke a car's exhaust gives, only thicker, curling off the flames.
          if (Math.random() < 0.7) exhaust.burst(at.x, -at.z, at.y + m(0.8), 2, 0, big * 0.5, m(1.4) + big * 0.1, 3.2);
        }
      }
      // Hydrants: a jet of water each, for good, and its puddle of spray.
      for (const g of geysers) {
        g.carry += 40 * wall;
        while (g.carry >= 1) { g.carry -= 1; exhaust.burst(g.x, g.y, g.z + m(0.4), 1, 8, m(0.15), m(0.5), 2.6); }
      }
      for (let i = arcs.length - 1; i >= 0; i--) {
        const a = arcs[i]!;
        if (time > a.until) { arcs.splice(i, 1); continue; }
        if (time >= a.next) {
          a.next = time + 0.08 + Math.random() * 0.5;
          exhaust.burst(a.at.x, -a.at.z, a.at.y, 18, 6, m(0.2), m(0.1), 0.6);
          flashAt(a.at, 0xa8d0ff, 2500, 0.1);
        }
      }
      // Light, ring, shake decay.
      flash = Math.max(0, flash - (flash / Math.max(0.03, flashLife)) * wall * 2.5);
      light.intensity = flash;
      // Always in the scene, dark when off: a light shown and hidden changes the
      // count of lights, which is part of every lit material's program - each
      // flash recompiled every shader in the town (three `WebGLPrograms`).
      light.visible = true;
      shakeAmp *= Math.exp(-wall * 4);
      if (shakeAmp < 1e-3) shakeAmp = 0;
      if (ringAge < 0.7) {
        ringAge += wall;
        const k = ringAge / 0.7;
        const r = ringReach * (1 - (1 - k) ** 2);
        ring.visible = true;
        ring.position.copy(ringAt);
        ring.scale.set(r, 1, r);
        ringMaterial.opacity = 0.55 * (1 - k);
      } else ring.visible = false;
      // Draw the pieces - rewritten only while one moves or the set changes:
      // a street of rubble at rest costs nothing a frame.
      const moving = pieces.some((b) => !b.asleep);
      const redraw = moving || pieces.length !== drawnPieces;
      drawnPieces = pieces.length;
      let nb = 0, nc = 0, ns = 0;
      if (redraw) for (const b of pieces) {
        o.position.copy(b.p);
        o.quaternion.copy(b.q);
        o.scale.copy(b.size);
        o.updateMatrix();
        // Burnt black as it burns.
        if (b.mesh === 'box') { boxes.setMatrixAt(nb, o.matrix); boxes.setColorAt(nb++, b.color); }
        else if (b.mesh === 'car') { if (ns < 80) { shells.setMatrixAt(ns, o.matrix); shells.setColorAt(ns++, b.color); } }
        else { cylinders.setMatrixAt(nc, o.matrix); cylinders.setColorAt(nc++, b.color); }
      }
      if (redraw) {
        boxes.count = nb; cylinders.count = nc; shells.count = ns;
        for (const mesh of [boxes, cylinders, shells]) {
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
      }
      const counts = [0, 0];
      for (const c of craters) {
        c.age += wall;
        const k = c.road ? 0 : 1;
        const grow = Math.min(1, 0.4 + c.age * 6);
        o.position.set(c.x, c.z + m(0.03), -c.y);
        o.quaternion.setFromAxisAngle(tmp1.set(0, 1, 0), c.angle);
        o.scale.set(c.r * 2 * grow, 1, c.r * 2 * grow);
        o.updateMatrix();
        craterMeshes[k]!.setMatrixAt(counts[k]!++, o.matrix);
      }
      craterMeshes.forEach((mesh, k) => { if (k < 2) { mesh.count = counts[k]!; mesh.instanceMatrix.needsUpdate = true; } });
      // Soot is still: written again only when some was added.
      if (sootDirty) {
        sootDirty = false;
        const mesh = craterMeshes[2]!;
        soots.forEach((c, i) => {
          o.position.set(c.x, c.z + m(0.025), -c.y);
          o.quaternion.setFromAxisAngle(tmp1.set(0, 1, 0), c.angle);
          o.scale.set(c.r * 2, 1, c.r * 2);
          o.updateMatrix();
          mesh.setMatrixAt(i, o.matrix);
        });
        mesh.count = soots.length;
        mesh.instanceMatrix.needsUpdate = true;
      }
      let w = 0;
      for (const r of ropes) {
        for (let k = 1; k < r.p.length; k++) {
          const a = r.p[k - 1]!, b = r.p[k]!;
          wirePositions.set([a.x, a.y, a.z, b.x, b.y, b.z], w);
          w += 6;
        }
      }
      wireGeometry.setDrawRange(0, w / 3);
      (wireGeometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
      void mtx;
    },
    dispose() {
      boxes.geometry.dispose(); cylinders.geometry.dispose(); shellGeometry.dispose(); debrisMaterial.dispose();
      craterGeometry.dispose(); for (const mat of craterMaterials) { mat.map?.dispose(); mat.dispose(); }
      ring.geometry.dispose(); ringMaterial.dispose(); wireGeometry.dispose(); (wires.material as LineBasicMaterial).dispose();
    },
  };
}

const tmp1 = new Vector3(), tmp2 = new Vector3(), tmp3 = new Vector3(), tmp4 = new Vector3(), tmp5 = new Vector3();
