// T-31 BYOK (owner decision 16-10): run Zumi on FREE models with the user's own key. Plain Node, no Electron, no
// real network: every request goes to a stubbed fetch, and every "key" is a random fake made at runtime. Verifies:
//   1. the provider table shape + ids, and the per-role defaults from REPORT section 4 (corrected);
//   2. request routing: the correct URL, header and model per provider, with no network (stubbed fetch);
//   3. a free-quota HTTP 429 -> error code 'quota' (the renderer's short provider-named message);
//   4. an existing OpenRouter user stays on OpenRouter (migration-free);
//   5. keys never appear in any log line, status answer or the provider table.
// T-31 fix r (Opus review, verdict FIX) adds:
//   r1. aiProvider is resolved ONCE and persisted (main.js); key save/test uses the persisted provider;
//   r2. with no stored Do choice the default model is the provider table's free Do id, for every provider incl.
//       OpenRouter (no paid deepseek); a stored role choice / a set chatModel still wins;
//   r3. a role choice accepts the selected provider's ids (Gemini ids have no "/"); the card shows the table ids;
//   r4. the key-test key is ALWAYS a header (Gemini x-goog-api-key), never in a URL;
//   r5. role choices are stored PER PROVIDER and restored on switch back (legacy flat -> the openrouter slot);
//   r6. a streamed OpenRouter 429 keeps the non-streamed fallback; the "free" quota wording is free-tier only.
// T-31 fix round 2 (Opus re-review) adds:
//   r2a. free per-role defaults are for NEW users only: a legacy (pre-BYOK) OpenRouter user -- `aiDefaultsLegacy` pinned
//        once at startup -- keeps the pre-BYOK default model + role defaults, exactly the old no-provider construction;
//   r2b. the legacy `chatModel` (an OpenRouter-only id) is applied on OpenRouter only, never POSTed to Groq/Gemini.
// T-31 OpenCode BYOK (owner 16-10) adds:
//   o1. the `opencode` provider: OpenAI-compatible base URL, the /inference/v1/models bearer key test, guide + notice;
//   o2. the two-choice header ("Dùng miễn phí" / "Tự nhập khoá"): the free-list order, the persisted mode + its
//       default (a new user = free, a pinned legacy user = byok), and the picker wiring;
//   o3. the pre-17-10 OpenCode free-quota line (now superseded).
// T-31 OpenCode PAID hotfix (CORRECTION 17-10, real calls) adds:
//   p1. OpenCode leaves the free list: FREE_PROVIDER_IDS = gemini, groq, openrouter (opencode is BYOK-only);
//   p2. OpenCode's per-role ids are the PAID deepseek-v4.1-flash (the *-free ids 403 outside the OpenCode app);
//   p3. its notice + guide (EN/VI/ZH) say "paid / Console credits", with no "free"/"miễn phí"/"免费" wording;
//   p4. a chat 402 / insufficient-funds body -> error code 'credit' (the money line); 401/403 -> 'auth'; 429 ->
//       'quota'; everything else stays 'upstream' (T-31 byok-errors, 20-10);
//   p5. a saved *-free OpenCode role id is rewritten to the paid id at load (migrateOpencodeRoleModels);
//   p6. a free-tier 429 (gemini/groq) keeps the "free quota used up for today, {provider}" line; any other 429 shows
//       the "provider is busy" line (byok-errors round 2). The old paid-quota / OpenCode-credit keys are removed;
// T-31 fix round 3 (Opus review, verdict FIX) adds:
//   o4. the OpenCode key shape refuses another vendor's key prefix (Gemini AIza / OpenRouter sk-or- / Groq gsk_); an
//       unreachable key test does NOT save without the explicit confirmation (every provider); the mode default, the
//       legacy pin, the wrong-vendor refusal and label-vs-model-in-free-mode are BEHAVIOUR tests of the pure helpers
//       main.js actually calls (the old mode/legacy regex-on-source checks are replaced by those). A few genuine
//       WIRING assertions (the preload surface, the markup) stay as source checks -- they need Electron to run for real.
// T-31 fix round 4 (Opus re-review) adds:
//   o5. each provider's key shape now enforces its DOCUMENTED format (Gemini `AIza`+35 = 39 chars, Groq `gsk_`,
//       OpenRouter `sk-or-`, OpenCode refusing the three) -- behaviour-tested over every cross-vendor pair, so an
//       unreachable key test can never store a wrong-vendor key.
// T-31 follow-up (review 17-10) adds:
//   f1. free mode never lists or selects OpenCode: pickerMode() shows a profile pinned to OpenCode (saved while it was
//       free) in "Tự nhập khoá", and the card builds the picker + header from that shown mode;
//   f2. the OpenCode guide's "Test key" step (EN/VI/ZH) says the test only checks the key -- chat also needs Console
//       credit -- instead of claiming a green test means chat works (the key-test GET returns 200 at zero balance).
//   node scripts/check-byok.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { realSafeStorage } from './lib/real-safe-storage.mjs';
import { TABLES } from '../src/renderer/i18n.js';
// T-31 free-click: the card is a renderer ES module; importing it is safe in plain Node (no DOM at module load) and
// lets the free-click path be behaviour-tested with a tiny DOM stub and a fake zumi surface below.
import { initBrainKey, indefiniteArticle } from '../src/renderer/brain-key-card.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const providers = require('../src/main/providers.js');
const { PROVIDERS, PROVIDER_IDS, FREE_PROVIDER_IDS, DEFAULT_PROVIDER, isProviderId, resolveProviderId, switchRoleSlots, chatUrl, headersFor, providerModels, isMode, providerIdsForMode, pickerMode, resolveMode, effectiveLegacyDefaults, optionLabel, migrateOpencodeRoleModels, paidOpencodeModel, OPENCODE_PAID_MODEL, OPENCODE_RETIRED_IDS } = providers;
const { createChatBrain, streamChat, MODEL } = require('../src/main/chat-brain.js');
const { createKeyStore } = require('../src/main/reflex-jev.js');
const { keyTestRequest, createBrainKey } = require('../src/main/brain-key.js');
const { setRoleChoice, resolveRoles, ROLES } = require('../src/main/role-models.js');

// Reversible fake of Electron safeStorage (same convention as check-brain-key.mjs).
function stubSafeStorage() {
  const real = realSafeStorage(); // ZUMI_VAULT_EXE: GATE-step5 test 9 (the real vault adapter)
  if (real) return real;
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...Buffer.from(`enc:${s}`, 'utf8')].map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8').slice(4),
  };
}
const tmpDirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-')); tmpDirs.push(d); return d; };
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// Runtime-made fakes per provider shape, never written to this file and never printed.
const FAKE = {
  gemini: `AIza${crypto.randomBytes(20).toString('hex').slice(0, 35)}`, // the strict shape: AIza + exactly 35 (39 total)
  groq: `gsk_${crypto.randomBytes(24).toString('hex')}`,
  openrouter: `sk-or-v1-${crypto.randomBytes(24).toString('hex')}`,
  opencode: `oc_sk_${crypto.randomBytes(24).toString('hex')}`,
};
const ALL_KEYS = Object.values(FAKE);
const leaks = (x) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return ALL_KEYS.some((k) => s.includes(k)) || /sk-or-v1-[0-9a-f]{20,}/.test(s); };
// p2: a retired OpenCode *-free model id (403 outside the OpenCode app, CORRECTION 17-10).
const openFree = (id) => OPENCODE_RETIRED_IDS.has(id);

// A stubbed fetch: records the request and answers a non-streamed reply (or a chosen status). No network at all.
function stubFetch({ status = 200, capture, body = '{}' } = {}) {
  return (url, opts) => {
    if (capture) capture.push({ url: String(url), opts });
    if (status !== 200) return Promise.resolve({ ok: false, status, json: async () => ({}), text: async () => body });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ provider: 'Stub', choices: [{ message: { content: '[agree] Sure.' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) });
  };
}

