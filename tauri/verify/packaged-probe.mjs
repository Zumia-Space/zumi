// T-31 parity 7-3: PATH-scrubbed probe of a BUILT (unpacked) preview.
//
// Run it through tauri/verify/run-packaged-probe.ps1: that script removes every Node directory from PATH before
// this file starts, so no system Node can be picked up by anything below. Nothing here opens an app window.
//
// Node is NOT bundled (node-bundle option (c): the host finds a system Node or downloads one with consent). So this probe:
//   - asserts the bundle carries NO node.exe;
//   - drives the sidecar with the test runtime passed as --node (run-packaged-probe.ps1 -Node / ZUMI_PROBE_NODE);
//   - proves the host does not silently fall back: with PATH scrubbed and no provisioned runtime its headless probe
//     reports `node_runtime_missing` (and if a provisioned runtime exists it must spawn and answer info).
//
// Proves (against the test runtime given as --node):
//   - the BUILT HOST (<bundle>/ZumiPreview.exe --probe-sidecar-spawn) spawns its sidecar through the real
//     `resource_dir()` path, which on Windows is verbatim (`\\?\`); a normalisation regression fails here with EISDIR;
//   - the test runtime is the one running the sidecar (`info` reports process.execPath);
//   - the sidecar boots to `ready` with PATH scrubbed and answers `info` (also driven directly over stdio, the way
//     scripts/check-tauri-*.mjs do);
//   - check-kokoro-packaged-env passes with --resources-dir <bundle>, i.e. kokoro-js,
//     @huggingface/transformers and the onnxruntime binding resolve FROM THE BUNDLE, not the dev tree.
//
//   node tauri/verify/packaged-probe.mjs --bundle tauri/src-tauri/target/unpacked --node <node.exe>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { ownerPath } from '../../scripts/lib/owner-paths.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..');
// Step 7-4: the packaged sidecar has no package.json, so it reports the version the host passes (--app-version). Both the
// handshake and info.version must equal the repo's package.json, the single source of truth.
const appVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const bundle = path.resolve(args.bundle || path.join(repo, 'tauri', 'src-tauri', 'target', 'unpacked'));
const seed = args.seed || ownerPath('kokoroSeed', 'local/kokoro');
const testNode = args.node && args.node !== true ? path.resolve(args.node) : '';
const dataDir = path.resolve(args['data-dir'] || path.join(repo, '.tauri-check-tmp', 'packaged-probe'));

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const under = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};


