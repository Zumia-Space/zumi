// What must hold before a v* tag goes out. Runs in .github/workflows/release.yml.
//   node scripts/check-release-gate.mjs                static rows: notes, Kokoro pin, packs-v1 rules
//   node scripts/check-release-gate.mjs --kokoro       also rebuilds the Kokoro pack and compares it with the catalog pin (after npm ci)
//   node scripts/check-release-gate.mjs --live         also asks GitHub which release is Latest (needs gh)
// The packs themselves: scripts/check-packs-asset.mjs (the workflow, with its token) and scripts/check-packs-public.mjs (by hand,
// once the repo is public, before publishing).
//   --notes <file>                                     read these notes instead of the version's own (the check's bite test)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../tauri/sidecar/market-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const args = process.argv.slice(2);
let fail = 0, pass = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } };

const REPO = 'Zumia-Space/zumi';
const PACKS_TAG = 'packs-v1';
// The zip built before the licence text was cleaned. It matches an old pin and says things a stranger should not read.
const ARCHIVED_ZIP_SHA = 'f9dffb3eaff33a016c729905db4e85b052275b60c3aba7c9bd72e1f089135fe7';

// ---------- release notes: the updater shows them too ----------
const version = JSON.parse(read('package.json')).version;
const notesFile = args.includes('--notes') ? args[args.indexOf('--notes') + 1] : path.join(ROOT, 'release-notes', `${version}.md`);
const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '';
ok(notes.length > 0, `notes exist for ${version}`);
ok(/^## vi$/m.test(notes) && /^## en$/m.test(notes), 'notes have Vietnamese and English');
for (const [word, re] of [['Owner preview', /owner preview/i], ['owner', /\bowner\b/i], ['chủ sở hữu', /chủ sở hữu/i], ['a task code', /\b[A-Z]-\d{2}\b/], ['CoS', /\bCoS\b/]]) ok(!re.test(notes), `notes do not say "${word}"`);
ok(!/kokoro[^\n]*(recommended|khuyên)/i.test(notes), 'notes do not recommend Kokoro: it is not live until the pack is published');

// ---------- the Kokoro pack ----------
const kokoro = CATALOG.find((c) => c.id === 'voice.kokoro-82m');
ok(kokoro.download.sha256 !== ARCHIVED_ZIP_SHA, 'the catalog does not pin the archived zip');
// The Marketplace lists only what installs: an item without a pinned download is a dead card in a new user's store.
ok(CATALOG.every((c) => c.download && /^[0-9a-f]{64}$/.test(c.download.sha256) && c.download.bytes > 0), 'every catalog item has a pinned download', CATALOG.filter((c) => !c.download).map((c) => c.id).join());
ok(/market-pack-kokoro\.mjs --out \S+ --check/.test(read('docs/RELEASING.md')), 'the pack is rebuilt and checked before upload, never taken from an archive');
if (args.includes('--kokoro')) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-gate-')), 'pack.zip');
  const r = spawnSync(process.execPath, ['scripts/market-pack-kokoro.mjs', '--out', out, '--check'], { cwd: ROOT, encoding: 'utf8' });
  ok(r.status === 0, 'a rebuild of the Kokoro pack equals the catalog pin', `${r.stdout || ''}${r.stderr || ''}`.slice(0, 300));
}

// ---------- packs-v1 must never become Latest: the updater reads releases/latest/download/latest.json ----------
const guide = read('docs/RELEASING.md');
const cmd = guide.split(/\r?\n/).find((l) => l.includes(`gh release create ${PACKS_TAG}`)) || '';
ok(cmd.includes('--prerelease') && cmd.includes('--latest=false'), `${PACKS_TAG} is created as a prerelease and never Latest`, cmd);
ok(cmd.includes(`--repo ${REPO}`), 'the command names the repo');
const tags = read('.github/workflows/release.yml').match(/tags: \[([^\]]*)\]/);
ok(Boolean(tags) && tags[1].trim() === "'v*'", 'only a v* tag starts the release workflow', tags && tags[1]);
ok(/releases\/latest\/download\/latest\.json/.test(read('tauri/src-tauri/tauri.conf.json')), 'the updater reads the Latest release: why this matters');
if (args.includes('--live')) {
  const r = spawnSync('gh', ['api', `repos/${REPO}/releases/latest`, '--jq', '.tag_name'], { encoding: 'utf8' });
  const latest = (r.stdout || '').trim();
  const none = r.status !== 0 && /404/.test(r.stderr || '');
  ok(none || /^v\d/.test(latest), 'GitHub\'s Latest release is an app release, or none exists yet', latest || r.stderr);
}

console.log(`\ncheck-release-gate: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
