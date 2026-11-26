// check:memory-journal (R6 item 2): the journal of changes to the user's memory notes, with undo. Plain Node 24, no window, no network.
// Upstream (docs/memory.md "The journal", server/memory-journal.ts): every change is a row (who, how, which note, when, the earlier text),
// outside what the agent can edit; undo puts the earlier state back and is itself a journaled change, so it can be undone in turn; a row
// whose earlier text held a secret cannot be undone and says so; a journal write never fails the change it records.
// Zumi's notes are rows of memory.db (append-only), so a change is "created" or "deleted"; undo of created = delete it, undo of
// deleted = put it back with its original time. Forget-all clears the journal too (nothing is kept).
//   node scripts/check-memory-journal.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryNotes } from '../tauri/sidecar/memory-notes.mjs';
import { createJournal, JOURNAL_FILE, KEEP_ROWS, MAX_ROWS } from '../tauri/sidecar/memory-journal.mjs';

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const section = (name, fn) => { try { fn(); } catch (e) { fail++; console.log(`FAIL ${name} threw: ${e && e.message}`); } };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-memory-journal-'));
let n = 0;
const fresh = (o = {}) => {
  const dataDir = path.join(tmpRoot, `d${++n}`);
  fs.mkdirSync(dataDir);
  let t = 1_762_000_000_000;
  const logs = [];
  const mem = createMemoryNotes({ dataDir, now: () => (t += 1000), log: (m) => logs.push(m), ...o });
  return { dataDir, mem, logs, journalPath: path.join(dataDir, 'memory', 'journal.ndjson') };
};
const J = (mem, q) => (mem.handlers['memory.journal'] ? mem.handlers['memory.journal'](q) : { ok: false, error: 'no_handler', items: [] });
const U = (mem, id) => (mem.handlers['memory.undo'] ? mem.handlers['memory.undo'](id) : { ok: false, error: 'no_handler' });
const texts = (mem) => mem.list({ limit: 50 }).items.map((i) => i.text);

