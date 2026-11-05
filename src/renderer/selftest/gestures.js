// Self-test, reflex part: the empty stage, the test model, every built-in trigger variant through the real input wiring,
// hand-written GestureCommands through window.zumi.playGesture (IPC `gesture:play`), and the reflex extras (schema,
// variant picker, continuous life, idle timers, clip fallback, every model in the picker). Fills report.cases / report.extras.
import { ReflexEngine } from '../reflex/index.js';
import { seatedPoseNameOf } from '../room/seat.js';

export const MAX_LATENCY_MS = 150;
export const MIN_POSE_DELTA = 0.01;
export const SETTLE_FRAMES_AFTER_CAPTURE = 3;

export const LLM_CASES = [
  {
    id: 'llm-shrug', labelVi: 'Nhún vai "ai biết~"', peakMs: 700,
    command: {
      id: 'llm-shrug', label: 'Nhún vai', priority: 5, interrupt: true,
      expressions: [{ name: 'relaxed', weight: 0.4, inMs: 150, holdMs: 900, outMs: 400 }, { name: 'ou', weight: 0.3, inMs: 120, holdMs: 500, outMs: 300 }],
      bones: [
        { bone: 'rightShoulder', rot: [0, 0, -12], inMs: 150, holdMs: 700, outMs: 400 },
        { bone: 'leftShoulder', rot: [0, 0, 12], inMs: 150, holdMs: 700, outMs: 400 },
        { bone: 'head', rot: [0, 0, 12], inMs: 200, holdMs: 800, outMs: 400 },
      ],
      reach: [
        { hand: 'right', target: { frame: 'shoulder', pos: [0.45, -0.55, 0.45] }, inMs: 250, holdMs: 800, outMs: 450 },
        { hand: 'left', target: { frame: 'shoulder', pos: [0.45, -0.55, 0.45] }, inMs: 250, holdMs: 800, outMs: 450 },
      ],
      lookAt: { target: 'camera', ms: 900 },
    },
  },
  {
    id: 'llm-think', labelVi: 'Ngước lên, chống cằm nghĩ', peakMs: 900,
    command: {
      id: 'llm-think', label: 'Ngước lên nghĩ', priority: 5,
      lookAt: [{ target: { x: 0.7, y: 1.1 }, weight: 0.9, inMs: 200, holdMs: 1200, outMs: 400 }],
      bones: [{ bone: 'head', rot: [-10, 12, 8], inMs: 250, holdMs: 1100, outMs: 450 }],
      reach: [{ hand: 'right', target: 'chin', inMs: 350, holdMs: 1000, outMs: 450 }],
      expressions: [{ name: 'ou', weight: 0.3, inMs: 200, holdMs: 900, outMs: 300 }],
    },
  },
  {
    id: 'llm-celebrate-clamped', labelVi: 'Ăn mừng (có góc vượt giới hạn -> bị kẹp)', peakMs: 800, expectWarnings: true,
    command: {
      id: 'llm-celebrate', label: 'Ăn mừng', priority: 5,
      bones: [
        { bone: 'head', rot: [-170, 0, 0], inMs: 200, holdMs: 900, outMs: 400 },
        { bone: 'spine', rot: [0, 0, 0], inMs: 150, holdMs: 1000, outMs: 400, osc: { hz: 2.5, amp: [3, 0, 0], wave: 'pulse' } },
      ],
      reach: [
        { hand: 'right', target: 'overhead', inMs: 300, holdMs: 900, outMs: 450 },
        { hand: 'left', target: 'overhead', inMs: 300, holdMs: 900, outMs: 450 },
      ],
      expressions: [{ name: 'happy', weight: 1, inMs: 120, holdMs: 1000, outMs: 400 }, { name: 'aa', weight: 0.5, inMs: 100, holdMs: 400, outMs: 300 }],
    },
  },
];

// Talk first, then any non-idle clip, then any other clip; never a seated (sit-*) or base pose (it changes nothing on stage).
export function pickClipFallbackName(names, basePose) {
  const pool = names.filter((n) => n !== basePose && !/^sit-/.test(n)); // seated sit-* clips change nothing on stage (poseDelta ~0.001)
  return pool.includes('Talk') ? 'Talk' : (pool.find((n) => !/idle/i.test(n)) || pool[0] || null);
}

