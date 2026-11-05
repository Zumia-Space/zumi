// Zumi's own lines on the stage (T-31 talk-mode, PLAN sections 2, 5.2): the renderer half of the speech scheduler.
// Main decides WHAT may be said and WHEN (speech-scheduler.mjs) and sends each line as 'speech:say'; this module shows
// it as a subtitle, speaks it through the normal voice path, and answers with sayAck. It also owns the one-click stage
// mute (button, right-click/long-press menu, Ctrl+Shift+M).
//
// No imports on purpose: everything it needs is injected, so scripts/check-say-ui.mjs drives every branch under plain
// Node with fakes (no Electron window, no audio device, no paid call).
//
// Rules this module keeps:
//   - never talks over a reply or another line: a busy voice answers sayAck 'busy' (a P1 ask is re-held by main);
//   - the subtitle appears when the line is really delivered, so a re-held ask is not shown twice;
//   - text goes to the page through textContent only;
//   - muting stops a line this module started, and never a reply (it only calls speech.stop() when it owns playback).

const SUBTITLE_MIN_MS = 4000;      // PLAN 5.2: a subtitle stays at least this long, or for the audio length
const SUBTITLE_TAIL_MS = 800;
const LONG_PRESS_MS = 500;
const CACHE_MAX_ENTRIES = 24;      // PLAN: "at most 24 entries"
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
const MUTE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_QUIET_END = '07:30';
const LEVELS = ['off', 'quiet', 'normal', 'chatty'];

/** The next local occurrence of "HH:MM" strictly after `now` (epoch ms). A bad value falls back to 07:30. */
export function nextClockTime(hhmm, now = Date.now()) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm)) || /^([01]\d|2[0-3]):([0-5]\d)$/.exec(DEFAULT_QUIET_END);
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const hhmmOf = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const bytesOf = (audios) => audios.reduce((a, b) => a + (b && b.byteLength ? b.byteLength : 0), 0);

/**
 * @param {object} o
 * @param {object} o.zumi    preload bridge: zumi.talk.{onSay, sayAck, sayEvent, sayStatus, mute, unmute, getTalkPrefs, setTalkPrefs, tts, onTtsMore}
 * @param {{speaking(): boolean, stop(): void, prepare(b: any[]): Promise<any>}} o.speech   SpeechOut
 * @param {{pick(intent: string): ({command: object}|null)}} [o.library]  SpeechLibrary
 * @param {{playCommand(cmd: object, source: string, opts: object): any}} [o.engine]
 * @param {() => boolean} [o.isBusy]   true while a reply is being thought/spoken
 * @param {(key: string, vars?: object) => string} o.t
 * @param {{showLine(text: string, ms: number): void, hideLine(): void, paintMute(state: object): void}} o.ui
 * @param {() => number} [o.now]
 * @param {(fn: Function, ms: number) => any} [o.setTimer]
 * @param {(h: any) => void} [o.clearTimer]
 */
