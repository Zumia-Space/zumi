// T-31 parity step 2: sidecar -> renderer event path. Plain Node, no Electron, no window, no network.
//
//   node scripts/check-tauri-events.mjs   (exit 1 on any failure)
//
// What it proves (the Rust half -- unknown channel, oversize, main-only -- is in `cargo test`, events.rs):
//   1. a real child process using the sidecar's emitter writes one NDJSON `event` frame per inventory
//      channel, in order; a bad channel name and an oversize payload are refused in the sidecar's own log
//      and never written; the payload text never reaches the log;
//   2. those frames, relayed the way the host relays them (channel + payload, nothing else), reach the shim
//      listener of each of the 13 channels with the callback shape src/main/preload.js gives (independent
//      expectations below, not read back from the generator), byte-equal and in order;
//   3. unsubscribe stops delivery, a second subscriber does not double-deliver, an unknown channel has no
//      listener, a payload the preload filters out is dropped;
//   4. sidecar death: every pending rpc call is rejected with `sidecar_exited` (Rust unit test pins the
//      host side; the shim side is checked here) and a reply stream still open ends once through
//      talk.onReplyDone({ ok:false, error:'sidecar_exited' }); closed streams and other events get nothing;
//   5. the Rust and Node halves agree on the contract (size limit, frame shape, main-only emit).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MAX_EVENT_PAYLOAD_BYTES, eventFrame } from '../tauri/sidecar/protocol.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'migration', 'api-inventory.json'), 'utf8'));
const events = inventory.apis.filter((a) => a.kind === 'event');
const SECRET = 'PAYLOAD-MUST-NOT-BE-LOGGED';

// What the Electron preload hands the callback, written from src/main/preload.js (not from the generator).
// `args` = the leading arguments of the subscribe call (a turnId for the four turn-scoped events).
const SOURCES = [{ url: 'https://example.test/a', title: 'A' }];
const CASES = {
  'update:state':        { name: 'update.onState', args: [], payload: { phase: 'ready', version: '0.2.4', percent: 100 }, expect: [{ phase: 'ready', version: '0.2.4', percent: 100 }], dropped: { percent: 3 } },
  'hud:feed':            { name: 'hud.onFeed', args: [], payload: { kind: 'line', text: 'hi' }, expect: [{ kind: 'line', text: 'hi' }] },
  'gesture:play':        { name: 'onGesture', args: [], payload: { reqId: 4, command: 'wave' }, expect: ['wave'] },
  'talk:replyMore':      { name: 'talk.onReplyMore', args: ['t1'], payload: { turnId: 't1', text: 'hello wor' }, expect: ['hello wor'], dropped: { turnId: 'other', text: 'x' } },
  'talk:replyDone':      { name: 'talk.onReplyDone', args: ['t1'], payload: { turnId: 't1', ok: true, reply: 'hello world', sources: [...SOURCES, { title: 'no url' }] }, expect: [{ ok: true, reply: 'hello world', error: null, sources: SOURCES }], dropped: { turnId: 'other', ok: true } },
  'talk:checkDone':      { name: 'talk.onCheckDone', args: ['t1'], payload: { turnId: 't1', verdict: 'fix', text: 'use 2' }, expect: [{ verdict: 'fix', text: 'use 2' }], dropped: { turnId: 't1', verdict: 'maybe' } },
  'talk:ttsMore':        { name: 'talk.onTtsMore', args: ['t1'], payload: { turnId: 't1', audio: { mime: 'audio/wav', data: 'AAEC' } }, expect: [{ mime: 'audio/wav', data: 'AAEC' }], dropped: { turnId: 'other', audio: {} } },
  'market:progress': { name: 'market.onProgress', args: [], payload: { id: 'voice.kokoro-82m', phase: 'download', loaded: 5, total: 10 }, expect: [{ id: 'voice.kokoro-82m', phase: 'download', loaded: 5, total: 10 }] },
  'talk:kokoroProgress': { name: 'talk.onKokoroProgress', args: [], payload: { phase: 'download', loaded: 5, total: 10 }, expect: [{ phase: 'download', loaded: 5, total: 10 }] },
  'speech:say':          { name: 'talk.onSay', args: [], payload: { sayId: 's1', kind: 'ack', text: 'ok', show: true, voice: 'en', lang: 'en', mood: 'calm' }, expect: [{ sayId: 's1', kind: 'ack', text: 'ok', show: true, voice: 'en', lang: 'en', mood: 'calm' }], dropped: { text: 'no sayId' } },
  'model:changed':       { name: 'onModelChanged', args: [], payload: { reason: 'select' }, expect: [{ reason: 'select' }] },
  'reflex:event':        { name: 'onReflexEvent', args: [], payload: { type: 'board-message', from: 'lane' }, expect: [{ type: 'board-message', from: 'lane' }] },
  'window:focus':        { name: 'onWindowFocus', args: [], payload: false, expect: [false] },
  'window:visible':      { name: 'onWindowVisible', args: [], payload: true, expect: [true] },
};

