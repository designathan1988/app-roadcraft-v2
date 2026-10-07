import {
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';

import type { Vec2 } from '@core/vec2';
import { PLANET_SPIN, planetFrame, planetPick, planetPoint, planetRadius, planetUnbend, setPlanetSpin } from './planet';
import { Quaternion } from 'three';
import { MAP_HALF } from '@world/bounds';
import type { Facing, Viewport } from '@view/viewport';

/**
 * Close inspection of pedestrian faces, gaits and the people inside vehicles.
 * At 18 (a view 14 m tall) a person was about eighty pixels high; at 5 the view
 * is 4 m tall and a person fills about half of it; at 2 (the player asked to
 * come closer, 2026-10-02) the view is 1.6 m tall: a face and shoulders.
 */
export const MIN_HALF_HEIGHT = 2;
export const MAX_HALF_HEIGHT = 1_600;

/**
 * The zoom range the iso rig can represent at a given viewport height.
 *
 * `zoom` is `height / (halfHeight * 2)` and `halfHeight` is clamped to
 * [MIN_HALF_HEIGHT, MAX_HALF_HEIGHT], so this is the rig's own range and NOT the
 * flat camera's `MIN_ZOOM`/`MAX_ZOOM`. Restoring a session clamps against it, so
 * a zoom the rig produced (up to 80 at 800 px tall) is never rejected by a
 * narrower fallback range. One definition, used by the rig's `zoomBounds` and by
 * the boot-time clamp before the rig exists.
 */
export function isoZoomBounds(height: number): { min: number; max: number } {
  return { min: height / (maxHalfHeight() * 2), max: height / (MIN_HALF_HEIGHT * 2) };
}

/**
 * How far out the view may go: on a planet, far enough to see the whole globe
 * (`planet.ts`); on a flat map, MAX_HALF_HEIGHT.
 */
export function maxHalfHeight(): number {
  return Math.max(MAX_HALF_HEIGHT, planetRadius() * 1.5);
}

/**
 * The orbit the camera starts in, and the one "reset view" returns to: looking
 * north-west-ish down at 48 degrees, the angle the whole game was drawn for.
 */
export const DEFAULT_AZIMUTH = Math.PI / 4;
export const DEFAULT_ELEVATION = (48 * Math.PI) / 180;
/**
 * How low the camera may look. The view is orthographic: there is no horizon to
 * look at, and below about thirty degrees the ground seen grows to twice the
 * screen's height in depth, which is paid for in shadows and detail with little
 * gained. Straight down (90) is a true plan view.
 */
export const MIN_ELEVATION = (20 * Math.PI) / 180;
export const MAX_ELEVATION = Math.PI / 2;
/** How far from the middle of the map the view's centre may go, units. */
const VIEW_REACH = MAP_HALF + 200;
/** The orthographic camera's distance from the view's centre: past the farthest ground a zoomed-out low view takes in. */
const DISTANCE = 5000;
/**
 * The perspective camera's vertical field of view, degrees: a long lens, so
 * a street keeps its proportions and the town still reads as a model.
 */
export const PERSPECTIVE_FOV = 35;
const TAU = Math.PI * 2;

const smooth = (v: number): number => {
  const t = Math.min(1, Math.max(0, v));
  return t * t * (3 - 2 * t);
};

export function clampElevation(e: number): number {
  return Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, e));
}

export function wrapAzimuth(a: number): number {
  return ((a % TAU) + TAU) % TAU;
}

export interface IsoRig {
  /** The camera drawn with: orthographic, or perspective (`setPerspective`). */
  readonly camera: OrthographicCamera | PerspectiveCamera;
  readonly perspective: boolean;
  /**
   * Perspective on or off. The view keeps its centre, its orbit and its scale
   * at the centre (`zoom` is still pixels per unit there).
   */
  setPerspective(on: boolean): void;
  readonly viewport: Viewport;
  readonly target: Vector3;
  resize(width: number, height: number): void;
  /**
   * The play camera (first or third person, `src/play.ts`): the perspective
   * camera at `eye` looking at `look`, three's space, `focus` the world point
   * the view is about (the player). Null: back to the orbit. Only with
   * perspective on.
   */
  setChase(chase: Chase | null): void;
  readonly chasing: boolean;
}

/** A free camera: where the eye is, what it looks at, its field of view, and whose view it is. */
export interface Chase {
  readonly eye: Vector3;
  readonly look: Vector3;
  readonly fov: number;
  readonly focus: Vector3;
}
/** The zoom the play camera reports: the closest detail of everything. */
const CHASE_ZOOM = 60;

