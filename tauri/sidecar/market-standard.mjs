// The Marketplace package standard: one manifest shape, one set of rules per item type. docs/marketplace/package-standards.md
// is the same content for package authors. Owner 02-11.
// The app runs this on every download, and scripts/market-validate.mjs runs it on a zip by hand; a later upload path calls the
// same validatePackZip. Messages are for package authors: each names the file and the rule, English only.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ALLOW_KEYS } from './profile-import.mjs';
import { extractZip, refuse, unsafePathReason } from './market-zip.mjs';
import { API_REQUIRED, HOST_API, apiVerdict } from './market-store.mjs';
import { checkRoomJsonFile } from '../../src/main/room-check.mjs';

const require = createRequire(import.meta.url);
const { validateSoul } = require('../../src/main/soul-prefs.js');

export const PACK_FORMAT = 'zumi-pack/1';
export const MANIFEST_FILE = 'zumi-pack.json';
const MB = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{1,48}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[0-9a-f]{64}$/;
export const SPDX_ALLOWED = Object.freeze(['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC0-1.0', 'CC-BY-4.0', 'LicenseRef-Zumia']);
const LICENCE_EXT = ['.txt', '.md'];
const TEXT_EXT = new Set(['.txt', '.md', '.json']);
// The shapes of real keys, not "long and random": a package is full of sha256 hashes.
const KEY_SHAPES = [/\bsk-[A-Za-z0-9_-]{16,}/, /\bAIza[0-9A-Za-z_-]{30,}/, /\bgsk_[A-Za-z0-9]{16,}/, /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, /\bBearer\s+[A-Za-z0-9._-]{16,}/, /\bAKIA[0-9A-Z]{16}\b/, /\b(?:xai|ghp|gho|ghs|github_pat|hf)_[A-Za-z0-9_-]{16,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const looksLikeKey = (text) => KEY_SHAPES.some((re) => re.test(text));
const CODE_EXT = ['.js', '.mjs', '.cjs', '.node', '.dll', '.exe', '.pyd', '.py'];

// Room values measured from the shipped rooms (assets/rooms-video/rooms.json + ffprobe on all eight videos): plate 1920x1200,
// video 1920x1080 h264 at 24 fps, no audio, 1.5-10.4 MB. check:market-pack fails if the manifest's plate or video size moves.
export const ROOM_PLATE_SIZE = Object.freeze([1920, 1200]);
export const ROOM_VIDEO_SIZE = Object.freeze([1920, 1080]);

/**
 * Per type: `maxBytes` caps the unpacked package. `ext` lists every extension it may hold. `code` marks a type that runs code,
 * which only Zumia may publish. `check(manifest, ctx)` reports what is specific to the type.
 */
export const STANDARD = Object.freeze({
  voice: { maxBytes: 1500 * MB, code: true, ext: ['.json', '.txt', '.md', '.bin', '.onnx', '.wav', '.js', '.mjs', '.cjs', '.node', '.dll', '.exe', '.pyd', '.py', '.pth', '.zip', '.map', '.wasm', '.d.ts', '.ts', ''], check: checkVoice },
  room: { maxBytes: 25 * MB, code: false, ext: ['.json', '.txt', '.md', '.png', '.mp4'], check: checkRoom },
  model: { maxBytes: 50 * MB, code: false, ext: ['.json', '.txt', '.md', '.png', '.vrm'], check: checkModel },
  skill: { maxBytes: 1 * MB, code: false, ext: ['.json', '.txt', '.md'], check: checkSkill },
  soul: { maxBytes: 64 * 1024, code: false, ext: ['.json', '.txt', '.md'], check: checkSoul },
  // A web-app pack: static files in its own locked webview (ADR 2026-11-11-pack-system). No Node code, no native file.
  plugin: { maxBytes: 50 * MB, code: true, ext: ['.json', '.txt', '.md', '.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.woff2', '.glb', '.gltf', '.bin', '.ktx2', '.hdr', '.mjs', '.cjs', '.node', '.dll', '.exe', '.pyd', '.py', '.wasm'], check: checkPlugin },
  agent: { maxBytes: 64 * 1024, code: false, ext: ['.json', '.txt', '.md'], check: checkAgent },
  // A lit 3D room the host renders: one glb + a descriptor of value tables. Nothing in it executes.
  scene: { maxBytes: 64 * MB, code: false, ext: ['.json', '.txt', '.md', '.glb', '.jpg', '.png'], check: checkScene },
});
export const PACK_KINDS = Object.freeze(Object.keys(STANDARD));

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isPair = (v, a, b) => Array.isArray(v) && v[0] === a && v[1] === b;
const num = (v) => typeof v === 'number' && Number.isFinite(v);

function walk(dir, base = '') {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (d.isSymbolicLink()) throw refuse('pack_symlink', `link in package: ${rel}`);
    if (d.isDirectory()) out.push(...walk(path.join(dir, d.name), rel));
    else if (d.isFile()) out.push(rel);
    else throw refuse('pack_symlink', `not a regular file: ${rel}`);
  }
  return out;
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

const extOf = (rel) => (rel.endsWith('.d.ts') ? '.d.ts' : path.extname(rel).toLowerCase());

// ---------- type rules. ctx: { dir, has(rel), bytes(rel), bad(code, message) } ----------

function checkVoice(m, ctx) {
  const v = m.voice;
  if (!isObj(v)) return ctx.bad('voice_section', 'voice: the manifest needs a "voice" section');
  if (!Array.isArray(v.langs) || !v.langs.length || !v.langs.every((l) => l === 'en' || l === 'vi')) ctx.bad('voice_langs', 'voice.langs must list "en" and/or "vi"');
  if (!Array.isArray(m.platforms) || !m.platforms.length) ctx.bad('voice_platforms', 'voice: "platforms" must list where it runs, e.g. "win-x64"');
  if (v.engine === 'kokoro') {
    for (const need of ['voice-modules/node_modules/kokoro-js/dist/kokoro.js', 'voice-modules/node_modules/@huggingface/transformers/dist/transformers.node.mjs']) {
      if (!ctx.has(need)) ctx.bad('voice_missing_file', `voice: engine "kokoro" needs ${need}`);
    }
    if (!ctx.list.some((f) => /onnxruntime_binding\.node$/.test(f))) ctx.bad('voice_missing_file', 'voice: engine "kokoro" needs the onnxruntime binding for its platform');
  } else if (v.engine === 'server') {
    if (typeof v.command !== 'string' || !ctx.has(v.command)) ctx.bad('voice_missing_file', 'voice: engine "server" needs "command", a file in the package');
    if (typeof v.speechPath !== 'string' || !v.speechPath.startsWith('/')) ctx.bad('voice_server', 'voice: engine "server" needs "speechPath", the local route that answers speech');
  } else {
    ctx.bad('voice_engine', 'voice.engine must be "kokoro" or "server"');
  }
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// Walks the mp4 boxes: h264 sample entry (avc1) with its coded size, and no audio sample entry. Enough to refuse the wrong file.
function mp4Facts(buf) {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;
  const avc = buf.indexOf('avc1', 12, 'latin1');
  const stsd = buf.indexOf('stsd', 12, 'latin1');
  const facts = { h264: false, size: null, audio: buf.indexOf('mp4a', 12, 'latin1') >= 0 };
  let at = avc;
  while (at >= 0 && (stsd < 0 || at < stsd)) at = buf.indexOf('avc1', at + 4, 'latin1');
  if (at >= 0 && at + 32 < buf.length) { facts.h264 = true; facts.size = [buf.readUInt16BE(at + 28), buf.readUInt16BE(at + 30)]; }
  return facts;
}

// A room ships in one of three shapes (T-31-ROOM-slim): its own plate + looping video; a looping video drawn `over` the default
// room's talk plate (the built-in video rooms: the host keeps their framing pins in assets/rooms-video/rooms.json); or the painted
// default room itself, a room.json v2 `layout` with its plates and the one occluder glb it names (checked by room-check.mjs).
export const ROOM_OVER = Object.freeze(['default-v2']);

function checkRoomVideo(r, ctx) {
  if (typeof r.video !== 'string' || !/\.mp4$/i.test(r.video) || !ctx.has(r.video)) return ctx.bad('room_video', 'room.video must name the looping video, an .mp4 in the package');
  const facts = mp4Facts(ctx.read(r.video));
  if (!facts) return ctx.bad('room_video', `${r.video} is not an mp4`);
  if (!facts.h264) ctx.bad('room_video_codec', `${r.video} is not h264`);
  else if (!isPair(facts.size, ...ROOM_VIDEO_SIZE)) ctx.bad('room_video_size', `${r.video} is ${facts.size.join('x')}; a room video is ${ROOM_VIDEO_SIZE.join('x')}`);
  if (facts.audio) ctx.bad('room_video_audio', `${r.video} has an audio track; a room video has none`);
}

function checkRoomLayout(r, ctx) {
  if (r.video !== undefined || r.plate !== undefined || r.over !== undefined) return ctx.bad('room_form', 'room: a layout room has no video, plate or over (one shape per pack)');
  if (typeof r.layout !== 'string' || !/\.json$/i.test(r.layout) || !ctx.has(r.layout)) return ctx.bad('room_layout', 'room.layout must name the room.json v2 in the package');
  const verdict = checkRoomJsonFile(ctx.abs(r.layout));
  if (!verdict.ok) return ctx.bad('room_layout', `${r.layout}: refused by the room checker (${(verdict.refused && verdict.refused.code) || 'invalid'})`);
  const json = JSON.parse(ctx.read(r.layout).toString('utf8'));
  const dir = r.layout.includes('/') ? `${r.layout.slice(0, r.layout.lastIndexOf('/') + 1)}` : '';
  for (const v of Object.values(json.views || {})) {
    if (v && typeof v.plate === 'string' && !ctx.has(dir + v.plate)) ctx.bad('room_layout', `${r.layout} names the plate ${v.plate}, which is not in the package`);
  }
  if (typeof json.model === 'string' && !ctx.has(dir + json.model)) ctx.bad('room_layout', `${r.layout} names the occluders ${json.model}, which are not in the package`);
}

function checkRoom(m, ctx) {
  const r = m.room;
  if (!isObj(r)) return ctx.bad('room_section', 'room: the manifest needs a "room" section');
  if (r.layout !== undefined) return checkRoomLayout(r, ctx);
  if (r.over !== undefined) {
    if (!ROOM_OVER.includes(r.over)) ctx.bad('room_over', `room.over must be one of ${ROOM_OVER.join(', ')}`);
  } else if (typeof r.plate !== 'string' || !/\.png$/i.test(r.plate) || !ctx.has(r.plate)) ctx.bad('room_plate', 'room.plate must name the background plate, a .png in the package');
  else {
    const size = pngSize(ctx.head(r.plate, 32));
    if (!size) ctx.bad('room_plate', `${r.plate} is not a PNG`);
    else if (!isPair(size, ...ROOM_PLATE_SIZE)) ctx.bad('room_plate_size', `${r.plate} is ${size.join('x')}; a room plate is ${ROOM_PLATE_SIZE.join('x')}`);
  }
  checkRoomVideo(r, ctx);
  if (!num(r.seconds) || r.seconds <= 0 || r.seconds > 60) ctx.bad('room_seconds', 'room.seconds must be the loop length, up to 60');
  const f = r.framing;
  if (!isObj(f) || !num(f.scale) || f.scale < 1 || f.scale > 2 || !num(f.offsetX) || !num(f.offsetY)) ctx.bad('room_framing', 'room.framing must be { scale 1..2, offsetX, offsetY }');
}

function checkModel(m, ctx) {
  const v = m.model;
  if (!isObj(v) || typeof v.vrm !== 'string' || !/\.vrm$/i.test(v.vrm) || !ctx.has(v.vrm)) return ctx.bad('model_vrm', 'model.vrm must name a .vrm file in the package');
  const head = ctx.head(v.vrm, 20);
  if (head.length < 20 || head.toString('latin1', 0, 4) !== 'glTF' || head.readUInt32LE(4) !== 2) return ctx.bad('model_not_vrm', `${v.vrm} is not a binary glTF 2 file`);
  const jsonLen = head.readUInt32LE(12);
  const json = ctx.read(v.vrm).toString('utf8', 20, 20 + jsonLen);
  if (!/"(VRM|VRMC_vrm)"/.test(json)) ctx.bad('model_not_vrm', `${v.vrm} holds no VRM extension`);
}

function checkSkill(m, ctx) {
  const s = m.skill;
  if (!isObj(s) || typeof s.file !== 'string' || !/\.md$/i.test(s.file) || !ctx.has(s.file)) return ctx.bad('skill_file', 'skill.file must name a .md file in the package');
  if (typeof s.summary !== 'string' || !s.summary.trim() || s.summary.length > 200) ctx.bad('skill_summary', 'skill.summary must say what it does, up to 200 characters');
  if (ctx.bytes(s.file) > 20 * 1024) ctx.bad('skill_too_long', `${s.file} is over 20 KB`);
}

function checkSoul(m, ctx) {
  const s = m.soul;
  if (!isObj(s) || typeof s.file !== 'string' || !ctx.has(s.file)) return ctx.bad('soul_file', 'soul.file must name a .json file in the package');
  let soul;
  try { soul = JSON.parse(ctx.read(s.file).toString('utf8')); } catch { return ctx.bad('soul_json', `${s.file} is not valid JSON`); }
  // ownerName is the owner's own: a shared soul never sets it.
  if (isObj(soul) && 'ownerName' in soul) ctx.bad('soul_owner_name', `${s.file} must not set ownerName`);
  const verdict = validateSoul(soul);
  if (!verdict || verdict.ok === false) ctx.bad('soul_invalid', `${s.file}: ${(verdict && verdict.error) || 'refused'}${verdict && verdict.field ? ` (${verdict.field})` : ''}`);
}

// Files a web-app pack may never hold: they would run outside its webview. They stay in `ext` so the refusal names this rule.
const PLUGIN_NATIVE = ['.mjs', '.cjs', '.node', '.dll', '.exe', '.pyd', '.py', '.wasm'];
const PLUGIN_PERMS = ['storage', 'links', 'avatar', 'net'];
const LINK_KEY = /^[a-z][a-z0-9-]{0,31}$/;

function checkPlugin(m, ctx) {
  const p = m.plugin;
  if (!isObj(p)) return ctx.bad('plugin_section', 'plugin: the manifest needs a "plugin" section');
  for (const rel of ctx.list) if (PLUGIN_NATIVE.includes(extOf(rel))) ctx.bad('plugin_native', `${rel}: a web-app pack runs only in its webview; no Node or native file`);
  if (typeof p.ui !== 'string' || !/\.html$/i.test(p.ui) || !ctx.has(p.ui)) ctx.bad('plugin_ui', 'plugin.ui must name the .html page the tab opens, a file in the package');
  const t = p.tab;
  if (!isObj(t) || !isObj(t.label) || typeof t.label.en !== 'string' || !t.label.en.trim() || t.label.en.length > 24) ctx.bad('plugin_tab', 'plugin.tab.label.en is required, up to 24 characters');
  else if (t.icon !== undefined && (typeof t.icon !== 'string' || !ctx.has(t.icon))) ctx.bad('plugin_tab', 'plugin.tab.icon must name a file in the package');
  const perms = p.permissions === undefined ? {} : p.permissions;
  if (!isObj(perms)) return ctx.bad('plugin_permissions', 'plugin.permissions must be an object');
  for (const k of Object.keys(perms)) if (!PLUGIN_PERMS.includes(k)) ctx.bad('plugin_permission_unknown', `plugin.permissions.${k} is not a permission (${PLUGIN_PERMS.join(', ')})`);
  if (perms.storage !== undefined && typeof perms.storage !== 'boolean') ctx.bad('plugin_permissions', 'plugin.permissions.storage must be true or false');
  if (perms.avatar !== undefined && perms.avatar !== 'read') ctx.bad('plugin_permission_unknown', 'plugin.permissions.avatar can only be "read"');
  if (perms.net !== undefined && (!Array.isArray(perms.net) || perms.net.length)) ctx.bad('plugin_net', 'plugin.permissions.net must be empty: a web-app pack has no network in v1');
  if (perms.links !== undefined) {
    if (!isObj(perms.links)) ctx.bad('plugin_link', 'plugin.permissions.links maps a key to an https link');
    else for (const [k, u] of Object.entries(perms.links)) {
      let ok = LINK_KEY.test(k) && typeof u === 'string';
      if (ok) { try { ok = new URL(u).protocol === 'https:'; } catch { ok = false; } }
      if (!ok) ctx.bad('plugin_link', `plugin.permissions.links.${k} must be an https link under a short lowercase key`);
    }
  }
}

// ---------- scene: a binary glTF the host renders + its descriptor ----------
export const SCENE_CAPS = Object.freeze({ triangles: 1500000, textureMaxPx: 4096 });
const GLTF_EXT_ALLOWED = ['KHR_materials_emissive_strength', 'KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_clearcoat', 'KHR_materials_sheen', 'KHR_materials_unlit', 'KHR_texture_transform', 'KHR_lights_punctual', 'KHR_mesh_quantization'];
const SCENE_MIME = ['image/png', 'image/jpeg'];

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < buf.length) {
    if (buf[at] !== 0xff) return null;
    const marker = buf[at + 1], len = buf.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [buf.readUInt16BE(at + 7), buf.readUInt16BE(at + 5)];
    at += 2 + len;
  }
  return null;
}

function readGlb(buf) {
  if (buf.length < 28 || buf.toString('latin1', 0, 4) !== 'glTF' || buf.readUInt32LE(4) !== 2 || buf.readUInt32LE(8) !== buf.length) return null;
  const jsonLen = buf.readUInt32LE(12);
  if (buf.toString('latin1', 16, 20) !== 'JSON' || 20 + jsonLen > buf.length) return null;
  let json;
  try { json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)); } catch { return null; }
  let bin = null; const at = 20 + jsonLen;
  if (at + 8 <= buf.length && buf.readUInt32LE(at + 4) === 0x004e4942) bin = buf.subarray(at + 8, at + 8 + buf.readUInt32LE(at));
  return isObj(json) && isObj(json.asset) && json.asset.version === '2.0' ? { json, bin } : null;
}

