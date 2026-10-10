import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const threeLicense = await readFile(resolve(root, 'node_modules/three/LICENSE'), 'utf8');
const studios = [
  ['signal', 'Signal Studio · Cruzamentos e semáforos'],
  ['traffic', 'Traffic Studio · Tráfego e cenários'],
  ['transit', 'Transit Studio · Transporte público'],
  ['material', 'Material Studio · Materiais e superfícies'],
  ['animation', 'Animation Studio · Animações e poses'],
  ['sound', 'Sound Studio · Som e ambientes sonoros'],
];
const result = await build({ root, configFile: false, logLevel: 'warn', build: {
  write: false, target: 'es2022', minify: true,
  lib: { entry: resolve(root, 'src/studios/main.ts'), formats: ['es'], fileName: 'studios' },
  rolldownOptions: { output: { codeSplitting: false } },
} });
const outputs = Array.isArray(result) ? result : [result];
const chunk = outputs.flatMap(output => output.output).find(output => output.type === 'chunk');
if (!chunk) throw new Error('No studio bundle was emitted.');
const code = chunk.code.replace(/<\/script/gi, '<\\/script');
for (const [kind, title] of studios) {
  const html = `<!doctype html>\n<!-- Bundled three.js licence:\n${threeLicense}\n-->\n<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title} — Roadcraft</title></head><body data-studio="${kind}"><script type="module">${code}</script></body></html>\n`;
  await writeFile(resolve(root, `${kind}-system.html`), html, 'utf8');
  console.log(`${kind}-system.html · ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB · self-contained`);
}
