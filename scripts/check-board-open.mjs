// src/main/board-open.mjs: what the owner build opens when the live board page asks (/__zumi-open). Plain Node.
//   node scripts/check-board-open.mjs        exit 1 on any failed check
// Allowed: files (png/jpg/jpeg/webp/gif/html/md/webm/mp4/pdf) and folders whose REAL path is under one of the owner
// roots (OPEN_ROOTS); URLs http://127.0.0.1:<port>/… (localhost opened as 127.0.0.1) and any plain http/https web page (no host allowlist since 0.2.5), asked
// by a page on the bridge origin. Everything else is refused. The real-filesystem part creates (and removes) a folder
// under the second owner root to pin the Windows name tricks (trailing dot/space, alternate data streams: Sol gate condition 2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideBoardOpen, decideExternalUrl, decideLocalPath, openRoots, OPEN_PATHNAME, OPEN_ROOTS } from '../src/main/board-open.mjs';
import { appendRefusal, safeOrigin, REFUSAL_LOG_NAME } from '../src/main/refusal-log.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Every test path derives from the owner roots, so this file names no folder of its own.
const [R0, R1] = OPEN_ROOTS;
const RK = R0.slice(0, R0.slice(0, -1).lastIndexOf('/') + 1); // the roots' common parent
const win = (p) => p.split('/').join(String.fromCharCode(92));
const [W0, W1, WK] = [R0, R1, RK].map(win);
// A secrets-style file outside the roots: a temp-dir placeholder (never a real secrets location).
const SECRETS_WIN = path.win32.join(os.tmpdir(), 'zumi-check-secrets', 'staging.env');
const SECRETS = SECRETS_WIN.split(String.fromCharCode(92)).join('/');

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const BRIDGE = 'http://127.0.0.1:51234';
const req = (q, origin = BRIDGE) => `${origin}${OPEN_PATHNAME}?${new URLSearchParams(q)}`;

// A fake filesystem, so every rule is checked without touching disk: real path (junction target) + kind.
const FS = {
  [`${W0}t31\\QC-CUOI-ANH.md`]: { real: `${W0}t31\\QC-CUOI-ANH.md`, kind: 'file' },
  [`${W0}l01\\visual-0910\\contact-sheet.png`]: { real: `${W0}l01\\visual-0910\\contact-sheet.png`, kind: 'file' },
  [`${W0}c52\\MORNING-0910\\`]: { real: `${W0}c52\\MORNING-0910`, kind: 'dir' },
  [`${W0}c52\\MORNING-0910\\index.html`]: { real: `${W0}c52\\MORNING-0910\\index.html`, kind: 'file' },
  [`${W1}F-04\\clip.webm`]: { real: `${W1}F-04\\clip.webm`, kind: 'file' },
  [`${W0}f04\\homepage\\index.html`]: { real: `${WK}TOOL\\wt\\F-04-homepage\\index.html`, kind: 'file' }, // junction out
  [`${W0}board\\cos-board.mjs`]: { real: `${W0}board\\cos-board.mjs`, kind: 'file' },
  [`${W0}x\\run.cmd`]: { real: `${W0}x\\run.cmd`, kind: 'file' },
  [`${W0}x\\a.md.lnk`]: { real: `${W0}x\\a.md.lnk`, kind: 'file' },
  [`${WK}TOOL\\secret.md`]: { real: `${WK}TOOL\\secret.md`, kind: 'file' },
  [SECRETS_WIN]: { real: SECRETS_WIN, kind: 'file' },
  [`${W0.slice(0, -1)}-evil\\a.md`]: { real: `${W0.slice(0, -1)}-evil\\a.md`, kind: 'file' },
  [`${WK}TOOL\\x.md`]: { real: `${WK}TOOL\\x.md`, kind: 'file' },
  // the resolver answering with a stream path / a trailing-dot folder (defence in depth: the resolved path is checked too)
  [`${W0}x\\short.md`]: { real: `${W0}x\\run.cmd:x.md`, kind: 'file' },
  [`${W0}x\\short2.md`]: { real: `${W0}x.\\a.md`, kind: 'file' },
};
const realpath = (p) => { const e = FS[p] || FS[p + '\\']; if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return e.real; };
const stat = (p) => { const e = Object.values(FS).find((x) => x.real === p); if (!e) throw new Error('ENOENT'); return { isDirectory: () => e.kind === 'dir', isFile: () => e.kind === 'file' }; };
const PAGE = `${BRIDGE}/?embed=1&lang=vi&local=open`; // the board guest's own URL (webContents.getURL())
const decide = (url, o = {}) => decideBoardOpen(url, { bridgeOrigin: BRIDGE, ownerAdmin: true, openerUrl: PAGE, realpath, stat, ...o });