export async function runReflexChecks(ctx, report) {
  const { app, engine, input, catalog, api, log, sleep, frames, nextReaction, nextState, pngName, audit = () => [] } = ctx;
  // ---------- no model yet (fresh install: nothing bundled) ----------
  // The stage must show the empty-state card, and every input path must be a safe no-op: nothing queued, no crash.
  {
    await frames(10);
    const rect0 = app.stageRect();
    const s = { x: rect0.x + 0.6 * rect0.width, y: rect0.y + 0.4 * rect0.height };
    let threw = null;
    let gesture = null;
    try {
      app.input.pointerMove(s.x, s.y);
      app.input.pointerDown(s.x, s.y); app.input.pointerUp(s.x, s.y);
      app.input.keyInput('a'); app.input.keyInput('Enter');
      app.onWindowFocus(false); app.onWindowFocus(true);
      engine.trigger('bored'); engine.enterState('sleepy');
      gesture = await window.zumi.playGesture(LLM_CASES[0].command);
      await frames(20);
    } catch (e) { threw = String((e && e.stack) || e); }
    const shot = await api.capture('no-model', { save: '00-no-model.png' });
    audit('no model on stage');
    report.extras.noModel = {
      ok: !threw && !app.hasModel() && app.emptyStateVisible() && app.bundledCount === 0 && engine.player.instances.length === 0 && engine.pending.size === 0 && Boolean(gesture && gesture.ok === false) && !shot.blank,
      bundledModels: app.bundledCount,
      emptyStateVisible: app.emptyStateVisible(),
      queuedInstances: engine.player.instances.length,
      gesturePlayAnswer: gesture,
      threw,
      png: shot.png,
    };
    log(`no-model stage ok=${report.extras.noModel.ok} (bundled=${app.bundledCount}, empty card=${report.extras.noModel.emptyStateVisible})`);
  }

  const tm = app.models.find((m) => m.id === app.defaultModel);
  report.defaultModel = tm ? { id: tm.id, file: tm.file, source: tm.source, bytes: tm.bytes } : null;
  if (!tm) throw new Error('no model to test with: start with --model <file.vrm> (or ZUMI_TEST_MODEL)');
  const entrance = await app.switchModel(tm.id);
  if (!entrance) throw new Error('test model failed to load');
  await sleep(2800);
  const rect = app.stageRect();
  const stagePx = Math.round(rect.width * rect.height * window.devicePixelRatio ** 2);
  const minPx = Math.max(300, Math.round(stagePx * 0.0015));

  app.setModelVisible(false);
  await frames(6);
  await api.capture('background', { rect, keepAs: 'bg', save: '00-background.png' });
  app.setModelVisible(true);

  const settle = async () => {
    engine.resetForTest();
    input.tick(performance.now() + 5000);
    await frames(55);
  };
  await settle();
  const idle = await api.capture('idle', { rect, keepAs: 'idle', diffWith: 'bg', save: '01-idle.png' });
  report.idle = idle;
  report.modelLoaded = !idle.blank && idle.diff && idle.diff.changedPct > 3;
  log(`model loaded=${report.modelLoaded} (idle vs background changed ${idle.diff && idle.diff.changedPct.toFixed(1)}%)`);

  const hr = () => engine.hitRegions(rect);

  // run one case: fire() must return the engine reaction info ({id, t0, ...}) or a playGesture result
  async function runCase({ trigger, variant, labelVi, peakMs, fire, cleanup, source, shotName = `${trigger}-${variant}` }) {
    await settle();
    await api.capture('base', { rect, keepAs: 'base' });
    // Measurement fix: a CDP/host capture (Tauri: 361-1103 ms) can leave the webview compositor/main thread busy for a moment after its promise resolves.
    // Let that drain (rAF settle) before the latency timer starts, or the first post-poke frame is the one that eats the stall (poke 150-160 ms, 12 RESULT.md).
    await frames(SETTLE_FRAMES_AFTER_CAPTURE);
    const sigIdle = engine.signature();
    if (source === 'catalog') catalog.forceNext(trigger, variant);
    const callT0 = performance.now();
    const fired = await fire();
    const rec = { trigger, variant, labelVi, source, fired: Boolean(fired && (fired.id || fired.trackId)) };
    let lat = null;
    let samplePose = null, sampleT = null;
    if (rec.fired) {
      const id = fired.trackId || fired.id;
      const startT0 = fired.t0 || fired.startedAt || callT0;
      lat = await engine.waitLatency(id, 2000);
      // Sample at peakMs on the PLAYER's clock (not wall-clock since t0): a slow capture or a late first frame must not move the sample point.
      const inst0 = engine.player.find(id);
      const deadline = performance.now() + peakMs + 3000;
      while (inst0 && engine.player.localTime(inst0, performance.now()) < peakMs && performance.now() < deadline) await sleep(4);
      await frames(1); // let the pose for this clock position be applied before reading it
      samplePose = engine.signature();
      sampleT = inst0 ? Math.round(engine.player.localTime(inst0, performance.now())) : null;
      if (source === 'gesture:play') rec.endToEndLatencyMs = lat ? +(lat.ms + (startT0 - callT0)).toFixed(1) : null;
      if (fired.warnings) rec.validatorWarnings = fired.warnings;
    }
    rec.variantPlayed = fired && fired.variant ? fired.variant : variant;
    rec.latencyMs = lat ? +lat.ms.toFixed(1) : null;
    if (rec.fired) { // diagnostic: where the reaction was when the frame was taken
      const inst = engine.player.find(fired.trackId || fired.id);
      rec.atCapture = inst ? { tMs: Math.round(engine.player.localTime(inst, performance.now())), durationMs: Math.round(engine.player.duration(inst)), fading: inst.fadeStart != null, others: engine.player.instances.length - 1 } : { gone: true };
    }
    const capT0 = performance.now();
    const shot = await api.capture(shotName, { rect, diffWith: 'base', save: pngName(shotName) });
    rec.captureMs = Math.round(performance.now() - capT0); // Tauri CDP capture is slow; the pose is sampled BEFORE it
    rec.poseSampleTMs = sampleT;
    audit(`reflex ${trigger}/${variant}`);
    rec.png = shot.png;
    rec.changedPx = shot.diff.changedPx;
    rec.changedPct = +shot.diff.changedPct.toFixed(2);
    rec.meanAbsDiff = +shot.diff.meanAbs.toFixed(2);
    rec.blank = shot.blank;
    rec.poseDelta = +ReflexEngine.signatureDelta(samplePose || engine.signature(), sigIdle).toFixed(4);
    rec.pass = rec.fired && rec.variantPlayed === variant && lat != null && lat.ms <= MAX_LATENCY_MS && shot.diff.changedPx >= minPx && !shot.blank && rec.poseDelta >= MIN_POSE_DELTA;
    if (cleanup) await cleanup();
    report.cases.push(rec);
    log(`${rec.pass ? 'PASS' : 'FAIL'} ${trigger}/${variant} latency=${rec.latencyMs}ms changed=${rec.changedPct}% pose=${rec.poseDelta}`);
    return rec;
  }

  const stageTo = (fx, fy) => ({ x: rect.x + fx * rect.width, y: rect.y + fy * rect.height });
  const cursorSpots = [stageTo(0.9, 0.12), stageTo(0.08, 0.2), stageTo(0.85, 0.85)];

  const fires = {
    cursor: (i) => () => { const p = nextReaction('cursor'); const s = cursorSpots[i % 3]; input.pointerMove(s.x, s.y); return p; },
    poke: (i) => () => {
      const h = hr();
      const spots = [{ x: h.head.x + 0.35 * h.head.r, y: h.head.y }, { x: (h.body.x0 + h.body.x1) / 2 + 10, y: h.body.y0 + 0.3 * (h.body.y1 - h.body.y0) }, { x: h.head.x - 0.4 * h.head.r, y: h.head.y - 0.2 * h.head.r }];
      const s = spots[i % 3];
      const p = nextReaction('poke');
      const t = performance.now();
      input.pointerDown(s.x, s.y, t);
      input.pointerUp(s.x, s.y, t + 80);
      return p;
    },
    pat: () => async () => {
      const h = hr();
      const p = nextReaction('pat');
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 4;
        input.pointerMove(h.head.x + Math.cos(a) * 0.5 * h.head.r, h.head.y + Math.sin(a) * 0.35 * h.head.r);
        if (engine.isState('pat')) break;
        await sleep(35);
      }
      return p;
    },
    typing: () => () => { const p = nextReaction('typing'); input.keyInput('a'); return p; },
    'typing-stop': () => () => { const p = nextReaction('typing-stop', 5000); input.keyInput('a'); return p; },
    send: () => () => { const p = nextReaction('send'); app.textbox.value = 'Chào Zumi, em nghe anh không?'; input.keyInput('Enter'); return p; },
    focus: () => () => { const p = nextReaction('focus'); app.onWindowFocus(true); return p; },
    blur: () => () => { const p = nextReaction('blur'); app.onWindowFocus(false); return p; },
    bored: () => () => engine.trigger('bored'),
    sleepy: () => () => engine.enterState('sleepy'),
    wake: () => async () => {
      engine.enterState('sleepy');
      await sleep(1500);
      const p = nextReaction('wake');
      const s = stageTo(0.7, 0.3);
      input.pointerMove(s.x, s.y);
      return p;
    },
    // The way hud.js:107/338 plays a board variant: the case's variant is forced (runCase -> catalog.forceNext), the card look is passed.
    board: () => () => { const p = nextReaction('board'); engine.trigger('board', { look: { x: -1.6, y: 0.35 } }); return p; },
    entrance: (i, v) => () => app.switchModel(app.defaultModel, { forceEntrance: v }),
  };
  const cleanups = {
    pat: () => { input.tick(performance.now() + 5000); },
    typing: () => { input.keyInput('Enter'); },
    blur: () => { engine.exitState('blur'); },
    sleepy: () => { engine.exitState('sleepy'); },
  };

  for (const trigger of catalog.names()) {
    const def = catalog.get(trigger);
    for (let i = 0; i < def.variants.length; i++) {
      const v = def.variants[i];
      if (trigger === 'board' && v.id === 'turn-point') continue; // unreachable, reported as an explicit skip below
      await runCase({
        trigger, variant: v.id, labelVi: `${def.labelVi} → ${v.labelVi}`, source: 'catalog',
        peakMs: (v.selftest && v.selftest.peakMs) || 600,
        fire: fires[trigger](i, v.id),
        cleanup: cleanups[trigger],
      });
    }
  }

  // The generic emitBoard path (app.js onBoardEvent) always plays double-take, whatever the catalog would pick.
  await runCase({
    trigger: 'board', variant: 'double-take', labelVi: 'New message on the board → generic event (emitBoard)', source: 'emit-board', peakMs: (catalog.get('board').variants.find((v) => v.id === 'double-take') || { selftest: {} }).selftest.peakMs || 600,
    fire: () => { const p = nextReaction('board'); api.emitBoard(); return p; },
    shotName: 'board-emit-generic',
  });

  // hand-written GestureCommands through the LLM path: window.zumi.playGesture -> IPC gesture:play -> player
  for (const c of LLM_CASES) {
    const rec = await runCase({
      trigger: 'gesture:play', variant: c.id, labelVi: c.labelVi, source: 'gesture:play', peakMs: c.peakMs,
      fire: async () => {
        const res = await window.zumi.playGesture(c.command);
        return res && res.ok ? { ...res, variant: c.id } : null;
      },
    });
    if (c.expectWarnings && !(rec.validatorWarnings && rec.validatorWarnings.length)) { rec.pass = false; rec.note = 'expected clamp warnings'; }
  }

  // ---------- extras ----------
  const extras = report.extras;
  extras.boardTurnPoint = { ok: true, skipped: 'unreachable: hud.js:329-330 excludes turn-point on purpose (its arm sweeps through the panels) and no app path plays it; NOT counted as passing' };
  extras.catalog = { ok: true, triggers: catalog.names().length, variants: catalog.names().reduce((a, n) => a + catalog.get(n).variants.length, 0) };

  // schema rejects unknown fields and does not play anything
  {
    await settle();
    const before = engine.player.instances.length;
    const res = await window.zumi.playGesture({ id: 'bad', dance: true, bones: [{ bone: 'tail', rot: [0, 0, 0] }] });
    extras.schemaRejectsUnknown = { ok: Boolean(res && res.ok === false && res.errors && res.errors.length && engine.player.instances.length === before), errors: res && res.errors };
  }

  // variant picker: never the same variant twice in a row, every variant reachable
  {
    const out = {};
    let ok = true;
    for (const n of catalog.names()) {
      let prev = null, repeats = 0;
      const seen = new Set();
      for (let k = 0; k < 300; k++) { const v = catalog.pick(n).id; if (v === prev) repeats++; prev = v; seen.add(v); }
      out[n] = { repeats, seen: seen.size };
      if (repeats || seen.size !== catalog.get(n).variants.length) ok = false;
    }
    extras.variantPicker = { ok, detail: out };
  }

  // continuous life: two frames 1.6 s apart must differ with breathing/blink/sway on
  {
    await settle();
    engine.setLifeEnabled(true);
    await frames(20);
    await api.capture('lifeA', { rect, keepAs: 'lifeA' });
    const sigA = engine.signature();
    await sleep(1600);
    const b = await api.capture('lifeB', { rect, diffWith: 'lifeA', save: pngName('life-idle') });
    const d = ReflexEngine.signatureDelta(engine.signature(), sigA);
    engine.setLifeEnabled(false);
    extras.life = { ok: b.diff.changedPx > 0 && d > 0.003, changedPct: +b.diff.changedPct.toFixed(2), poseDelta: +d.toFixed(4) };
  }

  // idle timers through the real clock path (60 s -> bored, 3 min -> sleepy, input -> wake)
  {
    await settle();
    engine.autoIdle = true;
    const pB = nextReaction('bored', 2500);
    engine.setIdleFor(61);
    const bored = await pB;
    if (bored) { await sleep(900); await api.capture('idle-bored', { rect, save: pngName('timer-idle60s-bored') }); }
    await sleep(2500);
    const pS = nextState('sleepy', 2500);
    engine.setIdleFor(181);
    const sleepy = await pS;
    if (sleepy) { await sleep(1800); await api.capture('idle-sleepy', { rect, save: pngName('timer-idle3min-sleepy') }); }
    const pW = nextReaction('wake', 2000);
    const s = stageTo(0.3, 0.3);
    input.pointerMove(s.x, s.y);
    const wake = await pW;
    if (wake) { await sleep(200); await api.capture('wake', { rect, save: pngName('timer-input-wakes') }); }
    engine.autoIdle = false;
    extras.idleTimers = { ok: Boolean(bored && sleepy && wake), bored: bored && bored.variant, sleepy: Boolean(sleepy), wake: wake && wake.variant };
  }

  // optional clip fallback (only if a clip is available, e.g. started with --clips-dir)
  {
    // The clip held as the seated base pose (sit-work in the work view, sit-idle otherwise) is the base pose already (poseDelta ~0 by construction;
    // 12 RESULT.md: sit-work 0.0003-0.0007 on both apps, a harness pick, not an app bug). Pick a clip that is NOT the current base.
    const name = pickClipFallbackName([...app.clips.available.keys()], seatedPoseNameOf(engine));
    if (!name) extras.clipFallback = { ok: null, skipped: 'no non-seated clip bundled' }; // skipped is neither pass nor fail
    else {
      await settle();
      await api.capture('base', { rect, keepAs: 'base' });
      const sig = engine.signature();
      const res = await window.zumi.playGesture({ id: 'llm-clip', clip: { name, weight: 1, loop: true, holdMs: 2000 } });
      await sleep(1200);
      const shot = await api.capture('clip', { rect, diffWith: 'base', save: pngName(`clip-${name}`) });
      const d = ReflexEngine.signatureDelta(engine.signature(), sig);
      extras.clipFallback = { ok: Boolean(res && res.ok && shot.diff.changedPx >= minPx && d > 0.01), clip: name, changedPct: +shot.diff.changedPct.toFixed(2), poseDelta: +d.toFixed(4), warnings: res && res.warnings };
    }
  }

  // every model the picker offers loads and renders (not blank, clearly different from the empty stage)
  {
    const out = [];
    for (const m of app.models) {
      const t0 = performance.now();
      const r = await app.switchModel(m.id);
      const loadMs = Math.round(performance.now() - t0);
      await sleep(2600);
      engine.resetForTest();
      await frames(30);
      const shot = await api.capture(`model-${m.id}`, { rect, diffWith: 'bg', save: pngName(`model-${m.id}`) });
      out.push({ model: m.file, source: m.source, bytes: m.bytes, loaded: Boolean(r), loadMs, changedPct: +shot.diff.changedPct.toFixed(1), blank: shot.blank, ok: Boolean(r) && !shot.blank && shot.diff.changedPct > 3 });
    }
    extras.allModels = { ok: out.length > 0 && out.every((x) => x.ok), models: out };
    await app.switchModel(app.defaultModel);
  }
}
