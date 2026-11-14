// Zumi's local task board is the Laneboard core (vendor/laneboard, commit pinned in vendor/laneboard/VERSION), run
// in-process. This module owns only what is Zumi's: where the data lives, the one-time import of a v0.2 board, the
// first-run sample, and a loopback Host check. Every record change goes through Laneboard's own write path.
//
// Data: <root> is the app's data folder (Zumi-data next to the install dir, see main.js). Laneboard keeps its journal,
// projection, media and owner token in <root>/laneboard. A v0.2 board (flat tasks.json/meta.json/times.json/... in
// <root>) is imported once, through Laneboard's scripts/migrate-from-legacy.mjs, and is never modified or removed.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LANEBOARD_SUBDIR = 'laneboard';
const LEGACY_MARKER = 'tasks.json'; // v0.2 wrote tasks.json on its first run

const load = (laneboardDir, rel) => import(pathToFileURL(path.join(laneboardDir, rel)).href);
const hasJournal = (dir) => fs.existsSync(path.join(dir, 'events.ndjson'));

/** The v0.2 board files in <root>, for tests and the self-test: { code: [step states] } in file order. */
export function readLegacyTasks(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, LEGACY_MARKER), 'utf8')).map((t) => ({ code: t.code, title: t.title, steps: (t.steps || []).map((s) => s.state) })); } catch { return null; }
}

/**
 * One-time import of a v0.2 board. Laneboard's importer only writes into an empty directory and checks every row
 * against the board rules before touching it; a refused snapshot comes back as { refused } and nothing is written.
 * The import goes to <dir>.importing and is renamed into place only when it finished, so a crash mid-import never
 * leaves a half board that a later launch would open as if it were complete.
 */