function checkScene(m, ctx) {
  const s = m.scene;
  if (!isObj(s)) return ctx.bad('scene_section', 'scene: the manifest needs a "scene" section');
  const budget = isObj(s.budget) ? s.budget : {};
  if (!Number.isInteger(budget.triangles) || budget.triangles < 1 || budget.triangles > SCENE_CAPS.triangles || !Number.isInteger(budget.textureMaxPx) || budget.textureMaxPx < 1 || budget.textureMaxPx > SCENE_CAPS.textureMaxPx) {
    ctx.bad('scene_budget', `scene.budget must state triangles (up to ${SCENE_CAPS.triangles}) and textureMaxPx (up to ${SCENE_CAPS.textureMaxPx})`);
  }
  if (!Array.isArray(s.tiers) || !s.tiers.length || !s.tiers.every((t) => t === 'low' || t === 'high')) ctx.bad('scene_tiers', 'scene.tiers lists "low" and/or "high"');
  let descriptor = null;
  if (typeof s.descriptor !== 'string' || !/\.json$/i.test(s.descriptor) || !ctx.has(s.descriptor)) ctx.bad('scene_descriptor', 'scene.descriptor must name the scene .json in the package');
  else { try { descriptor = JSON.parse(ctx.read(s.descriptor).toString('utf8')); } catch { ctx.bad('scene_descriptor', `${s.descriptor} is not valid JSON`); } }
  if (typeof s.glb !== 'string' || !/\.glb$/i.test(s.glb) || !ctx.has(s.glb)) return ctx.bad('scene_glb', 'scene.glb must name the binary glTF in the package');
  const glb = readGlb(ctx.read(s.glb));
  if (!glb) return ctx.bad('scene_glb', `${s.glb} is not a valid binary glTF 2.0 file`);
  const j = glb.json;
  for (const e of [...(j.extensionsUsed || []), ...(j.extensionsRequired || [])]) if (!GLTF_EXT_ALLOWED.includes(e)) ctx.bad('scene_extension', `${s.glb}: glTF extension ${e} is not on the scene allow-list`);
  // A scene is self-contained: no buffer or image may point anywhere (external, file or data URI).
  for (const [what, list] of [['buffer', j.buffers], ['image', j.images]]) for (const x of list || []) if (isObj(x) && x.uri !== undefined) ctx.bad('scene_uri', `${s.glb}: an ${what} names a URI (${String(x.uri).slice(0, 40)}); a scene embeds everything`);
  const views = j.bufferViews || [];
  for (const img of j.images || []) {
    if (!isObj(img) || img.uri !== undefined) continue;
    if (!SCENE_MIME.includes(img.mimeType)) { ctx.bad('scene_texture', `${s.glb}: an image is ${img.mimeType}; a scene holds png or jpeg`); continue; }
    const v = views[img.bufferView];
    const data = v && glb.bin ? glb.bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength) : null;
    const size = data ? (img.mimeType === 'image/png' ? pngSize(data) : jpegSize(data)) : null;
    if (!size) ctx.bad('scene_texture', `${s.glb}: an embedded image cannot be read`);
    else if (Number.isInteger(budget.textureMaxPx) && Math.max(...size) > budget.textureMaxPx) ctx.bad('scene_texture_size', `${s.glb}: a ${size.join('x')} texture is over the declared ${budget.textureMaxPx} px`);
  }
  let tris = 0;
  for (const mesh of j.meshes || []) for (const pr of mesh.primitives || []) {
    const mode = pr.mode === undefined ? 4 : pr.mode;
    const acc = (j.accessors || [])[pr.indices !== undefined ? pr.indices : (pr.attributes || {}).POSITION];
    const n = acc ? acc.count : 0;
    tris += mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0;
  }
  if (Number.isInteger(budget.triangles) && tris > budget.triangles) ctx.bad('scene_triangles', `${s.glb} has ${tris} triangles, over the declared ${budget.triangles}`);
  const named = new Set((j.nodes || []).map((n) => n && n.name));
  const anchor = descriptor && isObj(descriptor.anchors) && isObj(descriptor.anchors.zumi_stand) ? descriptor.anchors.zumi_stand.node : null;
  if (!anchor || !named.has(anchor)) ctx.bad('scene_anchor', 'a scene needs the zumi_stand anchor: descriptor anchors.zumi_stand.node naming a node in the glb');
}

