// Re-encodes a big photo so it fits the board's 5 MiB message-image cap. One copy for the page (public/app.js) and the
// test (test/image-shrink.test.mjs). Classic script: sets window.LaneImage in the browser, globalThis.LaneImage in Node.
//
// Why the result's mime comes from the blob and not from what was asked: Safari (every iPhone browser) cannot encode
// WebP in canvas.toBlob and hands back a PNG for image/webp. Labelling that PNG "image/webp" made the server refuse the
// upload (content_does_not_match_mime), the composer kept the draft and the reply never went out (owner 27-10: a phone
// photo, always over 2 MB, blocked the reply). Now an encoder that answered with something else is replaced by JPEG,
// which every browser encodes, and the upload carries the type the bytes really are.
(function (root) {
  'use strict';
  const SHRINK_OVER = 2 * 1024 * 1024, IMAGE_CAP = 5 * 1024 * 1024;
  const SENDABLE = ['image/webp', 'image/jpeg'];

  /** file: a File/Blob. io: { bitmap(file) -> {width,height}, encode(bitmap, width, height, type, quality) -> Blob|null }.
   *  Returns { blob, mime } (mime = the blob's real type) or null when it cannot get under the cap. */
  async function shrink(file, io) {
    if (file.size <= SHRINK_OVER) return { blob: file, mime: file.type };
    const bmp = await io.bitmap(file);
    let scale = Math.min(1, 3200 / Math.max(bmp.width, bmp.height)), type = 'image/webp';
    for (let i = 0; i < 4; i++, scale *= 0.75) {
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      let blob = await io.encode(bmp, w, h, type, 0.82);
      if (blob && blob.type !== type && type === 'image/webp') { type = 'image/jpeg'; blob = await io.encode(bmp, w, h, type, 0.82); } // this browser has no WebP encoder
      if (blob && SENDABLE.includes(blob.type) && blob.size <= IMAGE_CAP) return { blob, mime: blob.type };
    }
    return null;
  }

  /** The browser's own bitmap + canvas encoder. */
  const browserIo = {
    bitmap: file => createImageBitmap(file),
    encode(bmp, w, h, type, quality) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      return new Promise(r => c.toBlob(r, type, quality));
    }
  };

  root.LaneImage = { shrink, SHRINK_OVER, IMAGE_CAP, browserIo };
})(typeof window !== 'undefined' ? window : globalThis);
