// T-31 parity 7-1: check a staged or BUILT preview bundle directory.
//
//   node tauri/verify/check-bundle.mjs --dir <bundle dir>
//   node tauri/verify/check-bundle.mjs            (default: tauri/src-tauri/target/unpacked, made by build.ps1)
//
// Two directory shapes are accepted, because the exe and the resources are produced by different steps:
//   - a STAGED resources dir (tauri/src-tauri/bundle, made by tauri/stage-bundle.mjs): zumi-vault.exe,
//     tauri/sidecar/, src/main/, voice-modules/ -- but no main exe yet;
//   - a BUILT app dir (target\unpacked assembled by build.ps1, or a real install): the same resources PLUS the main
//     exe, with zumi-vault.exe beside it. Tauri's NSIS bundle leaves no unpacked directory on Windows, so build.ps1
//     assembles target\unpacked from the release build and the staged resources.
//
// Asserts, against a real directory rather than the source tree:
//   - node.exe is ABSENT (node-bundle option (c): the host finds/downloads Node at runtime; nothing may ship a runtime);
//   - zumi-vault.exe sits at the resource root, beside the main exe when one is present (the sidecar refuses it from
//     anywhere else -- step 5 gate condition 2); a staged dir reports the main exe as skipped, never invented;
//   - the onnxruntime native binding (.node) is in the voice modules (Kokoro's CPU inference);
//   - no .env or secret-bearing files shipped;
//   - no measure-stub (the measurement-only chat provider, tauri/sidecar/measure-stub.mjs): neither the file nor its marker
//     string may be in the dir, so it cannot reach a public bundle or an installer payload (build.ps1 runs this on the stage
//     before the installer is made). Only the unpacked dir of a -MeasureStub build passes --allow-measure-stub;
//   - THIRD_PARTY_LICENSES.md and NOTICE sit at the resource root (attribution must reach the installed app);
//   - prints the installed size.
//
// Exit 0 only when every assertion passes (a skipped main exe is not a failure: the staging step cannot make an exe).
// No network, no window, no Electron.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { verifyStagedFlavour } from '../flavour-stage.mjs';

const { verifyStagedDefaultModel } = createRequire(import.meta.url)('../../scripts/lib/default-vrm.cjs');

const repo = path.resolve(import.meta.dirname, '..', '..');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const allowMeasureStub = process.argv.includes('--allow-measure-stub');
const STUB_MARKER = ['ZUMI_MEASURE', 'STUB_7c1e'].join('_'); // = MEASURE_STUB_MARKER in the stub; split so this file does not carry the literal (check-tauri-measure-stub allows it in one tracked file only)
const MARKER_SCAN = /\.(?:mjs|cjs|js|json|html|css|map|txt|md)$/i; // text files only: the voice modules hold hundreds of MB of binaries
const bundleDir = path.resolve(argValue('--dir') || path.join(repo, 'tauri', 'src-tauri', 'target', 'unpacked'));