ok(events.length === 14, 'the inventory has 14 event entries (market:progress added in 0.3.0-alpha.14)', `got ${events.length}`);
ok(!events.some((e) => /^wardrobe:/.test(e.channel)), 'no wardrobe event channel is left');
ok(events.every((e) => CASES[e.channel] && CASES[e.channel].name === e.name), 'every inventory event has a case here, named as the inventory names it', events.filter((e) => !CASES[e.channel]).map((e) => e.channel).join(', '));

// ---- 1. a real process emits the frames ----
const fixtureSource = `
import { createEmitter } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'tauri', 'sidecar', 'protocol.mjs')).href)};
const cases = JSON.parse(process.env.ZUMI_EVENT_CASES);
const emit = createEmitter((o) => process.stdout.write(JSON.stringify(o) + '\\n'), (m) => process.stderr.write(m + '\\n'));
const written = [];
for (const [channel, payload] of cases) written.push(emit(channel, payload));
// refused ones: a malformed channel, an unserializable payload, an oversize payload
written.push(emit('Not A Channel', { secret: ${JSON.stringify(SECRET)} }));
written.push(emit('speech:say', 1n));
written.push(emit('talk:ttsMore', { audio: ${JSON.stringify(SECRET)} + 'x'.repeat(${MAX_EVENT_PAYLOAD_BYTES}) }));
process.stderr.write('RESULT ' + JSON.stringify(written) + '\\n');
`;
const sent = events.map((e) => [e.channel, CASES[e.channel].payload]);
const child = spawnSync(process.execPath, ['--input-type=module', '-e', fixtureSource], { encoding: 'utf8', env: { ...process.env, ZUMI_EVENT_CASES: JSON.stringify(sent) } });
const frames = child.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const written = JSON.parse((child.stderr.match(/RESULT (.*)/) || [])[1] || '[]');
ok(child.status === 0, 'the emitting process exits cleanly', child.stderr.slice(0, 200));
ok(frames.length === 14, 'exactly the 14 valid events were written to stdout (the 3 refused ones were not)', `got ${frames.length}`);
ok(written.length === 17 && written.slice(0, 14).every(Boolean) && written.slice(14).every((w) => w === false), 'emit() returns true for valid events and false for the 3 refused ones', JSON.stringify(written));
ok(frames.every((f) => f.jsonrpc === '2.0' && f.method === 'event' && !('id' in f) && Object.keys(f.params).sort().join() === 'channel,payload'), 'every frame is a JSON-RPC notification { method:"event", params:{ channel, payload } }');
ok(same(frames.map((f) => f.params.channel), events.map((e) => e.channel)), 'frames keep the emit order');
ok(!child.stderr.includes(SECRET) && !child.stdout.includes(SECRET), 'the payload text of a refused event is never logged or written');
ok(/bad channel name/.test(child.stderr) && /not JSON/.test(child.stderr) && new RegExp(`payload \\d+ bytes > ${MAX_EVENT_PAYLOAD_BYTES}`).test(child.stderr), 'refusals are logged by reason (channel/size only)');
ok(JSON.stringify(eventFrame('speech:say', undefined)) === '{"jsonrpc":"2.0","method":"event","params":{"channel":"speech:say","payload":null}}', 'a missing payload is sent as null');

// ---- 2/3. the shim side ----
function newShim() {
  const listeners = new Map(); // channel -> [handler]
  const invokes = [];
  const pendingRejects = [];
  const errors = [];
  const win = {
    __TAURI__: {
      core: { invoke: (cmd, p) => { invokes.push({ cmd, ...p }); return new Promise((_, reject) => pendingRejects.push(reject)); } },
      event: {
        listen: (channel, handler) => {
          const entry = { handler, live: true };
          if (!listeners.has(channel)) listeners.set(channel, []);
          listeners.get(channel).push(entry);
          return Promise.resolve(() => { entry.live = false; });
        },
      },
    },
    console: { error: (...a) => errors.push(a) },
    CustomEvent,
    dispatchEvent: () => true,
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'tauri', 'shim', 'zumi-shim.js'), 'utf8'), { window: win, Promise, URL, console }, { filename: 'zumi-shim.js' });
  // The host: a Tauri event reaches every still-registered listener of its channel, in order.
  const host = (channel, payload) => { for (const l of listeners.get(channel) || []) if (l.live) l.handler({ payload }); };
  const leaf = (name) => name.split('.').reduce((o, k) => o[k], win.zumi);
  return { win, host, leaf, invokes, pendingRejects, errors };
}
const tick = () => new Promise((r) => setTimeout(r, 15));

