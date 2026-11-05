// electron-builder config for the INTERNAL installer used only by installed self-tests (npm run dist:selftest).
// Same app bits as `npm run dist`, but safe to install next to a real Zumi install:
//  - distinct appId => its own uninstall registry key, so NSIS never treats it as an upgrade of (and uninstalls) the real copy;
//  - no Desktop / Start Menu shortcuts, so its uninstaller never deletes the real "Zumi" shortcuts;
//  - output in _internal-build/ (gitignored), not dist/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { onElectronHost, ELECTRON_HOST_ENV } = require('./lib/electron-guard.cjs');
const { runLicenceGate } = require('./lib/licence-gate.cjs');
const base = require('../package.json').build;

// Video rooms (T-31 room picker, 13-10): the owner build packs the 7 looping room videos (29 MB) from the manifest's
// folder (rooms.json localDir, else the owner values' roomsVideoDir) into <resources>/rooms-video (scene-rooms.mjs reads them there). The release build (package.json) packs
// none, so its Room dropdown stays hidden. Every file is checked against the manifest's size + sha256 first, so an
// owner build can never ship a video the app would then refuse to list.
const crypto = require('node:crypto');
const ROOMS_VIDEO = require('../assets/rooms-video/rooms.json');
// The video source folder and the owner cloud base: owner-only values (src/main/owner-values.json; none in a public tree).
const { ownerValue } = require('../src/main/owner-values.js');
const ROOMS_VIDEO_DIR = ROOMS_VIDEO.localDir || ownerValue('roomsVideoDir', null);
const OWNER_CLOUD_BASE = ownerValue('cloudBase', null);
// Inspect mode is entered ONLY by scripts/check-third-party.mjs, which require()s this file to read the config (never to
// build), so a box without the videos can still list what the owner flavour would pack. It sets ZUMI_CONFIG_INSPECT to
// `check-third-party:<its own pid>`: a bare ZUMI_CONFIG_INSPECT=1 left in a shell (or any value that is not the pid of the
// process loading this file, which electron-builder's never is) is REFUSED, because it would silently skip the video
// size + sha256 check below in a real owner dist.
const inspectEnv = process.env.ZUMI_CONFIG_INSPECT;
const GATE_INSPECT = inspectEnv === `check-third-party:${process.pid}`;
if (inspectEnv && !GATE_INSPECT) throw new Error(`ZUMI_CONFIG_INSPECT is set (${JSON.stringify(inspectEnv)}) outside the licence gate: refusing to load the owner build config with its room-video hash check skipped. Unset it.`);
if (!GATE_INSPECT) {
  if (!ROOMS_VIDEO_DIR) throw new Error('owner build: no room video folder (src/main/owner-values.json roomsVideoDir)');
  for (const r of ROOMS_VIDEO.rooms) {
    const f = path.join(ROOMS_VIDEO_DIR, r.file);
    if (!fs.existsSync(f)) throw new Error(`owner build: missing room video ${f}`);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    if (fs.statSync(f).size !== r.bytes || sha !== r.sha256) throw new Error(`owner build: ${f} does not match assets/rooms-video/rooms.json (size/sha256)`);
  }
}

// Bridge gate (Fable/Sol verdict 10-10 on ownerOps, condition 1: no CI runs these): every owner-build installer runs
// the three board-bridge checks first and is not built when one fails. Their output (with exit codes) is kept in the
// build output folder as board-gate-checks.log, so the "release build returns 403 for routing.* / roles.*" claim is
// as fresh as the installer itself.
// check-board-open.mjs (T-31 ask-media): the owner build's open-local allowlist (src/main/board-open.mjs).
// check-board-links.mjs (review 16bd64f C1): every link on anh's board opens in the owner build or is refused on purpose.
const BRIDGE_GATE = ['check-board-bridge.mjs', 'check-board-live.mjs', 'check-owner-board.mjs', 'check-board-open.mjs', 'check-board-links.mjs'];
function runBridgeGate(outDir) {
  const lines = [];
  let failed = null;
  for (const f of BRIDGE_GATE) {
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 180000 });
    const code = r.status === null ? `killed (${r.signal || 'timeout'})` : r.status;
    lines.push(`===== node scripts/${f} -> exit ${code}`, (r.stdout || '').trimEnd(), (r.stderr || '').trimEnd());
    console.log(`  • bridge gate: scripts/${f} exit ${code}`);
    if (r.status !== 0) { failed = `scripts/${f} exit ${code}`; break; }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const log = path.join(outDir, 'board-gate-checks.log');
  fs.writeFileSync(log, `${lines.filter(Boolean).join('\n')}\n`);
  if (failed) throw new Error(`bridge gate failed: ${failed}; see ${log}`);
}

