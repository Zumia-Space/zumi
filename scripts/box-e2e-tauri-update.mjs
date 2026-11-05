#!/usr/bin/env node
// Tauri auto-update end-to-end (PLAN-UPDATER.md section 8), modelled on box-e2e-update.mjs. Two halves, because compiling runs on
// the main PC and launching only on the render box:
//
//   node scripts/box-e2e-tauri-update.mjs --plan                 prints the steps; builds, installs and launches nothing
//   node scripts/box-e2e-tauri-update.mjs --prepare --work <dir> main PC: per-run test keys, two builds, the feed tree; launches nothing
//   ZUMI_ELECTRON_HOST=box node scripts/box-e2e-tauri-update.mjs --run --work <dir> [--case 1,3] [--port 47822] [--soak-marker <file>]
//
// The keys are generated per run, sign only this run's files, and are deleted when --prepare ends: the box never holds one. The
// builds carry the off-by-default update-e2e feature and their own identity (tauri/verify/update-e2e.conf.json), so nothing touches
// a real install. Evidence per case: <work>/evidence/<case>/ verdict.json, updater.log, feed-requests.log, processes.txt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFeedServer } from './serve-update-feed.mjs';
import { makeFeed } from './make-update-feed.mjs';
import { assertElectronHost } from './lib/electron-guard.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const WORK = path.resolve(opt('--work', path.join(os.tmpdir(), 'zumi-update-e2e')));
const PORT = Number(opt('--port', '47822'));
const SOAK = opt('--soak-marker', null);
const ONLY = opt('--case', '') ? opt('--case', '').split(',') : null;
const OLD = '5.0.0', NEW = '5.0.1', LOWER = '4.9.9';
const OVERLAY = JSON.parse(fs.existsSync(path.join(ROOT, 'tauri/verify/update-e2e.conf.json')) ? fs.readFileSync(path.join(ROOT, 'tauri/verify/update-e2e.conf.json'), 'utf8') : '{}');
const PRODUCT = 'ZumiUpdateE2E', APP_ID = 'space.zumia.update-e2e';
const FEED = path.join(WORK, 'feed');
const INSTALL_DIR = path.join(WORK, 'install');
const EXE = path.join(INSTALL_DIR, `${PRODUCT}.exe`);
const APPDATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_ID);
const LOCAL_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_ID);
const LOG_FILE = path.join(APPDATA_DIR, 'logs', 'updater.log');
const QUIT_FILE = path.join(WORK, 'quit-now');
const MIN = 60_000;

