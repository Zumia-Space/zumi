'use strict';
// Zumi-only assets (open-core ADR 2026-10-28, worklist B4): the app code is AGPL, these files are not. They ship in the OWNER
// builds only and never in a PUBLIC payload, in either build (Electron scripts/builder-public.cjs; Tauri stage-bundle.mjs and
// prep-ui.mjs with --flavour public). Both licence gates and scripts/check-public-payload.mjs read this one list.
// Paths are posix, relative to the repo or to the bundle root (the Tauri gate keys the injected avatar as models/<file>).
// `**` = any depth, `*` = within one segment; `<dir>/**` also matches the folder itself (an extraResources `from`).
const ZUMI_ONLY = Object.freeze([
  '**/*.vrm', // the default avatar (E13: a .vrm in a public payload is a hard fail)
  '**/LICENSE-zumi-default.txt', // the avatar's own notice travels with it
  'resources-pinned/room-v2/**', // the default room (Night City): room data + the three painted plates
  'tauri/ui/rooms/default-v2/**', // the same room, as prep-ui lays it out in the Tauri frontendDist
  'assets/chair3d/talk-plate-nochair.png', // room plate (chair cut out) of the 3D-chair talk view
  'tauri/ui/chair3d/plate-nochair.png', // the same plate in the Tauri frontendDist
  'assets/rooms-video/chair-talk.png', // the painted chair plate of the video rooms
  '**/*.mp4', // the room video clips
  '**/*.MP4', // the same, upper-case (globToRe is case-sensitive)
  '**/pricing-zumi.webp', // the Pricing hero image: a render of the default avatar in the default room (assets/pricing/, build/renderer/next/, tauri/ui/next/)
  'ASSETS-LICENSE.md', // the Zumi-only use terms of the files above (owner builds only)
  '**/redact-seed-owner.json', // the owner's first-run redact list: real client names (src/main/board-redact.mjs SEED_NAMES)
  '**/owner-values.json', // the owner machines' paths and hosts (src/main/owner-values.js): open roots, dev rooms, build inputs
]);

const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\/\*\*$/, '\u0003').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*')
  .replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*').replace(/\u0003/g, '(?:/.*)?') + '$');
const RES = ZUMI_ONLY.map(globToRe);

// The 7 built-in video rooms (owner 03-11: the 7 rooms he approved are the default rooms), by exact name. Since the slim installer
// (owner 11-11, mkt-q1; T-31-ROOM-slim) they ship as Marketplace packs room.<id>, never inside the official installer; this list is
// what scripts/market-pack-rooms.mjs packs. Each is pinned by size and sha256 in assets/rooms-video/rooms.json; check:public-payload
// O2b keeps this list equal to its files.
const OFFICIAL_ROOM_VIDEOS = Object.freeze([
  '01-cozy-study.mp4',
  '02-scifi-bridge.mp4',
  '03-zen-garden-room.mp4',
  '04-rooftop-night-city.mp4',
  '05-grand-library.mp4',
  '06-beach-cabin-studio-2710.mp4',
  '07-space-station-window.mp4',
]);

// The official installer (ASSET-REVIEW 2026-11-02; slim since owner 11-11 mkt-q1, T-31-ROOM-slim): public code plus exactly these
// Zumi-only files. Night City (resources-pinned/room-v2 + its no-chair plate) and the 7 room videos are Marketplace packs now. Other
// avatars and the owner files stay out. The source export still drops all of them (PUBLIC_REPO_EXCLUDE): a source build has no
// .vrm and no room video, only this installer may.
const OFFICIAL_ALLOWED = Object.freeze([
  'assets/rooms-video/chair-talk.png', // the chair plate a video room pack is drawn under (scene-rooms.mjs `chair`, 1 MB)
  '**/zumi-default-*.vrm', // pinned by size and sha256 (scripts/lib/default-vrm.cjs)
  '**/LICENSE-zumi-default.txt',
  '**/pricing-zumi.webp',
  'ASSETS-LICENSE.md',
]);
const OFFICIAL_RES = OFFICIAL_ALLOWED.map(globToRe);

