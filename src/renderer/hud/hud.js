// Talk-camera HUD (T-31 hud-react, 13-10; ASTRA-PLAN v8 steps 5-6): translucent task panels over the stage, Zumi's
// reaction to a new board update and the consent-to-open prompt. Main decides everything that matters
// (src/main/hud-host.mjs: dedupe, batching, the open allowlist); this module only paints main's 'hud:feed', plays the
// existing 'board' double-take (a head and upper-body turn toward the panels, no arm) and sends the owner's OK / No
// back by offer id. Voice is the talk scheduler's job now (T-31 talk-mode): the host hands each reaction to main via
// onReaction, so the HUD no longer speaks.
// Settings > HUD: style Off (default) / A side panels / B arc panels.
// C1 step 7: every feed also reports its task rows to `onWorkFeed` (hud/work-signal.js derives the renderer's
// "working" flag from them; an Off style or a failed read reports []). The HUD itself does not use the flag.
import { t, getLocale, onLocaleChange } from '../i18n.js';
import { armPanelHits, armScreenPoints, panelRects } from './clearance.js';
import { lookTarget, reactionLook, stateToVariant, createClickThrottle, createAnswerDrafts, canSendDraft, ageLabel } from './hud-logic.js';
// T-31 hud-panels: the new T1/T2/T3 panel. panel-prefs.js holds the two renderer-only choices (design, place),
// panel-logic.js decides which task it follows and whether Zumi is working on it, panels.js paints it.
import { readPanelPrefs, savePanelPrefs } from './panel-prefs.js';
import { focusTask, isWorkingOn } from './panel-logic.js';
import { renderPanel } from './panels.js';

const HOT_MS = 8000;
// The feed's task rows for the working signal: [] when the HUD is Off or this read failed (no board side).
const workFeedOf = (payload) => (payload.style === 'off' || !payload.feed ? [] : payload.feed.updates);

const age = (iso) => ageLabel(iso, Date.now(), t('hud.now'));

