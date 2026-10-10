// Descrição pura (sem three.js) das peças de um edifício. O módulo render/
// converte estas peças em malhas: caixas viram InstancedMesh por material,
// paredes e lajes viram ExtrudeGeometry, telhados viram BufferGeometry.
import type { ID, Vec2 } from '../core/schema';

export type Vec3 = [number, number, number];

export type MaterialRole = 'wall' | 'frame' | 'glass' | 'stone' | 'roof' | 'green';

export interface MaterialKey {
  role: MaterialRole;
  color: string;
  roughness: number;
  metalness?: number;
  doubleSide?: boolean;
}

/** Dados de seleção ligados a cada peça. */
export interface PartData {
  buildingId: ID;
  massId: ID;
  edgeId?: ID;
  part: string;
  storey?: number;
}

export interface BoxPart {
  mat: MaterialKey;
  size: Vec3;
  pos: Vec3;
  /** Rotação em Y (radianos). */
  angle: number;
  /** Rotação em Z aplicada depois de Y (radianos). */
  roll: number;
  data: PartData;
}

export interface WallHole {
  /** Centro horizontal, largura e altura exatos (o arco depende deles). */
  center: number;
  width: number;
  height: number;
  left: number;
  right: number;
  bottom: number;
  top: number;
  arch: boolean;
}

/** Parede: contorno retangular no plano da aresta, com vãos, extrudado em `depth`. */
export interface WallPart {
  mat: MaterialKey;
  /** Origem no plano [x, y, z] e rotação em Y da aresta. */
  origin: Vec3;
  angle: number;
  length: number;
  bottom: number;
  top: number;
  depth: number;
  holes: WallHole[];
  data: PartData;
}

/** Laje: polígono em planta extrudado para cima a partir de y. */
export interface SlabPart {
  mat: MaterialKey;
  y: number;
  thickness: number;
  outer: Vec2[];
  holes: Vec2[][];
  data: PartData;
}

/** Malha livre (telhados): triângulos em posições [x, y, z, ...]. */
export interface MeshPart {
  mat: MaterialKey;
  positions: number[];
  data: PartData;
}

export interface BuildingParts {
  boxes: BoxPart[];
  walls: WallPart[];
  slabs: SlabPart[];
  meshes: MeshPart[];
}

export const emptyParts = (): BuildingParts => ({ boxes: [], walls: [], slabs: [], meshes: [] });
