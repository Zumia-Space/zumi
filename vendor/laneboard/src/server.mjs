#!/usr/bin/env node
// HTTP wrapper around the board. No dependencies.
//   GET  /                     web UI (public/)
//   GET  /schema/v1/*.json     published JSON Schemas
//   GET  /api/v1/state         board view (anonymous: public records only)
//   GET  /api/stats            the board's task-statistics document (derived data in <data>/stats.json, never journaled), same audience as /api/state (a reporter token is 403)
//   GET  /api/v1/turns         one lane's turn reports, quick + detail, newest first (?lane=, ?limit=1..50); /api/v1/state?v=2 adds the latest quick per lane
//   GET  /api/v1/quota         the Claude-account quota document (side file <data>/quota.json; any signed-in token; 200 + empty when not published, 503 when the file is bad)
//   GET  /api/v1/whoami        who the bearer token is
//   GET  /api/v1/events        audit journal (owner, coordinator; ?after, ?limit, ?task=ID for one task); with Accept: text/event-stream a live
//                              stream of owner signals (?since=evt-N or Last-Event-ID, ?types=feedback,answer,ask)
//   GET  /api/v1/tokens        token list without secrets (owner)
//   GET  /api/v1/media/:id     attachment bytes; honours Range (206/416) so audio and video can seek; ?w=480|1600 asks
//                              for a size-reduced WebP copy of an image (made once with ImageMagick, else the original)
//   GET  /api/v1/media/:id/link  short-lived URL for <video>/<audio> (bearer tokens never go into URLs)
//   POST /api/v1/write         the only mutation endpoint for records
//   POST /api/v1/upload        streamed attachment upload (raw body, owner/coordinator), journaled as attachment.add
//   GET  /healthz              {ok, seq, release}: release = the deployed commit, from RELEASE in the code dir (else 'unknown')
// BOARD_PREVIEW_READONLY=1: a read-only preview (e.g. a new UI on a copy of the data). Every request other than
// GET/HEAD — v1 writes, uploads, the compat admin routes, anything — is refused 403 {error:'preview_readonly'} before
// any handler runs; the state says config.read_only (+ config.main_url, BOARD_PREVIEW_MAIN_URL) so the page shows a
// banner and turns its write controls off. BOARD_LEGACY_MEDIA_DIR alone (no compat token) serves that folder read only.
// With BOARD_LEGACY_COMPAT_TOKEN_FILE set, the predecessor board's API is answered too (src/legacy-compat.mjs);
// BOARD_AUTO_COMPACT=1 (off by default) additionally compacts a task's older done steps after a compat push that
// leaves it near the step cap (J-05 auto-compact, src/ops.mjs STEP_CAP / AUTO_COMPACT_AT).
//
// Owner behind a login proxy (BOARD_OWNER_PROXY_SECRET_FILE): a reverse proxy that has ALREADY authenticated the
// owner (e.g. nginx basic auth on one location) vouches for it by setting X-Laneboard-Owner-Proxy to a shared secret.
// The server then treats a request with no bearer token as the owner when, and only when: the TCP peer is loopback
// (the proxy on the same host), the header equals the secret (constant-time), and — for anything but GET/HEAD — the
// request also carries X-Requested-With: laneboard, which no cross-site form or simple request can send (CSRF).
// The proxy must set the header itself (proxy_set_header replaces whatever a client sent) and only in that location.
// A bearer token, when present, always wins: a lane token through the same proxy stays that lane.
//
// The external edge (X-Laneboard-Ext): the reverse proxy's /zumia/ext/api/v1/ location, open to outside reporters with no
// basic auth, sets X-Laneboard-Ext: 1 and strips X-Laneboard-Owner-Proxy and X-Laneboard-Token; every other location strips
// X-Laneboard-Ext. A request that carries it (any non-empty value; it can only ever REDUCE what a request may do) is
// answered as an outsider: only POST /api/v1/write (op inbox.submit), the lane mailbox (POST /api/v1/msg,
// GET /api/v1/inbox) and GET /api/v1/whoami exist (anything else 404), the
// owner-proxy and X-Laneboard-Token paths are off, and the bearer must be a reporter token (no bearer 401, any other role 403).
//
// X-Laneboard-Token (the Zumi desktop app): nginx's basic auth occupies Authorization for every request on this
// path, including the app's own, so the app cannot send its revocable owner token as a bearer. It sends it in
// X-Laneboard-Token instead, and that header — when present — ALONE decides the actor for the whole request:
// valid and unrevoked, the actor is that token's identity; invalid, revoked or malformed, the request is 401
// and never falls back to the proxy-owner header (which would otherwise attribute the write to the generic
// owner). Authorization is ignored on a request that carries this header. No header: behaviour is unchanged.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBoard, SCHEMA_DIR, DEFAULTS } from './board.mjs';
import { STREAM_TYPES } from './views.mjs';
import { BoardError } from './ops.mjs';
import { createLegacyCompat, createLegacyMedia } from './legacy-compat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The deployed commit: the first word of <code dir>/RELEASE (the release swap writes it), else 'unknown'. */
export function readRelease(dir = ROOT) {
  try { return fs.readFileSync(path.join(dir, 'RELEASE'), 'utf8').trim().split(/\s+/)[0] || 'unknown'; } catch { return 'unknown'; }
}
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 2 * 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...(type.startsWith('text/html') ? { 'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" } : {}) });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false; const chunks = [];
    // Oversized bodies are drained, not destroyed, so the client receives the 413 instead of a reset.
    req.on('data', c => { size += c.length; if (size > MAX_BODY) tooLarge = true; else chunks.push(c); });
    req.on('end', () => { if (tooLarge) return reject(new BoardError(413, 'body_too_large')); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new BoardError(400, 'bad_json')); } });
    req.on('error', reject);
  });
}
function serveStatic(res, baseDir, rel) {
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not_found' });
  return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}
