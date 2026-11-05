// DOM -> reflex triggers. Every handler is also callable directly (self-test drives these same
// functions with synthetic coordinates/keys, so the real wiring is what gets tested).
const CURSOR_EPISODE_GAP_MS = 700; // pointer still this long => next movement is a new "cursor" reaction
const PAT_WINDOW_MS = 1200;
const PAT_END_MS = 700;
const TYPING_STOP_MS = 1200;
const CLICK_MAX_MOVE_PX = 6;
const CLICK_MAX_MS = 450;

export function attachInput(engine, { stage, textbox, onSend }) {
  const st = { lastMoveAt: 0, lastX: null, lastY: null, down: null, pat: [], patActive: false, patLastAt: 0, typing: false, typeTimer: null, locked: false };

  const rect = () => stage.getBoundingClientRect();
  const toNdc = (x, y) => { const r = rect(); return [((x - r.left) / r.width) * 2 - 1, -(((y - r.top) / r.height) * 2 - 1)]; };
  const inHead = (x, y, hr) => hr && Math.hypot(x - hr.head.x, y - hr.head.y) <= hr.head.r;
  const inBody = (x, y, hr) => hr && x >= hr.body.x0 && x <= hr.body.x1 && y >= hr.body.y0 && y <= hr.body.y1;

  function pointerMove(x, y, t = performance.now()) {
    // T-31 0.2.7 (DIAG 20-10 §5 step 2): a pointer move still wakes her, drives the gaze and the cursor reflex,
    // and resets the bored/sleepy ladder -- but it is NOT a fresh owner input, so it leaves nextVarietyAt alone.
    // Before this, every move pushed the 15-40 s variety timer out and her arms never moved while anh was at the
    // PC (measured 0 idle-variety plays in the 90 s mouse phase). Keys and clicks still call noteInput().
    const woke = engine.noteActivity({ wake: true });
    const [nx, ny] = toNdc(x, y);
    engine.setPointer(nx, ny);
    const moved = st.lastX == null ? 99 : Math.hypot(x - st.lastX, y - st.lastY);
    if (!woke && t - st.lastMoveAt > CURSOR_EPISODE_GAP_MS && moved > 6) engine.trigger('cursor');
    st.lastMoveAt = t; st.lastX = x; st.lastY = y;

    const hr = engine.hitRegions(rect());
    if (inHead(x, y, hr)) {
      st.pat.push({ x, y, t });
      while (st.pat.length && t - st.pat[0].t > PAT_WINDOW_MS) st.pat.shift();
      let path = 0, reversals = 0, lastDx = 0;
      for (let i = 1; i < st.pat.length; i++) {
        const dx = st.pat[i].x - st.pat[i - 1].x;
        path += Math.hypot(dx, st.pat[i].y - st.pat[i - 1].y);
        if (Math.abs(dx) > 1.5) { if (lastDx && Math.sign(dx) !== Math.sign(lastDx)) reversals++; lastDx = dx; }
      }
      const r = hr.head.r;
      const stroking = (path > 2.2 * r && reversals >= 2) || (st.down && path > 1.2 * r);
      if (!st.patActive && stroking) { st.patActive = true; engine.enterState('pat'); }
      if (st.patActive) st.patLastAt = t;
    }
  }

  // T-31 C1 step 10 (CONCEPTS §5): is the pointer resting on her right now? The work loop asks this every frame while
  // working; it reads the last pointer position and the rig's live screen-space hit regions (the same head/body ones
  // poke and pat test), so a pointer that has not moved still counts when her head/body drifts under it. No model
  // bound -> no region -> false. Pure read: it never notes input or triggers anything.
  function pointerOver(stageRect = rect()) {
    if (st.lastX == null) return false;
    const hr = engine.hitRegions(stageRect);
    if (!hr) return false;
    return inHead(st.lastX, st.lastY, hr) || inBody(st.lastX, st.lastY, hr);
  }

  function pointerDown(x, y, t = performance.now()) { st.down = { x, y, t }; }

  function pointerUp(x, y, t = performance.now()) {
    const d = st.down;
    st.down = null;
    if (!d || st.patActive) return;
    if (Math.hypot(x - d.x, y - d.y) > CLICK_MAX_MOVE_PX || t - d.t > CLICK_MAX_MS) return;
    if (engine.noteInput()) return; // the click woke Zumi; the wake startle is the reaction
    const hr = engine.hitRegions(rect());
    const region = inHead(x, y, hr) ? 'head' : inBody(x, y, hr) ? 'body' : null;
    if (!region) return;
    // canonical poke variants react to a poke from screen-right; mirror for pokes on the left
    engine.trigger('poke', { side: x >= hr.head.x ? 1 : -1, region });
  }

  function keyInput(key) {
    const woke = engine.noteInput();
    if (key === 'Enter') {
      const text = textbox.value.trim();
      clearTimeout(st.typeTimer);
      if (st.typing) { st.typing = false; engine.exitState('typing'); }
      if (!text) return;
      textbox.value = '';
      if (!woke) engine.trigger('send');
      if (onSend) onSend(text);
      return;
    }
    if (!st.typing) { st.typing = true; engine.enterState('typing'); }
    clearTimeout(st.typeTimer);
    st.typeTimer = setTimeout(() => {
      st.typing = false;
      engine.exitState('typing');
      engine.trigger('typing-stop');
    }, TYPING_STOP_MS);
  }

  function tick(t = performance.now()) {
    if (st.patActive && t - st.patLastAt > PAT_END_MS) { st.patActive = false; st.pat.length = 0; engine.exitState('pat'); }
  }
  const tickTimer = setInterval(() => tick(), 100);

  const guard = (fn) => (e) => { if (!st.locked) fn(e); };
  const onMove = guard((e) => pointerMove(e.clientX, e.clientY));
  const onDown = guard((e) => { if (e.button === 0) pointerDown(e.clientX, e.clientY); });
  const onUp = guard((e) => { if (e.button === 0) pointerUp(e.clientX, e.clientY); });
  const onKey = guard((e) => { if (e.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); keyInput('Enter'); } else if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Process') keyInput(e.key); });
  const onInput = guard(() => { if (!st.typing || textbox.value) keyInput('input'); });
  window.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  textbox.addEventListener('keydown', onKey);
  textbox.addEventListener('input', onInput);

  return {
    pointerMove, pointerDown, pointerUp, keyInput, tick, pointerOver,
    setLocked(v) { st.locked = v; },
    isPatting: () => st.patActive,
    isTyping: () => st.typing,
    dispose() {
      clearInterval(tickTimer);
      window.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      textbox.removeEventListener('keydown', onKey);
      textbox.removeEventListener('input', onInput);
    },
  };
}
