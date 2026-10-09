import type { RoadProfileSpec } from '@world/roads/profile';
import { type RoadTemplate, normalizeTemplate } from '@world/roads/templates';

/**
 * The player's own road templates (docs/VIAS.md V1), kept in this browser for
 * every map, as Cities: Skylines keeps a player's roads apart from any one
 * city. Read back through `normalizeTemplate`: a damaged entry is dropped,
 * never built. Storage can be refused (a private window): then nothing is
 * kept and the game goes on.
 */
const STORE = 'roadcraft.roadTemplates';

export function savedTemplates(): RoadTemplate[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeTemplate).filter((t): t is RoadTemplate => t !== null);
  } catch {
    return [];
  }
}

/** Saves a template under a name, replacing one of the same name; null when it cannot be built or kept. */
export function saveTemplate(name: string, type: number, profile: RoadProfileSpec): RoadTemplate | null {
  const template = normalizeTemplate({ id: `user:${Date.now().toString(36)}`, name, type, profile });
  if (!template) return null;
  const list = savedTemplates().filter((t) => t.name !== template.name);
  list.push(template);
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    return null;
  }
  return template;
}

export function deleteTemplate(id: string): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(savedTemplates().filter((t) => t.id !== id)));
  } catch {
    // Storage refused: there was nothing kept to remove.
  }
}
