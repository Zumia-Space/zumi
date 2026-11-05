// T-31 box re-probe 2044691, finding 3: "the board webview never loads (selftest, board-stress, demo) although
// vendor/laneboard is staged". Plain Node, no window, no network beyond a loopback listener.
//
//   node scripts/check-tauri-board-url.mjs
//
// Root cause (measured from runs/selftest/selftest.json: extras.board = { error:'board did not load', outcome:null },
// and no guest_open / board request anywhere in the host log): the sidecar's board server and the staged bundle are
// fine; the renderer never CALLED openBoard(). The box ran the OWNER flavour (flavour.json ownerAdmin=true), and
// app.js sends an ownerAdmin build to renderOwnerBoardTab() (live board + sign-in card), never to the local/sample
// board -- identical in Electron's owner build (package.json zumiOwnerAdmin). Electron's selftest/board-stress/demo
// QC runs use `electron .` (no zumiOwnerAdmin), so the Tauri equivalent is a PUBLIC-flavour build.
//
// T-31 alpha.3 R1 (three whole themes): the board follows the shell theme through the URL fragment only (vendored page, no edit):
// withEmbedLang adds `#theme=light` for the white theme and `#theme=dark` for blue and black, next to the `#token=` the URL may already carry
// (the page's consumeFragment reads token|lang|theme once at boot). The pure part lives in src/renderer/theme.js (withBoardTheme).
//
// This check pins both halves: (a) the exact URL the public-flavour renderer loads resolves against a bundle staged
// from git (same file list as stage-bundle.mjs), answers 200 and carries the pinned release, and the guest policy
// allows it on the board partition; (b) the owner gate that keeps the local board closed is still the documented one.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { decideWebviewAttach } from '../src/main/webview-policy.mjs';
import { FLAVOURS } from '../tauri/sidecar/flavour.mjs';
import { laneboardDir, boardSamplePath, repoRoot } from '../tauri/sidecar/adapters.mjs';

const ROOT = path.join(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };

const TMP = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP, 'board-url-'));
const bundle = path.join(work, 'bundle');

// Stage exactly what stage-bundle.mjs stages for the board: git-tracked files only.
const tracked = (rel) => spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--', rel], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
for (const rel of ['vendor/laneboard', 'src/main', 'tauri/sidecar']) {
  for (const f of tracked(rel)) {
    const dest = path.join(bundle, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), dest);
  }
}

// R1: the renderer's theme module (dynamic, so a missing module is a FAIL line and not a crash).
let themeMod = null, themeLoadError = '';
try { themeMod = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'theme.js')).href); } catch (e) { themeLoadError = String(e && e.message).split('\n')[0]; }

