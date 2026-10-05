// Crime in the streets as the player sees it: an afternoon in the new town; a
// robbery (the victim down, people running or looking) and the thief's card;
// an officer on foot patrol and their card; an arrest - thief and officer
// walking to the station - and the thief's card. Each scene from two sides
// (the camera turned half round), as a building may hide one. Headless.
//
//   node scripts/crime-shots.mjs --base=http://127.0.0.1:5173 --town=maps/cidade-com-estacionamento.json --out=dir
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:5173');
const out = opt('out', 'crime-shots');
const town = JSON.parse(readFileSync(opt('town', 'maps/cidade-com-estacionamento.json'), 'utf8'));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.clear(); localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 180_000 });
await page.evaluate((data) => window.__roadcraft.loadDoc(data), town);
await page.waitForTimeout(6000);
await page.evaluate(() => { const r = window.__roadcraft; r.sim.clock.paused = true; r.sim.city.skip(6 * 60); });
// An hour of play first: those who work in the afternoon get there (the police at their stations).
for (let i = 0; i < 18; i++) await page.evaluate(() => window.__roadcraft.runSim(10));
// The Info tool: a click on somebody opens their card.
await page.keyboard.press('i');

const log = [];
let shot = 0;
const B = 1 << 25;
/** The camera on a resident: centred on them on the ground. */
const aim = (resident, zoom) => page.evaluate(([id, z, B]) => {
  const r = window.__roadcraft;
  const p = r.sim.pedViewById.get(B + id);
  if (!p) return null;
  r.lookAt(p.x, p.y, z);
  const h = r.scene().surfaceHeightAt(p.x, p.y);
  const c = r.view().toWorldAt(innerWidth / 2, innerHeight / 2, h);
  r.lookAt(2 * p.x - c.x, 2 * p.y - c.y, z);
  const s = r.view().toScreen({ x: p.x, y: p.y }, innerWidth, innerHeight, h);
  const box = document.querySelector('canvas').getBoundingClientRect();
  return { x: s.x + box.left, y: s.y + box.top };
}, [resident, zoom, B]);
const turn = () => page.evaluate(() => window.__roadcraft.view().rotate(2));
/** A moment of the game running (the bodies drawn where they are), then still. */
const live = async (ms) => {
  await page.evaluate(() => { window.__roadcraft.sim.clock.paused = false; });
  await page.waitForTimeout(ms);
  await page.evaluate(() => { window.__roadcraft.sim.clock.paused = true; });
};
const photo = async (what, extra = {}) => {
  await page.waitForTimeout(500);
  const name = `${String(shot++).padStart(2, '0')}-${what}`;
  await page.screenshot({ path: `${out}/${name}.png` });
  const card = await page.evaluate(() => { const c = document.querySelector('.agent-card'); return c && !c.hidden ? c.innerText : null; });
  log.push({ name, ...extra, ...(card ? { card } : {}) });
};
/** Both sides of a resident, then a click on them for their card. */
const scene = async (what, resident, zoom, extra = {}) => {
  await aim(resident, zoom);
  await live(600);
  await aim(resident, zoom);
  await photo(`${what}-a`, extra);
  await turn();
  const s = await aim(resident, zoom);
  await page.waitForTimeout(300);
  await photo(`${what}-b`, extra);
  if (s) { await page.mouse.click(s.x, s.y); await photo(`${what}-card`, extra); }
  await turn();
};
/** The game run on until a condition holds (checked every quarter second of play), at most `seconds`. */
const until = (test, seconds) => page.evaluate(async ([test, seconds]) => {
  const r = window.__roadcraft;
  const ok = new Function('r', `return (${test})(r);`);
  for (let t = 0; t < seconds; t += 0.25) {
    const got = ok(r);
    if (got) return got;
    r.runSim(0.25);
    if (Math.round(t * 4) % 40 === 0) await new Promise((res) => setTimeout(res, 0));
  }
  return null;
}, [test.toString(), seconds]);

// 1. An officer on the beat (before the afternoon's crimes take them all).
const patrol = await until((r) => { const c = r.sim.city.crime; const id = [...c.patrols.keys()][0]; return id === undefined ? null : { officer: id }; }, 120);
if (patrol) await scene('patrol', patrol.officer, 30, patrol);
// 2. A robbery, just done: the victim down.
const robbery = await until((r) => {
  const c = r.sim.city.crime;
  for (const x of c.crimes.values()) if (x.phase === 'fleeing' && x.time < 0.6) return { thief: x.thief, victim: x.victim - (1 << 25) };
  return null;
}, 400);
if (robbery) await scene('robbery', robbery.victim, 30, robbery);
// 3. An arrest: thief and officer walking to the station.
const arrest = await until((r) => {
  const c = r.sim.city.crime;
  for (const x of c.crimes.values()) if (x.phase === 'arrested' && x.time > 2) return { thief: x.thief, officer: [...x.officers.keys()][0] };
  return null;
}, 700);
if (arrest) await scene('arrest', arrest.thief, 30, arrest);
const stats = await page.evaluate(() => window.__roadcraft.sim.city.crime.stats);
log.push({ name: 'stats', ...stats });
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
console.log(JSON.stringify(log.map((l) => [l.name, l.card?.split('\n').slice(0, 2).join(' / ') ?? ''])));
await browser.close();
