// T-31 Tauri parity step 9-1: the talk-camera HUD in the sidecar. Plain Node, no Electron, no window, no network:
// every upstream named here is a loopback mock on 127.0.0.1.
//
//   node scripts/check-tauri-hud.mjs
//
//   1. the wrapper (hud-host-tauri.mjs) over src/main/hud-host.mjs UNCHANGED: prefs, the real hud.ready start, the
//      owner-only answerAsk gate, the consent answer and the step-9-2 host-open seam (no fake success);
//   2. the 8a seams the HUD host calls: boardReaction -> scheduler line, boardStatus -> scheduler event, talkActive;
//   3. goldens: hud.ready's reply and the hud:feed payload SHAPE (a future renderer template can rely on it);
//   4. the real sidecar, test flavour + loopback upstream: no poll before a start, setTalkPrefs starts it, the feed
//      shows a loopback board change, an idle transition emits (the 10a lock -> hud:feed unavailable), answerAsk is
//      not_owner_build in a release flavour and one real ask.answer write in the owner flavour;
//   5. wiring proof: main.mjs passes the reader, the idle cache, the scheduler seams and hud.start() on setTalkPrefs.
//
// `--write-golden` re-records the two files under scripts/fixtures/tauri-hud/ (review them before committing).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createHudHost, createHostOpen, hudPollMs, HUD_POLL_ENV } from '../tauri/sidecar/hud-host-tauri.mjs';
import { createHostCalls } from '../tauri/sidecar/host-calls.mjs';
import { OPEN_ROOTS as JS_OPEN_ROOTS, OPEN_EXT as JS_OPEN_EXT } from '../src/main/board-open.mjs';
import { ownerPath } from './lib/owner-paths.mjs';
import { createSpeechHost } from '../tauri/sidecar/speech-host.mjs';
import { sidecarHandlerNames } from './check-tauri-coverage.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
const TARGET = path.join(ROOT, 'tauri', 'src-tauri', 'target');
const GOLDEN = path.join(ROOT, 'scripts', 'fixtures', 'tauri-hud');
const WRITE_GOLDEN = process.argv.includes('--write-golden');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stable = (v) => JSON.stringify(v);

const ISO = '2026-10-20T08:05:00.000Z';
const NEW_ISO = '2026-10-20T08:06:00.000Z';
const ASK_URL = 'https://example.com/sheet.png';

// The feed's own inputs (boardView shape): one open task with a URL ref, one answerable ask with one option.
// No local path anywhere, so the shape golden never depends on what this PC has on disk.
function boardState() {
  return {
    tasks: [
      {
        id: 'T-1', title: 'cho Orvik', status: 'doing', rev: 4, last_activity_at: ISO,
        current_step: { id: 's2', label: 'Wire camera path', state: 'active' },
        steps: [
          { id: 's1', label: 'Rig', state: 'done', detail: `Rig done\n[sheet](${ASK_URL})` },
          { id: 's2', label: 'Wire camera path', state: 'active', detail: `[sheet](${ASK_URL})` },
        ],
      },
    ],
    attention: {
      waiting: [
        { kind: 'ask', id: 'ask-1', task_id: 'T-1', text: `Pick a look\n[sheet](${ASK_URL})`, rev: 2, since: ISO, options: [{ key: 'A', label: 'Friendly', desc: 'internal' }] },
      ],
    },
  };
}

/** Primitive types only: the payload SHAPE is the contract, not the fixture's values. */
function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  if (t === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf(v[k])]));
  return t;
}

// ---------------------------------------------------------------- 0. the test-only poll hook
{
  ok(hudPollMs({ flavour: { values: { test: true } }, env: { [HUD_POLL_ENV]: '1500' } }) === 1500, 'test flavour: ZUMI_TEST_HUD_POLL_MS is honoured (Electron main.js:1934)');
  ok(hudPollMs({ flavour: { values: { test: false } }, env: { [HUD_POLL_ENV]: '1500' } }) === undefined, 'public flavour: the fast-poll override is ignored (20 s always)');
  ok(hudPollMs({ flavour: { values: { test: true } }, env: { [HUD_POLL_ENV]: '10' } }) === undefined, 'a value below 1000 ms is refused (Electron\'s own bound)');
}

