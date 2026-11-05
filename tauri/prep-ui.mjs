// T-31 P1a — assemble tauri/ui, the folder Tauri embeds as `frontendDist`.
//
// The Electron app serves the renderer over a private `app://zumi/` scheme, resolving assets through
// src/main/main.js's protocol handler (tokens.css from the pinned Laneboard, the default room from
// its own validated copy, clips from assets/clips). Tauri serves a plain static folder, so this
// script flattens all of that into one tree and injects the generated shim:
//
//   ui/
//     index.html app.js styles.css hud.css tokens.css brand/ gestures/ speech/   (the renderer bundle)
//     clips/                     sit-idle.vrma, sit-work.vrma
//     models/                    the bundled .vrm files models.json lists (step 3)
//     chair3d/                   <id>.glb + plate-nochair.png (step 3)
//     rooms/default-v2/          the pinned v2 room switchRoom() fetches
//     zumi-shim.js               GENERATED from docs/migration/api-inventory.json (see shim/)
//     webview-element.js         hand-written <webview> element stand-in (tauri/shim/)
//
// index.html is the SAME file the Electron build ships (build/renderer/index.html); this script only
// inserts the two <script> tags above the renderer bundle, in the copy. src/renderer is never touched.
//
// Usage: node tauri/prep-ui.mjs [--renderer <dir>] [--out <dir>] [--flavour public|official|owner|selftest]
//
// --flavour public (tauri/build.ps1 passes its -Flavour) leaves out every Zumi-only asset (scripts/lib/zumi-only.cjs: bundled
// .vrm files, the no-chair plate, the default v2 room; open-core ADR 2026-10-28). No flag = everything, as before (dev checks);
// check-tauri-third-party.mjs --flavour public fails a frontendDist that still holds one.
//
// --out defaults to tauri/ui (the folder Tauri embeds). Pass a scratch dir to assemble without
// touching tauri/ui — scripts/check-tauri-guest.mjs does this so a check can never clobber the
// real frontendDist.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateShim } from './shim/generate-shim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const args = process.argv.slice(2);
const optAt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const rendererDir = path.resolve(optAt('--renderer') || path.join(root, 'build', 'renderer'));
const uiDir = path.resolve(optAt('--out') || path.join(here, 'ui'));
const publicFlavour = optAt('--flavour') === 'public';
const officialFlavour = optAt('--flavour') === 'official'; // the default model comes from the stage; no other avatar

const fail = (m) => { console.error(`prep-ui: ${m}`); process.exit(1); };
const copyDir = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
};
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

if (!fs.existsSync(path.join(rendererDir, 'app.js'))) fail(`renderer bundle missing at ${rendererDir} — run: npm run build:renderer`);

// 1. Fresh ui/ from the renderer bundle.
fs.rmSync(uiDir, { recursive: true, force: true });
fs.mkdirSync(uiDir, { recursive: true });
copyDir(rendererDir, uiDir);
// The Pricing hero image is a render of the default avatar (scripts/lib/zumi-only.cjs): a public frontendDist has none; pricing.js then drops the figure.
if (publicFlavour) fs.rmSync(path.join(uiDir, 'next', 'pricing-zumi.webp'), { force: true });

// 2. tokens.css: the pinned Laneboard sheet the app shell reads (served at app://zumi/tokens.css in Electron).
fs.copyFileSync(path.join(root, 'vendor', 'laneboard', 'public', 'tokens.css'), path.join(uiDir, 'tokens.css'));

// 3. clips (assets/clips) — .vrma/.fbx only, the filter listClips() uses.
const clipsSrc = path.join(root, 'assets', 'clips');
if (fs.existsSync(clipsSrc)) {
  fs.mkdirSync(path.join(uiDir, 'clips'), { recursive: true });
  for (const f of fs.readdirSync(clipsSrc)) {
    if (/\.(vrma|fbx)$/i.test(f)) fs.copyFileSync(path.join(clipsSrc, f), path.join(uiDir, 'clips', f));
  }
}

// 3b. bundled models (assets/models): listModels() answers `<origin>/models/<file>`, so lay the manifest-listed
//     .vrm files out at models/. Only files readManifest() would accept (models-core.js) are copied.
const modelsSrc = path.join(root, 'assets', 'models');
if (!publicFlavour && !officialFlavour && fs.existsSync(path.join(modelsSrc, 'models.json'))) {
  const list = (JSON.parse(fs.readFileSync(path.join(modelsSrc, 'models.json'), 'utf8')).models) || [];
  for (const m of list) {
    if (!m || typeof m.file !== 'string' || !/^[\w.-]+\.vrm$/i.test(m.file) || !fs.existsSync(path.join(modelsSrc, m.file))) continue;
    fs.mkdirSync(path.join(uiDir, 'models'), { recursive: true });
    fs.copyFileSync(path.join(modelsSrc, m.file), path.join(uiDir, 'models', m.file));
  }
}

