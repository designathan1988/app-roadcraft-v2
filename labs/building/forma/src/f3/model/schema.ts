// Documento FORMA 3 (forma/3).
// Metros; Y para cima; planta em [x, z] no referencial do edifício; ângulos em graus.
// IDs estáveis (nunca derivados de coordenadas). Este módulo não importa three.
import type { Lot } from '../../core/schema';
import type { StylePack } from '../../styles/schema';

export const SCHEMA3 = 'forma/3' as const;

export type ID = string;
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface Project3 {
  schema: typeof SCHEMA3;
  name: string;
  lots: Lot[];
  buildings: Building3[];
  /** Tipos de componente do projeto (os incluídos não precisam estar aqui). */
  types: ComponentType[];
  styles: StylePack[];
  meta: { createdWith: string; migratedFrom?: 1 | 2 };
  /** Camadas (como as Tags do SketchUp e as camadas do Rhino); sem camada = "Padrão". */
  layers?: Layer[];
  /** Estado da vista: categorias de componente escondidas e camada ativa. */
  view?: ViewState;
  /** Imagens do projeto (placas de imagem nas fachadas), embutidas. */
  images?: ProjectImage[];
}

export interface ProjectImage {
  id: ID;
  name: string;
  /** Imagem embutida (data URL), no máximo 2048 px. */
  data: string;
  w: number;
  h: number;
}

/**
 * Camada: visível (olho) e travada (cadeado: aparece, mas não se seleciona).
 * Só afeta a vista; salvar e exportar levam tudo.
 */
export interface Layer {
  id: ID;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
}

export interface ViewState {
  /** Categorias de componente escondidas (como Visibilidade/Gráficos do Revit). */
  hiddenCategories: string[];
  /** Camada que recebe o que for criado. */
  activeLayer?: ID;
  /** Hora do dia na vista (0–24). */
  time?: number;
}

/** Perfil varrido em volta do volume numa altura. */
export interface Band {
  id: ID;
  /** Altura da base do perfil acima da base do volume (m). */
  y: number;
  height: number;
  /** Quanto sai da parede (m). */
  depth: number;
  /** Reto (faixa) ou em degraus (cornija clássica). */
  profile: 'flat' | 'cornice';
}

/** Bisel das arestas horizontais (como o Bevel do Blender, não destrutivo). */
export interface BevelSpec {
  /** Largura no topo e na base (m). */
  top: number;
  bottom: number;
  /** Segmentos do perfil (1 = chanfro reto). */
  segments: number;
  /** 0 = reto, 1 = arredondado (quarto de círculo). */
  profile: number;
}

export type BuildingUse = 'residential' | 'commercial' | 'industrial' | 'public' | 'mixed';

/** Edifício: move e gira inteiro. */
export interface Building3 {
  id: ID;
  name: string;
  lotId: ID | null;
  position: Vec2;
  rotation: number;
  use: BuildingUse;
  /** Níveis compartilhados por todos os sólidos (como os níveis do Revit). */
  levels: Level[];
  solids: Solid[];
  items: Item[];
  /** Paredes internas e cômodos por nível. */
  interiors: Record<ID, Interior>;
  layer?: ID;
  hidden?: boolean;
  locked?: boolean;
}

export interface Level {
  id: ID;
  name: string;
  /** Cota do piso acima da origem do edifício. */
  elevation: number;
  /** Altura de piso a piso. */
  height: number;
}

export interface Interior {
  nodes: { id: ID; p: Vec2 }[];
  walls: { id: ID; a: ID; b: ID; thickness: number; splitFrom?: ID }[];
  rooms: { id: ID; name: string; wallIds: ID[]; polygon?: Vec2[]; area?: number }[];
}

// ── Sólido ─────────────────────────────────────────────────────────────
/**
 * Vértice da planta. A aresta que começa nele tem o mesmo ID.
 * `bulge` faz da aresta um arco (convenção das polilinhas do CAD: tan(θ/4),
 * positivo = arco para fora num anel anti-horário). `round` arredonda o canto
 * com esse raio; `chamfer` corta o canto com esse recuo.
 */
export interface PlanVertex {
  id: ID;
  p: Vec2;
  bulge?: number;
  round?: number;
  chamfer?: number;
}

export interface Plan {
  /** Anel externo anti-horário (visto de cima, com z para baixo na tela). */
  outer: PlanVertex[];
  holes: PlanVertex[][];
}

export type SolidOp = 'add' | 'subtract' | 'intersect';

export type RoofKind =
  | 'flat'
  | 'terrace'
  | 'shed'
  | 'gable'
  | 'hip'
  | 'mansard'
  | 'gambrel'
  | 'pyramid'
  | 'dome'
  | 'vault'
  | 'sawtooth';

export interface RoofSpec {
  kind: RoofKind;
  /** Inclinação das águas em graus (shed, gable, hip, gambrel, sawtooth, pyramid). */
  pitch: number;
  /** Altura da cúpula ou abóbada (m); 0 = semicírculo. */
  rise: number;
  overhang: number;
  /** Direção da cumeeira ou da queda, em graus no plano do edifício. */
  direction: number;
  /** Platibanda em telhado plano ou terraço (m). */
  parapet: number;
  thickness: number;
}

/** Ajustes de um lado do sólido (aresta da planta). */
export interface EdgeSpec {
  /** Inclinação da parede em graus: positivo inclina para dentro. */
  lean?: number;
  /** Este lado não recebe água (vira oitão) no quatro águas. */
  gable?: boolean;
  /** Sem componentes gerados pelas regras de fachada neste lado. */
  blank?: boolean;
  material?: MaterialRef;
  /** Bisel do topo só neste lado (m); sobrepõe o do volume. */
  bevel?: number;
}

