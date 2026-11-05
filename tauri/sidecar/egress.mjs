// T-31 parity step 6 (network half): the one egress seam for the sidecar. Gate: GATE-step6-hosts.md conditions 1-5
// (Fable, GO-WITH-CONDITIONS); proposal PROPOSAL-step6-hosts.md.
//
// Every request the sidecar makes goes through `guardedFetch(baseFetch, allowedOrigins, log)`. The guard is defence in
// depth, not the allow-list of record (the record is the module code + the recording-fetch tests): it refuses before a
// socket is opened and logs one line after the call, metadata only. Fixed code words are the WHOLE Error.message and
// nothing is attached (no URL, no .cause), because chat-brain surfaces `e.message` to the renderer.
//
// The provider set is DERIVED from the registry at module load (origin of `baseURL` and of `keyTest.url` for each
// provider), never hand-typed here. The registry is src/main/providers.js as extended by free-llm-presets.mjs (the
// Tauri-only Cloudflare and Mistral presets, FL-1). Cloud, Jev and the board mirror are built from the resolved flavour
// only.
//
// Static contract (scripts/check-tauri-egress.mjs): the socket API appears under tauri/sidecar/ only in this file and
// in main.mjs, where the global fetch is handed to `guardedFetch`; no ZUMI_TEST_* / ZUMI_BOARD_UPSTREAM /
// ZUMI_FIXTURE_LLM_URL is read anywhere in the sidecar.
import { createRequire } from 'node:module';

import { tauriProviders } from './free-llm-presets.mjs';

const require = createRequire(import.meta.url);
const { validateCustomUrl } = require('../../src/main/tts-common.js');

// FL-1: the frozen table extended with the Tauri presets (Cloudflare, Mistral). The registry is the source; this file
// never types a provider hostname.
const PROVIDERS = tauriProviders();

// Same loopback names as flavour.mjs / board-reader.mjs (the mirror is the only http origin the guard can allow).
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
// The only origin the Jev reflex may reach (GATE-step6-hosts condition 2; reflex-jev.js pins the same one).
export const JEV_ORIGIN = 'https://openrouter.ai';

/** Origins a provider request can reach, derived from the provider table (base URL and key-test URL). */
export function providerEgressOrigins(providers = PROVIDERS) {
  const out = new Set();
  for (const p of Object.values(providers)) {
    out.add(new URL(p.baseURL).origin);
    if (p.keyTest) out.add(new URL(p.keyTest.url).origin); // OpenCode Go has none: its model list proves nothing about a key
  }
  return Object.freeze([...out]);
}

/** The four public provider origins, derived once at module load. One test pins them to the literal list. */
export const PROVIDER_ORIGINS = providerEgressOrigins();

/**
 * Self-test guard (T-31, box re-probe 9bd5e2b: the owner --selftest made real TTS calls to https://zumia.space).
 * In ANY self-test mode (selftest, demo, shots, probe) the base fetch refuses every non-loopback host before a socket
 * opens and logs the refusal, so a path that was missed by the fixtures fails loudly instead of calling prod.
 * Electron's self-test never leaves the machine (cloud.js fixture transport); this makes the sidecar's the same.
 */
export function selfTestFetch(baseFetch, log = () => {}) {
  if (typeof baseFetch !== 'function') throw new TypeError('selfTestFetch: baseFetch must be a function');
  return async function selfTestGuarded(url, init) {
    let u = null;
    try { u = new URL(String(url)); } catch { log('egress - egress_bad_url'); throw refuse('egress_bad_url'); }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK.has(u.hostname)) {
      log(`egress ${u.origin} egress_selftest_nonloopback`);
      throw refuse('egress_selftest_nonloopback');
    }
    return baseFetch(url, init);
  };
}

/** True when the sidecar was launched in a self-test mode (parseSelfTestArgs result; argv only). */
export function isSelfTestRun(modes) {
  return Boolean(modes && (modes.selftest || modes.demo || modes.shots || modes.probe));
}

/** A fetch that makes no request at all: the default for a module with no allowed origin. */
export const closedFetch = () => Promise.reject(new Error('egress_closed'));

// A refusal: a FRESH Error whose whole message is the fixed code word. No URL, no cause, nothing attached.
function refuse(code) {
  return new Error(code);
}

/**
 * Wrap a fetch so it can only reach `allowedOrigins`.
 * Refusal order (GATE condition 1): bad URL -> userinfo -> scheme -> origin. Origins are compared as `u.origin`
 * (lowercase, scheme and port included), never hostnames, so a look-alike, a non-default port, a trailing-dot host,
 * a punycode host and an IP literal all fail by construction.
 * Redirects are always refused (`redirect: 'error'`, overriding the caller), so a bearer never follows one.
 * The log line is `egress <origin> <status|code word>` after the call; never the path, query, headers, body or key.
 *
 * @param {(url: string, init?: object) => Promise<any>} baseFetch
 * @param {string[]} allowedOrigins exact origins, e.g. ['https://openrouter.ai']
 * @param {(line: string) => void} [log]
 */
