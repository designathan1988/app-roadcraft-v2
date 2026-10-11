// Gera as peças de muitos edifícios num Web Worker (embutido na biblioteca),
// para não travar o jogo ao carregar um bairro. Sem suporte a workers, gera
// na própria thread.
import type { Building, Project } from '../core/schema';
import type { BuildingParts } from '../geometry/parts';
import { buildBuildingParts, type MassPartsOptions } from '../geometry/mass-parts';
import { styleResolver } from '../styles';

export interface PartsGenerator {
  generate(buildings: Building[], options?: Omit<MassPartsOptions, 'styles'>): Promise<BuildingParts[]>;
  /** true quando as peças saem de um worker. */
  readonly threaded: boolean;
  dispose(): void;
}

export async function createPartsGenerator(project?: Pick<Project, 'styles'>): Promise<PartsGenerator> {
  const styles = project?.styles ?? [];
  let worker: Worker | null = null;
  if (typeof Worker !== 'undefined') {
    try {
      const { default: PartsWorker } = await import('../worker/parts.worker?worker&inline');
      worker = new PartsWorker();
    } catch {
      worker = null;
    }
  }
  let seq = 0;
  const pending = new Map<number, { ok: (p: BuildingParts[]) => void; fail: (e: Error) => void }>();
  worker?.addEventListener('message', (e: MessageEvent<{ id: number; parts?: BuildingParts[]; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.parts) p.ok(e.data.parts);
    else p.fail(new Error(e.data.error ?? 'Falha no worker.'));
  });
  return {
    threaded: !!worker,
    generate(buildings, options = {}) {
      if (!worker) {
        const resolve = styleResolver({ styles });
        return Promise.resolve(buildings.map((b) => buildBuildingParts(b, { ...options, styles: resolve })));
      }
      const id = ++seq;
      return new Promise((ok, fail) => {
        pending.set(id, { ok, fail });
        worker!.postMessage({ id, buildings, styles, options });
      });
    },
    dispose() {
      worker?.terminate();
      for (const p of pending.values()) p.fail(new Error('Gerador encerrado.'));
      pending.clear();
    },
  };
}
