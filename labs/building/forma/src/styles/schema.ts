// Pacote de estilo: um arquivo JSON que descreve materiais, regras de
// fachada por pavimento (divisões no espírito do CGA/CityEngine) e módulos
// glTF. Sem three.js: o jogo pode validar e interpretar estilos num worker.
import type { MassFlags, RoofKind } from '../core/schema';

export const STYLE_SCHEMA = 'forma-style/1' as const;

export type TextureKind = 'brick' | 'plaster' | 'stone' | 'concrete' | 'tile' | 'wood' | 'metal';

export interface StyleMaterial {
  color: string;
  roughness?: number;
  metalness?: number;
  /** Textura procedural em escala real (multiplicada pela cor). */
  texture?: TextureKind;
  /** Tamanho, em metros, de uma repetição da textura. */
  scale?: number;
}

/**
 * Tamanho de um pedaço da divisão, como no CGA:
 *  - número ou "2.5": absoluto (metros);
 *  - "'0.2": relativo ao comprimento da fachada;
 *  - "~1.4": flutuante (valor nominal em metros; estica para preencher).
 */
export type SplitSize = number | string;

export type Tile =
  | { kind: 'wall' }
  | {
      kind: 'window';
      width?: number;
      height?: number;
      /** Peitoril acima do piso do pavimento. */
      sill?: number;
      arch?: boolean;
      balcony?: boolean;
      brise?: boolean;
      shutters?: boolean;
    }
  | { kind: 'door'; width?: number; height?: number; arch?: boolean }
  | { kind: 'storefront' }
  | { kind: 'pilaster'; width?: number; depth?: number; material?: 'trim' | 'stone' | 'wall' }
  | { kind: 'module'; module: string; width?: number; height?: number; sill?: number; hole?: boolean };

export type SplitNode = { size: SplitSize; tile: Tile } | { repeat: SplitNode[] };

export interface FloorRule {
  split: SplitNode[];
  /** Faixa (cornija) no topo do pavimento. */
  band?: { height: number; depth: number; material?: 'trim' | 'stone' | 'wall' };
}

export interface StyleModule {
  url: string;
  /** Caixa que o módulo ocupa na fachada [largura, altura, profundidade]. */
  size: [number, number, number];
}

export interface StylePack {
  schema: typeof STYLE_SCHEMA;
  id: string;
  name: string;
  description?: string;
  materials: { wall: StyleMaterial; trim: StyleMaterial; stone?: StyleMaterial; roof?: StyleMaterial };
  floors: {
    typical: FloorRule;
    ground?: FloorRule;
    top?: FloorRule;
    /** Exceções por índice de pavimento (0 = térreo). */
    byIndex?: Record<string, FloorRule>;
  };
  /** Embasamento: faixa de pedra na base. */
  plinth?: { height: number };
  roof?: { kind?: RoofKind; height?: number; overhang?: number };
  flags?: Partial<MassFlags>;
  modules?: Record<string, StyleModule>;
}

// ── Validação ─────────────────────────────────────────────────────────
const TEXTURES: TextureKind[] = ['brick', 'plaster', 'stone', 'concrete', 'tile', 'wood', 'metal'];
const TILE_KINDS = ['wall', 'window', 'door', 'storefront', 'pilaster', 'module'];
const ROOFS: RoofKind[] = ['flat', 'shed', 'gable', 'dome', 'hip', 'mansard'];
const isNum = (v: unknown, a: number, b: number) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
const isColor = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** Interpreta um tamanho de divisão; null se inválido. */
export function parseSize(s: SplitSize): { kind: 'abs' | 'rel' | 'float'; value: number } | null {
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? { kind: 'abs', value: s } : null;
  if (typeof s !== 'string') return null;
  const t = s.trim();
  const kind = t.startsWith("'") ? 'rel' : t.startsWith('~') ? 'float' : 'abs';
  const v = Number(kind === 'abs' ? t : t.slice(1));
  if (!Number.isFinite(v) || v < 0 || (kind === 'rel' && v > 1)) return null;
  return { kind, value: v };
}

