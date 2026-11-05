// Owner-build Board-tab sign-in card. In the owner build (app:info.ownerAdmin)
// this card REPLACES both the generic #board-locked overlay and the local/sample board: app.js's renderBoardTab
// never calls openBoard() for that build at all (see app.js). A non-owner build never mounts this module.
//
// Same secrets flow as Settings' "Live board" card (settings.js) -- same zumi.board.* IPC calls, same error-code ->
// i18n map (imported, not forked) -- just a smaller single-button form: no token field (optional, Nâng cao-only in
// Settings), no confirm-PIN. Three states, switched on zumi.board.status():
//   - not configured, pinRequired true (default): user + password + "Set a PIN", button submits
//     zumi.board.setSecrets (which also unlocks).
//   - not configured, pinRequired false (Settings > "Require PIN for Board" turned off before first sign-in): user
//     + password only, no PIN field at all -- button submits zumi.board.setSecretsOs instead.
//   - configured + locked: PIN only, button submits zumi.board.unlock, then setMode('live'). (A configured 'os'-mode install is never
//     locked -- board-secrets.mjs loads it straight from disk -- so this state only happens in 'pin' mode.)
// Unlike Settings' "Save and lock with PIN" (which deliberately re-locks right after configuring, so the owner must
// always re-enter a PIN once), first-time sign-in here goes straight into the live board — no re-lock step — and a
// first-time configure also flips the mode to 'live' (board-live.mjs only defaults to 'live' at construction time
// for an ALREADY-configured install; a fresh configure during this session needs an explicit setMode call).
import { t, onLocaleChange } from './i18n.js';
import { ERROR_KEY } from './settings.js';

export function initBoardSignin(zumi, $, { onDone } = {}) {
  const el = {
    userLabel: $('signin-user').previousElementSibling, user: $('signin-user'),
    passLabel: $('signin-pass').previousElementSibling, pass: $('signin-pass'),
    hint: $('signin-pass').nextElementSibling,
    pinLabel: $('signin-pin-label'), pin: $('signin-pin'),
    button: $('signin-button'), note: $('signin-note'), retry: $('signin-retry'),
  };
  let retryTimer = null;
  let retryUntil = 0;
  let configured = false;
  let pinRequired = true;

  const note = (text, bad) => { el.note.textContent = text || ''; el.note.classList.toggle('bad', Boolean(bad)); };
  const clearInputs = () => { el.user.value = ''; el.pass.value = ''; el.pin.value = ''; };

  function startBackoff(ms) {
    clearInterval(retryTimer);
    if (!ms || ms <= 0) { retryUntil = 0; el.retry.textContent = ''; el.button.disabled = false; return; }
    retryUntil = Date.now() + ms;
    el.button.disabled = true;
    const tick = () => {
      const left = retryUntil - Date.now();
      if (left <= 0) { clearInterval(retryTimer); retryUntil = 0; el.retry.textContent = ''; el.button.disabled = false; return; }
      el.retry.textContent = t('settings.retryIn', { secs: Math.ceil(left / 1000) });
    };
    tick();
    retryTimer = setInterval(tick, 250);
  }

  /** Shows the right fields for `status` (from zumi.board.status()). Call before revealing the card. */
  function render(status) {
    configured = Boolean(status && status.configured);
    pinRequired = status ? status.pinRequired !== false : true;
    el.user.hidden = el.userLabel.hidden = configured;
    el.pass.hidden = el.passLabel.hidden = el.hint.hidden = configured;
    // Not configured + PIN requirement off: no PIN field at all (the card's own "pinRequired false" state above).
    // Configured + locked only happens in 'pin' mode (see the header comment), so this branch is unreachable there.
    const showPin = configured || pinRequired;
    el.pinLabel.hidden = el.pin.hidden = !showPin;
    if (showPin) el.pinLabel.textContent = configured ? t('settings.unlockPin') : t('board.signin.setPin');
    note('');
    startBackoff(0);
  }

  el.button.addEventListener('click', async () => {
    note('');
    if (configured) {
      const pin = el.pin.value;
      el.pin.value = '';
      const r = await zumi.board.unlock(pin);
      // unlock() does not flip local->live either: a sign-in saved this session via Settings' "Save and lock" left the
      // mode 'local', and renderOwnerBoardTab would show this card again (T-31-TAURI unlock loop).
      if (r && r.ok) { await zumi.board.setMode('live'); if (onDone) onDone(); return; }
      if (r && (r.error === 'wrong_pin' || r.error === 'backoff')) { note(t('settings.wrongPin'), true); startBackoff(r.retryAfterMs); return; }
      note(ERROR_KEY[r && r.error] ? t(ERROR_KEY[r.error]) : t('settings.unlockFailed'), true);
      return;
    }
    let r;
    // Username trimmed (a stray space = Basic-auth 401 forever, board-secrets.mjs refuses it); the password never is.
    const user = el.user.value.trim();
    try {
      r = pinRequired
        ? await zumi.board.setSecrets({ token: '', user, pass: el.pass.value, pin: el.pin.value })
        : await zumi.board.setSecretsOs({ token: '', user, pass: el.pass.value });
    } catch { r = null; }
    finally { clearInputs(); } // never linger in the DOM, even if the call rejects
    if (r && r.ok) {
      await zumi.board.setMode('live'); // fresh install: configure()/configureOs() unlocks but does not itself flip local->live
      if (onDone) onDone();
      return;
    }
    note(ERROR_KEY[r && r.error] ? t(ERROR_KEY[r.error]) : t('settings.saveFailed'), true);
  });

  onLocaleChange(() => render({ configured, pinRequired }));

  return { render };
}
