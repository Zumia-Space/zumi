#!/usr/bin/env node
// Brain detail, slice 3a-3, renderer side (AC-B12 renderer half, AC-B14 / B15 renderer half): image thumbnails (w=480) with a lightbox (w=1600) inside the
// panel, and the Open buttons for the dossier and the refs a task's text cites (owner build only; the public build shows the path as text).
// Chromium (Playwright), the ZUMI_NEXT_UI build of a SCRATCH copy of the renderer, a stub of the preload bridge that records every board.media / board.openRef
// call, fed the real boardView body scripts/fixtures/brain-board-state.json with refs added. The host side is check-brain-host.mjs / check-brain-host-electron.mjs.
// Fault proof (C13): after the real run each FAULTS entry patches the scratch renderer with one defect, runs the same asserts in a child process, and requires
// exit 1 AND a FAIL starting with the expected id. An anchor that is not found is an error (exit 2), never a pass.
//   node scripts/check-brain-media.mjs [--no-faults] [--keep]       (child: --fault <id>)
// Playwright: $ZUMI_PLAYWRIGHT_DIR; Chromium: $ZUMI_CHROMIUM (same defaults as check-brain.mjs).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const PW = process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright');
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');
const args = process.argv.slice(2);
const faultId = args.includes('--fault') ? args[args.indexOf('--fault') + 1] : null;
const keep = args.includes('--keep');
const SCRATCH = `${ownerPath('scratchRoot', os.tmpdir())}/brain-media-check-${process.pid}`;
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; if (!faultId) console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); } };

const FAULTS = [
  { id: 'M1-public-shows-buttons', expect: 'M1', file: 'detail.js', edits: [['  if (owner) {\n    const btn = el(\'button\', \'nb-ref-open\'', '  if (true) {\n    const btn = el(\'button\', \'nb-ref-open\'']] },
  { id: 'M1-public-dossier-button', expect: 'M1', file: 'detail.js', edits: [["owner ? refRow(refs.find((r) => r.dossier), owner)", "true ? refRow(refs.find((r) => r.dossier), true)"]] },
  { id: 'M2-target-edited', expect: 'M2', file: 'detail.js', edits: [['{ kind: ref.kind, target: ref.target }); // verbatim', '{ kind: ref.kind, target: ref.target.trim().toLowerCase() }); // verbatim']] },
  { id: 'M3-thumb-width', expect: 'M3', file: 'detail.js', edits: [['getBoardMedia(m.id, 480)', 'getBoardMedia(m.id, 1600)']] },
  { id: 'M3-media-for-non-image', expect: 'M3', file: 'detail.js', edits: [['if (IMAGE_TYPES.has(m.mime) && thumbs.length < MAX_THUMBS) {', 'if (thumbs.length < MAX_THUMBS) {']] },
  { id: 'M4-lightbox-outside-panel', expect: 'M4', file: 'detail.js', edits: [['  card.appendChild(node);\n  close.focus();', '  document.body.appendChild(node);\n  close.focus();']] },
  { id: 'M4-escape-does-nothing', expect: 'M4', file: 'detail.js', edits: [["if (e.key === 'Escape')", "if (e.key === 'Escapx')"]] },
  { id: 'M4-lightbox-width', expect: 'M4', file: 'detail.js', edits: [['getBoardMedia(m.id, 1600)', 'getBoardMedia(m.id, 480)']] },
  { id: 'M5-no-revoke', expect: 'M5', file: 'detail.js', edits: [['for (const u of blobUrls) URL.revokeObjectURL(u);', '']] },
  { id: 'M6-keeps-asking-when-offline', expect: 'M6', file: 'detail.js', edits: [['if (stopped) { fail(stopped); continue; }', '']] },
  { id: 'M7-parallel-thumbnails', expect: 'M7', file: 'detail.js', edits: [["loadThumbs(thumbs, host.closest('.nx-brain') || host, mine);", "thumbs.forEach((x) => loadThumbs([x], host.closest('.nx-brain') || host, mine));"]] },
  { id: 'M9-media-in-library', expect: 'M9', file: 'brain.js', edits: [["renderLibrary(body, { state: res.state,", "window.zumi.board.media('att-17', { w: 480 }); renderLibrary(body, { state: res.state,"]] },
];

