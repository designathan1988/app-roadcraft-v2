// CPU and network profile from navigation until the game exposes its running scene.
// Run against a production preview: node scripts/probe-startup-profile.mjs --base=http://127.0.0.1:4181
import { chromium } from '@playwright/test';
import { SourceMap } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = (process.argv.find((arg) => arg.startsWith('--base=')) ?? '--base=http://127.0.0.1:4181').slice(7);
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error.message)));
await page.addInitScript(() => {
  globalThis.__roadcraftLongTasks = [];
  new globalThis.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) globalThis.__roadcraftLongTasks.push({ at: entry.startTime, ms: entry.duration });
  }).observe({ entryTypes: ['longtask'] });
});
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
await cdp.send('Profiler.start');
const started = Date.now();
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(globalThis.window.__roadcraft), null, { timeout: 120_000 });
const readyMs = Date.now() - started;
const { profile } = await cdp.send('Profiler.stop');
const timing = await page.evaluate(() => {
  const nav = globalThis.performance.getEntriesByType('navigation')[0];
  const resources = globalThis.performance.getEntriesByType('resource')
    .map((entry) => ({ name: entry.name.split('/').pop(), ms: Math.round(entry.duration),
      transferKB: Math.round(entry.transferSize / 1024), decodedKB: Math.round(entry.decodedBodySize / 1024) }));
  const longTasks = globalThis.__roadcraftLongTasks;
  return { domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd), loadMs: Math.round(nav.loadEventEnd),
    resourceCount: resources.length, transferredMB: +(resources.reduce((sum, entry) => sum + entry.transferKB, 0) / 1024).toFixed(1),
    resources: resources.sort((a, b) => b.transferKB - a.transferKB).slice(0, 12),
    longTasks: { count: longTasks.length, totalMs: Math.round(longTasks.reduce((sum, entry) => sum + entry.ms, 0)),
      largest: longTasks.sort((a, b) => b.ms - a.ms).slice(0, 10).map((task) => ({ at: Math.round(task.at), ms: Math.round(task.ms) })) } };
});
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const hits = new Map();
for (const id of profile.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
const maps = new Map();
const original = (call) => {
  if (!call?.url) return null;
  const file = call.url.split('/').pop();
  if (!file?.endsWith('.js')) return null;
  const path = join('dist', 'assets', `${file}.map`);
  if (!existsSync(path)) return null;
  let map = maps.get(path);
  if (!map) { map = new SourceMap(JSON.parse(readFileSync(path, 'utf8'))); maps.set(path, map); }
  const entry = map.findEntry(call.lineNumber, call.columnNumber);
  return entry.originalSource ? { file: entry.originalSource.replace('../../', ''), line: entry.originalLine + 1 } : null;
};
const hot = [...hits].map(([id, count]) => {
  const call = nodes.get(id)?.callFrame;
  return { samples: count, name: call?.functionName || '(anonymous)', file: call?.url.split('/').pop(),
    line: (call?.lineNumber ?? -1) + 1, column: (call?.columnNumber ?? -1) + 1, source: original(call) };
}).sort((a, b) => b.samples - a.samples).slice(0, 25);
const bySource = new Map();
for (const [id, count] of hits) {
  const source = original(nodes.get(id)?.callFrame);
  if (!source) continue;
  const key = `${source.file}:${source.line}`;
  bySource.set(key, (bySource.get(key) ?? 0) + count);
}
const hotSources = [...bySource].sort((a, b) => b[1] - a[1]).slice(0, 30)
  .map(([source, samples]) => ({ source, samples }));
const phaseSources = [new Map(), new Map()];
let elapsedMs = 0;
for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
  elapsedMs += (profile.timeDeltas?.[i] ?? 0) / 1000;
  const source = original(nodes.get(profile.samples[i])?.callFrame);
  if (!source) continue;
  const key = `${source.file}:${source.line}`;
  const phase = phaseSources[elapsedMs < timing.domContentLoadedMs ? 0 : 1];
  phase.set(key, (phase.get(key) ?? 0) + 1);
}
const hotPhases = phaseSources.map((phase) => [...phase].sort((a, b) => b[1] - a[1]).slice(0, 20)
  .map(([source, samples]) => ({ source, samples })));
console.log(JSON.stringify({ readyMs, ...timing, hotPhases, hotSources, hot, errors }, null, 2));
await browser.close();