try {
  // The sidecar derives both paths from its own location; in the staged layout they must land on the staged files.
  ok(path.relative(repoRoot, laneboardDir()).split(path.sep).join('/') === 'vendor/laneboard', 'laneboardDir() is <resource root>/vendor/laneboard');
  ok(path.relative(repoRoot, boardSamplePath()).split(path.sep).join('/') === 'src/main/sample-board.json', 'boardSamplePath() is <resource root>/src/main/sample-board.json');
  const stagedLaneboard = path.join(bundle, 'vendor', 'laneboard');
  const stagedSample = path.join(bundle, 'src', 'main', 'sample-board.json');
  ok(fs.existsSync(path.join(stagedLaneboard, 'VERSION')) && fs.existsSync(path.join(stagedLaneboard, 'public')) && fs.existsSync(stagedSample), 'the staged bundle carries the Laneboard core, its public/ pages and the sample board');

  const { openLocalBoard } = await import(pathToFileURL(path.join(bundle, 'src', 'main', 'laneboard-host.mjs')).href);
  const board = await openLocalBoard({ laneboardDir: stagedLaneboard, root: path.join(work, 'data', 'board-data'), sampleFixture: stagedSample, port: 0 });
  ok(board.outcome === 'seeded' && /^http:\/\/127\.0\.0\.1:\d+\/#token=/.test(board.url), 'openLocalBoard on the staged bundle seeds a first-run board and returns a loopback URL', board.url && board.url.replace(/token=.*/, 'token=<redacted>'));

  // The renderer's withEmbedLang (app.js) for a public flavour: embed=1, lang, local=hide; the #token fragment stays.
  const guest = new URL(board.url);
  guest.searchParams.set('embed', '1');
  guest.searchParams.set('lang', 'en');
  guest.searchParams.set('local', 'hide');
  const page = await fetch(guest.href.split('#')[0]);
  const html = await page.text();
  ok(page.status === 200 && /text\/html/.test(page.headers.get('content-type') || '') && html.length > 500, 'the guest URL answers 200 text/html', `status ${page.status} len ${html.length}`);
  const health = await (await fetch(`${board.origin}/healthz`)).json();
  const pinned = fs.readFileSync(path.join(stagedLaneboard, 'VERSION'), 'utf8').trim();
  ok(health.ok === true && typeof health.release === 'string' && pinned.startsWith(health.release), 'healthz reports the pinned Laneboard release', JSON.stringify(health));

  const decision = decideWebviewAttach({
    src: guest.href, partition: 'preview-board', boardOrigin: board.origin,
    boardPartition: 'preview-board', boardLivePartition: 'preview-board-live', wardrobePartition: 'preview-wardrobe',
  });
  ok(decision.allow === true, 'the guest policy allows that exact URL on the preview-board partition', JSON.stringify(decision));
  if (themeMod && themeMod.withBoardTheme) { // R1: the themed URL is still the same request and the same policy verdict
    const themed = themeMod.withBoardTheme(new URL(guest.href), 'white');
    const plainReq = new URL(guest.href); plainReq.hash = ''; const themedReq = new URL(themed.href); themedReq.hash = ''; themedReq.searchParams.delete('zumiTheme');
    ok(themedReq.href === plainReq.href && new URL(themed.href).searchParams.get('zumiTheme') === 'white' && /(^|[#&])theme=light(&|$)/.test(themed.hash) && /^#token=/.test(themed.hash), 'R1 + alpha.4: the white-theme board URL keeps the same path and query plus zumiTheme=white, and both #token= and #theme=light', themed.hash.replace(/token=[^&]*/, 'token=<redacted>'));
    ok(decideWebviewAttach({ src: themed.href, partition: 'preview-board', boardOrigin: board.origin, boardPartition: 'preview-board', boardLivePartition: 'preview-board-live', wardrobePartition: 'preview-wardrobe' }).allow === true, 'R1: the guest policy still allows the URL once it carries #theme=');
  } else ok(false, 'R1: the white-theme board URL keeps the same request and carries #theme=light (needs src/renderer/theme.js withBoardTheme)', themeLoadError);
  ok(decideWebviewAttach({ src: guest.href, partition: 'preview-wardrobe', boardOrigin: board.origin, boardPartition: 'preview-board', boardLivePartition: 'preview-board-live', wardrobePartition: 'preview-wardrobe' }).allow === false, 'and refuses it on any other partition');
  if (board.close) await board.close();
} finally {
  // The loopback server may keep the dir busy for a moment on Windows; the dir is under the check tmp root either way.
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* removed with .tauri-check-tmp */ }
}

// (b) The gate that keeps the local board closed in an owner flavour -- the reason the box's owner-flavour selftest never
// opened it. Pinned so nobody "fixes" the symptom in the renderer: Electron's owner build behaves the same.
{
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  ok(/if \(info\.ownerAdmin\) return renderOwnerBoardTab\(status\);/.test(app), 'app.js sends an ownerAdmin build to the live board / sign-in card, never to openBoard()');
  ok(FLAVOURS.owner.ownerAdmin === true && FLAVOURS.selftest.ownerAdmin === true && FLAVOURS.public.ownerAdmin === false, 'owner and selftest flavours are ownerAdmin builds; only public opens the local board');
  const sel = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'selftest', 'board.js'), 'utf8');
  ok(/app\.openBoardTab\(\)/.test(sel) && /board did not load/.test(sel), 'the self-test board part needs the local board (it has no live-board path)');
}

// (c) R1: which fragment the board gets for which theme (pure function) and that app.js uses it.
{
  const w = themeMod && themeMod.withBoardTheme;
  ok(typeof w === 'function', 'R1: src/renderer/theme.js exports withBoardTheme(url, theme)', themeLoadError);
  if (typeof w === 'function') {
    const tok = 'http://127.0.0.1:1234/?embed=1#token=abc.def_-9';
    const hash = (u, th) => w(new URL(u), th).hash;
    ok(hash(tok, 'white') === '#token=abc.def_-9&theme=light', 'R1: white -> #theme=light, appended to the existing #token= (token bytes untouched)', hash(tok, 'white'));
    ok(hash(tok, 'blue') === '#token=abc.def_-9&theme=dark', 'R1: blue -> #theme=dark', hash(tok, 'blue'));
    ok(hash(tok, 'black') === '#token=abc.def_-9&theme=dark', 'R1: black -> #theme=dark', hash(tok, 'black'));
    ok(hash('http://127.0.0.1:1234/', 'white') === '#theme=light' && hash('http://127.0.0.1:1234/', 'black') === '#theme=dark', 'R1: with no existing fragment the URL gets just #theme=');
    ok(hash('http://127.0.0.1:1234/#token=a&theme=dark', 'white') === '#token=a&theme=light', 'R1: an existing theme= is replaced, not duplicated');
    ok(hash(tok, 'nonsense') === '#token=abc.def_-9&theme=dark', 'R1: an unknown theme string falls back to blue (#theme=dark)', hash(tok, 'nonsense'));    // alpha.4 item 2: the page's own load also names the app theme in the query, so the Tauri bridge (hostTheme) can answer the page's
    // state with matching display prefs; adoptServerPrefs would otherwise put the owner's stored server theme (dark) back.
    const q = (u, th) => w(new URL(u), th).searchParams.get('zumiTheme');
    ok(q(tok, 'white') === 'white' && q(tok, 'blue') === 'blue' && q(tok, 'black') === 'black' && q(tok, 'nonsense') === 'blue', 'alpha.4: the board URL carries ?zumiTheme=<blue|black|white> (unknown -> blue)', [q(tok, 'white'), q(tok, 'blue'), q(tok, 'black'), q(tok, 'nonsense')]);
    ok(w(new URL(tok), 'white').searchParams.get('embed') === '1', 'alpha.4: the existing query (embed=1) is kept');
  }
  {
    const host = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'board-host.mjs'), 'utf8');
    ok(/createBridgeImpl: \(o\) => createBridge\(\{ \.\.\.o, hostTheme: true \}\)/.test(host), 'alpha.4: the Tauri board host builds its bridge with hostTheme: true (Electron main.js does not)');
    const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    ok(!/hostTheme/.test(mainJs), 'alpha.4: Electron main.js never sets hostTheme');
  }
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const fn = /function withEmbedLang\(urlStr\) \{[\s\S]*?\n  \}/.exec(app);
  ok(fn && /withBoardTheme\(u, applied\)/.test(fn[0]) && /const applied = document\.documentElement\.dataset\.theme/.test(fn[0]) && /if \(applied\)/.test(fn[0]),'R1: withEmbedLang adds the theme fragment from the applied <html data-theme> (no data-theme, i.e. next-UI off, adds nothing)');
  ok(/from '\.\/theme\.js'/.test(app) && /onThemeChange\(/.test(app), 'R1: app.js imports theme.js and reloads the open board when the theme changes');
}

console.log(fail ? `check-tauri-board-url FAIL (${fail} failed, ${pass} passed)` : `check-tauri-board-url OK (${pass} passed)`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(fail ? 1 : 0), 300);
