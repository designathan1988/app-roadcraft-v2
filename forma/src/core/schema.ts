// Esquema de projeto FORMA v2.
// Unidades: metros; Y para cima; planta em [x, z]; ângulos em graus.
// Todos os IDs são strings estáveis (UUID); nunca derivados de coordenadas.

export const SCHEMA = 'forma/2' as const;

export type ID = string;
export type Vec2 = [number, number];

export interface Project {
  schema: typeof SCHEMA;
  name: string;
  lots: Lot[];
  buildings: Building[];
  styles: StyleRef[];
  meta: { createdWith: string; migratedFrom?: 1 };
}

// ── Lote ──────────────────────────────────────────────────────────────
export interface Lot {
  id: ID;
  name: string;
  /** Polígono do lote em coordenadas do mundo, anti-horário. */
  polygon: Vec2[];
  /** Índices das arestas voltadas para a rua (testada). */
  frontEdges: number[];
  rules?: LotRules;
}

export interface LotRules {
  setbacks: { front: number; side: number; back: number };
  /** Taxa de ocupação máxima (0..1). */
  maxOccupancy?: number;
  /** Coeficiente de aproveitamento máximo. */
  maxFAR?: number;
  /** Gabarito: altura máxima em metros. */
  maxHeight?: number;
  maxStoreys?: number;
  /** Taxa de permeabilidade mínima (0..1). */
  minPermeability?: number;
  enforcement: 'block' | 'warn';
  /** Gabarito medido até a cumeeira (padrão) ou até o beiral. */
  heightTo?: 'eave' | 'ridge';
}

// ── Edifício ──────────────────────────────────────────────────────────
export interface Building {
  id: ID;
  name: string;
  lotId: ID | null;
  /** Origem do edifício no mundo [x, z]. */
  position: Vec2;
  /** Rotação em graus em torno de Y (mesma convenção do v1). */
  rotation: number;
  storeys: Storey[];
  masses: Mass[];
  openings: Opening[];
  slabs: Slab[];
  stairs: Stair[];
  styleRef?: ID;
}

/** Pavimento. Elevação relativa à origem do edifício (y = 0 no chão). */
export interface Storey {
  id: ID;
  name: string;
  elevation: number;
  height: number;
  slabThickness: number;
  /** Paredes internas (as externas são derivadas das massas). */
  graph: WallGraph;
  rooms: Room[];
}

export interface WallGraph {
  nodes: GraphNode[];
  walls: Wall[];
}

export interface GraphNode {
  id: ID;
  p: Vec2;
}

export interface Wall {
  id: ID;
  a: ID;
  b: ID;
  thickness: number;
  height?: number;
  sideA?: Partial<Finish>;
  sideB?: Partial<Finish>;
  splitFrom?: ID;
}

export interface Room {
  id: ID;
  name: string;
  wallIds: ID[];
}

export interface Slab {
  id: ID;
  storeyId: ID;
  outline: Vec2[];
  cutouts: Vec2[][];
}

export interface Stair {
  id: ID;
  fromStorey: ID;
  toStorey: ID;
  path: Vec2[];
  width: number;
}

// ── Massa (volume extrudado entre pavimentos) ─────────────────────────
export interface RingVertex {
  id: ID;
  p: Vec2;
}

/** Anel de polígono. O ID de uma aresta é o ID do seu vértice inicial. */
export interface Ring {
  vertices: RingVertex[];
}

export type FacadePattern = 'regular' | 'storefront' | 'curtain' | 'blank' | 'arched';
export type RoofKind = 'flat' | 'shed' | 'gable' | 'dome' | 'hip' | 'mansard';

export interface Finish {
  /** Cor da parede. */
  wall: string;
  /** Cor dos caixilhos. */
  trim: string;
  material?: string;
}

export interface FacadeSpec {
  pattern: FacadePattern;
  windowWidth: number;
  windowHeight: number;
  spacing: number;
}

export interface MassFlags {
  balconies: boolean;
  brise: boolean;
  cornice: boolean;
  garden: boolean;
  pilotis: boolean;
}

export interface Roof {
  kind: RoofKind;
  height: number;
  color: string;
  direction?: number;
  overhang?: number;
}

/** Ajustes de uma aresta (fachada) específica. */
export interface EdgeOverride {
  pattern?: FacadePattern;
  windowWidth?: number;
  windowHeight?: number;
  spacing?: number;
  wall?: string;
  trim?: string;
  balconies?: boolean;
  brise?: boolean;
  /** true: as aberturas desenhadas substituem o ritmo automático. */
  manual?: boolean;
  splitFrom?: ID;
}

export interface Mass {
  id: ID;
  name: string;
  /** Coordenadas locais do edifício. Anel externo anti-horário. */
  outer: Ring;
  holes: Ring[];
  fromStorey: ID;
  toStorey: ID;
  roof: Roof;
  facade: FacadeSpec;
  finish: Finish;
  flags: MassFlags;
  edges: Record<ID, EdgeOverride>;
}

// ── Aberturas (vão separado do preenchimento, como no IFC) ───────────
export type OpeningHost =
  | { kind: 'massEdge'; massId: ID; edgeId: ID }
  | { kind: 'wall'; storeyId: ID; wallId: ID };

export type OpeningFillType = 'window' | 'door' | 'void' | 'storefront';

export interface Opening {
  id: ID;
  host: OpeningHost;
  storeyId: ID;
  /** Distância em metros do início da aresta até o centro da abertura. */
  offset: number;
  /** Peitoril: altura da base da abertura acima do piso do pavimento. */
  sill: number;
  width: number;
  height: number;
  fill: { type: OpeningFillType; arch?: boolean; module?: string };
}

export interface StyleRef {
  id: ID;
  name: string;
  url?: string;
}

// ── Limites (configuráveis pelo jogo) ─────────────────────────────────
export interface Limits {
  maxBuildings: number;
  maxStoreys: number;
  maxHeight: number;
  maxVertices: number;
  maxHoles: number;
  maxOpeningsPerEdge: number;
  worldExtent: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBuildings: 120,
  maxStoreys: 30,
  maxHeight: 100,
  maxVertices: 128,
  maxHoles: 12,
  maxOpeningsPerEdge: 80,
  worldExtent: 500,
};
