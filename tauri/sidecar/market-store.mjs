// The Marketplace store client's rules (ADR 2026-11-11-pack-system): the signed index, its serial, version pick by host api,
// download pinning and the load verdict. Pure functions over bytes and objects, so the Rust port has one contract to match.
// Every refusal is a code word plus a message; nothing here throws for a bad index or zip.
import crypto from 'node:crypto';
import fs from 'node:fs';

import { verifyMinisign } from './market-sign.mjs';

export const INDEX_FORMAT = 'zumi-market/1';

/** kind -> [lowest, highest] api major this host supports. A pack outside the range is refused at install and at load. */
export const HOST_API = Object.freeze({
  voice: [1, 1], room: [1, 1], model: [1, 1], skill: [1, 1], soul: [1, 1], plugin: [1, 1], agent: [1, 1], scene: [1, 1],
});

/** Packs made before `api` existed (the Kokoro voice pack) count as api 1. Web-app and scene packs must state it. */
export const API_REQUIRED = Object.freeze(['plugin', 'scene']);

/** @returns {null | { code: string, message: string }} */
export function apiVerdict(kind, api, hostApi = HOST_API) {
  const range = hostApi[kind];
  if (!range) return { code: 'manifest_kind', message: `this host has no ${kind} support` };
  if (!Number.isInteger(api)) return { code: 'manifest_api', message: `${kind}.api must be a whole number` };
  if (api > range[1]) return { code: 'pack_needs_newer_host', message: `${kind} api ${api} needs a newer Zumi (this one has ${range[1]})` };
  if (api < range[0]) return { code: 'pack_api_retired', message: `${kind} api ${api} is no longer supported (lowest ${range[0]})` };
  return null;
}

const no = (code, message) => ({ ok: false, code, message });
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const SHA = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function semverCmp(a, b) {
  const pa = a.split(/[.-]/), pb = b.split(/[.-]/);
  for (let i = 0; i < 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d; }
  // A pre-release sorts before its release.
  if (pa.length !== pb.length) return pa.length > 3 && pb.length === 3 ? -1 : pa.length === 3 && pb.length > 3 ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

function shapeError(ix) {
  if (!isObj(ix) || ix.format !== INDEX_FORMAT) return `format must be "${INDEX_FORMAT}"`;
  if (!Number.isInteger(ix.serial) || ix.serial < 0) return 'serial must be a whole number';
  if (!Array.isArray(ix.packs)) return 'packs must be a list';
  for (const p of ix.packs) {
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.kind !== 'string' || !Array.isArray(p.versions)) return 'each pack needs id, kind and versions';
    if (p.withdrawn !== undefined && !Array.isArray(p.withdrawn)) return `${p.id}: withdrawn must be a list`;
    for (const v of p.versions) {
      if (!isObj(v) || !VERSION.test(v.version || '') || !Number.isInteger(v.api) || typeof v.url !== 'string' || !SHA.test(v.sha256 || '') || !Number.isInteger(v.bytes) || !SHA.test(v.manifestSha256 || '')) {
        return `${p.id}: each version needs version, api, url, sha256, bytes and manifestSha256`;
      }
    }
  }
  return null;
}

/**
 * Verify a fetched index: signature by a trusted key, then shape, then serial (never lower than the cached one).
 * @returns {{ ok: true, index: object, keyId: string } | { ok: false, code: 'index_signature'|'index_format'|'index_serial', message: string }}
 */
export function verifyIndex(indexBytes, sigText, { publicKeys, cachedSerial = 0 }) {
  const sig = verifyMinisign(indexBytes, sigText, publicKeys);
  if (!sig.ok) return no('index_signature', `index signature refused: ${sig.code} (${sig.message})`);
  let index;
  try { index = JSON.parse(Buffer.from(indexBytes).toString('utf8')); } catch { return no('index_format', 'the index is not JSON'); }
  const bad = shapeError(index);
  if (bad) return no('index_format', `index: ${bad}`);
  if (index.serial < cachedSerial) return no('index_serial', `index serial ${index.serial} is lower than the cached ${cachedSerial}: an old index was replayed`);
  return { ok: true, index, keyId: sig.keyId };
}

/** The newest listed, not withdrawn version whose api this host supports. */
export function pickVersion(pack, hostApi = HOST_API) {
  const withdrawn = new Set(pack.withdrawn || []);
  const live = pack.versions.filter((v) => !withdrawn.has(v.version)).sort((a, b) => semverCmp(b.version, a.version));
  if (!live.length) return no('pack_withdrawn', `${pack.id}: every version is withdrawn`);
  const fits = live.find((v) => !apiVerdict(pack.kind, v.api, hostApi));
  if (fits) return { ok: true, version: fits };
  const why = apiVerdict(pack.kind, live[0].api, hostApi);
  return no(why.code, `${pack.id}: ${why.message}`);
}

/** A downloaded zip against its index entry: bytes first (cheap), then sha256. */
export async function checkDownload(zipPath, version) {
  const size = fs.statSync(zipPath).size;
  if (size !== version.bytes) return no('zip_bytes', `the download is ${size} bytes, the index says ${version.bytes}`);
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(zipPath).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject));
  const got = h.digest('hex');
  if (got !== version.sha256) return no('zip_sha', 'the download does not match the sha256 in the signed index');
  return { ok: true };
}

/** May an installed pack load? It must be listed, not withdrawn, within the host api, with the listed manifest hash. */
export function loadVerdict(index, installed, hostApi = HOST_API) {
  const pack = index.packs.find((p) => p.id === installed.id);
  if (!pack) return no('pack_not_listed', `${installed.id} is no longer in the store index`);
  if ((pack.withdrawn || []).includes(installed.version)) return no('pack_withdrawn', `${installed.id} ${installed.version} was withdrawn`);
  const v = pack.versions.find((x) => x.version === installed.version);
  if (!v) return no('pack_not_listed', `${installed.id} ${installed.version} is not in the store index`);
  const why = apiVerdict(pack.kind, v.api, hostApi);
  if (why) return no(why.code, `${installed.id}: ${why.message}`);
  if (v.manifestSha256 !== installed.manifestSha256) return no('manifest_mismatch', `${installed.id}: the installed manifest is not the one the index lists`);
  return { ok: true, version: v };
}
