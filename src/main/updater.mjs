// Zumi desktop auto-update, client side (T-31 auto-update; the auto-update spec as
// trimmed by FABLE-REVIEW.md). electron-updater against a static generic feed (latest.yml + installer + blockmap):
//   - OFF unless the build names a feed (packaged package.json `zumiUpdateFeed`): an owner/release build without one
//     never loads electron-updater and makes no network call. https only; a loopback http feed (the local test feed)
//     and the ZUMI_UPDATE_FEED override only in a build that carries `zumiUpdateE2E: true` (the box e2e build).
//   - check once at startup, then every CHECK_INTERVAL_MS (Zumi stays open for days as an avatar app, so launch-only
//     would miss releases); never two checks at once, none while a download runs.
//   - downloads by itself (autoDownload); one offer when it is ready: changelog + Restart now / Later. Later installs
//     silently on the next normal quit (electron-updater autoInstallOnAppQuit); no surprise restart. The renderer
//     defers the offer while Zumi speaks or a reply streams; a version the owner put off is not offered again this
//     session.
//   - forward only (allowDowngrade false; electron-updater also refuses a feed version equal to the running one).
//   - withdrawal: the feed's kill switch is restoring the previous latest.yml. A client that already downloaded the
//     withdrawn version sees the feed go back below it on the next check and drops the pending install-on-quit. It
//     cannot revoke an installer it already ran; the fix for that is a higher repair release.
//   - unsigned pilot: no publisherName in app-update.yml, so electron-updater skips the Authenticode check; the
//     sha512 in latest.yml still rejects a corrupted or swapped installer.
// No Electron import: main.js injects electron-updater's autoUpdater (loadAutoUpdater) and the IPC sender, so
// scripts/check-updater.mjs drives all of this with a fake updater and fake timers.
import fs from 'node:fs';
import path from 'node:path';

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_LOG_NAME = 'updater.log';
export const UPDATE_LOG_MAX_BYTES = 512 * 1024;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** a vs b as semantic versions: -1 | 0 | 1, or null when either is not a valid version. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a ?? '')), pb = SEMVER.exec(String(b ?? ''));
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d > 0 ? 1 : -1; }
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0; // a pre-release sorts before its release
  const xa = pa[4].split('.'), xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) > Number(xb[i]) ? 1 : -1;
    if (na !== nb) return na ? -1 : 1;
    if (!na && xa[i] !== xb[i]) return xa[i] > xb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * The feed this build checks, or none. `pkg` is the packaged package.json.
 * @returns {{ feed: string|null, reason: 'off'|'ok'|'feed_invalid', source?: 'package'|'env' }}
 */
export function resolveFeed({ pkg = {}, env = {} } = {}) {
  const e2e = pkg.zumiUpdateE2E === true;
  const fromEnv = e2e && typeof env.ZUMI_UPDATE_FEED === 'string' && env.ZUMI_UPDATE_FEED !== '';
  const raw = fromEnv ? env.ZUMI_UPDATE_FEED : pkg.zumiUpdateFeed;
  if (raw === undefined || raw === null || raw === '') return { feed: null, reason: 'off' };
  let u;
  try { u = new URL(String(raw)); } catch { return { feed: null, reason: 'feed_invalid' }; }
  const plain = u.href === raw && !u.username && !u.password && !u.search && !u.hash && u.pathname.endsWith('/');
  const https = u.protocol === 'https:' && u.port === '' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(u.hostname) && !/(^|\.)xn--/.test(u.hostname);
  const localTest = e2e && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if (!plain || !(https || localTest)) return { feed: null, reason: 'feed_invalid' };
  return { feed: u.href, reason: 'ok', source: fromEnv ? 'env' : 'package' };
}

/** electron-updater's releaseNotes (a string, or [{ version, note }] with fullChangelog) -> the text for `version`. */
export function releaseNotesText(releaseNotes, version) {
  if (typeof releaseNotes === 'string') return releaseNotes;
  if (Array.isArray(releaseNotes)) {
    const hit = releaseNotes.find((n) => n && n.version === version) || releaseNotes[0];
    return hit && typeof hit.note === 'string' ? hit.note : '';
  }
  return '';
}

/**
 * One release-notes/<version>.md (published in latest.yml by electron-builder releaseInfo.releaseNotesFile) ->
 * { vi, en }. Sections are "## vi" and "## en" headings; text without either heading counts as English.
 */
