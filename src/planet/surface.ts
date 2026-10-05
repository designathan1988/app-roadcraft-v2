import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Camera,
} from 'three';
import { PLANET_RADIUS, reliefAt } from './relief';

/**
 * The planet's ground: a sphere made of a cube, six faces, each a quadtree of
 * patches drawn at the detail their distance needs.
 *
 * As planet renderers do it (Acko.net, "Making Worlds 1 - Of Spheres and
 * Cubes"; Leif Node, "Planetary Scale LOD Terrain Generation"): each face of a
 * cube is a regular grid, each grid point is carried out onto the sphere, and
 * each face is a quadtree - a patch splits in four as the camera comes near it.
 * Cube points are carried to the sphere with the evenly spread mapping of
 * Catlike Coding's "Cube Sphere" (x sqrt(1 - y^2/2 - z^2/2 + y^2 z^2 / 3)),
 * which bunches the corners far less than normalising.
 *
 * Patches of two levels side by side would show cracks; each wears a skirt
 * that hangs down into the ground and fills them. A patch the camera cannot see
 * because it is past the horizon is not drawn at all. Building is held to a time
 * budget per frame; a patch whose four children are not all ready is drawn
 * itself meanwhile, so nothing ever opens a hole.
 */

/** Cells per side of one patch. */
const CELLS = 32;
/** Deepest split: a patch about 40 m across, cells just over a metre. */
const MAX_DEPTH = 9;
/** A patch splits when the camera is nearer than this many times its size. */
const SPLIT = 2.2;
/** Milliseconds of patch building allowed in one frame. */
const BUDGET_MS = 6;
/** Patches kept built but unused before the oldest are let go. */
const KEEP = 2_500;

const FACES: readonly { n: Vector3; u: Vector3; v: Vector3 }[] = [
  { n: new Vector3(1, 0, 0), u: new Vector3(0, 0, -1), v: new Vector3(0, 1, 0) },
  { n: new Vector3(-1, 0, 0), u: new Vector3(0, 0, 1), v: new Vector3(0, 1, 0) },
  { n: new Vector3(0, 1, 0), u: new Vector3(1, 0, 0), v: new Vector3(0, 0, -1) },
  { n: new Vector3(0, -1, 0), u: new Vector3(1, 0, 0), v: new Vector3(0, 0, 1) },
  { n: new Vector3(0, 0, 1), u: new Vector3(1, 0, 0), v: new Vector3(0, 1, 0) },
  { n: new Vector3(0, 0, -1), u: new Vector3(-1, 0, 0), v: new Vector3(0, 1, 0) },
];

/** A point of a cube face, (a, b) in -1..1, carried onto the unit sphere. */
export function cubeToSphere(face: number, a: number, b: number, out: Vector3): Vector3 {
  const f = FACES[face]!;
  const x = f.n.x + f.u.x * a + f.v.x * b;
  const y = f.n.y + f.u.y * a + f.v.y * b;
  const z = f.n.z + f.u.z * a + f.v.z * b;
  const x2 = x * x, y2 = y * y, z2 = z * z;
  return out.set(
    x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3),
    y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3),
    z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3),
  );
}

interface Patch {
  readonly key: string;
  readonly face: number;
  readonly depth: number;
  readonly a0: number;
  readonly b0: number;
  readonly size: number;
  /** Middle of the patch on the sphere, world metres. */
  readonly centre: Vector3;
  /** Radius of the patch on the ground, metres. */
  readonly reach: number;
  mesh: Mesh | null;
  usedAt: number;
}

const SEA_DEEP = new Color(0.13, 0.16, 0.2);
const SAND = new Color(0.62, 0.56, 0.4);
const GRASS = new Color(0.2, 0.33, 0.12);
const FOREST = new Color(0.11, 0.21, 0.08);
const ROCK = new Color(0.36, 0.33, 0.3);
const SNOW = new Color(0.92, 0.94, 0.96);

