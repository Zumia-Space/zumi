// T-31 settings-a2: in-app provider key entry (Settings > AI brain > "Your own key"; KEY-HANDLING.md). No Electron,
// no real key, no real network: keys are random fakes made at runtime and are NEVER printed; the provider is a fake
// endpoint (a local HTTP server standing in for openrouter.ai's GET /api/v1/key) reached through the module's own
// allowlisted URL -- fetchImpl only swaps the origin, so path, method, headers and redirect policy are the real ones.
//   1. the key store: write -> read -> clear, encrypted on disk, shape-gated, no plaintext fallback;
//   2. checkKey: works / rejected (401, 403) / unreachable (5xx, 429, network, timeout) against the fake endpoint;
//   3. createBrainKey.save/clear/test: refused keys are not stored, offline keys are, nothing key-shaped comes back;
//   4. chat-brain sees a saved key at once (no restart) and stops at once after Clear;
//   5. wiring: main's brainKey:* IPC, the preload surface, the renderer card clears the field before sending.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { realSafeStorage } from './lib/real-safe-storage.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const { createKeyStore } = require('../src/main/reflex-jev.js');
const { createBrainKey, checkKey } = require('../src/main/brain-key.js');
const { createChatBrain } = require('../src/main/chat-brain.js');

// Reversible fake of Electron safeStorage (same convention as check-chat-brain.mjs); `available` toggles DPAPI.
// .decrypts counts decryptString calls (status() must never decrypt).
function stubSafeStorage({ available = true } = {}) {
  const real = realSafeStorage({ available }); // ZUMI_VAULT_EXE: GATE-step5 test 9 (the real vault adapter)
  if (real) return real;
  const ss = {
    decrypts: 0,
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from([...Buffer.from(`enc:${s}`, 'utf8')].map((b) => b ^ 0x5a)),
    decryptString: (b) => { ss.decrypts++; const s = Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'); if (!s.startsWith('enc:')) throw new Error('bad'); return s.slice(4); },
  };
  return ss;
}
const tmpDirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-key-test-')); tmpDirs.push(d); return d; };
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
// Runtime-made fakes: OpenRouter's shape (sk-or-...), random, never written to this file and never printed.
const fakeKey = () => `sk-or-v1-${crypto.randomBytes(24).toString('hex')}`;
const GOOD = fakeKey();
const OTHER_GOOD = fakeKey();
const REFUSED = fakeKey();
const ALL_KEYS = [GOOD, OTHER_GOOD, REFUSED];
const leaks = (x) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return ALL_KEYS.some((k) => s.includes(k)) || /sk-or-v1-[0-9a-f]{20,}/.test(s); };

