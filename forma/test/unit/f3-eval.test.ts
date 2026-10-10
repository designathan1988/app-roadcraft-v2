import { beforeAll, describe, expect, it } from 'vitest';
import { loadKernel } from '../../src/f3/kernel/kernel';
import { evaluateBuilding } from '../../src/f3/eval/evaluate';
import { building, circlePlan, rectPlan, roofSpec, solid } from '../../src/f3/model/defaults';
import type { RoofKind } from '../../src/f3/model/schema';

beforeAll(async () => {
  await loadKernel();
});

/** Volume e altura máxima da casca avaliada (malha fechada → volume pelo teorema da divergência). */
function measure(ev: ReturnType<typeof evaluateBuilding>) {
  const p = ev.shell.positions,
    ix = ev.shell.indices;
  let vol = 0,
    maxY = -Infinity;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i]! * 3,
      b = ix[i + 1]! * 3,
      c = ix[i + 2]! * 3;
    vol += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
  }
  for (let i = 1; i < p.length; i += 3) maxY = Math.max(maxY, p[i]!);
  return { vol, maxY, tris: ix.length / 3 };
}

describe('avaliação forma/3', () => {
  it('caixa plana sem platibanda tem o volume da caixa', () => {
    const b = building({ solids: [solid({ plan: { outer: rectPlan(10, 8), holes: [] }, height: 6, roof: roofSpec('flat', { parapet: 0 }) })] });
    const ev = evaluateBuilding(b);
    expect(ev.warnings).toEqual([]);
    expect(measure(ev).vol).toBeCloseTo(480, 1);
  });

  it('dois volumes sobrepostos viram um sólido (união, sem contar a sobreposição duas vezes)', () => {
    const b = building({
      solids: [
        solid({ plan: { outer: rectPlan(10, 8), holes: [] }, height: 6, roof: roofSpec('flat', { parapet: 0 }) }),
        solid({ plan: { outer: rectPlan(10, 8, 5, 0), holes: [] }, height: 6, roof: roofSpec('flat', { parapet: 0 }) }),
      ],
    });
    expect(measure(evaluateBuilding(b)).vol).toBeCloseTo(15 * 8 * 6, 1);
  });

  it('subtração abre um pátio e interseção recorta', () => {
    const base = solid({ plan: { outer: rectPlan(20, 20), holes: [] }, height: 6, roof: roofSpec('flat', { parapet: 0 }) });
    const court = solid({ op: 'subtract', plan: { outer: rectPlan(8, 8), holes: [] }, base: -1, height: 10, roof: roofSpec('flat', { parapet: 0 }) });
    expect(measure(evaluateBuilding(building({ solids: [base, court] }))).vol).toBeCloseTo((400 - 64) * 6, 1);
    const cap = solid({ op: 'intersect', plan: { outer: rectPlan(10, 30), holes: [] }, base: 0, height: 3, roof: roofSpec('flat', { parapet: 0 }) });
    expect(measure(evaluateBuilding(building({ solids: [base, cap] }))).vol).toBeCloseTo(10 * 20 * 3, 1);
  });

  it('afunilamento reduz o topo', () => {
    const b = building({ solids: [solid({ plan: { outer: rectPlan(10, 10), holes: [] }, height: 10, taper: 2, roof: roofSpec('flat', { parapet: 0 }) })] });
    // Tronco de pirâmide: h/3 (A1 + A2 + √(A1·A2)) = 10/3 (100 + 36 + 60)
    expect(measure(evaluateBuilding(b)).vol).toBeCloseTo((10 / 3) * (100 + 36 + 60), 0);
  });

  it.each<RoofKind>(['gable', 'hip', 'mansard', 'gambrel', 'shed', 'pyramid', 'dome', 'vault', 'sawtooth', 'terrace', 'flat'])('telhado %s fecha e sobe acima das paredes', (kind) => {
    const b = building({ solids: [solid({ plan: { outer: rectPlan(12, 9), holes: [] }, height: 6, roof: roofSpec(kind) })] });
    const ev = evaluateBuilding(b);
    const m = measure(ev);
    expect(ev.warnings).toEqual([]);
    expect(m.vol).toBeGreaterThan(12 * 9 * 6 - 1);
    expect(m.maxY).toBeGreaterThan(6.3);
  });

  it('cúpula numa base circular sobe o raio', () => {
    const b = building({ solids: [solid({ plan: { outer: circlePlan(6), holes: [] }, height: 8, roof: roofSpec('dome') })] });
    const m = measure(evaluateBuilding(b));
    expect(m.maxY).toBeGreaterThan(8 + 5.5);
  });

  it('volume mais alto atravessando um telhado de duas águas funde (um só sólido)', () => {
    const house = solid({ plan: { outer: rectPlan(12, 8), holes: [] }, height: 5, roof: roofSpec('gable') });
    const tower = solid({ plan: { outer: rectPlan(3, 3, 2, 0), holes: [] }, height: 12, roof: roofSpec('flat', { parapet: 0 }) });
    const ev = evaluateBuilding(building({ solids: [house, tower] }));
    const p = ev.shell.positions;
    // Nenhum triângulo do telhado da casa fica dentro da torre (a união removeu).
    let inside = 0;
    for (let t = 0; t < ev.shell.indices.length; t += 3) {
      const f = ev.faces[ev.shell.faceOf[t / 3]!]!;
      if (f.solid !== house.id || f.kind !== 'roof') continue;
      let cx = 0,
        cz = 0;
      for (let j = 0; j < 3; j++) {
        cx += p[ev.shell.indices[t + j]! * 3]! / 3;
        cz += p[ev.shell.indices[t + j]! * 3 + 2]! / 3;
      }
      if (cx > 0.6 && cx < 3.4 && cz > -1.4 && cz < 1.4) inside++;
    }
    expect(inside).toBe(0);
  });
});

