// Noite: os mesmos números do jogo (Roadcraft src/render/lightLevels.ts e
// buildings/kit.ts), para o que sai do construtor combinar com a cidade.
//  - Fração de cômodos acesos por hora = gente acordada (ATUS 2007-11, BLS
//    tabela A-3); a luz acompanha a ocupação ativa quando escurece
//    (Richardson et al. 2009).
//  - Cômodo aceso visto pelo vidro com luminância 0,72, ABAIXO do limiar do
//    brilho (1,05): acima disso a cidade virava halo. Luminária a 2,4 brilha.
import * as THREE from 'three';

const AWAKE_BY_HOUR = [
  0.174, 0.095, 0.063, 0.051, 0.082, 0.146, 0.34, 0.579, 0.755, 0.864, 0.924, 0.951,
  0.964, 0.959, 0.958, 0.961, 0.964, 0.97, 0.975, 0.973, 0.95, 0.855, 0.628, 0.349,
];

export function awakeShare(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const a = AWAKE_BY_HOUR[i]!,
    b = AWAKE_BY_HOUR[(i + 1) % 24]!;
  return a + (b - a) * (h - i);
}

export const NIGHT = {
  /** Cômodo aceso visto pelo vidro (abaixo do limiar do brilho). */
  window: 0.72,
  /** Luminária de fachada (brilha). */
  lamp: 2.4,
  bloomThreshold: 1.05,
  bloomStrength: 0.2,
  bloomRadius: 0.32,
} as const;

/** Uniformes compartilhados por cômodos e luminárias (um valor para a cena toda). */
export const nightUniforms = {
  /** 0 de dia a 1 de noite. */
  uDark: { value: 0 },
  /** Fração de cômodos acesos. */
  uAwake: { value: awakeShare(21) },
};

/** Luz quente de um cômodo (2700 K, lâmpada incandescente/LED quente). */
export const ROOM_LIGHT = new THREE.Color('#ffc58a');

/**
 * Cômodo: acende à noite conforme o sorteio do cômodo (atributo aRoom, 0..1)
 * e a fração acordada. A cor do cômodo vira a luz que ele manda pela janela.
 */
export function roomMaterial(m: THREE.MeshStandardMaterial): void {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDark = nightUniforms.uDark;
    sh.uniforms.uAwake = nightUniforms.uAwake;
    sh.vertexShader = 'attribute float aRoom;\nvarying float vRoom;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRoom = aRoom;');
    sh.fragmentShader =
      'uniform float uDark;\nuniform float uAwake;\nvarying float vRoom;\n' +
      sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  float roomLit = step(vRoom, uAwake) * uDark;
  totalEmissiveRadiance += vec3(${ROOM_LIGHT.r.toFixed(4)}, ${ROOM_LIGHT.g.toFixed(4)}, ${ROOM_LIGHT.b.toFixed(4)}) * ${NIGHT.window.toFixed(2)} * roomLit * (0.55 + 0.45 * fract(vRoom * 7.31));`,
      );
  };
  m.customProgramCacheKey = () => 'forma-room';
}

const lamps = new Set<THREE.MeshStandardMaterial>();

/** Luminária: emite à noite (brilha), apagada de dia. */
export function lampMaterial(m: THREE.MeshStandardMaterial, color: string): void {
  m.emissive.set(color);
  m.emissiveIntensity = nightUniforms.uDark.value * NIGHT.lamp;
  lamps.add(m);
}

export function setLampLevel(dark: number): void {
  for (const m of lamps) m.emissiveIntensity = dark * NIGHT.lamp;
}

/** Sorteio estável de um cômodo (0..1) a partir do número dele. */
export function roomHash(n: number): number {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return (x % 100000) / 100000;
}

/**
 * Cortina: à noite deixa passar a luz do cômodo (tecido translúcido contra a
 * luz), na média da fração acordada — senão a janela com cortina fica preta.
 */
export function curtainMaterial(m: THREE.MeshStandardMaterial): void {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDark = nightUniforms.uDark;
    sh.uniforms.uAwake = nightUniforms.uAwake;
    sh.fragmentShader =
      'uniform float uDark;\nuniform float uAwake;\n' +
      sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * vec3(${ROOM_LIGHT.r.toFixed(4)}, ${ROOM_LIGHT.g.toFixed(4)}, ${ROOM_LIGHT.b.toFixed(4)}) * ${(NIGHT.window * 0.6).toFixed(3)} * uDark * uAwake;`,
      );
  };
  m.customProgramCacheKey = () => 'forma-curtain';
}
