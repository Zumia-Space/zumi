// T-31 Tauri parity step 6 (local part) check: the AI/BYOK settings and the handlers that need no network.
// Plain Node: no Electron, no window, NO network (every fetch is the closed one; a socket attempt would fail the run).
//
//   node scripts/check-tauri-ai-settings.mjs
//
//   1. parity: main.js's own text (ai:provider, ai:set-mode, ai:set-provider, pinAiProvider, migrateOpencodeModels,
//      usage:summary, reflexjev:classify, talk:openSource, ai:open-key-page, talk:log) is run in a vm on the same fixture
//      settings as the sidecar code; every reply AND the settings file after each call must match;
//   2. keys: a sentinel key never leaves brainKey.status / clear, and appears in no file but its blob;
//   3. network: no module of this step can reach one (static scan + the injected fetch is the closed one);
//   4. the real stdio protocol: the pin at start, the answers, and the names that must stay unregistered.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createAiSettings } from '../tauri/sidecar/ai-settings.mjs';
import { closedFetch, createAiCore } from '../tauri/sidecar/ai-core.mjs';
import { createSecretStores } from '../tauri/sidecar/secret-stores.mjs';
import { decideExternalUrl } from '../tauri/sidecar/adapters.mjs';
import { sidecarHandlerNames } from './check-tauri-coverage.mjs';
import { evaluate, functionSource, handlerSource, constSource } from './lib/electron-source.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const prov = require('../src/main/providers.js');
const { appendUsage } = require('../src/main/usage-ledger.js');
const { withEstimatedCost } = require('../src/main/usage-cost.js');
const { aggregateUsage } = require('../src/main/usage-ledger.js');
const { createKeyStore, createReflexJev } = require('../src/main/reflex-jev.js');
const { loadLocalReflexClassifier } = require('../src/main/reflex-jev-local.js');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
// Stable JSON (sorted keys) so two objects compare by content, not by insertion order.
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const mainSrc = read('src', 'main', 'main.js');

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP_ROOT, 'ai-'));
let dirN = 0;
const freshDir = () => { const d = path.join(work, `d${++dirN}`); fs.mkdirSync(d, { recursive: true }); return d; };
const settingsStore = (dir) => {
  const file = path.join(dir, 'settings.json');
  const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const set = (patch) => { const next = { ...get(), ...patch }; fs.writeFileSync(file, JSON.stringify(next, null, 2)); return next; };
  return { get, set };
};

// ---------------------------------------------------------------- 1a. settings parity: Electron's text vs the sidecar module
const SOURCES = [
  functionSource(mainSrc, 'hasOpenRouterKey'), functionSource(mainSrc, 'aiProviderId'), functionSource(mainSrc, 'pinAiProvider'),
  functionSource(mainSrc, 'aiDefaultsLegacy'), functionSource(mainSrc, 'migrateOpencodeModels'), constSource(mainSrc, 'aiProvider'),
  functionSource(mainSrc, 'aiMode'), functionSource(mainSrc, 'aiLegacyDefaults'),
  handlerSource(mainSrc, 'ai:provider'), handlerSource(mainSrc, 'ai:set-mode'), handlerSource(mainSrc, 'ai:set-provider'),
];

