// Build step (tauri/build.ps1 -Flavour): write or remove flavour.json beside the host exe.
//   node tauri/write-flavour.mjs --flavour owner|selftest|public --out <dir of the host exe>
// `public` writes no file and deletes a stale one, so a rebuild can never keep an old owner file (GATE-6pre cond. 1).
import fs from 'node:fs';
import path from 'node:path';
import { FLAVOUR_FILE, flavourFileText } from './sidecar/flavour.mjs';

const at = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; };
const name = at('--flavour') || 'public';
const out = at('--out');
if (!out || !path.isAbsolute(out)) { console.error('write-flavour: --out <absolute dir> is required'); process.exit(2); }
let text;
try { text = flavourFileText(name); } catch (e) { console.error(`write-flavour: ${e.message}`); process.exit(2); }
const file = path.join(out, FLAVOUR_FILE);
if (text === null) {
  fs.rmSync(file, { force: true });
  console.log(`flavour public: no ${FLAVOUR_FILE} (removed if present)`);
} else {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`flavour ${name}: wrote ${file}`);
}
