// T-31 P1c4 extends it: the window helper refuses off the box too, and the main-phase verdict functions
// (tauri/verify/main-phase.mjs) are checked as pure code, since the real run happens only on the spare PC.
//
// T-31 P1c1: the guard-probe kit refuses off the render box. The probe server opens a non-loopback
// listener and the runner starts the preview build, so both refuse unless ZUMI_ELECTRON_HOST=box — the
// one rule in scripts/lib/electron-guard.cjs. Plain Node, no Electron, no window, no listener: on anh's
// main PC this check proves the refusal (a broken guard would open a listener here, which is why the
// server must refuse before any listen()).
//   node scripts/check-tauri-guard-host.mjs   (npm run check:tauri-guard-host)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'tauri', 'verify', 'guard-probe', 'server', 'server.mjs');
const RUNNER = path.join(ROOT, 'tauri', 'verify', 'run-guard-probe.ps1');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};

// 1. Plain node on this PC (no ZUMI_ELECTRON_HOST): REFUSED, exit 1, no listener.
{
  const env = { ...process.env, PORT: '0' };
  delete env.ZUMI_ELECTRON_HOST;
  const r = spawnSync(process.execPath, [SERVER], { env, encoding: 'utf8', timeout: 20000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  check('the probe server exits 1 without ZUMI_ELECTRON_HOST=box', r.status === 1, { status: r.status, signal: r.signal });
  check('... prints REFUSED (the one rule from electron-guard.cjs)', /REFUSED/.test(out), out.trim());
  check('... and opened no listener (no "listening on" line)', !/listening on/.test(out), out.trim());
}

// 2. The server loads the shared guard rather than re-implementing the rule.
check('server.mjs loads scripts/lib/electron-guard.cjs', /electron-guard\.cjs/.test(fs.readFileSync(SERVER, 'utf8')));

// 3. The PowerShell runner checks the host before it starts anything or opens a listener.
{
  const s = fs.readFileSync(RUNNER, 'utf8');
  const guard = s.search(/\$env:ZUMI_ELECTRON_HOST\s+-ne/);
  const start = s.search(/Start-Process\s+-FilePath/);
  check('the runner checks ZUMI_ELECTRON_HOST before Start-Process -FilePath', guard >= 0 && start >= 0 && guard < start, { guard, start });
  check("the runner's rule is the same one (ZUMI_ELECTRON_HOST must be 'box')", /ZUMI_ELECTRON_HOST[^\n]*-ne\s*'box'/.test(s));
}

// 4. P1c4: the window helper moves windows, the foreground and the mouse, so it refuses off the box BEFORE
// it compiles user32 or touches anything.
{
  const helper = path.join(ROOT, 'tauri', 'verify', 'win-helper.ps1');
  const env = { ...process.env };
  delete env.ZUMI_ELECTRON_HOST;
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Cmd', 'top-count', '-TargetPid', '0'], { env, encoding: 'utf8', timeout: 60000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  check('win-helper.ps1 exits 1 without ZUMI_ELECTRON_HOST=box', r.status === 1, { status: r.status });
  check('... prints REFUSED and does nothing else', /REFUSED/.test(out) && !/count/.test(out), out.trim());
  const src = fs.readFileSync(helper, 'utf8');
  const hostCheck = src.search(/\$env:ZUMI_ELECTRON_HOST\s+-ne/);
  check('the helper checks the host before Add-Type', hostCheck >= 0 && hostCheck < src.indexOf('Add-Type -TypeDefinition'));
  const runner = fs.readFileSync(RUNNER, 'utf8');
  check('the runner starts the window watcher before the exe and waits for it', runner.indexOf("'-Cmd', 'watch'") >= 0 && runner.indexOf("'-Cmd', 'watch'") < runner.indexOf('-FilePath $Exe') && /\.ready/.test(runner));
  check('the runner passes the pid, helper and watcher output to the driver', /--pid \$proc\.Id --helper \$helper --watch \$watchOut/.test(runner));
}

// 5. P1c4: the main-phase verdicts, as pure code.
{
  const m = await import('../tauri/verify/main-phase.mjs');
  const driver = fs.readFileSync(path.join(ROOT, 'tauri', 'verify', 'drive-guard-probe.mjs'), 'utf8');
  const phase = fs.readFileSync(path.join(ROOT, 'tauri', 'verify', 'main-phase.mjs'), 'utf8');
  const srv = fs.readFileSync(SERVER, 'utf8');
  check('the driver imports the main phase and requires main PASS next to the guest PASS', /from '\.\/main-phase\.mjs'/.test(driver) && /guestPass && mainBlock\.verdict === 'PASS'/.test(driver));
  check('the main phase bypasses CSP, reloads and proves the bypass with a loopback control', /Page\.setBypassCSP/.test(phase) && /Page\.reload/.test(phase) && /controls\.mainOk/.test(phase) && /\/main-ok/.test(srv));
  check('the server answers every main path (/main-ok, /main-iframe, /main-redirect, /__main_page)', ['/main-ok', '/main-iframe', '/main-redirect', '/__main_page'].every((p) => srv.includes(`'${p}'`)));
  check('every main vector has a body and a unique remote path', Object.keys(m.MAIN_VECTORS).every((n) => phase.includes(`'${n}':`) || phase.includes(`  ${n}:`)) && new Set(Object.values(m.MAIN_VECTORS)).size === Object.keys(m.MAIN_VECTORS).length);
  check('window-open, form-post, location-nav and the worker vectors are in the vector list', ['window-open', 'form-post', 'location-nav', 'worker-fetch', 'shared-worker-fetch', 'beacon', 'redirect'].every((n) => n in m.MAIN_VECTORS));
  check('no stdout line carries a URL (no origin/remote/href reaches process.stdout)', !/stdout\.write\([^)]*(remoteBase|\.origin|location\.href)/.test(driver + phase));

  const j = m.judgeVector;
  check('judgeVector: a missing report is FAIL', j('fetch', undefined, false).status === 'FAIL');
  check('judgeVector: throw is FAIL, timeout and n/a are INCONCLUSIVE', j('fetch', 'throw', false).status === 'FAIL' && j('fetch', 'timeout', false).status === 'INCONCLUSIVE' && j('worker-fetch', 'n/a:worker-error', false).status === 'INCONCLUSIVE');
  check('judgeVector: a remote hit is FAIL even when the page saw a block', j('fetch', 'rejected:TypeError', true).status === 'FAIL');
  check('judgeVector: a quiet reported vector is PASS', j('img', 'error', false).status === 'PASS');
  check('judgeVector: window.open must report denied', j('window-open', 'denied', false).status === 'PASS' && j('window-open', 'opened', false).status === 'FAIL');
  check('judgeVector: a navigation vector that left the app page is FAIL', j('location-nav', 'assigned', false, false).status === 'FAIL' && j('location-nav', 'assigned', false, true).status === 'PASS');

  check('judgeEvents: exactly one matching event passes', m.judgeEvents([{ t: 'visible', v: false }, { t: 'focus', v: false }], 'visible', [false]).status === 'PASS');
  check('judgeEvents: a repeat or a missing event fails', m.judgeEvents([{ t: 'visible', v: false }, { t: 'visible', v: false }], 'visible', [false]).status === 'FAIL' && m.judgeEvents([], 'focus', [true]).status === 'FAIL');
  check('judgeNoBlur: a focus:false after the click fails, focus:true does not', m.judgeNoBlur([{ t: 'focus', v: false }]).status === 'FAIL' && m.judgeNoBlur([{ t: 'focus', v: true }]).status === 'PASS');

  const good = 'noise\nguard: main source-kinds=all\nguard: main first=document\nwindow: main shown\n';
  const watch = { pollMs: 20, firstVisibleMs: 2100, guardSeenMs: 1500, shownSeenMs: 2090, timedOut: false };
  check('judgeStartup: guard < first=document < shown, window visible after the guard, is PASS', m.judgeStartup(good, watch).status === 'PASS');
  check('judgeStartup: first=other (the filter missed the document) is FAIL', m.judgeStartup(good.replace('first=document', 'first=other'), watch).status === 'FAIL');
  check('judgeStartup: shown before the guard line is FAIL', m.judgeStartup('window: main shown\nguard: main source-kinds=all\nguard: main first=document\n', watch).status === 'FAIL');
  check('judgeStartup: a window visible before the guard line is FAIL', m.judgeStartup(good, { ...watch, firstVisibleMs: 1000 }).status === 'FAIL');
  check('judgeStartup: a window visible long before the "window: main shown" line (not the legitimate show) is FAIL', m.judgeStartup(good, { ...watch, firstVisibleMs: 1700, shownSeenMs: 2090 }).status === 'FAIL' && m.judgeStartup(good, watch).shownMinusVisibleMs === -10);
  check('judgeStartup: no watcher data is INCONCLUSIVE, a guard FAILED line is FAIL', m.judgeStartup(good, null).status === 'INCONCLUSIVE' && m.judgeStartup(`${good}guard: main FAILED x\n`, watch).status === 'FAIL');

  const rpcBase = { minWindow: { width: 900, height: 600 }, status: { phase: 'off' }, install: false, later: false, bridgeRefused: 'unknown_method:zumiHost.apply' };
  check('judgeRpc: minWindow 900x600, the feed-less update answers and the refused guest bridge pass', m.judgeRpc(rpcBase).status === 'PASS');
  check('judgeRpc: the old 1024x700 minimum, a truthy install, or an allowed guest bridge fails', m.judgeRpc({ ...rpcBase, minWindow: { width: 1024, height: 700 } }).status === 'FAIL' && m.judgeRpc({ ...rpcBase, install: true }).status === 'FAIL' && m.judgeRpc({ ...rpcBase, bridgeRefused: 'allowed' }).status === 'FAIL');
  check('judgeExit: gone within 5 s passes, still alive fails, no helper is INCONCLUSIVE', m.judgeExit({ ok: true, exited: true, ms: 800 }).status === 'PASS' && m.judgeExit({ ok: true, exited: false, ms: 5001 }).status === 'FAIL' && m.judgeExit({ ok: false, reason: 'no_helper' }).status === 'INCONCLUSIVE');
  check('combine: FAIL beats INCONCLUSIVE beats PASS', m.combine(['PASS', 'INCONCLUSIVE', 'FAIL']) === 'FAIL' && m.combine(['PASS', 'INCONCLUSIVE']) === 'INCONCLUSIVE' && m.combine(['PASS']) === 'PASS');

  // Parity 11-2: the wardrobe guest's one bridge, measured by the probe page itself, and the main
  // webview's refusal through rpc. The board guest's refusal has no page hook: it is pinned by the Rust
  // guard test (guest_guard_blocks(uri, false)) and the capability check in check-tauri-guest.
  check('the probe page still reports whether a guest bridge exists (bridge_keys / bridge_other)', /bridge_keys/.test(srv) && /bridge_other/.test(srv) && /window\.zumiHost/.test(srv));
  // T-31 alpha.12 (alpha.11 review finding 1): no wardrobe guest any more. The runner starts the probe server and names its
  // origin; the stand-in is a board guest, so BOTH custom-protocol hosts must be BLOCKED and no guest may carry a bridge.
  check('the driver expects ipc.localhost AND tauri.localhost BLOCKED and gates the guest PASS on "no bridge"', /LOCALHOST_EXPECT = \{ 'ipc\.localhost': 'BLOCKED', 'tauri\.localhost': 'BLOCKED' \}/.test(driver) && /bridgeKeys === 'missing'/.test(driver) && /localhostOk && bridgeOk/.test(driver));
  check('the driver no longer calls zumi.wardrobe.open and reads the runner-named probe origin', !/zumi\.wardrobe/.test(driver) && /ZUMI_GUARD_PROBE_ORIGIN/.test(driver) && /info\.boardPartition/.test(driver));
  const runner2 = fs.readFileSync(RUNNER, 'utf8');
  check('the runner starts the probe server itself, names its origin, and stops it', !/ZUMI_WARDROBE_DIR/.test(runner2) && /ZUMI_GUARD_PROBE_ORIGIN = "http:\/\/127\.0\.0\.1:\$ProbePort"/.test(runner2) && /Stop-Process -Id \$probeServer\.Id/.test(runner2));
  const sidecar = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), 'utf8');
  const fnSrc = (sidecar.match(/export function guardProbeOriginOf\(env\) \{[\s\S]*?\n\}/) || [''])[0];
  const guardProbeOriginOf = fnSrc ? new Function(`${fnSrc.replace('export ', '')}; return guardProbeOriginOf;`)() : () => 'missing';
  check('sidecar: the probe origin is admitted only on the render box', guardProbeOriginOf({ ZUMI_GUARD_PROBE_ORIGIN: 'http://127.0.0.1:47931' }) === null && guardProbeOriginOf({ ZUMI_ELECTRON_HOST: 'box', ZUMI_GUARD_PROBE_ORIGIN: 'http://127.0.0.1:47931' }) === 'http://127.0.0.1:47931');
  check('sidecar: only a 127.0.0.1 http origin with a port (no https, no other host, no garbage)', ['https://127.0.0.1:1', 'http://localhost:1', 'http://10.0.0.2:1', 'http://127.0.0.1', 'not a url'].every((o) => guardProbeOriginOf({ ZUMI_ELECTRON_HOST: 'box', ZUMI_GUARD_PROBE_ORIGIN: o }) === null));
  check('sidecar: the probe origin attaches on the board partition only', /if \(guardProbeOrigin && sameOrigin\(src, guardProbeOrigin\)\) return \{ allow: partition === 'preview-board', origin: guardProbeOrigin \};/.test(sidecar));
  check('the main phase calls rpc zumiHost.apply and requires the unknown_method refusal', /method: 'zumiHost\.apply'/.test(phase) && /unknown_method:zumiHost\.apply/.test(phase));
}

console.log(`\ncheck:tauri-guard-host ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
