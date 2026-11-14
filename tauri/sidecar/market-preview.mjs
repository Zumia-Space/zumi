// A store item's preview picture (T-31-mkt-previews, PLAN 14-11 option A): `pack.meta.preview = { file, sha256, bytes, w, h }` in the
// signed index, so the minisign signature pins the file. One rule set for the store CLI (before signing) and the app (before showing).
// The file reaches the page only as a data: URI (CSP img-src 'self' data: blob:). Pure functions; nothing here throws for bad input.
import crypto from 'node:crypto';

export const PREVIEW_MAX_BYTES = 64 * 1024;
/** What the store publishes: 16:9 at 480x270. The app only requires the file to be the size its pin states. */
export const PREVIEW_SIZE = Object.freeze({ w: 480, h: 270 });
const MIME = Object.freeze({ webp: 'image/webp', png: 'image/png', jpeg: 'image/jpeg' });
const EXT = Object.freeze({ webp: 'webp', png: 'png', jpg: 'jpeg', jpeg: 'jpeg' });
// Store-relative, one name, no path: it is resolved against the store base like a zip's url.
const FILE = /^[a-z0-9][a-z0-9.-]*\.(webp|png|jpe?g)$/;
const SHA = /^[0-9a-f]{64}$/;
const dim = (n) => Number.isInteger(n) && n > 0 && n <= 4096;

/** The pin from an index entry, or null when it is missing or malformed (the item then shows its glyph). */
export function previewPin(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const m = typeof p.file === 'string' && FILE.exec(p.file);
  if (!m || !SHA.test(p.sha256 || '') || !Number.isInteger(p.bytes) || p.bytes < 1 || p.bytes > PREVIEW_MAX_BYTES || !dim(p.w) || !dim(p.h)) return null;
  return { file: p.file, sha256: p.sha256, bytes: p.bytes, w: p.w, h: p.h, type: EXT[m[1]] };
}

/** Type and pixel size from the header: WebP (VP8, VP8L, VP8X), PNG, JPEG. Null for anything else. */
export function imageInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { type: 'webp', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) return { type: 'webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && buf[20] === 0x2f) { const b = buf.readUInt32LE(21); return { type: 'webp', w: 1 + (b & 0x3fff), h: 1 + ((b >>> 14) & 0x3fff) }; }
    return null;
  }
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    // Walk the markers to the first start-of-frame (SOF0-15 except DHT C4, JPG C8, DAC CC).
    for (let at = 2; at + 9 < buf.length && buf[at] === 0xff;) {
      const mk = buf[at + 1];
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { type: 'jpeg', w: buf.readUInt16BE(at + 7), h: buf.readUInt16BE(at + 5) };
      at += 2 + buf.readUInt16BE(at + 2);
    }
  }
  return null;
}

/** The file against its pin: size first, then sha256, then magic, type and pixel size. @returns {null | { code, message }} */
export function checkPreview(buf, pin) {
  if (!Buffer.isBuffer(buf) || buf.length !== pin.bytes) return { code: 'preview_bytes', message: `the preview is ${buf ? buf.length : 0} bytes, the pin says ${pin.bytes}` };
  if (crypto.createHash('sha256').update(buf).digest('hex') !== pin.sha256) return { code: 'preview_sha', message: 'the preview does not match its sha256' };
  const info = imageInfo(buf);
  if (!info) return { code: 'preview_magic', message: 'the preview is not a WebP, PNG or JPEG image' };
  if (info.type !== pin.type) return { code: 'preview_type', message: `the preview is ${info.type}, its name says ${pin.type}` };
  if (info.w !== pin.w || info.h !== pin.h) return { code: 'preview_size', message: `the preview is ${info.w}x${info.h}, the pin says ${pin.w}x${pin.h}` };
  return null;
}

export const previewDataUri = (buf, pin) => `data:${MIME[pin.type]};base64,${buf.toString('base64')}`;
