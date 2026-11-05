// Marketplace packages are plain zip files. This reads one and extracts it, refusing anything a package has no business
// holding: paths that leave the folder, links, encryption, zip64, more bytes than it declares. Node only, no dependency,
// so the check a later upload runs is this same code. Every refusal throws { code, message }.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 20_000;
const MAX_PATH = 200; // relative; keeps <data>/packs/<id>/<path> under the Windows limit
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

export const refuse = (code, message) => Object.assign(new Error(message), { code });

/** A package-relative path, or the reason it is unsafe. Forward slashes only; no `..`, drive, colon, or reserved name. */
export function unsafePathReason(name) {
  if (typeof name !== 'string' || !name || name.length > MAX_PATH) return 'path is empty or too long';
  if (name.includes('\\') || name.includes('\0') || name.includes(':')) return 'path holds a backslash, colon or NUL';
  if (name.startsWith('/')) return 'path is absolute';
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'path leaves the package folder';
  if (parts.some((p) => WINDOWS_RESERVED.test(p) || /[. ]$/.test(p))) return 'path is not a valid Windows name';
  return null;
}

/** Central directory of a zip file. @returns {{ name, method, compressed, size, offset, dir }[]} */
export function readZipEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const tailSize = Math.min(fileSize, 22 + 0xffff);
    if (tailSize < 22) throw refuse('zip_invalid', 'not a zip file');
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, fileSize - tailSize);
    let at = -1;
    for (let i = tailSize - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { at = i; break; }
    if (at < 0) throw refuse('zip_invalid', 'not a zip file (no end record)');
    const count = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOffset = tail.readUInt32LE(at + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw refuse('zip_unsupported', 'zip64 packages are not accepted');
    if (count > MAX_ENTRIES) throw refuse('zip_too_many', `more than ${MAX_ENTRIES} files`);
    if (cdOffset + cdSize > fileSize) throw refuse('zip_invalid', 'central directory is outside the file');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const out = [];
    const seen = new Set();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cdSize || cd.readUInt32LE(p) !== CENTRAL) throw refuse('zip_invalid', 'bad central directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compressed = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const attrs = cd.readUInt32LE(p + 38);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & 1) throw refuse('zip_encrypted', `encrypted file: ${name}`);
      if (size === 0xffffffff || compressed === 0xffffffff || offset === 0xffffffff) throw refuse('zip_unsupported', 'zip64 packages are not accepted');
      if (method !== 0 && method !== 8) throw refuse('zip_unsupported', `unsupported compression on ${name}`);
      const reason = unsafePathReason(name);
      if (reason) throw refuse('zip_unsafe_path', `${name}: ${reason}`);
      if (madeBy === 3 && ((attrs >>> 16) & 0o170000) === 0o120000) throw refuse('zip_symlink', `link in package: ${name}`);
      if (attrs & 0x400) throw refuse('zip_symlink', `link in package: ${name}`); // FILE_ATTRIBUTE_REPARSE_POINT
      const fold = name.toLowerCase();
      if (seen.has(fold)) throw refuse('zip_duplicate', `listed twice: ${name}`);
      seen.add(fold);
      out.push({ name, method, compressed, size, offset, dir: name.endsWith('/') });
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

// Stops an entry that inflates past what the central directory declared (a zip bomb lies here).
function capped(limit, name) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, done) {
      seen += chunk.length;
      if (seen > limit) done(refuse('zip_size_lie', `${name} is larger than it declares`));
      else done(null, chunk);
    },
  });
}

/**
 * Extract into `destDir`, which must not exist yet. The caller removes it on failure.
 * @param {number} maxBytes the kind's limit on the unpacked total, checked against the declared sizes BEFORE any write.
 */
export async function extractZip(zipPath, destDir, { maxBytes, onProgress = () => {} }) {
  const entries = readZipEntries(zipPath);
  const total = entries.reduce((n, e) => n + e.size, 0);
  if (total > maxBytes) throw refuse('pack_too_large', `unpacks to ${total} bytes, the limit is ${maxBytes}`);
  fs.mkdirSync(destDir, { recursive: true });
  const fd = fs.openSync(zipPath, 'r');
  let done = 0;
  try {
    for (const e of entries) {
      const dest = path.join(destDir, ...e.name.replace(/\/$/, '').split('/'));
      if (e.dir) { fs.mkdirSync(dest, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const head = Buffer.alloc(30);
      fs.readSync(fd, head, 0, 30, e.offset);
      if (head.readUInt32LE(0) !== LOCAL) throw refuse('zip_invalid', `bad local header: ${e.name}`);
      const dataStart = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      const counter = capped(e.size, e.name);
      const raw = fs.createReadStream(zipPath, e.compressed ? { start: dataStart, end: dataStart + e.compressed - 1 } : { start: dataStart, end: dataStart });
      const out = fs.createWriteStream(dest);
      if (e.size === 0 && e.compressed === 0) { raw.destroy(); out.end(); await new Promise((r) => out.on('close', r)); continue; }
      if (e.method === 8) await pipeline(raw, zlib.createInflateRaw(), counter, out);
      else await pipeline(raw, counter, out);
      if (fs.statSync(dest).size !== e.size) throw refuse('zip_size_lie', `${e.name} is smaller than it declares`);
      done += e.size;
      onProgress({ loaded: done, total });
    }
  } finally {
    fs.closeSync(fd);
  }
  return { files: entries.filter((e) => !e.dir).length, bytes: total };
}
