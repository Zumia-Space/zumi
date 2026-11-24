// R6f M1b: an attached picture must reach the model through the REAL send path. Until R6f, talk/index.js `send(text)` dropped the second argument, so
// the page emptied the attachment control and the turn went out as text only (since R6c C). check:chat-images calls chat-brain directly and
// check:chat-image-frame builds the request line itself, so neither could see a hop that loses the pictures. This check drives every hop of the page:
//   chat-attach (real) -> app.js's own send function -> talk.send (real createTalk) -> TalkDirector (real) -> zumi.talk.turn (the real zumi-shim.js, in a vm)
//   -> the rpc request line (size against the host's frame cap) -> chat-host talk.turn (real) -> chat-brain (real) -> a loopback provider,
// and asserts the picture bytes are in the provider's request. The only fakes: the Tauri invoke (it frames the line and calls the host), the provider.
//   node scripts/check-chat-image-send.mjs     (exit 1 on any failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-image-send-'));
const realFetch = globalThis.fetch;

// The page reads speech/*.json over fetch; everything else is the real fetch.
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('speech/')) return new Response(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', 'speech', u.slice(7))), { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, init);
};

// A minimal DOM for the attach control.
const byId = new Map();
const mk = (tag) => {
  const listeners = {}; let text = '';
  const el = {
    tag, children: [], dataset: {}, attrs: {}, hidden: false, className: '', type: '', accept: '', multiple: false, files: [], _id: '',
    get id() { return el._id; }, set id(v) { el._id = v; byId.set(v, el); },
    get textContent() { return text + el.children.map((c) => c.textContent).join(''); }, set textContent(v) { text = String(v); el.children = []; },
    appendChild(ch) { el.children.push(ch); return ch; }, insertBefore(ch, ref) { const i = el.children.indexOf(ref); el.children.splice(i < 0 ? el.children.length : i, 0, ch); return ch; },
    setAttribute(k, v) { el.attrs[k] = String(v); }, addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }, click() {},
  };
  return el;
};
const composer = mk('footer'); composer.className = 'composer';
const msg = mk('input'); msg.id = 'msg';
const doc = { createElement: mk, querySelector: (s) => (s === 'footer.composer' ? composer : null) };
const $ = (id) => byId.get(id) || null;
const pic = (n) => ({ name: `p${n}.png`, type: 'image/png', size: 1000, mark: `ZUMIPICTURE${n}${'QUJD'.repeat(12)}` }); // valid base64 characters

