import { PerspectiveCamera, Vector3 } from 'three';
import { PLANET_RADIUS, reliefAt } from './relief';

/**
 * A camera that goes round the planet and down to its ground, as Google Earth's
 * does: it looks at a point of the surface, from straight above when far out
 * and tilting towards the horizon as it comes down.
 *
 * Dragging moves the point looked at over the sphere (the planet turns under
 * the pointer); a right drag turns the heading and the tilt; the wheel changes
 * the altitude, by a share of itself, so one notch means as much in orbit as at
 * street level.
 */

const MIN_ALTITUDE = 25;
const MAX_ALTITUDE = 70_000;
const FOV = 45;

export interface PlanetCamera {
  readonly camera: PerspectiveCamera;
  /** The point of the surface looked at, as a unit direction. */
  readonly target: Vector3;
  readonly altitude: number;
  resize(width: number, height: number): void;
  attach(element: HTMLElement): void;
  update(): void;
}

export function createPlanetCamera(): PlanetCamera {
  const camera = new PerspectiveCamera(FOV, 1, 1, 100_000);
  const target = new Vector3(0.3, 0.55, 0.78).normalize();
  let altitude = 45_000;
  let heading = 0;
  /** Extra tilt the player added with the right button, radians. */
  let tiltBias = 0;
  let height = 1;

  const up = new Vector3();
  const north = new Vector3();
  const east = new Vector3();
  const forward = new Vector3();
  const ground = new Vector3();

  /** The local frame at the point looked at. */
  const frame = (): void => {
    up.copy(target);
    north.set(0, 1, 0).addScaledVector(up, -up.y);
    if (north.lengthSq() < 1e-8) north.set(0, 0, -1).addScaledVector(up, -up.z);
    north.normalize();
    east.crossVectors(north, up).normalize();
    forward.copy(north).multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading)).normalize();
  };

  /** Tilt from straight down: looking at the horizon near the ground, straight down from orbit. */
  const tilt = (): number => {
    const t = Math.min(1, Math.max(0, (Math.log(altitude) - Math.log(400)) / (Math.log(25_000) - Math.log(400))));
    return Math.min(1.35, Math.max(0, 1.15 * (1 - t) + tiltBias));
  };

  const update = (): void => {
    frame();
    const h = Math.max(0, reliefAt(target.x, target.y, target.z));
    ground.copy(target).multiplyScalar(PLANET_RADIUS + h);
    const a = tilt();
    camera.position.copy(ground).addScaledVector(up, altitude * Math.cos(a)).addScaledVector(forward, -altitude * Math.sin(a));
    // Never under the ground: the camera rides at least a few metres above it.
    const camDir = camera.position.clone().normalize();
    const floor = PLANET_RADIUS + Math.max(0, reliefAt(camDir.x, camDir.y, camDir.z)) + 8;
    if (camera.position.length() < floor) camera.position.copy(camDir.multiplyScalar(floor));
    camera.up.copy(up);
    camera.lookAt(ground);
    camera.near = Math.max(0.5, altitude * 0.01);
    camera.far = altitude * 4 + PLANET_RADIUS * 3;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };

  return {
    camera,
    target,
    get altitude() { return altitude; },
    resize(width, h) {
      height = Math.max(1, h);
      camera.aspect = Math.max(0.1, width / height);
      update();
    },
    update,
    attach(element) {
      let dragging: 'move' | 'turn' | null = null;
      let lastX = 0, lastY = 0;
      element.addEventListener('contextmenu', (e) => e.preventDefault());
      element.addEventListener('pointerdown', (e) => {
        dragging = e.button === 2 ? 'turn' : 'move';
        lastX = e.clientX; lastY = e.clientY;
        element.setPointerCapture(e.pointerId);
      });
      element.addEventListener('pointerup', (e) => { dragging = null; element.releasePointerCapture(e.pointerId); });
      element.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        if (dragging === 'move') {
          // The ground under the pointer follows it: one screen height of drag
          // is the ground the screen shows, at this altitude.
          const metresPerPixel = (2 * altitude * Math.tan((FOV * Math.PI) / 360)) / height;
          const angle = metresPerPixel / PLANET_RADIUS;
          frame();
          const right = east.clone().multiplyScalar(Math.cos(heading)).addScaledVector(north, -Math.sin(heading));
          target.addScaledVector(right, -dx * angle).addScaledVector(forward, dy * angle).normalize();
        } else {
          heading += dx * 0.005;
          tiltBias = Math.min(0.6, Math.max(-1.2, tiltBias - dy * 0.004));
        }
        update();
      });
      element.addEventListener('wheel', (e) => {
        e.preventDefault();
        altitude = Math.min(MAX_ALTITUDE, Math.max(MIN_ALTITUDE, altitude * Math.pow(1.0015, e.deltaY)));
        update();
      }, { passive: false });
    },
  };
}
