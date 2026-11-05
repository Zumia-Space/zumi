// T-31 Tauri parity step 8a check: the talk-mode scheduler in the sidecar. Plain Node, no Electron, no window, no
// network (the scheduler and this host have no egress at all).
//
//   node scripts/check-tauri-speech.mjs
//
//   1. the wrapper main.js's whenReady block provides: migrateTalkLevel at start, the 500 ms settings cache, the tick
//      started by sayReady, the "updated" line on the Tauri app version;
//   2. speech:say order and mute semantics: nothing before sayReady (it is acked busy), one line per enqueue after it,
//      mute/unmute through the talkMute pref, timed-mute expiry, ack outcomes;
//   3. sayEvent accepts only poke | pat | look;
//   4. the scheduler module is src/main/speech-scheduler.mjs UNCHANGED (no copy, no local line renderer);
//   5. the real stdio protocol: the 11 names answer, the event path emits speech:say, and 8b names stay honest.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createSpeechHost } from '../tauri/sidecar/speech-host.mjs';
import { sidecarHandlerNames } from './check-tauri-coverage.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const MIN = 60_000;
// A FIXED local noon (a real calendar date, never today), so quiet hours / rollover / mute decisions do not depend on
// the machine's wall clock or on when this check runs. The Date constructor reads local fields, so this stays local
// noon under any TZ.
const FIXED_NOW = new Date(2025, 0, 15, 12, 0, 0).getTime();
const T0 = FIXED_NOW;

// A settings store with the same merge semantics as src/main/main.js saveSettings (and a read counter for the cache test).
function store(initial = {}) {
  let s = JSON.parse(JSON.stringify(initial));
  let reads = 0;
  let writes = 0;
  return {
    get: () => { reads++; return { ...s }; },
    set: (patch) => { writes++; s = { ...s, ...patch }; return s; },
    state: () => s,
    reads: () => reads,
    writes: () => writes,
  };
}

