// Talk path wiring for the renderer: library + cache + rig probe + speech + director, and the small UI it drives.
import { SpeechLibrary } from './library.js';
import { GestureCache } from './cache.js';
import { SpeechOut } from './speech.js';
import { RigProbe } from './rigprobe.js';
import { TalkDirector } from './director.js';
import { checkSpeechGesture } from './validate.js';
import { VRMUtils } from '@pixiv/three-vrm';
import { t, isPublicText } from '../i18n.js';
import { createReflexTiming } from './reflex-timing.js';

// Hash of the rig/schema/player/engine sources, injected at build time (scripts/build-renderer.mjs).
/* global __RIG_SRC_HASH__ */
const RIG_SRC_HASH = typeof __RIG_SRC_HASH__ === 'string' ? __RIG_SRC_HASH__ : 'dev';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data) => hex(await crypto.subtle.digest('SHA-256', data));

export async function createTalk({ zumi, engine, catalog, loader, camera, prepareVrm, ui, canned = false }) {
  const status = await zumi.talk.status();
  if (canned) ui.setCanned(); // demo with recorded answers: say so on screen, never show canned analysis
  const library = await SpeechLibrary.load((f) => fetch(`speech/${f}`).then((r) => r.json()));
  const speech = new SpeechOut();
  speech.warmup(); // T-31 voice P1 live-E2E fix 1: fire-and-forget, gets the AudioContext running ahead of turn 1
  let rigVersion = null;
  let cache = null;
  let probe = null;
  let probeError = null;
  let ready = Promise.resolve(false);
  let director = null;
  const cacheCheck = (cmd) => checkSpeechGesture(cmd);

  async function prepare(m) {
    const bytes = await (await fetch(m.url)).arrayBuffer();
    const modelHash = await sha256(bytes);
    rigVersion = (await sha256(new TextEncoder().encode(`${RIG_SRC_HASH}|${modelHash}`))).slice(0, 32);
    cache = new GestureCache({ rigVersion, check: cacheCheck }).load(await zumi.gcache.load());
    if (probe) { VRMUtils.deepDispose(probe.vrm.scene); probe = null; } // the previous model's hidden copy
    probeError = null;
    director = new TalkDirector({
      engine, catalog, cloud: zumi.talk, speech, library, cache,
      saveCache: (text) => zumi.gcache.save(text),
      probe: () => probe,
      rigVersion: () => rigVersion,
      ui,
      log: (rec) => zumi.talk.log(rec),
    });
    try { probe = await RigProbe.create({ loader, bytes, stageCamera: camera, catalog, prepare: prepareVrm }); } catch (e) { probeError = String((e && e.stack) || e).slice(0, 2000); console.error('rig probe', e); }
    return true;
  }

  ui.setEnabled(status.enabled);
  return {
    status,
    muted: false, // self-tests mute the Enter key path while the reflex cases run, then drive talk on purpose
    get enabled() { return status.enabled && Boolean(director); },
    library, speech,
    get cache() { return cache; },
    get probe() { return probe; },
    get probeError() { return probeError; },
    get director() { return director; },
    get rigVersion() { return rigVersion; },
    onModel(m) { ready = prepare(m); return ready; },
    ready: () => ready,
    mouth: () => speech.mouth(),
    send(text) { return director ? director.send(text) : null; },
    // Settings > AI brain saved or cleared the key: chat turns on/off without a restart (main reads the key per call).
    async refreshStatus() {
      try { Object.assign(status, await zumi.talk.status()); } catch { /* keep the last known status */ }
      ui.setEnabled(status.enabled);
      return status;
    },
    // Settings > Voice > "Play sample": one fixed line through the normal voice path (main's talk:tts picks the voice
    // by language, with the saved speed), played with the saved volume; Zumi's mouth follows it like a reply.
    // -> { ok: true } | { ok: false, reason: 'voice-off' | 'no-google-key' | <error code> }
    async playSample(text) {
      const turnId = `sample-${Date.now().toString(36)}`;
      const off = zumi.talk.onTtsMore(turnId, (audio) => { speech.append(audio); });
      try {
        const r = await zumi.talk.tts({ turnId, text });
        if (!r || !r.ok) return { ok: false, reason: (r && r.error && r.error.code) || 'failed' };
        if (!Array.isArray(r.audios) || !r.audios.length) return { ok: false, reason: r.reason || 'no-audio' };
        const prepared = await speech.prepare(r.audios);
        await prepared.start().ended;
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e).slice(0, 80) };
      } finally { off(); }
    },
    // Settings > Voice > "Test voice" (T-31 talk-mode, PLAN 10.3 item 6): one short line through the provider chosen for
    // `lang`, played with the saved volume. Main returns the audio (or a typed reason, never a key); a paid provider is
    // called once per click. -> { ok: true } | { ok: false, reason: <typed error code | 'voice-off-lang' | ...> }
    async playTest(lang, text) {
      try {
        const r = await zumi.talk.testVoice({ lang, text });
        if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'failed' };
        if (!Array.isArray(r.audios) || !r.audios.length) return { ok: false, reason: 'no-audio' };
        const prepared = await speech.prepare(r.audios);
        await prepared.start().ended;
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e).slice(0, 80) };
      }
    },
  };
}

