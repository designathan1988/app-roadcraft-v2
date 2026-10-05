import {
  CanvasTexture,
  CircleGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
} from 'three';

/** A patch of blood on the ground: where, how big at full spread, and how long it takes to spread. */
export interface BloodDecal {
  readonly x: number;
  readonly y: number;
  /** World height of the surface it lies on. */
  readonly z: number;
  readonly angle: number;
  readonly size: number;
  /** Seconds to reach full size (0: at once). */
  readonly spread: number;
  /** Seconds since it was made. */
  age: number;
}

/**
 * What a blow leaves on the ground (the player's order of 2026-10-05): a pool
 * of blood spreading from under each body over its first seconds, a darker
 * splatter where somebody was right under the blow. Instanced decals on the
 * ground, one draw for all of them.
 */

const MAX = 400;

function bloodTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  let seed = 11;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // An irregular pool: overlapping blobs, darker at the middle, a few drops round it.
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2, r = rnd() * size * 0.18;
    const x = size / 2 + Math.cos(a) * r, y = size / 2 + Math.sin(a) * r, rad = size * (0.12 + rnd() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(88, 6, 8, 0.95)');
    grad.addColorStop(0.75, 'rgba(110, 10, 12, 0.85)');
    grad.addColorStop(1, 'rgba(110, 10, 12, 0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2, r = size * (0.3 + rnd() * 0.18);
    g.fillStyle = 'rgba(95, 8, 10, 0.9)';
    g.beginPath(); g.arc(size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r, 1 + rnd() * 3, 0, Math.PI * 2); g.fill();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export interface CasualtyLayer {
  readonly group: Group;
  sync(list: readonly BloodDecal[]): void;
  dispose(): void;
}

export function createCasualties(): CasualtyLayer {
  const group = new Group();
  group.name = 'casualties';
  const geometry = new CircleGeometry(0.5, 20).rotateX(-Math.PI / 2);
  const material = new MeshStandardMaterial({
    map: bloodTexture(), transparent: true, depthWrite: false, roughness: 0.25, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const pools = new InstancedMesh(geometry, material, MAX);
  pools.instanceMatrix.setUsage(DynamicDrawUsage);
  pools.count = 0;
  pools.frustumCulled = false;
  pools.renderOrder = 4;
  group.add(pools);
  const o = new Object3D();
  return {
    group,
    sync(list) {
      let n = 0;
      for (const c of list) {
        if (n >= MAX) break;
        const grow = c.spread > 0 ? Math.min(1, 0.2 + c.age / c.spread) : 1;
        const size = c.size * grow;
        o.position.set(c.x, c.z + 0.02, -c.y);
        o.rotation.set(0, c.angle, 0);
        o.scale.set(size, 1, size * 0.85);
        o.updateMatrix();
        pools.setMatrixAt(n++, o.matrix);
      }
      pools.count = n;
      pools.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.map?.dispose();
      material.dispose();
    },
  };
}
