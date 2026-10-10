// Gera projetos v1 de referência com o FormaCore legado e os valida com o
// validador antigo. Saída: test/fixtures/v1/*.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const C = require(resolve(root, 'test/legacy/forma-core.js'));

// IDs determinísticos para fixtures estáveis entre execuções.
let seq = 0;
const id = () => 'v1-' + String(++seq).padStart(4, '0');
const vol = (o) => C.volume({ id: id(), ...o });
const project = (name, volumes) => C.validateProject({ version: 1, name, volumes });

const fixtures = {};

// Igual a example() do app legado.
fixtures.example = project('Residencial Jardim', [
  vol({ name: 'Ala norte', points: C.shape('rect', 26, 6), x: 0, z: -8, height: 12.8, floors: 4, color: '#d8d1c1', roof: 'gable', roofHeight: 2.7, garden: false, balconies: true }),
  vol({ name: 'Ala oeste', points: C.shape('rect', 6, 14), x: -10, z: 2, height: 9.6, floors: 3, color: '#b77b56', balconies: true, garden: true }),
  vol({ name: 'Volume 03', points: C.shape('rect', 13, 5), x: 0, z: 9, height: 6.4, floors: 2, color: '#b77b56', facade: 'storefront', garden: true }),
  vol({ name: 'Ala leste', points: C.shape('rect', 6, 14), x: 10, z: 2, height: 12.8, floors: 4, color: '#d8d1c1', balconies: true, garden: true }),
  vol({ name: 'Torre curva', points: C.shape('circle', 7, 7), x: 14, z: 8, height: 9.6, floors: 3, color: '#d8d1c1', spacing: 2.6, windowWidth: 1.35, garden: true }),
]);

fixtures.setback = project('Recuo empilhado', [
  vol({ name: 'Base', points: C.shape('rect', 14, 10), height: 9.6, floors: 3 }),
  vol({ name: 'Base · recuo', points: C.shape('rect', 14 * 0.77, 10 * 0.77), base: 9.78, height: 3.2, floors: 1, color: '#d8d1c1' }),
]);

const courtyard = C.cutVolume(vol({ name: 'Pátio', points: C.shape('rect', 20, 16), x: 30, height: 6.4, floors: 2 }), [[24, -4], [36, -4], [36, 4], [24, 4]]);
fixtures.courtyard = project('Pátio e U', [
  vol({ name: 'Planta U', points: C.shape('u', 18, 12), height: 9.6, floors: 3, roof: 'flat', garden: true }),
  ...courtyard.map((v) => ({ ...v, id: id() })),
]);

fixtures.circle = project('Torre circular', [
  vol({ name: 'Torre', points: C.shape('circle', 10, 10), height: 22.4, floors: 7, roof: 'dome', roofHeight: 3 }),
]);

fixtures.openings = project('Aberturas manuais', [
  vol({
    name: 'Fachadas', points: C.shape('rect', 12, 8), height: 9.6, floors: 3, facade: 'arched',
    faces: {
      0: { manual: true, openings: [
        { u: 0.25, y: 0.015, w: 1.35, h: 2.4, kind: 'door', floor: 0 },
        { u: 0.6, y: 3.9, w: 1.2, h: 2.05, kind: 'window', floor: 1 },
        { u: 0.6, y: 7.1, w: 2, h: 1.6, kind: 'opening', floor: 2 },
      ] },
      1: { facade: 'storefront', color: '#7b8d81' },
      2: { facade: 'blank', trim: '#aa2222' },
      3: { facade: 'curtain', windowWidth: 2, spacing: 3 },
    },
  }),
]);

fixtures.roofs = project('Coberturas', ['flat', 'shed', 'gable', 'dome'].map((roof, i) =>
  vol({ name: 'Cobertura ' + roof, points: C.shape(i % 2 ? 'l' : 'rect', 10, 8), x: i * 14, height: 6.4, floors: 2, roof, roofHeight: 2.5 })));

fixtures.toggles = project('Detalhes', [
  vol({ name: 'Tudo ligado', points: C.shape('rect', 12, 9), rotation: 30, height: 12.8, floors: 4, balconies: true, brise: true, cornice: true, garden: true, pilotis: true }),
  vol({ name: 'Sem cornija', points: C.shape('l', 12, 9), x: 18, rotation: -45, height: 6.4, floors: 2, cornice: false }),
]);

fixtures['stress-120'] = project('Carga 120', Array.from({ length: 120 }, (_, i) =>
  vol({ name: 'V' + i, points: C.shape(['rect', 'l', 'u', 'circle'][i % 4], 6, 5), x: (i % 12) * 9 - 50, z: Math.floor(i / 12) * 8 - 40, height: 3.2 * (1 + (i % 5)), floors: 1 + (i % 5) })));

const out = resolve(root, 'test/fixtures/v1');
mkdirSync(out, { recursive: true });
for (const [name, p] of Object.entries(fixtures)) writeFileSync(resolve(out, name + '.json'), JSON.stringify(p, null, 2) + '\n');
console.log('Fixtures v1:', Object.keys(fixtures).join(', '));