/** Valida um pacote de estilo; devolve a lista de erros (vazia = válido). */
export function validateStylePack(p: unknown): string[] {
  const errors: string[] = [];
  const fail = (m: string) => errors.length < 30 && errors.push(m);
  if (!p || typeof p !== 'object') return ['Estilo inválido: esperado um objeto JSON.'];
  const s = p as StylePack;
  if (s.schema !== STYLE_SCHEMA) fail(`Esquema do estilo deve ser "${STYLE_SCHEMA}".`);
  if (typeof s.id !== 'string' || !/^[\w:.-]{1,60}$/.test(s.id)) fail('ID do estilo inválido (letras, números, ":", "." e "-").');
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 60) fail('Nome do estilo inválido.');
  const mat = (m: unknown, label: string, required: boolean) => {
    if (m === undefined && !required) return;
    const x = m as StyleMaterial;
    if (!x || typeof x !== 'object') return fail(`Material ${label} ausente.`);
    if (!isColor(x.color)) fail(`Cor do material ${label} inválida (use #rrggbb).`);
    if (x.roughness !== undefined && !isNum(x.roughness, 0, 1)) fail(`Aspereza do material ${label} fora de 0..1.`);
    if (x.metalness !== undefined && !isNum(x.metalness, 0, 1)) fail(`Metalicidade do material ${label} fora de 0..1.`);
    if (x.texture !== undefined && !TEXTURES.includes(x.texture)) fail(`Textura do material ${label} desconhecida.`);
    if (x.scale !== undefined && !isNum(x.scale, 0.05, 20)) fail(`Escala da textura ${label} fora de 0,05..20 m.`);
  };
  const ms = s.materials ?? ({} as StylePack['materials']);
  mat(ms.wall, 'parede', true);
  mat(ms.trim, 'caixilho', true);
  mat(ms.stone, 'pedra', false);
  mat(ms.roof, 'cobertura', false);
  const modules = s.modules ?? {};
  for (const [id, m] of Object.entries(modules)) {
    if (!m || typeof m.url !== 'string' || !m.url) fail(`Módulo "${id}" sem URL.`);
    if (!Array.isArray(m?.size) || m.size.length !== 3 || !m.size.every((v) => isNum(v, 0.01, 50))) fail(`Módulo "${id}" com tamanho inválido.`);
  }
  let depth = 0;
  const tile = (t: Tile, where: string) => {
    if (!t || !TILE_KINDS.includes(t.kind)) return fail(`${where}: tipo de peça desconhecido.`);
    const r = t as Record<string, unknown>;
    for (const k of ['width', 'height', 'sill', 'depth']) if (r[k] !== undefined && !isNum(r[k], 0, 30)) fail(`${where}: ${k} fora do limite.`);
    if (t.kind === 'module' && !modules[t.module]) fail(`${where}: módulo "${t.module}" não declarado.`);
  };
  const nodes = (list: SplitNode[], where: string) => {
    if (!Array.isArray(list) || !list.length || list.length > 40) return fail(`${where}: divisão vazia ou longa demais.`);
    if (++depth > 200) return;
    let repeats = 0;
    for (const n of list) {
      if ('repeat' in n) {
        if (++repeats > 1) fail(`${where}: só uma repetição por divisão.`);
        if (n.repeat.some((x) => 'repeat' in x)) fail(`${where}: repetição dentro de repetição não é permitida.`);
        nodes(n.repeat, where + ' (repetição)');
      } else {
        if (!parseSize(n.size)) fail(`${where}: tamanho "${String(n.size)}" inválido.`);
        tile(n.tile, where);
      }
    }
  };
  const rule = (r: FloorRule | undefined, where: string, required: boolean) => {
    if (!r) return required ? fail(`${where}: regra ausente.`) : undefined;
    nodes(r.split, where);
    if (r.band && (!isNum(r.band.height, 0.02, 2) || !isNum(r.band.depth, 0, 1))) fail(`${where}: faixa inválida.`);
  };
  const f = s.floors ?? ({} as StylePack['floors']);
  rule(f.typical, 'Pavimento tipo', true);
  rule(f.ground, 'Térreo', false);
  rule(f.top, 'Último pavimento', false);
  for (const [k, r] of Object.entries(f.byIndex ?? {})) {
    if (!/^\d{1,2}$/.test(k)) fail(`Exceção de pavimento "${k}" deve ser um número.`);
    rule(r, `Pavimento ${k}`, true);
  }
  if (s.plinth && !isNum(s.plinth.height, 0.05, 3)) fail('Embasamento com altura inválida.');
  if (s.roof) {
    if (s.roof.kind !== undefined && !ROOFS.includes(s.roof.kind)) fail('Tipo de cobertura do estilo inválido.');
    if (s.roof.height !== undefined && !isNum(s.roof.height, 0.2, 10)) fail('Altura da cobertura do estilo inválida.');
    if (s.roof.overhang !== undefined && !isNum(s.roof.overhang, 0, 1.5)) fail('Beiral do estilo inválido.');
  }
  return errors;
}