export async function initHud({ zumi, $, engine, catalog, talk, hasModel, getView, devRun, openBoardTask, onHoloFeed, onWorkFeed, onWorkEvent }) {
  const root = $('hud');
  const styleSel = $('hud-style');
  // The two new Settings selects. NOTE: the design select is #hud-panel-design, not the plan's #hud-panel -- the panel
  // section itself is #hud-panel (PLAN section 4), and two elements cannot share an id.
  const panelSel = $('hud-panel-design');
  const placeSel = $('hud-panel-place');
  let prefs = { style: 'off' };
  let last = null; // the last 'hud:feed' payload
  let panelPrefs = readPanelPrefs(); // { design, place } -- renderer-only, localStorage (panel-prefs.js)
  let lastPrimary = null; // the task the last reaction was about: the new panel follows it (panel-logic.js focusTask)
  let wasVisible = false; // the HUD's own on-screen state, so the panel can re-fit its NOW line when the talk view returns
  const hot = new Map(); // task id -> expiry (ms)
  let consent = null; // { id, kind, label, target, ttlMs, at }
  let consentTimer = null;
  let expanded = null; // task id of the card whose detail is open (survives repaints)
  const answered = new Map(); // ask key (`kind:id@rev`) -> 'sending' | 'done' (an answer already sent; survives repaints)
  const drafts = createAnswerDrafts(); // per-ask in-progress answer (choice/verdict/note); survives a repaint (T-31 fix round 1610 r3: every poll rebuilds the open ask card, so the pick must not live in the closure)
  const clickThrottle = createClickThrottle(800); // B5: at most one click-glance per 800 ms
  const log = []; // dev/test runs only: what the HUD did, for scripts/electron-hud.cjs
  const note = (rec) => { if (devRun) { log.push({ at: Date.now(), ...rec }); if (log.length > 100) log.shift(); } };

  function paintPrefs() {
    styleSel.value = prefs.style;
    panelSel.value = panelPrefs.design;
    placeSel.value = panelPrefs.place;
  }

  // ---- the new T1/T2/T3 panel (T-31 hud-panels) ----
  // ONE node (#hud-panel), moved between the left group and the below group by the `place` pref: in place it is a
  // compact strip at rest that expands only while Zumi works on the focused task (isWorkingOn: the work loop's own
  // 10 minutes, or the 8 s reaction window); the two below places are always expanded. panel-logic.js picks the task,
  // panels.js paints, and both buttons in the T1 ask block are real: Answer opens the shipped ask card (which owns the
  // answer controls), Open calls the same board opener as the old cards.
  // True when the expanded panel sits wholly inside its group (the group is height-capped, the panel never shrinks, so a
  // panel that is too tall just overflows the group's bottom). A hidden/unlaid-out HUD measures as 0 and counts as
  // fitting; the repaint on show (syncVisible) and on resize re-measures.
  function fullPanelFits(panel, group) {
    if (!group) return true;
    const p = panel.getBoundingClientRect();
    const g = group.getBoundingClientRect();
    if (!p.height || !g.height) return true;
    return p.bottom <= g.bottom + 0.5;
  }

  function paintPanel(feed, now) {
    const panel = $('hud-panel');
    const below = $('hud-below');
    const task = feed ? focusTask(feed.updates, lastPrimary) : null;
    const place = panelPrefs.place;
    const inplace = place === 'inplace';
    const host = inplace ? $('hud-updates').closest('.hud-group') : below;
    if (host && panel.parentElement !== host) host.appendChild(panel);
    if (below) { below.dataset.place = place; below.hidden = inplace; }
    const paint = (expanded) => renderPanel(panel, {
      design: panelPrefs.design,
      expanded,
      task,
      asks: feed && Array.isArray(feed.waiting) && task ? feed.waiting.filter((w) => w.taskId === task.id) : [],
      t, locale: getLocale(), age, now,
      onAnswer: (taskId) => { const card = $('hud-asks').querySelector(`.hud-item[data-task="${cssEsc(taskId)}"]`); if (card) card.click(); },
      onOpen: (taskId) => { if (openBoardTask) openBoardTask(taskId); },
    });
    const wantFull = inplace ? isWorkingOn(task, now, hot) : true;
    paint(wantFull);
    // In place the full panel must fit inside its group (max-height 46% - 14 px, shared with the updates list): at a small
    // window it spilled below the 46% arm-safe line and squeezed "Task updates" to its header. Measure after the first
    // paint and fall back to the compact strip when it does not fit.
    if (inplace && wantFull && !panel.hidden && !fullPanelFits(panel, host)) paint(false);
    if (below) below.hidden = inplace || panel.hidden;
  }

  const li = (cls, parts) => {
    const el = document.createElement('li');
    el.className = cls;
    for (const [c, text] of parts) { if (!text) continue; const s = document.createElement('span'); s.className = c; s.textContent = text; el.appendChild(s); }
    return el;
  };

  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

  // ---- card -> stage-NDC (A1) ----
  // The look point for one card element: its centre in the same stage NDC the reflex lookAt targets use, plus the
  // reason it was skipped (DIAG r3 #3: the reaction note records `lookSkip`, so the next box run proves its cause).
  // A click glance skips a hidden card, an arm-yielded one (.yield) and an off-stage one; a reaction passes
  // `reaction:true` and uses reactionLook, which never skips for a passing fade (a reaction must not lose its gaze to
  // a 0.2 s yield). skip = 'nocard' | 'hidden' | 'faded' | 'offstage' | null.
  function cardLookOf(el, { reaction = false } = {}) {
    if (!el) return { look: null, skip: 'nocard', faded: false };
    const rect = el.getBoundingClientRect();
    const viewport = $('stage-canvas').getBoundingClientRect();
    const hidden = Boolean(el.hidden);
    // The group fade is read for BOTH paths (T-31 fix r4 review 4): reactionLook never skips on it, but react()
    // records it (lookFaded) so a box run can prove a reaction fired while the card's group was arm-yielded.
    const group = el.closest('.hud-group');
    const faded = group ? parseFloat(getComputedStyle(group).opacity || '1') <= 0.15 : false;
    if (reaction) {
      const look = reactionLook(rect, viewport, { hidden });
      return { look, skip: look ? null : hidden ? 'hidden' : 'offstage', faded };
    }
    const look = lookTarget(rect, viewport, { hidden, faded });
    return { look, skip: look ? null : hidden ? 'hidden' : faded ? 'faded' : 'offstage', faded };
  }
  // Scope the lookup to the list the changed item is in (A1 "the EXACT card"): an ask card sits on the right, an
  // update card on the left, and a task can be in both, so a bare task-id query would sometimes target the wrong one.
  const cardLook = (taskId, source, opts) => {
    if (!taskId) return { look: null, skip: 'nocard', faded: false };
    const sel = `.hud-item[data-task="${cssEsc(taskId)}"]`;
    const scope = source === 'waiting' ? $('hud-asks') : source === 'updates' ? $('hud-updates') : null;
    return cardLookOf((scope && scope.querySelector(sel)) || root.querySelector(sel), opts);
  };

  // ---- expand a card (B1) + glance at the card the owner clicked (B5) ----
  // One click expands/collapses the detail and (throttled, and never over speech) glances at that exact card.
  function onCardClick(taskId, el) {
    const { look: ndc } = cardLookOf(el); // read before paint() replaces this element
    const fromAsks = Boolean(el.closest && el.closest('#hud-asks')); // the clicked card's list (a task can be in both)
    expanded = expanded === taskId ? null : taskId;
    paint();
    // Keep the expanded ask's own question on screen (T-31 fix round 1610 r2, QC nit): align the CARD, never its
    // answer controls. Scrolling the controls into view pushed the title/question off the top, so the owner saw
    // Approve/Send with no context. If the card is taller than the list viewport, top-alignment (block:'start') is the
    // only way the question stays visible (the controls scroll below); a card that fits is brought fully into view,
    // top included. Scoped to #hud-asks: the SAME task can also sit in the left updates list (that card precedes it in
    // the DOM), and the left list must never be scrolled.
    if (expanded === taskId && fromAsks) {
      const fresh = $('hud-asks').querySelector(`.hud-item[data-task="${cssEsc(taskId)}"]`);
      if (fresh) {
        const taller = fresh.getBoundingClientRect().height > $('hud-asks').clientHeight;
        fresh.scrollIntoView({ block: taller ? 'start' : 'nearest' });
      }
    }
    if (expanded === taskId && !fromAsks) { // an expanded updates card: bring its Open button above the list's fold (J-05 card-clip)
      const list = $('hud-updates');
      const open = list.querySelector(`.hud-item[data-task="${cssEsc(taskId)}"] .hud-open`);
      if (open) { const over = open.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom; if (over > 0) list.scrollTop += over + 4; }
    }
    if (!ndc || !hasModel()) return;
    if (talk.speech.speaking()) return; // never interrupt speech
    if (!clickThrottle(Date.now())) return; // at most one glance per 800 ms
    if (engine.isState('sleepy')) engine.exitState('sleepy');
    catalog.forceNext('board', 'quick-glance');
    engine.trigger('board', { look: ndc });
    note({ kind: 'touch', taskId, look: ndc });
  }

  // The expanded detail block (B1): status, step, file labels (never a path), and the Board action (B2).
  function detailBlock(taskId, update, ask) {
    const box = document.createElement('div');
    box.className = 'hud-detail';
    const row = (k, v) => {
      if (!v) return;
      const r = document.createElement('div'); r.className = 'drow';
      const kk = document.createElement('span'); kk.className = 'dk'; kk.textContent = k;
      const vv = document.createElement('span'); vv.className = 'dv'; vv.textContent = v;
      r.append(kk, vv); box.appendChild(r);
    };
    if (update) {
      if (update.title) { const ttl = document.createElement('div'); ttl.className = 'dt'; ttl.textContent = update.title; box.appendChild(ttl); }
      if (update.step) row(t('hud.detail.step'), `${t(`hud.state.${update.stepState || 'todo'}`)} · ${update.step}`);
    } else if (ask && (ask.text || ask.title)) {
      const q = document.createElement('div'); q.className = 'dt'; q.textContent = ask.text || ask.title; box.appendChild(q);
    }
    const refs = (update && update.refs) || (ask && ask.refs) || [];
    if (refs.length) row(t('hud.detail.refs'), refs.map((r) => r.label).join(' · '));
    // Inline answer (T-31 0.2.3 batch C): only kind:'ask' waits are answerable (views.mjs ownerAttention), and only
    // in the owner build (payload.answer.owner, app:info.ownerAdmin). Off in a release build; a locked/mirror board
    // shows the read-only "enter the PIN" state instead of failing silently.
    if (ask && ask.kind === 'ask' && ownerBuild()) box.appendChild(answerControls(ask));
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ghost slim hud-open'; btn.textContent = t('hud.open');
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (openBoardTask) openBoardTask(taskId); });
    box.appendChild(btn);
    return box;
  }

  // ---- inline ask answers (T-31 0.2.3 batch C) ----
  // The answered set is keyed by the ask's identity+revision (`kind:id@rev`), so an ask already answered (or whose
  // revision advanced) renders as done and cannot be re-sent; main's own answered-set and the board (ops.mjs) are
  // the server-side twins. `last.answer` (from hud-host.mjs) says whether this build may answer at all (`owner`) and
  // whether the board is writable right now (`live`).
  const ownerBuild = () => Boolean(last && last.answer && last.answer.owner);
  const boardWritable = () => Boolean(last && last.answer && last.answer.live);
  const answerKey = (w) => `${w.key}@${w.rev}`;
  // The way out of a rejected sign-in (T-31 0.2.11 auth-401, Opus review): Settings > Account with the sign-in form open
  // (settings.js listens), the same place the Board tab's rejected overlay sends the user.
  const openBoardSignin = () => document.dispatchEvent(new CustomEvent('zumi:board-signin'));
  function signinButton() {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ghost slim hud-signin'; b.textContent = t('board.rejected.action');
    b.addEventListener('click', openBoardSignin);
    return b;
  }
  $('hud-signin').addEventListener('click', openBoardSignin);
  const answerReasonKey = (reason) => (reason === 'locked' ? 'hud.answer.locked' : reason === 'auth_rejected' ? 'hud.answer.authRejected' : reason === 'text_too_long' ? 'hud.answer.tooLong' : 'hud.answer.failed');

  function answerControls(ask) {
    const wrap = document.createElement('div');
    wrap.className = 'hud-answer';
    wrap.dataset.key = answerKey(ask); // lets paint() re-focus the note across a repaint (T-31 fix round 1610 r3)
    wrap.addEventListener('click', (e) => e.stopPropagation()); // a click here never toggles the card
    const st = answered.get(answerKey(ask));
    if (st === 'done') { const d = document.createElement('div'); d.className = 'a-state done'; d.textContent = t('hud.answer.done'); wrap.appendChild(d); return wrap; }
    if (st === 'sending') { const s = document.createElement('div'); s.className = 'a-state'; s.textContent = t('hud.answer.sending'); wrap.appendChild(s); return wrap; } // a repaint mid-send never re-enables the controls
    if (!boardWritable()) { const l = document.createElement('div'); l.className = 'a-state locked'; l.textContent = t('hud.answer.locked'); wrap.appendChild(l); return wrap; }

    const chosen = drafts.get(answerKey(ask)); // the draft, not a fresh closure: a repaint (the next poll) restores the pick and the note
    const btns = document.createElement('div');
    btns.className = 'a-btns';
    const mark = (btn) => { for (const b of btns.children) b.classList.toggle('sel', b === btn); };
    const opts = Array.isArray(ask.options) ? ask.options : [];
    if (opts.length) { // an ask with options: one button per option (the board's own option row)
      for (const o of opts) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost slim a-opt'; b.textContent = o.label || o.key;
        if (chosen.choice === o.key) b.classList.add('sel'); // restore a pick the last repaint would have wiped
        b.addEventListener('click', () => { chosen.choice = o.key; chosen.verdict = null; mark(b); updateSend(); });
        btns.appendChild(b);
      }
    } else { // no options: approve / reject (the board's own approve / reject buttons)
      for (const [v, key] of [['approve', 'hud.answer.approve'], ['reject', 'hud.answer.reject']]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost slim a-verdict'; b.textContent = t(key);
        if (chosen.verdict === v) b.classList.add('sel');
        b.addEventListener('click', () => { chosen.verdict = v; chosen.choice = null; mark(b); updateSend(); });
        btns.appendChild(b);
      }
    }
    wrap.appendChild(btns);
    const noteIn = document.createElement('input');
    noteIn.type = 'text'; noteIn.className = 'a-note'; noteIn.placeholder = t('hud.answer.note'); noteIn.autocomplete = 'off';
    noteIn.value = chosen.text || ''; // restore the note text across a repaint
    noteIn.addEventListener('input', () => { chosen.text = noteIn.value; updateSend(); });
    wrap.appendChild(noteIn);
    const send = document.createElement('button');
    send.type = 'button'; send.className = 'primary slim a-send'; send.textContent = t('hud.answer.send');
    wrap.appendChild(send);
    const status = document.createElement('div'); status.className = 'a-state'; status.setAttribute('aria-live', 'polite');
    wrap.appendChild(status);
    // A send that failed (T-31 fix round 1610 r3, review fix): the result rides the draft, so a repaint mid-send shows the
    // error on the CURRENT card instead of a replaced one. A retry clears it (doSend).
    if (chosen.error) { status.className = 'a-state err'; status.textContent = t(answerReasonKey(chosen.error)); }
    if (chosen.error === 'auth_rejected') wrap.appendChild(signinButton());
    function updateSend() { send.disabled = !canSendDraft(chosen); }
    async function doSend() {
      if (send.disabled) return;
      chosen.error = null; // a retry clears the previous failure
      answered.set(answerKey(ask), 'sending');
      paint(); // rebuild from the draft: the CURRENT card shows Sending… (a poll may replace this card mid-send)
      const text = String(chosen.text || '').trim();
      let r;
      try { r = await zumi.hud.answerAsk({ id: ask.id, rev: ask.rev, choice: chosen.choice || undefined, verdict: chosen.verdict || undefined, text: text || undefined }); }
      catch (e) { r = { ok: false, reason: 'failed', error: String(e && e.message || e) }; }
      note({ kind: 'ask-answer', id: ask.id, rev: ask.rev, choice: chosen.choice, verdict: chosen.verdict, ok: Boolean(r && r.ok), reason: (r && r.reason) || null });
      if (r && (r.ok || r.reason === 'already_answered')) { answered.set(answerKey(ask), 'done'); drafts.drop(answerKey(ask)); paint(); return; } // the board already has it: answered, so the draft is retired
      if (r && r.reason === 'in_flight') { answered.set(answerKey(ask), 'sending'); paint(); return; } // another write for this ask is in flight; repaint from the draft, never the replaced card
      answered.delete(answerKey(ask));
      chosen.error = (r && r.reason) || 'failed'; // the send result rides the draft (keyed by ask revision): answerControls shows it on the CURRENT card
      paint();
    }
    send.addEventListener('click', doSend);
    updateSend();
    return wrap;
  }

  // A real card: the code/title/age row, an optional step line, the B1 click, and (when open) the detail block.
  function card({ taskId, isHot, parts, step, update, ask }) {
    const el = li(`hud-item${isHot ? ' hot' : ''}`, parts);
    if (step) {
      const line = document.createElement('div');
      line.className = 'step';
      const chip = document.createElement('i');
      chip.className = `state s-${step.state}`;
      chip.textContent = t(`hud.state.${step.state}`);
      line.append(chip, document.createTextNode(step.label));
      el.appendChild(line);
    }
    if (ask && ask.refs && ask.refs.length) el.classList.add('has-ref');
    el.dataset.task = taskId;
    if (expanded === taskId) { el.classList.add('open'); el.appendChild(detailBlock(taskId, update, ask)); }
    el.addEventListener('click', () => onCardClick(taskId, el));
    return el;
  }

  function paint() {
    const on = prefs.style !== 'off';
    root.dataset.style = on ? prefs.style : 'off';
    if (!on) { root.hidden = true; return; }
    const feed = last && last.feed;
    const now = Date.now();
    for (const [id, until] of hot) if (until < now) hot.delete(id);
    const ups = $('hud-updates');
    const upsScroll = ups.scrollTop; // the rebuild below resets it; the list scrolls (hud.css)
    ups.innerHTML = '';
    $('hud-unavailable').hidden = Boolean(feed) || !last;
    // A rejected sign-in (board-live.mjs latch) says so, instead of the generic "can't see the board" (T-31 0.2.11).
    const rejected = !feed && Boolean(last) && last.unavailable === 'auth_rejected';
    const unavailableKey = rejected ? 'hud.unavailable.auth' : 'hud.unavailable';
    $('hud-unavailable').setAttribute('data-i18n', unavailableKey);
    $('hud-unavailable').textContent = t(unavailableKey);
    $('hud-signin').hidden = !rejected;
    if (feed) {
      for (const u of feed.updates) {
        ups.appendChild(card({
          taskId: u.id, isHot: hot.has(u.id),
          parts: [['code', u.id], ['title', u.title], ['age', age(u.at)]],
          step: u.step ? { state: u.stepState || 'todo', label: u.step } : null,
          update: u,
        }));
      }
      if (!feed.updates.length) ups.appendChild(li('hud-item empty', [['title', t('hud.none')]]));
    }
    ups.scrollTop = upsScroll;
    $('hud-asks-title').textContent = t('hud.asks', { n: feed ? feed.waitingCount : 0 });
    const asks = $('hud-asks');
    // Focus (T-31 fix round 1610 r3): this repaint replaces the note input, so remember where the owner was typing and
    // put the caret back after the rebuild. The draft above keeps the text; this keeps the caret.
    const active = document.activeElement;
    const focusKey = active && active.classList && active.classList.contains('a-note') && active.closest('.hud-answer') ? active.closest('.hud-answer').dataset.key : null;
    const focusStart = focusKey != null ? active.selectionStart : null;
    asks.innerHTML = '';
    if (feed) {
      for (const w of feed.waiting) {
        asks.appendChild(card({
          taskId: w.taskId, isHot: hot.has(w.taskId),
          parts: [['code', w.taskId], ['title', w.text || w.title], ['age', age(w.since)]],
          ask: w,
        }));
      }
      if (!feed.waiting.length) asks.appendChild(li('hud-item empty', [['title', t('hud.noneWaiting')]]));
      drafts.prune(new Set(feed.waiting.map(answerKey))); // an ask no longer waiting carries no draft forward
    }
    if (focusKey != null) { const noteEl = asks.querySelector(`.hud-answer[data-key="${cssEsc(focusKey)}"] .a-note`); if (noteEl) { noteEl.focus({ preventScroll: true }); try { noteEl.setSelectionRange(focusStart, focusStart); } catch { /* input replaced by a state block */ } } }
    $('hud-consent').hidden = !consent;
    if (consent) {
      $('hud-consent-target').textContent = consent.label && consent.label !== consent.target ? `${consent.label} · ${consent.target}` : consent.target;
      $('hud-consent-task').textContent = consent.taskId || '';
    }
    paintWatch();
    paintPanel(feed, now);
    syncVisible();
    requestAnimationFrame(fitRows);
  }

  // T-31 alpha.12: the read-only watcher's card ('hud:feed' watch, agent-core.mjs). Codes, counts and step ids only; hidden when empty.
  function paintWatch() {
    const list = Array.isArray(last && last.watch) ? last.watch : [];
    const panel = $('hud-watch');
    if (!panel) return;
    panel.hidden = list.length === 0;
    $('hud-watch-title').textContent = t('hud.watch', { n: list.length });
    const ol = $('hud-watch-list');
    ol.innerHTML = '';
    for (const w of list) {
      const el = li('hud-item', [['code', w.task], ['title', t(`hud.watch.${w.rule}`, { step: w.step || '', c: w.c || 0 })], ['age', w.since ? age(w.since) : '']]);
      el.dataset.rule = w.rule;
      ol.appendChild(el);
    }
  }

  // A group is height-capped to keep clear of her arms (hud.css): rows that do not fit whole are hidden, never cut --
  // unless the list scrolls (the asks list, hud.css). A scrolling list keeps every row reachable, so fitRows never
  // hides one there (T-31 fix round 1610: an expanded ask must not push the other asks out of the panel).
  function fitRows() {
    for (const ol of root.querySelectorAll('.hud-list')) {
      const items = [...ol.children];
      for (const li of items) li.hidden = false;
      if (getComputedStyle(ol).overflowY === 'auto') continue;
      const panel = ol.closest('.hud-panel').getBoundingClientRect();
      for (const li of items) if (!li.classList.contains('open') && li.getBoundingClientRect().bottom > panel.bottom - 6) li.hidden = true;
    }
  }
  window.addEventListener('resize', () => requestAnimationFrame(() => { if (last) paintPanel(last.feed, Date.now()); fitRows(); }));

  // The HUD belongs to the talk camera: hidden while a painted room shows its work/room view.
  // T-31 hud-panels: the new panel's NOW line is cut to the box it actually has, and a hidden stage gives it no width --
  // so the first frame back on the talk view re-paints it (panel only; the two old lists are untouched).
  function syncVisible() {
    const view = getView();
    const visible = !(prefs.style === 'off' || (view != null && view !== 'talk'));
    root.hidden = !visible;
    if (visible && !wasVisible && last) paintPanel(last.feed, Date.now());
    wasVisible = visible;
  }
  setInterval(syncVisible, 400);

  function clearConsent() { consent = null; clearTimeout(consentTimer); $('hud-consent-status').textContent = ''; paint(); }
  async function answer(yes) {
    if (!consent) return;
    const id = consent.id;
    $('hud-consent-ok').disabled = true; $('hud-consent-no').disabled = true;
    const r = await zumi.hud.answer(id, yes);
    note({ kind: 'answer', yes, opened: r.opened, reason: r.reason });
    $('hud-consent-ok').disabled = false; $('hud-consent-no').disabled = false;
    if (yes && !r.opened) { $('hud-consent-status').textContent = t('hud.consent.failed'); setTimeout(clearConsent, 2500); return; }
    clearConsent();
  }
  $('hud-consent-ok').addEventListener('click', () => answer(true));
  $('hud-consent-no').addEventListener('click', () => answer(false));

  async function react(reaction) {
    const until = Date.now() + HOT_MS;
    for (const id of reaction.taskIds) hot.set(id, until);
    lastPrimary = reaction.primary || lastPrimary; // the new panel follows the task she just reacted to
    setTimeout(paint, HOT_MS + 50);
    root.classList.remove('ping'); void root.offsetWidth; root.classList.add('ping');
    // Turn toward the exact card that changed (A1): its live rect -> stage NDC is passed as the gesture's one-shot
    // 'dynamic' look target, and the SAME point picks the arm variant (0.2.7 step 5): the hand on the card's side
    // points at it, except with the float-holo panel up and a screen-left card (her right hand is the panel hand):
    // then the other hand's small wave plays instead. The status expression is part of every arm variant, so
    // blocked still reads 'concerned'. Still not 'turn-point': its right arm reach sweeps through the panels.
    // reaction:true -> reactionLook: a yield fade in progress must not skip the gaze (DIAG r3 #3); lookSkip records
    // why a target was still skipped ('nocard' / 'hidden' / 'offstage') and lookFaded whether the card's group was
    // arm-yielded at the moment of the reaction, so the note proves the yield cause.
    const { look: target, skip: lookSkip, faded: lookFaded } = cardLook(reaction.primary, reaction.source, { reaction: true });
    const variant = stateToVariant(reaction.state, target, { float: Boolean(engine.holoPanel) });
    // T-31 C1 step 10: a step event while she is WORKING is work behaviour, not a card glance -- the work loop plays
    // the same shipped board variants at the panel (done -> nod-smile, blocked/failed -> concerned, then a look at
    // anh). It answers false when the loop is not running (signal off, no panel), so the card reaction below still
    // plays exactly as before; that is also the last reaction of a work session.
    const workState = reaction.state === 'done' || reaction.state === 'blocked' || reaction.state === 'failed';
    let workHandled = false;
    if (hasModel()) {
      // Same re-sleep fix as app.js's onBoardEvent: a HUD reaction counts as activity, so the idle ladder is
      // reset BEFORE 'sleepy' is exited (noteActivity never fires the wake startle; the board gesture reacts).
      engine.noteActivity();
      if (engine.isState('sleepy')) engine.exitState('sleepy');
      workHandled = Boolean(workState && typeof onWorkEvent === 'function' && onWorkEvent({ state: reaction.state }));
      if (!workHandled) {
        catalog.forceNext('board', variant);
        engine.trigger('board', { look: target });
      }
    }
    if (reaction.consent) {
      consent = { ...reaction.consent, at: Date.now() };
      clearTimeout(consentTimer);
      consentTimer = setTimeout(clearConsent, Math.max(1000, (reaction.consent.ttlMs || 120000) - 2000)); // expire before main does
    }
    note({ kind: 'reaction', taskIds: reaction.taskIds, primary: reaction.primary || null, source: reaction.source || null, state: reaction.state || '', variant, look: target, lookSkip, lookFaded, work: workHandled, consent: Boolean(reaction.consent) });
    paint();
    if (devRun) watchClearance(reaction);
    // Voice is the talk scheduler's now (T-31 talk-mode): the host hands each reaction to main via onReaction and the
    // scheduler decides whether to speak it, so the HUD no longer plays proactive lines itself.
  }

  // Dev/test runs only: for the whole gesture, every frame, are both arms clear of every visible panel? (06-10 rule)
  function watchClearance(reaction) {
    const canvas = $('stage-canvas');
    const t0 = performance.now();
    let frames = 0;
    const probe = { points: 0, panels: 0 };
    const style = prefs.style; // at the start: the harness may switch styles before the 2.6 s window ends
    const hits = [];
    const step = () => {
      if (++frames === 1) probe.points = armScreenPoints(engine, canvas).length;
      probe.panels = Math.max(probe.panels, panelRects(root).length); // most panels on screen at once (a group may be stepped aside)
      for (const h of armPanelHits(engine, canvas, root)) if (hits.length < 40) hits.push({ ms: Math.round(performance.now() - t0), ...h });
      if (performance.now() - t0 < 2600) requestAnimationFrame(step);
      else note({ kind: 'clearance', taskIds: reaction.taskIds, style, consent: Boolean(reaction.consent), frames, ...probe, hits });
    };
    requestAnimationFrame(step);
  }

  // Step aside (06-10 rule: no body part behind or through a panel). The panels sit in the top corners, out of the board
  // reaction's way, but idle moves (a stretch, arms overhead) can still reach there: every frame the HUD is on screen,
  // both arms are projected to the screen (clearance.js) and a group an arm comes within YIELD_PX of fades out at once,
  // coming back YIELD_HOLD_MS after the arm has left. Cheap: ~10 bone positions and a few rectangles per frame.
  const YIELD_PX = 90;
  const YIELD_HOLD_MS = 450;
  const groups = [...root.querySelectorAll('.hud-group')];
  const yieldLoop = () => {
    requestAnimationFrame(yieldLoop);
    if (root.hidden) return;
    const pts = armScreenPoints(engine, $('stage-canvas'));
    const now = performance.now();
    for (const g of groups) {
      const b = g.getBoundingClientRect();
      const near = b.width > 0 && pts.some((p) => p.x > b.left - YIELD_PX && p.x < b.right + YIELD_PX && p.y > b.top - YIELD_PX && p.y < b.bottom + YIELD_PX);
      if (near) { g.classList.add('yield'); g.dataset.nearAt = String(now); }
      else if (g.classList.contains('yield') && now - Number(g.dataset.nearAt || 0) > YIELD_HOLD_MS) g.classList.remove('yield');
    }
  };
  requestAnimationFrame(yieldLoop);

  // Dev/test runs only: the same check for the whole run (idle moves too: a stretch, a sideways swing), every 3rd frame
  // while the HUD is on screen.
  const session = { frames: 0, hits: [] };
  if (devRun) {
    let n = 0;
    const tick = () => {
      requestAnimationFrame(tick);
      if (root.hidden || ++n % 3) return;
      session.frames++;
      for (const h of armPanelHits(engine, $('stage-canvas'), root)) if (session.hits.length < 40) session.hits.push({ at: Date.now(), style: prefs.style, ...h });
    };
    requestAnimationFrame(tick);
  }

  zumi.hud.onFeed((payload) => {
    if (!payload) return;
    if (onWorkFeed) onWorkFeed(workFeedOf(payload));
    if (onHoloFeed) onHoloFeed(workFeedOf(payload)); // R3: the holo panel shows the live task of the same rows
    prefs = { ...prefs, style: payload.style || prefs.style };
    last = payload.style === 'off' ? null : payload;
    if (payload.style === 'off') { clearConsent(); hot.clear(); answered.clear(); drafts.clear(); }
    paint();
    if (payload.reaction) react(payload.reaction);
  });

  // 8c F1: once the style is Off the host sends no more 'hud:feed', so the empty feed of the Off branch above never arrives; clear both consumers here.
  styleSel.addEventListener('change', async () => { prefs = await zumi.hud.setPrefs({ style: styleSel.value }); if (prefs.style === 'off') { last = null; if (onWorkFeed) onWorkFeed([]); if (onHoloFeed) onHoloFeed([]); } paintPrefs(); paint(); });
  // The two new panel selects (T-31 hud-panels): read on init (paintPrefs), saved on change, repainted at once. The
  // store is localStorage only -- main stays frozen (PLAN section 3).
  panelSel.addEventListener('change', () => { panelPrefs = savePanelPrefs({ ...panelPrefs, design: panelSel.value }); paintPrefs(); paint(); });
  placeSel.addEventListener('change', () => { panelPrefs = savePanelPrefs({ ...panelPrefs, place: placeSel.value }); paintPrefs(); paint(); });
  onLocaleChange(() => paint());

  try { prefs = await zumi.hud.getPrefs(); } catch { /* keep off */ }
  paintPrefs();
  paint();
  await zumi.hud.ready(); // main starts reading the board now (only when a style is on)
  const api = { get prefs() { return prefs; }, get last() { return last; }, get consent() { return consent; }, get answered() { return answered; }, log, session };
  return api;
}
