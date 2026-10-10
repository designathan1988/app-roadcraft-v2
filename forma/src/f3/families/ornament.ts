// Ornamentos e elementos de fachada: cornija (perfil varrido), pilastra,
// cunhais (pedras de canto), frontão, faixa (cordão), letreiro, relógio e
// condutor de água. Referencial de face: x ao longo, y para cima, z para fora.
import type { Family, PartMat } from './family';
import { bool, num, P, str } from './family';

/** Perfis de cornija no plano (y, z): y para cima a partir da base, z para fora. */
const CORNICES: Record<string, [number, number][]> = {
  classic: [[0, 0], [0, 0.05], [0.08, 0.07], [0.12, 0.16], [0.2, 0.2], [0.26, 0.32], [0.32, 0.34], [0.36, 0.34], [0.36, 0]],
  modern: [[0, 0], [0, 0.08], [0.18, 0.08], [0.18, 0.12], [0.24, 0.12], [0.24, 0]],
  cove: [[0, 0], [0, 0.04], [0.05, 0.06], [0.1, 0.1], [0.14, 0.16], [0.17, 0.24], [0.2, 0.26], [0.24, 0.26], [0.24, 0]],
};

export const CORNICE: Family = {
  id: 'cornice',
  name: 'Cornija',
  category: 'ornament',
  host: 'face',
  tags: ['cornija', 'moldura', 'friso', 'coroamento', 'perfil'],
  params: [
    P.len('width', 'Comprimento', 6, 0.5, 60),
    { ...P.len('sillH', 'Altura (m)', 3, 0, 60, 'instance'), group: 'size' },
    P.pick('profile', 'Perfil', 'classic', [
      ['classic', 'Clássico'],
      ['modern', 'Moderno'],
      ['cove', 'Meia-cana'],
    ]),
    { ...P.ratio('scale', 'Escala do perfil', 1, 'type'), min: 0.4, max: 3, group: 'profile' },
    P.flag('dentils', 'Dentículos', false),
    P.color('color', 'Cor', '#f0ebe1'),
  ],
  size: (p) => [num(p, 'width'), 0.36 * num(p, 'scale'), 0.34 * num(p, 'scale')],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const w = num(p, 'width'),
      k = num(p, 'scale');
    const m: PartMat = { slot: 'stone', color: str(p, 'color'), finish: 'paint' };
    const prof = (CORNICES[str(p, 'profile')] ?? CORNICES.classic!).map(([y, z]) => [y * k, z * k] as [number, number]);
    out.sweepX(m, prof, -w / 2, w / 2);
    if (bool(p, 'dentils')) {
      const n = Math.max(2, Math.floor(w / (0.12 * k)));
      for (let i = 0; i < n; i++) out.box(m, [-w / 2 + ((i + 0.5) * w) / n, 0.04 * k, 0.06 * k], [0.06 * k, 0.07 * k, 0.1 * k]);
    }
  },
};

export const PILASTER: Family = {
  id: 'pilaster',
  name: 'Pilastra',
  category: 'ornament',
  host: 'face',
  tags: ['pilastra', 'coluna', 'clássico', 'fachada', 'ordem'],
  params: [
    P.len('width', 'Largura', 0.45, 0.15, 1.5),
    P.len('height', 'Altura', 6, 1, 40),
    { ...P.len('sillH', 'Base (m)', 0, 0, 30, 'instance'), group: 'size' },
    P.len('depth', 'Saliência', 0.1, 0.03, 0.4, 'type', 'profile', 0.01),
    P.flag('capital', 'Capitel e base', true),
    P.flag('fluted', 'Caneluras', false),
    P.color('color', 'Cor', '#efe9dc'),
  ],
  size: (p) => [num(p, 'width') + 0.12, num(p, 'height'), num(p, 'depth') + 0.06],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height'),
      d = num(p, 'depth');
    const m: PartMat = { slot: 'stone', color: str(p, 'color'), finish: 'stone' };
    const cap = bool(p, 'capital') ? Math.min(0.35, h * 0.08) : 0;
    out.box(m, [0, h / 2, d / 2], [w, h - 2 * cap, d]);
    if (cap) {
      out.box(m, [0, cap / 2, d / 2 + 0.02], [w + 0.12, cap, d + 0.04]);
      out.box(m, [0, h - cap / 2, d / 2 + 0.03], [w + 0.14, cap, d + 0.06]);
      out.box(m, [0, h - cap - 0.03, d / 2 + 0.015], [w + 0.06, 0.06, d + 0.03]);
    }
    if (bool(p, 'fluted')) {
      const n = Math.max(3, Math.round(w / 0.08));
      for (let i = 1; i < n; i++) out.box({ ...m, color: '#d9d2c4' }, [-w / 2 + (w * i) / n, h / 2, d + 0.002], [0.012, h - 2 * cap - 0.2, 0.006]);
    }
  },
};

