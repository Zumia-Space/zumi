// T-31 first-answer-time metric: the measurement-only stub chat provider. Plain Node, no app, no window, no network.
//
//   node scripts/check-tauri-measure-stub.mjs   (exit 1 on any failure)
//
// CoS-approved constraints, each pinned here:
//   1. reachable only from argv --measure-stub-provider (no env var, no setting), imported only behind that flag;
//   2. ABSENT from user builds: the marker string is in exactly one tracked file, that file is excluded from the staged
//      sidecar (stage-bundle STAGE_EXCLUDED) and the marker is in no renderer / ui / staged file;
//   3. 0 ms, a fixed reply, no network, no key: driven through the REAL chat brain with a global fetch that throws;
//   4. it is a provider in the real registry shape (PROVIDERS entry), so the chat path is the production one: the stub
//      replaces ONLY the provider's network transport, beneath the egress guard. The vault safeStorage (key decrypt) and the
//      egress layer run exactly as for a real keyed provider;
//   5. first-answer time is measured by the demo run (Enter -> first frame with reply text), not by --selftest, so the
//      flag is forwarded to demo launches only; the stub file is staged only by an explicit non-public option.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

const STUB_REL = 'tauri/sidecar/measure-stub.mjs';
const SELF_REL = 'scripts/check-tauri-measure-stub.mjs';
const MARKER = 'ZUMI_MEASURE_STUB_7c1e'; // must equal MEASURE_STUB_MARKER in the stub

const git = (...args) => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
// Tracked files that exist in the working tree (the stub may be staged-but-deleted mid-edit).
const tracked = git('ls-files', '-z').stdout.split('\0').filter((f) => f && fs.existsSync(path.join(ROOT, f)));
const text = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };

// ---- 2. absent from every shipped tree ----
const hits = tracked.filter((f) => f !== STUB_REL && f !== SELF_REL && text(f).includes(MARKER));
ok(hits.length === 0, 'the marker string is in no tracked file except the stub itself and this check', hits.join(','));
ok(tracked.includes(STUB_REL) && text(STUB_REL).includes(MARKER), 'the stub exists and carries the marker');
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const built = [...walk(path.join(ROOT, 'tauri', 'ui')), ...walk(path.join(ROOT, 'tauri', 'src-tauri', 'bundle')), ...walk(path.join(ROOT, 'build', 'renderer'))];
ok(built.every((f) => !fs.readFileSync(f).includes(MARKER)), 'no built renderer / ui / staged bundle file on disk carries the marker', String(built.length));
let stage = null;
try { stage = await import('../tauri/stage-bundle.mjs'); } catch { /* reported below */ }
ok(Boolean(stage) && Array.isArray(stage.STAGE_EXCLUDED) && stage.STAGE_EXCLUDED.includes(STUB_REL), 'stage-bundle excludes the stub from the staged sidecar');
const staged = stage && typeof stage.stagedTrackedFiles === 'function' ? stage.stagedTrackedFiles('tauri/sidecar') : [];
ok(staged.length > 10 && !staged.includes(STUB_REL), 'the staged sidecar file list omits the stub', String(staged.length));
ok(staged.length > 0 && staged.every((f) => !text(f).includes(MARKER)), 'no staged sidecar file carries the marker');
ok(Boolean(stage) && stage.stagedTrackedFiles('tauri/sidecar', { measureStub: true }).includes(STUB_REL) && !stage.stagedTrackedFiles('tauri/sidecar', {}).includes(STUB_REL), 'only an explicit measureStub staging option includes the stub; the default never does');
{
  const stageSrc = text('tauri/stage-bundle.mjs');
  const ps = text('tauri/build.ps1');
  ok(/measureStub: process\.argv\.includes\('--measure-stub'\) \}/.test(stageSrc) && !/measure[^\n]*process\.env|process\.env[^\n]*measure/i.test(stageSrc), 'stage-bundle turns the stub on from the argv switch alone (no env var, no other source)');
  ok(/process\.argv\.includes\('--measure-stub'\)/.test(stageSrc), 'stage-bundle reads the explicit --measure-stub switch');
  ok(/\[switch\]\$MeasureStub/.test(ps) && /if \(\$MeasureStub -and \$Flavour -eq 'public'\) \{ throw/.test(ps), 'build.ps1 -MeasureStub exists and refuses a public flavour');
  ok(/if \(\$MeasureStub\) \{[^}]*--measure-stub/.test(ps), 'build.ps1 passes --measure-stub to stage-bundle only under -MeasureStub');
}

