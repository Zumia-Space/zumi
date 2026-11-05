'use strict';
// Jev fast-reflex client — the ONLY place in the app that talks to openrouter.ai.
// Mirrors cloud.js's rules (the intent spike's REPORT.md backs the numbers below):
//   - one allowlisted origin (ALLOWED_ORIGIN), https only, no redirects;
//   - egress is OFF unless the caller explicitly says so (test build / ZUMI_TEST_JEV) — a release build never
//     constructs a live transport, so there is nothing for this module to leak network to;
//   - the API key lives encrypted with Electron safeStorage (Windows DPAPI); no plaintext fallback;
//   - the key never reaches the renderer, logs, URLs or argv; every error string is scrubbed first;
//   - classify() returns ONLY {reaction, confidence, source, decider, ms} — never raw probabilities, never the key.
// Fallback order (REPORT.md section 3): Jev (network, ~400ms warm) -> local embedding classifier (LAZY, only
// loaded the first time it is actually needed: Jev off/erroring/timed out) -> local keyword rules (reflex-rules.js,
// T-31 QC-cuoi fix b: the embedding model is not vendored, so without this every slow Jev call ended neutral)
// -> neutral. Below confidence 0.70 (REPORT.md section 2, the zero-wrong-reaction optimum) a reaction is replaced
// by the neutral listening pose. Every classify() logs which decider chose: jev | local | rules | none.
const fs = require('node:fs');
const path = require('node:path');
const { classifyRules } = require('./reflex-rules.js');

const JEV_MODEL = 'typesafe/jev-1.13';
const ALLOWED_ORIGIN = 'https://openrouter.ai';
const DECISIONS_PATH = '/api/alpha/decisions';
// Free GET on the same host/origin (no decision = no charge): opens the keep-alive HTTP/TLS connection at
// startup so the FIRST real Enter is warm, without spending one of the 60 calls this task is capped at.
const WARM_PATH = '/api/v1/models';
const TIMEOUT_MS = 900; // Enter -> parsed answer budget (REPORT.md: p95 ~445ms warm; 800ms was the spike's budget, +100ms margin)
const CONF_THRESHOLD = 0.70;
const MESSAGE_MAX_CHARS = 2000;

const LABELS = ['listen', 'nod', 'surprise', 'think', 'happy', 'concern', 'shrug', 'neutral'];
const LABEL_DESC = {
  listen: 'Lean in attentively: the user asks Zumi to do a task, or starts telling or describing something.',
  nod: 'Nod: the user agrees, confirms, accepts a proposal, or acknowledges.',
  surprise: 'Surprised look: the user shares something unexpected or astonishing, or reacts with disbelief.',
  think: 'Thinking pose: the user asks a question that needs reasoning, knowledge, comparison or advice.',
  happy: 'Happy and warm: a greeting, thanks, praise, good news, celebration, affection or a joke.',
  concern: 'Concerned look: the user complains, reports a problem or bad news, or feels sad, tired, stressed or unwell.',
  shrug: 'Shrug: the user is unsure, undecided, indifferent, or leaves the choice to Zumi.',
  neutral: 'Neutral listening pose: the line has no clear intent (filler, a test input, a lone sound, unclear text).',
};

// sk-or-... (OpenRouter key shape). Same idea as cloud.js's TOKEN_SHAPE: a shape gate, not a secret check.
const KEY_SHAPE = /^sk-or-[A-Za-z0-9_-]{20,200}$/;

function scrub(s, key) {
  let t = String(s == null ? '' : s);
  if (key) t = t.split(key).join('***');
  return t.replace(/sk-or-[\w-]+/g, 'sk-or-***').slice(0, 300);
}

function assertAllowedUrl(pathname) {
  const u = new URL(pathname, ALLOWED_ORIGIN);
  if (u.origin !== ALLOWED_ORIGIN || u.protocol !== 'https:') throw new Error('reflex-jev: url is not the allowlisted origin');
  return u;
}

