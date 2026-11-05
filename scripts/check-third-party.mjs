// Third-party licence gate (T-31 0.2.11, round 2). Lists every file the installer bundles, in BOTH build flavours, and fails
// when one is not mapped in third-party-manifest.json, when a mapped licence that needs a notice is not credited in
// THIRD_PARTY_LICENSES.md, or when a bundled dependency's licence text ships nowhere.
//
// The bundled set is DERIVED from the electron-builder config, never from a hand-kept list of folders:
//   flavour release = package.json "build";  flavour public = scripts/builder-public.cjs (release minus the Zumi-only assets);
//   flavour owner = scripts/builder-selftest.cjs (require()d with
//   ZUMI_CONFIG_INSPECT=check-third-party:<this pid>, so `...base.extraResources` spreads and the room-video entry come out as electron-builder sees them).
//   - build.files patterns, matched against every file in the repo (a pattern that matches nothing fails: a generated root
//     the gate cannot see must not pass silently). build/renderer/** is generated, so the gate runs scripts/build-renderer.mjs
//     into a scratch folder (ZUMI_RENDERER_OUT) and reads the files and the esbuild metafile from there.
//   - extraResources and extraFiles ({from,to,filter} or a plain string): in-repo folders file by file, node_modules packages
//     as one unit (plus any single named file in the filter), external folders (the owner room videos) by their filter names.
//   - directories.buildResources and every file path referenced under win/nsis/mac/linux (icons).
//   - what afterPack copies: scripts/lib/default-vrm.cjs stagedFiles(). An afterPack hook the gate does not recognise fails.
//   - electron-builder's automatic payload: the production "dependencies" closure (app.asar/node_modules).
//   - npm packages esbuild INLINES into build/renderer/app.js (legalComments none strips their notices).
// Manifest: exact paths ("files"), globs that must also state the matched file count and a hash of the sorted file list
// ("globs"), and exact "unverified" paths. A file nobody listed is UNMAPPED, even under a covered folder.
//
// Round 3 (eSpeak NG / DirectML):
//   - npm packages shipped through extraResources (the voice stack under voice-modules/) are listed PER FILE, not per package,
//     so one file with different terms (phonemizer.js carries eSpeak NG, DirectML.dll is Microsoft's) cannot hide in a package row.
//   - every shipped node_modules file is scanned: a file that embeds a component the manifest names under "signatures" (eSpeak NG
//     asm.js + data; DirectML) must be mapped to a licence whose "embeds" lists it, and that licence's full text must ship.
//   - native binaries inside app.asar's production dependency closure (they would land in app.asar.unpacked) and "asarUnpack"
//     patterns are listed too; today asarUnpack is empty and the closure has none (asserted, not assumed).
//   - a flavour counts ONLY the rows its own build ships. Files named under manifest "ownerOnly" (the room mp4s) must be ABSENT
//     from the release bundle: one that leaks in is an OWNER-ONLY-LEAK failure (any flavour run).
// Usage: node scripts/check-third-party.mjs [--flavour public|release|owner] [--list] [--release-config-file <json>]
//   release (default, also ZUMI_BUILD_FLAVOUR): what `npm run dist` packs (the owner's own installer). UNVERIFIED items in the release
//   bundle are a hard fail; openLegal items are a WARN (the owner build is never blocked by them).
//   owner: UNVERIFIED items are a warning that prints the list; every other problem still fails; openLegal items are a WARN.
//   public: the bundle for OTHER people (scripts/builder-public.cjs). Same checks as release, and every open openLegal item is
//   also a hard fail. ZUMI-ONLY-LEAK (any flavour run): a scripts/lib/zumi-only.cjs path (a .vrm, the default room, a plate, a
//   room video) in the public bundle is a hard fail (open-core ADR 2026-10-28; E13).
//   --units-json <file>: also write every bundled unit with the flavours that ship it (scripts/check-public-payload.mjs).
//   OPEN LEGAL ("openLegal" list of {id,item,detail,closure?}): an item stays open until closure.{closed,evidence,note} are all
//   non-empty strings. A public GREEN therefore never overstates legal readiness.
//   ATTESTATION-STALE: every "attested" entry pins sha256 of the attested file (repo-relative path); the gate recomputes it and a
//   missing, malformed or different sha256 is a hard fail in every flavour (the owner's statement was about THAT file).
//   OWNER-ATTESTED ("attested" section): an asset whose rights the owner attested in writing. Verified (counts as OK, both flavours)
//   ONLY when status is OWNER-ATTESTED and attestation.{source,date} are non-empty strings; anything else is
//   ATTESTATION-INCOMPLETE, a hard fail in both flavours. A path may not be in both "attested" and "unverified".
//   --manifest-file: gate a scratch manifest JSON instead of third-party-manifest.json (tests only, scripts/check-third-party-attest.mjs).
//   --release-config-file: gate a scratch electron-builder "build" JSON instead of package.json (tests only; the build hooks never pass it).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const argv = process.argv.slice(2);
const flagValue = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
const RELEASE_CONFIG_FILE = flagValue('--release-config-file');
const MANIFEST_FILE = flagValue('--manifest-file'); // tests only: gate a scratch manifest instead of third-party-manifest.json
const FLAVOUR = flagValue('--flavour') || process.env.ZUMI_BUILD_FLAVOUR || 'release';
if (!['public', 'release', 'owner'].includes(FLAVOUR)) { console.error(`--flavour must be public, release or owner, got "${FLAVOUR}"`); process.exit(2); }
const PUBLIC = FLAVOUR === 'public';
const BUILD = FLAVOUR;
const UNITS_JSON = flagValue('--units-json');
const { isZumiOnly } = require('./lib/zumi-only.cjs');

