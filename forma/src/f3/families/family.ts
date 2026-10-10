// Famílias de componentes paramétricos (como as famílias do Revit): uma função
// pura parâmetros → peças, com o esquema dos parâmetros declarado. Sem three.
//
// Referencial local de uma peça hospedada numa face: x ao longo da face (centro
// da peça em x = 0), y para cima a partir da base da peça, z para fora (a face
// da parede em z = 0). Peças livres usam o mesmo referencial no chão.
import type { ParamValue, Vec3 } from '../model/schema';

export type Category =
  | 'windows'
  | 'doors'
  | 'gates'
  | 'balconies'
  | 'railings'
  | 'fences'
  | 'walls'
  | 'structure'
  | 'stairs'
  | 'canopies'
  | 'shading'
  | 'ornament'
  | 'roofgear'
  | 'industrial'
  | 'facade'
  | 'site';

export const CATEGORY_NAMES: Record<Category, string> = {
  windows: 'Janelas',
  doors: 'Portas',
  gates: 'Portões',
  balconies: 'Sacadas e varandas',
  railings: 'Guarda-corpos e grades',
  fences: 'Muros e cercas',
  walls: 'Paredes',
  structure: 'Pilares e vigas',
  stairs: 'Escadas e rampas',
  canopies: 'Marquises e toldos',
  shading: 'Brises',
  ornament: 'Ornamentos',
  roofgear: 'Telhado',
  industrial: 'Industrial',
  facade: 'Revestimentos e fachada',
  site: 'Terreno',
};

export type ParamKind = 'length' | 'angle' | 'count' | 'ratio' | 'enum' | 'bool' | 'color' | 'finish';

export interface ParamDef {
  key: string;
  label: string;
  kind: ParamKind;
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** 'type': vale para todas as ocorrências do tipo; 'instance': de cada ocorrência. */
  scope: 'type' | 'instance';
  /** Grupo no inspetor (dimensões, divisões, perfil, materiais, detalhes). */
  group: 'size' | 'divisions' | 'profile' | 'material' | 'detail';
}

export type Params = Record<string, ParamValue>;

/** Papéis de material das peças; a cor vem dos parâmetros. */
export type Slot = 'frame' | 'glass' | 'panel' | 'metal' | 'wood' | 'stone' | 'concrete' | 'wall' | 'roof' | 'green' | 'fabric' | 'light' | 'dark';

export interface PartMat {
  slot: Slot;
  color: string;
  finish?: string;
}

/** Recebe as peças no referencial local da família. */
export interface PartSink {
  /** Caixa: centro e tamanho; rotação opcional (graus) em torno de y, x e z, nessa ordem. */
  box(m: PartMat, center: Vec3, size: Vec3, rot?: Vec3): void;
  /** Cilindro em pé (eixo y): centro da base, raio, altura; `sides` facetas. */
  cylinder(m: PartMat, base: Vec3, radius: number, height: number, sides?: number): void;
  /** Cilindro entre dois pontos (barras, tubos, balaústres inclinados). */
  rod(m: PartMat, a: Vec3, b: Vec3, radius: number, sides?: number): void;
  /** Prisma: perfil no plano xy (com furos) extrudado de z0 a z1. */
  prism(m: PartMat, profile: [number, number][], z0: number, z1: number, holes?: [number, number][][]): void;
  /** Placa em planta: contorno no plano xz (x, z) de y0 a y1 (lajes, degraus, bases). */
  slab(m: PartMat, plan: [number, number][], y0: number, y1: number, holes?: [number, number][][]): void;
  /** O mesmo sumidouro com a origem deslocada. */
  translated(x: number, y: number, z: number): PartSink;
  /** O mesmo sumidouro girado em torno de y (graus) e deslocado. */
  placed(x: number, y: number, z: number, rotY: number): PartSink;
  /** Perfil no plano yz varrido ao longo de x, de x0 a x1 (cornijas, rufos). */
  sweepX(m: PartMat, profile: [number, number][], x0: number, x1: number): void;
}

