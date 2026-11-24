// R6e M1 (gate R6c-C-item5): an attached picture must get through the rpc frame. talk.turn carries the base64 in one JSON line and the host
// refuses a line over MAX_REQUEST_FRAME_BYTES (4,000,000). Before this fix a 5 MB phone photo (6,990,508 base64 characters) went into the line
// as it was: refused by the host, the chat showed the generic error and the attachment was gone. check:chat-images calls chat-brain directly and
// never meets the frame, so this check builds the REAL request line, measures it against the cap, and sends it into the REAL sidecar process.
//   node scripts/check-chat-image-frame.mjs     (exit 1 on any failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_REQUEST_FRAME_BYTES } from '../tauri/sidecar/protocol.mjs';
import { initChatAttach } from '../src/renderer/chat-attach.js';
import { fitToBudget, IMAGE_B64_MAX } from '../src/renderer/image-fit.js';
import { failureLineKey } from '../src/renderer/talk/error-line.js';
import { TABLES } from '../src/renderer/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-image-frame-'));

// ---- a minimal DOM, as in check-chat-images ----
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
const msg = mk('input'); msg.id = 'msg'; composer.appendChild(msg);
const doc = { createElement: mk, querySelector: (s) => (s === 'footer.composer' ? composer : null) };
const $ = (id) => byId.get(id) || null;
const t = (k) => k;

// A 12 MP phone photo of 5 MB: its base64 is 6,990,508 characters. The encoder models a JPEG: bytes ~ pixels x quality x 0.5.
const PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_B64 = 'A'.repeat(Math.ceil(PHOTO_BYTES / 3) * 4);
const W = 4032; const H = 3024;
const modelEncode = async (w, h, q) => 'A'.repeat(Math.ceil((w * h * q * 0.5) / 3) * 4);
const shrink = async () => fitToBudget(W, H, modelEncode);
const readFile = async (f) => ({ mime: f.type, data: PHOTO_B64 });

const frameOf = (images, extra = {}) => {
  const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(20000) })); // a long reply is 20 KB
  const payload = { turnId: 'a'.repeat(32), message: 'What is in these pictures? '.repeat(80), history, images, ...extra };
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'talk.turn', params: [payload] }); // serde_json's compact form, as the host writes it
};

function startSidecar() {
  const child = spawn(process.execPath, [path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), '--data-dir', path.join(tmp, 'data'), '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => { try { lines.push(JSON.parse(l)); } catch { /* not a frame */ } });
  child.stderr.on('data', () => {});
  const waitFor = (fn, ms = 30000) => new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => { const v = lines.find(fn); if (v) return resolve(v); if (Date.now() - t0 > ms) return reject(new Error('timeout')); setTimeout(tick, 20); }; tick(); });
  return { child, waitFor, send: (line) => child.stdin.write(`${line}\n`) };
}

