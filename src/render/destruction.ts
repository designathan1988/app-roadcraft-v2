import { Group, Mesh, Vector3 } from 'three';

import type { Building } from '@world/buildings/types';
import { levelElevation, localToWorld } from '@world/buildings/geometry';
import { resolveBlocks } from '@world/buildings/blocks';
import { m } from '@world/units';
import type { Exhaust } from './exhaust';
import type { BuildingChunk } from './buildings/buildingMesh';
import type { BuildingKit } from './buildings/kit';
import { fractureBuilding, type Fragment } from './buildings/fracture';

/**
 * Buildings that break for real (the player's order of 2026-10-05): the
 * building's own meshes, pre-fractured into Voronoi fragments
 * (`buildings/fracture.ts`), stand in for it from the first blow - looking
 * exactly like it. A blow knocks the fragments within its reach out of the
 * building, thrown away from the impact; then every fragment no longer joined
 * to the ground through the others falls (the chunk graph's support check), so
 * a building cut low comes down on itself. Pieces tumble, land, settle as a
 * heap of the building's own walls, roof and floors, and sink away after a
 * while. Dust rises where pieces break off and where they land.
 */

const GRAVITY = m(9.8);
/** Seconds a settled piece lies before it sinks away. */
const RUBBLE_LIFE = 60;
/** Share of the fragments left standing below which the rest comes down. */
const COLLAPSE_BELOW = 0.35;

interface Piece {
  readonly fragment: Fragment;
  readonly mesh: Mesh;
  readonly floor: number;
  falling: boolean;
  settled: boolean;
  gone: boolean;
  v: Vector3;
  w: Vector3;
  age: number;
}

interface Ruin {
  readonly pieces: Piece[];
  readonly floor: number;
  standing: number;
}

export interface Destruction {
  readonly group: Group;
  /** Buildings now drawn as fragments here (and not by the building layer). */
  readonly ruined: ReadonlySet<number>;
  /**
   * A blow on building `b` (its floor at `floor`) at world (x, y, z), force
   * 1..10. Returns true when the building has come down.
   */
  hit(b: Building, floor: number, x: number, y: number, z: number, strength: number, eye?: Vector3): boolean;
  update(dt: number): void;
  dispose(): void;
}