function startSidecar(nodeExe, script, bundleDir, dir) {
  // `--app-version` is exactly what the Rust host passes (package_info), so this probe drives the packaged path.
  const child = spawn(nodeExe, [script, '--data-dir', dir, '--resources-dir', bundleDir, '--app-version', appVersion, '--no-voice-prefetch'], {
    cwd: bundleDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const notifications = [];
  let stderr = '';
  let nextId = 1;
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const slot = pending.get(msg.id);
      clearTimeout(slot.timer);
      pending.delete(msg.id);
      slot.resolve(msg);
    } else if (msg.method) {
      notifications.push(msg);
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return {
    child,
    notifications,
    stderrText: () => stderr,
    request(method, params = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 30000);
        pending.set(id, { resolve, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    waitFor(pred, ms, label) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + ms;
        const tick = () => {
          const hit = notifications.find(pred);
          if (hit) return resolve(hit);
          if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
          setTimeout(tick, 50);
        };
        tick();
      });
    },
  };
}

async function main() {
  console.log(`packaged-probe: ${bundle}`);
  const bundledNode = path.join(bundle, 'node', 'node.exe');
  const nodeExe = testNode;
  const script = path.join(bundle, 'tauri', 'sidecar', 'main.mjs');
  const hostExe = path.join(bundle, fs.existsSync(path.join(bundle, 'Zumi.exe')) ? 'Zumi.exe' : 'ZumiPreview.exe');

  // ---- 1. the unpacked bundle is complete and carries no Node ----
  ok(fs.existsSync(bundle) && fs.statSync(bundle).isDirectory(), 'the unpacked bundle directory exists', bundle);
  ok(!fs.existsSync(bundledNode), 'the bundle carries NO node/node.exe (it is provisioned at runtime)', bundledNode);
  ok(Boolean(nodeExe) && fs.existsSync(nodeExe), 'a test Node runtime was given with --node', nodeExe);
  ok(fs.existsSync(script), 'the bundle carries the sidecar entry point', script);
  ok(fs.existsSync(hostExe), 'the bundle carries the built host exe', hostExe);
  if (!nodeExe || !fs.existsSync(nodeExe) || !fs.existsSync(hostExe)) {
    console.log('packaged-probe FAIL: run tauri\\build.ps1 -Flavour owner -- pass --node <node.exe> (the bundle carries none)');
    process.exit(1);
  }

  // ---- 2. PATH carries no Node: the run cannot silently fall back to a system runtime ----
  const nodeDirs = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .filter((dir) => {
      try { return fs.existsSync(path.join(dir, 'node.exe')); } catch { return false; }
    });
  ok(nodeDirs.length === 0, 'PATH has no directory that holds node.exe', nodeDirs.join('; '));
  const where = spawnSync('where.exe', ['node'], { encoding: 'utf8', env: process.env });
  ok(where.status !== 0, 'where.exe node resolves nothing on the scrubbed PATH', ((where.stdout || '') + (where.stderr || '')).trim());
  ok(samePath(process.execPath, nodeExe), 'this probe process runs on the test Node', process.execPath);

  // ---- 3. the BUILT HOST spawns its sidecar through the real resource path ----
  // The 7-3 probe spawned the sidecar itself, so it never saw `resource_dir()`'s verbatim (`\\?\`) form and missed the
  // packaged EISDIR. Run the shipped exe in its headless probe mode instead: it builds the real Tauri app (no window),
  // calls the same spawn_sidecar(), and prints the paths it used. If the host stops normalising them, Node dies and
  // this assertion fails.
  const hostData = path.join(dataDir, 'host-data');
  fs.mkdirSync(hostData, { recursive: true });
  // No Kokoro prefetch in a probe: the real host does not pass --no-voice-prefetch, so turn voice off in the data dir
  // the probe host is told to use (never the app's real one, which lives on C:).
  fs.writeFileSync(path.join(hostData, 'settings.json'), JSON.stringify({ voiceEnabled: false }));
  const hostRun = spawnSync(hostExe, ['--probe-sidecar-spawn', '--probe-data-dir', hostData], {
    cwd: bundle,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 60000,
  });
  const hostStderr = (hostRun.stderr || '');
  const hostLine = (hostRun.stdout || '').split(/\r?\n/).filter((l) => l.startsWith('PROBE ')).pop();
  let hostProbe = null;
  try { hostProbe = hostLine ? JSON.parse(hostLine.slice('PROBE '.length)) : null; } catch { hostProbe = null; }
  ok(Boolean(hostProbe), 'the built host prints its headless spawn result', (hostLine || hostRun.stdout || '').slice(0, 200));
  // Scrubbed PATH + no provisioned runtime: the honest outcome is a refusal naming the missing runtime, never a fallback.
  // (A box that already provisioned the pinned runtime may legitimately spawn: then it must answer info.)
  const hostOk = hostRun.status === 0 && hostProbe && hostProbe.ok === true;
  const hostRefused = hostProbe && hostProbe.ok === false && /node_runtime_missing/.test(JSON.stringify(hostProbe));
  ok(hostOk || hostRefused, 'the built host either spawns on a provisioned runtime or refuses with node_runtime_missing (no silent fallback)', `rc=${hostRun.status} ${JSON.stringify(hostProbe && { error: hostProbe.error })}`);
  ok(!/EISDIR|illegal operation on a directory/i.test(hostStderr), 'the host spawn produces no EISDIR (verbatim paths normalised before Node)', hostStderr.split(/\r?\n/).slice(0, 6).join(' | '));
  if (hostProbe && hostProbe.ok) {
    ok(String(hostProbe.resourceDir || '').startsWith('\\\\?\\'), 'the host exercised a verbatim resource_dir (the case this probe guards)', String(hostProbe.resourceDir));
    ok(hostProbe.info && hostProbe.info.version === appVersion, `the host-spawned sidecar reports ${appVersion}`, JSON.stringify(hostProbe.info && hostProbe.info.version));
    ok(typeof hostProbe.dataDir === 'string' && samePath(hostProbe.dataDir, hostData), 'the host passes the probe data dir to the sidecar (never the real one)', hostProbe.dataDir);
  }

  // ---- 4. the sidecar boots with the test runtime and reports it (direct stdio, unchanged 7-3 coverage) ----
  fs.mkdirSync(dataDir, { recursive: true });
  const sc = startSidecar(nodeExe, script, bundle, dataDir);
  let exitCode = null;
  sc.child.on('exit', (code) => { exitCode = code; });
  try {
    const ready = await sc.waitFor((n) => n.method === 'ready', 30000, 'the ready handshake');
    ok(ready.params && ready.params.protocol === 1, 'the sidecar completes the protocol-1 ready handshake', JSON.stringify(ready.params));
    ok(ready.params && ready.params.version === appVersion, `the handshake reports ${appVersion} in the packaged bundle`, JSON.stringify(ready.params && ready.params.version));
    const info = (await sc.request('info')).result;
    ok(info && info.version === appVersion, `info.version is ${appVersion} in the packaged bundle`, JSON.stringify(info && info.version));
    ok(Boolean(info && typeof info.nodeExecPath === 'string' && info.nodeExecPath), 'info reports nodeExecPath (process.execPath)', JSON.stringify(info && info.nodeExecPath));
    if (info && info.nodeExecPath) {
      ok(samePath(info.nodeExecPath, nodeExe), 'the sidecar runs on the given test node.exe, not a PATH Node', info.nodeExecPath);
      ok(info.packaged === true, 'info still marks the preview as packaged');
    }
  } catch (e) {
    ok(false, 'the sidecar answers info over stdio with PATH scrubbed', (e && e.message) || String(e));
  } finally {
    try { sc.child.stdin.end(); } catch { /* ignore */ }
    const by = Date.now() + 5000;
    while (exitCode === null && Date.now() < by) await new Promise((r) => setTimeout(r, 100));
    if (exitCode === null) { try { sc.child.kill(); } catch { /* ignore */ } }
  }
  const errText = sc.stderrText();
  const stderrNoise = /vault_exe_missing|rooms manifest refused|chairs manifest refused|flavour: public/.test(errText);
  if (fail > 0 && stderrNoise) console.log('  (sidecar stderr was: ' + errText.split('\n').slice(0, 8).join(' | ') + ')');

  // ---- 5. Kokoro's packaged environment, against the same bundle ----
  const kokoro = spawnSync(nodeExe, [
    path.join(repo, 'scripts', 'check-kokoro-packaged-env.mjs'),
    '--resources-dir', bundle,
    '--seed', seed,
  ], { cwd: repo, env: process.env, stdio: 'inherit', timeout: 300000 });
  ok(kokoro.status === 0, 'check-kokoro-packaged-env passes against the bundle on the test Node', `rc=${kokoro.status}`);

  console.log(`packaged-probe ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} assertions passed (no app window was opened)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
