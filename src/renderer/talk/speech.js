// Zumi's voice in the renderer: plays the audio chunks main fetched for a turn (bytes over IPC; the renderer itself never
// touches the network) and turns the sound into mouth shapes for the engine's MOUTH expression group.
// Lip-sync is energy/band driven (same idea as the web app's visemeAnalyser.ts), not phoneme-accurate.
const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'];

// Frame-rate-independent mouth smoothing (T-31 0.2.3 B2 item 2). A fixed per-frame lerp factor converges faster
// at higher fps (0.5 per frame is ~4.8x faster at 144 than at 30), so the mouth shape depended on the frame
// rate. This is a one-pole low-pass with a time constant instead: value += (goal - value) * (1 - e^{-dt/tau}),
// whose response over wall-clock time is the same at any frame rate. tau is asymmetric -- the mouth OPENS fast
// on a syllable and CLOSES slowly -- which is the Live2D-research "open fast, close slow" idea. goal and value
// are both 0..1.
export const MOUTH_OPEN_TAU_MS = 30;
export const MOUTH_CLOSE_TAU_MS = 110;
export function mouthStep(value, goal, dtMs) {
  const tau = goal > value ? MOUTH_OPEN_TAU_MS : MOUTH_CLOSE_TAU_MS;
  return value + (goal - value) * (1 - Math.exp(-dtMs / tau));
}

// Builds a tiny near-silent PCM16 WAV (mono, 24kHz to match Kokoro's own output) purely to warm up
// decodeAudioData + the analyser/BufferSource graph in warmup() below -- never played audibly for real.
// Sample value 1 (not literally 0) so nothing in the pipeline can special-case/skip an all-zero buffer.
function silentWav(ms, sampleRate = 24000) {
  const n = Math.round((ms / 1000) * sampleRate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, 1, true);
  return buf;
}

export class SpeechOut {
  constructor() {
    this.ctx = null;
    this.current = null; // { sources, analyser, startAt, endAt, done }
    this.mouthState = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this.lastMouthAt = null; // wall-clock ms of the last mouth() call, for the frame-rate-independent dt
    this.volume = 1; // Settings > Voice > Volume (0-1), applied after the analyser so the mouth still reads the voice
  }

  setVolume(v) {
    this.volume = typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    if (this.current) this.current.gain.gain.value = this.volume; // a reply already playing follows the slider
    return this.volume;
  }

  audio() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // T-31 voice P1 live-E2E fix 1 + fix 2: warms the WHOLE pipeline (AudioContext resume, decodeAudioData, an
  // AnalyserNode, a BufferSource) ahead of the first real reply, by actually decoding and playing a tiny silent
  // clip through prepare()/start()/mouth() -- not just resuming the context. Measured need: resuming the context
  // alone still left turn 1's mouth/audio onset lagging ~150ms behind every later turn (headless Chromium,
  // check-mouth-sync.mjs) -- decodeAudioData + the analyser/BufferSource graph have their own first-call cost in
  // this engine that ctx.resume() never touches. Safe to call more than once; best-effort (a real turn's own
  // prepare()/play() works the normal way regardless of whether this ran).
  async warmup() {
    try {
      await this.audio().resume();
      const prepared = await this.prepare([silentWav(30)]);
      prepared.start();
      this.mouth();
      await new Promise((r) => setTimeout(r, 60));
      this.stop();
    } catch { /* best-effort; a real turn still plays normally either way */ }
  }

  // buffers: ArrayBuffer | Uint8Array chunks of one reply, played back to back.
  // -> { durationMs, start(): { startedAt (performance.now ms), ended: Promise<'ended'|'stopped'> } }
  async prepare(buffers) {
    const ctx = this.audio();
    const decoded = [];
    for (const b of buffers) {
      const ab = b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      decoded.push(await ctx.decodeAudioData(ab));
    }
    const durationMs = decoded.reduce((a, d) => a + d.duration * 1000, 0);
    return {
      durationMs,
      start: () => this.play(decoded, durationMs),
    };
  }

  play(decoded, durationMs) {
    this.stop();
    const ctx = this.audio();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    analyser.connect(gain);
    gain.connect(ctx.destination);
    let t = ctx.currentTime + 0.03;
    const t0 = t;
    const sources = decoded.map((d) => { const s = ctx.createBufferSource(); s.buffer = d; s.connect(analyser); s.start(t); t += d.duration; return s; });
    let resolveEnd;
    const ended = new Promise((r) => { resolveEnd = r; });
    const startedAt = performance.now() + (t0 - ctx.currentTime) * 1000;
    // nextCtxTime: the AudioContext-clock moment the schedule currently ends at -- append() below schedules the
    // next streamed chunk right there, so a late-arriving sentence (T-31 voice P1 item 2) never leaves a gap.
    const cur = { sources, analyser, gain, startedAt, endsAt: startedAt + durationMs, nextCtxTime: t, resolveEnd, bins: new Uint8Array(analyser.frequencyBinCount), wave: new Uint8Array(analyser.fftSize) };
    sources[sources.length - 1].onended = () => { if (this.current === cur) this.finish('ended'); };
    this.current = cur;
    return { startedAt, endsAt: cur.endsAt, ended };
  }

