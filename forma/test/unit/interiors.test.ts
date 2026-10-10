import { describe, expect, it } from 'vitest';
import type { Opening, Vec2, WallGraph } from '../../src/core/schema';
import { sequentialIds } from '../../src/core/ids';
import { addWall, removeWall, snapToGraph, wallEnds, wallLength } from '../../src/geometry/walls';
import { detectRooms, matchRooms, storeySegments } from '../../src/geometry/rooms';

const square: Vec2[] = [[0, 0], [10, 0], [10, 8], [0, 8]];
const empty = (): WallGraph => ({ nodes: [], walls: [] });
const rooms = (g: WallGraph, outer: Vec2[] = square, holes: Vec2[][] = []) => detectRooms(storeySegments(g, [outer, ...holes]), [outer], holes);

describe('grafo de paredes', () => {
  it('parede em X divide as duas e compartilha o nó', () => {
    const g = empty(),
      id = sequentialIds('w');
    addWall(g, [5, 0], [5, 8], { newId: id });
    addWall(g, [0, 4], [10, 4], { newId: id });
    expect(g.walls).toHaveLength(4);
    const center = g.nodes.filter((n) => n.p[0] === 5 && n.p[1] === 4);
    expect(center).toHaveLength(1);
    expect(g.walls.filter((w) => w.a === center[0]!.id || w.b === center[0]!.id)).toHaveLength(4);
  });

  it('divisão mantém o ID na primeira parte e redistribui as portas', () => {
    const g = empty(),
      id = sequentialIds('w');
    const [first] = addWall(g, [0, 4], [10, 4], { newId: id });
    const openings: Opening[] = [
      { id: 'o1', host: { kind: 'wall', storeyId: 's', wallId: first! }, storeyId: 's', offset: 2, sill: 0, width: 0.9, height: 2.1, fill: { type: 'door' } },
      { id: 'o2', host: { kind: 'wall', storeyId: 's', wallId: first! }, storeyId: 's', offset: 8, sill: 0, width: 0.9, height: 2.1, fill: { type: 'door' } },
    ];
    addWall(g, [6, 0], [6, 4], { newId: id, openings, storeyId: 's' });
    const original = g.walls.find((w) => w.id === first)!;
    expect(wallLength(g, original)).toBeCloseTo(6, 9);
    const second = g.walls.find((w) => w.splitFrom === first)!;
    expect(wallLength(g, second)).toBeCloseTo(4, 9);
    expect(openings[0]!.host).toMatchObject({ wallId: first });
    expect(openings[1]!.host).toMatchObject({ wallId: second.id });
    expect(openings[1]!.offset).toBeCloseTo(2, 9);
  });

  it('remover parede apaga nós soltos e suas portas', () => {
    const g = empty();
    const [w] = addWall(g, [0, 4], [10, 4]);
    const left = removeWall(g, w!, [{ id: 'o', host: { kind: 'wall', storeyId: 's', wallId: w! }, storeyId: 's', offset: 1, sill: 0, width: 1, height: 2, fill: { type: 'door' } }]);
    expect(g.walls).toHaveLength(0);
    expect(g.nodes).toHaveLength(0);
    expect(left).toHaveLength(0);
  });

  it('encaixe prefere nós, depois paredes, depois o contorno', () => {
    const g = empty();
    addWall(g, [5, 0], [5, 8]);
    expect(snapToGraph(g, [5.1, 0.1]).kind).toBe('node');
    expect(snapToGraph(g, [5.1, 3]).p).toEqual([5, 3]);
    const edge: [Vec2, Vec2][] = [[[0, 8], [10, 8]]];
    expect(snapToGraph(g, [2, 7.9], edge).p).toEqual([2, 8]);
  });
});

