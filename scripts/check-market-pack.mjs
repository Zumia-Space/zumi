// check:market-pack (T-31 Marketplace). Owner 02-11: each item type has its own standard, and a bad package is refused with a clear
// message. For every type: a good package passes, and each planted fault is refused with its own code and a message naming the rule.
// Also: zip attacks, the room values against the shipped rooms, the real docs, and the upload rule (no code from users).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import zlibMod from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packZip, sha256, zipBuffer } from './lib/zip-write.mjs';
import { PACK_KINDS, ROOM_PLATE_SIZE, ROOM_VIDEO_SIZE, STANDARD, validatePackZip } from '../tauri/sidecar/market-standard.mjs';
import { HOST_API, checkDownload, loadVerdict, pickVersion, verifyIndex } from '../tauri/sidecar/market-store.mjs';
import { generateKeyPair, keyIdOf, parsePublicKey, publicKeyText, signMinisign } from '../tauri/sidecar/market-sign.mjs';
import { sceneDescriptor, sceneGlb } from './lib/scene-fixture.mjs';
import { packDirZip } from './market-pack-dir.mjs';

const { TEMPLATE_IDS } = createRequire(import.meta.url)('../src/main/soul-prefs.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-market-pack-'));
let n = 0;
async function verdict(buf, opts = {}) {
  const zip = path.join(tmp, `p${++n}.zip`);
  fs.writeFileSync(zip, buf);
  const dest = path.join(tmp, `p${n}`);
  const v = await validatePackZip(zip, dest, opts);
  v.destLeft = fs.existsSync(dest);
  return v;
}
const LIC = { spdx: 'Apache-2.0', file: 'LICENSE.txt' };
const base = (kind, extra = {}) => ({ format: 'zumi-pack/1', id: `${kind}.sample`, kind, version: '1.0.0', name: { en: 'Sample' }, author: { name: 'Zumia' }, licence: LIC, ...extra });

// ---------- fixture files with real headers ----------
function png(w, h) { const b = Buffer.alloc(40); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; }
function mp4({ w = 1920, h = 1080, codec = 'avc1', audio = false } = {}) {
  const b = Buffer.alloc(400); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); b.write('moov', 40, 'latin1'); b.write('stsd', 60, 'latin1'); b.write(codec, 80, 'latin1');
  b.writeUInt16BE(w, 80 + 28); b.writeUInt16BE(h, 80 + 30); if (audio) b.write('mp4a', 200, 'latin1'); return b;
}
function vrm(json = '{"extensions":{"VRMC_vrm":{}}}') {
  const j = Buffer.from(json); const b = Buffer.alloc(20 + j.length); b.write('glTF', 0, 'latin1'); b.writeUInt32LE(2, 4); b.writeUInt32LE(b.length, 8); b.writeUInt32LE(j.length, 12); b.write('JSON', 16, 'latin1'); j.copy(b, 20); return b;
}
const FRAMING = { scale: 1.1, offsetX: 0, offsetY: 0 };
const roomFiles = () => ({ 'LICENSE.txt': 'licence', 'plate.png': png(1920, 1200), 'room.mp4': mp4() });
const roomSec = (o = {}) => ({ plate: 'plate.png', video: 'room.mp4', seconds: 8, framing: FRAMING, ...o });
const SOUL = JSON.stringify({ name: 'Mira', role: 'A calm helper', selfWord: 'em', userWord: 'anh', style: 'Short and warm', persona: 'Calm.', replyLang: 'auto', template: TEMPLATE_IDS[0] });

