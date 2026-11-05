#!/usr/bin/env node
// Host-side gate for Brain's three read-only calls (T-31 slice 3a-3, GATE-SEC-3a-3 C1-C13): src/main/board-reads.mjs under plain Node with stubs
// ("BH-n" in the plan). No Electron, no network, no real board.
// Fault proof (C13: "every new check shows its assert failing once on an injected fault before it counts"): after the real run this script
// builds, for each entry of FAULTS, a scratch copy of board-reads.mjs with one defect injected, runs the same asserts against it in a child
// process and requires exit 1 AND a FAIL line starting with the expected assert id. A fault whose anchor is not found is an error (exit 2),
// never a pass.
//   node scripts/check-brain-host.mjs [--no-faults] [--module <file>] [--fault-list]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const REAL_MODULE = path.join(ROOT, 'src', 'main', 'board-reads.mjs');
const args = process.argv.slice(2);
const argOf = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const MODULE = path.resolve(argOf('--module') || REAL_MODULE);
const IS_REAL = !argOf('--module') && !argOf('--static-root');
const SCRATCH_BASE = ownerPath('scratchRoot', os.tmpdir()); // never drive C on the owner's machines
// The open roots the owner build may open under (owner values openRoots; a tree without them uses two fixture roots): every local
// ref below sits under them, so the owner run feeds the real decideOpenRef the same strings as before.
const [R0, R1] = ownerPath('openRoots', ['D:/data/notes/', 'D:/data/material/']);
const W0 = R0.replace(/\//g, '\\');
const MiB4 = 4 * 1024 * 1024;

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; if (IS_REAL) console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); } };

// ---------------------------------------------------------------- faults (one injected defect each)
// edits: [from, to] pairs applied in order; every `from` must occur exactly once in the real file.
const FAULTS = [
  // C1 / N3
  { id: 'c1-passthrough', expect: 'BH-1', edits: [['const out = pick(full, BRAIN_STATE_KEYS);', 'const out = { ...full };']] },
  { id: 'c1-twelfth-key', expect: 'BH-1', edits: [["'attention'])", "'attention', 'notify'])"]] },
  { id: 'n3-tasks-whole', expect: 'BH-1', edits: [['if (Array.isArray(out.tasks)) out.tasks = out.tasks.map(projectTask);', '']] },
  { id: 'n3-steps-whole', expect: 'BH-1', edits: [['if (Array.isArray(t.steps)) out.steps = t.steps.map((s) => (isObj(s) ? pick(s, BRAIN_STEP_KEYS) : s));', 'out.steps = t.steps;']] },
  { id: 'c1-no-memo', expect: 'BH-1', edits: [['memo.set(r.state, e);', '']] },
  // C2
  { id: 'c2-no-cap', expect: 'BH-2', edits: [['return e.bytes > STATE_MAX_BYTES ? { ok: false, reason: \'too_large\' } : { ok: true, entry: e };', 'return { ok: true, entry: e };']] },
  { id: 'c2-log-every-call', expect: 'BH-2', edits: [['memo.set(r.state, e);', 'memo.set(r.state, e);'], ['if (e.bytes > STATE_MAX_BYTES) log(`state refused too_large ${e.bytes}`);   // once per cached object', ''], ['return e.bytes > STATE_MAX_BYTES ?', 'if (e.bytes > STATE_MAX_BYTES) log(`state refused too_large ${e.bytes}`);\n    return e.bytes > STATE_MAX_BYTES ?']] },
  // C3
  { id: 'c3-forward-options', expect: 'BH-3', edits: [['async function snapshot() {', 'async function snapshot(opts) {'], ['boardReader.getState()', 'boardReader.getState(opts)'], ['async function state() {', 'async function state(opts) {'], ['const s = await snapshot();\n    return s.ok ? { ok: true, state', 'const s = await snapshot(opts);\n    return s.ok ? { ok: true, state']] },
  // C10
  { id: 'c10-default-fetch', expect: 'BH-10', edits: [['liveBoard, fetchImpl, decide', 'liveBoard, fetchImpl = fetch, decide']] },
  // reader reasons stay fixed words
  { id: 'reason-echo', expect: 'BH-12', edits: [['REASON.test(String(r && r.reason)) ? r.reason : \'offline\'', '(r && r.reason) || \'offline\'']] },
];
// media (C5, C7, C8, B13)
FAULTS.push(
  { id: 'c5-no-inflight-limit', expect: 'BH-5', edits: [["if (mediaInflight >= MEDIA_MAX_INFLIGHT) return mediaRefuse('busy', id);", '']] },
  { id: 'c5-no-rate-limit', expect: 'BH-5', edits: [["if (!mediaWindow.tryTake()) return mediaRefuse('rate_limited', id);", '']] },
  { id: 'c7-no-abort-at-all', expect: 'BH-7', edits: [['const refuse = (reason) => { ac.abort(); return mediaRefuse(reason, id); };', 'const refuse = (reason) => mediaRefuse(reason, id);']] },
  { id: 'c7-header-too-large-no-abort', expect: 'BH-7', edits: [["if (Number(res.headers.get('content-length')) > MEDIA_MAX_BYTES) return refuse('too_large');", "if (Number(res.headers.get('content-length')) > MEDIA_MAX_BYTES) return mediaRefuse('too_large', id);"]] },
  { id: 'c7-stream-too-large-no-abort', expect: 'BH-7', edits: [["if (total > MEDIA_MAX_BYTES) return refuse('too_large'); chunks.push(c);", "if (total > MEDIA_MAX_BYTES) return mediaRefuse('too_large', id); chunks.push(c);"]] },
  { id: 'c7-abort-on-success', expect: 'BH-7', edits: [['} finally { clearTimeout(timer); }', '} finally { clearTimeout(timer); ac.abort(); }']] },
  { id: 'c7-no-timeout', expect: 'BH-7', edits: [['const timer = setTimeout(() => { timedOut = true; ac.abort(); }, FETCH_TIMEOUT_MS);', 'const timer = null;']] },
  { id: 'b13-id-regex-loose', expect: 'BH-13', edits: [['const ATT_ID = /^att-\\d{1,12}$/;', 'const ATT_ID = /^att-.+/;']] },
  { id: 'b13-no-mime-gate', expect: 'BH-13', edits: [["if (!IMAGE_MIMES.has(att.mime)) return mediaRefuse('not_image', id);", '']] },
  { id: 'b13-no-attachment-gate', expect: 'BH-13', edits: [['.find((a) => isObj(a) && a.id === id);', ".find((a) => isObj(a) && a.id === id) || { mime: 'image/png' };"]] },
  { id: 'b13-no-signature-check', expect: 'BH-13', edits: [["if (!SIGNATURE[mime](bytes)) return refuse('bad_image');", '']] },
  { id: 'b13-follow-redirects', expect: 'BH-13', edits: [["redirect: 'manual'", "redirect: 'follow'"]] },
  { id: 'b13-width-any', expect: 'BH-13', edits: [["if (!MEDIA_WIDTHS.includes(w)) return mediaRefuse('bad_width', id);", '']] },
  { id: 'c8-echo-bad-id', expect: 'BH-8', edits: [["return mediaRefuse('bad_id');", "return mediaRefuse('bad_id', String(id));"]] },
  { id: 'c8-log-error-message', expect: 'BH-8', edits: [["} catch { return refuse(timedOut ? 'timeout' : 'offline'); }\n      if (res.status !== 200)", "} catch (e) { log(String(e && e.message)); return refuse(timedOut ? 'timeout' : 'offline'); }\n      if (res.status !== 200)"]] },
  { id: 'b17-success-spreads-headers', expect: 'BH-17b', edits: [['return { ok: true, mime, bytes };', 'return { ok: true, mime, bytes, headers: await liveBoard.bridgeHeaders() };']] },
  { id: 'b17-success-extra-field', expect: 'BH-17b', edits: [['return { ok: true, mime, bytes };', "return { ok: true, mime, bytes, url: `http://127.0.0.1/api/v1/media/${id}` };"]] },
  { id: 'c3-media-forwards-args', expect: 'BH-3', edits: [['boardReader.getState()', 'boardReader.getState(undefined)']] },
);
// openRef (C6, C8, C9, B14)
const GATE = 'if (openInflight || t - lastOpenAt < OPEN_MIN_GAP_MS || !openWindow.tryTake())';
const H1 = "if (!s.entry.refs.has(refKey(ref.kind, ref.target))) return openRefuse('not_on_board', origin);";
FAULTS.push(
  { id: 'c6-no-inflight-limit', expect: 'BH-6', edits: [[GATE, 'if (t - lastOpenAt < OPEN_MIN_GAP_MS || !openWindow.tryTake())']] },
  { id: 'c6-no-min-gap', expect: 'BH-6', edits: [[GATE, 'if (openInflight || !openWindow.tryTake())']] },
  { id: 'c6-no-window-limit', expect: 'BH-6', edits: [[GATE, 'if (openInflight || t - lastOpenAt < OPEN_MIN_GAP_MS)']] },
  { id: 'c9-includes-match', expect: 'BH-9', edits: [[H1, "if (![...s.entry.refs].some((k) => k.includes(ref.target))) return openRefuse('not_on_board', origin);"]] },
  { id: 'c9-no-h1', expect: 'BH-9', edits: [[H1, '']] },
  { id: 'c9-kind-ignored', expect: 'BH-9', edits: [['const refKey = (kind, target) => `${kind}\\u0000${target}`;', 'const refKey = (_kind, target) => target;']] },
  { id: 'c9-decide-before-h1', expect: 'BH-9', edits: [[H1, "{ try { decide({ kind: ref.kind, target: ref.target }); } catch { /* ignored */ } if (!s.entry.refs.has(refKey(ref.kind, ref.target))) return openRefuse('not_on_board', origin); }"]] },
  { id: 'c9-dossier-not-cited', expect: 'BH-9', edits: [["if (typeof t.dossier === 'string' && t.dossier) keys.add(refKey('local', t.dossier));", '']] },
  { id: 'c8-log-decision-with-path', expect: 'BH-8', edits: [["if (!d || d.action === 'refuse') return openRefuse(d && /^[a-z_]{1,40}$/.test(String(d.reason)) ? d.reason : 'bad_request', d && d.origin);", "if (!d || d.action === 'refuse') { logRefusal(d); return { opened: false, reason: d && d.reason }; }"]] },
  { id: 'c8-log-open-error-message', expect: 'BH-8', edits: [["catch (e) { return openRefuse(e && e.message === 'open_unavailable' ? 'open_unavailable' : 'open_failed'); }", 'catch (e) { return openRefuse(String(e && e.message)); }']] },
  { id: 'c8-raw-url-origin', expect: 'BH-8', edits: [['logRefusal(origin ? { reason, origin: safeOrigin(origin) } : { reason })', 'logRefusal(origin ? { reason, origin } : { reason })']] },
  { id: 'c8-silent-not-on-board', expect: 'BH-8', edits: [["return openRefuse('not_on_board', origin);", "return { opened: false, reason: 'not_on_board' };"]] },
  { id: 'c8-silent-bad-request', expect: 'BH-8', edits: [["|| ref.target.length > MAX_REF_TARGET) return openRefuse('bad_request');", "|| ref.target.length > MAX_REF_TARGET) return { opened: false, reason: 'bad_request' };"]] },
  { id: 'c3-open-forwards-args', expect: 'BH-3', edits: [['boardReader.getState()', 'boardReader.getState(undefined)']] },
);
// later commits append here

