#!/usr/bin/env node
// "Boots without next/" gate (ADR 2026-10-27-next-version-path-flag, T-31 slice 1 gate item 2). The next-version UI lives in
// src/renderer/next/** (+ src/next-tokens/) and is built in only when ZUMI_NEXT_UI is on. This check copies the renderer sources
// into a scratch root, DELETES next/ and next-tokens/ there, builds with ZUMI_NEXT_UI=0 (the old UI; the default is ON since 28-10) and loads the built
// index.html in Chromium with a stub of the preload bridge:
//   - no failed request, console error or page error (a dangling <link href="next/..."> is a 404 and fails here);
//   - no Devices item, no #tab-devices, no next/ link, no zumi-next class on <html>;
//   - no Skills item, no #tab-skills / #next-skills-head / #next-skills-tree, and no Skills code (initSkills, createProgressStore, zumi.progress,
//     next-skills, nx-skills, skills/page) in the built app.js of the OFF copy and of the sources-present copy;
//   - the 0.2.11 token values (--background --foreground --primary --muted-foreground --radius): the app looks as before;
//   - the app's own boot path still ran: the version tag is filled from the stubbed bridge and the Settings tab opens.
// Positive control: the same copy WITH next/ built with ZUMI_NEXT_UI=1 must show the Skills item (opening two cards over the stage), the Devices item, the zumi-next class and the
// look A token values (so "no Devices item / old values" is something the probe can tell apart).
// Packager-drop case: a second scratch copy WITH src/renderer/next/ and src/next-tokens/ PRESENT is built with ZUMI_NEXT_UI=0 (OFF);
// build/renderer must hold no next/ dir, no tokens-a.css / theme-a.css anywhere, and index.html no "next/" or "zumi-next". Its
// positive control is the ON copy above (build/renderer/next/tokens-a.css + theme-a.css exist).
// `--inject-hook link|button|section|class` adds one unguarded hook back into the scratch index.html first, to prove the check
// bites (it must then FAIL). `--inject-hook copy` instead patches the scratch build-renderer.mjs of the sources-present copy to
// copy next/ unconditionally (the tree's build-renderer.mjs is never touched).
// `--inject-hook skills` adds a Skills sidebar item to the OFF scratch index.html; `--inject-hook skillscode` adds a Skills code trace to the OFF
// scratch app.js (both must make the check FAIL).
// Default-ON case: a third copy WITH next/ is built with the env var UNSET; it must write {"nextUi":true}, carry next/ and zumi-next
// (red when NEXT_UI_DEFAULT in build-renderer.mjs is false).
//   node scripts/check-next-ui-boots-without-next.mjs [--inject-hook link|button|section|class|copy|skills|skillscode] [--keep]
// Playwright: $ZUMI_PLAYWRIGHT_DIR (default: the owner values' playwrightDir); Chromium: $ZUMI_CHROMIUM (default: the owner values' chromiumExe).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW = process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright');
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');
const args = process.argv.slice(2);
const inject = args.includes('--inject-hook') ? args[args.indexOf('--inject-hook') + 1] : null;
const keep = args.includes('--keep');
const SCRATCH_BASE = ownerPath('scratchRoot', os.tmpdir()); // never drive C on the owner's machines
const { on: LOOK_A, off: V0211 } = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'next-tokens', 'theme-a-tokens.json'), 'utf8'));
const TOKEN_NAMES = ['--background', '--foreground', '--muted-foreground', '--primary'];

