// T-31 settings-a2: Settings > Voice > Speed (0.75-1.5x) + Volume + Play sample. No Electron, no real worker, no
// audio device: a fake worker records what kokoro-tts.js sends; the rest is checked in the sources it lives in.
//   1. kokoro-tts.js: setSpeed clamps to 0.75-1.5 and every 'speak' / 'open' message carries the current speed;
//   2. kokoro-worker.mjs: a stream keeps that speed and hands it to Kokoro's own generate({ speed });
//   3. main.js: talk:get/setVoicePrefs persist voiceSpeed / voiceVolume (clamped) and push the speed to Kokoro;
//   4. renderer: the volume is a GainNode AFTER the analyser (the mouth still reads the voice at any volume), the
//      sliders save on release, the volume is heard live, Play sample goes through the real talk:tts path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. kokoro-tts.js ----------
{
  const { createKokoroTts } = require('../src/main/kokoro-tts.js');
  const sent = [];
  const factory = () => {
    const w = new EventEmitter();
    w.postMessage = (msg) => { sent.push(msg); if (msg.cmd === 'speak') setImmediate(() => { w.emit('message', { type: 'sentence', turnId: msg.turnId, index: 0, text: msg.text, wav: new ArrayBuffer(44), synthEndedAt: Date.now() }); w.emit('message', { type: 'done', turnId: msg.turnId }); }); };
    w.terminate = () => {};
    return w;
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-prefs-'));
  const kk = createKokoroTts({ userDataDir: tmp, workerFactory: factory });
  ok(kk.speed() === 1, 'kokoro: default speed 1');
  ok(kk.setSpeed(1.25) === 1.25 && kk.setSpeed(3) === 1.5 && kk.setSpeed(0.1) === 0.75 && kk.setSpeed('fast') === 1 && kk.setSpeed(Number.NaN) === 1, 'kokoro: setSpeed clamps to 0.75-1.5, junk -> 1');
  kk.setSpeed(1.25);
  await kk.speakStream('t1'.padEnd(32, '0'), 'Hello there.', () => {});
  const speak = sent.find((m) => m.cmd === 'speak');
  ok(speak && speak.speed === 1.25, 'kokoro: a spoken reply carries the current speed', JSON.stringify(speak && speak.speed));
  kk.setSpeed(0.75);
  // Since 4b200967 the worker hears of a live turn at its first chunk ('open' is lazy), and the chunker holds an
  // unfinished sentence until more text or the end: the reply must finish for 'Hi.' to become a chunk.
  const live = { text: () => 'Hi.', onText: () => () => {}, final: Promise.resolve() };
  kk.speakLive('t2'.padEnd(32, '0'), live, () => {});
  await sleep(5);
  const open = sent.find((m) => m.cmd === 'open');
  ok(open && open.speed === 0.75, 'kokoro: a streamed reply opens with the current speed (a change applies from the next reply)');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- 2. kokoro-worker.mjs ----------
{
  const w = read('src', 'main', 'kokoro-worker.mjs');
  ok(/tts\.generate\(chunk, \{ voice: VOICE, speed: s\.speed \}\)/.test(w), "worker: Kokoro's generate() gets the stream's speed (natural pitch, not a playback-rate trick)");
  ok(/msg\.cmd === 'speak'\) handleSpeak\(msg\.turnId, msg\.text, msg\.speed\)/.test(w) && /msg\.cmd === 'open'\) openStream\(msg\.turnId, msg\.speed\)/.test(w), "worker: 'speak' and 'open' keep the speed they were sent");
  ok(/speed: typeof speed === 'number' && speed > 0 \? speed : 1/.test(w), 'worker: a missing/bad speed falls back to 1');
}

// ---------- 3. the routing core + main.js wiring (step 8b extracted the prefs there) ----------
{
  const m = read('src', 'main', 'main.js');
  const core = read('src', 'main', 'talk-voice-core.mjs');
  ok(/export const VOICE_SPEED = \{ min: 0\.75, max: 1\.5, def: 1 \}/.test(core), 'core: speed range 0.75-1.5, default 1');
  ok(/voiceSpeed: Math\.round\(clampNum\(p\.speed, VOICE_SPEED\.min, VOICE_SPEED\.max, cur\.speed\)/.test(core) && /voiceVolume: Math\.round\(clampNum\(p\.volume, 0, 1, cur\.volume\)/.test(core), 'core: setVoicePrefs clamps both values before saving them to settings.json');
  ok(/saveSettings\(next\);\s*const k = kokoro\(\);\s*if \(k\) k\.setSpeed\(next\.voiceSpeed\)/.test(core), 'core: a new speed reaches Kokoro at once');
  ok(/kokoroTts\.setSpeed\(talkVoice\.voicePrefs\(\)\.speed\)/.test(m), 'main: the saved speed is applied at startup');
  ok(/ipcMain\.handle\('talk:getVoicePrefs', \(e\) => \(fromAppPage\(e\) \? talkVoice\.voicePrefs\(\)/.test(m) && /ipcMain\.handle\('talk:setVoicePrefs', \(e, p\) => \(fromAppPage\(e\) && p/.test(m), 'main: both voice-prefs handlers check the sender and delegate to the core');
}

// ---------- 4. renderer ----------
{
  const sp = read('src', 'renderer', 'talk', 'speech.js');
  ok(/analyser\.connect\(gain\);\s*gain\.connect\(ctx\.destination\);/.test(sp), 'speech: volume = a GainNode after the analyser (mouth level unaffected by volume)');
  ok(/setVolume\(v\) \{[^}]*Math\.min\(1, Math\.max\(0, v\)\)/.test(sp) && /this\.current\.gain\.gain\.value = this\.volume/.test(sp), 'speech: setVolume clamps 0-1 and changes a reply already playing');
  const st = read('src', 'renderer', 'settings.js');
  ok(/el\.speed\.addEventListener\('change', \(\) => \{ zumi\.talk\.setVoicePrefs\(\{ speed:/.test(st) && /el\.volume\.addEventListener\('change', \(\) => \{ zumi\.talk\.setVoicePrefs\(\{ volume:/.test(st), 'settings: both sliders save on release');
  ok(/el\.volume\.addEventListener\('input', \(\) => \{ showVolume\(\); if \(voice\) voice\.setVolume\(/.test(st), 'settings: the volume is heard live while dragging');
  const ti = read('src', 'renderer', 'talk', 'index.js');
  ok(/async playSample\(text\) \{[\s\S]*zumi\.talk\.tts\(\{ turnId, text \}\)[\s\S]*speech\.prepare\(r\.audios\)/.test(ti), 'talk: Play sample goes through the real talk:tts path and the same SpeechOut (speed + volume apply)');
  const html = read('src', 'renderer', 'index.html');
  ok(/id="voice-speed" min="0\.75" max="1\.5" step="0\.05"/.test(html) && /id="voice-volume" min="0" max="100"/.test(html) && /id="voice-sample"/.test(html), 'markup: Speed 0.75-1.5, Volume 0-100, Play sample in the Voice card');
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? `FAIL check-voice-prefs — ${fail} failed` : `PASS check-voice-prefs — ${pass}/${pass} assertions passed`);
process.exitCode = fail ? 1 : 0;