// The relay: what the Rust host does with a frame is validate then emit params.channel / params.payload.
const relay = (host, frame) => host(frame.params.channel, frame.params.payload);

{
  const shim = newShim();
  const got = new Map();
  for (const e of events) {
    const c = CASES[e.channel];
    const seen = [];
    got.set(e.channel, seen);
    shim.leaf(c.name)(...c.args, (...a) => { seen.push(a.length === 1 ? a[0] : a); });
  }
  await tick(); // listen() resolves asynchronously
  for (const f of frames) relay(shim.host, f);
  await tick();
  for (const e of events) {
    const c = CASES[e.channel];
    ok(same(got.get(e.channel), c.expect), `${e.channel} -> ${c.name} callback shape matches the Electron preload`, `${JSON.stringify(got.get(e.channel))} vs ${JSON.stringify(c.expect)}`);
  }
}

// One payload per sequence number, changing a field the callback can see, so order is observable.
const SEQ = {
  'talk:replyMore': (p, n) => ({ ...p, text: p.text + n }),
  'talk:replyDone': (p, n) => ({ ...p, reply: p.reply + n }),
  'talk:checkDone': (p, n) => ({ ...p, text: p.text + n }),
  'talk:ttsMore': (p, n) => ({ ...p, audio: { ...p.audio, data: p.audio.data + n } }),
  'gesture:play': (p, n) => ({ ...p, command: p.command + n }),
};
const withSeq = (channel, p, n) => (SEQ[channel] ? SEQ[channel](p, n) : p && typeof p === 'object' ? { ...p, seq: n } : p);
for (const e of events) {
  const c = CASES[e.channel];
  const collect = (shim, into) => shim.leaf(c.name)(...c.args, (...x) => into.push(x.length === 1 ? x[0] : x));
  const payloads = [0, 1, 2].map((n) => withSeq(e.channel, c.payload, n));
  // reference: each payload alone into a fresh subscription (the callback shape is pinned by CASES above)
  const reference = [];
  for (const p of payloads) {
    const one = newShim();
    const seen = [];
    collect(one, seen);
    await tick();
    one.host(e.channel, p);
    await tick();
    reference.push(...seen);
  }
  const shim = newShim();
  const a = [];
  const b = [];
  const offA = collect(shim, a);
  collect(shim, b);
  await tick();
  for (const p of payloads) shim.host(e.channel, p);
  await tick();
  ok(same(a, reference) && a.length === 3, `${e.channel}: three payloads arrive in order, one callback call each`, `${JSON.stringify(a)} vs ${JSON.stringify(reference)}`);
  if (!SEQ[e.channel] && typeof c.payload === 'object') {
    ok(same(a, payloads), `${e.channel}: a passthrough payload arrives byte-equal`, JSON.stringify(a));
  }
  ok(same(a, b), `${e.channel}: a second subscription gets its own single delivery (no double delivery)`, `a=${a.length} b=${b.length}`);
  offA();
  shim.host(e.channel, payloads[0]);
  await tick();
  ok(a.length === 3 && b.length === 4, `${e.channel}: unsubscribe stops delivery, the other subscriber continues`, `a=${a.length} b=${b.length}`);
  if (c.dropped !== undefined) {
    const before = b.length;
    shim.host(e.channel, c.dropped);
    ok(b.length === before, `${e.channel}: a payload the preload filters out is dropped`);
  }
}

{
  // gesture:play is special: the handler's result goes back on gesture:result, once per request.
  const shim = newShim();
  shim.leaf('onGesture')(() => ({ ok: true }));
  await tick();
  shim.host('gesture:play', { reqId: 11, command: 'nod' });
  await tick();
  const back = shim.invokes.filter((i) => i.method === 'gesture:result');
  ok(back.length === 1 && back[0].args[0] === 11 && back[0].args[1].ok === true, 'gesture:play answers once on gesture:result');
  // unknown channel: nothing in the shim listens on it
  const shim2 = newShim();
  const seen = [];
  shim2.leaf('talk.onSay')((l) => seen.push(l));
  await tick();
  shim2.host('speech:unknown', { sayId: 'x' });
  ok(seen.length === 0, 'an event on a channel nobody subscribed to reaches no listener');
}

