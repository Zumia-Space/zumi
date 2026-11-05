'use strict';
// Talk cloud client — the ONLY place in the app that talks to a non-loopback host.
//
// Contract v1 for the desktop talk routes (signed by Sol 01-10 with conditions, the P1.1 verdict):
//   POST /api/zumi/desktop/turn     { contractVersion, turnId, message, history[≤6] }
//        -> { contractVersion, turnId, reply, analysis | null, gesture: { intent, brief, energy, deixis }, model, latencyMs, usage | null }
//   POST /api/zumi/desktop/gesture  { contractVersion, turnId, intent, brief, energy, deixis, targetMs, rigVersion }
//        -> { contractVersion, turnId, command | null, model, latencyMs, usage | null, repaired }
//   POST /api/zumi/tts              { text } -> { audio, audios[] } (public route, unchanged; NEVER sent the bearer)
//   errors: { error: { code, message, retryable }, traceId }, 429 with Retry-After.
//
// Rules this module enforces (Sol conditions 4, 6, 7):
//   - one origin only (ALLOWED_ORIGIN), https, redirects are errors (a bearer is never forwarded);
//   - the device token lives encrypted with Electron safeStorage (Windows DPAPI); no plaintext fallback: when encryption
//     is unavailable the talk feature is off;
//   - the token never reaches the renderer, logs, URLs or argv; logs carry op, status, timing, sizes and traceId only;
//   - narrow operations (turn / gesture / tts), each with its own payload validation — there is no generic fetch;
//   - TTS only for a turn that succeeded, once per turn, no retry.
// Modes: 'live' (packaged build with a zumiCloud.base and an imported token), 'fixture' (self-test: recorded answers +
// a generated tone, no network at all), 'off' (release build, or anything missing).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONTRACT_VERSION = 1;
const ALLOWED_ORIGIN = 'https://dev.zumia.space'; // staging only this round (Sol condition 1)
const INTENTS = ['greet', 'agree', 'disagree', 'point-screen', 'think', 'celebrate', 'explain', 'none'];
const ENERGIES = ['low', 'mid', 'high'];
const DEIXES = ['none', 'user', 'board', 'screen-left', 'screen-right'];
const TIMEOUT = { turn: 9000, gesture: 15000, tts: 9000 };
const LIMITS = { messageChars: 2000, historyItems: 6, historyChars: 2000, totalBytes: 24000, briefChars: 120, ttsChars: 2000, replyChars: 4000, analysisChars: 400 };
const TURN_ID = /^[0-9a-f]{32}$/;
const RIG_VERSION = /^[0-9a-f]{16,64}$/;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o, keys) => isObj(o) && Object.keys(o).every((k) => keys.includes(k));
const str = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;

class CloudError extends Error {
  constructor(code, message, { retryable = false, status = 0, retryAfterSec = null, traceId = null } = {}) {
    super(message);
    this.code = code; this.retryable = retryable; this.status = status; this.retryAfterSec = retryAfterSec; this.traceId = traceId;
  }
  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable, status: this.status, retryAfterSec: this.retryAfterSec, traceId: this.traceId }; }
}

// ---------- request validation (what the renderer may ask for) ----------
function checkTurnRequest(p) {
  if (!onlyKeys(p, ['turnId', 'message', 'history'])) return 'turn: unknown or missing fields';
  if (!TURN_ID.test(String(p.turnId))) return 'turn: turnId must be 128-bit hex';
  if (!str(p.message, LIMITS.messageChars)) return `turn: message must be 1..${LIMITS.messageChars} chars`;
  if (!Array.isArray(p.history) || p.history.length > LIMITS.historyItems) return `turn: history must be an array of <= ${LIMITS.historyItems}`;
  for (const h of p.history) {
    if (!onlyKeys(h, ['role', 'text']) || !['user', 'assistant'].includes(h.role) || !str(h.text, LIMITS.historyChars)) return 'turn: history items are {role: user|assistant, text}';
  }
  if (Buffer.byteLength(JSON.stringify(p)) > LIMITS.totalBytes) return 'turn: body too large';
  return null;
}
function checkGestureRequest(p) {
  if (!onlyKeys(p, ['turnId', 'intent', 'brief', 'energy', 'deixis', 'targetMs', 'rigVersion'])) return 'gesture: unknown or missing fields';
  if (!TURN_ID.test(String(p.turnId))) return 'gesture: turnId must be 128-bit hex';
  if (!INTENTS.includes(p.intent) || p.intent === 'none') return 'gesture: intent not composable';
  if (!str(p.brief, LIMITS.briefChars)) return 'gesture: brief must be 1..120 chars';
  if (!ENERGIES.includes(p.energy) || !DEIXES.includes(p.deixis)) return 'gesture: energy/deixis out of enum';
  if (!Number.isInteger(p.targetMs) || p.targetMs < 1500 || p.targetMs > 3500) return 'gesture: targetMs must be an integer 1500..3500';
  if (!RIG_VERSION.test(String(p.rigVersion))) return 'gesture: rigVersion must be hex';
  return null;
}
function checkTtsRequest(p) {
  if (!onlyKeys(p, ['turnId', 'text'])) return 'tts: unknown or missing fields';
  if (!TURN_ID.test(String(p.turnId))) return 'tts: turnId must be 128-bit hex';
  if (!str(p.text, LIMITS.ttsChars)) return 'tts: text must be 1..2000 chars';
  return null;
}

