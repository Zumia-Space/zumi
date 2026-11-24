'use strict';
// The one contract between a check and scripts/run-all-checks.mjs (gate MF-R1/MF-R2). A check that cannot run because a
// precondition is absent calls notRun(): it prints ONE marker line and exits 3. Nothing else ever means "not run":
// exit 0 is a pass, any other exit is a FAIL. The runner never reads PASS/FAIL text, so a product fault whose output
// happens to mention a missing bundle or the render box is still a FAIL.
// A check that ran but skipped one of its own cases prints a line that starts with SKIP; the runner shows `pass (N skipped)`.
const NOT_RUN_EXIT = 3;
const NOT_RUN_MARK = 'ZUMI-CHECK-NOT-RUN:';

/** Print the marker (kind = box | bundle | precondition, why = what is missing) and exit 3. */
function notRun(kind, why) {
  console.log(`${NOT_RUN_MARK} ${kind} - ${String(why).split(/\r?\n/)[0]}`);
  process.exit(NOT_RUN_EXIT);
}

/** Run fn (an assertElectronHost call); on the guard's refusal report NOT RUN, any other error is rethrown. */
function notRunOnBoxRefusal(fn) {
  try { fn(); } catch (e) { if (e && e.code === 'ELECTRON_HOST_REQUIRED') notRun('box', e.message); throw e; }
}

/** The runner's classifier. status: pass | fail | not-run; skipped = partial skips counted on a pass. */
function classify(output, code) {
  const marker = String(output).split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(NOT_RUN_MARK));
  // exit 3 without the marker, or the marker with another exit code, is a fault in the check itself: never a quiet NOT RUN.
  // A check that asserted something, saw a FAIL, and only then found its precondition missing (settings-normal-launch ran 4 static
  // asserts before its box test) has a product fault: the missing precondition must not hide it. Gate LIVE-2011 R1.
  const lines = String(output).split(/\r?\n/);
  const markAt = lines.findIndex((l) => l.trim().startsWith(NOT_RUN_MARK));
  if (markAt >= 0 && lines.slice(0, markAt).some((l) => /^\s*FAIL\b/.test(l))) return { status: 'fail', kind: 'fail-before-not-run', skipped: 0 };
  if (marker) return code === NOT_RUN_EXIT ? { status: 'not-run', kind: marker.slice(NOT_RUN_MARK.length).trim().split(/\s+/)[0] || 'precondition', skipped: 0 } : { status: 'fail', kind: 'marker-with-wrong-exit', skipped: 0 };
  if (code !== 0) return { status: 'fail', kind: '', skipped: 0 };
  return { status: 'pass', kind: '', skipped: String(output).split(/\r?\n/).filter((l) => /^\s*SKIP\b/i.test(l)).length };
}

/**
 * Static scan for the shape that made MF-R1 (gate LIVE-2011 R2): a check announces that it skipped something and then ends with a
 * clean exit, so the runner reports a pass. Returns the line number of every announcement (a console or stdout write whose text
 * holds skip, skipped or skipping, in any case) that has a clean exit (`process.exit(0)`, `process.exit()`, `process.exitCode = 0`)
 * within the next 12 lines. A partial skip that goes on to assert more is the runner's `pass (N skipped)` and is not near an exit.
 */
function scanSkipThenCleanExit(text) {
  const lines = String(text).split(/\r?\n/), out = [];
  const announce = /(console\.(log|error|warn|info)|process\.(stdout|stderr)\.write)\s*\(.*\bskip(ped|ping)?\b/i;
  const clean = /process\.exit\(\s*0?\s*\)|process\.exitCode\s*=\s*0\b/;
  lines.forEach((l, i) => { if (announce.test(l) && lines.slice(i, i + 13).some((x) => clean.test(x))) out.push(i + 1); });
  return out;
}

module.exports = { scanSkipThenCleanExit, NOT_RUN_EXIT, NOT_RUN_MARK, notRun, notRunOnBoxRefusal, classify };
