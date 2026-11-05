// The bundled VRoid sample (zumi-default-0910.vrm and its earlier builds) is recognised by its BYTES (size + pinned
// sha256 of the file), never by its name or folder, so a renamed or relocated copy of the sample is still the sample.
// models-core uses it to label the 'user' slot "Zumi default". Split out of check-wardrobe-block.mjs when the wardrobe
// (the block's other half) was removed in 0.3.0-alpha.11; this file also asserts that block is gone.
// Plain Node, no Electron (the repo's check:* convention).
//   npm run check:default-sample
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TABLES } from '../src/renderer/i18n.js';
import { ownerPath } from './lib/owner-paths.mjs';

const require = createRequire(import.meta.url);
const dm = require('../src/main/default-model.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---------- 2. identity: bytes, not names ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-wbl-'));
const sampleBytes = crypto.randomBytes(4096);
const sampleSha = sha(sampleBytes);
const sampleA = path.join(tmp, 'zumi-default-0910.vrm');
const renamed = path.join(tmp, 'sub', 'my-cool-avatar.vrm');
const userModel = path.join(tmp, 'user.vrm');
const sameNameOtherBytes = path.join(tmp, 'other', 'zumi-default-0910.vrm');
const sameSizeOtherBytes = path.join(tmp, 'samesize.vrm');
fs.mkdirSync(path.dirname(renamed), { recursive: true }); fs.mkdirSync(path.dirname(sameNameOtherBytes), { recursive: true });
fs.writeFileSync(sampleA, sampleBytes); fs.writeFileSync(renamed, sampleBytes);
fs.writeFileSync(userModel, crypto.randomBytes(8192));
fs.writeFileSync(sameNameOtherBytes, crypto.randomBytes(4096));
fs.writeFileSync(sameSizeOtherBytes, crypto.randomBytes(4096));

