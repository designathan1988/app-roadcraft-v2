import { type Object3D, PerspectiveCamera, Quaternion, Ray, Raycaster, Vector2, Vector3 } from 'three';
import { PLANET_RADIUS, reliefAt } from './relief';

/**
 * The camera round the planet, as Google Earth and Cesium move theirs: the
 * planet never moves; the camera goes round it.
 *
 * - Left drag grabs the ground: the point under the pointer stays under it,
 *   the camera turning round the planet's centre to keep it there (Cesium's
 *   rotate, `ScreenSpaceCameraController`).
 * - The wheel goes in and out towards the point under the pointer; a right drag
 *   goes in and out too (Google Earth, Cesium).
 * - Shift + drag, or the middle button, tilts and turns the view about the point
 *   looked at.
 * - N turns north back up, U looks straight down again.
 *
 * The camera looks at a point of the ground from `range` away, tilted from
 * straight down by `tilt` and facing `heading` from north. Screen up is the way
 * the camera faces over the ground, never the local vertical: looking straight
 * down, the local vertical IS the line of sight, and a camera told to keep it up
 * has no roll to go by - the planet spun on screen.
 */

const MIN_RANGE = 25;
const MAX_RANGE = 70_000;
const FOV = 45;
const MAX_TILT = 1.4;

export interface PlanetCamera {
  readonly camera: PerspectiveCamera;
  /** The point of the surface looked at, as a unit direction. */
  readonly target: Vector3;
  readonly altitude: number;
  resize(width: number, height: number): void;
  attach(element: HTMLElement): void;
  update(): void;
  /** The ground point (unit direction) under a pixel, or null in space. */
  groundAt(px: number, py: number): Vector3 | null;
}

/**
 * `terrain` is what the pointer can land on: the drawn ground. The pointer
 * grabs the ground the player sees - a hillside, a valley - not a smooth sphere
 * through the point looked at, which near the ground lies metres off the hill
 * under the pointer and let the grabbed point slide away from it.
 */