// ---------- response validation (what the server may answer) ----------
function checkAnalysisShape(a) {
  if (a === null) return true;
  return onlyKeys(a, ['understood', 'plan', 'why']) && ['understood', 'plan', 'why'].every((k) => str(a[k], LIMITS.analysisChars));
}
function checkTurnResponse(r, turnId) {
  if (!isObj(r) || r.contractVersion !== CONTRACT_VERSION) return 'turn: contractVersion';
  if (r.turnId !== turnId) return 'turn: turnId echo';
  if (!str(r.reply, LIMITS.replyChars)) return 'turn: reply';
  if (!('analysis' in r) || !checkAnalysisShape(r.analysis)) return 'turn: analysis must be an object or null';
  const g = r.gesture;
  if (!isObj(g) || !INTENTS.includes(g.intent) || !ENERGIES.includes(g.energy) || !DEIXES.includes(g.deixis) || !(g.brief === '' || str(g.brief, LIMITS.briefChars))) return 'turn: gesture';
  if (typeof r.model !== 'string') return 'turn: model';
  return null;
}
function checkGestureResponse(r, turnId) {
  if (!isObj(r) || r.contractVersion !== CONTRACT_VERSION) return 'gesture: contractVersion';
  if (r.turnId !== turnId) return 'gesture: turnId echo';
  if (!(r.command === null || isObj(r.command))) return 'gesture: command must be an object or null';
  return null;
}
const normUsage = (u) => (isObj(u) && ['inputTokens', 'outputTokens', 'totalTokens'].every((k) => Number.isFinite(u[k])) ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens } : null);

// ---------- device token (safeStorage / DPAPI) ----------
// Provisioning: an admin drops the token (from the server's issuing script) into <userData>/cloud-token.import once;
// the next start encrypts it into cloud-token.bin and destroys the import file. The renderer never sees either file.
function createTokenStore({ safeStorage, dir, log }) {
  const bin = path.join(dir, 'cloud-token.bin');
  const imp = path.join(dir, 'cloud-token.import');
  const available = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
  function importIfPresent() {
    if (!fs.existsSync(imp)) return 'none';
    if (!available()) { log('cloud token import skipped: OS encryption unavailable (talk stays off)'); return 'no-encryption'; }
    const raw = fs.readFileSync(imp, 'utf8').trim();
    try {
      if (!TOKEN_SHAPE.test(raw)) { log('cloud token import refused: unexpected format'); return 'bad-format'; }
      const tmp = `${bin}.tmp`;
      fs.writeFileSync(tmp, safeStorage.encryptString(raw));
      fs.renameSync(tmp, bin);
      log('cloud token imported (encrypted with the OS key)');
      return 'imported';
    } finally {
      try { fs.writeFileSync(imp, Buffer.alloc(Math.max(64, raw.length), 0)); fs.unlinkSync(imp); } catch { /* best effort */ }
    }
  }
  function read() {
    if (!available() || !fs.existsSync(bin)) return null;
    try { const t = safeStorage.decryptString(fs.readFileSync(bin)); return TOKEN_SHAPE.test(t) ? t : null; } catch { return null; }
  }
  return { importIfPresent, read, available, file: bin };
}

