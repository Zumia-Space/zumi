// Build the Kokoro runtime pack: node scripts/market-pack-kokoro.mjs --out <file.zip>
// Same files the installer used to carry (package.json build.extraResources, the same filters as tauri/stage-bundle.mjs) plus the
// licence texts. The zip is deterministic: a rebuild gives the same sha256. Prints the catalog's { sha256, bytes }; add --check to
// fail when they differ from tauri/sidecar/market-host.mjs. Publishing it is a separate step: docs/RELEASING.md.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256, zipBuffer } from './lib/zip-write.mjs';
import { validatePackZip } from '../tauri/sidecar/market-standard.mjs';
import { CATALOG } from '../tauri/sidecar/market-host.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
if (!args.includes('--out') || !out) { console.error('usage: market-pack-kokoro.mjs --out <file.zip> [--check]'); process.exit(2); }
const { copyFiltered } = await import(pathToFileURL(path.join(repo, 'tauri', 'stage-bundle.mjs')).href);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-kokoro-pack-'));
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const voice = pkg.build.extraResources.filter((e) => typeof e.to === 'string' && e.to.startsWith('voice-modules/'));
  if (voice.length !== 6) throw new Error(`expected 6 voice-modules entries, found ${voice.length}`);
  for (const e of voice) copyFiltered(path.join(repo, e.from), path.join(stage, e.to), e.filter || ['**/*']);
  // The pack carries its own credits: the licence texts, with the public form of the third-party list (no room provenance).
  fs.mkdirSync(path.join(stage, 'licenses'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'licenses', 'GPL-3.0.txt'), path.join(stage, 'licenses', 'GPL-3.0.txt'));
  fs.copyFileSync(path.join(repo, 'THIRD_PARTY_LICENSES.md'), path.join(stage, 'THIRD_PARTY_LICENSES.md'));
  createRequire(import.meta.url)('./lib/public-credits.cjs').toPublicCredits(path.join(stage, 'THIRD_PARTY_LICENSES.md'));

  const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), `${base}${d.name}/`) : [`${base}${d.name}`]));
  const names = walk(stage).sort();
  const entries = names.map((name) => ({ name, data: fs.readFileSync(path.join(stage, ...name.split('/'))) }));
  const item = CATALOG.find((c) => c.id === 'voice.kokoro-82m');
  const manifest = {
    format: 'zumi-pack/1', id: item.id, kind: 'voice', version: item.version,
    name: { en: 'Kokoro-82M English voice', vi: 'Kokoro-82M, giọng tiếng Anh' },
    author: { name: 'hexgrad', packagedBy: 'Zumia' }, licence: { spdx: 'Apache-2.0', file: 'THIRD_PARTY_LICENSES.md' },
    platforms: ['win-x64'], voice: { engine: 'kokoro', langs: ['en'] },
    files: entries.map((e) => ({ path: e.name, sha256: sha256(e.data), bytes: e.data.length })),
  };
  const zip = zipBuffer([{ name: 'zumi-pack.json', data: Buffer.from(JSON.stringify(manifest)) }, ...entries]);
  fs.writeFileSync(out, zip);
  const verdict = await validatePackZip(out, path.join(stage, '..', `${path.basename(stage)}-check`), { kind: 'voice', expectId: item.id, publisher: 'zumia' });
  fs.rmSync(path.join(stage, '..', `${path.basename(stage)}-check`), { recursive: true, force: true });
  if (!verdict.ok) { for (const e of verdict.errors.slice(0, 20)) console.error(`REFUSED [${e.code}] ${e.message}`); process.exit(1); }
  const facts = { sha256: sha256(zip), bytes: zip.length, files: entries.length, unpacked: entries.reduce((n, e) => n + e.data.length, 0) };
  console.log(JSON.stringify(facts));
  if (args.includes('--check') && (facts.sha256 !== item.download.sha256 || facts.bytes !== item.download.bytes)) {
    console.error(`the catalog pins ${item.download.sha256} / ${item.download.bytes}`);
    process.exit(1);
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
