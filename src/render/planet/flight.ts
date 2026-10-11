import { Euler, Quaternion, Ray, Vector3, type PerspectiveCamera } from 'three';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { m } from '@world/units';
import type { FlightPose } from '../isoViewport';
import { planetCentre, planetPick } from './bend';

/**
 * THE FREE CAMERA: the view flies like a spaceship, with no ship drawn - the
 * mouse steers (pointer locked, as flight games and three's PointerLockControls
 * have it; dragging when it is not), W/S thrust forward and back, A/D slide,
 * R/F rise and fall, Q/E roll, Shift boosts, the wheel sets the throttle.
 *
 * Its motion is a ship's, as space games give it (three's FlyControls for the
 * local-frame turns; Elite's "flight assist" for the feel):
 *  - thrust eases the velocity towards what the keys ask, a flight assist
 *    holding it there; let go, the ship coasts and slows only gently;
 *  - the speed asked scales with the height over the nearest body - a walk
 *    over the street, thousands of metres a second out in space - up to a
 *    ceiling that crosses to the sun in `SUN_CROSSING_S` with the boost
 *    (the height alone would grow the speed without end: speed ~ height
 *    is an exponential once out);
 *  - closing on a body is braked by its distance (Elite's mass lock in
 *    spirit): the speed towards it never more than `CLOSE_PER_HEIGHT` times
 *    the height over it a second, so an arrival slows by itself and a frame
 *    never steps through the moon at full speed;
 *  - space ends a little past the sun (`SPACE_REACH`): the view is held
 *    there, as a game's play area;
 *  - the planet and the moon pull (their gravity falls with the square of the
 *    distance), felt when coasting; the ground, the moon and the sun are
 *    never gone through;
 *  - the view widens with the speed, leans into a turn and trembles a little
 *    under hard thrust: what makes motion read as motion.
 */

export interface FlightBody {
  readonly name: 'planet' | 'moon' | 'sun';
  readonly centre: Vector3;
  readonly radius: number;
  /** Its pull at its surface, world units / s². */
  readonly gravity: number;
}

export interface FlightHost {
  readonly camera: PerspectiveCamera;
  /** The moon and the sun (`space.ts` bodies). */
  bodies(): readonly { readonly name: 'moon' | 'sun'; readonly centre: Vector3; readonly radius: number }[];
  /** The ground's height at an atlas point (`terrain.renderedHeightAt`). */
  groundAt(x: number, y: number): number;
  setPose(pose: FlightPose | null): void;
}

/** What the flight reports for its panel. */
export interface FlightReadout {
  /** Speed, world units / s. */
  readonly speed: number;
  /** The nearest body and the height over its surface, world units. */
  readonly near: 'planet' | 'moon' | 'sun';
  readonly height: number;
  readonly throttle: number;
  readonly boost: boolean;
}

const KEYS: Record<string, readonly [axis: 'x' | 'y' | 'z' | 'roll', sign: 1 | -1]> = {
  KeyW: ['z', -1], ArrowUp: ['z', -1], KeyS: ['z', 1], ArrowDown: ['z', 1],
  KeyA: ['x', -1], ArrowLeft: ['x', -1], KeyD: ['x', 1], ArrowRight: ['x', 1],
  KeyR: ['y', 1], Space: ['y', 1], KeyF: ['y', -1], KeyC: ['y', -1],
  KeyQ: ['roll', 1], KeyE: ['roll', -1],
};

/** Mouse steering, rad a pixel. */
const LOOK_PER_PX = 0.0022;
/** Time constants, s: the velocity reaching what the thrust asks; the coast's slowing; the turn following the mouse. */
const THRUST_TAU = 0.45;
const COAST_TAU = 6;
const TURN_TAU = 0.07;
/** The speed a full throttle asks for, per world unit of height over the nearest surface, a second. */
const SPEED_PER_HEIGHT = 1.4;
const MIN_SPEED = m(3);
const BOOST = 5;
/**
 * The boost on the speed a height allows: less than on the ceiling, or near a
 * body the boost asked five times the height a second and the view skimmed
 * past the moon's limb in a fraction of a second instead of arriving.
 */
const BOOST_NEAR = 2;
/** The most speed towards a body, per world unit of height over it, a second. */
const CLOSE_PER_HEIGHT = 1.5;
/** Seconds to the sun at the top speed, boosted. */
const SUN_CROSSING_S = 6;
/** How far out space goes, in distances to the sun from the planet's centre. */
const SPACE_REACH = 1.6;
/** The lens: at rest and at full speed, degrees. */
const FOV_REST = 55;
const FOV_FAST = 72;
/** The eye never comes closer to a surface than this. */
const SURFACE_GAP = m(1.7);
/** Roll a second (rad) on Q/E; the lean into a turn (rad per rad/s of yaw). */
const ROLL_PER_S = 1.4;
const LEAN = 0.18;

const tmpQ = new Quaternion();
const tmpE = new Euler(0, 0, 0, 'YXZ');
const v1 = new Vector3();
const v2 = new Vector3();
const ray = new Ray();

