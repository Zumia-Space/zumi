// T-31 supervisor port (design: ZUMI-SUPERVISOR-PORT-DESIGN-1311): the Board tab shows the board's own task supervisor.
// Plain Node, no Electron, no window, no network: the vendored Laneboard runs in-process on a throwaway data dir with an
// injected clock, and the page functions are lifted out of vendor/laneboard/public/app.js into a vm with the real locales
// (the same lift as Laneboard's test/machine-ui.test.mjs). Every strip/badge input is GET /api/v1/supervisor as the
// board serves it (the canonical reader); nothing here recomputes a nudge.
//   node scripts/check-board-supervisor.mjs   (or: npm run check:board-supervisor)
//
//   1. the vendor bump: vendor/laneboard is the Laneboard merge of 1617503 (supervisor) + 4c18e86 (machines-scrub, pin,
//      worker machine), the 0.3 export scrubs are still applied, and the "Giám sát" strip shows for one open nudge and
//      is absent when the supervisor is off.
//   2. the bridge: the app's live-board bridge (src/main/board-bridge.mjs, shared by Electron and the Tauri sidecar) forwards
//      GET /api/v1/supervisor to the real vendored board as the owner, so the page's ensureSupervisor() gets the board's answer,
//      and GET /api/v1/history, so the page's "load older" (state window) works in live mode.
//   3. the task chip and the L3 button (Laneboard b9e0351 + 6a04dcf + c4ba9ce on top of the merge): a chip on the nudged task only, and on an open
//      owner-level nudge the owner's button, whose write (feedback.resolve through the bridge's PAGE channel) takes the
//      nudge out of the supervisor's open list; an L1 nudge has no button. The owner's close is bookkeeping, not work: the
//      task's activity clock stays and the lane (L1) and CoS (L2) levels stay open after the next sweep (J = BLOCK), and the
//      chain does not vanish: its highest open level (L2) is what the supervisor read, the strip and the chip show next, and
//      the owner is not pinged again: no new owner level an hour later (the lane is re-nudged instead, Laneboard a01b5c5).
//      After the grace the lane's re-nudge supersedes the round before it (open nudges stay bounded) and the read's since is
//      the chain's first nudge, so the strip and chip show how long the task has been stuck (Laneboard 21d8a9b). Every
//      feedback record the fixture board wrote (superseded ones included) is valid against the vendored record schema
//      (Laneboard 8dfd954).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LB = path.join(ROOT, 'vendor', 'laneboard');
const PUB = path.join(LB, 'public');
const work = path.join(ROOT, `.sv-tmp-${process.pid}`);
// Laneboard branch T-31-supervisor-port-1311: MERGE has parents 1617503 (supervisor) and 4c18e86 (machines-scrub, pin, worker
// machine); PIN is MERGE + the task chip / L3 button (c639c30, b9e0351) + the owner close keeps the activity clock (787bdaf,
// 6a04dcf) + a chain whose upper level was closed stays visible (b6775c0, c4ba9ce) + re-nudge downward, never re-escalate to
// the owner (e8d55bd, a01b5c5) + bounded re-nudges and the chain's age (9806e7e, 21d8a9b) + the record schema accepts superseded and the root lane's
// digest (f9e810d, 8dfd954) + the R3 tighten and its follow-ups (J-05-r3-tighten-1311 050e617, c482a16; GATE-R3-TIGHTEN-1311) + the task header's
// Pin label (9f02a2a) + the slow poll while hidden (b579667, 7eef858; T-31 alpha.9.5, GATE-OPUS-ALPHA95) + the sidebar's pinned list above
// Cần anh (66325fb, ce780d8; owner 15-11; branch T-31-pin-label-src-1411, not pushed yet) + the B2 news feed: news kinds, feedback.kind.* labels,
// nudges out of the owner feed, news on POST /api/admin/news (e866f5b..b6d8417; branch T-31-MOBILE-newsfeed-b2-1611, not pushed yet).
// T-31-ALPHA11: PIN moves b6d8417 -> 04ecfbf (branch T-31-ALPHA11-laneboard, not pushed): live 988ecc6 (which already holds MERGE..c482a16)
// plus the c482a16..b6d8417 delta above re-applied, so the Diagram tab and this line are in one vendor; that is what vendor/laneboard holds.
const MERGE = '146c859da7e7c0573679310a96cae5733262c23a';
// T-31-ALPHA11 Fable visual pass B (21-11): PIN moves 04ecfbf -> eec04d3 (same branch, viewer zoom bar / node label / head status / scope label, UI only).
// T-31-ALPHA12 round 5 (21-11, CoS): PIN moves eec04d3 -> 07b311c (branch J-05-task-scroll: the task column scrolls as one, progress newest 2 +
// Xem thêm, scroll anchor, scroll to the sent message; UI only).
// T-31-ALPHA13 (22-11, CoS): PIN moves 07b311c -> 29bf7da (branch T-31-ALPHA13-lb, not pushed; a bundle is kept with the J-05 backups): the merge of
// live 2427a5e (J-05 working-status 673d3bc + e4c0613 + status-label) into 07b311c, so the desktop line (news feed, pinned list, hidden poll,
// eec04d3) stays in the vendor.
const PIN = '29bf7dac96bd577a12aacd493549316ee801714e';
const LB_REPO = process.env.LANEBOARD_REPO || ownerPath('laneboardRepo', '');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''}`); } };
const read = rel => fs.readFileSync(path.join(LB, rel), 'utf8');

const APP = read('public/app.js');
const LOC = Object.fromEntries(['en', 'vi', 'zh'].map(l => [l, JSON.parse(read(`public/locales/${l}.json`))]));
/** One top-level function or one-line const of the vendored page, as source text ('' when the page has none). */
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  return start < 0 ? '' : APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
/** A vm with the page's S (locale, viewer role, supervisor read, board view) and the named page functions. */
function page(names, { lang = 'vi', sv = null, role = 'owner', data = {} } = {}) {
  const ctx = vm.createContext({ S: { dict: LOC[lang], en: LOC.en, sv, data: { me: { role }, feedback: [], ...data } }, Date });
  const src = names.map(lift);
  ok(src.every(Boolean), `the vendored page defines ${names.join(', ')}`, names.filter((n, i) => !src[i]));
  vm.runInContext(src.join('\n'), ctx);
  return code => vm.runInContext(code, ctx);
}

const { createBoard } = await import(pathToFileURL(path.join(LB, 'src', 'board.mjs')).href);
const { createServer } = await import(pathToFileURL(path.join(LB, 'src', 'server.mjs')).href);
const { createBridge } = await import(pathToFileURL(path.join(ROOT, 'src', 'main', 'board-bridge.mjs')).href);
/** One request to a loopback port; JSON bodies are sent the way the page's write() sends them (CSRF header). */
function request(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { connection: 'close', ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length, 'x-requested-with': 'laneboard' } : {}) };
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, text, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
/** The fixture board served on 127.0.0.1 behind the app's real bridge (owner token held by the bridge, as in the app). */
async function behindBridge(f) {
  const upstream = createServer(f.board);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const bridge = createBridge({ upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, getToken: () => f.owner, publicDir: PUB });
  const port = await bridge.port();
  const get = (p) => request(port, 'GET', p, { headers: bridge.callerHeaders() });
  const post = (p, body) => request(port, 'POST', p, { body, headers: bridge.callerHeaders() });
  const close = async () => { try { await bridge.close?.(); } catch { /* closed */ } upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); };
  return { get, post, close };
}
const H = 3600000, MIN = 60000, T0 = Date.parse('2026-11-12T02:00:00.000Z'), iso = ms => new Date(ms).toISOString();
/** A throwaway vendored board on an injected clock; supervisor on from SINCE = T0 - 24 h unless `off`. */
function fixtureBoard(name, { off = false } = {}) {
  const clock = { ms: T0 };
  const board = createBoard({ dataDir: path.join(work, name), now: () => clock.ms, ...(off ? {} : { supervisorSince: iso(T0 - 24 * H), supervisorConfig: { digestHourIct: 24 } }) });
  const owner = fs.readFileSync(board.bootstrapTokenFile, 'utf8').trim();
  let n = 0;
  const w = (token, op, target_id, data = {}, extra = {}) => board.write(token, { version: 1, request_id: `sv-${name}-${++n}`, op, target_id, data, ...extra });
  const coord = w(owner, 'token.issue', 'coordinator', { role: 'coordinator' }).token;
  return { board, owner, coord, clock, w, tick: ms => { clock.ms += ms; } };
}
/** Task E has an active step whose run started at T0 and never reports: R1 fires after 4 h quiet, then escalates hourly. */
function seedQuietRun(f, id = 'E') {
  f.w(f.coord, 'task.create', id, { title: `quiet ${id}`, lane: 'Worker A', steps: [{ id: 'b', label: 'build', sub: `run:x@${iso(T0)}`, state: 'active', zone: 'build' }] });
}

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const boards = [], closers = [];
try {
  // ------------------------------------------------------------------ 1. the vendor bump
  {
    ok(read('VERSION').trim() === PIN, '1 VERSION is the Laneboard pin (the merge 1617503+4c18e86 + the task chip / L3 button)', read('VERSION').trim());
    ok(read('RELEASE').trim() === PIN.slice(0, 7), '1 RELEASE is its short sha (what /healthz reports)', read('RELEASE').trim());
    const lbGit = (...a) => spawnSync('git', ['-C', LB_REPO, ...a], { encoding: 'utf8' });
    if (LB_REPO && lbGit('cat-file', '-e', `${PIN}^{commit}`).status === 0) {
      const parents = lbGit('rev-list', '--parents', '-n', '1', MERGE).stdout.trim().split(' ').slice(1);
      ok(parents.length === 2 && parents[0].startsWith('1617503') && parents[1].startsWith('4c18e86'), '1 the merge has exactly the parents 1617503 and 4c18e86', parents);
      ok(lbGit('merge-base', '--is-ancestor', MERGE, PIN).status === 0, '1 the pin descends from the merge, so no 4c18e86-line commit is dropped');
    } else console.log(`NOT-RUN 1 merge ancestry: no Laneboard repo with ${PIN.slice(0, 7)} (set LANEBOARD_REPO)`);
    for (const [what, has] of [['supervisor strip (1617503 line)', 'function supervisorStrip('], ['supervisor read (1617503 line)', 'async function ensureSupervisor('],
      ['pin toggle (4c18e86 line)', 'function pinButton('], ['worker machine line (4c18e86 line)', 'function machineLine('], ['worker popover flip-up (Zumi 760501b)', 'placeWkPop']])
      ok(APP.includes(has), `1 the vendored page keeps the ${what}`);
    const { scanDir } = await import(pathToFileURL(path.join(LB, 'scripts', 'scan-served-assets.mjs')).href);
    const hits = scanDir(LB);
    ok(Array.isArray(hits) && hits.length === 0, '1 machines-scrub: no machine name or internal path in any served vendored file', hits);
    ok(!/[A-Z]:\/K\//.test(read('AGENTS.md')) && !/[A-Z]:\/K\//.test(read('src/roles.mjs')) && !read('README.md').includes('docs/overview-en.png'),
      '1 the 0.3 export scrubs are re-applied (AGENTS.md, src/roles.mjs, README.md)');

    const on = fixtureBoard('strip-on'); boards.push(on);
    if (typeof on.board.sweepSupervisor !== 'function') throw new Error('the vendored board has no supervisor (sweepSupervisor/supervisorView)');
    seedQuietRun(on);
    on.tick(4 * H + MIN); on.board.sweepSupervisor();
    const view = on.board.supervisorView(on.owner);
    ok(view.on === true && view.open.length === 1 && view.open[0].task_id === 'E' && view.open[0].rule === 'R1', '1 fixture: the vendored board files one R1 nudge on E', view.open);
    const strip = page(['esc', 't', 'fmtDur', 'supervisorStrip'], { sv: view })('supervisorStrip()');
    ok(strip.includes('supervisor-strip') && strip.includes('Giám sát') && (strip.match(/class="sv-row/g) || []).length === 1 && strip.includes('R1 · L1'),
      '1 the strip shows for one open nudge (Giám sát, one row, R1 · L1)', strip.slice(0, 300));

    const off = fixtureBoard('strip-off', { off: true }); boards.push(off);
    seedQuietRun(off);
    off.tick(4 * H + MIN); off.board.sweepSupervisor();
    const offView = off.board.supervisorView(off.owner);
    ok(offView.on === false && offView.open.length === 0, '1 fixture: supervisor off -> on:false, nothing open', offView);
    ok(page(['esc', 't', 'fmtDur', 'supervisorStrip'], { sv: offView })('supervisorStrip()') === '', '1 no strip when the supervisor is off');
    ok(page(['esc', 't', 'fmtDur', 'supervisorStrip'], { sv: { ...view, on: false } })('supervisorStrip()') === '', '1 no strip when the read says off, even with entries');
  }

  // ------------------------------------------------------------------ 2. the bridge forwards the supervisor read
  {
    const f = fixtureBoard('bridge'); boards.push(f);
    seedQuietRun(f);
    f.tick(4 * H + MIN); f.board.sweepSupervisor();
    const b = await behindBridge(f); closers.push(b.close);
    const r = await b.get('/api/v1/supervisor');
    ok(r.status === 200 && r.json?.on === true && r.json.open?.length === 1 && r.json.open[0].task_id === 'E', '2 GET /api/v1/supervisor through the bridge returns the board supervisor read (one open nudge on E)', { status: r.status, body: r.text.slice(0, 200) });
    ok(JSON.stringify(r.json) === JSON.stringify(f.board.supervisorView(f.owner)), '2 the bridge passes the read through unchanged (the canonical reader, nothing recomputed)');
    ok((await b.get('/api/v1/inbox?lane=cos')).status === 404, '2 the allow-list still refuses an unlisted read (/api/v1/inbox)');
    const hist = await b.get('/api/v1/history?task=E&limit=500');
    ok(hist.status === 200 && hist.json?.task === 'E' && Array.isArray(hist.json?.feedback) && 'has_more' in hist.json, '2 GET /api/v1/history (the page "load older") reaches the real board through the bridge', { status: hist.status, body: hist.text.slice(0, 160) });
  }

  // ------------------------------------------------------------------ 3. the task chip and the owner's L3 button
  {
    const BADGE = ['esc', 't', 'shortDur', 'role', 'isOwner', 'svBadge'];
    const f = fixtureBoard('badge'); boards.push(f);
    seedQuietRun(f, 'E');
    f.w(f.coord, 'task.create', 'OK', { title: 'healthy', lane: 'Worker A', steps: [{ id: 'a', label: 'a', state: 'todo', zone: 'build' }] });
    f.tick(4 * H + MIN); f.board.sweepSupervisor();
    const b = await behindBridge(f); closers.push(b.close);
    const read2 = async () => ({ sv: (await b.get('/api/v1/supervisor')).json, view: (await b.get('/api/v1/state')).json });
    let { sv, view } = await read2();
    const at = (role) => page(BADGE, { sv, role, data: { feedback: view?.feedback || [] } });
    const l1 = at('owner')(`svBadge(${JSON.stringify({ id: 'E' })})`);
    ok(/class="chip sv-badge lvl1"/.test(l1) && l1.includes('R1 · '), '3 a chip on the nudged task (R1 with its age)', l1);
    ok(at('owner')(`svBadge(${JSON.stringify({ id: 'OK' })})`) === '' && at('owner')(`svBadge(${JSON.stringify({ id: 'E2' })})`) === '', '3 no chip on a healthy task, none leaks to another task');
    ok(!l1.includes('sv-receipt'), '3 an L1 nudge shows no button (the lane receipts it)');

    f.tick(61 * MIN); f.board.sweepSupervisor(); f.tick(61 * MIN); f.board.sweepSupervisor();
    ({ sv, view } = await read2());
    const head = sv.open.find((n) => n.task_id === 'E');
    ok(head?.level === 3, '3 fixture: the R1 chain on E reached the owner level', sv.open);
    const l3 = at('owner')(`svBadge(${JSON.stringify({ id: 'E' })})`);
    const m = l3.match(/data-action="sv-receipt" data-id="([^"]+)" data-rev="(\d+)"/);
    ok(/class="chip sv-badge lvl3 bad"/.test(l3) && m && m[1] === head.id, '3 an open L3 nudge shows the owner the button, bound to that nudge and its rev', l3);
    ok(!at('coordinator')(`svBadge(${JSON.stringify({ id: 'E' })})`).includes('sv-receipt'), '3 a non-owner viewer gets no button');
    const actBefore = f.board.state.activity.E;
    f.tick(5 * MIN);
    const pressed = m ? await b.post('/api/v1/write', { version: 1, request_id: 'ui-sv-receipt-1', op: 'feedback.resolve', target_id: m[1], data: {}, expected_revision: Number(m[2]) }) : { status: 0 };
    ok(pressed.status === 200 && pressed.json?.ok !== false, '3 the button write (feedback.resolve) passes the bridge PAGE channel', { status: pressed.status, body: pressed.text?.slice(0, 200) });
    ({ sv } = await read2());
    ok(!sv.open.some((n) => n.id === head.id), '3 the nudge leaves the supervisor open list', sv.open);
    ok(f.board.state.activity.E === actBefore, '3 the owner close does not move the task activity clock', { before: actBefore, after: f.board.state.activity.E });
    f.tick(5 * MIN); f.board.sweepSupervisor();
    const chain = Object.values(f.board.state.feedback).filter((x) => x.kind === 'nudge' && x.task_id === 'E').map((x) => [x.level, x.status, x.cleared || '']);
    ok(JSON.stringify(chain) === JSON.stringify([[1, 'open', ''], [2, 'open', ''], [3, 'resolved', '']]), '3 after the next sweep the lane (L1) and CoS (L2) levels are still open (J = BLOCK)', chain);
    ({ sv, view } = await read2());
    const l2 = Object.values(f.board.state.feedback).find((x) => x.kind === 'nudge' && x.task_id === 'E' && x.level === 2);
    ok(JSON.stringify(sv.open.filter((n) => n.task_id === 'E').map((n) => [n.id, n.level])) === JSON.stringify([[l2.id, 2]]), '3 the chain does not vanish: the supervisor read now lists its L2 (CoS) as the head', sv.open);
    const after = at('owner')(`svBadge(${JSON.stringify({ id: 'E' })})`);
    ok(/class="chip sv-badge lvl2"/.test(after) && !after.includes('sv-receipt'), '3 the chip shows the chain at L2, without the owner button', after);
    const pings0 = (f.board.state.pings || []).length;
    f.tick(62 * MIN); f.board.sweepSupervisor();
    const owners = Object.values(f.board.state.feedback).filter((x) => x.kind === 'nudge' && x.task_id === 'E' && x.level === 3);
    ok(owners.length === 1 && (f.board.state.pings || []).length === pings0, '3 an hour after Đã nhận there is no new owner level and no owner ping', owners.map((x) => [x.id, x.status]));
    const root = Object.values(f.board.state.feedback).find((x) => x.kind === 'nudge' && x.task_id === 'E' && x.level === 1);
    f.tick(4 * H); f.board.sweepSupervisor(); // past the grace (R1: 4 h awake from the close), no work
    const openE = Object.values(f.board.state.feedback).filter((x) => x.kind === 'nudge' && x.task_id === 'E' && x.status === 'open');
    ok(openE.length === 1 && openE[0].level === 1 && openE[0].lane === 'Worker A' && openE[0].escalated_from === root.id, '3 after the grace the lane gets a re-nudge linked to the chain\'s first nudge, and it supersedes the round before it (one open nudge)', openE.map((x) => [x.level, x.lane, x.escalated_from]));
    ({ sv } = await read2());
    const headE = sv.open.find((n) => n.task_id === 'E');
    ok(headE?.since === root.attribution.created_at && headE.at > headE.since, '3 the supervisor read carries since = the chain\'s first nudge (the age the strip and chip show)', headE);
    ok((APP.match(/Date\.parse\(n\.since \|\| n\.at\)/g) || []).length === 2, '3 the vendored strip and chip both age from since (the chain), not at (this nudge)');
    const { loadSchemas, validate } = await import(pathToFileURL(path.join(LB, 'src', 'validate.mjs')).href);
    const schemas = loadSchemas(path.join(LB, 'schema', 'v1'));
    const recs = Object.values(f.board.state.feedback);
    const bad = recs.map((r) => [r.id, r.cleared || '', validate(schemas, 'feedback.json', r)]).filter(([, , e]) => e.length);
    ok(recs.some((r) => r.cleared === 'superseded') && bad.length === 0, '3 every feedback record the board wrote, superseded ones included, is valid against the vendored record schema', bad.slice(0, 3));
  }
} catch (e) {
  ok(false, 'the check ran to the end', String(e?.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
  for (const c of closers) await c();
  for (const b of boards) try { b.board.close(); } catch { /* already closed */ }
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, never process.exit(): http.Server close callbacks fire before libuv has finished closing the TCP handles (the
// bridge's keep-alive upstream socket among them), and exiting then aborts on Windows ("Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING)", rc 127; 6 of 13 runs before). Letting the loop drain closes them first; nothing here stays ref'd.
process.exitCode = fail ? 1 : 0;
