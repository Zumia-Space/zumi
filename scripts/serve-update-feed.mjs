#!/usr/bin/env node
// A LOCAL static update feed for tests (T-31 auto-update): what the VPS nginx location will serve later, on
// 127.0.0.1 only. Same caching rules as the planned feed: latest.yml is revalidated on every request (no-cache);
// every other file is versioned and immutable. GET/HEAD only; single byte ranges answer 206 (electron-updater's
// differential download asks several ranges at once: those get the whole file with 200, so the client falls back to
// a full download, which is the fallback path the spec wants exercised; real multi-range is nginx's job).
//   node scripts/serve-update-feed.mjs <feed dir> [--port 47821]
// Used by scripts/check-updater.mjs (Node), scripts/box-e2e-update.mjs and scripts/box-e2e-tauri-update.mjs (render box).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = { '.json': 'application/json; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream', '.md': 'text/markdown; charset=utf-8' };

/** @returns {{ port: () => Promise<number>, close: () => Promise<void>, hits: Array<{ method: string, path: string, status: number, range?: string }> }} */
export function createFeedServer({ dir, port = 0, host = '127.0.0.1' }) {
  const root = path.resolve(dir);
  const hits = [];
  const server = http.createServer((req, res) => {
    const done = (status, headers = {}, body = null) => { hits.push({ method: req.method, path: req.url, status, ...(req.headers.range ? { range: req.headers.range } : {}) }); res.writeHead(status, headers); res.end(body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return done(405, { Allow: 'GET, HEAD' });
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\/+/, ''); } catch { return done(400); }
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return done(404);
    const size = fs.statSync(file).size;
    const headers = {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': ['latest.yml', 'latest.json'].includes(path.basename(file)) ? 'no-cache' : 'public, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] !== '' || range[2] !== '')) {
      const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start > end || start >= size) return done(416, { 'Content-Range': `bytes */${size}` });
      const body = req.method === 'HEAD' ? null : fs.readFileSync(file).subarray(start, end + 1);
      return done(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 }, body);
    }
    return done(200, { ...headers, 'Content-Length': size }, req.method === 'HEAD' ? null : fs.readFileSync(file));
  });
  const ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    async port() { await ready; return server.address().port; },
    close() { return new Promise((resolve) => server.close(() => resolve())); },
    hits,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
  const portAt = args.indexOf('--port');
  if (!dir) { console.error('usage: node scripts/serve-update-feed.mjs <feed dir> [--port 47821]'); process.exit(2); }
  const s = createFeedServer({ dir, port: portAt >= 0 ? Number(args[portAt + 1]) : 47821 });
  s.port().then((p) => console.log(`update feed: http://127.0.0.1:${p}/ -> ${path.resolve(dir)}`));
  const report = () => { for (const h of s.hits.splice(0)) console.log(`${h.status} ${h.method} ${h.path}${h.range ? ` range=${h.range}` : ''}`); };
  setInterval(report, 1000).unref();
  process.on('SIGINT', () => { report(); s.close().then(() => process.exit(0)); });
}
