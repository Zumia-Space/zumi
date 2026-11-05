// T-31 Tauri updater pins (PLAN-UPDATER.md). Plain Node, no network, launches nothing.
//   node scripts/check-tauri-updater.mjs               the tree as committed
//   node scripts/check-tauri-updater.mjs --release     also refuses a build with no signing public key (the release workflow)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = path.join(ROOT, 'tauri', 'src-tauri');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};

// ---------- the crate: resolved against the pinned tauri, never by widening it ----------
const cargoToml = fs.readFileSync(path.join(TAURI, 'Cargo.toml'), 'utf8');
const cargoLock = fs.readFileSync(path.join(TAURI, 'Cargo.lock'), 'utf8');
const locked = (name) => [...cargoLock.matchAll(new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`, 'g'))].map((m) => m[1]);
ok(/^tauri = \{ version = "~2\.12"/m.test(cargoToml), 'the tauri pin stays ~2.12');
ok(locked('tauri').length === 1 && /^2\.12\./.test(locked('tauri')[0]), 'Cargo.lock holds one tauri, 2.12.x', String(locked('tauri')));
ok(/^tauri-plugin-updater = \{ version = "=2\.14\.1", default-features = false, features = \["rustls-tls", "system-proxy"\] \}/m.test(cargoToml), 'tauri-plugin-updater is exact, with no zip archive support (only a raw NSIS exe is ever published)');
ok(locked('tauri-plugin-updater')[0] === '2.14.1', 'Cargo.lock holds tauri-plugin-updater 2.14.1', String(locked('tauri-plugin-updater')));
ok(locked('zip').length === 0, 'no zip crate in the lockfile', String(locked('zip')));
const msrv = /^rust-version = "(\d+)\.(\d+)"/m.exec(cargoToml);
ok(msrv && Number(msrv[1]) === 1 && Number(msrv[2]) >= 90, 'rust-version floor covers the plugin (1.90)', msrv && msrv[0]);

// ---------- the fourth method: one name through every layer, generated files regenerated ----------
const has = (rel, text) => fs.readFileSync(path.join(ROOT, rel), 'utf8').includes(text);
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'migration', 'api-inventory.json'), 'utf8'));
ok(inventory.apis.some((a) => a.name === 'update.check' && a.kind === 'invoke'), 'update.check is in the inventory');
ok(has('tauri/src-tauri/src/rpc_allow_list.rs', '"update.check"'), 'update.check is in the generated allow-list');
ok(has('docs/migration/coverage-baseline.json', '"update.check"'), 'update.check is in the coverage baseline');
ok(has('src/main/preload.js', "invoke('update:check')") && has('src/main/main.js', "'update:check'") && has('src/main/updater.mjs', "check: async () => ({ result: 'off' })"), 'Electron parity: preload, main and a feed-less off answer');
ok(has('tauri/sidecar/main.mjs', "'update.check': () => ({ result: 'off' })"), 'the sidecar stub answers off');

// ---------- the host: config, gate order, no page surface ----------
const conf = JSON.parse(fs.readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8'));
const updaterConf = conf.plugins && conf.plugins.updater;
const ENDPOINT = 'https://github.com/Zumia-Space/zumi/releases/latest/download/latest.json';
ok(updaterConf && JSON.stringify(updaterConf.endpoints) === JSON.stringify([ENDPOINT]), 'exactly one endpoint, https, on Zumia-Space/zumi', JSON.stringify(updaterConf && updaterConf.endpoints));
ok(updaterConf && typeof updaterConf.pubkey === 'string', 'plugins.updater has a pubkey field (empty = updater off until the owner generates the key)');
const confText = JSON.stringify(conf);
ok(!/dangerous/i.test(confText), 'no dangerous* key in the base config');
ok(!/allowDowngrades/.test(confText), 'allowDowngrades is never set');
for (const dir of ['capabilities', 'capabilities-selftest']) {
  const texts = fs.readdirSync(path.join(TAURI, dir)).map((f) => fs.readFileSync(path.join(TAURI, dir, f), 'utf8'));
  ok(!texts.some((t) => /updater:/.test(t)), `no updater: permission in ${dir}/`);
}
const lib = fs.readFileSync(path.join(TAURI, 'src', 'lib.rs'), 'utf8');
const gateAt = lib.indexOf('renderer_method_allowed(&method)?;');
const interceptAt = lib.indexOf('updater::Op::from_method(&method)');
ok(gateAt > 0 && interceptAt > gateAt, 'the update.* intercept sits after the allow-list gate');
ok(/updater::start\(&handle, flavour_file, self_test\.enabled\(\), /.test(lib), 'the updater starts with the flavour and self-test facts');
// alpha.14 F1: a `--data-dir` launch wrote updater.log under %APPDATA% (app_data_dir). The log follows the launch's own data dir.
const updaterSrc = fs.readFileSync(path.join(TAURI, 'src', 'updater.rs'), 'utf8');
ok(/updater::start\(&handle, flavour_file, self_test\.enabled\(\), self_test\.data_dir_or\(/.test(lib) && /pub fn start\(app: &AppHandle, flavour_file: bool, self_test: bool, data_dir: Option<PathBuf>\)/.test(updaterSrc)
  && /log_file\.lock\(\)\.unwrap\(\) = data_dir\.map\(/.test(updaterSrc) && !/app_data_dir\(\)/.test(updaterSrc), "updater.log lives in the launch's data dir (--data-dir honoured), never app_data_dir() directly");
ok(lib.indexOf('guard_pending.store(false') < lib.indexOf('updater::start(&handle'), 'the updater starts after the main guard is up');
const features = /\[features\]([\s\S]*?)\n\[/.exec(cargoToml)[1];
ok(/^update-e2e = \[\]/m.test(features) && !/^default = .*update-e2e/m.test(features), 'update-e2e exists and is not a default feature');
const updaterRs = path.join(TAURI, 'src', 'updater.rs');
ok(fs.existsSync(updaterRs) && /#\[cfg\(feature = "update-e2e"\)\]\r?\nmod e2e/.test(fs.readFileSync(updaterRs, 'utf8')), 'the E2E hook compiles only under the feature');
if (args.includes('--release')) ok(updaterConf && updaterConf.pubkey.trim() !== '', 'release: the public key is set');

// ---------- no signing secret in any tracked file ----------
const SECRET_MARKS = ['encrypted secret key', 'untrusted comment: rsign', Buffer.from('untrusted comment: rsign').toString('base64').slice(0, 30)];
const grep = spawnSync('git', ['grep', '-l', '-I', '-F', ...SECRET_MARKS.flatMap((m) => ['-e', m]), '--', '.', ':!scripts/check-tauri-updater.mjs'], { cwd: ROOT, encoding: 'utf8' });
ok(grep.status === 1, 'no signing secret text in tracked files', grep.stdout.trim());

// ---------- the release path: one function of the texts, so every mutation below can be replayed against it ----------
const buildPs = fs.readFileSync(path.join(ROOT, 'tauri', 'build.ps1'), 'utf8');
const readIf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const releaseFiles = () => ({
  wf: readIf(path.join(ROOT, '.github', 'workflows', 'release.yml')),
  buildPs,
  publicConf: readIf(path.join(TAURI, 'tauri.public.conf.json')),
  baseConf: fs.readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8'),
  rust: fs.readdirSync(path.join(TAURI, 'src')).filter((n) => n.endsWith('.rs')).map((n) => fs.readFileSync(path.join(TAURI, 'src', n), 'utf8')).join('\n'),
  releaseOverlay: fs.existsSync(path.join(TAURI, 'tauri.release.conf.json')),
});
const buildAtLine = (lines) => lines.findIndex((l) => /build\.ps1/.test(l));
/** Every way the release path can stop being safe. Empty = clean. */
function releaseProblems({ wf, buildPs: ps, publicConf, baseConf, rust, releaseOverlay }) {
  const out = [];
  const lines = wf.split(/\r?\n/);
  const code = wf.replace(/^\s*#.*$/gm, '');
  // Test code must not reach a release build.
  if (/update-e2e|ZUMI_UPDATE_E2E/.test(code + ps + publicConf + baseConf)) out.push('the E2E feature or overlay is in the release path');
  if (/--features|TAURI_CONFIG/.test(code + ps)) out.push('a release build takes extra features or config from outside');
  if (/--config/.test(code)) out.push('the workflow passes its own --config');
  if ([...ps.matchAll(/--config', \(Join-Path \$tauriDir '([^']+)'/g)].some((m) => m[1] !== 'src-tauri\\tauri.public.conf.json')) out.push('build.ps1 merges another overlay');
  if (/dangerous|allowDowngrades/i.test(publicConf + baseConf)) out.push('a dangerous* or allowDowngrades key is set');
  // The plugin's default comparator is the downgrade guard.
  if (/version_comparator|allow_downgrades|dangerous_/.test(rust)) out.push('the host replaces the version comparator or a dangerous setting');
  // The key must never be in the environment of npm or a cargo build script.
  if (releaseOverlay || /createUpdaterArtifacts|UpdaterArtifacts/.test(code + ps + publicConf + baseConf)) out.push('signing is part of the build');
  if (/TAURI_SIGNING/.test(ps)) out.push('build.ps1 touches the signing key');
  const stepOf = (i) => { for (let j = i; j >= 0; j--) if (/^\s+- /.test(lines[j])) return j; return -1; };
  const secretAt = lines.flatMap((l, i) => (/secrets\./.test(l) ? [i] : []));
  const steps = new Set(secretAt.map(stepOf));
  const signAt = lines.findIndex((l) => /- name: Sign the installer/.test(l));
  const nextAfter = (i) => { const n = lines.findIndex((l, j) => j > i && /^\s+- /.test(l)); return n < 0 ? lines.length : n; };
  const signText = signAt >= 0 ? lines.slice(signAt, nextAfter(signAt)).join('\n') : '';
  const signingAt = lines.flatMap((l, i) => (/secrets\.TAURI_SIGNING/.test(l) ? [i] : []));
  if (signingAt.length !== 2 || new Set(signingAt.map(stepOf)).size !== 1 || stepOf(signingAt[0]) !== signAt) out.push('the signing secrets reach more than the signing step');
  const assetsAt = lines.flatMap((l, i) => (/secrets\.ZUMI_ASSETS_TOKEN/.test(l) ? [i] : []));
  const assetsStep = lines.findIndex((l) => /- name: Check out the official assets/.test(l));
  if (assetsAt.length !== 1 || stepOf(assetsAt[0]) !== assetsStep || !/repository: Zumia-Space\/zumi-assets/.test(lines.slice(assetsStep, nextAfter(assetsStep)).join('\n'))) out.push('the asset token reaches more than the asset checkout');
  if (secretAt.length !== signingAt.length + assetsAt.length) out.push('the workflow reads another secret');
  if (steps.size > 2) out.push('secrets are in too many steps');
  const verifyAt = lines.findIndex((l) => /fetch-official-assets\.mjs --from official-assets/.test(l));
  if (verifyAt < assetsStep || buildAtLine(lines) < verifyAt) out.push('the build does not follow a verified asset fetch');
  if (!/-Flavour official\b/.test(code)) out.push('the release does not build the official flavour');
  if (signAt < 0 || !/signer sign --app-version/.test(signText) || /\b(npm|npx|cargo build|cargo tauri build|build\.ps1)\b/.test(signText)) out.push('the signing step is not just the signer with a version');
  const buildAt = lines.findIndex((l) => /build\.ps1/.test(l));
  if (signAt >= 0 && (buildAt < 0 || buildAt > signAt)) out.push('signing runs before the build');
  if (signAt >= 0 && lines.slice(nextAfter(signAt)).some((l) => /\b(npm|npx|cargo build|build\.ps1)\b/.test(l))) out.push('a build tool runs after signing');
  const checkouts = lines.flatMap((l, i) => (/actions\/checkout@/.test(l) ? [i] : []));
  if (!checkouts.length || checkouts.some((c) => !/persist-credentials: false/.test(lines.slice(c, nextAfter(c)).join('\n')))) out.push('a checkout leaves its token in .git/config');
  if (!/"requireSignedVersion":\s*true/.test(baseConf)) out.push('a feed can pair a new version number with an older signed release');
  if (/requireSignedVersion/.test(publicConf)) out.push('an overlay touches requireSignedVersion');
  if (!/cargo install tauri-cli --version '=\d+\.\d+\.\d+' --locked/.test(ps)) out.push('tauri-cli is not pinned exactly');
  return out;
}
const cleanProblems = releaseProblems(releaseFiles());
ok(cleanProblems.length === 0, 'the release path is clean', cleanProblems.join('; '));
const MUTATIONS = [
  ['the E2E feature in build.ps1', (f) => { f.buildPs += "\n$buildArgs += '--features', 'update-e2e'\n"; }],
  ['the E2E overlay in the workflow', (f) => { f.wf += "\n      - run: cargo tauri build --config tauri/verify/update-e2e.conf.json\n"; }],
  ['a second overlay in build.ps1', (f) => { f.buildPs += "\n$buildArgs += '--config', (Join-Path $tauriDir 'verify\\update-e2e.conf.json')\n"; }],
  ['an always-true comparator in the updater', (f) => { f.rust += '\nlet b = app.updater_builder().version_comparator(|_, _| true);\n'; }],
  ['a default comparator at plugin registration', (f) => { f.rust += '\ntauri_plugin_updater::Builder::new().default_version_comparator(|_, _| true)\n'; }],
  ['allowDowngrades in the public overlay', (f) => { f.publicConf = '{"plugins":{"updater":{"allowDowngrades":true}}}'; }],
  ['the signing secret in the build step', (f) => { f.wf = f.wf.replace('      - name: Build the official installer\n', '      - name: Build the official installer\n        env:\n          X: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n'); }],
  ['npm in the signing step', (f) => { f.wf = f.wf.replace('signer sign --app-version', 'signer sign --app-version; npm run x; cargo-tauri signer sign --app-version'); }],
  ['a signature with no version', (f) => { f.wf = f.wf.replace('signer sign --app-version "$ZUMI_VERSION" ', 'signer sign '); }],
  ['persisted checkout credentials', (f) => { f.wf = f.wf.replace('persist-credentials: false', 'persist-credentials: true'); }],
  ['a floating tauri-cli', (f) => { f.buildPs = f.buildPs.replace(/--version '=[\d.]+'/, "--version '^2'"); }],
  ['signing back inside the build', (f) => { f.releaseOverlay = true; }],
  ['the asset token in the build step', (f) => { f.wf = f.wf.replace('      - name: Build the official installer\n', '      - name: Build the official installer\n        env:\n          X: ${{ secrets.ZUMI_ASSETS_TOKEN }}\n'); }],
  ['assets used without the hash check', (f) => { f.wf = f.wf.replace('node scripts/fetch-official-assets.mjs --from official-assets', 'node scripts/other.mjs'); }],
  ['the release building the public flavour', (f) => { f.wf = f.wf.replace('-Flavour official', '-Flavour public'); }],
  ['the asset checkout keeping its token', (f) => { f.wf = f.wf.replace(/(repository: Zumia-Space\/zumi-assets[\s\S]*?)persist-credentials: false/, '$1persist-credentials: true'); }],
  ['requireSignedVersion off', (f) => { f.baseConf = f.baseConf.replace('"requireSignedVersion": true', '"requireSignedVersion": false'); }],
];
for (const [name, mutate] of MUTATIONS) {
  const files = releaseFiles();
  mutate(files);
  const found = releaseProblems(files);
  ok(found.length > 0, `caught: ${name}`);
}
ok(has('scripts/serve-update-feed.mjs', "['latest.yml', 'latest.json']"), 'the test feed revalidates latest.json');
ok(has('tauri/README-installer.txt', 'contacts GitHub') && has('tauri/README-installer.txt', 'GitHub') && !has('tauri/README-installer.txt', 'This build does not update itself'), 'the README says it updates itself and contacts GitHub');
ok(has('tauri/README-installer.txt', 'run the installer by hand') && has('tauri/README-installer.txt', 'chạy lại bộ cài bằng tay'), 'the README gives the recovery from an interrupted update, in both languages');
ok(has('THIRD_PARTY_LICENSES.md', 'tauri-plugin-updater'), 'THIRD_PARTY_LICENSES names the updater crates');
const feedModule = path.join(ROOT, 'scripts', 'make-update-feed.mjs');
if (ok(fs.existsSync(feedModule), 'scripts/make-update-feed.mjs exists') !== false && fs.existsSync(feedModule)) {
  const { makeFeed } = await import(pathToFileURL(feedModule).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-feed-check-'));
  try {
    const installer = path.join(tmp, 'Zumi Test_1.2.3_x64-setup.exe');
    fs.writeFileSync(installer, 'MZ');
    fs.writeFileSync(`${installer}.sig`, 'SIG-TEXT\n');
    const notes = path.join(tmp, '1.2.3.md');
    fs.writeFileSync(notes, '## vi\n• Mới\n\n## en\n• New\n');
    const out = path.join(tmp, 'out');
    const made = makeFeed({ installer, notes, version: '1.2.3', baseUrl: 'https://github.com/o/r/releases/download/v1.2.3', out, date: '2026-01-01T00:00:00.000Z' });
    const feed = JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
    ok(made.assetName === 'Zumi-Test_1.2.3_x64-setup.exe' && fs.existsSync(path.join(out, made.assetName)), 'the published asset name has no space (GitHub renames those)', made.assetName);
    ok(feed.platforms['windows-x86_64'].url === 'https://github.com/o/r/releases/download/v1.2.3/Zumi-Test_1.2.3_x64-setup.exe', 'latest.json points at that exact name');
    ok(feed.platforms['windows-x86_64'].signature === 'SIG-TEXT' && feed.version === '1.2.3' && feed.notes.includes('## vi') && feed.pub_date === '2026-01-01T00:00:00.000Z', 'latest.json carries the signature, version, notes and date');
    const loopback = makeFeed({ installer, notes, version: '1.2.3', baseUrl: 'http://127.0.0.1:47822/', out: path.join(tmp, 'l') });
    ok(loopback.url === 'http://127.0.0.1:47822/Zumi-Test_1.2.3_x64-setup.exe', 'the loopback feed uses the same code', loopback.url);
    const refuses = (name, o) => { let threw = false; try { makeFeed({ installer, notes, version: '1.2.3', baseUrl: 'https://x/y', out: path.join(tmp, 'z'), ...o }); } catch { threw = true; } ok(threw, `refuses ${name}`); };
    refuses('an http non-loopback URL', { baseUrl: 'http://example.com/' });
    refuses('missing notes', { notes: path.join(tmp, 'none.md') });
    refuses('a missing .sig', { installer: notes });
    refuses('a version that is not semver', { version: '1.2' });
    // A signature made as the real tool makes it, by a key made here: right key and version pass, anything else stops the feed.
    const { verifySignature } = await import(pathToFileURL(feedModule).href);
    const keyId = crypto.randomBytes(8);
    const pair = (id) => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { privateKey, b64: Buffer.from(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), id, Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')]).toString('base64')}\n`).toString('base64') }; };
    const signed = (k, id, bytes, version) => {
      const raw = crypto.sign(null, crypto.createHash('blake2b512').update(bytes).digest(), k);
      const trusted = `timestamp:1\tfile:x.exe\tversion:${version}`;
      const sig = Buffer.concat([Buffer.from('ED'), id, raw]);
      const global = crypto.sign(null, Buffer.concat([raw, Buffer.from(trusted)]), k);
      return Buffer.from(`untrusted comment: signature\n${sig.toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`).toString('base64');
    };
    const a = pair(keyId), b = pair(crypto.randomBytes(8));
    const bytes = Buffer.from('MZ installer bytes');
    const attempt = (o) => { try { verifySignature({ pubkey: a.b64, data: bytes, version: '1.2.3', signature: signed(a.privateKey, keyId, bytes, '1.2.3'), ...o }); return null; } catch (e) { return e.message; } };
    ok(attempt({}) === null, 'the feed script accepts a good signature', String(attempt({})));
    ok(attempt({ data: Buffer.from('MZ other bytes') }) !== null, 'the feed script refuses changed bytes');
    ok(attempt({ pubkey: b.b64 }) !== null, 'the feed script refuses a signature from another key');
    ok(attempt({ version: '1.2.4' }) !== null, 'the feed script refuses a signature for another version');
    ok(attempt({ pubkey: '' }) !== null, 'the feed script refuses an empty public key');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- the box E2E: guarded, plan mode launches nothing ----------