function electronSide(dir, st) {
  let rebuilt = 0;
  const scope = {
    fromAppPage: () => true, loadSettings: st.get, saveSettings: st.set, app: { getPath: () => dir }, fs, path,
    PROVIDERS: prov.PROVIDERS, isProviderId: prov.isProviderId, selectableProvider: prov.selectableProvider, OWNER_ADMIN: false, resolveProviderId: prov.resolveProviderId, resolveMode: prov.resolveMode,
    isMode: prov.isMode, effectiveLegacyDefaults: prov.effectiveLegacyDefaults, switchRoleSlots: prov.switchRoleSlots,
    migrateOpencodeRoleModels: prov.migrateOpencodeRoleModels, rebuildChatBrain: () => { rebuilt++; return { rebuilt }; }, chatBrain: null,
  };
  const { ipc, ctx } = evaluate(SOURCES, scope);
  return {
    rebuilt: () => rebuilt,
    run: (a) => {
      switch (a[0]) {
        case 'provider': return ipc['ai:provider']({});
        case 'pin': ctx.pinAiProvider(); return null;
        case 'migrate': ctx.migrateOpencodeModels(); return null;
        case 'setMode': return ipc['ai:set-mode']({}, a[1]);
        case 'setProvider': return ipc['ai:set-provider']({}, a[1]);
        case 'legacy': return ctx.aiLegacyDefaults();
        default: throw new Error(a[0]);
      }
    },
  };
}
function sidecarSide(dir, st) {
  let rebuilt = 0;
  const ai = createAiSettings({ dataDir: dir, settings: st.get, saveSettings: st.set, onChange: () => { rebuilt++; } });
  return {
    rebuilt: () => rebuilt,
    run: (a) => {
      switch (a[0]) {
        case 'provider': return ai.providerInfo();
        case 'pin': ai.pin(); return null;
        case 'migrate': ai.migrateOpencodeModels(); return null;
        case 'setMode': return ai.setMode(a[1]);
        case 'setProvider': return ai.setProvider(a[1]);
        case 'legacy': return ai.legacyDefaults();
        default: throw new Error(a[0]);
      }
    },
  };
}

{
  const free = { free: 'z-ai/glm-4.5-air:free' };
  const fixtures = [
    {}, { aiProvider: 'groq' }, { aiProvider: 'nope' }, { aiMode: 'byok' }, { aiDefaultsLegacy: true },
    { aiProvider: 'opencode', aiMode: 'free', aiDefaultsLegacy: true },
    { aiProvider: 'opencode', roleModels: { plan: { model: 'x-free' }, check: { model: 'minimax-m2.5-free' } }, roleModelsByProvider: { opencode: { plan: { model: 'big-pickle-free' } } } },
    { aiProvider: 'gemini', roleModels: { plan: { model: 'gem-a' } }, roleModelsByProvider: { groq: { plan: { model: 'g-b' } } } },
    { aiProvider: 'openrouter', roleModels: free },
  ];
  const script = [
    ['provider'], ['legacy'], ['pin'], ['migrate'], ['provider'], ['setMode', 'byok'], ['provider'], ['legacy'], ['setMode', 'bogus'], ['setMode', undefined],
    ['setProvider', 'groq'], ['setProvider', 'groq'], ['setProvider', 'opencode'], ['migrate'], ['setProvider', 'nope'], ['setProvider', 7], ['setProvider', 'openrouter'],
    ['setProvider', 'gemini'], ['provider'], ['legacy'],
  ];
  let bad = 0;
  for (const withKey of [false, true]) {
    for (const [fi, fx] of fixtures.entries()) {
      const eDir = freshDir();
      const sDir = freshDir();
      for (const d of [eDir, sDir]) { fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(fx, null, 2)); if (withKey) fs.writeFileSync(path.join(d, 'jev-key.bin'), 'x'); }
      const e = electronSide(eDir, settingsStore(eDir));
      const s = sidecarSide(sDir, settingsStore(sDir));
      for (const step of script) {
        const er = stable(e.run(step));
        const sr = stable(s.run(step));
        const es = stable(settingsStore(eDir).get());
        const ss = stable(settingsStore(sDir).get());
        if (er !== sr || es !== ss) { bad++; ok(false, `fixture ${fi} key=${withKey} step ${JSON.stringify(step)}`, `reply ${er} vs ${sr}; settings ${es} vs ${ss}`); break; }
      }
      if (e.rebuilt() !== s.rebuilt()) { bad++; ok(false, `fixture ${fi} key=${withKey}: brain rebuilds`, `${e.rebuilt()} vs ${s.rebuilt()}`); }
    }
  }
  ok(bad === 0, `ai.provider / pin / migrate / setMode / setProvider match Electron on ${fixtures.length * 2} settings fixtures x ${script.length} steps (replies, settings file, brain rebuilds)`);
  const s = sidecarSide(freshDir(), settingsStore(freshDir()));
  ok(Object.keys(s.run(['provider'])).join() === 'id,label,mode', 'ai.provider keys are { id, label, mode }');
}