// ---- opened ----
for (const [p, kind] of [[`${R0}t31/QC-CUOI-ANH.md`, 'file'], [`${R0}l01/visual-0910/contact-sheet.png`, 'file'], [`${R0}c52/MORNING-0910/`, 'folder'], [`${R0}c52/MORNING-0910/index.html`, 'file'], [`${W1}F-04\\clip.webm`, 'file']]) {
  const d = decide(req({ path: p }));
  check(`open ${p} -> openPath (${kind})`, d.action === 'openPath' && d.kind === kind, d);
}
for (const u of ['http://127.0.0.1:4320/', 'http://127.0.0.1:4331/?f=chua-xem', 'https://board.example.org/zumia/', 'https://board.example.org/zumia/media/1e5adae4e344eb00.png']) {
  const d = decide(req({ url: u }));
  check(`open ${u} -> openExternal`, d.action === 'openExternal' && d.url === new URL(u).href, d);
}
// localhost: the page shows it as a loopback chip (Laneboard LOOPBACK accepts 127.0.0.1 and localhost), so main opens it
// too -- as 127.0.0.1, never through the hosts file.
for (const [u, want] of [['http://localhost:4320/', 'http://127.0.0.1:4320/'], ['http://LOCALHOST:4331/x?y=1', 'http://127.0.0.1:4331/x?y=1']]) {
  const d = decide(req({ url: u }));
  check(`open ${u} -> openExternal ${want}`, d.action === 'openExternal' && d.url === want, d);
}

