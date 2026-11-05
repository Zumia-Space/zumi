// Node checks for the talk path (no model, no Electron, no network):
//   speech library data, the speech-gesture gate, the analysis gate, the gesture cache, and the main-process cloud
//   client's contract v1 rules (payload validation, allowlisted origin, no redirect, bearer only on the desktop routes,
//   token never logged, one TTS / one gesture per successful turn, safeStorage-only token store).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SpeechLibrary } from '../src/renderer/talk/library.js';
import { checkSpeechGesture, checkAnalysis } from '../src/renderer/talk/validate.js';
import { isFaceOnly } from '../src/renderer/reflex/player.js';
import { GestureCache, commandHash } from '../src/renderer/talk/cache.js';
import { INTENTS, cacheKey, durBucket, deixisSide } from '../src/renderer/talk/intents.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const cloudMod = require('../src/main/cloud.js');
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'main', 'cloud-fixtures.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---------- library ----------
const speechDir = path.join(ROOT, 'src', 'renderer', 'reflex', 'speech');
const lib = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(speechDir, f), 'utf8')), () => 0.3);
ok(lib.byIntent.size === INTENTS.length, 'library: one file per intent of this round', `${lib.byIntent.size}`);
ok(lib.total() === 13, 'library: 8 approach-C seeds + 5 P5 variants (coordinator eye-QC 01-10) load and pass the speech gate', `${lib.total()}`);
for (const it of ['greet', 'point-screen', 'think', 'celebrate', 'agree', 'explain']) ok(lib.count(it) === 2, `library: ${it} has 2 LLM-authored variants`, String(lib.count(it)));
ok(lib.count('disagree') === 1, 'library: disagree has 1 variant (target 3; the live cache fills it after the flag is on)');
// energy-tagged variants: the stern refusal (hand on hip + shake) is never chosen for a soft (low-energy) refusal
{
  const d = lib.byIntent.get('disagree').variants[0];
  ok(d.id === 'disagree-p5-3' && JSON.stringify(d.energies) === '["mid","high"]', 'library: disagree-p5-3 is tagged energies mid/high');
  ok(lib.pick('disagree', 'low') === null, 'selector: no disagree variant for a low-energy (soft) refusal');
  ok(lib.pick('disagree', 'mid').id === 'disagree-p5-3' && lib.pick('disagree', 'high').id === 'disagree-p5-3', 'selector: disagree-p5-3 for mid and high energy');
  ok(lib.pick('agree', 'low') !== null, 'selector: untagged variants serve every energy');
  const { TalkDirector } = await import('../src/renderer/talk/director.js');
  const stubCache = { pick: () => null };
  const dir = new TalkDirector({ engine: null, catalog: { get: () => null }, cloud: null, speech: null, library: lib, cache: stubCache, saveCache() {}, probe: () => null, rigVersion: () => 'x', ui: {}, log() {} });
  ok(dir.pickAtStart({}, { intent: 'disagree', energy: 'low', deixis: 'none' }, 'k') === null, 'director: a soft refusal at speech start gets no stern gesture (intent fallback covers it)');
  const hi = dir.pickAtStart({}, { intent: 'disagree', energy: 'high', deixis: 'none' }, 'k');
  ok(hi && hi.source === 'library' && hi.id === 'disagree-p5-3', 'director: a firm refusal gets disagree-p5-3 from the library');
  // the built-in fallback still serves an intent whose library has nothing fitting (stub library: empty)
  const nod = { id: 'nod', command: { id: 'nod' } };
  const fb = new TalkDirector({ engine: null, catalog: { get: (n) => (n === 'send' ? { variants: [nod] } : null) }, cloud: null, speech: null, library: { pick: () => null }, cache: stubCache, saveCache() {}, probe: () => null, rigVersion: () => 'x', ui: {}, log() {} });
  const b = fb.pickAtStart({}, { intent: 'agree', energy: 'mid', deixis: 'none' }, 'k');
  ok(b && b.source === 'builtin' && b.id === 'send/nod', 'director: with no fitting library variant, agree falls back to the built-in nod');
  let bad = null;
  try { await SpeechLibrary.load(async (file) => (file === 'index.json' ? { intents: ['disagree'] } : { intent: 'disagree', variants: [{ id: 'x', energies: ['loud'], command: d.command }] })); } catch (e) { bad = e.message; }
  ok(Boolean(bad && /energies must be/.test(bad)), 'library: an unknown energy tag stops the load', String(bad));
}
{ const a = lib.pick('greet').id, b = lib.pick('greet').id; ok(a !== b, 'library: never the same variant twice in a row'); }

