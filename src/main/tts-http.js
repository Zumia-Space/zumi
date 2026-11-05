'use strict';
// Custom-HTTP TTS adapter (T-31 talk-mode, PLAN sections 10.1/10.2). ONE adapter; a `shape` picks how the request and
// the response look:
//
//   zumia   POST {url} {text}  -> JSON { audio } | { audios: [b64] }, base64 MP3          (the cloud.js:179-184 parse rule)
//   openai  POST {base}/audio/speech  { model, input, voice, response_format: 'mp3' }  -> the audio bytes
//           (OpenAI-compatible: OpenAI itself, Kokoro-FastAPI, LiteLLM ... https://developers.openai.com/api/reference/
//            resources/audio/subresources/speech/methods/create; input capped at 4096 chars, here min(4096, 2000))
//
// Three instances are wired by main.js:
//   zumia-owner  fixed URL constant, owner key from an import file (none: no header), vi only, the server's own Google
//                project pays (the owner preset). A 401 is typed no_key.
//   http-zumia   a user-saved URL, optional bearer
//   http-openai  a user-saved base URL + model + voice, optional bearer
// The user URLs follow the URL rules (tts-common.validateCustomUrl): https only (loopback http allowed), no userinfo.
// They are validated when saved AND again at call time. A user's optional bearer is NEVER sent to zumia.space; only the
// owner instance's own key goes there, and only to the fixed constant.
//
// Shared contract (PLAN 10.1): redirect:'error'; AbortSignal.timeout (20 s for the Zumia route, which synthesizes its
// chunks sequentially -- G1 -- else 9 s); a 10 MB response cap; input capped at 2000; every error string scrubbed of
// the key; the key never logged, never sent to the renderer, never in argv.
const fs = require('node:fs');
const path = require('node:path');
const { createKeyStore } = require('./tts-keys.js');
const { MAX_CHARS, DEFAULT_TIMEOUT_MS, fail, scrub, failFromThrown, failFromResponse, readCapped, contentTypeOf, validateCustomUrl } = require('./tts-common.js');

const ZUMIA_TIMEOUT_MS = 20000;
// The owner preset's route is a code constant, never read from the flag file (PLAN section 10.2).
const ZUMIA_OWNER_URL = 'https://zumia.space/api/zumi/tts';
const ZUMIA_OWNER_HOST = 'zumia.space';
// One optional bearer PER user provider (T-31 review fix 6): a bearer saved for one URL must never be sent to the other
// provider's host. 0.2.5 pre-release builds shared one file (LEGACY_CUSTOM_KEY_FILE); migrateLegacyCustomKey moves it.
const CUSTOM_KEY_FILES = Object.freeze({ 'http-openai': 'custom-openai-tts-key.bin', 'http-zumia': 'custom-zumia-tts-key.bin' });
const LEGACY_CUSTOM_KEY_FILE = 'custom-tts-key.bin';
const CUSTOM_KEY_SHAPE = /^[A-Za-z0-9_.~+/=-]{8,300}$/;

const isZumiaHost = (host) => host === ZUMIA_OWNER_HOST || host.endsWith(`.${ZUMIA_OWNER_HOST}`);

/**
 * @param {object} o
 * @param {string} [o.id]        'zumia-owner' | 'http-zumia' | 'http-openai'
 * @param {string} [o.url]       a fixed endpoint (the owner constant); user instances read getConfig() per call instead
 * @param {() => object} [o.getConfig] -> settings-derived { voiceCustom: {base, model, voice}, voiceCustomZumia: {url} }
 * @param {string[]} [o.langs]
 * @param {boolean} [o.paid]
 * @param {boolean} [o.needsKey]     true -> a bearer is required
 * @param {boolean} [o.keyOptional]  true -> a bearer is stored if the user gives one (never sent to zumia.space)
 * @param {'zumia'|'openai'} [o.shape]
 */
