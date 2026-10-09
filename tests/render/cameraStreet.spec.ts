import { describe, expect, it } from 'vitest';

import { DEFAULT_ELEVATION, MAX_HALF_HEIGHT, MIN_HALF_HEIGHT, createIsoRig } from '@render/isoViewport';
import { EYE_HEIGHT, FAR_TILT, NEAR_MIN_TILT, minTilt, profileTilt } from '@view/cameraProfile';

/**
 * The perspective camera from the overview down to the street (the player,
 * 2026-10-09: "descer mais a vista e não travar"): the tilt follows the zoom
 * continuously, the camera reaches a pedestrian's view, never goes under the
 * ground and never jumps between two steps of the wheel.
 */
const W = 1280;
const H = 720;

function perspective(ground = (_x: number, _y: number) => 0, half = 400) {
  const r = createIsoRig({ x: 0, y: 0 }, half);
  r.resize(W, H);
  r.setGround(ground);
  r.setPerspective(true);
  return r;
}

const hills = (x: number, y: number): number => 8 * Math.sin(x / 90) * Math.cos(y / 70) + 20;

describe('camera from the overview to the street', () => {
  it('keeps the game\'s tilt far away and eases to nearly level close up', () => {
    expect(profileTilt(MAX_HALF_HEIGHT)).toBeCloseTo(FAR_TILT, 9);
    expect(profileTilt(MIN_HALF_HEIGHT)).toBeLessThan((10 * Math.PI) / 180);
    expect(minTilt(MIN_HALF_HEIGHT)).toBeCloseTo(NEAR_MIN_TILT, 9);
  });

  it('the wheel walks from the overview to a pedestrian view with no jump in tilt or eye', () => {
    const r = perspective(hills);
    const v = r.viewport;
    expect(v.elevation).toBeCloseTo(DEFAULT_ELEVATION, 6);
    let last = v.eye!;
    let lastTilt = v.elevation;
    for (let i = 0; i < 120; i++) {
      v.zoomAt(W / 2, H / 2, 1.06, W, H, hills(v.centre.x, v.centre.y));
      const eye = v.eye!;
      // No jump: each notch moves the eye a share of its distance, the tilt a few degrees.
      const step = Math.hypot(eye.x - last.x, eye.y - last.y, eye.z - last.z);
      const range = Math.hypot(last.x - v.centre.x, last.y - v.centre.y, last.z - hills(v.centre.x, v.centre.y));
      expect(step).toBeLessThan(range * 0.25 + 1);
      expect(Math.abs(v.elevation - lastTilt)).toBeLessThan((4 * Math.PI) / 180);
      // Never under the ground.
      expect(eye.z).toBeGreaterThan(hills(eye.x, eye.y));
      last = eye;
      lastTilt = v.elevation;
    }
    // A person's view: eyes at about 1.7-2.5 m over the ground, looking almost level.
    const eye = v.eye!;
    const over = eye.z - hills(eye.x, eye.y);
    expect(over).toBeGreaterThan(EYE_HEIGHT * 0.8);
    expect(over).toBeLessThan(EYE_HEIGHT * 1.6);
    expect(v.elevation).toBeLessThan((10 * Math.PI) / 180);
  });

  it('tilts below level close up to look up at a facade, and never puts the eye under the ground', () => {
    const r = perspective(() => 0, MIN_HALF_HEIGHT);
    const v = r.viewport;
    v.orbit(0, -2);
    expect(v.elevation).toBeCloseTo(NEAR_MIN_TILT, 6);
    expect(v.eye!.z).toBeGreaterThanOrEqual(4 - 1e-9);
    v.orbit(0, 5);
    expect(v.elevation).toBeCloseTo(Math.PI / 2, 6);
  });

  it('turns a full circle at street level', () => {
    const r = perspective(() => 0, MIN_HALF_HEIGHT);
    const v = r.viewport;
    const c = v.centre;
    for (let i = 0; i < 24; i++) {
      v.orbit(Math.PI / 12, 0);
      expect(Math.hypot(v.centre.x - c.x, v.centre.y - c.y)).toBeLessThan(1e-9);
    }
  });

  it('zooms on past the closest view as a walk towards the pointer', () => {
    const r = perspective(() => 0, MIN_HALF_HEIGHT);
    const v = r.viewport;
    const c = v.centre;
    v.zoomAt(W / 2, H / 2 + 100, 1.5, W, H, 0);
    const moved = Math.hypot(v.centre.x - c.x, v.centre.y - c.y);
    expect(moved).toBeGreaterThan(0.5);
    expect(moved).toBeLessThan(10);
    expect(v.zoom).toBeCloseTo(H / (MIN_HALF_HEIGHT * 2), 9);
  });

  it('a pointer over the horizon zooms without throwing the view across the map', () => {
    const r = perspective(() => 0, 6);
    const v = r.viewport;
    v.orbit(0, -1);
    const c = v.centre;
    v.zoomAt(W / 2, 5, 0.8, W, H, 0);
    expect(Math.hypot(v.centre.x - c.x, v.centre.y - c.y)).toBeLessThan(5);
  });

  it('is lifted out of a building smoothly, never blocked', () => {
    const r = perspective(() => 0, MIN_HALF_HEIGHT);
    // A smooth floor: 40 high inside a 20 x 20 box, falling to nothing 3 units outside.
    r.setSolids((x, y) => {
      const d = Math.max(Math.abs(x) - 10, Math.abs(y) - 10, 0);
      const t = Math.max(0, 1 - d / 3);
      return 42 * t * t * (3 - 2 * t);
    });
    const v = r.viewport;
    // Facing +x on the map.
    v.setOrbit(Math.PI, DEFAULT_ELEVATION);
    v.moveTo({ x: -30, y: 0 });
    let lastZ = v.eye!.z;
    let inside = 0;
    for (let i = 0; i < 120; i++) {
      v.slide(0, 0.5);
      const eye = v.eye!;
      if (Math.abs(eye.x) < 10 && Math.abs(eye.y) < 10) {
        inside++;
        expect(eye.z).toBeGreaterThanOrEqual(42 - 1e-6);
      }
      expect(Math.abs(eye.z - lastZ)).toBeLessThan(15);
      lastZ = eye.z;
    }
    // It went through, over the roof: nothing stopped it.
    expect(inside).toBeGreaterThan(10);
    expect(v.centre.x).toBeGreaterThan(25);
  });
});
