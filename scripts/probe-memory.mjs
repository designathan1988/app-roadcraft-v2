// Steady-state JS memory: the town the game opens on, then the same session
// with an empty map loaded, each after the people have loaded and a GC.
import { chromium } from '@playwright/test';

const base = (process.argv.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:4197').slice(7);
const settle = Number((process.argv.find((a) => a.startsWith('--settle=')) ?? '--settle=90000').slice(9));
const emptySettle = Number((process.argv.find((a) => a.startsWith('--empty-settle=')) ?? '--empty-settle=15000').slice(15));
const returnSettle = Number((process.argv.find((a) => a.startsWith('--return-settle=')) ?? '--return-settle=0').slice(16));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { globalThis.window.confirm = () => true; });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(globalThis.window.__roadcraft), null, { timeout: 120_000 });
const cdp = await page.context().newCDPSession(page);
const measure = async (label) => {
  await cdp.send('HeapProfiler.collectGarbage');
  const m = await page.evaluate(() => {
    const s = globalThis.window.__roadcraft.scene();
    const info = s.gl?.info?.memory ?? {};
    let anim = 0, palette = 0, models = 0;
    s.scene.traverse((o) => { if (o.userData?.animationBytes) { anim += o.userData.animationBytes; palette += o.userData.paletteBytes ?? 0; models = Math.max(models, o.userData.loadedModels ?? 0); } });
    const citizens = s.scene.getObjectByName('rigged-citizens');
    let activeMeshes = 0, activeInstances = 0, sceneObjects = 0;
    s.scene.traverse(() => sceneObjects++);
    citizens?.traverse((o) => {
      if (!o.isInstancedMesh || !o.visible || o.count === 0) return;
      activeMeshes++;
      activeInstances += o.count;
    });
    let morphBytes = 0, geoBytes = 0, morphCount = 0; const gseen = new Set();
    s.scene.traverse((o) => { const g = o.geometry; if (!g || gseen.has(g)) return; gseen.add(g);
      for (const a of Object.values(g.attributes)) geoBytes += a.array.byteLength;
      for (const list of Object.values(g.morphAttributes ?? {})) for (const a of list) { morphBytes += a.array.byteLength; morphCount++; } });
    let texBytes = 0; const seen = new Set();
    s.scene.traverse((o) => { for (const mat of [].concat(o.material ?? [])) for (const v of Object.values(mat)) { if (v?.isTexture && !seen.has(v)) { seen.add(v); const im = v.image; if (im?.data?.byteLength) texBytes += im.data.byteLength; else if (im?.width) texBytes += im.width * im.height * 4; } } });
    return { animMB: Math.round(anim / 1048576), paletteMB: Math.round(palette / 1048576), models,
      activeMeshes, activeInstances, sceneObjects, drawCalls: s.stats.drawCalls, triangles: s.stats.triangles,
      sceneTexMB: Math.round(texBytes / 1048576), morphMB: Math.round(morphBytes / 1048576), morphTargets: morphCount, geoMB: Math.round(geoBytes / 1048576), heapMB: Math.round(globalThis.performance.memory.usedJSHeapSize / 1048576), geometries: info.geometries, textures: info.textures,
      buildings: globalThis.window.__roadcraft.doc.buildings.size, residents: globalThis.window.__roadcraft.sim.city.counts?.().residents };
  });
  console.log(label, JSON.stringify(m));
};
await page.waitForTimeout(settle);
await measure('town');
await page.evaluate(() => globalThis.window.__roadcraft.loadDoc({ version: 1, nodes: [], segments: [], terrain: [] }));
await page.waitForTimeout(emptySettle);
await measure('empty');
if (returnSettle > 0) {
  await page.evaluate(() => globalThis.document.getElementById('sampleTown').click());
  await page.waitForTimeout(returnSettle);
  await measure('returned');
}
await browser.close();
