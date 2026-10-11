// Luminárias: acendem à noite (material de luz, brilho acima do limiar do
// bloom, como as lanternas de porta do jogo).
import type { Family } from './family';
import { num, P, str } from './family';

export const WALL_LAMP: Family = {
  id: 'wall-lamp',
  name: 'Arandela',
  category: 'facade',
  host: 'face',
  tags: ['luz', 'luminária', 'arandela', 'lanterna', 'iluminação', 'noite', 'lâmpada'],
  params: [
    P.pick('style', 'Estilo', 'lantern', [
      ['lantern', 'Lanterna'],
      ['box', 'Caixa moderna'],
      ['globe', 'Globo'],
    ]),
    P.len('sillH', 'Altura do pé', 2.1, 0.3, 60, 'instance', 'size'),
    P.len('size', 'Tamanho', 0.3, 0.12, 0.8, 'type', 'size', 0.01),
    P.color('bodyColor', 'Corpo', '#26292c'),
    P.color('lightColor', 'Luz', '#ffd9a0'),
  ],
  size: (p) => [num(p, 'size'), num(p, 'size') * 1.5, num(p, 'size') + 0.08],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const k = num(p, 'size');
    const body = { slot: 'metal' as const, color: str(p, 'bodyColor') };
    const light = { slot: 'light' as const, color: str(p, 'lightColor') };
    const style = str(p, 'style');
    // Braço na parede.
    out.box(body, [0, k * 0.75, 0.03], [k * 0.3, k * 0.5, 0.06]);
    if (style === 'globe') {
      out.lathe(light, Array.from({ length: 9 }, (_, i) => [Math.sin((i / 8) * Math.PI) * k * 0.45, (i / 8) * k * 0.9] as [number, number]), 14, [0, k * 0.3, k * 0.5 + 0.06]);
      out.box(body, [0, k * 0.25, k * 0.5 + 0.06], [k * 0.3, k * 0.1, k * 0.3]);
    } else if (style === 'box') {
      out.box(body, [0, k * 0.75, k * 0.3 + 0.06], [k * 0.8, k * 1.4, k * 0.6]);
      out.box(light, [0, k * 0.75, k * 0.6 + 0.065], [k * 0.6, k * 1.15, 0.01]);
    } else {
      out.box(body, [0, k * 1.35, k * 0.35 + 0.06], [k * 0.7, k * 0.12, k * 0.7]);
      out.box(light, [0, k * 0.8, k * 0.35 + 0.06], [k * 0.55, k * 0.95, k * 0.55]);
      out.box(body, [0, k * 0.28, k * 0.35 + 0.06], [k * 0.6, k * 0.1, k * 0.6]);
    }
  },
};

export const STREET_LAMP: Family = {
  id: 'street-lamp',
  name: 'Poste de luz',
  category: 'site',
  host: 'free',
  tags: ['poste', 'luz', 'iluminação', 'rua', 'jardim', 'noite', 'luminária'],
  params: [
    P.pick('style', 'Estilo', 'modern', [
      ['modern', 'Moderno'],
      ['classic', 'Clássico'],
      ['garden', 'Balizador de jardim'],
    ]),
    P.len('height', 'Altura', 4.5, 0.5, 12, 'type', 'size', 0.1),
    P.color('bodyColor', 'Corpo', '#2b2e31'),
    P.color('lightColor', 'Luz', '#ffe2b0'),
  ],
  size: (p) => [0.6, num(p, 'height'), 0.6],
  build(p, out) {
    const H = num(p, 'height');
    const body = { slot: 'metal' as const, color: str(p, 'bodyColor') };
    const light = { slot: 'light' as const, color: str(p, 'lightColor') };
    const style = str(p, 'style');
    if (style === 'garden') {
      const h = Math.min(H, 1);
      out.cylinder(body, [0, 0, 0], 0.07, h * 0.75, 12);
      out.cylinder(light, [0, h * 0.75, 0], 0.075, h * 0.18, 12);
      out.cylinder(body, [0, h * 0.93, 0], 0.09, 0.04, 12);
      return;
    }
    out.cylinder(body, [0, 0, 0], 0.12, 0.35, 12);
    out.cylinder(body, [0, 0.35, 0], 0.06, H - 0.35, 10);
    if (style === 'classic') {
      out.box(body, [0, H + 0.02, 0], [0.42, 0.06, 0.42]);
      out.box(light, [0, H - 0.3, 0], [0.32, 0.5, 0.32]);
      out.box(body, [0, H - 0.58, 0], [0.36, 0.06, 0.36]);
      out.lathe(body, [[0.24, 0], [0.12, 0.18], [0.02, 0.26]], 4, [0, H + 0.05, 0]);
    } else {
      out.rod(body, [0, H - 0.05, 0], [0.9, H + 0.08, 0], 0.045, 8);
      out.box(body, [0.95, H + 0.06, 0], [0.55, 0.08, 0.24]);
      out.box(light, [0.95, H + 0.01, 0], [0.48, 0.02, 0.18]);
    }
  },
};
