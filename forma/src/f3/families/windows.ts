// Janelas: uma família configurável (formato, operação, folhas, bandeira,
// baguetes, guarnição, peitoril, venezianas, grade) e a janela saliente.
import type { Family, PartMat, PartSink, Params } from './family';
import { bool, num, P, str } from './family';
import { inflate, openingProfile, openingSpring, openingTop, type OpeningShape, type Pt } from './shapes';

const SHAPES: [string, string][] = [
  ['rect', 'Retangular'],
  ['arch', 'Arco pleno'],
  ['segment', 'Arco abatido'],
  ['round', 'Óculo'],
];

const OPERATIONS: [string, string][] = [
  ['casement', 'De abrir'],
  ['sash', 'Guilhotina'],
  ['sliding', 'De correr'],
  ['awning', 'Maxim-ar'],
  ['louvre', 'Veneziana'],
  ['fixed', 'Fixa'],
];

const MUNTINS: [string, string][] = [
  ['none', 'Sem baguetes'],
  ['grid', 'Grade'],
  ['colonial', 'Colonial (6 vidros)'],
  ['top', 'Só na bandeira'],
];

const SHUTTERS: [string, string][] = [
  ['none', 'Sem venezianas'],
  ['panel', 'Folhas cegas'],
  ['louvered', 'Venezianas'],
];

export const frameParams = [
  P.len('frameW', 'Largura do caixilho', 0.06, 0.03, 0.2, 'type', 'profile', 0.01),
  P.len('frameD', 'Profundidade do caixilho', 0.1, 0.04, 0.3, 'type', 'profile', 0.01),
  P.len('inset', 'Recuo na parede', 0.08, 0, 0.4, 'type', 'profile', 0.01),
];

function mats(p: Params): { frame: PartMat; glass: PartMat; trim: PartMat; stone: PartMat; shutter: PartMat; metal: PartMat } {
  return {
    frame: { slot: 'frame', color: str(p, 'frameColor'), finish: str(p, 'frameFinish') },
    glass: { slot: 'glass', color: str(p, 'glassColor') },
    trim: { slot: 'stone', color: str(p, 'trimColor'), finish: 'paint' },
    stone: { slot: 'stone', color: str(p, 'sillColor'), finish: 'stone' },
    shutter: { slot: 'wood', color: str(p, 'shutterColor'), finish: 'paint' },
    metal: { slot: 'metal', color: '#2f3335', finish: 'metal' },
  };
}

/** Moldura (anel) seguindo o formato do vão. */
function ring(out: PartSink, m: PartMat, shape: OpeningShape, w: number, h: number, t: number, z0: number, z1: number, bottom = true): void {
  const outer = inflate(shape, w, h, t, bottom ? t : 0).map(([x, y]) => [x, y] as Pt);
  const inner = openingProfile(shape, w, h);
  out.prism(m, outer, z0, z1, [inner]);
}

/** Barras verticais e horizontais dentro do vão, cortadas pelo topo do formato. */
function divisions(out: PartSink, m: PartMat, shape: OpeningShape, w: number, h: number, cols: number, rowsAt: number[], bar: number, z0: number, z1: number): void {
  const zc = (z0 + z1) / 2,
    d = z1 - z0;
  for (let i = 1; i < cols; i++) {
    const x = -w / 2 + (w * i) / cols;
    const top = openingTop(shape, w, h, x);
    if (top > 0.05) out.box(m, [x, top / 2, zc], [bar, top, d]);
  }
  for (const y of rowsAt) {
    // Largura do vão na altura y (os arcos estreitam).
    let half = w / 2;
    if (y > openingSpring(shape, w, h)) {
      let lo = 0,
        hi = w / 2;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (openingTop(shape, w, h, mid) > y) lo = mid;
        else hi = mid;
      }
      half = lo;
    }
    if (half > 0.03) out.box(m, [0, y, zc], [half * 2, bar, d]);
  }
}

