// Box QC r2 (T-31 0.2.5, 20-10): reconstruction of the 20-check "qcset" kit (the 0.2.4 qcset24 gate.log/result.json is the spec;
// the original qcset.mjs is no longer on the box or in any folder). Same 20 check names, same scenarios A/B/C (installed packaged
// owner Zumi.exe, own --user-data-dir) and D (release flavour = the release tree under electron.exe, live + locked board).
//   node qcset025.mjs <Zumi.exe> <electron.exe> <tree dir> <out dir>
// Box only. Never touches %APPDATA%\Zumi. No key, no network.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const [EXE, ELECTRON, TREE, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
fs.mkdirSync(OUT, { recursive: true });
const appdataZumi = path.join(process.env.APPDATA || '', 'Zumi');
const appdataBefore = fs.existsSync(appdataZumi);
const checks = [];
const notes = [];
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}  ${JSON.stringify(detail === undefined ? '' : detail).slice(0, 600)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = { uiLang: 'vi', voiceEnabled: false, talkLevel: 'off', room: 'default-v2' };
const TAB_LABELS = ['Tài khoản & Riêng tư', 'AI & Sử dụng', 'Quy trình', 'Agent & Linh hồn', 'Phòng & HUD', 'Ứng dụng'];
const TABS = ['account', 'ai', 'workflow', 'agent', 'room', 'app'];
// The 45 controls (S2), per tab, from the 0.2.4 qcset result.json; #hud-voice (removed in c2b79c9, talk-mode inc 2) is replaced by #talk-level in the Agent tab.
const CONTROLS = {
  account: ['board-form-toggle', 'mode-local', 'mode-live', 'board-user', 'board-pass', 'board-pin', 'board-pin-confirm', 'board-token', 'board-save', 'board-pin-required', 'board-pin-toggle-pin', 'board-pin-toggle-confirm', 'board-pin-toggle-apply', 'board-pin-toggle-cancel', 'board-unlock-pin', 'board-unlock', 'board-lock', 'send-client-names'],
  ai: ['brain-provider', 'brain-key-check', 'brain-key-change', 'brain-key-clear', 'brain-key-input', 'brain-key-save', 'brain-key-cancel', 'roles-board-open', 'usage-refresh', 'usage-details-toggle'],
  agent: ['voice-enabled', 'think-sound', 'voice-en-name', 'voice-leda-key', 'voice-leda-save', 'voice-leda-clear', 'voice-speed', 'voice-volume', 'voice-sample', 'talk-level'],
  room: ['room-picker', 'chair-picker', 'room-delete', 'room-open', 'hud-style'],
  app: ['dev-tools'],
};

let portSeq = 0;
async function launch(label, { exe, args = [], settings, env = {} }) {
  const ud = path.join(OUT, `ud-${label}`);
  fs.rmSync(ud, { recursive: true, force: true });
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify(settings, null, 2));
  const port = 9400 + ((process.pid + (portSeq++) * 7) % 90);
  const log = fs.openSync(path.join(OUT, `app-${label}.log`), 'w');
  const child = spawn(exe, [...args, `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*'], { stdio: ['ignore', log, log], env: { ...process.env, ...env }, windowsHide: false });
  const pid = child.pid;
  const kill = () => { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } };
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    await sleep(500);
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); target = list.find((t) => t.type === 'page' && /^app:\/\//.test(t.url)); } catch { /* not up yet */ }
  }
  if (!target) { kill(); throw new Error(`${label}: no app:// page target`); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('ws error')); });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const cdp = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
  const shot = async (name) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, `${label}-${name}.png`), Buffer.from(r.result.data, 'base64')); };
  await cdp('Page.enable');
  for (let i = 0; i < 80 && !(await ev(`!!window.zumi && !!document.getElementById('stab-agent')`)); i++) await sleep(500);
  await sleep(3000);
  return { ud, pid, ev, shot, kill, close: () => { try { ws.close(); } catch { /* closed */ } kill(); } };
}

const DEV_IDS = ['sim-board', 'cam-register', 'look-tuning-toggle', 'app-version'];
const chromeState = (a) => a.ev(`(() => { const shown = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; }; const w = document.querySelector('.tab[data-tab="wardrobe"]'); return { chrome: Object.fromEntries(${JSON.stringify(DEV_IDS)}.map((id) => [id, shown(id)])), devSwitch: !!document.getElementById('dev-tools') && document.getElementById('dev-tools').checked, version: (document.getElementById('app-version') || {}).textContent || null, wardrobeTab: !!w && !w.hidden }; })()`);
const goSettings = async (a, tab) => { await a.ev(`document.querySelector('.tab[data-tab="settings"]').click(); true`); await sleep(600); if (tab) { await a.ev(`document.getElementById('stab-${tab}').click(); true`); await sleep(400); } };