const pkg = readJson('package.json');
const manifest = MANIFEST_FILE ? JSON.parse(fs.readFileSync(path.resolve(MANIFEST_FILE), 'utf8')) : readJson('third-party-manifest.json');
const tpl = fs.readFileSync(path.join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8');
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const tplSquashed = squash(tpl);
const problems = []; // { code, path?, note }
const problem = (code, p, note, flavour = null) => problems.push({ code, path: p, note, flavour });

// ---- glob: ** = any depth, * = within a segment. Order-based include/exclude like electron-builder's file filters.
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
function applyPatterns(patterns, paths) {
  const pats = (patterns && patterns.length ? patterns : ['**/*']).map((p) => ({ neg: p.startsWith('!'), re: globToRe(p.replace(/^!/, '')), raw: p }));
  const hit = new Map(pats.map((p) => [p.raw, 0]));
  const out = paths.filter((f) => {
    let inc = false;
    for (const p of pats) if (p.re.test(f)) { inc = !p.neg; hit.set(p.raw, hit.get(p.raw) + 1); }
    return inc;
  });
  return { out, hit };
}
function walk(dir, skip = () => false, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (skip(p, e)) continue;
    if (e.isDirectory()) walk(p, skip, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// ---- repo files (what build.files can match). node_modules is the dependency payload (handled separately); build/ is
// replaced by the scratch renderer build below; _internal-build*/dist/selftest-* are outputs, not sources.
const SKIP_TOP = new Set(['node_modules', '.git', 'build', 'dist', '_third-party-check']);
const repoFiles = walk(root, (p, e) => {
  const r = rel(p);
  return SKIP_TOP.has(r) || /^(_internal-build|selftest-|_install-test|\.[a-z0-9-]+-tmp$|\.click-|\.l0-tmp)/.test(r.split('/')[0]) || e.name === '.git';
}).map(rel);

// ---- generated renderer output
const SCRATCH = path.join(root, '_third-party-check');
const SCRATCH_OUT = path.join(SCRATCH, 'renderer');
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-renderer.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, ZUMI_RENDERER_OUT: SCRATCH_OUT }, timeout: 180000 });
let generated = [];
let bundledNpm = [];
let embeddedLibs = new Map(); // npm package -> vendored libs inside it that esbuild inlined (three/examples/jsm/libs/*)
if (build.status !== 0) {
  problem('RENDERER-BUILD', 'build/renderer/**', `scripts/build-renderer.mjs failed (exit ${build.status}); cannot list what build/renderer/** carries: ${(build.stderr || build.stdout || '').trim().split('\n').slice(-2).join(' | ')}`);
} else {
  generated = walk(SCRATCH_OUT).map((f) => `build/renderer/${path.relative(SCRATCH_OUT, f).split(path.sep).join('/')}`);
  const meta = JSON.parse(fs.readFileSync(`${SCRATCH_OUT}.metafile.json`, 'utf8'));
  const names = new Set();
  for (const k of Object.keys(meta.inputs)) { const m = k.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//); if (m) names.add(m[1]); }
  bundledNpm = [...names].sort();
  for (const k of Object.keys(meta.inputs)) {
    const m = k.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\/.*\/libs\/([^/]+?)(?:\.module|\.min)*\.m?js$/);
    if (m) embeddedLibs.set(m[1], [...(embeddedLibs.get(m[1]) || []), m[2]]);
  }
}
const allFiles = [...repoFiles, ...generated];

