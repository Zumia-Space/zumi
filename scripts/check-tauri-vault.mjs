// T-31 parity step 5: the secrets vault, end to end through the REAL zumi-vault.exe helper. Plain Node, no Electron, no app
// window, no network. Gate: GATE-step5.md (conditions 2, 3, 6) and PLAN-step5-vault.md §7 checks 1-9. Check 10 (static
// leak grep over vault files + rpc-arg logging) is scripts/check-tauri-vault-leaks.mjs.
//
//   cargo build --manifest-path tauri/src-tauri/Cargo.toml --bins     # builds target/debug/zumi-vault.exe
//   node scripts/check-tauri-vault.mjs [--quick]                       # --quick skips the four slow module re-runs (9)
//   ZUMI_VAULT_EXE=<abs zumi-vault.exe> node scripts/check-tauri-vault.mjs   # use a specific helper (e.g. the box build)
//
// Scratch files live under tauri/src-tauri/target/vault-check-tmp (drive D, gitignored), never %TEMP%.
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createVaultSafeStorage, ENCRYPT_FAILED, DECRYPT_FAILED, validateVaultExe } from '../tauri/sidecar/vault-adapter.mjs';
import { createSecretStores } from '../tauri/sidecar/secret-stores.mjs';
import { createSecretsController } from '../src/main/board-secrets.mjs';
import { parseVaultArgs } from '../tauri/sidecar/main.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'tauri', 'src-tauri', 'target');
const SCRATCH = path.join(TARGET, 'vault-check-tmp');
const QUICK = process.argv.includes('--quick');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };

// ---- locate the helper ---------------------------------------------------------------------------------
function findHelper() {
  if (process.env.ZUMI_VAULT_EXE) return path.resolve(process.env.ZUMI_VAULT_EXE);
  const found = ['release', 'debug'].map((p) => path.join(TARGET, p, 'zumi-vault.exe')).filter((p) => fs.existsSync(p));
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0] || null;
}
const HELPER = findHelper();
if (!HELPER) {
  console.log('FAIL helper not built. Run: cargo build --manifest-path tauri/src-tauri/Cargo.toml --bins');
  process.exit(1);
}
if (process.platform !== 'win32') { console.log('SKIP the vault is Windows-only (DPAPI)'); process.exit(0); }
const HOST_DIR = path.dirname(HELPER);

fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
let dirN = 0;
const scratch = (tag) => { const d = path.join(SCRATCH, `${tag}-${dirN++}`); fs.mkdirSync(d, { recursive: true }); return d; };

const canary = (tag) => `ZVCANARY-${tag}-${crypto.randomBytes(8).toString('hex')}`;
const codeWords = [];
const adapter = (extra = {}) => createVaultSafeStorage({ vaultExe: HELPER, hostDir: HOST_DIR, log: (c) => codeWords.push(c), ...extra });

function dirHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else { h.update(path.relative(dir, p)); h.update('\0'); h.update(fs.readFileSync(p)); } } };
  walk(dir);
  return h.digest('hex');
}
const filesUnder = (dir) => { const out = []; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out.push(p); } }; walk(dir); return out; };

// ---- 1. the adapter's three methods round-trip, with Electron's exact sync signatures ---------------------
{
  const ss = adapter();
  ok(ss.isEncryptionAvailable() === true, '1: isEncryptionAvailable() is true with the real helper', JSON.stringify(codeWords));
  ok(codeWords.length === 1 && codeWords[0] === 'vault_ready', '1: the self-check logs exactly one fixed code word: vault_ready');
  for (const [label, text] of [['ascii key', `sk-or-v1-${crypto.randomBytes(24).toString('hex')}`], ['vietnamese', 'Khóa bí mật: ăâđêôơư ✓'], ['json envelope', JSON.stringify({ type: 'pin', ct: 'AAAA', tag: 'BBBB' })], ['empty', ''], ['64 KiB', 'k'.repeat(64 * 1024)]]) {
    let back = null, blob = null;
    try { blob = ss.encryptString(text); back = ss.decryptString(blob); } catch (e) { back = `THREW ${e.message}`; }
    ok(Buffer.isBuffer(blob) && blob.length > 0 && back === text, `1: round trip (${label})`, back === text ? '' : String(back).slice(0, 40));
    if (text.length > 8) ok(Buffer.isBuffer(blob) && !blob.includes(Buffer.from(text.slice(0, 8))), `1: blob does not contain the plaintext (${label})`);
  }
  let big = null;
  try { ss.encryptString('k'.repeat(64 * 1024 + 1)); } catch (e) { big = e; }
  ok(big && big.message === ENCRYPT_FAILED, '1: 64 KiB + 1 is refused with the fixed encrypt error');
  let bad = null;
  try { ss.decryptString(Buffer.from('not a blob')); } catch (e) { bad = e; }
  ok(bad && bad.message === DECRYPT_FAILED, '1: a non-blob is refused with the fixed decrypt error');
}