// ---- refused ----
const refused = [
  ['junction out of the allowed folders', { path: `${R0}f04/homepage/index.html` }, 'outside_allowed_folders'],
  ['".." out of the allowed folders', { path: `${R0}../TOOL/x.md` }, 'outside_allowed_folders'],
  ['a script in an allowed folder (.mjs)', { path: `${R0}board/cos-board.mjs` }, 'type_not_allowed'],
  ['a .cmd in an allowed folder', { path: `${R0}x/run.cmd` }, 'type_not_allowed'],
  ['a .lnk dressed as .md', { path: `${R0}x/a.md.lnk` }, 'type_not_allowed'],
  ['outside the folders (a sibling TOOL folder)', { path: `${RK}TOOL/secret.md` }, 'outside_allowed_folders'],
  ['the secrets file', { path: SECRETS }, 'outside_allowed_folders'],
  ['a look-alike folder (<root>-evil)', { path: `${R0.slice(0, -1)}-evil/a.md` }, 'outside_allowed_folders'],
  ['a missing file', { path: `${R0}nope.md` }, 'not_found'],
  ['a relative path', { path: 't31/QC-CUOI-ANH.md' }, 'not_an_absolute_drive_path'],
  ['a UNC path', { path: '\\\\server\\share\\a.md' }, 'not_an_absolute_drive_path'],
  ['a NUL byte', { path: `${R0}t31/QC-CUOI-ANH.md\0.exe` }, 'not_an_absolute_drive_path'],
  ['an ADS dressed as .md (run.cmd:x.md, review 10-11)', { path: `${R0}x/run.cmd:x.md` }, 'name_trick'],
  ['an ADS with its type (run.cmd:x.md:$DATA)', { path: `${R0}x/run.cmd:x.md:$DATA` }, 'name_trick'],
  ['the main stream spelled out (QC-CUOI-ANH.md::$DATA)', { path: `${R0}t31/QC-CUOI-ANH.md::$DATA` }, 'name_trick'],
  ['a second drive colon (<root>C:/x.md)', { path: `${R0}C:/x.md` }, 'name_trick'],
  ['a trailing dot (run.cmd.)', { path: `${R0}x/run.cmd.` }, 'name_trick'],
  ['a trailing space (QC-CUOI-ANH.md )', { path: `${R0}t31/QC-CUOI-ANH.md ` }, 'name_trick'],
  ['a folder part with a trailing dot (<root>./)', { path: `${R0.slice(0, -1)}./t31/QC-CUOI-ANH.md` }, 'name_trick'],
  ['a folder part with a trailing space (t31 \\)', { path: `${W0}t31 \\QC-CUOI-ANH.md` }, 'name_trick'],
  ['the resolver answers with a stream path', { path: `${R0}x/short.md` }, 'name_trick'],
  ['the resolver answers with a trailing-dot folder', { path: `${R0}x/short2.md` }, 'name_trick'],
  ['localhost over https (only http)', { url: 'https://localhost:4320/' }, 'url_not_allowed'],
  ['[::1] (the page does not treat it as loopback)', { url: 'http://[::1]:4320/' }, 'url_idn_host'],
  ['https on loopback (only http)', { url: 'https://127.0.0.1:4320/' }, 'url_not_allowed'],
  ['userinfo trick (host is evil.example)', { url: 'http://127.0.0.1@evil.example/' }, 'url_has_credentials'],
  ['credentials in the URL', { url: 'https://kei:pw@board.example.org/zumia/' }, 'url_has_credentials'],
  ['file: URL', { url: 'file:///C:/Windows/System32/calc.exe' }, 'url_not_allowed'],
  ['javascript: URL', { url: 'javascript:alert(1)' }, 'url_not_allowed'],
  ['data: URL', { url: 'data:text/html,<script>alert(1)</script>' }, 'url_not_allowed'],
  ['a custom scheme (zumi:)', { url: 'zumi://open?x=1' }, 'url_not_allowed'],
  ['an IP literal (LAN router)', { url: 'http://192.168.1.1/' }, 'url_not_allowed'],
  ['a .local host', { url: 'http://printer.local/' }, 'url_not_allowed'],
  ['both path and url', { path: `${R0}t31/QC-CUOI-ANH.md`, url: 'http://127.0.0.1:1/' }, 'bad_request'],
  ['an unknown parameter', { cmd: 'calc' }, 'bad_request'],
];
for (const [name, q, reason] of refused) {
  const d = decide(req(q));
  check(`refuse: ${name} (${reason})`, d.action === 'refuse' && d.reason === reason, d);
}
check('refuse in the release build (ownerAdmin false), even an allowed file', decide(req({ path: `${R0}t31/QC-CUOI-ANH.md` }), { ownerAdmin: false }).reason === 'not_owner_build');
for (const [name, openerUrl] of [['another origin', 'http://127.0.0.1:9999/'], ['a look-alike origin prefix', `${BRIDGE}9/`], ['no URL', undefined], ['about:blank', 'about:blank'], ['the bare origin without a slash', BRIDGE]]) {
  const d = decide(req({ path: `${R0}t31/QC-CUOI-ANH.md` }), { openerUrl });
  check(`refuse: the asking page is not on the bridge origin (${name})`, d.action === 'refuse' && d.reason === 'opener_not_on_bridge', d);
}
// ---- roots by flavour (P0 scrub): the owner build keeps exactly OPEN_ROOTS; a public build only its app data dir ----
{
  const appData = path.join(os.tmpdir(), 'zumi-app-data');
  const fwd = `${appData.split(path.sep).join('/')}/`;
  check('roots: the owner build keeps exactly OPEN_ROOTS', JSON.stringify(openRoots(true, appData)) === JSON.stringify(OPEN_ROOTS) && openRoots(true) === OPEN_ROOTS, openRoots(true, appData));
  for (const r of OPEN_ROOTS) {
    const p = `${r}t/a.md`;
    const d = decideLocalPath(p, { ownerAdmin: true, realpath: () => p.split('/').join('\\'), stat: () => ({ isDirectory: () => false, isFile: () => true }) });
    check(`roots: owner open-path still allows ${r}…`, d.action === 'openPath' && d.kind === 'file', d);
  }
  const pub = openRoots(false, appData);
  check('roots: a public build has only the app data dir', JSON.stringify(pub) === JSON.stringify([fwd]), pub);
  check('roots: a public build reaches no owner root', OPEN_ROOTS.every((r) => !pub.some((x) => `${r}t/a.md`.toLowerCase().startsWith(x.toLowerCase()))), pub);
  check('roots: a sibling -evil dir is not the app data dir', !pub.some((x) => `${fwd.slice(0, -1)}-evil/a.md`.toLowerCase().startsWith(x.toLowerCase())), pub);
  check('roots: a public build that names no app data dir has no root', openRoots(false).length === 0 && openRoots('yes').length === 0);
  check('roots: a public build is still refused before any root', decideLocalPath(`${fwd}a.md`, { ownerAdmin: false, appDataDir: appData }).reason === 'not_owner_build');
}
check('refuse when ownerAdmin is truthy but not true', decide(req({ path: `${R0}t31/QC-CUOI-ANH.md` }), { ownerAdmin: 'yes' }).reason === 'not_owner_build');

