// T-31 parity step 12-1: the test-only IPC families (`demo.*`, `selftest.*`, `shots.*`, `probe.finish`) in the
// sidecar, plus the run-dir turn log. Electron registers these handlers only under a CLI flag (main.js
// registerSelftestIpc / registerDemoIpc / registerShotsIpc / registerProbeIpc); this host keeps the names always
// registered (the coverage meter reads the handler table) but every handler answers `not_available` unless the host
// was launched in the matching self-test mode.
//
// Security (GATE-ANSWER Q5, BRIEF-12 "Security core"): self-test mode is decided by the ARGV only -- never by
// settings.json, the environment or an rpc. A normal launch therefore cannot turn these on, and the pixel/clipboard/
// window work that needs the webview is a sidecar -> host request (`__sidecarHost.*`) that only exists in a
// self-test launch (step 12-2).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { boardDataRoot, laneboardVersion, roomV2DefaultPath } from './adapters.mjs';
import { readLegacyTasks } from '../../src/main/laneboard-host.mjs';
import { generateBadRoomFixtures, tooBigFixture } from '../../src/main/room-fixtures.mjs';

const require = createRequire(import.meta.url);
const { usageDir, localDate } = require('../../src/main/usage-ledger.js');

// The refusal every test-only handler gives outside its mode. One frozen object: it is a result, not a thrown error,
// so a renderer call gets an answer instead of a transport failure (Electron's handlers simply do not exist then).
/** The board guest URL for selftest.boardLog: the opened board's url without its fragment, or null. Pure. */
export function guestUrlOf(board) {
  if (!board || typeof board.url !== 'string' || !board.url) return null;
  return board.url.split('#')[0];
}

export const NOT_AVAILABLE = Object.freeze({ error: 'not_available' });

// main.js MIN_WINDOW: shots.resize clamps a request to the window's real minimum before the host applies it.
const MIN_WINDOW = { width: 900, height: 600 };

// The generation source for the bad-room fixtures (any valid room .glb; nothing is written into the repo). Only a
// self-test run reads it, from ZUMI_ROOM_DEFAULT_PATH or settings.roomDefaultPath: the repo ships no v1 room any more
// (room v1 "Zumi's Office" removed, owner 2026-10-26), so with neither set the fixtures report no_default_room.
const EXPECTED_REFUSAL = {
  'too-big.glb': 'too_big',
  'external-image.glb': 'external_uri',
  'draco.glb': 'unsupported_compression',
  'big-texture.glb': 'texture_too_big',
  'bad-magic.glb': 'not_a_room_file',
};

/**
 * Read the self-test modes from the command line. CLI ONLY, by design: the renderer cannot reach argv and nothing
 * here reads settings.json or the environment. Paths must be absolute, like --data-dir, so a mode never guesses a
 * writable location.
 * @param {string[]} argv
 * @returns {{selftest: string|null, demo: {dir: string, script: string, fixture: boolean, reflexOnly: boolean, measureStub: boolean}|null,
 *            shots: {dir: string, kind: string, progressOnly: boolean}|null, probe: string|null, runDir: string|null}}
 */
export function parseSelfTestArgs(argv = []) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const v = argv[i + 1];
    return typeof v === 'string' && !v.startsWith('--') && path.isAbsolute(v) ? v : null;
  };
  const selftest = at('--selftest');
  const demoScript = at('--demo-script');
  const demoOut = demoScript ? at('--demo-out') : null;
  const demo = demoScript && demoOut
    ? { dir: demoOut, script: demoScript, fixture: argv.includes('--demo-fixture'), reflexOnly: argv.includes('--demo-reflex-only'), measureStub: argv.includes('--measure-stub-provider') }
    : null;
  // Exactly one mode per run, the same precedence Electron's flag chain produces.
  if (selftest) return { selftest, demo: null, shots: null, probe: null, runDir: selftest };
  if (demo) return { selftest: null, demo, shots: null, probe: null, runDir: demo.dir };
  for (const [flag, kind] of [['--settings-shots', 'settingsShots'], ['--room-shots', 'roomShots'], ['--board-stress', 'boardStress']]) {
    const dir = at(flag);
    if (dir) return { selftest: null, demo: null, shots: { dir, kind }, probe: null, runDir: null };
  }
  const probe = at('--settings-probe');
  return { selftest: null, demo: null, shots: null, probe, runDir: null };
}

