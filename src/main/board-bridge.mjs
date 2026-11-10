// Live-board loopback bridge (PLAN-live-board.md §2, §3, Coordinator QC 02-10; owner-token header ruling 02-10).
// Main-process only: no Electron imports, so Node can test it directly.
//
// It listens on 127.0.0.1:<ephemeral> and is the ONLY way the renderer reaches a live board:
//   - GET /…            serves the pinned Laneboard page from `publicDir` (never the upstream);
//   - /api/v1/*  +  GET  /healthz   are proxied to `upstreamOrigin`, with auth added HERE (never reaches the page,
//     the renderer or any response body) — see `buildAuthHeaders` for the two shapes:
//       - local mode: `getToken()` only -> `Authorization: Bearer <token>` (unchanged from the L0 POC).
//       - live mode: `getBasicAuth()` -> the nginx front for a live board requires `Authorization: Basic <user:pass>`
//         on the WHOLE location incl. /api/*, so Basic occupies that header; the zumi-desktop owner token, WHEN
//         non-empty, ALSO travels in `X-Laneboard-Token: <token>` (raw token, NO "Bearer " prefix) — the live board
//         reads that header to decide identity and refuses with 401 when it is present but invalid. The token is
//         OPTIONAL (coordinator decision, auth-approved): with none configured, this header is omitted entirely and
//         the request reaches the board as Basic-only, exactly like the web board's own UI — nginx's own
//         proxy-owner header (vendor/laneboard/src/server.mjs's `proxyOwner`, set by nginx itself after it validates
//         Basic, unrelated to anything this bridge sends) is what attributes the write to the proxy owner there.
//         Writes also get `X-Requested-With: laneboard` either way (vendor/laneboard/src/server.mjs).
//
// Two channels, tagged in MAIN (the page cannot choose its channel):
//   - PAGE  — an HTTP request arriving at the bridge (the owner clicking in the served page). Allowlisted owner
//             ops the web UI uses, incl. task/step status changes; NEVER token.*, notify.set, roles.escalate.
//             routing.set/reset + roles.set/reset (the per-task Plan/Code/Review/Scout lane models) ONLY when the
//             bridge is created with `ownerOps: true` — main passes the owner build's OWNER_ADMIN flag; the release
//             build keeps refusing them (T-31 role-ui-port, Sol gate).
//   - RELAY — `relay(op, body)`, an in-process call Zumi makes from chat (not over the page). Only ask.answer,
//             feedback.add, inbox.submit.
// Every write gets a request_id prefixed by its channel (`zumi-ui-` / `zumi-relay-`), so main's channel choice
// is visible in the board journal. A refused op never reaches upstream (a `forbidden_op` JSON error, 403).
//
// Redirects are errors: the bearer must never be replayed to a redirect target.
//
// Browser-origin guard (T-31 role-ui-port, raised for the Sol gate): the bridge ADDS the owner's credentials, so it
// must not forward what a web page in some other browser could send to 127.0.0.1:<port>. Every request must name this
// bridge in Host (127.0.0.1:<port> or localhost:<port>; a DNS-rebinding page names its own host) and every page write
// must carry `X-Requested-With: laneboard`, which the served page always sends (public/app.js write()) and which no
// cross-site form or simple request can set without a CORS preflight this bridge never grants. Without these two
// checks the bridge would launder Laneboard's own CSRF rule, since it adds that header upstream itself.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

