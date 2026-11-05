// The Marketplace in the app. v1: free items packaged by Zumia, listed from a catalog compiled into the app with every
// download pinned by sha256 (owner Q4; a remote catalog comes when third parties do). Rooms and models are not packages yet:
// the renderer lists the ones on disk through scenes.list / listModels. Voice packs are what installs today.
//
// A package lands at <data>/packs/<id>/, which an app update never touches. Trust: https to the fixed origins, one redirect hop
// checked by the same guard (egress.mjs marketFetch); bytes and sha256 from the catalog, then the package standard (market-standard.mjs), all
// before anything goes live. The swap from <id>.part is one rename.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { validatePackZip } from './market-standard.mjs';

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

/**
 * @param {{ dataDir: string, catalog?: object[], fetchImpl: Function, emit: Function, bundled: (id: string) => boolean,
 *           model: () => { present: () => boolean, download: (onProgress: Function) => Promise<boolean>, remove: () => void, stop: () => void },
 *           log?: Function }} o
 */
export function createMarketHost({ dataDir, catalog = CATALOG, fetchImpl, emit = () => false, bundled = () => false, model, log = () => {} }) {
  const packsDir = path.join(dataDir, 'packs');
  const installedFile = path.join(packsDir, 'installed.json');
  const busy = new Map(); // id -> last progress
  const published = new Map(); // id -> { yes, at }, for a download marked releaseAsset
  const packDir = (id) => path.join(packsDir, id);
  const pendingRemoval = (id) => path.join(packsDir, `${id}.remove-pending`);
  const find = (id) => catalog.find((c) => c.id === id) || null;

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

  function list() {
    const installed = readInstalled();
    return {
      platform: process.platform === 'win32' ? 'win-x64' : process.platform,
      items: catalog.map((c) => {
        const { download, ...rest } = c;
        return {
          ...rest,
          state: itemState(c),
          source: download ? new URL(download.url).host : null,
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
    const ctl = new AbortController();
    let stall = setTimeout(() => ctl.abort(), STALL_MS);
    const out = fs.openSync(zipPath, 'w');
    const hash = crypto.createHash('sha256');
    let got = 0;
    try {
      let res;
      try {
        res = await fetchImpl(c.download.url, { signal: ctl.signal });
        const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
        if (next) res = await fetchImpl(next, { signal: ctl.signal }); // one hop; a second redirect fails below as not ok
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
        if (model && c.modelBytes > 0 && isInstalled(id)) model.stop(); // an Update: the running voice holds the old pack's files
        fs.rmSync(packDir(id), { recursive: true, force: true });
        fs.renameSync(part, packDir(id));
        fs.rmSync(zip, { force: true });
        writeInstalled({ ...readInstalled(), [id]: { version: c.version, sha256: c.download.sha256, at: new Date().toISOString() } });
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
    const installed = readInstalled();
    delete installed[id];
    writeInstalled(installed);
    log(`[market] remove id=${id} ${gone ? 'done' : 'restart-pending'}`);
    return { ok: true, restartNeeded: !gone };
  }

  sweep();
  return { handlers: { 'market.list': list, 'market.install': install, 'market.remove': remove }, packDir };
}
