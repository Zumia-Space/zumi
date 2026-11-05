// T-31 float-holo QC switch: renderer test for the Settings pick and its LIVE wiring (no DOM, no Electron).
// The brief: "switching sets the FH params (6 combos)" -- three r6 TOP3 looks x two sweep colours.
//
// Review 20-10 (HOLO-QC finding 3): this used to copy the resolved fields into a sink shaped like app.js's sinks, so a
// broken handler still passed. It now cuts app.js's OWN float/holo wiring out of the source and runs it (the
// check-board-open.mjs pattern): `const floatRuntime = ... / applyFloatOverrides` + the two selects, `applyHoloPrefs`
// and their `change` handlers. The test then fires `change` on the fake selects exactly as a pick would, and reads the
// live sinks (floatRuntime.soleY, SHADOW_RUNTIME.centerBackM, holo.setRim/setAccent) plus localStorage. The only
// stubs are the DOM elements and the renderer sinks; every line under test is app.js's.
//   node scripts/check-float-holo-prefs.mjs                     (npm run check:float-holo-prefs)
//   node scripts/check-float-holo-prefs.mjs --app-src <file>    run the wiring from another app.js (mutation proof)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOLO_STYLES, HOLO_COLOURS, DEFAULT_HOLO, HOLO_PREF_KEY,
  resolveHolo, readHoloPrefs, saveHoloPrefs,
} from '../src/renderer/room/float-holo-prefs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APP_SRC = path.resolve(argOf('--app-src') || path.join(ROOT, 'src', 'renderer', 'app.js'));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => { if (cond) { pass++; console.log(`PASS ${msg}`); } else { fail++; console.log(`FAIL ${msg}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); } };
// Key-order-insensitive: the shipped table and the renderer sinks name the same fields in a different order.
const norm = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])])) : o);
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

// The values copied from the r6 sweep's TOP3.md (rimMul, fresnelPower, centerBackM, soleY).
const TOP3 = {
  T1: { rimMul: 3, fresnelPower: 2, centerBackM: 0.10, soleY: 0.24 },
  T2: { rimMul: 6, fresnelPower: 3, centerBackM: 0.10, soleY: 0.21 },
  T3: { rimMul: 4, fresnelPower: 2, centerBackM: 0.16, soleY: 0.24 },
};
const SWEEP_HEX = { cyan: '#39d0ff', amber: '#ffb347' }; // the two accents the r6 sweep measured

// The shipped tables ARE the TOP3 numbers (a typo here would silently ship a look nobody measured).
for (const style of Object.keys(TOP3)) {
  ok(!!HOLO_STYLES[style], `style ${style} exists`);
  ok(eq(HOLO_STYLES[style], TOP3[style]), `style ${style} is the r6 TOP3 quadruple`, HOLO_STYLES[style]);
}
for (const colour of Object.keys(SWEEP_HEX)) ok(HOLO_COLOURS[colour] === SWEEP_HEX[colour], `colour ${colour} is the sweep hex`, HOLO_COLOURS[colour]);
ok(DEFAULT_HOLO.style === 'T1' && DEFAULT_HOLO.colour === 'cyan', 'shipped default is T1 + cyan (a starting point, not a decision)');

// ---------- the app.js wiring, cut out of the real source and run with DOM-less stubs ----------
const source = fs.readFileSync(APP_SRC, 'utf8');
const BLOCK_CACHE = new Map();
function blocksFor(src) {
  if (BLOCK_CACHE.has(src)) return BLOCK_CACHE.get(src);
  const cut = (startMarker, endMarker) => {
    const at = src.indexOf(startMarker);
    const end = at < 0 ? -1 : src.indexOf(endMarker, at);
    if (at < 0 || end < 0) throw new Error(`app.js wiring marker moved (${JSON.stringify(startMarker)} .. ${JSON.stringify(endMarker)}): update this check together with app.js`);
    return src.slice(at, end);
  };
  // The float block owns floatRuntime + applyFloatOverrides; the holo block owns the two selects, applyHoloPrefs and
  // the change handlers. They share one scope, exactly as they do inside app.js's main().
  const floatBlock = cut('const floatRuntime = { ...FLOAT };', 'const urlOverrides = parseFloatOverrides(');
  const holoBlock = cut("const holoStyleSelect = $('holo-style');", '// Jev reaction variety');
  // The boot apply is a single (well-commented) line further down, after the room state exists; it must run after the
  // handlers are declared, so it is cut on its own and replayed in the same order.
  const bootLine = src.split('\n').find((l) => l.includes('applyHoloPrefs(holoPrefs); // the saved Hologram pick first'));
  if (!bootLine) throw new Error('app.js boot apply marker moved (applyHoloPrefs(holoPrefs);): update this check together with app.js');
  const blocks = { floatBlock, holoBlock, bootLine };
  BLOCK_CACHE.set(src, blocks);
  return blocks;
}
blocksFor(source); // fail fast: the real app.js must still carry every marker

const mapStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m };
};
const throwingStorage = { getItem: () => { throw new Error('storage disabled'); }, setItem: () => { throw new Error('storage disabled'); } };

// Boots app.js's wiring against fake selects and sink recorders, and returns the live state a pick would touch.
// storage: the renderer-only store the picks persist in; appSource defaults to the real app.js.
function boot({ storage = mapStorage(), appSource = source } = {}) {
  const { floatBlock, holoBlock, bootLine } = blocksFor(appSource);
  const select = (id) => {
    const handlers = [];
    const el = { id, value: '', addEventListener: (ev, fn) => { if (ev === 'change') handlers.push(fn); }, pick: (v) => { el.value = v; handlers.forEach((fn) => fn()); } };
    return el;
  };
  const style = select('holo-style');
  const colour = select('holo-colour');
  const sink = { rim: null, accent: null, closeSoleY: null };
  const SHADOW_RUNTIME = {};
  const holo = { setRim: (o) => { sink.rim = o; }, setAccent: (hex) => { sink.accent = hex; } };
  const FLOAT = { soleY: 0.30, bobAmpM: 0.01 }; // a different start proves the pick actually writes the value
  const factory = new Function(
    '$', 'resolveHolo', 'readHoloPrefs', 'saveHoloPrefs', 'holo', 'FLOAT', 'setFloatCloseSoleY', 'SHADOW_RUNTIME', 'current', 'currentRoomV2', 'stageMode', 'placeFloat', 'engine',
    `${floatBlock}\n${holoBlock}\n${bootLine}\nreturn { floatRuntime, applyFloatOverrides, applyHoloPrefs, get prefs() { return holoPrefs; }, selects: { style: holoStyleSelect, colour: holoColourSelect } };`,
  );
  const app = factory(
    (id) => ({ 'holo-style': style, 'holo-colour': colour })[id],
    (p) => resolveHolo(p),
    () => readHoloPrefs(storage),
    (p) => saveHoloPrefs(p, storage),
    holo, FLOAT,
    (y) => { sink.closeSoleY = y; },
    SHADOW_RUNTIME, null, null, 'seated',
    () => {}, {},
  );
  return { app, sink, storage, SHADOW_RUNTIME, FLOAT, style, colour };
}
const pick = (el, v) => el.pick(v); // one real `change` event on the fake select

const readSinks = (b) => ({
  soleY: b.app.floatRuntime.soleY,
  centerBackM: b.SHADOW_RUNTIME.centerBackM,
  rimMul: b.sink.rim && b.sink.rim.rimMul,
  fresnelPower: b.sink.rim && b.sink.rim.fresnelPower,
  accent: b.sink.accent,
});
const wantSinks = (style, colour) => ({ ...TOP3[style], accent: SWEEP_HEX[colour] });

