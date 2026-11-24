// W-42 5A / T-31-MAUS live gate B1: the Diagram tab (Sơ đồ) and its node comment work through BOTH of the app's board lanes.
//   node scripts/check-board-lane-diagram.mjs
//
// The 988ecc6 page is the web board's page, but the app does not serve it the way the web board does:
//   - live lane: src/main/board-bridge.mjs forwards only the reads it lists (deny by default). The page's diagram, history and supervisor
//     reads must be on that list, or the Sơ đồ panel answers 404 and shows "failed".
//   - local lane: src/main/laneboard-host.mjs hands the page its credential in the #token fragment. A raw owner bearer is not an owner-UI
//     credential in 988ecc6 (board.mjs ownerUi), so an owner node comment is refused 403 owner_ui_only unless the host gives the page a `ui` token.
// Section 1 is the route parity (every api/v1 read the vendored page makes must be forwarded by the bridge). Sections 2 and 3 run the real
// vendored board behind each lane. Section 4 is the fence: nothing owner-only became reachable.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBridge } from '../src/main/board-bridge.mjs';
import { openLocalBoard } from '../src/main/laneboard-host.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const laneboard = path.join(root, 'vendor', 'laneboard');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'board-route-parity-diagram.json'), 'utf8'));
const work = fs.mkdtempSync(path.join(process.env.ZUMI_CHECK_TMP || os.tmpdir(), 'lane-diagram-'));
const load = (rel) => import(pathToFileURL(path.join(laneboard, rel)).href);

let pass = 0, fail = 0;
const ok = (c, name, detail) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };

function call(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { connection: 'close', ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) };
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, text, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
let nReq = 0;
const rid = (tag) => `lane-diagram-${tag}-${++nReq}-${Date.now()}`;
const comment = (text) => ({ version: 1, request_id: rid('c'), op: 'feedback.add', target_id: 'MAP', data: { kind: 'note', node_id: fixture.nodes[0].id, text } });

// ---------------------------------------------------------------- 1. route parity: every read the vendored page makes is forwarded by the bridge
{
  const pubDir = path.join(laneboard, 'public');
  const segs = new Set();
  for (const f of fs.readdirSync(pubDir).filter((x) => x.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(pubDir, f), 'utf8').matchAll(/api\/v1\/([a-z]+)/g)) segs.add(m[1]);
  }
  // Writes and the upload have their own bridge routes (check-board-bridge sections 2, 10); every other segment is a GET the page makes.
  const NOT_A_READ = new Set(['write', 'upload']);
  const SAMPLE = { diagram: '/api/v1/diagram/MAP', media: '/api/v1/media/abc' };
  const stub = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"stub":true}'); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const bridge = createBridge({ upstreamOrigin: `http://127.0.0.1:${stub.address().port}`, getToken: () => 'tok', publicDir: path.join(laneboard, 'public') });
  const port = await bridge.port();
  const hdr = bridge.callerHeaders();
  ok(segs.size >= 10 && segs.has('diagram') && segs.has('history') && segs.has('supervisor'), `the page makes ${segs.size} kinds of api/v1 call, among them diagram, history and supervisor`, [...segs].sort());
  const missing = [];
  for (const s of [...segs].sort()) {
    if (NOT_A_READ.has(s)) continue;
    const p = SAMPLE[s] || `/api/v1/${s}`;
    const r = await call(port, 'GET', p, { headers: hdr });
    if (r.status === 404) missing.push(p);
  }
  ok(missing.length === 0, 'every api/v1 read the page makes is forwarded by the bridge (none answers the bridge\'s own 404)', missing);
  // a diagram id is a task id: one path segment of the board's id alphabet, nothing deeper (no history, no traversal)
  for (const bad of ['/api/v1/diagram/MAP/history', '/api/v1/diagram/', '/api/v1/diagram/a%2Fb']) {
    const r = await call(port, 'GET', bad, { headers: hdr });
    ok(r.status === 404 || r.status === 400, `GET ${bad} is not forwarded as a diagram read`, r.status);
  }
  const post = await call(port, 'POST', '/api/v1/diagram', { headers: { ...hdr, 'x-requested-with': 'laneboard' }, body: { op: 'diagram.create' } });
  ok(post.status === 404 || post.status === 405, 'POST /api/v1/diagram (the owner-only diagram write route) is not forwarded', post.status);
  const own = await call(port, 'POST', '/api/v1/owner/2fa/enrol', { headers: { ...hdr, 'x-requested-with': 'laneboard' }, body: {} });
  ok(own.status === 404 || own.status === 405, 'POST /api/v1/owner/* (2FA enrol, step-up, device revoke) is not forwarded', own.status);
  await bridge.close(); stub.close();
}

