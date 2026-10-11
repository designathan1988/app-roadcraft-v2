// Portas: de folha (almofadada, lisa, de vidro, meio vidro, tábuas, balcão),
// de garagem (de enrolar, seccionada, basculante), industrial (de enrolar
// grande, com doca) e vitrine de loja (vidro com porta, letreiro, toldo).
import type { Family, PartMat, PartSink } from './family';
import { bool, num, P, str } from './family';
import { inflate, openingProfile, openingTop, type OpeningShape, type Pt } from './shapes';
import { frameParams } from './windows';
import { awning } from './awning';

const LEAVES: [string, string][] = [
  ['panel', 'Almofadada'],
  ['flush', 'Lisa'],
  ['glass', 'De vidro'],
  ['half', 'Meio vidro'],
  ['plank', 'Tábuas'],
  ['french', 'Balcão (vidro com baguetes)'],
];

function leaf(out: PartSink, kind: string, x: number, w: number, h: number, z: number, m: { leaf: PartMat; frame: PartMat; glass: PartMat; metal: PartMat }, hingeLeft: boolean): void {
  const t = 0.045;
  const glassFrom = kind === 'glass' || kind === 'french' ? 0.12 : kind === 'half' ? h * 0.5 : Infinity;
  // Montantes e travessas da folha.
  const stile = kind === 'flush' ? 0 : kind === 'glass' ? 0.06 : 0.11;
  if (kind === 'flush' || kind === 'plank') {
    out.box(m.leaf, [x, h / 2, z], [w - 0.01, h, t]);
    if (kind === 'plank') {
      const n = Math.max(3, Math.round(w / 0.14));
      for (let i = 1; i < n; i++) out.box(m.frame, [x - w / 2 + (w * i) / n, h / 2, z + t / 2 + 0.002], [0.008, h - 0.02, 0.004]);
      for (const y of [0.25, h * 0.5, h - 0.25]) out.box(m.leaf, [x, y, z + t / 2 + 0.012], [w - 0.06, 0.12, 0.022]);
    }
  } else {
    out.box(m.leaf, [x - w / 2 + stile / 2, h / 2, z], [stile, h, t]);
    out.box(m.leaf, [x + w / 2 - stile / 2, h / 2, z], [stile, h, t]);
    out.box(m.leaf, [x, h - 0.06, z], [w - 2 * stile, 0.12, t]);
    out.box(m.leaf, [x, 0.1, z], [w - 2 * stile, 0.2, t]);
    const iw = w - 2 * stile;
    if (glassFrom < h) {
      const gy0 = Math.max(glassFrom, 0.2),
        gy1 = h - 0.12;
      out.box(m.glass, [x, (gy0 + gy1) / 2, z], [iw, gy1 - gy0, 0.012]);
      if (kind === 'half' || glassFrom > 0.2) out.box(m.leaf, [x, (0.2 + gy0) / 2, z], [iw, gy0 - 0.2, t * 0.7]);
      if (kind === 'half') out.box(m.leaf, [x, gy0, z], [iw, 0.08, t]);
      if (kind === 'french') {
        for (let i = 1; i < 2; i++) out.box(m.leaf, [x - iw / 2 + (iw * i) / 2, (gy0 + gy1) / 2, z + 0.01], [0.025, gy1 - gy0, 0.02]);
        for (let i = 1; i < 4; i++) out.box(m.leaf, [x, gy0 + ((gy1 - gy0) * i) / 4, z + 0.01], [iw, 0.025, 0.02]);
      }
    } else {
      // Almofadas.
      out.box(m.leaf, [x, h / 2, z], [iw, h - 0.32, t * 0.6]);
      const rows = h > 2.3 ? 3 : 2;
      const ph = (h - 0.36 - 0.08 * (rows - 1)) / rows;
      for (let r = 0; r < rows; r++) {
        const y = 0.2 + 0.02 + ph / 2 + r * (ph + 0.08);
        out.box(m.leaf, [x, y, z + t * 0.32], [iw - 0.1, ph - 0.06, 0.012]);
      }
    }
  }
  // Maçaneta.
  const hx = hingeLeft ? x + w / 2 - 0.08 : x - w / 2 + 0.08;
  out.box(m.metal, [hx, 1.0, z + t / 2 + 0.03], [0.12, 0.018, 0.018]);
  out.box(m.metal, [hx, 1.0, z + t / 2 + 0.012], [0.03, 0.06, 0.02]);
}

