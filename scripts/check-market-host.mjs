// check:market-host (T-31 Marketplace). The install path on a real zip through a fake server: progress, sha256, standard, swap, remove,
// the upgrade rule (a build with Kokoro in the installer never changes voice), and the egress guard. No network, no paid call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { packZip, sha256 } from './lib/zip-write.mjs';
import { CATALOG, createMarketHost } from '../tauri/sidecar/market-host.mjs';
import { MARKET_ORIGINS, marketFetch } from '../tauri/sidecar/egress.mjs';

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-market-host-'));
let n = 0;
const dataDir = () => { const d = path.join(root, `d${++n}`); fs.mkdirSync(d); return d; };

const RUNTIME = {
  'LICENSE.txt': 'Apache-2.0',
  'voice-modules/node_modules/kokoro-js/dist/kokoro.js': '//k',
  'voice-modules/node_modules/@huggingface/transformers/dist/transformers.node.mjs': '//t',
  'voice-modules/node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node': 'b',
};
const manifest = { format: 'zumi-pack/1', id: 'voice.kokoro-82m', kind: 'voice', version: '1.2.1', name: { en: 'Kokoro' }, author: { name: 'hexgrad' }, licence: { spdx: 'Apache-2.0', file: 'LICENSE.txt' }, platforms: ['win-x64'], voice: { engine: 'kokoro', langs: ['en'] } };
const goodZip = packZip(manifest, RUNTIME);
const catalogFor = (zip, over = {}) => [{ id: 'voice.kokoro-82m', kind: 'voice', version: '1.2.1', recommended: true, licence: 'Apache-2.0', author: 'hexgrad', langs: ['en'], platforms: ['win-x64'], bytes: 100, modelBytes: 100, download: { url: 'https://zumia.space/packs/k.zip', sha256: sha256(zip), bytes: zip.length }, ...over },
  { id: 'voice.vieneu-tts', kind: 'voice', version: '3.0.0', licence: 'Apache-2.0', author: 'x', langs: ['vi'], platforms: ['win-x64'], bytes: 1, modelBytes: 0, download: null }];
const serve = (bytes, status = 200) => async () => ({ ok: status === 200, status, body: new Blob([bytes]).stream() });
function fakeModel() { let here = false; return { present: () => here, calls: 0, download(cb) { this.calls++; cb({ loaded: 5, total: 10 }); here = true; return Promise.resolve(true); }, stops: 0, stop() { this.stops++; }, removed: 0, remove() { this.removed++; here = false; }, set(v) { here = v; } }; }

