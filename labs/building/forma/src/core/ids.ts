import type { ID } from './schema';

let fallback = 0;

/** Gera um ID único e estável (UUID quando disponível). */
export function uid(): ID {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + (++fallback).toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Gerador determinístico, útil em testes e migrações reproduzíveis. */
export function sequentialIds(prefix = 'id'): () => ID {
  let n = 0;
  return () => prefix + '-' + String(++n).padStart(4, '0');
}
