// T-31 parity step 12-1: the test-only families (`demo.*` 4, `selftest.*` 8, `shots.*` 8, `probe.finish`) and the
// run-dir turn log, over the real sidecar JSON-RPC surface. Plain Node, no Electron, no window, no network.
//
//   node scripts/check-tauri-selftest.mjs   (exit 1 on any failure)
//
// The pixel/clipboard/window work belongs to the Rust host (step 12-2). This check answers those three host requests
// with a stub, so the sidecar half (stats, diff, clamp, report files, gates) is exercised exactly as it will be on
// the real host.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { guestUrlOf, parseSelfTestArgs, frameStats, frameDiff, NOT_AVAILABLE } from '../tauri/sidecar/selftest-host.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

const require = createRequire(import.meta.url);
const { createKeyStore } = require('../src/main/reflex-jev.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
const DEFAULT_ROOM = process.env.ZUMI_ROOM_DEFAULT_PATH || ownerPath('roomGlb', 'local/room.glb');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const stable = (v) => JSON.stringify(v);

// The real DPAPI helper (step 5), when this tree has one, so a key write goes through the sidecar RPC; without it the
// key-store location is still checked with a stub encryption backend, so the check never depends on target/.
function findVault() {
  const fromEnv = process.env.ZUMI_VAULT_EXE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const target = path.join(ROOT, 'tauri', 'src-tauri', 'target');
  for (const profile of ['release', 'debug']) {
    const exe = path.join(target, profile, 'zumi-vault.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

if (!fs.existsSync(DEFAULT_ROOM)) { console.error(`default room not found: ${DEFAULT_ROOM}`); process.exit(2); }

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP_ROOT, 'selftest-'));
const modeDir = (name) => { const d = path.join(work, name); fs.mkdirSync(d, { recursive: true }); return d; };

const W = 96, H = 64;
// A two-colour card in BGRA, the shape capturePage().toBitmap() returns (main.js selftest:clipboard-image).
function card() {
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const left = x < W / 2;
    px[i] = left ? 220 : 60; px[i + 1] = left ? 120 : 200; px[i + 2] = left ? 40 : 90; px[i + 3] = 255;
  }
  return px;
}

// The Rust host's half of the three self-test requests (step 12-2). Records every request for the assertions.
// `failCapture` simulates the 12-runtime host failure (the CDP call never produced a frame), so the sidecar's error
// propagation can be checked end to end.
function stubHost({ failCapture = false } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    answer(msg) {
      const name = String(msg.method);
      const args = Array.isArray(msg.params) ? msg.params : [];
      calls.push({ name, args });
      if (name === '__sidecarHost.capture') {
        if (failCapture) return { error: 'capture_failed_test' };
        const req = args[0] || {};
        const rawPath = path.join(work, `raw-${++n}.bgra`);
        fs.writeFileSync(rawPath, card());
        if (req.save) fs.writeFileSync(req.save, Buffer.from('89504e470d0a1a0a', 'hex')); // a PNG signature is enough for the file check
        return { width: W, height: H, pixels: W * H, rawPath, pngPath: req.save || null };
      }
      if (name === '__sidecarHost.clipboardImage') return { width: W, height: H, bytes: 1234, pngBase64: 'iVBORw0KGgo=', hasPng: true, textOk: true, tries: [{ label: 'stub', has: true }] };
      if (name === '__sidecarHost.resize') return [args[0], args[1]];
      if (name === '__sidecarHost.netLog') return [{ url: 'http://127.0.0.1:4212/api/tasks' }, { url: 'http://127.0.0.1:4212/' }];
      return { error: 'unknown_host_method' };
    },
  };
}

