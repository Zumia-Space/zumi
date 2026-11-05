// check:go-cli-login (T-31 alpha.13). Owner 02-11. Plain Node: a FIXTURE auth.json with fake keys,
// a stubbed fetch, the real chat host. The real auth.json is never read (asserted through a read spy). No network, no paid call.
//   node scripts/check-go-cli-login.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkOutDir } from './lib/check-out-dir.mjs';
import { TABLES } from '../src/renderer/i18n.js';
import { failureLineKey } from '../src/renderer/talk/error-line.js';
import { createChatHost } from '../tauri/sidecar/chat-host.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PROVIDERS } = require('../src/main/providers.js');
const { readCliGoKey, defaultAuthFile } = require('../src/main/opencode-cli-login.js');
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const dir = checkOutDir('check-go-cli-login');
const scratch = (n) => fs.mkdtempSync(path.join(dir, `${n}-`));
const GO = `oc_go_${'g'.repeat(40)}`, GO2 = `oc_go_${'h'.repeat(40)}`, CONSOLE = `oc_console_${'c'.repeat(40)}`, OTHER = `sk-other-${'o'.repeat(40)}`, PASTED = `oc_pasted_${'p'.repeat(40)}`;
const SECRETS = [GO, GO2, CONSOLE, OTHER, PASTED];
const leak = (s) => SECRETS.filter((k) => s.includes(k) || s.includes(k.slice(-16)));
const shape = PROVIDERS['opencode-go'].keyShape;
const body = (go) => JSON.stringify({ opencode: { type: 'api', key: CONSOLE }, anthropic: { type: 'oauth', access: OTHER, refresh: OTHER }, ...(go ? { 'opencode-go': { type: 'api', key: go } } : {}) });
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };

// Every file read goes through the spy: the real auth.json must never appear, and the fixture only after a click.
const reads = [];
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...a) => { reads.push(String(p)); return realRead(p, ...a); };
const real = path.resolve(defaultAuthFile());
const readsOf = (f) => reads.filter((p) => path.resolve(p) === path.resolve(f)).length;

ok(path.resolve(defaultAuthFile()) === path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'), 'the default path is the CLI\'s auth.json');

function host({ owner = true, providerId = 'opencode-go', auth, respond }) {
  const d = scratch('data');
  let st = {};
  const logs = [], calls = [];
  const h = createChatHost({
    dataDir: d, settings: () => st, saveSettings: (p) => { st = { ...st, ...p }; fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(st)); return st; },
    ai: { mode: () => 'byok', provider: () => providerId, providerId: () => providerId, legacyDefaults: () => false },
    secretStores: async () => ({ brainKey: () => ({ noteChatResult: () => {} }) }), safeStorage, flavour: { values: { ownerAdmin: owner } }, emit: () => {}, aiCore: {},
    egress: { provider: fetch, cloud: fetch, mirror: fetch }, log: (m) => logs.push(String(m)), cliAuthFile: auth, appVersion: 'check',
    chatFetch: async (url, o) => { calls.push({ url: String(url), auth: o.headers.authorization }); return respond ? respond(o) : new Response(JSON.stringify({ choices: [{ message: { content: '[greet] Chào anh.' } }], usage: { total_tokens: 3 } }), { status: 200 }); },
  });
  return { h: h.handlers, d, logs, calls, settings: () => st };
}
const fixture = (go) => { const f = path.join(scratch('auth'), 'auth.json'); fs.writeFileSync(f, body(go)); return f; };
const onlyTwoKeys = (r) => Object.keys(r).sort().join() === 'active,source' && typeof r.active === 'boolean' && ['opencode-cli', 'key-file'].includes(r.source);
const dataLeaks = (d) => fs.readdirSync(d, { recursive: true }).flatMap((n) => { const p = path.join(d, String(n)); return fs.statSync(p).isFile() ? leak(realRead(p, 'latin1')) : []; });

// ---------- default off ----------
{
  const auth = fixture(GO);
  const a = host({ auth });
  const before = readsOf(auth);
  const v = a.h['brainKey.cliLoginStatus']();
  ok(onlyTwoKeys(v) && v.active === false && v.source === 'key-file', 'default off: status says the pasted-key source', JSON.stringify(v));
  ok(readsOf(auth) === before, 'default off: the status read touches no auth file');
  ok(a.settings().goCliLogin === undefined, 'default off: no setting is written until a click');
  const t = await a.h['talk.status']();
  ok(t && t.enabled !== true, 'default off: with no pasted key, talk stays off');
  ok(readsOf(auth) === before, 'default off: talk.status touches no auth file');
}

