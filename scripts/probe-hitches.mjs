// Where the game stalls while it is played: roads drawn with the real road
// tool while the cars and people of the panel run. For every frame over 50 ms
// it prints what the frame did on the GPU side (programs linked, bytes of
// textures and buffers uploaded, synchronous reads) and the JavaScript that
// ran in it (Chrome's JS Self-Profiling API), plus every single GL upload
// over a few MB with the code that made it. The log of findings is
// docs/performance.md.
//
//   node scripts/probe-hitches.mjs [--base=http://localhost:5173] [--cars=10] [--people=10] [--roads=8] [--settle=20000] [--town]
//
// A dev server must be running (it sends the Document-Policy header the
// profiler needs). Headless Chrome here renders on the Intel iGPU: compare
// its numbers only with each other. About two minutes, foreground.
/* global Element, WebGL2RenderingContext -- used inside the page (addInitScript) */
import { chromium } from '@playwright/test';
import { constants, setPriority } from 'node:os';

// Low priority, before Chrome is launched (its processes inherit it): this
// machine is the one the game is played on, and a cook or probe at normal
// priority took the CPU to 100% and froze it (2026-10-06).
try { setPriority(0, constants.priority.PRIORITY_LOW); } catch { /* not allowed here: run as is */ }

const opt = (n, f) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${f}`).slice(n.length + 3);
const BASE = opt('base', 'http://localhost:5173');
const CARS = Number(opt('cars', '10'));
const PEOPLE = Number(opt('people', '10'));
const ROADS = Number(opt('roads', '8'));
const IDLE = Number(opt('idle', '6000'));
const SETTLE = Number(opt('settle', '20000'));
// --town: the game's default town (761 buildings, `world/defaultTown.ts`), and
// short roads drawn inside it: what a local edit costs on a real map.
const TOWN = process.argv.includes('--town');

const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1280,840'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text().slice(0, 300)}`); });

await page.addInitScript(() => {
  window.confirm = () => true;
  // A headless pointer lock still clips the player's real mouse.
  Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
  const fresh = () => ({ link: 0, tex: 0, buf: 0, sync: 0, syncMs: 0, glMs: 0, uploads: [] });
  const probe = { frame: fresh(), big: [] };
  window.__hitch = probe;
  const where = () => new Error().stack.split('\n').slice(3, 10)
    .map((l) => l.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//, '').replace(/\?[^:)]*/, '')).join(' < ');
  // The bytes a call sends: a ranged call (`bufferSubData(target, offset,
  // data, srcOffset, length)`, three's `addUpdateRange`) sends `length`
  // elements, not the whole array. A ranged texture call is counted whole
  // (its texel size is not in the arguments): an upper bound.
  const bytes = (args) => {
    const at = args.findIndex((x) => x && typeof x === 'object' && x.byteLength !== undefined);
    if (at < 0) return 0;
    const data = args[at];
    const length = args[at + 2];
    return typeof length === 'number' && length > 0 && data.BYTES_PER_ELEMENT ? length * data.BYTES_PER_ELEMENT : data.byteLength;
  };
  const proto = WebGL2RenderingContext.prototype;
  const wrap = (name, after) => {
    const original = proto[name];
    if (!original) return;
    proto[name] = function (...args) {
      const t = performance.now();
      const result = original.apply(this, args);
      const ms = performance.now() - t;
      probe.frame.glMs += ms;
      after(args, ms);
      return result;
    };
  };
  wrap('linkProgram', () => { probe.frame.link++; });
  for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D']) {
    wrap(name, (args, ms) => {
      const b = bytes(args);
      probe.frame.tex += b;
      if (b > 1e6) probe.frame.uploads.push([b, `${name} ${args.filter((x) => typeof x === 'number').slice(2, 6).join('x')} ${where().split(' < ').slice(0, 3).join(' < ')}`]);
      if (b > 8e6 || ms > 15) probe.big.push(`${name} ${(b / 1e6).toFixed(1)} MB ${ms.toFixed(1)} ms  ${where()}`);
    });
  }
  for (const name of ['bufferData', 'bufferSubData']) {
    wrap(name, (args, ms) => {
      const b = bytes(args);
      probe.frame.buf += b;
      if (b > 65536) probe.frame.uploads.push([b, `${name} ${where().split(' < ').slice(2, 6).join(' < ')}`]);
      if (b > 2e6 || ms > 10) probe.big.push(`${name} ${(b / 1e6).toFixed(1)} MB ${ms.toFixed(1)} ms  ${where()}`);
    });
  }
  for (const name of ['getProgramParameter', 'getShaderParameter', 'readPixels', 'getError', 'finish', 'clientWaitSync']) {
    wrap(name, (_args, ms) => { probe.frame.sync++; probe.frame.syncMs += ms; });
  }

  window.__profile = async (ms) => {
    const profiler = new Profiler({ sampleInterval: 1, maxBufferSize: 1_000_000 });
    const spans = [];
    let last = performance.now();
    const t0 = last;
    await new Promise((done) => {
      const f = () => {
        const t = performance.now();
        spans.push([last, t, probe.frame]);
        probe.frame = fresh();
        last = t;
        if (t - t0 < ms) requestAnimationFrame(f); else done();
      };
      requestAnimationFrame(f);
    });
    const trace = await profiler.stop();
    const label = (id) => {
      const f = trace.frames[id];
      const file = f.resourceId !== undefined ? trace.resources[f.resourceId].split('/').pop().split('?')[0] : '';
      return `${f.name || '(anon)'} @${file}:${f.line ?? ''}`;
    };
    const js = (from, to, rows) => {
      const inclusive = new Map();
      for (const s of trace.samples) {
        if (s.timestamp < from || s.timestamp > to || s.stackId === undefined) continue;
        let st = trace.stacks[s.stackId];
        const seen = new Set();
        while (st) {
          const k = label(st.frameId);
          if (!seen.has(k)) { inclusive.set(k, (inclusive.get(k) ?? 0) + 1); seen.add(k); }
          st = st.parentId !== undefined ? trace.stacks[st.parentId] : null;
        }
      }
      return [...inclusive].sort((a, b) => b[1] - a[1]).slice(0, rows).map(([k, v]) => `${v} ${k}`);
    };
    const frames = spans.slice(1);
    const d = frames.map(([a, b]) => b - a).sort((a, b) => a - b);
    const at = (q) => +d[Math.min(d.length - 1, Math.floor(d.length * q))].toFixed(1);
    return {
      frames: d.length, median: at(0.5), p95: at(0.95), worst: at(1),
      over50: d.filter((x) => x > 50).length, over100: d.filter((x) => x > 100).length,
      js: js(t0, last, 25),
      long: frames.filter(([a, b]) => b - a > 50).map(([a, b, g]) => ({
        ms: Math.round(b - a),
        gl: `link=${g.link} tex=${(g.tex / 1e6).toFixed(1)}MB buf=${(g.buf / 1e6).toFixed(1)}MB sync=${g.sync}/${g.syncMs.toFixed(1)}ms gl=${g.glMs.toFixed(1)}ms`,
        js: js(a, b, 6),
        uploads: (() => {
          const by = new Map();
          for (const [n, w] of g.uploads) { const e = by.get(w) ?? [0, 0]; e[0] += n; e[1]++; by.set(w, e); }
          return [...by].sort((x, y) => y[1][0] - x[1][0]).slice(0, 3).map(([w, [n, k]]) => `${(n / 1e6).toFixed(0)} MB in ${k}: ${w}`);
        })(),
      })),
    };
  };
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => Boolean(window.__roadcraft), null, { timeout: 90_000 });
} catch {
  console.log('the game did not start', errors.slice(0, 8));
  process.exit(1);
}
await page.waitForTimeout(6000);
if (TOWN) {
  await page.evaluate(async () => {
    const { RoadDoc } = await import('/src/world/doc.ts');
    const { buildDefaultTown } = await import('/src/world/defaultTown.ts');
    const doc = new RoadDoc();
    buildDefaultTown(doc);
    window.__roadcraft.loadDoc(doc.toJSON());
    window.__roadcraft.lookAt(0, 0, 3);
  });
  await page.waitForTimeout(20000);
}
await page.evaluate(([cars, people]) => {
  const R = window.__roadcraft;
  R.sim.trafficCount = cars;
  R.sim.pedestrianCount = people;
  R.setTraffic(true);
  R.sim.clock.paused = false;
}, [CARS, PEOPLE]);
await page.waitForTimeout(3000);
const status = () => page.evaluate(() => `${document.body.innerText.split('\n').slice(1, 3).join(' | ')} | segments=${window.__roadcraft.doc.segments.size}`);
const report = (label, r) => {
  console.log(`\n== ${label}: ${r.frames} frames, median ${r.median} ms, p95 ${r.p95}, worst ${r.worst}, >50 ms ${r.over50}, >100 ms ${r.over100}`);
  console.log('   JS samples:', r.js.slice(0, 18).join('\n               '));
  for (const f of r.long) {
    console.log(`   ${f.ms} ms  ${f.gl}\n        ${f.js.join(' | ')}`);
    for (const u of f.uploads) console.log(`        upload ${u}`);
  }
};
console.log('start', await status());
report('idle, empty map', await page.evaluate((ms) => window.__profile(ms), IDLE));