const GOOD = {
  voice: () => [base('voice', { platforms: ['win-x64'], voice: { engine: 'server', langs: ['vi'], command: 'run.exe', speechPath: '/v1/audio/speech' } }), { 'LICENSE.txt': 'l', 'run.exe': 'MZ' }],
  room: () => [base('room', { room: roomSec() }), roomFiles()],
  model: () => [base('model', { model: { vrm: 'model.vrm' } }), { 'LICENSE.txt': 'l', 'model.vrm': vrm() }],
  skill: () => [base('skill', { skill: { file: 'skill.md', summary: 'Plans a day' } }), { 'LICENSE.txt': 'l', 'skill.md': '# Plan a day' }],
  soul: () => [base('soul', { soul: { file: 'soul.json' } }), { 'LICENSE.txt': 'l', 'soul.json': SOUL }],
  plugin: () => [base('plugin', { plugin: { api: 1, ui: 'ui/index.html', tab: { label: { en: 'Sample' } }, permissions: { storage: true, links: { docs: 'https://zumia.space/' }, net: [] } } }), { 'LICENSE.txt': 'l', 'ui/index.html': '<!doctype html><script src="app.js"></script>', 'ui/app.js': 'void 0;' }],
  scene: () => [base('scene', { scene: { api: 1, glb: 'scene.glb', descriptor: 'scene.json', tiers: ['low', 'high'], budget: { triangles: 1500000, textureMaxPx: 2048 } } }), { 'LICENSE.txt': 'l', 'scene.glb': sceneGlb(), 'scene.json': sceneDescriptor() }],
  agent: () => [base('agent', { agent: { items: [{ id: 'voice.kokoro-82m', version: '1.2.1', sha256: 'a'.repeat(64) }], settings: { uiLang: 'vi' } } }), { 'LICENSE.txt': 'l' }],
};
ok(PACK_KINDS.join() === 'voice,room,model,skill,soul,plugin,agent,scene', 'eight types have a standard (scene added)', PACK_KINDS.join());
for (const kind of PACK_KINDS) {
  const [m, f] = GOOD[kind]();
  const v = await verdict(packZip(m, f), { kind, expectId: m.id });
  ok(v.ok && v.destLeft, `good ${kind} package passes`, JSON.stringify(v.errors));
}

