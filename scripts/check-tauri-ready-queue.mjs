// T-31 boot-race check: rpc issued before the sidecar's ready handshake.
//
// On the real Tauri build the first load showed `sidecar_not_ready` in the chat area and an empty provider
// picker until a reload, because the renderer's first calls raced the sidecar handshake. The host refuses a
// call made before ready (`lib.rs`, `pending.ready`), so the shim now holds such a call until the host's
// `sidecar:ready` event and sends it once. This check drives the committed shim in a vm against a fake host
// that answers exactly like the Rust host: `sidecar_not_ready` until the ready frame, real replies after.
//
//   node scripts/check-tauri-ready-queue.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shim = fs.readFileSync(path.join(ROOT, 'tauri', 'shim', 'zumi-shim.js'), 'utf8');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake host: every rpc is refused with the Rust host's typed `sidecar_not_ready` until the test delivers
// the `sidecar:ready` frame, then answers the two methods this check drives.
function makeHost({ readyTimeoutMs, deferFirstReject = false }) {
  const state = { ready: false, deferFirstReject, deferredUsed: false, rejectFirst: null, calls: [], listened: new Map() };
  const tauri = {
    core: {
      invoke: (cmd, payload) => {
        if (cmd !== 'rpc') return Promise.resolve(null);
        state.calls.push(payload.method);
        if (!state.ready) {
          if (state.deferFirstReject && !state.deferredUsed) {
            state.deferredUsed = true;
            return new Promise((_resolve, reject) => { state.rejectFirst = reject; });
          }
          return Promise.reject('sidecar_not_ready');
        }
        if (payload.method === 'ai.presetList') return Promise.resolve({ free: [{ id: 'gemini', label: 'Google Gemini' }], advanced: [], settings: {} });
        if (payload.method === 'talk.status') return Promise.resolve({ ok: true, level: 'normal' });
        return Promise.resolve({ stub: payload.method });
      },
    },
    event: {
      listen: (name, handler) => { state.listened.set(name, handler); return Promise.resolve(() => {}); },
    },
  };
  const win = {
    __TAURI__: tauri,
    __ZUMI_READY_TIMEOUT_MS: readyTimeoutMs,
    console: { error: () => {} },
    CustomEvent,
    dispatchEvent: () => true,
  };
  vm.runInNewContext(shim, { window: win, Promise, URL, console, setTimeout, clearTimeout }, { filename: 'zumi-shim.js' });
  state.zumi = win.zumi;
  state.readyFrame = () => {
    state.ready = true;
    const h = state.listened.get('sidecar:ready');
    if (h) h({ payload: { version: '9.9.9', protocol: 1 } });
  };
  return state;
}

// ---- 1. calls issued before ready wait for the ready frame, then resolve (the first-load race) ----
{
  const h = makeHost({ readyTimeoutMs: 500 });
  let preset = null;
  let talk = null;
  let rejected = null;
  h.zumi.ai.presetList().then((v) => { preset = v; }, (e) => { rejected = e; });
  h.zumi.talk.status().then((v) => { talk = v; }, (e) => { rejected = e; });
  await sleep(20);
  ok(preset === null && talk === null && rejected === null,
    'ai.presetList and talk.status are still pending while the sidecar is not ready (queued, not failed)',
    JSON.stringify({ preset, talk, error: rejected && rejected.message }));
  ok(h.calls.includes('ai.presetList') && h.calls.includes('talk.status'),
    'both calls were attempted and answered with the host\'s typed not-ready, then held', JSON.stringify(h.calls));
  ok(h.listened.has('sidecar:ready'), 'the shim listens for the host sidecar:ready frame');

  h.readyFrame();
  await sleep(20);
  ok(preset && Array.isArray(preset.free) && preset.free[0].id === 'gemini',
    'ai.presetList resolves correctly after the ready frame', JSON.stringify(preset));
  ok(talk && talk.ok === true && talk.level === 'normal',
    'talk.status resolves correctly after the ready frame', JSON.stringify(talk));
  ok(!rejected, 'neither queued call rejects once ready arrives', rejected && rejected.message);
}