// ---------- live transport ----------
function createLive({ base, getToken, log, fetchImpl = fetch }) {
  const origin = new URL(base).origin;
  if (origin !== ALLOWED_ORIGIN || new URL(base).protocol !== 'https:') throw new Error('cloud base is not the allowlisted origin');
  async function post(op, pathname, body, { auth }) {
    const url = new URL(pathname, origin);
    if (url.origin !== ALLOWED_ORIGIN) throw new CloudError('bad_origin', 'refused: not the allowlisted origin');
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (auth) {
      const token = getToken();
      if (!token) throw new CloudError('no_token', 'no device token on this machine');
      headers.authorization = `Bearer ${token}`;
    }
    const payload = JSON.stringify(body);
    const t0 = Date.now();
    let res;
    try {
      res = await fetchImpl(url.href, { method: 'POST', headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT[op]) });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      log(`cloud ${op} ${timeout ? 'timeout' : 'network error'} after ${Date.now() - t0} ms`);
      throw new CloudError(timeout ? 'timeout' : 'network', timeout ? 'the server did not answer in time' : 'network error', { retryable: true });
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    const traceId = json && typeof json.traceId === 'string' ? json.traceId.slice(0, 64) : null;
    log(`cloud ${op} status=${res.status} ms=${Date.now() - t0} out=${payload.length}B in=${text.length}B${traceId ? ` trace=${traceId}` : ''}`);
    if (!res.ok) {
      const e = json && isObj(json.error) ? json.error : {};
      const ra = Number(res.headers.get('retry-after'));
      throw new CloudError(String(e.code || `http_${res.status}`).slice(0, 64), String(e.message || `HTTP ${res.status}`).slice(0, 200), { retryable: Boolean(e.retryable), status: res.status, retryAfterSec: Number.isFinite(ra) ? ra : null, traceId });
    }
    if (!json) throw new CloudError('bad_response', 'the server answered with something that is not JSON', { status: res.status, traceId });
    return json;
  }
  return {
    mode: 'live',
    async turn(p) {
      const r = await post('turn', '/api/zumi/desktop/turn', { contractVersion: CONTRACT_VERSION, ...p }, { auth: true });
      const bad = checkTurnResponse(r, p.turnId);
      if (bad) throw new CloudError('bad_response', bad);
      return { reply: r.reply, analysis: r.analysis, gesture: r.gesture, model: r.model, latencyMs: r.latencyMs, usage: normUsage(r.usage) };
    },
    async gesture(p) {
      const r = await post('gesture', '/api/zumi/desktop/gesture', { contractVersion: CONTRACT_VERSION, ...p }, { auth: true });
      const bad = checkGestureResponse(r, p.turnId);
      if (bad) throw new CloudError('bad_response', bad);
      return { command: r.command, model: r.model, latencyMs: r.latencyMs, usage: normUsage(r.usage), repaired: Boolean(r.repaired) };
    },
    async tts(p) {
      const r = await post('tts', '/api/zumi/tts', { text: p.text }, { auth: false }); // public route: never the bearer
      const list = Array.isArray(r.audios) && r.audios.length ? r.audios : r.audio ? [r.audio] : [];
      if (!list.length || list.some((a) => typeof a !== 'string')) throw new CloudError('bad_response', 'tts: no audio');
      return { mime: 'audio/mpeg', audios: list.map((b64) => Buffer.from(b64, 'base64')) };
    },
  };
}

// ---------- fixture transport (self-test: deterministic, no network) ----------
// Fixture file: { turns: { "<message>": { delayMs, reply, analysis, gesture, error? } }, defaultTurn, gestures: { "<turn message>": { delayMs, command } }, speechCharsPerSec }
function toneWav(ms, seed = 1) {
  const rate = 22050, n = Math.max(1, Math.round((rate * ms) / 1000));
  const buf = Buffer.alloc(44 + 2 * n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + 2 * n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(2 * n, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // syllable-like envelope (~4 Hz) over a voiced mix with a slowly moving formant, so the analyser sees changing bands
    const env = Math.max(0, Math.sin(2 * Math.PI * 4.1 * t + seed)) ** 0.7 * Math.min(1, t * 20, (n / rate - t) * 20);
    const f = 900 + 500 * Math.sin(2 * Math.PI * 0.7 * t + seed);
    const s = 0.5 * Math.sin(2 * Math.PI * 180 * t) + 0.35 * Math.sin(2 * Math.PI * f * t) + 0.15 * Math.sin(2 * Math.PI * 2600 * t);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s * env * 0.8)) * 32767), 44 + 2 * i);
  }
  return buf;
}
// audioDir (demo only): pre-rendered offline voice files, <first 16 hex of SHA-1(reply)>.wav; else a generated tone
function createFixture({ file, log, audioDir = null }) {
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const turnsById = new Map();
  const pick = (message) => fx.turns[message] || fx.defaultTurn;
  return {
    mode: 'fixture',
    async turn(p) {
      const t = pick(p.message);
      await sleep(t.delayMs || 0);
      log(`cloud(fixture) turn ${t.error ? `error ${t.error.code}` : `intent=${t.gesture.intent}`} after ${t.delayMs || 0} ms`);
      if (t.error) throw new CloudError(t.error.code, t.error.message, { retryable: Boolean(t.error.retryable), status: t.error.status || 503 });
      turnsById.set(p.turnId, p.message);
      return { reply: t.reply, analysis: t.analysis === undefined ? null : t.analysis, gesture: t.gesture, model: 'fixture', latencyMs: t.delayMs || 0, usage: null };
    },
    async gesture(p) {
      const g = fx.gestures[turnsById.get(p.turnId)] || { delayMs: 0, command: null };
      await sleep(g.delayMs || 0);
      log(`cloud(fixture) gesture ${g.command ? 'command' : 'null'} after ${g.delayMs || 0} ms`);
      return { command: g.command, model: 'fixture', latencyMs: g.delayMs || 0, usage: null, repaired: false };
    },
    async tts(p) {
      const t = pick(turnsById.get(p.turnId) || '');
      await sleep(t.ttsDelayMs || 120);
      if (audioDir) {
        const f = path.join(audioDir, `${crypto.createHash('sha1').update(p.text, 'utf8').digest('hex').slice(0, 16)}.wav`);
        if (fs.existsSync(f)) return { mime: 'audio/wav', audios: [fs.readFileSync(f)], voice: 'offline' };
      }
      const ms = t.speechMs || Math.min(8000, Math.max(1200, (p.text.length / (fx.speechCharsPerSec || 13)) * 1000));
      return { mime: 'audio/wav', audios: [toneWav(ms, p.text.length % 7)], voice: 'tone' };
    },
  };
}