export const QUOINS: Family = {
  id: 'quoins',
  name: 'Cunhais de pedra',
  category: 'ornament',
  host: 'face',
  tags: ['cunhal', 'pedra', 'canto', 'quina', 'colonial'],
  params: [
    P.len('height', 'Altura', 6, 1, 40),
    { ...P.len('sillH', 'Base (m)', 0.4, 0, 30, 'instance'), group: 'size' },
    P.len('stone', 'Altura da pedra', 0.35, 0.15, 0.8, 'type', 'divisions', 0.01),
    P.len('long', 'Pedra longa', 0.6, 0.2, 1.2, 'type', 'profile'),
    P.len('short', 'Pedra curta', 0.35, 0.1, 0.8, 'type', 'profile'),
    P.pick('side', 'Canto', 'left', [
      ['left', 'Esquerdo'],
      ['right', 'Direito'],
      ['both', 'Os dois'],
    ]),
    P.len('width', 'Largura da face', 6, 1, 60),
    P.color('color', 'Cor', '#cfc6b4'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'height'), 0.06],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const h = num(p, 'height'),
      s = num(p, 'stone'),
      W = num(p, 'width');
    const m: PartMat = { slot: 'stone', color: str(p, 'color'), finish: 'stone' };
    const n = Math.max(1, Math.floor(h / s));
    const sides = str(p, 'side') === 'both' ? [-1, 1] : str(p, 'side') === 'right' ? [1] : [-1];
    for (const sd of sides)
      for (let i = 0; i < n; i++) {
        const len = i % 2 === 0 ? num(p, 'long') : num(p, 'short');
        const x = sd * (W / 2 - len / 2);
        out.box(m, [x, (i + 0.5) * (h / n), 0.03], [len, h / n - 0.02, 0.06]);
      }
  },
};

export const PEDIMENT: Family = {
  id: 'pediment',
  name: 'Frontão',
  category: 'ornament',
  host: 'face',
  tags: ['frontão', 'triangular', 'segmentado', 'portada', 'clássico'],
  params: [
    P.len('width', 'Largura', 1.6, 0.6, 12),
    P.len('rise', 'Altura', 0.45, 0.1, 3),
    { ...P.len('sillH', 'Base (m)', 2.4, 0, 30, 'instance'), group: 'size' },
    P.pick('shape', 'Forma', 'triangle', [
      ['triangle', 'Triangular'],
      ['segment', 'Segmentado (arco)'],
      ['flat', 'Cornija reta'],
    ]),
    P.color('color', 'Cor', '#f1ece2'),
  ],
  size: (p) => [num(p, 'width') + 0.2, num(p, 'rise') + 0.15, 0.2],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const w = num(p, 'width'),
      r = num(p, 'rise');
    const m: PartMat = { slot: 'stone', color: str(p, 'color'), finish: 'paint' };
    out.box(m, [0, 0.06, 0.08], [w + 0.2, 0.12, 0.16]);
    const sh = str(p, 'shape');
    if (sh === 'flat') return;
    const prof: [number, number][] = [];
    if (sh === 'triangle') prof.push([-w / 2 - 0.1, 0.12], [w / 2 + 0.1, 0.12], [0, 0.12 + r]);
    else for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      prof.push([-w / 2 - 0.1 + (w + 0.2) * t, 0.12 + Math.sin(t * Math.PI) * r]);
    }
    if (sh !== 'triangle') prof.push([w / 2 + 0.1, 0.12]);
    out.prism(m, prof, 0, 0.12);
    // Moldura inclinada por cima (só no triangular).
    if (sh === 'triangle') {
      const ang = (Math.atan2(r, w / 2 + 0.1) * 180) / Math.PI;
      const L = Math.hypot(r, w / 2 + 0.1);
      for (const sx of [-1, 1]) out.box(m, [(sx * (w / 2 + 0.1)) / 2, 0.12 + r / 2 + 0.03, 0.08], [L + 0.05, 0.08, 0.18], [0, 0, sx * -ang]);
    }
  },
};

export const BAND: Family = {
  id: 'band',
  name: 'Faixa (cordão)',
  category: 'ornament',
  host: 'face',
  tags: ['faixa', 'cordão', 'frisos', 'entre pisos', 'moldura'],
  params: [
    P.len('width', 'Comprimento', 6, 0.5, 60),
    P.len('height', 'Altura', 0.2, 0.04, 1, 'type', 'profile', 0.01),
    P.len('depth', 'Saliência', 0.06, 0.01, 0.3, 'type', 'profile', 0.01),
    { ...P.len('sillH', 'Altura (m)', 3, 0, 60, 'instance'), group: 'size' },
    P.color('color', 'Cor', '#e6dfd0'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'height'), num(p, 'depth')],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    out.box({ slot: 'stone', color: str(p, 'color'), finish: 'stone' }, [0, num(p, 'height') / 2, num(p, 'depth') / 2], [num(p, 'width'), num(p, 'height'), num(p, 'depth')]);
  },
};

