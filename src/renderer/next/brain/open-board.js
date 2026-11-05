// "Open on board" (T-31 slice 3, PLAN-SLICE3-BRAIN section 2): renderer-only navigation of the board tab's <webview> to the task's own
// route (#/task/<id>, vendor/laneboard public/app.js route()). It reads only what app.js already keeps on the element (dataset.home =
// the bare board address, dataset.domReady). It never uses `openUrl`: that address carries a one-time nonce, dead after the first
// load. Same URL rule as app.js openBoardTask/reloadBoardUrl: embed=1, the current UI language, `local`, a fresh `r` so the page
// really reloads, then the task hash.

/** The URL the board webview is sent to. `home` = webview.dataset.home. Pure. */
export function boardTaskUrl(home, taskId, { locale, ownerAdmin, r = Date.now().toString(36) }) {
  const u = new URL(home);
  u.searchParams.set('embed', '1');
  u.searchParams.set('lang', locale);
  u.searchParams.set('local', ownerAdmin ? 'open' : 'hide');
  u.searchParams.set('r', r);
  u.hash = `#/task/${encodeURIComponent(taskId)}`;
  return u.href;
}

/** Switches to the Board tab (the app's own handler mounts the webview if it is not there yet), then navigates it once it is ready. */
export function openTaskOnBoard(taskId, { locale, ownerAdmin, doc = document, schedule = setTimeout, tries = 20 }) {
  if (!taskId) return;
  doc.querySelector('.tab[data-tab="board"]').click();
  let n = 0;
  const go = () => {
    const wv = doc.querySelector('#board-host webview');
    // dom-ready, not just dataset.home: on a cold Board tab loadURL before the guest view is attached fails (app.js openBoardTask).
    if (!wv || wv.dataset.domReady !== '1' || !wv.dataset.home) { if (n++ < tries) schedule(go, 150); return; }
    Promise.resolve(wv.loadURL(boardTaskUrl(wv.dataset.home, taskId, { locale, ownerAdmin }))).catch((e) => console.error('brain: open on board failed', e));
  };
  go();
}
