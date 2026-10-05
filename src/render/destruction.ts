import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';

import type { Building } from '@world/buildings/types';
import { levelElevation, localToWorld } from '@world/buildings/geometry';
import { resolveBlocks } from '@world/buildings/blocks';
import { FINISH_COLOUR } from '@world/buildings/materials';
import { m } from '@world/units';
import type { Exhaust } from './exhaust';
import { setHoles } from './buildings/damage';

/**
 * Buildings that break when struck (the player's order of 2026-10-05), done
 * as games do it (GMTK, "How Games Do Destruction"; Red Faction's collapse):
 *
 * - A blow opens a hole in the building where it lands: the building keeps its
 *   own look, cut by a sphere (`buildings/damage.ts`), the rooms behind
 *   showing; chunks of its walls fly out of the hole and a cloud of dust and a
 *   column of dark smoke rise from it.
 * - Once a good share of it is gone (`COLLAPSE_AT` of its volume), it comes
 *   down: the intact model is swapped for hundreds of pieces of its own
 *   colours, filling its shell, that fall from the bottom up - an implosion -
 *   under a billowing cloud that hides the swap, and leave a heap of rubble
 *   that lies a while and settles away.
 */

/** Share of a building's volume that, knocked out, brings it down. */
const COLLAPSE_AT = 0.22;
/** Debris pieces in flight or lying at once, map-wide. */
const MAX_DEBRIS = 6_000;
/** Seconds rubble lies before it sinks away. */
const RUBBLE_LIFE = 40;
const GRAVITY = m(9.8);
/** Edge of a collapse piece. */
const PIECE = m(1.4);

interface Hole { x: number; y: number; z: number; r: number; building: number }

interface Piece {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
  sx: number; sy: number; sz: number;
  r: number; g: number; b: number;
  /** Seconds before it starts to fall (a collapse goes from the bottom up). */
  delay: number;
  age: number;
  life: number;
  settled: boolean;
  ground: number;
}

export interface Destruction {
  readonly group: Group;
  /**
   * A blow on building `b` (its floor at `floor`) at world (x, y, z) with
   * `strength` 1..10. Returns true when the building came down: the caller
   * removes it from the map (its pieces are already falling).
   */
  hit(b: Building, floor: number, x: number, y: number, z: number, strength: number): boolean;
  update(dt: number): void;
  /** Forgets a building's holes (it was removed or rebuilt). */
  drop(id: number): void;
  dispose(): void;
}

function colours(b: Building): { wall: Color; roof: Color; trim: Color } {
  const spec = (slot: 'wall' | 'roof' | 'trim', fallback: number): Color => {
    const s = b.materials?.[slot] ?? b.volumes.find((v) => v.materials?.[slot === 'trim' ? 'wall' : slot])?.materials?.[slot === 'trim' ? 'wall' : slot];
    return new Color(s ? s.colour : fallback).convertSRGBToLinear();
  };
  return { wall: spec('wall', FINISH_COLOUR.plaster), roof: spec('roof', 0x7d4c3b), trim: spec('trim', 0xe8e4da) };
}

