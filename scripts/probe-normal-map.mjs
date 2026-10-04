// Measure procedural normal-map baking and hash its actual canvas pixels.
// Run against Vite dev: node scripts/probe-normal-map.mjs --base=http://127.0.0.1:4190
import { chromium } from '@playwright/test';

const base = (process.argv.find((arg) => arg.startsWith('--base=')) ?? '--base=http://127.0.0.1:4190').slice(7);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto(base, { waitUntil: 'domcontentloaded' });
const result = await page.evaluate(async () => {
  const { normalMapFrom } = await import('/src/render/mesh/textureBaker.ts');
  const rows = [];
  for (const size of [1, 2, 7, 512, 1024]) {
    const height = new Float32Array(size * size);
    for (let i = 0; i < height.length; i++) height[i] = Math.sin(i * 0.12431) * 0.5 + 0.5;
    const times = [];
    let canvas;
    for (let repeat = 0; repeat < 5; repeat++) {
      const start = globalThis.performance.now();
      canvas = normalMapFrom(height, size, 2.1);
      times.push(globalThis.performance.now() - start);
    }
    const pixels = canvas.getContext('2d').getImageData(0, 0, size, size).data;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', pixels);
    rows.push({ size, medianMs: +times.sort((a, b) => a - b)[2].toFixed(2),
      hash: Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('') });
  }
  return rows;
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