// ---- decideExternalUrl: the one rule main.js applies to every link the Board tab opens (the same in every build) ----
// 0.2.5 (CoS decision 20-10): no host allowlist; any plain http/https web page opens; the rejections below stay.
for (const [u, want] of [['http://127.0.0.1:4320/', 'http://127.0.0.1:4320/'], ['http://localhost:4320/a?b=1', 'http://127.0.0.1:4320/a?b=1'], ['https://board.example.org/zumia/', 'https://board.example.org/zumia/'], ['HTTPS://BOARD.EXAMPLE.ORG/zumia/x', 'https://board.example.org/zumia/x'],
  ['https://board.example.org/zumia/#/task/T-31', 'https://board.example.org/zumia/#/task/T-31'], ['https://zumia.space/pricing?x=1', 'https://zumia.space/pricing?x=1'], ['https://quaternius.com/packs/x.html', 'https://quaternius.com/packs/x.html'],
  ['https://shopee.vn/product/1/2', 'https://shopee.vn/product/1/2'], ['https://shopee.vn/Ao-thun-i.123.456?sp_atk=x#top', 'https://shopee.vn/Ao-thun-i.123.456?sp_atk=x#top'], ['https://s.shopee.vn/AbCd', 'https://s.shopee.vn/AbCd'], ['HTTPS://Shopee.VN/x', 'https://shopee.vn/x'],
  ['http://example.com/', 'http://example.com/'], ['https://example.com:8443/a', 'https://example.com:8443/a'], ['https://www.claude.ai/', 'https://www.claude.ai/'], ['https://claude.ai/artifact/x', 'https://claude.ai/artifact/x'], ['https://github.com/zumia-space', 'https://github.com/zumia-space'],
  ['https://docs.google.com/spreadsheets/d/1abc/edit?gid=1#gid=1', 'https://docs.google.com/spreadsheets/d/1abc/edit?gid=1#gid=1'], ['https://crm.orvik.example/x', 'https://crm.orvik.example/x'], ['https://board.example.org/other/', 'https://board.example.org/other/']]) {
  const d = decideExternalUrl(u);
  check(`external: ${u} -> openExternal ${want}`, d.action === 'openExternal' && d.url === want, d);
  const viaBridge = decide(req({ url: u }));
  check(`external: /__zumi-open?url=${u} (owner build bridge) -> openExternal`, viaBridge.action === 'openExternal' && viaBridge.url === want, viaBridge);
}
for (const [u, reason] of [['https://claude.ai@evil.example/', 'url_has_credentials'], ['https://claude.ai:x@evil.example/', 'url_has_credentials'], ['https://u:p@board.example.org/', 'url_has_credentials'], ['http://user:pass@shopee.vn/', 'url_has_credentials'], ['http://127.0.0.1@evil.example/', 'url_has_credentials'],
  ['https://cl\u0430ude.ai/', 'url_idn_host'], ['https://xn--clude-6ve.ai/', 'url_idn_host'], ['https://xn--80ak6aa92e.claude.ai/', 'url_idn_host'], ['https://[fe80::1]/', 'url_idn_host'], ['http://[::1]:4320/', 'url_idn_host'],
  ['https://claude.ai./', 'url_not_allowed'], ['https://shopee.vn./', 'url_not_allowed'],
  ['ftp://github.com/', 'url_not_allowed'], ['file:///C:/Windows/System32/calc.exe', 'url_not_allowed'], ['javascript:alert(1)', 'url_not_allowed'], ['data:text/html,<script>alert(1)</script>', 'url_not_allowed'], ['zumi://open?x=1', 'url_not_allowed'], ['mailto:a@b.co', 'url_not_allowed'], ['blob:https://shopee.vn/x', 'url_not_allowed'], ['view-source:https://shopee.vn/', 'url_not_allowed'],
  ['http://192.168.1.1/', 'url_not_allowed'], ['https://10.0.0.5:8080/', 'url_not_allowed'], ['https://8.8.8.8/', 'url_not_allowed'], ['https://127.0.0.1:4320/', 'url_not_allowed'], ['https://0x7f.1/', 'url_not_allowed'], ['https://2130706433/', 'url_not_allowed'],
  ['https://localhost:4320/', 'url_not_allowed'], ['https://intranet/', 'url_not_allowed'], ['http://printer.local/', 'url_not_allowed'], ['https://a.localhost/', 'url_not_allowed'], ['https://nas.lan/', 'url_not_allowed'], ['https://router.home.arpa/', 'url_not_allowed'], ['https://db.internal/', 'url_not_allowed'],
  ['not a url', 'bad_url'], ['', 'bad_url']]) {
  const d = decideExternalUrl(u);
  check(`external: refuse ${u} (${reason})`, d.action === 'refuse' && d.reason === reason, d);
}

