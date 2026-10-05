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
import { m } from '@world/units';
import type { Exhaust } from './exhaust';

/**
 * Buildings that break when struck (the player's order of 2026-10-05).
 *
 * The approach of grid-destruction games (Teardown; GMTK, "How Games Do
 * Destruction"): the first blow turns the building into a grid of blocks, its
 * shell on the outside, floor slabs and interior walls inside. Each blow
 * knocks out the blocks within its reach and throws them as debris; any block
 * left with no path down to the ground through the others falls too (a
 * support check, as Red Faction's collapse), so a building hit low comes down
 * on itself. Debris tumbles under gravity, bounces once and settles, then
 * sinks away after a while so it never piles past the frame budget. Dust and
 * smoke rise from every break. Once most of it is down, the rest collapses and
 * the building is gone.
 */

/** Edge of one block, world units (1.2 m). */
const CELL = m(1.2);
/** Blocks a building may have; larger ones use bigger blocks. */
const MAX_CELLS = 24_000;
/** Debris pieces in flight or lying at once, map-wide. */
const MAX_DEBRIS = 2_500;
/** Seconds a settled piece lies before it sinks away. */
const DEBRIS_LIFE = 14;
const GRAVITY = m(9.8);

interface Ruin {
  readonly building: Building;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cell: number;
  readonly cellZ: number;
  readonly base: number;
  /** 0 empty, 1 shell, 2 floor slab, 3 interior wall, 4 roof. */
  readonly kind: Uint8Array;
  readonly colour: Float32Array;
  readonly total: number;
  left: number;
  dirty: boolean;
  mesh: InstancedMesh | null;
}

interface Piece {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
  size: number;
  r: number; g: number; b: number;
  age: number;
  settled: boolean;
  /** The ground it lands on: the floor of the building it came from. */
  ground: number;
}

export interface Destruction {
  readonly group: Group;
  /** Whether a building is a ruin drawn here (and so not by the building layer). */
  readonly ruined: ReadonlySet<number>;
  /**
   * A blow on building `b` at world (x, y, z) with `strength` (1 light .. 10
   * a wrecking ball). Returns true when the building has come down completely.
   */
  hit(b: Building, floor: number, x: number, y: number, z: number, strength: number): boolean;
  /** Advances the debris; call once a frame. */
  update(dt: number): void;
  /** Forgets a ruin (its building was removed or replaced). */
  drop(id: number): void;
  dispose(): void;
}

