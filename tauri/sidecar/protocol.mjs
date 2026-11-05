// T-31 P1a sidecar — JSON-RPC 2.0 wire contract (framing + helpers).
//
// Framing: one JSON object per line (NDJSON) over the sidecar's stdin/stdout. stdout carries ONLY
// protocol messages; every log goes to stderr (see main.mjs). This is the "framed stdio" of
// docs/migration/PLAN.md §4 in its simplest correct form — fixed by this constant, not negotiated.

export const PROTOCOL_VERSION = 1;

// JSON-RPC 2.0 error codes we use.
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INTERNAL = -32603;

// A standard JSON-RPC error code except an unimplemented method/user, where main.js has to *run* it.
// The convention `not_implemented:<name>` is what the renderer sees; the shim never invents a value.
export function notImplemented(method) {
  return `not_implemented:${method}`;
}

export function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// The startup handshake: the host verifies PROTOCOL_VERSION before it trusts any response.
export function ready(version) {
  return { jsonrpc: '2.0', method: 'ready', params: { protocol: PROTOCOL_VERSION, version } };
}

// T-31 parity step 2 — sidecar -> renderer push. A JSON-RPC notification (no id):
//   { jsonrpc:'2.0', method:'event', params:{ channel, payload } }
// The host (tauri/src-tauri/src/events.rs) is the authority: it checks `channel` against the generated
// inventory allow-list and the payload size, then emits to the MAIN webview only. The sidecar-side
// checks below are the same bound, so a producer fails here (in its own log) instead of being dropped
// later; they never replace the host's.
//
// MAX_EVENT_PAYLOAD_BYTES must match events.rs. It is below both frame caps on purpose: a frame over its cap takes the
// whole connection down (`fatal`), a refused event only drops itself. A producer with more data (audio) must chunk it.
export const MAX_EVENT_PAYLOAD_BYTES = 512 * 1024;

// Per-direction frame caps (step 6-pre, F4). Each must match lib.rs (MAX_REQUEST_FRAME_BYTES / MAX_RESPONSE_FRAME_BYTES),
// and scripts/check-tauri-sidecar.mjs pins that. A frame over its cap is still a fatal protocol error.
//   request  host -> sidecar: 4 MB. Electron's largest renderer argument is gcache.save at 2.5 MB; JSON escaping can
//            double a quote-heavy string, so 4 MB keeps the 2.5 MB text on the wire without a second code path.
//   response sidecar -> host: 16 MB. gcache.load returns the same 2.5 MB text; audio replies (step 8b) are larger.
// A reply over the response cap becomes that call's own error (`response_too_large`), never a frame the host rejects.
export const MAX_REQUEST_FRAME_BYTES = 4_000_000;
export const MAX_RESPONSE_FRAME_BYTES = 16_000_000;

// T-31 parity step 8b (G-a, approach A): binary fields cross the JSON boundary as {"$bin": "<base64>"}. A Buffer's
// own toJSON() would send `{type:"Buffer",data:[...]}` -- ~4x larger and not something the shim could turn back into
// bytes without another convention. The shim decodes every `$bin` back to a Uint8Array before it resolves a call or
// dispatches an event, so the renderer keeps receiving bytes exactly as it did from ipcRenderer (a Buffer is a
// Uint8Array). Encoding is applied to sidecar -> host frames only; request payloads carry no binary.
export const BIN_KEY = '$bin';

const isBytes = (v) => Buffer.isBuffer(v) || v instanceof Uint8Array;

/** Deep-copy `value`, replacing every Buffer/Uint8Array with { $bin: base64 }. Other values pass through. */
export function encodeBinary(value) {
  if (isBytes(value)) return { [BIN_KEY]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeBinary);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = encodeBinary(value[k]);
    return out;
  }
  return value;
}

/** Inverse of encodeBinary (used by the tests that re-assemble a chunked reply). */
export function decodeBinary(value) {
  if (Array.isArray(value)) return value.map(decodeBinary);
  if (isBytes(value)) return value;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === BIN_KEY && typeof value[BIN_KEY] === 'string') return Buffer.from(value[BIN_KEY], 'base64');
    const out = {};
    for (const k of keys) out[k] = decodeBinary(value[k]);
    return out;
  }
  return value;
}

/** Encoded payload size in bytes: what createEmitter's cap is measured against. */
export function payloadBytes(payload) {
  return Buffer.byteLength(JSON.stringify(encodeBinary(payload === undefined ? null : payload)));
}

/**
 * A `talk:ttsMore` payload whose audio exceeds the event cap is split into byte ranges that each fit, never dropped
 * (G-a; PLAN 8b tests). Every frame of one logical chunk carries the same `chunk` and its own 1-based `part`/`parts`;
 * the shim concatenates the decoded parts in order and delivers one `Uint8Array` to the renderer, byte-equal to the
 * original. A payload that already fits is returned untouched (no part/parts fields), so the ordinary case is exactly
 * Electron's one-event-per-sentence shape.
 */
export function splitAudioPayload(payload, maxBytes = MAX_EVENT_PAYLOAD_BYTES) {
  const audio = payload && payload.audio;
  if (!isBytes(audio) || payloadBytes(payload) <= maxBytes) return [payload];
  const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  const framesFor = (parts) => {
    const size = Math.ceil(bytes.length / parts);
    const out = [];
    for (let i = 0; i < parts; i++) {
      out.push({ ...payload, audio: bytes.subarray(i * size, Math.min(bytes.length, (i + 1) * size)), part: i + 1, parts });
    }
    return out;
  };
  // Start from the smallest split the byte count implies and widen only if a frame's JSON overhead still overflows.
  let parts = Math.max(2, Math.ceil(bytes.length / Math.max(1, maxBytes - 1024)));
  for (;;) {
    const frames = framesFor(parts);
    if (frames.every((f) => payloadBytes(f) <= maxBytes)) return frames;
    parts += 1;
  }
}

/**
 * The line to write for a response: JSON text, serialized ONCE. A frame over the response cap is replaced by an error for
 * the same id (fail this call only). Before 6-pre the check stringified the frame and the writer did it again.
 */
export function serializeResponse(out) {
  const text = JSON.stringify(encodeBinary(out));
  return Buffer.byteLength(text) > MAX_RESPONSE_FRAME_BYTES ? JSON.stringify(error(out.id ?? null, ERR_INTERNAL, 'response_too_large')) : text;
}

const CHANNEL = /^[a-z][A-Za-z]*:[A-Za-z]+$/;

export function eventFrame(channel, payload) {
  return { jsonrpc: '2.0', method: 'event', params: { channel, payload: payload === undefined ? null : payload } };
}

// Build the sidecar's `emit(channel, payload)`: serialize once, refuse a malformed channel or an oversized
// payload, hand the frame to `write`. Returns true when written. Logs channel + byte size only, never the
// payload (it can carry chat text and audio).
export function createEmitter(write, log = () => {}) {
  return function emit(channel, payload) {
    if (typeof channel !== 'string' || !CHANNEL.test(channel)) {
      log(`[sidecar] event refused: bad channel name`);
      return false;
    }
    let bytes;
    let encoded;
    try {
      encoded = encodeBinary(payload === undefined ? null : payload);
      bytes = Buffer.byteLength(JSON.stringify(encoded));
    } catch {
      log(`[sidecar] event refused: ${channel} payload is not JSON`);
      return false;
    }
    if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
      log(`[sidecar] event refused: ${channel} payload ${bytes} bytes > ${MAX_EVENT_PAYLOAD_BYTES}`);
      return false;
    }
    write(eventFrame(channel, encoded));
    return true;
  };
}