try {
  ok(typeof createJournal === 'function' && MAX_ROWS === 500 && KEEP_ROWS === 400 && JOURNAL_FILE === 'journal.ndjson', 'the journal module exports its constants');
  section('block 1', () => {
    const { mem } = fresh();
    ok(typeof mem.handlers['memory.journal'] === 'function' && typeof mem.handlers['memory.undo'] === 'function', 'memory.journal and memory.undo are handlers');
    const a = mem.add('Prefers short answers');
    const b = mem.handlers['memory.add']('Dentist on Friday', { actor: 'agent', via: 'chat' });
    const j = J(mem);
    ok(j.ok === true && j.items.length === 2, 'two changes, two rows', JSON.stringify(j));
    ok(j.items[0].kind === 'created' && j.items[0].actor === 'agent' && j.items[0].via === 'chat' && j.items[0].noteId === b.item.id && j.items[0].text === 'Dentist on Friday', 'newest first: the agent\'s note, who and how');
    ok(j.items[1].kind === 'created' && j.items[1].actor === 'person' && j.items[1].via === 'panel' && j.items[1].noteId === a.item.id, 'a note added with no options is the person\'s, from the panel');
    ok(j.items.every((r) => typeof r.id === 'string' && r.id.length > 8 && typeof r.at === 'number' && r.canRevert === true), 'every row has an id, a time and says it can be undone');
    const odd = mem.handlers['memory.add']('third', { actor: 'root', via: '<script>' });
    ok(J(mem).items[0].actor === 'person' && J(mem).items[0].via === 'panel' && odd.ok, 'an unknown actor or way is not stored as given');
    ok(J(mem, { limit: 1 }).items.length === 1 && J(mem, { limit: 0 }).items.length >= 1 && J(mem, { limit: 99999 }).items.length === 3, 'limit is clamped to 1..200');
    ok(!mem.add('').ok && J(mem).items.length === 3, 'a refused (empty) note is not a change');
    mem.close();
  });
  section('block 2', () => {
    const { mem } = fresh();
    const a = mem.add('keep me');
    mem.add('forget me');
    const gone = mem.list({ limit: 10 }).items.find((i) => i.text === 'forget me');
    ok(mem.remove(gone.id).deleted === 1, 'delete works as before');
    const del = J(mem).items[0];
    ok(del.kind === 'deleted' && del.noteId === gone.id && del.text === 'forget me' && del.createdAt === gone.createdAt && del.actor === 'person' && del.canRevert === true, 'a delete row keeps the earlier text and time so undo can put it back', JSON.stringify(del));
    ok(mem.remove(987654).deleted === 0 && J(mem).items.length === 3, 'deleting a note that is not there is not a change');
    // undo of a delete: the note is back with its ORIGINAL time (so it sits where it was in the list)
    const u = U(mem, del.id);
    ok(u.ok === true && u.item && u.item.text === 'forget me' && u.item.createdAt === gone.createdAt, 'undo of a delete restores the note with its original time', JSON.stringify(u));
    ok(texts(mem).join('|') === 'forget me|keep me', 'it is back, newest first as before');
    const top = J(mem).items[0];
    ok(top.kind === 'created' && top.via === 'undo' && top.noteId === u.item.id, 'the undo is itself a journaled change');
    ok(U(mem, del.id).ok === false && U(mem, del.id).error === 'already_restored' && texts(mem).length === 2, 'undoing the same delete twice does not make a second copy');
    // undo the undo: the note goes again
    const uu = U(mem, top.id);
    ok(uu.ok === true && texts(mem).join('|') === 'keep me' && J(mem).items[0].kind === 'deleted' && J(mem).items[0].via === 'undo', 'an undo can be undone in turn');
    // undo of a create removes it
    const cr = J(mem).items.find((r) => r.kind === 'created' && r.noteId === a.item.id);
    const uc = U(mem, cr.id);
    ok(uc.ok === true && texts(mem).length === 0, 'undo of a created note removes it');
    ok(U(mem, cr.id).ok === false && U(mem, cr.id).error === 'already_gone', 'undoing a create whose note is already gone says so');
    ok(U(mem, 'no-such-row').error === 'not_found' && U(mem, 7).error === 'bad_id' && U(mem, undefined).error === 'bad_id', 'an unknown or malformed row id is refused');
    mem.close();
  });
  section('block 3', () => {
    // a reused row id must not be mistaken for the old note: delete the newest, add another (SQLite hands the id out again), then undo the OLD create
    const { mem } = fresh();
    const a = mem.add('first');
    const created = J(mem).items[0];
    mem.remove(a.item.id);
    const b = mem.add('second');
    ok(b.item.id === a.item.id, 'precondition: the id is handed out again');
    const r = U(mem, created.id);
    ok(r.ok === false && r.error === 'already_gone' && texts(mem).join('|') === 'second', 'undo of the old create leaves the new note with the same id alone');
    mem.close();
  });
  section('block 4', () => {
    // journal survives a reopen; forget-all clears it and leaves no canary
    const { dataDir, mem, journalPath } = fresh();
    mem.add('CANARY-9f3a1 secret-ish note');
    mem.close();
    const again = createMemoryNotes({ dataDir });
    ok(J(again).items.length === 1 && fs.existsSync(journalPath), 'the journal survives a restart (a file next to memory.db)');
    ok(fs.readFileSync(journalPath, 'utf8').includes('CANARY-9f3a1'), 'precondition: the canary is in the journal');
    again.deleteAll();
    ok(J(again).items.length === 0 && !fs.existsSync(journalPath), 'forget-all clears the journal: undo cannot bring anything back');
    const hits = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (fs.readFileSync(p).includes('CANARY-9f3a1')) hits.push(f.name); } };
    walk(dataDir);
    ok(hits.length === 0, 'forget-all leaves no canary byte anywhere in the data dir', hits.join(','));
    again.close();
  });
  section('block 5', () => {
    // a journal that cannot be written never fails the change it records, and says so in the log
    const { mem, logs, journalPath } = fresh();
    mem.add('first');
    fs.rmSync(journalPath, { force: true });
    fs.mkdirSync(journalPath); // a directory where the file goes
    const r = mem.add('second');
    ok(r.ok === true && texts(mem).includes('second'), 'the note is saved although the journal could not be written');
    ok(logs.some((l) => /journal/i.test(l)), 'and the failure is logged, not swallowed', logs.join(' | '));
    mem.close();
  });
  section('block 6', () => {
    // the journal module on its own: secrets, caps, bad lines
    const dir = path.join(tmpRoot, 'jm'); fs.mkdirSync(dir);
    const logs = [];
    let t = 1000;
    const redact = (s) => s.replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted]');
    const jr = createJournal({ dir, now: () => (t += 1), log: (m) => logs.push(m), redact });
    const secret = jr.record({ noteId: 1, kind: 'deleted', actor: 'person', via: 'panel', text: `key sk-${'a'.repeat(30)} here`, createdAt: 5 });
    ok(secret && secret.canRevert === false && /sensitive|hidden/i.test(secret.revertUnavailableReason || '') && !secret.text.includes('sk-aaaa'), 'a row whose earlier text held a secret keeps it redacted and cannot be undone');
    ok(jr.find(secret.id).canRevert === false, 'and a reread says the same');
    fs.appendFileSync(path.join(dir, JOURNAL_FILE), 'not json\n{"id":1}\n');
    ok(jr.list(50).length === 1, 'a line that does not parse is skipped, not trusted');
    for (let i = 0; i < MAX_ROWS + 5; i++) jr.record({ noteId: i, kind: 'created', actor: 'person', via: 'panel', text: `n${i}`, createdAt: 1 });
    const onDisk = fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8').split('\n').filter((l) => l.startsWith('{"id":"') && l.includes('"noteId"')).length;
    ok(onDisk <= MAX_ROWS && onDisk >= KEEP_ROWS && jr.list(1)[0].text === `n${MAX_ROWS + 4}`, 'past the cap the file is cut back to the newest rows (the newest is kept)', String(onDisk));
    ok(fs.readdirSync(dir).join() === JOURNAL_FILE, 'no temp file is left');
    jr.clear();
    ok(jr.list(10).length === 0 && !fs.existsSync(path.join(dir, JOURNAL_FILE)), 'clear removes the file');
  });
  section('block 7', () => {
    // undo of a deleted note whose earlier text held a secret is refused with the reason (no copy of the secret is written back)
    const { dataDir, mem } = fresh();
    mem.add('plain');
    const file = path.join(dataDir, 'memory', 'journal.ndjson');
    const row = { id: 'row-secret', at: 1, noteId: 99, kind: 'deleted', actor: 'person', via: 'panel', text: 'was [redacted]', createdAt: 7, canRevert: false, revertUnavailableReason: 'The earlier text contained sensitive text that was hidden, so it cannot be restored exactly.' };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    const r = U(mem, 'row-secret');
    ok(r.ok === false && r.error === 'cannot_revert' && /sensitive/.test(r.reason || '') && texts(mem).join() === 'plain', 'undo of a row marked cannot-be-undone is refused with its reason');
    mem.close();
  });
  section('block 8 (R6c C item 3: edit one note in place)', () => {
    const { dataDir, mem } = fresh();
    const a = mem.add('Dentist on Friday');
    const b = mem.add('Prefers short answers');
    ok(typeof mem.update === 'function' && typeof mem.handlers['memory.update'] === 'function', 'update exists (a function and an rpc handler)');
    if (typeof mem.update !== 'function') { mem.close(); return; }
    const before = mem.list({ limit: 10 }).items;
    const r = mem.handlers['memory.update'](a.item.id, 'Dentist on Monday');
    ok(r.ok === true && r.item.id === a.item.id && r.item.text === 'Dentist on Monday' && r.item.createdAt === a.item.createdAt, 'edit keeps the note\'s id and its time', JSON.stringify(r));
    const after = mem.list({ limit: 10 }).items;
    ok(after.map((i) => i.id).join() === before.map((i) => i.id).join() && after.find((i) => i.id === a.item.id).text === 'Dentist on Monday', 'the list order is unchanged and shows the new text');
    ok(mem.list({ search: 'monday' }).items.length === 1 && mem.list({ search: 'friday' }).items.length === 0, 'search follows the edit: the new word finds it, the old one does not');
    ok(/Dentist on Monday/.test(mem.recall('dentist') || '') && !/Friday/.test(mem.recall('dentist') || ''), 'the next chat turn quotes the edited text');
    const row = J(mem).items[0];
    ok(row.kind === 'edited' && row.actor === 'person' && row.via === 'panel' && row.noteId === a.item.id && row.text === 'Dentist on Friday' && row.to === 'Dentist on Monday' && row.canRevert === true, 'the edit is a journal row: who, how, the earlier text and the new one', JSON.stringify(row));
    const same = mem.update(a.item.id, 'Dentist on Monday');
    ok(same.ok === true && same.unchanged === true && J(mem).items.length === 3, 'saving the same text is not a change');
    ok(mem.update(a.item.id, '   ').error === 'empty' && mem.update(987654, 'x').error === 'not_found' && mem.update('1', 'x').error === 'bad_id' && mem.update(a.item.id, 5).error === 'empty', 'empty text, an unknown note and a bad id are refused');
    mem.addTurn('t-1', 'a sentence', 'a reply');
    const turn = mem.list({ kind: 'turn' }).items[0];
    ok(mem.update(turn.id, 'rewrite history').error === 'not_found', 'a chat turn cannot be edited, only forgotten');
    const key = `sk-or-v1-${'a'.repeat(40)}`;
    const k = mem.update(b.item.id, `Key is ${key}`);
    ok(k.ok === true && !JSON.stringify(mem.list({}).items).includes(key) && k.item.text === 'Key is [redacted]', 'a key in the new text is redacted');
    ok(J(mem).items[0].canRevert === true && J(mem).items[0].to === 'Key is [redacted]' && !JSON.stringify(J(mem).items).includes(key), 'the journal never holds the key either, and the earlier (clean) text can still be restored');
    // undo of an edit puts the earlier text back, and is itself a journaled change
    const edit = J(mem).items.find((x) => x.kind === 'edited' && x.noteId === a.item.id);
    const u = U(mem, edit.id);
    ok(u.ok === true && u.item.text === 'Dentist on Friday' && u.item.id === a.item.id && texts(mem).includes('Dentist on Friday'), 'undo of an edit restores the earlier text', JSON.stringify(u));
    ok(J(mem).items[0].kind === 'edited' && J(mem).items[0].via === 'undo' && J(mem).items[0].to === 'Dentist on Friday', 'and is journaled as a change by undo');
    ok(U(mem, edit.id).ok === false, 'undoing the same edit twice is refused (the note no longer reads as that edit left it)');
    mem.close();
    // the earlier text leaves memory.db and its WAL at once (the journal keeps it for undo, as for a delete)
    const CANARY = 'zumicanaryedit77';
    const f = fresh();
    const n = f.mem.add(`first ${CANARY} text`);
    const has = (p) => fs.existsSync(p) && fs.readFileSync(p).includes(Buffer.from(CANARY));
    const dbf = path.join(f.dataDir, 'memory', 'memory.db');
    ok(has(dbf) || has(`${dbf}-wal`), 'positive control: the canary is in memory.db or its WAL before the edit');
    f.mem.update(n.item.id, 'second text');
    ok(!has(dbf) && !has(`${dbf}-wal`), 'after an edit the earlier text is gone from memory.db and memory.db-wal');
    f.mem.close();
  });
  section('block 9 (R6c C item 3: nothing the model or the page can call wipes everything)', () => {
    const { mem } = fresh();
    ok(!('memory.deleteAll' in mem.handlers) && Object.keys(mem.handlers).every((k) => !/all|wipe|erase|clear|purge/i.test(k.replace(/^memory\./, ''))), 'no rpc handler wipes memory', Object.keys(mem.handlers).join());
    const src = fs.readFileSync(new URL('../tauri/sidecar/main.mjs', import.meta.url), 'utf8');
    ok(!/memory\.deleteAll/.test(src), 'main.mjs does not map memory.deleteAll');
    const inv = JSON.parse(fs.readFileSync(new URL('../docs/migration/api-inventory.json', import.meta.url), 'utf8'));
    const allow = fs.readFileSync(new URL('../tauri/src-tauri/src/rpc_allow_list.rs', import.meta.url), 'utf8');
    const shim = fs.readFileSync(new URL('../tauri/shim/zumi-shim.js', import.meta.url), 'utf8');
    ok(!inv.apis.some((x) => x.name === 'memory.deleteAll') && !allow.includes('memory.deleteAll') && !shim.includes('memory.deleteAll'), 'memory.deleteAll is in no inventory, allow-list or shim');
    ok(typeof mem.deleteAll === 'function', 'the internal function stays for the tests (it is not an rpc)');
    mem.close();
  });
  section('block 10 (R6c C item 4: the chat corrects exactly one note; both routes give one result)', () => {
    const { mem } = fresh();
    const C = (m, t) => (mem.handlers['memory.correct'] ? mem.handlers['memory.correct'](m, t) : { ok: false, error: 'no_handler' });
    ok(typeof mem.correct === 'function' && typeof mem.handlers['memory.correct'] === 'function', 'correct exists (a function and an rpc handler)');
    const d = mem.add('Dentist on Friday');
    mem.add('Prefers short answers');
    mem.add('Gym at 7 on Tuesday');
    const r = C('dentist', 'Dentist on Monday');
    ok(r.ok === true && r.item.id === d.item.id && r.item.text === 'Dentist on Monday' && r.previous === 'Dentist on Friday', 'one matching note is replaced and the old text is handed back for the confirmation', JSON.stringify(r));
    ok(texts(mem).includes('Dentist on Monday') && !texts(mem).includes('Dentist on Friday') && texts(mem).length === 3, 'the tab\'s list shows the corrected text and still has three notes');
    const row = J(mem).items[0];
    ok(row.kind === 'edited' && row.actor === 'agent' && row.via === 'chat' && row.text === 'Dentist on Friday' && row.to === 'Dentist on Monday', 'the correction is journaled as the agent\'s, from chat, with both texts', JSON.stringify(row));
    ok(U(mem, row.id).ok === true && texts(mem).includes('Dentist on Friday'), 'and the person can undo it');
    // the same result from the tab: an edit by id, then the agent finds it by its new words
    mem.update(d.item.id, 'Dentist on Monday at 9');
    const again = C('monday', 'Dentist on Monday at 10');
    ok(again.ok === true && again.item.id === d.item.id, 'a correction finds a note the tab edited (same index, same id)');
    // exactly one: several matches change nothing and name the candidates
    mem.add('Dentist phone: 555-0100');
    const before = texts(mem).join('|');
    const amb = C('dentist', 'whatever');
    ok(amb.ok === false && amb.error === 'ambiguous' && amb.candidates.length === 2 && amb.candidates.every((c) => Number.isInteger(c.id) && typeof c.text === 'string') && texts(mem).join('|') === before, 'two matching notes: refused with both as candidates, nothing changed', JSON.stringify(amb));
    ok(C('zzzzqq', 'x').error === 'not_found' && C('   ', 'x').error === 'bad_match' && C('gym', '   ').error === 'empty' && C(5, 'x').error === 'bad_args', 'no match, no usable words, an empty new text and a bad argument are each refused');
    ok(C('gym', 'Gym at 8').ok === true && texts(mem).includes('Gym at 8'), 'a unique word works');
    ok(mem.list({ kind: 'turn' }).items.length === 0 && (mem.addTurn('t-1', 'my dentist is nice', 'ok'), C('nice', 'x').error === 'not_found'), 'a chat turn is never a correction target');
    const wipe = Object.keys(mem.handlers).filter((k) => /all|wipe|erase|clear|purge/i.test(k.replace(/^memory\./, '')));
    ok(wipe.length === 0, 'the rpc surface the agent loop uses has no wipe');
    mem.close();
  });
} finally {
  // A block that threw leaves its sqlite file open (Windows refuses the delete); say so instead of hiding the failure behind it.
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { console.log(`NOTE temp dir not removed: ${e.message}`); }
}

console.log(`\ncheck:memory-journal ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