async function importLegacy(laneboardDir, root, dir) {
  const { migrate } = await load(laneboardDir, 'scripts/migrate-from-legacy.mjs');
  // The importer reads <snapshot>/data/*.json and <snapshot>/media; v0.2 kept them flat in <root>. Copy, never move.
  const stage = path.join(root, '.laneboard-import');
  const temp = `${dir}.importing`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(temp, { recursive: true, force: true }); // derived output of an interrupted import; the source is untouched
  fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
  for (const f of fs.readdirSync(root)) {
    if (f.endsWith('.json') && fs.statSync(path.join(root, f)).isFile()) fs.copyFileSync(path.join(root, f), path.join(stage, 'data', f));
  }
  if (fs.existsSync(path.join(root, 'media'))) fs.cpSync(path.join(root, 'media'), path.join(stage, 'media'), { recursive: true });
  try {
    const report = await migrate({ from: stage, to: temp });
    fs.renameSync(temp, dir);
    return { imported: report.imported, source: report.source, warnings: report.warnings, report: path.join(dir, 'migration-report.json') };
  } catch (e) {
    if (Array.isArray(e.violations)) {
      fs.rmSync(temp, { recursive: true, force: true }); // refused before writing: normally absent already
      return { refused: { message: e.message, violations: e.violations } };
    }
    if (fs.existsSync(temp)) fs.renameSync(temp, `${dir}.failed-${Date.now()}`); // kept for diagnosis
    throw e;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Opens the board in <root> and serves it on 127.0.0.1 — on `port` when given and free (a stable origin, so the page's
 * own browser storage — UI language, theme, drafts — survives a restart like on the web), else on an OS-assigned port.
 * @returns {Promise<{ outcome: 'opened'|'seeded'|'migrated', server, board, port, origin, url, dataDir, root, migration? }
 *                  | { outcome: 'refused', refused: { message, violations }, dataDir, root }>}
 *   url carries the owner token in its #fragment; Laneboard's page stores it and removes it from the address.
 *   alive() is false once the server is gone; close() is the host's own close.
 * onDown(err|null): called ONCE when the server goes away after listening without close() being called: an 'error'
 *   (libuv on Windows stops accepting and Node emits it with syscall 'accept') or the server closed under the host.
 */
// lang: an explicit UI language for the page (#lang=…, stored by the page as this browser's pick); null = the page's
// own default (English, like the web board) and whatever the viewer picked with its switcher before.
export async function openLocalBoard({ laneboardDir, root, sampleFixture, lang = null, port: wantPort = 0, onRequest = null, onDown = null }) {
  const dataDir = path.join(root, LANEBOARD_SUBDIR);
  fs.mkdirSync(root, { recursive: true });
  let outcome = 'opened';
  let migration;
  if (!hasJournal(dataDir) && fs.existsSync(path.join(root, LEGACY_MARKER))) {
    const r = await importLegacy(laneboardDir, root, dataDir);
    if (r.refused) return { outcome: 'refused', refused: r.refused, dataDir, root };
    outcome = 'migrated';
    migration = r;
  }

  const { createBoard } = await load(laneboardDir, 'src/board.mjs');
  const { createServer } = await load(laneboardDir, 'src/server.mjs');
  // roleSlots: false -- the per-task Plan/Code/Review/Scout slots name the owner's lane models (Opus/Sonnet/Haiku);
  // Zumi's users never see those (product rule: Zumi runs Google models only), so the local board draws no
  // "Workers by task" table. The owner build's Board tab shows the live board instead, where the slots belong.
  const board = createBoard({ dataDir, roleSlots: false });
  const ownerToken = fs.readFileSync(path.join(dataDir, 'owner.token'), 'utf8').trim();

  // Laneboard authorises by bearer token; on top of that only this loopback address may reach it (no DNS rebinding).
  const laneboard = createServer(board).listeners('request')[0];
  const server = http.createServer((req, res) => {
    // local-board FIN-swallow (same root cause as board-bridge.mjs, owner's PC 14-11 06:28Z): a loopback filter (Avast and
    // others) can eat the FIN this server sends when it closes an idle keep-alive socket; the Board guest's pool (6 per host)
    // then fills with half-dead sockets and the next load or XHR fails as ERR_CONNECTION_ABORTED. With Connection: close the
    // guest never pools a socket here. Safe: the page does plain request/response (it polls); the SSE route (/api/v1/events,
    // external clients) is one long response either way.
    res.setHeader('Connection', 'close');
    const port = req.socket.localPort;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end('{"error":"forbidden_host"}');
    }
    if (onRequest) onRequest(req, res);
    return laneboard(req, res);
  });
  const listen = (p) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  // T-31 local-board self-heal (0.3.7, same pattern as board-bridge.mjs): listen() removed its only 'error' listener, so
  // an accept error later was an unhandled 'error' event that killed the whole sidecar. Now any way down that close()
  // did not ask for closes the handle (nothing half-alive) and tells the host once; the host restarts the board.
  let down = false, closing = false;
  const goDown = (err) => {
    if (down || closing) return;
    down = true;
    if (server.listening) server.close();
    if (onDown) onDown(err || null);
  };
  let port, origin;
  try {
    try { await listen(wantPort); } catch (e) { if (!wantPort || e.code !== 'EADDRINUSE') throw e; await listen(0); } // taken: any free port
    port = server.address().port;
    origin = `http://127.0.0.1:${port}`;
    server.on('error', (e) => goDown(e));
    server.on('close', () => goDown(null));

    // First run: only the bootstrap owner event exists. The sample goes in through Laneboard's own seed path (HTTP writes
    // as the owner), so it is journaled like any other task. Also heals a crash between bootstrap and seeding.
    if (!migration && board.state.seq === 1) {
      const { seed } = await load(laneboardDir, 'scripts/seed.mjs');
      await seed(origin, ownerToken, { fixture: sampleFixture });
      outcome = 'seeded';
    }
  } catch (e) {
    // 0.3.7 gate S2: a failed open closes what it opened (the store's journal and mailbox handles, the server); the
    // host's restart loop retries once per backoff step, so each failed try used to leak them.
    closing = true;
    if (server.listening) server.close();
    board.close();
    throw e;
  }

  return {
    outcome, server, board, port, origin, dataDir, root, migration,
    url: `${origin}/#token=${encodeURIComponent(ownerToken)}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`,
    alive() { return !down && !closing && server.listening; },
    close() { closing = true; server.close(); board.close(); },
  };
}
