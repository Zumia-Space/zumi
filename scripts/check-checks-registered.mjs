// Meta-check: every scripts/check-*.mjs and tauri/verify/check-*.mjs must be referenced by a package.json script
// (so `npm run check:*` suites cannot silently skip a check). Helpers/probes go on the allowlist, each with a reason.
//   node scripts/check-checks-registered.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW = {
  'scripts/check-kokoro-tts.mjs': 'real Kokoro model latency measurement; needs the model weights and a quiet CPU, not a pass/fail gate',
  'scripts/check-mouth-sync.mjs': 'measurement on real Kokoro-synthesized WAV bytes; needs the model weights',
  'scripts/check-speech-stream.mjs': 'needs headless Chromium (playwright-core) and a real AudioContext; run by hand',
  'scripts/check-toe-gap-offline.mjs': 'takes a saved sweep directory as an argument; not runnable without input',
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const registered = new Set();
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  if (!name.startsWith('check:')) continue;
  for (const m of String(cmd).matchAll(/(?:scripts|tauri\/verify)\/check-[\w.-]+\.mjs/g)) registered.add(m[0]);
}
const files = [];
for (const dir of ['scripts', 'tauri/verify']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) if (/^check-.*\.mjs$/.test(f)) files.push(`${dir}/${f}`);
}
const missing = files.filter((f) => !registered.has(f) && !(f in ALLOW));
const stale = Object.keys(ALLOW).filter((f) => !files.includes(f) || registered.has(f));
for (const f of missing) console.log(`FAIL unregistered check: ${f}`);
for (const f of stale) console.log(`FAIL stale allowlist entry: ${f}`);
console.log(`${files.length} check files, ${registered.size} registered, ${Object.keys(ALLOW).length} allowlisted`);
process.exit(missing.length || stale.length ? 1 : 0);
