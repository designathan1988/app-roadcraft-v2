// Histórico de desfazer/refazer por cópias do estado. Portado do FormaCore.
export class History<T> {
  private states: string[];
  private index = 0;

  constructor(
    initial: T,
    private max = 100,
  ) {
    this.states = [JSON.stringify(initial)];
  }

  /** Registra um novo estado. Devolve false se nada mudou. */
  commit(state: T): boolean {
    const next = JSON.stringify(state);
    if (next === this.states[this.index]) return false;
    this.states.splice(this.index + 1);
    this.states.push(next);
    if (this.states.length > this.max) this.states.shift();
    this.index = this.states.length - 1;
    return true;
  }

  undo(): T {
    if (this.index > 0) this.index--;
    return JSON.parse(this.states[this.index]!) as T;
  }

  redo(): T {
    if (this.index < this.states.length - 1) this.index++;
    return JSON.parse(this.states[this.index]!) as T;
  }

  /** Estado registrado atual (cópia). */
  current(): T {
    return JSON.parse(this.states[this.index]!) as T;
  }

  /** Recomeça o histórico a partir de um estado (ex.: projeto aberto). */
  reset(state: T): void {
    this.states = [JSON.stringify(state)];
    this.index = 0;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.states.length - 1;
  }
}
