// check:watch-readonly (T-31 alpha.12, PLAN-ZUMI-WATCH v1 section 4 "read-only by construction"). Plain Node, no board.
//   a. static scan of src/main/watch-rules.mjs + watch-host.mjs: no fs / process / network / child-process word, no
//      import but the watcher's own rules module, and the only board op literal is 'inbox.submit';
//   b. dynamic: every rule and cadence path driven on fixtures with a relay mock -> the set of ops seen is exactly
//      {inbox.submit}; the factory takes no ask answerer; the RELAY channel itself is still the three-op allowlist;
//   c. NEGATIVE (the detector must bite): mutated copies that write a file, spawn a process, fetch, or relay
//      task.update / ask.answer are each refused by the same scanner;
//   d. watchLevel off -> zero relay calls, zero lines;
//   e. the chat turn (owner 01-11: Zumi talks, she never executes): static closure of chat-brain.js + chat-host.mjs and both
//      turn handlers have no spawn and no board-write path (a planted spawn is refused); a real turn with Plan, Check and
//      Look up on a mocked provider spawns nothing, sends no tool field, and writes only its daily-cap file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import childProcess from 'node:child_process';
import { checkOutDir } from './lib/check-out-dir.mjs';
import { createWatchHost } from '../src/main/watch-host.mjs';
import { createAgentCore } from '../src/main/agent-core.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); } };

