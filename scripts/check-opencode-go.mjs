// check:opencode-go (T-31 alpha.13, PLAN-ZUMI-SESSION section 0). Plain Node, stubbed fetch and a stubbed safeStorage: no network, no real key, no paid call.
//   1. the entry: Go chat URL, same model id, no key test; absent from the lists a public build sees;
//   2. a key can never read as checked before a chat reply: no request at all, even if the model list would answer 200 with no key;
//   3. a real chat reply marks it working, a 401 marks it refused; Go's refusals map to their own lines;
//   4. the client identity headers reach the wire on Go only, and the session id stays stable across turns;
//   5. a public build refuses it, stored or asked for; choosing nothing leaves the active provider alone.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkOutDir } from './lib/check-out-dir.mjs';
import { failureLineKey } from '../src/renderer/talk/error-line.js';
import { TABLES } from '../src/renderer/i18n.js';
import { createAiSettings } from '../tauri/sidecar/ai-settings.mjs';
import { providerEgressOrigins } from '../tauri/sidecar/egress.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = require('../src/main/providers.js');
const { createBrainKey, checkKey } = require('../src/main/brain-key.js');
const { createChatBrain, classifyUpstreamError } = require('../src/main/chat-brain.js');

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const dir = checkOutDir('check-opencode-go');
const FAKE_KEY = `oc_sk_${'f'.repeat(40)}`; // never a real key
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
const scratch = (n) => fs.mkdtempSync(path.join(dir, `${n}-`));
const go = P.PROVIDERS['opencode-go'];

// ---------- 1. the entry ----------
ok(P.chatUrl(go) === 'https://opencode.ai/inference/go/openai/v1/chat/completions', 'chat goes to the Go gateway', P.chatUrl(go));
ok(['plan', 'do', 'check', 'lookup'].every((r) => go.models[r] === 'deepseek-v4.1-flash'), 'all four roles send the same model id as today');
ok(go.keyTest === null, 'no key test: the Go model list answers 200 with no key (measured by CoS 02-11)');
ok(!P.PROVIDER_IDS.includes('opencode-go') && !P.FREE_PROVIDER_IDS.includes('opencode-go') && !P.providerIdsForMode('byok').includes('opencode-go'), 'not in the lists a public build sees');
ok(P.pickerMode('free', 'opencode-go') === 'byok', 'never shown under the free list');
ok(P.DEFAULT_PROVIDER === 'gemini' && P.PROVIDERS.opencode.baseURL === 'https://opencode.ai/inference/openai/v1', 'the default and the Console provider are unchanged');
ok(['en', 'vi', 'zh'].every((l) => go.guide[l].length && TABLES[l]['settings.opencodeGoNotice'] && TABLES[l]['settings.keyUnverified'] && TABLES[l]['app.goLimit'] && TABLES[l]['app.goKeyRefused']), 'guide and lines exist in en, vi, zh');
ok(TABLES.vi['settings.chipKeyUnverified'] === 'Chưa kiểm được khoá' && TABLES.vi['settings.keyUnverified'].includes('chưa kiểm được khoá'), 'the Vietnamese status says "chưa kiểm được khoá"');
ok(!Object.values(go.guide).flat().some((l) => /Test key|Thử khoá/.test(l)), 'the guide does not offer a key test');

ok(providerEgressOrigins(P.PROVIDERS).includes('https://opencode.ai'), 'the sidecar egress table loads with a provider that has no key test, and allows the Go origin');

