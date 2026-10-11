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
export { buildCollision } from './render/collision';
export { collisionShapes, wallSolids, type Solid } from './geometry/collision';
export * as interiorOps from './editor/interior-ops';
export { WalkPhysics, walkStart } from './editor/walk';
export { buildLotGroup } from './render/lot';
export * as lotOps from './editor/lot-ops';
export { straightSkeleton, SkeletonError, type SkeletonResult } from './geometry/roofs/skeleton';
export { skeletonRoof, gableEdges, type RoofGeometry, type SkeletonRoofOptions } from './geometry/roofs/skeleton-roof';
export { TEMPLATES, templateById, type Template } from './editor/templates';
export { buildLOD, buildBatchedCity, enableBVH, lod1Geometry, lod2Geometry, type BuiltLOD, type LodOptions, type BatchedCity } from './render/lod';
export { createPartsGenerator, type PartsGenerator } from './render/worker-client';
