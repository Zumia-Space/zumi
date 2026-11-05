// T-31 Tauri parity (miss found 25-10 on the main PC): the OWNER Tauri bundle (-Flavour owner|selftest) must ship the default Zumi
// model, auto-load it on first start, and carry its credits, exactly like Electron 0.2.9 (scripts/check-default-model.mjs is the
// Electron twin). Open-core ADR 2026-10-28: the public flavour ships no model (scripts/check-public-payload.mjs).
//   - the .vrm is a restrictive asset and NEVER in git: it is injected at stage time from ZUMI_DEFAULT_VRM_PATH, size+sha256 pinned
//     (resources-pinned/default-model/PIN-MANIFEST.json). A bundle without it, or with a different file, or without the licence/credits
//     notice, is a FAILURE (verifyStagedDefaultModel).
//   - first start: a profile with no `model` key adopts the verified default (default-model-boot.mjs); main.mjs awaits it before
//     answering any request.
//   node scripts/check-tauri-default-model.mjs   (exit 1 on any failure; no build, no window, no network)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
let fail = 0;
const ok = (cond, name, detail = '') => { if (!cond) fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? '  ' + detail : ''}`); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tmp = fs.mkdtempSync(path.join(process.env.CHECK_TMP_BASE || os.tmpdir(), 'zumi-dm-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp only */ } });

const dm = require('../src/main/default-model.js');
const vrmLib = require('./lib/default-vrm.cjs');
const pin = JSON.parse(read('resources-pinned/default-model/PIN-MANIFEST.json'));

// ---- 1. the pin, licence and git guard are the Electron ones (one source of truth, no second model) ----
ok(pin.file === dm.DEFAULT_MODEL_FILE && pin.sha256 === dm.DEFAULT_MODEL_SHA256 && pin.bytes === dm.DEFAULT_MODEL_BYTES, 'PIN-MANIFEST agrees with src/main/default-model.js (file, bytes, sha256)');
ok(pin.file === 'zumi-default-0910.vrm', 'the model is the file Electron 0.2.9 ships (zumi-default-0910.vrm), not another');
const notice = read(`resources-pinned/default-model/${pin.licenceNoticeFile}`);
ok(/3K FOREST/.test(notice) && /pixiv/i.test(notice) && /not open source/i.test(notice), 'licence/credits notice credits 3K FOREST + pixiv and says not open source');
ok(/^\*\.vrm$/m.test(read('.gitignore')), '.gitignore keeps every *.vrm out of git');
const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', '--', '*.vrm'], { encoding: 'utf8' }).stdout.trim();
ok(tracked === '', 'no .vrm is tracked in git', tracked);

// ---- 2. verifyStagedDefaultModel: the bundle gate (pure; fake pin + fake bytes) ----
const bytes = Buffer.from('fake-vrm-bytes-for-the-bundle-gate');
const fakePin = { ...pin, bytes: bytes.length, sha256: sha(bytes) };
const credits = 'Zumi default avatar. (c) 3K FOREST CO.,LTD. Contains VRoid AvatarSample_K content (c) pixiv Inc. Not open source.';
function stage(name, { model = bytes, licence = credits } = {}) {
  const root = path.join(tmp, name);
  const dir = path.join(root, 'assets', 'models');
  fs.mkdirSync(dir, { recursive: true });
  if (model) fs.writeFileSync(path.join(dir, pin.file), model);
  if (licence !== null) fs.writeFileSync(path.join(dir, pin.licenceNoticeFile), licence);
  return root;
}
ok(typeof vrmLib.verifyStagedDefaultModel === 'function', 'default-vrm.cjs exports verifyStagedDefaultModel');
if (typeof vrmLib.verifyStagedDefaultModel === 'function') {
  const v = (root) => vrmLib.verifyStagedDefaultModel(root, fakePin);
  ok(v(stage('good')).length === 0, 'bundle with the pinned model + credits passes', JSON.stringify(v(stage('good2'))));
  ok(v(stage('nomodel', { model: null })).some((p) => /missing/i.test(p)), 'bundle with NO default model FAILS');
  ok(v(stage('wrongbytes', { model: Buffer.from('other') })).some((p) => /size|sha/i.test(p)), 'bundle with a different model file FAILS');
  ok(v(stage('samesize', { model: Buffer.alloc(bytes.length, 7) })).some((p) => /sha/i.test(p)), 'same-size different bytes FAILS (sha256)');
  ok(v(stage('nolicence', { licence: null })).some((p) => /credit|licen/i.test(p)), 'bundle with the credits notice MISSING fails');
  ok(v(stage('emptycredits', { licence: 'Zumi model.' })).some((p) => /3K FOREST|pixiv/i.test(p)), 'credits notice that names neither 3K FOREST nor pixiv fails');
  ok(v(path.join(tmp, 'does-not-exist')).length > 0, 'a bundle dir with no assets/models at all fails');
}

// ---- 3. stage injection: missing / wrong source refuses (no half-built bundle), env var names the source ----
ok(typeof vrmLib.stageIntoTauriBundle === 'function', 'default-vrm.cjs exports stageIntoTauriBundle');
if (typeof vrmLib.stageIntoTauriBundle === 'function') {
  const missing = path.join(tmp, 'no-such.vrm');
  let err = null;
  try { vrmLib.stageIntoTauriBundle(path.join(tmp, 'stage-a'), { [pin.sourceEnvVar]: missing }); } catch (e) { err = e; }
  ok(err && /missing/i.test(err.message), 'stage refuses a missing source (message names the file)', err && err.message);
  const wrong = path.join(tmp, 'wrong.vrm');
  fs.writeFileSync(wrong, Buffer.alloc(pin.bytes, 1));
  err = null;
  try { vrmLib.stageIntoTauriBundle(path.join(tmp, 'stage-b'), { [pin.sourceEnvVar]: wrong }); } catch (e) { err = e; }
  ok(err && /sha256 mismatch/i.test(err.message), 'stage refuses a same-size file with the wrong sha256', err && err.message);
  ok(!fs.existsSync(path.join(tmp, 'stage-b', 'assets', 'models', pin.file)), 'a refused source leaves no model in the stage dir');
}
const stageSrc = read('tauri/stage-bundle.mjs');
ok(/if \(flavour !== 'public'\) \{\s*try \{ stageIntoTauriBundle\(stage\); \}/.test(stageSrc) && /verifyStagedDefaultModel\(/.test(stageSrc), 'tauri/stage-bundle.mjs stages AND verifies the default model for every non-public flavour (no opt-out switch; public never, open-core ADR 2026-10-28)');
ok(!/skip-default-model|no-default-model/i.test(stageSrc + read('tauri/build.ps1')), 'no flag skips the default model in the stage/build scripts');
const cb = read('tauri/verify/check-bundle.mjs');
ok(/verifyStagedDefaultModel/.test(cb), 'check-bundle.mjs (run on every staged/built dir) asserts the default model + credits');

// ---- 4. first start: a profile with no `model` key adopts the verified default ----
let boot = null;
try { boot = await import('../tauri/sidecar/default-model-boot.mjs'); } catch (e) { ok(false, 'tauri/sidecar/default-model-boot.mjs loads', e.message); }
if (boot) {
  const dir = path.join(tmp, 'models-dir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, pin.file), bytes);
  const mk = (saved, extra = {}) => {
    const state = { ...saved };
    const calls = [];
    return {
      state, calls,
      args: {
        settings: () => state,
        saveSettings: (patch) => { calls.push(patch); Object.assign(state, patch); },
        listModels: () => ({ models: [], selected: state.model === 'user' ? 'user' : null }),
        env: {}, modelsDir: dir, expectedSha256: sha(bytes), log: () => {}, ...extra,
      },
    };
  };
  let t = mk({});
  let r = await boot.adoptDefaultOnBoot(t.args);
  ok(r === 'adopted' && t.state.model === 'user' && t.state.userModelPath === path.join(dir, pin.file), 'fresh profile (no model key) adopts the bundled default as the user model', JSON.stringify([r, t.state]));
  t = mk({ model: 'user', userModelPath: 'D:/mine.vrm' });
  r = await boot.adoptDefaultOnBoot(t.args);
  ok(r === 'kept' && t.calls.length === 0, 'a saved model choice is never touched');
  t = mk({ model: null });
  r = await boot.adoptDefaultOnBoot(t.args);
  ok(r === 'kept' && t.calls.length === 0, 'even model:null is an explicit state and is kept');
  t = mk({}, { testModelPath: 'D:/test.vrm' });
  r = await boot.adoptDefaultOnBoot(t.args);
  ok(r === 'kept' && t.calls.length === 0, 'a --model test run does not adopt');
  t = mk({}, { expectedSha256: sha(Buffer.from('other')) });
  r = await boot.adoptDefaultOnBoot(t.args);
  ok(r && r.error === 'sha_mismatch' && t.calls.length === 0, 'a changed default file is refused, settings untouched', JSON.stringify(r));
  t = mk({}, { modelsDir: path.join(tmp, 'empty') });
  r = await boot.adoptDefaultOnBoot(t.args);
  ok(r && r.error === 'missing' && t.calls.length === 0, 'no default file (dev tree) changes nothing', JSON.stringify(r));
}
const mainSrc = read('tauri/sidecar/main.mjs');
ok(/adoptDefaultOnBoot\(/.test(mainSrc) && /await\s+defaultModelReady/.test(mainSrc), 'main.mjs starts the first-run adoption and awaits it before dispatching any request');


// ---- 8. preview.3 nit: the bundled default is labelled "Zumi default" in the model dropdown, not "Model from this PC" ----
{
  const { createModels } = require('../src/main/models-core.js');
  const { TABLES } = await import('../src/renderer/i18n.js');
  const { modelLabel } = await import('../src/renderer/default-model.js');
  const mdir = path.join(tmp, 'label-models'); fs.mkdirSync(mdir, { recursive: true });
  const sampleF = path.join(tmp, 'zumi-default-0910.vrm'), otherF = path.join(tmp, 'mine.vrm');
  fs.writeFileSync(sampleF, 'sample'); fs.writeFileSync(otherF, 'other');
  const list = (userModelPath) => createModels({ modelsDir: mdir, loadSettings: () => ({ model: 'user', userModelPath }), isDefaultSample: (f) => f === sampleF }).listModels().models[0];
  const d = list(sampleF), u = list(otherF);
  ok(d.labelKey === 'model.zumiDefault', 'models-core: the user slot holding the bundled sample carries labelKey model.zumiDefault', JSON.stringify(d));
  ok(u.labelKey === undefined && u.label === 'Model from this PC', 'models-core: a real user model keeps "Model from this PC", no labelKey', JSON.stringify(u));
  const WANT = { en: 'Zumi default', vi: 'Zumi mặc định' };
  for (const l of ['en', 'vi', 'zh']) ok(typeof TABLES[l]['model.zumiDefault'] === 'string' && TABLES[l]['model.zumiDefault'].trim() !== '' && (!WANT[l] || TABLES[l]['model.zumiDefault'] === WANT[l]), `i18n ${l}: model.zumiDefault`, String(TABLES[l]['model.zumiDefault']));
  const tr = (k) => TABLES.vi[k];
  ok(typeof modelLabel === 'function' && modelLabel(d, tr) === 'Zumi mặc định' && modelLabel(u, tr) === 'Model from this PC', 'renderer modelLabel(): translated for the default, host label otherwise');
  ok(/modelLabel\(m, t\)/.test(read('src/renderer/app.js')), 'app.js paints the dropdown option through modelLabel()');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