// ---------- 2. never "checked" before a reply ----------
{
  const calls = [];
  const fetchModelsAnswers200 = async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => '{"data":[]}' }; };
  ok(await checkKey(FAKE_KEY, { fetchImpl: fetchModelsAnswers200, provider: go }) === 'unverified' && calls.length === 0, 'checkKey: unverified, no request sent', calls.join());
  const d = scratch('key');
  const bk = createBrainKey({ safeStorage, dir: d, fetchImpl: fetchModelsAnswers200, getProvider: () => 'opencode-go' });
  const tested = await bk.testKey(FAKE_KEY);
  ok(tested.ok === false && tested.check === 'unverified', 'Test on a typed key: not ok, unverified', JSON.stringify(tested));
  const saved = await bk.save(FAKE_KEY);
  ok(saved.ok === true && saved.check === 'unverified' && saved.checked === 'unverified' && calls.length === 0, 'Save stores it without a confirm step, status unverified, no request', JSON.stringify({ ...saved, last4: 'x' }));
  ok(fs.existsSync(path.join(d, 'opencode-go-key.bin')) && !fs.existsSync(path.join(d, 'opencode-key.bin')), 'own key file: a Console key is not overwritten');
  const again = await bk.test();
  ok(again.ok === false && again.check === 'unverified' && bk.status().checked === 'unverified', 'Check again stays unverified');
  // ---------- 3. a real reply decides ----------
  const L4 = FAKE_KEY.slice(-4);
  bk.noteChatResult('works', 'zzzz');
  ok(bk.status().checked === 'unverified', 'a verdict about another key (a save during the call) is ignored');
  bk.noteChatResult('works', L4);
  ok(bk.status().checked === 'works', 'a chat reply marks the key as working');
  ok((await bk.test()).check === 'unverified' && bk.status().checked === 'works', 'Check again cannot erase what a real reply proved');
  bk.noteChatResult('rejected', L4);
  ok(bk.status().checked === 'rejected', 'a chat 401 marks it refused');
  bk.noteChatResult('bogus', L4);
  ok(bk.status().checked === 'rejected', 'an unknown verdict is ignored');
  const console_ = createBrainKey({ safeStorage, dir: scratch('console'), fetchImpl: fetchModelsAnswers200, getProvider: () => 'opencode' });
  await console_.save(FAKE_KEY); console_.noteChatResult('rejected', FAKE_KEY.slice(-4));
  ok(console_.status().checked === 'works', 'a provider with a real key test ignores chat verdicts');
}

