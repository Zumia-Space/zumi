// T-31 Tauri parity step 3 check: the renderer boot path is answered by the sidecar with Electron's shapes.
// Plain Node: no Electron, no Tauri, no window, no network. Nothing is launched.
//
//   node scripts/check-tauri-boot.mjs
//
// How parity is shown: the ORIGINAL Electron code is cut out of src/main/main.js (scripts/lib/electron-source.mjs)
// and run in a vm with fixtures, then compared with the sidecar's reply for the same fixtures (URLs re-homed from
// `app://zumi/` onto the Tauri origin, the one intended difference). listModels is compared with a golden file taken
// from main.js BEFORE its extraction into src/main/models-core.js.
//   1. the boot path in the renderer source is what BOOT-TRACE-static.md says, and every awaited name is answered
//   2. models / clips / rooms / talk.status / prefs reads / ai.provider / gcache: parity vs the Electron code
//   3. scenes / chairs: real modules, URLs servable from the assembled ui/ folder
//   4. over the real stdio protocol: the six awaited names answer
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { createBootReads } from '../tauri/sidecar/boot-reads.mjs';
import { APP_ORIGIN, appUrls, createModels } from '../tauri/sidecar/adapters.mjs';
import { sidecarHandlerNames } from './check-tauri-coverage.mjs';
import { constSource, evaluate, functionSource, handlerSource } from './lib/electron-source.mjs';
import { voicePrefsOf } from '../src/main/talk-voice-core.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const BS = String.fromCharCode(92);
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
// JSON-compare after a round trip (drops the vm realm, key order matters on purpose) with Windows paths unified.
const norm = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'string' ? x.split(BS).join('/') : x));
const same = (a, b) => norm(a) === norm(b);

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(TMP_ROOT, 'boot-'));
const mainSrc = read('src', 'main', 'main.js');
const handlerNames = new Set(sidecarHandlerNames(read('tauri', 'sidecar', 'main.mjs')));

// A sidecar-side settings store over <dataDir>/settings.json (what main.mjs wires from adapters.mjs).
function stores(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const set = (patch) => { fs.mkdirSync(dataDir, { recursive: true }); const next = { ...get(), ...patch }; fs.writeFileSync(file, JSON.stringify(next)); return next; };
  return { get, set };
}
const freshDir = (name, initial = null) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  if (initial) fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(initial));
  return d;
};