export const DOOR: Family = {
  id: 'door',
  name: 'Porta',
  category: 'doors',
  host: 'face',
  tags: ['porta', 'entrada', 'folha', 'almofada', 'vidro', 'balcão', 'dupla'],
  params: [
    P.len('width', 'Largura', 0.95, 0.6, 3.6),
    P.len('height', 'Altura', 2.2, 1.8, 4),
    { ...P.len('sillH', 'Soleira (altura)', 0, 0, 2, 'instance'), group: 'size' },
    P.count('leaves', 'Folhas', 1, 1, 2),
    P.pick('leaf', 'Folha', 'panel', LEAVES),
    P.pick('shape', 'Formato', 'rect', [
      ['rect', 'Retangular'],
      ['arch', 'Arco pleno'],
      ['segment', 'Arco abatido'],
    ]),
    P.flag('transom', 'Bandeira de vidro', false, 'divisions'),
    P.flag('sidelights', 'Vidros laterais', false, 'divisions'),
    { ...P.flag('hingeLeft', 'Dobradiça à esquerda', true), scope: 'instance' },
    ...frameParams,
    P.len('trim', 'Guarnição', 0.12, 0, 0.4, 'type', 'detail', 0.01),
    P.flag('step', 'Degrau de pedra', true),
    P.color('leafColor', 'Cor da folha', '#5b3a29'),
    P.finish('leafFinish', 'Material da folha', 'wood'),
    P.color('frameColor', 'Cor do batente', '#f1ede4'),
    P.finish('frameFinish', 'Material do batente', 'paint'),
    P.color('glassColor', 'Cor do vidro', '#46606c'),
    P.color('trimColor', 'Cor da guarnição', '#f1ede4'),
  ],
  size: (p) => [num(p, 'width') + (bool(p, 'sidelights') ? 0.8 : 0), num(p, 'height') + (bool(p, 'transom') ? 0.45 : 0), 0.2],
  sill: (p) => num(p, 'sillH'),
  opening: (p) => ({ w: num(p, 'width') + (bool(p, 'sidelights') ? 0.8 : 0), h: num(p, 'height') + (bool(p, 'transom') ? 0.45 : 0), shape: str(p, 'shape') as OpeningShape, depth: 0.32, room: 2.2 }),
  build(p, out) {
    const side = bool(p, 'sidelights') ? 0.4 : 0;
    const transom = bool(p, 'transom') ? 0.45 : 0;
    const dw = num(p, 'width'),
      dh = num(p, 'height');
    const W = dw + 2 * side,
      H = dh + transom;
    const shape = str(p, 'shape') as OpeningShape;
    const fw = num(p, 'frameW'),
      fd = num(p, 'frameD'),
      inset = num(p, 'inset');
    const m = {
      leaf: { slot: 'wood', color: str(p, 'leafColor'), finish: str(p, 'leafFinish') } as PartMat,
      frame: { slot: 'frame', color: str(p, 'frameColor'), finish: str(p, 'frameFinish') } as PartMat,
      glass: { slot: 'glass', color: str(p, 'glassColor') } as PartMat,
      metal: { slot: 'metal', color: '#b8a074', finish: 'metal' } as PartMat,
    };
    const z = -inset - fd / 2;
    // Batente em volta (sem travessa embaixo).
    out.prism(m.frame, inflate(shape, W - 2 * fw, H - fw, fw, 0) as Pt[], z - fd / 2, z + fd / 2, [openingProfile(shape, W - 2 * fw, H - fw)]);
    const n = Math.max(1, Math.round(num(p, 'leaves')));
    const lw = (dw - 2 * fw) / n;
    for (let i = 0; i < n; i++) {
      const x = -dw / 2 + fw + lw * (i + 0.5);
      leaf(out, str(p, 'leaf'), x, lw, dh - fw, z, m, n === 2 ? i === 0 : bool(p, 'hingeLeft'));
    }
    if (side) {
      for (const s of [-1, 1]) {
        const cx = s * (dw / 2 + side / 2 - fw / 2);
        out.box(m.frame, [s * (dw / 2), H / 2, z], [fw, H, fd]);
        out.box(m.glass, [cx, (dh - fw) / 2 + 0.2, z], [side - fw, dh - fw - 0.4, 0.012]);
        out.box(m.leaf, [cx, 0.1, z], [side - fw, 0.2, 0.04]);
      }
    }
    if (transom) {
      out.box(m.frame, [0, dh - fw / 2, z], [W - 2 * fw, fw, fd]);
      const top = openingTop(shape, W - 2 * fw, H - fw, 0);
      out.prism(
        m.glass,
        openingProfile(shape, W - 2 * fw, H - fw)
          .filter(([, y]) => y >= 0)
          .map(([x, y]) => [x, Math.max(y, dh)] as Pt),
        z - 0.006,
        z + 0.006,
      );
      void top;
    }
    const trim = num(p, 'trim');
    if (trim > 0.005) out.prism(m.frame, inflate(shape, W, H, trim, 0) as Pt[], -0.005, 0.04, [openingProfile(shape, W, H)]);
    if (bool(p, 'step')) out.box({ slot: 'stone', color: '#bdb6a8', finish: 'stone' }, [0, -0.08, 0.15], [W + 0.4, 0.16, 0.6]);
  },
};

