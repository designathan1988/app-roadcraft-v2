/**
 * THE PLANET'S GEOMETRY: the map is a CHART of a sphere.
 *
 * A flat map and a sphere are not isometric (Gauss's Theorema Egregium), so
 * the game keeps working on a plane - as surveying and flight simulators work
 * in a local tangent plane - and the plane is the STEREOGRAPHIC chart of the
 * sphere about the chart's centre: the projection from the antipode onto the
 * tangent plane there. It is conformal (angles kept: a junction, a lot, a
 * building keep their shape) and maps circles to circles; only the scale
 * changes, alike in every direction, by sec^2(theta/2) = 1 + rho^2 / (4 R^2)
 * at chart radius rho (https://en.wikipedia.org/wiki/Stereographic_projection).
 *
 * The chart's own axes: x east, y north (the map's), up out of the sphere at
 * its centre. A point of the sphere is a unit vector in the planet's frame;
 * a chart is that frame's centre and north (`Chart`), so the same city can be
 * charted about any of its places (`recenter.ts`).
 *
 * Pure: no three, no randomness.
 */

export type Vec3 = readonly [number, number, number];

/** A chart: the sphere's point at its centre, and its north there (unit, perpendicular to the centre). */
export interface Chart {
  readonly centre: Vec3;
  readonly north: Vec3;
}

/** The chart whose centre is the planet frame's z axis, north its y axis. */
export const TOP_CHART: Chart = { centre: [0, 0, 1], north: [0, 1, 0] };

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scaled = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A chart's east, north and up in the planet's frame. */
export function chartAxes(chart: Chart): { readonly east: Vec3; readonly north: Vec3; readonly up: Vec3 } {
  const up = unit(chart.centre);
  // North made exactly perpendicular to up (Gram-Schmidt), east across them.
  const north = unit([chart.north[0] - up[0] * dot(chart.north, up), chart.north[1] - up[1] * dot(chart.north, up), chart.north[2] - up[2] * dot(chart.north, up)]);
  const east = cross(north, up);
  return { east, north, up };
}

/** The angle from the chart's centre, seen from the sphere's centre, of a point at chart radius rho. */
export function chartAngle(rho: number, radius: number): number {
  return 2 * Math.atan(rho / (2 * radius));
}

/** How many chart units a unit of the sphere's surface spans at chart radius rho. */
export function chartScale(rho: number, radius: number): number {
  return 1 + (rho * rho) / (4 * radius * radius);
}

/** A chart point to the sphere: the unit vector in the CHART's own frame (x east, y north, z up). */
export function chartToLocal(x: number, y: number, radius: number): Vec3 {
  const rho = Math.hypot(x, y);
  if (rho < 1e-12) return [0, 0, 1];
  const th = chartAngle(rho, radius);
  const s = Math.sin(th) / rho;
  return [x * s, y * s, Math.cos(th)];
}

/** A unit vector in the chart's own frame back to its chart point (the antipode has none). */
export function localToChart(v: Vec3, radius: number): { x: number; y: number } {
  const across = Math.hypot(v[0], v[1]);
  if (across < 1e-15) return { x: 0, y: 0 };
  const th = Math.atan2(across, v[2]);
  const rho = 2 * radius * Math.tan(th / 2);
  return { x: (v[0] / across) * rho, y: (v[1] / across) * rho };
}

/** A chart point to the sphere, in the planet's frame. */
export function chartToPlanet(chart: Chart, x: number, y: number, radius: number): Vec3 {
  const { east, north, up } = chartAxes(chart);
  const l = chartToLocal(x, y, radius);
  return [
    east[0] * l[0] + north[0] * l[1] + up[0] * l[2],
    east[1] * l[0] + north[1] * l[1] + up[1] * l[2],
    east[2] * l[0] + north[2] * l[1] + up[2] * l[2],
  ];
}

/** A point of the sphere (planet frame) to its chart point. */
export function planetToChart(chart: Chart, p: Vec3, radius: number): { x: number; y: number } {
  const { east, north, up } = chartAxes(chart);
  return localToChart([dot(p, east), dot(p, north), dot(p, up)], radius);
}

/**
 * The bearing on chart `to` of a direction that has bearing `bearing`
 * (radians, anticlockwise from the chart's x axis) on chart `from` at the
 * chart point (x, y): the direction carried onto the sphere and charted again.
 * Both charts are conformal, so a shape keeps its angles: only this turn
 * changes (the meridian convergence of surveying).
 */
export function convergence(from: Chart, to: Chart, x: number, y: number, bearing: number, radius: number): number {
  // A short step along the bearing, on the sphere, charted again.
  const step = 1e-3 * radius;
  const a = planetToChart(to, chartToPlanet(from, x, y, radius), radius);
  const k = chartScale(Math.hypot(x, y), radius);
  const b = planetToChart(to, chartToPlanet(from, x + (Math.cos(bearing) * step) * k, y + (Math.sin(bearing) * step) * k, radius), radius);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** The chart about a point of another chart, its north the old north carried there. */
export function chartAt(from: Chart, x: number, y: number, radius: number): Chart {
  const centre = chartToPlanet(from, x, y, radius);
  // North: the old chart's north direction at that point, carried onto the sphere.
  const step = 1e-3 * radius;
  const ahead = chartToPlanet(from, x, y + step, radius);
  const toward: Vec3 = [ahead[0] - centre[0], ahead[1] - centre[1], ahead[2] - centre[2]];
  const n = unit([toward[0] - centre[0] * dot(toward, centre), toward[1] - centre[1] * dot(toward, centre), toward[2] - centre[2] * dot(toward, centre)]);
  return { centre, north: n };
}

/** Plain helpers for callers that hold vectors. */
export const vec3 = { cross, dot, scaled, unit };
