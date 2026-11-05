// The Claude-account quota document (J-05 quota-view): a SIDE FILE <data>/quota.json written by an external publisher
// (quota-pull on the CoS machine), never by the board and never in the journal. A new journal op would crash an older
// release replaying the journal after a rollback; a file the older code never opens cannot. The file is read on every
// request (the publisher replaces it atomically, there is nothing to cache or to invalidate).
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './ops.mjs';

export const QUOTA_FILE = 'quota.json';
export const QUOTA_MAX_BYTES = 256 * 1024;

/**
 * The document as published, or the "nothing published yet" document (200, accounts [], generated_at null + a reason).
 * Anything wrong with the file is a 503 with a short reason, never a 500 and never a silently empty answer.
 * `check(doc)` returns schema errors ({path, message}[]); empty means valid.
 */
export function readQuota(dataDir, check) {
  const file = path.join(dataDir, QUOTA_FILE);
  const unreadable = reason => new BoardError(503, 'quota_unreadable', { reason });
  let raw;
  try {
    if (fs.statSync(file).size > QUOTA_MAX_BYTES) throw unreadable('too_large');
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e instanceof BoardError) throw e;
    if (e.code === 'ENOENT') return { schema: 1, generated_at: null, accounts: [], reason: 'no_quota_file' };
    throw unreadable('unreadable_file');
  }
  let doc;
  try { doc = JSON.parse(raw); } catch { throw unreadable('invalid_json'); }
  const errors = check(doc);
  if (errors.length) throw unreadable(`invalid_shape: ${errors[0].path} ${errors[0].message}`.slice(0, 200));
  return doc;
}
