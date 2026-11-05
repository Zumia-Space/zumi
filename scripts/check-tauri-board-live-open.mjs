// T-31-TAURI P3-B: board.liveOpen + /__zumi-open in the Tauri sidecar (the owner's live board). Plain Node: no window, no network
// (the only upstream is a loopback mock). The Electron originals are src/main/main.js `board:live-open` and board-open.mjs; this
// check pins that the sidecar reuses them UNCHANGED and that the owner/public split is the flavour's, not the caller's.
//
//   node scripts/check-tauri-board-live-open.mjs
//
//   1. owner flavour: board.liveOpen -> { origin, partition, openUrl }; openUrl is single use (60 s nonce -> HttpOnly SameSite=Strict
//      cookie, then dead); the cookie opens the page, no cookie is 401; not live -> { error: 'not_live' }; leaving live drops the origin;
//   2. public flavour: board.liveOpen is registered too (CoS call, Electron parity: the sign-in card + the bridge caller-auth are the
//      gate), but every /__zumi-open verdict is a refusal (decideBoardOpen's own not_owner_build);
//   3. /__zumi-open verdict (__host.boardOpenVerdict, host-only): a valid md chip opens; traversal, unknown extension, outside the
//      roots, junction escape, ADS names, an opener that is not the bridge page and extra query keys are all refused; the bridge
//      itself serves NO /__zumi-open route (no cookie 401, with cookie 404): the open exists only as the board guest's
//      new-window/navigation interception in the Rust host;
//   4. the real sidecar over stdio (public flavour): board.liveOpen -> not_live outside live mode, __host.boardOpenVerdict never opens.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { FLAVOURS } from '../tauri/sidecar/flavour.mjs';
import { OPEN_ROOTS } from '../src/main/board-open.mjs';
import { BOARD_UPSTREAM_ENV, createBoardHost } from '../tauri/sidecar/board-host.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const stable = (v) => JSON.stringify(v);

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP_ROOT, 'liveopen-'));
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
};
const mockUpstream = () => new Promise((resolve) => {
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { host: u.host, ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

// Chip fixtures under the Electron allow-list's own root (the second OPEN_ROOTS entry). A temp dir there, removed at the end.
const MATERIAL = OPEN_ROOTS[1].slice(0, -1);
const fixtureRoot = `${MATERIAL}/_t31-liveopen-check-${process.pid}`;
const outside = path.join(work, 'outside');
fs.mkdirSync(fixtureRoot, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(`${fixtureRoot}/note.md`, '# ok\n');
fs.writeFileSync(`${fixtureRoot}/tool.exe`, 'MZ');
fs.writeFileSync(`${fixtureRoot}/run.cmd`, 'echo hi');
fs.writeFileSync(`${fixtureRoot}/noext`, 'x');
fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
fs.symlinkSync(outside, `${fixtureRoot}/jn`, 'junction');

const settings = () => ({});
const saveSettings = () => ({});
const startLive = async (flavourName) => {
  const up = await mockUpstream();
  const host = createBoardHost({
    safeStorage: fakeSafe, dataDir: fs.mkdtempSync(path.join(work, `host-${flavourName}-`)),
    flavour: { name: flavourName, values: { ...FLAVOURS[flavourName], test: true } }, // test: true so the loopback mock is honoured
    settings, saveSettings, env: { [BOARD_UPSTREAM_ENV]: `http://127.0.0.1:${up.port}` }, idleLock: false,
  });
  const r = host.liveBoard.secrets.configure({ user: 'u', pass: 'p', pin: '123456', token: '' });
  return { up, host, configured: r };
};

try {
  // ---------------------------------------------------------------- 1. owner flavour
  {
    const { up, host, configured } = await startLive('owner');
    ok(configured && configured.ok === true, 'owner: scratch board secrets configured', stable(configured));
    ok(typeof host.handlers['board.liveOpen'] === 'function', 'owner flavour registers board.liveOpen');
    ok(stable(await host.handlers['board.liveOpen']()) === stable({ error: 'not_live' }), 'owner, local mode: board.liveOpen -> { error: not_live }');
    ok(host.liveBridgeOrigin() === null, 'no bridge origin before the first liveOpen');
    ok((await host.handlers['board.setMode']('live')).ok === true, 'owner: setMode live');
    const r = await host.handlers['board.liveOpen']();
    ok(r && typeof r.origin === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(r.origin), 'liveOpen.origin is a loopback bridge origin, never the live host', stable(r));
    ok(r.partition === 'preview-board-live', 'liveOpen.partition is the live partition the policy expects', r.partition);
    ok(typeof r.openUrl === 'string' && r.openUrl.startsWith(`${r.origin}/__bridge-session?n=`), 'liveOpen.openUrl is the bridge session URL (single-use nonce)');
    ok(host.liveBridgeOrigin() === r.origin, 'the sidecar remembers the bridge origin (for guestDecide + the open verdict)');
    // single use
    const first = await get(r.openUrl);
    const setCookie = String(first.headers['set-cookie'] || '');
    ok(first.status === 302 && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), 'openUrl first load: 302 + HttpOnly SameSite=Strict cookie', `${first.status} ${setCookie.replace(/=[0-9a-f]{20,}/, '=<secret>')}`);
    ok(!first.headers.location.includes('n='), 'the redirect target carries no nonce');
    const second = await get(r.openUrl);
    ok(second.status === 401 && !second.headers['set-cookie'], 'openUrl second load: 401, no cookie (single use)', String(second.status));
    const cookie = setCookie.split(';')[0];
    ok((await get(`${r.origin}/`, { cookie })).status === 200, 'the cookie opens the board page');
    ok((await get(`${r.origin}/`)).status === 401, 'no cookie: 401');
    // each liveOpen mints a fresh nonce, the cookie secret stays per-launch
    const r2 = await host.handlers['board.liveOpen']();
    ok(r2.openUrl !== r.openUrl && r2.origin === r.origin, 'a second liveOpen reuses the bridge and mints a new single-use URL');
    const reuse = await get(r2.openUrl);
    ok(reuse.status === 302 && String(reuse.headers['set-cookie']).split(';')[0] === cookie, 'the reused bridge keeps the same per-launch caller secret');

    // ---------------------------------------------------------------- 3. /__zumi-open verdicts (owner flavour, live bridge)
    const origin = r.origin;
    const opener = `${origin}/`;
    const verdict = (u, o = opener) => host.openVerdict(u, o);
    const chip = (p) => `${origin}/__zumi-open?path=${encodeURIComponent(p)}`;
    const v1 = verdict(chip(`${fixtureRoot}/note.md`));
    ok(v1.action === 'openPath' && v1.kind === 'file' && /note\.md$/i.test(v1.path), 'a valid md chip under the allowed roots opens', stable(v1));
    const refusedReason = (u, o) => { const d = verdict(u, o); return d.action === 'refuse' ? d.reason : `NOT_REFUSED:${stable(d)}`; };
    // README.md has an allowed extension, so only the root check can refuse it: the traversal itself is what is under test.
    ok(refusedReason(chip(`${fixtureRoot}/../../TOOL/wt/T-31-tauri-sync-029/README.md`)) === 'outside_allowed_folders', 'traversal (..) out of the root to an allowed-extension file: outside_allowed_folders', refusedReason(chip(`${fixtureRoot}/../../TOOL/wt/T-31-tauri-sync-029/README.md`)));
    ok(verdict(chip(`${fixtureRoot}/../../../Windows/System32/notepad.exe`)).action === 'refuse', 'traversal to an executable is refused');
    ok(verdict(chip(`${fixtureRoot}/..\..\..\Windows\win.ini`)).action === 'refuse', 'backslash traversal is refused');
    ok(refusedReason(chip(`${fixtureRoot}/tool.exe`)) === 'type_not_allowed', 'unknown extension (.exe) inside the root: type_not_allowed');
    ok(refusedReason(chip(`${fixtureRoot}/run.cmd`)) === 'type_not_allowed', '.cmd: type_not_allowed');
    ok(refusedReason(chip(`${fixtureRoot}/noext`)) === 'type_not_allowed', 'no extension: type_not_allowed');
    ok(verdict(chip(`${MATERIAL}-evil/x.md`)).action === 'refuse', 'a sibling folder sharing the root prefix is refused');
    ok(refusedReason(chip('C:/Windows/win.ini')) === 'outside_allowed_folders', 'a file outside the roots is refused');
    ok(refusedReason(chip(`${fixtureRoot}/jn/secret.md`)) === 'outside_allowed_folders', 'a junction inside the root pointing outside is refused (real path resolved)');
    ok(refusedReason(chip(`${fixtureRoot}/run.cmd:x.md`)) === 'name_trick', 'an alternate-data-stream name is refused');
    ok(refusedReason(chip(`${fixtureRoot}/run.cmd.`)) === 'name_trick', 'a trailing-dot name is refused');
    ok(refusedReason(chip('relative/x.md')) === 'not_an_absolute_drive_path', 'a relative path is refused');
    ok(refusedReason(chip('\\\\server\\share\\x.md')) === 'not_an_absolute_drive_path', 'a UNC path is refused');
    ok(refusedReason(`${origin}/__zumi-open?path=${encodeURIComponent(`${fixtureRoot}/note.md`)}&x=1`) === 'bad_request', 'an extra query key is refused');
    ok(refusedReason(`${origin}/__zumi-open`) === 'bad_request', 'no query is refused');
    ok(refusedReason(chip(`${fixtureRoot}/note.md`), 'http://127.0.0.1:1/') === 'opener_not_on_bridge', 'an opener that is not the bridge page is refused');
    ok(refusedReason(chip(`${fixtureRoot}/note.md`), null) === 'opener_not_on_bridge', 'no opener is refused');
    ok(verdict(`http://127.0.0.1:1/__zumi-open?path=x`).action === 'none', 'another origin is not an open request (none)');
    ok(verdict(`${origin}/other?path=x`).action === 'none', 'another pathname on the bridge is not an open request (none)');
    const ext = verdict(`${origin}/__zumi-open?url=${encodeURIComponent('https://zumia.space/a')}`);
    ok(ext.action === 'openExternal' && ext.url === 'https://zumia.space/a', 'a web url chip is the same decideExternalUrl verdict', stable(ext));
    ok(refusedReason(`${origin}/__zumi-open?url=${encodeURIComponent('file:///C:/Windows/win.ini')}`) === 'url_not_allowed', 'a file: url chip is refused');
    // the bridge serves no /__zumi-open route of its own
    const noCookie = await get(chip(`${fixtureRoot}/note.md`));
    ok(noCookie.status === 401, 'GET bridge /__zumi-open without the caller cookie: 401', String(noCookie.status));
    const withCookie = await get(chip(`${fixtureRoot}/note.md`), { cookie });
    ok(withCookie.status === 404, 'GET bridge /__zumi-open WITH the cookie is a plain 404: the bridge never opens anything', String(withCookie.status));
    // leaving live mode drops the origin: the verdict stops recognising it
    ok((await host.handlers['board.setMode']('local')).ok === true && host.liveBridgeOrigin() === null, 'setMode local drops the bridge origin');
    ok(verdict(chip(`${fixtureRoot}/note.md`)).action === 'none', 'after leaving live mode the old origin is not an open request');
    ok(stable(await host.handlers['board.liveOpen']()) === stable({ error: 'not_live' }), 'after leaving live mode board.liveOpen -> not_live');
    // signOut drops it too
    await host.handlers['board.setMode']('live');
    const rr = await host.handlers['board.liveOpen']();
    ok(host.liveBridgeOrigin() === rr.origin, 'live again: origin set');
    const so = await host.handlers['board.signOut']('123456');
    ok(so.ok === true && host.liveBridgeOrigin() === null, 'signOut drops the bridge origin', stable(so));
    await host.dispose();
    up.srv.close();
  }

  // ---------------------------------------------------------------- 2. public flavour
  {
    const { up, host } = await startLive('public');
    ok(typeof host.handlers['board.liveOpen'] === 'function', 'public flavour registers board.liveOpen (Electron parity)');
    ok(stable(await host.handlers['board.liveOpen']()) === stable({ error: 'not_live' }), 'public, local mode: not_live');
    await host.handlers['board.setMode']('live');
    const lo = await host.handlers['board.liveOpen']();
    ok(lo && lo.origin.startsWith('http://127.0.0.1:') && lo.openUrl.startsWith(`${lo.origin}/__bridge-session?n=`) && lo.partition === 'preview-board-live', 'public, live mode: board.liveOpen returns {origin, partition, openUrl}', stable({ ...lo, openUrl: '<url>' }));
    const origin = lo.origin;
    const d = host.openVerdict(`${origin}/__zumi-open?path=${encodeURIComponent(`${fixtureRoot}/note.md`)}`, `${origin}/`);
    ok(d.action === 'refuse' && d.reason === 'not_owner_build', 'public flavour: even a valid md chip is refused (not_owner_build)', stable(d));
    const e = host.openVerdict(`${origin}/__zumi-open?url=${encodeURIComponent('https://zumia.space/')}`, `${origin}/`);
    ok(e.action === 'refuse' && e.reason === 'not_owner_build', 'public flavour: a url chip is refused too', stable(e));
    await host.dispose();
    up.srv.close();
  }

  // ---------------------------------------------------------------- 4. real sidecar over stdio (public flavour)
  {
    const dataDir = fs.mkdtempSync(path.join(work, 'sc-'));
    const child = spawn(process.execPath, [SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    let nextId = 1;
    let readyResolve;
    const ready = new Promise((r) => { readyResolve = r; });
    rl.on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.method === 'ready') readyResolve();
      else if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    child.stderr.on('data', () => {});
    const request = (method, params = []) => new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    await ready;
    const lo = await request('board.liveOpen', []);
    ok(lo.result && lo.result.error === 'not_live', 'real sidecar, public: board.liveOpen outside live mode -> not_live', stable(lo));
    const bv = await request('__host.boardOpenVerdict', ['http://127.0.0.1:1/__zumi-open?path=x', 'http://127.0.0.1:1/']);
    ok(bv.result && (bv.result.action === 'none' || bv.result.action === 'refuse'), 'real sidecar, public: __host.boardOpenVerdict never answers openPath/openExternal', stable(bv));
    // S1: the bridge's own routes are never an OS-browser link, with no live origin known (a stale guest).
    for (const u of ['http://127.0.0.1:1/__zumi-open?path=x', 'http://localhost:9/__bridge-session?n=1']) {
      const r = await request('__host.decideExternalUrl', [u]);
      ok(r.result && r.result.action === 'refuse' && r.result.reason === 'bridge_route', `S1: ${new URL(u).pathname} is refused as an external link`, stable(r));
    }
    const preview = await request('__host.decideExternalUrl', ['http://127.0.0.1:4320/']);
    ok(preview.result && preview.result.action === 'openExternal', 'a loopback preview (not a bridge route) still opens, as on Electron', stable(preview));
    const bad = await request('__host.boardOpenVerdict', [42, null]);
    ok(bad.result && bad.result.action === 'refuse', 'non-string arguments are a refusal, not a throw', stable(bad));
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
  }
} finally {
  try { fs.unlinkSync(`${fixtureRoot}/jn`); } catch { try { fs.rmdirSync(`${fixtureRoot}/jn`); } catch { /* already gone */ } }
  try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