function make(initial = {}, { now = T0, intervalMs = 60_000 } = {}) {
  const st = store(initial);
  const signals = { idle: 5, visible: true };
  const events = [];
  const clock = { t: now };
  const host = createSpeechHost({
    settings: st.get,
    saveSettings: st.set,
    signals: { idleSeconds: () => signals.idle, windowVisible: () => signals.visible },
    emit: (channel, payload) => { events.push({ channel, payload }); return true; },
    version: '9.9.9',
    now: () => clock.t,
    intervalMs,
    log: () => {},
  });
  return { host, st, signals, events, clock };
}
const drain = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- 1. wrapper behaviour
{
  const migrated = make({ hudVoiceMuted: true });
  ok(migrated.st.state().talkLevel === 'off' && migrated.st.state().hudVoiceMuted === undefined,
    'migrateTalkLevel runs at start: hudVoiceMuted: true -> talkLevel off (the old key is removed)');
  migrated.host.dispose();

  const kept = make({ talkLevel: 'quiet' });
  ok(kept.st.state().talkLevel === 'quiet' && kept.st.writes() === 0, 'an existing talkLevel is not rewritten');
  kept.host.dispose();

  // 500 ms settings cache: the scheduler's prefs reads share one settings read; a write drops it.
  const c = make({ talkLevel: 'normal' });
  const before = c.st.reads();
  c.host.handlers['talk.sayStatus']();
  const afterFirst = c.st.reads();
  c.host.handlers['talk.sayStatus']();
  const afterSecond = c.st.reads();
  ok(afterFirst === before + 1 && afterSecond === afterFirst, 'the 500 ms settings cache serves the second status read', `${before}/${afterFirst}/${afterSecond}`);
  c.clock.t += 600;
  c.host.handlers['talk.sayStatus']();
  ok(c.st.reads() === afterSecond + 1, 'a read after 500 ms re-reads settings');
  const changed = c.host.handlers['talk.setTalkPrefs']({ talkLevel: 'chatty' });
  ok(changed.talkLevel === 'chatty' && c.st.state().talkLevel === 'chatty', 'setTalkPrefs normalises and persists the patch');
  c.host.handlers['talk.sayStatus']();
  ok(c.st.reads() >= afterSecond + 3, 'a setTalkPrefs write drops the cache (the next decision sees the new prefs)');
  c.host.dispose();

  // The "updated" line uses the app version the host was given (Electron app.getVersion()).
  const updated = make({ talkLevel: 'normal', talkLastVersion: '0.0.1' });
  updated.host.handlers['talk.sayReady']();
  const line = updated.events.find((e) => e.channel === 'speech:say' && e.payload.kind === 'event');
  ok(Boolean(line) && line.payload.text.includes('9.9.9') && line.payload.mood === 'celebrate',
    'the "updated" line is enqueued on a new version and names the Tauri app version', JSON.stringify(line && line.payload));
  ok(updated.st.state().talkLastVersion === '9.9.9', 'talkLastVersion is recorded as the host version');
  ok(updated.host.handlers['talk.sayReady']() === true, 'sayReady is idempotent (a renderer reload calls it again)');
  updated.host.dispose();

  const firstRun = make({ talkLevel: 'normal' });
  firstRun.host.handlers['talk.sayReady']();
  ok(firstRun.events.length === 0, 'no "updated" line on the first run (no previous version recorded)');
  firstRun.host.dispose();
  const sameVersion = make({ talkLevel: 'normal', talkLastVersion: '9.9.9' });
  sameVersion.host.handlers['talk.sayReady']();
  ok(sameVersion.events.length === 0, 'no "updated" line when the version is unchanged');
  sameVersion.host.dispose();

  // The 1 s tick: it does not run before sayReady and starts on it. A short interval here (the product uses 1 s) lets
  // the first tick produce the 12:00 active-day morning line, proving the clock is really wired to scheduler.tick().
  const ticker = make({ talkLevel: 'normal' }, { intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 60));
  ok(ticker.events.length === 0, 'the scheduler clock does not run before sayReady');
  ticker.host.handlers['talk.sayReady']();
  const deadline = Date.now() + 2000;
  while (!ticker.events.some((e) => e.payload.kind === 'morning') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  ok(ticker.events.some((e) => e.payload.kind === 'morning'), 'sayReady starts the 1 s tick that drives scheduler.tick()', JSON.stringify(ticker.events.map((e) => e.payload.kind)));
  ticker.host.dispose();
}

// ---------------------------------------------------------------- 2. speech:say order, busy before ready, mute
{
  // A line emitted before the renderer listens is handed back as busy: nothing on the channel, nothing left live.
  const early = make({ talkLevel: 'normal' });
  const accepted = early.host.handlers['talk.sayEvent']('poke');
  ok(accepted === true && early.events.length === 0 && early.host.handlers['talk.sayStatus']().live === 1,
    'before sayReady the line is held for a moment (emitted to the wrapper, not to the renderer)');
  await drain();
  ok(early.host.handlers['talk.sayStatus']().live === 0, 'a line before sayReady is acked busy (the live id is released)');
  early.host.dispose();

  // Order after sayReady: one line per enqueue, in enqueue order, and the gap rule still applies between them.
  const h = make({ talkLevel: 'normal' });
  h.host.handlers['talk.sayReady']();
  h.clock.t += 3 * MIN + 1; // past the Normal gap left by the clock's start
  ok(h.host.handlers['talk.sayEvent']('pat') === true, 'sayEvent(pat) is accepted');
  const first = h.events.at(-1);
  ok(first.channel === 'speech:say' && first.payload.kind === 'event' && first.payload.voice === true
    && ['sayId', 'kind', 'text', 'show', 'voice', 'lang', 'mood'].every((k) => k in first.payload),
    'a line is pushed on speech:say with Electron preload\'s { sayId, kind, text, show, voice, lang, mood }', JSON.stringify(first.payload));
  ok(h.host.handlers['talk.sayAck'](first.payload.sayId, true, null).action === 'done', 'sayAck(spoken) closes the line (done)');
  ok(h.host.handlers['talk.sayAck']('say-missing', true, null).action === 'unknown', 'an unknown sayId is answered unknown');
  // The Normal 3-min gap is Electron's rule, not a test artefact: an immediate second line is dropped.
  const gapCount = h.events.length;
  ok(h.host.handlers['talk.sayEvent']('look') === true && h.events.length === gapCount,
    'a second line inside the 3-min gap is dropped (the scheduler gap rule)');
  h.clock.t += 3 * MIN + 1;
  h.host.handlers['talk.sayEvent']('look');
  const second = h.events.at(-1);
  ok(h.events.length === 2 && second.payload.kind === 'event' && second.payload.sayId !== first.payload.sayId,
    'a second line follows in enqueue order (speech:say order: sayReady, then each line)');

  // Mute is the talkMute pref (survives a restart). Muted: an event line is dropped, not shown; unmute restores it.
  const muted = h.host.handlers['talk.mute'](null);
  ok(muted.muted === true && muted.muteUntil === null && h.st.state().talkMute.until === null,
    'mute(null) persists talkMute { until: null } and reads back muted');
  h.clock.t += 3 * MIN + 1;
  const beforeMuted = h.events.length;
  ok(h.host.handlers['talk.sayEvent']('poke') === true && h.events.length === beforeMuted,
    'while muted an event line is dropped (enqueued, never shown)');
  const unmuted = h.host.handlers['talk.unmute']();
  ok(unmuted.muted === false && h.st.state().talkMute === null, 'unmute() clears the pref and reads back unmuted');
  h.clock.t += 3 * MIN + 1;
  h.host.handlers['talk.sayEvent']('poke');
  ok(h.events.length === beforeMuted + 1, 'after unmute the next line is shown');
  const timedUntil = h.clock.t + 1000;
  const timed = h.host.handlers['talk.mute'](timedUntil);
  ok(timed.muted === true && timed.muteUntil === timedUntil, 'mute(untilMs) records the timed mute');
  h.clock.t += 1001;
  ok(h.host.handlers['talk.sayStatus']().muted === false, 'a timed mute expires on the next status read');
  ok(h.host.handlers['talk.mute']('not-a-number').muted === false, 'a non-finite untilMs changes nothing');
  h.host.dispose();
}

// ---------------------------------------------------------------- 3. sayEvent whitelist
{
  const h = make({ talkLevel: 'chatty' });
  h.host.handlers['talk.sayReady']();
  const allowed = ['poke', 'pat', 'look'];
  ok(allowed.every((n) => h.host.handlers['talk.sayEvent'](n) === true), 'sayEvent accepts poke / pat / look');
  const refused = ['updated', 'boardLost', 'say', 'POKE', 'look ', '', null, undefined, 42, {}, ['poke']];
  const answers = refused.map((n) => h.host.handlers['talk.sayEvent'](n));
  ok(answers.every((r) => r === false), 'sayEvent refuses everything else (no arbitrary text)', JSON.stringify(answers));
  h.host.dispose();
}

// ---------------------------------------------------------------- 4. the scheduler is the Electron module, unchanged
{
  const src = read('tauri', 'sidecar', 'speech-host.mjs').replace(/^\s*\/\/.*$/gm, '');
  ok(/from '\.\.\/\.\.\/src\/main\/speech-scheduler\.mjs'/.test(src), 'the sidecar host imports src/main/speech-scheduler.mjs directly');
  ok(!/function createSpeechScheduler|function talkPrefs|const LEVELS/.test(src), 'the host carries no copy of the scheduler or the level matrix');
  const hostImports = (src.match(/from '([^']+)'/g) || []).join(' ');
  ok(!/electron|node:https?|node:net|fetch\(/.test(src), 'the host opens no network and imports no Electron', hostImports);
}

// ---------------------------------------------------------------- 5. over the real stdio protocol
function startSidecar(dataDir) {
  // --now-ms pins the sidecar's one clock: the scheduler sees local noon whatever the machine's clock/TZ says.
  const child = spawn(process.execPath, [SIDECAR, '--data-dir', dataDir, '--now-ms', String(FIXED_NOW)], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const events = [];
  let stderr = '';
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.once('exit', (code) => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`sidecar exited (code=${code}) while waiting for ${p.method}`)); }
    pending.clear();
  });
  rl.on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve();
    else if (m.method === 'event') events.push(m.params);
    else if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); p.resolve(m);
    }
  });
  return {
    child, events, stderrText: () => stderr, ready,
    request(method, params = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        // A crashed or wedged sidecar must fail the check, not hang it: 30 s is the same bound the product's host uses
        // for a call (CALL_TIMEOUT), so a real stall still fails, just later.
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 30000);
        pending.set(id, { resolve, reject, timer, method });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() { child.stdin.end(); return new Promise((r) => child.on('close', r)); },
  };
}

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP_ROOT, 'speech-'));

