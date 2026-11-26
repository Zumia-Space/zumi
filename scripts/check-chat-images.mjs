// R6c C item 5: an image attached to a chat message. Plain Node, no browser, no real provider (a loopback fake below the egress guard).
//   - the image goes to the model for that ONE request only (the last user message), never into history, memory, logs or any file;
//   - a model that cannot read images gets nothing: the turn ends at once with the code no_vision and the provider is never called;
//   - a bad attachment (type, size, count) is refused before anything leaves the machine;
//   - the renderer's attach control (chat-attach.js) keeps the images in memory only until the next send, in en/vi/zh.
//   node scripts/check-chat-images.mjs     (exit 1 on any failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TABLES, t } from '../src/renderer/i18n.js';
import { failureLineKey } from '../src/renderer/talk/error-line.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const nap = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-chat-images-'));
let n = 0;

// A 1x1 PNG, base64 (the marker the "never stored" sweep looks for is a longer, unique payload below).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MARK = `${'QUJD'.repeat(40)}ZUMIIMAGEMARK${'REVG'.repeat(40)}`; // valid base64 characters, 640+ chars: never allowed on disk
const img = (data = PNG, mime = 'image/png') => ({ mime, data });

try {
  // ---------- the words ----------
  for (const lang of ['en', 'vi', 'zh']) {
    const keys = ['app.noVision', 'app.badImage', 'chat.attach.btn', 'chat.attach.remove', 'chat.attach.badType', 'chat.attach.tooBig', 'chat.attach.tooMany', 'chat.attach.taskMode'];
    const missing = keys.filter((k) => !(k in TABLES[lang]) || !TABLES[lang][k]);
    ok(missing.length === 0, `${lang}: the image words exist (no-vision message, attach control, refusals)`, missing.join(', '));
  }
  ok(failureLineKey({ code: 'no_vision' }) === 'app.noVision' && failureLineKey({ code: 'bad_image' }) === 'app.badImage', 'a failed turn with code no_vision / bad_image shows its own line, not the generic one');
  ok(/image/i.test(t('app.noVision')) && !/^app\./.test(t('app.noVision')), 'the no-vision line says it is about images');

  // ---------- the chat brain: what reaches the provider ----------
  const CB = require('../src/main/chat-brain.js');
  const { startFakeLlm } = await import('./fake-llm-sse.mjs');
  const loopback = require('./fixtures/fetch-to-loopback.cjs');
  const { createKeyStore } = require('../src/main/reflex-jev.js');
  const prov = require('../src/main/providers.js');
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)), decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8') };
  const fake = await startFakeLlm({ firstMs: 1, intervalMs: 1, chunkChars: 16, text: 'I can see a small picture.', log: () => {} });
  const KEYS = { openrouter: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789', gemini: `AIza${'b'.repeat(35)}`, opencode: 'sk-opencodeabcdefghijklmnopqrstuvwxyz0123' };
  try {
    const brainFor = (providerId, { modelsJson = null } = {}) => {
      const dir = path.join(tmpRoot, `b${++n}`); fs.mkdirSync(dir);
      const p = prov.PROVIDERS[providerId];
      createKeyStore({ safeStorage, dir, name: p.keyName, shape: p.keyShape }).write(KEYS[providerId]);
      const bodies = [];
      const fetchImpl = async (url, init) => {
        const u = String(url);
        if (modelsJson && /\/models(\?|$)/.test(u)) return new Response(JSON.stringify(modelsJson), { status: 200, headers: { 'content-type': 'application/json' } });
        if (init && init.body) bodies.push(JSON.parse(init.body));
        return fetch(loopback.rewrite(u, new URL(fake.url)), init);
      };
      const brain = CB.createChatBrain({ safeStorage, dir, provider: p, fetchImpl, log: () => {} });
      return { brain, bodies, dir, model: () => brain.status().model };
    };
    const turn = async (b, extra) => { const r = await b.brain.turnStream({ turnId: 'a'.repeat(32), message: 'What is in this picture?', history: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' }], ...extra }); if (r.live) await r.live.final; return r; };
    const lastUser = (body) => body.messages[body.messages.length - 1];

    // a model that reads images (Gemini ids do)
    const g = brainFor('gemini');
    const r1 = await turn(g, { images: [img()] });
    ok(r1.head.ok === true && g.bodies.length >= 1, 'gemini: a turn with one image is answered');
    const sent = g.bodies[g.bodies.length - 1];
    const lu = lastUser(sent);
    ok(lu.role === 'user' && Array.isArray(lu.content) && lu.content.some((c) => c.type === 'text' && c.text === 'What is in this picture?') && lu.content.some((c) => c.type === 'image_url' && c.image_url.url === `data:image/png;base64,${PNG}`), 'the last user message carries the text and the image as a data URL');
    ok(sent.messages.slice(0, -1).every((m) => typeof m.content === 'string'), 'every earlier message (system, history) is plain text: the image is in that one message only');
    const r2 = await turn(g, {});
    ok(r2.head.ok === true && typeof lastUser(g.bodies[g.bodies.length - 1]).content === 'string', 'the next turn without an image is plain text again: nothing was kept');
    ok(!JSON.stringify(g.bodies[g.bodies.length - 1]).includes(PNG), 'and the earlier image is nowhere in the next request');

    // a model that cannot: no call leaves the machine
    const o = brainFor('opencode');
    const before = fake.requests.length;
    const r3 = await turn(o, { images: [img()] });
    ok(r3.head.ok === false && r3.head.error && r3.head.error.code === 'no_vision' && r3.head.error.retryable === false, 'a model that cannot read images: the turn ends with code no_vision', JSON.stringify(r3.head));
    ok(fake.requests.length === before && o.bodies.length === 0, 'and nothing was sent to the provider');
    ok(!JSON.stringify(r3.head).includes(PNG), 'the refusal does not echo the image back');
    const r3b = await turn(o, {});
    ok(r3b.head.ok === true, 'the same model still answers a text-only message');

    // OpenRouter says it in its model list (architecture.input_modalities)
    const probe = brainFor('openrouter');
    const mid = probe.model();
    const listOf = (inputs) => ({ data: [{ id: mid, name: 'M', architecture: { input_modalities: inputs, output_modalities: ['text'] }, supported_parameters: [] }] });
    const seeing = brainFor('openrouter', { modelsJson: listOf(['text', 'image']) });
    const r4 = await turn(seeing, { images: [img()] });
    ok(r4.head.ok === true && Array.isArray(lastUser(seeing.bodies[seeing.bodies.length - 1]).content), 'openrouter: a model whose list entry takes image input gets the image');
    const blind = brainFor('openrouter', { modelsJson: listOf(['text']) });
    const r5 = await turn(blind, { images: [img()] });
    ok(r5.head.ok === false && r5.head.error.code === 'no_vision' && blind.bodies.length === 0, 'openrouter: a text-only model gets nothing and the answer is no_vision');
    const unknown = brainFor('openrouter', { modelsJson: { data: [] } });
    const r6 = await turn(unknown, { images: [img()] });
    ok(r6.head.ok === false && r6.head.error.code === 'no_vision' && unknown.bodies.length === 0, 'openrouter: a model the list does not know is not assumed to see (no_vision)');

    // a bad attachment never leaves the machine
    const bad = [
      ['a type that is not an image', [img(PNG, 'image/svg+xml')]],
      ['text that is not base64', [img('not base64 !!!')]],
      ['more than four images', [img(), img(), img(), img(), img()]],
      ['one image over 5 MB', [img('A'.repeat(7 * 1024 * 1024))]],
      ['a malformed entry', [{ mime: 'image/png' }]],
      ['a non-array', 'nope'],
    ];
    for (const [label, images] of bad) {
      const b = brainFor('gemini');
      const r = await turn(b, { images });
      ok(r.head.ok === false && r.head.error && r.head.error.code === 'bad_image' && b.bodies.length === 0, `refused before anything is sent: ${label}`, JSON.stringify(r.head).slice(0, 160));
    }
    const logs = [];
    const lg = brainFor('gemini');
    const loud = CB.createChatBrain({ safeStorage, dir: lg.dir, provider: prov.PROVIDERS.gemini, fetchImpl: async (u, i) => fetch(loopback.rewrite(String(u), new URL(fake.url)), i), log: (m) => logs.push(m) });
    const r7 = await loud.turnStream({ turnId: 'c'.repeat(32), message: 'hi', history: [], images: [img(MARK)] });
    if (r7.live) await r7.live.final;
    ok(!logs.join('\n').includes(MARK), 'the log never holds image bytes');
  } finally { await fake.close(); }

  // ---------- the Tauri chat host with memory: the image is never kept ----------
  {
    const { startFakeLlm: startFake2 } = await import('./fake-llm-sse.mjs');
    const { guardedFetch, cloudFetch, mirrorFetch, jevFetch, PROVIDER_ORIGINS } = await import('../tauri/sidecar/egress.mjs');
    const { createAiSettings } = await import('../tauri/sidecar/ai-settings.mjs');
    const { createAiCore } = await import('../tauri/sidecar/ai-core.mjs');
    const { createChatHost } = await import('../tauri/sidecar/chat-host.mjs');
    const { createSecretStores } = await import('../tauri/sidecar/secret-stores.mjs');
    const { FLAVOURS } = await import('../tauri/sidecar/flavour.mjs');
    const { createMemoryNotes } = await import('../tauri/sidecar/memory-notes.mjs');
    const fake2 = await startFake2({ firstMs: 1, intervalMs: 1, chunkChars: 16, text: 'It is a tiny picture.', log: () => {} });
    try {
      const dir = path.join(tmpRoot, `host${++n}`); fs.mkdirSync(dir);
      const file = path.join(dir, 'settings.json');
      const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
      const set = (p) => { const next = { ...get(), ...p }; fs.writeFileSync(file, JSON.stringify(next)); return next; };
      set({ aiProvider: 'gemini', age18Confirmed: true, roleModels: { off: ['plan', 'check', 'lookup'] } });
      const bodies = [];
      const base = async (url, init) => { if (init && init.body) bodies.push(JSON.parse(init.body)); return fetch(loopback.rewrite(url, new URL(fake2.url)), init); };
      let host = null;
      const ai = createAiSettings({ dataDir: dir, settings: get, saveSettings: set, onChange: () => { if (host) host.rebuild(); } });
      ai.pin();
      const secretStores = async () => createSecretStores({ safeStorage, dataDir: dir });
      const aiCore = createAiCore({ ai, secretStores, dataDir: dir, log: () => {}, reflexEgress: false, jevFetch: jevFetch(base, false, () => {}) });
      const memory = createMemoryNotes({ dataDir: dir });
      const p = prov.PROVIDERS.gemini;
      host = createChatHost({ dataDir: dir, settings: get, saveSettings: set, ai, secretStores, safeStorage, flavour: { values: FLAVOURS.public }, aiCore, log: () => {}, memory, emit: () => true,
        egress: { provider: guardedFetch(base, PROVIDER_ORIGINS, () => {}), cloud: cloudFetch(base, null, () => {}), mirror: mirrorFetch(base, null, () => {}) } });
      host.rebuild();
      const noKey = await host.handlers['talk.turn']({ turnId: 'e'.repeat(32), message: 'What is this?', history: [], images: [img(MARK)] });
      ok(noKey && noKey.ok === false && noKey.error && noKey.error.code === 'no_vision' && bodies.length === 0, 'chat host: with no key of the person\'s own, an image is refused and Zumi\'s server is never sent it');
      createKeyStore({ safeStorage, dir, name: p.keyName, shape: p.keyShape }).write(KEYS.gemini);
      host.rebuild();
      const head = await host.handlers['talk.turn']({ turnId: 'd'.repeat(32), message: 'What is this?', history: [], images: [img(MARK)] });
      await nap(400);
      ok(head && head.ok === true && bodies.some((b) => JSON.stringify(b).includes(MARK)), 'chat host: the image reached the provider for this request');
      const kept = memory.list({ kind: 'turn' }).items;
      ok(kept.length === 1 && kept[0].text === 'What is this?' && !JSON.stringify(kept).includes('ZUMIIMAGEMARK'), 'chat host: memory keeps the sentence and the reply, never the image');
      memory.close();
      const hits = [];
      const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, f.name); if (f.isDirectory()) walk(q); else if (fs.readFileSync(q).includes(Buffer.from('ZUMIIMAGEMARK'))) hits.push(q); } };
      walk(dir);
      ok(hits.length === 0, 'chat host: no file under the data folder holds the image bytes (memory.db, its WAL, journal, usage, logs)', hits.join(','));
    } finally { await fake2.close(); }
  }

  // ---------- the renderer's attach control ----------
  {
    const mod = await import('../src/renderer/chat-attach.js').catch(() => null);
    ok(mod && typeof mod.initChatAttach === 'function' && mod.ATTACH_MAX_COUNT === 4 && mod.ATTACH_MAX_BYTES === 20 * 1024 * 1024, 'chat-attach.js exports initChatAttach and the limits (4 images, 20 MB per file; what is sent is shrunk, see check:chat-image-frame)');
    if (mod) {
      const byId = new Map();
      const mk = (tag) => {
        const listeners = {};
        let text = '';
        const el = {
          tag, children: [], dataset: {}, attrs: {}, hidden: false, className: '', disabled: false, value: '', type: '', accept: '', multiple: false, files: [], _id: '',
          get id() { return el._id; }, set id(v) { el._id = v; byId.set(v, el); },
          get textContent() { return text + el.children.map((c) => c.textContent).join(''); }, set textContent(v) { text = String(v); el.children = []; },
          appendChild(ch) { ch.parentNode = el; el.children.push(ch); return ch; },
          insertBefore(ch, ref) { ch.parentNode = el; const i = el.children.indexOf(ref); el.children.splice(i < 0 ? el.children.length : i, 0, ch); return ch; },
          setAttribute(k, v) { el.attrs[k] = String(v); },
          addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
          async fire(type, ev = {}) { for (const fn of listeners[type] || []) await fn({ preventDefault() { ev.prevented = true; }, ...ev }); return ev; },
          click() { el.clicked = true; },
          all() { return [el, ...el.children.flatMap((x) => x.all())]; },
        };
        return el;
      };
      const composer = mk('footer'); composer.className = 'composer';
      const msg = mk('input'); msg.id = 'msg'; composer.appendChild(msg);
      const doc = { createElement: mk, querySelector: (s) => (s === 'footer.composer' ? composer : null) };
      const $ = (id) => byId.get(id) || null;
      const read = async (f) => ({ mime: f.type, data: f.data || PNG });
      const ctl = mod.initChatAttach($, { doc, t, apply: () => {}, readFile: read });
      ok(ctl && $('chat-attach-btn') && $('chat-attach-input') && $('chat-attach-chips') && $('chat-attach-note'), 'a button, a file input, a chip list and a note line are built');
      ok($('chat-attach-input').type === 'file' && /image\/png/.test($('chat-attach-input').accept) && !/svg/.test($('chat-attach-input').accept) && $('chat-attach-input').hidden === true, 'the file box takes png, jpeg, webp, gif only and is hidden behind the button');
      await $('chat-attach-btn').fire('click');
      ok($('chat-attach-input').clicked === true, 'the button opens the file box');
      ok(ctl.take().length === 0, 'nothing attached: take() is an empty list');
      await ctl.add({ name: 'a.png', type: 'image/png', size: 1000 });
      await ctl.add({ name: 'b.jpg', type: 'image/jpeg', size: 1000 });
      ok(ctl.count() === 2 && $('chat-attach-chips').children.length === 2 && /a\.png/.test($('chat-attach-chips').textContent), 'two images: two chips with the file names');
      await ctl.add({ name: 'x.svg', type: 'image/svg+xml', size: 10 });
      ok(ctl.count() === 2 && $('chat-attach-note').textContent === t('chat.attach.badType'), 'a type that is not allowed is refused in words');
      await ctl.add({ name: 'big.png', type: 'image/png', size: 20 * 1024 * 1024 + 1 });
      ok(ctl.count() === 2 && $('chat-attach-note').textContent === t('chat.attach.tooBig'), 'a file over 20 MB is refused in words');
      await ctl.add({ name: 'c.png', type: 'image/png', size: 1 }); await ctl.add({ name: 'd.png', type: 'image/png', size: 1 });
      await ctl.add({ name: 'e.png', type: 'image/png', size: 1 });
      ok(ctl.count() === 4 && $('chat-attach-note').textContent === t('chat.attach.tooMany'), 'a fifth image is refused in words');
      const remove = $('chat-attach-chips').children[0].all().find((x) => x.tag === 'button');
      await remove.fire('click');
      ok(ctl.count() === 3 && !/a\.png/.test($('chat-attach-chips').textContent), 'a chip\'s remove button drops that image');
      const taken = ctl.take();
      ok(taken.length === 3 && taken.every((x) => x.mime && typeof x.data === 'string') && ctl.count() === 0 && $('chat-attach-chips').children.length === 0, 'take() hands over the images once and the control is empty again (one request only)');
      ok(ctl.take().length === 0, 'a second take() has nothing: the images are not kept');
      const ev = await msg.fire('paste', { clipboardData: { files: [{ name: 'p.png', type: 'image/png', size: 5 }, { name: 'doc.txt', type: 'text/plain', size: 5 }] } });
      await nap(10);
      ok(ev.prevented === true && ctl.count() === 1, 'pasting an image into the box attaches it (a text file in the clipboard is left alone)');
      const ev2 = await msg.fire('paste', { clipboardData: { files: [] } });
      ok(ev2.prevented !== true, 'a paste with no image is not touched');
      const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'chat-attach.js'), 'utf8').replace(/\/\/.*$/gm, '');
      ok(!/localStorage|sessionStorage|indexedDB|innerHTML|outerHTML/.test(src), 'the control stores nothing (no storage API) and sets no markup');
    }
  }
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { console.log(`NOTE temp dir not removed: ${e.message}`); }
}
console.log(`\ncheck:chat-images ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
