// The 3D room as a choice in the Zumi tab's own Room list (owner 13-11: "phòng chỉ ở tab Room chưa chọn được trong danh sách phòng").
// Picking it shows the first-party stage pack's guest INSIDE the Zumi tab's stage area, above the video/avatar canvases and below nothing the
// user needs: the tab's own message box, mic and caption row stay where they are and keep working (no second chat UI anywhere). Zumi's reply
// caption is mirrored under the guest, in the host UI (the guest only ever gets numbers, ADR D2).
//
// One guest per pack: while this view is on, the Room tab's viewer stays closed (pack-tabs.js reads `__zumiRoom3dActive`).
// The pick persists in the main webview's own storage (a browser setting of this window, not an app-data file the sidecar owns); a fallback
// closes the guest but keeps the pick, so the next start tries again (and F1's remembered verdict decides what happens, see stage_bridge.rs).
const KEY = 'zumi.room3d';
export const ROOM3D_VALUE = '3d';
// Room 2 (T-31-ROOM room2-holo, PACK-PLAN C4): the room pack holds two rooms. The HOST owns which one is shown (the Zumi tab's guest runs with `?ui=0` and has
// no controls): the pick lives in the main webview's storage under a key of its own, so picking Room 2 never turns the 3D room on by itself. It opens the
// pack page with exactly `?room=2` (guest.rs pack_src_allowed enumerates the four srcs it accepts); Room 1 is "no room in the query".
export const ROOM3D2_VALUE = '3d2';
const ROOM_KEY = 'zumi.room3d.room';
export function createRoomChoice(storage, bag = { mem: 1 }) {
  return {
    get() { try { return storage && storage.getItem(ROOM_KEY) === '2' ? 2 : 1; } catch { return bag.mem; } }, // a blocked storage: the pick lasts for this run
    set(n) { bag.mem = n; try { if (storage) { if (n === 2) storage.setItem(ROOM_KEY, '2'); else storage.removeItem(ROOM_KEY); } } catch { /* blocked: this run only */ } },
  };
}
export const roomQuery = (room) => (room === 2 ? '?room=2' : '');
// The Zumi tab's own talk UI that sits over the stage: the subtitle of Zumi's own lines, the heard line, and the talk box (status, check,
// Retry voice). A native guest covers whatever is under its rect, so while the 3D room is on these NODES move into a host row under the guest
// (the talk code keeps its references, nothing is copied) and go back to their place on leave (GATE-OPUS-ALPHA7 should-fix 1).
const HOSTED_IDS = ['say-line', 'heard', 'talk'];
// The room's "no controls" flag (room/src/main.js): no Tour/Photo/Walk/Lighting/Wireframe bar, no sun presets, no hidden view shortcut, so the
// owner cannot land in a debug view or photo mode inside the Zumi tab (GATE-OPUS-ALPHA7 S3). The host allows exactly this query (guest.rs).
const NO_CONTROLS = '?ui=0';

/**
 * @param {object} o
 * @param {HTMLElement} o.stageEl  the Zumi tab's #stage
 * @param {() => Promise<object[]>} o.listPacks  pack_list rows ({ id, src, partition, stage, label })
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} [o.storage]
 * @param {(on: boolean) => void} [o.onActive]  called when the 3D view turns on or off (the main renderer pauses while it is on, D1)
 * @param {Document} [o.doc]
 */