// ---------- speech-gesture gate ----------
const seed = lib.pick('greet').command;
const commands = Object.fromEntries(Object.entries(fixtures.gestures).map(([k, v]) => [k, v.command]));
ok(checkSpeechGesture(commands['Mình làm bản thử trước nhé, được không?']).ok, 'gate: composed nod passes');
{ const r = checkSpeechGesture(commands['Thử một cử chỉ cần kẹp góc nhé.']); ok(!r.ok && r.errors.some((e) => e.startsWith('needs clamping')), 'gate: a command that needs clamping is rejected', JSON.stringify(r.errors)); }
ok(!checkSpeechGesture({ ...seed, clip: { name: 'Talk' } }).ok, 'gate: clips are rejected in the speech path');
ok(!checkSpeechGesture({ ...seed, sustain: true }).ok, 'gate: sustained commands are rejected');
ok(!checkSpeechGesture({ ...seed, reach: [seed.reach[0], { ...seed.reach[0] }] }).ok, 'gate: two reaches for one hand are rejected');
ok(!checkSpeechGesture({ id: 'short', expressions: [{ name: 'happy', inMs: 100, holdMs: 200, outMs: 100 }] }).ok, 'gate: shorter than 1.5 s is rejected');
ok(!checkSpeechGesture({ id: 'long', expressions: [{ name: 'happy', inMs: 100, holdMs: 5000, outMs: 100 }] }).ok, 'gate: longer than 3.5 s is rejected');
ok(!checkSpeechGesture({ id: 'x', dance: true }).ok, 'gate: unknown fields are rejected');
ok(!checkSpeechGesture('{"id":"x"}').ok && !checkSpeechGesture(null).ok, 'gate: non-objects are rejected');
{ const r = checkSpeechGesture({ ...seed, priority: 10, mirror: 'random' }); ok(r.ok && r.command.priority === 6 && r.command.mirror === 'none', 'gate: priority / mirror are the app\'s, not the model\'s'); }

