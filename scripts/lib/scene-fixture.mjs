// Builds tiny, valid binary glTF files for the scene standard's checks and the scene.canary fixture. Test/build tool only.
// One triangle per mesh by default, an optional embedded PNG texture of a declared size, optional extra JSON (to plant faults).

const pad4 = (buf, fill) => { const n = (4 - (buf.length % 4)) % 4; return n ? Buffer.concat([buf, Buffer.alloc(n, fill)]) : buf; };

/** A PNG header only (8-byte signature + IHDR), enough for a size probe. */
export function pngHeader(w, h) {
  const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6; return b;
}

/**
 * @param {{ triangles?: number, texturePx?: [number, number] | null, nodes?: string[], mutate?: (json: object) => void }} [o]
 * @returns {Buffer} a .glb
 */
export function sceneGlb({ triangles = 1, texturePx = [64, 64], nodes = ['room', 'zumi_stand'], mutate } = {}) {
  const positions = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => positions.writeFloatLE(v, i * 4));
  const indices = Buffer.alloc(triangles * 3 * 4);
  for (let i = 0; i < triangles * 3; i++) indices.writeUInt32LE(i % 3, i * 4);
  const image = texturePx ? pngHeader(...texturePx) : null;
  const chunks = [positions, indices, ...(image ? [image] : [])];
  const views = []; let offset = 0;
  for (const c of chunks) { views.push({ buffer: 0, byteOffset: offset, byteLength: c.length }); offset += pad4(c, 0).length; }
  const json = {
    asset: { version: '2.0', generator: 'zumi scene-fixture' },
    scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes: nodes.map((name, i) => (i === 0 ? { name, mesh: 0 } : { name, translation: [0, 0, 0] })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4, ...(image ? { material: 0 } : {}) }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5125, count: triangles * 3, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: offset }],
    ...(image ? { images: [{ bufferView: 2, mimeType: 'image/png' }], textures: [{ source: 0 }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }] } : {}),
  };
  if (mutate) mutate(json);
  const jsonBuf = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const bin = Buffer.concat(chunks.map((c) => pad4(c, 0)));
  const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.write('JSON', 4, 'latin1');
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, jsonBuf, bh, bin]);
}

/** A scene.json descriptor matching sceneGlb's defaults: anchors by node name, the room.json v2 view names, five times of day. */
export function sceneDescriptor(extra = {}) {
  return JSON.stringify({
    format: 'zumi-scene/1',
    anchors: { zumi_stand: { node: 'zumi_stand' } },
    views: { talk: { camera: { position: [0, 1.4, 2.2], target: [0, 1.2, 0], fov: 35 } }, room: { camera: { position: [2, 1.6, 3], target: [0, 1, 0], fov: 45 } } },
    timeOfDay: { order: ['lowsun', 'morning', 'day', 'evening', 'night'], presets: { lowsun: {}, morning: {}, day: {}, evening: {}, night: {} } },
    ...extra,
  });
}
