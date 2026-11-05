// T-31 Tauri focus-events driver v3 (DEFAULT). Spare PC only. Derived from probe-r5/box-scripts/focus-drive.mjs (same subscription, same minimize/restore/judge rules).
// Differences, all because the session is now UNLOCKED:
//   1. every CDP eval has a timeout (the kit's ALT trick puts the window in Windows' system-menu mode and the page stops answering; the
//      kit driver then waits forever);
//   2. the helper is win-helper-v2-noalt.ps1 (AttachThreadInput instead of a synthetic ALT key);
//   3. after each step the real foreground is read (r5-helper fg-info) so a missing event can be told apart from "the OS never activated Zumi";
//   4. "switch away" keeps the helper form OPEN (async, HoldMs 6000) while "switch back" runs, so the focus:true after the form closed is not
//      confused with the explicit switch back (the kit closed the form first, Windows re-activated Zumi by itself, and the explicit
//      focus-zumi then had nothing to report).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, waitTarget, sleep } from './cdp.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const exe = arg('--exe'), out = arg('--out'), port = Number(arg('--port', '9336')), reps = Number(arg('--reps', '3'));
const helper = arg('--helper', path.join(path.dirname(fileURLToPath(import.meta.url)), 'win-helper-noalt.ps1')), fgHelper = arg('--fg-helper', helper);
const tree = arg('--tree');
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, ZUMI_ELECTRON_HOST: 'box', ZUMI_SIDECAR: path.join(tree, 'tauri', 'sidecar', 'main.mjs'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
const child = spawn(exe, [], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(out, 'stderr.log'), 'w')] });
const run = (file, cmd, extra = []) => { const t0 = Date.now(); const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Cmd', cmd, '-TargetPid', String(child.pid), ...extra], { encoding: 'utf8', timeout: 60000, env }); const t1 = Date.now(); let j; try { j = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()); } catch { j = { ok: false, raw: String(r.stdout).slice(0, 200) }; } return { ...j, t0, t1 }; };
const H = (cmd, extra) => run(helper, cmd, extra);
const FG = () => { const r = run(fgHelper, 'fg-info'); return { zumiIsFg: r.zumiIsFg, fgName: r.fgName }; };
const res = { pid: child.pid, reps, helper: path.basename(helper), steps: [] };
const bail = (why, code) => { res.error = why; res.verdict = 'INCONCLUSIVE'; fs.writeFileSync(path.join(out, 'focus.json'), JSON.stringify(res, null, 1)); spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); if (bystander) spawnSync('taskkill', ['/PID', String(bystander.pid), '/T', '/F'], { stdio: 'ignore' }); process.exit(code); };
// Optional bystander window (--bystander 1): a plain normal-level form of the helper process, so that Windows has another window to activate when Zumi is minimised
// (without any other window the OS leaves the minimised Zumi as the foreground window: no WM_ACTIVATE change, so nothing to report).
let bystander = null;
if (arg('--bystander', '0') === '1') {
  bystander = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = 'zumi probe bystander'; $f.Width = 320; $f.Height = 160; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(40, 40); [System.Windows.Forms.Application]::Run($f)"], { env, stdio: 'ignore' });
  await sleep(2500);
  res.bystanderPid = bystander.pid;
}
const target = await waitTarget(port, (t) => t.url.startsWith('http://tauri.localhost'), 30000);
if (!target) bail('no main target', 2);
const cdp = await connect(target.webSocketDebuggerUrl);
const ev = (expr, ms = 8000) => Promise.race([cdp.eval(expr), new Promise((_, no) => setTimeout(() => no(new Error('eval timeout')), ms))]);
for (let i = 0; i < 60; i++) { const ok = await ev(`document.readyState === 'complete' && typeof window.zumi === 'object'`, 3000).catch(() => false); if (ok) break; await sleep(250); }
await sleep(3000);
await ev(`(async () => { window.__ev = []; const T = () => Math.round(performance.timeOrigin + performance.now()); await window.zumi.onWindowFocus((v) => window.__ev.push({ t: 'focus', v, at: T() })); await window.zumi.onWindowVisible((v) => window.__ev.push({ t: 'visible', v, at: T() })); return true; })()`, 10000).catch((e) => bail('subscribe: ' + e.message, 3));
res.prime = H('focus-zumi'); await sleep(1500);
res.primeEvents = await ev('window.__ev.splice(0)').catch((e) => ['eval-error ' + e.message]);
res.fgAfterPrime = FG();
const fmt = (evs) => evs.map((e) => `${e.t}:${e.v}`).join(',');
const focusVals = (evs) => evs.filter((e) => e.t === 'focus').map((e) => e.v);
const visVals = (evs) => evs.filter((e) => e.t === 'visible').map((e) => e.v);
const last = (a) => a[a.length - 1];
const take = () => ev('window.__ev.splice(0)').catch(() => null);
async function step(name, act, judge, settle = 1500) {
  await take();
  const h = act();
  await sleep(settle);
  const evs = await take();
  const rec = { name, helper: { ok: h.ok, ms: h.t1 - h.t0 }, events: evs === null ? 'EVAL-TIMEOUT' : fmt(evs), raw: (evs || []).map((e) => ({ t: e.t, v: e.v, atMinusHelperStart: e.at - h.t0 })) };
  rec.status = evs === null ? 'INCONCLUSIVE' : !h.ok ? 'INCONCLUSIVE' : judge(evs, h);
  rec.fgAfter = FG();
  res.steps.push(rec);
  return rec;
}
for (let r = 1; r <= reps; r++) {
  await step(`rep${r}.minimize`, () => H('minimize'), (evs) => (JSON.stringify(visVals(evs)) === '[false]' ? 'PASS' : 'FAIL'));
  // Restore must start from a NON-Zumi foreground, or Windows has no activation change to report (a minimised Zumi can stay the foreground window).
  // A helper form is held open across the restore, so restore -> focused is always a real foreground change (form -> Zumi).
  const restoreForm = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Cmd', 'focus-away', '-TargetPid', String(child.pid), '-HoldMs', '5000'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  await sleep(1800);
  const fgBeforeRestore = FG();
  const restoreRec = await step(`rep${r}.restore`, () => H('restore'), (evs) => { const f = focusVals(evs); return (JSON.stringify(visVals(evs)) === '[true]' && f.length >= 1 && last(f) === true && !f.includes(false)) ? 'PASS' : 'FAIL'; }, 800);
  restoreRec.fgBeforeRestore = fgBeforeRestore;
  if (fgBeforeRestore.zumiIsFg !== false && restoreRec.status !== 'PASS') restoreRec.status = 'INCONCLUSIVE'; // could not set up a non-Zumi foreground: OS state, not product
  await new Promise((ok) => { restoreForm.on('exit', ok); setTimeout(ok, 6000); });
  try { restoreForm.kill(); } catch { /* already gone */ }
  await sleep(400);
  // switch away: the helper form stays open (async) until after the switch back
  await take();
  const hold = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Cmd', 'focus-away', '-TargetPid', String(child.pid), '-HoldMs', '7000'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const t0 = Date.now();
  await sleep(3500);
  const awayEvs = await take();
  const awayRec = { name: `rep${r}.focusAway`, events: awayEvs === null ? 'EVAL-TIMEOUT' : fmt(awayEvs), raw: (awayEvs || []).map((e) => ({ t: e.t, v: e.v, atMinusFormStart: e.at - t0 })) };
  awayRec.fgDuring = FG();
  awayRec.status = awayEvs === null ? 'INCONCLUSIVE' : (JSON.stringify(focusVals(awayEvs)) === '[false]' && awayRec.fgDuring.zumiIsFg === false) ? 'PASS' : (awayRec.fgDuring.zumiIsFg === true ? 'INCONCLUSIVE' : 'FAIL');
  res.steps.push(awayRec);
  // switch back while the form is still open
  await step(`rep${r}.focusBack`, () => H('focus-zumi'), (evs) => { const f = focusVals(evs); return (f.length >= 1 && last(f) === true) ? 'PASS' : 'FAIL'; }, 800);
  await new Promise((ok) => { hold.on('exit', ok); setTimeout(ok, 9000); });
  try { hold.kill(); } catch { /* already gone */ }
  await sleep(800);
  const post = await take();
  res.steps.push({ name: `rep${r}.afterFormClosed`, events: post === null ? 'EVAL-TIMEOUT' : fmt(post), status: 'INFO', fg: FG() });
  await sleep(300);
}
cdp.close();
if (bystander) { try { spawnSync('taskkill', ['/PID', String(bystander.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
res.close = H('close', ['-TimeoutSec', '5']);
await sleep(2500);
if (!res.close.exited) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
const st = res.steps.filter((s) => s.status !== 'INFO').map((s) => s.status);
res.verdict = st.includes('FAIL') ? 'FAIL' : st.includes('INCONCLUSIVE') ? 'INCONCLUSIVE' : 'PASS';
fs.writeFileSync(path.join(out, 'focus.json'), JSON.stringify(res, null, 1));
console.log(JSON.stringify({ verdict: res.verdict, steps: res.steps.map((s) => [s.name, s.status, s.events, s.fgAfter || s.fgDuring || s.fg]), close: res.close }));
process.exit(0);
