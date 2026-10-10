// FORMA 2 — biblioteca para jogos three.js.
//  - buildBuilding(edifício) → THREE.Group pronto para a cena (gerador)
//  - createEditor({ container }) → editor completo com interface
//  - createEditor({ renderer, scene, camera }) → editor dentro da cena do jogo
export * from './core';
export { buildBuilding, type BuildOptions, type BuiltBuilding } from './render/build-building';
export { createRenderContext, type RenderContext } from './render/context';
export { buildBuildingParts, buildMassParts } from './geometry/mass-parts';
export type { BuildingParts, PartData } from './geometry/parts';
export { createEditor, Editor, type EditorOptions, type EditorEvents, type Tool } from './editor/editor';
export * as ops from './editor/ops';
export { exampleProject } from './editor/example';
export { exportGLB, exportOBJ, exportJSON } from './io/export';