// ---- npm helpers
function findPkgDir(name, fromDir) {
  for (let d = fromDir; ; d = path.dirname(d)) {
    const c = path.join(d, 'node_modules', name);
    if (fs.existsSync(path.join(c, 'package.json'))) return c;
    if (path.dirname(d) === d) return null;
  }
}
const pkgJsonOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const LICENSE_RE = /^(licen[sc]e|copying)(\.|$)/i;
const NATIVE_RE = /\.(node|dll|exe|so|dylib|wasm)$/i;
const licenceFileOf = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => LICENSE_RE.test(n)) : null);
function depClosure(names, fromDir) {
  const seen = new Map();
  const visit = (n, from) => {
    if (seen.has(n)) return;
    const d = findPkgDir(n, from);
    if (!d) { seen.set(n, null); return; }
    seen.set(n, d);
    for (const dep of Object.keys(pkgJsonOf(d).dependencies || {})) visit(dep, d);
  };
  for (const n of names) visit(n, fromDir);
  return seen;
}

// ---- units: one per bundled file / package. { path, kind, size, flavours:Set, how, ... }
const units = new Map();
function addUnit(flavour, u) {
  const k = u.path;
  if (!units.has(k)) units.set(k, { ...u, flavours: new Set() });
  const x = units.get(k);
  x.flavours.add(flavour);
  if (u.packsLicenceFile === false) x.packsLicenceFile = false; // any flavour lacking a shipped licence file keeps the stricter rule
}
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return null; } };
const inRepo = (abs) => { const r = path.relative(root, abs); return !r.startsWith('..') && !path.isAbsolute(r); };

function collectEntry(flavour, entry, base) {
  const e = typeof entry === 'string' ? { from: entry } : entry;
  const fromAbs = path.resolve(root, e.from);
  const fromRel = inRepo(fromAbs) ? rel(fromAbs) : null;
  const how = `${base} (${e.from})`;
  const st = fs.existsSync(fromAbs) ? fs.statSync(fromAbs) : null;
  if (fromRel && fromRel.startsWith('node_modules/')) {
    // npm package: ONE UNIT PER PACKED FILE (round 3). The package's packed file list also decides whether a licence file
    // ships with it; every file of the package inherits that flag and the package root (pkgDir) for the version check.
    let packed = [];
    if (st && st.isDirectory()) packed = applyPatterns(e.filter, walk(fromAbs).map((f) => path.relative(fromAbs, f).split(path.sep).join('/'))).out;
    else problem('UNREADABLE', fromRel, `${base} entry "from" is not an installed folder; the gate cannot list its files`, flavour);
    const packsLicenceFile = packed.some((f) => LICENSE_RE.test(path.basename(f)) && !f.includes('/node_modules/'));
    for (const n of packed) addUnit(flavour, { path: `${fromRel}/${n}`, kind: 'npm-file', size: sizeOf(path.join(fromAbs, n)), how: `${how}, per file`, pkgDir: fromAbs, pkgRoot: fromRel, packsLicenceFile, abs: path.join(fromAbs, n) });
    return;
  }
  // a generated file under out/ (builder-public.cjs: the public THIRD_PARTY_LICENSES.md) is keyed by where it ships (`to`)
  const generated = fromRel && fromRel.startsWith('out/') && e.to;
  if (st && st.isFile()) { addUnit(flavour, { path: (!generated && fromRel) || e.to || path.basename(e.from), kind: 'file', size: st.size, how }); return; }
  if (st && st.isDirectory()) {
    const names = applyPatterns(e.filter, walk(fromAbs).map((f) => path.relative(fromAbs, f).split(path.sep).join('/'))).out;
    for (const n of names) {
      const p = fromRel ? `${fromRel}/${n}` : `${(e.to || path.basename(e.from)).replace(/\\/g, '/')}/${n}`;
      addUnit(flavour, { path: p, kind: 'file', size: sizeOf(path.join(fromAbs, n)), how: fromRel ? how : `${how}, external folder` });
    }
    return;
  }
  // `from` is not on this machine: only literal filter names can be listed; anything with a glob cannot be derived
  const lit = (e.filter || []).filter((f) => !f.startsWith('!') && !f.includes('*'));
  if (!lit.length || (e.filter || []).some((f) => f.includes('*'))) { problem('UNREADABLE', e.from, `${base} entry "from" is missing and its filter is not a literal file list; the gate cannot say what it ships`, flavour); return; }
  for (const n of lit) addUnit(flavour, { path: `${(e.to || path.basename(e.from)).replace(/\\/g, '/')}/${n}`, kind: 'file', size: null, how: `${how}, external folder (not on this machine)` });
}

