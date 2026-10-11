// Documento em edição: projeto forma/3, histórico (desfazer/refazer por cópias
// compactas), revisão por edifício (o que precisa ser recalculado) e eventos.
import type { Building3, ID, Project3 } from '../model/schema';
import { project as newProject } from '../model/defaults';

export type StoreEvent = { kind: 'change'; ids: ID[] | null; message: string } | { kind: 'history' };

const MAX_HISTORY = 200;

export class Store {
  project: Project3;
  /** Revisão por edifício: muda quando ele precisa ser reavaliado. */
  readonly revision = new Map<ID, number>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<(e: StoreEvent) => void>();
  private last: string;

  constructor(p: Project3 = newProject()) {
    this.project = p;
    this.last = JSON.stringify(p);
    for (const b of p.buildings) this.revision.set(b.id, 1);
  }

  on(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: StoreEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  building(id: ID | null | undefined): Building3 | undefined {
    return id ? this.project.buildings.find((b) => b.id === id) : undefined;
  }

  /** Marca edifícios como alterados (sem gravar no histórico): durante um arrasto. */
  touch(ids: ID[] | null, message = ''): void {
    const list = ids ?? this.project.buildings.map((b) => b.id);
    for (const id of list) this.revision.set(id, (this.revision.get(id) ?? 0) + 1);
    this.emit({ kind: 'change', ids: list, message });
  }

  /**
   * Grava o estado atual como um passo do histórico. `geometry = false` quando
   * só a posição/rotação de edifícios mudou (não precisa reavaliar).
   */
  commit(ids: ID[] | null, message = '', geometry = true): void {
    const now = JSON.stringify(this.project);
    if (now === this.last) {
      if (geometry) this.touch(ids, message);
      else this.emit({ kind: 'change', ids, message });
      return;
    }
    this.undoStack.push(this.last);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.last = now;
    if (geometry) this.touch(ids, message);
    else this.emit({ kind: 'change', ids, message });
    this.emit({ kind: 'history' });
  }

  /** Volta ao último estado gravado (cancela um arrasto). */
  revert(): void {
    this.project = JSON.parse(this.last) as Project3;
    this.touch(null);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (prev === undefined) return false;
    this.redoStack.push(this.last);
    this.restore(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (next === undefined) return false;
    this.undoStack.push(this.last);
    this.restore(next);
    return true;
  }

  private restore(json: string): void {
    this.last = json;
    this.project = JSON.parse(json) as Project3;
    this.touch(null, '');
    this.emit({ kind: 'history' });
  }

  /** Troca o projeto inteiro (abrir arquivo, novo). */
  replace(p: Project3, message = ''): void {
    this.undoStack.push(this.last);
    this.redoStack = [];
    this.project = p;
    this.last = JSON.stringify(p);
    this.revision.clear();
    this.touch(null, message);
    this.emit({ kind: 'history' });
  }

  json(): string {
    return JSON.stringify(this.project);
  }
}
