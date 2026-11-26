// T-31-MAUS R4b "voice in": the chat box's side. A mic button beside the message box, and the recorder the host asks for.
//
// The host owns the flow (stt.ptt, the hotkey, the 60 s cap, the engine, the settings); this page owns only the microphone, because
// the webview is the one process that may open it:
//   host `start`  -> record; `stop` -> finish, make a 16 kHz mono WAV (silence trimmed at both ends, as upstream) and hand it to
//   `stt.audio`; `cancel` -> throw it away; `text` -> put the words in the chat box after what was there; `notice` -> say why not.
// The button and the hotkey are the same flow: the button only sends press / release to the host. Everything shown is what the host
// sent, set with textContent only. Built here, not in index.html, like agent-chat.js, so a host without the stt API shows no control
// that does nothing.
import { t as i18nT, apply as i18nApply } from './i18n.js';

const REQUIRED = ['state', 'ptt', 'audio', 'onEvent'];
/** True where the host has the voice API (the Tauri host; the Electron preload has none). */
export const voiceAvailable = (zumi) => Boolean(zumi && zumi.stt && REQUIRED.every((k) => typeof zumi.stt[k] === 'function'));

/** Upstream appends dictated words to the draft, one space between. */
export function mergeText(base, heard) {
  const b = String(base == null ? '' : base);
  const h = String(heard == null ? '' : heard);
  if (!b) return h;
  return b + (/\s$/.test(b) ? '' : ' ') + h;
}

const RATE = 16000;
const FRAME_MS = 20;
const VOICED_RMS = 0.01; // about -40 dBFS
const PAD_MS = 150;
const MIN_SPEECH_MS = 150;

function mono16k(chunks, rate) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const all = new Float32Array(n);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  if (!rate || rate === RATE) return all;
  const out = new Float32Array(Math.floor((all.length * RATE) / rate));
  const step = rate / RATE;
  for (let i = 0; i < out.length; i++) {
    // area average over the source samples this output sample covers (a box filter: enough for speech)
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.min(all.length, Math.floor((i + 1) * step)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += all[j];
    out[i] = sum / (to - from);
  }
  return out;
}

function encodeWav(samples) {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (at, s) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return out;
}

/** The recording as a 16 kHz mono 16-bit WAV with the silence around the speech cut (150 ms kept), or null when nothing was said
 *  (no voiced stretch, or less than 150 ms of it). `chunks`: Float32Arrays at `rate` Hz. */
export function floatsToWav(chunks, rate) {
  const pcm = mono16k(chunks || [], rate);
  const frame = Math.round((RATE * FRAME_MS) / 1000);
  let first = -1;
  let last = -1;
  for (let f = 0; f * frame < pcm.length; f++) {
    let sum = 0;
    const end = Math.min(pcm.length, (f + 1) * frame);
    for (let i = f * frame; i < end; i++) sum += pcm[i] * pcm[i];
    if (Math.sqrt(sum / (end - f * frame)) >= VOICED_RMS) { if (first < 0) first = f; last = f; }
  }
  if (first < 0 || ((last - first + 1) * FRAME_MS) < MIN_SPEECH_MS) return null;
  const pad = Math.round((RATE * PAD_MS) / 1000);
  const from = Math.max(0, first * frame - pad);
  const to = Math.min(pcm.length, (last + 1) * frame + pad);
  return encodeWav(pcm.subarray(from, to));
}

/** A short silent WAV: what the host gets when nothing was said (it makes no request and types nothing for it). */
export const silentWav = () => encodeWav(new Float32Array(Math.round(RATE * 0.2)));

/** Base64 of bytes, in pieces (one String.fromCharCode over a megabyte overflows the call stack). */
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const KNOWN_CODES = new Set(['stt_not_configured', 'stt_key_missing', 'stt_key_rejected', 'stt_balance', 'stt_rate_limited', 'stt_network', 'stt_timeout', 'stt_audio_missing', 'stt_local_missing', 'stt_local_failed',
  'stt_local_timeout', 'stt_hotkey_taken', 'stt_policy_exe', 'stt_policy_key', 'stt_policy_origin', 'stt_policy_model', 'stt_settings_bad', 'stt_not_owner', 'stt_audio_bad', 'stt_audio_too_large',
  'stt_audio_too_long', 'stt_audio_refused', 'stt_bad_reply', 'stt_failed', 'stt_unavailable', 'stt_not_waiting', 'stt_save_failed', 'stt_bad_args', 'egress_scheme', 'egress_private', 'egress_userinfo',
  'egress_bad_url', 'stt_hotkey_failed', 'stt_hotkey_unsupported', 'stt_local_runtime_missing', 'stt_install_network', 'stt_install_http', 'stt_install_redirect', 'stt_install_hash', 'stt_install_size',
  'stt_install_write', 'stt_install_unpack', 'stt_install_busy', 'stt_install_unpublished', 'stt_cancelled', 'dictation_cancelled']);

/** Words for a code word from the host. An unknown code is shown after a generic line. */
export function noticeText(code, t = i18nT) {
  const c = String(code || '');
  return KNOWN_CODES.has(c) ? t(`voice.err.${c}`) : `${t('voice.err.other')} (${c.slice(0, 80)})`;
}

/** The microphone, for real: getUserMedia and a ScriptProcessor that keeps the samples. The host's 60 s cap bounds the hold; this keeps at
 *  most 5 minutes in memory whatever happens. */
