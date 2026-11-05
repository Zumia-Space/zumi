// T-31 0.2.11: the superseded B room plate (default-v2 talk plate) must never flash in a video room.
// Headless, no window, no Electron: the REAL CameraDirector + SceneVideo (+ the REAL applyScene source text from app.js)
// are driven with a fake <video> whose readyState/events we script, and a fake 2D context that models the plate canvas's
// visible pixels (clearRect empties it, drawImage paints a tag). "Visible" = what the canvas holds after each frame.
//   path (a) loop restart:  the video seeks back to 0, readyState drops below HAVE_CURRENT_DATA for 1-3 frames (0.2.9
//           captures C02-E f00075 = 1 frame) -> the plate canvas must keep the last room frame, never the B plate / empty.
//   path (b) room switch:   picking another video room while one plays (captures C05a f00122-124, C05c f00107-118) ->
//           the old room's frame stays until the NEW video's first decoded frame replaces it.
//   path (e) mid-play stall: the video stops advancing with no error/ended event (T-31 0.2.11 follow-up 2) -> after
//           VIDEO_STALL_MS the stall watchdog releases it and falls back to the plate exactly as the load-error path does
//           (SceneVideo.unload + app.js sceneToPlate); it stays quiet through hidden/paused windows, loop seeks and
//           slow-but-moving playback.
// Browser model used by the fake: drawImage(<video>) with readyState < 2 paints nothing (spec: no current frame data).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sceneVideoMod from '../src/renderer/room/scene-video.js';
const { SceneVideo } = sceneVideoMod;
import { CameraDirector } from '../src/renderer/room/camera-director.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'rooms-video', 'rooms.json'), 'utf8'));
const [PW, PH] = man.plateSize;
const ROOM_A = man.rooms.find((r) => r.id === 'scifi-bridge'), ROOM_B = man.rooms.find((r) => r.id === 'rooftop-night');
const tick = () => new Promise((r) => setTimeout(r, 0));
// Fake clock + interval registry for the stall watchdog: the test moves time and fires the watchdog by hand.
const clock = { t: performance.now() };
Object.defineProperty(globalThis.performance, 'now', { value: () => clock.t, configurable: true, writable: true });
const intervals = [];
globalThis.setInterval = (fn, ms) => { const t = { fn, ms, cleared: false }; intervals.push(t); return t; };
globalThis.clearInterval = (t) => { if (t && typeof t === 'object') t.cleared = true; };
const liveIntervals = () => intervals.filter((t) => !t.cleared);

// ---- fakes ----
class FakeVideo {
  constructor() { this.tag = 'video:?'; this.readyState = 0; this.paused = true; this.currentTime = 0; this.loop = false; this.l = {}; FakeVideo.made.push(this); }
  addEventListener(n, f) { (this.l[n] = this.l[n] || []).push(f); }
  setAttribute() {} removeAttribute(n) { if (n === 'src') this.src = null; } load() {}
  // `rejects` = how many upcoming play() calls the browser refuses (a rejected play() leaves the video paused)
  play() { this.plays = (this.plays || 0) + 1; if (this.rejects > 0) { this.rejects--; return Promise.reject(new Error('NotAllowedError')); } this.paused = false; return Promise.resolve(); } pause() { this.paused = true; }
  fire(n) { const fs_ = this.l[n] || []; this.l[n] = []; for (const f of fs_) f({}); }
  decode() { this.readyState = 4; this.fire('loadeddata'); } // the first frame is decoded
}
FakeVideo.made = [];
let pendingFetch = []; // test-held fetches: a room file "downloads" until the test releases it
globalThis.document = { createElement: (t) => { if (t !== 'video') throw new Error(t); return new FakeVideo(); } };
globalThis.URL.createObjectURL = (b) => `blob:${b.id}`;
globalThis.URL.revokeObjectURL = () => {};
globalThis.createImageBitmap = async () => ({ width: 10, height: 10 });
globalThis.fetch = (url) => new Promise((resolve) => {
  const res = () => resolve({ blob: async () => ({ id: url }) });
  if (/chair/.test(url)) res(); else pendingFetch.push({ url, res });
});
const releaseFetch = async () => { const p = pendingFetch; pendingFetch = []; for (const f of p) f.res(); await tick(); await tick(); };
const geometry = { ...man, chair: { ...man.chair, url: 'app://chair.png' } };
const roomList = (r) => ({ ...r, url: `app://${r.file}` });

