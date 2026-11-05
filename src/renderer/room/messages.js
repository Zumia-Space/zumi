// Renders a room-check verdict (src/main/room-check.mjs: { refused: {code, params} } / { warnings: [{code, params}] })
// into the active UI language, through the SAME i18n table as the rest of the app -- so a refusal or warning is
// always plain words in the owner's own language, never an anchor/extension code (scripts/check-room.mjs audits the
// rendered output with the owner-text rule, same as every other owner-visible label). Pure: no DOM, importable from
// plain Node (the check script) as well as the renderer.
import { t, en } from '../i18n.js';

// `current`: the "{current}" clause (coordinator QC 03-10) — a refusal is about a CANDIDATE file that was turned
// away, not the room already on stage, so every refused.* sentence says so explicitly: "<reason>. <current>."
// Build it with currentRoomClause() below; a caller that has no room-list context yet may omit it (keeps the
// {current} placeholder literally in the string rather than silently dropping half the sentence).
export function renderRoomRefused(refused, current) {
  if (!refused) return null;
  return t(`room.refused.${refused.code}`, { ...refused.params, current });
}

export function renderRoomWarning(warning) {
  return t(`room.warning.${warning.code}`, warning.params);
}

export function renderRoomWarnings(warnings) {
  return (warnings || []).map(renderRoomWarning);
}

// A room's name in the active UI language. The shipped room (id default-v2) is named by the i18n table, not by its
// room.json "name": a dev build live-reads the room repo and an installed app may serve an older validated copy, both
// of which can still carry the retired "Zumi's Office — Night" name (T-31 0.2.11, gate: scripts/check-no-office.mjs).
export function roomLabel(r) {
  if (r.id === 'default-v2') return t('room.name.default-v2');
  return r.label || r.id;
}

// A video room's name (assets/rooms-video/rooms.json) in the active UI language: i18n key scene.name.<id> when the
// table has one, else the manifest's English label (a new video room still shows a name before it is translated).
// scripts/check-no-office.mjs keeps every name distinct from the others, default-v2 "Night City" included.
export function sceneLabel(r) {
  const key = `scene.name.${r.id}`;
  return en(key) !== key ? t(key) : (r.label || r.id);
}

// The "{current}" clause from a rooms:list()-shaped result ({ rooms, selected }): "<label> is still in use" or
// "Zumi still has no room" when selected is 'none'/absent. Shared by room-settings.js (the real "Open room file…"
// flow) and shots/room.js (the QC screenshot), so the two never drift on what "current" means.
export function currentRoomClause({ rooms, selected } = {}) {
  if (!selected || selected === 'none') return t('room.inUseNone');
  const r = (rooms || []).find((x) => x.id === selected);
  const label = r ? roomLabel(r) : selected;
  return t('room.inUseWithRoom', { label });
}