export const GARAGE_DOOR: Family = {
  id: 'garage',
  name: 'Porta de garagem',
  category: 'doors',
  host: 'face',
  tags: ['garagem', 'portão', 'enrolar', 'seccionada', 'basculante', 'industrial'],
  params: [
    P.len('width', 'Largura', 2.8, 1.8, 8),
    P.len('height', 'Altura', 2.3, 1.8, 6),
    { ...P.len('sillH', 'Base (altura)', 0, 0, 2, 'instance'), group: 'size' },
    P.pick('kind', 'Tipo', 'sectional', [
      ['sectional', 'Seccionada'],
      ['roller', 'De enrolar'],
      ['tilt', 'Basculante'],
      ['carriage', 'Duas folhas de madeira'],
    ]),
    P.flag('windows', 'Visores de vidro', false, 'divisions'),
    ...frameParams,
    P.color('doorColor', 'Cor', '#d8d6d0'),
    P.finish('doorFinish', 'Material', 'metal'),
    P.color('frameColor', 'Cor do batente', '#e8e5de'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'height'), 0.2],
  sill: (p) => num(p, 'sillH'),
  opening: (p) => ({ w: num(p, 'width'), h: num(p, 'height'), shape: 'rect', depth: 0.35 }),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height');
    const kind = str(p, 'kind');
    const inset = num(p, 'inset'),
      fd = num(p, 'frameD'),
      fw = num(p, 'frameW');
    const door: PartMat = { slot: kind === 'carriage' ? 'wood' : 'metal', color: str(p, 'doorColor'), finish: kind === 'carriage' ? 'wood' : str(p, 'doorFinish') };
    const frame: PartMat = { slot: 'frame', color: str(p, 'frameColor'), finish: 'paint' };
    const glass: PartMat = { slot: 'glass', color: '#40525a' };
    const z = -inset - fd / 2;
    out.prism(frame, [[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]], z - fd / 2, z + fd / 2, [[[-w / 2 + fw, 0], [w / 2 - fw, 0], [w / 2 - fw, h - fw], [-w / 2 + fw, h - fw]]]);
    const iw = w - 2 * fw,
      ih = h - fw;
    out.box(door, [0, ih / 2, z], [iw, ih, 0.04]);
    if (kind === 'roller') {
      const n = Math.max(8, Math.round(ih / 0.08));
      for (let i = 1; i < n; i++) out.box(door, [0, (ih * i) / n, z + 0.022], [iw, 0.01, 0.006]);
      out.box(door, [0, ih + 0.12, z + 0.1], [iw + 0.1, 0.3, 0.3]);
    } else if (kind === 'sectional' || kind === 'tilt') {
      const rows = kind === 'tilt' ? 1 : 4;
      for (let r = 1; r < rows; r++) out.box(frame, [0, (ih * r) / rows, z + 0.022], [iw, 0.02, 0.008]);
      const cols = Math.max(2, Math.round(iw / 0.9));
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const cx = -iw / 2 + (iw * (c + 0.5)) / cols,
            cy = (ih * (r + 0.5)) / rows;
          const isWin = p.windows === true && r === rows - 1;
          out.box(isWin ? glass : door, [cx, cy, z + 0.024], [iw / cols - 0.12, ih / rows - 0.14, 0.01]);
        }
    } else {
      out.box(frame, [0, ih / 2, z + 0.024], [0.03, ih, 0.01]);
      for (const s of [-1, 1]) {
        const cx = (s * iw) / 4;
        out.rod(frame, [cx - iw / 4 + 0.08, 0.15, z + 0.03], [cx + iw / 4 - 0.08, ih - 0.15, z + 0.03], 0.02, 6);
        for (const y of [0.15, ih / 2, ih - 0.15]) out.box(frame, [cx, y, z + 0.03], [iw / 2 - 0.1, 0.1, 0.02]);
        if (p.windows === true) out.box(glass, [cx, ih - 0.45, z + 0.03], [iw / 2 - 0.3, 0.4, 0.012]);
      }
    }
    void kind;
  },
};

