import { describe, expect, it } from 'vitest';
import { migrateV1, normalizeV1 } from '../../src/core/migrate/v1';
import { loadProject } from '../../src/core';
import { validateProject } from '../../src/core/validate';
import { sequentialIds } from '../../src/core/ids';
import { massEdges } from '../../src/geometry/ring';
import { toWorld } from '../../src/geometry/frame';
import { Legacy, fixtures } from './legacy';

describe('migração v1 → forma/2', () => {
  const all = fixtures();

  it.each(Object.keys(all))('%s: migra, valida e preserva contagens', (name) => {
    const v1 = all[name]!;
    const p = migrateV1(v1, { newId: sequentialIds(name) });
    expect(() => validateProject(p)).not.toThrow();
    expect(p.buildings).toHaveLength(v1.volumes.length);
    v1.volumes.forEach((v, i) => {
      const b = p.buildings[i]!;
      expect(b.id).toBe(v.id);
      expect(b.storeys).toHaveLength(v.floors);
      const top = b.storeys.at(-1)!;
      expect(top.elevation + top.height).toBeCloseTo(v.base + v.height, 9);
      const m = b.masses[0]!;
      expect(massEdges(m)).toHaveLength(v.points.length + v.holes.reduce((s: number, h: unknown[]) => s + h.length, 0));
      // Cada face configurada no v1 vira exatamente um ajuste de aresta.
      const configured = Object.values(v.faces).filter((f) => Object.keys(f as object).length).length;
      expect(Object.keys(m.edges)).toHaveLength(configured);
    });
  });

  it('mesma posição no mundo para cada abertura manual (até 1 mm)', () => {
    const v1 = all.openings!;
    const p = migrateV1(v1, { newId: sequentialIds('op') });
    const v = Legacy.validateProject(v1).volumes[0];
    const b = p.buildings[0]!;
    const m = b.masses[0]!;
    const edges = massEdges(m);
    const manual = v.faces['0'].openings;
    expect(b.openings).toHaveLength(manual.length);
    manual.forEach((o: { u: number; y: number }, i: number) => {
      const op = b.openings[i]!;
      const e = edges.find((x) => op.host.kind === 'massEdge' && x.id === op.host.edgeId)!;
      // Centro da abertura no mundo: v1 vs v2.
      const a = v.points[0],
        bb = v.points[1],
        len = Math.hypot(bb[0] - a[0], bb[1] - a[1]);
      const legacy = Legacy.worldPolygon(v, [[a[0] + ((bb[0] - a[0]) / len) * o.u * len, a[1] + ((bb[1] - a[1]) / len) * o.u * len]])[0];
      const t = op.offset / e.length;
      const ours = toWorld(b, [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t]);
      expect(ours[0]).toBeCloseTo(legacy[0], 3);
      expect(ours[1]).toBeCloseTo(legacy[1], 3);
      const storey = b.storeys.find((s) => s.id === op.storeyId)!;
      expect(storey.elevation + op.sill).toBeCloseTo(v.base + o.y, 3);
    });
    expect(b.openings.map((o) => o.fill.type)).toEqual(['door', 'window', 'void']);
  });

  it('é determinística com o mesmo gerador de IDs', () => {
    const a = migrateV1(all.example, { newId: sequentialIds('x') });
    const b = migrateV1(all.example, { newId: sequentialIds('x') });
    expect(a).toEqual(b);
  });

  it('loadProject aceita v1 e v2 e rejeita formatos desconhecidos', () => {
    const p = loadProject(all.example);
    expect(p.schema).toBe('forma/2');
    expect(loadProject(p)).toEqual(p);
    expect(() => loadProject({ version: 3 })).toThrow('Formato de projeto desconhecido.');
  });

  it('normalizeV1 rejeita como o validador antigo', () => {
    const bad = [{ version: 2, volumes: [] }, { version: 1, volumes: [{ points: [[0, 0], [1, 1], [0, 1], [1, 0]] }] }, { version: 1, volumes: [{ points: [[0, 0], [5, 0], [5, 5], [0, 5]], color: 'red' }] }];
    for (const raw of bad) {
      let legacyMsg = '',
        ourMsg = '';
      try {
        Legacy.validateProject(structuredClone(raw));
      } catch (e) {
        legacyMsg = (e as Error).message;
      }
      try {
        normalizeV1(structuredClone(raw));
      } catch (e) {
        ourMsg = (e as Error).message;
      }
      expect(ourMsg).toBe(legacyMsg);
      expect(ourMsg).not.toBe('');
    }
  });

  it('validateProject aponta referências quebradas', () => {
    const p = migrateV1(all.openings, { newId: sequentialIds('y') });
    const broken = structuredClone(p);
    const op = broken.buildings[0]!.openings[0]!;
    if (op.host.kind === 'massEdge') op.host.edgeId = 'nao-existe';
    expect(() => validateProject(broken)).toThrow('Abertura em parede inexistente.');
    const broken2 = structuredClone(p);
    broken2.buildings[0]!.masses[0]!.fromStorey = 'x';
    expect(() => validateProject(broken2)).toThrow('pavimento inexistente');
  });
});

import { History, apply, diff } from '../../src/core/history';

describe('histórico por diferenças', () => {
  it('desfaz e refaz com emendas de lista e remoção de chaves', () => {
    const h = new History<{ a: number[]; o: Record<string, unknown> }>({ a: [1, 2, 3], o: { x: 1, y: 2 } });
    h.commit({ a: [1, 2, 3, 4], o: { x: 1, y: 2 } });
    h.commit({ a: [1, 3, 4], o: { x: 5 } });
    expect(h.undo()).toEqual({ a: [1, 2, 3, 4], o: { x: 1, y: 2 } });
    expect(h.undo()).toEqual({ a: [1, 2, 3], o: { x: 1, y: 2 } });
    expect(h.canUndo).toBe(false);
    expect(h.redo()).toEqual({ a: [1, 2, 3, 4], o: { x: 1, y: 2 } });
    expect(h.redo()).toEqual({ a: [1, 3, 4], o: { x: 5 } });
    expect(h.commit({ a: [1, 3, 4], o: { x: 5 } })).toBe(false);
  });

  it('em projetos reais guarda só o que mudou', () => {
    const p = migrateV1(fixtures()['stress-120'], { newId: sequentialIds('h') });
    const h = new History(p);
    const q = structuredClone(p);
    q.buildings[7]!.position = [1, 2];
    h.commit(q);
    expect(h.storedBytes).toBeLessThan(500);
    expect(h.undo()).toEqual(p);
  });

  it('diff/apply é identidade em 200 mutações aleatórias', () => {
    let s: unknown = { list: [1, 2, 3], m: { k: 'v' } };
    for (let i = 0; i < 200; i++) {
      const n = JSON.parse(JSON.stringify(s));
      const r = (i * 7919) % 5;
      if (r === 0) n.list.splice(i % (n.list.length + 1), 0, i);
      else if (r === 1 && n.list.length) n.list.splice(i % n.list.length, 1);
      else if (r === 2) n.m['k' + (i % 7)] = { deep: [i] };
      else if (r === 3) delete n.m['k' + (i % 7)];
      else n.list = n.list.map((x: number) => x + 1);
      const out = apply(JSON.parse(JSON.stringify(s)), diff(s, n));
      expect(out).toEqual(n);
      s = n;
    }
  });
});