// ---------- faults: [title, kind, mutate(manifest, files) -> extra options, expected code] ----------
const FAULTS = [
  ['common: wrong format', 'skill', (m) => { m.format = 'zip/1'; }, 'manifest_format'],
  ['common: unknown kind', 'skill', (m) => { m.kind = 'theme'; }, 'manifest_kind'],
  ['common: id of another kind', 'skill', (m) => { m.id = 'voice.sample'; }, 'manifest_id'],
  ['common: bad version', 'skill', (m) => { m.version = 'one'; }, 'manifest_version'],
  ['common: no name', 'skill', (m) => { delete m.name; }, 'manifest_name'],
  ['common: no author', 'skill', (m) => { delete m.author; }, 'manifest_author'],
  ['common: non-commercial licence', 'skill', (m) => { m.licence = { spdx: 'CC-BY-NC-4.0', file: 'LICENSE.txt' }; }, 'licence_spdx'],
  ['common: licence text missing', 'skill', (m) => { m.licence = { spdx: 'MIT', file: 'NOPE.txt' }; }, 'licence_file'],
  ['common: secret in a text file', 'skill', (m, f) => { f['skill.md'] = `key AIza${'x'.repeat(35)}`; }, 'secret_shape'],
  ['common: file type a kind may not hold', 'soul', (m, f) => { f['logo.png'] = 'x'; }, 'file_type'],
  ['common: code in a data package', 'room', (m, f) => { f['run.js'] = 'x'; }, 'file_type'],
  ['room: plate missing', 'room', (m, f) => { delete f['plate.png']; }, 'room_plate'],
  ['room: plate is not a PNG', 'room', (m, f) => { f['plate.png'] = 'notpng'; }, 'room_plate'],
  ['room: plate the wrong size', 'room', (m, f) => { f['plate.png'] = png(1024, 1024); }, 'room_plate_size'],
  ['room: video missing', 'room', (m, f) => { delete f['room.mp4']; }, 'room_video'],
  ['room: video not mp4', 'room', (m, f) => { f['room.mp4'] = 'nope'; }, 'room_video'],
  ['room: video not h264', 'room', (m, f) => { f['room.mp4'] = mp4({ codec: 'hvc1' }); }, 'room_video_codec'],
  ['room: video the wrong size', 'room', (m, f) => { f['room.mp4'] = mp4({ w: 1280, h: 720 }); }, 'room_video_size'],
  ['room: video has audio', 'room', (m, f) => { f['room.mp4'] = mp4({ audio: true }); }, 'room_video_audio'],
  ['room: loop length missing', 'room', (m) => { delete m.room.seconds; }, 'room_seconds'],
  ['room: framing out of range', 'room', (m) => { m.room.framing = { scale: 3, offsetX: 0, offsetY: 0 }; }, 'room_framing'],
  ['room: a 3D file is not a room', 'room', (m, f) => { f['room.glb'] = 'x'; }, 'file_type'],
  ['model: no vrm named', 'model', (m) => { m.model = {}; }, 'model_vrm'],
  ['model: not glTF', 'model', (m, f) => { f['model.vrm'] = Buffer.alloc(40); }, 'model_not_vrm'],
  ['model: glTF without VRM', 'model', (m, f) => { f['model.vrm'] = vrm('{"asset":{}}'); }, 'model_not_vrm'],
  ['skill: no file', 'skill', (m) => { m.skill.file = 'gone.md'; }, 'skill_file'],
  ['skill: no summary', 'skill', (m) => { delete m.skill.summary; }, 'skill_summary'],
  ['skill: too long', 'skill', (m, f) => { f['skill.md'] = 'x'.repeat(21 * 1024); }, 'skill_too_long'],
  ['voice: no section', 'voice', (m) => { delete m.voice; }, 'voice_section'],
  ['voice: unknown language', 'voice', (m) => { m.voice.langs = ['fr']; }, 'voice_langs'],
  ['voice: no platforms', 'voice', (m) => { delete m.platforms; }, 'voice_platforms'],
  ['voice: unknown engine', 'voice', (m) => { m.voice.engine = 'gpt'; }, 'voice_engine'],
  ['voice: server command absent', 'voice', (m) => { m.voice.command = 'gone.exe'; }, 'voice_missing_file'],
  ['voice: kokoro without its runtime', 'voice', (m) => { m.voice = { engine: 'kokoro', langs: ['en'] }; }, 'voice_missing_file'],
  ['soul: not JSON', 'soul', (m, f) => { f['soul.json'] = '{nope'; }, 'soul_json'],
  ['soul: sets the owner name', 'soul', (m, f) => { f['soul.json'] = JSON.stringify({ ...JSON.parse(SOUL), ownerName: 'Kei' }); }, 'soul_owner_name'],
  ['soul: field too long', 'soul', (m, f) => { f['soul.json'] = JSON.stringify({ ...JSON.parse(SOUL), name: 'x'.repeat(41) }); }, 'soul_invalid'],
  ['plugin: no ui page', 'plugin', (m) => { m.plugin.ui = 'ui/gone.html'; }, 'plugin_ui'],
  ['plugin: no tab label', 'plugin', (m) => { delete m.plugin.tab; }, 'plugin_tab'],
  ['plugin: a .mjs file (web app packs run no Node code)', 'plugin', (m, f) => { f['ui/host.mjs'] = 'export {};'; }, 'plugin_native'],
  ['plugin: a native file', 'plugin', (m, f) => { f['bin/helper.dll'] = 'MZ'; }, 'plugin_native'],
  ['plugin: a network origin (v1 has no network)', 'plugin', (m) => { m.plugin.permissions.net = ['https://x.com']; }, 'plugin_net'],
  ['plugin: an unknown permission', 'plugin', (m) => { m.plugin.permissions.settings = ['aiKey']; }, 'plugin_permission_unknown'],
  ['plugin: a link that is not https', 'plugin', (m) => { m.plugin.permissions.links = { docs: 'http://zumia.space/' }; }, 'plugin_link'],
  ['plugin: an avatar permission other than read', 'plugin', (m) => { m.plugin.permissions.avatar = 'write'; }, 'plugin_permission_unknown'],
  ['plugin: no api', 'plugin', (m) => { delete m.plugin.api; }, 'manifest_api'],
  ['api: a pack the host is too old for', 'plugin', (m) => { m.plugin.api = 2; }, 'pack_needs_newer_host'],
  ['api: a pack on a retired api', 'scene', (m) => { m.scene.api = 0; }, 'pack_api_retired'],
  ['scene: not a glb', 'scene', (m, f) => { f['scene.glb'] = 'nope'; }, 'scene_glb'],
  ['scene: an external URI', 'scene', (m, f) => { f['scene.glb'] = sceneGlb({ mutate: (j) => { j.images[0] = { uri: 'https://evil.example/t.png' }; } }); }, 'scene_uri'],
  ['scene: a data URI buffer', 'scene', (m, f) => { f['scene.glb'] = sceneGlb({ mutate: (j) => { j.buffers.push({ uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }); } }); }, 'scene_uri'],
  ['scene: a glTF extension off the allow-list', 'scene', (m, f) => { f['scene.glb'] = sceneGlb({ mutate: (j) => { j.extensionsUsed = ['EXT_script_runner']; } }); }, 'scene_extension'],
  ['scene: an oversize texture', 'scene', (m, f) => { f['scene.glb'] = sceneGlb({ texturePx: [4096, 4096] }); }, 'scene_texture_size'],
  ['scene: over its triangle budget', 'scene', (m, f) => { m.scene.budget.triangles = 10; f['scene.glb'] = sceneGlb({ triangles: 11 }); }, 'scene_triangles'],
  ['scene: a budget above the standard cap', 'scene', (m) => { m.scene.budget.triangles = 5000000; }, 'scene_budget'],
  ['scene: no zumi_stand anchor', 'scene', (m, f) => { f['scene.glb'] = sceneGlb({ nodes: ['room'] }); f['scene.json'] = sceneDescriptor({ anchors: {} }); }, 'scene_anchor'],
  ['scene: descriptor not JSON', 'scene', (m, f) => { f['scene.json'] = '{nope'; }, 'scene_descriptor'],
  ['scene: code in a scene', 'scene', (m, f) => { f['logic.js'] = 'x'; }, 'file_type'],
  ['agent: no items', 'agent', (m) => { m.agent.items = []; }, 'agent_items'],
  ['agent: item without a hash', 'agent', (m) => { delete m.agent.items[0].sha256; }, 'agent_items'],
  ['agent: nested agent pack', 'agent', (m) => { m.agent.items[0].id = 'agent.other'; }, 'agent_nested'],
  ['agent: a setting off the list', 'agent', (m) => { m.agent.settings = { aiKey: 'x' }; }, 'agent_settings'],
];
for (const [title, kind, mutate, code] of FAULTS) {
  const [m, f] = GOOD[kind]();
  mutate(m, f);
  const v = await verdict(packZip(m, f));
  const hit = v.errors.find((e) => e.code === code);
  ok(!v.ok && hit && hit.message.length > 10 && !v.destLeft, `refused, ${title}: [${code}] ${hit ? hit.message : ''}`, JSON.stringify(v.errors));
}

