// rigVersion of a build + model, exactly as the app computes it (talk/index.js): the hash of the rig sources baked in at
// build time (scripts/build-renderer.mjs) joined with the model file's sha256. The talk server only composes gestures
// for allowlisted rigVersions (ZUMI_DESKTOP_RIG_VERSIONS), so print it for the build + model that will ship.
//   node scripts/rig-version.mjs <model.vrm>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Paths relative to src/renderer. The reflex files are the rig; avatar-core/*.js (life, gaze, pose, the core's load path) joined in
// T-31-ROOM-live-b P1 (CoS decision): the idle life and gaze moved there out of engine.js, and a new file there is covered at once.
export const RIG_SOURCES = ['reflex/schema.js', 'reflex/player.js', 'reflex/rig.js', 'reflex/engine.js', 'avatar-core/*.js'];
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function rigSourceFiles(root = ROOT) {
  const out = [];
  for (const entry of RIG_SOURCES) {
    if (!entry.endsWith('/*.js')) { out.push(entry); continue; }
    const dir = entry.slice(0, -'/*.js'.length);
    out.push(...fs.readdirSync(path.join(root, 'src', 'renderer', dir)).filter((f) => f.endsWith('.js')).sort().map((f) => `${dir}/${f}`));
  }
  return out;
}

export function rigSrcHash(root = ROOT) {
  const h = crypto.createHash('sha256');
  for (const f of rigSourceFiles(root)) h.update(fs.readFileSync(path.join(root, 'src', 'renderer', f)));
  return h.digest('hex').slice(0, 32);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const model = process.argv[2];
  if (!model) { console.error('usage: node scripts/rig-version.mjs <model.vrm>'); process.exit(2); }
  const modelHash = crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex');
  const rigVersion = crypto.createHash('sha256').update(`${rigSrcHash()}|${modelHash}`).digest('hex').slice(0, 32);
  console.log(rigVersion);
}
