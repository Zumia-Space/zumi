// T-31 alpha.3 R3 gate (pure Node, no browser, no Electron): the holo panel draws the LIVE task from the board feed, never a demo page.
//   node scripts/check-holo-task.mjs   (npm run check:holo-task)
// New file by CoS rule A (alpha.3): these assertions used to be sections of scripts/check-float-holo.mjs, which stays frozen.
//   1. HoloScreen.setFeed + drawTask (a recording 2D context captures every fillText): title, STEP n/m . p% DONE, English state words, the board's step
//      label, the last 3 finished steps, first active row wins, no NaN, no redraw on an identical feed, the glance, NO LIVE TASK on an empty feed
//   2. the wiring: hud.js hands the feed to onHoloFeed, app.js points it at holo.setFeed (each line removed turns this red)
//   3. the accent pin (setPageAccent/pinPage) and the removal of the demo pages, their clock and the PILOT tag
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { FLOAT } from '../src/renderer/room/float-mode.js';
import { HoloScreen } from '../src/renderer/room/holo-screen.js';
import * as HoloMod from '../src/renderer/room/holo-screen.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, msg, detail) => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

// ---------- 12. T-31 alpha.3 R3: the panel draws the LIVE task from the board feed, never a demo page ----------
// The real HoloScreen runs here with a recording 2D context (Node has no canvas): every fillText/fillRect the panel
// draws is captured, so "the title is drawn" is read from what the class actually painted. The pixel proof (the
// glyphs, Vietnamese diacritics included) is the shot taken by scripts/electron-float-holo.cjs / the R3 shots.
// The fixture row is inside this check only (the same dev-seam rule as window.__zumiHud); the app never builds one.
{
  const calls = [];
  const recCtx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'fillText') return (s, x, y) => { calls.push({ op: 'text', s: String(s), x, y, fill: t.fillStyle }); };
      if (k === 'fillRect') return (...a) => { calls.push({ op: 'rect', a }); };
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => recCtx });
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: fakeCanvas };
  try {
    const light = { distance: 0, decay: 0, intensity: 0, position: new THREE.Vector3(), color: new THREE.Color() };
    const holo = new HoloScreen({ parent: new THREE.Scene(), engine: {}, camera: new THREE.PerspectiveCamera(28, 16 / 9, 0.05, 50), light, P: FLOAT });
    const texts = () => calls.filter((c) => c.op === 'text').map((c) => c.s);
    const fixture = {
      id: 'T-FIX-1', title: 'Fixture task: render the demo', status: 'working', at: '2026-10-29T10:00:00Z',
      step: 'Buoc 19 - kiem tra khung hinh', stepId: 's19', stepState: 'active', doneCount: 19, stepTotal: 37,
      steps: [], log: [
        { label: 'Step A', from: 'active', to: 'done', at: '2026-10-29T09:00:00Z' },
        { label: 'Step B', from: 'active', to: 'done', at: '2026-10-29T09:10:00Z' },
        { label: 'Step C', from: 'active', to: 'done', at: '2026-10-29T09:20:00Z' },
        { label: 'Step D', from: 'todo', to: 'active', at: '2026-10-29T09:30:00Z' },
        { label: 'Step E', from: 'active', to: 'done', at: '2026-10-29T09:40:00Z' },
      ],
    };
    ok(typeof holo.setFeed === 'function', 'R3 (a): HoloScreen has setFeed(updates), the one entry the board feed reaches the panel through', typeof holo.setFeed);
    if (typeof holo.setFeed === 'function') {
      calls.length = 0;
      holo.setFeed([fixture]);
      ok(holo.state().pageName === 'task', "R3 (a): after setFeed([fixture]) state().pageName is 'task'", holo.state().pageName);
      ok(texts().some((s) => s.startsWith('Fixture task')), 'R3 (a): the drawn canvas carries the task title', texts());
      ok(texts().includes('STEP 19/37 · 51% DONE'), 'R3 (a): line 2 reads STEP 19/37 · 51% DONE (doneCount/stepTotal, nothing invented)', texts());
      ok(texts().includes('WORKING'), 'R3 (a): line 3 is the English state word for stepState active (WORKING)', texts());
      ok(texts().some((s) => s.includes('Buoc 19')), "R3 (a): line 4 is the board's own step label, as written", texts());
      ok(texts().includes('DONE · Step E') && texts().includes('DONE · Step B') && texts().includes('DONE · Step C') && !texts().includes('DONE · Step A') && !texts().includes('DONE · Step D'),
        'R3 (a): the last 3 log lines with to === done are listed (E, C, B), not a started step and not the 4th done one', texts());
      ok(!texts().includes('PILOT'), 'R3 (a): no PILOT tag any more (the panel is no demo)', texts());
      for (const [state, word] of [['waiting', 'WAITING FOR OWNER'], ['blocked', 'BLOCKED'], ['todo', 'QUEUED']]) {
        calls.length = 0; holo.setFeed([{ ...fixture, stepState: state }]);
        ok(texts().includes(word), `R3 (a): stepState ${state} reads ${word}`, texts());
      }
      calls.length = 0;
      holo.setFeed([{ ...fixture, id: 'T-FIX-2', title: 'Idle task', stepState: 'todo' }, fixture]);
      ok(texts().some((s) => s.startsWith('Fixture task')) && !texts().includes('Idle task'), 'R3 (a): with several rows the first stepState active wins over the first row', texts());
      calls.length = 0; holo.setFeed([{ ...fixture, doneCount: 0, stepTotal: 0 }]);
      ok(texts().some((s) => s.startsWith('STEP 0/0')) && !texts().some((s) => /NaN|Infinity/.test(s)), 'R3 (a): a task with no steps never prints NaN/Infinity', texts());
      // redraw only when the chosen fields change (the 20 s poll re-sends the same rows)
      calls.length = 0; holo.setFeed([fixture]); const first = calls.length;
      calls.length = 0; holo.setFeed([JSON.parse(JSON.stringify(fixture))]);
      ok(first > 0 && calls.length === 0, 'R3 (a): an identical feed does not redraw the canvas', { first, again: calls.length });
      // the glance: 120 ms after a change to a task, only while the panel is up, never at NO LIVE TASK
      let glances = 0;
      holo.glance = () => { glances++; }; holo.screenNdc = () => ({ x: 0, y: 0 });
      const settle = () => new Promise((res) => setTimeout(res, 220));
      holo.on = true; holo.setFeed([{ ...fixture, doneCount: 1 }]); await settle();
      ok(glances === 1, 'R3 (a): a changed task makes her glance at the panel once (120 ms later)', glances);
      holo.on = false; holo.setFeed([{ ...fixture, doneCount: 2 }]); await settle();
      ok(glances === 1, 'R3 (a): no glance while the panel is hidden (seated, not working)', glances);
      holo.on = true; holo.setFeed([]); await settle();
      ok(glances === 1, 'R3 (a): no glance at NO LIVE TASK', glances);
      holo.setFeed([fixture]); calls.length = 0; holo.setFeed([]);
      ok(holo.state().pageName === 'idle' && texts().includes('NO LIVE TASK') && !texts().some((s) => s.includes('Fixture')), "R3 (a): an empty feed reads NO LIVE TASK (pageName 'idle'), never a demo page", { page: holo.state().pageName, texts: texts() });
    }
  } finally { globalThis.document = prevDoc; }
}

