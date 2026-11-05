// Working-signal gate (T-31 C1 step 7): headless Node, no Electron, no window, no network. Proves the renderer's
// "working" flag (hud/work-signal.js) end to end on a FAKE clock (milliseconds, no sleeps):
//   1. the rule            a running step with activity in the last 10 min -> working; a waiting/blocked/todo step,
//                          an unparseable time, or >10 min of silence -> not working (the 10th minute still counts);
//                          a chat turn in flight -> working even with no board activity
//   2. one feed update     an injected running update flips working=true on that single setFeed(), and the sink gets
//                          exactly one call (engine.working, the flag the work loop + the seated panel read)
//   2b. the camera         the REAL CameraDirector + the real signal sink: a board step or a chat turn in flight must
//                          leave desiredView() on 'talk' (review B1 / spec §5: talk rooms stay on the talk view)
//   3. one log line        every real change logs exactly "[work] working=true|false"; re-evaluations that do not
//                          change it log nothing (the app calls setChatBusy() every frame)
//   4. 10-min expiry       update() alone (no new feed, no new turn) drops working on the first tick after 10 min
//   4b. chat hold          a turn ending keeps working on until 10 s after it ends (review S2), no board feed needed
//   5. wiring guard        app.js/hud.js/engine.js/camera-director.js/package.json carry the real wiring (source guard,
//                          same technique check-hud.mjs uses for renderer wiring)
//   npm run check:work-signal   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkSignal, deriveWorking, WORK_IDLE_MS, CHAT_HOLD_MS, RUNNING_STEP_STATE } from '../src/renderer/hud/work-signal.js';
import { CameraDirector } from '../src/renderer/room/camera-director.js';
import * as THREE from 'three';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = Date.parse('2026-10-21T08:00:00.000Z'); // fake clock origin, epoch ms
const iso = (t) => new Date(t).toISOString();
const run = (t, extra = {}) => ({ id: 'T-31', at: iso(t), stepState: 'active', ...extra });

// ---------- 1. the rule (pure) ----------
{
  ok(WORK_IDLE_MS === 600000, 'rule: the idle window is 10 minutes', WORK_IDLE_MS);
  ok(CHAT_HOLD_MS === 10_000, 'rule: a turn end holds the signal for 10 s (review S2)', CHAT_HOLD_MS);
  ok(RUNNING_STEP_STATE === 'active', 'rule: board "running" = step state active (hud.state.active)', RUNNING_STEP_STATE);
  ok(deriveWorking([run(T0)], false, T0 + 1000) === true, 'rule: a running step with fresh activity -> working');
  ok(deriveWorking([run(T0)], false, T0 + WORK_IDLE_MS) === true, 'rule: still working at exactly 10 min of silence (the 10th minute counts)');
  ok(deriveWorking([run(T0)], false, T0 + WORK_IDLE_MS + 1) === false, 'rule: not working once silence passes 10 min');
  ok(deriveWorking([run(T0)], false, T0 - 60000) === true, 'rule: a board clock ahead of ours does not lose the signal');
  for (const state of ['waiting', 'blocked', 'todo', 'done', '']) {
    ok(deriveWorking([run(T0, { stepState: state })], false, T0 + 1000) === false, `rule: a ${state || 'stateless'} step is not "running"`);
  }
  ok(deriveWorking([{ id: 'X', at: 'not-a-date', stepState: 'active' }], false, T0) === false, 'rule: an unparseable activity time is never counted');
  ok(deriveWorking([], false, T0) === false && deriveWorking(null, false, T0) === false && deriveWorking(undefined, false, T0) === false, 'rule: no feed rows -> not working');
  ok(deriveWorking([], true, T0) === true, 'rule: a chat turn in flight -> working with no board at all');
  ok(deriveWorking([run(T0)], true, T0 + WORK_IDLE_MS + 1) === true, 'rule: the chat flag wins over an expired board step');
  ok(deriveWorking([run(T0, { stepState: 'waiting' }), run(T0)], false, T0 + 1) === true, 'rule: with several rows, one running row is enough');
  ok(deriveWorking([run(T0, { stepState: 'waiting' }), run(T0 - WORK_IDLE_MS - 1)], false, T0) === false, 'rule: with several rows, only an in-window running row counts');
}