export const LOADING_DOOR: Family = {
  id: 'loading',
  name: 'Porta industrial com doca',
  category: 'industrial',
  host: 'face',
  tags: ['doca', 'carga', 'industrial', 'galpão', 'enrolar', 'caminhão'],
  params: [
    P.len('width', 'Largura', 3.2, 2.4, 6),
    P.len('height', 'Altura', 3.4, 2.5, 6),
    P.len('dock', 'Altura da doca', 1.2, 0, 1.6),
    P.flag('canopy', 'Cobertura', true),
    P.flag('bumpers', 'Para-choques', true),
    P.color('doorColor', 'Cor da porta', '#c9ccce'),
    P.color('frameColor', 'Cor do batente', '#e3c13a'),
  ],
  size: (p) => [num(p, 'width') + 0.8, num(p, 'height') + num(p, 'dock'), 2],
  sill: () => 0,
  opening: (p) => ({ w: num(p, 'width'), h: num(p, 'height') + num(p, 'dock'), shape: 'rect', depth: 0.4 }),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height'),
      dock = num(p, 'dock');
    const door: PartMat = { slot: 'metal', color: str(p, 'doorColor'), finish: 'metal' };
    const yellow: PartMat = { slot: 'metal', color: str(p, 'frameColor'), finish: 'paint' };
    const concrete: PartMat = { slot: 'concrete', color: '#a8a59f', finish: 'concrete' };
    const rubber: PartMat = { slot: 'dark', color: '#202224' };
    if (dock > 0.05) {
      out.box(concrete, [0, dock / 2, 0.9], [w + 0.8, dock, 1.8]);
      out.box(concrete, [0, dock / 2, -0.15], [w, dock, 0.3]);
      out.box(yellow, [0, dock + 0.005, 1.78], [w + 0.8, 0.01, 0.06]);
    }
    out.box(door, [0, dock + h / 2, -0.2], [w, h, 0.05]);
    const n = Math.max(10, Math.round(h / 0.1));
    for (let i = 1; i < n; i++) out.box(door, [0, dock + (h * i) / n, -0.17], [w, 0.012, 0.008]);
    for (const s of [-1, 1]) out.box(yellow, [(s * (w + 0.12)) / 2, dock + h / 2, 0.02], [0.12, h, 0.06]);
    out.box(door, [0, dock + h + 0.18, 0.12], [w + 0.2, 0.36, 0.36]);
    if (p.bumpers === true && dock > 0.05) for (const s of [-1, 1]) out.box(rubber, [(s * w) / 2.6, dock - 0.25, 1.85], [0.25, 0.4, 0.12]);
    if (p.canopy === true) {
      out.box(door, [0, dock + h + 0.65, 1.1], [w + 1.2, 0.08, 2.2], [0, -8, 0]);
      for (const s of [-1, 1]) out.rod(door, [(s * (w + 1)) / 2, dock + h + 0.5, 0], [(s * (w + 1)) / 2, dock + h + 1.5, 2.0], 0.025, 6);
    }
  },
};

