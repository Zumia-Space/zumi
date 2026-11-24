// Room live B (ADR N7): build the hostile avatar fixture from the shipped default model. Never committed: a real .vrm stays out
// of the repo (tests-fixtures/room-live-b/*.vrm is gitignored); the test builds it on demand.
//   node scripts/build-hostile-vrm.mjs --from <zumi-default-0910.vrm> --canary-port <port> --out <hostile.vrm>
// What it adds to the glTF JSON chunk (the binary chunk is copied byte for byte):
//   * an image whose uri is http://127.0.0.1:<port>/beacon.png, a texture for it, and a base-colour reference to that texture on
//     every material, so a loader that follows image URIs WILL try to fetch it;
//   * an extension (ZUMI_hostile_note) carrying a long string, and the same string in `extras` and the asset copyright, so
//     anything that renders glTF strings as markup or code has something to chew on.
// The canary must see ZERO requests when the room loads this as the user's avatar.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildHostileVrm(buf, canaryPort) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const total = buf.readUInt32LE(8);
  let off = 12;
  const chunks = [];
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 8 + len;
  }
  const jsonChunk = chunks.find((c) => c.type === 0x4e4f534a);
  if (!jsonChunk) throw new Error('no JSON chunk');
  const gltf = JSON.parse(jsonChunk.data.toString('utf8'));
  const note = '<img src=x onerror=fetch("http://127.0.0.1:' + canaryPort + '/string-exec")>' + '"; alert(1); //'.repeat(20);
  gltf.images = gltf.images || [];
  gltf.textures = gltf.textures || [];
  gltf.images.push({ uri: `http://127.0.0.1:${canaryPort}/beacon.png`, name: note });
  gltf.textures.push({ source: gltf.images.length - 1, name: note });
  const textureIndex = gltf.textures.length - 1;
  // Every material gets the hostile base-colour texture: a loader only fetches images of materials a mesh really uses, and which
  // ones those are depends on the model, so the fixture does not guess.
  if (!(gltf.materials || []).length) throw new Error('no material to attach the hostile texture to');
  for (const material of gltf.materials) material.pbrMetallicRoughness = { ...(material.pbrMetallicRoughness || {}), baseColorTexture: { index: textureIndex } };
  gltf.extensionsUsed = [...new Set([...(gltf.extensionsUsed || []), 'ZUMI_hostile_note'])];
  gltf.extensions = { ...(gltf.extensions || {}), ZUMI_hostile_note: { note } };
  gltf.extras = { ...(gltf.extras || {}), note };
  gltf.asset = { ...(gltf.asset || {}), copyright: note };
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const parts = chunks.map((c) => (c === jsonChunk ? { type: c.type, data: json } : c));
  const size = 12 + parts.reduce((n, c) => n + 8 + c.data.length, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(size, 8);
  return Buffer.concat([head, ...parts.flatMap((c) => { const h = Buffer.alloc(8); h.writeUInt32LE(c.data.length, 0); h.writeUInt32LE(c.type, 4); return [h, c.data]; })]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
  const from = opt('from'), port = Number(opt('canary-port')), out = opt('out');
  if (!from || !port || !out) { console.error('usage: build-hostile-vrm.mjs --from <default.vrm> --canary-port <port> --out <hostile.vrm>'); process.exit(2); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const built = buildHostileVrm(fs.readFileSync(from), port);
  fs.writeFileSync(out, built);
  console.log(`hostile model: ${built.length} bytes -> ${out} (canary port ${port})`);
}
