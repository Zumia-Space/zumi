// T-31 parity 7-1: stage the Tauri bundle resources.
//
// Tauri copies `src-tauri/bundle/` to the resource root (tauri.conf.json bundle.resources `"bundle/": ""`), which on
// Windows is the directory holding the main exe. The staged tree is therefore exactly the layout a built/installed
// preview has:
//
//   ZumiPreview.exe            (built by tauri, not staged here)
//   zumi-vault.exe             (built by cargo; must sit BESIDE the main exe, parity step 5 gate condition 2)
//   tauri/sidecar/*.mjs        (the sidecar the host spawns)
//   src/main/*                 (the modules the sidecar imports unchanged, e.g. talk-voice-core.mjs)
//   THIRD_PARTY_LICENSES.md, NOTICE (the credit files, resource root)
//   voice-modules/node_modules (kokoro-js + phonemizer + @huggingface/transformers + its nested onnxruntime-node
//                               and the sharp stub) -- the SAME filters electron-builder's extraResources use
//
// node.exe is NOT staged (node-bundle option (c), owner): the installer ships without Node. At runtime the host
// finds a compatible system Node or, after consent, downloads the pinned official zip into the per-user data dir
// (tauri/src-tauri/src/node_runtime.rs). check-bundle.mjs asserts node.exe is ABSENT from the staged tree.
//
//   node tauri/stage-bundle.mjs [--flavour owner|public|official|selftest]   (default owner; a public stage needs --flavour public)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { stageRoomVideos, stageFlavourFile, stageInstallManifest, stripOfficialManifest, verifyStagedFlavour } from './flavour-stage.mjs';
import { stageNextUiFlag } from './next-ui-stage.mjs';

const { stageIntoTauriBundle, verifyStagedDefaultModel } = createRequire(import.meta.url)('../scripts/lib/default-vrm.cjs');
const { isZumiOnly, isOfficialDenied } = createRequire(import.meta.url)('../scripts/lib/zumi-only.cjs');
const { toPublicCredits } = createRequire(import.meta.url)('../scripts/lib/public-credits.cjs');

const repo = path.resolve(import.meta.dirname, '..');
const srcTauri = path.join(repo, 'tauri', 'src-tauri');
// ZUMI_STAGE_DIR: a scratch stage for scripts/check-public-payload.mjs (it walks a real public stage); a build never sets it.
const stage = process.env.ZUMI_STAGE_DIR ? path.resolve(process.env.ZUMI_STAGE_DIR) : path.join(srcTauri, 'bundle');

// Cargo honours CARGO_TARGET_DIR for every build; a box/scratch build points it outside the tree, so the helper is not
// under src-tauri/target. A relative override is resolved from the cwd, exactly as cargo treats it.
export function cargoTargetDir(env = process.env, cwd = process.cwd()) {
  return env.CARGO_TARGET_DIR ? path.resolve(cwd, env.CARGO_TARGET_DIR) : path.join(srcTauri, 'target');
}

export function vaultExePath(env = process.env, cwd = process.cwd()) {
  return path.join(cargoTargetDir(env, cwd), 'release', 'zumi-vault.exe');
}

function fail(message) {
  console.error(`stage-bundle: ${message}`);
  process.exit(1);
}

