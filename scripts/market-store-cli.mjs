// The owner's local store, by hand (ADR 2026-11-11-pack-system). Phase 4 moves install/update/rollback into the app;
// until then this is how a pack reaches a data folder, through the same signed-index rules the app re-checks at load.
//   node scripts/market-store-cli.mjs publish --store <dir> --key <store.key> [--meta <meta.json>] [--serial-min <n>] <pack.zip>   (validate, add version, serial+1, sign)
//     --serial-min: the new serial is at least n (a fresh store starting above an older index the same key signed; apps refuse a lower serial).
//     --meta: the store facts the app shows and acts on (author, bytes, recommended, langs, platforms, needs, modelBytes, activates);
//     they live in the signed index, so they are as trusted as the pins. market-pack-rooms.mjs writes one beside each room zip.
//   node scripts/market-store-cli.mjs install --store <dir> --data <dataDir> <id>          (verify index, pick, pin, validate, swap)
//   node scripts/market-store-cli.mjs remove  --data <dataDir> <id>                         (pack folder only; plugin-data is kept)
//   node scripts/market-store-cli.mjs show    --store <dir>
// Prints ids, versions, serials and verdicts; never key material.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePublicKey, signMinisign } from '../tauri/sidecar/market-sign.mjs';
import { validatePackZip } from '../tauri/sidecar/market-standard.mjs';
import { INDEX_FORMAT, checkDownload, pickVersion, verifyIndex } from '../tauri/sidecar/market-store.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
const die = (m, code = 2) => { console.error(`market-store: ${m}`); process.exit(code); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const KEYS = ['store.pub', 'spare.pub'].map((f) => parsePublicKey(fs.readFileSync(path.join(repo, 'tauri', 'market-keys', f), 'utf8')));

function readStore(store) {
  const bytes = fs.readFileSync(path.join(store, 'index.json'));
  const sig = fs.readFileSync(path.join(store, 'index.json.minisig'), 'utf8');
  return { bytes, sig };
}

if (cmd === 'publish') {
  const store = opt('store'), keyFile = opt('key'), zip = positional[0];
  if (!store || !keyFile || !zip) die('usage: publish --store <dir> --key <store.key> [--meta <meta.json>] [--serial-min <n>] <pack.zip>');
  const serialMin = opt('serial-min') === undefined ? 1 : Number(opt('serial-min'));
  if (!Number.isInteger(serialMin) || serialMin < 1) die('--serial-min must be a whole number of 1 or more');
  const META_KEYS = ['author', 'bytes', 'recommended', 'langs', 'platforms', 'needs', 'modelBytes', 'activates', 'desc'];
  const meta = opt('meta') ? JSON.parse(fs.readFileSync(opt('meta'), 'utf8')) : null;
  if (meta && Object.keys(meta).some((k) => !META_KEYS.includes(k))) die(`--meta may hold only ${META_KEYS.join(', ')}`);
  fs.mkdirSync(store, { recursive: true });
  const tmp = path.join(store, '.validate');
  const v = await validatePackZip(zip, tmp, {});
  if (!v.ok) die(`the pack does not pass the standard: ${JSON.stringify(v.errors)}`, 1);
  const m = v.manifest;
  const manifestSha256 = sha(fs.readFileSync(path.join(tmp, 'zumi-pack.json')));
  fs.rmSync(tmp, { recursive: true, force: true });
  let index = { format: INDEX_FORMAT, serial: 0, published: '', packs: [] };
  if (fs.existsSync(path.join(store, 'index.json'))) {
    const { bytes, sig } = readStore(store);
    const r = verifyIndex(bytes, sig, { publicKeys: KEYS });
    if (!r.ok) die(`the store's current index does not verify: ${r.code}`, 1);
    index = r.index;
  }
  const zipBytes = fs.readFileSync(zip);
  const file = `${m.id}-${m.version}.zip`;
  let pack = index.packs.find((p) => p.id === m.id);
  if (!pack) { pack = { id: m.id, kind: m.kind, name: m.name, licence: (m.licence || {}).spdx, versions: [], withdrawn: [] }; index.packs.push(pack); }
  if (meta) pack.meta = meta; // the newest publish states the facts
  if (pack.versions.some((x) => x.version === m.version)) die(`${m.id} ${m.version} is already published; versions only grow`, 1);
  const section = m[m.kind] || {};
  pack.versions.unshift({ version: m.version, api: Number.isInteger(section.api) ? section.api : 1, url: file, sha256: sha(zipBytes), bytes: zipBytes.length, manifestSha256 });
  index.serial = Math.max(index.serial + 1, serialMin);
  index.published = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  fs.copyFileSync(zip, path.join(store, file));
  const bytes = Buffer.from(`${JSON.stringify(index, null, 1)}\n`);
  const k = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const sig = signMinisign(bytes, { keyNum: Buffer.from(k.keyNum, 'hex'), privatePem: k.privatePem }, { trusted: `zumi-market index serial ${index.serial}` });
  fs.writeFileSync(path.join(store, 'index.json'), bytes);
  fs.writeFileSync(path.join(store, 'index.json.minisig'), sig);
  console.log(`published ${m.id} ${m.version} (${zipBytes.length} bytes) -> serial ${index.serial}, signed by ${k.keyId}`);
} else if (cmd === 'install') {
  const store = opt('store'), data = opt('data'), id = positional[0];
  if (!store || !data || !id) die('usage: install --store <dir> --data <dataDir> <id>');
  const market = path.join(data, 'market');
  let cachedSerial = 0;
  try { cachedSerial = JSON.parse(fs.readFileSync(path.join(market, 'index.json'), 'utf8')).serial || 0; } catch { /* first install */ }
  const { bytes, sig } = readStore(store);
  const r = verifyIndex(bytes, sig, { publicKeys: KEYS, cachedSerial });
  if (!r.ok) die(`index refused [${r.code}] ${r.message}`, 1);
  const pack = r.index.packs.find((p) => p.id === id);
  if (!pack) die(`${id} is not in the store`, 1);
  const pick = pickVersion(pack);
  if (!pick.ok) die(`${id}: [${pick.code}] ${pick.message}`, 1);
  const zip = path.join(store, path.basename(pick.version.url));
  const d = await checkDownload(zip, pick.version);
  if (!d.ok) die(`${id}: [${d.code}] ${d.message}`, 1);
  const packs = path.join(data, 'packs');
  fs.mkdirSync(packs, { recursive: true });
  const part = path.join(packs, `${id}.part`);
  const v = await validatePackZip(zip, part, { kind: pack.kind, expectId: id });
  if (!v.ok) die(`${id}: the pack fails the standard ${JSON.stringify(v.errors)}`, 1);
  if (sha(fs.readFileSync(path.join(part, 'zumi-pack.json'))) !== pick.version.manifestSha256) { fs.rmSync(part, { recursive: true, force: true }); die(`${id}: manifest is not the listed one`, 1); }
  const dest = path.join(packs, id), prev = path.join(packs, `${id}.prev`);
  if (fs.existsSync(dest)) { fs.rmSync(prev, { recursive: true, force: true }); fs.renameSync(dest, prev); }
  fs.renameSync(part, dest);
  fs.mkdirSync(market, { recursive: true });
  fs.writeFileSync(path.join(market, 'index.json'), bytes);
  fs.writeFileSync(path.join(market, 'index.json.minisig'), sig);
  console.log(`installed ${id} ${pick.version.version} from serial ${r.index.serial} (signed by ${r.keyId}) into ${dest}`);
} else if (cmd === 'remove') {
  const data = opt('data'), id = positional[0];
  if (!data || !id || !/^[a-z]+\.[a-z0-9-]+$/.test(id)) die('usage: remove --data <dataDir> <id>');
  const dest = path.join(data, 'packs', id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(`${dest}.prev`, { recursive: true, force: true });
  console.log(`removed ${id}; ${fs.existsSync(path.join(data, 'plugin-data', id)) ? 'its data folder is kept' : 'it had no data folder'}`);
} else if (cmd === 'show') {
  const { bytes, sig } = readStore(opt('store'));
  const r = verifyIndex(bytes, sig, { publicKeys: KEYS });
  if (!r.ok) die(`index refused [${r.code}]`, 1);
  console.log(`serial ${r.index.serial}, signed by ${r.keyId}`);
  for (const p of r.index.packs) console.log(`  ${p.id}: ${p.versions.map((x) => `${x.version} (api ${x.api}, ${x.bytes} B)`).join(', ')}${p.withdrawn && p.withdrawn.length ? `; withdrawn ${p.withdrawn.join(', ')}` : ''}`);
} else die('commands: publish, install, remove, show');