function checkAgent(m, ctx) {
  const a = m.agent;
  if (!isObj(a) || !Array.isArray(a.items) || !a.items.length) return ctx.bad('agent_items', 'agent.items must list the packages it brings together');
  for (const it of a.items) {
    if (!isObj(it) || typeof it.id !== 'string' || !VERSION.test(it.version || '') || !SHA.test(it.sha256 || '')) ctx.bad('agent_items', 'each agent item is { id, version, sha256 }, by reference, never embedded');
    else if (it.id.startsWith('agent.')) ctx.bad('agent_nested', `${it.id}: an agent pack cannot hold another agent pack`);
  }
  if (a.settings !== undefined) {
    if (!isObj(a.settings)) ctx.bad('agent_settings', 'agent.settings must be an object');
    else for (const k of Object.keys(a.settings)) if (!ALLOW_KEYS.includes(k)) ctx.bad('agent_settings', `agent.settings.${k} is not on the shared-settings list`);
  }
}

/**
 * Validate an unpacked package folder. Never throws for a bad package.
 * @param {{ expectId?: string, publisher?: 'zumia'|'user' }} [opts] publisher 'user' applies the rule that only Zumia ships code.
 * @returns {Promise<{ ok: boolean, errors: { code: string, message: string }[], manifest: object|null }>}
 */
