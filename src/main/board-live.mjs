// Live-board mode manager (PLAN-live-board.md §1/§2, Coordinator QC 02-10 note 4). Main-process only; Electron-free
// (safeStorage and the bridge factory are injected), so Node can test it directly.
//
// Owns:
//   - the mode switch: 'local' (unrelated to this module — src/main/laneboard-host.mjs) | 'live'. Default is 'live'
//     once the owner has configured live-board credentials (T-31 laneboard-live, owner-build default: anh asked for
//     the Board tab to be the real J-05 board "like a real user", not an extra click every launch) — the Board
//     tab's lock overlay (app.js renderBoardTab) still gates actual reads/writes until the PIN is entered, so this
//     only decides which board a FRESH install (nothing configured yet) shows: unchanged, 'local'.
//   - the egress allowlist for live mode: exactly LIVE_ORIGIN, pinned at construction, not from settings
//     or the renderer (PLAN-live-board.md §2). Local mode adds no egress; this module is simply not used there.
//   - wiring the secrets controller's decrypted creds into the bridge's upstream auth, so the renderer/preload never
//     see a secret (board-bridge.mjs's `getToken`/`getBasicAuth` close over `secrets.getSecrets()` and nothing else).
//
// nginx-auth + identity (read from the Laneboard cutover runbook + vendor/laneboard/src/server.mjs
// comment "Owner behind a login proxy" — NOT from the live VPS, which this task must not touch; owner-token header
// ruling 02-10):
//   The deployed /zumia/ location has `auth_basic` over its ENTIRE path incl. /api/*, so the standard `Authorization`
//   header must hold `Basic <user:pass>` or nginx itself refuses the request before Laneboard ever sees it — a Bearer
//   token cannot share that header with Basic. The owner app token (`X-Laneboard-Token: <token>`, raw, NO "Bearer "
//   prefix) is OPTIONAL (coordinator decision, auth-approved — the Settings "Bảng live" card only asks for
//   username+password+PIN by default): when configured, the bridge sends it on every live-mode request and the live
//   board refuses with 401 if it is invalid, never falling back to the proxy owner; when NOT configured, the header
//   is omitted entirely and the request reaches the board as Basic-only, same as the web board's own UI — nginx's
//   proxy-owner header attributes the write to the generic proxy-owner actor there (PLAN-live-board.md §3). Writes
//   get `X-Requested-With: laneboard` either way.
//   Known residual (L1): the app still holds the board's Basic password, which on its own is owner-capable at the nginx
//   layer; it is PIN-sealed. A proper fix (an nginx /zumia/api carve-out accepting the token without Basic) is L2.
import { createBridge } from './board-bridge.mjs';
import { createSecretsController } from './board-secrets.mjs';
import { ownerValue } from './owner-values.js';

// The owner's live board is an owner value (owner-values.json, Zumi-only, alpha.14 F7): a public or official build has no
// origin, so it builds no bridge, logs no upstream and never goes live (setMode('live') answers no_live_board).
export const LIVE_ORIGIN = ownerValue('liveOrigin', null);
export const LIVE_UPSTREAM = LIVE_ORIGIN ? `${LIVE_ORIGIN}/zumia` : null;

/**
 * Whether this running build is allowed to even ATTEMPT a ZUMI_BOARD_UPSTREAM override — never a release build.
 * Same gating style as the existing test-build flags (main.js's `CLOUD_BASE`/`--selftest`/`ZUMI_TEST_MODEL`): dev
 * (unpackaged `electron .`) counts as a test build on its own; a packaged build only counts if it carries the
 * `zumiTest` flag (set by scripts/builder-selftest.cjs's `extraMetadata`, never present in the release config).
 * @param {object} o
 * @param {boolean} o.packaged    `app.isPackaged`
 * @param {boolean} [o.zumiTestFlag]  the packaged package.json's `zumiTest` field, if any
 */
export function isTestBuild({ packaged, zumiTestFlag }) { return !packaged || Boolean(zumiTestFlag); }

/**
 * Decides the upstream `createLiveBoard` should be constructed with. A release build (`isTestBuild: false`) NEVER
 * reads `envOverride`, whatever it is set to — this is what makes "release ignores ZUMI_BOARD_UPSTREAM" true by
 * construction, not by validating the value and finding it wanting. The loopback-only shape check on a real
 * override happens in `createLiveBoard` itself (the module that owns the egress allowlist) — this function only
 * decides whether to try at all.
 * @param {object} o
 * @param {boolean} o.isTestBuild
 * @param {string|undefined} o.envOverride  raw ZUMI_BOARD_UPSTREAM value, if set
 * @returns {{upstream: string, allowTestUpstream: boolean}}
 */
export function resolveBoardUpstream({ isTestBuild, envOverride }) {
  if (!isTestBuild || !envOverride) return { upstream: LIVE_UPSTREAM, allowTestUpstream: false };
  return { upstream: envOverride, allowTestUpstream: true };
}

