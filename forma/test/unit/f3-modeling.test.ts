import { beforeAll, describe, expect, it } from 'vitest';
import { loadKernel } from '../../src/f3/kernel/kernel';
import { evaluateBuilding } from '../../src/f3/eval/evaluate';
import { building, circlePlan, facadeRule, planVertices, rectPlan, roofSpec, solid } from '../../src/f3/model/defaults';
import { extrudeSide, insetSide, insetTop, offsetCopy, offsetPlan, offsetSolid, setSolidSize, splitAtHeight } from '../../src/f3/model/modeling';
import { sampleRing, signedArea2, oriented } from '../../src/f3/model/plan';
import type { Solid } from '../../src/f3/model/schema';

beforeAll(async () => {
  await loadKernel();
});

function volume(b: ReturnType<typeof building>) {
  const ev = evaluateBuilding(b);
  const p = ev.shell.positions,
    ix = ev.shell.indices;
  let vol = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i]! * 3,
      c1 = ix[i + 1]! * 3,
      c2 = ix[i + 2]! * 3;
    vol += (p[a]! * (p[c1 + 1]! * p[c2 + 2]! - p[c1 + 2]! * p[c2 + 1]!) - p[a + 1]! * (p[c1]! * p[c2 + 2]! - p[c1 + 2]! * p[c2]!) + p[a + 2]! * (p[c1]! * p[c2 + 1]! - p[c1 + 1]! * p[c2]!)) / 6;
  }
  return { vol, warnings: ev.warnings };
}

const box = (extra: Partial<Solid> = {}) => solid({ plinth: 0, plan: { outer: rectPlan(10, 8), holes: [] }, height: 6, roof: roofSpec('flat', { parapet: 0 }), ...extra });
const area = (s: Solid) => Math.abs(signedArea2(sampleRing(oriented(s.plan.outer, 1)).pts));

describe('bisel (parâmetro do volume)', () => {
  it('chanfro reto de 1 m em todas as arestas do topo tira o tronco de pirâmide', () => {
    const b = building({ solids: [box({ bevel: { top: 1, bottom: 0, segments: 1, profile: 0 } })] });
    // 5 m retos + tronco de 1 m de 10×8 a 8×6 (prismatoide: h/6·(A1 + 4Am + A2)).
    expect(volume(b).vol).toBeCloseTo(80 * 5 + (80 + 4 * 63 + 48) / 6, 1);
  });

  it('arredondado tira menos que o chanfro; bisel na base também conta', () => {
    const round = volume(building({ solids: [box({ bevel: { top: 1, bottom: 0, segments: 8, profile: 1 } })] })).vol;
    expect(round).toBeGreaterThan(463.4);
    expect(round).toBeLessThan(480);
    const both = volume(building({ solids: [box({ bevel: { top: 1, bottom: 1, segments: 1, profile: 0 } })] })).vol;
    expect(both).toBeCloseTo(80 * 4 + 2 * ((80 + 4 * 63 + 48) / 6), 1);
  });

  it('bisel num lado só: prisma triangular ao longo daquele lado', () => {
    const s = box();
    s.edges[s.plan.outer[0]!.id] = { bevel: 1 };
    expect(volume(building({ solids: [s] })).vol).toBeCloseTo(480 - 0.5 * 10, 1);
  });

  it('emenda com outro volume não ganha bisel (sem sulco): anexo + caixa = caixa maior', () => {
    const bev = { top: 1, bottom: 0, segments: 1, profile: 0 };
    const s = box({ bevel: bev });
    const b = building({ solids: [s] });
    const n = extrudeSide(b, s, s.plan.outer[0]!.id, 4)!;
    n.bevel = { ...bev };
    const one = volume(building({ solids: [box({ bevel: bev, plan: { outer: rectPlan(10, 12, 0, -2), holes: [] } })] })).vol;
    expect(volume(b).vol).toBeCloseTo(one, 3);
  });

  it('a fachada não põe janela na faixa do bisel', () => {
    const s = box({ bevel: { top: 2.5, bottom: 0, segments: 1, profile: 0 }, facade: [] });
    const ev = evaluateBuilding(building({ solids: [s] }));
    expect(ev.faces.some((f) => f.kind === 'bevel')).toBe(true);
    expect(ev.faces.filter((f) => f.kind === 'side').every((f) => f.frame)).toBe(true);
  });
});