// ---------- key store (safeStorage / DPAPI) ----------
// Provisioning (operator -> spare machine): the operator copies the raw key (never the whole secrets file) into
// <userData>/jev-key.import once; the next start encrypts it into jev-key.bin and DESTROYS the import file. The
// renderer never sees either file. Mirrors cloud.js's createTokenStore exactly.
// name: the key file base (T-31 BYOK): the default 'jev' keeps <userData>/jev-key.bin -- the one store the OpenRouter
// path and the Jev reflex have always shared. A BYOK provider passes its own name (e.g. 'gemini'), so each provider's
// key lives in its own file and switching providers never deletes another key. shape: the key-format gate (a shape
// gate, not a secret check); default KEY_SHAPE (sk-or-...) keeps OpenRouter behaviour byte-for-byte.
function createKeyStore({ safeStorage, dir, log = () => {}, name = 'jev', shape = KEY_SHAPE }) {
  const bin = path.join(dir, `${name}-key.bin`);
  const imp = path.join(dir, `${name}-key.import`);
  // The key's last 4 characters, cached in the clear whenever the key is written (import or in-app entry), so a
  // Settings status read never has to decrypt the whole key (Fable/Sol gate 09-10, nit 4). 4 characters of a 20+
  // character random key: the same disclosure the Settings card already shows.
  const l4File = path.join(dir, `${name}-key.last4`);
  const L4_SHAPE = /^[A-Za-z0-9_-]{4}$/;
  const cacheLast4 = (raw) => { try { fs.writeFileSync(l4File, raw.slice(-4)); } catch { /* the next last4() refills it */ } };
  const available = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
  function importIfPresent() {
    if (!fs.existsSync(imp)) return 'none';
    if (!available()) { log('jev key import skipped: OS encryption unavailable (Jev stays off)'); return 'no-encryption'; }
    const raw = fs.readFileSync(imp, 'utf8').trim();
    try {
      if (!shape.test(raw)) { log('jev key import refused: unexpected format'); return 'bad-format'; }
      const tmp = `${bin}.tmp`;
      fs.writeFileSync(tmp, safeStorage.encryptString(raw));
      fs.renameSync(tmp, bin);
      cacheLast4(raw);
      log('jev key imported (encrypted with the OS key)');
      return 'imported';
    } finally {
      // Overwrite before unlink: best-effort against undelete, same as cloud.js.
      try { fs.writeFileSync(imp, Buffer.alloc(Math.max(64, raw.length), 0)); fs.unlinkSync(imp); } catch { /* best effort */ }
    }
  }
  function read() {
    if (!available() || !fs.existsSync(bin)) return null;
    try { const k = safeStorage.decryptString(fs.readFileSync(bin)); return shape.test(k) ? k : null; } catch { return null; }
  }
  // In-app entry (Settings > AI brain, T-31 settings-a2): the same encrypted file the import flow writes -- one key,
  // one file, one mechanism. Shape-gated, OS encryption required (no plaintext fallback), atomic tmp+rename.
  function write(raw) {
    if (!available()) return { ok: false, error: 'no_encryption' };
    if (typeof raw !== 'string' || !shape.test(raw)) return { ok: false, error: 'bad_format' };
    try {
      const tmp = `${bin}.tmp`;
      fs.writeFileSync(tmp, safeStorage.encryptString(raw));
      fs.renameSync(tmp, bin);
      cacheLast4(raw);
      return { ok: true };
    } catch (e) {
      log(`key write failed: ${scrub(e && e.message, raw)}`);
      return { ok: false, error: 'write_failed' };
    }
  }
  // Removes the key from this PC: the encrypted file, and a pending plaintext import file too (overwritten first,
  // like importIfPresent) so a cleared key cannot come back on the next start.
  function clear() {
    try { if (fs.existsSync(imp)) { fs.writeFileSync(imp, Buffer.alloc(Math.max(64, fs.statSync(imp).size), 0)); fs.unlinkSync(imp); } } catch { /* best effort */ }
    try { fs.rmSync(bin, { force: true }); fs.rmSync(`${bin}.tmp`, { force: true }); fs.rmSync(l4File, { force: true }); return true; } catch { return false; }
  }
  // Last 4 of the stored key WITHOUT decrypting it (null = no key). A key stored before this cache existed is
  // decrypted once to fill the cache; every later call reads the cache only.
  function last4() {
    if (!fs.existsSync(bin)) return null;
    try { const v = fs.readFileSync(l4File, 'utf8').trim(); if (L4_SHAPE.test(v)) return v; } catch { /* no cache yet */ }
    const k = read();
    if (!k) return null;
    cacheLast4(k);
    return k.slice(-4);
  }
  return { importIfPresent, read, write, clear, last4, available, file: bin, importFile: imp, last4File: l4File };
}

