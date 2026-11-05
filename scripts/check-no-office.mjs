// T-31 0.2.11 owner decision (default-room-q, 2026-10-26): room v1 "Zumi's Office" is below standard and is REMOVED
// from the app, so it can never be picked by mistake again (it was once, for the H-04 video). Night City (default-v2)
// stays. Headless, plain Node, no Electron:
//   node scripts/check-no-office.mjs
// 1 not staged: no resources-pinned/room-v1 in the repo, in build.extraResources or in the afterPack pin list;
// 2 not listed: main.js has no v1 room entry, no app://zumi/rooms/default/ route, no v1 path resolver;
// 3 not selectable: a saved v1 choice resolves to default-v2 (persisted once), v1 is never a fallback,
//   and no app test harness switches to it;
// 4 not in either picker's sources (room list above, video-room manifest) or in the third-party manifest;
// 5 not in any wording: no UI string (en/vi/zh i18n tables) and no room display name says "Office" / "Văn phòng" /
//   "办公室", and default-v2 is labelled "Night City" / "Thành phố đêm" / "城市夜景" in the Settings picker and the
//   "{current}" clause (owner calls the approved room; id, file names and settings keys stay default-v2).
// 6 Tauri (ported from Pi's 0ff6dc9e + f8901072, T-31-TAURI preview.3): the sidecar neither lists nor serves v1, rewrites a
//   saved v1 once, the bundle gate refuses the importer's test .glb fixture, and the shell markup says no Office (0.2.11 release notes announce the removal, so they are not checked).
// 7 no name clash: in every locale the room names (Settings picker + video scene picker) are pairwise distinct and only
//   default-v2 says "night city"; video room rooftop-night is "Rooftop" / "Sân thượng" / "天台" (id + file unchanged).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---- 1: not staged
ok(!fs.existsSync(path.join(ROOT, 'resources-pinned', 'room-v1')), 'resources-pinned/room-v1 is gone from the repo tree');
const pkg = JSON.parse(read('package.json'));
const extra = JSON.stringify(pkg.build.extraResources || []);
ok(!/room-v1/.test(extra), 'package.json build.extraResources does not stage room-v1', extra.match(/[^"]*room-v1[^"]*/g));
ok(!/room-v1/.test(read('scripts/builder-selftest.cjs')), 'owner build config (builder-selftest.cjs) does not stage room-v1');
const { PINNED_ROOM_DIRS } = require('./lib/pinned-rooms.cjs');
ok(JSON.stringify(PINNED_ROOM_DIRS) === JSON.stringify(['room-v2']), 'afterPack pin list is exactly [room-v2]', JSON.stringify(PINNED_ROOM_DIRS));

