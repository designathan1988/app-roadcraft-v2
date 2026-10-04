import { m } from '@world/units';

/**
 * A car's path off the road: out of a parking bay to its lane, or from the lane
 * into a bay.
 *
 * A path is a chain of legs, each a cubic Hermite curve between two points
 * with the direction of MOTION given at both ends. A leg driven in reverse
 * keeps the body pointing against its motion: backing out of a bay, the nose
 * stays towards the bay while the car swings round. Bays are entered nose
 * first and left backing out with a quarter turn, as drivers do in a car park.
 */

export interface PathSample {
  readonly x: number;
  readonly y: number;
  /** Heading of the BODY (nose), radians. */
  readonly angle: number;
  /** Distance along the whole path. */
  readonly s: number;
  /** Index of the leg the sample belongs to. */
  readonly leg: number;
}

export interface Leg {
  readonly x0: number; readonly y0: number;
  /** Unit direction of motion at the start. */
  readonly tx0: number; readonly ty0: number;
  readonly x1: number; readonly y1: number;
  /** Unit direction of motion at the end. */
  readonly tx1: number; readonly ty1: number;
  readonly reverse: boolean;
}

/** Points per leg: a leg is a few metres to a few tens of metres long. */
const SAMPLES = 28;
/** Top speed in a car park, forward and backing out. */
const FORWARD = m(3.6);
const BACKWARD = m(1.7);
/** Distance over which a car gets up to speed and comes to rest, per leg. */
const RAMP = m(2.2);
/** Slowest it creeps while moving (so a leg always ends). */
const CREEP = m(0.25);
/** Hermite tangent length as a share of a leg's chord. */
const TANGENT = 0.6;

export class Manoeuvre {
  readonly samples: PathSample[] = [];
  readonly legEnds: number[] = [];
  readonly length: number;
  /** Distance travelled along the path. */
  s = 0;

  constructor(readonly legs: readonly Leg[]) {
    let s = 0;
    legs.forEach((leg, i) => {
      // Tangents a little shorter than the chord: the curve keeps close to the line
      // between the points (which the lot grid found clear) instead of bulging out.
      const k = TANGENT * Math.hypot(leg.x1 - leg.x0, leg.y1 - leg.y0);
      let px = leg.x0, py = leg.y0;
      for (let j = 0; j <= SAMPLES; j++) {
        const u = j / SAMPLES;
        const u2 = u * u, u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
        const x = h00 * leg.x0 + h10 * k * leg.tx0 + h01 * leg.x1 + h11 * k * leg.tx1;
        const y = h00 * leg.y0 + h10 * k * leg.ty0 + h01 * leg.y1 + h11 * k * leg.ty1;
        // Tangent of the curve (derivative), the direction of motion here.
        const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
        const dx = d00 * leg.x0 + d10 * k * leg.tx0 + d01 * leg.x1 + d11 * k * leg.tx1;
        const dy = d00 * leg.y0 + d10 * k * leg.ty0 + d01 * leg.y1 + d11 * k * leg.ty1;
        const motion = dx === 0 && dy === 0 ? Math.atan2(leg.ty0, leg.tx0) : Math.atan2(dy, dx);
        if (j > 0) s += Math.hypot(x - px, y - py);
        else if (i > 0) continue; // the joint is the previous leg's last sample
        px = x; py = y;
        this.samples.push({ x, y, angle: leg.reverse ? motion + Math.PI : motion, s, leg: i });
      }
      this.legEnds.push(s);
    });
    this.length = s;
  }

  get done(): boolean { return this.s >= this.length - 1e-6; }

  /** The leg being driven now. */
  get leg(): number {
    let i = 0;
    while (i < this.legEnds.length - 1 && this.s >= this.legEnds[i]! - 1e-6) i++;
    return i;
  }

  /** Speed for the current place: up to speed and down to rest within each leg. */
  speed(): number {
    const i = this.leg;
    const start = i === 0 ? 0 : this.legEnds[i - 1]!;
    const end = this.legEnds[i]!;
    const top = this.legs[i]!.reverse ? BACKWARD : FORWARD;
    const ramp = Math.min(1, (this.s - start) / RAMP + 0.15, (end - this.s) / RAMP + 0.1);
    return Math.max(CREEP, top * Math.max(0, ramp));
  }

  /** Moves on by `ds`, never past the end. */
  advance(ds: number): void { this.s = Math.min(this.length, this.s + Math.max(0, ds)); }

  /** Body centre and heading at distance `s` (now, by default). */
  poseAt(s = this.s): { x: number; y: number; angle: number } {
    const pts = this.samples;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]!.s <= s) lo = mid; else hi = mid;
    }
    const a = pts[lo]!, b = pts[hi]!;
    const t = b.s > a.s ? Math.min(1, Math.max(0, (s - a.s) / (b.s - a.s))) : 0;
    // Across a joint from reverse to forward the heading is continuous by
    // construction (the leg's ends share the body direction).
    let da = b.angle - a.angle;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: a.angle + da * t };
  }
}