{
  const dir = path.join(work, 'plain');
  fs.mkdirSync(dir, { recursive: true });
  // voiceEnabled:false keeps the step-8b Kokoro prefetch from downloading the model in this scheduler-only check.
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ voiceEnabled: false }, null, 2));
  const c = startSidecar(dir);
  await c.ready;
  // The Rust host pushes idle every second; a test client is the host here, so it pushes the same signal. Without it
  // the cache reads 0 s (host-signals' "the user is here" default), which the scheduler treats as typing and holds.
  ok((await c.request('__host.idle', [5])).result === true, '__host.idle is accepted (the step-6-pre signal)');
  const status = (await c.request('talk.sayStatus')).result;
  ok(status && status.level === 'normal' && status.voiceLang === 'en' && status.muted === false && status.cap === 60,
    'talk.sayStatus answers the scheduler status (Normal, EN, unmuted)', JSON.stringify(status));
  const prefs = (await c.request('talk.getTalkPrefs')).result;
  ok(prefs && prefs.talkLevel === 'normal' && prefs.talkQuietHours.on === true && prefs.talkMute === null,
    'talk.getTalkPrefs answers the normalised prefs', JSON.stringify(prefs));
  ok((await c.request('talk.setTalkPrefs', [{ talkLevel: 'chatty' }])).result.talkLevel === 'chatty', 'talk.setTalkPrefs answers the new prefs');
  ok((await c.request('talk.setTalkPrefs', ['bad'])).result === null, 'talk.setTalkPrefs answers null for a non-object patch');
  ok((await c.request('talk.setVoiceEnabled', [false])).result === true, 'talk.setVoiceEnabled answers true');
  ok((await c.request('talk.setThinkSound', [true])).result === true, 'talk.setThinkSound answers true');
  ok((await c.request('talk.setSpeakTypedWhenMicOff', [false])).result === true, 'talk.setSpeakTypedWhenMicOff answers true');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  ok(saved.voiceEnabled === false && saved.thinkSound === true && saved.speakTypedWhenMicOff === false && saved.talkLevel === 'chatty',
    'the three switches and the talk level land in the preview settings.json', JSON.stringify(saved));

  // Before sayReady: accepted, nothing on the channel, and the live id is acked busy.
  ok((await c.request('talk.sayEvent', ['poke'])).result === true, 'talk.sayEvent(poke) answers true before sayReady');
  await new Promise((r) => setTimeout(r, 50));
  ok(c.events.length === 0, 'no speech:say reaches the host before sayReady');
  ok((await c.request('talk.sayStatus')).result.live === 0, 'the pre-ready line was acked busy (live released)');
  ok((await c.request('talk.sayReady')).result === true, 'talk.sayReady answers true');
  ok((await c.request('talk.sayAck', ['say-missing', true, null])).result.action === 'unknown', 'talk.sayAck answers unknown for an unknown id');
  ok((await c.request('talk.mute', [null])).result.muted === true, 'talk.mute(null) reads back muted');
  ok((await c.request('talk.unmute')).result.muted === false, 'talk.unmute reads back unmuted');
  ok((await c.request('talk.sayEvent', ['nope'])).result === false, 'talk.sayEvent refuses an unlisted name');
  const names = new Set(sidecarHandlerNames(read('tauri', 'sidecar', 'main.mjs')));
  const step8a = ['talk.getTalkPrefs', 'talk.setTalkPrefs', 'talk.setVoiceEnabled', 'talk.setThinkSound', 'talk.setSpeakTypedWhenMicOff',
    'talk.sayReady', 'talk.sayAck', 'talk.sayEvent', 'talk.sayStatus', 'talk.mute', 'talk.unmute'];
  ok(step8a.length === 11 && step8a.every((n) => names.has(n)), 'all 11 step-8a names are in the sidecar handler table', step8a.filter((n) => !names.has(n)).join(','));
  await c.close();
}