// The conversation UI on the stage. Model output is plain text: textContent only, never innerHTML.
// openSource(url): opens a Look up source in the OS browser (main checks the URL was really cited).
export function talkUi($, { openSource = null, ageConfirm = null } = {}) {
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text || ''; };
  // T-31 free LLM S1 (Tauri only; null callbacks in Electron): when the sidecar fails a Gemini turn closed with
  // `age_confirm_required`, offer the confirm here too. Built on demand, never in index.html, so Electron's DOM is
  // unchanged. The buttons call the sidecar setter / provider switch; the user then sends the message again.
  let ageBox = null;
  const hideAge = () => { if (ageBox) ageBox.hidden = true; };
  function showAgeConfirm() {
    if (!ageConfirm) return;
    const anchor = $('talk-note') || $('talk-status');
    if (!anchor || !anchor.parentNode) return;
    if (!ageBox) {
      ageBox = document.createElement('div');
      ageBox.id = 'talk-age-confirm';
      ageBox.className = 'talk-row';
      const reason = document.createElement('p');
      reason.id = 'talk-age-confirm-reason';
      const yes = document.createElement('button');
      yes.id = 'talk-age-confirm-yes';
      yes.type = 'button';
      yes.className = 'ghost slim';
      yes.textContent = t('settings.presetAge18');
      const other = document.createElement('button');
      other.id = 'talk-age-confirm-switch';
      other.type = 'button';
      other.className = 'ghost slim';
      other.textContent = t('settings.presetSwitchProvider');
      yes.addEventListener('click', async () => {
        if (!ageConfirm.confirm) return;
        let r = null;
        try { r = await ageConfirm.confirm(); } catch { r = null; }
        if (r && r.ok) { hideAge(); set('talk-note', t('settings.presetAge18Confirmed')); }
      });
      other.addEventListener('click', async () => {
        if (!ageConfirm.switchProvider) return;
        try { await ageConfirm.switchProvider(); } catch { /* keep the confirm */ }
        hideAge();
        set('talk-note', t('app.ageConfirmRequired'));
      });
      ageBox.appendChild(reason);
      ageBox.appendChild(yes);
      ageBox.appendChild(other);
      anchor.parentNode.insertBefore(ageBox, anchor.nextSibling);
    }
    ageBox.hidden = false;
    set('talk-age-confirm-reason', t('settings.presetAge18Reason'));
  }
  // A talk strip collapses (hidden) whenever its value is empty, so an unused line never sits over the model.
  // .talk-row sets display:flex, so the CSS carries a matching [hidden] rule for this to take effect.
  const setRow = (id, text) => {
    const el = $(id); if (!el) return el;
    el.textContent = text || '';
    if (el.parentElement && el.parentElement.classList.contains('talk-row')) el.parentElement.hidden = !el.textContent;
    return el;
  };
  // One analysis row (label + value) is shown only when it has text; the <dd>'s id is the row's handle.
  const setAnalysisRow = (ddId, text) => {
    const dd = $(ddId); if (!dd) return false;
    const value = (text || '').trim();
    dd.textContent = value;
    const on = Boolean(value);
    dd.hidden = !on;
    const dt = dd.previousElementSibling;
    if (dt && dt.tagName === 'DT') dt.hidden = !on;
    return on;
  };
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
  // Models by role (T-31 zumi-roles): one chip row under the reply -- "Planned" (the outline in its tooltip),
  // "Checked ✓" / "Check", "Sources: <sites>" (links) -- plus the Check correction as its own text row. state:
  // { planned, outline, sources: [{url, title}], check: {verdict, text} | null } | null (clears both). Never spoken.
  function paintRoles(state) {
    const row = $('talk-roles');
    if (!row) return;
    const s = state || {};
    row.textContent = '';
    const chip = (text, cls, title) => { const c = document.createElement('span'); c.className = `rchip ${cls}`; c.textContent = text; if (title) c.title = title; row.appendChild(c); };
    if (s.planned) chip(t('talk.planned'), 'plan', s.outline || '');
    if (s.check) chip(t(s.check.verdict === 'ok' ? 'talk.checked' : 'talk.checkFix'), s.check.verdict);
    if (Array.isArray(s.sources) && s.sources.length) {
      const src = document.createElement('span'); src.className = 'src';
      const label = document.createElement('span'); label.textContent = t('talk.sources');
      src.appendChild(label);
      for (const so of s.sources) {
        const a = document.createElement('a');
        a.href = so.url;
        a.textContent = hostOf(so.url);
        a.title = so.title ? `${so.title}\n${so.url}` : so.url;
        a.addEventListener('click', (ev) => { ev.preventDefault(); if (openSource) openSource(so.url); });
        src.appendChild(a);
      }
      row.appendChild(src);
    }
    row.hidden = !row.childNodes.length;
    setRow('talk-check', s.check && s.check.verdict === 'fix' ? s.check.text : '');
  }
  let canned = false;
  // Developer-mode gate, published by settings.js applyDevTools (stored switch OR an unpackaged dev run). Off until told.
  const reflex = createReflexTiming({ $, set, t, isCanned: () => canned });
  let devMode = false;
  const publicHidesGesture = () => isPublicText() && !devMode;
  if (typeof document !== 'undefined') document.addEventListener('zumi:dev-chrome', (e) => { devMode = Boolean(e.detail); reflex.setDevMode(e.detail); });
  return {
    setCanned() {
      canned = true;
      $('demo-banner').hidden = false;
      $('analysis').hidden = true;
      $('an-off').hidden = false;
    },
    setEnabled(on) {
      if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') document.dispatchEvent(new CustomEvent('zumi:talk-enabled', { detail: on }));
      $('talk').hidden = !on;
      $('msg').placeholder = on ? t('msg.placeholderOn') : t('msg.placeholderOff');
    },
    userLine(text) {
      setRow('talk-user', text); setRow('talk-reply', ''); set('talk-gesture', ''); set('talk-note', ''); paintRoles(null);
      $('talk-gesture').classList.remove('show');
      if (!canned) $('analysis').hidden = true;
      const retryBtn = $('talk-retry-voice'); if (retryBtn) { retryBtn.hidden = true; retryBtn.onclick = null; } // a new turn starts: any previous turn's retry control is stale
    },
    thinking(on) { set('talk-status', on ? t('app.thinking') : ''); },
    // A short honest line when there is nothing to play (e.g. no Vietnamese voice installed) — never silent-without-reason.
    // Its own row, not talk-status, because finish() clears the thinking row at the end of every turn.
    voiceNote(text) { set('talk-note', text || ''); },
    // T-31 voice P1 live-E2E fix 3: shows/hides the "Retry voice" button for a turn whose TTS genuinely failed
    // (not the benign no-key/no-voice/voice-off cases, which get voiceNote() above instead). `onRetry` is a
    // zero-arg callback; pass null/undefined to hide the control (a new turn, or a retry that just succeeded).
    voiceFailed(onRetry) {
      const btn = $('talk-retry-voice');
      if (!btn) return;
      if (typeof onRetry !== 'function') { btn.hidden = true; btn.onclick = null; return; }
      btn.hidden = false;
      btn.onclick = () => { if (btn.disabled) return; btn.disabled = true; Promise.resolve(onRetry()).finally(() => { btn.disabled = false; }); };
    },
    reply(text, fallback) { const el = setRow('talk-reply', text || fallback); if (el) el.classList.toggle('failed', !text); },
    // T-31 free LLM S1: Tauri-only confirm for a Gemini turn the sidecar refused (age_confirm_required).
    ageConfirm: showAgeConfirm,
    roles: paintRoles,
    // Jev fast-reflex timing (shown the moment Enter fires, ahead of the full /turn answer — reveals #analysis
    // early so the owner sees it even before analysis() below has anything to show). Skipped in canned/demo-fixture
    // mode, same convention as analysis(): a recorded run never claims a live timing it didn't measure.
    // Developer chrome (T-31 0.2.10): shown only while Developer mode is on (settings.js publishes the gate).
    reflexTiming(ms, source) {
      reflex.show(ms, source);
    },
    analysis(lines, missing) {
      if (canned) return; // recorded answers: the panel stays hidden, the one-line notice stays
      $('analysis').hidden = false;
      const shown = lines
        ? [setAnalysisRow('an-understood', lines.understood), setAnalysisRow('an-plan', lines.plan), setAnalysisRow('an-why', lines.why)]
        : [setAnalysisRow('an-understood', ''), setAnalysisRow('an-plan', ''), setAnalysisRow('an-why', '')];
      const any = shown.some(Boolean);
      $('an-lines').hidden = !any;
      $('an-missing').hidden = any;
      if (!any) set('an-missing', missing);
    },
    gesture(label, source) {
      if (publicHidesGesture()) return;
      set('talk-gesture', t('app.gestureLine', { label, source }));
      $('talk-gesture').classList.add('show'); // stays for the whole turn (a caption the owner can read), cleared by the next line
    },
  };
}
