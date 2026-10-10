// Abre o FORMA legado no Chromium com cada fixture v1 e grava, por volume, as
// peças geradas (malhas, instâncias por material, caixa envolvente).
// Saída: test/fixtures/legacy-baselines.json — usada nos testes de paridade.
import { chromium } from '@playwright/test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const legacyUrl = pathToFileURL(resolve(root, '../forma-construtor-3d.html')).href;
const dir = resolve(root, 'test/fixtures/v1');

// Captura o grupo raiz 'FORMA' quando o app o adiciona à cena.
const trap = () => {
  Object.defineProperty(globalThis, 'THREE', {
    configurable: true,
    get() { return undefined; },
    set(T) {
      Object.defineProperty(globalThis, 'THREE', { value: T, writable: true, configurable: true });
      const add = T.Object3D.prototype.add;
      T.Object3D.prototype.add = function (...objs) {
        for (const o of objs) if (o && o.name === 'FORMA') globalThis.__formaRoot = o;
        return add.apply(this, objs);
      };
    },
  });
};

const measure = () => {
  const T = globalThis.THREE, r2 = (n) => Math.round(n * 100) / 100, out = {};
  for (const g of globalThis.__formaRoot.children) {
    const meshes = {}, instances = {};
    for (const o of g.children) {
      if (o.isInstancedMesh) {
        const key = '#' + o.material.color.getHexString();
        instances[key] = (instances[key] || 0) + o.count;
      } else if (o.isMesh) {
        const part = o.userData.part || 'other';
        meshes[part] = (meshes[part] || 0) + 1;
      }
    }
    const b = new T.Box3().setFromObject(g);
    out[g.userData.volumeId] = { meshes, instances, box: [...b.min.toArray(), ...b.max.toArray()].map(r2) };
  }
  return out;
};

const browser = await chromium.launch();
const baselines = {};
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const json = readFileSync(resolve(dir, file), 'utf8');
  const context = await browser.newContext({ viewport: { width: 1440, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(trap);
  await page.addInitScript((j) => localStorage.setItem('forma_project_v1', j), json);
  await page.goto(legacyUrl);
  await page.waitForSelector('body[data-ready="true"]');
  const loaded = await page.evaluate(() => globalThis.Forma.getProject().volumes.length);
  if (loaded !== JSON.parse(json).volumes.length) throw new Error(file + ': o app legado não carregou a fixture.');
  if (errors.length) throw new Error(file + ': ' + errors.join('; '));
  baselines[file.replace('.json', '')] = await page.evaluate(measure);
  await context.close();
}
await browser.close();
writeFileSync(resolve(root, 'test/fixtures/legacy-baselines.json'), JSON.stringify(baselines, null, 1) + '\n');
console.log('Referências gravadas:', Object.keys(baselines).join(', '));
