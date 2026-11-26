// R6e M3: the run list's secret rules, in JS, for what memory writes to disk. A line for line port of tauri/zumi-agent-loop/src/redact.rs
// (itself the upstream app's shared/redact.ts, v0.1.169, plus the two extra rules: a database-credential name and a private key with no END
// line), so a turn or a note holds the same masks the run list shows: `«redacted N chars»`, N in UTF-16 units.
// The two ports are kept in step by vectors both read: zumi-agent-loop tests/data/redact-parity.json (upstream's own outputs, over a corpus)
// and tests/data/redact-extra.json (the two extra rules); scripts/check-memory-redact.mjs runs them here, tests/redact_parity.rs in Rust.
// Not a promise to catch every secret a person can type: a password with no shape stays. The Memory tab says what is kept.

const MARKER = /^«redacted \d+ chars»$/;
const mask = (value) => (MARKER.test(value) ? value : `«redacted ${value.length} chars»`);

const KEY_PREFIXES = [
  /\bom[dg]_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bxai-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{40,}/g,
  /\bcsk-[A-Za-z0-9]{32,}/g,
  /\bLLM\|\d{6,}\|[A-Za-z0-9_-]{16,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bpypi-AgE[A-Za-z0-9_-]{82,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgl(?:pat|dt|rtr?)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g,
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g,
  /\bxapp-\d-[A-Za-z0-9-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bntn_[A-Za-z0-9]{46}(?![A-Za-z0-9_-])/g,
  /\bpplx-[A-Za-z0-9]{48}(?![A-Za-z0-9_-])/g,
  /\bwhsec_[A-Za-z0-9_-]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  /\bbak_[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
const BASIC_AUTH = /(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9._~+/=-])/gi;
const PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;
const KEY_VALUE = /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;
const KEY_SUFFIX_ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_-]*[_-]key)s?(=)(["']?)([A-Za-z0-9._~+/=-]+)\3/gi;
// Extra rule 1 (not upstream): DB_PASS / MYSQL_PWD / REDIS_PASS / SMTP_PASS ... at any value length.
const DB_CREDENTIAL = /\b((?:[A-Za-z0-9]+[_-])*(?:db|database|mysql|postgres|pg|redis|mongo|mongodb|smtp)[_-](?:pass|pwd))(=)(["']?)([A-Za-z0-9._~+/=-]+)\3/gi;
const SECRET_FLAG = /(--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)(?:=|\s+))(["']?)(?!-)([A-Za-z0-9._~+/=-]+)\2/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:)([^\s/@'"«»]+)(@)/gi;

const assignment = (_m, key, sep, quote, value) => `${key}${sep}${quote}${mask(value)}${quote}`;

/** Extra rule 2: the first private-key header with no END line after it keeps the header and loses everything after it. */
function truncatedPrivateKey(text) {
  for (const m of text.matchAll(new RegExp(PRIVATE_KEY_BLOCK.source, 'g'))) {
    const end = m.index + m[0].length;
    const rest = text.slice(end);
    if (PRIVATE_KEY_END.test(rest)) continue; // a complete block was masked by PEM_BLOCK already
    const body = rest.trim();
    return body ? `${text.slice(0, end)}
${mask(body)}` : text;
  }
  return text;
}

/** `text` with credentials masked, in upstream's order; the same answer as redact.rs `redact_secrets`. */
export function redactRun(text) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length < 8) return s;
  let out = s.replace(PEM_BLOCK, (_m, open, body, close) => `${open}\n${mask(body.trim())}\n${close}`);
  out = truncatedPrivateKey(out);
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = out.replace(BEARER, (_m, lead, tok) => `${lead}${mask(tok)}`);
  out = out.replace(BASIC_AUTH, (_m, lead, creds) => `${lead}${mask(creds)}`);
  out = out.replace(KEY_VALUE, assignment);
  out = out.replace(KEY_SUFFIX_ASSIGNMENT, assignment);
  out = out.replace(DB_CREDENTIAL, assignment);
  out = out.replace(SECRET_FLAG, (_m, flag, quote, value) => `${flag}${quote}${mask(value)}${quote}`);
  out = out.replace(URL_USERINFO, (_m, lead, secret, at) => `${lead}${mask(secret)}${at}`);
  return out;
}
