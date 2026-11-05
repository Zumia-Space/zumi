'use strict';
// Google Cloud Text-to-Speech (T-31 voice P1 item 3; generalised for the BYO provider frame, PLAN section 10.1).
// Speaks with the user's OWN Google key: `vi` -> vi-VN Chirp3-HD Leda (unchanged), `en` -> en-US Chirp3-HD Leda. The
// voice name per language is non-secret config (settings.json `voiceGoogle`), defaulting to the two names below.
//
// No key -> refused with a typed, UI-facing reason (code 'no_key'); the caller falls back to subtitle-only, never to
// silence. This path makes a real paid network call only once a key is present AND synthesize() is invoked. The checks use a
// stubbed fetch, so the keyed branch has NOT run against Google with a real key yet.
//
// Key storage is the shared DPAPI store (tts-keys.js); the file name stays `leda-key.bin` so existing installs need no
// key migration. The key never reaches the renderer, logs, URLs or error messages: it goes in the x-goog-api-key header, which
// Google's API-key page prefers because a query string is exposed to URL scans.
const { createKeyStore } = require('./tts-keys.js');

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const VOICES_ENDPOINT = 'https://texttospeech.googleapis.com/v1/voices?languageCode=vi-VN'; // listing voices is free
const MAX_CHARS = 2000;
const MAX_BYTES = 10 * 1024 * 1024; // response cap (PLAN section 10.1)
// Standard Google API key shape (AIza + 35 base64url chars) -- a shape gate, not a secret check.
const KEY_SHAPE = /^AIza[0-9A-Za-z_-]{35}$/;
// Chirp3-HD voices by language. The en name is the plan's cited default (PLAN section 10.1); the vi name is unchanged.
const DEFAULT_VOICES = { en: 'en-US-Chirp3-HD-Leda', vi: 'vi-VN-Chirp3-HD-Leda' };
const LANGS = ['en', 'vi'];

function scrub(s, key) {
  let t = String(s == null ? '' : s);
  if (key) t = t.split(key).join('***');
  return t.slice(0, 300);
}

// "AI" -> "Ây Ai" in the VI TTS text ONLY (never in chat/UI text) -- a whole-word match so "AIza..." or "MAIL"
// are left alone, case-sensitive (Vietnamese prose does not otherwise produce a bare uppercase "AI").
function viTtsText(text) {
  return String(text).replace(/\bAI\b/g, 'Ây Ai');
}

/**
 * @param {object} o
 * @param {{isEncryptionAvailable():boolean, encryptString(s:string):Buffer, decryptString(b:Buffer):string}} o.safeStorage
 * @param {string} o.dir     userData
 * @param {() => object} [o.getConfig]  -> { voiceGoogle: { en, vi } }; absent -> the defaults above
 */
function createLedaTts({ safeStorage, dir, getConfig, log = () => {}, fetchImpl = fetch, id = 'google' } = {}) {
  const keys = createKeyStore({ safeStorage, dir, file: 'leda-key.bin', importFile: 'leda-key.import', shape: KEY_SHAPE, log, label: 'leda' });
  keys.importIfPresent();

  function hasKey() { return Boolean(keys.read()); }

  const voiceFor = (lang) => {
    const cfg = (getConfig && getConfig()) || {};
    const g = cfg.voiceGoogle || {};
    return (lang === 'en' ? g.en : g.vi) || DEFAULT_VOICES[lang === 'en' ? 'en' : 'vi'];
  };

  async function synthesize(text, lang = 'vi') {
    const L = lang === 'en' ? 'en' : 'vi';
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: { code: 'bad_request', message: 'empty text', retryable: false } };
    if (text.length > MAX_CHARS) return { ok: false, error: { code: 'bad_request', message: 'text too long', retryable: false } };
    const key = keys.read();
    if (!key) return { ok: false, error: { code: 'no_key', message: 'Requires a Google Cloud API key', retryable: false } };
    const voiceName = voiceFor(L);
    const body = JSON.stringify({
      input: { text: L === 'vi' ? viTtsText(text) : text },
      voice: { languageCode: L === 'en' ? 'en-US' : 'vi-VN', name: voiceName },
      audioConfig: { audioEncoding: 'LINEAR16' },
    });
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: AbortSignal.timeout(9000), // same budget as cloud.js's tts timeout
      });
      if (!res.ok) {
        const code = res.status === 401 || res.status === 403 ? 'auth_failed' : res.status === 429 ? 'rate_limited' : `http_${res.status}`;
        return { ok: false, error: { code, message: scrub(await res.text().catch(() => ''), key), retryable: res.status === 429 || res.status >= 500 } };
      }
      const raw = await res.text().catch(() => '');
      if (raw.length > MAX_BYTES) return { ok: false, error: { code: 'too_large', message: 'response too large', retryable: false } };
      let j;
      try { j = JSON.parse(raw); } catch { return { ok: false, error: { code: 'bad_response', message: 'not json', retryable: true } }; }
      if (!j || typeof j.audioContent !== 'string') return { ok: false, error: { code: 'bad_response', message: 'no audioContent', retryable: true } };
      return { ok: true, mime: 'audio/wav', audios: [Buffer.from(j.audioContent, 'base64')], voice: voiceName };
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { ok: false, error: { code: timeout ? 'timeout' : 'internal', message: scrub((e && e.message) || String(e), key), retryable: true } };
    }
  }

  // A key the user just pasted, tried for free before it is saved. Never stored here, never logged.
  // 'works' | 'rejected' (Google refused it, or the API is off for it) | 'unreachable' | 'bad_format'.
  async function checkKey(raw) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!KEY_SHAPE.test(key)) return 'bad_format';
    try {
      const res = await fetchImpl(VOICES_ENDPOINT, { method: 'GET', redirect: 'error', headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(9000) });
      if (res.ok) return 'works';
      return res.status === 400 || res.status === 401 || res.status === 403 ? 'rejected' : 'unreachable';
    } catch { return 'unreachable'; }
  }

  return {
    id, langs: LANGS, paid: true, needsKey: true,
    hasKey, synthesize, checkKey, setKey: keys.write, clearKey: keys.clear, voiceFor,
    info: () => ({ mode: hasKey() ? 'leda' : 'off', voice: hasKey() ? voiceFor('vi') : null }),
  };
}

module.exports = { createLedaTts, viTtsText, KEY_SHAPE, DEFAULT_VOICES, _test: { createKeyStore } };
