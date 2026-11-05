'use strict';
// Shared pieces of the BYO voice adapters (T-31 talk-mode, PLAN section 10.1). Every adapter returns the same shape,
//   { ok: true, mime, audios: [Buffer], voice } | { ok: false, error: { code, message, retryable } }
// and shares the same rules: redirect:'error', a timeout, a 10 MB response cap, scrubbed error strings. Keeping the
// rules in one place is what lets the adapters stay small and lets check-tts-providers test them once.

const MAX_BYTES = 10 * 1024 * 1024; // response cap (PLAN section 10.1)
const MAX_CHARS = 2000;             // input cap: min(provider limit, today's MAX_CHARS)
const DEFAULT_TIMEOUT_MS = 9000;

/** Typed failure. `code` is from the fixed set in PLAN section 10.1. */
const fail = (code, message, retryable = false) => ({ ok: false, error: { code, message: String(message || code).slice(0, 300), retryable } });

/** Strip the key from any string that could reach a log, an error message or the renderer. */
function scrub(s, ...keys) {
  let t = String(s == null ? '' : s);
  for (const key of keys) if (key) t = t.split(key).join('***');
  return t.slice(0, 300);
}

/** HTTP status -> typed error code (PLAN section 10.1). 5xx and 429 are retryable. */
function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  return `http_${status}`;
}
const retryableStatus = (status) => status === 429 || status >= 500;

/** An aborted/timed-out fetch is 'timeout'; anything else thrown is 'internal'. The message is always scrubbed. */
function failFromThrown(e, ...keys) {
  const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return fail(timeout ? 'timeout' : 'internal', scrub((e && e.message) || String(e), ...keys), true);
}

/**
 * Read a response body with the 10 MB cap. A declared content-length over the cap is refused before reading.
 * -> { ok: true, buf: Buffer } | { ok: false, error }
 */
async function readCapped(res, max = MAX_BYTES) {
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
  if (Number.isFinite(declared) && declared > max) return fail('too_large', 'response too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) return fail('too_large', 'response too large');
  return { ok: true, buf };
}

/** The failure for a non-2xx response: reads a small slice of the body for the message (scrubbed). */
async function failFromResponse(res, ...keys) {
  let body = '';
  try { body = (await readCapped(res, 64 * 1024)).buf?.toString('utf8') || ''; } catch { /* no body */ }
  let msg = body;
  try { const j = JSON.parse(body); msg = (j && (j.error && (j.error.message || j.error) || j.detail && (j.detail.message || j.detail) || j.message)) || body; } catch { /* not json */ }
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  return fail(httpErrorCode(res.status), scrub(msg, ...keys), retryableStatus(res.status));
}

const contentTypeOf = (res) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '') || '';

/**
 * Custom-endpoint URL rules (PLAN section 10.1): https only, except http://127.0.0.1 and http://localhost (local
 * servers such as Kokoro-FastAPI); no userinfo; a host is required. Used by the setter AND again at call time.
 * -> { ok: true, url: string (no trailing slash) } | { ok: false, reason }
 */
function validateCustomUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) return { ok: false, reason: 'empty' };
  let u;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: 'bad_url' }; }
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  if (!u.hostname) return { ok: false, reason: 'no_host' };
  const loopback = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if (u.protocol !== 'https:' && !loopback) return { ok: false, reason: 'not_https' };
  if (u.search || u.hash) return { ok: false, reason: 'query' };
  return { ok: true, url: u.href.replace(/\/+$/, '') };
}

module.exports = { MAX_BYTES, MAX_CHARS, DEFAULT_TIMEOUT_MS, fail, scrub, httpErrorCode, retryableStatus, failFromThrown, failFromResponse, readCapped, contentTypeOf, validateCustomUrl };
