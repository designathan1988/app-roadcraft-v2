// Photographs the map at a range of zooms, from street level to the whole map
// as a globe (`src/render/globe.ts`). Headless.
//
//   node scripts/globe-shots.mjs --base=http://127.0.0.1:4211 --out=dir [--map=map.json]
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const opt = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const base = opt('base', 'http://127.0.0.1:4211');
const out = opt('out', 'globe-shots');
const mapFile = opt('map', '');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
await page.addInitScript(() => { try { localStorage.setItem('roadcraft.sky', 'day'); } catch { /* blocked */ } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 180_000 });
if (mapFile) await page.evaluate((d) => window.__roadcraft.loadDoc(d), JSON.parse(readFileSync(mapFile, 'utf8')));
await page.waitForTimeout(5000);
// Visible half heights, world units: street, district, town, the whole globe.
for (const half of [150, 600, 1200, 2200]) {
  await page.evaluate((half) => window.__roadcraft.lookAt(0, 0, innerHeight / (2 * half)), half);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/half-${half}.png` });
}
await browser.close();
