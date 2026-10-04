// Clicks on a resident agent with the inspect tool and photographs their card
// at a few steps of a car trip, then with the camera following them (`?agents=1`).
// Headless.
//
//   node scripts/agent-card-shots.mjs --base=http://127.0.0.1:4211 --town=town.json --out=dir
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4211');
const out = opt('out', 'agent-card');
const town = JSON.parse(readFileSync(opt('town', 'town.json'), 'utf8'));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
await page.addInitScript(() => {
  window.confirm = () => true;
  try { localStorage.setItem('roadcraft.sky', 'day'); localStorage.setItem('roadcraft.language', 'pt-BR'); } catch { /* blocked */ }
});
await page.goto(`${base}/?agents=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 180_000 });
await page.evaluate((data) => window.__roadcraft.loadDoc(data), town);
await page.waitForTimeout(6000);
await page.evaluate(() => { window.__roadcraft.sim.clock.paused = true; window.__roadcraft.runSim(1); });

// A car owner at home, sent somewhere 160-450 m away with a free bay near it.
const agent = await page.evaluate(() => {
  const { sim, doc } = window.__roadcraft;
  const city = sim.city;
  const cars = city.cars;
  const m = (x) => x * 2.5;
  const buildings = [...doc.buildings.all()];
  for (const car of cars.cars.values()) {
    const r = city.population.residents.find((x) => x.id === car.owner);
    const at = city.whereIs(r.id);
    const home = at === null ? null : city.doorOf(at);
    if (at !== r.home || !home) continue;
    const to = buildings.find((b) => {
      const door = city.doorOf(b.id);
      if (!door || b.id === at) return false;
      const d = Math.hypot(door.x - home.x, door.y - home.y);
      return d > m(160) && d < m(450) && cars.bays.some((bay) => bay.car === null && bay.lane && Math.hypot(bay.x - door.x, bay.y - door.y) < m(80));
    });
    if (to && city.goTo(sim, r.id, to.id) === 'drive') return { resident: r.id, car: car.id };
  }
  return null;
});
if (!agent) { console.error('no agent could be sent'); await browser.close(); process.exit(1); }

/** The agent's car on screen, with the camera brought to it first. */
const aimAtCar = (zoom) => page.evaluate(([c, zoom]) => {
  const r = window.__roadcraft;
  const { sim } = r;
  const car = [...sim.city.cars.cars.values()].find((x) => x.id === c.car);
  const v = car.body ?? sim.vehicles.get(c.car);
  const lane = car.body ? null : sim.lanelet(v.lanelet);
  const p = car.body ? { x: car.body.free.x, y: car.body.free.y } : lane.centre.sampleAt(Math.max(0, Math.min(lane.length, v.s - v.archetype.length / 2))).p;
  r.lookAt(p.x, p.y, zoom);
  const h = r.scene().surfaceHeightAt(p.x, p.y);
  const s = r.view().toScreen(p, innerWidth, innerHeight, Number.isFinite(h) ? h : 0);
  const box = document.querySelector('canvas').getBoundingClientRect();
  return { x: s.x + box.left, y: s.y + box.top };
}, [agent, zoom]);
const phase = () => page.evaluate((c) => window.__roadcraft.sim.city.cars.tripOfCar(c.car)?.phase ?? 'done', agent);
const until = async (want) => {
  for (let i = 0; i < 400 && (await phase()) !== want; i++) await page.evaluate(() => window.__roadcraft.runSim(0.5));
};

const log = [];
const shoot = async (name) => {
  await page.waitForTimeout(900);
  const text = await page.evaluate(() => document.querySelector('.agent-card')?.innerText ?? null);
  await page.screenshot({ path: `${out}/${name}.png` });
  log.push({ name, phase: await phase(), card: text });
};

// Click on the car while its owner gets in.
await until('board');
await page.evaluate(() => window.__roadcraft.runSim(1));
const at = await aimAtCar(9);
await page.waitForTimeout(1200);
await page.mouse.click(at.x, at.y);
await shoot('01-board-clicked');
// Driving, the card follows by itself.
await until('drive');
await page.evaluate(() => window.__roadcraft.runSim(4));
await aimAtCar(5);
await shoot('02-driving');
// The camera follows them.
await page.click('.agent-card-head button:nth-of-type(1)');
await page.evaluate(() => window.__roadcraft.runSim(6));
await shoot('03-following');
await until('park');
await page.evaluate(() => window.__roadcraft.runSim(2));
await shoot('04-parking');
writeFileSync(`${out}/log.json`, JSON.stringify({ agent, shots: log }, null, 1));
console.log(JSON.stringify(log, null, 1));
await browser.close();
