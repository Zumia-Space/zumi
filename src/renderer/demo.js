// Demo run (P9, test-only — started with --demo-script): types each scripted line into the composer like a user and
// presses Enter, lets Zumi answer, speak and gesture, and records per line: the caption the owner sees (Anh nói / Zumi
// đáp / Cử chỉ · nguồn), the timings, whether speech played and which gesture started with it, and a PNG at the
// gesture's peak. Before the lines: a PNG of the start screen and the rig rules over the whole speech library. After the
// lines: the board tab (the first-run sample board) is opened and captured, then the Zumi tab is shown again — with
// --demo-stay the app stays open for the viewer. Lines are spaced so the public TTS route's 20/min/IP limit is never hit.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (id) => { const el = document.getElementById(id); return el ? el.textContent : ''; };
const visible = (id) => { const el = document.getElementById(id); return Boolean(el && !el.hidden && el.getBoundingClientRect().width > 0); };

// T-31 Jev fast-reflex measurement (coordinator-approved, the intent spike's REPORT.md): types each
// gold-labelled line and records what Enter produced, with NO talk/cloud requirement at all (onReflex fires from
// app.js's onSend independently of talk.enabled). lines: [{text, gold}], the first one is the COLD measurement
// (first Enter after this fresh launch); the rest are WARM. Writes the same demo.json/shots the caller expects.
async function runDemoReflexOnly({ zumi, input, textbox, hasModel, onReflex, info, report, log, shot }) {
  for (let i = 0; i < 200 && !hasModel(); i++) await sleep(150);
  if (!hasModel()) throw new Error('no model on stage (start with --model <file.vrm>)');
  log(`reflex-only: ${info.lines.length} lines (1 cold + ${info.lines.length - 1} warm)`);
  await sleep(2500); // the entrance reflex
  await shot('00-start.png');
  for (const [n, line] of info.lines.entries()) {
    let got = null;
    const off = onReflex((r) => { got = r; });
    const t0 = Date.now();
    textbox.value = line.text;
    input.keyInput('Enter');
    for (let k = 0; k < 400 && !got; k++) await sleep(50); // up to 20s
    off();
    const wallMs = Date.now() - t0;
    const turn = { n: n + 1, cold: n === 0, line: line.text, gold: line.gold, reaction: got && got.reaction, source: got && got.source, confidence: got && got.confidence, ms: got && got.ms, wallMs, matched: Boolean(got && got.reaction === line.gold) };
    report.turns.push(turn);
    log(`line ${n + 1}/${info.lines.length} ${n === 0 ? '(cold) ' : ''}"${line.text}" -> reaction=${turn.reaction} source=${turn.source} conf=${turn.confidence} ms=${turn.ms} gold=${line.gold}`);
    if (line.shot) await shot(`${String(n + 1).padStart(2, '0')}-${line.shot}.png`);
    await sleep(line.gapMs || 1500);
  }
  const ok = report.turns.filter((t) => t.source).length;
  report.summary = { lines: report.turns.length, answered: ok, wrongReaction: report.turns.filter((t) => t.gold !== 'neutral' && t.reaction !== 'neutral' && !t.matched).length };
  report.ok = ok === report.turns.length;
  log(`summary ${JSON.stringify(report.summary)}`);
}

// Visual gate 14, D4: the "pending" and "reply first paint" shots are taken on state signals, not on timers or an
// external poller, so both hosts photograph the same moment. A line with `shotPending` holds the cloud turn at the
// director's own 'sent' event (the composer line is shown, the reply row is empty, the thinking status is on), takes the
// shot, releases the turn, then waits for the reply row to hold text and takes the first-paint shot.
// Returns { pending, streaming } (file names or null); both are null when the line does not ask for them.
// Two animation frames: the DOM change is composited only after the next frame, and an Electron capturePage taken in
// the same tick returns the previous frame (visual gate 14 D4). Falls back to a timer where rAF does not exist (node checks).
const nextPaint = () => new Promise((r) => (typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame(() => requestAnimationFrame(() => r()))
  : setTimeout(r, 34)));
