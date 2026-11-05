// Alt check (FOCUS-KIT "Alt check"), spare PC only (ZUMI_ELECTRON_HOST=box). Real SendInput via input-helper.ps1; CDP only observes.
// node alt-check.mjs --exe <ZumiPreview.exe> --tree <tree> --out <dir> [--port 9341]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, waitTarget, sleep } from './cdp.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const exe = arg('--exe'), tree = arg('--tree'), out = arg('--out'), port = Number(arg('--port', '9341'));
const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'input-helper.ps1');
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, ZUMI_ELECTRON_HOST: 'box', ZUMI_SIDECAR: path.join(tree, 'tauri', 'sidecar', 'main.mjs'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
const H = (cmd, extra = []) => { const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Cmd', cmd, ...extra], { encoding: 'utf8', timeout: 60000, env }); try { return JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()); } catch { return { ok: false, raw: String(r.stdout).slice(0, 200), err: String(r.stderr).slice(0, 200) }; } };
const res = { exe: path.basename(exe), steps: [], checks: {} };
const finish = (code) => { fs.writeFileSync(path.join(out, 'alt-result.json'), JSON.stringify(res, null, 1)); console.log(JSON.stringify({ checks: res.checks, values: res.values, error: res.error }, null, 1)); process.exit(code); };
const alive = (pid) => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(String(pid));

const np = spawn('notepad.exe', [], { env }); await sleep(1500); res.notepadPid = np.pid;
const child = spawn(exe, [], { env, stdio: 'ignore' }); res.pid = child.pid;
const bail = (why) => { res.error = why; spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); spawnSync('taskkill', ['/PID', String(np.pid), '/F'], { stdio: 'ignore' }); finish(2); };
const t = await waitTarget(port, (x) => x.url.startsWith('http://tauri.localhost'), 40000);
if (!t) bail('no CDP target');
const cdp = await connect(t.webSocketDebuggerUrl);
const ev = (expr, ms = 4000) => Promise.race([cdp.eval(expr), sleep(ms).then(() => 'EVAL_TIMEOUT')]);
for (let i = 0; i < 150; i++) { if ((await ev(`!!document.getElementById('msg')`, 2000)) === true) break; await sleep(300); }
await sleep(6000);
await ev(`(() => { window.__k = []; for (const ty of ['keydown','keyup']) window.addEventListener(ty, (e) => window.__k.push(ty[3] + ':' + e.key), true); return true; })()`);
H('place', ['-TargetPid', String(child.pid), '-X', '100', '-Y', '40']); await sleep(1500);
const g = await ev(`(() => { const r = document.getElementById('msg').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, sx: window.screenX, sy: window.screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio }; })()`);
if (!g || g === 'EVAL_TIMEOUT') bail('no #msg geometry');
const cx = Math.round((g.sx + (g.ow - g.iw) / 2 + g.x) * g.dpr), cy = Math.round((g.sy + (g.oh - g.ih - (g.ow - g.iw) / 2) + g.y) * g.dpr);
res.geometry = g; res.click = [cx, cy];
const val = () => ev(`(document.getElementById('msg') || {}).value`);
const keys = () => ev(`window.__k.splice(0).join(' ')`);
const shot = (n) => H('shot', ['-Out', path.join(out, n + '.png')]);
const rec = async (name, extra = {}) => { const s = { name, value: await val(), fg: H('fg'), ...extra }; res.steps.push(s); shot(name); return s; };

H('click', ['-X', String(cx), '-Y', String(cy)]); await sleep(600);
res.activeAfterClick = await ev(`document.activeElement && document.activeElement.id`);
// 1. abc, Alt, xyz
H('type', ['-Text', 'abc']); await sleep(400);
await rec('1-abc');
H('alt-tap'); const t0 = Date.now(); const evalAfterAlt = await ev('1+1', 4000); const evalAfterAltMs = Date.now() - t0;
await rec('2-after-alt-tap', { evalAfterAlt, evalAfterAltMs });
H('type', ['-Text', 'xyz']); await sleep(500);
const s3 = await rec('3-xyz-after-alt', { keys: await keys() });
res.checks.abcxyz = s3.value === 'abcxyz' ? 'PASS' : `FAIL (value=${JSON.stringify(s3.value)})`;
res.checks.cdpAnswersAfterAlt = (evalAfterAlt === 2 && evalAfterAltMs < 1500) ? `PASS (${evalAfterAltMs} ms)` : `FAIL (${evalAfterAlt}, ${evalAfterAltMs} ms)`;
// 2. Alt, Esc, ee
await keys(); H('alt-tap'); await sleep(400); H('esc'); H('type', ['-Text', 'ee']); await sleep(500);
const s4 = await rec('4-alt-esc-ee', { keys: await keys() });
res.checks.escNotEaten = (/d:Escape/.test(s4.keys) && s4.value === 'abcxyzee') ? 'PASS' : `FAIL (value=${JSON.stringify(s4.value)} keys=${s4.keys})`;
// 5. Alt+Tab away and back, typing continues
res.altTabAway = H('alt-tab'); await sleep(500); res.altTabBack = H('alt-tab'); await sleep(800);
res.fgAfterAltTabBack = H('fg');
H('type', ['-Text', 'def']); await sleep(500);
const s5 = await rec('5-alttab-back-def', { keys: await keys() });
res.checks.altTabTypingContinues = s5.value === 'abcxyzeedef' ? 'PASS' : `FAIL/INCONCLUSIVE (value=${JSON.stringify(s5.value)}, fg after alt-tab back=${JSON.stringify(res.fgAfterAltTabBack)})`;
res.values = Object.fromEntries(res.steps.map((s) => [s.name, s.value]));
// 4. Alt+Space opens the system menu
const fgBefore = H('fg');
H('alt-key', ['-Vk', '32']); await sleep(600);
const menus = H('menus'); shot('6-alt-space');
res.altSpace = { fgBefore, menus, zumiPid: child.pid, fgAfter: H('fg') };
res.checks.altSpaceSystemMenu = (menus.menus || []).some((m) => m.startsWith(child.pid + ':')) ? 'PASS (#32768 menu window of the Zumi process visible)' : `FAIL/INCONCLUSIVE (menus=${JSON.stringify(menus.menus)})`;
H('esc'); await sleep(500);
res.altSpace.menusAfterEsc = H('menus').menus;
res.altSpace.evalAfterEsc = await ev('1+1', 3000);
// 3. Alt+F4 closes the window
H('alt-key', ['-Vk', '115']);
let closedMs = null; const tc = Date.now();
for (let i = 0; i < 40; i++) { await sleep(250); if (!alive(child.pid)) { closedMs = Date.now() - tc; break; } }
res.checks.altF4Closes = closedMs !== null ? `PASS (process exited after ${closedMs} ms)` : 'FAIL (process still alive after 10 s)';
if (closedMs === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
spawnSync('taskkill', ['/PID', String(np.pid), '/F'], { stdio: 'ignore' });
finish(0);
