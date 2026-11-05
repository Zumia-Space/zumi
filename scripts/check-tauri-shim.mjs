// T-31 P1a shim check. Plain Node, no Electron, nothing opened, no network.
//
// Verifies, against the frozen inventory:
//   1. the committed tauri/shim/zumi-shim.js is exactly what tauri/shim/generate-shim.mjs produces
//      (no hand edits, no drift);
//   2. the generated shim exposes EVERY inventory name on window.zumi / window.zumiHost (coverage),
//      with the inventory's arity, and nothing extra;
//   3. each leaf behaves by kind: invoke -> Promise, send -> undefined, event -> unsubscribe fn;
//   4. an unimplemented method is rejected with `not_implemented:<name>` (never a faked success),
//      while an implemented one resolves.
//
//   node scripts/check-tauri-shim.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { generateShim } from '../tauri/shim/generate-shim.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

const INVENTORY_PATH = path.join(ROOT, 'docs', 'migration', 'api-inventory.json');
const SHIM_PATH = path.join(ROOT, 'tauri', 'shim', 'zumi-shim.js');
const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
const apis = inventory.apis || [];
const byName = new Map(apis.map((a) => [a.name, a]));

// ---- 1. committed shim == freshly generated ----
ok(fs.existsSync(SHIM_PATH), 'committed shim exists (tauri/shim/zumi-shim.js)');
const committed = fs.readFileSync(SHIM_PATH, 'utf8');
const expected = generateShim(inventory);
ok(committed === expected, 'committed shim matches a fresh generation (run: node tauri/shim/generate-shim.mjs)');

// ---- 2/3/4. run the shim in a sandbox ----
const IMPLEMENTED = new Set(['info', 'ui.getLang', 'ui.setLang', 'ui.getDevTools', 'ui.setDevTools', 'roles.get']);
const invokes = [];
const listens = [];
const listenedHandlers = new Map();
const errorsLogged = [];
const dispatched = [];
const fakeTauri = {
  core: {
    invoke: (cmd, payload) => {
      invokes.push({ cmd, ...payload });
      if (cmd !== 'rpc') return Promise.resolve(null);
      if (IMPLEMENTED.has(payload.method)) return Promise.resolve({ stub: payload.method });
      return Promise.reject(new Error(`not_implemented:${payload.method}`));
    },
  },
  event: { listen: (name, handler) => { listens.push(name); listenedHandlers.set(name, handler); return Promise.resolve(() => {}); } },
};
const windowObj = {
  __TAURI__: fakeTauri,
  console: { error: (...a) => errorsLogged.push(a) },
  CustomEvent,
  dispatchEvent: (ev) => { dispatched.push(ev); return true; },
};
const sandbox = { window: windowObj, Promise, URL, console };
vm.runInNewContext(committed, sandbox, { filename: 'zumi-shim.js' });

const zumi = windowObj.zumi;
ok(zumi && typeof zumi === 'object', 'window.zumi is an object');

// Host-level sidecar failures must surface (console + a window event).
ok(listenedHandlers.has('sidecar:error'), 'the shim listens for the host sidecar:error event');
if (listenedHandlers.has('sidecar:error')) listenedHandlers.get('sidecar:error')({ payload: { message: 'boom', fatal: true } });
ok(errorsLogged.length >= 1, 'sidecar:error is written to console.error');
ok(dispatched.some((e) => e.type === 'zumi:sidecar-error' && e.detail && e.detail.message === 'boom'),
  'sidecar:error is surfaced as a window zumi:sidecar-error event');

// window.zumiHost must NOT be exposed by this shim (no guest page loads it; the wardrobe bridge left in 0.3.0-alpha.11).
{
  const mainWindow = {
    __TAURI__: { core: { invoke: () => Promise.resolve(null) }, event: { listen: () => Promise.resolve(() => {}) } },
  };
  vm.runInNewContext(committed, { window: mainWindow, Promise, URL, console }, { filename: 'zumi-shim.js' });
  ok(mainWindow.zumi && typeof mainWindow.zumi === 'object', 'window.zumi is present in the main window');
  ok(mainWindow.zumiHost === undefined, 'window.zumiHost is NOT exposed by the shim');
}

