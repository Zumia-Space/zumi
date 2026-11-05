// Regression test for the SECOND T-31 voice P1 packaged-app bug (the one hiding behind "Invalid URL" -- see
// check-kokoro-download-redirect.mjs for the first): once that redirect crash is fixed, ensureReady() still
// failed in a packaged-style run with "Load model from <path> failed. File doesn't exist", looking under
// `<...>/voice-modules/node_modules/@huggingface/transformers/.cache/...` instead of the app's real userData
// cache dir.
//
// Root cause: kokoro-js's own `env` export (what kokoro-worker.mjs used to mutate `.cacheDir`/`.allowRemoteModels`
// on) is NOT the real `@huggingface/transformers` env singleton -- kokoro-js's dist bundle re-exports a throwaway
// wrapper object that only proxies `wasmPaths` (irrelevant here: device:'cpu' uses the native onnxruntime-node
// binding, never onnxruntime-web/wasm). So `env.cacheDir = cacheDir` was always a silent no-op: from_pretrained()
// kept reading the REAL library's own env, whose default cacheDir is relative to wherever the transformers
// package itself is installed. That default happened to be writable (and already populated from a past real
// run) in this repo's own dev node_modules, which is why dev/headless runs never caught it -- but in a packaged
// install it's a path the app never downloads anything into, so from_pretrained() could never find the files
// ensureFiles() had just fetched.
//
// This test builds a real `resources/voice-modules/` tree the same way electron-builder's `build.extraResources`
// does (reading the filters straight from package.json so this can't silently drift from the real packaging
// config), points `process.resourcesPath` at it exactly like a packaged app would, pre-seeds the app's own
// userData cache with the already sha256-verified files of the Kokoro seed folder (so a
// correctly-wired cacheDir needs zero network), and asserts ensureReady() resolves using ONLY that pre-seeded
// cache -- never touching (or needing to create) the wrong default directory under the transformers package.
//
// Before the fix: FAILS -- either rejects with "File doesn't exist" (offline), or times out trying to hit
// huggingface.co for files that are already sitting right there in the pre-seeded cache (online).
// After the fix: PASSES in a few seconds, no network.
//
// T-31 parity 7-3: `--resources-dir <built bundle>` runs the SAME assertions against an already-built bundle
// (tauri/src-tauri/target/unpacked or an install) instead of a fixture made from package.json, so the packaged
// probe proves kokoro-js, @huggingface/transformers and the onnxruntime binary resolve FROM THE BUNDLE. The
// pre-seeded userData cache still comes from `--seed` (default: owner-paths kokoroSeed).
//   node scripts/check-kokoro-packaged-env.mjs
//   node scripts/check-kokoro-packaged-env.mjs --resources-dir tauri/src-tauri/target/unpacked
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ownerPath } from './lib/owner-paths.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');