// ---- the director with a pixel-modelling plate context ----
function stage() {
  const px = { content: [] };
  const ctx = { canvas: { width: 1204, height: 686 }, globalAlpha: 1,
    clearRect() { px.content = []; },
    drawImage(src) { if (src.tag && src.tag.startsWith('video:') && src.readyState < 2) return; px.content.push(src.tag); } };
  const cam = { fov: 28, aspect: 1, clearViewOffset() {}, setViewOffset() {}, updateProjectionMatrix() {}, position: { clone() { return this; } } };
  const d = new CameraDirector({ engine: { lastInputAt: performance.now(), speechMouth: 0 }, camera: cam, plateCtx: ctx });
  const vo = { fullWidth: 1920, fullHeight: 1926.6, x: 0, y: 726.6, width: 1920, height: 1200 };
  d.room = { views: { talk: { plateTexture: { image: { tag: 'B-plate', width: PW, height: PH } }, camera: { viewOffset: vo } }, work: {}, room: {} } };
  d.view = 'talk'; d.getFramingOverride = () => ({ chestUp: true });
  const seen = [];
  return { d, px, seen, frame() { d.drawPlate(); seen.push(px.content.length ? px.content[0] : 'EMPTY'); return seen[seen.length - 1]; } };
}
const bad = (seen) => seen.filter((s) => !s.startsWith('video:'));
async function loadedScene(room, tag) {
  const sv = new SceneVideo();
  const p = sv.load(roomList(room), geometry); await tick(); await releaseFetch();
  const v = FakeVideo.made[FakeVideo.made.length - 1]; v.tag = tag; v.decode(); await p;
  return { sv, v };
}
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const applySceneSrc = /async function applyScene\(\) \{([\s\S]*?)\n  \}\n/.exec(appSrc);
// The REAL app.js text runs in a scope of stubs: applyScene, the fallback helper sceneToPlate, and the one-line
// `sceneVideo.onStall = ...` wiring are all extracted from app.js, never re-implemented here.
const sceneToPlateSrc = /async function sceneToPlate\(\) \{([\s\S]*?)\n  \}\n/.exec(appSrc);
const onStallSrc = /^[ \t]*sceneVideo\.onStall = .*;$/m.exec(appSrc);
const inEnv = (env, body) => new Function('env', `with (env) { return (async () => {${body}
})(); }`)(env);
const makeEnv = (selected, rooms, director, sceneVideo) => {
  const env = {
    sceneApplyToken: 0, currentRoomV2: {}, sceneList: { rooms: rooms.map(roomList), selected, geometry },
    chairList: { chairs: [], selected: 'none' }, chair3d: { active: true }, chairSettled: async () => {},
    director, sceneVideo, roomViewSelect: { value: '', disabled: false, title: '' }, t: (k) => k, applyChair: async () => {}, settleScene: () => {},
  };
  if (sceneToPlateSrc) env.sceneToPlate = () => inEnv(env, sceneToPlateSrc[1]);
  return env;
};
const runApplyScene = (selected, rooms, director, sceneVideo, env = makeEnv(selected, rooms, director, sceneVideo)) => inEnv(env, applySceneSrc[1]);
ok(Boolean(applySceneSrc), 'app.js: applyScene found');

// ---- (a) loop restart ----
for (const dipFrames of [1, 2, 3]) {
  const { sv, v } = await loadedScene(ROOM_A, 'video:A');
  const s = stage(); sv.drawChair = false; s.d.setScene(sv);
  for (let i = 0; i < 5; i++) s.frame(); // normal playback
  // 'ended' -> native loop seeks to 0: no current frame until the seek lands (1-3 render frames)
  v.currentTime = 0; v.readyState = 1; v.fire('seeking');
  for (let i = 0; i < dipFrames; i++) s.frame();
  v.readyState = 4; v.fire('seeked'); v.fire('playing');
  for (let i = 0; i < 5; i++) s.frame();
  ok(bad(s.seen).length === 0, `loop restart, ${dipFrames}-frame seek gap: the plate canvas only ever shows the room video (never the B plate / empty)`, JSON.stringify(s.seen));
}

