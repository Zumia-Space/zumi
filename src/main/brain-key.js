'use strict';
// Settings > AI brain > "Your own key" (T-31 settings-a2): in-app entry of the user's own provider key (BYOK).
// Design + threat notes: the settings-a2 KEY-HANDLING notes (Sol gate before any merge).
// T-31 BYOK (owner 16-10): one key PER PROVIDER. The same encrypted store, one file per provider -- OpenRouter keeps
// the shared <userData>/jev-key.bin (unchanged, so the Jev reflex and every existing user stay exactly as they were);
// Gemini and Groq get their own <userData>/<name>-key.bin. Switching provider never deletes another provider's key.
//   - Storage: Electron safeStorage = Windows DPAPI; no plaintext fallback.
//   - Check ("Thử khoá" / Check again): one GET on the provider's key-test route (REPORT 3c: Gemini models with the
//     `x-goog-api-key` header, Groq /models, OpenRouter /api/v1/key). Free, no tokens; 200 works, 401/403 rejected,
//     4xx/5xx/network unreachable. T-31 fix r item 4: the key NEVER rides in a URL -- a header on every provider.
//   - What leaves this module toward the renderer: { provider, saved, last4, checked, encryption } + { ok, check, error }.
//     Never the key, never a provider error body. A key the provider REFUSES (401/403) is not stored. A key whose test
//     is UNREACHABLE is not stored either -- unless the caller passes confirmUnreachable (the explicit "Lưu dù chưa
//     thử được" button); T-31 fix round item 1, so a wrong-vendor key can never be saved silently.
// No Electron imports (safeStorage and fetch are injected), so scripts/check-brain-key.mjs drives it in plain Node.
const fs = require('node:fs');
const path = require('node:path');
const { createKeyStore } = require('./reflex-jev.js');
const { PROVIDERS, isProviderId } = require('./providers.js');

const PROVIDER = 'OpenRouter'; // the unconfigured default's label (kept for older callers/tests)
const CHECKS = ['works', 'unreachable', 'rejected', 'unverified'];
const KEY_CHECK_PATH = '/api/v1/key'; // OpenRouter's key route (kept for compat; each provider has its own now)
const CHECK_TIMEOUT_MS = 8000;

// The minimal key-test request from the provider table (REPORT 3c). T-31 fix r item 4: the key is ALWAYS a request
// header (Gemini `x-goog-api-key`, Groq/OpenRouter `authorization: Bearer`), never a query string, so it can never
// land in a URL, a proxy log or the route history. Free, no tokens.
function keyTestRequest(provider, key) {
  const t = provider.keyTest;
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const headers = t.auth === 'header'
    ? { [t.header]: key, accept: 'application/json' }
    : { authorization: `Bearer ${key}`, accept: 'application/json' };
  return { url: t.url, opts: { method: t.method, redirect: 'error', headers, signal } };
}

