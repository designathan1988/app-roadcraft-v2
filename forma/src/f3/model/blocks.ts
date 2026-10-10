// Blocos de massa prontos (modelar em instantes): cada bloco é um sólido com
// planta, altura e telhado, montado no referencial local do bloco (x largura,
// z profundidade, origem no meio da frente, costas em z = 0 para encostar numa
// face). Sem three.
import type { RoofKind, Solid, Vec2 } from './schema';
import { facadeRule, planVertices, roofSpec, solid } from './defaults';

export interface BlockDef {
  id: string;
  name: string;
  icon: string;
  /** Largura, profundidade padrão (m). */
  w: number;
  d: number;
  /** Altura em pavimentos (multiplica o pé-direito do edifício). */
  levels: number;
  roof: RoofKind;
  /** Planta normalizada (0..1 em x e z) ou forma especial. */
  plan: 'rect' | 'L' | 'U' | 'T' | 'cross' | 'circle' | 'hex' | 'oct' | 'tri';
}

export const BLOCKS: BlockDef[] = [
  { id: 'box', name: 'Caixa', icon: 'cube', w: 8, d: 8, levels: 1, roof: 'flat', plan: 'rect' },
  { id: 'slab-tall', name: 'Torre', icon: 'layers', w: 8, d: 8, levels: 6, roof: 'flat', plan: 'rect' },
  { id: 'house', name: 'Casa duas águas', icon: 'gable', w: 9, d: 7, levels: 1, roof: 'gable', plan: 'rect' },
  { id: 'hipblock', name: 'Quatro águas', icon: 'hip', w: 10, d: 8, levels: 1, roof: 'hip', plan: 'rect' },
  { id: 'shed', name: 'Água única', icon: 'shed', w: 8, d: 6, levels: 1, roof: 'shed', plan: 'rect' },
  { id: 'L', name: 'Bloco em L', icon: 'l', w: 14, d: 12, levels: 2, roof: 'flat', plan: 'L' },
  { id: 'U', name: 'Bloco em U', icon: 'u', w: 18, d: 14, levels: 2, roof: 'flat', plan: 'U' },
  { id: 'T', name: 'Bloco em T', icon: 'top', w: 16, d: 12, levels: 2, roof: 'flat', plan: 'T' },
  { id: 'cross', name: 'Cruz', icon: 'add', w: 14, d: 14, levels: 2, roof: 'flat', plan: 'cross' },
  { id: 'cyl', name: 'Cilindro', icon: 'circle', w: 8, d: 8, levels: 2, roof: 'flat', plan: 'circle' },
  { id: 'rotunda', name: 'Rotunda com cúpula', icon: 'dome', w: 10, d: 10, levels: 2, roof: 'dome', plan: 'circle' },
  { id: 'hex', name: 'Hexágono', icon: 'polygon', w: 9, d: 9, levels: 1, roof: 'pyramid', plan: 'hex' },
  { id: 'oct', name: 'Octógono', icon: 'polygon', w: 9, d: 9, levels: 2, roof: 'flat', plan: 'oct' },
  { id: 'vault', name: 'Galpão abobadado', icon: 'vault', w: 12, d: 20, levels: 2, roof: 'vault', plan: 'rect' },
  { id: 'saw', name: 'Galpão dente de serra', icon: 'sawtooth', w: 20, d: 16, levels: 2, roof: 'sawtooth', plan: 'rect' },
  { id: 'gambrel', name: 'Celeiro', icon: 'gambrel', w: 10, d: 14, levels: 1, roof: 'gambrel', plan: 'rect' },
  { id: 'mansard', name: 'Mansarda', icon: 'mansard', w: 12, d: 10, levels: 1, roof: 'mansard', plan: 'rect' },
  { id: 'prism', name: 'Prisma', icon: 'pyramid', w: 8, d: 7, levels: 1, roof: 'flat', plan: 'tri' },
  { id: 'arch', name: 'Arco (para recortar)', icon: 'vault', w: 3, d: 2, levels: 1, roof: 'vault', plan: 'rect' },
];

/** Planta normalizada (0..1) de cada forma, anti-horária em (x, z). */
function normPlan(kind: BlockDef['plan']): Vec2[] | null {
  switch (kind) {
    case 'rect':
      return [[0, 0], [1, 0], [1, 1], [0, 1]];
    case 'L':
      return [[0, 0], [1, 0], [1, 0.45], [0.45, 0.45], [0.45, 1], [0, 1]];
    case 'U':
      return [[0, 0], [1, 0], [1, 1], [0.7, 1], [0.7, 0.4], [0.3, 0.4], [0.3, 1], [0, 1]];
    case 'T':
      return [[0, 0], [1, 0], [1, 0.4], [0.65, 0.4], [0.65, 1], [0.35, 1], [0.35, 0.4], [0, 0.4]];
    case 'cross':
      return [[0.33, 0], [0.67, 0], [0.67, 0.33], [1, 0.33], [1, 0.67], [0.67, 0.67], [0.67, 1], [0.33, 1], [0.33, 0.67], [0, 0.67], [0, 0.33], [0.33, 0.33]];
    case 'tri':
      return [[0, 0], [1, 0], [0.5, 1]];
    case 'hex':
    case 'oct': {
      const n = kind === 'hex' ? 6 : 8;
      return Array.from({ length: n }, (_, i) => {
        const a = Math.PI / n + (i / n) * Math.PI * 2;
        return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)] as Vec2;
      });
    }
    default:
      return null;
  }
}