try {
  const { startFakeLlm } = await import('./fake-llm-sse.mjs');
  const { guardedFetch, cloudFetch, mirrorFetch, jevFetch, PROVIDER_ORIGINS } = await import('../tauri/sidecar/egress.mjs');
  const { createAiSettings } = await import('../tauri/sidecar/ai-settings.mjs');
  const { createAiCore } = await import('../tauri/sidecar/ai-core.mjs');
  const { createChatHost } = await import('../tauri/sidecar/chat-host.mjs');
  const { createSecretStores } = await import('../tauri/sidecar/secret-stores.mjs');
  const { FLAVOURS } = await import('../tauri/sidecar/flavour.mjs');
  const { MAX_REQUEST_FRAME_BYTES } = await import('../tauri/sidecar/protocol.mjs');
  const { initChatAttach } = await import('../src/renderer/chat-attach.js');
  const { createTalk } = await import('../src/renderer/talk/index.js');
  const loopback = require('./fixtures/fetch-to-loopback.cjs');
  const { createKeyStore } = require('../src/main/reflex-jev.js');
  const prov = require('../src/main/providers.js');

  const bodies = []; // every chat request the provider received
  const fake = await startFakeLlm({ firstMs: 1, intervalMs: 1, chunkChars: 16, log: () => {}, text: (body) => { bodies.push(body); return 'I can see the pictures.'; } });
  const base = async (url, init) => realFetch(loopback.rewrite(url, new URL(fake.url)), init);
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)), decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8') };
  const KEYS = { gemini: `AIza${'b'.repeat(35)}`, opencode: 'sk-opencodeabcdefghijklmnopqrstuvwxyz0123' };
  let n = 0;
  const hostFor = (providerId) => {
    const dir = path.join(tmpRoot, `h${++n}`); fs.mkdirSync(dir);
    const file = path.join(dir, 'settings.json');
    const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
    const set = (p) => { const next = { ...get(), ...p }; fs.writeFileSync(file, JSON.stringify(next)); return next; };
    set({ aiProvider: providerId, age18Confirmed: true });
    let host = null;
    const ai = createAiSettings({ dataDir: dir, settings: get, saveSettings: set, onChange: () => { if (host) host.rebuild(); } });
    ai.pin();
    const secretStores = async () => createSecretStores({ safeStorage, dataDir: dir });
    const aiCore = createAiCore({ ai, secretStores, dataDir: dir, log: () => {}, reflexEgress: false, jevFetch: jevFetch(base, false, () => {}) });
    const p = prov.PROVIDERS[providerId];
    createKeyStore({ safeStorage, dir, name: p.keyName, shape: p.keyShape }).write(KEYS[providerId]);
    host = createChatHost({ dataDir: dir, settings: get, saveSettings: set, ai, secretStores, safeStorage, flavour: { values: FLAVOURS.public }, aiCore, log: () => {}, memory: null, emit: () => true,
      egress: { provider: guardedFetch(base, PROVIDER_ORIGINS, () => {}), cloud: cloudFetch(base, null, () => {}), mirror: mirrorFetch(base, null, () => {}) } });
    host.rebuild();
    return host;
  };

  // The page: the real shim over a fake Tauri invoke that writes the request line (as the Rust host does) and hands it to the real host handler.
  const lines = []; // { bytes, frame }
  const pageFor = async (host) => {
    const invoke = async (_cmd, { method, args }) => {
      const line = JSON.stringify({ jsonrpc: '2.0', id: lines.length + 1, method, params: args });
      const frame = JSON.parse(line);
      lines.push({ bytes: Buffer.byteLength(line), frame });
      const h = host.handlers[frame.method];
      if (h) return h(...frame.params);
      if (/^(gcache|talk)\.(load|save|log)$/.test(frame.method)) return null; // the main process's own files and logs: not what is under test
      throw new Error(`not_implemented:${frame.method}`);
    };
    const window = { __TAURI__: { core: { invoke }, event: { listen: async () => () => {} } } };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'tauri', 'shim', 'zumi-shim.js'), 'utf8'), { window, Promise, URL, console, setTimeout, clearTimeout }, { filename: 'zumi-shim.js' });
    const noop = new Proxy(function () {}, { get: () => noop, apply: () => undefined });
    const ui = new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : () => undefined) });
    const keep = console.error; console.error = () => {}; // the rig probe fails on purpose (no model in node)
    const talk = await createTalk({ zumi: window.zumi, engine: noop, catalog: new Map(), loader: noop, camera: noop, prepareVrm: noop, ui });
    await talk.onModel({ url: 'data:application/octet-stream;base64,AAAA' });
    console.error = keep;
    return talk;
  };
  const attachFresh = () => {
    byId.clear(); composer.children = []; composer.appendChild(msg); byId.set('msg', msg);
    return initChatAttach($, { doc, t: (k) => k, apply: () => {}, readFile: async (f) => ({ mime: f.type, data: f.mark }), shrink: async () => null });
  };
  // app.js onSend's chat branch is this one call (asserted at the end against the source).
  const sendLikeApp = (attach, talk, text) => attach.sendVia(talk, text);
  const imagesIn = (body) => { const last = body.messages[body.messages.length - 1]; return Array.isArray(last.content) ? last.content.filter((c) => c.type === 'image_url').map((c) => c.image_url.url) : []; };

  // ---------- 1 picture and 4 pictures reach the provider ----------
  {
    const talk = await pageFor(hostFor('gemini'));
    ok(talk.enabled === true, '(the page is up: talk is enabled with a key)');
    for (const count of [1, 4]) {
      bodies.length = 0; lines.length = 0;
      const attach = attachFresh();
      const files = Array.from({ length: count }, (_, i) => pic(i + 1));
      for (const f of files) await attach.add(f);
      ok(attach.count() === count, `${count} picture(s) attached`);
      await sendLikeApp(attach, talk, 'What is in these pictures?');
      const turnLine = lines.find((l) => l.frame.method === 'talk.turn');
      ok(Boolean(turnLine) && Array.isArray(turnLine.frame.params[0].images) && turnLine.frame.params[0].images.length === count, `${count}: the rpc request line carries ${count} image(s)`, JSON.stringify(turnLine && Object.keys(turnLine.frame.params[0])));
      ok(Boolean(turnLine) && turnLine.bytes <= MAX_REQUEST_FRAME_BYTES, `${count}: the request line is inside the frame cap`, String(turnLine && turnLine.bytes));
      const sent = bodies.map(imagesIn).find((u) => u.length) || [];
      ok(sent.length === count && files.every((f, i) => sent[i] === `data:image/png;base64,${f.mark}`), `${count}: the provider's request holds the picture bytes, in order`, `${sent.length} image(s) in the provider body`);
      ok(attach.count() === 0, `${count}: the attachment control is empty after a good send`);
    }
    bodies.length = 0; lines.length = 0;
    await sendLikeApp(attachFresh(), talk, 'Just text.');
    const l = lines.find((x) => x.frame.method === 'talk.turn');
    ok(Boolean(l) && !('images' in l.frame.params[0]) && bodies.length > 0 && bodies.every((b) => imagesIn(b).length === 0), 'a turn with no picture sends no images field and no image part');
  }

  // ---------- a failed turn keeps the attachment ----------
  {
    const talk = await pageFor(hostFor('opencode')); // this provider's model is not known to read images: the host answers no_vision before any call
    bodies.length = 0; lines.length = 0;
    const attach = attachFresh();
    for (const i of [1, 2, 3, 4]) await attach.add(pic(i));
    await sendLikeApp(attach, talk, 'What is in these pictures?');
    ok(lines.some((l) => l.frame.method === 'talk.turn' && Array.isArray(l.frame.params[0].images) && l.frame.params[0].images.length === 4) && bodies.length === 0, 'no_vision: the four pictures reached the host and the provider was never called');
    ok(attach.count() === 4, 'no_vision: the four pictures are attached again after the failed turn');
    const again = attach.take();
    ok(again.length === 4 && again[0].data === pic(1).mark, '(and they are the same pictures)');
  }

  // ---------- app.js hands the pictures to the same function ----------
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  ok(/attach\.sendVia\(talk, text\)/.test(app) && !/talk\.send\(text, sent\)/.test(app), 'app.js onSend calls attach.sendVia(talk, text), the function this check drives');
  await fake.close();
} catch (e) {
  fail++; console.log(`FAIL threw: ${(e && e.stack) || e}`);
} finally {
  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
