// Lays out public transport as the player does - the Transport tool of the
// dock, clicks on the map - and photographs it running: a bus line of four
// stops (the first a terminal) and a train line of three stations on a track
// across the town; a bus at a stop, a train at a station, the lines on the map.
// Headless.
//
//   node scripts/transit-shots.mjs --base=http://127.0.0.1:5173 --town=town.json --out=dir
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:5173');
const out = opt('out', 'transit-shots');
const town = JSON.parse(readFileSync(opt('town', 'town.json'), 'utf8'));
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
const photo = async (what, extra = {}) => {
  await page.evaluate(() => { window.__roadcraft.sim.clock.paused = false; });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.__roadcraft.sim.clock.paused = true; });
  const name = `${String(shot++).padStart(2, '0')}-${what}`;
  await page.screenshot({ path: `${out}/${name}.png` });
  log.push({ name, ...extra });
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
  return r.view().toScreen(p, innerWidth, innerHeight, Number.isFinite(h) ? h : 0);
}, p);
/** Clicks the map at a world point, the camera on it first. */
const clickAt = async (p, zoom, detail = 1) => {
  await aim(p.x, p.y, zoom);
  await page.waitForTimeout(500);
  const s = await screenOf(p);
  if (detail === 2) await page.mouse.dblclick(s.x, s.y); else await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(250);
};

// Where the stops go: footways of town streets whose lane leads on into the town.
const plan = await page.evaluate(async () => {
  const r = window.__roadcraft;
  const { buildWalkways } = await import('/src/world/walkways.ts');
  const { laneBeside } = await import('/src/sim/agents/parking.ts');
  const { planTrip } = await import('/src/sim/drive/tactical.ts');
  const sim = r.sim, doc = r.doc;
  const links = [...sim.graph.lanelets.values()].filter((l) => l.kind === 'link').filter((_, i) => i % 6 === 0);
  const joined = (seg) => { const s = doc.segments.get(seg); return s && doc.nodes.get(s.a).incident.length > 1 && doc.nodes.get(s.b).incident.length > 1; };
  const picked = [];
  for (const w of buildWalkways(r.net).ways) {
    if (w.kind !== 'footway' || w.segment === undefined || w.path.length < 100 || !joined(w.segment)) continue;
    const p = w.path.sampleAt(w.path.length / 2).p;
    const lane = laneBeside(sim, p.x, p.y, w.segment);
    if (!lane || links.filter((l) => planTrip(sim, lane.lanelet, lane.at, l.id, 2)).length < links.length * 0.6) continue;
    const prev = picked[picked.length - 1];
    if (picked.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 625) && (!prev || Math.hypot(prev.x - p.x, prev.y - p.y) < 1500)) picked.push({ x: p.x, y: p.y });
    if (picked.length === 4) break;
  }
  const xs = [...doc.nodes.values()].map((n) => n.x), ys = [...doc.nodes.values()].map((n) => n.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), ym = (Math.min(...ys) + Math.max(...ys)) / 2;
  const { longestOnRoad, ALONG_ROAD } = await import('/src/world/transit.ts');
  const { onCarriageway } = await import('/src/editor/transitTools.ts');
  let yy = ym;
  for (let k = 0; k < 80; k++) {
    const y = Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * (0.3 + 0.4 * ((k * 0.618) % 1));
    if (longestOnRoad([{ x: x0 + (x1 - x0) * 0.1, y }, { x: x0 + (x1 - x0) * 0.9, y }], (q) => onCarriageway(r.net, q)) <= ALONG_ROAD) { yy = y; break; }
  }
  const at = (f) => ({ x: x0 + (x1 - x0) * f, y: yy });
  return { stops: picked, track: [at(0.1), at(0.9)], stations: [0.2, 0.5, 0.8].map(at) };
});

// The Transport tool, from the dock.
await page.locator('.v2-cat[data-cat="transit"]').click();
await page.waitForTimeout(500);
await photo('tool-open');
const tab = (label) => page.locator(`.v2-tab[title="${label}"], .v2-tab[data-tip="${label}"], .v2-tab:has-text("${label}")`).first().click();
// Bus stops, then the terminal, then the line.
await tab('Ponto de ônibus');
for (const p of plan.stops) await clickAt(p, 14);
await photo('stops', { stops: plan.stops.length });
await tab('Terminal de ônibus');
await clickAt(plan.stops[0], 14);
await tab('Criar linha');
for (const p of plan.stops) await clickAt(p, 6);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
// The train: its track, its stations, its line.
await tab('Trilho de trem');
await clickAt(plan.track[0], 3);
await clickAt(plan.track[1], 3, 2);
await tab('Estação de trem');
for (const p of plan.stations) await clickAt(p, 6);
await tab('Criar linha');
for (const p of plan.stations) await clickAt(p, 3);
await page.keyboard.press('Enter');
const made = await page.evaluate(() => { const t = window.__roadcraft.doc.transit; return { stops: t.stops.length, tracks: t.tracks.length, lines: t.lines.map((l) => [l.mode, l.stops.length]) }; });
await aim((plan.stops[0].x + plan.stops[3].x) / 2, (plan.stops[0].y + plan.stops[3].y) / 2, 3);
await photo('lines-map', made);
// A stop close up: its shelter and sign.
await aim(plan.stops[1].x, plan.stops[1].y, 30);
await photo('stop-close');
// Running: the tool put down, the city lived a while.
await page.locator('.v2-cat[data-cat="transit"]').click();
await page.evaluate(() => { window.__roadcraft.runSim(150); });
const bus = await page.evaluate(() => {
  const r = window.__roadcraft;
  for (const id of r.sim.city.transit.busIds()) { const v = r.sim.vehicles.get(id); if (v && v.v < 0.5) { const l = r.sim.lanelet(v.lanelet); const p = l.centre.sampleAt(Math.max(0, Math.min(l.length, v.s - v.archetype.length / 2))).p; return { x: p.x, y: p.y, driver: r.sim.city.transit.drivers().find((d) => d.bus === id)?.resident ?? null }; } }
  return null;
});
if (bus) {
  await aim(bus.x, bus.y, 16);
  await photo('bus-at-stop', bus);
  // Its driver: a resident of the town (the Info tool, a click on the bus).
  await page.keyboard.press('i');
  const s = await screenOf(bus);
  await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(600);
  const card = await page.evaluate(() => document.querySelector('.agent-card')?.innerText ?? null);
  await photo('bus-driver-card', { card });
}
const train = await page.evaluate(() => { const r = window.__roadcraft; for (let k = 0; k < 60; k++) { const t = r.sim.city.transit.trains().find((x) => !x.metro && x.v > 5); if (t) return t.cars[1]; r.runSim(1); } return null; });
if (train) { await aim(train.x, train.y, 10); await photo('train', train); }
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
console.log(JSON.stringify(log.map((l) => [l.name, l.lines ?? l.stops ?? ''])));
await browser.close();
