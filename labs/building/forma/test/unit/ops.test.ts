import { describe, expect, it } from 'vitest';
import type { Building, Project, Vec2 } from '../../src/core/schema';
import { SCHEMA } from '../../src/core/schema';
import { validateProject } from '../../src/core/validate';
import { sequentialIds } from '../../src/core/ids';
import { massEdges } from '../../src/geometry/ring';
import { toWorld } from '../../src/geometry/frame';
import { area, shape } from '../../src/geometry/polygon';
import {
  addOpening, applyEdgeToAll, applyPattern, cloneBuilding, cutBuilding, floorsOf, heightOf, mainMass, mirror, newBuilding, outerOf,
  repeatBuildings, scaleFootprint, setBase, setFloors, setHeight, setRotation, setback, unionBuildings, worldPolygon, baseOf,
} from '../../src/editor/ops';

const ids = () => sequentialIds('t');
const asProject = (buildings: Building[]): Project => ({ schema: SCHEMA, name: 'T', lots: [], buildings, styles: [], meta: { createdWith: 'test' } });
const valid = (bs: Building[]) => expect(() => validateProject(asProject(bs))).not.toThrow();

function rect(w = 10, d = 8, pos: Vec2 = [0, 0], newId = ids()) {
  return newBuilding({ name: 'R', points: shape('rect', w, d), position: pos, base: 0, height: 9.6, floors: 3 }, newId);
}

/** Centro de cada abertura no mundo (x, z) e altura absoluta da base. */
function openingWorld(b: Building) {
  const m = mainMass(b),
    edges = massEdges(m);
  return b.openings.map((o) => {
    const e = edges.find((x) => o.host.kind === 'massEdge' && x.id === o.host.edgeId)!;
    const t = o.offset / e.length;
    const w = toWorld(b, [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t]);
    const s = b.storeys.find((x) => x.id === o.storeyId)!;
    return { x: w[0], z: w[1], y: s.elevation + o.sill };
  });
}

describe('pavimentos', () => {
  it('setFloors mantém o pé-direito e os IDs; remove aberturas de pavimentos apagados', () => {
    const newId = ids();
    const b = rect(10, 8, [0, 0], newId);
    const e = massEdges(mainMass(b))[0]!;
    addOpening(b, { edgeId: e.id, x: 2, width: 1.2, y: 7, height: 1.5, kind: 'window' }, newId);
    const keep = b.storeys.map((s) => s.id);
    setFloors(b, 2, newId);
    expect(floorsOf(b)).toBe(2);
    expect(heightOf(b)).toBeCloseTo(6.4, 9);
    expect(b.storeys.map((s) => s.id)).toEqual(keep.slice(0, 2));
    expect(b.openings).toHaveLength(0);
    setFloors(b, 5, newId);
    expect(heightOf(b)).toBeCloseTo(16, 9);
    valid([b]);
  });

  it('setHeight escala pavimentos e peitoris; setBase desloca tudo', () => {
    const newId = ids();
    const b = rect(10, 8, [0, 0], newId);
    const e = massEdges(mainMass(b))[0]!;
    const o = addOpening(b, { edgeId: e.id, x: 2, width: 1.2, y: 4, height: 1.5, kind: 'window' }, newId)!;
    const sill = o.sill;
    setHeight(b, 19.2);
    expect(heightOf(b)).toBeCloseTo(19.2, 9);
    expect(b.openings[0]!.sill).toBeCloseTo(sill * 2, 9);
    setBase(b, 3);
    expect(baseOf(b)).toBe(3);
    valid([b]);
  });
});

