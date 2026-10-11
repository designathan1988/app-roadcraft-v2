// Salvamento automático no navegador. Lê forma_project_v2; se não existir,
// migra forma_project_v1 sem apagá-lo. Um projeto salvo que não abre nunca é
// descartado em silêncio: uma cópia vai para forma_project_v2_invalid.
import type { Limits, Project } from '../core/schema';
import { loadProject } from '../core';

export const KEY_V2 = 'forma_project_v2';
export const KEY_V1 = 'forma_project_v1';
export const KEY_INVALID = 'forma_project_v2_invalid';

export interface Restored {
  project: Project | null;
  source: 'v2' | 'v1' | 'none';
  error?: string;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function restore(key = KEY_V2, limits: Partial<Limits> = {}): Restored {
  const s = storage();
  if (!s) return { project: null, source: 'none' };
  for (const [k, source] of [[key, 'v2'], [KEY_V1, 'v1']] as const) {
    let raw: string | null = null;
    try {
      raw = s.getItem(k);
    } catch {
      return { project: null, source: 'none' };
    }
    if (!raw) continue;
    try {
      return { project: loadProject(JSON.parse(raw), limits), source };
    } catch (e) {
      try {
        s.setItem(KEY_INVALID, raw);
      } catch {
        /* sem espaço: segue sem a cópia */
      }
      return { project: null, source, error: (e as Error).message };
    }
  }
  return { project: null, source: 'none' };
}

export function save(project: Project, key = KEY_V2): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}

export function readPreference(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    /* preferência é opcional */
  }
}