// ---------- held face-only emotion (T-31 0.2.3 B2 item 1) ----------
{
  const held = checkSpeechGesture({ id: 'speech-emotion', sustain: true, expressions: [{ name: 'happy', weight: 0.8 }] });
  ok(held.ok && held.durationMs === null && held.command.sustain === true, 'gate: a face-only sustained emotion passes (no fixed length)', JSON.stringify(held.ok ? { durationMs: held.durationMs } : held.errors));
  ok(!checkSpeechGesture({ id: 'x', sustain: true, expressions: [{ name: 'happy' }], bones: [{ bone: 'head' }] }).ok, 'gate: sustain with any body channel is still rejected');
  ok(!checkSpeechGesture({ id: 'x', sustain: true, expressions: [{ name: 'happy' }], clip: { name: 'Talk' } }).ok, 'gate: a held emotion may never carry a clip');
  ok(!checkSpeechGesture({ id: 'x', sustain: true, expressions: [{ name: 'happy', weight: 99 }] }).ok, 'gate: a held emotion still fails on any clamp warning');
  ok(!checkSpeechGesture({ id: 'x', sustain: true, expressions: [{ name: 'nope' }] }).ok, 'gate: an unknown expression name is still rejected');
  ok(isFaceOnly({ expressions: [{ name: 'happy' }] }) && !isFaceOnly({ expressions: [{ name: 'happy' }], root: [{ pos: [0, 0.1, 0] }] }), 'face-only: expressions alone pass, a root channel fails');
  // director consumption: the held layer plays as a face-only sustained command and is tracked for finish()/cancel()
  const { TalkDirector } = await import('../src/renderer/talk/director.js');
  const played = [], stopped = [];
  const engine = { playCommand: (cmd, source, opts) => { played.push({ cmd, source, opts }); return { ok: true, trackId: played.length }; }, player: { stop: (id) => stopped.push(id) } };
  const dir = new TalkDirector({ engine, catalog: { get: () => null }, cloud: null, speech: null, library: { pick: () => null }, cache: { pick: () => null }, saveCache() {}, probe: () => null, rigVersion: () => 'x', ui: { thinking() {} }, log() {} });
  const t = { id: 'tv', intent: 'greet', instances: [], timeline: {}, t0: 0, wallT0: 0 };
  dir.playHeldEmotion(t, 'happy');
  ok(played.length === 1 && played[0].cmd.sustain === true && played[0].cmd.expressions[0].name === 'happy' && isFaceOnly(played[0].cmd), 'director: a known emotion plays one face-only sustained command', JSON.stringify(played[0] && played[0].cmd));
  ok(t.emotionId === 1 && t.instances.includes(1), 'director: the held track is tracked for finish()/cancel()');
  dir.playHeldEmotion(t, 'purple');
  ok(played.length === 1, 'director: an unknown emotion preset plays nothing');
  dir.finish(t, 'spoken');
  ok(stopped.includes(1), 'director: finish() stops the held emotion with the reply', JSON.stringify(stopped));
}

// ---------- frame-rate-independent mouth smoothing (T-31 0.2.3 B2 item 2) ----------
{
  const { mouthStep, MOUTH_OPEN_TAU_MS, MOUTH_CLOSE_TAU_MS } = await import('../src/renderer/talk/speech.js');
  const drive = (from, goal, fps, ms) => { let v = from, t = 0; const dt = 1000 / fps; while (t < ms - 1e-9) { const step = Math.min(dt, ms - t); v = mouthStep(v, goal, step); t += step; } return v; };
  const spread = (a) => Math.max(...a) - Math.min(...a);
  const open = [30, 60, 144].map((f) => drive(0, 1, f, 250));
  const close = [30, 60, 144].map((f) => drive(1, 0, f, 250));
  ok(spread(open) < 1e-9, 'mouth: the open response is identical at 30/60/144 fps', JSON.stringify(open.map((v) => +v.toFixed(6))));
  ok(spread(close) < 1e-9, 'mouth: the close response is identical at 30/60/144 fps', JSON.stringify(close.map((v) => +v.toFixed(6))));
  ok(MOUTH_OPEN_TAU_MS < MOUTH_CLOSE_TAU_MS, 'mouth: opens faster than it closes', `${MOUTH_OPEN_TAU_MS}/${MOUTH_CLOSE_TAU_MS}`);
  const open100 = drive(0, 1, 60, 100), closed100 = 1 - drive(1, 0, 60, 100);
  ok(open100 > closed100 + 0.2, 'mouth: after 100 ms far more open than a closing mouth', `${open100.toFixed(3)} vs ${closed100.toFixed(3)}`);
  ok(Math.abs(mouthStep(0, 1, 1000) - (1 - Math.exp(-1000 / MOUTH_OPEN_TAU_MS))) < 1e-12, 'mouth: one step follows 1 - e^{-dt/tau}');
}

