// Projeto de exemplo “Residencial Jardim”, definido no formato v1 original e
// convertido pela migração (garante que o exemplo e a migração andem juntos).
import type { Project } from '../core/schema';
import { migrateV1 } from '../core/migrate/v1';
import { shape } from '../geometry/polygon';

export function exampleProject(): Project {
  return migrateV1({
    version: 1,
    name: 'Residencial Jardim',
    volumes: [
      { name: 'Ala norte', points: shape('rect', 26, 6), x: 0, z: -8, height: 12.8, floors: 4, color: '#d8d1c1', roof: 'gable', roofHeight: 2.7, garden: false, balconies: true },
      { name: 'Ala oeste', points: shape('rect', 6, 14), x: -10, z: 2, height: 9.6, floors: 3, color: '#b77b56', balconies: true, garden: true },
      { name: 'Volume 03', points: shape('rect', 13, 5), x: 0, z: 9, height: 6.4, floors: 2, color: '#b77b56', facade: 'storefront', garden: true },
      { name: 'Ala leste', points: shape('rect', 6, 14), x: 10, z: 2, height: 12.8, floors: 4, color: '#d8d1c1', balconies: true, garden: true },
      { name: 'Torre curva', points: shape('circle', 7, 7), x: 14, z: 8, height: 9.6, floors: 3, color: '#d8d1c1', spacing: 2.6, windowWidth: 1.35, garden: true },
    ],
  });
}
