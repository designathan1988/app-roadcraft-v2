// Renders an SVG file to a PNG (headless), so a plan drawn by a probe can be looked at.
//
//   node scripts/svg-to-png.mjs in.svg out.png [size]
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [input, output, size = '1000'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: Number(size), height: Number(size) } });
await page.setContent(`<body style="margin:0">${readFileSync(input, 'utf8')}</body>`);
await page.screenshot({ path: output });
await browser.close();