// BGRA pixel statistics, ported from main.js frameStats/frameDiff so a capture's verdict is the same number Electron
// recorded (the buffers come from the host as BGRA, exactly what capturePage().toBitmap() returns).
export function frameStats(buf) {
  let sum = 0, sum2 = 0;
  const n = buf.length / 4;
  for (let i = 0; i < buf.length; i += 4) {
    const l = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
    sum += l; sum2 += l * l;
  }
  const mean = n ? sum / n : 0;
  return { lumMean: mean, lumStd: Math.sqrt(Math.max(0, (n ? sum2 / n : 0) - mean * mean)) };
}

export function frameDiff(a, b) {
  if (a.length !== b.length) return { changedPx: -1, changedPct: 0, meanAbs: 0, error: 'size-mismatch' };
  let changed = 0, total = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    total += d;
    if (d > 24) changed++;
  }
  const n = a.length / 4;
  return { changedPx: changed, changedPct: (100 * changed) / n, meanAbs: total / n };
}

const sanitize = (name) => path.basename(String(name)).replace(/[^\w.-]+/g, '-');
const elapsed = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

// The one-time v0.2 board snapshot (main.js boardLegacyBefore): proves a selftest open left the old files byte-equal.
function hashFiles(dir) {
  const out = {};
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isFile()) out[f] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  } catch { /* no dir yet */ }
  return out;
}

/**
 * @param {object} o
 * @param {ReturnType<typeof parseSelfTestArgs>} o.modes
 * @param {string} o.dataDir                     the preview data dir
 * @param {() => object} o.settings
 * @param {(m: string) => void} [o.log]
 * @param {(channel: string, payload?: unknown) => boolean} [o.emit]  the one push path (protocol.mjs createEmitter)
 * @param {(method: string, params?: unknown[]) => Promise<unknown>} [o.hostCall]  the sidecar -> host request channel
 * @param {() => object|null} [o.getLibrary]      library.mjs (importRoomPath is the production import path)
 * @param {() => object|null} [o.getBoard]        the opened local board, when open
 * @param {() => string|null} [o.getBoardOutcome]
 * @param {{setRoleMode: Function, setVoiceState: Function}|null} [o.shotsFixtures]
 * @param {string|null} [o.testModel]
 */
