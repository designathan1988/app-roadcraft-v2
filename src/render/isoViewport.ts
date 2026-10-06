import {
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';

import type { Vec2 } from '@core/vec2';
import { MAP_HALF } from '@world/bounds';
import type { Facing, Viewport } from '@view/viewport';

/**
 * Close inspection of pedestrian faces, gaits and the people inside vehicles.
 * At 18 (a view 14 m tall) a person was about eighty pixels high; at 5 the view
 * is 4 m tall and a person fills about half of it; at 2 (the player asked to
 * come closer, 2026-10-02) the view is 1.6 m tall: a face and shoulders.
 */
export const MIN_HALF_HEIGHT = 0.5;
export const MAX_HALF_HEIGHT = 950;

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
  return { min: height / (MAX_HALF_HEIGHT * 2), max: height / (MIN_HALF_HEIGHT * 2) };
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
export const MIN_ELEVATION = (30 * Math.PI) / 180;
/**
 * In perspective the camera may look almost level, out to the horizon and the
 * sky (the player, 2026-10-06: "não dá para ver o céu").
 */
export const MIN_ELEVATION_PERSPECTIVE = (4 * Math.PI) / 180;
export const MAX_ELEVATION = Math.PI / 2;
/** How far above the ground the orbit's camera is kept, units (4 m). */
const GROUND_CLEARANCE = 1.5;
/** The point the perspective camera turns about stands this high over the ground: eye height, 1.7 m. */
const EYE = 4.25;
/** How far from the middle of the map the view's centre may go, units. */
const VIEW_REACH = MAP_HALF + 200;
const DISTANCE = 2400;
/**
 * The perspective camera's vertical field of view, degrees: a long lens, so
 * a street keeps its proportions and the town still reads as a model.
 */
export const PERSPECTIVE_FOV = 35;
const TAU = Math.PI * 2;

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
  /**
   * The ground's height under a point of three's space (x, z): the orbit's
   * perspective camera is kept above it, as a camera on a spring arm is.
   */
  setGround(at: ((x: number, z: number) => number) | null): void;
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
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 1, 7000);
  const persp = new PerspectiveCamera(PERSPECTIVE_FOV, 1, 1, 20000);
  let perspective = false;
  let groundAt: ((x: number, z: number) => number) | null = null;
  /** The tilt allowed: down to the horizon in perspective, thirty degrees in the orthographic view. */
  const tilt = (e: number): number => Math.min(MAX_ELEVATION, Math.max(perspective ? MIN_ELEVATION_PERSPECTIVE : MIN_ELEVATION, e));
  let camera: OrthographicCamera | PerspectiveCamera = ortho;
  const target = new Vector3(initial.x, 0, -initial.y);
  const raycaster = new Raycaster();
  const ground = new Plane(new Vector3(0, 1, 0), 0);
  const hit = new Vector3();
  const ndc = new Vector2();

  let width = 1;
  let height = 1;
  let halfHeight = Math.min(MAX_HALF_HEIGHT, Math.max(MIN_HALF_HEIGHT, initialHalfHeight));
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
      persp.lookAt(chase.look);
      target.copy(chase.focus);
      persp.updateProjectionMatrix();
      persp.updateMatrixWorld(true);
      return;
    }
    persp.fov = PERSPECTIVE_FOV;
    // In perspective the camera turns about a point at eye height over the
    // ground there, so zoomed right in it stands in the street, not under it.
    if (camera === persp && groundAt) target.y = groundAt(target.x, target.z) + EYE;
    else if (camera !== persp) target.y = 0;
    // The view's centre stays over the map. Tilted low, a drag near the horizon
    // grabs ground kilometres away, and the centre was carried off the map into
    // empty sky - a white screen.
    target.x = Math.max(-VIEW_REACH, Math.min(VIEW_REACH, target.x));
    target.z = Math.max(-VIEW_REACH, Math.min(VIEW_REACH, target.z));
    let distance = DISTANCE;
    if (camera === ortho) {
      ortho.left = -halfHeight * aspect;
      ortho.right = halfHeight * aspect;
      ortho.top = halfHeight;
      ortho.bottom = -halfHeight;
    } else {
      // As far back as makes the view `halfHeight` tall at the centre: the
      // same scale there as the orthographic view had.
      distance = halfHeight / Math.tan((PERSPECTIVE_FOV * Math.PI) / 360);
      persp.aspect = aspect;
      persp.near = Math.max(0.5, distance * 0.02);
      persp.far = distance * 4 + 6000;
    }

    const horizontal = Math.cos(elevation) * distance;
    camera.position.set(
      target.x + Math.cos(azimuth) * horizontal,
      (camera === persp ? target.y : 0) + Math.sin(elevation) * distance,
      target.z + Math.sin(azimuth) * horizontal,
    );
    // Tilted low over hills, the camera never goes under the ground: where the
    // ground under it, or between it and what it looks at, stands higher than
    // the line of sight, the camera is lifted over it (it had gone under the
    // land and showed it from below).
    if (camera === persp && groundAt) {
      let lift = 0;
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const x = camera.position.x + (target.x - camera.position.x) * t * 0.85;
        const z = camera.position.z + (target.z - camera.position.z) * t * 0.85;
        const y = camera.position.y + (target.y - camera.position.y) * t * 0.85;
        const clear = groundAt(x, z) + GROUND_CLEARANCE - y;
        if (clear > 0) lift = Math.max(lift, clear / Math.max(0.15, 1 - t * 0.85));
      }
      camera.position.y += lift;
    }
    // "Up" on screen is the way the camera faces over the ground. At any tilt
    // below vertical that is exactly what the world's up gives; looking
    // straight down the world's up is the view direction itself and `lookAt`
    // would have no roll to go by, so the plan view would spin at random.
    camera.up.set(-Math.cos(azimuth), 0, -Math.sin(azimuth));
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };

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
    ground.constant = -atHeight;
    const ok = raycaster.ray.intersectPlane(ground, hit);
    ground.constant = 0;
    if (!ok) return { x: target.x, y: -target.z };
    return { x: hit.x, y: -hit.z };
  };

  /** Re-applies, keeping the ground point that was under (px, py) under it. */
  const keeping = (px: number, py: number, change: () => void): void => {
    const before = worldAt(px, py);
    change();
    apply();
    const after = worldAt(px, py);
    target.x += before.x - after.x;
    target.z -= before.y - after.y;
    apply();
  };

  const viewport: Viewport = {
    kind: 'iso',
    toWorld: (px, py) => worldAt(px, py),
    toWorldAt: (px, py, atHeight) => worldAt(px, py, atHeight),
    toScreen(p, cssW, cssH, atHeight = 0) {
      const projected = new Vector3(p.x, atHeight, -p.y).project(camera);
      return {
        x: (projected.x * 0.5 + 0.5) * cssW,
        y: (-projected.y * 0.5 + 0.5) * cssH,
      };
    },
    panTo(grabbed, px, py) {
      const now = worldAt(px, py);
      target.x += grabbed.x - now.x;
      target.z -= grabbed.y - now.y;
      apply();
    },
    zoomAt(px, py, factor) {
      keeping(px, py, () => {
        halfHeight = Math.min(MAX_HALF_HEIGHT, Math.max(MIN_HALF_HEIGHT, halfHeight / factor));
      });
    },
    rotate(quarterTurns, px, py) {
      keeping(px, py, () => {
        azimuth = wrapAzimuth(azimuth + quarterTurns * Math.PI * 0.5);
      });
    },
    orbit(dAzimuth, dElevation) {
      // About the centre of the view: the ground there stays put, the camera
      // swings round and over it. Orbiting about the pointer instead sends the
      // view sliding off whenever the pointer is near an edge.
      azimuth = wrapAzimuth(azimuth + dAzimuth);
      elevation = tilt(elevation + dElevation);
      apply();
    },
    setOrbit(nextAzimuth, nextElevation) {
      azimuth = wrapAzimuth(nextAzimuth);
      elevation = tilt(nextElevation);
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
      elevation = tilt(elevation);
      apply();
    },
    viewport,
    target,
    get chasing() {
      return chase !== null;
    },
    setGround(at) {
      groundAt = at;
      apply();
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
