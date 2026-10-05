// Photographs a person of the city taken into the player's hands, as the
// player does it: the Inspect tool, a click on somebody in the street, the
// card's Control button; then the keys - walk, run, talk, hit, get into a car
// and drive. Headless.
//
//   node scripts/player-shots.mjs --base=http://127.0.0.1:5173 --town=town.json --out=dir
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:5173');
const out = opt('out', 'player-shots');
const town = JSON.parse(readFileSync(opt('town', 'town.json'), 'utf8'));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.clear(); localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 180_000 });
await page.evaluate((data) => window.__roadcraft.loadDoc(data), town);
await page.waitForTimeout(6000);
await page.evaluate(() => {
  const r = window.__roadcraft;
  r.sim.clock.paused = true;
  r.sim.city.skip(4 * 60);
  r.runSim(60);
});
const log = [];
let shot = 0;
const photo = async (what) => {
  await page.waitForTimeout(400);
  const name = `${String(shot++).padStart(2, '0')}-${what}`;
  await page.screenshot({ path: `${out}/${name}.png` });
  const v = await page.evaluate(() => window.__roadcraft.sim.city.player.view());
  log.push({ name, view: v });
};
const hold = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k);
};

// Somebody walking with others near: the camera on them, the Inspect tool, a click on them.
const who = await page.evaluate(() => {
  const r = window.__roadcraft;
  const views = r.sim.pedViews.filter((v) => v.id >= (1 << 25));
  const near = (v) => views.filter((q) => Math.hypot(q.x - v.x, q.y - v.y) < 60).length;
  const v = views.sort((a, b) => near(b) - near(a))[0];
  r.lookAt(v.x, v.y, 18);
  const h = r.scene().surfaceHeightAt(v.x, v.y);
  const c = r.view().toWorldAt(innerWidth / 2, innerHeight / 2, h);
  r.lookAt(2 * v.x - c.x, 2 * v.y - c.y, 18);
  return { id: v.id };
});
await page.waitForTimeout(1500);
await page.locator('[title^="Inspecionar"], [data-tool="inspect"]').first().click().catch(() => {});
const at = await page.evaluate((id) => {
  const r = window.__roadcraft;
  const v = r.sim.pedViewById.get(id);
  const h = r.scene().surfaceHeightAt(v.x, v.y);
  return r.view().toScreen({ x: v.x, y: v.y }, innerWidth, innerHeight, h);
}, who.id);
await page.mouse.click(at.x, at.y);
await page.waitForTimeout(800);
await photo('card');
await page.locator('[title^="Controlar esta pessoa"]').first().click();
await page.waitForTimeout(500);
await photo('taken');
// Walk, then run.
await hold(['w'], 2500);
await photo('walked');
await hold(['Shift', 'd'], 2500);
await photo('ran');
// A word with whoever is near, and a blow.
const closest = async () => page.evaluate(() => {
  const r = window.__roadcraft;
  const p = r.sim.city.player;
  const others = r.sim.pedViews.filter((v) => v.id !== p.person).sort((a, b) =>
    Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  return others[0] ? { x: others[0].x, y: others[0].y, d: Math.hypot(others[0].x - p.x, others[0].y - p.y) } : null;
});
// Walk up to them, steering with the keys along the screen.
const approach = async (reach) => {
  for (let k = 0; k < 60; k++) {
    const t = await closest();
    if (!t || t.d < reach) break;
    const dir = await page.evaluate((t) => {
      const r = window.__roadcraft;
      const p = r.sim.city.player;
      const h = r.scene().surfaceHeightAt(p.x, p.y);
      const a = r.view().toScreen({ x: p.x, y: p.y }, innerWidth, innerHeight, h);
      const b = r.view().toScreen({ x: t.x, y: t.y }, innerWidth, innerHeight, h);
      return { x: b.x - a.x, y: b.y - a.y };
    }, t);
    const keys = [];
    if (dir.x > 8) keys.push('d'); else if (dir.x < -8) keys.push('a');
    if (dir.y > 8) keys.push('s'); else if (dir.y < -8) keys.push('w');
    await hold(keys.length ? keys : ['w'], 200);
  }
};
await approach(2.2 * 2.5);
await page.keyboard.press('f');
await page.waitForTimeout(1500);
await photo('talk');
await page.waitForTimeout(6000);
await approach(1.2 * 2.5);
await page.keyboard.press(' ');
await page.waitForTimeout(1200);
await photo('hit');
await page.waitForTimeout(4000);
await photo('after');
// The nearest car: walked to, got into, driven.
const car = await page.evaluate(() => {
  const r = window.__roadcraft;
  const p = r.sim.city.player;
  let best = null, bd = Infinity;
  for (const c of r.sim.city.cars.cars.values()) {
    const f = c.body?.free;
    if (!f || r.sim.city.cars.tripOfCar(c.id)) continue;
    const d = Math.hypot(f.x - p.x, f.y - p.y);
    if (d < bd) { bd = d; best = { x: f.x, y: f.y }; }
  }
  return best;
});
if (car) {
  for (let k = 0; k < 80; k++) {
    const d = await page.evaluate((c) => { const p = window.__roadcraft.sim.city.player; return Math.hypot(c.x - p.x, c.y - p.y); }, car);
    if (d < 3.5 * 2.5 || (await page.evaluate(() => window.__roadcraft.sim.city.player.resident)) === null) break;
    const dir = await page.evaluate((c) => {
      const r = window.__roadcraft;
      const p = r.sim.city.player;
      const h = r.scene().surfaceHeightAt(p.x, p.y);
      const a = r.view().toScreen({ x: p.x, y: p.y }, innerWidth, innerHeight, h);
      const b = r.view().toScreen({ x: c.x, y: c.y }, innerWidth, innerHeight, h);
      return { x: b.x - a.x, y: b.y - a.y };
    }, car);
    const keys = ['Shift'];
    if (dir.x > 8) keys.push('d'); else if (dir.x < -8) keys.push('a');
    if (dir.y > 8) keys.push('s'); else if (dir.y < -8) keys.push('w');
    await hold(keys, 250);
  }
  await page.keyboard.press('e');
  await page.waitForTimeout(800);
  await photo('in-car');
  await hold(['w'], 2500);
  await hold(['w', 'd'], 1200);
  await photo('driving');
}
// Into a restaurant: out of the car, to its door, E; then out again.
if (await page.evaluate(() => window.__roadcraft.sim.city.player.mode === 'car')) { await page.keyboard.press('e'); await page.waitForTimeout(500); }
const eatery = await page.evaluate(() => {
  const r = window.__roadcraft;
  const b = [...r.doc.buildings.all()].find((x) => (x.function === 'restaurant' || x.function === 'bakery') && r.sim.city.doorOf(x.id));
  const d = b ? r.sim.city.doorOf(b.id) : null;
  if (!d) return null;
  const p = r.sim.city.player; p.x = d.x; p.y = d.y;
  r.lookAt(d.x, d.y, 30);
  return d;
});
if (eatery) {
  await page.waitForTimeout(400);
  await page.keyboard.press('e');
  await page.waitForTimeout(4000);
  await photo('inside-restaurant');
  await page.keyboard.press('e');
  await page.waitForTimeout(800);
  await photo('out-of-restaurant');
}
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
console.log(JSON.stringify(log.map((l) => [l.name, l.view?.mode, l.view?.wanted, l.view?.message?.key, l.view?.officers])));
await browser.close();
