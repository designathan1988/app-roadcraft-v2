// Salvamento do FORMA 3: automático no navegador (localStorage) e em arquivo
// (.json baixado e aberto). Um projeto salvo que não abre nunca é descartado em
// silêncio: uma cópia vai para `forma3_project_invalid`. Sem three.
import type { Project3 } from '../model/schema';
import { migrateForma3, type Migration } from './migrate';

export const KEY3 = 'forma3_project';
export const KEY3_INVALID = 'forma3_project_invalid';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface Restored3 {
  project: Project3 | null;
  /** Notas da migração (quando o salvo era de uma versão anterior). */
  notes: string[];
  error?: string;
}

/** Lê o salvamento automático. Sem nada salvo, devolve `project: null` sem erro. */
export function loadAutosave(key = KEY3): Restored3 {
  const s = storage();
  if (!s) return { project: null, notes: [] };
  let raw: string | null;
  try {
    raw = s.getItem(key);
  } catch {
    return { project: null, notes: [], error: 'O navegador não deixou ler o projeto salvo.' };
  }
  if (!raw) return { project: null, notes: [] };
  try {
    const m = migrateForma3(JSON.parse(raw));
    return { project: m.project, notes: m.notes };
  } catch (e) {
    try {
      s.setItem(KEY3_INVALID, raw);
    } catch {
      /* sem espaço: segue sem a cópia */
    }
    return { project: null, notes: [], error: e instanceof SyntaxError ? 'O projeto salvo está corrompido (JSON inválido).' : (e as Error).message };
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string };

/** Salva no navegador. Falha (sem espaço, modo privado) volta como erro, nunca exceção. */
export function autosave(p: Project3, key = KEY3): SaveResult {
  const s = storage();
  if (!s) return { ok: false, error: 'Este navegador não permite salvar localmente.' };
  try {
    s.setItem(key, JSON.stringify(p));
    return { ok: true };
  } catch (e) {
    const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return { ok: false, error: quota ? 'Sem espaço no navegador para o salvamento automático; salve em arquivo.' : 'Não foi possível salvar no navegador.' };
  }
}

export function clearAutosave(key = KEY3): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* nada a limpar */
  }
}

/** Nome de arquivo seguro a partir do nome do projeto. */
export function fileName(name: string, ext: string): string {
  const base =
    (name || 'forma')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'forma';
  return `${base}.${ext}`;
}

/** Baixa dados como arquivo (Blob + a[download]); a URL é liberada depois do clique. */
export function download(data: BlobPart | Blob, name: string, type: string, doc: Document = document): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // Revogar logo depois do clique pode cancelar o download em alguns navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Salva o projeto como arquivo JSON (forma/3). */
export function saveFile(p: Project3, doc: Document = document): void {
  download(JSON.stringify(p, null, 2), fileName(p.name, 'forma3.json'), 'application/json', doc);
}

/** Abre um arquivo de projeto (forma/3, forma/2 ou v1), migrando para forma/3. */
export async function openFile(file: File): Promise<Project3> {
  return (await openFileWithNotes(file)).project;
}

export async function openFileWithNotes(file: File): Promise<Migration> {
  if (file.size > 50 * 1024 * 1024) throw new Error('Arquivo grande demais para um projeto (acima de 50 MB).');
  const text = await file.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('O arquivo não é um projeto válido (JSON inválido).');
  }
  return migrateForma3(raw);
}
