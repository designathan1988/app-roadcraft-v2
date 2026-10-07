/**
 * PLACED CLOUDS: cumulus the player puts in the sky, moves and takes away,
 * each its own size, height and thickness - as an editor's cloud actors are
 * placed, moved and scaled one by one (CloudScape Actors for Unreal) - over
 * the clouds the sky makes of itself (Paisagem > Céu e clima). Kept in the
 * document, so they save, load and undo; drawn by the atmosphere pass
 * (`render/postprocess.ts`), which ray-marches each as a heap of puffs.
 */

export interface PlacedCloud {
  readonly id: number;
  /** Map position under the cloud's middle, world units. */
  readonly x: number;
  readonly y: number;
  /** Height of its flat base over the ground's base level, world units. */
  readonly height: number;
  /** Across, world units (a cumulus about twice as wide as tall). */
  readonly size: number;
  /** 0..1: thin and wispy .. a dense white heap. */
  readonly density: number;
  /** Its turn about the vertical, radians: which way its puffs lie. */
  readonly yaw: number;
}

/** The most clouds a map keeps placed (the sky draws at most `MAX_CLOUDS` in all). */
export const MAX_PLACED_CLOUDS = 16;

export const CLOUD_LIMITS = {
  height: [80, 2400],
  size: [60, 1600],
  density: [0.1, 1],
} as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A placed cloud read from a saved map, kept in range, or null if it is not one. */
export function readCloud(data: unknown): PlacedCloud | null {
  const d = data as Partial<Record<keyof PlacedCloud, unknown>> | null;
  if (!d || !finite(d.id) || !finite(d.x) || !finite(d.y)) return null;
  return {
    id: Math.round(d.id),
    x: d.x,
    y: d.y,
    height: clamp(finite(d.height) ? d.height : 450, CLOUD_LIMITS.height),
    size: clamp(finite(d.size) ? d.size : 375, CLOUD_LIMITS.size),
    density: clamp(finite(d.density) ? d.density : 0.8, CLOUD_LIMITS.density),
    yaw: finite(d.yaw) ? d.yaw : 0,
  };
}

/** The placed cloud whose body covers the map point `(x, y)` seen at its own height, nearest first; null if none. */
export function cloudUnder(clouds: readonly PlacedCloud[], at: (height: number) => { x: number; y: number }): PlacedCloud | null {
  let best: PlacedCloud | null = null;
  let bestD = Infinity;
  for (const cloud of clouds) {
    // Where the pointer's ray crosses the middle of this cloud's body.
    const p = at(cloud.height + cloud.size * 0.3);
    const d = Math.hypot(p.x - cloud.x, p.y - cloud.y) / (cloud.size * 0.6);
    if (d < 1 && d < bestD) { bestD = d; best = cloud; }
  }
  return best;
}