// ---------- the listing itself ----------
{
  const [m, f] = GOOD.skill();
  const good = JSON.parse(zipEntryJson(packZip(m, f)));
  const entries = () => [{ name: 'LICENSE.txt', data: Buffer.from('l') }, { name: 'skill.md', data: Buffer.from('# Plan a day') }];
  const withManifest = (mm, extra = []) => zipBuffer([{ name: 'zumi-pack.json', data: Buffer.from(JSON.stringify(mm)) }, ...entries(), ...extra]);
  let v = await verdict(withManifest(good, [{ name: 'extra.md', data: Buffer.from('x') }]));
  ok(v.errors.some((e) => e.code === 'files_unlisted'), 'a file not in files is refused', JSON.stringify(v.errors));
  v = await verdict(withManifest({ ...good, files: good.files.map((x) => (x.path === 'skill.md' ? { ...x, sha256: 'b'.repeat(64) } : x)) }));
  ok(v.errors.some((e) => e.code === 'files_sha'), 'a file that fails its sha256 is refused', JSON.stringify(v.errors));
  v = await verdict(withManifest({ ...good, files: good.files.map((x) => (x.path === 'skill.md' ? { ...x, bytes: 1 } : x)) }));
  ok(v.errors.some((e) => e.code === 'files_bytes'), 'a wrong byte count is refused', JSON.stringify(v.errors));
  v = await verdict(withManifest({ ...good, files: [...good.files, { path: 'gone.md', sha256: 'c'.repeat(64), bytes: 1 }] }));
  ok(v.errors.some((e) => e.code === 'files_absent'), 'a listed file that is absent is refused', JSON.stringify(v.errors));
  v = await verdict(zipBuffer(entries()));
  ok(v.errors.some((e) => e.code === 'manifest_missing'), 'no manifest is refused', JSON.stringify(v.errors));
  v = await verdict(zipBuffer([{ name: 'zumi-pack.json', data: Buffer.from('{oops') }, ...entries()]));
  ok(v.errors.some((e) => e.code === 'manifest_json'), 'a broken manifest is refused', JSON.stringify(v.errors));
  v = await verdict(packZip(m, f), { expectId: 'skill.other' });
  ok(v.errors.some((e) => e.code === 'manifest_id'), 'a package that is not the item asked for is refused', JSON.stringify(v.errors));
}
function zipEntryJson(buf) { return manifestOf(buf); }

