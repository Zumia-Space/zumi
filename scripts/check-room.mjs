// Room checker gate (T-31 R1, PLAN-room.md §6 R1: "check:room units all pass; messages English and audited by the
// owner-text audit"). Reads a known-good room .glb (read-only, outside this repo; it was room v1 "Zumi's Office",
// removed from the app 2026-10-26 and kept ONLY as importer test data) as the ONE "good" fixture, derives
// the 6 bad ones from it in memory (room-fixtures.mjs — nothing is written to disk, nothing is committed), runs the
// checker (room-check.mjs) on all 7, and asserts every refusal/warning renders as a plain-English sentence that
// passes the same owner-text audit every other owner-visible label in this app goes through.
import fs from 'node:fs';
import path from 'node:path';
import { checkRoomGlb, CAPS, checkRoomJsonV2, checkRoomJsonFile, CAPS_V2 } from '../src/main/room-check.mjs';
import { generateBadRoomFixtures } from '../src/main/room-fixtures.mjs';
import { resolveRoomSelection, resolveRoomLaunch, roomPickPatch, APPROVED_SHIPPED_ROOMS } from '../src/main/room-default.mjs';
import { renderRoomRefused, renderRoomWarning, currentRoomClause } from '../src/renderer/room/messages.js';
import { ownerTextProblem } from '../src/renderer/talk/ownertext.js';
import { t, setLocale } from '../src/renderer/i18n.js';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOM_GLB_FIXTURE = process.env.ZUMI_ROOM_GLB_FIXTURE || ownerPath('roomGlb', 'local/room.glb');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---------- 0. the good .glb fixture is reachable ----------
if (!fs.existsSync(ROOM_GLB_FIXTURE)) {
  console.log(`FAIL room .glb fixture not found at ${ROOM_GLB_FIXTURE} (set ZUMI_ROOM_GLB_FIXTURE to override)`);
  process.exit(1);
}
const goodBuf = fs.readFileSync(ROOM_GLB_FIXTURE);

// ---------- 1. the good room passes with zero warnings (PLAN §6 R2: "passes R1 with zero warnings") ----------
const good = checkRoomGlb(goodBuf);
ok(good.ok === true, 'good room: accepted', JSON.stringify(good.refused));
ok(good.warnings.length === 0, 'good room: zero warnings', JSON.stringify(good.warnings));
ok(good.stats && good.stats.triangles <= 25_000, 'good room: triangles within the default-room target (<=25k)', good.stats && good.stats.triangles);
ok(good.stats && good.stats.drawCalls <= 40, 'good room: draw calls within the default-room target (<=40)', good.stats && good.stats.drawCalls);
ok(good.stats && good.stats.textureMemoryMB <= CAPS.textureMemWarnMB, 'good room: texture memory within the warn cap', good.stats && good.stats.textureMemoryMB);
ok(good.anchors && good.anchors.zumi_stand && good.anchors.camera_default && good.anchors.desk_seat && good.anchors.look_targets, 'good room: the anchors the app relies on are present', JSON.stringify(good.anchors));
console.log(`  stats: ${JSON.stringify(good.stats)}`);

// ---------- 2. size-cap boundary + unit consistency (coordinator QC 03-10: "26 MB" shown for a 25 MB cap) ----------
// CAPS.sizeRefuseBytes and the mb/capMb shown in the message must be the SAME definition of "MB" (room-check.mjs:
// both are now decimal, CAPS.MB = 1_000_000) -- these assertions would have caught the earlier 1024*1024-vs-1e6 mismatch.
{
  ok(CAPS.sizeRefuseBytes === 25_000_000, 'caps: the size-refuse cap is exactly 25,000,000 bytes (decimal MB)', CAPS.sizeRefuseBytes);
  const atCap = checkRoomGlb(Buffer.concat([goodBuf, Buffer.alloc(CAPS.sizeRefuseBytes - goodBuf.length, 0)]));
  ok(atCap.ok === true, 'caps: a file exactly AT the size cap is NOT refused for size', JSON.stringify(atCap.refused));
  const overCap = checkRoomGlb(Buffer.concat([goodBuf, Buffer.alloc(CAPS.sizeRefuseBytes - goodBuf.length + 1, 0)]));
  ok(overCap.refused && overCap.refused.code === 'too_big', 'caps: a file 1 byte over the size cap is refused as too_big', JSON.stringify(overCap.refused));
  ok(overCap.refused.params.capMb === 25, 'caps: the refusal message\'s capMb is exactly 25 (matches the 25 MB cap, not 26)', overCap.refused.params.capMb);
  // a file exactly 2x the cap reads back as exactly "50.0 MB" -- proves the display math (bytes/1e6) and the cap
  // definition (25_000_000) use the one same unit, not just that this one boundary case happens to round right.
  const twoX = checkRoomGlb(Buffer.alloc(CAPS.sizeRefuseBytes * 2));
  ok(twoX.refused.params.mb === 50, 'caps: a file at 2x the cap reports exactly 50.0 MB (bytes/1e6, same unit as the cap)', twoX.refused.params.mb);
}

