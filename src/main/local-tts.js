'use strict';
// Free local voice for Windows: speak with the OS's own System.Speech (SAPI) voices, so a build with no cloud (no
// talk server, no key) still has a voice. No Electron imports here on purpose — main.js wires it and
// scripts/check-local-tts.mjs exercises it under plain Node.
//
// The result shape matches the cloud TTS transport ({ mime, audios: Buffer[], voice }), so the renderer's SpeechOut
// decodes the WAV bytes and drives lip-sync from audio energy with no renderer change. One typed exception:
// Vietnamese text on a machine with no vi-VN voice comes back as
// { mime: 'audio/wav', audios: [], voice: 'none', reason: 'no-vi-voice' } rather than a fake English reading.
//
// Everything runs off the main thread's stack: PowerShell is spawned as a child, never run synchronously, so a
// synthesis that takes ~1 s cannot stall Electron's main process. Voice enumeration is a child too, started once in
// the background; `available()`/`voices()` stay synchronous and read the cached result once it is warm.
//
// Injection safety: the spoken text NEVER goes on the PowerShell command line. It is written to a temp UTF-8 file and
// the paths/voice are handed over in the process environment; the script itself is a constant ASCII string piped to
// stdin, so no caller-supplied character is ever parsed as PowerShell.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const TIMEOUT_MS = 15000;
const TTS_CHARS = 2000;
const TURN_ID = /^[0-9a-f]{32}$/;
const PREFERRED_EN = 'microsoft zira desktop';
// Precomposed accented Latin vowels (Vietnamese block included) and combining marks (NFD Vietnamese). The app's talk
// path is Vietnamese, so an accented vowel marks the reply as Vietnamese: it must never be read in an English voice.
// (Documented trade-off: a European word inside an English reply, e.g. "café", is also treated as Vietnamese.)
const VI_ACCENT = /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF\u0102\u0103\u0110\u0111\u01A0\u01A1\u01AF\u01B0\u1EA0-\u1EF9\u0300-\u036F]/;

const LIST_VOICES_PS = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  "$s.GetInstalledVoices() | ForEach-Object { if ($_.Enabled) { '{0}|{1}' -f $_.VoiceInfo.Name, $_.VoiceInfo.Culture.Name } }",
  '$s.Dispose()',
].join('\n') + '\n';

const SPEAK_PS = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.SelectVoice($env:ZUMI_TTS_VOICE)',
  '$t = [System.IO.File]::ReadAllText($env:ZUMI_TTS_TEXT, [System.Text.Encoding]::UTF8)',
  '$s.SetOutputToWaveFile($env:ZUMI_TTS_OUT)',
  '$s.Speak($t)',
  '$s.SetOutputToNull()',
  '$s.Dispose()',
].join('\n') + '\n';

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];

class LocalTtsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o, keys) => isObj(o) && Object.keys(o).every((k) => keys.includes(k));
// Control characters are not speakable and could split words: collapse any run to a single space, then trim.
const cleanText = (t) => String(t).normalize('NFC').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();

// Spawn one PowerShell, hand it the script on stdin, and resolve its stdout. On timeout only THIS child is killed.
function runPs(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', PS_ARGS, { windowsHide: true, env: { ...process.env, ...extraEnv } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(reject, new Error('powershell timed out')); }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8'); // setEncoding decodes split multi-byte sequences correctly across chunks
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < (1 << 20)) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 500) stderr += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => finish(code === 0 ? resolve : reject, code === 0 ? { stdout, stderr } : new Error(`powershell exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`)));
    child.stdin.on('error', () => { /* EPIPE if the child dies early */ });
    child.stdin.write(script);
    child.stdin.end();
  });
}

// voices: [{ name, culture }] (culture e.g. 'en-US' / 'vi-VN') -> { voice, reason? }
function chooseVoice(voices, text) {
  if (VI_ACCENT.test(text)) {
    const vi = voices.find((v) => /^vi\b/i.test(v.culture));
    return vi ? { voice: vi.name } : { voice: null, reason: 'no-vi-voice' };
  }
  const en = voices.filter((v) => /^en\b/i.test(v.culture));
  const zira = en.find((v) => v.name.toLowerCase() === PREFERRED_EN);
  const pick = zira || en[0] || voices[0];
  return pick ? { voice: pick.name } : { voice: null, reason: 'no-voice' };
}

