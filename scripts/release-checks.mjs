// The checks a release must pass. One list, run the same way by .github/workflows/release.yml and, inside a fresh export, by the
// maintainers' rehearsal. Any failure fails the run; nothing is skipped because a file is missing.
//   node scripts/release-checks.mjs            a tag: everything
//   node scripts/release-checks.mjs --dry      a rehearsal: no signing key is baked in yet, GitHub's Latest is not asked, no pack is downloaded
//   --also <script.mjs>                        add a script (the rehearsal's negative control)
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
export const RELEASE_CHECKS = [
  ['check-tauri-version'],
  dry ? ['check-tauri-updater'] : ['check-tauri-updater', '--release'],
  ['check-tauri-allowlist'],
  ['check-tauri-installer'],
  ['check-tauri-flavour'],
  ['check-tauri-window'],
  ['check-tauri-shim'],
  ['check-tauri-egress'],
  ['check-market-host'],
  ['check-ui-lang'],
  ['check-contributing'],
  ['check-checks-registered'],
  ['check-public-first-run'],
  ['check-memory-notes'],
  ['check-public-text'],
  ['check-first-run-setup'],
  ['check-free-key-guide'],
  dry ? ['check-release-gate', '--kokoro'] : ['check-release-gate', '--kokoro', '--live'],
  // A tag: every pack the catalog pins is downloaded with the job token and must equal its pin (draft or published, private or public).
  ...(dry ? [] : [['check-packs-asset']]),
];
if (args.includes('--also')) RELEASE_CHECKS.push([args[args.indexOf('--also') + 1]]);

const failed = [];
for (const [name, ...rest] of RELEASE_CHECKS) {
  const script = name.endsWith('.mjs') ? name : `scripts/${name}.mjs`;
  const r = spawnSync(process.execPath, [script, ...rest], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 27 });
  const lines = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).filter(Boolean);
  if (r.status === 0) { console.log(`ok   ${name} ${rest.join(' ')}`); continue; }
  failed.push(name);
  console.log(`RED  ${name} ${rest.join(' ')} (exit ${r.status})`);
  for (const l of lines.filter((x) => /\bFAIL\b|Error/.test(x)).slice(0, 8)) console.log(`     ${l.slice(0, 220)}`);
}
console.log(failed.length ? `\nrelease-checks: RED ${failed.join(', ')}` : `\nrelease-checks: all ${RELEASE_CHECKS.length} passed`);
if (failed.length) process.exit(1);