// ---- 2. helper location rules, and the modules' own "unavailable" answers --------------------------------
{
  const alt = scratch('alt-host');
  const renamed = path.join(alt, 'zumi-vault-renamed.exe');
  fs.copyFileSync(HELPER, renamed);
  const elsewhere = path.join(alt, 'zumi-vault.exe');
  fs.copyFileSync(HELPER, elsewhere);
  const upper = path.join(alt, 'ZUMI-VAULT.EXE');
  const cases = [
    ['renamed exe', { vaultExe: renamed, hostDir: alt }, 'vault_exe_rejected'],
    ['right name, but not the host dir', { vaultExe: elsewhere, hostDir: HOST_DIR }, 'vault_exe_rejected'],
    ['relative exe path', { vaultExe: 'zumi-vault.exe', hostDir: HOST_DIR }, 'vault_exe_rejected'],
    ['relative host dir', { vaultExe: HELPER, hostDir: path.relative(process.cwd(), HOST_DIR) }, 'vault_exe_rejected'],
    ['no exe argument', { vaultExe: null, hostDir: HOST_DIR }, 'vault_exe_missing'],
    ['missing file', { vaultExe: path.join(HOST_DIR, 'nope', 'zumi-vault.exe'), hostDir: path.join(HOST_DIR, 'nope') }, 'vault_exe_missing'],
  ];
  for (const [label, args, word] of cases) {
    const words = [];
    const ss = createVaultSafeStorage({ ...args, log: (c) => words.push(c) });
    ok(ss.isEncryptionAvailable() === false && words.length === 1 && words[0] === word, `2: ${label} -> unavailable, one fixed code word (${word})`, JSON.stringify(words));
  }
  // an upper-case file name is a different name for this rule (exact), even though NTFS would resolve it
  fs.copyFileSync(HELPER, upper);
  const v = validateVaultExe(path.join(alt, 'ZUMI-VAULT.EXE'), alt);
  ok(v.ok === false, '2: the file name must be exactly zumi-vault.exe (case-exact)');
  ok(validateVaultExe(HELPER, HOST_DIR).ok === true, '2: the real helper beside its host dir validates');
  const argv = parseVaultArgs(['--data-dir', 'X', '--vault-exe', 'A', '--host-dir', 'B']);
  ok(argv.vaultExe === 'A' && argv.hostDir === 'B' && parseVaultArgs([]).vaultExe === null, '2: main.mjs parses --vault-exe / --host-dir (absent = null)');

  // Modules with the unavailable adapter: Electron's own no-encryption answers.
  const off = createVaultSafeStorage({ vaultExe: renamed, hostDir: alt });
  const dir = scratch('noenc');
  const stores = createSecretStores({ safeStorage: off, dataDir: dir });
  const brain = stores.brainKey({ fetchImpl: async () => { throw new Error('no network in this check'); } });
  const r = await brain.save(`sk-or-v1-${crypto.randomBytes(24).toString('hex')}`);
  ok(r.ok === false && r.error === 'no_encryption' && r.encryption === false, '2: brainKey.save -> no_encryption when the helper is unavailable', JSON.stringify(r));
  const live = stores.liveBoard({ publicDir: dir, now: () => 1_700_000_000_000 });
  const c = live.secrets.configure({ token: '', user: 'u', pass: 'p', pin: '482913' });
  ok(c.ok === false && c.error === 'no_encryption', '2: board configure -> the module\'s unavailable result (no_encryption)', JSON.stringify(c));
  ok(filesUnder(dir).length === 0, '2: nothing was written while unavailable');
}