// Electron gate (T-31 ask-media review 10-10): the PACKED owner app itself, in Electron (window off the desktop,
// shell.openPath/openExternal recorded, nothing opened), clicks the Board tab's link chips: a local file, a folder, a
// 127.0.0.1 and a localhost preview, a path outside the allowed folders. Plain Node checks and Chromium shots could
// not see that a chip click never reached main (the <webview> had no allowpopups). Output appended to
// board-gate-checks.log; the shots land in <outDir>/board-open-electron/. A failure stops the installer.
function runElectronGate(ctx) {
  // Electron runs only on the render box (scripts/lib/electron-guard.cjs, ZUMI_ELECTRON_HOST=box). Anywhere else the
  // gate is SKIPPED, never passed: a loud console line and the same line in board-gate-checks.log, so an installer
  // built off the box visibly carries no Electron-gate evidence.
  if (!onElectronHost()) {
    const line = `===== SKIPPED: not on box -- the Electron gate (scripts/check-board-open-electron.mjs --expect owner) did NOT run; ${ELECTRON_HOST_ENV} is not "box". This installer has NO Electron-gate evidence; run the gate on the render box before shipping it.`;
    fs.appendFileSync(path.join(ctx.outDir, 'board-gate-checks.log'), `${line}\n`);
    console.log(`  • electron gate: ${line}`);
    return;
  }
  const asar = path.join(ctx.appOutDir, 'resources', 'app.asar');
  const out = path.join(ctx.outDir, 'board-open-electron');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'check-board-open-electron.mjs'), '--app', asar, '--out', out, '--expect', 'owner'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 400000 });
  const code = r.status === null ? `killed (${r.signal || 'timeout'})` : r.status;
  const lines = [`===== node scripts/check-board-open-electron.mjs --app <appOutDir>/resources/app.asar --expect owner -> exit ${code}`, (r.stdout || '').trimEnd(), (r.stderr || '').trimEnd()];
  fs.appendFileSync(path.join(ctx.outDir, 'board-gate-checks.log'), `${lines.filter(Boolean).join('\n')}\n`);
  console.log(`  • electron gate: scripts/check-board-open-electron.mjs exit ${code}`);
  if (r.status !== 0) throw new Error(`electron gate failed: scripts/check-board-open-electron.mjs exit ${code}; see ${path.join(ctx.outDir, 'board-gate-checks.log')}`);
}

module.exports = {
  ...base,
  appId: 'space.zumia.desktop.selftest',
  // the internal build may talk to the STAGING talk server (demo runs on the spare PC); --selftest still forces the
  // recorded answers, and talk stays off until a device token is imported. The release build (package.json) has none.
  // `zumiTest: true` is the same flavour marker for board-live.mjs's ZUMI_BOARD_UPSTREAM gate (main.js's ZUMI_TEST_FLAG) —
  // also absent from the release build. Same idea for the Jev fast-reflex egress allowlist: only this internal build
  // may reach openrouter.ai, and only after the operator imports a key (jev-key.import, see src/main/reflex-jev.js).
  // `zumiOwnerAdmin: true` (T-31 owner-admin + usage, Fable ruling 05-10, anh)
  // is this build's own flag: the owner's internal build is the one he actually runs, so it is the one build where
  // the chat daily cap is OFF. A future separate user-facing build keeps the cap (no such field => unchanged).
  // Release package.json has none of these fields.
  // No `zumiDisabledViews` any more: the Work-view-off interim (CoS/Pi HOLD 07-10, "work view OFF" until the chair
  // passed) ended when CoS QC passed the chair on 09-10, so this build has all three views like the release build.
  // The mechanism stays in main.js (DISABLED_VIEWS) / the renderer for a later build that needs it.
  // `zumiBoardMirror: 'http://127.0.0.1:3100'` (T-31 board-aware, coordinator follow-up 07-10): the owner's own
  // local board mirror (the owner's local-mirror.mjs) — board-reader.mjs's fallback source when the
  // live-board bridge is locked/unconfigured, so chat sees the board without a PIN step on his own PC. main.js's
  // BOARD_MIRROR reads this; board-reader.mjs still refuses it if it were ever anything but loopback http(s).
  // Release package.json has no such field, so a release build has no mirror fallback at all.
  extraMetadata: { zumiCloud: { base: OWNER_CLOUD_BASE }, zumiTest: true, zumiReflexJev: { egress: true }, zumiOwnerAdmin: true, zumiBoardMirror: 'http://127.0.0.1:3100' },
  directories: { ...base.directories, output: '_internal-build' },
  extraResources: [...base.extraResources, { from: ROOMS_VIDEO_DIR, to: ROOMS_VIDEO.packagedDir, filter: ROOMS_VIDEO.rooms.map((r) => r.file) }],
  // Runs once per packed target, before the app is packed (an exception stops the build).
  // Licence gate first (fast, owner flavour: UNVERIFIED assets are a WARN whose list is printed; an unmapped file, a missing
  // licence text or an owner-only leak into release still stops the build), then the bridge gate.
  beforePack: async (ctx) => { runLicenceGate('owner', ctx.outDir); runBridgeGate(ctx.outDir); },
  // Runs once the app is packed into appOutDir (win-unpacked), before the NSIS target: the packed app is what is tested.
  // The default avatar is staged first (sha256-checked, throws when missing) so the gate runs against what ships.
  afterPack: async (ctx) => { await require('./after-pack-default-model.cjs')(ctx); runElectronGate(ctx); },
  nsis: {
    ...base.nsis,
    // electron-builder's NSIS target leaves *.mp4 (its default preCompressedFileExtensions) OUT of the app-64.7z payload
    // and adds them as separate NSIS File entries instead. The owner install (owner installer) unpacks app-64.7z only,
    // so 0.2.1 landed with an empty resources/rooms-video. [] = no exclusions: the 7 room videos ride inside app-64.7z.
    preCompressedFileExtensions: [],
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
    shortcutName: 'Zumi selftest',
    artifactName: 'Zumi-selftest-${version}.${ext}',
  },
};