export function systemRecorder(win = globalThis) {
  let ctx = null;
  let stream = null;
  let node = null;
  let chunks = [];
  let kept = 0;
  const release = () => {
    try { if (node) { node.onaudioprocess = null; node.disconnect(); } } catch { /* already gone */ }
    try { if (stream) stream.getTracks().forEach((tr) => tr.stop()); } catch { /* already stopped */ }
    try { if (ctx) ctx.close(); } catch { /* already closed */ }
    node = null; stream = null; ctx = null;
  };
  return {
    async start() {
      const Ctx = win.AudioContext || win.webkitAudioContext;
      if (!Ctx || !win.navigator || !win.navigator.mediaDevices) throw new Error('no_microphone_api');
      stream = await win.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        if (kept > ctx.sampleRate * 300) return;
        const c = new Float32Array(e.inputBuffer.getChannelData(0));
        kept += c.length;
        chunks.push(c);
      };
      source.connect(node);
      node.connect(ctx.destination);
    },
    async stop() {
      const rate = ctx ? ctx.sampleRate : RATE;
      const got = chunks;
      chunks = []; kept = 0;
      release();
      return { chunks: got, rate };
    },
    cancel() { chunks = []; kept = 0; release(); },
  };
}

/** Builds the mic button and the status line, and keeps them current. Returns the controller or null without the API. */
export function initVoiceIn(zumi, $, { doc = typeof document === 'undefined' ? null : document, t = i18nT, apply = i18nApply, makeRecorder = () => systemRecorder() } = {}) {
  if (!doc || !voiceAvailable(zumi) || $('voice-mic')) return null;
  const composer = doc.querySelector('footer.composer');
  const msg = $('msg');
  if (!composer || !msg) return null;
  const node = (tag, cls, text, id) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (id) e.id = id; return e; };

  const mic = node('button', 'ghost slim voice-mic', t('voice.mic'), 'voice-mic');
  mic.type = 'button';
  mic.dataset.i18n = 'voice.mic';
  mic.title = t('voice.micHint');
  mic.setAttribute('aria-pressed', 'false');
  const status = node('span', 'voice-status', '', 'stt-status');
  status.hidden = true;
  status.setAttribute('aria-live', 'polite');
  composer.appendChild(mic);
  composer.appendChild(status);
  apply(mic);

  let recorder = null; // the recording of this page, while the host has asked for one
  let pressed = false; // what the button last told the host
  let hearing = false; // released, and the host is still working out the words
  let base = null; // what was in the box when the host said start
  let hideTimer = null;

  const say = (text) => {
    status.textContent = text || '';
    status.hidden = !text;
    clearTimeout(hideTimer);
    if (text) { hideTimer = setTimeout(() => say(''), 8000); if (hideTimer && hideTimer.unref) hideTimer.unref(); }
  };
  const paint = () => {
    const on = Boolean(recorder);
    mic.setAttribute('aria-pressed', String(on));
    mic.classList.toggle('on', on);
    if (on) say(t('voice.listening'));
  };
  const toHost = async (phase) => {
    let r = null;
    try { r = await zumi.stt.ptt(phase); } catch { r = null; }
    return r;
  };
  async function sendAudio(wavBytes) {
    try { await zumi.stt.audio(toBase64(wavBytes)); } catch { /* the host's wait ends with its own notice */ }
  }

  async function onStart() {
    if (recorder) return;
    base = msg.value;
    const rec = makeRecorder();
    recorder = rec;
    paint();
    try {
      await rec.start();
    } catch {
      if (recorder === rec) recorder = null;
      pressed = false;
      paint();
      say(t('voice.err.mic'));
      await toHost('dismiss');
    }
  }
  async function onStop() {
    const rec = recorder;
    recorder = null;
    pressed = false;
    hearing = true;
    paint();
    say('');
    let wav = null;
    if (rec) {
      try { const got = await rec.stop(); wav = floatsToWav(got.chunks, got.rate); } catch { wav = null; }
    }
    // Nothing said (or nothing recorded here): the host still gets an answer, so it never waits for one.
    await sendAudio(wav || silentWav());
  }
  function onCancel() {
    if (recorder) { try { recorder.cancel(); } catch { /* gone */ } }
    recorder = null; pressed = false; hearing = false; base = null;
    paint();
    say('');
  }
  function onText(text) {
    if (typeof text !== 'string' || !text.trim()) return;
    const start = base == null ? msg.value : base;
    base = null;
    hearing = false;
    // The person typed while it listened: upstream drops the words rather than overwrite them.
    if (msg.value !== start) return;
    msg.value = mergeText(start, text.trim());
    const E = doc.defaultView && doc.defaultView.Event;
    if (E) msg.dispatchEvent(new E('input', { bubbles: true }));
    msg.focus();
    say('');
  }

  const off = zumi.stt.onEvent((ev) => {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.ev) {
      case 'start': onStart(); break;
      case 'stop': onStop(); break;
      case 'cancel': onCancel(); break;
      case 'text': onText(ev.text); break;
      case 'notice': pressed = false; hearing = false; if (recorder) onCancel(); say(noticeText(ev.code, t)); break;
      default: break;
    }
  });

  // While the words are being worked out a click or Esc cancels them (a second press would be ignored by the host); the host says so
  // with a `dictation_cancelled` notice instead of dropping them silently.
  const cancelHearing = async () => {
    hearing = false;
    await toHost('dismiss');
  };
  msg.addEventListener('keydown', (e) => {
    if (e && e.key === 'Escape' && (hearing || recorder)) cancelHearing();
  });
  mic.addEventListener('click', async () => {
    if (hearing && !recorder) { await cancelHearing(); return; }
    pressed = !pressed;
    const r = await toHost(pressed ? 'press' : 'release');
    if (!r || !r.ok) { pressed = false; say(noticeText(r && r.error ? r.error : 'other', t)); }
  });

  return {
    destroy() { off && off(); if (recorder) onCancel(); mic.remove(); status.remove(); },
    recording: () => Boolean(recorder),
  };
}
