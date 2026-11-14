// The Marketplace in the app: free items packaged by Zumia. Two sources, one install path:
//  - `store` (T-31-ROOM-slim, ADR 2026-11-11-pack-system phase 4): the signed store index, from an https origin or a local folder.
//    The index is verified with the compiled store keys, its serial may only grow, and the verified copy is cached in
//    <data>/market/ (where the Rust pack host re-checks it), so an offline start still lists and loads what is installed.
//    Each item is the newest listed, not withdrawn version whose api this host supports (market-store.mjs pickVersion).
//  - `catalog`: a list compiled into the app (the 0.3.x path, kept for tests and builds without a store).
// Owner ruling 11-11 (mkt-q2): every item is free for now. Nothing here knows about prices; a paid item would be a new field
// and a new state, not a change to the install path.
//
// A package lands at <data>/packs/<id>/, which an app update never touches. Trust: https to the fixed origins, one redirect hop
// checked by the same guard (egress.mjs marketFetch); bytes and sha256 from the catalog, then the package standard (market-standard.mjs), all
// before anything goes live. The swap from <id>.part is one rename.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MANIFEST_FILE, validatePackZip } from './market-standard.mjs';
import { checkPreview, previewDataUri, previewPin } from './market-preview.mjs';
import { pickVersion, verifyIndex } from './market-store.mjs';

// Kokoro's runtime pack, built by scripts/market-pack-kokoro.mjs; the build's own sha and size go here. Every shipped item has a
// pinned download (check:release-gate): an item with no package is not listed. VieNeu-TTS left 05-11: no package exists (1.36 GB
// measured 01-11, packaging needs the owner's go). `needs` is what the detail panel shows under Permissions.
export const CATALOG = Object.freeze([
  {
    id: 'voice.kokoro-82m', kind: 'voice', version: '1.2.1', recommended: true, licence: 'Apache-2.0', author: 'hexgrad',
    langs: ['en'], platforms: ['win-x64'], bytes: 87194313, modelBytes: 156 * 1024 * 1024, needs: ['runs-code', 'model-download'],
    // releaseAsset: the file may not be on GitHub yet, so the item is offered only once a HEAD finds it. No new app version is needed when it appears.
    download: { url: 'https://github.com/Zumia-Space/zumi/releases/download/packs-v1/voice.kokoro-82m-1.2.1.zip', sha256: '70268f99efcb55ca9be37e7c3f472a870f07312a965a85be4a3eb8331342b452', bytes: 28501808, releaseAsset: true },
  },
]);

const SAFE_ID = /^[a-z]+\.[a-z0-9-]+$/;
const STALL_MS = 30_000;
const REPROBE_MS = 60_000;
const STORE_REFRESH_MS = 10 * 60_000; // the list re-reads the index at most this often; a start always reads it once
const STORE_RETRY_MS = 5_000; // after a failed read (offline, refused) a list asks again this soon: the page's Retry
const HOPS = 3; // GitHub's releases/latest/download/<f> -> releases/download/<tag>/<f> -> release-assets: each hop through the guard
const INDEX_MAX = 4 * 1024 * 1024;
const isHttps = (source) => /^https:\/\//.test(source);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The index's one line, `{ <lang>: text }` (strings only) or a plain string; anything else is no line (the page falls back to i18n). */
function storeDesc(desc) {
  if (typeof desc === 'string') return desc || null;
  if (!desc || typeof desc !== 'object' || Array.isArray(desc)) return null;
  const out = Object.fromEntries(Object.entries(desc).filter(([, v]) => typeof v === 'string' && v));
  return Object.keys(out).length ? out : null;
}

