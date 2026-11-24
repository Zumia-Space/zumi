// Settings > Room > Brightness (9.11 light round 2, FABLE-MOTION-TIMING-1911 section 4): one slider for the 3D room's light, -1 to +1 EV (stops), saved PER ROOM
// in settings.json by the host (ui.setRoomEv(roomId, ev)); the room is the 3D stage pack. The 3D room reads its own value from the host and follows within
// seconds, so there is nothing to restart. 0 EV = the look as it was. The face keeps its own light (the guest scales the character light the other way).
// Tauri only: without the host API (Electron), or with no 3D room installed, the row hides itself.
// The slider counts tenths of a stop (-10..+10, step 1): shown while dragging ('input'), saved after a short pause and on release ('change'), like the voice sliders.
const SAVE_DELAY_MS = 250;

// Room 1 and Room 2 are one stage pack (room3d.js, `?room=2`): Room 1 keeps the plain pack id (values saved before Room 2 stay), Room 2 is `<pack id>.room2`.
// The same key the host reads (pack_host.rs room_ev_key). No other stage pack exists (FIRST_PARTY_STAGE_IDS), so the suffix cannot meet a real pack id.
export const roomEvKey = (packId, room) => (packId ? (room === 2 ? `${packId}.room2` : packId) : null);

const label = (tenths) => `${tenths > 0 ? '+' : ''}${(tenths / 10).toFixed(1)} EV`;

/**
 * @param {object} zumi window.zumi
 * @param {(id: string) => HTMLElement|null} $ element lookup
 * @param {{ roomId: () => Promise<string|null>, setTimer?: Function, clearTimer?: Function }} o roomId: the id of the 3D room (stage pack) the slider edits
 */
export function initRoomEv(zumi, $, { roomId = async () => null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const el = { row: $('room-brightness-row'), slider: $('room-brightness'), val: $('room-brightness-val') };
  const ui = zumi && zumi.ui;
  const hide = () => { if (el.row) el.row.hidden = true; };
  if (!el.slider || !ui || typeof ui.getRoomEv !== 'function' || typeof ui.setRoomEv !== 'function') { hide(); return null; }
  const tenths = () => Number(el.slider.value);
  const show = () => {
    el.val.textContent = label(tenths());
    const lo = Number(el.slider.min), hi = Number(el.slider.max);
    if (el.slider.style && el.slider.style.setProperty) el.slider.style.setProperty('--fill', `${((tenths() - lo) / (hi - lo)) * 100}%`);
  };
  const paint = (ev) => { el.slider.value = String(Math.round(Number(ev) * 10) || 0); show(); };
  let timer = null, room = null;
  const save = () => { if (timer) { clearTimer(timer); timer = null; } return room ? Promise.resolve(ui.setRoomEv(room, tenths() / 10)).catch(() => {}) : Promise.resolve(); };
  el.slider.addEventListener('input', () => { show(); if (timer) clearTimer(timer); timer = setTimer(save, SAVE_DELAY_MS); });
  el.slider.addEventListener('change', save);
  // reload(): the picked room changed (Room 1 / Room 2): a pending save goes to the room it was dragged for, then the slider shows the new room's value.
  const reload = async () => {
    if (timer) await save();
    return Promise.resolve(roomId()).then((id) => {
      if (!id) { hide(); return null; }
      room = id;
      return Promise.resolve(ui.getRoomEv(id)).then(paint).catch(() => paint(0));
    }).catch(hide);
  };
  reload();
  return { paint, reload };
}
