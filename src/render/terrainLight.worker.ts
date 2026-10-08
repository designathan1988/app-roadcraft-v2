import { createLandLighter, type LightGrid, type LightRequest } from './terrainLightCompute';

/**
 * The land's light off the page's thread (`terrainLightCompute.ts`): the page
 * sends a copy of the heights (transferred, not copied again) with the sun and
 * what moved; the light of the corners that can have changed comes back,
 * transferred. The land's shape is kept here between requests.
 */
let light: ((request: LightRequest) => ReturnType<ReturnType<typeof createLandLighter>>) | null = null;

self.onmessage = (event: MessageEvent<{ grid: LightGrid } | LightRequest>) => {
  const data = event.data;
  if ('grid' in data) {
    light = createLandLighter(data.grid);
    return;
  }
  if (!light) return;
  try {
    const result = light(data);
    (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(result, [result.rgba.buffer]);
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