// alpha.14 launch fix N1: listen() is asynchronous, so an event pushed before it resolves is lost. The unsubscribe carries
// `ready`, resolved only once the listener is live, so talk/director.js can listen for a turn's reply before sending it.
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { __TAURI__: { core: { invoke: () => Promise.resolve(null) }, event: { listen: () => gate.then(() => () => {}) } } };
  vm.runInNewContext(committed, { window: slow, Promise, URL, console }, { filename: 'zumi-shim.js' });
  const off = slow.zumi.talk.onReplyMore('t9', () => {});
  let live = false;
  const watched = off.ready && off.ready.then(() => { live = true; });
  await new Promise((r) => setTimeout(r, 20));
  const before = live;
  release();
  await watched;
  ok(typeof off === 'function' && Boolean(watched) && before === false && live === true, "a subscription's unsubscribe carries ready, resolved only once listen() has resolved", JSON.stringify({ before, live }));
}

// Walk the window.zumi world into dotted leaf names.
const leaves = [];
const walk = (obj, trail) => {
  for (const [key, val] of Object.entries(obj)) {
    const here = `${trail}${key}`;
    if (typeof val === 'function') leaves.push({ name: here, fn: val });
    else if (val && typeof val === 'object') walk(val, `${here}.`);
  }
};
walk(zumi, '');

// The shim covers the window.zumi world only. An inventory name on window.zumiHost would be excluded from this shim's
// coverage requirement; since 0.3.0-alpha.11 (wardrobe removed) the inventory has none.
const isZumiHostName = (a) => (a.exposedBy && /zumiHost/.test(a.exposedBy)) || (typeof a.name === 'string' && a.name.startsWith('zumiHost.'));
const zumiApis = apis.filter((a) => !isZumiHostName(a));
const names = new Set(leaves.map((l) => l.name));
const missing = zumiApis.map((a) => a.name).filter((n) => !names.has(n)).sort();
const extra = [...names].filter((n) => !byName.has(n)).sort();
ok(names.size > 0, 'the shim exposes at least one name');
ok(missing.length === 0, 'every window.zumi inventory name is exposed by the shim', missing.length ? `missing ${missing.length}: ${missing.join(', ')}` : '');
ok(extra.length === 0, 'the shim exposes no name absent from the inventory', extra.join(', '));

// Per-leaf: arity matches, and kind behaviour is right.
const arityBad = [];
const kindBad = [];
for (const leaf of leaves) {
  const api = byName.get(leaf.name);
  if (!api) continue;
  if (leaf.fn.length !== (api.args || []).length) arityBad.push(`${leaf.name}: shim=${leaf.fn.length} inventory=${(api.args || []).length}`);
  const args = new Array(leaf.fn.length).fill(undefined);
  let result;
  try { result = leaf.fn(...args); } catch { result = undefined; }
  // Keep unhandled rejections from unimplemented invoke leaves out of the host process.
  if (result && typeof result.then === 'function') result.catch(() => {});
  if (api.kind === 'invoke' && !(result && typeof result.then === 'function')) kindBad.push(`${leaf.name}: invoke did not return a Promise`);
  if (api.kind === 'send' && result !== undefined) kindBad.push(`${leaf.name}: send returned a value (should be undefined)`);
  if (api.kind === 'event' && typeof result !== 'function') kindBad.push(`${leaf.name}: event did not return an unsubscribe function`);
}
ok(arityBad.length === 0, 'every shim function keeps its inventory arity', arityBad.join('; '));
ok(kindBad.length === 0, 'every leaf behaves by kind (invoke=Promise, send=undefined, event=unsubscribe fn)', kindBad.join('; '));