// ---------- 14. T-31 alpha.3 R3 round 2 (REVIEW-OPUS S1): the board feed really reaches the panel ----------
// Every other gate drives holo.setFeed directly, so deleting either wiring line would leave them all green while the shipped panel read NO LIVE TASK forever.
// hud.js hands the SAME task rows to onHoloFeed that it hands to the working signal; app.js points onHoloFeed at holo.setFeed (and keeps the
// onWorkFeed line byte-identical, scripts/check-work-signal.mjs pins it).
{
  const hudSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/hud/hud.js'), 'utf8'), appSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  ok(/initHud\(\{[^}]*\bonHoloFeed\b[^}]*\}\)/.test(hudSrc), 'R3 wiring: initHud takes onHoloFeed');
  ok(hudSrc.includes('if (onHoloFeed) onHoloFeed(workFeedOf(payload));') && hudSrc.indexOf('if (onWorkFeed) onWorkFeed(workFeedOf(payload));') < hudSrc.indexOf('if (onHoloFeed) onHoloFeed(workFeedOf(payload));'),
    'R3 wiring: every hud:feed hands workFeedOf(payload) to onHoloFeed, next to onWorkFeed');
  ok(/onHoloFeed: \(updates\) => holo\.setFeed\(updates\)/.test(appSrc), 'R3 wiring: app.js passes onHoloFeed: (updates) => holo.setFeed(updates) to initHud');
  ok(/initHud\(\{[\s\S]{0,600}onHoloFeed:/.test(appSrc), 'R3 wiring: the onHoloFeed line sits inside the initHud({ ... }) call');
}

// ---------- 15. the accent pin is wired, and the demo pages / page clock / PILOT tag are gone ----------
{
  const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const H = rd('scripts/electron-float-holo.cjs'), APP = rd('src/renderer/app.js'), HOLO = rd('src/renderer/room/holo-screen.js');
  ok(/pinPage\(on\) \{/.test(HOLO) && /this\.pinned = next;/.test(HOLO) && /setPageAccent: \(hex\) => holo\.setPageAccent\(hex\)/.test(APP) && /setPageAccent\(hex\) \{/.test(HOLO)
    && /liveAccent\(this\.pageAccent, this\.fixedAccent, this\.pinned\)/.test(HOLO) && /holo\.setPageAccent\(/.test(H),
  'R3 wiring: the accent is pinned through the dev hook (holo.pin -> pinPage keeps the panel accent over the Settings pick; holo.setPageAccent sets it; the harness uses it)');
  ok(!/nextPage|PAGE_MS|PAGES\b|drawCode|drawBars|drawWave|pageStartedAt/.test(HOLO), 'R3: the demo-page table, its drawers and the 6 s page clock are gone from holo-screen.js');
  ok(!/fillText\('PILOT'/.test(HOLO), 'R3: the PILOT tag is no longer drawn');
  ok(!/nextPage/.test(H), 'R3: the Electron harness no longer drives a page clock (nextPage)');
}

// ---------- 16. T-31 alpha.9: the card is made of the side panels' tokens, follows the theme, and never paints a colour of its own ----------
// anh QC 30-10. The side panels (src/renderer/hud/hud.css) build their colours from --holo-tint / --foreground /
// --background / --ai / --question / --danger with color-mix; the card must use the SAME expressions, resolved against the live theme.
{
  const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const css = rd('src/renderer/hud/hud.css').replace(/\s+/g, ' ');
  const exprs = HoloMod.PANEL_EXPRS || {};
  // the value of a custom property / declaration in hud.css, whitespace-normalised, then compared with the card's expression
  const decl = (re) => { const m = re.exec(css); return m ? m[1].trim() : null; };
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  const tint = (e) => String(e).replace(/var\(--holo-tint\)/g, 'var(--holo-tint)');
  const want = {
    holo: decl(/--holo: ([^;]+);/), line: decl(/--holo-line: ([^;]+);/), bg: decl(/--holo-bg: ([^;]+);/), scan: decl(/--holo-scan: ([^;]+);/), glow: decl(/--holo-glow: ([^;]+);/),
    title: decl(/\.hud-item \{ display: grid;[^}]*? color: ([^;]+);/), soft: decl(/\.hud-item \.step \{[^}]*? color: ([^;]+);/),
    waiting: decl(/\.s-waiting \{[^}]*? color: ([^;]+);/), blocked: decl(/\.s-blocked \{[^}]*? color: ([^;]+);/),
  };
  for (const [k, v] of Object.entries(want)) ok(v && same(tint(exprs[k]), v), `alpha.9 tokens: card colour '${k}' is the side panels' own expression (hud.css)`, { card: exprs[k], hud: v });
  ok(typeof HoloMod.panelPalette === 'function' && !/#39d0ff|#ffb347/i.test(HoloMod.drawTask.toString() + (HoloMod.panelPalette || '').toString()), 'alpha.9 tokens: drawing code carries no hard-coded cyan/amber');

  // a fake page whose "theme" tags every resolved expression: the card must paint ONLY resolved palette colours, and repaint in the new theme
  let theme = 'blue';
  const painted = new Set();
  const rec = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop(_o, c) { painted.add(String(c)); } });
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { if ((k === 'fillStyle' || k === 'strokeStyle') && typeof v === 'string') painted.add(v); t[k] = v; return true; },
  });
  const probe = () => { const st = { setProperty() {}, color: '' }; return { style: st }; };
  const root = { appendChild() {}, removeChild() {} };
  const fakeDoc = {
    documentElement: root,
    defaultView: { getComputedStyle: (el) => ({ color: `${el.style.color}@${theme}` }) },
    createElement: (tag) => (tag === 'span' ? probe() : { width: 0, height: 0, getContext: () => rec }),
  };
  const prevDoc = globalThis.document;
  globalThis.document = fakeDoc;
  try {
    const light = { distance: 0, decay: 0, intensity: 0, position: new THREE.Vector3(), color: new THREE.Color() };
    const holo = new HoloScreen({ parent: new THREE.Scene(), engine: {}, camera: new THREE.PerspectiveCamera(28, 16 / 9, 0.05, 50), light, P: FLOAT });
    const row = { id: 'T-A9', title: 'Hunter Tool: quet thu', status: 'working', step: 'Anh dang trao doi voi khach tren Upwork', stepId: 's16', stepState: 'waiting', doneCount: 16, stepTotal: 21,
      steps: [], log: [{ label: 'Quet job 30-10', from: 'active', to: 'done' }] };
    painted.clear(); holo.setFeed([row]);
    const allowed = (theme_) => new Set([...Object.values(exprs).map((e) => `${e}@${theme_}`), 'transparent']);
    const stray = (theme_) => [...painted].filter((c) => !allowed(theme_).has(c));
    ok(painted.size > 3 && stray('blue').length === 0, 'alpha.9 tokens: every colour the card paints is a resolved side-panel token (no hard-coded cyan, no rgba literal)', { stray: stray('blue') });
    ok([...painted].some((c) => c === `${exprs.waiting}@blue`), 'alpha.9 tokens: a waiting task paints its chip in the question colour (as .state.s-waiting)', [...painted]);
    theme = 'white'; painted.clear(); if (typeof holo.retheme === 'function') holo.retheme();
    ok(typeof holo.retheme === 'function' && painted.size > 3 && stray('white').length === 0 && ![...painted].some((c) => c.endsWith('@blue')), 'alpha.9 tokens: after a theme change the card repaints in the new theme and keeps nothing of the old one', { stray: stray('white') });
  } finally { globalThis.document = prevDoc; }
}

console.log(`\ncheck:holo-task ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
