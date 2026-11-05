// rigVersion of a build + model, exactly as the app computes it (talk/index.js): the hash of the rig sources baked in at
// build time (scripts/build-renderer.mjs) joined with the model file's sha256. The talk server only composes gestures
// for allowlisted rigVersions (ZUMI_DESKTOP_RIG_VERSIONS), so print it for the build + model that will ship.
//   node scripts/rig-version.mjs <model.vrm>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RIG_SOURCES = ['schema.js', 'player.js', 'rig.js', 'engine.js'];
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function rigSrcHash() {
  const h = crypto.createHash('sha256');
  for (const f of RIG_SOURCES) h.update(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', f)));
  return h.digest('hex').slice(0, 32);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const model = process.argv[2];
  if (!model) { console.error('usage: node scripts/rig-version.mjs <model.vrm>'); process.exit(2); }
  const modelHash = crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex');
  const rigVersion = crypto.createHash('sha256').update(`${rigSrcHash()}|${modelHash}`).digest('hex').slice(0, 32);
  console.log(rigVersion);
}
