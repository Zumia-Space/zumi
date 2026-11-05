// Waiver condition 3 (T-31 0.2.9): the Electron board gate must FAIL, not SKIP, when one of its inputs is missing. In 0.2.8 a
// missing input made it exit 0 and the installer shipped with no gate evidence. Runs the gate with ZUMI_ELECTRON_HOST=box so it
// gets past the host guard, and with one input pointed at nothing; the gate must stop at its input check, before it could
// start Electron (nothing is launched here), with a non-zero exit and a message naming the input.
//   node scripts/check-board-gate-inputs.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The gate's own host guard (scripts/lib/electron-guard.cjs) is satisfied with its own constants, so the gate reaches its input
// check. That check runs before anything is spawned: this script never starts Electron.
const { ELECTRON_HOST_ENV, ELECTRON_HOST_VALUE } = createRequire(import.meta.url)('./lib/electron-guard.cjs');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

const out = path.join(ROOT, `.click-gate-inputs-${process.pid}`); // in this tree (D:), gitignored (.click-*)
const missing = path.join(ROOT, `.click-no-such-input-${process.pid}`);
for (const [what, env] of [['the Electron executable', { ELECTRON_EXE: path.join(missing, 'electron.exe') }], ['the board server source', { ELECTRON_EXE: process.execPath, BOARD_SERVER_SRC: missing }]]) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-board-open-electron.mjs'), '--app', ROOT, '--out', out], { env: { ...process.env, [ELECTRON_HOST_ENV]: ELECTRON_HOST_VALUE, ...env }, encoding: 'utf8', timeout: 60000 });
  const said = `${r.stdout}${r.stderr}`;
  check(`missing ${what}: the gate exits non-zero (never 0, which reads as a pass)`, r.status !== null && r.status !== 0, { status: r.status });
  check(`missing ${what}: the gate says FAIL and names the missing input, not SKIP`, /FAIL/.test(said) && !/SKIP/.test(said) && said.includes(path.basename(missing)), said.trim().split('\n').slice(0, 2));
}
fs.rmSync(out, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(`\n${failed ? 'FAIL' : 'PASS'} check-board-gate-inputs — ${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
