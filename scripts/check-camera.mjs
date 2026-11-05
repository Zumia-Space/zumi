// CameraDirector + room-loader-v2 gate (T-31 camera modes, PLAN-camera-modes.md): headless Node (no Electron, no
// browser) -- a local static server stands in for the app:// protocol (fetch() needs http(s)/app://, not
// file://), the same posture check-room.mjs's checker-only tests already use, extended here to the renderer-side
// loader + director. Proves: plates preload at room load (not lazily per switch), the state -> view mapping
// (talk default / work signal / room after idle), a missing view falls back to talk, a missing talk view fails
// the room entirely, occluders load from the shared model by node name (and a missing node degrades, not
// crashes), per-view zumi_seat is applied on switch (round 2), and a view's own `lights` replace the default
// rig while active (round 3). Also asserts CameraDirector.update is a plain (non-async) function -- the
// latency gate's actual guarantee (check-camera-latency.mjs) is that calling it never stalls a frame; this is
// the static half of that: it cannot even BE awaited by a caller that forgot not to.
//   node scripts/check-camera.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} }); // room-loader-v2.js's ImageBitmapLoader path; pixel content is not what this gate checks (the renders are)
globalThis.ProgressEvent = class ProgressEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }; // three.js's loaders fire progress events while fetching

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STANDIN = ownerPath('standinRoom', 'local/standin-room-v2');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

if (!fs.existsSync(path.join(STANDIN, 'room.json'))) {
  console.error(`FAIL stand-in not found at ${STANDIN} -- run: node scripts/gen-standin-room-v2.mjs`);
  process.exit(1);
}

// ---------- a local static server over the stand-in dir + src/renderer (for room-loader-v2.js/camera-director.js
// themselves, imported as real ES modules -- not re-implemented for this test) ----------
const ROOTS = { '/room/': STANDIN + path.sep, '/renderer/': path.join(ROOT, 'src', 'renderer') + path.sep };
const TYPES = { '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary' };
const srv = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const pre = Object.keys(ROOTS).find((p) => url.startsWith(p));
  if (!pre) { res.writeHead(404); return res.end(); }
  const file = ROOTS[pre] + url.slice(pre.length);
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;
const base = `http://127.0.0.1:${port}`;

// The JS MODULES themselves import by plain file path (Node's default ESM loader has no http: scheme support);
// only the ASSETS they fetch at runtime (plates, occluders.glb) go through the local server above, via resolveUrl.
const { loadRoomV2 } = await import('../src/renderer/room/room-loader-v2.js');
const { CameraDirector, ROOM_IDLE_MS } = await import('../src/renderer/room/camera-director.js');

const roomJson = JSON.parse(fs.readFileSync(path.join(STANDIN, 'room.json'), 'utf8'));
const resolveUrl = (rel) => `${base}/room/${rel}`;

// ---------- 1. preloading: every view's plate texture is ready the instant loadRoomV2() resolves ----------
const room = await loadRoomV2(roomJson, resolveUrl);
ok(Boolean(room), 'loadRoomV2: the stand-in loads');
if (room) {
  for (const name of ['talk', 'work', 'room']) {
    ok(Boolean(room.views[name].plateTexture), `preload: views.${name}.plateTexture is ready at load time (not lazy)`, JSON.stringify(room.views[name].plateTexture));
  }
}

// ---------- 2. occluders loaded from the shared model by node name ----------
if (room) {
  ok(room.views.work.occludersGroup.children.length === 1, 'occluders: work view got its 1 named mesh from occluders.glb', room.views.work.occludersGroup.children.length);
  ok(room.views.talk.occludersGroup.children.length === 0, 'occluders: talk view (none declared) has an empty group, not a crash', room.views.talk.occludersGroup.children.length);
  const occMat = room.views.work.occludersGroup.children[0] && room.views.work.occludersGroup.children[0].material;
  ok(Boolean(occMat) && occMat.colorWrite === false && occMat.depthWrite === true, 'occluders: depth-only material (colorWrite false, depthWrite true)', JSON.stringify(occMat && { colorWrite: occMat.colorWrite, depthWrite: occMat.depthWrite }));
  ok(room.views.work.occludersGroup.children[0] && room.views.work.occludersGroup.children[0].renderOrder < 0, 'occluders: renderOrder is before the avatar\'s default (0)', room.views.work.occludersGroup.children[0] && room.views.work.occludersGroup.children[0].renderOrder);
}

// ---------- 3. a room with a missing node reference degrades (warns), never crashes ----------
{
  const bad = JSON.parse(JSON.stringify(roomJson));
  bad.views.work.occluders.push({ name: 'ghost', node: 'occ_does_not_exist' });
  let threw = false;
  const r = await (async () => { try { return await loadRoomV2(bad, resolveUrl); } catch { threw = true; return null; } })();
  ok(!threw && Boolean(r), 'occluders: an unresolvable node reference does not throw', threw);
}

