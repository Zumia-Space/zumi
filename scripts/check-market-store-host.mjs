// check:market-store-host (T-31-ROOM-slim). The in-app Marketplace reads its items from the signed store index instead of a
// catalog compiled into the app: a local store folder and an https store through a fake server, the cache in <data>/market that
// the Rust pack host re-checks, offline with and without a cache, a tampered and a replayed index, version pick, the download
// pinned by the index, the listed manifest hash, and a room pack landing where the room loaders look. No network, no paid call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { packZip, sha256 } from './lib/zip-write.mjs';
import { createMarketHost } from '../tauri/sidecar/market-host.mjs';
import { generateKeyPair, parsePublicKey, publicKeyText, signMinisign } from '../tauri/sidecar/market-sign.mjs';
import { INDEX_FORMAT } from '../tauri/sidecar/market-store.mjs';

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-market-store-host-'));
let n = 0;
const fresh = (tag) => { const d = path.join(root, `${tag}${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const settle = () => new Promise((r) => setTimeout(r, 30));

const storeKey = generateKeyPair(), stranger = generateKeyPair();
const KEYS = [parsePublicKey(publicKeyText(storeKey))];

const LIC = { spdx: 'Apache-2.0', file: 'LICENSE.txt' };
const voiceManifest = (version = '1.2.1') => ({ format: 'zumi-pack/1', id: 'voice.kokoro-82m', kind: 'voice', version, name: { en: 'Kokoro' }, author: { name: 'hexgrad' }, licence: LIC, platforms: ['win-x64'], voice: { engine: 'kokoro', langs: ['en'] } });
const RUNTIME = {
  'LICENSE.txt': 'Apache-2.0',
  'voice-modules/node_modules/kokoro-js/dist/kokoro.js': '//k',
  'voice-modules/node_modules/@huggingface/transformers/dist/transformers.node.mjs': '//t',
  'voice-modules/node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node': 'b',
};
function mp4() { const b = Buffer.alloc(400); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); b.write('moov', 40, 'latin1'); b.write('stsd', 60, 'latin1'); b.write('avc1', 80, 'latin1'); b.writeUInt16BE(1920, 108); b.writeUInt16BE(1080, 110); return b; }
const roomManifest = { format: 'zumi-pack/1', id: 'room.beach-cabin', kind: 'room', version: '1.0.0', name: { en: 'Beach cabin' }, author: { name: 'Zumia' }, licence: { spdx: 'LicenseRef-Zumia', file: 'LICENSE.txt' }, room: { over: 'default-v2', video: '06-beach-cabin-studio-2710.mp4', seconds: 15.92, framing: { scale: 1.1, offsetX: 0, offsetY: -33 } } };
const roomZip = packZip(roomManifest, { 'LICENSE.txt': 'Zumia', '06-beach-cabin-studio-2710.mp4': mp4() });

/** Write a store folder: zips + a signed index. `entries` = [{ manifest, zip, meta?, api? }]. */
function writeStore(dir, entries, { serial = 1, key = storeKey, withdrawn = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const packs = [];
  for (const e of entries) {
    const file = `${e.manifest.id}-${e.manifest.version}.zip`;
    fs.writeFileSync(path.join(dir, file), e.zip);
    let p = packs.find((x) => x.id === e.manifest.id);
    if (!p) { p = { id: e.manifest.id, kind: e.manifest.kind, name: e.manifest.name, licence: e.manifest.licence.spdx, meta: e.meta || {}, versions: [], withdrawn: withdrawn[e.manifest.id] || [] }; packs.push(p); }
    p.versions.unshift({ version: e.manifest.version, api: e.api || 1, url: file, sha256: sha256(e.zip), bytes: e.zip.length, manifestSha256: sha256(e.manifestOnDisk) });
  }
  const bytes = Buffer.from(JSON.stringify({ format: INDEX_FORMAT, serial, published: '2026-11-11T00:00:00Z', packs }));
  fs.writeFileSync(path.join(dir, 'index.json'), bytes);
  fs.writeFileSync(path.join(dir, 'index.json.minisig'), signMinisign(bytes, key));
  return dir;
}
// The manifest hash is over the bytes of the zip's own zumi-pack.json (packZip adds the files list): read them back.
import { extractZip } from '../tauri/sidecar/market-zip.mjs';
async function manifestOf(zip) {
  const z = path.join(fresh('z'), 'p.zip'); fs.writeFileSync(z, zip);
  const out = path.join(path.dirname(z), 'x'); await extractZip(z, out, { maxBytes: 1e9 });
  return fs.readFileSync(path.join(out, 'zumi-pack.json'));
}
const kokoroZip = packZip(voiceManifest(), RUNTIME);
const kokoroOnDisk = await manifestOf(kokoroZip);
const roomOnDisk = await manifestOf(roomZip);
const KOKORO = { manifest: voiceManifest(), zip: kokoroZip, manifestOnDisk: kokoroOnDisk, meta: { recommended: true, langs: ['en'], platforms: ['win-x64'], modelBytes: 100, needs: ['runs-code', 'model-download'], author: 'hexgrad' } };
const ROOM = { manifest: roomManifest, zip: roomZip, manifestOnDisk: roomOnDisk, meta: { activates: 'beach-cabin' } };

function fakeModel() { let here = false; return { present: () => here, calls: 0, download(cb) { this.calls++; cb({ loaded: 5, total: 10 }); here = true; return Promise.resolve(true); }, stop() {}, remove() { here = false; } }; }
const noNet = async () => { throw new Error('must not fetch'); };
const host = (dataDir, source, o = {}) => createMarketHost({ dataDir, store: { source, publicKeys: KEYS }, fetchImpl: noNet, model: fakeModel(), ...o });
const ids = (l) => l.items.map((i) => i.id).sort().join();

// ---------- a local store folder: items come from the signed index ----------
{
  const store = writeStore(fresh('s'), [KOKORO, ROOM]);
  const d = fresh('d');
  const h = host(d, store).handlers;
  h['market.list'](); await settle();
  const l = h['market.list']();
  ok(ids(l) === 'room.beach-cabin,voice.kokoro-82m', 'the list is the signed index, not a compiled catalog', ids(l));
  ok(l.store && l.store.state === 'ok' && l.store.serial === 1, 'the list says where the store stands', JSON.stringify(l.store));
  const k = l.items.find((i) => i.id === 'voice.kokoro-82m');
  ok(k.state === 'available' && k.version === '1.2.1' && k.modelBytes === 100 && k.recommended === true && k.sha256 === sha256(kokoroZip), 'an item carries the version, pin and facts the index lists', JSON.stringify(k));
  ok(fs.existsSync(path.join(d, 'market', 'index.json')) && fs.existsSync(path.join(d, 'market', 'index.json.minisig')), 'the verified index is cached where the Rust pack host re-checks it');
  const r = await h['market.install']('voice.kokoro-82m');
  ok(r.ok, 'Kokoro installs from the store', JSON.stringify(r));
  ok(fs.existsSync(path.join(d, 'packs', 'voice.kokoro-82m', 'voice-modules', 'node_modules', 'kokoro-js', 'dist', 'kokoro.js')), 'Kokoro lands in <data>/packs/<id>, where the voice host looks');
  const rr = await h['market.install']('room.beach-cabin');
  ok(rr.ok && fs.existsSync(path.join(d, 'packs', 'room.beach-cabin', '06-beach-cabin-studio-2710.mp4')), 'a room pack lands in <data>/packs/<id> with its video under the pinned name', JSON.stringify(rr));
  const rec = JSON.parse(fs.readFileSync(path.join(d, 'packs', 'installed.json'), 'utf8'));
  ok(rec['room.beach-cabin'].manifestSha256 === sha256(roomOnDisk) && rec['voice.kokoro-82m'].version === '1.2.1', 'installed.json records version and the listed manifest hash');
  ok(h['market.list']().items.every((i) => i.state === 'installed'), 'both read Installed');
}
// ---------- offline: a cache keeps the list; no cache is said in words; installed packs stay ----------
{
  const store = writeStore(fresh('s'), [KOKORO]);
  const d = fresh('d');
  const first = host(d, store).handlers; first['market.list'](); await settle(); await first['market.install']('voice.kokoro-82m');
  const off = host(d, path.join(store, 'gone')).handlers; off['market.list'](); await settle();
  const l = off['market.list']();
  ok(l.store.state === 'offline' && l.items.length === 1 && l.items[0].state === 'installed', 'store unreachable + cache: the cached list, the installed pack reads Installed', JSON.stringify(l));
  const none = host(fresh('d'), path.join(store, 'gone')).handlers; none['market.list'](); await settle();
  const e = none['market.list']();
  ok(e.store.state === 'offline' && e.items.length === 0, 'store unreachable, nothing cached: an empty list that says offline', JSON.stringify(e));
  const httpsOff = createMarketHost({ dataDir: fresh('d'), store: { source: 'https://github.com/Zumia-Space/zumi-market/releases/latest/download/', publicKeys: KEYS }, fetchImpl: async () => { throw new TypeError('fetch failed'); }, model: fakeModel() }).handlers;
  httpsOff['market.list'](); await settle();
  ok(httpsOff['market.list']().store.state === 'offline', 'an https store with no network reads offline');
}
// ---------- trust: a stranger's signature, a tampered index, a replayed older index ----------
{
  const d = fresh('d');
  const bad = writeStore(fresh('s'), [KOKORO], { key: stranger });
  const h = host(d, bad).handlers; h['market.list'](); await settle();
  const l = h['market.list']();
  ok(l.store.state === 'refused' && l.items.length === 0, 'an index signed by an unknown key is refused', JSON.stringify(l.store));
  ok(!fs.existsSync(path.join(d, 'market', 'index.json')), 'a refused index is never cached');
  const s = writeStore(fresh('s'), [KOKORO]);
  const tampered = Buffer.from(fs.readFileSync(path.join(s, 'index.json'), 'utf8').replace('"serial":1', '"serial":9'));
  fs.writeFileSync(path.join(s, 'index.json'), tampered);
  const t = host(fresh('d'), s).handlers; t['market.list'](); await settle();
  ok(t['market.list']().store.state === 'refused', 'one changed byte in the index is refused');
  const d2 = fresh('d');
  const newer = writeStore(fresh('s'), [KOKORO], { serial: 5 });
  const a = host(d2, newer).handlers; a['market.list'](); await settle();
  const older = writeStore(fresh('s'), [KOKORO], { serial: 4 });
  const b = host(d2, older).handlers; b['market.list'](); await settle();
  const lb = b['market.list']();
  ok(lb.store.state === 'refused' && lb.store.serial === 5, 'an older index replayed after a newer one is refused; the newer cache stays', JSON.stringify(lb.store));
}
// ---------- pins: the zip must be the one the index lists; the manifest must be the listed one ----------
{
  const s = writeStore(fresh('s'), [KOKORO]);
  fs.writeFileSync(path.join(s, 'voice.kokoro-82m-1.2.1.zip'), Buffer.concat([kokoroZip.subarray(0, -1), Buffer.from([7])]));
  const d = fresh('d');
  const h = host(d, s).handlers; h['market.list'](); await settle();
  const r = await h['market.install']('voice.kokoro-82m');
  ok(!r.ok && r.code === 'sha_mismatch' && !fs.existsSync(path.join(d, 'packs', 'voice.kokoro-82m')), 'a zip that differs from the index is refused and nothing goes live', JSON.stringify(r));
  const s2 = writeStore(fresh('s'), [{ ...KOKORO, manifestOnDisk: Buffer.from('not the listed manifest') }]);
  const h2 = host(fresh('d'), s2).handlers; h2['market.list'](); await settle();
  const r2 = await h2['market.install']('voice.kokoro-82m');
  ok(!r2.ok && r2.code === 'invalid_pack', 'a pack whose manifest is not the listed one is refused', JSON.stringify(r2));
}
// ---------- version pick: newest live version this host supports; update; withdrawn ----------
{
  const k2 = packZip(voiceManifest('1.2.2'), RUNTIME);
  const K2 = { manifest: voiceManifest('1.2.2'), zip: k2, manifestOnDisk: await manifestOf(k2), meta: KOKORO.meta };
  const k3 = packZip(voiceManifest('2.0.0'), RUNTIME);
  const K3 = { manifest: voiceManifest('2.0.0'), zip: k3, manifestOnDisk: await manifestOf(k3), meta: KOKORO.meta, api: 2 };
  const d = fresh('d');
  const s1 = writeStore(fresh('s'), [KOKORO]);
  const a = host(d, s1).handlers; a['market.list'](); await settle(); await a['market.install']('voice.kokoro-82m');
  const s2 = writeStore(fresh('s'), [KOKORO, K2, K3], { serial: 2 });
  const b = host(d, s2).handlers; b['market.list'](); await settle();
  const item = b['market.list']().items[0];
  ok(item.state === 'update' && item.version === '1.2.2', 'a newer compatible version reads Update; the api-2 version is skipped', JSON.stringify(item));
  ok((await b['market.install']('voice.kokoro-82m')).ok && JSON.parse(fs.readFileSync(path.join(d, 'packs', 'voice.kokoro-82m', 'zumi-pack.json'), 'utf8')).version === '1.2.2', 'Update installs 1.2.2 with no new app');
  const s3 = writeStore(fresh('s'), [KOKORO, K2], { serial: 3, withdrawn: { 'voice.kokoro-82m': ['1.2.2'] } });
  const c = host(fresh('d'), s3).handlers; c['market.list'](); await settle();
  ok(c['market.list']().items[0].version === '1.2.1', 'a withdrawn version is never offered');
}
// ---------- https store: files fetched through the guarded fetch, one redirect hop each followed ----------
{
  const s = writeStore(fresh('s'), [KOKORO]);
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    if (url.startsWith('https://github.com/')) return { ok: false, status: 302, headers: new Headers({ location: `https://release-assets.githubusercontent.com/x/${path.basename(url)}` }), body: null };
    const f = path.join(s, path.basename(url));
    if (!fs.existsSync(f)) return { ok: false, status: 404, headers: new Headers(), body: null };
    return { ok: true, status: 200, headers: new Headers(), body: new Blob([fs.readFileSync(f)]).stream(), arrayBuffer: async () => fs.readFileSync(f) };
  };
  const d = fresh('d');
  const h = createMarketHost({ dataDir: d, store: { source: 'https://github.com/Zumia-Space/zumi-market/releases/latest/download/', publicKeys: KEYS }, fetchImpl: fake, model: fakeModel() }).handlers;
  h['market.list'](); await settle();
  ok(h['market.list']().store.state === 'ok', 'an https store verifies through redirects', JSON.stringify(h['market.list']().store));
  ok((await h['market.install']('voice.kokoro-82m')).ok, 'and installs a pack from it');
  ok(seen.includes('https://github.com/Zumia-Space/zumi-market/releases/latest/download/voice.kokoro-82m-1.2.1.zip'), 'the zip url is resolved against the store origin', seen.join(' '));
}