describe('cômodos', () => {
  it('sem paredes internas: um cômodo com a área da base', () => {
    const r = rooms(empty());
    expect(r).toHaveLength(1);
    expect(r[0]!.area).toBeCloseTo(80, 6);
  });

  it('parede de ponta a ponta divide em dois', () => {
    const g = empty();
    addWall(g, [4, 0], [4, 8]);
    const r = rooms(g).map((x) => Math.round(x.area)).sort((a, b) => a - b);
    expect(r).toEqual([32, 48]);
  });

  it('cruz divide em quatro; parede solta não cria cômodo', () => {
    const g = empty();
    addWall(g, [5, 0], [5, 8]);
    addWall(g, [0, 4], [10, 4]);
    expect(rooms(g)).toHaveLength(4);
    const g2 = empty();
    addWall(g2, [2, 2], [6, 2]);
    expect(rooms(g2)).toHaveLength(1);
  });

  it('pátio vira furo do cômodo e não é contado', () => {
    const hole: Vec2[] = [[4, 3], [6, 3], [6, 5], [4, 5]];
    const r = rooms(empty(), square, [hole]);
    expect(r).toHaveLength(1);
    expect(r[0]!.area).toBeCloseTo(76, 6);
  });

  it('planta em L com paredes em T', () => {
    const L: Vec2[] = [[0, 0], [12, 0], [12, 5], [5, 5], [5, 12], [0, 12]];
    const g = empty();
    addWall(g, [5, 0], [5, 5]);
    addWall(g, [0, 5], [5, 5]);
    const r = rooms(g, L).map((x) => Math.round(x.area)).sort((a, b) => a - b);
    expect(r).toEqual([25, 35, 35]);
  });

  it('IDs e nomes persistem quando uma parede se move um pouco', () => {
    const g = empty();
    addWall(g, [4, 0], [4, 8]);
    const first = matchRooms([], rooms(g), () => []);
    first[0]!.name = 'Sala';
    const salaId = first[0]!.id;
    // Move a parede 0,5 m.
    for (const n of g.nodes) n.p = [4.5, n.p[1]];
    const second = matchRooms(first, rooms(g), () => []);
    const sala = second.find((r) => r.id === salaId)!;
    expect(sala.name).toBe('Sala');
    expect(second).toHaveLength(2);
    expect(wallEnds(g, g.walls[0]!)![0][0]).toBe(4.5);
  });
});

import { SCHEMA, type Building, type Project } from '../../src/core/schema';
import { validateProject } from '../../src/core/validate';
import { mainMass, newBuilding, mirror, cutBuilding, setFloors, setHeight, heightOf } from '../../src/editor/ops';
import { addInteriorDoor, addInteriorWall, addStair, groupBuildings, setStoreyHeight } from '../../src/editor/interior-ops';
import { buildBuildingParts } from '../../src/geometry/mass-parts';
import { toWorld } from '../../src/geometry/frame';
import { area } from '../../src/geometry/polygon';

const asProject = (bs: Building[]): Project => ({ schema: SCHEMA, name: 'I', lots: [], buildings: bs, styles: [], meta: { createdWith: 't' } });
const house = () => newBuilding({ name: 'Casa', points: [[-6, -4], [6, -4], [6, 4], [-6, 4]], position: [20, 10], base: 0, height: 6.4, floors: 2 });