export function createRoom3d({ stageEl, listPacks, storage = null, onActive = () => {}, doc = document }) {
  let pack = null;
  let box = null;
  let caption = null;
  let off = null;
  let moved = []; // [{ el, parent, next }] of the hosted nodes, to put them back
  let builtRoom = 1; // the room the open guest was built for
  const state = { active: false };
  const choice = createRoomChoice(storage);

  const store = {
    get() { try { return storage ? storage.getItem(KEY) : null; } catch { return null; } }, // a blocked storage just means "not remembered"
    set(v) { try { if (storage) { if (v) storage.setItem(KEY, '1'); else storage.removeItem(KEY); } } catch { /* a blocked storage: the pick lasts for this run */ }},
  };

  function setActive(on) {
    state.active = on;
    globalThis.__zumiRoom3dActive = on;
    onActive(on);
    if (typeof doc.dispatchEvent === 'function' && typeof CustomEvent === 'function') doc.dispatchEvent(new CustomEvent('zumi:room3d', { detail: { active: on } }));
  }

  function build() {
    box = doc.createElement('div');
    box.id = 'stage3d';
    box.className = 'stage3d';
    const view = doc.createElement('div');
    view.className = 'stage3d-view';
    const wv = doc.createElement('webview');
    wv.setAttribute('partition', pack.partition);
    builtRoom = choice.get();
    wv.setAttribute('src', pack.src + NO_CONTROLS + (builtRoom === 2 ? '&room=2' : '')); // the Room tab viewer opens the plain page and keeps the room's own controls
    wv.addEventListener('did-fail-load', () => api.leave());
    view.appendChild(wv);
    caption = doc.createElement('p');
    caption.className = 'stage3d-caption';
    const host = doc.createElement('div');
    host.className = 'stage3d-host';
    box.append(view, caption, host);
    stageEl.appendChild(box);
    moved = [];
    for (const id of HOSTED_IDS) {
      const el = typeof doc.getElementById === 'function' ? doc.getElementById(id) : null;
      if (!el || !el.parentNode) continue;
      moved.push({ el, parent: el.parentNode, next: el.nextSibling });
      host.appendChild(el);
    }
    const onCaption = (e) => { caption.textContent = String((e && e.detail) || ''); };
    doc.addEventListener('zumi:caption', onCaption);
    off = () => { if (typeof doc.removeEventListener === 'function') doc.removeEventListener('zumi:caption', onCaption); };
  }

  // The pick changed (here or on the Room tab's switch): the open guest is replaced by one on the new room (one guest, never two; not a retry under A11).
  function reopenIfStale() { if (state.active && builtRoom !== choice.get()) { api.leave(); api.enter({ remember: false }); } }
  if (typeof doc.addEventListener === 'function') doc.addEventListener('zumi:room-choice', reopenIfStale);

  const api = {
    state,
    get active() { return state.active; },
    /** Looks for a first-party stage pack among the installed ones. */
    async refresh() {
      try { const rows = await listPacks(); pack = (Array.isArray(rows) ? rows : []).find((r) => r && r.stage === true) || null; } catch { pack = null; }
      return Boolean(pack);
    },
    available() { return Boolean(pack); },
    /** Show the 3D room in the Zumi tab. The pick is remembered when `remember` is true (a user pick, not a restore after a fallback). */
    enter({ remember = true } = {}) {
      if (!pack || state.active) return state.active;
      build();
      if (remember) store.set(true);
      setActive(true);
      return true;
    },
    /** Close the guest and give the stage back. `forget` clears the pick (the user chose another room); a fallback keeps it. */
    leave({ forget = false } = {}) {
      if (forget) store.set(false);
      if (!state.active) return;
      if (off) { off(); off = null; }
      for (const { el, parent, next } of moved.reverse()) parent.insertBefore(el, next && next.parentNode === parent ? next : null);
      moved = [];
      if (box) { box.remove(); box = null; caption = null; } // removing the <webview> closes the guest (webview-element.js)
      setActive(false);
    },
    wanted() { return store.get() === '1'; },
    /** Room 1 or Room 2 (1 when nothing is stored). */
    room() { return choice.get(); },
    /** Picks Room 1 or 2 (anything else is ignored), remembers it, tells the Room tab's switch, and reopens the one guest when it is on. */
    setRoom(n) {
      if (n !== 1 && n !== 2) return;
      choice.set(n);
      if (typeof doc.dispatchEvent === 'function' && typeof CustomEvent === 'function') doc.dispatchEvent(new CustomEvent('zumi:room-choice', { detail: { room: n } }));
      reopenIfStale();
    },
    /** At launch: the pick survives a restart. */
    restore() { if (pack && store.get() === '1' && !state.active) api.enter({ remember: false }); },
    dispose() { api.leave(); },
  };
  return api;
}
