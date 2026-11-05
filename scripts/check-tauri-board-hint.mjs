// T-31 parity 13a / GATE-10b condition 2: the owner's Board tab must show the honest not-available hint on
// Tauri, not an endless "opening" spinner. board.liveOpen stays waived to P2; nothing is faked.
//
// Plain Node, no window, no Electron, no network. The renderer half runs in a child process
// (scripts/board-hint-renderer-check.mjs) so evaluating app.js cannot leak globals into this check.
//
//   node scripts/check-tauri-board-hint.mjs
//
// Includes its own negative control: the same child run against the pre-fix shim (liveOpen rejects) must FAIL,
// so a green run proves the harness really detects the endless-spinner bug rather than passing vacuously.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(ROOT, 'scripts', 'board-hint-renderer-check.mjs');
const SHIM = path.join(ROOT, 'tauri', 'shim', 'zumi-shim.js');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };

function runChild(shimPath) {
  const r = spawnSync(process.execPath, [CHILD, shimPath], { encoding: 'utf8', timeout: 60000 });
  if (r.error) return { error: String(r.error.message || r.error), stderr: r.stderr || '' };
  try { return { results: JSON.parse(r.stdout.trim()), status: r.status, stderr: r.stderr || '' }; }
  catch (e) { return { error: `child output is not JSON: ${e.message}`, stdout: r.stdout, stderr: r.stderr || '' }; }
}

// ---- the committed shim + the real app.js fragment ----
const main = runChild(SHIM);
if (main.error) {
  ok(false, 'the board-hint renderer child ran', main.error + (main.stderr ? `  stderr: ${main.stderr.slice(0, 300)}` : ''));
} else {
  for (const r of main.results) ok(r.ok, r.name, r.detail);
}

// ---- negative control: the pre-fix rejecting shim must fail this check ----
const HONEST_LIVE_OPEN = 'function () { return $invoke("board.liveOpen", []).catch(function (e) { var m = String((e && e.message) || e); return { error: m === "not_implemented:board.liveOpen" ? "live_board_later" : m }; }); }';
const REJECTING_LIVE_OPEN = 'function () { return $invoke("board.liveOpen", []); }';
const shimSrc = fs.readFileSync(SHIM, 'utf8');
const tmpRoot = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tmpRoot, 'board-hint-'));
try {
  const swapped = shimSrc.includes(HONEST_LIVE_OPEN)
    ? shimSrc.replace(HONEST_LIVE_OPEN, REJECTING_LIVE_OPEN)
    : null;
  ok(Boolean(swapped) && swapped !== shimSrc, 'negative control: the committed shim has the honest liveOpen resolve to swap back');
  if (swapped) {
    const rejectingShim = path.join(tmp, 'zumi-shim.js');
    fs.writeFileSync(rejectingShim, swapped);
    const control = runChild(rejectingShim);
    if (control.error) {
      ok(false, 'negative control: the rejecting-shim child ran', control.error);
    } else {
      const failed = control.results.filter((r) => !r.ok).map((r) => r.name);
      ok(failed.length > 0, 'negative control: the rejecting shim FAILS the board-hint check', failed.join('; '));
      ok(failed.some((n) => /settles|spinner|liveInElectron|live_board_later/.test(n)),
        'negative control: the endless-spinner failure is the one detected', failed.join('; '));
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
