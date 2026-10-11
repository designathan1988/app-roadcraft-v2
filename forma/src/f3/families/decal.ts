// Imagens e áreas sobre as faces. Hospedadas na face como uma janela (o
// referencial da fachada já é exato), acompanham a parede quando ela muda —
// sem reprojetar como o DecalGeometry do three.js.
//  - Imagem: placa fina com a foto (instância de caixa: a frente tem UV 0–1).
//  - Área de revestimento: placa de material (procedural ou foto) sobre um
//    trecho da parede, como um revestimento de pedra ou madeira.
import type { Family } from './family';
import { num, P, str } from './family';

export const IMAGE_DECAL: Family = {
  id: 'image-decal',
  name: 'Imagem',
  category: 'facade',
  host: 'face',
  tags: ['imagem', 'foto', 'pôster', 'cartaz', 'grafite', 'mural', 'adesivo', 'logo', 'placa'],
  params: [
    P.len('width', 'Largura', 2, 0.1, 30, 'type', 'size'),
    P.len('height', 'Altura', 1.4, 0.1, 30, 'type', 'size'),
    P.len('sillH', 'Altura do pé', 1.2, 0, 60, 'instance', 'size'),
    // Identificador da imagem no projeto (escolhida ao colocar; não aparece no painel).
    { key: 'image', label: 'Imagem', kind: 'text', default: '', scope: 'type', group: 'detail' },
    P.flag('frame', 'Moldura', false, 'detail'),
    P.color('frameColor', 'Cor da moldura', '#2b2b2b'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'height'), 0.02],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height');
    out.box({ slot: 'panel', color: '#ffffff', image: str(p, 'image') }, [0, h / 2, 0.006], [w, h, 0.006]);
    if (p.frame === true) {
      const t = 0.05,
        fm = { slot: 'frame' as const, color: str(p, 'frameColor') };
      out.box(fm, [0, h + t / 2, 0.01], [w + 2 * t, t, 0.02]);
      out.box(fm, [0, -t / 2, 0.01], [w + 2 * t, t, 0.02]);
      out.box(fm, [-w / 2 - t / 2, h / 2, 0.01], [t, h, 0.02]);
      out.box(fm, [w / 2 + t / 2, h / 2, 0.01], [t, h, 0.02]);
    }
  },
};

export const CLADDING: Family = {
  id: 'cladding',
  name: 'Área de revestimento',
  category: 'facade',
  host: 'face',
  tags: ['revestimento', 'área', 'pedra', 'madeira', 'painel', 'fachada', 'textura', 'pintura'],
  params: [
    P.len('width', 'Largura', 3, 0.1, 60, 'type', 'size'),
    P.len('height', 'Altura', 2.6, 0.1, 60, 'type', 'size'),
    P.len('sillH', 'Altura do pé', 0, 0, 60, 'instance', 'size'),
    P.len('thick', 'Espessura', 0.03, 0.002, 0.3, 'type', 'size', 0.005),
    P.finish('finish', 'Acabamento', 'stone'),
    P.color('color', 'Cor', '#cfc4ae'),
    P.color('color2', 'Cor da junta', '#bdb3a0'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'height'), num(p, 'thick')],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height'),
      t = num(p, 'thick');
    out.prism(
      { slot: 'wall', color: str(p, 'color'), finish: str(p, 'finish'), color2: str(p, 'color2') },
      [
        [-w / 2, 0],
        [w / 2, 0],
        [w / 2, h],
        [-w / 2, h],
      ],
      0,
      t,
    );
  },
};
