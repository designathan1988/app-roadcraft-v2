// Emissor de eventos tipado e mínimo.
export class Emitter<E extends Record<string, unknown>> {
  private handlers = new Map<keyof E, Set<(payload: never) => void>>();

  on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    for (const fn of this.handlers.get(event) ?? []) {
      try {
        (fn as (p: E[K]) => void)(payload);
      } catch (err) {
        console.error(err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
