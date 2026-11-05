'use strict';
// The owner machines' paths and hosts (T-31 P0b): the open-path roots, the dev-run room
// paths, the owner build inputs (room videos, default avatar), the dev checks' assets and the owner origins the pin checks
// bind. They live in ONE owner-only file, owner-values.json beside this module: Zumi-only (scripts/lib/zumi-only.cjs), so
// owner builds ship it and public builds and the public source drop it. Without the file every key answers its caller's
// public default (the app data dir, feature off/null, or a placeholder). With it, a key it lacks is a hard error (a typo
// must not silently change an owner run). Scripts read the same file through scripts/lib/owner-paths.mjs; the Rust host
// compiles in its openRoots (tauri/src-tauri/build.rs).
const fs = require('node:fs');
const path = require('node:path');

const OWNER_VALUES_FILE = path.join(__dirname, 'owner-values.json');
const TABLE = fs.existsSync(OWNER_VALUES_FILE) ? JSON.parse(fs.readFileSync(OWNER_VALUES_FILE, 'utf8')) : null;

/** The owner's value for `key`; `fallback` when this tree has no owner-values.json (a public tree or build). */
function ownerValue(key, fallback = null) {
  if (!TABLE) return fallback;
  if (!Object.prototype.hasOwnProperty.call(TABLE, key)) throw new Error(`src/main/owner-values.json has no "${key}"`);
  return TABLE[key];
}

module.exports = { ownerValue, OWNER_VALUES_FILE };
