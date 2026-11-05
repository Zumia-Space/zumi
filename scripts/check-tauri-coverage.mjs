// T-31 parity step A: the coverage meter. Plain Node, no Electron, nothing opened, no network.
//
// What share of the frozen API surface does the Tauri preview answer for real?
//   rpc    = every inventory invoke/send name that has a sidecar handler (tauri/sidecar/main.mjs `handlers`, including a
//            flavour-gated spread `...(cond ? { 'x': ... } : {})`: the owner-only phone.status), or that the Rust host answers
//            itself: a `match method { "x" => ... }` arm of a `from_method` that lib.rs routes (`<module>::<Type>::from_method(&method)`,
//            e.g. phone.* in phone_pair.rs).
//   events = every inventory event channel that Rust or the sidecar actually emits (a Rust emit_to(label, "x") or
//            events::emit_main(app, "x", ...), or a sidecar `emit('x', ...)` call: a PRODUCER exists).
//   event path = every inventory event channel the host will forward (generated ALLOWED_EVENT_CHANNELS).
//            scripts/check-tauri-events.mjs round-trips each one. The path is not a producer: a channel
//            counts as answered only once something really emits it.
// It prints answered/total and the percentage per family and overall, then compares against the recorded
// baseline (docs/migration/coverage-baseline.json). It FAILS only on a regression: a name the baseline
// records as answered that is no longer answered. A growing denominator (an inventory fold) never fails it.
//
//   node scripts/check-tauri-coverage.mjs                  # print the meter, compare with the baseline
//   node scripts/check-tauri-coverage.mjs --write-baseline # record the current answered names (ratchet up)
//   node scripts/check-tauri-coverage.mjs --require-full   # fail unless every non-exempt name is answered
//
// Exemptions are named, never silent: each row cites the file that grants it, and --require-full fails unless that file
// exists in this tree AND is part of the public source (not scripts/lib/zumi-only.cjs PUBLIC_REPO_EXCLUDE), so the exported
// tree can run the same gate. Exempt names still count in the printed meter (the honest denominator); only
// the --require-full gate ignores them.
//
// Measured statically from the source, so it never starts the sidecar (which would run real handlers).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = path.join(ROOT, 'docs', 'migration', 'api-inventory.json');
const BASELINE = path.join(ROOT, 'docs', 'migration', 'coverage-baseline.json');
const SIDECAR_DIR = path.join(ROOT, 'tauri', 'sidecar');
const RUST_DIR = path.join(ROOT, 'tauri', 'src-tauri', 'src');
const { isPublicRepoExcluded } = createRequire(import.meta.url)('./lib/zumi-only.cjs');

// Parity 13a: the names T1 deliberately does not answer, each with the gate that grants the exemption. Empty since alpha.14:
// update:state was exempt ("update activation off in preview"), but the public build's updater is on and emits it
// (updater.rs events::emit_main), which the meter now reads.
// (board.liveOpen + /__zumi-open were exempt here, waived to P2 by GATE-10b; P3-B implements both in the OWNER flavour,
// scripts/check-tauri-board-live-open.mjs. The public flavour still answers not_implemented:board.liveOpen, asserted by
// check-tauri-sidecar.mjs / check-tauri-ai-settings.mjs, so a faked success cannot hide behind this table.)
export const EXEMPTIONS = [];
// Behaviour drift the T1 preview accepts on purpose (cos-bc ruling). Not an rpc/event name, so it lives beside the table
// above, under the same rule: each row cites a file that exists AND the marker text inside it, and --require-full fails
// if either is missing. Cited, never silent.
//   selftest.room.default-v1 -- the preview does not offer the v1 'default' room (a dev-PC file, boot-reads.mjs
//     listRooms); the shipped default is 'default-v2'. The selftest room case asserts the v2 default loads instead.
export const BEHAVIOUR_DRIFT = [
  {
    name: 'selftest.room.default-v1',
    // The owner decision and the code that carries it out (src/main/room-default.mjs, since 0.2.11). docs/migration/DRIFT.md
    // (23-10, cos-bc ruling) keeps the full record but is not in the public tree.
    cite: path.join(ROOT, 'src', 'main', 'room-default.mjs'),
    section: 'header + RETIRED_ROOMS',
    marker: `owner decision (default-room-q, 2026-10-26): room v1 "Zumi's Office" (id 'default') is removed from the`,
    enforces: /^export const RETIRED_ROOMS = \['default'\];$/m,
    why: 'The preview lists no v1 default room by design (room v1 removed, owner 2026-10-26); the selftest room case asserts the v2 default room loads.',
  },
];
const EXEMPT_NAMES = new Set(EXEMPTIONS.map((row) => row.name));
// An event row may be written as its channel (`update:state`), an rpc row as its inventory name.
const isExempt = (api) => EXEMPT_NAMES.has(api.name) || (api.channel && EXEMPT_NAMES.has(api.channel));