// ---------- 4. a missing talk view fails the whole room; a missing work/room view falls back to talk ----------
{
  const noTalk = JSON.parse(JSON.stringify(roomJson));
  delete noTalk.views.talk;
  const r = await loadRoomV2(noTalk, resolveUrl);
  ok(r === null, 'fallback: a room with no talk view is unusable (loadRoomV2 returns null)', r);
}
{
  const noWork = JSON.parse(JSON.stringify(roomJson));
  delete noWork.views.work;
  const r = await loadRoomV2(noWork, resolveUrl);
  // Reference equality on the loaded Texture is NOT expected (each view fetches its own Texture instance, even
  // when the underlying URL is identical) -- what "falls back to talk" means is the SOURCE data (camera numbers,
  // which plate path, which seat) is talk's, not a separately-authored work view.
  ok(Boolean(r) && r.views.work.camera.fov === r.views.talk.camera.fov && r.views.work.camera.position.equals(r.views.talk.camera.position), 'fallback: a room with no work view falls back to the talk view\'s camera', r && { workFov: r.views.work.camera.fov, talkFov: r.views.talk.camera.fov });
  ok(Boolean(r) && r.views.work.seat && r.views.work.seat.rotYDeg === r.views.talk.seat.rotYDeg, 'fallback: ...and its seat', r && { work: r.views.work.seat, talk: r.views.talk.seat });
}

// ---------- 5. CameraDirector: never async, never touches engine.trigger/play ----------
ok(CameraDirector.prototype.update.constructor.name !== 'AsyncFunction', 'CameraDirector.update is not an async function (cannot await I/O by construction)');
ok(CameraDirector.prototype.beginSwitch.constructor.name !== 'AsyncFunction', 'CameraDirector.beginSwitch is not an async function');
const srcCode = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'room', 'camera-director.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '') // strip block (JSDoc) comments
  .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n'); // strip line comments -- this check is about CODE, not the prose that documents the rule
