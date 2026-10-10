import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const kinds = ['signal', 'traffic', 'transit', 'material', 'animation', 'sound'];
const paths = new Set(kinds.map(kind => `/${kind}-system.html`));
const port = Number(process.env.STUDIO_PORT ?? 5196);
createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (path === '/') { response.writeHead(302, { Location: '/signal-system.html' }); response.end(); return; }
  if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  if (!paths.has(path)) { response.writeHead(404); response.end('Studio not found.'); return; }
  try { const data = await readFile(fileURLToPath(new URL(path.slice(1), root))); response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(data); }
  catch (error) { console.error(error); response.writeHead(500); response.end('Build the studios with node scripts/build-studios.mjs.'); }
}).listen(port, '127.0.0.1', () => console.log(`Studios: http://127.0.0.1:${port}/signal-system.html`));