function checkRequest(p) {
  if (!onlyKeys(p, ['turnId', 'text'])) return 'tts: unknown or missing fields';
  if (!TURN_ID.test(String(p.turnId))) return 'tts: turnId must be 128-bit hex';
  if (typeof p.text !== 'string') return 'tts: text must be a string';
  const text = cleanText(p.text);
  if (!text) return `tts: text must be 1..${TTS_CHARS} chars`;
  if (text.length > TTS_CHARS) return `tts: text must be 1..${TTS_CHARS} chars`;
  return null;
}

// deps: { tmpDir, log }
function createLocalTts({ tmpDir, log = () => {} } = {}) {
  const dir = tmpDir || path.join(os.tmpdir(), 'zumi-tts');
  let cache = null; // { ok, entries, error }
  let pending = null;

  // One orphaned pair can survive a hard kill mid-speak (the OS ends the process before its finally runs); clear
  // anything left from a previous run at start-up.
  try { for (const f of fs.readdirSync(dir)) if (/^zumi-tts-[0-9a-f]{16}\.(txt|wav)$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* in use */ } } } catch { /* dir not created yet */ }

  // Enumerating voices spawns PowerShell (~0.3 s); do it once, off the main stack. A transient failure is NOT cached,
  // so the next call retries instead of disabling the voice for the whole session.
  function enumerate() {
    if (cache) return Promise.resolve(cache);
    if (pending) return pending;
    if (process.platform !== 'win32') { cache = { ok: false, entries: [], error: 'not windows' }; return Promise.resolve(cache); }
    pending = runPs(LIST_VOICES_PS).then(({ stdout }) => {
      pending = null;
      const entries = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const s = line.trim();
        const i = s.indexOf('|');
        if (i > 0) entries.push({ name: s.slice(0, i), culture: s.slice(i + 1) });
      }
      cache = { ok: entries.length > 0, entries, error: entries.length ? null : 'no voices installed' };
      log(`local-tts voices: ${entries.length}`);
      return cache;
    }, (err) => {
      pending = null; // not cached: retry on the next call
      const error = String((err && err.message) || err).slice(0, 200);
      log(`local-tts voices unavailable: ${error.slice(0, 120)}`);
      return { ok: false, entries: [], error };
    });
    return pending;
  }
  enumerate(); // pre-warm; accessors below stay synchronous

  const ready = () => enumerate().then(() => undefined);
  // Before the probe finishes, a Windows machine is assumed to have a voice; the real answer lands at speak() time.
  const available = () => (cache ? cache.ok : process.platform === 'win32');
  const voices = () => (cache ? cache.entries.map((v) => v.name) : []);
  async function info() {
    const en = await enumerate();
    return en.ok ? { mode: 'windows', voice: chooseVoice(en.entries, 'english').voice || null } : { mode: 'off', voice: null };
  }

  async function speak(p) {
    const bad = checkRequest(p);
    if (bad) { log(`local-tts refused: ${bad}`); throw new LocalTtsError('bad_request', bad); }
    const en = await enumerate();
    if (!en.ok) throw new LocalTtsError('no_voice', en.error || 'no voices installed');
    const text = cleanText(p.text);
    const choice = chooseVoice(en.entries, text);
    if (!choice.voice) { log(`local-tts no voice (${choice.reason})`); return { mime: 'audio/wav', audios: [], voice: 'none', reason: choice.reason }; }

    fs.mkdirSync(dir, { recursive: true });
    const stem = `zumi-tts-${crypto.randomBytes(8).toString('hex')}`;
    const textFile = path.join(dir, `${stem}.txt`);
    const wavFile = path.join(dir, `${stem}.wav`);
    try {
      fs.writeFileSync(textFile, text, 'utf8');
      await runPs(SPEAK_PS, { ZUMI_TTS_VOICE: choice.voice, ZUMI_TTS_TEXT: textFile, ZUMI_TTS_OUT: wavFile });
      const wav = fs.readFileSync(wavFile);
      if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new LocalTtsError('bad_audio', 'the synthesizer wrote no WAV');
      log(`local-tts spoke ${text.length} chars with ${choice.voice} (${wav.length} bytes)`);
      return { mime: 'audio/wav', audios: [wav], voice: choice.voice };
    } finally {
      for (const f of [textFile, wavFile]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
    }
  }

  return { available, voices, ready, info, speak };
}

// Reused by the P1 EN/VI TTS router in main.js so there is exactly one "is this Vietnamese?" heuristic in the app,
// not two independently-drifting copies.
const isVietnamese = (text) => VI_ACCENT.test(String(text || ''));

module.exports = { createLocalTts, LocalTtsError, LIMITS: { ttsChars: TTS_CHARS }, isVietnamese, _test: { chooseVoice, cleanText, checkRequest, LIST_VOICES_PS, SPEAK_PS } };