export class Flight {
  active = false;
  private readonly position = new Vector3();
  private readonly orientation = new Quaternion();
  private readonly velocity = new Vector3();
  private readonly held = new Set<string>();
  private boost = false;
  private throttle = 1;
  /** Mouse motion not yet turned (rad), and the turn rates it eases into. */
  private pendingYaw = 0;
  private pendingPitch = 0;
  private yawRate = 0;
  private rollRate = 0;
  private lean = 0;
  private fov = FOV_REST;
  private shake = 0;
  private time = 0;
  private readout: FlightReadout = { speed: 0, near: 'planet', height: 0, throttle: 1, boost: false };
  private readonly planet: { name: 'planet'; centre: Vector3; radius: number; gravity: number } = { name: 'planet', centre: new Vector3(), radius: PLANET_RADIUS, gravity: m(9.8) * 3 };
  private readonly pose = { position: new Vector3(), quaternion: new Quaternion(), fov: FOV_REST, near: 0.1, far: 1e5, globe: 0 };

  constructor(private readonly host: FlightHost) {}

  /** Takes off from where the camera is, facing as it faces. */
  enter(): void {
    if (this.active) return;
    this.active = true;
    this.position.copy(this.host.camera.position);
    this.orientation.copy(this.host.camera.quaternion);
    this.velocity.set(0, 0, 0);
    this.pendingYaw = this.pendingPitch = this.yawRate = this.rollRate = this.lean = 0;
    this.fov = this.host.camera.fov;
    this.step(0);
  }

  /** Back to the orbit view: the caller sets the orbit over `landing` (an atlas point, or null when none is under the view). */
  exit(): { landing: { x: number; y: number } | null; height: number } {
    this.active = false;
    this.held.clear();
    // The ground ahead of the eye, else under it.
    const centre = planetCentre(v1);
    ray.set(this.position, v2.set(0, 0, -1).applyQuaternion(this.orientation));
    let landing = planetPick(ray, 0);
    if (!landing) {
      ray.set(this.position, v2.subVectors(centre, this.position).normalize());
      landing = planetPick(ray, 0);
    }
    const height = Math.max(m(2), this.position.distanceTo(centre) - PLANET_RADIUS);
    this.host.setPose(null);
    return { landing, height };
  }

  press(code: string, shift: boolean): boolean {
    this.boost = shift;
    if (code === 'ShiftLeft' || code === 'ShiftRight') { this.boost = true; return true; }
    if (!(code in KEYS)) return false;
    this.held.add(code);
    return true;
  }

  release(code: string, shift: boolean): void {
    this.boost = shift && code !== 'ShiftLeft' && code !== 'ShiftRight';
    this.held.delete(code);
  }

  releaseAll(): void {
    this.held.clear();
    this.boost = false;
  }

  /** The mouse moved (CSS px): it steers. */
  look(dx: number, dy: number): void {
    this.pendingYaw -= dx * LOOK_PER_PX * (this.fov / FOV_REST);
    this.pendingPitch -= dy * LOOK_PER_PX * (this.fov / FOV_REST);
  }

  /** A notch of the wheel: the throttle up (positive) or down, 1/32 .. 32. */
  wheel(notches: number): void {
    this.throttle = Math.min(32, Math.max(1 / 32, this.throttle * Math.pow(1.25, notches)));
  }

  get state(): FlightReadout {
    return this.readout;
  }