if (args.includes('--fault-list')) { for (const f of FAULTS) console.log(`${f.id}\t${f.expect}`); process.exit(0); }

// ---------------------------------------------------------------- stubs
const FORBIDDEN_TOP = ['notify', 'me', 'routing', 'route_override', 'roles', 'inbox', 'messages', 'feedback', 'pings', 'freshness', 'stale_text', 'turns', 'config', 'watcher_at', 'docs', 'stalled'];
const STATE_KEYS = ['version', 'seq', 'now', 'tasks', 'asks', 'attachments', 'times', 'task_times', 'goals', 'plans', 'attention'];
const TASK_KEYS = ['id', 'title', 'lane', 'health', 'status', 'goal', 'now', 'next', 'context', 'dossier', 'architecture', 'steps', 'current_step', 'last_activity_at'];
const STEP_KEYS = ['id', 'label', 'sub', 'detail', 'state', 'zone'];
const FORBIDDEN_TASK = ['attribution', 'worker', 'worker_default', 'roles', 'loops', 'gate_fails', 'measured', 'status_request', 'visibility', 'rev', 'order', 'step_ids', 'text_at'];
const FORBIDDEN_STEP = ['attribution', 'task_id', 'rev', 'state_at'];
const SECRET = 'https://hooks.example.test/services/T000/B000/SECRET-WEBHOOK-TOKEN';

/** A cached board state as the reader hands it out: every key of the real boardView, including the ones Brain must never get. */
function boardState(over = {}) {
  return {
    version: 3, seq: 12, now: '2026-10-28T09:00:00.000Z',
    config: { bridge: 'x' }, me: { token_id: 'tok-1', name: 'owner', role: 'owner', prefs: { k: 1 } },
    notify: { coordinator_feedback: true, delivery: 'watch', webhook_url: SECRET },
    routing: { default: 'sonnet' }, route_override: { a: 1 }, roles: { owner: { model: 'm' } },
    inbox: [{ id: 'm1' }], messages: [{ id: 'm2' }], feedback: [{ id: 'f1' }], pings: [{ id: 'p1' }],
    docs: [{ id: 'd1' }], watcher_at: '2026-10-28T08:59:00.000Z', stalled: [], freshness: { stale: false }, stale_text: 'x',
    tasks: [
      { id: 'T-31', rev: 7, visibility: 'internal', attribution: { created_by: { name: 'owner' } }, title: 'Brain', lane: 'T', health: 'green', status: 'active',
        text_at: 'x', goal: 'g', now: 'n', next: 'x', context: 'c', order: 1, dossier: `${R0}t31/DOSSIER.md`, architecture: { format: 'graph', nodes: [], edges: [] },
        worker: 'deepseek', loops: 2, step_ids: ['T-31/a'], current_step: { id: 'T-31/a', label: 'A', state: 'active' }, last_activity_at: '2026-10-28T08:00:00.000Z',
        worker_default: 'w', roles: { worker: { model: 'secret-model' } }, gate_fails: 1, measured: { a: 1 }, status_request: null,
        steps: [{ id: 'T-31/a', task_id: 'T-31', rev: 2, attribution: { a: 1 }, label: 'A', sub: 's', detail: 'd', zone: 'build', state: 'active', state_at: 'x' }] },
      { id: 'F-04', title: 'Homepage', lane: 'F', health: 'grey', status: 'paused', steps: [] },
    ],
    asks: [{ id: 'a1', task_id: 'T-31', text: 'ask', status: 'open' }],
    attachments: [{ id: 'att-17', task_id: 'T-31', name: 'a.png', mime: 'image/png', size: 70 }],
    times: { 'T-31/a': { transitions: [] } }, task_times: {}, goals: [], plans: { 'T-31': [] }, attention: { waiting: [] },
    ...over,
  };
}
const readerOf = (st, calls = []) => ({ async getState(...a) { calls.push(a.length); return { ok: true, state: st }; } });
const noFetch = async () => { throw new Error('fetch must not be called'); };
const sleep0 = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- module under test
const mod = await import(pathToFileURL(MODULE).href);
const realCreate = mod.createBoardReads;
// the state / media tests do not open anything: a decide that refuses and an open that records stand in (BH-6/8/9 pass their own)
const createBoardReads = (o) => realCreate({ decide: () => ({ action: 'refuse', reason: 'unused' }), open: async () => {}, ...o });

async function runAll() {
  // ---- BH-1: C1 + N3 the projection ----
  {
    const st = boardState();
    const reads = createBoardReads({ boardReader: readerOf(st), fetchImpl: noFetch });
    const r = await reads.state();
    const v = r.state;
    ok(r.ok === true && v && typeof v === 'object', 'BH-1a state() answers ok with an object');
    ok(JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...STATE_KEYS].sort()), 'BH-1b the view has exactly the 11 gate keys', Object.keys(v).sort());
    ok(STATE_KEYS.filter((k) => k !== 'tasks').every((k) => v[k] === st[k]), 'BH-1c every other projected value is the same reference as the reader\'s cached value');
    ok(FORBIDDEN_TOP.every((k) => !(k in v)), 'BH-1d notify / me / routing / roles / inbox ... are absent', FORBIDDEN_TOP.filter((k) => k in v));
    ok(!JSON.stringify(r).includes('SECRET-WEBHOOK-TOKEN') && !JSON.stringify(r).includes('secret-model') && !JSON.stringify(r).includes('tok-1'), 'BH-1e a non-empty notify.webhook_url, a role model and the token id appear nowhere in the answer');
    ok(v.tasks.length === st.tasks.length && v.tasks.every((t, i) => t.id === st.tasks[i].id), 'BH-1f the task list keeps every task in the board\'s order');
    ok(v.tasks.every((t) => Object.keys(t).every((k) => TASK_KEYS.includes(k))), 'BH-1g each task carries only fields Brain renders (N3)', v.tasks.map((t) => Object.keys(t).filter((k) => !TASK_KEYS.includes(k))));
    ok(v.tasks.every((t, i) => TASK_KEYS.every((k) => !(k in st.tasks[i]) || (k === 'steps' || k === 'current_step' ? true : t[k] === st.tasks[i][k]))), 'BH-1h each task field is the same reference as the cached field');
    ok(v.tasks.every((t) => FORBIDDEN_TASK.every((k) => !(k in t))), 'BH-1i attribution / worker / roles / measured / gate_fails ... are absent from every task (N3)', FORBIDDEN_TASK.filter((k) => v.tasks.some((t) => k in t)));
    const s0 = v.tasks[0].steps[0], c0 = st.tasks[0].steps[0];
    ok(Object.keys(s0).every((k) => STEP_KEYS.includes(k)) && FORBIDDEN_STEP.every((k) => !(k in s0)) && STEP_KEYS.every((k) => s0[k] === c0[k]), 'BH-1j a step carries only id/label/sub/detail/state/zone, same references (N3)', Object.keys(s0));
    ok(JSON.stringify(v.tasks[0].current_step) === '{"id":"T-31/a"}', 'BH-1k current_step is reduced to its id (N3)', v.tasks[0].current_step);
    ok(v.tasks[0].architecture === st.tasks[0].architecture, 'BH-1l the structure diagram object is passed by reference');
    const again = (await reads.state()).state;
    ok(again === v, 'BH-1m the same cached object gives the same view (memoised, one projection per cache fill)');
    const other = (await createBoardReads({ boardReader: readerOf(boardState()), fetchImpl: noFetch }).state()).state;
    ok(other !== v, 'BH-1n a new cached object is projected afresh');
  }

  // ---- BH-2: C2 the size cap ----
  {
    const base = Buffer.byteLength(JSON.stringify((await createBoardReads({ boardReader: readerOf(boardState({ asks: [{ text: '' }] })), fetchImpl: noFetch }).state()).state));
    const withBytes = async (total) => {
      const st = boardState({ asks: [{ text: 'x'.repeat(total - base) }] });
      const lines = [];
      const reads = createBoardReads({ boardReader: readerOf(st), fetchImpl: noFetch, log: (l) => lines.push(l) });
      return { st, lines, reads, first: await reads.state(), second: await reads.state() };
    };
    const over = await withBytes(MiB4 + 1);
    ok(over.first.ok === false && over.first.reason === 'too_large' && !('state' in over.first), 'BH-2a 4 MiB + 1 byte -> { ok:false, reason:"too_large" } with no state', JSON.stringify(over.first).slice(0, 120));
    ok(over.lines.length === 1 && over.lines[0] === `state refused too_large ${MiB4 + 1}`, 'BH-2b exactly one log line with the reason and the byte count', over.lines);
    ok(over.second.ok === false && over.second.reason === 'too_large' && over.lines.length === 1, 'BH-2c a second call is refused again and logs nothing more (once per cached object)', over.lines);
    ok(!over.lines.join('').includes('xxxx'), 'BH-2d the log line carries no board text');
    const exact = await withBytes(MiB4);
    ok(exact.first.ok === true && exact.lines.length === 0, 'BH-2e exactly 4 MiB is accepted, nothing logged');
  }

  // ---- BH-3: C3 no cache knob ----
  {
    const calls = [];
    const reads = createBoardReads({ boardReader: readerOf(boardState(), calls), fetchImpl: noFetch });
    await reads.state({ maxAgeMs: 0 }); await reads.state(1, 2, 3); await reads.state();
    ok(calls.length === 3 && calls.every((n) => n === 0), 'BH-3a getState() is called with zero arguments, whatever state() was given', calls);
  }

  // ---- BH-10: C10 no default fetch ----
  {
    let err = null;
    try { createBoardReads({ boardReader: readerOf(boardState()) }); } catch (e) { err = e; }
    ok(err instanceof TypeError && /fetchImpl is required/.test(err.message), 'BH-10a constructing without fetchImpl throws a TypeError', err && err.message);
    err = null;
    try { createBoardReads({ boardReader: readerOf(boardState()), fetchImpl: 'nope' }); } catch (e) { err = e; }
    ok(err instanceof TypeError, 'BH-10b a non-function fetchImpl throws too');
    err = null;
    try { realCreate({ boardReader: readerOf(boardState()), fetchImpl: noFetch }); } catch (e) { err = e; }
    ok(err instanceof TypeError && /decide and open are required/.test(err.message), 'BH-10d constructing without decide / open throws a TypeError', err && err.message);
    const src = fs.readFileSync(MODULE, 'utf8');
    ok(!/fetchImpl\s*=\s*fetch/.test(src) && !/=\s*globalThis\.fetch/.test(src), 'BH-10c the module source has no `fetchImpl = fetch` default');
  }

  // ---- BH-12: the reader's reasons stay fixed words ----
  {
    const reasonOf = async (getState) => (await createBoardReads({ boardReader: { getState }, fetchImpl: noFetch }).state());
    const a = await reasonOf(async () => ({ ok: false, reason: 'unconfigured' }));
    ok(a.ok === false && a.reason === 'unconfigured', 'BH-12a a fixed reason word passes through', a);
    const b = await reasonOf(async () => ({ ok: false, reason: 'D:/data/secret/path.md went wrong' }));
    ok(b.ok === false && b.reason === 'offline' && !JSON.stringify(b).includes('secret'), 'BH-12b a reason that is not a fixed word never reaches the page', b);
    const c = await reasonOf(async () => { throw new Error('D:/data/secret/path.md'); });
    ok(c.ok === false && c.reason === 'offline' && !JSON.stringify(c).includes('secret'), 'BH-12c a throwing reader gives "offline" and no message', c);
    const d = await reasonOf(async () => ({ ok: true, state: [1, 2] }));
    ok(d.ok === false && d.reason === 'bad_state', 'BH-12d a state that is not an object is "bad_state"', d);
    const e = await reasonOf(async () => ({ ok: false, reason: 'http_503' }));
    ok(e.ok === false && e.reason === 'http_503', 'BH-12e http_<n> passes through', e);
  }
}

