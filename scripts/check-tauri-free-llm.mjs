// T-31 free LLM BYOK presets (BRIEF-free-llm FL-1). Plain Node, no app, NO network: every fetch is a recorder.
//
//   node scripts/check-tauri-free-llm.mjs   (exit 1 on any failure)
//
// FL-1 (this file today): the preset layer, its order, the Account ID validation, the egress allow-list, and the fact
// that no key material ships. FL-2 extends this script with the notices, the 18+ confirm and the Electron DOM check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createAiSettings } from '../tauri/sidecar/ai-settings.mjs';
import { PROVIDER_ORIGINS, providerFetch, guardedFetch } from '../tauri/sidecar/egress.mjs';
import {
  CLOUDFLARE_BASE_URL_TEMPLATE, CLOUDFLARE_ACCOUNT_ID_RE, validateCloudflareAccountId, cloudflareBaseUrl,
  registerTauriPresets, tauriProviders, resolveTauriProvider,
  TAURI_FREE_PRESETS, TAURI_ADVANCED_PRESETS, TAURI_PRESET_ORDER, TAURI_ADVANCED_ORDER, TAURI_EXTRA_PROVIDERS,
  presetList, PRESET_LIMIT_GUIDES, presetLimitGuideId,
} from '../tauri/sidecar/free-llm-presets.mjs';
import { createChatHost } from '../tauri/sidecar/chat-host.mjs';
import { createAiCore } from '../tauri/sidecar/ai-core.mjs';
import { createSecretStores } from '../tauri/sidecar/secret-stores.mjs';
import { FLAVOURS } from '../tauri/sidecar/flavour.mjs';
// FL-2/FL-3 drive the REAL card module in a CHILD process (free-llm-renderer-check.mjs): importing the sidecar
// preset layer here extends the shared CJS PROVIDERS table, which would hide the exact R2 defect. The child never
// imports the sidecar layer; it receives the sidecar's actual `ai.presetList` answer as its rpc stub.
import { FREE_LLM_UI } from '../src/renderer/brain-key-card.js';
import { TABLES } from '../src/renderer/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const frozen = require('../src/main/providers.js');
const { PROVIDERS } = frozen;
const { createKeyStore } = require('../src/main/reflex-jev.js');
const PRESET_SRC = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'free-llm-presets.mjs'), 'utf8');
const PRESET_CODE = PRESET_SRC.replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function recorder(status = 200) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status, json: async () => ({}), text: async () => '' }; };
  f.calls = calls;
  return f;
}
const codeOf = async (p) => { try { await p(); return null; } catch (e) { return e.message; } };

// ---- 1. the preset set and its order (RESEARCH section 3 + Opus review corrections) ----
{
  ok(same(TAURI_PRESET_ORDER, ['gemini', 'groq', 'openrouter', 'cloudflare']), 'the four default presets are Gemini, Groq, OpenRouter, Cloudflare in that order', JSON.stringify(TAURI_PRESET_ORDER));
  ok(same(TAURI_ADVANCED_ORDER, ['mistral']), 'Mistral is the only advanced entry (never a default)', JSON.stringify(TAURI_ADVANCED_ORDER));
  ok(TAURI_FREE_PRESETS.every((p) => p.advanced === false) && TAURI_ADVANCED_PRESETS.every((p) => p.advanced === true), 'the free list has no advanced flag and the advanced list has no default');
  ok(!TAURI_PRESET_ORDER.includes('mistral'), 'Mistral is not in the default order');
  ok(TAURI_PRESET_ORDER.every((id) => Object.prototype.hasOwnProperty.call(TAURI_EXTRA_PROVIDERS, id) || Object.prototype.hasOwnProperty.call(frozen.PROVIDERS, id)), 'every default preset resolves to a provider descriptor');

  const urls = {
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    groq: 'https://api.groq.com/openai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    cloudflare: CLOUDFLARE_BASE_URL_TEMPLATE,
    mistral: 'https://api.mistral.ai/v1',
  };
  const wrong = Object.entries(urls).filter(([id, url]) => (tauriProviders()[id] || {}).baseURL !== url);
  ok(wrong.length === 0, 'each preset carries the RESEARCH section 3 base URL', JSON.stringify(wrong));

  const models = [...TAURI_FREE_PRESETS, ...TAURI_ADVANCED_PRESETS].filter((p) => !Object.values(tauriProviders()[p.id].models).includes(p.defaultModel));
  ok(models.length === 0, 'each preset default model is one the provider table actually sends', JSON.stringify(models.map((p) => p.id)));
  ok(TAURI_FREE_PRESETS.find((p) => p.id === 'openrouter').defaultModel === 'openrouter/free', "OpenRouter's default is the official `openrouter/free` router (Opus correction)");
  ok(TAURI_FREE_PRESETS.find((p) => p.id === 'cloudflare').requiresAccountId === true && TAURI_FREE_PRESETS.filter((p) => p.requiresAccountId).length === 1, 'only Cloudflare asks for the extra Account ID field');
}

