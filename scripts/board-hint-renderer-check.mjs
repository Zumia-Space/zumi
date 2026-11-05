// T-31 parity 13a / GATE-10b condition 2, renderer half. Runs in its OWN process (like
// scripts/free-llm-renderer-check.mjs) so evaluating the committed renderer fragment cannot leak globals into
// the parent check.
//
// Input: argv[2] = the shim to load (default: the committed tauri/shim/zumi-shim.js).
// Output: one JSON array of { ok, name, detail }.
//
// It loads the REAL shim with a Tauri bridge whose sidecar answers the real `not_implemented:board.liveOpen`,
// extracts the REAL openLiveBoard() from src/renderer/app.js (never edited), and runs it. On Tauri the Board
// tab must end on board.liveInElectron -- the hint that names the Electron app -- with liveOpening cleared,
// no spinner and no "check your network" wording. The same fragment without window.__TAURI__ (Electron) must
// keep the existing board.liveConnectFailed hint, so Electron renders byte-identically.
// Against the pre-fix shim (liveOpen rejects) this process reports FAIL.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { t, TABLES } from '../src/renderer/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shimPath = path.resolve(process.argv[2] || path.join(ROOT, 'tauri', 'shim', 'zumi-shim.js'));

const results = [];
const ok = (cond, name, detail = '') => results.push({ ok: Boolean(cond), name, detail: String(detail || '') });

const shim = fs.readFileSync(shimPath, 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const extracted = appSrc.match(/const openLiveBoard = \(\) => liveOpening \|\| \(liveOpening = \(async \(\) => \{[\s\S]*?\n  \}\)\(\)\);/);
ok(extracted, 'src/renderer/app.js still defines openLiveBoard() in the shape this check evaluates');

/** Run the committed openLiveBoard() with a given zumi + host signal. */
function runOpenLiveBoard(zumi, tauriHost, windowObj) {
  const calls = [];
  const harnessSrc = `(function () {
  let liveOpening = null;
  ${extracted[0]}
  return { open: openLiveBoard, pending: function () { return liveOpening; } };
})()`;
  const harness = vm.runInNewContext(harnessSrc, {
    zumi,
    tauriHost,
    window: windowObj,
    boardHint: (text, items, where) => calls.push({ text, items, where }),
    t,
  }, { filename: 'openLiveBoard.js' });
  return { harness, calls };
}

if (extracted) {
  // The Tauri host routes every rpc to the sidecar; an unregistered name comes back as the real
  // `not_implemented:<name>` rejection (check-tauri-sidecar.mjs:181-184).
  const windowObj = {
    __TAURI__: {
      core: {
        invoke: (cmd, payload) => {
          if (cmd !== 'rpc') return Promise.resolve(null);
          return Promise.reject(new Error(`not_implemented:${payload.method}`));
        },
      },
      event: { listen: () => Promise.resolve(() => {}) },
    },
    console,
  };
  vm.runInNewContext(shim, { window: windowObj, Promise, URL, console, setTimeout, clearTimeout }, { filename: 'zumi-shim.js' });
  const zumi = windowObj.zumi;

  let shimThrew = null;
  let shimValue;
  try { shimValue = await zumi.board.liveOpen(); } catch (e) { shimThrew = e; }
  ok(!shimThrew, 'Tauri shim: board.liveOpen settles instead of rejecting', shimThrew && shimThrew.message);
  ok(!shimThrew && shimValue && shimValue.error === 'live_board_later',
    'Tauri shim: board.liveOpen resolves the distinct { error: live_board_later } (never a fake success)',
    JSON.stringify(shimValue));

  // ---- Tauri: the Board tab names the Electron app, no network wording, no spinner ----
  const tauriHost = Boolean(windowObj.__TAURI__);
  const { harness, calls } = runOpenLiveBoard(zumi, tauriHost, windowObj);

  let threw = null;
  try { await harness.open(); } catch (e) { threw = e; }
  ok(!threw, 'openLiveBoard() settles (a rejected liveOpen no longer strands the Board tab)', threw && threw.message);
  ok(calls.length === 1, 'openLiveBoard() replaces the spinner with exactly one boardHint', JSON.stringify(calls));
  ok(calls[0] && calls[0].text === t('board.liveInElectron'),
    'the hint is exactly board.liveInElectron: the owner sees the Electron message, not a spinner',
    calls[0] && calls[0].text);
  ok(calls.every((c) => !String(c.text).startsWith('board.opening')), 'the opening spinner text is gone');
  ok(calls.every((c) => !/network|Reload|not_implemented|live_board_later/i.test(String(c.text))),
    'the Tauri hint has no network wording, no Reload prompt and no raw error code',
    calls.map((c) => c.text).join(' | '));
  ok(harness.pending() === null, 'liveOpening is cleared so Reload retries instead of replaying the rejection');

  // ---- Electron: no window.__TAURI__ -> the existing hint and behaviour are unchanged ----
  const electronCalls = [];
  const electronZumi = { board: { liveOpen: () => Promise.resolve({ error: 'not_ready' }) } };
  const electron = vm.runInNewContext(`(function () {
  let liveOpening = null;
  ${extracted[0]}
  return { open: openLiveBoard, pending: function () { return liveOpening; } };
})()`, {
    zumi: electronZumi,
    tauriHost: false,
    boardHint: (text, items, where) => electronCalls.push({ text, items, where }),
    t,
  }, { filename: 'openLiveBoard-electron.js' });
  await electron.open();
  ok(electronCalls.length === 1 && electronCalls[0].text === t('board.liveConnectFailed', { error: 'not_ready' }),
    'Electron: the same fragment still shows board.liveConnectFailed (nothing changes off Tauri)',
    JSON.stringify(electronCalls));
  ok(!electronCalls.some((c) => c.text === t('board.liveInElectron')), 'Electron: the Tauri-only Electron hint never appears');
}

// ---- copy: the hint names Electron in one line, in all three locales ----
ok(TABLES.en['board.liveInElectron'] === 'The live board is not in this preview yet. Open it in the Zumi desktop app (Electron) for now.',
  'EN board.liveInElectron is the approved one-line copy',
  TABLES.en['board.liveInElectron']);
ok(TABLES.vi['board.liveInElectron'] === 'Bản xem trước này chưa có bảng việc trực tuyến. Tạm thời anh mở nó trong app Zumi bản desktop (Electron).',
  'VI board.liveInElectron is the approved one-line copy',
  TABLES.vi['board.liveInElectron']);
ok(TABLES.zh['board.liveInElectron'] === '此预览版尚未包含实时看板。目前请在 Zumi 桌面版（Electron）中打开。',
  'ZH board.liveInElectron is the approved one-line copy',
  TABLES.zh['board.liveInElectron']);

process.stdout.write(JSON.stringify(results));
