// T-31 P1a sidecar check. Plain Node, no Electron, no window, no network.
//
// Starts tauri/sidecar/main.mjs as a child process and speaks JSON-RPC over stdio, verifying:
//   - the versioned `ready` handshake arrives before any response;
//   - every implemented method round-trips (settings get/set for a few keys, app version, roles.get);
//   - an unimplemented method is rejected with `not_implemented:<name>` (never a faked success);
//   - settings persistence lands in the --data-dir it was given (preview isolation), not anywhere else;
//   - stdout carries only JSON-RPC frames; and the sidecar source imports no Electron.
//
//   node scripts/check-tauri-sidecar.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../tauri/sidecar/main.mjs';
import { createHostSignals } from '../tauri/sidecar/host-signals.mjs';
import { MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES, serializeResponse } from '../tauri/sidecar/protocol.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

// Keep the scratch dir off C: (the repo rule) and out of the tree (gitignored).
const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(TMP_ROOT, 'p1a-sidecar-'));

function startSidecar(args, env) {
  // --no-voice-prefetch: a protocol check must never start the step-8b Kokoro download (Electron's --settings-shots analogue).
  const child = spawn(process.execPath, [SIDECAR, ...args, '--no-voice-prefetch'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const notifications = [];
  const raw = [];
  let stderr = '';
  let nextId = 1;
  rl.on('line', (line) => {
    raw.push(line);
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      clearTimeout(pending.get(msg.id).timer);
      const resolve = pending.get(msg.id).resolve;
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg.method) {
      notifications.push(msg);
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return {
    child,
    notifications,
    raw,
    stderrText: () => stderr,
    request(method, params = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        // 30 s, not 5: under a loaded machine (several build workers) a child-process spawn or a large settings write
        // can stall well past 5 s. Electron's own host timeout for the slow methods is 45 s (talk.turn); a hung
        // request still fails visibly, just later. Reported as a load flake on the base tree too.
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 30000);
        pending.set(id, { resolve, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    endStdin() { try { child.stdin.end(); } catch { /* ignore */ } },
    close() { try { child.stdin.end(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } },
  };
}

const waitFor = (fn, ms = 30000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const v = fn();
    if (v) return resolve(v);
    if (Date.now() - t0 > ms) return reject(new Error('waitFor timed out'));
    setTimeout(tick, 20);
  };
  tick();
});

(async () => {
  // ---- refuses to start without a data dir (never guesses a path that could be Electron's) ----
  {
    const c = startSidecar([]);
    const code = await new Promise((r) => c.child.on('exit', r));
    ok(code === 2, 'sidecar exits 2 when --data-dir is missing (never guesses a writable path)', `exit=${code}`);
  }

  const c = startSidecar(['--data-dir', dataDir]);
  const ready = await waitFor(() => c.notifications.find((n) => n.method === 'ready'));
  ok(ready && ready.params && ready.params.protocol === 1, 'ready handshake reports protocol 1', JSON.stringify(ready && ready.params));
  ok(ready && typeof ready.params.version === 'string' && ready.params.version.length > 0, 'ready handshake carries a version');

  // ---- dispatch awaits async handlers (a returned Promise must not serialize as {}) ----
  {
    const handlers = {
      resolves: async (a, b) => ({ sum: a + b }),
      throws: async () => { throw new Error('boom'); },
      sync: (n) => n * 2,
    };
    const r1 = await dispatch({ jsonrpc: '2.0', id: 11, method: 'resolves', params: [2, 3] }, handlers);
    ok(r1 && r1.id === 11 && r1.result && r1.result.sum === 5, 'an async handler resolves through dispatch (awaited, not {})', JSON.stringify(r1));
    const r2 = await dispatch({ jsonrpc: '2.0', id: 12, method: 'throws' }, handlers);
    ok(r2 && r2.error && r2.error.code === -32603 && r2.error.message === 'boom', 'an async throw maps to ERR_INTERNAL with the thrown message', JSON.stringify(r2));
    const r3 = await dispatch({ jsonrpc: '2.0', id: 13, method: 'sync', params: [4] }, handlers);
    ok(r3 && r3.result === 8, 'a sync handler still round-trips through the async dispatch');
    const r4 = await dispatch({ jsonrpc: '2.0', id: 14, method: 'nope' }, handlers);
    ok(r4 && r4.error && r4.error.code === -32601 && r4.error.message === 'not_implemented:nope', 'an unknown method still rejects not_implemented:<name>');
    const r5 = await dispatch({ jsonrpc: '1.0', id: 15, method: 'sync' }, handlers);
    ok(r5 && r5.error && r5.error.code === -32600, 'an invalid request still rejects -32600');
    const r6 = await dispatch({ jsonrpc: '2.0', method: 'sync', params: [1] }, handlers);
    ok(r6 === null, 'a notification (no id) gets no response');
  }

  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;  const info = (await c.request('info')).result;
  ok(info && info.version === pkgVersion, 'info reports the app version', JSON.stringify(info && info.version));
  ok(info && info.packaged === true, 'info marks the preview as packaged');
  // P1c4: minWindow is Electron's MIN_WINDOW (main.js:625); the update.* answers are Electron's feed-less ones (main.js:1022-1025).
  ok(info && info.minWindow && info.minWindow.width === 900 && info.minWindow.height === 600 && Object.keys(info.minWindow).length === 2, 'info.minWindow is { width: 900, height: 600 } (Electron MIN_WINDOW)', JSON.stringify(info && info.minWindow));
  const updStatus = (await c.request('update.status')).result;
  ok(updStatus && updStatus.phase === 'off' && Object.keys(updStatus).length === 1, "update.status answers { phase: 'off' } (no updater)", JSON.stringify(updStatus));
  ok((await c.request('update.install')).result === false, 'update.install answers false (no updater)');
  ok((await c.request('update.later', ['9.9.9'])).result === false, "update.later('9.9.9') answers false (no updater)");
  ok((await c.request('update.later')).result === false, 'update.later() answers false');
  ok((await c.request('update.check')).result?.result === 'off', "update.check answers { result: 'off' } (no updater)");


  ok((await c.request('ui.getLang')).result === 'en', 'ui.getLang defaults to "en"');
  ok((await c.request('ui.setLang', ['vi'])).result === 'vi', 'ui.setLang stores "vi"');
  ok((await c.request('ui.getLang')).result === 'vi', 'ui.getLang reads back "vi" (persisted)');
  ok((await c.request('ui.setLang', ['klingon'])).result === 'en', 'ui.setLang falls back to "en" for an unknown language');

  ok((await c.request('ui.getDevTools')).result === false, 'ui.getDevTools defaults to false');
  ok((await c.request('ui.setDevTools', [true])).result === true, 'ui.setDevTools stores true');
  ok((await c.request('ui.getDevTools')).result === true, 'ui.getDevTools reads back true');

  const roles = (await c.request('roles.get')).result;
  ok(roles && roles.provider === null, 'roles.get returns { provider: null } with no provider wired', JSON.stringify(roles));

  // A name still behind its own step stays an honest not_implemented: the sidecar never fakes a success.
  // talk.ttsAbandon arrived with 8b part 2; board.unlock with 10a-1; the 21 test-only names
  // arrived with 12-1 (they are registered then, and answer not_available outside their CLI mode). board.liveOpen is 10b.
  const abandon = await c.request('talk.ttsAbandon', [{ turnId: 'none' }]);
  ok(abandon.result === true, 'talk.ttsAbandon is answered (8b part 2), not a faked unimplemented', JSON.stringify(abandon));

  const gated = (await c.request('selftest.capture')).result;
  ok(gated && gated.error === 'not_available', 'a 12-1 test-only name is registered and refuses in a normal start (not_available)', JSON.stringify(gated));

  const newUnimpl = await c.request('board.noSuchMethod');
  ok(newUnimpl.error && newUnimpl.error.code === -32601, 'unimplemented method returns error code -32601', JSON.stringify(newUnimpl.error));
  ok(newUnimpl.error && newUnimpl.error.message === 'not_implemented:board.noSuchMethod',
    'an unknown method still rejects not_implemented:<name>', JSON.stringify(newUnimpl.error));

  // A method named after an Object.prototype member must NOT resolve to the inherited function.
  for (const proto of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
    const r = await c.request(proto);
    ok(r.error && r.error.message === `not_implemented:${proto}`, `"${proto}" is rejected, not dispatched to a prototype method`, JSON.stringify(r));
  }

  // ---- persistence is inside the given data dir (preview isolation) ----
  const settingsFile = path.join(dataDir, 'settings.json');
  ok(fs.existsSync(settingsFile), 'settings.json is written into the --data-dir');
  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  ok(saved.uiLang === 'en' && saved.developerMode === true, 'persisted keys are uiLang + developerMode', JSON.stringify(saved));

  // ---- stdout only carries JSON-RPC frames ----
  const badLines = c.raw.filter((l) => l.trim() && l.trim()[0] !== '{');
  ok(badLines.length === 0, 'stdout carries only JSON-RPC frames (logs go to stderr)', badLines.join(' | '));

  // ---- the sidecar loads no Electron (including the modules the adapters and the 8a scheduler import) ----
  const sources = [
    path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'),
    path.join(ROOT, 'tauri', 'sidecar', 'adapters.mjs'),
    path.join(ROOT, 'tauri', 'sidecar', 'protocol.mjs'),
    path.join(ROOT, 'tauri', 'sidecar', 'boot-reads.mjs'),
    path.join(ROOT, 'tauri', 'sidecar', 'speech-host.mjs'),
    path.join(ROOT, 'src', 'main', 'providers.js'),
    path.join(ROOT, 'src', 'main', 'models-core.js'),
    // step 8a imports speech-scheduler.mjs, which imports these three: keep the whole chain in the scan.
    path.join(ROOT, 'src', 'main', 'speech-scheduler.mjs'),
    path.join(ROOT, 'src', 'main', 'speech-lines.mjs'),
    path.join(ROOT, 'src', 'main', 'quick-speech.js'),
    path.join(ROOT, 'src', 'main', 'local-tts.js'),
  ].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  ok(!/require\(\s*['"]electron['"]|from\s+['"]electron['"]/.test(sources), 'no sidecar module (or its imported adapter module) imports Electron');

  // ---- gcache.save above 1 MB (6-pre, F4): Electron accepts up to 2.5 MB; the 1 MB frame cap made it a fatal frame ----
  {
    const big = JSON.stringify({ v: 1, pad: 'g'.repeat(2_400_000) }); // 2.4 MB: under Electron's 2.5 MB, over the old 1 MB frame
    const saved = (await c.request('gcache.save', [big])).result;
    ok(saved === true, 'gcache.save of a 2.4 MB cache answers true (not a fatal frame)', String(saved));
    const back = (await c.request('gcache.load')).result;
    ok(back === big, 'gcache.load returns the 2.4 MB cache byte for byte', String(back && back.length));
    ok(!c.notifications.some((n) => n.method === 'fatal'), 'the large round trip raised no fatal notification');
    const libRs = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'lib.rs'), 'utf8');
    const rustCap = (name) => { const m = libRs.match(new RegExp(`const ${name}: u64 = ([\\d_]+);`)); return m ? Number(m[1].replace(/_/g, '')) : null; };
    ok(rustCap('MAX_REQUEST_FRAME_BYTES') === MAX_REQUEST_FRAME_BYTES && rustCap('MAX_RESPONSE_FRAME_BYTES') === MAX_RESPONSE_FRAME_BYTES, 'lib.rs and protocol.mjs agree on both frame caps', `${rustCap('MAX_REQUEST_FRAME_BYTES')}/${rustCap('MAX_RESPONSE_FRAME_BYTES')}`);
    // GATE-step6-hosts condition 6: talk.turn's head can take longer than CALL_TIMEOUT (a non-streamed fallback after a
    // stream timeout is FIRST_TOKEN_MS + TIMEOUT_MS), so it alone gets 60 s = 30 s + 20 s + 5 s. The host number is
    // re-derived here from the chat budgets so it cannot silently drift again; every other method keeps 30 s. No cancel
    // rpc (Electron parity).
    const rustNum = (name) => {
      const line = libRs.split('\n').find((l) => l.startsWith(`const ${name}: Duration`));
      const m = line && line.match(/from_secs\((\d+)\)/);
      return m ? Number(m[1]) : null;
    };
    ok(rustNum('CALL_TIMEOUT') === 30, 'every other method keeps the 30 s CALL_TIMEOUT', String(rustNum('CALL_TIMEOUT')));
    ok(rustNum('TALK_TURN_TIMEOUT') === 60, 'talk.turn has a 60 s host timeout (30 s first token + 20 s fallback + 5 s margin)', String(rustNum('TALK_TURN_TIMEOUT')));
    {
      // The two budgets live in chat-brain.js. FIRST_TOKEN_MS is exported; TIMEOUT_MS (postChat's non-streamed default)
      // is not, so read it from the source. host >= first token + fallback + 5 s margin must hold.
      const chatBrain = createRequire(import.meta.url)('../src/main/chat-brain.js');
      const chatSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'chat-brain.js'), 'utf8');
      const fallbackMs = Number((chatSrc.match(/const TIMEOUT_MS = (\d+);/) || [])[1]);
      const firstTokenMs = chatBrain.FIRST_TOKEN_MS;
      const hostSecs = rustNum('TALK_TURN_TIMEOUT');
      const marginSecs = 5;
      ok(Number.isFinite(firstTokenMs) && Number.isFinite(fallbackMs) && Number.isFinite(hostSecs) && hostSecs >= firstTokenMs / 1000 + fallbackMs / 1000 + marginSecs,
        'talk.turn host timeout covers FIRST_TOKEN_MS + non-streamed fallback + 5 s margin (derived from chat-brain)',
        `host=${hostSecs}s firstToken=${firstTokenMs}ms fallback=${fallbackMs}ms`);
    }
    ok(/fn method_timeout\(method: &str\) -> Duration \{[^}]*"talk\.turn"[^}]*TALK_TURN_TIMEOUT/.test(libRs), 'only talk.turn is mapped to TALK_TURN_TIMEOUT (method_timeout)');
    // 0.3.0-alpha.11: the wardrobe's 240 s timeout (zumiHost.apply / wardrobe.verifyFull) left with the wardrobe.
    ok(!/WARDROBE_APPLY_TIMEOUT|"zumiHost\.apply"|"wardrobe\.verifyFull"/.test(libRs.slice(0, libRs.indexOf('#[cfg(test)]'))), 'method_timeout has no wardrobe arm and lib.rs no WARDROBE_APPLY_TIMEOUT');
    ok(/let timeout = method_timeout\(&method\);/.test(libRs) && /client\.call\(&method, args, timeout\)/.test(libRs), 'the ordinary rpc path uses the per-method timeout', 'rpc path not found');
    const fits = { jsonrpc: '2.0', id: 7, result: 'x' };
    ok(serializeResponse(fits) === JSON.stringify(fits), 'a response under the response cap is sent as its JSON text');
    const tooBig = JSON.parse(serializeResponse({ jsonrpc: '2.0', id: 8, result: 'x'.repeat(MAX_RESPONSE_FRAME_BYTES) }));
    ok(tooBig.id === 8 && tooBig.error && tooBig.error.message === 'response_too_large' && !('result' in tooBig), 'a response over the cap becomes that call own error, never a frame the host rejects', JSON.stringify(tooBig).slice(0, 120));
    // 6-pre limits (non-blocking item): the response is stringified exactly once, then written as that text.
    let stringifyCalls = 0;
    const realStringify = JSON.stringify;
    JSON.stringify = function counted(...a) { stringifyCalls += 1; return realStringify.apply(this, a); };
    try { serializeResponse(fits); } finally { JSON.stringify = realStringify; }
    ok(stringifyCalls === 1, 'a response under the cap is serialized once (no second stringify at the writer)', String(stringifyCalls));
  }

  // ---- host signals (6-pre, F6): idle / windowVisible / osEvent are PUSHED by Rust as notifications ----
  {
    const sig = createHostSignals();
    ok(sig.idleSeconds() === 0 && sig.windowVisible() === true, 'signal defaults: the user is here (idle 0), the window is visible');
    const h = sig.handlers;
    h['__host.idle'](12.9);
    ok(sig.idleSeconds() === 12, 'idle(12.9) caches 12 whole seconds');
    for (const bad of [-1, NaN, Infinity, '7', null, undefined]) h['__host.idle'](bad);
    ok(sig.idleSeconds() === 12, 'a non-number, negative or non-finite idle is ignored');
    h['__host.windowVisible'](false);
    ok(sig.windowVisible() === false, 'windowVisible(false) is cached');
    h['__host.windowVisible']('yes');
    ok(sig.windowVisible() === false, 'a non-boolean windowVisible is ignored');
    const seen = [];
    const off = sig.onOsEvent((n) => seen.push(n));
    sig.onOsEvent(() => { throw new Error('a bad subscriber'); });
    sig.onOsEvent((n) => seen.push(`2:${n}`));
    h['__host.osEvent']('lock-screen');
    h['__host.osEvent']('suspend');
    ok(seen.join() === 'lock-screen,2:lock-screen,suspend,2:suspend', 'osEvent reaches every subscriber in order, a throwing one included', seen.join());
    ok(h['__host.osEvent']('resume') === false && h['__host.osEvent']({}) === false && seen.length === 4, 'an unknown or non-string osEvent reaches nobody');
    off();
    h['__host.osEvent']('lock-screen');
    ok(seen.length === 5, 'an unsubscribed listener hears nothing more');

    // Over the real stdio protocol: three notifications (no id) get no reply and raise no fatal; the next request still answers.
    const rawBefore = c.raw.length;
    c.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: '__host.idle', params: [3] })}\n`);
    c.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: '__host.windowVisible', params: [false] })}\n`);
    c.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: '__host.osEvent', params: ['lock-screen'] })}\n`);
    const after = (await c.request('info')).result;
    ok(Boolean(after) && c.raw.length === rawBefore + 1 && !c.notifications.some((n) => n.method === 'fatal'), 'signal notifications get no reply and no fatal; info still answers', String(c.raw.length - rawBefore));
    const viaRpc = await c.request('__host.idle', [1]);
    ok(viaRpc.result === true, '__host.idle with an id answers true (the host never does this; the renderer cannot reach it, see check:tauri-allowlist)');
  }

  // ---- frames the sidecar cannot tie to a request fail fast with a `fatal` notification ----
  // (a parse error and an oversized frame have no usable id, so the host must be told to stop)
  c.child.stdin.write('this is not json\n');
  const parseFatal = await waitFor(() => c.notifications.find((n) => n.method === 'fatal' && /parse_error/.test(n.params && n.params.message)));
  ok(Boolean(parseFatal), 'a parse-error frame emits a fatal notification (no usable id)', JSON.stringify(parseFatal));

  c.child.stdin.write(`${'x'.repeat(MAX_REQUEST_FRAME_BYTES + 1)}\n`);
  const bigFatal = await waitFor(() => c.notifications.find((n) => n.method === 'fatal' && /frame_too_large/.test(n.params && n.params.message)));
  ok(Boolean(bigFatal), 'an oversized frame emits a fatal frame_too_large notification', JSON.stringify(bigFatal));

  c.close();
  await new Promise((r) => c.child.on('exit', r));

  // ---- P1b: the three guest methods (real loopback servers; all temp data under TMP_ROOT) ----
  {
    const boardDir = fs.mkdtempSync(path.join(TMP_ROOT, 'p1b-board-'));
    const cb = startSidecar(['--data-dir', boardDir]);

    // board.status is exactly main.js's not-ready shape, so the renderer takes the local branch.
    const status = (await cb.request('board.status')).result;
    ok(status && status.mode === 'local' && status.configured === false && status.locked === true && status.pinRequired === true,
      'board.status returns the not-ready local shape', JSON.stringify(status));

    // With nothing opened, every guestDecide refuses.
    const nothing = (await cb.request('__host.guestDecide', ['http://127.0.0.1:9/', 'preview-board'])).result;
    ok(nothing && nothing.allow === false && nothing.origin === null, 'guestDecide refuses when nothing is open', JSON.stringify(nothing));

    // openBoard serves a real board on 127.0.0.1, writing ONLY under the temp data dir.
    const opened = (await cb.request('openBoard')).result;
    ok(opened && /^http:\/\/127\.0\.0\.1:\d+$/.test(opened.origin || ''), 'openBoard returns a 127.0.0.1 origin', JSON.stringify(opened && opened.origin));
    ok(opened && opened.root === path.join(boardDir, 'board-data'), 'the board root is <dataDir>/board-data (never Zumi-data / Electron userData)', JSON.stringify(opened && opened.root));
    ok(opened && typeof opened.laneboard === 'string' && opened.laneboard.length > 0 && typeof opened.url === 'string' && opened.url.includes('#token='), 'openBoard returns the laneboard version and a token URL', JSON.stringify(opened && opened.laneboard));
    const page = await fetch(`${opened.origin}/`);
    ok(page.status === 200, 'the opened board page answers 200', String(page.status));
    ok(fs.existsSync(path.join(boardDir, 'board-data', 'laneboard', 'events.ndjson')), 'the board journal landed under the temp data dir');
    ok(!fs.existsSync(path.join(ROOT, 'Zumi-data')), 'nothing was written to a Zumi-data folder');

    // The chosen port is saved back to the preview settings.json (main.js startBoard parity), so a
    // restart reuses the same origin and the board page keeps its browser storage.
    const openedPort = Number(new URL(opened.origin).port);
    const boardSettings = JSON.parse(fs.readFileSync(path.join(boardDir, 'settings.json'), 'utf8'));
    ok(boardSettings.boardPort === openedPort, 'openBoard saves the chosen port back to settings.boardPort', `${boardSettings.boardPort} vs ${openedPort}`);

    // guestDecide: exact origin + the matching partition only.
    const allowBoard = (await cb.request('__host.guestDecide', [opened.origin + '/', 'preview-board'])).result;
    ok(allowBoard && allowBoard.allow === true && !('preload' in allowBoard) && allowBoard.origin === opened.origin,
      'guestDecide allows the board origin on preview-board and hands out no preload at all', JSON.stringify(allowBoard));
    const wrongPart = (await cb.request('__host.guestDecide', [opened.origin + '/', 'preview-wardrobe'])).result;
    ok(wrongPart && wrongPart.allow === false && wrongPart.origin === null, 'guestDecide refuses the board origin on the wrong partition', JSON.stringify(wrongPart));
    const prefix = (await cb.request('__host.guestDecide', [`${opened.origin}evil.example`, 'preview-board'])).result;
    ok(prefix && prefix.allow === false, 'guestDecide refuses the prefix attack http://127.0.0.1:<port>evil.example', JSON.stringify(prefix));

    // ---- P1c3: __host.decideExternalUrl / __host.logRefusal (board-open.mjs decideExternalUrl, unchanged; 0.2.5 policy: any plain http/https web page opens) ----
    const logFile = path.join(boardDir, 'logs', 'board-open-refusals.log');
    const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
    const ext = async (url, ...rest) => (await cb.request('__host.decideExternalUrl', [url, ...rest])).result;
    const allowedLink = await ext('https://zumia.space/pricing?plan=x#top');
    ok(allowedLink && allowedLink.action === 'openExternal' && allowedLink.url === 'https://zumia.space/pricing?plan=x#top', 'decideExternalUrl opens an ordinary https link with the normalised href', JSON.stringify(allowedLink));
    const loop = await ext('http://localhost:5/x?y=1');
    ok(loop && loop.action === 'openExternal' && loop.url === 'http://127.0.0.1:5/x?y=1', 'decideExternalUrl opens loopback http as 127.0.0.1 (the Electron policy)', JSON.stringify(loop));
    ok(readLog() === '', 'no allowed link wrote a refusal line');

    const refusals = {
      'javascript:alert(document.cookie)': 'url_not_allowed',
      'file:///C:/Windows/System32/calc.exe': 'url_not_allowed',
      'ms-msdt:/id PCWDiagnostic': 'url_not_allowed',
      'data:text/html,<script>1</script>': 'url_not_allowed',
      [String.raw`\\server\share\x.exe`]: 'bad_url',
      'https://claude.ai@evil.example/secret?token=SECRET': 'url_has_credentials',
      'https://xn--clude-5ve.ai/': 'url_idn_host',
      // 0.2.5: no host allowlist any more, so these are refused by the plain-web-page rule, not by a host table.
      'http://192.168.1.5/admin': 'url_not_allowed',
      'https://printer.local/': 'url_not_allowed',
      'https://zumia.space./': 'url_not_allowed',
      'ftp://zumia.space/': 'url_not_allowed',
    };
    for (const [url, reason] of Object.entries(refusals)) {
      const d = await ext(url);
      ok(d && d.action === 'refuse' && d.reason === reason, `decideExternalUrl refuses ${JSON.stringify(url.slice(0, 40))} (${reason})`, JSON.stringify(d));
    }
    const nonString = await ext(42);
    ok(nonString && nonString.action === 'refuse' && nonString.reason === 'bad_url', 'decideExternalUrl refuses a non-string url', JSON.stringify(nonString));

    // 0.2.5 opens any plain web page (a CoS decision), so the owner flag no longer gates a host. Extra arguments still
    // change nothing: the verdict equals the one without them, and the `cited` channel is still not ported.
    const plainClaude = await ext('https://claude.ai/chat');
    const ownerTry = await ext('https://claude.ai/chat', { ownerAdmin: true });
    ok(plainClaude && plainClaude.action === 'openExternal' && JSON.stringify(ownerTry) === JSON.stringify(plainClaude), 'an ownerAdmin argument changes nothing (same verdict as without)', JSON.stringify(ownerTry));
    const plainWiki = await ext('https://en.wikipedia.org/wiki/Hanoi');
    const citedTry = await ext('https://en.wikipedia.org/wiki/Hanoi', { cited: ['https://en.wikipedia.org/wiki/Hanoi'] });
    ok(plainWiki && JSON.stringify(citedTry) === JSON.stringify(plainWiki), 'the cited channel is not ported (a cited set argument changes nothing)', JSON.stringify(citedTry));
    const stricter = await ext('http://example.com/a');
    ok(stricter && stricter.action === 'openExternal', 'plain http opens too (Electron 0.2.5 decideExternalUrl)', JSON.stringify(stricter));

    // A URL on the app's own board origin is not a link: { action: 'none' }, no refusal line.
    const logBefore = readLog();
    const own = await ext(`${opened.origin}/other?x=1`);
    ok(own && own.action === 'none', 'a URL on the open board origin is { action: none } (Electron inBoard guard)', JSON.stringify(own));
    ok(readLog() === logBefore, 'the own-origin answer wrote no refusal line');
    const ownPrefix = await ext(`${opened.origin}evil.example/`);
    ok(ownPrefix && ownPrefix.action !== 'none' && ownPrefix.action !== 'openExternal', 'the own-origin guard is exact: http://127.0.0.1:<port>evil.example is refused', JSON.stringify(ownPrefix));

    // Every refusal was logged: reason + origin only, never a path, query, fragment, userinfo or token.
    const lines = readLog().split('\n').filter(Boolean);
    ok(lines.length === Object.keys(refusals).length + 2, 'one refusal line per refusal (table + non-string + own-origin prefix)', String(lines.length));
    ok(lines.every((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z [a-z_]+ \S+$/.test(l)), 'every log line is "<ISO time> <reason> <origin>"', lines.join(' | '));
    const logText = readLog();
    ok(!/SECRET|frag|token|pricing|cookie|admin|calc\.exe|secret/i.test(logText) && !logText.includes('@') && !logText.includes('?') && !logText.includes('#'), 'the log carries no URL path, query, fragment, userinfo or payload');
    ok(logText.includes(' url_has_credentials https://evil.example'), 'a userinfo link logs the real host only', logText);

    // __host.logRefusal: the Rust host's own refusals go through the same helper, same file.
    const rl = await cb.request('__host.logRefusal', ['host_revalidate', 'https://example.org:8443']);
    ok(rl.result === true && readLog().trimEnd().endsWith(' host_revalidate https://example.org:8443'), 'logRefusal appends reason + origin to the same log', readLog().slice(-120));
    await cb.request('__host.logRefusal', ['Not A Reason!', 'https://u:p@example.org/x?q=1#f']);
    ok(readLog().trimEnd().endsWith(' unknown https://example.org'), 'logRefusal sanitises a bad reason and strips a full URL to its origin', readLog().slice(-120));
    // Unknown names stay not_implemented; the renderer-visible names do not include either __host method.
    const hostOnly = await cb.request('__host.nope', []);
    ok(hostOnly.error && /not_implemented/.test(hostOnly.error.message || ''), '__host.nope is not_implemented (no wildcard __host handler)');

    // A second openBoard call reuses the cached board (same origin).
    const again = (await cb.request('openBoard')).result;
    ok(again && again.origin === opened.origin, 'a second openBoard call reuses the cached board');

    cb.close();
    await new Promise((r) => cb.child.on('exit', r));
  }

  // 0.3.0-alpha.11: the wardrobe is gone. Every one of its names is an honest not_implemented over stdio (even with
  // ZUMI_WARDROBE_DIR pointing at a tree), and a guest on the old preview-wardrobe partition is refused.
  {
    const wDir = fs.mkdtempSync(path.join(TMP_ROOT, 'p1b-wardrobe-'));
    const cw = startSidecar(['--data-dir', path.join(wDir, 'data')], { ZUMI_WARDROBE_DIR: wDir });
    for (const m of ['wardrobe.open', 'wardrobe.undo', 'wardrobe.canUndo', 'wardrobe.verifyFull', 'zumiHost.apply']) {
      const r = await cw.request(m, m === 'zumiHost.apply' ? [{ recipe: {} }] : []);
      ok(r && r.result === undefined && r.error && r.error.message === `not_implemented:${m}`, `${m} is not_implemented (wardrobe removed)`, JSON.stringify(r));
    }
    const part = (await cw.request('__host.guestDecide', ['http://127.0.0.1:4212/', 'preview-wardrobe'])).result;
    ok(part && part.allow === false && part.origin === null, 'guestDecide refuses a loopback src on the old preview-wardrobe partition', JSON.stringify(part));
    const info = (await cw.request('info')).result;
    ok(info && !Object.keys(info).some((k) => /wardrobe/i.test(k)), 'info carries no wardrobe field', JSON.stringify(info && Object.keys(info)));
    cw.close();
    await new Promise((r) => cw.child.on('exit', r));
  }

  // T-31 alpha.12: soul / rhythm / watch through the real sidecar over stdio; everything lands in the --data-dir it was given.
  {
    const aDir = path.join(fs.mkdtempSync(path.join(TMP_ROOT, 'a12-agent-')), 'data');
    const ca = startSidecar(['--data-dir', aDir], { ZUMI_ELECTRON_HOST: '', ZUMI_GUARD_PROBE_ORIGIN: 'http://127.0.0.1:47931' });
    const call = async (m, ...p) => (await ca.request(m, p)).result;
    const g = await call('soul.get');
    ok(g && g.onboarded === false && g.templates.length === 5 && g.canUndo === false, 'soul.get: a fresh profile is not onboarded, 5 templates', JSON.stringify(g && Object.keys(g)));
    const refused = await call('soul.save', { persona: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
    ok(refused && refused.ok === false && refused.error === 'secret_shaped', 'soul.save refuses a key-shaped persona', JSON.stringify(refused));
    const saved = await call('soul.save', { template: 'calm', ownerName: 'Kei' });
    ok(saved && saved.ok === true && saved.soul.template === 'calm', 'soul.save saves', JSON.stringify(saved));
    ok(JSON.parse(fs.readFileSync(path.join(aDir, 'settings.json'), 'utf8')).soul.ownerName === 'Kei' && fs.existsSync(path.join(aDir, 'soul-history.json')), 'the soul lands in <data-dir>/settings.json + soul-history.json');
    const undone = await call('soul.undo');
    ok(undone && undone.ok === true && undone.soul.ownerName === '', 'soul.undo restores the previous soul', JSON.stringify(undone));
    const rh = await call('rhythm.get');
    ok(rh && rh.learning === true && Array.isArray(rh.activeProb) && JSON.stringify(rh.checkinHours) === '[12,16]' && rh.watchLevel === 'on', 'rhythm.get: learning, v1 check-ins, watcher on', JSON.stringify(rh && rh.checkinHours));
    const paused = await call('rhythm.pause', true);
    ok(paused && paused.paused === true && fs.existsSync(path.join(aDir, 'rhythm', 'state.json')), 'rhythm.pause lands in <data-dir>/rhythm/state.json');
    const off = await call('watch.setLevel', 'off');
    ok(off && off.watchLevel === 'off' && JSON.parse(fs.readFileSync(path.join(aDir, 'settings.json'), 'utf8')).watchLevel === 'off', 'watch.setLevel off persists');
    const reset = await call('rhythm.reset');
    ok(reset && reset.events === 0 && reset.paused === false && !fs.existsSync(path.join(aDir, 'rhythm')), 'rhythm.reset deletes <data-dir>/rhythm');
    const noBox = await call('__host.guestDecide', 'http://127.0.0.1:47931/', 'preview-board');
    ok(noBox && noBox.allow === false, 'off the render box the guard-probe origin is refused, even with the env var set', JSON.stringify(noBox));
    ca.close();
    await new Promise((r) => ca.child.on('exit', r));
    const cb = startSidecar(['--data-dir', path.join(aDir, '..', 'box')], { ZUMI_ELECTRON_HOST: 'box', ZUMI_GUARD_PROBE_ORIGIN: 'http://127.0.0.1:47931' });
    const onBox = (await cb.request('__host.guestDecide', ['http://127.0.0.1:47931/', 'preview-board'])).result;
    const wrongPart = (await cb.request('__host.guestDecide', ['http://127.0.0.1:47931/', 'preview-board-live'])).result;
    const otherPort = (await cb.request('__host.guestDecide', ['http://127.0.0.1:47932/', 'preview-board'])).result;
    ok(onBox && onBox.allow === true && onBox.origin === 'http://127.0.0.1:47931', 'on the render box the runner-named origin attaches on the board partition', JSON.stringify(onBox));
    ok(wrongPart && wrongPart.allow === false && otherPort && otherPort.allow === false, 'on the render box: another partition or another port is still refused');
    cb.close();
    await new Promise((r) => cb.child.on('exit', r));
  }

  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('check-tauri-sidecar error:', e && e.message);
  process.exit(1);
});
