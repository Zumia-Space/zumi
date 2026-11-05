// Room QC shots (T-31 R3). Drives the real UI like the owner would: loads the default room behind Zumi, opens
// Settings to show the room picker, then triggers a refused import (a too-big fixture derived from the real
// default room) to show the plain-English refusal message. Runs only when the app was started with --room-shots
// (main.js), driven the same way selftest/demo/wardrobe-shots drive themselves — see app.js's boot section.
import { renderRoomRefused, currentRoomClause } from '../room/messages.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Best-effort frame rate (T-31 R3 QC, "the frame rate if you could measure it" — not a perf-budget measurement,
// R6 is out of scope here; just a real number from this run on this machine). Counts rAF callbacks for `ms`.
function measureFps(ms) {
  return new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else resolve({ frames, ms: performance.now() - t0, fps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1) });
    };
    requestAnimationFrame(tick);
  });
}

// Instrument guard (visual gate 14, D1b): a room-shots run on a host that lists no room used to finish ok=true with
// "selected none" and look_target undefined, which hid a missing room behind a green self-test. The run is only valid
// when a room really is selected and both forced glances landed on a real look_target.
// `glanceSkipReason` (visual gate 14 I3): a v2 room authors look_targets per view and the approved room has none on talk;
// when no view with look_targets is reachable the run logs this reason and skips the glance assertions explicitly.
export function roomShotsVerdict({ selected, targetA, targetB, message, glanceSkipReason }) {
  const problems = [];
  if (!selected || selected === 'none') problems.push(`no room selected (selected=${JSON.stringify(selected)})`);
  if (!glanceSkipReason) {
    if (typeof targetA !== 'string' || !targetA) problems.push('glance A look_target is undefined');
    if (typeof targetB !== 'string' || !targetB) problems.push('glance B look_target is undefined');
  }
  if (!message) problems.push('no bad-room refusal message');
  return { ok: problems.length === 0, problems };
}

