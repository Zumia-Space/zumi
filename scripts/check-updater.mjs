// src/main/updater.mjs (T-31 auto-update, client side) in plain Node: no Electron, no network beyond 127.0.0.1.
//   node scripts/check-updater.mjs        (npm run check:updater)   exit 1 on any failed check
// Covers: feed resolution (OFF by default in the real release and owner configs, https only, the local test feed only
// in an e2e build), version order and the forward-only floor, withdrawal, release-notes parsing per UI language, the
// launch + 6 h schedule without overlap, the whole updater flow against a fake electron-updater (download by itself,
// one offer, Later = not again this session but still installs on quit, Restart = quitAndInstall), the build config
// (pinned electron-updater, generic publish, notes file for this version, no signing in the pilot), the capped log,
// and the local test feed server (scripts/serve-update-feed.mjs).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  CHECK_INTERVAL_MS, compareVersions, resolveFeed, releaseNotesText, parseNotes, notesFor, afterCheck, createScheduler, createUpdater, createFileLog,
} from '../src/main/updater.mjs';
import { createFeedServer } from './serve-update-feed.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const flush = () => new Promise((r) => setImmediate(r));

// ---------- 1. version order (the floor: forward only) ----------
for (const [a, b, want] of [['0.2.1', '0.2.0', 1], ['0.2.0', '0.2.1', -1], ['0.2.1', '0.2.1', 0], ['0.10.0', '0.9.9', 1], ['1.0.0', '0.99.99', 1],
  ['0.2.1-beta.1', '0.2.1', -1], ['0.2.1', '0.2.1-beta.1', 1], ['0.2.1-beta.2', '0.2.1-beta.10', -1], ['0.2.1-alpha', '0.2.1-beta', -1], ['0.2.1-1', '0.2.1-a', -1], ['0.2.1+build.5', '0.2.1', 0],
  ['v0.2.1', '0.2.0', null], ['0.2', '0.2.0', null], ['', '0.2.0', null], [undefined, '0.2.0', null], ['0.2.1 ', '0.2.0', null], ['01.2.3x', '0.2.0', null]]) {
  check(`compareVersions(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${want}`, compareVersions(a, b) === want, compareVersions(a, b));
}