/** Throws unless `upstream` is the real live origin, or (only when `allowTestUpstream`) a loopback http(s) URL. null = no live board. */
function assertAllowedUpstream(upstream, allowTestUpstream) {
  if (upstream === null) return;
  const u = new URL(upstream); // throws on garbage input — also a valid refusal
  if (LIVE_ORIGIN && u.origin === LIVE_ORIGIN) return;
  if (allowTestUpstream && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && (u.protocol === 'http:' || u.protocol === 'https:')) return;
  throw new Error(`live board egress refused: ${upstream} is not ${LIVE_ORIGIN}${allowTestUpstream ? ' and not an http(s) 127.0.0.1/localhost test override' : ''}`);
}

/**
 * @param {object} o
 * @param {object} o.safeStorage     Electron's safeStorage (or a test fake with the same 3 methods)
 * @param {string} o.secretsDir      userData-style dir for board-secrets.bin / .meta.json
 * @param {string} o.publicDir      the pinned Laneboard page the bridge serves (vendor/laneboard/public)
 * @param {() => number} [o.now]     injectable clock (tests)
 * @param {(msg:string) => void} [o.log]
 * @param {string} [o.upstream]      override; must resolve to LIVE_ORIGIN unless `allowTestUpstream`
 * @param {boolean} [o.allowTestUpstream]  test/selftest builds only (caller decides via `isTestBuild`/`resolveBoardUpstream`) —
 *   when true, a loopback http(s) `upstream` is accepted alongside LIVE_ORIGIN; still refuses any other origin.
 * @param {typeof createBridge} [o.createBridgeImpl]  injectable for tests
 * @param {boolean} [o.ownerOps]  owner build only (main.js OWNER_ADMIN): the bridge's page channel may write lane
 *   routing (routing.set/reset, roles.set/reset). The release build leaves it false and keeps the 403.
 */