// ---------- zip attacks ----------
const ATTACKS = [
  ['a path that leaves the folder', [{ name: '../evil.txt', data: Buffer.from('x') }], 'zip_unsafe_path'],
  ['a nested climb', [{ name: 'a/../../evil.txt', data: Buffer.from('x') }], 'zip_unsafe_path'],
  ['an absolute path', [{ name: '/evil.txt', data: Buffer.from('x') }], 'zip_unsafe_path'],
  ['a drive path', [{ name: 'C:/evil.txt', data: Buffer.from('x') }], 'zip_unsafe_path'],
  ['a backslash path', [{ name: '..\\evil.txt', data: Buffer.from('x') }], 'zip_unsafe_path'],
  ['a reserved Windows name', [{ name: 'CON.txt', data: Buffer.from('x') }], 'zip_unsafe_path'],
  ['a unix symlink', [{ name: 'link', data: Buffer.from('/etc/passwd'), madeBy: 3, attrs: 0o120777 * 65536 }], 'zip_symlink'],
  ['two names that differ by case', [{ name: 'a.txt', data: Buffer.from('x') }, { name: 'A.txt', data: Buffer.from('y') }], 'zip_duplicate'],
  ['a file bigger than it declares', [{ name: 'a.txt', data: Buffer.alloc(100000), rawSize: 10 }], 'zip_size_lie'],
];
for (const [title, entries, code] of ATTACKS) {
  const v = await verdict(zipBuffer(entries), { kind: 'skill' });
  ok(!v.ok && v.errors[0].code === code && !v.destLeft, `refused: ${title} [${code}]`, JSON.stringify(v.errors));
}
{
  const v = await verdict(zipBuffer([{ name: 'bomb.txt', data: Buffer.alloc(2 * 1024 * 1024) }]), { kind: 'skill' });
  ok(!v.ok && v.errors[0].code === 'pack_too_large', 'a package over its kind limit is refused before anything is written', JSON.stringify(v.errors));
  ok((await verdict(Buffer.from('not a zip at all, and longer than the end record is'))).errors[0].code === 'zip_invalid', 'not a zip is refused');
  const enc = zipBuffer([{ name: 'a.txt', data: Buffer.from('x') }]); enc.writeUInt16LE(0x0801, enc.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 8);
  ok((await verdict(enc)).errors[0].code === 'zip_encrypted', 'an encrypted package is refused');
}

// ---------- upload rule: same validator, stricter publisher ----------
for (const kind of ['voice', 'plugin']) {
  const [m, f] = GOOD[kind]();
  const v = await verdict(packZip(m, f), { publisher: 'user' });
  ok(v.errors.some((e) => e.code === 'code_publisher'), `a user's ${kind} package is refused: it runs code`, JSON.stringify(v.errors));
}
for (const kind of ['room', 'model', 'skill', 'soul', 'agent', 'scene']) {
  const [m, f] = GOOD[kind]();
  ok((await verdict(packZip(m, f), { publisher: 'user' })).ok, `a user's ${kind} package passes the same validator`);
}

// ---------- the room standard is measured, not invented ----------
const rooms = JSON.parse(fs.readFileSync(path.join(repo, 'assets', 'rooms-video', 'rooms.json'), 'utf8'));
ok(rooms.plateSize.join() === ROOM_PLATE_SIZE.join() && rooms.videoSize.join() === ROOM_VIDEO_SIZE.join(), 'room plate and video sizes equal the shipped manifest', `${rooms.plateSize} ${rooms.videoSize}`);
ok(Math.max(...rooms.rooms.map((r) => r.bytes)) < STANDARD.room.maxBytes, 'the largest shipped room video fits the room limit');
ok(Math.max(...rooms.rooms.map((r) => r.seconds)) <= 60, 'every shipped room fits the loop limit');
ok(!STANDARD.room.ext.includes('.glb'), 'a room package has no 3D type (a painted room may carry only the occluder glb its room.json names)');
const plate = path.join(repo, 'resources-pinned', 'room-v2', 'B-talk-plate.png');