// ---------- 4. the chat wire ----------
function sse(text) {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
async function turnWith(providerId, respond) {
  const d = scratch('brain');
  fs.writeFileSync(path.join(d, `${P.PROVIDERS[providerId].keyName}-key.bin`), FAKE_KEY);
  const calls = [], verdicts = [];
  const brain = createChatBrain({ safeStorage, dir: d, provider: providerId, ownerAdmin: true, appVersion: '0.3.0-alpha.13', log: () => {}, onKeyResult: (c, l4) => verdicts.push(`${c}:${l4}`),
    fetchImpl: async (url, o) => { calls.push({ url: String(url), headers: o.headers, body: o.body }); return respond(); } });
  const one = () => new Promise((resolve) => {
    Promise.resolve(brain.turn({ message: 'xin chào', history: [] })).then(resolve);
  });
  return { one, calls, verdicts };
}
{
  const bodyOk = () => new Response(JSON.stringify({ choices: [{ message: { content: '[greet] Chào anh.' } }], usage: { total_tokens: 3 } }), { status: 200 });
  const a = await turnWith('opencode-go', bodyOk);
  const r1 = await a.one(); const r2 = await a.one();
  ok(r1.ok && r2.ok, 'a stubbed Go turn replies', JSON.stringify(r1).slice(0, 200));
  ok(a.calls[0].url === 'https://opencode.ai/inference/go/openai/v1/chat/completions', 'the request goes to the Go URL');
  ok(a.calls[0].headers['user-agent'] === 'zumi/0.3.0-alpha.13', 'user-agent names Zumi and its version', a.calls[0].headers['user-agent']);
  const sid = a.calls[0].headers['x-opencode-session'];
  ok(/^[0-9a-f-]{36}$/.test(sid || '') && a.calls[1].headers['x-opencode-session'] === sid, 'x-opencode-session is stable across turns');
  ok(a.calls[0].headers.authorization === `Bearer ${FAKE_KEY}` && JSON.parse(a.calls[0].body).model === 'deepseek-v4.1-flash', 'bearer key and model id on the wire');
  ok(a.verdicts[0] === `works:${FAKE_KEY.slice(-4)}`, 'a reply reports the key it used as working', a.verdicts.join());
  const tag = await turnWith('opencode-go', () => new Response(JSON.stringify({ choices: [{ message: { content: '[greet]' } }] }), { status: 200 }));
  const rt = await tag.one();
  ok(!rt.ok && tag.verdicts.length === 0, 'a tag-only answer is a failed turn and no proof of the key', tag.verdicts.join());
  const f403 = await turnWith('opencode-go', () => new Response('{"error":{"message":"monthly limit reached"}}', { status: 403 }));
  const r403 = await f403.one();
  ok(f403.verdicts.length === 0 && failureLineKey(r403.error) === 'app.goForbidden', 'a Go 403 gives no verdict on the key and does not tell him to paste one (its meaning is undocumented)', JSON.stringify(r403));
  const c = await turnWith('opencode', bodyOk);
  await c.one();
  ok(!('x-opencode-session' in c.calls[0].headers) && !('user-agent' in c.calls[0].headers) && c.calls[0].url.includes('/inference/openai/') && c.verdicts.length === 0, 'the Console provider sends nothing new');
  ok(!('clientHeaders' in P.PROVIDERS['opencode-go']), 'the shared table entry is not mutated');

  const refused = await turnWith('opencode-go', () => new Response('{"error":{"message":"Invalid credential"}}', { status: 401 }));
  const r401 = await refused.one();
  ok(!r401.ok && r401.error.code === 'auth' && refused.verdicts[0] === `rejected:${FAKE_KEY.slice(-4)}`, 'Go 401: auth, key marked refused', JSON.stringify(r401));
  ok(failureLineKey(r401.error) === 'app.goKeyRefused', 'Go 401 -> the "paste the Go key" line');
  ok(!JSON.stringify(r401).includes(FAKE_KEY), 'the key is in no answer');
  for (const [status, body] of [[429, '{"error":{"message":"limit"}}'], [402, '{"error":{"message":"Insufficient account funds"}}']]) {
    const lim = await turnWith('opencode-go', () => new Response(body, { status }));
    const r = await lim.one();
    ok(!r.ok && failureLineKey(r.error) === 'app.goLimit' && lim.verdicts.length === 0, `Go ${status} -> the plan limit line, no verdict on the key`, JSON.stringify(r));
  }
  const con = await turnWith('opencode', () => new Response('{"error":{"message":"Insufficient account funds"}}', { status: 402 }));
  ok(failureLineKey((await con.one()).error) === 'app.creditOut', 'Console 402 keeps its out-of-funds line');
  ok(failureLineKey({ code: 'quota', free: false, providerId: 'groq' }) === 'app.providerBusy' && classifyUpstreamError(429).code === 'quota', 'other providers keep their lines');
}

// ---------- 5. owner only; nothing switches ----------
function ai(start, ownerBuild) {
  let s = start;
  return { a: createAiSettings({ dataDir: scratch('ai'), settings: () => s, saveSettings: (p) => { s = { ...s, ...p }; return s; }, ownerBuild }), s: () => s };
}
{
  const pub = ai({ aiProvider: 'opencode' }, false);
  ok(pub.a.setProvider('opencode-go').error === 'bad_provider' && pub.s().aiProvider === 'opencode', 'public build: selecting it is refused');
  ok(ai({ aiProvider: 'opencode-go' }, false).a.providerId() !== 'opencode-go', 'public build: a stored value does not take effect');
  const own = ai({ aiProvider: 'opencode' }, true);
  ok(own.a.providerId() === 'opencode', 'owner build: his active provider stays OpenCode after the update');
  ok(own.a.setProvider('opencode-go').ok === true && own.s().aiProvider === 'opencode-go' && own.a.provider().id === 'opencode-go', 'owner build: selectable');
  ok(own.a.setProvider('opencode').ok === true && own.s().aiProvider === 'opencode', 'owner build: and back');
  const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(/selectableProvider\(id, OWNER_ADMIN\)/.test(src('src/main/main.js')) && /selectableProvider\(stored, OWNER_ADMIN\)/.test(src('src/main/main.js')), 'Electron gates it the same way');
  ok(!/aiProvider: 'opencode-go'/.test(src('src/main/main.js') + src('tauri/sidecar/main.mjs') + src('tauri/sidecar/ai-settings.mjs')), 'no code path writes it as the active provider');
  ok(/ownerBuild && shown === 'byok'/.test(src('src/renderer/brain-key-card.js')), 'the picker lists it only on the owner build');
}

console.log(`\ncheck:opencode-go ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
