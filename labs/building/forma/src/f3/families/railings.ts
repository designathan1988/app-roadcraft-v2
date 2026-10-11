// Guarda-corpos: o de caminho segue o padrão do Revit (montantes de início,
// canto e fim; montantes intermediários com espaçamento máximo e justificação;
// preenchimento entre eles) e o gradil de janela (balcão francês) preso à face.
import type { Vec3 } from '../model/schema';
import type { Family } from './family';
import { bool, num, P, str } from './family';
import { mat, railAlong, railOpts, railParams, railRun } from './kit';

export const RAILING: Family = {
  id: 'railing',
  name: 'Guarda-corpo',
  category: 'railings',
  host: 'path',
  tags: ['guarda-corpo', 'corrimão', 'grade', 'parapeito', 'balaústre', 'vidro', 'cabo de aço'],
  params: [
    ...railParams('bars', 1.1),
    P.len('baseH', 'Altura da base', 0, 0, 2, 'instance'),
    P.flag('curb', 'Mureta de base', false),
    P.len('curbH', 'Altura da mureta', 0.2, 0.05, 0.8, 'type', 'detail'),
    P.color('curbColor', 'Cor da mureta', '#c9c2b4'),
  ],
  size: (p) => [1, num(p, 'railH') + num(p, 'baseH') + (bool(p, 'curb') ? num(p, 'curbH') : 0), Math.max(num(p, 'postSize'), bool(p, 'curb') ? 0.2 : 0)],
  build(p, out, ctx) {
    const L = ctx.length > 0 ? ctx.length : 3;
    const path: Vec3[] = ctx.path && ctx.path.length >= 2 ? ctx.path : [[-L / 2, 0, 0], [L / 2, 0, 0]];
    let y = num(p, 'baseH');
    if (bool(p, 'curb')) {
      const ch = num(p, 'curbH');
      // A mureta segue cada trecho; nos cantos os blocos se cruzam (fica fechado).
      const cm = mat('concrete', str(p, 'curbColor'), 'concrete');
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!,
          b = path[i]!;
        const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
        if (len < 1e-4) continue;
        const rot = (Math.atan2(-(b[2] - a[2]), b[0] - a[0]) * 180) / Math.PI;
        const s = out.placed(a[0], a[1], a[2], rot);
        const k = (b[1] - a[1]) / len;
        // Prisma no plano xy do trecho: o topo acompanha a inclinação.
        s.prism(cm, [[-0.1, -0.1 * k + y], [len + 0.1, (len + 0.1) * k + y], [len + 0.1, (len + 0.1) * k + y + ch], [-0.1, -0.1 * k + y + ch]], -0.1, 0.1);
        if (y > 0.001) s.prism(cm, [[-0.1, -0.1 * k], [len + 0.1, (len + 0.1) * k], [len + 0.1, (len + 0.1) * k + y], [-0.1, -0.1 * k + y]], -0.1, 0.1);
      }
      y += ch;
    }
    // Sem mureta, a base é a altura de onde ele se apoia (topo de muro ou laje).
    railAlong(out, path.map(([x, py, z]) => [x, py + y, z] as Vec3), railOpts(p));
  },
};

/** Gradil de balcão francês: grade na frente de uma porta-balcão, presa nas ombreiras. */
export const JULIETTE: Family = {
  id: 'juliette',
  name: 'Balcão francês',
  category: 'railings',
  host: 'face',
  tags: ['balcão francês', 'gradil', 'juliette', 'guarda-corpo de janela', 'peitoril'],
  params: [
    P.len('width', 'Largura', 1.4, 0.6, 4),
    { ...P.len('sillH', 'Altura da base', 0.05, 0, 2, 'instance'), group: 'size' },
    P.len('projection', 'Afastamento da parede', 0.15, 0.05, 0.6),
    P.flag('ledge', 'Soleira de pedra', true),
    P.flag('scrolls', 'Volutas no topo', false),
    ...railParams('bars', 0.95),
  ],
  size: (p) => [num(p, 'width') + 0.1, num(p, 'railH') + (bool(p, 'scrolls') ? 0.15 : 0), num(p, 'projection') + 0.05],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const w = num(p, 'width'),
      pr = num(p, 'projection');
    const o = railOpts(p);
    o.postSpacing = Math.max(o.postSpacing, w);
    // Frente: um lance de ombreira a ombreira; laterais voltando à parede.
    railRun(out.translated(-w / 2, 0, pr), w, 0, o);
    railRun(out.placed(-w / 2, 0, 0, -90), pr, 0, { ...o, infill: o.infill === 'glass' ? 'glass' : 'bars', postSpacing: 10 }, true, false);
    railRun(out.placed(w / 2, 0, 0, -90), pr, 0, { ...o, infill: o.infill === 'glass' ? 'glass' : 'bars', postSpacing: 10 }, true, false);
    // Chumbadores na parede.
    for (const s of [-1, 1]) for (const y of [0.15, o.h - 0.1]) out.box(o.post, [(s * w) / 2, y, 0.01], [0.08, 0.08, 0.02]);
    if (bool(p, 'ledge')) out.box(mat('stone', '#d3ccbd', 'stone'), [0, -0.04, pr / 2], [w + 0.1, 0.08, pr + 0.05]);
    if (bool(p, 'scrolls')) {
      // Volutas: arcos de barra sobre o corrimão.
      const n = Math.max(2, Math.round(w / 0.3));
      for (let i = 0; i < n; i++) {
        const cx = -w / 2 + (w * (i + 0.5)) / n;
        const r = Math.min(0.07, w / n / 2 - 0.01);
        let prev: Vec3 | null = null;
        for (let k = 0; k <= 8; k++) {
          const a = (k / 8) * Math.PI;
          const q: Vec3 = [cx + Math.cos(a) * r, o.h + Math.sin(a) * r * 1.4, pr];
          if (prev) out.rod(o.rail, prev, q, 0.006, 6);
          prev = q;
        }
      }
    }
  },
};