// ---- build.ps1: the stub never reaches an installer (the head of the script run alone, as the reviewer did) ----
{
  const ps = text('tauri/build.ps1');
  const cut = ps.indexOf('$tauriDir = $PSScriptRoot');
  const head = cut > 0 ? ps.slice(0, cut) + "Write-Output 'HEAD_PASSED'\n" : '';
  const headFile = path.join(process.env.CHECK_TMP || os.tmpdir(), `build-head-${process.pid}.ps1`);
  fs.writeFileSync(headFile, head);
  const runHead = (...args) => {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', headFile, ...args], { encoding: 'utf8', stdin: 'ignore' });
    return { passed: /HEAD_PASSED/.test(r.stdout || ''), err: `${r.stderr || ''}${r.error || ''}` };
  };
  try {
    ok(runHead('-MeasureStub', '-Flavour', 'owner').passed, 'build.ps1 head: -MeasureStub -Flavour owner is accepted (the baseline the refusals below are measured against)');
    ok(!runHead('-MeasureStub', '-Flavour', 'owner', '-SkipBundleResources').passed, 'build.ps1 refuses -MeasureStub with -SkipBundleResources (a reused stage is never trusted to be the stub stage)');
    ok(!runHead('-MeasureStub', '-Flavour', 'owner', '-NoBundle').passed, 'build.ps1 refuses -MeasureStub with -NoBundle (nothing would be staged or measured)');
  } finally { fs.rmSync(headFile, { force: true }); }
  ok(/\$noInstaller = \$NoBundle -or \$MeasureStub/.test(ps) && /if \(\$noInstaller\) \{ \$buildArgs \+= '--no-bundle' \}/.test(ps), 'build.ps1 builds with --no-bundle whenever -MeasureStub is set: a stub build never makes an NSIS/MSI installer');
  const preGate = ps.search(/if \(-not \$NoBundle -and -not \$MeasureStub\) \{[^]*?check-bundle\.mjs'\) --dir \$staged/);
  ok(preGate > 0 && preGate < ps.indexOf('& cargo tauri @buildArgs'), 'build.ps1 checks the stage (which the installer packs) for the stub marker BEFORE cargo tauri build in every non-stub build, a reused stage included');
  ok(/if \(\$MeasureStub\) \{ \$bundleCheckArgs \+= '--allow-measure-stub' \}/.test(ps) && (ps.match(/--allow-measure-stub/g) || []).length === 1, 'build.ps1 allows the marker in check-bundle only for a -MeasureStub build');
}

// ---- check-bundle: marker gate over a bundle / installer payload dir ----
{
  const fx = fs.mkdtempSync(path.join(process.env.CHECK_TMP || os.tmpdir(), 'bundle-fx-'));
  const put = (rel, body = 'x') => { const f = path.join(fx, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  try {
    put('zumi-vault.exe'); put('tauri/sidecar/main.mjs', 'export {}'); put('THIRD_PARTY_LICENSES.md', 'credits'); put('NOTICE', 'notice'); put('licenses/GPL-3.0.txt', 'gpl');
    // check-bundle also demands the pinned default model + credits; a fixture gets a tiny fake model under a fake pin (--pin seam).
    const realPin = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources-pinned', 'default-model', 'PIN-MANIFEST.json'), 'utf8'));
    const fakeModel = Buffer.from('fixture-model');
    put(`assets/models/${realPin.file}`, fakeModel); put(`assets/models/${realPin.licenceNoticeFile}`, '3K FOREST pixiv');
    const pinFile = path.join(fx, 'fixture-pin.json');
    fs.writeFileSync(pinFile, JSON.stringify({ ...realPin, bytes: fakeModel.length, sha256: createRequire(import.meta.url)('node:crypto').createHash('sha256').update(fakeModel).digest('hex') }));
    const bundleCheck = (...extra) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'tauri', 'verify', 'check-bundle.mjs'), '--dir', fx, '--pin', pinFile, ...extra], { encoding: 'utf8' }); return { code: r.status, out: r.stdout || '' }; };
    const clean = bundleCheck();
    ok(clean.code === 0 && /PASS no measure-stub marker/.test(clean.out), 'check-bundle: a clean bundle passes and reports the marker gate', clean.out.slice(-200));
    // room v1 "Zumi's Office" was removed (owner, 2026-10-26): a bundle that still carries it FAILS
    put('resources-pinned/room-v1/room.glb', 'stale-v1');
    const withV1 = bundleCheck();
    ok(withV1.code !== 0 && /FAIL the bundle ships no room v1/.test(withV1.out), 'check-bundle: a bundle that still ships room-v1 FAILS', withV1.out.slice(-200));
    fs.rmSync(path.join(fx, 'resources-pinned', 'room-v1'), { recursive: true, force: true });
    put('assets/room-glb-fixture/room.glb', 'fixture-glb'); // the importer's test-only fixture must never be packaged
    const withFixture = bundleCheck();
    ok(withFixture.code !== 0 && /FAIL the bundle ships no room \.glb test fixture/.test(withFixture.out), 'check-bundle: a bundle that carries the room .glb test fixture FAILS', withFixture.out.slice(-200));
    fs.rmSync(path.join(fx, 'assets', 'room-glb-fixture'), { recursive: true, force: true });
    put('tauri/sidecar/other.mjs', `// ${MARKER}`);
    const marked = bundleCheck();
    ok(marked.code !== 0 && /FAIL no measure-stub marker/.test(marked.out), 'check-bundle: the marker in any bundle file fails the check', marked.out.slice(-200));
    ok(bundleCheck('--allow-measure-stub').code === 0, 'check-bundle: --allow-measure-stub (the -MeasureStub build only) lets the marker through');
    fs.rmSync(path.join(fx, 'tauri/sidecar/other.mjs'));
    put('tauri/sidecar/measure-stub.mjs', 'export {}');
    const named = bundleCheck();
    ok(named.code !== 0 && /FAIL no measure-stub marker/.test(named.out), 'check-bundle: the stub file itself (by name) fails the check even without the marker text', named.out.slice(-200));
  } finally { fs.rmSync(fx, { recursive: true, force: true }); }
}
const renderer = tracked.filter((f) => f.startsWith('src/renderer/') || f.startsWith('tauri/ui/') || f.startsWith('tauri/shim/'));
ok(renderer.length > 50 && renderer.every((f) => !text(f).includes(MARKER)), 'no renderer / shim file carries the marker', String(renderer.length));