// ---- 2: not listed / not served (main.js is Electron CJS, so this part is a source scan)
const main = read('src/main/main.js').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
ok(!/roomEntry\(\s*'default'\s*,/.test(main), "main.js listRooms() has no v1 'default' room entry");
ok(!/rooms\\\/default\\\//.test(main), 'main.js serves no app://zumi/rooms/default/ route');
ok(!/ensureDefaultRoomCopy\b|roomDefaultPath\b/.test(main), 'main.js no longer resolves or copies the v1 room');
const rp = require('../src/main/room-paths.js');
ok(!('roomDefaultPath' in rp) && !('roomV1PinnedPath' in rp), 'room-paths.js exports no v1 room resolver', Object.keys(rp).join(','));
ok(!/defaultRoomIssue/.test(read('src/renderer/room-settings.js')), 'Settings room picker no longer has a v1 "default room damaged" note');

// ---- 3: not selectable
const rd = await import('../src/main/room-default.mjs');
const both = [{ id: 'default' }, { id: 'default-v2' }];
const v2 = [{ id: 'default-v2' }];
const savedV1 = rd.resolveRoomSelection('default', both);
ok(savedV1.selected === 'default-v2' && savedV1.persist === true, "saved v1 'default' resolves to default-v2 and is persisted, even if a stale list still carried v1", JSON.stringify(savedV1));
const savedV1Shipped = rd.resolveRoomSelection('default', v2);
ok(savedV1Shipped.selected === 'default-v2' && savedV1Shipped.persist === true, "saved v1 'default' on a normal install -> default-v2, persisted", JSON.stringify(savedV1Shipped));
const launchV1 = rd.resolveRoomLaunch({ room: 'default', roomChoiceV2: true }, v2);
ok(launchV1.selected === 'default-v2' && launchV1.patch && launchV1.patch.room === 'default-v2', "launch: saved v1 -> default-v2 and settings.room rewritten to default-v2", JSON.stringify(launchV1));
const launchV1Legacy = rd.resolveRoomLaunch({ room: 'default' }, v2);
ok(launchV1Legacy.selected === 'default-v2' && launchV1Legacy.patch && launchV1Legacy.patch.room === 'default-v2', 'launch: saved v1 from a pre-0.2.8 profile (no marker) -> default-v2, rewritten', JSON.stringify(launchV1Legacy));
const savedV1NoV2 = rd.resolveRoomSelection('default', []);
ok(savedV1NoV2.selected === 'none' && savedV1NoV2.persist === false, "saved v1 with no default-v2 available -> 'none' (never v1), nothing written", JSON.stringify(savedV1NoV2));
const v1Only = rd.resolveRoomSelection(undefined, [{ id: 'default' }]);
ok(v1Only.selected === 'none', "fresh profile with only a stale v1 entry -> 'none', v1 is never a fallback", JSON.stringify(v1Only));
const gone = rd.resolveRoomSelection('gone-id', [{ id: 'default' }]);
ok(gone.selected === 'none', "saved id gone + only a stale v1 entry -> 'none', never v1", JSON.stringify(gone));
const fresh = rd.resolveRoomSelection(undefined, both);
ok(fresh.selected === 'default-v2' && fresh.persist === true, 'fresh profile -> default-v2 (Night City), persisted', JSON.stringify(fresh));
const harnessHits = [];
for (const dir of ['src/renderer/selftest', 'src/renderer/shots']) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.js'))) {
    const s = read(`${dir}/${f}`);
    if (/switchRoom\(\s*'default'\s*\)|\.value\s*=\s*'default'\s*;/.test(s)) harnessHits.push(`${dir}/${f}`);
  }
}
ok(harnessHits.length === 0, 'no selftest/shots harness switches to the v1 room', harnessHits.join(', '));

// ---- 4: neither picker's source lists it; no v1 licence entries left behind
const videos = JSON.parse(read('assets/rooms-video/rooms.json')).rooms;
ok(!videos.some((r) => r.id === 'default' || /office/i.test(`${r.id} ${r.label} ${r.file}`)), 'scene picker (video rooms manifest) lists no Office room', JSON.stringify(videos.map((r) => r.id)));
for (const m of ['third-party-manifest.json', 'tauri/third-party-manifest.json'].filter((f) => fs.existsSync(path.join(ROOT, f)))) ok(!/room-v1/.test(read(m)), `${m} has no room-v1 entry`);
ok(!/room-v1|Kenney|KayKit/i.test(read('THIRD_PARTY_LICENSES.md')), 'THIRD_PARTY_LICENSES.md credits no v1 room assets');