export interface Opening {
  /** Largura e altura do vão. */
  w: number;
  h: number;
  /** Forma do topo do vão. */
  shape: 'rect' | 'arch' | 'segment' | 'round';
  /** Quanto o vão entra na parede (m); ≥ espessura atravessa. */
  depth: number;
  /** Profundidade do cômodo atrás do vão (m): interior de verdade visto pelo vidro. */
  room?: number;
}

export interface Family {
  id: string;
  name: string;
  category: Category;
  /** Onde a peça se apoia. */
  host: 'face' | 'free' | 'path' | 'roof';
  tags: string[];
  params: ParamDef[];
  /** Largura, altura e profundidade da peça (para encaixe, arranjo e regra de fachada). */
  size(p: Params): Vec3;
  /** Vão que a peça abre na face hospedeira (portas, janelas, portões). */
  opening?(p: Params): Opening | null;
  /** Altura padrão da base da peça acima do piso (peitoril). */
  sill?(p: Params): number;
  build(p: Params, out: PartSink, ctx: BuildContext): void;
}

export interface BuildContext {
  /** Comprimento do caminho (famílias de caminho) ou da face. */
  length: number;
  /** Profundidade do vão aberto na parede (recesso). */
  reveal: number;
  /** Índice desta cópia num arranjo. */
  index: number;
  /** Para famílias de caminho: pontos já no referencial local (x ao longo). */
  path?: Vec3[];
}

/** Valores efetivos: padrão da família ← tipo ← ocorrência. */
export function resolveParams(f: Family, ...layers: (Params | undefined)[]): Params {
  const out: Params = {};
  for (const d of f.params) out[d.key] = d.default;
  for (const l of layers) if (l) for (const k in l) if (k in out || k.startsWith('_')) out[k] = l[k]!;
  for (const d of f.params) {
    const v = out[d.key];
    if (typeof v === 'number' && (d.min !== undefined || d.max !== undefined)) out[d.key] = Math.max(d.min ?? -Infinity, Math.min(d.max ?? Infinity, v));
  }
  return out;
}

export const num = (p: Params, k: string): number => Number(p[k] ?? 0);
export const str = (p: Params, k: string): string => String(p[k] ?? '');
export const bool = (p: Params, k: string): boolean => p[k] === true || p[k] === 'true';

/** Atalhos para declarar parâmetros. */
export const P = {
  len: (key: string, label: string, def: number, min: number, max: number, scope: ParamDef['scope'] = 'type', group: ParamDef['group'] = 'size', step = 0.05): ParamDef => ({ key, label, kind: 'length', default: def, min, max, step, scope, group }),
  count: (key: string, label: string, def: number, min: number, max: number, group: ParamDef['group'] = 'divisions'): ParamDef => ({ key, label, kind: 'count', default: def, min, max, step: 1, scope: 'type', group }),
  angle: (key: string, label: string, def: number, min: number, max: number, scope: ParamDef['scope'] = 'type'): ParamDef => ({ key, label, kind: 'angle', default: def, min, max, step: 1, scope, group: 'profile' }),
  ratio: (key: string, label: string, def: number, scope: ParamDef['scope'] = 'instance'): ParamDef => ({ key, label, kind: 'ratio', default: def, min: 0, max: 1, step: 0.05, scope, group: 'detail' }),
  pick: (key: string, label: string, def: string, options: [string, string][], group: ParamDef['group'] = 'profile'): ParamDef => ({ key, label, kind: 'enum', default: def, options: options.map(([value, label]) => ({ value, label })), scope: 'type', group }),
  flag: (key: string, label: string, def: boolean, group: ParamDef['group'] = 'detail'): ParamDef => ({ key, label, kind: 'bool', default: def, scope: 'type', group }),
  color: (key: string, label: string, def: string): ParamDef => ({ key, label, kind: 'color', default: def, scope: 'type', group: 'material' }),
  finish: (key: string, label: string, def: string): ParamDef => ({ key, label, kind: 'finish', default: def, scope: 'type', group: 'material' }),
};
