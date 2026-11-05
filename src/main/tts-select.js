'use strict';
// BYO voice-provider selection (T-31 talk-mode, PLAN sections 10.2-10.4). Pure: no Electron, no fetch. It owns the
// provider-prefs validation, the owner-voice flag reader and the language + provider resolution that talk:tts uses.
//
// Routing (PLAN section 10.4): Zumi's OWN lines (a live sayId) route by `talkVoiceLang` with no text detection -- an
// EN line carrying a Vietnamese title stays EN (and the title is dropped per F4 in speech-lines). Chat REPLIES route
// by `voiceReplyLang`; only `auto` runs the isVietnamese(text) detector (the same heuristic as local-tts.js:184).
const fs = require('node:fs');
const path = require('node:path');
const { isVietnamese } = require('./local-tts.js');
const { validateCustomUrl } = require('./tts-common.js');

// Providers offered per language (all wired as of inc 3).
const EN_PROVIDERS = ['kokoro', 'google', 'gemini', 'elevenlabs', 'http-openai', 'http-zumia'];
const VI_PROVIDERS = ['google', 'gemini', 'elevenlabs', 'http-openai', 'http-zumia', 'off'];
const OWNER_PROVIDER = 'zumia-owner';
const REPLY_LANGS = ['auto', 'en', 'vi'];
const PROVIDER_LANGS = {
  kokoro: ['en'], google: ['en', 'vi'], gemini: ['en', 'vi'], elevenlabs: ['en', 'vi'],
  'http-openai': ['en', 'vi'], 'http-zumia': ['en', 'vi'], [OWNER_PROVIDER]: ['vi'],
};
const DEFAULT_VOICE_GOOGLE = { en: 'en-US-Chirp3-HD-Leda', vi: 'vi-VN-Chirp3-HD-Leda' };

/** The VI options at this moment: `off` is always offered, `zumia-owner` only while the owner flag is present. */
function viProviders(ownerFlag) { return ownerFlag ? [...VI_PROVIDERS, OWNER_PROVIDER] : [...VI_PROVIDERS]; }

/**
 * Read `<userData>/owner-voice.json` = `{ "v": 1, "zumiaVoice": true }` (PLAN section 10.2). Strict JSON and an
 * EXACT two-key shape: anything else (missing file, bad JSON, extra/missing keys, wrong values) counts as absent.
 * The file holds no URL and no secret.
 */
function readOwnerVoiceFlag(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'owner-voice.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const keys = Object.keys(raw).sort();
    if (keys.length !== 2 || keys[0] !== 'v' || keys[1] !== 'zumiaVoice') return false;
    return raw.v === 1 && raw.zumiaVoice === true;
  } catch { return false; }
}

const strOr = (v, d) => (typeof v === 'string' && v.trim() ? v : d);

// Shape gates for the non-secret voice config (PLAN section 10.1). They bound what can reach a request body, a URL
// path (the ElevenLabs voice id) or a log line; they are shape checks, not allow-lists of real voices.
const SHAPES = {
  geminiModel: /^[A-Za-z0-9._-]{1,60}$/, geminiVoice: /^[A-Za-z0-9_-]{1,40}$/,
  elevenVoiceId: /^[A-Za-z0-9]{8,40}$/, elevenModel: /^[a-z0-9_]{1,40}$/,
  customName: /^[A-Za-z0-9._:+/-]{1,80}$/,
};
const DEFAULT_CONFIG = Object.freeze({
  voiceGemini: { model: 'gemini-3.8-flash-tts', voice: 'Kore' },
  voiceEleven: { voiceId: '', model: 'eleven_flash_v2_5' },
  voiceCustom: { base: '', model: 'tts-1', voice: 'alloy' },
  voiceCustomZumia: { url: '' },
});
const shaped = (v, re, d) => (typeof v === 'string' && re.test(v.trim()) ? v.trim() : d);
const urlOr = (v) => { const r = validateCustomUrl(v); return r.ok ? r.url : ''; };

/** Non-secret voice config normalised from settings.json (PLAN section 10.1 table). Every field is shape-gated. */
function voiceConfig(s) {
  const g = (s && s.voiceGoogle) || {};
  const gm = (s && s.voiceGemini) || {};
  const el = (s && s.voiceEleven) || {};
  const cu = (s && s.voiceCustom) || {};
  const cz = (s && s.voiceCustomZumia) || {};
  return {
    voiceGoogle: { en: strOr(g.en, DEFAULT_VOICE_GOOGLE.en), vi: strOr(g.vi, DEFAULT_VOICE_GOOGLE.vi) },
    voiceGemini: { model: shaped(gm.model, SHAPES.geminiModel, DEFAULT_CONFIG.voiceGemini.model), voice: shaped(gm.voice, SHAPES.geminiVoice, DEFAULT_CONFIG.voiceGemini.voice) },
    voiceEleven: { voiceId: shaped(el.voiceId, SHAPES.elevenVoiceId, ''), model: shaped(el.model, SHAPES.elevenModel, DEFAULT_CONFIG.voiceEleven.model) },
    voiceCustom: { base: urlOr(cu.base), model: shaped(cu.model, SHAPES.customName, DEFAULT_CONFIG.voiceCustom.model), voice: shaped(cu.voice, SHAPES.customName, DEFAULT_CONFIG.voiceCustom.voice) },
    voiceCustomZumia: { url: urlOr(cz.url) },
  };
}

/**
 * Merge a renderer patch into the current config. Pure. A field that fails its shape/URL gate is IGNORED (the current
 * value stays) and reported in `rejected`; an empty string clears a clearable field (voice id, URLs).
 * -> { config, rejected: ['voiceCustom.base', ...] }
 */
