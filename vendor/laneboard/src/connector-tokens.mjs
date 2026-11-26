// J-05 connector tokens (CoS ruling 19-11, least privilege): the delivery connector's own credential. A connector token is NOT a
// board token: board.authenticate() never resolves it, so every board op and every board read answers it 401. It is accepted only
// by the delivery routes (marks, presence, the open list, the pointer stream, /delivery/me). Owner-only issue / list / revoke; any
// number, each labelled.
//
// Kept in <data>/connector-tokens.json (sha256 only, written temp-then-rename, mode 0600), never in the journal, for the same reason
// as the delivery marks (src/delivery.mjs): the reducer refuses an unknown op, and a journaled token.issue with a new role would give
// an older release (which treats any non-reporter role as a full reader) a connector that can read the whole board. With a side file
// an older release replays the journal unchanged and simply does not know these tokens: they fail closed on a rollback.
// A file that cannot be read is never overwritten: tokens fail closed and issuing answers 409 until the owner repairs it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BoardError } from './ops.mjs';

export const CONNECTOR_TOKENS_MAX = 50;
/** The only paths a connector token is accepted on. The server answers a connector-shaped bearer (lbc_...) 401 on every other path,
 *  valid or revoked, even where no token gets the public view; deploy/nginx-connector.conf exposes exactly these. */
export const CONNECTOR_PATHS = Object.freeze(['/api/v1/delivery', '/api/v1/delivery/open', '/api/v1/delivery/me', '/api/v1/delivery/stream', '/api/v1/presence']);
/** A connector token's shape (board tokens are lb_...). */
export const isConnectorShaped = secret => typeof secret === 'string' && secret.startsWith('lbc_');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

export function openConnectorTokens(dataDir, { now = Date.now, log = console.warn } = {}) {
  const file = path.join(dataDir, 'connector-tokens.json');
  let tokens = [], broken = false;
  try {
    tokens = JSON.parse(fs.readFileSync(file, 'utf8')).tokens;
    if (!Array.isArray(tokens)) throw new Error('no tokens array');
    // a hand-edited entry (hash not 64 hex, no id) would make timingSafeEqual throw on every call: refuse the whole file instead
    const bad = tokens.find(t => !t || typeof t.id !== 'string' || !/^[0-9a-f]{64}$/.test(t.sha256 || ''));
    if (bad) throw new Error(`bad entry ${JSON.stringify(bad?.id ?? null)}`);
  }
  catch (e) { tokens = []; if (e.code !== 'ENOENT') { broken = true; log(`connector-tokens.json unreadable (${e.message}): connector tokens fail closed; repair or move the file aside`); } }
  const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ tokens }, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); };
  const pub = t => ({ id: t.id, role: 'connector', label: t.label, ...(t.lane ? { lane: t.lane } : {}), created_at: t.created_at, ...(t.revoked_at ? { revoked_at: t.revoked_at } : {}) });
  return {
    /** The active token for a secret, as the public record, or null. Constant-time over the stored hashes. */
    authenticate(secret) {
      if (!isConnectorShaped(secret)) return null;
      const h = Buffer.from(sha256(secret), 'hex');
      const t = tokens.find(x => crypto.timingSafeEqual(Buffer.from(x.sha256, 'hex'), h));
      return t && !t.revoked_at ? pub(t) : null;
    },
    issue({ label, lane } = {}) {
      if (broken) throw new BoardError(409, 'connector_tokens_unreadable');
      if (typeof label !== 'string' || !label.trim()) throw new BoardError(400, 'label_required');
      if (label.length > 80 || (lane !== undefined && (typeof lane !== 'string' || lane.length > 64))) throw new BoardError(400, 'invalid_field');
      if (tokens.filter(t => !t.revoked_at).length >= CONNECTOR_TOKENS_MAX) throw new BoardError(429, 'too_many_connector_tokens', { max: CONNECTOR_TOKENS_MAX });
      const secret = 'lbc_' + crypto.randomBytes(32).toString('base64url');
      const id = `ctk-${tokens.reduce((n, t) => Math.max(n, Number(t.id.slice(4)) || 0), 0) + 1}`;
      tokens.push({ id, label: label.trim(), ...(lane ? { lane } : {}), sha256: sha256(secret), created_at: new Date(now()).toISOString() });
      save();
      return { ...pub(tokens.at(-1)), token: secret };
    },
    list() { return tokens.map(pub); },
    revoke(id) {
      if (broken) throw new BoardError(409, 'connector_tokens_unreadable');
      const t = tokens.find(x => x.id === id);
      if (!t) throw new BoardError(404, 'not_found', { id });
      if (!t.revoked_at) { t.revoked_at = new Date(now()).toISOString(); save(); }
      return pub(t);
    }
  };
}