const e2e = path.join(ROOT, 'scripts', 'box-e2e-tauri-update.mjs');
ok(fs.existsSync(e2e), 'scripts/box-e2e-tauri-update.mjs exists');
if (fs.existsSync(e2e)) {
  const plan = spawnSync(process.execPath, [e2e, '--plan'], { encoding: 'utf8', env: { ...process.env, ZUMI_ELECTRON_HOST: '' } });
  ok(plan.status === 0 && /bad signature|byte flipped/i.test(plan.stdout), '--plan prints the cases and exits 0');
  const refused = spawnSync(process.execPath, [e2e, '--run'], { encoding: 'utf8', env: { ...process.env, ZUMI_ELECTRON_HOST: '' } });
  ok(refused.status === 2 && /REFUSED/.test(refused.stderr), '--run refuses without ZUMI_ELECTRON_HOST=box', refused.stderr);
  const overlay = path.join(ROOT, 'tauri', 'verify', 'update-e2e.conf.json');
  ok(fs.existsSync(overlay) && JSON.parse(fs.readFileSync(overlay, 'utf8')).identifier !== conf.identifier, 'the E2E overlay has its own identifier');
}

// ---------- the release workflow: never run from here, so its safety lives in pins ----------
const workflowPath = path.join(ROOT, '.github', 'workflows', 'release.yml');
ok(fs.existsSync(workflowPath), '.github/workflows/release.yml exists');
if (fs.existsSync(workflowPath)) {
  const wf = fs.readFileSync(workflowPath, 'utf8');
  const on = /^on:\r?\n([\s\S]*?)\r?\n\r?\n/m.exec(wf);
  ok(on && /tags: \['v\*'\]/.test(on[1]) && !/pull_request|schedule|branches/.test(on[1]), 'a v* tag or a hand run triggers it, never a PR');
  const stepsText = wf.split(/\r?\n {6}- /).slice(1);
  ok(stepsText.filter((s) => /secrets\./.test(s)).every((s) => /if: github\.event_name == 'push'/.test(s)), 'a rehearsal reaches no secret: every step that names one runs on a tag only');
  ok(stepsText.filter((s) => /gh release create|signer sign/.test(s)).every((s) => /if: github\.event_name == 'push'/.test(s)), 'a rehearsal signs and publishes nothing');
  ok(wf.includes("if: github.event_name == 'workflow_dispatch' || github.repository == 'Zumia-Space/zumi'"), 'a tag releases only from the public repo');
  ok(wf.includes("environment: ${{ github.event_name == 'push' && 'release' || '' }}"), 'a tag uses the protected release environment');
  const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  ok(uses.length > 0 && uses.every((u) => /@[0-9a-f]{40}$/.test(u)), 'every action is pinned by a full SHA', uses.join(' '));
  ok(/gh release create [^\n]*--draft/.test(wf) && !/--prerelease/.test(wf.replace(/^\s*#.*$/gm, '')), 'it stops at a draft and never marks a prerelease');
  ok(wf.includes('run: node scripts/release-checks.mjs\n') || wf.includes('run: node scripts/release-checks.mjs\r\n'), 'a tag runs the whole release list');
  ok(fs.readFileSync(path.join(ROOT, 'scripts/release-checks.mjs'), 'utf8').includes("['check-tauri-updater', '--release']"), 'the list refuses an empty public key on a tag');
  ok(wf.includes('--pubkey-conf tauri/src-tauri/tauri.conf.json'), 'the feed script checks the signature against the key users will have');
}

// ---------- two products: the public build is Zumi; owner and self-test keep the preview's identity ----------
ok(conf.identifier === 'space.zumia.preview' && conf.productName === 'Zumi Preview' && conf.mainBinaryName === 'ZumiPreview', 'the base config stays the owner identity (their data dir and install stay where they are)');
const publicPath = path.join(TAURI, 'tauri.public.conf.json');
ok(fs.existsSync(publicPath) && (() => { const { productName, mainBinaryName, identifier } = JSON.parse(fs.readFileSync(publicPath, 'utf8')); return JSON.stringify({ productName, mainBinaryName, identifier }); })() === JSON.stringify({ productName: 'Zumi', mainBinaryName: 'Zumi', identifier: 'space.zumia.zumi' }), 'the public overlay sets the name and identifier, frozen: a change means another manual migration for users');
ok(/if \(\$Flavour -in 'public', 'official'\) \{ \$buildArgs \+= '--config', \(Join-Path \$tauriDir 'src-tauri\\tauri\.public\.conf\.json'\) \}/.test(buildPs), 'only a public or official build takes the public identity');
ok(lib.includes('app.config().product_name.as_deref()'), 'the window title follows the product name');
ok(has('tauri/verify/check-bundle.mjs', "? 'Zumi.exe' : 'ZumiPreview.exe'") && (!fs.existsSync(path.join(ROOT, 'tauri/stage-preview-kit.ps1')) || has('tauri/stage-preview-kit.ps1', "Join-Path $release 'Zumi.exe'")), 'the public gates look for Zumi.exe');

// ---------- official assets: pinned here, in a private repo, refused on any difference ----------
const fetchModule = path.join(ROOT, 'scripts', 'fetch-official-assets.mjs');
const pinsPath = path.join(ROOT, 'official-assets.json');
ok(fs.existsSync(pinsPath) && fs.existsSync(fetchModule), 'official-assets.json and the fetch script exist');
if (fs.existsSync(pinsPath) && fs.existsSync(fetchModule)) {
  const pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
  const names = Object.keys(pins);
  ok(names.some((n) => /zumi-default-[^/]*\.vrm$/.test(n)) && names.includes('resources-pinned/room-v2/B-talk-plate.png'), 'the pins name the default model and the Night City plates');
  // Owner 03-11: the 7 approved rooms ship as built-in rooms; the pins name exactly rooms.json's files (and their chair plate), no other video.
  const roomFiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'rooms-video', 'rooms.json'), 'utf8')).rooms.map((r) => `rooms-video/${r.file}`).sort();
  ok(JSON.stringify(names.filter((n) => /\.mp4$/i.test(n)).sort()) === JSON.stringify(roomFiles) && names.includes('assets/rooms-video/chair-talk.png'), 'the pins name exactly the 7 built-in room videos and their chair plate, no other video');
  ok(Object.values(pins).every((p) => /^[0-9a-f]{64}$/.test(p.sha256) && Number.isInteger(p.bytes)), 'every pin has a size and a sha256');
  const { assetProblems } = await import(pathToFileURL(fetchModule).href);
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-assets-check-'));
  try {
    fs.writeFileSync(path.join(t, 'a.bin'), 'good');
    const pin = { 'a.bin': { bytes: 4, sha256: crypto.createHash('sha256').update('good').digest('hex') } };
    ok(assetProblems(t, pin).length === 0, 'the fetch accepts exactly the pinned bytes');
    fs.writeFileSync(path.join(t, 'a.bin'), 'evil');
    ok(assetProblems(t, pin).some((p) => /sha256/.test(p)), 'the fetch refuses changed bytes of the same size');
    fs.writeFileSync(path.join(t, 'a.bin'), 'good');
    fs.writeFileSync(path.join(t, 'extra.mp4'), 'x');
    ok(assetProblems(t, pin).some((p) => /not pinned/.test(p)), 'the fetch refuses a file it does not pin');
    fs.rmSync(path.join(t, 'a.bin'));
    ok(assetProblems(t, pin).some((p) => /missing/.test(p)), 'the fetch refuses a missing file');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}

console.log(`check-tauri-updater: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