const argValue = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const bundleArg = argValue('--resources-dir');
const seedDir = argValue('--seed') || ownerPath('kokoroSeed', 'local/kokoro');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---------- minimal gitignore-style glob matcher, just enough for electron-builder's `filter` arrays ----------
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { re += '(?:.*/)?'; i++; }
      else re += '.*';
    } else if (c === '*') {
      re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
function isIncluded(relPosixPath, filters) {
  let included = false;
  for (const pattern of filters) {
    const neg = pattern.startsWith('!');
    const re = globToRegExp(neg ? pattern.slice(1) : pattern);
    if (re.test(relPosixPath)) included = !neg;
  }
  return included;
}
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
function copyFiltered(from, to, filters) {
  for (const rel of walk(from)) {
    if (!isIncluded(rel, filters)) continue;
    const src = path.join(from, rel);
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function main() {
  // NOT os.tmpdir() and NOT anywhere under this repo: Node's ESM resolution walks UP from any importing file
  // looking for node_modules at every ancestor directory, all the way to the drive root. os.tmpdir() resolves
  // under C:\Users\<user>\ on this machine (and possibly others), which happens to have its own stray
  // C:\Users\<user>\node_modules\sharp (some other tool's install); a repo-local dir is just as bad, since
  // `sharp` is ALSO sitting in this project's own (dev-only) node_modules/sharp -- @huggingface/transformers
  // declares it as a real dependency, so `npm install` put it there even though it's deliberately excluded from
  // the packaged build (see package.json's extraResources filter). Either ancestor silently masks exactly the
  // packaging gap this test exists to catch (FIX.md bug 3: transformers.node.mjs's unconditional static
  // `import sharp from 'sharp'`). A drive-root-adjacent, gitignored dir has no node_modules anywhere above it,
  // same as a real install's `D:\Program Files\Zumi\` or any other drive-root install dir -- the only placement that
  // actually reproduces what a clean machine sees.
  const tmpRoot = 'D:/.kokoro-check-tmp';
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  const userDataDir = path.join(tmp, 'userdata');
  console.log(`check-kokoro-packaged-env: ${bundleArg ? `bundle ${path.resolve(bundleArg)}` : 'fixture from package.json'}`);

  let resourcesDir;
  if (bundleArg) {
    // ---- bundle mode (parity 7-3): use the built tree as the packaged app's resource root, unchanged ----
    resourcesDir = path.resolve(bundleArg);
    ok(fs.existsSync(resourcesDir) && fs.statSync(resourcesDir).isDirectory(), 'the --resources-dir bundle exists', resourcesDir);
  } else {
    // 1. Build resources/voice-modules/ exactly as electron-builder's build.extraResources would, straight from
    // this repo's own package.json -- so this fixture can never silently drift from the real packaging config.
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const voiceEntries = pkg.build.extraResources.filter((e) => e.to.startsWith('voice-modules/'));
    ok(voiceEntries.length === 6, 'package.json still has the 6 expected voice-modules extraResources entries', String(voiceEntries.length));
    resourcesDir = path.join(tmp, 'resources');
    for (const entry of voiceEntries) {
      copyFiltered(path.join(repoRoot, entry.from), path.join(resourcesDir, entry.to), entry.filter || ['**/*']);
    }
  }

  const layout = bundleArg ? 'bundle' : 'fixture';
  const kokoroMain = path.join(resourcesDir, 'voice-modules/node_modules/kokoro-js/dist/kokoro.js');
  const transformersMain = path.join(resourcesDir, 'voice-modules/node_modules/@huggingface/transformers/dist/transformers.node.mjs');
  const sharpStub = path.join(resourcesDir, 'voice-modules/node_modules/@huggingface/transformers/node_modules/sharp/index.js');
  ok(fs.existsSync(kokoroMain), `the ${layout} has kokoro-js/dist/kokoro.js (same layout a packaged app gets)`, kokoroMain);
  ok(fs.existsSync(transformersMain), `the ${layout} has @huggingface/transformers/dist/transformers.node.mjs`, transformersMain);
  // Bug 3 of 3 (found on the spare-PC install, invisible on this dev machine -- see FIX.md): transformers.node.mjs
  // has an unconditional static `import sharp from 'sharp'`; without this stub, ensureReady() below fails with
  // ERR_MODULE_NOT_FOUND on any machine that has no stray ancestor node_modules/sharp to accidentally mask it.
  ok(fs.existsSync(sharpStub), `the ${layout} has the sharp stub (satisfies transformers.node.mjs' static import)`, sharpStub);
  if (bundleArg) {
    // The worker loads the native binding from kokoro-js's own nested onnxruntime-node; prove it is in the bundle
    // rather than resolved from this dev tree.
    const onnxBinding = path.join(resourcesDir,
      'voice-modules/node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node');
    ok(fs.existsSync(onnxBinding), 'the bundle ships the onnxruntime win32/x64 binding the worker loads', onnxBinding);
  }

  // 2. Pre-seed the app's own userData cache with the already sha256-verified files (same source as
  // check-kokoro-tts.mjs) so a CORRECTLY wired env.cacheDir needs zero network.
  const seedSrc = seedDir;
  ok(fs.existsSync(path.join(seedSrc, 'kokoro-v1.0-fp16.onnx')), 'the --seed Kokoro cache source exists', seedSrc);
  const seedDest = path.join(userDataDir, 'tts', 'kokoro', 'onnx-community', 'Kokoro-82M-v1.0-ONNX');
  fs.mkdirSync(path.join(seedDest, 'onnx'), { recursive: true });
  fs.copyFileSync(path.join(seedSrc, 'kokoro-v1.0-fp16.onnx'), path.join(seedDest, 'onnx', 'model_fp16.onnx'));
  for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) fs.copyFileSync(path.join(seedSrc, f), path.join(seedDest, f));

  // 3. Point process.resourcesPath at the fixture (or the built bundle) -- the exact signal kokoro-tts.js's
  // voiceModulesDir() uses to tell a packaged run from a dev run.
  Object.defineProperty(process, 'resourcesPath', { value: resourcesDir, configurable: true });
  const { createKokoroTts } = require('../src/main/kokoro-tts.js');

  const seenPhases = new Set();
  const tts = createKokoroTts({ userDataDir, log: (m) => console.log(`  [kokoro-tts] ${m}`) });
  ok(tts.available(), 'available() is true under the packaged-style resourcesPath');

  const wrongCacheDir = path.join(resourcesDir, 'voice-modules/node_modules/@huggingface/transformers/.cache');

  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} took >${ms}ms -- looks like it tried the network instead of the pre-seeded cache (bug regressed)`)), ms)),
  ]);

  try {
    await withTimeout(tts.ensureReady((p) => seenPhases.add(p.phase)), 20000, 'ensureReady()');
    ok(true, 'ensureReady() resolves using only the pre-seeded userData cache (no network)');
  } catch (e) {
    ok(false, 'ensureReady() resolves using only the pre-seeded userData cache (no network)', `${(e && e.message) || e}`);
  }

  ok(!fs.existsSync(wrongCacheDir), 'from_pretrained() never created the wrong default cache dir under the transformers package', wrongCacheDir);

  for (const relPath of ['onnx/model_fp16.onnx', 'config.json', 'tokenizer.json', 'tokenizer_config.json']) {
    ok(!seenPhases.has(relPath), `ensureFiles() did not re-download the pre-seeded ${relPath}`);
  }

  tts.dispose();
  // Best-effort: onnxruntime-node's native binding (onnxruntime_binding.node, loaded from inside this fixture's
  // own tree) can still hold the DLL mapped for a moment after worker.terminate() on Windows, which makes an
  // immediate rmSync of the fixture's own node_modules EPERM. That's a Windows cleanup quirk, not a test result
  // -- never let it mask the PASS/FAIL already decided above.
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log(`  (cleanup skipped, non-fatal: ${(e && e.message) || e})`); }

  console.log(`check:kokoro-packaged-env ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} assertions passed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
