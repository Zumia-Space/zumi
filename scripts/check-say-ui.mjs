// The stage side of "how much Zumi talks" (T-31 talk-mode inc 3, PLAN 5.2): src/renderer/talk/say.js under plain Node
// with fakes -- no Electron, no window, no audio device, no network. Covers the one-click mute (button, right-click /
// long-press menu, Ctrl+Shift+M), delivering a line (subtitle, voice, mood gesture, ack), the fixed-line audio cache,
// and the static wiring (markup, preload, main IPC, app.js) so a refactor cannot silently drop a piece.
//   node scripts/check-say-ui.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSay, initSay, nextClockTime } from '../src/renderer/talk/say.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------- fakes ----------
const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

function makeHarness({ level = 'normal', muted = false, muteUntil = null, busy = false, ttsResult = null, quietEnd = '07:30' } = {}) {
  const log = { ack: [], tts: [], mute: [], unmute: 0, setTalk: [], events: [], line: [], hide: 0, paint: [], menu: 0, played: [], gestures: [], stops: 0, prepared: [], appended: [] };
  const state = { level, muted, muteUntil, busy };
  const moreHandlers = new Map();
  const timers = [];
  const talk = {
    sayAck: async (id, spoken, reason) => { log.ack.push({ id, spoken, reason }); return {}; },
    sayStatus: async () => ({ level: state.level, muted: state.muted, muteUntil: state.muteUntil }),
    getTalkPrefs: async () => ({ talkLevel: state.level, talkQuietHours: { on: true, start: '22:30', end: quietEnd } }),
    setTalkPrefs: async (p) => { log.setTalk.push(p); if (p.talkLevel) state.level = p.talkLevel; return p; },
    mute: async (until) => { log.mute.push(until); state.muted = true; state.muteUntil = until; return {}; },
    unmute: async () => { log.unmute++; state.muted = false; state.muteUntil = null; return {}; },
    sayEvent: async (name) => { log.events.push(name); return true; },
    tts: async (p) => { log.tts.push(p); return typeof ttsResult === 'function' ? ttsResult(p) : (ttsResult || { ok: true, mime: 'audio/mpeg', audios: [new Uint8Array([1, 2, 3])] }); },
    onTtsMore: (turnId, cb) => { moreHandlers.set(turnId, cb); return () => moreHandlers.delete(turnId); },
  };
  let resolveEnded;
  const speech = {
    speaking: () => false,
    stop: () => { log.stops++; if (resolveEnded) resolveEnded('stopped'); },
    prepare: async (bufs) => { log.prepared.push(bufs.length); return { durationMs: 1500, start: () => { log.played.push(1); return { ended: new Promise((r) => { resolveEnded = r; }) }; } }; },
    append: async (a) => { log.appended.push(a); return true; },
  };
  const library = { pick: (mood) => ({ command: { id: `cmd-${mood}` } }) };
  const engine = { playCommand: (cmd, source, opts) => { log.gestures.push({ id: cmd.id, source, label: opts.labelVi }); return { ok: true }; } };
  const ui = {
    showLine: (text, ms) => log.line.push({ text, ms }), hideLine: () => { log.hide++; },
    paintMute: (s) => log.paint.push(s), openMenu: () => { log.menu++; },
  };
  const clock = { now: new Date(2026, 9, 19, 13, 0, 0).getTime() };
  const say = createSay({
    zumi: { talk }, speech, library, engine, isBusy: () => state.busy, t, ui, now: () => clock.now,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  });
  const finishPlayback = (how = 'ended') => resolveEnded && resolveEnded(how);
  return { say, log, state, talk, speech, ui, clock, timers, moreHandlers, finishPlayback };
}
const voiced = (o = {}) => ({ sayId: 's1', kind: 'ask', text: 'A task needs your answer.', show: 'Avatar needs your answer: pick a level.', voice: true, lang: 'en', mood: 'point-screen', ...o });

// ---------- 1. nextClockTime ----------
{
  const noon = new Date(2026, 9, 19, 12, 0, 0).getTime();
  const a = new Date(nextClockTime('07:30', noon));
  ok(a.getDate() === 20 && a.getHours() === 7 && a.getMinutes() === 30, 'nextClockTime: 07:30 after noon is tomorrow 07:30', a.toString());
  const early = new Date(2026, 9, 19, 5, 0, 0).getTime();
  const b = new Date(nextClockTime('07:30', early));
  ok(b.getDate() === 19 && b.getHours() === 7, 'nextClockTime: 07:30 before 05:00 is today 07:30', b.toString());
  ok(new Date(nextClockTime('nope', noon)).getHours() === 7, 'nextClockTime: a bad value falls back to 07:30');
  ok(nextClockTime('12:00', noon) > noon, 'nextClockTime: the same minute is the NEXT day (strictly after now)');
}