export async function runRoomShots({ zumi, $, engine, openZumiTab, openSettingsTab }) {
  const log = (m) => { console.log(`[room-shots] ${m}`); zumi.shots.log(m); };
  const capture = (name) => zumi.shots.capture(name);

  try {
    // The --model VRM is a large file (compile + decode can take tens of seconds, same cost the wardrobe shots
    // wait out); wait for the model's own "Loading model…" overlay to clear before picking the room, or the
    // Zumi-tab shot catches a 0% spinner instead of Zumi. The overlay element exists regardless of which tab is
    // on screen, so this is safe to poll before switching tabs.
    for (let i = 0; i < 300 && !$('loading').hidden; i++) await sleep(200); // up to 60s

    // T-31 0.2.11: the default room is default-v2 (Night City); room v1 "Zumi's Office" was removed (owner decision 2026-10-26).
    log('opening Settings and picking the default room (Night City) through the real picker control');
    openSettingsTab();
    await sleep(300);
    const picker = $('room-picker');
    // Visual gate 14 I2: take the host's own room, never a hard-coded v1 id ('default' is not an option on a v2 host,
    // so the old value was '' and the select was silently ignored): default-v2 if listed, else the first real room.
    const roomIds = [...picker.options].map((o) => o.value).filter((v) => v && v !== 'none');
    const pick = roomIds.includes('default-v2') ? 'default-v2' : roomIds[0];
    log(`room picker lists [${roomIds.join(', ')}], picking "${pick}"`);
    // Visual gate 14 I5: boot already loaded default-v2, so #room-view-picker is visible before any pick and cannot be
    // trusted as a ready signal; re-picking the same id would only dispose and reload the room mid-capture. Skip the
    // pick when it is already the loaded room; otherwise hide the picker first so its un-hide is a real signal.
    const viewPicker = $('room-view-picker');
    if (picker.value === pick) {
      log(`"${pick}" is already loaded from boot; not re-picking it`);
    } else {
      if (viewPicker) viewPicker.hidden = true;
      picker.value = pick;
      picker.dispatchEvent(new Event('change')); // same control + event the owner's own click fires (room-settings.js)
    }
    // There is no room-ready event; for a v2 room the View picker un-hides once switchRoom() has loaded it, so wait on
    // that (up to 15s), then a short settle for the first plate draw. A room without views keeps the fixed sleep.
    await sleep(300);
    for (let i = 0; i < 75 && viewPicker && viewPicker.hidden; i++) await sleep(200);
    await sleep(viewPicker && !viewPicker.hidden ? 500 : 1200);
    const selected = ((await zumi.rooms.list()) || {}).selected; // what the host actually selected, not what we asked for

    log('Zumi in the room');
    openZumiTab();
    await sleep(500);
    await capture('01-zumi-in-room.png');
    const fps = await measureFps(2000);
    log(`frame rate: ${fps.fps} fps over ${fps.frames} frames / ${fps.ms.toFixed(0)} ms (Zumi + default room, this machine)`);

    log('back to Settings, room picker now shows the selected room');
    openSettingsTab();
    // The room picker lives in the "Phòng & HUD" inner tab (T-31 settings P1), not the default/remembered first tab:
    // select it so the shot frames the picker instead of whatever inner tab was last open.
    const roomTab = document.getElementById('stab-room');
    if (roomTab) roomTab.click();
    await sleep(300);
    await capture('02-settings-room-picker.png');

    log('triggering a refused import (too-big fixture) to show the bad-room message');
    const nowRooms = await zumi.rooms.list(); // the default room is still selected -- a refused import never changes it
    const result = await zumi.shots.badRoom();
    const message = result && result.error ? renderRoomRefused(result.error, currentRoomClause(nowRooms)) : null;
    const note = $('room-note');
    if (note) { note.textContent = message || 'Could not add this room.'; note.classList.add('bad'); }
    log(`refusal message: "${message}"`);
    await sleep(300);
    await capture('03-bad-room-message.png');

    // R4a QC (PLAN-R4-lean.md §R4a): two idle glances toward the room's look_targets, forced so the shot lands
    // mid-glance instead of waiting on the real random timer -- lifeLayer()'s own anti-repeat (last 3) is what
    // this is proving, so we only ever RESET its schedule here, never pick the target ourselves.
    openZumiTab();
    await sleep(300);
    // Visual gate 14 I3: the approved v2 room authors look_targets only on 'work' (talk/room have none). Use the real
    // View picker to reach a view that has them; if it is unreachable (v1/no views, or 'work' disabled in this
    // build) the glance assertions are skipped with an explicit logged reason only when a View picker exists.
    let glanceSkipReason = null;
    const viewSelect = $('room-view-select');
    if (viewPicker && !viewPicker.hidden && viewSelect) {
      const workOpt = viewSelect.querySelector('option[value="work"]');
      if (workOpt && !workOpt.hidden && !viewSelect.disabled) {
        viewSelect.value = 'work';
        viewSelect.dispatchEvent(new Event('change'));
        log('switched to the work view (the view that authors look_targets)');
        await sleep(1500); // camera ease + seat/pose switch
      } else {
        glanceSkipReason = "v2 room has no reachable view with look_targets (talk has none; 'work' is not selectable in this build)";
        log(`glance assertions SKIPPED: ${glanceSkipReason}`);
      }
    }
    log('forcing an idle glance toward a room look_target');
    engine.pointer.at = performance.now() - 3000; // pointer "still" long enough to be eligible
    engine.life.glanceNext = 0; engine.life.glanceUntil = 0; // force a fresh pick on the next lifeLayer() tick
    await sleep(400); // glance eases in over ~120ms -- 400ms in is clearly mid-glance, well before it ends (600-1500ms)
    const targetA = engine.life.lookHistory[engine.life.lookHistory.length - 1];
    log(`glance A -> look_target "${targetA}"`);
    await capture('20-glance-a.png');

    log('forcing a second idle glance toward a different look_target (anti-repeat)');
    engine.life.glanceNext = 0; engine.life.glanceUntil = 0;
    await sleep(400);
    const targetB = engine.life.lookHistory[engine.life.lookHistory.length - 1];
    log(`glance B -> look_target "${targetB}"`);
    await capture('21-glance-b.png');

    const verdict = roomShotsVerdict({ selected, targetA, targetB, message, glanceSkipReason });
    if (!verdict.ok) log(`FAILED: ${verdict.problems.join('; ')}`);
    await zumi.shots.finish({ ok: verdict.ok, message, selected, fps, glanceA: targetA, glanceB: targetB, ...(glanceSkipReason ? { glanceSkipped: glanceSkipReason } : {}), ...(verdict.ok ? {} : { error: verdict.problems.join('; ') }) });
  } catch (e) {
    console.error(e);
    log(`FAILED: ${String((e && e.stack) || e)}`);
    await zumi.shots.finish({ ok: false, error: String((e && e.message) || e) });
  }
}