try {
  // ---------- 1. the provider table ----------
  {
    ok(JSON.stringify(PROVIDER_IDS) === '["gemini","groq","openrouter","opencode"]', 'table: the four provider ids, in order', JSON.stringify(PROVIDER_IDS));
    ok(DEFAULT_PROVIDER === 'gemini' && isProviderId(DEFAULT_PROVIDER), 'table: DEFAULT_PROVIDER is the single constant "gemini"', DEFAULT_PROVIDER);
    const ROLES = ['plan', 'do', 'check', 'lookup'];
    let shapeOk = true, guideOk = true, testCfgOk = true;
    for (const id of PROVIDER_IDS) {
      const p = PROVIDERS[id];
      if (p.id !== id || !p.label || !/^https:\/\//.test(p.baseURL) || typeof p.keyPrefix !== 'string' || !p.keyName || !(p.keyShape instanceof RegExp) || !p.keyPageURL) shapeOk = false;
      if (!p.models || !ROLES.every((r) => typeof p.models[r] === 'string')) shapeOk = false;
      if (!p.guide || !['en', 'vi', 'zh'].every((l) => Array.isArray(p.guide[l]) && p.guide[l].length >= 3)) guideOk = false;
      if (!p.keyTest || p.keyTest.method !== 'GET' || !/^https:\/\//.test(p.keyTest.url) || !['bearer', 'header'].includes(p.keyTest.auth)) testCfgOk = false;
      if (p.keyTest && p.keyTest.auth === 'header' && typeof p.keyTest.header !== 'string') testCfgOk = false;
    }
    ok(shapeOk, 'table: every provider has id/label/https baseURL/keyPrefix/keyName/keyShape/keyPageURL + 4 role models');
    ok(guideOk, 'table: every provider has >= 3 numbered guide steps in en/vi/zh');
    ok(testCfgOk, 'table: every provider has a GET key-test route with a bearer or header auth style');
    ok(PROVIDER_IDS.every((id) => !/[?=]/.test(PROVIDERS[id].keyTest.url)), 'table: no key-test URL carries a query string (the key is never in a URL)', JSON.stringify(PROVIDER_IDS.map((id) => PROVIDERS[id].keyTest.url)));
    ok(PROVIDER_IDS.every((id) => new Set(PROVIDERS[id].guide.en.map((_, i) => i)).size === PROVIDERS[id].guide.en.length
      && PROVIDERS[id].guide.vi.length === PROVIDERS[id].guide.en.length && PROVIDERS[id].guide.zh.length === PROVIDERS[id].guide.en.length),
      'table: guide steps are the same count across the three languages', '');
    ok(PROVIDERS.gemini.notice === 'settings.trainNoticeFreeTier' && PROVIDERS.groq.notice === null && PROVIDERS.openrouter.notice === null
      && PROVIDERS.opencode.notice === 'settings.opencodeNotice',
      'table: Gemini carries the free-tier training notice, OpenCode its paid-credits notice, Groq/OpenRouter none',
      JSON.stringify(PROVIDER_IDS.map((id) => [id, PROVIDERS[id].notice])));

    // REPORT section 4 (corrected): do = chat, plan & check = summarise, lookup = quick reflex.
    const EXPECT = {
      gemini: { do: 'gemini-3.5-flash-lite', lookup: 'gemini-3.5-flash-lite', plan: 'gemini-3.8-flash', check: 'gemini-3.8-flash' },
      groq: { do: 'openai/gpt-oss-120b', lookup: 'openai/gpt-oss-20b', plan: 'openai/gpt-oss-120b', check: 'openai/gpt-oss-120b' },
      openrouter: { do: 'google/gemma-4-31b-it:free', lookup: 'openrouter/free', plan: 'google/gemma-4-26b-a4b-it:free', check: 'google/gemma-4-26b-a4b-it:free' },
      // OpenCode PAID ids (CORRECTION 17-10): all four roles send deepseek-v4.1-flash. The *-free ids 403 outside the
      // OpenCode app, and the paid GLM twin is unmeasured, so no guess.
      opencode: { do: OPENCODE_PAID_MODEL, lookup: OPENCODE_PAID_MODEL, plan: OPENCODE_PAID_MODEL, check: OPENCODE_PAID_MODEL },
    };
    ok(PROVIDER_IDS.every((id) => ROLES.every((r) => PROVIDERS[id].models[r] === EXPECT[id][r])),
      'table: per-role model ids match the REPORT tables (chat->do, summarise->plan/check, quick reflex->lookup)',
      JSON.stringify(PROVIDER_IDS.map((id) => PROVIDERS[id].models)));
    // p2: no retired *-free id is left anywhere in the table, and OpenCode claims the paid id.
    ok(OPENCODE_PAID_MODEL === 'deepseek-v4.1-flash' && OPENCODE_RETIRED_IDS.has('deepseek-v4.1-flash-free') && OPENCODE_RETIRED_IDS.has('glm-5.3-flash-free')
      && ROLES.every((r) => PROVIDERS.opencode.models[r] === 'deepseek-v4.1-flash'),
      'paid: OpenCode sends the measured paid id in every role; the retired free ids are gone', JSON.stringify(PROVIDERS.opencode.models));
    ok(PROVIDER_IDS.every((id) => ROLES.every((r) => !openFree(PROVIDERS[id].models[r]))),
      'paid: no provider table sends a retired *-free OpenCode id', JSON.stringify(PROVIDER_IDS.map((id) => PROVIDERS[id].models)));

    ok(chatUrl(PROVIDERS.gemini) === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      && chatUrl(PROVIDERS.groq) === 'https://api.groq.com/openai/v1/chat/completions'
      && chatUrl(PROVIDERS.openrouter) === 'https://openrouter.ai/api/v1/chat/completions'
      && chatUrl(PROVIDERS.opencode) === 'https://opencode.ai/inference/openai/v1/chat/completions',
      'table: chatUrl joins baseURL + /chat/completions for each provider', JSON.stringify(PROVIDER_IDS.map((id) => chatUrl(PROVIDERS[id]))));
    ok(headersFor(PROVIDERS.groq, 'X').authorization === 'Bearer X' && providerModels(PROVIDERS.openrouter).length === 3
      && providerModels(PROVIDERS.opencode).length === 1,
      'table: bearer header + providerModels dedups the per-role ids (openrouter: 3 distinct, opencode: 1 paid id)', JSON.stringify(providerModels(PROVIDERS.opencode).map((m) => m.id)));
    // OpenCode keys: Console keys are oc_sk_... (new) or the legacy sk-...; a tolerant shape accepts both (REPORT
    // section 2b is silent on a prefix, so keyPrefix is empty and the bad-format line names no prefix). T-31 fix round
    // item 1: the shape must REJECT the other vendors' prefixes (Gemini AIza, OpenRouter sk-or-, Groq gsk_) so a
    // wrong-vendor key can never be stored under OpenCode and then 401 in chat.
    ok(PROVIDERS.opencode.keyShape.test(`oc_sk_${'a'.repeat(48)}`) && PROVIDERS.opencode.keyShape.test(`sk-${'b'.repeat(64)}`)
      && !PROVIDERS.opencode.keyShape.test('short') && PROVIDERS.opencode.keyPrefix === '',
      'table: OpenCode accepts oc_sk_... and sk-... keys, refuses junk, and claims no prefix', PROVIDERS.opencode.keyPrefix);
    ok(!PROVIDERS.opencode.keyShape.test(`AIza${'a'.repeat(35)}`) && !PROVIDERS.opencode.keyShape.test(`sk-or-v1-${'b'.repeat(48)}`)
      && !PROVIDERS.opencode.keyShape.test(`gsk_${'c'.repeat(48)}`),
      'table: OpenCode REFUSES the known Gemini / OpenRouter / Groq key prefixes', JSON.stringify(PROVIDERS.opencode.keyShape.source));
  }

  // ---------- key shapes: each vendor's documented format, and every cross-vendor key is refused ----------
  // T-31 fix round 4: the loose `{16,220}` shape accepted ANY vendor's key for Gemini and Groq, so a wrong-vendor
  // key could be saved when its key test was unreachable, then 401 in chat. Each shape now enforces its documented
  // format, and every cross-vendor pair (a key of vendor X against every OTHER vendor's shape) is refused.
  {
    // Well-formed placeholder keys built from repeated characters with the right prefix -- NEVER a real key.
    const WELL_FORMED = {
      gemini: `AIza${'a'.repeat(35)}`,       // AIza + 35 = 39 chars (Google AI Studio format)
      groq: `gsk_${'b'.repeat(48)}`,         // starts with gsk_
      openrouter: `sk-or-${'c'.repeat(48)}`, // starts with sk-or-
      opencode: `oc_sk_${'d'.repeat(48)}`,   // Console key, no documented prefix
    };
    // 1. a well-formed key of each vendor is accepted by its OWN shape.
    ok(PROVIDER_IDS.every((id) => PROVIDERS[id].keyShape.test(WELL_FORMED[id])),
      'shape: a well-formed key of each vendor is accepted by its own shape',
      JSON.stringify(PROVIDER_IDS.filter((id) => !PROVIDERS[id].keyShape.test(WELL_FORMED[id]))));
    // 2. every cross-vendor pair: a key of vendor X is refused by every OTHER vendor's shape.
    const crossLeaks = [];
    for (const from of PROVIDER_IDS) for (const to of PROVIDER_IDS) {
      if (from !== to && PROVIDERS[to].keyShape.test(WELL_FORMED[from])) crossLeaks.push(`${from}->${to}`);
    }
    ok(crossLeaks.length === 0, 'shape: every cross-vendor key is refused (no vendor accepts another vendor\'s key)', JSON.stringify(crossLeaks));
    // 3. the shape enforces the documented format exactly.
    ok(WELL_FORMED.gemini.length === 39 && PROVIDERS.gemini.keyShape.test(`AIza${'a'.repeat(35)}`)
      && !PROVIDERS.gemini.keyShape.test(`AIza${'a'.repeat(34)}`) && !PROVIDERS.gemini.keyShape.test(`AIza${'a'.repeat(36)}`),
      'shape: Gemini is exactly AIza + 35 chars (39 total) -- no shorter, no longer');
    ok(PROVIDERS.groq.keyShape.test(`gsk_${'b'.repeat(48)}`) && !PROVIDERS.groq.keyShape.test(`AIza${'a'.repeat(35)}`)
      && !PROVIDERS.groq.keyShape.test(`sk-or-${'c'.repeat(48)}`) && !PROVIDERS.groq.keyShape.test(`${'b'.repeat(48)}`),
      'shape: Groq requires the gsk_ prefix');
    ok(PROVIDERS.openrouter.keyShape.test(`sk-or-${'c'.repeat(48)}`) && PROVIDERS.openrouter.keyPrefix === 'sk-or-'
      && !PROVIDERS.openrouter.keyShape.test(`gsk_${'b'.repeat(48)}`),
      'shape: OpenRouter keeps its sk-or- prefix shape');
  }

  // ---------- r4. the key-test key is a header, never in a URL ----------
  {
    const g = keyTestRequest(PROVIDERS.gemini, FAKE.gemini);
    ok(g.url === PROVIDERS.gemini.keyTest.url && !g.url.includes(FAKE.gemini) && g.opts.headers['x-goog-api-key'] === FAKE.gemini && !('authorization' in g.opts.headers),
      'gemini: the key-test GET sends the key as the x-goog-api-key header, never in the URL', g.url);
    const o = keyTestRequest(PROVIDERS.openrouter, FAKE.openrouter);
    ok(o.opts.headers.authorization === `Bearer ${FAKE.openrouter}` && o.url === PROVIDERS.openrouter.keyTest.url, 'openrouter: the key-test GET still sends the key as a Bearer header');
    // opencode-free-1610 REPORT section 2b / CORRECTION 17-10: the minimal call is GET the model list with the bearer.
    const oc = keyTestRequest(PROVIDERS.opencode, FAKE.opencode);
    ok(oc.url === 'https://opencode.ai/inference/v1/models' && oc.opts.method === 'GET' && oc.opts.headers.authorization === `Bearer ${FAKE.opencode}` && !oc.url.includes(FAKE.opencode),
      'opencode: the key-test GET hits /inference/v1/models with the key as a Bearer header, never in the URL', oc.url);
  }

  // ---------- r3. a role choice accepts the selected provider's IDs; the card shows the table ids ----------
  {
    const plain = PROVIDERS.gemini.models.do; // a Gemini id: no "/"
    ok(setRoleChoice({}, 'do', { model: plain, effort: 'off' }).ok === true, 'roles: a Gemini id (no "/") is a valid role choice', plain);
    const stored = resolveRoles({ do: { model: plain, effort: 'off' } }, plain);
    ok(stored.roles.do.by === 'user' && stored.roles.do.model === plain, 'roles: a stored Gemini id is honoured (by user), never rejected', JSON.stringify(stored.roles.do));
    ok(setRoleChoice({}, 'do', { model: 'https://evil.example/x', effort: 'low' }).error === 'bad_choice' && setRoleChoice({}, 'do', { model: 'not an id', effort: 'low' }).error === 'bad_choice', 'roles: a URL or junk is still refused');
    const view = resolveRoles({}, PROVIDERS.gemini.models.do, providerModels(PROVIDERS.gemini), PROVIDERS.gemini.models);
    ok(ROLES.every((r) => view.roles[r].by === 'default' && view.roles[r].model === PROVIDERS.gemini.models[r]), 'roles: with the provider defaults every unset role shows exactly the table id that is sent', JSON.stringify(view.roles));
    // r2 card-vs-send: a set chatModel stays the Do default the card shows, exactly as chat-brain posts it.
    const cm = resolveRoles({}, 'deepseek/deepseek-v4-flash', providerModels(PROVIDERS.openrouter), { ...PROVIDERS.openrouter.models, do: 'deepseek/deepseek-v4-flash' });
    ok(cm.roles.do.model === 'deepseek/deepseek-v4-flash' && cm.roles.plan.model === PROVIDERS.openrouter.models.plan, 'roles: a set chatModel is the card Do default (matches the send, never the free table id)', JSON.stringify(cm.roles.do));
  }

  // ---------- r5. role choices are per provider; switching back restores them ----------
  {
    const opSlot = { plan: { model: 'google/gemma-4-26b-a4b-it:free', effort: 'low' }, off: ['check'] };
    const a = switchRoleSlots(undefined, 'openrouter', opSlot, 'gemini');
    ok(a.live && Object.keys(a.live).length === 0 && a.byProvider.openrouter === opSlot, 'slots: switching away snapshots the live slot under its provider and starts the target empty');
    const b = switchRoleSlots(a.byProvider, 'gemini', { do: { model: PROVIDERS.gemini.models.do, effort: 'off' } }, 'openrouter');
    ok(b.live === opSlot && b.byProvider.gemini.do.model === PROVIDERS.gemini.models.do, "slots: switching back restores that provider's own choices (and snapshots the other)");
    const legacy = { plan: { model: 'google/gemma-4-26b-a4b-it:free', effort: 'low' } };
    const m = switchRoleSlots(undefined, 'openrouter', legacy, 'groq');
    ok(m.byProvider.openrouter === legacy, 'slots: a legacy flat roleModels migrates to the openrouter slot on the first switch away');
  }

  // ---------- 2 + 3 + 5. routing, quota, and no key in logs ----------
  {
    const EXPECT_URL = {
      gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      groq: 'https://api.groq.com/openai/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
      opencode: 'https://opencode.ai/inference/openai/v1/chat/completions',
    };
    for (const id of PROVIDER_IDS) {
      const dir = tmpDir();
      const p = PROVIDERS[id];
      createKeyStore({ safeStorage: stubSafeStorage(), dir, name: p.keyName, shape: p.keyShape }).write(FAKE[id]);
      const logs = [];
      const capture = [];
      // r2: no `model` passed -> the default Do model must be this provider's table free id (the paid-default fix).
      const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, provider: p, ownerAdmin: true, fetchImpl: stubFetch({ capture }), log: (m) => logs.push(m) });

      ok(cb.hasKey() && cb.status().enabled === true && cb.status().provider === p.label, `${id}: a saved key turns chat on, status names ${p.label}`);
      ok(cb.defaultModel === p.models.do, `${id}: with no stored choice the default Do model is the table's free id (${p.models.do})`, cb.defaultModel);
      const r = await cb.turn({ message: 'hello', history: [] });
      ok(r.ok === true && typeof r.reply === 'string', `${id}: one turn succeeds against the stubbed fetch`, JSON.stringify(r.error || ''));
      const req = capture.find((c) => c.url === EXPECT_URL[id]);
      ok(Boolean(req), `${id}: the request went to ${EXPECT_URL[id]}`, JSON.stringify(capture.map((c) => c.url)));
      if (req) {
        ok(req.opts.method === 'POST' && req.opts.redirect === 'error', `${id}: POST, redirects refused`);
        ok(req.opts.headers && req.opts.headers.authorization === `Bearer ${FAKE[id]}`, `${id}: the key is sent as a Bearer header`);
        const body = JSON.parse(req.opts.body);
        ok(body.model === p.models.do, `${id}: the Do model is ${p.models.do}`, body.model);
        if (id === 'openrouter') ok(body.reasoning && body.reasoning.enabled === false, 'openrouter: reasoning-off is still sent (unchanged)');
        else ok(!('reasoning' in body) && !('provider' in body) && !('plugins' in body), `${id}: no OpenRouter-only request fields are sent`);
      }
      // The streamed body: `usage: {include}` is an OpenRouter field; Google (gemini) answered 400 to it in the first live chat test.
      const streamBodies = [];
      await streamChat([{ role: 'user', content: 'hi' }], FAKE[id], { provider: p, model: p.models.do, fetchImpl: async (_u, o) => { streamBodies.push(JSON.parse(o.body)); return { ok: false, status: 400, text: async () => '' }; } });
      if (id === 'openrouter') ok(streamBodies[0] && streamBodies[0].stream === true && streamBodies[0].usage && streamBodies[0].usage.include === true, 'openrouter: the stream body still asks for usage (unchanged)');
      else ok(streamBodies[0] && streamBodies[0].stream === true && !('usage' in streamBodies[0]), `${id}: the stream body carries no OpenRouter-only usage field`, JSON.stringify(streamBodies[0] || null));
      ok(!logs.some(leaks), `${id}: no log line contains the key`, `${logs.length} lines`);

      // r2: a stored Do choice (by 'user') still wins over the table default.
      const userDir = tmpDir();
      createKeyStore({ safeStorage: stubSafeStorage(), dir: userDir, name: p.keyName, shape: p.keyShape }).write(FAKE[id]);
      const capUser = [];
      const cbUser = createChatBrain({ safeStorage: stubSafeStorage(), dir: userDir, provider: p, ownerAdmin: true, fetchImpl: stubFetch({ capture: capUser }), log: () => {}, getRoute: () => ({ model: p.models.plan, effort: 'off', by: 'user' }) });
      await cbUser.turn({ message: 'hello', history: [] });
      ok(capUser.some((c) => c.url === EXPECT_URL[id] && JSON.parse(c.opts.body).model === p.models.plan), `${id}: a stored Do choice (by user) is sent unchanged, not the table default`);

      // 3. a free-quota 429 -> error code 'quota'
      const dir429 = tmpDir();
      createKeyStore({ safeStorage: stubSafeStorage(), dir: dir429, name: p.keyName, shape: p.keyShape }).write(FAKE[id]);
      const cb429 = createChatBrain({ safeStorage: stubSafeStorage(), dir: dir429, provider: p, ownerAdmin: true, fetchImpl: stubFetch({ status: 429 }), log: () => {} });
      const r429 = await cb429.turn({ message: 'hello', history: [] });
      ok(r429.ok === false && r429.error && r429.error.code === 'quota', `${id}: HTTP 429 maps to error code "quota"`, JSON.stringify(r429.error));
    }
  }

  // ---------- r6. a streamed 429: OpenRouter keeps the non-streamed fallback; free providers do not ----------
  {
    for (const id of PROVIDER_IDS) {
      const dir = tmpDir();
      const p = PROVIDERS[id];
      createKeyStore({ safeStorage: stubSafeStorage(), dir, name: p.keyName, shape: p.keyShape }).write(FAKE[id]);
      const calls = [];
      const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, provider: p, ownerAdmin: true, fetchImpl: stubFetch({ status: 429, capture: calls }), log: () => {} });
      const { head } = await cb.turnStream({ turnId: 'q'.repeat(32), message: 'hello', history: [] });
      const expect = id === 'openrouter' ? 2 : 1;
      ok(head && head.error && head.error.code === 'quota' && calls.length === expect,
        `${id}: a streamed 429 -> quota in ${expect} call(s) (OpenRouter falls back once, the free providers do not)`, JSON.stringify({ calls: calls.length, err: head && head.error }));
    }
  }

  // ---------- gemini reasoning_effort (22-10): the role effort now reaches Google's OpenAI-compat route ----------
  // Source for every value: the Gemini reasoning-effort notes (Google docs, 2026-10-14).
  // 2.5 Flash/Flash-Lite accept "none"; 2.5 Pro and 3.x cannot turn thinking off, so off maps to the family's lowest
  // level; a model id the docs do not cover gets no field. No `extra_body` (it conflicts with reasoning_effort).
  {
    const MSGS = [{ role: 'user', content: 'hi' }];
    const capture = async (provider, model, routing) => {
      let body = null;
      await streamChat(MSGS, FAKE[provider.id], { provider, model, routing, fetchImpl: async (_u, o) => { body = o.body; return { ok: false, status: 400, text: async () => '' }; } });
      return body;
    };
    const gemBody = (model, effort = 'off') => capture(PROVIDERS.gemini, model, { provider: null, reasoningOff: true, effort, effortOk: true });
    const parsed = async (model, effort) => JSON.parse(await gemBody(model, effort));

    {
      const b = await parsed('gemini-2.5-flash');
      ok(b.reasoning_effort === 'none' && !('extra_body' in b), 'gemini effort: 2.5 Flash off -> "none" (2.5 can disable thinking), no extra_body', JSON.stringify(b.reasoning_effort));
    }
    {
      const b = await parsed('gemini-3.5-flash-lite');
      ok(b.reasoning_effort === 'minimal' && !('extra_body' in b), 'gemini effort: 3.5 Flash-Lite off -> "minimal" (cannot be off; this family supports minimal)', JSON.stringify(b.reasoning_effort));
    }
    {
      const b = await parsed('gemini-3.8-flash');
      ok(b.reasoning_effort === 'low' && !('extra_body' in b), 'gemini effort: 3.8 Flash off -> "low" (no minimal on this family)', JSON.stringify(b.reasoning_effort));
    }
    {
      const b = await parsed('gemini-9.9-flash-lite');
      ok(!('reasoning_effort' in b) && !('extra_body' in b), 'gemini effort: an unknown gemini id gets NO field (never guess)', JSON.stringify(b));
      const b2 = await parsed('gemini-9.9-nova', 'low');
      ok(!('reasoning_effort' in b2), 'gemini effort: an unknown id gets no field even with a role effort set', JSON.stringify(b2));
    }
    {
      const pro = await parsed('gemini-2.5-pro');
      ok(pro.reasoning_effort === 'low', 'gemini effort: 2.5 Pro off -> its lowest supported non-off level (1,024 budget)', JSON.stringify(pro.reasoning_effort));
      ok((await parsed('gemini-2.5-flash', 'medium')).reasoning_effort === 'medium'
        && (await parsed('gemini-3.8-flash', 'high')).reasoning_effort === 'high',
        'gemini effort: low/medium/high from the role pass through unchanged');
    }
    // Other providers are byte-identical to the pre-fix body (no reasoning_effort leaks into them).
    {
      const routing = { provider: null, reasoningOff: true, effort: 'off', effortOk: true };
      const orBody = await capture(PROVIDERS.openrouter, PROVIDERS.openrouter.models.do, routing);
      const orExpected = JSON.stringify({ model: PROVIDERS.openrouter.models.do, messages: MSGS, temperature: 0.7, max_tokens: 500, stream: true, usage: { include: true }, reasoning: { enabled: false } });
      ok(orBody === orExpected, 'gemini effort: the OpenRouter stream body is byte-identical to before (reasoning field, no reasoning_effort)', orBody);
      const groqBody = await capture(PROVIDERS.groq, PROVIDERS.groq.models.do, routing);
      const groqExpected = JSON.stringify({ model: PROVIDERS.groq.models.do, messages: MSGS, temperature: 0.7, max_tokens: 500, stream: true });
      ok(groqBody === groqExpected, 'gemini effort: the Groq stream body is byte-identical to before (no reasoning fields at all)', groqBody);
    }
  }

  // ---------- r1. aiProvider is resolved ONCE and persisted; key save/test uses the persisted provider ----------
  {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    ok(/function aiProviderId\(\)\s*\{\s*const stored = loadSettings\(\)\.aiProvider;[\s\S]{0,140}isProviderId\(stored\)/.test(main), 'main: aiProviderId reads the PERSISTED choice first (no re-derivation once pinned)');
    ok(/function pinAiProvider\(\)\s*\{[\s\S]{0,200}saveSettings\(\{ aiProvider:/.test(main), 'main: pinAiProvider persists the one-time resolution to settings.json');
    ok(/^\s*pinAiProvider\(\);/m.test(main), 'main: pinAiProvider() is called once at startup');
    ok(/getProvider: aiProviderId/.test(main) && /provider: aiProvider\(\)/.test(main), 'main: key save/test (getProvider) and the chat brain both use the persisted provider');
    ok(/roleDefaults: \{ \.\.\.table, do: chatBrain\.defaultModel \}/.test(main), 'main: the card Do default tracks chatBrain.defaultModel (no card-vs-send mismatch for a set chatModel)');
  }

  // ---------- round 2. legacy (pre-BYOK) users keep the old defaults; only new users get the free table ids ----------
  {
    // main.js wiring: the pin persists aiDefaultsLegacy next to aiProvider, and the chat brain / roles card use it.
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    ok(/function aiDefaultsLegacy\(\)\s*\{\s*return loadSettings\(\)\.aiDefaultsLegacy === true;/.test(main), 'round2: main reads the pinned legacy flag (aiDefaultsLegacy)');
    ok(/function pinAiProvider\(\)[\s\S]{0,260}aiDefaultsLegacy: typeof s\.aiDefaultsLegacy/.test(main), 'round2: the startup pin persists aiDefaultsLegacy together with aiProvider (written once, never re-derived)');
    ok(/legacyDefaults: aiLegacyDefaults\(\)/.test(main) && /model: aiMode\(\) === 'free' \? undefined/.test(main),
      'round2/3: the chat brain is built with the mode-gated legacy flag (paid chatModel withheld in free mode)');
    ok(/function aiLegacyDefaults\(\) \{ return effectiveLegacyDefaults\(aiDefaultsLegacy\(\), aiMode\(\)\); \}/.test(main),
      'round3: main derives the effective legacy default from the pinned flag AND the current mode');
    ok(/chatBrain\.legacyOpenRouter \? \{\} : \{ roleDefaults: \{ \.\.\.table, do: chatBrain\.defaultModel \} \}/.test(main), 'round2: the roles card withholds the free table defaults exactly when chat-brain does (legacy OpenRouter)');

    // r2a. a legacy OpenRouter user with NO chatModel keeps the pre-BYOK default model and the old role defaults.
    const dir = tmpDir();
    createKeyStore({ safeStorage: stubSafeStorage(), dir, name: PROVIDERS.openrouter.keyName, shape: PROVIDERS.openrouter.keyShape }).write(FAKE.openrouter);
    const cap = [];
    const usage = [];
    const cbLegacy = createChatBrain({
      safeStorage: stubSafeStorage(), dir, ownerAdmin: true, provider: PROVIDERS.openrouter, legacyDefaults: true,
      fetchImpl: stubFetch({ capture: cap }), log: () => {},
      getRoute: (dm) => resolveRoles({}, dm).roles.do, // main.js legacy wiring: no providerDefaults
      getRoles: (dm) => resolveRoles({}, dm).roles,
      onUsage: (rec) => usage.push(rec),
    });
    ok(cbLegacy.legacyOpenRouter === true && cbLegacy.defaultModel === MODEL, `round2: a legacy OpenRouter user keeps the pre-BYOK Do model (${MODEL}), never the free table id`, cbLegacy.defaultModel);
    const rl = await cbLegacy.turn({ message: 'hello', history: [] });
    ok(rl.ok === true && JSON.parse(cap.find((c) => c.url.endsWith('/chat/completions')).opts.body).model === MODEL, 'round2: the legacy Do send is the pre-BYOK model, not the free table id');
    await cbLegacy.turnStream({ turnId: 'l'.repeat(32), message: 'p'.repeat(220), history: [] });
    const planLegacy = usage.find((u) => u.kind === 'plan');
    ok(planLegacy && planLegacy.model === MODEL, 'round2: a legacy unset role keeps the pre-BYOK default (plan), not the free table id', JSON.stringify(planLegacy));

    // r2a. a NEW OpenRouter user gets the provider table's free per-role ids.
    const dirNew = tmpDir();
    createKeyStore({ safeStorage: stubSafeStorage(), dir: dirNew, name: PROVIDERS.openrouter.keyName, shape: PROVIDERS.openrouter.keyShape }).write(FAKE.openrouter);
    const capNew = [];
    const usageNew = [];
    const cbNew = createChatBrain({
      safeStorage: stubSafeStorage(), dir: dirNew, ownerAdmin: true, provider: PROVIDERS.openrouter,
      fetchImpl: stubFetch({ capture: capNew }), log: () => {},
      // Mirror the REAL main.js buildChatBrain wiring exactly (main.js:1910-1911): getRoute/getRoles pass NO
      // providerDefaults -- chat-brain's own providerDefaultFor is what supplies the free table ids to a new user.
      getRoute: (dm) => resolveRoles({}, dm).roles.do,
      getRoles: (dm, models) => resolveRoles({}, dm, models).roles,
      onUsage: (rec) => usageNew.push(rec),
    });
    ok(cbNew.legacyOpenRouter === false && cbNew.defaultModel === PROVIDERS.openrouter.models.do, 'round2: a new OpenRouter user gets the free table Do id', cbNew.defaultModel);
    await cbNew.turn({ message: 'hello', history: [] });
    ok(JSON.parse(capNew[0].opts.body).model === PROVIDERS.openrouter.models.do, 'round2: the new-user Do send is the free table id');
    await cbNew.turnStream({ turnId: 'n'.repeat(32), message: 'q'.repeat(220), history: [] });
    const planNew = usageNew.find((u) => u.kind === 'plan');
    ok(planNew && planNew.model === PROVIDERS.openrouter.models.plan, 'round2: a new-user unset role gets the free table id', JSON.stringify(planNew));

    // r2b. a legacy chatModel (an OpenRouter-only id) is never sent to another provider.
    for (const id of ['groq', 'gemini']) {
      const d = tmpDir();
      const p = PROVIDERS[id];
      createKeyStore({ safeStorage: stubSafeStorage(), dir: d, name: p.keyName, shape: p.keyShape }).write(FAKE[id]);
      const cap2 = [];
      const cb2 = createChatBrain({ safeStorage: stubSafeStorage(), dir: d, ownerAdmin: true, provider: p, model: MODEL, legacyDefaults: true, fetchImpl: stubFetch({ capture: cap2 }), log: () => {} });
      ok(cb2.defaultModel === p.models.do, `round2: a legacy chatModel (${MODEL}) is ignored on ${id} -> the table Do id`, cb2.defaultModel);
      await cb2.turn({ message: 'hello', history: [] });
      ok(JSON.parse(cap2[0].opts.body).model === p.models.do, `round2: the OpenRouter-only chatModel is never POSTed to ${id}`, JSON.stringify(cap2.map((c) => c.url)));
    }
  }

  // ---------- 4. an existing OpenRouter user stays on OpenRouter ----------
  {
    ok(resolveProviderId(undefined, true) === 'openrouter', 'resolve: no choice + an OpenRouter key on disk -> openrouter (migration-free)');
    ok(resolveProviderId('', true) === 'openrouter' && resolveProviderId('nonsense', true) === 'openrouter', 'resolve: an unknown/empty stored value + a key -> openrouter');
    ok(resolveProviderId(undefined, false) === DEFAULT_PROVIDER, 'resolve: no choice + no key -> the default (gemini)');
    ok(resolveProviderId('groq', false) === 'groq' && resolveProviderId('gemini', true) === 'gemini', 'resolve: the user\'s own choice always wins');
    ok(resolveProviderId('nonsense', false) === DEFAULT_PROVIDER, 'resolve: an unknown value with no key -> the default');
  }

  // ---------- 6. wiring ----------
  {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    const director = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'talk', 'director.js'), 'utf8');
    ok(/ipcMain\.handle\('ai:set-provider'[\s\S]{0,1400}switchRoleSlots\(/.test(main) && !/ai:set-provider'[\s\S]{0,500}roleModels: \{\}/.test(main), 'main: switching provider MOVES per-provider role slots (no longer wipes the role choices)');
    ok(/ai: \{\s*provider: \(\) =>[\s\S]{0,200}setProvider:[\s\S]{0,160}testKey:[\s\S]{0,160}openKeyPage:/.test(preload), 'preload: zumi.ai exposes provider / setProvider / testKey / openKeyPage');
    ok(director.includes('failureLineKey') && /tr\(failureLineKey\(r && r\.error\)/.test(director),
      'director: a failed turn asks error-line.js which line to show (no inline code guesses)');
    const errLine = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'talk', 'error-line.js'), 'utf8');
    ok(['auth', 'credit', 'quota'].every((c) => errLine.includes(`'${c}'`)) && errLine.includes("'app.replyFailed'"),
      'error-line: auth / credit / quota / everything-else map to their i18n keys');
    ok(errLine.includes("'app.quota'") && /error\.free === true/.test(errLine),
      'error-line: a 429 keeps the free-quota line only when main marked it free-tier (gemini/groq)');
    ok(/free: aiProviderId\(\) === 'gemini' \|\| aiProviderId\(\) === 'groq'/.test(main), 'main: the quota error says "free quota" only for the free-tier providers (gemini/groq); paid OpenRouter/OpenCode get the neutral line');
    ok(['en', 'vi', 'zh'].every((l) => TABLES[l]['app.quota'].includes('{provider}')), 'i18n: the free-tier quota line names the provider in en/vi/zh');
    ok(['en', 'vi', 'zh'].every((l) => !('app.quotaPaid' in TABLES[l]) && !('app.opencodeCredit' in TABLES[l])),
      'i18n: app.quotaPaid / app.opencodeCredit are removed (no orphans; the busy line replaces them)');
    ok(/ai:set-provider[\s\S]{0,1600}rebuildChatBrain\(\)/.test(main), 'main: switching provider rebuilds the chat brain (no restart)');
    const statusKeys = ['settings.keyUnchecked', 'settings.keyBadFormat', 'settings.keyRejected', 'settings.keyCheckUnreachable', 'settings.keyStoredRejected'];
    ok(statusKeys.every((k) => ['en', 'vi', 'zh'].every((l) => TABLES[l][k].includes('{provider}'))), 'i18n: every key-status line names the active provider (no hardcoded vendor)');
    ok(['en', 'vi', 'zh'].every((l) => TABLES[l]['settings.keyBadFormat'].includes('{prefix}')), 'i18n: the bad-format line names the provider key prefix');
    const viKeys = Object.keys(TABLES.vi).filter((k) => /^(settings\.(ownKey|ownKeyPh|ownKeyEndingD|ownKeyNoneD|chipNoKey|brainFoot|keyChecking|keyWorks|keyNoEncryption|keyCleared)|app\.noGoogleKey)$/.test(k));
    ok(viKeys.length >= 8 && viKeys.every((k) => !/khóa/i.test(TABLES.vi[k])), `i18n: the BYOK key strings say "khoá" consistently (${viKeys.length} checked)`, JSON.stringify(viKeys.filter((k) => /khóa/i.test(TABLES.vi[k]))));
  }

  // ---------- T-31 OpenCode BYOK: the two-choice header (Dùng miễn phí / Tự nhập khoá) + OpenCode wiring ----------
  {
    // 1. the free list (CORRECTION 17-10: OpenCode is paid, so it is NOT here) and the free annotations the picker shows.
    ok(JSON.stringify(FREE_PROVIDER_IDS) === '["gemini","groq","openrouter"]', 'two-choice: the free list is Gemini, Groq, OpenRouter, in that order', JSON.stringify(FREE_PROVIDER_IDS));
    ok(FREE_PROVIDER_IDS.every(isProviderId) && new Set(FREE_PROVIDER_IDS).size === FREE_PROVIDER_IDS.length
      && !FREE_PROVIDER_IDS.includes('opencode') && PROVIDER_IDS.includes('opencode'),
      'two-choice: every free id is a real provider, and paid OpenCode is BYOK-only (not in the free list)',
      JSON.stringify({ free: FREE_PROVIDER_IDS, all: PROVIDER_IDS }));
    ok(isMode('free') && isMode('byok') && !isMode('nonsense') && !isMode(undefined), 'two-choice: the only modes are "free" and "byok"');
    ok(providerIdsForMode('byok') === PROVIDER_IDS && providerIdsForMode('free') === FREE_PROVIDER_IDS && providerIdsForMode('nonsense') === FREE_PROVIDER_IDS
      && !providerIdsForMode('free').includes('opencode'),
      'two-choice: byok lists every provider, free lists the free ones with no OpenCode (an unknown mode falls back to free)');
    ok(PROVIDERS.gemini.freeNote === 'settings.freeNoCard' && PROVIDERS.openrouter.freeLabel === 'OpenRouter free'
      && PROVIDERS.opencode.freeLabel === undefined && PROVIDERS.opencode.freeNote === undefined,
      'two-choice: Gemini says "no card", OpenRouter reads "OpenRouter free", and OpenCode carries no free annotation',
      JSON.stringify(PROVIDER_IDS.map((id) => [id, PROVIDERS[id].freeLabel, PROVIDERS[id].freeNote])));

    // ---------- follow-up item 1: free mode never lists or selects OpenCode ----------
    // A profile saved while OpenCode WAS in the free list can still read mode "free" + provider "opencode". The mode the
    // picker shows is pickerMode(): OpenCode is paid, so such a profile is shown in "Tự nhập khoá" with OpenCode selected.
    ok(pickerMode('free', 'opencode') === 'byok' && pickerMode('byok', 'opencode') === 'byok',
      'free-list: a profile on "free" with OpenCode pinned is shown in "Tự nhập khoá" (pickerMode)', pickerMode('free', 'opencode'));
    ok(pickerMode('free', 'gemini') === 'free' && pickerMode('byok', 'groq') === 'byok' && pickerMode('nonsense', 'gemini') === 'free',
      'free-list: pickerMode leaves every other provider in its stored mode (unknown mode -> free)',
      JSON.stringify([pickerMode('free', 'gemini'), pickerMode('byok', 'groq'), pickerMode('nonsense', 'gemini')]));
    ok(!providerIdsForMode('free').includes('opencode') && !providerIdsForMode(pickerMode('free', 'gemini')).includes('opencode'),
      'free-list: the shown free list never contains OpenCode');
    // The pinned-OpenCode-on-free profile is shown in the byok list (OpenCode there because it is pinned + paid, not
    // because free mode selects it), so the picker can show it with OpenCode selected.
    const pinnedList = providerIdsForMode(pickerMode('free', 'opencode'));
    ok(pinnedList === PROVIDER_IDS && pinnedList.includes('opencode'),
      'free-list: the pinned-OpenCode profile shows the byok list (OpenCode selected), never the free list', JSON.stringify(pinnedList));
    { // wiring: the card reads pickerMode(mode, providerId) for both the option list and the pressed header button.
      const cardSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'brain-key-card.js'), 'utf8');
      ok(/const shown = pickerMode\(mode, providerId\)[\s\S]{0,220}providerIdsForMode\(shown\)/.test(cardSrc) && /const shown = pickerMode\(mode, providerId\)[\s\S]{0,220}aria-pressed', shown === 'byok'/.test(cardSrc),
        'free-list: the card builds the picker from pickerMode(mode, providerId) and paints the shown mode');
    }

    // 2. behaviour tests (T-31 fix round item 4): the mode default, the legacy pin, the wrong-vendor key refusal, the
    //    unreachable-save confirmation, and label-vs-model in free mode -- driven through the real code paths (the
    //    pure helpers main.js calls, createBrainKey.save, createChatBrain) instead of grepping main.js source.
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    // (a) a NEW user defaults to "free" + Gemini.
    ok(resolveMode(undefined, false) === 'free' && resolveMode('', false) === 'free' && resolveMode('nonsense', false) === 'free'
      && resolveProviderId(undefined, false) === DEFAULT_PROVIDER && DEFAULT_PROVIDER === 'gemini',
      'behaviour: a new user defaults to "free" + Gemini');
    ok(resolveMode('byok', false) === 'byok', 'behaviour: a stored mode always wins');
    // (b) a legacy (pre-BYOK) user stays on "Tự nhập khoá" (byok) and keeps their pinned provider.
    ok(resolveMode(undefined, true) === 'byok' && resolveProviderId('openrouter', true) === 'openrouter',
      'behaviour: a legacy user stays on "Tự nhập khoá" (byok) and keeps their pinned OpenRouter provider');
    ok(resolveMode('free', true) === 'free', 'behaviour: a legacy user who explicitly chose "free" stays on free');
    // (c) another vendor's key is refused for OpenCode THROUGH the save path (shape check, before any network).
    {
      const dir = tmpDir();
      const bk = createBrainKey({ safeStorage: stubSafeStorage(), dir, getProvider: () => 'opencode', fetchImpl: stubFetch({ status: 200 }) });
      const g = await bk.save(`AIza${'a'.repeat(35)}`);
      const o = await bk.save(`sk-or-v1-${'b'.repeat(48)}`);
      const q = await bk.save(`gsk_${'c'.repeat(48)}`);
      ok([g, o, q].every((r) => !r.ok && r.error === 'bad_format') && !bk.status().saved,
        'behaviour: through the save path, a Gemini/OpenRouter/Groq key is refused for OpenCode (bad_format, nothing stored)',
        JSON.stringify([g.error, o.error, q.error]));
    }
    // (d) an unreachable key test does NOT save the key without the explicit confirmation -- for every provider.
    for (const id of PROVIDER_IDS) {
      const dir = tmpDir();
      const dead = () => Promise.reject(new Error('offline'));
      const bk = createBrainKey({ safeStorage: stubSafeStorage(), dir, getProvider: () => id, fetchImpl: dead });
      const r1 = await bk.save(FAKE[id]);
      const notSaved = !r1.ok && r1.error === 'unreachable' && r1.needsConfirm === true && !bk.status().saved;
      const r2 = await bk.save(FAKE[id], { confirmUnreachable: true });
      const confirmed = r2.ok && r2.check === 'unreachable' && bk.status().saved;
      ok(notSaved && confirmed, `behaviour: ${id} -- an unreachable test does not save without confirmation; the explicit confirm saves it`);
    }
    // (e) in free mode a legacy OpenRouter user sends the table's FREE model, and the picker label says so.
    {
      ok(effectiveLegacyDefaults(true, 'free') === false && effectiveLegacyDefaults(true, 'byok') === true && effectiveLegacyDefaults(false, 'byok') === false,
        'behaviour: the paid legacy defaults apply only in byok mode');
      const dir = tmpDir();
      createKeyStore({ safeStorage: stubSafeStorage(), dir, name: PROVIDERS.openrouter.keyName, shape: PROVIDERS.openrouter.keyShape }).write(FAKE.openrouter);
      const cap = [];
      const cb = createChatBrain({
        safeStorage: stubSafeStorage(), dir, ownerAdmin: true, provider: PROVIDERS.openrouter,
        legacyDefaults: effectiveLegacyDefaults(true, 'free'), // free mode: a legacy user
        fetchImpl: stubFetch({ capture: cap }), log: () => {},
      });
      ok(cb.legacyOpenRouter === false && cb.defaultModel === PROVIDERS.openrouter.models.do,
        'behaviour: a legacy user in free mode defaults to the table free Do id', cb.defaultModel);
      await cb.turn({ message: 'hello', history: [] });
      ok(JSON.parse(cap[0].opts.body).model === PROVIDERS.openrouter.models.do,
        'behaviour: the free-mode send is the table free id (never the paid legacy model)');
      ok(optionLabel('openrouter', 'free', (k) => k) === 'OpenRouter free' && optionLabel('openrouter', 'byok', (k) => k) === 'OpenRouter',
        'behaviour: the free-mode label reads "OpenRouter free" and matches the free model sent; byok reads the plain label');
    }
    // The pure helpers above ARE the shipped ones.
    ok(/resolveMode, effectiveLegacyDefaults/.test(main) && /aiLegacyDefaults\(\)/.test(main),
      'wiring: main.js imports and uses the pure mode/legacy helpers the behaviour tests exercise');

    // 3. the preload + renderer wiring.
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    const card = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'brain-key-card.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
    ok(/setMode: \(mode\) => ipcRenderer\.invoke\('ai:set-mode', mode\)/.test(preload), 'two-choice: preload exposes ai.setMode');
    ok(/providerIdsForMode/.test(card) && /optionLabel/.test(card) && /aria-pressed/.test(card),
      'two-choice: the card builds the picker from providerIdsForMode and paints the aria-pressed choice');
    ok(/id="brain-mode-free"[\s\S]{0,220}id="brain-mode-byok"/.test(html) && /id="brain-notice"/.test(html) && !/id="brain-train-notice"/.test(html),
      'two-choice: the markup carries the two mode buttons and the JS-owned notice element');
    ok(!/role="tab"/.test(html.slice(html.indexOf('id="brain-mode-row"'), html.indexOf('id="brain-mode-row"') + 400)),
      'two-choice: the mode buttons are NOT tabs (the settings tab count stays 6)');

    // 4. i18n: every new key exists, non-empty, in en/vi/zh; the OpenCode notice is the paid (17-10) wording.
    const KEYS = ['settings.aiMode', 'settings.aiModeD', 'settings.modeFree', 'settings.modeByok', 'settings.freeNoCard', 'settings.opencodeNotice', 'settings.keyBadFormatNoPrefix', 'settings.saveAnyway', 'settings.keyUnreachableNoSave'];
    ok(KEYS.every((k) => ['en', 'vi', 'zh'].every((l) => typeof TABLES[l][k] === 'string' && TABLES[l][k].trim())),
      'two-choice: every new i18n key exists and is non-empty in en/vi/zh', JSON.stringify(KEYS.filter((k) => !['en', 'vi', 'zh'].every((l) => TABLES[l][k]))));
    // p3: the OpenCode notice says paid/credits in all three languages, with no free wording.
    ok(['en', 'vi', 'zh'].every((l) => /credit|tín dụng|额度|trả phí|付费/i.test(TABLES[l]['settings.opencodeNotice']))
      && ['en', 'vi', 'zh'].every((l) => !/\bfree\b|miễn phí|免费/i.test(TABLES[l]['settings.opencodeNotice'])),
      'paid: the OpenCode notice says paid/Console credits in en/vi/zh and never calls OpenCode free',
      JSON.stringify(['en', 'vi', 'zh'].map((l) => TABLES[l]['settings.opencodeNotice'])));
    {
      // Box re-probe 2044691: "does not look like a OpenRouter key". The article follows the provider's name.
      const line = (key, provider, prefix) => TABLES.en[key].replace('{a}', indefiniteArticle(provider)).replace('{provider}', provider).replace('{prefix}', prefix);
      ok(line('settings.keyBadFormat', 'OpenRouter', 'sk-or-').startsWith('That does not look like an OpenRouter key')
        && line('settings.keyBadFormatNoPrefix', 'OpenCode', '').startsWith('That does not look like an OpenCode key')
        && line('settings.keyBadFormat', 'Groq', 'gsk_').startsWith('That does not look like a Groq key')
        && line('settings.keyBadFormat', 'Gemini', 'AIza').startsWith('That does not look like a Gemini key'),
        'i18n: the English bad-format line says "an OpenRouter key" / "a Groq key" (article follows the provider name)',
        JSON.stringify(['OpenRouter', 'OpenCode', 'Groq', 'Gemini'].map((p) => line('settings.keyBadFormat', p, 'x'))));
      ok(['vi', 'zh'].every((l) => !TABLES[l]['settings.keyBadFormat'].includes('{a}')) && TABLES.vi['settings.keyBadFormat'].startsWith('Chuỗi này không giống khoá {provider}') && TABLES.zh['settings.keyBadFormat'].startsWith('这看起来不是 {provider} 密钥'),
        'i18n: vi and zh need no article and read naturally');
    }
    ok(TABLES.en['settings.keyBadFormatNoPrefix'].includes('{provider}') && !TABLES.en['settings.keyBadFormatNoPrefix'].includes('{prefix}'),
      'two-choice: the prefix-less bad-format line names the provider but no prefix');

    // p3: no guide step presents OpenCode as free (EN/VI/ZH).
    ok(['en', 'vi', 'zh'].every((l) => (PROVIDERS.opencode.guide[l] || []).every((s) => !/\bfree\b|miễn phí|免费|\$0\b/i.test(s))),
      'paid: no OpenCode guide step claims it is free',
      JSON.stringify(PROVIDERS.opencode.guide.en.filter((s) => /\bfree\b|miễn phí|免费|\$0\b/i.test(s))));

    // ---------- follow-up item 2: the OpenCode "Test key" step only checks the key, never that chat works ----------
    // measured 17-10: the key-test GET returns 200 at zero balance, so a green test does NOT mean chat works -- chat
    // also needs credit in the OpenCode Console. The guide step must say so (EN/VI/ZH).
    const testStep = (l) => (PROVIDERS.opencode.guide[l] || []).find((s) => /test key|thử khoá|测试密钥/i.test(s)) || '';
    ok(['en', 'vi', 'zh'].every((l) => !/chat is on|chat đã bật|聊天已开启/i.test(testStep(l))),
      'guide: the OpenCode key-test step no longer claims a green test means chat works',
      JSON.stringify(['en', 'vi', 'zh'].map((l) => `${l} => ${testStep(l)}`)));
    ok(['en', 'vi', 'zh'].every((l) => /only checks the key|chỉ kiểm tra khoá|只检查密钥/i.test(testStep(l))),
      'guide: the OpenCode key-test step says the test only checks the key',
      JSON.stringify(['en', 'vi', 'zh'].map((l) => testStep(l))));
    ok(['en', 'vi', 'zh'].every((l) => /credit|额度/i.test(testStep(l)) && /console/i.test(testStep(l))),
      'guide: the OpenCode key-test step says chat also needs credit in the OpenCode Console',
      JSON.stringify(['en', 'vi', 'zh'].map((l) => testStep(l))));

    // 5. quota wording is free-tier only (CORRECTION 17-10: OpenCode, now paid, gets the neutral line).
    ok(/free: aiProviderId\(\) === 'gemini' \|\| aiProviderId\(\) === 'groq'/.test(main),
      'quota: main stamps free=true only for gemini/groq (paid OpenRouter and OpenCode get the neutral line)');
    ok(PROVIDERS.opencode.label === 'OpenCode' && !FREE_PROVIDER_IDS.includes('opencode'),
      'quota: OpenCode is paid, so its 429 is never read as free-tier quota');
    ok(['en', 'vi', 'zh'].every((l) => TABLES[l]['app.quota'].includes('{provider}')), 'quota: the free-quota line names the provider in en/vi/zh');

    // ---------- p4. provider failures -> the code the chat shows (20-10: auth / credit / quota / upstream) ----------
    {
      const expectCode = async (id, status, body = '{}') => {
        const dir = tmpDir();
        const p = PROVIDERS[id];
        createKeyStore({ safeStorage: stubSafeStorage(), dir, name: p.keyName, shape: p.keyShape }).write(FAKE[id]);
        const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, provider: p, ownerAdmin: true, fetchImpl: stubFetch({ status, body }), log: () => {} });
        const r = await cb.turn({ message: 'hello', history: [] });
        return r && r.error && r.error.code;
      };
      ok(await expectCode('opencode', 402, '{"error":{"message":"Upstream request failed: Insufficient account funds"}}') === 'credit',
        'credit: an OpenCode 402 -> error code "credit" (the money line)');
      ok(await expectCode('groq', 402) === 'credit', 'credit: a 402 from ANY provider is "credit" (money, not the key)');
      ok(await expectCode('opencode', 401) === 'auth' && await expectCode('opencode', 403) === 'auth',
        'auth: 401/403 -> error code "auth" (the check-your-key line)');
      ok(await expectCode('opencode', 400, 'Insufficient account funds') === 'credit',
        'credit: an insufficient-funds body under another status is still "credit"');
      ok(await expectCode('opencode', 500, '{"error":{"message":"boom"}}') === 'upstream',
        'upstream: a generic 5xx stays "upstream"');
      // A streamed 402 hits the no-fallback path: the head must carry the same 'credit' code and be non-retryable.
      const dir = tmpDir();
      createKeyStore({ safeStorage: stubSafeStorage(), dir, name: PROVIDERS.opencode.keyName, shape: PROVIDERS.opencode.keyShape }).write(FAKE.opencode);
      const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, provider: PROVIDERS.opencode, ownerAdmin: true, fetchImpl: stubFetch({ status: 402 }), log: () => {} });
      const { head } = await cb.turnStream({ turnId: 'c'.repeat(32), message: 'hello', history: [] });
      ok(head && head.error && head.error.code === 'credit' && head.error.retryable === false,
        'credit: a streamed 402 -> head error code "credit", retryable false', JSON.stringify(head && head.error));
      // i18n + wiring: the lines exist in all three languages, and main/chat-brain carry the credit code.
      ok(['en', 'vi', 'zh'].every((l) => typeof TABLES[l]['app.creditOut'] === 'string' && TABLES[l]['app.creditOut'].length > 10),
        'credit: app.creditOut exists in en/vi/zh', JSON.stringify(['en', 'vi', 'zh'].map((l) => TABLES[l]['app.creditOut'])));
      ok(TABLES.vi['app.creditOut'] === 'Tài khoản nhà cung cấp hết tiền — nạp thêm hoặc đổi nhà cung cấp',
        'credit: the VI line is the owner\'s "hết tiền" wording');
      ok(TABLES.vi['app.keyRefused'] === 'Khoá không hợp lệ hoặc không có quyền — kiểm tra lại khoá trong Cài đặt',
        'auth: the VI line is the owner\'s "khoá không hợp lệ" wording');
      const chat = fs.readFileSync(path.join(ROOT, 'src', 'main', 'chat-brain.js'), 'utf8');
      ok(/classifyUpstreamError/.test(chat) && /failureOf = \(r\) => classifyUpstreamError\(r\.status, r\.insufficient === true\)/.test(chat),
        'credit: chat-brain classifies every provider failure in one place');
      ok(!/head\.error\.code === 'credit'/.test(main), 'credit: main does not stamp an unused provider field onto the credit error (the owner-approved line is generic)');
    }

    // ---------- p5. a saved *-free OpenCode role id is rewritten at load ----------
    {
      ok(paidOpencodeModel('deepseek-v4.1-flash-free') === 'deepseek-v4.1-flash'
        && paidOpencodeModel('glm-5.3-flash-free') === OPENCODE_PAID_MODEL && paidOpencodeModel('deepseek-v4.1-flash') === 'deepseek-v4.1-flash',
        'migration: the retired free ids map to the paid id; a paid id is unchanged');
      const slot = { plan: { model: 'glm-5.3-flash-free', effort: 'low' }, do: { model: 'deepseek-v4.1-flash-free', effort: 'off' }, off: ['check'] };
      const out = migrateOpencodeRoleModels(slot);
      ok(out.plan.model === OPENCODE_PAID_MODEL && out.do.model === OPENCODE_PAID_MODEL && out.plan.effort === 'low' && out.off === slot.off,
        'migration: every free role id becomes the paid id; effort and the off list are untouched', JSON.stringify(out));
      const paidSlot = { do: { model: 'deepseek-v4.1-flash', effort: 'off' } };
      ok(migrateOpencodeRoleModels(paidSlot) === paidSlot && migrateOpencodeRoleModels(null) === null,
        'migration: a slot with no free id is returned unchanged (same object), and null is safe');
      ok(/aiProvider === 'opencode'[\s\S]{0,400}migrateOpencodeRoleModels\(s\.roleModels\)/.test(main)
        && /roleModelsByProvider[\s\S]{0,200}migrateOpencodeRoleModels\(by\.opencode\)/.test(main)
        && /^\s*migrateOpencodeModels\(\);/m.test(main),
        'migration: main rewrites the live slots when OpenCode is active and the OpenCode snapshot, once at startup');
    }
  }

  // ---------- T-31 free-click: "Dùng miễn phí" while OpenCode is pinned visibly switches to free + Gemini ----------
  // The card is driven through the REAL module with a tiny DOM stub and a fake zumi surface, so the click path, the
  // pressed header button and the picked provider are observed end-to-end (no Electron, no network).
  {
    const makeEl = () => {
      const e = {
        value: '', hidden: false, disabled: false, className: '', placeholder: '',
        children: [], attrs: {}, handlers: {}, _text: '',
        appendChild(c) { this.children.push(c); },
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
        addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
        focus() {},
        click() { let p; for (const fn of (this.handlers.click || [])) p = fn(); return p; },
        change() { let p; for (const fn of (this.handlers.change || [])) p = fn(); return p; },
      };
      // Like a real <select>: assigning textContent = '' clears the options, so a repaint never accumulates duplicates.
      Object.defineProperty(e, 'textContent', { get() { return this._text; }, set(v) { this._text = v; if (v === '') this.children = []; } });
      return e;
    };
    // A card wired to a fake zumi + a stub DOM. state mirrors what main would persist (mode + provider).
    const makeCard = (init) => {
      const els = new Map();
      const $ = (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };
      const state = { mode: init.mode, provider: init.provider, setProviderOk: init.setProviderOk !== false, setModeCalls: [] };
      const zumi = {
        ai: {
          provider: async () => ({ id: state.provider, label: PROVIDERS[state.provider].label, mode: state.mode }),
          setMode: async (m) => { state.mode = m; state.setModeCalls.push(m); return { ok: true, mode: m }; },
          setProvider: async (id) => {
            if (!state.setProviderOk) return { ok: false, error: 'bad_provider' };
            state.provider = id; return { ok: true, id, label: PROVIDERS[id].label };
          },
        },
        brainKey: { status: async () => ({ provider: state.provider, saved: false, last4: null, checked: null }) },
      };
      return { card: initBrainKey(zumi, $), state, elFor: $ };
    };
    const prevDoc = global.document, prevCE = global.CustomEvent;
    global.document = { createElement: () => makeEl(), dispatchEvent: () => true, documentElement: {} };
    global.CustomEvent = class { constructor(type) { this.type = type; } };
    try {
      // (a) free click while OpenCode is active (stored byok): the provider moves to the free default (Gemini).
      {
        const { card, state, elFor } = makeCard({ mode: 'byok', provider: 'opencode' });
        await card.refresh();
        await elFor('brain-mode-free').click();
        ok(state.mode === 'free' && state.provider === 'gemini'
          && elFor('brain-mode-free').getAttribute('aria-pressed') === 'true' && elFor('brain-mode-byok').getAttribute('aria-pressed') === 'false',
          'free-click: tapping "Dùng miễn phí" with OpenCode active switches to free + Gemini and presses the free button',
          JSON.stringify({ mode: state.mode, provider: state.provider, pressed: [elFor('brain-mode-free').getAttribute('aria-pressed'), elFor('brain-mode-byok').getAttribute('aria-pressed')] }));
      }
      // (b) stored mode already "free" + OpenCode pinned (migrated legacy): same result (no early return on stored mode).
      {
        const { card, state, elFor } = makeCard({ mode: 'free', provider: 'opencode' });
        await card.refresh();
        await elFor('brain-mode-free').click();
        ok(state.mode === 'free' && state.provider === 'gemini' && elFor('brain-mode-free').getAttribute('aria-pressed') === 'true',
          'free-click: a stored free mode pinned to OpenCode still moves to free + Gemini on the free click (no early return)',
          JSON.stringify({ mode: state.mode, provider: state.provider }));
      }
      // (c) setProvider refused: the previous mode and provider are kept, and the byok button stays pressed.
      {
        const { card, state, elFor } = makeCard({ mode: 'byok', provider: 'opencode', setProviderOk: false });
        await card.refresh();
        await elFor('brain-mode-free').click();
        ok(state.mode === 'byok' && state.provider === 'opencode'
          && elFor('brain-mode-byok').getAttribute('aria-pressed') === 'true' && elFor('brain-mode-free').getAttribute('aria-pressed') === 'false',
          'free-click: a refused provider switch restores the previous mode and keeps OpenCode (byok stays pressed)',
          JSON.stringify({ mode: state.mode, provider: state.provider, setModeCalls: state.setModeCalls }));
      }
      // (d) the option labels follow the SHOWN mode, so they never disagree with the pressed header button.
      {
        const { card, elFor } = makeCard({ mode: 'free', provider: 'opencode' });
        await card.refresh();
        const gem = elFor('brain-provider').children.find((o) => o.value === 'gemini');
        ok(elFor('brain-mode-free').getAttribute('aria-pressed') === 'false' && Boolean(gem) && gem.textContent === PROVIDERS.gemini.label,
          'free-click: while OpenCode is pinned (shown byok) the option labels are the plain labels, never the free wording',
          JSON.stringify({ pressed: elFor('brain-mode-free').getAttribute('aria-pressed'), gem: gem && gem.textContent }));
      }
      // (e) the byok button still persists byok for a stored-free profile pinned to OpenCode (the shown-mode guard alone
      //     must not swallow it and leave stored free while the UI claims byok).
      {
        const { card, state, elFor } = makeCard({ mode: 'free', provider: 'opencode' });
        await card.refresh();
        await elFor('brain-mode-byok').click();
        ok(state.mode === 'byok' && state.setModeCalls.includes('byok') && elFor('brain-mode-byok').getAttribute('aria-pressed') === 'true',
          'free-click: tapping "Tự nhập khoá" on a stored-free OpenCode profile persists byok (shown-mode guard alone would swallow it)',
          JSON.stringify({ mode: state.mode, setModeCalls: state.setModeCalls }));
      }
      // (f) changing provider with the picker repaints the header + labels, so the shown mode and the pressed button stay
      //     in step (OpenCode pinned free profile -> pick Gemini -> the free button lights and the free labels show).
      {
        const { card, state, elFor } = makeCard({ mode: 'free', provider: 'opencode' });
        await card.refresh();
        elFor('brain-provider').value = 'gemini';
        await elFor('brain-provider').change();
        const gem = elFor('brain-provider').children.find((o) => o.value === 'gemini');
        ok(state.provider === 'gemini' && elFor('brain-mode-free').getAttribute('aria-pressed') === 'true'
          && elFor('brain-mode-byok').getAttribute('aria-pressed') === 'false'
          && Boolean(gem) && gem.textContent === optionLabel('gemini', 'free', (k) => TABLES.en[k] || k),
          'free-click: a provider change repaints the header + labels (free button lights once the shown mode is free)',
          JSON.stringify({ provider: state.provider, pressed: [elFor('brain-mode-free').getAttribute('aria-pressed'), elFor('brain-mode-byok').getAttribute('aria-pressed')], gem: gem && gem.textContent }));
      }
    } finally { global.document = prevDoc; global.CustomEvent = prevCE; }
  }
} finally {
  /* nothing to close: no server, no sockets */
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? `FAIL check-byok — ${fail} failed` : `PASS check-byok — ${pass}/${pass} assertions passed`);
process.exitCode = fail ? 1 : 0;