function collectConfig(flavour, cfg) {
  const patterns = cfg.files || [];
  const { out, hit } = applyPatterns(patterns, allFiles);
  for (const p of patterns) if (!p.startsWith('!') && hit.get(p) === 0) problem('PATTERN-EMPTY', p, `build.files pattern matches no file (a generated root the gate cannot see?) [${flavour}]`, flavour);
  for (const f of out) addUnit(flavour, { path: f, kind: 'file', size: f.startsWith('build/renderer/') ? sizeOf(path.join(SCRATCH_OUT, f.slice('build/renderer/'.length))) : sizeOf(path.join(root, f)), how: 'build.files' });
  for (const er of cfg.extraResources || []) collectEntry(flavour, er, 'extraResources');
  for (const ef of cfg.extraFiles || []) collectEntry(flavour, ef, 'extraFiles');
  // build resources + files referenced from the platform sections (icons)
  const bres = cfg.directories?.buildResources;
  if (bres && fs.existsSync(path.join(root, bres))) for (const f of walk(path.join(root, bres))) addUnit(flavour, { path: rel(f), kind: 'file', size: sizeOf(f), how: 'directories.buildResources' });
  const refs = [];
  const scan = (o) => { for (const v of Object.values(o || {})) { if (typeof v === 'string') refs.push(v); else if (v && typeof v === 'object') scan(v); } };
  for (const sec of ['win', 'nsis', 'mac', 'linux', 'dmg', 'appx', 'msi', 'portable']) scan(cfg[sec]);
  for (const v of refs) { const abs = path.resolve(root, v); if (inRepo(abs) && fs.existsSync(abs) && fs.statSync(abs).isFile()) addUnit(flavour, { path: rel(abs), kind: 'file', size: fs.statSync(abs).size, how: 'config file reference' }); }
  // afterPack
  const hook = cfg.afterPack;
  const hookText = typeof hook === 'function' ? hook.toString() : typeof hook === 'string' && fs.existsSync(path.join(root, hook)) ? fs.readFileSync(path.join(root, hook), 'utf8') : null;
  if (hook) {
    if (hookText && /after-pack-default-model|stageIntoResources/.test(typeof hook === 'string' ? `${hook}\n${hookText}` : hookText)) {
      for (const f of require('./lib/default-vrm.cjs').stagedFiles()) addUnit(flavour, { path: f, kind: 'file', size: null, how: 'afterPack (default-vrm.cjs stagedFiles)' });
    } else problem('UNKNOWN-AFTERPACK', typeof hook === 'string' ? hook : '(function)', `[${flavour}] afterPack hook is not scripts/after-pack-default-model.cjs; the gate cannot tell what it copies into the installer`, flavour);
  }
  // electron-builder always packs the production dependency closure into app.asar
  for (const [name, dir] of depClosure(Object.keys(pkg.dependencies || {}), root)) {
    if (!dir) { problem('DEP-MISSING', `node_modules/${name}`, `production dependency "${name}" is not installed; cannot verify its licence`, flavour); continue; }
    addUnit(flavour, { path: `node_modules/${name}`, kind: 'asar-dep', size: null, how: 'app.asar production dependencies', pkgDir: dir, packsLicenceFile: Boolean(licenceFileOf(dir)) });
    // native code inside a dependency would be smart-unpacked to app.asar.unpacked: list each such file (needs its own manifest entry)
    for (const f of walk(dir, (p, ent) => ent.isDirectory() && ent.name === 'node_modules')) {
      if (NATIVE_RE.test(f)) addUnit(flavour, { path: `node_modules/${name}/${path.relative(dir, f).split(path.sep).join('/')}`, kind: 'npm-file', size: sizeOf(f), how: 'app.asar production dependency, native binary (app.asar.unpacked)', pkgDir: dir, pkgRoot: `node_modules/${name}`, packsLicenceFile: Boolean(licenceFileOf(dir)), abs: f });
    }
  }
  // asarUnpack: files matching a pattern are moved out of app.asar. Empty today; a pattern that matches a bundled file is listed
  // again as an app.asar.unpacked unit, so the unpacked root is never invisible. A pattern that matches nothing fails.
  for (const pat of cfg.asarUnpack || []) {
    const hits = applyPatterns([pat], [...allFiles]).out;
    if (!hits.length) problem('ASARUNPACK-EMPTY', pat, `[${flavour}] asarUnpack pattern matches no repo file; the gate cannot see what it unpacks (node_modules natives are listed from the dependency closure)`, flavour);
    for (const f of hits) addUnit(flavour, { path: `app.asar.unpacked/${f}`, kind: 'file', size: sizeOf(path.join(root, f)), how: `asarUnpack (${pat})` });
  }
}