// ---------- 3. the 6 bad fixtures, each refused/warned for the right reason ----------
const bad = generateBadRoomFixtures(goodBuf);
const EXPECT_REFUSED = {
  'too-big.glb': 'too_big',
  'external-image.glb': 'external_uri',
  'draco.glb': 'unsupported_compression',
  'big-texture.glb': 'texture_too_big',
  'bad-magic.glb': 'not_a_room_file',
};
for (const [name, code] of Object.entries(EXPECT_REFUSED)) {
  const r = checkRoomGlb(bad[name]);
  ok(r.ok === false && r.refused && r.refused.code === code, `fixture ${name}: refused as ${code}`, JSON.stringify(r.refused));
}
{
  const r = checkRoomGlb(bad['missing-anchors.glb']);
  ok(r.ok === true, 'fixture missing-anchors.glb: accepted (every anchor is optional, never a refusal)', JSON.stringify(r.refused));
  const codes = new Set(r.warnings.map((w) => w.code));
  const expected = ['missing_stand', 'missing_camera', 'missing_desk', 'missing_keyboard', 'missing_screen', 'missing_cup', 'missing_glances', 'missing_lights'];
  const missing = expected.filter((c) => !codes.has(c));
  ok(missing.length === 0, 'fixture missing-anchors.glb: warns for every missing anchor + the missing lights', `missing=${missing.join(',')} got=${[...codes].join(',')}`);
}

// ---------- 4. every refused/warning message renders as plain English (and VI/ZH) and passes the owner-text audit ----------
// no anchor/extension code (snake_case, camelCase, etc.) is allowed to leak into what the owner reads.
const allRefusedCodes = [...new Set([good, ...Object.values(bad).map(checkRoomGlb)].map((v) => v.refused && v.refused.code).filter(Boolean))];
const allWarningCodes = [...new Set([good, ...Object.values(bad).map(checkRoomGlb)].flatMap((v) => v.warnings.map((w) => w.code)))];
const sampleParams = { mb: 32, capMb: 25, count: 123456, cap: 100000, px: 4096 };
// A refusal names the CURRENT room, not the rejected file (coordinator QC 03-10) -- exercise both the "a room is
// active" and the "no room" cases, in every language, so a future wording change can't silently drop {current}.
const sampleRoomsWithDefault = { rooms: [{ id: 'default-v2', label: 'Night City' }], selected: 'default-v2' };
const sampleRoomsNone = { rooms: [], selected: 'none' };
for (const lang of ['en', 'vi', 'zh']) {
  setLocale(lang); // t() reads the active locale; render each message in the language it will actually be audited against
  for (const sample of [sampleRoomsWithDefault, sampleRoomsNone]) {
    const current = currentRoomClause(sample);
    const currentProblem = ownerTextProblem(current, { lang });
    ok(!currentProblem, `message [${lang}] {current} clause (selected=${sample.selected}) passes the owner-text audit`, `"${current}" -> ${currentProblem}`);
    for (const code of allRefusedCodes) {
      const text = renderRoomRefused({ code, params: sampleParams }, current);
      const problem = ownerTextProblem(text, { lang });
      ok(!problem, `message [${lang}] room.refused.${code} (selected=${sample.selected}) passes the owner-text audit`, `"${text}" -> ${problem}`);
      ok(text.includes(current), `message [${lang}] room.refused.${code} names the current room ("${current}")`, text);
    }
  }
  for (const code of allWarningCodes) {
    const text = renderRoomWarning({ code, params: sampleParams });
    const problem = ownerTextProblem(text, { lang });
    ok(!problem, `message [${lang}] room.warning.${code} passes the owner-text audit`, `"${text}" -> ${problem}`);
  }
}
setLocale('en');
ok(allRefusedCodes.length >= 5, `at least 5 distinct refusal codes exercised (got ${allRefusedCodes.length})`);
ok(allWarningCodes.length >= 8, `at least 8 distinct warning codes exercised (got ${allWarningCodes.length})`);