// ---------- electron-builder `filter` matcher (same rules as scripts/check-kokoro-packaged-env.mjs) ----------
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
    } else if (c === '*') {
      re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
function isIncluded(relPosixPath, filters) {
  let included = false;
  for (const pattern of filters) {
    const neg = pattern.startsWith('!');
    const re = globToRegExp(neg ? pattern.slice(1) : pattern);
    if (re.test(relPosixPath)) included = !neg;
  }
  return included;
}
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
// The files of `from` that `filters` include (relative, posix). Shared with the third-party gate so both see the same set.
export function filteredFiles(from, filters = ['**/*']) {
  return walk(from).filter((rel) => isIncluded(rel, filters));
}
export function copyFiltered(from, to, filters = ['**/*']) {
  let copied = 0;
  for (const rel of walk(from)) {
    if (!isIncluded(rel, filters)) continue;
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, rel), dest);
    copied++;
  }
  return copied;
}
// Copy only files git TRACKS under `rel` (step 7-8): a working-tree `cpSync` would also ship an untracked local file, and
// the name-only secret check in check-bundle.mjs cannot see a secret inside a stray `.mjs`. `git ls-files -z` is the
// commit's own list, so what ships is exactly what the review saw.
// Tracked files that must NEVER reach a user build. The measurement-only stub chat provider lives in the sidecar tree for
// development, but main.mjs imports it only behind --measure-stub-provider and a staged bundle simply does not contain it
// (scripts/check-tauri-measure-stub.mjs).
// Credit files copied verbatim to the same relative path in the resource root (check-bundle asserts all of them).
// ASSETS-LICENSE.md is Zumi-only (scripts/lib/zumi-only.cjs): owner / selftest stages only, never public.
export const CREDIT_FILES = Object.freeze(['LICENSE', 'THIRD_PARTY_LICENSES.md', 'NOTICE', 'licenses/GPL-3.0.txt', 'ASSETS-LICENSE.md']);

export const STAGE_EXCLUDED = Object.freeze(['tauri/sidecar/measure-stub.mjs']);
// Tracked folders no flavour ships (worklist B3): Laneboard's own dev/ops scripts (one names a VPS cutover); the app needs
// only its src/, public/ and schema/. Same exclusion as package.json build.files "!vendor/laneboard/scripts/**".
export const STAGE_EXCLUDED_DIRS = Object.freeze(['vendor/laneboard/scripts/']);
// ...minus the two Laneboard scripts the app runs (src/main/laneboard-host.mjs load(): the first-run sample seed and the v0.2
// board import). Same re-include as package.json build.files; check:public-payload E7/E8 derive the list from src/main.
export const STAGE_KEPT = Object.freeze(['vendor/laneboard/scripts/seed.mjs', 'vendor/laneboard/scripts/migrate-from-legacy.mjs']);

/**
 * The tracked files of `rel` that the staged bundle ships. Only the explicit `measureStub` option (the --measure-stub switch,
 * build.ps1 -MeasureStub on a non-public flavour) keeps the stub; the default, and so every public bundle, never does.
 * The public flavour (the default) also drops every Zumi-only asset (scripts/lib/zumi-only.cjs, open-core ADR 2026-10-28).
 */
export function stagedTrackedFiles(rel, { measureStub = false, flavour = 'public' } = {}) {
  return trackedFiles(rel).filter((f) => (measureStub || !STAGE_EXCLUDED.includes(f)) && (STAGE_KEPT.includes(f) || !STAGE_EXCLUDED_DIRS.some((d) => f.startsWith(d)))
    && !(flavour === 'public' && isZumiOnly(f)) && !(flavour === 'official' && isOfficialDenied(f)));
}

function trackedFiles(rel) {
  const run = spawnSync('git', ['-C', repo, 'ls-files', '-z', '--', rel], { encoding: 'utf8' });
  if (run.error) fail(`could not run git ls-files for ${rel}: ${run.error.message}`);
  if (run.status !== 0) fail(`git ls-files failed for ${rel}: ${(run.stderr || '').trim()}`);
  const files = (run.stdout || '').split('\0').filter(Boolean);
  // A folder that is all Zumi-only (the default room) is simply absent from a source export; that build is the public flavour.
  if (files.length === 0 && !isZumiOnly(rel)) fail(`git ls-files lists no tracked files under ${rel} (is this a git checkout?)`);
  return files;
}

