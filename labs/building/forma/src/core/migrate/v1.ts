// Migração de projetos FORMA v1 (volumes extrudados) para o esquema forma/2.
import type { Building, EdgeOverride, FacadePattern, ID, Mass, Opening, OpeningFillType, Project, Ring, RoofKind, Storey, Vec2 } from '../schema';
import { SCHEMA } from '../schema';
import { uid } from '../ids';
import { clamp, clean, validPolygon } from '../../geometry/polygon';
import { validHoles } from '../../geometry/boolean';

export interface V1Opening {
  u: number;
  y: number;
  w: number;
  h: number;
  kind?: string;
  arch?: boolean;
  floor?: number;
}

export interface V1Face {
  facade?: string;
  color?: string;
  trim?: string;
  windowWidth?: number;
  windowHeight?: number;
  spacing?: number;
  balconies?: boolean;
  brise?: boolean;
  manual?: boolean;
  openings?: V1Opening[];
}

export interface V1Volume {
  id: string;
  name: string;
  points: Vec2[];
  holes: Vec2[][];
  x: number;
  z: number;
  rotation: number;
  base: number;
  height: number;
  floors: number;
  color: string;
  roof: string;
  roofColor: string;
  roofHeight: number;
  facade: string;
  windowWidth: number;
  windowHeight: number;
  spacing: number;
  trim: string;
  balconies: boolean;
  brise: boolean;
  cornice: boolean;
  garden: boolean;
  pilotis: boolean;
  faces: Record<string, V1Face>;
}

export interface V1Project {
  version: 1;
  name: string;
  volumes: V1Volume[];
}

const V1_DEFAULTS: Omit<V1Volume, 'id'> = {
  name: 'Volume',
  points: [[-5, -4], [5, -4], [5, 4], [-5, 4]],
  holes: [],
  x: 0,
  z: 0,
  rotation: 0,
  base: 0,
  height: 9.6,
  floors: 3,
  color: '#b77b56',
  roof: 'flat',
  roofColor: '#474c4e',
  roofHeight: 2.3,
  facade: 'regular',
  windowWidth: 1.35,
  windowHeight: 1.8,
  spacing: 2.5,
  trim: '#383e40',
  balconies: false,
  brise: false,
  cornice: true,
  garden: false,
  pilotis: false,
  faces: {},
};

const COLOR = /^#[0-9a-f]{6}$/i;

/** Valida e normaliza um projeto v1, com as mesmas regras do validador original. */
export function normalizeV1(raw: unknown): V1Project {
  const r = raw as Partial<V1Project> | null;
  if (!r || r.version !== 1 || !Array.isArray(r.volumes) || r.volumes.length > 120) throw new Error('Projeto incompatível ou acima de 120 volumes.');
  const volumes = r.volumes.map((v) => {
    if (!validPolygon(v.points)) throw new Error('O projeto contém uma base inválida.');
    const out: V1Volume = { ...structuredClone(V1_DEFAULTS), ...structuredClone(v) };
    if (typeof out.id !== 'string' || !out.id) out.id = uid();
    out.points = clean(v.points);
    for (const k of ['height', 'base', 'floors', 'x', 'z', 'rotation', 'windowWidth', 'windowHeight', 'spacing', 'roofHeight'] as const)
      if (!Number.isFinite(out[k])) throw new Error('Parâmetro inválido: ' + k);
    out.height = clamp(out.height, 0.5, 100);
    out.base = clamp(out.base, 0, 100);
    out.floors = Math.round(clamp(out.floors, 1, 30));
    out.x = clamp(out.x, -500, 500);
    out.z = clamp(out.z, -500, 500);
    out.spacing = clamp(out.spacing, 1, 8);
    out.windowWidth = clamp(out.windowWidth, 0.25, 5);
    out.windowHeight = clamp(out.windowHeight, 0.3, 4);
    out.roofHeight = clamp(out.roofHeight, 0.2, 10);
    if (!Array.isArray(out.holes) || out.holes.length > 12 || !validHoles(out.points, out.holes)) throw new Error('Pátio inválido.');
    if (!['flat', 'gable', 'shed', 'dome'].includes(out.roof)) out.roof = 'flat';
    for (const k of ['color', 'trim', 'roofColor'] as const) if (!COLOR.test(out[k])) throw new Error('Cor inválida.');
    out.faces = out.faces && typeof out.faces === 'object' ? out.faces : {};
    for (const f of Object.values(out.faces)) {
      if (!f || typeof f !== 'object') throw new Error('Fachada inválida.');
      if (f.openings) {
        if (!Array.isArray(f.openings) || f.openings.length > 80) throw new Error('Aberturas inválidas.');
        for (const o of f.openings) {
          if (!(['u', 'y', 'w', 'h'] as const).every((k) => Number.isFinite(o[k]))) throw new Error('Abertura inválida.');
          o.u = clamp(o.u, 0, 1);
          o.y = clamp(o.y, 0, out.height);
          o.w = clamp(o.w, 0.25, 8);
          o.h = clamp(o.h, 0.3, 8);
        }
      }
    }
    out.name = String(out.name).slice(0, 60);
    return out;
  });
  return { version: 1, name: String(r.name || 'Projeto sem título').slice(0, 70), volumes };
}