// ---------- install ----------
{
  const d = dataDir(); const m = fakeModel(); const events = [];
  const host = createMarketHost({ dataDir: d, catalog: catalogFor(goodZip), fetchImpl: serve(goodZip), emit: (c, p) => events.push([c, p]), model: m });
  const h = host.handlers;
  ok(h['market.list']().items[0].state === 'available', 'not installed: the item can be installed');
  const r = await h['market.install']('voice.kokoro-82m');
  ok(r.ok, 'install succeeds on a good package', JSON.stringify(r));
  ok(fs.existsSync(path.join(d, 'packs', 'voice.kokoro-82m', 'voice-modules', 'node_modules', 'kokoro-js', 'dist', 'kokoro.js')), 'the runtime lands in <data>/packs/<id>');
  ok(!fs.readdirSync(path.join(d, 'packs')).some((f) => /\.part$|\.zip$/.test(f)), 'no .part or .zip is left behind');
  ok(m.calls === 1 && m.present(), 'install also fetches the model');
  const phases = events.filter(([c]) => c === 'market:progress').map(([, p]) => p.phase);
  ok(['download', 'verify', 'model', 'done'].every((p) => phases.includes(p)), 'progress reports every phase', phases.join());
  const after = h['market.list']().items[0];
  ok(after.state === 'installed' && after.installedVersion === '1.2.1' && after.modelReady === true, 'the list says installed', JSON.stringify(after));
  ok(JSON.parse(fs.readFileSync(path.join(d, 'packs', 'installed.json'), 'utf8'))['voice.kokoro-82m'].sha256 === sha256(goodZip), 'installed.json records the sha');
  const removed = h['market.remove']('voice.kokoro-82m');
  ok(removed.ok && !removed.restartNeeded && !fs.existsSync(path.join(d, 'packs', 'voice.kokoro-82m')), 'remove deletes the pack', JSON.stringify(removed));
  ok(m.stops === 1 && m.removed === 1, 'remove unloads the voice and deletes the model');
  ok(h['market.list']().items[0].state === 'available', 'after remove it can be installed again');
  // The installed record survives a new host (an app restart or update).
  ok((await h['market.install']('voice.kokoro-82m')).ok, 'install again');
  const later = createMarketHost({ dataDir: d, catalog: catalogFor(goodZip), fetchImpl: serve(goodZip), model: m });
  ok(later.handlers['market.list']().items[0].state === 'installed', 'a restart still lists it installed');
}
// ---------- refusals: nothing goes live, nothing is left ----------
const refusal = async (title, code, zipOnServer, catalog, status) => {
  const d = dataDir(); const m = fakeModel();
  const host = createMarketHost({ dataDir: d, catalog, fetchImpl: serve(zipOnServer, status), model: m });
  const r = await host.handlers['market.install']('voice.kokoro-82m');
  const left = fs.existsSync(path.join(d, 'packs')) ? fs.readdirSync(path.join(d, 'packs')) : [];
  ok(!r.ok && r.code === code, `${title}: ${code}`, JSON.stringify(r));
  ok(left.length === 0, `${title}: nothing is left`, left.join());
  ok(m.calls === 0, `${title}: the model is not fetched`);
  ok(host.handlers['market.list']().items[0].state === 'available', `${title}: it can be tried again`);
};
await refusal('sha mismatch', 'sha_mismatch', Buffer.concat([goodZip.subarray(0, -1), Buffer.from([1])]), catalogFor(goodZip));
await refusal('longer than the pin', 'sha_mismatch', Buffer.concat([goodZip, Buffer.from('x')]), catalogFor(goodZip));
await refusal('not published yet', 'download_failed', goodZip, catalogFor(goodZip), 404);
{ const bad = packZip({ ...manifest, id: 'voice.other' }, RUNTIME); await refusal('the wrong package with a right hash', 'invalid_pack', bad, catalogFor(bad)); }
{ const bad = packZip(manifest, { ...RUNTIME, 'voice-modules/node_modules/kokoro-js/dist/kokoro.js': undefined }); await refusal('a damaged package with a right hash', 'invalid_pack', bad, catalogFor(bad)); }
{
  const d = dataDir();
  const net = createMarketHost({ dataDir: d, catalog: catalogFor(goodZip), fetchImpl: async () => { throw new Error('offline'); }, model: fakeModel() });
  const r = await net.handlers['market.install']('voice.kokoro-82m');
  ok(!r.ok && r.code === 'download_failed' && r.detail === 'network', 'offline: a plain failure', JSON.stringify(r));
}
{
  const m = fakeModel(); m.download = () => Promise.resolve(false);
  const host = createMarketHost({ dataDir: dataDir(), catalog: catalogFor(goodZip), fetchImpl: serve(goodZip), model: m });
  ok((await host.handlers['market.install']('voice.kokoro-82m')).code === 'model_failed', 'a model that fails is reported');
  ok(host.handlers['market.list']().items[0].modelReady === false, 'the runtime stays; the model can be retried');
}
// ---------- what cannot be installed says so ----------
{
  const host = createMarketHost({ dataDir: dataDir(), catalog: catalogFor(goodZip), fetchImpl: () => { throw new Error('must not fetch'); }, model: fakeModel() });
  const h = host.handlers;
  ok(h['market.list']().items[1].state === 'unpackaged', 'VieNeu is listed as not packaged');
  ok((await h['market.install']('voice.vieneu-tts')).code === 'not_packaged', 'installing it is refused without a download');
  ok((await h['market.install']('../../evil')).code === 'unknown_item', 'an id with a path is refused');
  ok((await h['market.install']('voice.nope')).code === 'unknown_item', 'an unknown id is refused');
  ok(h['market.remove']('voice.kokoro-82m').code === 'not_installed', 'removing what is not installed is refused');
}
// ---------- the owner build: Kokoro in the installer never changes ----------
{
  const d = dataDir(); const m = fakeModel(); m.set(true); let fetched = 0;
  const host = createMarketHost({ dataDir: d, catalog: catalogFor(goodZip), fetchImpl: async () => { fetched++; return serve(goodZip)(); }, bundled: () => true, model: m });
  const h = host.handlers;
  ok(h['market.list']().items[0].state === 'bundled', 'owner build: Kokoro reads as in the installer');
  ok((await h['market.install']('voice.kokoro-82m')).code === 'bundled' && fetched === 0, 'owner build: nothing to install, nothing fetched');
  ok(h['market.remove']('voice.kokoro-82m').code === 'bundled' && m.removed === 0 && m.present(), 'owner build: it cannot be removed, the model stays');
  m.set(false);
  ok((await h['market.install']('voice.kokoro-82m')).ok && m.calls === 1 && fetched === 0, 'owner build, model missing: only the model downloads');
}
// ---------- a remove blocked by a locked DLL finishes on the next start ----------
{
  const d = dataDir(); const m = fakeModel();
  const host = createMarketHost({ dataDir: d, catalog: catalogFor(goodZip), fetchImpl: serve(goodZip), model: m });
  await host.handlers['market.install']('voice.kokoro-82m');
  const rm = fs.rmSync; const pack = path.join(d, 'packs', 'voice.kokoro-82m');
  fs.rmSync = (p, o) => { if (p === pack) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return rm(p, o); };
  const r = host.handlers['market.remove']('voice.kokoro-82m');
  fs.rmSync = rm;
  ok(r.ok && r.restartNeeded === true, 'a locked DLL: remove reports restart needed', JSON.stringify(r));
  ok(host.handlers['market.list']().items[0].state === 'restart', 'the list says restart');
  ok(fs.existsSync(pack) && fs.existsSync(`${pack}.remove-pending`), 'the marker holds the remove');
  const next = createMarketHost({ dataDir: d, catalog: catalogFor(goodZip), fetchImpl: serve(goodZip), model: m });
  ok(!fs.existsSync(pack) && !fs.existsSync(`${pack}.remove-pending`), 'the next start finishes it');
  ok(next.handlers['market.list']().items[0].state === 'available', 'and it can be installed again');
}
// ---------- leftovers from a crash are swept ----------
{
  const d = dataDir(); fs.mkdirSync(path.join(d, 'packs', 'voice.kokoro-82m.part'), { recursive: true }); fs.writeFileSync(path.join(d, 'packs', 'voice.kokoro-82m.zip'), 'x');
  createMarketHost({ dataDir: d, catalog: catalogFor(goodZip), fetchImpl: serve(goodZip), model: fakeModel() });
  ok(fs.readdirSync(path.join(d, 'packs')).length === 0, 'a crash mid-install leaves nothing after the next start');
}
// ---------- egress ----------
{
  ok(MARKET_ORIGINS.length === 2 && MARKET_ORIGINS[0] === 'https://github.com', 'the Marketplace reaches GitHub and its asset host');
  const seen = []; const guarded = marketFetch(async (u, i) => { seen.push([u, i && i.redirect]); return { status: 200, ok: true }; });
  await guarded('https://github.com/x/k.zip');
  ok(seen.length === 1, 'the origin is allowed');
  for (const url of ['https://evil.example/k.zip', 'http://github.com/k.zip', 'https://github.com.evil.example/k.zip', 'https://user:pw@github.com/k.zip', 'https://zumia.space/packs/k.zip']) {
    let refused = false; try { await guarded(url); } catch { refused = true; }
    ok(refused, `refused: ${url}`);
  }
  ok(seen.length === 1, 'nothing else reached the network');
}
// ---------- the shipped catalog ----------
{
  const kokoro = CATALOG.find((c) => c.id === 'voice.kokoro-82m'); const vieneu = CATALOG.find((c) => c.id === 'voice.vieneu-tts');
  ok(/^[0-9a-f]{64}$/.test(kokoro.download.sha256) && kokoro.download.bytes > 1e6, 'the Kokoro pack is pinned by sha256 and size');
  ok(new URL(kokoro.download.url).origin === MARKET_ORIGINS[0], 'the Kokoro pack comes from the Marketplace origin');
  ok(vieneu && vieneu.download === null, 'VieNeu is listed with no download until a package exists');
  ok(CATALOG.every((c) => c.licence && c.author), 'every item names a licence and an author');
  ok(!CATALOG.some((c) => 'price' in c || 'seller' in c), 'no paid item, no seller');
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`check:market-host: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