function copyTracked(rel) {
  const files = stagedTrackedFiles(rel, { flavour: flavourArg(), measureStub: process.argv.includes('--measure-stub') });
  for (const f of files) {
    const src = path.join(repo, f);
    if (!fs.existsSync(src)) fail(`tracked file is missing from the working tree: ${f}`);
    const dest = path.join(stage, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return files.length;
}

function dirSize(dir) {
  let total = 0;
  for (const rel of walk(dir)) total += fs.statSync(path.join(dir, rel)).size;
  return total;
}

function flavourArg(argv = process.argv) {
  const i = argv.indexOf('--flavour');
  const name = i >= 0 ? argv[i + 1] : 'owner'; // build.ps1's default (CoS 28-10, fix round 1 B2): public needs --flavour public
  if (!['public', 'official', 'owner', 'selftest'].includes(name)) fail(`--flavour must be public|official|owner|selftest, got ${name}`);
  return name;
}

function main() {
  const vault = vaultExePath();
  if (!fs.existsSync(vault)) {
    fail(`${vault} is missing: run \`cargo build --release --bin zumi-vault\` first (it must sit beside the main exe)`);
  }

  fs.mkdirSync(stage, { recursive: true });
  // Clear a previous staging run, keeping the tracked placeholder that keeps the directory present on a clean checkout.
  for (const entry of fs.readdirSync(stage)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(stage, entry), { recursive: true, force: true });
  }

  // 1. the vault helper: beside the main exe (the sidecar refuses it from anywhere else)
  fs.copyFileSync(vault, path.join(stage, 'zumi-vault.exe'));

  // 2. the sidecar and the src/main modules it imports unchanged, from git's tracked list only
  const sidecarFiles = copyTracked('tauri/sidecar');
  const mainFiles = copyTracked('src/main');

  // 3b. the scenes manifest + chair plate. The Rust asset route resolves `scenes/<id>.mp4` through
  // assets/rooms-video/rooms.json (Electron's mapping, asset_route.rs), so a packaged app needs that file and the plate
  // in the resource root. Without them the dev-tree fallback hid the gap: an install has no repo to fall back to.
  const sceneAssetFiles = copyTracked('assets/rooms-video');

  // 3c. the 3D chair manifest + GLBs + the no-chair plate. Electron's build.files ships `assets/**`, so its packaged
  // app has these; without them the sidecar logged "chairs manifest refused: ENOENT" and the chair picker was empty.
  const chairAssetFiles = copyTracked('assets/chair3d');

  // 3c2. what Electron's build.files / extraResources also ship and the sidecar reads from its resource root: the pinned
  // Laneboard core (adapters.mjs laneboardDir -> vendor/laneboard: without it the Board tab and the selftest board part
  // never load), the pinned v2 default room (resources-pinned/room-v2: without it the default room never loads), and
  // the rest of assets/** (models, clips). Box re-probe 2ef16d1, finding 5.
  const laneboardFiles = copyTracked('vendor/laneboard');
  const pinnedRoomFiles = copyTracked('resources-pinned/room-v2');
  const modelFiles = copyTracked('assets/models');
  const clipFiles = copyTracked('assets/clips');

  // 3c3. the default Zumi model (parity with Electron 0.2.9 afterPack): a restrictive asset that is NEVER in git, injected from
  // ZUMI_DEFAULT_VRM_PATH (PIN-MANIFEST.json) with its credits notice. Missing/wrong source = no bundle (same as Electron).
  // Owner / selftest flavour only (open-core ADR 2026-10-28): the public flavour ships no avatar and boots on the empty stage
  // ("Open VRM file…"); verifyStagedFlavour fails a public stage that holds any Zumi-only file.
  const flavour = flavourArg();
  if (flavour !== 'public') {
    try { stageIntoTauriBundle(stage); } catch (e) { fail(e.message); }
    const modelProblems = verifyStagedDefaultModel(stage);
    if (modelProblems.length) fail(modelProblems.join('; '));
  }

  // 3c4. flavour.json at the resource root (beside the exe, where the host looks; owner / selftest only, P3-A) and the 7 room
  // videos in <resources>/rooms-video, size+sha256 pinned by rooms.json (owner, selftest and official). The public flavour stages
  // neither, and verifyStagedFlavour fails a stage that holds either by mistake.
  let roomVideos = 0;
  stageFlavourFile(stage, flavour);
  stripOfficialManifest(stage, flavour);
  // 3c5. T-31 3a-3 (GATE-SEC C4): next-ui.json beside the host exe, ONLY when the renderer was built with the next-version UI. The sidecar reads it
  // (fail-closed) to decide whether Brain's three board calls exist. flavour.json and verifyStagedFlavour are not touched.
  stageNextUiFlag(stage, path.join(repo, 'build', 'renderer'));
  // Owner / selftest builds carry the 7 built-in rooms. The official installer carries none since the slim installer (owner 11-11
  // mkt-q1, T-31-ROOM-slim): they install from the Marketplace as room.<id> packs.
  if (flavour !== 'public' && flavour !== 'official') {
    try { roomVideos = stageRoomVideos(stage).count; } catch (e) { fail(e.message); }
  }
  const flavourProblems = verifyStagedFlavour(stage, flavour);
  if (flavourProblems.length) fail(flavourProblems.join('; '));

  // 3c5. the credit files, at the resource root like Electron's extraResources (0.2.11): CC BY / Apache-2.0 attribution has to
  // reach the installed app. Repo files (the gate check-tauri-third-party.mjs fails on an untracked one).
  // licenses/GPL-3.0.txt: the full GPL text for the eSpeak NG code inside phonemizer (credited in THIRD_PARTY_LICENSES.md).
  for (const f of CREDIT_FILES) {
    if (flavour === 'public' && isZumiOnly(f)) continue;
    const src = path.join(repo, f);
    if (!fs.existsSync(src)) fail(`credit file is missing from the working tree: ${f}`);
    fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    fs.copyFileSync(src, path.join(stage, f));
    // owner ruling 28-10: the public copy names no room-image provenance (scripts/lib/public-credits.cjs)
    if (flavour === 'public' && f === 'THIRD_PARTY_LICENSES.md') toPublicCredits(path.join(stage, f));
  }

  // 3d. NOT scripts/*: electron-builder's build.files has no `scripts/**`, and the Tauri bundle matches that on purpose.

  // 4. the voice modules, copied with the SAME filters electron-builder uses (package.json build.extraResources), so
  // the Tauri bundle cannot drift from the Electron one.
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const voiceEntries = (pkg.build && pkg.build.extraResources ? pkg.build.extraResources : []).filter(
    (e) => typeof e.to === 'string' && e.to.startsWith('voice-modules/'),
  );
  if (voiceEntries.length !== 6) fail(`package.json has ${voiceEntries.length} voice-modules extraResources entries, expected 6`);
  let voiceFiles = 0;
  // Owner 02-11: the public installer carries no Kokoro; it installs from the Marketplace. The owner build keeps it, so his voice does not change.
  if (flavour !== 'public' && flavour !== 'official') for (const entry of voiceEntries) {
    voiceFiles += copyFiltered(path.join(repo, entry.from), path.join(stage, entry.to), entry.filter || ['**/*']);
  }

  // 5. the required native files must be where the packaged resolver looks for them.
  const onnxBinding = path.join(
    stage, 'voice-modules', 'node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-node',
    'bin', 'napi-v3', 'win32', 'x64', 'onnxruntime_binding.node',
  );
  if (flavour !== 'public' && flavour !== 'official' && !fs.existsSync(onnxBinding)) fail(`staged bundle has no onnxruntime win32/x64 binding: ${onnxBinding}`);

  // 6. what an install must hold, for the mixed-install notice (updater.rs): NSIS has no rollback, so a locked file can leave old bytes
  // beside a new exe. The file itself is checked like the rest of the install: an old copy lists hashes the new files do not match.
  stageInstallManifest(stage);

  const total = dirSize(stage);
  const count = walk(stage).length;
  console.log(`stage-bundle: ${count} files (${(total / 1048576).toFixed(1)} MiB) in ${stage}`);
  console.log(`  sidecar ${sidecarFiles}  src/main ${mainFiles}  scenes ${sceneAssetFiles}  chair3d ${chairAssetFiles}  laneboard ${laneboardFiles}  room-v2 ${pinnedRoomFiles}  models ${modelFiles}  clips ${clipFiles}  voice-modules ${voiceFiles}  flavour ${flavour}  room-videos ${roomVideos}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