process.env.ZUMI_CONFIG_INSPECT = `check-third-party:${process.pid}`; // builder-selftest.cjs accepts ONLY this value (this process's pid), never a bare 1
const releaseConfig = RELEASE_CONFIG_FILE ? JSON.parse(fs.readFileSync(path.resolve(RELEASE_CONFIG_FILE), 'utf8')) : pkg.build;
if (RELEASE_CONFIG_FILE) console.log(`NOTE: release flavour taken from scratch config ${RELEASE_CONFIG_FILE} (test input, not package.json)`);
collectConfig('release', releaseConfig);
// The owner flavour needs the owner-only values file; the export has none and builds no owner flavour.
if (fs.existsSync(path.join(root, 'src/main/owner-values.json'))) collectConfig('owner', require('./builder-selftest.cjs'));
require('./lib/public-credits.cjs').writePublicCredits(root); // what builder-public.cjs beforePack writes: the public credits file it ships
collectConfig('public', require('./builder-public.cjs'));
// npm packages inlined into the renderer bundle (same in every flavour; build/renderer/** is in every config)
for (const name of bundledNpm) {
  const dir = findPkgDir(name, root);
  for (const fl of ['release', 'owner', 'public']) addUnit(fl, { path: `bundled:${name}`, kind: 'bundled-npm', size: null, how: 'inlined into build/renderer/app.js by esbuild (legalComments none: notice stripped)', pkgDir: dir, name });
}
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.rmSync(`${SCRATCH_OUT}.metafile.json`, { force: true });