const bearer = req => (/^Bearer (\S+)$/.exec(req.headers.authorization || '') || [])[1];
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const sha = s => crypto.createHash('sha256').update(s).digest();
/** True when the reverse proxy vouches for the owner on this request (see the header comment). */
export function proxyOwner(req, secret) {
  if (!secret || !LOOPBACK.includes(req.socket.remoteAddress)) return false;
  const got = req.headers['x-laneboard-owner-proxy'];
  if (typeof got !== 'string' || !crypto.timingSafeEqual(sha(got), sha(secret))) return false;
  return ['GET', 'HEAD'].includes(req.method) || req.headers['x-requested-with'] === 'laneboard';
}

// ---- size-reduced image copies (the predecessor's media/_w and media/_t): WebP, made once, kept beside the blobs ----
const DERIV = { 480: 75, 1600: 82 };
/** ImageMagick binary to use, or '' (no copies, originals are served). Never Windows' own convert.exe. */
export function imageTool(env = process.env, platform = process.platform) {
  if (env.BOARD_IMAGE_TOOL !== undefined) return env.BOARD_IMAGE_TOOL;
  return platform === 'win32' ? '' : 'convert';
}
const building = new Map();
let slots = 2; const queue = [];
const withSlot = fn => new Promise((resolve, reject) => {
  const run = () => { slots--; fn().then(resolve, reject).finally(() => { slots++; const next = queue.shift(); if (next) next(); }); };
  if (slots > 0) run(); else queue.push(run);
});
/** Path of the WebP copy of `file` (an image blob) at most `width` px wide; built on first use. Rejects on failure. */
function derivative(tool, file, width) {
  const out = path.join(path.dirname(file), `_w${width}`, path.basename(file) + '.webp');
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (building.has(out)) return building.get(out);
  const tmp = `${out}.${process.pid}.tmp.webp`;
  const job = withSlot(() => new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execFile(tool, [file + '[0]', '-auto-orient', '-strip', '-resize', `${width}x>`, '-quality', String(DERIV[width]), '-define', 'webp:method=4', 'webp:' + tmp], { timeout: 60000 }, err => {
      if (err || !fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); return reject(err || new Error('no output')); }
      fs.renameSync(tmp, out); resolve(out);
    });
  })).finally(() => building.delete(out));
  building.set(out, job);
  return job;
}