// ---------- 5. which room is shown (room-default.mjs) ----------
// A fake in-memory settings store (same {get, set} shape main.js's loadSettings/saveSettings give room-default.mjs).
function fakeSettings(initial = {}) { let s = { ...initial }; return { get: () => s, set: (patch) => { s = { ...s, ...patch }; } }; }

// -- (6) 0.2.8 fresh-install fix: the app lists the SHIPPED room (default-v2, Night City). Room v1 'default'
//    ("Zumi's Office") was removed by owner decision 2026-10-26 (default-room-q): never listed, never a fallback,
//    a saved 'default' resolves to default-v2 and is rewritten once (full v1 gate: scripts/check-no-office.mjs).
{
  const shipped = [{ id: 'default-v2' }];
  const fresh = resolveRoomSelection(undefined, shipped);
  ok(APPROVED_SHIPPED_ROOMS[0] === 'default-v2', 'approved shipped room is default-v2 (room-v2 B, first in the approved list)');
  ok(fresh.selected === 'default-v2' && fresh.persist === true, 'fresh profile (no saved room key) + only shipped rooms -> the approved room is selected AND persisted', JSON.stringify(fresh));
  const launchFresh = resolveRoomLaunch({}, shipped);
  ok(launchFresh.selected === 'default-v2' && launchFresh.patch && launchFresh.patch.room === 'default-v2' && launchFresh.patch.roomChoiceV2 === true, 'launch path: fresh settings -> default-v2 persisted with roomChoiceV2:true', JSON.stringify(launchFresh));
  const savedV1 = resolveRoomSelection('default', shipped);
  ok(savedV1.selected === 'default-v2' && savedV1.persist === true, "saved 'default' (removed v1) -> default-v2, persisted", JSON.stringify(savedV1));
  const savedV1Launch = resolveRoomLaunch({ room: 'default', roomChoiceV2: true }, shipped);
  ok(savedV1Launch.selected === 'default-v2' && savedV1Launch.patch && savedV1Launch.patch.room === 'default-v2', "launch path: saved v1 -> default-v2, settings rewritten", JSON.stringify(savedV1Launch));
  const savedV1Stale = resolveRoomSelection('default', [{ id: 'default' }, { id: 'default-v2' }]);
  ok(savedV1Stale.selected === 'default-v2', "saved v1 even with a stale v1 entry listed -> default-v2, never v1", JSON.stringify(savedV1Stale));
  const v1Only = resolveRoomSelection(undefined, [{ id: 'default' }]);
  ok(v1Only.selected === 'none' && v1Only.persist === false, "fresh profile with only a stale v1 entry -> 'none', v1 is never a fallback", JSON.stringify(v1Only));
  const empty = resolveRoomSelection(undefined, []);
  ok(empty.selected === 'none' && empty.persist === false, "fresh profile and nothing available -> 'none', nothing persisted", JSON.stringify(empty));
  const kept = resolveRoomSelection('some-imported-id', [{ id: 'default-v2' }, { id: 'some-imported-id' }]);
  ok(kept.selected === 'some-imported-id' && kept.persist === false, 'existing saved room that is still listed is kept, no write', JSON.stringify(kept));
  const keptV2 = resolveRoomSelection('default-v2', shipped);
  ok(keptV2.selected === 'default-v2' && keptV2.persist === false, 'saved default-v2 is kept, no write', JSON.stringify(keptV2));
  const keptV2Launch = resolveRoomLaunch({ room: 'default-v2', roomChoiceV2: true }, shipped);
  ok(keptV2Launch.selected === 'default-v2' && keptV2Launch.patch === null, 'launch path: saved v2 stays v2, no settings patch', JSON.stringify(keptV2Launch));
  const missing = resolveRoomSelection('gone-id', shipped);
  ok(missing.selected === 'default-v2' && missing.persist === false, 'saved room id that no longer exists -> falls back to the approved shipped room (saved value untouched)', JSON.stringify(missing));
  const noRoom = resolveRoomSelection('none', shipped);
  ok(noRoom.selected === 'none' && noRoom.persist === false, "explicit saved 'none' (user picked No room) stays 'none', never overridden, with a shipped room available", JSON.stringify(noRoom));
  const missingNothing = resolveRoomSelection('gone-id', []);
  ok(missingNothing.selected === 'none', "saved id missing and no shipped room available -> 'none'", JSON.stringify(missingNothing));
}