// ---------------------------------------------------------------- media (BH-3b, 5, 7, 8, 13, 14)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const MiB = 1024 * 1024;
const FORBIDDEN_LOG = /https?:\/\/|127\.0\.0\.1|\/api\/|x-zumi|token-123|D:|\\|4321|secret|ECONN/i;
function mediaState() {
  return boardState({ attachments: [
    { id: 'att-17', task_id: 'T-31', name: 'a.png', mime: 'image/png', size: 70 },
    { id: 'att-18', task_id: 'T-31', name: 'n.md', mime: 'text/markdown', size: 26 },
    { id: 'att-20', task_id: 'T-31', name: 'v.svg', mime: 'image/svg+xml', size: 90 },
    { id: 'att-21', task_id: 'T-31', name: 'b.jpg', mime: 'image/jpeg', size: 90 },
  ] });
}
/** A fetch Response stand-in: status, headers.get, and a body that is an async generator (it records whether the consumer stopped early). */
function mkRes({ status = 200, type = 'image/png', length, chunks = [PNG], rec = {} } = {}) {
  const h = new Map([['content-type', type]]);
  if (length !== undefined) h.set('content-length', String(length));
  async function* body() { let done = false; try { for (const c of chunks) yield c; done = true; } finally { rec.finished = done; rec.cancelled = !done; } }
  return { status, headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null }, body: body() };
}
/** Fake upstream: records every request, the peak number in flight, and the AbortSignal of each. */
function upstream(handler) {
  const u = { log: [], signals: [], inflight: 0, max: 0 };
  u.fetchImpl = async (url, init) => {
    u.log.push({ url, init }); u.signals.push(init && init.signal);
    u.inflight++; u.max = Math.max(u.max, u.inflight);
    try { return await handler(url, init, u.log.length); } finally { u.inflight--; }
  };
  return u;
}
function mkReads({ handler = async () => mkRes(), state = mediaState(), live = {}, getCalls, headers = { 'x-zumi-bridge-token': 'TOKEN-123' } } = {}) {
  const clock = { t: 5_000_000 };
  const st = { configured: true, locked: false, mode: 'live', ...live };
  const liveBoard = { status: () => st, bridgePort: async () => (live.port === null ? null : 4321), bridgeHeaders: async () => headers };
  const up = upstream(handler);
  const lines = [];
  const reads = createBoardReads({ boardReader: readerOf(state, getCalls), liveBoard, fetchImpl: up.fetchImpl, log: (l) => lines.push(l), now: () => clock.t });
  return { reads, up, lines, clock, st };
}
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await sleep0(); };

