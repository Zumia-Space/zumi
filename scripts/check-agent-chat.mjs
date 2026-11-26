// R2 "usable from chat": the renderer side of agent.* (src/renderer/agent-chat.js). Plain Node, no browser: the pure state
// machine is tested directly, the DOM controller against a small fake document.
//   node scripts/check-agent-chat.mjs     (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_STATE, activityText, agentAvailable, applyEvent, errorText, initAgentChat, routeSentence, rowText, usdText } from '../src/renderer/agent-chat.js';
import { TABLES, setLocale, t } from '../src/renderer/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- routing: a sentence is a task only with the switch on, the API there and some text ----
ok(routeSentence('open notepad', { taskMode: true, available: true }) === 'task', 'switch on + API + text = task');
ok(routeSentence('open notepad', { taskMode: false, available: true }) === 'chat', 'switch off = chat');
ok(routeSentence('open notepad', { taskMode: true, available: false }) === 'chat', 'no agent API (Electron) = chat');
ok(['', '   ', null, undefined].every((x) => routeSentence(x, { taskMode: true, available: true }) === 'chat'), 'a blank sentence is never a task');
ok(agentAvailable({ agent: { start() {}, onEvent() {} } }) && !agentAvailable({}) && !agentAvailable({ agent: { start() {} } }) && !agentAvailable(null), 'agentAvailable needs start and onEvent');

// ---- the chip state machine ----
const ev = (o) => ({ run: 'chat-1', ...o });
let s = EMPTY_STATE;
for (const e of [ev({ ev: 'task_start' }), ev({ ev: 'turn_start', step: 1 }), ev({ ev: 'tool_start', step: 1, name: 'hands.launch' }), ev({ ev: 'tool_end', step: 1, name: 'hands.launch', ok: true, ms: 40 }),
  ev({ ev: 'tool_start', step: 2, name: 'hands.type' }), ev({ ev: 'tool_end', step: 2, name: 'hands.type', ok: false, error: 'not_foreground', ms: 3 }), ev({ ev: 'turn', step: 2, cost_usd: 0.002 }), ev({ ev: 'turn', step: 3, cost_usd: 0.0015 })]) s = applyEvent(s, e);
ok(s.chips.length === 2 && s.chips[0].state === 'ok' && s.chips[1].state === 'fail' && s.chips[1].error === 'not_foreground', 'one chip per tool call: ok and failed, with the error code');
ok(Math.abs(s.costUsd - 0.0035) < 1e-12 && s.phase === 'working', 'cost adds up across turns');
s = applyEvent(s, ev({ ev: 'tool_start', step: 3, name: 'hands.key' }));
s = applyEvent(s, ev({ ev: 'run_end', status: 'stopped', reason: 'cancelled', cost_usd: 0.0035, steps: 3 }));
ok(s.phase === 'ended' && s.status === 'stopped' && s.reason === 'cancelled' && s.chips[2].state === 'fail', 'run_end closes the run and a chip still running becomes failed');
const same2 = applyEvent(s, ev({ ev: 'tool_start', step: 9, name: 'late' }));
ok(same2.chips.length === 3 || same2.chips.length === 4, 'an event of the ended run is harmless'); // adds a chip only if it reopens: it must not change status
ok(same2.status === 'stopped', 'a late event does not reopen an ended run');
let busy = applyEvent(EMPTY_STATE, ev({ ev: 'task_start' }));
const stale = applyEvent(busy, { run: 'chat-OTHER', ev: 'tool_start', step: 1, name: 'x' });
ok(stale === busy, 'an event of another run while this one works is dropped');
const next = applyEvent(s, { run: 'chat-2', ev: 'task_start' });
ok(next.run === 'chat-2' && next.chips.length === 0 && next.status === null, 'after a run ended, the next run starts clean');
ok(applyEvent(busy, null) === busy && applyEvent(busy, { ev: 'turn' }) === busy && applyEvent(busy, { run: 'chat-1' }) === busy, 'malformed events change nothing');
let c = applyEvent(EMPTY_STATE, ev({ ev: 'confirm', id: 'c-1', text: 'Delete the file?' }));
ok(c.confirm && c.confirm.id === 'c-1' && c.confirm.text === 'Delete the file?', 'a confirm event opens the card');
ok(applyEvent(c, ev({ ev: 'confirm_end', id: 'c-OTHER' })).confirm !== null && applyEvent(c, ev({ ev: 'confirm_end', id: 'c-1' })).confirm === null, 'confirm_end closes only its own card');
ok(applyEvent(c, ev({ ev: 'run_end', status: 'stopped', reason: 'cancelled' })).confirm === null, 'run_end closes an open card');
const orphan = applyEvent(EMPTY_STATE, ev({ ev: 'tool_end', step: 1, name: 'hands.launch', ok: true, ms: 5 }));
ok(orphan.chips.length === 1 && orphan.chips[0].state === 'ok', 'a tool_end whose start was missed still shows a chip');
let many = EMPTY_STATE;
for (let i = 0; i < 100; i++) many = applyEvent(many, ev({ ev: 'tool_start', step: i, name: `t${i}` }));
ok(many.chips.length === 40 && many.chips[39].name === 't99', 'at most 40 chips are kept (the newest)');

