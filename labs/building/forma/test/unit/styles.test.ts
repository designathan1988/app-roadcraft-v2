import { describe, expect, it } from 'vitest';
import { BUILTIN_STYLES, resolveSplit, styleFacade, validateStylePack, type SplitNode } from '../../src/styles';

const w = { kind: 'wall' } as const;
const sizes = (nodes: SplitNode[], L: number) => resolveSplit(nodes, L).map((p) => +(p.u1 - p.u0).toFixed(4));

describe('split no estilo CGA', () => {
  it('absoluto, flutuante e relativo (exemplo da documentação)', () => {
    expect(sizes([{ size: 2, tile: w }, { size: '~1', tile: w }, { size: "'0.2", tile: w }], 10)).toEqual([2, 6, 2]);
  });
  it('flutuantes na proporção dos valores', () => {
    expect(sizes([{ size: '~1', tile: w }, { size: '~3', tile: w }], 10)).toEqual([2.5, 7.5]);
  });
  it('estouro: corta o bloco e descarta os seguintes', () => {
    expect(sizes([{ size: "'0.5", tile: w }, { size: "'0.6", tile: w }, { size: 3, tile: w }], 10)).toEqual([5, 5]);
  });
  it('repetição com flutuante preenche sem cortar', () => {
    const r = sizes([{ size: 1, tile: w }, { repeat: [{ size: '~3', tile: w }, { size: 1, tile: w }] }, { size: 1, tile: w }], 20);
    expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(20, 6);
    expect(r).toHaveLength(2 + 2 * 5); // 18 m / (3 + 1) ≈ 4,5 → 5 cópias
  });
  it('repetição só com absolutos: quantas couberem, sobra no fim', () => {
    expect(sizes([{ repeat: [{ size: 3, tile: w }] }], 10)).toEqual([3, 3, 3]);
  });
  it('fachada curta demais não gera nada inválido', () => {
    expect(resolveSplit([{ size: 1, tile: w }, { repeat: [{ size: 2, tile: w }] }], 0.5).every((p) => p.u1 <= 0.5 + 1e-9)).toBe(true);
    expect(resolveSplit([{ size: 1, tile: w }], 0)).toEqual([]);
  });
});

describe('estilos incluídos', () => {
  it('todos são válidos', () => {
    for (const s of BUILTIN_STYLES) expect(validateStylePack(s), s.name).toEqual([]);
  });
  it('validação aponta erros em português', () => {
    const bad = { ...BUILTIN_STYLES[0]!, id: 'x y', materials: { wall: { color: 'red' }, trim: { color: '#000000' } } };
    const e = validateStylePack(bad);
    expect(e.join(' ')).toContain('ID do estilo inválido');
    expect(e.join(' ')).toContain('Cor do material parede');
  });
  it('fachadas de 3 a 40 m, 1 a 12 pavimentos: aberturas dentro da parede e sem sobreposição', () => {
    for (const s of BUILTIN_STYLES)
      for (const len of [3, 5.5, 8, 13, 21, 40])
        for (const n of [1, 2, 5, 12]) {
          const floors = Array.from({ length: n }, (_, i) => ({ y0: i * 3.2, h: 3.2 }));
          const f = styleFacade(s, len, floors, n * 3.2);
          for (const o of f.openings) {
            expect(o.s - o.w / 2, `${s.name} ${len} m`).toBeGreaterThanOrEqual(-1e-9);
            expect(o.s + o.w / 2).toBeLessThanOrEqual(len + 1e-9);
            expect(o.y + o.h).toBeLessThanOrEqual(n * 3.2 + 1e-9);
          }
          const byFloor = new Map<number, typeof f.openings>();
          for (const o of f.openings) byFloor.set(o.storey, [...(byFloor.get(o.storey) ?? []), o]);
          for (const list of byFloor.values()) {
            const sorted = [...list].sort((a, b) => a.s - b.s);
            for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.s - sorted[i]!.w / 2).toBeGreaterThanOrEqual(sorted[i - 1]!.s + sorted[i - 1]!.w / 2 - 1e-9);
          }
          if (len >= 8) expect(f.openings.length, `${s.name} ${len} m ${n} pav.`).toBeGreaterThan(0);
        }
  });
});

import { exampleProject } from '../../src/editor/example';
import { buildBuildingParts } from '../../src/geometry/mass-parts';
import { applyStyle } from '../../src/editor/ops';
import { loadProject } from '../../src/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('estilos nos edifícios', () => {
  const custom = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/styles/ornamentado.json'), 'utf8'));
  it('cada estilo incluído gera peças finitas e diferentes do ritmo automático', () => {
    for (const s of BUILTIN_STYLES) {
      const p = exampleProject();
      const b = p.buildings[0]!;
      const before = buildBuildingParts(b);
      applyStyle(b, s);
      const after = buildBuildingParts(b);
      expect(after.boxes.every((x) => [...x.pos, ...x.size].every(Number.isFinite)), s.name).toBe(true);
      expect(after.walls.some((w) => w.mat.texture === s.materials.wall.texture)).toBe(true);
      expect(JSON.stringify(after.walls.map((w) => w.holes.length))).not.toBe(JSON.stringify(before.walls.map((w) => w.holes.length)));
    }
  });
  it('estilo próprio no projeto: valida, gera módulos e um estilo inválido é recusado', () => {
    const p = exampleProject();
    p.styles.push(custom);
    applyStyle(p.buildings[0]!, custom);
    const loaded = loadProject(p);
    expect(loaded.styles[0]!.id).toBe('meu:ornamentado');
    const parts = buildBuildingParts(loaded.buildings[0]!, { styles: (id) => loaded.styles.find((s) => s.id === id) });
    expect(parts.modules.length).toBeGreaterThan(0);
    const bad = structuredClone(p);
    bad.styles[0]!.materials.wall.color = 'azul';
    expect(() => loadProject(bad)).toThrow(/Estilo "Ornamentado \(módulos\)": Cor do material parede/);
  });
  it('remover o estilo volta ao ritmo automático', () => {
    const p = exampleProject();
    const b = p.buildings[0]!;
    const plain = JSON.stringify(buildBuildingParts(b).walls.map((w) => w.holes.length));
    applyStyle(b, BUILTIN_STYLES[1]!);
    applyStyle(b, null);
    expect(b.styleRef).toBeUndefined();
    expect(JSON.stringify(buildBuildingParts(b).walls.map((w) => w.holes.length))).toBe(plain);
  });
});