describe('interiores no edifício', () => {
  it('paredes criam cômodos; porta e escada geram peças; laje de cima ganha o vão', () => {
    const b = house();
    const s0 = b.storeys[0]!.id;
    const [w] = addInteriorWall(b, s0, [0, -4], [0, 4]);
    expect(b.storeys[0]!.rooms).toHaveLength(2);
    expect(b.storeys[0]!.rooms.map((r) => Math.round(r.area!)).sort()).toEqual([48, 48]);
    addInteriorDoor(b, s0, w!, 4);
    addStair(b, s0, [[2, -3], [5, -3]], 1);
    expect(() => validateProject(asProject([b]))).not.toThrow();
    const parts = buildBuildingParts(b);
    expect(parts.walls.filter((x) => x.data.part === 'iwall')).toHaveLength(1);
    expect(parts.walls.find((x) => x.data.part === 'iwall')!.holes).toHaveLength(1);
    expect(parts.boxes.filter((x) => x.data.part === 'stair').length).toBeGreaterThanOrEqual(15);
    const upperSlab = parts.slabs.find((x) => x.data.part === 'floor' && x.data.storey === 1)!;
    expect(upperSlab.holes).toHaveLength(1);
    // Corte no térreo: some o pavimento de cima e o telhado.
    const cut = buildBuildingParts(b, { cutY: 3.19 });
    expect(cut.slabs.filter((x) => x.data.part === 'roof')).toHaveLength(0);
    expect(Math.max(...cut.walls.map((x) => x.top))).toBeLessThanOrEqual(3.2);
    // Nenhuma laje na altura do corte (ela cobriria o interior na planta).
    expect(cut.slabs.every((x) => x.y < 3.19 - 0.05)).toBe(true);
    // Paredes cortadas ganham tampa escura.
    expect(cut.boxes.filter((x) => x.mat.role === 'cap').length).toBe(5);
  });

  it('espelhar e recortar levam as paredes internas junto', () => {
    const b = house();
    const s0 = b.storeys[0]!.id;
    addInteriorWall(b, s0, [-3, -4], [-3, 4]);
    mirror(b);
    expect(b.storeys[0]!.graph.nodes.every((n) => n.p[0] === 3)).toBe(true);
    // Recorte ao meio: a parede (em x local 3 → mundo 23) fica na parte da direita.
    const parts = cutBuilding(b, [[19, 0], [21, 0], [21, 20], [19, 20]])!;
    expect(parts).toHaveLength(2);
    const withWall = parts.filter((p) => p.storeys[0]!.graph.walls.length);
    expect(withWall).toHaveLength(1);
    const pb = withWall[0]!;
    const node = pb.storeys[0]!.graph.nodes[0]!;
    expect(toWorld(pb, node.p)[0]).toBeCloseTo(23, 6);
    expect(() => validateProject(asProject(parts))).not.toThrow();
  });

  it('pavimentos com alturas diferentes: altura escala, andares copiam o último', () => {
    const b = house();
    setStoreyHeight(b, b.storeys[0]!.id, 4.5);
    expect(heightOf(b)).toBeCloseTo(7.7, 6);
    setFloors(b, 3);
    expect(b.storeys.map((s) => s.height)).toEqual([4.5, 3.2, 3.2]);
    setHeight(b, 21.8);
    expect(heightOf(b)).toBeCloseTo(21.8, 1);
    expect(b.storeys[0]!.height / b.storeys[1]!.height).toBeCloseTo(4.5 / 3.2, 1);
  });

  it('agrupar volume e recuo num só edifício com duas massas', () => {
    const a = house();
    const top = newBuilding({ name: 'Recuo', points: [[-3, -2], [3, -2], [3, 2], [-3, 2]], position: [20, 10], base: 6.4, height: 3.2, floors: 1 });
    const g = groupBuildings([a, top]);
    expect(g.masses).toHaveLength(2);
    expect(g.storeys).toHaveLength(3);
    expect(g.storeys.map((s) => s.name)).toEqual(['Térreo', '1º pavimento', '2º pavimento']);
    expect(() => validateProject(asProject([g]))).not.toThrow();
    const parts = buildBuildingParts(g);
    expect(parts.walls.length).toBe(8);
    expect(area(mainMass(g).outer.vertices.map((v) => v.p))).toBe(96);
    const bad = newBuilding({ name: 'X', points: [[-1, -1], [1, -1], [1, 1], [-1, 1]], position: [0, 0], base: 1, height: 3, floors: 1 });
    expect(() => groupBuildings([a, bad])).toThrow('não coincidem');
  });
});

import { WalkPhysics } from '../../src/editor/walk';

describe('modo caminhar (física)', () => {
  const setup = () => {
    const b = house();
    const s0 = b.storeys[0]!.id;
    const [w] = addInteriorWall(b, s0, [0, -4], [0, 4]);
    addInteriorDoor(b, s0, w!, 6, 0.9); // porta perto de z = +2
    addStair(b, s0, [[2, -3.2], [5.5, -3.2]], 1.1);
    return { b, phys: new WalkPhysics(b) };
  };
  const walk = (phys: WalkPhysics, from: [number, number], dir: [number, number], meters: number, floor = 0.16) => {
    let st = { p: from as [number, number], floor, yaw: 0, pitch: 0 };
    const n = Math.round(meters / 0.05);
    for (let i = 0; i < n; i++) st = phys.step(st, dir[0] * 0.05, dir[1] * 0.05);
    return st;
  };

  it('parede interna bloqueia; a porta deixa passar', () => {
    const { phys } = setup();
    const blocked = walk(phys, [-3, -2], [1, 0], 6);
    expect(blocked.p[0]).toBeLessThan(0);
    const through = walk(phys, [-3, 2], [1, 0], 6);
    expect(through.p[0]).toBeGreaterThan(1);
  });

  it('paredes externas seguram dentro do edifício', () => {
    const { phys } = setup();
    const st = walk(phys, [-3, 0], [0, 1], 10);
    expect(st.p[1]).toBeLessThan(4);
  });

  it('subir a escada chega ao piso do pavimento de cima', () => {
    const { phys } = setup();
    const st = walk(phys, [1.6, -3.2], [1, 0], 4.5);
    expect(st.floor).toBeGreaterThan(3.2);
    expect(st.floor).toBeCloseTo(3.36, 1);
  });
});
