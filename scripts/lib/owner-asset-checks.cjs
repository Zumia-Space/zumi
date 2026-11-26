'use strict';
// Checks that read owner material the public source does not hold: the owner values file (open roots, room-video folder, the
// owner's model paths), the default VRM, the Room / chair / plate / room-video assets and the official build's credit files.
// Measured 23-11 (OSS-02 step 0b): each one passes in the owner tree and fails in the public export, for that reason alone.
// scripts/run-all-checks.mjs reports them NOT RUN (precondition) when this tree has no src/main/owner-values.json, without
// starting them; with the file they run as before, so an owner run still sees every FAIL. ZUMI_RUN_OWNER_ASSET_CHECKS=1 runs
// them anyway (a contributor who supplies the assets by flag or env).
const fs = require('node:fs');
const path = require('node:path');

const VRM = 'a VRM model (the owner model path, or --model / ZUMI_TEST_MODEL)';
const ROOM = 'the Room / chair / plate assets of the official build';
const ROOTS = 'the owner values file (board open roots, owner origins)';
const VIDEOS = 'the owner values file (room-video folder) and the official build assets';
const CREDITS = 'the official build credit and asset files (ASSETS-LICENSE.md, resources-pinned/room-v2)';

const OWNER_ASSET_CHECKS = Object.freeze({
  'check:board-open': ROOTS, 'check:hud': ROOTS, 'check:tauri-board-live-open': ROOTS,
  'check:board-gate-inputs': 'the owner board CLI and Electron gate inputs', 'check:tauri-board-signout': 'the owner live board',
  'check:board-unlock-live': 'the owner live board',
  'check:speech': VIDEOS, 'check:updater': VIDEOS, 'check:tauri-owner-stage': VIDEOS, 'check:room-packs': VIDEOS,
  'check:kokoro-packaged-env': 'the Kokoro model seed (local/kokoro)', 'check:voice-p1': 'the owner voice cache',
  'check:tauri-guest': ROOTS, 'check:tauri-boot': 'the box boot trace and a VRM', 'check:tauri-step4': VRM,
  'check:tauri-default-model': 'the default VRM (official build only)', 'check:default-model': 'the default VRM (official build only)',
  'check:tauri-third-party': CREDITS, 'check:tauri-third-party-selftest': CREDITS, 'check:third-party': CREDITS,
  'check:third-party-attest': CREDITS, 'check:third-party-openlegal': CREDITS,
  'check:pricing': 'the pricing hero image (official build asset)',
  'check:gesture-forward': VRM, 'check:work-seated': VRM, 'check:panel-touch': VRM, 'check:idle-life': VRM, 'check:avatar-core': VRM,
  'check:arms-life': VRM, 'check:mouse-variety': VRM, 'check:r4a-latency': VRM, 'check:holo-seated-rect': VRM, 'check:camera-latency': VRM,
  'check:vrm0-facing': VRM, 'check:clip-hold': VRM,
  'check:room': ROOM, 'check:room-picker': ROOM, 'check:seat-offset': ROOM, 'check:seat-fit': ROOM, 'check:chair3d': ROOM,
  'check:float-holo': ROOM, 'check:holo-legible': ROOM, 'check:float-holo-pixels': ROOM, 'check:fh-clips': 'the render-box clip scripts',
  'check:camera': ROOM, 'check:room-v2-pin': ROOM, 'check:no-dev-paths': ROOM, 'check:no-office': ROOM,
  'check:tauri-room-default': ROOM, 'check:tauri-selftest': ROOM,
});

/** Why `name` cannot run in the tree at `root` (null = run it). */
function ownerAssetPrecondition(name, root, env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(OWNER_ASSET_CHECKS, name)) return null;
  if (env.ZUMI_RUN_OWNER_ASSET_CHECKS === '1') return null;
  if (fs.existsSync(path.join(root, 'src', 'main', 'owner-values.json'))) return null;
  return `needs ${OWNER_ASSET_CHECKS[name]}; this tree has no src/main/owner-values.json (the public source holds no owner assets)`;
}

module.exports = { OWNER_ASSET_CHECKS, ownerAssetPrecondition };