// ---------- the 6 combos: a real `change` event sets all four FH params + the accent, and saves the ids ----------
let combos = 0;
for (const style of Object.keys(TOP3)) {
  for (const colour of Object.keys(SWEEP_HEX)) {
    combos++;
    const b = boot();
    pick(b.style, style); // the owner's pick: style, then colour, each firing its real handler
    pick(b.colour, colour);
    ok(eq(readSinks(b), wantSinks(style, colour)), `${style}+${colour}: the picker's change handlers set soleY/centerBackM/rimMul/fresnelPower + accent`, readSinks(b));
    ok(b.sink.closeSoleY === TOP3[style].soleY, `${style}+${colour}: the float pose is re-solved (setFloatCloseSoleY)`, b.sink.closeSoleY);

    // Persistence: what the handler saves is what the next launch resolves (only the ids are stored).
    ok(b.storage.raw.has(HOLO_PREF_KEY) && eq(JSON.parse(b.storage.raw.get(HOLO_PREF_KEY)), { style, colour }), `${style}+${colour}: saves only {style, colour} under ${HOLO_PREF_KEY}`, b.storage.raw.get(HOLO_PREF_KEY));
    ok(b.app.prefs.style === style && b.app.prefs.colour === colour && b.app.selects.style.value === style && b.app.selects.colour.value === colour, `${style}+${colour}: both selects show what was stored`, { prefs: b.app.prefs, values: [b.app.selects.style.value, b.app.selects.colour.value] });

    const relaunch = boot({ storage: b.storage }); // same store, fresh boot: the saved pick applies itself
    ok(eq(readSinks(relaunch), wantSinks(style, colour)) && relaunch.app.selects.style.value === style && relaunch.app.selects.colour.value === colour, `${style}+${colour}: a relaunch re-applies the same FH params at boot`, readSinks(relaunch));
  }
}
ok(combos === 6, 'all 6 style x colour combos exercised', combos);

// ---------- fallbacks: a stale/hand-edited store can never disable the look ----------
const defaultSinks = () => wantSinks('T1', 'cyan');
for (const [name, storage] of [['empty storage', mapStorage()], ['bad JSON', mapStorage({ [HOLO_PREF_KEY]: '{not json' })], ['disabled storage', throwingStorage]]) {
  const b = boot({ storage });
  ok(eq(readSinks(b), defaultSinks()) && b.app.prefs.style === 'T1' && b.app.prefs.colour === 'cyan', `${name} -> T1 + cyan at boot`, readSinks(b));
}
{
  const b = boot({ storage: mapStorage({ [HOLO_PREF_KEY]: JSON.stringify({ style: 'T9', colour: 'magenta' }) }) });
  ok(eq(readSinks(b), defaultSinks()), 'unknown ids in the store -> T1 + cyan at boot', readSinks(b));
}
{
  // An unknown option cannot be stored either: the handler resolves it away and snaps the select back to what is saved.
  const b = boot();
  pick(b.colour, 'amber');
  pick(b.style, 'T9');
  ok(b.app.prefs.style === 'T1' && b.style.value === 'T1' && eq(readSinks(b), wantSinks('T1', 'amber')) && eq(JSON.parse(b.storage.raw.get(HOLO_PREF_KEY)), { style: 'T1', colour: 'amber' }), 'a rejected style snaps back to the stored one, the colour already picked stays', { prefs: b.app.prefs, select: b.style.value, sinks: readSinks(b) });
}
ok(resolveHolo({ style: 'constructor', colour: 'toString' }).style === 'T1' && resolveHolo({ style: 'constructor', colour: 'toString' }).colour === 'cyan', 'prototype keys are not accepted as ids');

// A caller mutating the resolved params must not change the shipped table (applyFloatOverrides writes floatRuntime,
// never the table).
const leaked = resolveHolo({ style: 'T2', colour: 'amber' });
leaked.params.soleY = 9;
ok(HOLO_STYLES.T2.soleY === 0.21, 'resolved params are a copy; the shipped TOP3 table stays immutable', HOLO_STYLES.T2);

// The module is renderer-only: no IPC, no main-process import (Electron main is frozen).
const self = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'room', 'float-holo-prefs.js'), 'utf8');
ok(!/ipcRenderer|ipcMain|invoke\(|require\(|from ['"][^'"]*main/.test(self), 'float-holo-prefs.js has no IPC/main dependency');

console.log(`\ncheck:float-holo-prefs ${pass}/${pass + fail} passed${APP_SRC === path.join(ROOT, 'src', 'renderer', 'app.js') ? '' : ` (wiring from ${APP_SRC})`}`);
process.exit(fail ? 1 : 0);
