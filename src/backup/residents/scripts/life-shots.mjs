// Photographs what residents do inside and around their buildings
// (`sim/agents/activities.ts`): a home cut open in the evening, a workplace cut
// open in the morning, a shop with customers, and people out in their lots.
// Headless.
//
//   AGENT_TOWN_OUT=town.json node scripts/test-light.mjs tests/sim/agents/ownCars.spec.ts   (the town map)
//   node scripts/life-shots.mjs --base=http://127.0.0.1:5173 --town=town.json --out=dir
//
// Writes <out>/NN-<what>.png and <out>/log.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:5173');
const out = opt('out', 'life-shots');
const town = JSON.parse(readFileSync(opt('town', 'town.json'), 'utf8'));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.clear(); localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 180_000 });
await page.evaluate((data) => window.__roadcraft.loadDoc(data), town);
await page.waitForTimeout(6000);

const log = [];
let shot = 0;
/** Lives `minutes` of game time after a skip to `clock` (minutes after midnight, today or tomorrow). */
const liveTo = (clock, seconds = 60) => page.evaluate(([clock, seconds]) => {
  const r = window.__roadcraft;
  r.sim.clock.paused = true;
  const now = r.sim.city.minutes(r.sim) % 1440;
  r.sim.city.skip((clock - now + 1440) % 1440);
  r.runSim(seconds);
}, [clock, seconds]);
const aim = (x, y, z, up = 0) => page.evaluate(([x, y, z, up]) => {
  const r = window.__roadcraft;
  r.lookAt(x, y, z);
  // The camera's centre is at height 0: aimed at the floor the person is on.
  const h = r.scene().surfaceHeightAt(x, y) + up;
  const c = Number.isFinite(h) ? r.view().toWorldAt(innerWidth / 2, innerHeight / 2, h) : null;
  if (c) r.lookAt(2 * x - c.x, 2 * y - c.y, z);
}, [x, y, z, up]);
const photo = async (what, extra) => {
  // The clock running a few seconds: bodies settle into their poses (a paused
  // game holds every clip on its first frame: those sitting down stand).
  await page.evaluate(() => { window.__roadcraft.sim.clock.paused = false; });
  await page.waitForTimeout(5000);
  await page.evaluate(() => { window.__roadcraft.sim.clock.paused = true; });
  const name = `${String(shot++).padStart(2, '0')}-${what}`;
  await page.screenshot({ path: `${out}/${name}.png` });
  log.push({ name, ...extra });
};

/** The building with most people doing one of `kinds`, its floor, and what they do there. */
const busiest = (kinds, outside) => page.evaluate(([kinds, outside]) => {
  const r = window.__roadcraft;
  const city = r.sim.city;
  const by = new Map();
  for (const res of city.population.residents) {
    const d = city.doingOf(res.id);
    if (!d || !kinds.includes(d.kind) || Boolean(d.out) !== outside) continue;
    const key = outside ? `${Math.round(d.out.x / 40)},${Math.round(d.out.y / 40)}` : `${d.building}:${d.level}`;
    const e = by.get(key) ?? { building: d.building, level: d.level, n: 0, kinds: {}, x: d.out?.x, y: d.out?.y };
    e.n++;
    e.kinds[d.kind] = (e.kinds[d.kind] ?? 0) + 1;
    by.set(key, e);
  }
  const best = [...by.values()].sort((a, b) => b.n - a.n)[0];
  if (!best) return null;
  const b = r.doc.buildings.get(best.building);
  return { ...best, x: best.x ?? b.x, y: best.y ?? b.y };
}, [kinds, outside]);

/** Where a resident doing one of `kinds` in that building and floor is: the piece of furniture, world. */
const pieceOf = (building, level) => page.evaluate(async ([building, level]) => {
  const r = window.__roadcraft;
  const { interiorAt } = await import('/src/world/buildings/interior.ts');
  const { localToWorld, levelElevation } = await import('/src/world/buildings/geometry.ts');
  const b = r.doc.buildings.get(building);
  for (const res of r.sim.city.population.residents) {
    const d = r.sim.city.doingOf(res.id);
    if (!d || d.building !== building || d.level !== level || d.piece < 0) continue;
    const f = interiorAt(b, level).furniture[d.piece];
    if (f) return { ...localToWorld(b, f.x, f.y), up: levelElevation(b, level) };
  }
  return null;
}, [building, level]);

/** Opens a building at a floor as the player does: a double click on it, then "Floor above". */
const open = async (e, zoom) => {
  const at = (await pieceOf(e.building, e.level)) ?? { x: e.x, y: e.y };
  await aim(at.x, at.y, zoom, at.up ?? 0);
  await page.waitForTimeout(800);
  await page.mouse.dblclick(700, 430);
  // Down to the ground floor first: the floor shown is kept from the last building opened.
  for (let i = 0; i < 6; i++) await page.locator('.inside-bar [title="Andar abaixo"], .inside-bar [title="Floor below"]').first().click();
  for (let i = 0; i < e.level; i++) {
    await page.locator('.inside-bar [title="Andar acima"], .inside-bar [title="Floor above"]').first().click();
    await page.waitForTimeout(200);
  }
  return at;
};
const close = async () => {
  await page.locator('.inside-bar [title="Fechar a vista por dentro"], .inside-bar [title="Close the inside view"]').first().click();
  await page.waitForTimeout(300);
};

// The evening at home.
await liveTo(19 * 60 + 30, 90);
const home = await busiest(['tv', 'eat', 'cook', 'talk', 'read', 'game', 'dishes', 'bath', 'childcare'], false);
if (home) { await open(home, 24); await photo('home-evening', home); const nearhome = await pieceOf(home.building, home.level); if (nearhome) { await aim(nearhome.x, nearhome.y, 60, nearhome.up); await photo('home-evening-close', home); } await close(); }
const yard = await busiest(['garden', 'swim', 'porch', 'washCar'], true);
if (yard) { await aim(yard.x, yard.y, 18); await photo('yard', yard); }
const shop = await busiest(['shop', 'pay', 'dine', 'drink', 'bank', 'watch', 'pray'], false);
if (shop) { await open(shop, 22); await photo('out-evening', shop); const nearshop = await pieceOf(shop.building, shop.level); if (nearshop) { await aim(nearshop.x, nearshop.y, 60, nearshop.up); await photo('out-evening-close', shop); } await close(); }
// The working morning.
await liveTo(8 * 60, 360);
const work = await busiest(['computer', 'machine', 'checkout', 'reception', 'stock', 'serve', 'teach', 'study', 'treat', 'mop', 'guard', 'cook'], false);
if (work) { await open(work, 22); await photo('work-morning', work); const nearwork = await pieceOf(work.building, work.level); if (nearwork) { await aim(nearwork.x, nearwork.y, 60, nearwork.up); await photo('work-morning-close', work); } await close(); }
// The night.
await liveTo(2 * 60, 60);
const night = await busiest(['sleep'], false);
if (night) { await open(night, 24); await photo('home-night', night); const nearnight = await pieceOf(night.building, night.level); if (nearnight) { await aim(nearnight.x, nearnight.y, 60, nearnight.up); await photo('home-night-close', night); } await close(); }
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
console.log(JSON.stringify(log.map((l) => [l.name, l.kinds])));
await browser.close();
