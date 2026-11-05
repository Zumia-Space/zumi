// T-31 Tauri parity step 4 — models / rooms / gestures, the write side (gate GATE-step4.md).
//
// Each function mirrors the Electron handler named next to it (src/main/main.js); the Electron-free modules are
// reused unchanged and nothing under src/main is touched. What differs is the trust boundary:
//   - The file dialog lives in Rust. `importModelPath` / `importRoomPath` are reached ONLY through the host-only
//     `__host.*` methods the Rust `rpc` command calls with the dialog's pick; the public `openModelFile` /
//     `rooms.openFile` take no arguments and cannot import anything (conditions 2-3).
//   - A path the host hands over is re-validated here: model = absolute, `.vrm`, a regular file, referenced in place;
//     room = room-check + a copy under <data dir>/rooms/<sha12>/ (25 MB cap, as Electron).
//   - rooms.delete and rooms.v2.saveView enforce their own preconditions (conditions 4-5).
import fs from 'node:fs';
import path from 'node:path';

import { checkRoomFile, checkRoomJsonFile, isVrmFile, roomContentId, roomPickPatch } from './adapters.mjs';
import { ROOM_ID } from './boot-reads.mjs';

const MAX_PATH_CHARS = 32_767;
const GESTURE_TIMEOUT_MS = 5000; // main.js:911, the renderer's answer deadline
const VIEWS = ['talk', 'work', 'room'];