// ---------------------------------------------------------------- 0b. the sidecar -> host open channel (9-2)
{
  const frames = [];
  const calls = createHostCalls((f) => frames.push(f), { timeoutMs: 1000 });
  const pending = calls.call('__sidecarHost.shell.openPath', ['C:/data/t31/a.md']);
  const req = frames[0];
  ok(req && req.jsonrpc === '2.0' && req.method === '__sidecarHost.shell.openPath' && req.params[0] === 'C:/data/t31/a.md',
    'a host call writes one JSON-RPC request with the fixed method and one string argument', stable(req));
  ok(typeof req.id === 'string' && req.id.startsWith('sc-'), 'sidecar request ids are strings, so they cannot collide with the host\'s numeric ids', req.id);
  ok(calls.settle({ jsonrpc: '2.0', id: req.id, result: { action: 'openPath' } }) === true, 'the host response settles the call');
  ok(stable(await pending) === '{"action":"openPath"}', 'the call resolves with the host result');
  ok(calls.pendingCount() === 0, 'no call is left pending');

  const errFrames = [];
  const errChannel = createHostCalls((f) => errFrames.push(f), { timeoutMs: 1000 });
  const errored = errChannel.call('__sidecarHost.shell.openPath', ['C:/data/x.mjs']);
  errChannel.settle({ jsonrpc: '2.0', id: errFrames[0].id, error: { code: -32000, message: 'type_not_allowed' } });
  ok(await errored.then(() => 'resolved', (e) => e.message) === 'type_not_allowed', 'a host error rejects the sidecar call with the host reason');

  const t = createHostCalls(() => {}, { timeoutMs: 30 });
  ok(await t.call('__sidecarHost.shell.openPath', ['C:/data/a.md']).then(() => 'resolved', (e) => e.message) === 'host_timeout',
    'a host that never answers cannot hang the renderer call (deadline)');
  ok(t.settle({ jsonrpc: '2.0', id: 'sc-1', result: {} }) === false, 'a response with no matching pending call is ignored');
  ok(t.settle({ jsonrpc: '2.0', id: 'x', method: 'hud.answer', params: [] }) === false, 'a request is never mistaken for a response');
  t.rejectAll('sidecar_shutdown');

  const openPathCalls = [];
  const openExternalCalls = [];
  const open = createHostOpen(async (method, params) => {
    if (method === '__sidecarHost.shell.openPath') openPathCalls.push(params[0]);
    if (method === '__sidecarHost.shell.openExternal') openExternalCalls.push(params[0]);
  });
  await open({ action: 'openPath', path: 'C:/data/t31/a.md', kind: 'file' });
  await open({ action: 'openExternal', url: 'http://127.0.0.1:4320/' });
  ok(stable([openPathCalls, openExternalCalls]) === stable([['C:/data/t31/a.md'], ['http://127.0.0.1:4320/']]),
    'a consent decision maps to exactly one fixed host method (openPath / openExternal)', stable([openPathCalls, openExternalCalls]));
  ok(await open({ action: 'refuse', reason: 'outside_allowed_folders' }).then(() => 'opened', (e) => e.message) === 'open_unavailable',
    'a non-open decision never asks the host to open anything');
  ok(await open({ action: 'openPath' }).then(() => 'opened', (e) => e.message) === 'open_unavailable', 'a missing path never reaches the host');

  // Wiring proof: main.mjs passes the host opener only in the owner flavour, and settles host replies before dispatch.
  const mainSrc = read('tauri', 'sidecar', 'main.mjs');
  ok(/open:\s*ownerAdmin\s*\?\s*createHostOpen\(/.test(mainSrc), 'main.mjs wires the opener only when the flavour is owner');
  ok(/if \(hostCalls\.settle\(msg\)\) return;/.test(mainSrc), 'main.mjs consumes a host response before the request dispatcher');

  // The Rust re-validation must use the SAME roots and extensions as the frozen sidecar policy. If one list
  // moves, this fails until both do (the whole point is that Rust does not trust the sidecar's decision).
  const rust = read('tauri', 'src-tauri', 'src', 'open_path.rs');
  const rustList = (name) => {
    const m = rust.match(new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\];`));
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
  };
  // The roots are owner values: board-open.mjs reads openRoots of src/main/owner-values.json and build.rs compiles the same
  // key into the host (open_path.rs owner_open_roots; its cargo test pins the compiled list to the file).
  const buildRs = read('tauri', 'src-tauri', 'build.rs');
  ok(/join\("main"\)\.join\("owner-values\.json"\)/.test(buildRs) && /doc\.get\("openRoots"\)/.test(buildRs) && /cargo:rustc-env=ZUMI_OWNER_OPEN_ROOTS=/.test(buildRs)
    && /pub fn owner_open_roots\(\) -> Vec<String> \{\s*env!\("ZUMI_OWNER_OPEN_ROOTS"\)/.test(rust) && /if owner \{\s*return owner_open_roots\(\);/.test(rust)
    && stable(JS_OPEN_ROOTS) === stable(ownerPath('openRoots', [])),
  'open_path.rs re-checks the SAME OPEN_ROOTS as board-open.mjs (both: openRoots of the owner values file)', stable({ js: JS_OPEN_ROOTS, file: ownerPath('openRoots', []) }));
  ok(stable(rustList('OPEN_EXT')) === stable([...JS_OPEN_EXT]), 'open_path.rs re-checks the SAME OPEN_EXT as board-open.mjs', stable({ rust: rustList('OPEN_EXT'), js: [...JS_OPEN_EXT] }));

  // Step 9 gate item 2 (mutant O12): a sidecar request is served with the host's OWN stored owner flag (read once from
  // the flavour file beside the exe at spawn), never with a literal. A public build therefore answers not_owner_build
  // even if the sidecar asks. The flag store itself is unit-tested in lib.rs; this pins that the request path uses it.
  const lib = read('tauri', 'src-tauri', 'src', 'lib.rs');
  const handle = lib.slice(lib.indexOf('fn handle_sidecar_request'), lib.indexOf('fn open_path_from_sidecar'));
  ok(/let owner = request_owner\(rpc\);/.test(handle), 'handle_sidecar_request takes the owner from request_owner(rpc)');
  ok(!/let owner = (true|false);/.test(handle), 'handle_sidecar_request never hard-codes the owner flag');
  const spawn = lib.slice(lib.indexOf('fn spawn_sidecar'), lib.indexOf('fn spawn_handshake_watchdog'));
  ok(/host_owner\(flavour\.as_ref\(\)\)/.test(spawn), 'spawn_sidecar stores the flavour-file answer (host_owner)');
  ok(/fn request_owner\(rpc: &Rpc\) -> bool \{\s*rpc\.0\.owner\.load\(Ordering::SeqCst\)\s*\}/.test(lib), 'request_owner reads the stored flag, and nothing else');
}

// ---------------------------------------------------------------- 1. the wrapper over the frozen modules
function unitHost({ owner = false, initial = {}, withOpen = null } = {}) {
  let st = { ...initial };
  let state = boardState();
  const sent = [];
  const opened = [];
  const relayed = [];
  const liveBoard = {
    status: () => ({ mode: 'live', configured: true, locked: false }),
    relay: async (op, body) => { relayed.push({ op, body }); return { status: 200, text: '{"ok":true}' }; },
  };
  const host = createHudHost({
    getState: async () => ({ ok: true, state }),
    idleSeconds: () => 5,
    settings: () => ({ ...st }),
    saveSettings: (patch) => { st = { ...st, ...patch }; return st; },
    emit: (channel, payload) => { sent.push({ channel, payload }); return true; },
    ownerAdmin: owner,
    liveBoard,
    now: () => Date.parse('2026-10-20T09:00:00.000Z'),
    pollMs: 3_600_000,
    ...(withOpen ? { open: async (d) => { opened.push(d); } } : {}),
    log: () => {},
  });
  return { host, sent, opened, relayed, liveBoard, state: () => state, setState: (s) => { state = s; }, st: () => st };
}
const feeds = (h) => h.sent.filter((e) => e.channel === 'hud:feed').map((e) => e.payload);

// Record the two goldens first when asked; the sections below always read them.
if (WRITE_GOLDEN) {
  fs.mkdirSync(GOLDEN, { recursive: true });
  fs.writeFileSync(path.join(GOLDEN, 'hud-ready.golden.json'), 'true\n');
  const g = unitHost({ owner: true, initial: { hudStyle: 'a' } });
  g.host.handlers['hud.ready']();
  await new Promise((r) => setTimeout(r, 50));
  fs.writeFileSync(path.join(GOLDEN, 'feed-shape.golden.json'), `${JSON.stringify(shapeOf(feeds(g)[0]), null, 2)}\n`);
  g.host.dispose();
  console.log(`goldens written under ${path.relative(ROOT, GOLDEN)}`);
}

{
  // hud.ready is now a real start: with a style on, it polls and emits one hud:feed straight away.
  const u = unitHost({ initial: { hudStyle: 'a' } });
  ok(stable(u.host.handlers['hud.getPrefs']()) === '{"style":"a"}', 'hud.getPrefs answers the stored style');
  ok(u.host.handlers['hud.ready']() === true, 'hud.ready answers true');
  await new Promise((r) => setTimeout(r, 50));
  const first = feeds(u);
  ok(first.length === 1 && first[0].style === 'a' && first[0].reaction === null && first[0].feed && first[0].feed.updates.length === 1,
    'hud.ready starts the real host: one hud:feed with the baseline board (no reaction on the first read)', stable(first.map((f) => f.style)));
  ok(stable(first[0].answer) === '{"owner":false,"live":true}', 'the feed carries the renderer answer state (owner flag + live/unlocked)', stable(first[0].answer));
  u.host.dispose();

  // Style Off + talk level Off: hud.ready starts nothing, so nothing is read and nothing is sent.
  const off = unitHost({});
  ok(off.host.handlers['hud.ready']() === true, 'hud.ready answers true with everything off');
  await new Promise((r) => setTimeout(r, 50));
  ok(feeds(off).length === 0, 'hud.ready with HUD off and talk off starts no poll, sends no hud:feed');
  ok(stable(off.host.handlers['hud.setPrefs']({ style: 'nope' })) === '{"style":"off"}', 'hud.setPrefs refuses an unknown style (keeps Off)');
  ok(stable(off.host.handlers['hud.setPrefs']({ style: 'b' })) === '{"style":"b"}', 'hud.setPrefs stores a valid style');
  await new Promise((r) => setTimeout(r, 50));
  // Electron repaints Off when an unknown style arrives while Off, then the real style's feed: the LAST one is b.
  const offFeeds = feeds(off);
  ok(offFeeds.length >= 1 && offFeeds[offFeeds.length - 1].style === 'b', 'switching the HUD on repaints a feed in the new style', offFeeds.map((f) => f.style));
  off.host.dispose();

  // Goldens: hud.ready's reply and the hud:feed payload shape.
  const g = unitHost({ owner: true, initial: { hudStyle: 'a' } });
  g.host.handlers['hud.ready']();
  await new Promise((r) => setTimeout(r, 50));
  const feedPayload = feeds(g)[0];
  const readyGolden = JSON.parse(read('scripts', 'fixtures', 'tauri-hud', 'hud-ready.golden.json'));
  const feedGolden = JSON.parse(read('scripts', 'fixtures', 'tauri-hud', 'feed-shape.golden.json'));
  ok(readyGolden === true, 'golden: hud.ready answers true');
  ok(stable(shapeOf(feedPayload)) === stable(feedGolden), 'golden: the hud:feed payload shape is Electron\'s {style, feed{updates,waiting,waitingCount}, reaction, answer}', stable(shapeOf(feedPayload)));
  const f0 = feedPayload && feedPayload.feed;
  ok(f0 && f0.waitingCount === 1 && f0.waiting[0].id === 'ask-1' && f0.waiting[0].rev === 2 && f0.waiting[0].options.length === 1 && !('desc' in f0.waiting[0].options[0]),
    'the feed carries the ask id/revision and key+label options only', stable(f0 && f0.waiting));
  g.host.dispose();

  // hud.answer: an unknown or used id opens nothing, with Electron's reason.
  const a = unitHost({});
  ok(stable(await a.host.handlers['hud.answer']('c1-nope', true)) === '{"opened":false,"reason":"unknown_or_used"}', 'hud.answer refuses an unknown offer id');
  a.host.dispose();

  // The open seam with no host opener (a release build, or an injected host that has none): a "yes" must NOT
  // report a success it did not perform.
  const closed = unitHost({ owner: true, initial: { hudStyle: 'a' } });
  closed.host.handlers['hud.ready']();
  await new Promise((r) => setTimeout(r, 50));
  closed.setState({ ...boardState(), tasks: [{ ...boardState().tasks[0], rev: 5, last_activity_at: NEW_ISO }] });
  await closed.host.poll();
  const offer = feeds(closed).map((f) => f.reaction && f.reaction.consent).filter(Boolean).pop();
  ok(Boolean(offer) && typeof offer.id === 'string' && offer.kind === 'url' && offer.target === 'example.com',
    'a changed card with an openable link carries a consent offer (host name only, never the full target)', stable(offer));
  if (offer) {
    ok(stable(await closed.host.handlers['hud.answer'](offer.id, true)) === '{"opened":false,"reason":"open_unavailable"}',
      'hud.answer without a host opener fails closed: opened:false, never a fake success');
  }
  closed.host.dispose();

  // ... and the seam itself works: an injected opener (what 9-2 supplies) gets the re-validated decision.
  const openable = unitHost({ owner: true, initial: { hudStyle: 'a' }, withOpen: true });
  openable.host.handlers['hud.ready']();
  await new Promise((r) => setTimeout(r, 50));
  openable.setState({ ...boardState(), tasks: [{ ...boardState().tasks[0], rev: 5, last_activity_at: NEW_ISO }] });
  await openable.host.poll();
  const offer2 = feeds(openable).map((f) => f.reaction && f.reaction.consent).filter(Boolean).pop();
  if (offer2) {
    const r = await openable.host.handlers['hud.answer'](offer2.id, true);
    ok(r.opened === true && r.reason === null && openable.opened.length === 1 && openable.opened[0].action === 'openExternal' && openable.opened[0].url === ASK_URL,
      'hud.answer hands the allowlist decision to the injected opener (the step-9-2 seam)', stable({ r, opened: openable.opened }));
  } else {
    ok(false, 'hud.answer hands the allowlist decision to the injected opener (the step-9-2 seam)', 'no offer');
  }
  openable.host.dispose();

  // answerAsk: ONLY the owner flavour has the write surface; a release build refuses before any relay.
  const nonOwner = unitHost({ owner: false });
  const refused = await nonOwner.host.handlers['hud.answerAsk']({ id: 'ask-1', rev: 2, verdict: 'approve' });
  ok(stable(refused) === '{"ok":false,"reason":"not_owner_build"}' && nonOwner.relayed.length === 0,
    'hud.answerAsk in a release flavour: not_owner_build, no relay, no write', stable(refused));
  nonOwner.host.dispose();

  const owner = unitHost({ owner: true });
  const wrote = await owner.host.handlers['hud.answerAsk']({ id: 'ask-1', rev: 2, verdict: 'approve' });
  ok(stable(wrote) === '{"ok":true}' && owner.relayed.length === 1 && owner.relayed[0].op === 'ask.answer',
    'hud.answerAsk in the owner flavour relays exactly ask.answer', stable({ wrote, relayed: owner.relayed }));
  ok(stable(owner.relayed[0].body) === stable({ target_id: 'ask-1', expected_revision: 2, data: { verdict: 'approve' } }),
    'the relay body is the frozen module\'s {target_id, expected_revision, data}', stable(owner.relayed[0].body));
  const twice = await owner.host.handlers['hud.answerAsk']({ id: 'ask-1', rev: 2, verdict: 'approve' });
  ok(twice.ok === false && twice.reason === 'already_answered' && owner.relayed.length === 1, 'a second identical answer is already_answered, never a second write', stable(twice));
  owner.host.dispose();

  // A locked board refuses before the relay (the frozen module's own gate).
  const locked = unitHost({ owner: true });
  locked.liveBoard.status = () => ({ mode: 'local', configured: true, locked: false });
  const lockedOut = await locked.host.handlers['hud.answerAsk']({ id: 'ask-1', rev: 2, verdict: 'approve' });
  ok(stable(lockedOut) === '{"ok":false,"reason":"locked"}' && locked.relayed.length === 0, 'answerAsk refuses while the board is not live (locked), no relay', stable(lockedOut));
  locked.host.dispose();
}

// ---------------------------------------------------------------- 2. the 8a seams
function speechHost(initial = {}) {
  let st = { talkLevel: 'normal', talkQuietHours: { on: false, start: '22:30', end: '07:30' }, ...initial };
  const events = [];
  const clock = { t: Date.parse('2026-10-20T09:00:00.000Z') };
  const host = createSpeechHost({
    settings: () => ({ ...st }),
    saveSettings: (patch) => { st = { ...st, ...patch }; return st; },
    signals: { idleSeconds: () => 5, windowVisible: () => true },
    emit: (channel, payload) => { events.push({ channel, payload }); return true; },
    version: '9.9.9',
    now: () => clock.t,
    intervalMs: 60_000,
    log: () => {},
  });
  return { host, events, set: (patch) => { st = { ...st, ...patch }; } };
}
{
  const s = speechHost();
  s.host.boardReaction({ source: 'waiting', askKey: 'ask:ask-1', title: 'cho Orvik', step: '' });
  await new Promise((r) => setTimeout(r, 0)); // the pre-ready ack is a microtask (busy -> the ask is re-held)
  const st = s.host.scheduler.status();
  ok(st.held === 1 && st.heldKeys.includes('ask:ask-1'), 'boardReaction maps a HUD ask to one scheduler ask (held until the renderer listens)', stable(st));
  s.host.dispose();

  const ev = speechHost();
  ok(ev.host.handlers['talk.sayReady']() === true, 'setup: sayReady so a line reaches the channel');
  ev.host.boardStatus(false);
  const line = ev.events.find((e) => e.channel === 'speech:say');
  ok(Boolean(line) && line.payload.kind === 'event' && /board/i.test(line.payload.text), 'boardStatus(false) enqueues the scheduler\'s board-lost event line', stable(line && line.payload));
  ev.host.dispose();

  const ta = speechHost({ talkLevel: 'off' });
  ok(ta.host.talkActive() === false, 'talkActive is false at level off');
  ta.set({ talkLevel: 'normal' });
  ok(ta.host.talkActive() === true, 'talkActive is true at level normal (the HUD polls with the HUD hidden)');
  ta.host.dispose();
}

// ---------------------------------------------------------------- sidecar helpers
function findHelper() {
  if (process.env.ZUMI_VAULT_EXE) return path.resolve(process.env.ZUMI_VAULT_EXE);
  const found = ['release', 'debug'].map((p) => path.join(TARGET, p, 'zumi-vault.exe')).filter((p) => fs.existsSync(p));
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0] || null;
}
const HELPER = findHelper();
const HAVE_VAULT = Boolean(HELPER) && process.platform === 'win32';
if (!HAVE_VAULT) {
  console.log('FAIL the vault helper is not built. Run: cargo build --manifest-path tauri/src-tauri/Cargo.toml --bins');
  process.exit(1);
}

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP_ROOT, 'hud-'));
const freshDir = (name, initial = {}) => {
  const d = path.join(work, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(initial));
  return d;
};
function flavourHost(name, ownerAdmin) {
  const host = path.join(work, name);
  fs.mkdirSync(host, { recursive: true });
  fs.writeFileSync(path.join(host, 'flavour.json'), `${JSON.stringify({ v: 1, cloudBase: null, test: true, reflexEgress: false, ownerAdmin, boardMirror: null }, null, 2)}\n`);
  const exe = path.join(host, 'zumi-vault.exe');
  fs.copyFileSync(HELPER, exe);
  return ['--vault-exe', exe, '--host-dir', host, '--flavour', path.join(host, 'flavour.json')];
}

// A FIXED local noon (never today): the HUD and scheduler decisions must not read the machine's wall clock. Built
// from local fields, so it stays local noon under any TZ the proof run sets.
const FIXED_NOW = new Date(2025, 0, 15, 12, 0, 0).getTime();

function startSidecar(dataDir, extraEnv = {}, extraArgs = []) {
  const args = [SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch', '--now-ms', String(FIXED_NOW), ...extraArgs];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const events = [];
  const replies = [];
  let stderr = '';
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.once('exit', (code) => { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`sidecar exited (${code})`)); } pending.clear(); });
  rl.on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve();
    else if (m.method === 'event') events.push(m.params);
    else if (m.id != null && pending.has(m.id)) { replies.push(m); const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
  });
  return {
    child, events, replies, stderrText: () => stderr, ready,
    request(method, params = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() { child.stdin.end(); return new Promise((r) => child.on('close', r)); },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await wait(100); }
  return false;
}

/** LISTENING addresses of one pid, from netstat (Windows: Proto/Address/Foreign/State/PID). */
function listenersFor(pid) {
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 5 && p[3] === 'LISTENING' && p[4] === String(pid))
    .map((p) => p[1]);
}
async function waitForListeners(pid) {
  const end = Date.now() + 5000;
  let addrs = [];
  while (Date.now() < end) { addrs = listenersFor(pid); if (addrs.length) return addrs; await wait(100); }
  return addrs;
}

const S = {
  user: `user-${crypto.randomBytes(9).toString('hex')}`,
  pass: `pass-${crypto.randomBytes(9).toString('hex')}`,
  token: `tok-${crypto.randomBytes(9).toString('hex')}`,
  pin: String(crypto.randomInt(100000, 999999)),
};
const SENTINELS = [S.user, S.pass, S.token, S.pin];

/** A loopback stand-in for the live board behind nginx: Basic on every path, CSRF + the RAW owner token on writes.
 *  `state` is mutable so a test can change the board between polls; write bodies are recorded parsed. */
function startBoardMock() {
  const expectedBasic = `Basic ${Buffer.from(`${S.user}:${S.pass}`, 'utf8').toString('base64')}`;
  const mock = { state: boardState(), requests: [], writes: [] };
  const srv = http.createServer((req, res) => {
    const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
    if (!String(req.url).startsWith('/zumia/')) return send(404, { error: 'not_found' });
    if (req.headers.authorization !== expectedBasic) return send(401, { error: 'bad_basic' });
    if (req.method === 'POST') {
      if (req.headers['x-requested-with'] !== 'laneboard') return send(403, { error: 'missing_csrf' });
      if (req.headers['x-laneboard-token'] !== S.token) return send(401, { error: 'missing_token' });
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* not json */ }
        mock.requests.push({ method: 'POST', url: req.url });
        mock.writes.push(parsed);
        send(200, { ok: true });
      });
    }
    mock.requests.push({ method: req.method, url: req.url });
    if (req.url === '/zumia/api/v1/state') return send(200, mock.state);
    return send(200, {});
  });
  return new Promise((resolve) => { srv.listen(0, '127.0.0.1', () => { mock.srv = srv; mock.port = srv.address().port; resolve(mock); }); });
}
const stateReads = (mock) => mock.requests.filter((r) => r.url === '/zumia/api/v1/state').length;

// ---------------------------------------------------------------- 3. release flavour: no owner write surface
{
  const mock = await startBoardMock();
  const c = startSidecar(
    freshDir('release', { voiceEnabled: false, talkLevel: 'normal' }),
    { [HUD_POLL_ENV]: '1000', ZUMI_BOARD_UPSTREAM: `http://127.0.0.1:${mock.port}/zumia` },
    flavourHost('host-release', false),
  );
  try {
    await c.ready;
    // Nothing polls before a start: hud.getPrefs is a read of settings, not a board read.
    ok(stable((await c.request('hud.getPrefs')).result) === '{"style":"off"}', 'hud.getPrefs answers Off on a fresh install');
    await wait(1200);
    ok(stateReads(mock) === 0, 'no board poll before hud.ready / a talk level (the host is created, not started)', `${stateReads(mock)} read(s)`);
    ok((await c.request('board.setSecrets', [S])).result.ok === true, 'release setup: secrets configured under the PIN');
    ok((await c.request('board.setMode', ['live'])).result.ok === true, 'release setup: live mode (the loopback mock)');
    ok(stateReads(mock) === 0, 'configuring the board does not start the HUD poll either', `${stateReads(mock)} read(s)`);

    // setTalkPrefs -> hudHost.start() (main.js:1252): the poll runs with the HUD hidden, and sends no hud:feed.
    ok((await c.request('talk.setTalkPrefs', [{ talkLevel: 'normal' }])).result.talkLevel === 'normal', 'talk.setTalkPrefs answers the new level');
    ok(await waitFor(() => stateReads(mock) > 0, 5000), 'a talk level switched on starts the HUD poll (setTalkPrefs -> hud.start())');
    ok(c.events.filter((e) => e.channel === 'hud:feed').length === 0, 'HUD style Off: the poll runs but no hud:feed is sent');

    // hud.ready: a real start, and its reply is the recorded golden.
    ok((await c.request('hud.ready')).result === JSON.parse(read('scripts', 'fixtures', 'tauri-hud', 'hud-ready.golden.json')), 'hud.ready answers the golden reply (true)');

    // HUD on: one feed per read, in Electron's shape.
    ok(stable((await c.request('hud.setPrefs', [{ style: 'a' }])).result) === '{"style":"a"}', 'hud.setPrefs stores style a');
    ok(await waitFor(() => c.events.some((e) => e.channel === 'hud:feed'), 5000), 'switching the HUD on emits hud:feed');
    const baseline = c.events.filter((e) => e.channel === 'hud:feed').map((e) => e.payload).pop();
    ok(baseline && baseline.style === 'a' && baseline.feed && baseline.feed.updates[0].id === 'T-1' && baseline.answer.owner === false && baseline.answer.live === true,
      'the feed shows the loopback board (task T-1), with the release build\'s answer state', stable(baseline && { style: baseline.style, answer: baseline.answer }));
    ok(stable(shapeOf(baseline)) === stable(JSON.parse(read('scripts', 'fixtures', 'tauri-hud', 'feed-shape.golden.json'))), 'the live hud:feed payload matches the shape golden');

    // A board change upstream -> a new feed with a reaction (test flavour + loopback only).
    mock.state = { ...boardState(), tasks: [{ ...boardState().tasks[0], rev: 5, last_activity_at: NEW_ISO }] };
    ok(await waitFor(() => c.events.some((e) => e.channel === 'hud:feed' && e.payload.reaction && e.payload.reaction.primary === 'T-1'), 6000),
      'a board change on the loopback upstream reaches hud:feed as a reaction');
    const changed = c.events.filter((e) => e.channel === 'hud:feed' && e.payload.reaction).map((e) => e.payload).pop();
    ok(changed.feed.updates[0].at === NEW_ISO, 'the feed carries the new board activity time (the change, not a cached copy)', changed.feed.updates[0].at);

    // An idle transition emits: the board idle lock is 15 min (like Electron) of cached __host.idle, and the HUD's next read reports it.
    const beforeIdle = c.events.length;
    ok((await c.request('__host.idle', [15 * 60])).result === true, '__host.idle is accepted (the step-6-pre cache)');
    ok(await waitFor(() => c.events.slice(beforeIdle).some((e) => e.channel === 'hud:feed' && e.payload.unavailable === 'locked' && e.payload.feed === null), 6000),
      'an idle transition emits: the locked board arrives as hud:feed {feed:null, unavailable:locked}');
    await c.request('__host.idle', [0]);

    // The write surface does not exist in a release flavour: not_owner_build, before any relay or upstream write.
    const writesBefore = mock.writes.length;
    ok(stable((await c.request('hud.answerAsk', [{ id: 'ask-1', rev: 2, verdict: 'approve' }])).result) === '{"ok":false,"reason":"not_owner_build"}',
      'hud.answerAsk in a release flavour: not_owner_build');
    ok(mock.writes.length === writesBefore, 'the refused answerAsk sent no upstream write');
    ok(stable((await c.request('hud.answer', ['c1-nope', true])).result) === '{"opened":false,"reason":"unknown_or_used"}', 'hud.answer refuses an unknown offer id');

    const seen = [...c.replies.map((r) => stable(r)), ...c.events.map((e) => stable(e)), c.stderrText()].join('\n');
    const leaked = SENTINELS.filter((s) => seen.includes(s));
    ok(leaked.length === 0, 'no board secret appears in any rpc reply, event payload or stderr line', `${leaked.length} sentinel(s)`);
  } finally {
    await c.close();
    await new Promise((r) => mock.srv.close(r));
  }
}

// ---------------------------------------------------------------- 4. owner flavour: the real ask.answer write
{
  const mock = await startBoardMock();
  const c = startSidecar(
    freshDir('owner', { voiceEnabled: false, talkLevel: 'normal' }),
    { [HUD_POLL_ENV]: '1000', ZUMI_BOARD_UPSTREAM: `http://127.0.0.1:${mock.port}/zumia` },
    flavourHost('host-owner', true),
  );
  try {
    await c.ready;
    ok((await c.request('board.setSecrets', [S])).result.ok === true, 'owner setup: secrets configured under the PIN');
    ok((await c.request('board.setMode', ['live'])).result.ok === true, 'owner setup: live mode');
    const addrs = await waitForListeners(c.child.pid);
    ok(addrs.length > 0 && addrs.every((a) => a.startsWith('127.0.0.1:')), 'the live bridge listens on 127.0.0.1 only', addrs.join(','));
    ok((await c.request('hud.ready')).result === true, 'owner setup: hud.ready');
    ok((await c.request('hud.setPrefs', [{ style: 'b' }])).result.style === 'b', 'owner setup: HUD style b');
    ok(await waitFor(() => c.events.some((e) => e.channel === 'hud:feed' && e.payload.feed && e.payload.feed.waiting.length === 1), 6000),
      'the owner feed carries the loopback ask (id + revision + options)');
    const feed = c.events.filter((e) => e.channel === 'hud:feed' && e.payload.feed).map((e) => e.payload).pop();
    ok(feed.answer.owner === true && feed.answer.live === true, 'the owner feed reports answer controls live (owner + live + unlocked)', stable(feed.answer));
    ok(feed.feed.waiting[0].id === 'ask-1' && feed.feed.waiting[0].rev === 2 && feed.feed.waiting[0].options[0].key === 'A', 'the ask card carries what a write must name', stable(feed.feed.waiting[0]));

    // One real answer through the sidecar's own live board relay: only the loopback mock ever sees it.
    ok(stable((await c.request('hud.answerAsk', [{ id: 'ask-1', rev: 2, verdict: 'approve' }])).result) === '{"ok":true}', 'hud.answerAsk writes the owner answer (ok)');
    ok(mock.writes.length === 1, 'exactly one upstream write', `${mock.writes.length}`);
    const w = mock.writes[0] || {};
    ok(w.op === 'ask.answer' && w.target_id === 'ask-1' && w.expected_revision === 2 && w.data && w.data.verdict === 'approve' && typeof w.request_id === 'string',
      'the upstream write is the frozen module\'s ask.answer body (op, target_id, expected_revision, data)', stable(w));
    ok(stable((await c.request('hud.answerAsk', [{ id: 'ask-1', rev: 2, verdict: 'approve' }])).result) === '{"ok":false,"reason":"already_answered"}',
      'a second identical answer is already_answered');
    ok(mock.writes.length === 1, 'the double answer never reached the upstream');

    // Not live -> the frozen module refuses before the relay (no write).
    ok((await c.request('board.setMode', ['local'])).result.ok === true, 'owner: back to local mode');
    ok(stable((await c.request('hud.answerAsk', [{ id: 'ask-1', rev: 3, choice: 'A' }])).result) === '{"ok":false,"reason":"locked"}', 'answerAsk is refused while not live (locked)');
    ok(mock.writes.length === 1, 'the locked answer sent no upstream write');

    const seen = [...c.replies.map((r) => stable(r)), ...c.events.map((e) => stable(e)), c.stderrText()].join('\n');
    const leaked = SENTINELS.filter((s) => seen.includes(s));
    ok(leaked.length === 0, 'owner: no board secret appears in any rpc reply, event payload or stderr line', `${leaked.length} sentinel(s)`);
  } finally {
    await c.close();
    await new Promise((r) => mock.srv.close(r));
  }
}

// ---------------------------------------------------------------- 5. wiring proof (only main.mjs can own these)
{
  const main = read('tauri', 'sidecar', 'main.mjs');
  const mod = read('tauri', 'sidecar', 'hud-host-tauri.mjs');
  const names = new Set(sidecarHandlerNames(main));
  const step9 = ['hud.getPrefs', 'hud.setPrefs', 'hud.ready', 'hud.answer', 'hud.answerAsk'];
  ok(step9.every((n) => names.has(n)), 'all 5 hud rpc names are in the sidecar handler table', step9.filter((n) => !names.has(n)).join(','));
  ok(/getState: \(o\) => chatHost\.boardReader\.getState\(o\)/.test(main), 'main.mjs reads the board through the SAME reader chat owns');
  ok(/idleSeconds: \(\) => signals\.idleSeconds\(\)/.test(main), 'main.mjs feeds the HUD the cached __host.idle');
  ok(/onReaction: \(r\) => speech\.boardReaction\(r\)/.test(main) && /onWaiting: \(n\) => speech\.setWaitingCount\(n\)/.test(main) && /onBoardStatus: \(ok\) => speech\.boardStatus\(ok\)/.test(main),
    'main.mjs maps onReaction / onWaiting / onBoardStatus onto the 8a scheduler');
  ok(/const next = speech\.handlers\['talk\.setTalkPrefs'\]\(p\); if \(next\) hud\.start\(\)/.test(main), 'setTalkPrefs -> hudHost.start() is wired (main.js:1252)');
  ok(/import \{ createHudHost as createElectronHudHost \} from '\.\.\/\.\.\/src\/main\/hud-host\.mjs'/.test(mod) && /decideOpenRef/.test(mod) && /createAskAnswerer/.test(mod),
    'the sidecar imports the frozen hud-host / board-open / hud-answer modules (no copy)');
  ok(!/\bfetch\s*\(/.test(mod) && !/https?:\/\//.test(mod.replace(/^\s*\/\/.*$/gm, '')), 'the HUD module makes no egress of its own');
}

fs.rmSync(work, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
