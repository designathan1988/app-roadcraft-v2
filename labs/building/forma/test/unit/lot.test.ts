import { describe, expect, it } from 'vitest';
import type { Lot, LotRules, Project } from '../../src/core/schema';
import { SCHEMA } from '../../src/core/schema';
import { validateProject } from '../../src/core/validate';
import { computeLotIndices, DEFAULT_LOT_RULES } from '../../src/core/indices';
import { buildableArea, edgeKinds } from '../../src/geometry/lot';
import { area, bounds, distanceToSegment, pointInPolygon } from '../../src/geometry/polygon';
import { netArea } from '../../src/geometry/boolean';
import { newBuilding, setFloors } from '../../src/editor/ops';
import { assignLots, fillLot, newLot } from '../../src/editor/lot-ops';
import { rng } from './legacy';

const rules = (o: Partial<LotRules> = {}): LotRules => ({ ...DEFAULT_LOT_RULES, ...o, setbacks: { ...DEFAULT_LOT_RULES.setbacks, ...(o.setbacks ?? {}) } });
const project = (lots: Lot[], buildings = [] as Project['buildings']): Project => ({ schema: SCHEMA, name: 'L', lots, buildings, styles: [], meta: { createdWith: 't' } });

// Lote 20 × 40 com a rua em z = 40 (aresta inferior na tela).
const rectLot = (r = rules()) => newLot([[0, 0], [20, 0], [20, 40], [0, 40]], 'Lote', r);

describe('lote: arestas e área edificável', () => {
  it('classifica testada, laterais e fundos', () => {
    const lot = rectLot();
    expect(edgeKinds(lot)).toEqual(['back', 'side', 'front', 'side']);
  });

  it('retângulo: área edificável é o retângulo recuado exato', () => {
    const lot = rectLot(rules({ setbacks: { front: 5, side: 1.5, back: 3 } }));
    const parts = buildableArea(lot);
    expect(parts).toHaveLength(1);
    const bd = bounds(parts[0]![0]!);
    expect(bd.minX).toBeCloseTo(1.5, 6);
    expect(bd.maxX).toBeCloseTo(18.5, 6);
    expect(bd.minZ).toBeCloseTo(3, 6);
    expect(bd.maxZ).toBeCloseTo(35, 6);
    expect(netArea(parts[0]!)).toBeCloseTo(17 * 32, 3);
  });

  it('polígono cadastrado no sentido horário mantém a testada certa', () => {
    const lot: Lot = { id: 'x', name: 'x', polygon: [[0, 40], [20, 40], [20, 0], [0, 0]], frontEdges: [0], rules: rules() };
    expect(edgeKinds(lot).filter((k) => k === 'front')).toHaveLength(1);
    const bd = bounds(buildableArea(lot)[0]![0]!);
    expect(bd.maxZ).toBeCloseTo(35, 6);
  });

  it('lote em L: nenhum ponto edificável fica a menos do recuo da divisa', () => {
    const lot = newLot([[0, 0], [30, 0], [30, 12], [12, 12], [12, 30], [0, 30]], 'L', rules({ setbacks: { front: 3, side: 3, back: 3 } }));
    const parts = buildableArea(lot);
    const r = rng(5);
    let tested = 0;
    for (let i = 0; i < 4000; i++) {
      const x = r() * 30,
        z = r() * 30;
      const inBuildable = parts.some((p) => pointInPolygon(x, z, p[0]!) && !p.slice(1).some((h) => pointInPolygon(x, z, h)));
      if (!inBuildable) continue;
      tested++;
      const d = Math.min(...lot.polygon.map((a, j) => distanceToSegment(x, z, a, lot.polygon[(j + 1) % lot.polygon.length]!)));
      expect(d).toBeGreaterThan(3 - 0.05);
    }
    expect(tested).toBeGreaterThan(500);
  });
});

