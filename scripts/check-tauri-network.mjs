// T-31 parity step 6 (network half): provider calls + talk.turn streaming over the sidecar event path.
// Gate: GATE-step6-hosts.md conditions 5-9. Plain Node, no app, no network beyond the loopback SSE fixture.
//
// The fixture host rewrite lives ONLY here (a test file), as the base fetch BELOW the guard: the guard is exercised on
// the real provider origin, and production code (tauri/sidecar/) has no URL override. One test proves the production
// guard refuses the fixture's loopback origin directly.
//
//   node scripts/check-tauri-network.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { startFakeLlm } from './fake-llm-sse.mjs';
import { guardedFetch, cloudFetch, mirrorFetch, jevFetch, PROVIDER_ORIGINS } from '../tauri/sidecar/egress.mjs';
import { createAiSettings } from '../tauri/sidecar/ai-settings.mjs';
import { createAiCore } from '../tauri/sidecar/ai-core.mjs';
import { createChatHost } from '../tauri/sidecar/chat-host.mjs';
import { createSecretStores } from '../tauri/sidecar/secret-stores.mjs';
import { MAX_EVENT_PAYLOAD_BYTES } from '../tauri/sidecar/protocol.mjs';
import { FLAVOURS } from '../tauri/sidecar/flavour.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const loopback = require('./fixtures/fetch-to-loopback.cjs');
const { createKeyStore } = require('../src/main/reflex-jev.js');
const prov = require('../src/main/providers.js');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP_ROOT, 'net-'));
let dirN = 0;
const freshDir = () => { const d = path.join(work, `d${++dirN}`); fs.mkdirSync(d, { recursive: true }); return d; };
const settingsStore = (dir) => {
  const file = path.join(dir, 'settings.json');
  const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const set = (patch) => { const next = { ...get(), ...patch }; fs.writeFileSync(file, JSON.stringify(next, null, 2)); return next; };
  return { get, set };
};
const fakeSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'),
});
const PUBLIC = { values: FLAVOURS.public };
const turnId = (n) => n.toString(16).padStart(32, '0');
const waitEvent = (events, tid, channel, ms = 8000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const e = events.find((x) => x.channel === channel && x.payload && x.payload.turnId === tid);
    if (e) return resolve(e);
    if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting ${channel} ${tid}`));
    setTimeout(tick, 5);
  };
  tick();
});
const writes = (events, tid, channel) => events.filter((x) => x.channel === channel && x.payload && x.payload.turnId === tid);

// A host whose provider fetch is `baseFetch` (already below the guard), plus the recorded egress log.
function makeHost({ dir = freshDir(), fetchBase, flavour = PUBLIC, initial = null } = {}) {
  const st = settingsStore(dir);
  if (initial) st.set(initial);
  const safeStorage = fakeSafeStorage();
  const events = [];
  const logs = [];
  let host = null;
  const ai = createAiSettings({ dataDir: dir, settings: st.get, saveSettings: st.set, onChange: () => { if (host) host.rebuild(); } });
  ai.pin();
  const secretStores = async () => createSecretStores({ safeStorage, dataDir: dir });
  const log = (m) => logs.push(m);
  const egressLog = (m) => { logs.push(m); };
  const reflexEgress = flavour.values.reflexEgress === true;
  const aiCore = createAiCore({ ai, secretStores, dataDir: dir, log, reflexEgress, jevFetch: jevFetch(fetchBase, reflexEgress, egressLog) });
  host = createChatHost({
    dataDir: dir, settings: st.get, saveSettings: st.set, ai, secretStores, safeStorage, flavour, aiCore, log,
    emit: (channel, payload) => { events.push({ channel, payload }); return true; },
    egress: {
      provider: guardedFetch(fetchBase, PROVIDER_ORIGINS, egressLog),
      cloud: cloudFetch(fetchBase, flavour.values.cloudBase, egressLog),
      mirror: mirrorFetch(fetchBase, flavour.values.boardMirror, egressLog),
    },
  });
  return { host, ai, aiCore, st, dir, safeStorage, events, logs, fetchBase };
}
const writeKey = (h, key, providerId = 'openrouter') => {
  const p = prov.PROVIDERS[providerId];
  return createKeyStore({ safeStorage: h.safeStorage, dir: h.dir, name: p.keyName, shape: p.keyShape }).write(key);
};
const OPENROUTER_KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789';
const GROQ_KEY = 'gsk_abcdefghijklmnopqrstu';
const OPENCODE_KEY = 'oc_sk_abcdefghijklmnopqrstu';

// The fixture below the guard: the guard sees the provider URL; the base fetch rewrites it to 127.0.0.1.
const rewriteBase = (to, record) => async (url, init) => {
  record.push({ from: url, to: loopback.rewrite(url, to), body: init && init.body });
  return fetch(loopback.rewrite(url, to), init);
};

// ------------------------------------------------------------------ 1. provider calls (keys, key tests, roles)
{
  const fake = await startFakeLlm({ firstMs: 1, intervalMs: 1, chunkChars: 8, text: 'fixture model list and key checks', log: () => {} });
  try {
    const rec = [];
    const h = makeHost({ fetchBase: rewriteBase(new URL(fake.url), rec), initial: { aiProvider: 'openrouter' } });
    const saved = await h.host.handlers['brainKey.save'](OPENROUTER_KEY, false);
    ok(saved.ok === true && saved.check === 'works' && saved.saved === true, 'brainKey.save stores a key only after the provider key test answers 200', stable(saved));
    ok(rec.some((r) => r.from === prov.PROVIDERS.openrouter.keyTest.url && r.to.startsWith(fake.url)), 'the key test reached the real provider URL, rewritten only below the guard', stable(rec[0] || {}));
    const tested = await h.host.handlers['ai.testKey'](OPENROUTER_KEY);
    ok(tested.ok === true && tested.check === 'works', 'ai.testKey answers works against the fixture key-test route', stable(tested));
    const again = await h.host.handlers['brainKey.test']();
    ok(again.ok === true && again.check === 'works', 'brainKey.test re-checks the stored key', stable(again));
    ok((await h.host.handlers['ai.testKey']('not-a-key')).error === 'bad_format', 'ai.testKey refuses a malformed key before any network');

    const st = h.host.handlers['talk.status']();
    ok(st.enabled === true && st.mode === 'byo' && st.provider === 'OpenRouter' && typeof st.model === 'string', 'talk.status answers the chat brain first when a key exists', stable(st));
    ok(stable(h.host.handlers['talk.brainInfo']()) === stable({ provider: st.provider, model: st.model }), 'talk.brainInfo answers { provider, model } only', stable(h.host.handlers['talk.brainInfo']()));

    const rv = await h.host.handlers['roles.get']();
    ok(rv.provider && rv.provider.label === 'OpenRouter' && rv.roles && typeof rv.roles.do === 'object' && rv.wired, 'roles.get (F7) answers the real roles view once a key exists', stable(rv).slice(0, 160));
    const set = await h.host.handlers['roles.set']('plan', { model: 'openai/gpt-oss-120b', effort: 'low' });
    ok(set.ok === true && set.roles.plan.by === 'user' && set.roles.plan.model === 'openai/gpt-oss-120b', 'roles.set stores a valid choice and re-reads the view', stable(set).slice(0, 160));
    const off = await h.host.handlers['roles.setOn']('check', false);
    ok(off.ok === true && off.roles.check.on === false, 'roles.setOn(false) switches Check off', stable(off).slice(0, 160));
    const reset = await h.host.handlers['roles.reset']('plan');
    ok(reset.ok === true && reset.roles.plan.by === 'default', 'roles.reset removes the choice (back to the default)', stable(reset).slice(0, 160));
    ok((await h.host.handlers['roles.set']('nope', { model: 'x/y', effort: 'low' })).error === 'not_available', 'roles.set refuses a role that drives no step');
    const models = await h.host.handlers['roles.models']();
    ok(models.ok === true && Array.isArray(models.models), 'roles.models answers the provider list', stable(models).slice(0, 120));

    // No key -> the honest null/off shapes (also the greyscale golden).
    const empty = makeHost({ fetchBase: rewriteBase(new URL(fake.url), []) });
    const emptyRoles = await empty.host.handlers['roles.get']();
    ok(stable(emptyRoles) === '{"provider":null}', 'roles.get without a key is { provider: null }', stable(emptyRoles));
    ok(stable(empty.ai.providerInfo()) === stable({ id: 'gemini', label: 'Google Gemini', mode: 'free' }), 'ai.provider golden: { id, label, mode } (pinned default)', stable(empty.ai.providerInfo()));
    ok(stable(empty.host.handlers['talk.status']()) === stable({ enabled: false, mode: 'off', reason: 'this build has no talk server configured' }), 'talk.status golden without a key and without cloudBase', stable(empty.host.handlers['talk.status']()));
    ok(empty.host.handlers['talk.brainInfo']() === null, 'talk.brainInfo without a key is null');
    const g = empty.host.handlers['talk.gesture']({ turnId: turnId(1), intent: 'agree', brief: 'agree', energy: 'mid', deixis: 'none', targetMs: 2000, rigVersion: '0123456789abcdef' });
    const gv = await g;
    ok(gv && gv.ok === false && gv.error && gv.error.code === 'talk_off', 'talk.gesture goes through cloud and answers talk_off without a cloud base', stable(gv).slice(0, 120));
  } finally { await fake.close(); }
}

// ------------------------------------------------------------------ 2. streaming: head, replyMore*, replyDone
const FIXTURE_TEXT = 'Sure, I can help with that. This fixed reply streams at a steady pace so the first words can be timed.';
{
  const fake = await startFakeLlm({ firstMs: 2, intervalMs: 1, chunkChars: 8, text: FIXTURE_TEXT, log: () => {} });
  try {
    const rec = [];
    const h = makeHost({ fetchBase: rewriteBase(new URL(fake.url), rec), initial: { aiProvider: 'openrouter' } });
    writeKey(h, OPENROUTER_KEY);
    h.st.set({ roleModels: { off: ['plan', 'check', 'lookup'] } });
    const id = turnId(10);
    const head = await h.host.handlers['talk.turn']({ turnId: id, message: 'hello', history: [] });
    ok(head && head.ok === true && head.streaming === true && typeof head.reply === 'string' && head.reply.length > 0, 'talk.turn resolves the head at the first speakable clause', stable(head).slice(0, 180));
    ok(/^https:\/\/openrouter\.ai\//.test(rec[0].from) && rec[0].to.startsWith(fake.url), 'the guard saw the real provider origin; the fixture rewrite sits below it', `${rec[0].from} -> ${rec[0].to}`);
    const done = await waitEvent(h.events, id, 'talk:replyDone');
    const more = writes(h.events, id, 'talk:replyMore');
    ok(more.length >= 1, 'at least one talk:replyMore precedes the end', String(more.length));
    const moreIndex = h.events.findIndex((x) => x.channel === 'talk:replyMore' && x.payload.turnId === id);
    const doneIndex = h.events.findIndex((x) => x.channel === 'talk:replyDone' && x.payload.turnId === id);
    ok(moreIndex >= 0 && moreIndex < doneIndex, 'stream order: head, replyMore*, replyDone', `${moreIndex} < ${doneIndex}`);
    ok(done.payload.ok === true && done.payload.reply === FIXTURE_TEXT.trim() && Array.isArray(done.payload.sources) && done.payload.error === null, 'talk:replyDone carries the final reply and no error', stable(done.payload).slice(0, 180));
    ok(!h.events.some((x) => x.channel === 'talk:checkDone' && x.payload.turnId === id), 'Check off: no talk:checkDone');
    ok(h.logs.some((l) => /^egress https:\/\/openrouter\.ai 200$/.test(l)), 'the egress log line is egress <origin> <status>', h.logs.filter((l) => l.startsWith('egress')).join(' | '));
  } finally { await fake.close(); }
}

// ------------------------------------------------------------------ 3. a second turn never lands under the first turnId
{
  const fake = await startFakeLlm({ firstMs: 2, intervalMs: 2, chunkChars: 8, text: 'a reply that is long enough to overlap another turn while it streams along', log: () => {} });
  try {
    const h = makeHost({ fetchBase: rewriteBase(new URL(fake.url), []), initial: { aiProvider: 'openrouter' } });
    writeKey(h, OPENROUTER_KEY);
    h.st.set({ roleModels: { off: ['plan', 'check', 'lookup'] } });
    const a = turnId(21); const b = turnId(22);
    const [ha, hb] = await Promise.all([
      h.host.handlers['talk.turn']({ turnId: a, message: 'turn A', history: [] }),
      h.host.handlers['talk.turn']({ turnId: b, message: 'turn B', history: [] }),
    ]);
    ok(ha.ok && hb.ok, 'two turns stream concurrently, each with its own head');
    const [da, db] = await Promise.all([waitEvent(h.events, a, 'talk:replyDone'), waitEvent(h.events, b, 'talk:replyDone')]);
    ok(da && db && writes(h.events, a, 'talk:replyDone').length === 1 && writes(h.events, b, 'talk:replyDone').length === 1, 'each turn ends exactly once, under its own turnId');
    const bad = h.events.filter((x) => x.payload && x.payload.turnId && x.payload.turnId !== a && x.payload.turnId !== b);
    ok(bad.length === 0, 'no event carries a turnId that was never requested', stable(bad[0] || {}));
  } finally { await fake.close(); }
}

// ------------------------------------------------------------------ 4. setMode / setProvider change the next request body
{
  const fake = await startFakeLlm({ firstMs: 1, intervalMs: 1, chunkChars: 8, text: 'mode and provider switch reply', log: () => {} });
  try {
    const rec = [];
    const h = makeHost({ fetchBase: rewriteBase(new URL(fake.url), rec), initial: { aiProvider: 'openrouter' } });
    writeKey(h, OPENROUTER_KEY);
    h.st.set({ roleModels: { off: ['plan', 'check', 'lookup'] }, chatModel: 'openai/gpt-oss-120b' });
    const bodyOf = () => JSON.parse(rec.filter((r) => r.body).at(-1).body);
    h.ai.setMode('free'); h.host.rebuild();
    await h.host.handlers['talk.turn']({ turnId: turnId(31), message: 'free', history: [] });
    ok(bodyOf().model === prov.PROVIDERS.openrouter.models.do, 'free mode sends the provider table Do id', bodyOf().model);
    h.ai.setMode('byok'); h.host.rebuild();
    await h.host.handlers['talk.turn']({ turnId: turnId(32), message: 'byok', history: [] });
    ok(bodyOf().model === 'openai/gpt-oss-120b', 'byok mode sends settings.chatModel on the next request', bodyOf().model);
    writeKey(h, GROQ_KEY, 'groq');
    h.ai.setProvider('groq'); h.host.rebuild();
    await h.host.handlers['talk.turn']({ turnId: turnId(33), message: 'groq', history: [] });
    const last = rec.filter((r) => r.from.includes('api.groq.com')).at(-1);
    ok(last && bodyOf().model === prov.PROVIDERS.groq.models.do, 'setProvider moves the next request to the new provider host and its Do model', last && bodyOf().model);
    ok(rec.some((r) => r.from.startsWith('https://api.groq.com/')), 'the groq request went to api.groq.com through the guard', last && last.from);
  } finally { await fake.close(); }
}

// ------------------------------------------------------------------ 5. Check runs after the reply (checkDone)
{
  const line = 'This reply is long enough for the Check role to run. '.repeat(12); // > 400 chars
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const checkFetch = async (url, init) => {
    const body = JSON.parse(String(init.body || '{}'));
    if (!body.stream) {
      const system = String(body.messages[0].content);
      if (system.startsWith('You review')) return { ok: true, status: 200, json: async () => ({ provider: 'Stub', choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }) };
      return { ok: true, status: 200, json: async () => ({ provider: 'Stub', choices: [{ message: { content: 'stub' } }], usage: null }) };
    }
    return {
      ok: true, status: 200,
      body: (async function* () { for (const p of line.match(/[\s\S]{1,12}/g)) yield sse({ provider: 'Stub', choices: [{ delta: { content: p } }] }); yield sse({ provider: 'Stub', choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 } }); yield 'data: [DONE]\n\n'; })(),
    };
  };
  const h = makeHost({ fetchBase: checkFetch, initial: { aiProvider: 'openrouter' } });
  writeKey(h, OPENROUTER_KEY);
  h.st.set({ roleModels: { off: ['plan', 'lookup'] } });
  const id = turnId(41);
  const head = await h.host.handlers['talk.turn']({ turnId: id, message: 'check this reply for me', history: [] });
  const done = await waitEvent(h.events, id, 'talk:replyDone');
  const c = await waitEvent(h.events, id, 'talk:checkDone');
  const doneIdx = h.events.indexOf(done); const chkIdx = h.events.indexOf(c);
  ok(head.ok === true && c.payload.verdict === 'ok' && chkIdx > doneIdx, 'talk:checkDone follows talk:replyDone when Check runs', `${doneIdx} < ${chkIdx} ${stable(c.payload)}`);
}

// ------------------------------------------------------------------ 6. 429 quota and OpenCode 402 credit (provider-named)
{
  const status = (code) => async () => ({ ok: false, status: code, text: async () => '' });
  {
    const h = makeHost({ fetchBase: status(429), initial: { aiProvider: 'openrouter' } });
    writeKey(h, OPENROUTER_KEY);
    h.st.set({ roleModels: { off: ['plan', 'check', 'lookup'] } });
    const head = await h.host.handlers['talk.turn']({ turnId: turnId(51), message: 'q', history: [] });
    ok(head.ok === false && head.error.code === 'quota' && head.error.provider === 'OpenRouter' && head.error.free === false, 'a 429 becomes the provider-named quota error (OpenRouter: not free)', stable(head.error));
  }
  {
    const h = makeHost({ fetchBase: status(402), initial: { aiProvider: 'openrouter' } });
    h.ai.setProvider('opencode');
    writeKey(h, OPENCODE_KEY, 'opencode');
    h.st.set({ roleModels: { off: ['plan', 'check', 'lookup'] } });
    const head = await h.host.handlers['talk.turn']({ turnId: turnId(52), message: 'c', history: [] });
    ok(head.ok === false && head.error.code === 'credit' && head.error.provider === 'OpenCode', 'an OpenCode 402 becomes the credit error (top up), provider-named', stable(head.error));
  }
}

// ------------------------------------------------------------------ 7. a stream that breaks after the first clause keeps what was said
{
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const breakFetch = async () => ({
    ok: true, status: 200,
    body: (async function* () {
      yield sse({ provider: 'Stub', choices: [{ delta: { content: 'The reply starts here and then the connection dies. ' } }] });
      // ends without a stop chunk and without [DONE] -> stream_cut
    })(),
  });
  const h = makeHost({ fetchBase: breakFetch, initial: { aiProvider: 'openrouter' } });
  writeKey(h, OPENROUTER_KEY);
  h.st.set({ roleModels: { off: ['plan', 'check', 'lookup'] } });
  const id = turnId(61);
  const head = await h.host.handlers['talk.turn']({ turnId: id, message: 'break', history: [] });
  const done = await waitEvent(h.events, id, 'talk:replyDone');
  ok(head.ok === true && done.payload.ok === false && done.payload.error === 'stream_cut' && done.payload.reply.length > 0, 'a stream that breaks after the first clause ends replyDone ok:false with the text already said', stable(done.payload).slice(0, 160));
}

// ------------------------------------------------------------------ 8. event caps with the longest fixture reply
{
  const long = 'Zumi streams a long deterministic reply for the event-size check. '.repeat(90); // ~5.6 KB
  const fake = await startFakeLlm({ firstMs: 1, intervalMs: 1, chunkChars: 32, text: long, log: () => {} });
  try {
    const h = makeHost({ fetchBase: rewriteBase(new URL(fake.url), []), initial: { aiProvider: 'openrouter' } });
    writeKey(h, OPENROUTER_KEY);
    h.st.set({ roleModels: { off: ['plan', 'lookup'] } }); // Check ON: the third event is measured too
    const id = turnId(71);
    await h.host.handlers['talk.turn']({ turnId: id, message: 'long', history: [] });
    const done = await waitEvent(h.events, id, 'talk:replyDone', 15000);
    const check = await waitEvent(h.events, id, 'talk:checkDone', 15000);
    const sizes = [done, check, ...writes(h.events, id, 'talk:replyMore')].map((e) => Buffer.byteLength(JSON.stringify(e.payload)));
    const max = Math.max(...sizes);
    ok(max < MAX_EVENT_PAYLOAD_BYTES, `every replyMore/replyDone/checkDone payload is under MAX_EVENT_PAYLOAD_BYTES (max ${max} of ${MAX_EVENT_PAYLOAD_BYTES})`);
    ok(done.payload.reply.length >= 3900, 'the long reply arrived whole (chat-brain caps at 4000 chars)');
  } finally { await fake.close(); }
}

// ------------------------------------------------------------------ 9. sentinel key: no reply, event, log or file but its blob
{
  const BODY = 'SENTINELbodyKEYmaterial0123456789';
  const KEY = `sk-or-v1-${BODY}wxyz`;
  let keySeen = false;
  // A provider that echoes the key in its error body AND in a streamed reply.
  const echoFetch = async (url, init) => {
    const body = JSON.parse(String(init.body || '{}'));
    if (!body.stream) return { ok: false, status: 500, text: async () => `{"error":"${KEY}"}` };
    keySeen = true;
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    return {
      ok: true, status: 200,
      body: (async function* () {
        for (const p of [`The key is ${KEY}`, ' and that is all.']) yield sse({ provider: 'Echo', choices: [{ delta: { content: p } }] });
        yield sse({ provider: 'Echo', choices: [{ delta: {} }], usage: null });
        yield 'data: [DONE]\n\n';
      })(),
    };
  };
  const h = makeHost({ fetchBase: echoFetch, initial: { aiProvider: 'openrouter' } });
  // A failing provider call whose error body echoes the key: the reply error must be the scrubbed code only.
  writeKey(h, KEY);
  h.st.set({ roleModels: { off: ['plan', 'check', 'lookup'] } });
  const failHead = await h.host.handlers['talk.turn']({ turnId: turnId(81), message: 'fail', history: [] });
  // The echo above is a stream, so make a separate host whose fetch fails non-streamed before the first clause.
  const failOnly = makeHost({ fetchBase: async () => ({ ok: false, status: 500, text: async () => `{"error":"${KEY}"}` }), initial: { aiProvider: 'openrouter' } });
  writeKey(failOnly, KEY); failOnly.st.set({ roleModels: { off: ['plan', 'check', 'lookup'] } });
  const errHead = await failOnly.host.handlers['talk.turn']({ turnId: turnId(82), message: 'fail2', history: [] });
  ok(errHead.ok === false && errHead.error.message === 'http_500' && !JSON.stringify(errHead).includes(BODY), 'a failing provider call whose error body echoes the key answers the scrubbed code only', stable(errHead.error));
  ok(keySeen, 'fixture: the streamed reply really echoed the key');

  const done = await waitEvent(h.events, turnId(81), 'talk:replyDone');
  const all = [...h.events.map((e) => JSON.stringify(e)), ...h.logs, JSON.stringify(failHead), JSON.stringify(errHead), JSON.stringify(done)];
  ok(!all.join('\n').includes(BODY), 'the sentinel key appears in no rpc result, event or log line (replyMore/replyDone/checkDone, egress included)');
  ok(!done.payload.reply.includes(BODY) && done.payload.reply.includes('***'), 'the streamed reply is redacted before it leaves the sidecar', done.payload.reply.slice(0, 80));

  // The key-store path: save/test store it, and no result carries it.
  const saved = await h.host.handlers['brainKey.save'](KEY, false); // echoFetch answers 500 -> unreachable -> needs confirm
  const confirmed = await h.host.handlers['brainKey.save'](KEY, true);
  ok(saved.ok === false && saved.needsConfirm === true && !JSON.stringify(saved).includes(BODY), 'save without confirmation keeps an unverified key out and leaks nothing', stable(saved).slice(0, 140));
  ok(confirmed.ok === true && !JSON.stringify(confirmed).includes(BODY), 'an explicitly confirmed save answers status only (never the key)', stable(confirmed));
  const tested = await h.host.handlers['ai.testKey'](KEY);
  ok(!JSON.stringify(tested).includes(BODY), 'ai.testKey answer carries no key material');
  const bt = await h.host.handlers['brainKey.test']();
  ok(!JSON.stringify(bt).includes(BODY), 'brainKey.test answer carries no key material');

  const files = fs.readdirSync(h.dir).filter((f) => fs.statSync(path.join(h.dir, f)).isFile());
  const leaks = files.filter((f) => f !== 'jev-key.bin' && fs.readFileSync(path.join(h.dir, f)).includes(Buffer.from(BODY)));
  ok(leaks.length === 0, 'the sentinel body is in no data-dir file but its encrypted blob', leaks.join(','));
  ok(files.includes('jev-key.bin'), 'the encrypted blob does exist under its Electron file name');
}

// ------------------------------------------------------------------ 9b. sentinel in the three stream events, Check on
{
  const BODY = 'SENTINELEVENTSkeymaterial0123456789';
  const KEY = `sk-or-v1-${BODY}wxyz`;
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  // The streamed reply echoes the key; the Check role's own answer echoes it as well (a correction), so both the
  // replyMore/replyDone path and the checkDone path must be redacted. Non-stream = the Check call only.
  const echoAll = async (url, init) => {
    const body = JSON.parse(String(init.body || '{}'));
    if (!body.stream) {
      return { ok: true, status: 200, json: async () => ({ provider: 'Echo', choices: [{ message: { content: `Correction: the key is ${KEY}` } }], usage: null }) };
    }
    return {
      ok: true, status: 200,
      body: (async function* () {
        for (const p of [`The key is ${KEY}`, ' and that is all.']) yield sse({ provider: 'Echo', choices: [{ delta: { content: p } }] });
        yield sse({ provider: 'Echo', choices: [{ delta: {} }], usage: null });
        yield 'data: [DONE]\n\n';
      })(),
    };
  };
  const h = makeHost({ fetchBase: echoAll, initial: { aiProvider: 'openrouter' } });
  writeKey(h, KEY);
  h.st.set({ roleModels: { off: ['plan', 'lookup'] } }); // Check on: the third event must be exercised
  const id = turnId(91);
  await h.host.handlers['talk.turn']({ turnId: id, message: 'check this reply for me', history: [] });
  const done = await waitEvent(h.events, id, 'talk:replyDone');
  let check = null;
  try { check = await waitEvent(h.events, id, 'talk:checkDone'); } catch { /* asserted below */ }
  const more = writes(h.events, id, 'talk:replyMore');
  const three = [...more, done, check].filter(Boolean).map((e) => JSON.stringify(e));
  ok(more.length >= 1 && check && check.payload.verdict === 'fix', 'a turn with a key-echoing reply streams replyMore, replyDone and checkDone', `${more.length} replyMore, check=${check && check.payload.verdict}`);
  ok(three.length >= 3 && !three.join('\n').includes(BODY), 'no stream event (replyMore/replyDone/checkDone) carries the sentinel key');
  ok(done.payload.reply.includes('***') && check && check.payload.text.includes('***'), 'replyDone and checkDone text are redacted before they leave the sidecar', `${done.payload.reply} | ${check && check.payload.text}`);
  ok(h.logs.every((l) => !String(l).includes(BODY)), 'the sidecar log lines of this turn carry no key');
  const egressLines = h.logs.filter((l) => String(l).startsWith('egress'));
  ok(egressLines.length >= 1 && egressLines.every((l) => !String(l).includes(BODY)), 'the egress log line never carries the sentinel', egressLines.join(' | '));
}

// ------------------------------------------------------------------ 10. Jev egress behind flavour.reflexEgress
{
  const calls = [];
  const jevReply = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ answers: { reaction: { choice: 'happy', confidence: 0.93 } }, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) };
  };
  // Off (public flavour): no key is read and no fetch is made.
  const off = makeHost({ fetchBase: jevReply, initial: { aiProvider: 'openrouter' } });
  writeKey(off, OPENROUTER_KEY);
  const rOff = await off.aiCore.reflexClassify('thanks a lot!');
  ok(calls.length === 0 && rOff.source !== 'jev', 'reflexJev.classify with egress off never calls a fetch (rules, then neutral)', stable(rOff));

  // On (owner/selftest flavour): exactly openrouter.ai, through the guard, key in a header.
  const SENT = 'sentinelJEVbody0123456789';
  const JEK = `sk-or-v1-${SENT}wxyz`;
  const on = makeHost({ fetchBase: jevReply, initial: { aiProvider: 'openrouter' }, flavour: { values: { ...FLAVOURS.public, reflexEgress: true } } });
  writeKey(on, JEK);
  const rOn = await on.aiCore.reflexClassify('thanks a lot!');
  ok(rOn.source === 'jev' && rOn.reaction === 'happy', 'reflexJev.classify uses Jev when reflexEgress is on', stable(rOn));
  ok(calls.length === 1 && new URL(calls[0].url).origin === 'https://openrouter.ai', 'the Jev call went to https://openrouter.ai only', calls[0] && calls[0].url);
  ok(calls[0].init.headers.authorization === `Bearer ${JEK}` && !calls[0].url.includes(JEK), 'the Jev key rode the header, never the URL');
  ok(on.logs.some((l) => l === 'egress https://openrouter.ai 200'), 'the Jev call writes the same egress log line');
  ok(![...on.logs, JSON.stringify(rOn)].join(String.fromCharCode(10)).includes(SENT), 'the sentinel Jev key is in no log line or reply');
  ok((await off.aiCore.reflexClassify('   ')).source === 'neutral', 'a blank line stays neutral without any call');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(work, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