// ---------------------------------------------------------------- 1. the boot path
{
  const app = read('src', 'renderer', 'app.js');
  const talkIdx = read('src', 'renderer', 'talk', 'index.js');
  const trace = fs.existsSync(path.join(ROOT, 'docs', 'migration', 'BOOT-TRACE-static.md')) ? read('docs', 'migration', 'BOOT-TRACE-static.md') : '';

  // The names app.js awaits with no catch before the first frame (line numbers are in the trace doc).
  ok(/await zumi\.info\(\)/.test(app) && /await zumi\.ui\.getLang\(\)/.test(app), 'renderer still awaits info + ui.getLang first (trace step 1-2)');
  ok(/Promise\.all\(\[zumi\.listModels\(\), zumi\.listClips\(\), Catalog\.load\([^)]*\), zumi\.rooms\.list\(\)\]\)/.test(app), 'renderer still awaits listModels, listClips, rooms.list together (trace step 3)');
  ok(/await zumi\.talk\.status\(\)/.test(talkIdx) && /await createTalk\(/.test(app), 'createTalk still awaits talk.status before the avatar loads (trace step 6)');
  ok(/try \{ sceneList = await zumi\.scenes\.list\(\)/.test(app) && /try \{ chairList = await zumi\.chairs\.list\(\)/.test(app), 'scenes.list and chairs.list are awaited inside try/catch (trace steps 4-5)');
  ok(/if \(!info\.selftest && defaultModel\) switchModel\(defaultModel\)/.test(app), 'the avatar load (switchModel) runs after all of the above, at the end of main() (trace step 9)');

  const AWAITED = ['info', 'ui.getLang', 'listModels', 'listClips', 'rooms.list', 'talk.status'];
  const PORTED = [...AWAITED, 'scenes.list', 'scenes.select', 'chairs.list', 'chairs.select', 'ai.provider',
    'talk.getVoiceEnabled', 'talk.getThinkSound', 'talk.getSpeakTypedWhenMicOff', 'talk.getVoicePrefs',
    'ui.getDevTools', 'ui.getSendClientNames', 'ui.setSendClientNames', 'ui.getLookTuning', 'ui.setLookTuning', 'gcache.load', 'gcache.save',
    'board.status', 'update.status', 'roles.get'];
  for (const n of AWAITED) ok(handlerNames.has(n), `awaited boot name ${n} has a sidecar handler`);
  ok(PORTED.every((n) => handlerNames.has(n)), 'every boot-path name this step answers is in the handler table', PORTED.filter((n) => !handlerNames.has(n)).join(', '));
  for (const n of ['talk.ledaInfo']) {
    ok(!handlerNames.has(n), `${n} (needs a later increment) is not faked`);
  }
  // Step 9-1 landed the HUD host: its boot read is a real handler now, not a boot-time answer.
  ok(handlerNames.has('hud.getPrefs'), 'hud.getPrefs is a real step-9 handler now');
  // Step 8b: the voice card's fire-and-forget reads are real handlers now (cloud providers only in part 1).
  ok(handlerNames.has('talk.voiceInfo') && handlerNames.has('talk.voiceState') && handlerNames.has('talk.voiceProviders'),
    'talk.voiceInfo, talk.voiceState and talk.voiceProviders are real step-8b handlers now');
  // Step 6 landed these two: they are real handlers now, not faked boot answers.
  ok(handlerNames.has('talk.brainInfo') && handlerNames.has('roles.models'), 'talk.brainInfo and roles.models are real step-6 handlers now');
  ok(trace.includes('static, to be confirmed by the spare-PC trace'), 'BOOT-TRACE-static.md is marked "static, to be confirmed by the spare-PC trace"');
  ok(PORTED.filter((n) => !['board.status', 'update.status', 'roles.get'].includes(n)).every((n) => trace.includes('`' + n + '`')), 'the trace names every ported boot method');
  ok(AWAITED.every((n) => trace.includes('`' + n + '`')), 'the trace names every awaited boot method');
}

// ---------------------------------------------------------------- 2a. models: golden from the pre-extraction main.js
{
  const golden = JSON.parse(read('scripts', 'fixtures', 'tauri-boot', 'models.golden.json'));
  const root = path.join(tmp, 'models-fixture');
  const modelsDir = path.join(root, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  const put = (rel, bytes) => { const f = path.join(root, rel); fs.writeFileSync(f, Buffer.alloc(bytes, 1)); fs.utimesSync(f, new Date(1700000000000), new Date(1700000000000)); };
  put('models/a.vrm', 111); put('models/b.vrm', 222); put('user.vrm', 333); put('test.vrm', 444);
  fs.writeFileSync(path.join(modelsDir, 'models.json'), JSON.stringify({ models: [{ id: 'a', label: 'Alpha', file: 'a.vrm', default: true }, { id: 'b', label: 'Beta', file: 'b.vrm' }, { id: 'user', file: 'a.vrm' }, { file: '../evil.vrm' }, { id: 'missing', file: 'zz.vrm' }, { id: 'a', file: 'b.vrm' }] }));
  const withRoot = (v) => JSON.parse(JSON.stringify(v).split('<ROOT>').join(root.split(BS).join('/')));
  const settingsFor = {
    fresh: {}, picked: { model: 'b' }, testModel: { model: 'b' },
    userModel: { model: 'user', userModelPath: path.join(root, 'user.vrm') },
    badPick: { model: 'nope', userModelPath: path.join(root, 'nothing.vrm') },
  };
  for (const [name, golden0] of Object.entries(golden.cases)) {
    // the golden predates Electron 75687b0; 0.3.0-alpha.11 removed that commit's only new field (wardrobeBlocked) again
    const expected = golden0;
    const settings = settingsFor[name];
    // models-core.js with Electron's prefix and test model: exactly the pre-extraction Electron answer
    const core = createModels({ modelsDir, loadSettings: () => settings, getTestModelPath: () => (name === 'testModel' ? path.join(root, 'test.vrm') : null) });
    ok(same(core.listModels(), withRoot(expected)), `models-core.js == pre-extraction main.js listModels (${name})`);
    if (name === 'testModel') continue; // the sidecar has no --model flag, so it never has a test slot
    const dataDir = freshDir(`models-${name}`);
    const st = stores(dataDir); st.set(settings);
    const boot = createBootReads({ dataDir, settings: st.get, saveSettings: st.set, dirs: { models: modelsDir } });
    ok(same(boot.listModels(), appUrls(withRoot(expected))), `sidecar listModels == Electron shape, URLs on ${APP_ORIGIN} (${name})`);
  }
  ok(/require\('\.\/models-core\.js'\)/.test(mainSrc) && !/^function readManifest\(/m.test(mainSrc) && !/^function listModels\(/m.test(mainSrc), 'main.js takes listModels from models-core.js (one implementation for both hosts)');
  const repoBoot = createBootReads({ dataDir: freshDir('models-repo'), settings: () => ({}), saveSettings: () => {} });
  const repoList = repoBoot.listModels();
  ok(Array.isArray(repoList.models) && repoList.selected === (repoList.models.find((m) => m.isDefault) || { id: null }).id, 'the repo\'s own assets/models answers (default selected, or null when none is bundled)');
}

// ---------------------------------------------------------------- 2b. clips: the original listClips
{
  const clipsDir = path.join(tmp, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });
  for (const f of ['sit-idle.vrma', 'wave.fbx', 'README.txt', 'bad name.vrma', 'dup.vrma', 'dup.fbx']) fs.writeFileSync(path.join(clipsDir, f), 'x');
  const { ctx } = evaluate([functionSource(mainSrc, 'listClips')], { fs, path, CLIPS_DIR: clipsDir, extraClipsDir: null });
  const electron = ctx.listClips();
  const boot = createBootReads({ dataDir: freshDir('clips'), settings: () => ({}), saveSettings: () => {}, dirs: { clips: clipsDir } });
  ok(electron.length >= 2 && same(boot.listClips(), appUrls(electron)), 'sidecar listClips == Electron listClips (same names, order, URLs re-homed)');
  const repoClips = createBootReads({ dataDir: freshDir('clips-repo'), settings: () => ({}), saveSettings: () => {} }).listClips();
  ok(repoClips.some((c) => c.name === 'sit-idle') && repoClips.every((c) => c.url.startsWith(`${APP_ORIGIN}/clips/`)), 'the repo clips list (sit-idle, sit-work) with Tauri-origin URLs');
}

// ---------------------------------------------------------------- 2c. rooms: the original listRooms
{
  const roomsSrc = functionSource(mainSrc, 'listRooms');
  const { createDefaultRoomV2Cache, ensureDefaultRoomV2Copy, resolveRoomLaunch } = await import('../tauri/sidecar/adapters.mjs');
  const v2Json = path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json');
  const cases = { fresh: {}, selectedV2: { room: 'default-v2' }, none: { room: 'none' }, staleId: { room: 'gone' }, v1Stored: { room: 'default' } };
  for (const [name, initial] of Object.entries(cases)) {
    // Electron side: listRooms() from main.js, deps injected. The v1 default room is unavailable (see boot-reads.mjs).
    const eDir = freshDir(`rooms-e-${name}`, initial);
    const eSt = stores(eDir);
    const cache = createDefaultRoomV2Cache();
    const defaultRoomV2Dir = (sha) => path.join(eDir, 'rooms', 'default-v2', sha);
    const { ctx } = evaluate([roomsSrc], {
      fs, path, loadSettings: eSt.get, saveSettings: eSt.set, roomDefaultPath: () => null, defaultRoomDir: () => null, defaultRoomCacheObj: {},
      ensureDefaultRoomCopyFn: () => ({ sha: null, refused: null }), readRoomManifest: () => null, roomsStoreDir: () => path.join(eDir, 'rooms'),
      ensureDefaultRoomV2CopyFn: ensureDefaultRoomV2Copy, getDefaultRoomV2: () => Promise.resolve(ensureDefaultRoomV2Copy(cache, v2Json, defaultRoomV2Dir, eSt)),
      defaultRoomV2Dir, resolveRoomLaunchFn: resolveRoomLaunch, roomEntry: () => { throw new Error('v1 rooms are not offered in this fixture'); },
    });
    const electron = await ctx.listRooms();
    const sDir = freshDir(`rooms-s-${name}`, initial);
    const sSt = stores(sDir);
    const boot = createBootReads({ dataDir: sDir, settings: sSt.get, saveSettings: sSt.set });
    const sidecar = await boot.listRooms();
    ok(same(sidecar, appUrls(electron)), `sidecar rooms.list == Electron listRooms (${name})`, norm(sidecar).slice(0, 300));
    ok(same(eSt.get(), sSt.get()), `...and persists the same settings (${name}: room, defaultRoomV2GoodSha)`, norm(sSt.get()));
    if (name === 'fresh') {
      ok(sidecar.rooms.length === 1 && sidecar.rooms[0].id === 'default-v2' && sidecar.selected === 'default-v2' && sSt.get().room === 'default-v2', 'fresh preview: the pinned v2 room is listed and auto-selected + persisted once (0.2.8; v1 default unavailable)');
      const sha = sSt.get().defaultRoomV2GoodSha;
      ok(Boolean(sha) && fs.existsSync(path.join(sDir, 'rooms', 'default-v2', sha, 'room.json')), 'the validated room copy lives under the preview data dir (never Electron userData)');
    }
  }
  const roomsOut = JSON.parse(JSON.stringify(await createBootReads({ dataDir: freshDir('rooms-shape'), settings: stores(freshDir('rooms-shape2')).get, saveSettings: () => {} }).listRooms()));
  ok(Object.keys(roomsOut).join() === 'rooms,selected', 'rooms.list keys are { rooms, selected } (Electron order; defaultRoomIssue went with room v1)');
}

// ---------------------------------------------------------------- 2d. talk.status, prefs reads, ai.provider, look tuning, gcache
{
  const { createCloud, providers } = await import('../tauri/sidecar/adapters.mjs');
  const dataDir = freshDir('prefs');
  const st = stores(dataDir);
  const boot = createBootReads({ dataDir, settings: st.get, saveSettings: st.set });
  const fromAppPage = () => true;
  const app = { isPackaged: true, getPath: () => dataDir };
  const prov = require('../src/main/providers.js');

  // talk:status with no chat key (chatBrain null) and the release cloud config
  {
    const cloud = createCloud({ mode: 'auto', base: null });
    const { ipc } = evaluate([handlerSource(mainSrc, 'talk:status')], { fromAppPage, chatBrain: null, cloud });
    ok(same(boot.talkStatus(), ipc['talk:status']({})), 'talk.status == Electron talk:status (no key, no talk server)', norm(boot.talkStatus()));
    ok(boot.talkStatus().enabled === false && boot.talkStatus().mode === 'off', 'talk.status says off, honestly (no key store exists yet)');
  }

  // one-line settings reads
  const settingsCases = [{}, { voiceEnabled: false, thinkSound: true, speakTypedWhenMicOff: false, voiceSpeed: 9, voiceVolume: -2, sendClientNamesToAi: true }, { voiceSpeed: 0.8, voiceVolume: 0.25, thinkSound: 'yes' },
    { voiceProviderEn: 'gemini', voiceProviderVi: 'zumia-owner', voiceReplyLang: 'vi', voiceGemini: { voice: 'Kore' }, voiceProviderVi2: 1 }];
  const channels = ['talk:getVoiceEnabled', 'talk:getThinkSound', 'talk:getSpeakTypedWhenMicOff', 'talk:getVoicePrefs', 'ui:get-send-client-names'];
  const bootFor = { 'talk:getVoiceEnabled': 'getVoiceEnabled', 'talk:getThinkSound': 'getThinkSound', 'talk:getSpeakTypedWhenMicOff': 'getSpeakTypedWhenMicOff', 'talk:getVoicePrefs': 'getVoicePrefs', 'ui:get-send-client-names': 'getSendClientNames' };
  // Step 8b: voicePrefs moved into src/main/talk-voice-core.mjs (the freeze exception), so the Electron side of this
  // comparison is that module's own function with the same settings (the old inline copy would be a second source).
  const plain = channels.filter((c) => c !== 'talk:getVoicePrefs');
  for (const [i, s] of settingsCases.entries()) {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(s));
    const { ipc } = evaluate(plain.map((c) => handlerSource(mainSrc, c)), { fromAppPage, loadSettings: st.get });
    ok(same(boot.getVoicePrefs(), voicePrefsOf(s, false)), `talk:getVoicePrefs == Electron's extracted voicePrefsOf (settings case ${i})`, `${norm(boot.getVoicePrefs())} vs ${norm(voicePrefsOf(s, false))}`);
    for (const c of plain) ok(same(boot[bootFor[c]](), ipc[c]({})), `${c} == sidecar (settings case ${i})`, `${norm(boot[bootFor[c]]())} vs ${norm(ipc[c]({}))}`);
  }

  // ai.provider / ai.setMode / ai.setProvider: parity vs main.js lives in scripts/check-tauri-ai-settings.mjs (step 6).

  // setSendClientNames + look tuning (dev-gated) + gesture cache: Electron handlers vs sidecar on separate files
  {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), '{}');
    const eDir = freshDir('prefs-e');
    const eSt = stores(eDir);
    const lookFile = path.join(eDir, 'look-tuning.json');
    const cacheFile = path.join(eDir, 'gesture-cache', 'cache.json');
    const { ipc } = evaluate([
      'function lookTuningPath() { return LOOK; }', 'function gestureCacheFile() { return CACHE; }',
      handlerSource(mainSrc, 'ui:set-send-client-names'), handlerSource(mainSrc, 'ui:get-look-tuning'), handlerSource(mainSrc, 'ui:set-look-tuning'),
      handlerSource(mainSrc, 'gcache:load'), handlerSource(mainSrc, 'gcache:save'),
    ], { fromAppPage, loadSettings: eSt.get, saveSettings: eSt.set, app, fs, path, LOOK: lookFile, CACHE: cacheFile });

    ok(boot.setSendClientNames(1) === ipc['ui:set-send-client-names']({}, 1) && boot.setSendClientNames(true) === ipc['ui:set-send-client-names']({}, true) && st.get().sendClientNamesToAi === true && eSt.get().sendClientNamesToAi === true,
      'ui.setSendClientNames: only `true` stores true, and it persists (Electron parity)');
    ok(boot.getLookTuning() === null && ipc['ui:get-look-tuning']({}) === null, 'ui.getLookTuning is null before anything is saved');
    ok(same(boot.setLookTuning({ talk: { fov: 20 } }), ipc['ui:set-look-tuning']({}, { talk: { fov: 20 } })) && boot.setLookTuning({}).error === 'dev_tools_off', 'ui.setLookTuning refuses with dev_tools_off while Developer mode is off (packaged build)');
    st.set({ developerMode: true }); eSt.set({ developerMode: true });
    ok(same(boot.setLookTuning(null), ipc['ui:set-look-tuning']({}, null)) && boot.setLookTuning(null).error === 'bad_overrides', 'ui.setLookTuning rejects a non-object with bad_overrides');
    const tuning = { talk: { fov: 21, grade: { exposure: 1.1 } } };
    ok(same(boot.setLookTuning(tuning), ipc['ui:set-look-tuning']({}, tuning)) && boot.setLookTuning(tuning).ok === true, 'ui.setLookTuning stores with Developer mode on');
    ok(same(boot.getLookTuning(), ipc['ui:get-look-tuning']({})) && same(boot.getLookTuning(), tuning), 'ui.getLookTuning reads it back, equal to Electron\'s read of the same content');
    ok(fs.existsSync(path.join(dataDir, 'look-tuning.json')), 'look-tuning.json lives in the preview data dir');

    ok(boot.gcacheLoad() === null && ipc['gcache:load']({}) === null, 'gcache.load is null before a save');
    const text = JSON.stringify({ v: 1, entries: ['é'] });
    ok(boot.gcacheSave(text) === ipc['gcache:save']({}, text) && boot.gcacheSave(text) === true, 'gcache.save stores text and answers true');
    ok(boot.gcacheLoad() === text && ipc['gcache:load']({}) === text, 'gcache.load returns exactly the saved text');
    ok(boot.gcacheSave(5) === false && boot.gcacheSave('x'.repeat(2_500_001)) === false && ipc['gcache:save']({}, 5) === false, 'gcache.save refuses a non-string or an oversize payload');
    ok(fs.existsSync(path.join(dataDir, 'gesture-cache', 'cache.json')), 'the gesture cache lives in the preview data dir');
  }
  ok(providers && typeof providers.resolveMode === 'function', 'sanity: providers.js loaded through the adapter');
}

// ---------------------------------------------------------------- 3. scenes / chairs and servable URLs
{
  const dataDir = freshDir('scenes-chairs');
  const st = stores(dataDir);
  const boot = createBootReads({ dataDir, settings: st.get, saveSettings: st.set });
  const scenes = boot.listScenes();
  ok(Object.keys(scenes).join() === 'selected,geometry,rooms,error' && scenes.selected === 'current' && Array.isArray(scenes.rooms) && scenes.rooms.length === 0 && scenes.error === null,
    'scenes.list: { selected, geometry, rooms, error } - "current" and no video rooms without the videos folder (release-build answer)');
  ok(boot.selectScene('current').selected === 'current' && boot.selectScene('ghost').selected === 'current', 'scenes.select ignores an unknown id');

  const chairs = boot.listChairs();
  ok(Object.keys(chairs).join() === 'selected,noChairPlateUrl,hideOccluders,chairs,error' && chairs.error === null && chairs.chairs.length >= 1, 'chairs.list: { selected, noChairPlateUrl, hideOccluders, chairs, error } with the manifest\'s chairs');
  ok(chairs.chairs.every((c) => c.url === `${APP_ORIGIN}/chair3d/${c.id}.glb` && c.seat && typeof c.reclineDeg === 'number'), 'every chair has its Tauri-origin URL, seat and reclineDeg');
  ok(boot.selectChair('painted').selected === 'painted' && st.get().chair3d === 'painted' && boot.selectChair('ghost').selected === 'painted', 'chairs.select persists a real pick and ignores an unknown id');

  // Every URL the boot reads hand out must exist in the assembled ui/ folder (prep-ui lays files out at the URL path).
  const ui = path.join(tmp, 'ui');
  const prep = await new Promise((resolve) => { const c = spawn(process.execPath, [path.join(ROOT, 'tauri', 'prep-ui.mjs'), '--out', ui], { cwd: ROOT, stdio: 'pipe' }); c.on('close', resolve); });
  ok(prep === 0, 'tauri/prep-ui.mjs assembles a scratch ui/ folder');
  const roomsNow = await createBootReads({ dataDir: freshDir('servable'), settings: stores(freshDir('servable2')).get, saveSettings: () => {} }).listRooms();
  const urls = [
    ...boot.listClips().map((c) => c.url), ...chairs.chairs.map((c) => c.url), chairs.noChairPlateUrl,
    ...createBootReads({ dataDir: freshDir('servable3'), settings: () => ({}), saveSettings: () => {} }).listModels().models.filter((m) => m.source === 'bundled').map((m) => m.url),
    ...roomsNow.rooms.map((r) => r.url),
  ];
  const missing = urls.filter((u) => !u.startsWith(`${APP_ORIGIN}/`) || !fs.existsSync(path.join(ui, decodeURIComponent(u.slice(APP_ORIGIN.length + 1).split('?')[0]))));
  ok(urls.length >= 7 && missing.length === 0, `every bundled URL (${urls.length}) resolves to a file in the assembled ui/ folder`, missing.join(', '));
  const room = JSON.parse(fs.readFileSync(path.join(ui, 'rooms', 'default-v2', 'room.json'), 'utf8'));
  const plates = Object.values(room.views || {}).map((v) => v && v.plate).filter(Boolean);
  ok(plates.length >= 1 && plates.every((p) => fs.existsSync(path.join(ui, 'rooms', 'default-v2', p))), 'the v2 room\'s plates are served from ui/rooms/default-v2 (renderer resolves them against room.json)');
}

// ---------------------------------------------------------------- 4. the Tauri origin is the one the Rust guard allows
{
  const guard = read('tauri', 'src-tauri', 'src', 'guest_guard.rs');
  const host = new URL(APP_ORIGIN);
  ok(host.protocol === 'http:' && host.port === '' && guard.includes(`"${host.hostname}"`), `APP_ORIGIN (${APP_ORIGIN}) is the app host main_guard_blocks allows`);
  ok(!/useHttpsScheme/.test(read('tauri', 'src-tauri', 'tauri.conf.json')), 'tauri.conf.json leaves useHttpsScheme unset (http scheme on Windows)');
}

// ---------------------------------------------------------------- 5. over the real stdio protocol
{
  const dataDir = freshDir('stdio');
  const child = spawn(process.execPath, [path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), '--data-dir', dataDir, '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  rl.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve(); else if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const request = (method, params = []) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  await ready;
  const answers = {};
  for (const n of ['info', 'ui.getLang', 'listModels', 'listClips', 'rooms.list', 'talk.status', 'scenes.list', 'chairs.list', 'ai.provider', 'talk.getVoicePrefs', 'ui.getLookTuning', 'gcache.load']) answers[n] = await request(n);
  ok(['info', 'ui.getLang', 'listModels', 'listClips', 'rooms.list', 'talk.status'].every((n) => answers[n].result !== undefined && !answers[n].error), 'the six awaited boot names answer over stdio with no error');
  ok(Object.entries(answers).every(([, a]) => !a.error), 'every ported boot name answers over stdio', Object.entries(answers).filter(([, a]) => a.error).map(([n, a]) => `${n}: ${a.error.message}`).join('; '));
  ok(answers.listModels.result.models && answers['rooms.list'].result.rooms.map((r) => r.id).join() === 'default-v2' && answers['talk.status'].result.enabled === false, 'stdio replies carry the expected shapes (rooms: only the pinned v2; room v1 removed, owner 2026-10-26)');
  const setMode = await request('ai.setMode', ['byok']);
  ok(setMode.result && setMode.result.ok === true && setMode.result.mode === 'byok', 'ai.setMode answers over stdio (step 6, local settings write)');
  ok((await request('ai.provider')).result.mode === 'byok', 'ai.provider reads the mode ai.setMode just saved');
  // Electron's null-host answer (main.js:1438 hudHost null -> true); a rejection here was an unhandled promise rejection
  // (app.js:887) and a dead HUD (hud.js:445) in the probe's boot trace.
  const hudReady = await request('hud.ready');
  ok(hudReady.result === true && !hudReady.error, 'hud.ready answers true (Electron main.js:1438, no HUD host)');
  // 0.3.0-alpha.11: the wardrobe is gone, so its names are unknown methods over stdio (the renderer no longer calls them).
  for (const m of ['wardrobe.canUndo', 'wardrobe.open', 'zumiHost.apply']) {
    const r = await request(m);
    ok(r.result === undefined && r.error, `${m} is an unknown sidecar method`, JSON.stringify(r));
  }
  const keyStatus = await request('brainKey.status');
  ok(keyStatus.result && keyStatus.result.saved === false && keyStatus.result.last4 === null && Object.keys(keyStatus.result).join() === 'provider,saved,last4,checked,encryption', 'brainKey.status answers over stdio with { provider, saved, last4, checked, encryption } and no key');
  ok(!/jev-key|api[-_ ]?key|secret/i.test(stderr), 'sidecar stderr carries no key material');
  const tree = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else tree.push(path.relative(dataDir, p).split(BS).join('/')); } })(dataDir);
  ok(tree.includes('settings.json') && tree.some((f) => /^rooms\/default-v2\/[0-9a-f]+\/room\.json$/.test(f)), 'the only writes landed in the --data-dir (settings.json + the validated room copy)', tree.join(', '));
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
}

