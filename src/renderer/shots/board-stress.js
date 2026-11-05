// Board-tab stress run (J-05 coordinator QC 03-10, GUEST_VIEW_MANAGER_CALL investigation). A "packaged-like" run
// (no --selftest sandbox, no test model) -- opens the Board tab 20x, with a reload and a tab-switch each round, and
// tries an executeJavaScript() on the board <webview> right after the SAME readiness signal the board selftest
// waits for (webview.dataset.loaded === '1'), to see whether the race the selftest hit is reachable from ordinary
// tab-switching/reload, or only from the selftest's own broader timing. Runs only when the app was started with
// --board-stress (main.js), driven the same way selftest/demo/shots drive themselves -- see app.js's boot section.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for a FRESH dataset.loaded==='1' (the caller clears it first), up to `ms`. Returns the elapsed ms, or null
// on timeout -- the same signal board.js's selftest polls (app.boardWebview().dataset.loaded === '1').
async function waitLoaded(boardWebview, ms) {
  const t0 = performance.now();
  for (;;) {
    const wv = boardWebview();
    if (wv && wv.dataset.loaded === '1') return performance.now() - t0;
    if (performance.now() - t0 > ms) return null;
    await sleep(100);
  }
}

// One inject attempt right after the readiness signal -- mirrors board.js's `js = (code) => wv.executeJavaScript(code)`.
async function tryInject(wv) {
  const t0 = performance.now();
  try {
    await wv.executeJavaScript('1+1');
    return { ok: true, ms: performance.now() - t0 };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, error: String((e && e.message) || e) };
  }
}

export async function runBoardStress({ zumi, $, openBoardTab, openZumiTab, boardWebview }) {
  const log = (m) => { console.log(`[board-stress] ${m}`); zumi.shots.log(m); };
  const N = 20;
  const rounds = [];
  let errors = 0;
  let attempts = 0;

  for (let i = 1; i <= N; i++) {
    // ---- open the Board tab ----
    // Do NOT clear dataset.loaded here: app.js's renderBoardTab() deliberately keeps the existing webview and does
    // NOTHING on a repeat open ("if (webview) return; // already showing the right mode; don't reload on every
    // status poll") -- clearing the flag first would wait for a navigation that never happens past round 1, which
    // is a TEST bug, not a product one (caught empirically: every round-2+ "open" timed out this way).
    openBoardTab();
    const openedMs = await waitLoaded(boardWebview, 30000);
    let openInject = null;
    if (openedMs != null) { attempts++; openInject = await tryInject(boardWebview()); if (!openInject.ok) errors++; }
    else { attempts++; openInject = { ok: false, ms: null, error: 'webview never reached dataset.loaded=1 (open)' }; errors++; }

    // ---- reload (same webview element, a fresh navigation) ----
    const wv = boardWebview();
    let reloadInject = null;
    if (wv) {
      delete wv.dataset.loaded;
      $('board-reload').click();
      const reloadedMs = await waitLoaded(boardWebview, 30000);
      if (reloadedMs != null) { attempts++; reloadInject = await tryInject(boardWebview()); if (!reloadInject.ok) errors++; }
      else { attempts++; reloadInject = { ok: false, ms: null, error: 'webview never reached dataset.loaded=1 (reload)' }; errors++; }
    }

    rounds.push({ i, openedMs, openInject, reloadInject });
    log(`#${i} open: loaded=${openedMs != null ? openedMs.toFixed(0) + 'ms' : 'TIMEOUT'} inject=${openInject.ok ? `ok ${openInject.ms.toFixed(1)}ms` : `ERROR ${openInject.error}`}`
      + (reloadInject ? ` | reload: inject=${reloadInject.ok ? `ok ${reloadInject.ms.toFixed(1)}ms` : `ERROR ${reloadInject.error}`}` : ''));

    // ---- switch away (what a real user does between glances at the board) ----
    openZumiTab();
    await sleep(250);
  }

  log(`done: ${errors}/${attempts} inject attempts errored over ${N} Board-tab rounds`);
  await zumi.shots.finish({ ok: true, n: N, attempts, errors, rounds });
}