// ---- 2. Z.ai is not added (RESEARCH "## Z.ai check (22-10)": DO NOT ADD) ----
{
  ok(!/z\.?ai\b|\bglm\b/i.test(PRESET_CODE), 'the preset layer names neither Z.ai nor a GLM model');
  ok(!TAURI_PRESET_ORDER.includes('zai') && !TAURI_ADVANCED_ORDER.includes('zai') && !Object.prototype.hasOwnProperty.call(tauriProviders(), 'zai'), 'no Z.ai provider entry exists');
}

// ---- 3. no bundled key material anywhere in the preset layer ----
{
  const KEY_LIKE = [
    [/AIza[0-9A-Za-z_-]{20,}/, 'Gemini-shaped key'],
    [/gsk_[A-Za-z0-9_-]{10,}/, 'Groq-shaped key'],
    [/sk-or-[A-Za-z0-9_-]{10,}/, 'OpenRouter-shaped key'],
    [/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9]{20,}/, 'sk-shaped key'],
    [/oc_sk_[A-Za-z0-9_-]{10,}/, 'OpenCode-shaped key'],
    [/Bearer\s+[A-Za-z0-9._-]{12,}/, 'literal bearer token'],
  ];
  const found = KEY_LIKE.filter(([re]) => re.test(PRESET_CODE)).map(([, name]) => name);
  ok(found.length === 0, 'the presets source carries no key-like literal (nothing is bundled)', found.join(', '));
  ok(Object.values(TAURI_EXTRA_PROVIDERS).every((p) => p.keyPrefix === ''), 'the new providers claim no key prefix and ship no key');
  ok(!Object.values(TAURI_EXTRA_PROVIDERS).some((p) => p.keyShape.test(`AIza${'a'.repeat(35)}`) || p.keyShape.test(`gsk_${'b'.repeat(40)}`) || p.keyShape.test(`sk-or-${'c'.repeat(40)}`)), 'the new key shapes do not accept the other vendors\' documented prefixes');
}

// ---- 4. Cloudflare Account ID: 32 hex only, validated before any URL ----
{
  const good = '0123456789abcdef0123456789abcdef';
  const bad = [
    ['../' + 'a'.repeat(29), 'path traversal'],
    ['a'.repeat(31), '31 chars'],
    ['a'.repeat(33), '33 chars'],
    ['g'.repeat(32), 'non-hex'],
    ['a'.repeat(31) + '/', 'trailing slash'],
    ['', 'empty'],
    [null, 'null'],
    [undefined, 'undefined'],
    [123, 'number'],
    ['0x' + 'a'.repeat(30), '0x prefix'],
  ];
  ok(good.length === 32 && validateCloudflareAccountId(good) && validateCloudflareAccountId(good.toUpperCase()), 'a 32-hex Account ID is accepted (case-insensitive)');
  const leaked = bad.filter(([v]) => validateCloudflareAccountId(v)).map(([, name]) => name);
  ok(leaked.length === 0, 'the Account ID validator rejects ../, non-hex, empty, null and wrong lengths', leaked.join(', '));
  ok(CLOUDFLARE_ACCOUNT_ID_RE.source === '^[0-9a-f]{32}$' && CLOUDFLARE_ACCOUNT_ID_RE.flags === 'i', 'the shape is pinned to exactly 32 hex characters');
  ok(cloudflareBaseUrl(good) === `${CLOUDFLARE_BASE_URL_TEMPLATE.replace('{ACCOUNT_ID}', good)}` && !cloudflareBaseUrl(good).includes('{'), 'a valid Account ID substitutes the URL placeholder');
  const threw = bad.filter(([v]) => { try { cloudflareBaseUrl(v); return false; } catch { return true; } }).length;
  ok(threw === bad.length, 'an invalid Account ID never produces a base URL (the substitution throws)');
  ok(!cloudflareBaseUrl(good).includes('..') && new URL(cloudflareBaseUrl(good)).origin === 'https://api.cloudflare.com', 'the produced URL stays on api.cloudflare.com and cannot carry a traversal segment');
}