// Ops the PAGE channel may reach upstream. The owner's own board UI is the actor, so task/step status changes are
// allowed; credential/routing/notification ops are not (a compromised page must not spend owner power), and nothing
// irreversible: the board rule is close-not-delete, so task/step deletes stay web-only.
const PAGE_OPS = new Set([
  // exactly the writes the web board UI makes at ee04051 (public/app.js write(...) calls), minus routing.*/notify.set
  'task.update', 'step.update',
  'ask.answer', 'ask.clear',
  'inbox.merge',
  'feedback.add', 'feedback.resolve',
  'goal.lock', 'rebrief.request',
  'summary.set', 'ping.send', 'prefs.set',
]);
// Owner build only (`ownerOps`): the page's worker-routing writes (public/app.js: routing.set / routing.reset for the
// code slot, roles.set / roles.reset for plan / review / scout). Server-side these are owner-only ops; the board is
// PIN-unlocked before the bridge has any credential. Trade-off accepted at the Sol gate: while unlocked, any local
// process that finds the loopback port can re-route lanes, the same exposure task.update already has. Never
// roles.escalate (coordinator power), token.* or notify.set.
// J-05 machines-app-tab (Laneboard 9bfe62d, CoS GO 6eb016e7fd99): also the owner's pin toggle (pin.set) and machine picker
// (machines.set). Same trade-off. The board's x-roles still decide: pin.set is owner-only, machines.set is owner or
// coordinator (the board's own rule, not widened here); a reporter gets the board's 403 for both.
const OWNER_OPS = new Set(['routing.set', 'routing.reset', 'roles.set', 'roles.reset', 'pin.set', 'machines.set']);
// T-31-MOBILE M3: the label on every phone token this app mints (coordinator 01-11: one test token "phone-test").
export const PHONE_TOKEN_LABEL = 'phone-test';
// Ops Zumi relays from chat. Exactly three (Coordinator QC 02-10).
const RELAY_OPS = new Set(['ask.answer', 'feedback.add', 'inbox.submit']);
// Board-wide settings the page renders as a control from one GET /api/v1/state field, each written by one op. When the
// PAGE channel cannot write that op (both are refused in every build: board-wide settings stay on the web board), the
// field is dropped from the state the page reads, so the page never renders a control whose click can only come back
// 403 (review v7 should-fix: Laneboard 0595f29's "status freshness" control wrote freshness.set into a refusal). The
// page already hides each control when its field is absent (public/app.js statusFreshness / coordinatorNotify: the
// shape of a board that predates them), and nothing else in the page reads them (stale badges come from stale_text).
const SETTING_FIELDS = Object.freeze({ freshness: 'freshness.set', notify: 'notify.set' });
// T-31 alpha.4: the Zumi app theme (src/renderer/theme.js THEMES) -> the display prefs the vendored page understands (public/app.js CHOICES).
// Used only by a bridge created with hostTheme: true (the Tauri host); the page names its theme in the ?zumiTheme= of its own load.
const HOST_THEME_PREFS = Object.freeze({
  blue: Object.freeze({ theme: 'dark', accent: 'blue' }),
  black: Object.freeze({ theme: 'dark', accent: 'neutral' }),
  white: Object.freeze({ theme: 'light', accent: 'neutral' }),
});

