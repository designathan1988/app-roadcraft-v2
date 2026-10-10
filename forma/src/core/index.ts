// Núcleo sem three.js: esquema, validação, migração e consultas.
// Pode rodar num worker ou no servidor do jogo.
import type { Limits, Project } from './schema';
import { SCHEMA } from './schema';
import { validateProject } from './validate';
import { migrateV1 } from './migrate/v1';

export * from './schema';
export { validateProject } from './validate';
export { migrateV1, normalizeV1 } from './migrate/v1';
export { History } from './history';
export { Emitter } from './events';
export { uid, sequentialIds } from './ids';
export { massExtent, massStoreys, sortedStoreys, edgeConfig } from './model';
export { computeLotIndices, buildingHeight, buildingFootprints, DEFAULT_LOT_RULES, type LotIndices, type Violation, type ViolationKind } from './indices';
export { buildableArea, edgeKinds, lotArea, lotAt } from '../geometry/lot';

/** Abre um projeto de qualquer versão conhecida, migrando quando necessário. */
export function loadProject(raw: unknown, limits: Partial<Limits> = {}): Project {
  const r = raw as { schema?: string; version?: number } | null;
  if (r && r.schema === SCHEMA) return validateProject(r, limits);
  if (r && r.version === 1) return validateProject(migrateV1(r), limits);
  throw new Error('Formato de projeto desconhecido.');
}

export function emptyProject(name = 'Projeto sem título'): Project {
  return { schema: SCHEMA, name, lots: [], buildings: [], styles: [], meta: { createdWith: 'forma 2' } };
}