// ---------- 2-5. the stateful signal: fake clock, one log per change, one apply per change ----------
{
  let now = T0;
  const logs = [];
  const calls = [];
  const engine = { working: false, setWorking(on) { this.working = on; calls.push(`engine:${on}`); } };
  const signal = createWorkSignal({
    now: () => now,
    log: (line) => logs.push(line),
    apply: (on) => { engine.setWorking(on); }, // app.js's sink minus the seated panel (DOM-free here)
  });

  ok(signal.working === false && logs.length === 0 && calls.length === 0, 'start: not working, nothing logged or applied');

  // one injected running update -> true on that single feed update
  const r = signal.setFeed([run(T0)]);
  ok(r === true && signal.working === true, 'feed: one injected running update makes working=true');
  ok(logs.length === 1 && logs[0] === '[work] working=true', 'log: exactly "[work] working=true" on the change', logs);
  ok(engine.working === true, 'sink: engine.working=true (the flag the work loop + seated panel read)');
  ok(calls.join(',') === 'engine:true', 'sink: applied once, to engine.working', calls);

  // re-evaluations without a change never log (the render loop calls setChatBusy every frame)
  signal.setChatBusy(false); signal.setChatBusy(false); signal.update();
  ok(logs.length === 1 && calls.length === 1, 'no spam: unchanged re-evaluations log nothing and apply nothing', { logs: logs.length, calls: calls.length });

  // 10-min expiry from the clock alone (no new feed)
  now = T0 + WORK_IDLE_MS;
  ok(signal.update() === true && logs.length === 1, 'expiry: still working at exactly 10 min');
  now = T0 + WORK_IDLE_MS + 1;
  ok(signal.update() === false && signal.working === false, 'expiry: update() alone drops working on the first tick after 10 min');
  ok(logs.length === 2 && logs[1] === '[work] working=false', 'log: exactly "[work] working=false" on the drop', logs);
  ok(engine.working === false, 'sink: engine.working cleared on the drop');

  // a new running feed re-arms it; a non-running feed does not
  ok(signal.setFeed([run(now, { stepState: 'waiting' })]) === false && signal.working === false, 'feed: a waiting update does not turn working on');
  ok(signal.setFeed([run(now)]) === true && signal.working === true, 'feed: a later running update turns it back on');
  ok(logs.slice(-1)[0] === '[work] working=true', 'log: the re-arm is logged too');

  // ---------- 4b. review S2: the chat half holds for CHAT_HOLD_MS after the turn ends ----------
  now += 2000;
  signal.setFeed([]);
  ok(signal.working === false, 'chat: clearing the feed clears the board side');
  ok(signal.setChatBusy(true) === true && signal.working === true, 'chat: a turn in flight gives working=true');
  ok(logs.slice(-1)[0] === '[work] working=true', 'chat: the turn-in-flight change is logged');
  now += WORK_IDLE_MS + 1;
  ok(signal.update() === true && signal.working === true, 'chat: a long turn stays working after the board window has passed');
  const turnEnd = now;
  ok(signal.setChatBusy(false) === true && signal.working === true,
    'chat: the turn END does not drop the signal -- it holds (review S2)');
  now = turnEnd + CHAT_HOLD_MS - 100; // +9.9 s
  ok(signal.update() === true && signal.working === true, 'chat hold: still working 9.9 s after the turn ended (no board feed)');
  now = turnEnd + CHAT_HOLD_MS; // +10 s exactly
  ok(signal.update() === false && signal.working === false, 'chat hold: not working at exactly +10 s with no board feed');
  ok(logs.slice(-1)[0] === '[work] working=false', 'chat hold: the expiry is logged');

  // a new turn during/after the hold re-raises it, and the hold re-arms from the NEW turn end
  now += 500;
  ok(signal.setChatBusy(true) === true && signal.working === true, 'chat hold: a second turn re-raises the signal');
  now += 500;
  ok(signal.setChatBusy(false) === true && signal.working === true, 'chat hold: the second turn end holds again');
  now += CHAT_HOLD_MS - 1;
  ok(signal.update() === true, 'chat hold: the hold restarted from the new turn end');
  now += 1;
  ok(signal.update() === false && signal.working === false, 'chat hold: the second hold expires at its own +10 s');

  // the HUD-Off path: the host reports [] for style off / failed reads
  ok(signal.setFeed([]) === false && signal.working === false, 'hud off: an empty feed keeps working=false (accepted for this slice)');
}