{
  // A previous version recorded: sayReady enqueues the "updated" line, and it crosses as speech:say.
  const dir = path.join(work, 'updated');
  fs.mkdirSync(dir, { recursive: true });
  // Default quiet hours (22:30-07:30) stay ON: the sidecar's clock is pinned to local noon via --now-ms, so the
  // version line is not suppressed and the check never depends on the wall clock (the lane B workaround, 62ee895,
  // turned quiet hours off; the injected clock replaces it).
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ voiceEnabled: false, talkLevel: 'normal', talkLastVersion: '0.0.1' }, null, 2));
  const c = startSidecar(dir);
  await c.ready;
  ok((await c.request('__host.idle', [5])).result === true, '__host.idle is accepted before sayReady');
  ok((await c.request('talk.sayReady')).result === true, 'talk.sayReady answers true on a version change');
  await new Promise((r) => setTimeout(r, 50));
  const say = c.events.find((e) => e.channel === 'speech:say');
  ok(say && say.payload.kind === 'event' && typeof say.payload.sayId === 'string' && /9\.9\.9|\d+\.\d+\.\d+/.test(say.payload.text),
    'the real path emits one speech:say frame for the "updated" line', JSON.stringify(say));
  if (say) {
    ok((await c.request('talk.sayAck', [say.payload.sayId, true, null])).result.action === 'done',
      'the positional sayAck shape the Tauri shim sends closes the line (done)');
  }
  // The one allowed URL is step 10a's board-host build line (`[board-live] upstream <origin>`): it names the effective
  // upstream, is secret-free, and is not an egress made by this step. Every other stderr URL still fails.
  const stderrWithoutBoardOrigin = c.stderrText().split(/\r?\n/).filter((l) => !/^\[board-live\] upstream \S+$/.test(l)).join('\n');
  ok(!/https?:\/\//.test(stderrWithoutBoardOrigin), 'the sidecar stderr carries no URL outside the board upstream line (this step has no egress)');
  await c.close();
}

fs.rmSync(work, { recursive: true, force: true });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
