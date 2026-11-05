// Check a Marketplace package zip against the standard: node scripts/market-validate.mjs <file.zip> [--user]
// The code the app runs on every download, so a package that passes here installs. --user applies the rule for a future upload
// (a package that runs code is refused). Exit 0 = pass, 1 = refused, each reason printed; 2 = usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validatePackZip } from '../tauri/sidecar/market-standard.mjs';

const args = process.argv.slice(2);
const zip = args.find((a) => !a.startsWith('--'));
if (!zip || !fs.existsSync(zip)) { console.error('usage: node scripts/market-validate.mjs <file.zip> [--user]'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-pack-'));
try {
  const v = await validatePackZip(zip, path.join(tmp, 'pack'), { publisher: args.includes('--user') ? 'user' : 'zumia' });
  if (v.ok) console.log(`PASS ${v.manifest.id} ${v.manifest.version} (${v.manifest.kind}, ${v.manifest.files.length} files)`);
  else for (const e of v.errors) console.log(`REFUSED [${e.code}] ${e.message}`);
  process.exitCode = v.ok ? 0 : 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