// T-31 alpha.5: the vendored page styles no scrollbar, so WebView2 drew its wide grey default (owner shot 30-10). A hostTheme
// bridge links this one stylesheet last in the page it serves (same origin, so the guest CSP's style-src 'self' allows it).
// Same look as the shell (renderer next/brain.css, pricing.css): thin, thumb = the line-dim token, transparent track.
// Tokens only (vendor public/tokens.css), so it follows the page theme: --input is the shell's --line-dim for black/white.
export const HOST_GUEST_CSS_PATH = '/__zumi-host/board-guest.css';
const HOST_GUEST_CSS = [
  '* { scrollbar-width: thin; }',
  'html { scrollbar-color: var(--input) transparent; }',
  'html.dark[data-accent="blue"] { scrollbar-color: color-mix(in srgb, var(--primary) 45%, transparent) transparent; }',
  // T-31 alpha.6 (owner 30-10): app theme blue maps to the page's dark + blue
  // accent (HOST_THEME_PREFS), which only recolours the accent, so the Board sat black/grey inside the navy shell. Under
  // blue the surface tokens take the shell's look A values. A copy, not a link: src/next-tokens is not shipped with the
  // bridge (Electron files, Tauri stage-bundle); check-board-bridge 5e fails if it drifts from tokens-a.css. Black and
  // white map to accent neutral, so this selector never matches them.
  'html.dark[data-accent="blue"] { --background: #050b14; --card: #071628; --muted: #0b2033; --muted-foreground: #8fb6b8; --border: #5ff2e166; --input: #5ff2e155; --accent: #0e3040; }',
  '',
].join('\n');
const HOST_GUEST_LINK = `<link rel="stylesheet" href="${HOST_GUEST_CSS_PATH}">`;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
// Same policy as vendor/laneboard/src/server.mjs send(). `connect-src 'self'` is what closes guest ws/wss/fetch to any
// other origin: WebView2 never raises WebResourceRequested for a ws handshake (probe-p1c4 `ws: LEAK`), so the page's own
// CSP is the only thing that can stop it. Exported so the Tauri host check pins the exact string.
export const GUEST_HTML_CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";
// Reads the bridge forwards upstream (deny by default: a new upstream GET stays unreachable until it is listed HERE).
// Exactly what the vendored page fetches (public/app.js) plus /api/stats (Stats tab). inbox, msg, compact/preview and
// every other route are NOT listed: the bridge adds the owner's credentials, so each entry widens owner-read power.
const READ_ROUTES = new Set([
  '/healthz', '/api/v1/state', '/api/v1/whoami', '/api/v1/turns', '/api/v1/events', '/api/v1/quota', '/api/v1/tokens',
]);
const GET_ONLY_ROUTES = new Set(['/api/stats']); // Stats tab: GET only, no HEAD (same rule as Electron 0.2.10)
const READ_ROUTE_PATTERNS = [/^\/api\/v1\/media\/[A-Za-z0-9_-]+(\/link)?$/];
const isReadRoute = (p, method) => READ_ROUTES.has(p) || READ_ROUTE_PATTERNS.some((re) => re.test(p)) || (method === 'GET' && GET_ONLY_ROUTES.has(p));
// Caller secret (every request to the bridge must carry it). Webview: HttpOnly SameSite=Strict cookie set by the
// one-time session URL; in-process readers: the header. Never in a log, a page, a response body or the Referer.
// Accepted residual: a process of the same Windows user can read this process's memory; no loopback scheme defends that.
export const CALLER_HEADER = 'x-zumi-bridge-token';
const SESSION_PATH = '/__bridge-session';
const SESSION_NONCE_TTL_MS = 60_000;
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''), 'utf8'), y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const MAX_BODY = 2 * 1024 * 1024; // JSON writes only; POST /api/v1/upload streams under its own cap (MESSAGE_IMAGE)
// Copy of MESSAGE_IMAGE in vendor/laneboard/src/board.mjs (not imported: that module has load side effects in main).
export const MESSAGE_IMAGE = Object.freeze({ mimes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), maxBytes: 5 * 1024 * 1024 });
// Page image upload (public/app.js uploadImage): exactly these query keys, purpose=message only. request_id must still
// match upload.json's pattern once prefixed `zumi-ui-`.
const UPLOAD_QUERY_KEYS = new Set(['request_id', 'task_id', 'name', 'mime', 'purpose']);
const UPLOAD_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const UPLOAD_TIMEOUT_MS = 60_000;

const sendJson = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
};

