// T-31 alpha.3 R4: the fixed app links seam (tauri/sidecar/links.mjs) and the hidden "Join Discord" row in Settings > App.
// Plain Node: no Electron, no window, no network, nothing opened. The renderer is built into a scratch dir under out/check-runs.
//
//   node scripts/check-links.mjs
//
//   a. linkVerdict: an unset id refuses link_unset, an unknown id refuses unknown_link, a set https URL opens exactly that href,
//      and a javascript: URL or a URL with userinfo is refused (decideExternalUrl). The table keeps the discord, donate and
//      upgrade ids (R5 reuses the last two).
//   b. links.list answers booleans only, never a URL, both from the module and over the real sidecar stdio protocol; a
//      links.open that reaches the sidecar opens nothing; __host.linkVerdict answers the module's verdict.
//   c. the built renderer bundle and index.html carry no discord.gg / discord.com literal; #join-discord is a button with no
//      href inside a row that starts hidden; the page opens it only through zumi.links.open('discord').
//   d. lib.rs maps links.open to __host.linkVerdict (app_open_target) and its unit test asserts it; the inventory, the
//      generated rpc allow-list and the generated shim carry links.list / links.open; Electron's preload does not.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOutDir } from './lib/check-out-dir.mjs';
import { ownerValue } from '../src/main/owner-values.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stable = (v) => JSON.stringify(v);
const LINKS_FILE = path.join(ROOT, 'tauri', 'sidecar', 'links.mjs');
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
const OUT = checkOutDir('check-links');
const IDS = ['discord', 'donate', 'upgrade'];
const onlyBooleans = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'boolean');