export function createIsoRig(
  initial: Vec2,
  initialHalfHeight: number,
  orbit: { azimuth: number; elevation: number } = { azimuth: DEFAULT_AZIMUTH, elevation: DEFAULT_ELEVATION },
): IsoRig {
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 1, 14000);
  const persp = new PerspectiveCamera(PERSPECTIVE_FOV, 1, 1, 20000);
  let perspective = false;
  let camera: OrthographicCamera | PerspectiveCamera = ortho;
  const target = new Vector3(initial.x, 0, -initial.y);
  const raycaster = new Raycaster();
  const ground = new Plane(new Vector3(0, 1, 0), 0);
  const hit = new Vector3();
  const ndc = new Vector2();

  let width = 1;
  let height = 1;
  let halfHeight = Math.min(maxHalfHeight(), Math.max(MIN_HALF_HEIGHT, initialHalfHeight));
  let azimuth = wrapAzimuth(Number.isFinite(orbit.azimuth) ? orbit.azimuth : DEFAULT_AZIMUTH);
  let elevation = clampElevation(Number.isFinite(orbit.elevation) ? orbit.elevation : DEFAULT_ELEVATION);
  let chase: Chase | null = null;
  /** The orbit's centre while the play camera has it. */
  const orbitTarget = new Vector3();

  const apply = (): void => {
    const aspect = Math.max(0.1, width / Math.max(1, height));
    if (chase && camera === persp) {
      persp.fov = chase.fov;
      persp.aspect = aspect;
      // Close enough for a face at arm's length, far enough for the horizon.
      persp.near = 0.25;
      persp.far = 16000;
      persp.up.set(0, 1, 0);
      persp.position.copy(chase.eye);
      target.copy(chase.focus);
      if (planetRadius() > 0) {
        // On the globe: the eye and what it looks at carried with the ground
        // round the player, the world's up turned with it.
        planetFrame(target.x, target.z, turn);
        planetPoint(target.x, target.y, target.z, bentFocus);
        persp.position.sub(target).applyQuaternion(turn).add(bentFocus);
        persp.up.applyQuaternion(turn);
        persp.lookAt(look.copy(chase.look).sub(target).applyQuaternion(turn).add(bentFocus));
      } else {
        persp.lookAt(chase.look);
      }
      persp.updateProjectionMatrix();
      persp.updateMatrixWorld(true);
      return;
    }
    persp.fov = PERSPECTIVE_FOV;
    const R = planetRadius();
    if (R > 0 && litFor <= 0) {
      // The planet just came on: the ground the view was over brought to
      // the top of the globe.
      litFor = R;
      bringToTop(target.x, target.z);
    }
    litFor = R;
    if (R <= 0) {
      // The view's centre stays over the map: dragged off it, the view
      // showed nothing but sky - a white screen.
      target.x = Math.max(-VIEW_REACH, Math.min(VIEW_REACH, target.x));
      target.z = Math.max(-VIEW_REACH, Math.min(VIEW_REACH, target.z));
    }
    // Pulled back from a planet to see it whole: how far the view has gone
    // from the street to the globe (0 on the ground, 1 the globe filling it).
    globe = R > 0 ? smooth((halfHeight - R * 0.15) / (R * 1.05)) : 0;
    let distance = DISTANCE + globe * R * 2.4;
    if (camera === ortho) {
      ortho.left = -halfHeight * aspect;
      ortho.right = halfHeight * aspect;
      ortho.top = halfHeight;
      ortho.bottom = -halfHeight;
      // Room for the whole globe behind the point looked at.
      ortho.far = Math.max(14000, distance + R * 2.6);
    } else {
      // As far back as makes the view `halfHeight` tall at the centre: the
      // same scale there as the orthographic view had.
      distance = halfHeight / Math.tan((PERSPECTIVE_FOV * Math.PI) / 360);
      persp.aspect = aspect;
      persp.near = Math.max(0.5, distance * 0.02);
      persp.far = distance * 4 + 6000 + R * 2.6;
    }

    // On a planet the camera stays over the top of the globe and the GLOBE
    // turns (`planet.ts` PLANET_SPIN), as a globe viewer's does: the ground
    // looked at is always brought to the top, any way round, with no pole the
    // view cannot pass. `target` is that ground on the map's chart.
    const looked = R > 0 ? look.set(0, target.y, 0) : target;
    const horizontal = Math.cos(elevation) * distance;
    camera.position.set(
      looked.x + Math.cos(azimuth) * horizontal,
      (camera === persp ? looked.y : 0) + Math.sin(elevation) * distance,
      looked.z + Math.sin(azimuth) * horizontal,
    );
    // "Up" on screen is the way the camera faces over the ground. At any tilt
    // below vertical that is exactly what the world's up gives; looking
    // straight down the world's up is the view direction itself and `lookAt`
    // would have no roll to go by, so the plan view would spin at random.
    camera.up.set(-Math.cos(azimuth), 0, -Math.sin(azimuth));
    camera.lookAt(looked);
    if (globe > 0) {
      // Pulled back to the whole planet: the view slides from the ground it
      // looked at down to the planet's centre, the globe whole in the middle.
      camera.position.y -= globe * R;
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };
  /** How far out to the whole globe the view is (`Viewport.globe`). */
  let globe = 0;
  /** The planet's radius the view was last set for (0: flat). */
  let litFor = 0;
  const spin = new Quaternion();
  const from = new Vector3();
  const to = new Vector3();
  /** Turns the globe so a direction from its centre comes round to another. */
  const turnGlobe = (a: Vector3, b: Vector3): void => {
    if (a.lengthSq() < 1e-9 || b.lengthSq() < 1e-9) return;
    spin.setFromUnitVectors(a.normalize(), b.normalize()).multiply(PLANET_SPIN);
    setPlanetSpin(spin);
  };
  /** The map's chart point now at the top of the globe, into `target`. */
  const syncTarget = (): void => {
    planetUnbend(to.set(0, 0, 0), from);
    const rho = Math.hypot(from.x, from.z), most = planetRadius() * 400;
    const k = rho > most ? most / rho : 1;
    target.x = from.x * k;
    target.z = from.z * k;
  };
  /** Turns the globe to bring a chart point (three's x, z) to its top. */
  const bringToTop = (x: number, z: number): void => {
    const R = planetRadius();
    planetPoint(x, 0, z, from);
    from.y += R;
    turnGlobe(from, to.set(0, 1, 0));
    syncTarget();
  };
  /**
   * Where a pointer's ray meets the globe at height `atHeight`, as a direction
   * from its centre; past the limb, the direction of the ray's nearest pass,
   * so a drag off the edge still turns the globe.
   */
  const globeDirection = (px: number, py: number, atHeight: number, out: Vector3): Vector3 => {
    ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
    raycaster.setFromCamera(ndc, camera);
    const R = planetRadius();
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    const ox = o.x, oy = o.y + R, oz = o.z;
    const b = ox * d.x + oy * d.y + oz * d.z;
    const c = ox * ox + oy * oy + oz * oz - (R + atHeight) * (R + atHeight);
    const disc = b * b - c;
    const t = disc >= 0 ? -b - Math.sqrt(disc) : -b;
    return out.set(ox + d.x * t, oy + d.y * t, oz + d.z * t);
  };
  const turn = new Quaternion();
  const bentFocus = new Vector3();
  const look = new Vector3();

  /**
   * The point under a pointer, on the horizontal plane at `atHeight`.
   *
   * Height is not cosmetic here. The camera looks down at an angle, so a
   * surface fifteen units up projects about thirteen units away from the ground
   * point beneath it at 48 degrees. Solving on the wrong plane is why pointing
   * at the end of an elevated road picked open ground thirteen units away and
   * the snap never found the node that was plainly drawn there.
   */
  const worldAt = (px: number, py: number, atHeight = 0): Vec2 => {
    ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
    raycaster.setFromCamera(ndc, camera);
    if (planetRadius() > 0) {
      // On the globe: the sphere at that height, taken back to the plane exactly.
      const onGlobe = planetPick(raycaster.ray.origin, raycaster.ray.direction, atHeight, hit);
      return onGlobe ? { x: onGlobe.x, y: -onGlobe.z } : { x: target.x, y: -target.z };
    }
    ground.constant = -atHeight;
    const ok = raycaster.ray.intersectPlane(ground, hit);
    ground.constant = 0;
    if (!ok) return { x: target.x, y: -target.z };
    return { x: hit.x, y: -hit.z };
  };

  /** Re-applies, keeping the ground point that was under (px, py) - at `atHeight` - under it. */
  const keeping = (px: number, py: number, change: () => void, atHeight = 0): void => {
    if (planetRadius() > 0) {
      // The globe turned under the camera so the ground under the pointer
      // stays there: one exact step (the camera does not follow the turn).
      const before = globeDirection(px, py, atHeight, new Vector3());
      change();
      apply();
      turnGlobe(before, globeDirection(px, py, atHeight, new Vector3()));
      syncTarget();
      apply();
      return;
    }
    const before = worldAt(px, py, atHeight);
    change();
    apply();
    // On the plane one step is exact; on the globe the view turns as the
    // centre moves, and a second step takes up what the first left.
    for (let pass = planetRadius() > 0 ? 2 : 1; pass > 0; pass--) {
      const after = worldAt(px, py, atHeight);
      target.x += before.x - after.x;
      target.z -= before.y - after.y;
      apply();
    }
  };

  const viewport: Viewport = {
    kind: 'iso',
    toWorld: (px, py) => worldAt(px, py),
    toWorldAt: (px, py, atHeight) => worldAt(px, py, atHeight),
    toScreen(p, cssW, cssH, atHeight = 0) {
      const projected = planetPoint(p.x, atHeight, -p.y, new Vector3()).project(camera);
      return {
        x: (projected.x * 0.5 + 0.5) * cssW,
        y: (-projected.y * 0.5 + 0.5) * cssH,
      };
    },
    panTo(grabbed, px, py) {
      const R = planetRadius();
      if (R > 0) {
        // The grabbed ground turned round to under the hand: the globe
        // spins any way, as in a globe viewer.
        planetPoint(grabbed.x, 0, -grabbed.y, from);
        from.y += R;
        turnGlobe(from, globeDirection(px, py, 0, to));
        syncTarget();
        apply();
        return;
      }
      const now = worldAt(px, py);
      target.x += grabbed.x - now.x;
      target.z -= grabbed.y - now.y;
      apply();
    },
    zoomAt(px, py, factor, _cssW, _cssH, atHeight = 0) {
      keeping(px, py, () => {
        halfHeight = Math.min(maxHalfHeight(), Math.max(MIN_HALF_HEIGHT, halfHeight / factor));
      }, atHeight);
    },
    rotate(quarterTurns, px, py) {
      keeping(px, py, () => {
        azimuth = wrapAzimuth(azimuth + quarterTurns * Math.PI * 0.5);
      });
    },
    orbit(dAzimuth, dElevation, pivot) {
      // About the point the player grabbed (the player, 2026-10-07): that
      // ground stays under the pointer while the camera swings round and over
      // it. Without a pivot, about the centre of the view.
      const turn = (): void => {
        azimuth = wrapAzimuth(azimuth + dAzimuth);
        elevation = clampElevation(elevation + dElevation);
      };
      if (pivot) keeping(pivot.px, pivot.py, turn, pivot.height);
      else { turn(); apply(); }
    },
    setOrbit(nextAzimuth, nextElevation) {
      azimuth = wrapAzimuth(nextAzimuth);
      elevation = clampElevation(nextElevation);
      apply();
    },
    get azimuth() {
      return azimuth;
    },
    get elevation() {
      return elevation;
    },
    get centre() {
      return { x: target.x, y: -target.z };
    },
    moveTo(p) {
      target.set(p.x, 0, -p.y);
      if (planetRadius() > 0) bringToTop(target.x, target.z);
      apply();
    },
    get zoom() {
      return chase ? CHASE_ZOOM : height / Math.max(1, halfHeight * 2);
    },
    get facing() {
      const turns = Math.round((azimuth - DEFAULT_AZIMUTH) / (Math.PI * 0.5));
      return (((turns % 4) + 4) % 4) as Facing;
    },
    get zoomBounds() {
      return isoZoomBounds(height);
    },
    get globe() {
      return globe;
    },
  };

  apply();
  return {
    get camera() {
      return camera;
    },
    get perspective() {
      return perspective;
    },
    setPerspective(on) {
      if (on === perspective) return;
      perspective = on;
      camera = on ? persp : ortho;
      apply();
    },
    viewport,
    target,
    get chasing() {
      return chase !== null;
    },
    setChase(next) {
      if (next && !chase) orbitTarget.copy(target);
      if (!next && chase) target.copy(orbitTarget);
      chase = next;
      apply();
    },
    resize(nextWidth, nextHeight) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      apply();
    },
  };
}
