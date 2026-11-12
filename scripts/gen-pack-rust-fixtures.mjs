// Writes the Rust pack host's test fixtures (tauri/src-tauri/tests-fixtures/pack/): plugin.canary unpacked with its real
// `files` list, and a store index signed by Node with a throwaway key (its private half is never written). The Rust tests
// verifying this index are the cross-language check that Node signs what Rust's minisign-verify accepts.
//   node scripts/gen-pack-rust-fixtures.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateKeyPair, publicKeyText, signMinisign } from '../tauri/sidecar/market-sign.mjs';
import { packDirZip } from './market-pack-dir.mjs';
import { extractZip } from '../tauri/sidecar/market-zip.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'tauri', 'src-tauri', 'tests-fixtures', 'pack');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const zipPath = path.join(out, 'canary.zip');
fs.writeFileSync(zipPath, packDirZip(path.join(repo, 'scripts', 'fixtures', 'market', 'plugin.canary')));
await extractZip(zipPath, path.join(out, 'plugin.canary'), { maxBytes: 1024 * 1024 });
fs.rmSync(zipPath);
const manifestSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, 'plugin.canary', 'zumi-pack.json'))).digest('hex');

const z = '0'.repeat(64);
const index = {
  format: 'zumi-market/1', serial: 3, published: '2026-11-11T00:00:00Z',
  packs: [{ id: 'plugin.canary', kind: 'plugin', name: { en: 'Canary' },
    versions: [
      { version: '1.0.0', api: 1, url: 'plugin.canary-1.0.0.zip', sha256: z, bytes: 1, manifestSha256: manifestSha },
      { version: '0.9.0', api: 1, url: 'plugin.canary-0.9.0.zip', sha256: z, bytes: 1, manifestSha256: manifestSha },
    ],
    withdrawn: ['0.9.0'] }],
};
const pair = generateKeyPair();
const bytes = Buffer.from(JSON.stringify(index, null, 1));
fs.writeFileSync(path.join(out, 'index.json'), bytes);
fs.writeFileSync(path.join(out, 'index.json.minisig'), signMinisign(bytes, pair, { trusted: 'zumi-market index serial 3 (test fixture)' }));
fs.writeFileSync(path.join(out, 'test.pub'), publicKeyText(pair));
console.log(`fixtures in ${path.relative(repo, out)}: plugin.canary (manifest ${manifestSha.slice(0, 12)}), index serial 3, test.pub`);
