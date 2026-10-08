/**
 * THE GAME'S STATE: what the player has in hand and how the game runs - the
 * tool, the pause and speed, the quality, the selection - owned in one place,
 * and every change of it written down: what changed, from what to what, and
 * why (the player, 2026-10-08: "o jogo precisa ter um controlador global de
 * estados, eventos"). Before it these were loose variables of `main.ts`,
 * written from some thirty places with no record.
 *
 * The world's own changes are in the document's diary (`world/changes.ts`).
 * This one is apart on purpose: an entry here has no place on the map, and a
 * reader of the diary takes an entry with no place as the whole map changed;
 * and the interface changes far more often than the world, which would push
 * the world's entries out of the diary's ring.
 *
 * An entry is an event - what already happened, its values captured when it
 * is written - in a ring of fixed size (Nystrom, "Event Queue"); nobody is
 * called, readers pull what came after the serial they last saw. `set` is
 * the one way in, and a value set to what it already is writes nothing.
 *
 * Pure: no three, no DOM.
 */

export interface StateChange<V> {
  /** Order of writing; every entry has its own. */
  readonly serial: number;
  readonly key: keyof V & string;
  readonly from: unknown;
  readonly to: unknown;
  /** Why: the gesture or control that changed it. */
  readonly cause: string;
  /** When (`performance.now()`). */
  readonly at: number;
}

/** How many changes are kept; a reader older than that takes everything as changed. */
const KEPT = 512;

export class GameState<V extends object> {
  private readonly values: V;
  private serial = 0;
  private readonly ring: (StateChange<V> | undefined)[] = new Array<StateChange<V> | undefined>(KEPT);
  private count = 0;

  constructor(initial: V) {
    this.values = { ...initial };
  }

  get<K extends keyof V>(key: K): V[K] {
    return this.values[key];
  }

  /** Sets a value and writes the change down; false (nothing written) when it already was that. */
  set<K extends keyof V & string>(key: K, value: V[K], cause: string): boolean {
    const from = this.values[key];
    if (Object.is(from, value)) return false;
    this.values[key] = value;
    const serial = ++this.serial;
    this.ring[serial % KEPT] = { serial, key, from, to: value, cause, at: performance.now() };
    if (this.count < KEPT) this.count++;
    return true;
  }

  /** The serial of the latest change: what a reader that has seen everything holds. */
  get version(): number {
    return this.serial;
  }

  /** The changes after `since`, of these keys only when given; `null` if some were forgotten. */
  since(since: number, keys?: readonly (keyof V & string)[]): StateChange<V>[] | null {
    if (since < this.serial - this.count) return null;
    const out: StateChange<V>[] = [];
    for (let s = since + 1; s <= this.serial; s++) {
      const entry = this.ring[s % KEPT];
      if (entry && entry.serial === s && (!keys || keys.includes(entry.key))) out.push(entry);
    }
    return out;
  }

  /** The last `n` changes, newest first. */
  latest(n: number): StateChange<V>[] {
    const out: StateChange<V>[] = [];
    for (let s = this.serial; s > this.serial - this.count && out.length < n; s--) {
      const entry = this.ring[s % KEPT];
      if (entry && entry.serial === s) out.push(entry);
    }
    return out;
  }

  /** Every value as it is now (a copy). */
  snapshot(): Readonly<V> {
    return { ...this.values };
  }
}
