'use strict';
// Where the default room is read from (T-31 0.2.11). Pure functions, no Electron import, so main.js and
// scripts/check-no-dev-paths.mjs run the SAME decision. A packaged build never reads the dev box (the owner's material folder):
// the default room (v2, Night City) is staged next to app.asar as extraResources (resources-pinned/room-v2),
// sha256-pinned by its PIN-MANIFEST.json and re-hashed by the afterPack gate (scripts/lib/pinned-rooms.cjs). A dev run
// (app.isPackaged false) keeps live-reading the room repo, as before. Room v1 ("Zumi's Office") was removed from the
// app by owner decision 2026-10-26 (default-room-q); its .glb survives only as the room importer's test fixture.
const path = require('node:path');
const { ownerValue } = require('./owner-values.js');

const roomV2PinnedPath = (resourcesPath) => path.join(resourcesPath, 'resources-pinned', 'room-v2', 'room.json');

// The dev-run room: final room B in the owner's room repo (owner-only values file, roomV2Dir); a tree without the owner
// values reads the repo's own pinned copy, as a packaged build reads its staged one.
const ROOM_V2_DIR = ownerValue('roomV2Dir', null);
const ROOM_V2_DEV_PATH = ROOM_V2_DIR ? `${ROOM_V2_DIR}/room.json` : roomV2PinnedPath(path.join(__dirname, '..', '..'));
// Test-only: the known-good .glb the selftest/shots harnesses derive their importer fixtures from (never listed,
// never staged, never selected outside that throwaway run). Same file scripts/check-room.mjs reads. Owner values only
// (roomGlb); elsewhere ZUMI_ROOM_GLB_FIXTURE names it.
const ROOM_GLB_FIXTURE_DEV_PATH = ownerValue('roomGlb', null);

// Precedence: env override > settings override > (packaged ? staged copy : dev path).
function roomV2DefaultPath({ env, settingsPath, isPackaged, resourcesPath }) {
  if (env) return path.resolve(env);
  if (settingsPath) return path.resolve(settingsPath);
  return isPackaged ? roomV2PinnedPath(resourcesPath) : ROOM_V2_DEV_PATH;
}
const roomGlbFixturePath = (env) => (env ? path.resolve(env) : ROOM_GLB_FIXTURE_DEV_PATH);

module.exports = { roomV2DefaultPath, roomV2PinnedPath, roomGlbFixturePath, ROOM_V2_DEV_PATH, ROOM_GLB_FIXTURE_DEV_PATH };
