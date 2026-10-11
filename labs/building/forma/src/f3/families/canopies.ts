// Marquises, toldos e coberturas presas à fachada; brises, cobogó e persiana
// de enrolar. Referencial de face: x ao longo, y para cima, z para fora.
import type { Family, PartMat } from './family';
import { bool, num, P, str } from './family';
import { awning } from './awning';

export const CANOPY: Family = {
  id: 'canopy',
  name: 'Marquise',
  category: 'canopies',
  host: 'face',
  tags: ['marquise', 'cobertura', 'entrada', 'laje em balanço', 'vidro'],
  params: [
    P.len('width', 'Largura', 3, 0.8, 20),
    P.len('depth', 'Projeção', 1.4, 0.4, 5),
    P.len('thick', 'Espessura', 0.15, 0.03, 0.5, 'type', 'profile', 0.01),
    { ...P.len('sillH', 'Altura (m)', 2.6, 1.8, 8, 'instance'), group: 'size' },
    P.angle('tilt', 'Inclinação', 0, -15, 25),
    P.pick('kind', 'Tipo', 'concrete', [
      ['concrete', 'Laje de concreto'],
      ['glass', 'Vidro em estrutura metálica'],
      ['metal', 'Chapa metálica'],
      ['wood', 'Madeira'],
    ]),
    P.flag('rods', 'Tirantes', false),
    P.flag('posts', 'Pilares na frente', false),
    P.color('color', 'Cor', '#d8d4cc'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'thick') + 0.1, num(p, 'depth')],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const w = num(p, 'width'),
      d = num(p, 'depth'),
      t = num(p, 'thick');
    const kind = str(p, 'kind');
    const tilt = num(p, 'tilt');
    const steel: PartMat = { slot: 'metal', color: '#3b3f43', finish: 'metal' };
    const slab: PartMat = kind === 'glass' ? { slot: 'glass', color: '#9fb6bd' } : kind === 'metal' ? { slot: 'metal', color: str(p, 'color'), finish: 'metal' } : kind === 'wood' ? { slot: 'wood', color: '#8a6240', finish: 'wood' } : { slot: 'concrete', color: str(p, 'color'), finish: 'concrete' };
    const drop = Math.tan((tilt * Math.PI) / 180) * d;
    // Placa: perfil (y, z) inclinado, varrido na largura.
    out.sweepX(slab, [[0, 0], [-drop, d], [-drop - t, d], [-t, 0]], -w / 2, w / 2);
    if (kind === 'glass') {
      const n = Math.max(2, Math.ceil(w / 1.5) + 1);
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + (w * i) / (n - 1);
        out.sweepX(steel, [[-t, 0], [-drop - t, d], [-drop - t - 0.1, d], [-t - 0.1, 0]], x - 0.03, x + 0.03);
      }
      out.box(steel, [0, -drop - t - 0.05, d - 0.03], [w, 0.1, 0.06]);
    }
    if (bool(p, 'rods')) for (const sx of [-1, 1]) out.rod(steel, [(sx * w) / 2.4, 1.4, 0.02], [(sx * w) / 2.4, -drop, d - 0.1], 0.012, 6);
    if (bool(p, 'posts')) {
      const top = num(p, 'sillH');
      for (const sx of [-1, 1]) out.box(steel, [sx * (w / 2 - 0.1), -top / 2 - drop / 2, d - 0.15], [0.12, top + drop, 0.12]);
    }
  },
};

export const AWNING: Family = {
  id: 'awning',
  name: 'Toldo',
  category: 'canopies',
  host: 'face',
  tags: ['toldo', 'lona', 'listrado', 'janela', 'loja'],
  params: [
    P.len('width', 'Largura', 2.4, 0.6, 12),
    P.len('depth', 'Projeção', 1.1, 0.4, 3),
    P.len('drop', 'Caída', 0.6, 0.1, 1.6),
    P.len('valance', 'Sanefa', 0.22, 0, 0.6, 'type', 'profile', 0.01),
    { ...P.len('sillH', 'Altura da fixação (m)', 2.4, 1, 8, 'instance'), group: 'size' },
    P.flag('scallop', 'Sanefa recortada', true, 'profile'),
    P.flag('cheeks', 'Abas laterais', true, 'profile'),
    P.color('color', 'Cor', '#2f6b4f'),
    P.color('stripe', 'Cor da listra', '#f0ebe0'),
    P.flag('striped', 'Listrado', true, 'material'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'drop') + num(p, 'valance'), num(p, 'depth')],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const h = num(p, 'drop') + num(p, 'valance');
    awning(out, h, {
      width: num(p, 'width'),
      depth: num(p, 'depth'),
      drop: num(p, 'drop'),
      valance: num(p, 'valance'),
      color: str(p, 'color'),
      ...(bool(p, 'striped') ? { stripe: str(p, 'stripe') } : {}),
      stripeWidth: 0.3,
      scallop: bool(p, 'scallop'),
      cheeks: bool(p, 'cheeks'),
    });
  },
};