// ---------- 2. delivering a line ----------
{
  // subtitle-only
  const h = makeHarness();
  await h.say.onSay(voiced({ voice: false, text: '', sayId: 'sub' }));
  ok(h.log.line.length === 1 && h.log.line[0].text === 'Avatar needs your answer: pick a level.' && h.log.tts.length === 0, 'line: a subtitle-only line is shown and never synthesised', h.log);
  ok(h.log.ack[0].id === 'sub' && h.log.ack[0].spoken === false && h.log.ack[0].reason === 'subtitle', 'line: a subtitle-only line is acked as unspoken');
  ok(h.log.line[0].ms >= 4000, 'line: a subtitle stays at least 4 s', h.log.line[0]);
}
{
  // spoken
  const h = makeHarness();
  const p = h.say.onSay(voiced());
  await tick(5);
  ok(h.log.tts.length === 1 && h.log.tts[0].sayId === 's1' && h.log.tts[0].text === 'A task needs your answer.', 'line: a voiced line is synthesised with its sayId (main authorises it by id)', h.log.tts);
  ok(h.log.line[0].text === 'Avatar needs your answer: pick a level.' && h.log.line[0].ms >= 1500 + 800, 'line: the SUBTITLE shows the full text and lasts the audio length plus a tail', h.log.line[0]);
  ok(h.log.gestures.length === 1 && h.log.gestures[0].id === 'cmd-point-screen' && h.log.gestures[0].source === 'speech', 'line: the mood plays a speech-library gesture', h.log.gestures);
  ok(h.log.ack[0].spoken === true && h.log.ack[0].reason === 'spoken', 'line: acked as spoken once playback starts');
  ok(h.say._test.owns() === true, 'line: the module owns playback while its line plays');
  h.finishPlayback('ended');
  await p;
  ok(h.say._test.owns() === false && h.say._test.current() === null, 'line: ownership ends with the audio');
}
{
  // busy (a reply is in flight): no tts, no subtitle, ack busy
  const h = makeHarness({ busy: true });
  await h.say.onSay(voiced());
  ok(h.log.tts.length === 0 && h.log.line.length === 0 && h.log.ack[0].reason === 'busy' && h.log.ack[0].spoken === false, 'busy: never over a reply -- no synthesis, no subtitle, ack busy (a P1 ask is re-held by main)', h.log);
}
{
  // a reply started while synthesising
  const h = makeHarness({ ttsResult: (p) => { h.state.busy = true; return { ok: true, mime: 'audio/mpeg', audios: [new Uint8Array([1])] }; } });
  await h.say.onSay(voiced());
  ok(h.log.played.length === 0 && h.log.line.length === 0 && h.log.ack[0].reason === 'busy', 'busy: a reply that starts during synthesis wins -- the line is handed back, not played', h.log);
}
{
  // failures fall back to a subtitle (never silence)
  for (const [name, res, reason] of [['typed error', { ok: false, error: { code: 'rate_limited' } }, 'rate_limited'], ['no-key empty audio', { ok: true, audios: [], reason: 'no-google-key' }, 'no-google-key'], ['voice-off-lang', { ok: true, audios: [], reason: 'voice-off-lang' }, 'voice-off-lang']]) {
    const h = makeHarness({ ttsResult: res });
    await h.say.onSay(voiced());
    ok(h.log.line.length === 1 && h.log.ack[0].spoken === false && h.log.ack[0].reason === reason && h.log.played.length === 0, `failure: ${name} -> the line shows as text and is acked with the reason`, h.log);
  }
  const h = makeHarness({ ttsResult: () => { throw new Error('ipc closed'); } });
  await h.say.onSay(voiced());
  ok(h.log.line.length === 1 && h.log.ack[0].spoken === false, 'failure: a thrown IPC error also ends as a subtitle');
}
{
  // stray / malformed input
  const h = makeHarness();
  await h.say.onSay(null); await h.say.onSay({}); await h.say.onSay({ sayId: 5 });
  ok(h.log.ack.length === 0 && h.log.tts.length === 0, 'line: a malformed message is ignored');
}
{
  // streamed sentence 2+ (Kokoro): chunks before and after the start are appended, and the whole line is cached
  const h = makeHarness();
  const p = h.say.onSay(voiced({ sayId: 'k1', text: 'Hello. Again.' }));
  h.moreHandlers.get('k1')(new Uint8Array([9])); // arrives before tts resolves
  await tick(5);
  h.moreHandlers.get('k1')(new Uint8Array([8])); // arrives while playing
  h.finishPlayback('ended');
  await p;
  ok(h.log.appended.length === 2, 'stream: sentence 2+ chunks are appended, whether they arrive before or after playback starts', h.log.appended);
  ok(h.say._test.cache().get('en|Hello. Again.').length === 3, 'stream: the cache holds the WHOLE line (first chunk plus streamed ones)');
  ok(h.moreHandlers.size === 0, 'stream: the stream subscription is released');
}

