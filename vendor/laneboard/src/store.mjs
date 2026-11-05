// Durable storage: an append-only NDJSON journal (the source of truth) plus one JSON projection
// written temp-then-rename after every accepted event. On open, any journal lines newer than the
// projection are replayed through the same reducer used live, so a crash between "journal fsynced"
// and "projection renamed" heals itself on restart. No database, no custom replay engine.
import fs from 'node:fs';
import path from 'node:path';
import { emptyState, reduce } from './ops.mjs';

export function openStore(dir) {
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  // Streamed uploads land in media/.upload-* first; any left behind by a crash never reached the journal.
  for (const f of fs.readdirSync(path.join(dir, 'media'))) if (f.startsWith('.upload-')) fs.rmSync(path.join(dir, 'media', f), { force: true });
  const journalPath = path.join(dir, 'events.ndjson');
  const projectionPath = path.join(dir, 'state.json');

  let state = emptyState();
  try { state = JSON.parse(fs.readFileSync(projectionPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`projection unreadable, move ${projectionPath} aside to rebuild from the journal: ${e.message}`); }

  // Read the journal; a torn final line (crash mid-write, no trailing newline) is cut off.
  let raw = '';
  try { raw = fs.readFileSync(journalPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (raw && !raw.endsWith('\n')) {
    const keep = raw.lastIndexOf('\n') + 1;
    fs.truncateSync(journalPath, Buffer.byteLength(raw.slice(0, keep)));
    raw = raw.slice(0, keep);
  }
  const events = raw.split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`journal line ${i + 1} is not JSON; refusing to start`); }
  });
  const lastSeq = events.length ? events.at(-1).seq : 0;
  if (state.seq > lastSeq) throw new Error(`projection (seq ${state.seq}) is ahead of the journal (seq ${lastSeq}); refusing to start`);
  let replayed = 0;
  for (const ev of events) if (ev.seq > state.seq) { reduce(state, ev); replayed++; }

  const saveProjection = () => {
    const tmp = projectionPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, projectionPath);
  };
  if (replayed) saveProjection();

  const fd = fs.openSync(journalPath, 'a');
  return {
    get state() { return state; },
    replayed,
    /** Journal first (fsynced), then the in-memory projection, then the projection file. */
    append(ev, { crashAfterJournal = false } = {}) {
      fs.writeSync(fd, JSON.stringify(ev) + '\n');
      fs.fsyncSync(fd);
      if (crashAfterJournal) throw new Error('simulated crash after journal append');
      reduce(state, ev);
      saveProjection();
    },
    readEvents(afterSeq = 0, limit = 200) {
      return fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.seq > afterSeq).slice(0, limit);
    },
    storeBlob(sha256, bytes) {
      const f = path.join(dir, 'media', sha256);
      if (fs.existsSync(f)) return;
      fs.writeFileSync(f + '.tmp', bytes);
      fs.renameSync(f + '.tmp', f);
    },
    blobPath: sha256 => path.join(dir, 'media', sha256),
    uploadTempPath: () => path.join(dir, 'media', `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    /** Moves a fully written temp file to its content address (same directory, so the rename is atomic). */
    adoptBlob(tmp, sha256) {
      const f = path.join(dir, 'media', sha256);
      if (fs.existsSync(f)) fs.rmSync(tmp, { force: true }); else fs.renameSync(tmp, f);
    },
    close() { fs.closeSync(fd); }
  };
}