// ---------- the module the main process wires to IPC ----------
// opts: { mode: 'auto'|'fixture', base, fixtureFile, safeStorage, tokenDir, log }
function createCloud(opts) {
  const log = opts.log || (() => {});
  let transport = null;
  let reason = null;
  if (opts.mode === 'fixture') {
    transport = createFixture({ file: opts.fixtureFile, log, audioDir: opts.audioDir || null });
  } else if (!opts.base) {
    reason = 'this build has no talk server configured';
  } else {
    const tokens = createTokenStore({ safeStorage: opts.safeStorage, dir: opts.tokenDir, log });
    tokens.importIfPresent();
    if (!tokens.available()) reason = 'OS encryption is unavailable, so no device token can be stored';
    else if (!tokens.read()) reason = 'no device token on this machine';
    else {
      try { transport = createLive({ base: opts.base, getToken: tokens.read, log, fetchImpl: opts.fetchImpl }); } catch (e) { reason = e.message; }
    }
  }
  const okTurns = new Set(); // turnIds that succeeded (TTS and one gesture allowed for them)
  const gestured = new Set();
  const spoken = new Set();
  const fail = (e) => ({ ok: false, error: e instanceof CloudError ? e.toJSON() : { code: 'internal', message: String((e && e.message) || e).slice(0, 200), retryable: false } });
  return {
    status: () => ({ enabled: Boolean(transport), mode: transport ? transport.mode : 'off', reason }),
    async turn(p) {
      const bad = checkTurnRequest(p);
      if (bad) return fail(new CloudError('bad_request', bad));
      if (!transport) return fail(new CloudError('talk_off', reason || 'talk is off'));
      try { const r = await transport.turn(p); okTurns.add(p.turnId); return { ok: true, ...r }; } catch (e) { return fail(e); }
    },
    async gesture(p) {
      const bad = checkGestureRequest(p);
      if (bad) return fail(new CloudError('bad_request', bad));
      if (!transport) return fail(new CloudError('talk_off', reason || 'talk is off'));
      if (!okTurns.has(p.turnId)) return fail(new CloudError('no_turn', 'gesture asked for a turn that did not succeed'));
      if (gestured.has(p.turnId)) return fail(new CloudError('once_per_turn', 'one gesture per turn'));
      gestured.add(p.turnId);
      try { return { ok: true, ...(await transport.gesture(p)) }; } catch (e) { return fail(e); }
    },
    async tts(p) {
      const bad = checkTtsRequest(p);
      if (bad) return fail(new CloudError('bad_request', bad));
      if (!transport) return fail(new CloudError('talk_off', reason || 'talk is off'));
      if (!okTurns.has(p.turnId)) return fail(new CloudError('no_turn', 'speech asked for a turn that did not succeed'));
      if (spoken.has(p.turnId)) return fail(new CloudError('once_per_turn', 'one speech per turn'));
      spoken.add(p.turnId);
      try { return { ok: true, ...(await transport.tts(p)) }; } catch (e) { return fail(e); }
    },
  };
}

module.exports = { createCloud, createTokenStore, CloudError, CONTRACT_VERSION, ALLOWED_ORIGIN, INTENTS, ENERGIES, DEIXES, LIMITS, toneWav,
  _test: { checkTurnRequest, checkGestureRequest, checkTtsRequest, checkTurnResponse, checkGestureResponse, createLive, normUsage } };
