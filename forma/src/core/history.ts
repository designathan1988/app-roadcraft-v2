// Histórico de desfazer/refazer por diferenças. Cada passo guarda só o que
// mudou (ida e volta), em vez de cópias inteiras: projetos com interiores
// ficam grandes, e 100 cópias pesariam centenas de megabytes.

type Key = string | number;
export type Op =
  | { t: 'set'; p: Key[]; v: unknown }
  | { t: 'del'; p: Key[] }
  | { t: 'splice'; p: Key[]; s: number; dc: number; items: unknown[] };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

/** Diferenças que transformam `a` em `b`. */
export function diff(a: unknown, b: unknown, p: Key[] = [], ops: Op[] = []): Op[] {
  if (a === b) return ops;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i++) diff(a[i], b[i], [...p, i], ops);
      return ops;
    }
    // Tamanhos diferentes: prefixo e sufixo comuns, emenda no meio.
    let s = 0;
    while (s < a.length && s < b.length && JSON.stringify(a[s]) === JSON.stringify(b[s])) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && JSON.stringify(a[a.length - 1 - e]) === JSON.stringify(b[b.length - 1 - e])) e++;
    ops.push({ t: 'splice', p, s, dc: a.length - s - e, items: clone(b.slice(s, b.length - e)) });
    return ops;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (!(k in b)) ops.push({ t: 'del', p: [...p, k] });
    for (const k of Object.keys(b)) {
      if (!(k in a)) ops.push({ t: 'set', p: [...p, k], v: clone(b[k]) });
      else diff(a[k], b[k], [...p, k], ops);
    }
    return ops;
  }
  ops.push({ t: 'set', p, v: clone(b) });
  return ops;
}

/** Aplica as diferenças; devolve o objeto (a raiz pode ser substituída). */
export function apply<T>(root: T, ops: Op[]): T {
  let r: unknown = root;
  for (const op of ops) {
    if (!op.p.length) {
      if (op.t === 'set') r = clone(op.v);
      else if (op.t === 'splice') (r as unknown[]).splice(op.s, op.dc, ...clone(op.items));
      continue;
    }
    let parent = r as Record<Key, unknown>;
    for (let i = 0; i < op.p.length - 1; i++) parent = parent[op.p[i]!] as Record<Key, unknown>;
    const last = op.p.at(-1)!;
    if (op.t === 'set') parent[last] = clone(op.v);
    else if (op.t === 'del') delete parent[last];
    else (parent[last] as unknown[]).splice(op.s, op.dc, ...clone(op.items));
  }
  return r as T;
}

export class History<T> {
  private state: T;
  private undoStack: { fwd: Op[]; back: Op[] }[] = [];
  private redoStack: { fwd: Op[]; back: Op[] }[] = [];

  constructor(
    initial: T,
    private max = 200,
  ) {
    this.state = clone(initial);
  }

  /** Registra um novo estado. Devolve false se nada mudou. */
  commit(state: T): boolean {
    const next = clone(state);
    const fwd = diff(this.state, next);
    if (!fwd.length) return false;
    const back = diff(next, this.state);
    this.undoStack.push({ fwd, back });
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack = [];
    this.state = next;
    return true;
  }

  undo(): T {
    const step = this.undoStack.pop();
    if (step) {
      this.state = apply(this.state, step.back);
      this.redoStack.push(step);
    }
    return clone(this.state);
  }

  redo(): T {
    const step = this.redoStack.pop();
    if (step) {
      this.state = apply(this.state, step.fwd);
      this.undoStack.push(step);
    }
    return clone(this.state);
  }

  /** Estado registrado atual (cópia). */
  current(): T {
    return clone(this.state);
  }

  /** Recomeça o histórico a partir de um estado (ex.: projeto aberto). */
  reset(state: T): void {
    this.state = clone(state);
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Tamanho aproximado guardado (para diagnóstico). */
  get storedBytes(): number {
    return JSON.stringify(this.undoStack).length + JSON.stringify(this.redoStack).length;
  }
}
