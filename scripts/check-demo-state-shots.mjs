// T-31 visual gate 14, D4: the demo's pending / reply-first-paint shots are taken on state signals (director 'sent',
// reply row non-empty), with the cloud turn held until the pending shot is done, so both hosts photograph one moment.
//   node scripts/check-demo-state-shots.mjs
import fs from 'node:fs';
import { holdTurnForShots } from '../src/renderer/demo.js';

let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}${d ? '  ' + d : ''}`); } };

function rig(replyDelayMs) {
  const st = { user: '', reply: '' };
  const listeners = new Set();
  const calls = { turn: 0 };
  const director = {
    onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    cloud: { turn: async () => { calls.turn++; await new Promise((r) => setTimeout(r, replyDelayMs)); return { reply: 'full reply' }; } },
  };
  const origTurn = director.cloud.turn;
  // what director.send does: userLine + thinking, emit 'sent', then await cloud.turn, then paint the reply
  const send = async () => {
    st.user = 'hello'; st.reply = '';
    for (const cb of listeners) cb({ type: 'sent' });
    (async () => { const r = await director.cloud.turn(); st.reply = r.reply; })();
  };
  return { st, director, calls, send, origTurn };
}

{
  const r = rig(10); // a reply far faster than any poller: the old timing-based shot would have missed pending
  const shots = [];
  const shot = async (name) => { shots.push({ name, state: { ...r.st }, turnsStarted: r.calls.turn }); return name; };
  const out = await holdTurnForShots({ director: r.director, line: { shotPending: true }, n: 0, shot, log: () => {}, send: r.send, readState: () => ({ ...r.st }) });
  ok(out.pending === '01-pending.png' && out.streaming === '01-streaming.png', 'both shots taken, named by line number', JSON.stringify(out));
  ok(shots[0].state.user === 'hello' && shots[0].state.reply === '', 'pending shot: user line shown, reply row empty');
  ok(shots[0].turnsStarted === 0, 'pending shot: the cloud turn had not even started (held)');
  ok(shots[1].state.reply === 'full reply', 'streaming shot: taken once the reply row holds text');
  ok(r.director.cloud.turn === r.origTurn, 'cloud.turn restored after the shots');
}

{
  const r = rig(10);
  const shots = [];
  const out = await holdTurnForShots({ director: r.director, line: {}, n: 1, shot: async (n) => { shots.push(n); return n; }, log: () => {}, send: r.send, readState: () => ({ ...r.st }) });
  ok(shots.length === 0 && out.pending === null && out.streaming === null, 'a line without shotPending takes no state shots and does not hold the turn');
  ok(r.director.cloud.turn === r.origTurn, 'and leaves cloud.turn untouched');
}

{
  const r = rig(10);
  r.send = async () => { /* Enter never reached the director */ };
  let threw = null;
  try { await holdTurnForShots({ director: r.director, line: { shotPending: true }, n: 0, shot: async (n) => n, log: () => {}, send: r.send, readState: () => ({ user: '', reply: '' }) }); } catch (e) { threw = e; }
  ok(threw && /never emitted sent/.test(threw.message), 'no sent event = the run fails loudly (not a silent skip)');
  ok(r.director.cloud.turn === r.origTurn, 'cloud.turn restored even on failure');
}

{
  // reply already painted when 'sent' fires => not a pending state
  const r = rig(10);
  const listeners = [];
  r.director.onEvent = (cb) => { listeners.push(cb); return () => {}; };
  const send = async () => { r.st.user = 'hi'; r.st.reply = 'already here'; listeners.forEach((cb) => cb({ type: 'sent' })); };
  let threw = null;
  try { await holdTurnForShots({ director: r.director, line: { shotPending: true }, n: 0, shot: async (n) => n, log: () => {}, send, readState: () => ({ ...r.st }) }); } catch (e) { threw = e; }
  ok(threw && /not a pending state/.test(threw.message), 'a reply already on screen at pending time fails the shot instead of recording a fake pending');
}

const demoSrc = fs.readFileSync(new URL('../src/renderer/demo.js', import.meta.url), 'utf8');
ok(/holdTurnForShots\(\{ director: d, line, n, shot/.test(demoSrc), 'runDemo uses holdTurnForShots on every scripted line');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
