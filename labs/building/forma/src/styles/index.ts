// Pacotes de estilo: esquema, validação, divisão (split) e estilos incluídos.
import type { Project } from '../core/schema';
import { BUILTIN_STYLES, builtinStyle } from './builtin';
import type { StylePack } from './schema';

export * from './schema';
export { resolveSplit, type Piece } from './split';
export { styleFacade, floorRule, type StyledFacade, type StyledOpening, type Ornament } from './interpret';
export { BUILTIN_STYLES, builtinStyle } from './builtin';

export type StyleResolver = (id: string) => StylePack | undefined;

/** Procura o estilo no projeto e, depois, entre os incluídos. */
export function styleResolver(project?: Pick<Project, 'styles'>): StyleResolver {
  return (id) => project?.styles.find((s) => s.id === id) ?? builtinStyle(id);
}

/** Todos os estilos disponíveis (incluídos + do projeto). */
export function allStyles(project?: Pick<Project, 'styles'>): StylePack[] {
  const own = project?.styles ?? [];
  return [...BUILTIN_STYLES.filter((b) => !own.some((o) => o.id === b.id)), ...own];
}