const PLAN = [
  `--prepare (main PC, launches nothing): two per-run minisign key pairs; renderer, stage --flavour public; cargo tauri build --config <overlay> --features update-e2e for ${OLD} and ${NEW}; a stand-in exe that exits 1; feed tree; keys deleted`,
  `--run (box only: refuses without ZUMI_ELECTRON_HOST=box; exit 3 if --soak-marker names a file that exists). Each case: fresh ${OLD} install, then:`,
  `1 restart: Restart now -> exe is ${NEW} and relaunched; old host and sidecar pids gone`,
  `2 quit: Later, then a normal quit -> installs ${NEW}; the app does not reopen; next launch is ${NEW}; time from quit to installer recorded`,
  `3 bad signature, one installer byte flipped: feed shows the download, rejected at verify; still ${OLD}, running, sidecar answering`,
  `4 signature from a different valid key: same as 3`,
  `5 empty signature, then malformed signature: same as 3. 5c replay: the old release's real installer and signature announced as ${NEW}: refused by the signed version, still ${OLD}`,
  `6 withdrawn after download: next check deletes the pending file; a quit leaves ${OLD}`,
  `7 offline then back: quiet, pending file kept, next check succeeds with no second download`,
  `8 feed lists ${LOWER}, then ${OLD}: no offer, no installer download`,
  `9 data: marker files and a vault secret written on ${OLD} read back on ${NEW}`,
  `10 a stubborn job member running from the install dir: nothing left in the job when the installer starts; its file is replaced`,
  `11 stale files: code files only ${OLD} had stay on disk and never run`,
  `12a validly signed stand-in that exits 1: old version reopens by hand. 12b a held lock on a resource file: records what /P does; the next launch finds the mixed install`,
  `13 release candidate is NOT here: it needs the CI draft (launch step P3)`,
  `Cases 3 to 5 count only if case 1 passes in the same run with the same builds; a rejection with no download hit fails`,
];
if (args.includes('--plan')) { console.log(PLAN.map((s, i) => `${i + 1}. ${s}`).join('\n')); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ---------- --prepare: main PC, launches nothing ----------
function prepare() {
  const env = { ...process.env, LOCALAPPDATA: path.join(ROOT, '.tauri-cache') };
  const TAURI = path.join(ROOT, 'tauri');
  const run = (cmd, argv, o = {}) => {
    say(`$ ${cmd} ${o.secretArgs ? argv[0] : argv.join(' ')}`); // a key password never reaches the log
    const r = spawnSync(cmd, argv, { cwd: o.cwd || ROOT, stdio: o.quiet ? 'pipe' : 'inherit', shell: o.shell || false, env: { ...env, ...(o.env || {}) }, timeout: 60 * MIN });
    if (r.status !== 0) throw new Error(`${cmd} ${argv[0]} exited ${r.status}`);
  };
  const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const gitDirty = spawnSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() !== '';
  fs.rmSync(WORK, { recursive: true, force: true });
  const keys = path.join(WORK, 'keys');
  fs.mkdirSync(keys, { recursive: true });
  const password = crypto.randomBytes(24).toString('hex');
  const keyEnv = { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
  // stdout stays captured: the generator prints the public key and the file paths.
  for (const name of ['a', 'b']) run('cargo-tauri', ['signer', 'generate', '--ci', '--password', password, '--write-keys', path.join(keys, `${name}.key`), '--force'], { quiet: true, secretArgs: true });
  const pubkey = fs.readFileSync(path.join(keys, 'a.key.pub'), 'utf8').trim();
  // As the release workflow signs: a separate step after the build, bound to the version.
  const sign = (keyName, file, version) => run('cargo-tauri', ['signer', 'sign', '--private-key-path', path.join(keys, `${keyName}.key`), '--app-version', version, file], { quiet: true, env: keyEnv });

  run('npm', ['run', 'build:renderer'], { shell: true });
  run(process.execPath, [path.join(TAURI, 'prep-ui.mjs'), '--flavour', 'public']);
  run('cargo', ['build', '--release', '--manifest-path', path.join(TAURI, 'src-tauri', 'Cargo.toml'), '--bin', 'zumi-vault']);
  run(process.execPath, [path.join(TAURI, 'stage-bundle.mjs'), '--flavour', 'public']);

  const target = process.env.CARGO_TARGET_DIR || path.join(TAURI, 'src-tauri', 'target');
  const nsis = path.join(target, 'release', 'bundle', 'nsis');
  const built = {};
  for (const version of [OLD, NEW]) {
    const overlay = path.join(WORK, `overlay-${version}.json`);
    fs.writeFileSync(overlay, JSON.stringify({ ...OVERLAY, version, plugins: { updater: { ...OVERLAY.plugins.updater, pubkey, endpoints: [`http://127.0.0.1:${PORT}/latest.json`] } } }, null, 2));
    fs.rmSync(nsis, { recursive: true, force: true });
    run('cargo-tauri', ['build', '--config', overlay, '--features', 'update-e2e'], { cwd: TAURI });
    const setup = fs.readdirSync(nsis).find((n) => n.endsWith('-setup.exe'));
    if (!setup) throw new Error(`build ${version}: no installer in ${nsis}`);
    const out = path.join(WORK, `build-${version}`);
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.join(nsis, setup), path.join(out, setup));
    sign('a', path.join(out, setup), version);
    built[version] = path.join(out, setup);
  }

  // The stand-in: a real exe, validly signed, that exits 1 (case 12a).
  const standinDir = path.join(WORK, 'standin');
  fs.mkdirSync(standinDir, { recursive: true });
  const standinSrc = path.join(standinDir, 'exit1.rs');
  fs.writeFileSync(standinSrc, 'fn main() { std::process::exit(1) }\n');
  const standin = path.join(standinDir, `${PRODUCT}_${NEW}_x64-setup.exe`);
  run('rustc', ['-O', '-o', standin, standinSrc], { quiet: true });
  sign('a', standin, NEW);

  // One tree, several manifests: --run copies the chosen one to latest.json.
  const notes = path.join(WORK, 'notes.md');
  fs.writeFileSync(notes, `## vi\n• Bản thử ${NEW} (e2e).\n\n## en\n• Test build ${NEW} (e2e).\n`);
  const base = `http://127.0.0.1:${PORT}`;
  const good = makeFeed({ installer: built[NEW], notes, version: NEW, baseUrl: `${base}/good`, out: path.join(FEED, 'good'), pubkey });
  const manifest = (name, edit) => {
    const m = JSON.parse(fs.readFileSync(good.feedFile, 'utf8'));
    edit(m, m.platforms['windows-x86_64']);
    fs.writeFileSync(path.join(FEED, `${name}.json`), JSON.stringify(m, null, 2));
  };
  manifest('m-good', () => {});
  const assetPath = (dir) => path.join(FEED, dir, good.assetName);
  // Case 3: one byte flipped, the good signature kept.
  fs.mkdirSync(path.join(FEED, 'flipped'), { recursive: true });
  const bytes = fs.readFileSync(built[NEW]);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(assetPath('flipped'), bytes);
  manifest('m-flipped', (_, p) => { p.url = `${base}/flipped/${good.assetName}`; });
  // Case 4: the exact bytes, signed by the other valid key.
  fs.mkdirSync(path.join(FEED, 'otherkey'), { recursive: true });
  fs.copyFileSync(built[NEW], assetPath('otherkey'));
  sign('b', assetPath('otherkey'), NEW);
  const otherSig = fs.readFileSync(`${assetPath('otherkey')}.sig`, 'utf8').trim();
  fs.rmSync(`${assetPath('otherkey')}.sig`);
  manifest('m-otherkey', (_, p) => { p.url = `${base}/otherkey/${good.assetName}`; p.signature = otherSig; });
  // Case 5.
  manifest('m-emptysig', (_, p) => { p.signature = ''; });
  manifest('m-badsig', (_, p) => { p.signature = 'bm90IGEgbWluaXNpZ24gc2lnbmF0dXJl'; });
  // Cases 6 and 8.
  manifest('m-lower', (m) => { m.version = LOWER; });
  manifest('m-same', (m) => { m.version = OLD; });
  // Case 5c, replay: the older release's real installer and real signature, announced under the newer version number.
  fs.mkdirSync(path.join(FEED, 'replay'), { recursive: true });
  fs.copyFileSync(built[OLD], assetPath('replay'));
  const oldSig = fs.readFileSync(`${built[OLD]}.sig`, 'utf8').trim();
  manifest('m-replay', (_, p) => { p.url = `${base}/replay/${good.assetName}`; p.signature = oldSig; });
  // Case 12a.
  fs.mkdirSync(path.join(FEED, 'standin'), { recursive: true });
  fs.copyFileSync(standin, assetPath('standin'));
  const standinSig = fs.readFileSync(`${standin}.sig`, 'utf8').trim();
  manifest('m-standin', (_, p) => { p.url = `${base}/standin/${good.assetName}`; p.signature = standinSig; });

  fs.rmSync(keys, { recursive: true, force: true });
  fs.rmSync(nsis, { recursive: true, force: true }); // a test installer left here would fail the next real build's version gate
  fs.writeFileSync(path.join(WORK, 'prepared.json'), JSON.stringify({
    tool: 'scripts/box-e2e-tauri-update.mjs --prepare', gitHead, gitDirty, old: OLD, new: NEW, keysDeleted: true,
    installers: { [OLD]: { file: path.relative(WORK, built[OLD]), sha256: sha256(built[OLD]) }, [NEW]: { file: path.relative(WORK, built[NEW]), sha256: sha256(built[NEW]) } },
    assetName: good.assetName,
  }, null, 2));
  say(`prepared ${WORK}: copy it and these scripts to the box, then --run`);
}

if (args.includes('--prepare')) {
  try { prepare(); process.exit(0); } catch (e) { console.error(`prepare failed: ${e.message}`); process.exit(1); }
}

// ---------- --run: the box only ----------
try { assertElectronHost('box-e2e-tauri-update.mjs --run (installs and launches a packaged Zumi)'); } catch (e) { console.error(`${e.message} (--plan prints the steps anywhere)`); process.exit(2); }
if (!args.includes('--run')) { console.error('use --plan, --prepare or --run'); process.exit(2); }
if (SOAK && fs.existsSync(SOAK)) { console.error(`soak marker ${SOAK} exists: the box is busy. Nothing done.`); process.exit(3); }

const prepared = JSON.parse(fs.readFileSync(path.join(WORK, 'prepared.json'), 'utf8'));
const installerOf = (version) => path.join(WORK, prepared.installers[version].file);
const ps = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).stdout.trim();
const exeVersion = () => (fs.existsSync(EXE) ? ps(`(Get-Item -LiteralPath '${EXE}').VersionInfo.ProductVersion`) : null);
const processes = () => {
  const out = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${INSTALL_DIR.replace(/\//g, '\\')}*' -or $_.CommandLine -like '*${INSTALL_DIR.replace(/\//g, '\\')}*' -or $_.Name -like '*_x64-setup*' -or $_.Name -like '*-installer*' } | Where-Object { $_.Name -ne 'powershell.exe' } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`);
  return out ? out.split(/\r?\n/).map((l) => { const [pid, name] = l.split('|'); return { pid: Number(pid), name }; }) : [];
};
const hostPids = () => processes().filter((p) => p.name === `${PRODUCT}.exe`).map((p) => p.pid);
const sidecarPids = () => processes().filter((p) => p.name === 'node.exe').map((p) => p.pid);
const running = () => hostPids().length > 0;
const killAll = () => { for (const p of processes()) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(p.pid)], { encoding: 'utf8' }); };
const updaterLog = () => { try { return fs.readFileSync(LOG_FILE, 'utf8'); } catch { return ''; } };
const logTime = (re) => { const line = updaterLog().split('\n').find((l) => re.test(l)); return line ? Number(line.split(' ')[0]) : null; };
async function waitFor(what, fn, ms, every = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(every); }
  say(`timed out waiting for: ${what}`);
  return false;
}
const launch = (env = {}) => spawn(EXE, [], { detached: true, stdio: 'ignore', env: { ...process.env, ZUMI_UPDATE_INTERVAL_MS: '15000', ZUMI_UPDATE_E2E_QUIT_FILE: QUIT_FILE, ...env } }).unref();
const useManifest = (name) => fs.copyFileSync(path.join(FEED, `${name}.json`), path.join(FEED, 'latest.json'));
const quitNormally = async () => { fs.writeFileSync(QUIT_FILE, 'x'); await waitFor('app closed', () => !running(), MIN); fs.rmSync(QUIT_FILE, { force: true }); };

