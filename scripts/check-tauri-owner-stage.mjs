// T-31 P3-A: the OWNER flavour stage carries the 7 room videos (<resources>/rooms-video, size+sha256 pinned by
// assets/rooms-video/rooms.json) and flavour.json with the builder-selftest.cjs values; the PUBLIC stage carries neither.
//
//   node scripts/check-tauri-owner-stage.mjs
//
// Fixture videos (tiny files + a fixture manifest) for the fail paths; the real manifest + real owner values for the
// pins. No cargo, no GUI, no packaging. The real mp4s are only read when present (never copied by this check).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createBootReads } from '../tauri/sidecar/boot-reads.mjs';
import { roomsVideoDir } from '../tauri/sidecar/adapters.mjs';

import { stageRoomVideos, verifyStagedRoomVideos, stageFlavourFile, verifyStagedFlavour } from '../tauri/flavour-stage.mjs';
import { FLAVOURS, flavourFileText } from '../tauri/sidecar/flavour.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

const repo = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const throws = (fn, re, name) => { try { fn(); ok(false, name, 'did not throw'); } catch (e) { ok(re.test(String(e.message)), name, e.message); } };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const realManifest = JSON.parse(fs.readFileSync(path.join(repo, 'assets', 'rooms-video', 'rooms.json'), 'utf8'));
const REAL_VIDEO_DIR = realManifest.localDir || ownerPath('roomsVideoDir', 'local/rooms-video'); // the owner values' video folder
const tmp = fs.mkdtempSync(path.join(process.env.ZUMI_CHECK_TMP || os.tmpdir(), 'zumi-owner-stage-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- fixture: two tiny "videos" + a manifest that pins them ----
const src = path.join(tmp, 'src'); fs.mkdirSync(src);
const rooms = [['a-room', '01-a-room.mp4', Buffer.from('video-a-bytes')], ['b-room', '02-b-room.mp4', Buffer.from('video-b-bytes!!')]];
for (const [, f, b] of rooms) fs.writeFileSync(path.join(src, f), b);
const fixtureManifest = { ...realManifest, default: undefined, localDir: src, rooms: rooms.map(([id, file, b]) => ({ ...realManifest.rooms[0], id, file, bytes: b.length, sha256: sha(b) })) };
const manifestPath = path.join(tmp, 'rooms.json'); fs.writeFileSync(manifestPath, JSON.stringify(fixtureManifest));
const stageOf = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };

// owner: videos land in <stage>/rooms-video with the pinned bytes
{
  const stage = stageOf('owner');
  const r = stageRoomVideos(stage, { env: {}, manifestPath });
  ok(r.count === 2, 'owner stage copies every listed video', JSON.stringify(r));
  ok(rooms.every(([, f, b]) => fs.readFileSync(path.join(stage, 'rooms-video', f)).equals(b)), 'staged bytes equal the source bytes');
  ok(fs.readdirSync(path.join(stage, 'rooms-video')).length === 2, 'nothing but the listed files is staged');
  ok(verifyStagedRoomVideos(stage, fixtureManifest).length === 0, 'verifyStagedRoomVideos accepts a good stage');
  fs.appendFileSync(path.join(stage, 'rooms-video', '01-a-room.mp4'), 'x');
  ok(verifyStagedRoomVideos(stage, fixtureManifest).length > 0, 'verifyStagedRoomVideos refuses a changed video');
  fs.rmSync(path.join(stage, 'rooms-video', '02-b-room.mp4'));
  ok(verifyStagedRoomVideos(stage, fixtureManifest).some((p) => /02-b-room/.test(p)), 'verifyStagedRoomVideos names a missing video');
}
// source dir: ZUMI_ROOMS_SRC_DIR wins over localDir
{
  const other = path.join(tmp, 'other-src'); fs.mkdirSync(other);
  for (const [, f, b] of rooms) fs.writeFileSync(path.join(other, f), b);
  const m2 = path.join(tmp, 'rooms2.json'); fs.writeFileSync(m2, JSON.stringify({ ...fixtureManifest, localDir: path.join(tmp, 'does-not-exist') }));
  ok(stageRoomVideos(stageOf('envsrc'), { env: { ZUMI_ROOMS_SRC_DIR: other }, manifestPath: m2 }).count === 2, 'ZUMI_ROOMS_SRC_DIR is the source dir when set');
  throws(() => stageRoomVideos(stageOf('nodir'), { env: {}, manifestPath: m2 }), /missing room video/, 'a missing source dir fails the build');
}
// wrong size / wrong sha / missing file fail the build
{
  fs.writeFileSync(path.join(src, '01-a-room.mp4'), Buffer.from('video-a-BYTES')); // same size, other sha
  throws(() => stageRoomVideos(stageOf('badsha'), { env: {}, manifestPath }), /sha256/, 'a wrong sha256 fails the build');
  fs.writeFileSync(path.join(src, '01-a-room.mp4'), Buffer.from('short'));
  throws(() => stageRoomVideos(stageOf('badsize'), { env: {}, manifestPath }), /size/, 'a wrong size fails the build');
  fs.rmSync(path.join(src, '01-a-room.mp4'));
  throws(() => stageRoomVideos(stageOf('nofile'), { env: {}, manifestPath }), /missing room video/, 'a missing video fails the build');
}
// a manifest naming a traversal file or folder is refused before any copy
{
  const evil = { ...fixtureManifest, rooms: [{ ...fixtureManifest.rooms[0], file: '../evil.mp4' }] };
  const p = path.join(tmp, 'evil.json'); fs.writeFileSync(p, JSON.stringify(evil));
  throws(() => stageRoomVideos(stageOf('evil'), { env: {}, manifestPath: p }), /plain/, 'a manifest file name with a path is refused');
  const evil2 = { ...fixtureManifest, packagedDir: '..' };
  const p2 = path.join(tmp, 'evil2.json'); fs.writeFileSync(p2, JSON.stringify(evil2));
  throws(() => stageRoomVideos(stageOf('evil2'), { env: {}, manifestPath: p2 }), /plain/, 'a manifest packagedDir with a path is refused');
}

// flavour.json: owner values pinned to builder-selftest.cjs extraMetadata; public = no file
{
  const self = fs.readFileSync(path.join(repo, 'scripts', 'builder-selftest.cjs'), 'utf8');
  const meta = /extraMetadata:\s*(\{[^\n]*\})/.exec(self)[1];
  const m = new Function('OWNER_CLOUD_BASE', `return (${meta})`)(ownerPath('cloudBase', null)); // builder-selftest.cjs: the owner values' cloudBase
  const want = { cloudBase: m.zumiCloud.base, test: m.zumiTest, reflexEgress: m.zumiReflexJev.egress, ownerAdmin: m.zumiOwnerAdmin, boardMirror: m.zumiBoardMirror };
  ok(JSON.stringify(FLAVOURS.owner) === JSON.stringify(want), 'owner flavour values == builder-selftest.cjs extraMetadata', JSON.stringify(FLAVOURS.owner));
  ok(want.ownerAdmin === true && want.reflexEgress === true && want.cloudBase === ownerPath('cloudBase', null) && FLAVOURS.owner.cloudBase === ownerPath('cloudBase', null) && want.boardMirror === 'http://127.0.0.1:3100', 'owner values: ownerAdmin, reflex-Jev egress, dev cloud, board mirror');

  const o = stageOf('flav-owner');
  stageFlavourFile(o, 'owner');
  ok(fs.readFileSync(path.join(o, 'flavour.json'), 'utf8') === flavourFileText('owner'), 'owner stage writes flavour.json with the owner text');
  ok(verifyStagedFlavour(o, 'owner').some((s) => /rooms-video/.test(s)) && !verifyStagedFlavour(o, 'owner').some((s) => /flavour\.json/.test(s)), 'owner stage: flavour.json fine, rooms-video still required');
  ok(verifyStagedFlavour(o, 'public').length > 0, 'verifyStagedFlavour(public) refuses a stage holding flavour.json');
  const p = stageOf('flav-public');
  fs.writeFileSync(path.join(p, 'flavour.json'), 'stale'); stageFlavourFile(p, 'public');
  ok(!fs.existsSync(path.join(p, 'flavour.json')), 'public stage removes a stale flavour.json');
  ok(verifyStagedFlavour(p, 'public').length === 0, 'verifyStagedFlavour(public) accepts a clean stage');
  ok(verifyStagedFlavour(p, 'owner').length > 0, 'verifyStagedFlavour(owner) refuses a stage without flavour.json');
  fs.mkdirSync(path.join(p, 'rooms-video')); fs.writeFileSync(path.join(p, 'rooms-video', 'x.mp4'), 'x');
  ok(verifyStagedFlavour(p, 'public').some((s) => /rooms-video/.test(s)), 'a public stage holding rooms-video is refused');
}

// sidecar: the rooms folder comes from <resources>/rooms-video when packaged; ZUMI_ROOMS_VIDEO_DIR stays the dev override
{
  const bs = String.fromCharCode(92);
  const res = path.join(tmp, 'res'); fs.mkdirSync(res);
  ok(roomsVideoDir(realManifest, { env: {}, resourcesPath: undefined }) === null, 'no env and no resources dir (a dev run without videos) -> no folder');
  ok(roomsVideoDir(realManifest, { env: {}, resourcesPath: res }) === path.join(res, 'rooms-video'), 'packaged: <resources>/rooms-video');
  ok(roomsVideoDir(realManifest, { env: { ZUMI_ROOMS_VIDEO_DIR: path.join(tmp, 'dev') }, resourcesPath: res }) === path.join(tmp, 'dev'), 'ZUMI_ROOMS_VIDEO_DIR overrides the resources folder');
  ok(roomsVideoDir({ ...realManifest, packagedDir: '..' + bs + 'x' }, { env: {}, resourcesPath: res }) === null, 'a packagedDir that is not a plain name is never joined');

  const listWith = (manifest, resourcesPath) => {
    const dataDir = stageOf('data-' + Math.random().toString(36).slice(2));
    const mf = path.join(dataDir, 'rooms.json'); fs.writeFileSync(mf, JSON.stringify(manifest));
    fs.copyFileSync(path.join(repo, 'assets', 'rooms-video', realManifest.chair.file), path.join(dataDir, realManifest.chair.file));
    const saved = [process.env.ZUMI_ROOMS_VIDEO_DIR, process.resourcesPath];
    delete process.env.ZUMI_ROOMS_VIDEO_DIR; process.resourcesPath = resourcesPath;
    try {
      let settings = {};
      return createBootReads({ dataDir, settings: () => settings, saveSettings: (p) => { settings = { ...settings, ...p }; }, dirs: { scenesManifest: mf } }).listScenes();
    } finally {
      if (saved[0] === undefined) delete process.env.ZUMI_ROOMS_VIDEO_DIR; else process.env.ZUMI_ROOMS_VIDEO_DIR = saved[0];
      process.resourcesPath = saved[1];
    }
  };
  // public: no rooms-video in the resources -> no video rooms (the release answer)
  ok(listWith(fixtureManifest, res).rooms.length === 0, 'resources without rooms-video list no video rooms (public)');
  // owner fixture: stage -> list
  fs.writeFileSync(path.join(src, '01-a-room.mp4'), rooms[0][2]);
  const ownerRes = stageOf('owner-res'); stageRoomVideos(ownerRes, { env: {}, manifestPath });
  ok(listWith(fixtureManifest, ownerRes).rooms.length === 2, 'a staged owner resources dir lists its 2 fixture rooms');
  // real: the 7 real videos staged exactly as the owner build does -> scenes:list returns 7
  const real = realManifest.rooms.map((r) => path.join(REAL_VIDEO_DIR, r.file));
  if (real.every(fs.existsSync)) {
    const realRes = stageOf('real-res'); stageRoomVideos(realRes);
    const listed = listWith(realManifest, realRes);
    ok(listed.rooms.length === 7 && listed.error === null, 'owner stage of the real videos -> scenes:list returns 7 rooms', JSON.stringify(listed).slice(0, 200));
  } else console.log('SKIP real videos not on this machine');
}

// wiring: only the owner/selftest flavour stages videos; build.ps1 passes the flavour through
{
  const stageSrc = fs.readFileSync(path.join(repo, 'tauri', 'stage-bundle.mjs'), 'utf8');
  ok(/--flavour/.test(stageSrc) && /stageRoomVideos/.test(stageSrc) && /stageFlavourFile/.test(stageSrc), 'stage-bundle takes --flavour and stages videos + flavour.json');
  ok(/flavour !== 'public'/.test(stageSrc), 'videos are staged only for a non-public flavour');
  const ps = fs.readFileSync(path.join(repo, 'tauri', 'build.ps1'), 'utf8');
  ok(/\$stageArgs \+= '--flavour', \$Flavour/.test(ps), 'build.ps1 passes -Flavour to stage-bundle');
  ok(/check-bundle\.mjs'\) --dir \$stagedDir --flavour \$Flavour/.test(ps) && /\$bundleCheckArgs = @\('--flavour', \$Flavour\)/.test(ps), 'build.ps1 checks the stage AND the unpacked dir against the flavour');
  ok(/-\$Flavour-installer\.exe/.test(ps), 'build.ps1 keeps a non-public installer apart from the public one');
}
// the release package.json packs no videos (so the public flavour matches 0.2.9 public)
{
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  ok(!JSON.stringify(pkg.build.extraResources || []).includes('rooms-video'), 'the release package.json packs no room videos');
}
// room v1 "Zumi's Office" was removed (owner rejected it, 2026-10-26): no stage helper or repo folder for it is left
{
  ok(!fs.existsSync(path.join(repo, 'resources-pinned', 'room-v1')) && !/verifyStagedRoomV1/.test(fs.readFileSync(path.join(repo, 'tauri', 'flavour-stage.mjs'), 'utf8')), 'room v1 is gone: no resources-pinned/room-v1, no verifyStagedRoomV1');
}
// real pins: when the real mp4s are on this box they match rooms.json (the owner build would otherwise fail)
{
  const real = realManifest.rooms.map((r) => path.join(REAL_VIDEO_DIR, r.file));
  if (real.every(fs.existsSync)) {
    const bad = realManifest.rooms.filter((r) => { const b = fs.readFileSync(path.join(REAL_VIDEO_DIR, r.file)); return b.length !== r.bytes || sha(b) !== r.sha256; });
    ok(bad.length === 0 && realManifest.rooms.length === 7, 'the 7 real videos match rooms.json size+sha256', bad.map((r) => r.id).join(','));
  } else console.log('SKIP real videos not on this machine');
}

if (fail) { console.log(`check-tauri-owner-stage FAIL (${fail} failed, ${pass} passed)`); process.exit(1); }
console.log(`check-tauri-owner-stage PASS (${pass} assertions)`);
