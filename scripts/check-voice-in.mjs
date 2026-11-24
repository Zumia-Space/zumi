// R4b "voice in" renderer side: the mic button and recorder (src/renderer/voice-in.js) and the Settings card
// (src/renderer/voice-in-card.js). Plain Node, no browser, no microphone: the recorder is injected, the document is a small fake.
//   node scripts/check-voice-in.mjs     (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { floatsToWav, initVoiceIn, mergeText, noticeText, toBase64, voiceAvailable } from '../src/renderer/voice-in.js';
import { cardAvailable, initVoiceCard, settingsFromForm } from '../src/renderer/voice-in-card.js';
import { TABLES, setLocale, t } from '../src/renderer/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ---- text: upstream appends the words to what was in the box, with one space ----
ok(mergeText('', 'xin chào') === 'xin chào', 'empty box: the words');
ok(mergeText('hello', 'world') === 'hello world', 'text in the box: a space, then the words');
ok(mergeText('hello ', 'world') === 'hello world', 'the box already ends in a space: no second one');

// ---- audio: 16 kHz mono 16-bit WAV, silence trimmed at both ends, nothing said = null ----
const sine = (rate, seconds, amp = 0.5) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin(i * 0.05) * amp);
const zeros = (rate, seconds) => new Float32Array(Math.round(rate * seconds));
const u32 = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24);
const u16 = (b, at) => b[at] | (b[at + 1] << 8);
{
  const wav = floatsToWav([zeros(48000, 0.5), sine(48000, 1), zeros(48000, 0.5)], 48000);
  ok(wav && String.fromCharCode(...wav.slice(0, 4)) === 'RIFF' && String.fromCharCode(...wav.slice(8, 12)) === 'WAVE', 'a WAV file');
  ok(wav && u16(wav, 22) === 1 && u32(wav, 24) === 16000 && u16(wav, 34) === 16, 'mono, 16 kHz, 16-bit');
  const samples = wav ? u32(wav, 40) / 2 : 0;
  ok(samples >= 16000 && samples <= 16000 + 2 * 3200, `the 2 s clip with 1 s of speech is trimmed to about 1 s (${samples} samples)`);
  ok(wav && wav.length === 44 + samples * 2, 'the header size matches the data');
  ok(floatsToWav([zeros(48000, 2)], 48000) === null, 'silence is null: nothing was said');
  ok(floatsToWav([], 48000) === null, 'no audio is null');
  ok(floatsToWav([sine(16000, 0.05)], 16000) === null, 'a click shorter than 0.15 s is not speech');
  const direct = floatsToWav([sine(16000, 1)], 16000);
  ok(direct && u32(direct, 40) / 2 >= 15000, 'already 16 kHz: kept as is');
}
ok(toBase64(Uint8Array.from([0, 1, 2, 250, 251, 252, 253])) === Buffer.from([0, 1, 2, 250, 251, 252, 253]).toString('base64'), 'base64 matches a reference encoder');
{
  const big = Uint8Array.from({ length: 1_000_003 }, (_, i) => i * 7);
  ok(toBase64(big) === Buffer.from(big).toString('base64'), 'a megabyte encodes the same (no call-stack limit)');
}