// ---- 1. argv-only gate, dynamic import only behind it ----
const mainSrc = text('tauri/sidecar/main.mjs');
ok(!/^\s*import[^;]*measure-stub/m.test(mainSrc), 'main.mjs has no static import of the stub');
ok((mainSrc.match(/import\('\.\/measure-stub\.mjs'\)/g) || []).length === 1, 'main.mjs imports the stub dynamically, exactly once');
ok(/if \(parseMeasureStubProvider\(process\.argv\.slice\(2\)\)\) \{\s*try \{ measureStubModule = await import\('\.\/measure-stub\.mjs'\)/.test(mainSrc), 'that import sits directly behind parseMeasureStubProvider(argv)');
ok(!/process\.env[^\n]*(measure|stub)/i.test(mainSrc), 'no env var reaches the stub');
ok(!/measureStub\.safeStorage/.test(mainSrc) && /safeStorage: ctx\.safeStorage, flavour: ctx\.flavour, emit: ctx\.emit, aiCore/.test(mainSrc), 'the chat host keeps the vault safeStorage (the stub swaps nothing but the transport)');
ok(!/chatFetch: ctx\.measureStub/.test(mainSrc) && /guardedFetch\(ctx\.measureStub\.fetch,/.test(mainSrc), 'the stub transport sits beneath the egress guard (egress.provider), not in the chatFetch bypass');
let mainMod = null;
try { mainMod = await import('../tauri/sidecar/main.mjs'); } catch { /* reported below */ }
const parse = mainMod && mainMod.parseMeasureStubProvider;
ok(typeof parse === 'function' && parse(['--measure-stub-provider']) === true && parse(['--selftest', 'D:/r']) === false && parse([]) === false, 'parseMeasureStubProvider is true only for the explicit argv flag');
process.env.ZUMI_MEASURE_STUB = '1';
ok(typeof parse === 'function' && parse([]) === false, 'an env var does not turn it on');
delete process.env.ZUMI_MEASURE_STUB;
const modeErr = mainMod && mainMod.measureStubModeError;
ok(typeof modeErr === 'function' && modeErr({ demo: { dir: 'D:/o' }, shots: null }) === null && modeErr({ selftest: 'D:/r', demo: null, shots: null }) !== null
  && modeErr({ demo: null, shots: { kind: 'settingsShots' } }) !== null && modeErr({ demo: null, shots: null, probe: null }) !== null,
  'the stub runs only in a demo launch: selftest, shots and a normal launch refuse it');
const settingsUi = text('tauri/sidecar/ai-settings.mjs') + text('tauri/sidecar/free-llm-presets.mjs');
ok(!/measurestub|measure-stub/i.test(settingsUi), 'no settings / preset table names the stub');

// ---- 3 + 4. the real chat brain with the stub provider, offline ----
let stub = null;
try { stub = await import('../tauri/sidecar/measure-stub.mjs'); } catch { /* reported below */ }
ok(Boolean(stub), 'the stub module loads');
if (stub) {
  const { PROVIDERS } = require('../src/main/providers.js');
  const { createChatBrain } = require('../src/main/chat-brain.js');
  const dir = fs.mkdtempSync(path.join(process.env.CHECK_TMP || os.tmpdir(), 'measure-stub-'));
  const realFetch = globalThis.fetch;
  let netCalls = 0;
  globalThis.fetch = () => { netCalls++; throw new Error('network is forbidden in this check'); };
  try {
    const table = {};
    let decrypts = 0;
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(`enc:${v}`), decryptString: (b) => { decrypts++; return b.toString().slice(4); } };
    let threw = false;
    try { stub.installMeasureStub({ table: {}, dataDir: fs.mkdtempSync(path.join(dir, 'x-')), safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } }); } catch { threw = true; }
    ok(threw, 'installMeasureStub fails loudly when OS encryption is unavailable (no silent cloud fallback)');
    const handle = stub.installMeasureStub({ table, dataDir: dir, safeStorage });
    ok(!('safeStorage' in handle), 'the stub hands out no stand-in safeStorage');
    ok(Boolean(table[handle.providerId]) && table[handle.providerId].id === 'measurestub', 'installMeasureStub registers the provider in the table it is given');
    ok(!Object.prototype.hasOwnProperty.call(PROVIDERS, 'measurestub'), 'merely importing the stub does not touch the shared registry');
    const bin = path.join(dir, 'measurestub-key.bin');
    ok(fs.existsSync(bin) && fs.readFileSync(bin, 'utf8') === 'enc:measure-stub-placeholder', 'the placeholder key goes through safeStorage.encryptString into the real key-store file (no plaintext key, no real secret)');
    const brain = createChatBrain({ safeStorage, dir, provider: table[handle.providerId], fetchImpl: handle.fetch, ownerAdmin: true });
    const t0 = Date.now();
    const plain = await brain.turn({ message: 'hello', history: [] });
    ok(plain.ok === true && plain.reply === stub.MEASURE_STUB_REPLY, 'a plain turn returns the fixed reply', JSON.stringify(plain).slice(0, 160));
    const streamed = await brain.turnStream({ message: 'hello', history: [] });
    ok(Boolean(streamed.head) && streamed.head.ok === true && streamed.head.streaming === true && String(streamed.head.reply).startsWith('Measure stub reply.'), 'a streamed turn returns a head with the fixed reply', JSON.stringify(streamed.head).slice(0, 160));
    ok(decrypts >= 2, 'the turns decrypt the key through the injected safeStorage (the vault path stays in the measured pipeline)', String(decrypts));
    ok(Date.now() - t0 < 500 && netCalls === 0, 'both turns finish near-instantly with no network call', `${Date.now() - t0} ms, ${netCalls} calls`);
    const res = await handle.fetch('https://measure-stub.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ stream: true }) });
    let raw = '';
    for await (const c of res.body) raw += c;
    ok(/^data: \{[^\n]*\n\ndata: \{[^\n]*\n\ndata: \[DONE\]\n\n$/.test(raw), 'the stream is SSE frames ending in [DONE]');
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 5. first-answer time: Enter -> first frame showing reply text, recorded by the demo run ----
{
  const demoSrc = text('src/renderer/demo.js');
  let demo = null;
  try { demo = await import('../src/renderer/demo.js'); } catch { /* reported below */ }
  const { timeFirstReply, summarizeFirstReply } = demo || {};
  ok(typeof timeFirstReply === 'function' && typeof summarizeFirstReply === 'function', 'demo.js exports timeFirstReply and summarizeFirstReply');
  if (typeof timeFirstReply === 'function') {
    let clock = 1000;
    let reply = '';
    const frames = [];
    const raf = (cb) => { frames.push(cb); };
    const tick = () => { clock += 16; frames.splice(0).forEach((cb) => cb(clock)); };
    const settled = (pr) => { let done = false; pr.then(() => { done = true; }); return () => done; };
    const within = (pr, ms) => Promise.race([pr, new Promise((res) => setTimeout(() => res('HUNG'), ms))]);
    const p = timeFirstReply({ read: () => reply, raf, now: () => clock, timeoutMs: 2000 });
    const isSettled = settled(p);
    await Promise.resolve();
    ok(!isSettled() && frames.length === 1, 'the timer is pending until the first injected frame fires, and it schedules through the injected raf');
    tick(); tick();
    reply = 'hello';
    clock += 5; // the text lands between two frames; the metric is the first frame that shows it
    tick();
    ok((await within(p, 1000)) === clock - 1000, 'it resolves on the first frame whose text is non-empty, measured from the call', String(clock - 1000));
    clock = 0; reply = '';
    const q = timeFirstReply({ read: () => reply, raf, now: () => clock, timeoutMs: 100 });
    for (let i = 0; i < 20; i++) tick();
    ok((await within(q, 1000)) === null, 'no reply within the timeout resolves null (never a fake number)');
    // a failed turn's fallback text sits in the same row (talk/index.js reply(text || fallback)): it is an error sample, not a time
    clock = 0; reply = ''; let failed = false;
    const f = timeFirstReply({ read: () => reply, failed: () => failed, raf, now: () => clock, timeoutMs: 2000 });
    tick(); reply = 'Sorry, something went wrong.'; failed = true; tick();
    ok((await within(f, 1000)) === null, 'a failed turn (fallback text, row marked .failed) resolves null, never a reply time');
  }
  if (typeof summarizeFirstReply === 'function') {
    const sum = summarizeFirstReply([{ firstReplyMs: 400 }, { firstReplyMs: 120 }, { firstReplyMs: 100 }, { firstReplyMs: 140 }, { firstReplyMs: null }]);
    ok(sum.coldMs === 400 && sum.warmMedianMs === 120 && sum.warmN === 3, 'summary: first line is cold, median over the warm lines', JSON.stringify(sum));
  }
  ok(/firstReply = timeFirstReply\(.*\); input\.keyInput\('Enter'\)/.test(demoSrc), 'the timer starts in the same tick, immediately before input.keyInput(Enter)');
  ok(/read: \(\) => text\('talk-reply'\), failed: \(\) => \{? ?[^}]*classList\.contains\('failed'\)/.test(demoSrc), 'the timer reads #talk-reply and treats a .failed row as an error sample');
  ok(/firstReplyMs/.test(demoSrc) && /firstReply: summarizeFirstReply/.test(demoSrc), 'the run records firstReplyMs per turn and a firstReply summary in the report');
  ok(/const measured = !line\.shotPending/.test(demoSrc), 'a shotPending line (cloud.turn held behind a gate) is never measured');
  ok(/if \(info\.measureStub && \(talk\.status\.mode !== 'byo'[^\n]*\) throw new Error\(/.test(demoSrc), 'a measure run fails unless the stub provider is the one answering (mode byo)');
  ok(/measureStub/.test(text('tauri/sidecar/selftest-host.mjs')), 'demo.info tells the renderer it is a measure run');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