try {
  // ---------- the control: what the old attach did ----------
  const oldLine = frameOf([{ mime: 'image/jpeg', data: PHOTO_B64 }]);
  ok(PHOTO_B64.length === 6_990_508, 'the 5 MB photo is 6,990,508 base64 characters', String(PHOTO_B64.length));
  ok(Buffer.byteLength(oldLine) > MAX_REQUEST_FRAME_BYTES, 'CONTROL: the photo as it was (unshrunk) makes a request line over the frame cap', String(Buffer.byteLength(oldLine)));
  console.log('  line bytes: old one photo ' + Buffer.byteLength(oldLine));

  // ---------- the fix: the attach control shrinks it before it is held ----------
  const ctl = initChatAttach($, { doc, t, apply: () => {}, readFile, shrink });
  for (let i = 0; i < 4; i++) await ctl.add({ name: `p${i}.jpg`, type: 'image/jpeg', size: PHOTO_BYTES });
  ok(ctl.count() === 4, 'four 5 MB photos are accepted (the picture limit is on what is sent, not on the file)');
  const taken = ctl.take();
  const sizes = taken.map((x) => x.data.length);
  ok(sizes.every((n) => n > 0 && n <= IMAGE_B64_MAX) && taken.every((x) => x.mime === 'image/jpeg'), 'every held picture is re-encoded to at most the per-picture cap', sizes.join(','));
  const line = frameOf(taken);
  const bytes = Buffer.byteLength(line);
  console.log('  line bytes: new four photos ' + bytes + ', per-picture b64 ' + sizes.join('/'));
  ok(bytes <= MAX_REQUEST_FRAME_BYTES, 'four shrunk photos + a long message + six 20 KB history lines fit the frame cap', `${bytes} <= ${MAX_REQUEST_FRAME_BYTES}`);
  ok(4 * IMAGE_B64_MAX + 6 * 20000 + 4000 < MAX_REQUEST_FRAME_BYTES * 0.7, 'the per-picture cap leaves at least 30% of the frame for the message and history');

  // a picture that cannot be shrunk is refused in words and not held
  byId.clear();
  const composer2 = mk('footer'); composer2.className = 'composer'; const msg2 = mk('input'); msg2.id = 'msg'; composer2.appendChild(msg2);
  const ctl2 = initChatAttach($, { doc: { createElement: mk, querySelector: () => composer2 }, t, apply: () => {}, readFile, shrink: async () => null });
  await ctl2.add({ name: 'huge.png', type: 'image/png', size: PHOTO_BYTES });
  ok(ctl2.count() === 0 && $('chat-attach-note').textContent === 'chat.attach.cannotShrink', 'a picture that cannot be shrunk is refused in words, not attached too big');
  const small = 'QUJD'.repeat(1000);
  const ctl3 = initChatAttach($, { doc: { createElement: mk, querySelector: () => composer2 }, t, apply: () => {}, readFile: async (f) => ({ mime: f.type, data: small }), shrink: async () => { throw new Error('must not run'); } });
  ok(ctl3 === null, "(a page that has the control already builds no second one)");

  // a failed send gives the pictures back
  ctl.restore(taken);
  ok(ctl.count() === 4, 'restore(): the pictures of a failed send are attached again');
  ok(ctl.take().length === 4, '(and are taken again for the retry)');

  // ---------- the real sidecar reads the real line ----------
  const sc = startSidecar();
  await sc.waitFor((m) => m.method === 'ready');
  sc.send(line);
  const answer = await sc.waitFor((m) => m.id === 1);
  ok(answer.result && answer.result.ok === false && answer.result.error && answer.result.error.code === 'no_vision', 'the sidecar accepts the fitted frame and answers it (no key: no_vision, never an oversize fatal)', JSON.stringify(answer).slice(0, 200));
  ok(!sc.child.killed, '(sidecar still running)');
  sc.child.stdin.end(); sc.child.kill();

  const sc2 = startSidecar();
  await sc2.waitFor((m) => m.method === 'ready');
  sc2.send(oldLine);
  const fatal = await sc2.waitFor((m) => m.method === 'fatal');
  ok(/frame_too_large/.test(fatal.params && fatal.params.message), 'CONTROL: the unshrunk line is a fatal frame_too_large at the sidecar', JSON.stringify(fatal.params));
  sc2.child.kill();

  // ---------- the words ----------
  ok(failureLineKey({ code: 'too_large' }) === 'app.tooLarge', 'a turn the host refused for size shows its own line (too_large)');
  for (const lang of ['en', 'vi', 'zh']) {
    const miss = ['app.tooLarge', 'chat.attach.cannotShrink', 'chat.attach.tooBig', 'app.badImage'].filter((k) => !TABLES[lang][k]);
    ok(miss.length === 0, `${lang}: the size words exist`, miss.join(','));
    ok(/450/.test(TABLES[lang]['app.tooLarge']) && /450/.test(TABLES[lang]['chat.attach.cannotShrink']) && /20/.test(TABLES[lang]['chat.attach.tooBig']), `${lang}: the lines state the real limits (about 450 KB per picture, 20 MB per file)`);
    ok(!/5 MB/.test(TABLES[lang]['app.badImage']) && !/5 MB/.test(TABLES[lang]['chat.attach.tooBig']), `${lang}: the old "5 MB" promise is gone`);
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log(`NOTE temp dir not removed: ${e.message}`); }
}
console.log(`\ncheck:chat-image-frame ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
