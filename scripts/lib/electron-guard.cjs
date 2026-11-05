'use strict';
// One guard for every script that starts Electron or a packaged Zumi (T-31 auto-update, coordinator 13-10, after a
// "Node" check started electron.exe on anh's main PC). Electron and app windows run ONLY on the render box: its run
// scripts set ZUMI_ELECTRON_HOST=box. anh's main PC never sets it, so every guarded script refuses there, loudly.
// Call assertElectronHost(<what>) before the spawn (or, in a script Electron itself runs, before anything else).
// CommonJS so the .cjs Electron harnesses, builder-selftest.cjs and the .mjs checks can all load it.
//   node scripts/lib/electron-guard.cjs "<what>"              exit 1 unless on the box (npm scripts: guard && electron …)
//   node scripts/lib/electron-guard.cjs "<what>" --allow-dev  `npm start` only: also passes with ZUMI_DEV_ELECTRON=1,
//                                                             a developer's explicit "yes, open the app here"
const ELECTRON_HOST_ENV = 'ZUMI_ELECTRON_HOST';
const ELECTRON_HOST_VALUE = 'box';
const DEV_ENV = 'ZUMI_DEV_ELECTRON';

/** true only on the render box (ZUMI_ELECTRON_HOST=box). */
function onElectronHost(env = process.env) {
  return env[ELECTRON_HOST_ENV] === ELECTRON_HOST_VALUE;
}

/**
 * Throws unless on the render box. `what` names the script/step in the message. `allowDev` (npm start only): an
 * explicit ZUMI_DEV_ELECTRON=1 also passes; checks and harnesses never take it.
 */
function assertElectronHost(what, env = process.env, { allowDev = false } = {}) {
  if (onElectronHost(env)) return;
  if (allowDev && env[DEV_ENV] === '1') return;
  const dev = allowDev ? ` For a deliberate dev run on a machine that is not anh's main PC, set ${DEV_ENV}=1.` : '';
  const err = new Error(`REFUSED: ${what} starts Electron / Zumi.exe, which runs only on the render box (${ELECTRON_HOST_ENV}=${ELECTRON_HOST_VALUE}, set by the box's run scripts). anh's main PC never sets it. Nothing was launched.${dev}`);
  err.code = 'ELECTRON_HOST_REQUIRED';
  throw err;
}

/** For scripts Electron itself runs: print and exit 1 instead of throwing (an uncaught throw in Electron's main
 *  process opens an error dialog, i.e. a window). */
function exitUnlessElectronHost(what, env = process.env, o = {}) {
  try { assertElectronHost(what, env, o); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { ELECTRON_HOST_ENV, ELECTRON_HOST_VALUE, DEV_ENV, onElectronHost, assertElectronHost, exitUnlessElectronHost };

if (require.main === module) {
  const argv = process.argv.slice(2);
  exitUnlessElectronHost(argv.find((a) => !a.startsWith('--')) || 'this command', process.env, { allowDev: argv.includes('--allow-dev') });
}
