import { describe, expect, it } from 'vitest';
import { building, rectPlan, solid } from '../../src/f3/model/defaults';
import { bendEdge, cloneSolid, mirrorSolid, moveVertex, planValid, pushEdge, removeVertex, rotateSolid, splitEdge, toLocal, toWorld } from '../../src/f3/model/ops';
import { oriented, sampleRing, signedArea2 } from '../../src/f3/model/plan';

const area = (s: ReturnType<typeof solid>) => Math.abs(signedArea2(sampleRing(oriented(s.plan.outer, 1)).pts));

describe('operações forma/3', () => {
  it('local ↔ mundo são inversas com rotação', () => {
    const b = building({ position: [10, -4], rotation: 37 });
    const w = toWorld(b, [3, 5]);
    const l = toLocal(b, w);
    expect(l[0]).toBeCloseTo(3);
    expect(l[1]).toBeCloseTo(5);
  });

  it('empurrar um lado para fora aumenta a área pelo comprimento × distância', () => {
    const s = solid({ plan: { outer: rectPlan(10, 8), holes: [] } });
    expect(pushEdge(s, s.plan.outer[0]!.id, 2)).toBe(true);
    expect(area(s)).toBeCloseTo(100);
    expect(pushEdge(s, s.plan.outer[1]!.id, -3)).toBe(true);
    expect(area(s)).toBeCloseTo(70);
  });

  it('puxar demais é recusado (planta inválida)', () => {
    const s = solid({ plan: { outer: rectPlan(10, 8), holes: [] } });
    expect(pushEdge(s, s.plan.outer[0]!.id, -9)).toBe(false);
    expect(area(s)).toBeCloseTo(80);
  });

  it('arrastar o meio de um lado para fora curva o lado para fora', () => {
    const s = solid({ plan: { outer: rectPlan(10, 8), holes: [] } });
    // Lado 0 vai de (-5,-4) a (5,-4); para fora é z negativo.
    expect(bendEdge(s, s.plan.outer[0]!.id, [0, -6])).toBe(true);
    expect(area(s)).toBeGreaterThan(80 + 10);
    expect(bendEdge(s, s.plan.outer[0]!.id, [0, -2])).toBe(true);
    expect(area(s)).toBeLessThan(80 - 10);
  });

  it('dividir, mover e remover vértice mantém a planta válida', () => {
    const s = solid({ plan: { outer: rectPlan(10, 8), holes: [] } });
    const v = splitEdge(s, s.plan.outer[0]!.id)!;
    expect(s.plan.outer).toHaveLength(5);
    expect(moveVertex(s, v, [0, -7])).toBe(true);
    expect(area(s)).toBeCloseTo(80 + 15);
    expect(removeVertex(s, v)).toBe(true);
    expect(area(s)).toBeCloseTo(80);
  });

  it('girar, espelhar e clonar preservam a área e a validade', () => {
    const s = solid({ plan: { outer: rectPlan(10, 8), holes: [] } });
    rotateSolid(s, 30);
    mirrorSolid(s, 'x');
    expect(planValid(s.plan)).toBe(true);
    expect(area(s)).toBeCloseTo(80);
    const c = cloneSolid(s);
    expect(c.id).not.toBe(s.id);
    expect(c.plan.outer.map((v) => v.id)).not.toEqual(s.plan.outer.map((v) => v.id));
    expect(area(c)).toBeCloseTo(80);
  });
});