// -- (7) 0.2.7 -> 0.2.8 one-time room migration (CoS option A). 0.2.7 auto-saved room:'none' on a fresh run without the
//    v1 room, so 'none' with NO marker is indistinguishable from "never chose" -> migrate ONCE to default-v2.
//    Marker key `roomChoiceV2`: absent = never decided; false = migrated from 0.2.7 (explicit, so it never re-runs);
//    true = explicit pick or fresh install ('none' respected forever). Driven through the same fake store main.js uses.
{
  const shipped = [{ id: 'default-v2' }];
  const launch = (st, rooms = shipped) => { const r = resolveRoomLaunch(st.get(), rooms); if (r.patch) st.set(r.patch); return r.selected; };
  const pick = (st, id) => st.set(roomPickPatch(id));

  const s27 = fakeSettings({ room: 'none' }); // a 0.2.7 profile: 'none', no marker
  ok(launch(s27) === 'default-v2', "0.2.7 profile (room:'none', no roomChoiceV2) -> default-v2 selected on first 0.2.8 launch");
  ok(s27.get().room === 'default-v2' && s27.get().roomChoiceV2 === false, "0.2.7 migration persists room:'default-v2' AND the explicit marker roomChoiceV2:false", JSON.stringify(s27.get()));
  const before = JSON.stringify(s27.get());
  ok(launch(s27) === 'default-v2' && JSON.stringify(s27.get()) === before, 'relaunch after the migration is stable: same room, no second change to settings', JSON.stringify(s27.get()));
  ok(resolveRoomLaunch(s27.get(), shipped).patch === null, 'relaunch after the migration produces no settings patch at all');

  const post = fakeSettings({ room: 'none', roomChoiceV2: true }); // explicit post-0.2.8 No room
  const postBefore = JSON.stringify(post.get());
  ok(launch(post) === 'none' && JSON.stringify(post.get()) === postBefore, "explicit post-0.2.8 'none' (roomChoiceV2:true) is kept, nothing written", JSON.stringify(post.get()));

  const noneAfter = fakeSettings({ room: 'none' });
  launch(noneAfter); pick(noneAfter, 'none'); // migrated, then the user chooses No room in the picker
  ok(noneAfter.get().room === 'none' && noneAfter.get().roomChoiceV2 === true, "an explicit pick sets roomChoiceV2:true (here: No room after the migration)", JSON.stringify(noneAfter.get()));
  ok(launch(noneAfter) === 'none' && launch(noneAfter) === 'none' && noneAfter.get().room === 'none', "No room picked after the migration survives repeated relaunches");

  const fresh = fakeSettings({}); // brand-new install: key absent
  ok(launch(fresh) === 'default-v2' && fresh.get().room === 'default-v2' && fresh.get().roomChoiceV2 === true, 'brand-new install: default-v2 selected, persisted, and marker roomChoiceV2:true so it never migrates', JSON.stringify(fresh.get()));

  const noRoomsAvail = fakeSettings({ room: 'none' });
  ok(launch(noRoomsAvail, []) === 'none' && noRoomsAvail.get().roomChoiceV2 === undefined, "0.2.7 'none' but no room is listed: nothing to migrate to, nothing written (retries next launch)", JSON.stringify(noRoomsAvail.get()));

  const imported = fakeSettings({ room: 'some-imported-id' });
  const impBefore = JSON.stringify(imported.get());
  ok(launch(imported, [{ id: 'default-v2' }, { id: 'some-imported-id' }]) === 'some-imported-id' && JSON.stringify(imported.get()) === impBefore, "a 0.2.7 profile with a real room selected is untouched by the migration");
}