// ---------- 2b. review B1 / spec §5: the working signal must NOT cut the camera to the Work view ----------
// The REAL CameraDirector, wired the way app.js is: the signal sink writes engine.working, and nothing ever calls
// director.setWorking. The room fixture HAS a distinct work view (a different camera + fov), so the old wiring
// (app.js's sink calling director.setWorking, camera-director.js:200 -> 'work') would fail these assertions.
{
  const camAt = (position, target, fov) => ({ position: new THREE.Vector3(...position), target: new THREE.Vector3(...target), fov });
  const mkView = (cam) => ({
    camera: { ...cam, aspect: 16 / 10, viewOffset: null },
    occludersGroup: new THREE.Group(), lightsGroup: new THREE.Group(), hasLights: false, lookTargets: [], seat: null,
  });
  const room = {
    views: {
      talk: mkView(camAt([0, 1.4, 3], [0, 1.3, 0], 28)),
      work: mkView(camAt([0.9, 1.55, 2.3], [0, 1.15, 0], 34)), // a genuinely different over-the-shoulder framing
      room: mkView(camAt([0, 1.4, 3], [0, 1.2, 0], 30)),
    },
  };
  const engine = { working: false, speechMouth: null, lastInputAt: performance.now(), setWorking(on) { this.working = Boolean(on); } };
  const camera = new THREE.PerspectiveCamera(28, 16 / 10, 0.05, 50);
  const director = new CameraDirector({ engine, camera, plateCtx: null });
  director.setRoom(room);
  const signal = createWorkSignal({ now: () => T0, log: () => {}, apply: (on) => engine.setWorking(on) });

  ok(director.view === 'talk' && director.desiredView() === 'talk', 'camera: a fresh room starts on the talk view');
  signal.setFeed([run(T0)]); // a running board step
  ok(signal.working === true && engine.working === true, 'camera: a running board step raises the working signal on the engine');
  ok(director.working === false, 'camera: the signal sink never writes director.working (review B1)');
  ok(director.desiredView() === 'talk', 'camera: board active -> the REAL director still wants TALK (talk rooms stay on talk, spec §5)');
  director.update();
  ok(director.view === 'talk' && !director.switching, 'camera: a per-frame director update confirms no switch to Work');

  signal.setFeed([]); // no board activity
  signal.setChatBusy(true); // a chat turn in flight (every reply used to play in the Work view)
  ok(signal.working === true && engine.working === true, 'camera: a chat turn in flight raises the working signal');
  ok(director.desiredView() === 'talk', 'camera: chat in flight -> the REAL director still wants TALK');
  director.update();
  ok(director.view === 'talk' && !director.switching, 'camera: a per-frame director update still stays on Talk');

  // Control: the fixture really does have a work view -- the director's own API would pick it if it were driven.
  director.setWorking(true);
  ok(director.desiredView() === 'work', 'camera: control -- the room HAS a work view the director would select if driven');
  director.setWorking(false);
  ok(director.desiredView() === 'talk', 'camera: control -- clearing the director flag returns the automatic rule to talk');
}

// ---------- 6. wiring source guard (the modules the app actually ships) ----------
{
  const hud = read('src/renderer/hud/hud.js');
  ok(hud.includes('if (onWorkFeed) onWorkFeed(workFeedOf(payload));'), 'hud.js: every feed reports its task rows through onWorkFeed');
  ok(/const workFeedOf = \(payload\) => \(payload\.style === 'off' \|\| !payload\.feed \? \[\] : payload\.feed\.updates\);/.test(hud),
    'hud.js: an Off style or a failed read reports [] (no stale board side)');

  const app = read('src/renderer/app.js');
  ok(/import \{ createWorkSignal \} from '\.\/hud\/work-signal\.js';/.test(app), 'app.js: imports the work signal');
  ok(/apply: \(on\) => \{ engine\.setWorking\(on\); applyWorkPanel\(\); \}/.test(app),
    'app.js: the sink is engine.working + the seated work panel (C1 step 11); it does NOT drive the camera view (B1, spec §5)');
  ok(!/director\.setWorking/.test(app), 'app.js: nothing in the app calls director.setWorking -- the C1 signal cannot cut to Work (review B1)');
  ok(/onWorkFeed: \(updates\) => workSignal\.setFeed\(updates\)/.test(app), 'app.js: the HUD feed feeds the signal');
  ok(/workSignal\.setChatBusy\(replyBusy\(\)\)/.test(app), 'app.js: the render loop mirrors the chat turn state (and is the expiry clock)');

  const engine = read('src/renderer/reflex/engine.js');
  ok(/this\.working = false;/.test(engine), 'engine.js: engine.working exists');
  // The C1 signal still only sets engine.working here (the camera stays out of it). The false->true edge also wakes
  // her from 'sleepy' (review S3); check-work-loop drives that edge on the real engine.
  ok(/setWorking\(on\) \{\n\s+const next = Boolean\(on\);\n\s+const rising = next && !this\.working;\n\s+this\.working = next;/.test(engine),
    'engine.js: engine.setWorking(on) stores the flag and detects the false->true edge');

  // The director's own setWorking API stays (check-camera proves it still maps a working signal to work); what must
  // NOT happen is the C1 signal driving it. The sink guard above is that line.
  const director = read('src/renderer/room/camera-director.js');
  ok(/setWorking\(on\) \{ this\.working = Boolean\(on\); \}/.test(director), 'camera-director.js: the director API itself is untouched');

  const pkg = JSON.parse(read('package.json'));
  ok(pkg.scripts['check:work-signal'] === 'node scripts/check-work-signal.mjs', 'package.json: check:work-signal runs this script', pkg.scripts['check:work-signal']);
}

console.log(`\ncheck:work-signal ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
