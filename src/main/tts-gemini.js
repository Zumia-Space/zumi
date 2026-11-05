'use strict';
// Gemini API text-to-speech (T-31 talk-mode inc 3, PLAN section 10.1 row `gemini`). The user's OWN Google AI Studio key.
//
// Endpoint, re-checked against Google's docs on 19-10-2026 (https://ai.google.dev/gemini-api/docs/speech-generation):
// Google moved TTS to the INTERACTIONS API, so this is NOT generateContent:
//   POST https://generativelanguage.googleapis.com/v1beta/interactions      header  x-goog-api-key: <key>
//   { model: 'gemini-3.8-flash-tts',
//     input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
//     response_format: { type: 'audio' },
//     generation_config: { speech_config: [{ voice: 'Kore' }] } }
//   -> unary response: audio/wav (24 kHz mono s16le, RIFF header), base64, at
//      steps[type='model_output'].content[type='audio'].data. Vietnamese is listed for gemini-3.8-flash-tts and
//      gemini-3.8-flash-lite-tts. The language is auto-detected from the text, so `lang` only gates support.
// This API moves fast: if a call starts failing with bad_response, re-read the page above before anything else.
//
// Key: DPAPI store gemini-tts-key.bin (tts-keys.js). Never logged, never sent to the renderer; the key travels in a
// header (not the URL), so it can never land in a URL log.
const { createKeyStore } = require('./tts-keys.js');
const { MAX_CHARS, DEFAULT_TIMEOUT_MS, fail, scrub, failFromThrown, failFromResponse, readCapped } = require('./tts-common.js');

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const DEFAULT_CONFIG = Object.freeze({ model: 'gemini-3.8-flash-tts', voice: 'Kore' });
// A Google AI Studio key has the same AIza... shape as a Cloud key -- a shape gate, not a secret check.
const KEY_SHAPE = /^AIza[0-9A-Za-z_-]{35}$/;
const LANGS = ['en', 'vi'];

/** First base64 audio blob in steps[type=model_output].content[type=audio].data, or null. */
function audioFromInteraction(j) {
  const steps = Array.isArray(j && j.steps) ? j.steps : [];
  for (const step of steps) {
    if (!step || step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const c of step.content) if (c && c.type === 'audio' && typeof c.data === 'string' && c.data) return c.data;
  }
  return null;
}

/**
 * @param {object} o
 * @param {object} o.safeStorage
 * @param {string} o.dir  userData
 * @param {() => {voiceGemini?: {model?: string, voice?: string}}} [o.getConfig]
 * @param {typeof fetch} [o.fetchImpl]
 */
function createGeminiTts({ safeStorage, dir, getConfig, fetchImpl = fetch, log = () => {}, id = 'gemini' } = {}) {
  const keys = createKeyStore({ safeStorage, dir, file: 'gemini-tts-key.bin', importFile: 'gemini-tts-key.import', shape: KEY_SHAPE, log, label: 'gemini-tts' });
  keys.importIfPresent();
  const hasKey = () => Boolean(keys.read());
  const cfg = () => {
    const g = ((getConfig && getConfig()) || {}).voiceGemini || {};
    return { model: g.model || DEFAULT_CONFIG.model, voice: g.voice || DEFAULT_CONFIG.voice };
  };

  async function synthesize(text, lang = 'en') {
    if (!LANGS.includes(lang)) return fail('unsupported_lang', `gemini does not speak ${lang}`);
    if (typeof text !== 'string' || !text.trim()) return fail('bad_request', 'empty text');
    if (text.length > MAX_CHARS) return fail('bad_request', 'text too long');
    const key = keys.read();
    if (!key) return fail('no_key', 'Requires a Gemini API key');
    const { model, voice } = cfg();
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          model,
          input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice }] },
        }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) return await failFromResponse(res, key);
      const body = await readCapped(res);
      if (!body.ok) return body;
      let j;
      try { j = JSON.parse(body.buf.toString('utf8')); } catch { return fail('bad_response', 'not json', true); }
      const b64 = audioFromInteraction(j);
      if (!b64) return fail('bad_response', 'no audio in the interaction', true);
      const audio = Buffer.from(b64, 'base64');
      if (!audio.length) return fail('bad_response', 'empty audio', true);
      return { ok: true, mime: 'audio/wav', audios: [audio], voice: `${model}/${voice}` };
    } catch (e) {
      return failFromThrown(e, key);
    }
  }

  return { id, langs: LANGS, paid: true, needsKey: true, hasKey, synthesize, setKey: keys.write, clearKey: keys.clear };
}

module.exports = { createGeminiTts, ENDPOINT, DEFAULT_CONFIG, KEY_SHAPE, _test: { audioFromInteraction, scrub } };