// ---------- analysis gate ----------
const good = fixtures.turns['Chào Zumi, hôm nay em thế nào?'].analysis;
ok(checkAnalysis(good).ok, 'analysis: three plain Vietnamese sentences are shown');
ok(!checkAnalysis(null).ok, 'analysis: null -> honest "not explained" line');
ok(checkAnalysis(fixtures.turns['Lượt này giải thích có mã T-31.'].analysis).reason === 'understood: task code', 'analysis: a task code is refused');
ok(!checkAnalysis({ ...good, plan: 'I will wave hello.' }).ok, 'analysis: English-only is refused');
ok(!checkAnalysis({ ...good, why: 'Vì <b>gesture</b> hợp' }).ok, 'analysis: markup is refused');
ok(!checkAnalysis({ ...good, plan: 'Em sẽ dùng rig_version mới.' }).ok, 'analysis: snake_case is refused');
ok(!checkAnalysis({ ...good, why: 'Vì '.repeat(70) + 'đúng' }).ok, 'analysis: longer than 160 chars is refused');
ok(!checkAnalysis({ understood: 'Em hiểu.', plan: 'Em làm.' }).ok, 'analysis: a missing line is refused');

// ---------- cache ----------
const rigA = 'a'.repeat(32), rigB = 'b'.repeat(32);
const check = (c) => checkSpeechGesture(c);
const g = { intent: 'greet', energy: 'mid', deixis: 'none' };
const keyA = cacheKey(g, 2600, rigA);
ok(keyA === `greet|mid|mid|none|${rigA}` && durBucket(1999) === 'short' && durBucket(5001) === 'long', 'cache: key = intent|energy|length bucket|deixis|rigVersion');
ok(deixisSide('board') === -1 && deixisSide('screen-right') === 1 && deixisSide('none') === 0, 'intents: the board is on the viewer\'s left');
{
  let clock = 1000;
  const c = new GestureCache({ rigVersion: rigA, check, random: () => 0, now: () => clock++ });
  const v1 = lib.byIntent.get('greet').variants[0].command, v2 = lib.byIntent.get('greet').variants[1].command;
  ok(c.add(keyA, { command: v1, source: 'composed' }) && c.add(keyA, { command: v2, source: 'composed' }), 'cache: adds validated commands');
  ok(!c.add(keyA, { command: v1, source: 'composed' }), 'cache: the same command is stored once');
  ok(!c.add(cacheKey(g, 2600, rigB), { command: v1 }), 'cache: refuses a key of another rigVersion');
  const p1 = commandHash(c.pick(keyA).command), p2 = commandHash(c.pick(keyA).command);
  ok(p1 !== p2, 'cache: never the same variant twice in a row');
  const saved = JSON.stringify(c.toJSON());
  ok(new GestureCache({ rigVersion: rigA, check }).load(saved).size() === 2, 'cache: survives a save/load round trip');
  const stale = new GestureCache({ rigVersion: rigB, check }).load(saved);
  ok(stale.size() === 0 && stale.dropped.stale === 2, 'cache: a new rigVersion (rig change or another model) drops every older entry');
  ok(new GestureCache({ rigVersion: rigA, check }).load('{not json').size() === 0, 'cache: a corrupt file is an empty cache, not a crash');
  const tampered = JSON.parse(saved); tampered.entries[0].command = commands['Thử một cử chỉ cần kẹp góc nhé.'];
  const t2 = new GestureCache({ rigVersion: rigA, check }).load(JSON.stringify(tampered));
  ok(t2.size() === 1 && t2.dropped.invalid === 1, 'cache: entries are re-validated on load (an invalid one is dropped)');
  c.denyCommand(v1);
  ok(c.size() === 1 && !c.add(keyA, { command: v1 }), 'cache: a denied command is removed and never re-added');
  const small = new GestureCache({ rigVersion: rigA, check, perKey: 6, maxEntries: 3, now: () => clock++ });
  const nods = [0, 1, 2, 3].map((i) => ({ ...commands['Mình làm bản thử trước nhé, được không?'], id: `nod-${i}` }));
  nods.forEach((cmd, i) => small.add(cacheKey({ intent: 'agree', energy: 'mid', deixis: 'none' }, 1000 + i * 2000, rigA), { command: cmd }));
  ok(small.size() === 3, 'cache: maxEntries evicts the least recently used', `${small.size()}`);
}

