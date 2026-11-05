// T-31 batch-1 box probe, finding 3 (PARITY-PLAN "### 13": "sidecar kill -> recoverable error in the UI and
// restart path"). Before this fix the kill produced the host event and a console.error only: the owner saw
// nothing. The renderer now paints it under the existing Tauri host gate.
//
//   node scripts/check-tauri-sidecar-error.mjs   (exit 1 on any failure)
//
// The renderer module and the real i18n tables run in a CHILD process (scripts/sidecar-error-renderer-check.mjs),
// the pattern check-tauri-free-llm.mjs uses for renderer behaviour. The shim side is pinned here too: the host's
// sidecar:ready must reach the page as a `zumi:sidecar-ready` window event, which is what clears the banner.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };

// ---- 1. the real renderer module, in a fresh process ----
const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sidecar-error-renderer-check.mjs')], { cwd: ROOT, encoding: 'utf8' });
ok(child.status === 0, 'the renderer check process exits cleanly', (child.stderr || '').slice(0, 300));
let parsed = null;
try { parsed = JSON.parse((child.stdout || '').trim().split(/\r?\n/).pop()); } catch { /* reported below */ }
const results = (parsed && Array.isArray(parsed.results)) ? parsed.results : [];
ok(results.length > 0, 'the renderer check returned a result set', (child.stdout || '').slice(0, 200));
for (const r of results) ok(r.ok, r.name, r.detail);
const names = results.map((r) => r.name).join('|');
ok(/Electron \(no __TAURI__\)/.test(names) && /Tauri: the banner element is created/.test(names) && /sidecar:ready .* clears the banner/.test(names) && /both sidecar strings are translated/.test(names),
  'the check covers the Electron gate, the banner, the ready-clear and all three locales');

// ---- 2. the shim turns sidecar:ready into a page event (the clear signal) ----
const listeners = new Map();
const dispatched = [];
const win = {
  __TAURI__: { core: { invoke: () => Promise.resolve(null) }, event: { listen: (name, fn) => { listeners.set(name, fn); return Promise.resolve(() => {}); } } },
  console: { error: () => {} },
  CustomEvent,
  dispatchEvent: (ev) => { dispatched.push(ev); return true; },
};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'tauri', 'shim', 'zumi-shim.js'), 'utf8'), { window: win, Promise, URL, console }, { filename: 'zumi-shim.js' });
ok(typeof listeners.get('sidecar:ready') === 'function' && typeof listeners.get('sidecar:error') === 'function', 'the shim listens for both host sidecar events');
if (listeners.has('sidecar:ready')) listeners.get('sidecar:ready')({ payload: null });
ok(dispatched.some((e) => e.type === 'zumi:sidecar-ready'), 'sidecar:ready reaches the page as a zumi:sidecar-ready event (clears the banner)');

// ---- 3. the module is Tauri-gated and the strings live in the real table ----
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'sidecar-status.js'), 'utf8');
ok(/win\.__TAURI__/.test(src) && !/document\.(getElementById|createElement)\(/.test(src.replace(/doc\.(getElementById|createElement)\(/g, '')),
  'sidecar-status.js builds DOM only through the injected document behind the window.__TAURI__ gate');
const i18n = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'i18n.js'), 'utf8');
ok((i18n.match(/'sidecar\.restarting'/g) || []).length === 3 && (i18n.match(/'sidecar\.failed'/g) || []).length === 3,
  'en/vi/zh all carry sidecar.restarting and sidecar.failed');

console.log(`\n${fail ? 'FAIL' : 'PASS'} check-tauri-sidecar-error — ${pass}/${pass + fail} assertions passed`);
process.exit(fail ? 1 : 0);
