import { DT } from '../params';
import type { SimWorld } from '../world';
import { TransitSim } from '../transit/transit';

/** Game seconds per simulated second: a day lasts 72 minutes of play. */
export const TIME_SCALE = 20;
/** The time of day the city wakes at, minutes after midnight. */
export const DAY_START = 6 * 60 + 30;

/**
 * THE CITY'S OWN SERVICES, with nobody living in it: the time of day, read
 * off the simulation's fixed clock (the game time a fixed step advances,
 * Nystrom's "Game Loop") plus whatever was skipped by hand; the public
 * transport running on the lines the player drew; and the flag that lets the
 * scenery's traffic in at the road ends.
 *
 * The residents' days - homes, jobs, needs, trips, their own cars - and
 * walking the city as one of them were kept apart in `src/backup/residents`
 * (the player's decision of 2026-10-08): the people in the game are the
 * scenery's life (`sim/ambient`).
 */
export class City {
  /** Buses and trains on the drawn lines (`transit/transit.ts`). */
  readonly transit = new TransitSim();
  /** Minutes the clock was moved on by hand (`skip`). */
  private skipped = 0;

  /** Minutes since midnight of the first day, from the simulation clock. */
  minutes(w: SimWorld): number {
    return DAY_START + this.skipped + (w.clock.tick * DT * TIME_SCALE) / 60;
  }

  /** Moves the clock on. */
  skip(minutes: number): void {
    this.skipped += Math.max(0, minutes);
  }

  /** Stage 2 (`pipeline.ts`): the lines run; traffic comes in at the road ends when the scenery is fed from them. */
  step(w: SimWorld): void {
    w.edgeTraffic = w.ambient.enabled && w.ambient.source === 'edges';
    this.transit.step(w);
  }
}