ok(typeof dm.createDefaultSampleDetector === 'function', 'main exports createDefaultSampleDetector');
if (typeof dm.createDefaultSampleDetector === 'function') {
  const detector = dm.createDefaultSampleDetector({ fs, crypto, expectedSha256: sampleSha, expectedBytes: sampleBytes.length });
  ok(detector.isDefaultSample(sampleA) === true, 'the sample file is the default sample');
  ok(detector.isDefaultSample(renamed) === true, 'a RENAMED / relocated byte-identical copy is still the sample');
  ok(detector.isDefaultSample(userModel) === false, 'a user model (other size) is not');
  ok(detector.isDefaultSample(sameNameOtherBytes) === false, 'the default FILE NAME with other bytes is not the sample');
  ok(detector.isDefaultSample(sameSizeOtherBytes) === false, 'same size, other bytes is not the sample');
  ok(detector.isDefaultSample(null) === false && detector.isDefaultSample(path.join(tmp, 'nope.vrm')) === false, 'no model / missing file is not the sample');
  // the cache must follow the bytes: overwrite the user model with the sample bytes, then back
  fs.writeFileSync(userModel, sampleBytes);
  const t = new Date(Date.now() + 5000); fs.utimesSync(userModel, t, t);
  ok(detector.isDefaultSample(userModel) === true, 'a file rewritten to the sample bytes flips to true (cache keyed by mtime+size)');
  fs.writeFileSync(userModel, crypto.randomBytes(4096));
  const t2 = new Date(Date.now() + 10000); fs.utimesSync(userModel, t2, t2);
  ok(detector.isDefaultSample(userModel) === false, 'and back to false');
}
// the production list blocks BOTH the shipped file (3K FOREST) and the 0.2.7 default; a user model is not
{
  // alpha.4 item 4: the shipped file is now the corporation-commercialUsage one; the pixiv-credit file (PIX_SHA) joins the old list.
  const NEW_SHA = 'd1183bcf27bac3a587de7e383bcd8f6f4e0068e0a7c56653fa3e731e1460c372', PIX_SHA = '310203381f11d5c045af5f3f37ae300d3c400916edf3484ba78c30c6a7eab0f1', MID_SHA = '7b28695a81cf53cd878ac25d19bd6c56e4310a50453968f4cdbd93234ec3d240', OLD_SHA = 'd01f7273cd8480d28252bfac8f907d070bc10a8731e1b4def224c18387de4e8a';
  const ks = dm.KNOWN_SAMPLES || [];
  ok(ks.length === 4 && ks.some((k) => k.sha256 === NEW_SHA && k.bytes === 9141588) && ks.some((k) => k.sha256 === PIX_SHA && k.bytes === 9141592) && ks.some((k) => k.sha256 === MID_SHA && k.bytes === 9142044) && ks.some((k) => k.sha256 === OLD_SHA && k.bytes === 9142032), 'KNOWN_SAMPLES lists the new corporation-meta (9141588), the pixiv-credit (9141592), the 3K FOREST pre-pixiv-meta (9142044) and the old 0.2.7 (9142032) sample');
  ok(dm.DEFAULT_MODEL_SHA256 === NEW_SHA && dm.DEFAULT_MODEL_BYTES === 9141588, 'the shipped/pinned identity is the NEW file (commercialUsage corporation in meta)');
  // two fake samples of different sizes through the same seam the production list uses
  const sa = crypto.randomBytes(3000), sb = crypto.randomBytes(3500);
  const fa = path.join(tmp, 'sa.vrm'), fb = path.join(tmp, 'sb.vrm'), fu = path.join(tmp, 'su.vrm'), fs2 = path.join(tmp, 'same-size-as-sa.vrm');
  fs.writeFileSync(fa, sa); fs.writeFileSync(fb, sb); fs.writeFileSync(fu, crypto.randomBytes(5000)); fs.writeFileSync(fs2, crypto.randomBytes(3000));
  const multi = dm.createDefaultSampleDetector({ fs, crypto, samples: [{ sha256: sha(sa), bytes: sa.length }, { sha256: sha(sb), bytes: sb.length }] });
  ok(multi.isDefaultSample(fa) === true && multi.isDefaultSample(fb) === true, 'a multi-identity list blocks EVERY known sample (new and old)');
  ok(multi.isDefaultSample(fu) === false && multi.isDefaultSample(fs2) === false, 'a user model (other size, or same size as a sample but other bytes) is not blocked');
  // production list, real files when present on this PC: old 0.2.7 default (if kept) is also detected
  const prod = dm.createDefaultSampleDetector({ fs, crypto });
  const oldSrc = process.env.ZUMI_OLD_DEFAULT_VRM_PATH || ownerPath('oldDefaultVrm', 'local/old-default.vrm');
  if (fs.existsSync(oldSrc)) ok(prod.isDefaultSample(oldSrc) === (fs.statSync(oldSrc).size === 9142032 && sha(fs.readFileSync(oldSrc)) === OLD_SHA), 'production list: the old sample file (when present) is detected iff its bytes are the 0.2.7 default');
  ok(prod.isDefaultSample(userModel) === false, 'production list: a user model is not the sample');
}
// the pinned constants agree with the pin manifest, and (when present on this PC) the real file is detected
const pin = JSON.parse(read('resources-pinned', 'default-model', 'PIN-MANIFEST.json'));
ok(dm.DEFAULT_MODEL_BYTES === pin.bytes && dm.DEFAULT_MODEL_SHA256 === pin.sha256, 'DEFAULT_MODEL_BYTES / SHA256 agree with PIN-MANIFEST.json');
const realDefault = process.env.ZUMI_DEFAULT_VRM_PATH || ownerPath('defaultAvatarSource', null);
if (typeof dm.createDefaultSampleDetector === 'function' && realDefault && fs.existsSync(realDefault)) {
  ok(dm.createDefaultSampleDetector({ fs, crypto }).isDefaultSample(realDefault) === true, 'the REAL pinned avatar is detected with the production pins');
}

// ---------- 3. the label the detector drives (models-core), and the removed wardrobe block (negative) ----------
{
  const { createModels } = require('../src/main/models-core.js');
  const mdir = path.join(tmp, 'models'); fs.mkdirSync(mdir, { recursive: true });
  const sampleList = createModels({ modelsDir: mdir, loadSettings: () => ({ model: 'user', userModelPath: sampleA }), isDefaultSample: (f) => f === sampleA }).listModels();
  const user = sampleList.models.find((m) => m.id === 'user');
  ok(user && user.labelKey === 'model.zumiDefault', 'models-core: the sample in the user slot is labelled "Zumi default"', JSON.stringify(user));
  const otherList = createModels({ modelsDir: mdir, loadSettings: () => ({ model: 'user', userModelPath: userModel }), isDefaultSample: (f) => f === sampleA }).listModels();
  ok(!otherList.models.find((m) => m.id === 'user').labelKey, 'models-core: a user model gets no default label');
  ok(!('wardrobeBlocked' in sampleList), 'models-core: listModels() carries no wardrobeBlocked any more (wardrobe removed)', JSON.stringify(Object.keys(sampleList)));
}
ok(!('wardrobeBlockedMessage' in dm), 'default-model.js exports no wardrobeBlockedMessage');
ok(!/wardrobe/i.test(read('src', 'main', 'default-model.js').replace(/check:default-sample/g, '')), 'default-model.js has no wardrobe code or wording left');
for (const lang of Object.keys(TABLES)) ok(!Object.keys(TABLES[lang]).some((k) => /wardrobe/i.test(k)), `i18n ${lang}: no wardrobe key`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
