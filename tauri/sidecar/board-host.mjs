// T-31 parity step 10a: the live board in the sidecar. Electron's board:secrets/PIN/status handlers (main.js:1355-1440)
// delegate to src/main/board-live.mjs, board-secrets.mjs and board-bridge.mjs; this module builds exactly those three,
// UNCHANGED, with the step-5 safeStorage stand-in and the PREVIEW data dir (never Electron's userData). The freeze rule
// allows importing those pure modules as they are; no board logic is re-implemented here.
//
// Egress: the bridge's upstream is LIVE_UPSTREAM (board-live.mjs) and nothing else. The test-only
// ZUMI_BOARD_UPSTREAM override is honoured ONLY when the build flavour carries `test` (owner/selftest, the preview's
// equivalent of Electron's zumiTest flag): resolveBoardUpstream drops it outright otherwise, and createLiveBoard still
// refuses anything that is not the live origin or a loopback http(s) URL. A refused override falls back to the real
// upstream, like main.js:1868-1872.
//
// Secrets never leave this process: every reply here is a status/ok/error object; token/user/pass/pin are only ever the
// arguments to board-secrets.mjs. scripts/check-tauri-board.mjs runs the sentinel check against the real sidecar.
import path from 'node:path';

import { createLiveBoard, isTestBuild, resolveBoardUpstream, LIVE_UPSTREAM } from '../../src/main/board-live.mjs';
import { decideBoardOpen } from '../../src/main/board-open.mjs';
import { createBridge } from '../../src/main/board-bridge.mjs';
import { laneboardDir } from './adapters.mjs';

export const BOARD_UPSTREAM_ENV = 'ZUMI_BOARD_UPSTREAM';
// The webview partition the policy (webview-policy.mjs, boardLivePartition) accepts for the live board guest.
export const BOARD_LIVE_PARTITION = 'preview-board-live';

// The board locks after 15 min of host-reported idle (6-pre's __host.idle cache): parity with the shipped Electron
// IDLE_LOCK_MS (src/main/board-secrets.mjs). The earlier 30 s had no owner quote behind it. The 1 s check interval
// is kept: it only reads a cached number (negligible cost) and the existing idle checks rely on a lock within seconds.
export const BOARD_IDLE_LOCK_MS = 15 * 60 * 1000;
const IDLE_CHECK_MS = 1_000;

/** The preview's isTestBuild: the flavour's `test` flag is Electron's packaged zumiTest flag; the preview ships packaged. */
export function isBoardTestBuild(flavour) {
  const fv = (flavour && flavour.values) || {};
  return isTestBuild({ packaged: true, zumiTestFlag: fv.test === true });
}

/**
 * The upstream the live board will be built with. A public flavour NEVER reads the env override (the branch does not
 * run), and a test flavour's override still has to pass createLiveBoard's own loopback-only check.
 * @returns {{upstream: string, allowTestUpstream: boolean}}
 */
export function boardUpstream({ flavour, env = process.env } = {}) {
  return resolveBoardUpstream({ isTestBuild: isBoardTestBuild(flavour), envOverride: env[BOARD_UPSTREAM_ENV] });
}

const onlyStrings = (o, keys) => Boolean(o) && typeof o === 'object' && keys.every((k) => typeof o[k] === 'string');

/**
 * @param {object} o
 * @param {object} o.safeStorage   the step-5 vault adapter (same three sync methods Electron's safeStorage has)
 * @param {string} o.dataDir       preview data dir: board-secrets.bin / .meta.json live here
 * @param {object} o.flavour       resolved build flavour ({ values: { test, ownerAdmin } })
 * @param {() => object} o.settings
 * @param {(patch: object) => object} o.saveSettings
 * @param {(m: string) => void} [o.log]
 * @param {object} [o.env]         the environment to read the test override from (tests inject it)
 * @param {object} [o.signals]     the cached host signals (6-pre): osEvent lock triggers + the idle clock
 */