// ============================================================================================
// room standard v2 (T-31 camera modes, PLAN-camera-modes.md + coordinator rounds 2-3): structural checks built
// in memory (same "fixtures derived in memory, nothing written to disk" posture as the v1 bad-fixtures above),
// so this section needs no external file to run. A REAL-FILE block follows it, skipped gracefully (not failed)
// when the referenced file is not present on this machine -- same tolerance room-fixtures.mjs's v1 section does
// NOT need (v1's one fixture is mandatory input to this whole script), because a v2 room is still optional/new.
function minimalV2Room(overrides = {}) {
  const view = (patch = {}) => ({
    camera: { pos: [0, 1.3, 2], target: [0, 1.3, 0], three: { fov: 40, aspect: 1.5 } },
    plate: 'plate.png',
    zumi_seat: { pos: [0, 0.58, 0], rotYDeg: 0, pose: 'sit-idle' },
    occluders: [],
    ...patch,
  });
  return { format: 'zumi-room', version: 2, model: 'occluders.glb', views: { talk: view() }, ...overrides };
}

// -- required talk view --
{
  const missing = checkRoomJsonV2({ format: 'zumi-room', version: 2, views: {} });
  ok(missing.refused && missing.refused.code === 'missing_talk_view', 'v2: a room with no talk view is refused', JSON.stringify(missing.refused));
  const notV2 = checkRoomJsonV2({ format: 'zumi-room', version: 1, views: { talk: {} } });
  ok(notV2.refused && notV2.refused.code === 'not_a_room_json', 'v2: version !== 2 is refused as not_a_room_json (never guessed from content)', JSON.stringify(notV2.refused));
}

// -- fallback to talk: a missing work/room view warns and copies talk's own data, not a refusal --
{
  const r = checkRoomJsonV2(minimalV2Room());
  ok(r.ok, 'v2: a room with ONLY talk passes', JSON.stringify(r.refused));
  ok(r.fallback.work === true && r.fallback.room === true, 'v2: work/room both flagged as fallbacks', JSON.stringify(r.fallback));
  ok(r.views.work.camera.fov === r.views.talk.camera.fov, 'v2: the fallback view\'s camera IS talk\'s camera', JSON.stringify({ work: r.views.work.camera, talk: r.views.talk.camera }));
  ok(r.warnings.some((w) => w.code === 'view_falls_back_to_talk' && w.params.view === 'work'), 'v2: the fallback is reported as a warning, not silent');
}

// -- camera: fov/aspect range + viewOffset all-or-nothing --
{
  const badFov = checkRoomJsonV2(minimalV2Room({ views: { talk: { camera: { pos: [0, 1, 1], target: [0, 1, 0], three: { fov: 200, aspect: 1.5 } }, plate: 'p.png', occluders: [] } } }));
  ok(badFov.refused && badFov.refused.code === 'bad_camera', 'v2: an out-of-range fov is refused as bad_camera', JSON.stringify(badFov.refused));
  const halfOffset = checkRoomJsonV2(minimalV2Room({ views: { talk: { camera: { pos: [0, 1, 1], target: [0, 1, 0], three: { fov: 40, aspect: 1.5, viewOffset: { fullWidth: 100 } } }, plate: 'p.png', occluders: [] } } }));
  ok(halfOffset.refused && halfOffset.refused.code === 'bad_camera', 'v2: a half-specified viewOffset is refused (never half-applied)', JSON.stringify(halfOffset.refused));
  const fullOffset = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ camera: { pos: [0, 1, 1], target: [0, 1, 0], three: { fov: 40, aspect: 1.5, viewOffset: { fullWidth: 100, fullHeight: 100, x: 0, y: 0, width: 100, height: 100 } } } }) } }));
  ok(fullOffset.ok, 'v2: a fully-specified viewOffset passes', JSON.stringify(fullOffset.refused));
}
function view2(patch) { return { camera: { pos: [0, 1.3, 2], target: [0, 1.3, 0], three: { fov: 40, aspect: 1.5 } }, plate: 'plate.png', zumi_seat: { pos: [0, 0.58, 0], rotYDeg: 0, pose: 'sit-idle' }, occluders: [], ...patch }; }