// ---------- main-process cloud client (contract v1, Sol P1.1 conditions) ----------
const { _test: T, createCloud, createTokenStore, ALLOWED_ORIGIN } = cloudMod;
const tid = crypto.randomBytes(16).toString('hex');
ok(!T.checkTurnRequest({ turnId: tid, message: 'hi', history: [{ role: 'assistant', text: 'chào' }] }), 'cloud: a well-formed turn request passes');
ok(Boolean(T.checkTurnRequest({ turnId: tid, message: 'hi', history: [], extra: 1 })) === true, 'cloud: unknown request fields are refused');
ok(Boolean(T.checkTurnRequest({ turnId: 'abc', message: 'hi', history: [] })), 'cloud: turnId must be 128-bit hex');
ok(Boolean(T.checkTurnRequest({ turnId: tid, message: 'hi', history: [{ role: 'model', text: 'x' }] })), 'cloud: history roles are user|assistant only');
ok(Boolean(T.checkTurnRequest({ turnId: tid, message: 'hi', history: Array(7).fill({ role: 'user', text: 'x' }) })), 'cloud: history is at most 6 items');
ok(Boolean(T.checkTurnRequest({ turnId: tid, message: 'x'.repeat(2001), history: [] })), 'cloud: message length is bounded');
ok(Boolean(T.checkGestureRequest({ turnId: tid, intent: 'greet', brief: 'b', energy: 'mid', deixis: 'none', targetMs: 4000, rigVersion: rigA })), 'cloud: targetMs is bounded by the rig');
ok(!T.checkGestureRequest({ turnId: tid, intent: 'greet', brief: 'wave', energy: 'mid', deixis: 'none', targetMs: 2600, rigVersion: rigA }), 'cloud: a well-formed gesture request passes');
const resp = { contractVersion: 1, turnId: tid, reply: 'Chào anh', analysis: null, gesture: { intent: 'greet', brief: 'wave', energy: 'mid', deixis: 'none' }, model: 'm', latencyMs: 1, usage: null };
ok(!T.checkTurnResponse(resp, tid), 'cloud: analysis may be null');
ok(Boolean(T.checkTurnResponse({ ...resp, contractVersion: 2 }, tid)), 'cloud: another contractVersion is refused');
ok(Boolean(T.checkTurnResponse(resp, crypto.randomBytes(16).toString('hex'))), 'cloud: the turnId must be echoed');
ok(T.normUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3, raw: {} }).raw === undefined && T.normUsage({ promptTokenCount: 1 }) === null, 'cloud: usage is normalised, never the raw Google object');
let threw = false; try { T.createLive({ base: 'https://evil.example', getToken: () => 'x', log: () => {} }); } catch { threw = true; }
ok(threw, 'cloud: a base outside the allowlist is refused');
threw = false; try { T.createLive({ base: ALLOWED_ORIGIN.replace('https:', 'http:'), getToken: () => 'x', log: () => {} }); } catch { threw = true; }
ok(threw, 'cloud: plain http is refused');

