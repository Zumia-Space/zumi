// Room live B (ADR docs/decisions/2026-11-13-room-live-b.md D2 D5): the host half of the live 3D room, in the main webview where the
// talk path already is. It turns the audio SpeechOut plays into a viseme track (30 Hz, 5 channels, integers) and sends the room's
// performance through `window.zumi.stage.produce` as numbers and enums. The reply TEXT and the AUDIO never leave this webview; the
// guest webview gets a mouth, a face and a gaze. With no 3D room open (`status` says not active) nothing is sent and the video-room
// path is untouched.
//
//   const producer = createStageProducer({ call: (op, payload) => window.zumi.stage.produce(op, payload) });
//   await producer.refresh();                         // is a 3D room open?      -> producer.active
//   producer.setEmotion(1 /* joy */, 80);             // the held emotion rides on each chunk
//   producer.speak([audioBuffer, ...], startAtEpochMs) // one schedule per <= 6 s chunk, consecutive
//   producer.cancel();                                // barge-in: utterance.cancel for every id still outstanding
//   producer.state('thinking'); producer.gaze('anchor', 1);

export const LEAD_MS = 150; // the contract's minimum lead between sending and the start time (ADR D5)
// What the voice is delayed by while the room is on: the host's 150 ms minimum (measured from receipt) plus 25 ms for the rpc itself. The viseme
// analysis is NOT in this budget: it runs in analyse(), before any start time exists (a 200 ms lead lost schedules in the real app when the
// analysis ran after the start was fixed, a cold first call being the worst).
export const START_LEAD_MS = 175;
export const MAX_CHUNK_MS = 6000; // a longer chunk is split into consecutive schedules (ADR D5)
const FRAME_HZ = 30;
const STATE = { idle: 0, listening: 1, thinking: 2, speaking: 3 };
const GAZE = { user: 0, away: 1, window: 2, anchor: 3 };

// ---- the viseme track -------------------------------------------------------------------------------------------------------------
// Energy/band driven, the same analysis SpeechOut.mouth() runs live on the analyser (talk/speech.js), run offline over the decoded
// samples so the host can send it ahead of the audio. Not phoneme-accurate. Channel order is the contract's: aa ih ou ee oh.
const FFT_SIZE = 1024;
const BLACKMAN = Float32Array.from({ length: FFT_SIZE }, (_, i) => 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE) + 0.08 * Math.cos((4 * Math.PI * i) / FFT_SIZE));