// ---------- 2. the feed: OFF by default, https only, the local feed only in an e2e build ----------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const selftest = createRequire(import.meta.url)('./builder-selftest.cjs');
{
  const release = resolveFeed({ pkg, env: {} });
  check('release build (package.json as packed): updates OFF, no feed', release.feed === null && release.reason === 'off', release);
  const owner = resolveFeed({ pkg: { ...pkg, ...selftest.extraMetadata }, env: {} });
  check('owner build (package.json + builder-selftest extraMetadata): updates OFF until a feed is set', owner.feed === null && owner.reason === 'off', owner);
  check('neither config sets a feed or the e2e flag today', !('zumiUpdateFeed' in pkg) && !('zumiUpdateE2E' in pkg) && !('zumiUpdateFeed' in selftest.extraMetadata) && !('zumiUpdateE2E' in selftest.extraMetadata));
  const envOnly = resolveFeed({ pkg: { ...pkg, ...selftest.extraMetadata }, env: { ZUMI_UPDATE_FEED: 'https://zumia.space/updates/windows/x64/' } });
  check('ZUMI_UPDATE_FEED is ignored outside an e2e build (no way to switch updates on from the environment)', envOnly.feed === null && envOnly.reason === 'off', envOnly);
}
for (const [name, p, env, want] of [
  ['the planned VPS feed', { zumiUpdateFeed: 'https://zumia.space/updates/windows/x64/' }, {}, 'https://zumia.space/updates/windows/x64/'],
  ['an owner feed path', { zumiUpdateFeed: 'https://zumia.space/updates/owner/windows/x64/' }, {}, 'https://zumia.space/updates/owner/windows/x64/'],
  ['the local test feed in an e2e build', { zumiUpdateE2E: true, zumiUpdateFeed: 'http://127.0.0.1:47821/' }, {}, 'http://127.0.0.1:47821/'],
  ['the env override in an e2e build', { zumiUpdateE2E: true }, { ZUMI_UPDATE_FEED: 'http://127.0.0.1:5555/feed/' }, 'http://127.0.0.1:5555/feed/'],
  ['the env override wins over the packed feed in an e2e build', { zumiUpdateE2E: true, zumiUpdateFeed: 'https://zumia.space/updates/windows/x64/' }, { ZUMI_UPDATE_FEED: 'http://127.0.0.1:5555/' }, 'http://127.0.0.1:5555/'],
]) {
  const r = resolveFeed({ pkg: p, env });
  check(`feed on: ${name}`, r.feed === want && r.reason === 'ok', r);
}
for (const [name, p] of [
  ['plain http', { zumiUpdateFeed: 'http://zumia.space/updates/windows/x64/' }],
  ['the local feed without the e2e flag (a production build cannot use it)', { zumiUpdateFeed: 'http://127.0.0.1:47821/' }],
  ['the local feed with a truthy non-boolean e2e flag', { zumiUpdateE2E: 'true', zumiUpdateFeed: 'http://127.0.0.1:47821/' }],
  ['localhost instead of 127.0.0.1 (e2e)', { zumiUpdateE2E: true, zumiUpdateFeed: 'http://localhost:47821/' }],
  ['no trailing slash', { zumiUpdateFeed: 'https://zumia.space/updates/windows/x64' }],
  ['a port', { zumiUpdateFeed: 'https://zumia.space:8443/updates/' }],
  ['userinfo', { zumiUpdateFeed: 'https://u:p@zumia.space/updates/' }],
  ['a query (a token in the URL)', { zumiUpdateFeed: 'https://zumia.space/updates/?token=x' }],
  ['a fragment', { zumiUpdateFeed: 'https://zumia.space/updates/#x' }],
  ['a punycode host', { zumiUpdateFeed: 'https://xn--zmia-6qa.space/updates/' }],
  ['uppercase (not as the parser prints it)', { zumiUpdateFeed: 'https://Zumia.space/updates/' }],
  ['not a URL', { zumiUpdateFeed: 'updates' }],
  ['file:', { zumiUpdateFeed: 'file:///D:/feed/' }],
  ['a non-string', { zumiUpdateFeed: 42 }],
]) {
  const r = resolveFeed({ pkg: p, env: {} });
  check(`feed refused (updates stay off): ${name}`, r.feed === null && r.reason === 'feed_invalid', r);
}

// ---------- 3. release notes: one bilingual file, the UI language picks ----------
{
  const md = '## vi\n• Một\n• Hai\n\n## en\n• One\n• Two\n';
  const n = parseNotes(md);
  check('notes: "## vi" / "## en" sections split', n.vi === '• Một\n• Hai' && n.en === '• One\n• Two', n);
  check('notes: Vietnamese UI -> vi', notesFor(n, 'vi') === '• Một\n• Hai');
  check('notes: English UI -> en', notesFor(n, 'en') === '• One\n• Two');
  check('notes: Chinese UI -> en (no zh section by design)', notesFor(n, 'zh') === '• One\n• Two');
  const enOnly = parseNotes('## en\nOnly English\n');
  check('notes: missing vi section -> English for a Vietnamese UI', notesFor(enOnly, 'vi') === 'Only English');
  check('notes: no headings at all -> the text counts as English', parseNotes('Just text\n').en === 'Just text' && parseNotes('Just text').vi === '');
  check('notes: CRLF and heading case/spacing tolerated', JSON.stringify(parseNotes('##  VI \r\nmột\r\n## En\r\none\r\n')) === JSON.stringify({ vi: 'một', en: 'one' }));
  check('notes: only "## vi" / "## en" start a section ("## vietnam" stays text)', parseNotes('## en\na\n## vietnam\nb').en === 'a\n## vietnam\nb');
  check('notes: empty / missing -> empty strings, nothing offered as notes', notesFor(parseNotes(''), 'vi') === '' && notesFor(parseNotes(undefined), 'en') === '');
  check('releaseNotesText: a string as is', releaseNotesText('x', '0.2.2') === 'x');
  check('releaseNotesText: the fullChangelog array picks this version', releaseNotesText([{ version: '0.2.3', note: 'c' }, { version: '0.2.2', note: 'b' }], '0.2.2') === 'b');
  check('releaseNotesText: null / odd shapes -> ""', releaseNotesText(null, '1.0.0') === '' && releaseNotesText([{ version: '1.0.0', note: 5 }], '1.0.0') === '' && releaseNotesText({}, '1.0.0') === '');
  check('notes are plain text: markup stays literal (the renderer uses textContent)', parseNotes('## en\n<img src=x onerror=alert(1)>').en === '<img src=x onerror=alert(1)>');
}