// ---- words ----
setLocale('en');
ok(usdText(0.0035) === '0.0035 USD' && usdText(0.5) === '0.50 USD' && usdText(undefined) === '0.0000 USD', 'cost text');
ok(errorText('busy').includes('already running') && errorText('chat_off: no key').includes('AI key') && errorText('zzz').includes('(zzz)'), 'error words: known, chat_off, unknown code kept');
ok(rowText({ sentence: 'open notepad', status: 'done', reason: null, cost_usd: 0.0035 }) === 'open notepad - done - 0.0035 USD', 'a done row');
ok(rowText({ sentence: 'x', status: 'stopped', reason: 'cancelled', cost_usd: 0 }).includes('stopped by you'), 'a user-stopped row says so');
ok(rowText({ sentence: 'x', status: 'stopped', reason: 'cost_cap', cost_usd: 0.4 }).includes('cost_cap'), 'a cap-stopped row names the cap');
{
  const why = 'monthly budget 5.00 USD (2026-11): 4.99 USD already spent, the next call could cost up to 0.02 USD';
  const budget = errorText(`budget_month: ${why}`);
  ok(budget.includes('budget') && budget.includes('4.99 USD') && !budget.includes('(budget_month'), 'the month cap is said in words with its numbers (not "could not do that (code)")', budget);
  ok(errorText('budget_unreadable: budget.json: not a number').includes('budget.json') && !errorText('budget_unreadable: x').includes('(budget_unreadable'), 'an unreadable budget is said in words');
  ok(rowText({ sentence: 'x', status: 'stopped', reason: `budget_month: ${why}`, cost_usd: 0 }).includes('4.99 USD'), 'a run row stopped by the month cap shows why');
}
ok(activityText({ step: 2, kind: 'tool', name: 'hands.type', decision: 'refused', code: 'not_foreground' }) === '2. hands.type - refused: not_foreground', 'a refused audit line shows the code');
ok(activityText({ step: null, kind: 'result', name: 'hands.launch', decision: 'allowed', code: null }) === 'result of hands.launch', 'a result line');