/** Serve one file from `publicDir`, refusing any path that escapes it. */
function serveStatic(res, publicDir, rel) {
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: 'not_found' });
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(type.startsWith('text/html') || type === MIME['.svg'] ? { 'Content-Security-Policy': GUEST_HTML_CSP } : {}) });
  res.end(fs.readFileSync(file));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) tooLarge = true; else chunks.push(c); });
    req.on('end', () => { if (tooLarge) return reject(Object.assign(new Error('too_large'), { status: 413, code: 'body_too_large' })); resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/**
 * Auth headers for one upstream request. `auth.basic` (live mode) wins the `Authorization` header because the live
 * board's nginx front validates THAT header as HTTP Basic before anything reaches Laneboard — a Bearer value there
 * would be refused by nginx itself, never reaching the app. `auth.bearer`, when set, ALWAYS rides in
 * `X-Laneboard-Token` as the RAW token (no "Bearer " prefix) in live mode: the live board reads that header to decide
 * identity and refuses with 401 when it is missing or invalid, never falling back to the proxy owner. `forWrite` adds
 * the CSRF header Laneboard requires on writes (all documented at the top of this file).
 */
function buildAuthHeaders(auth, forWrite) {
  if (auth && auth.basic) {
    return {
      Authorization: `Basic ${Buffer.from(`${auth.basic.user}:${auth.basic.pass}`, 'utf8').toString('base64')}`,
      ...(auth.bearer ? { 'X-Laneboard-Token': auth.bearer } : {}),
      ...(forWrite ? { 'X-Requested-With': 'laneboard' } : {}),
    };
  }
  return { Authorization: `Bearer ${auth && auth.bearer}` };
}

/** One upstream call. `redirect: 'manual'` turns any 3xx into a hard error so the auth is never re-sent. */
async function upstreamFetch(upstreamOrigin, pathname, { method, auth, body } = {}) {
  const res = await fetch(new URL(upstreamOrigin + pathname), {
    method,
    redirect: 'manual',
    headers: { ...buildAuthHeaders(auth, method !== 'GET' && method !== 'HEAD'), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status >= 300 && res.status < 400) throw Object.assign(new Error('upstream redirect'), { status: 502, code: 'upstream_redirect' });
  return res;
}

/**
 * @param {object} o
 * @param {string} o.upstreamOrigin   e.g. LIVE_UPSTREAM of board-live.mjs  (POC: http://127.0.0.1:<port>)
 * @param {() => string|null} o.getToken  main-only bearer source; null while locked. Local mode's only auth source;
 *   in live mode it is the zumi-desktop owner token, sent in `X-Laneboard-Token` alongside (not instead of) basic
 *   auth — see module header.
 * @param {() => {user:string,pass:string}|null} [o.getBasicAuth]  live mode only: the nginx front's basic-auth
 *   credential. When this is provided the bridge is in "live" shape: Authorization carries Basic, not Bearer.
 * @param {string} o.publicDir        the pinned Laneboard page (vendor/laneboard/public)
 * @param {string} [o.host]           default 127.0.0.1
 * @param {(op:string, channel:string) => void} [o.onRefused]  test hook: observe a refusal, no secrets in it
 * @param {boolean} [o.ownerOps]      owner build only: the PAGE channel may also forward OWNER_OPS (lane routing, pin, machines)
 * @param {(generation: *) => void} [o.onAuthRejected]  the UPSTREAM answered 401 with the user's credentials (T-31 0.2.11
 *   auth-401). Called only right after `upstreamFetch`, so the bridge's own 401s (`locked`, caller `unauthorized`) never
 *   reach it. Gets the `authGeneration()` value captured when that request's auth was read, so the host can ignore a
 *   late 401 sent with credentials that were replaced while it was in flight.
 * @param {() => *} [o.authGeneration]  the host's current credential generation (see onAuthRejected)
 * @param {() => boolean} [o.isAuthRejected]  while true, every upstream call is refused HERE with 401 `auth_rejected`
 *   (no network): a rejected sign-in is not retried until the host clears the latch (new sign-in / sign-out).
 * @param {(line: string) => void} [o.onLog]  one line per error answer the bridge gives itself
 *   (`bridge refused <METHOD> <path> <status> <code>`): no query string, header, body or secret
 */
export function createBridge({ upstreamOrigin, getToken, getBasicAuth, publicDir, host = '127.0.0.1', onRefused, ownerOps = false, onAuthRejected, isAuthRejected, authGeneration, onLog, hostTheme = false } = {}) {
  const dir = path.resolve(publicDir);
  const base = upstreamOrigin.replace(/\/+$/, '');
  // null while locked/unconfigured (either source), so one check covers local mode (bearer only) and live mode
  // (basic, +optional bearer) alike.
  function auth() {
    const basic = getBasicAuth ? getBasicAuth() : null;
    const bearer = getToken ? getToken() : null;
    return basic || bearer ? { basic, bearer } : null;
  }

  const callerToken = crypto.randomBytes(32).toString('hex');
  const nonces = new Map(); // one-time session nonce -> expiry (ms); consumed by the first load of SESSION_PATH
  let cookieName = 'zumi_bridge';
  const hasCallerToken = (req) => {
    if (safeEqual(req.headers[CALLER_HEADER], callerToken)) return true;
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName && safeEqual(part.slice(i + 1).trim(), callerToken)) return true;
    }
    return false;
  };
  function takeNonce(n) {
    let hit = null;
    for (const [k, exp] of nonces) { if (exp < Date.now()) nonces.delete(k); else if (safeEqual(n, k)) hit = k; }
    if (hit === null) return false;
    nonces.delete(hit);
    return true;
  }

  let pageTheme = null; // hostTheme only: the app theme the page was last loaded with (?zumiTheme=), one board page per bridge
  const pageMayWrite = (op) => PAGE_OPS.has(op) || (ownerOps === true && OWNER_OPS.has(op));
  // GET /api/v1/state as the page reads it: minus the SETTING_FIELDS whose op the page channel cannot write.
  function pageState(buf) {
    let state;
    try { state = JSON.parse(buf.toString('utf8')); } catch { return buf; } // not JSON: passed through untouched
    if (!state || typeof state !== 'object' || Array.isArray(state)) return buf;
    let changed = false;
    for (const [field, op] of Object.entries(SETTING_FIELDS)) if (field in state && !pageMayWrite(op)) { delete state[field]; changed = true; }
    // hostTheme: the app's theme wins over the token's stored server prefs, which adoptServerPrefs would otherwise copy over the #theme= the
    // page booted with. Only the state the page reads changes; upstream prefs are never written.
    if (hostTheme === true && pageTheme && state.me && typeof state.me === 'object') {
      state.me.prefs = { ...(state.me.prefs || {}), ...HOST_THEME_PREFS[pageTheme] };
      changed = true;
    }
    return changed ? Buffer.from(JSON.stringify(state), 'utf8') : buf;
  }

  async function proxyWrite(op, channel, rawBody, reqId) {
    if (!op || !(channel === 'relay' ? RELAY_OPS.has(op) : pageMayWrite(op))) {
      onRefused?.(op || '', channel);
      throw Object.assign(new Error('forbidden op'), { status: 403, code: 'forbidden_op', channel });
    }
    const gen = authGeneration?.(); // read with the auth: a 401 is charged to THESE credentials, not later ones
    const a = auth();
    if (!a) throw Object.assign(new Error('locked'), { status: 401, code: 'locked' });
    if (isAuthRejected?.()) throw Object.assign(new Error('auth rejected'), { status: 401, code: 'auth_rejected' });
    const body = JSON.stringify({ ...rawBody, version: 1, op, request_id: `${channel === 'relay' ? 'zumi-relay-' : 'zumi-ui-'}${reqId}` });
    const res = await upstreamFetch(base, '/api/v1/write', { method: 'POST', auth: a, body });
    if (res.status === 401) onAuthRejected?.(gen);
    const text = await res.text();
    return { status: res.status, text };
  }

  const server = http.createServer(async (req, res) => {
    let url, p = '-';
    // Every answer the bridge itself gives with an error status is logged as method, path, status and code. The path has
    // no query string, so file names and ids stay out of the log; headers and bodies never go in.
    const json = (res, status, body) => {
      if (status >= 400) onLog?.(`bridge refused ${req.method} ${p} ${status} ${body.error}`);
      return sendJson(res, status, body);
    };
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return json(res, 400, { error: 'bad_url' }); }
    p = url.pathname;
    try {
      const own = server.address()?.port;
      if (![`127.0.0.1:${own}`, `localhost:${own}`].includes(req.headers.host)) return json(res, 403, { error: 'forbidden_host' });
      // ---- session bootstrap: a single-use nonce (minted by the host via sessionUrl()) swaps for the caller cookie ----
      if (req.method === 'GET' && p === SESSION_PATH) {
        if (!takeNonce(url.searchParams.get('n'))) return json(res, 401, { error: 'unauthorized' });
        url.searchParams.delete('n');
        res.writeHead(302, {
          'Set-Cookie': `${cookieName}=${callerToken}; Path=/; HttpOnly; SameSite=Strict`,
          Location: `/${url.search}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        });
        return res.end();
      }
      if (!hasCallerToken(req)) return json(res, 401, { error: 'unauthorized' });
      const gen = authGeneration?.(); // read with the auth (see onAuthRejected)
      const a = auth();
      // ---- proxied writes (page channel): POST /api/v1/write ----
      if (req.method === 'POST' && p === '/api/v1/write') {
        if (req.headers['x-requested-with'] !== 'laneboard') return json(res, 403, { error: 'csrf_header_required' });
        const raw = await readBody(req);
        let parsed; try { parsed = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'bad_json' }); }
        const { op, request_id: reqId, ...rest } = parsed;
        const { status, text } = await proxyWrite(op, 'page', rest, reqId || String(Date.now()));
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(text);
      }
      // ---- proxied reads (page channel): GET/HEAD /healthz and /api/v1/* ----
      if ((req.method === 'GET' || req.method === 'HEAD') && isReadRoute(p, req.method)) {
        if (!a) return json(res, 401, { error: 'locked' });
        if (isAuthRejected?.()) return json(res, 401, { error: 'auth_rejected' });
        const up = await upstreamFetch(base, p + url.search, { method: req.method, auth: a });
        if (up.status === 401) onAuthRejected?.(gen); // upstream (nginx Basic / Laneboard token) refused these credentials
        let buf = Buffer.from(await up.arrayBuffer());
        if (req.method === 'GET' && p === '/api/v1/state' && up.status === 200) buf = pageState(buf);
        res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(buf);
      }
      // ---- image upload (page channel): POST /api/v1/upload, purpose=message only ----
      if (req.method === 'POST' && p === '/api/v1/upload') {
        // An early refusal reads the rest of the body first, so the client gets the answer, not a reset socket.
        const drained = () => (req.readableEnded ? null : new Promise((r) => { req.once('end', r); req.once('error', r); req.resume(); }));
        const refuse = async (status, code) => { await drained(); return json(res, status, { error: code }); };
        if (req.headers['x-requested-with'] !== 'laneboard') return refuse(403, 'csrf_header_required');
        if (!a) return refuse(401, 'locked');
        if (isAuthRejected?.()) return refuse(401, 'auth_rejected');
        const q = url.searchParams;
        if ([...q.keys()].some((k) => !UPLOAD_QUERY_KEYS.has(k))) return refuse(400, 'bad_upload_query');
        if (q.get('purpose') !== 'message') return refuse(403, 'upload_purpose_not_allowed');
        const mime = q.get('mime');
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!MESSAGE_IMAGE.mimes.includes(mime) || contentType !== mime) return refuse(400, 'image_type_not_allowed');
        // Content-Length is optional (gate 2): when present it refuses early; the streamed count below is the cap.
        const declared = req.headers['content-length'];
        if (declared !== undefined && Number(declared) > MESSAGE_IMAGE.maxBytes) return refuse(413, 'image_too_large');
        const requestId = `zumi-ui-${q.get('request_id') || Date.now()}`;
        if (!UPLOAD_REQUEST_ID.test(requestId)) return refuse(400, 'bad_upload_query');
        const upQuery = new URLSearchParams({ request_id: requestId });
        for (const k of ['task_id', 'name', 'mime', 'purpose']) if (q.has(k)) upQuery.set(k, q.get(k));

        const abort = new AbortController();
        const body = new PassThrough();
        let size = 0, tooLarge = false, dropRest = false;
        req.on('data', (chunk) => {
          if (dropRest) return; // past the cap, or upstream already answered: read and dropped, never forwarded
          size += chunk.length;
          if (size > MESSAGE_IMAGE.maxBytes) {
            tooLarge = dropRest = true;
            body.destroy(Object.assign(new Error('image too large'), { code: 'image_too_large' }));
            abort.abort(); // upstream sees a cut body, never a complete one
            return req.resume();
          }
          if (!body.write(chunk)) { req.pause(); body.once('drain', () => req.resume()); }
        });
        req.on('end', () => { if (!tooLarge) body.end(); });
        req.on('error', (e) => { body.destroy(e); abort.abort(); });
        let up;
        try {
          up = await fetch(new URL(`${base}/api/v1/upload?${upQuery}`), {
            method: 'POST', redirect: 'manual', duplex: 'half', body,
            headers: { ...buildAuthHeaders(a, true), 'Content-Type': mime, ...(declared !== undefined ? { 'Content-Length': declared } : {}) },
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
          });
        } catch (e) {
          if (tooLarge) return refuse(413, 'image_too_large');
          throw e;
        }
        if (!req.readableEnded) { dropRest = true; body.destroy(); } // upstream answered before the body ended
        if (up.status >= 300 && up.status < 400) { await drained(); throw Object.assign(new Error('upstream redirect'), { status: 502, code: 'upstream_redirect' }); }
        if (up.status === 401) onAuthRejected?.(gen);
        const buf = Buffer.from(await up.arrayBuffer());
        await drained();
        res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(buf);
      }
      // ---- the pinned page ----
      if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
      if (p === '/healthz' || p.startsWith('/api/')) return json(res, 404, { error: 'not_found' }); // unlisted read: never the static handler
      if (hostTheme === true && p === '/' && Object.hasOwn(HOST_THEME_PREFS, url.searchParams.get('zumiTheme'))) pageTheme = url.searchParams.get('zumiTheme');
      if (hostTheme === true && p === HOST_GUEST_CSS_PATH) {
        res.writeHead(200, { 'Content-Type': MIME['.css'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(HOST_GUEST_CSS);
      }
      if (hostTheme === true && p === '/') {
        const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
        if (!html.includes('</head>')) return json(res, 500, { error: 'page_head_missing' });
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': GUEST_HTML_CSP });
        return res.end(html.replace('</head>', `${HOST_GUEST_LINK}\n</head>`));
      }
      return serveStatic(res, dir, p === '/' ? 'index.html' : p.slice(1));
    } catch (e) {
      return json(res, e.status || 500, { error: e.code || 'internal', ...(e.channel ? { channel: e.channel } : {}) });
    }
  });

  const ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => { cookieName = `zumi_bridge_${server.address().port}`; resolve(); }); });

  return {
    /** Resolves to the ephemeral port once listening. */
    async port() { await ready; return server.address().port; },
    /** HOST ONLY: the one URL the app's own board webview loads first. Its single-use nonce (60 s) swaps for the
     *  HttpOnly caller cookie and redirects to `/`; the URL is dead after that load, so logging it leaks nothing. */
    async sessionUrl() {
      await ready;
      const n = crypto.randomBytes(32).toString('hex');
      nonces.set(n, Date.now() + SESSION_NONCE_TTL_MS);
      return `http://127.0.0.1:${server.address().port}${SESSION_PATH}?n=${n}`;
    },
    /** HOST ONLY: header for in-process readers (board-reader, HUD) that call the bridge over loopback. */
    callerHeaders() { return { [CALLER_HEADER]: callerToken }; },
    close() { return new Promise((resolve) => server.close(resolve)); },
    /**
     * HOST ONLY (T-31-MOBILE M3 pairing, GATE-BRIDGE-OPUS F4, GATE-M3 fix 8): mint ONE device token for a phone. Not a
     * channel: no page, relay or op name reaches it (PAGE_OPS / OWNER_OPS / RELAY_OPS are unchanged and still refuse
     * token.*). The body is fixed here: role owner, `device: true` (the board's D3 limits), the fixed label, a fresh name.
     * @returns {Promise<{ok:true, id:string, name:string, token:string} | {ok:false, status:number, error:string}>}
     *   `token` is the plaintext the board reveals once; the caller puts it in the QR and nowhere else.
     */
    async issueDeviceToken({ now = new Date() } = {}) {
      const a = auth();
      if (!a) return { ok: false, status: 401, error: 'locked' };
      if (isAuthRejected?.()) return { ok: false, status: 401, error: 'auth_rejected' };
      const day = now.toISOString().slice(0, 10).replace(/-/g, '');
      const name = `phone-${day}-${crypto.randomBytes(2).toString('hex')}`;
      const body = JSON.stringify({ version: 1, op: 'token.issue', request_id: `zumi-host-${crypto.randomUUID()}`, target_id: name, data: { role: 'owner', device: true, label: PHONE_TOKEN_LABEL } });
      const res = await upstreamFetch(base, '/api/v1/write', { method: 'POST', auth: a, body });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || typeof out.token !== 'string' || typeof out.id !== 'string') return { ok: false, status: res.status, error: String(out.error || 'issue_failed') };
      return { ok: true, id: out.id, name, token: out.token };
    },
    /** HOST ONLY: the board's token list without secrets (id, name, role, label, device, revoked_at). */
    async listTokens() {
      const a = auth();
      if (!a) return { ok: false, status: 401, error: 'locked' };
      const res = await upstreamFetch(base, '/api/v1/tokens', { method: 'GET', auth: a });
      const out = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(out)) return { ok: false, status: res.status, error: String((out && out.error) || 'list_failed') };
      return { ok: true, tokens: out.map((t) => ({ id: t.id, name: t.name, role: t.role, label: t.label ?? null, device: t.device === true, revoked_at: t.revoked_at ?? null })) };
    },
    /**
     * HOST ONLY: revoke a phone token this app minted. Looked up first and refused unless the ACTIVE token with this id
     * also has this name, `device: true`, a `phone-` name and the phone label, so tok-1 and every non-device token are out
     * of reach whatever the caller passes. Revoke takes an id (a name can be reused after a revoke). "Already gone"
     * (404 token_not_found / 409 already_revoked) counts as done; anything else fails closed.
     */
    async revokeDeviceToken({ id, name } = {}) {
      const list = await this.listTokens();
      if (!list.ok) return list;
      const t = list.tokens.find((x) => x.id === id);
      if (!t) return { ok: true, gone: 'token_not_found' };
      if (t.name !== name || !t.device || !String(t.name).startsWith('phone-') || t.label !== PHONE_TOKEN_LABEL) return { ok: false, status: 403, error: 'not_a_phone_token' };
      if (t.revoked_at) return { ok: true, gone: 'already_revoked' };
      const a = auth();
      if (!a) return { ok: false, status: 401, error: 'locked' };
      const body = JSON.stringify({ version: 1, op: 'token.revoke', request_id: `zumi-host-${crypto.randomUUID()}`, target_id: id, data: {} });
      const res = await upstreamFetch(base, '/api/v1/write', { method: 'POST', auth: a, body });
      const out = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, revoked: id, cascade: Array.isArray(out.cascade) ? out.cascade : [] };
      if ((res.status === 404 && out.error === 'token_not_found') || (res.status === 409 && out.error === 'already_revoked')) return { ok: true, gone: out.error };
      return { ok: false, status: res.status, error: String(out.error || 'revoke_failed') };
    },
    /** RELAY channel: Zumi relaying its own words from chat, in-process (never over the page). */
    async relay(op, body = {}) {
      try {
        return await proxyWrite(op, 'relay', body, body.request_id || String(Date.now()));
      } catch (e) {
        return { status: e.status || 500, text: JSON.stringify({ error: e.code || 'internal', ...(e.channel ? { channel: e.channel } : {}) }) };
      }
    },
  };
}

// Allow `node src/main/board-bridge.mjs` to print the module path (smoke check the file loads without Electron).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('board-bridge: createBridge is importable without Electron');
}