// key -> 'works' | 'rejected' (401/403, or Gemini's 400 API_KEY_INVALID) | 'unreachable' (network, timeout, 429/5xx,
// or Gemini's 400 FAILED_PRECONDITION region block: no verdict on the key itself).
// 'unverified': the provider has no route that can prove a key (keyTest null); no network at all.
async function checkKey(key, { fetchImpl = fetch, provider = PROVIDERS.openrouter } = {}) {
  if (!provider.keyTest) return 'unverified';
  const { url, opts } = keyTestRequest(provider, key);
  try {
    const res = await fetchImpl(url, opts);
    if (res.ok) return 'works';
    if (res.status === 401 || res.status === 403) return 'rejected';
    if (res.status === 400 && typeof res.text === 'function') {
      const body = await res.text().catch(() => '');
      return /api[-_ ]?key|invalid_argument/i.test(body) ? 'rejected' : 'unreachable';
    }
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

// opts: { safeStorage, dir, fetchImpl?, log?, getProvider? }
//   getProvider(): the active provider id from settings (T-31 BYOK). Read on EVERY call, so a provider switch in
//   Settings takes effect at once, no restart. Absent/unknown -> OpenRouter (today's one provider).
function createBrainKey({ safeStorage, dir, fetchImpl, log = () => {}, getProvider = () => 'openrouter' }) {
  const resolve = () => { const id = getProvider(); return isProviderId(id) ? PROVIDERS[id] : PROVIDERS.openrouter; };
  const storeFor = (provider) => createKeyStore({ safeStorage, dir, log, name: provider.keyName, shape: provider.keyShape });
  // The last provider check: { last4, check }. Tied to last4, so a key that arrived another way reads "not checked".
  // One file per provider (OpenRouter keeps the historical name) so a check on one provider can never colour another.
  const checkFileFor = (provider) => path.join(dir, provider.id === 'openrouter' ? 'brain-key-check.json' : `brain-key-check-${provider.id}.json`);
  const readCheck = (provider) => { try { const c = JSON.parse(fs.readFileSync(checkFileFor(provider), 'utf8')); return c && typeof c === 'object' ? c : null; } catch { return null; } };
  const writeCheck = (provider, last4, check) => { try { fs.writeFileSync(checkFileFor(provider), JSON.stringify({ last4, check, at: new Date().toISOString() })); } catch { /* status reads "not checked" */ } };
  // Never decrypts the key (store.last4() is a cache filled at write time). checked: null = saved but never checked.
  function status() {
    const provider = resolve();
    const store = storeFor(provider);
    const l4 = store.available() ? store.last4() : null;
    const c = l4 ? readCheck(provider) : null;
    return { provider: provider.label, saved: Boolean(l4), last4: l4, checked: c && c.last4 === l4 && CHECKS.includes(c.check) ? c.check : null, encryption: store.available() };
  }
  // raw: what the user pasted. Order matters: shape (no network) -> encryption available -> provider check ->
  // store only if the provider did not refuse it. T-31 fix round item 1: an UNREACHABLE test (429/5xx/offline) does
  // NOT store the key silently -- a wrong-vendor key would pass the shape and then 401 in chat. The renderer must ask
  // the user first ("Lưu dù chưa thử được"); only that explicit confirmation (confirmUnreachable) stores it. A key the
  // provider REFUSES (401/403) is never stored, confirmation or not. Applies to every provider (one code path).
  async function save(raw, { confirmUnreachable = false } = {}) {
    const provider = resolve();
    const store = storeFor(provider);
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!provider.keyShape.test(key)) return { ok: false, error: 'bad_format', ...status() };
    if (!store.available()) return { ok: false, error: 'no_encryption', ...status() };
    const check = await checkKey(key, { fetchImpl, provider });
    if (check === 'rejected') { log('brain key refused by the provider; nothing stored'); return { ok: false, error: 'rejected', check, ...status() }; }
    if (check === 'unreachable' && !confirmUnreachable) {
      log('brain key not verified (provider unreachable); not stored without confirmation');
      return { ok: false, error: 'unreachable', check, needsConfirm: true, ...status() };
    }
    const w = store.write(key);
    if (!w.ok) return { ok: false, error: w.error, ...status() };
    writeCheck(provider, key.slice(-4), check);
    log(`brain key saved (encrypted with the OS key), provider=${provider.id}, check=${check}`);
    return { ok: true, check, ...status() };
  }
  function clear() {
    const provider = resolve();
    const store = storeFor(provider);
    store.clear();
    try { fs.rmSync(checkFileFor(provider), { force: true }); } catch { /* status() ignores a record for another last4 */ }
    log(`brain key cleared (provider=${provider.id})`);
    return { ok: true, ...status() };
  }
  // "Check again" (Settings, shown while the key is saved but not known to work): re-checks the stored key; a refused
  // stored key stays stored (the user decides: Change or Clear). Same answer shape as save().
  async function test() {
    const provider = resolve();
    const store = storeFor(provider);
    const k = store.read();
    if (!k) return { ok: false, error: 'no_key', ...status() };
    const check = await checkKey(k, { fetchImpl, provider });
    if (check === 'unverified') return { ok: false, check, ...status() }; // keeps what a real chat call already proved
    writeCheck(provider, k.slice(-4), check);
    log(`brain key check=${check}`);
    return { ok: check === 'works', check, ...status() };
  }
  // "Thử khoá" (BYOK): test the key the user just typed, BEFORE saving it. Shape-gated, no store write, no log of the key.
  async function testKey(raw) {
    const provider = resolve();
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!provider.keyShape.test(key)) return { ok: false, error: 'bad_format' };
    const check = await checkKey(key, { fetchImpl, provider });
    return { ok: check === 'works', check };
  }
  // A real chat call's verdict, for a provider that has no key test: 'works' after a reply, 'rejected' after a 401. Never the key.
  // usedLast4: the key the call really used; a key saved while the call was in flight gets no verdict from it.
  function noteChatResult(check, usedLast4) {
    const provider = resolve();
    if (provider.keyTest || (check !== 'works' && check !== 'rejected')) return;
    const store = storeFor(provider);
    const l4 = store.available() ? store.last4() : null;
    if (l4 && l4 === usedLast4) writeCheck(provider, l4, check);
  }
  return { status, save, clear, test, testKey, noteChatResult };
}

module.exports = { createBrainKey, checkKey, keyTestRequest, PROVIDER, KEY_CHECK_PATH };
