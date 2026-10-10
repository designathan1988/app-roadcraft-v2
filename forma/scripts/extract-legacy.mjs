// Extrai do HTML legado a biblioteca polygon-clipping e o FormaCore (UMD) para
// test/legacy/, onde os testes de paridade comparam o código novo com o antigo.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, '../forma-construtor-3d-legacy.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const clipping = scripts.find((s) => s.includes('polygonClipping='));
const core = scripts.find((s) => s.includes('root.FormaCore=Core'));
if (!clipping || !core) throw new Error('Scripts do FORMA legado não encontrados.');

const out = resolve(root, 'test/legacy');
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'package.json'), '{ "type": "commonjs" }\n');
writeFileSync(resolve(out, 'polygon-clipping.js'), clipping);
writeFileSync(resolve(out, 'forma-core.js'), core);
console.log('Código legado extraído para test/legacy/.');
