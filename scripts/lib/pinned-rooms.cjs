'use strict';
// afterPack gate for the bundled default room (T-31 0.2.11). electron-builder's extraResources copied
// resources-pinned/room-v2 into <appOutDir>/resources/ (room v1 "Zumi's Office" was removed by owner decision
// 2026-10-26, default-room-q); this re-hashes every file listed in each folder's
// PIN-MANIFEST.json against the staged copy. A missing file or a different sha256 throws, so no installer is built.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PINNED_ROOM_DIRS = ['room-v2'];
const REPO_PIN_ROOT = path.join(__dirname, '..', '..', 'resources-pinned');
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Returns the list of verified staged files (absolute paths); throws a self-explanatory Error otherwise.
function verifyStagedRooms(appOutDir) {
  const verified = [];
  for (const dir of PINNED_ROOM_DIRS) {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_PIN_ROOT, dir, 'PIN-MANIFEST.json'), 'utf8'));
    const entries = Object.entries(manifest.files || {});
    if (!entries.length) throw new Error(`pinned room ${dir}: PIN-MANIFEST.json lists no files`);
    for (const [rel, pin] of entries) {
      const staged = path.join(appOutDir, 'resources', 'resources-pinned', dir, rel);
      if (!fs.existsSync(staged)) throw new Error(`pinned room file missing from the build: ${staged}`);
      const got = sha256Of(staged);
      if (got !== pin.sha256) throw new Error(`pinned room file sha256 mismatch: ${staged} is ${got}, pin says ${pin.sha256}`);
      verified.push(staged);
    }
  }
  return verified;
}

module.exports = { PINNED_ROOM_DIRS, verifyStagedRooms };