// ---------- 3. fixed-line audio cache ----------
{
  const h = makeHarness();
  const run = async (id, text, how = 'ended') => { const p = h.say.onSay(voiced({ sayId: id, text, show: text })); await tick(3); h.finishPlayback(how); await p; };
  await run('c1', 'Mm?');
  await run('c2', 'Mm?');
  ok(h.log.tts.length === 1 && h.log.played.length === 2, 'cache: the same text is synthesised once and played twice (no second paid call)', { tts: h.log.tts.length, played: h.log.played.length });
  h.say.clearCache();
  await run('c3', 'Mm?');
  ok(h.log.tts.length === 2, 'cache: clearCache (a voice setting changed) forces a fresh synthesis');
  for (let i = 0; i < 30; i++) await run(`l${i}`, `line number ${i}`);
  ok(h.say._test.cache().size === 24, 'cache: at most 24 entries (LRU)', h.say._test.cache().size);
  await run('x1', 'cut short', 'stopped');
  ok(!h.say._test.cache().has('en|cut short'), 'cache: a line cut short by mute is not cached truncated');
  await run('d1', 'Dạ?'); // another language key
  const hv = makeHarness();
  const pv = hv.say.onSay(voiced({ sayId: 'v', lang: 'vi', text: 'Dạ?' })); await tick(3); hv.finishPlayback(); await pv;
  ok(hv.say._test.cache().has('vi|Dạ?'), 'cache: keyed by language and text');
}

// ---------- 4. mute ----------
{
  const h = makeHarness({ level: 'normal' });
  await h.say.refresh();
  ok(h.log.paint.at(-1).muted === false && h.log.paint.at(-1).title === 'stage.mute.title', 'mute: unmuted button reads "Mute"', h.log.paint.at(-1));
  await h.say.toggleMute();
  ok(h.log.mute.length === 1 && h.log.mute[0] === null && h.log.paint.at(-1).muted === true && h.log.paint.at(-1).title === 'stage.mute.muted', 'mute: a click mutes until unmuted and repaints', h.log.paint.at(-1));
  await h.say.toggleMute();
  ok(h.log.unmute === 1 && h.log.paint.at(-1).muted === false, 'mute: a second click unmutes');
}
{
  // muting stops THIS module's playing line, never a reply
  const h = makeHarness();
  const p = h.say.onSay(voiced()); await tick(5);
  await h.say.refresh();
  await h.say.toggleMute();
  await p;
  ok(h.log.stops === 1 && h.say._test.owns() === false, 'mute: a click stops the line Zumi is speaking on her own (speech.stop once)', h.log.stops);
  const r = makeHarness();
  await r.say.refresh();
  await r.say.toggleMute();
  ok(r.log.stops === 0, 'mute: with a REPLY playing (not ours) the click never calls speech.stop');
}
{
  // muted mid-synthesis: nothing plays
  let release;
  const h = makeHarness({ ttsResult: () => new Promise((res) => { release = () => res({ ok: true, audios: [new Uint8Array([1])] }); }) });
  const p = h.say.onSay(voiced()); await tick(5);
  await h.say.refresh(); await h.say.toggleMute();
  release(); await p;
  ok(h.log.played.length === 0 && h.log.ack[0].spoken === false && h.log.ack[0].reason === 'muted', 'mute: muting while a line is still being synthesised drops it (acked muted)', h.log.ack);
}
{
  const off = makeHarness({ level: 'off' });
  await off.say.refresh();
  ok(off.log.paint.at(-1).off === true && off.log.paint.at(-1).title === 'stage.mute.levelOff', 'mute: level Off dims the button', off.log.paint.at(-1));
  await off.say.toggleMute();
  ok(off.log.menu === 1 && off.log.mute.length === 0, 'mute: a click at level Off opens the menu instead of muting');
}
{
  const h = makeHarness({ level: 'normal', muted: true, muteUntil: new Date(2026, 9, 20, 7, 30).getTime() });
  await h.say.refresh();
  ok(h.log.paint.at(-1).title.startsWith('stage.mute.mutedUntil') && h.log.paint.at(-1).title.includes('07:30'), 'mute: a timed mute reads "Muted until 07:30"', h.log.paint.at(-1).title);
}
{
  const h = makeHarness({ quietEnd: '07:30' });
  await h.say.refresh();
  await h.say.muteForHour();
  ok(h.log.mute.at(-1) === h.clock.now + 3_600_000, 'menu: "Mute for 1 hour" mutes now + 1 h', h.log.mute);
  await h.say.muteUntilTomorrow();
  const u = new Date(h.log.mute.at(-1));
  ok(u.getDate() === 20 && u.getHours() === 7 && u.getMinutes() === 30, 'menu: "Mute until tomorrow" runs to the next quiet-hours end', u.toString());
  await h.say.setLevel('chatty'); await h.say.setLevel('bogus');
  ok(h.log.setTalk.length === 1 && h.log.setTalk[0].talkLevel === 'chatty', 'menu: a level choice saves talkLevel; an unknown level is ignored', h.log.setTalk);
}

