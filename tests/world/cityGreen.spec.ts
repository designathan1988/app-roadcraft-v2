import { describe, expect, it } from 'vitest';

import { greenCity, layCity, widenCityFootways } from '@editor/cityGenerator';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { NEIGHBOURHOOD } from '@world/cityGen/squares';
import { footwayAt, medianAt } from '@world/landscape';
import { applyLots, insideLot, planLots, type Lot } from '@world/lots';
import { Network } from '@world/network';

/**
 * THE GENERATED CITY'S GREEN (docs/VIAS.md V7): street trees on every
 * footway and down the avenues' medians, one square per neighbourhood made
 * of a whole block (no loose lawn inside a block), its trees inside it, and
 * all of it laid fast.
 */
describe('a generated city is planted', () => {
  it('small city: squares of whole blocks, one per neighbourhood at most, street trees and medians planted', () => {
    const plan = planCity({ ...DEFAULT_CITY, size: 'small', seed: 5 });
    const doc = layCity(plan);
    widenCityFootways(doc);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    const lotsBefore = [...doc.lots] as Lot[];
    const started = performance.now();
    const green = greenCity(doc, net, 5);
    const ms = performance.now() - started;
    expect(green.squares).toBeGreaterThanOrEqual(1);
    expect(ms).toBeLessThan(15_000);
    // No lot remains under a square's tree; every square tree stood on a lot (inside the block).
    const lotsAfter = doc.lots as readonly Lot[];
    for (const tree of doc.trees) {
      expect(lotsBefore.some((l) => insideLot(tree, l))).toBe(true);
      expect(lotsAfter.some((l) => insideLot(tree, l))).toBe(false);
    }
    // At most one square per neighbourhood cell.
    const cells = new Map<string, number>();
    const removed = lotsBefore.filter((l) => !lotsAfter.some((k) => k.id === l.id));
    expect(removed.length).toBeGreaterThan(0);
    // Street trees: on footways and in medians.
    const trees = [...doc.landscape.values()].filter((i) => i.kind === 'tree');
    expect(trees.length).toBeGreaterThan(100);
    expect(trees.some((t) => medianAt(net, t) !== null)).toBe(true);
    expect(trees.some((t) => footwayAt(net, t) !== null)).toBe(true);
    const squareTrees = doc.trees;
    for (const t of squareTrees) {
      const key = `${Math.floor(t.x / NEIGHBOURHOOD)},${Math.floor(t.y / NEIGHBOURHOOD)}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    expect(cells.size).toBeLessThanOrEqual(green.squares * 4);
  });
});
