// R6e M1: an attached picture has to fit the rpc frame. talk.turn carries the base64 inside one JSON line, and the host refuses a line over
// 4,000,000 bytes (MAX_REQUEST_FRAME_BYTES, lib.rs / protocol.mjs): a 5 MB phone photo is 6.99 MB of base64 and never reached the model.
// So every picture is held to IMAGE_B64_MAX characters of base64 here, in the page, before it is attached: 4 pictures x 600,000 = 2.4 MB, which
// leaves 1.6 MB of the frame for the message, the six history lines and the JSON envelope. A picture already under the cap is sent as it is;
// a bigger one is re-encoded as a JPEG, scaled down in steps, until it fits (or the attach is refused in words, never sent too big).
export const IMAGE_B64_MAX = 600_000;      // base64 characters per picture (about 450 KB of bytes)
export const IMAGE_EDGE_MAX = 2048;        // longest side after shrinking: the vision models downscale to about this anyway
// (scale of the first fit, JPEG quality) per attempt, from the gentlest to the harshest.
const STEPS = [[1, 0.85], [1, 0.7], [0.75, 0.7], [0.5, 0.65], [0.35, 0.55], [0.25, 0.5]];

/**
 * Re-encode until it fits. `encode(width, height, quality)` -> base64 of a JPEG (no data: prefix). Returns { mime, data } or null when even
 * the harshest step is over the cap.
 */
export async function fitToBudget(width, height, encode, { maxB64 = IMAGE_B64_MAX, maxEdge = IMAGE_EDGE_MAX } = {}) {
  if (!(width > 0) || !(height > 0)) return null;
  const base = Math.min(1, maxEdge / Math.max(width, height));
  for (const [scale, quality] of STEPS) {
    const s = base * scale;
    const data = await encode(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)), quality);
    if (typeof data === 'string' && data.length > 0 && data.length <= maxB64) return { mime: 'image/jpeg', data };
  }
  return null;
}

/** The browser's way: decode the File, draw it (on white, JPEG has no alpha) and encode with the canvas. A gif keeps its first frame. */
export async function shrinkInBrowser(file, { maxB64 = IMAGE_B64_MAX } = {}) {
  const bmp = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const encode = (w, h, q) => new Promise((resolve) => {
      canvas.width = w; canvas.height = h;
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) { resolve(''); return; }
        const r = new FileReader();
        r.onerror = () => resolve('');
        r.onload = () => { const s = String(r.result || ''); const at = s.indexOf(','); resolve(at >= 0 ? s.slice(at + 1) : ''); };
        r.readAsDataURL(blob);
      }, 'image/jpeg', q);
    });
    return await fitToBudget(bmp.width, bmp.height, encode, { maxB64 });
  } finally { if (typeof bmp.close === 'function') bmp.close(); }
}
