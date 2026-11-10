// T-31-TAURI 0.3.3 install report (10-11): one click on "Require PIN for Board" and the installed app's store went from
// PIN-sealed (438 B) to OS-sealed (294 B) with requireBoardPin:false on disk, while the installer says Apply was never
// pressed and no PIN typed. This check drives the REAL sidecar process (JSON-RPC over stdio, the exact channel the Tauri
// host forwards the renderer's calls on) with the REAL zumi-vault.exe (DPAPI), on a throwaway data dir, and pins the rule
// the report suspected broken: no IPC call may drop the PIN without the CURRENT PIN, UNLOCKED SESSION OR NOT.
//   A. unlocked + PIN-sealed: disablePin with no / malformed / wrong PIN, setSecretsOs without currentPin, setPinRequired,
//      signOut without PIN: all refused, board-secrets.bin byte-identical, settings.json has no requireBoardPin
//   B. the same refusals on a freshly started (locked) sidecar
//   C. the right PIN is the ONLY thing that turns it off: bin becomes type 'os', requireBoardPin:false persisted
// Needs zumi-vault.exe: ZUMI_VAULT_EXE or a built tauri/src-tauri/target/{release,debug}. Without it the check says so and
// exits 0 (same rule as check-tauri-board). Never prints a PIN, a secret or an envelope.
//   node scripts/check-board-pin-toggle-ipc.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
const TARGET = path.join(ROOT, 'tauri', 'src-tauri', 'target');
const helper = process.env.ZUMI_VAULT_EXE
  ? path.resolve(process.env.ZUMI_VAULT_EXE)
  : ['release', 'debug'].map((p) => path.join(TARGET, p, 'zumi-vault.exe')).find((p) => fs.existsSync(p));
if (!helper || process.platform !== 'win32' || !fs.existsSync(helper)) {
  console.log('SKIP check-board-pin-toggle-ipc - no zumi-vault.exe (set ZUMI_VAULT_EXE or build the host)');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

const pick = () => String(crypto.randomInt(100000, 999999));
const PIN = pick();
let WRONG = pick(); while (WRONG === PIN) WRONG = pick();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-pinipc-'));
const binFile = path.join(dataDir, 'board-secrets.bin');
const settingsFile = path.join(dataDir, 'settings.json');
const sha = () => crypto.createHash('sha256').update(fs.readFileSync(binFile)).digest('hex');
const savedFlag = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).requireBoardPin; } catch { return undefined; } };

function startSidecar() {
  const args = [SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch', '--vault-exe', helper, '--host-dir', path.dirname(helper)];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  child.stderr.on('data', () => {});
  rl.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve();
    else if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
  });
  return {
    ready,
    request(method, params = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() { child.stdin.end(); return new Promise((r) => child.on('close', r)); },
  };
}
const res = async (c, method, params) => (await c.request(method, params)).result;

// Every way the renderer (or anything speaking the same RPC) could try to drop the PIN without proving it.
async function refusals(c, label) {
  const before = sha();
  const tries = [
    ['disablePin with no PIN', 'board.disablePin', ['']],
    ['disablePin with a malformed PIN', 'board.disablePin', ['12ab']],
    ['disablePin with a non-string', 'board.disablePin', [null]],
    ['disablePin with the WRONG PIN', 'board.disablePin', [WRONG]],
    ['setSecretsOs without currentPin', 'board.setSecretsOs', [{ user: 'fake-ipc-user', pass: 'fake-ipc-pass' }]],
    ['setPinRequired(false) on a configured store', 'board.setPinRequired', [false]],
    ['signOut without a PIN', 'board.signOut', []],
  ];
  for (const [name, method, params] of tries) {
    const r = await res(c, method, params);
    ok(r && r.ok !== true, `${label}: ${name} is refused`, r && { ok: r.ok, error: r.error });
  }
  const st = await res(c, 'board.status');
  ok(sha() === before, `${label}: board-secrets.bin byte-identical after every refusal`);
  ok(savedFlag() === undefined, `${label}: settings.json has no requireBoardPin`, savedFlag());
  ok(st.configured === true && st.pinRequired === true, `${label}: status still configured + PIN-required`, st);
}

try {
  let c = startSidecar();
  await c.ready;
  const set = await res(c, 'board.setSecrets', [{ token: '', user: 'fake-ipc-user', pass: 'fake-ipc-pass', pin: PIN }]);
  ok(set && set.ok === true, 'setup: PIN-sealed store created through the sidecar', set);
  ok((await res(c, 'board.status')).locked === false, 'setup: the session is UNLOCKED (setSecrets unlocks), the install report state');
  await refusals(c, 'A unlocked');
  await c.close();

  c = startSidecar();
  await c.ready;
  ok((await res(c, 'board.status')).locked === true, 'B precondition: a restarted sidecar is locked');
  await refusals(c, 'B locked');

  const r = await res(c, 'board.disablePin', [PIN]);
  ok(r && r.ok === true, 'C right PIN: disablePin succeeds', r);
  const st = await res(c, 'board.status');
  ok(st.pinRequired === false && st.locked === false, 'C status is no longer PIN-required, unlocked', st);
  ok(savedFlag() === false, 'C requireBoardPin:false persisted', savedFlag());
  await c.close();
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${fail ? 'FAIL' : 'PASS'} check-board-pin-toggle-ipc - ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
