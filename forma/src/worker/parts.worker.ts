// Worker: gera as peças (sem three.js) fora da thread principal.
import { buildBuildingParts, type MassPartsOptions } from '../geometry/mass-parts';
import { styleResolver } from '../styles';
import type { Building } from '../core/schema';
import type { StylePack } from '../styles/schema';

export interface PartsRequest {
  id: number;
  buildings: Building[];
  styles: StylePack[];
  options: Omit<MassPartsOptions, 'styles'>;
}

self.onmessage = (e: MessageEvent<PartsRequest>) => {
  const { id, buildings, styles, options } = e.data;
  try {
    const resolve = styleResolver({ styles });
    const parts = buildings.map((b) => buildBuildingParts(b, { ...options, styles: resolve }));
    (self as unknown as Worker).postMessage({ id, parts });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message });
  }
};
