// Writes a deterministic zip: entries sorted, fixed timestamp, deflate level 9. The same input gives the same bytes, so a pack's
// sha256 can be pinned in the app's catalog and a rebuild proves it. Build tool and test fixture only; the app only reads zips.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

/** @param {{ name: string, data?: Buffer, attrs?: number, madeBy?: number, stored?: boolean, rawSize?: number }[]} entries */
export function zipBuffer(entries) {
  const parts = []; const central = []; let offset = 0;
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const name = Buffer.from(e.name, 'utf8'); const raw = e.data || Buffer.alloc(0);
    const data = e.stored ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const method = e.stored ? 0 : 8; const crc = crc32(raw); const size = e.rawSize === undefined ? raw.length : e.rawSize;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x5a21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(((e.madeBy || 0) << 8) | 20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x5a21, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(size, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(e.attrs || 0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A package zip from { path: Buffer|string }: fills in `files` with each file's sha256 and bytes, as the standard asks. */
export function packZip(manifest, files) {
  const entries = Object.entries(files).filter(([, v]) => v !== undefined).map(([name, v]) => ({ name, data: Buffer.isBuffer(v) ? v : Buffer.from(String(v)) }));
  const full = { files: entries.map((e) => ({ path: e.name, sha256: sha256(e.data), bytes: e.data.length })), ...manifest };
  return zipBuffer([{ name: 'zumi-pack.json', data: Buffer.from(JSON.stringify(full, null, 1)) }, ...entries]);
}

export function writeFileEnsured(p, buf) { fs.writeFileSync(p, buf); return { bytes: buf.length, sha256: sha256(buf) }; }