  // Streamed sentence N+1 arriving while sentence N (or earlier) is already playing: schedule it right after
  // whatever is currently queued, with no change to mouth()/stop() -- they only ever look at `this.current`.
  // No-op (returns false) if nothing is playing: the caller (director.js) only appends for the turn it itself
  // started, and ignores a stale append after stop()/a new turn replaced `this.current`.
  async append(buffer) {
    const cur = this.current;
    if (!cur) return false;
    const ctx = this.ctx;
    const ab = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const decoded = await ctx.decodeAudioData(ab);
    if (this.current !== cur) return false; // stopped / superseded while we were decoding
    const startAt = Math.max(cur.nextCtxTime, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(cur.analyser);
    src.start(startAt);
    cur.sources[cur.sources.length - 1].onended = null; // only the new last source ends the turn now
    cur.sources.push(src);
    cur.nextCtxTime = startAt + decoded.duration;
    // Wall-clock moment this new chunk ends: now + (ctx-seconds from "now" until it ends).
    cur.endsAt = performance.now() + (cur.nextCtxTime - ctx.currentTime) * 1000;
    src.onended = () => { if (this.current === cur) this.finish('ended'); };
    return true;
  }

  // T-31 voice round 6 never-dead ack (director.js THINK_AFTER_MS): a short, soft two-note chime made right here
  // (no file, no network, no TTS worker time), straight to the speakers -- NOT through a turn's analyser, so the
  // mouth stays still and stop()/barge-in never has to know about it. ~0.4 s, quiet (peak gain 0.06). -> played?
  chime() {
    try {
      const ctx = this.audio();
      const t0 = ctx.currentTime + 0.01;
      const out = ctx.createGain();
      out.gain.value = 0.06;
      out.connect(ctx.destination);
      for (const [hz, at] of [[660, 0], [880, 0.12]]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = hz;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(1, t0 + at + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.28);
        o.connect(g); g.connect(out);
        o.start(t0 + at); o.stop(t0 + at + 0.3);
      }
      setTimeout(() => { try { out.disconnect(); } catch { /* already */ } }, 700);
      return true;
    } catch { return false; }
  }

  speaking() { return Boolean(this.current); }
  remainingMs(now = performance.now()) { return this.current ? Math.max(0, this.current.endsAt - now) : 0; }

  finish(why) {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    for (const s of cur.sources) { try { s.onended = null; s.stop(); } catch { /* not started yet */ } }
    try { cur.analyser.disconnect(); cur.gain.disconnect(); } catch { /* already */ }
    for (const m of MOUTH) this.mouthState[m] = 0;
    this.lastMouthAt = null; // the next reply's first frame starts from a clean dt
    cur.resolveEnd(why);
  }

  stop() { this.finish('stopped'); }

  // Mouth weights for this frame, or null when silent (the engine then leaves the mouth to gestures/expressions).
  mouth(now = performance.now()) {
    const cur = this.current;
    if (!cur) return null;
    const ctx = this.ctx;
    cur.analyser.getByteTimeDomainData(cur.wave);
    let sum = 0;
    for (let i = 0; i < cur.wave.length; i++) { const v = (cur.wave[i] - 128) / 128; sum += v * v; }
    const level = Math.min(1, Math.sqrt(sum / cur.wave.length) * 4.5);
    cur.analyser.getByteFrequencyData(cur.bins);
    const hz = ctx.sampleRate / 2 / cur.bins.length;
    const band = (a, b) => { let s = 0, n = 0; for (let i = Math.floor(a / hz); i <= Math.min(cur.bins.length - 1, Math.ceil(b / hz)); i++) { s += cur.bins[i]; n++; } return n ? s / n / 255 : 0; };
    const low = band(150, 700), mid = band(700, 1800), high = band(1800, 4500);
    const tot = low + mid + high + 1e-6;
    const target = level < 0.04 ? { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 } : {
      aa: level * (mid / tot) * 1.6,
      oh: level * (low / tot) * 0.9,
      ou: level * (low / tot) * 0.5,
      ee: level * (high / tot) * 0.9,
      ih: level * (high / tot) * 0.6,
    };
    // dt from the last call (capped so a stalled tab does not jump the mouth); the step is frame-rate independent.
    const dt = this.lastMouthAt == null ? 1000 / 60 : Math.min(100, Math.max(0, now - this.lastMouthAt));
    this.lastMouthAt = now;
    const st = this.mouthState;
    for (const m of MOUTH) st[m] = mouthStep(st[m], Math.min(1, target[m]), dt);
    return st;
  }
}
