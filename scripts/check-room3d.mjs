// Fix round 2 (Opus gate must-fix 1): the 3D room is a choice in the Zumi tab's own Room list. Picking it shows the stage guest inside the Zumi
// tab's stage; the tab's message box and mic are not touched; the caption row is mirrored under the guest in the host UI; the pick survives a
// restart; a fallback closes the guest but keeps the pick; the Room tab's viewer stays closed while this view is on.
//   node scripts/check-room3d.mjs
import assert from 'node:assert/strict';
import { createRoom3d, ROOM3D_VALUE } from '../src/renderer/room3d.js';

let n = 0;
const pass = (name) => { n++; console.log(`PASS ${name}`); };

function node(tag) {
  const e = {
    tag, children: [], attrs: {}, listeners: {}, className: '', id: '', textContent: '', parent: null,
    setAttribute(k, v) { e.attrs[k] = String(v); },
    addEventListener(k, f) { (e.listeners[k] ||= []).push(f); },
    appendChild(c) { if (c.parent) c.remove(); c.parent = e; e.children.push(c); return c; }, // a DOM append MOVES a node that has a parent
    append(...cs) { for (const c of cs) e.appendChild(c); },
    remove() { if (e.parent) e.parent.children.splice(e.parent.children.indexOf(e), 1); e.parent = null; },
    insertBefore(c, ref) { if (c.parent) c.remove(); c.parent = e; const i = ref ? e.children.indexOf(ref) : -1; if (i < 0) e.children.push(c); else e.children.splice(i, 0, c); return c; },
    get parentNode() { return e.parent; },
    get nextSibling() { if (!e.parent) return null; const sib = e.parent.children; return sib[sib.indexOf(e) + 1] || null; },
  };
  return e;
}
const find = (root, pred) => { if (pred(root)) return root; for (const c of root.children) { const r = find(c, pred); if (r) return r; } return null; };

function rig({ packs = [{ id: 'plugin.room-preview', src: 'zumipack://plugin.room-preview/ui/index.html', partition: 'pack:plugin.room-preview', stage: true }], stored = null, room = null } = {}) {
  const docListeners = {};
  const doc = {
    createElement: (t) => node(t),
    getElementById: (id) => find(stageEl, (e) => e.id === id),
    addEventListener: (k, f) => { (docListeners[k] ||= []).push(f); },
    removeEventListener: (k, f) => { docListeners[k] = (docListeners[k] || []).filter((x) => x !== f); },
    dispatchEvent(ev) { for (const f of docListeners[ev.type] || []) f(ev); return true; },
  };
  const bag = new Map([...(stored ? [['zumi.room3d', stored]] : []), ...(room ? [['zumi.room3d.room', room]] : [])]);
  const storage = { getItem: (k) => (bag.has(k) ? bag.get(k) : null), setItem: (k, v) => bag.set(k, v), removeItem: (k) => bag.delete(k) };
  const stageEl = node('div'); stageEl.id = 'stage';
  // the Zumi tab's own talk UI, as in index.html: the subtitle of Zumi's own lines, the heard line, the talk box (status, Retry voice)
  for (const [tag, id] of [['div', 'heard'], ['div', 'say-line'], ['div', 'demo-banner'], ['div', 'talk'], ['aside', 'analysis']]) { const el = node(tag); el.id = id; stageEl.appendChild(el); }
  const retry = node('button'); retry.id = 'talk-retry-voice'; find(stageEl, (e) => e.id === 'talk').appendChild(retry);
  const composer = node('footer'); composer.className = 'composer';
  const active = [];
  const r = createRoom3d({ stageEl, listPacks: async () => packs, storage, onActive: (on) => active.push(on), doc });
  return { r, doc, docListeners, storage: bag, stageEl, composer, active };
}

