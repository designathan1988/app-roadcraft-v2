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
import { FAR_TILT, eyeLift, fieldOfView, minTilt, profileTilt, pullWeight, viewDistance } from '@view/cameraProfile';

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
export const MIN_ELEVATION = (20 * Math.PI) / 180;
export const MAX_ELEVATION = Math.PI / 2;
/** How far from the middle of the map the view's centre may go, units. */
const VIEW_REACH = MAP_HALF + 200;
/** The orthographic camera's distance from the view's centre: past the farthest ground a zoomed-out low view takes in. */
const DISTANCE = 5000;
/**
 * The perspective camera's vertical field of view far away, degrees: a long
 * lens, so a street keeps its proportions and the town still reads as a
 * model. Close up it widens to a person's view (`view/cameraProfile.ts`
 * `fieldOfView`); the camera's own `fov` is the one in use.
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
   * The height of what is drawn at a map point (x, y): the perspective view
   * looks at the ground there, and never goes under it (`apply`).
   */
  setGround(groundAt: (x: number, y: number) => number): void;
  /**
   * The lowest the perspective camera's eye may stand at a map point, world
   * height: over the roofs near a building (`world/buildings/cameraSolids.ts`).
   * A continuous function of position, so the camera is lifted out of a
   * building without a jump and never blocked.
   */
  setSolids(floorAt: ((x: number, y: number) => number) | null): void;
}

