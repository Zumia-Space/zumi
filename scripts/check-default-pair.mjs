// T-31-ROOM round 8 (owner 16-11: "2 model trong hình model cũ và model quần áo mới là 2 model mặc định của Zumi luôn nhé").
// Zumi ships TWO default models, both selectable out of the box: the new outfit first (the one a fresh profile starts on), the
// 0910 look second. Both carry the outfit shading pass (tools/outfit-shade/shade_pass.py): material values checked here.
//   - the Tauri stage puts the two pinned files into assets/models and the sidecar offers them in front of the model list
//     (tauri/sidecar/default-pair.mjs); picking one puts its file into the 'user' slot, so the asset route and the room pack's
//     avatar follow with no host change; assets/models/models.json stays empty (no bundled-manifest model);
//   - a fresh profile adopts the first; a pick of the second holds; a changed file is refused before any write;
//   - the bundle gate refuses a stage without either file;
//   - "Back to default model" hides while the picker already offers the defaults; Electron keeps its one default.
//   node scripts/check-default-pair.mjs   (plain Node; needs the two source files of the owner build, like check:rig)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = fs.mkdtempSync(path.join(process.env.CHECK_TMP_BASE || os.tmpdir(), 'zumi-pair-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp only */ } });

const dm = require('../src/main/default-model.js');
const vrmLib = require('./lib/default-vrm.cjs');
const { createModels } = require('../src/main/models-core.js');
const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources-pinned/default-model/PIN-MANIFEST.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/models/models.json'), 'utf8'));
const pairMod = await import('../tauri/sidecar/default-pair.mjs').catch(() => ({}));
const bootMod = await import('../tauri/sidecar/default-model-boot.mjs');
const LOOK4 = 'zumi-default-look4.vrm', LOOK3 = 'zumi-default-0910.vrm';

// ---- 1. the pair is pinned once and the places agree ----
const pair = Array.isArray(dm.DEFAULT_MODELS) ? dm.DEFAULT_MODELS : [];
ok(pair.length === 2 && pair[0].file === LOOK4 && pair[1].file === LOOK3 && pair[0].id === 'zumi-look4' && pair[1].id === 'zumi-look3', 'default-model.js DEFAULT_MODELS: the new outfit first, the 0910 look second', pair.map((m) => m.file));
ok(pair.length === 2 && pair[1].sha256 === dm.DEFAULT_MODEL_SHA256 && pair[1].bytes === dm.DEFAULT_MODEL_BYTES && dm.DEFAULT_MODEL_FILE === LOOK3, 'the second of the pair is the file "Back to default model" restores (Electron keeps its one default)');
const pins = [pin, ...(Array.isArray(pin.pair) ? pin.pair : [])];
ok(pins.length === 2 && pair.every((m) => pins.some((p) => p.file === m.file && p.sha256 === m.sha256 && p.bytes === m.bytes)), 'PIN-MANIFEST.json pins the same two files (size + sha256)', pins.map((p) => [p.file, p.bytes]));
ok(Array.isArray(manifest.models) && manifest.models.length === 0, 'assets/models/models.json stays empty: the defaults are not bundled-manifest models');
ok(dm.KNOWN_SAMPLES.some((x) => x.sha256 === 'd1183bcf27bac3a587de7e383bcd8f6f4e0068e0a7c56653fa3e731e1460c372' && x.bytes === 9141588) && dm.KNOWN_SAMPLES.some((x) => x.sha256 === dm.DEFAULT_MODEL_SHA256),
  'the 0910 look before the shading pass is still recognised as the sample on a user\'s disk');

// ---- 2. the picker: both offered out of the box, a fresh profile starts on the first, a pick holds ----
const dir = path.join(tmp, 'models'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(manifest));
const A4 = crypto.randomBytes(3000), A3 = crypto.randomBytes(2000);
fs.writeFileSync(path.join(dir, LOOK4), A4); fs.writeFileSync(path.join(dir, LOOK3), A3);
const fake = [{ id: 'zumi-look4', file: LOOK4, sha256: sha(A4), bytes: A4.length }, { id: 'zumi-look3', file: LOOK3, sha256: sha(A3), bytes: A3.length }];
let settings = {}; const saved = [];
const save = (patch) => { saved.push(patch); settings = { ...settings, ...patch }; };
const core = createModels({ modelsDir: dir, loadSettings: () => settings, urlPrefix: 'app://zumi/' });
const has = typeof pairMod.withDefaultPair === 'function' && typeof pairMod.pickDefault === 'function';
ok(has, 'tauri/sidecar/default-pair.mjs exports withDefaultPair and pickDefault');
const listNow = () => (has ? pairMod.withDefaultPair(core.listModels(), { modelsDir: dir, pins: fake }) : core.listModels());
let list = listNow();
ok(list.models.slice(0, 2).map((m) => m.id).join() === 'zumi-look4,zumi-look3' && list.models.slice(0, 2).every((m) => m.source === 'default') && list.models[0].isDefault === true && list.models[1].isDefault !== true,
  'models:list offers both defaults in front, the new outfit first and marked default', list.models.map((m) => [m.id, m.source]));
