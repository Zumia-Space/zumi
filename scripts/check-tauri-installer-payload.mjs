// T-31 installer payload gate (26-10): extract the BUILT NSIS installer with 7-Zip and look at what it really carries.
//   node scripts/check-tauri-installer-payload.mjs [--installer <setup.exe>] [--out <dir on a non-C drive>] [--keep-listing]
//   node scripts/check-tauri-installer-payload.mjs --selftest        (parser + duplicate finder on synthetic listings, no 7z)
// FAILs on any payload path that the installer packs more than once (r4 packed zumi-vault.exe twice: tauri-cli bundles every
// [[bin]] of the package AND the resource dir bundle/ held the same exe). Prints `PAYLOAD_DIR=<dir>` last so build.ps1 can run
// check-bundle against the extracted payload: future kits are verified against the extracted payload, not the build tree.
// Exit 0 = payload unique, 1 = duplicate or unreadable installer, 2 = no 7-Zip on this box (reported, never a silent pass).
// No network, no window; nothing is written to drive C.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Payload paths of `7z l -slt` output, in archive order. The first block (Path = <the archive itself>) is the header. */
export function parseSltPaths(text) {
  const afterHeader = text.split(/\r?\n-{5,}\r?\n/)[1];
  if (afterHeader === undefined) return [];
  const out = [];
  for (const block of afterHeader.split(/\r?\n\r?\n/)) {
    const m = /^Path = (.*)$/m.exec(block);
    if (m && !/^Folder = \+$/m.test(block)) out.push(m[1]);
  }
  return out;
}

/** Entries that occur more than once (case-insensitive, / and \ the same). Returns [{ path, count }]. */
export function findDuplicates(paths) {
  const seen = new Map();
  for (const p of paths) {
    const key = p.replace(/\\/g, '/').toLowerCase();
    const e = seen.get(key) || { path: p, count: 0 };
    e.count++;
    seen.set(key, e);
  }
  return [...seen.values()].filter((e) => e.count > 1);
}

export function find7z(env = process.env) {
  const cands = [env.SEVENZIP, env.SEVEN_ZIP];
  for (const dir of (env.PATH || '').split(path.delimiter)) for (const n of ['7z.exe', '7za.exe', '7zr.exe']) cands.push(path.join(dir, n));
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files', 'D:\\Program Files', 'D:\\Apps']) {
    if (!base) continue;
    cands.push(path.join(base, '7-Zip', '7z.exe'), path.join(base, '7z', '7z.exe'));
  }
  cands.push('C:\\Program Files\\NVIDIA Corporation\\NVIDIA GeForce Experience\\7z.exe'); // a genuine 7-Zip 22.01 shipped with the GPU driver
  return cands.filter(Boolean).find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
let fail = 0;
const ok = (cond, name, detail = '') => { if (!cond) fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? '  ' + detail : ''}`); };

function selftest() {
  const listing = ['hdr', 'Path = X.exe', 'Type = Nsis', '', '----------', 'Path = $PLUGINSDIR\\a.dll', 'Size = 1', '', 'Path = zumi-vault.exe', 'Size = 2', '', 'Path = tauri\\x.mjs', 'Size = 3', '', 'Path = ZUMI-VAULT.EXE', 'Size = 2', ''].join('\n');
  const paths = parseSltPaths(listing);
  ok(paths.length === 4 && paths[1] === 'zumi-vault.exe', 'selftest: the header block is skipped, four payload paths parsed', JSON.stringify(paths));
  const dups = findDuplicates(paths);
  ok(dups.length === 1 && dups[0].count === 2 && /vault/i.test(dups[0].path), 'selftest: a case-different second zumi-vault.exe is a duplicate', JSON.stringify(dups));
  ok(findDuplicates(['a/b', 'a\\c', 'd']).length === 0, 'selftest: distinct paths are not duplicates');
  ok(findDuplicates(['a/b', 'a\\b']).length === 1, 'selftest: / and \\ are the same path');
}

function newestInstaller() {
  const targets = [process.env.CARGO_TARGET_DIR && path.resolve(process.env.CARGO_TARGET_DIR), path.join(ROOT, 'tauri', 'src-tauri', 'target')].filter(Boolean);
  const found = [];
  for (const t of targets) {
    const dir = path.join(t, 'release', 'bundle', 'nsis');
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir)) if (/-(setup|(owner|selftest)-installer)\.exe$/i.test(n)) found.push(path.join(dir, n));
  }
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function main() {
  const installer = path.resolve(argValue('--installer') || newestInstaller() || '');
  if (!argValue('--installer') && !newestInstaller()) { console.log('FAIL no installer found: pass --installer <setup.exe> or build first (tauri\\build.ps1 -Flavour owner, or -Flavour public for a public kit)'); process.exit(1); }
  if (!fs.existsSync(installer)) { console.log(`FAIL installer exists ${installer}`); process.exit(1); }
  const sevenZ = find7z();
  if (!sevenZ) { console.log('BLOCKED no 7-Zip (7z.exe) on this box: set SEVENZIP=<path to 7z.exe> or put 7z on PATH. Not a pass.'); process.exit(2); }
  console.log(`installer: ${installer}\n7z:       ${sevenZ}`);

  const out = path.resolve(argValue('--out') || path.join(ownerPath('scratchDir', os.tmpdir()), `installer-payload-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  if (/^c:/i.test(out) || path.relative(os.tmpdir(), out) === '' || !/^[a-z]:/i.test(out)) { console.log(`FAIL the extraction dir must be on a non-C drive: ${out}`); process.exit(1); }

  const list = spawnSync(sevenZ, ['l', '-slt', installer], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  ok(list.status === 0, '7z lists the installer', (list.stderr || list.stdout || '').slice(0, 300));
  if (list.status !== 0) process.exit(1);
  const paths = parseSltPaths(list.stdout);
  ok(paths.length > 0, `the installer lists payload entries (${paths.length})`);
  const dups = findDuplicates(paths);
  ok(dups.length === 0, 'no payload entry is packed more than once', dups.map((d) => `${d.path} x${d.count}`).join('; '));
  ok(paths.filter((p) => p.toLowerCase() === 'zumi-vault.exe').length === 1, 'zumi-vault.exe is in the payload exactly once (beside the main exe)');

  fs.mkdirSync(out, { recursive: true });
  const ex = spawnSync(sevenZ, ['x', '-y', '-aoa', `-o${out}`, installer], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  ok(ex.status === 0, `7z extracts the installer into ${out}`, (ex.stderr || ex.stdout || '').slice(-300));
  if (ex.status === 0) for (const f of [fs.existsSync(path.join(out, 'Zumi.exe')) ? 'Zumi.exe' : 'ZumiPreview.exe', 'zumi-vault.exe']) ok(fs.existsSync(path.join(out, f)), `extracted payload has ${f}`);
  console.log(fail ? '\ninstaller payload FAIL' : '\ninstaller payload OK');
  console.log(`PAYLOAD_DIR=${out}`);
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) { selftest(); console.log(fail ? `\n${fail} FAILED` : '\nall passed'); process.exit(fail ? 1 : 0); }
else if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || path.resolve(process.argv[1] || '') === path.resolve(import.meta.filename)) main();