// WebView2 helpers outlive a killed host briefly and hold the profile folder.
const RM = { recursive: true, force: true, maxRetries: 20, retryDelay: 500 };
function uninstall() {
  killAll();
  const un = path.join(INSTALL_DIR, 'uninstall.exe');
  if (fs.existsSync(un)) spawnSync(un, ['/S'], { timeout: 2 * MIN });
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3']);
  fs.rmSync(INSTALL_DIR, RM);
}
function freshInstall() {
  uninstall();
  fs.rmSync(APPDATA_DIR, RM);
  fs.rmSync(LOCAL_DIR, RM);
  fs.rmSync(QUIT_FILE, { force: true });
  const r = spawnSync(installerOf(OLD), ['/S', `/D=${INSTALL_DIR.replace(/\//g, '\\')}`], { timeout: 5 * MIN });
  if (r.status !== 0) throw new Error(`fresh install exited ${r.status}`);
  if (exeVersion() !== OLD) throw new Error(`fresh install is ${exeVersion()}, not ${OLD}`);
}

const results = [];
async function runCase(id, name, body) {
  if (ONLY && !ONLY.includes(id)) return;
  say(`===== case ${id} ${name}`);
  const ev = path.join(WORK, 'evidence', `${id}-${name}`);
  fs.rmSync(ev, { recursive: true, force: true });
  fs.mkdirSync(ev, { recursive: true });
  let server = null;
  const serve = async () => { server = createFeedServer({ dir: FEED, port: PORT }); await server.port(); return server; };
  const allHits = [];
  const drain = () => { if (server) allHits.push(...server.hits.splice(0)); };
  const stopServing = async () => { drain(); if (server) await server.close(); server = null; };
  const installerHits = () => { drain(); return allHits.filter((h) => /\.exe$/.test(h.path) && h.method === 'GET' && (h.status === 200 || h.status === 206)).length; };
  let verdict;
  try {
    freshInstall();
    await serve();
    verdict = await body({ serve, stopServing, installerHits, ev });
  } catch (e) { verdict = { pass: false, error: String((e && e.stack) || e) }; }
  fs.writeFileSync(path.join(ev, 'processes.txt'), `${JSON.stringify(processes(), null, 1)}\n`);
  killAll();
  await stopServing();
  fs.writeFileSync(path.join(ev, 'updater.log'), updaterLog());
  fs.writeFileSync(path.join(ev, 'feed-requests.log'), `${allHits.map((h) => `${h.status} ${h.method} ${h.path}`).join('\n')}\n`);
  verdict = { case: id, name, tool: 'box-e2e-tauri-update.mjs', gitHead: prepared.gitHead, installerSha256: prepared.installers, ...verdict, exeVersionAfter: exeVersion() };
  fs.writeFileSync(path.join(ev, 'verdict.json'), JSON.stringify(verdict, null, 2));
  say(`case ${id}: ${verdict.pass ? 'PASS' : 'FAIL'} ${JSON.stringify({ ...verdict, installerSha256: undefined })}`);
  results.push(verdict);
}