/** Keys of the sidecar's `const handlers = { ... }` object: the 4-space-indented keys up to its closing `  };`. */
export function sidecarHandlerNames(source, resolveSpread = () => []) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => /^ {2}const handlers = \{\s*$/.test(l));
  if (start < 0) throw new Error('sidecar main.mjs: `const handlers = {` not found');
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\};\s*$/.test(lines[i])) return names;
    const m = lines[i].match(/^ {4}(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/);
    if (m) names.push(m[1] || m[2] || m[3]);
    const spread = lines[i].match(/^ {4}\.\.\.([A-Za-z_$][\w$]*)\(/);
    if (spread) names.push(...resolveSpread(spread[1]));
  }
  throw new Error('sidecar main.mjs: the handlers object never closes');
}

/** Keys of the object an exported sidecar factory returns (`export function name(` ... `  return {` ... `  };`), for `...name(...)` spreads. */
export function factoryHandlerNames(source, fnName) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`export function ${fnName}(`));
  if (start < 0) return [];
  const names = [];
  let inReturn = false;
  for (let i = start + 1; i < lines.length && !/^\}/.test(lines[i]); i++) {
    if (/^ {2}return \{\s*$/.test(lines[i])) { inReturn = true; continue; }
    if (inReturn && /^ {2}\};?\s*$/.test(lines[i])) break;
    const m = inReturn && lines[i].match(/^ {4}(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/);
    if (m) names.push(m[1] || m[2] || m[3]);
  }
  return names;
}

// Spread handlers (`...createImportRpc({...})`) are resolved by scanning the factory in any sidecar module.
function spreadNames(fnName) {
  for (const f of fs.readdirSync(SIDECAR_DIR)) {
    if (!f.endsWith('.mjs')) continue;
    const names = factoryHandlerNames(fs.readFileSync(path.join(SIDECAR_DIR, f), 'utf8'), fnName);
    if (names.length) return names;
  }
  return [];
}