// ---- first load still shows the painted plate (no video frame exists yet to hold) ----
{
  const s = stage(); const sv = new SceneVideo();
  s.d.setScene(sv);
  ok(s.frame() === 'B-plate', 'before any video frame exists the painted plate stays (never an empty stage)');
}

// ---- (b) room switch: run the REAL applyScene text from app.js ----
{
  const { sv } = await loadedScene(ROOM_A, 'video:A');
  const s = stage(); sv.drawChair = false; s.d.setScene(sv);
  for (let i = 0; i < 4; i++) s.frame();
  const switchAt = s.seen.length;
  const run = runApplyScene(ROOM_B.id, [ROOM_A, ROOM_B], s.d, sv);
  // B's file downloads for 12 render frames (C05c: 12 flashed frames), then decodes
  for (let i = 0; i < 12; i++) { s.frame(); await tick(); }
  await releaseFetch();
  for (let i = 0; i < 3; i++) s.frame();
  const vb = FakeVideo.made[FakeVideo.made.length - 1]; vb.tag = 'video:B'; vb.decode(); await run;
  for (let i = 0; i < 4; i++) s.frame();
  ok(bad(s.seen).length === 0, "room switch: from the old room's last frame to the new video's first frame the canvas never shows the B plate / empty", JSON.stringify(s.seen));
  ok(s.seen[s.seen.length - 1] === 'video:B', "room switch: the new room's video is on screen at the end", s.seen[s.seen.length - 1]);
  ok(s.seen.slice(switchAt, switchAt + 12).every((x) => x === 'video:A'), 'room switch: the old room kept playing for every frame while the new file loaded', JSON.stringify(s.seen.slice(switchAt, switchAt + 12)));
}

// ---- switch to "Current room" (no video) must still land on the painted plate ----
{
  const { sv } = await loadedScene(ROOM_A, 'video:A');
  const s = stage(); sv.drawChair = false; s.d.setScene(sv); s.frame();
  await runApplyScene('current', [ROOM_A], s.d, sv);
  ok(s.frame() === 'B-plate', "picking 'Current room' shows the painted plate (the intended target)");
}