function buildWindow(p: Params, out: PartSink): void {
  const w = num(p, 'width'),
    h = num(p, 'height');
  const shape = str(p, 'shape') as OpeningShape;
  const op = str(p, 'operation');
  const M = mats(p);
  const fw = num(p, 'frameW'),
    fd = num(p, 'frameD'),
    inset = num(p, 'inset');
  const zf1 = -inset,
    zf0 = -inset - fd;
  // Caixilho (batente) seguindo o formato.
  ring(out, M.frame, shape, w - 2 * fw, h - 2 * fw, fw, zf0, zf1);
  const iw = w - 2 * fw,
    ih = h - 2 * fw;
  const clear = (shape: OpeningShape) => openingProfile(shape, iw, ih).map(([x, y]) => [x, y + fw] as Pt);
  const transom = bool(p, 'transom') && shape === 'rect' && ih > 1.1 ? Math.max(0.3, Math.min(0.6, ih * 0.22)) : 0;
  const leafTop = ih - (transom ? transom + fw * 0.5 : 0);
  // Vidro (ou lâminas da veneziana).
  if (op === 'louvre') {
    const n = Math.max(3, Math.round(leafTop / 0.09));
    for (let i = 0; i < n; i++) {
      const y = fw + ((i + 0.5) * leafTop) / n;
      out.box(M.shutter, [0, y, (zf0 + zf1) / 2], [iw, leafTop / n - 0.012, fd * 0.6], [0, 30, 0]);
    }
    if (transom) out.prism(M.glass, openingProfile('rect', iw, transom).map(([x, y]) => [x, y + fw + leafTop + fw * 0.5] as Pt), zf0 + fd * 0.45, zf0 + fd * 0.55);
  } else {
    out.prism(M.glass, clear(shape), zf0 + fd * 0.45, zf0 + fd * 0.55);
  }
  // Folhas: montantes e travessas conforme a operação.
  const cols = Math.max(1, Math.round(num(p, 'leaves')));
  const bar = fw * 0.8;
  const rows: number[] = [];
  if (op === 'sash') rows.push(leafTop / 2);
  if (transom) rows.push(leafTop + fw * 0.25);
  if (op === 'awning' && leafTop > 1.2) rows.push(leafTop * 0.62);
  const zIn0 = zf0 + fd * 0.2,
    zIn1 = zf1 - fd * 0.2;
  const g = { shape, w: iw, h: ih };
  out.prism(M.frame, [[-iw / 2, 0], [iw / 2, 0], [iw / 2, 0.01], [-iw / 2, 0.01]].map(([x, y]) => [x!, y! + fw] as Pt), zIn0, zIn1);
  // Montantes entre folhas e travessas (no referencial do vão livre).
  const inner = out.translated(0, fw, 0);
  divisions(inner, M.frame, g.shape, g.w, g.h, op === 'fixed' ? 1 : cols, rows, bar, zIn0, zIn1);
  // Correr: as folhas ficam em dois planos (sobreposição visível).
  if (op === 'sliding' && cols >= 2) inner.box(M.frame, [0, leafTop / 2, zIn1 - 0.005], [bar * 1.6, leafTop, fd * 0.25]);
  // Baguetes.
  const muntin = str(p, 'muntins');
  if (muntin !== 'none' && op !== 'louvre') {
    const mb = Math.max(0.018, fw * 0.35);
    const zm0 = zf0 + fd * 0.56,
      zm1 = zm0 + 0.02;
    if (muntin === 'top' && transom) {
      divisions(inner, M.frame, 'rect', iw, ih, cols * 2, [], mb, zm0, zm1);
    } else {
      const perLeafCols = muntin === 'colonial' ? 2 : Math.max(1, Math.round(num(p, 'muntinCols')));
      const rowsN = muntin === 'colonial' ? 3 : Math.max(1, Math.round(num(p, 'muntinRows')));
      const ys: number[] = [];
      for (let r = 1; r < rowsN; r++) ys.push((leafTop * r) / rowsN);
      divisions(inner, M.frame, shape, iw, ih, cols * perLeafCols, ys, mb, zm0, zm1);
    }
  }
  // Guarnição na face da parede.
  const trim = num(p, 'trim');
  if (trim > 0.005) ring(out, M.trim, shape, w, h, trim, -0.005, 0.035, false);
  // Peitoril de pedra.
  if (bool(p, 'sill')) out.box(M.stone, [0, -0.03, -inset / 2 + 0.04], [w + 2 * Math.max(trim, 0.05) + 0.06, 0.06, inset + 0.12]);
  // Venezianas laterais.
  const sh = str(p, 'shutters');
  if (sh !== 'none' && shape !== 'round') {
    const sw = w / 2,
      sy = openingSpring(shape, w, h);
    for (const side of [-1, 1]) {
      const cx = side * (w / 2 + Math.max(trim, 0) + 0.02 + sw / 2);
      out.box(M.shutter, [cx, sy / 2, 0.045], [sw, sy, 0.03]);
      if (sh === 'louvered') {
        const n = Math.max(4, Math.round(sy / 0.08));
        for (let i = 1; i < n; i++) out.box(M.shutter, [cx, (sy * i) / n, 0.068], [sw - 0.06, 0.012, 0.022], [0, 25, 0]);
      } else {
        out.box(M.shutter, [cx, sy * 0.28, 0.064], [sw - 0.08, sy * 0.36, 0.012]);
        out.box(M.shutter, [cx, sy * 0.72, 0.064], [sw - 0.08, sy * 0.36, 0.012]);
      }
    }
  }
  // Grade de proteção.
  if (bool(p, 'grille')) {
    const n = Math.max(3, Math.round(w / 0.13));
    for (let i = 1; i < n; i++) {
      const x = -w / 2 + (w * i) / n;
      const top = openingTop(shape, w, h, x);
      out.rod(M.metal, [x, 0, 0.03], [x, top, 0.03], 0.008, 6);
    }
    for (const y of [0.1, h * 0.5, Math.min(h - 0.1, openingSpring(shape, w, h) - 0.05)]) out.box(M.metal, [0, y, 0.03], [w - 0.02, 0.025, 0.01]);
  }
}