// ---- i18n: every key the module uses exists in all three languages ----
const src = fs.readFileSync(path.join(ROOT, 'src/renderer/agent-chat.js'), 'utf8');
const used = new Set([...src.matchAll(/['"`](agent\.[A-Za-z_.]+)['"`]/g)].map((m) => m[1]).filter((k) => !k.endsWith('.err.') && !k.endsWith('.status.')));
const dynamic = ['agent.status.running', 'agent.status.done', 'agent.status.stopped', 'agent.status.error', 'agent.err.bad_args', 'agent.err.bad_sentence', 'agent.err.busy', 'agent.err.thread_failed', 'agent.err.no_pending', 'agent.err.budgetMonth', 'agent.err.budgetUnreadable'];
for (const lang of ['en', 'vi', 'zh']) {
  const missing = [...used, ...dynamic].filter((k) => !(k in TABLES[lang]));
  ok(missing.length === 0, `${lang}: every agent.* key the module uses is translated`, missing.join(', '));
}
ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(src.replace(/\/\/.*$/gm, '')), 'the module never sets markup (textContent only)');

// ---- the controller on a fake document ----
function fakeDoc() {
  const byId = new Map();
  const mk = (tag) => {
    const listeners = {};
    let text = '';
    const el = {
      tag, children: [], dataset: {}, attrs: {}, hidden: false, className: '', title: '', alt: '', src: '', disabled: false, value: '', placeholder: '', _id: '',
      classList: { toggle(cls, on) { const set = new Set(el.className.split(' ').filter(Boolean)); if (on) set.add(cls); else set.delete(cls); el.className = [...set].join(' '); } },
      get id() { return el._id; }, set id(v) { el._id = v; byId.set(v, el); },
      get textContent() { return text; }, set textContent(v) { text = String(v); if (v === '') el.children = []; },
      appendChild(ch) { ch.parentNode = el; el.children.push(ch); return ch; },
      insertBefore(ch, ref) { ch.parentNode = el; const i = el.children.indexOf(ref); el.children.splice(i < 0 ? el.children.length : i, 0, ch); return ch; },
      remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((x) => x !== el); if (el._id) byId.delete(el._id); },
      setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute(k) { return el.attrs[k]; },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      async click() { for (const fn of listeners.click || []) await fn({}); },
      focus() { el.focused = true; },
      all() { return [el, ...el.children.flatMap((x) => x.all())]; },
    };
    return el;
  };
  const composer = mk('footer'); composer.className = 'composer';
  const msg = mk('input'); msg.id = 'msg'; msg.placeholder = 'Message Zumi… (Enter to send)'; composer.appendChild(msg);
  const stage = mk('div'); const analysis = mk('aside'); analysis.id = 'analysis'; stage.appendChild(analysis);
  const doc = { createElement: mk, querySelector: (sel) => (sel === 'footer.composer' ? composer : null) };
  return { doc, $: (id) => byId.get(id) || null, composer, msg, stage, byId };
}
function fakeZumi() {
  const bus = [];
  const calls = [];
  const z = {
    calls,
    emit(e) { bus.forEach((cb) => cb(e)); },
    status: { ok: true, active: null, runs: [], activity: [], frame: null, confirm: null },
    startResult: { ok: true, id: 'chat-1' },
    agent: {
      onEvent(cb) { bus.push(cb); return () => bus.splice(bus.indexOf(cb), 1); },
      async start(text) { calls.push(['start', text]); return z.startResult; },
      async stop() { calls.push(['stop']); return { ok: true, stopped: 1 }; },
      async status(id) { calls.push(['status', id]); return z.status; },
      async confirm(id, allow) { calls.push(['confirm', id, allow]); return { ok: true }; },
    },
  };
  return z;
}
const texts = (el) => el.children.map((x) => x.textContent);

{
  const f = fakeDoc(); const z = fakeZumi();
  const ctl = initAgentChat(z, f.$, { doc: f.doc, t, apply: () => {} });
  ok(ctl !== null && f.$('agent-strip') && f.$('agent-mode') && f.$('agent-stop') && f.$('agent-chips') && f.$('agent-confirm') && f.$('agent-activity'), 'the strip, the confirm card and the Activity panel are built');
  ok(f.composer.children.indexOf(f.$('agent-strip')) < f.composer.children.indexOf(f.msg), 'the strip sits above the chat box');
  ok(initAgentChat(z, f.$, { doc: f.doc, t, apply: () => {} }) === null, 'a second init builds nothing');
  ok(f.$('agent-stop').hidden === true && f.$('agent-activity').hidden === true && f.$('agent-confirm').hidden === true, 'Stop, the panel and the card start hidden');
  ok(ctl.take('open notepad') === false && !z.calls.some((x) => x[0] === 'start'), 'switch off: the sentence is left to the chat brain');
  await f.$('agent-mode').click();
  ok(ctl.taskMode() === true && f.$('agent-mode').attrs['aria-pressed'] === 'true' && f.msg.placeholder === t('agent.placeholderOn') && f.msg.focused === true, 'switch on: pressed, the placeholder says what Enter does, the box has focus');
  ok(ctl.take('   open notepad and write hi  ') === true, 'switch on: the sentence is taken as a task');
  await Promise.resolve();
  ok(same(z.calls.filter((x) => x[0] === 'start'), [['start', 'open notepad and write hi']]), 'agent.start got the trimmed sentence once');
  ok(ctl.take('   ') === false, 'a blank line is not taken');
  // events from the host paint chips and show Stop
  z.emit({ ev: 'task_start', run: 'chat-1' });
  z.emit({ ev: 'tool_start', run: 'chat-1', step: 1, name: 'hands.launch' });
  ok(f.$('agent-stop').hidden === false && same(texts(f.$('agent-chips')), ['hands.launch']) && f.$('agent-chips').children[0].className === 'agent-chip run', 'a tool_start paints a running chip and shows Stop');
  z.emit({ ev: 'tool_end', run: 'chat-1', step: 1, name: 'hands.launch', ok: true, ms: 40 });
  ok(f.$('agent-chips').children[0].className === 'agent-chip ok' && f.$('agent-chips').children[0].title === '40 ms', 'a tool_end turns it ok with its time');
  z.emit({ ev: 'tool_start', run: 'chat-1', step: 2, name: 'hands.type' });
  z.emit({ ev: 'tool_end', run: 'chat-1', step: 2, name: 'hands.type', ok: false, error: 'not_foreground', ms: 2 });
  ok(f.$('agent-chips').children[1].className === 'agent-chip fail' && f.$('agent-chips').children[1].title === 'not_foreground', 'a failed tool shows its error code');
  // Stop
  await f.$('agent-stop').click();
  ok(same(z.calls.filter((x) => x[0] === 'stop'), [['stop']]), 'Stop calls agent.stop');
  z.emit({ ev: 'run_end', run: 'chat-1', status: 'stopped', reason: 'cancelled', steps: 2, cost_usd: 0.002 });
  ok(f.$('agent-stop').hidden === true && f.$('agent-status').textContent === 'stopped (stopped by you) - 0.0020 USD', 'run_end hides Stop and says how it ended with the cost', f.$('agent-status').textContent);
  // confirm card
  z.emit({ ev: 'confirm', run: 'chat-2', id: 'c-9', text: 'Delete the file?' });
  ok(f.$('agent-confirm').hidden === false && f.$('agent-confirm-text').textContent === 'Delete the file?', 'a confirm event opens the card with the host text');
  await f.$('agent-confirm-allow').click();
  ok(same(z.calls.filter((x) => x[0] === 'confirm'), [['confirm', 'c-9', true]]) && f.$('agent-confirm').hidden === true, 'Allow answers yes once and closes the card');
  await f.$('agent-confirm-allow').click();
  ok(z.calls.filter((x) => x[0] === 'confirm').length === 1, 'a second click on a closed card answers nothing');
  z.emit({ ev: 'confirm', run: 'chat-2', id: 'c-10', text: 'Again?' });
  await f.$('agent-confirm-deny').click();
  ok(same(z.calls.filter((x) => x[0] === 'confirm')[1], ['confirm', 'c-10', false]), 'Deny answers no');
  // Activity panel
  z.status = { ok: true, active: null, selected: 'chat-1', runs: [{ id: 'chat-1', sentence: 'open notepad <b>x</b>', status: 'done', reason: null, steps: 2, cost_usd: 0.0035 }],
    activity: [{ t: 1, kind: 'tool', name: 'hands.launch', decision: 'allowed', code: null, step: 1 }, { t: 2, kind: 'tool', name: 'hands.type', decision: 'refused', code: 'not_foreground', step: 2 }],
    frame: { name: 'a.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }, confirm: null, skipped: 0 };
  await f.$('agent-activity-btn').click();
  ok(f.$('agent-activity').hidden === false, 'the Activity button opens the panel');
  ok(same(texts(f.$('agent-act-list')), ['1. hands.launch', '2. hands.type - refused: not_foreground']) && f.$('agent-act-list').children[1].className === 'refused', 'the panel lists the audit lines, a refusal marked');
  ok(same(texts(f.$('agent-run-list')), ['open notepad <b>x</b> - done - 0.0035 USD']), 'the run list is one row per run and its text is not parsed as markup');
  ok(f.$('agent-frame').hidden === false && f.$('agent-frame').src === 'data:image/png;base64,iVBORw0KGgo=', 'a PNG frame shows');
  for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/a.png', 'data:image/png;base64,AAA"onload="x']) {
    z.status = { ...z.status, frame: { name: 'x.png', dataUrl: bad } };
    f.$('agent-frame').src = '';
    await ctl.refreshPanel();
    ok(f.$('agent-frame').hidden === true && f.$('agent-frame').src === '', `a frame that is not a PNG data URL is not shown: ${bad.slice(0, 30)}`);
  }
  z.status = { ok: true, active: null, runs: [], activity: [], frame: null, confirm: null };
  await ctl.refreshPanel();
  ok(texts(f.$('agent-run-list'))[0] === t('agent.noRuns') && texts(f.$('agent-act-list'))[0] === t('agent.noActivity'), 'empty lists say so');
  await f.$('agent-mode').click();
  ok(ctl.taskMode() === false && f.msg.placeholder === 'Message Zumi… (Enter to send)', 'switch off restores the chat placeholder');
  ctl.destroy();
  ok(f.$('agent-strip') === null, 'destroy removes the strip');
}
{
  // start refused: the reason is shown, no chips
  const f = fakeDoc(); const z = fakeZumi();
  const ctl = initAgentChat(z, f.$, { doc: f.doc, t, apply: () => {} });
  await f.$('agent-mode').click();
  z.startResult = { ok: false, error: 'busy' };
  ctl.take('go');
  await new Promise((r) => setTimeout(r, 5));
  ok(f.$('agent-status').textContent === t('agent.err.busy') && f.$('agent-stop').hidden === true, 'a refused start shows the reason and no Stop');
  z.startResult = { ok: false, error: 'chat_off: no OpenRouter key saved' };
  ctl.take('go again');
  await new Promise((r) => setTimeout(r, 5));
  ok(f.$('agent-status').textContent === t('agent.err.chatOff'), 'a brain that is off is explained in words');
  // events that arrive before agent.start resolves are not wiped by the answer
  const f2 = fakeDoc(); const z2 = fakeZumi();
  const ctl2 = initAgentChat(z2, f2.$, { doc: f2.doc, t, apply: () => {} });
  await f2.$('agent-mode').click();
  const realStart = z2.agent.start;
  z2.agent.start = async (text) => { z2.emit({ ev: 'task_start', run: 'chat-1' }); z2.emit({ ev: 'tool_start', run: 'chat-1', step: 1, name: 'note.save' }); return realStart(text); };
  ctl2.take('save a note');
  await new Promise((r) => setTimeout(r, 5));
  ok(same(texts(f2.$('agent-chips')), ['note.save']), 'a chip that arrived before agent.start answered is kept');
}
{
  // Electron (no agent API): nothing is built
  const f = fakeDoc();
  ok(initAgentChat({ talk: {} }, f.$, { doc: f.doc, t, apply: () => {} }) === null && f.$('agent-strip') === null, 'without the agent API nothing is built');
}

// ---- wiring in app.js and styles ----
const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
ok(/import \{ initAgentChat \} from '\.\/agent-chat\.js';/.test(app), 'app.js imports initAgentChat');
const takeAt = app.indexOf('agentChat.take(text)');
const sendAt = app.indexOf('talk.send(text');
ok(takeAt > 0 && sendAt > takeAt, 'onSend offers the sentence to the task switch before the chat brain');
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
for (const sel of ['.agent-strip', '.agent-chip.run', '.agent-chip.ok', '.agent-chip.fail', '.agent-confirm', '.agent-activity', '.agent-frame']) ok(css.includes(sel), `styles.css has ${sel}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