describe('índices e violações', () => {
  it('calcula ocupação, coeficiente, altura e permeabilidade', () => {
    const lot = rectLot();
    const b = newBuilding({ name: 'A', points: [[-5, -8], [5, -8], [5, 8], [-5, 8]], position: [10, 18], base: 0, height: 9.6, floors: 3 });
    const p = project([lot], [b]);
    assignLots(p);
    expect(b.lotId).toBe(lot.id);
    const ix = computeLotIndices(p, lot);
    expect(ix.lotArea).toBe(800);
    expect(ix.occupancy).toBeCloseTo(160 / 800, 6);
    expect(ix.far).toBeCloseTo(480 / 800, 6);
    expect(ix.height).toBeCloseTo(9.6 + 0.66, 6);
    expect(ix.permeability).toBeCloseTo(640 / 800, 6);
    expect(ix.violations).toEqual([]);
    expect(() => validateProject(p)).not.toThrow();
  });

  it('aponta recuo invadido, gabarito, pavimentos e coeficiente', () => {
    const lot = rectLot(rules({ maxHeight: 12, maxStoreys: 3, maxFAR: 1 }));
    const b = newBuilding({ name: 'Alto', points: [[-9, -10], [9, -10], [9, 10], [-9, 10]], position: [10, 25], base: 0, height: 9.6, floors: 3 });
    setFloors(b, 6);
    const p = project([lot], [b]);
    assignLots(p);
    const kinds = computeLotIndices(p, lot).violations.map((v) => v.kind).sort();
    expect(kinds).toEqual(['far', 'height', 'setback', 'storeys']);
  });

  it('preencher lote gera edifício sem violações', () => {
    for (const r of [rules(), rules({ maxOccupancy: 0.3, maxStoreys: 4 }), rules({ maxFAR: 1.2, maxHeight: 15 })]) {
      const lot = rectLot(r);
      const p = project([lot]);
      const b = fillLot(p, lot)!;
      expect(b).not.toBeNull();
      p.buildings.push(b);
      const ix = computeLotIndices(p, lot);
      expect(ix.violations, JSON.stringify(ix.violations)).toEqual([]);
      expect(() => validateProject(p)).not.toThrow();
    }
  });

  it('preencher lote em L respeita o recuo', () => {
    const lot = newLot([[0, 0], [30, 0], [30, 12], [12, 12], [12, 30], [0, 30]], 'L', rules());
    const p = project([lot]);
    const b = fillLot(p, lot)!;
    expect(b).not.toBeNull();
    p.buildings.push(b);
    expect(computeLotIndices(p, lot).violations.filter((v) => v.kind === 'setback' || v.kind === 'outside')).toEqual([]);
    expect(area(b.masses[0]!.outer.vertices.map((v) => v.p))).toBeGreaterThan(50);
  });
});

describe('lote: robustez com lotes aleatórios', () => {
  it('200 lotes irregulares: sem exceção e sem ponto edificável dentro do recuo', () => {
    const r = rng(77);
    let ok = 0;
    for (let i = 0; i < 200; i++) {
      const n = 4 + Math.floor(r() * 6);
      const poly = Array.from({ length: n }, (_, k) => {
        const t = (k / n) * Math.PI * 2,
          rad = 15 + r() * 15;
        return [Math.round(Math.cos(t) * rad), Math.round(Math.sin(t) * rad)] as [number, number];
      });
      const s = { front: 1 + Math.round(r() * 6), side: Math.round(r() * 3), back: Math.round(r() * 5) };
      let lot: Lot;
      try {
        lot = newLot(poly, 'R', rules({ setbacks: s }));
      } catch {
        continue;
      }
      const parts = buildableArea(lot);
      const minS = Math.min(s.front, s.side, s.back);
      for (let k = 0; k < 60; k++) {
        const x = (r() - 0.5) * 60,
          z = (r() - 0.5) * 60;
        if (!parts.some((p) => pointInPolygon(x, z, p[0]!) && !p.slice(1).some((h) => pointInPolygon(x, z, h)))) continue;
        expect(pointInPolygon(x, z, lot.polygon)).toBe(true);
        const d = Math.min(...lot.polygon.map((a, j) => distanceToSegment(x, z, a, lot.polygon[(j + 1) % lot.polygon.length]!)));
        expect(d).toBeGreaterThan(minS - 0.05);
      }
      ok++;
    }
    expect(ok).toBeGreaterThan(190);
  });
});
