import { fractureData, mergeFragments, type FractureInput, type FragmentData } from './fracture';

/**
 * Breaks a building into its fragments off the main thread (`fracture.ts`):
 * a big building's Voronoi fracture took up to a second, the game frozen.
 * The ruin's still mesh (every fragment in one buffer) is made here too: made
 * on the main thread it took up to 0.7 s.
 */
self.onmessage = (e: MessageEvent<{ id: number; input: FractureInput }>) => {
  const data: FragmentData[] = fractureData(e.data.input);
  const still = mergeFragments(data);
  // Every buffer once (MDN: one listed twice throws a DataCloneError).
  const transfer: ArrayBuffer[] = [];
  for (const f of data) for (const a of [f.position, f.normal, f.colour, f.uv, f.decay]) transfer.push(a.buffer as ArrayBuffer);
  for (const a of [still.position, still.normal, still.colour, still.uv, still.decay, ...still.slots]) transfer.push(a.buffer as ArrayBuffer);
  (self as unknown as Worker).postMessage({ id: e.data.id, data, still }, transfer);
};