// ---------- the click ----------
{
  const auth = fixture(GO);
  const original = realRead(auth);
  const a = host({ auth });
  const v = a.h['brainKey.cliLoginSet'](true);
  ok(onlyTwoKeys(v) && v.active === true && v.source === 'opencode-cli', 'click: the answer is one boolean and one source', JSON.stringify(v));
  ok(leak(JSON.stringify(v)).length === 0 && leak(JSON.stringify(a.h['brainKey.cliLoginStatus']())).length === 0, 'renderer answers carry no key');
  ok(a.settings().goCliLogin === true, 'click: the choice is saved as a boolean');
  const r = await a.h['talk.turn']({ message: 'xin chào', history: [] });
  ok(a.calls.length > 0 && a.calls.every((c) => c.auth === `Bearer ${GO}`), 'the Go entry\'s key is the one on the wire', String(a.calls.length));
  ok(a.calls.every((c) => c.url.startsWith('https://opencode.ai/inference/go/')), 'the call goes to the Go endpoint');
  ok(!a.calls.some((c) => c.auth.includes(CONSOLE) || c.auth.includes(OTHER)), 'the other entries never reach the wire');
  ok(leak(JSON.stringify(r)).length === 0, 'the turn\'s answer carries no key');
  ok(dataLeaks(a.d).length === 0, 'no key in any file of the data dir', dataLeaks(a.d).join());
  ok(leak(a.logs.join('\n')).length === 0, 'no key in the logs');
  ok(realRead(auth).equals(original), 'auth.json is byte-identical afterwards: nothing is written back');
  // Read at call time, not held: a new login is used at once, a removed one stops the next call with no fallback.
  fs.writeFileSync(auth, body(GO2));
  a.calls.length = 0;
  await a.h['talk.turn']({ message: 'xin chào', history: [] });
  ok(a.calls.length > 0 && a.calls.every((c) => c.auth === `Bearer ${GO2}`), 'read at call time: a changed login is used on the next call');
  // A refusal that echoes the key must stay out of the logs and the answer.
  const b = host({ auth, respond: () => new Response(JSON.stringify({ error: { message: `bad key ${GO2}` } }), { status: 401 }) });
  b.h['brainKey.cliLoginSet'](true);
  const refused = await b.h['talk.turn']({ message: 'xin chào', history: [] });
  ok(refused.error && refused.error.cliLogin === true && failureLineKey(refused.error) === 'app.goCliRefused', 'a CLI login refused (401) says to log in again, not to paste a key', JSON.stringify(refused.error));
  ok(['en', 'vi', 'zh'].every((l) => /opencode auth login/.test(TABLES[l]['app.goCliRefused'] || '')), 'that line names the command in en, vi, zh');
  ok(leak(JSON.stringify(refused)).length === 0 && leak(b.logs.join('\n')).length === 0 && dataLeaks(b.d).length === 0, 'a refusal that echoes the key: no key in the answer, logs or files', `${leak(JSON.stringify(refused))} ${leak(b.logs.join('\n'))}`);

  const e = host({ auth, respond: () => new Response(JSON.stringify({ choices: [{ message: { content: `[greet] Khoá là ${GO2} nhé.` } }], usage: { total_tokens: 3 } }), { status: 200 }) });
  e.h['brainKey.cliLoginSet'](true);
  const echoed = await e.h['talk.turn']({ message: 'xin chào', history: [] });
  ok(echoed.ok && leak(JSON.stringify(echoed)).length === 0, 'a reply that quotes the login key is redacted, as a pasted key is', JSON.stringify(echoed).slice(0, 60).replace(/oc_\w+/g, '<fake>'));

  // Turning it off goes back to the key-file source without another read of the login.
  const n = readsOf(auth);
  const off = a.h['brainKey.cliLoginSet'](false);
  ok(onlyTwoKeys(off) && off.source === 'key-file' && a.settings().goCliLogin === false && readsOf(auth) === n, 'off: back to the pasted-key source, no read');
}