function fft(re, im) { // in-place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** @param {{ sampleRate: number, duration: number, getChannelData: (c: number) => Float32Array }} audio -> { durationMs, vis: number[] } */
export function buildVisTrack(audio) {
  const data = audio.getChannelData(0), sr = audio.sampleRate;
  const durationMs = Math.round(audio.duration * 1000);
  const frames = Math.ceil((durationMs * FRAME_HZ) / 1000);
  const vis = new Array(5 * frames).fill(0);
  const hz = sr / FFT_SIZE;
  const re = new Float32Array(FFT_SIZE), im = new Float32Array(FFT_SIZE);
  const band = (bytes, a, b) => { let s = 0, c = 0; for (let i = Math.floor(a / hz); i <= Math.min(FFT_SIZE / 2 - 1, Math.ceil(b / hz)); i++) { s += bytes[i]; c++; } return c ? s / c / 255 : 0; };
  for (let f = 0; f < frames; f++) {
    const centre = Math.round(((f + 0.5) / FRAME_HZ) * sr);
    const from = centre - FFT_SIZE / 2;
    let sum = 0;
    for (let i = 0; i < FFT_SIZE; i++) { const v = data[from + i] || 0; sum += v * v; re[i] = v * BLACKMAN[i]; im[i] = 0; }
    const level = Math.min(1, Math.sqrt(sum / FFT_SIZE) * 4.5);
    if (level < 0.04) continue; // below the voice gate: closed
    fft(re, im);
    const bytes = new Float32Array(FFT_SIZE / 2);
    for (let i = 0; i < bytes.length; i++) {
      const mag = Math.hypot(re[i], im[i]) / FFT_SIZE; // AnalyserNode scaling: dB over -100..-30 mapped to 0..255
      bytes[i] = Math.min(255, Math.max(0, ((20 * Math.log10(mag + 1e-12) + 100) / 70) * 255));
    }
    const low = band(bytes, 150, 700), mid = band(bytes, 700, 1800), high = band(bytes, 1800, 4500);
    const tot = low + mid + high + 1e-6;
    const w = { aa: level * (mid / tot) * 1.6, ih: level * (high / tot) * 0.6, ou: level * (low / tot) * 0.5, ee: level * (high / tot) * 0.9, oh: level * (low / tot) * 0.9 };
    ['aa', 'ih', 'ou', 'ee', 'oh'].forEach((m, k) => { vis[f * 5 + k] = Math.round(Math.min(1, w[m]) * 100); });
  }
  return { durationMs, vis };
}

// ---- the producer -----------------------------------------------------------------------------------------------------------------
export function createStageProducer({ call, now = () => Date.now() }) {
  const stats = { sent: 0, refused: 0, lastError: null, analysed: 0 };
  const tracks = new WeakMap(); // decoded buffer -> [{ durationMs, vis }] per <= 6 s part
  let nextId = 1;
  let outstanding = []; // { id, endsAt } of the schedules not known to be over
  let emotion = { enum: 0, intensity: 50 };
  const self = {
    active: false,
    testHook: false, // true only when the host was started with --stage-test-hook (the answer of `status` says so)
    leadMs: START_LEAD_MS,
    stats,
    /** Asks the host whether a 3D room is open right now. */
    async refresh() {
      try { const r = await call('status', {}); self.active = Boolean(r.active); self.testHook = r.testHook === true; } catch (e) { self.active = false; stats.lastError = String((e && e.message) || e); }
      return self.active;
    },
    setEmotion(enumValue, intensity = 80) { emotion = { enum: enumValue, intensity }; },
    /** Builds (once) the viseme tracks of decoded buffers. Call it before the audio start time is chosen. */
    analyse(buffers) {
      for (const audio of buffers) {
        if (tracks.has(audio)) continue;
        tracks.set(audio, splitAudio(audio).map((part) => buildVisTrack(part)));
        stats.analysed++;
      }
    },
    async send(op, payload) {
      try {
        const r = await call(op, payload);
        stats.sent++;
        if (r && r.active === false) self.active = false; // the room fell back while we talked
        return true;
      } catch (e) { stats.refused++; stats.lastError = String((e && e.message) || e); return false; }
    },
    /** One schedule per <= 6000 ms of audio, consecutive from `startAtEpochMs`. `buffers` are decoded AudioBuffers (audio stays here). */
    async speak(buffers, startAtEpochMs) {
      if (!self.active) return [];
      const ids = [];
      let at = Math.round(startAtEpochMs); // the audio clock is fractional; the contract and the host parser take integers
      for (const audio of buffers) {
        self.analyse([audio]); // a no-op when prepare()/append() already did
        for (const { durationMs, vis } of tracks.get(audio)) {
          if (durationMs < 100) { at += durationMs; continue; }
          const id = nextId++;
          outstanding.push({ id, endsAt: at + durationMs });
          ids.push(id);
          await self.send('schedule', { id, startAtEpochMs: at, durationMs, emotion: emotion.enum, intensity: emotion.intensity, vis });
          at += durationMs;
        }
      }
      return ids;
    },
    /** Barge-in or a stop: utterance.cancel for every schedule that has not ended yet. */
    async cancel() {
      if (!self.active) { outstanding = []; return; }
      const t = now();
      const ids = outstanding.filter((o) => o.endsAt > t).map((o) => o.id);
      outstanding = [];
      for (const id of ids) await self.send('cancel', { id, atEpochMs: t });
    },
    async state(name) { if (self.active && name in STATE) await self.send('state', { s: STATE[name] }); },
    async gaze(target, anchorIx = 0) { if (self.active && target in GAZE) await self.send('gaze', { target: GAZE[target], anchorIx: target === 'anchor' ? anchorIx : 0 }); },
    /** T-31-ROOM motion P4 (contract v2): one seated-motion program { id, prog } (talk/motion-route.js); false when no 3D room is open. */
    async motion(payload) { await self.refresh(); return self.active ? self.send('motion', payload) : false; },
  };
  return self;
}

function splitAudio(audio) {
  const total = Math.round(audio.duration * 1000);
  if (total <= MAX_CHUNK_MS) return [audio];
  const data = audio.getChannelData(0), per = Math.round((MAX_CHUNK_MS / 1000) * audio.sampleRate), out = [];
  for (let i = 0; i < data.length; i += per) {
    const slice = data.subarray(i, i + per);
    out.push({ sampleRate: audio.sampleRate, duration: slice.length / audio.sampleRate, getChannelData: () => slice });
  }
  return out;
}
