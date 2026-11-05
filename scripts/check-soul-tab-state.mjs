// check:soul-tab-state (T-31 alpha.13, REVIEW T1). A changed address pair repaints through the locale listeners, and Brain's listener re-enters
// renderSoulTab on the same host. Runs the real soul.js + i18n.js on a small stub DOM, with a stub host answer: no network, no model.
//   1. a save or undo that changes the pair keeps its status line;  2. a draft survives a re-entry;  3. leaving and coming back shows no old status.
import fs from 'node:fs';
import { TABLES } from '../src/renderer/i18n.js';

const nap = (ms = 5) => new Promise((r) => setTimeout(r, ms));
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.text = ''; this.dataset = {}; this.style = {}; this.attrs = {}; this.listeners = {}; this.parent = null; this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false }; }
  set textContent(v) { for (const c of this.children) c.parent = null; this.children = []; this.text = String(v); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  append(...n) { for (const c of n) this.appendChild(c); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(n, f) { (this.listeners[n] ||= []).push(f); }
  click() { for (const f of this.listeners.click || []) f({ preventDefault() {} }); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() {}
  closest() { return null; }
  get scrollHeight() { return 10; }
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const r = c.find(pred); if (r) return r; } return null; }
}
globalThis.document = { body: new El('body'), createElement: (t) => new El(t), createElementNS: (_, t) => new El(t), addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] };
globalThis.window = globalThis;

const soulOf = (selfWord, userWord, persona = '') => ({ name: 'Zumi', ownerName: '', selfWord, userWord, role: 'r', style: 's', persona, replyLang: 'auto', template: 'custom' });
let stored = soulOf('em', 'anh');
const view = () => ({ soul: { ...stored }, onboarded: true, canUndo: true, history: [], templates: [], defaults: {}, limits: {}, preview: 'p' });
window.zumi = { soul: {
  get: async () => { await nap(2); return view(); },
  save: async (p) => { stored = { ...stored, ...p }; await nap(2); return { ok: true, soul: { ...stored } }; },
  undo: async () => { stored = soulOf('em', 'anh'); await nap(2); return { ok: true, soul: { ...stored } }; },
} };
const { setAddress, setLocale, onLocaleChange, t } = await import('../src/renderer/i18n.js');
const { renderSoulTab } = await import('../src/renderer/next/brain/soul.js');
setLocale('vi');

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const statusOf = (h) => { const s = h.find((n) => n.className && n.className.includes('nb-soul-status')); return s ? s.textContent : null; };
const byAct = (h, a) => h.find((n) => n.dataset && n.dataset.act === a);
const field = (h, f) => h.find((n) => n.dataset && n.dataset.field === f);
const type = (h, f, v) => { const i = field(h, f); i.value = v; for (const fn of i.listeners.input) fn(); };
const change = async () => { await nap(1); document.body.find((n) => n.tag === 'button' && n.textContent === t('soul.warn.change')).click(); };

function open(start) {
  stored = start; setAddress(stored);
  const host = new El('div');
  const off = onLocaleChange(() => renderSoulTab(host)); // exactly next/brain/brain.js: the Brain listener re-enters the tab on the same host
  renderSoulTab(host);
  return { host, off };
}

{
  const { host, off } = open(soulOf('em', 'anh'));
  await nap(10);
  byAct(host, 'edit').click(); type(host, 'userWord', 'cậu'); byAct(host, 'save').click(); await change();
  await nap(60);
  ok(statusOf(host) === t('soul.saved'), 'a save that changes the pair keeps its status line', JSON.stringify(statusOf(host)));
  ok(field(host, 'userWord').value === 'cậu' && t('talk.whoUser') === 'Cậu nói', 'the form and the page show the new word');
  byAct(host, 'undo').click();
  await nap(60);
  ok(statusOf(host) === t('soul.undone'), 'an undo that changes the pair keeps its status line', JSON.stringify(statusOf(host)));
  off();
}
{
  const { host, off } = open(soulOf('em', 'anh'));
  await nap(10);
  byAct(host, 'edit').click(); type(host, 'persona', 'bản nháp');
  setAddress(soulOf('tớ', 'cậu'));
  await nap(20);
  ok(field(host, 'persona') && field(host, 'persona').value === 'bản nháp' && field(host, 'persona').readOnly === false, 'a draft survives a re-entry');
  off();
}
{
  const { host, off } = open(soulOf('em', 'anh'));
  await nap(10);
  byAct(host, 'edit').click(); type(host, 'persona', 'x'); byAct(host, 'save').click(); await change();
  await nap(30);
  ok(statusOf(host) === t('soul.saved'), 'a save of another field keeps its status line');
  renderSoulTab(host); // the person left the tab and came back
  await nap(20);
  ok(statusOf(host) === '', 'coming back to the tab shows no old status', JSON.stringify(statusOf(host)));
  off();
}
ok(TABLES.vi['soul.saved'] && TABLES.vi['soul.undone'], 'the status lines exist');
// Source row: the measured run on the real bundle at 1366x768 is alpha13-pronoun-0211/work/review-probe/probe4b.mjs.
ok(/const y = body\.scrollTop; paint\(\); body\.scrollTop = y;/.test(fs.readFileSync(new URL('../src/renderer/next/brain/brain.js', import.meta.url), 'utf8')), 'Brain keeps the scroll across a repaint in place (REVIEW U1)');

console.log(`\ncheck:soul-tab-state ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
