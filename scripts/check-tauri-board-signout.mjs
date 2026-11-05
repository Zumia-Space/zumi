// T-31 S1 (GATE-OPUS-B1 should-fix): the Tauri sidecar half of the Board sign-out coverage, dropped from
// scripts/check-board-signout.mjs when B1 merged the Electron version over it. Sections B0-B8 and C4 copied from that file at
// eeababf0; only the scratch dir moved from os.tmpdir() to out/check-runs (scripts/lib/check-out-dir.mjs, never drive C:).
//   B. the Tauri sidecar handler board.signOut (tauri/sidecar/board-host.mjs): PIN rule, the live board drops to local, the
//      keystore is gone, idempotent, a relaunch is unconfigured; fault probe: a failed delete is an explicit io error.
//   C4. the API inventory, the generated Rust allow-list and the shim expose board.signOut.
// Node only, no window, no network.
//   node scripts/check-tauri-board-signout.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoardHost } from '../tauri/sidecar/board-host.mjs';
import { checkOutDir } from './lib/check-out-dir.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const scratch = checkOutDir('check-tauri-board-signout');

const SECRET = { token: 'lb_FAKEtoken_signout_77', user: 'kei-signout-user', pass: 'fake-pass-signout-55' };
const PIN = '482913', WRONG = '000000';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const tmp = () => fs.mkdtempSync(path.join(scratch, 'zumi-signout-'));
const binExists = (d) => fs.existsSync(path.join(d, 'board-secrets.bin'));

// ---------- B. sidecar handler ----------
{
  const dir = tmp();
  let settingsStore = { requireBoardPin: true };
  const mk = () => createBoardHost({ safeStorage, dataDir: dir, flavour: { values: {} }, settings: () => settingsStore, saveSettings: (p) => { settingsStore = { ...settingsStore, ...p }; return settingsStore; }, signals: null, idleLock: false });
  const host = mk();
  const h = host.handlers['board.signOut'];
  check('B0 sidecar exposes board.signOut', typeof h === 'function');
  if (typeof h === 'function') {
    host.handlers['board.setSecrets']({ ...SECRET, pin: PIN });
    await host.handlers['board.unlock'](PIN);
    await host.handlers['board.setMode']('live');
    check('B1 live mode before sign-out', host.handlers['board.status']().mode === 'live');
    check('B2 non-string PIN is bad_request, keystore kept', (await h(5)).error === 'bad_request' && host.handlers['board.status']().configured === true);
    check('B3 wrong PIN refused, keystore kept', (await h(WRONG)).ok === false && host.handlers['board.status']().configured === true);
    const r = await h(PIN);
    const s = host.handlers['board.status']();
    check('B4 right PIN signs out: unconfigured, back to local, no keystore file', r.ok === true && s.configured === false && s.mode === 'local' && !binExists(dir), { r, s });
    check('B4b sidecar live board holds no auth and no bridge after sign-out', host.liveBoard.secrets.getSecrets() === null && (await host.liveBoard.bridgePort()) === null);
    check('B5 idempotent', (await h()).ok === true);
    const again = mk();
    check('B6 relaunch: status unconfigured', again.handlers['board.status']().configured === false);
    await again.dispose();
  }
  await host.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  // B7/B8: fault probe (review F1): a delete fails -> explicit io error, board STILL dropped to local with no live auth
  const dirF = tmp();
  let stF = { requireBoardPin: false };
  const hostF = createBoardHost({ safeStorage, dataDir: dirF, flavour: { values: {} }, settings: () => stF, saveSettings: (p) => { stF = { ...stF, ...p }; return stF; }, signals: null, idleLock: false });
  hostF.handlers['board.setSecretsOs'](SECRET);
  await hostF.handlers['board.setMode']('live');
  const realRm = fs.rmSync;
  fs.rmSync = (f, o) => { if (String(f).endsWith('.meta.json')) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return realRm(f, o); };
  let rF, thrF = null;
  try { rF = await hostF.handlers['board.signOut'](); } catch (e) { thrF = e; } finally { fs.rmSync = realRm; }
  check('B7 fault probe: explicit io error (not ok, not a throw) naming the leftover file', !thrF && rF && rF.ok === false && rF.error === 'io' && rF.leftover.some((n) => /meta\.json$/.test(n)), { thrF: thrF && thrF.code, rF });
  check('B8 fault probe: no live auth in memory, mode back to local, bridge closed', hostF.liveBoard.secrets.getSecrets() === null && hostF.handlers['board.status']().mode === 'local' && (await hostF.liveBoard.bridgePort()) === null, hostF.handlers['board.status']());
  await hostF.dispose();
  fs.rmSync(dirF, { recursive: true, force: true });
}

// ---------- C4. wiring ----------
{
  const inventory = JSON.parse(read('docs/migration/api-inventory.json'));
  const rs = read('tauri/src-tauri/src/rpc_allow_list.rs');
  const shim = read('tauri/shim/zumi-shim.js');
  check('C4 inventory + generated allow-list + shim expose board.signOut', inventory.apis.some((a) => a.name === 'board.signOut' && a.kind === 'invoke') && rs.includes('"board.signOut"') && /"signOut":\s*function \(pin\) \{ return \$invoke\("board\.signOut", \[pin\]\); \}/.test(shim));
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
