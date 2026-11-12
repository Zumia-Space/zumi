// MKT phase 2 goal check on a BUILT app (not installed: the exe runs from an extracted folder with its own --data-dir).
// FABLE-MARKET.md phase 2: canary in-scope calls pass 10/10; out-of-scope attempts refused 10/10 with a log line each
// (path escape, another pack's folder, an unlisted link, an https fetch, the main rpc, navigation off the pack); one changed
// byte -> the pack does not load; uninstall -> tab gone, pack folder gone, data folder kept. Plus FABLE-MARKET2: the avatar
// without the permission is a 404 (in the canary), and a public build with no pack shows no extra tab.
//   node scripts/pack-canary-run.mjs --app <folder with the exe> --exe <name.exe> --run <empty run folder> --key <store.key>
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, findPorts, sleep, targets, waitTarget } from './lib/cdp-lite.mjs';
import { packDirZip } from './market-pack-dir.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const app = opt('app'), exe = opt('exe'), run = opt('run'), key = opt('key');
const ROUNDS = Number(opt('rounds') || 10);
if (!app || !exe || !run || !key) { console.error('usage: --app <dir> --exe <name.exe> --run <dir> --key <store.key>'); process.exit(2); }
fs.mkdirSync(run, { recursive: true });
let pass = 0, fail = 0;
const lines = [];
const ok = (c, name, detail = '') => { const l = `${c ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`; lines.push(l); console.log(l); if (c) pass++; else fail++; };
const cli = (...a) => execFileSync(process.execPath, [path.join(repo, 'scripts', 'market-store-cli.mjs'), ...a], { encoding: 'utf8' }).trim();
const ID = 'plugin.canary';
const BROWSER_ARGS = '--remote-debugging-port=0 --disable-features=msWebOOUI,msPdfOOUI,CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --autoplay-policy=no-user-gesture-required';

function launch(data, extra = []) {
  const child = spawn(path.join(app, exe), ['--data-dir', data, '--pack-links-dry', ...extra], {
    cwd: app, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: BROWSER_ARGS },
  });
  return child;
}
function kill(child) {
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
}
async function mainPage(data) {
  const { target } = await waitTarget(data, /^http:\/\/tauri\.localhost\//, 90000);
  return connect(target.webSocketDebuggerUrl);
}
async function waitFor(page, expr, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await page.evaluate(expr).catch(() => false)) return true; await sleep(300); }
  return false;
}
const tabSel = `.tab[data-tab="pack-${ID}"]`;
const log = (data) => { try { return fs.readFileSync(path.join(data, 'logs', 'pack-host.log'), 'utf8'); } catch { return ''; } };
async function guestTargets(data) {
  const out = [];
  for (const { port } of findPorts(data)) { try { out.push(...(await targets(port)).filter((t) => /zumipack\.localhost/.test(t.url))); } catch { /* stale */ } }
  return out;
}

// ---------- a test store with the canary, signed with the store key; installed through the signed index ----------
const store = path.join(run, 'store');
const canaryZip = path.join(run, `${ID}-1.0.0.zip`);
fs.writeFileSync(canaryZip, packDirZip(path.join(repo, 'scripts', 'fixtures', 'market', ID)));
console.log(cli('publish', '--store', store, '--key', key, canaryZip));
const data = path.join(run, 'data');
console.log(cli('install', '--store', store, '--data', data, ID));

