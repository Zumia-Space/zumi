// Durable log of the links and open requests main.js refused (review v6 C1: a packaged GUI app started from the Start
// menu has no console, so console.warn alone left "refused and logged" true only in a terminal). One line per refusal:
//   <ISO time> <reason> <scheme://host[:port] | scheme: | ->
// Only the reason and the origin are written: never a path, a query string, a fragment, userinfo or a token (an ask's
// link can carry any of those). The file is capped: when the next line would push it past maxBytes, it is renamed to
// <file>.1 (replacing the previous old copy) and a new file starts, so at most 2 x maxBytes stay on disk.
// No Electron here: main.js passes <userData>/logs; scripts/check-board-open.mjs tests it on a scratch folder.
import fs from 'node:fs';
import path from 'node:path';

export const REFUSAL_LOG_NAME = 'board-open-refusals.log';
export const REFUSAL_LOG_MAX_BYTES = 256 * 1024;

// scheme://host[:port] for http(s) (URL.host never carries userinfo, path or query), the scheme alone for any other
// parsable URL (file:, javascript:, …), '-' for anything else.
export function safeOrigin(value) {
  let u;
  try { u = new URL(String(value ?? '')); } catch { return '-'; }
  if (u.protocol === 'http:' || u.protocol === 'https:') return /^[a-z0-9.:[\]-]+$/i.test(u.host) ? `${u.protocol}//${u.host}` : '-';
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) ? u.protocol : '-';
}

/**
 * Append one refusal line. Throws on a filesystem error (main.js reports it on its own console line; the refusal
 * itself already happened, nothing is opened either way).
 * @param {string} dir  the logs folder (created when missing)
 * @param {{ reason: string, origin?: string }} refusal  board-open.mjs's refuse() answer
 * @param {{ now?: Date, maxBytes?: number }} [o]
 * @returns {string} the line written (without the newline)
 */
export function appendRefusal(dir, { reason, origin } = {}, { now = new Date(), maxBytes = REFUSAL_LOG_MAX_BYTES } = {}) {
  const line = `${now.toISOString()} ${/^[a-z_]+$/.test(String(reason)) ? reason : 'unknown'} ${safeOrigin(origin)}`;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, REFUSAL_LOG_NAME);
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (size > 0 && size + line.length + 1 > maxBytes) fs.renameSync(file, `${file}.1`); // replaces the previous old copy
  fs.appendFileSync(file, `${line}\n`);
  return line;
}
