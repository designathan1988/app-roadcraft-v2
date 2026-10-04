/** Authored land-use area. Buildings generated from it remain ordinary editable buildings. */
export const ZONE_USES = ['residential', 'commercial', 'industrial'] as const;
export const ZONE_DENSITIES = ['low', 'medium', 'high'] as const;
export type ZoneUse = (typeof ZONE_USES)[number];
export type ZoneDensity = (typeof ZONE_DENSITIES)[number];

export interface Zone {
  readonly id: number;
  readonly use: ZoneUse;
  readonly density: ZoneDensity;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly seed: number;
  readonly buildingIds: readonly number[];
}

export const isZoneUse = (value: unknown): value is ZoneUse => ZONE_USES.includes(value as ZoneUse);
export const isZoneDensity = (value: unknown): value is ZoneDensity => ZONE_DENSITIES.includes(value as ZoneDensity);

export function zoneBounds(a: { x: number; y: number }, b: { x: number; y: number }): Pick<Zone, 'x0' | 'y0' | 'x1' | 'y1'> {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

export function zonesOverlap(a: Pick<Zone, 'x0' | 'y0' | 'x1' | 'y1'>, b: Pick<Zone, 'x0' | 'y0' | 'x1' | 'y1'>): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}
