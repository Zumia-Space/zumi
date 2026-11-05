// A public or official build: what the renderer does differently for a stranger. The host's app:info says so
// (tauri/sidecar/main.mjs); a host without the flag (Electron, the owner build) is not public, so nothing here touches them.
export function isPublicBuild(info) {
  return Boolean(info && info.publicBuild === true);
}

// The Board and what only serves it: its tab, its sign-in and PIN (Settings > Account), the task HUD and the phone code that logs in to it.
const BOARD_SURFACES = ['.tab[data-tab="board"]', '#stab-account', '#stabpanel-account', '#hud-card', '#phone-card'];

/** Runs before the Settings tabs are wired, so Settings opens on the first tab left. */
export function applyPublicShell(doc) {
  for (const sel of BOARD_SURFACES) { const el = doc.querySelector(sel); if (el) el.hidden = true; }
  // The provider steps say Save, then Test key.
  const save = doc.querySelector('#brain-key-save'), test = doc.querySelector('#brain-key-test');
  if (save && test && test.before) test.before(save);
}