export async function validatePackDir(dir, { expectId, publisher = 'zumia', hostApi = HOST_API } = {}) {
  const errors = [];
  const bad = (code, message) => { errors.push({ code, message }); };
  const done = (manifest) => ({ ok: errors.length === 0, errors, manifest });
  let list;
  try { list = walk(dir); } catch (e) { bad(e.code || 'pack_unreadable', e.message); return done(null); }
  if (!list.includes(MANIFEST_FILE)) { bad('manifest_missing', `${MANIFEST_FILE} must be at the package root`); return done(null); }
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')); } catch { bad('manifest_json', `${MANIFEST_FILE} is not valid JSON`); return done(null); }
  if (!isObj(m)) { bad('manifest_json', `${MANIFEST_FILE} must be an object`); return done(null); }

  if (m.format !== PACK_FORMAT) bad('manifest_format', `format must be "${PACK_FORMAT}"`);
  const std = Object.prototype.hasOwnProperty.call(STANDARD, m.kind) ? STANDARD[m.kind] : null;
  if (!std) { bad('manifest_kind', `kind must be one of ${PACK_KINDS.join(', ')}`); return done(m); }
  const idParts = typeof m.id === 'string' ? m.id.split('.') : [];
  if (idParts.length !== 2 || idParts[0] !== m.kind || !ID.test(idParts[1])) bad('manifest_id', `id must be "${m.kind}.<lowercase-name>"`);
  if (expectId && m.id !== expectId) bad('manifest_id', `this download is ${expectId}, the package says ${m.id}`);
  if (!VERSION.test(m.version || '')) bad('manifest_version', 'version must be like 1.2.3');
  if (!isObj(m.name) || typeof m.name.en !== 'string' || !m.name.en.trim() || m.name.en.length > 60) bad('manifest_name', 'name.en is required, up to 60 characters');
  if (!isObj(m.author) || typeof m.author.name !== 'string' || !m.author.name.trim()) bad('manifest_author', 'author.name is required');
  if (std.code && publisher !== 'zumia') bad('code_publisher', `a ${m.kind} package runs code, so only Zumia may publish it`);
  // Compatibility (ADR 2026-11-11): the kind section's api major must be one this host supports.
  const section = isObj(m[m.kind]) ? m[m.kind] : null;
  if (section && (section.api !== undefined || API_REQUIRED.includes(m.kind))) {
    const why = apiVerdict(m.kind, section.api, hostApi);
    if (why) bad(why.code, why.message);
  }

  const lic = m.licence;
  if (!isObj(lic) || !SPDX_ALLOWED.includes(lic.spdx)) bad('licence_spdx', `licence.spdx must be one of ${SPDX_ALLOWED.join(', ')}`);
  if (!isObj(lic) || typeof lic.file !== 'string' || !list.includes(lic.file) || !LICENCE_EXT.includes(extOf(lic.file))) bad('licence_file', 'licence.file must name the licence text in the package (.txt or .md)');

  // Every file is listed with its hash, and nothing unlisted ships.
  const declared = Array.isArray(m.files) ? m.files : null;
  if (!declared) bad('files_missing', 'files must list every file as { path, sha256, bytes }');
  const payload = list.filter((f) => f !== MANIFEST_FILE);
  let total = fs.statSync(path.join(dir, MANIFEST_FILE)).size;
  if (declared) {
    const byPath = new Map();
    for (const f of declared) {
      const reason = isObj(f) ? unsafePathReason(f.path) : 'not an object';
      if (reason) { bad('files_entry', `files: ${(f && f.path) || '?'}: ${reason}`); continue; }
      byPath.set(f.path, f);
    }
    for (const rel of payload) if (!byPath.has(rel)) bad('files_unlisted', `${rel} is in the package but not in files`);
    for (const [rel, f] of byPath) {
      if (!list.includes(rel)) { bad('files_absent', `${rel} is in files but not in the package`); continue; }
      const size = fs.statSync(path.join(dir, ...rel.split('/'))).size;
      total += size;
      if (size !== f.bytes) bad('files_bytes', `${rel} is ${size} bytes, files says ${f.bytes}`);
      if (await sha256File(path.join(dir, ...rel.split('/'))) !== f.sha256) bad('files_sha', `${rel} does not match its sha256`);
    }
  }
  if (total > std.maxBytes) bad('pack_too_large', `the package is ${total} bytes, a ${m.kind} package may be ${std.maxBytes}`);
  const ext = new Set(std.ext);
  const layoutGlb = roomLayoutGlb(m, dir);
  for (const rel of payload) {
    if (!ext.has(extOf(rel)) && rel !== layoutGlb) bad('file_type', `${rel}: a ${m.kind} package may not hold ${extOf(rel) || 'files without an extension'}`);
    if (!std.code && CODE_EXT.includes(extOf(rel))) bad('file_code', `${rel}: a ${m.kind} package holds data only`);
  }
  // A secret in a shared package reaches everyone who installs it.
  for (const rel of [MANIFEST_FILE, ...payload.filter((f) => TEXT_EXT.has(extOf(f)) && fs.statSync(path.join(dir, ...f.split('/'))).size <= MB && !f.includes('node_modules/'))]) {
    if (looksLikeKey(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'))) bad('secret_shape', `${rel} holds what looks like a key`);
  }
  const has = (rel) => typeof rel === 'string' && !unsafePathReason(rel) && list.includes(rel);
  const abs = (rel) => path.join(dir, ...rel.split('/'));
  std.check(m, {
    list, has, bad,
    bytes: (rel) => fs.statSync(abs(rel)).size,
    read: (rel) => fs.readFileSync(abs(rel)),
    abs,
    head: (rel, n) => { const fd = fs.openSync(abs(rel), 'r'); try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, got); } finally { fs.closeSync(fd); } },
  });
  return done(m);
}