// Implemented method resolves; unimplemented rejects with not_implemented:<name>.
(async () => {
  const okValue = await zumi.ui.getLang();
  ok(okValue && okValue.stub === 'ui.getLang', 'an implemented method resolves through invoke("rpc")');
  ok(invokes.some((c) => c.cmd === 'rpc' && c.method === 'ui.getLang'), 'ui.getLang is routed as invoke("rpc", {method})');

  let rejected = null;
  try { await zumi.rooms.list(); } catch (e) { rejected = e; }
  ok(rejected && /^not_implemented:rooms\.list$/.test(rejected.message), 'an unimplemented method rejects with not_implemented:<name>', rejected ? rejected.message : 'no rejection');

  // A rejection that is a plain string (Tauri returns the Rust command's Err value) must be normalized
  // to an Error, so renderer handlers that read err.message keep working.
  const stringSandbox = { window: { __TAURI__: { core: { invoke: () => Promise.reject('not_implemented:rooms.list') }, event: { listen: () => Promise.resolve(() => {}) } } }, Promise, URL, console };
  vm.runInNewContext(committed, stringSandbox, { filename: 'zumi-shim.js' });
  let normalized = null;
  try { await stringSandbox.window.zumi.rooms.list(); } catch (e) { normalized = e; }
  // Errors thrown inside the vm realm are not `instanceof` the host Error; brand-check instead.
  ok(normalized && Object.prototype.toString.call(normalized) === '[object Error]' && normalized.message === 'not_implemented:rooms.list',
    'a string rejection is normalized to an Error with .message', normalized ? String(normalized.message) : 'no rejection');

  await zumi.update.onState(() => {});
  ok(listens.includes('update:state'), 'an event subscription listens on its inventory channel');

  // A send-kind call must not surface an unhandled rejection when the sidecar rejects it.
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  if (typeof process.on === 'function') process.on('unhandledRejection', onUnhandled);
  zumi.demo.log('hi');
  await new Promise((r) => setTimeout(r, 10));
  if (typeof process.removeListener === 'function') process.removeListener('unhandledRejection', onUnhandled);
  ok(unhandled === 0, 'a send-kind call does not leak an unhandled rejection');

  // The shim must be injected BEFORE the renderer bundle by prep-ui.mjs.
  const prep = fs.readFileSync(path.join(ROOT, 'tauri', 'prep-ui.mjs'), 'utf8');
  const shimTag = '<script src="zumi-shim.js"></script>';
  ok(prep.includes('<script src="app.js"></script>'), 'prep-ui anchors on the renderer bundle script');
  const inject = prep.match(/idx\.replace\(anchor,\s*`([\s\S]*?)`\)/);
  ok(Boolean(inject) && inject[1].includes(shimTag) && inject[1].indexOf(shimTag) < inject[1].indexOf('${anchor}'),
    'prep-ui injects the shim before app.js');

  // ---- the reshaped events match src/main/preload.js ----
  {
    const seen = [];
    zumi.talk.onReplyMore('t1', (t) => seen.push(t));
    listenedHandlers.get('talk:replyMore')({ payload: { turnId: 't1', text: 'hi' } });
    listenedHandlers.get('talk:replyMore')({ payload: { turnId: 'other', text: 'no' } });
    listenedHandlers.get('talk:replyMore')({ payload: { turnId: 't1', text: 7 } });
    ok(seen.length === 1 && seen[0] === 'hi', 'onReplyMore delivers cb(text) only for its turnId', JSON.stringify(seen));
  }
  {
    // onReplyDone reshapes like preload.js:96: { ok, reply, error, sources:[{url,title}] }.
    const seen = [];
    zumi.talk.onReplyDone('t3', (v) => seen.push(v));
    listenedHandlers.get('talk:replyDone')({ payload: { turnId: 't3', ok: true, reply: 'hi', sources: [{ url: 'u', title: 't' }, { title: 'no url' }, null] } });
    listenedHandlers.get('talk:replyDone')({ payload: { turnId: 'zzz', ok: true, reply: 'no' } });
    const r = seen[0] || {};
    ok(seen.length === 1 && r.ok === true && r.reply === 'hi' && r.error === null &&
      Array.isArray(r.sources) && r.sources.length === 1 && r.sources[0].url === 'u' && r.sources[0].title === 't',
      'onReplyDone reshapes { ok, reply, error, sources } like preload.js:96', JSON.stringify(seen));
  }
  {
    // Missing optional fields fall back to { ok:false, reply:'', error:null, sources:[] }.
    const seen = [];
    zumi.talk.onReplyDone('t5', (v) => seen.push(v));
    listenedHandlers.get('talk:replyDone')({ payload: { turnId: 't5' } });
    const r = seen[0] || {};
    ok(seen.length === 1 && r.ok === false && r.reply === '' && r.error === null && Array.isArray(r.sources) && r.sources.length === 0,
      'onReplyDone defaults missing fields (preload.js:96)', JSON.stringify(seen));
  }
  {
    // onCheckDone reshapes like preload.js:99 and only fires for verdict ok|fix + its turnId.
    const seen = [];
    zumi.talk.onCheckDone('t4', (v) => seen.push(v));
    listenedHandlers.get('talk:checkDone')({ payload: { turnId: 't4', verdict: 'fix', text: 'x' } });
    listenedHandlers.get('talk:checkDone')({ payload: { turnId: 't4', verdict: 'weird', text: 'x' } });
    listenedHandlers.get('talk:checkDone')({ payload: { turnId: 'zzz', verdict: 'ok', text: 'x' } });
    ok(seen.length === 1 && seen[0].verdict === 'fix' && seen[0].text === 'x',
      'onCheckDone reshapes { verdict, text } only for ok|fix + its turnId', JSON.stringify(seen));
  }
  {
    const seen = [];
    zumi.talk.onTtsMore('t2', (a) => seen.push(a));
    listenedHandlers.get('talk:ttsMore')({ payload: { turnId: 't2', audio: { chunk: 1 } } });
    listenedHandlers.get('talk:ttsMore')({ payload: { turnId: 'zzz', audio: { chunk: 2 } } });
    ok(seen.length === 1 && seen[0] && seen[0].chunk === 1, 'onTtsMore delivers cb(audio) only for its turnId', JSON.stringify(seen));
  }
  {
    const seen = [];
    zumi.update.onState((s) => seen.push(s));
    listenedHandlers.get('update:state')({ payload: { phase: 'downloading', percent: 3 } });
    listenedHandlers.get('update:state')({ payload: { percent: 3 } });
    ok(seen.length === 1 && seen[0].phase === 'downloading', 'onState delivers only payloads with a string phase', JSON.stringify(seen));
  }
  {
    // onGesture: handler(command), then the result is sent back on gesture:result (preload.js:82-86).
    const seen = [];
    zumi.onGesture((command) => { seen.push(command); return { ok: true, command }; });
    listenedHandlers.get('gesture:play')({ payload: { reqId: 7, command: 'wave' } });
    await new Promise((r) => setTimeout(r, 10));
    ok(seen.length === 1 && seen[0] === 'wave', 'onGesture delivers the command to the handler', JSON.stringify(seen));
    const reply = invokes.filter((c) => c.cmd === 'rpc' && c.method === 'gesture:result').pop();
    ok(reply && Array.isArray(reply.args) && reply.args[0] === 7 && reply.args[1] && reply.args[1].ok === true && reply.args[1].command === 'wave',
      'onGesture sends its handler result back on gesture:result (preload.js:85)', JSON.stringify(reply));
  }
  {
    // A throwing handler becomes { ok:false, errors:[message] }, like preload.js:84.
    zumi.onGesture(() => { throw new Error('nope'); });
    listenedHandlers.get('gesture:play')({ payload: { reqId: 8, command: 'x' } });
    await new Promise((r) => setTimeout(r, 10));
    const reply = invokes.filter((c) => c.cmd === 'rpc' && c.method === 'gesture:result').pop();
    ok(reply && Array.isArray(reply.args) && reply.args[0] === 8 && reply.args[1] && reply.args[1].ok === false &&
      Array.isArray(reply.args[1].errors) && reply.args[1].errors[0] === 'nope',
      'onGesture returns { ok:false, errors:[msg] } when the handler throws (preload.js:84)', JSON.stringify(reply));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