let pass = 0;
let fail = 0;
let skipped = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const skip = (name, detail = '') => {
  skipped++;
  console.log(`SKIP ${name} ${detail}`);
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Files that must never ship. `.env` is the rule from the brief; the rest are the secret-bearing names this app uses
// (DPAPI blobs live in the DATA dir, never the bundle) plus common certificate/key containers. Matched on the basename;
// data-file extensions keep source modules such as secret-stores.mjs from being mistaken for a secret. flavour.json is
// NOT matched: owner/selftest builds write it beside the exe on purpose (tauri/write-flavour.mjs).
const SECRET_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|secrets?(?:[-_.].*)?\.(?:json|txt|ya?ml|dat|bin|enc)|credentials?(?:[-_.].*)?(?:\.(?:json|txt|ya?ml|dat|bin|enc))?|owner-voice\.json|id_(?:rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(?:pem|pfx|p12|key|keystore|snk))$/i;

function main() {
  console.log(`check-bundle: ${bundleDir}`);
  if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
    console.log(`FAIL bundle directory exists ${bundleDir}`);
    console.log('check-bundle FAIL — build the app first (tauri\\build.ps1 -Flavour owner, or -Flavour public for a public kit), then point --dir at the unpacked bundle');
    process.exit(1);
  }

  const mainExe = path.join(bundleDir, ['public', 'official'].includes(argValue('--flavour') || (fs.existsSync(path.join(bundleDir, 'flavour.json')) ? 'owner' : 'public')) ? 'Zumi.exe' : 'ZumiPreview.exe');
  const stagedSidecar = path.join(bundleDir, 'tauri', 'sidecar', 'main.mjs');
  const hasMainExe = fs.existsSync(mainExe);
  // A staged resources dir (stage-bundle.mjs) is a legitimate 7-1 target: it cannot contain the app exe, which the
  // Tauri build only adds later. Anything that is neither an app dir nor a staged dir is a hard failure.
  const stagedOnly = !hasMainExe && fs.existsSync(stagedSidecar);
  if (hasMainExe) ok(true, 'the main exe is in the bundle', mainExe);
  else if (stagedOnly) skip('the main exe is in the bundle', '(staged resources dir: the exe is added by the Tauri build)');
  else ok(false, 'the main exe is in the bundle', mainExe);

  // ---- 1. no Node runtime anywhere in the bundle (provisioned at runtime, per user) ----
  const nodeBinaries = walk(bundleDir).filter((f) => /^node(?:\.exe)?$/i.test(path.basename(f)));
  ok(nodeBinaries.length === 0, 'the bundle carries NO node.exe (it is found or downloaded at runtime)', nodeBinaries.map((f) => path.relative(bundleDir, f)).join('; '));
  ok(!fs.existsSync(path.join(bundleDir, 'node')), 'the bundle has no node/ runtime directory');

  // ---- 2. zumi-vault.exe at the resource root, beside the main exe when there is one ----
  const vault = path.join(bundleDir, 'zumi-vault.exe');
  ok(fs.existsSync(vault), 'zumi-vault.exe sits beside the main exe', vault);
  const strayVaults = walk(bundleDir).filter((f) => path.basename(f).toLowerCase() === 'zumi-vault.exe' && path.dirname(f) !== bundleDir);
  ok(strayVaults.length === 0, 'no zumi-vault.exe outside the main exe directory', strayVaults.join(', '));

  // ---- 3. the onnxruntime native binding ----
  const expectedBinding = path.join(
    bundleDir, 'voice-modules', 'node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-node',
    'bin', 'napi-v3', 'win32', 'x64', 'onnxruntime_binding.node',
  );
  const anyBinding = walk(bundleDir).filter((f) => /onnxruntime_binding\.node$/i.test(f) && /win32[\\/]x64/i.test(f));
  // A public bundle ships no voice modules: Kokoro installs from the Marketplace. Anything else must carry them.
  const publicBundle = ['public', 'official'].includes(argValue('--flavour') || (fs.existsSync(path.join(bundleDir, 'flavour.json')) ? 'owner' : 'public'));
  if (publicBundle) {
    ok(!fs.existsSync(path.join(bundleDir, 'voice-modules')) && anyBinding.length === 0, 'a public bundle carries no voice modules', `found ${anyBinding.length}`);
  } else {
    ok(fs.existsSync(expectedBinding), 'the onnxruntime win32/x64 binding is in the voice modules', expectedBinding);
    ok(anyBinding.length > 0, 'at least one onnxruntime win32/x64 .node binary ships', `found ${anyBinding.length}`);
  }

  // ---- 3b. the default Zumi model + its credits notice (parity with Electron 0.2.9; pinned size+sha256, never in git) ----
  // --pin <file>: test seam for fixture dirs only (scripts/check-tauri-measure-stub.mjs); a real build never passes it.
  // Owner builds only (open-core ADR 2026-10-28): a --flavour public bundle must NOT carry it (3c, verifyStagedFlavour).
  // No --flavour (stage-preview-kit.ps1, check-bundle-staged.mjs, npm run check:tauri-bundle): the dir says which. Only owner /
  // selftest write flavour.json, so a dir without it is a public one and is not asked for the model; a dir with it still is.
  const pinArg = argValue('--pin');
  const modelFlavour = argValue('--flavour') || (fs.existsSync(path.join(bundleDir, 'flavour.json')) ? 'owner' : 'public');
  if (!argValue('--flavour')) console.log(`flavour (no --flavour): ${modelFlavour}, flavour.json ${modelFlavour === 'public' ? 'absent' : 'present'}`);
  if (modelFlavour === 'public') skip('the bundle ships the pinned default model', `(public flavour: Zumi-only${argValue('--flavour') ? ', asserted absent in 3c' : ''})`);
  else {
    const modelProblems = verifyStagedDefaultModel(bundleDir, pinArg ? JSON.parse(fs.readFileSync(pinArg, 'utf8')) : undefined);
    ok(modelProblems.length === 0, 'the bundle ships the pinned default model and its credits notice', modelProblems.join('; '));
  }

  // ---- 3b2. room v1 ("Zumi's Office") was removed (owner rejected it, 2026-10-26): no flavour may ship it ----
  ok(!fs.existsSync(path.join(bundleDir, 'resources-pinned', 'room-v1')), 'the bundle ships no room v1 (resources-pinned/room-v1 removed)');
  // the room importer's test-only .glb fixture (the old v1 room.glb, read from ZUMI_ROOM_DEFAULT_PATH / the dev box by the
  // selftest) and its generated fixtures are never packaged: this gate also runs on the EXTRACTED installer payload (build.ps1)
  const roomFixtures = walk(bundleDir).filter((f) => /^(room|good|too-big|external-image|draco|big-texture|bad-magic|missing-anchors)\.glb$/i.test(path.basename(f)) || /[\/]room-fixtures[\/]/i.test(f));
  ok(roomFixtures.length === 0, 'the bundle ships no room .glb test fixture (room.glb / good.glb / room-fixtures)', roomFixtures.slice(0, 5).join(', '));

  // ---- 3c. flavour (P3-A): --flavour public|owner|selftest. public = no flavour.json and no rooms-video; owner/selftest =
  // the pinned flavour.json and all 7 pinned room videos. Absent flag = no flavour assertion (older callers).
  const flavourArg = argValue('--flavour');
  if (flavourArg) {
    const flavourProblems = verifyStagedFlavour(bundleDir, flavourArg);
    ok(flavourProblems.length === 0, `the bundle matches the ${flavourArg} flavour (flavour.json + room videos; public: no Zumi-only asset)`, flavourProblems.join('; '));
  } else skip('the bundle matches a flavour', '(no --flavour given)');
  if (flavourArg === 'official') {
    for (const rel of ['LICENSE', 'NOTICE']) ok(fs.existsSync(path.join(bundleDir, rel)), `the official bundle ships ${rel}`);
    // Slim installer (owner 11-11 mkt-q1, T-31-ROOM-slim): Night City is the room.night-city Marketplace pack.
    for (const rel of ['resources-pinned/room-v2', 'rooms-video', 'assets/chair3d/talk-plate-nochair.png']) ok(!fs.existsSync(path.join(bundleDir, rel)), `the slim official bundle has no ${rel} (a Marketplace pack)`);
  }

  // ---- 3d. the credit files ship (CC BY / Apache-2.0 attribution must reach the user; the Electron 0.2.11 sweep found both missing) ----
  for (const f of ['THIRD_PARTY_LICENSES.md', 'NOTICE', 'licenses/GPL-3.0.txt']) {
    const credit = path.join(bundleDir, f);
    ok(fs.existsSync(credit) && fs.statSync(credit).size > 0, `the bundle ships ${f} at the resource root`, credit);
  }
  // ASSETS-LICENSE.md (Zumi-only use terms): owner builds only; a public bundle must not carry it (3c asserts the absence)
  if (flavourArg && flavourArg !== 'public') ok(fs.existsSync(path.join(bundleDir, 'ASSETS-LICENSE.md')), `the ${flavourArg} bundle ships ASSETS-LICENSE.md at the resource root`);

  // ---- 4. no .env or secret-bearing files ----
  const allFiles = walk(bundleDir);
  const secrets = allFiles.filter((f) => SECRET_FILE.test(path.basename(f)));
  ok(secrets.length === 0, 'no .env or secret-bearing files in the bundle', secrets.slice(0, 20).map((f) => path.relative(bundleDir, f)).join(', '));

  // ---- 5. the measure stub is not in the bundle ----
  if (allowMeasureStub) skip('no measure-stub marker in the bundle', '(--allow-measure-stub: a -MeasureStub measurement build)');
  else {
    const stubHits = allFiles.filter((f) => path.basename(f).toLowerCase() === 'measure-stub.mjs'
      || (MARKER_SCAN.test(f) && fs.statSync(f).size < 8 * 1048576 && fs.readFileSync(f).includes(STUB_MARKER)));
    ok(stubHits.length === 0, 'no measure-stub marker in the bundle', stubHits.slice(0, 5).map((f) => path.relative(bundleDir, f)).join(', '));
  }

  // ---- 6. installed size ----
  const total = allFiles.reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(`installed size: ${(total / 1048576).toFixed(1)} MiB (${total} bytes, ${allFiles.length} files)`);

  console.log(`check-bundle ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail + skipped} assertions passed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
