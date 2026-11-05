// Self-test, talk part (fixture cloud: recorded answers from src/main/cloud-fixtures.json, a generated voice tone, no
// network). Drives the real TalkDirector, SpeechOut, gesture cache, speech library and RigProbe on the test model:
// gesture onset vs the first audio sample, cache / library / built-in fallback, composed second beat vs cache-only,
// schema and rig rejections, honest analysis fallback, failed turn, thinking gesture, barge-in, lip-sync.
import { ANALYSIS_MISSING_VI } from '../talk/validate.js';
import { TURN_FAILED_VI, THINK_AFTER_MS, GATE_SECOND_BEAT } from '../talk/director.js';
import { en } from '../i18n.js';

const L = {
  greet: 'Chào Zumi, hôm nay em thế nào?',
  agree: 'Mình làm bản thử trước nhé, được không?',
  board: 'Việc nào đang chờ anh trên bảng?',
  clamp: 'Thử một cử chỉ cần kẹp góc nhé.',
  torso: 'Thử một cử chỉ xuyên người nhé.',
  failed: 'Lượt này máy chủ lỗi.',
  noAnalysis: 'Lượt này không có giải thích.',
  codeAnalysis: 'Lượt này giải thích có mã T-31.',
  slow: 'Em nghĩ kỹ rồi trả lời nhé.',
  long: 'Kể anh nghe một chuyện dài đi.',
};
const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'];

// Approved P1 rule (director.js GATE_SECOND_BEAT): exactly ONE gesture per reply, so the composed beat is cached but never played on top of
// the library gesture (secondBeat unset, played false, cacheOnly set). The old expectation (secondBeat + played) contradicted the gate on both apps.
// With the gate off the second beat must play, as before.
export function agreeComposedOk(c, gate = GATE_SECOND_BEAT) {
  if (!c || !c.ok) return false;
  return gate ? !c.secondBeat && c.played === false && Boolean(c.cacheOnly) && Boolean(c.cachedAs) : Boolean(c.secondBeat) && c.played === true;
}