async function runMedia() {
  const { mock } = await import('node:test');

  // ---- BH-13: invalid inputs never reach the upstream (B13) ----
  {
    const m = mkReads();
    const cases = [
      ['att-1/../state', undefined, 'bad_id'], ['att-1?w=9', undefined, 'bad_id'], ['ATT-1', undefined, 'bad_id'], ['1', undefined, 'bad_id'], ['', undefined, 'bad_id'],
      ['att-' + '9'.repeat(13), undefined, 'bad_id'], ['a'.repeat(100), undefined, 'bad_id'], [null, undefined, 'bad_id'], [17, undefined, 'bad_id'],
      ['att-17', { w: 481 }, 'bad_width'], ['att-17', { w: 0 }, 'bad_width'], ['att-17', { w: '480' }, 'bad_width'], ['att-17', { w: null }, 'bad_width'], ['att-17', { w: 1599 }, 'bad_width'],
      ['att-18', undefined, 'not_image'], ['att-20', undefined, 'not_image'], ['att-99999', undefined, 'unknown_attachment'],
    ];
    const got = [];
    for (const [id, opts, want] of cases) { const r = await m.reads.media(id, opts); got.push([String(id).slice(0, 14), r.ok === false && r.reason === want]); }
    ok(got.every(([, g]) => g), 'BH-13a every invalid id / width / attachment is refused with its own reason', got.filter(([, g]) => !g));
    ok(m.up.log.length === 0, 'BH-13b ... and the upstream request log stays at 0', m.up.log.map((x) => x.url));
    const good = await m.reads.media('att-17');
    ok(good.ok === true && m.up.log.length === 1, 'BH-13c one valid call gives exactly one upstream request (the log can see a request)', m.up.log.length);
    ok(m.up.log[0] && m.up.log[0].url === 'http://127.0.0.1:4321/api/v1/media/att-17?w=480', 'BH-13d the request URL is exactly the media route on the bridge port, default width 480', m.up.log[0] && m.up.log[0].url);
    ok(m.up.log[0] && m.up.log[0].init.redirect === 'manual' && m.up.log[0].init.headers['x-zumi-bridge-token'] === 'TOKEN-123', 'BH-13e redirects are not followed and the bridge headers are sent');
    const big = await m.reads.media('att-17', { w: 1600 });
    ok(big.ok === true && m.up.log[1] && m.up.log[1].url.endsWith('?w=1600'), 'BH-13f width 1600 is allowed (lightbox)');
    ok(good.mime === 'image/png' && Buffer.isBuffer(good.bytes) && Buffer.compare(good.bytes, PNG) === 0, 'BH-13g the answer is { ok, mime, bytes } with the exact bytes');
    // BH-17b: the success answer carries exactly { ok, mime, bytes }; the bridge caller headers and any extra field stay out
    {
      const SENTINEL = 'SENTINEL-7f3a91c2';
      const sm = mkReads({ headers: { 'x-zumi-bridge-test': SENTINEL, 'x-zumi-bridge-token': SENTINEL } });
      const r = await sm.reads.media('att-17');
      const keys = Object.getOwnPropertyNames(r).sort();
      const { bytes: _b, ...rest } = r;
      const flat = JSON.stringify(rest) + keys.join(',');
      ok(r.ok === true && sm.up.log.length === 1 && sm.up.log[0].init.headers['x-zumi-bridge-test'] === SENTINEL, 'BH-17b-pre the sentinel bridge header is sent upstream (the leak probe can see it)');
      ok(keys.join(',') === 'bytes,mime,ok' && r.ok === true && r.mime === 'image/png' && (Buffer.isBuffer(r.bytes) || r.bytes instanceof Uint8Array) && Buffer.compare(Buffer.from(r.bytes), PNG) === 0, 'BH-17b a successful board.media answer has exactly the own keys ok, mime, bytes (exact image bytes)', keys);
      ok(!flat.includes(SENTINEL) && !/bridge|token/i.test(flat), 'BH-17b the bridge caller headers leak nowhere into the answer (keys or values, bytes excluded)', flat.slice(0, 120));
    }
    // refusals that come back from the upstream
    const probe = async (res, id = 'att-17') => (await mkReads({ handler: async () => res }).reads.media(id));
    const cases2 = [
      ['6 MiB streamed, no content-length -> too_large', () => mkRes({ chunks: Array.from({ length: 6 }, () => Buffer.alloc(MiB, 1)) }), 'too_large'],
      ['content-length 6 MiB -> too_large', () => mkRes({ length: 6 * MiB }), 'too_large'],
      ['wrong magic -> bad_image', () => mkRes({ chunks: [Buffer.from('this is not a png at all, just text')] }), 'bad_image'],
      ['svg content-type -> not_image', () => mkRes({ type: 'image/svg+xml' }), 'not_image'],
      ['302 -> http_302', () => mkRes({ status: 302 }), 'http_302'],
      ['500 -> http_500', () => mkRes({ status: 500 }), 'http_500'],
      ['404 -> http_404', () => mkRes({ status: 404 }), 'http_404'],
    ];
    for (const [name, mk, want] of cases2) { const r = await probe(mk()); ok(r.ok === false && r.reason === want && !('bytes' in r), `BH-13h ${name}`, r); }
    const ct = await probe(mkRes({ type: 'image/png; charset=binary' }));
    ok(ct.ok === true, 'BH-13i a content-type with a parameter is read by its media type');
    const jpegBad = await probe(mkRes({ type: 'image/jpeg' }), 'att-21');
    ok(jpegBad.ok === false && jpegBad.reason === 'bad_image', 'BH-13j a PNG body served as image/jpeg is bad_image (the bytes must match the type)', jpegBad);
  }

  // ---- upstream gates in the reader's own order and words (no request) ----
  {
    const each = async (label, live, want) => {
      const m = mkReads({ live });
      const r = await m.reads.media('att-17');
      ok(r.ok === false && r.reason === want && m.up.log.length === 0, `BH-14 ${label} -> ${want}, 0 requests`, { r, n: m.up.log.length });
    };
    await each('not configured', { configured: false }, 'unconfigured');
    await each('locked', { locked: true }, 'locked');
    await each('auth rejected', { authRejected: true }, 'auth_rejected');
    await each('mirror / not live mode', { mode: 'local' }, 'not_live');
    await each('bridge has no port', { port: null }, 'not_live');
    const up = upstream(async () => mkRes());
    const reads = createBoardReads({ boardReader: { async getState() { return { ok: false, reason: 'locked' }; } }, liveBoard: { status: () => ({ configured: true, mode: 'live' }), bridgePort: async () => 4321, bridgeHeaders: async () => ({}) }, fetchImpl: up.fetchImpl });
    const r = await reads.media('att-17');
    ok(r.ok === false && r.reason === 'locked' && up.log.length === 0, 'BH-14 the reader\'s own refusal passes through, 0 requests', r);
  }

  // ---- BH-5: C5 in-flight and rate limits ----
  {
    let release; const gate = new Promise((r) => { release = r; });
    const m = mkReads({ handler: async () => { await gate; return mkRes(); } });
    const calls = Array.from({ length: 10 }, () => m.reads.media('att-17'));
    await settle(30);
    const early = await Promise.all(calls.map((c) => Promise.race([c, settle(1).then(() => null)])));
    const busyNow = early.filter((r) => r && r.ok === false && r.reason === 'busy').length;
    ok(m.up.max === 4 && m.up.log.length === 4, 'BH-5a 10 parallel valid calls: at most 4 upstream requests ever in flight', { max: m.up.max, sent: m.up.log.length });
    ok(busyNow === 6, 'BH-5b ... and the other 6 get { ok:false, reason:"busy" } straight away', busyNow);
    release();
    const all = await Promise.all(calls);
    ok(all.filter((r) => r.ok).length === 4 && all.filter((r) => r.reason === 'busy').length === 6, 'BH-5c the 4 admitted calls complete ok', all.map((r) => r.ok || r.reason));
    const after = await m.reads.media('att-17');
    ok(after.ok === true, 'BH-5d after they finish the counter is back to 0 (a new call is admitted)', after);
  }
  {
    const m = mkReads();
    let accepted = 0;
    for (let i = 0; i < 120; i++) { const r = await m.reads.media('att-17'); if (r.ok) accepted++; }
    ok(accepted === 120, 'BH-5e 120 valid calls inside one minute are all accepted', accepted);
    const r121 = await m.reads.media('att-17');
    ok(r121.ok === false && r121.reason === 'rate_limited' && m.up.log.length === 120, 'BH-5f call 121 inside 60 s -> rate_limited, no 121st request', { r121, sent: m.up.log.length });
    m.clock.t += 59_999;
    ok((await m.reads.media('att-17')).reason === 'rate_limited', 'BH-5g at +59.999 s still limited');
    m.clock.t += 1;
    const again = await m.reads.media('att-17');
    ok(again.ok === true, 'BH-5h at +60 s the window has moved on: accepted', again);
  }

  // ---- BH-7: C7 abort on every refusal after the request, timer, stream ----
  {
    const run = async (mk) => { const rec = {}; const m = mkReads({ handler: async () => mk(rec) }); const r = await m.reads.media('att-17'); return { r, aborted: m.up.signals[0] && m.up.signals[0].aborted, rec }; };
    const sixMiB = (rec) => mkRes({ chunks: Array.from({ length: 6 }, () => Buffer.alloc(MiB, 1)), rec });
    const a = await run(sixMiB);
    ok(a.r.reason === 'too_large' && a.aborted === true && a.rec.cancelled === true, 'BH-7a stream over 5 MiB: refused, the signal is aborted and the body stream was cancelled', { reason: a.r.reason, aborted: a.aborted, rec: a.rec });
    const b = await run((rec) => mkRes({ length: 6 * MiB, rec }));
    ok(b.r.reason === 'too_large' && b.aborted === true, 'BH-7b content-length over 5 MiB: refused, aborted', b.r);
    const c = await run((rec) => mkRes({ status: 500, rec }));
    ok(c.r.reason === 'http_500' && c.aborted === true, 'BH-7c http 500: aborted', c.r);
    const d = await run((rec) => mkRes({ status: 302, rec }));
    ok(d.r.reason === 'http_302' && d.aborted === true, 'BH-7d http 302: aborted', d.r);
    const e = await run((rec) => mkRes({ type: 'image/svg+xml', rec }));
    ok(e.r.reason === 'not_image' && e.aborted === true, 'BH-7e not an image type: aborted', e.r);
    const f = await run((rec) => mkRes({ chunks: [Buffer.from('plain text, no magic')], rec }));
    ok(f.r.reason === 'bad_image' && f.aborted === true, 'BH-7f wrong magic bytes: aborted', f.r);
    const g = await run((rec) => mkRes({ rec }));
    ok(g.r.ok === true && g.aborted === false, 'BH-7g success path: the signal is NOT aborted', { ok: g.r.ok, aborted: g.aborted });
    // the 15 s timer, on a mocked clock: a request that never answers
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const m = mkReads({ handler: (_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
      const p = m.reads.media('att-17');
      await settle(20);
      mock.timers.tick(14_999); await settle(5);
      const early = m.up.signals[0] && m.up.signals[0].aborted;
      mock.timers.tick(1);
      const r = await Promise.race([p, settle(40).then(() => ({ hung: true }))]);   // a request nobody aborts would hang forever: that is the failure
      ok(early === false && r.reason === 'timeout' && m.up.signals[0].aborted === true, 'BH-7h no answer for 15 s: aborted at the 15 s mark with reason "timeout"', { early, r });
      const ok2 = mkReads();
      const done = await ok2.reads.media('att-17');
      mock.timers.tick(20_000); await settle(3);
      ok(done.ok === true && ok2.up.signals[0].aborted === false, 'BH-7i the timer is cleared on success (nothing aborts a finished request later)');
    } finally { mock.timers.reset(); }
  }

  // ---- BH-8 (media half): C8 one path-free log line per refusal ----
  {
    const sixMiB = () => mkRes({ chunks: Array.from({ length: 6 }, () => Buffer.alloc(MiB, 1)) });
    const scenarios = [
      ['bad_id', {}, (r) => r.media('att-1/../state')], ['bad_width', {}, (r) => r.media('att-17', { w: 7 })], ['unknown_attachment', {}, (r) => r.media('att-9')],
      ['not_image', {}, (r) => r.media('att-18')], ['unconfigured', { live: { configured: false } }, (r) => r.media('att-17')], ['locked', { live: { locked: true } }, (r) => r.media('att-17')],
      ['auth_rejected', { live: { authRejected: true } }, (r) => r.media('att-17')], ['not_live', { live: { mode: 'local' } }, (r) => r.media('att-17')],
      ['http_500', { handler: async () => mkRes({ status: 500 }) }, (r) => r.media('att-17')], ['http_302', { handler: async () => mkRes({ status: 302 }) }, (r) => r.media('att-17')],
      ['too_large', { handler: async () => sixMiB() }, (r) => r.media('att-17')], ['bad_image', { handler: async () => mkRes({ chunks: [Buffer.from('xxxxxxxxxxxx')] }) }, (r) => r.media('att-17')],
      ['offline', { handler: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4321 D:/data/secret/x.png'); } }, (r) => r.media('att-17')],
    ];
    const bad = [];
    for (const [want, cfg, call] of scenarios) {
      const m = mkReads(cfg);
      const r = await call(m.reads);
      const okLine = m.lines.length === 1 && /^media refused [a-z0-9_]+( att-\d{1,12})?$/.test(m.lines[0]) && !FORBIDDEN_LOG.test(m.lines[0]) && m.lines[0].startsWith(`media refused ${want}`);
      if (r.reason !== want || !okLine) bad.push({ want, r: r.reason, lines: m.lines });
    }
    ok(bad.length === 0, 'BH-8a every media refusal writes exactly one line: "media refused <reason>[ att-n]", no URL / port / header / path / error text', bad);
    const m = mkReads();
    await m.reads.media('att-1/../state'); await m.reads.media('<script>');
    ok(m.lines.join('|') === 'media refused bad_id|media refused bad_id', 'BH-8b a bad id is never echoed into the log', m.lines);
    const s = mkReads();
    await s.reads.media('att-17');
    ok(s.lines.length === 0, 'BH-8c a successful read logs nothing', s.lines);
  }

  // ---- BH-3b: no argument reaches getState from media either ----
  {
    const calls = [];
    const m = mkReads({ getCalls: calls });
    await m.reads.media('att-17', { w: 480, maxAgeMs: 0 }); await m.reads.media('att-18'); await m.reads.media('att-99999');
    ok(calls.length === 3 && calls.every((n) => n === 0), 'BH-3b getState() is called with zero arguments by media() too', calls);
  }
}

// ---------------------------------------------------------------- openRef (BH-3c, 6, 8, 9; B14, B15)
const { decideOpenRef } = await import(pathToFileURL(path.join(ROOT, 'src', 'main', 'board-open.mjs')).href);
const URL_CITED = 'https://user:pw@evil.example/a?x=SECRET#frag';
/** A board that cites refs in every field the HUD reads, plus ones the decide step must refuse. */
function openState() {
  const st = boardState();
  st.tasks[0].goal = `Check \`${R0}x/a.md.bak\` and [Spec](https://example.com/spec?a=1)`;
  st.tasks[0].dossier = `${R0}x/DOSSIER.md`;
  st.tasks[0].steps[0].detail = `Shot\n\`${W0}x\\shot.png\``;
  st.tasks[0].next = `Run \`${R0}x/run.exe\` or \`${R0}x/run.cmd:x.md\` or \`C:/Windows/win.ini\` or [Creds](` + URL_CITED + ') or [Ip](https://192.168.1.5/x) or [Local](http://127.0.0.1:4320/)';
  st.asks = [{ id: 'a1', task_id: 'T-31', status: 'open', text: `Pick one · [Doc](https://docs.example.org/p) · \`${R0}x/a.md\`` }];
  st.plans = { 'T-31': [{ id: 'p1', body: `Plan \`${R1}p.md\`` }] };
  st.attention = { waiting: [{ id: 'a1', task_id: 'T-31', text: `Wait \`${R0}w.md\`` }] };
  return st;
}
const FILE = { isDirectory: () => false, isFile: () => true };
const realDecide = (ownerAdmin) => (ref) => decideOpenRef(ref, { ownerAdmin, realpath: (p) => path.win32.normalize(p), stat: () => FILE });
function mkOpen({ state = openState(), decide, open, getCalls, ownerAdmin } = {}) {
  const clock = { t: 9_000_000 };
  const entries = [], lines = [], opened = [], decided = [];
  const dec = ownerAdmin !== undefined ? realDecide(ownerAdmin) : (decide || ((ref) => ({ action: 'openPath', path: ref.target, kind: 'file' })));
  const reads = realCreate({
    boardReader: readerOf(state, getCalls), liveBoard: { status: () => ({ configured: true, mode: 'live' }), bridgePort: async () => 4321, bridgeHeaders: async () => ({}) }, fetchImpl: noFetch,
    decide: (ref) => { decided.push(ref); return dec(ref); },
    open: async (d) => { opened.push(d); if (open) await open(d); },
    logRefusal: (r) => entries.push(r), log: (l) => lines.push(l), now: () => clock.t,
  });
  // each call is 7 s after the last: the C6 gap and the 10-per-minute window never interfere with the case under test
  const go = async (ref) => { clock.t += 7000; return reads.openRef(ref); };
  return { reads, clock, entries, lines, opened, decided, go };
}
const L = (target) => ({ kind: 'local', target });
const U = (target) => ({ kind: 'url', target });
const FORBIDDEN_ENTRY = /D:|\\|secret|SECRET|user:pw|evil\.example\/|\?x=|#frag|ENOENT|\.md|\.png|\.exe|win\.ini/i;

async function runOpen() {
  // ---- BH-9: C9 exact match, before decide ----
  {
    const m = mkOpen();
    const exact = await m.go(L(`${R0}x/a.md.bak`));
    ok(exact.opened === true && m.decided.length === 1 && m.opened.length === 1, 'BH-9a a cited local ref, exactly as extractRefs gives it, passes H1, goes to decide, and opens', { exact, decided: m.decided.length });
    const refused = [
      [`strict prefix ${R0}`, L(`${R0}`)], ['strict prefix .../x/a.m of a cited path', L(`${R0}x/a.m`)],
      ['suffix x/a.md.bak', L('x/a.md.bak')], ['case change', L(`${R0.toLowerCase()}x/a.md.bak`)], ['trailing slash', L(`${R0}x/a.md.bak/`)],
      ['kind swapped to url', U(`${R0}x/a.md.bak`)], ['kind swapped to local', L('https://example.com/spec?a=1')], ['backslash form of a cited path', L(`${W0}x\\a.md.bak`)],
      ['a file that is on disk but not on the board', L(`${R0}x/other.md`)], ['empty-ish whitespace padded', L(` ${R0}x/a.md.bak`)],
      ['a url prefix', U('https://example.com/')], ['a url with an extra query', U('https://example.com/spec?a=1&b=2')],
    ];
    const bad = [];
    for (const [name, ref] of refused) {
      const before = m.decided.length;
      const r = await m.go(ref);
      if (!(r.opened === false && r.reason === 'not_on_board' && m.decided.length === before)) bad.push({ name, r, decideCalled: m.decided.length - before });
    }
    ok(bad.length === 0, 'BH-9b prefix / suffix / case / trailing / kind-swap / uncited targets are refused with not_on_board and decide is never called', bad);
    const fields = [
      ['task goal (url)', U('https://example.com/spec?a=1')], ['dossier (as local)', L(`${R0}x/DOSSIER.md`)], ['step detail (backslashes normalised)', L(`${R0}x/shot.png`)],
      ['ask text', U('https://docs.example.org/p')], ['ask text (local)', L(`${R0}x/a.md`)], ['plan body', L(`${R1}p.md`)], ['attention.waiting text', L(`${R0}w.md`)],
    ];
    const bad2 = [];
    for (const [name, ref] of fields) { const r = await m.go(ref); if (r.opened !== true) bad2.push({ name, r }); }
    ok(bad2.length === 0, 'BH-9c every field the HUD reads can cite a ref: goal, dossier, step detail, ask, plan, waiting', bad2);
    const dossierUrl = await m.go(U(`${R0}x/DOSSIER.md`));
    ok(dossierUrl.opened === false && dossierUrl.reason === 'not_on_board', 'BH-9d a dossier counts as kind local only', dossierUrl);
    // set built once per cached state
    const m2 = mkOpen();
    await m2.go(L(`${R0}x/a.md.bak`)); await m2.go(L(`${R0}x/DOSSIER.md`));
    ok(m2.opened.length === 2, 'BH-9e two refs of the same cached state both resolve (set built once and reused)');
    // the state fields the projection dropped can never cite a ref
    const hid = openState();
    hid.notify.webhook_url = 'https://hooks.example.test/x'; hid.me.prefs = { link: `\`${R0}hidden.md\`` };
    const m3 = mkOpen({ state: hid });
    const r3 = await m3.go(L(`${R0}hidden.md`)); const r4 = await m3.go(U('https://hooks.example.test/x'));
    ok(r3.reason === 'not_on_board' && r4.reason === 'not_on_board', 'BH-9f a ref in a field the projection drops (notify, me) is not on the board', [r3, r4]);
  }

  // ---- BH-6: C6 in flight, gap, window ----
  {
    let release; const gate = new Promise((r) => { release = r; });
    const m = mkOpen({ open: () => gate });
    const first = m.reads.openRef(L(`${R0}x/a.md.bak`));
    await settle(10);
    m.clock.t += 5000;   // far past the 1 s gap: only "one in flight" can refuse the second call
    const second = await Promise.race([m.reads.openRef(L(`${R0}x/DOSSIER.md`)), settle(40).then(() => ({ hung: true }))]);   // without the guard it queues behind the held open
    ok(second.opened === false && second.reason === 'rate_limited' && m.decided.length === 1, 'BH-6a a second open while one is still running -> rate_limited (after the 1 s gap)', second);
    release();
    ok((await first).opened === true, 'BH-6b the first open completes');
    const next = await m.reads.openRef(L(`${R0}x/DOSSIER.md`));   // 5 s after the first: the gap is fine, so this one runs and restarts the gap
    ok(next.opened === true, 'BH-6b2 once the first is done, the next open (past the gap) runs', next);
    m.clock.t += 500;
    const tooSoon = await m.reads.openRef(L(`${R0}x/shot.png`));
    ok(tooSoon.reason === 'rate_limited', 'BH-6c 500 ms after the last open -> rate_limited', tooSoon);
    m.clock.t += 500;
    const nowOk = await m.reads.openRef(L(`${R0}x/shot.png`));
    ok(nowOk.opened === true, 'BH-6d 1000 ms after the last open -> proceeds', nowOk);
  }
  {
    const m = mkOpen();
    const refs = [L(`${R0}x/a.md.bak`), L(`${R0}x/DOSSIER.md`), L(`${R0}x/shot.png`)];
    const res = [];
    for (let i = 0; i < 10; i++) { res.push(await m.reads.openRef(refs[i % 3])); m.clock.t += 1000; }
    ok(res.every((r) => r.opened === true), 'BH-6e 10 opens, one per second, inside one minute are all accepted', res.map((r) => r.opened || r.reason));
    const eleventh = await m.reads.openRef(refs[0]);
    ok(eleventh.opened === false && eleventh.reason === 'rate_limited', 'BH-6f the 11th inside 60 s -> rate_limited', eleventh);
    m.clock.t += 49_999;  // 59.999 s after the first take (taken at t0; now t0 + 10 s + 49.999 s)
    ok((await m.reads.openRef(refs[1])).reason === 'rate_limited', 'BH-6g at +59.999 s after the first open: still limited');
    m.clock.t += 1;
    ok((await m.reads.openRef(refs[1])).opened === true, 'BH-6h at +60 s the window has moved on: accepted');
    const refusedFirst = mkOpen({ state: openState() });
    const hit = await refusedFirst.reads.openRef(L('D:/data/nope')); // a refused call also uses a slot
    ok(hit.reason === 'not_on_board' && refusedFirst.decided.length === 0, 'BH-6i the limits run before any state read or decide (a refused call costs a slot, never a file-system touch)');
  }

  // ---- BH-8 (open half): C8 every refusal is exactly one path-free entry ----
  {
    const bad = [];
    const check = (name, m, r, wantReason, wantOrigin) => {
      const e = m.entries;
      const good = e.length === 1 && Object.keys(e[0]).every((k) => k === 'reason' || k === 'origin') && /^[a-z_]+$/.test(e[0].reason) && e[0].reason === wantReason
        && (wantOrigin === undefined ? !('origin' in e[0]) : e[0].origin === wantOrigin) && !FORBIDDEN_ENTRY.test(JSON.stringify(e[0])) && m.lines.length === 0 && r.opened === false && r.reason === wantReason;
      if (!good) bad.push({ name, r, entries: e, lines: m.lines });
    };
    for (const [name, ref] of [['null', null], ['empty object', {}], ['bad kind', { kind: 'x', target: 'a' }], ['empty target', L('')], ['numeric target', { kind: 'local', target: 5 }], ['huge target', L('D:/' + 'a'.repeat(3000))], ['array', []]]) {
      const m = mkOpen(); const r = await m.go(ref); check(`bad_request: ${name}`, m, r, 'bad_request');
    }
    { const m = mkOpen(); const r = await m.go(L(`${R0}nope.md`)); check('not_on_board local', m, r, 'not_on_board'); }
    { const m = mkOpen(); const r = await m.go(U('https://user:pw@evil.example/b?x=SECRET#frag')); check('not_on_board url keeps scheme://host only', m, r, 'not_on_board', 'https://evil.example'); }
    { const m = mkOpen(); await m.go(L(`${R0}x/a.md.bak`)); m.entries.length = 0; m.clock.t -= 6500; const r = await m.reads.openRef(L(`${R0}x/DOSSIER.md`)); check('rate_limited local', m, r, 'rate_limited'); }
    { const m = mkOpen(); await m.go(L(`${R0}x/a.md.bak`)); m.entries.length = 0; m.clock.t -= 6500; const r = await m.reads.openRef(U('https://user:pw@evil.example/a?x=SECRET#frag')); check('rate_limited url keeps scheme://host only', m, r, 'rate_limited', 'https://evil.example'); }
    for (const why of ['unconfigured', 'locked', 'offline']) {
      const m = mkOpen({ state: openState() });
      m.reads = realCreate({ boardReader: { async getState() { return { ok: false, reason: why }; } }, liveBoard: { status: () => ({}), bridgePort: async () => 1, bridgeHeaders: async () => ({}) }, fetchImpl: noFetch, decide: () => ({ action: 'openPath' }), open: async () => {}, logRefusal: (r) => m.entries.push(r), log: (l) => m.lines.push(l), now: () => (m.clock.t += 7000) });
      const r = await m.reads.openRef(L(`${R0}x/a.md.bak`)); check(`state reason ${why}`, m, r, why);
    }
    { const m = mkOpen({ decide: () => ({ action: 'refuse', reason: 'outside_allowed_folders', path: 'D:/data/secret/zz.md', ext: '.md' }) }); const r = await m.go(L(`${R0}x/a.md.bak`)); check('decide refusal drops path and ext', m, r, 'outside_allowed_folders'); }
    { const m = mkOpen({ decide: () => ({ action: 'refuse', reason: 'url_has_credentials', origin: 'https://evil.example' }) }); const r = await m.go(U(URL_CITED)); check('decide refusal keeps the origin', m, r, 'url_has_credentials', 'https://evil.example'); }
    { const m = mkOpen({ decide: () => { throw new Error('D:/data/secret/boom'); } }); const r = await m.go(L(`${R0}x/a.md.bak`)); check('decide throws', m, r, 'bad_request'); }
    { const m = mkOpen({ open: async () => { throw new Error(`${R0}secret.md ENOENT`); } }); const r = await m.go(L(`${R0}x/a.md.bak`)); check('open throws a path-bearing error -> open_failed', m, r, 'open_failed'); }
    { const m = mkOpen({ open: async () => { throw new Error('open_unavailable'); } }); const r = await m.go(U('https://example.com/spec?a=1')); check('public flavour opener -> open_unavailable', m, r, 'open_unavailable'); }
    ok(bad.length === 0, 'BH-8d every open refusal (bad_request, rate_limited, not_on_board, state reasons, each decide refusal, open_failed, open_unavailable) is exactly one { reason[, origin] } entry, no path / query / userinfo / error text, nothing on stdout', bad);
    const okCase = mkOpen(); const done = await okCase.go(L(`${R0}x/a.md.bak`));
    ok(done.opened === true && okCase.entries.length === 0 && okCase.lines.length === 0, 'BH-8e a successful open writes no refusal and no line');
  }

  // ---- B14: decide runs unchanged; same reasons as the board's own open path ----
  {
    const cites = [
      ['C:/Windows/win.ini', L('C:/Windows/win.ini')], [`${R0}x/run.exe`, L(`${R0}x/run.exe`)], [`${R0}x/run.cmd:x.md`, L(`${R0}x/run.cmd:x.md`)],
      ['cited allowed file', L(`${R0}x/a.md.bak`)], ['cited allowed md', L(`${R0}x/a.md`)], ['https plain host', U('https://example.com/spec?a=1')],
      ['url with credentials', U(URL_CITED)], ['IP literal', U('https://192.168.1.5/x')], ['loopback preview', U('http://127.0.0.1:4320/')],
    ];
    for (const ownerAdmin of [true, false]) {
      const mismatches = [];
      const m = mkOpen({ ownerAdmin });
      for (const [name, ref] of cites) {
        const want = realDecide(ownerAdmin)(ref);
        const r = await m.go(ref);
        const same = want.action === 'refuse' ? (r.opened === false && r.reason === want.reason) : r.opened === true;
        if (!same) mismatches.push({ name, want: want.action === 'refuse' ? want.reason : want.action, got: r.opened ? 'opened' : r.reason });
      }
      ok(mismatches.length === 0, `BH-15${ownerAdmin ? 'a owner' : 'b public'} build: every cited ref gets exactly decideOpenRef's answer (opens, or the same refusal word)`, mismatches);
      if (ownerAdmin) ok(m.opened.some((d) => d.action === 'openPath') && m.opened.some((d) => d.action === 'openExternal'), 'BH-15c the owner build opens files and web links through the host opener');
      else ok(m.opened.every((d) => d.action === 'openExternal'), 'BH-15d the public build never opens a local file (only web links, as the Board tab does)', m.opened.map((d) => d.action));
    }
    const m = mkOpen({ ownerAdmin: true });
    const unc = await m.go(L(`${R0}x/a.md`));
    const refusals = mkOpen({ ownerAdmin: true });
    const w = await refusals.go(L('C:/Windows/win.ini')), e = await refusals.go(L(`${R0}x/run.exe`)), t = await refusals.go(L(`${R0}x/run.cmd:x.md`));
    ok(unc.opened === true && w.reason === 'outside_allowed_folders' && e.reason === 'type_not_allowed' && t.reason === 'name_trick', 'BH-15e out-of-roots / .exe / stream name refuse with the reason words check-board-open.mjs expects', { w: w.reason, e: e.reason, t: t.reason });
  }

  // ---- B15a: unconfigured board: nothing is "on the board" ----
  {
    const m = mkOpen({ ownerAdmin: true });
    m.reads = realCreate({ boardReader: { async getState() { return { ok: false, reason: 'unconfigured' }; } }, liveBoard: { status: () => ({ configured: false }), bridgePort: async () => null, bridgeHeaders: async () => ({}) }, fetchImpl: noFetch, decide: realDecide(true), open: async () => { throw new Error('must not open'); }, logRefusal: (r) => m.entries.push(r), now: () => (m.clock.t += 7000) });
    const s = await m.reads.state(), md = await m.reads.media('att-17'), o = await m.reads.openRef(L(`${R0}x/a.md`));
    ok(s.reason === 'unconfigured' && md.reason === 'unconfigured' && o.opened === false && o.reason === 'unconfigured', 'BH-15f unconfigured: state, media and openRef all answer "unconfigured"', [s, md, o]);
  }

  // ---- BH-3c ----
  {
    const calls = [];
    const m = mkOpen({ getCalls: calls });
    await m.go(L(`${R0}x/a.md.bak`)); await m.go(L('nope')); await m.go(null);
    ok(calls.length === 2 && calls.every((n) => n === 0), 'BH-3c getState() is called with zero arguments by openRef() too (and not at all for a bad request)', calls);
  }
}

// ---------------------------------------------------------------- static: the next-UI gate in main / preload / build artefact (BH-4, 16, 17, 11)
const STATIC_ROOT = path.resolve(argOf('--static-root') || ROOT);
const ONLY_STATIC = args.includes('--only-static');
// Default anchor for BH-11b/c/e: the merge-base with the OSS line, not a fixed commit, so the next OSS rebase must not break it.
// Re-pinned in T-31 P0c (CoS-approved): the OSS line is now the P0/P0b scrub tip 038dbbb7 (merged into T-31-oss-next as
// 132ef4b8), no longer T-31-oss-split (merge-base c1ca750d). P0/P0b changed board-bridge / board-reader / board-open,
// open_path.rs and the existing check scripts ON PURPOSE (owner values out of the source, scrubbed fixtures); owner behaviour
// is proven identical by the 21 owner checks of the P0b review (same exit and counts before and after). The freeze itself is
// unchanged: from this anchor on, the same files may not move. An anchor that holds this file (e.g. 132ef4b8) cannot work:
// BH-11e would flag this file's own later edits.
// BH_OSS_REF names that line (env override only so the fallback can be shown); if the ref or the merge-base is missing, fall back to the same commit.
const P0B_TIP = '038dbbb71a051686a5662fa19693411f2057f22f';
const OSS_ANCHOR = (() => {
  const r = spawnSync('git', ['merge-base', 'HEAD', process.env.BH_OSS_REF || P0B_TIP], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 && /^[0-9a-f]{8,40}$/.test(r.stdout.trim()) ? r.stdout.trim() : P0B_TIP;
})();
const BASE_REF = argOf('--base') || OSS_ANCHOR;   // the frozen files must be byte-equal to it
const START_REF = argOf('--start') || OSS_ANCHOR; // no existing check script may differ from it
const rd = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const listCode = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : listCode(path.join(dir, e.name))) : /\.(c|m)?js$/.test(e.name) ? [path.join(dir, e.name)] : [])) : []);
/** index of the `}` that closes the first `{` at or after `from` (strings and comments are not special-cased: the blocks checked here have none with braces) */
function blockEnd(text, from) {
  let depth = 0;
  for (let i = text.indexOf('{', from); i >= 0 && i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) return i; }
  return -1;
}
const within = (text, openers, idx) => openers.some((o) => idx > o && idx < blockEnd(text, o));
const occurrences = (text, needle) => { const out = []; for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i); return out; };
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