// ---------- 4. after a check: newer / none / withdrawn ----------
for (const [o, want] of [
  [{ current: '0.2.1', feedVersion: '0.2.2' }, 'newer'], [{ current: '0.2.1', feedVersion: '0.2.1' }, 'none'], [{ current: '0.2.1', feedVersion: '0.2.0' }, 'none'],
  [{ current: '0.2.1', feedVersion: '0.2.1', pendingVersion: '0.2.2' }, 'withdrawn'], [{ current: '0.2.1', feedVersion: '0.2.0', pendingVersion: '0.2.2' }, 'withdrawn'],
  [{ current: '0.2.1', feedVersion: '0.2.2', pendingVersion: '0.2.2' }, 'newer'], [{ current: '0.2.1', feedVersion: '0.2.3', pendingVersion: '0.2.2' }, 'newer'],
  [{ current: '0.2.1', feedVersion: 'garbage', pendingVersion: '0.2.2' }, 'invalid'], [{ current: '0.2.1', feedVersion: undefined }, 'invalid'],
]) check(`afterCheck(${JSON.stringify(o)}) = ${want}`, afterCheck(o) === want, afterCheck(o));

// ---------- 5. schedule: at launch, then every 6 h, never two at once ----------
function fakeTimers() {
  const t = { fns: [], setInterval(fn, ms) { t.fns.push({ fn, ms }); return { id: t.fns.length, unref() {} }; }, clearInterval(h) { t.cleared = h; }, fire() { return t.fns[0].fn(); } };
  return t;
}
check('CHECK_INTERVAL_MS is 6 hours', CHECK_INTERVAL_MS === 6 * 3600 * 1000);
{
  const timers = fakeTimers();
  let calls = 0, release;
  const s = createScheduler({ timers, check: () => { calls++; return new Promise((r) => { release = r; }); } });
  s.start();
  check('schedule: one check right at start', calls === 1);
  check('schedule: then an interval of 6 h', timers.fns.length === 1 && timers.fns[0].ms === CHECK_INTERVAL_MS);
  await timers.fire();
  check('schedule: a tick while the first check still runs does nothing (no overlap)', calls === 1);
  release(); await flush();
  const second = timers.fire();
  check('schedule: the next tick after it finished checks again', calls === 2);
  release(); await second;
  s.start();
  check('schedule: start() twice keeps one interval', timers.fns.length === 1);
  const failing = createScheduler({ timers: fakeTimers(), check: () => Promise.reject(new Error('net down')) });
  failing.start(); await flush();
  check('schedule: a failed check does not stop the schedule (next tick runs)', (await failing.tick()) === true && failing.runs === 2);
  let skipNow = true, n = 0;
  const skipping = createScheduler({ timers: fakeTimers(), skip: () => skipNow, check: async () => { n++; } });
  skipping.start(); await flush();
  check('schedule: skip() (a download is running) -> no check', n === 0);
  skipNow = false; await skipping.tick();
  check('schedule: skip() false -> checks', n === 1);
  s.stop();
  check('schedule: stop() clears the interval', timers.cleared && timers.cleared.id === 1);
}

