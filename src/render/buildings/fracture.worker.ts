import { fractureData, type FractureInput, type FragmentData } from './fracture';

/**
 * Breaks a building into its fragments off the main thread (`fracture.ts`):
 * a big building's Voronoi fracture took up to a second, the game frozen.
 */
self.onmessage = (e: MessageEvent<{ id: number; input: FractureInput }>) => {
  const data: FragmentData[] = fractureData(e.data.input);
  const transfer: ArrayBuffer[] = [];
  for (const f of data) for (const a of [f.position, f.normal, f.colour, f.uv, f.decay]) transfer.push(a.buffer as ArrayBuffer);
  (self as unknown as Worker).postMessage({ id: e.data.id, data }, transfer);
};
