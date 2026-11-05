// Room setting resolution (which room to show at launch, and the settings to write for it). Pure and Electron-free,
// so scripts/check-room.mjs and check-no-office.mjs run the same code main.js does.
//
// T-31 0.2.11 owner decision (default-room-q, 2026-10-26): room v1 "Zumi's Office" (id 'default') is removed from the
// app -- below standard, and it was once picked by mistake for a video. Its validate-and-copy pipeline that used to
// live here went with it; a saved 'default' now resolves to default-v2 (Night City) and is rewritten once.

/**
 * Rooms that are SHIPPED inside the packaged app and approved by the owner, in preference order (T-31 0.2.8 fix).
 * 'default-v2' = room standard v2 room B (resources-pinned/room-v2/room.json): the painted night room the video rooms
 * are registered to, and the coordinator's 03-10 ruling "make v2-B the bundled default room".
 */
export const APPROVED_SHIPPED_ROOMS = ['default-v2'];

/** Room ids that were removed from the app; a saved one is replaced by the approved room (owner decision 2026-10-26). */
export const RETIRED_ROOMS = ['default'];

/**
 * Which room to show, given the saved `room` setting and the rooms actually listed on this machine.
 * - saved value absent (undefined) = first run: the first approved shipped room (default-v2), else 'none';
 *   `persist` says to write the pick once so it reads as an explicit choice from then on.
 * - saved retired id (v1 'default'): the approved shipped room, persisted (so settings stop naming the removed room),
 *   else 'none' (not persisted) -- never the retired room, even if a stale list still carries it.
 * - saved 'none' = the user picked "No room": kept, never overridden.
 * - saved id still listed: kept.
 * - saved id no longer listed: the first approved shipped room, else 'none'; the saved value is left untouched.
 * @param storedRoom settings.room: undefined | 'none' | 'default-v2' | <imported id> | a retired id
 * @param rooms [{ id }] as listed by main.js
 * @returns {{ selected: string, persist: boolean }}
 */
export function resolveRoomSelection(storedRoom, rooms) {
  const ids = new Set(rooms.map((r) => r.id).filter((id) => !RETIRED_ROOMS.includes(id)));
  const approved = APPROVED_SHIPPED_ROOMS.find((id) => ids.has(id)) || null;
  if (storedRoom === undefined || RETIRED_ROOMS.includes(storedRoom)) {
    return approved ? { selected: approved, persist: true } : { selected: 'none', persist: false };
  }
  if (storedRoom === 'none' || ids.has(storedRoom)) return { selected: storedRoom, persist: false };
  return { selected: approved || 'none', persist: false };
}

/**
 * Settings patch for an EXPLICIT room pick (rooms:select, room import). `roomChoiceV2: true` = "the user decided in 0.2.8+",
 * so a saved 'none' is respected forever from then on.
 */
export function roomPickPatch(id) { return { room: id, roomChoiceV2: true }; }

/**
 * Launch-time room decision (what main.js listRooms runs). Wraps resolveRoomSelection with the one-time 0.2.7 migration:
 * 0.2.7 auto-saved room:'none' on a fresh run without the v1 room, so 'none' with the marker `roomChoiceV2` absent is
 * "never really chose" -> select the approved shipped room ONCE and persist room + roomChoiceV2:false (explicit "migrated",
 * so a relaunch cannot loop). Marker values: absent = undecided, false = migrated from 0.2.7, true = explicit pick or
 * fresh install. A fresh install (room absent) persists room + roomChoiceV2:true so it never migrates.
 * @param settings the saved settings object ({ room?, roomChoiceV2? })
 * @param rooms [{ id }] as listed by main.js
 * @returns {{ selected: string, patch: object|null }} patch = settings to write now, or null
 */
export function resolveRoomLaunch(settings, rooms) {
  const { room, roomChoiceV2 } = settings || {};
  if (room === 'none' && roomChoiceV2 === undefined) {
    const ids = new Set(rooms.map((r) => r.id));
    const approved = APPROVED_SHIPPED_ROOMS.find((id) => ids.has(id));
    if (approved) return { selected: approved, patch: { room: approved, roomChoiceV2: false } };
  }
  const { selected, persist } = resolveRoomSelection(room, rooms);
  return { selected, patch: persist ? { room: selected, roomChoiceV2: true } : null };
}