const common = [
  P.color('frameColor', 'Cor do caixilho', '#f3f1ec'),
  P.finish('frameFinish', 'Material do caixilho', 'paint'),
  P.color('glassColor', 'Cor do vidro', '#46606c'),
  P.color('trimColor', 'Cor da guarnição', '#f1ede4'),
  P.color('sillColor', 'Cor do peitoril', '#cfc8ba'),
  P.color('shutterColor', 'Cor das venezianas', '#3e6b52'),
];

export const WINDOW: Family = {
  id: 'window',
  name: 'Janela',
  category: 'windows',
  host: 'face',
  tags: ['janela', 'vidro', 'caixilho', 'guilhotina', 'correr', 'arco', 'óculo', 'veneziana', 'basculante', 'maxim-ar'],
  params: [
    P.len('width', 'Largura', 1.2, 0.3, 6, 'type'),
    P.len('height', 'Altura', 1.4, 0.3, 4.5, 'type'),
    { ...P.len('sillH', 'Peitoril (altura)', 0.95, 0, 3, 'instance'), group: 'size' },
    P.pick('shape', 'Formato', 'rect', SHAPES),
    P.pick('operation', 'Abertura', 'casement', OPERATIONS),
    P.count('leaves', 'Folhas', 2, 1, 8),
    P.flag('transom', 'Bandeira', false, 'divisions'),
    P.pick('muntins', 'Baguetes', 'none', MUNTINS, 'divisions'),
    P.count('muntinCols', 'Baguetes por folha (colunas)', 1, 1, 6),
    P.count('muntinRows', 'Baguetes (linhas)', 2, 1, 8),
    ...frameParams,
    P.len('trim', 'Guarnição', 0.1, 0, 0.4, 'type', 'detail', 0.01),
    P.flag('sill', 'Peitoril de pedra', true),
    P.pick('shutters', 'Venezianas', 'none', SHUTTERS, 'detail'),
    P.flag('grille', 'Grade', false),
    ...common,
  ],
  // A largura ocupada inclui guarnição e venezianas abertas (a distribuição não as encosta).
  size: (p) => {
    const w = num(p, 'width'),
      trim = Math.max(0, num(p, 'trim'));
    const shutters = str(p, 'shutters') !== 'none' && str(p, 'shape') !== 'round' ? 2 * (w / 2 + 0.02) : 0;
    return [w + 2 * trim + shutters, num(p, 'height'), 0.2];
  },
  sill: (p) => num(p, 'sillH'),
  opening: (p) => ({ w: num(p, 'width'), h: num(p, 'height'), shape: str(p, 'shape') as OpeningShape, depth: 0.3 }),
  build: (p, out) => buildWindow(p, out),
};

