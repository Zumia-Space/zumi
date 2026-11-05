// T-31 parity step 8b: the voice routing core, extracted from src/main/main.js under the freeze exception
// (PLAN-steps6plus section 4: "src/main/talk-voice-core.mjs (8b)", pure move, no IPC/window/Electron API change).
//
// Electron's main.js keeps the ipcMain handles and the sender check; everything between them -- the voice prefs
// (speed/volume + the BYO provider prefs), providerFor/providerList, the talk:tts route, testVoice and the fixed
// VOICE_GUIDES table -- lives here, unchanged in behaviour, so the Tauri sidecar can run exactly the same code.
//
// This module is Electron-free: no ipcMain, no BrowserWindow, no shell. Every side effect arrives through the
// dependencies passed to createTalkVoiceCore(); the adapter registry is a GETTER because main.js creates the
// adapters in app.whenReady, after the handlers are registered.
//
// Routing (PLAN section 10.4): Zumi's OWN lines (a live sayId) route by `talkVoiceLang` with no text detection -- an
// EN line carrying a Vietnamese title stays EN (and the title is dropped per F4 in speech-lines). Chat REPLIES route
// by `voiceReplyLang`; only `auto` runs the isVietnamese(text) detector (the same heuristic as local-tts.js:184).
import crypto from 'node:crypto';
import { voiceProviderPrefs, voiceConfig, patchVoiceConfig, resolveVoice, replyOutcome, viProviders, PROVIDER_LANGS, EN_PROVIDERS, REPLY_LANGS } from './tts-select.js';
import { stripMarkup } from './speech-chunker.js';

// Settings > Voice > Speed + Volume (T-31 settings-a2): settings.json voiceSpeed (0.75-1.5, Kokoro's own `speed`, so
// the pitch stays natural) and voiceVolume (0-1, the renderer's playback gain). Clamped here, the one writer.
export const VOICE_SPEED = { min: 0.75, max: 1.5, def: 1 };
export const clampNum = (v, min, max, def) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

const REFUSED = { ok: false, error: { code: 'forbidden', message: 'not the app page', retryable: false } };
const NO_VOICE = { ok: false, error: { code: 'talk_off', message: 'no voice available on this build', retryable: false } };

// Guide links on the Voice card (PLAN 10.3 item 5). The page names a guide, never a URL: this is the fixed table of
// exact https URLs (the same pattern as ai:open-key-page). They do not go through board-open.mjs decideExternalUrl,
// which is the rule for untrusted Board tab content.
export const VOICE_GUIDES = {
  google: 'https://cloud.google.com/text-to-speech/docs/',
  gemini: 'https://aistudio.google.com/apikey',
  geminiDocs: 'https://ai.google.dev/gemini-api/docs/speech-generation',
  elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
};

/** settings.json -> the voice prefs reply (main.js:1220-1229). Pure apart from `settings()`. */
export function voicePrefsOf(settings, ownerFlag = false) {
  const s = settings || {};
  return {
    speed: clampNum(s.voiceSpeed, VOICE_SPEED.min, VOICE_SPEED.max, VOICE_SPEED.def),
    volume: clampNum(s.voiceVolume, 0, 1, 1),
    // T-31 talk-mode (PLAN 10.3): the BYO provider choice per language + reply language + the non-secret voice
    // config. Validated by the pure voiceProviderPrefs(), so a bad saved value reads as its default.
    ...voiceProviderPrefs(s, { ownerFlag }),
  };
}

/**
 * @param {object} o
 * @param {() => object} o.settings                  loadSettings()
 * @param {(patch: object) => object} o.saveSettings merge-patch write
 * @param {() => boolean} [o.ownerFlag]              ownerVoiceFlag (owner-voice.json / the flavour's ownerAdmin)
 * @param {() => object} [o.talkPrefs]               talkPrefsFn(loadSettings) -> the scheduler's normalised prefs
 * @param {() => object} [o.adapters]                { google, gemini, elevenlabs, 'http-openai', 'http-zumia', 'zumia-owner' }
 * @param {() => object|null} [o.enTts]              tts-router.js instance (Kokoro once ready, Windows voice until then)
 * @param {() => object|null} [o.kokoro]             kokoro-tts.js instance (speed push on a pref change)
 * @param {() => object|null} [o.cloud]              cloud.js instance (the build's own talk server, when configured)
 * @param {(sayId: string) => boolean} [o.isLiveSay] scheduler.isLive(sayId)
 * @param {(turnId: string) => object|null} [o.takeLiveReply]  the liveReplies map's take-and-delete
 * @param {(sayId: string) => boolean} [o.saySilent]  the test-build ZUMI_TEST_SAY_SILENT hook
 * @param {() => string|null} [o.forceTtsFail]  the Electron E2E ZUMI_E2E_FORCE_TTS_FAIL substring (null = off)
 * @param {() => boolean} [o.realTts]           the Electron E2E ZUMI_E2E_REAL_TTS switch (skip the cloud stub)
 * @param {(url: string) => void} [o.openExternal]   Electron's shell.openExternal
 * @param {(line: string) => void} [o.log]           the [talk:tts] log sink (process.stdout.write in Electron)
 * @param {() => number} [o.now]
 */
