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
  plugin: () => [base('plugin', { plugin: { entry: 'plugin.mjs', permissions: { net: ['https://example.com'], settings: ['uiLang'], hud: false } } }), { 'LICENSE.txt': 'l', 'plugin.mjs': 'export {};' }],
  agent: () => [base('agent', { agent: { items: [{ id: 'voice.kokoro-82m', version: '1.2.1', sha256: 'a'.repeat(64) }], settings: { uiLang: 'vi' } } }), { 'LICENSE.txt': 'l' }],
};
ok(PACK_KINDS.join() === 'voice,room,model,skill,soul,plugin,agent', 'seven types have a standard', PACK_KINDS.join());
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
  ['plugin: no entry', 'plugin', (m) => { m.plugin.entry = 'gone.mjs'; }, 'plugin_entry'],
  ['plugin: http origin', 'plugin', (m) => { m.plugin.permissions.net = ['http://x.com']; }, 'plugin_permissions'],
  ['plugin: a setting off the list', 'plugin', (m) => { m.plugin.permissions.settings = ['aiKey']; }, 'plugin_permissions'],
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
for (const kind of ['room', 'model', 'skill', 'soul', 'agent']) {
  const [m, f] = GOOD[kind]();
  ok((await verdict(packZip(m, f), { publisher: 'user' })).ok, `a user's ${kind} package passes the same validator`);
}

// ---------- the room standard is measured, not invented ----------
const rooms = JSON.parse(fs.readFileSync(path.join(repo, 'assets', 'rooms-video', 'rooms.json'), 'utf8'));
ok(rooms.plateSize.join() === ROOM_PLATE_SIZE.join() && rooms.videoSize.join() === ROOM_VIDEO_SIZE.join(), 'room plate and video sizes equal the shipped manifest', `${rooms.plateSize} ${rooms.videoSize}`);
ok(Math.max(...rooms.rooms.map((r) => r.bytes)) < STANDARD.room.maxBytes, 'the largest shipped room video fits the room limit');
ok(Math.max(...rooms.rooms.map((r) => r.seconds)) <= 60, 'every shipped room fits the loop limit');
ok(!STANDARD.room.ext.includes('.glb'), 'a room package has no 3D type');
const plate = path.join(repo, 'resources-pinned', 'room-v2', 'B-talk-plate.png');
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
