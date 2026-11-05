'use strict';
// ElevenLabs text-to-speech (T-31 talk-mode inc 3, PLAN section 10.1 row `elevenlabs`). The user's OWN API key.
//
// Request, per https://elevenlabs.io/docs/api-reference/text-to-speech/convert (checked 19-10-2026):
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}     header  xi-api-key: <key>
//   { text, model_id }  -> the audio bytes, default mp3_44100_128 (audio/mpeg)
// Model/language, per https://elevenlabs.io/docs/overview/models (checked 19-10-2026): the API default model
// `eleven_multilingual_v2` has NO Vietnamese. Vietnamese needs eleven_flash_v2_5 (32 languages, 40k chars) or
// eleven_v3 / eleven_v4 / eleven_v4_turbo / eleven_v3_conversational. So the default here is eleven_flash_v2_5, and a
// Vietnamese request with any other model is refused as `unsupported_lang` BEFORE any network call (no wasted paid call).
//
// The voice id has no safe default (library voices differ per plan), so a missing one is `no_config`, never a guess.
// The voice id goes into the URL path, so it is shape-gated and encoded. Key: DPAPI store elevenlabs-key.bin; never
// logged, never sent to the renderer.
const { createKeyStore } = require('./tts-keys.js');
const { MAX_CHARS, DEFAULT_TIMEOUT_MS, fail, failFromThrown, failFromResponse, readCapped, contentTypeOf } = require('./tts-common.js');

const BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL = 'eleven_flash_v2_5';
const VI_MODELS = Object.freeze(['eleven_flash_v2_5', 'eleven_v3', 'eleven_v4', 'eleven_v4_turbo', 'eleven_v3_conversational']);
const KEY_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;
const VOICE_ID_SHAPE = /^[A-Za-z0-9]{8,40}$/;
const LANGS = ['en', 'vi'];

function createElevenTts({ safeStorage, dir, getConfig, fetchImpl = fetch, log = () => {}, id = 'elevenlabs' } = {}) {
  const keys = createKeyStore({ safeStorage, dir, file: 'elevenlabs-key.bin', importFile: 'elevenlabs-key.import', shape: KEY_SHAPE, log, label: 'elevenlabs' });
  keys.importIfPresent();
  const hasKey = () => Boolean(keys.read());
  const cfg = () => {
    const e = ((getConfig && getConfig()) || {}).voiceEleven || {};
    return { voiceId: typeof e.voiceId === 'string' ? e.voiceId : '', model: e.model || DEFAULT_MODEL };
  };

  async function synthesize(text, lang = 'en') {
    if (!LANGS.includes(lang)) return fail('unsupported_lang', `elevenlabs does not speak ${lang}`);
    const { voiceId, model } = cfg();
    // Checked first on purpose: it needs no key and no network, so the user learns about it before any paid call.
    if (lang === 'vi' && !VI_MODELS.includes(model)) return fail('unsupported_lang', `model ${model} has no Vietnamese`);
    if (typeof text !== 'string' || !text.trim()) return fail('bad_request', 'empty text');
    if (text.length > MAX_CHARS) return fail('bad_request', 'text too long');
    if (!VOICE_ID_SHAPE.test(voiceId)) return fail('no_config', 'ElevenLabs needs a voice id');
    const key = keys.read();
    if (!key) return fail('no_key', 'Requires an ElevenLabs API key');
    try {
      const res = await fetchImpl(`${BASE}/${encodeURIComponent(voiceId)}`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': key },
        body: JSON.stringify({ text, model_id: model }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) return await failFromResponse(res, key);
      const ct = contentTypeOf(res);
      if (ct && !/^audio\//i.test(ct)) return fail('bad_response', `content-type ${ct.slice(0, 60)}`);
      const body = await readCapped(res);
      if (!body.ok) return body;
      if (!body.buf.length) return fail('bad_response', 'empty audio', true);
      return { ok: true, mime: 'audio/mpeg', audios: [body.buf], voice: `${model}/${voiceId.slice(0, 6)}` };
    } catch (e) {
      return failFromThrown(e, key);
    }
  }

  return { id, langs: LANGS, paid: true, needsKey: true, hasKey, synthesize, setKey: keys.write, clearKey: keys.clear };
}

module.exports = { createElevenTts, BASE, DEFAULT_MODEL, VI_MODELS, KEY_SHAPE, VOICE_ID_SHAPE };
