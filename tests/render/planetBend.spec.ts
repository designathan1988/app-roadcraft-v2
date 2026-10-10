import { describe, expect, it } from 'vitest';
import { FACES, FACE_HALF, faceToSphereInto, type Vec3 } from '@core/cubeSphere';
import { atlasToFaceInto, faceCentre, type FaceLocal } from '@world/planet/atlas';
import { rehome } from '@render/planet/bend';

/** The heading an azimuth gives on the sphere at an atlas point (the camera's back, over the ground). */
function headingOnSphere(x: number, y: number, azimuth: number): Vec3 {
  const local: FaceLocal = { face: 0, x: 0, y: 0 };
  atlasToFaceInto(x, y, local);
  const s = faceToSphereInto(local.face, local.x, local.y, { x: 0, y: 0, z: 0 });
  const f = FACES[local.face]!;
  const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a.x * b.x + a.y * b.y + a.z * b.z;
  const e = { x: f.east.x - dot(f.east, s) * s.x, y: f.east.y - dot(f.east, s) * s.y, z: f.east.z - dot(f.east, s) * s.z };
  const l = Math.hypot(e.x, e.y, e.z);
  e.x /= l; e.y /= l; e.z /= l;
  const n = { x: s.y * e.z - s.z * e.y, y: s.z * e.x - s.x * e.z, z: s.x * e.y - s.y * e.x };
  // World (cos az, sin az) over x (east) and z (= -north).
  const east = Math.cos(azimuth), north = -Math.sin(azimuth);
  return { x: east * e.x + north * n.x, y: east * e.y + north * n.y, z: east * e.z + north * n.z };
}

describe('the view carried over a face border', () => {
  it('keeps its place and its heading on the sphere', () => {
    let worst = 0;
    for (let face = 0; face < 6; face++) {
      const c = faceCentre(face);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 0.4]] as const) {
        for (const az of [0, 1, 2.5, 4]) {
          const x = c.x + dx * (FACE_HALF + 30), y = c.y + dy * (FACE_HALF + 30) * (Math.abs(dy) < 1 ? 1 : 1);
          const moved = rehome(x, y);
          if (!moved) continue;
          const before = headingOnSphere(x, y, az);
          // The same ground before and after is checked by its own heading:
          // the heading at the new place with the turned azimuth.
          const after = headingOnSphere(moved.x, moved.y, az + moved.turn);
          const cos = before.x * after.x + before.y * after.y + before.z * after.z;
          worst = Math.max(worst, Math.acos(Math.min(1, cos)) * (180 / Math.PI));
        }
      }
    }
    expect(worst).toBeLessThan(0.5);
  });
});