export function createDestruction(
  exhaust: Exhaust,
  chunkOf: (b: Building) => { chunk: BuildingChunk; kit: BuildingKit } | null,
): Destruction {
  const group = new Group();
  group.name = 'destruction';
  const ruins = new Map<number, Ruin>();
  const ruined = new Set<number>();
  const loose: Piece[] = [];

  const make = (b: Building, floor: number): Ruin | null => {
    const source = chunkOf(b);
    if (!source) return null;
    // Floor slabs inside every volume, storey by storey.
    const slabs: { corners: Vector3[]; y: number }[] = [];
    for (const v of resolveBlocks(b).volumes) {
      if (v.open) continue;
      const corners = [[v.x, v.y], [v.x + v.w, v.y], [v.x + v.w, v.y + v.d], [v.x, v.y + v.d]].map(([lx, ly]) => {
        const p = localToWorld(b, lx!, ly!);
        return new Vector3(p.x, 0, -p.y);
      });
      for (let level = v.base + 1; level < v.base + v.storeys.length; level++) slabs.push({ corners, y: floor + levelElevation(b, level) });
    }
    const fragments = fractureBuilding(source.chunk, source.kit, slabs, b.id * 2654435761);
    const pieces: Piece[] = fragments.map((fragment) => {
      const mesh = new Mesh(fragment.geometry, fragment.materials);
      mesh.position.copy(fragment.centre);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return { fragment, mesh, floor, falling: false, settled: false, gone: false, v: new Vector3(), w: new Vector3(), age: 0 };
    });
    return { pieces, floor, standing: pieces.length };
  };

  const release = (ruin: Ruin, piece: Piece, from: Vector3, power: number): void => {
    if (piece.falling) return;
    piece.falling = true;
    ruin.standing--;
    const away = piece.mesh.position.clone().sub(from);
    const d = away.length() || 1;
    away.divideScalar(d);
    piece.v.copy(away).multiplyScalar(power * (0.5 + Math.random() * 0.6));
    piece.v.y += power * 0.25 * Math.random();
    piece.w.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3).multiplyScalar(0.4 + power / m(10));
    loose.push(piece);
    // Dust where it breaks off.
    if (Math.random() < 0.5) {
      const p = piece.mesh.position;
      exhaust.burst(p.x, -p.z, p.y, 3, 3, piece.fragment.radius * 0.6, m(2.5), 3.5);
    }
  };

  /** Every standing piece not joined to the ground through standing pieces. */
  const unsupported = (ruin: Ruin): Piece[] => {
    const held = new Uint8Array(ruin.pieces.length);
    const stack: number[] = [];
    ruin.pieces.forEach((p, i) => {
      if (!p.falling && p.fragment.low <= ruin.floor + m(0.6)) { held[i] = 1; stack.push(i); }
    });
    while (stack.length) {
      const i = stack.pop()!;
      for (const j of ruin.pieces[i]!.fragment.neighbours) {
        if (!held[j] && !ruin.pieces[j]!.falling) { held[j] = 1; stack.push(j); }
      }
    }
    return ruin.pieces.filter((p, i) => !p.falling && !held[i]);
  };

  return {
    group,
    ruined,
    hit(b, floor, x, y, z, strength, eye) {
      let ruin = ruins.get(b.id);
      if (!ruin) {
        const made = make(b, floor);
        if (!made) return false;
        ruin = made;
        ruins.set(b.id, ruin);
        ruined.add(b.id);
      }
      let impact = new Vector3(x, z, -y);
      // Once broken, the blow lands on the first standing piece along the line
      // of sight through the point: what is left of the building, not the air
      // where the rest of it was.
      if (eye) {
        // `eye` is the camera's looking direction (an orthographic camera's rays are parallel).
        const dir = eye.clone().normalize();
        eye = impact.clone().addScaledVector(dir, -m(2000));
        let best: Vector3 | null = null, bestT = Infinity;
        const to = new Vector3();
        for (const p of ruin.pieces) {
          if (p.falling) continue;
          to.copy(p.mesh.position).sub(eye);
          const t = to.dot(dir);
          if (t <= 0) continue;
          const off = to.clone().addScaledVector(dir, -t).length();
          if (off < p.fragment.radius * 0.8 + m(1.5) && t < bestT) { bestT = t; best = p.mesh.position.clone(); }
        }
        // Nothing on the line: the standing piece nearest the point aimed at.
        if (!best) {
          let bd = Infinity;
          for (const p of ruin.pieces) {
            if (p.falling || p.fragment.centre.y < floor + m(0.6)) continue;
            const d = p.mesh.position.distanceTo(impact);
            if (d < bd) { bd = d; best = p.mesh.position.clone(); }
          }
        }
        if (best) impact = best;
      }
      const reach = m(1.4 + strength * 0.55);
      const power = m(2 + strength * 1.1);
      for (const piece of ruin.pieces) {
        if (piece.falling) continue;
        const d = piece.mesh.position.distanceTo(impact) - piece.fragment.radius * 0.5;
        if (d < reach) release(ruin, piece, impact, power * Math.max(0.3, 1 - d / reach));
      }
      exhaust.burst(impact.x, -impact.z, impact.y, 10 + strength * 2, 3, reach * 0.6, m(2.5 + strength * 0.2), 4);
      // What hangs on nothing now comes down: it falls, it is not thrown.
      for (const piece of unsupported(ruin)) release(ruin, piece, piece.mesh.position.clone().add(new Vector3(0, m(1), 0)), m(0.5));
      // Counted over what stands above the ground: the lot's paving and the
      // plinth are never knocked down by blows above them.
      const upper = ruin.pieces.filter((p) => p.fragment.centre.y > floor + m(0.6));
      if (upper.filter((p) => !p.falling).length < upper.length * COLLAPSE_BELOW) {
        for (const piece of ruin.pieces) {
          // What lies on the ground (the lot's paving, the plinth) stays as it
          // is, and goes with the rubble later.
          if (piece.fragment.centre.y < floor + m(0.6)) {
            if (!piece.falling) { piece.falling = true; piece.settled = true; ruin.standing--; loose.push(piece); }
          } else release(ruin, piece, impact, m(0.6));
        }
        exhaust.burst(x, y, floor, 60, 3, m(10), m(5), 6);
        return true;
      }
      return false;
    },
    update(dt) {
      for (let i = loose.length - 1; i >= 0; i--) {
        const p = loose[i]!;
        const mesh = p.mesh;
        p.age += dt;
        if (!p.settled) {
          p.v.y -= GRAVITY * dt;
          mesh.position.addScaledVector(p.v, dt);
          mesh.rotation.x += p.w.x * dt; mesh.rotation.y += p.w.y * dt; mesh.rotation.z += p.w.z * dt;
          const rest = p.floor + p.fragment.radius * 0.3;
          if (mesh.position.y <= rest) {
            mesh.position.y = rest;
            if (p.v.y < -m(3)) {
              p.v.multiplyScalar(0.3); p.v.y = Math.abs(p.v.y) * 0.5; p.w.multiplyScalar(0.4);
              if (p.fragment.radius > m(1.2) && Math.random() < 0.3) exhaust.burst(mesh.position.x, -mesh.position.z, p.floor, 3, 3, m(1.5), m(3), 4);
            } else {
              p.settled = true;
              p.v.set(0, 0, 0);
              p.age = 0;
            }
          }
        } else if (p.age > RUBBLE_LIFE) {
          mesh.position.y -= dt * m(0.15);
          if (p.age > RUBBLE_LIFE + 15) {
            group.remove(mesh);
            p.gone = true;
            loose.splice(i, 1);
          }
        }
      }
      // A ruin whose pieces are all gone is forgotten; its geometry is released.
      for (const [id, ruin] of ruins) {
        if (!ruin.pieces.every((p) => p.gone)) continue;
        for (const p of ruin.pieces) p.fragment.geometry.dispose();
        ruins.delete(id);
        ruined.delete(id);
      }
    },
    dispose() {
      for (const ruin of ruins.values()) for (const p of ruin.pieces) p.fragment.geometry.dispose();
      group.clear();
    },
  };
}