ok(!/\btrigger\s*\(/.test(srcCode) && !/\.play\s*\(/.test(srcCode), 'CameraDirector source never calls engine.trigger()/play()', (srcCode.match(/\btrigger\s*\(|\.play\s*\(/g) || []).join(','));

// ---------- 6. state -> view mapping (PLAN: talk default / Zumi speaking -> talk / a working signal -> work / idle > 60s -> room) ----------
{
  const fakeEngine = { lastInputAt: performance.now(), speechMouth: null };
  const seatCalls = [];
  const director = new CameraDirector({ engine: fakeEngine, camera: new (await import('three')).PerspectiveCamera(), plateCtx: null, setLookTargets: () => {}, placeSeat: (s) => seatCalls.push(s) });
  director.setRoom(room);
  ok(director.view === 'talk', 'state->view: the default is talk', director.view);
  ok(seatCalls.length === 1 && seatCalls[0].rotYDeg === roomJson.views.talk.zumi_seat.rotYDeg, 'per-view seat: placeSeat was called with the TALK view\'s own seat on room load', JSON.stringify(seatCalls[seatCalls.length - 1]));

  director.setWorking(true);
  director.jumpToView(director.desiredView());
  ok(director.view === 'work', 'state->view: a working signal selects work', director.view);
  ok(seatCalls[seatCalls.length - 1].rotYDeg === roomJson.views.work.zumi_seat.rotYDeg, 'per-view seat: placeSeat was called with the WORK view\'s own seat (not talk\'s) on switch', JSON.stringify(seatCalls[seatCalls.length - 1]));
  ok(room.views.work.lightsGroup.visible === true, 'lights: the work view\'s own light rig is visible once active');
  director.setWorking(false);

  fakeEngine.speechMouth = { aa: 0.5 };
  ok(director.desiredView() === 'talk', 'state->view: Zumi speaking selects talk even if otherwise idle');
  fakeEngine.speechMouth = null;

  fakeEngine.lastInputAt = performance.now() - (ROOM_IDLE_MS + 1000);
  ok(director.desiredView() === 'room', 'state->view: idle past the threshold selects room', ROOM_IDLE_MS);
  fakeEngine.lastInputAt = performance.now();
  ok(director.desiredView() === 'talk', 'state->view: fresh input returns to talk', director.desiredView());
}

// ---------- 6b. disabledViews (Thu 16:00 talk-QC build, option C: work off for this build) -- proves work is
// UNREACHABLE by every path (auto working-signal AND manual pin) when the flag names it, and that the SAME
// director with no flag still reaches it -- the negative half alone can't rule out "always unreachable". ----------
{
  const fakeEngine = { lastInputAt: performance.now(), speechMouth: null };
  const director = new CameraDirector({ engine: fakeEngine, camera: new (await import('three')).PerspectiveCamera(), plateCtx: null, setLookTargets: () => {}, placeSeat: () => {}, disabledViews: ['work'] });
  director.setRoom(room);
  director.setWorking(true);
  ok(director.desiredView() === 'talk', 'disabledViews: a working signal maps to talk when work is disabled', director.desiredView());
  director.jumpToView(director.desiredView());
  ok(director.view === 'talk', 'disabledViews: the director never actually lands on work while working=true', director.view);
  director.setManualView('work');
  ok(director.manualView === null, 'disabledViews: a manual pin to a disabled view is rejected (null), not silently accepted', director.manualView);
  ok(director.view !== 'work', 'disabledViews: work is unreachable via manual pin either', director.view);
  director.setWorking(false);

  // Control: the identical sequence with NO disabledViews still reaches work -- proves the block above is the
  // flag's effect, not something else (a broken room/engine fixture) making work unreachable regardless.
  const plainDirector = new CameraDirector({ engine: fakeEngine, camera: new (await import('three')).PerspectiveCamera(), plateCtx: null, setLookTargets: () => {}, placeSeat: () => {} });
  plainDirector.setRoom(room);
  plainDirector.setWorking(true);
  ok(plainDirector.desiredView() === 'work', 'disabledViews control: with no flag, the same working signal still selects work', plainDirector.desiredView());
  plainDirector.setManualView('work');
  ok(plainDirector.manualView === 'work', 'disabledViews control: with no flag, a manual pin to work is accepted', plainDirector.manualView);
  plainDirector.setWorking(false);

  // T-31-MOBILE: the phone turns 'room' off (its portrait crop loses her). Idle past ROOM_IDLE_MS must then stay on
  // talk; the control (no flag, same idle engine) still goes to room, so the flag is what keeps her on stage.
  const idleEngine = { lastInputAt: performance.now() - 120_000, speechMouth: null };
  // A Set, exactly as app.js passes it (app.js:60): an Array-only constructor emptied it and the phone still went to room.
  const phoneDirector = new CameraDirector({ engine: idleEngine, camera: new (await import('three')).PerspectiveCamera(), plateCtx: null, setLookTargets: () => {}, placeSeat: () => {}, disabledViews: new Set(['room']) });
  phoneDirector.setRoom(room);
  ok(phoneDirector.desiredView() === 'talk', 'disabledViews room: idle past ROOM_IDLE_MS stays on talk', phoneDirector.desiredView());
  const idleControl = new CameraDirector({ engine: idleEngine, camera: new (await import('three')).PerspectiveCamera(), plateCtx: null, setLookTargets: () => {}, placeSeat: () => {} });
  idleControl.setRoom(room);
  ok(idleControl.desiredView() === 'room', 'disabledViews room control: with no flag, the same idle engine selects room', idleControl.desiredView());
}

// ---------- 7. grade: a plate-only (fully transparent) pixel is untouched -- coordinator round 3 QC
// (2026-10-05): round 2's tint leaked onto the plate (a flat fillRect's own alpha survives over a transparent
// backdrop regardless of blend mode -- see apply-grade.js's header for the full derivation). applyAvatarTint
// must never write a pixel whose alpha is 0, at any strength, for any tint. ----------
{
  const { applyAvatarTint } = await import('../src/renderer/room/apply-grade.js');
  const W = 4, H = 1; // 4 pixels: 2 "plate-only" (alpha 0), 2 "avatar" (alpha 255)
  const data = Uint8ClampedArray.from([
    120, 130, 140, 0, // plate-only #1
    200, 90, 60, 0, // plate-only #2
    220, 220, 220, 255, // avatar #1 (her white suit)
    220, 220, 220, 255, // avatar #2
  ]);
  const img = { data, width: W, height: H };
  applyAvatarTint(img, '#6f7fe0', 0.24); // the real work/room grade strength
  const plateUnchanged = data[0] === 120 && data[1] === 130 && data[2] === 140
    && data[4] === 200 && data[5] === 90 && data[6] === 60;
  ok(plateUnchanged, 'grade: a fully-transparent (plate-only) pixel is byte-exact after applyAvatarTint (ON = OFF)', JSON.stringify(Array.from(data.slice(0, 8))));
  const avatarChanged = data[8] !== 220 || data[9] !== 220 || data[10] !== 220;
  ok(avatarChanged, 'grade: an opaque (avatar) pixel DOES change -- the tint is not simply a no-op', JSON.stringify(Array.from(data.slice(8, 12))));
  // mean luminance of the plate-only region, ON vs a fresh OFF (strength 0) run -- must match within 1 (the
  // task's own framing: "a plate-only region's mean luminance with grade ON = OFF (+/-1)")
  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const onLuma = (luma(data[0], data[1], data[2]) + luma(data[4], data[5], data[6])) / 2;
  const offData = Uint8ClampedArray.from([120, 130, 140, 0, 200, 90, 60, 0, 220, 220, 220, 255, 220, 220, 220, 255]);
  const offImg = { data: offData, width: W, height: H };
  applyAvatarTint(offImg, '#6f7fe0', 0); // OFF
  const offLuma = (luma(offData[0], offData[1], offData[2]) + luma(offData[4], offData[5], offData[6])) / 2;
  ok(Math.abs(onLuma - offLuma) <= 1, 'grade: plate-only region mean luminance, ON vs OFF, within 1', `on=${onLuma.toFixed(2)} off=${offLuma.toFixed(2)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0; // not process.exit(): let the http server's close() handle drain naturally (an immediate exit() races its teardown on Windows -- a libuv assertion, harmless but noisy)
srv.close();