export function createLiveBoard({ safeStorage, secretsDir, publicDir, now, log = () => {}, upstream = LIVE_UPSTREAM, allowTestUpstream = false, createBridgeImpl = createBridge, ownerOps = false }) {
  assertAllowedUpstream(upstream, allowTestUpstream);
  const rawSecrets = createSecretsController({ safeStorage, dir: secretsDir, now, log });
  let bridge = null;
  let mode = upstream && rawSecrets.status().configured ? 'live' : 'local';
  // T-31 0.2.11 auth-401: the live board answered 401 to these credentials. Set ONLY by the bridge at its upstream edge
  // (never by its own `locked`/`unauthorized` 401s); while set, the bridge and board-reader make no upstream call, so a
  // wrong sign-in costs one request, not one every poll forever. Cleared only by a NEW sign-in (configure /
  // configureOs), signOut, or unlock (a deliberate user act: the cause may have been fixed server-side; if not, that one
  // request re-latches, so no loop). In memory: a restart retries once.
  // `authGen` counts those clears; the bridge reports the generation a request's auth was read under, so a late 401
  // sent with the OLD sign-in never latches a just-saved new one (Opus review probe H).
  let authRejected = false;
  let authGen = 0;
  const clearAuthRejected = (r) => { if (r && r.ok) { authRejected = false; authGen++; } return r; };
  const secrets = {
    ...rawSecrets,
    configure: (o) => clearAuthRejected(rawSecrets.configure(o)),
    configureOs: (o) => clearAuthRejected(rawSecrets.configureOs(o)),
    signOut: (pin) => clearAuthRejected(rawSecrets.signOut(pin)),
    unlock: (pin) => clearAuthRejected(rawSecrets.unlock(pin)),
  };
  function onAuthRejected(gen) {
    if (gen !== authGen) { log('ignored a late upstream 401 sent with a sign-in that has since changed'); return; }
    if (!authRejected) log('live board rejected the sign-in (upstream 401); board reads paused until the sign-in changes or the board is unlocked');
    authRejected = true;
  }

  function getBasicAuth() { const s = secrets.getSecrets(); return s ? { user: s.user, pass: s.pass } : null; }
  function getToken() { const s = secrets.getSecrets(); return s ? s.token : null; }
  const canGoLive = () => { const st = secrets.status(); return Boolean(upstream) && st.configured && !st.locked; };

  async function ensureBridge() {
    if (!bridge) bridge = createBridgeImpl({ upstreamOrigin: upstream, getToken, getBasicAuth, publicDir, ownerOps: ownerOps === true, onAuthRejected, isAuthRejected: () => authRejected, authGeneration: () => authGen, onLog: log });
    return bridge;
  }
  async function closeBridge() { if (bridge) { const b = bridge; bridge = null; await b.close(); } }

  /** Live mode never activates unless the secrets are set AND the app is unlocked (PLAN-live-board.md §1). */
  async function setMode(next) {
    if (next !== 'local' && next !== 'live') return { ok: false, error: 'bad_mode' };
    if (next === 'live' && !upstream) return { ok: false, error: 'no_live_board' };
    if (next === 'live' && !canGoLive()) return { ok: false, error: 'locked_or_unconfigured' };
    mode = next;
    if (mode === 'live') await ensureBridge(); else await closeBridge();
    return { ok: true, mode };
  }

  return {
    secrets, // .configure/.unlock/.lock/.status/.noteActivity/.checkIdle — main.js wires these to IPC + powerMonitor
    setMode,
    status: () => ({ mode, ...secrets.status(), ...(authRejected ? { authRejected: true } : {}) }),
    /** The first URL for the app's own board webview: carries a single-use nonce that swaps for the caller cookie. null outside live mode. */
    async bridgeSessionUrl() { return mode === 'live' ? (await ensureBridge()).sessionUrl() : null; },
    /** Caller-secret header for in-process loopback readers (board-reader, HUD). {} outside live mode. */
    async bridgeHeaders() { return mode === 'live' ? (await ensureBridge()).callerHeaders() : {}; },
    /** The live bridge's loopback port, for the webview to load — null outside live mode. Still 401s while locked. */
    async bridgePort() { return mode === 'live' ? (await ensureBridge()).port() : null; },
    /**
     * RELAY channel (T-31 0.2.3 batch C): Zumi relaying one write from the app itself (the HUD answering a board
     * ask), through the SAME live bridge — never a new connection, never a new op (the bridge's RELAY_OPS allowlist
     * still bounds it to ask.answer / feedback.add / inbox.submit). Delegates only while the board is actually live
     * AND unlocked (`canGoLive()`); the read-only mirror and a locked/unconfigured board are refused here with 401
     * `locked`, before any bridge or network call — a write must be refused, not attempted, when the board is served
     * from the mirror (PLAN Feature 2). The shape mirrors board-bridge.mjs relay() so callers read one result type.
     * @param {string} op
     * @param {object} [body]
     * @returns {Promise<{status:number, text:string}>}
     */
    async relay(op, body = {}) {
      if (mode !== 'live' || !canGoLive()) return { status: 401, text: JSON.stringify({ error: 'locked' }) };
      const b = await ensureBridge();
      return b.relay(op, body);
    },
    /**
     * HOST ONLY (T-31-MOBILE M3 pairing): never reachable from a page. The phone gets the board login (owner decision
     * D1 a, owner's own test build) plus one fresh DEVICE token (D3), as one QR the host shows for 60 s.
     */
    phone: {
      /**
       * Revoke the token this app minted last time (fails closed), then mint a new one and build the bundle.
       * @param {{previous?: {id:string, name:string}|null, nowS?: number, extras?: {ai: object|null, voice: object|null, redact?: string[]}|null}} o
       * @returns {Promise<{ok:true, bundle:string, id:string, name:string, iat:number} | {ok:false, error:string, status?:number}>}
       *   `bundle` holds the password and the token: the caller encodes it as the QR and drops it.
       */
      async pair({ previous = null, nowS = Math.floor(Date.now() / 1000), extras = null } = {}) {
        if (!canGoLive()) return { ok: false, error: 'locked_or_unconfigured' };
        const b = await ensureBridge();
        if (previous && previous.id) {
          const r = await b.revokeDeviceToken(previous);
          if (!r.ok) return { ok: false, error: `previous_not_revoked:${r.error}`, status: r.status };
        }
        // the login first: a token minted without a login to send with it would be an orphan nobody revokes (REVIEW-M3 F4)
        const basic = getBasicAuth();
        if (!basic) return { ok: false, error: 'locked' };
        const issued = await b.issueDeviceToken({ now: new Date(nowS * 1000) });
        if (!issued.ok) return { ok: false, error: issued.error, status: issued.status };
        // v2 (M4/M5): + `ai` (the selected brain provider's key, or null) and `voice` (non-secret voice prefs + the owner
        // route flag), `redact` (the PC's client-name list, masked in the phone's digest), from the host (main.mjs
        // phoneExtras). Exactly ten fields; the phone accepts v1 and v2.
        const ai = extras && extras.ai ? { provider: extras.ai.provider, key: extras.ai.key, model: extras.ai.model || null } : null;
        const voice = extras && extras.voice ? extras.voice : null;
        const redact = extras && Array.isArray(extras.redact) ? extras.redact : [];
        const bundle = JSON.stringify({ v: 2, kind: 'zumi-phone-pair', iat: nowS, user: basic.user, pass: basic.pass, token: issued.token, name: issued.name, ai, voice, redact });
        return { ok: true, bundle, id: issued.id, name: issued.name, iat: nowS };
      },
      async unpair(ref) {
        if (!canGoLive()) return { ok: false, error: 'locked_or_unconfigured' };
        return (await ensureBridge()).revokeDeviceToken(ref || {});
      },
      async listTokens() {
        if (!canGoLive()) return { ok: false, error: 'locked_or_unconfigured' };
        return (await ensureBridge()).listTokens();
      },
    },
    async close() { await closeBridge(); },
  };
}