/** One store item from a verified index entry, or null when no version fits this host (it is then not offered). */
function storeItem(pack, source) {
  const pick = pickVersion(pack);
  if (!pick.ok) return null;
  const v = pick.version;
  const meta = pack.meta && typeof pack.meta === 'object' ? pack.meta : {};
  const name = path.basename(String(v.url));
  return {
    id: pack.id, kind: pack.kind, version: v.version, name: pack.name || null, licence: pack.licence || null,
    author: typeof meta.author === 'string' ? meta.author : 'Zumia', recommended: meta.recommended === true,
    langs: Array.isArray(meta.langs) ? meta.langs : undefined, platforms: Array.isArray(meta.platforms) ? meta.platforms : undefined,
    needs: Array.isArray(meta.needs) ? meta.needs : [], modelBytes: Number.isInteger(meta.modelBytes) ? meta.modelBytes : 0,
    bytes: Number.isInteger(meta.bytes) ? meta.bytes : v.bytes, activates: typeof meta.activates === 'string' ? meta.activates : null,
    desc: storeDesc(meta.desc), previewPin: previewPin(meta.preview),
    download: isHttps(source)
      ? { url: new URL(v.url, source).href, sha256: v.sha256, bytes: v.bytes, manifestSha256: v.manifestSha256 }
      : { file: path.join(source, name), url: `file:${name}`, sha256: v.sha256, bytes: v.bytes, manifestSha256: v.manifestSha256 },
  };
}

/**
 * @param {{ dataDir: string, catalog?: object[], fetchImpl: Function, emit: Function, bundled: (id: string) => boolean,
 *           model: () => { present: () => boolean, download: (onProgress: Function) => Promise<boolean>, remove: () => void, stop: () => void },
 *           log?: Function }} o
 */
