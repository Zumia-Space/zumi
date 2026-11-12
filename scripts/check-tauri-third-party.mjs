// Third-party licence gate for the TAURI bundle (T-31-TAURI preview.3). Mirror of the Electron check:third-party
// (fix/T-31-0211-licenses 0f492037), over EVERY root the Tauri build ships, each file listed exactly:
//   - tauri.conf.json: build.frontendDist must be ../ui and bundle.resources exactly {"bundle/": ""}; anything else FAILS;
//   - frontendDist (tauri/ui, embedded in the exe): every file on disk, untracked ones included;
//   - the staged tree (tauri/src-tauri/bundle): the git-tracked files of every copyTracked('<tree>') in tauri/stage-bundle.mjs,
//     the voice-modules files (package.json build.extraResources run through stage-bundle's own filter, PER FILE), the credit
//     files, the default VRM + notice (from the pin) and, owner/selftest only, the 7 room videos of rooms.json;
//   - copy paths: stage-bundle.mjs may copy only through copyTracked / copyFiltered / the credit loop / the vault exe; any other
//     cpSync / copyDir / extra copyFileSync is a COPY-PATH failure;
//   - untracked files inside a staged asset tree FAIL (prep-ui copies the working tree, not git's list).
// Manifest: tauri/third-party-manifest.json: exact path -> licence id (no globs), `pins` (sha256 + licence id of binaries),
// `attested` (path -> {source, date, sha256}: OWNER-ATTESTED, verified only when both fields are non-empty
// AND the shipped file's sha256 equals the pin; missing/malformed/different sha256 = ATTESTATION-STALE, every flavour),
// `unverified` (bundled, licence not confirmed), `bundledCode` (full licence texts that must sit in THIRD_PARTY_LICENSES.md).
//
//   node scripts/check-tauri-third-party.mjs [--flavour public|owner|selftest] [--list] [--units-json <file>]
//
// Open-core split (ADR 2026-10-28): the public flavour stages no Zumi-only asset (scripts/lib/zumi-only.cjs; the staged trees
// are listed through stage-bundle's own stagedTrackedFiles, the default VRM only for owner/selftest), and any Zumi-only path
// still in the public list (a frontendDist built without --flavour public, a .vrm) is a ZUMI-ONLY-LEAK hard fail.
// --units-json writes the listed units (scripts/check-public-payload.mjs).
//
// Exit 1 on: UNMAPPED / NOT-CREDITED / BAD-ID / WIDE-GLOB / NO-LICENCE-TEXT / HASH-MISMATCH / LICENCE-MISMATCH / UNTRACKED /
// COPY-PATH / ATTEST-INCOMPLETE / ATTESTATION-STALE / VIDEO-IN-PUBLIC / conf problems (every flavour). UNVERIFIED assets: owner / selftest -> reported, exit 0; public (default) -> exit 1.
// Test seams (selftest only): ZUMI_TP_MANIFEST, ZUMI_TP_CREDITS, ZUMI_TP_EXTRA_FILES, ZUMI_TP_TAURI_CONF, ZUMI_TP_STAGE_SRC, ZUMI_TP_UI_DIR.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { filteredFiles, CREDIT_FILES, stagedTrackedFiles } from '../tauri/stage-bundle.mjs';