// ---------- Jev transport ----------
// One call; returns {ok, ms, reaction, confidence, usage} | {ok:false, ms, error, usage} (error is pre-scrubbed,
// key-free). usage mirrors chat-brain.js's callChat: {in, out, total} from OpenRouter's own `usage` field, or null
// when the response carries none (e.g. an http error, before any body is parsed) -- T-31 owner-admin + usage.
async function callJev(text, key, { fetchImpl = fetch } = {}) {
  const t0 = Date.now();
  const url = assertAllowedUrl(DECISIONS_PATH);
  const body = JSON.stringify({
    model: JEV_MODEL,
    state: 'Zumi is a friendly desktop AI companion avatar. The user just pressed Enter on the chat message below '
      + '(English or Vietnamese, possibly typed without diacritics). Zumi must react with her body at once, before any '
      + `reply is written.\nUser message: ${JSON.stringify(String(text).slice(0, MESSAGE_MAX_CHARS))}`,
    questions: { reaction: { type: 'choice', instructions: 'Which immediate non-verbal reaction should Zumi show to this message?', criteria: LABEL_DESC } },
  });
  try {
    const res = await fetchImpl(url.href, {
      method: 'POST',
      redirect: 'error', // a bearer is never forwarded across a redirect
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, error: scrub(`http_${res.status}`, key), usage: null };
    const j = await res.json().catch(() => null);
    const a = j && j.answers && j.answers.reaction;
    const probs = a && a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : null;
    const choice = a ? (a.choice ?? a.answer ?? null) : null;
    const conf = a ? (a.confidence ?? (probs ? Math.max(...Object.values(probs)) : null)) : null;
    const u = j && j.usage;
    const usage = u ? { in: u.prompt_tokens || 0, out: u.completion_tokens || 0, total: u.total_tokens || 0 } : null;
    if (!choice || !LABELS.includes(choice) || typeof conf !== 'number') return { ok: false, ms, error: 'bad_response', usage };
    return { ok: true, ms, reaction: choice, confidence: conf, usage };
  } catch (e) {
    const ms = Date.now() - t0;
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, ms, error: scrub(timeout ? 'timeout' : (e && e.message) || String(e), key), usage: null };
  }
}

// ---------- call ledger (test-time safety net, OFF by default) ----------
// A call is counted (and the ledger written) BEFORE the request leaves, same discipline as the spike's
// jev.mjs, so an aborted call still counts. With no file configured there is no cap at all (normal product
// behaviour) — this exists only so a measurement run can enforce its own hard cap in code, not by hand.
function createCallLedger(file, cap) {
  if (!file || !cap) return { count: () => true, total: () => 0 };
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { cap, total: 0 }; } };
  function count() {
    const l = load();
    if (l.total >= cap) return false;
    l.total++;
    fs.writeFileSync(file, JSON.stringify(l, null, 1));
    return true;
  }
  return { count, total: () => load().total };
}