// ---- 3. a missing file never reaches the helper ----------------------------------------------------------
function spied() {
  const calls = [];
  const real = childProcess.execFileSync;
  const exec = (exe, args, opts) => { calls.push({ exe, args: [...args], opts: { ...opts, input: undefined }, inputLen: opts && opts.input ? opts.input.length : 0, inputText: opts && opts.input ? Buffer.from(opts.input).toString('latin1') : '' }); return real(exe, args, opts); };
  return { calls, exec };
}
{
  const dir = scratch('missing');
  const spy = spied();
  const ss = adapter({ execFileSync: spy.exec });
  const baseline = spy.calls.length; // the one `available` probe
  const stores = createSecretStores({ safeStorage: ss, dataDir: dir });
  const brain = stores.brainKey();
  const st = brain.status();
  const leda = stores.ledaTts();
  const hasKey = leda.hasKey();
  const jev = stores.reflexJev({ egressAllowed: true });
  const ctl = createSecretsController({ safeStorage: ss, dir });
  ok(spy.calls.length === baseline && baseline === 1 && spy.calls[0].args[0] === 'available', '3: only the start-up probe ran; no read path called the helper', `calls=${spy.calls.length}`);
  ok(st.saved === false && hasKey === false && jev && ctl.status().configured === false, '3: missing files read as "no key" / "not configured"');
  const unlock = ctl.unlock ? ctl.unlock('482913') : null;
  ok(spy.calls.length === 1, '3: board unlock with no file never spawns the helper', unlock && JSON.stringify(unlock).slice(0, 60));
}

// ---- 4. a corrupted blob in the preview dir: module says null/corrupt, the file stays byte-identical -----
{
  const dir = scratch('corrupt');
  const ss = adapter();
  const KEY = `sk-or-v1-${crypto.randomBytes(24).toString('hex')}`;
  const { createKeyStore } = require('../src/main/reflex-jev.js');
  const ks = createKeyStore({ safeStorage: ss, dir });
  ok(ks.write(KEY).ok === true && ks.read() === KEY, '4: baseline key store write/read through the real helper');
  const binFile = path.join(dir, 'jev-key.bin');
  const good = fs.readFileSync(binFile);
  const bad = Buffer.from(good); bad[bad.length - 1] ^= 0x55;
  fs.writeFileSync(binFile, bad);
  ok(ks.read() === null, '4: key store read of a corrupted blob returns null');
  ok(Buffer.compare(fs.readFileSync(binFile), bad) === 0, '4: the corrupted file is still on disk, byte-identical');
  const truncated = good.subarray(0, 30);
  fs.writeFileSync(binFile, truncated);
  ok(ks.read() === null && Buffer.compare(fs.readFileSync(binFile), truncated) === 0, '4: a truncated blob reads null and is left alone');
  const foreign = Buffer.concat([Buffer.from('v10'), crypto.randomBytes(48)]);
  fs.writeFileSync(binFile, foreign);
  ok(ks.read() === null && Buffer.compare(fs.readFileSync(binFile), foreign) === 0, '4: a Chromium v10 blob is never decrypted in daily mode (null, kept)');

  const bdir = scratch('corrupt-board');
  const ctl = createSecretsController({ safeStorage: ss, dir: bdir });
  ok(ctl.configure({ token: 't'.repeat(8), user: 'user', pass: 'pass', pin: '482913' }).ok === true, '4: board configure through the real helper');
  const ctl2 = createSecretsController({ safeStorage: ss, dir: bdir });
  const bfile = path.join(bdir, 'board-secrets.bin');
  const bgood = fs.readFileSync(bfile);
  const bbad = Buffer.from(bgood); bbad[bbad.length - 1] ^= 0x55;
  fs.writeFileSync(bfile, bbad);
  const un = ctl2.unlock('482913');
  ok(un && un.ok === false && un.error === 'corrupt', '4: board unlock of a corrupted blob -> corrupt', JSON.stringify(un));
  ok(Buffer.compare(fs.readFileSync(bfile), bbad) === 0, '4: the corrupted board file is byte-identical afterwards');
}