export function createSay({ zumi, speech, library = null, engine = null, isBusy = () => false, t, ui, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const talk = zumi.talk;
  const cache = new Map(); // `${lang}|${text}` -> Uint8Array[]  (insertion order = LRU order)
  let cacheBytes = 0;
  let subtitleTimer = null;
  let current = null;      // { sayId, cancelled, started } -- the line this module is delivering right now
  let owns = false;        // true while a line THIS module started is playing (so mute never cuts a reply)
  let status = { level: 'normal', muted: false, muteUntil: null };
  let quietEnd = DEFAULT_QUIET_END;

  // ---------- subtitle ----------
  function showSubtitle(text, audioMs = 0) {
    if (!text) return;
    if (subtitleTimer) clearTimer(subtitleTimer);
    ui.showLine(String(text), Math.max(SUBTITLE_MIN_MS, audioMs + SUBTITLE_TAIL_MS));
    subtitleTimer = setTimer(() => { subtitleTimer = null; ui.hideLine(); }, Math.max(SUBTITLE_MIN_MS, audioMs + SUBTITLE_TAIL_MS));
  }

  // ---------- fixed-line audio cache ----------
  function cacheGet(key) {
    const v = cache.get(key);
    if (!v) return null;
    cache.delete(key); cache.set(key, v); // most recent last
    return v;
  }
  function cachePut(key, audios) {
    const size = bytesOf(audios);
    if (!size || size > CACHE_MAX_BYTES) return;
    if (cache.has(key)) { cacheBytes -= bytesOf(cache.get(key)); cache.delete(key); }
    cache.set(key, audios); cacheBytes += size;
    while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
      const oldest = cache.keys().next().value;
      cacheBytes -= bytesOf(cache.get(oldest)); cache.delete(oldest);
    }
  }

  // ---------- delivering one line ----------
  async function deliver(line) {
    const sayId = line.sayId;
    const ack = (spoken, reason) => { try { return Promise.resolve(talk.sayAck(sayId, spoken, reason)).catch(() => {}); } catch { return Promise.resolve(); } };
    // A subtitle-only line (muted, quiet hours, cap, or no safe spoken variant): show it and finish.
    if (!line.voice || !line.text) { showSubtitle(line.show || line.text); await ack(false, 'subtitle'); return; }
    // Never over a reply or another line. Not shown either: main re-holds a P1 ask and will emit it again.
    if (isBusy() || owns) { await ack(false, 'busy'); return; }

    const job = { sayId, cancelled: false, started: false };
    current = job;
    const key = `${line.lang || 'en'}|${line.text}`;
    let audios = cacheGet(key);
    const fromCache = Boolean(audios);
    let failure = null;
    let off = null;          // unsubscribe from the streamed sentence 2+ chunks (Kokoro)
    const more = [];         // chunks that arrive before playback starts
    const finish = () => { if (off) { try { off(); } catch { /* already gone */ } off = null; } if (current === job) current = null; };
    if (!audios) {
      try { off = talk.onTtsMore ? talk.onTtsMore(sayId, (a) => more.push(a)) : null; } catch { /* streaming is optional */ }
      try {
        const r = await talk.tts({ turnId: sayId, text: line.text, sayId });
        if (!r || !r.ok) failure = (r && r.error && r.error.code) || 'failed';
        else if (!Array.isArray(r.audios) || !r.audios.length) failure = r.reason || 'no-audio';
        else audios = r.audios;
      } catch (e) { failure = String((e && e.message) || e).slice(0, 60); }
    }

    if (job.cancelled) { finish(); await ack(false, 'muted'); return; }
    if (failure || !audios) { finish(); showSubtitle(line.show || line.text); await ack(false, failure || 'failed'); return; }
    // A reply started while this line was being synthesised: hand the slot back instead of talking over it.
    if (isBusy() || owns) { finish(); await ack(false, 'busy'); return; }

    let prepared;
    try { prepared = await speech.prepare(audios); } catch { finish(); showSubtitle(line.show || line.text); await ack(false, 'decode_failed'); return; }
    if (job.cancelled) { finish(); await ack(false, 'muted'); return; }
    job.started = true; owns = true;
    const heard = audios.slice(); // everything this line plays (first chunk + streamed ones), cached only when it ends whole
    const take = (a) => { heard.push(a); try { speech.append(a); } catch { /* best effort */ } };
    const h = prepared.start();
    showSubtitle(line.show || line.text, prepared.durationMs || 0);
    for (const a of more.splice(0)) take(a);
    if (off) { off(); off = talk.onTtsMore ? talk.onTtsMore(sayId, take) : null; }
    playMood(line.mood);
    await ack(true, 'spoken');
    let how = 'ended';
    if (h && h.ended) { try { how = await h.ended; } catch { how = 'stopped'; } }
    owns = false; finish();
    if (!fromCache && how === 'ended') cachePut(key, heard); // a line cut short by mute would be cached truncated
  }

  function playMood(mood) {
    if (!mood || !library || !engine) return;
    try {
      const v = library.pick(mood);
      if (v && v.command) engine.playCommand(v.command, 'speech', { labelVi: t(`intent.${mood}`) });
    } catch { /* a gesture is garnish; the line was already delivered */ }
  }

  function onSay(line) {
    if (!line || typeof line.sayId !== 'string') return Promise.resolve();
    return deliver(line).catch(() => {});
  }

  // ---------- mute ----------
  /** Stop the line this module is delivering, if any. Never touches a reply (PLAN 5.2). */
  function stopOwn() {
    if (current) current.cancelled = true;
    if (owns) { try { speech.stop(); } catch { /* nothing playing */ } owns = false; }
    if (subtitleTimer) { clearTimer(subtitleTimer); subtitleTimer = null; ui.hideLine(); }
  }

  async function refresh() {
    try {
      const [st, tp] = await Promise.all([Promise.resolve(talk.sayStatus()).catch(() => null), talk.getTalkPrefs ? Promise.resolve(talk.getTalkPrefs()).catch(() => null) : null]);
      if (st) status = { level: st.level, muted: st.muted === true, muteUntil: st.muteUntil == null ? null : st.muteUntil };
      if (tp && tp.talkQuietHours && tp.talkQuietHours.end) quietEnd = tp.talkQuietHours.end;
    } catch { /* keep the last state */ }
    paint();
    return status;
  }

  function paint() {
    const off = status.level === 'off';
    const title = status.muted
      ? (status.muteUntil ? t('stage.mute.mutedUntil', { time: hhmmOf(status.muteUntil) }) : t('stage.mute.muted'))
      : off ? t('stage.mute.levelOff') : t('stage.mute.title');
    ui.paintMute({ muted: status.muted, off, title, level: status.level });
  }

  /** Click on the speaker button: level Off -> the menu (nothing to mute); otherwise mute <-> unmute. */
  async function toggleMute() {
    if (!status.level || status.level === 'off') { ui.openMenu(); return status; }
    if (status.muted) await talk.unmute(); else { stopOwn(); await talk.mute(null); }
    return refresh();
  }
  async function muteFor(ms) { stopOwn(); await talk.mute(now() + ms); return refresh(); }
  async function muteForHour() { return muteFor(MUTE_HOUR_MS); }
  async function muteUntilTomorrow() { stopOwn(); await talk.mute(nextClockTime(quietEnd, now())); return refresh(); }
  async function setLevel(level) { if (LEVELS.includes(level)) await talk.setTalkPrefs({ talkLevel: level }); return refresh(); }

  /** Ctrl+Shift+M (window-scoped). Modifiers are required, so a plain "m" typed in a field never gets here. */
  function onKeydown(e) {
    if (!e || e.repeat) return false;
    if (e.code !== 'KeyM' || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return false;
    if (e.preventDefault) e.preventDefault();
    toggleMute();
    return true;
  }

  function clearCache() { cache.clear(); cacheBytes = 0; }
  function event(name) { try { return Promise.resolve(talk.sayEvent(name)).catch(() => false); } catch { return Promise.resolve(false); } }

  return {
    onSay, toggleMute, muteForHour, muteUntilTomorrow, setLevel, onKeydown, refresh, stopOwn, clearCache, event,
    getStatus: () => ({ ...status }),
    _test: { cache: () => cache, owns: () => owns, current: () => current, LEVELS },
  };
}

/**
 * Bind the say module to the page: the subtitle line, the mute button, its menu and Ctrl+Shift+M.
 * `$` is the page's getElementById wrapper. Missing elements are skipped (a build without the stage UI stays quiet).
 * @returns {ReturnType<typeof createSay>}
 */
export function initSay({ zumi, $, speech, library, engine, isBusy, t, doc = document, win = window }) {
  const lineEl = $('say-line');
  const btn = $('talk-mute');
  const menu = $('talk-mute-menu');
  let say = null;

  const ui = {
    showLine(text) { if (lineEl) { lineEl.textContent = text; lineEl.hidden = false; } },
    hideLine() { if (lineEl) { lineEl.textContent = ''; lineEl.hidden = true; } },
    paintMute({ muted, off, title, level }) {
      if (!btn) return;
      btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      btn.classList.toggle('muted', muted);
      btn.classList.toggle('off', off);
      btn.title = title;
      btn.setAttribute('aria-label', title);
      if (menu) for (const item of menu.querySelectorAll('[data-level]')) item.setAttribute('aria-checked', item.dataset.level === level ? 'true' : 'false');
    },
    openMenu() { if (menu) { menu.hidden = false; const first = menu.querySelector('[role^="menuitem"]'); if (first && first.focus) first.focus(); } },
    closeMenu() { if (menu) menu.hidden = true; },
  };
  say = createSay({ zumi, speech, library, engine, isBusy, t, ui });

  if (zumi.talk.onSay) {
    zumi.talk.onSay((line) => say.onSay(line));
    if (zumi.talk.sayReady) zumi.talk.sayReady(); // main starts the scheduler clock only once someone listens
  }
  if (btn) {
    let pressTimer = null;
    let longFired = false;
    btn.addEventListener('pointerdown', (e) => { if (e.button && e.button !== 0) return; longFired = false; pressTimer = setTimeout(() => { longFired = true; ui.openMenu(); }, LONG_PRESS_MS); });
    const endPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    btn.addEventListener('pointerup', endPress);
    btn.addEventListener('pointerleave', endPress);
    btn.addEventListener('click', () => { if (longFired) { longFired = false; return; } say.toggleMute(); });
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); ui.openMenu(); });
  }
  if (menu) {
    menu.addEventListener('click', (e) => {
      const item = e.target && e.target.closest ? e.target.closest('[data-action],[data-level]') : null;
      if (!item) return;
      ui.closeMenu();
      if (item.dataset.action === 'hour') say.muteForHour();
      else if (item.dataset.action === 'tomorrow') say.muteUntilTomorrow();
      else if (item.dataset.level) say.setLevel(item.dataset.level);
    });
    doc.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !(btn && btn.contains(e.target))) ui.closeMenu(); });
  }
  win.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu && !menu.hidden) { ui.closeMenu(); if (btn) btn.focus(); return; }
    say.onKeydown(e);
  });
  // A voice setting changed in Settings (provider, key, config, language): fixed-line audio from the old voice is stale.
  doc.addEventListener('zumi:voice-changed', () => say.clearCache());
  // A talk setting changed in Settings (level / quiet hours): repaint the button.
  doc.addEventListener('zumi:talk-changed', () => say.refresh());
  say.refresh();
  win.setInterval(() => say.refresh(), 30_000); // a timed mute expires on its own
  return say;
}
