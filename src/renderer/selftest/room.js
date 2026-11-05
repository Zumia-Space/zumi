// Self-test, room part (T-31 R3, PLAN-room.md §6 R3: "default room loads; each bad fixture refused with its
// message; missing-anchor fallback; non-loopback 0"). The last of those is already covered by the whole-run
// network extra in index.js (every room file comes from app:// / local disk, never a network request) -- this
// module checks the other three, through the same production code path the real Settings room picker uses
// (selftest:room-fixtures / selftest:room-open both call main's importRoomFile(), the function the real "Open room
// file…" dialog calls too).
import { renderRoomRefused, currentRoomClause } from '../room/messages.js';
import { ownerTextProblem } from '../talk/ownertext.js';

export async function roomCheck(ctx) {
  const { app, api, log, frames, until, pngName, audit } = ctx;
  const r = { ok: false, fixtures: {}, defaultV2: {}, default: {}, missingAnchors: {} };

  // ---------- 1a. the shipped default room loads (PLAN §6 R3; Tauri case, kept by the T-31 B1 merge) ----------
  // The shipped default is the v2 room 'default-v2': it must be listed (schemaVersion 2), and switchRoom must leave it
  // as the live room. No default room loading fails the part; nothing is skipped.
  app.openZumiTab();
  const listed = ((await window.zumi.rooms.list()).rooms || []).some((x) => x.id === 'default-v2' && x.schemaVersion === 2);
  await app.switchRoom('default-v2');
  await frames(6);
  const loadedId = await until(() => app.roomV2Id(), 8000);
  r.defaultV2 = {
    loaded: Boolean(listed && loadedId === 'default-v2'),
    listed,
    id: loadedId || null,
    blocked: app.roomBlocked(),
  };
  if (audit) audit('default-v2 room loaded');
  const shotV2 = await api.capture('room-default', { save: pngName('room-default') });
  r.defaultV2.png = shotV2.png;
  r.defaultV2.blank = shotV2.blank;
  log(`room default-v2: id=${r.defaultV2.id} listed=${r.defaultV2.listed} loaded=${r.defaultV2.loaded} blocked=${r.defaultV2.blocked}`);

  // ---------- 1b. a good .glb room loads (PLAN §6 R3) ----------
  // T-31 0.2.11: room v1 'default' ("Zumi's Office") is removed from the app (owner decision 2026-10-26), so the room
  // under test is the importer's good fixture, opened through the same import path a user's own room takes.
  app.openZumiTab();
  const { names, expectedRefusal } = await api.roomFixtures();
  const goodImport = await api.roomOpen('good.glb');
  await app.switchRoom(goodImport && !goodImport.error ? goodImport.selected : 'none');
  await frames(6);
  const anchors = await until(() => app.roomAnchorsFound(), 8000);
  r.default = {
    loaded: Boolean(anchors),
    standFound: Boolean(anchors && anchors.zumi_stand),
    cameraFound: Boolean(anchors && anchors.camera_default),
    lookTargets: anchors && anchors.look_targets ? anchors.look_targets.children.length : 0,
    blocked: app.roomBlocked(),
  };
  if (audit) audit('good .glb room loaded');
  const shot = await api.capture('room-glb-fixture', { save: pngName('room-glb-fixture') });
  r.default.png = shot.png;
  r.default.blank = shot.blank;
  log(`room good .glb: loaded=${r.default.loaded} stand=${r.default.standFound} camera=${r.default.cameraFound} lookTargets=${r.default.lookTargets} blocked=${r.default.blocked}`);

  // ---------- 2. fixtures: good + 6 bad, each refused (or accepted) for the right reason ----------
  let missingAnchorsRoomId = null;
  for (const name of names) {
    const res = await api.roomOpen(name);
    const expectCode = expectedRefusal[name];
    if (expectCode) {
      const code = res && res.error && res.error.code;
      // A refusal is never about the active room -- it names it (coordinator QC 03-10). A refused import never
      // changes settings.room, so the CURRENT list (fetched fresh, same as the production "Open room file…" flow
      // would) is still accurate here.
      const current = code ? currentRoomClause(await window.zumi.rooms.list()) : null;
      const message = code ? renderRoomRefused(res.error, current) : null;
      const auditProblem = message ? ownerTextProblem(message) : 'no message';
      r.fixtures[name] = { ok: code === expectCode, code, message, auditProblem };
      log(`room fixture ${name}: expected=${expectCode} got=${code} message="${message}" audit=${auditProblem || 'clean'}`);
    } else {
      // 'good.glb' and 'missing-anchors.glb' are both expected to be ACCEPTED (anchors are warn-only, never refused).
      const ok = Boolean(res && !res.error && res.selected);
      r.fixtures[name] = { ok, selected: res && res.selected };
      log(`room fixture ${name}: accepted=${ok} selected=${res && res.selected}`);
      if (name === 'missing-anchors.glb' && ok) missingAnchorsRoomId = res.selected;
    }
  }

  // ---------- 3. the missing-anchor fallback (PLAN §3: every anchor optional, scene origin + plain camera) ----------
  if (missingAnchorsRoomId) {
    await app.switchRoom(missingAnchorsRoomId);
    await frames(6);
    const a2 = await until(() => app.roomAnchorsFound(), 8000);
    const fellBackToOrigin = Boolean(a2 && !a2.zumi_stand && !a2.camera_default); // the fixture renamed every anchor
    r.missingAnchors = { loaded: Boolean(a2), fellBackToOrigin, modelStillVisible: app.hasModel(), blocked: app.roomBlocked() };
    const shot2 = await api.capture('room-missing-anchors', { save: pngName('room-missing-anchors') });
    r.missingAnchors.png = shot2.png;
    r.missingAnchors.blank = shot2.blank;
    log(`room missing-anchors fallback: loaded=${r.missingAnchors.loaded} fellBackToOrigin=${fellBackToOrigin} modelVisible=${r.missingAnchors.modelStillVisible} blank=${shot2.blank}`);
  } else {
    r.missingAnchors = { skipped: true, reason: 'missing-anchors.glb import did not succeed' };
  }

  // back to no room + a clean stage for whatever runs next
  await app.switchRoom('none');
  await frames(4);

  const fixturesOk = Object.values(r.fixtures).every((f) => f.ok);
  r.ok = Boolean(r.defaultV2.loaded && !r.defaultV2.blank
    && r.default.loaded && r.default.standFound && r.default.cameraFound && !r.default.blank && fixturesOk
    && r.missingAnchors.loaded && r.missingAnchors.fellBackToOrigin && r.missingAnchors.modelStillVisible && !r.missingAnchors.blank);
  return r;
}
