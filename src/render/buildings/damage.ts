import { DoubleSide, Vector4, type Material } from 'three';

/**
 * Holes knocked in buildings (`destruction.ts`): spheres in world space inside
 * which the building's surfaces are not drawn, so a blow opens the wall it
 * landed on - the building keeps its own look everywhere else, as damaged
 * buildings do in games (the intact model, cut where it was hit), and the
 * rooms behind show through. A ragged edge comes from noise on the radius.
 *
 * One table for the whole map, shared by every building material.
 */

/** Holes at once, map-wide. */
export const MAX_HOLES = 96;

export const holeUniforms = {
  uHoles: { value: Array.from({ length: MAX_HOLES }, () => new Vector4(0, -1e6, 0, 0)) },
  uHoleCount: { value: 0 },
};

/** Sets the holes: world (x, y, z) and radius each, three's axes (y up, z = -world y). */
export function setHoles(holes: readonly { x: number; y: number; z: number; r: number }[]): void {
  const list = holes.slice(-MAX_HOLES);
  list.forEach((h, i) => holeUniforms.uHoles.value[i]!.set(h.x, h.z, -h.y, h.r));
  holeUniforms.uHoleCount.value = list.length;
}

/** Makes a building material cut by the holes, and drawn from both sides so a hole shows the inside. */
export function applyHoles(material: Material, key: string): void {
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.side = DoubleSide;
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, holeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHoleWorld;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        {
          vec4 holeP = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            holeP = instanceMatrix * holeP;
          #endif
          vHoleWorld = (modelMatrix * holeP).xyz;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vHoleWorld;
        uniform vec4 uHoles[${MAX_HOLES}];
        uniform int uHoleCount;
        float holeNoise(vec3 p) { return fract(sin(dot(floor(p * 2.2), vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        for (int i = 0; i < ${MAX_HOLES}; i++) {
          if (i >= uHoleCount) break;
          vec4 h = uHoles[i];
          // A broken edge: the radius varies block by block.
          float r = h.w * (0.78 + 0.34 * holeNoise(vHoleWorld));
          if (distance(vHoleWorld, h.xyz) < r) discard;
        }`);
  };
  material.customProgramCacheKey = () => `${previousKey()}-holes-${key}`;
}