export const PORCH_ROOF: Family = {
  id: 'porchroof',
  name: 'Alpendre',
  category: 'canopies',
  host: 'face',
  tags: ['alpendre', 'varanda', 'cobertura', 'telhado', 'pilares', 'entrada'],
  params: [
    P.len('width', 'Largura', 4, 1.5, 20),
    P.len('depth', 'Profundidade', 2.2, 1, 5),
    { ...P.len('sillH', 'Altura do beiral (m)', 2.6, 2, 6, 'instance'), group: 'size' },
    P.angle('pitch', 'Inclinação', 18, 5, 40),
    P.count('posts', 'Pilares', 2, 0, 8),
    P.flag('deck', 'Piso elevado', true),
    P.color('roofColor', 'Cor do telhado', '#8a4b33'),
    P.finish('roofFinish', 'Telha', 'tile'),
    P.color('postColor', 'Cor dos pilares', '#f2eee6'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'sillH'), num(p, 'depth')],
  sill: () => 0,
  build(p, out) {
    const w = num(p, 'width'),
      d = num(p, 'depth'),
      h = num(p, 'sillH');
    const rise = Math.tan((num(p, 'pitch') * Math.PI) / 180) * d;
    const roof: PartMat = { slot: 'roof', color: str(p, 'roofColor'), finish: str(p, 'roofFinish') };
    const post: PartMat = { slot: 'wood', color: str(p, 'postColor'), finish: 'paint' };
    // Telhado de uma água encostado na parede: alto na parede, baixo na frente.
    out.sweepX(roof, [[h + rise, 0], [h, d + 0.3], [h - 0.06, d + 0.3], [h + rise - 0.06, 0]], -w / 2 - 0.2, w / 2 + 0.2);
    out.box(post, [0, h - 0.12, d - 0.1], [w, 0.18, 0.14]);
    const n = Math.round(num(p, 'posts'));
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0 : -w / 2 + 0.15 + ((w - 0.3) * i) / (n - 1);
      out.box(post, [x, h / 2, d - 0.1], [0.16, h, 0.16]);
    }
    if (bool(p, 'deck')) out.box({ slot: 'wood', color: '#9a7a58', finish: 'wood' }, [0, 0.08, d / 2], [w, 0.16, d]);
  },
};

export const BRISE: Family = {
  id: 'brise',
  name: 'Brise',
  category: 'shading',
  host: 'face',
  tags: ['brise', 'quebra-sol', 'lâminas', 'sombreamento', 'fachada'],
  params: [
    P.len('width', 'Largura', 2.4, 0.5, 20),
    P.len('height', 'Altura', 2.4, 0.5, 12),
    { ...P.len('sillH', 'Base (m)', 0.4, 0, 6, 'instance'), group: 'size' },
    P.pick('dir', 'Lâminas', 'h', [
      ['h', 'Horizontais'],
      ['v', 'Verticais'],
    ]),
    P.len('spacing', 'Espaçamento', 0.25, 0.08, 1, 'type', 'divisions', 0.01),
    P.len('blade', 'Profundidade da lâmina', 0.25, 0.05, 0.8, 'type', 'profile', 0.01),
    P.angle('angle', 'Ângulo', 30, -80, 80),
    P.len('offset', 'Distância da parede', 0.25, 0.05, 1, 'type', 'profile', 0.01),
    P.flag('frame', 'Moldura', true),
    P.color('color', 'Cor', '#d7d2c7'),
    P.finish('finish', 'Material', 'metal'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'height'), num(p, 'offset') + num(p, 'blade')],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height'),
      sp = num(p, 'spacing'),
      bl = num(p, 'blade'),
      off = num(p, 'offset');
    const m: PartMat = { slot: 'metal', color: str(p, 'color'), finish: str(p, 'finish') };
    const a = num(p, 'angle');
    const z = off + bl / 2;
    if (str(p, 'dir') === 'h') {
      const n = Math.max(1, Math.floor(h / sp));
      for (let i = 0; i < n; i++) out.box(m, [0, ((i + 0.5) * h) / n, z], [w, 0.025, bl], [0, a, 0]);
    } else {
      const n = Math.max(1, Math.floor(w / sp));
      for (let i = 0; i < n; i++) out.box(m, [-w / 2 + ((i + 0.5) * w) / n, h / 2, z], [0.025, h, bl], [a, 0, 0]);
    }
    if (bool(p, 'frame')) {
      for (const sx of [-1, 1]) out.box(m, [(sx * (w + 0.06)) / 2, h / 2, z], [0.06, h + 0.06, bl + 0.04]);
      for (const y of [0, h]) out.box(m, [0, y, z], [w + 0.06, 0.06, bl + 0.04]);
      for (const sx of [-1, 1]) for (const y of [0.05, h - 0.05]) out.box(m, [(sx * w) / 2, y, off / 2], [0.04, 0.04, off]);
    }
  },
};