describe('fachada forma/3', () => {
  it('parede curva recebe janelas em cada nível (segmentos contínuos)', async () => {
    const { facadeRule, levelsFor } = await import('../../src/f3/model/defaults');
    const b = building({ levels: levelsFor(2, 4.2, 4.6), solids: [solid({ plan: { outer: circlePlan(6.5), holes: [] }, height: 9, roof: roofSpec('dome'), facade: [facadeRule('win-arched', { mode: 'spacing', value: 3 })] })] });
    const ev = evaluateBuilding(b);
    const byLevel = new Set(ev.placements.map((p) => p.tag.key!.split(':')[1]));
    expect(ev.placements.length).toBeGreaterThanOrEqual(8);
    expect(byLevel.size).toBe(2);
  });

  it('torre que afina distribui pelo trecho visível de cada fileira', async () => {
    const { facadeRule, levelsFor } = await import('../../src/f3/model/defaults');
    const tw = rectPlan(9, 9);
    const tower = solid({ plan: { outer: tw, holes: [] }, height: 30, taper: 2, roof: roofSpec('flat'), facade: [facadeRule('win-casement', { mode: 'spacing', value: 2 })] });
    tower.edges[tw[0]!.id] = { lean: 8 };
    const ev = evaluateBuilding(building({ levels: levelsFor(9, 3.3, 3.6), solids: [tower] }));
    const levels = new Set(ev.placements.map((p) => p.tag.key!.split(':')[1]));
    expect(levels.size).toBe(9);
    expect(ev.warnings).toEqual([]);
  });

  it('janela recorta a parede (vão aberto) e gera caixilho', async () => {
    const { facadeRule, levelsFor } = await import('../../src/f3/model/defaults');
    const plain = evaluateBuilding(building({ levels: levelsFor(1, 3, 3), solids: [solid({ plan: { outer: rectPlan(6, 6), holes: [] }, height: 3, roof: roofSpec('flat', { parapet: 0 }) })] }));
    const withWin = evaluateBuilding(building({ levels: levelsFor(1, 3, 3), solids: [solid({ plan: { outer: rectPlan(6, 6), holes: [] }, height: 3, roof: roofSpec('flat', { parapet: 0 }), facade: [facadeRule('win-casement', { mode: 'count', value: 1 })] })] }));
    expect(withWin.placements).toHaveLength(4);
    expect(withWin.shell.indices.length).toBeGreaterThan(plain.shell.indices.length);
    expect(withWin.parts.inst.length + withWin.parts.meshes.length).toBeGreaterThan(8);
  });
});