export async function holdTurnForShots({ director, line, n, shot, log, send, readState = () => ({ user: text('talk-user'), reply: text('talk-reply') }) }) {
  const out = { pending: null, streaming: null, pendingState: null, streamingState: null };
  if (!line.shotPending) { await send(); return out; }
  const cloud = director.cloud;
  const origTurn = cloud.turn;
  let release;
  const gate = new Promise((r) => { release = r; });
  let sent = false;
  const off = director.onEvent((e) => { if (e.type === 'sent') sent = true; });
  cloud.turn = async (...a) => { await gate; return origTurn.apply(cloud, a); };
  try {
    await send();
    for (let k = 0; k < 100 && !sent; k++) await sleep(50); // 'sent' fires synchronously inside send(); this is only the wait for the keypress to land
    if (!sent) throw new Error('shotPending: the director never emitted sent');
    out.pendingState = readState();
    if (!out.pendingState.user || out.pendingState.reply) throw new Error(`shotPending: not a pending state (user=${JSON.stringify(out.pendingState.user)} reply=${JSON.stringify(out.pendingState.reply)})`);
    await nextPaint();
    out.pending = await shot(`${String(n + 1).padStart(2, '0')}-pending.png`);
    log(`pending shot ${out.pending} (user line shown, reply empty)`);
  } finally {
    cloud.turn = origTurn;
    release();
    off();
  }
  for (let k = 0; k < 400 && !readState().reply; k++) await sleep(25); // first paint of the reply row
  out.streamingState = readState();
  if (out.streamingState.reply) {
    await nextPaint();
    out.streaming = await shot(`${String(n + 1).padStart(2, '0')}-streaming.png`);
    log(`streaming shot ${out.streaming} (reply first painted)`);
  } else throw new Error('shotPending: the reply never painted');
  return out;
}

// T-31 first-answer time (offline stub run): milliseconds from the call (made in the same tick, right before the Enter key is
// sent) to the FIRST animation frame on which the reply row holds text, so the number is what a user would see, to the
// frame. null when no reply showed within timeoutMs, or when the row that showed text is marked .failed (talk reply(text || fallback)):
// never a made-up number. `raf`/`now` are injectable for the node check.
const defaultRaf = (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16));
export function timeFirstReply({ read, failed = () => false, raf = defaultRaf, now = () => performance.now(), timeoutMs = 20000 }) {
  const t0 = now();
  return new Promise((resolve) => {
    const frame = () => {
      const elapsed = now() - t0;
      if (String(read() || '').trim()) resolve(failed() ? null : elapsed); // a failed turn's fallback text is an error sample, not a reply
      else if (elapsed > timeoutMs) resolve(null);
      else raf(frame);
    };
    raf(frame);
  });
}

/** The first measured line is the COLD one (first Enter of a fresh launch); the rest are WARM, reported as a median. */
export function summarizeFirstReply(turns) {
  const ms = turns.map((t) => t.firstReplyMs).filter((v) => typeof v === 'number');
  const warm = ms.slice(1).sort((a, b) => a - b);
  const mid = warm.length >> 1;
  const warmMedianMs = warm.length === 0 ? null : warm.length % 2 ? warm[mid] : (warm[mid - 1] + warm[mid]) / 2;
  return { coldMs: ms.length ? ms[0] : null, warmMedianMs, warmN: warm.length, missing: turns.filter((t) => t.firstReplyMs === null).length };
}