ok(list.selected === null && list.models.length === 2, 'a fresh profile has nothing selected yet and no user entry', [list.selected, list.models.length]);
const adopt = await dm.adoptDefaultIfNoModelKey({ fs, crypto, loadSettings: () => settings, saveSettings: save, listModels: listNow, dirs: [dir], first: fake[0] });
list = listNow();
ok(adopt === 'adopted' && settings.model === 'user' && path.basename(settings.userModelPath || '') === LOOK4 && list.selected === 'zumi-look4' && list.models.length === 2 && typeof list.models[0].url === 'string' && /external\/user\.vrm/.test(list.models[0].url),
  'first start adopts the new outfit into the user slot; the list shows it selected, with the slot\'s url, and no separate user entry', { adopt, selected: list.selected, n: list.models.length, url: list.models[0] && list.models[0].url });
ok(has && pairMod.pickDefault('zumi-look3', { modelsDir: dir, saveSettings: save, pins: fake }) === true && path.basename(settings.userModelPath) === LOOK3 && settings.model === 'user' && listNow().selected === 'zumi-look3',
  'picking the 0910 look puts its file into the user slot and holds', settings);
const keys = saved.flatMap((x) => Object.keys(x)).filter((k) => k !== 'userModelPath' && k !== 'model');
ok(keys.length === 0, 'picks write userModelPath and model only', keys);
fs.writeFileSync(path.join(dir, LOOK4), crypto.randomBytes(3000)); // same size, other bytes
const before = JSON.stringify(settings);
const refused = has ? pairMod.pickDefault('zumi-look4', { modelsDir: dir, saveSettings: save, pins: fake }) : null;
ok(refused && refused.error === 'sha_mismatch' && JSON.stringify(settings) === before, 'a changed file under a default\'s name is refused before any write', refused);
fs.writeFileSync(path.join(dir, LOOK4), A4);
const own = path.join(tmp, 'my-own.vrm'); fs.writeFileSync(own, crypto.randomBytes(500));
settings = { model: 'user', userModelPath: own };
list = listNow();
ok(list.selected === 'user' && list.models.map((m) => m.id).join() === 'zumi-look4,zumi-look3,user' && list.models[0].url === null, 'a user\'s own model stays selected, listed after the two defaults (which carry no url until picked)', list.models.map((m) => m.id));
fs.rmSync(path.join(dir, LOOK4)); settings = {};
list = listNow();
ok(list.models.map((m) => m.id).join() === 'zumi-look3', 'without the first file only the 0910 look is offered', list.models.map((m) => m.id));
const adopt2 = await dm.adoptDefaultIfNoModelKey({ fs, crypto, loadSettings: () => settings, saveSettings: save, listModels: listNow, dirs: [dir], first: fake[0], expectedSha256: sha(A3) });
ok(adopt2 === 'adopted' && path.basename(settings.userModelPath || '') === LOOK3, 'and a fresh profile then adopts the 0910 look, as before the pair', adopt2);
ok(/first: expectedSha256 \? null : DEFAULT_MODELS\[0\]/.test(fs.readFileSync(path.join(ROOT, 'tauri/sidecar/default-model-boot.mjs'), 'utf8')) && typeof bootMod.adoptDefaultOnBoot === 'function', 'the sidecar\'s first-run adoption asks for the first of the pair');
const lib = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/library.mjs'), 'utf8'), br = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/boot-reads.mjs'), 'utf8');
ok(/picked\.source === 'default'/.test(lib) && /boot\.pickDefaultModel\(id\)/.test(lib) && /withDefaultPair\(appUrls\(models\.listModels\(\)\)/.test(br), 'models:list and models:select in the sidecar go through the pair');

// ---- 2b. the names in the picker (CoS 16-11): "Zumi", and "Zumi cổ điển" (vi) / "Zumi classic" (en) ----
const { TABLES } = await import('../src/renderer/i18n.js');
const { modelLabel } = await import('../src/renderer/default-model.js');
fs.writeFileSync(path.join(dir, LOOK4), A4); settings = {};
const named = listNow().models;
const tr = (lang) => (key) => TABLES[lang][key];
ok(named.length === 2 && modelLabel(named[0], tr('vi')) === 'Zumi' && modelLabel(named[0], tr('en')) === 'Zumi', 'the new outfit is named "Zumi" in every language', named[0]);
ok(named.length === 2 && named[1].labelKey === 'model.zumiClassic' && modelLabel(named[1], tr('vi')) === 'Zumi cổ điển' && modelLabel(named[1], tr('en')) === 'Zumi classic',
  'the 0910 look is named "Zumi cổ điển" in Vietnamese and "Zumi classic" in English', named[1] && [named[1].labelKey, named[1].label]);
ok(Object.keys(TABLES).every((l) => typeof TABLES[l]['model.zumiClassic'] === 'string' && TABLES[l]['model.zumiClassic'].trim() !== ''), 'every language table has the name', Object.keys(TABLES));

// ---- 3. the bundle gate ----
const notice = fs.readFileSync(path.join(ROOT, 'resources-pinned/default-model', pin.licenceNoticeFile), 'utf8');
const A = Buffer.from('fake look3'), B = Buffer.from('fake look4');
const fakePin = { file: LOOK3, bytes: A.length, sha256: sha(A), licenceNoticeFile: pin.licenceNoticeFile, pair: [{ file: LOOK4, bytes: B.length, sha256: sha(B) }] };
const stage = (name, files) => { const d = path.join(tmp, name, 'assets', 'models'); fs.mkdirSync(d, { recursive: true }); for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(d, f), b); return path.join(tmp, name); };
const full = { [LOOK3]: A, [LOOK4]: B, [pin.licenceNoticeFile]: notice };
const v = (root) => vrmLib.verifyStagedDefaultModel(root, fakePin);
ok(v(stage('ok', full)).length === 0, 'bundle gate: a stage with both files and the notice passes', v(stage('ok2', full)));
const no4 = { ...full }; delete no4[LOOK4];
ok(v(stage('no4', no4)).some((p) => p.includes(LOOK4)), 'bundle gate: a stage without the new outfit is refused, and the refusal names the file', v(stage('no4b', no4)));
ok(v(stage('bad4', { ...full, [LOOK4]: Buffer.from('other bytes') })).some((p) => p.includes(LOOK4)), 'bundle gate: a different file under the new outfit\'s name is refused');
ok(/zumi-default-look4\.vrm/.test(notice) && /zumi-default-0910\.vrm/.test(notice), 'the licence notice names both model files');