/** Janela saliente (bay window): caixa projetada com janelas nos três lados. */
export const BAY_WINDOW: Family = {
  id: 'baywindow',
  name: 'Janela saliente',
  category: 'windows',
  host: 'face',
  tags: ['bay window', 'saliente', 'bow', 'janela projetada'],
  params: [
    P.len('width', 'Largura', 2.4, 1.2, 6),
    P.len('height', 'Altura', 1.6, 0.8, 3),
    { ...P.len('sillH', 'Peitoril (altura)', 0.6, 0, 3, 'instance'), group: 'size' },
    P.len('depth', 'Projeção', 0.7, 0.3, 1.5),
    P.angle('angle', 'Ângulo dos lados', 45, 20, 90),
    P.flag('roofCap', 'Telhadinho', true),
    ...frameParams,
    P.color('bodyColor', 'Cor do corpo', '#efe9dd'),
    P.color('roofColor', 'Cor do telhadinho', '#6e4a3a'),
    ...common,
  ],
  size: (p) => [num(p, 'width'), num(p, 'height'), num(p, 'depth')],
  sill: (p) => num(p, 'sillH'),
  opening: (p) => ({ w: num(p, 'width') - 0.1, h: num(p, 'height'), shape: 'rect', depth: 0.3 }),
  build(p, out) {
    const w = num(p, 'width'),
      h = num(p, 'height'),
      d = num(p, 'depth');
    const a = (Math.max(20, Math.min(90, num(p, 'angle'))) * Math.PI) / 180;
    const dx = Math.min(d / Math.tan(a), w * 0.4);
    // Contorno em planta (x, z): costas na parede, frente projetada.
    const plan: Pt[] = [[-w / 2, 0], [w / 2, 0], [w / 2 - dx, d], [-w / 2 + dx, d]];
    const grow = (g: number): Pt[] => [[-w / 2 - g, 0], [w / 2 + g, 0], [w / 2 - dx + g * 0.6, d + g], [-w / 2 + dx - g * 0.6, d + g]];
    const body: PartMat = { slot: 'wall', color: str(p, 'bodyColor'), finish: 'plaster' };
    const roof: PartMat = { slot: 'roof', color: str(p, 'roofColor'), finish: 'tile' };
    const frame: PartMat = { slot: 'frame', color: str(p, 'frameColor'), finish: str(p, 'frameFinish') };
    const glass: PartMat = { slot: 'glass', color: str(p, 'glassColor') };
    out.slab(body, plan, -0.3, 0);
    out.slab(body, grow(0.04), h, h + 0.18);
    if (p.roofCap === true) out.slab(roof, grow(0.12), h + 0.18, h + 0.26);
    const panes: [Pt, Pt][] = [
      [plan[0]!, plan[3]!],
      [plan[3]!, plan[2]!],
      [plan[2]!, plan[1]!],
    ];
    for (const [A, B] of panes) {
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (len < 0.1) continue;
      const rot = (-Math.atan2(B[1] - A[1], B[0] - A[0]) * 180) / Math.PI;
      const s = out.placed((A[0] + B[0]) / 2, 0, (A[1] + B[1]) / 2, rot);
      s.box(glass, [0, h / 2, 0], [len - 0.08, h, 0.02]);
      s.box(frame, [0, 0.03, 0], [len, 0.06, 0.08]);
      s.box(frame, [0, h - 0.03, 0], [len, 0.06, 0.08]);
      s.box(frame, [0, h / 2, 0], [0.05, h, 0.06]);
    }
    for (const q of [plan[2]!, plan[3]!]) out.box(frame, [q[0], h / 2, q[1]], [0.07, h, 0.07]);
  },
};