// live transport with a stub fetch: bearer only on the desktop routes, never on TTS, redirects are errors, no token in logs
{
  const TOKEN = 'T0k3n_' + crypto.randomBytes(24).toString('base64url');
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization || null, redirect: opts.redirect });
    const body = JSON.parse(opts.body);
    let json;
    if (url.endsWith('/turn')) json = { ...resp, turnId: body.turnId };
    else if (url.endsWith('/gesture')) json = { contractVersion: 1, turnId: body.turnId, command: null, model: 'm', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, repaired: false };
    else json = { audio: Buffer.from('mp3').toString('base64'), audios: [Buffer.from('mp3').toString('base64')] };
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(json) };
  };
  const live = T.createLive({ base: ALLOWED_ORIGIN, getToken: () => TOKEN, log: (m) => logs.push(m), fetchImpl });
  await live.turn({ turnId: tid, message: 'xin chào', history: [] });
  await live.gesture({ turnId: tid, intent: 'greet', brief: 'wave', energy: 'mid', deixis: 'none', targetMs: 2600, rigVersion: rigA });
  await live.tts({ turnId: tid, text: 'Chào anh' });
  ok(calls.every((c) => c.url.startsWith(`${ALLOWED_ORIGIN}/`)), 'cloud: every call goes to the allowlisted origin');
  ok(calls.every((c) => c.redirect === 'error'), 'cloud: redirects are errors (the bearer is never forwarded)');
  ok(calls[0].auth === `Bearer ${TOKEN}` && calls[1].auth === `Bearer ${TOKEN}`, 'cloud: the device token goes on /turn and /gesture');
  ok(calls[2].auth === null && calls[2].url === `${ALLOWED_ORIGIN}/api/zumi/tts`, 'cloud: the public TTS route never gets the bearer');
  ok(!logs.some((l) => l.includes(TOKEN) || l.includes('xin chào') || l.includes('Chào anh')), 'cloud: logs carry no token and no text');
  // error shape + Retry-After
  const err429 = T.createLive({ base: ALLOWED_ORIGIN, getToken: () => TOKEN, log: () => {}, fetchImpl: async () => ({ ok: false, status: 429, headers: new Map([['retry-after', '30']]), text: async () => JSON.stringify({ error: { code: 'daily_cap', message: 'cap', retryable: true }, traceId: 'tr1' }) }) });
  try { await err429.turn({ turnId: tid, message: 'x', history: [] }); ok(false, 'cloud: 429 surfaces as an error'); } catch (e) { ok(e.code === 'daily_cap' && e.retryAfterSec === 30 && e.traceId === 'tr1' && e.retryable, 'cloud: stable error shape with Retry-After and traceId'); }
}

// token store: safeStorage only, import file destroyed, no plaintext fallback
{
  const dir = fs.mkdtempSync(path.join(ROOT, '.check-speech-'));
  try {
    const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)), decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString() };
    const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCD';
    fs.writeFileSync(path.join(dir, 'cloud-token.import'), TOKEN + '\n');
    const store = createTokenStore({ safeStorage: fake, dir, log: () => {} });
    ok(store.importIfPresent() === 'imported' && !fs.existsSync(path.join(dir, 'cloud-token.import')), 'token: the import file is consumed and destroyed');
    ok(!fs.readFileSync(path.join(dir, 'cloud-token.bin')).toString().includes(TOKEN) && store.read() === TOKEN, 'token: stored encrypted, readable only through safeStorage');
    fs.writeFileSync(path.join(dir, 'cloud-token.import'), TOKEN);
    const noEnc = createTokenStore({ safeStorage: { isEncryptionAvailable: () => false }, dir, log: () => {} });
    ok(noEnc.importIfPresent() === 'no-encryption' && noEnc.read() === null, 'token: no OS encryption = no token (no plaintext fallback)');
    const offCloud = createCloud({ mode: 'auto', base: ALLOWED_ORIGIN, safeStorage: { isEncryptionAvailable: () => false }, tokenDir: dir, log: () => {} });
    ok(!offCloud.status().enabled && /encryption/.test(offCloud.status().reason), 'token: talk stays off without OS encryption');
    const release = createCloud({ mode: 'auto', base: null, safeStorage: fake, tokenDir: dir, log: () => {} });
    ok(!release.status().enabled, 'release build (no talk server configured): talk is off');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// fixture cloud: one TTS and one gesture per successful turn
{
  const fx = createCloud({ mode: 'fixture', fixtureFile: path.join(ROOT, 'src', 'main', 'cloud-fixtures.json'), log: () => {} });
  const id = crypto.randomBytes(16).toString('hex');
  ok((await fx.tts({ turnId: id, text: 'x' })).error.code === 'no_turn', 'cloud: no speech for a turn that did not succeed');
  const tr = await fx.turn({ turnId: id, message: 'Lượt này không có giải thích.', history: [] });
  ok(tr.ok && tr.analysis === null, 'fixture: a turn without analysis');
  ok((await fx.tts({ turnId: id, text: 'x' })).ok && (await fx.tts({ turnId: id, text: 'x' })).error.code === 'once_per_turn', 'cloud: one speech per turn, no retry');
  const gq = { turnId: id, intent: 'greet', brief: 'wave', energy: 'mid', deixis: 'none', targetMs: 2000, rigVersion: rigA };
  ok((await fx.gesture(gq)).ok && (await fx.gesture(gq)).error.code === 'once_per_turn', 'cloud: one gesture per turn');
  const bad = await fx.turn({ turnId: crypto.randomBytes(16).toString('hex'), message: 'Lượt này máy chủ lỗi.', history: [] });
  ok(!bad.ok && bad.error.code === 'upstream_unavailable' && bad.error.retryable === true, 'fixture: a failed turn carries the stable error shape');
}