// -- occluders: node-name references (not inline geometry), count cap --
{
  const r = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ occluders: [{ name: 'desk', node: 'occ_talk_desk' }] }) } }));
  ok(r.ok && r.views.talk.occluders.length === 1 && r.views.talk.occluders[0].node === 'occ_talk_desk', 'v2: an occluder is a {name,node} reference, not geometry', JSON.stringify(r.views.talk.occluders));
  const tooMany = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ occluders: Array.from({ length: CAPS_V2.occludersPerViewRefuse + 1 }, (_, i) => ({ name: `o${i}`, node: `n${i}` })) }) } }));
  ok(tooMany.refused && tooMany.refused.code === 'too_many_occluders', 'v2: over the per-view occluder cap is refused', JSON.stringify(tooMany.refused));
}

// -- seat: per-view, optional, bad shape warns and drops (round 2: no longer a single room-level anchor) --
{
  const noSeat = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ zumi_seat: undefined }) } }));
  ok(noSeat.ok && noSeat.views.talk.zumi_seat === null, 'v2: a view with no seat passes (she stands instead)', JSON.stringify(noSeat.views.talk.zumi_seat));
  ok(noSeat.warnings.some((w) => w.code === 'missing_seat' && w.params.view === 'talk'), 'v2: the missing seat is reported as a warning');
}

// -- seat scale/offset (work-view fit task, 2026-10-06): optional, per-view, identity default, bounded --
{
  const defaults = checkRoomJsonV2(minimalV2Room());
  ok(defaults.views.talk.zumi_seat.scale === 1 && JSON.stringify(defaults.views.talk.zumi_seat.offset) === '[0,0,0]', 'v2: a seat with no scale/offset defaults to identity (1, [0,0,0])', JSON.stringify(defaults.views.talk.zumi_seat));

  const good = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ zumi_seat: { pos: [0, 0.58, 0], rotYDeg: 0, pose: 'sit-idle', scale: 1.18, offset: [0.01, -0.02, 0.03] } }) } }));
  ok(good.ok && good.views.talk.zumi_seat.scale === 1.18 && JSON.stringify(good.views.talk.zumi_seat.offset) === '[0.01,-0.02,0.03]', 'v2: a well-formed scale/offset passes through unchanged', JSON.stringify(good.views.talk.zumi_seat));

  const badScale = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ zumi_seat: { pos: [0, 0.58, 0], rotYDeg: 0, pose: 'sit-idle', scale: 5 } }) } }));
  ok(badScale.ok && badScale.views.talk.zumi_seat.scale === 1 && badScale.warnings.some((w) => w.code === 'bad_seat_scale' && w.params.view === 'talk'), 'v2: an out-of-range scale is dropped to the identity (1) with a warning, not a refusal', JSON.stringify({ scale: badScale.views.talk.zumi_seat.scale, warnings: badScale.warnings }));

  const badOffset = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ zumi_seat: { pos: [0, 0.58, 0], rotYDeg: 0, pose: 'sit-idle', offset: [9, 0, 0] } }) } }));
  ok(badOffset.ok && JSON.stringify(badOffset.views.talk.zumi_seat.offset) === '[0,0,0]' && badOffset.warnings.some((w) => w.code === 'bad_seat_offset' && w.params.view === 'talk'), 'v2: an out-of-range offset is dropped to [0,0,0] with a warning, not a refusal', JSON.stringify({ offset: badOffset.views.talk.zumi_seat.offset, warnings: badOffset.warnings }));
}

// -- allowed_region (work-view fit task): optional per-view QC polygon list, caps, malformed drops with a warning --
{
  const noRegion = checkRoomJsonV2(minimalV2Room());
  ok(Array.isArray(noRegion.views.talk.allowed_region) && noRegion.views.talk.allowed_region.length === 0, 'v2: a view with no allowed_region gets an empty list (not null/undefined)', JSON.stringify(noRegion.views.talk.allowed_region));

  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const withRegion = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ allowed_region: [square] }) } }));
  ok(withRegion.ok && withRegion.views.talk.allowed_region.length === 1 && JSON.stringify(withRegion.views.talk.allowed_region[0]) === JSON.stringify(square), 'v2: a well-formed allowed_region polygon passes through unchanged', JSON.stringify(withRegion.views.talk.allowed_region));

  const tooFewPoints = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ allowed_region: [[[0, 0], [1, 1]]] }) } }));
  ok(tooFewPoints.ok && tooFewPoints.views.talk.allowed_region.length === 0 && tooFewPoints.warnings.some((w) => w.code === 'bad_allowed_region_polygon'), 'v2: a polygon with <3 points is dropped with a warning, not a refusal', JSON.stringify(tooFewPoints.warnings));

  const tooMany = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ allowed_region: Array.from({ length: CAPS_V2.allowedRegionPolygonsRefuse + 1 }, () => square) }) } }));
  ok(tooMany.ok && tooMany.views.talk.allowed_region.length === 0 && tooMany.warnings.some((w) => w.code === 'too_many_allowed_region_polygons'), 'v2: over the per-view allowed_region polygon cap drops them all with a warning (never a refusal -- QC-only data)', JSON.stringify(tooMany.warnings));
}