// ---- 4. "Back to default model" hides while the picker offers the defaults ----
const { isDefaultModelActive } = await import('../src/renderer/default-model.js');
ok(isDefaultModelActive({ models: [{ id: 'zumi-look4', source: 'default', isDefault: true }, { id: 'zumi-look3', source: 'default' }, { id: 'user', source: 'user', path: 'C:/x/my.vrm' }], selected: 'user' }) === true, 'the restore item hides when the list offers the defaults');
ok(isDefaultModelActive({ models: [{ id: 'user', source: 'user', path: 'C:/x/my.vrm' }], selected: 'user' }) === false, 'the restore item still shows for a user model when no default is offered (Electron, public build)');

// ---- 5. the two shipped files: the pins, and the shading pass on the clothes only ----
const KEEP = /SKIN|FACE|EYE|HAIR|Brow|Lash|Mouth|Halo|Glow|Tips|Drone|Fin/i;
const glbJson = (file) => { const b = fs.readFileSync(file); return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')); };
const sources = typeof vrmLib.resolveSources === 'function' ? vrmLib.resolveSources() : [];
ok(sources.length === 2 && sources.every((s) => s.src && fs.existsSync(s.src)), 'both source files are known on this machine (owner values or the two env vars)', sources.map((s) => s.src));
for (const s of sources) {
  if (!s.src || !fs.existsSync(s.src)) continue;
  const buf = fs.readFileSync(s.src), p = pins.find((x) => x.file === s.file);
  ok(p && buf.length === p.bytes && sha(buf) === p.sha256, `${s.file}: the source file is the pinned one (size + sha256)`, { bytes: buf.length });
  ok(buf.length <= 9.6e6, `${s.file}: within the 9.6 MB budget`, buf.length);
  const j = glbJson(s.src), mt = (m) => (m.extensions || {}).VRMC_materials_mtoon;
  const cloth = j.materials.filter((m) => mt(m) && !KEEP.test(m.name || '')), rest = j.materials.filter((m) => mt(m) && KEEP.test(m.name || ''));
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const satin = (m) => { const t = mt(m).matcapTexture; return t && j.images[j.textures[t.index].source].name === 'Zumia_SatinMatcap'; };
  const bad = cloth.filter((m) => !(near(mt(m).shadingToonyFactor, 0.5) && near(mt(m).shadingShiftFactor, -0.12) && near(mt(m).parametricRimFresnelPowerFactor, 3.5) && near(mt(m).rimLightingMixFactor, 0.7) && satin(m) && [0.42, 0.13].some((x) => near(mt(m).matcapFactor[0], x))));
  ok(cloth.length >= 8 && bad.length === 0, `${s.file}: every cloth material carries the material pass (round 9: soft toon edge 0.5, shift -0.12, rim power 3.5, satin matcap 0.42 or 0.13)`, { cloth: cloth.length, bad: bad.map((m) => m.name) });
  const touched = rest.filter((m) => satin(m) || near(mt(m).shadingToonyFactor, 0.5));
  ok(rest.length >= 8 && touched.length === 0, `${s.file}: face, skin, hair, eyes, halo, drones and fins are not touched by it`, { rest: rest.length, touched: touched.map((m) => m.name) });
}

console.log(`check:default-pair ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