// ---------- build flavours: the release build talks to nobody and ships no model ----------
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok(!('zumiCloud' in pkg), 'release build: no talk server configured (package.json has no zumiCloud)');
  ok(JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'models', 'models.json'), 'utf8')).models.length === 0 && !(pkg.build.files || []).some((f) => /\.vrm/i.test(f)), 'release build: no bundled model (models.json empty, no .vrm in files)');
  const internal = require('./builder-selftest.cjs');
  ok(internal.appId !== pkg.build.appId && internal.extraMetadata && internal.extraMetadata.zumiCloud && internal.extraMetadata.zumiCloud.base === cloudMod.ALLOWED_ORIGIN, 'internal build: own appId, talk server = the allowlisted staging origin');
}

// ---------- owner-visible text (P6): plain Vietnamese labels only ----------
{
  const { ownerTextProblem } = await import('../src/renderer/talk/ownertext.js');
  const bad = { 'C mẫu 1': '"C mẫu" shorthand', 'Việc T-31 đang chờ': 'task or step code', 'Bước s3 đang chờ': 'task or step code', 'Laneboard 984927c': 'commit hash', 'rig_version': 'snake_case', 'rigVersion mới': 'camelCase', 'Vì <b>đẹp</b>': 'markup or JSON' };
  for (const [t, why] of Object.entries(bad)) ok(ownerTextProblem(t) === why, `owner text: "${t}" is refused (${why})`, String(ownerTextProblem(t)));
  // The intent/source id rule and the English-only rule are bugs only in the Vietnamese UI (the ids are ordinary
  // English words, and English is the default locale now), so they are asserted with lang:'vi'.
  const badVi = { 'cử chỉ greet': 'intent or source id', 'nguồn: library': 'intent or source id', 'Lệnh cử chỉ → Wave hello': 'English-only label', 'Wave hello': 'English-only label' };
  for (const [t, why] of Object.entries(badVi)) ok(ownerTextProblem(t, { lang: 'vi' }) === why, `owner text: "${t}" is refused (${why}) in the Vietnamese UI`, String(ownerTextProblem(t, { lang: 'vi' })));
  const good = ['Rảnh > 60 giây → Vươn vai', 'Cử chỉ: Chào hỏi — vẫy tay · AI vừa soạn mới', 'Rê chuột → Mắt dẫn', 'Open VRM file…', 'Zumi (test build)', 'Zumi could not explain this turn.', 'Point at the board', 'Zumi', 'v0.2.0', 'Message Zumi… (Enter to send)'];
  ok(good.every((t) => ownerTextProblem(t) === null), 'owner text: the app\'s own labels pass', JSON.stringify(good.map((t) => [t, ownerTextProblem(t)]).filter(([, p]) => p)));
  const paths = ['dữ liệu lưu ở D:\\Apps\\Zumi-data\\board-data', 'Dữ liệu ở C:/ProgramData/Zumi', 'thư mục \\\\server\\share\\x', 'nằm ở /root/zumia-staging/backend', 'thư mục runs\\check-1\\board-data'];
  for (const t of paths) ok(ownerTextProblem(t) === 'filesystem path', `owner text: a path is refused ("${t}")`, String(ownerTextProblem(t)));
  for (const t of ['Model kiểm thử: zumi-v3.1.vrm', 'Đã lưu settings.json', 'mở Zumi.exe']) ok(ownerTextProblem(t) === 'file name', `owner text: a file name in visible text is refused ("${t}")`, String(ownerTextProblem(t)));
  ok(ownerTextProblem('zumi-v3.1.vrm', { tooltip: true }) === null && ownerTextProblem('D:\\x\\zumi-v3.1.vrm', { tooltip: true }) === 'filesystem path', 'owner text: a file name may sit in a tooltip, a path may not');
  const { auditOwnerTexts } = await import('../src/renderer/talk/ownertext.js');
  ok(auditOwnerTexts([{ where: '#model-picker@title', text: 'zumi-v3.1.vrm' }, { where: '#model-picker:selected', text: 'zumi-v3.1.vrm' }]).map((p) => p.where).join() === '#model-picker:selected', 'owner text: the audit allows the file name in the picker tooltip, not as the shown option');
  for (const t of ['Zumi (bản thử)', 'Model từ máy anh', 'Chạy ngay trong máy, không cần mạng', '127.0.0.1 không phải đường dẫn', 'v0.2.0']) ok(ownerTextProblem(t) === null, `owner text: "${t}" passes`, String(ownerTextProblem(t)));
  const { INTENT_LABEL_VI, SOURCE_LABEL_VI } = await import('../src/renderer/talk/intents.js');
  ok([...Object.values(INTENT_LABEL_VI), ...Object.values(SOURCE_LABEL_VI)].every((t) => ownerTextProblem(t) === null), 'owner text: every intent and source label passes');
}

