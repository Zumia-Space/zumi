// Rewrites ONLY the author field of a .vrm (GLB) into a NEW file. T-31: the bundled default avatar's meta author becomes
// the company name. Licence/permission fields (VRM1 licenseUrl, avatarPermission, commercialUsage, modification, ...; VRM0
// licenseName, otherPermissionUrl, ...) are never touched. Every byte after the JSON chunk (BIN + any other chunk) is copied
// verbatim; the JSON chunk is re-padded with spaces to a 4-byte boundary and the GLB/chunk lengths are rewritten.
//   VRM 1.0: extensions.VRMC_vrm.meta.authors = [author]      VRM 0.x: extensions.VRM.meta.author = author
// Optional 4th arg (T-31 0.2.8, anh 7779): also sets VRM 1.0 meta.thirdPartyLicenses (the credit text); nothing else changes.
// T-31 alpha.4 (anh 30-10): --commercial-usage sets ONLY VRM 1.0 meta.commercialUsage, the one licence field this tool
// may change, and only on an explicit owner ruling.
// Usage: node scripts/tools/set-vrm-author.mjs <in.vrm> <out.vrm> "<author>" ["<thirdPartyLicenses>"]   (refuses out === in; never edits in place)
//        node scripts/tools/set-vrm-author.mjs --commercial-usage <in.vrm> <out.vrm> <personalNonProfit|personalProfit|corporation>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a; // 'JSON'

// VRM 1.0 meta.commercialUsage values (https://vrm.dev/en/licenses/1.0/).
const COMMERCIAL_USAGE = Object.freeze(['personalNonProfit', 'personalProfit', 'corporation']);

/** Parses the GLB header and JSON chunk; throws on anything that is not a single-JSON-chunk GLB 2.0. */
function readGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== MAGIC) throw new Error('not a GLB (bad magic)');
  if (buf.readUInt32LE(4) !== 2) throw new Error('unsupported GLB version');
  if (buf.readUInt32LE(8) !== buf.length) throw new Error(`GLB length header ${buf.readUInt32LE(8)} != file size ${buf.length}`);
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== JSON_CHUNK || 20 + jsonLen > buf.length) throw new Error('first chunk is not a valid JSON chunk');
  return { gltf: JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)), rest: buf.subarray(20 + jsonLen) }; // rest: BIN and anything after
}

/** A new GLB from the edited glTF JSON and the untouched bytes after the JSON chunk. */
function writeGlb(gltf, rest) {
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + json.length + rest.length, 8);
  head.writeUInt32LE(json.length, 12);
  head.writeUInt32LE(JSON_CHUNK, 16);
  return Buffer.concat([head, json, rest]);
}

/** Sets VRM 1.0 meta.commercialUsage only. Returns { out, vrm: '1', before } or throws (unknown value, VRM 0.x, no meta, bad GLB). */
export function setVrmCommercialUsage(buf, value) {
  if (!COMMERCIAL_USAGE.includes(value)) throw new Error(`commercialUsage must be one of ${COMMERCIAL_USAGE.join(', ')}`);
  const { gltf, rest } = readGlb(buf);
  const meta = gltf.extensions && gltf.extensions.VRMC_vrm && gltf.extensions.VRMC_vrm.meta;
  if (!meta) throw new Error('commercialUsage is a VRM 1.0 field; this file has no extensions.VRMC_vrm.meta');
  const before = meta.commercialUsage;
  meta.commercialUsage = value; // an existing key keeps its place, so the JSON differs only in this value
  return { out: writeGlb(gltf, rest), vrm: '1', before };
}

// Returns { out: Buffer, vrm: '0'|'1', before } or throws. `before` is the replaced author value.
export function setVrmAuthor(buf, author, thirdPartyLicenses) {
  if (typeof author !== 'string' || !author.trim()) throw new Error('author must be a non-empty string');
  if (thirdPartyLicenses !== undefined && (typeof thirdPartyLicenses !== 'string' || !thirdPartyLicenses.trim())) throw new Error('thirdPartyLicenses must be a non-empty string');
  const { gltf, rest } = readGlb(buf);
  const ext = gltf.extensions || {};
  let vrm, before;
  if (ext.VRMC_vrm && ext.VRMC_vrm.meta) {
    vrm = '1';
    before = ext.VRMC_vrm.meta.authors;
    ext.VRMC_vrm.meta.authors = [author];
    if (thirdPartyLicenses !== undefined) ext.VRMC_vrm.meta.thirdPartyLicenses = thirdPartyLicenses;
  } else if (ext.VRM && ext.VRM.meta) {
    vrm = '0';
    if (thirdPartyLicenses !== undefined) throw new Error('thirdPartyLicenses is a VRM 1.0 field; this file is VRM 0.x');
    before = ext.VRM.meta.author;
    ext.VRM.meta.author = author;
  } else {
    throw new Error('no VRM meta found (neither extensions.VRMC_vrm.meta nor extensions.VRM.meta)');
  }
  return { out: writeGlb(gltf, rest), vrm, before };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--commercial-usage') {
  const [, , , inFile, outFile, value] = process.argv;
  if (!inFile || !outFile || !value) { console.error('usage: node set-vrm-author.mjs --commercial-usage <in.vrm> <out.vrm> <personalNonProfit|personalProfit|corporation>'); process.exit(2); }
  if (path.resolve(inFile) === path.resolve(outFile)) { console.error('refusing to overwrite the input in place'); process.exit(2); }
  if (fs.existsSync(outFile)) { console.error(`refusing to overwrite existing ${outFile}`); process.exit(2); }
  const { out, before } = setVrmCommercialUsage(fs.readFileSync(inFile), value);
  fs.writeFileSync(outFile, out);
  console.log(`VRM1 commercialUsage ${JSON.stringify(before)} -> ${JSON.stringify(value)}; wrote ${outFile} (${out.length} bytes)`);
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , inFile, outFile, author, thirdPartyLicenses] = process.argv;
  if (!inFile || !outFile || !author) { console.error('usage: node set-vrm-author.mjs <in.vrm> <out.vrm> "<author>" ["<thirdPartyLicenses>"]'); process.exit(2); }
  if (path.resolve(inFile) === path.resolve(outFile)) { console.error('refusing to overwrite the input in place'); process.exit(2); }
  if (fs.existsSync(outFile)) { console.error(`refusing to overwrite existing ${outFile}`); process.exit(2); }
  const { out, vrm, before } = setVrmAuthor(fs.readFileSync(inFile), author, thirdPartyLicenses);
  fs.writeFileSync(outFile, out);
  console.log(`VRM${vrm} author ${JSON.stringify(before)} -> ${JSON.stringify(author)}${thirdPartyLicenses === undefined ? '' : '; thirdPartyLicenses set'}; wrote ${outFile} (${out.length} bytes)`);
}