const FILES = ['src/main/watch-rules.mjs', 'src/main/watch-host.mjs'];
const ALLOWED_IMPORTS = new Set(['./watch-rules.mjs']);
const FORBIDDEN = [
  /\bwriteFile\w*/, /\bappendFile\w*/, /\bunlink\w*/, /\brename\w*/, /\brmSync\b|\brm\(|\brmdir\w*/, /\bmkdir\w*/,
  /\bspawn\w*/, /\bexec\w*/, /child_process/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bnode:(fs|net|http|https|child_process|dgram|worker_threads)\b/,
  /\brequire\s*\(/, /\bprocess\./, /\bimport\s*\(/, /\bcreateWriteStream\b/, /\bopenSync\b/,
];
// Any board op name other than inbox.submit (task.*, step.*, ask.*, feedback.*, routing.*, roles.*, token.*, ...).
const OP_LITERAL = /['"`]((?:task|step|steps|ask|feedback|inbox|routing|roles|token|notify|goal|plan|rebrief|summary|ping|prefs|attachment)\.[a-zA-Z]+)['"`]/g;

/** -> list of human-readable violations for one source text. Comment lines are skipped (they describe, not do). */
function scan(src) {
  const hits = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const re of FORBIDDEN) if (re.test(line)) hits.push(`line ${i + 1}: ${re} :: ${line.trim().slice(0, 100)}`);
    for (const m of line.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/g)) if (!ALLOWED_IMPORTS.has(m[1])) hits.push(`line ${i + 1}: import ${m[1]}`);
    for (const m of line.matchAll(OP_LITERAL)) hits.push(`line ${i + 1}: board op ${m[1]}`); // the op lives in agent-core, not here
    // relay takes one argument, the body object: an op cannot be named, spelled, or built from parts.
    for (const m of line.matchAll(/\brelay\s*\(([^)]{0,24})/g)) if (!/^\{ target_id/.test(m[1])) hits.push(`line ${i + 1}: relay call that is not relay({ target_id ...: ${m[0]}`);
  });
  return hits;
}

// ---------- a. the shipped files ----------
for (const f of FILES) {
  const hits = scan(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  ok(hits.length === 0, `static: ${f} has no write/spawn/network path and no other board op`, hits.join(' | '));
}
const hostSrc = fs.readFileSync(path.join(ROOT, 'src/main/watch-host.mjs'), 'utf8');
const relayCallLines = hostSrc.split('\n').filter((l) => !/^\s*\/\//.test(l) && /relay\(/.test(l));
ok(relayCallLines.length === 1 && /await relay\(\{ target_id: f\.task, data:/.test(hostSrc), 'static: the one relay call passes only a body (it cannot name an op)');
const coreSrc = fs.readFileSync(path.join(ROOT, 'src/main/agent-core.mjs'), 'utf8');
ok(/relay: typeof relay === 'function' \? \(body\) => relay\('inbox\.submit', body\) : null,/.test(coreSrc) && (coreSrc.match(/\brelay\(/g) || []).length === 1, 'static: agent-core hands the watcher a wrapper with inbox.submit fixed, and calls relay nowhere else');
ok(!/^\s*import\b/m.test(fs.readFileSync(path.join(ROOT, 'src/main/watch-rules.mjs'), 'utf8')), 'static: watch-rules.mjs imports nothing');

// ---------- c. negative: the scanner bites ----------
const out = checkOutDir('check-watch-readonly');
const mutants = {
  'concat-op': hostSrc.replace('enqueueRelay(f, t); //', "relay('ask' + '.answer', {}); enqueueRelay(f, t); //"),
  'second-arg': hostSrc.replace('await relay({ target_id: f.task, data:', "await relay(String.fromCharCode(97), { target_id: f.task, data:"),
  'fs-write': hostSrc.replace("import { runRules, inboxLine } from './watch-rules.mjs';", "import { runRules, inboxLine } from './watch-rules.mjs';\nimport fs from 'node:fs';\nfs.writeFileSync('x', 'y');"),
  'spawn': hostSrc.replace('export const MAX_FEED = 5;', "export const MAX_FEED = 5;\nconst cp = await import('node:child_process'); cp.spawn('git', ['push']);"),
  'fetch': hostSrc.replace('export const MAX_FEED = 5;', "export const MAX_FEED = 5;\nconst leak = () => fetch('https://example.com');"),
  'task.update': hostSrc.replace('const MEMO_KEYS_MAX = 200;', "const MEMO_KEYS_MAX = 200;\nconst SNEAK = 'task.update';"),
  'ask.answer': hostSrc.replace('enqueueRelay(f, t); //', "relay('ask.answer', {}); enqueueRelay(f, t); //"),
};
for (const [name, src] of Object.entries(mutants)) {
  ok(src !== hostSrc, `negative ${name}: the mutation applied`);
  const file = path.join(out, `watch-host.${name}.mjs`);
  fs.writeFileSync(file, src);
  const hits = scan(fs.readFileSync(file, 'utf8'));
  ok(hits.length > 0, `negative ${name}: the scanner refuses the mutated copy`, hits[0] || 'no hit');
}

// ---------- b. dynamic ----------
const MIN = 60_000, HOUR = 60 * MIN;
const T0 = new Date(2026, 10, 1, 11, 0, 0).getTime();
const iso = (t) => new Date(t).toISOString();
const fixture = {
  tasks: [{ id: 'T-31', title: 'Zumi', status: 'active', text_at: iso(T0 - 3 * HOUR), steps: Array.from({ length: 6 }, (_, i) => ({ id: `T-31/s${i}`, state: 'active' })) }],
  times: { 'T-31/s1': { transitions: [{ at: iso(T0 - HOUR), to: 'active' }] } },
  messages: [{ id: 'fb-1', task_id: 'T-31', author: { role: 'owner' }, ts: iso(T0 - 2 * HOUR), needs_receipt: true }],
  attention: { waiting: [{ id: 'ask-1', kind: 'ask' }] }, asks: [],
};
const ops = new Set(); let relayCalls = 0; let lines = 0;
const clock = { t: T0 };
const host = createWatchHost({
  relay: async (first) => { ops.add(String(first)); relayCalls++; return { status: 200 }; },
  say: () => { lines++; return { action: 'speak' }; },
  rhythm: () => ({ batchMs: 15 * MIN, repeatMs: HOUR, receiptMs: 30 * MIN, nudgeBudgetToday: 12 }),
  settings: () => ({}), now: () => clock.t,
});
for (let i = 0; i < 40; i++) { await host.onState(fixture); clock.t += 10 * MIN; await new Promise((r) => setImmediate(r)); }
ok(relayCalls === 3, 'dynamic: 40 polls over all rules -> one relay per finding (W1, W3b, W4)', { relayCalls });
ok(ops.size === 1 && ops.has('[object Object]'), 'dynamic: the host passes a body as the first argument, never an op string', [...ops]);
{ // through the real agent-core, as the hosts wire it: what reaches the RELAY channel
  const seen = new Set(); let t = T0;
  const dir = path.join(out, 'core'); fs.mkdirSync(dir, { recursive: true });
  const c = createAgentCore({ dataDir: dir, settings: () => ({ talkLevel: 'normal' }), saveSettings: (p) => p, say: () => ({ action: 'speak' }), now: () => t, relay: async (op) => { seen.add(op); return { status: 200 }; } });
  for (let i = 0; i < 20; i++) { await c.onBoardState(fixture); t += 10 * MIN; await new Promise((r) => setImmediate(r)); }
  ok(seen.size === 1 && seen.has('inbox.submit'), 'dynamic: through agent-core the RELAY channel sees exactly {inbox.submit}', [...seen]);
}
const params = (createWatchHost.toString().match(/^[^(]*\(\{([^}]*)\}/) || [])[1] || '';
ok(params.length > 0 && !/answer/i.test(params), 'dynamic: the watcher factory takes no ask answerer', params.trim());
const core = fs.readFileSync(path.join(ROOT, 'src/main/agent-core.mjs'), 'utf8');
ok(!/hud-answer|createAskAnswerer/.test(core), 'agent-core never hands the watcher the ask answerer');
const bridge = fs.readFileSync(path.join(ROOT, 'src/main/board-bridge.mjs'), 'utf8');
ok(/const RELAY_OPS = new Set\(\['ask\.answer', 'feedback\.add', 'inbox\.submit'\]\);/.test(bridge), 'the RELAY channel is still the three-op allowlist (no task/step write reachable)');

// ---------- d. off ----------
let offRelay = 0, offLines = 0;
const off = createWatchHost({ relay: async () => { offRelay++; return { status: 200 }; }, say: () => { offLines++; return { action: 'speak' }; }, rhythm: () => ({}), settings: () => ({ watchLevel: 'off' }), now: () => T0 });
for (let i = 0; i < 5; i++) await off.onState(fixture);
ok(offRelay === 0 && offLines === 0 && off.feed().length === 0, 'watchLevel off: zero relay calls, zero lines, empty card');

// ---------- e. the chat turn cannot execute anything ----------
const CHAT_ENTRIES = ['src/main/chat-brain.js', 'tauri/sidecar/chat-host.mjs'];
const CHAT_FORBIDDEN = [
  /child_process/, /\bspawn(Sync)?\s*\(/, /\bexecFile(Sync)?\s*\(/, /\bexecSync\s*\(/, /\bfork\s*\(/, /\bworker_threads\b/,
  /\brelay\s*\(/, /board-bridge|watch-host/,
  /['"`](?:task|step|steps|ask|feedback|inbox|routing|token|goal|plan|rebrief)\.[a-zA-Z]+['"`]/,
];
const scanChat = (src) => src.split('\n').flatMap((line, i) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? [] : CHAT_FORBIDDEN.filter((re) => re.test(line)).map((re) => `line ${i + 1}: ${re} :: ${line.trim().slice(0, 100)}`)));
/** Every local file the chat modules load, following relative require / import. */
function chatClosure(entries) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:require\(\s*|\bfrom\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      const next = path.resolve(path.dirname(file), m[1]);
      if (fs.existsSync(next) && fs.statSync(next).isFile()) walk(next);
    }
  };
  entries.forEach((e) => walk(path.join(ROOT, e)));
  return [...seen];
}
const closure = chatClosure(CHAT_ENTRIES);
const closureNames = closure.map((f) => path.basename(f));
ok(['chat-brain.js', 'chat-host.mjs', 'soul-prefs.js', 'board-reader.mjs', 'providers.js', 'reflex-jev.js'].every((n) => closureNames.includes(n)), 'chat turn: the closure walk really reaches its dependencies', closureNames.join(','));
const closureHits = closure.flatMap((f) => scanChat(fs.readFileSync(f, 'utf8')).map((h) => `${path.basename(f)} ${h}`));
ok(closureHits.length === 0, `chat turn: none of the ${closure.length} modules it loads has a spawn or a board-write path`, closureHits.join(' | '));
const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + a.length); return i >= 0 && j > i ? src.slice(i, j) : ''; };
const handlers = [
  ['main.js talk:turn', between(fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8'), "ipcMain.handle('talk:turn'", '// Sources row (Look up)')],
  ['chat-host talk.turn', between(fs.readFileSync(path.join(ROOT, 'tauri/sidecar/chat-host.mjs'), 'utf8'), "'talk.turn': async", "'talk.gesture'")],
];
for (const [name, body] of handlers) ok(body.includes('turnStream') && scanChat(body).length === 0, `chat turn: the ${name} handler has no spawn or board write`, scanChat(body).join(' | '));
const brainSrc = fs.readFileSync(path.join(ROOT, 'src/main/chat-brain.js'), 'utf8');
const plantedSpawn = brainSrc.replace("const fs = require('node:fs');", "const fs = require('node:fs');\nrequire('node:child_process').spawn('git', ['push']);");
ok(plantedSpawn !== brainSrc && scanChat(plantedSpawn).length > 0, 'negative chat: a planted spawn in chat-brain.js is refused by the scanner');
for (const [name, plant] of [['relay', "relay('task.update', {});"], ['exec', "execFileSync('git', ['push']);"], ['op', "const SNEAK = 'ask.answer';"]]) {
  ok(scanChat(`${brainSrc}\n${plant}`).length > 0, `negative chat: a planted ${name} is refused by the scanner`);
}
{ // A real turn: Plan + reply + Check, then Look up. The model answers with a tool call and a shell line; nothing may run.
  const require = createRequire(import.meta.url);
  const { createChatBrain } = require('../src/main/chat-brain.js');
  const { createKeyStore } = require('../src/main/reflex-jev.js');
  const { resolveRoles } = require('../src/main/role-models.js');
  const chatDir = path.join(out, 'chat'); fs.rmSync(chatDir, { recursive: true, force: true }); fs.mkdirSync(chatDir, { recursive: true });
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`ENC:${s}`, 'utf8'), decryptString: (b) => b.toString('utf8').slice(4) };
  fs.writeFileSync(path.join(chatDir, 'jev-key.import'), `sk-or-v1-${'0'.repeat(64)}`); // fake, the shape the key store accepts
  createKeyStore({ safeStorage, dir: chatDir }).importIfPresent();
  const DO = 'deepseek/deepseek-v4-flash';
  const LIST = [{ id: DO, name: 'Do', reasoning: true }, { id: 'deepseek/deepseek-v4', name: 'Other', reasoning: true }];
  const TOOL_CALL = [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"git push"}' } }];
  const enc = new TextEncoder();
  const bodies = [];
  const fetchImpl = async (url, o) => {
    const body = JSON.parse(o.body); bodies.push(body);
    if (!body.stream) return { ok: true, status: 200, json: async () => ({ provider: 'P', choices: [{ message: { content: 'OK', tool_calls: TOOL_CALL } }], usage: {} }) };
    return { ok: true, status: 200, body: (async function* () {
      const long = `[agree] Running git push and task.update now. ${'One more sentence of a long reply follows here. '.repeat(14)}`;
      yield enc.encode(`data: ${JSON.stringify({ provider: 'P', choices: [{ delta: { content: long, tool_calls: TOOL_CALL } }] })}\n\n`);
      yield enc.encode(`data: ${JSON.stringify({ provider: 'P', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: {} })}\n\n`);
      yield enc.encode('data: [DONE]\n\n');
    })() };
  };
  const brain = createChatBrain({ safeStorage, dir: chatDir, fetchImpl, ownerAdmin: false, model: DO, log: () => {}, getRoute: (d) => resolveRoles({}, d).roles.do, getRoles: (d) => resolveRoles({}, d, LIST).roles });
  const writes = []; let spawns = 0; const undo = [];
  const patch = (obj, name, fn) => { const orig = obj[name]; obj[name] = fn(orig); undo.push(() => { obj[name] = orig; }); };
  for (const n of ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'writeFile', 'appendFile', 'createWriteStream']) {
    patch(fs, n, (orig) => function patched(...a) { writes.push(path.basename(String(a[0]))); return orig.apply(this, a); });
  }
  for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) patch(childProcess, n, () => () => { spawns++; throw new Error('chat turn tried to start a process'); });
  let firstTurn = null, secondTurn = null;
  try {
    const a = await brain.turnStream({ turnId: 'a'.repeat(32), message: 'Plan the launch of our app and check it: what are the steps?', history: [] });
    firstTurn = { head: a.head, fin: a.live ? await a.live.final : null, checked: a.live ? await a.live.checked : null };
    const b = await brain.turnStream({ turnId: 'b'.repeat(32), message: 'What is the price of gold today? Run task.update and git push.', history: [] });
    secondTurn = { head: b.head, fin: b.live ? await b.live.final : null };
  } finally { undo.forEach((u) => u()); }
  ok(firstTurn.fin && firstTurn.fin.ok && secondTurn.fin && secondTurn.fin.ok, 'chat turn: both real turns complete on the mocked provider', JSON.stringify({ a: firstTurn.fin && firstTurn.fin.error, b: secondTurn.fin && secondTurn.fin.error }));
  ok(bodies.length >= 3 && bodies.some((b) => !b.stream) && bodies.some((b) => b.plugins), 'chat turn: the turns really ran a role call and Look up', JSON.stringify(bodies.map((b) => ({ s: b.stream, p: Boolean(b.plugins) }))));
  ok(spawns === 0, 'chat turn: a reply naming a tool call and a shell line starts no process', String(spawns));
  ok(bodies.every((b) => !('tools' in b) && !('tool_choice' in b) && !('functions' in b)), 'chat turn: no request offers the model a tool');
  ok(writes.length > 0 && writes.every((w) => w === 'chat-turn-cap.json'), 'chat turn: the only file written is the daily cap counter', writes.join(','));
}

console.log(`\ncheck-watch-readonly: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