// ---------- removing the default room's pack takes its served copy with it ----------
{
  const nc = { ...ROOM, manifest: { ...roomManifest, id: 'room.night-city' } };
  nc.zip = packZip(nc.manifest, { 'LICENSE.txt': 'Zumia', '06-beach-cabin-studio-2710.mp4': mp4() });
  nc.manifestOnDisk = await manifestOf(nc.zip); nc.meta = { activates: 'default-v2' };
  const d = fresh('d');
  const h = host(d, writeStore(fresh('s'), [nc])).handlers; h['market.list'](); await settle();
  ok((await h['market.install']('room.night-city')).ok, 'the default room pack installs');
  fs.mkdirSync(path.join(d, 'rooms', 'default-v2', 'abcdefabcdef'), { recursive: true });
  ok(h['market.remove']('room.night-city').ok && !fs.existsSync(path.join(d, 'rooms', 'default-v2')) && !fs.existsSync(path.join(d, 'packs', 'room.night-city')), 'remove deletes the pack and the copy the room was served from');
}

// ---------- the page: the Start strip and store rows (src/renderer/market.js, pure parts) ----------
{
  const { startState, buildRows, STARTER } = await import('../src/renderer/market.js');
  const item = (id, state, extra = {}) => ({ id, kind: id.split('.')[0], state, ...extra });
  ok(STARTER.join() === 'room.night-city,voice.kokoro-82m', 'the first-run offer is the default room, then the voice');
  ok(startState({ items: [item('voice.kokoro-82m', 'available')] }) === null, 'a build with no store (compiled catalog): no Start strip');
  const s1 = startState({ store: { state: 'ok' }, items: [item('room.night-city', 'available'), item('voice.kokoro-82m', 'available')] });
  ok(s1 && s1.kind === 'offer' && s1.ids.join() === 'room.night-city,voice.kokoro-82m', 'fresh install, store reachable: offer both', JSON.stringify(s1));
  const s2 = startState({ store: { state: 'ok' }, items: [item('room.night-city', 'installed'), item('voice.kokoro-82m', 'available')] });
  ok(s2 && s2.ids.join() === 'voice.kokoro-82m', 'room installed: offer the voice only');
  ok(startState({ store: { state: 'ok' }, items: [item('room.night-city', 'installed'), item('voice.kokoro-82m', 'installed')] }) === null, 'both installed: the strip goes away');
  ok(startState({ store: { state: 'ok' }, items: [item('room.night-city', 'installed'), item('voice.kokoro-82m', 'bundled')] }) === null, 'a build that carries Kokoro: no voice offer');
  ok(startState({ store: { state: 'offline' }, items: [] }).kind === 'offline', 'no network, nothing cached: the strip says offline (and offers Retry)');
  ok(startState({ store: { state: 'refused' }, items: [] }).kind === 'refused', 'an index that does not verify: the strip says so');
  // The strip's 'offline' kind covers every unreadable store (no network, a missing file, an http error) and chat is a cloud call:
  // the text may claim neither 'offline' nor that chat works; it says chat needs internet and a provider key (release 0.3.5 gate).
  {
    const i18n = await import('../src/renderer/i18n.js');
    const want = {
      en: 'Zumi cannot reach the Marketplace right now. Rooms and voices can be installed here later; chat needs internet and your AI provider key.',
      vi: 'Zumi chưa kết nối được Marketplace. Phòng và giọng có thể cài ở đây sau; trò chuyện cần có mạng và khoá của nhà cung cấp AI bạn chọn.',
      zh: 'Zumi 暂时无法连接商店。房间和语音可以稍后在这里安装;聊天需要联网和你的 AI 服务商密钥。',
    };
    const false_ = { en: /offline|chat works/i, vi: /mất mạng|vẫn dùng được/i, zh: /离线|照常可用/ };
    for (const lang of ['en', 'vi', 'zh']) {
      i18n.setLocale(lang);
      const text = i18n.t('market.start.offline');
      ok(text === want[lang] && !false_[lang].test(text), `the unreachable-store strip (${lang}) claims neither offline nor working chat; chat needs internet + a provider key`, text);
    }
    // The offer shows when the store answered; chat still needs the user's provider key, which the market UI does not know.
    const offer = {
      en: 'You can chat by text now (needs your AI provider key). Add a room and a voice when you like: both are free and install here.',
      vi: 'Bạn có thể trò chuyện bằng chữ ngay (cần khoá của nhà cung cấp AI bạn chọn). Thêm phòng và giọng nói lúc nào cũng được: đều miễn phí, cài ngay tại đây.',
      zh: '现在就能用文字聊天(需要你的 AI 服务商密钥)。房间和语音随时可以添加:都免费,在这里安装。',
    };
    // An item reads 'offline' when the request for its download got no answer: say that, not that the PC is offline.
    const unreachable = { en: 'Cannot reach the download. Try again.', vi: 'Chưa kết nối được nơi tải. Thử lại.', zh: '无法连接下载地址。请重试。' };
    for (const lang of ['en', 'vi', 'zh']) {
      i18n.setLocale(lang);
      ok(i18n.t('market.start.offer') === offer[lang], `the Start strip offer (${lang}) says chat needs the provider key`, i18n.t('market.start.offer'));
      ok(i18n.t('market.status.offline') === unreachable[lang] && !false_[lang].test(i18n.t('market.status.offline')), `an unreachable download (${lang}) is labelled as such, not "offline"`, i18n.t('market.status.offline'));
    }
    i18n.setLocale('en');
  }
  const tr = (k) => (k === 'market.item.room_night_city.name' ? 'Night City' : k === 'market.room.desc' ? 'A room.' : k);
  const rows = buildRows({ market: { store: { state: 'ok' }, items: [item('room.night-city', 'available', { activates: 'default-v2' }), item('room.beach-cabin', 'installed', { activates: 'beach-cabin', name: { en: 'Beach cabin', vi: 'Nhà gỗ biển' } })] }, rooms: [{ id: 'beach-cabin', label: 'Beach cabin', selected: true }, { id: 'zen-garden', label: 'Zen', selected: false }], models: [], tr, lang: 'vi' });
  ok(rows.find((r) => r.id === 'room.night-city').name === 'Night City', 'a store item with its own i18n key uses it');
  ok(rows.find((r) => r.id === 'room.beach-cabin').name === 'Nhà gỗ biển' && rows.find((r) => r.id === 'room.beach-cabin').origin === 'catalog', 'a store room without a key takes its name from the index, in the UI language');
  ok(rows.filter((r) => r.id === 'room.beach-cabin').length === 1 && rows.some((r) => r.id === 'room.zen-garden' && r.origin === 'room'), 'a video room that came as a pack shows once (its pack row); one on this PC from elsewhere keeps its own row');
}

// ---------- the app's own store settings ----------
{
  const { STORE_PUB_TEXT, STORE_URL, storeSource } = await import('../tauri/sidecar/market-keys.mjs');
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const onDisk = ['store.pub', 'spare.pub'].map((f) => fs.readFileSync(path.join(repo, 'tauri', 'market-keys', f), 'utf8'));
  ok(STORE_PUB_TEXT[0] === onDisk[0] && STORE_PUB_TEXT[1] === onDisk[1], 'the sidecar trusts exactly the keys the Rust host compiles in (tauri/market-keys)');
  ok(storeSource({}) === STORE_URL && STORE_URL.startsWith('https://github.com/'), 'no override: the fixed https store on a Marketplace origin');
  ok(storeSource({ ZUMI_MARKET_STORE: 'D:\\store' }) === 'D:\\store' && storeSource({ ZUMI_MARKET_STORE: 'https://x.test/s' }) === 'https://x.test/s/', 'an override names a local folder or an https base');
  ok(storeSource({ ZUMI_MARKET_STORE: 'http://x.test/' }) === STORE_URL && storeSource({ ZUMI_MARKET_STORE: 'store' }) === STORE_URL, 'plain http and a relative path are ignored');
}

console.log(`check:market-store-host: ${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