// ---- 5. error redaction: nothing from the failed child reaches the thrown Error ----------------------------
{
  const C = canary('redact');
  const forced = (script, extra = {}) => (exe, args, opts) => (args[0] === 'available'
    ? childProcess.execFileSync(process.execPath, ['-e', ''], { ...opts, input: undefined })
    : childProcess.execFileSync(process.execPath, ['-e', script], { ...opts, ...extra }));
  const scripts = {
    'forced exit 3 with the canary on stdout and stderr': [`process.stdout.write('${C}');process.stderr.write('${C}');process.exit(3)`, {}],
    'timeout (ETIMEDOUT) with partial stdout': [`process.stdout.write('${C}');setTimeout(()=>{},60000)`, { timeout: 400 }],
    'maxBuffer (ENOBUFS) with partial stdout': [`process.stdout.write('${C}'.repeat(100000))`, { maxBuffer: 1024 }],
  };
  for (const [label, [script, extra]] of Object.entries(scripts)) {
    const ss = createVaultSafeStorage({ vaultExe: HELPER, hostDir: HOST_DIR, execFileSync: forced(script, extra) });
    for (const [verb, call, msg] of [['encrypt', () => ss.encryptString(`secret-${C}`), ENCRYPT_FAILED], ['decrypt', () => ss.decryptString(Buffer.from(`blob-${C}`)), DECRYPT_FAILED]]) {
      let e = null;
      try { call(); } catch (x) { e = x; }
      const dump = e ? util.inspect(e, { showHidden: true, depth: 6 }) + JSON.stringify(e) + String(e.stack) + Object.getOwnPropertyNames(e).join(',') : '';
      ok(e instanceof Error && e.message === msg, `5: ${label}: ${verb} throws exactly ${msg}`, e && e.message);
      ok(e && !dump.includes(C) && !dump.includes(process.execPath.slice(0, 12) + '-e'), `5: ${label}: ${verb} error carries no canary anywhere`);
      ok(e && Object.keys(e).length === 0 && e.cause === undefined && e.stdout === undefined && e.stderr === undefined && e.cmd === undefined && e.code === undefined && e.status === undefined,
        `5: ${label}: ${verb} error has no enumerable or forwarded properties (no .stdout/.stderr/.cmd/.cause/.code)`);
      ok(e && Object.getOwnPropertyNames(e).every((n) => n === 'stack' || n === 'message'), `5: ${label}: ${verb} error owns only stack and message`);
    }
  }
  // a real forced exit 3 from the real helper (corrupt blob), and a real timeout against the real helper
  const ss = adapter();
  let e1 = null; try { ss.decryptString(Buffer.concat([Buffer.from([1, 0, 0, 0, 0xd0, 0x8c, 0x9d, 0xdf]), crypto.randomBytes(64)])); } catch (x) { e1 = x; }
  ok(e1 && e1.message === DECRYPT_FAILED && Object.keys(e1).length === 0, '5: real helper exit 3 -> fixed decrypt error');
  const slow = createVaultSafeStorage({ vaultExe: HELPER, hostDir: HOST_DIR, execFileSync: (exe, args, opts) => childProcess.execFileSync(exe, args, args[0] === 'available' ? opts : { ...opts, timeout: 1 }) });
  let e2 = null; try { slow.encryptString(`secret-${C}`); } catch (x) { e2 = x; }
  ok(e2 && e2.message === ENCRYPT_FAILED && !util.inspect(e2, { showHidden: true, depth: 6 }).includes(C), '5: a real 1 ms timeout against the real helper -> fixed encrypt error, nothing attached');
  // module level: a failing adapter inside a store still never leaks through the module's own log
  const logs = [];
  const KEY = `sk-or-v1-${crypto.randomBytes(24).toString('hex')}`;
  const failing = createVaultSafeStorage({ vaultExe: HELPER, hostDir: HOST_DIR, execFileSync: (exe, args, opts) => (args[0] === 'available' ? childProcess.execFileSync(exe, args, opts) : (() => { const er = new Error(`boom ${KEY}`); er.stdout = Buffer.from(KEY); throw er; })()) });
  const { createKeyStore } = require('../src/main/reflex-jev.js');
  const w = createKeyStore({ safeStorage: failing, dir: scratch('redact-store'), log: (m) => logs.push(m) }).write(KEY);
  ok(w.ok === false && w.error === 'write_failed' && !logs.join('\n').includes(KEY), '5: a failing helper makes the key store answer write_failed and the module log carries no key', JSON.stringify(logs));
}

