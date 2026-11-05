// Room fixture generator (T-31 R1, PLAN-room.md §6 R1: "Generate the bad ones from the good one with a small
// script; don't commit huge files"). Pure Buffer transforms of ONE good room .glb (Vesta's default room, read
// read-only from its configured path) -- nothing here is ever written into the repo; every caller generates these
// in a scratch/selftest directory at run time. Shared by scripts/check-room.mjs (plain-Node unit fixtures) and
// main.js's test-only room selftest IPC (so both exercise the exact same bad bytes).
const GLB_MAGIC_OFFSET = 0;
const JSON_CHUNK_LEN_OFFSET = 12;
const JSON_CHUNK_START = 20;

function readGlb(buf) {
  const jsonLen = buf.readUInt32LE(JSON_CHUNK_LEN_OFFSET);
  const json = JSON.parse(buf.subarray(JSON_CHUNK_START, JSON_CHUNK_START + jsonLen).toString('utf8'));
  const binHeaderOff = JSON_CHUNK_START + jsonLen;
  const binLen = buf.readUInt32LE(binHeaderOff);
  const bin = buf.subarray(binHeaderOff + 8, binHeaderOff + 8 + binLen);
  return { json, bin };
}

// Re-serializes { json, bin } back into a valid GLB container (glTF 2.0 binary layout: 12-byte header, JSON chunk
// padded to a 4-byte boundary with spaces, BIN chunk padded with zero bytes).
function writeGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binPadded = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const totalLen = 12 + 8 + jsonChunk.length + 8 + binPadded.length;
  const out = Buffer.alloc(totalLen);
  out.writeUInt32LE(0x46546c67, 0); // magic 'glTF'
  out.writeUInt32LE(2, 4); // version
  out.writeUInt32LE(totalLen, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  jsonChunk.copy(out, 20);
  const binHeaderOff = 20 + jsonChunk.length;
  out.writeUInt32LE(binPadded.length, binHeaderOff);
  out.writeUInt32LE(0x004e4942, binHeaderOff + 4); // 'BIN\0'
  binPadded.copy(out, binHeaderOff + 8);
  return out;
}

// A minimal valid PNG: signature + IHDR only (no IDAT/IEND needed -- the checker reads only the header, never decodes).
function minimalPng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  const typeAndData = Buffer.concat([Buffer.from('IHDR'), ihdrData]);
  const len = Buffer.alloc(4); len.writeUInt32BE(ihdrData.length, 0);
  const crc = Buffer.alloc(4); // not verified by our checker; zero is fine
  return Buffer.concat([sig, len, typeAndData, crc]);
}

/** The too-big fixture alone: any GLB (even one without images) plus padding past the size cap. */
export function tooBigFixture(goodGlb) {
  return Buffer.concat([goodGlb, Buffer.alloc(26 * 1024 * 1024, 0)]);
}

/** @param {Buffer} goodGlb -- Vesta's default room.glb, read-only input. Returns { name: Buffer } for 6 bad fixtures. */
export function generateBadRoomFixtures(goodGlb) {
  const out = {};

  // 1. too-big: padding appended after a structurally valid GLB. The size cap is a cheap byte-length check, so this
  // alone is enough to trigger it without touching the glTF content.
  out['too-big.glb'] = tooBigFixture(goodGlb);

  // 2. external-image: one image gets a remote `uri` instead of a `bufferView` reference.
  {
    const { json, bin } = readGlb(goodGlb);
    json.images[0] = { name: json.images[0].name, uri: 'https://example.com/texture.png', mimeType: 'image/png' };
    out['external-image.glb'] = writeGlb(json, bin);
  }

  // 3. draco: declares a required compression extension this build's allowlist refuses.
  {
    const { json, bin } = readGlb(goodGlb);
    json.extensionsUsed = [...(json.extensionsUsed || []), 'KHR_draco_mesh_compression'];
    json.extensionsRequired = [...(json.extensionsRequired || []), 'KHR_draco_mesh_compression'];
    out['draco.glb'] = writeGlb(json, bin);
  }

  // 4. big-texture: a new 4096x4096 image (header only) appended to the BIN chunk and referenced by a new
  // bufferView -- the checker's refusal is header-based, so no pixel data is needed.
  {
    const { json, bin } = readGlb(goodGlb);
    const png = minimalPng(4096, 4096);
    const bvIndex = json.bufferViews.length;
    const offset = bin.length;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: png.length });
    json.images.push({ name: 'oversized', mimeType: 'image/png', bufferView: bvIndex });
    const newBin = Buffer.concat([bin, png]);
    json.buffers[0].byteLength = newBin.length;
    out['big-texture.glb'] = writeGlb(json, newBin);
  }

  // 5. missing-anchors: every zumi-room-standard anchor node is renamed, so none of the exact-name lookups match.
  // Also drops every light -- node-level KHR_lights_punctual references are removed FIRST, so the top-level
  // `lights` array can be deleted without leaving a dangling `{light: <index>}` reference (a real GLTFLoader
  // throws on that; the pure JSON checker would not have caught it, since it only counts the array's length).
  {
    const { json, bin } = readGlb(goodGlb);
    const ANCHORS = new Set(['zumi_stand', 'camera_default', 'desk_seat', 'desk_keyboard', 'screen_surface', 'prop_cup', 'look_targets']);
    for (const n of json.nodes || []) { if (n.name && ANCHORS.has(n.name)) n.name = `was_${n.name}`; }
    for (const n of json.nodes || []) {
      if (n.extensions && n.extensions.KHR_lights_punctual) {
        delete n.extensions.KHR_lights_punctual;
        if (Object.keys(n.extensions).length === 0) delete n.extensions;
      }
    }
    if (json.extensions && json.extensions.KHR_lights_punctual) delete json.extensions.KHR_lights_punctual; // exercises the "no lights" warning
    if (json.extensionsUsed) json.extensionsUsed = json.extensionsUsed.filter((e) => e !== 'KHR_lights_punctual');
    out['missing-anchors.glb'] = writeGlb(json, bin);
  }

  // 6. bad-magic: flips the GLB magic bytes, so the file is not recognizable as glTF-binary at all.
  {
    const b = Buffer.from(goodGlb);
    b.writeUInt32LE(0xdeadbeef, GLB_MAGIC_OFFSET);
    out['bad-magic.glb'] = b;
  }

  return out;
}
