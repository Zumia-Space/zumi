// Zumi 0.3.5-alpha.9.11 (T-31-ROOM 9.11 light round 2, FABLE-MOTION-TIMING-1911 section 4): one brightness control per 3D room, in EV (stops).
// settings.json `roomEv` is a map { <room id>: ev } with ev in -1..+1: the room's exposure is multiplied by 2^ev after the time-of-day preset and the
// character's light factor by 2^-ev (the 3D room guest does that). 0 = the look as it was. The room id is the stage pack's id (`plugin.zumi-room-1`, ...).
// The Settings > Room slider reads and writes it through ui.getRoomEv / ui.setRoomEv (Tauri only); the 3D room guest asks the host for its own room's value at
// `GET /<pack id>/__zumi/light.json` (pack_host.rs reads settings.json itself and clamps with the same range) and applies it live.
// The range is one set of numbers in three places: here, pack_host.rs (ROOM_EV_*) and room/src/room-light.js. check:room-light pins them.
// The first draft of this slider (a 0.6-1.4 factor, `roomBrightness`) never shipped: it is not read and not migrated.

export const ROOM_EV = Object.freeze({ min: -1, max: 1, def: 0 });
// A room id is a pack id: plain characters only (it becomes a key in settings.json and a path segment in the host URL).
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ROOMS = 64;

const clamp = (n) => Math.min(ROOM_EV.max, Math.max(ROOM_EV.min, n));
const map = (settings) => (settings && settings.roomEv && typeof settings.roomEv === 'object' && !Array.isArray(settings.roomEv) ? settings.roomEv : {});

/** settings.json -> the EV of one room. A bad room id, a missing room or anything that is not a finite number reads as 0. */
export function evOf(settings, roomId) {
  if (typeof roomId !== 'string' || !ROOM_ID.test(roomId) || !Object.prototype.hasOwnProperty.call(map(settings), roomId)) return ROOM_EV.def;
  const n = map(settings)[roomId];
  return typeof n === 'number' && Number.isFinite(n) ? clamp(n) : ROOM_EV.def;
}

/**
 * @param {{ settings: () => object, saveSettings: (patch: object) => object }} o
 */
export function roomEvHandlers({ settings, saveSettings }) {
  return {
    'ui.getRoomEv': (roomId) => evOf(settings(), roomId),
    // A value that is not a number, or a room id that is not a plain id, changes nothing. A number is clamped to the range and kept to 2 decimals.
    // Answers what is now saved for that room. The other rooms' values are kept (the whole map is rewritten, valid entries only).
    'ui.setRoomEv': (roomId, v) => {
      if (typeof roomId === 'string' && ROOM_ID.test(roomId) && typeof v === 'number' && Number.isFinite(v)) {
        const current = map(settings()), next = {};
        for (const [k, val] of Object.entries(current)) if (ROOM_ID.test(k) && typeof val === 'number' && Number.isFinite(val)) next[k] = clamp(val);
        if (Object.prototype.hasOwnProperty.call(next, roomId) || Object.keys(next).length < MAX_ROOMS) {
          next[roomId] = Math.round(clamp(v) * 100) / 100;
          saveSettings({ roomEv: next });
        }
      }
      return evOf(settings(), roomId);
    },
  };
}