if (!fs.existsSync(path.join(PW, 'package.json')) || !fs.existsSync(EXE)) { console.error(`ENV: need playwright at ${PW} and Chromium at ${EXE} (set ZUMI_PLAYWRIGHT_DIR / ZUMI_CHROMIUM)`); process.exit(2); }
const { chromium } = createRequire(import.meta.url)(PW);
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// One scratch root = the files build-renderer.mjs reads (it resolves everything from its own location) + a junction to node_modules.
function makeScratch(tag, withNext) {
  const dir = path.join(SCRATCH_BASE, `next-ui-check-${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const f of ['build-renderer.mjs', 'rig-version.mjs', 'seat-offset.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'src', 'renderer'), path.join(dir, 'src', 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'main'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'main', 'providers.js'), path.join(dir, 'src', 'main', 'providers.js')); // brain-key-card.js imports it
  fs.copyFileSync(path.join(ROOT, 'src', 'main', 'free-key-routes.js'), path.join(dir, 'src', 'main', 'free-key-routes.js')); // free-key-guide.js imports it
  fs.cpSync(path.join(ROOT, 'src', 'next-tokens'), path.join(dir, 'src', 'next-tokens'), { recursive: true });
  if (withNext && fs.existsSync(path.join(ROOT, 'assets', 'pricing'))) fs.cpSync(path.join(ROOT, 'assets', 'pricing'), path.join(dir, 'assets', 'pricing'), { recursive: true }); // the Pricing hero image (alpha.12)
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  if (!withNext) for (const d of [['src', 'renderer', 'next'], ['src', 'next-tokens']]) fs.rmSync(path.join(dir, ...d), { recursive: true, force: true });
  return dir;
}
function build(dir, flag) {
  const env = { ...process.env }; delete env.ZUMI_NEXT_UI; if (flag !== undefined) env.ZUMI_NEXT_UI = flag;
  return execFileSync(process.execPath, [path.join(dir, 'scripts', 'build-renderer.mjs')], { cwd: dir, env, encoding: 'utf8' }).trim();
}
const listFiles = (d, base = d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [`${path.relative(base, path.join(d, e.name))}/`, ...listFiles(path.join(d, e.name), base)] : [path.relative(base, path.join(d, e.name))])) : []).map((x) => x.replace(/\\/g, '/'));
const HOOKS = {
  link: ['<!-- next-ui:head -->', '<link rel="stylesheet" href="next/theme-a.css">'],
  button: ['<div class="spacer"></div>', '<button class="tab" data-tab="devices"><span>Devices</span></button><div class="spacer"></div>'],
  section: ['<section id="tab-settings"', '<section id="tab-devices" class="panel"></section><section id="tab-settings"'],
  class: ['<html lang="en" class="dark">', '<html lang="en" class="dark zumi-next">'],
  skills: ['<div class="spacer"></div>', '<button class="tab" data-next="skills"><span>Skills</span></button><div class="spacer"></div>'],
};
const SKILLS_CODE = /initSkills|createProgressStore|zumi\.progress|next-skills|nx-skills|skills\/page/;

// Static server for a built renderer: its files, plus /tokens.css from the vendored Laneboard (main serves it at app://zumi/tokens.css).
function serve(buildDir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = p === '/tokens.css' ? path.join(ROOT, 'vendor', 'laneboard', 'public', 'tokens.css') : path.join(buildDir, p === '/' ? 'index.html' : p);
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); } // Chromium asks for it on a plain http page; Electron's app:// does not
    if (p !== '/tokens.css' && !path.resolve(file).startsWith(path.resolve(buildDir))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); res.end(buf);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// A stand-in for the preload bridge (window.zumi): enough for main() to run up to the point where the tabs are wired.
function stubScript() {
  const info = { version: '0.0.0-check', packaged: true, disabledViews: [], ownerAdmin: false, boardPartition: 'persist:check', demo: false, selftest: false };
  return `(() => {
    const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => Promise.resolve(deep()) });
    const withFallback = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (k === 'then' ? undefined : deep())) });
    const base = { info: async () => (${JSON.stringify(info)}), listModels: async () => ({ models: [], selected: null }), listClips: async () => [],
      rooms: withFallback({ list: async () => ({ rooms: [], geometry: null }) }), scenes: withFallback({ list: async () => ({ rooms: [], geometry: null, selected: null }) }),
      chairs: withFallback({ list: async () => ({ chairs: [], selected: null }) }), wardrobe: withFallback({ canUndo: async () => false }), ui: withFallback({ getLang: async () => 'en', setLang: async () => {} }) };
    window.zumi = withFallback(base);
  })();`;
}

async function probe(browser, buildDir) {
  const server = await serve(buildDir);
  const page = await browser.newPage({ viewport: { width: 1296, height: 839 } });
  const bad = [];
  page.on('pageerror', (e) => bad.push(`pageerror: ${String(e.message).split('\n')[0]}`));
  page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text().split('\n')[0]}`); });
  page.on('requestfailed', (r) => bad.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`http ${r.status()}: ${r.url()}`); });
  await page.addInitScript(stubScript());
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app-version') && document.getElementById('app-version').textContent.startsWith('v0.0.0'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500); // let the dynamic import / later boot steps settle
  const r = await page.evaluate((names) => {
    const cs = getComputedStyle(document.documentElement);
    return {
      version: document.getElementById('app-version').textContent,
      bootError: ((document.querySelector('body > pre') || {}).textContent || '').split('\n').slice(0, 4).join(' <- '), // app.js main().catch paints the stack here
      htmlClass: document.documentElement.className,
      devicesItem: document.querySelectorAll('.tab[data-next="devices"], .tab[data-tab="devices"]').length,
      devicesText: [...document.querySelectorAll('#sidebar .tab')].some((b) => /devices/i.test(b.textContent)),
      devicesSection: document.querySelectorAll('#tab-devices, #next-devices').length,
      skillsItem: document.querySelectorAll('.tab[data-next="skills"], .tab[data-tab="skills"]').length,
      skillsText: [...document.querySelectorAll('#sidebar .tab')].some((b) => /skills/i.test(b.textContent)),
      skillsSection: document.querySelectorAll('#tab-skills, #next-skills-head, #next-skills-tree').length,
      nextLinks: [...document.querySelectorAll('link[href^="next/"]')].map((l) => l.getAttribute('href')),
      tabs: [...document.querySelectorAll('#sidebar .tab')].map((b) => b.textContent.trim()),
      tokens: Object.fromEntries([...names, '--radius'].map((n) => [n, cs.getPropertyValue(n).trim().toLowerCase()])),
    };
  }, TOKEN_NAMES);
  // the app's own tab wiring (app.js, after the stage and settings init): clicking Settings must open its panel
  // Polled, not a fixed settle: under load the wiring lands after the 1500 ms above, which failed this row at random on alpha.10-12.
  r.settingsOpens = false;
  for (let i = 0; i < 40 && !r.settingsOpens; i++) {
    await page.click('.tab[data-tab="settings"]').catch(() => {});
    r.settingsOpens = await page.evaluate(() => document.getElementById('tab-settings').classList.contains('active'));
    if (!r.settingsOpens) await page.waitForTimeout(500);
  }
  if (await page.$('.tab[data-next="devices"]')) { // ON build only: the Devices card (concept A-1: a card over the stage, not a tab page)
    await page.click('.tab[data-next="devices"]');
    r.card = await page.evaluate(() => {
      const c = document.getElementById('next-devices'), b = c.getBoundingClientRect(), s = document.getElementById('stage').getBoundingClientRect();
      return { shown: !c.hidden && b.width > 0, insideStage: b.left >= s.left && b.top >= s.top && b.right <= s.right && b.bottom <= s.bottom, count: c.querySelector('.meta').textContent, links: c.querySelectorAll('a, [href], img').length, rows: c.querySelectorAll('.dev').length,
        chips: [...c.querySelectorAll('.dchip')].map((x) => x.textContent), zumiPanel: document.getElementById('tab-zumi').classList.contains('active'), navActive: document.querySelector('.tab.active').dataset.next || document.querySelector('.tab.active').dataset.tab };
    });
    await page.click('.tab[data-tab="zumi"]');
    r.cardAfterZumi = await page.evaluate(() => document.getElementById('next-devices').hidden);
  }
  if (await page.$('.tab[data-next="skills"]')) { // ON build only: Skills = two cards over the stage, closed by another tab
    await page.click('.tab[data-next="skills"]');
    r.skills = await page.evaluate(() => {
      const s = document.getElementById('stage').getBoundingClientRect();
      const card = (id) => { const c = document.getElementById(id); if (!c) return null; const b = c.getBoundingClientRect(); return { shown: !c.hidden && b.width > 0, inside: b.left >= s.left && b.top >= s.top && b.right <= s.right && b.bottom <= s.bottom, text: c.textContent.length }; };
      return { head: card('next-skills-head'), tree: card('next-skills-tree'), zumiPanel: document.getElementById('tab-zumi').classList.contains('active'), navActive: (document.querySelector('.tab.active') || {}).dataset ? document.querySelector('.tab.active').dataset.next : '' };
    });
    await page.click('.tab[data-tab="zumi"]');
    r.skillsAfterZumi = await page.evaluate(() => { const a = document.getElementById('next-skills-head'), b = document.getElementById('next-skills-tree'); return Boolean(a && b && a.hidden && b.hidden); });
  }
  await page.close(); server.close();
  return { ...r, bad };
}
const tokenDiff = (got, want, radius) => [...TOKEN_NAMES.map((n) => [n, want[n === '--primary' && want === V0211 ? '--foreground' : n]]), ['--radius', radius]]
  .filter(([n, v]) => got[n] !== v.toLowerCase()).map(([n, v]) => `${n}: want ${v}, got ${got[n]}`);