// ---------- the module main.js wires to IPC ----------
// opts: { egressAllowed, safeStorage, dir, log, fetchImpl, loadLocal: () => Promise<{classify(text)}>,
//         callLedgerFile, callLedgerCap, onUsage }
//   onUsage({model, kind:'jev', in, out, total, ms, ok}): called once per REAL callJev attempt (success or
//     failure) -- never when egress/key is off or the test-only call-ledger cap skipped it (no call was made).
//     Swallowed here -- a usage-ledger problem must never surface as a classify() failure (T-31 owner-admin + usage).
function createReflexJev(opts = {}) {
  const log = opts.log || (() => {});
  const egressAllowed = Boolean(opts.egressAllowed);
  const keys = egressAllowed && opts.safeStorage ? createKeyStore({ safeStorage: opts.safeStorage, dir: opts.dir, log }) : null;
  if (keys) keys.importIfPresent();
  const ledger = createCallLedger(opts.callLedgerFile, opts.callLedgerCap);
  const reportUsage = (rec) => { if (opts.onUsage) { try { opts.onUsage(rec); } catch (e) { log(`onUsage failed: ${(e && e.message) || e}`); } } };

  let localClassifier = null;
  let localLoadFailed = false;
  async function loadLocalIfNeeded() {
    if (localClassifier || localLoadFailed || !opts.loadLocal) return localClassifier;
    try { localClassifier = await opts.loadLocal(); } catch (e) { localLoadFailed = true; log(`local classifier unavailable: ${scrub(e && e.message)}`); }
    return localClassifier;
  }

  // Pre-warm: opens the keep-alive connection to openrouter.ai with a FREE GET (never the paid decisions route),
  // so the first real Enter after launch does not also pay the ~0.5-1.0s cold TLS/DNS/TCP cost (REPORT.md 1a/1b).
  function warm() {
    if (!egressAllowed || !keys) return;
    const key = keys.read();
    if (!key) return;
    const url = assertAllowedUrl(WARM_PATH);
    (opts.fetchImpl || fetch)(url.href, { method: 'GET', headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) }).catch(() => {});
  }

  // One log line per Enter, metadata only (never the text): which decider chose, what, how fast.
  const decided = (r, decider) => { log(`decider=${decider} reaction=${r.reaction} ms=${r.ms}`); return { ...r, decider }; };

  async function classify(text) {
    const t0 = Date.now();
    if (egressAllowed && keys) {
      const key = keys.read();
      if (key && !ledger.count()) log(`jev classify skipped: call ledger cap reached (${ledger.total()}/${opts.callLedgerCap})`);
      else if (key) {
        const r = await callJev(text, key, { fetchImpl: opts.fetchImpl });
        // Logged for success AND failure alike -- a real call left openrouter.ai either way (usage-ledger plan item 2).
        const u = r.usage || {};
        reportUsage({ model: JEV_MODEL, kind: 'jev', in: u.in || 0, out: u.out || 0, total: u.total || 0, ms: r.ms, ok: r.ok });
        if (r.ok) {
          const ms = Date.now() - t0;
          return decided(r.confidence >= CONF_THRESHOLD
            ? { reaction: r.reaction, confidence: r.confidence, source: 'jev', ms }
            : { reaction: 'neutral', confidence: r.confidence, source: 'jev', ms }, 'jev');
        }
        log(`jev classify failed: ${r.error}`);
      }
    }
    const local = await loadLocalIfNeeded();
    if (local) {
      try {
        const r = await local.classify(text);
        const ms = Date.now() - t0;
        if (r && typeof r.conf === 'number' && LABELS.includes(r.label)) {
          return decided(r.conf >= CONF_THRESHOLD ? { reaction: r.label, confidence: r.conf, source: 'local', ms } : { reaction: 'neutral', confidence: r.conf, source: 'local', ms }, 'local');
        }
      } catch (e) { log(`local classify failed: ${scrub(e && e.message)}`); }
    }
    const rule = classifyRules(text);
    if (rule && LABELS.includes(rule.label)) return decided({ reaction: rule.label, confidence: rule.conf, source: 'rules', ms: Date.now() - t0 }, 'rules');
    return decided({ reaction: 'neutral', confidence: 0, source: 'neutral', ms: Date.now() - t0 }, 'none');
  }

  return { classify, warm, egressAllowed, keyFile: keys && keys.file };
}

module.exports = {
  createReflexJev, createKeyStore, createCallLedger, callJev, scrub, assertAllowedUrl,
  LABELS, LABEL_DESC, CONF_THRESHOLD, TIMEOUT_MS, ALLOWED_ORIGIN, DECISIONS_PATH, WARM_PATH, JEV_MODEL, KEY_SHAPE,
};
