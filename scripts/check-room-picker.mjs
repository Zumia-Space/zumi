// Video rooms / room picker (T-31 room picker, 13-10): plain-Node checks, no Electron.
//   node scripts/check-room-picker.mjs
// 1. rooms.json schema (the real manifest passes; broken copies are refused, every error named)
// 2. the default is the current painted room (fresh settings, unknown/stale pick, no video folder, release build)
// 3. a pick persists across a restart (a new instance reading the same settings file) and a bad pick is ignored
// 4. no video edge in any talk crop window: every room's framing covers the crop at every window aspect 0.8-3.0 and at
//    1280x720, 1920x1080 and the default/min windows' stage; the identity framing (no fix) must FAIL, so the check bites
// 5. layer order: the video is drawn into #stage-plate (the plate's own canvas, before #stage-canvas in the DOM, no
//    z-index on either), through CameraDirector.drawPlate, with the plate's crop window; the chair is drawn after it
// 5b. qc-021 ROOM-CROP: SceneVideo draws the painted cut-out only while drawChair is set, and app.js's applyChair lets the
//     3D chair attach under a video room and clears drawChair whenever a 3D chair is on (box: electron-room-picker.cjs)
// 6. the packaged files match the manifest (videos at localDir, chair cut-out), and the owner build packs the videos
//    inside the NSIS app archive -- SKIP when the folder is absent
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ownerPath } from './lib/owner-paths.mjs';
import { checkScenesManifest, createSceneRooms, resolveSelectedScene, DEFAULT_SCENE } from '../src/main/scene-rooms.mjs';
import { sceneVideoRect, plateRectToCanvas, rectCovers, SceneVideo } from '../src/renderer/room/scene-video.js';
import { CameraDirector, CHEST_UP, coverCropRect } from '../src/renderer/room/camera-director.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'assets', 'rooms-video', 'rooms.json');
let pass = 0, fail = 0, skip = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

// ---- 1. schema ----
ok(checkScenesManifest(man).ok, 'manifest: the shipped rooms.json passes the schema', JSON.stringify(checkScenesManifest(man).errors));
ok(man.rooms.length === 7, 'manifest: 7 rooms', man.rooms.length);
ok(man.rooms.every((r) => /^[A-Z][A-Za-z -]{2,30}$/.test(r.label)), 'manifest: short English names', man.rooms.map((r) => r.label).join(', '));
// One room = one video: the manifest is what the owner build packs (extraResources filter) and what the picker resolves
// by id, so two entries sharing a file would ship one room twice and hide the other's missing clip.
const dupFiles = man.rooms.map((r) => r.file).filter((f, i, a) => a.indexOf(f) !== i);
ok(dupFiles.length === 0, 'manifest: every room has its own video file', dupFiles.join(', '));
const broken = (mut) => { const m = structuredClone(man); mut(m); return checkScenesManifest(m); };
for (const [name, mut, want] of [
  ['missing sha256', (m) => { delete m.rooms[0].sha256; }, /sha256/],
  ['duplicate id', (m) => { m.rooms[1].id = m.rooms[0].id; }, /duplicate/],
  ["id 'current'", (m) => { m.rooms[0].id = 'current'; }, /slug other than 'current'/],
  ['scale below 1', (m) => { m.rooms[0].framing.scale = 0.9; }, /framing/],
  ['path in file name', (m) => { m.rooms[0].file = '../x.mp4'; }, /file/],
  ['bad status', (m) => { m.rooms[0].status = 'maybe'; }, /status/],
  ['missing pivot', (m) => { delete m.pivot; }, /pivot/],
  ['wrong view', (m) => { m.view = 'work'; }, /view/],
]) {
  const r = broken(mut);
  ok(!r.ok && r.errors.some((e) => want.test(e)), `manifest refused: ${name}`, JSON.stringify(r.errors));
}