// ---------------------------------------------------------------- 2. live lane: the real board behind the bridge, view and node comment
{
  const { createBoard } = await load('src/board.mjs');
  const { createServer } = await load('src/server.mjs');
  const crypto = await import('node:crypto');
  const board = createBoard({ dataDir: path.join(work, 'live'), owner2faKey: crypto.randomBytes(32) });
  const ownerToken = fs.readFileSync(board.bootstrapTokenFile, 'utf8').trim();
  const w = (t, op, id, data = {}) => board.write(t, { version: 1, request_id: rid('w'), op, target_id: id, data });
  const coord = w(ownerToken, 'token.issue', 'coordinator', { role: 'coordinator' }).token;
  w(coord, 'task.create', 'MAP', { title: 'Test map', lane: 'CoS', steps: [{ id: 's1', label: 'Step', zone: 'build', state: 'active' }] });
  board.diagramWrite(coord, { version: 1, request_id: rid('d'), op: 'diagram.create', target_id: 'MAP', data: { document: fixture, note: 'fixture' } });
  const server = createServer(board);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const bridge = createBridge({ upstreamOrigin: `http://127.0.0.1:${server.address().port}`, getToken: () => ownerToken, publicDir: path.join(laneboard, 'public') });
  const port = await bridge.port();
  const hdr = bridge.callerHeaders();
  const st = await call(port, 'GET', '/api/v1/state', { headers: hdr });
  ok(st.status === 200 && (st.json?.tasks || []).find((t) => t.id === 'MAP')?.diagram, 'live lane: /api/v1/state shows MAP with a diagram (the page renders the panel)', st.status);
  const view = await call(port, 'GET', '/api/v1/diagram/MAP', { headers: hdr });
  ok(view.status === 200 && Array.isArray(view.json?.document?.nodes ?? view.json?.nodes) && (view.json.document?.nodes ?? view.json.nodes).length === fixture.nodes.length, 'live lane: GET /api/v1/diagram/MAP through the bridge returns the document', { status: view.status, keys: Object.keys(view.json || {}).slice(0, 6) });
  const hist = await call(port, 'GET', '/api/v1/history?task=MAP&limit=50', { headers: hdr });
  ok(hist.status === 200, 'live lane: GET /api/v1/history through the bridge answers 200', hist.status);
  const sv = await call(port, 'GET', '/api/v1/supervisor', { headers: hdr });
  ok(sv.status === 200, 'live lane: GET /api/v1/supervisor through the bridge answers 200', sv.status);
  await bridge.close(); server.close();
}

// ---------------------------------------------------------------- 3. local lane: the page's own credential posts an owner node comment
{
  const b = await openLocalBoard({ laneboardDir: laneboard, root: path.join(work, 'local'), sampleFixture: path.join(root, 'src', 'main', 'sample-board.json') });
  try {
    const pageToken = decodeURIComponent(/#token=([^&]+)/.exec(b.url)[1]);
    const rawOwner = fs.readFileSync(path.join(b.dataDir, 'owner.token'), 'utf8').trim();
    const w = (t, op, id, data = {}) => b.board.write(t, { version: 1, request_id: rid('w'), op, target_id: id, data });
    const coord = w(rawOwner, 'token.issue', 'coordinator', { role: 'coordinator' }).token;
    w(coord, 'task.create', 'MAP', { title: 'Test map', lane: 'CoS', steps: [{ id: 's1', label: 'Step', zone: 'build', state: 'active' }] });
    b.board.diagramWrite(coord, { version: 1, request_id: rid('d'), op: 'diagram.create', target_id: 'MAP', data: { document: fixture, note: 'fixture' } });
    const auth = { authorization: `Bearer ${pageToken}`, 'x-requested-with': 'laneboard' };
    const view = await call(b.port, 'GET', '/api/v1/diagram/MAP', { headers: auth });
    ok(view.status === 200, 'local lane: the page credential reads the diagram', view.status);
    const posted = await call(b.port, 'POST', '/api/v1/write', { headers: auth, body: comment('first note from the app page') });
    ok(posted.status === 200, 'local lane: an owner node comment from the page credential is accepted (no owner_ui_only)', { status: posted.status, error: posted.json?.error });
    const after = await call(b.port, 'GET', '/api/v1/state', { headers: auth });
    ok((after.json?.feedback || []).some((f) => f.node_id === fixture.nodes[0].id && /first note from the app page/.test(f.text || '')), 'local lane: the comment is on the board, anchored on its node');
    // control: the raw bootstrap owner bearer is still not an owner-UI credential, so the gate itself still bites
    const raw = await call(b.port, 'POST', '/api/v1/write', { headers: { authorization: `Bearer ${rawOwner}`, 'x-requested-with': 'laneboard' }, body: comment('from the raw bearer') });
    ok(raw.status === 403 && raw.json?.error === 'owner_ui_only', 'control: the raw owner bearer is still refused owner_ui_only (the board gate was not loosened)', { status: raw.status, error: raw.json?.error });
    // fence: the page credential cannot do the owner-only acts
    const diag = await call(b.port, 'POST', '/api/v1/diagram', { headers: auth, body: { version: 1, request_id: rid('x'), op: 'diagram.archive', target_id: 'MAP', data: {} } });
    ok(diag.status >= 400, 'fence: the page credential cannot use the diagram write route without the 2FA step-up', diag.status);
    const mint = await call(b.port, 'POST', '/api/v1/write', { headers: auth, body: { version: 1, request_id: rid('t'), op: 'token.issue', target_id: 'sneaky', data: { role: 'owner', ui: true } } });
    ok(mint.status === 403, 'fence: the page credential cannot mint another owner-UI token', { status: mint.status, error: mint.json?.error });
    // a second open of the same data dir reuses the credential instead of minting one per launch
    const tokensBefore = Object.values(b.board.state.tokens).filter((t) => t.ui).length;
    b.close();
    const b2 = await openLocalBoard({ laneboardDir: laneboard, root: path.join(work, 'local'), sampleFixture: path.join(root, 'src', 'main', 'sample-board.json') });
    const tokensAfter = Object.values(b2.board.state.tokens).filter((t) => t.ui).length;
    ok(tokensBefore === 1 && tokensAfter === 1, 'the app UI credential is minted once and reused on the next launch', { tokensBefore, tokensAfter });
    b2.close();
  } finally { try { b.close(); } catch { /* closed above */ } }
}

try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a handle still open on Windows: the temp dir is swept with the scratch */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