export function guardedFetch(baseFetch, allowedOrigins, log = () => {}, redirect = 'error') {
  if (typeof baseFetch !== 'function') throw new TypeError('guardedFetch: baseFetch must be a function');
  const allowed = new Set((Array.isArray(allowedOrigins) ? allowedOrigins : []).map(String));
  return async function guarded(url, init) {
    let u = null;
    if (typeof url !== 'string') {
      log(`egress - egress_bad_url`);
      throw refuse('egress_bad_url');
    }
    try { u = new URL(url); } catch {
      log(`egress - egress_bad_url`);
      throw refuse('egress_bad_url');
    }
    if (u.username || u.password) {
      log(`egress ${u.origin} egress_userinfo`);
      throw refuse('egress_userinfo');
    }
    // https only; http only when the allowed entry is itself a loopback origin (the board mirror). A loopback http
    // origin that is NOT in the set fails as a host (the fixture's loopback port through the production guard, GATE-5);
    // a public http origin fails as a scheme. Every other scheme fails as a scheme.
    if (u.protocol !== 'https:') {
      if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) {
        if (!allowed.has(u.origin)) {
          log(`egress ${u.origin} egress_host`);
          throw refuse('egress_host');
        }
      } else {
        log(`egress ${u.origin} egress_scheme`);
        throw refuse('egress_scheme');
      }
    }
    if (!allowed.has(u.origin)) {
      log(`egress ${u.origin} egress_host`);
      throw refuse('egress_host');
    }
    try {
      const res = await baseFetch(url, { ...(init || {}), redirect });
      const status = res && typeof res.status === 'number' ? res.status : 'no_status';
      log(`egress ${u.origin} ${status}`);
      return res;
    } catch (e) {
      // A transport error message can carry a URL or a host; log a fixed word and rethrow the original untouched
      // (chat-brain scrubs it before the renderer sees it).
      log(`egress ${u.origin} network`);
      throw e;
    }
  };
}

/** Chat brain + brain key: the four provider origins, at all times (a provider switch needs no rebuild). */
export function providerFetch(baseFetch, log) {
  return guardedFetch(baseFetch, PROVIDER_ORIGINS, log);
}

/** Cloud transport: the flavour's cloudBase origin only, else closed. */
export function cloudFetch(baseFetch, cloudBase, log) {
  return cloudBase ? guardedFetch(baseFetch, [new URL(cloudBase).origin], log) : closedFetch;
}

/** Jev reflex: openrouter.ai only when the flavour says egress is on, else closed. */
export function jevFetch(baseFetch, enabled, log) {
  return enabled ? guardedFetch(baseFetch, [JEV_ORIGIN], log) : closedFetch;
}

/** Board-reader mirror: the flavour's loopback origin only, else closed (the guard still enforces the scheme). */
export function mirrorFetch(baseFetch, mirrorOrigin, log) {
  return mirrorOrigin ? guardedFetch(baseFetch, [new URL(mirrorOrigin).origin], log) : closedFetch;
}

/**
 * board.media's only transport (T-31 3a-3, GATE-SEC-3a-3 C10): the live bridge's media route on its CURRENT loopback port, and nothing else.
 * The URL must match `http://127.0.0.1:<current port>/api/v1/media/att-<1-12 digits>?w=480|1600` as a whole (no userinfo, no extra query, no
 * fragment, no path tricks); anything else goes to closedFetch (egress_closed, no socket). The bridge's own headers are added here, the call is
 * made with redirect:'error' (a 302 surfaces to board-reads as "offline"; Electron's redirect:'manual' says http_302; both refuse, neither follows).
 * @param {(url: string, init?: object) => Promise<any>} baseFetch the one fetch main.mjs hands to every guard
 * @param {() => Promise<number|null>} bridgePort liveBoard.bridgePort
 * @param {() => Promise<object>} bridgeHeaders liveBoard.bridgeHeaders
 */
export function bridgeMediaFetch(baseFetch, bridgePort, bridgeHeaders) {
  if (typeof baseFetch !== 'function') throw new TypeError('bridgeMediaFetch: baseFetch must be a function');
  return async (url, init) => {
    const port = await Promise.resolve().then(bridgePort).catch(() => null);
    const ok = Number.isInteger(port) && port > 0 && port < 65536 && typeof url === 'string'
      && new RegExp(`^http://127\\.0\\.0\\.1:${port}/api/v1/media/att-\\d{1,12}\\?w=(480|1600)$`).test(url);
    if (!ok) return closedFetch(url, init);
    return baseFetch(url, { ...(init || {}), headers: { ...((init && init.headers) || {}), ...(await bridgeHeaders()) }, redirect: 'error' });
  };
}

