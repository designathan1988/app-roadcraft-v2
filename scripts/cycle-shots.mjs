// Cycle lanes as the player meets them: the new town's east-west streets with
// their red lane, a resident without a car cycling in it (and their card when
// the bicycle is clicked), then the road tool's parking options with the
// cycle lane chosen. Headless. (Drawing a road is photographed in the app.)
//
//   node scripts/cycle-shots.mjs --base=http://127.0.0.1:5173 --town=maps/cidade-com-estacionamento.json --out=dir
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:5173');
const out = opt('out', 'cycle-shots');
const town = JSON.parse(readFileSync(opt('town', 'maps/cidade-com-estacionamento.json'), 'utf8'));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.clear(); localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 180_000 });
await page.evaluate((data) => window.__roadcraft.loadDoc(data), town);
await page.waitForTimeout(6000);
await page.evaluate(() => { const r = window.__roadcraft; r.sim.clock.paused = true; r.sim.city.skip(4 * 60); r.runSim(5); });
const log = [];
let shot = 0;
const photo = async (what, extra = {}, live = true) => {
  if (live) {
    await page.evaluate(() => { window.__roadcraft.sim.clock.paused = false; });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__roadcraft.sim.clock.paused = true; });
  }
  await page.waitForTimeout(600);
  const name = `${String(shot++).padStart(2, '0')}-${what}`;
  await page.screenshot({ path: `${out}/${name}.png` });
  const card = await page.evaluate(() => document.querySelector('.agent-card')?.innerText ?? null);
  log.push({ name, ...extra, ...(card ? { card } : {}) });
};
const aim = (x, y, z) => page.evaluate(([x, y, z]) => {
  const r = window.__roadcraft;
  r.lookAt(x, y, z);
  const h = r.scene().surfaceHeightAt(x, y);
  const c = Number.isFinite(h) ? r.view().toWorldAt(innerWidth / 2, innerHeight / 2, h) : null;
  if (c) r.lookAt(2 * x - c.x, 2 * y - c.y, z);
}, [x, y, z]);
const screenOf = (p) => page.evaluate((p) => {
  const r = window.__roadcraft;
  const h = r.scene().surfaceHeightAt(p.x, p.y);
  const s = r.view().toScreen(p, innerWidth, innerHeight, Number.isFinite(h) ? h : 0);
  const box = document.querySelector('canvas').getBoundingClientRect();
  return { x: s.x + box.left, y: s.y + box.top };
}, p);

// 1. A street of the new town with its cycle lane.
const street = await page.evaluate(() => {
  const { sim } = window.__roadcraft;
  const lane = [...sim.graph.lanelets.values()].filter((l) => l.cycleShift && l.length > 150).sort((a, b) => b.length - a.length)[0];
  const f = lane.centre.sampleAt(lane.length / 2);
  return { x: f.p.x, y: f.p.y, lanes: [...sim.graph.lanelets.values()].filter((l) => l.cycleShift).length };
});
await aim(street.x, street.y, 14);
await photo('street', street);

// 2. A resident without a car on their bicycle, riding in a cycle lane.
const rider = async () => page.evaluate(() => {
  const { sim } = window.__roadcraft;
  for (const t of sim.city.trips.values()) {
    if (t.mode !== 'bike') continue;
    const v = sim.vehicles.get(t.agent);
    const lane = v && sim.lanelet(v.lanelet);
    const c = v ? v.s - v.archetype.length / 2 : 0;
    if (!lane?.cycleShift || c < 30 || c > lane.length - 30 || v.v < 1) continue;
    // The body, in the cycle lane beside the lane's centre.
    const f = lane.centre.sampleAt(c);
    return { resident: t.resident, bike: t.agent, lane: String(lane.id), x: f.p.x + f.n.x * lane.cycleShift, y: f.p.y + f.n.y * lane.cycleShift };
  }
  return null;
});
let found = await rider();
for (let i = 0; i < 300 && !found; i++) { await page.evaluate(() => window.__roadcraft.runSim(0.5)); found = await rider(); }
if (!found) { console.error('no bicycle in a cycle lane'); await browser.close(); process.exit(1); }
// Turned round: the cycle lane of these streets lies on the far side of the houses.
await page.evaluate(() => { const v = window.__roadcraft.view(); const az = typeof v.azimuth === 'function' ? v.azimuth() : v.azimuth; const el = typeof v.elevation === 'function' ? v.elevation() : v.elevation; v.setOrbit(az + Math.PI, el); });
await aim(found.x, found.y, 18);
await page.waitForTimeout(4000);
await photo('bike-in-lane', found);
// Click on the bicycle: the rider's card.
const now = await rider() ?? found;
const s = await screenOf(now.bike === found.bike ? now : found);
await page.mouse.click(s.x, s.y);
await photo('bike-card', {}, false);
const closed = await page.evaluate(() => { const b = document.querySelector('.agent-card button[title="Fechar"]'); b?.click(); return Boolean(b); });
console.log('card closed', closed, await page.evaluate(() => getComputedStyle(document.querySelector('.agent-card')).display));

// 3. The road tool: parking options, the cycle lane chosen, a road drawn with it.
await page.locator('.v2-cat[data-cat="roads"]').click();
await page.waitForTimeout(500);
await photo('road-tool', {}, false);
await page.locator('.v2-choice[title="Ciclofaixa dos dois lados"]').click();
await page.waitForTimeout(300);
await photo('road-tool-cycle', {}, false);
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
console.log(JSON.stringify(log));
await browser.close();
