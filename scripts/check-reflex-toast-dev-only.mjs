// T-31 0.2.10: the "reflex in 0.01 s" line is developer chrome. A normal build must not show it; Developer mode
// (Settings > App, same gate as the sidebar dev buttons) must. Node only, fake DOM, no window:
//   node scripts/check-reflex-toast-dev-only.mjs   (or: npm run check:reflex-toast-dev-only)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

let mod = null;
try { mod = await import('../src/renderer/talk/reflex-timing.js'); } catch (e) { ok(false, 'talk/reflex-timing.js exists and loads', String(e.message).split('\n')[0]); }

if (mod) {
  const { t } = await import('../src/renderer/i18n.js');
  const make = () => {
    const els = {};
    const $ = (id) => (els[id] ||= { id, hidden: true, textContent: '' });
    const set = (id, text) => { $(id).textContent = text || ''; };
    return { els, $, set };
  };
  const run = (flags) => { const d = make(); const shown = mod.showReflexTiming({ $: d.$, set: d.set, t, ms: 10, source: 'rules', ...flags }); return { d, shown }; };

  const off = run({ devMode: false });
  ok(off.shown === false && (!off.d.els['an-reflex'] || off.d.els['an-reflex'].hidden) && !off.d.els.analysis, 'Developer mode OFF: nothing is shown');
  const none = run({});
  ok(none.shown === false && (!none.d.els['an-reflex'] || none.d.els['an-reflex'].hidden), 'Developer mode unset (default): hidden');
  const on = run({ devMode: true });
  ok(on.shown === true && on.d.els['an-reflex'].hidden === false && /0\.01/.test(on.d.els['an-reflex'].textContent) && on.d.els.analysis.hidden === false, 'Developer mode ON: the timing line is shown', JSON.stringify(on.d.els['an-reflex']));
  const canned = run({ devMode: true, canned: true });
  ok(canned.shown === false && (!canned.d.els['an-reflex'] || canned.d.els['an-reflex'].hidden), 'canned demo stays hidden even in Developer mode (old rule kept)');

  // Behavioural: Developer mode toggled on -> timing shown -> toggled off -> next turn. The stale line must be gone.
  const el = (d, id) => d.els[id] || { hidden: true, textContent: '' };
  const gone = (d) => el(d, 'an-reflex').hidden === true && el(d, 'an-reflex').textContent === '';
  const nextTurn = (d) => { d.$('analysis').hidden = false; }; // talkUi.analysis() reveals #analysis again

  // (a) show path: dev off after on must hide + clear an-reflex even though nothing is shown
  const d1 = make();
  const base = { $: d1.$, set: d1.set, t, ms: 10, source: 'rules' };
  mod.showReflexTiming({ ...base, devMode: true });
  mod.showReflexTiming({ ...base, devMode: false });
  nextTurn(d1);
  ok(gone(d1), 'on -> timing -> off -> next turn: an-reflex hidden and empty (show path)', JSON.stringify(d1.els['an-reflex']));

  // (b) event path, through the real controller that talkUi uses: the toggle itself must hide the line
  ok(typeof mod.createReflexTiming === 'function', 'createReflexTiming controller is exported (talkUi uses it)');
  if (typeof mod.createReflexTiming === 'function') {
    const d2 = make();
    const rt = mod.createReflexTiming({ $: d2.$, set: d2.set, t, isCanned: () => false });
    rt.show(10, 'rules');
    ok(gone(d2) && !d2.els.analysis, 'controller: Developer mode off from start never shows');
    rt.setDevMode(true); rt.show(10, 'rules');
    ok(el(d2, 'an-reflex').hidden === false && /0\.01/.test(el(d2, 'an-reflex').textContent), 'controller: Developer mode on shows the timing');
    rt.setDevMode(false); nextTurn(d2);
    ok(gone(d2), 'controller: turning Developer mode off hides and clears an-reflex (event path)', JSON.stringify(d2.els['an-reflex']));
    rt.show(10, 'rules'); nextTurn(d2);
    ok(gone(d2), 'controller: a turn after off stays hidden');
    rt.setDevMode(true); rt.show(10, 'jev');
    ok(el(d2, 'an-reflex').hidden === false, 'controller: turning back on shows again');
    const d3 = make();
    const live = mod.createReflexTiming({ $: d3.$, set: d3.set, t, isCanned: () => true });
    live.setDevMode(true); live.show(10, 'rules');
    ok(gone(d3), 'controller: canned stays hidden even with Developer mode on');
    const d4 = make();
    const boot = mod.createReflexTiming({ $: d4.$, set: d4.set, t, isCanned: () => false, devMode: true });
    boot.show(10, 'rules');
    ok(el(d4, 'an-reflex').hidden === false, 'controller: Developer mode already on at launch shows');
  }
}

// wiring: the real talkUi uses the module, and Settings feeds it the same gate as the other dev chrome
const talk = fs.readFileSync(path.join(root, 'src/renderer/talk/index.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'src/renderer/settings.js'), 'utf8');
ok(/reflex\.show\(/.test(talk) && !/set\('an-reflex'/.test(talk), 'talkUi.reflexTiming delegates to the controller (no ungated an-reflex write)');
ok(/addEventListener\('zumi:dev-chrome'/.test(talk) && /createReflexTiming\(/.test(talk) && /setDevMode\(/.test(talk), 'talkUi listens for the Developer-mode gate and forwards it to the controller');
ok(/dispatchEvent\([^;]*zumi:dev-chrome/.test(settings), 'applyDevTools publishes the gate (devChromeVisible result, dev run included)');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