/** The one .glb a painted (layout) room may carry: the occluders its room.json names. Null for every other pack. */
function roomLayoutGlb(m, dir) {
  const r = m && m.kind === 'room' && isObj(m.room) ? m.room : null;
  if (!r || typeof r.layout !== 'string' || unsafePathReason(r.layout)) return null;
  let json;
  try { json = JSON.parse(fs.readFileSync(path.join(dir, ...r.layout.split('/')), 'utf8')); } catch { return null; }
  const at = r.layout.includes('/') ? r.layout.slice(0, r.layout.lastIndexOf('/') + 1) : '';
  return json && typeof json.model === 'string' && /\.glb$/i.test(json.model) && !unsafePathReason(at + json.model) ? at + json.model : null;
}

/**
 * Validate a package zip, leaving the extracted, checked folder at `destDir` when it passes. The caller supplies the
 * `maxBytes` of the kind it expects, because the manifest cannot be trusted before extraction.
 * @returns {Promise<{ ok: boolean, errors: object[], manifest: object|null }>}
 */
export async function validatePackZip(zipPath, destDir, { kind, expectId, publisher, onProgress, hostApi } = {}) {
  const maxBytes = kind && STANDARD[kind] ? STANDARD[kind].maxBytes : Math.max(...PACK_KINDS.map((k) => STANDARD[k].maxBytes));
  fs.rmSync(destDir, { recursive: true, force: true });
  try {
    await extractZip(zipPath, destDir, { maxBytes, onProgress });
  } catch (e) {
    fs.rmSync(destDir, { recursive: true, force: true });
    return { ok: false, errors: [{ code: e.code || 'zip_invalid', message: e.message }], manifest: null };
  }
  const verdict = await validatePackDir(destDir, { expectId, publisher, hostApi });
  if (verdict.ok && kind && verdict.manifest.kind !== kind) verdict.errors.push({ code: 'manifest_kind', message: `expected a ${kind} package` });
  verdict.ok = verdict.errors.length === 0;
  if (!verdict.ok) fs.rmSync(destDir, { recursive: true, force: true });
  return verdict;
}
