import { BoxGeometry, Color, Group, InstancedMesh, type Material, MeshStandardMaterial, Object3D } from 'three';

import type { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import type { TrainView } from '@sim/transit/transit';

/**
 * Public transport on screen (`world/transit.ts`, `sim/transit/transit.ts`):
 * the train's tracks on their ballast with sleepers and two rails; its
 * stations, a platform beside the track under a canopy; the metro's
 * entrances (its tracks and trains run under the ground and are not drawn);
 * bus stops, a shelter and a sign in the colour of the first line that calls
 * there, a terminal's longer; and the trains, their cars in their line's
 * colour, moved every frame.
 *
 * Every piece is a unit box, instanced, as the walls and fences are
 * (`barriers.ts`).
 */
export interface TransitMeshes {
  readonly group: Group;
  readonly triangles: number;
  /** The trains where the simulation has them now. */
  update(trains: readonly TrainView[], groundAt: (x: number, y: number) => number): void;
  dispose(): void;
}

interface Box { x: number; y: number; z: number; yaw: number; length: number; width: number; height: number; colour?: string }

const SLEEPER_STEP = m(0.7);
/** Length of the pieces a track is laid in, each on what is under it. */
const PIECE = m(4);
const GAUGE = m(1.435);
/** Most trains' cars drawn at once. */
const MAX_CARS = 256;
const CAR = { length: m(17.5), width: m(2.9), height: m(3.6) };

export function buildTransit(doc: RoadDoc, groundAt: (x: number, y: number) => number,
  pavedAt: (x: number, y: number) => number = () => NaN): TransitMeshes {
  const group = new Group();
  group.name = 'transit';
  const t = doc.transit;
  const ballast: Box[] = [], sleepers: Box[] = [], rails: Box[] = [], platforms: Box[] = [], roofs: Box[] = [],
    posts: Box[] = [], signs: Box[] = [], glass: Box[] = [];
  const along = (ax: number, ay: number, bx: number, by: number): { len: number; yaw: number; cx: number; cy: number; ux: number; uy: number } => {
    const len = Math.hypot(bx - ax, by - ay);
    // three's yaw turns about +y, with world y as -z.
    return { len, yaw: Math.atan2(by - ay, bx - ax), cx: (ax + bx) / 2, cy: (ay + by) / 2, ux: (bx - ax) / (len || 1), uy: (by - ay) / (len || 1) };
  };
  // In pieces, each laid on what is under it: over open ground on its
  // ballast and sleepers; across a street (a level crossing) the rails alone,
  // flush with the paving.
  for (const track of t.tracks) {
    if (track.mode !== 'train') continue;
    for (let i = 1; i < track.points.length; i++) {
      const a = track.points[i - 1]!, b = track.points[i]!;
      const s = along(a.x, a.y, b.x, b.y);
      if (s.len < 1e-3) continue;
      const pieces = Math.max(1, Math.ceil(s.len / PIECE));
      const piece = s.len / pieces;
      for (let k = 0; k < pieces; k++) {
        const d0 = k * piece, cx = a.x + s.ux * (d0 + piece / 2), cy = a.y + s.uy * (d0 + piece / 2);
        const paved = pavedAt(cx, cy);
        const crossing = Number.isFinite(paved);
        const z = crossing ? paved : groundAt(cx, cy);
        if (!crossing) {
          ballast.push({ x: cx, y: cy, z: z - m(0.05), yaw: s.yaw, length: piece + m(0.05), width: m(3.4), height: m(0.3) });
          for (let d = d0 + SLEEPER_STEP / 2; d < d0 + piece; d += SLEEPER_STEP) {
            sleepers.push({ x: a.x + s.ux * d, y: a.y + s.uy * d, z: z + m(0.25), yaw: s.yaw + Math.PI / 2, length: m(2.6), width: m(0.24), height: m(0.15) });
          }
        }
        for (const side of [-1, 1]) {
          rails.push({ x: cx - s.uy * side * GAUGE / 2, y: cy + s.ux * side * GAUGE / 2, z: z + (crossing ? m(0.01) : m(0.4)), yaw: s.yaw,
            length: piece + m(0.02), width: m(0.08), height: crossing ? m(0.04) : m(0.15) });
        }
      }
    }
  }
  const colourAt = (stop: number): string => t.lines.find((l) => l.stops.includes(stop))?.colour ?? '#2f7de1';
  for (let s of t.stops) {
    const z = groundAt(s.x, s.y);
    const colour = colourAt(s.id);
    if (s.mode === 'train') {
      // Along the track there: the platform beside it, under its canopy.
      const track = t.tracks.find((k) => k.id === s.track);
      let yaw = 0;
      if (track) {
        let best = Infinity;
        for (let i = 1; i < track.points.length; i++) {
          const a = track.points[i - 1]!, b = track.points[i]!;
          const d = Math.hypot((a.x + b.x) / 2 - s.x, (a.y + b.y) / 2 - s.y);
          if (d < best) { best = d; yaw = Math.atan2(b.y - a.y, b.x - a.x); }
        }
      }
      const nx = -Math.sin(yaw), ny = Math.cos(yaw);
      const off = m(3.6);
      const px = s.x + nx * off, py = s.y + ny * off;
      platforms.push({ x: px, y: py, z, yaw, length: m(60), width: m(4), height: m(1.0) });
      for (const k of [-24, -12, 0, 12, 24]) {
        posts.push({ x: px + Math.cos(yaw) * m(k), y: py + Math.sin(yaw) * m(k), z: z + m(1), yaw, length: m(0.2), width: m(0.2), height: m(3) });
      }
      roofs.push({ x: px, y: py, z: z + m(4), yaw, length: m(56), width: m(4.4), height: m(0.25) });
      signs.push({ x: px + nx * m(1.8), y: py + ny * m(1.8), z: z + m(2.6), yaw, length: m(2.4), width: m(0.1), height: m(0.7), colour });
      continue;
    }
    if (s.mode === 'metro') {
      // The way down: a glazed entrance with the sign of the line.
      glass.push({ x: s.x, y: s.y, z, yaw: 0, length: m(4), width: m(2.6), height: m(2.6) });
      roofs.push({ x: s.x, y: s.y, z: z + m(2.6), yaw: 0, length: m(4.4), width: m(3), height: m(0.2) });
      posts.push({ x: s.x + m(2.6), y: s.y, z, yaw: 0, length: m(0.12), width: m(0.12), height: m(3.4) });
      signs.push({ x: s.x + m(2.6), y: s.y, z: z + m(3.4), yaw: 0, length: m(0.9), width: m(0.9), height: m(0.9), colour });
      continue;
    }
    // A bus stop: a shelter on two posts along the street, its glass at the
    // back (away from the road), a pole with the sign at its end.
    const seg = s.segment !== undefined ? doc.segments.get(s.segment) : undefined;
    const na = seg ? doc.nodes.get(seg.a) : undefined, nb = seg ? doc.nodes.get(seg.b) : undefined;
    let yaw = 0, bx = 0, by = 1;
    if (na && nb) {
      yaw = Math.atan2(nb.y - na.y, nb.x - na.x);
      const ux = Math.cos(yaw), uy = Math.sin(yaw);
      const u = (s.x - na.x) * ux + (s.y - na.y) * uy;
      const cx = na.x + ux * u, cy = na.y + uy * u, d = Math.hypot(s.x - cx, s.y - cy) || 1;
      bx = (s.x - cx) / d; by = (s.y - cy) / d;
    }
    const long = s.terminal ? m(9) : m(3.2);
    const ux = Math.cos(yaw), uy = Math.sin(yaw);
    // At the kerb, as a shelter stands, clear of the shop awnings over the
    // footway: from the stop (the middle of the footway) towards the road.
    const kx = s.x - bx * m(0.9), ky = s.y - by * m(0.9);
    s = { ...s, x: kx, y: ky };
    for (const k of [-1, 1]) {
      posts.push({ x: s.x + ux * k * (long / 2 - m(0.2)) + bx * m(0.5), y: s.y + uy * k * (long / 2 - m(0.2)) + by * m(0.5),
        z: z + m(0.15), yaw, length: m(0.1), width: m(0.1), height: m(2.4) });
    }
    roofs.push({ x: s.x + bx * m(0.2), y: s.y + by * m(0.2), z: z + m(2.55), yaw, length: long, width: m(1.6), height: m(0.12) });
    glass.push({ x: s.x + bx * m(0.75), y: s.y + by * m(0.75), z: z + m(0.15), yaw, length: long, width: m(0.06), height: m(2.1) });
    posts.push({ x: s.x + ux * (long / 2 + m(0.6)), y: s.y + uy * (long / 2 + m(0.6)), z: z + m(0.15), yaw, length: m(0.08), width: m(0.08), height: m(2.8) });
    signs.push({ x: s.x + ux * (long / 2 + m(0.6)), y: s.y + uy * (long / 2 + m(0.6)), z: z + m(2.6), yaw, length: m(0.6), width: m(0.05), height: m(0.6), colour });
  }

  const unit = new BoxGeometry(1, 1, 1);
  const materials: Material[] = [];
  const material = (colour: number, roughness: number, metalness = 0, opacity = 1): MeshStandardMaterial => {
    const mat = new MeshStandardMaterial({ color: colour, roughness, metalness, transparent: opacity < 1, opacity });
    materials.push(mat);
    return mat;
  };
  const o = new Object3D();
  const place = (b: Box): void => {
    o.position.set(b.x, b.z + b.height / 2, -b.y);
    o.rotation.set(0, b.yaw, 0);
    o.scale.set(b.length, b.height, b.width);
    o.updateMatrix();
  };
  let triangles = 0;
  const add = (name: string, boxes: readonly Box[], mat: Material, coloured = false): void => {
    if (boxes.length === 0) return;
    const mesh = new InstancedMesh(unit, mat, boxes.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const c = new Color();
    boxes.forEach((b, i) => {
      place(b);
      mesh.setMatrixAt(i, o.matrix);
      if (coloured) mesh.setColorAt(i, c.set(b.colour ?? '#ffffff'));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
    triangles += boxes.length * 12;
  };
  add('transit-ballast', ballast, material(0x7d776e, 0.95));
  add('transit-sleepers', sleepers, material(0x5b4636, 0.9));
  add('transit-rails', rails, material(0x9aa0a6, 0.35, 0.8));
  add('transit-platforms', platforms, material(0xbdb6aa, 0.9));
  add('transit-roofs', roofs, material(0x3f4a52, 0.6, 0.2));
  add('transit-posts', posts, material(0x2e3438, 0.5, 0.6));
  add('transit-glass', glass, material(0xa9c7d6, 0.1, 0.1, 0.45));
  add('transit-signs', signs, material(0xffffff, 0.5), true);

  // The trains: one box per car, moved each frame, in their line's colour.
  const cars = new InstancedMesh(unit, material(0xffffff, 0.45, 0.3), MAX_CARS);
  cars.name = 'transit-trains';
  cars.castShadow = true;
  // Its instances move all over the map: the bounds of the one unit box at the
  // origin would cull them all whenever the camera is elsewhere.
  cars.frustumCulled = false;
  cars.count = 0;
  group.add(cars);
  const tint = new Color();
  return {
    group,
    triangles,
    update(trains, ground) {
      let n = 0;
      for (const train of trains) {
        if (train.metro) continue;
        tint.set(train.colour);
        for (const car of train.cars) {
          if (n >= MAX_CARS) break;
          place({ x: car.x, y: car.y, z: ground(car.x, car.y) + m(0.55), yaw: car.heading, length: CAR.length, width: CAR.width, height: CAR.height });
          cars.setMatrixAt(n, o.matrix);
          cars.setColorAt(n, tint);
          n++;
        }
      }
      cars.count = n;
      cars.instanceMatrix.needsUpdate = true;
      if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
    },
    dispose() {
      unit.dispose();
      for (const mat of materials) mat.dispose();
    },
  };
}