export const SHOPFRONT: Family = {
  id: 'shopfront',
  name: 'Vitrine de loja',
  category: 'doors',
  host: 'face',
  tags: ['vitrine', 'loja', 'comércio', 'letreiro', 'toldo', 'porta de vidro'],
  params: [
    P.len('width', 'Largura', 4, 1.6, 12),
    P.len('height', 'Altura', 2.7, 2.2, 5),
    { ...P.len('sillH', 'Base (altura)', 0, 0, 1, 'instance'), group: 'size' },
    P.count('bays', 'Divisões', 3, 1, 10),
    P.pick('door', 'Porta', 'center', [
      ['center', 'No meio'],
      ['left', 'À esquerda'],
      ['right', 'À direita'],
      ['none', 'Sem porta'],
    ]),
    P.len('stallRiser', 'Rodapé', 0.45, 0, 1.2, 'type', 'profile'),
    P.flag('sign', 'Letreiro', true),
    P.flag('awning', 'Toldo', true),
    P.color('frameColor', 'Cor dos perfis', '#2c3134'),
    P.color('signColor', 'Cor do letreiro', '#1f4a5a'),
    P.color('awningColor', 'Cor do toldo', '#a8332c'),
    P.color('awningStripe', 'Listra do toldo', '#f1e9dc'),
    P.color('glassColor', 'Cor do vidro', '#3c535d'),
  ],
  size: (p) => [num(p, 'width'), num(p, 'height') + (bool(p, 'sign') ? 0.7 : 0), 0.3],
  sill: (p) => num(p, 'sillH'),
  opening: (p) => ({ w: num(p, 'width'), h: num(p, 'height'), shape: 'rect', depth: 0.35, room: 3.2 }),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height');
    const frame: PartMat = { slot: 'metal', color: str(p, 'frameColor'), finish: 'metal' };
    const glass: PartMat = { slot: 'glass', color: str(p, 'glassColor') };
    const z = -0.15;
    const bays = Math.max(1, Math.round(num(p, 'bays')));
    const riser = num(p, 'stallRiser');
    out.prism(frame, [[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]], z - 0.05, z + 0.05, [[[-w / 2 + 0.06, 0], [w / 2 - 0.06, 0], [w / 2 - 0.06, h - 0.06], [-w / 2 + 0.06, h - 0.06]]]);
    const bw = (w - 0.12) / bays;
    const doorAt = str(p, 'door') === 'none' ? -1 : str(p, 'door') === 'left' ? 0 : str(p, 'door') === 'right' ? bays - 1 : Math.floor(bays / 2);
    for (let i = 0; i < bays; i++) {
      const x = -w / 2 + 0.06 + bw * (i + 0.5);
      if (i > 0) out.box(frame, [x - bw / 2, h / 2, z], [0.05, h, 0.1]);
      const isDoor = i === doorAt;
      const r = isDoor ? 0 : riser;
      if (r > 0) out.box(frame, [x, r / 2, z + 0.02], [bw - 0.05, r, 0.06]);
      out.box(glass, [x, r + (h - 0.06 - r) / 2, z], [bw - 0.05, h - 0.06 - r, 0.012]);
      if (isDoor) {
        out.box(frame, [x, 2.2, z + 0.01], [bw - 0.05, 0.06, 0.08]);
        for (const s of [-1, 1]) out.box(frame, [x + (s * (bw - 0.1)) / 2, 1.1, z + 0.01], [0.05, 2.2, 0.08]);
        out.box({ slot: 'metal', color: '#c9ced1', finish: 'metal' }, [x + bw * 0.3, 1.05, z + 0.08], [0.03, 0.5, 0.03]);
      }
    }
    if (bool(p, 'sign')) {
      out.box({ slot: 'panel', color: str(p, 'signColor'), finish: 'paint' }, [0, h + 0.38, 0.06], [w, 0.6, 0.1]);
      out.box({ slot: 'light', color: '#f4eedc' }, [0, h + 0.38, 0.115], [w * 0.55, 0.22, 0.01]);
    }
    if (bool(p, 'awning')) awning(out, h + 0.02, { width: w + 0.1, depth: 1.25, drop: 0.55, valance: 0.22, color: str(p, 'awningColor'), stripe: str(p, 'awningStripe'), stripeWidth: 0.32, scallop: true });
  },
};

export type { OpeningShape };