export interface MaterialRef {
  /** Acabamento: plaster, brick, stone, concrete, wood, metal, glass, tile, panel… */
  finish: string;
  color: string;
  /** 2ª cor do acabamento procedural (junta, argamassa, rejunte). */
  color2?: string;
  /** Parâmetros do acabamento procedural (medida do tijolo, junta, aparelho…). */
  params?: Record<string, number>;
}

export interface SolidMaterials {
  wall: MaterialRef;
  roof: MaterialRef;
  trim: MaterialRef;
  base: MaterialRef;
  /** Piso do topo (terraço, laje); sem ele, terraço usa piso cerâmico e laje usa manta. */
  floor?: MaterialRef;
}

export interface Solid {
  id: ID;
  name: string;
  op: SolidOp;
  plan: Plan;
  /** Cota da base acima da origem do edifício. */
  base: number;
  height: number;
  /** Recuo uniforme do topo em relação à base (m); afunila o volume. */
  taper: number;
  edges: Record<ID, EdgeSpec>;
  roof: RoofSpec;
  facade: FacadeRule[];
  materials: SolidMaterials;
  /** Embasamento visível (m) no pé das paredes. */
  plinth: number;
  /** Bisel das arestas do topo e da base. */
  bevel?: BevelSpec;
  /** Frisos, cornijas e rodapés varridos pelo contorno (como o Follow Me do SketchUp). */
  bands?: Band[];
  /** Escondido na vista (olho da árvore). Recortes escondidos continuam recortando. */
  hidden?: boolean;
  /** Travado: aparece, mas não se seleciona. */
  locked?: boolean;
  layer?: ID;
}

// ── Componentes ────────────────────────────────────────────────────────
export type ParamValue = number | string | boolean;

/** Tipo de componente: uma família com valores nomeados (ligado às ocorrências). */
export interface ComponentType {
  id: ID;
  family: string;
  name: string;
  params: Record<string, ParamValue>;
  /** Tipo criado pelo usuário (salvo no projeto e na biblioteca). */
  user?: boolean;
  /** Variação de outro tipo (aparece debaixo dele nos grupos de elementos). */
  base?: ID;
}

export type ItemHost =
  /** Numa face lateral de um sólido: `u` ao longo do lado (m do início ao centro), `y` acima da base do sólido. */
  | { kind: 'face'; solid: ID; edge: ID; u: number; y: number }
  /** Livre no edifício: posição local e rotação em Y. */
  | { kind: 'free'; p: Vec3; rot: number }
  /** Ao longo de um caminho (cercas, muros, guarda-corpos, escadas corridas). */
  | { kind: 'path'; points: Vec3[]; closed?: boolean }
  /** Sobre o telhado ou a laje de cobertura de um sólido. */
  | { kind: 'roof'; solid: ID; p: Vec2; rot: number };

export type Distribution = 'spacing' | 'max' | 'count' | 'fit';

/** Repetição de uma ocorrência (como o Array do Blender e a caixa de medidas do SketchUp). */
export interface ArraySpec {
  /** Ao longo do lado ou do eixo x local. */
  along: { mode: Distribution; value: number; count: number };
  /** Em colunas (faces: níveis acima; livres: eixo z local). */
  across?: { count: number; spacing: number };
}

export interface Item {
  id: ID;
  type: ID;
  /** Sobreposições desta ocorrência aos valores do tipo. */
  params: Record<string, ParamValue>;
  host: ItemHost;
  array?: ArraySpec;
  layer?: ID;
  hidden?: boolean;
  locked?: boolean;
  /** Elemento solto de uma regra de fachada (posição "lado:nível:índice"; `prev`, a exceção de tipo que a posição tinha): "Voltar à regra" o devolve. */
  origin?: { solid: ID; rule: ID; key: string; prev?: ID };
}

/** Que níveis do sólido uma regra de fachada ocupa. */
export type LevelPick = 'all' | 'ground' | 'upper' | 'top' | 'middle' | number[];

/**
 * Regra de fachada: distribui um tipo de componente nos lados do sólido, por
 * nível, recalculada a cada mudança (o tamanho da face decide quantos cabem).
 */
export interface FacadeRule {
  id: ID;
  type: ID;
  levels: LevelPick;
  /** Lados (IDs); vazio = todos os lados com comprimento suficiente. */
  edges: ID[];
  mode: Distribution;
  /** Distância (spacing/max) ou quantidade (count/fit). */
  value: number;
  /** Margem livre nas pontas de cada lado (m). */
  margin: number;
  /** Altura do peitoril acima do piso do nível (m); NaN = do tipo. */
  sill: number;
  justify: 'start' | 'center' | 'end';
  /** Exceções por posição: "lado:nível:índice" → tipo ou "none". */
  except: Record<string, ID>;
  params: Record<string, ParamValue>;
}

export interface Limits3 {
  maxBuildings: number;
  maxSolids: number;
  maxItems: number;
  maxLevels: number;
  maxHeight: number;
  maxVertices: number;
  worldExtent: number;
}

export const LIMITS3: Limits3 = {
  maxBuildings: 200,
  maxSolids: 64,
  maxItems: 400,
  maxLevels: 60,
  maxHeight: 240,
  maxVertices: 256,
  worldExtent: 600,
};
