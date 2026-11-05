// Gate for scripts/tools/set-vrm-author.mjs on tiny synthetic GLBs (no real .vrm needed, none is in git).
import assert from 'node:assert/strict';
import * as tool from './tools/set-vrm-author.mjs';
const { setVrmAuthor } = tool;

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`PASS ${name}`); };

function glb(gltf, bin = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])) {
  let j = Buffer.from(JSON.stringify(gltf), 'utf8');
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const h = Buffer.alloc(12); h.write('glTF', 0, 'latin1'); h.writeUInt32LE(2, 4);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.write('JSON', 4, 'latin1');
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4, 'latin1');
  const all = Buffer.concat([h, jh, j, bh, bin]);
  all.writeUInt32LE(all.length, 8);
  return all;
}
function parse(buf) {
  assert.equal(buf.toString('latin1', 0, 4), 'glTF');
  assert.equal(buf.readUInt32LE(8), buf.length);
  const jl = buf.readUInt32LE(12);
  assert.equal(jl % 4, 0);
  assert.equal(buf.toString('latin1', 16, 20), 'JSON');
  return { gltf: JSON.parse(buf.toString('utf8', 20, 20 + jl)), rest: buf.subarray(20 + jl) };
}
const meta1 = { authors: ['Old Co'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit', modification: 'prohibited', allowRedistribution: false, name: 'x', thirdPartyLicenses: 'keep\nme' };
const base1 = { asset: { version: '2.0' }, nodes: [{ name: 'Hips', extras: { s: 'café' } }], extensions: { VRMC_vrm: { specVersion: '1.0', meta: meta1 } } };
const NEW = '3K FOREST CO.,LTD';

ok('VRM1: authors replaced, every other JSON field and the BIN chunk identical', () => {
  const src = glb(base1);
  const { out, vrm } = setVrmAuthor(src, NEW);
  assert.equal(vrm, '1');
  const a = parse(src), b = parse(out);
  assert.deepEqual(b.gltf.extensions.VRMC_vrm.meta.authors, [NEW]);
  const expected = structuredClone(a.gltf); expected.extensions.VRMC_vrm.meta.authors = [NEW];
  assert.deepEqual(b.gltf, expected);
  assert.ok(a.rest.equals(b.rest), 'BIN chunk bytes changed');
});
ok('VRM0: author string replaced, licence fields untouched', () => {
  const g = { asset: { version: '2.0' }, extensions: { VRM: { exporterVersion: 'x', meta: { title: 't', author: 'Old', licenseName: 'Other', otherLicenseUrl: 'https://e/l', otherPermissionUrl: 'https://e/p', allowedUserName: 'OnlyAuthor' } } } };
  const { out, vrm } = setVrmAuthor(glb(g), NEW);
  assert.equal(vrm, '0');
  const expected = structuredClone(g); expected.extensions.VRM.meta.author = NEW;
  assert.deepEqual(parse(out).gltf, expected);
});
ok('output is a valid GLB for every author length mod 4 (re-padded, lengths rewritten)', () => {
  for (const n of ['a', 'ab', 'abc', 'abcd', 'abcde', NEW]) {
    const { out } = setVrmAuthor(glb(base1, Buffer.alloc(12, 9)), n);
    const p = parse(out);
    assert.deepEqual(p.gltf.extensions.VRMC_vrm.meta.authors, [n]);
    assert.equal(p.rest.readUInt32LE(0), 12);
    assert.equal(p.rest.toString('latin1', 4, 7), 'BIN');
  }
});
ok('input not mutated; no VRM meta / bad GLB / empty author throw', () => {
  const src = glb(base1); const copy = Buffer.from(src);
  setVrmAuthor(src, NEW);
  assert.ok(src.equals(copy));
  assert.throws(() => setVrmAuthor(glb({ asset: { version: '2.0' } }), NEW), /no VRM meta/);
  assert.throws(() => setVrmAuthor(Buffer.from('not a glb at all, really'), NEW), /bad magic/);
  assert.throws(() => setVrmAuthor(src, '  '), /non-empty/);
});
ok('VRM1 thirdPartyLicenses: only that field (and authors) change, BIN identical; VRM0 and empty text throw', () => {
  const T = 'own (c) X; contains (c) Y';
  const src = glb(base1);
  const { out } = setVrmAuthor(src, NEW, T);
  const a = parse(src), b = parse(out);
  const expected = structuredClone(a.gltf); expected.extensions.VRMC_vrm.meta.authors = [NEW]; expected.extensions.VRMC_vrm.meta.thirdPartyLicenses = T;
  assert.deepEqual(b.gltf, expected);
  assert.deepEqual(Object.keys(b.gltf.extensions.VRMC_vrm.meta), Object.keys(a.gltf.extensions.VRMC_vrm.meta), 'meta key order changed');
  assert.ok(a.rest.equals(b.rest), 'BIN chunk bytes changed');
  assert.throws(() => setVrmAuthor(src, NEW, ' '), /thirdPartyLicenses/);
  const v0 = { asset: { version: '2.0' }, extensions: { VRM: { meta: { author: 'Old' } } } };
  assert.throws(() => setVrmAuthor(glb(v0), NEW, T), /VRM 1\.0 field/);
});
// T-31 alpha.4 item 4 (anh 30-10: 3K FOREST may use Zumi in promo clips): VRM1 meta.commercialUsage
// personalNonProfit -> corporation, and nothing else in the file.
ok('VRM1 commercialUsage: only that field changes (same key order), BIN identical; bad value / VRM0 / bad GLB throw', () => {
  assert.equal(typeof tool.setVrmCommercialUsage, 'function', 'set-vrm-author.mjs exports setVrmCommercialUsage');
  const src = glb(base1, Buffer.alloc(16, 3));
  const { out, vrm, before } = tool.setVrmCommercialUsage(src, 'corporation');
  assert.equal(vrm, '1'); assert.equal(before, 'personalNonProfit');
  const a = parse(src), b = parse(out);
  const expected = structuredClone(a.gltf); expected.extensions.VRMC_vrm.meta.commercialUsage = 'corporation';
  assert.deepEqual(b.gltf, expected);
  assert.deepEqual(Object.keys(b.gltf.extensions.VRMC_vrm.meta), Object.keys(a.gltf.extensions.VRMC_vrm.meta), 'meta key order changed');
  assert.ok(a.rest.equals(b.rest), 'BIN chunk bytes changed');
  assert.throws(() => tool.setVrmCommercialUsage(src, 'anything'), /commercialUsage/);
  assert.throws(() => tool.setVrmCommercialUsage(glb({ asset: { version: '2.0' }, extensions: { VRM: { meta: { author: 'Old', commercialUssageName: 'Disallow' } } } }), 'corporation'), /VRM 1\.0/);
  assert.throws(() => tool.setVrmCommercialUsage(Buffer.from('not a glb at all, really'), 'corporation'), /bad magic/);
});
ok('VRM1 commercialUsage: the JSON chunk differs from the input only in that value (byte diff of a compact JSON source)', () => {
  const src = glb(base1);
  const { out } = tool.setVrmCommercialUsage(src, 'corporation');
  const js = (buf) => buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)).trimEnd();
  assert.equal(js(out), js(src).replace('"commercialUsage":"personalNonProfit"', '"commercialUsage":"corporation"'));
});
console.log(`${pass} passed, 0 failed`);