// ---- 5. the resolved descriptor: valid Account ID or no base URL at all ----
{
  const good = '0123456789abcdef0123456789abcdef';
  const resolved = resolveTauriProvider('cloudflare', { cloudflareAccountId: good });
  ok(resolved.baseURL === `https://api.cloudflare.com/client/v4/accounts/${good}/ai/v1` && resolved.configError === undefined, 'resolveTauriProvider substitutes a valid Account ID');
  const missing = resolveTauriProvider('cloudflare', {});
  const traversal = resolveTauriProvider('cloudflare', { cloudflareAccountId: '../' + 'a'.repeat(29) });
  ok(missing.baseURL === null && missing.configError === 'cloudflare_account_id', 'a missing Account ID leaves NO base URL (configError set)');
  ok(traversal.baseURL === null && traversal.configError === 'cloudflare_account_id', 'a traversal-shaped Account ID leaves NO base URL');
  ok(resolveTauriProvider('gemini', {}) === frozen.PROVIDERS.gemini, 'providers that need no config resolve to the frozen descriptor unchanged');
  ok(resolveTauriProvider('nope', {}) === null, 'an unknown provider resolves to null');
}

// ---- 6. the sidecar's settings layer is wired to the extended registry ----
{
  const tmpRoot = path.join(ROOT, '.tauri-check-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'free-llm-'));
  const store = { s: {} };
  const ai = createAiSettings({ dataDir: dir, settings: () => store.s, saveSettings: (patch) => { store.s = { ...store.s, ...patch }; return store.s; } });
  ok(ai.setProvider('cloudflare').ok && ai.providerInfo().id === 'cloudflare' && ai.providerInfo().label === 'Cloudflare Workers AI', 'ai.setProvider accepts the Tauri-only Cloudflare preset');
  ok(ai.setProvider('mistral').ok && ai.providerInfo().label === 'Mistral', 'ai.setProvider accepts the advanced Mistral preset');
  ok(ai.setProvider('zai').ok === false && ai.setProvider('zai').error === 'bad_provider', 'ai.setProvider refuses Z.ai (not in the table)');
  ai.setProvider('cloudflare');
  ok(ai.provider().baseURL === null && ai.provider().configError === 'cloudflare_account_id', 'without an Account ID the active descriptor has no base URL');
  store.s = { ...store.s, cloudflareAccountId: '0123456789abcdef0123456789abcdef' };
  ok(ai.provider().baseURL === 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1', 'the Account ID from settings is substituted into the active descriptor');
  ok(frozen.isProviderId('cloudflare') && frozen.isProviderId('mistral'), 'the frozen isProviderId sees the Tauri presets (the frozen brain-key/chat-brain path resolves them)');
  ok(frozen.PROVIDERS.gemini.baseURL === 'https://generativelanguage.googleapis.com/v1beta/openai/' && frozen.PROVIDERS.openrouter.baseURL === 'https://openrouter.ai/api/v1', 'the four frozen entries are not overwritten');
  ok(registerTauriPresets(frozen.PROVIDERS) === frozen.PROVIDERS && Object.keys(TAURI_EXTRA_PROVIDERS).every((id) => frozen.PROVIDERS[id]), 'registration is idempotent and additive');
}

// ---- 7. egress: exactly the new hosts join the derived allow-list ----
{
  const expected = [
    'https://generativelanguage.googleapis.com', 'https://api.groq.com', 'https://openrouter.ai', 'https://opencode.ai',
    'https://api.cloudflare.com', 'https://api.mistral.ai',
  ];
  ok(same([...PROVIDER_ORIGINS].sort(), [...expected].sort()), 'the allow-list is the four frozen provider origins plus api.cloudflare.com and api.mistral.ai', JSON.stringify(PROVIDER_ORIGINS));
  ok(PROVIDER_ORIGINS.filter((o) => o === 'https://api.cloudflare.com').length === 1 && PROVIDER_ORIGINS.filter((o) => o === 'https://api.mistral.ai').length === 1, 'each new host appears once');

  const base = recorder();
  const guarded = guardedFetch(base, PROVIDER_ORIGINS);
  const good = '0123456789abcdef0123456789abcdef';
  await guarded(`https://api.cloudflare.com/client/v4/accounts/${good}/ai/v1/chat/completions`, { method: 'POST' });
  await guarded('https://api.mistral.ai/v1/chat/completions', { method: 'POST' });
  ok(base.calls.length === 2, 'the guard lets the two new preset endpoints through');
  ok(base.calls.every((c) => c.init.redirect === 'error'), 'the new endpoints are called with redirect:error');
  const refused = [
    ['https://api.cloudflare.com.evil.example/client/v4/accounts/x/ai/v1/chat/completions', 'look-alike'],
    ['https://api.cloudflare.com:8443/client/v4/accounts/x/ai/v1/chat/completions', 'non-default port'],
    ['https://user:pass@api.cloudflare.com/client/v4/accounts/x/ai/v1', 'userinfo'],
    ['https://api.mistral.ai.evil.example/v1/chat/completions', 'look-alike'],
  ];
  const codes = [];
  for (const [url] of refused) codes.push(await codeOf(() => guarded(url)));
  ok(codes[0] === 'egress_host' && codes[1] === 'egress_host' && codes[2] === 'egress_userinfo' && codes[3] === 'egress_host', 'a look-alike, another port, userinfo and a Mistral look-alike are refused', JSON.stringify(codes));
  ok(base.calls.length === 2, 'no refused preset URL reaches the base fetch');

  const prodBase = recorder();
  const prod = providerFetch(prodBase);
  await prod('https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions', { method: 'POST' });
  await prod('https://api.mistral.ai/v1/chat/completions', { method: 'POST' });
  ok(prodBase.calls.length === 2, 'providerFetch (the production provider guard) reaches both new preset hosts');
}

// ---- 8. limits are never hard-coded: each preset points at its official page ----
{
  const all = [...TAURI_FREE_PRESETS, ...TAURI_ADVANCED_PRESETS];
  ok(all.every((p) => /^https:\/\//.test(p.limitsUrl) && p.limitsNoteKey === 'settings.presetCheckLimits'), 'every preset carries an https official limits page and the "check your limits" copy key', JSON.stringify(all.map((p) => [p.id, p.limitsUrl])));
  ok(all.every((p) => !('limits' in p) && !('rpm' in p) && !('rpd' in p) && !('tokensPerDay' in p)), 'no preset hard-codes a numeric limit');
  ok(all.find((p) => p.id === 'gemini').limitsUrl === 'https://ai.google.dev/gemini-api/docs/rate-limits'
    && all.find((p) => p.id === 'groq').limitsUrl === 'https://console.groq.com/docs/rate-limits'
    && all.find((p) => p.id === 'openrouter').limitsUrl === 'https://openrouter.ai/docs/api-reference/limits'
    && all.find((p) => p.id === 'cloudflare').limitsUrl === 'https://developers.cloudflare.com/workers-ai/platform/pricing/'
    && all.find((p) => p.id === 'mistral').limitsUrl === 'https://docs.mistral.ai/admin/billing-usage/usage-limits',
    'the limits links are the official pages named in RESEARCH');
}

// ---- 9. FL-2: the renderer preset facts agree with the sidecar layer ----
{
  const ids = [...TAURI_PRESET_ORDER, ...TAURI_ADVANCED_ORDER];
  ok(same(Object.keys(FREE_LLM_UI), ids), 'the renderer preset table names the same presets in the same order', JSON.stringify(Object.keys(FREE_LLM_UI)));
  const all = [...TAURI_FREE_PRESETS, ...TAURI_ADVANCED_PRESETS];
  const bad = all.filter((p) => !FREE_LLM_UI[p.id] || FREE_LLM_UI[p.id].requiresAge18 !== p.requiresAge18 || FREE_LLM_UI[p.id].limitsUrl !== p.limitsUrl).map((p) => p.id);
  ok(bad.length === 0, 'the renderer age flag and official limits URL match FL-1 for every preset', bad.join(', '));
  ok(TAURI_FREE_PRESETS.every((p) => p.notices.includes('developerService')), '(A) the developer-service note is declared on every default preset');
  ok(same(TAURI_FREE_PRESETS.find((p) => p.id === 'gemini').notices, ['developerService', 'geminiEea', 'geminiFreeTier']), '(B)(D) only Gemini declares the EEA and free-tier notes');
  ok(TAURI_FREE_PRESETS.filter((p) => p.id !== 'gemini').every((p) => p.notices.every((n) => n === 'developerService')), 'no other default preset claims a Gemini note');
  ok(TAURI_ADVANCED_PRESETS.every((p) => p.notices.includes('developerService') && p.notices.every((n) => n === 'developerService' || n === 'mistralTraining')), 'Mistral is advanced, carries (A), and its training line stays the provider notice');
}

// ---- 10. FL-2: the notice copy exists in EN/VI/ZH and makes no unsupported claim ----
{
  const KEYS = ['settings.presetDeveloperService', 'settings.presetGeminiEea', 'settings.presetGeminiSlow', 'settings.presetGeminiFreeTier', 'settings.presetAge18', 'settings.presetAge18Required', 'settings.presetAge18KeyHint', 'settings.presetAge18Reason', 'settings.presetAge18Confirmed', 'settings.presetSwitchProvider', 'settings.presetAdvanced', 'settings.presetCheckLimits', 'settings.presetAccountLabel', 'settings.presetAccountPlaceholder', 'settings.presetAccountSave', 'settings.presetAccountBad', 'settings.presetAccountSaved', 'settings.mistralFreeTrainingNotice', 'app.ageConfirmRequired'];
  const missing = [];
  for (const l of ['en', 'vi', 'zh']) {
    const tab = TABLES[l] || {};
    for (const k of KEYS) if (typeof tab[k] !== 'string' || !tab[k]) missing.push(`${l}:${k}`);
  }
  ok(missing.length === 0, 'every FL-2 notice key exists in en, vi and zh', missing.join(', '));
  const en = TABLES.en;
  ok(/\{provider\}/.test(en['settings.presetDeveloperService']) && /own key/.test(en['settings.presetDeveloperService']) && /terms apply to you/.test(en['settings.presetDeveloperService']), '(A) the EN developer-service note is the brief copy with the provider name');
  ok(/EEA/.test(en['settings.presetGeminiEea']) && /(UK|United Kingdom)/.test(en['settings.presetGeminiEea']) && /Switzerland/.test(en['settings.presetGeminiEea']) && /paid/.test(en['settings.presetGeminiEea']) && /may bind the key holder/.test(en['settings.presetGeminiEea']), '(B) the EN EEA/UK/CH note says the terms MAY bind the key holder, plus the possible paid requirement');
  ok(/^Outside the EEA/.test(en['settings.presetGeminiFreeTier']) && /improve its products/.test(en['settings.presetGeminiFreeTier']) && /reviewers/.test(en['settings.presetGeminiFreeTier']) && /private information/.test(en['settings.presetGeminiFreeTier']), '(D) the EN free-tier warning carries the "outside EEA/UK/CH" qualifier and the review warning');
  ok(/người duyệt/.test(TABLES.vi['settings.presetGeminiFreeTier']) && !/nhân viên/.test(TABLES.vi['settings.presetGeminiFreeTier']), '(D) the VI line renders "human reviewers" as "người duyệt", not "nhân viên"');
  ok(en['settings.presetGeminiSlow'] === "Gemini's free tier can be slow at busy times; Groq is usually faster."
    && TABLES.vi['settings.presetGeminiSlow'] === 'Gemini miễn phí có thể chậm vào giờ đông người; Groq thường nhanh hơn.'
    && TABLES.zh['settings.presetGeminiSlow'] === 'Gemini 免费版在高峰时段可能较慢；Groq 通常更快。',
    'the approved slow-tier note (cos-bc 22-10) is verbatim in EN, VI and ZH');
  ok(!/\d/.test(en['settings.presetGeminiSlow'] + TABLES.vi['settings.presetGeminiSlow'] + TABLES.zh['settings.presetGeminiSlow']), 'the slow-tier note carries no numbers');
  ok(/có thể ràng buộc người giữ khoá/.test(TABLES.vi['settings.presetGeminiEea']) && /可能约束密钥持有人/.test(TABLES.zh['settings.presetGeminiEea']), '(B) the VI and ZH lines carry the same "may bind" qualifier');
  ok(en['settings.presetAge18Reason'] === "Google's terms require users of the Gemini API to be 18 or older.", 'S1: the confirm reason is the decided one-line copy');
  ok(/18/.test(en['settings.presetAge18']) && /18/.test(TABLES.vi['settings.presetAge18']), '(C) the 18+ checkbox label is the required text in EN and VI');
  ok(KEYS.every((k) => !/\b\d[\d,.]*\s*(rpm|rpd|rps|neurons|requests per)\b/i.test(en[k])), 'no notice hard-codes a provider limit number');
}

// ---- 11. FL-3: the read-only preset list rpc (metadata only, never a key) ----
{
  const list = presetList();
  ok(same(list.free.map((p) => p.id), ['gemini', 'groq', 'openrouter', 'cloudflare']), 'ai.presetList: the four defaults in the fixed order', JSON.stringify(list.free.map((p) => p.id)));
  ok(same(list.advanced.map((p) => p.id), ['mistral']) && list.advanced.every((p) => p.advanced === true), 'ai.presetList: Mistral is the only advanced entry');
  ok([...list.free, ...list.advanced].every((p) => typeof p.label === 'string' && p.label.length > 0), 'ai.presetList: every descriptor carries the label the renderer cannot get from the frozen table');
  const text = JSON.stringify(list);
  ok(!/keyShape|keyPrefix|keyTest|"key"/.test(text) && !(/AIza[0-9A-Za-z_-]{20,}|gsk_[A-Za-z0-9_-]{10,}|sk-or-[A-Za-z0-9_-]{10,}/.test(text)), 'ai.presetList: descriptors carry no key, key shape or key test (metadata only)');
  ok(list.free.find((p) => p.id === 'cloudflare').requiresAccountId === true && list.free.filter((p) => p.requiresAccountId).length === 1, 'ai.presetList: only Cloudflare asks for the Account ID');
  ok(same(Object.keys(PRESET_LIMIT_GUIDES), ['preset-limits-gemini', 'preset-limits-groq', 'preset-limits-openrouter', 'preset-limits-cloudflare', 'preset-limits-mistral']), 'the limits guide ids are a fixed table, one per preset', JSON.stringify(Object.keys(PRESET_LIMIT_GUIDES)));
  ok(PRESET_LIMIT_GUIDES[presetLimitGuideId('cloudflare')] === 'https://developers.cloudflare.com/workers-ai/platform/pricing/', 'a preset limits id resolves to its fixed official URL');
}

// ---- 12. FL-3: the setter validates, refuses unknown fields, and persists through saveSettings ----
{
  const tmpRoot = path.join(ROOT, '.tauri-check-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'preset-set-'));
  const file = path.join(dir, 'settings.json');
  const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  let writes = 0;
  const set = (patch) => { writes++; const next = { ...get(), ...patch }; fs.writeFileSync(file, JSON.stringify(next, null, 2)); return next; };
  const ai = createAiSettings({ dataDir: dir, settings: get, saveSettings: set });
  const good = '0123456789abcdef0123456789abcdef';
  const bad = [
    ['../' + 'a'.repeat(29), 'path traversal'], ['g'.repeat(32), 'non-hex'], ['a'.repeat(31), '31 chars'], ['a'.repeat(33), '33 chars'], [undefined, 'undefined'],
  ];
  const codes = bad.map(([v]) => ai.setPresetSettings({ cloudflareAccountId: v }));
  ok(codes.every((r) => r.ok === false && r.error === 'bad_cloudflare_account_id'), 'the setter refuses ../, non-hex, wrong length and an undefined Account ID with a typed error', JSON.stringify(codes));
  ok(writes === 0 && get().cloudflareAccountId === undefined, 'a refused Account ID writes nothing');
  const unknown = ai.setPresetSettings({ apiKey: 'not-a-real-key-value' });
  ok(unknown.ok === false && unknown.error === 'bad_field' && writes === 0 && !JSON.stringify(get()).includes('not-a-real-key-value'), 'the setter refuses an unknown field and writes nothing');
  const ageBad = ai.setPresetSettings({ age18Confirmed: 'yes' });
  ok(ageBad.ok === false && ageBad.error === 'bad_age18' && writes === 0, 'the setter refuses a non-boolean age answer');
  const accepted = ai.setPresetSettings({ cloudflareAccountId: good, age18Confirmed: true });
  ok(accepted.ok === true && accepted.settings.cloudflareAccountId === good && accepted.settings.age18Confirmed === true, 'the setter accepts a valid Account ID and the age answer');
  ok(get().cloudflareAccountId === good && get().age18Confirmed === true && writes === 1, 'the two settings are persisted through saveSettings', JSON.stringify(get()));
  // A fresh instance is a sidecar restart: the settings are read back from settings.json.
  const restarted = createAiSettings({ dataDir: dir, settings: get, saveSettings: set });
  ok(restarted.presetSettings().age18Confirmed === true && restarted.presetSettings().cloudflareAccountId === good, 'the age answer and Account ID survive a sidecar restart');
  ok(JSON.stringify(accepted).indexOf('key') === -1, 'the setter reply never echoes a key-shaped field', JSON.stringify(accepted));
  // Nits: an empty string or null clears the Account ID; anything else invalid is still refused.
  const clearedByEmpty = ai.setPresetSettings({ cloudflareAccountId: '' });
  ok(clearedByEmpty.ok === true && clearedByEmpty.settings.cloudflareAccountId === null && get().cloudflareAccountId === null, 'an empty string clears the stored Account ID');
  ai.setPresetSettings({ cloudflareAccountId: good });
  const clearedByNull = ai.setPresetSettings({ cloudflareAccountId: null });
  ok(clearedByNull.ok === true && clearedByNull.settings.cloudflareAccountId === null && get().cloudflareAccountId === null, 'null clears the stored Account ID');
  const refusedAfterClear = ai.setPresetSettings({ cloudflareAccountId: 'not-32-hex' });
  ok(refusedAfterClear.ok === false && refusedAfterClear.error === 'bad_cloudflare_account_id' && get().cloudflareAccountId === null, 'a non-empty invalid Account ID is still refused after a clear');
}

// ---- 13. S1: a saved Gemini key fails closed until the 18+ confirm, with NO fetch ----
{
  const tmpRoot = path.join(ROOT, '.tauri-check-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'age-gate-'));
  const file = path.join(dir, 'settings.json');
  const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const set = (patch) => { const next = { ...get(), ...patch }; fs.writeFileSync(file, JSON.stringify(next, null, 2)); return next; };
  set({ aiProvider: 'gemini', aiMode: 'free', aiDefaultsLegacy: false });
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (v) => Buffer.from(Buffer.from(v, 'utf8').map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'),
  };
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), method: String((init && init.method) || 'GET') });
    if (String((init && init.method) || 'GET') === 'POST') {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ai = createAiSettings({ dataDir: dir, settings: get, saveSettings: set });
  ai.pin();
  const secretStores = async () => createSecretStores({ safeStorage, dataDir: dir });
  const aiCore = createAiCore({ ai, secretStores, dataDir: dir });
  const host = createChatHost({
    dataDir: dir, settings: get, saveSettings: set, ai, secretStores, safeStorage,
    flavour: { values: FLAVOURS.public }, aiCore, log: () => {},
    emit: () => true,
    egress: { provider: fetchStub, cloud: fetchStub, mirror: fetchStub },
  });
  const p = PROVIDERS.gemini;
  createKeyStore({ safeStorage, dir, name: p.keyName, shape: p.keyShape }).write(`AIza${'a'.repeat(35)}`);
  ok(host.chatBrain.hasKey() === true, 'a Gemini key saved before this step is present in the vault');
  const turnId = '0123456789abcdef0123456789abcdef';
  const before = await host.handlers['talk.turn']({ turnId, message: 'hi', history: [] });
  ok(before && before.ok === false && before.error && before.error.code === 'age_confirm_required', 'the chat rpc refuses with age_confirm_required', JSON.stringify(before));
  ok(calls.length === 0, 'NO provider fetch is made while the age confirmation is missing');
  // Nit: S1 also covers the Gemini model-list path (a metadata call that would carry the saved key). The key TEST is
  // deliberately left open: the user saves a key before the confirm exists, and the test is not a chat turn.
  const modelsBefore = await host.handlers['roles.models']();
  ok(modelsBefore && modelsBefore.ok === false && modelsBefore.error === 'age_confirm_required' && Array.isArray(modelsBefore.models) && modelsBefore.models.length === 0, 'the Gemini model-list rpc refuses with age_confirm_required before the confirm', JSON.stringify(modelsBefore));
  ok(calls.length === 0, 'the refused model-list makes NO provider fetch either');
  const confirmed = ai.setPresetSettings({ age18Confirmed: true });
  ok(confirmed.ok === true && get().age18Confirmed === true, 'confirming through the setter stores age18Confirmed');
  const after = await host.handlers['talk.turn']({ turnId, message: 'hi', history: [] });
  ok(!(after && after.error && after.error.code === 'age_confirm_required') && calls.length > 0, 'after the confirmation the same Gemini turn proceeds and reaches the provider', JSON.stringify({ error: after && after.error, calls: calls.length }));
  const modelsAfter = await host.handlers['roles.models']();
  ok(modelsAfter && modelsAfter.ok === true && Array.isArray(modelsAfter.models) && modelsAfter.models.length > 0, 'after the confirmation the Gemini model-list rpc answers the provider table', JSON.stringify(modelsAfter).slice(0, 160));
}

// ---- 14. FL-2/FL-3: drive the REAL card in a child process (no sidecar import, so the R2 defect cannot hide) ----
{
  const tmpRoot = path.join(ROOT, '.tauri-check-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const payloadPath = path.join(tmpRoot, `renderer-${process.pid}-${Date.now()}.json`);
  const labels = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, PROVIDERS[id].label]));
  fs.writeFileSync(payloadPath, JSON.stringify({ presets: presetList(), settings: { age18Confirmed: false, cloudflareAccountId: null }, labels }));
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'free-llm-renderer-check.mjs'), payloadPath], { encoding: 'utf8' });
  } catch (e) {
    out = String((e && e.stdout) || '');
  } finally {
    fs.rmSync(payloadPath, { force: true });
  }
  let rows = [];
  try { rows = JSON.parse(out); } catch { rows = [{ ok: false, name: 'the renderer child produced parseable results', detail: out.slice(0, 300) }]; }
  for (const r of rows) ok(r.ok, r.name, r.detail);
}