// ---------- fixture: the real boardView body, with refs the task text cites and enough images to see the queue ----------
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'brain-board-state.json'), 'utf8'));
const DOSSIER = base.tasks.find((t) => t.id === 'T-31').dossier;
const URL_REF = 'https://example.com/spec?a=1';
const LOCAL_REF = 'D:/data/notes/t31/next/x.md';
function stateWith(extraImages = 0) {
  const st = JSON.parse(JSON.stringify(base));
  const t = st.tasks.find((x) => x.id === 'T-31');
  t.goal = `${t.goal || 'Brain'}\n[Spec](${URL_REF})`;
  t.next = `${t.next || 'Next'}\n\`${LOCAL_REF}\``;
  for (let i = 0; i < extraImages; i++) st.attachments.push({ id: `att-${30 + i}`, task_id: 'T-31', name: `shot-${i}.png`, mime: 'image/png', size: 1200 + i, sha256: 'x'.repeat(8) });
  return st;
}
const fixture = stateWith(0);

// a small real PNG (40 x 30) so the <img> really decodes
function pngBase64() {
  const w = 40, h = 30;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 40 + x * 4; raw[o + 1] = 120; raw[o + 2] = 200 - y * 4; } }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const PNG_B64 = pngBase64();

// ---------- scratch copy of the renderer ----------
function makeScratch() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(path.join(SCRATCH, 'scripts'), { recursive: true });
  for (const f of ['build-renderer.mjs', 'rig-version.mjs', 'seat-offset.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(SCRATCH, 'scripts', f));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(SCRATCH, 'package.json'));
  fs.cpSync(path.join(ROOT, 'src', 'renderer'), path.join(SCRATCH, 'src', 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(SCRATCH, 'src', 'main'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'main', 'providers.js'), path.join(SCRATCH, 'src', 'main', 'providers.js'));
  fs.cpSync(path.join(ROOT, 'src', 'next-tokens'), path.join(SCRATCH, 'src', 'next-tokens'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'vendor', 'laneboard', 'public'), path.join(SCRATCH, 'vendor', 'laneboard', 'public'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(SCRATCH, 'node_modules'), 'junction');
}
function patch(fault) {
  const f = path.join(SCRATCH, 'src', 'renderer', 'next', 'brain', fault.file);
  let s = fs.readFileSync(f, 'utf8');
  for (const [a, b] of fault.edits) { const n = s.split(a).length - 1; if (n !== 1) { console.log(`ERROR fault ${fault.id}: anchor found ${n} times (need 1): ${a.slice(0, 70)}`); process.exit(2); } s = s.replace(a, () => b); }
  fs.writeFileSync(f, s);
}

function serve(buildDir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = p === '/tokens.css' ? path.join(ROOT, 'vendor', 'laneboard', 'public', 'tokens.css') : path.join(buildDir, p === '/' ? 'index.html' : p);
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p !== '/tokens.css' && !path.resolve(file).startsWith(path.resolve(buildDir))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); res.end(buf);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// window.__cfg: { owner, state, media: { <id>: answer } | undefined, mediaAll: answer | undefined, noMedia, noOpenRef, open: answer, delay }
// board.media / board.openRef are real functions or truly absent (never the catch-all proxy), so feature detection sees the truth.
function stubScript() {
  return `(() => {
    const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => Promise.resolve(deep()) });
    const cfg = window.__cfg;
    const info = { version: '0.0.0-check', packaged: true, disabledViews: [], ownerAdmin: Boolean(cfg.owner), boardPartition: 'persist:check', demo: false, selftest: false };
    const png = () => Uint8Array.from(atob(${JSON.stringify(PNG_B64)}), (c) => c.charCodeAt(0));
    window.__calls = { state: 0, media: [], open: [], inflight: 0, maxInflight: 0 };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const board = { status: async () => ({ configured: false, mode: 'local' }), state: async () => { window.__calls.state++; return cfg.state; } };
    if (!cfg.noMedia) board.media = async (id, opts) => {
      const c = window.__calls; c.media.push({ id, w: opts && opts.w }); c.inflight++; c.maxInflight = Math.max(c.maxInflight, c.inflight);
      await sleep(cfg.delay || 20); c.inflight--;
      const a = (cfg.media && cfg.media[id]) || cfg.mediaAll;
      return a || { ok: true, mime: 'image/png', bytes: png() };
    };
    if (!cfg.noOpenRef) board.openRef = async (ref) => { window.__calls.open.push(JSON.parse(JSON.stringify(ref))); return cfg.open || { opened: true }; };
    const boardProxy = new Proxy(board, { get: (t, k) => (k in t ? t[k] : (k === 'then' || k === 'media' || k === 'openRef' || k === 'state' ? undefined : deep())) });
    const withFallback = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (k === 'then' || k === 'memory' ? undefined : deep())) });
    const base = { info: async () => info, listModels: async () => ({ models: [], selected: null }), listClips: async () => [],
      rooms: withFallback({ list: async () => ({ rooms: [], geometry: null }) }), scenes: withFallback({ list: async () => ({ rooms: [], geometry: null, selected: null }) }),
      chairs: withFallback({ list: async () => ({ chairs: [], selected: null }) }), wardrobe: withFallback({ canUndo: async () => false }), ui: withFallback({ getLang: async () => 'en', setLang: async () => {} }),
      openBoard: async () => ({ url: 'http://127.0.0.1:9/', origin: 'http://127.0.0.1:9', dataDir: 'x' }), board: boardProxy };
    window.zumi = withFallback(base);
  })();`;
}

async function pageFor(browser, server, cfg) {
  const page = await browser.newPage({ viewport: { width: 1296, height: 839 } });
  const bad = [];
  page.on('pageerror', (e) => bad.push(`pageerror: ${String(e.message).split('\n')[0]}`));
  page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text().split('\n')[0]}`); });
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`http ${r.status()}: ${r.url()}`); });
  await page.addInitScript(`window.__cfg = ${JSON.stringify(cfg)};`);
  await page.addInitScript(stubScript());
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app-version') && document.getElementById('app-version').textContent.startsWith('v0.0.0'), null, { timeout: 20000 });
  await page.waitForSelector('.tab[data-next="brain"]', { timeout: 20000 });
  return { page, bad };
}
const openTask = async (page, id = 'T-31') => {
  await page.click('.tab[data-next="brain"]'); await page.click('.nb-tab[data-tab="tasks"]');
  await page.waitForSelector('.nb-row', { timeout: 5000 });
  await page.click(`.nb-row[data-task="${id}"]`);
  await page.waitForSelector('.nb-dhead', { timeout: 5000 });
};
const calls = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__calls)));
const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function chromiumPart(buildDir) {
  const { chromium } = createRequire(import.meta.url)(PW);
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], timeout: 60000 });
  const server = await serve(buildDir);
  try {
    const st = { ok: true, state: stateWith(0) };

    // --- M9: the library asks for nothing ---
    {
      const { page, bad } = await pageFor(browser, server, { owner: true, state: st });
      await page.click('.tab[data-next="brain"]'); await page.click('.nb-tab[data-tab="tasks"]');
      await page.waitForSelector('.nb-row', { timeout: 5000 }); await settle(page);
      const c = await calls(page);
      ok(c.state >= 1 && c.media.length === 0 && c.open.length === 0, 'M9 the library view makes no media and no openRef call (control: board.state was read)', { state: c.state, media: c.media.length, open: c.open.length });
      ok(bad.length === 0, 'M9 library: no console error, page error or failed request', bad.slice(0, 3).join(' | '));
      await page.close();
    }

    // --- M1 / M2: Open buttons, owner vs public ---
    for (const owner of [true, false]) {
      const { page, bad } = await pageFor(browser, server, { owner, state: st });
      await openTask(page); await settle(page);
      const d = await page.evaluate(() => ({
        buttons: document.querySelectorAll('#next-brain .nb-ref-open').length,
        refs: [...document.querySelectorAll('#next-brain .nb-path')].map((p) => ({ text: p.textContent, inRef: Boolean(p.closest('.nb-ref')) })),
        sections: [...document.querySelectorAll('#next-brain .nb-sec-h')].map((h) => h.textContent),
      }));
      const wantTargets = [DOSSIER, URL_REF, LOCAL_REF];
      const texts = d.refs.map((r) => r.text);
      ok(wantTargets.every((x) => texts.includes(x)) && d.sections.includes('Dossier') && d.sections.includes('Links and files'), `M1 ${owner ? 'owner' : 'public'} build: the dossier and both cited refs are shown (the path / link as text)`, { refs: d.refs, sections: d.sections });
      if (owner) ok(d.buttons === 3, 'M1 owner build: one Open button each for the dossier and the two cited refs', d.buttons);
      else ok(d.buttons === 0, 'M1 public build: no Open button anywhere in the detail (the path is only text)', d.buttons);
      if (owner) {
        const rows = await page.$$('#next-brain .nb-ref');
        for (const row of rows) { const b = await row.$('.nb-ref-open'); if (b) await b.click(); await settle(page, 120); }
        const c = await calls(page);
        const want = [{ kind: 'local', target: DOSSIER }, { kind: 'url', target: URL_REF }, { kind: 'local', target: LOCAL_REF }];
        ok(JSON.stringify(c.open) === JSON.stringify(want), 'M2 each Open button sends exactly { kind, target } as the board cites it (verbatim, in reading order)', { got: c.open, want });
        ok((await page.$$eval('#next-brain .nb-ref-msg', (m) => m.map((x) => x.textContent))).every((x) => x === '') && (await page.$$eval('#next-brain .nb-ref-open', (b) => b.every((x) => !x.disabled))), 'M2 a successful open shows no message and leaves the button enabled');
      }
      ok(bad.length === 0, `M1 ${owner ? 'owner' : 'public'} detail: no console error, page error or failed request`, bad.slice(0, 3).join(' | '));
      await page.close();
    }
    {
      const { page } = await pageFor(browser, server, { owner: true, state: st, open: { opened: false, reason: 'not_on_board' } });
      await openTask(page);
      await page.click('#next-brain .nb-ref-open'); await settle(page, 200);
      const msg = await page.$eval('#next-brain .nb-ref-msg', (m) => m.textContent);
      ok(msg === 'Could not open it (not_on_board).', 'M2 a host refusal is shown next to the button with its reason word', msg);
      await page.close();
    }

    // --- M3 / M4 / M5: thumbnails, lightbox, release ---
    {
      const { page, bad } = await pageFor(browser, server, { owner: true, state: st });
      await openTask(page); await settle(page, 700);
      const c = await calls(page);
      ok(JSON.stringify(c.media) === JSON.stringify([{ id: 'att-17', w: 480 }]), 'M3 the T-31 detail asks for the one image attachment, once, at w=480 (the markdown attachment is not asked for)', c.media);
      const th = await page.evaluate(() => [...document.querySelectorAll('#next-brain img.nb-thumb')].map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, blob: i.src.startsWith('blob:'), inLi: i.closest('li') && i.closest('li').dataset.att })));
      ok(th.length === 1 && th[0].w === 40 && th[0].h === 30 && th[0].blob && th[0].inLi === 'att-17', 'M3 one thumbnail, decoded from a blob: URL, inside its attachment row', th);
      ok((await page.$$('#next-brain li[data-att="att-18"] img')).length === 0, 'M3 the markdown attachment has no preview');
      const thumbSrc = await page.$eval('#next-brain img.nb-thumb', (i) => i.src);
      // M4 lightbox
      await page.click('#next-brain .nb-thumb-btn'); await page.waitForSelector('.nb-lightbox img.nb-lb-img', { timeout: 5000 });
      const lb = await page.evaluate(() => {
        const l = document.querySelector('.nb-lightbox'), card = document.getElementById('next-brain'), r = l.getBoundingClientRect(), c = card.getBoundingClientRect(), i = l.querySelector('img.nb-lb-img');
        return { inCard: card.contains(l), within: r.left >= c.left - 1 && r.top >= c.top - 1 && r.right <= c.right + 1 && r.bottom <= c.bottom + 1, decoded: i.naturalWidth, role: l.getAttribute('role'), modal: l.getAttribute('aria-modal'), focus: document.activeElement && document.activeElement.textContent };
      });
      const c2 = await calls(page);
      ok(lb.inCard && lb.within && lb.decoded === 40 && lb.role === 'dialog' && lb.modal === 'true', 'M4 clicking the thumbnail opens the lightbox INSIDE the Brain card (a dialog), showing the decoded image', lb);
      ok(c2.media.length === 2 && c2.media[1].id === 'att-17' && c2.media[1].w === 1600, 'M4 the lightbox asks for the same attachment at w=1600 (and only then)', c2.media);
      ok(lb.focus === 'Close', 'M4 focus goes to the Close button', lb.focus);
      const lbSrc = await page.$eval('.nb-lightbox img.nb-lb-img', (i) => i.src);
      await page.keyboard.press('Escape'); await settle(page, 150);
      ok((await page.$$('.nb-lightbox')).length === 0, 'M4 Esc closes the lightbox');
      ok(await page.evaluate((u) => fetch(u).then(() => false, () => true), lbSrc), 'M4 the lightbox picture\'s blob: URL is released when it closes');
      await page.click('#next-brain .nb-thumb-btn'); await page.waitForSelector('.nb-lightbox'); await page.click('.nb-lightbox .nb-back'); await settle(page, 100);
      ok((await page.$$('.nb-lightbox')).length === 0, 'M4 the Close button closes it');
      await page.click('#next-brain .nb-thumb-btn'); await page.waitForSelector('.nb-lightbox'); await page.click('.nb-lightbox .nb-lb-bar', { position: { x: 4, y: 4 } }).catch(() => {}); await page.mouse.click(1, 1).catch(() => {});
      await page.evaluate(() => document.querySelector('.nb-lightbox .nb-lb-stage').click()); await settle(page, 100);
      ok((await page.$$('.nb-lightbox')).length === 0, 'M4 a click on the empty area around the picture closes it');
      // M5 leaving the detail releases the thumbnail
      ok(await page.evaluate((u) => fetch(u).then(() => true, () => false), thumbSrc), 'M5 control: the thumbnail\'s blob: URL is alive while the detail is open');
      await page.click('.nb-back'); await settle(page, 150);
      ok(await page.evaluate((u) => fetch(u).then(() => false, () => true), thumbSrc), 'M5 going Back releases the thumbnail\'s blob: URL', thumbSrc);
      const real = bad.filter((x) => !/ERR_FILE_NOT_FOUND/.test(x)); // the probes above fetch() blob: URLs that were released on purpose
      ok(real.length === 0, 'M3-5 detail with images: no console error, page error or failed request (apart from the released-URL probes)', real.slice(0, 3).join(' | '));
      await page.close();
    }

    // --- M6: the board cannot serve images -> one answer, no hammering; "busy" is not a stop ---
    for (const [reason, stops] of [['offline', true], ['rate_limited', false]]) {
      const { page, bad } = await pageFor(browser, server, { owner: true, state: { ok: true, state: stateWith(3) }, mediaAll: { ok: false, reason } });
      await openTask(page); await settle(page, 900);
      const c = await calls(page);
      const msgs = await page.$$eval('#next-brain .nb-thumb-msg', (m) => m.map((x) => x.textContent));
      const want = `No preview (${reason}).`;
      ok(msgs.length === 4 && msgs.every((x) => x === want), `M6 ${reason}: every image shows "${want}"`, msgs);
      ok(stops ? c.media.length === 1 : c.media.length === 4, `M6 ${reason}: ${stops ? 'after the first answer the others are not asked for' : 'a per-image refusal does not stop the next image'}`, c.media.length);
      ok(bad.length === 0, `M6 ${reason}: no console error`, bad.slice(0, 3).join(' | '));
      await page.close();
    }
    {
      const { page, bad } = await pageFor(browser, server, { owner: false, state: st, noMedia: true, noOpenRef: true });
      await openTask(page); await settle(page);
      const msgs = await page.$$eval('#next-brain .nb-thumb-msg', (m) => m.map((x) => x.textContent));
      ok(msgs.join() === 'No preview (unconfigured).' && bad.length === 0, 'M6 a host with no board.media (a release build) shows "No preview (unconfigured)." and no error', { msgs, bad: bad.slice(0, 2) });
      await page.close();
    }

    // --- M7: at most one media read in flight from the detail ---
    {
      const { page } = await pageFor(browser, server, { owner: true, state: { ok: true, state: stateWith(5) }, delay: 60 });
      await openTask(page); await settle(page, 1200);
      const c = await calls(page);
      const imgs = await page.$$eval('#next-brain img.nb-thumb', (i) => i.length);
      ok(imgs === 6 && c.media.length === 6 && c.maxInflight === 1, 'M7 six thumbnails load one after the other (never more than 1 media read in flight; the host allows 4)', { imgs, reads: c.media.length, max: c.maxInflight });
      await page.close();
    }

    // --- M8: the three new reason words reach the reason card ---
    for (const [reason, text] of [['too_large', 'The board data is too large for Brain to load.'], ['busy', 'Brain is already loading other pictures. Try again in a moment.'], ['rate_limited', 'Brain asked the board too often. Wait a minute and try again.']]) {
      const { page } = await pageFor(browser, server, { owner: true, state: { ok: false, reason } });
      await page.click('.tab[data-next="brain"]'); await page.click('.nb-tab[data-tab="tasks"]');
      await page.waitForSelector('.nb-reason', { timeout: 5000 });
      const got = await page.$eval('#next-brain .nb-reason .nb-text', (e) => e.textContent);
      ok(got === text && (await page.$eval('#next-brain .nb-reason', (e) => e.dataset.reason)) === reason, `M8 reason "${reason}" -> its own sentence on the reason card`, got);
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
}

try {
  if (!fs.existsSync(path.join(PW, 'package.json')) || !fs.existsSync(EXE)) { console.error(`ENV: need playwright at ${PW} and Chromium at ${EXE}`); process.exit(2); }
  makeScratch();
  if (faultId) { const f = FAULTS.find((x) => x.id === faultId); if (!f) { console.error(`unknown fault ${faultId}`); process.exit(2); } patch(f); }
  execFileSync(process.execPath, [path.join(SCRATCH, 'scripts', 'build-renderer.mjs')], { cwd: SCRATCH, env: { ...process.env, ZUMI_NEXT_UI: '1' }, encoding: 'utf8' });
  await chromiumPart(path.join(SCRATCH, 'build', 'renderer'));
} catch (e) {
  fail++; console.log(`FAIL check crashed: ${(e && e.stack) || e}`);
} finally {
  if (!keep) fs.rmSync(SCRATCH, { recursive: true, force: true });
}
if (faultId) { console.log(`child: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
console.log(`\nreal run: ${pass} passed, ${fail} failed`);
let bad = fail;

if (!args.includes('--no-faults')) {
  let proved = 0;
  for (const f of FAULTS) {
    const run = spawnSync(process.execPath, [SELF, '--fault', f.id], { encoding: 'utf8', timeout: 600000 });
    const fails = run.stdout.split('\n').filter((l) => l.startsWith('FAIL '));
    const hit = fails.some((l) => l.startsWith(`FAIL ${f.expect}`));
    const good = run.status === 1 && hit;
    if (good) proved++; else bad++;
    console.log(`${good ? 'PROVED' : 'NOT PROVED'} fault ${f.id}: exit ${run.status}, ${fails.length} assert(s) failed, expected ${f.expect}* ${hit ? 'among them' : 'MISSING'}`);
    for (const l of fails) console.log(`    > ${l.slice(0, 200)}`);
  }
  console.log(`faults proved: ${proved}/${FAULTS.length}`);
}
console.log(bad ? `\ncheck-brain-media: FAILED (${bad})` : '\ncheck-brain-media: all passed');
process.exit(bad ? 1 : 0);