const { isZumiOnly, isOfficialDenied } = createRequire(import.meta.url)('./lib/zumi-only.cjs');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argVal = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const flavour = argVal('--flavour') || 'public';
if (!['public', 'official', 'owner', 'selftest'].includes(flavour)) { console.error(`--flavour must be public|official|owner|selftest, got ${flavour}`); process.exit(2); }
const forPublic = flavour === 'public' || flavour === 'official'; // what a user downloads: strict gate, no voice modules, no room video
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const pkg = readJson('package.json');
const manifest = JSON.parse(fs.readFileSync(process.env.ZUMI_TP_MANIFEST || path.join(root, 'tauri/third-party-manifest.json'), 'utf8'));
const tpl = fs.readFileSync(process.env.ZUMI_TP_CREDITS || path.join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8');
const stageSrc = fs.readFileSync(process.env.ZUMI_TP_STAGE_SRC || path.join(root, 'tauri/stage-bundle.mjs'), 'utf8');
const tauriConf = JSON.parse(fs.readFileSync(process.env.ZUMI_TP_TAURI_CONF || path.join(root, 'tauri/src-tauri/tauri.conf.json'), 'utf8'));
const uiDir = process.env.ZUMI_TP_UI_DIR || path.join(root, 'tauri', 'ui');

const problems = []; // { status, path, size, flavour, note }
const addProblem = (status, p, note, size = null, fl = '-') => problems.push({ status, path: p, size, flavour: fl, note });

// ---- config: the real bundle roots ----
const resKeys = Object.keys(tauriConf.bundle?.resources || {});
if (!(resKeys.length === 1 && resKeys[0] === 'bundle/' && tauriConf.bundle.resources['bundle/'] === '')) addProblem('CONF', 'tauri.conf.json bundle.resources', `must be exactly {"bundle/": ""}, found ${JSON.stringify(tauriConf.bundle?.resources)}: every other resources entry would ship files this gate does not list`);
if (tauriConf.build?.frontendDist !== '../ui') addProblem('CONF', 'tauri.conf.json build.frontendDist', `must be ../ui (checked as tauri/ui), found ${tauriConf.build?.frontendDist}`);

// ---- copy paths in stage-bundle.mjs ----
const code = stageSrc.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
for (const bad of [/\bcpSync\s*\(/, /\bcopyDir\s*\(/, /\bcopyTree\s*\(/, /\bcopyFile\s*\(/, /\bsymlinkSync\s*\(/, /\bwriteFileSync\s*\(/]) {
  if (bad.test(code)) addProblem('COPY-PATH', 'tauri/stage-bundle.mjs', `uses ${bad.source}: every shipped copy must go through copyTracked / copyFiltered / the credit loop so this gate lists it`);
}
const copyFileCalls = (code.match(/\bcopyFileSync\s*\(/g) || []).length;
if (copyFileCalls !== 4) addProblem('COPY-PATH', 'tauri/stage-bundle.mjs', `${copyFileCalls} copyFileSync calls, expected the 4 known ones (copyFiltered, copyTracked, vault exe, credit loop)`);
const CODE_TREES = ['tauri/sidecar', 'src/main'];
const STAGED_TREES = [...code.matchAll(/copyTracked\('([^']+)'\)/g)].map((m) => m[1]).filter((t) => !CODE_TREES.includes(t));
if (STAGED_TREES.length < 5) addProblem('CONF', 'tauri/stage-bundle.mjs', `only ${STAGED_TREES.length} staged asset trees found`);

const git = (...args) => {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (run.status !== 0) { console.error(`git ${args.join(' ')} failed`); process.exit(2); }
  return run.stdout.split('\0').filter(Boolean);
};
const tracked = (rel) => git('ls-files', '-z', '--', rel);
const sizeOf = (p) => { try { return fs.statSync(path.join(root, p)).size; } catch { return null; } };
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.isAbsolute(p) ? p : path.join(root, p))).digest('hex');
const walk = (dir, base = dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out); else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
};

// units: { path (bundle-relative or repo-relative as the manifest keys it), src (repo file to hash, or null), size, flavour }
const units = [];
for (const t of STAGED_TREES) for (const f of stagedTrackedFiles(t, { flavour })) units.push({ path: f, src: f, size: sizeOf(f), flavour: 'both' });
// untracked files inside a staged tree (and the other prep-ui copy sources) are shipped by working-tree copies: FAIL
for (const t of [...STAGED_TREES, 'assets', 'resources-pinned', 'vendor']) {
  for (const f of git('ls-files', '-z', '--others', '--exclude-standard', '--', t)) addProblem('UNTRACKED', f, 'untracked file in a tree that ships (tauri/prep-ui.mjs copies the working tree): commit it and map it, or delete it', sizeOf(f));
}
for (const er of pkg.build.extraResources || []) {
  if (!er.to || !er.to.startsWith('voice-modules/')) continue;
  if (forPublic) continue; // the public bundle ships no voice modules: Kokoro installs from the Marketplace
  for (const rel of filteredFiles(path.join(root, er.from), er.filter || ['**/*'])) units.push({ path: `${er.to}/${rel}`, src: `${er.from}/${rel}`, size: sizeOf(`${er.from}/${rel}`), flavour: 'both' });
}
for (const f of CREDIT_FILES) if (f.startsWith('licenses/')) units.push({ path: f, src: f, size: sizeOf(f), flavour: 'both' });
for (const f of CREDIT_FILES) if (isZumiOnly(f) && flavour !== 'public') units.push({ path: f, src: f, size: sizeOf(f), flavour: 'owner' });
const pin = readJson('resources-pinned/default-model/PIN-MANIFEST.json');
if (flavour !== 'public') {
  units.push({ path: `models/${pin.file}`, src: null, size: pin.bytes, flavour: 'owner' });
  units.push({ path: `models/${pin.licenceNoticeFile}`, src: null, size: null, flavour: 'owner' });
  const rooms = readJson('assets/rooms-video/rooms.json');
  // owner / selftest only: the 7 built-in rooms (owner 03-11). The slim official installer (owner 11-11 mkt-q1) has none: they are packs.
  if (flavour !== 'official') for (const r of rooms.rooms) units.push({ path: `${rooms.packagedDir}/${r.file}`, src: null, size: r.bytes, pinSha: r.sha256, flavour: 'owner' });
}
// frontendDist: what is on disk (untracked files included)
let uiCount = 0;
if (fs.existsSync(uiDir)) {
  for (const rel of walk(uiDir)) { units.push({ path: `tauri/ui/${rel}`, src: null, abs: path.join(uiDir, rel), size: fs.statSync(path.join(uiDir, rel)).size, flavour: 'both' }); uiCount++; }
} else if (forPublic) addProblem('CONF', 'tauri/ui', 'frontendDist is not built (run tauri/prep-ui.mjs): a public check needs the real embedded file list');
else console.log('warn: tauri/ui is not built, frontendDist not checked');
for (const f of JSON.parse(process.env.ZUMI_TP_EXTRA_FILES || '[]')) units.push({ path: f, src: null, size: null, flavour: 'both' }); // test seam

const ATTEST_FIELDS = ['source', 'date'];
const attested = manifest.attested || {};
for (const [k, a] of Object.entries(attested)) {
  const bad = ATTEST_FIELDS.filter((f) => typeof (a || {})[f] !== 'string' || !a[f].trim());
  if (bad.length) addProblem('ATTEST-INCOMPLETE', k, `owner attestation lacks non-empty: ${bad.join(', ')} (needs source, date)`);
}
// public: no video at all. official: only the built-in rooms rooms.json pins (isOfficialDenied names them one by one).
if (forPublic) for (const u of units) if (/\.mp4$/i.test(u.path) && (flavour === 'public' || isOfficialDenied(u.path))) addProblem('VIDEO-IN-PUBLIC', u.path, flavour === 'public' ? 'room videos ship in the official and owner installers only; they must be absent from a public (source) build' : 'only the 7 built-in room videos may ship in the official installer');
for (const u of units) if (flavour === 'public' ? isZumiOnly(u.path) : flavour === 'official' && isOfficialDenied(u.path)) addProblem('ZUMI-ONLY-LEAK', u.path, 'Zumi-only asset in the public bundle (scripts/lib/zumi-only.cjs); it ships in the owner builds only', u.size);

const wide = [...Object.keys(manifest.map), ...Object.keys(manifest.unverified || {}), ...Object.keys(attested), ...Object.keys(manifest.pins || {})].filter((k) => /[*?]/.test(k));
for (const k of wide) addProblem('WIDE-GLOB', k, 'manifest keys must be exact file paths (a glob lets unknown files pass)');

const norm = (t) => t.replace(/\s+/g, ' ').trim();
const tplNorm = norm(tpl);
for (const c of manifest.bundledCode || []) {
  const missing = [];
  for (const k of c.textKeys || []) if (!tpl.includes(k)) missing.push(k);
  const full = c.textFile ? fs.readFileSync(path.join(root, c.textFile), 'utf8') : c.text;
  if (full && !tplNorm.includes(norm(full))) missing.push(`the full text of ${c.textFile || 'the pinned text'}`);
  if (c.fileSha256) {
    const f = c.shipFile;
    if (!f || !fs.existsSync(path.join(root, f)) || sha256(f) !== c.fileSha256) missing.push(`${f} (sha256 must be ${c.fileSha256.slice(0, 12)}...)`);
  }
  if (missing.length) addProblem('NO-LICENCE-TEXT', c.name, `THIRD_PARTY_LICENSES.md / shipped file lacks: ${missing.join(' | ')}`);
}

const unverified = [];
const used = new Set();
for (const u of units) {
  const lid = manifest.map[u.path];
  if (!lid && attested[u.path]) {
    used.add(u.path);
    const a = attested[u.path];
    const file = u.abs || (u.src ? path.join(root, u.src) : null); // the bytes that ship (frontendDist copy or the staged repo file)
    if (!ATTEST_FIELDS.every((f) => typeof a[f] === 'string' && a[f].trim())) { u.status = 'ATTEST-INCOMPLETE'; u.note = 'see problem above'; }
    else if (!/^[0-9a-f]{64}$/.test(String(a.sha256 || ''))) { u.status = 'ATTESTATION-STALE'; u.note = 'owner attestation pins no valid sha256 of the attested file'; problems.push({ ...u }); }
    // A room video is not in the tree: its shipped bytes are the rooms.json pin, which stageRoomVideos enforces at build time.
    else if (((file && fs.existsSync(file)) ? sha256(file) : u.pinSha) !== a.sha256) { u.status = 'ATTESTATION-STALE'; u.note = `shipped file differs from the sha256 the owner attested (${a.sha256.slice(0, 12)}...): re-attest it`; problems.push({ ...u }); }
    else { u.status = 'OWNER-ATTESTED'; u.note = `${a.source}, ${a.date}`; }
    continue;
  }
  if (!lid) {
    const why = (manifest.unverified || {})[u.path];
    if (why) { u.status = 'UNVERIFIED'; u.note = why; unverified.push(u); } else { u.status = 'UNMAPPED'; u.note = 'no manifest entry'; problems.push({ ...u }); }
    used.add(u.path);
    continue;
  }
  used.add(u.path);
  const lic = manifest.licences[lid];
  const pinned = (manifest.pins || {})[u.path];
  if (!lic) { u.status = 'BAD-ID'; u.note = `unknown licence id "${lid}"`; problems.push({ ...u }); }
  else if (lic.noticeKey && !tpl.includes(lic.noticeKey)) { u.status = 'NOT-CREDITED'; u.note = `${lid}: "${lic.noticeKey}" not in THIRD_PARTY_LICENSES.md`; problems.push({ ...u }); }
  else if (pinned && pinned.licence !== lid) { u.status = 'LICENCE-MISMATCH'; u.note = `mapped to ${lid}, the reviewed licence of this binary is ${pinned.licence}`; problems.push({ ...u }); }
  else if (pinned && u.src && sha256(u.src) !== pinned.sha256) { u.status = 'HASH-MISMATCH'; u.note = `sha256 differs from the reviewed ${pinned.sha256.slice(0, 12)}...`; problems.push({ ...u }); }
  else { u.status = 'OK'; u.note = `${lid} (${lic.licence})`; }
}
// pins must name bundled files
for (const k of Object.keys(manifest.pins || {})) if (!(forPublic && k.startsWith('voice-modules/')) && !units.some((u) => u.path === k)) addProblem('LICENCE-MISMATCH', k, 'pinned binary is not in the bundle (stale pin)');

// A Zumi-only credit file is not in the source repo: a public stage never ships it, and an official one has it from the asset checkout, untracked.
const shipProblems = CREDIT_FILES.filter((f) => !(flavour === 'public' && isZumiOnly(f)) && (!stageSrc.includes(`'${f}'`) || (tracked(f).length === 0 && !fs.existsSync(path.join(root, f)))));

const fmt = (n) => (n === null ? '-' : String(n));
console.log(`# tauri third-party asset gate (flavour: ${flavour})`);
const unitsJson = argVal('--units-json');
if (unitsJson) fs.writeFileSync(path.resolve(unitsJson), JSON.stringify({ flavour, units: units.map((u) => ({ path: u.path, flavour: u.flavour })) }, null, 1));
console.log(`assets listed: ${units.length} (both flavours: ${units.filter((u) => u.flavour === 'both').length}, owner-only: ${units.filter((u) => u.flavour === 'owner').length}; frontendDist ${uiCount}, voice-modules ${units.filter((u) => u.path.startsWith('voice-modules/')).length})`);
if (process.argv.includes('--list')) for (const u of units) console.log(`${u.status.padEnd(12)} ${u.path} [${fmt(u.size)} B] ${u.note}`);
const groups = {};
for (const u of units) groups[u.status] = (groups[u.status] || 0) + 1;
console.log('by status:', JSON.stringify(groups));
if (problems.length) {
  console.log(`\nFAIL ${problems.length} problem(s):`);
  for (const u of problems) console.log(`  ${u.status.padEnd(16)} ${u.path} [${fmt(u.size)} B] ${u.note}`);
}
if (shipProblems.length) console.log(`\nFAIL credit file(s) not staged into the bundle: ${shipProblems.join(', ')}`);
if (unverified.length) {
  console.log(`\n${forPublic ? 'FAIL (public: an unverified licence blocks the release)' : 'UNVERIFIED (non-public build only, awaiting anh)'} ${unverified.length} asset(s):`);
  for (const u of unverified) console.log(`  UNVERIFIED       ${u.path} [${fmt(u.size)} B, ${u.flavour}] ${u.note}`);
}
const stale = Object.keys(manifest.map).filter((k) => !used.has(k));
if (stale.length) console.log(`\nwarn: ${stale.length} manifest path(s) match no shipped file (flavour ${flavour}): ${stale.slice(0, 8).join(', ')}${stale.length > 8 ? ', ...' : ''}`);
const bad = problems.length + shipProblems.length + (forPublic ? unverified.length : 0);
console.log(bad ? `\nRED: ${bad} problem(s)` : unverified.length ? `\nGREEN with ${unverified.length} UNVERIFIED (non-public flavour only)` : '\nGREEN: every shipped file is mapped and credited');
process.exit(bad ? 1 : 0);
