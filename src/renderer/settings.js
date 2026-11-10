// Settings > "Bảng thật" (T-31 L1). Wires the narrow `zumi.board` namespace: the owner stores the live-board
// credentials + a 6-digit PIN, unlocks/locks the session, and switches between the on-machine board and his real
// board. Every input is cleared the moment `setSecrets` resolves — the credentials never stay in the DOM, and are
// never written to localStorage or any other renderer storage.
import { t, onLocaleChange, isPublicText } from './i18n.js';
import { initVoiceProviders } from './voice-providers.js';

// Main-process error codes -> i18n keys (the L1 UI contract). The renderer owns the words.
// Exported so board-signin.js (the owner-build Board-tab sign-in card) maps the SAME zumi.board.* error codes to
// the SAME words, rather than forking its own copy.
export const ERROR_KEY = {
  bad_pin_shape: 'err.bad_pin_shape',
  bad_secrets_shape: 'err.bad_secrets_shape',
  bad_user_whitespace: 'err.bad_user_whitespace',
  no_encryption: 'err.no_encryption',
  not_configured: 'err.not_configured',
  not_ready: 'err.not_ready',
  bad_request: 'err.bad_request',
  // "Require PIN for Board" toggle (board-secrets.mjs disablePin/enablePin/configureOs) -- defensive mappings only;
  // the toggle UI below never fires a request that could hit already_os/already_pin/use_toggle itself.
  already_os: 'err.already_os',
  already_pin: 'err.already_pin',
  use_toggle: 'err.use_toggle',
};

// Which developer chrome is visible: the three sidebar debug buttons and the version tag. `storedOn` is the
// persisted "Developer mode" switch (settings.json `developerMode` -- NOT the pre-update `devTools` key, which is
// ignored); `devRun` is an unpackaged `electron .` run (app.js passes it) which keeps the controls visible so the
// app's own developer never has to flip the switch while working.
export function devChromeVisible({ storedOn = false, devRun = false } = {}) {
  return Boolean(devRun) || Boolean(storedOn);
}