async function runStatic(root, { git: withGit }) {
  const main = rd(root, 'src/main/main.js'), preload = rd(root, 'src/main/preload.js');
  // ---- BH-4: C4 the flag is a build artefact; handlers and keys exist only behind it; no env var is read ----
  const hostFiles = [...listCode(path.join(root, 'src', 'main')), ...listCode(path.join(root, 'tauri', 'sidecar'))];
  const envReaders = hostFiles.filter((f) => /process\.env(\.ZUMI_NEXT_UI|\[\s*['"]ZUMI_NEXT_UI['"]\s*\])/.test(fs.readFileSync(f, 'utf8')));
  ok(hostFiles.length > 20 && envReaders.length === 0, 'BH-4a no `process.env.ZUMI_NEXT_UI` in src/main (or tauri/sidecar): the runtime env var never decides', envReaders.map((f) => path.relative(root, f)));
  const flagLine = main.split('\n').find((l) => l.startsWith('const NEXT_UI = ')) || '';
  ok(/path\.join\(RENDERER_DIR, 'next-ui\.json'\)/.test(flagLine) && !/APP_ROOT|'build'/.test(flagLine) && /catch \{ return false; \}/.test(flagLine), 'BH-4b main.js reads build/renderer/next-ui.json through the existing RENDERER_DIR (N1), fail-closed', flagLine.slice(0, 160));
  const openers = occurrences(main, 'if (NEXT_UI) {');
  const chans = ['board:state', 'board:media', 'board:open-ref'].map((c) => occurrences(main, `ipcMain.handle('${c}'`));
  ok(openers.length === 2 && chans.every((o) => o.length === 1 && within(main, openers, o[0])), 'BH-4c all three ipcMain.handle calls sit inside an `if (NEXT_UI) {` block (and there is no other registration)', { blocks: openers.length, chans: chans.map((o) => o.length) });
  const builds = occurrences(main, 'createBoardReads(');
  ok(builds.length === 1 && within(main, openers, builds[0]), 'BH-4d boardReads is only built inside an `if (NEXT_UI) {` block');
  const keyAt = ["ipcRenderer.invoke('board:state')", "ipcRenderer.invoke('board:media'", "ipcRenderer.invoke('board:open-ref'"].map((n) => occurrences(preload, n));
  const gateAt = occurrences(preload, '...(NEXT_UI ? {');
  ok(gateAt.length === 1 && keyAt.every((o) => o.length === 1 && o[0] > gateAt[0] && o[0] < blockEnd(preload, gateAt[0])), 'BH-4e the three preload keys exist only inside `...(NEXT_UI ? {` (the spread is empty in an OFF build)', { gate: gateAt.length, keys: keyAt.map((o) => o.length) });
  ok(/const NEXT_UI = process\.argv\.includes\('--zumi-next-ui=1'\);/.test(preload) && /additionalArguments: NEXT_UI \? \['--zumi-next-ui=1'\] : \[\],/.test(main), 'BH-17 main passes --zumi-next-ui=1 to the preload only when the flag is on', 'preload or additionalArguments line changed');
  // ---- BH-18: the renderer's refs.js finds the same refs as the HUD parser the host matches against ----
  {
    const hud = await import(pathToFileURL(path.join(root, 'src', 'main', 'hud-feed.mjs')).href);
    const rnd = await import(pathToFileURL(path.join(root, 'src', 'renderer', 'next', 'brain', 'refs.js')).href);
    const strings = [];
    (function walk(v) { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(JSON.parse(rd(root, 'scripts/fixtures/brain-board-state.json')));
    const corpus = [...strings,
      `Spec: [Spec](https://example.com/spec?a=1) and \`${W0}x\\a.md\``,
      'label `D:/data/x y/z.md` · [Doc](https://docs.example.org/p)',
      '![img](https://x.test/media/a.png) [pic](https://x.test/media/b.png) [real](https://x.test/page)',
      `\`${R0}x/a.md.bak\`\r\n[L](http://127.0.0.1:4320/)`,
      `Shot\n\`${W0}x\\shot.png\``,
      'a · b · `C:/Windows/win.ini` · [x](https://u:p@evil.example/a?x=1#f)',
      '[Doc](https://x.test/a) · [Doc](https://x.test/a) `D:/data/a.md` `D:/data/a.md`', '', null, 5];
    const diff = corpus.filter((x) => JSON.stringify(hud.extractRefs(x)) !== JSON.stringify(rnd.extractRefs(x)));
    const refCount = corpus.reduce((n, x) => n + hud.extractRefs(x).length, 0);
    ok(diff.length === 0 && refCount >= 10, `BH-18 refs.js and hud-feed.mjs extractRefs agree on ${corpus.length} texts (${refCount} refs), label and target alike`, { differing: diff.slice(0, 2), refCount });
  }
  // ---- BH-16: the artefact the host reads is written by the same resolution as __ZUMI_NEXT_UI__ ----
  const dir = path.join(SCRATCH_BASE, `brain-host-art-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
  const artefact = (flag) => {
    const out = path.join(dir, `out-${flag === undefined ? 'unset' : flag}`);
    const env = { ...process.env, ZUMI_RENDERER_OUT: out }; delete env.ZUMI_NEXT_UI; if (flag !== undefined) env.ZUMI_NEXT_UI = flag;
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-renderer.mjs')], { cwd: root, env, encoding: 'utf8' });
    let file = null; try { file = fs.readFileSync(path.join(out, 'next-ui.json'), 'utf8'); } catch { /* missing */ }
    const html = fs.existsSync(path.join(out, 'index.html')) ? fs.readFileSync(path.join(out, 'index.html'), 'utf8') : '';
    return { status: r.status, file, zumiNext: /class="dark zumi-next"/.test(html) };
  };
  fs.mkdirSync(dir, { recursive: true });
  const unset = artefact(undefined), on = artefact('1'), off = artefact('0');
  fs.rmSync(dir, { recursive: true, force: true });
  ok(on.file === '{"nextUi":true}\n' && on.zumiNext, 'BH-16a a build with ZUMI_NEXT_UI=1 writes {"nextUi":true} (and index.html carries zumi-next)', on);
  ok(off.file === '{"nextUi":false}\n' && !off.zumiNext, 'BH-16b a build with ZUMI_NEXT_UI=0 writes {"nextUi":false}', off);
  ok(off.file === '{"nextUi":false}\n' && !off.zumiNext, 'BH-16c an explicit ZUMI_NEXT_UI=0 build writes {"nextUi":false} (the old UI is still buildable)', off);
  ok(unset.file === '{"nextUi":true}\n' && unset.zumiNext, 'BH-16d a default build (NEXT_UI_DEFAULT true, no env) writes {"nextUi":true} and index.html carries zumi-next', unset);

  if (!withGit) return;
  // ---- BH-11: C12 the frozen files are byte-equal to the base; the command can see a change (control) ----
  const frozen = ['src/main/board-bridge.mjs', 'src/main/board-reader.mjs', 'src/main/board-open.mjs', 'src/main/refusal-log.mjs', 'vendor/laneboard'];
  const hasBase = git(root, 'cat-file', '-e', `${BASE_REF}^{commit}`).status === 0;
  ok(hasBase, `BH-11a the base commit ${BASE_REF} exists in this repo`, 'pass --base <ref>');
  // BH-11f: an anchor that resolves to HEAD itself (e.g. BH_OSS_REF=<this branch>) makes b/c/e compare HEAD with HEAD and pass vacuously.
  const shaOf = (ref) => git(root, 'rev-parse', '--verify', `${ref}^{commit}`).stdout.trim();
  const headSha = shaOf('HEAD');
  ok(!headSha || (shaOf(BASE_REF) !== headSha && shaOf(START_REF) !== headSha), `BH-11f the anchors (base ${BASE_REF}, start ${START_REF}) are not HEAD itself, so BH-11b/c/e compare something`, { head: headSha, base: shaOf(BASE_REF), start: shaOf(START_REF) });
  if (hasBase) {
    // T-31 alpha.3 B1 (review F1): board-bridge.mjs gained the image-upload route + onLog (plan-required, one hunk set, READ_ROUTES / PAGE_OPS /
    // RELAY_OPS / MAX_BODY untouched). It is held at ONE pinned blob instead of byte-equal to the anchor; every other frozen path stays byte-equal,
    // and the anchor does not move. Any further edit to the pinned file changes its blob and turns BH-11b red again (control BH-11g below).
    const PINNED_FROZEN = { 'src/main/board-bridge.mjs': 'a3cd366525ed1de7bad1043ad7c84d12d19e7ce9' };
    const frozenRest = frozen.filter((p) => !(p in PINNED_FROZEN));
    const committed = git(root, 'diff', '--stat', `${BASE_REF}..HEAD`, '--', ...frozenRest).stdout.trim();
    const working = git(root, 'diff', '--stat', BASE_REF, '--', ...frozenRest).stdout.trim();
    const pinnedMoved = Object.entries(PINNED_FROZEN).filter(([p, sha]) => git(root, 'hash-object', '--', p).stdout.trim() !== sha).map(([p]) => p);
    ok(committed === '' && working === '' && pinnedMoved.length === 0, `BH-11b git diff --stat ${BASE_REF}..HEAD (and the working tree) over board-reader / board-open / refusal-log / vendor/laneboard prints nothing, and board-bridge.mjs is at its pinned blob`, { committed, working, pinnedMoved });
    for (const [p, sha] of Object.entries(PINNED_FROZEN)) {
      const oneByte = spawnSync('git', ['hash-object', '--stdin'], { cwd: root, encoding: 'utf8', input: `${fs.readFileSync(path.join(root, p), 'utf8')} ` }).stdout.trim();
      ok(oneByte !== '' && oneByte !== sha, `BH-11g control: a one-byte change to the pinned ${p} no longer matches its pin`, { oneByte, sha });
    }
    const openPath = 'tauri/src-tauri/src/open_path.rs';
    if (fs.existsSync(path.join(root, openPath)) || git(root, 'cat-file', '-e', `${BASE_REF}:${openPath}`).status === 0) ok(git(root, 'diff', '--stat', BASE_REF, '--', openPath).stdout.trim() === '', 'BH-11c open_path.rs is unchanged');
    const scratch = path.join(SCRATCH_BASE, `brain-host-frozen-${process.pid}`);
    fs.mkdirSync(scratch, { recursive: true });
    const copy = path.join(scratch, 'board-open.mjs');
    fs.writeFileSync(copy, `${fs.readFileSync(path.join(root, 'src/main/board-open.mjs'), 'utf8')} `); // one byte appended
    const control = git(root, 'diff', '--no-index', '--stat', path.join(root, 'src/main/board-open.mjs'), copy).stdout.trim();
    fs.rmSync(scratch, { recursive: true, force: true });
    ok(control !== '', 'BH-11d control: the same diff command prints the file when one byte differs', control);
    // A modified check/lib file passes only while its working-tree blob equals the sha pinned here (the files that differ
    // from the P0b anchor: three as of T-31 P0c (the two oss-next + P0 merges and the P0c guard list), a fourth for alpha.3 R1, two for alpha.3 R3); any further edit turns this red again.
    const PINNED_MODIFIED = {
      'scripts/check-public-payload.mjs': '823e4ccd08f678fe798f4fbdd7cfa5ef0c2f673b',
      'scripts/check-tauri-installer-payload.mjs': 'fecb9deda7dd4b0b7fbe2f4c8d37e3f53ca8f030',
      'scripts/lib/public-p0.cjs': '87e6d766ba4bf11e106b9d6228795b47412b4055',
      // T-31 alpha.3 B1: pure additions (section 10b/10c upload cases; the Board-guest drag-drop assertions), review F1.
      'scripts/check-board-bridge.mjs': '4fabdeef6baa1db3030b6c8a2347530387a98746',
      'scripts/check-tauri-guest.mjs': 'edf8b633a322e3f09d8ca3d97ac7aa5adf48d981',
      // T-31 alpha.3 R1: three whole themes add #theme= assertions to the board-URL check (33 lines added, none removed or weakened).
      'scripts/check-tauri-board-url.mjs': 'd14aab65ebd1b7c32cdcd5dfa23971cc4479d33f',
      // T-31 alpha.3 R3 (CoS e562fd07ed76, exception to rule A: only assertions that check the fake holo content the owner asked to remove):
      // check-fh-clips +1 -1 (the PAGE_MS / pinPage-body assertion of the 6 s page clock), check-palette +0 -3 (the allowances of the deleted demo PAGES accents).
      'scripts/check-fh-clips.mjs': '6e4f224edf4feda63081f18e7bf67f15f15e6d57',
      'scripts/check-palette.mjs': 'd141d6f2ee28dcf89684fb2e9463641fa7f90ca1',
      // R4 adds links.open to the OS-open allowlist by design; CoS exception 043cfc368119.
      'scripts/check-tauri-ai-settings.mjs': 'c812bed7dfe4956574d27864c0572af37f64c218',
    };
    const changed = git(root, 'diff', '--diff-filter=M', '--name-only', START_REF, '--', 'scripts').stdout.split('\n').filter((f) => /scripts\/(check-|lib\/)/.test(f))
      .filter((f) => git(root, 'hash-object', '--', f).stdout.trim() !== PINNED_MODIFIED[f]);
    ok(git(root, 'cat-file', '-e', `${START_REF}^{commit}`).status === 0 && changed.length === 0, `BH-11e no existing check script or lib is modified since ${START_REF} except the ${Object.keys(PINNED_MODIFIED).length} pinned by blob sha (new files only)`, changed);
  }
}

// ---------------------------------------------------------------- run
if (!ONLY_STATIC) {
  await runAll();
  await runMedia();
  await runOpen();
}
if (IS_REAL || ONLY_STATIC) await runStatic(STATIC_ROOT, { git: IS_REAL });
if (!IS_REAL) {
  console.log(`child: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
console.log(`\nreal module: ${pass} passed, ${fail} failed`);
let bad = fail;

// ---------------------------------------------------------------- fault proof
if (!args.includes('--no-faults')) {
  const src = fs.readFileSync(REAL_MODULE, 'utf8');
  const dir = path.join(SCRATCH_BASE, `brain-host-faults-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const abs = (name) => pathToFileURL(path.join(ROOT, 'src', 'main', name)).href;
  let proven = 0;
  for (const f of FAULTS) {
    let mutated = src;
    for (const [from, to] of f.edits) {
      const n = mutated.split(from).length - 1;
      if (n !== 1 && !(from === to)) { console.log(`ERROR fault ${f.id}: anchor found ${n} times (need 1): ${from.slice(0, 70)}`); process.exit(2); }
      mutated = mutated.replace(from, () => to);
    }
    if (mutated === src) { console.log(`ERROR fault ${f.id}: the injected fault changed nothing`); process.exit(2); }
    // imports of siblings resolve to the real tree
    mutated = mutated.replace(/from '\.\/([\w.-]+)'/g, (_m, n) => `from '${abs(n)}'`);
    const file = path.join(dir, `board-reads.${f.id}.mjs`);
    fs.writeFileSync(file, mutated);
    const run = spawnSync(process.execPath, [SELF, '--module', file, '--no-faults'], { encoding: 'utf8' });
    const fails = run.stdout.split('\n').filter((l) => l.startsWith('FAIL '));
    const hit = fails.some((l) => l.startsWith(`FAIL ${f.expect}`));
    const good = run.status === 1 && hit;
    if (!good) bad++;
    else proven++;
    console.log(`${good ? 'PROVED' : 'NOT PROVED'} fault ${f.id}: exit ${run.status}, ${fails.length} assert(s) failed, expected ${f.expect}* ${hit ? 'among them' : 'MISSING'}`);
    for (const l of fails) console.log(`    > ${l.slice(0, 200)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`faults proved: ${proven}/${FAULTS.length}`);

  // ---- static faults: a scratch copy of the files BH-4/16/17 read, one defect each ----
  const STATIC_FAULTS = [
    { id: 'env-var-decides', expect: 'BH-4', file: 'src/main/main.js', edits: [['const NEXT_UI = (() => {', "const NEXT_UI = process.env.ZUMI_NEXT_UI === '1' || (() => {"]] },
    { id: 'handlers-unconditional', expect: 'BH-4', file: 'src/main/main.js', edits: [['if (NEXT_UI) {\n  const early', 'if (true) {\n  const early']] },
    { id: 'boardreads-unconditional', expect: 'BH-4', file: 'src/main/main.js', edits: [['if (NEXT_UI) {\n    const { createBoardReads }', 'if (true) {\n    const { createBoardReads }']] },
    { id: 'preload-keys-unconditional', expect: 'BH-4', file: 'src/main/preload.js', edits: [['...(NEXT_UI ? {', '...(true ? {']] },
    { id: 'second-path-join', expect: 'BH-4b', file: 'src/main/main.js', edits: [["path.join(RENDERER_DIR, 'next-ui.json')", "path.join(APP_ROOT, 'build', 'renderer', 'next-ui.json')"]] },
    { id: 'fail-open-flag', expect: 'BH-4b', file: 'src/main/main.js', edits: [["nextUi === true; } catch { return false; } })();\n", "nextUi === true; } catch { return true; } })();\n"]] },
    { id: 'preload-arg-always', expect: 'BH-17', file: 'src/main/main.js', edits: [["additionalArguments: NEXT_UI ? ['--zumi-next-ui=1'] : [],", "additionalArguments: ['--zumi-next-ui=1'],"]] },
    { id: 'refs-parser-drift', expect: 'BH-18', file: 'src/renderer/next/brain/refs.js', edits: [["l[2].replace(/\\\\/g, '/')", 'l[2]']] },
    { id: 'artefact-always-true', expect: 'BH-16', file: 'scripts/build-renderer.mjs', edits: [['JSON.stringify({ nextUi })', 'JSON.stringify({ nextUi: true })']] },
    { id: 'artefact-not-written', expect: 'BH-16', file: 'scripts/build-renderer.mjs', edits: [["fs.writeFileSync(path.join(out, 'next-ui.json'), ", 'void (0, ']] },
  ];
  const sdir = path.join(SCRATCH_BASE, `brain-host-static-${process.pid}`);
  const makeRoot = (id) => {
    const r = path.join(sdir, id);
    fs.mkdirSync(path.join(r, 'scripts'), { recursive: true });
    for (const f of ['build-renderer.mjs', 'rig-version.mjs', 'seat-offset.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(r, 'scripts', f));
    fs.mkdirSync(path.join(r, 'scripts', 'fixtures'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'fixtures', 'brain-board-state.json'), path.join(r, 'scripts', 'fixtures', 'brain-board-state.json'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(r, 'package.json'));
    fs.cpSync(path.join(ROOT, 'src', 'main'), path.join(r, 'src', 'main'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'src', 'renderer'), path.join(r, 'src', 'renderer'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'src', 'next-tokens'), path.join(r, 'src', 'next-tokens'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(r, 'node_modules'), 'junction');
    return r;
  };
  fs.rmSync(sdir, { recursive: true, force: true });
  let sproved = 0;
  for (const f of STATIC_FAULTS) {
    const r = makeRoot(f.id);
    const file = path.join(r, f.file);
    let s = fs.readFileSync(file, 'utf8');
    for (const [from, to] of f.edits) {
      const n = s.split(from).length - 1;
      if (n !== 1) { console.log(`ERROR static fault ${f.id}: anchor found ${n} times (need 1): ${from.slice(0, 70)}`); process.exit(2); }
      s = s.replace(from, () => to);
    }
    fs.writeFileSync(file, s);
    const run = spawnSync(process.execPath, [SELF, '--static-root', r, '--only-static'], { encoding: 'utf8' });
    const fails = run.stdout.split('\n').filter((l) => l.startsWith('FAIL '));
    const hit = fails.some((l) => l.startsWith(`FAIL ${f.expect}`));
    const good = run.status === 1 && hit;
    if (!good) bad++; else sproved++;
    console.log(`${good ? 'PROVED' : 'NOT PROVED'} static fault ${f.id}: exit ${run.status}, ${fails.length} assert(s) failed, expected ${f.expect}* ${hit ? 'among them' : 'MISSING'}`);
    for (const l of fails) console.log(`    > ${l.slice(0, 200)}`);
  }
  fs.rmSync(sdir, { recursive: true, force: true });
  console.log(`static faults proved: ${sproved}/${STATIC_FAULTS.length}`);
}
console.log(bad ? `\ncheck-brain-host: FAILED (${bad})` : '\ncheck-brain-host: all passed');
process.exit(bad ? 1 : 0);
