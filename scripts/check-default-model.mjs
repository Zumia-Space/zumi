// "Về model mặc định" gate (T-31, owner 20-10
// được ko cho dễ qc"). Plain Node, no Electron (the repo's check:* convention), because the requirement is that the
// shipped renderer + main still behave: one click restores the locked default avatar, a missing or byte-changed file
// refuses with a message and changes nothing, and the item hides while the default is on stage.
//
//   1. the menu item + all locales (en / vi, plus zh for the identical-key gate)
//   2. the click calls the dedicated NO-ARGUMENT zumi.restoreDefaultModel() (preload -> models:restore-default)
//   3. a missing / mismatched file paints the message and makes no set-model (switch) call
//   4. the item is hidden when the default already is the active model (and one click then makes no IPC)
//   5. MAIN, executed for real: src/main/default-model.js registers the handler on a mocked ipcMain and runs against a
//      temp dir + temp settings.json (restore ok / wrong hash refuses / settings preserved / args ignored); and
//      models:open-file is byte-identical to the shipped 79c018c handler
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';
import { TABLES } from '../src/renderer/i18n.js';
import { DEFAULT_MODEL_FILE, isDefaultModelActive, defaultModelErrorKey, restoreDefaultModel } from '../src/renderer/default-model.js';

const require = createRequire(import.meta.url);
const mainDefault = require('../src/main/default-model.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const html = read('src', 'renderer', 'index.html');
const app = read('src', 'renderer', 'app.js');
const main = read('src', 'main', 'main.js');
const preload = read('src', 'main', 'preload.js');
const pkg = JSON.parse(read('package.json'));

// ---------- 1. the menu item exists, in all locales ----------
ok(html.includes('id="model-default"') && /<button id="model-default"[^>]*data-i18n="zumi\.defaultModel"/.test(html),
  'index.html: a #model-default button carries the zumi.defaultModel label');
ok(/<button id="model-default"[^>]*data-i18n-title="zumi\.defaultModelTitle"/.test(html),
  'index.html: the button has a title key (what the one click does, no dialog)');
ok(/id="model-default-note"[^>]*aria-live="polite"/.test(html),
  'index.html: a polite live region shows the refusal message');

const KEYS = ['zumi.defaultModel', 'zumi.defaultModelTitle', 'app.defaultModelMissing', 'app.defaultModelWrong', 'app.defaultModelUnreadable'];
for (const lang of ['en', 'vi']) {
  for (const k of KEYS) ok(typeof TABLES[lang][k] === 'string' && TABLES[lang][k].trim() !== '', `${lang}: ${k} resolved`, String(TABLES[lang][k]));
}
ok(TABLES.en['zumi.defaultModel'] === 'Back to default model', 'en: menu item wording', TABLES.en['zumi.defaultModel']);
ok(TABLES.vi['zumi.defaultModel'] === 'Về model mặc định', 'vi: the owner\'s own wording', TABLES.vi['zumi.defaultModel']);
// check:ui-lang requires all three tables to carry the same key set, so zh must have them too.
for (const k of KEYS) ok(typeof TABLES.zh[k] === 'string' && TABLES.zh[k].trim() !== '', `zh: ${k} resolved (identical-key gate)`);
for (const lang of ['en', 'vi', 'zh']) {
  const missing = TABLES[lang]['app.defaultModelMissing'];
  const wrong = TABLES[lang]['app.defaultModelWrong'];
  ok(missing.includes('{file}') && missing.includes(DEFAULT_MODEL_FILE) === false, `${lang}: the missing-file message names the file via {file}`);
  ok(!wrong.includes('{file}') && /sha256/i.test(wrong), `${lang}: the changed-file message names the sha256 mismatch`);
  ok(missing !== 'app.defaultModelMissing' && wrong !== 'app.defaultModelWrong', `${lang}: both messages resolve (no raw key on screen)`);
}

// ---------- 2. the click calls the dedicated no-argument channel ----------
ok(/import \{[^}]*restoreDefaultModel[^}]*\} from '\.\/default-model\.js'/.test(app), 'app.js imports the restore helper');
ok(/\$\('model-default'\)\.addEventListener\('click',/.test(app), 'app.js wires the #model-default click');
ok(/restoreDefault: \(\) => zumi\.restoreDefaultModel\(\)/.test(app), 'app.js calls zumi.restoreDefaultModel() with no argument');
ok(/restoreDefaultModel: \(\) => ipcRenderer\.invoke\('models:restore-default'\)/.test(preload), 'preload.js exposes ONE no-arg function for models:restore-default');
ok(/openModelFile: \(\) => ipcRenderer\.invoke\('models:open-file'\)/.test(preload), 'preload.js: openModelFile still passes no argument to models:open-file');
ok(DEFAULT_MODEL_FILE === 'zumi-default-0910.vrm' && mainDefault.DEFAULT_MODEL_FILE === DEFAULT_MODEL_FILE, 'the message names the file; renderer and main agree on it', DEFAULT_MODEL_FILE);
ok(/^[0-9a-f]{64}$/.test(mainDefault.DEFAULT_MODEL_SHA256), 'main pins the FULL sha256 of the default file');

// The click, driven through the real helper with the IPC stubbed.
const otherUser = { models: [{ id: 'user', source: 'user', path: 'C:\\models\\test-model-2.vrm' }], selected: 'user' };
const restoredList = { models: [{ id: 'user', source: 'user', path: '/models/' + DEFAULT_MODEL_FILE }], selected: 'user' };
{
  const calls = [];
  let switched = null;
  const r = await restoreDefaultModel({
    list: otherUser,
    restoreDefault: async (...args) => { calls.push(args); return restoredList; },
    onList: (list) => { switched = list; },
  });
  ok(calls.length === 1 && calls[0].length === 0, 'click: exactly one restore call, with NO arguments', JSON.stringify(calls));
  ok(r.ok === true && switched === restoredList, 'click: the returned list drives the normal picker + switchModel path');
}

// ---------- 3. a missing / mismatched file: message, nothing changed ----------
for (const [error, key, label] of [
  ['missing', 'app.defaultModelMissing', 'missing file'],
  ['sha_mismatch', 'app.defaultModelWrong', 'sha256 mismatch'],
  ['unreadable', 'app.defaultModelUnreadable', 'unreadable file'],
]) {
  const calls = [];
  let switched = null;
  const shown = [];
  const r = await restoreDefaultModel({
    list: otherUser,
    restoreDefault: async () => { calls.push(1); return { error }; },
    onList: (list) => { switched = list; },
    onError: (k) => shown.push(k),
  });
  ok(calls.length === 1, `${label}: main is asked to verify the locked default`);
  ok(switched === null, `${label}: no set-model / switchModel call (nothing changes)`);
  ok(shown.length === 1 && shown[0] === key, `${label}: the message key is shown`, JSON.stringify(shown));
  ok(r.ok === false && r.reason === key, `${label}: the helper reports the refusal`);
}
ok(defaultModelErrorKey(null) === null && defaultModelErrorKey({ models: [] }) === null, 'a successful list is not reported as an error');

// ---------- 4. hidden while the default already is the active model ----------
const active = { models: [{ id: 'user', source: 'user', path: 'C:\\models\\ZUMI-default-0910.vrm' }], selected: 'user' };
ok(isDefaultModelActive(active) === true, 'active: backslash/case differences still read as the default');
ok(isDefaultModelActive({ models: [{ id: 'user', source: 'user', path: '/models/' + DEFAULT_MODEL_FILE }], selected: 'user' }) === true, 'active: forward slashes read as the default');
ok(isDefaultModelActive(otherUser) === false, 'another picked model is not the default');
ok(isDefaultModelActive({ models: [{ id: 'zumi', source: 'bundled', file: DEFAULT_MODEL_FILE }], selected: 'zumi' }) === false,
  'a bundled model is never mistaken for the external default');
ok(isDefaultModelActive({ models: [{ id: 'test', source: 'test', path: '/models/' + DEFAULT_MODEL_FILE }], selected: 'test' }) === false,
  'a test --model with the same file name is still not the "user" default (model must be user)');
ok(isDefaultModelActive({ models: [{ id: 'user', source: 'bundled', path: '/models/' + DEFAULT_MODEL_FILE }], selected: 'user' }) === false,
  'the user slot must really be the external user file (source=user), not a bundled entry reusing the id');
{
  let n = 0;
  const r = await restoreDefaultModel({ list: active, restoreDefault: async () => { n++; } });
  ok(n === 0 && r.ok === false && r.reason === 'already_default', 'hidden item: one click makes NO IPC call');
}
const paintAt = app.indexOf('const paintDefaultModel =');
const paintSrc = paintAt >= 0 ? app.slice(paintAt, app.indexOf('function fillPicker', paintAt)) : '';
ok(/\$\('model-default'\)\.hidden = isDefaultModelActive\(\{ models, selected \}\);/.test(paintSrc),
  'app.js hides #model-default exactly when the current model is the locked default (the pure predicate alone)');
ok(/const paintDefaultModel = \(selected = currentId\)/.test(paintSrc),
  'app.js paint takes the selected id (boot passes the full list\'s own selected)');
ok(/paintDefaultModel\(list\.selected\);/.test(app) && /paintDefaultModel\(\);/.test(app),
  'app.js re-evaluates the item after every model change (fillPicker) and after a failed load');

// ---------- 5. MAIN, executed: the real handler on a mocked ipcMain + temp dir + temp settings.json ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-default-model-'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const GOOD = Buffer.from('pretend-default-vrm-bytes');
const settingsPath = path.join(tmp, 'settings.json');
const baseSettings = { model: 'zumi', userModelPath: 'C:/old/other.vrm', aiProvider: 'gemini', roleModels: { do: 'x' }, boardPort: 3055, keyHint: 'k-123' };
const rawSettings = () => fs.readFileSync(settingsPath, 'utf8');
// `content` = the bytes on disk under the default's file name (null = absent). saveSettings has main.js's merge semantics.
function boot(content, extra = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'models-'));
  if (content !== null) fs.writeFileSync(path.join(dir, DEFAULT_MODEL_FILE), content);
  fs.writeFileSync(settingsPath, JSON.stringify(baseSettings, null, 2));
  const handlers = {};
  const saves = [];
  const events = [];
  mainDefault.registerRestoreDefault({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    fs, crypto,
    saveSettings: (patch) => { saves.push(patch); const next = { ...JSON.parse(rawSettings()), ...patch }; fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2)); return next; },
    listModels: () => ({ models: [{ id: 'user', source: 'user', path: path.join(dir, DEFAULT_MODEL_FILE) }], selected: 'user' }),
    sayEvent: (n) => events.push(n),
    dirs: [path.join(dir, 'does-not-exist'), dir],
    expectedSha256: sha(GOOD), // test pin: the production constant belongs to the real file (see the production-pin case)
    ...extra,
  });
  return { dir, handlers, saves, events };
}
{
  const t = boot(GOOD);
  const before = rawSettings();
  ok(Object.keys(t.handlers).join() === 'models:restore-default', 'main registers exactly ONE channel: models:restore-default');
  ok(t.handlers['models:restore-default'].length === 0, 'the handler declares no parameters (it cannot read renderer input)');
  const r = await t.handlers['models:restore-default']({}, { path: 'C:/evil/x.vrm', shaPrefix: 'abc', userModelPath: 'C:/evil/x.vrm' });
  const after = JSON.parse(rawSettings());
  ok(r && r.selected === 'user' && Array.isArray(r.models), 'restore: returns the model list', JSON.stringify(r));
  ok(after.model === 'user' && after.userModelPath === path.join(t.dir, DEFAULT_MODEL_FILE), 'restore: writes the default file (found by main, renderer args ignored) as the user model', JSON.stringify(after));
  ok(t.saves.length === 1 && Object.keys(t.saves[0]).sort().join() === 'model,userModelPath', 'restore: the write patch holds only { model, userModelPath }', JSON.stringify(t.saves));
  const { model: _m, userModelPath: _u, ...restAfter } = after;
  const { model: _m0, userModelPath: _u0, ...restBefore } = JSON.parse(before);
  ok(JSON.stringify(restAfter) === JSON.stringify(restBefore), 'restore: API key / provider / role / port settings are unchanged', JSON.stringify(restAfter));
  ok(t.events.join() === 'look', 'restore: the avatar look event fires once');
}
{
  const t = boot(Buffer.concat([GOOD, Buffer.from('x')]));
  const before = rawSettings();
  const r = await t.handlers['models:restore-default']();
  ok(r && r.error === 'sha_mismatch', 'wrong on-disk hash: refused with sha_mismatch', JSON.stringify(r));
  ok(rawSettings() === before && t.saves.length === 0 && t.events.length === 0, 'wrong on-disk hash: settings.json byte-identical, no write, no event');
}
{
  const t = boot(null);
  const before = rawSettings();
  const r = await t.handlers['models:restore-default']();
  ok(r && r.error === 'missing' && rawSettings() === before && t.saves.length === 0, 'missing file: refused with missing, settings unchanged', JSON.stringify(r));
}
{
  const t = boot(GOOD);
  const f = path.join(t.dir, DEFAULT_MODEL_FILE);
  fs.rmSync(f); fs.mkdirSync(f); // a directory with the right name is not a file
  const before = rawSettings();
  const r = await t.handlers['models:restore-default']();
  ok(r && r.error === 'missing' && rawSettings() === before, 'a directory named like the default is not a file: missing, settings unchanged', JSON.stringify(r));
}
{
  // Without the test pin the handler must use the production constant: arbitrary bytes under the name are refused.
  const t = boot(GOOD, { expectedSha256: undefined });
  const before = rawSettings();
  const r = await t.handlers['models:restore-default']();
  ok(r && r.error === 'sha_mismatch' && rawSettings() === before && t.saves.length === 0, 'production pin: arbitrary bytes under the default name are refused', JSON.stringify(r));
}
{
  const dirs = mainDefault.defaultModelDirs({ env: { ZUMI_DEFAULT_MODEL_DIR: '/env/dir' }, modelsDir: '/app/assets/models', resourcesPath: '/app/resources' });
  ok(dirs.length === 3 && dirs[0] === '/env/dir' && dirs[1] === '/app/assets/models' && dirs[2].replace(/\\/g, '/') === '/app/resources/models', 'location: env override, then app assets/models, then resources/models', JSON.stringify(dirs));
  ok(mainDefault.defaultModelDirs({ env: {}, modelsDir: '/a' }).length === 1, 'location: unset env / resources are skipped');
}
fs.rmSync(tmp, { recursive: true, force: true });