// voice: { setVolume(0-1), playSample(text) -> {ok, reason}, playTest(lang, text) -> {ok, reason} } -- app.js's talk playback (Settings > Voice).
export function initSettings(zumi, $, { onBoardChange, devBuild, ownerAdmin, voice = null } = {}) {
  const el = {
    token: $('board-token'), user: $('board-user'), pass: $('board-pass'),
    pin: $('board-pin'), confirm: $('board-pin-confirm'),
    status: $('board-status'), note: $('board-note'), retry: $('board-retry'),
    save: $('board-save'), unlockPin: $('board-unlock-pin'), unlock: $('board-unlock'), lock: $('board-lock'),
    unlockRow: $('board-unlock-row'), signOut: $('board-signout'), signOutRow: $('board-signout-row'),
    // "Require PIN for Board" toggle (T-31 voice-P1 follow-up, owner request 08-10).
    pinRequired: $('board-pin-required'), pinTogglePrompt: $('board-pin-toggle-prompt'),
    pinTogglePin: $('board-pin-toggle-pin'), pinToggleConfirm: $('board-pin-toggle-confirm'),
    pinToggleApply: $('board-pin-toggle-apply'), pinToggleCancel: $('board-pin-toggle-cancel'),
    pinToggleNote: $('board-pin-toggle-note'),
    modeSwitch: $('board-mode-switch'), modeLocal: $('mode-local'), modeLive: $('mode-live'),
    // Settings A2: Account card (state pill + the sign-in form behind "Change sign-in"), Privacy card (session line).
    boardChip: $('board-chip'), formToggle: $('board-form-toggle'), form: $('board-form'),
    sessionDesc: $('board-session-desc'), sessionNote: $('board-session-note'),
    voice: $('voice-status'), voiceEnName: $('voice-en-name'), voiceSpeaking: $('voice-speaking'),
    speed: $('voice-speed'), speedVal: $('voice-speed-val'), volume: $('voice-volume'), volumeVal: $('voice-volume-val'),
    sample: $('voice-sample'), sampleNote: $('voice-sample-note'),
    devTools: $('dev-tools'), version: $('app-version'),
    simBoard: $('sim-board'), camRegister: $('cam-register'), lookTuning: $('look-tuning-toggle'),
    sendClientNames: $('send-client-names'),
    // T-31 voice P1 item 7.
    voiceEnabled: $('voice-enabled'), thinkSound: $('think-sound'), voiceKokoroProgress: $('voice-kokoro-progress'),
    // T-31 settings P1: Workflow tab's typed-reply speech switch.
    typedReplySpeech: $('typed-reply-speech'),
    kokoroRow: $('voice-kokoro-row'), kokoroBar: $('voice-kokoro-bar'), kokoroChip: $('voice-kokoro-chip'), kokoroDesc: $('voice-kokoro-desc'),
    ledaKey: $('voice-leda-key'), ledaSave: $('voice-leda-save'), ledaClear: $('voice-leda-clear'), ledaStatus: $('voice-leda-status'), ledaChip: $('voice-leda-chip'),
    // T-31 talk-mode (PLAN 5.1 / 10.3): the "how much Zumi talks" rows + the per-language voice provider selects.
    talkLevel: $('talk-level'), talkLevelDesc: $('talk-level-desc'), talkQuiet: $('talk-quiet'),
    talkQuietStart: $('talk-quiet-start'), talkQuietEnd: $('talk-quiet-end'), talkLang: $('talk-lang'), talkLangNote: $('talk-lang-note'),
    providerEn: $('voice-provider-en'), providerVi: $('voice-provider-vi'),
  };
  // Owner build (coordinator scope-add 07-10): the local/sample board is gone from this build entirely (app.js's
  // Board tab never mounts it), so the local<->live choice here is meaningless -- hide the radio pair. A non-owner
  // build still gets the switch.
  if (ownerAdmin && el.modeSwitch) el.modeSwitch.hidden = true;
  // Owner build only: its Board tab may change lane models through the loopback bridge (ownerOps). With the PIN off
  // that stays possible for any local app while the board is open (Fable/Sol bridge gate 10-10, condition 3), so the
  // line sits next to the toggle in both states: he turns it off knowingly.
  if (ownerAdmin && $('pin-off-risk')) $('pin-off-risk').hidden = false;
  const pill = (node, key, tone) => { node.textContent = t(key); node.className = tone ? `pill ${tone}` : 'pill'; };
  // One read-only option (the English voice): the select shows the current voice in the A2 picker style without
  // offering voices that are not wired yet. Empty `label` -> no option at all.
  const singleOption = (select, label) => {
    select.innerHTML = '';
    if (!label) return;
    const o = document.createElement('option');
    o.textContent = label;
    select.appendChild(o);
  };
  // (The AI brain card -- provider + "Your own key" -- is brain-key-card.js.)
  // English voice row: which voice speaks the replies, by a user-facing name (Kokoro's "af_heart" reads "Heart"; a
  // Windows voice keeps its OS name) -- never a raw voice id, never a key.
  const voiceName = (v) => {
    if (!v || !v.voice) return '';
    if (v.mode !== 'kokoro') return String(v.voice);
    const tail = String(v.voice).split('_').pop();
    return tail.charAt(0).toUpperCase() + tail.slice(1);
  };
  const paintVoice = (v) => {
    const mode = v && v.mode;
    el.voice.textContent = t(mode === 'cloud' ? 'settings.enVoiceCloudD' : mode === 'kokoro' ? 'settings.enVoiceKokoroD' : mode === 'windows' ? 'settings.enVoiceWindowsD' : 'settings.enVoiceOffD');
    if (el.voiceEnName) { const name = voiceName(v); singleOption(el.voiceEnName, name); el.voiceEnName.hidden = !name; }
    if (isPublicText() && el.voiceSpeaking) el.voiceSpeaking.textContent = t('settings.voiceSpeaking', { voice: voiceName(v) || t('settings.voiceSpeakingNone') });
    if (isPublicText() && el.voiceSpeaking) el.voiceSpeaking.hidden = false;
  };
  const renderVoice = () => {
    if (!el.voice) return;
    zumi.talk.voiceInfo().then(paintVoice).catch(() => paintVoice(null));
  };
  // T-31 talk-mode (PLAN 10.3): the Voice card reads the provider list from main (no secrets -- only hasKey crosses
  // back) and shows the Google key chip. The old single-Leda IPC is gone; a key now goes through talk:setProviderKey
  // ('google', ...). The provider selects offer exactly the providers main reports for each language (kokoro for EN;
  // google + "off", plus the owner Zumia route only while the owner flag is present, for VI).
  let providerList = [];
  let voiceSaved = {}; // { voiceProviderEn, voiceProviderVi, ... } from main, non-secret
  const vp = initVoiceProviders({ zumi, $, voice }); // BYO provider panels, Test voice buttons, reply language (inc 3)
  const paintProviderSelect = (select, lang, saved) => {
    if (!select) return;
    const opts = providerList.filter((p) => p.langs.includes(lang));
    select.innerHTML = '';
    for (const p of opts) { const o = document.createElement('option'); o.value = p.id; o.textContent = t(`settings.provider.${p.id}`); select.appendChild(o); }
    if (lang === 'vi') { const o = document.createElement('option'); o.value = 'off'; o.textContent = t('settings.provider.off'); select.appendChild(o); }
    const known = (v) => opts.some((p) => p.id === v) || (lang === 'vi' && v === 'off');
    // The saved choice is the Kokoro pack, and with no pack Windows speaks. A select falling back to its first option named a voice that was not speaking.
    if (isPublicText() && lang === 'en' && saved && !known(saved)) { const o = document.createElement('option'); o.value = saved; o.textContent = t('settings.provider.windowsHere'); select.prepend(o); select.value = saved; return; }
    select.value = known(saved) ? saved : (opts[0] ? opts[0].id : 'off');
  };
  const renderProviders = () => {
    if (!zumi.talk.voiceProviders || !zumi.talk.getVoicePrefs) return;
    Promise.all([zumi.talk.voiceProviders().catch(() => []), zumi.talk.getVoicePrefs().catch(() => ({}))])
      .then(([list, prefs]) => { // not `vp`: that name is the provider panels below (release 0.3.0 N2)
        providerList = Array.isArray(list) ? list : [];
        voiceSaved = prefs || {};
        const g = providerList.find((p) => p.id === 'google');
        if (el.ledaChip) pill(el.ledaChip, g && g.hasKey ? 'settings.chipKeySaved' : 'settings.chipNoKey', g && g.hasKey ? 'ok' : '');
        paintProviderSelect(el.providerEn, 'en', voiceSaved.voiceProviderEn);
        paintProviderSelect(el.providerVi, 'vi', voiceSaved.voiceProviderVi);
        paintLangNote();
        vp.paint(providerList, voiceSaved);
      })
      .catch(() => { providerList = []; if (el.ledaChip) pill(el.ledaChip, 'settings.chipNoKey', ''); });
  };
  renderVoice();
  renderProviders();
  if (el.voiceEnabled && zumi.talk.getVoiceEnabled) {
    zumi.talk.getVoiceEnabled().then((on) => { el.voiceEnabled.checked = on !== false; }).catch(() => { el.voiceEnabled.checked = true; });
    el.voiceEnabled.addEventListener('change', async () => {
      if (el.sampleNote) el.sampleNote.textContent = ''; // a "turn the voice on" hint is stale once it is toggled
      try { await zumi.talk.setVoiceEnabled(el.voiceEnabled.checked); } catch { /* still applies this session via the checkbox state */ }
    });
  }
  // "Soft sound while thinking" (off by default): the think ack's chime; read by TalkDirector on each Enter.
  if (el.thinkSound && zumi.talk.getThinkSound) {
    zumi.talk.getThinkSound().then((on) => { el.thinkSound.checked = on === true; }).catch(() => { el.thinkSound.checked = false; });
    el.thinkSound.addEventListener('change', async () => {
      try { await zumi.talk.setThinkSound(el.thinkSound.checked); } catch { /* the next turn reads the stored value */ }
    });
  }
  // "Đọc to câu trả lời khi tắt mic" (T-31 settings P1, Workflow tab): on by default (typed replies are spoken, as
  // today). Persisted like the other voice switches; talk/director.js reads it per turn and gates TTS when it is off.
  if (el.typedReplySpeech && zumi.talk.getSpeakTypedWhenMicOff) {
    // R8-F1: repainted from the host when another surface saves it (the first-run card announces zumi:talk-changed), not only at boot.
    const paintTypedReplySpeech = () => zumi.talk.getSpeakTypedWhenMicOff().then((on) => { el.typedReplySpeech.checked = on !== false; }).catch(() => { el.typedReplySpeech.checked = true; });
    paintTypedReplySpeech();
    document.addEventListener('zumi:talk-changed', paintTypedReplySpeech);
    el.typedReplySpeech.addEventListener('change', async () => {
      try { await zumi.talk.setSpeakTypedWhenMicOff(el.typedReplySpeech.checked); } catch { /* still applies this session via the checkbox state */ }
    });
  }
  // T-31 talk-mode (PLAN 5.1): "how much Zumi talks" -- level, voice language and quiet hours. Wired to the IPC main
  // reads (talk:getTalkPrefs / talk:setTalkPrefs); each change saves immediately, like the other voice switches.
  let talkPrefs = null;
  const VI_COST = { off: '$0', quiet: '$0.45', normal: '$1.80', chatty: '$5.40' }; // PLAN 5.1 item 2 (estimate)
  // setTalkPrefs validates the WHOLE quiet-hours object (start !== end), so every change sends all three fields.
  const quietPatch = () => ({ on: el.talkQuiet.checked, start: el.talkQuietStart.value, end: el.talkQuietEnd.value });
  // The note under "Voice for her own lines" when Vietnamese is chosen: it speaks about the provider picked for
  // Vietnamese below (Google, Gemini, ElevenLabs, a custom server, the owner route, or Off), never a fixed "Google".
  function paintLangNote() {
    if (!el.talkLangNote || !talkPrefs) return;
    const note = (key, bad, vars) => { el.talkLangNote.textContent = key ? t(key, vars) : ''; el.talkLangNote.classList.toggle('bad', bad); };
    if (talkPrefs.talkVoiceLang !== 'vi') { note(null, false); return; }
    const id = voiceSaved.voiceProviderVi;
    const p = providerList.find((x) => x.id === id);
    const name = t(`settings.provider.${id}`);
    if (id === 'off') note('settings.talkLangViOff', true);
    else if (id === 'zumia-owner') note('settings.talkLangViOwner', false);
    else if (id === 'google') {
      const hasKey = Boolean(p && p.hasKey);
      if (hasKey) note('settings.talkLangViCost', false, { cost: VI_COST[talkPrefs.talkLevel] || VI_COST.normal });
      else note('settings.talkLangViNoKey', true);
    } else if (p && p.needsKey && !p.hasKey) note('settings.talkLangViNoKeyAny', true, { provider: name });
    else note('settings.talkLangViSentAny', false, { provider: name });
  }
  const applyTalk = (p) => {
    if (!p) return;
    talkPrefs = p;
    if (el.talkLevel) el.talkLevel.value = p.talkLevel;
    if (el.talkLang) el.talkLang.value = p.talkVoiceLang;
    if (el.talkLevelDesc) el.talkLevelDesc.textContent = t(`talk.levelD.${p.talkLevel}`);
    const q = p.talkQuietHours;
    if (el.talkQuiet) el.talkQuiet.checked = q.on;
    if (el.talkQuietStart) { el.talkQuietStart.value = q.start; el.talkQuietStart.disabled = !q.on; }
    if (el.talkQuietEnd) { el.talkQuietEnd.value = q.end; el.talkQuietEnd.disabled = !q.on; }
    paintLangNote();
  };
  const saveTalk = (patch) => zumi.talk.setTalkPrefs(patch).then((p) => { applyTalk(p); document.dispatchEvent(new CustomEvent('zumi:talk-changed')); document.dispatchEvent(new CustomEvent('zumi:voice-changed')); }).catch(() => {});
  if (zumi.talk.getTalkPrefs) {
    zumi.talk.getTalkPrefs().then(applyTalk).catch(() => {});
    if (el.talkLevel) el.talkLevel.addEventListener('change', () => { if (el.talkLevelDesc) el.talkLevelDesc.textContent = t(`talk.levelD.${el.talkLevel.value}`); paintLangNote(); saveTalk({ talkLevel: el.talkLevel.value }); });
    if (el.talkLang) el.talkLang.addEventListener('change', () => { paintLangNote(); saveTalk({ talkVoiceLang: el.talkLang.value }); });
    if (el.talkQuiet) el.talkQuiet.addEventListener('change', () => saveTalk({ talkQuietHours: quietPatch() }));
    if (el.talkQuietStart) el.talkQuietStart.addEventListener('change', () => saveTalk({ talkQuietHours: quietPatch() }));
    if (el.talkQuietEnd) el.talkQuietEnd.addEventListener('change', () => saveTalk({ talkQuietHours: quietPatch() }));
  }
  const providerChanged = (patch) => zumi.talk.setVoicePrefs(patch).then((saved) => {
    voiceSaved = saved || voiceSaved; paintLangNote(); vp.paint(providerList, voiceSaved);
    document.dispatchEvent(new CustomEvent('zumi:voice-changed')); // the stage's fixed-line audio cache belongs to the old voice
  }).catch(() => {});
  if (el.providerEn) el.providerEn.addEventListener('change', () => providerChanged({ providerEn: el.providerEn.value }));
  if (el.providerVi) el.providerVi.addEventListener('change', () => providerChanged({ providerVi: el.providerVi.value }));
  const googleGuide = $('vp-google-guide');
  if (googleGuide) googleGuide.addEventListener('click', () => { try { zumi.talk.openGuide('google'); } catch { /* no browser */ } });
  // R4 + alpha.4 (anh 30-10): the Join Discord row (Settings > App) is always shown where the host has links; until the host says the
  // link is set, its button is disabled and reads "Coming soon". The page never sees the URL: it names the id and the Tauri host opens it.
  // Electron has no zumi.links, so the row stays hidden there.
  const discordRow = $('join-discord-row');
  if (discordRow && zumi.links && typeof zumi.links.list === 'function') {
    const discordBtn = $('join-discord');
    const paintDiscord = (on) => {
      discordBtn.disabled = !on;
      const key = on ? 'settings.joinDiscord' : 'links.comingSoon';
      discordBtn.setAttribute('data-i18n', key); discordBtn.textContent = t(key);
    };
    discordRow.hidden = false;
    paintDiscord(false);
    zumi.links.list().then((set) => paintDiscord(set && set.discord === true)).catch((e) => console.error('settings: links.list failed', e));
    discordBtn.addEventListener('click', () => { zumi.links.open('discord').catch(() => {}); });
  }
  // T-31 QC-cuoi fix d: the local voice now prefetches at app start, so this row reads the prefetch STATE (main's
  // talk:voiceState), not just progress events -- events sent before this page loaded would otherwise be lost and
  // the row would sit empty mid-download. Polled only until a terminal state (ready / error / off). Settings A2: the
  // "English voice model" row shows a bar + % while downloading, a pill once ready / failed / preparing.
  let kokoroState = null;
  const showState = (s) => {
    kokoroState = s;
    const st = s && s.state;
    const visible = Boolean(st) && st !== 'off' && st !== 'idle';
    el.kokoroRow.hidden = !visible;
    if (!visible) { el.voiceKokoroProgress.textContent = ''; return; }
    const downloading = st === 'downloading' && s.total > 0;
    const percent = downloading ? Math.min(100, Math.floor((s.loaded / s.total) * 100)) : 0;
    el.kokoroBar.hidden = !downloading;
    el.kokoroBar.firstElementChild.style.width = `${percent}%`;
    el.voiceKokoroProgress.textContent = downloading ? `${percent}%` : '';
    el.kokoroChip.hidden = downloading;
    if (!downloading) pill(el.kokoroChip, st === 'ready' ? 'settings.chipReady' : st === 'error' ? 'settings.chipFailed' : 'settings.chipPreparing', st === 'ready' ? 'ok' : st === 'error' ? 'bad' : '');
    el.kokoroDesc.textContent = t(st === 'error' ? 'settings.enModelFailedD' : st === 'ready' || downloading ? 'settings.enModelD' : 'settings.enModelPreparingD');
  };
  if (el.kokoroRow && zumi.talk.voiceState) {
    let polling = null;
    const poll = () => zumi.talk.voiceState().then((s) => {
      showState(s);
      const done = !s || ['ready', 'error', 'off'].includes(s.state);
      if (done) { clearInterval(polling); polling = null; renderVoice(); } else if (!polling) polling = setInterval(poll, 1000);
    }).catch(() => {});
    poll();
    if (zumi.talk.onKokoroProgress) zumi.talk.onKokoroProgress(() => { if (!polling) poll(); });
  }
  // T-31 talk-mode (PLAN 10.3): the Google Cloud key for the VI voice. The key is typed by the user, sent to main
  // through talk:setProviderKey('google', raw) and never read back; only hasKey returns (the chip below).
  // Free check of a pasted key before saving it (Tauri). The field keeps the key so Save can follow.
  const ledaTest = $('voice-leda-test');
  if (ledaTest && zumi.talk.checkProviderKey) {
    ledaTest.hidden = false;
    ledaTest.addEventListener('click', async () => {
      el.ledaStatus.textContent = t('settings.voiceKeyChecking');
      let verdict = 'unreachable';
      try { verdict = await zumi.talk.checkProviderKey('google', el.ledaKey.value); } catch { /* reported as unreachable */ }
      el.ledaStatus.textContent = t(`settings.voiceKey.${verdict}`);
    });
  }
  if (el.ledaSave && zumi.talk.setProviderKey) {
    el.ledaSave.addEventListener('click', async () => {
      const raw = el.ledaKey.value;
      el.ledaKey.value = ''; // never let the key linger in the DOM, success or not
      let okSaved = false;
      try { okSaved = await zumi.talk.setProviderKey('google', raw); } catch { okSaved = false; }
      el.ledaStatus.textContent = okSaved ? t('settings.voiceKeySaved') : t('settings.voiceKeyBadFormat');
      el.ledaStatus.classList.toggle('bad', !okSaved);
      if (okSaved) setTimeout(ledaSettled, 1200);
    });
  }
  // After a save/clear the pill carries the lasting state, so the one-off "Key saved." / "Key cleared." line goes.
  function ledaSettled() { renderProviders(); el.ledaStatus.textContent = ''; }
  if (el.ledaClear && zumi.talk.clearProviderKey) {
    el.ledaClear.addEventListener('click', async () => {
      try { await zumi.talk.clearProviderKey('google'); } catch { /* best effort */ }
      el.ledaStatus.textContent = t('settings.voiceKeyCleared');
      el.ledaStatus.classList.remove('bad');
      setTimeout(ledaSettled, 1200);
    });
  }
  // Settings > Voice > Speed / Volume / Play sample (T-31 settings-a2). Main stores both (settings.json voiceSpeed,
  // voiceVolume) and applies the speed to Kokoro; the volume is the renderer's playback gain (voice.setVolume), so the
  // slider is heard live, even on a reply already playing. Saved on release ('change'), shown while dragging ('input').
  if (el.speed && el.volume && zumi.talk.getVoicePrefs) {
    const fill = (input) => input.style.setProperty('--fill', `${((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
    const showSpeed = () => { el.speedVal.textContent = `${Number(el.speed.value).toFixed(2).replace(/0$/, '')}×`; fill(el.speed); };
    const showVolume = () => { el.volumeVal.textContent = `${el.volume.value}%`; fill(el.volume); };
    const apply = (p) => {
      el.speed.value = String(p.speed); el.volume.value = String(Math.round(p.volume * 100));
      showSpeed(); showVolume();
      if (voice) voice.setVolume(p.volume);
    };
    zumi.talk.getVoicePrefs().then(apply).catch(() => apply({ speed: 1, volume: 1 }));
    el.speed.addEventListener('input', showSpeed);
    el.volume.addEventListener('input', () => { showVolume(); if (voice) voice.setVolume(Number(el.volume.value) / 100); });
    el.speed.addEventListener('change', () => { zumi.talk.setVoicePrefs({ speed: Number(el.speed.value) }).then(apply).catch(() => {}); });
    el.volume.addEventListener('change', () => { zumi.talk.setVoicePrefs({ volume: Number(el.volume.value) / 100 }).then(apply).catch(() => {}); });
  }
  if (el.sample && voice) {
    const SAMPLE_LINE = { 'voice-off': 'settings.sampleVoiceOff', 'no-google-key': 'settings.sampleNoKey' };
    el.sample.addEventListener('click', async () => {
      el.sample.disabled = true;
      el.sampleNote.textContent = '';
      let r;
      try { r = await voice.playSample(t('settings.sampleText')); } catch { r = { ok: false }; }
      el.sample.disabled = false;
      if (!r || !r.ok) { el.sampleNote.textContent = t(SAMPLE_LINE[r && r.reason] || 'settings.sampleFailed'); el.sampleNote.classList.toggle('bad', !SAMPLE_LINE[r && r.reason]); }
    });
  }
  let retryTimer = null;
  let retryUntil = 0;
  // "Require PIN for Board" toggle: set while the confirm/apply prompt is open, cleared once applied or cancelled.
  // null = no pending change (the checkbox just mirrors the real status()).
  let pendingPinRequired = null;

  const clearInputs = () => { for (const k of ['token', 'user', 'pass', 'pin', 'confirm']) el[k].value = ''; };
  const note = (text, bad) => { el.note.textContent = text || ''; el.note.classList.toggle('bad', Boolean(bad)); };
  // Unlock / Lock now sit in the Privacy & PIN card, so their messages show there (falls back to the one note line
  // when a page has no separate session line).
  const sessionNote = (text, bad) => { const n = el.sessionNote || el.note; n.textContent = text || ''; n.classList.toggle('bad', Boolean(bad)); };
  // Account card: on a configured install the sign-in form hides behind "Change sign-in"; before the first sign-in
  // it is simply open (nothing to change yet).
  let lastStatus = null;
  let formOpen = false;
  function paintAccount(s) {
    lastStatus = s;
    if (el.boardChip) {
      el.boardChip.hidden = false;
      if (!s.configured) pill(el.boardChip, 'settings.chipNotSet', '');
      else if (s.locked) pill(el.boardChip, 'settings.chipLocked', '');
      else if (s.authRejected) pill(el.boardChip, 'settings.chipRejected', 'bad');
      else pill(el.boardChip, s.mode === 'live' ? 'settings.chipConnected' : 'settings.chipSignedIn', 'ok');
    }
    const open = !s.configured || formOpen;
    if (el.form) el.form.hidden = !open;
    if (el.formToggle) {
      el.formToggle.hidden = !s.configured;
      el.formToggle.textContent = t(formOpen ? 'settings.cancel' : 'settings.changeSignin');
      el.formToggle.setAttribute('aria-expanded', String(open));
    }
    // "Sign out of Board" needs the bridge to carry board.signOut (both builds since T-31 OSS parity row 10), and only
    // while there is a stored sign-in to remove.
    const canSignOut = s.configured && typeof zumi.board.signOut === 'function';
    if (el.signOutRow) el.signOutRow.hidden = !canSignOut;
    if (el.signOut) el.signOut.hidden = !canSignOut;
    if (el.sessionDesc) el.sessionDesc.textContent = t(!s.configured ? 'settings.sessionNotSetD' : s.locked ? 'settings.sessionLockedD' : 'settings.sessionUnlockedD');
  }
  // "Change sign-in" from the HUD or the Board tab when the live board rejected the sign-in (T-31 0.2.11 auth-401):
  // land on Settings > Account with the sign-in form already open, not one more click away.
  document.addEventListener('zumi:board-signin', () => {
    const account = document.getElementById('stab-account');
    if (account) account.click();
    const tab = document.querySelector('.tab[data-tab="settings"]');
    if (tab) tab.click();
    formOpen = true;
    if (lastStatus) paintAccount(lastStatus);
    if (el.user && el.user.focus) el.user.focus();
  });
  if (el.formToggle) {
    el.formToggle.addEventListener('click', () => {
      formOpen = !formOpen;
      if (!formOpen) { clearInputs(); note(''); }
      if (lastStatus) paintAccount(lastStatus);
    });
  }

  // Sign out of Board: removes the stored user/pass/token (host side), then repaints signed out so the sign-in form
  // is back and the Board tab (onBoardChange) reloads without the board. A PIN-sealed install needs the CURRENT PIN
  // (typed in the unlock field, same as Unlock); an OS-sealed one shows no PIN field and sends none.
  let signOutArmed = false;
  let signOutTimer = null;
  if (el.signOut) {
    el.signOut.addEventListener('click', async () => {
      if (typeof zumi.board.signOut !== 'function') return;
      sessionNote('');
      const needsPin = !(lastStatus && lastStatus.pinRequired === false);
      const pin = el.unlockPin.value;
      if (needsPin && !pin) { sessionNote(t('settings.signOutNeedPin'), true); return; }
      // Irreversible: the first click only asks, a second click within 5 s does it.
      if (!signOutArmed) {
        signOutArmed = true;
        clearTimeout(signOutTimer);
        signOutTimer = setTimeout(() => { signOutArmed = false; }, 5000);
        sessionNote(t('settings.signOutConfirm'));
        return;
      }
      signOutArmed = false;
      clearTimeout(signOutTimer);
      el.unlockPin.value = '';
      let r;
      try { r = await zumi.board.signOut(needsPin ? pin : undefined); }
      catch { r = null; }
      if (r && r.ok) { formOpen = false; clearInputs(); note(''); await refresh(); sessionNote(t('settings.signedOut')); return; }
      if (r && (r.error === 'wrong_pin' || r.error === 'backoff')) { sessionNote(t('settings.wrongPin'), true); if (r.error === 'backoff') startBackoff(r.retryAfterMs); return; }
      if (r && r.error === 'io') { await refresh(); sessionNote(`${t('settings.signOutIo')} ${(r.leftover || []).join(', ')}`, true); return; }
      if (r && r.error === 'corrupt') { sessionNote(t('settings.signOutCorrupt'), true); return; }
      sessionNote(ERROR_KEY[r && r.error] ? t(ERROR_KEY[r.error]) : t('settings.signOutFailed'), true);
    });
  }

  function hidePinTogglePrompt() {
    pendingPinRequired = null;
    if (el.pinTogglePrompt) el.pinTogglePrompt.hidden = true;
    if (el.pinTogglePin) el.pinTogglePin.value = '';
    if (el.pinToggleConfirm) el.pinToggleConfirm.value = '';
    if (el.pinToggleNote) el.pinToggleNote.textContent = '';
  }
  // targetOn=true: owner just checked the box (wants a PIN set) -> ask for a new PIN + confirm, same shape as the
  // "Save and lock with PIN" fields above. targetOn=false: owner just unchecked it -> ask only for the CURRENT PIN
  // (the one-time unseal the relay plan calls the "fresh auth tap"), no confirm needed.
  function showPinTogglePrompt(targetOn) {
    pendingPinRequired = targetOn;
    if (el.pinToggleConfirm) el.pinToggleConfirm.hidden = !targetOn;
    if (el.pinTogglePin) { el.pinTogglePin.value = ''; el.pinTogglePin.placeholder = t(targetOn ? 'settings.pin' : 'settings.pinToggleCurrent'); }
    if (el.pinToggleConfirm) el.pinToggleConfirm.value = '';
    // The switch already shows the target, but nothing changed on disk until Apply: say so in words (0.3.2 owner report,
    // "turned PIN off but the Board still asks for it": the switch was flipped, Apply never pressed).
    if (el.pinToggleNote) { el.pinToggleNote.textContent = t(targetOn ? 'settings.pinTogglePendingOn' : 'settings.pinTogglePendingOff'); el.pinToggleNote.classList.remove('bad'); }
    if (el.pinTogglePrompt) el.pinTogglePrompt.hidden = false;
  }

  function paint(s) {
    // Which board, in plain words; configured/locked now reads from the pill next to it (paintAccount).
    el.status.textContent = !s.configured ? t('settings.boardNotSetD') : t(s.mode === 'live' ? 'board.mode.live' : 'board.mode.local');
    paintAccount(s);
    el.modeLive.checked = s.mode === 'live';
    el.modeLocal.checked = s.mode !== 'live';
    el.unlock.disabled = !s.configured || retryUntil > Date.now();
    el.lock.disabled = s.locked;
    // While a toggle confirmation is in flight, keep showing the TARGET state the owner asked for, not the still-
    // unchanged real one -- paint() runs mid-flow too (e.g. a mismatched confirm PIN calls nothing else).
    if (el.pinRequired) el.pinRequired.checked = pendingPinRequired !== null ? pendingPinRequired : s.pinRequired !== false;
    // 'os' mode (PIN requirement off) has no PIN to lock/unlock with (board-secrets.mjs's lock()/unlock() are
    // no-ops there) -- hide the now-meaningless controls entirely instead of showing disabled dead buttons.
    if (el.unlockRow) el.unlockRow.hidden = s.pinRequired === false;
    if (el.retry) el.retry.hidden = s.pinRequired === false;
  }
  // Every caller of refresh() just changed board state (save/lock/unlock/mode) or is reacting to one (window focus) —
  // the Board tab (app.js) needs the same status to decide local/live/locked, so it hooks in here rather than
  // re-polling zumi.board.status() on its own timer for every one of these cases.
  async function refresh() { const s = await zumi.board.status(); paint(s); if (onBoardChange) onBoardChange(s); return s; }

  // A correct PIN inside the backoff window is refused without being checked, so disable the input for that long.
  function startBackoff(ms) {
    clearInterval(retryTimer);
    if (!ms || ms <= 0) { retryUntil = 0; el.retry.textContent = ''; el.unlockPin.disabled = false; el.unlock.disabled = false; return; }
    retryUntil = Date.now() + ms;
    el.unlockPin.disabled = true;
    el.unlock.disabled = true;
    const tick = () => {
      const left = retryUntil - Date.now();
      if (left <= 0) { clearInterval(retryTimer); retryUntil = 0; el.retry.textContent = ''; el.unlockPin.disabled = false; el.unlock.disabled = false; return; }
      el.retry.textContent = t('settings.retryIn', { secs: Math.ceil(left / 1000) });
    };
    tick();
    retryTimer = setInterval(tick, 250);
  }

  // "Save and lock with PIN" must end LOCKED: setSecrets() itself also unlocks (the PIN re-entry is the fresh-auth
  // tap), so lock() right after seals it back up — the only way back in from here is "Unlock".
  el.save.addEventListener('click', async () => {
    note('');
    // Username trimmed (a stray space = Basic-auth 401 forever, board-secrets.mjs refuses it); the password never is.
    const p = { token: el.token.value, user: el.user.value.trim(), pass: el.pass.value, pin: el.pin.value };
    if (p.pin !== el.confirm.value) { clearInputs(); note(t('settings.pinMismatch'), true); return; }
    // Replacing a PIN-sealed sign-in needs the CURRENT PIN (typed in the unlock field, like Sign out); an OS-sealed one sends none.
    const needsPin = Boolean(lastStatus && lastStatus.configured) && lastStatus.pinRequired !== false;
    if (needsPin) {
      if (!el.unlockPin.value) { clearInputs(); note(t('settings.changeSigninNeedPin'), true); return; }
      p.currentPin = el.unlockPin.value;
      el.unlockPin.value = '';
    }
    let r;
    try { r = await zumi.board.setSecrets(p); }
    catch { r = null; }
    finally { clearInputs(); } // the credentials never linger in the DOM, even if the call rejects
    if (r && r.ok) { formOpen = false; await zumi.board.lock(); note(t('settings.savedLocked')); await refresh(); }
    else if (r && r.error === 'corrupt') note(t('settings.changeSigninCorrupt'), true);
    else if (r && r.error === 'io') note(t('settings.changeSigninIo'), true);
    else if (r && (r.error === 'wrong_pin' || r.error === 'backoff')) { note(t('settings.wrongPin'), true); if (r.error === 'backoff') startBackoff(r.retryAfterMs); else await refresh(); }
    else note(ERROR_KEY[r && r.error] ? t(ERROR_KEY[r.error]) : t('settings.saveFailed'), true);
  });

  el.unlock.addEventListener('click', async () => {
    sessionNote('');
    const pin = el.unlockPin.value;
    el.unlockPin.value = '';
    const r = await zumi.board.unlock(pin);
    // Success needs no extra line: the session row's own description now reads Unlocked / Locked (paintAccount).
    // Owner build: no mode switch, so an ok unlock goes live (else the Board tab's sign-in card loops, same as
    // board-signin.js). A non-owner build keeps whatever mode its user picked with the visible switch.
    if (r && r.ok) { startBackoff(0); sessionNote(''); if (ownerAdmin) await zumi.board.setMode('live'); await refresh(); return; }
    if (r && (r.error === 'wrong_pin' || r.error === 'backoff')) { sessionNote(t('settings.wrongPin'), true); return startBackoff(r.retryAfterMs); }
    sessionNote(ERROR_KEY[r && r.error] ? t(ERROR_KEY[r.error]) : t('settings.unlockFailed'), true);
  });

  el.lock.addEventListener('click', async () => { await zumi.board.lock(); sessionNote(''); await refresh(); });

  // "Require PIN for Board" toggle (T-31 voice-P1 follow-up, owner request 08-10). Ticking/unticking the box never
  // applies anything by itself when secrets already exist — it only opens the confirm prompt; `refresh()` on
  // cancel/failure repaints the checkbox back to the real (unchanged) state via paint()'s pendingPinRequired check.
  if (el.pinRequired) {
    el.pinRequired.addEventListener('change', async () => {
      const target = el.pinRequired.checked;
      const s = await zumi.board.status();
      if (!s.configured) { await zumi.board.setPinRequired(target); await refresh(); return; } // nothing to re-seal yet
      // The box repaints to the pending TARGET while a prompt is open, so the next click flips relative to that, not to
      // the real state. A click that lands back on the real state is "never mind": close the prompt, change nothing
      // (0.3.3 install report 10-11: a re-tick offered "choose a NEW PIN" over a store that was already PIN-ON).
      if (target === (s.pinRequired !== false)) { hidePinTogglePrompt(); await refresh(); return; }
      sessionNote(''); // a leftover "PIN requirement turned off" line must not sit under a new, different prompt
      showPinTogglePrompt(target);
      await refresh(); // repaints the box back to `s.pinRequired` underneath the now-open prompt (pendingPinRequired wins visually)
    });
  }
  // A pending (unapplied) toggle must not outlive the Settings tab: coming back would show a switch that reads OFF
  // over a store that is still PIN-sealed. app.js announces every tab change; any tab but Settings drops the pending state.
  document.addEventListener('zumi:tab', (e) => {
    if (pendingPinRequired === null || (e && e.detail === 'settings')) return;
    hidePinTogglePrompt();
    refresh();
  });
  if (el.pinToggleCancel) el.pinToggleCancel.addEventListener('click', async () => { hidePinTogglePrompt(); await refresh(); });
  if (el.pinToggleApply) {
    el.pinToggleApply.addEventListener('click', async () => {
      const toggleNote = (text, bad) => { if (el.pinToggleNote) { el.pinToggleNote.textContent = text || ''; el.pinToggleNote.classList.toggle('bad', Boolean(bad)); } };
      toggleNote('');
      if (pendingPinRequired === true) {
        const newPin = el.pinTogglePin.value;
        const confirmPin = el.pinToggleConfirm.value;
        el.pinTogglePin.value = ''; el.pinToggleConfirm.value = '';
        if (newPin !== confirmPin) { toggleNote(t('settings.pinMismatch'), true); return; } // nothing sent yet — no IPC call, no attempt counted
        const r = await zumi.board.enablePin(newPin);
        if (r && r.ok) { hidePinTogglePrompt(); sessionNote(t('settings.pinRequiredOn')); await refresh(); return; }
        toggleNote(ERROR_KEY[r && r.error] ? t(ERROR_KEY[r.error]) : t('settings.saveFailed'), true);
        await refresh();
        return;
      }
      if (pendingPinRequired === false) {
        const pin = el.pinTogglePin.value;
        el.pinTogglePin.value = '';
        const r = await zumi.board.disablePin(pin);
        if (r && r.ok) { hidePinTogglePrompt(); sessionNote(t('settings.pinRequiredOff')); await refresh(); return; }
        if (r && (r.error === 'wrong_pin' || r.error === 'backoff')) { toggleNote(t('settings.wrongPin'), true); await refresh(); return; }
        toggleNote(ERROR_KEY[r && r.error] ? t(ERROR_KEY[r.error]) : t('settings.saveFailed'), true);
        await refresh();
      }
    });
  }

  async function chooseMode(mode) {
    note('');
    const r = await zumi.board.setMode(mode);
    if (r && r.ok) return refresh();
    const s = await zumi.board.status();
    note(s.configured ? t('settings.needUnlock') : t('err.not_configured'), true);
    await refresh();
  }
  el.modeLocal.addEventListener('change', () => { if (el.modeLocal.checked) chooseMode('local'); });
  el.modeLive.addEventListener('change', () => { if (el.modeLive.checked) chooseMode('live'); });

  zumi.onWindowFocus(() => refresh()); // reflects an idle/OS lock while the tab is open

  // "Developer mode" (T-31 settings P1b, renamed from "Show developer tools"): one persisted switch that reveals the
  // three dev-only sidebar buttons and the version tag. Off by default, so a normal install shows no developer chrome
  // (see app:info.packaged); an unpackaged dev run keeps them visible (app.js devBuild), so the app's own developer
  // never has to flip the switch. The switch itself always reflects the stored value, dev run or not.
  function applyDevTools(storedOn) {
    const on = devChromeVisible({ storedOn, devRun: devBuild });
    document.dispatchEvent(new CustomEvent('zumi:dev-chrome', { detail: on })); // the reflex-timing line (talk/index.js) follows the same gate
    if (el.simBoard) el.simBoard.hidden = !on;
    if (el.camRegister) el.camRegister.hidden = !on; // T-31 camera modes: registration overlay, same gate as simBoard
    if (el.lookTuning) el.lookTuning.hidden = !on; // T-31 camera modes: look-tuning panel, same gate
    if (el.version) el.version.hidden = !on; // T-31 settings P1b: the sidebar version tag is developer chrome too
    if (el.devTools) el.devTools.checked = Boolean(storedOn);
  }
  applyDevTools(false);
  if (zumi.ui && zumi.ui.getDevTools) zumi.ui.getDevTools().then(applyDevTools).catch(() => applyDevTools(false));
  if (el.devTools) el.devTools.addEventListener('change', async () => {
    const on = el.devTools.checked;
    try { if (zumi.ui && zumi.ui.setDevTools) await zumi.ui.setDevTools(on); } catch { /* still apply this session */ }
    applyDevTools(on);
  });

  // "Send client names to the AI" (T-31 board-aware privacy, CoS 07-10): off by default, same persisted-boolean
  // shape as Developer mode above. board-reader.mjs reads the SAME settings.json key on every digest refresh — this
  // checkbox is the only thing that ever flips it.
  if (el.sendClientNames) {
    zumi.ui.getSendClientNames().then((on) => { el.sendClientNames.checked = Boolean(on); }).catch(() => {});
    el.sendClientNames.addEventListener('change', async () => {
      try { await zumi.ui.setSendClientNames(el.sendClientNames.checked); } catch { /* still applies this session via the checkbox state */ }
    });
  }

  // Settings always opens at the top: the scroll container is per-tab and would otherwise keep the last position.
  const settingsScroll = document.querySelector('.settings');
  if (settingsScroll) settingsScroll.scrollTop = 0;

  // Language change: every line this module owns repaints in place (the shell + dynamic app lines are app.js's job).
  document.addEventListener('zumi:board-changed', () => { refresh(); }); // Board-tab sign-in (app.js) changed the keystore
  onLocaleChange(() => { renderVoice(); renderProviders(); applyTalk(talkPrefs); if (el.kokoroRow && kokoroState) showState(kokoroState); refresh(); });

  return refresh();
}