// ---- (c) a room video that never loads and never fires an error: the load times out, releases the pending video + blob ----
// Fake timers: only setTimeout calls >= 1000 ms are captured (the load timeout); the test's own 0 ms ticks stay real.
{
  const realST = globalThis.setTimeout, realCT = globalThis.clearTimeout, realRevoke = globalThis.URL.revokeObjectURL;
  const fake = [], revoked = [];
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 1000) { const t = { fn, ms, cleared: false }; fake.push(t); return t; } return realST(fn, ms, ...a); };
  globalThis.clearTimeout = (t) => { if (t && typeof t === 'object' && 'cleared' in t) t.cleared = true; else realCT(t); };
  globalThis.URL.revokeObjectURL = (u) => { revoked.push(u); };
  const { sv } = await loadedScene(ROOM_A, 'video:A');
  ok(fake.every((t) => t.cleared), 'load timeout: a load that succeeds leaves no timer armed');
  const s = stage(); sv.drawChair = false; s.d.setScene(sv);
  for (let i = 0; i < 3; i++) s.frame();
  const envC = makeEnv(ROOM_B.id, [ROOM_A, ROOM_B], s.d, sv); envC.roomViewSelect.disabled = true; // a video room locks the View picker
  const run = runApplyScene(ROOM_B.id, [ROOM_A, ROOM_B], s.d, sv, envC);
  let settled = false; run.then(() => { settled = true; });
  await tick(); await releaseFetch();
  const vb = FakeVideo.made[FakeVideo.made.length - 1]; vb.tag = 'video:B'; // downloaded, but never decodes and never errors
  for (let i = 0; i < 6; i++) { s.frame(); await tick(); }
  const armed = fake.filter((t) => !t.cleared);
  ok(armed.length === 1 && armed[0].ms === sceneVideoMod.VIDEO_LOAD_TIMEOUT_MS && armed[0].ms > 0, 'load timeout: a stuck load arms exactly one VIDEO_LOAD_TIMEOUT_MS timer', JSON.stringify({ armed: armed.length, ms: armed[0] && armed[0].ms, exported: sceneVideoMod.VIDEO_LOAD_TIMEOUT_MS }));
  ok(!settled && bad(s.seen).length === 0, 'load timeout: until it fires the old room keeps playing (still waiting, no plate flash)', JSON.stringify(s.seen));
  for (const t of armed) t.fn(); // the clock reaches the timeout
  await tick(); await tick(); await tick();
  ok(settled, 'load timeout: applyScene settles after the timeout instead of waiting forever');
  ok(vb.src === null && vb.paused, 'load timeout: the pending <video> is released (src removed, paused)');
  ok(revoked.includes('blob:app://' + ROOM_B.file), 'load timeout: the pending blob URL is revoked', JSON.stringify(revoked));
  ok(sv.video === null && !sv.active, 'load timeout: falls back as the error path does (SceneVideo unloaded)');
  ok(s.d.scene === null && envC.roomViewSelect.disabled === false, 'load timeout: app.js applyScene fallback wiring (!ok) clears the director scene and unlocks the View picker', JSON.stringify({ scene: s.d.scene && 'set', disabled: envC.roomViewSelect.disabled }));
  s.frame(); ok(s.seen[s.seen.length - 1] === 'B-plate', 'load timeout: the stage lands on the painted plate (error-path fallback), not a dead video', s.seen[s.seen.length - 1]);
  vb.decode(); await tick();
  ok(sv.video === null && !sv.active, 'load timeout: a late loadeddata from the abandoned video does not revive it');
  globalThis.setTimeout = realST; globalThis.clearTimeout = realCT; globalThis.URL.revokeObjectURL = realRevoke;
}

// ---- (d) the per-frame debug probe (scripts/probe-room-loop-electron.cjs): off by default, one event per drawPlate() when set ----
{
  const s = stage();
  ok(s.d.plateProbe === null, 'plate probe: CameraDirector.plateProbe is null by default (release path: no hook)');
  const ev = []; s.d.plateProbe = (e) => ev.push(e);
  const { sv, v } = await loadedScene(ROOM_A, 'video:A'); sv.drawChair = false;
  s.d.setScene(null); s.frame();                   // launch, no scene yet
  s.d.setScene(sv); for (let i = 0; i < 3; i++) s.frame(); // video playing
  v.readyState = 1; s.frame(); s.frame();          // loop seek gap
  v.readyState = 4; s.frame();
  s.d.setScene(null); s.frame();                   // back to the painted room
  const kinds = ev.map((e) => e.kind + (e.reason ? ':' + e.reason : ''));
  ok(JSON.stringify(kinds) === JSON.stringify(['plate:no-scene', 'video', 'video', 'video', 'hold:seek-gap', 'hold:seek-gap', 'video', 'plate:no-scene']), 'plate probe: exactly one event per frame with kind/reason (plate no-scene, video, hold seek-gap)', JSON.stringify(kinds));
  ok(ev.every((e) => typeof e.t === 'number' && e.view === 'talk'), 'plate probe: every event carries a timestamp and the view');
}