// ---- 2. if ready never arrives within the bound, each held call gets the typed error ----
{
  const h = makeHost({ readyTimeoutMs: 40 });
  const settled = [];
  const p1 = h.zumi.ai.presetList().then(() => settled.push('preset:ok'), (e) => settled.push(`preset:${e && e.message}`));
  const p2 = h.zumi.talk.status().then(() => settled.push('talk:ok'), (e) => settled.push(`talk:${e && e.message}`));
  await sleep(15);
  ok(settled.length === 0, 'both calls are still held before the ready bound expires', JSON.stringify(settled));
  await Promise.all([p1, p2]);
  ok(settled.includes('preset:sidecar_not_ready') && settled.includes('talk:sidecar_not_ready'),
    'each held call rejects with the typed sidecar_not_ready when ready never comes', JSON.stringify(settled));
}

// ---- 3. a ready frame that beats the rejection of the call sent just before it is not lost ----
{
  const h = makeHost({ readyTimeoutMs: 500, deferFirstReject: true });
  let value = null;
  let rejected = null;
  h.zumi.talk.status().then((v) => { value = v; }, (e) => { rejected = e; });
  await sleep(10);
  h.readyFrame(); // the host becomes ready...
  h.rejectFirst('sidecar_not_ready'); // ...and only then does the pre-ready call's rejection land
  await sleep(20);
  ok(value && value.ok === true && !rejected,
    'a ready frame that arrives before the not-ready rejection is not lost (the call is sent once more)',
    JSON.stringify({ value, error: rejected && rejected.message }));
}

// ---- 4. a ready frame after the timeout does not resurrect a rejected call ----
{
  const h = makeHost({ readyTimeoutMs: 30 });
  const settled = [];
  const p = h.zumi.talk.status().then(() => settled.push('ok'), (e) => settled.push(e && e.message));
  await p;
  h.readyFrame();
  await sleep(10);
  ok(settled.length === 1 && settled[0] === 'sidecar_not_ready', 'a late ready frame leaves the timed-out call rejected', JSON.stringify(settled));
}

// ---- 5. N3: provisioning beats keep a held call open past the bound; ready then resolves it ----
{
  const h = makeHost({ readyTimeoutMs: 60 });
  const beat = () => { const f = h.listened.get('sidecar:provisioning'); if (f) f({ payload: { active: true } }); };
  ok(h.listened.has('sidecar:provisioning'), 'the shim listens for the host sidecar:provisioning beat');
  let value = null;
  let rejected = null;
  h.zumi.talk.status().then((v) => { value = v; }, (e) => { rejected = e; });
  for (let i = 0; i < 6; i++) { await sleep(25); beat(); } // 150 ms, well past the 60 ms bound
  ok(value === null && rejected === null, 'a call held past the bound stays pending while provisioning beats arrive', JSON.stringify({ value, error: rejected && rejected.message }));
  h.readyFrame();
  await sleep(20);
  ok(value && value.ok === true && !rejected, 'it resolves once ready arrives', JSON.stringify({ value, error: rejected && rejected.message }));
}

// ---- 6. N3: beats stop -> the normal bound applies; a fatal sidecar:error rejects at once ----
{
  const h = makeHost({ readyTimeoutMs: 40 });
  const beat = () => h.listened.get('sidecar:provisioning')({ payload: { active: true } });
  const settled = [];
  const p = h.zumi.talk.status().then(() => settled.push('ok'), (e) => settled.push(e && e.message));
  await sleep(25); beat();
  await sleep(25);
  ok(settled.length === 0, 'a beat re-arms the bound (still held 50 ms in, bound is 40 ms)', JSON.stringify(settled));
  await p; // no more beats: the bound expires
  ok(settled[0] === 'sidecar_not_ready', 'when beats stop the held call rejects after the normal bound', JSON.stringify(settled));
}
{
  const h = makeHost({ readyTimeoutMs: 5000 });
  const settled = [];
  const p = h.zumi.talk.status().then(() => settled.push('ok'), (e) => settled.push(e && e.message));
  await sleep(10);
  h.listened.get('sidecar:provisioning')({ payload: { active: true } });
  h.listened.get('sidecar:error')({ payload: { message: 'node_runtime_download_failed', fatal: true } });
  await p;
  ok(settled[0] === 'sidecar_not_ready', 'sidecar:error (fatal) rejects a call held during provisioning at once', JSON.stringify(settled));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
