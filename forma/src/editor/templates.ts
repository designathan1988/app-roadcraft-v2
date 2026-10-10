// Modelos prontos: pontos de partida completos (volume, estilo, cobertura e,
// nas casas, cômodos, portas e escada). Tudo continua editável depois.
import type { Building, ID, Vec2 } from '../core/schema';
import { uid } from '../core/ids';
import { shape } from '../geometry/polygon';
import { builtinStyle } from '../styles';
import { applyStyle, newBuilding } from './ops';
import { addInteriorDoor, addInteriorWall, addStair, renameRoom } from './interior-ops';
import { sortedStoreys } from '../core/model';

export interface Template {
  id: string;
  name: string;
  description: string;
  icon: string;
  build(position: Vec2, name: string, newId?: () => ID): Building;
}

/** Parede com porta no meio (ou em `at`, metros a partir de a). */
function wallWithDoor(b: Building, storeyId: ID, a: Vec2, c: Vec2, at?: number, newId: () => ID = uid): void {
  const ids = addInteriorWall(b, storeyId, a, c, 0.12, newId);
  const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const s = b.storeys.find((x) => x.id === storeyId)!;
  // A parede pode ter sido dividida no encontro com outras: põe a porta no trecho que contém `at`.
  const target = at ?? len / 2;
  for (const id of ids) {
    const w = s.graph.walls.find((x) => x.id === id);
    if (!w) continue;
    const pa = s.graph.nodes.find((n) => n.id === w.a)!.p,
      pb = s.graph.nodes.find((n) => n.id === w.b)!.p;
    const da = Math.hypot(pa[0] - a[0], pa[1] - a[1]),
      db = Math.hypot(pb[0] - a[0], pb[1] - a[1]);
    const lo = Math.min(da, db),
      hi = Math.max(da, db);
    if (target >= lo && target <= hi && hi - lo > 1.1) {
      addInteriorDoor(b, storeyId, id, da < db ? target - lo : hi - target, 0.85, 2.1, newId);
      return;
    }
  }
}

function named(b: Building, storeyId: ID, names: [Vec2, string][]): void {
  const s = b.storeys.find((x) => x.id === storeyId)!;
  for (const [p, n] of names) {
    const r = s.rooms.find((room) => room.polygon && inside(p, room.polygon));
    if (r) renameRoom(b, storeyId, r.id, n);
  }
}

function inside(p: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!,
      d = poly[j]!;
    if (a[1] > p[1] !== d[1] > p[1] && p[0] < ((d[0] - a[0]) * (p[1] - a[1])) / (d[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

function styled(b: Building, styleId: string, roof?: Building['masses'][number]['roof']['kind']): Building {
  const pack = builtinStyle(styleId);
  if (pack) applyStyle(b, pack);
  if (roof) for (const m of b.masses) m.roof.kind = roof;
  return b;
}

export const TEMPLATES: Template[] = [
  {
    id: 'casa',
    name: 'Casa térrea',
    description: 'Casa de 10 × 8 m com sala, cozinha, dois quartos e banheiro.',
    icon: 'fill',
    build(position, name, newId = uid) {
      const b = styled(newBuilding({ name, points: shape('rect', 10, 8), position, base: 0, height: 3.1, floors: 1 }, newId), 'builtin:colonial');
      const s = b.storeys[0]!.id;
      wallWithDoor(b, s, [0, -4], [0, 4], 6.2, newId);
      wallWithDoor(b, s, [0, 0.6], [5, 0.6], 1.6, newId);
      wallWithDoor(b, s, [2.6, 0.6], [2.6, 4], 1.2, newId);
      wallWithDoor(b, s, [-5, 0.8], [0, 0.8], 3.4, newId);
      named(b, s, [
        [[-2.5, -2], 'Sala'],
        [[-2.5, 2.5], 'Cozinha'],
        [[2.5, -2], 'Quarto 1'],
        [[1.2, 2.5], 'Quarto 2'],
        [[3.8, 2.5], 'Banheiro'],
      ]);
      return b;
    },
  },
  {
    id: 'sobrado',
    name: 'Sobrado',
    description: 'Dois pavimentos de 8 × 10 m com escada, sala embaixo e quartos em cima.',
    icon: 'stair',
    build(position, name, newId = uid) {
      const b = styled(newBuilding({ name, points: shape('rect', 8, 10), position, base: 0, height: 6, floors: 2 }, newId), 'builtin:colonial', 'gable');
      const [t, u] = sortedStoreys(b);
      addStair(b, t!.id, [
        [-3.3, -4.4],
        [-3.3, -0.4],
      ], 1.0, newId);
      wallWithDoor(b, t!.id, [-4, 1], [4, 1], 5.5, newId);
      wallWithDoor(b, u!.id, [-2.6, -5], [-2.6, 1], 4.8, newId);
      wallWithDoor(b, u!.id, [-2.6, 1], [4, 1], 3.6, newId);
      wallWithDoor(b, u!.id, [1, 1], [1, 5], 1.4, newId);
      named(b, t!.id, [
        [[0, -2], 'Sala'],
        [[0, 3], 'Cozinha'],
      ]);
      named(b, u!.id, [
        [[0.8, -2], 'Quarto 1'],
        [[2.5, 3], 'Quarto 2'],
        [[-1, 3], 'Banheiro'],
      ]);
      return b;
    },
  },
  {
    id: 'predio',
    name: 'Prédio',
    description: 'Residencial de 6 pavimentos com lojas no térreo.',
    icon: 'layers',
    build: (position, name, newId = uid) => styled(newBuilding({ name, points: shape('rect', 18, 12), position, base: 0, height: 19.2, floors: 6 }, newId), 'builtin:comercial'),
  },
  {
    id: 'galpao',
    name: 'Galpão',
    description: 'Galpão de 16 × 30 m em tijolo, pé-direito de 7 m.',
    icon: 'loja',
    build: (position, name, newId = uid) => styled(newBuilding({ name, points: shape('rect', 16, 30), position, base: 0, height: 7, floors: 1 }, newId), 'builtin:industrial'),
  },
  {
    id: 'torre',
    name: 'Torre',
    description: 'Torre de escritórios envidraçada, 20 pavimentos.',
    icon: 'cube',
    build: (position, name, newId = uid) => styled(newBuilding({ name, points: shape('rect', 22, 22), position, base: 0, height: 72, floors: 20 }, newId), 'builtin:torre'),
  },
];

export const templateById = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);