// ---------- 1. in-scope 10/10, refusals 10/10 ----------
let child = launch(data);
const evidence = { rounds: [], network: [], navigation: [] };
try {
  const page = await mainPage(data);
  ok(await waitFor(page, `!!document.querySelector('${tabSel}')`), 'the canary pack has a tab in the sidebar');
  await page.evaluate(`document.querySelector('${tabSel}').click(), true`);
  const { target } = await waitTarget(data, /^http:\/\/zumipack\.localhost\/plugin\.canary\/ui\/index\.html/, 30000);
  const guest = await connect(target.webSocketDebuggerUrl);
  await guest.send('Network.enable');
  guest.on((m) => {
    if (m.method === 'Network.requestWillBeSent') evidence.network.push({ url: m.params.request.url.split('?')[0], type: m.params.type });
    if (m.method === 'Network.loadingFailed') evidence.network.push({ failed: m.params.errorText, blocked: m.params.blockedReason || null });
  });
  const tally = new Map();
  for (let i = 0; i < ROUNDS; i++) {
    await guest.send('Page.reload', { ignoreCache: true });
    await sleep(800);
    const res = await guest.evaluate('(async () => { for (let i = 0; i < 100 && !window.__canary; i++) await new Promise((r) => setTimeout(r, 100)); return window.__canary; })()');
    evidence.rounds.push(res);
    for (const r of res.results) { const t = tally.get(r.name) || { pass: 0, n: 0, detail: '' }; t.n++; if (r.pass) t.pass++; else t.detail = r.detail; tally.set(r.name, t); }
  }
  for (const [name, t] of tally) ok(t.pass === ROUNDS && t.n === ROUNDS, `${name}: ${t.pass}/${ROUNDS}`, t.detail);
  let stayed = 0;
  for (let i = 0; i < ROUNDS; i++) {
    await guest.evaluate("location.assign('https://example.com/'); true").catch(() => null);
    await sleep(1200);
    const href = await guest.evaluate('location.href').catch(() => 'gone');
    evidence.navigation.push(href);
    if (href.startsWith('http://zumipack.localhost/plugin.canary/')) stayed++;
  }
  ok(stayed === ROUNDS, `refused: navigation off the pack ${stayed}/${ROUNDS}`);
  const text = log(data);
  const count = (re) => (text.match(re) || []).length;
  ok(count(/refused path_escape pack=plugin\.canary/g) >= 2 * ROUNDS, `log: path escape refusals ${count(/refused path_escape pack=plugin\.canary/g)} lines`);
  ok(count(/refused (other_pack|unlisted_file|request) pack=plugin\.canary/g) >= ROUNDS, `log: another pack's folder ${count(/refused (other_pack|unlisted_file|request) pack=plugin\.canary/g)} lines`);
  ok(count(/refused link_unlisted pack=plugin\.canary/g) >= ROUNDS, `log: unlisted link ${count(/refused link_unlisted pack=plugin\.canary/g)} lines`);
  ok(count(/refused (request|csp [a-z-]+) pack=plugin\.canary origin=https:\/\/example\.com/g) >= ROUNDS, `log: https fetch ${count(/refused (request|csp [a-z-]+) pack=plugin\.canary origin=https:\/\/example\.com/g)} lines`);
  ok(count(/refused (request|csp [a-z-]+) pack=plugin\.canary origin=http:\/\/ipc\.localhost/g) >= ROUNDS, `log: main rpc over ipc.localhost ${count(/refused (request|csp [a-z-]+) pack=plugin\.canary origin=http:\/\/ipc\.localhost/g)} lines`);
  ok(count(/refused navigation off the pack/g) >= ROUNDS, `log: navigation off the pack ${count(/refused navigation off the pack/g)} lines`);
  ok(count(/refused avatar pack=plugin\.canary \(no avatar permission\)/g) >= ROUNDS, `log: avatar without permission ${count(/refused avatar pack=plugin\.canary/g)} lines`);
  ok(count(/links\.open dry run/g) >= ROUNDS, `log: the declared link went to the opener ${count(/links\.open dry run/g)} times (dry run)`);
  const outside = evidence.network.filter((n) => n.url && !n.url.startsWith('http://zumipack.localhost/plugin.canary/') && !n.url.startsWith('data:'));
  evidence.outside = outside;
  // The browser asks for /favicon.ico on its own; it is off the pack prefix, so it is refused like the planted attempts.
  ok(outside.every((n) => /example\.com|ipc\.localhost|zumipack\.localhost\/plugin\.other|zumipack\.localhost\/favicon\.ico$/.test(n.url)), "every request off the pack was a planted attempt or the browser's own favicon request (all refused)", JSON.stringify([...new Set(outside.map((n) => n.url))]));
  guest.close(); page.close();
} finally { kill(child); await sleep(2500); }