export const SIGN: Family = {
  id: 'sign',
  name: 'Letreiro',
  category: 'ornament',
  host: 'face',
  tags: ['letreiro', 'placa', 'nome', 'loja', 'luminoso', 'bandeira'],
  params: [
    P.len('width', 'Largura', 2.4, 0.3, 20),
    P.len('height', 'Altura', 0.6, 0.2, 4),
    { ...P.len('sillH', 'Altura (m)', 3, 0, 40, 'instance'), group: 'size' },
    P.pick('kind', 'Tipo', 'panel', [
      ['panel', 'Painel na parede'],
      ['blade', 'Bandeira (perpendicular)'],
      ['letters', 'Letras soltas'],
    ]),
    P.flag('lit', 'Iluminado', true),
    P.color('color', 'Cor', '#1f4a5a'),
    P.color('textColor', 'Cor das letras', '#f4eedc'),
  ],
  size: (p) => (str(p, 'kind') === 'blade' ? [0.2, num(p, 'height'), num(p, 'width')] : [num(p, 'width'), num(p, 'height'), 0.12]),
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height');
    const bg: PartMat = { slot: 'panel', color: str(p, 'color'), finish: 'paint' };
    const tx: PartMat = { slot: bool(p, 'lit') ? 'light' : 'panel', color: str(p, 'textColor') };
    const kind = str(p, 'kind');
    if (kind === 'blade') {
      out.box({ slot: 'metal', color: '#2f3336', finish: 'metal' }, [0, h + 0.05, w / 2], [0.04, 0.04, w + 0.1]);
      out.box(bg, [0, h / 2, w / 2 + 0.05], [0.08, h, w]);
      for (const sx of [-1, 1]) out.box(tx, [sx * 0.045, h / 2, w / 2 + 0.05], [0.006, h * 0.45, w * 0.7]);
      return;
    }
    if (kind === 'panel') out.box(bg, [0, h / 2, 0.04], [w, h, 0.08]);
    // Letras: blocos de largura variada (sem texto real; leitura de longe).
    const n = Math.max(3, Math.round(w / (h * 0.55)));
    for (let i = 0; i < n; i++) {
      const lw = (w * 0.8) / n;
      const x = -w * 0.4 + (i + 0.5) * lw;
      out.box(tx, [x, h / 2, kind === 'panel' ? 0.085 : 0.03], [lw * (0.55 + 0.3 * ((i * 7) % 3) / 2), h * 0.55, kind === 'panel' ? 0.01 : 0.06]);
    }
  },
};

export const CLOCK: Family = {
  id: 'clock',
  name: 'Relógio de fachada',
  category: 'ornament',
  host: 'face',
  tags: ['relógio', 'torre', 'estação', 'igreja', 'prefeitura'],
  params: [
    P.len('width', 'Diâmetro', 1.4, 0.4, 5),
    { ...P.len('sillH', 'Altura (m)', 8, 0, 60, 'instance'), group: 'size' },
    P.color('face', 'Mostrador', '#f6f2e8'),
    P.color('frame', 'Moldura', '#2d2a26'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'width'), 0.15],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const d = num(p, 'width'),
      r = d / 2;
    const fr: PartMat = { slot: 'metal', color: str(p, 'frame'), finish: 'metal' };
    const disc = (rr: number): [number, number][] => Array.from({ length: 32 }, (_, k) => [Math.cos((k / 32) * Math.PI * 2) * rr, r + Math.sin((k / 32) * Math.PI * 2) * rr] as [number, number]);
    out.prism(fr, disc(r), 0, 0.08);
    out.prism({ slot: 'panel', color: str(p, 'face'), finish: 'paint' }, disc(r * 0.88), 0.08, 0.1);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      out.box(fr, [Math.cos(a) * r * 0.75, r + Math.sin(a) * r * 0.75, 0.105], [0.03, 0.08, 0.01], [0, 0, (a * 180) / Math.PI + 90]);
    }
    out.box(fr, [0, r + r * 0.25, 0.115], [0.035, r * 0.5, 0.01]);
    out.box(fr, [r * 0.3, r, 0.12], [r * 0.6, 0.03, 0.01]);
  },
};

export const DOWNPIPE: Family = {
  id: 'downpipe',
  name: 'Condutor de água',
  category: 'ornament',
  host: 'face',
  tags: ['condutor', 'calha', 'tubo', 'chuva', 'águas pluviais'],
  params: [
    P.len('height', 'Altura', 6, 1, 60),
    { ...P.len('sillH', 'Base (m)', 0, 0, 30, 'instance'), group: 'size' },
    P.len('width', 'Diâmetro', 0.1, 0.05, 0.25, 'type', 'profile', 0.01),
    P.color('color', 'Cor', '#7d8183'),
  ],
  size: (p) => [num(p, 'width') + 0.1, num(p, 'height'), 0.2],
  sill: (p) => num(p, 'sillH'),
  build(p, out) {
    const h = num(p, 'height'),
      r = num(p, 'width') / 2;
    const m: PartMat = { slot: 'metal', color: str(p, 'color'), finish: 'metal' };
    out.cylinder(m, [0, 0.25, 0.12], r, h - 0.4, 12);
    out.rod(m, [0, 0.25, 0.12], [0, 0.02, 0.32], r, 12);
    out.box(m, [0, h - 0.08, 0.1], [0.3, 0.12, 0.2]);
    for (let y = 1; y < h - 0.5; y += 1.8) out.box(m, [0, y, 0.06], [r * 2 + 0.04, 0.03, 0.12]);
  },
};