/** Cases 3 to 5: the download happens, the signature check refuses it, and the app is untouched. */
const rejected = (manifest, kind = 'signature') => async ({ installerHits }) => {
  useManifest(manifest);
  launch({ ZUMI_UPDATE_E2E: 'restart' });
  const refused = await waitFor('a rejected download in updater.log', () => updaterLog().includes(`download rejected: ${kind} `), 5 * MIN);
  const answers = await waitFor('the sidecar answers after the rejection', () => {
    const lines = updaterLog().split('\n');
    const at = lines.findIndex((l) => /download rejected/.test(l));
    return at >= 0 && lines.slice(at).some((l) => /sidecar answers: true/.test(l));
  }, 2 * MIN);
  const downloads = installerHits();
  const pendingLeft = fs.existsSync(path.join(LOCAL_DIR, 'update-pending')) ? fs.readdirSync(path.join(LOCAL_DIR, 'update-pending')) : [];
  return { pass: refused && answers && downloads >= 1 && exeVersion() === OLD && running() && pendingLeft.length === 0, refused, answers, downloadHits: downloads, stillRunning: running(), pendingLeft };
};

fs.mkdirSync(path.join(WORK, 'evidence'), { recursive: true });
try {
  await runCase('1', 'restart', async ({ installerHits }) => {
    useManifest('m-good');
    launch({ ZUMI_UPDATE_E2E: 'restart' });
    const up = await waitFor('sidecar up', () => sidecarPids().length > 0 && running(), 2 * MIN);
    const oldHost = hostPids(), oldSidecar = sidecarPids();
    let peakBytes = 0;
    const updated = await waitFor(`exe version ${NEW}`, () => {
      const peak = Number(oldHost[0] && ps(`(Get-Process -Id ${oldHost[0]} -ErrorAction SilentlyContinue).PeakWorkingSet64`));
      if (peak > peakBytes) peakBytes = peak;
      return exeVersion() === NEW;
    }, 10 * MIN, 2000);
    const relaunched = updated && await waitFor('the relaunched host', () => hostPids().some((p) => !oldHost.includes(p)), 2 * MIN);
    const now = processes().map((p) => p.pid);
    const oldGone = ![...oldHost, ...oldSidecar].some((p) => now.includes(p));
    const stopped = /sidecar stopped, 0 job process\(es\) left/.test(updaterLog());
    const installOk = await waitFor('the install check on the new version', () => { const l = updaterLog(); return /install check: /.test(l.slice(l.lastIndexOf('on: current 5.0.1'))); }, MIN);
    const installLine = updaterLog().split('\n').filter((l) => /install check: /.test(l)).pop();
    if (!installOk || !/install check: ok/.test(installLine || '')) return { pass: false, installLine };
    return { pass: up && updated && relaunched && oldGone && stopped && installerHits() >= 1 && /downloaded 5\.0\.1; signature ok/.test(updaterLog()), up, updated, relaunched, oldGone, stopped, peakWorkingSetBytes: peakBytes, installerBytes: fs.statSync(installerOf(NEW)).size };
  });

  await runCase('2', 'quit', async () => {
    useManifest('m-good');
    const startedLater = Date.now();
    launch({ ZUMI_UPDATE_E2E: 'quit' });
    const updated = await waitFor(`exe version ${NEW} after a normal quit`, () => exeVersion() === NEW, 10 * MIN, 2000);
    await sleep(15000);
    const reopened = running();
    const quitAt = logTime(/quit: installing/), installerAt = logTime(/sidecar stopped/);
    const elapsed = quitAt && installerAt ? installerAt - quitAt : null;
    const leftoverDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`${PRODUCT}-`) && n.includes('-updater-'));
    const leftoversBefore = leftoverDirs().length;
    const mark = updaterLog().length;
    launch();
    const nextLaunch = await waitFor('next launch', () => running() && /on: current/.test(updaterLog().slice(mark)), MIN);
    const sameVersion = exeVersion() === NEW;
    const leftoversAfter = leftoverDirs().length;
    return { pass: updated && !reopened && nextLaunch && sameVersion && elapsed !== null && elapsed < 5000 && leftoversBefore >= 1 && leftoversAfter === 0, updated, reopened, nextLaunch, leftoversBefore, leftoversAfter, quitToInstallerMs: elapsed, forceExitGraceMs: 5000, testMs: Date.now() - startedLater };
  });

  await runCase('3', 'flipped-byte', rejected('m-flipped'));
  await runCase('4', 'other-key', rejected('m-otherkey'));
  await runCase('5a', 'empty-signature', rejected('m-emptysig'));
  await runCase('5b', 'malformed-signature', rejected('m-badsig'));
  await runCase('5c', 'replayed-old-release', rejected('m-replay', 'signed_version'));

  await runCase('6', 'withdrawn', async () => {
    useManifest('m-good');
    launch();
    const downloaded = await waitFor('downloaded', () => /downloaded 5\.0\.1/.test(updaterLog()), 5 * MIN);
    const pendingFile = path.join(LOCAL_DIR, 'update-pending', `${NEW}.exe`);
    const pendingWritten = fs.existsSync(pendingFile);
    useManifest('m-lower');
    const dropped = await waitFor('withdrawn in updater.log', () => /withdrawn, file deleted/.test(updaterLog()), 2 * MIN);
    const pendingGone = !fs.existsSync(pendingFile);
    await quitNormally();
    await sleep(15000);
    return { pass: downloaded && pendingWritten && dropped && pendingGone && exeVersion() === OLD && !running() && !/quit: installing/.test(updaterLog()), downloaded, pendingWritten, dropped, pendingGone };
  });

  await runCase('7', 'offline', async ({ serve, stopServing, installerHits }) => {
    useManifest('m-good');
    launch();
    const downloaded = await waitFor('downloaded', () => /downloaded 5\.0\.1/.test(updaterLog()), 5 * MIN);
    const hitsBefore = installerHits();
    await stopServing();
    const failed = await waitFor('a quiet failed check', () => /check failed: network/.test(updaterLog()), 2 * MIN);
    const kept = fs.existsSync(path.join(LOCAL_DIR, 'update-pending', `${NEW}.exe`));
    await serve();
    const mark = updaterLog().length;
    const back = await waitFor('the next check succeeds', () => /automatic check: available/.test(updaterLog().slice(mark)), 2 * MIN);
    return { pass: downloaded && failed && kept && back && installerHits() === hitsBefore && exeVersion() === OLD, downloaded, failed, kept, back, secondDownload: installerHits() !== hitsBefore };
  });

  await runCase('8', 'lower-then-same', async ({ installerHits }) => {
    useManifest('m-lower');
    launch();
    const lower = await waitFor('none for the lower version', () => /automatic check: none/.test(updaterLog()), 3 * MIN);
    useManifest('m-same');
    const mark = updaterLog().length;
    const same = await waitFor('none for the same version', () => /automatic check: none/.test(updaterLog().slice(mark)), 2 * MIN);
    return { pass: lower && same && installerHits() === 0 && !/available|downloading/.test(updaterLog()) && exeVersion() === OLD, lower, same, installerHits: installerHits() };
  });

  await runCase('9', 'data', async () => {
    useManifest('m-good');
    const vault = path.join(INSTALL_DIR, 'zumi-vault.exe');
    const secret = `e2e-marker-${crypto.randomBytes(8).toString('hex')}`;
    const blob = spawnSync(vault, ['protect'], { input: secret });
    const stored = path.join(APPDATA_DIR, 'e2e-secret.bin');
    const markerRoaming = path.join(APPDATA_DIR, 'e2e-marker.txt'), markerLocal = path.join(LOCAL_DIR, 'e2e-marker.txt');
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.writeFileSync(stored, blob.stdout);
    fs.writeFileSync(markerRoaming, secret);
    fs.writeFileSync(markerLocal, secret);
    launch({ ZUMI_UPDATE_E2E: 'restart' });
    const updated = await waitFor(`exe version ${NEW}`, () => exeVersion() === NEW, 10 * MIN, 2000);
    await waitFor('relaunch', running, 2 * MIN);
    const read = spawnSync(path.join(INSTALL_DIR, 'zumi-vault.exe'), ['unprotect'], { input: fs.readFileSync(stored) });
    const secretBack = read.status === 0 && read.stdout.toString('utf8') === secret;
    const markers = fs.readFileSync(markerRoaming, 'utf8') === secret && fs.readFileSync(markerLocal, 'utf8') === secret;
    return { pass: blob.status === 0 && updated && secretBack && markers, updated, secretBack, markers };
  });

  await runCase('10', 'stubborn-child', async () => {
    // No update on offer until the hold is seen running: on a loopback feed the whole update takes under a second.
    useManifest('m-lower');
    launch({ ZUMI_UPDATE_E2E: 'restart', ZUMI_UPDATE_E2E_HOLD: '1' });
    const held = await waitFor('the hold process', () => /hold pid \d+/.test(updaterLog()), 2 * MIN);
    const holdPid = held ? Number(/hold pid (\d+)/.exec(updaterLog())[1]) : null;
    const stillBefore = held && processes().some((p) => p.pid === holdPid);
    useManifest('m-good');
    const updated = await waitFor(`exe version ${NEW}`, () => exeVersion() === NEW, 10 * MIN, 2000);
    const relaunched = updated && await waitFor('relaunch', running, 2 * MIN);
    const stopped = /sidecar stopped, 0 job process\(es\) left/.test(updaterLog());
    const holdGone = !processes().some((p) => p.pid === holdPid);
    return { pass: held && stillBefore && updated && relaunched && stopped && holdGone, held, holdRunningBeforeUpdate: stillBefore, updated, relaunched, jobEmptyBeforeInstaller: stopped, holdGone, note: 'the public bundle has no voice-modules .node file; the locked file here is zumi-vault.exe' };
  });

  await runCase('11', 'stale-files', async () => {
    useManifest('m-good');
    const ran = path.join(WORK, 'stale-ran.txt');
    fs.rmSync(ran, { force: true });
    const code = `require('node:fs').writeFileSync(${JSON.stringify(ran)}, 'ran');\n`;
    const stale = [path.join(INSTALL_DIR, 'tauri', 'sidecar', 'stale-from-old.cjs'), path.join(INSTALL_DIR, 'src', 'main', 'stale-from-old.cjs')];
    for (const f of stale) fs.writeFileSync(f, code);
    launch({ ZUMI_UPDATE_E2E: 'restart' });
    const updated = await waitFor(`exe version ${NEW}`, () => exeVersion() === NEW, 10 * MIN, 2000);
    const up = updated && await waitFor('relaunch and sidecar', () => running() && sidecarPids().length > 0, 2 * MIN);
    await sleep(20000);
    return { pass: updated && up && stale.every((f) => fs.existsSync(f)) && !fs.existsSync(ran), updated, up, staleStayed: stale.every((f) => fs.existsSync(f)), staleRan: fs.existsSync(ran) };
  });

  await runCase('12a', 'installer-exits-1', async () => {
    useManifest('m-standin');
    launch({ ZUMI_UPDATE_E2E: 'restart' });
    const closed = await waitFor('the app closed for the installer', () => /sidecar stopped/.test(updaterLog()) && !running(), 5 * MIN);
    await sleep(10000);
    const noRelaunch = !running();
    const version = exeVersion();
    launch();
    const reopens = await waitFor('reopened by hand', running, MIN);
    return { pass: closed && noRelaunch && version === OLD && reopens, closed, noRelaunch, version, reopens };
  });

  await runCase('12b', 'locked-file', async () => {
    useManifest('m-good');
    const locked = path.join(INSTALL_DIR, 'THIRD_PARTY_LICENSES.md').replace(/\//g, '\\');
    // The file is the same in both versions, so a marker tells whether the installer replaced it.
    const MARK = '\nE2E-OLD-CONTENT\n';
    fs.appendFileSync(locked, MARK);
    // libuv's UV_FS_O_EXLOCK: opened with no sharing on Windows, held by this harness until the case ends.
    const heldFd = fs.openSync(locked, fs.constants.O_RDONLY | 0x10000000);
    let lockError = null;
    try { fs.closeSync(fs.openSync(locked, 'r')); } catch (e) { lockError = e.code; }
    const lockHeld = lockError !== null;
    if (!lockHeld) return { pass: false, error: 'the lock never took, so nothing was tested' };
    launch({ ZUMI_UPDATE_E2E: 'restart' });
    await waitFor('the app closed for the installer', () => /sidecar stopped/.test(updaterLog()) && !running(), 5 * MIN);
    const seen = [];
    await waitFor('the installer ending, or 90 s', () => {
      const list = ps("Get-Process | Where-Object { $_.ProcessName -like '*setup*' -or $_.ProcessName -like '*-installer*' } | ForEach-Object { \"$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)\" }");
      if (list && !seen.includes(list)) seen.push(list);
      return !list && seen.length > 0;
    }, 90_000, 2000);
    const stuck = ps("Get-Process | Where-Object { $_.ProcessName -like '*setup*' -or $_.ProcessName -like '*-installer*' } | ForEach-Object { $_.Id }");
    const observed = { lockHeld, lockError, installerStillRunningAfter90s: Boolean(stuck), installerWindows: seen, versionAfter: exeVersion(), running: running() };
    if (stuck) for (const id of stuck.split(/\r?\n/)) spawnSync('taskkill.exe', ['/F', '/T', '/PID', id]);
    fs.closeSync(heldFd);
    // The next launch must say so: this is the state the notice exists for.
    const mark = updaterLog().length;
    launch();
    observed.noticeLogged = await waitFor('the install check', () => /install check: [1-9]\d* file\(s\) differ/.test(updaterLog().slice(mark)), MIN);
    observed.lockedFileKeptOldContent = fs.readFileSync(locked, 'utf8').includes('E2E-OLD-CONTENT');
    return { pass: lockHeld && observed.noticeLogged, recordOnly: true, observed };
  });
} catch (e) {
  results.push({ case: 'harness', pass: false, error: String((e && e.stack) || e) });
} finally {
  // A failed cleanup is a harness finding, and must not lose the verdicts of the cases that ran.
  try {
    uninstall();
    fs.rmSync(APPDATA_DIR, RM);
    fs.rmSync(LOCAL_DIR, RM);
  } catch (e) {
    results.push({ case: 'cleanup', pass: false, error: String(e) });
  }
}

// Rejection counts only next to a real install from the same builds.
const case1 = results.find((r) => r.case === '1');
for (const r of results) {
  if (['3', '4', '5a', '5b', '5c'].includes(r.case) && !(case1 && case1.pass)) { r.pass = false; r.notCounted = 'case 1 did not pass in this run'; }
}
const summary = path.join(WORK, 'evidence', ONLY ? `summary-${ONLY.join('_')}.json` : 'summary.json');
fs.writeFileSync(summary, JSON.stringify({ tool: 'box-e2e-tauri-update.mjs', machine: os.hostname(), totalMemGb: Math.round(os.totalmem() / 2 ** 30), gitHead: prepared.gitHead, results }, null, 2));
const failed = results.filter((r) => !r.pass);
say(`${failed.length ? 'FAIL' : 'PASS'} box-e2e-tauri-update: ${results.length - failed.length}/${results.length} (evidence ${path.join(WORK, 'evidence')})`);
process.exitCode = failed.length ? 1 : 0;