// ---------- 2. one changed byte: the pack does not load ----------
const js = path.join(data, 'packs', ID, 'ui', 'canary.js');
const original = fs.readFileSync(js);
const changed = Buffer.from(original); changed[10] ^= 1; fs.writeFileSync(js, changed);
child = launch(data);
try {
  const page = await mainPage(data);
  await waitFor(page, `!!document.querySelector('${tabSel}')`);
  await page.evaluate(`document.querySelector('${tabSel}').click(), true`);
  await sleep(6000);
  const guests = await guestTargets(data);
  ok(guests.length === 0, 'one changed byte: no pack page loads', JSON.stringify(guests.map((g) => g.url)));
  ok(/refused open files_sha pack=plugin\.canary/.test(log(data)), 'one changed byte: log names files_sha');
  page.close();
} finally { kill(child); await sleep(2500); }
fs.writeFileSync(js, original);

// ---------- 3. uninstall: tab gone, pack folder gone, data folder kept ----------
child = launch(data);
try {
  const page = await mainPage(data);
  await waitFor(page, `!!document.querySelector('${tabSel}')`);
  await page.evaluate(`document.querySelector('${tabSel}').click(), true`);
  await waitTarget(data, /^http:\/\/zumipack\.localhost\/plugin\.canary\//, 30000);
  // Give the canary a file in its data folder, then remove the pack.
  fs.mkdirSync(path.join(data, 'plugin-data', ID), { recursive: true });
  fs.writeFileSync(path.join(data, 'plugin-data', ID, 'keep.txt'), 'kept');
  console.log(cli('remove', '--data', data, ID));
  const gone = await waitFor(page, `!document.querySelector('${tabSel}') && !document.querySelector('#tab-pack-${ID.replace('.', '\\\\.')}')`, 15000);
  ok(gone, 'uninstall: the tab and its panel are gone');
  await sleep(1500);
  ok((await guestTargets(data)).length === 0, 'uninstall: the pack page is closed');
  ok(!fs.existsSync(path.join(data, 'packs', ID)), 'uninstall: the pack folder is gone');
  ok(fs.readFileSync(path.join(data, 'plugin-data', ID, 'keep.txt'), 'utf8') === 'kept', 'uninstall: the data folder is kept');
  page.close();
} finally { kill(child); await sleep(2500); }

// ---------- 4. a build with no pack: no extra tab; --pack-dir is owner-only ----------
const empty = path.join(run, 'data-empty');
child = launch(empty, opt('owner') ? [] : ['--pack-dir', path.join(repo, 'tauri', 'src-tauri', 'tests-fixtures', 'pack', ID)]);
try {
  const page = await mainPage(empty);
  await waitFor(page, "document.readyState === 'complete' && !!document.querySelector('.tab[data-tab=\"market\"]')");
  await sleep(7000); // more than one pack_list refresh
  const n = await page.evaluate("document.querySelectorAll('.pack-tab').length");
  ok(n === 0, `no pack installed${opt('owner') ? '' : ' (and --pack-dir given to a public build)'}: no extra tab`, `pack tabs: ${n}`);
  page.close();
} finally { kill(child); await sleep(2000); }

fs.writeFileSync(path.join(run, 'canary-evidence.json'), JSON.stringify(evidence, null, 1));
fs.writeFileSync(path.join(run, 'canary-result.txt'), `${lines.join('\n')}\n${pass} passed, ${fail} failed\n--- pack-host.log ---\n${log(data)}`);
console.log(`pack-canary-run: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
