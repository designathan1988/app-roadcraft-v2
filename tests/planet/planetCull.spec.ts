import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, Sphere, Vector3 } from 'three';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, toOwner } from '@world/planet/charts';
import { anchorPlanet, installPlanet, planetEye, planetSphereInView } from '@render/planet/bend';

/**
 * WHAT IS CULLED ONE BY ONE ON THE PLANET (`render/planet/bend.ts`
 * planetSphereInView: the plants' and the street furniture's instances, the
 * grass, each vehicle and person). Run with `vitest.planet.config.ts`.
 *
 * Their spheres were tested as the world is built, flat: a thing kept on the
 * chart of the next piece lies 1 600 units or more from the one looked from
 * in the flat world, out of every frustum - benches, lamps, trees and cars
 * across a border were never drawn.
 */

describe('culling where the planet draws a thing', () => {
  it('keeps what stands across a border in view, and drops what is round the back', () => {
    installPlanet();
    // Over an edge of the cube: west of the second piece of face 3.
    const chart = 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1;
    const c = tileCentre(chart);
    const look = toOwner(chart, { x: c.x - 200, y: c.y });
    const across = toOwner(chart, { x: c.x - 290, y: c.y + 5 });
    expect(chartAt(across.x, across.y)).not.toBe(chartAt(look.x, look.y));
    anchorPlanet(look.x, -look.y);
    const camera = new PerspectiveCamera(50, 16 / 9, 0.5, 20000);
    // Up over the place looked at, looking west along the ground to the border.
    camera.position.set(look.x + 40, 60, -look.y);
    camera.lookAt(look.x - 60, 0, -look.y);
    camera.updateMatrixWorld();
    planetEye(camera.position);
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const near = new Sphere(new Vector3(across.x, 1, -across.y), 1);
    // As it stands in the flat world it is out of view...
    expect(frustum.intersectsSphere(near)).toBe(false);
    // ...and where the planet draws it, in.
    expect(planetSphereInView(frustum, near)).toBe(true);
    // The far side of the planet is behind the horizon, whatever the frustum says.
    const opposite = 5 * TILES_PER_SIDE * TILES_PER_SIDE + 6 * TILES_PER_SIDE + 6;
    const back = tileCentre(opposite);
    expect(planetSphereInView(frustum, new Sphere(new Vector3(back.x, 1, -back.y), 1))).toBe(false);
  });
});
