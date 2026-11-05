// T-31 parity step 7-5: ONE version, three places that must agree, and the installer name that carries it.
//
//   node scripts/check-tauri-version.mjs
//   node scripts/check-tauri-version.mjs --installer-dir tauri/src-tauri/target/release/bundle/nsis
//
// `package.json` is the single source of truth (Electron and the sidecar already read it). tauri.conf.json names it
// (the Tauri 2 path form, resolved relative to the conf file), and Cargo.toml must carry the same value. Any difference
// is a hard failure. After a build, `--installer-dir` also asserts that the NSIS artifact's file name contains that
// version, so an installer can never be published under a stale name.
//
// Plain Node, no Tauri, no window, no network. Exit 0 only when every assertion passes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'package.json');
const CONF = path.join(ROOT, 'tauri', 'src-tauri', 'tauri.conf.json');
const CARGO = path.join(ROOT, 'tauri', 'src-tauri', 'Cargo.toml');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const canary = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function main() {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const version = pkg.version;
  ok(typeof version === 'string' && canary.test(version), 'package.json has a semver version', String(version));
  if (typeof version !== 'string' || !canary.test(version)) {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }

  const conf = JSON.parse(fs.readFileSync(CONF, 'utf8'));
  // Tauri 2 accepts a semver or a path to a package.json. Step 7-3 requires the path form: one source, not a copy.
  ok(conf.version === '../../package.json', 'tauri.conf.json names package.json as its version source (no copy)', String(conf.version));
  let resolvedConf = null;
  if (typeof conf.version === 'string') {
    const candidate = path.resolve(path.dirname(CONF), conf.version);
    if (candidate.toLowerCase().endsWith('package.json') && fs.existsSync(candidate)) {
      try { resolvedConf = JSON.parse(fs.readFileSync(candidate, 'utf8')).version; } catch { resolvedConf = null; }
    } else if (canary.test(conf.version)) {
      resolvedConf = conf.version; // a literal semver: still checked for equality below
    }
  }
  ok(resolvedConf === version, `tauri.conf.json resolves to ${version}`, `got ${resolvedConf}`);

  const cargoText = fs.readFileSync(CARGO, 'utf8');
  const packageSection = cargoText.split(/^\[/m).find((s) => s.startsWith('package]')) || '';
  const cargoVersion = (packageSection.match(/^version\s*=\s*"([^"]+)"/m) || [])[1] || null;
  ok(cargoVersion === version, `Cargo.toml [package] version is ${version}`, `got ${cargoVersion}`);

  const installerDir = argValue('--installer-dir');
  if (installerDir) {
    const dir = path.resolve(ROOT, installerDir);
    const installers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f)) : [];
    ok(installers.length > 0, 'the installer directory has a built .exe', dir);
    ok(installers.every((f) => f.includes(version)), `every installer file name contains ${version}`, installers.join(', '));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