/** Event channels a sidecar module pushes through `emit('x', ...)` (the createEmitter helper), skipping comments. */
export function sidecarEmittedChannels(source) {
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  const out = new Set();
  for (const m of code.matchAll(/\bemit\(\s*['"]([a-z][A-Za-z]*:[A-Za-z]+)['"]/g)) out.add(m[1]);
  return out;
}

/** Event channels emitted by Rust (`emit("x"` / `emit_to(label, "x"` / `events::emit_main(app, "x"`), skipping comments. */
export function emittedChannels(source) {
  const code = source.replace(/\/\/[^\n]*/g, '');
  const out = new Set();
  for (const m of code.matchAll(/\.emit(?:_to)?\(\s*(?:[A-Za-z_][\w:]*\s*,\s*)?"([^"]+)"/g)) out.add(m[1]);
  for (const m of code.matchAll(/\bemit_main\(\s*[A-Za-z_&][\w.&]*\s*,\s*"([^"]+)"/g)) out.add(m[1]);
  return out;
}

/** Keys of the flavour-gated spreads inside `const handlers = {`: `...(cond ? { 'x': ... } : {})`, on one line or as a block. */
export function conditionalHandlerNames(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => /^ {2}const handlers = \{\s*$/.test(l));
  const names = [];
  for (let i = start + 1; start >= 0 && i < lines.length && !/^ {2}\};\s*$/.test(lines[i]); i++) {
    if (!/^ {4}\.\.\.\(.*\?\s*\{/.test(lines[i])) continue;
    if (/\?\s*\{\s*$/.test(lines[i])) {
      for (i++; i < lines.length && !/^ {4}\}/.test(lines[i]); i++) {
        const m = lines[i].match(/^ {6}(?:'([^']+)'|"([^"]+)")\s*:/);
        if (m) names.push(m[1] || m[2]);
      }
    } else {
      for (const m of lines[i].slice(lines[i].indexOf('?')).matchAll(/'([^']+)'\s*:|"([^"]+)"\s*:/g)) names.push(m[1] || m[2]);
    }
  }
  return names;
}

/**
 * Rust source with the comments and the #[cfg(test)] modules taken out, string literals kept: what the shipped host runs.
 * A `//` inside a string (a URL) is not a comment; a brace inside a string does not end a module.
 */
export function rustCode(source) {
  const noComments = source.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ''));
  let out = '';
  let at = 0;
  const testMod = /#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
  for (let m; (m = testMod.exec(noComments));) {
    out += noComments.slice(at, m.index);
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < noComments.length && depth > 0; i++) {
      const c = noComments[i];
      if (c === '"') { for (i++; i < noComments.length && noComments[i] !== '"'; i++) if (noComments[i] === '\\') i++; }
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    at = i;
    testMod.lastIndex = i;
  }
  return out + noComments.slice(at);
}

/** Event channels the shipped Rust host emits (emittedChannels over rustCode: no comment, no test module). */
export function rustEmittedChannels(source) {
  return emittedChannels(rustCode(source));
}

/** rpc names the Rust host answers itself: the `"x" =>` arms of each `fn from_method` whose module lib.rs routes (code only, not comments or tests). */
export function rustInterceptNames(rustFiles, libSource) {
  const routed = new Set([...rustCode(libSource).matchAll(/\b(\w+)::\w+::from_method\(&method\)/g)].map((m) => m[1]));
  const names = [];
  for (const [file, rawSource] of rustFiles) {
    if (!routed.has(path.basename(file, '.rs'))) continue;
    const source = rustCode(rawSource);
    for (const fn of source.matchAll(/fn from_method\(method: &str\)[^{]*\{\s*match method \{([\s\S]*?)\n\s*\}/g)) {
      for (const m of fn[1].matchAll(/"([^"]+)"\s*=>/g)) names.push(m[1]);
    }
  }
  return names;
}

const family = (name) => (name.includes('.') ? name.split('.')[0] : '(top level)');

function measure() {
  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  const apis = inventory.apis || [];
  const mainSource = fs.readFileSync(path.join(SIDECAR_DIR, 'main.mjs'), 'utf8');
  const handlers = new Set(sidecarHandlerNames(mainSource, spreadNames).filter((n) => !n.startsWith('__')));
  const rustFiles = fs.readdirSync(RUST_DIR).filter((f) => f.endsWith('.rs')).map((f) => [f, fs.readFileSync(path.join(RUST_DIR, f), 'utf8')]);
  const libSource = fs.readFileSync(path.join(RUST_DIR, 'lib.rs'), 'utf8');
  const inventoryNameSet = new Set(apis.map((a) => a.name));
  // Gated and Rust-answered names count only when inventoried (a test-only gated name such as board.testBridgeAuth is neither).
  const extraAnswers = new Set([...conditionalHandlerNames(mainSource), ...rustInterceptNames(rustFiles, libSource)].filter((n) => inventoryNameSet.has(n)));
  const emitted = new Set();
  for (const [, src] of rustFiles) for (const c of rustEmittedChannels(src)) emitted.add(c);
  for (const f of fs.readdirSync(SIDECAR_DIR)) if (f.endsWith('.mjs')) { const src = fs.readFileSync(path.join(SIDECAR_DIR, f), 'utf8'); for (const c of [...emittedChannels(src), ...sidecarEmittedChannels(src)]) emitted.add(c); }

  const rpc = apis.filter((a) => a.kind === 'invoke' || a.kind === 'send');
  const events = apis.filter((a) => a.kind === 'event');
  const rpcAnswered = rpc.filter((a) => handlers.has(a.name) || extraAnswers.has(a.name)).map((a) => a.name).sort();
  const eventAnswered = events.filter((a) => emitted.has(a.channel)).map((a) => a.name).sort();
  const allowListSource = fs.readFileSync(path.join(RUST_DIR, 'rpc_allow_list.rs'), 'utf8');
  const channelBlock = (allowListSource.match(/ALLOWED_EVENT_CHANNELS[^=]*=\s*&\[([\s\S]*?)\];/) || ['', ''])[1];
  const allowedChannels = new Set([...channelBlock.matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  const eventPath = events.filter((a) => allowedChannels.has(a.channel)).map((a) => a.name).sort();
  const inventoryNames = new Set(apis.map((a) => a.name));
  const strayHandlers = [...handlers].filter((n) => !inventoryNames.has(n)).sort();
  return { rpc, events, rpcAnswered, eventAnswered, eventPath, strayHandlers, handlerCount: handlers.size };
}

const pct = (a, t) => (t === 0 ? '0.0' : ((100 * a) / t).toFixed(1));

function main() {
  let pass = 0;
  let fail = 0;
  const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };

  const m = measure();
  ok(m.handlerCount >= 10 && m.rpcAnswered.includes('info'), 'sanity: the sidecar handler table parsed (info + the P1c4 answers are present)');
  // Self-check (review N-c): a route, a match arm or an emit that is only in a comment, or only in a #[cfg(test)] module, is not counted.
  {
    const lib = 'fn rpc(method: String) {\n    // if let Some(op) = ghost::Op::from_method(&method) {}\n    /* if let Some(op) = ghost2::Op::from_method(&method) {} */\n    if let Some(op) = real::Op::from_method(&method) {}\n}\n';
    const opFile = (n) => `impl Op {\n    pub fn from_method(method: &str) -> Option<Op> {\n        match method {\n            "${n}.a" => Some(Op::A),\n            // "${n}.commented" => Some(Op::B),\n            _ => None,\n        }\n    }\n}\n`;
    const real = `${opFile('real')}fn push(app: &AppHandle) {\n    events::emit_main(app, "real:event", json!({ "url": "https://x" }));\n}\n// events::emit_main(app, "comment:event", json!({}));\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {\n        let s = "a { brace";\n        events::emit_main(&views, "test:event", json!({}));\n    }\n}\n`;
    const names = rustInterceptNames([['real.rs', real], ['ghost.rs', opFile('ghost')], ['ghost2.rs', opFile('ghost2')]], lib);
    ok(names.join(',') === 'real.a', 'meter self-check: a routed from_method arm counts; a commented route or arm does not', names.join(','));
    const ev = typeof rustEmittedChannels === 'function' ? [...rustEmittedChannels(real)].sort().join(',') : 'no rustEmittedChannels';
    ok(ev === 'real:event', 'meter self-check: a Rust emit counts; one in a comment or a #[cfg(test)] module does not', ev);
  }
  ok(m.strayHandlers.length === 0, 'every sidecar handler (except __host.*) is an inventoried name', m.strayHandlers.join(', '));

  const answered = new Set([...m.rpcAnswered, ...m.eventAnswered]);
  const fam = new Map();
  for (const a of [...m.rpc, ...m.events]) {
    const f = family(a.name);
    const row = fam.get(f) || { rpc: [0, 0], ev: [0, 0] };
    const cell = a.kind === 'event' ? row.ev : row.rpc;
    cell[1]++;
    if (answered.has(a.name)) cell[0]++;
    fam.set(f, row);
  }
  console.log('\nfamily            rpc answered/total   events answered/total');
  for (const [f, r] of [...fam].sort((x, y) => x[0].localeCompare(y[0]))) {
    console.log(`${f.padEnd(17)} ${`${r.rpc[0]}/${r.rpc[1]}`.padEnd(20)} ${r.ev[1] ? `${r.ev[0]}/${r.ev[1]}` : '-'}`);
  }
  const rt = m.rpc.length;
  const et = m.events.length;
  const all = m.rpcAnswered.length + m.eventAnswered.length;
  const inventoryNames = [...m.rpc, ...m.events];
  const nonExempt = inventoryNames.filter((a) => !isExempt(a));
  const nonExemptAnswered = nonExempt.filter((a) => answered.has(a.name));
  console.log(`\nevent path (host forwards, round-trip tested): ${m.eventPath.length}/${et}   producers (something emits it): ${m.eventAnswered.length}/${et}`);
  console.log(`\nCOVERAGE rpc ${m.rpcAnswered.length}/${rt} = ${pct(m.rpcAnswered.length, rt)}%   events ${m.eventAnswered.length}/${et} = ${pct(m.eventAnswered.length, et)}%   total ${all}/${rt + et} = ${pct(all, rt + et)}%`);
  console.log(`non-exempt ${nonExemptAnswered.length}/${nonExempt.length} = ${pct(nonExemptAnswered.length, nonExempt.length)}%   exemptions ${EXEMPTIONS.length}: ${EXEMPTIONS.map((r) => r.name).join(', ')}\n`);

  if (process.argv.includes('--write-baseline')) {
    const record = {
      note: 'Names the Tauri preview answered when recorded. check-tauri-coverage fails if any of these stops being answered. Ratchet up with --write-baseline when a parity increment lands.',
      recordedAgainst: JSON.parse(fs.readFileSync(INVENTORY, 'utf8')).talkModeFold ? 'inventory with talkModeFold (131 names)' : 'inventory without talkModeFold',
      rpc: { answered: m.rpcAnswered.length, total: rt, names: m.rpcAnswered },
      events: { answered: m.eventAnswered.length, total: et, names: m.eventAnswered },
      eventPath: { ready: m.eventPath.length, total: et, names: m.eventPath },
    };
    fs.writeFileSync(BASELINE, JSON.stringify(record, null, 2) + '\n');
    console.log(`baseline written: ${path.relative(ROOT, BASELINE)}`);
    return 0;
  }

  ok(fs.existsSync(BASELINE), 'a coverage baseline is recorded (docs/migration/coverage-baseline.json)');
  if (fs.existsSync(BASELINE)) {
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const lostRpc = (base.rpc.names || []).filter((n) => !m.rpcAnswered.includes(n));
    const lostEvents = (base.events.names || []).filter((n) => !m.eventAnswered.includes(n));
    ok(lostRpc.length === 0, `no rpc name fell below the baseline (${base.rpc.answered} recorded)`, `no longer answered: ${lostRpc.join(', ')}`);
    ok(lostEvents.length === 0, `no event fell below the baseline (${base.events.answered} recorded)`, `no longer emitted: ${lostEvents.join(', ')}`);
    const lostPath = ((base.eventPath || {}).names || []).filter((n) => !m.eventPath.includes(n));
    ok(lostPath.length === 0, `no event channel fell out of the delivery path (${(base.eventPath || {}).ready || 0} recorded)`, `no longer forwarded: ${lostPath.join(', ')}`);
    ok(m.rpcAnswered.length >= base.rpc.answered && m.eventAnswered.length >= base.events.answered, 'answered counts are at or above the baseline');
    const ahead = m.rpcAnswered.length + m.eventAnswered.length - base.rpc.answered - base.events.answered;
    if (ahead > 0) console.log(`NOTE ${ahead} name(s) are answered beyond the baseline: run with --write-baseline to ratchet it up`);
  }

  if (process.argv.includes('--require-full')) {
    const unanswered = nonExempt.filter((a) => !answered.has(a.name)).map((a) => a.name).sort();
    ok(unanswered.length === 0, `--require-full: every non-exempt inventory name is answered (${nonExemptAnswered.length}/${nonExempt.length})`,
      `unanswered: ${unanswered.join(', ')}`);
    const inTree = (cite) => fs.existsSync(cite) && !isPublicRepoExcluded(path.relative(ROOT, cite).split(path.sep).join('/'));
    for (const row of EXEMPTIONS) {
      ok(inTree(row.cite), `--require-full: exemption "${row.name}" cites a file of this tree that the public source keeps`, `missing or not exported: ${row.cite}`);
    }
    for (const row of BEHAVIOUR_DRIFT) {
      const text = fs.existsSync(row.cite) ? fs.readFileSync(row.cite, 'utf8') : '';
      ok(inTree(row.cite) && text.includes(row.marker), `--require-full: behaviour drift "${row.name}" is cited in ${path.relative(ROOT, row.cite)} (${row.section}), a file the public source keeps`, `missing, not exported, or no marker "${row.marker}" in ${row.cite}`);
      // Review N-d: the cite is the code that makes the drift true, not a note written for this gate.
      ok(row.enforces instanceof RegExp && row.enforces.test(text), `--require-full: behaviour drift "${row.name}" cites the code that enforces it`, `no ${row.enforces} in ${row.cite}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
