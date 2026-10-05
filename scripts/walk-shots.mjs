// Photographs residents walking as agents (`?agents=1`, `sim/agents/walk.ts`) in the
// default town on an evening: the busiest footway, somebody waiting at a zebra's
// kerb, somebody crossing, a corner, and one walker followed for a while. Headless.
//
//   npx vite --port 4211 --strictPort                     (the game, own port; or the dev server)
//   AGENT_TOWN_OUT=town.json node scripts/test-light.mjs tests/sim/agents/ownCars.spec.ts   (the town map)
//   node scripts/walk-shots.mjs --base=http://127.0.0.1:4211 --town=town.json --out=dir
//
// Writes <out>/NN-<what>.png and <out>/log.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4211');
const out = opt('out', 'walk-shots');
const ZOOM = Number(opt('zoom', '12'));
const town = JSON.parse(readFileSync(opt('town', 'town.json'), 'utf8'));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.clear(); localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(`${base}/?agents=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 180_000 });
await page.evaluate((data) => window.__roadcraft.loadDoc(data), town);
await page.waitForTimeout(6000);
// Late afternoon: residents going out to eat, for fun and for company.
await page.evaluate(() => {
  const r = window.__roadcraft;
  r.sim.clock.paused = true;
  r.sim.city.skip(10.5 * 60);
  r.runSim(45);
});

/** Aims the camera at the ground at (x, y): its centre is at height 0. */
const aim = (x, y, z) => page.evaluate(([x, y, z]) => {
  const r = window.__roadcraft;
  r.lookAt(x, y, z);
  const h = r.scene().surfaceHeightAt(x, y);
  const c = Number.isFinite(h) ? r.view().toWorldAt(innerWidth / 2, innerHeight / 2, h) : null;
  if (c) r.lookAt(2 * x - c.x, 2 * y - c.y, z);
}, [x, y, z]);

const log = [];
let shot = 0;
const photo = async (what, x, y, z = ZOOM, extra = {}) => {
  await aim(x, y, z);
  await page.waitForTimeout(1200);
  const name = `${String(shot++).padStart(2, '0')}-${what}`;
  await page.screenshot({ path: `${out}/${name}.png` });
  log.push({ name, x, y, ...extra });
};

/** Picks a walker: the one in the busiest spot, or the first meeting a test. */
const find = (kind) => page.evaluate((kind) => {
  const views = window.__roadcraft.sim.pedViews;
  const near = (v) => views.filter((q) => Math.hypot(q.x - v.x, q.y - v.y) < 20).length;
  let pick = null, best = -1;
  for (const v of views) {
    const ok = kind === 'busy' ? v.ground === 'footway' && v.kerbWait === 0
      : kind === 'waiting' ? v.kerbWait > 2
      : kind === 'crossing' ? v.ground === 'crossing' && v.walking
      : true;
    if (!ok) continue;
    const n = near(v);
    if (n > best) { best = n; pick = { id: v.id, x: v.x, y: v.y, around: n, wait: v.kerbWait }; }
  }
  return pick;
}, kind);

for (const kind of ['busy', 'waiting', 'crossing']) {
  const p = await find(kind);
  if (p) await photo(kind, p.x, p.y, ZOOM, p);
  else log.push({ name: `no ${kind}` });
}

// One walker followed: a shot every two seconds.
const first = await find('busy');
if (first) {
  for (let i = 0; i < 8; i++) {
    const v = await page.evaluate((id) => {
      const p = window.__roadcraft.sim.pedViewById.get(id);
      return p ? { x: p.x, y: p.y, v: p.v, ground: p.ground, wait: p.kerbWait } : null;
    }, first.id);
    if (!v) break;
    await photo(`follow-${i}`, v.x, v.y, ZOOM, v);
    await page.evaluate(() => window.__roadcraft.runSim(2));
  }
}
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
console.log(JSON.stringify(log.map((l) => l.name)));
await browser.close();
