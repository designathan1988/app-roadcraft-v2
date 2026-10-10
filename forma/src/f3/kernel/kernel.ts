// Carrega o Manifold (WASM) uma vez. No navegador, quem chama passa a URL do
// .wasm (o Vite resolve com ?url); no Node, o pacote acha o arquivo sozinho.
// Todo Manifold e CrossSection criado precisa de .delete(): use `scope`.
import Module from 'manifold-3d';
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';

export type Kernel = ManifoldToplevel;
export type { Manifold, CrossSection };

let loading: Promise<Kernel> | null = null;
let ready: Kernel | null = null;

export function loadKernel(wasmUrl?: string): Promise<Kernel> {
  if (ready) return Promise.resolve(ready);
  loading ??= (async () => {
    const opts = wasmUrl ? { locateFile: () => wasmUrl } : undefined;
    const k = await (Module as unknown as (o?: object) => Promise<Kernel>)(opts);
    k.setup();
    ready = k;
    return k;
  })();
  return loading;
}

/** Núcleo já carregado (síncrono); erro se ninguém chamou loadKernel antes. */
export function kernel(): Kernel {
  if (!ready) throw new Error('Núcleo geométrico ainda não carregado.');
  return ready;
}

export const kernelReady = (): boolean => ready !== null;

/**
 * Coleta objetos do Manifold para liberar todos de uma vez no fim de uma
 * avaliação (o WASM não tem coleta de lixo).
 */
export class Scope {
  private items: { delete(): void }[] = [];
  keep<T extends { delete(): void }>(o: T): T {
    this.items.push(o);
    return o;
  }
  dispose(): void {
    for (const o of this.items) o.delete();
    this.items = [];
  }
}
