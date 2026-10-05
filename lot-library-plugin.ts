import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * The lot library of the lot lab (`?lab=lots`, `src/ui/lotLab.ts`): lots the
 * player generated and edited, kept as one JSON file each in `lots/`.
 *
 * Development only:
 * - `GET /__lots` lists them (`[{ name, use, density, savedAt }]`);
 * - `GET /__lots/<name>` reads one;
 * - `PUT /__lots/<name>` writes one (the body is the template's JSON);
 * - `DELETE /__lots/<name>` removes one.
 */
const DIR = 'lots';

const safeName = (raw: string): string | null => {
  const name = decodeURIComponent(raw).trim();
  return /^[\p{L}\p{N} _.-]{1,80}$/u.test(name) && !name.includes('..') ? name : null;
};

export function lotLibraryPlugin(): Plugin {
  const root = process.cwd();
  const dir = path.join(root, DIR);
  return {
    name: 'roadcraft-lot-library',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        if (url !== '/__lots' && !url.startsWith('/__lots/')) { next(); return; }
        const send = (code: number, body?: unknown): void => {
          res.statusCode = code;
          if (body === undefined) { res.end(); return; }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(JSON.stringify(body));
        };
        if (url === '/__lots') {
          if (req.method !== 'GET') { send(405); return; }
          const list = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
              try {
                const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
                return { name: f.slice(0, -5), use: t['use'], density: t['density'], savedAt: t['savedAt'] };
              } catch {
                return null;
              }
            }).filter((x) => x !== null)
            : [];
          send(200, list);
          return;
        }
        const name = safeName(url.slice('/__lots/'.length));
        if (!name) { send(400); return; }
        const file = path.join(dir, `${name}.json`);
        if (req.method === 'GET') {
          if (!fs.existsSync(file)) { send(404); return; }
          send(200, JSON.parse(fs.readFileSync(file, 'utf8')));
          return;
        }
        if (req.method === 'DELETE') {
          if (fs.existsSync(file)) fs.unlinkSync(file);
          send(204);
          return;
        }
        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
              send(204);
            } catch {
              send(400);
            }
          });
          return;
        }
        send(405);
      });
    },
  };
}