export function parseNotes(text) {
  const out = { vi: '', en: '' };
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const heads = [...src.matchAll(/^##[ \t]*(vi|en)[ \t]*$/gim)];
  if (!heads.length) { out.en = src.trim(); return out; }
  heads.forEach((h, i) => {
    const body = src.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : src.length).trim();
    const lang = h[1].toLowerCase();
    if (!out[lang]) out[lang] = body;
  });
  return out;
}

/** The changelog in the owner's UI language: Vietnamese UI -> vi; any other UI (en, zh) -> en; missing -> en. */
export function notesFor(notes, lang) {
  return (lang === 'vi' && notes.vi) || notes.en || '';
}

/**
 * What a finished check means while a download may be pending:
 *   'invalid'   the feed version is not a version (ignored)
 *   'withdrawn' a downloaded version waits for install, and the feed is now below it (latest.yml restored)
 *   'newer'     the feed is above the running version (electron-updater offers and downloads it)
 *   'none'      nothing to do (same or lower: forward only)
 */
export function afterCheck({ current, feedVersion, pendingVersion = null }) {
  const vsCurrent = compareVersions(feedVersion, current);
  if (vsCurrent === null) return 'invalid';
  if (pendingVersion && compareVersions(feedVersion, pendingVersion) === -1) return 'withdrawn';
  return vsCurrent === 1 ? 'newer' : 'none';
}

/**
 * Launch + every intervalMs, never overlapping: `check` returns a promise; a tick while one is still running (or
 * while `skip()` says so: a download is running) does nothing and waits for the next tick.
 */
export function createScheduler({ check, intervalMs = CHECK_INTERVAL_MS, skip = () => false, timers = globalThis }) {
  let handle = null, inFlight = false, runs = 0;
  async function tick() {
    if (inFlight || skip()) return false;
    inFlight = true; runs++;
    try { await check(); } catch { /* the caller logs; the next tick retries */ } finally { inFlight = false; }
    return true;
  }
  return {
    start() { if (handle) return; handle = timers.setInterval(tick, intervalMs); if (handle && handle.unref) handle.unref(); tick(); },
    stop() { if (handle) timers.clearInterval(handle); handle = null; },
    tick,
    get runs() { return runs; },
  };
}

/** A capped line log in <userData>/logs (same rotation as refusal-log.mjs: one .1 copy). Never throws. */
export function createFileLog(dir, { name = UPDATE_LOG_NAME, maxBytes = UPDATE_LOG_MAX_BYTES, now = () => new Date() } = {}) {
  const file = path.join(dir, name);
  return (level, msg) => {
    const line = `${now().toISOString()} ${level} ${String(msg).replace(/[\r\n]+/g, ' ').slice(0, 2000)}`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* new file */ }
      if (size > 0 && size + line.length + 1 > maxBytes) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${line}\n`);
    } catch { /* logging must never break updating */ }
    return line;
  };
}

/**
 * @param {object} o
 * @param {string|null} o.feed              resolveFeed().feed; null = OFF (loadAutoUpdater is never called)
 * @param {string} o.currentVersion         app.getVersion()
 * @param {() => object} o.loadAutoUpdater  require('electron-updater').autoUpdater, called once on start()
 * @param {(channel: string, payload: object) => void} o.send   to the renderer ('update:state')
 * @param {() => string} [o.getLang]        the owner's UI language (settings.json uiLang)
 * @param {(level: string, msg: string) => void} [o.log]
 * @param {object} [o.timers]               setInterval/clearInterval (tests)
 * @param {number} [o.intervalMs]
 * @param {(state: object) => void} [o.onReady]  test-build hook (box e2e): called once per downloaded version
 */
export function createUpdater({ feed, currentVersion, loadAutoUpdater, send, getLang = () => 'en', log = () => {}, timers, intervalMs = CHECK_INTERVAL_MS, onReady = null }) {
  const state = { enabled: Boolean(feed), phase: feed ? 'idle' : 'off', version: null, percent: 0, ready: null };
  if (!feed) return { status: () => ({ ...state }), start() {}, stop() {}, install: () => false, later: () => false, check: async () => ({ result: 'off' }) };
  const putOff = new Set(); // versions the owner answered Later this session
  let au = null, scheduler = null, pending = null, lastCheckFailed = false;
  const push = () => send('update:state', { phase: state.phase, version: state.version, percent: state.percent, ready: state.ready });

  function onDownloaded(info) {
    const version = info && info.version;
    if (compareVersions(version, currentVersion) !== 1) return log('warn', `downloaded ${version} is not above ${currentVersion}; ignored`);
    pending = version;
    au.autoInstallOnAppQuit = true; // a withdrawal may have turned it off for an earlier version
    state.phase = 'ready'; state.version = version; state.percent = 100;
    state.ready = putOff.has(version) ? null : { version, notes: notesFor(parseNotes(releaseNotesText(info.releaseNotes, version)), getLang()) };
    log('info', `downloaded ${version}; installs on quit${state.ready ? '; offered' : ' (put off this session)'}`);
    push();
    if (onReady) onReady({ ...state });
  }

  return {
    status: () => ({ ...state }),
    start() {
      if (au) return;
      au = loadAutoUpdater();
      au.autoDownload = true;
      au.autoInstallOnAppQuit = true;
      au.allowDowngrade = false;
      au.allowPrerelease = false;
      au.logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m), debug: () => {} };
      au.setFeedURL({ provider: 'generic', url: feed });
      au.on('update-available', (info) => {
        // a later check finding the version already downloaded (cached): no "downloading 0%" flash; update-downloaded follows
        if (pending && info && info.version === pending) return;
        state.phase = 'downloading'; state.version = info && info.version; state.percent = 0;
        log('info', `available ${state.version}; downloading`); push();
      });
      au.on('download-progress', (p) => {
        const pct = Math.max(0, Math.min(100, Math.floor(Number(p && p.percent) || 0)));
        if (state.phase !== 'downloading' || pct === state.percent) return;
        state.percent = pct; push();
      });
      au.on('update-downloaded', onDownloaded);
      au.on('update-not-available', (info) => {
        const verdict = afterCheck({ current: currentVersion, feedVersion: info && info.version, pendingVersion: pending });
        if (verdict !== 'withdrawn') return;
        log('warn', `feed went back to ${info.version}; pending ${pending} withdrawn, not installed on quit`);
        au.autoInstallOnAppQuit = false;
        pending = null;
        state.phase = 'idle'; state.version = null; state.percent = 0; state.ready = null;
        push();
      });
      au.on('error', (err) => {
        log('error', (err && (err.stack || err.message)) || String(err));
        if (state.phase !== 'downloading') return; // a failed check stays quiet; the next one retries
        state.phase = 'error'; push();
        // back to what is really on disk: the earlier pending download (still offered / installs on quit), or nothing
        Object.assign(state, pending ? { phase: 'ready', version: pending, percent: 100 } : { phase: 'idle', version: null, percent: 0 });
      });
      scheduler = createScheduler({
        intervalMs, timers,
        skip: () => state.phase === 'downloading',
        // With autoDownload, checkForUpdates() resolves { downloadPromise } and nobody awaits that promise: a failed
        // download (network drop, sha512 mismatch) would be an unhandled rejection in main (review 16bd64f). Caught and
        // logged here; the 'error' event already set the state, and the next scheduled check retries.
        check: () => Promise.resolve(lastCheckFailed = false).then(() => au.checkForUpdates())
          .then((r) => { if (r && r.downloadPromise && typeof r.downloadPromise.catch === 'function') r.downloadPromise.catch((e) => log('error', `download failed: ${(e && e.message) || e}; the next check retries`)); })
          .catch((e) => { lastCheckFailed = true; log('error', `check failed: ${(e && e.message) || e}`); }),
      });
      log('info', `on: feed ${feed}, current ${currentVersion}, every ${Math.round(intervalMs / 60000)} min`);
      scheduler.start();
    },
    stop() { if (scheduler) scheduler.stop(); },
    /** The About button: one check now, through the same single-flight scheduler. */
    async check() {
      if (!scheduler) return { result: 'off' };
      if (!(await scheduler.tick())) return { result: 'busy' };
      if (lastCheckFailed) return { result: 'error' };
      return { result: state.phase === 'downloading' || state.phase === 'ready' ? 'available' : 'none' };
    },
    /** Restart now: only an explicit click (or the e2e hook) installs; silent installer, app relaunched. */
    install() {
      if (!au || !pending) return false;
      log('info', `restart to install ${pending}`);
      au.quitAndInstall(true, true);
      return true;
    },
    /** Later: not offered again this session; still installs on the next normal quit. */
    later(version) {
      if (!state.ready || state.ready.version !== version) return false;
      putOff.add(version);
      state.ready = null;
      log('info', `later ${version}; installs on quit`);
      return true;
    },
  };
}
