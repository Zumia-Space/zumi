import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Default output root for check scripts: portable for OSS (no drive-letter assumption). The repo lives on D: on our PCs,
// so <repo>/out/check-runs never writes to C: (os.tmpdir() would). ZUMI_CHECK_OUT replaces that ROOT; each run still gets its
// own <script>-<ts>-<pid> dir under it (never reused, BP-3). An explicit --out beats both.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function checkOutDir(scriptName) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const root = path.resolve(process.env.ZUMI_CHECK_OUT || path.join(REPO_ROOT, 'out', 'check-runs'));
  const dir = path.join(root, `${scriptName}-${stamp}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