// ---- the controller on a fake document ----
function fakeDoc() {
  const byId = new Map();
  const dupes = []; // ids a script gave to an element while another element already held the id
  const mk = (tag) => {
    const listeners = {};
    let text = '';
    const el = {
      tag, children: [], dataset: {}, attrs: {}, hidden: false, className: '', title: '', value: '', placeholder: '', disabled: false, type: '', checked: false, _id: '',
      classList: { toggle(cls, on) { const set = new Set(el.className.split(' ').filter(Boolean)); if (on) set.add(cls); else set.delete(cls); el.className = [...set].join(' '); } },
      get id() { return el._id; }, set id(v) { if (byId.has(v) && byId.get(v) !== el) dupes.push(v); el._id = v; byId.set(v, el); },
      get textContent() { return text; }, set textContent(v) { text = String(v); if (v === '') el.children = []; },
      appendChild(ch) { ch.parentNode = el; el.children.push(ch); return ch; },
      insertBefore(ch, ref) { ch.parentNode = el; const i = el.children.indexOf(ref); el.children.splice(i < 0 ? el.children.length : i, 0, ch); return ch; },
      remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((x) => x !== el); if (el._id) byId.delete(el._id); },
      setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute(k) { return el.attrs[k]; },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      dispatchEvent(e) { for (const fn of listeners[e.type] || []) fn(e); return true; },
      async click() { for (const fn of listeners.click || []) await fn({}); },
      async change() { for (const fn of listeners.change || []) await fn({}); },
      focus() { el.focused = true; },
      all() { return [el, ...el.children.flatMap((x) => x.all())]; },
    };
    return el;
  };
  const composer = mk('footer'); composer.className = 'composer';
  const msg = mk('input'); msg.id = 'msg'; composer.appendChild(msg);
  const panel = mk('div'); panel.id = 'stabpanel-agent';
  const tab = mk('button'); tab.id = 'stab-agent';
  const doc = { createElement: mk, querySelector: (sel) => (sel === 'footer.composer' ? composer : null), defaultView: { Event: class { constructor(type) { this.type = type; } } } };
  return { doc, $: (id) => byId.get(id) || null, composer, msg, panel, tab, byId, dupes };
}

const STATE = { ok: true, engine: 'local', language: 'vi', keyEnv: null, baseUrl: null, model: null, whisperExe: 'C:/app/whisper/whisper-cli.exe', whisperModel: 'C:/m/ggml.bin', threads: 2, chord: 'ctrl-opt-space', keySet: false, ready: true, error: null, hotkey: 'on', busy: false,
  engines: ['local', 'fish', 'elevenlabs', 'deepseek', 'openai', 'groq'], chords: [{ id: 'ctrl-opt-space', label: 'Ctrl+Alt+Space' }, { id: 'ctrl-shift-space', label: 'Ctrl+Shift+Space' }], keyEnvNames: { providers: { fish: ['FISH_API_KEY'], elevenlabs: ['ELEVENLABS_API_KEY'], deepseek: ['DEEPSEEK_API_KEY'], openai: ['OPENAI_API_KEY'], groq: ['GROQ_API_KEY'] }, user: 'ZUMI_STT_API_KEY' }, exeName: 'whisper-cli.exe', exeDirs: ['C:/app/whisper'] };

function fakeZumi() {
  const bus = [];
  const calls = [];
  const z = {
    calls, state: { ...STATE }, setResult: null, audioResult: { ok: true },
    emit(e) { bus.forEach((cb) => cb(e)); },
    stt: {
      onEvent(cb) { bus.push(cb); return () => bus.splice(bus.indexOf(cb), 1); },
      async state() { calls.push(['state']); return z.state; },
      async set(s) { calls.push(['set', s]); return z.setResult || { ...z.state, ok: true }; },
      async ptt(phase) { calls.push(['ptt', phase]); return { ok: true }; },
      async audio(b64) { calls.push(['audio', b64]); return z.audioResult; },
      async install(...a) { calls.push(['install', ...a]); return z.installResult || { ok: true }; },
    },
  };
  return z;
}
function fakeRecorder({ failStart = false, audio = [sine(16000, 1)], rate = 16000 } = {}) {
  const r = { started: 0, stopped: 0, cancelled: 0,
    async start() { r.started++; if (failStart) throw new Error('NotAllowedError'); },
    async stop() { r.stopped++; return { chunks: audio, rate }; },
    cancel() { r.cancelled++; } };
  return r;
}