{
  const k = rig({ packs: [{ id: 'plugin.other', stage: false }] });
  assert.equal(await k.r.refresh(), false);
  assert.equal(k.r.available(), false, 'no first-party stage pack, no 3D entry in the room list');
  k.r.enter();
  assert.equal(find(k.stageEl, (e) => e.id === 'stage3d'), null, 'and nothing is built');
  pass('no stage pack, no entry');
}
{
  const k = rig();
  assert.equal(ROOM3D_VALUE, '3d');
  assert.equal(await k.r.refresh(), true);
  assert.equal(k.r.available(), true, 'a stage pack makes the 3D room a choice in the list');
  k.r.enter();
  const box = find(k.stageEl, (e) => e.id === 'stage3d');
  assert.ok(box, 'the 3D view is built inside the Zumi tab stage');
  const wv = find(box, (e) => e.tag === 'webview');
  // alpha.7 S3: the Zumi tab opens the room with its "no controls" flag (ui=0): no Tour/Photo/Walk toolbar, no photo mode to land in.
  assert.deepEqual([wv.attrs.src, wv.attrs.partition], ['zumipack://plugin.room-preview/ui/index.html?ui=0', 'pack:plugin.room-preview'], 'it hosts the pack guest from the pack list row, with the no-controls flag');
  assert.deepEqual(box.children.map((c) => c.className), ['stage3d-view', 'stage3d-caption', 'stage3d-host'], 'the guest view, the caption and the talk row are separate rows: nothing the user reads sits under the native guest');
  assert.equal(find(box, (e) => e.tag === 'input' || e.tag === 'textarea'), null, 'no second chat UI: the 3D view holds no input');
  assert.equal(k.composer.children.length, 0, 'the tab composer is not touched');
  assert.equal(k.r.active, true);
  assert.deepEqual(k.active, [true], 'the main renderer is told to pause (D1)');
  assert.equal(globalThis.__zumiRoom3dActive, true, 'the Room tab viewer sees it and stays closed');
  assert.equal(k.storage.get('zumi.room3d'), '1', 'the pick is remembered');
  k.doc.dispatchEvent({ type: 'zumi:caption', detail: 'Hello from Zumi' });
  assert.equal(find(box, (e) => e.className === 'stage3d-caption').textContent, 'Hello from Zumi', 'the reply caption is mirrored under the guest');
  pass('pick shows the guest in the Zumi tab, composer untouched, caption mirrored, pick remembered');

  k.r.leave({ forget: true });
  assert.equal(find(k.stageEl, (e) => e.id === 'stage3d'), null, 'leaving removes the guest view (the shim closes the guest)');
  assert.equal(k.storage.get('zumi.room3d'), undefined, 'picking another room forgets the pick');
  assert.equal(globalThis.__zumiRoom3dActive, false);
  assert.deepEqual(k.active, [true, false]);
  k.doc.dispatchEvent({ type: 'zumi:caption', detail: 'late' });
  pass('leave: view removed, pick forgotten, caption listener released');
}
{
  const k = rig();
  await k.r.refresh();
  k.r.enter();
  const wv = find(k.stageEl, (e) => e.tag === 'webview');
  k.r.leave(); // a fallback closes the guest but keeps the pick
  assert.equal(k.storage.get('zumi.room3d'), '1', 'a fallback keeps the pick, so the next start tries again');
  assert.equal(k.r.active, false);
  void wv;
  const again = rig({ stored: '1' });
  await again.r.refresh();
  again.r.restore();
  assert.equal(again.r.active, true, 'after a restart the 3D room is still the chosen room');
  const noPack = rig({ stored: '1', packs: [] });
  await noPack.r.refresh();
  noPack.r.restore();
  assert.equal(noPack.r.active, false, 'a remembered pick with no pack installed does nothing');
  pass('persistence across a restart; a fallback keeps the pick');
}
{
  // Room 2 (PACK-PLAN C4): the 3D room is Room 1 or Room 2 of the same pack. The host owns the choice (the guest runs with ?ui=0 and has no
  // controls): it opens the pack page with exactly `?room=2`, remembers the pick in its own storage under a key of its own (so picking Room 2
  // never turns the 3D room on by itself), keeps it over a fallback and a restart, and a pick while the view is on reopens the one guest.
  const SRC = 'zumipack://plugin.room-preview/ui/index.html';
  const k = rig();
  await k.r.refresh();
  assert.equal(k.r.room(), 1, 'the default room is Room 1');
  k.r.setRoom(2);
  assert.equal(k.storage.get('zumi.room3d'), undefined, 'picking Room 2 does not turn the 3D room on');
  assert.equal(k.storage.get('zumi.room3d.room'), '2', 'the room pick is remembered');
  k.r.enter();
  assert.equal(find(k.stageEl, (e) => e.tag === 'webview').attrs.src, `${SRC}?ui=0&room=2`, 'the Zumi tab opens Room 2 with exactly ?ui=0&room=2');
  k.r.setRoom(1);
  assert.equal(find(k.stageEl, (e) => e.tag === 'webview').attrs.src, `${SRC}?ui=0`, 'a pick while the view is on reopens the guest on the new room');
  assert.equal(k.stageEl.children.filter((c) => c.id === 'stage3d').length, 1, 'one guest, never two');
  assert.equal(k.storage.get('zumi.room3d.room'), undefined, 'Room 1 is the default: nothing stored');
  k.r.setRoom(2); k.r.leave(); // a fallback keeps the room pick
  assert.equal(k.r.room(), 2, 'a fallback keeps the room pick');
  const again = rig({ stored: '1', room: '2' });
  await again.r.refresh(); again.r.restore();
  assert.equal(again.r.active, true);
  assert.equal(find(again.stageEl, (e) => e.tag === 'webview').attrs.src, `${SRC}?ui=0&room=2`, 'after a restart the 3D room reopens Room 2');
  const only2 = rig({ room: '2' });
  await only2.r.refresh(); only2.r.restore();
  assert.equal(only2.r.active, false, 'a remembered Room 2 alone does not turn the 3D room on');
  for (const bad of ['3', '0', 'x', '22', '']) { const j = rig({ room: bad }); assert.equal(j.r.room(), 1, `a stored ${JSON.stringify(bad)} is Room 1`); }
  const j = rig(); j.r.setRoom(3); j.r.setRoom('2'); j.r.setRoom(0);
  assert.equal(j.r.room(), 1, 'only 1 and 2 are rooms');
  pass('Room 1 / Room 2: the host owns the pick, opens exactly ?room=2, keeps it over a fallback and a restart');
}
{
  // alpha.7 fix (GATE-OPUS-ALPHA7 should-fix 1): while the 3D room is on, Zumi's own-line subtitle, the heard line and the talk box (status,
  // Retry voice) move into a host row under the guest, so the native guest never covers them; leaving puts them back where they were.
  const k = rig();
  await k.r.refresh();
  const before = k.stageEl.children.map((c) => c.id);
  k.r.enter();
  const box = find(k.stageEl, (e) => e.id === 'stage3d');
  const view = find(box, (e) => e.className === 'stage3d-view');
  const host = find(box, (e) => e.className === 'stage3d-host');
  assert.ok(host, 'a host row is built under the guest');
  assert.deepEqual(host.children.map((c) => c.id), ['say-line', 'heard', 'talk'], 'the subtitle, the heard line and the talk box sit in the host row');
  assert.ok(find(host, (e) => e.id === 'talk-retry-voice'), 'Retry voice comes with the talk box');
  for (const id of ['say-line', 'heard', 'talk', 'talk-retry-voice']) assert.equal(find(view, (e) => e.id === id), null, `${id} is never inside the guest view`);
  assert.equal(k.composer.children.length, 0, 'the composer is not touched');
  k.r.leave();
  assert.deepEqual(k.stageEl.children.map((c) => c.id), before, 'leaving puts every hosted node back in its place and order');
  k.r.enter(); k.r.leave({ forget: true });
  assert.deepEqual(k.stageEl.children.map((c) => c.id), before, 'and again after a second round');
  const bare = rig();
  for (const id of ['say-line', 'heard', 'talk']) find(bare.stageEl, (e) => e.id === id).remove();
  await bare.r.refresh(); bare.r.enter();
  assert.equal(find(bare.stageEl, (e) => e.className === 'stage3d-host').children.length, 0, 'a missing node is skipped, not an error');
  pass('the talk UI moves under the guest while the 3D room is on and back after');
}
{
  // the host row is laid out in the flow of .stage3d (never absolute over the guest), and the hosted nodes drop their stage overlay position
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  const rule = (sel) => { const i = css.indexOf(`\n${sel} {`); if (i < 0) return null; const a = css.indexOf('{', i) + 1; return css.slice(a, css.indexOf('}', a)); };
  const hostRule = rule('.stage3d-host');
  assert.ok(hostRule && /flex:\s*none/.test(hostRule) && !/position:\s*absolute/.test(hostRule), `.stage3d-host is an in-flow row: ${hostRule}`);
  const hosted = rule('.stage3d-host .say-line, .stage3d-host .heard, .stage3d-host .talk');
  assert.ok(hosted && /position:\s*static/.test(hosted) && /transform:\s*none/.test(hosted), `the hosted nodes are static inside the row: ${hosted}`);
  pass('CSS: the host row is in flow and the hosted nodes are static');
}
{
  const k = rig();
  await k.r.refresh();
  k.r.enter();
  const wv = find(k.stageEl, (e) => e.tag === 'webview');
  wv.listeners['did-fail-load'][0]();
  assert.equal(k.r.active, false, 'a guest that fails to load (a refused open) hands the stage back');
  assert.equal(find(k.stageEl, (e) => e.id === 'stage3d'), null);
  pass('did-fail-load closes the view');
}

console.log(`\nALL OK check-room3d -- ${n} groups`);
