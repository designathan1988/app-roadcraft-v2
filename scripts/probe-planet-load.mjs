// CPU profile of the planet's boot on the dev server (function names, by file), and the JS heap once ready.
// node scripts/probe-planet-load.mjs --base=http://127.0.0.1:5175
import { chromium } from '@playwright/test';

const base = (process.argv.find((arg) => arg.startsWith('--base=')) ?? '--base=http://127.0.0.1:5175').slice(7);
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error.message)));
// A probe must never trap the player's real mouse.
await page.addInitScript(() => { Element.prototype.requestPointerLock = function () { return Promise.resolve(); }; });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
await cdp.send('Profiler.start');
const started = Date.now();
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(globalThis.window.__roadcraft), null, { timeout: 180_000 });
const exposedMs = Date.now() - started;
await page.waitForFunction(() => (globalThis.window.__roadcraft?.scene().stats.rebuilds ?? 0) > 0, null, { timeout: 180_000 });
const readyMs = Date.now() - started;
const { profile } = await cdp.send('Profiler.stop');
await cdp.send('HeapProfiler.collectGarbage');
const heapMB = await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1e6));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
const key = (id) => {
  const c = nodes.get(id)?.callFrame;
  if (!c) return null;
  const file = (c.url.split('/src/')[1] ?? c.url.split('/').pop() ?? '').split('?')[0];
  return `${c.functionName || '(anon)'} ${file}`;
};
const self = new Map(), incl = new Map();
for (const id of profile.samples ?? []) {
  const k = key(id);
  self.set(k, (self.get(k) ?? 0) + 1);
  const seen = new Set();
  for (let at = id; at !== undefined; at = parents.get(at)) {
    const kk = key(at);
    if (!kk || seen.has(kk)) continue;
    seen.add(kk);
    incl.set(kk, (incl.get(kk) ?? 0) + 1);
  }
}
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${String(v).padStart(6)} ms  ${k}`);
console.log(JSON.stringify({ exposedMs, readyMs, heapMB, errors }, null, 1));
console.log('--- self'); console.log(top(self, 30).join('\n'));
console.log('--- inclusive'); console.log(top(incl, 60).join('\n'));
await browser.close();
