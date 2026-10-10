// Tabela de faces de origem. Cada triângulo que entra no Manifold carrega o
// índice de uma destas faces (faceID), e o Manifold mantém esse índice no
// resultado das booleanas: é assim que o resultado sabe de que sólido, de que
// lado e de que parte veio cada triângulo (material, seleção, fachada).
import type { ID, Vec3 } from '../model/schema';

export type FaceKind =
  /** Parede lateral de um sólido (um segmento do lado `edge`). */
  | 'side'
  /** Topo plano de um sólido (cobertura plana, terraço). */
  | 'top'
  | 'bottom'
  /** Água do telhado ou superfície de cúpula/abóbada. */
  | 'roof'
  /** Empena (parede vertical sob o telhado). */
  | 'gable'
  /** Plano envidraçado (dente de serra, claraboia). */
  | 'glazing'
  /** Testeira do beiral. */
  | 'fascia'
  /** Forro do beiral (face de baixo). */
  | 'soffit'
  | 'parapet'
  /** Rufo/capa no topo da platibanda. */
  | 'coping'
  /** Embasamento no pé das paredes. */
  | 'plinth'
  /** Superfície criada por um vão recortado. */
  | 'reveal'
  /** Cômodo atrás de uma janela: piso, teto e paredes do interior. */
  | 'roomFloor'
  | 'roomCeil'
  | 'roomWall'
  /** Faixa do bisel no topo ou na base de um lado (parede, sem componentes). */
  | 'bevel'
  /** Face interna de um sólido de subtração (vira parede do recorte). */
  | 'cutter';

export interface FaceFrame {
  /** Origem: início do segmento na base do sólido. */
  o: Vec3;
  /** Ao longo do segmento (horizontal). */
  u: Vec3;
  /** Subindo pela face. */
  v: Vec3;
  /** Para fora. */
  n: Vec3;
  /** Distância ao longo do lado onde o segmento começa (lados curvos têm vários). */
  s0: number;
  s1: number;
}

export interface FaceInfo {
  kind: FaceKind;
  solid: ID;
  edge?: ID;
  /** Índice do segmento no anel amostrado. */
  seg?: number;
  /** Anel: -1 externo, ≥0 furo. */
  ring?: number;
  frame?: FaceFrame;
  /** Superfície curva: normais suavizadas no desenho. */
  smooth?: boolean;
  /** Componente que abriu o vão (faces 'reveal'). */
  item?: ID;
}

export class FaceTable {
  readonly faces: FaceInfo[] = [];
  add(f: FaceInfo): number {
    this.faces.push(f);
    return this.faces.length - 1;
  }
}
