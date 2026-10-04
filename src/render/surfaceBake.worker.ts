import { createMaterials } from './materials';
import { terrainBakes } from './terrain';
import { createFinishMaterials } from './buildings/finishes';
import { detailTextures, takeDetailPixels } from './mesh/detailLayer';
import { takeBakedSurfacePixels } from './mesh/textureBaker';

// The recipes use only the two-dimensional canvas API. Give them OffscreenCanvas
// here so the same source computes every texel without touching the DOM thread.
Object.defineProperty(globalThis, 'document', {
  value: { createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`Unexpected element in surface baker: ${tag}`);
    return new OffscreenCanvas(1, 1);
  } },
});

try {
  createMaterials(1);
  terrainBakes(1);
  createFinishMaterials(1);
  detailTextures('soil', 1);
  const surfaces = takeBakedSurfacePixels();
  const details = takeDetailPixels();
  const buffers = [...surfaces.map(item => item.rgba), ...details.flatMap(item => [item.map.rgba, item.normal.rgba])];
  (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(
    { surfaces, details }, buffers,
  );
} catch (error) {
  self.postMessage({ error: String(error) });
}
