// HUD inline ask answers (T-31 0.2.3 batch C): the owner answers a board ask from a HUD card, straight through the
// EXISTING bridge RELAY op `ask.answer` (board-bridge.mjs, RELAY_OPS) — no new connection, no new op. The renderer
// never names the op, the origin or any credential; this module fixes op = 'ask.answer' and hands the bridge only
// { target_id, expected_revision, data } (the bridge adds version/op/request_id itself, and prefixes the journal id
// with `zumi-relay-`, board-bridge.mjs proxyWrite).
//
// The `data` shape is exactly what the board's own page sends (vendor/laneboard/public/app.js answer() -> write(
// 'ask.answer', askId, data, rev), and ops.mjs 'ask.answer' check): one of a picked option `choice`, an owner
// approve/reject `verdict`, or (for a free-text ask) a non-empty `text` — plus an optional one-line `text` note on
// any of them. Only kind:'ask' waits are answerable (views.mjs ownerAttention: the ask branch); a proposal / step /
// unreceived wait is a different op and is refused here.
//
// Pure decisions + shape only (no Electron, no I/O but the injected `relay`), so scripts/check-hud.mjs tests every
// gate under plain Node. main.js owns the IPC handler; hud-host.mjs owns the read side (the feed's id/rev/options).

// Owner approve/reject of an ask with no options (ops.mjs 'ask.answer' verdict; app.js attentionRow's Duyệt/Chưa đạt).
export const ASK_ANSWER_VERDICTS = Object.freeze(['approve', 'reject']);

// A free-text answer / note longer than this is refused (a clear error, never a silent truncation): the board wants a
// real answer, not a wall of text (T-31 0.2.3 C nit).
export const ASK_ANSWER_TEXT_MAX = 2000;

/**
 * The `data` of an ask.answer write from the owner's HUD input, or null when nothing was answered.
 * A picked option (`choice`) wins over a `verdict` (an ask with options is answered by choosing one); an optional
 * trimmed note rides as `text` either way. Mirrors ops.mjs: `!choice && !verdict && !text.trim()` is "nothing to
 * answer"; a `choice` not in the ask's options comes back 400 unknown_choice from the board (not checked here — this
 * module never sees the ask's options; the renderer only offers the ones the feed carried).
 * @param {{ choice?: string, verdict?: string, text?: string }} input
 * @returns {{ choice?: string, verdict?: string, text?: string } | null}
 */
export function askAnswerData({ choice, verdict, text } = {}) {
  const data = {};
  const c = typeof choice === 'string' ? choice.trim() : '';
  if (c) data.choice = c;
  else if (ASK_ANSWER_VERDICTS.includes(verdict)) data.verdict = verdict;
  const note = typeof text === 'string' ? text.trim() : '';
  if (note) data.text = note;
  return Object.keys(data).length ? data : null;
}

/**
 * The relay body for one answer: { target_id, expected_revision, data }, or null on a malformed request.
 * `id` is the ask id (ask-N, the feed's `id`); `rev` is that ask's `rev` (the board's optimistic-concurrency
 * expected_revision — a stale one is refused upstream with 409 revision_conflict, which the caller surfaces as
 * "already answered"). Both are required: without the current revision we must not write (the board would 409).
 * A `null`/`undefined`/empty revision is refused, never coerced to 0; the answer text is capped at ASK_ANSWER_TEXT_MAX.
 * @param {string} id
 * @param {number|string} rev
 * @param {{ choice?: string, verdict?: string, text?: string }} input
 * @returns {{ target_id: string, expected_revision: number, data: object } | null}
 */
export function buildAskAnswer(id, rev, input) {
  const target = typeof id === 'string' ? id.trim() : '';
  // A real expected_revision is required (the board's optimistic-concurrency write needs it): null / undefined / '' /
  // any non-number must never coerce to 0 via Number() (T-31 0.2.3 C nit). A numeric string ("3") is still accepted.
  const revNum = typeof rev === 'number' || (typeof rev === 'string' && rev.trim() !== '') ? Number(rev) : NaN;
  const data = askAnswerData(input);
  const tooLong = Boolean(data) && typeof data.text === 'string' && data.text.length > ASK_ANSWER_TEXT_MAX;
  if (!target || !data || tooLong || !Number.isInteger(revNum) || revNum < 0) return null;
  return { target_id: target, expected_revision: revNum, data };
}