/** Ground colour for a height and a slope (1 flat, 0 a wall). */
function groundColour(h: number, flat: number, out: Color): Color {
  if (h < 0) return out.copy(SEA_DEEP).lerp(SAND, Math.max(0, 1 + h / 60));
  if (h < 6) return out.copy(SAND).lerp(GRASS, h / 6);
  out.copy(GRASS).lerp(FOREST, Math.min(1, Math.max(0, (h - 80) / 200)));
  out.lerp(ROCK, Math.min(1, Math.max(0, (h - 380) / 160)));
  out.lerp(ROCK, Math.min(1, Math.max(0, (0.86 - flat) / 0.2)));
  return out.lerp(SNOW, Math.min(1, Math.max(0, (h - 620) / 120)) * Math.min(1, Math.max(0, (flat - 0.7) / 0.2)));
}

export interface PlanetSurface {
  readonly group: Group;
  /** Chooses and builds the patches this camera needs. */
  update(camera: Camera): void;
  /** Ground height above sea level under a unit direction (the relief, not the drawn patch). */
  heightAt(direction: Vector3): number;
  /** Patches drawn in the last update. */
  readonly drawn: number;
}

export function createPlanetSurface(): PlanetSurface {
  const group = new Group();
  group.name = 'planet-surface';
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const patches = new Map<string, Patch>();
  const scratch = new Vector3();
  const colour = new Color();
  let frame = 0;
  let drawn = 0;

  const patch = (face: number, depth: number, a0: number, b0: number, size: number): Patch => {
    const key = `${face}/${depth}/${a0}/${b0}`;
    let p = patches.get(key);
    if (!p) {
      const centre = cubeToSphere(face, a0 + size / 2, b0 + size / 2, new Vector3());
      const corner = cubeToSphere(face, a0, b0, new Vector3());
      const reach = corner.distanceTo(centre) * PLANET_RADIUS;
      centre.multiplyScalar(PLANET_RADIUS + Math.max(0, reliefAt(centre.x, centre.y, centre.z)));
      p = { key, face, depth, a0, b0, size, centre, reach, mesh: null, usedAt: 0 };
      patches.set(key, p);
    }
    return p;
  };

  const build = (p: Patch): void => {
    const row = CELLS + 1;
    const grid = row * row;
    const rim: number[] = [];
    for (let i = 0; i < CELLS; i++) rim.push(i);
    for (let j = 0; j < CELLS; j++) rim.push(CELLS + j * row);
    for (let i = CELLS; i > 0; i--) rim.push(i + CELLS * row);
    for (let j = CELLS; j > 0; j--) rim.push(j * row);
    const count = grid + rim.length;
    const position = new Float32Array(count * 3);
    const heights = new Float32Array(count);
    const dirs = new Float32Array(grid * 3);
    // Positions are kept relative to the patch's middle: the mesh sits there.
    for (let j = 0; j < row; j++) {
      for (let i = 0; i < row; i++) {
        const k = i + j * row;
        cubeToSphere(p.face, p.a0 + (p.size * i) / CELLS, p.b0 + (p.size * j) / CELLS, scratch);
        const h = reliefAt(scratch.x, scratch.y, scratch.z);
        heights[k] = h;
        dirs[k * 3] = scratch.x; dirs[k * 3 + 1] = scratch.y; dirs[k * 3 + 2] = scratch.z;
        const r = PLANET_RADIUS + h;
        position[k * 3] = scratch.x * r - p.centre.x;
        position[k * 3 + 1] = scratch.y * r - p.centre.y;
        position[k * 3 + 2] = scratch.z * r - p.centre.z;
      }
    }
    // The skirt: each rim point again, sunk towards the centre of the planet.
    const drop = 2 + p.reach * 0.06;
    rim.forEach((from, n) => {
      const to = grid + n;
      const r = PLANET_RADIUS + (heights[from] as number) - drop;
      position[to * 3] = (dirs[from * 3] as number) * r - p.centre.x;
      position[to * 3 + 1] = (dirs[from * 3 + 1] as number) * r - p.centre.y;
      position[to * 3 + 2] = (dirs[from * 3 + 2] as number) * r - p.centre.z;
      heights[to] = heights[from] as number;
    });
    const index: number[] = [];
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const a = i + j * row, b = i + (j + 1) * row, c = i + 1 + (j + 1) * row, d = i + 1 + j * row;
        index.push(a, d, b, b, d, c);
      }
    }
    for (let n = 0; n < rim.length; n++) {
      const t0 = rim[n] as number, t1 = rim[(n + 1) % rim.length] as number;
      const l0 = grid + n, l1 = grid + ((n + 1) % rim.length);
      index.push(t0, l0, t1, t1, l0, l1, t0, t1, l0, t1, l1, l0);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    // Colours read the slope against the local up, after the normals exist.
    const normal = geometry.getAttribute('normal');
    const colours = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
      const g = k < grid ? k : (rim[k - grid] as number);
      const flat = normal.getX(k) * (dirs[g * 3] as number) + normal.getY(k) * (dirs[g * 3 + 1] as number) + normal.getZ(k) * (dirs[g * 3 + 2] as number);
      groundColour(heights[k] as number, flat, colour);
      colours[k * 3] = colour.r; colours[k * 3 + 1] = colour.g; colours[k * 3 + 2] = colour.b;
    }
    geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(p.centre);
    mesh.updateMatrixWorld();
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.visible = false;
    group.add(mesh);
    p.mesh = mesh;
  };

  // The six faces are always ready: everything else falls back to them.
  for (let f = 0; f < 6; f++) build(patch(f, 0, -1, -1, 2));

  const camPos = new Vector3();
  const toPatch = new Vector3();

  return {
    group,
    get drawn() { return drawn; },
    heightAt(direction) {
      return reliefAt(direction.x, direction.y, direction.z);
    },
    update(camera) {
      frame++;
      camera.getWorldPosition(camPos);
      const camDist = camPos.length();
      // Past the horizon: the angle beyond which the ground cannot be seen.
      const horizon = Math.acos(Math.min(1, PLANET_RADIUS / Math.max(PLANET_RADIUS + 1, camDist)));
      const camDir = camPos.clone().normalize();
      const wanted: Patch[] = [];
      const shown: Patch[] = [];
      const visit = (p: Patch): void => {
        p.usedAt = frame;
        // Not drawn when wholly past the horizon (the mountains are allowed for).
        const angle = Math.acos(Math.min(1, Math.max(-1, toPatch.copy(p.centre).normalize().dot(camDir))));
        if (angle - p.reach / PLANET_RADIUS > horizon + 0.12) return;
        const near = camPos.distanceTo(p.centre) < p.reach * 2 * SPLIT;
        if (near && p.depth < MAX_DEPTH) {
          const half = p.size / 2;
          const kids = [
            patch(p.face, p.depth + 1, p.a0, p.b0, half),
            patch(p.face, p.depth + 1, p.a0 + half, p.b0, half),
            patch(p.face, p.depth + 1, p.a0, p.b0 + half, half),
            patch(p.face, p.depth + 1, p.a0 + half, p.b0 + half, half),
          ];
          if (kids.every((k) => k.mesh)) {
            for (const k of kids) visit(k);
            return;
          }
          for (const k of kids) if (!k.mesh) { k.usedAt = frame; wanted.push(k); }
        }
        if (p.mesh) shown.push(p);
      };
      for (let f = 0; f < 6; f++) visit(patch(f, 0, -1, -1, 2));

      for (const p of patches.values()) if (p.mesh) p.mesh.visible = false;
      for (const p of shown) (p.mesh as Mesh).visible = true;
      drawn = shown.length;

      // Nearest first, within the frame's budget.
      wanted.sort((a, b) => camPos.distanceTo(a.centre) - camPos.distanceTo(b.centre));
      const start = performance.now();
      for (const p of wanted) {
        if (performance.now() - start > BUDGET_MS) break;
        build(p);
      }

      // Let the oldest unused patches go.
      if (patches.size > KEEP) {
        const old = [...patches.values()].filter((p) => p.depth > 0 && frame - p.usedAt > 120).sort((a, b) => a.usedAt - b.usedAt);
        for (const p of old.slice(0, patches.size - KEEP)) {
          if (p.mesh) { group.remove(p.mesh); p.mesh.geometry.dispose(); }
          patches.delete(p.key);
        }
      }
      void camDist;
    },
  };
}