// ---------- the fake provider endpoint ----------
const seen = []; // { method, path, auth, bodyLen }
let mode = 'normal'; // normal | 500 | 429
const server = http.createServer((req, res) => {
  let len = 0;
  req.on('data', (c) => { len += c.length; });
  req.on('end', () => {
    const auth = String(req.headers.authorization || '');
    seen.push({ method: req.method, path: req.url, auth, bodyLen: len });
    if (mode === '500' || mode === '429') { res.writeHead(Number(mode)); return res.end('{}'); }
    if (req.url !== '/api/v1/key') { res.writeHead(404); return res.end('{}'); }
    const good = auth === `Bearer ${GOOD}` || auth === `Bearer ${OTHER_GOOD}`;
    if (auth === `Bearer ${REFUSED}`) { res.writeHead(403); return res.end('{"error":{"code":403}}'); }
    res.writeHead(good ? 200 : 401, { 'content-type': 'application/json' });
    res.end(good ? '{"data":{"label":"test"}}' : '{"error":{"message":"User not found.","code":401}}');
  });
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const urls = [];
const fakeFetch = (url, opts) => { urls.push({ url, opts }); return fetch(String(url).replace('https://openrouter.ai', `http://127.0.0.1:${port}`), opts); };
const deadFetch = () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND openrouter.ai'), { code: 'ENOTFOUND' }));

try {
  // ---------- 1. key store ----------
  {
    const dir = tmpDir();
    const ks = createKeyStore({ safeStorage: stubSafeStorage(), dir });
    ok(ks.read() === null, 'store: empty dir -> no key');
    ok(ks.write('hello').error === 'bad_format' && !fs.existsSync(ks.file), 'store: a non-key string is refused, nothing written');
    ok(ks.write(GOOD).ok && ks.read() === GOOD, 'store: write -> read round-trip');
    const disk = fs.readFileSync(ks.file);
    ok(!disk.includes(Buffer.from(GOOD)) && !disk.includes(Buffer.from('sk-or-')), 'store: the file on disk is ciphertext, not the key');
    ok(!fs.existsSync(`${ks.file}.tmp`), 'store: atomic write leaves no .tmp behind');
    fs.writeFileSync(ks.importFile, `${OTHER_GOOD}\n`); // a pending one-time import must not resurrect a cleared key
    ok(ks.clear() && ks.read() === null && !fs.existsSync(ks.file) && !fs.existsSync(ks.importFile), 'store: clear removes the encrypted file AND a pending import file');
    const noEnc = createKeyStore({ safeStorage: stubSafeStorage({ available: false }), dir });
    ok(noEnc.write(GOOD).error === 'no_encryption' && !fs.existsSync(noEnc.file), 'store: no OS encryption -> refused, no plaintext fallback');
  }

  // ---------- 2. checkKey against the fake endpoint ----------
  {
    seen.length = 0; urls.length = 0;
    ok(await checkKey(GOOD, { fetchImpl: fakeFetch }) === 'works', 'check: a key the provider accepts -> works');
    const call = urls[0];
    ok(call && call.url === 'https://openrouter.ai/api/v1/key' && call.opts.method === 'GET' && call.opts.redirect === 'error', 'check: one GET to https://openrouter.ai/api/v1/key, redirects refused', call && `${call.opts.method} ${call.opts.redirect}`);
    ok(seen.length === 1 && seen[0].path === '/api/v1/key' && seen[0].bodyLen === 0 && seen[0].auth.startsWith('Bearer '), 'check: the endpoint saw a bodiless GET /api/v1/key with a bearer (free, no tokens spent)');
    ok(await checkKey(fakeKey(), { fetchImpl: fakeFetch }) === 'rejected', 'check: unknown key (401) -> rejected');
    ok(await checkKey(REFUSED, { fetchImpl: fakeFetch }) === 'rejected', 'check: forbidden key (403) -> rejected');
    mode = '500'; ok(await checkKey(GOOD, { fetchImpl: fakeFetch }) === 'unreachable', 'check: provider 5xx -> unreachable (no verdict on the key)');
    mode = '429'; ok(await checkKey(GOOD, { fetchImpl: fakeFetch }) === 'unreachable', 'check: provider 429 -> unreachable');
    mode = 'normal';
    ok(await checkKey(GOOD, { fetchImpl: deadFetch }) === 'unreachable', 'check: no network -> unreachable');
    const timeoutFetch = () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    ok(await checkKey(GOOD, { fetchImpl: timeoutFetch }) === 'unreachable', 'check: timeout -> unreachable');
    ok(!seen.some((s) => s.path.includes('chat/completions')), 'check: never a paid completion');
  }

  // ---------- 3. createBrainKey ----------
  {
    const dir = tmpDir();
    const logs = [];
    const bk = createBrainKey({ safeStorage: stubSafeStorage(), dir, fetchImpl: fakeFetch, log: (m) => logs.push(m) });
    const results = [];
    const r0 = bk.status(); results.push(r0);
    ok(r0.provider === 'OpenRouter' && r0.saved === false && r0.last4 === null && r0.encryption === true, 'brain key: fresh install -> {provider, saved:false, last4:null}');
    seen.length = 0;
    const bad = await bk.save('not a key'); results.push(bad);
    ok(!bad.ok && bad.error === 'bad_format' && seen.length === 0 && !bk.status().saved, 'brain key: wrong shape -> bad_format, no network call, nothing stored');
    let junkOk = true;
    for (const junk of [undefined, null, 42, { k: GOOD }, ['x']]) { const r = await bk.save(junk); results.push(r); if (r.ok || r.error !== 'bad_format') junkOk = false; }
    ok(junkOk && seen.length === 0, 'brain key: non-string inputs (undefined/null/number/object/array) -> bad_format, no network call');
    const refused = await bk.save(REFUSED); results.push(refused);
    ok(!refused.ok && refused.error === 'rejected' && !bk.status().saved && !fs.existsSync(path.join(dir, 'jev-key.bin')), 'brain key: a key the provider refuses is NOT stored');
    const saved = await bk.save(`  ${GOOD}\n`); results.push(saved);
    ok(saved.ok && saved.check === 'works' && saved.saved && saved.last4 === GOOD.slice(-4), 'brain key: a working key (pasted with spaces) -> saved, check "works", last4 only', JSON.stringify({ ok: saved.ok, check: saved.check, saved: saved.saved, l4: saved.last4 === GOOD.slice(-4) }));
    ok(Object.keys(saved).sort().join(',') === 'check,checked,encryption,last4,ok,provider,saved', 'brain key: the save answer carries exactly {ok, check, provider, saved, last4, checked, encryption}', Object.keys(saved).sort().join(','));
    ok(saved.checked === 'works', 'brain key: a key that worked on save reads checked:"works" (no Check again button)');
    const t1 = await bk.test(); results.push(t1);
    ok(t1.ok && t1.check === 'works', 'brain key: test() re-checks the stored key');
    const replaced = await bk.save(OTHER_GOOD); results.push(replaced);
    ok(replaced.ok && bk.status().last4 === OTHER_GOOD.slice(-4), 'brain key: Change -> the new key replaces the old one');

    const offline = createBrainKey({ safeStorage: stubSafeStorage(), dir: tmpDir(), fetchImpl: deadFetch });
    const off = await offline.save(GOOD); results.push(off);
    ok(!off.ok && off.error === 'unreachable' && off.needsConfirm === true && !offline.status().saved, 'brain key: provider unreachable -> NOT saved without the explicit confirmation (T-31 fix round item 1)');
    const offConfirmed = await offline.save(GOOD, { confirmUnreachable: true }); results.push(offConfirmed);
    ok(offConfirmed.ok && offConfirmed.check === 'unreachable' && !offConfirmed.needsConfirm && offline.status().saved, 'brain key: provider unreachable + explicit confirmation -> saved, check "unreachable"');
    const noEnc = createBrainKey({ safeStorage: stubSafeStorage({ available: false }), dir: tmpDir(), fetchImpl: fakeFetch });
    seen.length = 0;
    const ne = await noEnc.save(GOOD); results.push(ne);
    ok(!ne.ok && ne.error === 'no_encryption' && seen.length === 0, 'brain key: no OS encryption -> no_encryption, the key is not even sent for checking');

    const cleared = bk.clear(); results.push(cleared);
    ok(cleared.ok && !cleared.saved && cleared.last4 === null && !fs.existsSync(path.join(dir, 'jev-key.bin')), 'brain key: Clear -> no key on disk, status saved:false');
    const t2 = await bk.test(); results.push(t2);
    ok(!t2.ok && t2.error === 'no_key', 'brain key: test() with no key -> no_key');

    ok(!results.some(leaks), `brain key: none of the ${results.length} answers contains a key (only last4)`);
    ok(!logs.some(leaks), 'brain key: no log line contains a key', `${logs.length} lines`);
  }

  // ---------- 3b. last4 cached at write time (status() never decrypts) + the "Check again" state ----------
  {
    const dir = tmpDir();
    const ss = stubSafeStorage();
    let revoked = false; // the fake provider starts refusing GOOD (a key revoked on the provider's side)
    const flipFetch = (url, opts) => (revoked && String(opts.headers.authorization) === `Bearer ${GOOD}` ? Promise.resolve({ ok: false, status: 401 }) : fakeFetch(url, opts));
    const bk = createBrainKey({ safeStorage: ss, dir, fetchImpl: flipFetch });
    await bk.save(GOOD);
    const before = ss.decrypts;
    for (let i = 0; i < 5; i++) bk.status();
    ok(ss.decrypts === before && bk.status().last4 === GOOD.slice(-4), 'cache: status() x5 never decrypts the key (last4 cached at write time)', `decrypts +${ss.decrypts - before}`);
    const cache = path.join(dir, 'jev-key.last4');
    ok(fs.readFileSync(cache, 'utf8') === GOOD.slice(-4), 'cache: the cache file holds exactly the last 4 characters');
    revoked = true;
    const t = await bk.test();
    ok(!t.ok && t.check === 'rejected' && t.saved && t.checked === 'rejected', 'Check again: a key the provider now refuses -> "rejected", still stored (the user picks Change or Clear)');
    revoked = false;
    const t2 = await bk.test();
    ok(t2.ok && t2.checked === 'works', 'Check again: works again -> checked "works"');
    const off = createBrainKey({ safeStorage: ss, dir, fetchImpl: deadFetch });
    const t3 = await off.test();
    ok(!t3.ok && t3.check === 'unreachable' && t3.checked === 'unreachable' && bk.status().checked === 'unreachable', 'Check again: provider unreachable -> checked "unreachable" (the button stays)');
    bk.clear();
    ok(!fs.existsSync(cache) && !fs.existsSync(path.join(dir, 'brain-key-check.json')) && bk.status().checked === null, 'cache: Clear removes the last4 cache and the check record');

    // A key stored before the cache existed (an older build): decrypted ONCE to fill the cache, never again.
    const legacy = tmpDir();
    const ss2 = stubSafeStorage();
    fs.writeFileSync(path.join(legacy, 'jev-key.bin'), ss2.encryptString(OTHER_GOOD));
    const lk = createBrainKey({ safeStorage: ss2, dir: legacy, fetchImpl: fakeFetch });
    const s1 = lk.status();
    const afterFirst = ss2.decrypts;
    lk.status(); lk.status();
    ok(s1.saved && s1.last4 === OTHER_GOOD.slice(-4) && afterFirst === 1 && ss2.decrypts === 1, 'cache: a pre-cache key is decrypted once to fill the cache, then never', `decrypts=${ss2.decrypts}`);
    ok(s1.checked === null, 'state: a key that arrived without a check (older build / import file) reads "not checked" -> Check again shown');
    // The one-time import path fills the cache too.
    const imp = tmpDir();
    const ss3 = stubSafeStorage();
    const ks = createKeyStore({ safeStorage: ss3, dir: imp });
    fs.writeFileSync(ks.importFile, OTHER_GOOD);
    ok(ks.importIfPresent() === 'imported' && fs.readFileSync(ks.last4File, 'utf8') === OTHER_GOOD.slice(-4) && ks.last4() === OTHER_GOOD.slice(-4) && ss3.decrypts === 0, 'cache: the import file path caches last4 too (no decrypt needed afterwards)');
    ok(!leaks([t, t2, t3, s1]), 'Check again: no answer contains a key');
  }

  // ---------- 4. chat-brain uses the saved key at once, and stops at once after Clear ----------
  {
    const dir = tmpDir();
    const ss = stubSafeStorage();
    const cb = createChatBrain({ safeStorage: ss, dir, fetchImpl: deadFetch, log: () => {} });
    const bk = createBrainKey({ safeStorage: ss, dir, fetchImpl: fakeFetch });
    ok(!cb.hasKey() && cb.status().enabled === false, 'chat: no key -> chat off');
    await bk.save(GOOD);
    ok(cb.hasKey() && cb.status().enabled === true && cb.status().provider === 'OpenRouter', 'chat: key saved in Settings -> chat on in the SAME session (no restart)');
    ok(!leaks(cb.status()), 'chat: status() still carries no key');
    bk.clear();
    ok(!cb.hasKey() && cb.status().enabled === false, 'chat: key cleared -> chat off at once');
  }

  // ---------- 5. wiring ----------
  {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    const card = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'brain-key-card.js'), 'utf8');
    const handlers = [...main.matchAll(/ipcMain\.handle\('brainKey:(\w+)', ([^\n]+)/g)].map((m) => [m[1], m[2]]);
    ok(handlers.map((h) => h[0]).sort().join(',') === 'clear,save,status,test', 'main: exactly four brainKey:* handlers (status/save/clear/test)', handlers.map((h) => h[0]).join(','));
    ok(handlers.every(([, body]) => body.includes('fromAppPage(e)') && !/\.read\(/.test(body)), 'main: every brainKey handler checks the sender is the app page and none returns the stored key');
    ok(/brainKey: \{\s*status: \(\) => ipcRenderer\.invoke\('brainKey:status'\),[\s\S]*?save: \(raw, confirm\) => ipcRenderer\.invoke\('brainKey:save', raw, confirm\),\s*clear: \(\) => ipcRenderer\.invoke\('brainKey:clear'\),\s*test: \(\) => ipcRenderer\.invoke\('brainKey:test'\),\s*\}/.test(preload), 'preload: zumi.brainKey = { status, save(raw, confirm), clear, test } and nothing else');
    const cleared = card.indexOf("el.input.value = ''");
    const sent = card.indexOf('zumi.brainKey.save(');
    ok(cleared > -1 && sent > cleared, 'renderer: the key field is emptied BEFORE the key is sent to main');
    ok(/shotsProviderFetch : undefined/.test(main) && /settingsShotsDir \? shotsProviderFetch/.test(main), 'main: the fake key check is wired only under --settings-shots');
    ok(/el\.check\.addEventListener\('click'[\s\S]{0,200}zumi\.brainKey\.test\(\)/.test(card) && /el\.check\.hidden = !view\.saved \|\| view\.checked === 'works'/.test(card), 'renderer: "Check again" calls brainKey:test and shows only while a saved key is not known to work');
    const allMain = fs.readdirSync(path.join(ROOT, 'src', 'main')).filter((f) => /\.(m?js)$/.test(f)).map((f) => fs.readFileSync(path.join(ROOT, 'src', 'main', f), 'utf8')).join('\n');
    ok(!/crashReporter/.test(allMain), 'main: crashReporter is not configured anywhere (nothing uploads main-process memory)');
  }
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? `FAIL check-brain-key — ${fail} failed` : `PASS check-brain-key — ${pass}/${pass} assertions passed`);
// exitCode, not process.exit(): undici's keep-alive handles must close on their own (an early exit trips a libuv
// assertion on Windows).
process.exitCode = fail ? 1 : 0;