export interface BlockPlacement {
  /** Origem (meio da frente do bloco) e direções no plano do edifício. */
  origin: Vec2;
  /** Direção da largura (x do bloco) e da profundidade (z do bloco, "para dentro"). */
  ux: Vec2;
  uz: Vec2;
  base: number;
  levelHeight: number;
  op: Solid['op'];
  w?: number;
  d?: number;
  /** Encostado numa face: a frente é o lado oposto à parede. */
  attached?: boolean;
}

/** Monta o sólido do bloco posicionado no edifício. */
export function blockSolid(def: BlockDef, at: BlockPlacement): Solid {
  const w = at.w ?? def.w,
    d = at.d ?? def.d;
  const local = (p: Vec2): Vec2 => {
    const x = (p[0] - 0.5) * w,
      z = p[1] * d;
    return [at.origin[0] + at.ux[0] * x + at.uz[0] * z, at.origin[1] + at.ux[1] * x + at.uz[1] * z];
  };
  let pts: Vec2[];
  let bulges: (number | undefined)[] = [];
  if (def.plan === 'circle') {
    const c = local([0.5, 0.5]);
    const r = Math.min(w, d) / 2;
    pts = [
      [c[0] + r, c[1]],
      [c[0], c[1] + r],
      [c[0] - r, c[1]],
      [c[0], c[1] - r],
    ];
    bulges = [1, 1, 1, 1].map(() => Math.tan(Math.PI / 8));
  } else pts = normPlan(def.plan)!.map(local);
  // O referencial pode estar espelhado (ux × uz): garante o anel anti-horário.
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!,
      b = pts[(i + 1) % pts.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) {
    pts = [...pts].reverse();
    bulges = [...bulges].reverse();
  }
  const height = def.id === 'arch' ? at.levelHeight * 0.75 : def.levels * at.levelHeight;
  const made = solid({
    name: def.name,
    op: at.op,
    plan: { outer: planVertices(pts, (i) => (bulges[i] ? { bulge: bulges[i] } : {})), holes: [] },
    base: at.base,
    height,
    roof: roofSpec(def.roof, def.roof === 'vault' ? { direction: def.id === 'arch' ? 90 : 0 } : def.roof === 'flat' ? { parapet: at.op === 'add' ? 0.6 : 0 } : {}),
    plinth: at.base < 0.3 && at.op === 'add' ? 0.4 : 0,
  });
  if (at.op === 'add') made.facade = defaultFacade(def, made, at);
  return made;
}

/** Fachada inicial de cada bloco: modelar em instantes (tudo editável depois). */
function defaultFacade(def: BlockDef, s: Solid, at: BlockPlacement): Solid['facade'] {
  // Frente: o lado cujo meio fica mais perto da origem do bloco.
  const o = s.plan.outer;
  let front = o[0]!.id,
    best = Infinity;
  o.forEach((v, i) => {
    const n = o[(i + 1) % o.length]!;
    const m: Vec2 = [(v.p[0] + n.p[0]) / 2, (v.p[1] + n.p[1]) / 2];
    const dd = Math.hypot(m[0] - at.origin[0], m[1] - at.origin[1]);
    const score = at.attached ? -dd : dd;
    if (score < best) {
      best = score;
      front = v.id;
    }
  });
  const door = (type: string) => facadeRule(type, { levels: 'ground', edges: [front], mode: 'count', value: 1 });
  const onGround = at.base < 0.3;
  switch (def.id) {
    case 'arch':
      return [];
    case 'house':
    case 'hipblock':
    case 'mansard':
      return [...(onGround ? [door('door-panel')] : []), facadeRule('win-casement', { mode: 'max', value: 3.2 })];
    case 'gambrel':
      return [...(onGround ? [door('garage-carriage')] : []), facadeRule('win-sash', { mode: 'max', value: 4 })];
    case 'vault':
    case 'saw':
      return [...(onGround ? [door('loading-dock')] : []), facadeRule('win-industrial', { mode: 'max', value: 4.5 })];
    case 'rotunda':
      return [facadeRule('win-arched', { mode: 'spacing', value: 3 })];
    case 'slab-tall':
      return [...(onGround ? [door('door-glass')] : []), facadeRule('win-sliding', { mode: 'spacing', value: 2.6 })];
    default:
      return [...(onGround ? [door('door-double')] : []), facadeRule('win-casement', { mode: 'max', value: 3 })];
  }
}