setLocale('en');
ok(voiceAvailable({ stt: { state() {}, onEvent() {}, ptt() {}, audio() {} } }) && !voiceAvailable({}) && !voiceAvailable({ stt: { state() {} } }) && !voiceAvailable(null), 'voiceAvailable needs the four methods and the event');
{
  const f = fakeDoc();
  ok(initVoiceIn({ talk: {} }, f.$, { doc: f.doc, t, apply: () => {}, makeRecorder: () => fakeRecorder() }) === null && f.$('voice-mic') === null, 'without the stt API (Electron) nothing is built');
}
{
  const f = fakeDoc(); const z = fakeZumi(); const rec = fakeRecorder();
  const ctl = initVoiceIn(z, f.$, { doc: f.doc, t, apply: () => {}, makeRecorder: () => rec });
  ok(ctl !== null && f.$('voice-mic') && f.$('stt-status'), 'the mic button and the status line are built');
  ok(initVoiceIn(z, f.$, { doc: f.doc, t, apply: () => {}, makeRecorder: () => rec }) === null, 'a second init builds nothing');
  ok(f.composer.children.includes(f.$('voice-mic')), 'the button sits in the composer');

  // click, host says start, speak, click, host says stop, the page hands in the WAV, the host sends the words
  f.msg.value = 'note:';
  await f.$('voice-mic').click();
  ok(z.calls.some((c) => c[0] === 'ptt' && c[1] === 'press'), 'a click on the button presses push-to-talk through the host (one flow with the hotkey)');
  z.emit({ ev: 'start' });
  await tick();
  ok(rec.started === 1 && f.$('voice-mic').attrs['aria-pressed'] === 'true', 'the recorder starts only when the HOST says start');
  await f.$('voice-mic').click();
  ok(z.calls.filter((c) => c[0] === 'ptt').pop()[1] === 'release', 'the second click releases');
  z.emit({ ev: 'stop' });
  await tick(20);
  const audio = z.calls.find((c) => c[0] === 'audio');
  ok(rec.stopped === 1 && audio && Buffer.from(audio[1], 'base64').subarray(0, 4).toString() === 'RIFF', 'on stop the page sends the recorded WAV (base64) to the host');
  ok(f.$('voice-mic').attrs['aria-pressed'] === 'false', 'the button is off again');
  z.emit({ ev: 'text', text: 'xin chào' });
  ok(f.msg.value === 'note: xin chào', 'the words land in the chat input after what was there');
  ok(f.msg.focused === true, 'the input is focused');

  // the person typed while it was listening: the words are dropped (upstream cancels)
  f.msg.value = ''; z.emit({ ev: 'start' }); await tick();
  f.msg.value = 'typed meanwhile';
  z.emit({ ev: 'text', text: 'ignored words' });
  ok(f.msg.value === 'typed meanwhile', 'text typed during dictation is never overwritten');
  z.emit({ ev: 'cancel' });
  ok(rec.cancelled >= 1, 'cancel throws the recording away');

  // cancelling while the engine works (after the release, before the words): the mic click or Esc dismisses in the host, and the
  // host's `dictation_cancelled` notice is shown in words (it used to vanish silently)
  const before = z.calls.filter((c) => c[0] === 'ptt').length;
  f.msg.value = '';
  await f.$('voice-mic').click(); // press
  z.emit({ ev: 'start' }); await tick();
  await f.$('voice-mic').click(); // release
  z.emit({ ev: 'stop' }); await tick(20);
  await f.$('voice-mic').click(); // while the engine hears: a cancel, not a second press
  ok(z.calls.filter((c) => c[0] === 'ptt').slice(before).map((c) => c[1]).join() === 'press,release,dismiss', 'a click on the mic while the words are being worked out dismisses (not a second press)', z.calls.filter((c) => c[0] === 'ptt').slice(before).map((c) => c[1]).join());
  z.emit({ ev: 'notice', code: 'dictation_cancelled' });
  ok(f.$('stt-status').textContent === t('voice.err.dictation_cancelled') && f.$('stt-status').hidden === false && !/\(/.test(f.$('stt-status').textContent), 'the cancel is said in words');
  f.msg.value = '';
  await f.$('voice-mic').click(); z.emit({ ev: 'start' }); await tick();
  await f.$('voice-mic').click(); z.emit({ ev: 'stop' }); await tick(20);
  const n2 = z.calls.filter((c) => c[0] === 'ptt').length;
  f.msg.dispatchEvent({ type: 'keydown', key: 'Escape' });
  await tick(10);
  ok(z.calls.filter((c) => c[0] === 'ptt').slice(n2).map((c) => c[1]).join() === 'dismiss', 'Esc in the box while the words are being worked out dismisses');
  z.emit({ ev: 'text', text: 'late' });
  f.msg.dispatchEvent({ type: 'keydown', key: 'Escape' }); await tick(10);
  ok(z.calls.filter((c) => c[0] === 'ptt').length === n2 + 1, 'Esc with nothing under way sends nothing (the person is just typing)');

  z.emit({ ev: 'notice', code: 'stt_key_rejected' });
  ok(f.$('stt-status').textContent.length > 0 && f.$('stt-status').hidden === false, 'a notice is shown in words');
  ok(noticeText('stt_key_rejected', t) !== noticeText('stt_network', t) && noticeText('zzz_unknown', t).includes('zzz_unknown'), 'each known code has its own words; an unknown one is shown as is');
}
{
  // silence: the host still gets an answer (a silent clip), never a hang
  const f = fakeDoc(); const z = fakeZumi(); const rec = fakeRecorder({ audio: [zeros(16000, 2)] });
  initVoiceIn(z, f.$, { doc: f.doc, t, apply: () => {}, makeRecorder: () => rec });
  z.emit({ ev: 'start' }); await tick();
  z.emit({ ev: 'stop' }); await tick(20);
  const audio = z.calls.find((c) => c[0] === 'audio');
  ok(audio && Buffer.from(audio[1], 'base64').subarray(0, 4).toString() === 'RIFF', 'nothing said: a short silent WAV is still handed in');
}
{
  // microphone refused
  const f = fakeDoc(); const z = fakeZumi(); const rec = fakeRecorder({ failStart: true });
  initVoiceIn(z, f.$, { doc: f.doc, t, apply: () => {}, makeRecorder: () => rec });
  z.emit({ ev: 'start' }); await tick(20);
  ok(z.calls.some((c) => c[0] === 'ptt' && c[1] === 'dismiss'), 'a refused microphone dismisses the flow in the host');
  ok(f.$('stt-status').textContent === t('voice.err.mic'), 'and says so');
  ok(f.$('voice-mic').attrs['aria-pressed'] === 'false', 'the button is not stuck on');
}
{
  // text/stop with nothing recorded by this page (a second window, a late event): harmless
  const f = fakeDoc(); const z = fakeZumi(); const rec = fakeRecorder();
  initVoiceIn(z, f.$, { doc: f.doc, t, apply: () => {}, makeRecorder: () => rec });
  z.emit({ ev: 'stop' }); await tick(10);
  ok(z.calls.some((c) => c[0] === 'audio'), 'a stop without a start is still answered (never a hang in the host), and does not throw');
  z.emit({ ev: 'bogus' }); z.emit(null); z.emit({ ev: 'text' }); z.emit({ ev: 'text', text: 5 });
  ok(f.msg.value === '', 'malformed events change nothing');
}

// ---- Settings card ----
ok(cardAvailable({ stt: { state() {}, set() {} } }) && !cardAvailable({}), 'the card needs stt.state and stt.set');
ok(sorted(settingsFromForm({ engine: 'local', language: 'vi', keyEnv: 'OPENAI_API_KEY', baseUrl: 'https://x', model: 'm', whisperExe: 'C:/a/whisper-cli.exe', whisperModel: 'C:/m.bin', threads: '2', chord: 'ctrl-opt-space' }))
  === sorted({ engine: 'local', language: 'vi', whisperExe: 'C:/a/whisper-cli.exe', whisperModel: 'C:/m.bin', threads: 2, chord: 'ctrl-opt-space' }), 'the local engine sends the program, the model and the thread count, no key fields');
ok(sorted(settingsFromForm({ engine: 'openai', language: 'auto', keyEnv: 'OPENAI_API_KEY', baseUrl: '', model: '', whisperExe: 'C:/x', whisperModel: 'C:/y', threads: '4', chord: 'ctrl-shift-space' }))
  === sorted({ engine: 'openai', keyEnv: 'OPENAI_API_KEY', chord: 'ctrl-shift-space' }), 'an API engine sends the key variable NAME and no program fields; empty fields are left out');
ok(JSON.stringify(settingsFromForm({ engine: '' })) === '{}', 'no engine = voice off = {}');
{
  const f = fakeDoc(); const z = fakeZumi();
  const card = await initVoiceCard(z, f.$, { doc: f.doc, t, apply: () => {} });
  ok(card !== null && f.$('stt-card') && f.$('voice-engine') && f.$('voice-save') && f.$('voice-chord') && f.$('voice-keyenv') && f.$('voice-exe'), 'the card is built into the Agent tab');
  ok(f.$('voice-engine').value === 'local' && f.$('voice-exe').value === 'C:/app/whisper/whisper-cli.exe' && f.$('voice-chord').value === 'ctrl-opt-space', 'it shows what the host says is set');
  const fields = f.panel.all().filter((e) => e.tag === 'input');
  ok(fields.every((e) => e.type !== 'password') && !fields.some((e) => /key$/i.test(e._id) && e.type !== 'select'), 'there is no field that takes a key value: the key stays in the environment');
  f.$('voice-engine').value = 'openai'; await f.$('voice-engine').change();
  f.$('voice-keyenv').value = 'OPENAI_API_KEY';
  await f.$('voice-save').click();
  const set = z.calls.find((c) => c[0] === 'set');
  ok(set && sorted(set[1]) === sorted({ engine: 'openai', keyEnv: 'OPENAI_API_KEY', language: 'vi', chord: 'ctrl-opt-space' }), 'Save sends the form to stt.set', JSON.stringify(set));
  z.setResult = { ok: false, error: 'stt_policy_key' };
  await f.$('voice-save').click();
  ok(/stt_policy_key|key/i.test(f.$('voice-card-status').textContent) && f.$('voice-card-status').textContent !== '', 'a refused setting shows its reason');
}
{
  const f = fakeDoc();
  ok((await initVoiceCard({ talk: {} }, f.$, { doc: f.doc, t, apply: () => {} })) === null, 'no stt API: no card');
}

// ---- first-use install of the local engine (R4c) ----
const INSTALL = { state: 'idle', phase: '', item: '', done: 0, total: 0, code: null, installed: false, unpublished: [],
  items: [{ id: 'model', file: 'ggml-small-q5_1.bin', bytes: 190085487, disk: 190085487 }, { id: 'program', file: 'whisper-bin-x64.zip', bytes: 8928640, disk: 11603968 }],
  downloadBytes: 199014127, diskBytes: 201689455,
  optionalModel: { id: 'model', file: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574041195, disk: 574041195, slowWithoutGpu: true }, optionalDownloadBytes: 582969835, optionalDiskBytes: 585645163, optionalInstalled: false,
  paths: { exe: 'C:/data/whisper/whisper-cli.exe', model: 'C:/data/whisper/ggml-small-q5_1.bin' } };
setLocale('en');
{
  const f = fakeDoc(); const z = fakeZumi(); z.state = { ...STATE, engine: '', whisperExe: null, whisperModel: null, install: { ...INSTALL } };
  await initVoiceCard(z, f.$, { doc: f.doc, t, apply: () => {} });
  ok(f.$('voice-install') && f.$('voice-install-btn') && f.$('voice-install-size') && f.$('voice-install-progress') && f.$('voice-install-status'), 'the card has the install block');
  const size = f.$('voice-install-size').textContent;
  ok(/190 MB/.test(size) && /12 MB/.test(size), 'the size is shown before any click: the default model about 190 MB and the program about 12 MB', size);
  // R4d: the larger model is an optional download; both sizes are on the card before anything is installed, with the slow-without-GPU warning.
  ok(f.$('voice-install-large-btn') && f.$('voice-install-large-note'), 'the card has the optional large-model button and its note');
  const big = f.$('voice-install-large-note').textContent;
  ok(/574 MB/.test(big) && /large-v3-turbo/.test(big) && /GPU|graphics card/i.test(big) && /slow/i.test(big), 'the larger model: its size and the warning that it is slow without a GPU', big);
  ok(/190 MB/.test(size) && /574 MB/.test(size + ' ' + big), 'both model sizes are visible before install');
  ok(!z.calls.some((c) => c[0] === 'install'), 'looking at the card installs nothing');
  ok(f.$('voice-install-btn').disabled === false && f.$('voice-install-cancel').hidden === true && f.$('voice-install-progress').hidden === true, 'the button is there; no cancel and no progress yet');
  await f.$('voice-install-btn').click();
  ok(JSON.stringify(z.calls.filter((c) => c[0] === 'install')) === '[["install","start"]]', 'one click starts the install');
  z.emit({ ev: 'install', phase: 'download', item: 'model', done: 287020597, total: 574041195, code: null });
  const bar = f.$('voice-install-progress');
  ok(bar.hidden === false && Math.round((Number(bar.value) / Number(bar.max)) * 100) === 50, 'the progress bar shows 50%');
  ok(/50%/.test(f.$('voice-install-status').textContent), 'and the words say so', f.$('voice-install-status').textContent);
  ok(f.$('voice-install-btn').disabled === true && f.$('voice-install-large-btn').disabled === true && f.$('voice-install-cancel').hidden === false, 'while it runs: no second start (either button), and a cancel');
  await f.$('voice-install-cancel').click();
  ok(z.calls.some((c) => c[0] === 'install' && c[1] === 'cancel'), 'cancel is sent to the host');
  z.emit({ ev: 'install', phase: 'failed', item: '', done: 0, total: 0, code: 'stt_cancelled' });
  await tick();
  await f.$('voice-install-large-btn').click();
  ok(JSON.stringify(z.calls.filter((c) => c[0] === 'install').pop()) === '["install","start","large"]', 'the large-model button asks for the larger model by name');
  z.emit({ ev: 'install', phase: 'failed', item: '', done: 0, total: 0, code: 'stt_install_hash' });
  await tick();
  ok(/checksum/i.test(f.$('voice-install-status').textContent) && f.$('voice-install-btn').disabled === false && f.$('voice-install-progress').hidden === true, 'a failure says why in words and allows another try');
  // Done: the installed files go in the form and Local is chosen; nothing is saved until the owner presses Save.
  z.state = { ...z.state, install: { ...INSTALL, state: 'done', installed: true } };
  const savedBefore = z.calls.filter((c) => c[0] === 'set').length;
  z.emit({ ev: 'install', phase: 'done', item: '', done: 0, total: 0, code: null });
  await tick(20);
  ok(f.$('voice-engine').value === 'local' && f.$('voice-exe').value === INSTALL.paths.exe && f.$('voice-wmodel').value === INSTALL.paths.model, 'when it is done the installed files are in the form and Local is chosen');
  ok(z.calls.filter((c) => c[0] === 'set').length === savedBefore, 'nothing is saved until the owner presses Save');
  ok(f.$('voice-install-btn').disabled === true && /installed/i.test(f.$('voice-install-status').textContent), 'installed: the button is off and the card says so');
}
{
  const f = fakeDoc(); const z = fakeZumi();
  z.state = { ...STATE, install: { ...INSTALL, items: [INSTALL.items[0]], downloadBytes: 190085487, diskBytes: 190085487, unpublished: ['program'] } };
  await initVoiceCard(z, f.$, { doc: f.doc, t, apply: () => {} });
  ok(f.$('voice-install-btn').disabled === true && f.$('voice-install-large-btn').disabled === true && f.$('voice-install-note').textContent !== '', 'no published program: both buttons are off and the card says why');
  await f.$('voice-install-btn').click();
  ok(!z.calls.some((c) => c[0] === 'install'), 'a click on the disabled button asks nothing');
}
{
  const f = fakeDoc(); const z = fakeZumi();
  z.state = { ...STATE, engine: 'local', localRuntime: 'missing', install: { ...INSTALL, installed: true, state: 'done' } };
  await initVoiceCard(z, f.$, { doc: f.doc, t, apply: () => {} });
  const chosen = f.$('voice-engine').value;
  ok(chosen !== 'local' && chosen !== '', 'the program cannot start here: an online engine is offered instead', chosen);
  ok(/Visual C\+\+/.test(f.$('voice-install-status').textContent) && /Vulkan/.test(f.$('voice-install-status').textContent), 'the message names the runtime and the graphics driver, and that Zumi does not install them');
  ok(!z.calls.some((c) => c[0] === 'set' || c[0] === 'install'), 'nothing is saved or installed by itself');
}
{
  const f = fakeDoc(); const z = fakeZumi();
  z.state = { ...STATE, engine: 'openai', keyEnv: 'OPENAI_API_KEY', localRuntime: 'missing' };
  await initVoiceCard(z, f.$, { doc: f.doc, t, apply: () => {} });
  ok(f.$('voice-engine').value === 'openai', 'an online engine the owner already chose is left alone');
  ok(f.$('voice-install') === null || f.$('voice-install').hidden === true || !f.$('voice-install-btn'), 'a host without install info shows no install block');
}
for (const lang of ['en', 'vi', 'zh']) {
  const want = ['download', 'verify', 'unpack', 'check'].map((p) => `voice.install.phase.${p}`).concat(['voice.install.large.button', 'voice.install.large.note'])
    .concat(['stt_local_runtime_missing', 'stt_install_network', 'stt_install_http', 'stt_install_redirect', 'stt_install_hash', 'stt_install_size', 'stt_install_write', 'stt_install_unpack', 'stt_install_busy', 'stt_install_unpublished', 'stt_cancelled', 'dictation_cancelled'].map((c) => `voice.err.${c}`));
  const missing = want.filter((k) => !(k in TABLES[lang]));
  ok(missing.length === 0, `${lang}: the install phases and failure codes have words`, missing.join(', '));
  const same = want.filter((k) => lang !== 'en' && TABLES[lang][k] === TABLES.en[k]);
  ok(same.length === 0, `${lang}: they are translated, not copied from English`, same.join(', '));
}
for (const code of ['stt_local_runtime_missing', 'stt_install_network', 'stt_install_http', 'stt_install_redirect', 'stt_install_hash', 'stt_install_size', 'stt_install_write', 'stt_install_unpack', 'stt_install_busy', 'stt_install_unpublished', 'stt_cancelled', 'dictation_cancelled']) {
  ok(!/\(/.test(noticeText(code, t)) || /Visual C\+\+/.test(noticeText(code, t)), `${code} is a known word, not "did not work (code)"`);
}
{
  // Only the Settings card names stt.install: no other renderer file can start a download.
  const renderer = fs.readdirSync(path.join(ROOT, 'src/renderer')).filter((n) => n.endsWith('.js'));
  const callers = renderer.filter((n) => /stt\.install\(/.test(fs.readFileSync(path.join(ROOT, 'src/renderer', n), 'utf8')));
  ok(callers.join(',') === 'voice-in-card.js', 'voice-in-card.js is the only renderer file that calls stt.install', callers.join(','));
}

// ---- strings, markup, wiring ----
const files = ['voice-in.js', 'voice-in-card.js'].map((n) => [n, fs.readFileSync(path.join(ROOT, 'src/renderer', n), 'utf8')]);
for (const [n, src] of files) {
  ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(src.replace(/\/\/.*$/gm, '')), `${n} never sets markup (textContent only)`);
  const used = new Set([...src.matchAll(/['"`](voice\.[A-Za-z_.]+)['"`]/g)].map((m) => m[1]));
  for (const lang of ['en', 'vi', 'zh']) {
    const missing = [...used].filter((k) => !(k in TABLES[lang]));
    ok(missing.length === 0, `${n} ${lang}: every voice.* key is translated`, missing.join(', '));
  }
}
const codes = ['stt_not_configured', 'stt_key_missing', 'stt_key_rejected', 'stt_balance', 'stt_rate_limited', 'stt_network', 'stt_timeout', 'stt_audio_missing', 'stt_local_missing', 'stt_local_failed', 'stt_local_timeout', 'stt_hotkey_taken', 'stt_policy_exe', 'stt_policy_key', 'stt_policy_origin', 'stt_policy_model', 'stt_settings_bad', 'stt_not_owner'];
for (const lang of ['en', 'vi', 'zh']) {
  const missing = codes.filter((c) => !(`voice.err.${c}` in TABLES[lang]));
  ok(missing.length === 0, `${lang}: the notice codes have words`, missing.join(', '));
}
const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
ok(/import \{ initVoiceIn \} from '\.\/voice-in\.js';/.test(app) && /initVoiceIn\(zumi, \$\)/.test(app), 'app.js imports and starts the composer part');
ok(/import \{ initVoiceCard \} from '\.\/voice-in-card\.js';/.test(app) && /initVoiceCard\(zumi, \$\)/.test(app), 'app.js imports and starts the Settings card');
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
for (const sel of ['.voice-mic', '.voice-mic.on', '.voice-status']) ok(css.includes(sel), `styles.css has ${sel}`);

// ---- the REAL index.html: both Settings cards mount (R4h: the TTS card owned id="voice-card", so the Voice in card returned early) ----
{
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const f = fakeDoc(); const z = fakeZumi();
  const realIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  ok(realIds.includes('voice-card') && realIds.includes('stabpanel-agent'), 'index.html has the TTS card (voice-card) and the Agent panel');
  for (const id of realIds) {
    if (f.$(id)) continue; // the fake already owns stabpanel-agent
    const e = f.doc.createElement('div'); e.id = id;
  }
  const ttsCard = f.$('voice-card');
  const card = await initVoiceCard(z, f.$, { doc: f.doc, t, apply: () => {} });
  ok(card !== null, 'the Voice in card mounts into the real Agent tab');
  ok(f.$('voice-card') === ttsCard, 'the TTS card keeps id voice-card');
  ok(f.$('stt-card') && f.$('stt-card') !== ttsCard && f.$('stt-card').tag === 'section', 'the Voice in card is its own element, id stt-card');
  ok(f.dupes.length === 0, 'no id the Voice in card creates is already in index.html', f.dupes.join(', '));
  // R4i: the composer mic part runs BEFORE initSettings in app.js and must not take an id index.html already has
  const settingsLine = f.$('voice-status');
  const mic = initVoiceIn(z, f.$, { doc: f.doc, t, apply: () => {}, makeRecorder: () => fakeRecorder() });
  ok(mic !== null, 'the composer mic part mounts on the real page');
  ok(f.dupes.length === 0, 'no id the mic part or the card creates is already in index.html', f.dupes.join(', '));
  ok(f.$('voice-status') === settingsLine, 'the Settings English-voice line still owns id voice-status after the mic part mounts');
  for (const lang of ['en', 'vi', 'zh']) {
    const text = TABLES[lang]['voice.err.stt_cancelled'] || '';
    ok(text !== '' && !/kept|continues from it|giữ lại|chạy tiếp|保留|继续/.test(text), `${lang}: the cancel text does not say the download is kept (cancel deletes the .part)`, text);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