// ---- 5: no "Office" wording for rooms anywhere the owner reads; default-v2 is "Night City" / "Thành phố đêm"
const OFFICE = /office|văn phòng|办公室/i;
const pinnedRoom = JSON.parse(read('resources-pinned/room-v2/room.json'));
ok(pinnedRoom.name === 'Night City', 'pinned default-v2 room.json display name is "Night City"', JSON.stringify(pinnedRoom.name));
const { TABLES, setLocale } = await import('../src/renderer/i18n.js');
const officeStrings = [];
for (const [lang, table] of Object.entries(TABLES)) {
  for (const [key, value] of Object.entries(table)) if (OFFICE.test(String(value))) officeStrings.push(`${lang}:${key}="${value}"`);
}
ok(officeStrings.length === 0, 'no UI string in any locale says Office / Văn phòng / 办公室', officeStrings.join(' | '));
const WANT = { en: 'Night City', vi: 'Thành phố đêm', zh: '城市夜景' };
for (const [lang, want] of Object.entries(WANT)) {
  const got = TABLES[lang] && TABLES[lang]['room.name.default-v2'];
  ok(got === want, `i18n [${lang}] room.name.default-v2 is "${want}"`, JSON.stringify(got));
}
// What the Settings picker and the "{current}" clause render for default-v2, whatever name a stale room.json still
// carries (a dev build live-reads the room repo; an installed app may hold an older validated copy).
const msgs = await import('../src/renderer/room/messages.js');
const staleV2 = { id: 'default-v2', label: "Zumi's Office — Night" };
const labelOf = (r) => (typeof msgs.roomLabel === 'function' ? msgs.roomLabel(r) : null);
for (const [lang, want] of Object.entries(WANT)) {
  setLocale(lang);
  ok(labelOf(staleV2) === want, `[${lang}] room label for default-v2 is "${want}" (not the room.json name)`, JSON.stringify(labelOf(staleV2)));
  const clause = msgs.currentRoomClause({ rooms: [staleV2], selected: 'default-v2' });
  ok(clause.includes(want) && !OFFICE.test(clause), `[${lang}] "{current}" clause names default-v2 "${want}"`, JSON.stringify(clause));
}
setLocale('en');
ok(labelOf({ id: 'abc123', label: 'My loft' }) === 'My loft', 'an imported room keeps its own label', JSON.stringify(labelOf({ id: 'abc123', label: 'My loft' })));
ok(/roomLabel\(/.test(read('src/renderer/room-settings.js')), 'Settings room picker (room-settings.js) labels rooms through roomLabel()');

// ---- 6: Tauri sidecar + bundle gate + shell markup
{
  const { createBootReads } = await import('../tauri/sidecar/boot-reads.mjs');
  const tmp = path.join(ROOT, '.check-no-office-tmp'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  try {
    const file = path.join(tmp, 'settings.json'); fs.writeFileSync(file, JSON.stringify({ room: 'default', roomChoiceV2: true }));
    const get = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const boot = createBootReads({ dataDir: tmp, settings: get, saveSettings: (pt) => fs.writeFileSync(file, JSON.stringify({ ...get(), ...pt })) });
    const res = await boot.listRooms();
    ok(!res.rooms.some((r) => r.id === 'default') && res.selected === 'default-v2' && get().room === 'default-v2', 'Tauri sidecar: saved v1 -> default-v2, listed without v1, settings.room rewritten once', JSON.stringify({ sel: res.selected, saved: get().room }));
    ok(boot.resolveAsset('rooms/default/room.glb') === null, 'Tauri sidecar serves no rooms/default/ asset');
    // the renamed room.json (new pinned sha) is re-validated and re-copied ONCE over an install that holds the old copy
    const file2 = path.join(tmp, 'v2', 'settings.json'); fs.mkdirSync(path.dirname(file2), { recursive: true });
    fs.writeFileSync(file2, JSON.stringify({ room: 'default-v2', roomChoiceV2: true, defaultRoomV2GoodSha: '34448a707156' }));
    const get2 = () => JSON.parse(fs.readFileSync(file2, 'utf8'));
    const boot2 = createBootReads({ dataDir: path.dirname(file2), settings: get2, saveSettings: (pt) => fs.writeFileSync(file2, JSON.stringify({ ...get2(), ...pt })) });
    const pinSha = JSON.parse(read('resources-pinned/room-v2/PIN-MANIFEST.json')).files['room.json'].sha256;
    const r2 = await boot2.listRooms();
    const copied = path.join(path.dirname(file2), 'rooms', 'default-v2', get2().defaultRoomV2GoodSha || 'x', 'room.json');
    ok(pinSha.startsWith(get2().defaultRoomV2GoodSha) && fs.existsSync(copied) && JSON.parse(fs.readFileSync(copied, 'utf8')).name === 'Night City' && r2.selected === 'default-v2', 'Tauri sidecar: an old default-v2 copy (34448a707156) is re-copied once as the renamed room (pinned sha), selection unchanged', JSON.stringify({ sha: get2().defaultRoomV2GoodSha, sel: r2.selected }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const rs = read('tauri/src-tauri/src/asset_route.rs');
  const routeFn = rs.slice(rs.indexOf('"rooms" => {'), rs.indexOf('_ => {', rs.indexOf('"rooms" => {')));
  ok(routeFn.length > 50 && !/"default"/.test(routeFn), 'asset_route.rs has no rooms/default route');
  ok(/the bundle ships no room \.glb test fixture/.test(read('tauri/verify/check-bundle.mjs')) && /check-bundle\.mjs'\) --dir \$payloadDir/.test(read('tauri/build.ps1')), 'the bundle gate refuses the room .glb test fixture, on the stage and on the extracted installer payload');
  ok(!/room-v1|room\.glb/.test(read('tauri/stage-bundle.mjs')), 'tauri/stage-bundle.mjs stages no room-v1 and no room .glb fixture');
  const html = read('src/renderer/index.html').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  ok(!OFFICE.test(html), 'index.html shows no Office / Văn phòng / 办公室 text');
}

// ---- 7: no two room names clash (CoS spec 0.2.11): default-v2 is "Night City" / "Thành phố đêm", so the video room
// once called "Rooftop night city" is now "Rooftop" / "Sân thượng" / "天台". In every locale, the names the owner can
// pick (Settings room picker + video scene picker) are pairwise distinct, and only default-v2 says "night city".
const NIGHT_CITY = /night city|thành phố đêm|城市夜景/i;
const sceneLabelOf = (r) => (typeof msgs.sceneLabel === 'function' ? msgs.sceneLabel(r) : r.label);
const ROOFTOP = { en: 'Rooftop', vi: 'Sân thượng', zh: '天台' };
ok(videos.every((r) => !NIGHT_CITY.test(r.label)), 'video rooms manifest: no display name says "night city"', JSON.stringify(videos.map((r) => r.label)));
for (const lang of Object.keys(TABLES)) {
  setLocale(lang);
  const labels = [labelOf(staleV2), ...videos.map(sceneLabelOf)];
  const norm = labels.map((s) => String(s).trim().toLowerCase());
  const dupes = norm.filter((s, i) => norm.indexOf(s) !== i);
  ok(dupes.length === 0, `[${lang}] no two room names are the same`, JSON.stringify(labels));
  const nightCity = labels.filter((s) => NIGHT_CITY.test(s));
  ok(nightCity.length === 1 && nightCity[0] === labelOf(staleV2), `[${lang}] only default-v2 is named "night city" / "thành phố đêm"`, JSON.stringify(nightCity));
  const rooftop = sceneLabelOf(videos.find((r) => r.id === 'rooftop-night'));
  ok(rooftop === ROOFTOP[lang], `[${lang}] video room rooftop-night is "${ROOFTOP[lang]}"`, JSON.stringify(rooftop));
}
setLocale('en');
ok(videos.every((r) => sceneLabelOf(r) === r.label), '[en] every video room name equals its manifest label (one English source)', JSON.stringify(videos.map((r) => [r.label, sceneLabelOf(r)])));
ok(/sceneLabel\(/.test(read('src/renderer/app.js')), 'video scene picker (app.js) labels rooms through sceneLabel()');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