function patchVoiceConfig(cur, patch) {
  const next = JSON.parse(JSON.stringify(cur));
  const rejected = [];
  const p = patch && typeof patch === 'object' ? patch : {};
  const put = (group, field, v, re, clearable = false) => {
    if (v === undefined) return;
    if (typeof v === 'string' && v.trim() === '' && clearable) { next[group][field] = ''; return; }
    if (typeof v === 'string' && re.test(v.trim())) next[group][field] = v.trim(); else rejected.push(`${group}.${field}`);
  };
  const putUrl = (group, field, v) => {
    if (v === undefined) return;
    if (typeof v === 'string' && v.trim() === '') { next[group][field] = ''; return; }
    const r = validateCustomUrl(v);
    if (r.ok) next[group][field] = r.url; else rejected.push(`${group}.${field}`);
  };
  if (p.voiceGoogle && typeof p.voiceGoogle === 'object') {
    for (const l of ['en', 'vi']) if (typeof p.voiceGoogle[l] === 'string' && p.voiceGoogle[l].trim()) next.voiceGoogle[l] = p.voiceGoogle[l].trim().slice(0, 80);
  }
  if (p.voiceGemini && typeof p.voiceGemini === 'object') { put('voiceGemini', 'model', p.voiceGemini.model, SHAPES.geminiModel); put('voiceGemini', 'voice', p.voiceGemini.voice, SHAPES.geminiVoice); }
  if (p.voiceEleven && typeof p.voiceEleven === 'object') { put('voiceEleven', 'voiceId', p.voiceEleven.voiceId, SHAPES.elevenVoiceId, true); put('voiceEleven', 'model', p.voiceEleven.model, SHAPES.elevenModel); }
  if (p.voiceCustom && typeof p.voiceCustom === 'object') { putUrl('voiceCustom', 'base', p.voiceCustom.base); put('voiceCustom', 'model', p.voiceCustom.model, SHAPES.customName); put('voiceCustom', 'voice', p.voiceCustom.voice, SHAPES.customName); }
  if (p.voiceCustomZumia && typeof p.voiceCustomZumia === 'object') putUrl('voiceCustomZumia', 'url', p.voiceCustomZumia.url);
  return { config: next, rejected };
}

/**
 * settings.json -> normalised provider prefs. Pure. Any unknown or invalid value becomes its default.
 * `ownerFlag` (from readOwnerVoiceFlag) only changes the VI DEFAULT: a saved VI choice always wins (PLAN 10.2); a
 * saved `zumia-owner` without the flag falls back to `google`.
 */
function voiceProviderPrefs(settings, { ownerFlag = false } = {}) {
  const s = settings || {};
  const en = EN_PROVIDERS.includes(s.voiceProviderEn) ? s.voiceProviderEn : 'kokoro';
  const viAllowed = viProviders(ownerFlag);
  const viDefault = ownerFlag ? OWNER_PROVIDER : 'google';
  const vi = viAllowed.includes(s.voiceProviderVi) ? s.voiceProviderVi : viDefault;
  return {
    voiceProviderEn: en,
    voiceProviderVi: vi,
    voiceReplyLang: REPLY_LANGS.includes(s.voiceReplyLang) ? s.voiceReplyLang : 'auto',
    ...voiceConfig(s),
  };
}

/**
 * `prefs` carries both the talk prefs (talkVoiceLang) and the provider prefs (voiceProviderEn/Vi/voiceReplyLang).
 * -> { lang: 'en'|'vi', providerId, off: boolean }. `off` is true when the chosen provider cannot speak `lang`
 * (the `off` option, or a provider that does not list that language): talk:tts then returns voice-off-lang.
 */
function resolveVoice({ prefs, ownerFlag = false, isSay = false, text = '' } = {}) {
  const p = prefs || {};
  let lang;
  if (isSay) {
    lang = p.talkVoiceLang === 'vi' ? 'vi' : 'en'; // Zumi's own line: the chosen language, no detection (F3)
  } else {
    const rl = REPLY_LANGS.includes(p.voiceReplyLang) ? p.voiceReplyLang : 'auto';
    lang = rl === 'en' ? 'en' : rl === 'vi' ? 'vi' : (isVietnamese(text) ? 'vi' : 'en');
  }
  let providerId = lang === 'vi' ? (p.voiceProviderVi || 'google') : (p.voiceProviderEn || 'kokoro');
  // The owner route exists only while the flag is present; without it, fall back to the language default.
  if (providerId === OWNER_PROVIDER && !ownerFlag) providerId = lang === 'vi' ? 'google' : 'kokoro';
  const off = providerId === 'off' || !(PROVIDER_LANGS[providerId] || []).includes(lang);
  return { lang, providerId, off };
}

/**
 * A chat reply (not Zumi's own line) on the Google voice with no key is a known by-design silence, not a failure
 * (0.2.4 behaviour): the renderer shows the "needs a Google key" note and no Retry. Every other typed error keeps
 * its error shape (no silent cross-provider fallback, PLAN 10.4). Pure.
 */
function replyOutcome(result, { providerId, isSay = false } = {}) {
  const r = result;
  if (!isSay && providerId === 'google' && r && r.ok === false && r.error && r.error.code === 'no_key') {
    return { ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'no-google-key' };
  }
  return r;
}

module.exports = { replyOutcome, resolveVoice, voiceProviderPrefs, readOwnerVoiceFlag, voiceConfig, patchVoiceConfig, DEFAULT_CONFIG, viProviders, PROVIDER_LANGS, EN_PROVIDERS, VI_PROVIDERS, REPLY_LANGS, OWNER_PROVIDER, DEFAULT_VOICE_GOOGLE };