/** The pull in front of a building (`apply`): samples along the line of sight. */
const PULL_SAMPLES = 24;
/** How far over the ground under it the perspective camera keeps, units. */
const GROUND_CLEARANCE = 4;

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
  let halfHeight = Math.min(MAX_HALF_HEIGHT, Math.max(MIN_HALF_HEIGHT, initialHalfHeight));
  let azimuth = wrapAzimuth(Number.isFinite(orbit.azimuth) ? orbit.azimuth : DEFAULT_AZIMUTH);
  /**
   * The player's tilt, as it would be far away. The orthographic view uses
   * it as it is; the perspective view adds what the distance does by itself
   * (`tiltNow`): the camera eases towards the street as it comes closer, and
   * the player's own tilt rides on top of that.
   */
  let farTilt = clampElevation(Number.isFinite(orbit.elevation) ? orbit.elevation : DEFAULT_ELEVATION);
  /** The tilt in use now, rad. */
  const tiltNow = (): number => camera === persp
    ? Math.min(MAX_ELEVATION, Math.max(minTilt(halfHeight), profileTilt(halfHeight) + farTilt - FAR_TILT))
    : clampElevation(farTilt);
  /** The tilt the player asks for now (`next`), kept as the far tilt it means at this distance. */
  const askTilt = (next: number): void => {
    if (camera === persp) {
      const now = Math.min(MAX_ELEVATION, Math.max(minTilt(halfHeight), next));
      farTilt = now - profileTilt(halfHeight) + FAR_TILT;
    } else farTilt = clampElevation(next);
  };
  let elevation = clampElevation(farTilt);
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
      persp.lookAt(chase.look);
      persp.updateProjectionMatrix();
      persp.updateMatrixWorld(true);
      return;
    }
    elevation = tiltNow();
    // The view's centre stays over the map: dragged off it, the view
    // showed nothing but sky - a white screen.
    target.x = Math.max(-VIEW_REACH, Math.min(VIEW_REACH, target.x));
    target.z = Math.max(-VIEW_REACH, Math.min(VIEW_REACH, target.z));
    let distance = DISTANCE;
    if (camera === ortho) {
      ortho.left = -halfHeight * aspect;
      ortho.right = halfHeight * aspect;
      ortho.top = halfHeight;
      ortho.bottom = -halfHeight;
      ortho.far = 14000;
    } else {
      // As far back as makes the view `halfHeight` tall at the centre: the
      // same scale there as the orthographic view had, through a lens that
      // widens in the street (`cameraProfile`).
      persp.fov = fieldOfView(halfHeight);
      distance = viewDistance(halfHeight);
      persp.aspect = aspect;
      persp.near = Math.max(0.2, distance * 0.02);
      persp.far = distance * 4 + 6000;
    }

    // In perspective the view looks at the ground itself, at its height
    // there: at the height of the plane at zero, a camera brought close over
    // a hill or a chapada ended inside it and showed the land from below
    // (the player, 2026-10-07).
    // Close up, the point looked at rises to a person's eyes: the closest
    // view is a pedestrian's, looking down the street, not at the asphalt.
    if (camera === persp) target.y = (groundAt ? groundAt(target.x, -target.z) : 0) + eyeLift(halfHeight);
    const looked = target;
    const horizontal = Math.cos(elevation) * distance;
    camera.position.set(
      looked.x + Math.cos(azimuth) * horizontal,
      (camera === persp ? looked.y : 0) + Math.sin(elevation) * distance,
      looked.z + Math.sin(azimuth) * horizontal,
    );
    // "Up" on screen: the camera's own up with no roll, the world's up tipped
    // forward by the tilt - straight up looking level, the way the camera
    // faces over the ground looking straight down (where the world's up is
    // the view direction itself and `lookAt` would spin the plan view at
    // random). The way it faces alone, used at every tilt, turned the picture
    // upside down once the camera looked up from the street (the player,
    // 2026-10-10): looking up, that direction falls DOWN the screen.
    camera.up.set(-Math.cos(azimuth) * Math.sin(elevation), Math.cos(elevation), -Math.sin(azimuth) * Math.sin(elevation));
    const pull = camera === persp && solidsAt ? pullWeight(halfHeight) : 0;
    if (pull > 0 && solidsAt) {
      // Never behind a building from the point looked at: the eye is brought
      // in along the line of sight to just short of the first building that
      // line meets going OUT from that point (camera-controls'
      // `_collisionTest`: rays from the target towards the camera, the
      // distance cut to the first hit). Searched from the eye inwards, or
      // lifted over the roof, the eye jumped as the view crossed a building.
      // With the point looked at inside a building (the view on its wall)
      // nothing is done, as camera-controls does.
      const floorAt = solidsAt;
      const clear = (t: number): boolean => {
        const x = camera.position.x + (looked.x - camera.position.x) * t;
        const y = camera.position.y + (looked.y - camera.position.y) * t;
        const z = camera.position.z + (looked.z - camera.position.z) * t;
        return y >= floorAt(x, -z);
      };
      if (clear(1)) {
        let free = 1;
        let hit = -1;
        for (let i = PULL_SAMPLES - 1; i >= 0; i--) {
          const t = i / PULL_SAMPLES;
          if (!clear(t)) { hit = t; break; }
          free = t;
        }
        if (hit >= 0) {
          for (let i = 0; i < 10; i++) {
            const mid = (hit + free) / 2;
            if (clear(mid)) free = mid; else hit = mid;
          }
          // Faded out with the distance (`pullWeight`): continuous in the zoom.
          camera.position.lerp(looked, free * pull);
          persp.near = Math.max(0.2, camera.position.distanceTo(looked) * 0.02);
        }
      }
    }
    if (camera === persp && groundAt) {
      // And never under the ground where it stands: raised over it, still
      // looking at the same point (the camera-terrain clamp of Cesium's and
      // Unity's orbit cameras, read from the height field).
      const floor = groundAt(camera.position.x, -camera.position.z) + GROUND_CLEARANCE;
      if (camera.position.y < floor) camera.position.y = floor;
    }
    camera.lookAt(looked);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };
  /** The drawn ground's height at a map point (`setGround`). */
  let groundAt: ((x: number, y: number) => number) | null = null;
  /** The lowest the eye may stand over buildings (`setSolids`). */
  let solidsAt: ((x: number, y: number) => number) | null = null;
  const projected = new Vector3();

  /**
   * The point under a pointer, on the horizontal plane at `atHeight`.
   *
   * Height is not cosmetic here. The camera looks down at an angle, so a
   * surface fifteen units up projects about thirteen units away from the ground
   * point beneath it at 48 degrees. Solving on the wrong plane is why pointing
   * at the end of an elevated road picked open ground thirteen units away and
   * the snap never found the node that was plainly drawn there.
   */
  const worldAt = (px: number, py: number, atHeight = 0): Vec2 => hitAt(px, py, atHeight) ?? { x: target.x, y: -target.z };
  /** The same, or null where the pointer's ray does not reach that plane (three's `Ray.intersectPlane`: above its horizon). */
  const hitAt = (px: number, py: number, atHeight: number): Vec2 | null => {
    ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
    raycaster.setFromCamera(ndc, camera);
    ground.constant = -atHeight;
    const ok = raycaster.ray.intersectPlane(ground, hit);
    ground.constant = 0;
    return ok ? { x: hit.x, y: -hit.z } : null;
  };

  /** Re-applies, keeping the ground point that was under (px, py) - at `atHeight` - under it. */
  /**
   * The plane a zoom or a turn holds under the pointer. Far down a street, at
   * a grazing angle, the ground under the pointer lies many times the view's
   * distance away, and holding it swung the view metres per notch for a tiny
   * change of tilt (an ill-conditioned hold); over the horizon there is no
   * ground at all. The point held is then the one on the pointer's ray at
   * three times the view's distance: the zoom still goes towards the pointer.
   */
  const holdHeight = (px: number, py: number, atHeight: number): number => {
    if (camera !== persp) return atHeight;
    ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
    raycaster.setFromCamera(ndc, camera);
    ground.constant = -atHeight;
    const t = raycaster.ray.distanceToPlane(ground);
    ground.constant = 0;
    const limit = 3 * camera.position.distanceTo(target);
    if (t !== null && t <= limit) return atHeight;
    return raycaster.ray.origin.y + raycaster.ray.direction.y * limit;
  };
  const keeping = (px: number, py: number, change: () => void, groundHeight = 0): void => {
    const atHeight = holdHeight(px, py, groundHeight);
    const before = hitAt(px, py, atHeight);
    change();
    apply();
    // A pointer over the horizon holds no ground: the change is made about
    // the view's centre. (Its old stand-in, the centre itself, set against a
    // real point after the change, threw the view across the map.)
    if (!before) return;
    // On the plane one step is exact; looking at the ground, the view's
    // height moves with its centre, and a second step takes up what the
    // first left. Close up the tilt, the lens and the eye's lift change with
    // the zoom too: a third step.
    for (let pass = camera === persp ? 3 : 1; pass > 0; pass--) {
      const after = hitAt(px, py, atHeight);
      if (!after) break;
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
      projected.set(p.x, atHeight, -p.y).project(camera);
      return {
        x: (projected.x * 0.5 + 0.5) * cssW,
        y: (-projected.y * 0.5 + 0.5) * cssH,
      };
    },
    // The same test the zoom's hold makes (`holdHeight`): met within three
    // times the view's distance.
    holds: (px, py, atHeight) => camera !== persp || holdHeight(px, py, atHeight) === atHeight,
    panTo(grabbed, px, py, _cssW, _cssH, atHeight = 0) {
      // The grabbed point is held on its own plane (the height of what was
      // under the pointer), as zoom and orbit hold theirs (`keeping`): on the
      // plane at zero, close over a hill a pixel moved the view far, and a
      // ray above that plane's horizon jumped it to the target. Looking at the
      // ground, the view's height moves with its centre: a second step takes
      // up what the first left. A ray that misses the plane moves nothing.
      for (let pass = camera === persp && groundAt ? 2 : 1; pass > 0; pass--) {
        const now = hitAt(px, py, atHeight);
        if (!now) break;
        target.x += grabbed.x - now.x;
        target.z -= grabbed.y - now.y;
        apply();
      }
    },
    zoomAt(px, py, factor, _cssW, _cssH, atHeight = 0) {
      if (!(factor > 0) || !Number.isFinite(factor)) return;
      const wanted = halfHeight / factor;
      // The closest zoom is a person's eyes on the ground, and the zoom stops
      // there (the player, 2026-10-10: "zoom máximo até pegar o nível do chão
      // e encaixar, pronto, aí não vai mais").
      if (wanted < MIN_HALF_HEIGHT && halfHeight <= MIN_HALF_HEIGHT) return;
      keeping(px, py, () => {
        halfHeight = Math.min(MAX_HALF_HEIGHT, Math.max(MIN_HALF_HEIGHT, wanted));
      }, atHeight);
    },
    slide(right, forward) {
      // Along the ground the camera faces: forward is away from the camera
      // over the ground, whatever the tilt (straight down included).
      const fx = -Math.cos(azimuth), fz = -Math.sin(azimuth);
      target.x += fx * forward - fz * right;
      target.z += fz * forward + fx * right;
      apply();
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
        askTilt(tiltNow() + dElevation);
      };
      if (pivot) keeping(pivot.px, pivot.py, turn, pivot.height);
      else { turn(); apply(); }
    },
    setOrbit(nextAzimuth, nextElevation) {
      azimuth = wrapAzimuth(Number.isFinite(nextAzimuth) ? nextAzimuth : DEFAULT_AZIMUTH);
      askTilt(Number.isFinite(nextElevation) ? nextElevation : DEFAULT_ELEVATION);
      apply();
    },
    get azimuth() {
      return azimuth;
    },
    get elevation() {
      return elevation;
    },
    get eye() {
      return { x: camera.position.x, y: -camera.position.z, z: camera.position.y };
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
      apply();
    },
    viewport,
    target,
    get chasing() {
      return chase !== null;
    },
    setGround(next) {
      groundAt = next;
      apply();
    },
    setSolids(next) {
      solidsAt = next;
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