// Paths that must also stay out of the PUBLIC SOURCE REPO (the F1 export and its history; B9 plan), on top of ZUMI_ONLY.
// No build ships them today; this list is what the export must drop. CoS security decision 28-10.
const PUBLIC_REPO_EXCLUDE = Object.freeze([
  ...ZUMI_ONLY,
  'vendor/laneboard/scripts/**', // Laneboard dev/ops scripts (B3): mint-lane-tokens.mjs, a VPS cutover script
  // Electron safeStorage fixture of the vault check (tauri/verify/vault-fixture-check.mjs): fake key blobs + .last4 files that
  // secret scanners flag, a DPAPI-wrapped Local State bound to one Windows user, a README naming the host and user. A public
  // vault test regenerates its own fixture later, on a throwaway VM user.
  'tauri/verify/fixtures/electron-userdata/**',
  // internal board rows of the board-open checks (check-board-open-owner / -electron); fix round 1, CoS 28-10
  'scripts/fixtures/asks-1010/rows/**',
  // P0 scrub (T-31, CoS mail 707bdc5c9f95): owner-only files, dropped whole instead of rewritten
  'scripts/lib/public-p0.cjs', // the export's P0 guard list: it names what it guards (owner paths, hosts, client names)
  'scripts/check-parity.mjs', // sshes to the LIVE board (owner tooling)
  'scripts/check-board-open-electron.mjs', // drive the owner's board CLI + the rows fixture excluded above
  'scripts/check-board-open-owner.mjs',
  'scripts/check-board-links.mjs', // the owner's live-board links
  'scripts/fixtures/board-urls.json',
  'scripts/shot-board-roles.mjs', // screenshots of the owner's live board UI
  'scripts/shot-laneboard-owner-ui.mjs',
  'scripts/box-e2e-update.mjs', // the owner's render-box soak run
  'scripts/market-pack-rooms.mjs', // builds the store's room packs from the owner's room videos (owner values roomsVideoDir); store tooling
  'scripts/slim-installer-run.mjs', // built-app probes A/B/C on the spare box (slim installer release gate)
  'tauri/stage-preview-kit.ps1', // the owner's preview-kit release staging
  'tauri/verify/VAULT-BOX-RUNBOOK.md', // render-box runbook
  'scripts/box/**', // render-box job scripts (the box's own folder layout)
  'tauri/verify/vault-fixture-writer.cjs', // box-only fixture writer (spare PC); its output and runbook are excluded above
  'BUG_PATTERNS_KNOWN.md', // internal incident log
  'RELEASE-0.2.11.md', // internal release record
  'scripts/fixtures/float-holo/toe-*.png', // crops of the default avatar in the default room (SCAN-1 S3)
  'docs/migration/*.md', // migration reports and plans (internal process records). The .json files stay: gen-allowlist and the shim read them
  'docs/agents/**', // the owner's agent workflow
  'docs/decisions/**', // internal decision records
  'docs/MAINTAINERS-preview-kit.md', // internal TODOs
  'scripts/check-kokoro-live-precond.mjs', // names the owner's hosts
  // need the guard list above, which is owner-only; they run from the maintainers' tree, on the export
  'scripts/check-public-payload.mjs',
  'scripts/export-public-source.mjs',
  'scripts/check-export.mjs',
  'scripts/check-agent-guide-hook.mjs', // its check; the export drops the npm script line with it
  // release notes that speak to the owner; the current version's are written for the public and the gate reads them
  'release-notes/0.2.*.md',
  ...Array.from({ length: 13 }, (_, i) => `release-notes/0.3.0-alpha.${i + 1}.md`),
]);
const REPO_RES = PUBLIC_REPO_EXCLUDE.map(globToRe);
// ...except the two Laneboard scripts the app runs (src/main/laneboard-host.mjs: first-run seed, v0.2 import); every build
// ships them, so the public source keeps them too (check:public-payload E9).
const PUBLIC_REPO_KEEP = Object.freeze(['vendor/laneboard/scripts/seed.mjs', 'vendor/laneboard/scripts/migrate-from-legacy.mjs']);

/** Is this payload path (posix or Windows separators) a Zumi-only asset? */
function isZumiOnly(p) {
  const s = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  return RES.some((re) => re.test(s));
}

/** May this payload path NOT ship in the official installer? */
function isOfficialDenied(p) {
  const s = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  return isZumiOnly(s) && !OFFICIAL_RES.some((re) => re.test(s));
}

/** Must this repo path stay out of the public source repo (and its history)? */
function isPublicRepoExcluded(p) {
  const s = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  return !PUBLIC_REPO_KEEP.includes(s) && REPO_RES.some((re) => re.test(s));
}

module.exports = { ZUMI_ONLY, isZumiOnly, PUBLIC_REPO_EXCLUDE, isPublicRepoExcluded, isOfficialDenied, OFFICIAL_ROOM_VIDEOS };