// ---- 2 + 3. default + persistence (a scratch userData-like folder, real files) ----
const scratch = path.join(ROOT, '.room-picker-check-tmp'); // inside the tree (gitignored), never the system temp on C:
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch);
const vids = path.join(scratch, 'videos');
fs.mkdirSync(vids);
// Small stand-in files whose bytes/sha256 the scratch manifest records (the real 29 MB set is checked in part 6).
const fakeMan = structuredClone(man);
for (const r of fakeMan.rooms) { const buf = Buffer.from(`video ${r.id}`); fs.writeFileSync(path.join(vids, r.file), buf); r.bytes = buf.length; r.sha256 = crypto.createHash('sha256').update(buf).digest('hex'); }
const manDir = path.join(scratch, 'assets');
fs.mkdirSync(manDir);
fs.writeFileSync(path.join(manDir, 'rooms.json'), JSON.stringify(fakeMan));
fs.copyFileSync(path.join(ROOT, 'assets', 'rooms-video', man.chair.file), path.join(manDir, man.chair.file));
const settingsFile = path.join(scratch, 'settings.json');
const store = {
  get: () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } },
  set: (patch) => fs.writeFileSync(settingsFile, JSON.stringify({ ...store.get(), ...patch })),
};
const open = (dir = vids) => createSceneRooms({ manifestPath: path.join(manDir, 'rooms.json'), resolveVideoDir: () => dir, settings: store });

ok(DEFAULT_SCENE === 'current', "default id is 'current'");
let list = open().list();
// Owner 03-11: the 7 approved rooms are the built-in rooms and a fresh install opens in the beach cabin he uses (manifest `default`).
ok(man.default === 'beach-cabin' && checkScenesManifest(man).ok, "the manifest's start room is beach-cabin, and the schema accepts it");
ok(list.selected === 'beach-cabin', 'default: a fresh install with the videos shows the beach cabin', list.selected);
ok(list.rooms.length === 7 && list.rooms.every((r) => r.url === `app://zumi/scenes/${r.id}.mp4`), 'list: 7 rooms with app:// urls', list.rooms.length);
ok(!('sceneRoom' in store.get()), 'default: listing never writes the setting');
ok(resolveSelectedScene('no-such-room', ['cozy-study']) === 'current', 'default: an unknown pick with no manifest default falls back to current');
ok(resolveSelectedScene('no-such-room', ['cozy-study', 'beach-cabin'], 'beach-cabin') === 'beach-cabin', 'default: an unknown pick falls back to the listed manifest default');
ok(resolveSelectedScene('current', ['beach-cabin'], 'beach-cabin') === 'current', "default: an explicit 'current' pick stays (the user chose no video)");
ok(resolveSelectedScene(undefined, ['cozy-study'], 'beach-cabin') === 'current', 'default: a default whose video is not on disk -> current');
ok(resolveSelectedScene(undefined, []) === 'current', 'default: nothing stored, nothing on disk -> current');
ok(!checkScenesManifest({ ...man, default: 'no-such-room' }).ok, 'schema: a default that names no room is refused');
list = open(null).list();
ok(list.selected === 'current' && list.rooms.length === 0, 'release build (no video folder): no rooms, current room', JSON.stringify(list.rooms));

list = open().select('beach-cabin');
ok(list.selected === 'beach-cabin' && store.get().sceneRoom === 'beach-cabin', 'persist: a pick is written to settings.json', JSON.stringify(store.get()));
list = open().list(); // a new instance = the app restarted
ok(list.selected === 'beach-cabin', 'persist: the pick survives a restart', list.selected);
list = open().select('../../etc');
ok(list.selected === 'beach-cabin' && store.get().sceneRoom === 'beach-cabin', 'persist: an unknown id is ignored, the old pick stays');
fs.writeFileSync(path.join(vids, fakeMan.rooms[5].file), 'tampered!!!!!!!!!!!!!!'.slice(0, fakeMan.rooms[5].bytes));
list = open().list();
ok(list.selected === 'current' && !list.rooms.some((r) => r.id === 'beach-cabin'), 'a changed video file is dropped and the pick falls back to current', JSON.stringify(list.rooms.map((r) => r.id)));
list = open().select('current');
ok(list.selected === 'current' && store.get().sceneRoom === 'current', "persist: picking 'Current room' back is stored too");
const sr = open();
ok(sr.resolvePath('chair') && sr.resolvePath('cozy-study.mp4') && !sr.resolvePath('../rooms.json') && !sr.resolvePath('nope.mp4'), 'app:// scenes/ resolves exact names only');
fs.rmSync(scratch, { recursive: true, force: true });

