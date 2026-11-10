// L0 POC check for the live-board bridge (src/main/board-bridge.mjs). No Electron, no network to the real board.
// Upstream = a local Laneboard started in-process from vendor/laneboard on 127.0.0.1:<ephemeral>, with a
// throwaway data dir under ./.l0-tmp (deleted at the end). Node only:
//   node scripts/check-board-bridge.mjs   (or: npm run check:board-bridge)
//
// Proves: the bridge serves the pinned page; adds the bearer in main (whoami = owner); keeps the token out of the
// page and out of every response/log; enforces the PAGE and RELAY allowlists in main with the right request_id
// prefixes; treats an upstream redirect as an error without forwarding the bearer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBridge as rawCreateBridge, GUEST_HTML_CSP } from '../src/main/board-bridge.mjs';
// Caller-auth (board-bridge.mjs): every request must carry the per-launch secret. The wrapper records each bridge's
// header by port so the helpers send it like the app's own webview/reader would; a test drops it with `undefined`.
const bridgeTokens = new Map();
const createBridge = (o) => { const b = rawCreateBridge(o); b.port().then((p) => bridgeTokens.set(p, b.callerHeaders())); return b; };
const tokenFor = (port) => bridgeTokens.get(port) || {};


const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const laneboard = path.join(root, 'vendor', 'laneboard');
const publicDir = path.join(laneboard, 'public');
const work = path.join(root, '.l0-tmp');

const load = (rel) => import(pathToFileURL(path.join(laneboard, rel)).href);

const results = [];
const seenBodies = []; // every response body the bridge ever produced, for the leak scan at the end
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

