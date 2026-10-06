// Runs scenarios in the weapons lab (`src/weaponsLab.ts`, `?lab=armas`) in
// headless Chrome and writes, for each: frames of the screen (a screencast,
// every other frame), the probes' log and a summary; and one report of every
// scenario's problems (a body under the ground or inside a wall, bones off
// their lengths, a mesh stretched or scaled).
//
//   node scripts/weapons-lab.mjs [--base=http://127.0.0.1:5173] [--out=<dir>] [--only=<name,...>] [--frames]
//
// The dev server must be running. Low priority, one browser.
import { constants, setPriority, tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

try { setPriority(0, constants.priority.PRIORITY_LOW); } catch { /* not allowed here: run as is */ }
const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = arg('base', 'http://127.0.0.1:5173');
const out = arg('out', join(tmpdir(), 'weapons-lab'));
const only = arg('only', '').split(',').filter(Boolean);
const keepFrames = process.argv.includes('--frames');

/**
 * Each scenario: where the person stands, then steps - `shoot` a part from a
 * side, `body` a shot at the body on the ground, `bomb` at a distance,
 * `wait` milliseconds, `speed`, `watchers`.
 */
const SCENARIOS = [
  { name: 'flinch-torso', spot: 'footway', steps: [['shoot', 'torso', 'front'], ['wait', 3500]] },
  { name: 'flinch-arm', spot: 'footway', steps: [['shoot', 'armL', 'left'], ['wait', 3500]] },
  { name: 'flinch-leg', spot: 'footway', steps: [['shoot', 'legR', 'front'], ['wait', 3500]] },
  { name: 'down-second', spot: 'footway', steps: [['shoot', 'torso', 'front'], ['wait', 600], ['shoot', 'torso', 'front'], ['wait', 5000]] },
  { name: 'head-front', spot: 'footway', steps: [['shoot', 'head', 'front'], ['wait', 4500]] },
  { name: 'head-back', spot: 'footway', steps: [['shoot', 'head', 'back'], ['wait', 4500]] },
  { name: 'leg-off', spot: 'footway', steps: [['shoot', 'legL', 'front'], ['wait', 400], ['shoot', 'legL', 'front'], ['wait', 6000]] },
  { name: 'arm-off', spot: 'footway', steps: [['shoot', 'armR', 'right'], ['wait', 400], ['shoot', 'armR', 'right'], ['wait', 5000]] },
  { name: 'kerb', spot: 'kerb', steps: [['shoot', 'head', 'obstacle'], ['wait', 4500]] },
  { name: 'road', spot: 'road', steps: [['shoot', 'head', 'front'], ['wait', 4500]] },
  { name: 'slope', spot: 'bank', steps: [['shoot', 'head', 'back'], ['wait', 5000]] },
  { name: 'wall', spot: 'wall', steps: [['shoot', 'head', 'obstacle'], ['wait', 4500]] },
  { name: 'pole', spot: 'pole', steps: [['shoot', 'head', 'obstacle'], ['wait', 4500]] },
  { name: 'bench', spot: 'bench', steps: [['shoot', 'head', 'obstacle'], ['wait', 4500]] },
  { name: 'tree', spot: 'tree', steps: [['shoot', 'head', 'obstacle'], ['wait', 4500]] },
  { name: 'car', spot: 'car', steps: [['shoot', 'head', 'obstacle'], ['wait', 4500]] },
  { name: 'corpse', spot: 'footway', steps: [['shoot', 'head', 'front'], ['wait', 3000],
    ...Array.from({ length: 14 }, (_, i) => [['body', ['torso', 'armL', 'armR', 'legL', 'legR', 'head'][i % 6], 'front'], ['wait', 250]]).flat(), ['wait', 3000]] },
  { name: 'bomb-near', spot: 'footway', steps: [['bomb', 1], ['wait', 5000]] },
  { name: 'bomb-mid', spot: 'footway', steps: [['bomb', 3], ['wait', 6000]] },
  { name: 'bomb-far', spot: 'footway', steps: [['bomb', 7], ['wait', 6000]] },
  { name: 'bomb-wall', spot: 'wall', steps: [['bomb', 3, 'front'], ['wait', 6000]] },
  { name: 'witnesses', spot: 'footway', steps: [['watchers', 6], ['wait', 1500], ['shoot', 'torso', 'front'], ['wait', 5000]] },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Pointer lock in a headless page traps the real mouse on this machine.
await page.addInitScript(() => { Element.prototype.requestPointerLock = function () { return Promise.resolve(); }; });
await page.goto(`${base}/?lab=armas`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(globalThis.__weaponsLab), null, { timeout: 120_000 });
await page.waitForTimeout(5000);
const cdp = await page.context().newCDPSession(page);
mkdirSync(out, { recursive: true });

const report = [];
// The dev server reloads the page when a file changes (another session at
// work): each scenario waits for the lab, and runs again once if the page
// went away under it.
const ready = async () => {
  await page.waitForFunction(() => Boolean(globalThis.__weaponsLab), null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
};
let reloads = 0;
// A real reload (not the map's own address changes, which are same-document).
page.on('load', () => { reloads++; });
for (const sc of SCENARIOS) {
  if (only.length && !only.includes(sc.name)) continue;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = reloads;
    try {
      await ready();
      await runScenario(sc);
      if (reloads === before) break;
    } catch (e) {
      if (attempt === 2) throw e;
    }
    console.log(`${sc.name}: page reloaded, again`);
  }
}

async function runScenario(sc) {
  const dir = join(out, sc.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await page.evaluate((spot) => { const L = globalThis.__weaponsLab; L.setSpeed(1); L.clear(); L.spawn(spot); }, sc.spot);
  await page.waitForTimeout(2500);
  let n = 0;
  const t0 = Date.now();
  const onFrame = async (f) => {
    if (keepFrames && n % 2 === 0) writeFileSync(join(dir, `f${String(n).padStart(4, '0')}-${Date.now() - t0}.jpg`), Buffer.from(f.data, 'base64'));
    n++;
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  };
  cdp.on('Page.screencastFrame', onFrame);
  const results = [];
  try {
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70 });
  await page.evaluate(() => globalThis.__weaponsLab.record(true));
  for (const [what, a, b] of sc.steps) {
    if (what === 'wait') { await page.waitForTimeout(a); continue; }
    results.push([what, a, await page.evaluate(([w, a, b]) => {
      const L = globalThis.__weaponsLab;
      const r = w === 'shoot' ? L.shoot(a, b) : w === 'body' ? L.shootBody(a, b) : w === 'bomb' ? L.bomb(a, 5, b)
        : w === 'speed' ? L.setSpeed(a) : w === 'watchers' ? L.bystanders(a) : null;
      return r ?? null;
    }, [what, a, b])]);
  }
  await page.evaluate(() => globalThis.__weaponsLab.record(false));
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => {});
    cdp.off('Page.screencastFrame', onFrame);
  }
  await page.screenshot({ path: join(dir, 'end.png') });
  const { summary, log } = await page.evaluate(() => ({ summary: globalThis.__weaponsLab.summary(), log: globalThis.__weaponsLab.log() }));
  writeFileSync(join(dir, 'log.json'), JSON.stringify(log));
  report.splice(0, report.length, ...report.filter((r) => r.name !== sc.name), { name: sc.name, spot: sc.spot, results, summary });
  console.log(sc.name.padEnd(14), JSON.stringify(summary));
}
writeFileSync(join(out, 'report.json'), JSON.stringify({ base, when: new Date().toISOString(), report, errors }, null, 1));
console.log(`report: ${join(out, 'report.json')}`, errors.length ? `page errors: ${errors.slice(0, 3).join(' | ')}` : '');
await browser.close();