describe('forma da base', () => {
  it('scaleFootprint mantém aberturas na mesma posição relativa', () => {
    const newId = ids();
    const b = rect(10, 8, [0, 0], newId);
    const e = massEdges(mainMass(b))[0]!; // aresta de 10 m ao longo de x
    addOpening(b, { edgeId: e.id, x: 2, width: 1, y: 1, height: 1.5, kind: 'window' }, newId);
    const before = b.openings[0]!.offset / e.length;
    scaleFootprint(b, 'width', 20);
    const e2 = massEdges(mainMass(b))[0]!;
    expect(e2.length).toBeCloseTo(20, 9);
    expect(b.openings[0]!.offset / e2.length).toBeCloseTo(before, 9);
  });

  it('espelhar mantém a área no mundo e leva as aberturas para o lado espelhado', () => {
    const newId = ids();
    const b = newBuilding({ name: 'L', points: shape('l', 12, 9), position: [30, -4], rotation: 30, base: 0, height: 6.4, floors: 2 }, newId);
    const edges = massEdges(mainMass(b));
    addOpening(b, { edgeId: edges[0]!.id, x: 1, width: 1, y: 0.5, height: 2, kind: 'door' }, newId);
    mainMass(b).edges[edges[2]!.id] = { ...mainMass(b).edges[edges[2]!.id], wall: '#ff0000' };
    const footprint = area(worldPolygon(b)[0]!);
    const beforeOpening = openingWorld(b)[0]!;
    mirror(b);
    expect(area(worldPolygon(b)[0]!)).toBeCloseTo(footprint, 6);
    const after = openingWorld(b)[0]!;
    // Espelho em torno do centro local: a distância ao eixo de simetria se mantém.
    expect(after.y).toBeCloseTo(beforeOpening.y, 9);
    expect(Object.values(mainMass(b).edges).some((o) => o.wall === '#ff0000')).toBe(true);
    // A aresta pintada continua sendo uma aresta com o mesmo comprimento.
    const painted = Object.entries(mainMass(b).edges).find(([, o]) => o.wall === '#ff0000')![0];
    expect(massEdges(mainMass(b)).find((e) => e.id === painted)!.length).toBeCloseTo(edges[2]!.length, 9);
    valid([b]);
  });

  it('girar não move a base no mundo além da rotação em torno do próprio centro', () => {
    const b = rect(10, 8, [5, 5]);
    // Base deslocada da origem local.
    mainMass(b).outer.vertices.forEach((v) => (v.p = [v.p[0] + 7, v.p[1] - 3]));
    const c0 = worldPolygon(b)[0]!.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
    setRotation(b, 90);
    const c1 = worldPolygon(b)[0]!.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
    expect(c1[0]).toBeCloseTo(c0[0], 9);
    expect(c1[1]).toBeCloseTo(c0[1], 9);
  });
});

