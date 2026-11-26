// The journal of changes to the user's memory notes (R6 item 2). Upstream: docs/memory.md "The journal", server/memory-journal.ts.
//
// One JSON line per change in <data dir>/memory/journal.ndjson: who (person or agent), how (panel, chat, undo), which note, when, and the
// note's text (for an edit: the earlier text, and `to` the new one), so an undo needs nothing else. It sits outside anything the agent's tools can reach (the agent has no file tool on the
// data dir, and its only write door is the memory.add rpc). A journal write never fails the change it records: the failure is logged and
// the row dropped (upstream's rule). A row whose earlier text held a secret keeps the redacted text and cannot be undone: restoring it
// would write the redaction marker into the user's memory.
//
// A log, not a store: a line that does not parse is skipped. Past MAX_ROWS the file is cut back to the newest KEEP_ROWS (write temp,
// then rename). There is no "Forget all" in the app (owner ruling 19-11); `clear` stays for the tests and an uninstall.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const JOURNAL_FILE = 'journal.ndjson';
export const MAX_ROWS = 500;
export const KEEP_ROWS = 400;
export const LIST_MAX = 200;
export const ACTORS = ['person', 'agent'];
export const WAYS = ['panel', 'chat', 'undo'];
export const SECRET_REASON = 'The earlier text contained sensitive text that was hidden, so it cannot be restored exactly.';

/**
 * @param {{ dir: string, now?: () => number, log?: (m: string) => void, redact: (s: string) => string, id?: () => string }} o
 *   dir: <data dir>/memory. redact: the notes store's own secret redaction (passed in, so this file has no import cycle).
 */
export function createJournal({ dir, now = Date.now, log = () => {}, redact, id = () => crypto.randomUUID() }) {
  const file = path.join(dir, JOURNAL_FILE);
  let lines = null; // rows in the file, counted at the first write

  const parse = (line) => {
    try {
      const v = JSON.parse(line);
      return v && typeof v === 'object' && typeof v.id === 'string' && typeof v.at === 'number' && typeof v.kind === 'string' && Number.isInteger(v.noteId) && typeof v.text === 'string' ? v : null;
    } catch { return null; }
  };
  const readAll = () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
    return text.split('\n').filter(Boolean).map(parse).filter(Boolean);
  };

  /** Appends one row. Returns it, or null when it could not be written (logged). */
  function record({ noteId, kind, actor, via, text, to, createdAt }) {
    try {
      const kept = redact(text);
      const row = {
        id: id(), at: now(), noteId, kind,
        actor: ACTORS.includes(actor) ? actor : 'person',
        via: WAYS.includes(via) ? via : 'panel',
        text: kept, createdAt, canRevert: true,
      };
      // An edit also keeps the text it wrote (`to`), so an undo can tell the note still reads as that edit left it.
      if (typeof to === 'string') row.to = redact(to);
      // A deleted or edited note is put back from the row's text; a text the redaction changed would come back damaged.
      if ((kind === 'deleted' || kind === 'edited') && kept !== text) { row.canRevert = false; row.revertUnavailableReason = SECRET_REASON; }
      fs.mkdirSync(dir, { recursive: true });
      if (lines === null) lines = readAll().length;
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      lines += 1;
      if (lines > MAX_ROWS) trim();
      return row;
    } catch (e) {
      log(`[memory] journal: a change could not be recorded (${String((e && e.message) || e).slice(0, 120)}); the change itself stands`);
      return null;
    }
  }

  function trim() {
    const keep = readAll().slice(-KEEP_ROWS);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    lines = keep.length;
  }

  /** Newest first, at most `limit` (1..LIST_MAX). */
  function list(limit = 50) {
    const n = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), LIST_MAX);
    try { return readAll().reverse().slice(0, n); } catch (e) { log(`[memory] journal: could not be read (${String((e && e.message) || e).slice(0, 120)})`); return []; }
  }

  function find(rowId) {
    try { return readAll().find((r) => r.id === rowId) || null; } catch (e) { log(`[memory] journal: could not be read (${String((e && e.message) || e).slice(0, 120)})`); return null; }
  }

  /** Forget all: the file is removed. Throws if it cannot be (the caller must not claim nothing is kept). */
  function clear() {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.tmp`, { force: true });
    lines = null;
  }

  return { record, list, find, clear, file };
}
