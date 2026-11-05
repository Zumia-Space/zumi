// T-31 visual gate 14, D2: shots.capture / demo.capture must also save the open board guest webview beside the
// main-webview PNG, because a guest is a separate WebView2 that Page.captureScreenshot on main never includes.
// Since 0.3.0-alpha.11 the board is the only guest (the "wardrobe" capture target left with the wardrobe).
// Pure Node: createSelfTestHost with a fake host channel, no window.
//   node scripts/check-tauri-guest-shots.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSelfTestHost, parseSelfTestArgs } from '../tauri/sidecar/selftest-host.mjs';

let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}${d ? '  ' + d : ''}`); } };
const tmp = fs.mkdtempSync(path.join(process.env.ZUMI_CHECK_TMP || os.tmpdir(), 'guest-shots-'));

function host(kind, openGuests, failWith) {
  const dir = path.join(tmp, `${kind}-${openGuests.join('+') || 'none'}-${failWith || 'ok'}`);
  fs.mkdirSync(dir, { recursive: true });
  const calls = [];
  const hostCall = async (method, [req]) => {
    calls.push(req.target);
    if (req.target !== 'main' && !openGuests.includes(req.target)) throw new Error(`no_${req.target}_guest`);
    if (failWith && req.target === 'board') throw new Error(failWith);
    fs.writeFileSync(req.save, 'png');
    return { width: 1, height: 1, pixels: 1 };
  };
  const flag = kind === 'shots' ? ['--room-shots', dir] : ['--demo-script', path.join(dir, 'l.json'), '--demo-out', dir];
  if (kind === 'demo') fs.writeFileSync(path.join(dir, 'l.json'), '[]');
  const h = createSelfTestHost({ modes: parseSelfTestArgs(flag), dataDir: path.join(dir, 'data'), settings: () => ({}), hostCall });
  return { h, dir, calls };
}

for (const kind of ['shots', 'demo']) {
  const name = kind === 'shots' ? 'shots.capture' : 'demo.capture';
  const b = host(kind, ['board']);
  const r = await b.h.handlers[name]('10-board-tab.png');
  ok(r === '10-board-tab.png', `${name}: still returns the main file name`, String(r));
  ok(fs.existsSync(path.join(b.dir, '10-board-tab.board.png')), `${name}: board guest saved beside the main PNG`);
  ok(b.calls.every((t) => t !== 'wardrobe'), `${name}: never asks the host for a wardrobe guest`, b.calls.join());

  const n = host(kind, []);
  await n.h.handlers[name]('plain.png');
  ok(fs.readdirSync(n.dir).filter((f) => f.endsWith('.png')).join() === 'plain.png', `${name}: no guest open = only the main PNG, and no capture error`);

  const f = host(kind, ['board'], 'capture_failed_boom');
  await f.h.handlers[name]('x.png');
  const fin = await f.h.handlers[kind === 'shots' ? 'shots.finish' : 'demo.finish']({ ok: true });
  ok(fin === true || fin === undefined || fin === null || fin, `${name}: finish still answers`);
  const rep = JSON.parse(fs.readFileSync(path.join(f.dir, kind === 'shots' ? 'shots.json' : 'demo.json'), 'utf8'));
  ok(rep.ok === false && /capture_failed/.test(String(rep.error)), `${name}: a real guest capture failure turns the run red`, JSON.stringify(rep).slice(0, 200));
}

const rs = fs.readFileSync(new URL('../tauri/src-tauri/src/guest_cdp.rs', import.meta.url), 'utf8');
ok(/name == "board"[\s\S]{0,120}board_webview\(\)/.test(rs), 'guest_cdp.rs resolve_target knows the "board" target');
ok(!/name == "wardrobe"|wardrobe_webview/.test(rs), 'guest_cdp.rs has no "wardrobe" capture target any more');
const gs = fs.readFileSync(new URL('../tauri/src-tauri/src/guest.rs', import.meta.url), 'utf8');
ok(/fn board_webview[\s\S]{0,300}is_board_label/.test(gs) && !/fn wardrobe_webview/.test(gs), 'guest.rs GuestRegistry selects the board guest by its label; no wardrobe_webview');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