const isPlainAbsolutePath = (p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_CHARS && !p.includes('\0') && path.isAbsolute(p);
// A regular file, NOT a link: lstat does not follow, so a symlink/junction named *.vrm never passes.
const isRegularFile = (p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };

/**
 * @param boot    createBootReads(...) result (listModels / listRooms / roomsStore / servedRoomV2Json)
 * @param emit    protocol.mjs createEmitter(...) — the one push path to the renderer
 */
export function createLibrary({ settings, saveSettings, boot, emit, log = () => {}, gestureTimeoutMs = GESTURE_TIMEOUT_MS }) {
  // ---- models ----
  // models:select (main.js:734). The test model is never persisted; an unknown id changes nothing.
  function selectModel(id) {
    const list = boot.listModels();
    if (id !== 'test' && list.models.some((m) => m.id === id)) saveSettings({ model: id });
    return boot.listModels();
  }

  // models:open-file's tail (main.js:745-747), after the host's dialog returned `p`. null = nothing imported.
  function importModelPath(p) {
    if (!isPlainAbsolutePath(p) || !/\.vrm$/i.test(p) || !isVrmFile(p) || !isRegularFile(p)) return null;
    saveSettings({ userModelPath: p, model: 'user' });
    return boot.listModels();
  }

  // ---- rooms ----
  // rooms:select (main.js:752).
  async function selectRoom(id) {
    const { rooms } = await boot.listRooms();
    if (id === 'none' || rooms.some((r) => r.id === id)) saveSettings(roomPickPatch(id));
    return boot.listRooms();
  }

  // The imported room's sidecar manifest (main.js:337/342): <name>.json or <name>.room.json beside the .glb.
  function readRoomManifest(glbPath) {
    for (const candidate of [glbPath.replace(/\.glb$/i, '.json'), glbPath.replace(/\.glb$/i, '.room.json')]) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        return raw && raw.format === 'zumi-room' ? raw : null;
      } catch { return null; }
    }
    return null;
  }

  // <store>/<id> when it is a real directory directly inside the store; otherwise why not. lstat first, so a
  // symlink or junction planted at the id is never followed; the realpath check catches a link in the store's own
  // path. 'missing' = nothing on disk (a hand-deleted folder).
  function roomDirState(id) {
    const store = boot.roomsStore();
    const dir = path.join(store, id);
    let st;
    try { st = fs.lstatSync(dir); } catch (e) { return { state: e && e.code === 'ENOENT' ? 'missing' : 'unsafe' }; }
    if (st.isSymbolicLink() || !st.isDirectory()) return { state: 'unsafe' };
    try {
      const realStore = fs.realpathSync.native(store);
      const realDir = fs.realpathSync.native(dir);
      if (path.relative(realStore, realDir) !== id) return { state: 'unsafe' };
    } catch { return { state: 'unsafe' }; }
    return { state: 'ok', dir };
  }

  // rooms:open-file's tail (main.js:763-765, importRoomFile :411), after the host's dialog returned `p`.
  async function importRoomPath(p) {
    const notARoom = { error: { code: 'not_a_room_file', params: {} } };
    if (!isPlainAbsolutePath(p) || !isRegularFile(p)) return notARoom;
    let size;
    let check;
    try { size = fs.statSync(p).size; check = checkRoomFile(p); } catch { return notARoom; }
    if (!check.ok) return { error: check.refused };
    const buf = fs.readFileSync(p);
    if (buf.length !== size) return notARoom; // the file changed between the check and the copy
    const id = roomContentId(buf);
    const store = boot.roomsStore();
    const destDir = path.join(store, id);
    fs.mkdirSync(destDir, { recursive: true });
    if (roomDirState(id).state !== 'ok') return notARoom; // never write through a link planted at the id
    fs.writeFileSync(path.join(destDir, 'room.glb'), buf);
    const manifest = readRoomManifest(p);
    fs.writeFileSync(path.join(destDir, 'check.json'), JSON.stringify({ warnings: check.warnings, stats: check.stats, importedAt: new Date().toISOString() }, null, 2));
    const imported = (Array.isArray(settings().importedRooms) ? settings().importedRooms : []).filter((r) => r && r.id !== id);
    imported.push({ id, fileBase: path.basename(p), manifest });
    saveSettings({ importedRooms: imported, ...roomPickPatch(id) });
    return boot.listRooms();
  }

  // rooms:delete (main.js:768, deleteRoom :429). Only a user-imported room, only inside the store, never a link.
  async function deleteRoom(id) {
    const current = settings();
    const imported = Array.isArray(current.importedRooms) ? current.importedRooms : [];
    if (typeof id === 'string' && ROOM_ID.test(id) && imported.some((r) => r && r.id === id)) {
      const where = roomDirState(id);
      if (where.state === 'unsafe') {
        log(`[rooms] delete refused: store entry ${id} is not a plain folder inside the store`);
      } else {
        if (where.state === 'ok') fs.rmSync(where.dir, { recursive: true, force: true });
        saveSettings({ importedRooms: imported.filter((r) => r && r.id !== id), room: current.room === id ? 'none' : current.room });
      }
    }
    return boot.listRooms();
  }

  // rooms:v2:save-view (main.js:781). Developer mode only (the sidecar is a packaged build, so Electron's
  // `app.isPackaged === false ||` branch is gone); edits land on the served copy, never the source room.
  function saveRoomV2View(id, view, camera) {
    if (settings().developerMode !== true) return { error: 'dev_tools_off' };
    if (id !== 'default-v2') return { error: 'unknown_room' };
    if (!VIEWS.includes(view)) return { error: 'bad_view' };
    const pos = camera && camera.pos;
    const target = camera && camera.target;
    const fov = camera && camera.fov;
    const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
    if (!isVec3(pos) || !isVec3(target) || typeof fov !== 'number' || !Number.isFinite(fov)) return { error: 'bad_camera' };
    const jsonPath = boot.servedRoomV2Json();
    if (!jsonPath) return { error: 'missing_view' };
    let json;
    try { json = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return { error: 'not_a_room_json' }; }
    if (!json.views || !json.views[view] || !json.views[view].camera || !json.views[view].camera.three) return { error: 'missing_view' };
    const before = JSON.stringify(json);
    // MERGE, never overwrite the camera object (main.js:807): only pos / target / three.fov are the tool's to change.
    json.views[view].camera.pos = pos;
    json.views[view].camera.target = target;
    json.views[view].camera.three.fov = fov;
    if (JSON.stringify(json) === before) return { ok: true, unchanged: true };
    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
    const check = checkRoomJsonFile(jsonPath);
    if (!check.ok) { fs.writeFileSync(jsonPath, before); return { error: 'save_made_it_invalid', refused: check.refused }; } // rolled back
    return { ok: true };
  }

  // ---- gestures (main.js:897-911) ----
  // playGesture pushes `gesture:play { reqId, command }` to the renderer and resolves with the validator's verdict
  // the renderer sends back on `gesture:result` (host-only `__host.gestureResult`), or a failure after 5 s.
  const pendingGestures = new Map();
  let gestureSeq = 0;
  function playGesture(command) {
    const reqId = ++gestureSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pendingGestures.delete(reqId); resolve({ ok: false, errors: ['renderer did not answer'] }); }, gestureTimeoutMs);
      pendingGestures.set(reqId, (result) => { clearTimeout(timer); resolve(result); });
      if (!emit('gesture:play', { reqId, command })) {
        clearTimeout(timer);
        pendingGestures.delete(reqId);
        resolve({ ok: false, errors: ['gesture command could not be delivered'] });
      }
    });
  }
  function gestureResult(reqId, result) {
    const done = Number.isSafeInteger(reqId) ? pendingGestures.get(reqId) : undefined;
    if (!done) return false;
    pendingGestures.delete(reqId);
    done(result === undefined ? null : result);
    return true;
  }

  // ---- model:changed ----
  // Its only producer was the wardrobe Apply / Undo (removed in 0.3.0-alpha.11); the event-path probe still drives it.
  // The renderer re-reads the list and switches model on it, so it is NOT sent for a change the renderer made itself
  // (it would switch twice).
  function modelChanged(reason) {
    return emit('model:changed', { reason: typeof reason === 'string' ? reason.slice(0, 64) : 'unknown' });
  }

  return { selectModel, importModelPath, selectRoom, importRoomPath, deleteRoom, saveRoomV2View, playGesture, gestureResult, modelChanged };
}
