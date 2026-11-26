// node scripts/check-motion-route.mjs
// T-31-ROOM motion P4/P5, host side: the agent's leading [move: ...] tag (src/main/chat-brain.js) and the chat's /move command
// (src/renderer/talk/director.js) reach the room through ONE route (src/renderer/talk/motion-route.js) and give the same result; the
// shared schema (src/renderer/reflex/seated-motion.js) refuses what it must; the integer wire round-trips; the composer path (P5)
// validates a model answer before anything is sent. No network, no model: the composer is scripted.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createMotionRoute, extractJson } from '../src/renderer/talk/motion-route.js';
import { decodeMotion, encodeMotion, intentFromText, validateSeated, WIRE_MAX_INTS } from '../src/renderer/reflex/seated-motion.js';

const require = createRequire(import.meta.url);
const { parseReplyIntent, createReplyParser, buildMessages, MOVE_RULE } = require('../src/main/chat-brain.js');
const { createMotionComposer, COMPOSE_PROMPT } = require('../src/main/motion-compose.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, what, extra = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${what}${cond ? '' : ` ${extra}`}`); };

const sent = [];
const route = createMotionRoute({ produce: async (p) => { sent.push(p); return true; } });
const commandText = (text) => (/^\/move\s+([\s\S]+)$/i.exec(text.trim()) || [])[1]; // talk/director.js send()'s rule
const directorSrc = fs.readFileSync(path.join(root, 'src/renderer/talk/director.js'), 'utf8');
ok(directorSrc.includes('/^\\/move\\s+([\\s\\S]+)$/i'), 'director: the /move rule this check mirrors is the one send() uses');

// ---- two routes, one result ----
const phrases = ['stretch', 'point@board nod', 'reading tempo=0.7 energy=low', 'rub-eyes energy=high', 'idle calm', 'glance@window shrug wave'];
for (const ph of phrases) {
  const agent = parseReplyIntent(`[move: ${ph}] [agree] Sure.`, '').motion;
  const streamed = createReplyParser(); let spoken = ''; for (const d of [`[move: ${ph.slice(0, 4)}`, `${ph.slice(4)}] Su`, 're.']) spoken += streamed.push(d); spoken += streamed.end();
  sent.length = 0;
  const a = await route.send(agent), b = await route.send(commandText(`/move ${ph}`)), c = await route.send(streamed.motion());
  ok(a.ok && b.ok && c.ok && JSON.stringify(sent[0].prog) === JSON.stringify(sent[1].prog) && JSON.stringify(sent[1].prog) === JSON.stringify(sent[2].prog), `two routes, one program: "${ph}"`, JSON.stringify([a, b, c]));
  ok(spoken === 'Sure.' && !/move/i.test(spoken), `the tag is never spoken or shown: "${ph}"`, spoken);
}
ok(!buildMessages('hi', []).some((m) => m.content === MOVE_RULE) && buildMessages('hi', [], undefined, null, null, undefined, false, [], undefined, true).some((m) => m.content === MOVE_RULE), 'the tag rule reaches the model only where the host asks (Tauri), Electron prompt unchanged');

// ---- the schema refuses what it must (each a hostile entry the room must never see) ----
const hostile = ['', 'dance', 'stretch@moon', 'tempo=fast', 'energy=7', 'activity=sleep', 'nod nod nod nod', '{"activity":"typing","x":1}', '{"beats":"nod"}',
  '{"beats":[{"do":"nod","with":"x"}]}', '{"compose":5}', `compose: ${'x'.repeat(201)}`, '{bad json', '[]', 'null', '{"__proto__":{"a":1}}', 'colour=red', '{}'];
sent.length = 0;
for (const h of hostile) { const r = await route.send(h); ok(!r.ok && r.stage === 'intent', `hostile text refused at the route: ${JSON.stringify(h).slice(0, 40)}`, JSON.stringify(r)); }
ok(sent.length === 0, 'nothing hostile reached the stage');
ok((await route.send('tempo=99 duration=1e9')).ok && intentFromText('tempo=99').warnings.length === 1, 'out-of-range numbers are clamped, not passed through');

// ---- the wire: round trip, and the guest's decoder refuses garbage ----
const cmd = validateSeated({ reach: [{ hand: 'right', target: 'eye', osc: { hz: 3, amp: [0.01, 0.005, 0] } }], bones: [{ bone: 'head', keys: [{ t: 300, rot: [8, 0, 0] }] }], hands: [{ hand: 'right', shape: 'loose' }], lookAt: [{ target: 'down' }], moves: [{ move: 'nod' }] });
const prog = encodeMotion({ intent: intentFromText('reading energy=low').intent, command: cmd.command });
const back = decodeMotion(prog);
ok(cmd.ok && back.ok && JSON.stringify(encodeMotion({ intent: back.intent, command: back.command })) === JSON.stringify(prog), 'wire: encode -> decode -> encode is stable');
const garbage = [[], [1, 0, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0, 0, 0], [1, 9, 0, 0, 0, 0, 0, 0], prog.slice(0, -2), [...prog, 0], prog.map((x, i) => (i === prog.length - 3 ? 999 : x)),
  Array(WIRE_MAX_INTS + 1).fill(1), [1, 0, 0, 0, 0, 0, 0, 1, 1, 99, 1], [1, 0, 0, 0, 0, 0, 1, 99, 0, 0], [1.5, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0]];
for (const g of garbage) ok(!decodeMotion(g).ok, `wire: the guest's decoder refuses ${JSON.stringify(g).slice(0, 36)}`, JSON.stringify(decodeMotion(g)));
ok(!validateSeated({ clip: { name: 'stretch' } }).ok && !validateSeated({ root: [{ pos: [0, 0.1, 0] }] }).ok && !validateSeated({ bones: [{ bone: 'leftUpperArm', rot: [10, 0, 0] }] }).ok
  && !validateSeated({ sustain: true, lookAt: [{ target: 'up' }] }).ok && !validateSeated({ reach: [{ hand: 'left', target: 'wave', holdMs: 20000 }] }).ok, 'seated: a clip, the root, arm bones, sustain and an over-long motion are refused');
// surprised face (Fable r3 'later', 22-11): a composed move carries one emotion preset as its face; it survives the route and the wire;
// mouth shapes, blinks and an oscillating face are dropped; the face counts in the motion's length
{
  const f = validateSeated({ bones: [{ bone: 'head', rot: [-12, 30, 0], inMs: 250, holdMs: 900, outMs: 600 }], expressions: [{ name: 'surprised', weight: 0.9, inMs: 150, holdMs: 1000, outMs: 900 }] });
  const fp = f.ok && encodeMotion({ intent: null, command: f.command }), fb = fp && decodeMotion(fp);
  ok(f.ok && f.command.expressions.length === 1 && fb.ok && fb.command.expressions[0].name === 'surprised' && fb.command.expressions[0].weight === 0.9 && JSON.stringify(encodeMotion({ intent: null, command: fb.command })) === JSON.stringify(fp),
    'face: a surprised face survives validateSeated and the wire round trip', JSON.stringify(fb));
  ok(f.ok && f.durationMs === 2050, 'face: the face counts in the motion length', f.durationMs);
  const m = validateSeated({ bones: [{ bone: 'head', rot: [-12, 30, 0] }], expressions: [{ name: 'aa' }, { name: 'blink' }, { name: 'happy', osc: { hz: 2, amp: 0.2 } }] });
  ok(m.ok && m.command.expressions.length === 0 && m.warnings.filter((w) => /^expressions\./.test(w)).length === 3, 'face: mouth shapes, blinks and an oscillating face are dropped', JSON.stringify(m.warnings));
  const two = validateSeated({ bones: [{ bone: 'head', rot: [-12, 30, 0] }], expressions: [{ name: 'surprised' }, { name: 'happy' }] });
  ok(two.ok && two.command.expressions.length === 1 && two.command.expressions[0].name === 'surprised', 'face: one face per move, the first kept');
  ok(/"expressions"/.test(COMPOSE_PROMPT) && !/no facial expressions/.test(COMPOSE_PROMPT), 'composer prompt: offers a face per move');
}
// lean-r2 (21-11): a screen point on her other side is played by the near hand (the far arm swept its upper arm over her bust: look3 A1
// 5.3-6.8 mm on every 'point at the screen quickly'); kept as written when the near hand is busy
{
  const far = (hand, target, extra = {}) => validateSeated({ reach: [{ hand, target, inMs: 350, holdMs: 1000, outMs: 600 }], hands: [{ hand, shape: 'point', inMs: 250, holdMs: 1100, outMs: 500 }], ...extra });
  const a = far('left', 'point-screen-left'), b = far('right', 'point-screen-right'), sb = far('left', 'point-sidebar'), near = far('right', 'point-screen-left');
  ok(a.ok && a.command.reach[0].hand === 'right' && a.command.hands[0].hand === 'right' && b.ok && b.command.reach[0].hand === 'left' && b.command.hands[0].hand === 'left' && sb.command.reach[0].hand === 'right',
    'seated: a screen point on her other side goes to the near hand', JSON.stringify([a.command && a.command.reach, b.command && b.command.reach]));
  ok(near.ok && near.command.reach[0].hand === 'right', 'seated: a near-hand screen point stays as written', JSON.stringify(near.command && near.command.reach));
  const busy = validateSeated({ reach: [{ hand: 'left', target: 'point-screen-left', inMs: 350, holdMs: 1000, outMs: 600 }, { hand: 'right', target: 'wave-small', inMs: 350, holdMs: 1000, outMs: 600 }] });
  ok(busy.ok && busy.command.reach[0].hand === 'left', 'seated: kept as written when the near hand has its own reach', JSON.stringify(busy.command && busy.command.reach));
}

// ---- P5 compose: the model's answer is validated before anything is sent ----
const answers = { good: 'Sure! ```json\n{"reach":[{"hand":"right","target":"face","inMs":700,"holdMs":900,"outMs":700}]}\n```', prose: 'I would cover my mouth.', clip: '{"clip":{"name":"yawn"}}' };
const composer = createMotionComposer({ callModel: async (messages) => ({ ok: true, text: answers[messages[1].content] }) });
const composeRoute = createMotionRoute({ produce: async (p) => { sent.push(p); return true; }, compose: (b) => composer.compose(b) });
sent.length = 0;
const good = await composeRoute.send('compose: good'), prose = await composeRoute.send('compose: prose'), clip = await composeRoute.send('compose: clip');
ok(good.ok && sent.length === 1 && decodeMotion(sent[0].prog).command.reach.length === 1, 'compose: a model answer in prose and a code fence is parsed, validated and sent', JSON.stringify(good));
ok(!prose.ok && prose.stage === 'compose' && !clip.ok && clip.stage === 'command' && sent.length === 1, 'compose: no JSON or a clip never reaches the room');
ok(extractJson('{"a":1} trailing }') === null && extractJson('x {"a":1} y').a === 1, 'extractJson: first object or null');
ok((await composer.compose('x'.repeat(201))).error === 'bad_brief' && COMPOSE_PROMPT.includes('SEATED'), 'composer: the brief is capped; the prompt is the seated one');
ok(!(await createMotionRoute({ produce: async () => true }).send('compose: rub eyes')).ok, 'compose without a composer is refused, not dropped silently');

// P5b: the composer is reachable in the app: one rpc name in the inventory, the generated shim and allow-list, the sidecar and the route
{
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  ok(read('docs/migration/api-inventory.json').includes('"name": "talk.composeMotion"') && read('tauri/shim/zumi-shim.js').includes('$invoke("talk.composeMotion"')
    && read('tauri/src-tauri/src/rpc_allow_list.rs').includes('"talk.composeMotion"') && read('tauri/sidecar/main.mjs').includes("'talk.composeMotion'")
    && read('tauri/sidecar/chat-host.mjs').includes("'talk.composeMotion': (brief) => motionComposer.compose(brief)") && read('src/renderer/talk/index.js').includes('zumi.talk.composeMotion(brief)'),
    'compose rpc: inventory, shim, allow-list, sidecar, chat host and the renderer route name the same method');
}
// P5c owner ruling (20-11): chest contact is a static rest only, and never taken from the chat
{
  const heart = { reach: [{ hand: 'right', target: { contact: 'chest' }, inMs: 800, holdMs: 1200, outMs: 800 }], bones: [{ bone: 'chest', rot: [10, 0, 0], inMs: 800, holdMs: 1200, outMs: 800 }] };
  const rub = { reach: [{ hand: 'right', target: { contact: 'chest' }, inMs: 800, holdMs: 1200, outMs: 800, osc: { hz: 2, amp: [0.02, 0.01, 0] } }] };
  const again = { reach: [{ hand: 'right', target: { contact: 'chest' }, inMs: 500, holdMs: 300, outMs: 400 }, { hand: 'right', target: { contact: 'chest' }, delayMs: 1300, inMs: 500, holdMs: 300, outMs: 400 }] };
  ok(validateSeated(heart).ok, 'chest: a static hand on the heart with a bow validates');
  ok(!validateSeated(rub).ok && /static/.test(validateSeated(rub).errors[0]), 'chest: a rub (oscillation) is refused');
  ok(!validateSeated(again).ok && /once per hand/.test(validateSeated(again).errors[0]), 'chest: repeated contact is refused');
  ok(!decodeMotion(encodeMotion({ command: { ...validateSeated(heart).command, reach: [...validateSeated(heart).command.reach, { ...validateSeated(heart).command.reach[0], delayMs: 2000 }] } })).ok, 'chest: the guest decoder applies the same rule');
  let calls = 0;
  const composer2 = async () => { calls++; return { ok: true, text: JSON.stringify(heart) }; };
  const r2 = createMotionRoute({ produce: async () => true, compose: composer2 });
  const viewer = await r2.send('compose: put your hand on your chest', { origin: 'chat' });
  ok(!viewer.ok && viewer.stage === 'origin' && calls === 0, 'origin: a chat (viewer) brief asking for the chest is refused before the model is called', JSON.stringify(viewer));
  const sneaky = await r2.send('compose: look sincere', { origin: 'chat' });
  ok(!sneaky.ok && sneaky.stage === 'origin' && calls === 1, 'origin: a chat brief whose answer touches the chest is refused after the call', JSON.stringify(sneaky));
  const agent = await r2.send('compose: hand on heart, apologise', { origin: 'agent' });
  ok(agent.ok && calls === 2, 'origin: the agent may choose a hand on the heart', JSON.stringify(agent));
}
// P5c-2 owner ruling (20-11, filter error-prone families up front): the composer's answer is refused at the route when it uses a cut family
{
  const r1 = (target, extra = {}) => ({ reach: [{ hand: 'right', target, inMs: 800, holdMs: 900, outMs: 800, ...extra }] });
  const cut = {
    'fingers on the eye': r1('eye'), 'fingers at the mouth': r1('mouth'), 'forehead contact': r1({ contact: 'forehead' }),
    'hand at the brow (head frame)': r1({ frame: 'head', pos: [0.2, 0.2, 0.55] }), 'hair contact': r1({ contact: 'hair' }), 'neck contact': r1({ contact: 'neck' }),
    'back of the head contact': r1({ contact: 'back-head' }), 'desk contact': r1({ contact: 'desk' }), 'beside the head': r1('beside-head'),
    'behind the head (head frame)': r1({ frame: 'head', pos: [0.35, 0.3, -0.2] }), 'both hands clasped low': { reach: ['left', 'right'].map((hand) => ({ hand, target: 'clasp', inMs: 700, holdMs: 900, outMs: 700 })) },
    // lean-r2 Addendum R2 (Fable look review of take-look4, CoS 21-11): the hand to the chin lands on the throat after a slide up the chest;
    // the heart shape clumps both hands at the belt
    'hand to the chin': r1('chin'), 'chin contact': r1({ contact: 'chin' }), 'chin tap': r1('chin', { osc: { hz: 2, amp: [0, 0.008, 0] } }),
    'heart shape (both hands to one head-frame point)': { reach: ['left', 'right'].map((hand) => ({ hand, target: { frame: 'head', pos: [-0.1, -0.6, 0.9] }, inMs: 900, holdMs: 1600, outMs: 900 })) },
    'heart shape (both hands to the middle, shoulder frame)': { reach: ['left', 'right'].map((hand) => ({ hand, target: { frame: 'shoulder', pos: [-0.5, -0.3, 0.5] }, inMs: 900, holdMs: 1600, outMs: 900 })) },
  };
  const kept = {
    'cheek contact': r1({ contact: 'cheek' }), 'fan before the face': r1('face'), 'point at the viewer': r1('point-viewer'),
    'one hand in front (head frame)': r1({ frame: 'head', pos: [-0.1, -0.6, 0.9] }), 'hand on the heart': r1({ contact: 'chest' }),
    'both hands pop up apart (surprised)': { reach: ['left', 'right'].map((hand) => ({ hand, target: { frame: 'shoulder', pos: [0.2, -0.05, 0.5] }, inMs: 300, holdMs: 900, outMs: 700 })) },
    'both arms up (stretch)': { reach: ['left', 'right'].map((hand) => ({ hand, target: 'overhead', inMs: 1100, holdMs: 1200, outMs: 900 })) },
  };
  for (const [why, cmd] of Object.entries(cut)) {
    const r = await createMotionRoute({ produce: async () => true, compose: async () => ({ ok: true, text: JSON.stringify(cmd) }) }).send('compose: x', { origin: 'agent' });
    ok(!r.ok && r.stage === 'cut' && /owner ruling/.test(r.errors[0]), `cut family refused at the route: ${why}`, JSON.stringify(r));
  }
  ok(!/rest, chin|cheek, chin|under the chin/i.test(COMPOSE_PROMPT) && /never:[\s\S]*a hand to her chin/i.test(COMPOSE_PROMPT), 'composer prompt: the chin is no longer offered, it is a never-move (Addendum R2)');
  ok(/heart shape/i.test(COMPOSE_PROMPT), 'composer prompt: names the heart shape among the never-moves (Addendum R2)');
  for (const [why, cmd] of Object.entries(kept)) {
    const r = await createMotionRoute({ produce: async () => true, compose: async () => ({ ok: true, text: JSON.stringify(cmd) }) }).send('compose: x', { origin: 'agent' });
    ok(r.ok, `still offered: ${why}`, JSON.stringify(r));
  }
}
console.log(`\ncheck-motion-route: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