// ---- talk:openSource (review v7 nit): a Look up source link goes through decideExternalUrl's `cited` channel ----
{
  const cited = new Set(['https://localhost./x', 'https://news.example.org./a', 'https://a.localhost/x', 'https://en.wikipedia.org/wiki/Hanoi', 'https://news.example.org/a?b=1', 'http://plain.example.org/', 'https://127.0.0.1/x', 'https://localhost/x', 'https://8.8.8.8/x', 'https://xn--clude-6ve.ai/', 'https://site.example:8443/', 'https://u:p@site.example/']);
  for (const u of ['https://en.wikipedia.org/wiki/Hanoi', 'https://news.example.org/a?b=1']) {
    const d = decideExternalUrl(u, { cited });
    check(`openSource: a cited https source opens (${u})`, d.action === 'openExternal' && d.url === u, d);
  }
  for (const [u, reason] of [['https://en.wikipedia.org/wiki/Saigon', 'url_not_cited'], ['https://evil.example/', 'url_not_cited'], ['http://plain.example.org/', 'url_not_allowed'],
    ['https://127.0.0.1/x', 'url_not_allowed'], ['https://localhost/x', 'url_not_allowed'], ['https://localhost./x', 'url_not_allowed'], ['https://news.example.org./a', 'url_not_allowed'], ['https://a.localhost/x', 'url_not_allowed'], ['https://8.8.8.8/x', 'url_not_allowed'], ['https://xn--clude-6ve.ai/', 'url_idn_host'], ['https://site.example:8443/', 'url_not_allowed'],
    ['https://u:p@site.example/', 'url_has_credentials'], ['http://127.0.0.1:4320/', 'url_not_cited'], ['javascript:alert(1)', 'url_not_cited'], ['not a url', 'bad_url']]) {
    const d = decideExternalUrl(u, { cited });
    check(`openSource: refuse ${u} (${reason})`, d.action === 'refuse' && d.reason === reason, d);
  }
  check('openSource: an ordinary web page is still refused when it was not cited (the cited set is the only gate)', decideExternalUrl('https://zumia.space/', { cited }).reason === 'url_not_cited');
  check('openSource: cited must be a Set (an array is refused)', decideExternalUrl('https://en.wikipedia.org/wiki/Hanoi', { cited: ['https://en.wikipedia.org/wiki/Hanoi'] }).reason === 'url_not_cited');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('talk:openSource'"), main.indexOf('});', main.indexOf("ipcMain.handle('talk:openSource'")));
  check('main.js talk:openSource decides with decideExternalUrlFn(url, { cited: citedUrls }), logs refusals, and opens only d.url', /decideExternalUrlFn\(url, \{ cited: citedUrls \}\)/.test(handler) && /logRefusal\(d\)/.test(handler) && /shell\.openExternal\(d\.url\)/.test(handler) && !/shell\.openExternal\(url\)/.test(handler), handler.slice(0, 400));
}

// ---- main.js's guest link handlers, run for real against fakes (the block is cut out of the source) ----
// A link opens only when it was asked by THE Board tab guest on its own board origin (top-level page, and the asking frame when
// Electron names one); the new window is always denied and an outside navigation is always prevented. Both builds.
{
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const start = main.indexOf("if (contents.getType() === 'webview') {");
  const end = main.indexOf('// ---------- IPC ----------');
  const block = main.slice(start, end).replace(/\}\s*\}\);\s*$/, '}');
  const OTHER = 'https://evil.example/page';
  const rig = ({ ownerAdmin, contentsId = 7, guestId = 7, pageUrl = `${BRIDGE}/?embed=1`, noGuest = false }) => {
    const opened = [], logged = [], handlers = {};
    const contents = { id: contentsId, getType: () => 'webview', getURL: () => pageUrl, setWindowOpenHandler: (f) => { handlers.open = f; }, on: (ev, f) => { handlers[ev] = f; } };
    const shell = { openExternal: (u) => opened.push(u), openPath: () => Promise.resolve('') };
    new Function('contents', 'boardGuest', 'decideBoardOpenFn', 'decideExternalUrlFn', 'liveBridgeOrigin', 'OWNER_ADMIN', 'shell', 'logRefusal', 'inBoard', 'inWardrobe', 'console', block)(
      contents, noGuest ? null : { id: guestId }, decideBoardOpen, decideExternalUrl, BRIDGE, ownerAdmin, shell, (d) => logged.push(d.reason), (u) => u.startsWith(BRIDGE + '/'), () => false, { warn() {} });
    return { opened, logged, handlers };
  };
  const nav = (r, url, frame) => { let prevented = 0; r.handlers['will-navigate']({ preventDefault: () => prevented++, frame }, url); return prevented; };
  for (const ownerAdmin of [true, false]) {
    const tag = ownerAdmin ? 'owner build' : 'release build';
    const o = rig({ ownerAdmin });
    const w = o.handlers.open({ url: 'https://shopee.vn/product/1/2', frame: { url: `${BRIDGE}/?embed=1` } });
    check(`${tag}: window.open / target=_blank from the Board tab to an https link -> shell.openExternal(url), new window denied`, o.opened.length === 1 && o.opened[0] === 'https://shopee.vn/product/1/2' && w.action === 'deny', { opened: o.opened, w });
    const w2 = o.handlers.open({ url: 'https://shopee.vn/product/3' });
    check(`${tag}: the same without a frame in the details (older Electron shape) -> opens, denied`, o.opened.length === 2 && w2.action === 'deny', o.opened);
    check(`${tag}: will-navigate to an outside https link: navigation prevented AND the link opened in the browser`, nav(o, 'https://shopee.vn/x', { url: `${BRIDGE}/?embed=1` }) === 1 && o.opened[2] === 'https://shopee.vn/x', o.opened);
    const before = o.opened.length;
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,x', 'zumi://open', 'http://user:pass@shopee.vn/', 'http://192.168.1.1/', 'https://xn--clude-6ve.ai/', 'https://printer.local/']) {
      const r = o.handlers.open({ url: bad });
      const prevented = nav(o, bad);
      check(`${tag}: ${bad} -> nothing opened, new window denied, navigation prevented`, r.action === 'deny' && prevented === 1 && o.opened.length === before, { r, prevented, opened: o.opened });
    }
    check(`${tag}: every refused link was logged (open + navigate each)`, o.logged.length === 16, o.logged);
    const own = o.handlers.open({ url: `${BRIDGE}/some/page` });
    check(`${tag}: a link on the board's own origin opens nothing (stays in the page)`, own.action === 'deny' && o.opened.length === before, o.opened);

    // origin check: who asked
    const cases = [
      ['another guest (the wardrobe: contents is not the Board tab guest)', { contentsId: 9 }, undefined],
      ['the Board tab guest after it navigated away from the board origin', { pageUrl: OTHER }, undefined],
      ['no Board tab guest attached yet', { noGuest: true }, undefined],
      ['a foreign iframe inside the board page (frame url not on the board origin)', {}, { url: OTHER }],
      ['an about:blank frame inside the board page', {}, { url: 'about:blank' }],
      ['a look-alike origin (127.0.0.1:51234 prefix)', { pageUrl: `${BRIDGE}9/` }, undefined],
    ];
    for (const [name, opts, frame] of cases) {
      const r = rig({ ownerAdmin, ...opts });
      const win = r.handlers.open({ url: 'https://shopee.vn/product/1/2', frame });
      const prevented = nav(r, 'https://shopee.vn/product/1/2', frame);
      check(`${tag}: open request from ${name} -> denied, nothing opened, navigation prevented, logged opener_not_board_tab`, win.action === 'deny' && prevented === 1 && r.opened.length === 0 && r.logged.length === 2 && r.logged.every((x) => x === 'opener_not_board_tab'), { win, prevented, opened: r.opened, logged: r.logged });
    }
  }
}
// No host allowlist is packed or configured any more (CoS decision 20-10).
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json build.files carries no link-allowlist exclusion any more', !pkg.build.files.some((f) => /link-allowlist/.test(f)), pkg.build.files);
  check('no link-allowlist*.json file is left in src/main', fs.readdirSync(path.join(ROOT, 'src', 'main')).every((f) => !/^link-allowlist/.test(f)));
  check('scripts/builder-selftest.cjs has no link-allowlist file filter and still sets zumiOwnerAdmin', !/link-allowlist/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'builder-selftest.cjs'), 'utf8').replace(/\/\/[^\n]*/g, '')) && fs.readFileSync(path.join(ROOT, 'scripts', 'builder-selftest.cjs'), 'utf8').includes('zumiOwnerAdmin: true'));
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'board-open.mjs'), 'utf8');
  check('board-open.mjs has no host allowlist code left', !/LINK_ALLOWLIST|readLinkList|link-allowlist\.json/.test(src.replace(/\/\/[^\n]*/g, '')));
}