const PATTERNS: FacadePattern[] = ['regular', 'storefront', 'curtain', 'blank', 'arched'];
const pattern = (s: string | undefined): FacadePattern | undefined => (s && (PATTERNS as string[]).includes(s) ? (s as FacadePattern) : undefined);

function fillType(kind: string | undefined): OpeningFillType {
  if (kind === 'door') return 'door';
  if (kind === 'opening') return 'void';
  if (kind === 'storefront') return 'storefront';
  return 'window';
}

export const storeyName = (i: number): string => (i === 0 ? 'Térreo' : `${i}º pavimento`);

export interface MigrateOptions {
  newId?: () => ID;
  /** Versão que aparece em meta.createdWith. */
  version?: string;
}

/** Converte um volume v1 em um edifício v2 (um volume vira um edifício com uma massa). */
export function migrateVolume(v: V1Volume, newId: () => ID = uid): Building {
  const levelHeight = v.height / v.floors;
  const storeys: Storey[] = Array.from({ length: v.floors }, (_, i) => ({
    id: newId(),
    name: storeyName(i),
    elevation: v.base + i * levelHeight,
    height: levelHeight,
    slabThickness: 0.16,
    graph: { nodes: [], walls: [] },
    rooms: [],
  }));
  const ring = (points: Vec2[]): Ring => ({ vertices: points.map((p) => ({ id: newId(), p: [p[0], p[1]] as Vec2 })) });
  const outer = ring(v.points),
    holes = v.holes.map(ring);
  // Índice plano do v1: anel externo e depois os furos, aresta por aresta.
  const flat = [outer, ...holes].flatMap((r) => r.vertices.map((vx, i) => ({ id: vx.id, a: vx.p, b: r.vertices[(i + 1) % r.vertices.length]!.p })));
  const mass: Mass = {
    id: newId(),
    name: v.name,
    outer,
    holes,
    fromStorey: storeys[0]!.id,
    toStorey: storeys.at(-1)!.id,
    roof: { kind: v.roof as RoofKind, height: v.roofHeight, color: v.roofColor },
    facade: { pattern: pattern(v.facade) ?? 'regular', windowWidth: v.windowWidth, windowHeight: v.windowHeight, spacing: v.spacing },
    finish: { wall: v.color, trim: v.trim },
    flags: { balconies: v.balconies, brise: v.brise, cornice: v.cornice, garden: v.garden, pilotis: v.pilotis },
    edges: {},
  };
  const openings: Opening[] = [];
  for (const [key, f] of Object.entries(v.faces)) {
    const edge = flat[Number(key)];
    if (!edge) continue;
    const o: EdgeOverride = {};
    const p = pattern(f.facade);
    if (p) o.pattern = p;
    if (f.color && COLOR.test(f.color)) o.wall = f.color;
    if (f.trim && COLOR.test(f.trim)) o.trim = f.trim;
    for (const k of ['windowWidth', 'windowHeight', 'spacing'] as const) if (Number.isFinite(f[k])) o[k] = f[k];
    if (typeof f.balconies === 'boolean') o.balconies = f.balconies;
    if (typeof f.brise === 'boolean') o.brise = f.brise;
    if (f.manual) {
      o.manual = true;
      const len = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
      for (const op of f.openings ?? []) {
        const si = Math.min(v.floors - 1, Math.max(0, Math.floor(op.y / levelHeight + 1e-9)));
        openings.push({
          id: newId(),
          host: { kind: 'massEdge', massId: mass.id, edgeId: edge.id },
          storeyId: storeys[si]!.id,
          offset: op.u * len,
          sill: op.y - si * levelHeight,
          width: op.w,
          height: op.h,
          fill: { type: fillType(op.kind), ...(op.arch ? { arch: true } : {}) },
        });
      }
    }
    if (Object.keys(o).length) mass.edges[edge.id] = o;
  }
  return {
    id: v.id || newId(),
    name: v.name,
    lotId: null,
    position: [v.x, v.z],
    rotation: v.rotation,
    storeys,
    masses: [mass],
    openings,
    slabs: [],
    stairs: [],
  };
}

export function migrateV1(raw: unknown, opts: MigrateOptions = {}): Project {
  const v1 = normalizeV1(raw);
  const newId = opts.newId ?? uid;
  return {
    schema: SCHEMA,
    name: v1.name,
    lots: [],
    buildings: v1.volumes.map((v) => migrateVolume(v, newId)),
    styles: [],
    meta: { createdWith: 'forma ' + (opts.version ?? '2'), migratedFrom: 1 },
  };
}