// ---------- slim installer (T-31-ROOM-slim): the two shapes the built-in rooms ship as ----------
// "over": a looping video drawn over the default room's talk plate (the seven built-in video rooms). No plate of its own.
const overRoom = (o = {}, files = {}) => [base('room', { id: 'room.beach-cabin', room: { over: 'default-v2', video: 'room.mp4', seconds: 8, framing: FRAMING, ...o } }), { 'LICENSE.txt': 'l', 'room.mp4': mp4(), ...files }];
{ const [m, f] = overRoom(); const v = await verdict(packZip(m, f)); ok(v.ok, 'room over default-v2: a video with no plate passes', JSON.stringify(v.errors)); }
{ const [m, f] = overRoom({ over: 'night' }); const v = await verdict(packZip(m, f)); ok(v.errors.some((e) => e.code === 'room_over'), 'room over: only default-v2 can be drawn over', JSON.stringify(v.errors)); }
{ const [m, f] = overRoom({}, { 'x.glb': 'glTF' }); const v = await verdict(packZip(m, f)); ok(v.errors.some((e) => e.code === 'file_type'), 'room over: a glb is still refused', JSON.stringify(v.errors)); }
// "layout": the painted default room itself (room.json v2 + its plates + the occluder glb it names), checked by room-check.mjs.
const pinnedRoom = path.join(repo, 'resources-pinned', 'room-v2');
const paintedFiles = () => {
  const j = JSON.parse(fs.readFileSync(path.join(pinnedRoom, 'room.json'), 'utf8'));
  const f = { 'LICENSE.txt': 'l', 'room.json': fs.readFileSync(path.join(pinnedRoom, 'room.json')), [j.model]: fs.readFileSync(path.join(pinnedRoom, j.model)) };
  for (const v of Object.values(j.views)) f[v.plate] = fs.readFileSync(path.join(pinnedRoom, v.plate));
  return [j, f];
};
if (fs.existsSync(path.join(pinnedRoom, 'room.json')) && fs.existsSync(plate)) {
  const painted = (o = {}) => base('room', { id: 'room.night-city', room: { layout: 'room.json', ...o } });
  { const [, f] = paintedFiles(); const v = await verdict(packZip(painted(), f)); ok(v.ok, 'room layout: the real Night City room (room.json v2, plates, occluders) passes', JSON.stringify(v.errors)); }
  { const [j, f] = paintedFiles(); f['extra.glb'] = f[j.model]; const v = await verdict(packZip(painted(), f)); ok(v.errors.some((e) => e.code === 'file_type'), 'room layout: a glb the room.json does not name is refused', JSON.stringify(v.errors)); }
  { const [, f] = paintedFiles(); f['room.json'] = '{"schemaVersion":2}'; const v = await verdict(packZip(painted(), f)); ok(v.errors.some((e) => e.code === 'room_layout'), 'room layout: a room.json the room checker refuses is refused', JSON.stringify(v.errors)); }
  { const [, f] = paintedFiles(); f['room.mp4'] = mp4(); const v = await verdict(packZip(painted({ video: 'room.mp4' }), f)); ok(v.errors.some((e) => e.code === 'room_form'), 'room: layout and video together are refused (one shape per pack)', JSON.stringify(v.errors)); }
  { const [j, f] = paintedFiles(); delete f[j.views.talk.plate]; const v = await verdict(packZip(painted(), f)); ok(v.errors.some((e) => e.code === 'room_layout'), 'room layout: a plate room.json names must be in the pack', JSON.stringify(v.errors)); }
} else console.log('INFO no pinned room-v2 on this PC: the painted-room rows did not run');
if (fs.existsSync(plate)) { const b = fs.readFileSync(plate).subarray(0, 32); ok(b.readUInt32BE(16) === 1920 && b.readUInt32BE(20) === 1200, 'the real plate is the standard size'); }
// Rooms and the model are not in git. ZUMI_REAL_ROOM_VIDEO and ZUMI_REAL_MODEL point at shipped files for the two real-file rows.
const realVideo = process.env.ZUMI_REAL_ROOM_VIDEO;
if (realVideo && fs.existsSync(realVideo)) {
  const [m, f] = GOOD.room(); f['room.mp4'] = fs.readFileSync(realVideo); if (fs.existsSync(plate)) f['plate.png'] = fs.readFileSync(plate);
  const v = await verdict(packZip(m, f), { kind: 'room' });
  ok(v.ok, 'a real shipped room (plate + video) passes the room standard', JSON.stringify(v.errors));
} else console.log('INFO no shipped room video on this PC: the real-room row did not run');
const vrmReal = path.join(repo, 'assets', 'models', 'zumi-default-0910.vrm');
const vrmEnv = process.env.ZUMI_REAL_MODEL;
const vrmFile = fs.existsSync(vrmReal) ? vrmReal : (vrmEnv && fs.existsSync(vrmEnv) ? vrmEnv : null);
if (vrmFile) {
  const [m, f] = GOOD.model(); f['model.vrm'] = fs.readFileSync(vrmFile);
  const v = await verdict(packZip(m, f), { kind: 'model' });
  ok(v.ok, 'the real default model passes the model standard', JSON.stringify(v.errors));
} else console.log('INFO no default model on this PC: the real-model row did not run');

// ---------- canaries: the open fixtures the runtime is tested with ----------
{
  const zip = path.join(tmp, 'plugin.canary.zip');
  fs.writeFileSync(zip, packDirZip(path.join(repo, 'scripts', 'fixtures', 'market', 'plugin.canary')));
  const v = await validatePackZip(zip, path.join(tmp, 'plugin.canary'), { kind: 'plugin', expectId: 'plugin.canary' });
  ok(v.ok, 'plugin.canary (built from scripts/fixtures/market) passes the plugin standard', JSON.stringify(v.errors));
  const [m, f] = GOOD.scene(); m.id = 'scene.canary';
  const s = await verdict(packZip(m, f), { kind: 'scene', expectId: 'scene.canary' });
  ok(s.ok, 'scene.canary passes the scene standard', JSON.stringify(s.errors));
  ok(STANDARD.scene.maxBytes === 64 * 1024 * 1024 && !STANDARD.scene.code, 'a scene is data only, up to 64 MB');
  ok(Object.keys(HOST_API).sort().join() === [...PACK_KINDS].sort().join(), 'the host api table names every kind', Object.keys(HOST_API).join());
}

