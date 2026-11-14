// T-31 bridge self-heal 2 (field report 14-11: the Board tab died again and nothing on disk said why; the sidecar's log went
// to the host's stderr only, which a release build drops). A bounded, persistent log at <data-dir>/logs/sidecar.log:
// one ISO-timed line per event, rotated to sidecar.log.1 at ~1 MB (one old file kept), so at most ~2 MB on disk.
// Every line is scrubbed before it is written: URL credentials, query strings, auth headers, cookies, token/password
// pairs and long hex/base64 runs. Callers already log codes and origins only; this is the second fence.
// A write never throws: losing a log line must not take the sidecar down.
import fs from 'node:fs';
import path from 'node:path';

export const SIDECAR_LOG_MAX_BYTES = 1_000_000;

// gate GATE-OPUS-037-DELTA3 S1: the scrub runs synchronously on the sidecar thread for every line (the stderr tee too), and
// several URL rules are quadratic on long word runs. A line is cut to this many chars BEFORE it is scrubbed; the rest is
// dropped, never logged, so the cut cannot let a secret through. Real lines are well under 200 chars.
export const SIDECAR_LOG_LINE_MAX = 2048;
// key=value / key: value keys: one maximal [a-z0-9_-] run, started where no such char precedes it, so a long run is
// scanned once (the old `[a-z0-9_-]*word[a-z0-9_-]*` form backtracked cubically: 4 KB of `xtokenx-` took 5.6 s).
const SECRET_KEY_EQ = /token|pass|password|secret|key|pin|cookie|nonce|zumi_bridge/i;
const SECRET_KEY_ANY = /password|passwd|secret|token|cookie|authorization|api[-_]?key/i;

/** Removes anything secret-shaped from one log line, keeping the origin/port and the event words. */
export function sanitizeLogLine(input) {
  let line = String(input), cut = '';
  if (line.length > SIDECAR_LOG_LINE_MAX) {
    const sp = line.lastIndexOf(' ', SIDECAR_LOG_LINE_MAX);
    const end = sp > SIDECAR_LOG_LINE_MAX - 256 ? sp : SIDECAR_LOG_LINE_MAX; // end on a word break when one is near: no half token
    cut = ` [+${line.length - end} chars cut]`;
    line = line.slice(0, end);
  }
  return line
    .replace(/[\r\n]+/g, ' ')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1***@') // user:pass@ in any URL
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1?***') // query strings and fragments (nonces, tokens)
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|x-[a-z0-9-]*token)\b\s*[:=]\s*\S+(\s+\S+)?/gi, '$1: ***')
    .replace(/\b(Basic|Bearer)\s+\S+/gi, '$1 ***')
    .replace(/(?<![a-z0-9_-])(?=([a-z0-9_-]+))\1\s*=\s*\S+/gi, (m, key) => (SECRET_KEY_EQ.test(key) ? `${key}=***` : m))
    // gate S-c (GATE-OPUS-HEAL2 S3): key:value too, and quoted JSON keys/values. Whole key names only (`pass`/`pin` exact),
    // so event lines such as "load failed: ..." or "mode at start: local" stay readable.
    .replace(/(["']?)(?<![a-z0-9_-])(?=([a-z0-9_-]+))\2\1(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, (m, q, key, sep) => (SECRET_KEY_ANY.test(key) || /^(pass|pin)$/i.test(key) ? `${q}${key}${q}${sep}***` : m))
    .replace(/\b(sk|lbt|pk|ghp|xox[a-z])[-_][A-Za-z0-9_-]{6,}/g, '***')
    .replace(/\b[0-9a-f]{24,}\b/gi, '***')
    .replace(/[A-Za-z0-9+/]{24,}={0,2}/g, '***') + cut;
}

/**
 * @param {{dataDir: string, maxBytes?: number, now?: () => Date}} o
 * @returns {{file: string, write: (line: string) => void}}
 */
export function createSidecarLog({ dataDir, maxBytes = SIDECAR_LOG_MAX_BYTES, now = () => new Date() }) {
  const dir = path.join(dataDir, 'logs');
  const file = path.join(dir, 'sidecar.log');
  let size = null;
  function write(line) {
    try {
      if (size === null) { fs.mkdirSync(dir, { recursive: true }); try { size = fs.statSync(file).size; } catch { size = 0; } }
      const text = `${now().toISOString()} ${sanitizeLogLine(line)}\n`;
      if (size > 0 && size + Buffer.byteLength(text) > maxBytes) {
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`);
        size = 0;
      }
      fs.appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch { size = null; /* a full or read-only disk loses the line, never the sidecar */ }
  }
  return { file, write };
}

/**
 * Wall-clock gap detector: ticks every `everyMs`; a tick that finds more than `gapMs` since the last one logs both the
 * wall-clock and the monotonic delta. Wall jumps with a normal monotonic delta = a clock step (NTP, a manual change, or a
 * sleep the monotonic clock did not count); both jumping = the process was frozen (sleep/resume, a suspended process).
 * @param {{log: (m: string) => void, everyMs?: number, gapMs?: number, wallNow?: () => number, monoNow?: () => number}} o
 */
export function createClockGapWatch({ log, everyMs = 5_000, gapMs = 15_000, wallNow = Date.now, monoNow = () => performance.now() }) {
  let lastWall = wallNow(), lastMono = monoNow(), timer = null;
  function tick() {
    const w = wallNow(), m = monoNow();
    const dw = w - lastWall, dm = m - lastMono;
    lastWall = w; lastMono = m;
    if (dw > gapMs || dm > gapMs || dw < -gapMs) log(`wall-clock gap ${Math.round(dw / 1000)} s, monotonic ${Math.round(dm / 1000)} s (sleep/resume, a frozen process, or a clock jump)`);
  }
  return {
    tick,
    start() { if (!timer) { timer = setInterval(tick, everyMs); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