export function createDestruction(exhaust: Exhaust): Destruction {
  const group = new Group();
  group.name = 'destruction';
  const unit = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  const ruins = new Map<number, Ruin>();
  const ruined = new Set<number>();
  const pieces: Piece[] = [];
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

  const make = (b: Building, floor: number): Ruin => {
    const resolved = resolveBlocks(b);
    const closed = resolved.volumes.filter((v) => !v.open);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, top = 0;
    for (const v of closed) {
      x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x + v.w); y1 = Math.max(y1, v.y + v.d);
      top = Math.max(top, levelElevation(b, v.base + v.storeys.length));
    }
    let cell = CELL;
    while (((x1 - x0) / cell) * ((y1 - y0) / cell) * (top / cell) > MAX_CELLS) cell *= 1.25;
    const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), ny = Math.max(1, Math.ceil((y1 - y0) / cell));
    const storey = levelElevation(b, 1) || m(3);
    // Vertical cells a whole number per storey, so slabs fall on the floors.
    const perStorey = Math.max(1, Math.round(storey / cell));
    const cellZ = storey / perStorey;
    const nz = Math.max(1, Math.ceil(top / cellZ));
    const kind = new Uint8Array(nx * ny * nz);
    const colour = new Float32Array(nx * ny * nz * 3);
    const wall = new Color(b.materials?.wall?.colour ?? 0xd8cfc0);
    const slab = new Color(0x9c9890), inner = new Color(0xe6e0d4), roofC = new Color(b.materials?.roof?.colour ?? 0x7a4f3d);
    let total = 0;
    const idx = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const lx = x0 + (i + 0.5) * cell, ly = y0 + (j + 0.5) * cell, lz = (k + 0.5) * cellZ;
      const v = closed.find((q) => lx >= q.x && lx <= q.x + q.w && ly >= q.y && ly <= q.y + q.d &&
        lz >= levelElevation(b, q.base) && lz <= levelElevation(b, q.base + q.storeys.length));
      if (!v) continue;
      const vTop = levelElevation(b, v.base + v.storeys.length);
      const edge = lx - v.x < cell || v.x + v.w - lx < cell || ly - v.y < cell || v.y + v.d - ly < cell;
      const roof = vTop - lz < cellZ;
      const onFloor = k % perStorey === 0;
      // Interior walls on a coarse grid, so rooms show when the shell opens.
      const partition = !edge && (i % 5 === 0 || j % 4 === 0);
      const kd = roof ? 4 : edge ? 1 : onFloor ? 2 : partition ? 3 : 0;
      if (kd === 0) continue;
      const n = idx(i, j, k);
      kind[n] = kd;
      const c = kd === 1 ? wall : kd === 2 ? slab : kd === 3 ? inner : roofC;
      const shade = 0.9 + ((i * 7 + j * 13 + k * 17) % 10) / 50;
      colour[n * 3] = c.r * shade; colour[n * 3 + 1] = c.g * shade; colour[n * 3 + 2] = c.b * shade;
      total++;
    }
    return { building: b, nx, ny, nz, cell, cellZ, base: floor, kind, colour, total, left: total, dirty: true, mesh: null };
  };

  const worldOf = (r: Ruin, i: number, j: number, k: number): { x: number; y: number; z: number } => {
    const resolved = r.building;
    let x0 = Infinity, y0 = Infinity;
    for (const v of resolveBlocks(resolved).volumes) if (!v.open) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); }
    const p = localToWorld(resolved, x0 + (i + 0.5) * r.cell, y0 + (j + 0.5) * r.cell);
    return { x: p.x, y: p.y, z: r.base + (k + 0.5) * r.cellZ };
  };

  const throwPiece = (x: number, y: number, z: number, from: { x: number; y: number; z: number }, power: number, size: number, c: [number, number, number], ground: number): void => {
    if (pieces.length >= MAX_DEBRIS) pieces.shift();
    const dx = x - from.x, dy = y - from.y, dz = z - from.z, d = Math.hypot(dx, dy, dz) || 1;
    const speed = power * (0.4 + Math.random() * 0.8);
    pieces.push({
      x, y, z,
      vx: (dx / d) * speed + (Math.random() - 0.5) * m(2), vy: (dy / d) * speed + (Math.random() - 0.5) * m(2), vz: (dz / d) * speed * 0.5 + Math.random() * m(2),
      rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
      wx: (Math.random() - 0.5) * 8, wy: (Math.random() - 0.5) * 8, wz: (Math.random() - 0.5) * 8,
      size: size * (0.55 + Math.random() * 0.5), r: c[0], g: c[1], b: c[2], age: 0, settled: false, ground,
    });
  };

  /** Drops every block with no path to the ground through other blocks. */
  const unsupported = (r: Ruin): number[] => {
    const { nx, ny, nz, kind } = r;
    const seen = new Uint8Array(kind.length);
    const stack: number[] = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const n = j * nx + i; if (kind[n]) { seen[n] = 1; stack.push(n); } }
    while (stack.length) {
      const n = stack.pop()!;
      const i = n % nx, j = Math.floor(n / nx) % ny, k = Math.floor(n / (nx * ny));
      for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const a = i + di, b2 = j + dj, c = k + dk;
        if (a < 0 || b2 < 0 || c < 0 || a >= nx || b2 >= ny || c >= nz) continue;
        const q = (c * ny + b2) * nx + a;
        if (kind[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    const out: number[] = [];
    for (let n = 0; n < kind.length; n++) if (kind[n] && !seen[n]) out.push(n);
    return out;
  };

  const rebuildMesh = (r: Ruin): void => {
    if (r.mesh) { group.remove(r.mesh); r.mesh.dispose(); r.mesh = null; }
    if (r.left <= 0) return;
    const mesh = new InstancedMesh(unit, material, r.left);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `ruin-${r.building.id}`;
    let n = 0;
    const { nx, ny, nz } = r;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = (k * ny + j) * nx + i;
      if (!r.kind[q]) continue;
      const p = worldOf(r, i, j, k);
      o.position.set(p.x, p.z, -p.y);
      o.rotation.set(0, r.building.rotation, 0);
      o.scale.set(r.cell * 1.001, r.cellZ * 1.001, r.cell * 1.001);
      o.updateMatrix();
      mesh.setMatrixAt(n, o.matrix);
      mesh.setColorAt(n, tint.setRGB(r.colour[q * 3]!, r.colour[q * 3 + 1]!, r.colour[q * 3 + 2]!));
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    r.mesh = mesh;
  };

  const fall = (r: Ruin, cells: readonly number[], from: { x: number; y: number; z: number }, power: number): void => {
    const { nx, ny } = r;
    let dust = 0;
    for (const q of cells) {
      if (!r.kind[q]) continue;
      const i = q % nx, j = Math.floor(q / nx) % ny, k = Math.floor(q / (nx * ny));
      const p = worldOf(r, i, j, k);
      throwPiece(p.x, p.y, p.z, from, power, Math.min(r.cell, r.cellZ), [r.colour[q * 3]!, r.colour[q * 3 + 1]!, r.colour[q * 3 + 2]!], r.base);
      // Dust and smoke from the breaks.
      if (dust++ % 3 === 0) exhaust.emit(p.x, p.y, p.z - m(1), 0, 0, m(10), true);
      r.kind[q] = 0;
      r.left--;
    }
    r.dirty = true;
  };

  return {
    group,
    ruined,
    hit(b, floor, x, y, z, strength) {
      let r = ruins.get(b.id);
      if (!r) {
        r = make(b, floor);
        ruins.set(b.id, r);
        ruined.add(b.id);
      }
      const reach = m(1.2 + strength * 0.75);
      const centre = { x, y, z };
      const hitCells: number[] = [];
      const { nx, ny, nz } = r;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const q = (k * ny + j) * nx + i;
        if (!r.kind[q]) continue;
        const p = worldOf(r, i, j, k);
        // A ragged edge: a little noise on the reach of the blow.
        if (Math.hypot(p.x - x, p.y - y, p.z - z) < reach * (0.75 + 0.5 * (((i * 31 + j * 17 + k * 7) % 13) / 13))) hitCells.push(q);
      }
      const power = m(4 + strength * 2.5);
      fall(r, hitCells, centre, power);
      // What hangs on nothing comes down too; then once most of it is gone, all of it.
      fall(r, unsupported(r), centre, m(1));
      if (r.left < r.total * 0.22) {
        const rest: number[] = [];
        for (let q = 0; q < r.kind.length; q++) if (r.kind[q]) rest.push(q);
        fall(r, rest, { x: centre.x, y: centre.y, z: centre.z + m(30) }, m(2));
      }
      return r.left <= 0;
    },
    update(dt) {
      for (const r of ruins.values()) if (r.dirty) { r.dirty = false; rebuildMesh(r); }
      let n = 0;
      for (let p = pieces.length - 1; p >= 0; p--) {
        const piece = pieces[p]!;
        piece.age += dt;
        if (!piece.settled) {
          piece.vz -= GRAVITY * dt;
          piece.x += piece.vx * dt; piece.y += piece.vy * dt; piece.z += piece.vz * dt;
          piece.rx += piece.wx * dt; piece.ry += piece.wy * dt; piece.rz += piece.wz * dt;
          // The ground under the ruin: where it stood.
          const floorZ = piece.size / 2;
          if (piece.z - floorZ <= baseOf(piece)) {
            piece.z = baseOf(piece) + floorZ;
            if (Math.abs(piece.vz) > m(2)) { piece.vz *= -0.25; piece.vx *= 0.5; piece.vy *= 0.5; piece.wx *= 0.5; piece.wy *= 0.5; }
            else { piece.settled = true; piece.vx = piece.vy = piece.vz = 0; }
          }
        }
        if (piece.age > DEBRIS_LIFE) piece.z -= dt * m(0.15);
        if (piece.age > DEBRIS_LIFE + 10) { pieces.splice(p, 1); continue; }
      }
      for (const piece of pieces) {
        o.position.set(piece.x, piece.z, -piece.y);
        o.rotation.set(piece.rx, piece.ry, piece.rz);
        o.scale.setScalar(piece.size);
        o.updateMatrix();
        debris.setMatrixAt(n, o.matrix);
        debris.setColorAt(n, tint.setRGB(piece.r, piece.g, piece.b));
        n++;
      }
      debris.count = n;
      debris.instanceMatrix.needsUpdate = true;
      if (debris.instanceColor) debris.instanceColor.needsUpdate = true;
    },
    drop(id) {
      const r = ruins.get(id);
      if (r?.mesh) { group.remove(r.mesh); r.mesh.dispose(); }
      ruins.delete(id);
      ruined.delete(id);
    },
    dispose() {
      for (const r of ruins.values()) r.mesh?.dispose();
      debris.dispose();
      unit.dispose();
      material.dispose();
    },
  };

  function baseOf(piece: Piece): number {
    return piece.ground;
  }
}