// ---------- rig margin guard (warn under 1.05, never fail) ----------
{
  const { rigMargins, WARN_BELOW } = await import('../src/renderer/talk/rigmargins.js');
  const rules = (o = {}) => ({
    R1: { ok: true, minF: 1.9 }, R2: { ok: true, hits: [], deepest: { f: 1.6 } }, R3: { ok: true, maxFlexDeg: 100, maxTwistDeg: 50 }, R4: { ok: true, maxDriftM: 0 }, R5: { ok: true }, R6: { ok: true }, ...o,
  });
  const roomy = rigMargins(rules());
  ok(roomy.warnings.length === 0 && roomy.margins.body === 1.6 && roomy.margins.elbow === 1.55 && roomy.margins.feet === null, 'margins: a roomy gesture has no warning (feet 0 drift = nothing to measure)');
  const think = rigMargins(rules({ R2: { ok: true, hits: [], deepest: { f: 1.033 } }, R3: { ok: true, maxFlexDeg: 151.3, maxTwistDeg: 43 } }));
  ok(think.warnings.map((w) => w.rule).sort().join() === 'body,elbow' && think.warnings.every((w) => w.margin < WARN_BELOW), 'margins: through-body 1.033 and elbow 151.3/155 warn (the approved think seed)', JSON.stringify(think.warnings));
  const edge = rigMargins(rules({ R2: { ok: true, hits: [], deepest: { f: 1.05 } } }));
  ok(!edge.warnings.some((w) => w.rule === 'body'), 'margins: exactly 1.05 does not warn');
  const failing = rigMargins(rules({ R2: { ok: false, hits: [{}], deepest: { f: 0.61 } } }));
  ok(!failing.warnings.some((w) => w.rule === 'body'), 'margins: a failing rule is a failure, not a warning');
  const twist = rigMargins(rules({ R3: { ok: true, maxFlexDeg: 90, maxTwistDeg: 72 } }));
  ok(twist.warnings.length === 1 && twist.warnings[0].rule === 'twist', 'margins: twist 72 of 75 warns');
}

// the GestureCommand schema hash the backend pins (P1 copies schema.js and compares this hash in a test)
for (const f of ['schema.js', 'player.js']) console.log(`${f} sha256 (LF) ${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', f), 'utf8').replace(/\r\n/g, '\n')).digest('hex')}`);
console.log(`check:speech ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