// ---------- the signed store index ----------
{
  const store = generateKeyPair(), spare = generateKeyPair(), stranger = generateKeyPair();
  const keys = [parsePublicKey(publicKeyText(store)), parsePublicKey(publicKeyText(spare))];
  const [pm, pf] = GOOD.plugin();
  const zipBuf = packZip(pm, pf);
  const zipFile = path.join(tmp, 'plugin.sample-1.0.0.zip'); fs.writeFileSync(zipFile, zipBuf);
  const ver = (version, api, extra = {}) => ({ version, api, url: `plugin.sample-${version}.zip`, sha256: sha256(zipBuf), bytes: zipBuf.length, manifestSha256: 'a'.repeat(64), ...extra });
  const index = (serial, withdrawn = []) => ({ format: 'zumi-market/1', serial, published: '2026-11-11T00:00:00Z', packs: [{ id: 'plugin.sample', kind: 'plugin', name: { en: 'Sample' }, versions: [ver('1.2.0', 2), ver('1.1.0', 1), ver('1.0.0', 1)], withdrawn }] });
  const signed = (obj, pair = store) => { const bytes = Buffer.from(JSON.stringify(obj)); return { bytes, sig: signMinisign(bytes, pair) }; };
  const s = signed(index(5));
  let v = verifyIndex(s.bytes, s.sig, { publicKeys: keys, cachedSerial: 4 });
  ok(v.ok && v.index.serial === 5, 'a signed index with a higher serial is accepted', JSON.stringify(v));
  v = verifyIndex(s.bytes, s.sig, { publicKeys: keys, cachedSerial: 5 });
  ok(v.ok, 'the same index fetched again (equal serial) is accepted', JSON.stringify(v));
  const sp = signed(index(6), spare);
  ok(verifyIndex(sp.bytes, sp.sig, { publicKeys: keys, cachedSerial: 5 }).ok, 'an index signed by the offline spare key is accepted');
  const tampered = Buffer.from(s.bytes.toString().replace('"serial":5', '"serial":9'));
  v = verifyIndex(tampered, s.sig, { publicKeys: keys, cachedSerial: 0 });
  ok(!v.ok && v.code === 'index_signature', 'refused: an index with a bad signature (edited after signing)', JSON.stringify(v));
  const st = signed(index(7), stranger);
  v = verifyIndex(st.bytes, st.sig, { publicKeys: keys, cachedSerial: 0 });
  ok(!v.ok && v.code === 'index_signature', 'refused: an index signed by a key the app does not hold', JSON.stringify(v));
  v = verifyIndex(s.bytes, s.sig, { publicKeys: keys, cachedSerial: 6 });
  ok(!v.ok && v.code === 'index_serial', 'refused: an index with a lower serial (an old index replayed)', JSON.stringify(v));
  const bad = signed({ format: 'zumi-market/2', serial: 9, packs: [] });
  v = verifyIndex(bad.bytes, bad.sig, { publicKeys: keys, cachedSerial: 0 });
  ok(!v.ok && v.code === 'index_format', 'refused: a signed index of an unknown format', JSON.stringify(v));
  const ix = index(5);
  let pick = pickVersion(ix.packs[0], HOST_API);
  ok(pick.ok && pick.version.version === '1.1.0', 'version pick: the newest version whose api the host supports (1.2.0 needs api 2)', JSON.stringify(pick));
  const wd = index(8, ['1.1.0']);
  pick = pickVersion(wd.packs[0], HOST_API);
  ok(pick.ok && pick.version.version === '1.0.0', 'version pick skips a withdrawn version', JSON.stringify(pick));
  pick = pickVersion({ ...ix.packs[0], versions: [ver('2.0.0', 2)] }, HOST_API);
  ok(!pick.ok && pick.code === 'pack_needs_newer_host', 'refused: a pack whose every version needs a newer host', JSON.stringify(pick));
  let d = await checkDownload(zipFile, ver('1.0.0', 1));
  ok(d.ok, 'a zip that matches its index entry is accepted', JSON.stringify(d));
  const other = path.join(tmp, 'other.zip'); const ob = Buffer.from(zipBuf); ob[ob.length - 30] ^= 1; fs.writeFileSync(other, ob);
  d = await checkDownload(other, ver('1.0.0', 1));
  ok(!d.ok && d.code === 'zip_sha', 'refused: a zip whose hash differs from the index', JSON.stringify(d));
  d = await checkDownload(zipFile, ver('1.0.0', 1, { bytes: zipBuf.length + 1 }));
  ok(!d.ok && d.code === 'zip_bytes', 'refused: a zip whose size differs from the index', JSON.stringify(d));
  let l = loadVerdict(wd, { id: 'plugin.sample', version: '1.1.0', manifestSha256: 'a'.repeat(64) }, HOST_API);
  ok(!l.ok && l.code === 'pack_withdrawn', 'refused at load: a withdrawn version', JSON.stringify(l));
  l = loadVerdict(ix, { id: 'plugin.sample', version: '1.1.0', manifestSha256: 'a'.repeat(64) }, HOST_API);
  ok(l.ok, 'load: a listed, not withdrawn version with its manifest hash', JSON.stringify(l));
  l = loadVerdict(ix, { id: 'plugin.sample', version: '1.1.0', manifestSha256: 'b'.repeat(64) }, HOST_API);
  ok(!l.ok && l.code === 'manifest_mismatch', 'refused at load: an installed manifest that is not the listed one', JSON.stringify(l));
  l = loadVerdict(ix, { id: 'plugin.gone', version: '1.0.0', manifestSha256: 'a'.repeat(64) }, HOST_API);
  ok(!l.ok && l.code === 'pack_not_listed', 'refused at load: a pack gone from the index', JSON.stringify(l));
  l = loadVerdict(ix, { id: 'plugin.sample', version: '1.2.0', manifestSha256: 'a'.repeat(64) }, HOST_API);
  ok(!l.ok && l.code === 'pack_needs_newer_host', 'refused at load: a listed version whose api the host lacks', JSON.stringify(l));
}