// 3c. 3D chairs (assets/chair3d): chairs.list() answers `<origin>/chair3d/<id>.glb` and `.../plate-nochair.png`
//     (chair3d.mjs resolvePath names), so copy each chairs.json file under those names.
const chairSrc = path.join(root, 'assets', 'chair3d');
if (fs.existsSync(path.join(chairSrc, 'chairs.json'))) {
  const man = JSON.parse(fs.readFileSync(path.join(chairSrc, 'chairs.json'), 'utf8'));
  fs.mkdirSync(path.join(uiDir, 'chair3d'), { recursive: true });
  if (!publicFlavour && man.noChairPlate && man.noChairPlate.file) fs.copyFileSync(path.join(chairSrc, man.noChairPlate.file), path.join(uiDir, 'chair3d', 'plate-nochair.png'));
  for (const c of man.chairs || []) if (/^[a-z0-9-]+$/.test(c.id)) fs.copyFileSync(path.join(chairSrc, c.file), path.join(uiDir, 'chair3d', `${c.id}.glb`));
}

// 4. the default v2 room — served (and sha-checked) from the app's own copy in Electron; static here.
const roomSrc = path.join(root, 'resources-pinned', 'room-v2');
if (publicFlavour) console.log('prep-ui: public flavour -- no default room, no plates, no bundled .vrm (Zumi-only assets)');
else if (fs.existsSync(roomSrc)) {
  copyDir(roomSrc, path.join(uiDir, 'rooms', 'default-v2'));
  // stripOfficialUiManifest: the app never reads it, and its notes name a path on the owner's machine.
  if (officialFlavour) fs.rmSync(path.join(uiDir, 'rooms', 'default-v2', 'PIN-MANIFEST.json'), { force: true });
}
else console.warn('prep-ui: resources-pinned/room-v2 missing — the room switch will have no default');

// 5. the shims, loaded before the renderer bundle: the generated window.zumi bridge, then the
//    <webview> element stand-in (which needs the Tauri bridge the first shim installs).
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'migration', 'api-inventory.json'), 'utf8'));
fs.writeFileSync(path.join(uiDir, 'zumi-shim.js'), generateShim(inventory));
fs.copyFileSync(path.join(here, 'shim', 'webview-element.js'), path.join(uiDir, 'webview-element.js'));

// The renderer's own <meta> CSP does not allow Tauri's IPC origin. Tauri also sets a CSP header from
// tauri.conf.json, but when two policies apply the browser enforces the intersection, so the meta
// would still block IPC. Extend ONLY the meta's connect-src with the two IPC sources (Windows uses
// http://ipc.localhost, other platforms ipc:); nothing else in the policy changes. Keep in sync with
// app.security.csp in tauri/src-tauri/tauri.conf.json.
const IPC_CONNECT_SRC = 'ipc: http://ipc.localhost';
const allowTauriIpc = (html) => html.replace(/connect-src ([^;"]*);/, (match, sources) =>
  (sources.includes('ipc:') ? match : `connect-src ${sources.trim()} ${IPC_CONNECT_SRC};`));

// 6. inject the shim <script> tags into the COPY of index.html, just above the renderer bundle.
//    Order matters: zumi-shim defines the bridge, webview-element wraps createElement, then app.js runs.
const idxPath = path.join(uiDir, 'index.html');
const idx = allowTauriIpc(fs.readFileSync(idxPath, 'utf8'));
const anchor = '<script src="app.js"></script>';
if (!idx.includes(anchor)) fail(`index.html has no "${anchor}" — renderer bundle layout changed?`);
fs.writeFileSync(idxPath, idx.replace(anchor, `<script src="zumi-shim.js"></script>\n  <script src="webview-element.js"></script>\n  ${anchor}`));

console.log(`prep-ui: ui/ assembled at ${path.relative(root, uiDir)}`);
console.log(`prep-ui: renderer app.js ${kb(fs.statSync(path.join(uiDir, 'app.js')).size)}, shim ${(inventory.apis || []).length} names`);
