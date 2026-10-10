// Escadas e rampas derivadas da altura (como FreeCAD e Revit): o número de
// degraus sai do desnível e do espelho máximo, n = ceil(desnível / espelho
// máximo); a rampa sai da inclinação máxima, com patamar a cada 0,8 m de
// desnível. Guarda-corpo gerado junto. Referencial livre: x largura, z
// avançando (a escada sobe em +z), y para cima.
import type { Family, PartMat, PartSink, Params } from './family';
import { bool, num, P, str } from './family';
import { railOpts, railParams, railRun } from './kit';

const STRUCT: [string, string][] = [
  ['solid', 'Maciça (concreto)'],
  ['stringers', 'Duas longarinas'],
  ['center', 'Longarina central'],
];

export function stairCount(rise: number, maxRiser: number): number {
  return Math.max(1, Math.ceil(rise / Math.max(0.1, maxRiser) - 1e-9));
}

function flight(out: PartSink, n: number, r: number, g: number, w: number, y0: number, mat: { tread: PartMat; struct: PartMat }, kind: string): void {
  for (let i = 0; i < n; i++) {
    const z = (i + 0.5) * g;
    const top = y0 + (i + 1) * r;
    if (kind === 'solid') out.box(mat.struct, [0, (y0 + top) / 2 - 0.01, z], [w, top - y0 + 0.02, g]);
    out.box(mat.tread, [0, top - 0.025, z - 0.02], [w + 0.02, 0.05, g + 0.04]);
  }
  if (kind !== 'solid') {
    const L = n * g,
      rise = n * r;
    const xs = kind === 'center' ? [0] : [-w / 2 + 0.05, w / 2 - 0.05];
    const ang = (-Math.atan2(rise, L) * 180) / Math.PI;
    for (const x of xs) out.box(mat.struct, [x, y0 + rise / 2 - 0.15, L / 2], [0.08, 0.28, Math.hypot(L, rise)], [0, ang, 0]);
  }
}

export const STAIR: Family = {
  id: 'stair',
  name: 'Escada',
  category: 'stairs',
  host: 'free',
  tags: ['escada', 'degraus', 'lance', 'caracol', 'patamar', 'externa'],
  params: [
    { ...P.len('rise', 'Desnível', 3, 0.3, 12, 'instance'), group: 'size' },
    P.len('width', 'Largura', 1.2, 0.6, 4),
    P.len('maxRiser', 'Espelho máximo', 0.18, 0.12, 0.22, 'type', 'divisions', 0.005),
    P.len('going', 'Piso (profundidade do degrau)', 0.28, 0.22, 0.4, 'type', 'divisions', 0.01),
    P.pick('shape', 'Forma', 'straight', [
      ['straight', 'Reta'],
      ['L', 'Em L'],
      ['U', 'Em U'],
      ['spiral', 'Caracol'],
    ]),
    P.pick('structure', 'Estrutura', 'solid', STRUCT),
    P.pick('rails', 'Guarda-corpo', 'both', [
      ['both', 'Dos dois lados'],
      ['left', 'À esquerda'],
      ['right', 'À direita'],
      ['none', 'Sem'],
    ]),
    ...railParams('bars', 0.95),
    P.color('treadColor', 'Cor dos degraus', '#b9b1a4'),
    P.finish('treadFinish', 'Material dos degraus', 'stone'),
    P.color('structColor', 'Cor da estrutura', '#a7a39c'),
  ],
  size: (p) => {
    const n = stairCount(num(p, 'rise'), num(p, 'maxRiser'));
    const w = num(p, 'width'),
      g = num(p, 'going');
    const sh = str(p, 'shape');
    if (sh === 'spiral') return [w * 2 + 0.3, num(p, 'rise'), w * 2 + 0.3];
    if (sh === 'L') return [w + Math.ceil(n / 2) * g, num(p, 'rise'), Math.floor(n / 2) * g + w];
    if (sh === 'U') return [w * 2 + 0.1, num(p, 'rise'), Math.ceil(n / 2) * g + w];
    return [w, num(p, 'rise'), n * g];
  },
  build(p, out) {
    const rise = num(p, 'rise'),
      w = num(p, 'width'),
      g = num(p, 'going');
    const n = stairCount(rise, num(p, 'maxRiser'));
    const r = rise / n;
    const kind = str(p, 'structure');
    const m = { tread: { slot: 'stone', color: str(p, 'treadColor'), finish: str(p, 'treadFinish') } as PartMat, struct: { slot: 'concrete', color: str(p, 'structColor'), finish: 'concrete' } as PartMat };
    const rails = str(p, 'rails');
    const o = railOpts(p);
    const sides = rails === 'both' ? [-1, 1] : rails === 'left' ? [-1] : rails === 'right' ? [1] : [];
    // Guarda-corpo de um lance: corre em +z subindo `run.rise`.
    const railOf = (s: PartSink, L: number, y0: number, x: number, rr: number) => railRun(s.placed(x, y0, 0, -90), L, rr, o);
    const shape = str(p, 'shape');
    if (shape === 'spiral') {
      const R = w + 0.15;
      const turn = Math.min(360, Math.max(240, n * 22));
      out.cylinder(m.struct, [0, 0, 0], 0.09, rise + 0.9, 16);
      for (let i = 0; i < n; i++) {
        const a = (turn * (i + 0.5)) / n;
        const s = out.placed(0, (i + 1) * r - 0.03, 0, a);
        s.prism(m.tread, [[0.05, -0.05], [R, -((R * Math.PI * turn) / 180 / n) / 2 - 0.05], [R, ((R * Math.PI * turn) / 180 / n) / 2 + 0.05]], -0.03, 0.03);
      }
      if (sides.length) for (let i = 0; i <= n; i++) {
        const a = ((turn * i) / n) * (Math.PI / 180);
        out.rod(o.post, [Math.cos(-a) * R * 0.98, i * r, Math.sin(-a) * R * 0.98], [Math.cos(-a) * R * 0.98, i * r + o.h, Math.sin(-a) * R * 0.98], 0.012, 6);
      }
      return;
    }
    if (shape === 'straight') {
      flight(out, n, r, g, w, 0, m, kind);
      for (const sd of sides) railOf(out, n * g, 0, (sd * w) / 2, rise);
      return;
    }
    // Em L e em U: dois lances com patamar.
    const n1 = Math.ceil(n / 2),
      n2 = n - n1;
    const y1 = n1 * r;
    flight(out, n1, r, g, w, 0, m, kind);
    const landZ = n1 * g;
    out.box(m.struct, [0, y1 / 2 - 0.01, landZ + w / 2], [w, y1 + 0.02, w]);
    out.box(m.tread, [0, y1 - 0.025, landZ + w / 2], [w + 0.02, 0.05, w + 0.02]);
    for (const sd of sides) railOf(out, n1 * g, 0, (sd * w) / 2, y1);
    if (shape === 'L') {
      // Segundo lance para +x, a partir do patamar.
      const s2 = out.placed(w / 2, 0, landZ + w / 2, 90);
      flight(s2.translated(0, 0, 0), n2, r, g, w, y1, m, kind);
      for (const sd of sides) railOf(s2, n2 * g, y1, (sd * w) / 2, n2 * r);
    } else {
      // Em U: volta para trás, ao lado do primeiro lance.
      const s2 = out.placed(w + 0.1, 0, landZ, 180);
      flight(s2, n2, r, g, w, y1, m, kind);
      for (const sd of sides) railOf(s2, n2 * g, y1, (sd * w) / 2, n2 * r);
    }
  },
};