export async function talkCheck(ctx) {
  const { app, api, log, sleep, frames, until, pngName, audit = () => [] } = ctx;
  const talk = app.talk;
  const out = { ok: false, status: talk.status, cases: {} };
  const $ = (id) => document.getElementById(id);
  const text = (id) => ($(id) ? $(id).textContent : null);
  const visible = (id) => Boolean($(id) && !$(id).hidden);
  if (!talk.status.enabled || talk.status.mode !== 'fixture') { out.error = `talk not in fixture mode: ${JSON.stringify(talk.status)}`; return out; }
  await talk.ready();
  await until(() => talk.probe || talk.probeError, 20000);
  out.probe = { ready: Boolean(talk.probe), error: talk.probeError, rigVersion: talk.rigVersion };
  if (!talk.probe) { out.error = 'rig probe not ready'; return out; }
  const d = talk.director;

  // every shipped library variant passes the rig rules on this model
  {
    const rows = [];
    for (const [intent, def] of talk.library.byIntent) {
      for (const v of def.variants) {
        const r = talk.probe.check(v.command, { flip: false });
        rows.push({ intent, id: v.id, ok: r.ok, fails: r.fails, ms: r.ms, rules: r.rules, margins: r.margins, warnings: r.warnings });
        if (v.faces) { const f = talk.probe.check(v.command, { flip: true }); rows.push({ intent, id: `${v.id} (mirrored)`, ok: f.ok, fails: f.fails, ms: f.ms, rules: f.rules, margins: f.margins, warnings: f.warnings }); }
      }
    }
    out.libraryRig = { ok: rows.length > 0 && rows.every((x) => x.ok), maxMs: Math.max(...rows.map((x) => x.ms)), rows };
    out.libraryRig.marginWarnings = rows.flatMap((x) => x.warnings.map((w) => ({ id: x.id, ...w })));
    log(`talk: library rig rules ${rows.filter((x) => x.ok).length}/${rows.length} pass, probe max ${out.libraryRig.maxMs} ms${rows.filter((x) => !x.ok).map((x) => ` FAIL ${x.id}:${x.fails}`).join('')}`);
    for (const w of out.libraryRig.marginWarnings) log(`talk: WARN margin ${w.id} ${w.rule} ${w.margin} (value ${w.value}, cut-off ${w.cutoff}) — passes with < 5 % to spare`);
  }

  let mouthSamples = [];
  let sampling = false;
  const sampler = () => { if (!sampling) return; const ex = app.engine.lastFinal && app.engine.lastFinal.ex; if (ex) mouthSamples.push(MOUTH.reduce((a, m) => a + ex[m], 0)); requestAnimationFrame(sampler); };
  const settle = async () => { app.engine.resetForTest(); await frames(20); };
  const run = async (name, line, { shot, during } = {}) => {
    await settle();
    const p = d.send(line);
    let shotRes = null;
    if (shot || during) {
      const speaking = await new Promise((res) => { const off = d.onEvent((e) => { if (e.type === 'speaking' || e.type === 'done') { off(); res(e); } }); });
      if (during) await during(speaking);
      if (shot && speaking.type === 'speaking') { await sleep(700); shotRes = await api.capture(`talk-${name}`, { save: pngName(`talk-${name}`) }); }
    }
    const rec = await p;
    await sleep(150);
    audit(`talk ${name}`);
    const r = { outcome: rec.outcome, intent: rec.intent, first: rec.first, composed: rec.composed, speechMs: rec.speechMs, timeline: rec.timeline,
      ui: { reply: text('talk-reply'), analysisLines: visible('an-lines'), missing: visible('an-missing') ? text('an-missing') : null, understood: text('an-understood'), gesture: text('talk-gesture') },
      analysis: rec.analysis, png: shotRes && shotRes.png, blank: shotRes ? shotRes.blank : null };
    out.cases[name] = r;
    return { r, rec };
  };
  const onsetOk = (f) => Boolean(f && f.ok && typeof f.onsetVsAudioMs === 'number' && f.onsetVsAudioMs >= -150 && f.onsetVsAudioMs <= 100);

  try {
    // 1. library gesture at speech start; the composed one arrives too late -> cache only
    {
      const { r } = await run('greet', L.greet, { shot: true });
      await until(() => r.first && r.first.onsetVsAudioMs !== undefined, 3000);
      // r.ui.gesture is the app's OWN "Gesture: {label} · {source}" line (app.gestureLine), where {label} is
      // t('intent.greet') -- a stale Vietnamese literal here ("Chào hỏi — vẫy tay") was left behind by the
      // ui-english migration (which otherwise correctly moved ANALYSIS_MISSING_VI/TURN_FAILED_VI above to en()):
      // the app now defaults to English, so this case ALWAYS failed, reporting "FAIL" while outcome/onset/reply/
      // analysis/composed/cache were all already correct (coordinator QC 03-10 confirmed every other field matched).
      r.ok = r.outcome === 'spoken' && r.first.source === 'library' && onsetOk(r.first) && r.ui.reply === 'Chào anh! Hôm nay em vui lắm, sẵn sàng làm việc cùng anh rồi.'
        && r.ui.analysisLines && r.ui.understood === 'Anh đang chào em và hỏi thăm em hôm nay thế nào.' && r.composed && r.composed.ok && Boolean(r.composed.cacheOnly) && Boolean(r.composed.cachedAs)
        && r.ui.gesture.includes(en('intent.greet')) && !r.blank;
    }
    // 2. library variant at speech start (P5 agree variants; the built-in fallback is unit-tested in check:speech); the composed nod arrives with >= 2 s left -> second beat; lip-sync moves
    {
      mouthSamples = [];
      const { r } = await run('agree', L.agree, { during: async () => { sampling = true; requestAnimationFrame(sampler); await sleep(1500); sampling = false; } });
      await until(() => r.first && r.first.onsetVsAudioMs !== undefined, 3000);
      const mean = mouthSamples.reduce((a, b) => a + b, 0) / Math.max(1, mouthSamples.length);
      const variance = mouthSamples.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, mouthSamples.length);
      r.mouth = { samples: mouthSamples.length, mean: +mean.toFixed(4), variance: +variance.toFixed(5) };
      r.ok = r.outcome === 'spoken' && r.first.source === 'library' && onsetOk(r.first) && agreeComposedOk(r.composed) && r.mouth.samples > 10 && r.mouth.variance > 0;
    }
    // 3. pointing at the board (viewer's left) with a seed authored for the right side -> mirrored
    {
      const { r } = await run('board', L.board, { shot: true });
      r.ok = r.outcome === 'spoken' && r.first.source === 'library' && r.first.flip === true && r.composed && !r.composed.ok && r.composed.reason === 'model returned no command' && !r.blank;
    }
    // 4. a composed command that needs clamping never plays and is not cached
    {
      const before = talk.cache.size();
      const { r } = await run('clamp', L.clamp);
      r.ok = r.outcome === 'spoken' && r.first.source === 'library' && r.composed && !r.composed.ok && r.composed.reason === 'schema' && talk.cache.size() === before;
    }
    // 5. a composed command whose hand goes through the body fails the rig rules: never plays, not cached
    {
      const before = talk.cache.size();
      const { r } = await run('torso', L.torso);
      r.ok = r.outcome === 'spoken' && r.first.source === 'library' && r.composed && !r.composed.ok && r.composed.reason === 'rig' && r.composed.fails.includes('R2') && talk.cache.size() === before;
    }
    // 6. the turn call fails: honest text, no voice, no gesture
    {
      const { r } = await run('failed', L.failed);
      r.ok = r.outcome === 'turn-failed' && r.ui.reply === TURN_FAILED_VI && r.ui.missing === ANALYSIS_MISSING_VI && !r.speechMs;
    }
    // 7-8. analysis null / analysis with a task code -> the panel says it could not explain, never a fake text
    {
      const a = (await run('analysis-null', L.noAnalysis)).r;
      a.ok = a.outcome === 'spoken' && a.ui.missing === ANALYSIS_MISSING_VI && !a.ui.analysisLines && a.analysis.reason === 'no analysis from the model';
      const b = (await run('analysis-code', L.codeAnalysis)).r;
      b.ok = b.outcome === 'spoken' && b.ui.missing === ANALYSIS_MISSING_VI && b.analysis.reason === 'understood: task code';
    }
    // 9. a slow answer: the thinking gesture (+ chime) starts at THINK_AFTER_MS
    {
      const { r } = await run('slow', L.slow);
      r.ok = r.outcome === 'spoken' && typeof r.timeline.thinkAt === 'number' && r.timeline.thinkAt >= THINK_AFTER_MS - 50 && r.timeline.thinkAt < THINK_AFTER_MS + 500 && r.timeline.replyAt >= 1650;
    }
    // 10. barge-in: a new line while Zumi speaks stops the voice; the greet line now comes from the cache
    {
      let stop = null;
      const off = d.onEvent((e) => { if (e.type === 'cancelled') stop = e; });
      await settle();
      const pLong = d.send(L.long);
      await new Promise((res) => { const o = d.onEvent((e) => { if (e.type === 'speaking') { o(); res(); } }); });
      await sleep(1500);
      const wasSpeaking = talk.speech.speaking();
      const pGreet = d.send(L.greet);
      const silencedAtOnce = !talk.speech.speaking(); // the cancel runs synchronously inside send()
      const recLong = await pLong;
      const recGreet = await pGreet;
      off();
      await until(() => recGreet.first && recGreet.first.onsetVsAudioMs !== undefined, 3000);
      out.cases.bargeIn = { wasSpeaking, silencedAtOnce, stopMs: stop && stop.stopMs, longOutcome: recLong.outcome, greetFirst: recGreet.first, ok: wasSpeaking && silencedAtOnce && stop && stop.stopMs <= 100 && recLong.outcome === 'cancelled' && recGreet.outcome === 'spoken' && recGreet.first.source === 'cache' && onsetOk(recGreet.first) };
    }
    // the real key path: typing a line + Enter in the composer starts a turn (the 'send' reflex still fires first)
    {
      talk.muted = false;
      await settle();
      let sent = false;
      const off = d.onEvent((e) => { if (e.type === 'sent') sent = true; });
      const reflex = new Promise((res) => { const o = app.engine.on('reaction', (x) => { if (x.trigger === 'send') { o(); res(x); } }); setTimeout(() => res(null), 3000); });
      app.textbox.value = L.noAnalysis;
      app.input.keyInput('Enter');
      const rx = await reflex;
      const done = await new Promise((res) => { const o = d.onEvent((e) => { if (e.type === 'done') { o(); res(e); } }); setTimeout(() => res(null), 8000); });
      off();
      out.cases.enterKey = { ok: sent && Boolean(rx) && Boolean(done) && done.outcome === 'spoken', sent, sendReflex: rx && rx.variant, outcome: done && done.outcome };
    }
    // silence after speech: the voice no longer drives the mouth
    {
      await sleep(400);
      app.engine.resetForTest();
      await frames(30);
      const ex = app.engine.lastFinal.ex;
      out.mouthAfter = { sum: +MOUTH.reduce((a, m) => a + ex[m], 0).toFixed(4), speaking: talk.speech.speaking() };
      out.mouthAfter.ok = out.mouthAfter.sum === 0 && !out.mouthAfter.speaking;
    }
    out.cache = { size: talk.cache.size(), saved: await until(async () => { const t = await window.zumi.gcache.load(); return t && JSON.parse(t).entries.length === talk.cache.size() ? true : null; }, 3000) };
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  const caseOk = Object.values(out.cases).every((c) => c.ok);
  out.ok = !out.error && caseOk && out.libraryRig.ok && out.mouthAfter && out.mouthAfter.ok && Boolean(out.cache && out.cache.saved);
  for (const [k, c] of Object.entries(out.cases)) log(`talk ${c.ok ? 'PASS' : 'FAIL'} ${k} first=${c.first ? `${c.first.source}${c.first.flip ? '(mirrored)' : ''} onset=${c.first.onsetVsAudioMs}` : c.greetFirst ? `${c.greetFirst.source} stop=${c.stopMs}ms` : '-'} composed=${c.composed ? (c.composed.ok ? (c.composed.secondBeat ? 'second-beat' : 'cache-only') : `rejected:${c.composed.reason}${c.composed.fails ? `:${c.composed.fails}` : ''}`) : '-'}${c.mouth ? ` mouthVar=${c.mouth.variance}` : ''}`);
  log(`talk ok=${out.ok} cache=${out.cache && out.cache.size} mouthAfter=${out.mouthAfter && out.mouthAfter.sum}${out.error ? ` error=${out.error}` : ''}`);
  return out;
}