// ---- classify
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sorted = [...units.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
const globRules = (manifest.globs || []).map((g) => ({ ...g, re: globToRe(g.glob) }));
const claimedByGlob = new Set(); // a file belongs to the FIRST glob that matches it, so a specific glob listed before a broad one carves its files out
for (const g of globRules) {
  const matched = sorted.filter((u) => g.re.test(u.path) && !(manifest.files || {})[u.path] && !claimedByGlob.has(u.path)).map((u) => u.path);
  for (const m of matched) claimedByGlob.add(m);
  g.matched = matched;
  g.drift = matched.length !== g.count || sha256(matched.join('\n')) !== g.listSha256;
  g.got = { count: matched.length, listSha256: sha256(matched.join('\n')) };
}
const hasText = (t) => tplSquashed.includes(squash(t));
// signatures: components that can hide inside another package's file (eSpeak NG compiled into phonemizer.js; Microsoft's DirectML.dll)
const SIGS = Object.entries(manifest.signatures || {}).map(([name, s]) => ({ name, content: s.content ? new RegExp(s.content) : null, path: s.path ? new RegExp(s.path, 'i') : null }));
const MAX_SCAN = 40 * 1024 * 1024;
for (const u of sorted) {
  u.sigs = [];
  if (u.kind !== 'npm-file') continue;
  let text = null;
  for (const sg of SIGS) {
    if (sg.path && sg.path.test(u.path)) u.sigs.push(sg.name);
    else if (sg.content && u.abs && (u.size === null || u.size <= MAX_SCAN)) { text ??= fs.readFileSync(u.abs).toString('latin1'); if (sg.content.test(text)) u.sigs.push(sg.name); }
  }
}
const ATTEST_FIELDS = ['source', 'date'];
const rows = [];
const usedExact = new Set();
for (const u of sorted) {
  let id = (manifest.files || {})[u.path];
  let via = 'exact';
  if (id) usedExact.add(u.path);
  if (!id) {
    const g = globRules.find((r) => r.matched.includes(u.path));
    if (g) { id = g.id; via = `glob ${g.glob}`; u.globDrift = g.drift ? g : null; }
  }
  const unv = (manifest.unverified || {})[u.path];
  const att = (manifest.attested || {})[u.path];
  if (att) {
    const a = att.attestation || {};
    const missing = ATTEST_FIELDS.filter((f) => typeof a[f] !== 'string' || !a[f].trim());
    if (unv) problem('ATTEST-CONFLICT', u.path, 'path is in both "attested" and "unverified"; remove one');
    if (att.status !== 'OWNER-ATTESTED') { u.status = 'ATTESTATION-INCOMPLETE'; u.note = `attested entry has status "${att.status}", expected OWNER-ATTESTED`; }
    else if (missing.length) { u.status = 'ATTESTATION-INCOMPLETE'; u.note = `OWNER-ATTESTED but attestation lacks: ${missing.join(', ')}`; }
    else if (!/^[0-9a-f]{64}$/.test(String(att.sha256 || ''))) { u.status = 'ATTESTATION-STALE'; u.note = 'OWNER-ATTESTED entry pins no valid sha256 of the attested file'; }
    else if (!fs.existsSync(path.join(root, u.path)) || crypto.createHash('sha256').update(fs.readFileSync(path.join(root, u.path))).digest('hex') !== att.sha256) { u.status = 'ATTESTATION-STALE'; u.note = 'the file no longer matches the sha256 the owner attested (changed or missing): re-attest it'; }
    else { u.status = 'OWNER-ATTESTED'; u.note = `${a.source}; owner ${a.date}`; }
  } else if (unv) { u.status = 'UNVERIFIED'; u.note = unv; }
  else if (!id && u.kind === 'asar-dep') {
    // electron-builder keeps each package's own LICENSE next to its code in app.asar, so a permissive licence is carried
    const pj = pkgJsonOf(u.pkgDir);
    const spdx = String(pj.license || '');
    if (/^(MIT|ISC|BSD-[23]-Clause|Apache-2\.0|0BSD|BlueOak-1\.0\.0)$/.test(spdx) && licenceFileOf(u.pkgDir)) { u.status = 'OK'; u.note = `${pj.name}@${pj.version} ${spdx}, licence file ships inside the package`; }
    else { u.status = 'UNMAPPED'; u.note = `production dependency ${pj.name}@${pj.version} licence "${spdx}"${licenceFileOf(u.pkgDir) ? '' : ', no licence file'}: add a manifest entry`; }
  } else if (!id) { u.status = 'UNMAPPED'; u.note = 'no manifest entry (list the exact path under "files")'; }
  else {
    const lic = (manifest.licences || {})[id];
    if (!lic) { u.status = 'BAD-ID'; u.note = `manifest maps to unknown licence id "${id}"`; }
    else if (u.globDrift) {
      // one problem per glob, not one per file; every file of the glob stays unresolved until a human re-verifies the list
      u.status = 'GLOB-DRIFT'; u.note = `${id}: glob ${u.globDrift.glob} drifted`;
      if (!u.globDrift.reported) { u.globDrift.reported = true; problem('GLOB-DRIFT', u.globDrift.glob, `now matches ${u.globDrift.got.count} bundled file(s) (listSha256 ${u.globDrift.got.listSha256}), manifest expects ${u.globDrift.count} (${u.globDrift.listSha256.slice(0, 12)}): a file was added, removed or renamed. Run with --list to see them, verify the licence of the new file, then update count + listSha256`); }
    }
    else if (lic.noticeKey && !tpl.includes(lic.noticeKey)) { u.status = 'NOT-CREDITED'; u.note = `${id}: "${lic.noticeKey}" not in THIRD_PARTY_LICENSES.md`; }
    else {
      u.status = 'OK'; u.note = `${id} (${lic.licence}) via ${via}`;
      // non-npm components (a compiled library inside someone else's file, a vendor DLL): no npm version; the full terms must ship
      const notNpmPackage = lic.nonNpm || lic.assetInPackage; // assetInPackage: a model/voice file that merely sits in an npm folder (no npm checks, no terms text required)
      if (lic.nonNpm) {
        const miss = (lic.mustContain || []).filter((t) => !hasText(t));
        if (!(lic.mustContain || []).length) { u.status = 'NO-LICENSE-TEXT'; u.note = `${id}: non-npm component entry lists no "mustContain" text; its terms would ship nowhere`; }
        else if (miss.length) { u.status = 'NO-LICENSE-TEXT'; u.note = `${id}: THIRD_PARTY_LICENSES.md lacks: ${miss.map((m) => `"${m.slice(0, 50)}"`).join(', ')}`; }
      }
      // a file that embeds a signature component must be mapped to a licence that declares it (and ships its terms, checked above)
      if (u.status === 'OK' && (u.sigs || []).length) {
        const undeclared = u.sigs.filter((n) => !(lic.embeds || []).includes(n));
        if (undeclared.length) { u.status = 'UNCREDITED-EMBED'; u.note = `${id} does not declare that this file embeds ${undeclared.join(', ')} (manifest "signatures"); map it to a licence entry with "embeds" and the full terms`; }
        else u.note += `; embeds ${u.sigs.join(', ')} (declared)`;
      }
      // npm units: installed version must match the version the credit row names
      if (u.status === 'OK' && !notNpmPackage && u.pkgDir && fs.existsSync(path.join(u.pkgDir, 'package.json')) && u.kind !== 'bundled-npm') {
        const v = pkgJsonOf(u.pkgDir).version;
        if (!lic.version) { u.status = 'NO-VERSION'; u.note = `${id}: licence entry has no "version" to compare with installed ${v}`; }
        else if (lic.version !== v) { u.status = 'VERSION-DRIFT'; u.note = `${id}: installed ${v}, credited ${lic.version}`; }
      }
      // npm folder with no licence file in the packed folder, and bundled npm (notice stripped): the full text must be in THIRD_PARTY_LICENSES.md
      if (u.status === 'OK' && (u.kind === 'npm-file' || u.kind === 'asar-dep') && !notNpmPackage && u.packsLicenceFile === false) {
        const need = lic.mustContain || [];
        const miss = need.filter((t) => !hasText(t));
        if (!need.length) { u.status = 'NO-LICENSE-TEXT'; u.note = `${id}: the packed folder carries no LICENSE file and the entry lists no "mustContain" texts; the licence text ships nowhere`; }
        else if (miss.length) { u.status = 'NO-LICENSE-TEXT'; u.note = `${id}: packed folder has no LICENSE file and THIRD_PARTY_LICENSES.md lacks: ${miss.map((m) => `"${m.slice(0, 40)}"`).join(', ')}`; }
      }
      if (u.status === 'OK' && u.kind === 'bundled-npm') {
        if (!u.pkgDir) { u.status = 'NO-LICENSE-TEXT'; u.note = `${u.name} is inlined in the bundle but not installed; cannot read its LICENSE`; }
        else {
          const v = pkgJsonOf(u.pkgDir).version;
          const closure = depClosure([u.name], root); // a prebuilt bundle inlines its declared dependencies too
          const lacking = [];
          for (const [n, d] of closure) {
            const lf = d && licenceFileOf(d);
            if (!lf) { lacking.push(`${n} (no LICENSE file to compare)`); continue; }
            if (!hasText(fs.readFileSync(path.join(d, lf), 'utf8'))) lacking.push(`${n}@${pkgJsonOf(d).version} (its ${lf} text is not in THIRD_PARTY_LICENSES.md verbatim)`);
          }
          const miss = (lic.mustContain || []).filter((t) => !hasText(t));
          const unlisted = (embeddedLibs.get(u.name) || []).filter((l) => !(lic.embedded || []).includes(l));
          if (unlisted.length) lacking.push(`embedded lib(s) ${unlisted.join(', ')} inlined from ${u.name} but not listed in the entry's "embedded" (add the notice text under mustContain too)`);
          if (lic.version !== v) { u.status = 'VERSION-DRIFT'; u.note = `${id}: installed ${v}, credited ${lic.version || '(none)'}`; }
          else if (lacking.length || miss.length) { u.status = 'NO-LICENSE-TEXT'; u.note = `${u.name}: ${[...lacking, ...miss.map((m) => `mustContain "${m.slice(0, 40)}" missing`)].join('; ')}`; }
          else u.note = `${id} (${lic.licence}): full text present for ${[...closure.keys()].join(', ')}${(lic.mustContain || []).length ? ` + ${lic.mustContain.length} extra notice text(s)` : ''}`;
        }
      }
    }
  }
  rows.push(u);
}
const staleExact = Object.keys(manifest.files || {}).filter((p) => !usedExact.has(p));
const staleUnv = [...Object.keys(manifest.unverified || {}), ...Object.keys(manifest.attested || {})].filter((p) => !units.has(p));
const staleGlobs = globRules.filter((g) => g.matched.length === 0).map((g) => g.glob);

// owner-only files must be ABSENT from the release bundle (a bare name list plus the rule "no rooms-video/*.mp4 in release")
const OWNER_ONLY_RE = /^rooms-video\/[^/]+\.mp4$/;
const ownerOnlyNames = new Set(manifest.ownerOnly || []);
for (const u of sorted) {
  if (!u.flavours.has('release')) continue;
  if (ownerOnlyNames.has(u.path) || OWNER_ONLY_RE.test(u.path)) problem('OWNER-ONLY-LEAK', u.path, `owner-only file is in the RELEASE bundle (${u.how}); the release build must not ship it`, 'release');
}
for (const n of ownerOnlyNames) { const u = units.get(n); if (!u || !u.flavours.has('owner')) problem('OWNER-ONLY-STALE', n, 'manifest "ownerOnly" names a file the owner build no longer packs; update the list', 'owner'); }
// Zumi-only assets (open-core ADR 2026-10-28) must be ABSENT from the public bundle; reported in every flavour run
for (const u of sorted) if (u.flavours.has('public') && isZumiOnly(u.path)) problem('ZUMI-ONLY-LEAK', u.path, `Zumi-only asset is in the PUBLIC bundle (${u.how}); it ships in the owner builds only (scripts/lib/zumi-only.cjs)`, 'public');

// the credit file itself must ship in every flavour
for (const fl of ['release', 'owner', 'public']) for (const f of ['THIRD_PARTY_LICENSES.md', 'NOTICE']) {
  const u = units.get(f);
  if (!u || !u.flavours.has(fl)) problem('NOT-SHIPPED', f, `[${fl}] not in build.extraResources/files: attribution would never reach the user`, fl);
}

// ---- report
const fmt = (n) => (n === null || n === undefined ? '-' : String(n));
const flav = (u) => (u.flavours.size === 3 ? 'all' : u.flavours.size === 1 ? `${[...u.flavours][0]}-only` : [...u.flavours].sort().join('+'));
// a flavour counts ONLY the rows its own build ships (round 3: the 7 owner-only mp4s are not a release problem)
const scope = rows.filter((u) => u.flavours.has(BUILD));
const fails = scope.filter((u) => u.status !== 'OK' && u.status !== 'OWNER-ATTESTED' && u.status !== 'UNVERIFIED' && u.status !== 'GLOB-DRIFT');
const unverified = scope.filter((u) => u.status === 'UNVERIFIED');
const STRICT = FLAVOUR !== 'owner';
const LEGAL_FIELDS = ['closed', 'evidence', 'note'];
const openLegal = (manifest.openLegal || []).filter((i) => LEGAL_FIELDS.some((k) => typeof (i.closure || {})[k] !== 'string' || !i.closure[k].trim()));
const scopedProblems = problems.filter((p) => !p.flavour || p.flavour === BUILD || p.code === 'OWNER-ONLY-LEAK' || p.code === 'ZUMI-ONLY-LEAK');
console.log(`# third-party asset gate (flavour: ${FLAVOUR}${PUBLIC ? ', strict, open legal items fail' : STRICT ? ', strict' : ', owner: UNVERIFIED = warning'})`);
console.log(`${BUILD} bundle: ${scope.length} files/units counted (${rows.length} across all flavours)`);
console.log(`bundled units derived from build config: ${rows.length} (all flavours: ${rows.filter((u) => u.flavours.size === 3).length}, owner builds only: ${rows.filter((u) => !u.flavours.has('public')).length}, owner-only: ${rows.filter((u) => u.flavours.size === 1 && u.flavours.has('owner')).length}); npm inlined into app.js: ${bundledNpm.join(', ') || '(none)'}`);
if (UNITS_JSON) fs.writeFileSync(path.resolve(UNITS_JSON), JSON.stringify({ flavour: FLAVOUR, units: rows.map((u) => ({ path: u.path, flavours: [...u.flavours].sort() })) }, null, 1));
if (argv.includes('--list')) for (const u of rows) console.log(`${u.status.padEnd(14)} ${u.path} [${fmt(u.size)} B, ${flav(u)}] ${u.note}`);
const groups = {};
for (const u of scope) groups[u.status] = (groups[u.status] || 0) + 1;
console.log('by status:', JSON.stringify(groups));
if (fails.length) {
  console.log(`\nFAIL ${fails.length} bundled item(s) not covered:`);
  for (const u of fails) console.log(`  ${u.status.padEnd(14)} ${u.path} [${fmt(u.size)} B, ${flav(u)}] ${u.note}`);
}
if (scopedProblems.length) {
  console.log(`\nFAIL ${scopedProblems.length} config problem(s):`);
  for (const p of scopedProblems) console.log(`  ${p.code.padEnd(14)} ${p.path || ''} ${p.note}`);
}
if (unverified.length) {
  console.log(`\n${STRICT ? 'FAIL' : 'WARN'} ${unverified.length} UNVERIFIED item(s) (licence/terms not confirmed)${STRICT ? ' -- a release/public build may not ship them' : ' -- allowed in the owner build only'}:`);
  for (const u of unverified) console.log(`  UNVERIFIED     ${u.path} [${fmt(u.size)} B, ${flav(u)}] ${u.note}`);
}
if (openLegal.length) {
  console.log(`\n${PUBLIC ? 'FAIL' : 'WARN'} ${openLegal.length} open legal item(s) (no closure evidence)${PUBLIC ? ' -- a public build may not ship while they are open' : ' -- allowed in the owner builds, blocks the public build'}:`);
  for (const i of openLegal) console.log(`  OPEN-LEGAL     ${i.id} ${i.item || ''}: ${i.detail || ''}`);
}
if (staleExact.length || staleUnv.length || staleGlobs.length) console.log(`\nwarn: manifest entries that match no bundled file: ${[...staleExact, ...staleUnv, ...staleGlobs].join(', ')}`);
const hard = fails.length + scopedProblems.length + (STRICT ? unverified.length : 0) + (PUBLIC ? openLegal.length : 0);
console.log(hard ? `\nRED (${FLAVOUR}): ${hard} blocking problem(s)${!STRICT && unverified.length ? `; ${unverified.length} UNVERIFIED warned` : ''}${!PUBLIC && openLegal.length ? `; ${openLegal.length} open legal warned` : ''}` : `\nGREEN (${FLAVOUR}): every bundled file is mapped and credited${unverified.length ? `; ${unverified.length} UNVERIFIED warned (owner build only)` : ''}${!PUBLIC && openLegal.length ? `; ${openLegal.length} open legal warned (not for a public build)` : ''}`);
process.exit(hard ? 1 : 0);