export function createBoardHost({ safeStorage, dataDir, flavour, settings, saveSettings, log = () => {}, env = process.env, signals = null, idleLock = true, phoneExtras = () => null }) {
  const { upstream, allowTestUpstream } = boardUpstream({ flavour, env });
  const ownerAdmin = Boolean(flavour && flavour.values && flavour.values.ownerAdmin === true);
  // main.js:657 liveBridgeOrigin: set once board.liveOpen hands out a port, cleared when live mode is left. It is what
  // guestDecide and the /__zumi-open verdict recognise as "the live board".
  let liveBridgeOrigin = null;
  const args = {
    safeStorage,
    secretsDir: dataDir,
    publicDir: path.join(laneboardDir(), 'public'),
    ownerOps: ownerAdmin,
    log,
    // alpha.4 item 2: the Board follows the app theme, not the token's stored server prefs (board-bridge.mjs hostTheme). Electron keeps the default.
    createBridgeImpl: (o) => createBridge({ ...o, hostTheme: true }),
  };
  let liveBoard;
  let effectiveUpstream = upstream;
  try {
    liveBoard = createLiveBoard({ ...args, upstream, allowTestUpstream });
  } catch (e) {
    // A test upstream that is not loopback: the real origin, exactly like main.js's catch. The log line carries the
    // refusal reason (never a secret; the value is a URL the caller planted).
    log(`board upstream refused (${(e && e.message) || e}); falling back to the real live board`);
    liveBoard = createLiveBoard(args);
    effectiveUpstream = LIVE_UPSTREAM;
  }
  // Process-level proof of the effective upstream (gate 10a M3): one secret-free line, origin only, logged only where there is
  // a live board. With the owner values (owner tree and builds) a public flavour names LIVE_ORIGIN whatever ZUMI_BOARD_UPSTREAM is
  // planted, and only a test flavour can show a loopback mock. Without them (the public source, public and official builds)
  // there is no origin and no line. scripts/check-tauri-board.mjs asserts both cases; check-public-payload G10 the staged build.
  if (effectiveUpstream) log(`upstream ${new URL(effectiveUpstream).origin}`);

  // main.js:1371: the envelope's own `type` is the ground truth once secrets exist; settings.requireBoardPin is only
  // the preference for a FRESH install (the first-run form reads it to decide whether to show the PIN field).
  const status = () => {
    const s = liveBoard.status();
    return s.configured ? s : { ...s, pinRequired: settings().requireBoardPin !== false };
  };

  const handlers = {
    'board.status': () => status(),
    'board.setSecrets': (p) => {
      // token is optional; if present it must be a string (main.js:1378). PIN shape is board-secrets.mjs's own check.
      if (!onlyStrings(p, ['user', 'pass', 'pin']) || (p.token !== undefined && typeof p.token !== 'string') || (p.currentPin !== undefined && typeof p.currentPin !== 'string')) return { ok: false, error: 'bad_request' };
      return liveBoard.secrets.configure({ ...p, token: p.token || '' });
    },
    // Fresh setup with the PIN requirement off (main.js:1385): same shape minus `pin`, keeps settings in sync. T-31 PIN
    // fix: on a PIN-sealed store (setSecrets too = Change sign-in) the optional `currentPin` is REQUIRED, see board-secrets.mjs.
    'board.setSecretsOs': (p) => {
      if (!onlyStrings(p, ['user', 'pass']) || (p.token !== undefined && typeof p.token !== 'string') || (p.currentPin !== undefined && typeof p.currentPin !== 'string')) return { ok: false, error: 'bad_request' };
      const r = liveBoard.secrets.configureOs({ ...p, token: p.token || '' });
      if (r.ok) saveSettings({ requireBoardPin: false });
      return r;
    },
    'board.unlock': (pin) => {
      if (typeof pin !== 'string') return { ok: false, error: 'bad_request' };
      return liveBoard.secrets.unlock(pin);
    },
    'board.lock': () => {
      liveBoard.secrets.lock('manual');
      return true;
    },
    // main.js:1352/1359: the Settings toggle on an ALREADY-configured install re-seals the existing secrets; a wrong
    // current PIN is refused by board-secrets.mjs and changes nothing but the (plaintext, secret-free) backoff counter.
    'board.disablePin': (pin) => {
      if (typeof pin !== 'string') return { ok: false, error: 'bad_request' };
      const r = liveBoard.secrets.disablePin(pin);
      if (r.ok) saveSettings({ requireBoardPin: false });
      return r;
    },
    'board.enablePin': (newPin) => {
      if (typeof newPin !== 'string') return { ok: false, error: 'bad_request' };
      const r = liveBoard.secrets.enablePin(newPin);
      if (r.ok) saveSettings({ requireBoardPin: true });
      return r;
    },
    // T-31-TAURI Settings > "Sign out of Board" (Tauri only; Electron main is frozen and has no such channel). Removes the
    // stored user/pass/token (board-secrets.mjs signOut: idempotent, PIN rule = disablePin's) and drops the live board
    // back to local, closing its bridge, so the Board tab reloads signed out. The PIN preference is left as the owner set it.
    'board.signOut': async (pin) => {
      if (pin !== undefined && pin !== null && typeof pin !== 'string') return { ok: false, error: 'bad_request' };
      const r = liveBoard.secrets.signOut(pin == null ? undefined : pin);
      // 'io' = the memory copy is already gone but a file delete failed: still stop the live board, report the error.
      if (r.ok || r.error === 'io') { await liveBoard.setMode('local', r.ok ? 'sign-out' : 'sign-out, file delete failed'); liveBridgeOrigin = null; }
      return r;
    },
    // main.js:1369: the bare preference only, refused once secrets exist (the envelope's own `type` is then the truth;
    // the toggle must go through disablePin/enablePin, which actually re-seal).
    'board.setPinRequired': (on) => {
      if (liveBoard.secrets.status().configured) return { ok: false, error: 'use_toggle' };
      saveSettings({ requireBoardPin: on !== false });
      return { ok: true };
    },
    // main.js:1375 + :1431: leaving live mode also drops liveBridgeOrigin so the board guest stops being recognised.
    'board.setMode': async (mode) => {
      const r = await liveBoard.setMode(mode, 'board.setMode');
      if (r.ok && mode === 'local') liveBridgeOrigin = null;
      return r;
    },
    // main.js:1436 board:live-open, EVERY flavour (CoS call, Electron 0.2.9 parity: main.js has no ownerAdmin check here; the
    // sign-in card, the PIN lock and the bridge's caller-auth are the gate). Returns what Electron returns: the loopback bridge
    // origin, the live partition and the single-use session URL the board guest loads FIRST (its nonce swaps for the HttpOnly
    // caller cookie; the URL is dead after that load). { error: 'not_live' } outside live mode.
    'board.liveOpen': async () => {
      const port = await liveBoard.bridgePort();
      if (!port) return { error: 'not_live' };
      liveBridgeOrigin = `http://127.0.0.1:${port}`;
      // `fed` (bridge-heal2): the Board tab's watch (src/renderer/board-live-watch.js) re-loads a page that never got its board.
      const fed = await liveBoard.bridgePageFed();
      return { origin: liveBridgeOrigin, partition: BOARD_LIVE_PARTITION, openUrl: await liveBoard.bridgeSessionUrl(), fed };
    },
    // ---- T-31-MOBILE M3 phone pairing: OWNER BUILD ONLY (GATE-M3 fix 8d: pairing exports the shared board password) ----
    // `phone.status` is the renderer's read (no secret). The two `__host.*` names are host-only: the Rust host calls them
    // after its own native confirm, and only it ever holds the bundle (it encodes the QR). They are not in the inventory.
    ...(ownerAdmin ? {
      'phone.status': () => {
        const p = settings().phonePairing;
        return p && typeof p.name === 'string' ? { paired: true, name: p.name, iat: p.iat } : { paired: false };
      },
      '__host.phonePairBundle': async () => {
        const prev = settings().phonePairing;
        const r = await liveBoard.phone.pair({ previous: prev && prev.id ? { id: prev.id, name: prev.name } : null, extras: await phoneExtras() });
        if (!r.ok) { log(`phone pair refused: ${r.error}`); return { ok: false, error: r.error }; }
        saveSettings({ phonePairing: { id: r.id, name: r.name, iat: r.iat } });
        log(`phone pair: issued ${r.name}`);
        return { ok: true, bundle: r.bundle, name: r.name, iat: r.iat };
      },
      '__host.phoneUnpair': async () => {
        const prev = settings().phonePairing;
        if (!prev || !prev.id) return { ok: true, paired: false };
        const r = await liveBoard.phone.unpair({ id: prev.id, name: prev.name });
        if (!r.ok) { log(`phone unpair refused: ${r.error}`); return { ok: false, error: r.error }; }
        saveSettings({ phonePairing: null });
        log(`phone unpair: ${prev.name} ${r.revoked ? 'revoked' : r.gone}`);
        return { ok: true, paired: false };
      },
    } : {}),
    // TEST FLAVOUR ONLY (same gate as the ZUMI_BOARD_UPSTREAM override): hands a script the bridge's per-launch caller
    // secret so check-tauri-board can drive the bridge from outside this process. A public flavour never registers it
    // (the call rejects not_implemented), so the secret is reachable only by the app's own webview/readers there.
    ...(isBoardTestBuild(flavour) ? {
      'board.testBridgeAuth': async () => ({ port: await liveBoard.bridgePort(), headers: await liveBoard.bridgeHeaders() }),
    } : {}),
  };

  // Lock triggers (main.js:1971-1973): the OS lock/suspend push locks at once; the idle clock locks once the host
  // reports 15 min without input. Both read the cache 6-pre fills (the only source of OS idle in this process).
  const stopOs = signals ? signals.onOsEvent((name) => {
    if (name === 'lock-screen') liveBoard.secrets.lock('os-lock-screen');
    else if (name === 'suspend') liveBoard.secrets.lock('os-suspend');
  }) : () => {};
  // Step 12-runtime finding 5: a self-test/shots run must be deterministic. A headless box reports a large OS idle at
  // unlock time, so the idle clock would lock the board again mid-run (Electron's 15 min poll does not reach a 2 s
  // check). A test run therefore keeps the OS-lock triggers but skips the idle clock; a normal launch keeps both.
  const idleTimer = signals && idleLock ? setInterval(() => {
    if (signals.idleSeconds() * 1000 >= BOARD_IDLE_LOCK_MS) liveBoard.secrets.lock('idle');
  }, IDLE_CHECK_MS) : null;
  if (idleTimer) idleTimer.unref?.();

  return {
    handlers,
    status,
    liveBoard,
    upstream: effectiveUpstream,
    /** The live bridge origin once liveOpen handed it out; null otherwise. */
    liveBridgeOrigin: () => liveBridgeOrigin,
    /**
     * HOST ONLY (never an rpc): the verdict for a board guest's /__zumi-open request, board-open.mjs decideBoardOpen UNCHANGED
     * (allow-list roots/extensions, real-path resolution, name tricks, opener must be the bridge page). `ownerAdmin` is this
     * process's flavour, never the caller's claim. A malformed argument is a refusal, never a throw.
     */
    openVerdict: (url, openerUrl) => {
      if (typeof url !== 'string') return { action: 'refuse', reason: 'bad_request' };
      return decideBoardOpen(url, { bridgeOrigin: liveBridgeOrigin, ownerAdmin, openerUrl: typeof openerUrl === 'string' ? openerUrl : undefined });
    },
    dispose: async () => {
      if (idleTimer) clearInterval(idleTimer);
      stopOs();
      await liveBoard.close();
    },
  };
}
