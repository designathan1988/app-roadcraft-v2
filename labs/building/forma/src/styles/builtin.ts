// Estilos incluídos no FORMA. IDs com prefixo "builtin:" não precisam
// estar no projeto; estilos próprios ficam em project.styles.
import { STYLE_SCHEMA, type StylePack } from './schema';

const S = STYLE_SCHEMA;

export const BUILTIN_STYLES: StylePack[] = [
  {
    schema: S,
    id: 'builtin:colonial',
    name: 'Colonial brasileiro',
    description: 'Paredes caiadas, janelas com venezianas, cunhais de pedra e telhado de telha.',
    materials: {
      wall: { color: '#f2ede2', texture: 'plaster', scale: 2 },
      trim: { color: '#2f5d8a', roughness: 0.55 },
      stone: { color: '#d8cdb9', texture: 'stone', scale: 0.9 },
      roof: { color: '#b0603b', texture: 'tile', scale: 0.6 },
    },
    floors: {
      ground: {
        split: [
          { size: 0.5, tile: { kind: 'pilaster', width: 0.5, depth: 0.08, material: 'stone' } },
          { size: '~0.8', tile: { kind: 'wall' } },
          { repeat: [{ size: 1.2, tile: { kind: 'door', width: 1.1, height: 2.4 } }, { size: '~1.6', tile: { kind: 'wall' } }, { size: 1.1, tile: { kind: 'window', width: 1.0, height: 1.5, sill: 0.95, shutters: true } }, { size: '~1.6', tile: { kind: 'wall' } }] },
          { size: 0.5, tile: { kind: 'pilaster', width: 0.5, depth: 0.08, material: 'stone' } },
        ],
        band: { height: 0.16, depth: 0.1, material: 'stone' },
      },
      typical: {
        split: [
          { size: 0.5, tile: { kind: 'pilaster', width: 0.5, depth: 0.08, material: 'stone' } },
          { size: '~0.8', tile: { kind: 'wall' } },
          { repeat: [{ size: 1.2, tile: { kind: 'window', width: 1.0, height: 1.9, sill: 0.3, shutters: true, balcony: true } }, { size: '~1.8', tile: { kind: 'wall' } }] },
          { size: 0.5, tile: { kind: 'pilaster', width: 0.5, depth: 0.08, material: 'stone' } },
        ],
        band: { height: 0.2, depth: 0.14, material: 'stone' },
      },
    },
    plinth: { height: 0.45 },
    roof: { kind: 'hip', height: 2.6, overhang: 0.6 },
    flags: { cornice: false, brise: false, garden: false, pilotis: false, balconies: false },
  },
  {
    schema: S,
    id: 'builtin:moderno',
    name: 'Moderno',
    description: 'Concreto aparente, janelas em fita com brise e cobertura plana.',
    materials: {
      wall: { color: '#d3d1cc', texture: 'concrete', scale: 1.5 },
      trim: { color: '#2a2d2f', roughness: 0.4, metalness: 0.3 },
      stone: { color: '#9a9893', texture: 'concrete', scale: 1.5 },
    },
    floors: {
      ground: {
        split: [{ size: '~0.6', tile: { kind: 'wall' } }, { repeat: [{ size: 2.6, tile: { kind: 'storefront' } }, { size: 0.3, tile: { kind: 'pilaster', width: 0.3, depth: 0.12, material: 'stone' } }] }, { size: '~0.6', tile: { kind: 'wall' } }],
      },
      typical: {
        split: [{ size: '~0.5', tile: { kind: 'wall' } }, { repeat: [{ size: '~2.4', tile: { kind: 'window', height: 1.5, sill: 0.9, brise: true } }, { size: 0.25, tile: { kind: 'wall' } }] }, { size: '~0.5', tile: { kind: 'wall' } }],
        band: { height: 0.3, depth: 0.25, material: 'wall' },
      },
    },
    roof: { kind: 'flat' },
    flags: { cornice: false, brise: false, garden: true, pilotis: false, balconies: false },
  },
  {
    schema: S,
    id: 'builtin:artdeco',
    name: 'Art déco',
    description: 'Pilastras verticais, faixas e janelas em arco no último pavimento.',
    materials: {
      wall: { color: '#e6d9bf', texture: 'plaster', scale: 2.5 },
      trim: { color: '#5d4d36', roughness: 0.5 },
      stone: { color: '#cbbb9a', texture: 'stone', scale: 1.2 },
    },
    floors: {
      ground: {
        split: [{ size: 0.7, tile: { kind: 'pilaster', width: 0.7, depth: 0.15, material: 'stone' } }, { repeat: [{ size: '~2.8', tile: { kind: 'storefront' } }, { size: 0.5, tile: { kind: 'pilaster', width: 0.5, depth: 0.15, material: 'stone' } }] }, { size: 0.2, tile: { kind: 'wall' } }],
        band: { height: 0.35, depth: 0.18, material: 'stone' },
      },
      typical: {
        split: [{ size: 0.7, tile: { kind: 'pilaster', width: 0.7, depth: 0.12, material: 'stone' } }, { repeat: [{ size: '~1.2', tile: { kind: 'window', width: 1.0, height: 1.8 } }, { size: '~1.2', tile: { kind: 'window', width: 1.0, height: 1.8 } }, { size: 0.45, tile: { kind: 'pilaster', width: 0.45, depth: 0.12, material: 'stone' } }] }, { size: 0.25, tile: { kind: 'wall' } }],
      },
      top: {
        split: [{ size: 0.7, tile: { kind: 'pilaster', width: 0.7, depth: 0.12, material: 'stone' } }, { repeat: [{ size: '~2.4', tile: { kind: 'window', width: 1.4, height: 1.9, arch: true } }, { size: 0.45, tile: { kind: 'pilaster', width: 0.45, depth: 0.12, material: 'stone' } }] }, { size: 0.25, tile: { kind: 'wall' } }],
        band: { height: 0.45, depth: 0.2, material: 'stone' },
      },
    },
    plinth: { height: 0.6 },
    roof: { kind: 'flat' },
    flags: { cornice: false, brise: false, garden: false, pilotis: false, balconies: false },
  },
  {
    schema: S,
    id: 'builtin:industrial',
    name: 'Galpão industrial',
    description: 'Tijolo aparente, janelões em arco e telhado metálico de duas águas.',
    materials: {
      wall: { color: '#a65a40', texture: 'brick', scale: 0.8 },
      trim: { color: '#33393b', roughness: 0.45, metalness: 0.4 },
      stone: { color: '#7d4a37', texture: 'brick', scale: 0.8 },
      roof: { color: '#6f777a', texture: 'metal', scale: 0.8, metalness: 0.4, roughness: 0.45 },
    },
    floors: {
      typical: {
        split: [{ size: 0.6, tile: { kind: 'pilaster', width: 0.6, depth: 0.18, material: 'stone' } }, { repeat: [{ size: '~2.6', tile: { kind: 'window', width: 1.8, height: 2.6, arch: true } }, { size: 0.6, tile: { kind: 'pilaster', width: 0.6, depth: 0.18, material: 'stone' } }] }],
        band: { height: 0.25, depth: 0.12, material: 'stone' },
      },
      ground: {
        split: [{ size: 0.6, tile: { kind: 'pilaster', width: 0.6, depth: 0.18, material: 'stone' } }, { size: '~1', tile: { kind: 'wall' } }, { size: 3.6, tile: { kind: 'door', width: 3.4, height: 3.2 } }, { repeat: [{ size: '~2.6', tile: { kind: 'window', width: 1.8, height: 2.2, sill: 1.1, arch: true } }, { size: 0.6, tile: { kind: 'pilaster', width: 0.6, depth: 0.18, material: 'stone' } }] }],
      },
    },
    roof: { kind: 'gable', height: 3, overhang: 0.5 },
    flags: { cornice: false, brise: false, garden: false, pilotis: false, balconies: false },
  },
  {
    schema: S,
    id: 'builtin:comercial',
    name: 'Comercial com lojas',
    description: 'Lojas envidraçadas no térreo e apartamentos com sacadas em cima.',
    materials: {
      wall: { color: '#c7b29c', texture: 'plaster', scale: 2 },
      trim: { color: '#3b3f40', roughness: 0.5 },
      stone: { color: '#8f8a82', texture: 'stone', scale: 1 },
    },
    floors: {
      ground: {
        split: [{ size: 0.4, tile: { kind: 'pilaster', width: 0.4, depth: 0.1, material: 'stone' } }, { repeat: [{ size: '~3.2', tile: { kind: 'storefront' } }, { size: 0.4, tile: { kind: 'pilaster', width: 0.4, depth: 0.1, material: 'stone' } }] }],
        band: { height: 0.4, depth: 0.2, material: 'stone' },
      },
      typical: {
        split: [{ size: '~0.8', tile: { kind: 'wall' } }, { repeat: [{ size: 1.5, tile: { kind: 'window', width: 1.4, height: 2.1, sill: 0.15, balcony: true } }, { size: '~1.4', tile: { kind: 'wall' } }, { size: 1.0, tile: { kind: 'window', width: 0.9, height: 1.2, sill: 1.0 } }, { size: '~1.4', tile: { kind: 'wall' } }] }, { size: '~0.8', tile: { kind: 'wall' } }],
      },
    },
    roof: { kind: 'flat' },
    flags: { cornice: true, brise: false, garden: false, pilotis: false, balconies: false },
  },
  {
    schema: S,
    id: 'builtin:torre',
    name: 'Torre envidraçada',
    description: 'Pele de vidro com montantes metálicos do chão ao topo.',
    materials: {
      wall: { color: '#4d5a60', texture: 'metal', scale: 1, metalness: 0.5, roughness: 0.35 },
      trim: { color: '#9aa3a6', roughness: 0.3, metalness: 0.6 },
      stone: { color: '#5e6668', texture: 'metal', scale: 1, metalness: 0.5, roughness: 0.4 },
    },
    floors: {
      typical: { split: [{ size: 0.12, tile: { kind: 'wall' } }, { repeat: [{ size: '~1.5', tile: { kind: 'window', height: 9, sill: 0.08 } }, { size: 0.08, tile: { kind: 'pilaster', width: 0.08, depth: 0.1, material: 'trim' } }] }, { size: 0.12, tile: { kind: 'wall' } }] },
      ground: { split: [{ size: 0.12, tile: { kind: 'wall' } }, { repeat: [{ size: '~2.2', tile: { kind: 'storefront' } }, { size: 0.1, tile: { kind: 'pilaster', width: 0.1, depth: 0.12, material: 'trim' } }] }, { size: 0.12, tile: { kind: 'wall' } }] },
    },
    roof: { kind: 'flat' },
    flags: { cornice: false, brise: false, garden: false, pilotis: false, balconies: false },
  },
];

const byId = new Map(BUILTIN_STYLES.map((s) => [s.id, s]));
export const builtinStyle = (id: string): StylePack | undefined => byId.get(id);
