import { primeDetailPixels, type DetailBakePixels } from './mesh/detailLayer';
import { primeBakedSurfacePixels, type BakedPixels } from './mesh/textureBaker';

interface SurfaceBakeResult {
  readonly surfaces: readonly BakedPixels[];
  readonly details: readonly DetailBakePixels[];
}

/** Start the exact procedural recipes while the main thread builds the town. */
export function startSurfaceBake(): Promise<SurfaceBakeResult | null> {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./surfaceBake.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      console.warn('Surface bake worker unavailable; using the canvas recipes on the main thread.', error);
      resolve(null);
      return;
    }
    worker.onmessage = (event: MessageEvent<SurfaceBakeResult | { error: string }>) => {
      worker.terminate();
      if ('error' in event.data) {
        console.warn('Surface bake worker failed; using the canvas recipes on the main thread.', event.data.error);
        resolve(null);
      } else resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      console.warn('Surface bake worker failed; using the canvas recipes on the main thread.', event.message);
      resolve(null);
    };
    worker.onmessageerror = () => {
      worker.terminate();
      console.warn('Surface bake pixels could not be transferred; using the canvas recipes on the main thread.');
      resolve(null);
    };
  });
}

/** Install ready texels before the first material is constructed or drawn. */
export function primeSurfaceBake(result: SurfaceBakeResult | null): void {
  if (!result) return;
  primeBakedSurfacePixels(result.surfaces);
  primeDetailPixels(result.details);
}
