// THE BASELINE of docs/PLANO.md Etapa 3: each scenario played as the player
// does, timed by the game's own monitor (`__frames`, core/health.ts
// `frameStats`) - median, 95th percentile and largest frame, per system.
//
//   node scripts/probe-baseline.mjs [--base=http://localhost:5173/] [--only=empty,town,crowd,camera,blast]
//
// Headless Chrome draws on this machine's Intel UHD 770, about 5x slower on
// the GPU than the player's RTX 3060: read "desenho" with that in mind; the
// other systems are CPU and compare directly. Run at low priority.
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split('=').slice(1).join('=');
const base = arg('base', 'http://localhost:5173/');
const only = new Set(arg('only', 'empty,town,crowd,camera,blast').split(','));
const map = JSON.parse(fs.readFileSync(new URL('../maps/cidade-com-estacionamento.json', import.meta.url), 'utf8'));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
// The pointer lock would trap the real mouse of whoever is at this machine.
await context.addInitScript(() => { window.Element.prototype.requestPointerLock = function () { return Promise.resolve(); }; });
const page = await context.newPage();

const opened = () => page.waitForFunction(() => performance.getEntriesByName('opening:shown').length > 0, null, { timeout: 180_000, polling: 250 });
const now = () => page.evaluate(() => performance.now());
const frames = (since) => page.evaluate((s) => window.__frames(s), since);
const broken = () => page.evaluate(() => window.__health(100).filter((e) => e.severity === 'broken' && !e.earlier).map((e) => e.message));
/** Until the world of the last edit is built and the traffic's topology has caught up, ms from `from`. */
const settled = (from) => page.waitForFunction((f) => {
  const { scene, sim, net } = window.__roadcraft;
  const s = scene();
  return !s.worldBusy && sim.topologyRevision === net.trafficRevision ? performance.now() - f : null;
}, from, { timeout: 60_000, polling: 'raf' }).then((h) => h.jsonValue());
const glide = async (a, b, n = 12) => {
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
};
/** A road drawn by a drag; how long until its world and traffic are in place. */
const road = async (a, b) => {
  await glide(a, b);
  const from = await now();
  return Math.round(await settled(from));
};
const report = (name, stats, extra = {}) => {
  const top = Object.entries(stats.systems).sort((x, y) => y[1].p95 - x[1].p95).slice(0, 6)
    .map(([k, v]) => `${k} ${v.p50}/${v.p95}/${v.max}`).join(' · ');
  console.log(JSON.stringify({ scenario: name, frames: stats.frames, long: stats.long, total: stats.total, ...extra }));
  console.log(`  por sistema (mediana/p95/máx ms): ${top}`);
};

await page.goto(base, { waitUntil: 'domcontentloaded' });
await opened();
await page.waitForTimeout(1500);
const pick = (tool) => page.evaluate((t) => document.querySelector(`.tool[data-tool="${t}"]`)?.click(), tool);

if (only.has('empty')) {
  await pick('road');
  const since = await now();
  const edits = [];
  for (let i = 0; i < 4; i++) edits.push(await road([300, 180 + i * 100], [900, 180 + i * 100]));
  for (let i = 0; i < 4; i++) edits.push(await road([360 + i * 160, 140], [360 + i * 160, 560]));
  report('mapa vazio, 8 vias', await frames(since), { editMs: edits });
}

if (only.has('town') || only.has('crowd') || only.has('camera') || only.has('blast')) {
  await page.evaluate((m) => window.__roadcraft.loadDoc(m), map);
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const shown = await opened().then(() => page.evaluate(() => performance.getEntriesByName('opening:shown')[0].startTime));
  await page.waitForTimeout(3000);
  console.log(JSON.stringify({ scenario: 'abertura da cidade de teste', shownMs: Math.round(shown) }));
}

if (only.has('town')) {
  await pick('road');
  const since = await now();
  const edits = [];
  edits.push(await road([560, 300], [700, 300]));
  edits.push(await road([600, 420], [600, 520]));
  edits.push(await road([480, 380], [560, 450]));
  report('cidade de teste, 3 vias curtas', await frames(since), { editMs: edits });
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Control+z'); await page.waitForTimeout(300); }
  await settled(await now());
}

if (only.has('crowd')) {
  await page.evaluate(() => {
    for (const [id, value] of [['trafficIntensity', 400], ['pedIntensity', 400]]) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const filling = await now();
  await page.waitForTimeout(12_000);
  report('400/400 enchendo (criação de pessoas e carros)', await frames(filling));
  const since = await now();
  await page.waitForTimeout(4000);
  const counts = await page.evaluate(() => {
    const { sim } = window.__roadcraft;
    return { cars: sim.vehicles?.length ?? null, people: sim.peds?.length ?? sim.pedestrians?.length ?? null };
  });
  report('400/400 rodando', await frames(since), counts);
}

if (only.has('camera')) {
  const since = await now();
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 40; i++) { await page.mouse.move(640 + i * 8, 360 - i * 2); await page.waitForTimeout(16); }
  await page.mouse.up({ button: 'right' });
  await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 40; i++) { await page.mouse.move(960 - i * 10, 280 + i * 4); await page.waitForTimeout(16); }
  await page.mouse.up({ button: 'middle' });
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, i < 5 ? -240 : 240); await page.waitForTimeout(60); }
  await page.waitForTimeout(500);
  report('câmera: girar, arrastar, zoom', await frames(since));
}

if (only.has('blast')) {
  const since = await now();
  await page.evaluate(() => {
    const { doc } = window.__roadcraft;
    const b = [...doc.buildings.all()][0];
    if (b) window.__roadcraft.explode({ x: b.x, y: b.y }, 0, 1);
  });
  await page.waitForTimeout(4000);
  report('bomba num prédio', await frames(since));
}

console.log(JSON.stringify({ broken: await broken() }));
await browser.close();