let appA = null, appB = null, appC = null, appD = null;
try {
  // ---------------- A: packaged owner exe, defaults ----------------
  appA = await launch('A-default', { exe: EXE, settings: BASE });
  const info = await appA.ev(`window.zumi.info().then((i) => ({ version: i.version, packaged: i.packaged, ownerAdmin: i.ownerAdmin }))`);
  const fv = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${EXE}').VersionInfo.FileVersion`], { encoding: 'utf8' }).stdout.trim();
  check('A0 packaged owner build (app:info.packaged true)', info.packaged === true && info.ownerAdmin === true && info.version === '0.2.5' && fv === '0.2.5', { ...info, FileVersion: fv });
  await goSettings(appA, 'app');
  const s4 = await chromeState(appA);
  check('S4a Developer mode OFF by default (switch unchecked)', s4.devSwitch === false && Object.values(s4.chrome).every((v) => v === false) && s4.wardrobeTab === false, s4);
  check('S4b dev chrome hidden by default (3 debug buttons + version tag)', Object.values(s4.chrome).every((v) => v === false), s4.chrome);
  const s4c = await appA.ev(`(() => { const e = document.getElementById('about-version'); const shown = !!e && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none'; return { shown, text: e ? e.textContent : null, label: e && e.closest('.srow') ? e.closest('.srow').querySelector('.k').textContent.trim() : null, sidebarTagHidden: document.getElementById('app-version').hidden }; })()`);
  check('S4c About > Version row visible with Developer mode OFF, shows app:info.version, sidebar tag still hidden', s4c.shown === true && s4c.text === info.version && s4c.label === 'Phiên bản' && s4c.sidebarTagHidden === true, s4c);
  const tabs = await appA.ev(`[...document.querySelectorAll('.stab')].map((t) => ({ id: t.id, text: t.textContent.trim() }))`);
  check('S1 six tabs, VI labels exactly as spec, in order', tabs.length === 6 && tabs.every((t, i) => t.id === `stab-${TABS[i]}` && t.text === TAB_LABELS[i]), tabs);
  for (const n of TABS) {
    await appA.ev(`document.getElementById('stab-${n}').click(); true`); await sleep(350);
    const st = await appA.ev(`(() => ({ sel: [...document.querySelectorAll('.stab')].filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.id), shown: [...document.querySelectorAll('.stabpanel')].filter((p) => !p.hidden).map((p) => p.id) }))()`);
    check(`S1 tab ${n} selects only its panel`, st.sel.length === 1 && st.sel[0] === `stab-${n}` && st.shown.length === 1 && st.shown[0] === `stabpanel-${n}`, st);
    await appA.shot(`settings-vi-${n}`);
  }
  const s2 = await appA.ev(`(() => { const per = ${JSON.stringify(CONTROLS)}; const bad = []; let n = 0; for (const [tab, ids] of Object.entries(per)) for (const id of ids) { n++; const all = document.querySelectorAll('#' + id); const p = all[0] && all[0].closest('.stabpanel'); if (all.length !== 1 || !p || p.id !== 'stabpanel-' + tab) bad.push({ id, count: all.length, panel: p && p.id }); } return { bad, n }; })()`);
  check('S2 every 0.2.3 control (45) present once, in its tab\'s panel', s2.bad.length === 0 && s2.n === 45, s2);
  const s3 = await appA.ev(`(async () => { const e = document.getElementById('typed-reply-speech'); const row = e && e.closest('.srow'); const ipc = await window.zumi.talk.getSpeakTypedWhenMicOff(); const p = e && e.closest('.stabpanel'); return { checked: !!e && e.checked, ipc, rowText: row ? row.textContent.replace(/\\s+/g, ' ').trim() : null, inPanel: p && p.id }; })()`);
  check('S3 "Đọc to câu trả lời khi tắt mic" switch ON by default (UI + stored getter)', s3.checked === true && s3.ipc !== false && /Đọc to câu trả lời khi tắt mic/.test(s3.rowText || '') && s3.inPanel === 'stabpanel-workflow', s3);
  await goSettings(appA, 'app');
  await appA.ev(`document.getElementById('dev-tools').click(); true`); await sleep(800);
  const on = await chromeState(appA);
  check('S5 Developer mode ON shows the 3 debug buttons + version tag (and still no Wardrobe tab, removed 0.3.0-alpha.11)', on.devSwitch === true && Object.values(on.chrome).every(Boolean) && on.wardrobeTab === false, on);
  await appA.shot('settings-vi-app-devmode-on');
  const persisted = JSON.parse(fs.readFileSync(path.join(appA.ud, 'settings.json'), 'utf8'));
  check('S5b developerMode:true persisted to the scratch userData (proves --user-data-dir is honoured)', persisted.developerMode === true, { developerMode: persisted.developerMode });
  await appA.ev(`document.getElementById('dev-tools').click(); true`); await sleep(800);
  const off = await chromeState(appA);
  check('S5c Developer mode OFF again hides them', off.devSwitch === false && Object.values(off.chrome).every((v) => v === false), off);
  appA.close(); appA = null;

  // ---------------- B: legacy devTools:true, no developerMode ----------------
  appB = await launch('B-legacy-devTools', { exe: EXE, settings: { ...BASE, devTools: true } });
  await goSettings(appB, 'app');
  const b = await chromeState(appB);
  check('S4c settings.json devTools:true + no developerMode -> chrome stays hidden, switch OFF', b.devSwitch === false && Object.values(b.chrome).every((v) => v === false), b);
  await appB.shot('settings-vi-app-legacy-devTools');
  appB.close(); appB = null;

  // ---------------- C: developerMode:true at launch ----------------
  appC = await launch('C-devmode-true', { exe: EXE, settings: { ...BASE, developerMode: true } });
  await goSettings(appC, 'app');
  const c = await chromeState(appC);
  check('S5d developerMode:true at launch -> chrome shown, switch ON', c.devSwitch === true && Object.values(c.chrome).every(Boolean), c);
  await appC.shot('main-devmode-true');
  appC.close(); appC = null;

  // ---------------- D: release flavour (the release tree under electron.exe), live + locked ----------------
  appD = await launch('D-release-locked', { exe: ELECTRON, args: [TREE], settings: BASE, env: { ZUMI_ELECTRON_HOST: 'box' } });
  const infoD = await appD.ev(`window.zumi.info().then((i) => ({ packaged: i.packaged, ownerAdmin: i.ownerAdmin }))`);
  const boardD = await appD.ev(`(async () => { const set = await window.zumi.board.setSecrets({ user: 'kei-demo', pass: 'demo-nginx-pass-9z9z', pin: '246810', token: '' }); const mode = await window.zumi.board.setMode('live'); const lock = await window.zumi.board.lock(); const status = await window.zumi.board.status(); return { set: set && set.ok, mode, lock: lock && lock.ok !== false, status }; })()`);
  await goSettings(appD, 'room'); // remembered tab = Room
  await appD.ev(`document.querySelector('.tab[data-tab="board"]').click(); true`);
  let overlay = null;
  for (let i = 0; i < 30 && !(overlay && overlay.shown); i++) { await sleep(500); overlay = await appD.ev(`(() => { const o = document.getElementById('board-locked'); const b = document.getElementById('board-locked-settings'); return { shown: !!o && !o.hidden && getComputedStyle(o).display !== 'none', btn: !!b && b.getBoundingClientRect().width > 0 }; })()`); }
  await appD.shot('board-locked-overlay');
  const remembered = await appD.ev(`(() => { const s = document.querySelector('.stab[aria-selected="true"]'); return s && s.id; })()`);
  check('S6a release build, live+locked -> "Unlock in Settings" overlay shown', overlay.shown && overlay.btn && infoD.ownerAdmin === false && boardD.status && boardD.status.locked === true, { status: boardD.status, remembered, ownerAdmin: infoD.ownerAdmin, packaged: infoD.packaged, overlay });
  await appD.ev(`document.getElementById('board-locked-settings').click(); true`); await sleep(900);
  const after = await appD.ev(`(() => { const sa = document.querySelector('.tab[data-tab="settings"]'); const acc = document.getElementById('stab-account'); const row = document.getElementById('board-unlock-pin'); const btn = document.getElementById('board-unlock'); const vis = (e) => !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden'; return { settingsActive: !!sa && (sa.classList.contains('active') || sa.getAttribute('aria-selected') === 'true'), accountSel: acc && acc.getAttribute('aria-selected'), shown: [...document.querySelectorAll('.stabpanel')].filter((p) => !p.hidden).map((p) => p.id.replace('stabpanel-', '')), unlockPin: vis(row), unlockBtn: vis(btn) }; })()`);
  await appD.shot('after-unlock-in-settings');
  check('S6 "Unlock in Settings" opens Settings on the Account tab (PIN unlock row visible), remembered tab was Room', after.accountSel === 'true' && after.shown.length === 1 && after.shown[0] === 'account' && after.unlockPin && after.unlockBtn && remembered === 'stab-room', { after, remembered });
  appD.close(); appD = null;

  const now = fs.existsSync(appdataZumi);
  check('S0 no %APPDATA% Zumi userData created (never touch a real profile)', appdataBefore || !now, { before: appdataBefore, after: now });
} catch (e) {
  check('harness ran to the end', false, String(e && e.stack || e).slice(0, 500));
} finally {
  for (const a of [appA, appB, appC, appD]) if (a) a.close();
}
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ checks, notes }, null, 1));
for (const d of fs.readdirSync(OUT)) if (d.startsWith('ud-')) { try { fs.rmSync(path.join(OUT, d), { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`DONE ${checks.filter((x) => x.ok).length}/${checks.length} pass`);
process.exit(checks.length === 20 && checks.every((x) => x.ok) ? 0 : 1);
