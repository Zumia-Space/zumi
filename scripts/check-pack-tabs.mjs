#!/usr/bin/env node
// check:pack-tabs (MKT, owner 11-11: the app was switched to English and the room pack's sidebar tab still said "Phòng").
// A web-app pack's tab label follows the app language like the built-in tabs: English by default, the pack's own `vi`/`zh`
// label only when the app is in that language, and a language switch repaints it live (no restart, no pack reload).
// Runs pack-tabs.js against a minimal fake DOM and a stub `pack_list`; no browser, no network.
//   node scripts/check-pack-tabs.mjs
import { setLocale, getLocale } from '../src/renderer/i18n.js';

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}  ${detail}`); } };

// ---------- the smallest DOM pack-tabs.js touches ----------
function node(tag) {
  const n = {
    tag, children: [], dataset: {}, attrs: {}, listeners: {}, hidden: false, className: '', title: '', textContent: '', innerHTML: '', parent: null,
    classList: { contains: (c) => n.className.split(/\s+/).includes(c) },
    setAttribute(k, v) { n.attrs[k] = String(v); },
    addEventListener(k, f) { (n.listeners[k] ||= []).push(f); },
    appendChild(c) { c.parent = n; n.children.push(c); return c; },
    append(...cs) { for (const c of cs) n.appendChild(c); },
    insertBefore(c, ref) { c.parent = n; const i = n.children.indexOf(ref); n.children.splice(i < 0 ? n.children.length : i, 0, c); return c; },
    remove() { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; },
    querySelector(sel) { return sel === '.spacer' ? n.children.find((c) => c.className === 'spacer') || null : null; },
  };
  return n;
}
const sidebar = node('nav'); const spacer = node('div'); spacer.className = 'spacer'; sidebar.appendChild(spacer);
const main = node('main');
const docListeners = {};
globalThis.document = {
  documentElement: { lang: 'en' },
  getElementById: (id) => (id === 'sidebar' ? sidebar : id === 'stage-reason-slot' ? slot : null),
  dispatchEvent: (ev) => { dispatched.push(ev.type); return true; },
  querySelector: (sel) => (sel === 'main' ? main : null),
  createElement: (tag) => node(tag),
  addEventListener: (k, f) => { (docListeners[k] ||= []).push(f); },
};
const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (f, ms) => { const h = realSetInterval(f, ms); h.unref?.(); timers.push(h); return h; };
const ROOM = { id: 'plugin.room-preview', version: '0.1.2', partition: 'pack:plugin.room-preview', src: 'zumipack://plugin.room-preview/ui/index.html', label: { en: 'Room', vi: 'Phòng' }, stage: true };
const BARE = { id: 'plugin.canary', version: '1.0.0', partition: 'pack:plugin.canary', src: 'zumipack://plugin.canary/ui/index.html', label: { en: 'Canary' } };
const BUNDLED = { id: 'plugin.bundled-demo', version: '0.1.3', dev: true, bundled: true, partition: 'pack:plugin.bundled-demo', src: 'zumipack://plugin.bundled-demo/ui/index.html', label: { en: 'Bundled' } };
const DEVDIR = { id: 'plugin.dev-demo', version: '9.9.9', dev: true, partition: 'pack:plugin.dev-demo', src: 'zumipack://plugin.dev-demo/ui/index.html', label: { en: 'Dev' } };
let fallbackCb = null;
const produced = [];
const dispatched = [];
const slot = (() => { const e = { tag: 'div', children: [], dataset: {}, className: '', parent: null, appendChild(c) { c.parent = e; e.children.push(c); return c; } }; return e; })();
globalThis.window = { zumi: { stage: { produce: async (op, payload) => { produced.push([op, payload]); return { active: false }; }, onFallback: (cb) => { fallbackCb = cb; return () => { fallbackCb = null; }; } } }, __TAURI__: { core: { invoke: async (cmd) => (cmd === 'pack_list' ? [ROOM, BARE, BUNDLED, DEVDIR] : null) } }, addEventListener() {} };

// The app's own locale switch: i18n.setLocale fires the listeners, and apply() sets <html lang> (zh -> zh-CN).
const switchTo = (lang) => { setLocale(lang); document.documentElement.lang = getLocale() === 'zh' ? 'zh-CN' : getLocale(); };
const tabOf = (id) => sidebar.children.find((c) => c.dataset.tab === `pack-${id}`);
const labelOf = (id) => { const b = tabOf(id); return b && b.children[0] ? b.children[0].textContent : null; };
const panelVersionOf = (id) => { const p = main.children.find((c) => c.id === `tab-pack-${id}`); return p ? p.children[0].children[1].textContent : null; };
const panelTitleOf = (id) => { const p = main.children.find((c) => c.id === `tab-pack-${id}`); return p ? p.children[0].children[0].textContent : null; };

// The owner's case: Zumi started in Vietnamese, then he picked English.
switchTo('vi');
const { initPackTabs } = await import('../src/renderer/pack-tabs.js');
let zumiTabOpened = 0;
const tabs = initPackTabs({ openZumiTab() { zumiTabOpened++; } });
await tabs.refresh();
ok(labelOf(ROOM.id) === 'Phòng', 'app in Vietnamese: the room tab says Phòng', labelOf(ROOM.id));
switchTo('en');
ok(labelOf(ROOM.id) === 'Room', 'switch to English: the room tab says Room at once', labelOf(ROOM.id));
ok(tabOf(ROOM.id).title === 'Room', 'switch to English: the tooltip says Room', tabOf(ROOM.id).title);
ok(panelTitleOf(ROOM.id) === 'Room', 'switch to English: the panel title says Room', panelTitleOf(ROOM.id));
switchTo('zh');
ok(labelOf(ROOM.id) === 'Room', 'Chinese with no zh label: English, the default', labelOf(ROOM.id));
switchTo('vi');
ok(labelOf(ROOM.id) === 'Phòng', 'back to Vietnamese: Phòng again', labelOf(ROOM.id));
ok(labelOf(BARE.id) === 'Canary', 'a pack with only an English label keeps it in Vietnamese', labelOf(BARE.id));
await tabs.refresh();
ok(sidebar.children.filter((c) => c.dataset.tab === `pack-${ROOM.id}`).length === 1, 'a refresh after a switch adds no second tab');
switchTo('en');
await tabs.refresh();
ok(labelOf(ROOM.id) === 'Room', 'a refresh after a switch keeps the active language', labelOf(ROOM.id));

// The header names where a pack came from: the installer's own pack says "bundled", a --pack-dir folder says "dev folder", a store pack neither.
ok(/bundled/.test(panelVersionOf(BUNDLED.id)) && !/dev folder/.test(panelVersionOf(BUNDLED.id)), 'a pack the installer carries reads "bundled", not "dev folder"', panelVersionOf(BUNDLED.id));
ok(/dev folder/.test(panelVersionOf(DEVDIR.id)), 'a --pack-dir pack still reads "dev folder"', panelVersionOf(DEVDIR.id));
ok(!/bundled|dev folder/.test(panelVersionOf(ROOM.id)), 'a store pack reads neither', panelVersionOf(ROOM.id));

// Room live B (ADR D2): the 3D room's caption is shown in the host UI under the stage, never inside the guest. Only a stage pack gets one.
{
  const panel = (id) => main.children.find((c) => c.id === `tab-pack-${id}`);
  const caption = panel(ROOM.id).children.find((c) => c.className === 'pack-caption');
  ok(Boolean(caption) && panel(ROOM.id).children.indexOf(caption) === panel(ROOM.id).children.length - 1, 'a stage pack gets a caption line under its stage (host UI, D2)');
  ok(!panel(BARE.id).children.some((c) => c.className === 'pack-caption'), 'a pack without stage gets no caption line');
  for (const f of docListeners['zumi:caption'] || []) f({ detail: 'Xin chao, minh la Zumi.' });
  ok(caption && caption.textContent === 'Xin chao, minh la Zumi.', 'the reply caption lands in the caption line', caption && caption.textContent);
  for (const f of docListeners['zumi:caption'] || []) f({ detail: '' });
  ok(caption && caption.textContent === '', 'an empty caption clears it');
  ok(!panel(BARE.id).children.some((c) => c.textContent === 'Xin chao, minh la Zumi.'), 'the caption never reaches a pack without stage');
}

// Room live B F1 (ADR D8): when the host closes the 3D guest it announces `stage:fallback {pack, reason}`; the app shows the video room
// (the Zumi tab) and one line saying why, carrying the reason code.
{
  const line = () => slot.children.find((c) => c.className === 'stage-reason');
  ok(typeof fallbackCb === 'function', 'the tab strip listens for stage:fallback');
  const before = zumiTabOpened;
  if (fallbackCb) fallbackCb({ pack: ROOM.id, reason: 'bench' });
  ok(zumiTabOpened === before + 1, 'a fallback shows the video room (the Zumi tab)');
  ok(Boolean(line()) && line().dataset.reason === 'bench', 'the reason line carries the code', line() && JSON.stringify(line().dataset));
  ok(line() && /video room/.test(line().textContent) && /slow/.test(line().textContent), 'the reason line says why in plain words', line() && line().textContent);
  if (fallbackCb) fallbackCb({ pack: ROOM.id, reason: 'guest_gone' });
  ok(slot.children.filter((c) => c.className === 'stage-reason').length === 1 && line().dataset.reason === 'guest_gone', 'one line at a time, replaced by the newest reason');
  // the way back and the dismiss, on the reason line (Opus gate must-fix 2 and 3): Try anyway, Test again, a close button; each button arms the
  // host and then asks the Zumi tab to show the 3D room (zumi:room3d-enter); the line sits in the slot between the stage and the message box
  {
    const find = (n, cls) => { if (n.className === cls) return n; for (const c of n.children || []) { const r = find(c, cls); if (r) return r; } return null; };
    const press = async (cls) => { fallbackCb({ pack: ROOM.id, reason: 'no_ready' }); const b = line() ? find(line(), cls) : null; produced.length = 0; dispatched.length = 0; if (b) await b.listeners.click[0](); return b; };
    fallbackCb({ pack: ROOM.id, reason: 'no_ready' });
    ok(Boolean(find(line(), 'stage-retry')) && /anyway/i.test(find(line(), 'stage-retry').textContent), 'the reason line carries a Try 3D anyway button');
    ok(Boolean(find(line(), 'stage-again')) && /again/i.test(find(line(), 'stage-again').textContent), 'and a Test again button');
    ok(Boolean(find(line(), 'stage-dismiss')), 'and a dismiss button');
    ok(slot.children.includes(line()) && !main.children.includes(line()), 'the line is in the slot between the stage and the message box, not an overlay on the main area');
    const rows = [['stage-retry', 'tryAnyway'], ['stage-again', 'testAgain']];
    for (const [cls, op] of rows) {
      await press(cls);
      ok(produced.length === 1 && produced[0][0] === op, `${cls} arms exactly one host action (stage.produce ${op})`, JSON.stringify(produced));
      ok(dispatched.includes('zumi:room3d-enter') && !line(), `${cls}: the Zumi tab is asked to show the 3D room and the line goes away`, JSON.stringify(dispatched));
    }
    fallbackCb({ pack: ROOM.id, reason: 'no_ready' });
    produced.length = 0;
    await find(line(), 'stage-dismiss').listeners.click[0]();
    ok(!line() && produced.length === 0, 'dismiss removes the line and asks the host nothing');
    // one guest per pack: the Room tab viewer stays closed while the Zumi tab shows the 3D room
    globalThis.__zumiRoom3dActive = true;
    const roomPanel = main.children.find((c) => c.id === `tab-pack-${ROOM.id}`);
    const hostEl = roomPanel.children.find((c) => c.className === 'pack-host');
    hostEl.children.filter((c) => c.tag === 'webview').forEach((c) => c.remove());
    for (const f of docListeners['zumi:tab'] || []) f({ detail: `pack-${ROOM.id}` });
    ok(hostEl.children.filter((c) => c.tag === 'webview').length === 0, 'the Room tab viewer does not open a second guest while the Zumi tab shows the 3D room');
    globalThis.__zumiRoom3dActive = false;
    // alpha.7 S3: the Room tab viewer keeps the room's own controls (Tour/Photo/Walk...): it opens the pack page as listed, without `?ui=0`
    for (const f of docListeners['zumi:tab'] || []) f({ detail: `pack-${ROOM.id}` });
    const roomWv = hostEl.children.find((c) => c.tag === 'webview');
    ok(Boolean(roomWv) && roomWv.attrs.src === ROOM.src, 'the Room tab viewer opens the room page as listed (its dev toolbar stays there)', roomWv && roomWv.attrs.src);
  }
  if (fallbackCb) fallbackCb({ pack: ROOM.id, reason: 'something_new' });
  ok(line() && /video room/.test(line().textContent), 'an unknown reason still gets a plain line');
}

// Room 2 (T-31-ROOM room2-holo, PACK-PLAN C4): a stage pack's Room tab header carries the Room 1 / Room 2 switch. The host owns the pick (the
// Zumi tab's guest has no controls): it is remembered in the main webview's storage, opens the pack page with exactly `?room=2`, and survives
// a restart. Room 1 is "no room in the query".
{
  const has = (n, cls) => String(n.className).split(/\s+/).includes(cls);
  const find = (n, cls) => { if (has(n, cls)) return n; for (const c of n.children || []) { const r = find(c, cls); if (r) return r; } return null; };
  const findAll = (n, cls, out = []) => { if (has(n, cls)) out.push(n); for (const c of n.children || []) findAll(c, cls, out); return out; };
  const bag = new Map();
  globalThis.window.localStorage = { getItem: (k) => (bag.has(k) ? bag.get(k) : null), setItem: (k, v) => bag.set(k, String(v)), removeItem: (k) => bag.delete(k) };
  const panelOf = (id) => main.children.find((c) => c.id === `tab-pack-${id}`);
  const hostOf = (id) => panelOf(id).children.find((c) => c.className === 'pack-host');
  const wvOf = (id) => hostOf(id).children.find((c) => c.tag === 'webview');
  const btn = (n) => findAll(panelOf(ROOM.id), 'room-switch-btn').find((b) => b.dataset.room === String(n));
  const isOn = (n) => Boolean(btn(n)) && btn(n).attrs['aria-pressed'] === 'true';
  ok(Boolean(find(panelOf(ROOM.id), 'room-switch')) && findAll(panelOf(ROOM.id), 'room-switch-btn').length === 2, 'a stage pack gets a Room 1 / Room 2 switch in its Room tab header');
  ok(!find(panelOf(BARE.id), 'room-switch'), 'a pack without stage gets no room switch');
  ok(isOn(1) && !isOn(2), 'the switch starts on Room 1');
  for (const f of docListeners['zumi:tab'] || []) f({ detail: `pack-${ROOM.id}` });
  ok(Boolean(wvOf(ROOM.id)) && wvOf(ROOM.id).attrs.src === ROOM.src, 'Room 1 opens the page as listed (no room in the query)', wvOf(ROOM.id) && wvOf(ROOM.id).attrs.src);
  const btn2 = btn(2);
  if (btn2) btn2.listeners.click[0]();
  ok(isOn(2) && !isOn(1), 'a click on Room 2 turns it on');
  ok(bag.get('zumi.room3d.room') === '2', 'the pick is remembered (main webview storage)', JSON.stringify([...bag]));
  ok(Boolean(wvOf(ROOM.id)) && wvOf(ROOM.id).attrs.src === `${ROOM.src}?room=2`, 'the Room tab guest reopens on exactly ?room=2, one guest', wvOf(ROOM.id) && wvOf(ROOM.id).attrs.src);
  ok(hostOf(ROOM.id).children.filter((c) => c.tag === 'webview').length === 1, 'the switch never leaves two guests open');
  // a restart: a new tab strip over the same storage opens Room 2 again
  for (const c of [...sidebar.children]) if ((c.dataset || {}).tab === `pack-${ROOM.id}`) c.remove();
  panelOf(ROOM.id).remove();
  const tabs2 = initPackTabs({ openZumiTab() {} });
  await tabs2.refresh();
  ok(isOn(2) && !isOn(1), 'after a restart the switch is still on Room 2');
  for (const f of docListeners['zumi:tab'] || []) f({ detail: `pack-${ROOM.id}` });
  ok(Boolean(wvOf(ROOM.id)) && wvOf(ROOM.id).attrs.src === `${ROOM.src}?room=2`, 'after a restart the Room tab opens Room 2', wvOf(ROOM.id) && wvOf(ROOM.id).attrs.src);
  btn(1).listeners.click[0]();
  ok(isOn(1) && wvOf(ROOM.id).attrs.src === ROOM.src && !bag.has('zumi.room3d.room'), 'back to Room 1: the page as listed, nothing stored');
  // blocked storage: the switch still works for this run and nothing throws
  globalThis.window.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  let threw = false; try { btn(2).listeners.click[0](); } catch { threw = true; }
  ok(!threw && wvOf(ROOM.id).attrs.src === `${ROOM.src}?room=2`, 'with the storage blocked the switch still works for this run');
  globalThis.window.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
}

for (const h of timers) clearInterval(h);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