// ---------------------------------------------------------------- a. the verdict
let mod = null;
try { mod = await import(pathToFileURL(LINKS_FILE).href); } catch (e) { console.log(`  links.mjs: ${e.code || e.message}`); }
ok(Boolean(mod && mod.LINKS && typeof mod.linkVerdict === 'function' && typeof mod.linkList === 'function'), 'a. tauri/sidecar/links.mjs exports LINKS, linkVerdict and linkList');
if (mod && mod.LINKS) {
  const { LINKS, linkVerdict, linkList } = mod;
  ok(stable(Object.keys(LINKS).sort()) === stable(IDS), 'a. LINKS carries exactly the discord, donate and upgrade ids', stable(Object.keys(LINKS)));
  ok(Object.isFrozen(LINKS), 'a. LINKS is frozen (the page cannot add an id at runtime)');
  ok(Object.entries(LINKS).every(([id, u]) => typeof u === 'string' && (u === '' || (linkVerdict(id).action === 'openExternal' && /^https:\/\/[^/:@]+\//.test(new URL(u).href)))),
    'a. every shipped value is empty or an https URL on the default port that passes the verdict');
  console.log(`  shipped: ${stable(linkList())} (true = the button shows)`);
  const empty = { discord: '', donate: '', upgrade: '' };
  const set = { ...empty, discord: 'https://discord.gg/x' };
  ok(stable(linkVerdict('discord', empty)) === stable({ action: 'refuse', reason: 'link_unset' }), 'a. discord unset -> refuse link_unset', stable(linkVerdict('discord', empty)));
  ok(stable(linkVerdict('discord', set)) === stable({ action: 'openExternal', url: 'https://discord.gg/x' }), 'a. discord = https://discord.gg/x -> openExternal that href', stable(linkVerdict('discord', set)));
  const js = linkVerdict('discord', { ...empty, discord: 'javascript:alert(1)' });
  ok(js.action === 'refuse', 'a. javascript:alert(1) -> refuse', stable(js));
  const cred = linkVerdict('discord', { ...empty, discord: 'https://user:pw@x' });
  ok(cred.action === 'refuse' && cred.reason === 'url_has_credentials', 'a. https://user:pw@x -> refuse url_has_credentials', stable(cred));
  // The owner/staging hosts are read from the owner-only values file (never spelled in public source). A public tree has
  // no such file, so those cases are skipped there by name, not silently.
  const cloudBase = ownerValue('cloudBase', null);
  const liveOrigin = ownerValue('liveOrigin', null);
  const ownerUrls = cloudBase ? [`${cloudBase}/pricing`, `${cloudBase.toUpperCase().replace('HTTPS://', 'https://')}./pricing`] : [];
  if (liveOrigin) ownerUrls.push(`${liveOrigin}/zumia/`);
  if (!ownerUrls.length) console.log('  SKIP owner/staging host cases: no src/main/owner-values.json in this tree (public)');
  ok(!cloudBase || (mod.OWNER_HOSTS instanceof Set && mod.OWNER_HOSTS.has(new URL(cloudBase).hostname)), 'a. the staging cloud host is on the owner-host refusal list (owner tree)');
  // Review F1 (CoS: https only): a link is https on the default port to a public host; never http, loopback, an IP literal,
  // a .local name or an owner/staging host, whatever decideExternalUrl would allow for board links.
  for (const bad of ['http://x', 'http://discord.gg/x', 'https://127.0.0.1', 'https://localhost', 'https://x.localhost/', 'https://printer.local/', 'https://1.2.3.4/',
    'https://[::1]/', 'https://x:8443', 'https://discord.gg:8443/x', 'http://localhost:8080/', ...ownerUrls]) {
    const d = linkVerdict('discord', { ...empty, discord: bad });
    ok(d.action === 'refuse' && /^link_/.test(d.reason), `a. ${bad} -> refused by the https-only link rule`, stable(d));
  }
  ok(stable(linkVerdict('discord', { ...empty, discord: 'https://discord.gg/x' })) === stable({ action: 'openExternal', url: 'https://discord.gg/x' }), 'a. https://discord.gg/x is still allowed under the https-only rule');
  for (const bad of ['https://evil.example', 'toString', '__proto__', 'Discord', '', null, 7, ['discord']]) {
    const d = linkVerdict(bad, set);
    ok(d.action === 'refuse' && d.reason === 'unknown_link', `a. ${stable(bad)} is not an id -> refuse unknown_link`, stable(d));
  }

  // ---------------------------------------------------------------- b. the list (module)
  ok(onlyBooleans(linkList(empty)) && stable(linkList(empty)) === stable({ discord: false, donate: false, upgrade: false }), 'b. linkList(all empty) -> every id false', stable(linkList(empty)));
  ok(stable(linkList(set)) === stable({ discord: true, donate: false, upgrade: false }), 'b. linkList(discord set) -> discord true only', stable(linkList(set)));
  const badSet = linkList({ ...empty, discord: 'javascript:alert(1)' });
  ok(badSet.discord === false, 'b. a URL the verdict refuses lists as false (no button that cannot open)', stable(badSet));
  ok(onlyBooleans(linkList()) && !/https?:|discord\./.test(stable(linkList(set))), 'b. linkList answers booleans only, never a URL');
}

// ---------------------------------------------------------------- b. over the real sidecar stdio protocol
function startSidecar(dataDir) {
  const child = spawn(process.execPath, [SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  child.stderr.on('data', () => {});
  child.once('exit', (code) => { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`sidecar exited (${code})`)); } pending.clear(); });
  rl.on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; } // a non-JSON stdout line is not a protocol message
    if (m.method === 'ready') readyResolve();
    else if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
  });
  return {
    ready,
    request(method, params = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() { child.stdin.end(); return new Promise((r) => child.on('close', r)); },
  };
}
{
  const dataDir = path.join(OUT, 'sidecar-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const c = startSidecar(dataDir);
  try {
    await c.ready;
    const list = await c.request('links.list');
    ok(!list.error && onlyBooleans(list.result) && stable(Object.keys(list.result).sort()) === stable(IDS), 'b. sidecar links.list -> { discord, donate, upgrade } booleans only', stable(list));
    ok(Boolean(mod) && stable(list.result) === stable(mod.linkList()), 'b. sidecar links.list equals the module table state');
    const open = await c.request('links.open', ['discord']);
    ok(open.result === false, 'b. a links.open that reaches the sidecar opens nothing (Rust intercepts it)', stable(open));
    const v = await c.request('__host.linkVerdict', ['discord']);
    ok(!v.error && Boolean(mod) && stable(v.result) === stable(mod.linkVerdict('discord')), 'b. __host.linkVerdict answers the module verdict for discord', stable(v));
    const vBad = await c.request('__host.linkVerdict', ['https://discord.gg/x']);
    ok(vBad.result && vBad.result.action === 'refuse' && vBad.result.reason === 'unknown_link', 'b. __host.linkVerdict refuses a URL from the page (unknown_link)', stable(vBad));
  } catch (e) {
    ok(false, 'b. sidecar rpc round-trip', String((e && e.message) || e));
  } finally {
    await c.close();
  }
}

// ---------------------------------------------------------------- c. the renderer
const DISCORD_LITERAL = /discord\.(gg|com)/i;
const buildOut = path.join(OUT, 'renderer');
let built = false;
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.mjs')], { cwd: ROOT, env: { ...process.env, ZUMI_RENDERER_OUT: buildOut }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  built = true;
} catch (e) { console.log(`  build-renderer: ${(e && e.message) || e}`); }
ok(built, 'c. the renderer builds into the scratch dir');
if (built) {
  const js = fs.readFileSync(path.join(buildOut, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(buildOut, 'index.html'), 'utf8');
  ok(!DISCORD_LITERAL.test(js), 'c. the built app.js carries no discord.gg / discord.com literal');
  ok(!DISCORD_LITERAL.test(html), 'c. the built index.html carries no discord.gg / discord.com literal');
  const btn = (html.match(/<[a-z]+\b[^>]*\bid="join-discord"[^>]*>/) || [''])[0];
  ok(/^<button\b/.test(btn) && /type="button"/.test(btn) && !/\bhref\s*=/.test(btn), 'c. #join-discord is a type=button with no href', btn);
  const row = (html.match(/<div\b[^>]*\bid="join-discord-row"[^>]*>/) || [''])[0];
  ok(/\bhidden\b/.test(row), 'c. the Join Discord row starts hidden', row);
  const panelApp = html.indexOf('id="stabpanel-app"');
  ok(panelApp >= 0 && html.indexOf('id="join-discord-row"') > panelApp, 'c. the row sits in Settings > App');
  ok(/links\.open\(["']discord["']\)/.test(js) && /links\.list\(\)/.test(js), 'c. the bundle opens it only by id (links.open("discord")) after links.list()');
}
const settingsSrc = read('src', 'renderer', 'settings.js');
const wiring = settingsSrc.slice(settingsSrc.indexOf("$('join-discord-row')"), settingsSrc.indexOf("$('join-discord-row')") + 900);
// alpha.4 scope change (anh 30-10 05:10Z): the row is always shown where zumi.links exists (Tauri); the button stays disabled with the
// "Coming soon" label until links.list() says discord === true. Electron (no zumi.links) still never shows it.
ok(/zumi\.links\.list\(\)/.test(wiring) && /discordRow\.hidden = false;/.test(wiring) && /paintDiscord\(set && set\.discord === true\)/.test(wiring) && /discordBtn\.disabled = !on;/.test(wiring) && /on \? 'settings\.joinDiscord' : 'links\.comingSoon'/.test(wiring),
  'c. alpha.4: settings.js shows the row on a links host; the button is disabled "Coming soon" until links.list() says discord === true');
ok(/zumi\.links\.open\('discord'\)/.test(wiring) && !/window\.open|location|href|https?:/.test(wiring), 'c. the click names the id only: no window.open, no navigation, no URL');
ok(!DISCORD_LITERAL.test(read('src', 'renderer', 'index.html')) && !DISCORD_LITERAL.test(settingsSrc) && !DISCORD_LITERAL.test(read('src', 'renderer', 'i18n.js')), 'c. no discord.gg / discord.com literal in index.html, settings.js or i18n.js');

// ---------------------------------------------------------------- d. the host mapping and the generated surfaces
const lib = read('tauri', 'src-tauri', 'src', 'lib.rs');
const fnBody = (lib.match(/fn app_open_target\(method: &str\) -> Option<&'static str> \{([\s\S]*?)\n\}/) || ['', ''])[1];
ok(/"links\.open" => Some\("__host\.linkVerdict"\)/.test(fnBody), 'd. lib.rs app_open_target maps "links.open" -> "__host.linkVerdict"');
ok(!/"links\.list"/.test(fnBody), 'd. lib.rs does not intercept links.list (an ordinary read)');
ok(/assert_eq!\(app_open_target\("links\.open"\), Some\("__host\.linkVerdict"\)\);/.test(lib), 'd. the lib.rs unit test asserts app_open_target("links.open") == Some("__host.linkVerdict") (cargo test runs it)');
const inv = JSON.parse(read('docs', 'migration', 'api-inventory.json'));
const row = (n) => (inv.apis || []).find((a) => a.name === n);
ok(row('links.list') && row('links.list').kind === 'invoke' && row('links.list').args.length === 0 && row('links.list').tauriOnly === true && !row('links.list').guestOnly, 'd. inventory: links.list invoke, 0 args, tauriOnly, not guestOnly');
ok(row('links.open') && row('links.open').kind === 'invoke' && stable(row('links.open').args) === stable(['id']) && row('links.open').tauriOnly === true && !row('links.open').guestOnly, 'd. inventory: links.open invoke, (id), tauriOnly, not guestOnly');
const allow = read('tauri', 'src-tauri', 'src', 'rpc_allow_list.rs');
ok(/"links\.list"/.test(allow) && /"links\.open"/.test(allow) && !/"__host\.linkVerdict"/.test(allow), 'd. the generated rpc allow-list serves links.list / links.open and never __host.linkVerdict');
const shim = read('tauri', 'shim', 'zumi-shim.js');
ok(/\$invoke\("links\.list", \[\]\)/.test(shim) && /\$invoke\("links\.open", \[id\]\)/.test(shim), 'd. the generated shim exposes zumi.links.list() / zumi.links.open(id)');
ok(!/links[.:]/.test(read('src', 'main', 'preload.js')), 'd. Electron preload has no links surface (src/main frozen; the renderer feature-detects zumi.links)');
const sidecarMain = read('tauri', 'sidecar', 'main.mjs');
ok(/'__host\.linkVerdict': \(id\) => \{\s*const d = linkVerdict\(id\);/.test(sidecarMain), 'd. main.mjs __host.linkVerdict delegates to linkVerdict(id)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