/**
 * The bridge relay result ({ status, text }) -> { ok } | { ok: false, reason }.
 * The bridge answers { status: <upstream status>, text: <upstream body> } (board-bridge.mjs relay); a refused op /
 * a locked bridge arrives as 403 forbidden_op / 401 locked with a JSON error. Taxonomy for the HUD:
 *   locked            board not live, unconfigured or PIN-locked (also the read-only mirror) -> "Bảng đang khoá"
 *   auth_rejected     the live board refused the stored sign-in (bridge latch, board-live.mjs) -> "check your
 *                     credentials"; NOT retryable until the sign-in changes
 *   already_answered  the board already rejected a second answer (409 ask_not_open, ops.mjs:363) or the rev moved
 *                     (409 revision_conflict / already_resolved) -> "đã trả lời"
 *   forbidden_op      should not happen (ask.answer ∈ RELAY_OPS) -> generic failure, logged
 *   failed            everything else (403, 5xx, bad json, offline/timeout) -> generic failure, retryable
 * @param {{ status?: number, text?: string }} r
 */
export function answerOutcome({ status, text } = {}) {
  let json = null;
  try { json = JSON.parse(String(text ?? '')); } catch { /* not json: status decides */ }
  const err = (json && json.error) || '';
  if (status === 200 && (!json || json.ok !== false)) return { ok: true };
  if (err === 'locked') return { ok: false, reason: 'locked' };
  // any other 401 came from the live board itself (nginx Basic / Laneboard token): the sign-in is wrong, not the lock
  if (status === 401 || err === 'auth_rejected') return { ok: false, reason: 'auth_rejected' };
  if (err === 'ask_not_open' || err === 'already_resolved' || err === 'revision_conflict') return { ok: false, reason: 'already_answered' };
  if (status === 403 || err === 'forbidden_op') return { ok: false, reason: 'forbidden_op' };
  return { ok: false, reason: 'failed', status: Number(status) || 0 };
}

/**
 * The HUD answer gate + relay. Every refusal is decided BEFORE any network call, so a refused answer never reaches
 * the board (mirrors board-open.mjs's pre-checks).
 * @param {object} o
 * @param {(op: string, body: object) => Promise<{status:number, text:string}>} o.relay  liveBoard.relay (or a fake)
 * @param {boolean} o.ownerAdmin  OWNER_ADMIN (main.js): the release build refuses every answer
 * @param {() => {mode:string, configured:boolean, locked:boolean}|null} o.boardStatus  liveBoard.status()
 * @param {(msg: string) => void} [o.log]
 */
export function createAskAnswerer({ relay, ownerAdmin = false, boardStatus = () => null, log = () => {} } = {}) {
  const answered = new Set(); // `${id}@${rev}` keys confirmed answered (locally or by the board) — a re-send is refused
  const inflight = new Set(); // ask ids with a write in flight — one write per ask at a time (disable-on-click's server twin)

  return {
    /**
     * @param {{ id?: string, rev?: number, choice?: string, verdict?: string, text?: string }} payload
     * @returns {Promise<{ok: boolean, reason?: string}>}
     */
    async answer(payload = {}) {
      if (ownerAdmin !== true) return { ok: false, reason: 'not_owner_build' }; // release build: no write surface at all
      const note = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (note.length > ASK_ANSWER_TEXT_MAX) return { ok: false, reason: 'text_too_long' }; // clear error, never truncated
      const body = buildAskAnswer(payload.id, payload.rev, payload);
      if (!body) return { ok: false, reason: 'bad_request' };
      const key = `${body.target_id}@${body.expected_revision}`;
      if (answered.has(key)) return { ok: false, reason: 'already_answered' };
      if (inflight.has(body.target_id)) return { ok: false, reason: 'in_flight' };
      const st = boardStatus();
      if (!(st && st.configured === true && st.locked === false && st.mode === 'live')) return { ok: false, reason: 'locked' };
      if (st.authRejected === true) return { ok: false, reason: 'auth_rejected' };
      inflight.add(body.target_id);
      let out;
      try { out = answerOutcome(await relay('ask.answer', body)); }
      catch (e) { out = { ok: false, reason: 'failed', error: String((e && e.message) || e) }; }
      finally { inflight.delete(body.target_id); }
      if (out.ok || out.reason === 'already_answered') answered.add(key); // answered either way: never send it twice
      log(`answer ${body.target_id} rev=${body.expected_revision} -> ${out.ok ? 'ok' : out.reason}`);
      return out;
    },
  };
}
