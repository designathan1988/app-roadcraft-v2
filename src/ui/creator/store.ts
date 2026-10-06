import type { PersonParams } from '@people/gen/person';

/**
 * The people the player has saved in the creator, kept in the browser
 * (localStorage), each with a portrait for the gallery; a person can also
 * be written to and read from a JSON file.
 */

export interface SavedPerson {
  readonly id: string;
  readonly savedAt: number;
  readonly portrait: string;
  readonly params: PersonParams;
}

const KEY = 'roadcraft.creator.people';
const FORMAT = 'roadcraft-person/1';

export function loadSaved(): SavedPerson[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedPerson[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: readonly SavedPerson[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Saves (or replaces, by id) a person; returns their id, or null if the browser refused. */
export function savePerson(params: PersonParams, portrait: string, id?: string): string | null {
  const list = loadSaved();
  const entry: SavedPerson = { id: id ?? `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, savedAt: Date.now(), portrait, params };
  const at = list.findIndex((p) => p.id === entry.id);
  if (at >= 0) list[at] = entry; else list.unshift(entry);
  return write(list) ? entry.id : null;
}

export function deleteSaved(id: string): void {
  write(loadSaved().filter((p) => p.id !== id));
}

/** Offers a person to the player as a JSON file. */
export function exportPerson(params: PersonParams): void {
  const blob = new Blob([JSON.stringify({ format: FORMAT, person: params }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(params.name || 'pessoa').replace(/[^\p{L}\p{N}_-]+/gu, '_')}.person.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Reads a person file; null when it is not one. */
export async function importPerson(file: File): Promise<PersonParams | null> {
  try {
    const data = JSON.parse(await file.text()) as { format?: string; person?: PersonParams };
    return data.format === FORMAT && data.person ? data.person : null;
  } catch {
    return null;
  }
}