// ---- (e) mid-play stall + (f) the watchdog stays quiet on the app's deliberate pauses ----
// Model: the watchdog is a 1 s setInterval; the test owns the clock (performance.now) and fires the interval by hand.
// A "step" = 1 s of wall time. `playing` = currentTime advances 1 s per step (normal playback); `frozen` = it does not.
{
  const N = sceneVideoMod.VIDEO_STALL_MS ?? 5000;
  ok(Number.isFinite(sceneVideoMod.VIDEO_STALL_MS) && N >= 2000 && N < sceneVideoMod.VIDEO_LOAD_TIMEOUT_MS, 'stall watchdog: VIDEO_STALL_MS is exported, well above a seek/decode (<= 0.5 s measured) and below the load timeout', String(sceneVideoMod.VIDEO_STALL_MS));
  ok(Boolean(sceneToPlateSrc) && Boolean(onStallSrc), 'app.js: sceneToPlate helper and the sceneVideo.onStall wiring line exist');
  const realRevoke = globalThis.URL.revokeObjectURL; const revoked = [];
  globalThis.URL.revokeObjectURL = (u) => { revoked.push(u); };
  async function room() {
    intervals.length = 0; revoked.length = 0;
    const { sv, v } = await loadedScene(ROOM_A, 'video:A');
    const s = stage(); sv.drawChair = false; s.d.setScene(sv);
    const env = makeEnv(ROOM_A.id, [ROOM_A, ROOM_B], s.d, sv); env.roomViewSelect.disabled = true; // video room: View picker locked
    if (onStallSrc) inEnv(env, onStallSrc[0]);
    const stalls = { n: 0 }; const wired = sv.onStall; sv.onStall = () => { stalls.n++; return wired && wired(); };
    // one second of wall time: the watchdog interval fires; `moving` = the video clock advanced
    const step = async (moving, frames = 2) => { clock.t += 1000; if (moving) v.currentTime += 1; for (let i = 0; i < frames; i++) s.frame(); for (const t of liveIntervals()) t.fn(); await tick(); };
    return { sv, v, s, env, stalls, step };
  }
  const steps = async (r, n, moving) => { for (let i = 0; i < n; i++) await r.step(moving); };
  const sec = Math.round(N / 1000);

  // (e) frozen decoder (readyState stays 4, same frame forever) and buffer underflow (readyState drops to 1, holding)
  for (const mode of ['frozen decoder (readyState 4)', 'underflow (readyState 1)']) {
    const r = await room();
    ok(liveIntervals().length === 1, `stall [${mode}]: a loaded room arms exactly one watchdog interval`, String(liveIntervals().length));
    await steps(r, 8, true);
    ok(r.stalls.n === 0 && r.sv.active, `stall [${mode}]: 8 s of normal playback never trips it`);
    if (mode.includes('underflow')) r.v.readyState = 1;
    await steps(r, sec - 1, false); // frozen for N - 1 s: not yet
    ok(r.stalls.n === 0 && r.sv.active && r.s.d.scene === r.sv, `stall [${mode}]: frozen ${sec - 1} s (< N) -> still waiting, scene kept`);
    ok(bad(r.s.seen).length === 0, `stall [${mode}]: until N the stage holds the last room frame (no plate flash)`, JSON.stringify(r.s.seen));
    await steps(r, 2, false); // crosses N
    ok(r.stalls.n === 1, `stall [${mode}]: frozen past N (${N} ms) -> fallback fires exactly once`, String(r.stalls.n));
    ok(r.v.src === null && r.v.paused, `stall [${mode}]: the frozen <video> is released (src removed, paused)`);
    ok(revoked.includes('blob:app://' + ROOM_A.file), `stall [${mode}]: its blob URL is revoked`, JSON.stringify(revoked));
    ok(r.sv.video === null && !r.sv.active && r.sv.objectUrl === null, `stall [${mode}]: SceneVideo unloaded, same end state as the load-error path`);
    ok(liveIntervals().length === 0, `stall [${mode}]: the watchdog interval is cleared after it fires`);
    ok(r.s.d.scene === null && r.env.roomViewSelect.disabled === false, `stall [${mode}]: app.js wiring (sceneToPlate) clears the director scene and unlocks the View picker`, JSON.stringify({ scene: r.s.d.scene && 'set', disabled: r.env.roomViewSelect.disabled }));
    r.s.frame(); ok(r.s.seen[r.s.seen.length - 1] === 'B-plate', `stall [${mode}]: the stage lands on the painted plate, not the frozen frame`, r.s.seen[r.s.seen.length - 1]);
    r.v.decode(); await steps(r, 2, true);
    ok(r.sv.video === null && r.stalls.n === 1, `stall [${mode}]: a late event from the abandoned video does not revive it or re-fire`);
  }

  // (f1) hidden window: main's minimize/hide pauses the video on purpose. Nothing is owed while hidden, and the hidden time is not counted on restore.
  {
    const r = await room(); await steps(r, 3, true);
    r.sv.setVisible(false);
    await steps(r, 60, false); // a minute hidden, clock frozen
    ok(r.stalls.n === 0 && r.sv.active, 'quiet: a hidden (paused) window for 60 s does not trip the watchdog');
    r.sv.setVisible(true);
    await steps(r, sec - 1, true); await steps(r, 1, true);
    ok(r.stalls.n === 0 && r.sv.active, 'quiet: restoring the window and playing again does not trip it');
    await steps(r, sec - 1, false);
    ok(r.stalls.n === 0 && r.sv.active, 'quiet: hidden time is not counted -- after restore a freeze is judged from the restore, not from before the hide');
    await steps(r, 2, false);
    ok(r.stalls.n === 1, 'quiet: ...but a real freeze after restore still falls back');
  }
  // (f1b) restore with the clock still frozen for < N after play() resumes (decoder warming up)
  {
    const r = await room(); await steps(r, 2, true);
    r.sv.setVisible(false); await steps(r, 30, false);
    r.sv.setVisible(true); await steps(r, sec - 1, false); // play() issued, first frame takes a while but < N
    ok(r.stalls.n === 0 && r.sv.active, 'quiet: resume from hidden with a slow first frame (< N) does not trip it');
  }
  // (f2) paused while the window is VISIBLE is never deliberate (only a hidden window pauses on purpose, syncPlayback): the browser
  // refused play() or paused the video behind our back, and the last frame would stay up forever. It is a stall.
  {
    const r = await room(); await steps(r, 2, true);
    r.v.pause(); // visible, paused, no rejection ever seen by us
    await steps(r, sec - 1, false);
    ok(r.stalls.n === 0 && r.sv.active, 'paused+visible, no rejection seen: still waiting before N (a resume may be in flight)');
    await steps(r, 2, false);
    ok(r.stalls.n === 1 && !r.sv.active, `paused+visible, no rejection seen: the watchdog treats it as a stall and falls back after N (${N} ms)`, String(r.stalls.n));
    r.s.frame(); ok(r.s.seen[r.s.seen.length - 1] === 'B-plate' && r.env.roomViewSelect.disabled === false, 'paused+visible: stage lands on the painted plate via the same fallback wiring');
  }
  // (f2a) play() rejects while visible: retried once; a second refusal takes the stall/load-error fallback right away (inside N)
  {
    const r = await room(); await steps(r, 2, true);
    r.v.pause(); r.v.rejects = Infinity; r.v.plays = 0;
    r.sv.setVisible(true); await tick(); await tick();
    ok(r.v.plays === 2, 'play() rejected while visible: retried exactly once', String(r.v.plays));
    ok(r.stalls.n === 1 && !r.sv.active && r.sv.video === null, 'play() rejected twice while visible: falls back immediately, well inside the stall window');
    ok(r.v.src === null && revoked.includes('blob:app://' + ROOM_A.file) && liveIntervals().length === 0, 'play() rejected: the video + blob are released and the watchdog cleared (same as the stall path)');
    ok(r.s.d.scene === null && r.env.roomViewSelect.disabled === false, 'play() rejected: app.js wiring clears the director scene and unlocks the View picker');
    r.s.frame(); ok(r.s.seen[r.s.seen.length - 1] === 'B-plate', 'play() rejected: the stage lands on the painted plate, not a frozen frame');
  }
  // (f2b) a single transient refusal: the retry succeeds, no fallback
  {
    const r = await room(); await steps(r, 2, true);
    r.v.pause(); r.v.rejects = 1;
    r.sv.setVisible(true); await tick(); await tick();
    await steps(r, 8, true);
    ok(r.stalls.n === 0 && r.sv.active && !r.v.paused, 'play() rejected once then retried OK: no fallback, video playing');
  }
  // (f2c) the intended hidden-window pause stays quiet, even if a pending play() is rejected because the pause interrupted it
  {
    const r = await room(); await steps(r, 2, true);
    r.v.pause(); r.v.rejects = Infinity;
    r.sv.setVisible(true); r.sv.setVisible(false); // play() issued, then the window hides before it settles (AbortError in a browser)
    await tick(); await tick();
    await steps(r, 60, false);
    ok(r.stalls.n === 0 && r.sv.active, 'quiet: a play() rejection that lands after the window was hidden does not fall back');
  }
  // (f3) loop seeks: currentTime wraps to 0 and readyState dips; long playback across many loops
  {
    const r = await room(); let wraps = 0;
    for (let i = 0; i < 60; i++) {
      if (i % 6 === 5) { r.v.currentTime = 0; r.v.readyState = 1; wraps++; await r.step(true, 3); r.v.readyState = 4; } else await r.step(true);
    }
    ok(wraps >= 9 && r.stalls.n === 0 && r.sv.active, `quiet: 60 s across ${wraps} loop restarts (seek gaps) never trips it`);
    ok(bad(r.s.seen).length === 0, 'quiet: ...and the stage only ever showed the room video', JSON.stringify(bad(r.s.seen)));
  }
  // (f4) slow but moving: the video clock ticks once every N - 1 s (heavy load): progress is progress
  {
    const r = await room();
    for (let i = 0; i < 5; i++) { await steps(r, sec - 2, false); await r.step(true); }
    ok(r.stalls.n === 0 && r.sv.active, 'quiet: a video that advances at least once per N does not trip it');
  }
  // (f5) lifecycle: switching away from a video room or picking another one leaves no stray watchdog
  {
    const r = await room();
    r.sv.unload();
    ok(liveIntervals().length === 0, 'lifecycle: unload() clears the watchdog interval');
    const again = await loadedScene(ROOM_B, 'video:B'); // fresh scene swapped over a live one:
    const p = again.sv.load(roomList(ROOM_A), geometry); await tick(); await releaseFetch();
    const v2 = FakeVideo.made[FakeVideo.made.length - 1]; v2.tag = 'video:A2'; v2.decode(); await p;
    ok(liveIntervals().length === 1, 'lifecycle: a room swap leaves exactly one live watchdog interval (the old one is cleared)', String(liveIntervals().length));
  }
  globalThis.URL.revokeObjectURL = realRevoke;
}

