// Self-test (`Zumi.exe --selftest <dir>`): fires every built-in trigger variant through the real input
// wiring, plus hand-written GestureCommands through window.zumi.playGesture (IPC `gesture:play`),
// captures a PNG mid-reaction for each, and checks: reaction started <= 150 ms, the frame differs
// visibly from the idle frame, the pose/expression signature changed, and the frame is not blank.
// The checks live in ./gestures.js (reflex) and ./board.js (local task board); this file runs them in order and writes the report.
import { runReflexChecks, MAX_LATENCY_MS, MIN_POSE_DELTA } from './gestures.js';
import { boardCheck } from './board.js';
import { talkCheck } from './talk.js';
import { roomCheck } from './room.js';
import { collectOwnerTexts, auditOwnerTexts } from '../talk/ownertext.js';

// Not labels: what the user typed, the model's spoken reply, the user's own words echoed back, the vendored board page
// in its webview. Paths and file names are NOT exempt: they must not be in owner-visible text at all.
const OWNER_TEXT_SKIP = ['#talk-user', '#talk-reply', '#heard', 'webview'];

export async function runSelftest(app) {
  const { engine, input, catalog, info } = app;
  const api = window.zumi.selftest;
  const log = (m) => api.log(m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const nextReaction = (trigger, timeoutMs = 4000) => new Promise((resolve) => {
    const off = engine.on('reaction', (r) => { if (r.trigger === trigger) { off(); clearTimeout(t); resolve(r); } });
    const t = setTimeout(() => { off(); resolve(null); }, timeoutMs);
  });
  const nextState = (name, timeoutMs = 4000) => new Promise((resolve) => {
    const off = engine.on('state', (s) => { if (s.name === name && s.on) { off(); clearTimeout(t); resolve(true); } });
    const t = setTimeout(() => { off(); resolve(false); }, timeoutMs);
  });

  const report = {
    ok: false,
    version: info.version,
    startedAt: new Date().toISOString(),
    env: { ...info.versions, dpr: window.devicePixelRatio, ua: navigator.userAgent },
    criteria: { maxLatencyMs: MAX_LATENCY_MS, minChangedPct: 0.15, minPoseDelta: MIN_POSE_DELTA, diffPixelThreshold: 'max channel delta > 24' },
    defaultModel: app.defaultModel,
    modelLoaded: false,
    cases: [],
    extras: {},
    summary: {},
  };

  engine.autoIdle = false;
  engine.setLifeEnabled(false);
  let shotNo = 2;
  const pngName = (label) => `${String(shotNo++).padStart(2, '0')}-${label.replace(/[^\w.-]+/g, '-')}.png`;
  const until = async (fn, ms = 10000, step = 150) => {
    const end = performance.now() + ms;
    for (;;) {
      let v = null;
      try { v = await fn(); } catch { v = null; }
      if (v) return v;
      if (performance.now() > end) return null;
      await sleep(step);
    }
  };
  // owner-visible text audit (P6): the app's own visible labels at each moment a test calls ctx.audit(moment)
  const ownerText = { checked: 0, moments: [], problems: [] };
  const audit = (moment) => {
    const items = collectOwnerTexts(document.body, OWNER_TEXT_SKIP);
    const problems = auditOwnerTexts(items);
    ownerText.checked += items.length;
    ownerText.moments.push(`${moment} (${items.length})`);
    for (const p of problems) if (ownerText.problems.length < 50) ownerText.problems.push({ moment, ...p });
    if (problems.length) log(`owner text FAIL at ${moment}: ${problems.map((p) => `${p.where} "${p.text}" (${p.problem})`).join(' | ')}`);
    return problems;
  };
  const ctx = { app, engine, input, catalog, info, api, log, sleep, frames, nextReaction, nextState, until, pngName, audit };

  try {
    await runReflexChecks(ctx, report);
    const extras = report.extras;

    // room (T-31 R1/R3): default room loads from anchors, bad fixtures refused with their message, missing-anchor fallback
    extras.room = await roomCheck(ctx);
    audit('after the room cases');

    // talk path on the fixture cloud: Zumi answers, speaks and gestures (no network)
    extras.talk = await talkCheck(ctx);
    audit('after the talk cases');

    // local task board (Laneboard core): served on 127.0.0.1, seeded / migrated / refused data, one valid and one invalid write
    extras.board = await boardCheck(ctx);

    // network: every http(s)/ws request of the whole run went to a loopback host
    {
      const bl = await api.boardLog();
      const remote = bl.net.filter((x) => x.remote);
      // a refused v0.2 import starts no board server, so that run may have no request at all
      extras.network = { ok: remote.length === 0 && (bl.net.length > 0 || extras.board.outcome === 'refused'), requests: bl.net.length, loopback: bl.net.length - remote.length, nonLoopback: remote.length, nonLoopbackUrls: remote.map((x) => x.url), hosts: [...new Set(bl.net.map((x) => { try { return new URL(x.url).host; } catch { return x.url; } }))] };
      log(`network: ${extras.network.requests} requests, non-loopback ${extras.network.nonLoopback}, hosts ${extras.network.hosts.join(', ')}`);
    }

    extras.ownerText = { ok: ownerText.checked > 0 && ownerText.problems.length === 0, checked: ownerText.checked, moments: ownerText.moments, problems: ownerText.problems };
    log(`owner text: ${ownerText.checked} strings at ${ownerText.moments.length} moments, ${ownerText.problems.length} problem(s)`);

    const cases = report.cases;
    const lats = cases.map((c) => c.latencyMs).filter((x) => x != null);
    report.summary = {
      cases: cases.length,
      passed: cases.filter((c) => c.pass).length,
      builtinTriggers: catalog.names().length,
      builtinVariants: cases.filter((c) => c.source === 'catalog').length,
      gesturePlayCases: cases.filter((c) => c.source === 'gesture:play').length,
      maxLatencyMs: lats.length ? Math.max(...lats) : null,
      meanLatencyMs: lats.length ? +(lats.reduce((a, b) => a + b, 0) / lats.length).toFixed(1) : null,
      minChangedPct: cases.length ? Math.min(...cases.map((c) => c.changedPct)) : null,
      extrasOk: Object.values(report.extras).every((e) => e.skipped ? true : e.ok),
      extrasSkipped: Object.entries(report.extras).filter(([, e]) => e.skipped).map(([k, e]) => `${k}: ${e.skipped}`),
    };
    report.ok = Boolean(report.modelLoaded && cases.length && cases.every((c) => c.pass) && report.summary.extrasOk);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    log(`ERROR ${report.error}`);
  }
  report.finishedAt = new Date().toISOString();
  await api.finish(report);
}
