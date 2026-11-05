// T-31 T1: pins the Kokoro load-mode default (L1, owner choice 31-10) and the escape hatches.
//   node scripts/check-kokoro-load-mode.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createVoiceHost, kokoroLoadMode, VOICE_L1_DELAY_MS } = await import('../tauri/sidecar/voice-host.mjs');
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failed++; };

ok(kokoroLoadMode({}) === 'l1', 'unset env -> l1 (default)');
ok(kokoroLoadMode({ ZUMI_KOKORO_LOAD: '' }) === 'l1', 'empty env -> l1');
ok(kokoroLoadMode({ ZUMI_KOKORO_LOAD: 'garbage' }) === 'l1', 'unknown value -> l1');
ok(kokoroLoadMode({ ZUMI_KOKORO_LOAD: 'eager' }) === 'eager', 'eager is the escape hatch');
ok(kokoroLoadMode({ ZUMI_KOKORO_LOAD: 'EAGER' }) === 'eager', 'case-insensitive');
ok(kokoroLoadMode({ ZUMI_KOKORO_LOAD: 'l2' }) === 'l2', 'l2 unchanged');

// Host level: with the env unset, construction does NOT prefetch (it is deferred by VOICE_L1_DELAY_MS).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-mode-'));
const mk = () => { const c = { prefetch: 0 }; return { c, k: { available: () => true, isReady: () => false, status: () => ({ state: 'idle' }), info: () => ({}), speed: () => 1, setSpeed() {}, prefetch() { c.prefetch++; return Promise.resolve(true); }, unload() {}, abandon() {}, dispose() {} } }; };
const build = (kk) => createVoiceHost({ dataDir: tmp, settings: () => ({}), saveSettings: () => {}, secretStores: async () => ({}), flavour: { values: {} }, ttsFetchFor: () => null, emit: () => true, isLiveSay: () => true, kokoroFactory: () => kk, localTtsFactory: () => ({ available: () => false }), log: () => {} });
delete process.env.ZUMI_KOKORO_LOAD;
const d = mk(); build(d.k);
ok(d.c.prefetch === 0, 'default: no Kokoro load at host construction');
ok(VOICE_L1_DELAY_MS === 8000, 'default delay is 8 s after start');
process.env.ZUMI_KOKORO_LOAD = 'eager';
const e = mk(); build(e.k);
ok(e.c.prefetch === 1, 'eager: loads at host construction');
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