export async function runDemo({ zumi, talk, engine, input, textbox, hasModel, openBoardTab, openZumiTab, boardWebview, reflexOnly, onReflex }) {
  const report = { ok: false, startedAt: new Date().toISOString(), turns: [], shots: [] };
  const log = (m) => zumi.demo.log(m);
  const shot = async (name) => { const f = await zumi.demo.capture(name); if (f) report.shots.push(f); return f; };
  try {
    const info = await zumi.demo.info();
    if (!info || info.error) throw new Error(`demo script unreadable: ${info && info.error}`);
    if (reflexOnly) { await runDemoReflexOnly({ zumi, input, textbox, hasModel, onReflex, info, report, log, shot }); report.finishedAt = new Date().toISOString(); return zumi.demo.finish(report); }
    report.fixture = info.fixture;
    report.talk = talk.status;
    for (let i = 0; i < 200 && !(hasModel() && talk.enabled); i++) await sleep(150);
    if (!hasModel()) throw new Error('no model on stage (start with --model <file.vrm>)');
    if (!talk.enabled) throw new Error(`talk is off: ${talk.status.reason || talk.status.mode}`);
    // A measure run (--measure-stub-provider) is only valid when the stub is the provider answering: BYO mode, stub label.
    if (info.measureStub && (talk.status.mode !== 'byo' || !/^Measure stub/.test(String(talk.status.provider)))) throw new Error(`measure run: the stub provider is not answering (${JSON.stringify(talk.status)})`);
    report.measureStub = Boolean(info.measureStub);
    await talk.ready();
    for (let i = 0; i < 100 && !talk.probe && !talk.probeError; i++) await sleep(200);
    log(`talk mode=${talk.status.mode}, ${info.lines.length} lines, rigVersion=${talk.rigVersion}`);
    await sleep(2500); // the entrance reflex
    report.screen = { banner: visible('demo-banner') ? text('demo-banner') : null, analysisPanelShown: visible('analysis'), analysisNotice: visible('an-off') ? text('an-off') : null };
    await shot('00-start.png');

    // the rig rules over every shipped speech variant (and its mirror when it points to a side), on this model
    if (talk.probe) {
      const rows = [];
      for (const [intent, def] of talk.library.byIntent) for (const v of def.variants) {
        const r = talk.probe.check(v.command);
        rows.push({ intent, id: v.id, ok: r.ok, fails: r.fails, warnings: r.warnings.map((w) => w.rule) });
        if (v.faces) { const f = talk.probe.check(v.command, { flip: true }); rows.push({ intent, id: `${v.id} (mirrored)`, ok: f.ok, fails: f.fails, warnings: f.warnings.map((w) => w.rule) }); }
      }
      report.libraryRig = { ok: rows.every((x) => x.ok), passed: rows.filter((x) => x.ok).length, total: rows.length, rows };
      engine.resetForTest();
      log(`library rig rules ${report.libraryRig.passed}/${report.libraryRig.total}`);
    } else report.libraryRig = { ok: false, error: talk.probeError || 'rig probe not ready' };

    const d = talk.director;
    for (const [n, line] of info.lines.entries()) {
      // T-31 QC-cuoi E2E (round 5): a line may wait for the local voice prefetch to finish first, so the scored
      // turns after it measure Kokoro rather than the Windows voice the app uses while the model downloads.
      if (line.awaitVoiceReady && zumi.talk.voiceState) {
        const w0 = Date.now();
        let s = null;
        for (let k = 0; k < 900; k++) { s = await zumi.talk.voiceState(); if (!s || ['ready', 'error', 'off'].includes(s.state)) break; await sleep(200); }
        log(`voice ready wait: state=${s && s.state} after ${Date.now() - w0} ms`);
      }
      const t0 = Date.now();
      let speaking = null;
      let checked = null;
      const offS = d.onEvent((e) => { if (e.type === 'speaking') speaking = e; if (e.type === 'checked') checked = e; });
      const done = new Promise((res) => { const off = d.onEvent((e) => { if (e.type === 'done') { off(); res(e); } }); setTimeout(() => res(null), 45000); });
      let png = null;
      // First-answer time: only a line that is not held behind the shotPending gate (the gate would inflate it).
      const measured = !line.shotPending;
      let firstReply = null;
      const stateShots = await holdTurnForShots({ director: d, line, n, shot, log, send: async () => { textbox.value = line.text; if (measured) firstReply = timeFirstReply({ read: () => text('talk-reply'), failed: () => Boolean(document.getElementById('talk-reply')?.classList.contains('failed')) }); input.keyInput('Enter'); } }); // the real composer path: 'send' reflex first, then the turn
      for (let k = 0; k < 400 && !speaking; k++) await sleep(50);
      if (speaking) { await sleep(800); png = await shot(`${String(n + 1).padStart(2, '0')}-${line.expect || 'line'}.png`); }
      const rec = await done;
      const firstReplyMs = firstReply ? await firstReply : null;
      // Models by role: a Check verdict lands after the reply (up to its own 10 s budget); a line may wait for it.
      for (let k = 0; k < (line.waitCheckedMs || 0) / 100 && !checked; k++) await sleep(100);
      offS();
      const rolesRow = document.getElementById('talk-roles');
      const roles = {
        chips: rolesRow && !rolesRow.hidden ? [...rolesRow.querySelectorAll('.rchip')].map((c) => ({ kind: c.className.replace('rchip', '').trim(), text: c.textContent, tip: (c.title || '').slice(0, 300) })) : [],
        sources: rolesRow && !rolesRow.hidden ? [...rolesRow.querySelectorAll('.src a')].map((a) => ({ site: a.textContent, url: a.getAttribute('href') })) : [],
        checkRow: visible('talk-check') ? text('talk-check') : null,
        checked: checked ? checked.verdict : null,
      };
      const panel = { missingLine: visible('an-missing') ? text('an-missing') : null, reflexLine: visible('an-reflex') ? text('an-reflex') : null };
      if (line.shotAfter) await shot(`${String(n + 1).padStart(2, '0')}-${line.shotAfter}.png`);
      const turn = {
        n: n + 1, line: line.text, expect: line.expect || null, scored: line.scored !== false, intent: rec && rec.intent,
        matched: Boolean(rec && line.expect && rec.intent === line.expect), outcome: rec ? rec.outcome : 'no answer in 45 s',
        audio: Boolean(rec && rec.timeline && typeof rec.timeline.speechStartAt === 'number' && !rec.ttsError), speechMs: rec && rec.speechMs,
        gesture: rec && rec.first ? { source: rec.first.source, id: rec.first.id, mirrored: rec.first.flip, onsetVsAudioMs: rec.first.onsetVsAudioMs } : null,
        shown: { user: text('talk-user'), reply: text('talk-reply'), gesture: text('talk-gesture') }, png, ms: Date.now() - t0,
        roles, panel, planned: Boolean(rec && rec.planned), stages: (rec && rec.stages) || null,
        firstReplyMs: measured ? firstReplyMs : undefined,
        stateShots: line.shotPending ? { pending: stateShots.pending, streaming: stateShots.streaming } : undefined,
      };
      report.turns.push(turn);
      log(`line ${n + 1} "${line.text}" -> ${turn.outcome} intent=${turn.intent} expect=${line.expect} audio=${turn.audio} ${turn.speechMs}ms gesture=${turn.gesture && `${turn.gesture.source}:${turn.gesture.id}${turn.gesture.mirrored ? ' mirrored' : ''} onset=${turn.gesture.onsetVsAudioMs}`}`);
      await sleep(Math.max(0, (line.gapMs || 8000) - (Date.now() - t0)) + 1500);
    }

    // the board tab: the first-run sample board of this run (open question on step 3)
    openBoardTab();
    for (let i = 0; i < 150 && !(boardWebview() && boardWebview().dataset.loaded === '1'); i++) await sleep(200);
    await sleep(1500);
    report.board = { loaded: Boolean(boardWebview() && boardWebview().dataset.loaded === '1') };
    await shot('10-board-tab.png');
    openZumiTab();
    await sleep(800);

    const scored = report.turns.filter((t) => t.scored);
    report.summary = {
      lines: report.turns.length, spoken: report.turns.filter((t) => t.outcome === 'spoken').length,
      withAudio: report.turns.filter((t) => t.audio).length,
      withGestureAtSpeechStart: report.turns.filter((t) => t.gesture && t.gesture.source && t.gesture.source !== 'none').length,
      scored: scored.length, intentMatched: scored.filter((t) => t.matched).length,
      firstReply: summarizeFirstReply(report.turns.filter((t) => t.firstReplyMs !== undefined)),
    };
    report.ok = report.summary.spoken === report.turns.length && report.summary.withAudio === report.turns.length
      && report.summary.withGestureAtSpeechStart === report.turns.length && Boolean(report.libraryRig && report.libraryRig.ok) && report.board.loaded;
    log(`summary ${JSON.stringify(report.summary)} rig=${report.libraryRig.ok} board=${report.board.loaded} ok=${report.ok}`);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    log(`ERROR ${report.error}`);
  }
  report.finishedAt = new Date().toISOString();
  await zumi.demo.finish(report);
}