// ---- 6. spawn arguments: exactly [verb], no data in argv, exact options ----------------------------------
{
  const spy = spied();
  const ss = adapter({ execFileSync: spy.exec });
  const C = canary('argv');
  const blob = ss.encryptString(C);
  const back = ss.decryptString(blob);
  ok(back === C, '6: round trip through the spied adapter');
  const verbs = spy.calls.map((c) => c.args.join('|'));
  ok(JSON.stringify(verbs) === JSON.stringify(['available', 'protect', 'unprotect']), '6: argv is exactly [verb] on every call', verbs.join(' / '));
  ok(spy.calls.every((c) => !JSON.stringify([c.exe, c.args, c.opts]).includes(C)), '6: no secret appears in argv, the exe path or the options');
  ok(spy.calls[1].inputText.includes(C) && !spy.calls[2].inputText.includes(C), '6: the plaintext goes on stdin of protect only; unprotect gets the blob');
  const o = spy.calls[1].opts;
  ok(o.shell === false && o.windowsHide === true && o.timeout === 5000 && o.maxBuffer === 256 * 1024, '6: shell=false, windowsHide, timeout 5000 ms, maxBuffer 256 KiB');
  ok(Array.isArray(o.stdio) && o.stdio.join() === 'pipe,pipe,pipe', '6: stdio is pipe,pipe,pipe (no inherited handles, no files)');
  ok(Object.keys(o.env).every((k) => ['SystemRoot', 'USERPROFILE', 'APPDATA'].includes(k)), '6: env keeps only SystemRoot, USERPROFILE, APPDATA', Object.keys(o.env).join());
  ok(spy.calls.every((c) => c.exe === path.join(fs.realpathSync(HOST_DIR), 'zumi-vault.exe')), '6: always the validated absolute helper path (no PATH lookup)');
}