// ---- 4. coverage: no visible video edge in any talk crop ----
const [PW, PH] = man.plateSize;
const cropAt = (w, h) => { const c = coverCropRect(PW, PH, w, h, CHEST_UP.zoom, 0, CHEST_UP.biasRight, CHEST_UP.anchor); return c; };
// stage = the window's content minus the left rail (84 px) and the toolbar + composer (~153 px); measured on the
// installed v7 at its default 1280x800 content size (stage 1204x686) -- the min window (900x600) likewise.
const SIZES = [[1280, 720], [1920, 1080], [1204, 686], [816, 447], [2560, 1080], [1000, 1000]];
const aspects = []; for (let a = 0.8; a <= 3.0001; a += 0.01) aspects.push(+a.toFixed(2));
for (const r of man.rooms) {
  const rect = sceneVideoRect(man, r.framing);
  const misses = [];
  for (const a of aspects) { const w = 1200, h = Math.round(1200 / a); if (!rectCovers(rect, cropAt(w, h))) misses.push(a); }
  for (const [w, h] of SIZES) if (!rectCovers(rect, cropAt(w, h))) misses.push(`${w}x${h}`);
  ok(misses.length === 0, `coverage: ${r.id} (scale ${r.framing.scale}, offsetY ${r.framing.offsetY}) shows no edge at any aspect 0.8-3.0 / ${SIZES.map((s) => s.join('x')).join(', ')}`, `misses ${misses.slice(0, 8).join(',')}`);
}
const identity = sceneVideoRect(man, { scale: 1, offsetX: 0, offsetY: 0 });
ok(!rectCovers(identity, cropAt(1280, 720)), 'coverage check bites: the unfixed (identity) framing shows the top edge at 1280x720');
{ // the video pixel that sits on the pivot at identity must still sit on it after any scale (no offset)
  const fx = (man.pivot[0] - man.identity[0]) / man.videoSize[0], fy = (man.pivot[1] - man.identity[1]) / man.videoSize[1];
  const pr = sceneVideoRect(man, { scale: 1.2, offsetX: 0, offsetY: 0 });
  ok(Math.abs(pr.x + fx * pr.w - man.pivot[0]) < 1e-9 && Math.abs(pr.y + fy * pr.h - man.pivot[1]) < 1e-9, 'framing.scale is about the pivot (the horizon row stays put)', JSON.stringify(pr));
}
const toCanvas = plateRectToCanvas({ x: 100, y: 50, w: 200, h: 100 }, { x: 100, y: 50, w: 400, h: 200 }, 800, 400);
ok(toCanvas.x === 0 && toCanvas.y === 0 && toCanvas.w === 400 && toCanvas.h === 200, 'plate -> canvas mapping', JSON.stringify(toCanvas));