// A grid of roads, each drawn as the player draws one: two clicks, Escape.
const profiling = page.evaluate((ms) => window.__profile(ms), 3000 + ROADS * 1500);
await page.waitForTimeout(300);
for (let i = 0; i < ROADS; i++) {
  const k = i >> 1;
  const [[x0, y0], [x1, y1]] = TOWN
    ? [[300 + (i % 4) * 180, 200 + (i >> 2) * 220], [420 + (i % 4) * 180, 260 + (i >> 2) * 220]]
    : i % 2 ? [[180 + k * 220, 90], [180 + k * 220, 640]] : [[100, 120 + k * 160], [1180, 120 + k * 160]];
  await page.evaluate(() => document.querySelector('.tool[data-tool="road"]')?.click());
  await page.waitForTimeout(150);
  await page.mouse.move(x0, y0, { steps: 3 }); await page.mouse.down(); await page.mouse.up();
  await page.mouse.move(x1, y1, { steps: 25 }); await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
}
report('drawing roads, traffic and people arriving', await profiling);
console.log('after roads', await status());
await page.waitForTimeout(SETTLE);
console.log('settled', await status());
report('roads drawn, traffic running', await page.evaluate((ms) => window.__profile(ms), IDLE));
console.log('\n== timed steps over 8 ms (performance.measure: hitch:*, person-*)');
for (const line of await page.evaluate(() => performance.getEntriesByType('measure')
  .filter((e) => (e.name.startsWith('hitch:') || e.name.startsWith('person-')) && e.duration > 8)
  .map((e) => `${e.duration.toFixed(0).padStart(5)} ms  at ${(e.startTime / 1000).toFixed(1)} s  ${e.name}`))) console.log(line);
console.log('\n== single GL uploads over 8 MB (textures) / 2 MB (buffers) or slow');
for (const line of await page.evaluate(() => window.__hitch.big)) console.log('  ', line);
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await browser.close();
