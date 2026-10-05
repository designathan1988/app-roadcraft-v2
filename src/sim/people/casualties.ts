import type { SimWorld } from '../world';
import type { PartyView, PersonAgeClass, PersonGender } from './view';

/**
 * The people blows have struck, for the renderer (`render/ragdoll.ts`): every
 * pedestrian engine records here, so a blow throws bodies whichever engine
 * walks the town.
 */

/** Somebody a blow killed or knocked down: who they were (for their body) and the blast that threw them. */
export interface Casualty {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  /** Killed, killed and torn apart, or knocked down (gets up again). */
  readonly kind: 'dead' | 'torn' | 'knocked';
  /** Seconds since. */
  t: number;
  readonly id: number;
  readonly gender: PersonGender;
  readonly ageClass: PersonAgeClass;
  readonly party: PartyView;
  readonly blastX: number;
  readonly blastY: number;
  /** 0 at the edge of the reach, 1 at the blow's centre. */
  readonly power: number;
}

const RECORDS = new WeakMap<SimWorld, Casualty[]>();

/** Records somebody struck by a blow. */
export function recordCasualty(w: SimWorld, c: Casualty): void {
  let list = RECORDS.get(w);
  if (!list) RECORDS.set(w, (list = []));
  list.push(c);
}

/** The casualties of blows on the map; their clocks advanced by `dt`, a minute's worth kept. */
export function impactCasualties(w: SimWorld, dt = 0): readonly Casualty[] {
  const list = RECORDS.get(w);
  if (!list) return [];
  for (const c of list) c.t += dt;
  if (list.length && list[0]!.t > 60) RECORDS.set(w, list.filter((c) => c.t <= 60));
  return RECORDS.get(w)!;
}