describe('offset da planta', () => {
  it('retângulo cresce 1 m de cada lado; com cantos redondos perde (4 − π)', () => {
    const s = box();
    expect(offsetSolid(s, 1)).toBe(true);
    expect(area(s)).toBeCloseTo(120, 3);
    const r = box();
    const plan = offsetPlan(r, 1, 'round')!;
    // Arco amostrado com tolerância de corda de 2 cm: um pouco menos que o exato.
    expect(area({ ...r, plan })).toBeCloseTo(120 - (4 - Math.PI), 0);
    const c = box();
    expect(area({ ...c, plan: offsetPlan(c, 1, 'chamfer')! })).toBeCloseTo(120 - 4 * 0.5, 3);
  });

  it('círculo continua círculo (arcos concêntricos)', () => {
    const s = solid({ plan: { outer: circlePlan(5), holes: [] } });
    expect(offsetSolid(s, 1)).toBe(true);
    expect(area(s)).toBeCloseTo(Math.PI * 36, 0);
    expect(s.plan.outer.every((v) => Math.abs(Math.hypot(v.p[0], v.p[1]) - 6) < 1e-6)).toBe(true);
  });

  it('planta em L encolhe certo no canto côncavo; encolher demais é recusado', () => {
    const L = solid({ plan: { outer: planVertices([[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]), holes: [] } });
    const before = area(L);
    expect(offsetSolid(L, -1)).toBe(true);
    // L 10×10 com braço de 4: offset −1 → braços de 2 m: área = 8·2 + 2·6 = 28... pelo contorno: (8×2)+(2×6).
    expect(area(L)).toBeCloseTo(8 * 2 + 2 * 6, 3);
    expect(before).toBeCloseTo(64, 3);
    expect(offsetSolid(L, -3)).toBe(false);
  });

  it('cópia com offset vira volume novo com IDs próprios', () => {
    const s = box();
    const b = building({ solids: [s] });
    const c = offsetCopy(b, s, 0.5)!;
    expect(b.solids).toHaveLength(2);
    expect(c.plan.outer.some((v) => s.plan.outer.some((w) => w.id === v.id))).toBe(false);
  });
});

describe('extrudar e inset de face lateral', () => {
  it('extrudar para fora soma um anexo do tamanho da face; para dentro recorta', () => {
    const s = box();
    const b = building({ solids: [s] });
    const edge = s.plan.outer[0]!.id; // lado de 10 m
    expect(extrudeSide(b, s, edge, 3)).not.toBeNull();
    expect(volume(b).vol).toBeCloseTo(480 + 10 * 3 * 6, 0);
    const s2 = box();
    const b2 = building({ solids: [s2] });
    extrudeSide(b2, s2, s2.plan.outer[0]!.id, -2);
    expect(volume(b2).vol).toBeCloseTo(480 - 10 * 2 * 6, 0);
    // Encostados sem sobreposição: medidas exatas e um sólido só, fechado.
    const s3 = box();
    const b3 = building({ solids: [s3] });
    const n = extrudeSide(b3, s3, s3.plan.outer[0]!.id, 3)!;
    const ys = n.plan.outer.map((v) => v.p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(3, 9);
    const r = volume(b3);
    expect(r.warnings).toEqual([]);
    expect(r.vol).toBeCloseTo(660, 6);
  });

  it('inset com margem e profundidade negativa abre um nicho (loggia)', () => {
    const s = box();
    const b = building({ solids: [s] });
    insetSide(b, s, s.plan.outer[0]!.id, 1, -1.5);
    expect(volume(b).vol).toBeCloseTo(480 - 8 * 4 * 1.5, 0);
  });

  it('em lado curvo o anexo segue o arco', () => {
    const s = solid({ plinth: 0, plan: { outer: circlePlan(5), holes: [] }, height: 6, roof: roofSpec('flat', { parapet: 0 }) });
    const b = building({ solids: [s] });
    const before = volume(b).vol;
    const n = extrudeSide(b, s, s.plan.outer[0]!.id, 1)!;
    expect(n.plan.outer.filter((v) => v.bulge).length).toBe(2);
    // Quarto de anel de 5 a 6 m: π/4·(36 − 25)·6.
    expect(volume(b).vol - before).toBeCloseTo((Math.PI / 4) * 11 * 6, 0);
  });
});

describe('platibanda de volumes fundidos', () => {
  it('anexo de mesma altura: a platibanda segue a união, sem mureta na emenda', () => {
    const withParapet = (extra: Partial<Solid> = {}) => box({ roof: roofSpec('flat', { parapet: 1 }), ...extra });
    const s = withParapet();
    const b = building({ solids: [s] });
    extrudeSide(b, s, s.plan.outer[0]!.id, 4);
    const merged = volume(b).vol;
    // Um volume só de 10 × 12 com a mesma platibanda.
    const one = volume(building({ solids: [withParapet({ plan: { outer: rectPlan(10, 12, 0, -2), holes: [] } })] })).vol;
    expect(merged).toBeCloseTo(one, 3);
  });
});

describe('cômodos atrás das janelas', () => {
  it('não furam a laje de um volume mais baixo que o pavimento nem a parede oposta', () => {
    // Volume de 3 m (pavimento de 3,4 m) e só 2,4 m de fundo: janelas dos dois lados.
    const s = box({ plan: { outer: rectPlan(10, 2.4), holes: [] }, height: 3, roof: roofSpec('flat', { parapet: 0 }), facade: [facadeRule('win-casement', { mode: 'max', value: 3 })] });
    const b = building({ solids: [s] });
    const ev = evaluateBuilding(b);
    const P = ev.shell.positions;
    let maxY = 0;
    for (let i = 1; i < P.length; i += 3) maxY = Math.max(maxY, P[i]!);
    // O topo continua fechado: nenhum triângulo de cômodo acima da laje, nenhum furo.
    const top = ev.faces.findIndex((f) => f.kind === 'top' && f.solid === s.id);
    let topArea = 0;
    for (let t = 0; t < ev.shell.indices.length / 3; t++) {
      if (ev.shell.faceOf[t] !== top) continue;
      const [a, c1, c2] = [0, 1, 2].map((j) => ev.shell.indices[t * 3 + j]! * 3);
      const ux = P[c1!]! - P[a!]!, uz = P[c1! + 2]! - P[a! + 2]!, vx = P[c2!]! - P[a!]!, vz = P[c2! + 2]! - P[a! + 2]!;
      topArea += Math.abs(ux * vz - uz * vx) / 2;
    }
    expect(topArea).toBeCloseTo(24, 3);
    expect(maxY).toBeCloseTo(3, 6);
    // Sem furos: a malha continua fechada com o volume perto da caixa menos vãos e cômodos.
    expect(volume(b).vol).toBeGreaterThan(0);
  });
});

describe('inset do topo, escala e divisão', () => {
  it('inset do topo com altura ergue o recuado; com profundidade negativa afunda', () => {
    const s = box();
    const b = building({ solids: [s] });
    insetTop(b, s, 2, 3);
    expect(b.solids).toHaveLength(2);
    expect(b.solids[1]!.base).toBe(6);
    expect(area(b.solids[1]!)).toBeCloseTo(6 * 4, 3);
    const s2 = box();
    const b2 = building({ solids: [s2] });
    insetTop(b2, s2, 2, -2);
    expect(volume(b2).vol).toBeCloseTo(480 - 6 * 4 * 2, 0);
  });

  it('largura e profundidade exatas', () => {
    const s = box();
    expect(setSolidSize(s, 12, 8)).toBe(true);
    expect(area(s)).toBeCloseTo(96, 3);
  });

  it('dividir na altura não muda o volume e leva as peças de cima', () => {
    const s = box({ taper: 1 });
    const b = building({ solids: [s], items: [{ id: 'w', type: 'win-casement', params: {}, host: { kind: 'face', solid: s.id, edge: s.plan.outer[0]!.id, u: 5, y: 4 } }] });
    const before = volume(b).vol;
    const up = splitAtHeight(b, s, 2.5)!;
    expect(b.solids).toHaveLength(2);
    expect(volume(b).vol).toBeCloseTo(before, 1);
    const h = b.items[0]!.host;
    expect(h.kind === 'face' && h.solid === up.id && Math.abs(h.y - (4 - 2.5 * Math.hypot(1, 1 / 6))) < 1e-6 && up.plan.outer.some((v) => v.id === h.edge)).toBe(true);
  });
});