export function createDestruction(exhaust: Exhaust): Destruction {
  const group = new Group();
  group.name = 'destruction';
  const unit = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  const pieces: Piece[] = [];
  /** Things that happen a moment after a collapse starts: the dust clouds. */
  const later: { t: number; run: () => void }[] = [];
  const holes: Hole[] = [];
  /** Volume knocked out of each building so far, and its whole volume. */
  const damage = new Map<number, { gone: number; total: number }>();
  const debris = new InstancedMesh(unit, material, MAX_DEBRIS);
  debris.instanceMatrix.setUsage(DynamicDrawUsage);
  debris.count = 0;
  debris.castShadow = true;
  debris.receiveShadow = true;
  debris.frustumCulled = false;
  debris.name = 'destruction-debris';
  group.add(debris);
  const o = new Object3D();
  const tint = new Color();

  const add = (p: Omit<Piece, 'age' | 'settled' | 'rx' | 'ry' | 'rz'>): void => {
    if (pieces.length >= MAX_DEBRIS) pieces.splice(0, pieces.length - MAX_DEBRIS + 1);
    pieces.push({ ...p, age: 0, settled: false, rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6 });
  };

  /** The building's closed volumes in world terms: footprint corners, floor, top. */
  const shellOf = (b: Building) => resolveBlocks(b).volumes.filter((v) => !v.open).map((v) => ({
    v, z0: levelElevation(b, v.base), z1: levelElevation(b, v.base + v.storeys.length),
  }));

  const collapse = (b: Building, floor: number): void => {
    const { wall, roof, trim } = colours(b);
    const shells = shellOf(b);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, top = 0;
    for (const { v, z0, z1 } of shells) {
      top = Math.max(top, z1);
      // Pieces over the walls and the roof of each volume; a few inside (floors, rooms).
      const nx = Math.max(1, Math.round(v.w / PIECE)), ny = Math.max(1, Math.round(v.d / PIECE)), nz = Math.max(1, Math.round((z1 - z0) / PIECE));
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const edge = i === 0 || j === 0 || i === nx - 1 || j === ny - 1;
        const isRoof = k === nz - 1;
        const isFloor = k % 3 === 0;
        if (!edge && !isRoof && !(isFloor && Math.random() < 0.35)) continue;
        const lx = v.x + (i + 0.5) * (v.w / nx), ly = v.y + (j + 0.5) * (v.d / ny);
        const p = localToWorld(b, lx, ly);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        const z = floor + z0 + (k + 0.5) * ((z1 - z0) / nz);
        const c = isRoof ? roof : edge ? (Math.random() < 0.05 ? trim : wall) : new Color(0.55, 0.53, 0.5);
        const shade = 0.75 + Math.random() * 0.35;
        const s = PIECE * (0.6 + Math.random() * 0.7);
        // Implosion: the bottom goes first, the rest drops onto it.
        const delay = ((z - floor) / Math.max(1, top)) * 0.9 + Math.random() * 0.35;
        const cx = (minX + maxX) / 2 || p.x, cy = (minY + maxY) / 2 || p.y;
        add({
          x: p.x, y: p.y, z,
          vx: (cx - p.x) * 0.15 + (Math.random() - 0.5) * m(1.5), vy: (cy - p.y) * 0.15 + (Math.random() - 0.5) * m(1.5), vz: -Math.random() * m(1),
          wx: (Math.random() - 0.5) * 4, wy: (Math.random() - 0.5) * 4, wz: (Math.random() - 0.5) * 4,
          sx: s, sy: s * (0.4 + Math.random() * 0.6), sz: s * (0.5 + Math.random() * 0.7),
          r: c.r * shade, g: c.g * shade, b: c.b * shade,
          delay, life: RUBBLE_LIFE + Math.random() * 10, ground: floor,
        });
      }
    }
    // The cloud: concrete dust billowing out at the foot, rising with the fall.
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, span = Math.max(maxX - minX, maxY - minY) / 2 + m(4);
    // Released as the floors come down, not all at once, so the fall is seen.
    later.push({ t: 0.35, run: () => exhaust.burst(cx, cy, floor + m(1), 90, 3, span * 0.9, m(5), 6) });
    later.push({ t: 0.9, run: () => exhaust.burst(cx, cy, floor + m(2), 90, 3, span * 1.1, m(6), 6) });
    later.push({ t: 1.6, run: () => exhaust.burst(cx, cy, floor + top * 0.3, 50, 3, span * 0.8, m(7), 5) });
    later.push({ t: 1.0, run: () => exhaust.burst(cx, cy, floor + top * 0.3, 18, 2, span * 0.4, m(5), 7) });
  };

  const sync = (): void => setHoles(holes);

  return {
    group,
    hit(b, floor, x, y, z, strength) {
      const shells = shellOf(b);
      let d = damage.get(b.id);
      if (!d) {
        let total = 0;
        for (const { v, z0, z1 } of shells) total += v.w * v.d * (z1 - z0);
        d = { gone: 0, total: Math.max(1, total) };
        damage.set(b.id, d);
      }
      const r = m(1.0 + strength * 0.32);
      holes.push({ x, y, z, r, building: b.id });
      if (holes.length > 96) holes.shift();
      sync();
      // Roughly what the blow took out: the sphere, as much as is in the building.
      d.gone += (4 / 3) * Math.PI * r * r * r * 0.5;
      // Chunks of the wall it hit, thrown out of the hole; dust and smoke from it.
      const { wall, trim } = colours(b);
      const count = 18 + strength * 8;
      for (let n = 0; n < count; n++) {
        const a = Math.random() * Math.PI * 2, el = (Math.random() - 0.5) * 1.0;
        const speed = m(1.5 + strength * 0.55) * (0.4 + Math.random());
        const c = Math.random() < 0.06 ? trim : wall;
        const shade = 0.7 + Math.random() * 0.4;
        const s = m(0.25 + Math.random() * (0.4 + strength * 0.08));
        add({
          x: x + Math.cos(a) * r * 0.5, y: y + Math.sin(a) * r * 0.5, z: z + (Math.random() - 0.5) * r,
          vx: Math.cos(a) * Math.cos(el) * speed, vy: Math.sin(a) * Math.cos(el) * speed, vz: Math.sin(el) * speed + m(1),
          wx: (Math.random() - 0.5) * 12, wy: (Math.random() - 0.5) * 12, wz: (Math.random() - 0.5) * 12,
          sx: s, sy: s * (0.5 + Math.random() * 0.6), sz: s * (0.6 + Math.random() * 0.6),
          r: c.r * shade, g: c.g * shade, b: c.b * shade,
          delay: 0, life: RUBBLE_LIFE * 0.5, ground: floor,
        });
      }
      exhaust.burst(x, y, z, 14 + strength * 3, 3, r, m(2 + strength * 0.25), 3.5);
      exhaust.burst(x, y, z, 4 + strength, 2, r * 0.4, m(2.2), 5);
      if (d.gone / d.total >= COLLAPSE_AT) {
        collapse(b, floor);
        for (let i = holes.length - 1; i >= 0; i--) if (holes[i]!.building === b.id) holes.splice(i, 1);
        sync();
        damage.delete(b.id);
        return true;
      }
      return false;
    },
    update(dt) {
      for (let i = later.length - 1; i >= 0; i--) {
        const job = later[i]!;
        job.t -= dt;
        if (job.t <= 0) { later.splice(i, 1); job.run(); }
      }
      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i]!;
        if (p.delay > 0) { p.delay -= dt; continue; }
        p.age += dt;
        if (!p.settled) {
          p.vz -= GRAVITY * dt;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          p.rx += p.wx * dt; p.ry += p.wy * dt; p.rz += p.wz * dt;
          const lie = p.ground + p.sy / 2;
          if (p.z <= lie) {
            p.z = lie;
            if (p.vz < -m(3)) {
              // A bounce, losing most of it, and a puff where it lands hard.
              p.vz *= -0.2; p.vx *= 0.45; p.vy *= 0.45; p.wx *= 0.4; p.wy *= 0.4; p.wz *= 0.4;
              if (p.sx > m(1) && Math.random() < 0.08) exhaust.burst(p.x, p.y, p.ground, 2, 3, m(1), m(4), 4);
            } else {
              p.settled = true;
              p.vx = p.vy = p.vz = 0;
              // It comes to rest flat-ish, on one of its faces.
              p.rx = Math.round(p.rx / (Math.PI / 2)) * (Math.PI / 2) + (Math.random() - 0.5) * 0.3;
              p.rz = Math.round(p.rz / (Math.PI / 2)) * (Math.PI / 2) + (Math.random() - 0.5) * 0.3;
            }
          }
        }
        if (p.age > p.life) p.z -= dt * m(0.12);
        if (p.age > p.life + 12) pieces.splice(i, 1);
      }
      let n = 0;
      for (const p of pieces) {
        o.position.set(p.x, p.z, -p.y);
        o.rotation.set(p.rx, p.ry, p.rz);
        o.scale.set(p.sx, p.sy, p.sz);
        o.updateMatrix();
        debris.setMatrixAt(n, o.matrix);
        debris.setColorAt(n, tint.setRGB(p.r, p.g, p.b));
        n++;
      }
      debris.count = n;
      debris.instanceMatrix.needsUpdate = true;
      if (debris.instanceColor) debris.instanceColor.needsUpdate = true;
    },
    drop(id) {
      for (let i = holes.length - 1; i >= 0; i--) if (holes[i]!.building === id) holes.splice(i, 1);
      damage.delete(id);
      sync();
    },
    dispose() {
      debris.dispose();
      unit.dispose();
      material.dispose();
    },
  };
}
