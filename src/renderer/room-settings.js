// Settings > "Room" (T-31 R3, PLAN-room.md §3 "UI"): None / the default room / imported rooms, an "Open room
// file…" picker, and "Delete room" for user rooms only. Mirrors settings.js's shape (one init function, owns its
// own DOM + i18n, calls back into app.js so the 3D stage reloads when the picked room actually changes).
import { t, onLocaleChange } from './i18n.js';
import { renderRoomRefused, renderRoomWarnings, currentRoomClause, roomLabel } from './room/messages.js';

// `sceneName()`: the label of the video room drawn over default-v2's talk plate (the toolbar Room picker), or null for the
// painted plate. A video room is all the stage shows, so this picker names it too (alpha.14 F6: it said "Night City" while
// the stage showed the beach cabin). The app fires `zumi:scene-changed` on document when the toolbar pick changes.
export function initRoomSettings(zumi, $, { onRoomChange, sceneName = () => null } = {}) {
  const el = { picker: $('room-picker'), open: $('room-open'), del: $('room-delete'), note: $('room-note') };
  let rooms = [];
  let selected = 'none';

  const note = (text, bad) => { el.note.textContent = text || ''; el.note.classList.toggle('bad', Boolean(bad)); };

  function labelFor(r) {
    if (r.id === 'none') return t('room.none');
    const scene = r.id === 'default-v2' ? sceneName() : null;
    if (scene) return scene;
    const author = r.hasManifest ? (r.author || t('room.unknownAuthor')) : t('room.unknownAuthor');
    return `${roomLabel(r)} — ${author}`;
  }

  function paint(result) {
    rooms = result.rooms;
    selected = result.selected;
    el.picker.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = 'none';
    noneOpt.textContent = t('room.none');
    el.picker.appendChild(noneOpt);
    for (const r of rooms) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = labelFor(r);
      el.picker.appendChild(opt);
    }
    el.picker.value = selected;
    const current = rooms.find((r) => r.id === selected);
    el.del.hidden = !current || current.source !== 'user';
    if (current && current.warnings && current.warnings.length) note(renderRoomWarnings(current.warnings).join(' '));
  }

  async function refresh() { paint(await zumi.rooms.list()); }

  el.picker.addEventListener('change', async () => {
    note('');
    const r = await zumi.rooms.select(el.picker.value);
    paint(r);
    if (onRoomChange) onRoomChange(r);
  });

  el.open.addEventListener('click', async () => {
    note('');
    // Snapshot BEFORE the call: a refusal never changes settings.room, so this is still the right "{current}"
    // room to name in the message (coordinator QC 03-10 — the picker itself also still shows it, untouched).
    const before = { rooms, selected };
    const r = await zumi.rooms.openFile();
    if (!r) return; // dialog cancelled
    if (r.error) { note(renderRoomRefused(r.error, currentRoomClause(before)) || t('room.importFailed', { message: r.error.code }), true); return; }
    note(t('room.importedOk'));
    paint(r);
    if (onRoomChange) onRoomChange(r);
  });

  el.del.addEventListener('click', async () => {
    const r = await zumi.rooms.delete(el.picker.value);
    note('');
    paint(r);
    if (onRoomChange) onRoomChange(r);
  });

  onLocaleChange(refresh); // relabel "No room" / "Author not listed" / warning text in the new language
  document.addEventListener('zumi:scene-changed', refresh);

  return refresh();
}
