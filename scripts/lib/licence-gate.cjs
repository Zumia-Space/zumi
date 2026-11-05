// Runs scripts/check-third-party.mjs for an electron-builder build and throws when it is RED, so an installer is never packed
// with an unmapped file, a missing licence text, an UNVERIFIED asset (release flavour) or an owner-only file in the release bundle.
// release (npm run dist, the owner's own installer): UNVERIFIED = fail, open legal items = WARN. owner: UNVERIFIED = WARN (the list is printed),
// every other problem still fails. public (a build for other people; no hook runs it yet): release rules, and open legal items fail too.
// The child is started with ZUMI_CONFIG_INSPECT / --release-config-file stripped: the gate must read the real configs, never a scratch one.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runLicenceGate(flavour, outDir, { gateArgs = [], print = console.log } = {}) {
  if (!['public', 'release', 'owner'].includes(flavour)) throw new Error(`licence gate: flavour must be public, release or owner, got "${flavour}"`);
  const root = path.join(__dirname, '..', '..');
  const env = { ...process.env };
  delete env.ZUMI_CONFIG_INSPECT;
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-third-party.mjs'), '--flavour', flavour, ...gateArgs], { cwd: root, env, encoding: 'utf8', timeout: 300000 });
  const code = r.status === null ? `killed (${r.signal || 'timeout'})` : r.status;
  const text = `${(r.stdout || '').trimEnd()}\n${(r.stderr || '').trimEnd()}\n`;
  fs.mkdirSync(outDir, { recursive: true });
  const log = path.join(outDir, `third-party-gate-${flavour}.log`);
  fs.writeFileSync(log, `===== node scripts/check-third-party.mjs --flavour ${flavour} ${gateArgs.join(' ')} -> exit ${code}\n${text}`);
  print(`  • licence gate (${flavour}): exit ${code}; full output in ${log}`);
  // owner prints its whole warn list on the console; release prints the fail list the same way
  for (const line of text.split('\n')) if (/^(FAIL|WARN|RED|GREEN|  [A-Z-]{6,} )/.test(line)) print(`    ${line}`);
  if (r.status !== 0) throw new Error(`licence gate failed (${flavour}): exit ${code}; see ${log}`);
  return { code: r.status, log };
}

module.exports = { runLicenceGate };