// models:open-file must stay byte-identical to the shipped 79c018c handler (no renderer-supplied path / sha).
const OPEN_FILE_79C018C = `ipcMain.handle('models:open-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open VRM file',
    filters: [{ name: 'VRM model', extensions: ['vrm'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0] || !isVrmFile(r.filePaths[0])) return null;
  saveSettings({ userModelPath: r.filePaths[0], model: 'user' });
  sayEvent('look');
  return listModels();
});
`;
ok(main.replace(/\r\n/g, '\n').includes(OPEN_FILE_79C018C), 'main.js: models:open-file is byte-identical to the 79c018c handler');
ok(!/shaPrefix|setModelFile/.test(main), 'main.js: no renderer-supplied sha / path pick remains');
ok(/const defaultModelSearchDirs = \(\) => defaultModelDirs\(/.test(main) && /registerRestoreDefault\(\{ ipcMain, fs, crypto, saveSettings, listModels, sayEvent, dirs: defaultModelSearchDirs\(\) \}\)/.test(main), 'main.js registers the restore channel through default-model.js');
{
  // first-run adoption: wired in whenReady BEFORE the window exists, with the SAME dirs as the restore channel (one resolution)
  const at = main.indexOf('adoptDefaultIfNoModelKey({ fs, crypto, loadSettings');
  ok(at > 0 && /dirs: defaultModelSearchDirs\(\)/.test(main.slice(at, at + 300)) && at < main.indexOf('mainWindow = createWindow();'), 'main.js adopts the bundled default (no model key) before createWindow, using the restore channel dirs');
}

// Open-source app: no machine-specific drive path in the files this feature owns.
for (const f of [['src', 'main', 'default-model.js'], ['src', 'renderer', 'default-model.js'], ['scripts', 'check-default-model.mjs']]) {
  ok(!/\b[A-Z]:[/\\]K[/\\]/.test(read(...f)), `${f.join('/')}: no hard-coded drive path`);
}

const scripts = pkg.scripts || {};
ok(scripts['check:default-model'] === 'node scripts/check-default-model.mjs', 'package.json: check:default-model is wired', String(scripts['check:default-model']));

// ---------- 6. packaged resolution + build-time inclusion (restrictive asset, never in git) ----------
{
  // Packaged app: nothing in assets/models, no env override -> the file is found under <resources>/models.
  const res = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-resources-'));
  fs.mkdirSync(path.join(res, 'models'));
  fs.writeFileSync(path.join(res, 'models', DEFAULT_MODEL_FILE), GOOD);
  const dirs = mainDefault.defaultModelDirs({ env: {}, modelsDir: path.join(res, 'no-assets-models'), resourcesPath: res });
  const handlers = {};
  const saves = [];
  mainDefault.registerRestoreDefault({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, fs, crypto,
    saveSettings: (p) => { saves.push(p); }, listModels: () => ({ models: [], selected: 'user' }), sayEvent: () => {},
    dirs, expectedSha256: sha(GOOD),
  });
  const r = await handlers['models:restore-default']();
  ok(r && r.selected === 'user' && saves.length === 1 && saves[0].userModelPath === path.join(res, 'models', DEFAULT_MODEL_FILE),
    'packaged: restore resolves the file from <resources>/models and sets it as the user model', JSON.stringify([r, saves]));
  fs.rmSync(res, { recursive: true, force: true });
}
const defaultVrm = require('./lib/default-vrm.cjs');
const pin = JSON.parse(read('resources-pinned', 'default-model', 'PIN-MANIFEST.json'));
ok(pin.file === DEFAULT_MODEL_FILE && pin.sha256 === mainDefault.DEFAULT_MODEL_SHA256, 'PIN-MANIFEST: file + sha256 equal the runtime constants in src/main/default-model.js');
ok(pin.sha256 === 'd1183bcf27bac3a587de7e383bcd8f6f4e0068e0a7c56653fa3e731e1460c372' && pin.bytes === 9141588 && mainDefault.DEFAULT_MODEL_BYTES === pin.bytes, 'PIN-MANIFEST + runtime: the pin is the 3K FOREST file with meta commercialUsage corporation (alpha.4, d1183bcf..., 9141588 B)');
ok(Number.isInteger(pin.bytes) && pin.bytes > 0 && pin.sourceEnvVar === 'ZUMI_DEFAULT_VRM_PATH', 'PIN-MANIFEST: byte size pinned, source env var is ZUMI_DEFAULT_VRM_PATH');
{
  const lic = read('resources-pinned', 'default-model', pin.licenceNoticeFile);
  ok(/NOT part of the app's open-source/i.test(lic) && /AGPL/.test(lic), 'licence notice: the model is not part of the OSS source / not AGPL');
  ok(/AvatarSample_K/.test(lic) && /pixiv/i.test(lic) && /not CC0/i.test(lic), 'licence notice: VRoid AvatarSample_K lineage + pixiv sample terms (not CC0)');
  ok(/may NOT use this model[^]*character-creation|character-creation use/i.test(lic) && /NOT copy, redistribute/.test(lic), 'licence notice: no redistribution, no character-creation use');
}
{
  // the source is no longer in the (public) pin manifest: env, else the owner-only values file
  const src = ownerPath('defaultAvatarSource', null);
  ok(!('defaultSourcePath' in pin), 'the pin manifest names no machine path (the build source is env or the owner values file)');
  if (src) ok(!fs.existsSync(path.join(ROOT, src)) && path.isAbsolute(src), 'the owner default build source is an absolute path outside the repo', src);
  else console.log('SKIP the owner default build source: no owner values file in this tree');
}
// Build gate: the afterPack stage refuses a missing or different file and copies a good one (temp pin-sized stand-ins cannot
// pass the real sha256, so the failure paths use real temp files and the success path needs the real avatar when present).
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-stage-'));
  const refuses = (env, re) => { try { defaultVrm.stageIntoResources(path.join(t, 'out'), env); return false; } catch (e) { return re.test(e.message); } };
  ok(refuses({ ZUMI_DEFAULT_VRM_PATH: path.join(t, 'absent.vrm') }, /default avatar missing/), 'build: a missing file fails the build loudly');
  fs.writeFileSync(path.join(t, 'tiny.vrm'), GOOD);
  ok(refuses({ ZUMI_DEFAULT_VRM_PATH: path.join(t, 'tiny.vrm') }, /size mismatch/), 'build: a wrong-size file fails the build loudly');
  fs.writeFileSync(path.join(t, 'same-size.vrm'), Buffer.alloc(pin.bytes, 7));
  ok(refuses({ ZUMI_DEFAULT_VRM_PATH: path.join(t, 'same-size.vrm') }, /sha256 mismatch/), 'build: same size but different bytes fails the build loudly');
  ok(!fs.existsSync(path.join(t, 'out')), 'build: a refused file stages nothing');
  const real = defaultVrm.resolveSource(process.env);
  if (real && fs.existsSync(real)) {
    const dst = defaultVrm.stageIntoResources(path.join(t, 'out'), process.env);
    ok(sha(fs.readFileSync(dst)) === pin.sha256 && fs.existsSync(path.join(t, 'out', 'resources', 'models', pin.licenceNoticeFile)),
      'build: the real avatar is staged into resources/models with its licence notice (sha256 verified)', dst);
  } else console.log('SKIP build staging of the real avatar: not found at ' + real + ' (set ZUMI_DEFAULT_VRM_PATH)');
  fs.rmSync(t, { recursive: true, force: true });
}
ok(pkg.build.afterPack === 'scripts/after-pack-default-model.cjs' && fs.existsSync(path.join(ROOT, 'scripts', 'after-pack-default-model.cjs')), 'package.json: build.afterPack stages the default avatar (release build)');
ok(read('scripts', 'builder-selftest.cjs').includes("require('./after-pack-default-model.cjs')(ctx)"), 'builder-selftest.cjs: the owner build stages it too (before its Electron gate)');
ok(!JSON.stringify(pkg.build.extraResources).includes('.vrm') && !JSON.stringify(pkg.build.files).includes('.vrm'), 'package.json: no .vrm is packed through files/extraResources (only the checked afterPack copy)');
{
  const gi = read('.gitignore');
  ok(/^\*\.vrm$/m.test(gi),'.gitignore: *.vrm can never be committed');
  const g = spawnSync('git', ['ls-files', '*.vrm', '**/*.vrm'], { cwd: ROOT, encoding: 'utf8' });
  if (g.status === 0) ok(g.stdout.trim() === '', 'git: no .vrm file is tracked', g.stdout);
  else console.log('SKIP git ls-files (git unavailable)');
}

// The locked avatar, when present on this PC (env override or app assets), must still be the pinned bytes.
const dirsHere = mainDefault.defaultModelDirs({ env: process.env, modelsDir: path.join(ROOT, 'assets', 'models') });
const here = dirsHere.map((d) => path.join(d, DEFAULT_MODEL_FILE)).find((f) => fs.existsSync(f));
if (here) ok(sha(fs.readFileSync(here)) === mainDefault.DEFAULT_MODEL_SHA256, 'locked default on this PC: sha256 equals the pinned constant', here);
else console.log('SKIP locked default: not found via ZUMI_DEFAULT_MODEL_DIR or assets/models (the refusal path is gated above)');

// ---------- 7. first run: a profile with NO model key starts on the bundled default (T-31 0.2.8) ----------
{
  const res = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-firstrun-'));
  fs.mkdirSync(path.join(res, 'models'));
  const defFile = path.join(res, 'models', DEFAULT_MODEL_FILE);
  fs.writeFileSync(defFile, GOOD);
  const dirs = mainDefault.defaultModelDirs({ env: {}, modelsDir: path.join(res, 'no-assets-models'), resourcesPath: res });
  const userFile = path.join(res, 'my-own.vrm');
  fs.writeFileSync(userFile, Buffer.from('a user model'));
  // settings stand-in + listModels stand-in that mirrors main.js: selected = the saved id when its file exists, else null
  const run = async (settings, extra = {}) => {
    const store = { ...settings }; const saves = [];
    const r = await mainDefault.adoptDefaultIfNoModelKey({
      fs, crypto, dirs, expectedSha256: sha(GOOD), ...extra,
      loadSettings: () => store,
      saveSettings: (p) => { saves.push(p); Object.assign(store, p); },
      listModels: () => ({ selected: store.model === 'user' && store.userModelPath && fs.existsSync(store.userModelPath) ? 'user' : null }),
    });
    return { r, saves, store };
  };
  let o = await run({});
  ok(o.r === 'adopted' && o.saves.length === 1 && o.saves[0].model === 'user' && o.saves[0].userModelPath === defFile, 'fresh settings, no model key: the bundled default is loaded (same { userModelPath, model: "user" } write as the restore button)', JSON.stringify(o));
  o = await run({ boardPort: 1234, aiProvider: 'x' });
  ok(o.r === 'adopted' && o.store.boardPort === 1234 && o.store.aiProvider === 'x', 'other settings keys do not count as a saved model and survive');
  o = await run({ model: 'user', userModelPath: userFile });
  ok(o.r === 'kept' && o.saves.length === 0, 'a saved user model is kept (nothing written)');
  o = await run({ model: 'user', userModelPath: defFile });
  ok(o.r === 'kept' && o.saves.length === 0, 'a saved default is kept (nothing written)');
  o = await run({ model: 'user', userModelPath: path.join(res, 'gone.vrm') });
  ok(o.r === 'kept' && o.saves.length === 0, "a saved key whose file is missing is NOT overridden (today's behaviour: no avatar until the user picks)");
  o = await run({ model: null });
  ok(o.r === 'kept' && o.saves.length === 0, 'an explicit saved model:null is a saved key and is kept');
  o = await run({}, { hasTestModel: true });
  ok(o.r === 'kept' && o.saves.length === 0, 'a --model test run is never persisted over');
  fs.writeFileSync(defFile, Buffer.from('tampered'));
  o = await run({});
  ok(o.r && o.r.error === 'sha_mismatch' && o.saves.length === 0, 'a byte-changed default file is refused on first run (same check as the button), nothing written');
  fs.rmSync(defFile);
  o = await run({});
  ok(o.r && o.r.error === 'missing' && o.saves.length === 0, 'no default file on this install (dev run): nothing written');
  fs.rmSync(res, { recursive: true, force: true });
}

console.log(`\ncheck:default-model ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