export function createPlanetCamera(terrain: Object3D): PlanetCamera {
  const camera = new PerspectiveCamera(FOV, 1, 1, 100_000);
  const target = new Vector3(0.3, 0.55, 0.78).normalize();
  let range = 45_000;
  let heading = 0;
  /** Tilt the player set, added to the one the altitude gives. */
  let tiltBias = 0;
  let width = 1;
  let height = 1;

  const up = new Vector3();
  const north = new Vector3();
  const east = new Vector3();
  const forward = new Vector3();
  const ground = new Vector3();
  const raycaster = new Raycaster();
  const ndc = new Vector2();

  /** The local frame at the point looked at: up, and the way the camera faces over the ground. */
  const frame = (): void => {
    up.copy(target);
    north.set(0, 1, 0).addScaledVector(up, -up.y);
    if (north.lengthSq() < 1e-6) north.set(0, 0, -1).addScaledVector(up, -up.z);
    north.normalize();
    east.crossVectors(north, up).normalize();
    forward.copy(north).multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading)).normalize();
  };

  /** Tilt from straight down: towards the horizon near the ground, straight down from orbit. */
  const autoTilt = (): number => {
    const t = Math.min(1, Math.max(0, (Math.log(range) - Math.log(400)) / (Math.log(25_000) - Math.log(400))));
    return 1.15 * (1 - t);
  };
  const tilt = (): number => Math.min(MAX_TILT, Math.max(0, autoTilt() + tiltBias));
  /** Sets the tilt the player sees now, kept within its range: the bias is what makes it so. */
  const setTilt = (value: number): void => {
    tiltBias = Math.min(MAX_TILT, Math.max(0, value)) - autoTilt();
  };

  const groundRadius = (): number => PLANET_RADIUS + Math.max(0, reliefAt(target.x, target.y, target.z));

  const update = (): void => {
    frame();
    ground.copy(target).multiplyScalar(groundRadius());
    const a = tilt();
    camera.position.copy(ground).addScaledVector(up, range * Math.cos(a)).addScaledVector(forward, -range * Math.sin(a));
    // Never under the ground: at least a few metres above it.
    const dir = camera.position.clone().normalize();
    const floor = PLANET_RADIUS + Math.max(0, reliefAt(dir.x, dir.y, dir.z)) + 8;
    if (camera.position.length() < floor) camera.position.copy(dir.multiplyScalar(floor));
    // Screen up: perpendicular to the line of sight, in the plane of the local
    // vertical and the facing - the facing itself when looking straight down.
    camera.up.copy(up).multiplyScalar(Math.sin(a)).addScaledVector(forward, Math.cos(a)).normalize();
    camera.lookAt(ground);
    camera.near = Math.max(0.5, range * 0.01);
    camera.far = range * 4 + PLANET_RADIUS * 3;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };

  /** The ray under a pixel against the sphere through the point looked at. */
  const groundAt = (px: number, py: number): Vector3 | null => {
    ndc.set((px / width) * 2 - 1, 1 - (py / height) * 2);
    raycaster.setFromCamera(ndc, camera);
    const ray: Ray = raycaster.ray;
    // The drawn terrain first, or the sea over it, whichever the ray meets first.
    const hits = raycaster.intersectObjects(terrain.children.filter((o) => o.visible), false);
    const sea = seaHit(ray);
    const land = hits[0]?.point;
    if (land && (!sea || ray.origin.distanceTo(land) <= ray.origin.distanceTo(sea))) return land.clone().normalize();
    if (sea) return sea.normalize();
    const r = groundRadius();
    const b = ray.origin.dot(ray.direction);
    const c = ray.origin.lengthSq() - r * r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const along = -b - Math.sqrt(disc);
    if (along < 0) return null;
    return ray.origin.clone().addScaledVector(ray.direction, along).normalize();
  };

  /** Where a ray meets the sea, the sphere at sea level; null if it misses it. */
  const seaHit = (ray: Ray): Vector3 | null => {
    const b = ray.origin.dot(ray.direction);
    const c = ray.origin.lengthSq() - PLANET_RADIUS * PLANET_RADIUS;
    const disc = b * b - c;
    if (disc < 0) return null;
    const along = -b - Math.sqrt(disc);
    return along < 0 ? null : ray.origin.clone().addScaledVector(ray.direction, along);
  };

  /** Turns the camera round the planet's centre so the ground at `from` comes to where `to` is now. */
  const carry = (from: Vector3, to: Vector3): void => {
    // The ground under the pointer moved from `from` to `to` on screen; the
    // camera turns the other way, so `from` comes back under the pointer.
    const turn = new Quaternion().setFromUnitVectors(to, from);
    const before = forward.clone();
    target.applyQuaternion(turn).normalize();
    // Keep the facing as it was over the ground, so the view does not twist.
    before.applyQuaternion(turn);
    frame();
    const facing = before.addScaledVector(up, -before.dot(up)).normalize();
    heading = Math.atan2(facing.dot(east), facing.dot(north));
  };

  /** Changes the range, keeping the ground under the pixel where it is. */
  const zoomAt = (px: number, py: number, factor: number): void => {
    const before = groundAt(px, py);
    range = Math.min(MAX_RANGE, Math.max(MIN_RANGE, range * factor));
    update();
    const after = groundAt(px, py);
    if (before && after) { carry(before, after); update(); }
  };

  return {
    camera,
    target,
    get altitude() { return range; },
    groundAt,
    resize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      camera.aspect = width / height;
      update();
    },
    update,
    attach(element) {
      let mode: 'grab' | 'zoom' | 'tilt' | null = null;
      let grabbed: Vector3 | null = null;
      let lastX = 0, lastY = 0;
      const local = (e: MouseEvent): [number, number] => {
        const rect = element.getBoundingClientRect();
        return [e.clientX - rect.left, e.clientY - rect.top];
      };
      element.addEventListener('contextmenu', (e) => e.preventDefault());
      element.addEventListener('pointerdown', (e) => {
        const [px, py] = local(e);
        lastX = px; lastY = py;
        mode = e.button === 1 || (e.button === 0 && e.shiftKey) ? 'tilt' : e.button === 2 ? 'zoom' : 'grab';
        grabbed = mode === 'grab' ? groundAt(px, py) : null;
        element.setPointerCapture(e.pointerId);
      });
      const end = (e: PointerEvent): void => {
        mode = null;
        grabbed = null;
        if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
      };
      element.addEventListener('pointerup', end);
      element.addEventListener('pointercancel', end);
      element.addEventListener('pointermove', (e) => {
        if (!mode) return;
        const [px, py] = local(e);
        const dx = px - lastX, dy = py - lastY;
        lastX = px; lastY = py;
        if (mode === 'grab') {
          const now = groundAt(px, py);
          if (grabbed && now) carry(grabbed, now);
          else if (!grabbed) grabbed = now;
        } else if (mode === 'zoom') {
          range = Math.min(MAX_RANGE, Math.max(MIN_RANGE, range * Math.pow(1.006, dy)));
        } else {
          heading += dx * 0.005;
          setTilt(tilt() - dy * 0.004);
        }
        update();
      });
      element.addEventListener('wheel', (e) => {
        e.preventDefault();
        const [px, py] = local(e);
        zoomAt(px, py, Math.pow(1.0015, e.deltaY));
      }, { passive: false });
      window.addEventListener('keydown', (e) => {
        if (e.key === 'n' || e.key === 'N') { heading = 0; update(); }
        if (e.key === 'u' || e.key === 'U') { setTilt(0); update(); }
      });
    },
  };
}