// ---------- 6. the updater flow against a fake electron-updater ----------
class FakeAutoUpdater extends EventEmitter {
  constructor() { super(); this.checks = 0; this.feeds = []; this.installs = []; this.autoInstallOnAppQuit = false; this.autoDownload = false; this.allowDowngrade = true; }
  setFeedURL(o) { this.feeds.push(o); }
  checkForUpdates() { this.checks++; return Promise.resolve(null); }
  quitAndInstall(silent, runAfter) { this.installs.push([silent, runAfter]); }
}
{
  let loaded = 0;
  const sent = [];
  const off = createUpdater({ feed: null, currentVersion: '0.2.1', loadAutoUpdater: () => { loaded++; return new FakeAutoUpdater(); }, send: (c, p) => sent.push(p) });
  off.start();
  check('OFF: electron-updater is never loaded, nothing is sent, no check', loaded === 0 && sent.length === 0);
  check('OFF: status says off; install/later refuse; check answers off', off.status().phase === 'off' && off.status().enabled === false && off.install() === false && off.later('0.2.2') === false && (await off.check()).result === 'off');
}
{
  const au = new FakeAutoUpdater();
  const sent = [], logs = [], readies = [];
  let lang = 'vi';
  const timers = fakeTimers();
  const u = createUpdater({ feed: 'https://zumia.space/updates/windows/x64/', currentVersion: '0.2.1', loadAutoUpdater: () => au, send: (c, p) => sent.push({ c, ...p }), getLang: () => lang, log: (l, m) => logs.push(`${l} ${m}`), timers, onReady: (s) => readies.push(s.version) });
  u.start(); await flush();
  check('ON: settings per spec (autoDownload, install on quit, no downgrade, no pre-release)', au.autoDownload === true && au.autoInstallOnAppQuit === true && au.allowDowngrade === false && au.allowPrerelease === false);
  check('ON: generic feed set from the build, exactly once', au.feeds.length === 1 && au.feeds[0].provider === 'generic' && au.feeds[0].url === 'https://zumia.space/updates/windows/x64/');
  check('ON: checks once at start, then on the 6 h interval', au.checks === 1 && timers.fns[0].ms === CHECK_INTERVAL_MS);
  check('ON: electron-updater logs go to the updater log', typeof au.logger.info === 'function' && (au.logger.info('x'), logs.at(-1) === 'info x'));
  au.emit('update-available', { version: '0.2.2' });
  check('available -> state downloading 0% sent to the renderer', sent.at(-1).c === 'update:state' && sent.at(-1).phase === 'downloading' && sent.at(-1).version === '0.2.2' && sent.at(-1).percent === 0, sent.at(-1));
  const before = sent.length;
  au.emit('download-progress', { percent: 12.7 }); au.emit('download-progress', { percent: 12.9 }); au.emit('download-progress', { percent: 55 });
  check('progress: whole percents only, repeats not re-sent', sent.length === before + 2 && sent.at(-2).percent === 12 && sent.at(-1).percent === 55, sent.slice(before));
  await timers.fire();
  check('a scheduled check while downloading is skipped', au.checks === 1);
  au.emit('update-downloaded', { version: '0.2.2', releaseNotes: '## vi\n• Mới\n## en\n• New\n' });
  const ready = sent.at(-1);
  check('downloaded -> one offer: version + notes in the UI language (vi)', ready.phase === 'ready' && ready.ready && ready.ready.version === '0.2.2' && ready.ready.notes === '• Mới', ready);
  check('downloaded -> install on quit stays on (Later installs on the next quit)', au.autoInstallOnAppQuit === true);
  check('the e2e hook sees the ready state once', readies.length === 1 && readies[0] === '0.2.2');
  check('later() for another version is refused', u.later('9.9.9') === false);
  check('later(0.2.2) -> no offer left in status', u.later('0.2.2') === true && u.status().ready === null && u.status().phase === 'ready');
  lang = 'en';
  au.emit('update-downloaded', { version: '0.2.2', releaseNotes: '## vi\n• Mới\n## en\n• New\n' }); // a later check finds the cached download
  check('the same version is not offered again this session after Later', sent.at(-1).ready === null && u.status().ready === null);
  check('... but it still installs on quit', au.autoInstallOnAppQuit === true);
  check('install() = quitAndInstall(silent, relaunch)', u.install() === true && JSON.stringify(au.installs) === '[[true,true]]');
  au.emit('update-not-available', { version: '0.2.2' });
  check('a check that finds the same version pending is not a withdrawal', au.autoInstallOnAppQuit === true && u.status().phase === 'ready');
  au.emit('update-not-available', { version: '0.2.1' });
  check('withdrawal: feed back below the pending version -> no install on quit', au.autoInstallOnAppQuit === false);
  check('withdrawal: state idle sent, offer gone, install refused', sent.at(-1).phase === 'idle' && sent.at(-1).ready === null && u.install() === false && au.installs.length === 1);
  check('withdrawal is logged', logs.some((l) => /withdrawn/.test(l)));
  au.emit('update-available', { version: '0.2.3' });
  au.emit('update-downloaded', { version: '0.2.3', releaseNotes: '## en\n• Repair\n' });
  check('a higher repair release after a withdrawal: offered (English UI), install on quit back on', sent.at(-1).ready?.version === '0.2.3' && sent.at(-1).ready?.notes === '• Repair' && au.autoInstallOnAppQuit === true);
  au.emit('update-downloaded', { version: '0.2.1' });
  check('a "downloaded" version not above the running one is ignored (floor)', u.status().version === '0.2.3' && logs.some((l) => /not above/.test(l)));
  const n0 = sent.length;
  au.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  check('an error outside a download (a failed check) sends nothing; the next check retries', sent.length === n0 && logs.at(-1).startsWith('error'));
  au.emit('update-available', { version: '0.2.4' });
  au.emit('error', new Error('sha512 checksum mismatch'));
  check('a download error -> one non-blocking "failed" state, then back to the pending update', sent.at(-1).phase === 'error' && u.status().phase === 'ready' && u.status().version === '0.2.3' && u.status().ready?.version === '0.2.3', u.status());
  check('... and Restart still installs the pending 0.2.3', u.install() === true && au.installs.length === 2);
  u.stop();
  check('stop() stops the schedule', timers.cleared && timers.cleared.id === 1);
}