function start(dataDir, args = [], { host = null, env = {} } = {}) {
  const child = spawn(process.execPath, [SIDECAR, '--data-dir', dataDir, ...args, '--no-voice-prefetch'], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const notifications = [];
  let stderr = '';
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  rl.on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.method === 'string') {
      if (host && msg.method.startsWith('__sidecarHost.')) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: host.answer(msg) })}\n`);
        return;
      }
      notifications.push(msg);
      if (msg.method === 'ready') readyResolve();
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const r = pending.get(msg.id);
      clearTimeout(r.timer);
      pending.delete(msg.id);
      r.resolve(msg);
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return {
    child, notifications,
    stderrText: () => stderr,
    ready,
    request(method, params = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 30000);
        pending.set(id, { resolve, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    stop() { try { child.stdin.end(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } },
  };
}

const result = async (c, method, params = []) => (await c.request(method, params)).result;

const ALL = [
  'demo.info', 'demo.log', 'demo.capture', 'demo.finish',
  'selftest.capture', 'selftest.emitBoard', 'selftest.boardLog', 'selftest.clipboardImage',
  'selftest.log', 'selftest.finish', 'selftest.roomFixtures', 'selftest.roomOpen',
  'shots.capture', 'shots.log', 'shots.finish', 'shots.badRoom',
  'shots.rolesProvider', 'shots.resize', 'shots.voiceState', 'shots.seedUsage',
  'probe.finish',
];

(async () => {
  // ---------------------------------------------------------------- 0. the CLI parser itself
  {
    ok(stable(parseSelfTestArgs([])) === stable({ selftest: null, demo: null, shots: null, probe: null, runDir: null }), 'no flags = no self-test mode');
    ok(parseSelfTestArgs(['--selftest', 'C:/x']).selftest === 'C:/x', '--selftest <absolute dir> enables the selftest mode');
    ok(parseSelfTestArgs(['--selftest', 'relative']).selftest === null, 'a relative run dir is refused (never guesses a path)');
    ok(parseSelfTestArgs(['--settings-shots', 'C:/x']).shots.kind === 'settingsShots', '--settings-shots enables the shots family');
    ok(parseSelfTestArgs(['--settings-probe', 'C:/x']).probe === 'C:/x', '--settings-probe enables probe.finish');
    ok(parseSelfTestArgs(['--selftest', 'C:/x', '--settings-shots', 'C:/y']).shots === null, 'one mode per run (selftest wins)');
    // The security core: the parser reads argv only. No environment, no settings file, no rpc.
    const src = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'selftest-host.mjs'), 'utf8');
    const body = (src.match(/export function parseSelfTestArgs[\s\S]*?\n\}/) || [''])[0];
    ok(body.length > 0 && !/process\.env|settings\(|readSettings/.test(body), 'parseSelfTestArgs reads neither the environment nor settings');
  }

  // ---------------------------------------------------------------- 1. a normal launch refuses all 21
  {
    const dataDir = modeDir('normal');
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ selftest: true, demo: true, settingsShots: true, settingsProbe: true }));
    const host = stubHost();
    const c = start(dataDir, [], { host, env: { ZUMI_SELFTEST: '1', ZUMI_SETTINGS_SHOTS: '1' } });
    await c.ready;
    const info = await result(c, 'info');
    ok(info && info.selftest === false && info.demo === false && info.settingsShots === false && info.settingsProbe === false,
      'a normal launch reports every self-test flag false even with settings + env asking for one', stable(info));
    for (const name of ALL) {
      const r = await result(c, name, name === 'shots.resize' ? [800, 500] : []);
      ok(stable(r) === stable(NOT_AVAILABLE), `${name} answers not_available in a normal sidecar start`, stable(r));
    }
    ok((await result(c, 'talk.log', [{ a: 1 }])) === false, 'talk.log answers false in a normal start (no run dir)');
    ok(!fs.existsSync(path.join(dataDir, 'turns.ndjson')), 'a normal start writes no turns.ndjson');
    ok(!c.notifications.some((m) => m.method === 'event' && m.params && m.params.channel === 'reflex:event'), 'a normal start never emits reflex:event');
    ok(host.calls.length === 0, 'a normal start never asks the host for a capture/clipboard/resize', stable(host.calls));
    c.stop();
    await new Promise((r) => c.child.on('close', r));
  }

  // ---------------------------------------------------------------- 2. selftest mode: all 8 answer
  {
    const dataDir = modeDir('selftest-data');
    const out = modeDir('selftest-out');
    const host = stubHost();
    // Use the default room the fixture generator reads; the env override keeps the check independent of settings.
    const c = start(dataDir, ['--selftest', out], { host, env: { ZUMI_ROOM_DEFAULT_PATH: DEFAULT_ROOM } });
    await c.ready;
    const info = await result(c, 'info');
    ok(info && info.selftest === true && info.demo === false && info.settingsShots === false, 'info.selftest is true in --selftest, the other modes stay off', stable(info));

    ok((await result(c, 'selftest.log', ['hello from the check'])) === null, 'selftest.log answers (null, like Electron send)');
    ok(c.stderrText().includes('hello from the check'), 'selftest.log reaches the run log');

    const shot = await result(c, 'selftest.capture', ['idle', { save: '00-idle.png', keepAs: 'idle' }]);
    ok(shot && shot.width === W && shot.height === H && shot.pixels === W * H && shot.blank === false, 'selftest.capture returns the frame geometry and its stats', stable(shot));
    ok(shot && shot.png === '00-idle.png' && fs.existsSync(path.join(out, '00-idle.png')), 'selftest.capture saves the PNG under the run dir');
    ok(Math.abs(shot.lumMean - 129.3) < 1.5 && shot.lumStd > 20, 'the stats are the real BGRA frame stats (half light / half dark card)', stable({ lumMean: shot.lumMean, lumStd: shot.lumStd }));
    const same = await result(c, 'selftest.capture', ['again', { keepAs: 'again', diffWith: 'idle' }]);
    ok(same && same.diff && same.diff.changedPx === 0 && same.diff.changedPct === 0, 'diffWith compares against keepAs (identical frame -> 0 changed)', stable(same && same.diff));
    const missing = await result(c, 'selftest.capture', ['x', { diffWith: 'nope' }]);
    ok(missing && missing.diff && missing.diff.error === 'no-baseline', 'diffWith an unknown baseline answers no-baseline');
    // S6: a ../ name is sanitized by the sidecar on its own (the Rust save_path is the second lock, tested in Rust).
    const traversalCapture = await result(c, 'selftest.capture', ['traverse', { save: '../self-escape.png' }]);
    const traversalSave = host.calls.filter((x) => x.name === '__sidecarHost.capture').map((x) => x.args[0] && x.args[0].save).pop();
    ok(traversalCapture && traversalCapture.png === 'self-escape.png' && fs.existsSync(path.join(out, 'self-escape.png'))
      && typeof traversalSave === 'string' && path.resolve(path.dirname(traversalSave)) === path.resolve(out)
      && !fs.existsSync(path.join(path.dirname(out), 'self-escape.png')),
      'selftest.capture sanitizes a ../ save name into the run dir (S6)', stable(traversalSave));

    const clip = await result(c, 'selftest.clipboardImage');
    ok(clip && clip.hasPng === true && clip.textOk === true && typeof clip.pngBase64 === 'string', 'selftest.clipboardImage relays the host clipboard result', stable(clip));

    // Box re-probe 2ef16d1: Electron answers a --selftest run's talk path from src/main/cloud-fixtures.json; the preview said
    // "no device token on this machine", so the selftest talk part could never run.
    const talkStatus = await result(c, 'talk.status');
    ok(talkStatus && talkStatus.enabled === true && talkStatus.mode === 'fixture', 'talk.status in a --selftest run is the fixture cloud (recorded answers, no token, no network)', stable(talkStatus));

    // Box re-probe 9bd5e2b: the owner --selftest made real TTS calls to https://zumia.space (1.4-1.7 s each); Electron answers
    // from the fixture transport (a generated tone). A fixture turn + its TTS must come back as the tone, with no network.
    const ttsTurn = '0123456789abcdef0123456789abcdef';
    const turned = await result(c, 'talk.turn', [{ turnId: ttsTurn, message: 'hi', history: [] }]);
    const spoke = await result(c, 'talk.tts', [{ turnId: ttsTurn, text: 'Hello there, this is the fixture voice.' }]);
    ok(turned && turned.ok === true && spoke && spoke.ok === true && spoke.voice === 'tone' && spoke.mime === 'audio/wav', 'a --selftest talk.tts answers from the cloud fixture (the tone), never a provider or zumia.space', stable(turned).slice(0, 120) + ' | ' + stable(spoke).slice(0, 160));

    const fx = await result(c, 'selftest.roomFixtures');
    ok(fx && Array.isArray(fx.names) && fx.names[0] === 'good.glb' && fx.expectedRefusal['too-big.glb'] === 'too_big', 'selftest.roomFixtures names the fixtures and their expected refusals', stable(fx));
    ok(fx && fx.names.every((n) => fs.existsSync(path.join(out, 'room-fixtures', n))), 'every room fixture was generated under the run dir');
    const refused = await result(c, 'selftest.roomOpen', ['bad-magic.glb']);
    ok(refused && refused.error && refused.error.code === 'not_a_room_file', 'selftest.roomOpen refuses a non-glTF fixture through the real import path', stable(refused));
    const traversal = await result(c, 'selftest.roomOpen', ['../good.glb']);
    ok(traversal && traversal.error && traversal.error.code === 'not_a_room_file', 'selftest.roomOpen refuses a name that is not a plain .glb');
    const good = await result(c, 'selftest.roomOpen', ['good.glb']);
    ok(good && Array.isArray(good.rooms) && good.rooms.some((r) => r.source === 'user') && good.selected === good.rooms.find((r) => r.source === 'user').id,
      'selftest.roomOpen imports the good fixture through library.importRoomPath (the real path)', stable(good).slice(0, 300));

    const opened = await result(c, 'openBoard');
    ok(opened && !opened.error, 'openBoard opens the local board for the board check', stable(opened).slice(0, 200));
    const bl = await result(c, 'selftest.boardLog');
    ok(bl && typeof bl.laneboard === 'string' && bl.root && bl.dataDir && bl.outcome, 'selftest.boardLog carries the board identity', stable(bl).slice(0, 250));
    ok(bl && bl.legacyAfter && bl.requests !== undefined, 'selftest.boardLog carries the legacy snapshot and requests');
    // Box re-probe 9bd5e2b: guestUrl was hardcoded null, so servedFromLoopback (renderer board.js) could never be true.
    ok(bl && typeof bl.guestUrl === 'string' && opened && typeof opened.url === 'string' && bl.guestUrl === opened.url.split('#')[0] && bl.guestUrl.startsWith('http://127.0.0.1:' + bl.port + '/') && !/token/.test(bl.guestUrl), 'selftest.boardLog.guestUrl is the loaded board URL on the loopback port, without the #token fragment', stable(bl && bl.guestUrl));
    ok(bl && JSON.stringify(bl.net) === JSON.stringify([{ url: 'http://127.0.0.1:4212/api/tasks' }, { url: 'http://127.0.0.1:4212/' }]), 'selftest.boardLog.net is the host-side guest network log (box re-probe 2ef16d1: it was always empty, so the network check could never pass)', JSON.stringify(bl && bl.net));
    const emitted = await result(c, 'selftest.emitBoard');
    ok(emitted === true, 'selftest.emitBoard answers true in a selftest launch');
    const reflex = c.notifications.filter((m) => m.method === 'event' && m.params && m.params.channel === 'reflex:event');
    const frame = reflex[reflex.length - 1];
    ok(reflex.length === 1, 'selftest.emitBoard pushes exactly one reflex:event frame', `got ${reflex.length}`);
    ok(frame && frame.jsonrpc === '2.0' && !('id' in frame) && stable(Object.keys(frame.params).sort()) === stable(['channel', 'payload']),
      'the reflex:event push is a JSON-RPC notification { params:{ channel, payload } }', stable(frame && frame.params));
    ok(frame && frame.params.payload && frame.params.payload.type === 'board-message' && frame.params.payload.source === 'selftest' && typeof frame.params.payload.at === 'number',
      "the payload is Electron's { type:'board-message', source:'selftest', at }", stable(frame && frame.params.payload));

    ok((await result(c, 'talk.log', [{ turn: 1 }])) === true, 'talk.log writes a turn record inside a selftest run dir');
    ok(fs.readFileSync(path.join(out, 'turns.ndjson'), 'utf8').includes('"turn":1'), 'the turn record is appended to turns.ndjson');
    ok((await result(c, 'talk.log', [{ pad: 'x'.repeat(70 * 1024) }])) === false, 'talk.log refuses a record over 64 KB');

    ok((await result(c, 'selftest.finish', [{ ok: true, name: 'check' }])) === true, 'selftest.finish answers true');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'selftest.json'), 'utf8'));
    ok(report.ok === true && report.name === 'check' && report.packaged === true && typeof report.exe === 'string', 'selftest.json keeps the report and marks the preview packaged', stable(report).slice(0, 200));

    // The other three families stay off in a selftest launch.
    for (const name of ['demo.info', 'shots.capture', 'probe.finish']) {
      ok(stable(await result(c, name, name === 'shots.capture' ? ['x.png'] : [])) === stable(NOT_AVAILABLE), `${name} still answers not_available in a selftest launch`);
    }
    ok(host.calls.filter((x) => x.name === '__sidecarHost.capture').length >= 3, 'every capture went through the host request channel');
    c.stop();
    await new Promise((r) => c.child.on('close', r));
  }

  // ---------------------------------------------------------------- 3. demo mode: 4 names
  {
    const dataDir = modeDir('demo-data');
    const out = modeDir('demo-out');
    const script = path.join(work, 'demo-lines.json');
    fs.writeFileSync(script, JSON.stringify({ lines: [{ text: 'hi' }] }));
    const host = stubHost();
    const c = start(dataDir, ['--demo-script', script, '--demo-out', out, '--demo-fixture'], { host });
    await c.ready;
    const info = await result(c, 'info');
    ok(info && info.demo === true && info.demoFixture === true && info.selftest === false, 'info.demo + demoFixture are true in --demo-script', stable(info));
    const di = await result(c, 'demo.info');
    ok(di && di.fixture === true && di.lines && di.lines.lines.length === 1, 'demo.info reads the script and the fixture flag', stable(di));
    ok((await result(c, 'demo.log', ['a demo line'])) === null, 'demo.log answers (null)');
    ok(c.stderrText().includes('a demo line'), 'demo.log reaches the run log');
    const shot = await result(c, 'demo.capture', ['00-start.png']);
    ok(shot === '00-start.png' && fs.existsSync(path.join(out, '00-start.png')), 'demo.capture saves the PNG under the demo dir and returns its name');
    // S8: same sanitize layer, on its own.
    const traversal = await result(c, 'demo.capture', ['../demo-escape.png']);
    const traversalSave = host.calls.filter((x) => x.name === '__sidecarHost.capture').map((x) => x.args[0] && x.args[0].save).pop();
    ok(traversal === 'demo-escape.png' && fs.existsSync(path.join(out, 'demo-escape.png'))
      && typeof traversalSave === 'string' && path.resolve(path.dirname(traversalSave)) === path.resolve(out)
      && !fs.existsSync(path.join(path.dirname(out), 'demo-escape.png')),
      'demo.capture sanitizes a ../ save name into the demo dir (S8)', stable(traversalSave));
    ok((await result(c, 'talk.log', [{ turn: 2 }])) === true, 'talk.log writes in a demo run dir too');
    ok((await result(c, 'demo.finish', [{ ok: true }])) === true, 'demo.finish answers true');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'demo.json'), 'utf8'));
    ok(report.ok === true && Array.isArray(report.net) && report.packaged === true, 'demo.json keeps the report (+ the honest empty net log)', stable(report).slice(0, 200));
    ok(stable(await result(c, 'selftest.capture', ['x'])) === stable(NOT_AVAILABLE), 'selftest.capture is not available in a demo launch');
    ok(stable(await result(c, 'selftest.emitBoard')) === stable(NOT_AVAILABLE), 'selftest.emitBoard is not available in a demo launch (Electron registers it with the selftest family)');
    ok(!c.notifications.some((m) => m.method === 'event' && m.params && m.params.channel === 'reflex:event'), 'a demo launch emits no reflex:event');
    c.stop();
    await new Promise((r) => c.child.on('close', r));
  }

  // ---------------------------------------------------------------- 4. shots mode: 8 names
  {
    const out = modeDir('shots-out');
    // Parity gate 12 change 1: the HOST passes <runDir>/ud as the sidecar data dir. Mirror that here so every fixture
    // write (usage ledger, roles/settings, key) can be checked against the run dir, never the run root or %APPDATA%.
    const dataDir = path.join(out, 'ud');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ aiProvider: 'openrouter', voiceEnabled: false }));
    const host = stubHost();
    const vault = findVault();
    const vaultArgs = vault ? ['--vault-exe', vault, '--host-dir', path.dirname(vault)] : [];
    const c = start(dataDir, ['--settings-shots', out, ...vaultArgs], { host, env: { ZUMI_ROOM_DEFAULT_PATH: DEFAULT_ROOM } });
    await c.ready;
    const info = await result(c, 'info');
    ok(info && info.settingsShots === true && !('wardrobeShots' in info) && info.selftest === false, 'info.settingsShots is true in --settings-shots', stable(info));
    ok((await result(c, 'shots.log', ['shots line'])) === null, 'shots.log answers (null)');
    ok(c.stderrText().includes('shots line'), 'shots.log reaches the run log');
    ok((await result(c, 'shots.rolesProvider', ['one'])) === 'one', "shots.rolesProvider('one') answers 'one'");
    ok((await result(c, 'shots.rolesProvider', ['bogus'])) === 'on', "an invalid rolesProvider mode falls back to 'on' (Electron parity)");
    ok((await result(c, 'shots.rolesProvider', ['off'])) === 'off', "shots.rolesProvider('off') answers 'off'");
    const roles = await result(c, 'roles.get');
    ok(roles && roles.provider === null, 'with no saved key the fixture provider still reads as none (the real step-6 hasKey gate)', stable(roles));

    ok((await result(c, 'shots.voiceState', ['downloading'])) === 'downloading', "shots.voiceState('downloading') answers 'downloading'");
    const vs = await result(c, 'talk.voiceState');
    ok(vs && vs.state === 'downloading' && vs.phase === 'model' && vs.loaded === 64 && vs.total === 100, 'talk.voiceState (step 8b) returns the fixture state', stable(vs));
    ok((await result(c, 'shots.voiceState', ['ready'])) === 'ready', "shots.voiceState('ready') answers 'ready'");
    ok((await result(c, 'talk.voiceState')).state === 'ready', 'the fixture state is what the next talk.voiceState reads');
    ok((await result(c, 'shots.voiceState', ['bogus'])) === 'off', "an invalid voice state falls back to 'off'");

    ok((await result(c, 'shots.seedUsage')) === 5, 'shots.seedUsage seeds five days');
    ok(fs.existsSync(path.join(dataDir, 'usage')) && !fs.existsSync(path.join(out, 'usage')),
      "shots.seedUsage writes the ledger under the run's ud, never the run root");
    const usage = await result(c, 'usage.summary');
    ok(usage && Array.isArray(usage.rows) && usage.rows.length === 10, 'usage.summary (step 6) aggregates the five seeded days (chat + jev per day)', stable(usage && usage.rows && usage.rows.length));
    ok(usage.rows.every((r) => r.calls > 0 && r.in > 0), 'the seeded rows carry the real ledger fields');

    // Gate 12 change 1: a roles write goes through saveSettings into <runDir>/ud too.
    const reset = await result(c, 'roles.reset', ['do']);
    ok(reset && reset.ok === true && fs.existsSync(path.join(dataDir, 'settings.json')) && !fs.existsSync(path.join(out, 'settings.json')),
      "a roles write lands in the run's ud settings, never the run root", stable(reset));
    // ...and so does a key write. With the real DPAPI helper the sidecar RPC stores it; without one the store is driven
    // with a stub backend but at the same data dir, so the location rule is still checked on its own.
    if (vault) {
      const saved = await result(c, 'brainKey.save', ['sk-or-v1-shots-good-0123456789abcdef', true]);
      ok(saved && saved.ok === true && fs.existsSync(path.join(dataDir, 'jev-key.bin')) && !fs.existsSync(path.join(out, 'jev-key.bin')),
        "a shots key write lands in the run's ud, never the run root", stable(saved));
    } else {
      const stub = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
      const store = createKeyStore({ safeStorage: stub, dir: dataDir, name: 'jev', shape: /^sk-or-[A-Za-z0-9_-]{20,200}$/ });
      const written = store.write('sk-or-v1-shots-good-0123456789abcdef');
      ok(written.ok === true && fs.existsSync(path.join(dataDir, 'jev-key.bin')) && !fs.existsSync(path.join(out, 'jev-key.bin')),
        "a key write resolves to the run's ud, never the run root (no vault helper: stub backend)", stable(written));
    }

    const size = await result(c, 'shots.resize', [500, 400]);
    ok(stable(size) === stable([900, 600]), 'shots.resize clamps a request to the 900x600 minimum before the host', stable(size));
    ok(host.calls.some((x) => x.name === '__sidecarHost.resize' && x.args[0] === 900 && x.args[1] === 600), 'the clamped size is what the host is asked for');
    const shot = await result(c, 'shots.capture', ['roles-card.png']);
    ok(shot === 'roles-card.png' && fs.existsSync(path.join(out, 'roles-card.png')), 'shots.capture saves the PNG under the shots dir');
    const bad = await result(c, 'shots.badRoom');
    ok(bad && bad.error && bad.error.code === 'too_big', 'shots.badRoom refuses the too-big fixture through the real import path', stable(bad));
    ok((await result(c, 'shots.finish', [{ ok: true, checks: [{ ok: true }] }])) === true, 'shots.finish answers true');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'shots.json'), 'utf8'));
    ok(report.ok === true && report.kind === 'settingsShots' && Array.isArray(report.checks), 'shots.json keeps the report and the run kind');
    ok(stable(await result(c, 'probe.finish', [{ ok: true }])) === stable(NOT_AVAILABLE), 'probe.finish is not available in a shots launch');
    c.stop();
    await new Promise((r) => c.child.on('close', r));
  }

  // ---------------------------------------------------------------- 4b. a failed capture fails the run (12-runtime 1+5)
  //
  // The host answers every capture with an error, the way the old CDP race did (no frame). Before this fix the
  // capture handlers returned null and the finish report kept `ok:true`, so a run with zero PNGs looked green.
  {
    const selftestOut = modeDir('capture-fail-selftest');
    const selftestData = modeDir('capture-fail-selftest-data');
    const c = start(selftestData, ['--selftest', selftestOut], { host: stubHost({ failCapture: true }) });
    await c.ready;
    const shot = await result(c, 'selftest.capture', ['00-idle.png', { save: '00-idle.png' }]);
    ok(shot && shot.name === '00-idle.png' && shot.error === 'capture_failed_test', 'a failed selftest capture returns its reason', stable(shot));
    ok((await result(c, 'selftest.finish', [{ ok: true, name: 'capture-fail' }])) === true, 'selftest.finish still answers true');
    const report = JSON.parse(fs.readFileSync(path.join(selftestOut, 'selftest.json'), 'utf8'));
    ok(report.ok === false && report.error === 'capture_failed:1' && report.captureErrors[0].name === '00-idle.png'
      && report.captureErrors[0].error === 'capture_failed_test',
      'a failed selftest capture makes selftest.json ok:false with the reason (mutation: drop the finish override)', stable(report).slice(0, 240));
    c.stop();
    await new Promise((r) => c.child.on('close', r));
  }
  {
    const shotsOut = modeDir('capture-fail-shots');
    const shotsData = path.join(shotsOut, 'ud');
    fs.mkdirSync(shotsData, { recursive: true });
    const c = start(shotsData, ['--settings-shots', shotsOut], { host: stubHost({ failCapture: true }) });
    await c.ready;
    ok((await result(c, 'shots.capture', ['roles-card.png'])) === null, 'a failed shots capture answers null');
    ok((await result(c, 'shots.finish', [{ ok: true, checks: [{ ok: true }] }])) === true, 'shots.finish still answers true');
    const report = JSON.parse(fs.readFileSync(path.join(shotsOut, 'shots.json'), 'utf8'));
    ok(report.ok === false && report.error === 'capture_failed:1' && report.captureErrors[0].name === 'roles-card.png',
      'a failed shots capture makes shots.json ok:false with the reason (mutation: drop the finish override)', stable(report).slice(0, 240));
    c.stop();
    await new Promise((r) => c.child.on('close', r));
  }
  {
    const demoOut = modeDir('capture-fail-demo');
    const demoData = modeDir('capture-fail-demo-data');
    const script = path.join(work, 'capture-fail-lines.json');
    fs.writeFileSync(script, JSON.stringify({ lines: [{ text: 'hi' }] }));
    const c = start(demoData, ['--demo-script', script, '--demo-out', demoOut, '--demo-fixture'], { host: stubHost({ failCapture: true }) });
    await c.ready;
    ok((await result(c, 'demo.capture', ['00-start.png'])) === null, 'a failed demo capture answers null');
    ok((await result(c, 'demo.finish', [{ ok: true }])) === true, 'demo.finish still answers true');
    const report = JSON.parse(fs.readFileSync(path.join(demoOut, 'demo.json'), 'utf8'));
    ok(report.ok === false && report.error === 'capture_failed:1' && report.captureErrors[0].name === '00-start.png',
      'a failed demo capture makes demo.json ok:false with the reason (mutation: drop the finish override)', stable(report).slice(0, 240));
    c.stop();
    await new Promise((r) => c.child.on('close', r));
  }

  // ---------------------------------------------------------------- 5. probe mode
  {
    const dataDir = modeDir('probe-data');
    const out = modeDir('probe-out');
    const c = start(dataDir, ['--settings-probe', out]);
    await c.ready;
    const info = await result(c, 'info');
    ok(info && info.settingsProbe === true && info.selftest === false && info.settingsShots === false, 'info.settingsProbe is true in --settings-probe', stable(info));
    ok((await result(c, 'probe.finish', [{ ok: true, rows: 2 }])) === true, 'probe.finish answers true');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'probe.json'), 'utf8'));
    ok(report.ok === true && report.rows === 2 && report.packaged === true && report.settingsShots === false, 'probe.json keeps the report', stable(report));
    ok(stable(await result(c, 'shots.capture', ['x.png'])) === stable(NOT_AVAILABLE), 'shots.capture is not available in a probe launch');
    c.stop();
    await new Promise((r) => c.child.on('close', r));
  }

  // ---------------------------------------------------------------- 6. the pure frame helpers (ported logic)
  {
    const plain = Buffer.alloc(W * H * 4, 128);
    ok(frameStats(plain).lumStd === 0, 'frameStats of a flat frame has zero deviation');
    ok(frameDiff(plain, plain).changedPx === 0, 'frameDiff of identical frames changes nothing');
    ok(frameDiff(plain, Buffer.alloc(4)).error === 'size-mismatch', 'frameDiff refuses frames of different sizes');
  }

  ok(guestUrlOf({ url: 'http://127.0.0.1:5000/#token=abc&lang=en' }) === 'http://127.0.0.1:5000/' && guestUrlOf(null) === null && guestUrlOf({}) === null, 'guestUrlOf drops the token fragment and is null without a board');
  const boardJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'selftest', 'board.js'), 'utf8');
  ok(boardJs.includes('Boolean(bl0.guestUrl) && stripHash(bl0.guestUrl) === stripHash(b.url)'), 'board.js computes servedFromLoopback from a non-empty guestUrl compared with the live URL (route fragment ignored)');
  ok(boardJs.includes('b.signOutHiddenInEmbed = ') && boardJs.includes("!document.querySelector('[data-action=signout]')") && !boardJs.includes('b.signedOut'), 'board.js embed contract: the board own sign-out button is absent (host provides sign-out); no signedOut assertion');

  const roomJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'selftest', 'room.js'), 'utf8');
  ok(roomJs.includes("app.switchRoom('default-v2')") && roomJs.includes("loadedId === 'default-v2'") && roomJs.includes('r.ok = Boolean(r.defaultV2.loaded'), 'selftest room case asserts the v2 default room loads (and r.ok needs it): no v1 expectation, no skip');
  ok(!/switchRoom('default')/.test(roomJs) && !/r.default.skipped/.test(roomJs), 'selftest room case no longer drives the v1 default room');
  ok(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8').includes('roomV2Id: () => currentRoomV2Id'), 'app.js exposes roomV2Id to the selftest');

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