// ---- 7. leak grep: canary keys through every store, then grep every output surface --------------------------
{
  const dir = scratch('leak');
  const surfaces = [];
  const logLines = [];
  const realOut = process.stdout.write.bind(process.stdout), realErr = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stdout.write = (c, ...a) => { captured.push(String(c)); return realOut(c, ...a); };
  process.stderr.write = (c, ...a) => { captured.push(String(c)); return realErr(c, ...a); };
  const canaries = {};
  try {
    const ss = adapter();
    const stores = createSecretStores({ safeStorage: ss, dataDir: dir, log: (m) => logLines.push(String(m)) });
    const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ data: {} }), text: async () => '{}' });
    // BYOK keys, all four providers (each provider's own shape, with the canary inside the shape)
    const shapes = {
      openrouter: (c) => `sk-or-v1-${c.replace(/[^A-Za-z0-9_-]/g, '')}`,
      gemini: (c) => `AIza${c.replace(/[^A-Za-z0-9_-]/g, '').padEnd(35, 'x').slice(0, 35)}`,
      groq: (c) => `gsk_${c.replace(/[^A-Za-z0-9_-]/g, '')}`,
      opencode: (c) => `oc_sk_${c.replace(/[^A-Za-z0-9_-]/g, '')}`,
    };
    for (const id of Object.keys(shapes)) {
      const c = canary(id).replace(/-/g, '');
      const key = shapes[id](c);
      canaries[id] = key;
      const brain = stores.brainKey({ getProvider: () => id, fetchImpl: okFetch });
      const r = await brain.save(key);
      const st = brain.status();
      logLines.push(JSON.stringify(r), JSON.stringify(st));
      ok(r.ok === true, `7: ${id} key saved through the real helper`, JSON.stringify(r).slice(0, 80));
      ok(!JSON.stringify(r).includes(key) && !JSON.stringify(st).includes(key), `7: ${id} save/status replies carry no key`);
    }
    // Leda / Google TTS key, cloud token (via its one-shot import file), board secrets (pin and os modes)
    const ledaKey = `AIza${canary('leda').replace(/[^A-Za-z0-9_-]/g, '').padEnd(35, 'y').slice(0, 35)}`;
    canaries.leda = ledaKey;
    const leda = stores.ledaTts();
    ok(leda.setKey(ledaKey) === true && leda.hasKey() === true, '7: leda key saved + read back through the real helper');
    const tokenText = canary('cloud').replace(/[^A-Za-z0-9_-]/g, '').padEnd(40, 'z');
    canaries.cloud = tokenText;
    fs.writeFileSync(path.join(dir, 'cloud-token.import'), tokenText);
    const { createTokenStore } = require('../src/main/cloud.js');
    const ts = createTokenStore({ safeStorage: ss, dir, log: (m) => logLines.push(String(m)) });
    ok(ts.importIfPresent() === 'imported' && ts.read() === tokenText, '7: cloud token imported (one-shot file) and read back');
    ok(!fs.existsSync(path.join(dir, 'cloud-token.import')), '7: the plaintext import file is destroyed');
    const user = canary('boarduser'), pass = canary('boardpass'), tok = canary('boardtoken'), pin = '482913';
    Object.assign(canaries, { boardUser: user, boardPass: pass, boardToken: tok });
    const live = stores.liveBoard({ publicDir: dir, now: () => 1_700_000_000_000 });
    const cfg = live.secrets.configure({ token: tok, user, pass, pin });
    logLines.push(JSON.stringify(cfg), JSON.stringify(live.status()));
    ok(cfg.ok === true, '7: board secrets configured (pin envelope)', JSON.stringify(cfg));
    const dirOs = scratch('leak-os');
    const ctlOs = createSecretsController({ safeStorage: ss, dir: dirOs });
    ok(ctlOs.configureOs({ token: tok, user, pass }).ok === true, '7: board secrets configured (os envelope)');
    await new Promise((r) => setTimeout(r, 50));
    surfaces.push(dir, dirOs);
  } finally {
    process.stdout.write = realOut; process.stderr.write = realErr;
  }
  const needles = Object.values(canaries);
  const hay = [['module logs + replies', logLines.join('\n')], ['sidecar/host stdout+stderr during the run', captured.join('')], ['adapter code words', codeWords.join('\n')]];
  for (const d of surfaces) for (const f of filesUnder(d)) hay.push([`file ${path.relative(SCRATCH, f)}`, fs.readFileSync(f).toString('latin1')]);
  // %TEMP%: anything touched in the last 15 minutes (the helper must not drop temp files); bounded walk
  const tmpRoot = os.tmpdir();
  const recent = [];
  const since = Date.now() - 15 * 60 * 1000;
  // %TEMP% can hold hundreds of thousands of entries: descend only into directories touched in the window, budget 30k stats.
  let budget = 30000;
  const walkTmp = (d, depth) => { let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { if (budget-- <= 0) return; const p = path.join(d, e.name); try { const st = fs.statSync(p); if (st.mtimeMs < since) continue; if (e.isDirectory()) { if (depth < 3) walkTmp(p, depth + 1); } else if (st.size < 4_000_000) recent.push(p); } catch { /* raced */ } } };
  walkTmp(tmpRoot, 0);
  for (const f of recent) { try { hay.push([`temp ${path.basename(f)}`, fs.readFileSync(f).toString('latin1')]); } catch { /* locked */ } }
  let hits = [];
  for (const [label, text] of hay) for (const n of needles) if (text.includes(n)) hits.push(`${label} contains a ${n.slice(0, 14)}...`);
  // the one allowed leak-shaped thing: the plaintext last4 cache files (4 chars) hold no full key; the full needles never match them
  ok(hits.length === 0, `7: zero canary hits across ${hay.length} surfaces (logs, replies, stdout/stderr, preview data dir, bounded %TEMP% scan)`, hits.slice(0, 3).join(' | '));
  const bins = filesUnder(dir).filter((f) => f.endsWith('.bin'));
  ok(bins.length >= 6 && bins.every((f) => fs.readFileSync(f).subarray(0, 4).equals(Buffer.from([1, 0, 0, 0]))), `7: ${bins.length} secret files, each a raw DPAPI blob`);
  ok(filesUnder(dir).every((f) => !f.endsWith('.tmp')), '7: no .tmp file is left behind');
}

