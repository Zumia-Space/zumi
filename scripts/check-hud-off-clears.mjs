// T-31 alpha.3 step 8c gate (pure Node, no browser, no Electron): turning the HUD style to Off in Settings must clear BOTH task consumers.
//   node scripts/check-hud-off-clears.mjs   (npm run check:hud-off-clears)
// Why a new file (CoS rule A, BH-11e freeze: existing check scripts are never edited): the 8b Opus review found F1. src/main/hud-host.mjs sends
// 'hud:feed' only while a style is on, so after B -> Off NO payload ever reaches hud.js again; the only code that empties the holo panel and the
// work signal ran inside onFeed (payload.style === 'off'), so the last live task stayed on the panel and the seated working pose stayed up.
// The R3 harness hid it because it sent a trailing { style: 'off' } payload that the real host never sends.
// This check runs the REAL initHud with a stub DOM, the REAL HoloScreen (recording 2D context, as check-holo-task.mjs) and the REAL work signal,
// sends ONE live feed with style B, then changes the style select to Off and sends NOTHING more (the real host's behaviour).
import * as THREE from 'three';
import { FLOAT } from '../src/renderer/room/float-mode.js';
import { HoloScreen } from '../src/renderer/room/holo-screen.js';
import { createWorkSignal } from '../src/renderer/hud/work-signal.js';

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

// ---- a stub DOM: every property is another stub, every call returns a stub; only what initHud needs to run is real ----
const listeners = new Map(); // element id -> { event -> [fn] }
const makeEl = (id) => {
  const own = { id, value: 'off', hidden: false, dataset: {}, style: {}, children: [], textContent: '', className: '' };
  const classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  const fn = function () {};
  const p = new Proxy(fn, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;
      if (k === 'classList') return classList;
      if (k === 'addEventListener') return (ev, h) => { const m = listeners.get(id) || {}; (m[ev] = m[ev] || []).push(h); listeners.set(id, m); };
      if (k === 'getBoundingClientRect') return () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
      if (k === 'closest' || k === 'querySelector' || k === 'parentElement') return k === 'parentElement' ? null : () => null;
      if (k === 'querySelectorAll') return () => [];
      if (k in own) return own[k];
      return p;
    },
    set(_t, k, v) { own[k] = v; return true; },
    apply() { return p; },
  });
  return p;
};
const els = new Map();
const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

const calls = [];
const recCtx = new Proxy({}, {
  get(t, k) {
    if (k === 'measureText') return (s) => ({ width: String(s).length * 8 });
    if (k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k === 'fillText') return (s) => { calls.push(String(s)); };
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});
const stubStore = new Map();
globalThis.localStorage = { getItem: (k) => (stubStore.has(k) ? stubStore.get(k) : null), setItem: (k, v) => stubStore.set(k, String(v)), removeItem: (k) => stubStore.delete(k) };
globalThis.document = { createElement: () => makeEl('created'), createElementNS: () => makeEl('created'), createTextNode: () => makeEl('text'), addEventListener() {}, dispatchEvent() {}, activeElement: null };
globalThis.window = { addEventListener() {}, CSS: undefined, localStorage: globalThis.localStorage };
globalThis.CustomEvent = class { constructor(t) { this.type = t; } };
globalThis.getComputedStyle = () => ({ opacity: '1' });
globalThis.setInterval = () => 0; // syncVisible's 400 ms timer must not keep the process alive
globalThis.requestAnimationFrame = () => 0; // no frame loop: the style-change path under test does not depend on one

const { initHud } = await import('../src/renderer/hud/hud.js');

const light = { distance: 0, decay: 0, intensity: 0, position: new THREE.Vector3(), color: new THREE.Color() };
const workSignal = createWorkSignal({ log: () => {} });

const nowIso = new Date().toISOString();
const liveRow = { id: 'T-LIVE-1', title: 'Aurora app 2.0 release', status: 'working', at: nowIso, step: 'QA on iPhone', stepId: 's2', stepState: 'active', doneCount: 2, stepTotal: 6, steps: [], log: [] };
const livePayload = { style: 'B', feed: { updates: [liveRow], waiting: [], waitingCount: 0 }, reaction: null };

let feedCb = null;
let prefsStyle = 'B';
const zumi = {
  hud: {
    onFeed: (cb) => { feedCb = cb; },
    getPrefs: async () => ({ style: prefsStyle }),
    setPrefs: async (patch) => { prefsStyle = patch.style; return { style: prefsStyle }; },
    ready: async () => {},
  },
};

// HoloScreen draws on a canvas made through document.createElement: hand it the recording context
const prevCreate = globalThis.document.createElement;
globalThis.document.createElement = (tag) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => recCtx } : prevCreate(tag));
const holoForHud = new HoloScreen({ parent: new THREE.Scene(), engine: {}, camera: new THREE.PerspectiveCamera(28, 16 / 9, 0.05, 50), light, P: FLOAT });
globalThis.document.createElement = prevCreate;

await initHud({
  zumi, $, engine: { isState: () => false, trigger() {}, exitState() {} }, catalog: { forceNext() {} }, talk: { speech: { speaking: () => false } },
  hasModel: () => false, getView: () => 'wide', devRun: false, openBoardTask: () => {},
  onWorkFeed: (updates) => workSignal.setFeed(updates),
  onHoloFeed: (updates) => holoForHud.setFeed(updates),
});

ok(typeof feedCb === 'function', 'harness: initHud registered its hud:feed listener');
ok((listeners.get('hud-style') || {}).change && listeners.get('hud-style').change.length === 1, 'harness: initHud registered the Settings style select change listener');

// 1. a live feed with style B reaches both consumers (control: the check can see a live task at all)
calls.length = 0;
feedCb(livePayload);
ok(holoForHud.state().pageName === 'task' && calls.includes('Aurora app 2.0 release') && calls.includes('WORKING'), 'control: a style B feed puts the live task on the holo panel', { page: holoForHud.state().pageName, texts: calls });
ok(workSignal.working === true, 'control: a style B feed with an active step makes the work signal report working=true', workSignal.working);

// 2. B -> Off in Settings, and NOTHING after it (the real host sends no payload once the style is Off: src/main/hud-host.mjs header)
$('hud-style').value = 'off';
calls.length = 0;
await Promise.all((listeners.get('hud-style').change || []).map((h) => h()));
await new Promise((res) => setTimeout(res, 20));
ok(prefsStyle === 'off', 'B -> Off: the select change saved style off through zumi.hud.setPrefs', prefsStyle);
ok(holoForHud.state().pageName === 'idle' && calls.includes('NO LIVE TASK') && !calls.includes('Aurora app 2.0 release'), 'B -> Off, no trailing payload: the holo panel reads NO LIVE TASK (pageName idle), not the last live task', { page: holoForHud.state().pageName, texts: calls });
ok(workSignal.working === false, 'B -> Off, no trailing payload: the work signal reports working=false (the seated pose can end)', workSignal.working);

// 3. the other order still works: Off -> B, then the next live feed shows the task again
prefsStyle = 'B'; $('hud-style').value = 'B';
await Promise.all((listeners.get('hud-style').change || []).map((h) => h()));
calls.length = 0;
feedCb(livePayload);
ok(holoForHud.state().pageName === 'task' && calls.includes('Aurora app 2.0 release') && workSignal.working === true, 'Off -> B: the next live feed shows the task and working=true again', { page: holoForHud.state().pageName, working: workSignal.working });

console.log(`\ncheck:hud-off-clears ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