// ---------------------------------------------------------------- 5. test-only model slot (box trace: no model ships)
{
  const { parseTestModel } = await import(pathToFileURL(path.join(ROOT, 'tauri', 'sidecar', 'main.mjs')).href);
  const abs = path.join(tmp, 'tm', 'avatar.vrm');
  ok(parseTestModel(['--data-dir', tmp, '--test-model', abs]) === abs, 'parseTestModel accepts an absolute .vrm');
  ok(parseTestModel(['--test-model', 'rel/avatar.vrm']) === null && parseTestModel(['--test-model', path.join(tmp, 'a.glb')]) === null
    && parseTestModel(['--data-dir', tmp]) === null && parseTestModel(['--test-model']) === null, 'parseTestModel ignores relative paths, non-.vrm files and a missing value');
  const savedEnv = process.env.ZUMI_TEST_MODEL; process.env.ZUMI_TEST_MODEL = abs;
  ok(parseTestModel(['--data-dir', tmp]) === null, 'the environment variable alone never enables the slot (argv only)');
  if (savedEnv === undefined) delete process.env.ZUMI_TEST_MODEL; else process.env.ZUMI_TEST_MODEL = savedEnv;
  fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, Buffer.alloc(123, 1));
  const dataDir = freshDir('testmodel'); const st = stores(dataDir);
  const none = createBootReads({ dataDir, settings: st.get, saveSettings: st.set }).listModels();
  ok(!none.models.some((m) => m.id === 'test') && none.selected !== 'test', 'without --test-model the model list has no test slot');
  const withTest = createBootReads({ dataDir, settings: st.get, saveSettings: st.set, testModelPath: abs }).listModels();
  const slot = withTest.models.find((m) => m.id === 'test');
  ok(slot && /^http:\/\/tauri\.localhost\/external\/test\.vrm\?v=/.test(slot.url) && withTest.selected === 'test', 'with a test model the list carries a selected `test` slot at /external/test.vrm', JSON.stringify(withTest));
  ok(!st.get().userModelPath && st.get().model !== 'test', 'the test model is never persisted to settings');
  const cargo = read('tauri', 'src-tauri', 'Cargo.toml'); const libRs = read('tauri', 'src-tauri', 'src', 'lib.rs');
  ok(!/test-model/.test(cargo), 'there is no test-model cargo feature: the avatar switch is Electron\'s --model / ZUMI_TEST_MODEL in every build');
  ok(!/#\[cfg\(feature = "test-model"\)\]/.test(libRs),
    'the avatar switch is NOT behind a cargo feature: every build honours --model / ZUMI_TEST_MODEL, like Electron');
  const testModelRs = read('tauri', 'src-tauri', 'src', 'test_model.rs');
  ok(/fn from_args/.test(testModelRs) && /test_model::init\(&argv\)/.test(libRs) && /ENV_VAR/.test(testModelRs),
    'the host resolves --model <file> then ZUMI_TEST_MODEL once at start (Electron precedence)');
  ok(!/ZUMI_TEST_MODEL/.test(read('tauri', 'sidecar', 'main.mjs').replace(/\/\/[^\n]*/g, '')),
    'the sidecar code never reads ZUMI_TEST_MODEL (the host hands it --test-model)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
void os;
process.exit(fail ? 1 : 0);