// ---------- missing ----------
{
  for (const [name, make] of [['file missing', () => path.join(scratch('none'), 'auth.json')], ['entry missing', () => fixture(null)], ['broken JSON', () => { const f = path.join(scratch('bad'), 'auth.json'); fs.writeFileSync(f, `{"opencode-go":"${GO}`); return f; }]]) {
    const a = host({ auth: make() });
    const v = a.h['brainKey.cliLoginSet'](true);
    ok(onlyTwoKeys(v) && v.active === false && a.settings().goCliLogin === undefined, `${name}: click answers active:false, nothing saved`, JSON.stringify(v));
    ok(leak(JSON.stringify(v)).length === 0 && leak(a.logs.join('\n')).length === 0, `${name}: no key or file text in the answer or logs`);
  }
  // Chosen, then logged out: no silent move to a pasted key.
  const auth = fixture(GO);
  const a = host({ auth });
  fs.writeFileSync(path.join(a.d, `${PROVIDERS['opencode-go'].keyName}-key.bin`), PASTED);
  a.h['brainKey.cliLoginSet'](true);
  fs.writeFileSync(auth, body(null));
  const v = a.h['brainKey.cliLoginStatus']();
  ok(v.active === false && v.source === 'opencode-cli', 'logged out later: still chosen, not active', JSON.stringify(v));
  const r = await a.h['talk.turn']({ message: 'xin chào', history: [] });
  ok(!r.ok && a.calls.length === 0, 'logged out later: no call goes out, the pasted key is not used instead', JSON.stringify(r).slice(0, 160));
  a.h['brainKey.cliLoginSet'](false);
  ok((await a.h['talk.status']()).enabled === true, 'off again: the pasted key works as before');
  ok(['en', 'vi', 'zh'].every((l) => TABLES[l]['settings.cliLoginMissing'].includes('opencode auth login')), 'the missing line gives the command in en, vi, zh');
  ok(TABLES.vi['settings.cliLoginMissing'].startsWith('chưa đăng nhập OpenCode CLI') && TABLES.vi['settings.cliLoginUse'] === 'Dùng đăng nhập OpenCode CLI trên máy này', 'the Vietnamese button and line use the agreed words');
  ok(['en', 'vi', 'zh'].every((l) => ['settings.cliLoginUse', 'settings.cliLoginStop', 'settings.cliLoginSource', 'settings.cliLoginSourcePaste'].every((k) => TABLES[l][k])), 'button and source lines exist in en, vi, zh');
}

// ---------- owner build, Go selected ----------
{
  const auth = fixture(GO);
  const before = readsOf(auth);
  const pub = host({ owner: false, auth });
  const v = pub.h['brainKey.cliLoginSet'](true);
  ok(onlyTwoKeys(v) && v.active === false && pub.settings().goCliLogin === undefined && readsOf(auth) === before, 'public build: refused, nothing saved, no read');
  const other = host({ providerId: 'opencode', auth });
  const w = other.h['brainKey.cliLoginSet'](true);
  ok(w.active === false && other.settings().goCliLogin === undefined && readsOf(auth) === before, 'another provider selected: refused, nothing saved, no read');
  // A setting left on must not reach another provider, or a public build.
  const c = host({ providerId: 'opencode', auth });
  c.h['brainKey.cliLoginSet'](false);
  fs.writeFileSync(path.join(c.d, `${PROVIDERS.opencode.keyName}-key.bin`), PASTED);
  await c.h['talk.turn']({ message: 'xin chào', history: [] });
  ok(c.calls.every((x) => x.auth === `Bearer ${PASTED}`) && readsOf(auth) === before, 'the Console provider uses its own key and never the CLI file');
}

// ---------- planted reads: this check must catch them ----------
{
  const src = realRead(path.join(ROOT, 'src/main/opencode-cli-login.js'), 'utf8');
  const auth = fixture(GO);
  const planted = (from, to) => { if (!src.includes(from)) throw new Error(`plant anchor: ${from}`); const f = path.join(scratch('plant'), 'm.cjs'); fs.writeFileSync(f, src.replace(from, to)); return require(f).readCliGoKey({ file: auth, shape }); };
  ok(readCliGoKey({ file: auth, shape }) === GO, 'the real module takes the Go entry');
  ok(planted("const ENTRY = 'opencode-go';", "const ENTRY = 'opencode';") === CONSOLE, 'a planted read of the opencode entry returns the Console key, so the rows below would see it');
  ok(planted("const ENTRY = 'opencode-go';", "const ENTRY = 'opencode';") !== GO, 'planted read of the opencode entry fails the "takes the Go entry" row');
  ok(/const ENTRY = 'opencode-go';/.test(src) && (src.match(/\[ENTRY\]/g) || []).length === 1 && !/Object\.(keys|values|entries)/.test(src), 'source: one fixed entry, one lookup, no walk over the file (source regex)');
  ok(!/writeFile|appendFile|createWriteStream|console\.|log\(/.test(src), 'source: the module writes nothing and logs nothing (source regex)');
}

ok(reads.every((p) => path.resolve(p) !== real), 'the real auth.json was never read in this run');

console.log(`\ncheck:go-cli-login: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