// ---- review v6 C1: every refusal is appended to <userData>/logs/board-open-refusals.log (reason + origin only) ----
{
  const tmp = fs.mkdtempSync(path.join(ROOT, '.check-refusal-log-')); // in this tree (D:), never the OS temp on C:
  const logs = path.join(tmp, 'logs'), file = path.join(logs, REFUSAL_LOG_NAME);
  try {
    const secretUrl = 'https://xn--evil-6ve.example:8443/steal/path?token=SECRET123&session=abc#frag';
    const d = decideExternalUrl(secretUrl);
    check('a refused link with a query string is refused (url_idn_host)', d.action === 'refuse' && d.reason === 'url_idn_host', d);
    const line = appendRefusal(logs, d, { now: new Date('2026-10-11T08:00:00.000Z') });
    const text = fs.readFileSync(file, 'utf8');
    check('a refusal writes one line to logs/board-open-refusals.log', text === `${line}\n` && text.split('\n').filter(Boolean).length === 1, text);
    check('the line is "<ISO time> <reason> <origin>"', line === '2026-10-11T08:00:00.000Z url_idn_host https://xn--evil-6ve.example:8443', line);
    check('the line carries no query string, path, fragment or token', !/[?#]|token|SECRET123|session|steal|frag/.test(text), text);
    const cred = decideExternalUrl('https://kei:pw@board.example.org/zumia/?k=v');
    const l2 = appendRefusal(logs, cred);
    check('a userinfo refusal logs the origin without the userinfo', /url_has_credentials https:\/\/board\.example\.org$/.test(l2) && !/kei|pw|k=v/.test(l2), l2);
    const pathRefusal = decide(req({ path: `${RK}TOOL/secret.md` }));
    const l3 = appendRefusal(logs, pathRefusal);
    check('a path refusal logs the reason only (no local path)', pathRefusal.reason === 'outside_allowed_folders' && / outside_allowed_folders -$/.test(l3) && !/secret|TOOL/.test(l3), { pathRefusal, l3 });
    for (const [v, want] of [['javascript:alert(1)?q=1', 'javascript:'], ['not a url ?token=x', '-'], [undefined, '-'], ['file:///C:/x?y', 'file:'], ['http://127.0.0.1:4320/a?b', 'http://127.0.0.1:4320']]) check(`safeOrigin(${JSON.stringify(v)}) = ${want}`, safeOrigin(v) === want, safeOrigin(v));
    check('an unknown reason shape is written as "unknown"', / unknown -$/.test(appendRefusal(logs, { reason: 'x y\nz' })));
    // cap: past maxBytes the file becomes .1 (one old copy) and a new one starts
    for (let i = 0; i < 40; i++) appendRefusal(logs, { reason: 'url_not_allowed', origin: 'https://example.com/' }, { maxBytes: 512 });
    const size = fs.statSync(file).size, old = fs.existsSync(`${file}.1`) ? fs.statSync(`${file}.1`).size : -1;
    check('the log is capped (<= maxBytes) with exactly one old copy (.1)', size <= 512 && old > 0 && old <= 512 && fs.readdirSync(logs).length === 2, { size, old, files: fs.readdirSync(logs) });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---- not an open request: the caller's usual link rules apply (nothing opened here) ----
for (const [name, url, o] of [
  ['another origin', req({ path: `${R0}t31/QC-CUOI-ANH.md` }, 'http://127.0.0.1:9999'), {}],
  ['not in live mode (no bridge origin)', req({ path: `${R0}t31/QC-CUOI-ANH.md` }), { bridgeOrigin: null }],
  ['another path on the bridge', `${BRIDGE}/api/v1/state`, {}],
  ['a plain web link', 'https://docs.google.com/x', {}],
]) check(`none: ${name}`, decide(url, o).action === 'none');

// ---- the real filesystem on this PC: the file anh's T-31 ask links, and the F-04 junction ----
if (fs.existsSync(`${R0}t31/QC-CUOI-ANH.md`)) {
  const d = decideBoardOpen(req({ path: `${R0}t31/QC-CUOI-ANH.md` }), { bridgeOrigin: BRIDGE, ownerAdmin: true, openerUrl: PAGE });
  check(`real fs: ${R0}t31/QC-CUOI-ANH.md opens`, d.action === 'openPath' && /QC-CUOI-ANH\.md$/.test(d.path), d);
}
if (fs.existsSync(`${R0}f04/homepage`)) {
  const d = decideBoardOpen(req({ path: `${R0}f04/homepage` }), { bridgeOrigin: BRIDGE, ownerAdmin: true, openerUrl: PAGE });
  check(`real fs: the ${R0}f04/homepage junction (target outside) is refused`, d.action === 'refuse' && d.reason === 'outside_allowed_folders', d);
}

// ---- real filesystem: Windows name tricks on files that exist (a scratch folder under an allowed root) ----
// Today these are refused because realpathSync.native does not apply Win32 name trimming and never opens a stream;
// the checks keep that true if the resolver changes. Only D: drive, removed at the end.
if (fs.existsSync(R1.slice(0, -1))) {
  const dir = path.join(R1.slice(0, -1), `_check-board-open-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'notes.md'), '# notes\n');
    fs.writeFileSync(path.join(dir, 'run.cmd'), '@echo off\r\necho should never run\r\n');
    let ads = false;
    try { fs.writeFileSync(path.join(dir, 'notes.md') + ':evil.cmd', '@echo off\r\n'); fs.writeFileSync(path.join(dir, 'run.cmd') + ':x.md', '# a stream\n'); ads = true; } catch { /* not NTFS: the stream cases still must refuse */ }
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'a.md'), '# a\n');
    const fwd = dir.replace(/\\/g, '/');
    const real = (p) => decideBoardOpen(req({ path: p }), { bridgeOrigin: BRIDGE, ownerAdmin: true, openerUrl: PAGE });
    const ok = real(`${fwd}/notes.md`);
    check('real fs (scratch): the plain notes.md opens (control)', ok.action === 'openPath' && /notes\.md$/.test(ok.path), ok);
    check('real fs (scratch): run.cmd itself is refused (type_not_allowed)', real(`${fwd}/run.cmd`).reason === 'type_not_allowed', real(`${fwd}/run.cmd`));
    for (const [name, p] of [
      ['trailing dot (run.cmd.)', `${fwd}/run.cmd.`], ['trailing space (run.cmd )', `${fwd}/run.cmd `], ['trailing dot + space', `${fwd}/run.cmd .`],
      ['trailing dot on an allowed type (notes.md.)', `${fwd}/notes.md.`], ['trailing space on an allowed type', `${fwd}/notes.md `],
      [`ADS notes.md:evil.cmd${ads ? ' (stream exists)' : ''}`, `${fwd}/notes.md:evil.cmd`], ['ADS notes.md:evil.cmd:$DATA', `${fwd}/notes.md:evil.cmd:$DATA`],
      ['ADS run.cmd::$DATA', `${fwd}/run.cmd::$DATA`], [`ADS run.cmd:x.md${ads ? ' (stream exists: the review probe)' : ''}`, `${fwd}/run.cmd:x.md`],
      ['ADS run.cmd:x.md:$DATA', `${fwd}/run.cmd:x.md:$DATA`], ['the main stream notes.md::$DATA', `${fwd}/notes.md::$DATA`],
      ['ADS run.cmd:x.md with backslashes', `${dir.replace(/\//g, '\\')}\\run.cmd:x.md`],
      ['a folder with a trailing dot (sub./a.md)', `${fwd}/sub./a.md`], ['a folder with a trailing space (sub /a.md)', `${fwd}/sub /a.md`],
    ]) {
      const d = real(p);
      check(`real fs (scratch): ${name} is refused (name_trick), nothing opened`, d.action === 'refuse' && d.reason === 'name_trick', d);
    }
    if (ads) { // the stream really resolves: only the name check stands between it and openPath
      let resolved = null; try { resolved = fs.realpathSync.native(path.join(dir, 'run.cmd') + ':x.md'); } catch { /* resolver changed */ }
      check('real fs (scratch): the run.cmd:x.md stream resolves on this PC (so the refusal above is the name check, not luck)', resolved !== null, resolved);
    }
    const sub = real(`${fwd}/sub/a.md`);
    check('real fs (scratch): sub/a.md opens (control for the folder cases)', sub.action === 'openPath' && /a\.md$/.test(sub.path), sub);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  check('real fs (scratch): the scratch folder is gone', !fs.existsSync(dir));
}

const failed = results.filter((x) => !x).length;
console.log(`\n${failed ? 'FAIL' : 'PASS'} check-board-open — ${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