// ---------------------------------------------------------------- 1b. usage.summary, reflexjev:classify, talk:log vs Electron
function makeCore(dir, extra = {}) {
  const st = settingsStore(dir);
  const ai = createAiSettings({ dataDir: dir, settings: st.get, saveSettings: st.set });
  const fake = fakeSafeStorage();
  const calls = [];
  const stores = createSecretStores({ safeStorage: fake, dataDir: dir });
  const secretStores = async () => ({ ...stores, brainKey: (o) => { calls.push(o); return stores.brainKey(o); } });
  const logs = [];
  const refusals = [];
  const core = createAiCore({ ai, secretStores, dataDir: dir, logRefusal: (d) => refusals.push(d), log: (m) => logs.push(m), ...extra });
  return { core, ai, st, fake, calls, logs, refusals };
}
// A reversible, non-identity fake (so a plaintext key can never appear in the blob).
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'),
  };
}

{
  const dir = freshDir();
  const { core } = makeCore(dir);
  // usage.summary: same ledger, Electron's handler text
  const rec = { model: 'openai/gpt-oss-20b', kind: 'chat', in: 120, out: 30, total: 150, ms: 800, ok: true };
  appendUsage(dir, rec); appendUsage(dir, { ...rec, kind: 'plan', total: 90 }); appendUsage(dir, { ...rec, model: 'made-up/model', ok: false });
  const { ipc } = evaluate([handlerSource(mainSrc, 'usage:summary')], { fromAppPage: () => true, app: { getPath: () => dir }, aggregateUsage, withEstimatedCost });
  ok(stable(core.usageSummary()) === stable(ipc['usage:summary']({})), 'usage.summary == Electron usage:summary on a populated ledger');
  const empty = freshDir();
  const e2 = evaluate([handlerSource(mainSrc, 'usage:summary')], { fromAppPage: () => true, app: { getPath: () => empty }, aggregateUsage, withEstimatedCost }).ipc['usage:summary']({});
  ok(stable(makeCore(empty).core.usageSummary()) === stable(e2), 'usage.summary == Electron on an empty ledger');
  ok(Array.isArray(core.usageSummary().rows) && core.usageSummary().rows.length >= 2, 'the populated summary has rows');

  // reflexjev:classify: Electron's handler around the same module with egress off
  const reflex = createReflexJev({ egressAllowed: false, loadLocal: loadLocalReflexClassifier, fetchImpl: closedFetch });
  const eClassify = evaluate([handlerSource(mainSrc, 'reflexjev:classify')], { fromAppPage: () => true, reflexJev: reflex }).ipc['reflexjev:classify'];
  const texts = ['thanks a lot!', 'I am worried this will fail', 'wow really?', '', '   ', 'hello there', 'x'.repeat(5000), 12, null, undefined];
  let same = true;
  let detail = '';
  for (const t of texts) {
    const a = await core.reflexClassify(t);
    const b = await eClassify({}, t);
    const strip = (r) => stable({ reaction: r.reaction, confidence: r.confidence, source: r.source });
    if (strip(a) !== strip(b)) { same = false; detail = `${JSON.stringify(String(t).slice(0, 20))}: ${strip(a)} vs ${strip(b)}`; break; }
  }
  ok(same, 'reflexJev.classify == Electron reflexjev:classify (egress off) on 10 inputs', detail);
  ok((await core.reflexClassify('')).source === 'neutral', 'a blank text is the neutral reply');

  // talk:log: no run dir in a normal run -> false
  const logHandler = evaluate([handlerSource(mainSrc, 'talk:log')], { fromAppPage: () => true, runDir: null, fs, path }).ipc['talk:log'];
  ok(logHandler({}, { a: 1 }) === false, 'Electron talk:log is false without a run dir (the sidecar answers false)');
}

