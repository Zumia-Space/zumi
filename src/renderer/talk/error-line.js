// T-31 BYOK: which plain line the chat shows when a turn fails. The main process classifies the provider failure
// (chat-brain.js classifyUpstreamError) into a code, so the renderer never guesses from an HTTP string:
//   auth    -> the key is invalid / has no permission (check it in Settings)
//   credit  -> the provider account is out of funds (top up or switch provider)
//   quota   -> a free-tier provider (gemini/groq) used up today's allowance (app.quota, names the provider);
//              any other 429 is a transient rate limit (app.providerBusy)
//   no_vision / bad_image -> R6c C: the model cannot read images / the attachment was not allowed (nothing was sent)
//   too_large -> R6e: the request was over the rpc frame cap (the host refused it; nothing was sent)
//   other   -> today's generic line
// main.js stamps `free` and `provider` on a 429, so this stays a pure code/free test. Pure (no DOM, no state, no i18n
// import), so scripts/check-byok-errors.mjs can test every branch.
// OpenCode Go has its own lines: a refusal means "paste the Go key", and any limit is the subscription's window, not a busy server.
// Which window is not named: the body of that refusal is not documented or measured yet.
// R6b S1: the line the chat shows for a failed turn, whole. A turn the monthly budget stopped (`budget_month` / `budget_unreadable`, the
// host's own codes) says why in the words of the agent chat (src/renderer/agent-chat.js: the same prefix keys, then the host's reason text,
// numbers and all); every other failure is its plain line. `t` is the i18n lookup. Pure.
export function failureText(error, t, params) {
  const line = t(failureLineKey(error), params);
  const detail = error && typeof error.message === 'string' ? error.message.trim() : '';
  return detail && (error.code === 'budget_month' || error.code === 'budget_unreadable') ? `${line} ${detail}` : line;
}

export function failureLineKey(error) {
  const code = error && error.code;
  if (error && error.providerId === 'opencode-go') {
    if (code === 'auth' && error.cliLogin === true && error.forbidden !== true) return 'app.goCliRefused';
    if (code === 'auth') return error.forbidden === true ? 'app.goForbidden' : 'app.goKeyRefused';
    if (code === 'quota' || code === 'credit') return 'app.goLimit';
  }
  if (code === 'no_vision') return 'app.noVision';
  if (code === 'bad_image') return 'app.badImage';
  if (code === 'too_large') return 'app.tooLarge';
  if (code === 'budget_month') return 'agent.err.budgetMonth';
  if (code === 'budget_unreadable') return 'agent.err.budgetUnreadable';
  if (code === 'auth') return 'app.keyRefused';
  if (code === 'credit') return 'app.creditOut';
  if (code === 'quota') return error.free === true ? 'app.quota' : 'app.providerBusy';
  return 'app.replyFailed';
}