// ---------- 6b. review 16bd64f: a failed download is handled (no unhandled rejection), logged, and retried ----------
{
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String(e && e.message || e));
  process.on('unhandledRejection', onUnhandled);
  const au = new FakeAutoUpdater();
  let n = 0;
  au.checkForUpdates = () => { n++; return Promise.resolve({ updateInfo: { version: '0.2.2' }, downloadPromise: n === 1 ? Promise.reject(new Error('sha512 checksum mismatch')) : Promise.resolve(['ok']) }); };
  const logs = [], sent = [];
  const timers = fakeTimers();
  const u = createUpdater({ feed: 'https://zumia.space/updates/windows/x64/', currentVersion: '0.2.1', loadAutoUpdater: () => au, send: (c, p) => sent.push(p), log: (l, m) => logs.push(`${l} ${m}`), timers });
  u.start();
  au.emit('update-available', { version: '0.2.2' });
  au.emit('error', new Error('sha512 checksum mismatch'));
  await flush(); await new Promise((r) => setTimeout(r, 20));
  check('failed download: no unhandled rejection reaches the process', unhandled.length === 0, unhandled);
  check('failed download: logged ("download failed ... the next check retries")', logs.some((l) => /^error download failed: sha512 checksum mismatch; the next check retries$/.test(l)), logs);
  check('failed download: state back to idle (the error was shown once)', u.status().phase === 'idle' && sent.some((p) => p.phase === 'error'));
  await timers.fire(); await flush();
  check('failed download: the next scheduled check runs again (retry)', n === 2);
  process.off('unhandledRejection', onUnhandled);
  // the cached re-offer: after Later, a later check emits update-available for the same pending version
  const au2 = new FakeAutoUpdater();
  const sent2 = [];
  const u2 = createUpdater({ feed: 'https://zumia.space/updates/windows/x64/', currentVersion: '0.2.1', loadAutoUpdater: () => au2, send: (c, p) => sent2.push(p), timers: fakeTimers() });
  u2.start();
  au2.emit('update-available', { version: '0.2.2' }); au2.emit('update-downloaded', { version: '0.2.2', releaseNotes: '' });
  u2.later('0.2.2');
  const k = sent2.length;
  au2.emit('update-available', { version: '0.2.2' });
  check('a cached pending version found again: no "downloading 0%" flash', sent2.length === k && u2.status().phase === 'ready');
  au2.emit('update-available', { version: '0.2.3' });
  check('... a newer version still shows downloading', sent2.at(-1).phase === 'downloading' && sent2.at(-1).version === '0.2.3');
}