// ---------------------------------------------------------------- 1c. the two opens: verdicts == Electron's decisions
{
  const dir = freshDir();
  const { core, ai, refusals, logs } = makeCore(dir);
  // ai:open-key-page: Electron opens aiProvider().keyPageURL; the verdict names the same URL for every provider
  for (const id of prov.PROVIDER_IDS) {
    ai.setProvider(id);
    const opened = [];
    const { ipc } = evaluate([functionSource(mainSrc, 'aiProviderId'), functionSource(mainSrc, 'hasOpenRouterKey'), constSource(mainSrc, 'aiProvider'), handlerSource(mainSrc, 'ai:open-key-page')], {
      fromAppPage: () => true, loadSettings: () => ({ aiProvider: id }), app: { getPath: () => dir }, fs, path, PROVIDERS: prov.PROVIDERS, isProviderId: prov.isProviderId, selectableProvider: prov.selectableProvider, OWNER_ADMIN: false, resolveProviderId: prov.resolveProviderId, shell: { openExternal: (u) => opened.push(u) },
    });
    const r = ipc['ai:open-key-page']({});
    const v = core.keyPageVerdict();
    ok(r === true && opened.length === 1 && v.action === 'openExternal' && v.url === opened[0] && v.url === prov.PROVIDERS[id].keyPageURL && /^https:\/\//.test(v.url), `ai.openKeyPage: provider ${id} verdict URL == the URL Electron opens (${new URL(v.url).host})`);
  }
  ok(core.keyPageVerdict.length === 0, 'the key page verdict takes no argument: the page cannot name the URL');

  // talk:openSource: only an exact cited URL; same decisions as main.js
  const cited = 'https://example.com/a?b=1';
  core.rememberCited([{ url: cited, title: 't' }, { url: 7 }, null, { title: 'no url' }]);
  const urls = [cited, 'https://example.com/a', 'http://example.com/a?b=1', 'https://user@example.com/', 'https://127.0.0.1/', 'https://xn--e1afmkfd.example/', 'javascript:alert(1)', '', 'https://example.com:8443/a?b=1'];
  let allSame = true;
  let detail = '';
  for (const u of urls) {
    const opened = [];
    const warned = [];
    const refusedLog = [];
    const citedUrls = new Set([cited]);
    const { ipc } = evaluate([handlerSource(mainSrc, 'talk:openSource')], {
      fromAppPage: () => true, decideExternalUrlFn: decideExternalUrl, citedUrls, logRefusal: (d) => refusedLog.push(d),
      shell: { openExternal: (x) => opened.push(x) }, console: { warn: (m) => warned.push(m) },
    });
    const eRes = ipc['talk:openSource']({}, u);
    refusals.length = 0;
    const v = core.citedUrlVerdict(u);
    const sOpens = v.action === 'openExternal';
    if (eRes !== sOpens || (sOpens && opened[0] !== v.url) || (!sOpens && refusals.length !== refusedLog.length)) { allSame = false; detail = `${u}: electron ${eRes}/${opened[0]} vs sidecar ${stable(v)}`; break; }
  }
  ok(allSame, 'talk.openSource verdict == Electron talk:openSource on cited / uncited / malformed URLs (open iff Electron opens, same URL, same refusal logging)', detail);
  ok(core.citedUrlVerdict(7).action === 'refuse' && core.citedUrlVerdict(undefined).action === 'refuse', 'a non-string url is refused');
  // the cited set is capped at 100 like main.js
  core.rememberCited(Array.from({ length: 150 }, (_x, i) => ({ url: `https://example.com/${i}` })));
  ok(core.citedUrlVerdict('https://example.com/149').action === 'openExternal' && core.citedUrlVerdict('https://example.com/10').action === 'refuse', 'the cited set keeps the newest 100 URLs');
  ok(!logs.join('\n').includes('https://example.com/a?b=1'), 'the refusal log lines carry no full URL');
}

// ---------------------------------------------------------------- 2. keys: a sentinel never leaves the sidecar
{
  const dir = freshDir();
  const { core, ai, fake, calls } = makeCore(dir);
  const SENTINEL_BODY = 'SENTINELbodyKEYmaterial0123456789';
  const key = `sk-or-v1-${SENTINEL_BODY}wxyz`;
  ai.setProvider('openrouter');
  const store = createKeyStore({ safeStorage: fake, dir, name: prov.PROVIDERS.openrouter.keyName, shape: prov.PROVIDERS.openrouter.keyShape });
  ok(store.write(key).ok === true, 'fixture: a key is written through the same store the module uses');
  const status = await core.brainKeyStatus();
  ok(status.saved === true && status.last4 === 'wxyz' && status.encryption === true && Object.keys(status).join() === 'provider,saved,last4,checked,encryption', 'brainKey.status: { provider, saved, last4, checked, encryption } only', stable(status));
  ok(!JSON.stringify(status).includes(SENTINEL_BODY), 'the status reply carries no key material');
  ok(calls.length === 1 && calls[0].fetchImpl === closedFetch, 'the key store was built with the closed fetch (never the global one)');
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const leaks = files.filter((f) => fs.readFileSync(path.join(dir, f)).includes(Buffer.from(SENTINEL_BODY)));
  ok(leaks.length === 0, 'the sentinel body is in no file of the data dir (the blob is encrypted)', leaks.join(','));
  const cleared = await core.brainKeyClear();
  ok(cleared.ok === true && cleared.saved === false && cleared.last4 === null && !JSON.stringify(cleared).includes(SENTINEL_BODY), 'brainKey.clear answers { ok, ...status } with the key gone');
  ok(!fs.existsSync(path.join(dir, 'jev-key.bin')), 'the key blob is deleted by clear');
  // another provider's file is untouched by a switch (one file per provider)
  const groq = prov.PROVIDERS.groq;
  createKeyStore({ safeStorage: fake, dir, name: groq.keyName, shape: groq.keyShape }).write('gsk_0123456789abcdefGROQ');
  ai.setProvider('gemini');
  const g = await core.brainKeyStatus();
  ok(g.saved === false, 'brainKey.status follows the active provider (gemini has no key)');
  ai.setProvider('groq');
  ok((await core.brainKeyStatus()).last4 === 'GROQ', 'switching back brings the groq key status back');
}

// ---------------------------------------------------------------- 3. network: nothing in this step can reach one
{
  const files = ['ai-settings.mjs', 'ai-core.mjs', 'flavour.mjs'].map((f) => [f, read('tauri', 'sidecar', f).replace(/^\s*\/\/.*$/gm, '')]);
  for (const [f, code] of files) {
    ok(!/\bfetch\s*\(|globalThis\.fetch|node:https?|node:net|node:dgram|node:tls|XMLHttpRequest|WebSocket|undici/.test(code.replace(/closedFetch/g, '')), `${f} opens no network connection of its own`);
  }
  let threw = false;
  try { await closedFetch('https://openrouter.ai/api/v1/key'); } catch (e) { threw = e.message === 'egress_closed'; }
  ok(threw, 'closedFetch refuses every request');
  const core = read('tauri', 'sidecar', 'ai-core.mjs');
  ok(/egressAllowed: reflexEgress/.test(core) && /fetchImpl: reflexEgress \? jevFetch : closedFetch/.test(core), 'ai-core builds Jev from the resolved flavour: off -> closedFetch, on -> the guarded fetch');
  const names = new Set(sidecarHandlerNames(read('tauri', 'sidecar', 'main.mjs')));
  const network = ['brainKey.save', 'brainKey.test', 'ai.testKey', 'roles.set', 'roles.setOn', 'roles.reset', 'roles.models', 'talk.turn', 'talk.gesture', 'talk.brainInfo'];
  ok(network.every((n) => names.has(n)), 'every step-6 network name is registered through the chat host', network.filter((n) => !names.has(n)).join(','));
  // The next-unbuilt name is board.liveOpen (10b): the 21 test-only names are registered from 12-1 (answering
  // not_available outside their CLI mode), and zumiHost.apply is registered from 11-1.
  // P3-B (CoS call): board.liveOpen is registered for EVERY flavour, like Electron; outside live mode it answers not_live (section 4).
  ok(names.has('board.liveOpen'), 'board.liveOpen is a registered sidecar name (every flavour)');
  const local = ['brainKey.status', 'brainKey.clear', 'ai.setProvider', 'ai.setMode', 'ai.openKeyPage', 'talk.openSource', 'talk.log', 'usage.summary', 'reflexJev.classify', 'ai.provider'];
  ok(local.every((n) => names.has(n)), 'the network-free names are registered');
  ok(names.has('__host.aiKeyPageVerdict') && names.has('__host.citedUrlVerdict') && names.has('__host.voiceGuideVerdict') && names.has('__host.linkVerdict'), 'the four host-only verdict methods exist (R4 adds __host.linkVerdict)');
  // Rust side: the host intercepts exactly these names and asks for exactly these verdicts.
  const lib = read('tauri', 'src-tauri', 'src', 'lib.rs');
  const arms = [...lib.slice(lib.indexOf('fn app_open_target'), lib.indexOf('fn app_open_target') + 500).matchAll(/"([\w.]+)" => Some\("([\w.]+)"\)/g)].map((m) => `${m[1]}>${m[2]}`).sort().join(',');
  ok(arms === 'ai.openKeyPage>__host.aiKeyPageVerdict,links.open>__host.linkVerdict,talk.openGuide>__host.voiceGuideVerdict,talk.openSource>__host.citedUrlVerdict', 'lib.rs app_open_target maps exactly the four names to the four sidecar verdict methods (R4: links.open)', arms);
  ok(/guest::open_for_app_page\(&app, &client, host_method, &candidate\)/.test(lib) && /shell_ops::handle_request\(/.test(read('tauri', 'src-tauri', 'src', 'guest.rs')), 'the app-page open runs through shell_ops::handle_request (strict verdict, re-validation, main-thread open)');
  ok(/None => return Ok\(Value::Bool\(false\)\)/.test(lib), 'talk.openSource / talk.openGuide with a non-string argument is false without calling the sidecar (Electron parity)');
  const inventory = JSON.parse(read('docs', 'migration', 'api-inventory.json'));
  const inv = new Set(inventory.apis.map((a) => a.name));
  ok(![...names].filter((n) => n.startsWith('__host.aiKeyPage') || n.startsWith('__host.citedUrl') || n.startsWith('__host.voiceGuide')).some((n) => inv.has(n)), 'the verdict methods are not in the renderer inventory');
}

// ---------------------------------------------------------------- 4. over the real stdio protocol
{
  const dataDir = freshDir();
  const child = spawn(process.execPath, [path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), '--data-dir', dataDir, '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let readyResolve;
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const ready = new Promise((r) => { readyResolve = r; });
  rl.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve(); else if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const request = (method, params = []) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  await ready;
  const st = settingsStore(dataDir).get();
  ok(st.aiProvider === prov.DEFAULT_PROVIDER && st.aiDefaultsLegacy === false, 'the provider is pinned once at start (settings.json: aiProvider + aiDefaultsLegacy)', stable(st));
  ok((await request('ai.provider')).result.id === prov.DEFAULT_PROVIDER, 'ai.provider reads the pinned provider');
  ok((await request('ai.setProvider', ['groq'])).result.label === prov.PROVIDERS.groq.label, 'ai.setProvider answers { ok, id, label }');
  ok((await request('ai.provider')).result.id === 'groq', 'ai.provider follows ai.setProvider');
  ok((await request('ai.setProvider', ['nope'])).result.error === 'bad_provider', 'ai.setProvider refuses an unknown provider');
  ok((await request('ai.openKeyPage')).result === false, 'a direct ai.openKeyPage opens nothing (Rust opens it)');
  ok((await request('talk.openSource', ['https://example.com/'])).result === false, 'a direct talk.openSource opens nothing');
  const verdict = (await request('__host.aiKeyPageVerdict')).result;
  ok(verdict.action === 'openExternal' && verdict.url === prov.PROVIDERS.groq.keyPageURL, '__host.aiKeyPageVerdict names the active provider key page');
  const refuse = (await request('__host.citedUrlVerdict', ['https://example.com/'])).result;
  ok(refuse.action === 'refuse' && refuse.reason === 'url_not_cited', '__host.citedUrlVerdict refuses a URL no reply cited');
  ok((await request('talk.log', [{ a: 1 }])).result === false, 'talk.log answers false');
  ok(Array.isArray((await request('usage.summary')).result.rows), 'usage.summary answers rows');
  ok((await request('reflexJev.classify', ['thanks!'])).result.reaction !== undefined, 'reflexJev.classify answers a reaction');
  const status = (await request('brainKey.status')).result;
  ok(status.saved === false && status.encryption === false, 'brainKey.status without the vault helper: not saved, encryption false (honest)', stable(status));
  // The network names are registered now (step 6 network half). Without a key they answer honestly: no key -> talk_off
  // from cloud, bad_format for a key that cannot pass the shape gate.
  const turn = (await request('talk.turn', [{ turnId: '0123456789abcdef0123456789abcdef', message: 'hi', history: [] }])).result;
  ok(turn && turn.ok === false && turn.error && turn.error.code === 'talk_off', 'talk.turn with no key answers talk_off (the cloud status reason)', stable(turn));
  const save = (await request('brainKey.save', ['not-a-key'])).result;
  ok(save && save.ok === false && save.error === 'bad_format', 'brainKey.save refuses a malformed key before any network', stable(save));
  // talk.ttsAbandon arrived with 8b part 2; the next-unbuilt name is board.liveOpen (10b); the 12-1 test-only names
  // are registered now and refuse with not_available outside their CLI mode.
  ok((await request('talk.ttsAbandon', [{ turnId: 'x' }])).result === true, 'talk.ttsAbandon is answered (8b part 2)');
  {
    const r = await request('board.liveOpen', []);
    ok(r.result && r.result.error === 'not_live', 'board.liveOpen outside live mode answers { error: not_live } (P3-B: registered in every flavour)', JSON.stringify(r));
  }
  ok(!/sk-or-|gsk_|AIza/.test(stderr), 'sidecar stderr carries no key material');
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
}

// ---------------------------------------------------------------- 5. --settings-shots fixtures (12-runtime finding 5)
//
// The box's settings-shots run drove the picker while the sidecar still reported the DEFAULT provider (Gemini, free
// mode). Every key the run types is OpenRouter-shaped and the fixture endpoint answers only that shape, so the key
// flow, Models by role and the chat turns all failed. A shots run must use the fixture provider, like Electron's
// shotsFixtures (main.js:1297): OpenRouter in BYOK mode. This test runs the real sidecar in that CLI mode.
{
  const dataDir = freshDir();
  const outDir = freshDir();
  const child = spawn(process.execPath, [path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), '--data-dir', dataDir, '--settings-shots', outDir, '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  rl.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve();
    else if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (typeof m.method === 'string') child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { error: 'stub' } })}\n`);
  });
  const request = (method, params = []) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  await ready;
  const provider = (await request('ai.provider')).result;
  ok(provider.id === 'openrouter' && provider.mode === 'byok' && provider.label === prov.PROVIDERS.openrouter.label,
    'a --settings-shots run uses the OpenRouter fixture provider in BYOK mode (mutation: drop shotsProvider -> Gemini/free)', stable(provider));
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
