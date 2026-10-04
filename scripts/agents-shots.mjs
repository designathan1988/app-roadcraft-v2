// Photographs one resident agent doing a car trip from start to end (`?agents=1`):
// walking to their own parked car, getting in, backing out of the bay, driving,
// parking in a bay at the other end, getting out and walking in. Headless.
//
//   AGENT_TOWN_OUT=town.json node scripts/test-light.mjs tests/sim/agents/ownCars.spec.ts   (the town map)
//   npx vite --port 4211 --strictPort                                                     (the game, own port)
//   node scripts/agents-shots.mjs --base=http://127.0.0.1:4211 --town=town.json --out=dir [--agent=N]
//
// Writes <out>/NN-<phase>.png and <out>/log.json (phase, time, position of each shot).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4211');
const out = opt('out', 'agent-shots');
const town = JSON.parse(readFileSync(opt('town', 'town.json'), 'utf8'));
const pick = Number(opt('agent', '0'));
// Close on the person (walking, at the door), nearer the car manoeuvring, wider driving.
const ZOOM = { toCar: 11, board: 13, leave: 8, drive: 4.5, park: 8, alight: 13, fromCar: 11, done: 11 };
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
await page.addInitScript(() => { window.confirm = () => true; try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(`${base}/?agents=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 180_000 });
await page.evaluate((data) => window.__roadcraft.loadDoc(data), town);
await page.waitForTimeout(6000);
await page.evaluate(() => { window.__roadcraft.sim.clock.paused = true; window.__roadcraft.runSim(1); });

// A car owner at home, sent somewhere 160-450 m away with a free bay near it.
const chosen = await page.evaluate((pick) => {
  const { sim, doc } = window.__roadcraft;
  const city = sim.city;
  const cars = city.cars;
  const m = (x) => x * 2.5;
  const buildings = [...doc.buildings.all()];
  let n = 0;
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
    if (!to) continue;
    if (n++ < pick) continue;
    if (city.goTo(sim, r.id, to.id) !== 'drive') continue;
    const trip = [...cars.trips.values()].find((t) => t.resident === r.id);
    return { resident: r.id, trip: trip.trip, car: car.id, person: trip.person, to: to.id };
  }
  return null;
}, pick);
if (!chosen) { console.error('no agent could be sent'); await browser.close(); process.exit(1); }

const where = () => page.evaluate((c) => {
  const { sim } = window.__roadcraft;
  const cars = sim.city.cars;
  const t = cars.trips.get(c.trip);
  const car = [...cars.cars.values()].find((x) => x.id === c.car);
  const ped = sim.pedViewById.get(c.person);
  const body = car.body ?? sim.vehicles.get(c.car);
  const f = car.body?.free;
  let x, y;
  if (t && (t.phase === 'toCar' || t.phase === 'fromCar') && ped) { x = ped.x; y = ped.y; }
  else if (f) { x = f.x; y = f.y; }
  else if (body) { const lane = sim.lanelet(body.lanelet); const p = lane.centre.sampleAt(Math.min(lane.length, Math.max(0, body.s))).p; x = p.x; y = p.y; }
  else if (ped) { x = ped.x; y = ped.y; }
  const hh = x === undefined ? 0 : window.__roadcraft.scene().surfaceHeightAt(x, y);
  const scr = x === undefined ? null : window.__roadcraft.view().toScreen({ x, y }, innerWidth, innerHeight, Number.isFinite(hh) ? hh : 0);
  return { phase: t ? t.phase : 'done', stop: car.body?.kerbStop?.phase ?? null, x, y, inside: sim.city.whereIs(c.resident) === c.to,
    screen: scr ? [Math.round(scr.x), Math.round(scr.y)] : null, ped: Boolean(ped), body: Boolean(car.body), doors: car.body ? car.body.doors.join(',') : '', seats: body ? body.seats : -1 };
}, chosen);

const log = [];
let shot = 0;
let lastPhase = '';
let sinceShot = 0;
const steps = Number(opt('steps', '900'));
for (let step = 0; step < steps; step++) {
  const w = await where();
  if (w.x === undefined) break;
  const changed = w.phase + (w.stop ?? '') !== lastPhase;
  if (changed || sinceShot >= (w.phase === 'drive' ? 16 : 6)) {
    // Aimed at the ground where they are: the camera's centre is at height 0, and a
    // raised town would put them off the middle of the picture at a close zoom.
    await page.evaluate(([x, y, z]) => {
      const r = window.__roadcraft;
      r.lookAt(x, y, z);
      const h = r.scene().surfaceHeightAt(x, y);
      const c = Number.isFinite(h) ? r.view().toWorldAt(innerWidth / 2, innerHeight / 2, h) : null;
      if (c) r.lookAt(2 * x - c.x, 2 * y - c.y, z);
    }, [w.x, w.y, ZOOM[w.phase] ?? 6]);
    await page.waitForTimeout(1200);
    const name = `${String(shot).padStart(2, '0')}-${w.phase}${w.stop ? `-${w.stop}` : ''}`;
    await page.screenshot({ path: `${out}/${name}.png` });
    log.push({ name, ...(await where()), t: step * 0.5 });
    shot++;
    sinceShot = 0;
    lastPhase = w.phase + (w.stop ?? '');
  }
  if (w.phase === 'done' && w.inside) break;
  await page.evaluate(() => window.__roadcraft.runSim(0.5));
  sinceShot++;
}
writeFileSync(`${out}/log.json`, JSON.stringify({ agent: chosen, shots: log }, null, 1));
console.log(JSON.stringify({ agent: chosen, shots: log.length, last: log[log.length - 1] }));
await browser.close();