describe('booleanas com IDs estáveis', () => {
  it('recortar ao meio mantém fachadas e aberturas das paredes que sobram', () => {
    const newId = ids();
    const b = rect(20, 8, [3, 2], newId);
    const m = mainMass(b);
    const edges = massEdges(m);
    // Aresta inferior (z = -4) com cor própria e duas portas, uma em cada metade.
    m.edges[edges[0]!.id] = { wall: '#123456' };
    addOpening(b, { edgeId: edges[0]!.id, x: 2, width: 1.2, y: 0, height: 2.4, kind: 'door' }, newId);
    addOpening(b, { edgeId: edges[0]!.id, x: 16, width: 1.2, y: 0, height: 2.4, kind: 'door' }, newId);
    // Uma porta bem no meio, que o recorte remove.
    addOpening(b, { edgeId: edges[0]!.id, x: 9.4, width: 1.2, y: 0, height: 2.4, kind: 'door' }, newId);
    const worldBefore = openingWorld(b);
    const parts = cutBuilding(b, [[2, -10], [4, -10], [4, 10], [2, 10]], newId)!;
    expect(parts).toHaveLength(2);
    expect(parts[0]!.id).toBe(b.id);
    valid(parts);
    const all = parts.flatMap(openingWorld);
    expect(all).toHaveLength(2);
    for (const w of [worldBefore[0]!, worldBefore[1]!]) {
      const hit = all.find((x) => Math.hypot(x.x - w.x, x.z - w.z) < 1e-6);
      expect(hit, 'abertura preservada no mesmo lugar').toBeDefined();
    }
    for (const p of parts) {
      const colored = Object.values(mainMass(p).edges).filter((o) => o.wall === '#123456');
      expect(colored).toHaveLength(1);
      // Partes centradas na própria base.
      const bd = outerOf(p).reduce((s, q) => [Math.min(s[0], q[0]), Math.max(s[1], q[0])], [Infinity, -Infinity]);
      expect(bd[0] + bd[1]).toBeCloseTo(0, 9);
    }
  });

  it('recorte que não alcança a base devolve null', () => {
    expect(cutBuilding(rect(), [[50, 50], [52, 50], [52, 52], [50, 52]])).toBeNull();
  });

  it('pátio: recorte interno cria um furo e mantém os IDs dos vértices externos', () => {
    const b = rect(20, 16);
    const outerIds = mainMass(b).outer.vertices.map((v) => v.id).sort();
    const parts = cutBuilding(b, [[-3, -2], [3, -2], [3, 2], [-3, 2]])!;
    expect(parts).toHaveLength(1);
    expect(mainMass(parts[0]!).holes).toHaveLength(1);
    expect(mainMass(parts[0]!).outer.vertices.map((v) => v.id).sort()).toEqual(outerIds);
    valid(parts);
  });

  it('unir dois retângulos vizinhos preserva os ajustes de fachada de ambos', () => {
    const newId = ids();
    const a = rect(26, 6, [0, -8], newId),
      b = rect(6, 14, [10, 2], newId);
    mainMass(a).edges[massEdges(mainMass(a))[0]!.id] = { wall: '#aa0000' };
    mainMass(b).edges[massEdges(mainMass(b))[1]!.id] = { pattern: 'blank' };
    addOpening(b, { edgeId: massEdges(mainMass(b))[1]!.id, x: 5, width: 1, y: 3.5, height: 1.5, kind: 'window' }, newId);
    const before = openingWorld(b)[0]!;
    const parts = unionBuildings([a, b], newId);
    expect(parts).toHaveLength(1);
    const u = parts[0]!;
    valid(parts);
    const ov = Object.values(mainMass(u).edges);
    expect(ov.some((o) => o.wall === '#aa0000')).toBe(true);
    expect(ov.some((o) => o.pattern === 'blank')).toBe(true);
    const after = openingWorld(u)[0]!;
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('unir exige mesma altura e elevação', () => {
    const a = rect(),
      b = rect(10, 8, [5, 0]);
    setHeight(b, 12);
    expect(() => unionBuildings([a, b])).toThrow('mesma altura e elevação');
  });
});

describe('cópias, recuo e fachadas', () => {
  it('cloneBuilding gera IDs novos sem referências cruzadas', () => {
    const newId = ids();
    const b = rect(10, 8, [0, 0], newId);
    addOpening(b, { edgeId: massEdges(mainMass(b))[1]!.id, x: 1, width: 1, y: 1, height: 1, kind: 'window' }, newId);
    const c = cloneBuilding(b, newId);
    const idsOf = (x: Building) => JSON.stringify(x).match(/t-\d{4}/g)!;
    const shared = idsOf(c).filter((id) => idsOf(b).includes(id));
    expect(shared).toEqual([]);
    valid([b, c]);
  });

  it('repetir posiciona cópias lado a lado com intervalo', () => {
    const b = rect(10, 8, [0, 0]);
    const copies = repeatBuildings([b], 3, 2);
    expect(copies.map((c) => c.position[0])).toEqual([12, 24, 36]);
    valid([b, ...copies]);
  });

  it('recuo cria um pavimento sobre o topo com 77% da base', () => {
    const b = rect(10, 8);
    const s = setback(b);
    expect(baseOf(s)).toBeCloseTo(9.78, 9);
    expect(floorsOf(s)).toBe(1);
    expect(heightOf(s)).toBeCloseTo(3.2, 9);
    expect(area(outerOf(s))).toBeCloseTo(80 * 0.77 * 0.77, 6);
  });

  it('desenhar abertura torna a aresta manual; aplicar distribuição limpa as aberturas', () => {
    const b = rect();
    const e = massEdges(mainMass(b))[0]!;
    const o = addOpening(b, { edgeId: e.id, x: 1, width: 1.2, y: 3.6, height: 1.8, kind: 'window' })!;
    expect(mainMass(b).edges[e.id]!.manual).toBe(true);
    expect(b.storeys.findIndex((s) => s.id === o.storeyId)).toBe(1);
    expect(o.sill).toBeCloseTo(0.4, 9);
    applyPattern(b, e.id, 'storefront');
    expect(b.openings).toHaveLength(0);
    expect(mainMass(b).edges[e.id]).toEqual({ pattern: 'storefront', manual: false });
    expect(applyEdgeToAll(b, e.id)).toBe(true);
    expect(mainMass(b).facade.pattern).toBe('storefront');
    expect(mainMass(b).edges).toEqual({});
  });
});