// A write carries X-Requested-With: laneboard exactly like the served page's write() (public/app.js); `headers`
// overrides (the browser-origin guard negatives in §1b drop it or forge Host).
function request(port, method, p, { body, raw, headers: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? Buffer.from(raw) : body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { connection: 'close', ...tokenFor(port), ...(data ? { 'content-type': 'application/json', 'content-length': data.length, 'x-requested-with': 'laneboard' } : {}), ...extra };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); seenBodies.push(text); let j = null; try { j = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, text, json: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const { createBoard } = await load('src/board.mjs');
const { createServer } = await load('src/server.mjs');

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

let upstream, bridge, board, redirectBridge, redir, target;
try {
  // ---- upstream: local Laneboard on a throwaway data dir --------------------------------
  board = createBoard({ dataDir: work });
  const ownerToken = fs.readFileSync(board.bootstrapTokenFile, 'utf8').trim();
  upstream = createServer(board);
  await new Promise((res) => upstream.listen(0, '127.0.0.1', res));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

  const identity = (await request(upstream.address().port, 'GET', '/api/v1/whoami', {})).json; // no token -> null/401
  check('upstream whoami is unauthenticated without a bearer', !identity || identity.error === 'unauthorized', identity);

  // Seed one task + one open ask + one inbox item in the upstream (owner setup), so page/relay writes have real
  // targets and their request_id prefixes land in the journal. This is upstream setup, not a bridge assertion.
  const seedWrite = (op, target_id, data, extra = {}) => board.write(ownerToken, { version: 1, request_id: `seed-${op}-${target_id}`, op, target_id, data, ...extra });
  seedWrite('task.create', 'T-1', { title: 'POC task', status: 'open', steps: [{ id: 's1', label: 'do it', zone: 'build', state: 'todo' }] }, { expected_revision: 0 });
  board.write(ownerToken, { version: 1, request_id: 'seed-ask-1', op: 'ask.raise', target_id: 'T-1', data: { text: 'Proceed?', options: [{ key: 'a', label: 'Yes' }] } });
  board.write(ownerToken, { version: 1, request_id: 'seed-inb-1', op: 'inbox.submit', target_id: 'T-1', data: { kind: 'ask', text: 'Proceed?' } });
  // Read the seeded state as the owner: the task is `internal`, so an unauthenticated GET /api/v1/state
  // would return only public records (none) and the ids/revs below would be undefined.
  const seeded = board.view(ownerToken);

  // ---- the bridge, bearer held only in this closure ------------------------------------
  bridge = createBridge({ upstreamOrigin, getToken: () => ownerToken, publicDir: path.join(publicDir) });
  const port = await bridge.port();

  // 1. pinned page served through the bridge
  const page = await request(port, 'GET', '/');
  check('GET / serves the pinned page (200 + Laneboard marker)', page.status === 200 && page.text.includes('Zumia · Laneboard') && page.text.includes('id="app"'), { status: page.status });
  const csp = page.headers['content-security-policy'] || '';
  check("GET / carries a CSP with connect-src 'self' (closes guest ws/wss leak)", csp === GUEST_HTML_CSP && /(^|; )connect-src 'self'(;|$)/.test(csp) && !/wss?:/.test(csp), csp);
  const vendorSrc = fs.readFileSync(path.join(laneboard, 'src', 'server.mjs'), 'utf8');
  check('guest CSP is the same string the vendored Laneboard server sends', vendorSrc.includes(GUEST_HTML_CSP));
  const pageScript = await request(port, 'GET', '/app.js');
  check('GET /app.js serves the pinned script', pageScript.status === 200 && pageScript.text.includes('authHeaders'));
  // G5(i) hardening (GATE-G5I-WAIVER.md): nosniff on static + proxied responses, and the guest CSP on SVG too.
  check('static responses carry X-Content-Type-Options: nosniff', pageScript.headers['x-content-type-options'] === 'nosniff' && page.headers['x-content-type-options'] === 'nosniff');
  const svg = await request(port, 'GET', '/favicon.svg');
  check('an SVG is served with the guest CSP and nosniff', svg.status === 200 && svg.headers['content-security-policy'] === GUEST_HTML_CSP && svg.headers['x-content-type-options'] === 'nosniff', { status: svg.status, csp: svg.headers['content-security-policy'] });
  const proxied = await request(port, 'GET', '/healthz');
  check('a proxied upstream read carries X-Content-Type-Options: nosniff', proxied.status === 200 && proxied.headers['x-content-type-options'] === 'nosniff', { status: proxied.status });

  // 1b. browser-origin guard: a foreign Host (DNS rebinding) is refused on reads and writes; a write without
  //     X-Requested-With: laneboard (a cross-site text/plain simple POST) is refused before it reaches upstream.
  {
    const seq0 = board.state.seq;
    const rebindRead = await request(port, 'GET', '/api/v1/state', { headers: { host: 'evil.example' } });
    check('foreign Host on a read -> 403 forbidden_host (no owner state through a rebinding page)', rebindRead.status === 403 && rebindRead.json?.error === 'forbidden_host', rebindRead.json);
    const rebindWrite = await request(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: 'rebind-1', op: 'task.update', target_id: 'T-1', data: { status: 'doing' } }, headers: { host: `evil.example:${port}` } });
    check('foreign Host on a write -> 403 forbidden_host', rebindWrite.status === 403 && rebindWrite.json?.error === 'forbidden_host', rebindWrite.json);
    const simplePost = await request(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: 'csrf-1', op: 'task.update', target_id: 'T-1', data: { status: 'doing' } }, headers: { 'content-type': 'text/plain', 'x-requested-with': undefined } });
    check('cross-site simple POST (text/plain, no X-Requested-With) -> 403 csrf_header_required', simplePost.status === 403 && simplePost.json?.error === 'csrf_header_required', simplePost.json);
    const lh = await request(port, 'GET', '/', { headers: { host: `localhost:${port}` } });
    check('localhost:<port> Host is accepted (same bridge)', lh.status === 200);
    check('none of the refused requests reached upstream (journal seq unchanged)', board.state.seq === seq0, { seq0, seq: board.state.seq });
    // Fable/Sol bridge gate 10-10, condition 2: the two browser guards stay the FIRST checks (ahead of auth and any
    // upstream call), and the bridge never answers CORS -- a preflight gets 405 with no Access-Control-* header.
    const pre = await request(port, 'OPTIONS', '/api/v1/write', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-requested-with,content-type' } });
    const acHeaders = [pre, page, lh].flatMap((r) => Object.keys(r.headers).filter((h) => h.startsWith('access-control-')));
    check('CORS preflight -> 405, and no response carries an Access-Control-* header', pre.status === 405 && acHeaders.length === 0, { status: pre.status, acHeaders });
    const src = fs.readFileSync(path.join(root, 'src', 'main', 'board-bridge.mjs'), 'utf8');
    const handler = src.slice(src.indexOf('http.createServer('));
    const at = (needle) => handler.indexOf(needle);
    const order = { host: at("'forbidden_host'"), csrf: at("'csrf_header_required'"), proxyWrite: at('proxyWrite('), locked: at("{ error: 'locked' }"), upstream: at('upstreamFetch(') };
    check('source: forbidden_host then csrf_header_required are the first two checks of the handler (before the lock check and any upstream call); no Access-Control in the file', order.host > 0 && order.host < order.csrf && order.csrf < order.proxyWrite && order.csrf < order.locked && order.csrf < order.upstream && !/access-control/i.test(src), order);
  }

  // 1c. caller-auth (security fix, GATE-B3-SECURITY C1): a recording mock upstream, so what reached it is observable.
  {
    const seen = [];
    const mock = http.createServer((r, res) => { seen.push({ method: r.method, url: r.url }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
    await new Promise((res) => mock.listen(0, '127.0.0.1', res));
    const mk = (extra = {}) => createBridge({ upstreamOrigin: `http://127.0.0.1:${mock.address().port}`, getToken: () => 'tok', publicDir, ...extra });
    const b = mk(); const bp = await b.port();
    const noTok = { 'x-zumi-bridge-token': undefined };
    try {
      const secret = b.callerHeaders()['x-zumi-bridge-token'];
      check('caller secret is >= 32 random bytes (64 hex chars)', /^[0-9a-f]{64,}$/.test(secret));
      const n0 = seen.length;
      const r1 = await request(bp, 'GET', '/api/v1/state', { headers: noTok });
      check('no token: GET /api/v1/state -> 401, nothing reached upstream', r1.status === 401 && seen.length === n0, r1.json);
      const r2 = await request(bp, 'GET', '/api/v1/state');
      check('valid token: GET /api/v1/state -> 200', r2.status === 200 && seen.length === n0 + 1);
      const r3 = await request(bp, 'GET', '/api/v1/state', { headers: { 'x-zumi-bridge-token': secret.slice(0, -1) + (secret.endsWith('0') ? '1' : '0') } });
      check('wrong token (one char off) -> 401', r3.status === 401);
      check('no token on page, healthz, write, static asset and CORS preflight -> 401 each', (await Promise.all([
        request(bp, 'GET', '/', { headers: noTok }), request(bp, 'GET', '/app.js', { headers: noTok }), request(bp, 'GET', '/healthz', { headers: noTok }),
        request(bp, 'POST', '/api/v1/write', { body: { op: 'task.update' }, headers: noTok }), request(bp, 'OPTIONS', '/api/v1/write', { headers: noTok }),
      ])).every((r) => r.status === 401) && seen.length === n0 + 1);
      for (const route of ['/api/v1/inbox?lane=cos', '/api/v1/compact/preview?task=T-1', '/api/v1/msg', '/api/v1/nope', '/api/other']) {
        const r = await request(bp, 'GET', route);
        check(`unlisted ${route.split('?')[0]} with a valid token -> 404, never forwarded`, r.status === 404, r.status);
      }
      check('no unlisted route reached upstream', seen.length === n0 + 1, seen);
      const msg = await request(bp, 'POST', '/api/v1/msg', { body: { to: 'cos', body: 'x' } });
      check('POST /api/v1/msg with a valid token -> 405 (never proxied)', msg.status === 405);
      const wrongHost = await request(bp, 'GET', '/api/v1/state', { headers: { host: 'evil.example' } });
      check('wrong Host with a valid token -> 403 forbidden_host', wrongHost.status === 403 && wrongHost.json?.error === 'forbidden_host');
      // listed routes: every route the page fetches
      const listed = ['/healthz', '/api/v1/state?v=2', '/api/v1/whoami', '/api/v1/turns?lane=a&limit=20', '/api/v1/events?after=0&limit=100', '/api/v1/quota', '/api/v1/tokens', '/api/v1/media/att-1', '/api/v1/media/att-1/link', '/api/v1/media/abc_1?w=200', '/api/stats'];
      const rs = []; for (const route of listed) rs.push((await request(bp, 'GET', route)).status);
      check('every route the page fetches (incl. /api/stats) is proxied with a valid token', rs.every((s) => s === 200), rs);
      const nS = seen.length;
      const stPost = await request(bp, 'POST', '/api/stats', { body: {} }); const stHead = await request(bp, 'HEAD', '/api/stats');
      check('/api/stats: GET only (same rule as Electron 0.2.10) -- POST and HEAD refused, nothing forwarded', stPost.status === 405 && stHead.status === 405 && seen.length === nS, seen.slice(nS));
      check('/api/stats GET reaches upstream as GET /api/stats', seen.some((s) => s.method === 'GET' && s.url === '/api/stats'));
      // session bootstrap: one-time nonce -> HttpOnly SameSite=Strict cookie; the nonce is single-use
      const su = new URL(await b.sessionUrl());
      const boot = await request(bp, 'GET', su.pathname + su.search + '&embed=1', { headers: noTok });
      const cookie = String(boot.headers['set-cookie'] || '');
      check('session URL: 302 to / (embed kept, nonce dropped) + HttpOnly; SameSite=Strict cookie, no token in the URL', boot.status === 302 && boot.headers.location === '/?embed=1' && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && !boot.headers.location.includes(secret), { loc: boot.headers.location });
      check('Set-Cookie is exactly `zumi_bridge_<port>=<secret>; Path=/; HttpOnly; SameSite=Strict` (Path=/ so /api/* reads carry it; a narrower Path blanks the board)', cookie === `zumi_bridge_${bp}=${secret}; Path=/; HttpOnly; SameSite=Strict`, cookie.replace(secret, '<secret>'));
      const again = await request(bp, 'GET', su.pathname + su.search, { headers: noTok });
      check('the session nonce is single-use (replay -> 401)', again.status === 401 && !again.headers['set-cookie']);
      const viaCookie = await request(bp, 'GET', '/api/v1/state', { headers: { ...noTok, cookie: cookie.split(';')[0] } });
      const pageViaCookie = await request(bp, 'GET', '/', { headers: { ...noTok, cookie: cookie.split(';')[0] } });
      check('the cookie from the session URL authenticates reads and the page', viaCookie.status === 200 && pageViaCookie.status === 200);
      const badNonce = await request(bp, 'GET', '/__bridge-session?n=' + '0'.repeat(64), { headers: noTok });
      check('a guessed nonce -> 401', badNonce.status === 401);
      const foreignHost = await request(bp, 'GET', su.pathname + '?n=x', { headers: { ...noTok, host: 'evil.example' } });
      check('session URL on a foreign Host -> 403', foreignHost.status === 403);
      check('the caller secret never appears in any response body or Location header', ![r1, r2, boot, again, viaCookie, pageViaCookie].some((r) => r.text.includes(secret) || String(r.headers.location || '').includes(secret)));
      // S1: cookie and nonce negatives (GATE-BRIDGE-AUTH): name+value both matter, and a nonce expires.
      const ck = `zumi_bridge_${bp}`;
      const wrongVal = await request(bp, 'GET', '/api/v1/state', { headers: { ...noTok, cookie: `${ck}=${'0'.repeat(64)}` } });
      check('cookie with the right name and a wrong value -> 401', wrongVal.status === 401);
      const wrongName = await request(bp, 'GET', '/api/v1/state', { headers: { ...noTok, cookie: `zumi_bridge_${bp + 1}=${secret}` } });
      const bareName = await request(bp, 'GET', '/api/v1/state', { headers: { ...noTok, cookie: `zumi_bridge=${secret}` } });
      check('cookie with the right value under another name (other port / bare name) -> 401', wrongName.status === 401 && bareName.status === 401);
      const realNow = Date.now;
      const expiredUrl = new URL(await b.sessionUrl());
      Date.now = () => realNow() + 61_000;
      let expired; try { expired = await request(bp, 'GET', expiredUrl.pathname + expiredUrl.search, { headers: noTok }); } finally { Date.now = realNow; }
      check('a session nonce older than 60 s -> 401, no cookie', expired.status === 401 && !expired.headers['set-cookie']);
      // MUTATION PROOFS: with a guard removed the mutant accepts the bad request, so the assertion above would FAIL.
      const src0 = fs.readFileSync(path.join(root, 'src', 'main', 'board-bridge.mjs'), 'utf8');
      const mutate = async (name, from, to, probe) => {
        check(`mutation anchor present: ${name}`, src0.includes(from));
        const file = path.join(work, `mut-${name}.mjs`);
        fs.writeFileSync(file, src0.replace(from, to));
        const m = (await import(pathToFileURL(file).href)).createBridge({ upstreamOrigin: `http://127.0.0.1:${mock.address().port}`, getToken: () => 'tok', publicDir });
        const mp = await m.port();
        try { check(`mutation proof (${name}): guard removed -> the bad request is accepted`, await probe(mp, m.callerHeaders(), m)); } finally { await m.close(); }
      };
      await mutate('token-check', "if (!hasCallerToken(req)) return json(res, 401, { error: 'unauthorized' });", '', async (mp) => (await request(mp, 'GET', '/api/v1/state', { headers: noTok })).status === 200);
      await mutate('cookie-value', 'safeEqual(part.slice(i + 1).trim(), callerToken)', 'true', async (mp) => (await request(mp, 'GET', '/api/v1/state', { headers: { ...noTok, cookie: `zumi_bridge_${mp}=${'0'.repeat(64)}` } })).status === 200);
      await mutate('cookie-name', "part.slice(0, i).trim() === cookieName", 'true', async (mp, tok) => (await request(mp, 'GET', '/api/v1/state', { headers: { ...noTok, cookie: `zumi_bridge=${tok['x-zumi-bridge-token']}` } })).status === 200);
      await mutate('nonce-ttl', 'if (exp < Date.now())', 'if (false)', async (mp, tok, m) => {
        const u = new URL(await m.sessionUrl());
        Date.now = () => realNow() + 61_000;
        try { return (await request(mp, 'GET', u.pathname + u.search, { headers: noTok })).status === 302; } finally { Date.now = realNow; }
      });
      await mutate('allow-list', 'READ_ROUTES.has(p) || READ_ROUTE_PATTERNS.some((re) => re.test(p)) ||', "p.startsWith('/api/') ||", async (mp, tok) => (await request(mp, 'GET', '/api/v1/inbox?lane=cos', { headers: tok })).status === 200);
    } finally { await b.close(); await new Promise((res) => mock.close(res)); }
  }

  // 2. identity route through the bridge -> bearer was added in main
  const me = await request(port, 'GET', '/api/v1/whoami');
  check('GET /api/v1/whoami through the bridge returns the owner identity (bearer added in main)', me.status === 200 && me.json && me.json.role === 'owner' && me.json.name === 'owner', me.json);

  // 3. the token is never in the served page (the full-response leak scan runs at the end, over every body)
  check('served page HTML/JS contains no token string', !page.text.includes(ownerToken) && !pageScript.text.includes(ownerToken));

  // 4. PAGE channel: an allowed owner op changes status and succeeds with a zumi-ui- request_id
  const task = seeded?.tasks?.[0];
  const statusBefore = board.state.tasks['T-1']?.status;
  const pageWrite = await request(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: 'page-status-1', op: 'task.update', target_id: 'T-1', expected_revision: task?.rev, data: { status: 'doing' } } });
  check('PAGE channel: task.update (owner status change) succeeds', pageWrite.status === 200 && pageWrite.json?.ok === true && statusBefore === 'open' && board.state.tasks['T-1']?.status === 'doing', { from: statusBefore, to: board.state.tasks['T-1']?.status });

  // 5. PAGE channel refusals (RELEASE build: no ownerOps): token.issue / routing.* / roles.* / notify.set and
  //    irreversible deletes never reach upstream
  const releaseRefused = [['token.issue', 'sneaky', { role: 'owner' }], ['routing.set', 'T-1', { model: 'sonnet', effort: 'high' }], ['routing.reset', 'T-1', {}], ['roles.set', 'T-1', { role: 'plan', model: 'sonnet', effort: 'high' }], ['roles.reset', 'T-1', { role: 'plan' }], ['roles.escalate', 'T-1', { gate: 'g' }], ['notify.set', 'board', { coordinator_feedback: true }], ['task.delete', 'T-1', {}], ['step.delete', 'T-1/s1', {}], ['registry.set', 'T-1', {}]];
  const seqBefore = board.state.seq;
  for (const [op, targetId, data] of releaseRefused) {
    const r = await request(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: `page-${op}`, op, target_id: targetId, data } });
    check(`PAGE channel (release build): ${op} refused in main (403 forbidden_op)`, r.status === 403 && r.json?.error === 'forbidden_op', r.json);
  }
  check('release build: none of the refused ops reached upstream (journal seq unchanged, no role slot by owner)', board.state.seq === seqBefore && !board.state.roles?.['T-1'] && !board.state.routing?.['T-1'], { seqBefore, seqAfter: board.state.seq });

  // 5b. OWNER build (`ownerOps: true`, main.js passes OWNER_ADMIN): the page may set lane routing -- routing.set/reset
  //     (code slot) and roles.set/reset (plan/review/scout) reach upstream as the owner with a zumi-ui- request_id;
  //     everything else refused above stays refused (never token.*, notify.set, roles.escalate, deletes). The RELAY
  //     channel never gains them.
  {
    const ownerBridge = createBridge({ upstreamOrigin, getToken: () => ownerToken, publicDir, ownerOps: true });
    const truthyBridge = createBridge({ upstreamOrigin, getToken: () => ownerToken, publicDir, ownerOps: 'yes' });
    try {
      const op0 = await ownerBridge.port();
      const w = (op, target_id, data) => request(op0, 'POST', '/api/v1/write', { body: { version: 1, request_id: `owner-${op}-${Math.random().toString(36).slice(2)}`, op, target_id, data } });
      const plan = await w('roles.set', 'T-1', { role: 'plan', model: 'sonnet', effort: 'xhigh' });
      const slot = board.view(ownerToken).tasks.find((t) => t.id === 'T-1')?.roles?.plan;
      check('owner build: roles.set (plan slot) forwarded, 200, slot set by the owner', plan.status === 200 && plan.json?.ok === true && slot?.model === 'sonnet' && slot?.effort === 'xhigh' && slot?.by === 'owner', { status: plan.status, slot });
      const code = await w('routing.set', 'T-1', { model: 'opus', effort: 'high' });
      const codeSlot = board.view(ownerToken).tasks.find((t) => t.id === 'T-1')?.roles?.code;
      check('owner build: routing.set (code slot) forwarded, 200, by owner', code.status === 200 && codeSlot?.model === 'opus' && codeSlot?.by === 'owner', { status: code.status, codeSlot });
      const noHaiku = await w('roles.set', 'T-1', { role: 'review', model: 'haiku', effort: 'low' });
      check('owner build: the board itself still refuses haiku for review (400 review_model_not_allowed, not a bridge decision)', noHaiku.status === 400 && noHaiku.json?.error === 'review_model_not_allowed', noHaiku.json);
      const rr = await w('roles.reset', 'T-1', { role: 'plan' });
      const cr = await w('routing.reset', 'T-1', {});
      const after = board.view(ownerToken).tasks.find((t) => t.id === 'T-1')?.roles;
      check('owner build: roles.reset + routing.reset forwarded, slots back to defaults', rr.status === 200 && cr.status === 200 && after?.plan?.by !== 'owner' && after?.code?.by !== 'owner', { rr: rr.status, cr: cr.status, plan: after?.plan?.by, code: after?.code?.by });
      const ids = board.events(ownerToken, 0, 1000).filter((e) => /^(routing|roles)\./.test(e.op)).map((e) => String(e.request_id));
      check('owner build: lane-routing writes carry the zumi-ui- prefix in the journal', ids.length === 4 && ids.every((r) => r.startsWith('zumi-ui-')), ids);
      for (const [op, targetId, data] of releaseRefused.filter(([op]) => !['routing.set', 'routing.reset', 'roles.set', 'roles.reset'].includes(op))) {
        const r = await w(op, targetId, data);
        check(`owner build: ${op} still refused (403 forbidden_op)`, r.status === 403 && r.json?.error === 'forbidden_op', r.json);
      }
      const relayRoles = await ownerBridge.relay('roles.set', { target_id: 'T-1', data: { role: 'plan', model: 'opus', effort: 'low' } });
      check('owner build: RELAY channel never forwards roles.set (403)', relayRoles.status === 403 && JSON.parse(relayRoles.text).error === 'forbidden_op');
      const tp = await truthyBridge.port();
      const truthy = await request(tp, 'POST', '/api/v1/write', { body: { version: 1, request_id: 'truthy-1', op: 'roles.set', target_id: 'T-1', data: { role: 'plan', model: 'opus', effort: 'low' } } });
      check('ownerOps must be exactly true: a truthy non-boolean keeps the 403', truthy.status === 403 && truthy.json?.error === 'forbidden_op', truthy.json);
      const ownerState = await request(op0, 'GET', '/api/v1/state');
      check('owner build: the page state has no freshness / notify either (both ops stay refused in every build)', ownerState.status === 200 && ownerState.json && !('freshness' in ownerState.json) && !('notify' in ownerState.json) && Array.isArray(ownerState.json.tasks), Object.keys(ownerState.json || {}).filter((k) => k === 'freshness' || k === 'notify'));
    } finally { await ownerBridge.close(); await truthyBridge.close(); }
  }

  // 5f. J-05 machines-app-tab (Laneboard 9bfe62d): the owner's pin toggle (pin.set) and machine picker (machines.set)
  //     reach upstream from the OWNER build only. Release build: refused in main. Owner build holding another credential:
  //     forwarded, and the board's own x-roles decide (pin.set owner only; machines.set owner or coordinator): a reporter
  //     is refused both, a coordinator is refused pin.set and allowed machines.set. The RELAY channel never gains them.
  {
    const PIN_MACHINE = [['pin.set', { pinned: true }], ['machines.set', { coordinator: 'main', worker_machines: ['spare'] }]];
    const seq0 = board.state.seq;
    for (const [op, data] of PIN_MACHINE) {
      const r = await request(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: `rel-${op}`, op, target_id: 'T-1', data } });
      check(`release build: ${op} refused in main (403 forbidden_op)`, r.status === 403 && r.json?.error === 'forbidden_op', r.json);
    }
    check('release build: pin.set / machines.set never reached upstream', board.state.seq === seq0 && !board.state.pins?.['T-1'] && !board.state.machines?.['T-1'], { seq0, seq: board.state.seq });
    const reporterToken = board.write(ownerToken, { version: 1, request_id: 'seed-reporter-5d', op: 'token.issue', target_id: 'reporter-5d', data: { role: 'reporter', label: 'reporter 5d' } }).token;
    const ownerBridge = createBridge({ upstreamOrigin, getToken: () => ownerToken, publicDir, ownerOps: true });
    const reporterBridge = createBridge({ upstreamOrigin, getToken: () => reporterToken, publicDir, ownerOps: true });
    try {
      const op0 = await ownerBridge.port(), rp = await reporterBridge.port();
      const w = (p, op, data) => request(p, 'POST', '/api/v1/write', { body: { version: 1, request_id: `pm-${op}-${Math.random().toString(36).slice(2)}`, op, target_id: 'T-1', data } });
      const t1 = () => board.view(ownerToken).tasks.find((t) => t.id === 'T-1');
      const rSeq = board.state.seq;
      for (const [op, data] of PIN_MACHINE) {
        const r = await w(rp, op, data);
        check(`owner build, reporter credential: ${op} refused by the board (403, not a bridge decision)`, r.status === 403 && r.json?.error !== 'forbidden_op', r.json);
      }
      check('reporter credential: nothing pinned, no machines stored', board.state.seq === rSeq && !t1()?.pinned && !t1()?.coordinator, { rSeq, seq: board.state.seq });
      const pin = await w(op0, 'pin.set', { pinned: true });
      check('owner build: pin.set forwarded, 200, T-1 pinned', pin.status === 200 && pin.json?.ok === true && t1()?.pinned === true, { status: pin.status, pinned: t1()?.pinned });
      const mc = await w(op0, 'machines.set', { coordinator: 'main', worker_machines: ['spare'] });
      check('owner build: machines.set forwarded, 200, T-1 coordinator main / workers spare', mc.status === 200 && t1()?.coordinator === 'main' && t1()?.worker_machines?.join() === 'spare', { status: mc.status, coordinator: t1()?.coordinator, workers: t1()?.worker_machines });
      const unpin = await w(op0, 'pin.set', { pinned: false });
      check('owner build: pin.set pinned=false unpins', unpin.status === 200 && !t1()?.pinned, { status: unpin.status });
      const ids = board.events(ownerToken, 0, 100000).filter((e) => e.op === 'pin.set' || e.op === 'machines.set').map((e) => String(e.request_id));
      check('owner build: pin/machine writes carry the zumi-ui- prefix in the journal', ids.length === 3 && ids.every((r) => r.startsWith('zumi-ui-')), ids);
      // coordinator credential (the board's machines.set rule is owner|coordinator; the app does not widen or narrow it)
      const coordToken = board.write(ownerToken, { version: 1, request_id: 'seed-coord-5d', op: 'token.issue', target_id: 'coord-5d', data: { role: 'coordinator', label: 'coord 5d', lane: 'coordination' } }).token;
      const coordBridge = createBridge({ upstreamOrigin, getToken: () => coordToken, publicDir, ownerOps: true });
      try {
        const cp = await coordBridge.port();
        const cPin = await w(cp, 'pin.set', { pinned: true });
        check('owner build, coordinator credential: pin.set refused by the board (403 forbidden_for_role, owner only)', cPin.status === 403 && cPin.json?.error === 'forbidden_for_role' && !t1()?.pinned, cPin.json);
        // T-1's machines were picked by the owner above: the board keeps an owner pick from a coordinator (409 owner_set)
        const cOver = await w(cp, 'machines.set', { coordinator: 'main', worker_machines: ['laptop'] });
        check('owner build, coordinator credential: machines.set over the owner pick refused by the board (409 owner_set)', cOver.status === 409 && cOver.json?.error === 'owner_set' && t1()?.worker_machines?.join() === 'spare', { status: cOver.status, error: cOver.json?.error });
        board.write(ownerToken, { version: 1, request_id: 'seed-T-2-5d', op: 'task.create', target_id: 'T-2', data: { title: 'machines by coordinator', steps: [{ id: 's1', label: 'x', zone: 'build', state: 'todo' }] }, expected_revision: 0 });
        const cMc = await request(cp, 'POST', '/api/v1/write', { body: { version: 1, request_id: 'pm-coord-T-2', op: 'machines.set', target_id: 'T-2', data: { coordinator: 'main', worker_machines: ['laptop'] } } });
        const t2 = board.view(ownerToken).tasks.find((t) => t.id === 'T-2');
        check('owner build, coordinator credential: machines.set ALLOWED by the board on a task without an owner pick (x-roles owner|coordinator)', cMc.status === 200 && t2?.worker_machines?.join() === 'laptop' && t2?.machines_by === 'coordinator', { status: cMc.status, workers: t2?.worker_machines, by: t2?.machines_by });
      } finally { await coordBridge.close(); }
      for (const [op, data] of PIN_MACHINE) {
        const relay = await ownerBridge.relay(op, { target_id: 'T-1', data });
        check(`owner build: RELAY channel never forwards ${op} (403)`, relay.status === 403 && JSON.parse(relay.text).error === 'forbidden_op');
      }
    } finally { await ownerBridge.close(); await reporterBridge.close(); }
  }

  // 5c. review v7 should-fix: the page never gets a setting control it cannot write. The upstream state carries
  //     freshness + notify (Laneboard 0595f29); the state read through the bridge drops both, keeps the rest (stale_text,
  //     tasks), and freshness.set itself stays refused in main.
  {
    const direct = board.view(ownerToken);
    check('upstream (as the owner) does carry freshness and notify, so the drop below is meaningful', direct && typeof direct.freshness === 'object' && direct.notify && 'stale_text' in direct, Object.keys(direct || {}).filter((k) => ['freshness', 'notify', 'stale_text'].includes(k)));
    const st = await request(port, 'GET', '/api/v1/state');
    check('page state through the bridge: no freshness, no notify', st.status === 200 && st.json && !('freshness' in st.json) && !('notify' in st.json), Object.keys(st.json || {}));
    check('page state through the bridge: the rest is intact (tasks, stale_text, seq)', Array.isArray(st.json?.tasks) && st.json.tasks.some((t) => t.id === 'T-1') && Array.isArray(st.json?.stale_text) && st.json?.seq === direct.seq, { seq: st.json?.seq, want: direct.seq });
    const seq0 = board.state.seq;
    const fr = await request(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: 'page-fresh-1', op: 'freshness.set', target_id: 'board', data: { stale_h: 6 } } });
    check('freshness.set from the page is still refused in main (403 forbidden_op), nothing reached upstream', fr.status === 403 && fr.json?.error === 'forbidden_op' && board.state.seq === seq0, fr.json);
    const src = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
    check('pinned page hides both controls when the field is absent (the contract the drop relies on)', /const f = S\.data\?\.freshness;\s*\n\s*if \(!f\) return '';/.test(src) && /const n = S\.data\?\.notify;\s*\n\s*if \(!n\) return '';/.test(src));
  }

  // 5d. T-31 alpha.4 item 2: the app's Board follows the app theme even though the owner's server prefs say theme=dark (the live
  //     board's tok-1 prefs, read on the VPS 30-10). The page boots with #theme= from the shell, then adoptServerPrefs (public/app.js)
  //     copies me.prefs over it once per load; so a Tauri bridge (hostTheme: true) answers the page's state with me.prefs.theme/accent
  //     from the theme the page was loaded with (?zumiTheme=), and only that. Electron's bridge (no option) passes me.prefs through.
  {
    const me0 = board.view(ownerToken).me;
    board.write(ownerToken, { version: 1, request_id: 'seed-prefs-dark', op: 'prefs.set', target_id: me0.token_id, data: { lang: 'vi', theme: 'dark' } });
    check('upstream: the owner has server prefs theme=dark, as on the live board', board.view(ownerToken).me?.prefs?.theme === 'dark', board.view(ownerToken).me?.prefs);
    const themed = createBridge({ upstreamOrigin, getToken: () => ownerToken, publicDir, hostTheme: true });
    try {
      const tp = await themed.port();
      const prefsAfter = async (theme) => {
        const pg = await request(tp, 'GET', `/?embed=1&lang=en&zumiTheme=${theme}`);
        const st = await request(tp, 'GET', '/api/v1/state');
        return { page: pg.status, prefs: st.json?.me?.prefs };
      };
      const white = await prefsAfter('white');
      check('hostTheme: page loaded with zumiTheme=white -> state me.prefs theme=light, accent=neutral (server dark no longer wins)', white.page === 200 && white.prefs?.theme === 'light' && white.prefs?.accent === 'neutral' && white.prefs?.lang === 'vi', white);
      const blue = await prefsAfter('blue');
      check('hostTheme: zumiTheme=blue -> theme=dark, accent=blue', blue.prefs?.theme === 'dark' && blue.prefs?.accent === 'blue', blue);
      const black = await prefsAfter('black');
      check('hostTheme: zumiTheme=black -> theme=dark, accent=neutral', black.prefs?.theme === 'dark' && black.prefs?.accent === 'neutral', black);
      const junk = await prefsAfter('pink');
      check('hostTheme: an unknown zumiTheme keeps the last page theme (black), never an invented one', junk.prefs?.theme === 'dark' && junk.prefs?.accent === 'neutral', junk);
      check('hostTheme: the upstream prefs themselves are untouched (no prefs.set written)', board.view(ownerToken).me?.prefs?.theme === 'dark' && !board.view(ownerToken).me?.prefs?.accent, board.view(ownerToken).me?.prefs);
    } finally { await themed.close(); }
    await request(port, 'GET', '/?embed=1&zumiTheme=white');
    const plain = await request(port, 'GET', '/api/v1/state');
    check('no hostTheme (Electron): zumiTheme is ignored, me.prefs passes through (theme=dark)', plain.json?.me?.prefs?.theme === 'dark' && !('accent' in (plain.json?.me?.prefs || {})), plain.json?.me?.prefs);
  }

  // 5e. T-31 alpha.5: the vendored page styles no scrollbar, so the Board showed WebView2's wide grey default (owner shot
  //     scroll.png, 30-10). A Tauri bridge (hostTheme: true) links one host stylesheet into the page it serves; the CSP
  //     (style-src 'self') allows it because the bridge serves it. The vendored files are not edited.
  {
    const themed = createBridge({ upstreamOrigin, getToken: () => ownerToken, publicDir, hostTheme: true });
    try {
      const tp = await themed.port();
      const pg = await request(tp, 'GET', '/?embed=1&lang=en&zumiTheme=blue');
      const link = /<link rel="stylesheet" href="\/__zumi-host\/board-guest\.css">\s*<\/head>/.test(pg.text);
      check('hostTheme: the page links the host guest stylesheet last in <head>', pg.status === 200 && link);
      check('hostTheme: the page keeps the guest CSP', pg.headers['content-security-policy'] === GUEST_HTML_CSP, pg.headers['content-security-policy']);
      const css = await request(tp, 'GET', '/__zumi-host/board-guest.css');
      check('hostTheme: guest stylesheet served as text/css, same-origin', css.status === 200 && /^text\/css/.test(css.headers['content-type'] || ''), css.status);
      // T-31 alpha.6 (owner 30-10): under blue the Board kept the black .dark
      // surfaces. The one literal block allowed is the blue surface block, and its values must be the shell's blue tokens.
      const blueBlock = css.text.match(/html\.dark\[data-accent="blue"\]\s*\{([^}]*--background[^}]*)\}/)?.[1] || '';
      const rest = blueBlock ? css.text.replace(blueBlock, '') : css.text;
      check('guest stylesheet: thin scrollbar on every scroller, theme tokens only (outside the blue surface block)', /scrollbar-width:\s*thin/.test(css.text) && /scrollbar-color:\s*var\(--input\) transparent/.test(css.text) && /data-accent="blue"/.test(css.text) && !/#[0-9a-f]{3,8}\b/i.test(rest), css.text.slice(0, 120));
      const shellBlue = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'next-tokens', 'tokens-a.css'), 'utf8').match(/html\.zumi-next\[data-theme="blue"\]\s*\{([^}]*)\}/)?.[1] || '';
      const tok = (src, name) => src.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
      const SURFACE = ['--background', '--card', '--muted', '--muted-foreground', '--border', '--input', '--accent'];
      const surfaceDiff = SURFACE.filter((n) => !tok(shellBlue, n) || tok(blueBlock, n) !== tok(shellBlue, n)).map((n) => `${n}=${tok(blueBlock, n)} (shell ${tok(shellBlue, n)})`);
      check(`blue: the injected CSS sets the Board bg to the shell blue token (--background ${tok(shellBlue, '--background')})`, !!blueBlock && tok(blueBlock, '--background') === tok(shellBlue, '--background'), tok(blueBlock, '--background'));
      check('blue: every Board surface token (bg, cards, panels, borders, muted text) equals the shell blue token', !!blueBlock && surfaceDiff.length === 0, surfaceDiff.join(' '));
      check('black/white: no surface token set outside the blue selector', !/--background|--card|--muted/.test(rest), rest.slice(0, 200));
      const vendored = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
      check('vendored index.html itself has no host link (not edited)', !vendored.includes('__zumi-host'));
    } finally { await themed.close(); }
    const plainPage = await request(port, 'GET', '/?embed=1');
    check('no hostTheme (Electron): page served as vendored, no host stylesheet link', plainPage.status === 200 && !plainPage.text.includes('__zumi-host'));
    const plainCss = await request(port, 'GET', '/__zumi-host/board-guest.css');
    check('no hostTheme (Electron): host stylesheet path is 404', plainCss.status === 404, plainCss.status);
  }

  // 6. RELAY channel: the three allowed ops succeed with a zumi-relay- request_id
  const ask = seeded?.asks?.find((a) => a.status === 'open');
  const relayAsk = await bridge.relay('ask.answer', { target_id: ask?.id, expected_revision: ask?.rev, data: { choice: 'a' } });
  check('RELAY channel: ask.answer succeeds (200)', relayAsk.status === 200 && JSON.parse(relayAsk.text).ok === true, relayAsk.text.slice(0, 80));
  // The bridge holds the board's OWNER token (whoami = owner), so the relay must use an owner-writable kind:
  // `receipt` is coordinator-only (ops.mjs) and needs an owner-message parent — it would 403 here. `note` is the
  // generic owner kind, which is what "Zumi relaying from chat" writes.
  const relayFb = await bridge.relay('feedback.add', { target_id: 'T-1', data: { kind: 'note', text: 'Đổi: x\nLịch: y\nBước tiếp: z' } });
  check('RELAY channel: feedback.add succeeds (200)', relayFb.status === 200 && JSON.parse(relayFb.text).ok === true, relayFb.text.slice(0, 80));
  const relayInbox = await bridge.relay('inbox.submit', { target_id: 'T-1', data: { kind: 'report', text: 'ok' } });
  check('RELAY channel: inbox.submit succeeds (200)', relayInbox.status === 200 && JSON.parse(relayInbox.text).ok === true, relayInbox.text.slice(0, 80));

  // 7. RELAY channel refusal: any other op (task.update) is refused in main
  const relayBad = await bridge.relay('task.update', { target_id: 'T-1', expected_revision: 1, data: { status: 'doing' } });
  check('RELAY channel: task.update refused in main (403 forbidden_op)', relayBad.status === 403 && JSON.parse(relayBad.text).error === 'forbidden_op');

  // 8. request_id prefixes are visible in the upstream journal
  const ev = board.events(ownerToken, 0, 500);
  const reqIds = ev.map((e) => e.request_id);
  check('upstream journal shows zumi-ui- prefix for a page write', reqIds.some((r) => String(r).startsWith('zumi-ui-')));
  check('upstream journal shows zumi-relay- prefix for a relay write', reqIds.some((r) => String(r).startsWith('zumi-relay-')));

  // 9. redirects from upstream are errors; the bearer is not forwarded to the redirect target
  let firstHopAuth = null, targetHits = 0;
  target = http.createServer((r, res) => { targetHits++; res.writeHead(200); res.end('the redirect was followed'); });
  await new Promise((res) => target.listen(0, '127.0.0.1', res));
  redir = http.createServer((r, res) => { firstHopAuth = r.headers.authorization || null; res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/elsewhere` }); res.end(); });
  await new Promise((res) => redir.listen(0, '127.0.0.1', res));
  if (process.env.L0_FORCE_THROW) throw new Error('forced'); // TEMP
  redirectBridge = createBridge({ upstreamOrigin: `http://127.0.0.1:${redir.address().port}`, getToken: () => ownerToken, publicDir });
  const rport = await redirectBridge.port();
  const redirectResp = await request(rport, 'GET', '/api/v1/whoami');
  await redirectBridge.close();
  await new Promise((res) => redir.close(res));
  await new Promise((res) => target.close(res));
  check('upstream redirect is an error (502 upstream_redirect)', redirectResp.status === 502 && redirectResp.json?.error === 'upstream_redirect', redirectResp.json);
  // firstHopAuth proves the bridge HAD a bearer to send (so the targetHits check is meaningful); targetHits is 0
  // because `redirect: 'manual'` makes the bridge refuse the 3xx instead of following it.
  check('bearer is not sent to the redirect target', targetHits === 0 && firstHopAuth === `Bearer ${ownerToken}`, { targetHits });

  // 10. live-shaped auth (owner-token header ruling 02-10): the owner token rides in `X-Laneboard-Token` as the RAW
  //     token (no "Bearer " prefix), Basic keeps the Authorization header, a write adds the CSRF header, and the old
  //     side header is gone. A tiny echo upstream records exactly what the bridge sent — the pinned Laneboard in
  //     vendor/ predates this header, so it cannot observe it.
  {
    const sent = [];
    const echo = http.createServer((r, res) => { sent.push({ url: r.url, method: r.method, headers: r.headers }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"role":"owner"}'); });
    await new Promise((res) => echo.listen(0, '127.0.0.1', res));
    const liveEchoBridge = createBridge({ upstreamOrigin: `http://127.0.0.1:${echo.address().port}`, getToken: () => ownerToken, getBasicAuth: () => ({ user: 'u', pass: 'p' }), publicDir });
    try {
      const lp = await liveEchoBridge.port();
      await request(lp, 'GET', '/api/v1/whoami');
      await liveEchoBridge.relay('ask.answer', { target_id: 'T-1', data: { choice: 'a' } });
      const get = sent.find((s) => s.method === 'GET');
      const post = sent.find((s) => s.method === 'POST');
      check('live auth: owner token sent as raw X-Laneboard-Token (no "Bearer " prefix)', get?.headers['x-laneboard-token'] === ownerToken && !String(get?.headers['x-laneboard-token']).startsWith('Bearer '));
      check('live auth: Basic keeps the Authorization header; the old side header is gone', /^Basic /.test(get?.headers.authorization || '') && !('x-zumi-owner-bearer' in (get?.headers || {})));
      check('live auth: a write adds the CSRF header and still carries the raw token', post?.headers['x-requested-with'] === 'laneboard' && post?.headers['x-laneboard-token'] === ownerToken);
    } finally { await liveEchoBridge.close(); await new Promise((res) => echo.close(res)); }
  }

  // 10b. B1 (alpha.3): the page's image upload (public/app.js uploadImage: POST /api/v1/upload, purpose=message) reaches the
  //      upstream through the bridge; the refusals happen in the bridge, before upstream. alpha.2 answered 405 here, so the
  //      composer toasted "Image not uploaded: method_not_allowed".
  {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const up = (query, headers = {}, raw = png) => request(port, 'POST', `/api/v1/upload?${query}`, { raw, headers: { 'content-type': 'image/png', ...headers } });
    const q = 'request_id=paste-b1-0001&task_id=T-1&name=shot.png&mime=image%2Fpng&purpose=message';
    const seq0 = board.state.seq;
    const ok = await up(q);
    check('B1: POST /api/v1/upload?purpose=message (image/png, page headers) -> 200 with an attachment id', ok.status === 200 && Boolean(ok.json?.id), { status: ok.status, body: ok.json });
    check('B1: the upload reached upstream (journal grew by one attachment.add)', board.state.seq === seq0 + 1, { seq0, seq: board.state.seq });
    const seq1 = board.state.seq;
    const noCsrf = await up(q.replace('paste-b1-0001', 'paste-b1-0002'), { 'x-requested-with': undefined });
    const badPurpose = await up(q.replace('paste-b1-0001', 'paste-b1-0003').replace('purpose=message', 'purpose=attachment'));
    const badMime = await up(q.replace('paste-b1-0001', 'paste-b1-0004'), { 'content-type': 'image/jpeg' });
    const badKey = await up(q.replace('paste-b1-0001', 'paste-b1-0005') + '&x=1');
    const tooBig = await up(q.replace('paste-b1-0001', 'paste-b1-0006'), {}, Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    check('B1: refused in the bridge: no CSRF header 403, purpose!=message 403, Content-Type!=mime 400, unknown query key 400, >5 MiB 413',
      noCsrf.status === 403 && badPurpose.status === 403 && badMime.status === 400 && badKey.status === 400 && tooBig.status === 413,
      { noCsrf: noCsrf.status, badPurpose: badPurpose.status, badMime: badMime.status, badKey: badKey.status, tooBig: tooBig.status });
    check('B1: none of the refused uploads reached upstream (journal seq unchanged)', board.state.seq === seq1, { seq1, seq: board.state.seq });
  }

  // 10c. B1 round 2 (review F2): the bridge itself enforces the 5 MiB cap. The upstream here is a stub that ACCEPTS any size,
  //      so a 413 can only come from the bridge; the assertions read the stub's own request list, not the journal.
  {
    const MiB = 1024 * 1024;
    const got = []; // every request the stub upstream receives: size so far and whether its body ended
    const accept = http.createServer((r, res) => {
      const rec = { method: r.method, url: r.url, bytes: 0, complete: false }; got.push(rec);
      r.on('data', (c) => { rec.bytes += c.length; });
      r.on('end', () => { rec.complete = true; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"id":"att-stub"}'); });
      r.on('error', () => {});
    });
    await new Promise((res) => accept.listen(0, '127.0.0.1', res));
    const capBridge = createBridge({ upstreamOrigin: `http://127.0.0.1:${accept.address().port}`, getToken: () => ownerToken, publicDir });
    try {
      const cp = await capBridge.port();
      const q = (id) => `request_id=${id}&task_id=T-1&name=big.png&mime=image%2Fpng&purpose=message`;
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const ctl = await request(cp, 'POST', `/api/v1/upload?${q('cap-ctl-0001')}`, { raw: png, headers: { 'content-type': 'image/png' } });
      check('B1 cap control: a small image through the stub upstream -> 200 and the stub saw exactly that one complete request', ctl.status === 200 && got.length === 1 && got[0].complete && got[0].bytes === png.length, { status: ctl.status, got });
      const n0 = got.length;
      const declared = await request(cp, 'POST', `/api/v1/upload?${q('cap-dec-0001')}`, { raw: Buffer.alloc(5 * MiB + 1, 1), headers: { 'content-type': 'image/png' } });
      check('B1: a >5 MiB image with Content-Length -> 413 from the bridge, ZERO calls reached the upstream stub', declared.status === 413 && got.length === n0, { status: declared.status, stubCalls: got.length - n0 });
      // chunked: no Content-Length, so only the streamed count can stop it (the stub may see the start of a request, never a complete one)
      const n1 = got.length;
      const chunked = await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: cp, method: 'POST', path: `/api/v1/upload?${q('cap-chk-0001')}`, headers: { connection: 'close', ...tokenFor(cp), 'content-type': 'image/png', 'x-requested-with': 'laneboard', 'transfer-encoding': 'chunked' } }, (res) => {
          const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(cs).toString('utf8') }));
        });
        r.on('error', reject);
        let sent = 0; const chunk = Buffer.alloc(MiB, 2);
        const pump = () => { while (sent < 7) { sent++; if (!r.write(chunk)) return r.once('drain', pump); } r.end(); };
        pump();
      }).catch((e) => ({ status: 0, text: String(e.code || e.message) }));
      await new Promise((res) => setTimeout(res, 300)); // let a cut upstream request settle in the stub's list
      check('B1: a chunked >5 MiB image (no Content-Length) -> 413 from the bridge, and no upstream request ever completed', chunked.status === 413 && got.slice(n1).every((g) => !g.complete), { status: chunked.status, text: chunked.text.slice(0, 80), stubCalls: got.slice(n1) });
    } finally { await capBridge.close(); await new Promise((res) => accept.close(res)); }
  }

  // 11. no response body from any bridge route (page, identity, writes, refusals, redirect) ever echoed the token
  check('no response body echoes the token', !seenBodies.some((t) => t.includes(ownerToken)));
} finally {
  if (redirectBridge) await redirectBridge.close();
  if (redir) await new Promise((res) => redir.close(res));
  if (target) await new Promise((res) => target.close(res));
  if (bridge) await bridge.close();
  if (upstream) await new Promise((res) => upstream.close(res));
  board?.close(); // release the store's journal fd before removing the temp data dir
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} check-board-bridge — ${results.length - failed.length}/${results.length} assertions passed`);
process.exitCode = failed.length ? 1 : 0;