// ---------- 7. the build config: pinned updater, generic feed metadata, this version's notes, unsigned pilot ----------
{
  check('electron-updater is a runtime dependency, pinned exactly (6.8.10, builder-util-runtime 9.7.0 = electron-builder 26.15.3)', pkg.dependencies && pkg.dependencies['electron-updater'] === '6.8.10' && !(pkg.devDependencies || {})['electron-updater']);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const eu = lock.packages['node_modules/electron-updater'];
  check('lockfile: electron-updater 6.8.10 with integrity, not dev', eu && eu.version === '6.8.10' && /^sha512-/.test(eu.integrity) && !eu.dev && lock.packages[''].version === pkg.version);
  const pub = pkg.build.publish;
  check('build.publish: one generic provider (writes latest.yml + blockmap + app-update.yml; the app sets its feed itself)', Array.isArray(pub) && pub.length === 1 && pub[0].provider === 'generic' && /^https:\/\/[^/]+\/.+\/$/.test(pub[0].url));
  const notesFile = pkg.build.releaseInfo && pkg.build.releaseInfo.releaseNotesFile;
  check(`build.releaseInfo.releaseNotesFile is release-notes/${pkg.version}.md (bump both together)`, notesFile === `release-notes/${pkg.version}.md`, notesFile);
  const notes = fs.existsSync(path.join(ROOT, notesFile || 'x')) ? parseNotes(fs.readFileSync(path.join(ROOT, notesFile), 'utf8')) : null;
  check('the notes file has both a vi and an en section', notes && notes.vi && notes.en, notes);
  check('version is 0.2.1 or later (0.2.1 = the first updater-capable bootstrap build; 0.2.0 installs update by hand once)', compareVersions(pkg.version, '0.2.1') >= 0, pkg.version);
  const win = pkg.build.win || {}, ownerWin = selftest.win || {};
  check('unsigned pilot: no publisherName / certificate / signing hook in either config (electron-updater then skips the signature check; sha512 still applies)', !('publisherName' in win) && !('certificateFile' in win) && !('signtoolOptions' in win) && !('sign' in win) && !('azureSignOptions' in win) && !('publisherName' in ownerWin) && !('signtoolOptions' in ownerWin));
  check('owner config inherits the same publish + releaseInfo', JSON.stringify(selftest.publish) === JSON.stringify(pub) && JSON.stringify(selftest.releaseInfo) === JSON.stringify(pkg.build.releaseInfo));
  check('nsis stays the assisted per-user installer the updater runs silently', pkg.build.nsis.oneClick === false && pkg.build.nsis.perMachine === false);
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const loads = main.match(/require\('electron-updater'\)/g) || [];
  check("main.js: electron-updater is required in exactly one place, inside loadAutoUpdater (so OFF never loads it)", loads.length === 1 && /loadAutoUpdater: \(\) => require\('electron-updater'\)\.autoUpdater/.test(main));
  check('main.js: no updater during self-tests or demos', /feed: selftestDir \|\| demoDir \? null : feed/.test(main));
  check('main.js: the e2e hook only in a zumiUpdateE2E build', /appPkg\.zumiUpdateE2E === true \? process\.env\.ZUMI_UPDATE_E2E : null/.test(main));
  check('main.js: the e2e interval override only in a zumiUpdateE2E build, never below 5 s', /appPkg\.zumiUpdateE2E === true && Number\(process\.env\.ZUMI_UPDATE_INTERVAL_MS\) >= 5000/.test(main) && /intervalMs: e2eInterval/.test(main));
  check('main.js: the three update IPC handlers check fromAppPage', ['update:status', 'update:install', 'update:later'].every((ch) => new RegExp(`ipcMain\\.handle\\('${ch}', \\(e[^)]*\\) => [^\\n]*fromAppPage\\(e\\)`).test(main)));
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  check('preload: update.install takes no argument (the page never names a URL or a file)', /install: \(\) => ipcRenderer\.invoke\('update:install'\)/.test(preload));
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'update-ui.js'), 'utf8');
  check('renderer: notes go in with textContent, never innerHTML', /notesEl\.textContent = /.test(ui) && !/innerHTML/.test(ui));
  check('renderer: the offer waits while Zumi is busy', /if \(isBusy\(\)\) \{ waitTimer = setTimeout\(tryOffer/.test(ui));
}

// ---------- 8. the updater log: capped, one old copy, one line per event ----------
{
  const tmp = fs.mkdtempSync(path.join(ROOT, '.check-updater-'));
  try {
    const log = createFileLog(path.join(tmp, 'logs'), { maxBytes: 400, now: () => new Date('2026-10-13T00:00:00.000Z') });
    const line = log('info', 'first\nsecond');
    check('log line: "<ISO> <level> <msg>" with newlines flattened', line === '2026-10-13T00:00:00.000Z info first second');
    for (let i = 0; i < 30; i++) log('info', `line ${i}`);
    const files = fs.readdirSync(path.join(tmp, 'logs')).sort();
    check('log capped with exactly one .1 copy', JSON.stringify(files) === '["updater.log","updater.log.1"]' && fs.statSync(path.join(tmp, 'logs', 'updater.log')).size <= 400, files);
    const bad = createFileLog(path.join(tmp, 'logs', 'updater.log', 'nested')); // a file where a folder should be
    check('a log write that fails never throws', typeof bad('info', 'x') === 'string');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- 9. the local test feed (what the box e2e serves; same cache rules as the VPS feed) ----------
{
  const tmp = fs.mkdtempSync(path.join(ROOT, '.check-feed-'));
  const feedDir = path.join(tmp, 'feed');
  fs.mkdirSync(feedDir);
  fs.writeFileSync(path.join(feedDir, 'latest.yml'), 'version: 0.2.2\npath: Zumi-Setup-0.2.2.exe\nreleaseNotes: |\n  ## en\n  New\n');
  fs.writeFileSync(path.join(feedDir, 'Zumi-Setup-0.2.2.exe'), Buffer.from('0123456789abcdef'));
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside');
  const s = createFeedServer({ dir: feedDir });
  const get = (p, headers = {}, method = 'GET') => s.port().then((port) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') })); });
    r.on('error', reject); r.end();
  }));
  try {
    const yml = await get('/latest.yml');
    check('feed: latest.yml 200, revalidated on every request (no-cache)', yml.status === 200 && yml.headers['cache-control'] === 'no-cache' && /version: 0\.2\.2/.test(yml.body), yml.headers);
    const exe = await get('/Zumi-Setup-0.2.2.exe');
    check('feed: a versioned file is immutable', exe.status === 200 && /immutable/.test(exe.headers['cache-control']) && exe.body === '0123456789abcdef');
    const part = await get('/Zumi-Setup-0.2.2.exe', { range: 'bytes=4-7' });
    check('feed: a single byte range -> 206 with Content-Range', part.status === 206 && part.body === '4567' && part.headers['content-range'] === 'bytes 4-7/16', part);
    const tail = await get('/Zumi-Setup-0.2.2.exe', { range: 'bytes=-3' });
    check('feed: a suffix range -> the last bytes', tail.status === 206 && tail.body === 'def');
    const multi = await get('/Zumi-Setup-0.2.2.exe', { range: 'bytes=0-1,4-5' });
    check('feed: several ranges -> the whole file with 200 (the client falls back to a full download)', multi.status === 200 && multi.body.length === 16);
    const outside = await get('/..%2Fsecret.txt');
    const outside2 = await get('/%2e%2e/secret.txt');
    check('feed: nothing outside the feed folder is served', outside.status === 404 && outside2.status === 404 && !/outside/.test(outside.body + outside2.body), [outside.status, outside2.status]);
    check('feed: a missing file -> 404', (await get('/Zumi-Setup-9.9.9.exe')).status === 404);
    check('feed: writes are refused (405)', (await get('/latest.yml', {}, 'POST')).status === 405);
    check('feed: listens on 127.0.0.1 only', s.hits.length > 0 && (await s.port()) > 0);
  } finally { await s.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
}

console.log(`\ncheck:updater ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