// ---- 8. poisoned Electron dir: the preview never reads it -----------------------------------------------
{
  const electron = scratch('poisoned-electron');
  const ss = adapter();
  const KEY = `sk-or-v1-${crypto.randomBytes(24).toString('hex')}`;
  fs.writeFileSync(path.join(electron, 'jev-key.bin'), ss.encryptString(KEY)); // even a blob THIS helper can open
  fs.writeFileSync(path.join(electron, 'jev-key.last4'), KEY.slice(-4));
  fs.writeFileSync(path.join(electron, 'leda-key.bin'), ss.encryptString('AIza' + 'q'.repeat(35)));
  fs.writeFileSync(path.join(electron, 'board-secrets.bin'), ss.encryptString('{}'));
  const before = dirHash(electron);
  const preview = scratch('poisoned-preview');
  const stores = createSecretStores({ safeStorage: ss, dataDir: preview });
  const st = stores.brainKey().status();
  ok(st.saved === false && st.last4 === null, '8: preview brainKey reports "no key" while Electron\'s folder holds jev-key.bin', JSON.stringify(st));
  ok(stores.ledaTts().hasKey() === false, '8: preview leda reports no key');
  ok(stores.liveBoard({ publicDir: preview }).status().configured === false, '8: preview board reports not configured');
  ok(dirHash(electron) === before, '8: Electron fixture dir is byte-identical');
  // and through the real sidecar process: handshake, self-check, no key rpc exists
  const sdata = scratch('sidecar-data');
  const run = (extraArgs) => new Promise((resolve) => {
    const child = childProcess.spawn(process.execPath, [path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), '--data-dir', sdata, '--no-voice-prefetch', ...extraArgs], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    let sent = false, ended = false;
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      out += d;
      if (!sent && out.includes('"ready"')) { sent = true; child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"info"}\n'); }
      if (!ended && out.includes('"id":1')) { ended = true; child.stdin.end(); }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => resolve({ out, err }));
    setTimeout(() => child.kill(), 15000).unref();
  });
  const good = await run(['--vault-exe', HELPER, '--host-dir', HOST_DIR]);
  ok(/\[sidecar\] vault_ready/.test(good.err) && good.out.includes('"ready"'), '8: the real sidecar starts, runs the self-check and logs vault_ready', good.err.slice(0, 120));
  const wrong = await run(['--vault-exe', HELPER, '--host-dir', path.join(HOST_DIR, '..')]);
  ok(/\[sidecar\] vault_exe_rejected/.test(wrong.err), '8: a --host-dir that is not the helper\'s dir is rejected (vault_exe_rejected)', wrong.err.slice(0, 120));
  const none = await run([]);
  ok(/\[sidecar\] vault_exe_missing/.test(none.err) && none.out.includes('"ready"'), '8: no --vault-exe: the sidecar still starts, with the vault honestly unavailable');
  ok(!(good.err + wrong.err + none.err + good.out).includes(KEY), '8: no key text on the sidecar streams');
}

// ---- 9. the existing module checks, re-run with the REAL adapter instead of the reversible fake -------------
if (QUICK) {
  console.log('SKIP 9: --quick (run without it, or: ZUMI_VAULT_EXE=<exe> node scripts/check-brain-key.mjs ...)');
} else {
  for (const name of ['check-brain-key', 'check-byok', 'check-board-live', 'check-board-pin-toggle']) {
    const r = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'scripts', `${name}.mjs`)], { env: { ...process.env, ZUMI_VAULT_EXE: HELPER }, encoding: 'utf8', timeout: 240000, windowsHide: true });
    const tail = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    ok(r.status === 0 && /^PASS /.test(tail), `9: ${name} stays green with the real vault adapter`, `${tail}  ${(r.stderr || '').slice(0, 120)}`);
  }
}

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