export const COBOGO: Family = {
  id: 'cobogo',
  name: 'Cobogó',
  category: 'shading',
  host: 'face',
  tags: ['cobogó', 'elemento vazado', 'tijolo vazado', 'ventilação', 'brasileiro'],
  params: [
    P.len('width', 'Largura', 2, 0.4, 12),
    P.len('height', 'Altura', 2, 0.4, 8),
    { ...P.len('sillH', 'Base (m)', 0.4, 0, 6, 'instance'), group: 'size' },
    P.len('module', 'Módulo', 0.25, 0.15, 0.5, 'type', 'divisions', 0.01),
    P.pick('pattern', 'Desenho', 'square', [
      ['square', 'Quadrado'],
      ['round', 'Círculo'],
      ['diamond', 'Losango'],
    ]),
    P.color('color', 'Cor', '#e9e4da'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'height'), 0.12],
  sill: (p) => num(p, 'sillH'),
  opening: (p) => ({ w: num(p, 'width'), h: num(p, 'height'), shape: 'rect', depth: 0.3 }),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height'),
      mod = num(p, 'module');
    const m: PartMat = { slot: 'concrete', color: str(p, 'color'), finish: 'concrete' };
    const nx = Math.max(1, Math.round(w / mod)),
      ny = Math.max(1, Math.round(h / mod));
    const cw = w / nx,
      ch = h / ny;
    const hole = (cx: number, cy: number): [number, number][] => {
      const r = Math.min(cw, ch) * 0.34;
      const pat = str(p, 'pattern');
      if (pat === 'round') return Array.from({ length: 12 }, (_, k) => [cx + Math.cos((k / 12) * Math.PI * 2) * r, cy + Math.sin((k / 12) * Math.PI * 2) * r] as [number, number]);
      if (pat === 'diamond') return [[cx, cy - r * 1.2], [cx + r * 1.2, cy], [cx, cy + r * 1.2], [cx - r * 1.2, cy]];
      return [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];
    };
    // Um painel com os furos (prisma com furos): poucas peças, muitas aberturas.
    const holes: [number, number][][] = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) holes.push(hole(-w / 2 + (i + 0.5) * cw, (j + 0.5) * ch));
    out.prism(m, [[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]], -0.12, 0, holes);
  },
};

export const ROLL_SHUTTER: Family = {
  id: 'rollshutter',
  name: 'Persiana de enrolar',
  category: 'shading',
  host: 'face',
  tags: ['persiana', 'enrolar', 'rolo', 'janela', 'blackout'],
  params: [
    P.len('width', 'Largura', 1.4, 0.4, 6),
    P.len('height', 'Altura', 1.4, 0.4, 4),
    { ...P.len('sillH', 'Peitoril (m)', 0.95, 0, 3, 'instance'), group: 'size' },
    P.ratio('closed', 'Fechada (0 a 1)', 0.35, 'instance'),
    P.color('color', 'Cor', '#e8e6e0'),
  ],
  size: (p) => [num(p, 'width') + 0.1, num(p, 'height') + 0.25, 0.2],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height');
    const m: PartMat = { slot: 'metal', color: str(p, 'color'), finish: 'metal' };
    out.box(m, [0, h + 0.12, 0.08], [w + 0.1, 0.24, 0.18]);
    const c = Math.max(0, Math.min(1, num(p, 'closed')));
    const ch = h * c;
    if (ch > 0.02) {
      const n = Math.max(2, Math.round(ch / 0.05));
      for (let i = 0; i < n; i++) out.box(m, [0, h - ((i + 0.5) * ch) / n, 0.04], [w, ch / n - 0.004, 0.015]);
    }
    for (const sx of [-1, 1]) out.box(m, [(sx * (w + 0.04)) / 2, h / 2, 0.04], [0.04, h, 0.05]);
  },
};