export function createSelfTestHost({
  modes, dataDir, settings, log = () => {}, emit = () => false, hostCall = null,
  getLibrary = () => null, getBoard = () => null, getBoardOutcome = () => null, shotsFixtures = null,
  testModel = null,
}) {
  const enabled = { selftest: Boolean(modes.selftest), demo: Boolean(modes.demo), shots: Boolean(modes.shots), probe: Boolean(modes.probe) };
  const t0 = { selftest: Date.now(), demo: Date.now(), shots: Date.now(), probe: Date.now() };
  const modeLog = (kind) => (m) => log(`[${kind} +${elapsed(t0[kind])}s] ${String(m).slice(0, 2000)}`);
  const logSelftest = modeLog('selftest');
  const logDemo = modeLog('demo');
  const logShots = modeLog('shots');

  const boardRoot = boardDataRoot(dataDir);
  // Selftest only, taken at start: the v0.2 files as they were before any board open (main.js:547).
  const legacyBefore = enabled.selftest ? { tasks: readLegacyTasks(boardRoot), files: hashFiles(boardRoot) } : null;
  const boardRequests = [];
  // main.js:548: only a selftest records the board's HTTP answers for the board check.
  const onBoardRequest = enabled.selftest
    ? (req, res) => { res.on('finish', () => boardRequests.push({ method: req.method, path: String(req.url).split('?')[0], status: res.statusCode })); }
    : null;

  const baselines = new Map();
  // 12-runtime findings 1+5: a capture the host could not take must not leave the run looking green. Every capture
  // failure is recorded per mode and folded into that mode's finish report (`ok:false` + the reason).
  const captureErrors = { selftest: [], demo: [], shots: [] };
  const noteCaptureError = (kind, name, error) => { captureErrors[kind].push({ name: String(name), error: String(error) }); };
  const finishReport = (kind, report) => {
    const base = report && typeof report === 'object' ? report : {};
    const failed = captureErrors[kind];
    if (!failed.length) return base;
    const reason = `capture_failed:${failed.length}`;
    return { ...base, ok: false, error: typeof base.error === 'string' && base.error ? base.error : reason, captureErrors: failed.slice() };
  };
  let roomFixturesDir = null;

  function defaultRoomPath() {
    if (process.env.ZUMI_ROOM_DEFAULT_PATH) return path.resolve(process.env.ZUMI_ROOM_DEFAULT_PATH);
    const s = settings().roomDefaultPath;
    return s ? path.resolve(s) : null;
  }

  // The guests' network log from the host. Empty when there is no host channel or the host cannot answer: the selftest's
  // network check then reports "0 requests" honestly instead of passing on a guess.
  async function guestNetLog() {
    if (!hostCall) return [];
    try {
      const r = await hostCall('__sidecarHost.netLog', []);
      return Array.isArray(r) ? r.filter((x) => x && typeof x.url === 'string').map((x) => ({ url: x.url })) : [];
    } catch { return []; }
  }

  // One capture request. The host owns the webview; it writes the raw BGRA frame (stats/diff) and/or the PNG.
  async function capture(request) {
    if (!hostCall) return { error: 'capture_unavailable' };
    try {
      const r = await hostCall('__sidecarHost.capture', [request]);
      return r && typeof r === 'object' ? r : { error: 'capture_failed' };
    } catch (e) {
      return { error: String((e && e.message) || e) }; // host_timeout / unknown_host_method / transport
    }
  }

  // The board guest is a separate WebView2 instance, so the main-webview PNG shows only the tab header (visual gate
  // 14, D2). Electron's capturePage includes <webview> content; to keep the evidence comparable we save an open board
  // guest next to the main shot as <base>.board.png. No open guest answers no_board_guest, which is the normal case
  // (not an error) for every shot taken on another tab.
  const GUEST_TARGETS = ['board'];
  async function captureGuests(file) {
    const saved = [];
    const base = file.replace(/.png$/i, '');
    for (const target of GUEST_TARGETS) {
      const r = await capture({ target, rect: null, save: `${base}.${target}.png`, saveFull: false, raw: false });
      if (!r.error) saved.push(`${path.basename(base)}.${target}.png`);
      else if (!/no_board_guest/.test(String(r.error))) saved.push({ target, error: String(r.error) });
    }
    return saved;
  }

  // The raw frame is a host-supplied absolute file; check its declared geometry against the file before trusting it.
  function readRaw(r) {
    const w = Number(r.width), h = Number(r.height), rawPath = r.rawPath;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w * h > 16_000_000) return null;
    if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) return null;
    try {
      if (!fs.statSync(rawPath).isFile()) return null;
      const buf = fs.readFileSync(rawPath);
      return buf.length === w * h * 4 ? buf : null;
    } catch { return null; }
  }

  function writeReport(dir, file, report) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(report, null, 2));
  }

  const baseReport = (report) => ({ ...(report && typeof report === 'object' ? report : {}), exe: process.execPath, packaged: true, testModel });

  function ensureRoomFixtures(dir, kind) {
    const goodPath = defaultRoomPath();
    if (!goodPath || !fs.existsSync(goodPath)) return { error: 'no_default_room' };
    const fixtures = path.join(dir, 'room-fixtures');
    fs.mkdirSync(fixtures, { recursive: true });
    const good = fs.readFileSync(goodPath);
    fs.writeFileSync(path.join(fixtures, 'good.glb'), good);
    for (const [name, buf] of Object.entries(generateBadRoomFixtures(good))) fs.writeFileSync(path.join(fixtures, name), buf);
    log(`${kind} room fixtures generated at ${fixtures}`);
    return { dir: fixtures };
  }

  // A refused import always leaves the fixture generator's file behind only for the duration of the call.
  function importFixture(dir, name) {
    const lib = getLibrary();
    if (!lib || !lib.importRoomPath) return { error: { code: 'not_a_room_file', params: {} } };
    const file = path.join(dir, name);
    return lib.importRoomPath(file);
  }

  const handlers = {
    // ---- demo (4) ----
    'demo.info': () => {
      if (!enabled.demo) return NOT_AVAILABLE;
      try { return { lines: JSON.parse(fs.readFileSync(modes.demo.script, 'utf8')), fixture: modes.demo.fixture, measureStub: modes.demo.measureStub === true }; } catch (e) { return { error: String((e && e.message) || e) }; }
    },
    'demo.log': (m) => { if (!enabled.demo) return NOT_AVAILABLE; logDemo(m); return null; },
    'demo.capture': async (name) => {
      if (!enabled.demo) return NOT_AVAILABLE;
      const file = path.join(modes.demo.dir, sanitize(name));
      fs.mkdirSync(modes.demo.dir, { recursive: true });
      const r = await capture({ target: 'main', rect: null, save: file, saveFull: false, raw: false });
      if (r.error) noteCaptureError('demo', name, r.error);
      else for (const g of await captureGuests(file)) if (typeof g === 'object') noteCaptureError('demo', `${name} guest ${g.target}`, g.error);
      return r.error ? null : path.basename(file);
    },
    'demo.finish': (report) => {
      if (!enabled.demo) return NOT_AVAILABLE;
      const final = finishReport('demo', report);
      writeReport(modes.demo.dir, 'demo.json', { ...baseReport(final), net: [] }); // the sidecar does not see the webview's net log
      logDemo(`finished ok=${Boolean(final.ok)} -> demo.json${final.error ? ` (${final.error})` : ''}`);
      return true;
    },

    // ---- selftest (8) ----
    'selftest.log': (m) => { if (!enabled.selftest) return NOT_AVAILABLE; logSelftest(m); return null; },
    'selftest.roomFixtures': () => {
      if (!enabled.selftest) return NOT_AVAILABLE;
      if (!roomFixturesDir) {
        const made = ensureRoomFixtures(modes.selftest, 'selftest');
        if (made.error) return made;
        roomFixturesDir = made.dir;
      }
      return { names: ['good.glb', ...Object.keys(EXPECTED_REFUSAL), 'missing-anchors.glb'], expectedRefusal: EXPECTED_REFUSAL };
    },
    'selftest.roomOpen': async (name) => {
      if (!enabled.selftest) return NOT_AVAILABLE;
      if (!roomFixturesDir || !/^[\w.-]+\.glb$/.test(String(name))) return { error: { code: 'not_a_room_file', params: {} } };
      const r = await importFixture(roomFixturesDir, String(name));
      return r;
    },
    'selftest.capture': async (name, opts = {}) => {
      if (!enabled.selftest) return NOT_AVAILABLE;
      const o = opts && typeof opts === 'object' ? opts : {};
      const rect = o.rect && typeof o.rect === 'object'
        ? { x: Math.round(o.rect.x), y: Math.round(o.rect.y), width: Math.round(o.rect.width), height: Math.round(o.rect.height) }
        : null;
      const savePath = o.save ? path.join(modes.selftest, sanitize(o.save)) : null;
      const r = await capture({ target: o.target === 'board' ? 'board' : 'main', rect, save: savePath, saveFull: Boolean(savePath && rect), raw: true });
      if (r.error) { noteCaptureError('selftest', name, r.error); return { name, error: r.error }; }
      const buf = readRaw(r);
      if (typeof r.rawPath === 'string') { try { fs.unlinkSync(r.rawPath); } catch { /* the host may own cleanup */ } }
      if (!buf) { noteCaptureError('selftest', name, 'bad_frame'); return { name, error: 'bad_frame' }; }
      const out = { name, width: r.width, height: r.height, pixels: buf.length / 4, ...frameStats(buf) };
      out.blank = out.lumStd < 4 || out.lumMean < 3;
      if (o.diffWith) {
        const base = baselines.get(o.diffWith);
        out.diff = base ? frameDiff(buf, base) : { error: 'no-baseline' };
      }
      if (o.keepAs) baselines.set(o.keepAs, buf);
      if (savePath) out.png = path.basename(savePath);
      return out;
    },
    'selftest.emitBoard': () => {
      // `reflex:event` producer (F2, main.js:1699 `selftest:emit-board`): the test-only push the coverage meter counts.
      // Same payload Electron sends, pushed through the one sidecar -> host -> main-webview path.
      if (!enabled.selftest) return NOT_AVAILABLE;
      return emit('reflex:event', { type: 'board-message', source: 'selftest', at: Date.now() });
    },
    'selftest.clipboardImage': async () => {
      if (!enabled.selftest) return NOT_AVAILABLE;
      if (!hostCall) return { error: 'clipboard_unavailable' };
      try {
        const r = await hostCall('__sidecarHost.clipboardImage', []);
        return r && typeof r === 'object' ? r : { error: 'clipboard_failed' };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    },
    'selftest.finish': (report) => {
      if (!enabled.selftest) return NOT_AVAILABLE;
      const final = finishReport('selftest', report);
      writeReport(modes.selftest, 'selftest.json', baseReport(final));
      logSelftest(`finished ok=${Boolean(final.ok)} -> selftest.json${final.error ? ` (${final.error})` : ''}`);
      return true;
    },
    'selftest.boardLog': async () => {
      if (!enabled.selftest) return NOT_AVAILABLE;
      const b = getBoard();
      const root = boardRoot;
      return {
        laneboard: laneboardVersion(),
        port: b && b.port,
        origin: b && b.origin,
        outcome: getBoardOutcome(),
        root,
        dataDir: path.join(root, 'laneboard'),
        laneboardDirExists: fs.existsSync(path.join(root, 'laneboard')),
        legacyBefore,
        legacyAfter: { tasks: readLegacyTasks(root), files: hashFiles(root) },
        migrationReport: fs.existsSync(path.join(root, 'laneboard', 'migration-report.json')),
        // The preview has ONE data dir (the host passes it): a selftest open and a normal open use the same board root.
        normalRunDataDir: root,
        // The URL the host was told to load for the board guest (board.url minus the #token fragment, which the page
        // consumes and which must never be reported); null until a board was opened. The guest's network log is the host's
        // (guest_requests): every request a board guest made, read here through the host channel.
        guestUrl: guestUrlOf(b),
        requests: boardRequests.slice(),
        net: await guestNetLog(),
      };
    },

    // ---- shots (8) ----
    'shots.capture': async (name) => {
      if (!enabled.shots) return NOT_AVAILABLE;
      const file = path.join(modes.shots.dir, sanitize(name));
      fs.mkdirSync(modes.shots.dir, { recursive: true });
      const r = await capture({ target: 'main', rect: null, save: file, saveFull: false, raw: false });
      if (r.error) noteCaptureError('shots', name, r.error);
      else {
        const guests = await captureGuests(file);
        for (const g of guests) if (typeof g === 'object') noteCaptureError('shots', `${name} guest ${g.target}`, g.error);
        logShots(`captured ${path.basename(file)}${guests.filter((g) => typeof g === 'string').map((g) => ` + ${g}`).join('')}`);
      }
      return r.error ? null : path.basename(file);
    },
    'shots.log': (m) => { if (!enabled.shots) return NOT_AVAILABLE; logShots(m); return null; },
    'shots.finish': (report) => {
      if (!enabled.shots) return NOT_AVAILABLE;
      const final = finishReport('shots', report);
      logShots(`finished ok=${Boolean(final.ok)}${final.error ? ` (${final.error})` : ''}`);
      writeReport(modes.shots.dir, 'shots.json', { ...final, kind: modes.shots.kind });
      return true;
    },
    'shots.badRoom': async () => {
      if (!enabled.shots) return NOT_AVAILABLE;
      // Same source as Electron's shots:bad-room: the v2 room's own occluders.glb (it has no images, so only the
      // too-big builder applies), written to a temp file and imported through the real import path.
      const goodPath = path.join(path.dirname(roomV2DefaultPath(settings())), 'occluders.glb');
      if (!fs.existsSync(goodPath)) return { error: { code: 'not_a_room_file', params: { reason: 'no_default_room' } } };
      fs.mkdirSync(modes.shots.dir, { recursive: true });
      const tmp = path.join(modes.shots.dir, '_bad-room-too-big.glb');
      fs.writeFileSync(tmp, tooBigFixture(fs.readFileSync(goodPath)));
      try {
        return importFixture(modes.shots.dir, '_bad-room-too-big.glb');
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
    'shots.rolesProvider': (mode) => {
      if (!enabled.shots) return NOT_AVAILABLE;
      if (!shotsFixtures) return NOT_AVAILABLE;
      return shotsFixtures.setRoleMode(mode);
    },
    'shots.resize': async (w, h) => {
      if (!enabled.shots) return NOT_AVAILABLE;
      const want = {
        width: Number.isFinite(Number(w)) ? Math.max(MIN_WINDOW.width, Math.round(Number(w))) : MIN_WINDOW.width,
        height: Number.isFinite(Number(h)) ? Math.max(MIN_WINDOW.height, Math.round(Number(h))) : MIN_WINDOW.height,
      };
      if (!hostCall) return { error: 'resize_unavailable' };
      try {
        const r = await hostCall('__sidecarHost.resize', [want.width, want.height]);
        return Array.isArray(r) && r.length === 2 ? r : { error: 'resize_failed' };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    },
    'shots.voiceState': (state) => {
      if (!enabled.shots) return NOT_AVAILABLE;
      if (!shotsFixtures) return NOT_AVAILABLE;
      return shotsFixtures.setVoiceState(state);
    },
    'shots.seedUsage': () => {
      if (!enabled.shots) return NOT_AVAILABLE;
      // main.js:2143: five days of sample ledger lines, in the real ledger format, so usage.summary aggregates them
      // exactly like real calls. Sample numbers, no text.
      const days = [[41, 152000, 9100, 44, 13640, 528], [63, 231400, 14800, 66, 20460, 792], [27, 98200, 6000, 30, 9300, 360], [55, 201000, 12300, 58, 17980, 696], [12, 40100, 2500, 15, 4650, 180]];
      const dir = usageDir(dataDir);
      fs.mkdirSync(dir, { recursive: true });
      days.forEach(([calls, inTok, outTok, jCalls, jIn, jOut], back) => {
        const day = new Date(Date.now() - back * 86400000);
        const lines = [];
        const add = (model, kind, n, i, o) => { for (let k = 0; k < n; k++) { const a = Math.round(i / n), b = Math.round(o / n); lines.push(JSON.stringify({ ts: day.toISOString(), model, kind, in: a, out: b, total: a + b, ms: 900, ok: true })); } };
        add('deepseek/deepseek-v4-flash', 'chat', calls, inTok, outTok);
        add('typesafe/jev-1.13', 'jev', jCalls, jIn, jOut);
        fs.writeFileSync(path.join(dir, `${localDate(day)}.jsonl`), `${lines.join('\n')}\n`);
      });
      return days.length;
    },

    // ---- probe ----
    'probe.finish': (report) => {
      if (!enabled.probe) return NOT_AVAILABLE;
      writeReport(modes.probe, 'probe.json', { ...(report && typeof report === 'object' ? report : {}), settingsShots: false, packaged: true });
      log(`[probe] finished -> probe.json`);
      return true;
    },
  };

  // main.js:1333 talk:log -- turn records (QC evidence) only inside a self-test/demo run dir.
  function appendTurn(rec) {
    if (!modes.runDir || !rec || typeof rec !== 'object') return false;
    let line;
    try { line = JSON.stringify(rec); } catch { return false; }
    if (line.length > 64 * 1024) return false;
    fs.mkdirSync(modes.runDir, { recursive: true });
    fs.appendFileSync(path.join(modes.runDir, 'turns.ndjson'), `${line}\n`);
    return true;
  }

  const info = {
    selftest: enabled.selftest,
    demo: enabled.demo,
    demoFixture: Boolean(modes.demo && modes.demo.fixture),
    demoReflexOnly: Boolean(modes.demo && modes.demo.reflexOnly),
    roomShots: Boolean(modes.shots && modes.shots.kind === 'roomShots'),
    boardStress: Boolean(modes.shots && modes.shots.kind === 'boardStress'),
    settingsShots: Boolean(modes.shots && modes.shots.kind === 'settingsShots'),
    settingsProbe: enabled.probe,
  };

  // Set after creation by main.mjs's wiring (the shots fixture is built in the same call path).
  return {
    handlers,
    info,
    modes,
    enabled,
    runDir: modes.runDir,
    onBoardRequest,
    legacyBefore,
    appendTurn,
  };
}