export const RAMP: Family = {
  id: 'ramp',
  name: 'Rampa',
  category: 'stairs',
  host: 'free',
  tags: ['rampa', 'acessibilidade', 'acessível', 'cadeirante', 'patamar'],
  params: [
    { ...P.len('rise', 'Desnível', 0.8, 0.1, 4, 'instance'), group: 'size' },
    P.len('width', 'Largura', 1.5, 0.9, 4),
    { ...P.ratio('slope', 'Inclinação máxima (%)', 0.0833, 'type'), min: 0.03, max: 0.125, group: 'divisions' },
    P.len('landing', 'Patamar', 1.5, 1.2, 3, 'type', 'divisions'),
    P.flag('rails', 'Guarda-corpo dos dois lados', true),
    ...railParams('bars', 0.92),
    P.color('slabColor', 'Cor do piso', '#b8b3a8'),
  ],
  size: (p) => {
    const rise = num(p, 'rise'),
      sl = Math.max(0.03, num(p, 'slope'));
    const runs = Math.max(1, Math.ceil(rise / 0.8 - 1e-9));
    return [num(p, 'width'), rise, rise / sl + (runs - 1) * num(p, 'landing')];
  },
  build(p, out) {
    const rise = num(p, 'rise'),
      w = num(p, 'width'),
      sl = Math.max(0.03, num(p, 'slope')),
      land = num(p, 'landing');
    const runs = Math.max(1, Math.ceil(rise / 0.8 - 1e-9));
    const rr = rise / runs,
      L = rr / sl;
    const m: PartMat = { slot: 'concrete', color: str(p, 'slabColor'), finish: 'concrete' };
    const o = railOpts(p);
    let z = 0,
      y = 0;
    for (let i = 0; i < runs; i++) {
      // Rampa: perfil (y, z) varrido na largura.
      // Perfil (y, z) do trecho: do chão até a superfície inclinada.
      const prof: [number, number][] = y > 0.001 ? [[0, z], [y, z], [y + rr, z + L], [0, z + L]] : [[0, z], [rr, z + L], [0, z + L]];
      out.sweepX(m, prof, -w / 2, w / 2);
      if (bool(p, 'rails')) for (const sd of [-1, 1]) railRun(out.placed((sd * w) / 2, y, z, -90), L, rr, o);
      y += rr;
      z += L;
      if (i < runs - 1) {
        out.box(m, [0, y / 2, z + land / 2], [w, y, land]);
        if (bool(p, 'rails')) for (const sd of [-1, 1]) railRun(out.placed((sd * w) / 2, y, z, -90), land, 0, o);
        z += land;
      }
    }
  },
};

export type { Params };