// ---------- 5. Ctrl+Shift+M ----------
{
  const h = makeHarness();
  await h.say.refresh();
  const ev = (o) => ({ code: 'KeyM', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false, preventDefault() { this.prevented = true; }, ...o });
  const e1 = ev();
  ok(h.say.onKeydown(e1) === true && e1.prevented === true, 'shortcut: Ctrl+Shift+M is handled and its default prevented');
  await tick(5);
  ok(h.log.mute.length === 1, 'shortcut: it toggles the mute like a click');
  ok(h.say.onKeydown(ev({ ctrlKey: false })) === false && h.say.onKeydown(ev({ shiftKey: false })) === false && h.say.onKeydown(ev({ altKey: true })) === false && h.say.onKeydown(ev({ metaKey: true })) === false, 'shortcut: Ctrl+M, Shift+M, Alt/Meta combos and a bare "m" do nothing');
  ok(h.say.onKeydown(ev({ code: 'KeyN' })) === false && h.say.onKeydown(ev({ repeat: true })) === false, 'shortcut: another key and a held-down repeat do nothing');
  ok(h.log.mute.length === 1 && h.log.unmute === 0, 'shortcut: nothing fired besides the one handled press');
}

// ---------- 6. initSay: the real DOM binding, against a minimal fake DOM ----------
class FakeEl {
  constructor(id) { this.id = id; this.listeners = {}; this.attrs = {}; this.hidden = false; this.textContent = ''; this.title = ''; this.dataset = {}; this.children = []; this.cls = new Set(); this.focused = false; this.classList = { toggle: (c, on) => { if (on) this.cls.add(c); else this.cls.delete(c); }, add: (c) => this.cls.add(c), remove: (c) => this.cls.delete(c), contains: (c) => this.cls.has(c) }; }
  addEventListener(n, fn) { (this.listeners[n] ||= []).push(fn); }
  fire(n, ev = {}) { for (const fn of this.listeners[n] || []) fn({ preventDefault() {}, target: this, ...ev }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  focus() { this.focused = true; }
  contains(n) { return n === this || this.children.some((c) => c === n); }
  querySelectorAll(sel) { return sel === '[data-level]' ? this.children.filter((c) => c.dataset.level) : this.children; }
  querySelector() { return this.children[0] || null; }
}
{
  const btn = new FakeEl('talk-mute');
  const menu = new FakeEl('talk-mute-menu'); menu.hidden = true;
  const mk = (data) => { const e = new FakeEl('mi'); e.dataset = data; e.closest = () => e; return e; };
  const iHour = mk({ action: 'hour' }), iTom = mk({ action: 'tomorrow' }), iChatty = mk({ level: 'chatty' }), iNormal = mk({ level: 'normal' });
  menu.children = [iHour, iTom, iChatty, iNormal];
  const line = new FakeEl('say-line'); line.hidden = true;
  const els = { 'talk-mute': btn, 'talk-mute-menu': menu, 'say-line': line };
  const docL = {}; const winL = {};
  const doc = { addEventListener: (n, fn) => { (docL[n] ||= []).push(fn); } };
  const win = { addEventListener: (n, fn) => { (winL[n] ||= []).push(fn); }, setInterval: () => 0 };
  const h = makeHarness();
  let onSay;
  const zumi = { talk: { ...h.talk, onSay: (cb) => { onSay = cb; } } };
  const say = initSay({ zumi, $: (id) => els[id] || null, speech: h.speech, library: h.library, engine: h.engine, isBusy: () => false, t, doc, win });
  await tick(10);
  ok(btn.getAttribute('aria-pressed') === 'false' && btn.title === 'stage.mute.title' && btn.getAttribute('aria-label') === 'stage.mute.title', 'dom: the button starts unmuted with an accessible name');

  btn.fire('click'); await tick(10);
  ok(h.log.mute.length === 1 && btn.getAttribute('aria-pressed') === 'true' && btn.cls.has('muted'), 'dom: a click mutes; aria-pressed and the muted class follow', { pressed: btn.getAttribute('aria-pressed') });
  btn.fire('click'); await tick(10);
  ok(h.log.unmute === 1 && btn.getAttribute('aria-pressed') === 'false', 'dom: a second click unmutes');

  btn.fire('contextmenu');
  ok(menu.hidden === false, 'dom: right-click opens the menu');
  menu.hidden = true;
  // long press: pointerdown held past 500 ms opens the menu, and the click that follows is swallowed
  btn.fire('pointerdown', { button: 0 });
  await tick(560);
  ok(menu.hidden === false, 'dom: a 500 ms long press opens the menu');
  const before = h.log.mute.length + h.log.unmute;
  btn.fire('pointerup'); btn.fire('click'); await tick(5);
  ok(h.log.mute.length + h.log.unmute === before, 'dom: the click that ends a long press does not also toggle the mute');
  menu.hidden = true;
  btn.fire('pointerdown', { button: 0 }); await tick(50); btn.fire('pointerup');
  await tick(560);
  ok(menu.hidden === true, 'dom: a short press does not open the menu');

  menu.hidden = false;
  menu.fire('click', { target: iHour }); await tick(10);
  ok(menu.hidden === true && Math.abs(h.log.mute.at(-1) - (Date.now() + 3_600_000)) < 5000, 'dom: choosing "Mute for 1 hour" closes the menu and mutes', h.log.mute);
  menu.fire('click', { target: iChatty }); await tick(10);
  ok(h.log.setTalk.at(-1).talkLevel === 'chatty' && iChatty.getAttribute('aria-checked') === 'true' && iNormal.getAttribute('aria-checked') === 'false', 'dom: choosing a level saves it and the radio follows', h.log.setTalk);

  menu.hidden = false;
  winL.keydown[0]({ key: 'Escape', preventDefault() {} });
  ok(menu.hidden === true && btn.focused === true, 'dom: Escape closes the menu and returns focus to the button');
  menu.hidden = false;
  docL.pointerdown[0]({ target: new FakeEl('elsewhere') });
  ok(menu.hidden === true, 'dom: a click outside closes the menu');

  const unmutedBefore = h.log.unmute; const mutedBefore = h.log.mute.length;
  winL.keydown[0]({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false, preventDefault() {} });
  await tick(10);
  ok(h.log.unmute + h.log.mute.length === unmutedBefore + mutedBefore + 1, 'dom: Ctrl+Shift+M on the window toggles the mute');

  // a line from main: textContent only, hidden again after its time
  await onSay({ sayId: 'z', kind: 'event', text: '', show: '<img src=x onerror=alert(1)>', voice: false, lang: 'en', mood: null });
  ok(line.hidden === false && line.textContent === '<img src=x onerror=alert(1)>', 'dom: a subtitle is set with textContent (markup stays text)');
  docL['zumi:voice-changed'][0]();
  ok(say._test.cache().size === 0, 'dom: a voice-changed event clears the audio cache');
}

// ---------- 7. static wiring ----------
{
  const html = read('src/renderer/index.html');
  const toolbar = html.slice(html.indexOf('<section id="tab-zumi"'), html.indexOf('</header>', html.indexOf('<section id="tab-zumi"')));
  ok(/id="talk-mute"[^>]*aria-pressed="false"/.test(toolbar) && toolbar.indexOf('id="reflex-chip"') < toolbar.indexOf('id="talk-mute"'), 'markup: #talk-mute (aria-pressed) sits in the Zumi toolbar right after #reflex-chip');
  ok(/id="talk-mute-menu"[^>]*role="menu"[^>]*\bhidden\b/.test(toolbar), 'markup: the menu is role=menu and starts hidden');
  ok(['hour', 'tomorrow'].every((a) => toolbar.includes(`data-action="${a}"`)) && ['off', 'quiet', 'normal', 'chatty'].every((l) => new RegExp(`role="menuitemradio"[^>]*data-level="${l}"`).test(toolbar)), 'markup: the menu offers 1 hour, until tomorrow and the four levels (radio)');
  ok(/id="say-line"[^>]*aria-live="polite"[^>]*\bhidden\b/.test(html), 'markup: #say-line is an aria-live subtitle, hidden until used');
  const css = read('src/renderer/styles.css');
  ok(/#talk-mute\.muted/.test(css) && /#talk-mute\.off/.test(css) && /\.say-line/.test(css) && /\.mute-menu\[hidden\]/.test(css), 'styles: muted / off states, the menu and the subtitle are styled');
  const pre = read('src/main/preload.js');
  ok(/onSay: \(cb\) => on\('speech:say'/.test(pre) && /sayAck: /.test(pre) && /sayEvent: /.test(pre) && /mute: \(untilMs\)/.test(pre) && /unmute: \(\) =>/.test(pre) && /openGuide: /.test(pre), 'preload: onSay / sayAck / sayEvent / mute / unmute / openGuide are exposed');
  const main = read('src/main/main.js');
  ok(/ipcMain\.handle\('talk:mute'[\s\S]{0,400}setTalkPrefsFn\(\{ talkMute: \{ until \} \}\)/.test(main) && /ipcMain\.handle\('talk:unmute'[\s\S]{0,300}talkMute: null/.test(main), 'main: the stage mute is persisted as the talkMute pref (survives a restart)');
  ok(/\['poke', 'pat', 'look'\]\.includes\(name\)/.test(main), 'main: talk:sayEvent only accepts poke / pat / look');
  ok(main.includes("sendToRenderer('speech:say', line)") && main.includes("ipcMain.handle('talk:sayReady'") && pre.includes('sayReady') && /scheduler = createSpeechScheduler\(/.test(main) && /setInterval\(\(\) => \{ try \{ scheduler\.tick\(\)/.test(main), 'main: the scheduler is created, its lines go to the renderer and a 1 s tick drives it');
  ok(/onReaction: \(r\) => boardReactionToSay\(r\)/.test(main) && /onBoardStatus: \(ok\) =>/.test(main) && /talkActive: /.test(main), 'main: the HUD host feeds reactions and board status into the scheduler and polls while a talk level is on');
  ok(/sayEvent\('look'\)/.test(main), 'main: a new model or outfit queues the "New look?" line');
  const app = read('src/renderer/app.js');
  ok(/initSay\(\{ zumi, \$, speech: talk\.speech, library: talk\.library, engine, isBusy: replyBusy, t \}\)/.test(app) && /r\.trigger === 'poke'\) say\.event\('poke'\)/.test(app) && /st\.name === 'pat' && st\.on\) say\.event\('pat'\)/.test(app), 'app.js: initSay is wired and poke / pat are forwarded as events');
  ok(/!info\.selftest && !info\.demo/.test(app), 'app.js: self-tests and demos never get unprompted speech');
  // The box harness (review fix 3): it asserts the NEW voice gate, not the removed HUD one.
  const box = read('scripts/electron-hud.cjs');
  ok(/ZUMI_TEST_SAY_SILENT/.test(box) && /talkLevel: 'normal'/.test(box) && /speech:say/.test(box) && /say-line/.test(box) && /talk-mute/.test(box) && /ctrlKey: true, shiftKey: true/.test(box), 'electron-hud.cjs: the box harness drives speech:say, #say-line, #talk-mute and Ctrl+Shift+M with ZUMI_TEST_SAY_SILENT');
  ok(!/re1\.voice|re2\.voice|rate_limited|task T-31/.test(box), 'electron-hud.cjs: no assertion on the removed HUD voice gate (re.voice / rate_limited / "task T-31")');
}

console.log(`\ncheck:say-ui ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