/** Server-sent events of owner signals. Each message has id evt-N, so EventSource/curl clients resume by Last-Event-ID. */
function streamSignals(req, res, board, token, url) {
  const since = url.searchParams.get('since') ?? req.headers['last-event-id'];
  const m = since ? /^(?:evt-)?(\d+)$/.exec(since) : null;
  if (since && !m) throw new BoardError(400, 'bad_since');
  const types = (url.searchParams.get('types') || 'feedback,answer,ask').split(',').filter(Boolean);
  if (types.some(x => !STREAM_TYPES.includes(x))) throw new BoardError(400, 'bad_types');
  const pending = [];
  let open = false;
  const out = chunk => (open ? res.write(chunk) : pending.push(chunk));
  const stop = board.watch(token, { afterSeq: m ? Number(m[1]) : null, types }, {
    onSignal: sig => out(`id: ${sig.event_id}\nevent: ${sig.type}\ndata: ${JSON.stringify(sig)}\n\n`),
    onCursor: seq => out(`id: evt-${seq}\n\n`), // no data: moves the client's resume point without firing an event
    onEnd: () => res.end()
  }); // throws 401/403 before any header is written
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  for (const chunk of pending) res.write(chunk);
  open = true;
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); stop(); });
}

export function createServer(board, { legacyCompat, legacyMedia, ownerProxySecret = '', imageTool: tool = '', readOnly = false, mainUrl = '', release = readRelease() } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    // A read-only preview refuses every write before any handler (or the body) is touched.
    if (readOnly && req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); return send(res, 403, { error: 'preview_readonly' }); }
    const viaExt = !!req.headers['x-laneboard-ext'];
    if (viaExt) {
      const allowed = (req.method === 'POST' && (p === '/api/v1/write' || p === '/api/v1/msg'))
        || (req.method === 'GET' && (p === '/api/v1/whoami' || p === '/api/v1/inbox'));
      if (!allowed) { req.resume(); return send(res, 404, { error: 'not_found' }); }
      const who = board.authenticate(bearer(req));
      if (!who) { req.resume(); return send(res, 401, { error: 'unauthorized' }); }
      // no role is echoed: the edge must not tell an outsider which tokens are owner or coordinator
      if (who.role !== 'reporter') { req.resume(); return send(res, 403, { error: 'forbidden_on_ext' }); }
    }
    const appToken = viaExt ? undefined : req.headers['x-laneboard-token'];
    if (appToken !== undefined) {
      if (!board.authenticate(appToken)) { req.resume(); return send(res, 401, { error: 'unauthorized' }); }
    }
    const token = appToken !== undefined ? appToken : (bearer(req) || (!viaExt && proxyOwner(req, ownerProxySecret) ? board.ownerCredential : undefined));
    try {
      // The predecessor's routes carry no per-record scope: a reporter token never reads them (they answer the whole board).
      if ((p === '/api/state' || p === '/api/times' || p === '/api/media' || p === '/api/stats' || p.startsWith('/media/') || p.startsWith('/api/admin/')) && board.authenticate(token)?.role === 'reporter') { req.resume(); return send(res, 403, { error: 'forbidden_for_role' }); }
      if (legacyCompat && await legacyCompat.handle(req, res, p, send)) return;
      if (!legacyCompat && legacyMedia && await legacyMedia.handle(req, res, p, send)) return;
      if (req.method === 'POST' && p === '/api/v1/write') {
        const body = await readJson(req);
        if (viaExt && body?.op !== 'inbox.submit') throw new BoardError(403, 'op_not_allowed_on_ext', { allowed: ['inbox.submit'] });
        return send(res, 200, board.write(token, body));
      }
      // Lane mailbox: a separate message file, never the journal. `from` is stamped by board.sendMessage from
      // the token; the owner may post from the app, a lane token as its lane, and the ext edge may do both routes.
      if (req.method === 'POST' && p === '/api/v1/msg') {
        const body = await readJson(req);
        return send(res, 200, board.sendMessage(token, body));
      }
      if (req.method === 'POST' && p === '/api/v1/upload') {
        const meta = Object.fromEntries(url.searchParams);
        const len = req.headers['content-length'];
        return send(res, 200, await board.upload(token, meta, req, { contentLength: len ? Number(len) : undefined }));
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      // A long poll parks for up to 25 s; a client that disconnects wakes it through the abort signal.
      if (p === '/api/v1/inbox') {
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.on('close', abort);
        try {
          const out = await board.inbox(token, {
            lane: url.searchParams.get('lane') ?? undefined,
            after: url.searchParams.get('after') ?? undefined,
            waitMs: url.searchParams.get('wait') ?? undefined,
            signal: controller.signal
          });
          if (res.destroyed || res.writableEnded) return;
          return send(res, 200, out);
        } finally { req.off('close', abort); }
      }
      if (p === '/healthz') return send(res, 200, { ok: true, seq: board.state.seq, release });
      // Dry run of steps.compact: the same eligibility function as the op's check(), and a read: it writes nothing.
      if (p === '/api/v1/compact/preview') {
        return send(res, 200, board.compactPreview(token, { task: url.searchParams.get('task'), keep_last: url.searchParams.get('keep_last') }));
      }
      if (p === '/api/v1/state') {
        const v = board.view(token, { turns: url.searchParams.get('v') === '2', archived: url.searchParams.get('archived') === '1' });
        return send(res, 200, readOnly ? { ...v, config: { ...v.config, read_only: true, main_url: mainUrl } } : v);
      }
      // The board's task-statistics document (derived data in <data>/stats.json, never journaled): one aggregated JSON
      // the page reads as-is, same audience as /api/state.
      if (p === '/api/stats') return send(res, 200, board.stats());
      // The quota side file (<data>/quota.json, written by an external publisher, never journaled): read-only, any signed-in token, not on the ext edge.
      if (p === '/api/v1/quota') return send(res, 200, board.quota(token));
      if (p === '/api/v1/turns') return send(res, 200, board.turns(token, url.searchParams.get('lane'), url.searchParams.get('limit')));
      if (p === '/api/v1/whoami') {
        const me = board.authenticate(token);
        if (me && viaExt) return send(res, 200, { token_id: me.token_id, name: me.name, role: me.role, scope_tasks: me.scope_tasks }); // principal, role, scope only
        return me ? send(res, 200, me) : send(res, 401, { error: 'unauthorized' });
      }
      if (p === '/api/v1/events' && /text\/event-stream/.test(req.headers.accept || '')) return streamSignals(req, res, board, token, url);
      if (p === '/api/v1/events') return send(res, 200, board.events(token, Number(url.searchParams.get('after') || 0), Number(url.searchParams.get('limit') || 200), { task: url.searchParams.get('task') || undefined }));
      if (p === '/api/v1/tokens') return send(res, 200, board.tokens(token));
      const link = /^\/api\/v1\/media\/(att-[0-9]+)\/link$/.exec(p);
      if (link) return send(res, 200, board.mediaLink(token, link[1]));
      const media = /^\/api\/v1\/media\/(att-[0-9]+)$/.exec(p);
      if (media) {
        // Bearer header, or an expiring link from /link: tokens never travel in URLs (they end up in logs).
        const m = board.media(token, media[1], { exp: url.searchParams.get('exp'), sig: url.searchParams.get('sig') });
        const width = Number(url.searchParams.get('w'));
        if (tool && DERIV[width] && /^image\/(png|jpeg|webp)$/.test(m.mime)) {
          try {
            const f = await derivative(tool, m.file, width);
            res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': fs.statSync(f).size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
            return fs.createReadStream(f).pipe(res);
          } catch (e) { console.error('image copy failed, serving the original', media[1], e.message); }
        }
        const head = { 'Content-Type': m.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' };
        // Byte ranges: browsers seek audio/video with them, and iOS Safari will not play <video> without 206.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (range && (range[1] || range[2])) {
          const start = range[1] === '' ? Math.max(0, m.size - Number(range[2])) : Number(range[1]);
          const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), m.size - 1) : m.size - 1;
          if (start > end || start >= m.size) { res.writeHead(416, { 'Content-Range': `bytes */${m.size}` }); return res.end(); }
          res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${m.size}`, 'Content-Length': end - start + 1 });
          return fs.createReadStream(m.file, { start, end }).pipe(res);
        }
        res.writeHead(200, { ...head, 'Content-Length': m.size });
        return fs.createReadStream(m.file).pipe(res);
      }
      if (p.startsWith('/schema/v1/')) return serveStatic(res, SCHEMA_DIR, p.slice('/schema/v1/'.length));
      if (p === '/' ) return serveStatic(res, PUBLIC_DIR, 'index.html');
      return serveStatic(res, PUBLIC_DIR, p.slice(1));
    } catch (e) {
      if (e instanceof BoardError) return send(res, e.status, { error: e.code, ...e.extra });
      console.error(e);
      return send(res, 500, { error: 'internal' });
    }
  });
}

/** "sonnet=Sonnet 5.5,opus" -> { models: ['sonnet', 'opus'], modelLabels: { sonnet: 'Sonnet 5.5' } } */
export function parseModels(spec) {
  const pairs = spec.split(',').map(x => x.trim()).filter(Boolean).map(x => { const i = x.indexOf('='); return i < 0 ? [x, ''] : [x.slice(0, i).trim(), x.slice(i + 1).trim()]; });
  return { models: pairs.map(([id]) => id), modelLabels: Object.fromEntries(pairs.filter(([, l]) => l)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = path.resolve(process.env.BOARD_DATA || path.join(process.cwd(), 'data'));
  const board = createBoard({
    dataDir,
    ownerToken: process.env.BOARD_OWNER_TOKEN || undefined,
    stallMs: Number(process.env.BOARD_STALL_MS || DEFAULTS.stallMs),
    maxAttachmentBytes: Number(process.env.BOARD_MAX_ATTACHMENT_BYTES || DEFAULTS.maxAttachmentBytes),
    maxUploadBytes: Number(process.env.BOARD_MAX_UPLOAD_BYTES || DEFAULTS.maxUploadBytes),
    // BOARD_MODELS: "id,id" or "id=Label,id=Label" (labels are display names; ids are what gets stored)
    ...(process.env.BOARD_MODELS ? parseModels(process.env.BOARD_MODELS) : {})
  });
  if (board.bootstrapTokenFile) console.log(`owner token written to ${board.bootstrapTokenFile} (keep it private)`);
  if (board.replayed) console.log(`replayed ${board.replayed} journal event(s) into the projection`);
  const compatToken = process.env.BOARD_LEGACY_COMPAT_TOKEN_FILE;
  // BOARD_AUTO_COMPACT=1 turns on the post-push step compaction of the compat push (J-05). Default OFF: the code path is
  // not entered at all, so the journal of the same pushes is byte-identical to a build without the feature.
  const autoCompact = process.env.BOARD_AUTO_COMPACT === '1';
  const legacyCompat = compatToken ? createLegacyCompat(board, { tokenFile: compatToken, dataDir, mediaDir: process.env.BOARD_LEGACY_MEDIA_DIR || '', autoCompact }) : undefined;
  if (legacyCompat) console.log(`predecessor API on (/api/state, loopback /api/admin/*)${process.env.BOARD_LEGACY_MEDIA_DIR ? `, media ${process.env.BOARD_LEGACY_MEDIA_DIR}` : ''}${autoCompact ? ', auto-compact on' : ''}`);
  const proxyFile = process.env.BOARD_OWNER_PROXY_SECRET_FILE;
  const ownerProxySecret = proxyFile ? fs.readFileSync(proxyFile, 'utf8').trim() : '';
  if (proxyFile && ownerProxySecret.length < 32) throw new Error('BOARD_OWNER_PROXY_SECRET_FILE must hold a secret of at least 32 characters');
  if (ownerProxySecret) console.log('owner via login proxy: on (X-Laneboard-Owner-Proxy from a loopback peer)');
  const readOnly = process.env.BOARD_PREVIEW_READONLY === '1';
  const legacyMedia = !legacyCompat && process.env.BOARD_LEGACY_MEDIA_DIR ? createLegacyMedia(process.env.BOARD_LEGACY_MEDIA_DIR) : undefined;
  if (readOnly) console.log(`READ-ONLY PREVIEW: every write is refused (403 preview_readonly)${legacyMedia ? `, media read from ${process.env.BOARD_LEGACY_MEDIA_DIR}` : ''}`);
  const tool = imageTool();
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1';
  createServer(board, { legacyCompat, legacyMedia, ownerProxySecret, imageTool: tool, readOnly, mainUrl: process.env.BOARD_PREVIEW_MAIN_URL || '/zumia/' }).listen(port, host, () => console.log(`laneboard listening on http://${host}:${port}  data=${dataDir}`));
  // Stale Now/Next text asks the lane for an update (the owner's freshness.set). A read-only preview must not write.
  if (!readOnly) setInterval(() => { try { board.sweepFreshness(); } catch (e) { console.error('freshness sweep failed', e); } }, 3600000).unref();
}
