// T-31 public preview installer check: pins the NSIS settings that let the user pick the install folder.
// Plain Node, no build, no window, no network.
//   - bundle target is NSIS only; installMode stays "currentUser" (per-user, no admin);
//   - no custom NSIS template / installer hooks that could remove the directory page;
//   - when the pinned tauri-bundler template is on disk, its directory page is unconditional (only skipped in passive mode).
//   node scripts/check-tauri-installer.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, name, detail = '') => { if (!cond) fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? '  ' + detail : ''}`); };

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const nsis = conf.bundle?.windows?.nsis ?? {};
ok(JSON.stringify(conf.bundle?.targets) === '["nsis"]', 'bundle targets are exactly ["nsis"]', JSON.stringify(conf.bundle?.targets));
ok(nsis.installMode === 'currentUser', 'nsis.installMode is currentUser (per-user, no admin)', String(nsis.installMode));
ok(!('template' in nsis) && !('installerHooks' in nsis), 'no custom nsis template or installerHooks (default template keeps the directory page)');

const reg = path.join(ROOT, '.cargo-home', 'registry', 'src');
const tpl = fs.existsSync(reg)
  ? fs.readdirSync(reg).map((d) => path.join(reg, d)).flatMap((d) => fs.readdirSync(d).filter((n) => n.startsWith('tauri-bundler-')).map((n) => path.join(d, n, 'src', 'bundle', 'windows', 'nsis', 'installer.nsi'))).find(fs.existsSync)
  : undefined;
if (tpl) {
  const t = fs.readFileSync(tpl, 'utf8');
  ok(/MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive\r?\n!insertmacro MUI_PAGE_DIRECTORY/.test(t), 'bundler template shows the directory page (skipped only when passive)');
} else {
  console.log('SKIP bundler template not on disk');
}
// One copy of zumi-vault.exe in the installer (r4 packed it twice). tauri-cli bundles EVERY [[bin]] of the package beside the main
// exe, and bundle.resources "bundle/" already ships the staged copy, so the bin must be invisible to tauri-cli: it sits behind a
// required-feature that only the default cargo build enables (tauri-cli counts only features given on ITS command line).
const cargo = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'Cargo.toml'), 'utf8');
const vaultBin = /\[\[bin\]\]\r?\nname\s*=\s*"zumi-vault"[\s\S]*?(?=\r?\n\[|$)/.exec(cargo);
ok(vaultBin && /required-features\s*=\s*\[\s*"vault-bin"\s*\]/.test(vaultBin[0]), 'Cargo.toml: the zumi-vault [[bin]] has required-features = ["vault-bin"] (tauri-cli will not bundle it a second time)');
ok(/^\[features\][^[]*default\s*=\s*\[[^\]]*"vault-bin"[^\]]*\][^[]*vault-bin\s*=\s*\[\s*\]/m.test(cargo), 'Cargo.toml: vault-bin is a default feature, so plain cargo build / --bins / --bin zumi-vault still build the helper');
ok(conf.bundle?.resources && conf.bundle.resources['bundle/'] === '' && !conf.bundle.externalBin, 'tauri.conf.json: zumi-vault.exe ships through the staged resource dir only (no externalBin)');
// Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI: any non-ASCII literal (Vietnamese text) is mis-decoded and written out as mojibake.
const tauriDir = path.join(ROOT, 'tauri');
for (const n of fs.readdirSync(tauriDir).filter((f) => f.endsWith('.ps1'))) {
  const b = fs.readFileSync(path.join(tauriDir, n));
  const nonAscii = b.some((x) => x > 0x7f);
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  ok(!nonAscii || bom, `tauri/${n}: non-ASCII content needs a UTF-8 BOM (PowerShell 5.1 parses BOM-less as ANSI)`);
}
process.exit(fail ? 1 : 0);