// -- seat_cushion_line (work-view fit task, coordinator round 5): optional per-view 2-point QC line --
{
  const noLine = checkRoomJsonV2(minimalV2Room());
  ok(noLine.views.talk.seat_cushion_line === null, 'v2: a view with no seat_cushion_line is null (not an empty array)', JSON.stringify(noLine.views.talk.seat_cushion_line));

  const line = [[100, 200], [300, 220]];
  const withLine = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ seat_cushion_line: line }) } }));
  ok(withLine.ok && JSON.stringify(withLine.views.talk.seat_cushion_line) === JSON.stringify(line), 'v2: a well-formed seat_cushion_line passes through unchanged', JSON.stringify(withLine.views.talk.seat_cushion_line));

  const badLine = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ seat_cushion_line: [[100, 200], [300, 220], [400, 230]] }) } }));
  ok(badLine.ok && badLine.views.talk.seat_cushion_line === null && badLine.warnings.some((w) => w.code === 'bad_seat_cushion_line'), 'v2: a line with != 2 points is dropped with a warning, not a refusal', JSON.stringify(badLine.warnings));
}

// -- lights (coordinator round 3): optional per view, caps, falls back to default when absent --
{
  const noLights = checkRoomJsonV2(minimalV2Room());
  ok(noLights.views.talk.lights.length === 0, 'v2: a view with no lights field has an empty lights list (default rig stays on)');
  const withLights = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ lights: [{ type: 'point', color: '#ffaa00', intensity: 2, position: [0, 1, 0] }, { type: 'hemisphere', skyColor: '#7a8cd2', groundColor: '#5a5068', intensity: 1 }] }) } }));
  ok(withLights.ok && withLights.views.talk.lights.length === 2, 'v2: well-formed point + hemisphere lights pass through', JSON.stringify(withLights.views.talk.lights));
  const badLight = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ lights: [{ type: 'point', color: 'not-a-color', intensity: 2, position: [0, 1, 0] }] }) } }));
  ok(badLight.ok && badLight.views.talk.lights.length === 0 && badLight.warnings.some((w) => w.code === 'bad_light'), 'v2: a malformed light is dropped with a warning, not a refusal', JSON.stringify(badLight.warnings));
  const tooManyLights = checkRoomJsonV2(minimalV2Room({ views: { talk: view2({ lights: Array.from({ length: CAPS_V2.lightsPerViewRefuse + 1 }, () => ({ type: 'hemisphere', skyColor: '#ffffff', groundColor: '#000000', intensity: 1 })) }) } }));
  ok(tooManyLights.refused == null && tooManyLights.warnings.some((w) => w.code === 'too_many_lights'), 'v2: over the per-view lights cap drops them all with a warning (never a refusal -- lighting is cosmetic)', JSON.stringify(tooManyLights.warnings));
}

// -- real files, skipped (not failed) when absent on this machine --
for (const [label, p] of [['Vesta\'s v2-B room', `${ownerPath('roomV2Dir', 'local/room-v2')}/room.json`], ['the T-31 camera-modes stand-in', `${ownerPath('standinRoom', 'local/standin-room-v2')}/room.json`]]) {
  if (!fs.existsSync(p)) { console.log(`SKIP v2 real-file check (${label} not present at ${p})`); continue; }
  const r = checkRoomJsonFile(p);
  ok(r.ok === true, `v2: ${label} passes the checker`, JSON.stringify(r.refused));
  if (r.ok) ok(r.views.talk && r.views.work && r.views.room, `v2: ${label} resolves all three views`, Object.keys(r.views || {}));
}

console.log(`\ncheck:room ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