// ---- 5. layer order ----
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
const stageBlock = /<div id="stage">([\s\S]*?)<\/div>/.exec(html);
ok(stageBlock && stageBlock[1].indexOf('id="stage-plate"') >= 0 && stageBlock[1].indexOf('id="stage-plate"') < stageBlock[1].indexOf('id="stage-canvas"'), 'z-order: #stage-plate comes before #stage-canvas inside #stage (painted under it)');
ok(!/#stage-(plate|canvas)[^{]*\{[^}]*z-index/.test(css), 'z-order: no z-index on either stage canvas (DOM order decides)');
ok(/id="scene-picker"[\s\S]*?id="scene-select"/.test(html) && html.indexOf('id="scene-picker"') < html.indexOf('<div id="stage">'), 'picker: the Room dropdown sits in the stage toolbar');
{ // CameraDirector draws the video into the PLATE context, after nothing else, with the plate's crop
  const calls = [];
  const plateCtx = { canvas: { width: 1204, height: 686 }, clearRect: () => calls.push('clear'), drawImage: (src) => calls.push(src.tag), set globalAlpha(v) {}, get globalAlpha() { return 1; } };
  const cam = { clearViewOffset() {}, setViewOffset() {}, updateProjectionMatrix() {}, position: { clone() { return this; } } };
  const d = new CameraDirector({ engine: { lastInputAt: performance.now(), speechMouth: 0 }, camera: cam, plateCtx });
  const plate = { image: { tag: 'plate', width: PW, height: PH } };
  const vo = { fullWidth: 1920, fullHeight: 1926.6, x: 0, y: 726.6, width: 1920, height: 1200 };
  d.room = { views: { talk: { plateTexture: plate, camera: { viewOffset: vo } }, work: {}, room: {} } };
  d.view = 'talk'; d.getFramingOverride = () => ({ chestUp: true });
  let seenCrop = null;
  const scene = { ready: true, draw: (ctx, crop, w, h) => { seenCrop = crop; ctx.drawImage({ tag: 'video' }); ctx.drawImage({ tag: 'chair' }); } };
  d.setScene(scene);
  d.drawPlate();
  const want = cropAt(1204, 686);
  ok(JSON.stringify(calls) === JSON.stringify(['clear', 'video', 'chair']), 'z-order: with a video room the plate canvas gets video then chair (no painted plate)', JSON.stringify(calls));
  ok(seenCrop && Math.abs(seenCrop.x - want.x) < 1e-9 && Math.abs(seenCrop.y - want.y) < 1e-9 && Math.abs(seenCrop.w - want.w) < 1e-9, 'registration: the video uses the plate\'s own chest-up crop window', JSON.stringify(seenCrop));
  ok(d.desiredView() === 'talk', 'a video room keeps the talk view');
  d.setManualView('work');
  ok(d.manualView === null, 'a video room refuses a manual pin to work/room');
  calls.length = 0; d.setScene(null); d.drawPlate();
  ok(JSON.stringify(calls) === JSON.stringify(['clear', 'plate']), "'Current room' draws the painted plate exactly as before", JSON.stringify(calls));
  calls.length = 0; d.setScene({ ...scene, ready: false }); d.drawPlate();
  ok(JSON.stringify(calls) === JSON.stringify(['clear', 'plate']), 'until the first video frame decodes, the plate stays (never an empty stage)', JSON.stringify(calls));
}

// ---- 5b. no painted cut-out under a 3D chair (qc-021 ROOM-CROP) ----
{
  const sv = new SceneVideo();
  sv.room = man.rooms[0]; sv.geometry = man; sv.video = { tag: 'video' }; sv.chair = { tag: 'chair', width: 10, height: 10 };
  const drawn = [];
  const ctx = { drawImage: (src) => drawn.push(src.tag) };
  const crop = { x: 0, y: 0, w: PW, h: PH };
  ok(sv.drawChair === true, 'SceneVideo draws the painted cut-out by default (no 3D chair yet)');
  sv.draw(ctx, crop, 800, 500);
  ok(JSON.stringify(drawn) === JSON.stringify(['video', 'chair']), 'drawChair on: video then the painted cut-out', JSON.stringify(drawn));
  drawn.length = 0; sv.drawChair = false; sv.draw(ctx, crop, 800, 500);
  ok(JSON.stringify(drawn) === JSON.stringify(['video']), 'drawChair off (3D chair attached): the video only, no painted cut-out', JSON.stringify(drawn));
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const fn = /async function applyChair\(\) \{([\s\S]*?)\n  \}\n/.exec(app);
  const want = fn && /const want = ([^;]*);/.exec(fn[1]);
  ok(want && !/director\.scene/.test(want[1]), 'applyChair: the 3D chair is not gated off under a video room (no director.scene in the gate)', want && want[1]);
  // Launch flash (0.2.2 RC box run trc2): the video's first frame came while the picked 3D chair was still loading, and the
  // cut-out was drawn for 0.5 s. drawChair follows the PICK, set before applyChair awaits anything, and from the moment
  // the chair list is read (applyScene can show the video before any applyChair has run).
  ok(fn && /const entry = [^\n]*\n\s*sceneVideo\.drawChair = !entry;/.test(fn[1]) && !/sceneVideo\.drawChair = !chair3d\.active/.test(fn[1]), 'applyChair: sceneVideo.drawChair follows the pick (!entry), set before any await, not the load state');
  ok(/chairList = await zumi\.chairs\.list\(\);[^\n]*\n[\s\S]{0,200}?sceneVideo\.drawChair = !chairList\.chairs\.some\(\(c\) => c\.id === chairList\.selected\);/.test(app), 'startup: drawChair is set from the stored pick as soon as the chair list is read');
  ok(fn && /if \(!ok\) \{[^}]*sceneVideo\.drawChair = true;[^}]*return; \}/.test(fn[1]), 'applyChair: a failed chair load puts the painted cut-out back');
  // Launch order (0.2.2 RC follow-up): never a chairless video room, and the Jev warm off the launch path.
  const sc = /async function applyScene\(\) \{([\s\S]*?)\n  \}\n/.exec(app);
  ok(sc && /await chairSettled\(\);[\s\S]*director\.setScene\(sceneVideo\)/.test(sc[1]), 'applyScene: with a 3D chair picked, the video waits for the chair before director.setScene');
  ok(fn && /fit\([^\n]*\n\s*settleChair\(\);/.test(fn[1]) && /drawChair = true; settleChair\(\); return;/.test(fn[1]), 'applyChair: settles the waiting video on attach and on a failed load');
  ok(/jevSelector\.warmAsync\(/.test(app) && !/jevSelector\.warm\(/.test(app) && /jevSelector\.warmAsync\([^\n]*idleSlice, launchSettled\)/.test(app), 'the Jev variety warm runs async (idle slices), its bulk gated on the launch having settled, never the sync warm');
}

// ---- 6. files ----
const chairFile = path.join(ROOT, 'assets', 'rooms-video', man.chair.file);
ok(fs.existsSync(chairFile) && sha(chairFile) === man.chair.sha256, 'chair cut-out matches the manifest sha256');
const videoDir = man.localDir || ownerPath('roomsVideoDir', null); // the owner's video folder (owner-only values file)
if (videoDir && fs.existsSync(videoDir)) {
  const missing = [];
  for (const r of man.rooms) {
    const f = path.join(videoDir, r.file);
    const good = fs.existsSync(f) && fs.statSync(f).size === r.bytes && sha(f) === r.sha256;
    if (!good) missing.push(r.file);
    ok(good, `video ${r.file} matches bytes + sha256`);
  }
  // Every manifest entry is on disk and hash-matched (one summary line, so a partly vendored set names every stale file),
  // and the folder holds no .mp4 the manifest forgot -- a room swap must never leave the old clip behind as a stray.
  ok(missing.length === 0, `every rooms.json entry exists at localDir with its sha256 (${man.rooms.length - missing.length}/${man.rooms.length})`, missing.join(', '));
  // alpha.9: room no. 6 (beach-cabin) must MOVE. Measured as the bug was found: mean absolute luma difference between frames 0.25 s apart
  // (ffmpeg tblend=difference + signalstats, 320x180 gray). The shipped 06 was 0.026 (a still: 18.5 s of ~no change; the other moving rooms
  // measure 0.50-0.63), the Oct 28 studio re-render measures 1.60. A still is under 0.1; the bar is 0.3.
  const beach = man.rooms.find((r) => r.id === 'beach-cabin');
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(videoDir, beach.file), '-vf', 'fps=4,scale=320:180,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const diffs = (ff.stdout || '').split(/\r?\n/).filter((l) => l.includes('YAVG')).map((l) => Number(l.split('=')[1]));
  if (ff.error) { skip++; console.log('SKIP room 6 motion: ffmpeg not on PATH'); }
  else { const mean = diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1); ok(diffs.length > 8 && mean >= 0.3, `room 6 (${beach.file}) animates: mean frame difference ${mean.toFixed(3)} >= 0.3 (a still measures 0.026)`, `${diffs.length} samples`); }
  // Packaging (0.2.1 shipped an empty rooms-video in app-64.7z): the owner build lists every video as an extraResource
  // into packagedDir and keeps *.mp4 inside the NSIS app archive (no preCompressedFileExtensions exclusion).
  const owner = createRequire(import.meta.url)('./builder-selftest.cjs');
  const vids = owner.extraResources.find((e) => e.to === man.packagedDir);
  ok(vids && path.resolve(vids.from) === path.resolve(videoDir) && JSON.stringify(vids.filter) === JSON.stringify(man.rooms.map((r) => r.file)), `owner build: extraResources packs all ${man.rooms.length} videos into <resources>/${man.packagedDir}`, vids && JSON.stringify(vids));
  const pre = owner.nsis.preCompressedFileExtensions;
  ok(Array.isArray(pre) && !pre.some((x) => /mp4$/i.test(x)), 'owner build: nsis.preCompressedFileExtensions excludes nothing, so the videos sit inside app-64.7z', JSON.stringify(pre));
} else { skip += 3; console.log(`SKIP videos + owner packaging: ${videoDir || 'no owner video folder'} not on this machine`); }

// ---- 7b. toolbar pickers hidden by the app must really be hidden (box 20261024-1927 screenshot 2b) ----
// `.picker { display: flex }` beats the hidden attribute, so with no v2 room (saved 'none') the never-painted, EMPTY Room
// select (#scene-select) showed as a blank dropdown in the Zumi toolbar (and the View picker stayed visible). The
// app sets scene-picker / room-view-picker `hidden` (app.js paintScenePicker / switchRoom), so CSS must honour it.
ok(/\.picker\[hidden\]\s*\{\s*display:\s*none/.test(css), "toolbar: .picker[hidden] { display: none } (an empty Room select must not show when no v2 room is loaded)");

// ---- 7. Settings > Room picker (#room-picker): a saved 'none' must read "No room", never a blank select ----
// A <select> shows blank when its value matches no <option>. Minimal fake DOM with the browser's rule (value= picks the
// matching option, else selectedIndex -1); the same module was also run in headless Chrome (EN + VI: shown "No room" /
// "Không có phòng"), so the fake agrees with the real control. Main side: a saved 'none' resolves to 'none'.
{
  const { initRoomSettings } = await import('../src/renderer/room-settings.js');
  const { setLocale, t } = await import('../src/renderer/i18n.js');
  const { resolveRoomLaunch } = await import('../src/main/room-default.mjs');
  const mkSelect = () => {
    const s = { options: [], selectedIndex: -1, listeners: {}, addEventListener(n, f) { this.listeners[n] = f; },
      appendChild(o) { this.options.push(o); if (this.selectedIndex < 0) this.selectedIndex = 0; return o; },
      set innerHTML(_v) { this.options = []; this.selectedIndex = -1; },
      set value(v) { this.selectedIndex = this.options.findIndex((o) => o.value === v); },
      get value() { return this.selectedIndex < 0 ? '' : this.options[this.selectedIndex].value; } };
    return s;
  };
  const nodes = { 'room-picker': mkSelect(), 'room-open': { addEventListener() {} }, 'room-delete': { addEventListener() {}, hidden: false }, 'room-note': { textContent: '', classList: { toggle() {} } } };
  globalThis.document = { createElement: () => ({ value: '', textContent: '' }), addEventListener() {} };
  // main's list since 0.2.11 no-office: default-v2 (Night City) + imported rooms; room v1 'default' is never listed.
  const rooms = [{ id: 'default-v2', source: 'default-v2', label: 'V2', hasManifest: true }];
  const shown = () => { const s = nodes['room-picker']; const o = s.options[s.selectedIndex]; return o ? o.textContent : ''; };
  setLocale('en');
  await initRoomSettings({ rooms: { list: async () => ({ rooms, selected: 'none' }) } }, (id) => nodes[id]);
  ok(nodes['room-picker'].value === 'none' && shown() === 'No room', "room picker (en): saved 'none' selects the \"No room\" option", `value=${nodes['room-picker'].value} shown=${shown()}`);
  setLocale('vi'); await new Promise((r) => setTimeout(r, 0));
  ok(nodes['room-picker'].value === 'none' && shown() === 'Không có phòng', "room picker (vi): saved 'none' selects the \"Không có phòng\" option", `value=${nodes['room-picker'].value} shown=${shown()}`);
  ok(t('room.none') === 'Không có phòng', 'room picker (vi): the label is the room.none string');
  // T-31 0.2.11 owner decision (default-room-q, 2026-10-26): room v1 "Zumi's Office" is removed -- the picker offers
  // exactly No room + Night City (default-v2); the v1 gate itself is scripts/check-no-office.mjs.
  const optValues = nodes['room-picker'].options.map((o) => o.value);
  ok(JSON.stringify(optValues) === JSON.stringify(['none', 'default-v2']), "room picker lists exactly none + default-v2, no v1 'default'", JSON.stringify(optValues));
  setLocale('en');
  for (const [settings, list, want, name] of [
    [{ room: 'none', roomChoiceV2: true }, rooms, 'none', 'explicit none, rooms listed'],
    [{ room: 'none', roomChoiceV2: true }, [], 'none', 'explicit none, no rooms listed'],
    [{ room: 'none', roomChoiceV2: false }, rooms, 'none', 'migrated none stays none'],
  ]) ok(resolveRoomLaunch(settings, list).selected === want, `main: ${name} -> selected '${want}'`, JSON.stringify(resolveRoomLaunch(settings, list)));
  delete globalThis.document;

  // ---- 7c. first run (alpha.14 F6): Settings > Room names the room the stage shows ----
  // A fresh data dir resolves `room` to default-v2 (room-default.mjs) and `sceneRoom` to the manifest's start room
  // (scene-rooms.mjs), which is drawn over default-v2's talk plate. The Settings picker used to label that option with the
  // plate's own name, so it said "Night City" while the stage and the toolbar showed the beach cabin.
  const docListeners = {};
  // set before the next await: the first picker's locale refresh (setLocale above) is still pending and paints through `document`
  globalThis.document = { createElement: () => ({ value: '', textContent: '' }), addEventListener: (n, f) => { (docListeners[n] ||= []).push(f); } };
  const { sceneLabel } = await import('../src/renderer/room/messages.js');
  const fresh = resolveRoomLaunch({}, rooms);
  const startScene = resolveSelectedScene(undefined, man.rooms.map((r) => r.id), man.default);
  ok(fresh.selected === 'default-v2' && startScene === 'beach-cabin', 'fresh data dir: room default-v2 with the beach cabin video over it', `${fresh.selected} / ${startScene}`);
  const sceneNodes = { ...nodes, 'room-picker': mkSelect() };
  let scene = man.rooms.find((r) => r.id === startScene);
  await initRoomSettings({ rooms: { list: async () => ({ rooms, selected: fresh.selected }) } }, (id) => sceneNodes[id], { sceneName: () => (scene ? sceneLabel(scene) : null) });
  const shownIn = (s) => { const o = s.options[s.selectedIndex]; return o ? o.textContent : ''; };
  ok(shownIn(sceneNodes['room-picker']) === 'Beach cabin', 'Settings > Room on a fresh data dir reads "Beach cabin", the room on the stage', shownIn(sceneNodes['room-picker']));
  scene = null; // the toolbar picks "Current room": the painted plate is what shows
  for (const f of docListeners['zumi:scene-changed'] || []) await f();
  await new Promise((r) => setTimeout(r, 0));
  ok(shownIn(sceneNodes['room-picker']).startsWith(`${t('room.name.default-v2')} — `), 'after the toolbar picks the painted room, Settings > Room reads its plate name again', shownIn(sceneNodes['room-picker']));
  const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  ok(/initRoomSettings\(zumi, \$, \{[^\n]*sceneName:/.test(appJs) && /sceneSelect\.addEventListener\('change'[\s\S]{0,400}?dispatchEvent\(new (?:Custom)?Event\('zumi:scene-changed'\)\)/.test(appJs), 'app.js hands Settings > Room the video room name and tells it when the toolbar pick changes');
  delete globalThis.document;
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
