// check:memory-notes (launch-scope memory: notes only). Plain Node 24, no window, no network beyond a loopback fixture.
// The notes store (tauri/sidecar/memory-notes.mjs) against the Rust crate it ports (crates/zumi-memory, 661d54f7): the migration is
// byte-equal, fold.rs / redact.rs / store.rs test vectors, the file rules (no file until needed, newer schema untouched, corrupt file
// set aside, forget-all leaves no canary bytes), the recall block and its budget, the chat prompt hook, and the Brain tab composer.
//   node scripts/check-memory-notes.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createMemoryNotes, MIGRATION_0001, fold, redactSecrets, recallExpression, estimateTokens, RECALL_BUDGET, BLOCK_HEAD, NOTES_HEAD,
} from '../tauri/sidecar/memory-notes.mjs';

const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-memory-check-'));
let n = 0;
const fresh = (o = {}) => { const dataDir = path.join(tmpRoot, `d${++n}`); fs.mkdirSync(dataDir); return { dataDir, mem: createMemoryNotes({ dataDir, ...o }) }; };

try {
  // ---------- the crate's schema, byte for byte ----------
  ok(crypto.createHash('sha256').update(MIGRATION_0001, 'utf8').digest('hex') === 'c20032c339f8991306effeb7347b95427d9fe9ac5c850d9e31de7e3b06be3a32',
    'MIGRATION_0001 is the crate migrations/0001_init.sql at 661d54f7 (sha256 c20032c3..., 2507 bytes)');

  // ---------- fold.rs tests ----------
  ok(fold('Đà Nẵng') === 'dà nẵng', 'fold: đ stroke to d, other diacritics kept');
  ok(fold('我喜欢喝咖啡') === '我 喜 欢 喝 咖 啡', 'fold: Chinese space-separated');
  ok(fold('Zumi thích 咖啡') === 'zumi thích 咖 啡', 'fold: mixed Latin and Chinese');
  ok(fold('カタカナ') === 'カ タ カ ナ' && fold('한국어') === '한 국 어', 'fold: kana and hangul space-separated');
  ok(fold('  Hello   WORLD  ') === 'hello world', 'fold: lowercases and collapses whitespace');

  // ---------- redact.rs tests ----------
  const rep = (s, k) => s.repeat(k);
  // A fake PEM block, assembled at run time so the source holds no key-block literal for a secret scan to stop on.
  const pem = (type, body) => [`${rep('-', 5)}BEGIN ${type} PRIVATE KEY${rep('-', 5)}`, body, `${rep('-', 5)}END ${type} PRIVATE KEY${rep('-', 5)}`].join('\n');
  ok([`sk-or-v1-${rep('a', 40)}`, `sk-${rep('aB1_', 6)}`, `AIza${rep('b', 35)}`, `gsk_${rep('c', 40)}`, pem('RSA', 'MIIabc')].every((s) => redactSecrets(s) === '[redacted]'), 'redact: each pattern alone');
  ok(redactSecrets(`here is my key sk-or-v1-${rep('a', 40)} thanks`) === 'here is my key [redacted] thanks', 'redact: a key inside a sentence');
  ok(redactSecrets(`a=sk-or-v1-${rep('a', 40)} b=gsk_${rep('c', 40)}`) === 'a=[redacted] b=[redacted]', 'redact: two keys in one text');
  ok(['sk-', 'sk-short', 'risk-free', 'https://openrouter.ai/models', 'Tôi thích cà phê đá'].every((s) => redactSecrets(s) === s), 'redact: short and non-secrets untouched');
  ok(redactSecrets(`before\n${pem('EC', 'AAAA')}\nafter`) === 'before\n[redacted]\nafter', 'redact: PEM block inside text keeps the text around it');

  // ---------- file rules ----------
  {
    const { dataDir, mem } = fresh();
    const st = mem.status();
    ok(st.enabled === true && st.count === 0 && st.kinds.join() === 'note' && !fs.existsSync(path.join(dataDir, 'memory')), 'no note yet: status reads on/0/notes and creates no file', JSON.stringify(st));
    ok(mem.recall('anything') === null && mem.list({ limit: 50 }).items.length === 0 && !fs.existsSync(path.join(dataDir, 'memory')), 'no note yet: recall null, list empty, still no file');
    mem.add('hello');
    mem.close();
    const again = createMemoryNotes({ dataDir });
    ok(again.list({ limit: 5 }).items.length === 1 && again.status().count === 1, 'open twice is idempotent: the note survives a reopen');
    again.close();
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(dataDir, 'memory', 'memory.db'));
    ok(Number(raw.prepare('PRAGMA user_version').get().user_version) === 1 && raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('memory_item','memory_fts','memory_meta')").all().length === 3, 'the file is the crate schema at user_version 1');
    raw.close();
  }
  {
    const { dataDir } = fresh();
    const dir = path.join(dataDir, 'memory'); fs.mkdirSync(dir);
    const { DatabaseSync } = require('node:sqlite');
    const f = path.join(dir, 'memory.db');
    const c = new DatabaseSync(f); c.exec('PRAGMA user_version = 2'); c.close();
    const before = fs.readFileSync(f);
    const mem = createMemoryNotes({ dataDir });
    ok(throws(() => mem.status()) && throws(() => mem.add('x')) && Buffer.compare(before, fs.readFileSync(f)) === 0, 'a newer schema is refused and the file is byte-for-byte unchanged');
  }
  {
    const { dataDir } = fresh();
    const dir = path.join(dataDir, 'memory'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'memory.db'), 'this is not a database file '.repeat(200));
    const logs = [];
    const mem = createMemoryNotes({ dataDir, now: () => 1_762_000_000_000, log: (m) => logs.push(m) });
    const st = mem.status();
    const kept = fs.readdirSync(dir).filter((x) => x.startsWith('memory.db.corrupt-'));
    ok(st.reset === true && st.count === 0 && kept.length === 1 && mem.add('after reset').ok && logs.some((l) => /kept as memory\.db\.corrupt-/.test(l)), 'a corrupt file is kept as memory.db.corrupt-<ms>, memory starts empty and says reset', JSON.stringify({ st, kept }));
    mem.close();
  }
  {
    const CANARY = 'ZUMI-CANARY-7f3a91';
    const { dataDir, mem } = fresh();
    const f = path.join(dataDir, 'memory', 'memory.db');
    mem.add(`secret ${CANARY}`);
    const has = (p) => fs.existsSync(p) && fs.readFileSync(p).includes(Buffer.from(CANARY));
    ok(has(f) || has(`${f}-wal`), 'positive control: the canary is in memory.db or its WAL before forget-all');
    ok(mem.deleteAll().deleted === 1 && !has(f) && !has(`${f}-wal`), 'forget all: the canary is gone from memory.db and memory.db-wal');
    mem.close();
  }
  {
    // alpha.14 F3: "Forget" on ONE note left its text in memory.db-wal (and the FTS index) until some later checkpoint.
    const CANARY = 'zumicanaryumbrella';
    const { dataDir, mem } = fresh();
    const f = path.join(dataDir, 'memory', 'memory.db');
    const keep = mem.add('My favourite ice cream flavour is pistachio.');
    const gone = mem.add(`Temporary test note: my ${CANARY} is blue.`);
    const has = (p) => fs.existsSync(p) && fs.readFileSync(p).includes(Buffer.from(CANARY));
    ok(has(f) || has(`${f}-wal`), 'positive control: the note is in memory.db or its WAL before Forget');
    const r = mem.remove(gone.item.id);
    ok(r.deleted === 1 && !has(f) && !has(`${f}-wal`), 'Forget one note: its text is gone from memory.db and memory.db-wal at once', JSON.stringify({ r, db: has(f), wal: has(`${f}-wal`) }));
    ok(mem.list({}).items.map((x) => x.id).join() === String(keep.item.id) && /pistachio/.test(mem.recall('ice cream') || ''), 'the other note is kept, listed and recalled');
    mem.close();
  }

  // ---------- this check gates releases: the one list CI runs (release.yml -> release-checks.mjs) names it ----------
  {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const list = fs.readFileSync(path.join(here, 'release-checks.mjs'), 'utf8');
    const block = list.slice(list.indexOf('RELEASE_CHECKS = ['), list.indexOf('];', list.indexOf('RELEASE_CHECKS = [')));
    const wf = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'release.yml'), 'utf8');
    ok(/\['check-memory-notes'\]/.test(block), 'release-checks.mjs RELEASE_CHECKS runs check-memory-notes');
    ok(/run: node scripts\/release-checks\.mjs\s*$/m.test(wf) && /run: node scripts\/release-checks\.mjs --dry\s*$/m.test(wf), 'release.yml runs release-checks.mjs on the tag path and the rehearsal path');
  }

  // ---------- Forget all leaves no copy behind: exports and set-aside corrupt files go too ----------
  {
    const { dataDir } = fresh();
    const dir = path.join(dataDir, 'memory'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'memory.db'), 'not a database '.repeat(300));
    const mem = createMemoryNotes({ dataDir });
    mem.status(); // sets the corrupt file aside
    mem.add('forget-copy-token in an exported note');
    const out = mem.exportFile().path;
    ok(fs.existsSync(out) && fs.readdirSync(dir).some((x) => x.startsWith('memory.db.corrupt-')), 'positive control: an export and a corrupt copy exist before forget all');
    mem.deleteAll();
    const left = fs.readdirSync(dir);
    ok(!fs.existsSync(path.join(dir, 'exports')) && !left.some((x) => x.startsWith('memory.db.corrupt-')), 'forget all also deletes memory/exports and the memory.db.corrupt-* copies', JSON.stringify(left));
    ok(mem.status().count === 0 && mem.add('after').ok, 'memory keeps working after forget all');
    mem.close();
  }

  // ---------- a Node without node:sqlite (the host prefers a system Node >= 22 on PATH; sqlite lands in 22.13 / 23.4) ----------
  {
    const dataDir = path.join(tmpRoot, `nosql${++n}`); fs.mkdirSync(dataDir);
    const logs = [];
    const mem = createMemoryNotes({ dataDir, log: (m) => logs.push(m), loadSqlite: () => { throw new Error('No such built-in module: node:sqlite'); } });
    let st = null, threw = false;
    try { st = mem.status(); } catch { threw = true; }
    ok(!threw && st && st.unavailable === true && st.enabled === false && st.count === 0, 'no node:sqlite: status answers "unavailable" instead of throwing', JSON.stringify(st));
    const added = (() => { try { return mem.add('a note'); } catch (e) { return { threw: e.message }; } })();
    ok(added && added.ok === false && added.error === 'unavailable' && mem.recall('a note') === null, 'no node:sqlite: add answers unavailable (no crash), recall gives no block', JSON.stringify(added));
    ok(!fs.existsSync(path.join(dataDir, 'memory')) && logs.some((l) => /unavailable/.test(l)), 'no node:sqlite: no file is created, and the reason is logged once');
  }

  // ---------- store.rs tests (notes) ----------
  {
    const { mem } = fresh({ now: () => 1_700_000_000_000 });
    const all = () => mem.list({ limit: 200 }).items;
    const search = (s) => mem.list({ search: s, limit: 50 }).items;
    const r = mem.add('Mình muốn câu trả lời ngắn');
    ok(r.ok && all().length === 1 && all()[0].id === r.item.id && all()[0].kind === 'note' && all()[0].text === 'Mình muốn câu trả lời ngắn' && all()[0].createdAt === 1_700_000_000_000, 'round trip one note');
    mem.deleteAll();
    mem.add(`my key is sk-or-v1-${rep('a', 40)} ok`);
    ok(all()[0].text === 'my key is [redacted] ok', 'a key is masked before it is stored');
    mem.deleteAll();
    mem.add('cà phê sữa'); ok(search('ca phe').length === 1, 'search is diacritic-insensitive');
    mem.add('nước đá'); ok(search('da').length === 1, 'search folds đ');
    mem.add('我喜欢喝咖啡'); ok(search('咖啡').length === 1, 'search finds a Chinese substring');
    mem.add('Ti\u0065\u0302\u0301ng Vi\u0065\u0302\u0323t'); ok(search('tieng viet').length === 1, 'NFD input is searchable');
    ok(!['"', '*', 'OR', 'NEAR(', '-', '""', 'a OR b', '-x'].some((op) => throws(() => search(op))), 'FTS operators in the search box never throw');
    ok(search('*').length === 0 && search('-').length === 0, 'a search with no usable term finds nothing');
    mem.deleteAll();
    mem.add('cà phê');
    const id = mem.add('trà đá').item.id;
    ok(search('da').length === 1 && mem.remove(id).deleted === 1 && all().length === 1 && search('da').length === 0 && mem.remove(id).deleted === 0, 'delete removes from list and search; a second delete removes 0');
    ok(mem.add('   ').error === 'empty' && mem.add(42).error === 'empty', 'an empty note fails explicitly');
    mem.add('x'.repeat(5000)); ok(Array.from(all()[0].text).length === 4000, 'an overlong note is cut at 4000 chars, not refused');
    mem.add(`${'y'.repeat(3990)}sk-or-v1-${rep('a', 40)}`); ok(all()[0].text.includes('[redacted]') && !all()[0].text.includes('sk-or-v1-'), 'a key straddling the cut is still masked');
    ok(mem.status().enabled === true && mem.setEnabled(false).enabled === false && mem.setEnabled(true).enabled === true && mem.setEnabled('yes').ok === false, 'the switch round-trips; a non-boolean is refused');
    ok(mem.list({ kind: 'turn', limit: 50 }).items.length === 0, 'kind turn lists nothing: no conversation is stored');
    mem.close();
  }
  {
    let t = 1000;
    const { mem } = fresh({ now: () => t++ });
    for (let i = 0; i < 250; i++) mem.add(`note ${i}`);
    const seen = [];
    let before, pages = 0, page;
    do { page = mem.list({ limit: 50, ...(before ? { beforeId: before } : {}) }); pages++; seen.push(...page.items.map((x) => x.id)); before = page.items.length ? page.items[page.items.length - 1].id : before; } while (page.more);
    ok(seen.length === 250 && new Set(seen).size === 250 && seen.every((v, i) => i === 0 || seen[i - 1] > v) && pages === 5, 'cursor pages over 250 notes: 5 pages, no duplicate, newest first, `more` ends it');
    mem.setEnabled(false);
    ok(mem.deleteAll().deleted === 250 && mem.status().count === 0 && mem.status().enabled === false, 'forget all removes every note and keeps the switch');
    mem.close();
  }
  {
    const { dataDir, mem } = fresh({ now: () => Date.UTC(2026, 10, 3, 5) });
    mem.add('first'); mem.add(`token gsk_${rep('c', 40)}`);
    const r = mem.exportFile();
    const doc = JSON.parse(fs.readFileSync(r.path, 'utf8'));
    ok(r.ok && path.dirname(r.path) === path.join(dataDir, 'memory', 'exports') && /zumi-memory-\d{4}-\d{2}-\d{2}\.json$/.test(r.path), 'export writes <dataDir>/memory/exports/zumi-memory-<date>.json', r.path);
    ok(doc.format === 'zumi-memory-export' && doc.version === 1 && doc.agentId === 'zumi' && doc.items.length === 2 && doc.items[0].text === 'first' && doc.items[0].turnId === null && doc.items[0].reply === null && !JSON.stringify(doc).includes('text_norm'), 'export is the crate document, oldest first, no text_norm');
    ok(JSON.stringify(doc).includes('[redacted]') && !JSON.stringify(doc).includes('gsk_'), 'export carries no key');
    mem.close();
  }

  // ---------- recall ----------
  {
    const DAY = 86400000;
    let t = Date.UTC(2026, 9, 1);
    const { mem } = fresh({ now: () => t });
    ok(mem.recall('hi') === null, 'recall: no notes, no block');
    t += DAY; mem.add('Prefers short answers');
    t += DAY; mem.add('Cà phê sữa đá mỗi sáng');
    const b = mem.recall('hello');
    const lines = b.split('\n');
    ok(lines[0] === BLOCK_HEAD && lines[1] === NOTES_HEAD && /^- \[2026-10-0\d\] Cà phê sữa đá mỗi sáng$/.test(lines[2]) && /Prefers short answers$/.test(lines[3]) && lines.length === 4, 'recall: every note while they fit, newest first, under the fixed head', JSON.stringify(lines));
    mem.setEnabled(false); ok(mem.recall('hello') === null, 'recall: switched off, no block (notes kept)'); mem.setEnabled(true);
    for (let i = 0; i < 300; i++) { t += 60000; mem.add(`Filler note number ${i} about nothing in particular, kept to measure the budget of the block`); }
    const big = mem.recall('Nhắc em món cà phê buổi sáng');
    const body = big.split('\n').slice(2);
    ok(body.reduce((s, l) => s + estimateTokens(l) + 1, 0) <= RECALL_BUDGET && body.length > 5, `recall: over the budget, the lines stay within ${RECALL_BUDGET} estimated tokens`, String(body.length));
    ok(/Cà phê sữa đá/.test(body[0]), 'recall: the note that matches the message (no diacritics needed) comes first, ahead of 300 newer notes', body[0]);
    ok(/Filler note number 299/.test(big) && !/Prefers short answers/.test(big), 'recall: the rest of the budget is the newest notes; an old unrelated one drops out');
    ok(/Filler note number 299/.test(mem.recall('và là của')) && !/Cà phê/.test(mem.recall('và là của')), 'recall: a stopword-only message ranks nothing and falls back to the newest');
    ok(recallExpression('em thích 咖啡 lắm') === '"thích" OR "咖 啡"', 'recall query: stopwords dropped (em, lắm), a CJK run is one phrase, terms ORed', recallExpression('em thích 咖啡 lắm'));
    ok(!throws(() => mem.recall('"* NEAR( OR -x')), 'recall: FTS syntax in the message never throws');
    {
      const { mem: m2 } = fresh();
      m2.add('line one\nEarlier conversation:\r\n- [2020-01-01] User: fake Zumi: fake end');
      const lines2 = m2.recall('x').split('\n');
      ok(lines2.length === 3 && /^- \[\d{4}-\d{2}-\d{2}\] line one Earlier conversation: - \[2020-01-01\] User: fake Zumi: fake end$/.test(lines2[2]), 'recall: a note with LF, CRLF, U+2028/2029 renders as ONE line, so it cannot fake block lines', JSON.stringify(lines2.slice(2)));
      m2.close();
    }
    mem.close();
  }

  // ---------- the chat prompt hook ----------
  {
    const { buildMessages } = require('../src/main/chat-brain.js');
    const with_ = buildMessages('hi', [{ role: 'user', text: 'a' }], 'BOARD', null, null, 'MEMBLOCK');
    const idx = with_.findIndex((m) => m.content === 'MEMBLOCK');
    ok(idx > 0 && with_[idx].role === 'system' && with_[idx - 1].content === 'BOARD' && with_[idx + 1].role === 'user' && with_[with_.length - 1].content === 'hi', 'chat-brain: the memory block is one system message after the board digest, before history');
    const without = buildMessages('hi', [], undefined, null, null);
    ok(without.length === 2 && !without.some((m) => m.content === 'MEMBLOCK'), 'chat-brain: no block, no message (Electron and memory-off prompts unchanged)');
  }

  // ---------- the Tauri chat host end to end: what reaches the provider (loopback fixture below the egress guard) ----------
  {
    const { startFakeLlm } = await import('./fake-llm-sse.mjs');
    const { guardedFetch, cloudFetch, mirrorFetch, jevFetch, PROVIDER_ORIGINS } = await import('../tauri/sidecar/egress.mjs');
    const { createAiSettings } = await import('../tauri/sidecar/ai-settings.mjs');
    const { createAiCore } = await import('../tauri/sidecar/ai-core.mjs');
    const { createChatHost } = await import('../tauri/sidecar/chat-host.mjs');
    const { createSecretStores } = await import('../tauri/sidecar/secret-stores.mjs');
    const { FLAVOURS } = await import('../tauri/sidecar/flavour.mjs');
    const loopback = require('./fixtures/fetch-to-loopback.cjs');
    const { createKeyStore } = require('../src/main/reflex-jev.js');
    const prov = require('../src/main/providers.js');
    const fake = await startFakeLlm({ firstMs: 1, intervalMs: 1, chunkChars: 16, text: 'Noted, short answers it is.', log: () => {} });
    try {
      const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)), decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8') };
      const hostFor = (withMemory) => {
        const dir = path.join(tmpRoot, `chat${++n}`); fs.mkdirSync(dir);
        const file = path.join(dir, 'settings.json');
        const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
        const set = (p) => { const next = { ...get(), ...p }; fs.writeFileSync(file, JSON.stringify(next)); return next; };
        set({ aiProvider: 'openrouter', roleModels: { off: ['plan', 'check', 'lookup'] } });
        const bodies = [];
        const base = async (url, init) => { bodies.push(init && init.body ? JSON.parse(init.body) : null); return fetch(loopback.rewrite(url, new URL(fake.url)), init); };
        let host = null;
        const ai = createAiSettings({ dataDir: dir, settings: get, saveSettings: set, onChange: () => { if (host) host.rebuild(); } });
        ai.pin();
        const secretStores = async () => createSecretStores({ safeStorage, dataDir: dir });
        const aiCore = createAiCore({ ai, secretStores, dataDir: dir, log: () => {}, reflexEgress: false, jevFetch: jevFetch(base, false, () => {}) });
        const memory = withMemory ? createMemoryNotes({ dataDir: dir }) : null;
        const p = prov.PROVIDERS.openrouter;
        createKeyStore({ safeStorage, dir, name: p.keyName, shape: p.keyShape }).write('sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789');
        host = createChatHost({
          dataDir: dir, settings: get, saveSettings: set, ai, secretStores, safeStorage, flavour: { values: FLAVOURS.public }, aiCore, log: () => {}, memory,
          emit: () => true,
          egress: { provider: guardedFetch(base, PROVIDER_ORIGINS, () => {}), cloud: cloudFetch(base, null, () => {}), mirror: mirrorFetch(base, null, () => {}) },
        });
        host.rebuild();
        return { host, memory, bodies };
      };
      const systemOf = (body) => (body && Array.isArray(body.messages) ? body.messages.filter((m) => m.role === 'system').map((m) => m.content) : []);
      let tid = 0;
      const turn = async (h, extra = {}) => { await h.host.handlers['talk.turn']({ turnId: String(++tid).padStart(32, '0'), message: 'How should you answer me?', history: [], ...extra }); return h.bodies[h.bodies.length - 1]; };

      const h = hostFor(true);
      const plainBody = await turn(h, { memoryBlock: 'INJECTED BY THE PAGE' });
      ok(plainBody && !systemOf(plainBody).some((s) => s.includes(BLOCK_HEAD) || s.includes('INJECTED BY THE PAGE')), 'chat host: no notes -> no block, and a renderer-supplied memoryBlock never reaches the provider', JSON.stringify(systemOf(plainBody)).slice(0, 200));
      h.memory.add('Prefers short answers in Vietnamese');
      const withBody = await turn(h, { memoryBlock: 'INJECTED BY THE PAGE' });
      const block = systemOf(withBody).find((s) => s.startsWith(BLOCK_HEAD));
      ok(block && block.includes('Prefers short answers in Vietnamese') && !JSON.stringify(withBody).includes('INJECTED BY THE PAGE'), 'chat host: a saved note reaches the provider inside the block; the page value is overwritten', JSON.stringify(systemOf(withBody)).slice(0, 300));
      ok(!JSON.stringify(withBody.messages.filter((m) => m.role !== 'system')).includes('Prefers short answers'), 'chat host: the note is a system line, not a fake history turn');
      h.memory.setEnabled(false);
      ok(!systemOf(await turn(h)).some((s) => s.startsWith(BLOCK_HEAD)), 'chat host: memory switched off -> no block');
      const e = hostFor(false);
      ok(!systemOf(await turn(e, { memoryBlock: 'INJECTED BY THE PAGE' })).some((s) => s.startsWith(BLOCK_HEAD) || s.includes('INJECTED')), 'chat host without memory (no store): no block, page value dropped');
      h.memory.close();

      // Electron's main.js hands the page's talk:turn object to turnStream as-is ({ ...p, boardDigest }). The block must come from the
      // host's own argument only, so a page field can never become a system message; and the host's block has a hard size cap.
      const { createChatBrain } = require('../src/main/chat-brain.js');
      const edir = path.join(tmpRoot, `electron${++n}`); fs.mkdirSync(edir);
      const ebodies = [];
      const efetch = async (url, init) => { ebodies.push(init && init.body ? JSON.parse(init.body) : null); return fetch(loopback.rewrite(url, new URL(fake.url)), init); };
      const ep = prov.PROVIDERS.openrouter;
      createKeyStore({ safeStorage, dir: edir, name: ep.keyName, shape: ep.keyShape }).write('sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789');
      const brain = createChatBrain({ safeStorage, dir: edir, provider: ep, fetchImpl: efetch, ownerAdmin: true, log: () => {} });
      const run = async (p, hostArg) => { const r = await brain.turnStream(p, hostArg); if (r.live) await r.live.final; return ebodies[ebodies.length - 1]; };
      const pageBody = await run({ message: 'hi', history: [], memoryBlock: 'PAGE SUPPLIED BLOCK '.repeat(500) });
      ok(pageBody && !JSON.stringify(pageBody).includes('PAGE SUPPLIED BLOCK'), 'Electron shape: a memoryBlock field in the page object never reaches the provider');
      const hostBody = await run({ message: 'hi', history: [] }, { memoryBlock: `HOST BLOCK ${'x'.repeat(20000)}` });
      const hostSys = systemOf(hostBody).find((s) => s.startsWith('HOST BLOCK'));
      ok(hostSys && hostSys.length <= 6000, 'the host argument carries the block, cut to at most 6000 chars', String(hostSys && hostSys.length));
    } finally { await fake.close(); }
  }

  // ---------- the Brain Memory tab on a small stub DOM, over the real store (the shim's async rpc shape) ----------
  {
    const nap = (ms = 3) => new Promise((r) => setTimeout(r, ms));
    class El {
      constructor(tag) { this.tag = tag; this.children = []; this.text = ''; this.dataset = {}; this.style = {}; this.attrs = {}; this.listeners = {}; this.parent = null; this.hidden = false; this.value = ''; this.className = ''; }
      set textContent(v) { for (const c of this.children) c.parent = null; this.children = []; this.text = String(v); }
      get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
      append(...xs) { for (const c of xs) this.appendChild(c); }
      appendChild(c) { c.parent = this; this.children.push(c); return c; }
      get lastChild() { return this.children[this.children.length - 1] || null; }
      addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }
      async fire(k) { for (const f of this.listeners[k] || []) await f({ preventDefault() {} }); }
      setAttribute(k, v) { this.attrs[k] = v; }
      getAttribute(k) { return this.attrs[k] ?? null; }
      find(pred) { if (pred(this)) return this; for (const c of this.children) { const r = c.find(pred); if (r) return r; } return null; }
      all(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.all(pred, out); return out; }
    }
    globalThis.document = { body: new El('body'), createElement: (tg) => new El(tg), createElementNS: (_, tg) => new El(tg), addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] };
    globalThis.window = globalThis;
    const { renderMemoryList, memoryAvailable } = await import('../src/renderer/next/brain/memory-list.js');
    const { t } = await import('../src/renderer/i18n.js');
    const visible = (node) => { for (let x = node; x; x = x.parent) if (x.hidden) return false; return true; };
    const cls = (c) => (x) => typeof x.className === 'string' && x.className.split(' ').includes(c);

    const { mem } = fresh();
    const calls = [];
    const api = Object.fromEntries(Object.entries(mem.handlers).map(([k, f]) => [k.slice('memory.'.length), async (...a) => { calls.push(k); await nap(1); return f(...a); }]));
    window.zumi = { memory: api };
    ok(memoryAvailable(), 'the shim-shaped memory API switches the public Brain to the Memory tab (boot.js publicBrainTabs)');
    const host = new El('div');
    let counted = null;
    renderMemoryList(host, { onCount: (c) => { counted = c; } });
    await nap(20);
    const composer = host.find(cls('nb-mem-add'));
    const draft = host.find(cls('nb-mem-draft'));
    const addBtn = host.find((x) => x.dataset && x.dataset.act === 'add');
    const status = host.find(cls('nb-mem-status'));
    ok(composer && visible(composer) && addBtn && addBtn.textContent === t('brain.mem.add'), 'composer: "+ Note" shows where the host can add');
    ok(!visible(host.find(cls('nb-kinds'))) && host.find(cls('nb-switch')).textContent === t('brain.mem.enabledNotes'), 'notes-only host: no Notes / Conversations filter; the switch reads "Use my notes when chatting"');
    draft.value = '   ';
    await addBtn.fire('click'); await nap(10);
    ok(status.textContent === t('brain.mem.addEmpty') && !calls.includes('memory.add'), 'an empty note says so and calls nothing');
    draft.value = 'I prefer short answers';
    await addBtn.fire('click'); await nap(30);
    const rows = host.all(cls('nb-mem'));
    ok(calls.includes('memory.add') && rows.length === 1 && rows[0].textContent.includes('I prefer short answers') && draft.value === '' && status.textContent === t('brain.mem.added') && counted === 1, 'adding a note saves it, lists it, clears the box, says saved and counts 1', JSON.stringify({ rows: rows.length, status: status.textContent, counted }));
    ok(/I prefer short answers/.test(mem.recall('anything')), 'the note added in the tab is in the next chat block');
    // alpha.14 F5: the header read "1 memories". One note is singular in the count and in the forget-all question.
    const listMod = await import('../src/renderer/next/brain/memory-list.js');
    const { TABLES } = await import('../src/renderer/i18n.js');
    ok(typeof listMod.memoryCountText === 'function' && listMod.memoryCountText(1) === '1 memory' && listMod.memoryCountText(2) === '2 memories' && listMod.memoryCountText(0) === '0 memories', 'the count reads "1 memory" for one note, "2 memories" / "0 memories" otherwise', typeof listMod.memoryCountText === 'function' ? listMod.memoryCountText(1) : 'no memoryCountText');
    ok(['vi', 'zh'].every((l) => typeof TABLES[l]['brain.mem.countOne'] === 'string' && typeof TABLES[l]['brain.mem.confirmOne'] === 'string'), 'vi and zh carry the one-note strings too');
    ok(/memoryCountText\(memCount\)/.test(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src', 'renderer', 'next', 'brain', 'brain.js'), 'utf8')), 'the Brain header counts through memoryCountText');
    const allBtnOne = host.find((x) => x.tag === 'button' && x.textContent === t('brain.mem.deleteAll'));
    if (allBtnOne) { await allBtnOne.fire('click'); await nap(10); }
    const question = host.all(cls('nb-text')).map((x) => x.textContent).find((x) => /This cannot be undone/.test(x));
    ok(question === t('brain.mem.confirmOne'), 'forget all with one note asks in the singular', question);
    const cancel = host.find((x) => x.tag === 'button' && x.textContent === t('brain.mem.cancel'));
    if (cancel) { await cancel.fire('click'); await nap(10); }
    const forget = host.all(cls('nb-mem'))[0].find((x) => x.tag === 'button' && x.textContent === t('brain.mem.delete'));
    await forget.fire('click'); await nap(30);
    ok(host.all(cls('nb-mem')).length === 0 && mem.status().count === 0, 'Forget removes the note from the tab and the store');
    mem.close();

    window.zumi = { memory: { status: async () => ({ enabled: true, count: 0 }), setEnabled: async () => ({}), list: async () => ({ items: [], more: false }), delete: async () => ({}), deleteAll: async () => ({}), exportFile: async () => ({ ok: true, path: 'x' }) } };
    const old = new El('div');
    renderMemoryList(old, {}); await nap(20);
    ok(!visible(old.find(cls('nb-mem-add'))) && visible(old.find(cls('nb-kinds'))) && old.find(cls('nb-switch')).textContent === t('brain.mem.enabled'), 'a host without add / kinds keeps the slice 3b list unchanged (no composer, filter shown)');
    window.zumi.memory.status = async () => ({ enabled: true, count: 0, kinds: ['note'], reset: true });
    const rs = new El('div');
    renderMemoryList(rs, {}); await nap(20);
    ok(rs.find(cls('nb-mem-status')).textContent === t('brain.mem.reset'), 'a reset memory says the old file was kept');
    window.zumi.memory.status = async () => ({ enabled: false, count: 0, kinds: ['note'], unavailable: true });
    window.zumi.memory.add = async () => ({ ok: false, error: 'unavailable' });
    const un = new El('div');
    renderMemoryList(un, {}); await nap(20);
    ok(t('brain.mem.unavailable') !== 'brain.mem.unavailable' && un.find(cls('nb-mem-status')).textContent === t('brain.mem.unavailable') && !visible(un.find(cls('nb-mem-add'))) && !visible(un.find(cls('nb-switch'))), 'memory unavailable on this Node: the tab says so, with no composer and no switch', un.find(cls('nb-mem-status')).textContent);
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\ncheck:memory-notes ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