// ---- 4. the sidecar dies mid-stream ----
{
  const shim = newShim();
  const more = [];
  const done = [];
  const doneOther = [];
  const closed = [];
  const say = [];
  shim.leaf('talk.onReplyMore')('t1', (t) => more.push(t));
  shim.leaf('talk.onReplyDone')('t1', (r) => done.push(r));
  shim.leaf('talk.onReplyDone')('t2', (r) => doneOther.push(r));
  const offClosed = shim.leaf('talk.onReplyDone')('t3', (r) => closed.push(r));
  shim.leaf('talk.onSay')((l) => say.push(l));
  await tick();
  shim.host('talk:replyDone', { turnId: 't2', ok: true, reply: 'finished before the crash' });
  offClosed(); // the renderer unsubscribed t3 (its turn ended) before the crash

  // Two rpc calls are in flight when the host rejects them with sidecar_exited (events.rs/lib.rs pins that).
  const calls = [shim.leaf('ui.getLang')(), shim.leaf('roles.get')()];
  const settled = Promise.allSettled(calls);
  for (const reject of shim.pendingRejects) reject('sidecar_exited'); // Tauri rejects with the Rust Err string
  const results = await settled;
  ok(results.every((r) => r.status === 'rejected' && r.reason && r.reason.message === 'sidecar_exited'), 'every pending rpc call rejects with an Error "sidecar_exited" (none hangs)', JSON.stringify(results.map((r) => r.status)));

  // The host emits ONE sidecar:error for the exit.
  shim.host('sidecar:error', { message: 'the app sidecar stopped; restarting', fatal: false, restarts: 1, reason: 'sidecar_exited' });
  await tick();
  ok(done.length === 1 && same(done[0], { ok: false, reply: '', error: 'sidecar_exited', sources: [] }), 'the open reply stream ends once with { ok:false, error:"sidecar_exited" } (the renderer\'s failure path)', JSON.stringify(done));
  ok(doneOther.length === 1 && doneOther[0].ok === true, 'a stream that already finished is not failed again');
  ok(closed.length === 0, 'an unsubscribed stream gets nothing');
  ok(more.length === 0 && say.length === 0, 'other event kinds are not fabricated on death');
  ok(shim.errors.length >= 1, 'the error is still written to console.error and surfaced as zumi:sidecar-error');

  // A second sidecar:error (e.g. the restart also failed) does not fail the stream again.
  shim.host('sidecar:error', { message: 'x', fatal: true, restarts: 5 });
  await tick();
  ok(done.length === 1, 'a second sidecar:error does not deliver the failure twice');
}

// ---- 5. Rust <-> Node contract ----
{
  const rs = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'events.rs'), 'utf8');
  const lib = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'lib.rs'), 'utf8').replace(/\r\n/g, '\n');
  const limit = rs.match(/pub const MAX_EVENT_PAYLOAD_BYTES: usize = (\d+) \* 1024;/);
  ok(Boolean(limit) && Number(limit[1]) * 1024 === MAX_EVENT_PAYLOAD_BYTES, 'events.rs and protocol.mjs agree on MAX_EVENT_PAYLOAD_BYTES', limit ? `${limit[1]} KiB vs ${MAX_EVENT_PAYLOAD_BYTES}` : 'constant not found');
  ok(MAX_EVENT_PAYLOAD_BYTES < 1_000_000, 'the payload limit is below the 1 MB frame limit (one oversize event must not be a fatal frame)');
  ok(/sink\.emit_to_label\(MAIN_LABEL, event\.channel/.test(rs), 'forward() addresses MAIN_LABEL only');
  ok(/Some\("event"\) => \{[\s\S]*?events::forward\(app,/.test(lib), 'lib.rs routes the sidecar "event" notification to events::forward');
  ok(/fn serving_with\(&self, pending: &Pending\) -> bool \{\s*pending\.ready/.test(lib) && /if rpc\.serving\(\) \{\s*forward\(params\);/.test(lib) && /let _ = events::forward\(app, params\)/.test(lib), 'no event is forwarded before the versioned handshake (and the main guard): route_event gates on serving()');
  ok(/rpc\.fail_pending\("sidecar_exited"\);[\s\S]*?exit_payload\(fatal, restarts\)/.test(lib), 'on exit the host rejects pending calls with sidecar_exited, then emits the exit event');
  const code = [lib, rs].join('\n').split('\n').map((l) => l.split('//')[0]).join('\n').replace(/mod tests \{[\s\S]*$/, '');
  ok(!/\.emit\(/.test(code), 'no broadcast .emit( in the host (everything goes to the main webview by label)');
  ok(/"jsonrpc":"2.0","method":"event","params":\{"channel":"speech:say","payload":\{"sayId":"s1","text":"hi"\}\}/.test(rs), 'events.rs pins the same golden frame protocol.mjs produces');
  ok(JSON.stringify(eventFrame('speech:say', { sayId: 's1', text: 'hi' })) === '{"jsonrpc":"2.0","method":"event","params":{"channel":"speech:say","payload":{"sayId":"s1","text":"hi"}}}', 'protocol.mjs produces the golden frame');
  const main = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), 'utf8');
  ok(/createEmitter\(writeLine,/.test(main) && /ctx = \{[^}]*\bemit\b/.test(main), 'main.mjs wires ctx.emit to the framed stdout writer');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