const scratches = [];
let browser;
try {
  const off = makeScratch('off', false); scratches.push(off);
  if (inject && inject !== 'copy') {
    if (!HOOKS[inject] && inject !== 'skillscode') { console.error(`unknown --inject-hook ${inject}`); process.exit(2); }
    if (inject === 'skillscode') { const fa = path.join(off, 'src', 'renderer', 'app.js'); fs.appendFileSync(fa, "\nwindow.__leak = 'next-skills';\n"); console.log('(self-test: a Skills code trace appended to the scratch app.js)'); }
    const f = path.join(off, 'src', 'renderer', 'index.html');
    const [from, to] = HOOKS[inject] || ['', '']; const html = fs.readFileSync(f, 'utf8');
    if (HOOKS[inject] && !html.includes(from)) { console.error(`inject: anchor not found in index.html: ${from}`); process.exit(2); }
    if (HOOKS[inject]) { fs.writeFileSync(f, html.replace(from, to)); console.log(`(self-test: one unguarded "${inject}" hook added back to the scratch index.html)`); }
  }
  console.log(`OFF: ${build(off, '0')}`);
  const on = makeScratch('on', true); scratches.push(on);
  console.log(`ON : ${build(on, '1')}`);
  // packager drop: sources PRESENT, flag OFF (default) -> the build must still carry neither path
  const full = makeScratch('full', true); scratches.push(full);
  if (inject === 'copy') {
    const f = path.join(full, 'scripts', 'build-renderer.mjs'); const js = fs.readFileSync(f, 'utf8');
    const re = /if \(nextUi\) \{(\r?\n  const ndir)/;
    if (!re.test(js)) { console.error('inject: next/ copy block not found in build-renderer.mjs'); process.exit(2); }
    fs.writeFileSync(f, js.replace(re, 'if (true) {$1'));
    console.log('(self-test: the sources-present scratch build-renderer.mjs copies next/ unconditionally)');
  }
  console.log(`FULL (sources present, ZUMI_NEXT_UI=0): ${build(full, '0')}`);
  const fullOut = path.join(full, 'build', 'renderer'), onOut = path.join(on, 'build', 'renderer');
  // default-ON: env var unset, sources present -> the build ships the next UI (NEXT_UI_DEFAULT = true)
  const dflt = makeScratch('default', true); scratches.push(dflt);
  console.log(`DEFAULT (env unset): ${build(dflt)}`);
  const dfltOut = path.join(dflt, 'build', 'renderer');
  let dfltFlag = null; try { dfltFlag = fs.readFileSync(path.join(dfltOut, 'next-ui.json'), 'utf8'); } catch { /* missing */ }
  const dfltHtml = fs.readFileSync(path.join(dfltOut, 'index.html'), 'utf8'), dfltApp = fs.readFileSync(path.join(dfltOut, 'app.js'), 'utf8');
  ok(dfltFlag === '{"nextUi":true}\n', 'default ON: a build with ZUMI_NEXT_UI unset writes {"nextUi":true}', dfltFlag);
  ok(fs.existsSync(path.join(dfltOut, 'next', 'tokens-a.css')) && fs.existsSync(path.join(dfltOut, 'next', 'theme-a.css')), 'default ON: build/renderer/next/tokens-a.css and next/theme-a.css exist');
  ok(/class="dark zumi-next"/.test(dfltHtml) && /next\/theme-a\.css/.test(dfltHtml) && /next-skills-head/.test(dfltApp), 'default ON: built index.html carries zumi-next and the next/ stylesheet, app.js carries the Skills code');
  ok(fs.existsSync(path.join(full, 'src', 'renderer', 'next')) && fs.existsSync(path.join(full, 'src', 'next-tokens', 'tokens-a.css')), 'packager drop: the OFF scratch copy has next/ and next-tokens/ sources present');
  const fullFiles = listFiles(fullOut), fullHtml = fs.readFileSync(path.join(fullOut, 'index.html'), 'utf8');
  ok(!fullFiles.some((x) => /^next\/?$|(^|\/)next\//.test(x)), 'packager drop, OFF with sources present: build/renderer has no next/ dir', fullFiles.filter((x) => /(^|\/)next(\/|$)/.test(x)).join(','));
  ok(!fullFiles.some((x) => /(^|\/)(tokens-a|theme-a)\.css$/.test(x)), 'packager drop, OFF with sources present: no tokens-a.css / theme-a.css anywhere in build/renderer', fullFiles.filter((x) => /(tokens-a|theme-a)\.css$/.test(x)).join(','));
  ok(!/next\/|zumi-next/.test(fullHtml), 'packager drop, OFF with sources present: built index.html has no "next/" or "zumi-next"');
  ok(fs.existsSync(path.join(onOut, 'next', 'tokens-a.css')) && fs.existsSync(path.join(onOut, 'next', 'theme-a.css')), 'packager drop control, ON: build/renderer/next/tokens-a.css and next/theme-a.css exist');
  const offApp = fs.readFileSync(path.join(off, 'build', 'renderer', 'app.js'), 'utf8'), fullApp = fs.readFileSync(path.join(fullOut, 'app.js'), 'utf8'), onApp = fs.readFileSync(path.join(onOut, 'app.js'), 'utf8');
  ok(!SKILLS_CODE.test(offApp), 'OFF: no Skills code in the built app.js (initSkills, store, next-skills, nx-skills, skills/page)', (offApp.match(SKILLS_CODE) || [])[0]);
  ok(!SKILLS_CODE.test(fullApp), 'packager drop, OFF with sources present: no Skills code in the built app.js', (fullApp.match(SKILLS_CODE) || [])[0]);
  ok(SKILLS_CODE.test(onApp) && /next-skills-head/.test(onApp) && /zumi\.progress/.test(onApp), 'control, ON: the built app.js carries the Skills code (so the OFF grep can tell the builds apart)');
  ok(!['src/renderer/next', 'src/next-tokens', 'build/renderer/next'].some((d) => fs.existsSync(path.join(off, d))), 'scratch copy has no next/ (source, tokens source, build)');

  browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], timeout: 60000 });
  const o = await probe(browser, path.join(off, 'build', 'renderer'));
  console.log(`OFF probe: ${JSON.stringify({ ...o, bad: o.bad.length })}`);
  ok(o.bad.length === 0 && !o.bootError, 'OFF: no failed request, console error or page error', `${o.bad.slice(0, 4).join(' | ')} ${o.bootError}`);
  ok(o.version.startsWith('v0.0.0'), 'OFF: app.js boot ran (version tag filled from the bridge)', o.version);
  ok(o.settingsOpens, "OFF: the app's own tab wiring ran (Settings opens)");
  ok(o.devicesItem === 0 && !o.devicesText, 'OFF: no Devices item in the sidebar', o.tabs.join(','));
  ok(o.devicesSection === 0, 'OFF: no #tab-devices / #next-devices');
  ok(o.skillsItem === 0 && !o.skillsText, 'OFF: no Skills item in the sidebar', o.tabs.join(','));
  ok(o.skillsSection === 0, 'OFF: no #tab-skills / #next-skills-head / #next-skills-tree');
  ok(o.nextLinks.length === 0 && !/zumi-next/.test(o.htmlClass), 'OFF: no next/ link and no zumi-next class', `${o.nextLinks.join(',')} class="${o.htmlClass}"`);
  const dOff = tokenDiff(o.tokens, V0211, '10px');
  ok(dOff.length === 0, 'OFF: the 0.2.11 token values (--background --foreground --primary --muted-foreground, --radius 10px)', dOff.join(' | '));

  const n = await probe(browser, path.join(on, 'build', 'renderer'));
  console.log(`ON  probe: ${JSON.stringify({ ...n, bad: n.bad.length })}`);
  ok(n.devicesItem === 1 && n.devicesText && n.devicesSection === 1, 'control, ON: the probe sees the Devices item and #next-devices', n.tabs.join(','));
  ok(n.nextLinks.includes('next/theme-a.css') && /zumi-next/.test(n.htmlClass) && n.bad.length === 0, 'control, ON: next/ stylesheets linked, zumi-next set, loads clean', `${n.bad.slice(0, 3).join(' | ')} class="${n.htmlClass}"`);
  const c = n.card || {};
  ok(c.shown && c.insideStage && c.zumiPanel && c.navActive === 'devices', 'control, ON: Devices opens a card over the Zumi stage (not a tab page)', JSON.stringify(c));
  ok(c.count === '3' && c.rows === 3 && c.links === 0 && c.chips && c.chips.join() === 'IN PROGRESS,COMING SOON,COMING SOON', 'control, ON: header count 3, three rows, no link / image, the chips', JSON.stringify(c));
  ok(n.cardAfterZumi === true, 'control, ON: another tab closes the card');
  ok(n.skillsItem === 1 && n.skillsText && n.skillsSection === 2, 'control, ON: the probe sees the Skills item and both Skills cards', `${n.skillsItem} ${n.skillsSection}`);
  const sk = n.skills || {};
  ok(sk.head && sk.tree && sk.head.shown && sk.tree.shown && sk.head.inside && sk.tree.inside && sk.head.text > 20 && sk.tree.text > 20 && sk.zumiPanel && sk.navActive === 'skills', 'control, ON: Skills opens two filled cards over the Zumi stage (not a tab page)', JSON.stringify(sk));
  ok(n.skillsAfterZumi === true, 'control, ON: another tab closes both Skills cards');
  const dOn = tokenDiff(n.tokens, LOOK_A, '2px');
  ok(dOn.length === 0, 'control, ON: the look A token values (the probe tells them from 0.2.11)', dOn.join(' | '));
} catch (e) {
  fail++; console.log(`FAIL check crashed: ${(e && e.stack) || e}`);
} finally {
  if (browser) await browser.close();
  if (!keep) for (const d of scratches) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`\ncheck:next-ui-off ${fail ? 'FAIL' : 'PASS'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