  /** Advances `dt` seconds; sets the camera's pose. */
  step(dt: number): void {
    if (!this.active) return;
    const s = Math.min(0.1, Math.max(0, dt));
    this.time += s;
    // The bodies, and the nearest surface.
    planetCentre(this.planet.centre);
    const bodies: FlightBody[] = [this.planet];
    for (const b of this.host.bodies()) bodies.push({ ...b, gravity: b.name === 'moon' ? this.planet.gravity * 0.17 : 0 });
    let sunDistance = PLANET_RADIUS * 60;
    for (const b of bodies) if (b.name === 'sun') sunDistance = b.centre.distanceTo(this.planet.centre);
    let near: FlightBody = this.planet;
    let height = Infinity;
    // The planet's own ground under the eye (its relief, its roads' cuts).
    let planetFloor = PLANET_RADIUS;
    ray.set(this.position, v1.subVectors(this.planet.centre, this.position).normalize());
    const under = planetPick(ray, 0);
    if (under) planetFloor = PLANET_RADIUS + Math.max(0, this.host.groundAt(under.x, under.y));
    for (const b of bodies) {
      const floor = b === this.planet ? planetFloor : b.radius;
      const h = this.position.distanceTo(b.centre) - floor;
      if (h < height) { height = h; near = b; }
    }
    // Thrust: what the keys ask, in the ship's frame, at a speed scaled by the height.
    const want = v1.set(0, 0, 0);
    let roll = 0;
    for (const code of this.held) {
      const [axis, sign] = KEYS[code]!;
      if (axis === 'roll') roll += sign;
      else want[axis] += sign;
    }
    const thrusting = want.lengthSq() > 0;
    const ceiling = sunDistance / SUN_CROSSING_S / BOOST;
    const top = Math.min(
      ceiling * (this.boost ? BOOST : 1),
      Math.max(MIN_SPEED, Math.max(0, height) * SPEED_PER_HEIGHT) * this.throttle * (this.boost ? BOOST_NEAR : 1),
    );
    if (thrusting) {
      want.normalize().multiplyScalar(top).applyQuaternion(this.orientation);
      this.velocity.lerp(want, 1 - Math.exp(-s / THRUST_TAU));
    } else {
      this.velocity.multiplyScalar(Math.exp(-s / COAST_TAU));
      // Gravity, felt when coasting: g (r0 / r)², towards each body.
      for (const b of bodies) {
        if (b.gravity <= 0) continue;
        const d = v2.subVectors(b.centre, this.position);
        const r = d.length();
        this.velocity.addScaledVector(d.divideScalar(r), b.gravity * (b.radius / r) ** 2 * s);
      }
    }
    // Braked towards every body by the height over it.
    for (const b of bodies) {
      const floor = b === this.planet ? planetFloor : b.radius;
      const d = v2.subVectors(b.centre, this.position);
      const r = d.length();
      const closing = this.velocity.dot(d.divideScalar(r));
      const most = Math.max(MIN_SPEED, (r - floor) * CLOSE_PER_HEIGHT);
      if (closing > most) this.velocity.addScaledVector(d, most - closing);
    }
    const before = this.velocity.length();
    this.position.addScaledVector(this.velocity, s);
    // Never into a body: held at its surface, the velocity into it taken away.
    for (const b of bodies) {
      const floor = (b === this.planet ? planetFloor : b.radius * (b.name === 'sun' ? 1.2 : 1)) + SURFACE_GAP;
      const d = v2.subVectors(this.position, b.centre);
      const r = d.length();
      if (r >= floor) continue;
      d.divideScalar(r);
      this.position.copy(b.centre).addScaledVector(d, floor);
      const into = this.velocity.dot(d);
      if (into < 0) this.velocity.addScaledVector(d, -into);
    }
    // The end of space: held on its sphere, the velocity outwards taken away.
    const out = v2.subVectors(this.position, this.planet.centre);
    const reach = sunDistance * SPACE_REACH;
    if (out.length() > reach) {
      out.normalize();
      this.position.copy(this.planet.centre).addScaledVector(out, reach);
      const away = this.velocity.dot(out);
      if (away > 0) this.velocity.addScaledVector(out, -away);
    }
    // Turning: the mouse's motion spent smoothly, rolls on Q/E.
    const ease = 1 - Math.exp(-s / TURN_TAU);
    const yaw = this.pendingYaw * ease, pitch = this.pendingPitch * ease;
    this.pendingYaw -= yaw;
    this.pendingPitch -= pitch;
    this.yawRate = s > 0 ? yaw / s : 0;
    this.rollRate += (roll * ROLL_PER_S - this.rollRate) * (1 - Math.exp(-s / 0.2));
    tmpE.set(pitch, yaw, this.rollRate * s, 'YXZ');
    this.orientation.multiply(tmpQ.setFromEuler(tmpE)).normalize();
    // Feel: the lens widens with the speed; the view leans into a turn and trembles under hard thrust.
    const speed = this.velocity.length();
    const fast = Math.min(1, speed / Math.max(1e-6, top * 1.2));
    this.fov += (FOV_REST + (FOV_FAST - FOV_REST) * fast * fast - this.fov) * (1 - Math.exp(-s / 0.4));
    this.lean += (-this.yawRate * LEAN - this.lean) * (1 - Math.exp(-s / 0.25));
    const accel = s > 0 ? Math.abs(speed - before) / s / Math.max(1e-6, top) : 0;
    this.shake += (Math.min(1, accel * 0.6 + (this.boost && thrusting ? 0.35 : 0)) - this.shake) * (1 - Math.exp(-s / 0.15));
    const tremble = this.shake * 0.0035;
    tmpE.set(
      Math.sin(this.time * 37.1) * tremble,
      Math.sin(this.time * 29.7 + 1.3) * tremble,
      this.lean + Math.sin(this.time * 23.3 + 2.1) * tremble,
      'YXZ',
    );
    const p = this.pose;
    p.position.copy(this.position);
    p.quaternion.copy(this.orientation).multiply(tmpQ.setFromEuler(tmpE));
    p.fov = this.fov;
    // The depth range the view needs: close to the nearest surface, out past the planet.
    const toPlanet = this.position.distanceTo(this.planet.centre);
    p.near = Math.min(Math.max(0.05, height * 0.25), 2000);
    p.far = Math.max(toPlanet + PLANET_RADIUS * 1.3, p.near * 100);
    // From the ground's sky out to space, by the height over the planet.
    const over = toPlanet - PLANET_RADIUS;
    p.globe = Math.min(1, Math.max(0, (over - PLANET_RADIUS * 0.05) / (PLANET_RADIUS * 0.6)));
    this.host.setPose(p);
    this.readout = { speed, near: near.name, height: Math.max(0, height), throttle: this.throttle, boost: this.boost };
  }
}