// ---- step 8b: the voice providers' egress ----
// Each adapter gets its OWN guard, so a look-alike of a paid endpoint is refused for that provider instead of being
// accepted as "the user's custom URL". Fixed origins (PLAN-steps6plus 8b, egress), asserted by the recording fetch:
//   google -> texttospeech.googleapis.com, gemini -> generativelanguage.googleapis.com, elevenlabs -> api.elevenlabs.io,
//   the owner's preset / the user's Zumia shape -> zumia.space (+ the user's own URL under tts-http's rules),
//   http-openai -> the user's own URL under tts-http's rules (the same validator the adapter runs at call time).
// Kokoro (part 2) downloads from huggingface.co plus the CDN host its LFS files redirect to.
export const TTS_ORIGINS = Object.freeze([
  'https://texttospeech.googleapis.com',
  'https://generativelanguage.googleapis.com',
  'https://api.elevenlabs.io',
  'https://zumia.space',
]);
export const KOKORO_ORIGINS = Object.freeze([
  'https://huggingface.co',
  // The worker enforces a host RULE, not this exact list: https + huggingface.co / *.huggingface.co / *.hf.co on
  // every hop (kokoro-worker.mjs checkHop). This list is the measured KNOWN set (the origins seen in practice),
  // not the boundary; the sha256 pins still decide whether the downloaded bytes are used.
  'https://us.aws.cdn.hf.co', // measured 22-10: model_fp16.onnx 302s here; the worker enforces the host RULE per hop
]);
export const TTS_ALLOWED_ORIGINS = Object.freeze([...TTS_ORIGINS, ...KOKORO_ORIGINS]);
// Marketplace package downloads: their own guard. A GitHub Release asset answers 302 to its asset host (measured), so the two origins go together.
export const MARKET_ORIGINS = Object.freeze(['https://github.com', 'https://release-assets.githubusercontent.com']);
/** The Marketplace's fetch: its origins, a redirect comes back unfollowed so the host sends the next hop through this guard too; origin + status logged. */
export function marketFetch(baseFetch, log = () => {}) {
  return guardedFetch(baseFetch, MARKET_ORIGINS, log, 'manual');
}

const FIXED_TTS_ORIGIN = Object.freeze({
  google: TTS_ORIGINS[0],
  gemini: TTS_ORIGINS[1],
  elevenlabs: TTS_ORIGINS[2],
});
const ZUMIA_ORIGIN = TTS_ORIGINS[3];
// A custom-shape provider whose user URL must still never receive the bearer (tts-http's own rule) may point at
// zumia.space; that fixed origin is allowed in addition to the user's URL.
const CUSTOM_WITH_FIXED = Object.freeze({ 'http-zumia': [ZUMIA_ORIGIN], 'zumia-owner': [ZUMIA_ORIGIN], 'http-openai': [] });

/**
 * The TTS fetch for one adapter. A fixed provider reaches its one origin and nothing else; a custom provider reaches
 * its optional fixed origin plus a URL that passes tts-common.validateCustomUrl (https, or loopback http; no userinfo,
 * no query/hash). Redirects are always refused; the log line is origin + status only.
 *
 * @param {(url: string, init?: object) => Promise<any>} baseFetch
 * @param {'google'|'gemini'|'elevenlabs'|'http-openai'|'http-zumia'|'zumia-owner'} providerId
 * @param {(line: string) => void} [log]
 */
export function ttsFetch(baseFetch, providerId, log = () => {}) {
  if (typeof baseFetch !== 'function') throw new TypeError('ttsFetch: baseFetch must be a function');
  if (FIXED_TTS_ORIGIN[providerId]) return guardedFetch(baseFetch, [FIXED_TTS_ORIGIN[providerId]], log);
  const extra = CUSTOM_WITH_FIXED[providerId];
  if (!extra) throw new Error(`ttsFetch: unknown provider ${providerId}`);
  const fixedOrigins = new Set(extra);
  return async function customTts(url, init) {
    let u;
    if (typeof url !== 'string') {
      log('egress - egress_bad_url');
      throw refuse('egress_bad_url');
    }
    try { u = new URL(url); } catch {
      log('egress - egress_bad_url');
      throw refuse('egress_bad_url');
    }
    if (u.username || u.password) {
      log(`egress ${u.origin} egress_userinfo`);
      throw refuse('egress_userinfo');
    }
    if (!fixedOrigins.has(u.origin) && !validateCustomUrl(url).ok) {
      log(`egress ${u.origin} egress_host`);
      throw refuse('egress_host');
    }
    try {
      const res = await baseFetch(url, { ...(init || {}), redirect: 'error' });
      const status = res && typeof res.status === 'number' ? res.status : 'no_status';
      log(`egress ${u.origin} ${status}`);
      return res;
    } catch (e) {
      log(`egress ${u.origin} network`);
      throw e;
    }
  };
}
