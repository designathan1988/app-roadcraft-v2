import { describe, expect, it } from 'vitest';

import {
  TOP_CHART, chartAngle, chartAt, chartScale, chartToLocal, chartToPlanet, convergence, localToChart, planetToChart, type Vec3,
} from '@world/planet/sphere';

const R = 14_000;

describe('the stereographic chart of the planet', () => {
  it('goes to the sphere and back to the same chart point', () => {
    for (const [x, y] of [[0, 0], [10, -3], [3000, 1200], [-7500, 4100], [20_000, -18_000]] as const) {
      const back = localToChart(chartToLocal(x, y, R), R);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
  });

  it('keeps the points on the unit sphere', () => {
    for (const [x, y] of [[0, 0], [4000, -2000], [-30_000, 9000]] as const) {
      const v = chartToLocal(x, y, R);
      expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    }
  });

  it('is conformal: a right angle on the chart is a right angle on the sphere', () => {
    const h = 0.01;
    for (const [x, y] of [[2500, 900], [-6000, 3000]] as const) {
      const o = chartToLocal(x, y, R);
      const a = chartToLocal(x + h, y, R);
      const b = chartToLocal(x, y + h, R);
      const da: Vec3 = [a[0] - o[0], a[1] - o[1], a[2] - o[2]];
      const db: Vec3 = [b[0] - o[0], b[1] - o[1], b[2] - o[2]];
      const cos = (da[0] * db[0] + da[1] * db[1] + da[2] * db[2]) / (Math.hypot(...da) * Math.hypot(...db));
      expect(Math.abs(cos)).toBeLessThan(1e-4);
      // And alike in both directions: the scale is the same across and along.
      expect(Math.hypot(...da) / Math.hypot(...db)).toBeCloseTo(1, 4);
      // At the scale the chart says.
      const sphereStep = Math.hypot(...da) * R;
      expect(h / sphereStep).toBeCloseTo(chartScale(Math.hypot(x, y), R), 4);
    }
  });

  it('puts a chart radius at the right angle from the centre', () => {
    expect(chartAngle(0, R)).toBe(0);
    // 2 R on the chart is a quarter of the way round (the equator from the pole).
    expect(chartAngle(2 * R, R)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('charts the same city about another of its places without losing a point', () => {
    const other = chartAt(TOP_CHART, 3000, -1500, R);
    for (const [x, y] of [[0, 0], [3000, -1500], [5200, 800], [-1000, -4000]] as const) {
      const p = chartToPlanet(TOP_CHART, x, y, R);
      const there = planetToChart(other, p, R);
      const back = planetToChart(TOP_CHART, chartToPlanet(other, there.x, there.y, R), R);
      expect(back.x).toBeCloseTo(x, 5);
      expect(back.y).toBeCloseTo(y, 5);
    }
    // The new chart's centre is the old chart's point.
    const centre = planetToChart(other, chartToPlanet(TOP_CHART, 3000, -1500, R), R);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(0, 6);
  });

  it('turns a bearing by the charts convergence only', () => {
    // On the same chart, nothing turns.
    expect(convergence(TOP_CHART, TOP_CHART, 2000, 1000, 0.7, R)).toBeCloseTo(0.7, 5);
    // A chart about a point with north carried there: north stays north at that point.
    const other = chartAt(TOP_CHART, 2500, 0, R);
    expect(convergence(TOP_CHART, other, 2500, 0, Math.PI / 2, R)).toBeCloseTo(Math.PI / 2, 4);
  });
});