function createHttpTts({
  id = 'http-zumia', url = null, getConfig = null, langs = ['vi'], paid = false, needsKey = false, keyOptional = false, shape = 'zumia',
  safeStorage, dir, keyFile = CUSTOM_KEY_FILES[id] || `custom-${String(id).replace(/[^a-z0-9-]/gi, '')}-tts-key.bin`, keyImportFile, keyShape = CUSTOM_KEY_SHAPE, authHeader = 'authorization',
  timeoutMs, fetchImpl = fetch, log = () => {},
} = {}) {
  const wantsKey = needsKey || keyOptional;
  const keys = wantsKey ? createKeyStore({ safeStorage, dir, file: keyFile, importFile: keyImportFile, shape: keyShape, log, label: id }) : null;
  if (keys && keyImportFile) keys.importIfPresent();

  // A key-less provider is always ready; an optional-key one is ready without it; a required-key one asks the store.
  const hasKey = () => (keys ? Boolean(keys.read()) : true);

  /** -> { ok: true, url, body } | typed failure. The URL rules run here, at call time, on every request. */
  function target(text) {
    if (shape === 'openai') {
      const c = ((getConfig && getConfig()) || {}).voiceCustom || {};
      const v = validateCustomUrl(c.base);
      if (!v.ok) return fail('no_config', `${id} has no valid base URL (${v.reason})`);
      if (!c.model || !c.voice) return fail('no_config', `${id} needs a model and a voice`);
      return { ok: true, url: `${v.url}/audio/speech`, body: { model: c.model, input: text, voice: c.voice, response_format: 'mp3' } };
    }
    let u = url;
    if (!u && getConfig) {
      const c = ((getConfig && getConfig()) || {}).voiceCustomZumia || {};
      const v = validateCustomUrl(c.url);
      if (!v.ok) return fail('no_config', `${id} has no valid URL (${v.reason})`);
      u = v.url;
    }
    if (!u) return fail('no_config', `${id} has no endpoint`);
    return { ok: true, url: u, body: { text } };
  }

  async function synthesize(text, lang) {
    if (!langs.includes(lang)) return fail('unsupported_lang', `${id} does not speak ${lang || 'that language'}`);
    if (typeof text !== 'string' || !text.trim()) return fail('bad_request', 'empty text');
    if (text.length > MAX_CHARS) return fail('bad_request', 'text too long');
    const key = keys ? keys.read() : null;
    if (needsKey && !key) return fail('no_key', `${id} needs an API key`);
    const t = target(text);
    if (!t.ok) return t;

    let host = '';
    try { host = new URL(t.url).host; } catch { /* validateCustomUrl already refused a bad URL */ }
    const headers = { 'content-type': 'application/json' };
    // A user's bearer only ever goes to the URL the user saved, never to zumia.space (PLAN section 10.1). The owner key
    // goes only to the owner constant (owner 02-11: the route becomes owner-only).
    const ownerRoute = id === 'zumia-owner' && t.url === ZUMIA_OWNER_URL;
    if (key && authHeader && (ownerRoute || !isZumiaHost(host))) headers[authHeader] = `Bearer ${key}`;

    const budget = timeoutMs || (shape === 'zumia' ? ZUMIA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(t.url, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(t.body), signal: AbortSignal.timeout(budget) });
      if (ownerRoute && res.status === 401) return fail('no_key', `${id} was refused: no valid owner key`);
      if (!res.ok) return await failFromResponse(res, key);
      if (shape === 'zumia') {
        const body = await readCapped(res);
        if (!body.ok) return body;
        let j;
        try { j = JSON.parse(body.buf.toString('utf8')); } catch { return fail('bad_response', 'not json', true); }
        const list = Array.isArray(j && j.audios) && j.audios.length ? j.audios : (j && typeof j.audio === 'string' ? [j.audio] : []);
        if (!list.length || list.some((a) => typeof a !== 'string' || !a)) return fail('bad_response', 'no audio', true);
        return { ok: true, mime: 'audio/mpeg', audios: list.map((b64) => Buffer.from(b64, 'base64')), voice: (j && j.voice) || id };
      }
      // openai shape: the body IS the audio bytes (read as bytes -- never through text(), which would corrupt them).
      const ct = contentTypeOf(res);
      if (!/^audio\//i.test(ct)) return fail('bad_response', `content-type ${ct.slice(0, 60) || 'missing'}`);
      const body = await readCapped(res);
      if (!body.ok) return body;
      if (!body.buf.length) return fail('bad_response', 'empty audio', true);
      return { ok: true, mime: 'audio/mpeg', audios: [body.buf], voice: id };
    } catch (e) {
      return failFromThrown(e, key);
    }
  }

  return {
    id, langs, paid, needsKey, keyOptional, shape,
    hasKey, synthesize,
    setKey: keys ? keys.write : () => false,
    clearKey: keys ? keys.clear : () => {},
  };
}

/**
 * One-time move of the shared pre-split bearer file. The file carries no provider tag, so it is moved only when the
 * provider it was saved for is determinable: exactly one of the two user providers has a valid saved URL. Both or
 * neither -> the legacy file is deleted and the user re-enters the bearer (it is never silently used for either, so it
 * can never reach the other provider's host). Never overwrites a key already saved in the new file.
 * @returns {'none'|'http-openai'|'http-zumia'|'cleared'}
 */
function migrateLegacyCustomKey({ dir, config = {}, log = () => {} } = {}) {
  const legacy = path.join(dir, LEGACY_CUSTOM_KEY_FILE);
  if (!fs.existsSync(legacy)) return 'none';
  const hasOpenai = validateCustomUrl(config.voiceCustom && config.voiceCustom.base).ok;
  const hasZumia = validateCustomUrl(config.voiceCustomZumia && config.voiceCustomZumia.url).ok;
  const target = hasOpenai && !hasZumia ? 'http-openai' : hasZumia && !hasOpenai ? 'http-zumia' : null;
  try {
    if (target && !fs.existsSync(path.join(dir, CUSTOM_KEY_FILES[target]))) {
      fs.renameSync(legacy, path.join(dir, CUSTOM_KEY_FILES[target]));
      log(`custom voice bearer moved to the ${target} key file`);
      return target;
    }
    fs.unlinkSync(legacy);
    log('custom voice bearer cleared: it cannot be matched to one provider, so it must be entered again');
    return 'cleared';
  } catch (e) {
    log(`custom voice bearer migration failed: ${(e && e.code) || 'error'}`);
    return 'none';
  }
}

module.exports = { createHttpTts, ZUMIA_OWNER_URL, CUSTOM_KEY_FILES, LEGACY_CUSTOM_KEY_FILE, migrateLegacyCustomKey, _test: { scrub } };
