import {
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';

import type { Vec2 } from '@core/vec2';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { WORLD_HALF } from '@world/bounds';
import { tileCellOf } from '@world/planet/atlas';
import { setPointerChart } from '@world/planet/charts';
import { anchorPlanet, inTileChart, planetNearest, planetPick, planetWorld, rehome } from './planet/bend';
import type { Facing, Viewport } from '@view/viewport';
import { FAR_TILT, eyeLift, fieldOfView, minTilt, profileTilt, pullWeight, viewDistance } from '@view/cameraProfile';

/**
 * Close inspection of pedestrian faces, gaits and the people inside vehicles.
 * At 18 (a view 14 m tall) a person was about eighty pixels high; at 5 the view
 * is 4 m tall and a person fills about half of it; at 2 (the player asked to
 * come closer, 2026-10-02) the view is 1.6 m tall: a face and shoulders.
 */
export const MIN_HALF_HEIGHT = 2;
/** On the planet, out to the whole globe: half again its radius. */
export const MAX_HALF_HEIGHT = __PLANET__ ? Math.round(PLANET_RADIUS * 1.5) : 1_600;

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
const VIEW_REACH = WORLD_HALF + 200;
/** The orthographic camera's distance from the view's centre: past the farthest ground a zoomed-out low view takes in. */
const DISTANCE = 5000;
/**
 * The perspective camera's vertical field of view far away, degrees: a long
 * lens, so a street keeps its proportions and the town still reads as a
 * model. Close up it widens to a person's view (`view/cameraProfile.ts`
 * `fieldOfView`); the camera's own `fov` is the one in use.
 */
export const PERSPECTIVE_FOV = 35;
/**
 * How far one notch of the wheel may carry the view forward once the camera
 * is as close as it comes, in units of that closest distance per unit of
 * log zoom: the zoom goes on as a walk towards the pointer (camera-controls'
 * `infinityDolly`: at the distance limit the camera keeps its distance and
 * moves the target).
 */
const DOLLY_REACH = 2.5;
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
    if (__PLANET__) {
      // On the planet there is no edge: a centre dragged over a face's border
      // goes on on the face it reached, the view turned by the turn between
      // the two faces' axes there, so nothing on screen moves.
      const moved = rehome(target.x, -target.z);
      if (moved) {
        target.x = moved.x;
        target.z = -moved.y;
        azimuth = wrapAzimuth(azimuth + moved.turn);
      }
      anchorPlanet(target.x, target.z);
    } else {
      // The view's centre stays over the map: dragged off it, the view
      // showed nothing but sky - a white screen.
      target.x = Math.max(-VIEW_REACH, Math.min(VIEW_REACH, target.x));
      target.z = Math.max(-VIEW_REACH, Math.min(VIEW_REACH, target.z));
    }
    // Pulled back from the planet to see it whole: how far the view has gone
    // from the ground to the globe (0 near the ground, 1 the globe filling it).
    const globe = globeNow = __PLANET__ ? smooth((halfHeight - PLANET_RADIUS * 0.15) / (PLANET_RADIUS * 1.05)) : 0;
    let distance = DISTANCE + globe * PLANET_RADIUS * 2.4;
    if (camera === ortho) {
      ortho.left = -halfHeight * aspect;
      ortho.right = halfHeight * aspect;
      ortho.top = halfHeight;
      ortho.bottom = -halfHeight;
      ortho.far = Math.max(14000, distance + PLANET_RADIUS * 2.6 * (__PLANET__ ? 1 : 0));
    } else {
      // As far back as makes the view `halfHeight` tall at the centre: the
      // same scale there as the orthographic view had, through a lens that
      // widens in the street (`cameraProfile`).
      persp.fov = fieldOfView(halfHeight);
      distance = viewDistance(halfHeight) + globe * PLANET_RADIUS * 2.4;
      persp.aspect = aspect;
      persp.near = Math.max(0.2, distance * 0.02);
      persp.far = distance * 4 + 6000 + (__PLANET__ ? PLANET_RADIUS * 2.6 : 0);
    }

    // In perspective the view looks at the ground itself, at its height
    // there: at the height of the plane at zero, a camera brought close over
    // a hill or a chapada ended inside it and showed the land from below
    // (the player, 2026-10-07).
    // Close up, the point looked at rises to a person's eyes: the closest
    // view is a pedestrian's, looking down the street, not at the asphalt.
    if (camera === persp) target.y = (groundAt ? groundAt(target.x, -target.z) : 0) + eyeLift(halfHeight);
    // Out at the globe, the view slides from the ground it looked at down to
    // the planet's centre: the globe whole in the middle of the screen.
    const looked = globe > 0 ? globeLook.set(target.x, target.y - globe * PLANET_RADIUS, target.z) : target;
    const horizontal = Math.cos(elevation) * distance;
    camera.position.set(
      looked.x + Math.cos(azimuth) * horizontal,
      (camera === persp || globe > 0 ? looked.y : 0) + Math.sin(elevation) * distance,
      looked.z + Math.sin(azimuth) * horizontal,
    );
    // "Up" on screen is the way the camera faces over the ground. At any tilt
    // below vertical that is exactly what the world's up gives; looking
    // straight down the world's up is the view direction itself and `lookAt`
    // would have no roll to go by, so the plan view would spin at random.
    camera.up.set(-Math.cos(azimuth), 0, -Math.sin(azimuth));
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
    // Pixels per unit where the view looks at the ground (the globe's pull back included).
    scaleNow = camera === persp
      ? height / Math.max(1e-6, 2 * camera.position.distanceTo(target) * Math.tan((persp.fov * Math.PI) / 360))
      : height / Math.max(1e-6, halfHeight * 2);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };
  const globeLook = new Vector3();
  /** How far out to the globe the view is, and its scale at the centre, as `apply` last set them. */
  let globeNow = 0;
  let scaleNow = 1;
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
  /** The piece whose map a gesture is read on (`Viewport.holdChart`), or -1. */
  let heldTile = -1;
  const worldAt = (px: number, py: number, atHeight = 0): Vec2 => hitAt(px, py, atHeight) ?? missed(px, py);
  /**
   * The ground for a pointer whose ray meets none: on the flat map the view's
   * centre; on the planet, past its limb, the ground nearest the ray - the
   * limb under the pointer, as a drag of the view holds it (`panTo`). The
   * view's centre there sent a road drawn off the globe's edge to the middle
   * of the screen, round the back of the planet.
   */
  const missed = (px: number, py: number): Vec2 => {
    if (!__PLANET__) return { x: target.x, y: -target.z };
    ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
    raycaster.setFromCamera(ndc, camera);
    const limb = planetNearest(raycaster.ray);
    return heldTile >= 0 ? inTileChart(heldTile, limb.x, limb.y) : limb;
  };
  /** The same, or null where the pointer's ray does not reach that plane (three's `Ray.intersectPlane`: above its horizon). */
  const hitAt = (px: number, py: number, atHeight: number): Vec2 | null => {
    ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
    raycaster.setFromCamera(ndc, camera);
    // On the planet: where the ray meets the sphere at that height, exactly.
    if (__PLANET__) {
      const found = planetPick(raycaster.ray, atHeight);
      return found && heldTile >= 0 ? inTileChart(heldTile, found.x, found.y) : found;
    }
    ground.constant = -atHeight;
    const ok = raycaster.ray.intersectPlane(ground, hit);
    ground.constant = 0;
    return ok ? { x: hit.x, y: -hit.z } : null;
  };
  /**
   * A map point as the view's own face measures it: on the planet two points
   * on different faces are subtracted in the chart of the face the view's
   * centre is on (`inTileChart`); on the flat map, the point itself.
   */
  const chart = (p: Vec2): Vec2 => (__PLANET__ ? inTileChart(tileCellOf(target.x, -target.z), p.x, p.y) : p);

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
      const found = hitAt(px, py, atHeight);
      if (!found) break;
      const was = chart(before), after = chart(found);
      target.x += was.x - after.x;
      target.z -= was.y - after.y;
      apply();
    }
  };
  /**
   * The walk on past the closest zoom: the view's centre carried towards the
   * ground under the pointer (straight ahead when the pointer is over the
   * horizon), by `excess` (> 1, the zoom factor that could not be taken).
   */
  const dolly = (px: number, py: number, excess: number, atHeight: number): void => {
    const step = viewDistance(MIN_HALF_HEIGHT) * DOLLY_REACH * Math.log(excess);
    const found = hitAt(px, py, atHeight);
    const at = found && chart(found);
    let dx = -Math.cos(azimuth), dz = -Math.sin(azimuth);
    let move = step;
    if (at) {
      const ax = at.x - target.x, az = -at.y - target.z;
      const len = Math.hypot(ax, az);
      if (len < 1e-6) return;
      dx = ax / len; dz = az / len;
      move = Math.min(step, len * (1 - 1 / excess));
    }
    target.x += dx * move;
    target.z += dz * move;
    apply();
  };

  const viewport: Viewport = {
    kind: 'iso',
    toWorld: (px, py) => worldAt(px, py),
    toWorldAt: (px, py, atHeight) => worldAt(px, py, atHeight),
    toScreen(p, cssW, cssH, atHeight = 0) {
      if (__PLANET__) projected.copy(planetWorld(p.x, atHeight, -p.y)).project(camera);
      else projected.set(p.x, atHeight, -p.y).project(camera);
      return {
        x: (projected.x * 0.5 + 0.5) * cssW,
        y: (-projected.y * 0.5 + 0.5) * cssH,
      };
    },
    holdChart(px, py) {
      if (!__PLANET__) return;
      heldTile = -1;
      const found = hitAt(px, py, 0);
      heldTile = found ? tileCellOf(found.x, found.y) : tileCellOf(target.x, -target.z);
      setPointerChart(heldTile);
    },
    releaseChart() {
      heldTile = -1;
      setPointerChart(-1);
    },
    panTo(grabbed, px, py, _cssW, _cssH, atHeight = 0) {
      // The grabbed point is held on its own plane (the height of what was
      // under the pointer), as zoom and orbit hold theirs (`keeping`): on the
      // plane at zero, close over a hill a pixel moved the view far, and a
      // ray above that plane's horizon jumped it to the target. Looking at the
      // ground, the view's height moves with its centre: a second step takes
      // up what the first left. A ray that misses the plane moves nothing.
      for (let pass = camera === persp && groundAt ? 2 : 1; pass > 0; pass--) {
        let found = hitAt(px, py, atHeight);
        // Off the globe's limb: the ground nearest the ray, so a drag past
        // the edge still turns the planet.
        if (!found && __PLANET__) {
          ndc.set((px / Math.max(1, width)) * 2 - 1, 1 - (py / Math.max(1, height)) * 2);
          raycaster.setFromCamera(ndc, camera);
          found = planetNearest(raycaster.ray);
        }
        if (!found) break;
        const held = chart(grabbed), now = chart(found);
        target.x += held.x - now.x;
        target.z -= held.y - now.y;
        apply();
      }
    },
    zoomAt(px, py, factor, _cssW, _cssH, atHeight = 0) {
      if (!(factor > 0) || !Number.isFinite(factor)) return;
      const wanted = halfHeight / factor;
      if (wanted < MIN_HALF_HEIGHT && camera === persp && !chase) {
        // As close as it comes: what is left of the zoom walks on.
        const excess = Math.min(halfHeight, MIN_HALF_HEIGHT) / wanted;
        if (halfHeight > MIN_HALF_HEIGHT) keeping(px, py, () => { halfHeight = MIN_HALF_HEIGHT; }, atHeight);
        if (excess > 1) dolly(px, py, excess, atHeight);
        return;
      }
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
    get globe() {
      return globeNow;
    },
    get scaleAtCentre() {
      return scaleNow;
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
