// T-31 Tauri parity (25-10): "Về model mặc định" (models:restore-default, Electron ab66e9b/05bf103) resets to the pinned
// file, refuses a changed file without writing, and is reachable by the MAIN webview only (never a guest, never the
// board). Split out of check-tauri-wardrobe-block.mjs when the wardrobe (that check's other half) was removed in
// 0.3.0-alpha.11; the last section asserts the wardrobe surface is gone from the shipped sources.
//   node scripts/check-tauri-restore-default.mjs   (plain Node: no GUI, no network, no .vrm in git)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TABLES } from '../src/renderer/i18n.js';
import { restoreDefaultModel } from '../src/renderer/default-model.js';
import { createRestoreDefault } from '../tauri/sidecar/default-model-boot.mjs';
import { guestOnlyMethodNames, rendererMethodNames } from '../tauri/gen-allowlist.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let fail = 0;
const ok = (cond, name, detail = '') => { if (!cond) fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? '  ' + detail : ''}`); };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = fs.mkdtempSync(path.join(process.env.CHECK_TMP_BASE || os.tmpdir(), 'zumi-rd-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp only */ } });

const LOCALES = Object.keys(TABLES); // every UI locale the renderer has (en, vi, zh)

// ---- 1. the button's strings exist in EVERY renderer locale ----
ok(['en', 'vi', 'zh'].every((l) => LOCALES.includes(l)), 'renderer has en, vi, zh', LOCALES.join());
for (const l of LOCALES) {
  for (const k of ['zumi.defaultModel', 'zumi.defaultModelTitle', 'app.defaultModelMissing', 'app.defaultModelWrong', 'app.defaultModelUnreadable']) {
    ok(typeof TABLES[l][k] === 'string' && TABLES[l][k].trim() !== '', `i18n ${l}: ${k} present`);
  }
}

// ---- 2. the sample: fake bytes + a pinned-sha seam (the real 9 MB file is never in git) ----
const sampleBytes = crypto.randomBytes(4096);
const modelsDir = path.join(tmp, 'models');
fs.mkdirSync(modelsDir, { recursive: true });
const DEFAULT_MODEL_FILE = 'zumi-default-0910.vrm';
const sampleFile = path.join(modelsDir, DEFAULT_MODEL_FILE);
fs.writeFileSync(sampleFile, sampleBytes);
const userFile = path.join(tmp, 'mine.vrm');
fs.writeFileSync(userFile, crypto.randomBytes(8192));

// ---- 3. restore-default: resets to the pinned file; a changed file is refused without a write ----
const mkRestore = (extra = {}) => {
  const st = { model: 'bundled-x', userModelPath: userFile };
  const patches = []; const said = [];
  const r = createRestoreDefault({
    settings: () => st, saveSettings: (p) => { patches.push(p); Object.assign(st, p); },
    listModels: () => ({ models: [], selected: st.model }), sayEvent: (n) => said.push(n),
    modelsDir, env: {}, expectedSha256: sha(sampleBytes), ...extra,
  });
  return { st, patches, said, r };
};
let t = mkRestore();
let res = await t.r();
ok(t.patches.length === 1 && t.st.model === 'user' && t.st.userModelPath === sampleFile && Array.isArray(res.models), 'restore-default: settings reset to the pinned file, list returned', JSON.stringify([t.patches, res]));
ok(Object.keys(t.patches[0] || {}).sort().join() === 'model,userModelPath', 'restore-default writes ONLY { userModelPath, model }');
ok(t.said.join() === 'look', 'restore-default says the whitelisted "look" line');
t = mkRestore({ expectedSha256: sha(Buffer.from('other')) });
res = await t.r();
ok(res && res.error === 'sha_mismatch' && t.patches.length === 0, 'restore-default: a changed default file is refused, nothing written', JSON.stringify(res));
t = mkRestore({ modelsDir: path.join(tmp, 'empty') });
res = await t.r();
ok(res && res.error === 'missing' && t.patches.length === 0, 'restore-default: a missing default file is refused, nothing written', JSON.stringify(res));
ok(t.r.length === 0, 'restore-default handler takes no arguments (cannot be pointed at another file)');

// ---- 4. renderer: restore click (pure) ----
let called = 0;
const rr = await restoreDefaultModel({ list: { models: [], selected: null }, restoreDefault: async () => { called++; return { models: [{ id: 'user' }], selected: 'user' }; }, onList: () => {} });
ok(called === 1 && rr.ok === true, 'UI: restore click asks main with no arguments and applies the list');

// ---- 5. wiring read from the shipped sources ----
const inventory = JSON.parse(read('docs/migration/api-inventory.json'));
const inv = inventory.apis.find((a) => a.name === 'restoreDefaultModel');
ok(inv && inv.channel === 'models:restore-default' && inv.kind === 'invoke' && (inv.args || []).length === 0, 'inventory: restoreDefaultModel (models:restore-default), no arguments');
ok(rendererMethodNames(inventory).includes('restoreDefaultModel'), 'rpc allow-list: restoreDefaultModel is served to the main webview');
ok(!guestOnlyMethodNames(inventory).includes('restoreDefaultModel'), 'restoreDefaultModel is not a guest-only name');
const alRs = read('tauri/src-tauri/src/rpc_allow_list.rs');
ok(/"restoreDefaultModel"/.test(alRs.split('GUEST_ONLY_METHODS')[0]), 'generated allow-list file contains restoreDefaultModel in ALLOWED_METHODS');
ok(!(alRs.split('GUEST_ONLY_METHODS')[1] || '').includes('restoreDefaultModel'), 'GUEST_ONLY_METHODS does not');
const defCap = JSON.parse(read('tauri/src-tauri/capabilities/default.json'));
ok(JSON.stringify(defCap.webviews) === '["main"]' && defCap.permissions.includes('allow-rpc'), 'rpc is granted to the MAIN webview only (default.json webviews: [main])');
const caps = fs.readdirSync(path.join(ROOT, 'tauri/src-tauri/capabilities')).filter((f) => f.endsWith('.json'));
ok(caps.every((f) => { const c = JSON.parse(read(`tauri/src-tauri/capabilities/${f}`)); return !(c.webviews || []).some((w) => /board/i.test(w)); }), 'no capability names a board webview (the board guest resolves nothing, incl. rpc)');
ok(/restoreDefaultModel/.test(read('tauri/sidecar/main.mjs')), 'sidecar main.mjs wires restoreDefaultModel');
ok(/restoreDefaultModel|restore_default/.test(read('tauri/src-tauri/src/acl_tests.rs')), 'acl_tests.rs covers restore-default (main only, guests refused)');
ok(/restoreDefaultModel/.test(read('src/main/preload.js')) && /model-default/.test(read('src/renderer/index.html')), 'preload + renderer carry the restore button');

// ---- 6. negative (0.3.0-alpha.11): the wardrobe surface is gone ----
ok(caps.join() === 'default.json', 'capabilities: only default.json (no wardrobe guest capability)', caps.join());
ok(!inventory.apis.some((a) => /wardrobe/i.test(a.name) || /^wardrobe:/.test(a.channel || '') || a.name.startsWith('zumiHost.')), 'inventory: no wardrobe / zumiHost name or channel');
ok(guestOnlyMethodNames(inventory).length === 0, 'inventory: no guest-only (bridge) name is left');
ok(!/wardrobe|zumiHost/.test(alRs.replace(/^\/\/.*$/gm, '')), 'generated allow-list: no wardrobe / zumiHost entry');
const sidecar = read('tauri/sidecar/main.mjs');
ok(!/'wardrobe\.|'zumiHost\.|createWardrobe|wardrobeBlocked/.test(sidecar), 'sidecar main.mjs: no wardrobe handler, host or block');
ok(!fs.existsSync(path.join(ROOT, 'tauri/sidecar/wardrobe-host.mjs')), 'tauri/sidecar/wardrobe-host.mjs is gone');
const html = read('src/renderer/index.html');
ok(!/data-tab="wardrobe"|id="tab-wardrobe"|id="wardrobe-/.test(html), 'index.html: no Wardrobe tab, panel, undo button or check row');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