export function createTalkVoiceCore({
  settings, saveSettings,
  ownerFlag = () => false,
  talkPrefs = () => ({}),
  adapters = () => ({}),
  enTts = () => null,
  kokoro = () => null,
  cloud = () => null,
  isLiveSay = () => false,
  takeLiveReply = () => null,
  saySilent = () => false,
  // Electron's own test-only env hooks. Defaults keep Electron byte-identical; a host that must not honour them
  // (the sidecar) passes them off, so the env cannot force a literal TTS failure in the preview.
  forceTtsFail = () => process.env.ZUMI_E2E_FORCE_TTS_FAIL || null,
  realTts = () => process.env.ZUMI_E2E_REAL_TTS === '1',
  openExternal = () => {},
  log = (line) => process.stdout.write(line),
  now = Date.now,
} = {}) {
  const owner = () => ownerFlag() === true;
  // Set by callers that do not run Kokoro yet (step 8b part 1 keeps the worker for part 2). Default: Electron's list.
  let includeKokoro = () => true;

  // main.js:1220-1255
  function voicePrefs() { return voicePrefsOf(settings(), owner()); }

  function setVoicePrefs(p) {
    if (!p || typeof p !== 'object') return voicePrefs();
    const cur = voicePrefs();
    const next = {
      voiceSpeed: Math.round(clampNum(p.speed, VOICE_SPEED.min, VOICE_SPEED.max, cur.speed) * 100) / 100,
      voiceVolume: Math.round(clampNum(p.volume, 0, 1, cur.volume) * 100) / 100,
    };
    // T-31 talk-mode (PLAN 10.3): the Voice card picks a provider per language and the reply language. The setter is
    // the gate: `zumia-owner` is refused without the owner flag, an unknown provider id is ignored, and the non-secret
    // voice config is validated. Nothing here is a secret; a key goes through talk:setProviderKey only.
    const allowedVi = viProviders(owner());
    if (typeof p.providerEn === 'string' && EN_PROVIDERS.includes(p.providerEn)) next.voiceProviderEn = p.providerEn;
    if (typeof p.providerVi === 'string' && allowedVi.includes(p.providerVi)) next.voiceProviderVi = p.providerVi;
    if (REPLY_LANGS.includes(p.voiceReplyLang)) next.voiceReplyLang = p.voiceReplyLang;
    // Non-secret voice config per provider (PLAN 10.1), merged by the pure patchVoiceConfig: every field is shape-gated
    // and the custom URLs follow the URL rules (https, or loopback http; no userinfo). A refused field keeps its value
    // and is named in `rejected` so the card can say which one.
    const merged = patchVoiceConfig(voiceConfig(settings()), p);
    for (const group of ['voiceGoogle', 'voiceGemini', 'voiceEleven', 'voiceCustom', 'voiceCustomZumia']) {
      if (p[group] && typeof p[group] === 'object') next[group] = merged.config[group];
    }
    saveSettings(next);
    const k = kokoro();
    if (k) k.setSpeed(next.voiceSpeed);
    return { ...voicePrefs(), rejected: merged.rejected };
  }

  // main.js:1303-1313
  function providerFor(id) {
    const a = adapters() || {};
    switch (id) {
      case 'google': return a.google || null;
      case 'gemini': return a.gemini || null;
      case 'elevenlabs': return a.elevenlabs || null;
      case 'http-openai': return a['http-openai'] || null;
      case 'http-zumia': return a['http-zumia'] || null;
      case 'zumia-owner': return owner() ? (a['zumia-owner'] || null) : null;
      default: return null;
    }
  }

  function logTts(turnId, lang, providerId, reason, result) {
    log(`[talk:tts] turn=${String(turnId || '').slice(0, 8)} lang=${lang} provider=${providerId} reason=${reason} result=${result || 'ok'}\n`);
  }

  // main.js:1317-1358. TTS result shape is unchanged ({ ok, mime, audios: Buffer[], voice } | { ok:false, error }); the
  // ROUTE is chosen by the talk-mode resolver (PLAN section 10.4): Zumi's own lines (a live sayId) by talkVoiceLang,
  // chat replies by voiceReplyLang, and the provider by language. Kokoro streams; every other provider awaits the
  // whole text.
  async function tts(p) {
    const tHandlerEntry = now(); // T-31 voice P1 live-E2E fix 1: per-stage timing (reply text arrives here)
    // A scheduler-issued line (a live sayId) skips the "Speak replies aloud" gate (PLAN F3): proactive talk is gated
    // by the talk level, not by the reply switch. Every other id must pass it.
    const sayId = p && p.sayId;
    const liveSay = Boolean(sayId && isLiveSay(sayId));
    if (settings().voiceEnabled === false && !liveSay) return { ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'voice-off' };
    const turnId = p && p.turnId;
    // Streamed turn (round 6): `p.text` is only the first clause; the live reply carries the rest. Kokoro speaks it as
    // it streams; every other route (cloud, Google, Zumia) needs the whole text, so it waits for the final reply.
    const live = turnId ? takeLiveReply(turnId) : null;
    const wholeText = async () => (live ? ((await live.final).reply || live.text() || p.text) : p.text);
    let text = p && p.text;
    // T-31 voice P1 E2E hooks (env-gated, test-only): both are no-ops unless the harness sets the env var.
    //   ZUMI_E2E_REAL_TTS=1        -> skip cloud.js's demo-fixture TTS stub and reach the real local synthesis.
    //   ZUMI_E2E_FORCE_TTS_FAIL=<substring> -> a turn whose text contains it gets a forced ok:false (retry-UI test).
    const forcedFail = forceTtsFail();
    if (forcedFail && typeof text === 'string' && text.includes(forcedFail)) {
      return { ok: false, error: { code: 'e2e_forced', message: 'forced failure for E2E retry-UI verification', retryable: true } };
    }
    text = stripMarkup(text); // T-31 0.2.3 B1: no markdown/asterisks/thinking/emoji reaches the voice (any route)
    // A reply that is only a link or code stays on screen; there is nothing to say aloud, and that is not a failure.
    const quiet = { ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'nothing-to-say' };
    if (!live && !text) return quiet;
    const c = cloud();
    if (c && c.status().enabled && !realTts()) { const said = stripMarkup(await wholeText()); return said ? c.tts({ ...p, text: said }) : quiet; }
    // T-31 talk-mode box-E2E hook (test builds only): a scheduler line returns silent so a run can assert the wiring
    // with no real synthesis.
    if (sayId && saySilent(sayId)) return { ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'test-silent' };
    const prefs = { ...talkPrefs(settings()), ...voiceProviderPrefs(settings(), { ownerFlag: owner() }) };
    const reason = liveSay ? 'say' : (prefs.voiceReplyLang === 'auto' ? 'reply-auto' : 'reply-fixed');
    const { lang, providerId, off } = resolveVoice({ prefs, ownerFlag: owner(), isSay: liveSay, text });
    if (off) { logTts(turnId, lang, providerId, reason, 'voice-off-lang'); return { ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'voice-off-lang' }; }
    // KOKORO keeps its streaming; on failure tts-router.js falls back to the free, local Windows voice (never paid).
    if (providerId === 'kokoro') { const e = enTts(); return e ? e.speak({ turnId, text, live }, tHandlerEntry) : NO_VOICE; }
    // Every other provider awaits the whole text. No silent cross-provider fallback (PLAN 10.4): the typed error is
    // returned as-is, so the existing "text stays + retry" UI handles it and no paid call is masked.
    const body = stripMarkup(await wholeText());
    if (!body) return quiet;
    const adapter = providerFor(providerId);
    if (!adapter) { logTts(turnId, lang, providerId, reason, 'no_provider'); return { ok: false, error: { code: 'no_provider', message: `no ${providerId} voice on this build`, retryable: false } }; }
    const r = await adapter.synthesize(body, lang);
    logTts(turnId, lang, providerId, reason, r.ok ? 'ok' : (r.error && r.error.code));
    // The one exception to the rule above (CoS 02-11): the owner route refused the key, so the turn takes the route a
    // missing owner flag takes (resolveVoice: google). With no Google key that is the usual note, never a charge.
    if (providerId === 'zumia-owner' && !r.ok && r.error && r.error.code === 'no_key') {
      const google = providerFor('google');
      if (google) {
        const g = await google.synthesize(body, lang);
        logTts(turnId, lang, 'google', 'owner-key-refused', g.ok ? 'ok' : (g.error && g.error.code));
        return replyOutcome(g, { providerId: 'google', isSay: liveSay });
      }
    }
    return replyOutcome(r, { providerId, isSay: liveSay });
  }

  // main.js:1384-1393. A key never crosses back (only hasKey).
  function providerList() {
    const out = [];
    if (includeKokoro()) out.push({ id: 'kokoro', langs: ['en'], paid: false, needsKey: false, hasKey: true });
    for (const id of ['google', 'gemini', 'elevenlabs', 'http-openai', 'http-zumia']) {
      const a = providerFor(id);
      // keyOptional: the custom endpoints take a bearer only if the user's server wants one; hasKey says whether one is stored.
      if (a) out.push({ id, langs: a.langs, paid: a.paid === true, needsKey: a.needsKey === true, keyOptional: a.keyOptional === true, hasKey: a.hasKey() });
    }
    if (owner() && providerFor('zumia-owner')) out.push({ id: 'zumia-owner', langs: ['vi'], paid: false, needsKey: false, keyOptional: false, hasKey: true });
    return out;
  }
  function setIncludeKokoro(fn) { includeKokoro = typeof fn === 'function' ? fn : () => true; }

  function setProviderKey(id, raw) {
    if (id === 'zumia-owner') return false; // provisioned by its import file only, never from the page
    const a = providerFor(id);
    return Boolean(a && a.setKey && a.setKey(raw));
  }
  function clearProviderKey(id) {
    if (id === 'zumia-owner') return false;
    const a = providerFor(id);
    if (a && a.clearKey) a.clearKey();
    return true;
  }

  // main.js:1408-1427. "Test voice" per language row: one short line through the provider chosen for that language,
  // returned as audio so the card can PLAY it (a typed error becomes a plain reason, never a key). The text comes from
  // the renderer (settings.sampleText), is capped at 200 characters and is never stored. A paid provider is called
  // exactly once per click.
  async function testVoice(p) {
    const lang = p && p.lang === 'vi' ? 'vi' : 'en';
    const text = stripMarkup(String((p && p.text) || '')).slice(0, 200);
    const vp = voiceProviderPrefs(settings(), { ownerFlag: owner() });
    let providerId = lang === 'vi' ? vp.voiceProviderVi : vp.voiceProviderEn;
    if (providerId === 'zumia-owner' && !owner()) providerId = 'google';
    if (providerId === 'off' || !(PROVIDER_LANGS[providerId] || []).includes(lang)) return { ok: false, reason: 'voice-off-lang' };
    if (!text) return { ok: false, reason: 'bad_request' };
    if (providerId === 'kokoro') {
      const e = enTts();
      if (!e) return { ok: false, reason: 'no_provider' };
      // A real turn id: the Windows voice refuses any other shape, so without Kokoro the Test voice button failed (measured on a public build).
      const r = await e.speak({ turnId: crypto.randomBytes(16).toString('hex'), text });
      return r && r.ok && Array.isArray(r.audios) && r.audios.length ? { ok: true, mime: r.mime, audios: r.audios } : { ok: false, reason: (r && r.error && r.error.code) || (r && r.reason) || 'failed' };
    }
    const adapter = providerFor(providerId);
    if (!adapter) return { ok: false, reason: 'no_provider' };
    const r = await adapter.synthesize(text, lang);
    logTts('test', lang, providerId, 'test', r.ok ? 'ok' : (r.error && r.error.code));
    return r.ok ? { ok: true, mime: r.mime, audios: r.audios } : { ok: false, reason: (r && r.error && r.error.code) || 'failed' };
  }

  // main.js:1437-1441. The page names a guide, never a URL.
  function openGuide(id) {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(VOICE_GUIDES, id)) return false;
    openExternal(VOICE_GUIDES[id]);
    return true;
  }

  return {
    REFUSED, NO_VOICE,
    voicePrefs, setVoicePrefs,
    providerFor, providerList,
    setProviderKey, clearProviderKey,
    tts, testVoice, openGuide,
    setIncludeKokoro,
  };
}