export function createMarketHost({ dataDir, catalog = CATALOG, store = null, fetchImpl, emit = () => false, bundled = () => false, model, log = () => {} }) {
  const packsDir = path.join(dataDir, 'packs');
  const marketDir = path.join(dataDir, 'market');
  // The store's view: the verified index (cached or fresh), and how the last read went.
  const storeView = { index: null, state: 'none', at: 0, pending: null };
  const installedFile = path.join(packsDir, 'installed.json');
  const busy = new Map(); // id -> last progress
  const previews = new Map(); // preview sha256 -> { uri } once verified, or { at, pending? } while fetching / after a failure
  const published = new Map(); // id -> { yes, at }, for a download marked releaseAsset
  const packDir = (id) => path.join(packsDir, id);
  const pendingRemoval = (id) => path.join(packsDir, `${id}.remove-pending`);
  const items = () => (store ? (storeView.index ? storeView.index.packs.map((p) => storeItem(p, store.source)).filter(Boolean) : []) : catalog);
  const find = (id) => items().find((c) => c.id === id) || null;

  // ---- the store index ----
  /** GET through the guard, following up to HOPS redirects, each one through the same guard. */
  async function getFollow(url, init = {}) {
    let res = await fetchImpl(url, init);
    for (let hop = 0; hop < HOPS && res.status >= 300 && res.status < 400 && res.headers.get('location'); hop++) {
      res = await fetchImpl(new URL(res.headers.get('location'), url).href, init);
    }
    return res;
  }
  async function readStoreFile(name) {
    if (!isHttps(store.source)) return fs.readFileSync(path.join(store.source, name));
    const res = await getFollow(new URL(name, store.source).href);
    if (!res.ok || !res.body) throw Object.assign(new Error(`http_${res.status}`), { code: 'store_http' });
    const buf = Buffer.from(await new Response(res.body).arrayBuffer());
    if (buf.length > INDEX_MAX) throw Object.assign(new Error('index too large'), { code: 'store_http' });
    return buf;
  }
  function loadCachedIndex() {
    try {
      const bytes = fs.readFileSync(path.join(marketDir, 'index.json'));
      const sig = fs.readFileSync(path.join(marketDir, 'index.json.minisig'), 'utf8');
      const r = verifyIndex(bytes, sig, { publicKeys: store.publicKeys });
      if (r.ok) storeView.index = r.index; else log(`[market] cached index refused ${r.code}`);
    } catch { /* no cache yet */ }
  }
  // The signature first and the index last, each by rename: a torn write leaves the old pair or a pair the Rust host refuses,
  // never an index that verifies under a signature it does not carry.
  function cacheIndex(bytes, sig) {
    fs.mkdirSync(marketDir, { recursive: true });
    for (const [name, data] of [['index.json.minisig', sig], ['index.json', bytes]]) {
      const tmp = path.join(marketDir, `${name}.tmp`);
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, path.join(marketDir, name));
    }
  }
  async function refreshStore() {
    if (storeView.pending) return storeView.pending;
    storeView.pending = (async () => {
      try {
        let bytes, sig;
        try { [bytes, sig] = await Promise.all([readStoreFile('index.json'), readStoreFile('index.json.minisig').then((b) => b.toString('utf8'))]); } catch (e) {
          // No answer, a missing file or an http error: the store cannot be read now. Installed packs keep the cached index.
          storeView.state = 'offline';
          log(`[market] store unreachable ${e.code || 'error'}`);
          return;
        }
        const r = verifyIndex(bytes, sig, { publicKeys: store.publicKeys, cachedSerial: storeView.index ? storeView.index.serial : 0 });
        if (!r.ok) { storeView.state = 'refused'; log(`[market] store index refused ${r.code}`); return; }
        cacheIndex(bytes, sig);
        storeView.index = r.index;
        storeView.state = 'ok';
        log(`[market] store index serial ${r.index.serial} key ${r.keyId}`);
      } finally {
        storeView.at = Date.now();
        storeView.pending = null;
        emit('market:progress', { id: '_store', phase: 'done', loaded: 0, total: 0 });
      }
    })();
    return storeView.pending;
  }
  if (store) loadCachedIndex();

  const readInstalled = () => {
    try { const j = JSON.parse(fs.readFileSync(installedFile, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
  };
  const writeInstalled = (j) => { fs.mkdirSync(packsDir, { recursive: true }); fs.writeFileSync(installedFile, `${JSON.stringify(j, null, 2)}\n`); };
  const installedVersion = (id) => (readInstalled()[id] || {}).version || null;
  const isInstalled = (id) => Boolean(readInstalled()[id]) && fs.existsSync(path.join(packDir(id), 'zumi-pack.json')) && !fs.existsSync(pendingRemoval(id));

  // Windows keeps a loaded DLL's file locked until the process ends, so a remove after Kokoro ran finishes on the next start.
  function tryRemoveDir(id) {
    try { fs.rmSync(packDir(id), { recursive: true, force: true, maxRetries: 2 }); } catch (e) { log(`[market] remove id=${id} deferred ${e.code || 'error'}`); }
    if (fs.existsSync(packDir(id))) { fs.writeFileSync(pendingRemoval(id), ''); return false; }
    fs.rmSync(pendingRemoval(id), { force: true });
    return true;
  }
  function sweep() {
    let names = [];
    try { names = fs.readdirSync(packsDir); } catch { return; }
    for (const n of names) {
      if (n.endsWith('.part') || n.endsWith('.zip')) fs.rmSync(path.join(packsDir, n), { recursive: true, force: true });
      else if (n.endsWith('.remove-pending')) tryRemoveDir(n.slice(0, -'.remove-pending'.length));
    }
  }

  function itemState(c) {
    if (busy.has(c.id)) return 'installing';
    if (bundled(c.id)) return 'bundled';
    if (fs.existsSync(pendingRemoval(c.id))) return 'restart';
    if (isInstalled(c.id)) return !c.download || installedVersion(c.id) === c.version ? 'installed' : 'update';
    if (!c.download) return 'unpackaged';
    const probe = published.get(c.id);
    if (c.download.releaseAsset && !(probe || {}).yes) { refreshPublished(c); return probe && probe.offline ? 'offline' : 'unpublished'; }
    return 'available';
  }

  /** Is the Release asset there? 2xx or a redirect is yes. A request that never got an answer is offline; any status is an answer. */
  async function probePublished(c) {
    let yes = false, offline = false;
    try { const res = await fetchImpl(c.download.url, { method: 'HEAD' }); yes = res.status >= 200 && res.status < 400; } catch (e) { offline = e.code !== 'egress_refused'; }
    const probe = { yes, offline, at: Date.now() };
    published.set(c.id, probe);
    return probe;
  }
  // Called from the list, which stays synchronous: the answer repaints the page through the one event it already follows.
  function refreshPublished(c) {
    const last = published.get(c.id);
    if (last && (last.pending || Date.now() - last.at < REPROBE_MS)) return;
    published.set(c.id, { yes: false, offline: Boolean(last && last.offline), at: Date.now(), pending: true });
    probePublished(c).then((p) => { if (p.yes || p.offline !== Boolean(last && last.offline)) emit('market:progress', { id: c.id, phase: 'done', loaded: 0, total: 0 }); });
  }

  // ---- previews (meta.preview): pinned by the signed index, verified, cached at <data>/market/previews/<sha256>.<ext> ----
  const previewFile = (pin) => path.join(marketDir, 'previews', `${pin.sha256}.${pin.type}`);
  /** The bytes, never more than the pin allows: a local store file, or the store origin through the guard. */
  async function readPreview(pin) {
    if (!isHttps(store.source)) {
      const f = path.join(store.source, pin.file);
      return fs.statSync(f).size > pin.bytes ? null : fs.readFileSync(f);
    }
    const res = await getFollow(new URL(pin.file, store.source).href);
    if (!res.ok || !res.body) return null;
    const parts = [];
    let got = 0;
    for await (const chunk of res.body) { got += chunk.length; if (got > pin.bytes) return null; parts.push(Buffer.from(chunk)); }
    return Buffer.concat(parts);
  }
  async function fetchPreview(c, pin) {
    let buf = null;
    try { buf = await readPreview(pin); } catch (e) { log(`[market] preview id=${c.id} unreachable ${e.code || 'error'}`); }
    const bad = buf ? checkPreview(buf, pin) : { code: 'preview_unreachable' };
    if (bad) { if (buf) log(`[market] preview id=${c.id} refused ${bad.code}`); previews.set(pin.sha256, { at: Date.now() }); return; }
    const dest = previewFile(pin);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.tmp`, buf);
    fs.renameSync(`${dest}.tmp`, dest);
    previews.set(pin.sha256, { uri: previewDataUri(buf, pin) });
    emit('market:progress', { id: c.id, phase: 'done', loaded: 0, total: 0 });
  }
  /** The picture for a list item now, or null (the page shows the glyph) while it is fetched, or when it is refused or out of reach. */
  function previewOf(c, pin) {
    const seen = previews.get(pin.sha256);
    if (seen && seen.uri) return seen.uri;
    if (seen && (seen.pending || Date.now() - seen.at < REPROBE_MS)) return null;
    try { // a cached file is checked again before it is trusted: the data folder is not signed
      const buf = fs.readFileSync(previewFile(pin));
      if (!checkPreview(buf, pin)) { const uri = previewDataUri(buf, pin); previews.set(pin.sha256, { uri }); return uri; }
    } catch { /* not cached yet */ }
    previews.set(pin.sha256, { at: Date.now(), pending: true });
    fetchPreview(c, pin).catch((e) => { previews.set(pin.sha256, { at: Date.now() }); log(`[market] preview id=${c.id} failed ${e.code || 'error'}`); });
    return null;
  }

  function list() {
    if (store && !storeView.pending && (!storeView.at || Date.now() - storeView.at > (storeView.state === 'ok' ? STORE_REFRESH_MS : STORE_RETRY_MS))) refreshStore();
    const installed = readInstalled();
    return {
      platform: process.platform === 'win32' ? 'win-x64' : process.platform,
      store: store ? { state: storeView.pending && storeView.state === 'none' ? 'loading' : storeView.state, serial: storeView.index ? storeView.index.serial : null } : null,
      items: items().map((c) => {
        const { download, previewPin: pin, ...rest } = c;
        return {
          ...rest,
          preview: pin ? previewOf(c, pin) : null,
          state: itemState(c),
          source: download ? (download.file ? 'store' : new URL(download.url).host) : null,
          needs: rest.needs || [],
          sha256: download ? download.sha256 : null,
          downloadBytes: download ? download.bytes : 0,
          installedVersion: installed[c.id] ? installed[c.id].version : null,
          modelReady: c.modelBytes > 0 && model ? model.present() : null,
          progress: busy.get(c.id) || null,
        };
      }),
    };
  }

  async function download(c, zipPath, onBytes) {
    if (c.download.file) return copyLocal(c, zipPath, onBytes);
    const ctl = new AbortController();
    let stall = setTimeout(() => ctl.abort(), STALL_MS);
    const out = fs.openSync(zipPath, 'w');
    const hash = crypto.createHash('sha256');
    let got = 0;
    try {
      let res;
      try {
        if (store) res = await getFollow(c.download.url, { signal: ctl.signal }); // the store's own hops, each through the guard
        else {
          res = await fetchImpl(c.download.url, { signal: ctl.signal });
          const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
          if (next) res = await fetchImpl(next, { signal: ctl.signal }); // one hop; a second redirect fails below as not ok
        }
      } catch (e) { throw e.code === 'egress_refused' ? coded('download_failed', 'refused') : coded('offline', 'network'); }
      if (!res.ok || !res.body) throw coded('download_failed', `http_${res.status}`);
      const reader = res.body.getReader();
      for (;;) {
        let step;
        try { step = await reader.read(); } catch { throw coded('offline', 'network'); }
        if (step.done) break;
        clearTimeout(stall); stall = setTimeout(() => ctl.abort(), STALL_MS);
        got += step.value.length;
        // Never store more than the pin says, whatever the server sends.
        if (got > c.download.bytes) throw coded('sha_mismatch', 'larger than the catalog says');
        fs.writeSync(out, step.value);
        hash.update(step.value);
        onBytes(got, c.download.bytes);
      }
    } finally {
      clearTimeout(stall);
      fs.closeSync(out);
    }
    if (got !== c.download.bytes || hash.digest('hex') !== c.download.sha256) throw coded('sha_mismatch', 'does not match the catalog');
  }
  const coded = (code, detail) => Object.assign(new Error(detail), { code, detail });
  /** A local store folder: the same pins (bytes, then sha256) on a copy, with the same progress. */
  async function copyLocal(c, zipPath, onBytes) {
    let st;
    try { st = fs.statSync(c.download.file); } catch { throw coded('offline', 'store folder unreachable'); }
    if (st.size !== c.download.bytes) throw coded('sha_mismatch', 'does not match the index');
    const hash = crypto.createHash('sha256');
    const out = fs.openSync(zipPath, 'w');
    let got = 0;
    try {
      for await (const chunk of fs.createReadStream(c.download.file, { highWaterMark: 1 << 20 })) {
        got += chunk.length; hash.update(chunk); fs.writeSync(out, chunk); onBytes(got, c.download.bytes);
      }
    } finally { fs.closeSync(out); }
    if (got !== c.download.bytes || hash.digest('hex') !== c.download.sha256) throw coded('sha_mismatch', 'does not match the index');
  }

  async function install(id) {
    const c = typeof id === 'string' && SAFE_ID.test(id) ? find(id) : null;
    if (!c) return { ok: false, code: 'unknown_item' };
    if (busy.has(id)) return { ok: false, code: 'busy' };
    if (!c.download) return { ok: false, code: 'not_packaged' };
    const fresh = !bundled(id) && (!isInstalled(id) || installedVersion(id) !== c.version); // not here yet, or an Update
    if (fresh && c.download.releaseAsset) {
      const probe = await probePublished(c);
      if (!probe.yes) return { ok: false, code: probe.offline ? 'offline' : 'not_published' };
    }
    // In the installer already: only its model can still be missing.
    const inBuild = bundled(id);
    if (inBuild && !(c.modelBytes > 0 && model && !model.present())) return { ok: false, code: 'bundled' };
    if (fs.existsSync(pendingRemoval(id)) && !tryRemoveDir(id)) return { ok: false, code: 'restart_needed' };
    const say = (phase, loaded = 0, total = 0) => { const p = { id, phase, loaded, total }; busy.set(id, p); emit('market:progress', p); };
    const zip = path.join(packsDir, `${id}.zip`);
    const part = path.join(packsDir, `${id}.part`);
    const cleanup = () => { for (const p of [zip, part]) fs.rmSync(p, { recursive: true, force: true }); };
    say('download');
    try {
      if (fresh) {
        fs.mkdirSync(packsDir, { recursive: true });
        await download(c, zip, (loaded, total) => say('download', loaded, total));
        say('verify');
        const verdict = await validatePackZip(zip, part, { kind: c.kind, expectId: id, publisher: 'zumia', onProgress: (p) => say('verify', p.loaded, p.total) });
        if (!verdict.ok) { log(`[market] install id=${id} refused ${verdict.errors[0].code}`); throw coded('invalid_pack', verdict.errors[0].message); }
        // A store item: the manifest must be the very one the signed index lists (what the Rust host re-checks at load).
        const manifestSha256 = sha256(fs.readFileSync(path.join(part, MANIFEST_FILE)));
        if (c.download.manifestSha256 && manifestSha256 !== c.download.manifestSha256) { log(`[market] install id=${id} refused manifest_mismatch`); throw coded('invalid_pack', 'the manifest is not the one the store lists'); }
        if (model && c.modelBytes > 0 && isInstalled(id)) model.stop(); // an Update: the running voice holds the old pack's files
        fs.rmSync(packDir(id), { recursive: true, force: true });
        fs.renameSync(part, packDir(id));
        fs.rmSync(zip, { force: true });
        writeInstalled({ ...readInstalled(), [id]: { version: c.version, sha256: c.download.sha256, manifestSha256, at: new Date().toISOString() } });
        log(`[market] install id=${id} sha=ok`);
      }
      if (c.modelBytes > 0 && model && !model.present()) {
        say('model');
        if (!(await model.download((p) => say('model', p.loaded || 0, p.total || 0)))) return { ok: false, code: 'model_failed' };
      }
      return { ok: true };
    } catch (e) {
      cleanup();
      log(`[market] install id=${id} failed ${e.code || 'error'} ${e.detail || ''}`);
      return { ok: false, code: e.code || 'install_failed', detail: e.code === 'invalid_pack' ? e.detail : (e.detail || null) };
    } finally {
      busy.delete(id);
      emit('market:progress', { id, phase: 'done', loaded: 0, total: 0 });
    }
  }

  function remove(id) {
    const c = typeof id === 'string' && SAFE_ID.test(id) ? find(id) : null;
    if (!c) return { ok: false, code: 'unknown_item' };
    if (busy.has(id)) return { ok: false, code: 'busy' };
    if (bundled(id)) return { ok: false, code: 'bundled' };
    if (!isInstalled(id)) return { ok: false, code: 'not_installed' };
    if (model && c.modelBytes > 0) { model.stop(); model.remove(); }
    const gone = tryRemoveDir(id);
    // The painted default room is served from its validated copy (boot-reads.mjs): removing the pack removes that copy too,
    // so the room leaves the list instead of staying behind as a copy the user can no longer manage.
    if (c.activates === 'default-v2') fs.rmSync(path.join(dataDir, 'rooms', 'default-v2'), { recursive: true, force: true });
    const installed = readInstalled();
    delete installed[id];
    writeInstalled(installed);
    log(`[market] remove id=${id} ${gone ? 'done' : 'restart-pending'}`);
    return { ok: true, restartNeeded: !gone };
  }

  sweep();
  return { handlers: { 'market.list': list, 'market.install': install, 'market.remove': remove }, packDir, refreshStore: store ? refreshStore : null };
}