// ---------- store CLI publish --serial-min: a fresh public store starts above an older index signed by the same key ----------
{
  const { spawnSync } = await import('node:child_process');
  const pair = generateKeyPair();
  const keyFile = path.join(tmp, 'cli-test.key');
  fs.writeFileSync(keyFile, JSON.stringify({ format: 'zumi-market-key/1', role: 'store', keyId: keyIdOf(pair), keyNum: pair.keyNum.toString('hex'), privatePem: pair.privatePem }));
  const [pm, pf] = GOOD.plugin();
  const zipFile = path.join(tmp, 'cli-plugin.sample-1.0.0.zip'); fs.writeFileSync(zipFile, packZip(pm, pf));
  const publish = (store, ...extra) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'market-store-cli.mjs'), 'publish', '--store', store, '--key', keyFile, ...extra, zipFile], { encoding: 'utf8' });
  const readIndex = (store) => { try { return verifyIndex(fs.readFileSync(path.join(store, 'index.json')), fs.readFileSync(path.join(store, 'index.json.minisig'), 'utf8'), { publicKeys: [parsePublicKey(publicKeyText(pair))] }); } catch (e) { return { ok: false, code: String(e.message) }; } };
  let r = publish(path.join(tmp, 'cli-store-plain'));
  let v = readIndex(path.join(tmp, 'cli-store-plain'));
  ok(r.status === 0 && v.ok && v.index.serial === 1, 'store CLI: the first publish into an empty store is serial 1', `${r.stderr}${JSON.stringify(v)}`);
  r = publish(path.join(tmp, 'cli-store-min'), '--serial-min', '10');
  v = readIndex(path.join(tmp, 'cli-store-min'));
  ok(r.status === 0 && v.ok && v.index.serial === 10 && /serial 10\b/.test(r.stdout), 'store CLI: publish --serial-min 10 into an empty store signs serial 10', `${r.stderr}${JSON.stringify(v)}`);
  for (const bad of ['0', '-3', '1.5', 'ten']) {
    r = publish(path.join(tmp, `cli-store-bad-${bad}`), '--serial-min', bad);
    ok(r.status !== 0 && !fs.existsSync(path.join(tmp, `cli-store-bad-${bad}`, 'index.json')), `store CLI: --serial-min ${bad} is refused before anything is written`, r.stderr);
  }
}

// ---------- the docs cover every type ----------
const doc = fs.readFileSync(path.join(repo, 'docs', 'marketplace', 'package-standards.md'), 'utf8');
for (const kind of PACK_KINDS) ok(new RegExp(`^## ${kind}\\b`, 'mi').test(doc), `docs have a section for ${kind}`);
void sha256;

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`check:market-pack: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

function manifestOf(buf) {
  // Test helper: walks the local headers to the manifest. The entries are sorted, so it comes after LICENSE and before the rest.
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18), nameLen = buf.readUInt16LE(at + 26), extra = buf.readUInt16LE(at + 28);
    const start = at + 30 + nameLen + extra;
    if (buf.toString('utf8', at + 30, at + 30 + nameLen) === 'zumi-pack.json') return zlibMod.inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
    at = start + size;
  }
  throw new Error('no manifest');
}