/** Unit vector, or `fallback` for a zero one. */
function unit(x: number, y: number, fallback: [number, number]): [number, number] {
  const l = Math.hypot(x, y);
  return l > 1e-9 ? [x / l, y / l] : fallback;
}

type Point = { readonly x: number; readonly y: number };

/**
 * Forward legs through `points`, leaving the first along `t0` and arriving at the
 * last along `t1`; at the points between, the direction halves the turn.
 */
function through(points: readonly Point[], t0: [number, number], t1: [number, number]): Leg[] {
  const legs: Leg[] = [];
  const dirAt = (i: number): [number, number] => {
    if (i === 0) return t0;
    if (i === points.length - 1) return t1;
    const a = points[i - 1]!, p = points[i]!, c = points[i + 1]!;
    const [ux, uy] = unit(p.x - a.x, p.y - a.y, t0);
    const [vx, vy] = unit(c.x - p.x, c.y - p.y, t1);
    return unit(ux + vx, uy + vy, [vx, vy]);
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!, b = points[i + 1]!;
    const [tx0, ty0] = dirAt(i), [tx1, ty1] = dirAt(i + 1);
    legs.push({ x0: a.x, y0: a.y, tx0, ty0, x1: b.x, y1: b.y, tx1, ty1, reverse: false });
  }
  return legs;
}

/**
 * Out of a bay to the lane. Backing out of the stall into the aisle, swinging
 * the nose towards the way out, then forward down the aisle and out of the lot
 * by its street edge (`Bay.via`), and onto the lane at its joining point. A bay
 * outside any lot backs out with a quarter turn towards the traffic and drives
 * straight to the lane.
 *
 * `bay` is the stall (centre, unit direction out of it, depth); the car stands
 * nose in. `lane` is the body centre's place on the lane and the direction of
 * travel there.
 */
export function departure(
  bay: { x: number; y: number; ox: number; oy: number; depth: number; via: readonly Point[] },
  lane: { x: number; y: number; tx: number; ty: number },
): Manoeuvre {
  if (bay.via.length > 0) {
    const aisle = bay.via[0]!;
    const next = bay.via[1] ?? lane;
    const [dx, dy] = unit(next.x - aisle.x, next.y - aisle.y, [lane.tx, lane.ty]);
    return new Manoeuvre([
      { x0: bay.x, y0: bay.y, tx0: bay.ox, ty0: bay.oy, x1: aisle.x, y1: aisle.y, tx1: -dx, ty1: -dy, reverse: true },
      ...through([...bay.via, lane], [dx, dy], [lane.tx, lane.ty]),
    ]);
  }
  // Which way to swing the nose: along the traffic.
  const p1: [number, number] = [-bay.oy, bay.ox];
  const p = p1[0] * lane.tx + p1[1] * lane.ty >= 0 ? p1 : [-p1[0], -p1[1]] as [number, number];
  const rx = bay.x + bay.ox * (bay.depth / 2 + m(2.6)) - p[0] * m(1.6);
  const ry = bay.y + bay.oy * (bay.depth / 2 + m(2.6)) - p[1] * m(1.6);
  return new Manoeuvre([
    // Backing out: moving out of the stall, ending moving against the nose (-p).
    { x0: bay.x, y0: bay.y, tx0: bay.ox, ty0: bay.oy, x1: rx, y1: ry, tx1: -p[0], ty1: -p[1], reverse: true },
    // Forward to the lane, arriving along it.
    { x0: rx, y0: ry, tx0: p[0], ty0: p[1], x1: lane.x, y1: lane.y, tx1: lane.tx, ty1: lane.ty, reverse: false },
  ]);
}

/**
 * From the lane into a bay, nose first: from where the car stopped (`from`,
 * its body centre and heading) to a point in front of the stall, then
 * straight in.
 */
export function arrival(
  from: { x: number; y: number; angle: number },
  bay: { x: number; y: number; ox: number; oy: number; depth: number; via: readonly Point[] },
): Manoeuvre {
  const [hx, hy] = unit(Math.cos(from.angle), Math.sin(from.angle), [1, 0]);
  if (bay.via.length > 0) {
    // In by the lot's street edge, up the aisle, and nose first into the stall.
    const inward = [...bay.via].reverse();
    const aisle = inward[inward.length - 1]!;
    return new Manoeuvre([
      ...through([from, ...inward], [hx, hy], [-bay.ox, -bay.oy]),
      { x0: aisle.x, y0: aisle.y, tx0: -bay.ox, ty0: -bay.oy, x1: bay.x, y1: bay.y, tx1: -bay.ox, ty1: -bay.oy, reverse: false },
    ]);
  }
  const ax = bay.x + bay.ox * (bay.depth / 2 + m(2.4));
  const ay = bay.y + bay.oy * (bay.depth / 2 + m(2.4));
  return new Manoeuvre([
    { x0: from.x, y0: from.y, tx0: hx, ty0: hy, x1: ax, y1: ay, tx1: -bay.ox, ty1: -bay.oy, reverse: false },
    { x0: ax, y0: ay, tx0: -bay.ox, ty0: -bay.oy, x1: bay.x, y1: bay.y, tx1: -bay.ox, ty1: -bay.oy, reverse: false },
  ]);
}