// ---- (g) selecting "No room" (setRoom(null)) after a resize: the plate canvas is cleared, fov/aspect reset, nothing stale drawn ----
// app.js resize() (a tab click triggers one) sets the canvas size + camera.aspect; a frame then repaints the plate; picking "No room"
// used to leave that picture on #stage-plate (update() is a no-op once room is null) and the room view's fov/aspect on the camera.
{
  const { sv } = await loadedScene(ROOM_A, 'video:A'); sv.drawChair = false;
  for (const withVideo of [false, true]) {
    const tag = withVideo ? 'video room' : 'plate';
    const s = stage(); const cam = s.d.camera, canvas = s.d.plateCtx.canvas;
    if (withVideo) s.d.setScene(sv);
    for (let i = 0; i < 3; i++) s.frame();
    cam.fov = 41; // the room view's authored camera (applyViewSideEffects / jumpToView)
    canvas.width = 900; canvas.height = 600; cam.aspect = canvas.width / canvas.height; // resize(): the tab click
    cam.aspect = 2.3; // ...and a view cut in flight (applyViewSideEffects) re-applies the room view's authored aspect over it
    s.frame(); // the frame after the resize repaints the plate
    ok(s.px.content.length > 0, `No room [${tag}]: precondition, the room picture is on the plate canvas`);
    s.d.setRoom(null);
    ok(s.px.content.length === 0, `No room [${tag}]: #stage-plate is cleared`, JSON.stringify(s.px.content));
    ok(cam.fov === 28, `No room [${tag}]: fov is back to the stage default`, String(cam.fov));
    ok(Math.abs(cam.aspect - 900 / 600) < 1e-9, `No room [${tag}]: aspect follows the live canvas`, String(cam.aspect));
    const seenAfter = []; for (let i = 0; i < 3; i++) { s.d.update(); s.d.drawPlate(); seenAfter.push(s.px.content.length); }
    ok(seenAfter.every((n) => n === 0), `No room [${tag}]: no stale video/plate frame is drawn afterwards`, JSON.stringify(seenAfter));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