// ---- 15. FL-2/FL-3: no key material in the renderer preset block either ----
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'brain-key-card.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const KEY_LIKE = [[/AIza[0-9A-Za-z_-]{20,}/, 'Gemini-shaped'], [/gsk_[A-Za-z0-9_-]{10,}/, 'Groq-shaped'], [/sk-or-[A-Za-z0-9_-]{10,}/, 'OpenRouter-shaped']];
  ok(KEY_LIKE.every(([re]) => !re.test(code)), 'the renderer notice layer carries no key-like literal');
}

// ---- 16. N1: a saved Cloudflare Account ID reaches the chat brain at once (no restart) ----
{
  const tmpRoot = path.join(ROOT, '.tauri-check-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'cf-live-'));
  const file = path.join(dir, 'settings.json');
  const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const set = (patch) => { const next = { ...get(), ...patch }; fs.writeFileSync(file, JSON.stringify(next, null, 2)); return next; };
  set({ aiProvider: 'cloudflare', aiMode: 'free', aiDefaultsLegacy: false });
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (v) => Buffer.from(Buffer.from(v, 'utf8').map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'),
  };
  const calls = [];
  const fetchStub = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let host = null;
  const ai = createAiSettings({ dataDir: dir, settings: get, saveSettings: set, onChange: () => { if (host) host.rebuild(); } });
  ai.pin();
  const secretStores = async () => createSecretStores({ safeStorage, dataDir: dir });
  const aiCore = createAiCore({ ai, secretStores, dataDir: dir });
  host = createChatHost({
    dataDir: dir, settings: get, saveSettings: set, ai, secretStores, safeStorage,
    flavour: { values: FLAVOURS.public }, aiCore, log: () => {},
    emit: () => true,
    egress: { provider: fetchStub, cloud: fetchStub, mirror: fetchStub },
  });
  createKeyStore({ safeStorage, dir, name: PROVIDERS.cloudflare.keyName, shape: PROVIDERS.cloudflare.keyShape }).write('a'.repeat(40));
  ok(host.chatBrain.hasKey() === true, 'N1: a Cloudflare token is present in the vault');
  ok(ai.setProvider('cloudflare').ok === true && ai.provider().baseURL === null, 'N1: the pick is Cloudflare with no base URL until the Account ID exists');
  const good = '0123456789abcdef0123456789abcdef';
  const saved = ai.setPresetSettings({ cloudflareAccountId: good });
  ok(saved.ok === true && ai.provider().baseURL === `https://api.cloudflare.com/client/v4/accounts/${good}/ai/v1`, 'N1: saving the Account ID resolves the active base URL');
  await host.handlers['talk.turn']({ turnId: '0123456789abcdef0123456789abcf', message: 'hi', history: [] });
  const expected = `https://api.cloudflare.com/client/v4/accounts/${good}/ai/v1/chat/completions`;
  ok(calls.some((u) => u === expected), 'N1: the NEXT chat turn, with NO restart, fetches the Account-ID base URL', JSON.stringify(calls));
  ai.setPresetSettings({ cloudflareAccountId: '' });
  const cleared = ai.provider();
  ok(cleared.baseURL === null && cleared.configError === 'cloudflare_account_id', 'N1: clearing the Account ID takes the base URL away again (a rebuild, not a stale brain)');
  // T-31 security (box re-probe finding 0): the rpc replies the page receives never echo the key.
  const SENT = 'SENTINELsaveREPLY' + 'k'.repeat(24);
  ai.setPresetSettings({ cloudflareAccountId: good });
  const saveReply = await host.handlers['brainKey.save'](SENT, false);
  const statusReply = await aiCore.brainKeyStatus();
  ok(!JSON.stringify(saveReply).includes(SENT) && !JSON.stringify(statusReply).includes(SENT), 'T-31 security: brainKey.save / brainKey.status replies carry no key material', JSON.stringify(saveReply).slice(0, 120));
}

// ---- 17. N3: the talk-panel 18+ path + the provider-switch choice, driven in a child process ----
{
  const tmpRoot = path.join(ROOT, '.tauri-check-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const payloadPath = path.join(tmpRoot, `talk-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ presets: presetList() }));
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'free-llm-talk-check.mjs'), payloadPath], { encoding: 'utf8' });
  } catch (e) {
    out = String((e && e.stdout) || '');
  } finally {
    fs.rmSync(payloadPath, { force: true });
  }
  let rows = [];
  try { rows = JSON.parse(out); } catch { rows = [{ ok: false, name: 'the talk renderer child produced parseable results', detail: out.slice(0, 300) }]; }
  for (const r of rows) ok(r.ok, r.name, r.detail);

  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  ok(/createAgeConfirm\(\{\s*zumi,\s*openPicker/.test(appSrc), 'app.js builds the talk 18+ wiring through createAgeConfirm with a picker fallback');
  ok(!/setProvider\(\s*['"]groq['"]\s*\)/.test(appSrc), 'app.js no longer hard-codes the switch to Groq');
  const switchSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'talk', 'age-confirm.js'), 'utf8');
  ok(/['"]groq['"],\s*['"]openrouter['"],\s*['"]cloudflare['"]/.test(switchSrc), 'the switch order is Groq, OpenRouter :free, Cloudflare');
  ok(/id !== 'gemini'/.test(switchSrc), 'the switch order skips Gemini');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
